import { Hono } from "hono";
import { cors } from "hono/cors";
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
  markListingStatus,
  logScan,
} from "./db";

type Bindings = {
  DB: D1Database;
  AI: Ai;
  BROWSER: Fetcher;
  ASSETS: Fetcher;
  RESEND_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/*", cors());

// Create or update user preferences
app.post("/api/users", async (c) => {
  const body = await c.req.json();
  const { email, preferences, city } = body;

  if (!email || !preferences) {
    return c.json({ error: "email and preferences required" }, 400);
  }

  const existing = await getUser(c.env.DB, email);
  if (existing) {
    await updateUser(c.env.DB, existing.id, preferences);
    return c.json({ id: existing.id, updated: true });
  }

  const user = await createUser(c.env.DB, email, city || "san_francisco", preferences);
  return c.json({ id: user.id, created: true });
});

// Get user dashboard data
app.get("/api/dashboard/:userId", async (c) => {
  const userId = c.req.param("userId");
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();

  if (!user) return c.json({ error: "user not found" }, 404);

  const scores = await getTopScoresForUser(c.env.DB, userId, 20);
  const recentScans = await c.env.DB.prepare(
    "SELECT * FROM scan_log WHERE city = ? ORDER BY scan_date DESC LIMIT 7"
  ).bind(user.city as string).all();

  return c.json({
    user: { id: user.id, email: user.email, preferences: JSON.parse(user.preferences as string) },
    listings: scores.results,
    scans: recentScans.results,
  });
});

// Get preferences config (neighborhoods etc.)
app.get("/api/config/:city", async (c) => {
  const city = c.req.param("city");
  if (city !== "san_francisco") return c.json({ error: "city not supported yet" }, 400);

  return c.json({
    city: "san_francisco",
    neighborhoods: SF_NEIGHBORHOODS,
    preference_fields: PREFERENCE_FIELDS,
    priority_buckets: ["must_have", "important", "nice_to_have", "not_important"],
  });
});

// Manual scan trigger (for testing)
app.post("/api/scan", async (c) => {
  const result = await runDailyScan(c.env);
  return c.json(result);
});

// Dashboard route — serve static HTML for any /dashboard/* path
app.get("/dashboard/*", async (c) => {
  return c.env.ASSETS.fetch(new Request(new URL("/dashboard.html", c.req.url)));
});

// Cron handler
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(runDailyScan(env));
  },
};

// --- Core scan logic ---

async function runDailyScan(env: Bindings) {
  const city = "san_francisco";
  let newCount = 0;
  let removedCount = 0;
  let priceChanges = 0;

  // Phase 1: Scrape each neighborhood for new listings
  const allNeighborhoods = SF_NEIGHBORHOODS.map((g) => g.neighborhoods).flat();

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

  // Phase 2: Score listings for each user
  const users = await getUsersForCity(env.DB, city);
  const activeListings = await getActiveListings(env.DB, city);

  for (const user of users.results) {
    const prefs = JSON.parse(user.preferences as string);

    for (const listing of activeListings.results) {
      const { score, breakdown, explanation } = await scoreListing(
        env.AI,
        listing,
        prefs
      );

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

    // Phase 3: Send email
    if (env.RESEND_API_KEY) {
      const topScores = await getTopScoresForUser(env.DB, user.id as string, 10);
      await sendDailyEmail(
        env.RESEND_API_KEY,
        user.email as string,
        user.id as string,
        topScores.results,
        { newCount, removedCount, priceChanges }
      );
    }
  }

  // Log the scan
  await logScan(env.DB, city, newCount, removedCount, priceChanges);

  return { success: true, newCount, removedCount, priceChanges, usersNotified: users.results.length };
}

// --- SF Config ---

const SF_NEIGHBORHOODS = [
  {
    group: "Preferred",
    neighborhoods: [
      "Cole Valley",
      "Noe Valley",
      "Dolores Heights",
      "Corona Heights",
      "Inner Sunset",
    ],
  },
  {
    group: "Central",
    neighborhoods: [
      "Duboce Triangle",
      "The Castro",
      "Glen Park",
      "Eureka Valley",
      "Ashbury Heights",
      "Mission Dolores",
      "Buena Vista",
    ],
  },
];

const PREFERENCE_FIELDS = [
  { key: "neighborhood", label: "Neighborhood", type: "multi_select" },
  { key: "price", label: "Price Range", type: "range", min: 500000, max: 5000000, step: 50000 },
  { key: "bedrooms", label: "Bedrooms", type: "min", options: [1, 2, 3, 4, 5] },
  { key: "bathrooms", label: "Bathrooms", type: "min", options: [1, 1.5, 2, 2.5, 3] },
  { key: "sqft", label: "Square Footage", type: "min", options: [800, 1000, 1200, 1400, 1600, 1800, 2000] },
  { key: "property_type", label: "Property Type", type: "priority", options: ["Single Family", "Condo", "TIC", "Duplex"] },
  { key: "parking", label: "Parking", type: "priority" },
  { key: "walkability", label: "Walkability / Transit", type: "priority" },
  { key: "condition", label: "Move-in Ready", type: "priority" },
];
