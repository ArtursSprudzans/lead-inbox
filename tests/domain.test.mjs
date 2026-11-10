import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImport, buildInbox, calculateStats, followUps } from '../src/domain.mjs';

const rawLead = (overrides = {}) => ({ id: 'L1', company_id: 'A', name: 'Alex Example', email: 'alex@example.com', phone: '+1 (202) 555-0100', created_at: '2026-10-20T08:00:00Z', ...overrides });
const rawEvent = (overrides = {}) => ({ id: 'E1', company_id: 'A', lead_id: 'L1', meeting_id: 'M1', type: 'booked', occurred_at: '2026-11-01T08:00:00Z', meeting_at: '2026-11-05T10:00:00Z', closer: 'Maya', ...overrides });
const now = new Date('2026-11-10T10:00:00Z');

test('deduplication is normalized, transitive, independent of input order, and company-scoped', () => {
  const leads = [
    rawLead(),
    rawLead({ id: 'L2', email: 'other@example.com', phone: '0012025550100' }),
    rawLead({ id: 'L3', email: ' OTHER@EXAMPLE.COM ', phone: '+1 202 555 0109' }),
    rawLead({ id: 'L1', company_id: 'B' }),
  ];
  const events = [rawEvent({ lead_id: 'L3' })];
  const one = normalizeImport(leads, events);
  const two = normalizeImport([...leads].reverse(), events);
  assert.deepEqual(one.leads, two.leads);
  assert.equal(one.leads.length, 2);
  assert.equal(one.duplicatesMerged, 2);
  assert.equal(one.events[0].leadId, 'L1');
  assert.equal(one.aliases.length, 4);
});

test('matching names alone does not merge leads', () => {
  const result = normalizeImport([rawLead(), rawLead({ id: 'L2', email: 'other@example.com', phone: '+12025550101' })], []);
  assert.equal(result.leads.length, 2);
});

test('identity and event tie ordering stays deterministic for Unicode IDs', () => {
  const leads = [rawLead({ id: '\u00e9', name: 'Composed' }), rawLead({ id: 'e\u0301', name: 'Decomposed' })];
  const events = [
    rawEvent({ id: '\u00e9', lead_id: '\u00e9', type: 'rescheduled', meeting_at: '2026-11-12T10:00:00Z' }),
    rawEvent({ id: 'e\u0301', lead_id: 'e\u0301' }),
  ];
  const first = normalizeImport(leads, events);
  const reversed = normalizeImport([...leads].reverse(), [...events].reverse());
  assert.deepEqual(first, reversed);
  assert.equal(first.leads[0].id, 'e\u0301');
  assert.equal(first.leads[0].name, 'Composed');
  assert.equal(buildInbox(first.leads, first.events, now)[0].status, 'rescheduled');
});

test('source and event IDs may repeat across companies without sharing state', () => {
  const normalized = normalizeImport([rawLead(), rawLead({ company_id: 'B' })], [
    rawEvent(),
    rawEvent({ company_id: 'B', closer: 'Oliver', meeting_at: '2026-11-12T10:00:00Z' }),
  ]);
  const companyA = normalized.leads.filter(lead => lead.companyId === 'A');
  assert.deepEqual(calculateStats(companyA, normalized.events, now).closers.map(closer => closer.closer), ['Maya']);
  assert.equal(buildInbox(companyA, normalized.events, now)[0].nextMeetingAt, null);
  assert.equal(followUps(companyA, normalized.events, now).leads[0].companyId, 'A');
});

test('invalid and cross-tenant references reject the complete import', () => {
  assert.throws(() => normalizeImport([rawLead()], [rawEvent({ company_id: 'B' })]), /does not reference a lead in Company B/);
  assert.throws(() => normalizeImport([rawLead({ created_at: '2026-02-30T00:00:00Z' })], []), /valid timestamp/);
  assert.throws(() => normalizeImport([rawLead({ created_at: '2026-11-01T24:00:00Z' })], []), /valid timestamp/);
  assert.throws(() => normalizeImport([rawLead({ created_at: '2026-11-01' })], []), /explicit timezone/);
  assert.throws(() => normalizeImport([rawLead(), rawLead({ name: 'Changed' })], []), /conflicts/);
  assert.throws(() => normalizeImport([rawLead()], [rawEvent(), rawEvent({ closer: 'Someone else' })]), /conflicts/);
});

test('identical event copies are idempotent and invalid transitions are rejected', () => {
  assert.equal(normalizeImport([rawLead()], [rawEvent(), rawEvent()]).events.length, 1);
  assert.throws(() => normalizeImport([rawLead()], [rawEvent({ type: 'rescheduled' })]), /must start/);
  assert.throws(() => normalizeImport([rawLead()], [rawEvent(), rawEvent({ id: 'E2', type: 'met', occurred_at: '2026-11-05T11:00:00Z' }), rawEvent({ id: 'E3', type: 'rescheduled', occurred_at: '2026-11-06T08:00:00Z' })]), /terminal outcome/);
});

test('out-of-order reschedules count one booking and use the current appointment and closer', () => {
  const normalized = normalizeImport([rawLead()], [
    rawEvent({ id: 'E2', type: 'rescheduled', occurred_at: '2026-11-03T08:00:00Z', meeting_at: '2026-11-12T10:00:00Z', closer: 'Leo' }),
    rawEvent(),
  ]);
  const inbox = buildInbox(normalized.leads, normalized.events, now);
  assert.equal(inbox[0].status, 'rescheduled');
  assert.equal(inbox[0].nextMeetingAt, '2026-11-12T10:00:00.000Z');
  assert.equal(inbox[0].closer, 'Leo');
  assert.deepEqual(calculateStats(normalized.leads, normalized.events, now), { closers: [{ closer: 'Leo', booked: 1, showed: 0, noShow: 0, showRate: null }], totals: { booked: 1, showed: 0, noShow: 0, showRate: null } });
});

