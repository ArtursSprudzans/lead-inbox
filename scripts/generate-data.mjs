import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeImport } from '../src/domain.mjs';

const dateFlag = process.argv.indexOf('--date');
const date = dateFlag >= 0 ? process.argv[dateFlag + 1] : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Riga', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Use --date YYYY-MM-DD with a valid calendar date.');
const base = new Date(`${date}T10:00:00Z`);
const at = (days, hours = 10) => {
  const value = new Date(base);
  value.setUTCDate(value.getUTCDate() + days);
  value.setUTCHours(hours, 0, 0, 0);
  return value.toISOString();
};
const names = [
  ['Alex Morgan', 'Jamie Chen', 'Taylor Brooks', 'Jordan Rivera', 'Sam Patel', 'Casey Wilson', 'Avery Thompson', 'Riley Carter', 'Morgan Lee', 'Drew Parker', 'Cameron Scott', 'Quinn Harris', 'Robin Davis', 'Charlie Evans', 'Peyton Reed', 'Skyler Lewis', 'Reese Bennett', 'Dakota Foster', 'Emerson Hayes', 'Finley Cooper'],
  ['Alex Morgan', 'Sasha Campbell', 'Rowan Mitchell', 'Harper James', 'Logan Bailey', 'Blair Anderson', 'Eden Phillips', 'Marley Collins', 'Jules Stewart', 'Kendall Morris', 'Phoenix Ward', 'Sage Turner', 'River Nelson', 'Sydney Wright', 'Remy Adams', 'Tatum Baker', 'Arden Green', 'Ellis Hall', 'Hayden Young', 'Kerry Clark'],
];
const leads = [];
const bookings = [];
let sequence = 0;

for (const [companyIndex, companyId] of ['A', 'B'].entries()) {
  const closers = companyId === 'A' ? ['Maya Chen', 'Leo Martins', 'Nora Ellis'] : ['Oliver Reed', 'Eva Brooks', 'Theo James'];
  for (let index = 0; index < 20; index += 1) {
    const number = String(index + 1).padStart(2, '0');
    const id = `${companyId}-L${number}`;
    const phoneIndex = companyIndex * 20 + index;
    const lead = {
      id,
      company_id: companyId,
      name: names[companyIndex][index],
      email: `${names[companyIndex][index].toLowerCase().replaceAll(' ', '.')}@example.com`,
      phone: `+1 (202) 555-01${String(index === 0 ? 0 : phoneIndex).padStart(2, '0')}`,
      created_at: at(index === 1 ? 0 : -20 - index % 3, 7),
    };
    leads.push(lead);
    const duplicate = [2, 5, 9].includes(index);
    const sourceId = duplicate ? `${id}-copy` : id;
    if (duplicate) leads.push({ ...lead, id: sourceId, email: `  ${lead.email.toUpperCase()}  `, phone: `00${lead.phone.replace(/\D/g, '')}`, created_at: at(-12, 8) });
    const closer = closers[index % 3];
    let meetingNumber = 0;
    function event(type, meetingId, occurredAt, meetingAt, assignedCloser = closer) {
      sequence += 1;
      bookings.push({ id: `${companyId}-E${String(sequence).padStart(4, '0')}`, company_id: companyId, lead_id: sourceId, meeting_id: meetingId, type, occurred_at: occurredAt, meeting_at: meetingAt, closer: assignedCloser });
    }
    function meeting(days, outcome = null, options = {}) {
      meetingNumber += 1;
      const meetingId = `${id}-M${meetingNumber}`;
      const scheduledAt = at(days, options.hour || 10);
      const bookedAt = at(Math.min(days - 4, -3), 8);
      const originalAt = options.rescheduled ? at(days - 1, 11) : scheduledAt;
      event('booked', meetingId, bookedAt, originalAt);
      if (options.rescheduled) event('rescheduled', meetingId, at(Math.min(days - 2, -1), 9), scheduledAt, options.closer || closer);
      if (outcome) {
        const outcomeAt = outcome === 'cancelled' ? at(options.cancelDay ?? days - 1, 9) : at(days, (options.hour || 10) + 1);
        event(outcome, meetingId, outcomeAt, scheduledAt, options.closer || closer);
      }
    }
    switch (index) {
      case 0: case 1: case 16: break;
      case 2: meeting(1, null); break;
      case 3: meeting(2, null, { rescheduled: true }); break;
      case 4: meeting(-5, 'met'); break;
      case 5: meeting(-3, 'no_show'); break;
      case 6: meeting(-2, 'cancelled'); break;
      case 7: meeting(-2); break;
      case 8: meeting(-6, 'met'); meeting(3); break;
      case 9: meeting(-6, 'cancelled'); meeting(2); break;
      case 10: meeting(-5, 'no_show'); meeting(4, null, { rescheduled: true }); break;
      case 11: meeting(-4, 'met'); break;
      case 12: meeting(-3, 'met', { rescheduled: true, closer: closers[(index + 1) % 3] }); break;
      case 13: meeting(0, 'no_show', { hour: 6 }); break;
      case 14: meeting(2, 'cancelled', { cancelDay: 0 }); break;
      case 15: meeting(5); break;
      case 17: meeting(-1, 'met'); break;
      case 18: meeting(-1, null, { rescheduled: true }); break;
      case 19: meeting(-7, 'met'); break;
    }
  }
}

// Deliberately out of order: consumers must use event timestamps, not file order.
bookings.reverse();
const normalized = normalizeImport(leads, bookings);
const directory = fileURLToPath(new URL('../data/', import.meta.url));
await mkdir(directory, { recursive: true });
await Promise.all([
  writeFile(`${directory}/leads.json`, `${JSON.stringify(leads, null, 2)}\n`),
  writeFile(`${directory}/bookings.json`, `${JSON.stringify(bookings, null, 2)}\n`),
]);
console.log(`Generated ${leads.length} source leads (${normalized.leads.length} people), ${bookings.length} events for ${date} (Europe/Riga). All names and contacts are fictional; example.com and reserved 202-555-01xx numbers are used.`);
