// Redfin source — highest priority, fast MLS IDX updates

import type { Source, SourceResult, ListingData } from "./common";
import { fetchHtml, parseJsonLdBlocks, normalizeStatus, extractFromText } from "./common";

export const redfin: Source = {
  name: "redfin",
  priority: 1,
  reliability: "high",

  handlesUrl(url: string) {
    return /redfin\.com/i.test(url);
  },

  async fetchDetail(url: string): Promise<SourceResult | null> {
    const html = await fetchHtml(url);
    if (!html) return null;

    const data: Partial<ListingData> = { url };

    // Strategy 1: JSON-LD blocks on detail pages have Residence + offers
    const blocks = parseJsonLdBlocks(html);
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;

      // Primary residence block
      if (block.address?.streetAddress) {
        data.address = data.address || block.name || block.address.streetAddress;
        if (block.numberOfRooms) data.bedrooms = parseFloat(block.numberOfRooms);
        if (block.numberOfBathroomsTotal) data.bathrooms = parseFloat(block.numberOfBathroomsTotal);
        if (block.floorSize?.value) data.sqft = parseInt(block.floorSize.value);
        if (block.offers?.price) data.price = parseInt(String(block.offers.price));
        if (block.offers?.availability) {
          data.status = normalizeStatus(String(block.offers.availability));
        }
      }

      // Open House events
      if (block["@type"] === "Event" && block.startDate) {
        data.open_houses = data.open_houses || [];
        data.open_houses.push({ start: block.startDate, end: block.endDate });
      }
    }

    // Strategy 2: HTML data attributes (price, beds, baths often in data-* attrs)
    if (!data.price) {
      // Redfin shows price as <div class="homeInfo"><div class="statsValue">$X,XXX,XXX</div>
      const priceMatch = html.match(/class="[^"]*(?:statsValue|price)[^"]*"[^>]*>\s*\$([\d,]+)/i);
      if (priceMatch) data.price = parseInt(priceMatch[1].replace(/,/g, ""));
    }

    if (!data.bathrooms) {
      const bathMatch = html.match(/(\d+(?:\.\d+)?)\s*(?:Bath|bathrooms?)/i);
      if (bathMatch) data.bathrooms = parseFloat(bathMatch[1]);
    }

    // Strategy 3: detect status from page text
    if (!data.status) {
      if (/\"standardStatus\"\s*:\s*\"(Pending|Contingent|ActiveUnderContract)\"/i.test(html))
        data.status = "pending";
      else if (/\"standardStatus\"\s*:\s*\"(Sold|Closed)\"/i.test(html))
        data.status = "sold";
      else if (/\"standardStatus\"\s*:\s*\"(Withdrawn|Canceled)\"/i.test(html))
        data.status = "withdrawn";
      else if (/\"standardStatus\"\s*:\s*\"Active\"/i.test(html)) data.status = "active";
    }

    // Extract parking from features
    if (data.parking == null) {
      if (/garage|parking\s*space|carport/i.test(html)) data.parking = true;
    }

    // If we got nothing useful, return null
    if (!data.price && !data.bathrooms && !data.status && !data.sqft) {
      return null;
    }

    return {
      data,
      source: "redfin",
      fetched_at: new Date().toISOString(),
      confidence: "high",
    };
  },
};
