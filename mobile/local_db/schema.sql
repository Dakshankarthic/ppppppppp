CREATE TABLE IF NOT EXISTS fines (
  id INTEGER PRIMARY KEY,
  offence_code TEXT NOT NULL,
  vehicle_class TEXT NOT NULL,
  state TEXT NOT NULL,
  amount_inr INTEGER NOT NULL,
  repeat_amount_inr INTEGER,
  section_ref TEXT,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  version_hash TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL DEFAULT 'IN',
  currency TEXT NOT NULL DEFAULT 'INR'
);

CREATE TABLE IF NOT EXISTS rules (
  rule_id TEXT PRIMARY KEY,
  section TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ALL',
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zones (
  zone_id TEXT PRIMARY KEY,
  zone_type TEXT NOT NULL,
  state TEXT NOT NULL,
  rule_set_id TEXT,
  geometry_json TEXT NOT NULL,
  fine_multiplier REAL DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at TEXT NOT NULL,
  module TEXT NOT NULL,
  rows_updated INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT
);
