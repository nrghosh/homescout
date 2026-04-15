// Runtime listing verification — fetch URL and detect current status

const STATUS_PATTERNS: Array<{ status: string; patterns: RegExp[] }> = [
  {
    status: "sold",
    patterns: [
      /\bsold\b/i,
      /\bclosed[\s_-]?on\b/i,
      /price[\s-]+(was|reduced).*sold/i,
      /\"standardStatus\"\s*:\s*\"closed\"/i,
      /\"standardStatus\"\s*:\s*\"sold\"/i,
      /sale[\s-]+price/i,
    ],
  },
  {
    status: "pending",
    patterns: [
      /\bpending\b/i,
      /\bunder[\s-]+contract\b/i,
      /\bcontingent\b/i,
      /\boffer[\s-]+accepted\b/i,
      /\"standardStatus\"\s*:\s*\"pending\"/i,
      /\"standardStatus\"\s*:\s*\"contingent\"/i,
    ],
  },
  {
    status: "withdrawn",
    patterns: [
      /\bwithdrawn\b/i,
      /\boff[\s-]+market\b/i,
      /\blisting[\s-]+removed\b/i,
      /\bno[\s-]+longer[\s-]+for[\s-]+sale\b/i,
      /\"standardStatus\"\s*:\s*\"withdrawn\"/i,
    ],
  },
  {
    status: "active",
    patterns: [
      /\"standardStatus\"\s*:\s*\"active\"/i,
      /\bfor[\s-]+sale\b/i,
      /\"listingStatus\"\s*:\s*\"active\"/i,
    ],
  },
];

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface VerifyResult {
  status: "active" | "pending" | "sold" | "withdrawn" | "unknown";
  confidence: "high" | "medium" | "low";
  source: string;
}

// Fetch a listing URL and detect status from page content
export async function verifyListing(url: string): Promise<VerifyResult> {
  if (!url) return { status: "unknown", confidence: "low", source: "no_url" };

  try {
    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      cf: { cacheTtl: 600 }, // CF edge cache for 10 min
    } as any);

    if (response.status === 404) {
      return { status: "withdrawn", confidence: "high", source: "404" };
    }

    if (response.status === 403 || response.status === 401) {
      return { status: "unknown", confidence: "low", source: `http_${response.status}` };
    }

    if (!response.ok) {
      return { status: "unknown", confidence: "low", source: `http_${response.status}` };
    }

    const html = await response.text();

    // Quick check: extracted JSON-LD or microdata is most reliable
    // Check most-specific patterns first (sold > pending > withdrawn > active)
    for (const { status, patterns } of STATUS_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(html)) {
          // For "active", require explicit signal — don't default to active
          if (status === "active") {
            // Make sure pending/sold patterns don't ALSO match
            const hasNegative = STATUS_PATTERNS.slice(0, 3).some(({ patterns: nps }) =>
              nps.some((np) => np.test(html))
            );
            if (hasNegative) continue;
            return { status: "active", confidence: "high", source: "page_signal" };
          }
          return { status: status as any, confidence: "high", source: "page_signal" };
        }
      }
    }

    // No clear signal found — content exists but ambiguous
    return { status: "unknown", confidence: "low", source: "no_signal" };
  } catch (err) {
    return { status: "unknown", confidence: "low", source: "fetch_error" };
  }
}

// Verify multiple listings in parallel with a concurrency limit
export async function verifyListings(
  listings: Array<{ id: string; url: string }>,
  concurrency = 5
): Promise<Map<string, VerifyResult>> {
  const results = new Map<string, VerifyResult>();
  const queue = [...listings];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const result = await verifyListing(item.url);
      results.set(item.id, result);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, listings.length) }, worker);
  await Promise.all(workers);
  return results;
}
