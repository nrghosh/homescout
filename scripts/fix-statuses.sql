-- Update listings to reflect actually-verified statuses (April 14, 2026)

-- PENDING
UPDATE listings SET status = 'pending', last_checked = datetime('now') WHERE address LIKE '4431 19th St%';
UPDATE listings SET status = 'pending', last_checked = datetime('now') WHERE address LIKE '505 Grand View Ave%';
UPDATE listings SET status = 'pending', last_checked = datetime('now') WHERE address LIKE '49 Nordhoff St%';

-- OFF MARKET / SOLD
UPDATE listings SET status = 'sold', last_checked = datetime('now') WHERE address LIKE '618 Sanchez St%';
UPDATE listings SET status = 'sold', last_checked = datetime('now') WHERE address LIKE '200 Dolores St%';
UPDATE listings SET status = 'sold', last_checked = datetime('now') WHERE address LIKE '305 Castro St #1%';
UPDATE listings SET status = 'withdrawn', last_checked = datetime('now') WHERE address LIKE '642 Clayton St%';

-- UNKNOWN (conflicting signals)
UPDATE listings SET status = 'unknown', last_checked = datetime('now') WHERE address LIKE '4367 21st St%';

-- Confirmed ACTIVE — refresh last_checked
UPDATE listings SET last_checked = datetime('now')
WHERE status = 'active'
AND (
  address LIKE '510 Jersey%'
  OR address LIKE '280-282 Roosevelt%'
  OR address LIKE '1601 Diamond%'
  OR address LIKE '1815 18th%'
  OR address LIKE '72 Castro%'
  OR address LIKE '12 Beaver%'
  OR address LIKE '117 Divisadero%'
  OR address LIKE '162 Noe%'
  OR address LIKE '287 Chenery%'
  OR address LIKE '214 Castro%'
  OR address LIKE '160 Noe%'
  OR address LIKE '885 Duncan%'
);

-- Clear preview cache so old cached responses get invalidated
DELETE FROM preview_cache;
