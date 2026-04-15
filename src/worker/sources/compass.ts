// Compass — agent-driven listings, sometimes has Coming Soon listings Redfin misses

import type { Source, SourceResult, ListingData } from "./common";
import { fetchHtml, parseJsonLdBlocks, normalizeStatus } from "./common";

export const compass: Source = {
  name: "compass",
  priority: 2,
  reliability: "high",

  handlesUrl(url: string) {
    return /compass\.com/i.test(url);
  },

  async fetchDetail(url: string): Promise<SourceResult | null> {
    const html = await fetchHtml(url);
    if (!html) return null;

    const data: Partial<ListingData> = { url };

    // Compass uses Next.js — data is in __NEXT_DATA__
    const nextData = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextData) {
      try {
        const parsed = JSON.parse(nextData[1]);
        const listing = findListingInNextData(parsed);
        if (listing) {
          if (listing.price) data.price = parseInt(String(listing.price));
          if (listing.bedrooms) data.bedrooms = parseFloat(listing.bedrooms);
          if (listing.bathrooms) data.bathrooms = parseFloat(listing.bathrooms);
          if (listing.totalSqFt || listing.squareFootage) {
            data.sqft = parseInt(String(listing.totalSqFt || listing.squareFootage));
          }
          if (listing.status) data.status = normalizeStatus(listing.status);
          if (listing.address?.streetAddress) data.address = listing.address.streetAddress;
          if (listing.listDate) data.listing_date = listing.listDate;
        }
      } catch {}
    }

    // Fallback: JSON-LD
    if (!data.price) {
      const blocks = parseJsonLdBlocks(html);
      for (const block of blocks) {
        if (block?.offers?.price) data.price = parseInt(String(block.offers.price));
        if (block?.numberOfBathroomsTotal) data.bathrooms = parseFloat(block.numberOfBathroomsTotal);
      }
    }

    // Status indicators in page text
    if (!data.status) {
      if (/compass\s*coming\s*soon/i.test(html)) data.status = "coming_soon";
      else if (/contract\s*pending|under\s*contract|contingent/i.test(html)) data.status = "pending";
      else if (/this\s*listing\s*has\s*been\s*sold/i.test(html)) data.status = "sold";
    }

    if (!data.price && !data.bathrooms && !data.status && !data.sqft) {
      return null;
    }

    return {
      data,
      source: "compass",
      fetched_at: new Date().toISOString(),
      confidence: "high",
    };
  },
};

function findListingInNextData(obj: any, depth = 0): any {
  if (depth > 8 || !obj || typeof obj !== "object") return null;
  if (obj.price && (obj.bedrooms || obj.totalSqFt)) return obj;
  for (const val of Object.values(obj)) {
    const found = findListingInNextData(val, depth + 1);
    if (found) return found;
  }
  return null;
}
