import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { scoreListing, scoreListingRuleBased } from "./scorer";
import { verifyListings } from "./verify";
import { enrichListing, enrichBatch } from "./enrich";
import { getFlag, isFlagOn } from "./flags";
import { scrapeNeighborhood } from "./scraper";
import { sendDailyEmail } from "./email";
import {
  getActiveListings,
  upsertListing,
  getUser,
  createUser,
  updateUser,
  getUsersForCity,
  getTopScoresForUser,
} from "./db";
import {
  validateEmail,
  validatePreferences,
  validateCity,
  checkRateLimit,
} from "./validation";

type Bindings = {
  DB: D1Database;
  AI: Ai;
  BROWSER: Fetcher;
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Security headers — CSP, HSTS, X-Frame-Options, etc.
app.use(
  "/*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // inline styles in HTML
      scriptSrc: ["'self'", "'unsafe-inline'"], // inline script for form handler
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      frameAncestors: ["'none'"],
    },
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    referrerPolicy: "strict-origin-when-cross-origin",
  })
);

// CORS — only allow same origin
app.use("/api/*", cors({ origin: (origin) => origin || "*", credentials: false }));

// Simple client IP extraction for rate limiting
function clientKey(c: any): string {
  return c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "anon";
}

// --- Preview endpoint (no email required) ---
// Returns a teaser: matches #4-6 visible with explanations, #1-3 locked
app.post("/api/preview", async (c) => {
  const ip = clientKey(c);
  if (!checkRateLimit(`preview:${ip}`, 20, 60_000)) {
    return c.json({ error: "Too many requests. Please wait a moment." }, 429);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const prefsCheck = validatePreferences(body.preferences);
  if (!prefsCheck.ok) return c.json({ error: prefsCheck.error }, 400);

  const city = body.city || "san_francisco";
  const cityCheck = validateCity(city);
  if (!cityCheck.ok) return c.json({ error: cityCheck.error }, 400);

  // Check preview cache (by preference hash) — 1 hour TTL
  const prefHash = await hashPreferences(prefsCheck.value, city);
  const cached = await c.env.DB.prepare(
    `SELECT response FROM preview_cache
     WHERE pref_hash = ? AND created_at > datetime('now', '-1 hour')`
  )
    .bind(prefHash)
    .first();

  if (cached?.response) {
    return c.json({ ...JSON.parse(cached.response as string), cached: true });
  }

  // Fast path: rule-based score for ALL listings (no LLM)
  const listings = await getActiveListings(c.env.DB, city);
  const ruleScored = listings.results
    .map((listing) => {
      const { score, breakdown } = scoreListingRuleBased(listing, prefsCheck.value);
      return { ...listing, score, breakdown };
    })
    .filter((l) => l.score > 0)
    .sort((a: any, b: any) => b.score - a.score);

  // Verify the top 10 candidates by fetching their URLs (catches stale data)
  const topCandidates = ruleScored.slice(0, 10);
  const verifyTargets = topCandidates
    .filter((l: any) => l.url && shouldReVerify(l.last_checked))
    .map((l: any) => ({ id: l.id, url: l.url }));

  if (verifyTargets.length > 0) {
    const results = await verifyListings(verifyTargets, 5);
    for (const [id, result] of results) {
      // If verified non-active, update DB and remove from candidates
      if (result.status !== "active" && result.confidence === "high") {
        await c.env.DB.prepare(
          "UPDATE listings SET status = ?, last_checked = datetime('now') WHERE id = ?"
        )
          .bind(result.status, id)
          .run();
      } else if (result.status === "active") {
        await c.env.DB.prepare(
          "UPDATE listings SET last_checked = datetime('now') WHERE id = ?"
        )
          .bind(id)
          .run();
      }
    }

    // Filter out any that were just marked non-active
    const stillActive = new Set(
      Array.from(results.entries())
        .filter(([_, r]) => r.status === "active" || r.confidence !== "high")
        .map(([id]) => id)
    );
    const verifiedIds = new Set(verifyTargets.map((t) => t.id));

    // Keep listings that weren't verified, OR were verified as still active
    const filtered = ruleScored.filter((l: any) =>
      !verifiedIds.has(l.id) || stillActive.has(l.id)
    );
    ruleScored.length = 0;
    ruleScored.push(...filtered);
  }

  // Only generate LLM explanations for visible matches (4-6) — 3 LLM calls per preview max
  const visibleCandidates = ruleScored.slice(3, 6);
  const visible = await Promise.all(
    visibleCandidates.map(async (l: any) => {
      const { explanation } = await scoreListing(c.env.AI, l, prefsCheck.value, {
        db: c.env.DB,
      });
      return {
        score: l.score,
        address: l.address,
        price: l.price,
        bedrooms: l.bedrooms,
        bathrooms: l.bathrooms,
        sqft: l.sqft,
        neighborhood: l.neighborhood,
        property_type: l.property_type,
        url: l.url,
        explanation,
        last_checked: l.last_checked,
        locked: false,
      };
    })
  );

  // Locked top 3 — no LLM, no addresses
  const locked = ruleScored.slice(0, 3).map((l: any) => ({
    score: l.score,
    neighborhood: l.neighborhood,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    property_type: l.property_type,
    price_range: l.price ? priceRange(l.price) : null,
    locked: true,
  }));

  const response = {
    total_matches: ruleScored.length,
    locked,
    visible,
    city,
  };

  // Cache for 1 hour
  await c.env.DB.prepare(
    `INSERT INTO preview_cache (pref_hash, response, created_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(pref_hash) DO UPDATE SET
       response = excluded.response,
       created_at = excluded.created_at`
  )
    .bind(prefHash, JSON.stringify(response))
    .run();

  return c.json(response);
});

// --- Create or update user ---
app.post("/api/users", async (c) => {
  const ip = clientKey(c);
  if (!checkRateLimit(`signup:${ip}`, 5, 60_000)) {
    return c.json({ error: "Too many signup attempts. Please wait a moment." }, 429);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const emailCheck = validateEmail(body.email);
  if (!emailCheck.ok) return c.json({ error: emailCheck.error }, 400);

  const prefsCheck = validatePreferences(body.preferences);
  if (!prefsCheck.ok) return c.json({ error: prefsCheck.error }, 400);

  const cityCheck = validateCity(body.city || "san_francisco");
  if (!cityCheck.ok) return c.json({ error: cityCheck.error }, 400);

  const existing = await getUser(c.env.DB, emailCheck.value);
  if (existing) {
    await updateUser(c.env.DB, existing.id as string, prefsCheck.value);
    return c.json({ id: existing.id, updated: true });
  }

  const user = await createUser(c.env.DB, emailCheck.value, cityCheck.value, prefsCheck.value);
  return c.json({ id: user.id, created: true });
});

// --- Dashboard data ---
app.get("/api/dashboard/:userId", async (c) => {
  const userId = c.req.param("userId");
  // Sanitize userId (UUID format only)
  if (!/^[a-f0-9-]{36}$/.test(userId)) {
    return c.json({ error: "Invalid user ID" }, 400);
  }

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) return c.json({ error: "user not found" }, 404);

  const scores = await getTopScoresForUser(c.env.DB, userId, 20);
  const recentScans = await c.env.DB.prepare(
    "SELECT * FROM scan_log WHERE city = ? ORDER BY scan_date DESC LIMIT 7"
  )
    .bind(user.city as string)
    .all();

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      preferences: JSON.parse(user.preferences as string),
    },
    listings: scores.results,
    scans: recentScans.results,
  });
});

