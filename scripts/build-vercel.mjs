import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (process.env.VERCEL === '1') {
  const { createClient } = await import('@libsql/client/web');
  const { tursoConfig } = await import('../src/turso-config.mjs');
  const { migrateTurso } = await import('./migrate-turso.mjs');
  const client = createClient(tursoConfig());
  try { await migrateTurso(client); }
  finally { client.close(); }
}
mkdirSync('dist/client/samples', { recursive: true });
cpSync('public', 'dist/client', { recursive: true });
cpSync('data/leads.json', 'dist/client/samples/leads.json');
cpSync('data/bookings.json', 'dist/client/samples/bookings.json');
console.log('Built Vercel frontend. API routes use the Node.js functions in api/.');
