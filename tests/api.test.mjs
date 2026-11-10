import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.mjs';
import { createDatabase } from '../scripts/sqlite-d1.mjs';

const lead = (id, company = 'A', overrides = {}) => ({ id, company_id: company, name: `Person ${id}`, email: `${id}@example.test`, phone: `+1555010${company === 'A' ? '0' : '1'}${id.replace(/\D/g, '').padStart(3, '0')}`, created_at: '2026-11-01T08:00:00Z', ...overrides });
const booking = (id, company = 'A', overrides = {}) => ({ id, company_id: company, lead_id: company === 'A' ? 'a1' : 'b1', meeting_id: `${company}-meeting`, type: 'booked', occurred_at: '2026-11-03T08:00:00Z', meeting_at: '2026-11-09T09:00:00Z', closer: company === 'A' ? 'Alex' : 'Blair', ...overrides });
const seed = {
  leads: [lead('a1'), lead('a1-duplicate', 'A', { phone: '+1 (555) 010-0001', email: 'a1@example.test' }), lead('a2'), lead('b1', 'B', { phone: '+15550100001', email: 'a1@example.test' })],
  bookings: [booking('A-booked'), booking('A-met', 'A', { type: 'met', occurred_at: '2026-11-09T09:30:00Z' }), booking('B-booked', 'B', { meeting_at: '2026-11-12T09:00:00Z' })],
};