// Feature flag read (public — any user can see current flag state for their ID)
app.get("/api/flags/:userId?", async (c) => {
  const userId = c.req.param("userId");
  const flags = await c.env.DB.prepare(
    "SELECT key, value, rollout_percent, description FROM feature_flags"
  ).all();

  const resolved: Record<string, string> = {};
  for (const f of flags.results as any[]) {
    resolved[f.key] = await getFlag(c.env as any, f.key, userId);
  }
  return c.json({ flags: resolved, meta: flags.results });
});

// Admin: toggle a flag (requires ADMIN_KEY header match)
app.post("/api/flags/:key", async (c) => {
  const adminKey = c.req.header("x-admin-key");
  const expected = (c.env as any).ADMIN_KEY;
  if (!expected || adminKey !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const key = c.req.param("key");
  const body = await c.req.json();
  const { value, rollout_percent, allow_users } = body;

  if (typeof value !== "string") return c.json({ error: "value required" }, 400);
  if (rollout_percent != null && (typeof rollout_percent !== "number" || rollout_percent < 0 || rollout_percent > 100)) {
    return c.json({ error: "rollout_percent must be 0-100" }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO feature_flags (key, value, rollout_percent, allow_users, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       rollout_percent = COALESCE(excluded.rollout_percent, rollout_percent),
       allow_users = COALESCE(excluded.allow_users, allow_users),
       updated_at = datetime('now')`
  )
    .bind(
      key,
      value,
      rollout_percent ?? 0,
      allow_users ? JSON.stringify(allow_users) : null
    )
    .run();

  return c.json({ ok: true, key, value, rollout_percent });
});

// Debug: snapshot history for an address (P0.2 — audit trail)
app.get("/api/debug/snapshots", async (c) => {
  const address = c.req.query("address")?.toLowerCase().trim();
  if (!address) return c.json({ error: "?address=... required" }, 400);

  const rows = await c.env.DB.prepare(
    `SELECT source, scraped_at, json_extract(raw_json, '$.price') as price,
            json_extract(raw_json, '$.status') as status,
            json_extract(raw_json, '$.bathrooms') as bathrooms
     FROM listing_source_snapshots
     WHERE address = ?
     ORDER BY scraped_at DESC
     LIMIT 50`
  )
    .bind(address)
    .all();

  return c.json({ address, count: rows.results.length, snapshots: rows.results });
});

// Debug: inspect what scraper sees for a single neighborhood
app.get("/api/debug/scrape/:neighborhood", async (c) => {
  const neighborhood = c.req.param("neighborhood").replace(/-/g, " ");
  const listings = await scrapeNeighborhood(c.env.BROWSER, "san_francisco", neighborhood);
  return c.json({ neighborhood, count: listings.length, listings: listings.slice(0, 3) });
});

app.get("/api/debug/parser/:neighborhood", async (c) => {
  const slugs: Record<string, string> = {
    "Cole-Valley": "605/CA/San-Francisco/Cole-Valley",
  };
  const slug = slugs[c.req.param("neighborhood")];
  if (!slug) return c.json({ error: "no slug" });
  const url = `https://www.redfin.com/neighborhood/${slug}/filter/property-type=house+condo+townhouse,min-beds=2,min-baths=2,min-price=1M,max-price=3M`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36" },
  } as any);
  const html = await r.text();

  const result: any = { htmlLen: html.length, strategies: [] };

  // Strategy 1
  const serverStateMatch = html.match(/<script[^>]*>__reactServerState\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  result.strategies.push({ name: "serverState_regex_match", found: !!serverStateMatch, len: serverStateMatch?.[1]?.length });

  // Strategy 2: count JSON-LD with addresses
  const jsonLdMatches = [...html.matchAll(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  let withAddress = 0;
  let parsed = 0;
  let extractedItems: any[] = [];
  for (const match of jsonLdMatches) {
    try {
      const json = JSON.parse(match[1]);
      parsed++;
      const items = Array.isArray(json) ? json : json["@graph"] || [json];
      const listingItem = items.find((it: any) => it && it.address && it.address.streetAddress);
      if (listingItem) {
        withAddress++;
        extractedItems.push({ name: listingItem.name, url: listingItem.url, hasOffers: !!listingItem.offers });
      }
    } catch (e) {
      result.strategies.push({ parse_error: String(e).slice(0, 100) });
    }
  }
  result.strategies.push({ name: "jsonld", total: jsonLdMatches.length, parsed, withAddress, items: extractedItems });

  return c.json(result);
});

app.get("/api/debug/jsonld/:neighborhood", async (c) => {
  const slugs: Record<string, string> = {
    "Cole-Valley": "605/CA/San-Francisco/Cole-Valley",
    "Noe-Valley": "1838/CA/San-Francisco/Noe-Valley",
  };
  const slug = slugs[c.req.param("neighborhood")];
  if (!slug) return c.json({ error: "no slug" });
  const url = `https://www.redfin.com/neighborhood/${slug}/filter/property-type=house+condo+townhouse,min-beds=2,min-baths=2,min-price=1M,max-price=3M`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36" },
  } as any);
  const html = await r.text();
  const matches = [...html.matchAll(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  const blocks = matches.map((m, i) => {
    try {
      const parsed = JSON.parse(m[1]);
      return { i, type: parsed["@type"] || (Array.isArray(parsed) ? "array" : "unknown"), preview: JSON.stringify(parsed).slice(0, 300) };
    } catch (e) {
      return { i, error: String(e), raw: m[1].slice(0, 200) };
    }
  });
  return c.json({ count: blocks.length, blocks });
});

app.get("/api/debug/parse/:neighborhood", async (c) => {
  const slugs: Record<string, string> = {
    "Cole-Valley": "605/CA/San-Francisco/Cole-Valley",
    "Noe-Valley": "1838/CA/San-Francisco/Noe-Valley",
  };
  const slug = slugs[c.req.param("neighborhood")];
  if (!slug) return c.json({ error: "no slug" });
  const url = `https://www.redfin.com/neighborhood/${slug}/filter/property-type=house+condo+townhouse,min-beds=2,min-baths=2,min-price=1M,max-price=3M`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36" },
  } as any);
  const html = await r.text();

  // Try different regex patterns for ServerState
  const patterns = [
    { name: "p1: window.__reactServerState=", re: /window\.__reactServerState\s*=\s*(\{[\s\S]*?\});/ },
    { name: "p2: __reactServerState =", re: /__reactServerState\s*=\s*(\{[\s\S]*?\})\s*[,;<]/ },
    { name: "p3: ServerState +/* anything", re: /__reactServerState[^=]*=\s*(\{[\s\S]+?\})\s*\n/ },
  ];
  const results: any = { url, status: r.status, htmlLen: html.length };
  for (const p of patterns) {
    const m = html.match(p.re);
    results[p.name] = m ? `matched, ${m[1].length} chars` : "no match";
  }

  // Sample the area around __reactServerState
  const idx = html.indexOf("__reactServerState");
  if (idx > -1) {
    results.serverStateContext = html.slice(idx, idx + 200);
  }

  // Count JSON-LD entries
  const jsonLdMatches = html.match(/<script\s+type="application\/ld\+json"[^>]*>/g) || [];
  results.jsonLdCount = jsonLdMatches.length;

  // Count HomeCardContainer
  const homeCardMatches = html.match(/HomeCardContainer/g) || [];
  results.homeCardCount = homeCardMatches.length;

  return c.json(results);
});

app.get("/api/debug/raw/:neighborhood", async (c) => {
  const neighborhood = c.req.param("neighborhood").replace(/-/g, " ");
  const slugs: Record<string, string> = {
    "Cole Valley": "605/CA/San-Francisco/Cole-Valley",
    "Noe Valley": "1838/CA/San-Francisco/Noe-Valley",
  };
  const slug = slugs[neighborhood];
  if (!slug) return c.json({ error: "no slug" });
  const url = `https://www.redfin.com/neighborhood/${slug}`;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36",
      },
    });
    const text = await r.text();
    return c.json({
      status: r.status,
      length: text.length,
      first500: text.slice(0, 500),
      hasReactState: /__reactServerState/.test(text),
      hasJsonLd: /application\/ld\+json/.test(text),
      hasHomeCard: /HomeCardContainer/.test(text),
    });
  } catch (err) {
    return c.json({ error: String(err) });
  }
});

