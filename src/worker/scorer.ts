// Scoring engine: priority buckets → weighted scores + LLM explanations

const BUCKET_WEIGHTS: Record<string, number> = {
  must_have: 3,
  important: 2,
  nice_to_have: 1,
  not_important: 0,
};

const BASE_WEIGHTS: Record<string, number> = {
  neighborhood: 10,
  price: 10,
  property_type: 7,
  size: 7,
  bedrooms: 5,
  bathrooms: 3,
  parking: 3,
  walkability: 3,
  condition: 3,
};

// Only generate LLM explanations for scores at or above this threshold
const LLM_THRESHOLD = 70;

interface Preferences {
  neighborhoods?: string[];
  price_min?: number;
  price_max?: number;
  beds_min?: number;
  baths_min?: number;
  sqft_min?: number;
  priorities?: Record<string, string>;
}

interface ScoreResult {
  score: number;
  breakdown: Record<string, number>;
  explanation: string;
}

// --- Rule-based score only (fast, no LLM) ---
export function scoreListingRuleBased(listing: any, prefs: Preferences): {
  score: number;
  breakdown: Record<string, number>;
} {
  const priorities = prefs.priorities || {};
  const breakdown: Record<string, number> = {};
  let totalWeight = 0;
  let totalScore = 0;

  // Hard filters (Must Have items auto-disqualify)
  if (priorities.bedrooms === "must_have" && listing.bedrooms < (prefs.beds_min || 2)) {
    return { score: 0, breakdown: { bedrooms: 0 } };
  }
  if (priorities.bathrooms === "must_have" && listing.bathrooms < (prefs.baths_min || 2)) {
    return { score: 0, breakdown: { bathrooms: 0 } };
  }
  if (priorities.price === "must_have" && listing.price > (prefs.price_max || 3000000)) {
    return { score: 0, breakdown: { price: 0 } };
  }
  if (priorities.price === "must_have" && listing.price < (prefs.price_min || 0)) {
    return { score: 0, breakdown: { price: 0 } };
  }

  for (const [dim, baseWeight] of Object.entries(BASE_WEIGHTS)) {
    const bucket = priorities[dim] || "nice_to_have";
    const multiplier = BUCKET_WEIGHTS[bucket] || 1;
    const weight = baseWeight * multiplier;
    if (weight === 0) continue;

    const dimScore = scoreDimension(dim, listing, prefs);
    breakdown[dim] = Math.round(dimScore * weight);
    totalScore += dimScore * weight;
    totalWeight += weight;
  }

  const normalizedScore = totalWeight > 0 ? Math.round((totalScore / totalWeight) * 100) : 0;
  return { score: normalizedScore, breakdown };
}

// --- Full scoring with LLM explanation (only for high-scoring listings) ---
export async function scoreListing(
  ai: Ai,
  listing: any,
  prefs: Preferences,
  options?: { db?: D1Database; skipLLM?: boolean }
): Promise<ScoreResult> {
  const { score, breakdown } = scoreListingRuleBased(listing, prefs);

  // Skip LLM entirely for low-scoring or disqualified listings
  if (score === 0 || score < LLM_THRESHOLD || options?.skipLLM) {
    return {
      score,
      breakdown,
      explanation: templateExplanation(listing, score, breakdown, prefs),
    };
  }

  // Check cache first
  if (options?.db) {
    const cached = await getCachedExplanation(options.db, listing.id, prefs);
    if (cached) {
      return { score, breakdown, explanation: cached };
    }
  }

  // Generate fresh LLM explanation
  let explanation: string;
  try {
    explanation = await generateExplanation(ai, listing, prefs, score, breakdown);
    if (options?.db) {
      await setCachedExplanation(options.db, listing.id, prefs, explanation);
    }
  } catch {
    explanation = templateExplanation(listing, score, breakdown, prefs);
  }

  return { score, breakdown, explanation };
}

function scoreDimension(dim: string, listing: any, prefs: Preferences): number {
  switch (dim) {
    case "price": {
      const max = prefs.price_max || 3000000;
      const min = prefs.price_min || 0;
      if (!listing.price) return 0.5;
      if (listing.price < min || listing.price > max) return 0.1;
      const mid = (min + max) / 2;
      if (listing.price <= mid) return 1.0;
      const ratio = (max - listing.price) / (max - mid);
      return Math.max(0.3, ratio);
    }
    case "neighborhood": {
      const targetHoods = (prefs.neighborhoods || []).map((n: string) => n.toLowerCase());
      const listingHood = (listing.neighborhood || "").toLowerCase();
      if (targetHoods.some((h: string) => listingHood.includes(h) || h.includes(listingHood))) return 1.0;
      return 0.3;
    }
    case "property_type": {
      const type = (listing.property_type || "").toLowerCase();
      if (type === "sfh" || type === "single_family") return 1.0;
      if (type === "condo") return 0.6;
      if (type === "tic") return 0.3;
      if (type === "duplex") return 0.7;
      return 0.5;
    }
    case "size": {
      const min = prefs.sqft_min || 1600;
      if (!listing.sqft) return 0.5;
      if (listing.sqft >= min * 1.15) return 1.0;
      if (listing.sqft >= min) return 0.8;
      if (listing.sqft >= min * 0.85) return 0.5;
      return 0.2;
    }
    case "bedrooms": {
      const min = prefs.beds_min || 2;
      if (!listing.bedrooms) return 0.5;
      if (listing.bedrooms >= min + 1) return 1.0;
      if (listing.bedrooms >= min) return 0.7;
      return 0.0;
    }
    case "bathrooms": {
      const min = prefs.baths_min || 2;
      if (!listing.bathrooms) return 0.5;
      if (listing.bathrooms >= min) return 1.0;
      return 0.0;
    }
    case "parking":
      if (listing.parking === 1 || listing.parking === true) return 1.0;
      if (listing.parking === 0 || listing.parking === false) return 0.0;
      return 0.3;
    case "walkability":
      return 0.6;
    case "condition":
      return 0.6;
    default:
      return 0.5;
  }
}

