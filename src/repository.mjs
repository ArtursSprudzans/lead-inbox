import { normalizeImport } from './domain.mjs';
import { DEMO_PASSWORD, passwordHash, randomToken } from './auth.mjs';

export class RepositoryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const COMPANY_IDS = ['A', 'B'];
const rowId = row => typeof row?.id === 'string' ? row.id.trim() : row?.id;
const results = result => result?.results ?? [];

/** Migrations run at deployment/startup. Request handling never creates tables. */
export async function initialize(db, seed = { leads: [], bookings: [] }) {
  if (await db.prepare("SELECT value FROM app_meta WHERE key = 'demo_seed_v1'").first()) return;
  normalizeImport(seed.leads, seed.bookings);
  const statements = [];
  for (const companyId of COMPANY_IDS) {
    const salt = `lead-inbox-demo-company-${companyId}-v1`;
    const hash = await passwordHash(DEMO_PASSWORD, salt);
    statements.push(db.prepare('INSERT OR IGNORE INTO companies (id, name) VALUES (?, ?)').bind(companyId, `Company ${companyId}`));
    statements.push(db.prepare('INSERT OR IGNORE INTO users (id, company_id, email, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)').bind(`user-${companyId}`, companyId, `${companyId.toLowerCase()}@leadinbox.demo`, salt, hash));
    statements.push(db.prepare('INSERT OR IGNORE INTO company_revisions (company_id, revision) VALUES (?, ?)').bind(companyId, 'initial'));
  }
  for (const [table, rows] of [['source_leads', seed.leads], ['booking_events', seed.bookings]]) {
    for (const row of rows) statements.push(db.prepare(`INSERT OR IGNORE INTO ${table} (company_id, id, payload) VALUES (?, ?, ?)`).bind(row.company_id, rowId(row), JSON.stringify(row)));
  }
  statements.push(db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('demo_seed_v1', '1')"));
  await db.batch(statements);
}

export async function loadCompany(db, companyId) {
  // A D1 batch gives all three reads a consistent transactional snapshot.
  const snapshots = await db.batch([
    db.prepare('SELECT payload FROM source_leads WHERE company_id = ? ORDER BY id').bind(companyId),
    db.prepare('SELECT payload FROM booking_events WHERE company_id = ? ORDER BY id').bind(companyId),
    db.prepare('SELECT revision FROM company_revisions WHERE company_id = ?').bind(companyId),
  ]);
  const rawLeads = results(snapshots[0]).map(row => JSON.parse(row.payload));
  const rawBookings = results(snapshots[1]).map(row => JSON.parse(row.payload));
  return { rawLeads, rawBookings, revision: results(snapshots[2])[0]?.revision, ...normalizeImport(rawLeads, rawBookings) };
}

function validateInputRows(rows, name) {
  if (!Array.isArray(rows)) throw new RepositoryError(`${name} must be a JSON array.`);
  if (rows.length > 1000) throw new RepositoryError(`${name} exceeds the maximum of 1,000 rows per import.`);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || typeof row !== 'object' || Array.isArray(row) || !COMPANY_IDS.includes(row.company_id)) {
      throw new RepositoryError(`${name}[${index}] must be an object with company_id A or B.`);
    }
  }
}

export async function importCompany(db, companyId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RepositoryError('Import must be an object containing leads and bookings arrays.');
  validateInputRows(input.leads, 'leads');
  validateInputRows(input.bookings, 'bookings');
  const leads = input.leads.filter(row => row.company_id === companyId);
  const bookings = input.bookings.filter(row => row.company_id === companyId);
  const companyRowsSkipped = input.leads.length + input.bookings.length - leads.length - bookings.length;
  const existing = await loadCompany(db, companyId);
  let normalized;
  try { normalized = normalizeImport([...existing.rawLeads, ...leads], [...existing.rawBookings, ...bookings]); }
  catch (error) { throw new RepositoryError(error.message); }

  const previousLeadIds = new Set(existing.rawLeads.map(rowId));
  const previousEventIds = new Set(existing.rawBookings.map(rowId));
  const newLeads = [...new Map(leads.filter(row => !previousLeadIds.has(rowId(row))).map(row => [rowId(row), row])).values()];
  const newBookings = [...new Map(bookings.filter(row => !previousEventIds.has(rowId(row))).map(row => [rowId(row), row])).values()];

  if (newLeads.length || newBookings.length) {
    // Optimistic revision token makes validation + writes safe across Worker isolates.
    // A stale writer's conditional inserts are all no-ops, then it returns 409.
    const token = randomToken(16);
    const statements = [db.prepare('UPDATE company_revisions SET revision = ? WHERE company_id = ? AND revision = ?').bind(token, companyId, existing.revision)];
    for (const [table, rows] of [['source_leads', newLeads], ['booking_events', newBookings]]) {
      for (const row of rows) statements.push(db.prepare(`INSERT INTO ${table} (company_id, id, payload) SELECT ?, ?, ? WHERE (SELECT revision FROM company_revisions WHERE company_id = ?) = ?`).bind(companyId, rowId(row), JSON.stringify(row), companyId, token));
    }
    statements.push(db.prepare('SELECT revision FROM company_revisions WHERE company_id = ?').bind(companyId));
    const committed = await db.batch(statements);
    if (results(committed.at(-1))[0]?.revision !== token) throw new RepositoryError('Another import finished first. Please retry this import.', 409);
  }
  const delta = normalized.leads.length - existing.leads.length;
  return {
    leadsImported: Math.max(0, delta),
    duplicatesMerged: Math.max(0, newLeads.length - delta),
    eventsImported: newBookings.length,
    eventsSkipped: bookings.length - newBookings.length,
    companyRowsSkipped,
  };
}
