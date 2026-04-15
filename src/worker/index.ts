import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { scoreListing } from "./scorer";
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
// Returns a teaser: matches #4-6 visible, #1-3 blurred
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

  // Get all active listings and score them
  const listings = await getActiveListings(c.env.DB, city);
  const scored = [];

  for (const listing of listings.results) {
    const result = await scoreListing(c.env.AI, listing, prefsCheck.value);
    if (result.score > 0) {
      scored.push({ ...listing, ...result });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // Top 3 = locked teasers (show score + neighborhood only)
  // 4-6 = full details (proof the product works)
  const locked = scored.slice(0, 3).map((l) => ({
    score: l.score,
    neighborhood: l.neighborhood,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    property_type: l.property_type,
    price_range: l.price ? priceRange(l.price) : null,
    locked: true,
  }));

  const visible = scored.slice(3, 6).map((l) => ({
    score: l.score,
    address: l.address,
    price: l.price,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    sqft: l.sqft,
    neighborhood: l.neighborhood,
    property_type: l.property_type,
    url: l.url,
    explanation: l.explanation,
    locked: false,
  }));

  return c.json({
    total_matches: scored.length,
    locked,
    visible,
    city,
  });
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

    for (const listing of activeListings.results) {
      const { score, breakdown, explanation } = await scoreListing(env.AI, listing, prefs);
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