// Manual enrichment trigger — fill missing price/baths from multiple sources
app.post("/api/enrich", async (c) => {
  const ip = clientKey(c);
  if (!checkRateLimit(`enrich:${ip}`, 3, 3600_000)) {
    return c.json({ error: "Enrichment is rate-limited to 3/hour" }, 429);
  }

  // Find active listings that are missing price OR bathrooms
  const incomplete = await c.env.DB.prepare(
    `SELECT id, address, url, price, bathrooms FROM listings
     WHERE city = 'san_francisco' AND status = 'active' AND url != ''
     AND (price IS NULL OR bathrooms IS NULL)
     LIMIT 20`
  ).all();

  let updated = 0;
  for (const row of incomplete.results) {
    const did = await enrichAndUpdateDB(c.env, row as any);
    if (did) updated++;
  }

  return c.json({
    examined: incomplete.results.length,
    updated,
  });
});

// Manual scan trigger (for testing, rate limited)
app.post("/api/scan", async (c) => {
  const ip = clientKey(c);
  if (!checkRateLimit(`scan:${ip}`, 1, 3600_000)) {
    return c.json({ error: "Scans are rate-limited to 1 per hour" }, 429);
  }
  const result = await runDailyScan(c.env);
  return c.json(result);
});

// Dashboard static HTML for any /dashboard/* path
app.get("/dashboard/*", async (c) => {
  return c.env.ASSETS.fetch(new Request(new URL("/dashboard.html", c.req.url)));
});

