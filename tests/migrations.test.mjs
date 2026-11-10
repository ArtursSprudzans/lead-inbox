import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { migrateTurso } from '../scripts/migrate-turso.mjs';

function database(t) {
  const client = createClient({ url: ':memory:' });
  t.after(() => client.close());
  return client;
}

function migrationDirectory(t, sql) {
  const prefix = join(tmpdir(), 'lead-inbox-migration-');
  const directory = mkdtempSync(prefix);
  const filename = join(directory, '0000_test.sql');
  writeFileSync(filename, sql);
  t.after(() => {
    assert.ok(directory.startsWith(prefix));
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory: pathToFileURL(directory + sep), filename };
}

test('Turso migration runs once and preserves saved data on a later deployment', async t => {
  const client = database(t);
  await migrateTurso(client);
  await client.execute({ sql: 'INSERT INTO companies (id, name) VALUES (?, ?)', args: ['saved', 'Saved company'] });
  await migrateTurso(client);
  const saved = await client.execute("SELECT name FROM companies WHERE id = 'saved'");
  assert.equal(saved.rows[0].name, 'Saved company');
  const migrations = await client.execute('SELECT name, checksum FROM app_schema_migrations');
  assert.equal(migrations.rows.length, 1);
  assert.equal(migrations.rows[0].name, '0000_initial.sql');
  assert.match(migrations.rows[0].checksum, /^[a-f0-9]{64}$/);
});

test('a failed Turso migration rolls back schema and migration marker together', async t => {
  const client = database(t);
  const { directory, filename } = migrationDirectory(t, 'CREATE TABLE migration_probe (id TEXT);\n--> statement-breakpoint\nINSERT INTO missing_table VALUES (1);');
  await assert.rejects(migrateTurso(client, directory));
  assert.equal((await client.execute("SELECT name FROM sqlite_master WHERE name = 'migration_probe'")).rows.length, 0);
  assert.equal((await client.execute('SELECT name FROM app_schema_migrations')).rows.length, 0);

  writeFileSync(filename, "CREATE TABLE migration_probe (id TEXT);\n--> statement-breakpoint\nINSERT INTO migration_probe VALUES ('saved');");
  await migrateTurso(client, directory);
  assert.equal((await client.execute('SELECT id FROM migration_probe')).rows[0].id, 'saved');
  assert.equal((await client.execute('SELECT name FROM app_schema_migrations')).rows.length, 1);
});

test('changing an applied migration is rejected instead of silently modifying the schema', async t => {
  const client = database(t);
  const { directory, filename } = migrationDirectory(t, 'CREATE TABLE immutable_probe (id TEXT);');
  await migrateTurso(client, directory);
  writeFileSync(filename, 'CREATE TABLE immutable_probe (id TEXT, changed TEXT);');
  await assert.rejects(migrateTurso(client, directory), /has changed; add a new migration/);
  const columns = await client.execute('PRAGMA table_info(immutable_probe)');
  assert.deepEqual(columns.rows.map(row => row.name), ['id']);
});
