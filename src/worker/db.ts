// Database helpers for D1

export async function getUser(db: D1Database, email: string) {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
}

export async function createUser(db: D1Database, email: string, city: string, preferences: any) {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO users (id, email, city, preferences) VALUES (?, ?, ?, ?)")
    .bind(id, email, city, JSON.stringify(preferences))
    .run();
  return { id };
}

export async function updateUser(db: D1Database, id: string, preferences: any) {
  await db
    .prepare("UPDATE users SET preferences = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(JSON.stringify(preferences), id)
    .run();
}

export async function getUsersForCity(db: D1Database, city: string) {
  return db.prepare("SELECT * FROM users WHERE city = ? AND active = 1").bind(city).all();
}

export async function getActiveListings(db: D1Database, city: string) {
  return db
    .prepare("SELECT * FROM listings WHERE city = ? AND status = 'active' ORDER BY price ASC")
    .bind(city)
    .all();
}

export async function upsertListing(db: D1Database, listing: any): Promise<boolean> {
  const existing = await db
    .prepare("SELECT id, price FROM listings WHERE address = ? AND city = ?")
    .bind(listing.address, listing.city || "san_francisco")
    .first();

  if (existing) {
    // Check for price change
    if (existing.price !== listing.price && listing.price) {
      await db
        .prepare("INSERT INTO price_history (listing_id, price) VALUES (?, ?)")
        .bind(existing.id, existing.price)
        .run();
    }

    await db
      .prepare(
        `UPDATE listings SET
          price = COALESCE(?, price),
          status = COALESCE(?, status),
          last_checked = datetime('now'),
          raw_data = COALESCE(?, raw_data)
        WHERE id = ?`
      )
      .bind(listing.price, listing.status, JSON.stringify(listing.raw_data || {}), existing.id)
      .run();

    return false; // Not new
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO listings (id, city, address, price, bedrooms, bathrooms, sqft, lot_sqft,
        neighborhood, property_type, url, listing_date, status, features, red_flags, parking, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    )
    .bind(
      id,
      listing.city || "san_francisco",
      listing.address,
      listing.price,
      listing.bedrooms,
      listing.bathrooms,
      listing.sqft,
      listing.lot_sqft || null,
      listing.neighborhood,
      listing.property_type,
      listing.url,
      listing.listing_date || null,
      JSON.stringify(listing.features || []),
      JSON.stringify(listing.red_flags || []),
      listing.parking != null ? (listing.parking ? 1 : 0) : null,
      JSON.stringify(listing.raw_data || {})
    )
    .run();

  return true; // New listing
}

export async function markListingStatus(db: D1Database, id: string, status: string) {
  await db
    .prepare("UPDATE listings SET status = ?, last_checked = datetime('now') WHERE id = ?")
    .bind(status, id)
    .run();
}

export async function getTopScoresForUser(db: D1Database, userId: string, limit: number) {
  return db
    .prepare(
      `SELECT us.score, us.breakdown, us.explanation, l.*
       FROM user_scores us
       JOIN listings l ON us.listing_id = l.id
       WHERE us.user_id = ? AND l.status = 'active'
       ORDER BY us.score DESC
       LIMIT ?`
    )
    .bind(userId, limit)
    .all();
}

export async function logScan(
  db: D1Database,
  city: string,
  newCount: number,
  removedCount: number,
  priceChanges: number
) {
  await db
    .prepare(
      "INSERT INTO scan_log (city, scan_date, new_listings, removed_listings, price_changes) VALUES (?, date('now'), ?, ?, ?)"
    )
    .bind(city, newCount, removedCount, priceChanges)
    .run();
}