// Cron handler
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runDailyScan(env));
  },
};

// --- Helpers ---

async function enrichAndUpdateDB(
  env: Bindings,
  listing: { id: string; address: string; url?: string; price?: number | null; bathrooms?: number | null }
): Promise<boolean> {
  // Only enrich if we're missing key fields
  if (listing.price != null && listing.bathrooms != null) return false;

  const enriched = await enrichListing({
    id: listing.id,
    address: listing.address,
    url: listing.url,
    price: listing.price,
    bathrooms: listing.bathrooms,
  } as any);

  // Update listing with any new fields
  const updates: string[] = [];
  const binds: any[] = [];

  if (enriched.price != null && enriched.price !== listing.price) {
    updates.push("price = ?");
    binds.push(enriched.price);
  }
  if (enriched.bathrooms != null && enriched.bathrooms !== listing.bathrooms) {
    updates.push("bathrooms = ?");
    binds.push(enriched.bathrooms);
  }
  if (enriched.sqft != null) {
    updates.push("sqft = COALESCE(sqft, ?)");
    binds.push(enriched.sqft);
  }
  if (enriched.status) {
    updates.push("status = ?");
    binds.push(enriched.status);
  }
  if (enriched.parking != null) {
    updates.push("parking = COALESCE(parking, ?)");
    binds.push(enriched.parking ? 1 : 0);
  }

  if (updates.length > 0) {
    updates.push("last_checked = datetime('now')");
    binds.push(listing.id);
    await env.DB.prepare(
      `UPDATE listings SET ${updates.join(", ")} WHERE id = ?`
    )
      .bind(...binds)
      .run();

    // Record source attribution for each field
    for (const [field, meta] of Object.entries(enriched._sources || {})) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO source_attribution
         (listing_id, field, source, value, confidence, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          listing.id,
          field,
          meta.source,
          String((enriched as any)[field] ?? ""),
          meta.confidence,
          meta.fetched_at
        )
        .run();
    }
    return true;
  }
  return false;
}

