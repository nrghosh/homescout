import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { scoreListing, scoreListingRuleBased } from "./scorer";
import { verifyListings } from "./verify";
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
  let newCount = 0;

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

  for (const hood of allNeighborhoods) {
    try {
      const listings = await scrapeNeighborhood(env.BROWSER, city, hood);
      for (const listing of listings) {
        const isNew = await upsertListing(env.DB, listing);
        if (isNew) newCount++;
      }
    } catch (err) {
      console.error(`Scrape failed for ${hood}:`, err);
    }
  }

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
        { newCount, removedCount: 0, priceChanges: 0 }
      );
    }
  }

  return { success: true, newCount, usersNotified: users.results.length };
}
