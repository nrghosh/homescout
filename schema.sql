-- HomeScout D1 Schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email TEXT UNIQUE NOT NULL,
  city TEXT NOT NULL DEFAULT 'san_francisco',
  preferences TEXT NOT NULL DEFAULT '{}',  -- JSON: {neighborhoods: [...], price_min, price_max, beds_min, baths_min, sqft_min, priorities: {neighborhood: "must_have", price: "important", ...}}
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  city TEXT NOT NULL DEFAULT 'san_francisco',
  address TEXT NOT NULL,
  price INTEGER,
  bedrooms REAL,
  bathrooms REAL,
  sqft INTEGER,
  lot_sqft INTEGER,
  neighborhood TEXT,
  property_type TEXT,  -- sfh, condo, tic, duplex
  url TEXT,
  listing_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active, pending, sold, withdrawn, unknown
  features TEXT DEFAULT '[]',  -- JSON array
  red_flags TEXT DEFAULT '[]',  -- JSON array
  parking INTEGER,  -- 1 = yes, 0 = no, NULL = unknown
  raw_data TEXT DEFAULT '{}',  -- JSON blob of everything scraped
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(address, city)
);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  price INTEGER NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  score INTEGER NOT NULL,
  breakdown TEXT DEFAULT '{}',  -- JSON: {neighborhood: 20, price: 15, ...}
  explanation TEXT,  -- NL explanation from LLM
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS scan_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL,
  scan_date TEXT NOT NULL,
  new_listings INTEGER DEFAULT 0,
  removed_listings INTEGER DEFAULT 0,
  price_changes INTEGER DEFAULT 0,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS explanation_cache (
  listing_id TEXT NOT NULL,
  priority_hash TEXT NOT NULL,
  explanation TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (listing_id, priority_hash)
);

CREATE TABLE IF NOT EXISTS preview_cache (
  pref_hash TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Track which source provided each field + when (for conflict resolution + transparency)
CREATE TABLE IF NOT EXISTS source_attribution (
  listing_id TEXT NOT NULL,
  field TEXT NOT NULL,
  source TEXT NOT NULL,
  value TEXT,
  confidence TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (listing_id, field)
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, city);
CREATE INDEX IF NOT EXISTS idx_listings_neighborhood ON listings(neighborhood, status);
CREATE INDEX IF NOT EXISTS idx_user_scores_user ON user_scores(user_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_listing ON price_history(listing_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_explanation_cache_created ON explanation_cache(created_at);
CREATE INDEX IF NOT EXISTS idx_preview_cache_created ON preview_cache(created_at);
CREATE INDEX IF NOT EXISTS idx_source_attribution_listing ON source_attribution(listing_id);

-- Feature flags — runtime config without redeploys
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  -- "value" is the default. For bucketed/rollout, see rollout_percent + allow_users
  value TEXT NOT NULL DEFAULT 'off',  -- 'on', 'off', or arbitrary string
  rollout_percent INTEGER NOT NULL DEFAULT 0,  -- 0-100: hash(user_id) % 100 < rollout_percent => on
  allow_users TEXT,  -- JSON array of user_ids that always get 'on' (internal testing)
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed initial flags (all off except listed)
INSERT OR IGNORE INTO feature_flags (key, value, rollout_percent, description) VALUES
  ('LOG_SOURCE_SNAPSHOTS',    'on',  100, 'Append every scrape to listing_source_snapshots log'),
  ('WIZARD_STEPS_3',          'off', 0,   'P0.3: compress wizard from 4 steps to 3'),
  ('LOCK_MODE_SOFT',          'off', 0,   'P0.4: show addresses, gate explanations'),
  ('SHOW_FRESHNESS_LABELS',   'off', 0,   'P0.5: show "Verified active N min ago" on each listing'),
  ('EMAIL_CHANGES_FIRST',     'off', 0,   'P0.6: put status changes at top of daily email'),
  ('ENRICHMENT_MODE',         'sync', 0,  'P1.1: sync, async, or hybrid'),
  ('DEFAULT_CADENCE',         'daily', 0, 'P1.2: daily, weekly, or instant'),
  ('COMPARE_VIEW',            'off', 0,   'P1.3: mobile compare 2-3 listings'),
  ('AI_CANNED_PROMPTS',       'off', 0,   'P1.4: 3 canned AI prompts per listing'),
  ('EXPLANATION_BACKEND',     'llama', 0, 'P1.5: llama | template — A/B LLM vs template');
