-- Office packages — schema. Idempotent: safe to run on every deploy.

CREATE TABLE IF NOT EXISTS person (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT,
  pin_hash     TEXT,                       -- NULL = cannot sign in
  is_admin     BOOLEAN NOT NULL DEFAULT FALSE,
  can_collect  BOOLEAN NOT NULL DEFAULT FALSE, -- appears in "who left with it"
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  failed_pins  INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS person_name_uq ON person (lower(name));

CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY,
  person_id  INT NOT NULL REFERENCES person(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Machine access (the scheduled email scan). Token shown once; only its hash is kept.
CREATE TABLE IF NOT EXISTS service_token (
  id         SERIAL PRIMARY KEY,
  label      TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used  TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS package (
  id              SERIAL PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'expected'
                  CHECK (status IN ('expected','arrived','collected','missing','cancelled')),
  description     TEXT NOT NULL,
  vendor          TEXT,
  carrier         TEXT,
  tracking        TEXT,
  order_number    TEXT,
  recipient_id    INT REFERENCES person(id),
  label_name      TEXT,                  -- name printed on the label, as the email gave it
  expected_date   DATE,
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','email','walk-in')),
  source_ref      TEXT UNIQUE,           -- email import key: tracking or vendor:order:shipment
  email_link      TEXT,
  carrier_status  TEXT,                  -- last thing the carrier/vendor email said
  carrier_delivered_at TIMESTAMPTZ,      -- carrier claims delivered: THE loss signal
  notes           TEXT,
  created_by      INT REFERENCES person(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  arrived_at      TIMESTAMPTZ,
  arrived_by      INT REFERENCES person(id),
  location        TEXT,
  collected_at    TIMESTAMPTZ,
  collected_by    INT REFERENCES person(id),  -- who LEFT the office with it
  released_by     INT REFERENCES person(id),  -- who recorded the hand-out
  arrival_alert_sent_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS package_status_idx ON package (status);
CREATE INDEX IF NOT EXISTS package_tracking_idx ON package (lower(tracking));
CREATE INDEX IF NOT EXISTS package_order_idx ON package (order_number);

CREATE TABLE IF NOT EXISTS photo (
  id          SERIAL PRIMARY KEY,
  package_id  INT NOT NULL REFERENCES package(id),
  kind        TEXT NOT NULL CHECK (kind IN ('arrival','label','moved','collected')),
  storage_key TEXT NOT NULL,
  bytes       INT,
  taken_by    INT REFERENCES person(id),
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS photo_pkg_idx ON photo (package_id);

-- Append-only history. Nothing is ever deleted from a package's story.
CREATE TABLE IF NOT EXISTS package_event (
  id         SERIAL PRIMARY KEY,
  package_id INT NOT NULL REFERENCES package(id),
  actor_id   INT REFERENCES person(id),
  actor_note TEXT,                 -- e.g. 'email scan'
  action     TEXT NOT NULL,
  detail     JSONB,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_pkg_idx ON package_event (package_id, at);

CREATE TABLE IF NOT EXISTS app_setting (
  key   TEXT PRIMARY KEY,
  value TEXT
);
