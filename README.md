# 27 Squared CRM

Contacts, companies, deals on a 5-stage pipeline, tasks with reminders, analytics, multi-user logins, CSV import, email notifications, DocuSign e-signature. Node + Express + Postgres. One service, no build step.

## Features

- **Pipeline** — deals (not contacts) move through New lead → Contacted → Qualified → Proposal sent → Closed won. A contact or company can have several deals. Drag-and-drop, All/Mine filter, signature status on each card.
- **Contacts & companies** — profiles, linked deals, tasks, activity log. CSV import with column mapping (contacts can create a deal per row; company names are matched or created).
- **Tasks** — due date, assignee, linked deal/contact. Overdue/Today/Upcoming view; sidebar badge counts what's due.
- **DocuSign** — "Send for signature" on any deal at Proposal sent or Closed won: pick one of your account's templates, signer prefilled from the deal's contact, extra roles editable. Status tracked (sent → delivered → completed/declined/voided) via DocuSign Connect webhook or the Refresh button; void from the CRM.
- **Email notifications** — deal assigned to you, stage change on a deal you own, task assigned to you, envelope signed/declined/voided, and an 8:00 ET digest of tasks due/overdue.
- **Analytics** — new contacts/deals, open pipeline, win rate, average deal, awaiting signature, funnel, breakdowns by stage/vertical/source/owner/company.
- **Team** (admin) — add users, roles, deactivate, reset passwords. **Settings** (admin) — integration status and setup instructions.

## Deploy on Render (one click)

`render.yaml` in this repo defines the web service + Postgres.

1. render.com → **New → Blueprint** → connect GitHub → pick `russell2727/27SQ-CRM` → **Apply**.
2. Render creates the `27sq-crm` web service and `27sq-crm-db` Postgres, wires `DATABASE_URL`, and generates `SESSION_SECRET`.
3. Open the service URL. First visit creates the admin account.

Cost: web service Starter (~$7/mo) + Postgres Basic (~$6/mo). The free web tier also works but sleeps after idle; swap `plan: starter` for `plan: free` in `render.yaml` if you want that.

## Deploy on Railway

1. Push this folder to a GitHub repo (private is fine).
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo. Railway detects Node and runs `npm start`.
3. In the same project: **+ New → Database → PostgreSQL**.
4. Open the CRM service → **Variables** → add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (use the reference picker so it stays in sync)
   - `SESSION_SECRET` = any long random string (`openssl rand -hex 32`)
   - `NODE_ENV` = `production`
5. **Settings → Networking → Generate Domain**. Open it.
6. First visit shows **Create the admin account**. That runs once. After that, add teammates from **Team**.

Schema is created automatically on first boot (`schema.sql`). Sessions live in Postgres, so logins survive redeploys.

## Run locally

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/crm SESSION_SECRET=dev npm run dev
```
Open http://localhost:3000.

## Integrations

**Email** — set `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` (or one `SMTP_URL`) and `MAIL_FROM`. Any provider: Google Workspace SMTP, SendGrid, Postmark, Resend, SES. Settings page has a "send me a test" button. Without these, notifications are logged, not sent.

**DocuSign** — JWT grant, no per-user login.
1. DocuSign → Settings → Apps and Keys → Add App. Note the **Integration Key**, your **User ID** and the **API Account ID** shown on that page. Generate an RSA keypair there and download the private key.
2. Set `DS_INTEGRATION_KEY`, `DS_USER_ID`, `DS_ACCOUNT_ID`, `DS_PRIVATE_KEY_B64` (= `base64 -w0 private.key`), `DS_ENV=production` (or `demo` for the developer sandbox).
3. First use requires one-time consent: Settings page shows the link if DocuSign reports `consent_required`. Open it while signed in as the API user and accept.
4. Status pushes: DocuSign → Settings → Connect → Add configuration → URL `https://<your-app>/api/docusign/webhook`, JSON format, events envelope sent/delivered/completed/declined/voided, and set an HMAC key. Put that key in `DS_WEBHOOK_SECRET`. Without Connect, use Refresh on the envelope.

Templates must have named signer roles (e.g. "Client"); the first signer role is the client and is prefilled from the deal's contact.

## Env vars

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Railway Postgres reference |
| `SESSION_SECRET` | yes in prod | Random, 32+ chars. Changing it logs everyone out. |
| `NODE_ENV` | recommended | `production` turns on secure cookies |
| `PGSSL` | no | Set `true` only if connecting to Postgres over the public proxy URL |
| `PORT` | no | set by the host |
| `APP_URL` | recommended | public URL, used in email links (Render sets `RENDER_EXTERNAL_URL` automatically) |
| `SMTP_*` / `SMTP_URL`, `MAIL_FROM` | no | email notifications |
| `DIGEST_HOUR`, `DIGEST_TZ` | no | daily task digest, default 8 / America/New_York |
| `DS_INTEGRATION_KEY`, `DS_USER_ID`, `DS_ACCOUNT_ID`, `DS_PRIVATE_KEY_B64`, `DS_ENV`, `DS_WEBHOOK_SECRET` | no | DocuSign |

## Roles

- **Admin** — everything, plus Team page: add users, reset passwords, change roles, deactivate.
- **Member** — full CRM access (all leads visible; "Mine" filter on the pipeline).

No self-signup. Admin creates each account with a temporary password; the user changes it from the sidebar.

## Backups

Sidebar → **Export backup (JSON)** dumps contacts, companies and activities. Railway Postgres also supports point-in-time backups on paid plans.

## Structure

```
server.js          API + auth + notifications + static hosting
lib/docusign.js    DocuSign JWT auth, templates, envelopes, Connect webhook verification
lib/mail.js        SMTP transport
schema.sql         tables + idempotent migrations (auto-applied on boot)
public/index.html  the whole front end
```

## API (session cookie auth)

```
GET    /api/auth/status                POST /api/auth/setup | login | logout | password
GET    /api/bootstrap                   everything the UI needs in one call
POST   /api/contacts                    PUT/DELETE /api/contacts/:id        (POST accepts createDeal)
POST   /api/companies                   PUT/DELETE /api/companies/:id
POST   /api/deals                       PUT/DELETE /api/deals/:id
PATCH  /api/deals/:id/stage             PATCH /api/deals/:id/lost
POST   /api/deals/:id/envelopes         send a DocuSign template for signature
POST   /api/envelopes/:id/refresh       POST /api/envelopes/:id/void
POST   /api/docusign/webhook            DocuSign Connect (HMAC verified)
GET    /api/docusign/status | templates | templates/:id/roles
GET    /api/activities?dealId=|contactId=   POST /api/activities
POST   /api/tasks                       PUT/DELETE /api/tasks/:id
POST   /api/import/contacts             POST /api/import/companies
POST   /api/users (admin)               PUT /api/users/:id (admin)
GET    /api/settings (admin)            POST /api/settings/test-email (admin)
GET    /api/export
```
