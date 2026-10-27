# 27 Squared CRM

Contacts, companies, deals on a 5-stage pipeline, tasks with reminders, analytics, multi-user logins, CSV import, email notifications, DocuSign e-signature. Node + Express + Postgres. One service, no build step.

## Features

- **Pipeline** — deals (not contacts) move through New lead → Contacted → Qualified → Proposal sent → Closed won. A contact or company can have several deals. Drag-and-drop, All/Mine filter, signature status on each card.
- **Contacts & companies** — profiles, linked deals, tasks, activity log. CSV import with column mapping (contacts can create a deal per row; company names are matched or created).
- **Tasks** — due date, assignee, linked deal/contact. Overdue/Today/Upcoming view; sidebar badge counts what's due.
- **DocuSign** — "Send for signature" on any deal at Proposal sent or Closed won: pick one of your account's templates, signer prefilled from the deal's contact, extra roles editable. Status tracked (sent → delivered → completed/declined/voided) via DocuSign Connect webhook or the Refresh button; void from the CRM.
- **Email notifications** — deal assigned to you, stage change on a deal you own, task assigned to you, envelope signed/declined/voided, and an 8:00 ET digest of tasks due/overdue.
- **Email** — send one-to-one from a contact or deal: goes out via connect@ with the sender's name, Reply-To set to the sender, open tracking, merge tags (`{{first_name|there}}`, `{{company}}`, `{{deal_name}}`, `{{sender_name}}`, `{{contact.<custom key>}}`). Replies are captured over IMAP from the connect@ inbox, logged on the contact, and the owner is notified. BCC connect@ from Gmail to log mail sent outside the CRM.
- **Sequences** — multi-step email cadences (day 0 / +2 / +5…), sent from the enrolling user's name at 9:00 ET on weekdays, optional same-thread replies. Auto-stop on reply, on Closed won, on Mark lost, or manually. Sequences page shows active/replied/completed per sequence.
- **Custom properties** (admin, Settings) — text, textarea, number, date, dropdown, checkbox on contacts, companies and deals. Shown on forms and profiles, mappable in CSV import, contact properties usable as merge tags.
- **Pipelines** (admin, Settings) — several pipelines, each with its own stages; every stage carries a win probability, a "won" flag and a "signatures allowed" flag. Board shows plain and weighted totals per column; Analytics has a weighted forecast and forecast by expected-close month. Renaming a stage moves its deals.
- **Rate card & line items** — products seeded from the 27SQ rate card (appends, hygiene, One Connect, Hercules ESP tiers, SMS tiers, direct mail tiers, postage, social/CTV media and management, creative, agency fee). Add them to a deal as line items: quantity, unit rate (auto from volume tiers, override freely), term for monthly items. Line items drive the deal value.
- **Quotes** — one click builds a branded proposal PDF from the deal's line items (overview, one-time/monthly investment table, tinted subtotals, magenta total, terms, acceptance block), numbered Q-YYYY-nnnn and stored on the deal. View, email with PDF attached, mark accepted.
- **Web forms** — form builder (standard + custom fields), hosted branded page at `/f/<key>` and a one-line embed snippet (auto-sizing iframe). Submissions create or update the contact (match by email, fill blanks only), create the company, optionally a deal at a chosen stage, log the submission, notify the owner. Honeypot + rate limiting.
- **Website tracking** — `<script src=".../track.js" async>` sets a first-party cookie and records page views; once a visitor submits a form (or is identified) their earlier visits attach to the contact and show under "Website activity". Identify webhook `POST /api/public/identify/<siteKey>` for SmartPiXL / One Connect to push identified visitors (email + optional name/company/url).
- **Workflows** — triggers: deal created, stage changed (with pipeline/stage filters), won, lost, contact created, form submitted (per form), no activity for N days (hourly scan, once per deal per N days). Conditions: vertical, source, owner, min value. Actions: create task, email the owner, email the contact (tracked), enroll in sequence, assign owner, move stage, add note. Run log per workflow.
- **Meetings** — each user sets a Google Calendar appointment-schedule link in My profile: "Book a meeting" button on contacts and `{{meeting_link}}` merge tag. With Google Calendar sync (service account + domain-wide delegation), meetings whose attendees match a contact are logged automatically (scheduled → held → cancelled) and the next meeting shows on the deal.
- **Claude connector (MCP)** — the CRM serves a remote MCP endpoint at `/mcp/<api key>` (stateless Streamable HTTP, 19 tools: setup, find/get/add/update contacts, companies, list/get/create/update deals, log activity, tasks, send email, enroll in sequence, pipeline summary, forecast, recent activity). Add it in claude.ai → Settings → Connectors → Add custom connector. Actions are attributed to the key's creator.
- **Inbound contacts API** — admin creates API keys in Settings; `POST /api/inbound/contacts` with `X-API-Key` accepts one contact or a batch with forgiving field names (Seamless.AI, Zapier, HubSpot-style). Updates by email, creates companies, optional deal. Use with Zapier's Seamless.AI "New Contact" trigger → Webhooks by Zapier.
- **Dashboards** — build as many as you want from 18 widgets (key numbers, weighted forecast by close month, pipeline by stage/owner, won by owner, new vs won over time, source performance, deals by vertical, activity leaderboard, email performance, sequence performance, funnel, top companies, quotes, tasks by user, quota attainment, form submissions, stale deals). Sizes 1–3 columns, reorder, date ranges 7d/30d/90d/MTD/QTD/YTD. "Email me this now" and a Monday 8:00 ET weekly digest to chosen recipients.
- **Forecast** — per rep × month: quota, closed won, commit, best case, pipeline, weighted, forecast (won + commit), best case, gap. Team totals. Categories derive from stage probability (≥75% commit, ≥50% best case) or are set per deal (commit / best / pipeline / omit). Lists open deals with no close date. Admins edit monthly quotas inline.
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