// --- LLM explanation with tight prompt and post-processing ---
async function generateExplanation(
  ai: Ai,
  listing: any,
  prefs: Preferences,
  score: number,
  breakdown: Record<string, number>
): Promise<string> {
  // Identify top 2-3 factors driving the score
  const topFactors = Object.entries(breakdown)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k]) => k);

  const priceM = listing.price ? (listing.price / 1_000_000).toFixed(2) : "?";
  const prompt = `Explain in exactly 2 short sentences why this home scored ${score}/100. No meta-commentary. No "Note:", "Please", or "Let me know". Just the explanation.

Home: $${priceM}M, ${listing.bedrooms}bd/${listing.bathrooms}ba, ${listing.sqft || "?"} sqft, ${listing.neighborhood}, ${listing.property_type || "home"}.
Top scoring factors: ${topFactors.join(", ")}.

Explanation:`;

  const response = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any, {
    prompt,
    max_tokens: 80,
    temperature: 0.3,
  });

  const raw = (response as any).response || "";
  return cleanExplanation(raw) || templateExplanation(listing, score, breakdown, prefs);
}

// Strip meta-commentary, conversational cruft, and garbled tails
function cleanExplanation(text: string): string {
  let cleaned = text.trim();

  // Cut at known cruft phrases
  const cruftPatterns = [
    /\n\s*Note[:]/i,
    /\n\s*Please let me know/i,
    /\n\s*Let me know/i,
    /\n\s*The score breakdown/i,
    /\n\s*I hope this/i,
    /\n\s*Is there/i,
    /\n\s*Would you/i,
    /\n\s*If you/i,
    /Explanation[:]/i,
  ];
  for (const pattern of cruftPatterns) {
    const match = cleaned.match(pattern);
    if (match && match.index !== undefined) {
      cleaned = cleaned.slice(0, match.index).trim();
    }
  }

  // Remove leading labels / prefixes
  cleaned = cleaned.replace(/^(Explanation|Summary|Answer)[:]\s*/i, "").trim();

  // Keep to max 2 sentences, max 300 chars
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 2) {
    cleaned = sentences.slice(0, 2).join("").trim();
  }
  if (cleaned.length > 300) {
    cleaned = cleaned.slice(0, 297).trim() + "...";
  }

  return cleaned;
}

function templateExplanation(
  listing: any,
  score: number,
  breakdown: Record<string, number>,
  prefs: Preferences
): string {
  if (score === 0) {
    const priorities = prefs.priorities || {};
    if (priorities.bedrooms === "must_have" && listing.bedrooms < (prefs.beds_min || 2))
      return `Doesn't meet your bedroom minimum (${listing.bedrooms} vs ${prefs.beds_min || 2}+).`;
    if (priorities.bathrooms === "must_have" && listing.bathrooms < (prefs.baths_min || 2))
      return `Doesn't meet your bathroom minimum (${listing.bathrooms} vs ${prefs.baths_min || 2}+).`;
    return "Doesn't match your must-have criteria.";
  }

  const top = Object.entries(breakdown)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2)
    .map(([k]) => k.replace("_", " "));

  return `Scores ${score}/100. Strongest fit on ${top.join(" and ")}.`;
}

// --- Explanation caching ---
function priorityHash(prefs: Preferences): string {
  // Simple deterministic hash of the priority buckets + bounds that matter for scoring
  const priorities = prefs.priorities || {};
  const parts = [
    ...Object.keys(priorities)
      .sort()
      .map((k) => `${k}:${priorities[k]}`),
    `beds:${prefs.beds_min || 0}`,
    `baths:${prefs.baths_min || 0}`,
    `sqft:${prefs.sqft_min || 0}`,
    `pmin:${prefs.price_min || 0}`,
    `pmax:${prefs.price_max || 0}`,
  ];
  return parts.join("|");
}

async function getCachedExplanation(
  db: D1Database,
  listingId: string,
  prefs: Preferences
): Promise<string | null> {
  const hash = priorityHash(prefs);
  const row = await db
    .prepare(
      `SELECT explanation FROM explanation_cache
       WHERE listing_id = ? AND priority_hash = ? AND created_at > datetime('now', '-7 days')`
    )
    .bind(listingId, hash)
    .first();
  return (row?.explanation as string) || null;
}

async function setCachedExplanation(
  db: D1Database,
  listingId: string,
  prefs: Preferences,
  explanation: string
): Promise<void> {
  const hash = priorityHash(prefs);
  await db
    .prepare(
      `INSERT INTO explanation_cache (listing_id, priority_hash, explanation, created_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(listing_id, priority_hash) DO UPDATE SET
         explanation = excluded.explanation,
         created_at = excluded.created_at`
    )
    .bind(listingId, hash, explanation)
    .run();
}