async function setup(t, fixture = seed) {
  const db = createDatabase(':memory:');
  await db.exec(readFileSync(new URL('../drizzle/0000_initial.sql', import.meta.url), 'utf8'));
  let clock = new Date('2026-11-10T12:00:00Z');
  const app = createApp({ db, seed: fixture, now: () => clock });
  t.after(() => db.close());
  const call = (path, { method = 'GET', body, cookie, origin, headers = {} } = {}) => app(new Request(`https://inbox.example${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  async function login(company = 'A') {
    const response = await call('/api/login', { method: 'POST', body: { email: `${company.toLowerCase()}@leadinbox.demo`, password: 'LeadInbox2026!' } });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  return { db, call, login, setTime: value => { clock = new Date(value); } };
}

test('all company endpoints require authentication and reject forged sessions', async t => {
  const { call } = await setup(t);
  for (const path of ['/api/me', '/api/leads', '/api/stats', '/api/follow-ups']) {
    assert.equal((await call(path)).status, 401);
    assert.equal((await call(path, { cookie: `lead_session=${'a'.repeat(64)}` })).status, 401);
  }
  assert.equal((await call('/api/import', { method: 'POST', body: { leads: [], bookings: [] } })).status, 401);
});

test('login uses protected cookies, stores token hashes, and company is server derived', async t => {
  const { call, db } = await setup(t);
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'a@leadinbox.demo', password: 'wrong' } })).status, 401);
  const response = await call('/api/login', { method: 'POST', body: { email: ' A@LeadInbox.demo ', password: 'LeadInbox2026!', company_id: 'B' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.companyId, 'A');
  const setCookie = response.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=43200']) assert.ok(setCookie.includes(flag));
  const token = setCookie.split(';')[0].split('=')[1];
  const stored = await db.prepare('SELECT token_hash FROM sessions').first();
  assert.notEqual(stored.token_hash, token);
  assert.equal(stored.token_hash.length, 64);
  assert.notEqual((await db.prepare('SELECT password_hash FROM users LIMIT 1').first()).password_hash, 'LeadInbox2026!');
});

test('lead list, closer statistics, and follow-ups cannot leak another company', async t => {
  const { call, login } = await setup(t);
  const a = await login('A');
  const b = await login('B');
  const aLeads = await (await call('/api/leads?company_id=B', { cookie: a })).json();
  const bLeads = await (await call('/api/leads', { cookie: b })).json();
  assert.equal(aLeads.leads.length, 2);
  assert.ok(aLeads.leads.every(row => row.companyId === 'A'));
  assert.equal(bLeads.leads.length, 1);
  assert.ok(bLeads.leads.every(row => row.companyId === 'B'));
  const stats = await (await call('/api/stats', { cookie: a })).json();
  assert.deepEqual(stats.closers.map(row => row.closer), ['Alex']);
  assert.deepEqual(stats.totals, { booked: 1, showed: 1, noShow: 0, showRate: 100 });
  const followups = await (await call('/api/follow-ups', { cookie: a })).json();
  assert.equal(followups.date, '2026-11-10');
  assert.equal(followups.timezone, 'Europe/Riga');
  assert.deepEqual(followups.leads.map(row => row.id), ['a2']);
});

test('logout revokes a session and absolute expiry is enforced', async t => {
  const { call, login, setTime } = await setup(t);
  const cookie = await login();
  assert.equal((await call('/api/logout', { method: 'POST', cookie })).status, 200);
  assert.equal((await call('/api/me', { cookie })).status, 401);
  const other = await login();
  setTime('2026-11-11T01:00:00Z');
  assert.equal((await call('/api/me', { cookie: other })).status, 401);
});

test('cross-origin mutations and unsupported request types are rejected', async t => {
  const { call, login } = await setup(t);
  const cookie = await login();
  assert.equal((await call('/api/import', { method: 'POST', cookie, origin: 'https://attacker.example', body: { leads: [], bookings: [] } })).status, 403);
  assert.equal((await call('/api/logout', { method: 'POST', cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call('/api/import', { method: 'POST', cookie, body: { leads: [], bookings: [] }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('/api/leads', { method: 'DELETE', cookie })).status, 405);
});

test('repeat imports are idempotent, filter foreign rows, and merge against saved identities', async t => {
  const { call, login } = await setup(t);
  const cookie = await login();
  const extra = lead('a3', 'A', { phone: '+15550100001', email: 'alias@example.test' });
  const foreign = lead('b2', 'B');
  const input = { leads: [extra, foreign], bookings: [] };
  const first = await call('/api/import', { method: 'POST', cookie, body: input });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { leadsImported: 0, duplicatesMerged: 1, eventsImported: 0, eventsSkipped: 0, companyRowsSkipped: 1 });
  const again = await call('/api/import', { method: 'POST', cookie, body: input });
  assert.deepEqual(await again.json(), { leadsImported: 0, duplicatesMerged: 0, eventsImported: 0, eventsSkipped: 0, companyRowsSkipped: 1 });
  assert.equal((await (await call('/api/leads', { cookie })).json()).leads.length, 2);
  const b = await login('B');
  assert.equal((await (await call('/api/leads', { cookie: b })).json()).leads.length, 1);
});

test('invalid cross-company references roll back the whole import', async t => {
  const { call, login, db } = await setup(t);
  const cookie = await login();
  const response = await call('/api/import', { method: 'POST', cookie, body: {
    leads: [lead('a4')],
    bookings: [booking('evil', 'A', { lead_id: 'b1', meeting_id: 'evil-meeting' })],
  } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /does not reference a lead/);
  assert.equal(await db.prepare("SELECT id FROM source_leads WHERE id = 'a4'").first(), null);
});

test('conflicting IDs cannot overwrite saved records and duplicate events count once', async t => {
  const { call, login, db } = await setup(t);
  const cookie = await login();
  const conflict = await call('/api/import', { method: 'POST', cookie, body: { leads: [lead('a1', 'A', { name: 'Changed identity' })], bookings: [] } });
  assert.equal(conflict.status, 400);
  const source = JSON.parse((await db.prepare("SELECT payload FROM source_leads WHERE company_id = 'A' AND id = 'a1'").first()).payload);
  assert.equal(source.name, 'Person a1');
  const repeated = await call('/api/import', { method: 'POST', cookie, body: { leads: [], bookings: [seed.bookings[0], seed.bookings[0]] } });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).eventsSkipped, 2);
  const stats = await (await call('/api/stats', { cookie })).json();
  assert.equal(stats.totals.booked, 1);
});

test('body and row limits reject oversized imports before mutation', async t => {
  const { call, login } = await setup(t);
  const cookie = await login();
  const tooMany = await call('/api/import', { method: 'POST', cookie, body: { leads: Array.from({ length: 1001 }, (_, index) => lead(`limit${index}`)), bookings: [] } });
  assert.equal(tooMany.status, 400);
  const tooLarge = await call('/api/import', { method: 'POST', cookie, body: { leads: [], bookings: [], padding: 'x'.repeat(2 * 1024 * 1024) } });
  assert.equal(tooLarge.status, 413);
});

test('concurrent imports either both serialize safely or one returns a retryable conflict', async t => {
  const { call, login } = await setup(t);
  const cookie = await login();
  const responses = await Promise.all([
    call('/api/import', { method: 'POST', cookie, body: { leads: [lead('a5')], bookings: [] } }),
    call('/api/import', { method: 'POST', cookie, body: { leads: [lead('a6')], bookings: [] } }),
  ]);
  assert.ok(responses.some(response => response.status === 200));
  assert.ok(responses.every(response => [200, 409].includes(response.status)));
  const actual = (await (await call('/api/leads', { cookie })).json()).leads.length;
  assert.equal(actual, 2 + responses.filter(response => response.status === 200).length);
});

test('failed-login limiting starts a fresh window after backoff expires', async t => {
  const { call, setTime } = await setup(t);
  const attempt = () => call('/api/login', { method: 'POST', body: { email: 'a@leadinbox.demo', password: 'incorrect' } });
  for (let index = 0; index < 10; index++) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
  setTime('2026-11-10T12:06:00Z');
  for (let index = 0; index < 10; index++) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
});

test('security headers cover static assets and samples as well as API responses', async () => {
  const app = createApp({ assets: () => new Response('asset'), db: null });
  for (const path of ['/', '/styles.css', '/samples/leads.json']) {
    const response = await app(new Request(`https://inbox.example${path}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    if (path.startsWith('/samples/')) assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
