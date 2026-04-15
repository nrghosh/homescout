// Seed D1 with ONLY verified-active listings (last_checked within 3 days)

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const SOURCE = "/Users/nikhilghosh/Projects/009-sf-house-scanner/listings.json";
const STALENESS_CUTOFF = "2026-04-11"; // within 3 days of scanner's last run (4/14)

const data = JSON.parse(readFileSync(SOURCE, "utf-8"));

// Filter: active + verified recently + deduplicate by address
const seen = new Set();
const active = data.listings
  .filter((l) => l.status === "active")
  .filter((l) => (l.last_checked || "") >= STALENESS_CUTOFF)
  .filter((l) => {
    const key = l.address.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

console.log(`Source: ${data.listings.length} total listings`);
console.log(`Filtered: ${active.length} active + verified within 3 days + deduplicated`);

// Clear existing + replace with fresh data
const statements = [
  "DELETE FROM user_scores;",
  "DELETE FROM explanation_cache;",
  "DELETE FROM preview_cache;",
  "DELETE FROM price_history;",
  "DELETE FROM listings;",
];

for (const l of active) {
  const id = randomUUID();
  const features = JSON.stringify(l.features || []).replace(/'/g, "''");
  const redFlags = JSON.stringify(l.red_flags || []).replace(/'/g, "''");
  const rawData = "{}";
  const address = (l.address || "").replace(/'/g, "''");
  const neighborhood = (l.neighborhood || "").replace(/'/g, "''");
  const url = (l.url || "").replace(/'/g, "''");
  const propertyType = (l.property_type || "condo").replace(/'/g, "''");
  const parking = l.parking === true ? 1 : l.parking === false ? 0 : "NULL";
  const lotSqft = l.lot_sqft || "NULL";
  const sqft = l.sqft || "NULL";
  const listingDate = l.listing_date ? `'${l.listing_date}'` : "NULL";
  const lastChecked = l.last_checked ? `'${l.last_checked}'` : "datetime('now')";

  statements.push(
    `INSERT INTO listings (id, city, address, price, bedrooms, bathrooms, sqft, lot_sqft, neighborhood, property_type, url, listing_date, status, features, red_flags, parking, raw_data, first_seen, last_checked) VALUES ('${id}', 'san_francisco', '${address}', ${l.price}, ${l.bedrooms}, ${l.bathrooms}, ${sqft}, ${lotSqft}, '${neighborhood}', '${propertyType}', '${url}', ${listingDate}, 'active', '${features}', '${redFlags}', ${parking}, '${rawData}', datetime('now'), ${lastChecked});`
  );
}

writeFileSync("/tmp/seed-listings.sql", statements.join("\n"));
console.log(`Writing ${active.length} listings to D1 (remote)...`);
execSync(`npx wrangler d1 execute homescout --remote --file=/tmp/seed-listings.sql`, {
  cwd: "/Users/nikhilghosh/homescout",
  stdio: "inherit",
});
console.log("Done!");
