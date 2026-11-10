const EVENT_TYPES = new Set(['booked', 'cancelled', 'rescheduled', 'met', 'no_show']);
const TERMINAL_TYPES = new Set(['cancelled', 'met', 'no_show']);
const ACTIVE_TYPES = new Set(['booked', 'rescheduled']);
const companyKey = (companyId, id) => JSON.stringify([companyId, id]);
// Code-point ordering keeps ties stable across runtime locales and Unicode collation.
const compareStrings = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compareEvents = (a, b) => compareStrings(a.occurredAt, b.occurredAt)
  || compareStrings(a.id, b.id) || compareStrings(a.companyId, b.companyId);

function fail(message) { throw new Error(message); }

function string(value, path, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail(`${path} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function timestamp(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail(`${path} must be an ISO timestamp with an explicit timezone.`);
  }
  const parsed = new Date(value);
  const parts = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const validClock = Number(value.slice(11, 13)) < 24
    && Number(value.slice(14, 16)) < 60
    && (value[16] !== ':' || Number(value.slice(17, 19)) < 60);
  const validCalendar = calendar.getUTCFullYear() === parts[0]
    && calendar.getUTCMonth() === parts[1] - 1
    && calendar.getUTCDate() === parts[2];
  if (!validClock || !validCalendar || !Number.isFinite(parsed.getTime())) {
    fail(`${path} must be a valid timestamp.`);
  }
  return parsed.toISOString();
}

function company(value, path) {
  if (value !== 'A' && value !== 'B') fail(`${path} must be A or B.`);
  return value;
}

function email(value, path) {
  if (value === null || value === undefined || value === '') return null;
  const result = string(value, path, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(`${path} must be a valid email address.`);
  return result;
}

function phone(value, path) {
  if (value === null || value === undefined || value === '') return null;
  const result = string(value, path, 40);
  if (!/^\+?[\d\s().-]+$/.test(result)) fail(`${path} must contain a phone number without extensions.`);
  let digits = result.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 7 || digits.length > 15) fail(`${path} must contain 7 to 15 digits.`);
  return `+${digits}`;
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object.`);
}

