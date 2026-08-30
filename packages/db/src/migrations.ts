/**
 * Forward-only migrations, applied in order inside a transaction. `user_version`
 * records what has been applied. Migrations are append-only: once a version has
 * shipped it is never edited, because a device somewhere has already run it.
 *
 * Schema mirrors docs/data-model.md. Where the two disagree, fix both in one
 * commit.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const initial = `
-- Provenance: one row per act of capture. capture_id is minted on the device
-- that made it and is the identity Merge matches on across devices, forever.
CREATE TABLE captures (
  capture_id     TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('photo','statement','voice','manual')),
  captured_at    INTEGER NOT NULL,
  document_path  TEXT,
  document_hash  TEXT,
  document_bytes INTEGER CHECK (document_bytes IS NULL OR document_bytes >= 0),
  rev            INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  origin_device  TEXT NOT NULL
);

CREATE TABLE merchants (
  id             TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  rev            INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  origin_device  TEXT NOT NULL
);

-- 'SQ *BLUE BOTTLE', 'BLUE BOTTLE COFFEE', and 'BLUEBOTTLE.COM' are one merchant.
CREATE TABLE merchant_aliases (
  alias         TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  rev           INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  origin_device TEXT NOT NULL
);

CREATE INDEX merchant_aliases_merchant ON merchant_aliases(merchant_id);

CREATE TABLE categories (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  parent_id     TEXT REFERENCES categories(id),
  rev           INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  origin_device TEXT NOT NULL
);

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  currency      TEXT NOT NULL,
  rev           INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  origin_device TEXT NOT NULL
);

CREATE TABLE transactions (
  id                   TEXT PRIMARY KEY,
  capture_id           TEXT REFERENCES captures(capture_id),
  account_id           TEXT REFERENCES accounts(id),
  merchant_id          TEXT REFERENCES merchants(id),
  category_id          TEXT REFERENCES categories(id),
  amount_minor         INTEGER NOT NULL,
  currency             TEXT NOT NULL,
  occurred_at          INTEGER NOT NULL,
  posted_at            INTEGER,
  note                 TEXT,
  source               TEXT NOT NULL CHECK (source IN ('photo','statement','voice','manual')),
  -- Null until the user confirms. Unconfirmed rows stay out of every total.
  confirmed_at         INTEGER,
  fx_original_minor    INTEGER,
  fx_original_currency TEXT,
  fx_rate              REAL CHECK (fx_rate IS NULL OR fx_rate > 0),
  reconciled           INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0,1)),
  rev                  INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER,
  origin_device        TEXT NOT NULL,
  -- An original amount without its currency and rate cannot be re-derived later.
  CHECK ((fx_original_minor IS NULL) = (fx_original_currency IS NULL)),
  CHECK ((fx_original_minor IS NULL) = (fx_rate IS NULL))
);

-- Partial indexes keep tombstones out of the hot paths. occurred_at DESC is the
-- workhorse: it serves the screen users actually live on.
CREATE INDEX tx_occurred    ON transactions(occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tx_category    ON transactions(category_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tx_merchant    ON transactions(merchant_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tx_account     ON transactions(account_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX tx_capture     ON transactions(capture_id);
CREATE INDEX tx_unconfirmed ON transactions(occurred_at DESC)
  WHERE confirmed_at IS NULL AND deleted_at IS NULL;

CREATE TABLE line_items (
  id               TEXT PRIMARY KEY,
  transaction_id   TEXT NOT NULL REFERENCES transactions(id),
  kind             TEXT NOT NULL CHECK (kind IN ('item','tax','fee','discount','tip')),
  name             TEXT NOT NULL,
  quantity         INTEGER CHECK (quantity IS NULL OR quantity > 0),
  unit_price_minor INTEGER,
  total_minor      INTEGER NOT NULL,
  position         INTEGER NOT NULL,
  rev              INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  origin_device    TEXT NOT NULL
);

CREATE INDEX line_items_transaction ON line_items(transaction_id, position)
  WHERE deleted_at IS NULL;

CREATE TABLE extractions (
  id          TEXT PRIMARY KEY,
  capture_id  TEXT NOT NULL REFERENCES captures(capture_id),
  tier        INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
  engine      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
  candidate   TEXT NOT NULL,
  confidence  TEXT NOT NULL,
  ran_at      INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);

CREATE INDEX extractions_capture ON extractions(capture_id, ran_at DESC);

-- Append-only. A revision that loses a merge is kept here, never dropped: it is
-- the user's money data, and an overwrite they did not expect must be
-- recoverable.
CREATE TABLE tombstones (
  id            TEXT PRIMARY KEY,
  table_name    TEXT NOT NULL,
  row_id        TEXT NOT NULL,
  rev           INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  superseded_at INTEGER NOT NULL
);

CREATE INDEX tombstones_row ON tombstones(table_name, row_id, superseded_at DESC);

-- Per-device by design; never merged.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const search = `
-- Full-text search over merchant name and note. SQLite's FTS5 replaces the
-- Postgres trigram index the server design used. External-content table kept in
-- sync by triggers, so the transactions table stays the single source of truth.
CREATE VIRTUAL TABLE transactions_fts USING fts5(
  note,
  merchant_name,
  content = '',
  tokenize = 'unicode61'
);

CREATE TRIGGER transactions_fts_insert AFTER INSERT ON transactions BEGIN
  INSERT INTO transactions_fts(rowid, note, merchant_name)
  VALUES (
    new.rowid,
    COALESCE(new.note, ''),
    COALESCE((SELECT canonical_name FROM merchants WHERE id = new.merchant_id), '')
  );
END;

CREATE TRIGGER transactions_fts_delete AFTER DELETE ON transactions BEGIN
  INSERT INTO transactions_fts(transactions_fts, rowid, note, merchant_name)
  VALUES ('delete', old.rowid, COALESCE(old.note, ''), '');
END;

CREATE TRIGGER transactions_fts_update AFTER UPDATE ON transactions BEGIN
  INSERT INTO transactions_fts(transactions_fts, rowid, note, merchant_name)
  VALUES ('delete', old.rowid, COALESCE(old.note, ''), '');
  INSERT INTO transactions_fts(rowid, note, merchant_name)
  VALUES (
    new.rowid,
    COALESCE(new.note, ''),
    COALESCE((SELECT canonical_name FROM merchants WHERE id = new.merchant_id), '')
  );
END;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: initial },
  { version: 2, name: 'search', sql: search },
];
