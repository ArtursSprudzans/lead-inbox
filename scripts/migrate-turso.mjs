import { createClient } from '@libsql/client/web';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { tursoConfig } from '../src/turso-config.mjs';

// Runs at deployment time. Request handlers only read/write application data.
export async function migrateTurso(client, directory = new URL('../drizzle/', import.meta.url)) {
  await client.execute('CREATE TABLE IF NOT EXISTS app_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)');
  const migrations = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    const sql = readFileSync(resolve(fileURLToPath(directory), name), 'utf8');
    const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
    const applied = await client.execute({ sql: 'SELECT checksum FROM app_schema_migrations WHERE name = ?', args: [name] });
    if (applied.rows.length) {
      if (applied.rows[0].checksum !== checksum) throw new Error(`Applied migration ${name} has changed; add a new migration instead.`);
      continue;
    }
    const statements = sql.split('--> statement-breakpoint').map(statement => statement.trim()).filter(Boolean);
    statements.push({ sql: 'INSERT INTO app_schema_migrations (name, checksum) VALUES (?, ?)', args: [name, checksum] });
    try {
      await client.batch(statements, 'write');
    } catch (error) {
      // Another deployment can finish the same migration while this one waits.
      const result = await client.execute({ sql: 'SELECT checksum FROM app_schema_migrations WHERE name = ?', args: [name] });
      if (result.rows[0]?.checksum !== checksum) throw error;
    }
    console.log(`Applied ${name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const client = createClient(tursoConfig());
  try { await migrateTurso(client); }
  finally { client.close(); }
}
