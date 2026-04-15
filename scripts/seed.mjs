// Seed D1 with active listings from the existing SF house scanner

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const SOURCE = "/Users/nikhilghosh/Projects/009-sf-house-scanner/listings.json";

const data = JSON.parse(readFileSync(SOURCE, "utf-8"));
const active = data.listings.filter((l) => l.status === "active");

console.log(`Seeding ${active.length} active listings...`);

const sql = active
  .map((l) => {
    const id = randomUUID();
    const features = JSON.stringify(l.features || []).replace(/'/g, "''");
    const redFlags = JSON.stringify(l.red_flags || []).replace(/'/g, "''");
    const rawData = JSON.stringify({}).replace(/'/g, "''");
    const address = (l.address || "").replace(/'/g, "''");
    const neighborhood = (l.neighborhood || "").replace(/'/g, "''");
    const url = (l.url || "").replace(/'/g, "''");
    const propertyType = (l.property_type || "condo").replace(/'/g, "''");
    const parking = l.parking === true ? 1 : l.parking === false ? 0 : "NULL";
    const lotSqft = l.lot_sqft || "NULL";
    const sqft = l.sqft || "NULL";
    const listingDate = l.listing_date ? `'${l.listing_date}'` : "NULL";

    return `INSERT OR REPLACE INTO listings (id, city, address, price, bedrooms, bathrooms, sqft, lot_sqft, neighborhood, property_type, url, listing_date, status, features, red_flags, parking, raw_data, first_seen, last_checked)
VALUES ('${id}', 'san_francisco', '${address}', ${l.price}, ${l.bedrooms}, ${l.bathrooms}, ${sqft}, ${lotSqft}, '${neighborhood}', '${propertyType}', '${url}', ${listingDate}, 'active', '${features}', '${redFlags}', ${parking}, '${rawData}', datetime('now'), datetime('now'));`;
  })
  .join("\n");

import { writeFileSync } from "node:fs";
writeFileSync("/tmp/seed-listings.sql", sql);

console.log("Writing to D1 (remote)...");
execSync(`npx wrangler d1 execute homescout --remote --file=/tmp/seed-listings.sql`, {
  cwd: "/Users/nikhilghosh/homescout",
  stdio: "inherit",
});

console.log("Done!");
