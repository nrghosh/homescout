// Feature flag helper — runtime config via D1 with environment overrides.
//
// Priority order for resolution:
//   1. Environment variable (highest — lets ops disable a flag instantly via wrangler secret)
//   2. Per-user allowlist in the flag row (always on for specific user_ids)
//   3. Rollout bucket: hash(user_id + key) % 100 < rollout_percent → 'on'
//   4. Default value from flag row
//   5. Hardcoded fallback passed by caller
//
// Caching: flags are read-heavy, so we cache in-memory for the request lifetime.
// For cross-request caching, we'd need a KV namespace — skipped for MVP.

type FlagEnv = {
  DB: D1Database;
  // Environment-specific overrides (e.g., FLAG_WIZARD_STEPS_3=on)
  [key: string]: any;
};

interface FlagRow {
  key: string;
  value: string;
  rollout_percent: number;
  allow_users: string | null;
}

// Simple request-scoped cache
const flagCache = new WeakMap<object, Map<string, string>>();

/**
 * Resolve a flag to its current value.
 * - `userId`: optional — if provided, enables allowlist + rollout bucketing
 * - `fallback`: value returned if the flag doesn't exist in DB
 */
export async function getFlag(
  env: FlagEnv,
  key: string,
  userId?: string,
  fallback = "off"
): Promise<string> {
  // 1. Environment override (FLAG_<KEY>)
  const envKey = `FLAG_${key}`;
  if (env[envKey] != null && env[envKey] !== "") {
    return String(env[envKey]);
  }

  // 2. Check cache
  const reqKey = env as unknown as object;
  let cache = flagCache.get(reqKey);
  if (!cache) {
    cache = new Map();
    flagCache.set(reqKey, cache);
  }
  const cacheKey = `${key}:${userId || ""}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  // 3. DB lookup
  const row = (await env.DB.prepare(
    "SELECT key, value, rollout_percent, allow_users FROM feature_flags WHERE key = ?"
  )
    .bind(key)
    .first()) as FlagRow | null;

  let resolved: string;
  if (!row) {
    resolved = fallback;
  } else if (userId) {
    // Allowlist check
    if (row.allow_users) {
      try {
        const allowed: string[] = JSON.parse(row.allow_users);
        if (allowed.includes(userId)) {
          resolved = "on";
          cache.set(cacheKey, resolved);
          return resolved;
        }
      } catch {}
    }

    // Rollout bucket
    if (row.rollout_percent > 0 && row.rollout_percent < 100) {
      const bucket = await bucketForUser(userId, key);
      resolved = bucket < row.rollout_percent ? "on" : row.value;
    } else if (row.rollout_percent >= 100) {
      resolved = "on";
    } else {
      resolved = row.value;
    }
  } else {
    resolved = row.value;
  }

  cache.set(cacheKey, resolved);
  return resolved;
}

/**
 * Convenience: returns true if the flag is 'on' (anything else returns false).
 * For non-boolean flags (e.g., ENRICHMENT_MODE), use getFlag() directly.
 */
export async function isFlagOn(env: FlagEnv, key: string, userId?: string): Promise<boolean> {
  const v = await getFlag(env, key, userId, "off");
  return v === "on";
}

/**
 * Batch-fetch multiple flags at once to reduce D1 round-trips.
 */
export async function getFlags(
  env: FlagEnv,
  keys: string[],
  userId?: string
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  await Promise.all(
    keys.map(async (k) => {
      result[k] = await getFlag(env, k, userId);
    })
  );
  return result;
}

// Stable hash → 0-99 bucket for a given (userId, flagKey) pair
async function bucketForUser(userId: string, flagKey: string): Promise<number> {
  const data = new TextEncoder().encode(`${userId}:${flagKey}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  // Use first 4 bytes as uint32, mod 100
  const bytes = new Uint8Array(hash);
  const n = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  return Math.abs(n) % 100;
}
