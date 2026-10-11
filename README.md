# Safe Learners

Booking platform for Australian driving instructors and learners — live at **https://australiadrivingproj.web.app**.

Learners find a verified instructor by suburb or postcode, book from live availability, reschedule or cancel online and pay from a wallet. Instructors manage their calendar, availability, pricing, documents and payouts. Admins verify instructors, moderate reviews and manage users.

## Stack

| Part | Tech |
|---|---|
| Web app (`web/`) | React 19, TypeScript, Vite, Tailwind CSS, React Router |
| Backend (`backend/`) | Firebase Cloud Functions v2 (Node 22, `australia-southeast1`), bundled with esbuild |
| Shared rules (`shared/`) | Pricing, availability/slot engine, time zones, booking refs, document parsing — used by both |
| Data | Cloud Firestore, Cloud Storage, Firebase Auth, Firestore & Storage security rules |
| Other | Google Maps / Places (suburbs, postcodes, maps), Cloud Vision (reading licence photos), Cloud Scheduler |

All booking, wallet, pricing and verification changes go through Cloud Functions (transactions, conflict checks); the security rules stop clients writing them directly.

## Project layout

```
web/            React app (pages: public, learner, instructor, admin)
backend/src/    Cloud Functions: bookings, accounts, documents, reviews, scheduled jobs
shared/         Domain logic shared by web and backend
firestore.rules, storage.rules, firestore.indexes.json
firebase.json            Production config (hosting serves web/dist)
firebase.emulator.json   Local emulator config
public/         The previous single-page site (kept for reference/rollback)
functions/      Previous functions folder (see deploy warning below)
```

## Run locally (emulators)

Requires Node 22+, Java 17+ and the Firebase CLI.

```bash
cd backend && npm install && npm run build && cd ..
cd web && npm install && cd ..

# Terminal 1 — Auth, Firestore, Functions and Storage emulators (demo project, never touches production)
firebase emulators:start --config firebase.emulator.json --project demo-safelearners

# Terminal 2 — web app against the emulators
cd web && VITE_USE_EMULATORS=true npm run dev
```

For the emulator, `backend/.env.local` can set `ADMIN_EMAILS=you@example.com` so that account gets admin access.

## Tests

```bash
cd web && npm test          # unit tests for the shared logic (time zones, slots, pricing, parsing…)
cd web && npx tsc -b        # type check
cd backend && npm run typecheck
```

## Deploy

```bash
cd web && npm run build && cd ..
firebase deploy --only functions:app,firestore,storage,hosting --project australiadrivingproj
```

> **Always deploy functions with `--only functions:app`.** The project also runs a function called `processLicenseDocuments` whose source is not in this repo; a plain `firebase deploy` would delete it.

### Configuration

- `ADMIN_EMAILS` (backend env) — comma-separated emails that get admin access on sign-in.
- `RESEND_API_KEY`, `EMAIL_FROM` (backend env, optional) — enables email notifications. Without them notifications are in-app only.
- The Firebase web config and Google Maps key in `web/src` are browser keys; restrict the Maps key to the site's domains in Google Cloud.
