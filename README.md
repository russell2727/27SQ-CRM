# 27 Squared CRM

Contacts, 5-stage lead pipeline, company profiles, analytics, multi-user logins. Node + Express + Postgres. One service, no build step.

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

## Env vars

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Railway Postgres reference |
| `SESSION_SECRET` | yes in prod | Random, 32+ chars. Changing it logs everyone out. |
| `NODE_ENV` | recommended | `production` turns on secure cookies |
| `PGSSL` | no | Set `true` only if connecting to Postgres over the public proxy URL |
| `PORT` | no | Railway sets this |

## Roles

- **Admin** — everything, plus Team page: add users, reset passwords, change roles, deactivate.
- **Member** — full CRM access (all leads visible; "Mine" filter on the pipeline).

No self-signup. Admin creates each account with a temporary password; the user changes it from the sidebar.

## Backups

Sidebar → **Export backup (JSON)** dumps contacts, companies and activities. Railway Postgres also supports point-in-time backups on paid plans.

## Structure

```
server.js          API + auth + static hosting
schema.sql         tables (auto-applied on boot)
public/index.html  the whole front end
```

## API (session cookie auth)

```
GET    /api/auth/status            POST /api/auth/setup | login | logout | password
GET    /api/bootstrap               everything the UI needs in one call
POST   /api/contacts                PUT/DELETE /api/contacts/:id
PATCH  /api/contacts/:id/stage      PATCH /api/contacts/:id/lost
GET/POST /api/contacts/:id/activities
POST   /api/companies               PUT/DELETE /api/companies/:id
POST   /api/users (admin)           PUT /api/users/:id (admin)
GET    /api/export
```