/** Validate one complete import, merge identities within each tenant, and resolve source IDs. */
export function normalizeImport(rawLeads, rawBookings) {
  if (!Array.isArray(rawLeads) || !Array.isArray(rawBookings)) fail('leads and bookings must both be JSON arrays.');
  if (rawLeads.length > 10000 || rawBookings.length > 50000) fail('Import exceeds the limit of 10,000 leads or 50,000 events.');
  const sourceById = new Map();
  rawLeads.forEach((row, index) => {
    const path = `leads[${index}]`;
    object(row, path);
    const lead = {
      id: string(row.id, `${path}.id`, 100),
      companyId: company(row.company_id, `${path}.company_id`),
      name: string(row.name, `${path}.name`),
      email: email(row.email, `${path}.email`),
      phone: phone(row.phone, `${path}.phone`),
      createdAt: timestamp(row.created_at, `${path}.created_at`),
    };
    if (!lead.phone && !lead.email) fail(`${path} needs at least one of phone or email for deduplication.`);
    const key = companyKey(lead.companyId, lead.id);
    const previous = sourceById.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(lead)) fail(`${path}.id conflicts with another lead in Company ${lead.companyId}.`);
    sourceById.set(key, lead);
  });

  // Union-find handles bridges: one record can connect a phone match to an email match.
  const sources = [...sourceById.values()].sort((a, b) => compareStrings(a.companyId, b.companyId) || compareStrings(a.id, b.id));
  const parents = sources.map((_, index) => index);
  function root(index) {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
    return index;
  }
  const identities = new Map();
  sources.forEach((lead, index) => {
    for (const [kind, value] of [['email', lead.email], ['phone', lead.phone]]) {
      if (!value) continue;
      const key = JSON.stringify([lead.companyId, kind, value]);
      if (identities.has(key)) parents[root(index)] = root(identities.get(key));
      else identities.set(key, index);
    }
  });
  const groups = new Map();
  sources.forEach((lead, index) => {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(lead);
  });
  const leads = [];
  const aliases = [];
  const canonicalBySource = new Map();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id));
    const earliest = ordered[0];
    const canonical = { ...earliest, id: group.map(lead => lead.id).sort()[0] };
    // Latest non-empty contact details win; identity matching used every source value.
    for (const source of ordered) {
      canonical.name = source.name;
      if (source.phone) canonical.phone = source.phone;
      if (source.email) canonical.email = source.email;
      aliases.push({ companyId: source.companyId, sourceId: source.id, leadId: canonical.id });
      canonicalBySource.set(companyKey(source.companyId, source.id), canonical.id);
    }
    leads.push(canonical);
  }

  const eventById = new Map();
  rawBookings.forEach((row, index) => {
    const path = `bookings[${index}]`;
    object(row, path);
    const companyId = company(row.company_id, `${path}.company_id`);
    const sourceId = string(row.lead_id, `${path}.lead_id`, 100);
    const leadId = canonicalBySource.get(companyKey(companyId, sourceId));
    if (!leadId) fail(`${path}.lead_id does not reference a lead in Company ${companyId}.`);
    const type = row.type === 'no-show' ? 'no_show' : row.type;
    if (!EVENT_TYPES.has(type)) fail(`${path}.type must be booked, cancelled, rescheduled, met, or no_show.`);
    const event = {
      id: string(row.id, `${path}.id`, 100),
      companyId,
      leadId,
      meetingId: string(row.meeting_id, `${path}.meeting_id`, 100),
      type,
      occurredAt: timestamp(row.occurred_at, `${path}.occurred_at`),
      meetingAt: timestamp(row.meeting_at, `${path}.meeting_at`),
      closer: string(row.closer, `${path}.closer`, 100),
    };
    const key = companyKey(companyId, event.id);
    const previous = eventById.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) fail(`${path}.id conflicts with another event in Company ${companyId}.`);
    eventById.set(key, event);
  });
  const events = [...eventById.values()].sort(compareEvents);
  const meetings = new Map();
  const canonicalLeads = new Map(leads.map(lead => [companyKey(lead.companyId, lead.id), lead]));
  for (const event of events) {
    const key = companyKey(event.companyId, event.meetingId);
    const previous = meetings.get(key);
    if (event.occurredAt < canonicalLeads.get(companyKey(event.companyId, event.leadId)).createdAt) {
      fail(`Event ${event.id} occurs before its lead was created.`);
    }
    if (!previous && event.type !== 'booked') fail(`Meeting ${event.meetingId} in Company ${event.companyId} must start with a booked event.`);
    if (previous) {
      if (previous.leadId !== event.leadId) fail(`Meeting ${event.meetingId} refers to more than one lead in Company ${event.companyId}.`);
      if (TERMINAL_TYPES.has(previous.type)) fail(`Meeting ${event.meetingId} has an event after a terminal outcome; use a new meeting_id to rebook.`);
      if (event.type === 'booked') fail(`Meeting ${event.meetingId} has more than one booked event; use rescheduled for time changes.`);
      if (event.type !== 'rescheduled' && event.meetingAt !== previous.meetingAt) fail(`Event ${event.id} changes the meeting time without a rescheduled event.`);
    }
    if ((event.type === 'met' || event.type === 'no_show') && event.occurredAt < event.meetingAt) fail(`Event ${event.id} records an outcome before the meeting time.`);
    meetings.set(key, event);
  }
  return {
    leads: leads.sort((a, b) => compareStrings(a.companyId, b.companyId) || compareStrings(a.id, b.id)),
    events,
    aliases,
    duplicatesMerged: rawLeads.length - leads.length,
  };
}

function instant(now) {
  const result = new Date(now);
  if (!Number.isFinite(result.getTime())) fail('now must be a valid date.');
  return result;
}

