# Lead Inbox

A small, working lead-management app: two company accounts, duplicate-safe JSON imports, a responsive inbox, closer statistics, and a follow-up API. Vanilla JavaScript frontend, a Web API backend, and SQLite locally / Cloudflare D1 when hosted. No third-party runtime dependencies.

**Live demo:** https://lead-inbox-sprud-2026.lielie-d-i-8001.chatgpt.site

| Account | Email | Password |
| --- | --- | --- |
| Company A | `a@leadinbox.demo` | `LeadInbox2026!` |
| Company B | `b@leadinbox.demo` | `LeadInbox2026!` |

These are intentionally public demo accounts. All contacts are fictional; email addresses use `example.com` and phone numbers use the reserved US fictional range. Every authenticated query derives the company from the server session. A company supplied in a URL or request cannot change that scope.

## Run and test

Install Node.js **24.11 or later**. No `npm install` is needed.

```sh
node scripts/dev.mjs             # http://localhost:3000
node --test tests/*.test.mjs      # domain + API integration tests
node scripts/build.mjs           # deployable dist/server/index.js
```

The server applies the SQL migration and imports both sample files on its first API request. Local data persists in `.local/inbox.sqlite`; hosted data persists in D1. Use **Import data** to upload both JSON files; each account imports only its company’s rows. Repeating the import adds nothing. Invalid tenant references or conflicting IDs reject the whole company import without partial writes; simultaneous imports use a revision check and return a retryable conflict when necessary.

Browser verification: start Chrome with `--remote-debugging-port=9222` and a separate test profile, then run `node scripts/browser-smoke.mjs`. It exercises both accounts, filters, details, stats, file uploads, repeat imports, logout, and 360px/390px layouts, saving screenshots under `.local/screenshots/`. `APP_URL` can select another deployment.

## Sample data and assumptions

The original task files were not provided. [`data/leads.json`](data/leads.json) and [`data/bookings.json`](data/bookings.json) are generated fixtures: **46 source lead records → 40 people (20 per company), 72 events**. They include formatted duplicate phones, case-varied emails, duplicate-source booking references, shuffled event order, closer reassignment, and every required event type. One contact deliberately exists in both companies to exercise isolation.

```sh
node scripts/generate-data.mjs --date 2026-11-10
```

The checked-in fixture is anchored to 10 November 2026. Without `--date`, generation uses today in Riga. Regeneration changes files, not an already seeded database; start a fresh local database with `DATABASE_PATH` to preview a new fixture. All API decisions use the actual server clock.

- **Identity:** within a company, normalized phone **or** case-insensitive email matches identify the same person, including transitive matches. Names alone never merge people. Phones require an explicit country code; `00` and `+` prefixes and formatting normalize consistently. Source aliases remain available for bookings. The smallest source ID becomes the canonical ID, earliest creation time is retained, and latest nonempty contact details win.
- **Events:** `bookings.json` is an append-only event log. `meeting_id` identifies an appointment; a reschedule keeps it, while rebooking after a terminal outcome needs a new one. Replay sorts by `occurred_at`, then deterministic ID order. Timestamps require an explicit offset. Terminal outcomes are `met`, `no_show` (also accepts `no-show`), and `cancelled`; invalid transitions reject the import.
- **Current status:** the nearest future active meeting takes precedence; otherwise the latest recorded event determines status. Leads without events are `new`. Unresolved past bookings stay booked with no next meeting and become eligible for follow-up.
- **Stats:** booked counts distinct appointments ever booked, including subsequently cancelled appointments. Rescheduling does not add a booking. Showed counts appointments ending in `met`; show rate is `showed / (showed + no_show) × 100`. Cancelled, future, and unresolved meetings are excluded from the denominator. With no resolved outcomes the rate is `null` and displayed as a dash. The latest assigned closer receives the appointment and outcome counts. Stats cover all imported history.
- **Follow-ups:** use calendar days in `Europe/Riga`, including daylight-saving changes. An unbooked lead is due the day after creation; a cancellation/no-show is due the day after its event; an unresolved past meeting is due the day after the meeting. Return due-today **and overdue** leads once each, excluding met leads and anyone with a future active meeting. The endpoint computes a queue; it does not send messages or mark them sent.

## API

All data endpoints require the HttpOnly session cookie from login. Sessions expire after 12 hours, logout revokes them, passwords use PBKDF2, and only session-token hashes are stored. HTTPS cookies include `Secure`; mutations enforce same-origin requests.

| Method | Route | Result |
| --- | --- | --- |
| POST | `/api/login` | `{email,password}` → session cookie and user |
| POST | `/api/logout` | Revoke current session |
| GET | `/api/me` | Current company account |
| GET | `/api/leads` | Deduplicated leads, status, next meeting, closer |
| GET | `/api/stats` | Per-closer counts/rates and totals |
| GET | `/api/follow-ups` | `{date, timezone, leads:[…reason,dueAt]}` |
| POST | `/api/import` | `{leads:[],bookings:[]}` → import counts |

For example, after logging in:

```sh
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"a@leadinbox.demo","password":"LeadInbox2026!"}' \
  http://localhost:3000/api/login
curl -b cookies.txt http://localhost:3000/api/follow-ups
```

Source schemas: leads use `id, company_id, name, email, phone, created_at`; events use `id, company_id, lead_id, meeting_id, type, occurred_at, meeting_at, closer`. Imports accept up to 1,000 rows in each array and a 2 MB request. IDs are unique within their company; unchanged replays are safe and changed payloads require new IDs. Normalization supports this bounded exercise; a production system should materialize indexed projections rather than replay every read.

## Deployment

The included `.openai/hosting.json` configures the published Sites app and D1 binding; versioned SQL lives in `drizzle/`. The build embeds the UI and sample fixtures in a single Worker module. No database data, credentials, browser profiles, or local runtime binaries enter the repository.

For a separate Cloudflare deployment: install Wrangler, create a D1 database, replace `database_id` in `wrangler.jsonc`, run `node scripts/build.mjs`, `wrangler d1 migrations apply lead-inbox --remote`, and `wrangler deploy`. Use your own accounts and credentials before loading real contacts.

## Skipped and next

Kept the interview scope small: no signup/password reset, manual CRM editing, message delivery, follow-up delivery history, roles beyond company membership, external calendar integration, or database UI. Login backoff is per Worker instance; this is a public sample, not a production account service.

Next: managed authentication and shared rate limits, normalized/indexed lead and meeting projections, paginated server queries, delivery history with suppression/consent, and CI for deployment and browser tests. Clarify the employer’s actual file schema, closer attribution, show-rate denominator, and follow-up rules before importing their real files.
