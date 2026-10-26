CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',   -- admin | member
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  domain      TEXT DEFAULT '',
  phone       TEXT DEFAULT '',
  vertical    TEXT DEFAULT '',
  size        TEXT DEFAULT '',
  city        TEXT DEFAULT '',
  state       TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id            SERIAL PRIMARY KEY,
  first_name    TEXT DEFAULT '',
  last_name     TEXT DEFAULT '',
  title         TEXT DEFAULT '',
  email         TEXT DEFAULT '',
  phone         TEXT DEFAULT '',
  company_id    INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  vertical      TEXT DEFAULT '',
  source        TEXT DEFAULT '',
  stage         TEXT NOT NULL DEFAULT 'New lead',
  value         NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes         TEXT DEFAULT '',
  lost          BOOLEAN NOT NULL DEFAULT FALSE,
  lost_at       TIMESTAMPTZ,
  won_at        TIMESTAMPTZ,
  stage_history JSONB NOT NULL DEFAULT '[]',
  owner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS deal_migrated BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS deals (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  contact_id     INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  company_id     INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  stage          TEXT NOT NULL DEFAULT 'New lead',
  value          NUMERIC(14,2) NOT NULL DEFAULT 0,
  vertical       TEXT DEFAULT '',
  source         TEXT DEFAULT '',
  expected_close DATE,
  notes          TEXT DEFAULT '',
  lost           BOOLEAN NOT NULL DEFAULT FALSE,
  lost_at        TIMESTAMPTZ,
  won_at         TIMESTAMPTZ,
  stage_history  JSONB NOT NULL DEFAULT '[]',
  owner_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activities (
  id          SERIAL PRIMARY KEY,
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT NOT NULL DEFAULT 'Note',
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE activities ALTER COLUMN contact_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  due_at       DATE,
  done         BOOLEAN NOT NULL DEFAULT FALSE,
  done_at      TIMESTAMPTZ,
  deal_id      INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  contact_id   INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  assignee_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS envelopes (
  id             SERIAL PRIMARY KEY,
  deal_id        INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  envelope_id    TEXT UNIQUE NOT NULL,
  template_id    TEXT,
  template_name  TEXT,
  signer_name    TEXT,
  signer_email   TEXT,
  status         TEXT NOT NULL DEFAULT 'sent',
  sent_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS contacts_company_idx   ON contacts(company_id);
CREATE INDEX IF NOT EXISTS deals_stage_idx        ON deals(stage);
CREATE INDEX IF NOT EXISTS deals_contact_idx      ON deals(contact_id);
CREATE INDEX IF NOT EXISTS deals_company_idx      ON deals(company_id);
CREATE INDEX IF NOT EXISTS deals_owner_idx        ON deals(owner_id);
CREATE INDEX IF NOT EXISTS activities_contact_idx ON activities(contact_id);
CREATE INDEX IF NOT EXISTS activities_deal_idx    ON activities(deal_id);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx     ON tasks(assignee_id, done, due_at);
CREATE INDEX IF NOT EXISTS envelopes_deal_idx     ON envelopes(deal_id);

-- One-time migration: every pre-existing contact becomes one deal (the pipeline is now deal-based).
INSERT INTO deals (name, contact_id, company_id, stage, value, vertical, source, notes, lost, lost_at, won_at, stage_history, owner_id, created_by, created_at)
SELECT COALESCE(NULLIF(co.name, ''), NULLIF(TRIM(c.first_name || ' ' || c.last_name), ''), 'Deal'),
       c.id, c.company_id, c.stage, c.value, c.vertical, c.source, '', c.lost, c.lost_at, c.won_at, c.stage_history, c.owner_id, c.created_by, c.created_at
FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
WHERE c.deal_migrated = FALSE;
UPDATE activities a SET deal_id = d.id FROM deals d JOIN contacts c ON c.id = d.contact_id
WHERE a.contact_id = c.id AND a.deal_id IS NULL AND c.deal_migrated = FALSE AND a.text LIKE 'Moved to %';
UPDATE contacts SET deal_migrated = TRUE WHERE deal_migrated = FALSE;

-- ===== Round 1: custom properties, email, sequences =====
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS custom JSONB NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom JSONB NOT NULL DEFAULT '{}';
ALTER TABLE deals     ADD COLUMN IF NOT EXISTS custom JSONB NOT NULL DEFAULT '{}';
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS last_emailed_at TIMESTAMPTZ;
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS last_replied_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS properties (
  id         SERIAL PRIMARY KEY,
  object     TEXT NOT NULL,                -- contact | company | deal
  key        TEXT NOT NULL,
  label      TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'text', -- text | number | date | select | checkbox | textarea
  options    JSONB NOT NULL DEFAULT '[]',
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (object, key)
);

CREATE TABLE IF NOT EXISTS emails (
  id              SERIAL PRIMARY KEY,
  direction       TEXT NOT NULL DEFAULT 'out',  -- out | in
  contact_id      INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id         INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  enrollment_id   INTEGER,
  step_index      INTEGER,
  from_email      TEXT DEFAULT '',
  to_email        TEXT DEFAULT '',
  subject         TEXT DEFAULT '',
  body            TEXT DEFAULT '',
  message_id      TEXT,
  in_reply_to     TEXT,
  track_token     TEXT UNIQUE,
  open_count      INTEGER NOT NULL DEFAULT 0,
  first_opened_at TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS emails_contact_idx ON emails(contact_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS emails_msgid_idx   ON emails(message_id);

CREATE TABLE IF NOT EXISTS sequences (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  steps       JSONB NOT NULL DEFAULT '[]',  -- [{delayDays, subject, body}]
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS enrollments (
  id            SERIAL PRIMARY KEY,
  sequence_id   INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id    INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id       INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- sender
  status        TEXT NOT NULL DEFAULT 'active',  -- active | completed | replied | stopped | failed
  current_step  INTEGER NOT NULL DEFAULT 0,
  next_send_at  TIMESTAMPTZ,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  end_reason    TEXT
);
CREATE INDEX IF NOT EXISTS enrollments_due_idx ON enrollments(status, next_send_at);
CREATE INDEX IF NOT EXISTS enrollments_contact_idx ON enrollments(contact_id);

-- ===== Round 2: pipelines, products / line items, quotes =====
CREATE TABLE IF NOT EXISTS pipelines (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  stages      JSONB NOT NULL DEFAULT '[]',   -- [{name, probability, won, sign}]
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO pipelines (name, stages, is_default, sort)
SELECT 'Sales', '[{"name":"New lead","probability":10},{"name":"Contacted","probability":25},{"name":"Qualified","probability":50},{"name":"Proposal sent","probability":75,"sign":true},{"name":"Closed won","probability":100,"won":true,"sign":true}]', TRUE, 0
WHERE NOT EXISTS (SELECT 1 FROM pipelines);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS pipeline_id INTEGER REFERENCES pipelines(id) ON DELETE SET NULL;
UPDATE deals SET pipeline_id = (SELECT id FROM pipelines WHERE is_default LIMIT 1) WHERE pipeline_id IS NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS value_auto BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT DEFAULT '',
  description TEXT DEFAULT '',
  unit        TEXT NOT NULL DEFAULT 'each',     -- record | message | email | piece | month | each | percent | 1,000
  billing     TEXT NOT NULL DEFAULT 'one-time', -- one-time | monthly
  price       NUMERIC(14,4) NOT NULL DEFAULT 0, -- base/flat price (used when no tiers)
  tiers       JSONB NOT NULL DEFAULT '[]',      -- [{min, price}] sorted ascending by min
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deal_items (
  id          SERIAL PRIMARY KEY,
  deal_id     INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  unit        TEXT NOT NULL DEFAULT 'each',
  billing     TEXT NOT NULL DEFAULT 'one-time',
  qty         NUMERIC(14,2) NOT NULL DEFAULT 1,
  unit_price  NUMERIC(14,4) NOT NULL DEFAULT 0,
  months      INTEGER NOT NULL DEFAULT 1,       -- term for monthly lines
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0, -- qty * unit_price * (months if monthly)
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS deal_items_deal_idx ON deal_items(deal_id, sort);

CREATE TABLE IF NOT EXISTS quotes (
  id          SERIAL PRIMARY KEY,
  deal_id     INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  number      TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  intro       TEXT DEFAULT '',
  terms       TEXT DEFAULT '',
  items       JSONB NOT NULL DEFAULT '[]',
  one_time    NUMERIC(14,2) NOT NULL DEFAULT 0,
  monthly     NUMERIC(14,2) NOT NULL DEFAULT 0,
  total       NUMERIC(14,2) NOT NULL DEFAULT 0,
  valid_until DATE,
  pdf         BYTEA,
  status      TEXT NOT NULL DEFAULT 'draft',   -- draft | sent | accepted
  sent_to     TEXT,
  sent_at     TIMESTAMPTZ,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quotes_deal_idx ON quotes(deal_id, created_at DESC);

-- ===== Round 3: forms & tracking, workflows, meetings =====
ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_url TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_sync BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS visitor_id TEXT;
CREATE INDEX IF NOT EXISTS contacts_visitor_idx ON contacts(visitor_id);

CREATE TABLE IF NOT EXISTS forms (
  id            SERIAL PRIMARY KEY,
  key           TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  title         TEXT DEFAULT '',
  intro         TEXT DEFAULT '',
  button        TEXT DEFAULT 'Submit',
  thanks        TEXT DEFAULT 'Thanks — we''ll be in touch shortly.',
  redirect_url  TEXT DEFAULT '',
  fields        JSONB NOT NULL DEFAULT '[]',   -- [{key,label,type,required,options}]
  create_deal   BOOLEAN NOT NULL DEFAULT TRUE,
  pipeline_id   INTEGER REFERENCES pipelines(id) ON DELETE SET NULL,
  stage         TEXT DEFAULT '',
  owner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source        TEXT DEFAULT 'Website',
  vertical      TEXT DEFAULT '',
  notify        BOOLEAN NOT NULL DEFAULT TRUE,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  submissions   INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS form_submissions (
  id          SERIAL PRIMARY KEY,
  form_id     INTEGER REFERENCES forms(id) ON DELETE CASCADE,
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id     INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  page_url    TEXT DEFAULT '',
  ip          TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visits (
  id          BIGSERIAL PRIMARY KEY,
  visitor_id  TEXT NOT NULL,
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  url         TEXT NOT NULL,
  title       TEXT DEFAULT '',
  referrer    TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visits_visitor_idx ON visits(visitor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS visits_contact_idx ON visits(contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflows (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  trigger     TEXT NOT NULL,                 -- deal_created | deal_stage | deal_won | deal_lost | contact_created | form_submitted | no_activity
  conditions  JSONB NOT NULL DEFAULT '{}',   -- {pipelineId, stage, vertical, source, formId, days, ownerId}
  actions     JSONB NOT NULL DEFAULT '[]',   -- [{type, ...}]
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  runs        INTEGER NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id           SERIAL PRIMARY KEY,
  workflow_id  INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  deal_id      INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  contact_id   INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  summary      TEXT DEFAULT '',
  ran_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_runs_idx ON workflow_runs(workflow_id, deal_id, contact_id, ran_at DESC);

CREATE TABLE IF NOT EXISTS meetings (
  id          SERIAL PRIMARY KEY,
  event_id    TEXT UNIQUE NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id     INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  title       TEXT DEFAULT '',
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ,
  link        TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | held | cancelled
  logged_held BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meetings_contact_idx ON meetings(contact_id, starts_at DESC);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin TEXT DEFAULT '';

-- ===== Round 4: dashboards, forecasting =====
CREATE TABLE IF NOT EXISTS dashboards (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  widgets       JSONB NOT NULL DEFAULT '[]',   -- [{type, size: 1|2|3, title?, options?}]
  range         TEXT NOT NULL DEFAULT '30d',
  email_weekly  BOOLEAN NOT NULL DEFAULT FALSE,
  email_to      JSONB NOT NULL DEFAULT '[]',   -- user ids
  sort          INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO dashboards (name, widgets, range, sort)
SELECT 'Sales overview', '[{"type":"kpis","size":3},{"type":"forecast_by_month","size":2},{"type":"pipeline_by_stage","size":1},{"type":"deals_over_time","size":2},{"type":"pipeline_by_owner","size":1},{"type":"won_by_owner","size":1},{"type":"source_roi","size":1},{"type":"deals_by_vertical","size":1},{"type":"activity_leaderboard","size":1},{"type":"email_performance","size":1},{"type":"funnel","size":1}]', '30d', 0
WHERE NOT EXISTS (SELECT 1 FROM dashboards);

CREATE TABLE IF NOT EXISTS quotas (
  id       SERIAL PRIMARY KEY,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period   TEXT NOT NULL,          -- YYYY-MM
  amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  UNIQUE (user_id, period)
);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS forecast_category TEXT; -- NULL = derived from probability; pipeline | best | commit | omit

-- ===== API keys for inbound integrations (Zapier, Seamless, scripts) =====
CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT UNIQUE NOT NULL,
  prefix       TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  uses         INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
