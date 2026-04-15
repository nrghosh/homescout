// Realtor.com — direct MLS syndication via Move Inc, high reliability

import type { Source, SourceResult, ListingData } from "./common";
import { fetchHtml, parseJsonLdBlocks, normalizeStatus } from "./common";

export const realtor: Source = {
  name: "realtor",
  priority: 3,
  reliability: "high",

  handlesUrl(url: string) {
    return /realtor\.com/i.test(url);
  },

  async fetchDetail(url: string): Promise<SourceResult | null> {
    const html = await fetchHtml(url);
    if (!html) return null;

    const data: Partial<ListingData> = { url };

    // Realtor.com uses RDP state data
    const rdpMatch = html.match(/window\.__RDPPDEFAULT__\s*=\s*({[\s\S]*?});/);
    if (rdpMatch) {
      try {
        const state = JSON.parse(rdpMatch[1]);
        const prop = state?.property || state?.home;
        if (prop) {
          if (prop.list_price) data.price = parseInt(String(prop.list_price));
          if (prop.description?.beds) data.bedrooms = parseFloat(prop.description.beds);
          if (prop.description?.baths) data.bathrooms = parseFloat(prop.description.baths);
          if (prop.description?.sqft) data.sqft = parseInt(String(prop.description.sqft));
          if (prop.description?.lot_sqft) data.lot_sqft = parseInt(String(prop.description.lot_sqft));
          if (prop.status) data.status = normalizeStatus(prop.status);
          if (prop.list_date) data.listing_date = prop.list_date;
        }
      } catch {}
    }

    // JSON-LD fallback
    if (!data.price) {
      const blocks = parseJsonLdBlocks(html);
      for (const block of blocks) {
        if (block?.offers?.price) data.price = parseInt(String(block.offers.price));
        if (block?.address?.streetAddress) data.address = data.address || block.name;
      }
    }

    if (!data.price && !data.bathrooms && !data.status) return null;

    return {
      data,
      source: "realtor",
      fetched_at: new Date().toISOString(),
      confidence: "high",
    };
  },
};
