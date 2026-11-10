import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { createVercelHandler } from '../src/vercel-handler.mjs';
import { migrateTurso } from '../scripts/migrate-turso.mjs';

const environment = { TURSO_DATABASE_URL: 'libsql://inbox.example', TURSO_AUTH_TOKEN: 'test-token' };
const seed = {
  leads: JSON.parse(readFileSync(new URL('../data/leads.json', import.meta.url), 'utf8')),
  bookings: JSON.parse(readFileSync(new URL('../data/bookings.json', import.meta.url), 'utf8'))
};

function request(path, { method = 'GET', body, cookie, origin } = {}) {
  return new Request(`https://lead-inbox.example${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

test('Vercel handler uses real libSQL for company logins, scoped data, imports and warm reuse', async t => {
  const client = createClient({ url: ':memory:' });
  t.after(() => client.close());
  await migrateTurso(client);
  let clientsCreated = 0;
  const create = () => createVercelHandler({
    environment, seed, now: () => new Date('2026-11-10T12:00:00Z'),
    createClient(options) {
      assert.deepEqual(options, { url: environment.TURSO_DATABASE_URL, authToken: environment.TURSO_AUTH_TOKEN, intMode: 'number' });
      clientsCreated++;
      return client;
    }
  });
  const handler = create();
  assert.equal((await handler(request('/api/leads'))).status, 401);
  const cookies = {};
  for (const company of ['A', 'B']) {
    const response = await handler(request('/api/login', { method: 'POST', body: { email: `${company.toLowerCase()}@leadinbox.demo`, password: 'LeadInbox2026!' }, origin: 'https://lead-inbox.example' }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.companyId, company);
    assert.ok(response.headers.get('set-cookie').includes('Secure'));
    cookies[company] = response.headers.get('set-cookie').split(';')[0];
    const leads = await handler(request('/api/leads?company_id=other', { cookie: cookies[company] }));
    assert.equal(leads.status, 200);
    const records = (await leads.json()).leads;
    assert.equal(records.length, 20);
    assert.ok(records.every(lead => lead.companyId === company));
    const stats = await handler(request('/api/stats', { cookie: cookies[company] }));
    assert.equal(stats.status, 200);
    assert.equal((await stats.json()).closers.length, 3);
    const followups = await handler(request('/api/follow-ups', { cookie: cookies[company] }));
    assert.equal(followups.status, 200);
    assert.ok((await followups.json()).leads.every(lead => lead.companyId === company));
    const imported = await handler(request('/api/import', { method: 'POST', cookie: cookies[company], body: seed }));
    assert.equal(imported.status, 200);
    const summary = await imported.json();
    assert.equal(summary.leadsImported, 0);
    assert.equal(summary.eventsImported, 0);
  }
  assert.equal(clientsCreated, 1);
  // A later function instance sees sessions saved by the first instance.
  const nextInstance = create();
  const persisted = await nextInstance(request('/api/me', { cookie: cookies.A }));
  assert.equal((await persisted.json()).user.companyId, 'A');
  const blocked = await nextInstance(request('/api/logout', { method: 'POST', cookie: cookies.A, origin: 'https://other.example' }));
  assert.equal(blocked.status, 403);
});

test('Vercel handler reports missing configuration without constructing a database client', async () => {
  const handler = createVercelHandler({ createClient() { throw new Error('Must not construct client without configuration'); }, seed, environment: {} });
  const response = await handler(request('/api/me'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'The database is not available. Please try again later.' });
});

test('Vercel connection failures do not expose credentials and allow a later retry', async () => {
  let calls = 0;
  const handler = createVercelHandler({
    environment, seed,
    createClient() { calls++; throw new Error(`Failed using ${environment.TURSO_AUTH_TOKEN}`); }
  });
  for (let index = 0; index < 2; index++) {
    const response = await handler(request('/api/me'));
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(environment.TURSO_AUTH_TOKEN));
  }
  assert.equal(calls, 2);
});
