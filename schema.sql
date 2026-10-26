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
