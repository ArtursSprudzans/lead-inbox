import { createApp } from './app.mjs';
import { createLibsqlDatabase } from './libsql-d1.mjs';
import { tursoConfig } from './turso-config.mjs';

// Client construction is lazy: static assets can deploy independently, and the
// same client/handler is reused by warm function invocations.
export function createVercelHandler({ createClient, seed, environment = process.env, now }) {
  let handler;
  return async request => {
    try {
      if (!handler) {
        const client = createClient(tursoConfig(environment));
        handler = createApp({ db: createLibsqlDatabase(client), seed, now });
      }
      return await handler(request);
    } catch {
      // Configuration/connection errors must never expose credentials.
      return new Response(JSON.stringify({ error: 'The database is not available. Please try again later.' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      });
    }
  };
}
