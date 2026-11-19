# End-to-end tests

These suites test the real Cloud Functions, database rules and storage rules together, against the local
Firebase emulators (project `demo-safelearners`). They never touch the live or test site. Every suite
wipes the emulator data and creates its own test accounts (all `@test.local`, password `password123`).

| Suite | What it covers |
|---|---|
| `regression` | Booking, rescheduling, cancellation, proposals, completion, reviews |
| `wallet_finance` | Wallet, part payments, refunds, invoices, finance records |
| `commission` | Default, introductory and custom commission, change history |
| `super_admin` | Cybria Super Admin, client admin management, roles, permissions, audit |
| `admin_panel` | Super Admin-only areas, client dashboard figures and permissions, layouts |
| `documents` | Document upload, OCR, verification, expiry, eligibility (needs OCR access) |

## Running

1. `backend/.env.local` must list the test Super Admin: `SUPER_ADMIN_EMAILS=super.admin@test.local`
   (plus `ADMIN_EMAILS=legacy.admin@test.local` for the migration check).
2. Build the backend and start the emulators from the project folder:
   `npm --prefix backend run build` then `firebase emulators:start --project demo-safelearners --config firebase.emulator.json`
3. In another terminal: `node e2e/run-all.mjs` (add `--documents` to include the documents suite).

Results are written to `e2e/results/` (not committed). The run exits with an error if any check fails.