function shouldReVerify(lastChecked: string | null | undefined): boolean {
  if (!lastChecked) return true;
  const last = new Date(lastChecked).getTime();
  const now = Date.now();
  // Re-verify if last check was more than 6 hours ago
  return now - last > 6 * 60 * 60 * 1000;
}

async function hashPreferences(prefs: any, city: string): Promise<string> {
  // Canonical, sorted representation of prefs for cache key
  const canonical = {
    city,
    n: (prefs.neighborhoods || []).slice().sort(),
    pmin: prefs.price_min || 0,
    pmax: prefs.price_max || 0,
    bd: prefs.beds_min || 0,
    ba: prefs.baths_min || 0,
    sq: prefs.sqft_min || 0,
    p: prefs.priorities || {},
  };
  const data = new TextEncoder().encode(JSON.stringify(canonical));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function priceRange(price: number): string {
  const m = price / 1_000_000;
  if (m < 1) return "under $1M";
  if (m < 1.5) return "$1-1.5M";
  if (m < 2) return "$1.5-2M";
  if (m < 2.5) return "$2-2.5M";
  if (m < 3) return "$2.5-3M";
  return "$3M+";
}

async function runDailyScan(env: Bindings) {
  const city = "san_francisco";
  const today = new Date().toISOString().slice(0, 10);
  let newCount = 0;
  let removedCount = 0;

  const allNeighborhoods = [
    "Cole Valley",
    "Noe Valley",
    "Dolores Heights",
    "Corona Heights",
    "Inner Sunset",
    "Duboce Triangle",
    "The Castro",
    "Glen Park",
    "Eureka Valley",
    "Ashbury Heights",
    "Mission Dolores",
    "Buena Vista",
  ];

  // Track addresses seen in this scrape, so we can reconcile statuses after
  const seenAddresses = new Set<string>();

  for (const hood of allNeighborhoods) {
    try {
      const listings = await scrapeNeighborhood(env.BROWSER, city, hood);
      for (const listing of listings) {
        const isNew = await upsertListing(env.DB, listing);
        if (isNew) newCount++;
        seenAddresses.add(listing.address.toLowerCase().trim());
      }
    } catch (err) {
      console.error(`Scrape failed for ${hood}:`, err);
    }
  }

  // Status reconciliation: any active listing NOT in today's scrape
  // and last_checked > 24h ago gets re-verified via URL fetch.
  // After 2 consecutive misses, mark as likely_sold.
  if (seenAddresses.size > 5) {
    // Only run reconciliation if scrape was meaningful (didn't fail silently)
    const stale = await env.DB.prepare(
      `SELECT id, address, url, raw_data FROM listings
       WHERE city = ? AND status = 'active' AND last_checked < datetime('now', '-1 day')`
    )
      .bind(city)
      .all();

    for (const row of stale.results) {
      const addr = String(row.address).toLowerCase().trim();
      if (seenAddresses.has(addr)) continue; // Still on Redfin search

      // Not seen — verify via URL
      const verifyResult = await import("./verify").then((m) =>
        m.verifyListing(String(row.url || ""))
      );

      if (verifyResult.status !== "active" && verifyResult.confidence === "high") {
        await env.DB.prepare(
          "UPDATE listings SET status = ?, last_checked = datetime('now') WHERE id = ?"
        )
          .bind(verifyResult.status, row.id)
          .run();
        removedCount++;
      } else if (verifyResult.status === "unknown") {
        // Track miss count in raw_data
        const raw = JSON.parse(String(row.raw_data || "{}"));
        const misses = (raw.scrape_misses || 0) + 1;
        raw.scrape_misses = misses;

        if (misses >= 2) {
          await env.DB.prepare(
            "UPDATE listings SET status = 'likely_sold', last_checked = datetime('now'), raw_data = ? WHERE id = ?"
          )
            .bind(JSON.stringify(raw), row.id)
            .run();
          removedCount++;
        } else {
          await env.DB.prepare(
            "UPDATE listings SET raw_data = ? WHERE id = ?"
          )
            .bind(JSON.stringify(raw), row.id)
            .run();
        }
      }
    }
  }

  // Enrichment pass — fill missing price/baths from multiple sources
  // Run on all active listings with missing data, in batches of 20
  let enrichedCount = 0;
  const incomplete = await env.DB.prepare(
    `SELECT id, address, url, price, bathrooms FROM listings
     WHERE city = ? AND status = 'active' AND url != ''
     AND (price IS NULL OR bathrooms IS NULL)
     LIMIT 30`
  )
    .bind(city)
    .all();

  for (const row of incomplete.results) {
    const did = await enrichAndUpdateDB(env, row as any);
    if (did) enrichedCount++;
  }

  // Log the scan
  await env.DB.prepare(
    "INSERT INTO scan_log (city, scan_date, new_listings, removed_listings, summary) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(
      city,
      today,
      newCount,
      removedCount,
      JSON.stringify({
        scraped_addresses: seenAddresses.size,
        enriched: enrichedCount,
      })
    )
    .run();

  const users = await getUsersForCity(env.DB, city);
  const activeListings = await getActiveListings(env.DB, city);

  for (const user of users.results) {
    const prefs = JSON.parse(user.preferences as string);

    // Tier 1: rule-based score for ALL listings (fast, no LLM)
    const scored = activeListings.results
      .map((listing) => {
        const { score, breakdown } = scoreListingRuleBased(listing, prefs);
        return { listing, score, breakdown };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // Tier 2: LLM explanations only for top 10
    const topN = 10;
    for (let i = 0; i < scored.length; i++) {
      const { listing, score, breakdown } = scored[i];
      let explanation: string;

      if (i < topN) {
        const result = await scoreListing(env.AI, listing, prefs, { db: env.DB });
        explanation = result.explanation;
      } else {
        explanation = `Scores ${score}/100 on rule-based match.`;
      }

      await env.DB.prepare(
        `INSERT INTO user_scores (user_id, listing_id, score, breakdown, explanation)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, listing_id) DO UPDATE SET
           score = excluded.score,
           breakdown = excluded.breakdown,
           explanation = excluded.explanation,
           created_at = datetime('now')`
      )
        .bind(user.id, listing.id, score, JSON.stringify(breakdown), explanation)
        .run();
    }

    if (env.RESEND_API_KEY) {
      const topScores = await getTopScoresForUser(env.DB, user.id as string, 10);
      await sendDailyEmail(
        env.RESEND_API_KEY,
        user.email as string,
        user.id as string,
        topScores.results,
        { newCount, removedCount, priceChanges: 0 }
      );
    }
  }

  return { success: true, newCount, removedCount, usersNotified: users.results.length };
}
