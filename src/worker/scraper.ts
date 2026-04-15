// Hybrid scraper: try plain HTTP first, fall back to Cloudflare Browser Rendering.
// Parses Redfin neighborhood search pages (most structured data).

const REDFIN_NEIGHBORHOOD_IDS: Record<string, string> = {
  // Redfin's internal region IDs for SF neighborhoods
  // Format: /neighborhood/{id}/CA/San-Francisco/{slug}
  "Cole Valley": "605/CA/San-Francisco/Cole-Valley",
  "Noe Valley": "1838/CA/San-Francisco/Noe-Valley",
  "Dolores Heights": "109390/CA/San-Francisco/Dolores-Heights",
  "Corona Heights": "604/CA/San-Francisco/Corona-Heights",
  "Inner Sunset": "973/CA/San-Francisco/Inner-Sunset",
  "Duboce Triangle": "773/CA/San-Francisco/Duboce-Triangle",
  "The Castro": "5350/CA/San-Francisco/Castro",
  "Glen Park": "884/CA/San-Francisco/Glen-Park",
  "Eureka Valley": "812/CA/San-Francisco/Eureka-Valley",
  "Ashbury Heights": "120/CA/San-Francisco/Ashbury-Heights",
  "Mission Dolores": "1648/CA/San-Francisco/Mission-Dolores",
  "Buena Vista": "390/CA/San-Francisco/Buena-Vista",
};

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
};

interface ScrapedListing {
  address: string;
  price: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  sqft: number | null;
  neighborhood: string;
  property_type: string;
  url: string;
  city: string;
  status: string;
  parking: boolean | null;
  features: string[];
  red_flags: string[];
  raw_data: any;
}

export async function scrapeNeighborhood(
  browser: Fetcher | undefined,
  city: string,
  neighborhood: string
): Promise<ScrapedListing[]> {
  const slug = REDFIN_NEIGHBORHOOD_IDS[neighborhood];
  if (!slug) {
    console.log(`No Redfin slug for ${neighborhood}`);
    return [];
  }

  // Filter URL: 2+ bed, 2+ bath, $1M-$3M, house+condo+townhouse
  const url = `https://www.redfin.com/neighborhood/${slug}/filter/property-type=house+condo+townhouse,min-beds=2,min-baths=2,min-price=1M,max-price=3M`;

  // Tier 1: try plain HTTP fetch
  let html = await tryHttpFetch(url);

  // Tier 2: fall back to Browser Rendering if HTTP failed (403/blocked)
  if (!html && browser) {
    html = await tryBrowserRendering(browser, url);
  }

  if (!html) {
    console.log(`Both fetch tiers failed for ${neighborhood}`);
    return [];
  }

  return parseRedfinHtml(html, neighborhood);
}

async function tryHttpFetch(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      cf: { cacheTtl: 1800 }, // 30-min edge cache
    } as any);

    if (!response.ok) {
      console.log(`HTTP fetch returned ${response.status} for ${url}`);
      return null;
    }

    const text = await response.text();
    // Detect anti-bot pages: short response or specific block markers in <title>
    if (text.length < 5000) {
      console.log("HTTP fetch returned tiny response (likely blocked)");
      return null;
    }
    // Only flag bot-detection if it's in <title> or <h1> (where it'd actually appear)
    const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
    if (titleMatch && /access\s*denied|blocked|forbidden|cloudflare|cf-browser/i.test(titleMatch[1])) {
      console.log(`HTTP fetch hit block page: ${titleMatch[1]}`);
      return null;
    }
    return text;
  } catch (err) {
    console.log(`HTTP fetch error: ${err}`);
    return null;
  }
}

async function tryBrowserRendering(browser: Fetcher, url: string): Promise<string | null> {
  try {
    // Cloudflare Browser Rendering REST API via the binding
    // POST to /content with JSON {url}
    const response = await browser.fetch("https://browser/content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, waitUntil: "networkidle0" }),
    });

    if (!response.ok) {
      console.log(`Browser Rendering returned ${response.status}`);
      return null;
    }

    return await response.text();
  } catch (err) {
    console.log(`Browser Rendering error: ${err}`);
    return null;
  }
}

