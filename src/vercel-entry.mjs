import { createClient } from '@libsql/client/web';
import { readFileSync } from 'node:fs';
import { createVercelHandler } from './vercel-handler.mjs';

const seed = {
  leads: JSON.parse(readFileSync(new URL('../data/leads.json', import.meta.url), 'utf8')),
  bookings: JSON.parse(readFileSync(new URL('../data/bookings.json', import.meta.url), 'utf8'))
};

export default { fetch: createVercelHandler({ createClient, seed }) };
