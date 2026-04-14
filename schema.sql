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

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, city);
CREATE INDEX IF NOT EXISTS idx_listings_neighborhood ON listings(neighborhood, status);
CREATE INDEX IF NOT EXISTS idx_user_scores_user ON user_scores(user_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_listing ON price_history(listing_id, recorded_at);