function parseRedfinHtml(html: string, neighborhood: string): ScrapedListing[] {
  const listings: ScrapedListing[] = [];

  // Strategy 1: Redfin embeds search results as JSON in a <script> tag
  // Look for ServerState or homes data
  const serverStateMatch = html.match(/<script[^>]*>__reactServerState\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (serverStateMatch) {
    try {
      const state = JSON.parse(serverStateMatch[1]);
      const homes = extractHomesFromState(state);
      for (const home of homes) {
        const listing = normalizeRedfinHome(home, neighborhood);
        if (listing) listings.push(listing);
      }
    } catch (err) {
      console.log("ServerState parse failed:", err);
    }
  }

  // Strategy 2: parse JSON-LD structured data
  // Redfin emits each listing as a JSON-LD ARRAY containing related items
  // (the property + open houses + breadcrumbs). The first item with
  // address.streetAddress is the listing itself.
  if (listings.length === 0) {
    const jsonLdMatches = html.matchAll(
      /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
    );
    for (const match of jsonLdMatches) {
      try {
        const json = JSON.parse(match[1]);
        const items = Array.isArray(json) ? json : json["@graph"] || [json];
        // Find the listing item (has address.streetAddress)
        const listingItem = items.find(
          (it: any) => it && it.address && it.address.streetAddress
        );
        if (listingItem) {
          const listing = normalizeRedfinJsonLd(listingItem, items, neighborhood);
          if (listing) listings.push(listing);
        }
      } catch {}
    }
  }

  // Strategy 3: regex extraction from HomeCardContainer markup as last resort
  if (listings.length === 0) {
    listings.push(...extractListingsFromHomeCards(html, neighborhood));
  }

  return listings;
}

function extractHomesFromState(state: any): any[] {
  // Redfin's React state has a complex structure — look for homes array
  if (!state) return [];
  const candidates = [
    state.searchResult?.homes,
    state.homes,
    state.results?.homes,
    state.payload?.homes,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c;
  }
  return [];
}

function normalizeRedfinHome(home: any, neighborhood: string): ScrapedListing | null {
  if (!home || !home.streetLine) return null;
  return {
    address: typeof home.streetLine === "object" ? home.streetLine.value : home.streetLine,
    price: typeof home.price === "object" ? home.price.value : home.price,
    bedrooms: typeof home.beds === "object" ? home.beds.value : home.beds,
    bathrooms: typeof home.baths === "object" ? home.baths.value : home.baths,
    sqft: typeof home.sqFt === "object" ? home.sqFt.value : home.sqFt,
    neighborhood,
    property_type: inferPropertyType(home.propertyType || ""),
    url: home.url ? `https://www.redfin.com${home.url}` : "",
    city: "san_francisco",
    status: "active",
    parking: home.hasParking ?? null,
    features: [],
    red_flags: [],
    raw_data: { source: "redfin_state", mlsId: home.mlsId, listingId: home.listingId },
  };
}

function normalizeRedfinJsonLd(
  primary: any,
  allItems: any[],
  neighborhood: string
): ScrapedListing | null {
  if (!primary?.address?.streetAddress) return null;

  // The full address line from "name" includes street + city + state + zip
  const fullAddress = primary.name || `${primary.address.streetAddress}, San Francisco, CA`;

  // Look for additional info in sibling array items (open houses, etc.)
  // Redfin often embeds beds/baths in description fields
  let bedrooms: number | null = null;
  let bathrooms: number | null = null;
  let sqft: number | null = null;
  let price: number | null = null;

  // Check primary item for these
  if (primary.numberOfRooms) bedrooms = parseFloat(primary.numberOfRooms);
  if (primary.numberOfBathroomsTotal) bathrooms = parseFloat(primary.numberOfBathroomsTotal);
  if (primary.floorSize?.value) sqft = parseInt(primary.floorSize.value);
  if (primary.offers?.price) price = parseInt(String(primary.offers.price));

  // Check description for parsing hints
  const desc = primary.description || "";
  if (!bedrooms) {
    const m = desc.match(/(\d+(?:\.\d+)?)\s*(?:bed|bd|br)/i);
    if (m) bedrooms = parseFloat(m[1]);
  }
  if (!bathrooms) {
    const m = desc.match(/(\d+(?:\.\d+)?)\s*(?:bath|ba)/i);
    if (m) bathrooms = parseFloat(m[1]);
  }
  if (!sqft) {
    const m = desc.match(/([\d,]+)\s*(?:sq\s*ft|sqft)/i);
    if (m) sqft = parseInt(m[1].replace(/,/g, ""));
  }
  if (!price) {
    const m = desc.match(/\$([\d,]+)/);
    if (m) price = parseInt(m[1].replace(/,/g, ""));
  }

  return {
    address: fullAddress,
    price,
    bedrooms,
    bathrooms,
    sqft,
    neighborhood,
    property_type: "condo", // default; refined later via verification
    url: primary.url || "",
    city: "san_francisco",
    status: "active",
    parking: null,
    features: [],
    red_flags: [],
    raw_data: { source: "redfin_jsonld" },
  };
}

function normalizeJsonLd(item: any, neighborhood: string): ScrapedListing | null {
  const type = item["@type"];
  if (!type) return null;
  const isResidence =
    type === "SingleFamilyResidence" ||
    type === "Residence" ||
    type === "House" ||
    type === "Apartment";
  if (!isResidence) return null;

  return {
    address:
      item.address?.streetAddress ||
      (typeof item.address === "string" ? item.address : item.name) ||
      "",
    price: item.offers?.price ? parseInt(String(item.offers.price)) : null,
    bedrooms: item.numberOfRooms || null,
    bathrooms: item.numberOfBathroomsTotal || null,
    sqft: item.floorSize?.value ? parseInt(String(item.floorSize.value)) : null,
    neighborhood,
    property_type: inferPropertyType(type),
    url: item.url || "",
    city: "san_francisco",
    status: "active",
    parking: null,
    features: [],
    red_flags: [],
    raw_data: { source: "jsonld", type },
  };
}

function extractListingsFromHomeCards(html: string, neighborhood: string): ScrapedListing[] {
  const listings: ScrapedListing[] = [];
  // Match individual HomeCardContainer div blocks, then extract data within
  const cardRegex = /<div[^>]*class="[^"]*HomeCardContainer[^"]*"[\s\S]{0,3000}?<\/div>\s*<\/div>/g;
  const cards = html.match(cardRegex) || [];

  for (const card of cards) {
    const priceMatch = card.match(/\$([0-9,]+)/);
    const bedMatch = card.match(/(\d+(?:\.\d+)?)\s*Bed/i);
    const bathMatch = card.match(/(\d+(?:\.\d+)?)\s*Bath/i);
    const sqftMatch = card.match(/([\d,]+)\s*Sq\.?\s*Ft/i);
    const urlMatch = card.match(/href="(\/CA\/San-Francisco\/[^"]+)"/);
    const addressMatch = card.match(/(\d+\s+[\w\s.]+(?:St|Ave|Way|Blvd|Dr|Ct|Ter|Ln|Pl|Hwy|Rd)(?:\s+Unit\s+[\w\d]+)?(?:\s+#\d+)?)/);

    if (priceMatch && addressMatch) {
      listings.push({
        address: addressMatch[1].trim(),
        price: parseInt(priceMatch[1].replace(/,/g, "")),
        bedrooms: bedMatch ? parseFloat(bedMatch[1]) : null,
        bathrooms: bathMatch ? parseFloat(bathMatch[1]) : null,
        sqft: sqftMatch ? parseInt(sqftMatch[1].replace(/,/g, "")) : null,
        neighborhood,
        property_type: "condo", // default; can't infer from card
        url: urlMatch ? `https://www.redfin.com${urlMatch[1]}` : "",
        city: "san_francisco",
        status: "active",
        parking: null,
        features: [],
        red_flags: [],
        raw_data: { source: "regex_cards" },
      });
    }
  }

  return listings;
}

function inferPropertyType(type: string): string {
  const lower = String(type).toLowerCase();
  if (lower.includes("single") || lower.includes("house") || lower === "1") return "sfh";
  if (lower.includes("condo") || lower.includes("apartment") || lower === "3") return "condo";
  if (lower.includes("town") || lower === "2") return "condo";
  if (lower.includes("multi") || lower.includes("duplex")) return "duplex";
  if (lower.includes("tic")) return "tic";
  return "sfh";
}
