// Demo passwords are intentionally published in the README. Only hashes enter SQLite.
const ITERATIONS = 100_000;
const encoder = new TextEncoder();
export const DEMO_PASSWORD = 'LeadInbox2026!';
export const SESSION_SECONDS = 12 * 60 * 60;

export function randomToken(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: ITERATIONS, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(password, user) {
  // Perform the same expensive calculation for an unknown email.
  const result = await passwordHash(password, user?.password_salt ?? 'unknown-account-dummy-salt');
  const expected = user?.password_hash ?? '0'.repeat(64);
  let difference = result.length ^ expected.length;
  for (let index = 0; index < 64; index++) difference |= result.charCodeAt(index) ^ expected.charCodeAt(index);
  return Boolean(user) && difference === 0;
}

export function readSessionToken(request) {
  const value = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('lead_session='))?.slice('lead_session='.length);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export function sessionCookie(request, token, clear = false) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `lead_session=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_SECONDS}${secure}`;
}