test('stats count unique meetings and exclude cancellations and future meetings from show-rate denominator', () => {
  const normalized = normalizeImport([rawLead()], [
    rawEvent(), rawEvent({ id: 'E2', type: 'met', occurred_at: '2026-11-05T11:00:00Z' }),
    rawEvent({ id: 'E3', meeting_id: 'M2', meeting_at: '2026-11-06T10:00:00Z' }),
    rawEvent({ id: 'E4', meeting_id: 'M2', type: 'no_show', occurred_at: '2026-11-06T11:00:00Z', meeting_at: '2026-11-06T10:00:00Z' }),
    rawEvent({ id: 'E5', meeting_id: 'M3', meeting_at: '2026-11-07T10:00:00Z' }),
    rawEvent({ id: 'E6', meeting_id: 'M3', type: 'cancelled', occurred_at: '2026-11-06T12:00:00Z', meeting_at: '2026-11-07T10:00:00Z' }),
    rawEvent({ id: 'E7', meeting_id: 'M4', meeting_at: '2026-11-12T10:00:00Z' }),
  ]);
  assert.deepEqual(calculateStats(normalized.leads, normalized.events, now).totals, { booked: 4, showed: 1, noShow: 1, showRate: 50 });
  assert.equal(buildInbox(normalized.leads, normalized.events, now)[0].nextMeetingAt, '2026-11-12T10:00:00.000Z');
  assert.equal(followUps(normalized.leads, normalized.events, now).leads.length, 0);
});

test('follow-ups use Riga calendar days, include overdue work, and exclude same-day events', () => {
  const normalized = normalizeImport([
    rawLead({ id: 'old' }),
    rawLead({ id: 'today', email: 'today@example.com', phone: '+12025550101', created_at: '2026-11-09T23:10:00Z' }),
    rawLead({ id: 'missed', email: 'missed@example.com', phone: '+12025550102' }),
  ], [
    rawEvent({ lead_id: 'missed' }),
    rawEvent({ id: 'E2', lead_id: 'missed', type: 'no_show', occurred_at: '2026-11-05T11:00:00Z' }),
  ]);
  const result = followUps(normalized.leads, normalized.events, now);
  assert.equal(result.date, '2026-11-10');
  assert.equal(result.timezone, 'Europe/Riga');
  assert.deepEqual(result.leads.map(lead => lead.id), ['old', 'missed']);
  assert.equal(result.leads[1].dueAt, '2026-11-06');
});

test('future recorded outcomes do not affect an earlier snapshot', () => {
  const normalized = normalizeImport([rawLead()], [rawEvent(), rawEvent({ id: 'E2', type: 'met', occurred_at: '2026-11-05T11:00:00Z' })]);
  const earlier = new Date('2026-11-02T10:00:00Z');
  assert.equal(buildInbox(normalized.leads, normalized.events, earlier)[0].status, 'booked');
  assert.equal(calculateStats(normalized.leads, normalized.events, earlier).totals.showed, 0);
});

test('cancelled and unresolved meetings become due on the next local day', () => {
  const normalized = normalizeImport([
    rawLead(),
    rawLead({ id: 'L2', phone: '+12025550101', email: 'two@example.com' }),
    rawLead({ id: 'L3', phone: '+12025550102', email: 'three@example.com' }),
  ], [
    rawEvent(),
    rawEvent({ id: 'E2', type: 'cancelled', occurred_at: '2026-11-04T11:00:00Z' }),
    rawEvent({ id: 'E3', lead_id: 'L2', meeting_id: 'M2', meeting_at: '2026-11-09T10:00:00Z' }),
    rawEvent({ id: 'E4', lead_id: 'L3', meeting_id: 'M3', meeting_at: '2026-11-10T06:00:00Z' }),
    rawEvent({ id: 'E5', lead_id: 'L3', meeting_id: 'M3', type: 'no_show', occurred_at: '2026-11-10T07:00:00Z', meeting_at: '2026-11-10T06:00:00Z' }),
  ]);
  const result = followUps(normalized.leads, normalized.events, now);
  assert.deepEqual(result.leads.map(lead => [lead.id, lead.reason, lead.dueAt]), [
    ['L1', 'Meeting cancelled', '2026-11-05'],
    ['L2', 'Past meeting needs an outcome', '2026-11-10'],
  ]);
});

test('DST calendar transitions do not become fixed 24-hour follow-up windows', () => {
  // Riga's spring day is 23 hours: the next local date arrives in under 24 hours.
  const spring = normalizeImport([rawLead({ created_at: '2026-03-28T22:30:00Z' })], []);
  assert.equal(followUps(spring.leads, spring.events, new Date('2026-03-29T21:05:00Z')).leads.length, 1);
  // The autumn day is 25 hours: 24h45m later can still be the same local date.
  const autumn = normalizeImport([rawLead({ created_at: '2026-10-24T21:05:00Z' })], []);
  assert.equal(followUps(autumn.leads, autumn.events, new Date('2026-10-25T21:50:00Z')).leads.length, 0);
  assert.equal(followUps(autumn.leads, autumn.events, new Date('2026-10-25T22:05:00Z')).leads.length, 1);
});
