CREATE TABLE IF NOT EXISTS workshops (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registrations (
  id          SERIAL PRIMARY KEY,
  workshop_id INTEGER NOT NULL REFERENCES workshops(id),
  member_id   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workshop_id, member_id)          -- a member can register only once per workshop
);

-- The "outbox": a to-do list of messages that must be sent.
-- A row is created in the SAME transaction as the registration / cancellation, so either both
-- exist or neither does. A background worker then delivers them. Even if the server crashes,
-- the rows are still in the database and delivery continues after restart.
CREATE TABLE IF NOT EXISTS notifications (
  id              BIGSERIAL PRIMARY KEY,
  workshop_id     INTEGER NOT NULL REFERENCES workshops(id),
  member_id       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('confirmation', 'cancellation')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  UNIQUE (workshop_id, member_id, kind)    -- never two rows for the same message
);
CREATE INDEX IF NOT EXISTS notifications_due_idx ON notifications (status, next_attempt_at);
