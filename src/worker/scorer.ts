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

export async function scoreListing(
  ai: Ai,
  listing: any,
  prefs: Preferences
): Promise<ScoreResult> {
  const priorities = prefs.priorities || {};
  const breakdown: Record<string, number> = {};
  let totalWeight = 0;
  let totalScore = 0;

  // --- Rule-based scoring ---

  // Hard filters (Must Have items auto-disqualify)
  if (priorities.bedrooms === "must_have" && listing.bedrooms < (prefs.beds_min || 2)) {
    return { score: 0, breakdown: { bedrooms: 0 }, explanation: `Disqualified: only ${listing.bedrooms} bedrooms (need ${prefs.beds_min}+).` };
  }
  if (priorities.bathrooms === "must_have" && listing.bathrooms < (prefs.baths_min || 2)) {
    return { score: 0, breakdown: { bathrooms: 0 }, explanation: `Disqualified: only ${listing.bathrooms} bathrooms (need ${prefs.baths_min}+).` };
  }
  if (priorities.price === "must_have" && listing.price > (prefs.price_max || 3000000)) {
    return { score: 0, breakdown: { price: 0 }, explanation: `Disqualified: $${(listing.price / 1000000).toFixed(1)}M exceeds budget.` };
  }

  // Score each dimension
  for (const [dim, baseWeight] of Object.entries(BASE_WEIGHTS)) {
    const bucket = priorities[dim] || "nice_to_have";
    const multiplier = BUCKET_WEIGHTS[bucket] || 1;
    const weight = baseWeight * multiplier;

    if (weight === 0) continue; // Not important, skip

    const dimScore = scoreDimension(dim, listing, prefs);
    breakdown[dim] = Math.round(dimScore * weight);
    totalScore += dimScore * weight;
    totalWeight += weight;
  }

  // Normalize to 0-100
  const normalizedScore = totalWeight > 0 ? Math.round((totalScore / totalWeight) * 100) : 0;

  // --- LLM explanation ---
  let explanation = "";
  try {
    explanation = await generateExplanation(ai, listing, prefs, normalizedScore, breakdown);
  } catch (err) {
    // Fallback to template
    explanation = templateExplanation(listing, normalizedScore, breakdown);
  }

  return { score: normalizedScore, breakdown, explanation };
}

function scoreDimension(dim: string, listing: any, prefs: Preferences): number {
  switch (dim) {
    case "price": {
      const max = prefs.price_max || 3000000;
      const mid = max * 0.7;
      if (!listing.price) return 0.5;
      if (listing.price <= mid) return 1.0;
      if (listing.price <= max * 0.85) return 0.75;
      if (listing.price <= max) return 0.5;
      return 0.1;
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
      return 0.3; // Unknown
    case "walkability":
      return 0.6; // Default moderate, could enhance with walk score API later
    case "condition":
      return 0.6; // Default moderate, would need listing description analysis
    default:
      return 0.5;
  }
}

async function generateExplanation(
  ai: Ai,
  listing: any,
  prefs: Preferences,
  score: number,
  breakdown: Record<string, number>
): Promise<string> {
  const prompt = `You are a real estate assistant. Write a 2-3 sentence explanation of why this listing scored ${score}/100 for this buyer. Be specific and concise.

Listing: ${listing.address}, $${listing.price?.toLocaleString()}, ${listing.bedrooms}bd/${listing.bathrooms}ba, ${listing.sqft || "?"} sqft, ${listing.neighborhood}, ${listing.property_type}.
Features: ${listing.features || "none listed"}.

Buyer priorities: ${JSON.stringify(prefs.priorities || {})}
Score breakdown: ${JSON.stringify(breakdown)}

Write the explanation in plain English, mentioning the top 2-3 factors that drove the score up or down. No bullet points, just flowing text.`;

  const response = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as any, {
    prompt,
    max_tokens: 150,
  });

  return (response as any).response || templateExplanation(listing, score, breakdown);
}

function templateExplanation(listing: any, score: number, breakdown: Record<string, number>): string {
  const top = Object.entries(breakdown)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k]) => k);

  return `Scored ${score}/100. Strongest on ${top.join(", ")}. ${listing.address} at $${((listing.price || 0) / 1000).toFixed(0)}K in ${listing.neighborhood}.`;
}
