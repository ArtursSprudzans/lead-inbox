export function tursoConfig(environment = process.env) {
  const url = environment.TURSO_DATABASE_URL;
  const authToken = environment.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error('Connect a Turso database and set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN before deploying.');
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('TURSO_DATABASE_URL must be a valid remote database URL.'); }
  if (!['libsql:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error('TURSO_DATABASE_URL must use libsql:// or https:// without embedded credentials.');
  }
  return { url, authToken, intMode: 'number' };
}
