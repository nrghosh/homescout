// Coldwell Banker — often first to list Bay Area properties, direct brokerage data

import type { Source, SourceResult, ListingData } from "./common";
import { fetchHtml, parseJsonLdBlocks, normalizeStatus } from "./common";

export const coldwellBanker: Source = {
  name: "coldwell_banker",
  priority: 2,
  reliability: "high",

  handlesUrl(url: string) {
    return /coldwellbanker(?:homes)?\.com/i.test(url);
  },

  async fetchDetail(url: string): Promise<SourceResult | null> {
    const html = await fetchHtml(url);
    if (!html) return null;

    const data: Partial<ListingData> = { url };

    // JSON-LD is reliable on Coldwell Banker
    const blocks = parseJsonLdBlocks(html);
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.address?.streetAddress) {
        data.address = block.name || block.address.streetAddress;
        if (block.numberOfRooms) data.bedrooms = parseFloat(block.numberOfRooms);
        if (block.numberOfBathroomsTotal) data.bathrooms = parseFloat(block.numberOfBathroomsTotal);
        if (block.floorSize?.value) data.sqft = parseInt(block.floorSize.value);
        if (block.offers?.price) data.price = parseInt(String(block.offers.price));
      }
    }

    // Status signals in Coldwell's markup
    if (!data.status) {
      if (/listing\s*(?:is\s*)?pending|offer\s*accepted/i.test(html)) data.status = "pending";
      else if (/listing\s*(?:is\s*)?sold|recently\s*sold/i.test(html)) data.status = "sold";
      else if (/coming\s*soon/i.test(html)) data.status = "coming_soon";
      else if (data.price) data.status = "active";
    }

    if (!data.price && !data.bathrooms && !data.status) return null;

    return {
      data,
      source: "coldwell_banker",
      fetched_at: new Date().toISOString(),
      confidence: "high",
    };
  },
};
