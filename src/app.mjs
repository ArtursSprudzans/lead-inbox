import { buildInbox, calculateStats, followUps } from './domain.mjs';
import { initialize, importCompany, loadCompany, RepositoryError } from './repository.mjs';
import { hashToken, randomToken, readSessionToken, sessionCookie, SESSION_SECONDS, verifyPassword } from './auth.mjs';

const TIMEZONE = 'Europe/Riga';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) throw new RepositoryError('Request body exceeds 2 MB.', 413);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new RepositoryError('Send an application/json request body.', 415);
  const reader = request.body?.getReader();
  const chunks = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new RepositoryError('Request body exceeds 2 MB.', 413); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new RepositoryError('Request body must be valid JSON.'); }
}

function guardOrigin(request) {
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new RepositoryError('Cross-origin requests are not allowed.', 403);
  }
}

function publicUser(user) {
  return { email: user.email, companyId: user.company_id, companyName: user.company_name };
}

function secureResponse(response, pathname) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (pathname.startsWith('/samples/')) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createApp({ db, seed = { leads: [], bookings: [] }, assets, now = () => new Date() }) {
  let ready;
  // Simple per-instance backoff complements password hashing; replace with a shared
  // edge rate limiter before production use (documented in README).
  const failures = new Map();

  async function authenticated(request, instant) {
    const token = readSessionToken(request);
    if (!token) return null;
    return db.prepare('SELECT u.id, u.email, u.company_id, c.name AS company_name FROM sessions s JOIN users u ON u.id = s.user_id JOIN companies c ON c.id = u.company_id WHERE s.token_hash = ? AND s.expires_at > ?').bind(await hashToken(token), instant.toISOString()).first();
  }

  async function handle(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return assets ? assets(request) : json({ error: 'Not found.' }, 404);
    try {
      if (!ready) ready = initialize(db, seed).catch(error => { ready = undefined; throw error; });
      await ready;
      const instant = new Date(typeof now === 'function' ? now() : now);
      if (!Number.isFinite(instant.getTime())) throw new Error('Invalid server clock.');
      if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST' });
      if (request.method === 'POST') guardOrigin(request);

      if (url.pathname === '/api/login' && request.method === 'POST') {
        const input = await readJson(request);
        if (!input || typeof input.email !== 'string' || typeof input.password !== 'string' || input.email.length > 254 || input.password.length > 200) throw new RepositoryError('Enter a valid email and password.');
        const email = input.email.trim().toLowerCase();
        const key = `${request.headers.get('cf-connecting-ip') || 'local'}:${email}`;
        const attempt = failures.get(key);
        if (attempt && attempt.count >= 10 && instant.getTime() - attempt.since < 5 * 60_000) return json({ error: 'Too many attempts. Try again in five minutes.' }, 429, { 'Retry-After': '300' });
        const user = await db.prepare('SELECT u.*, c.name AS company_name FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = ?').bind(email).first();
        if (!await verifyPassword(input.password, user)) {
          if (failures.size > 1000) failures.clear();
          const withinWindow = attempt && instant.getTime() - attempt.since < 5 * 60_000;
          failures.set(key, { count: withinWindow ? attempt.count + 1 : 1, since: withinWindow ? attempt.since : instant.getTime() });
          return json({ error: 'Email or password is incorrect.' }, 401);
        }
        failures.delete(key);
        const token = randomToken();
        await db.batch([
          db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(instant.toISOString()),
          db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await hashToken(token), user.id, new Date(instant.getTime() + SESSION_SECONDS * 1000).toISOString()),
        ]);
        return json({ user: publicUser(user), timezone: TIMEZONE }, 200, { 'Set-Cookie': sessionCookie(request, token) });
      }

      if (url.pathname === '/api/logout' && request.method === 'POST') {
        const token = readSessionToken(request);
        if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).run();
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', true) });
      }

      const user = await authenticated(request, instant);
      if (!user) return json({ error: 'Please sign in to continue.' }, 401);
      if (url.pathname === '/api/me' && request.method === 'GET') return json({ user: publicUser(user), timezone: TIMEZONE });
      if (url.pathname === '/api/import' && request.method === 'POST') return json(await importCompany(db, user.company_id, await readJson(request)));
      if (request.method === 'GET' && ['/api/leads', '/api/stats', '/api/follow-ups'].includes(url.pathname)) {
        const state = await loadCompany(db, user.company_id);
        if (url.pathname === '/api/leads') return json({ leads: buildInbox(state.leads, state.events, instant), timezone: TIMEZONE });
        if (url.pathname === '/api/stats') return json({ ...calculateStats(state.leads, state.events, instant), timezone: TIMEZONE });
        return json(followUps(state.leads, state.events, instant, TIMEZONE));
      }
      if (['/api/login', '/api/logout', '/api/me', '/api/leads', '/api/stats', '/api/follow-ups', '/api/import'].includes(url.pathname)) return json({ error: 'Method not allowed.' }, 405);
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      if (error instanceof RepositoryError) return json({ error: error.message }, error.status);
      console.error('Lead Inbox request failed:', error?.message || 'Unknown error');
      return json({ error: 'The server could not complete this request. Please try again.' }, 500);
    }
  }
  return async request => secureResponse(await handle(request), new URL(request.url).pathname);
}
