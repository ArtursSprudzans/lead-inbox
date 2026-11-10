import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createLibsqlDatabase } from '../src/libsql-d1.mjs';
import { createApp } from '../src/app.mjs';

// Exercise real SQLite constraints and transactions through the documented
// libSQL client shape, without depending on a remote account or network.
function localClient() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const batchModes = [];
  function execute({ sql, args = [] }) {
    const statement = sqlite.prepare(sql);
    const columns = statement.columns().map(column => column.name);
    if (!columns.length) {
      const change = statement.run(...args);
      return { columns, rows: [], rowsAffected: Number(change.changes), lastInsertRowid: change.lastInsertRowid };
    }
    const rows = statement.all(...args).map(row => {
      const hybrid = Object.assign(columns.map(column => row[column]), row);
      return hybrid;
    });
    return { columns, rows, rowsAffected: 0 };
  }
  return {
    batchModes,
    execute: async input => execute(input),
    async batch(inputs, mode) {
      batchModes.push(mode);
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = inputs.map(execute);
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async executeMultiple(sql) { sqlite.exec(sql); },
    close() { sqlite.close(); },
  };
}

test('libSQL adapter keeps bindings separate and returns named JSON rows', async t => {
  const db = createLibsqlDatabase(localClient());
  t.after(() => db.close());
  await db.exec('CREATE TABLE contacts (name TEXT PRIMARY KEY, score INTEGER)');
  const insert = db.prepare('INSERT INTO contacts (name, score) VALUES (?, ?)');
  await insert.bind("A'); DROP TABLE contacts; --", 0).run();
  await insert.bind('B', 2).run();
  const lookup = db.prepare('SELECT name, score FROM contacts WHERE name = ?');
  assert.deepEqual(await lookup.bind('B').first(), { name: 'B', score: 2 });
  assert.equal(await lookup.bind("A'); DROP TABLE contacts; --").first('score'), 0);
  assert.equal(await lookup.bind('missing').first(), null);
  assert.equal(await lookup.bind('missing').first('score'), null);
  assert.deepEqual((await lookup.bind('B').all()).results, [{ name: 'B', score: 2 }]);
  assert.deepEqual(await lookup.bind('B').raw(), [['B', 2]]);
});

test('libSQL batches preserve intermediate reads and roll back every write on failure', async t => {
  const client = localClient();
  const db = createLibsqlDatabase(client);
  t.after(() => db.close());
  await db.exec('CREATE TABLE revisions (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const result = await db.batch([
    db.prepare('INSERT INTO revisions VALUES (?, ?)').bind('A', 'initial'),
    db.prepare('UPDATE revisions SET value = ? WHERE id = ? AND value = ?').bind('next', 'A', 'initial'),
    db.prepare('SELECT value FROM revisions WHERE id = ?').bind('A'),
  ]);
  assert.equal(result[0].meta.changes, 1);
  assert.equal(result[1].meta.changes, 1);
  assert.deepEqual(result[2].results, [{ value: 'next' }]);
  assert.deepEqual(client.batchModes, ['write']);
  await assert.rejects(db.batch([
    db.prepare('UPDATE revisions SET value = ? WHERE id = ?').bind('should-rollback', 'A'),
    db.prepare('INSERT INTO revisions VALUES (?, ?)').bind('A', 'duplicate'),
  ]));
  assert.equal(await db.prepare('SELECT value FROM revisions WHERE id = ?').bind('A').first('value'), 'next');
});

test('libSQL batches reject another database statement before running any SQL', async t => {
  const first = createLibsqlDatabase(localClient());
  const second = createLibsqlDatabase(localClient());
  t.after(() => { first.close(); second.close(); });
  await first.exec('CREATE TABLE saved (id TEXT)');
  await assert.rejects(first.batch([
    first.prepare('INSERT INTO saved VALUES (?)').bind('unexpected'),
    second.prepare('SELECT 1'),
  ]), /prepared by this database/);
  assert.deepEqual((await first.prepare('SELECT * FROM saved').all()).results, []);
});

test('libSQL integer metadata is JSON-safe without losing large values', async () => {
  const result = { columns: ['small', 'large'], rows: [[7n, 9007199254740993n]], rowsAffected: 1, lastInsertRowid: 9007199254740993n };
  const client = { execute: async () => result, batch: async () => [result], close() {} };
  const db = createLibsqlDatabase(client);
  const selected = await db.prepare('SELECT small, large').all();
  assert.deepEqual(selected.results, [{ small: 7, large: '9007199254740993' }]);
  assert.equal(selected.meta.last_row_id, '9007199254740993');
  assert.doesNotThrow(() => JSON.stringify(selected));
  assert.deepEqual(await db.prepare('SELECT small, large').raw(), [[7, '9007199254740993']]);
});

test('the application can seed, authenticate and import across separate handlers with libSQL', async t => {
  const db = createLibsqlDatabase(localClient());
  t.after(() => db.close());
  await db.exec(readFileSync(new URL('../drizzle/0000_initial.sql', import.meta.url), 'utf8'));
  const seed = {
    leads: JSON.parse(readFileSync(new URL('../data/leads.json', import.meta.url), 'utf8')),
    bookings: JSON.parse(readFileSync(new URL('../data/bookings.json', import.meta.url), 'utf8')),
  };
  const now = () => new Date('2026-11-10T12:00:00Z');
  const first = createApp({ db, seed, now });
  const login = await first(new Request('https://inbox.example/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@leadinbox.demo', password: 'LeadInbox2026!' }) }));
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  // A new function instance still sees the same durable account and session.
  const second = createApp({ db, seed, now });
  const leads = await second(new Request('https://inbox.example/api/leads', { headers: { Cookie: cookie } }));
  const inbox = await leads.json();
  assert.equal(leads.status, 200);
  assert.equal(inbox.leads.length, 20);
  assert.ok(inbox.leads.every(lead => lead.companyId === 'A'));
  const imported = await second(new Request('https://inbox.example/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(seed) }));
  assert.equal(imported.status, 200);
  const summary = await imported.json();
  assert.equal(summary.leadsImported, 0);
  assert.equal(summary.eventsImported, 0);
});
