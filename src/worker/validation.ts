// Input validation — run everything through here

const VALID_BUCKETS = ["must_have", "important", "nice_to_have", "not_important"];
const VALID_CITIES = ["san_francisco"];
const VALID_NEIGHBORHOODS = [
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

// Known disposable email domains (starter list)
const DISPOSABLE_DOMAINS = new Set([
  "tempmail.com",
  "throwaway.email",
  "guerrillamail.com",
  "mailinator.com",
  "10minutemail.com",
  "yopmail.com",
  "trashmail.com",
  "fakeinbox.com",
  "sharklasers.com",
]);

export function validateEmail(email: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof email !== "string") return { ok: false, error: "Email must be a string" };

  const trimmed = email.trim().toLowerCase();
  if (trimmed.length < 5 || trimmed.length > 254) {
    return { ok: false, error: "Email length invalid" };
  }

  // RFC 5322 simplified pattern
  const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
  if (!emailRegex.test(trimmed)) {
    return { ok: false, error: "Invalid email format" };
  }

  const domain = trimmed.split("@")[1];
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { ok: false, error: "Disposable email addresses not accepted" };
  }

  return { ok: true, value: trimmed };
}

export function validatePreferences(prefs: unknown): { ok: true; value: any } | { ok: false; error: string } {
  if (!prefs || typeof prefs !== "object") {
    return { ok: false, error: "Preferences must be an object" };
  }

  const p = prefs as any;

  // Neighborhoods
  if (p.neighborhoods && !Array.isArray(p.neighborhoods)) {
    return { ok: false, error: "neighborhoods must be an array" };
  }
  if (p.neighborhoods) {
    for (const hood of p.neighborhoods) {
      if (typeof hood !== "string" || !VALID_NEIGHBORHOODS.includes(hood)) {
        return { ok: false, error: `Invalid neighborhood: ${hood}` };
      }
    }
    if (p.neighborhoods.length === 0) {
      return { ok: false, error: "Select at least one neighborhood" };
    }
    if (p.neighborhoods.length > 20) {
      return { ok: false, error: "Too many neighborhoods selected" };
    }
  }

  // Numeric fields
  const numericFields = ["price_min", "price_max", "beds_min", "baths_min", "sqft_min"];
  for (const field of numericFields) {
    if (p[field] != null) {
      const n = Number(p[field]);
      if (!Number.isFinite(n) || n < 0 || n > 100_000_000) {
        return { ok: false, error: `${field} must be a valid number` };
      }
      p[field] = n;
    }
  }

  // Price sanity
  if (p.price_min && p.price_max && p.price_min > p.price_max) {
    return { ok: false, error: "price_min cannot exceed price_max" };
  }

  // Priorities
  if (p.priorities) {
    if (typeof p.priorities !== "object") {
      return { ok: false, error: "priorities must be an object" };
    }
    for (const [key, val] of Object.entries(p.priorities)) {
      if (typeof val !== "string" || !VALID_BUCKETS.includes(val)) {
        return { ok: false, error: `Invalid priority bucket for ${key}` };
      }
    }
  }

  // Return a sanitized copy (strip any unexpected fields)
  return {
    ok: true,
    value: {
      neighborhoods: p.neighborhoods || [],
      price_min: p.price_min || 1000000,
      price_max: p.price_max || 3000000,
      beds_min: p.beds_min || 2,
      baths_min: p.baths_min || 2,
      sqft_min: p.sqft_min || 0,
      priorities: p.priorities || {},
    },
  };
}

export function validateCity(city: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof city !== "string") return { ok: false, error: "city must be a string" };
  if (!VALID_CITIES.includes(city)) return { ok: false, error: "city not supported" };
  return { ok: true, value: city };
}

// Rate limiting helpers
const rateLimitMap = new Map<string, number[]>();

export function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const requests = rateLimitMap.get(key) || [];
  const recent = requests.filter((t) => now - t < windowMs);
  if (recent.length >= maxRequests) return false;
  recent.push(now);
  rateLimitMap.set(key, recent);
  return true;
}
