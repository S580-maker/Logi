# Deployment

## Current app shape

LogiAuth is a responsive web app that can be installed from a supported desktop or mobile browser as a PWA. The PWA caches only its public app shell; authenticated API requests are never cached. It is not a native iOS/Android app-store package.

## Setup

1. Use Node.js 22.13 or newer and a PostgreSQL database.
2. Configure the environment variables required by `utils/validate-production-env.js`: `DATABASE_URL` (or a supported Postgres URL alias), `DATABASE_CA_CERT_BASE64`, `REDIS_URL`, `SESSION_SECRET`, `PEPPER`, `GMAIL_USER`, and `GMAIL_APP_PASSWORD`.
3. Use random secrets of at least 32 bytes for `SESSION_SECRET` and `PEPPER`. Keep both outside source control. Do not rotate `PEPPER` without a password-hash migration: existing passwords will stop verifying.
4. Run `npm run db:init`, then create the first administrator with `npm run user:create`.
5. Start with `npm start`. Serve production over HTTPS so secure cookies, passkeys, and PWA installation work.

Passwords are processed with bcrypt using 12 rounds, a separately generated per-password salt, and the server-side `PEPPER`. The bcrypt hash embeds its salt; the separate `salt` column is retained as the per-user salt record. The pepper is never stored in the database.

## Backups and account lifecycle

Admin restore points save system settings and a summary of counts/role totals. Restoring one changes settings only; it does not restore or overwrite user, role, course, or learning records. These are **not** database disaster-recovery backups. Configure provider-managed PostgreSQL backups/PITR separately to recover data after database loss.

Deleted accounts are archived and deactivated. Their password/passkey/recovery credentials are revoked, while learning records are preserved.

## Hosting constraint

Uploaded slide files currently use the app server's local filesystem. The existing Vercel path writes to temporary storage, which is not durable across serverless invocations. Do not use Vercel for production slide uploads until persistent object storage is implemented. A Node host with a persistent disk is compatible with the current file-storage design; multi-instance deployments also need shared file storage. Select the hosting provider and storage target before deploying production.
