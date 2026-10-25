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

CREATE TABLE IF NOT EXISTS activities (
  id          SERIAL PRIMARY KEY,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type        TEXT NOT NULL DEFAULT 'Note',
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contacts_stage_idx   ON contacts(stage);
CREATE INDEX IF NOT EXISTS contacts_company_idx ON contacts(company_id);
CREATE INDEX IF NOT EXISTS contacts_owner_idx   ON contacts(owner_id);
CREATE INDEX IF NOT EXISTS activities_contact_idx ON activities(contact_id);
