// Enrichment orchestrator — merge listing data from multiple sources

import {
  ALL_SOURCES,
  SOURCES_BY_PRIORITY,
  sourceForUrl,
  type Source,
  type ListingData,
  type SourceResult,
  type ListingStatus,
} from "./sources";

export interface EnrichedListing extends ListingData {
  _sources: Record<string, { source: string; fetched_at: string; confidence: string }>;
}

const FIELDS_WE_WANT: (keyof ListingData)[] = [
  "price",
  "bedrooms",
  "bathrooms",
  "sqft",
  "status",
  "property_type",
  "parking",
];

// Status conflict resolution: prefer stricter/more recent status
const STATUS_STRICTNESS: Record<ListingStatus, number> = {
  sold: 5,
  withdrawn: 5,
  pending: 4,
  coming_soon: 3,
  active: 2,
  unknown: 1,
};

/**
 * Enrich a listing by fetching from multiple sources.
 * Strategy:
 *  1. If the listing has a URL, fetch from the matching source first (it's usually the primary)
 *  2. Then walk SOURCES_BY_PRIORITY, fetching any source whose URL we can synthesize or already know
 *  3. Merge results: missing fields filled from next source; conflicting status resolved by strictness
 */
export async function enrichListing(
  listing: Partial<ListingData> & { url?: string; address?: string },
  options: {
    maxSources?: number;
    fallbackAllSources?: boolean;
  } = {}
): Promise<EnrichedListing> {
  const { maxSources = 2, fallbackAllSources = false } = options;
  const merged: EnrichedListing = { ...listing, _sources: {} };
  const results: SourceResult[] = [];

  // Step 1: primary source by URL
  if (listing.url) {
    const primarySource = sourceForUrl(listing.url);
    if (primarySource) {
      const result = await primarySource.fetchDetail(listing.url);
      if (result) {
        results.push(result);
        mergeResult(merged, result);
      }
    }
  }

  // Step 2: try additional sources until we have the fields we need OR hit maxSources
  if (!hasAllFields(merged) || fallbackAllSources) {
    const sourcesToTry = SOURCES_BY_PRIORITY.filter(
      (s) => !results.find((r) => r.source === s.name)
    ).slice(0, maxSources - results.length);

    for (const source of sourcesToTry) {
      // Skip if we already have everything
      if (!fallbackAllSources && hasAllFields(merged)) break;

      // Try to find a URL on this source for this address
      if (!source.searchByAddress || !listing.address) continue;

      const searchResult = await source.searchByAddress(listing.address);
      if (!searchResult) continue;

      const detail = await source.fetchDetail(searchResult.url);
      if (detail) {
        results.push(detail);
        mergeResult(merged, detail);
      }
    }
  }

  return merged;
}

function mergeResult(target: EnrichedListing, result: SourceResult) {
  const { data, source, fetched_at, confidence } = result;

  for (const [key, value] of Object.entries(data)) {
    if (value == null || value === "") continue;

    const current = (target as any)[key];

    // Status has special conflict resolution
    if (key === "status") {
      if (!current || shouldOverrideStatus(current, value as ListingStatus)) {
        (target as any)[key] = value;
        target._sources[key] = { source, fetched_at, confidence };
      }
      continue;
    }

    // For other fields, fill in if missing
    if (current == null || current === "") {
      (target as any)[key] = value;
      target._sources[key] = { source, fetched_at, confidence };
    }
  }
}

function shouldOverrideStatus(current: ListingStatus, incoming: ListingStatus): boolean {
  const curStrictness = STATUS_STRICTNESS[current] ?? 1;
  const newStrictness = STATUS_STRICTNESS[incoming] ?? 1;
  return newStrictness > curStrictness;
}

function hasAllFields(listing: Partial<ListingData>): boolean {
  return FIELDS_WE_WANT.every((f) => listing[f] != null);
}

// Batch enrichment with concurrency control
export async function enrichBatch(
  listings: Array<Partial<ListingData> & { url?: string; address?: string; id: string }>,
  concurrency = 5
): Promise<Map<string, EnrichedListing>> {
  const results = new Map<string, EnrichedListing>();
  const queue = [...listings];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        const enriched = await enrichListing(item);
        results.set(item.id, enriched);
      } catch (err) {
        console.error(`Enrich failed for ${item.id}:`, err);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, listings.length) },
    worker
  );
  await Promise.all(workers);
  return results;
}
