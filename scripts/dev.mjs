import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.mjs';
import { createDatabase } from './sqlite-d1.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync('.local', { recursive: true });
const db = createDatabase(process.env.DATABASE_PATH || '.local/inbox.sqlite');
// Local migrations are applied once and tracked independently of business data.
await db.exec('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
if (!await db.prepare('SELECT name FROM local_migrations WHERE name = ?').bind('0000_initial').first()) {
  await db.exec(readFileSync('drizzle/0000_initial.sql', 'utf8'));
  await db.prepare('INSERT INTO local_migrations (name) VALUES (?)').bind('0000_initial').run();
}
const seed = {
  leads: JSON.parse(readFileSync('data/leads.json', 'utf8')),
  bookings: JSON.parse(readFileSync('data/bookings.json', 'utf8'))
};
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const assets = async request => {
  const pathname = new URL(request.url).pathname;
  const files = { '/': 'public/index.html', '/index.html': 'public/index.html', '/app.js': 'public/app.js', '/styles.css': 'public/styles.css', '/samples/leads.json': 'data/leads.json', '/samples/bookings.json': 'data/bookings.json' };
  const file = files[pathname];
  if (!file) return new Response('Not found', { status: 404 });
  const extension = file.slice(file.lastIndexOf('.'));
  return new Response(request.method === 'HEAD' ? null : readFileSync(file), { headers: { 'Content-Type': contentTypes[extension], 'Cache-Control': 'no-cache' } });
};
const handle = createApp({ db, seed, assets });
const server = createServer(async (incoming, outgoing) => {
  try {
    const host = incoming.headers.host || 'localhost';
    const method = incoming.method || 'GET';
    let size = 0;
    const chunks = [];
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 2_100_000) {
        outgoing.writeHead(413, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: 'Import is too large; maximum is 2 MB.' }));
        return;
      }
      chunks.push(chunk);
    }
    const request = new Request(`http://${host}${incoming.url}`, {
      method, headers: incoming.headers,
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) })
    });
    const response = await handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ error: 'An unexpected server error occurred.' }));
  }
});
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`Lead Inbox: http://localhost:${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
