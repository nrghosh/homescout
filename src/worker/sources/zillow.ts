// Zillow — broadest coverage but aggressive bot blocking. Low priority.

import type { Source, SourceResult, ListingData } from "./common";
import { fetchHtml, normalizeStatus } from "./common";

export const zillow: Source = {
  name: "zillow",
  priority: 4,
  reliability: "medium",

  handlesUrl(url: string) {
    return /zillow\.com/i.test(url);
  },

  async fetchDetail(url: string): Promise<SourceResult | null> {
    const html = await fetchHtml(url);
    if (!html) return null;

    const data: Partial<ListingData> = { url };

    // Zillow embeds hdpData in a script tag
    const hdpMatch = html.match(/"hdpData"\s*:\s*({[\s\S]*?})(?:,"\w)/);
    if (hdpMatch) {
      try {
        const hdp = JSON.parse(hdpMatch[1]);
        if (hdp.homeInfo) {
          const h = hdp.homeInfo;
          if (h.price) data.price = parseInt(String(h.price));
          if (h.bedrooms) data.bedrooms = parseFloat(h.bedrooms);
          if (h.bathrooms) data.bathrooms = parseFloat(h.bathrooms);
          if (h.livingArea) data.sqft = parseInt(String(h.livingArea));
          if (h.lotSize) data.lot_sqft = parseInt(String(h.lotSize));
          if (h.homeStatus) data.status = normalizeStatus(h.homeStatus);
          if (h.streetAddress) data.address = h.streetAddress;
        }
      } catch {}
    }

    // Text-based status detection
    if (!data.status) {
      if (/this\s*home\s*is\s*no\s*longer\s*for\s*sale/i.test(html)) data.status = "withdrawn";
      else if (/\"homeStatus\"\s*:\s*\"PENDING\"/i.test(html)) data.status = "pending";
      else if (/\"homeStatus\"\s*:\s*\"RECENTLY_SOLD\"/i.test(html)) data.status = "sold";
      else if (/\"homeStatus\"\s*:\s*\"FOR_SALE\"/i.test(html)) data.status = "active";
    }

    if (!data.price && !data.bathrooms && !data.status) return null;

    return {
      data,
      source: "zillow",
      fetched_at: new Date().toISOString(),
      confidence: "medium",
    };
  },
};
