// Source registry — add new sources here to expand coverage
//
// Priority order (1 = most trusted, used first):
//   1. Redfin (fast MLS IDX)
//   2. Coldwell Banker, Compass (direct brokerage data)
//   3. Realtor.com (MLS syndication via Move)
//   4. Zillow (broad coverage, aggressive bot blocking)

import { redfin } from "./redfin";
import { compass } from "./compass";
import { coldwellBanker } from "./coldwell";
import { realtor } from "./realtor";
import { zillow } from "./zillow";

export { redfin, compass, coldwellBanker, realtor, zillow };
export * from "./common";

export const ALL_SOURCES = [redfin, coldwellBanker, compass, realtor, zillow];

// Find the source that handles a given URL (for direct detail fetches)
export function sourceForUrl(url: string) {
  return ALL_SOURCES.find((s) => s.handlesUrl(url)) || null;
}

// Sources sorted by priority for fallback enrichment
export const SOURCES_BY_PRIORITY = [...ALL_SOURCES].sort((a, b) => a.priority - b.priority);
