# Lead Inbox

My solution for the Lead Inbox task. It includes separate company logins, JSON imports, a lead list, closer stats and a follow-up queue.

I used plain JavaScript for the frontend and backend. Local development uses SQLite. For Vercel, the app connects to a Turso database through its JavaScript client.

[Live demo](https://lead-inbox-sprud-2026.lielie-d-i-8001.chatgpt.site) · [Repository](https://github.com/ArtursSprudzans/lead-inbox)

## Try it

| Company | Email | Password |
| --- | --- | --- |
| A | `a@leadinbox.demo` | `LeadInbox2026!` |
| B | `b@leadinbox.demo` | `LeadInbox2026!` |

Both accounts use made-up contacts. The company comes from the login session, so changing a company ID in a request doesn't give access to the other company's records.

## Run locally

You'll need Node.js 24.11 or newer within the 24.x release.

```sh
npm ci
node scripts/dev.mjs          # starts at http://localhost:3000
node --test tests/*.test.mjs  # run the tests
npm run build                # build for Vercel
```

The sample files are loaded automatically on the first API request. Local data is saved in `.local/inbox.sqlite`. You can also upload both files through **Import data**. Importing them again won't create extra leads or bookings.

## Deploy on Vercel

Import this repository into Vercel using the **Other** framework preset. The build command and API routes are already set in `vercel.json`.

Connect a [Turso database](https://vercel.com/marketplace/tursocloud) from Vercel's Storage Marketplace. The app needs `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in its deployment environment. Keep preview and production databases separate if you enable preview deployments.

The Vercel build applies the SQL migrations before deploying. On the first API request, the app loads the sample data and creates the two demo accounts. Sessions and imports are stored in Turso, so they survive restarts and redeployments.

To apply migrations yourself, copy `.env.example` to an ignored `.env.local`, fill in the database credentials, and run `npm run db:migrate`. The existing demo link above still points to the original deployment until the Vercel deployment is published.

## Data and assumptions

I didn't receive the original files, so I generated [leads.json](data/leads.json) and [bookings.json](data/bookings.json). There are 46 lead records that merge into 40 people, split evenly between the two companies, and 72 booking events. The examples include duplicates, cancellations, reschedules, attended meetings and no-shows.

These are the rules I used where the task wasn't specific:

- A matching phone number or email means the same person within a company. Phone formatting and email casing are ignored. A matching name alone isn't enough.
- Each appointment has a `meeting_id`. Rescheduling keeps that ID; booking again after a cancellation or outcome uses a new one. Events are processed by their timestamp, regardless of file order.
- The next active meeting determines a lead's status. If there isn't one, I use the latest event. A lead with no events is new.
- Booked counts appointments, so a reschedule doesn't count twice. Cancelled appointments still count as having been booked. Stats go to the latest assigned closer.
- Show rate is `showed / (showed + no-shows)`. Future meetings, cancellations and meetings without an outcome are left out of that calculation. Stats cover all imported history.
- Follow-ups become due the next calendar day after a lead is created without a meeting, a cancellation or a no-show. Past meetings without an outcome also become due the next day. The queue includes overdue leads and excludes people who attended or have a future meeting. Dates use `Europe/Riga`.

The checked-in data uses 10 November 2026 as its reference date. To generate another set:

```sh
node scripts/generate-data.mjs --date 2026-11-10
```

Leaving out `--date` uses today's date in Riga. This only changes the JSON files; it doesn't replace an existing database. Use a fresh `DATABASE_PATH` when running locally if you want to load a new set.

## Follow-up endpoint

`GET /api/follow-ups` returns the logged-in company's leads due today or earlier, with a reason and due date. It uses the same session cookie as the app.

```sh
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"a@leadinbox.demo","password":"LeadInbox2026!"}' \
  http://localhost:3000/api/login
curl -b cookies.txt http://localhost:3000/api/follow-ups
```

The tests cover company separation, sessions, repeated and invalid imports, event ordering, stats and follow-up dates. There's also a browser check in `scripts/browser-smoke.mjs` for the main flows and mobile layouts.

## What I left out

No signup, password reset, manual lead editing or calendar integration. The follow-up endpoint returns a list; it doesn't send messages or track whether someone has already been contacted. Login rate limiting is per server instance.

## What I'd do next

First, check the assumptions against the actual input files and agree on the follow-up rules. After that I'd add proper account management, shared rate limiting and a record of sent follow-ups. For larger datasets, I'd store indexed lead and meeting summaries instead of replaying the events on every read, and move pagination to the server.