function replay(events, now) {
  const cutoff = instant(now).toISOString();
  const meetings = new Map();
  const latest = new Map();
  for (const event of [...events].filter(event => event.occurredAt <= cutoff).sort(compareEvents)) {
    meetings.set(companyKey(event.companyId, event.meetingId), event);
    latest.set(companyKey(event.companyId, event.leadId), event);
  }
  return { meetings: [...meetings.values()], latest, cutoff };
}

/** The nearest active future appointment takes precedence over earlier outcomes. */
export function buildInbox(leads, events, now = new Date()) {
  const { meetings, latest, cutoff } = replay(events, now);
  const futureByLead = new Map();
  for (const meeting of meetings) {
    if (!ACTIVE_TYPES.has(meeting.type) || meeting.meetingAt < cutoff) continue;
    const key = companyKey(meeting.companyId, meeting.leadId);
    const previous = futureByLead.get(key);
    if (!previous || meeting.meetingAt < previous.meetingAt) futureByLead.set(key, meeting);
  }
  return leads.filter(lead => lead.createdAt <= cutoff).map(lead => {
    const key = companyKey(lead.companyId, lead.id);
    const last = latest.get(key);
    const next = futureByLead.get(key);
    const selected = next || last;
    return {
      ...lead,
      status: selected?.type || 'new',
      nextMeetingAt: next?.meetingAt || null,
      closer: selected?.closer || null,
      lastEventAt: last?.occurredAt || null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function withRate(row) {
  const outcomes = row.showed + row.noShow;
  return { ...row, showRate: outcomes ? (row.showed / outcomes) * 100 : null };
}

/** Unique meeting counts, attributed to its latest assigned closer as of now. */
export function calculateStats(leads, events, now = new Date()) {
  const allowed = new Set(leads.map(lead => companyKey(lead.companyId, lead.id)));
  const { meetings } = replay(events.filter(event => allowed.has(companyKey(event.companyId, event.leadId))), now);
  const byCloser = new Map();
  for (const meeting of meetings) {
    if (!byCloser.has(meeting.closer)) byCloser.set(meeting.closer, { closer: meeting.closer, booked: 0, showed: 0, noShow: 0 });
    const row = byCloser.get(meeting.closer);
    row.booked += 1;
    row.showed += Number(meeting.type === 'met');
    row.noShow += Number(meeting.type === 'no_show');
  }
  const closers = [...byCloser.values()].sort((a, b) => a.closer.localeCompare(b.closer)).map(withRate);
  const totals = closers.reduce((sum, row) => ({ booked: sum.booked + row.booked, showed: sum.showed + row.showed, noShow: sum.noShow + row.noShow }), { booked: 0, showed: 0, noShow: 0 });
  return { closers, totals: withRate(totals) };
}

function localDate(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}

function nextDate(date) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

/** Due today includes overdue work, with calendar-day rules in the company's timezone. */
export function followUps(leads, events, now = new Date(), timezone = 'Europe/Riga') {
  const current = instant(now);
  const date = localDate(current, timezone);
  const { latest } = replay(events, current);
  const due = [];
  for (const lead of buildInbox(leads, events, current)) {
    if (lead.nextMeetingAt || lead.status === 'met') continue;
    const event = latest.get(companyKey(lead.companyId, lead.id));
    let reason;
    let anchor;
    if (lead.status === 'new') {
      reason = 'No meeting booked';
      anchor = lead.createdAt;
    } else if (lead.status === 'cancelled') {
      reason = 'Meeting cancelled';
      anchor = event.occurredAt;
    } else if (lead.status === 'no_show') {
      reason = 'Missed meeting';
      anchor = event.occurredAt;
    } else if (ACTIVE_TYPES.has(lead.status) && event.meetingAt < current.toISOString()) {
      reason = 'Past meeting needs an outcome';
      anchor = event.meetingAt;
    } else continue;
    const dueAt = nextDate(localDate(anchor, timezone));
    if (dueAt <= date) due.push({ ...lead, reason, dueAt });
  }
  due.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.name.localeCompare(b.name));
  return { date, timezone, leads: due };
}
