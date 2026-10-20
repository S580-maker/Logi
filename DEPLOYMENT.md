# Deployment

## Current app shape

LogiAuth is a responsive web app that can be installed from a supported desktop or mobile browser as a PWA. On supported browsers, use **Install app** in the dashboard; other browsers may offer installation from their browser menu. Courses accept PDF, PowerPoint, Word, text, and audio materials. Set `GROQ_API_KEY` in the server's private `.env` file to enable Groq-powered source-grounded notebook answers, study insights, study sets, and audio transcription. Optionally set `GROQ_MODEL` and `GROQ_TRANSCRIPTION_MODEL` to select supported Groq models; the default text model is `openai/gpt-oss-20b` for faster responses. Never put the API key in browser code, a public repository, or a user-facing client form. The notebook can explain concepts, recap selected sources, quiz interactively, and accept optional browser-based voice dictation. Answers use the selected course material; citations are shown only when verified against the source text. Learners can record audio in a supported browser or upload recordings for Groq Whisper transcription. YouTube import uses captions available on public videos; upload audio for videos without captions. Import only videos whose transcripts you own or have permission to use, and review AI transcripts for mistakes. Voice dictation uses the browser's speech-recognition service; review the transcript before sending it. Study groups support discoverable or invite-only joining, member chat, group-shared PDF/PowerPoint/Word/text files, and leader-managed goals and tasks with assignments and progress status. Only group members can access group files and discussion; personal notes and progress remain private. Group files are stored alongside course uploads, so production deployments require persistent storage as described below. Apply the study-group tables in `db/schema.sql` with `npm run db:init`. The PWA caches only its public app shell; authenticated API requests are never cached. When offline, the dashboard explains that account and study data require a connection. It is not a native iOS/Android app-store package.

The **Personal AI** section provides general chat without selecting a course. Conversation history is stored in browser storage for the signed-in account on that browser; it is not synced to other devices.

## Setup

1. Use Node.js 22.13 or newer and a PostgreSQL database.
2. Configure the environment variables required by `utils/validate-production-env.js`: `DATABASE_URL` (or a supported Postgres URL alias), `DATABASE_CA_CERT_BASE64`, `REDIS_URL`, `SESSION_SECRET`, `PEPPER`, `GMAIL_USER`, and `GMAIL_APP_PASSWORD`. Add `GROQ_API_KEY` to the private `.env` file for AI and audio transcription; restart the server after changing it.
3. Use random secrets of at least 32 bytes for `SESSION_SECRET` and `PEPPER`. Keep both outside source control. Do not rotate `PEPPER` without a password-hash migration: existing passwords will stop verifying.
4. Run `npm run db:init`, then create the first administrator with `npm run user:create`.
5. Start with `npm start`. Serve production over HTTPS so secure cookies, passkeys, and PWA installation work.

Passwords are processed with bcrypt using 12 rounds, a separately generated per-password salt, and the server-side `PEPPER`. The bcrypt hash embeds its salt; the separate `salt` column is retained as the per-user salt record. The pepper is never stored in the database.

## Backups and account lifecycle

Admin restore points save system settings and a summary of counts/role totals. Restoring one changes settings only; it does not restore or overwrite user, role, course, or learning records. These are **not** database disaster-recovery backups. Configure provider-managed PostgreSQL backups/PITR separately to recover data after database loss.

Deleted accounts are archived and deactivated. Their password/passkey/recovery credentials are revoked, while learning records are preserved.

## Hosting constraint

Uploaded slide files currently use the app server's local filesystem. The existing Vercel path writes to temporary storage, which is not durable across serverless invocations. Do not use Vercel for production slide uploads until persistent object storage is implemented. A Node host with a persistent disk is compatible with the current file-storage design; multi-instance deployments also need shared file storage. Select the hosting provider and storage target before deploying production.

## AWS single-instance deployment

The initial AWS deployment uses one encrypted EC2 volume for the Node app, Redis, and persistent slide uploads. CloudFront provides the HTTPS address; the EC2 origin accepts requests only when they include the generated origin token. The app continues to use the PostgreSQL database configured in `.env`; the deployment does not copy, migrate, or modify database records.

This is a single-instance setup, not a highly available production architecture. It assumes an AWS Free plan account with credits; EC2, its EBS volume, CloudFront usage, and S3 storage consume those credits, and deployment stops if the account runs out of credits. Do not convert the account to a Paid plan without reviewing the estimated charges first. Back up the database and slide files separately before relying on this host.

Prerequisites:

- An AWS account on the Free plan and AWS CLI v2 installed and signed in.
- A default VPC with a public subnet in the selected AWS region.
- The root `.env` configured with the production PostgreSQL URL, CA certificate, session secret, password pepper, and email credentials. The deployment script uploads this file to a private S3 bucket using server-side encryption; it never includes `.env` in the application archive.

From the repository root, run:

```powershell
.\deploy\aws\deploy.ps1
```

The script creates the EC2 host, restricted S3 artifact bucket, and CloudFront distribution, then sends the application and environment file to the host through Systems Manager. It prints the HTTPS website URL when the app passes its startup check. AWS infrastructure creation requires permissions for CloudFormation, EC2, IAM, S3, CloudFront, and Systems Manager. Resource provisioning may take several minutes.

The instance keeps Redis data and uploaded slides on an encrypted EBS volume. PowerPoint previews use LibreOffice in the Linux container. Passkeys are domain-bound, so users may need to register new passkeys after moving to the CloudFront URL. Existing slide database records are retained, but files that were only on Vercel's temporary filesystem are not migrated.

For local container testing, set `ORIGIN_VERIFY_TOKEN` to a random value and run:

```powershell
docker compose up --build
```

The local app is available at `http://localhost:8080`. PostgreSQL still uses the connection in `.env`.