**Reply capture** — uses the same Gmail credentials as sending (`SMTP_USER`/`SMTP_PASS`) over IMAP; set `IMAP_HOST` for a non-Gmail provider. IMAP must be enabled on the mailbox. The CRM polls every 60s, starting from the most recent 50 messages on first run.

**Google Calendar sync** — Google Cloud project → enable Calendar API → service account → JSON key. In Google Admin → Security → API controls → Domain-wide delegation, authorize the service account's client ID for scope `https://www.googleapis.com/auth/calendar.readonly`. Set `GOOGLE_SA_JSON_B64` to the base64 of the key file. Syncs every 10 minutes; Settings has "Sync now".

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
| `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS`, `IMAP_POLL_SECONDS` | no | reply capture; defaults to Gmail + SMTP creds |
| `SEQ_SEND_HOUR` | no | hour (in `DIGEST_TZ`) sequence steps go out, default 9 |
| `GOOGLE_SA_JSON_B64`, `CALENDAR_POLL_MINUTES` | no | Google Calendar sync |
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
lib/engage.js      tracked email, merge tags, sequence scheduler, IMAP reply capture
lib/catalog.js     rate-card seed + tiered pricing
lib/quote-pdf.js   branded proposal PDF (pdfkit)
lib/workflows.js   automation engine
lib/calendar.js    Google Calendar sync (service account)
lib/metrics.js     dashboard widgets, forecast, email digest
lib/mcp.js         remote MCP server for Claude
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
GET    /api/emails?contactId=|dealId=   POST /api/emails   POST /api/emails/preview   GET /t/:token.gif (open pixel)
POST   /api/sequences                   PUT/DELETE /api/sequences/:id   POST /api/sequences/:id/enroll
POST   /api/enrollments/:id/stop
POST   /api/properties (admin)          PUT/DELETE /api/properties/:id (admin)
POST   /api/pipelines (admin)           PUT/DELETE /api/pipelines/:id (admin)
POST   /api/products (admin)            PUT/DELETE /api/products/:id (admin)
GET/POST /api/deals/:id/items           PUT/DELETE /api/items/:id        POST /api/deals/:id/value (manual override)
GET/POST /api/deals/:id/quotes          GET /api/quotes/:id.pdf          POST /api/quotes/:id/send   PATCH /api/quotes/:id/status
POST   /api/forms                       PUT/DELETE /api/forms/:id        GET /api/forms/:id/submissions
GET    /f/:key  /f/:key/embed.js  /track.js          (public)
POST   /api/public/forms/:key/submit  /api/public/track  /api/public/identify/:siteKey   (public, CORS)
GET    /api/contacts/:id/visits
POST   /api/workflows                   PUT/DELETE /api/workflows/:id    GET /api/workflows/:id/runs   POST /api/workflows/scan (admin)
GET    /api/meetings?contactId=|dealId= POST /api/meetings/sync (admin)
PUT    /api/me                          booking link, calendar sync opt-in
POST   /api/dashboards                  PUT/DELETE /api/dashboards/:id   GET /api/dashboards/:id/data?range=   POST /api/dashboards/:id/email
GET    /api/forecast?months=            PUT /api/quotas (admin)
GET/POST /api/keys (admin)              DELETE /api/keys/:id             POST /api/inbound/contacts (X-API-Key)
POST   /mcp/:key                        remote MCP server (claude.ai custom connector)
POST   /api/users (admin)               PUT /api/users/:id (admin)
GET    /api/settings (admin)            POST /api/settings/test-email (admin)
GET    /api/export
```


## Launchpad handoff (onboarding)
Closed-won deals can be pushed to 27SQ Launchpad, which creates the client with its onboarding checklist and one launch checklist per channel found in the deal's line items (Hercules ESP → Email, SMS → SMS, Direct Mail → Direct Mail, Paid Social → META + TikTok, CTV → CTV/OTT, append/hygiene → Data Hygiene, creative → Creative). SMS and email default to weekly deployment cycles.

- **Manual:** open a Closed-won deal → **Push to Launchpad** → adjust channels / target launch → push. Re-pushing updates the same client and only adds missing channels. The deal then shows **Open in Launchpad ↗**.
- **Automatic:** Workflows → New → When *Deal won* → Then *Push to Launchpad*.
- **Setup:** on the CRM's Render service set `LAUNCHPAD_URL` (Launchpad service URL) and `LAUNCHPAD_SECRET` (Launchpad's `CRM_WEBHOOK_SECRET`). Settings → Launchpad shows connection status.
