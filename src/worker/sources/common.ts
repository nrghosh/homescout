// Shared types and helpers for all sources

export type ListingStatus = "active" | "pending" | "sold" | "withdrawn" | "coming_soon" | "unknown";
export type PropertyType = "sfh" | "condo" | "tic" | "duplex" | "townhouse";

export interface ListingData {
  address?: string;
  price?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  sqft?: number | null;
  lot_sqft?: number | null;
  property_type?: PropertyType;
  status?: ListingStatus;
  listing_date?: string;
  parking?: boolean | null;
  features?: string[];
  red_flags?: string[];
  url?: string;
  price_history?: Array<{ date: string; price: number }>;
  open_houses?: Array<{ start: string; end?: string }>;
}

export interface SourceResult {
  data: Partial<ListingData>;
  source: string;
  fetched_at: string;
  confidence: "high" | "medium" | "low";
}

export interface Source {
  name: string;
  priority: number; // 1 = highest (most trusted)
  reliability: "high" | "medium" | "low";
  // Does this URL belong to this source?
  handlesUrl(url: string): boolean;
  // Fetch and extract from a specific listing URL
  fetchDetail(url: string): Promise<SourceResult | null>;
  // Optional: build a search URL from an address, used for fallback lookups
  searchByAddress?(address: string): Promise<{ url: string } | null>;
}

const DEFAULT_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

export async function fetchHtml(url: string, cacheTtl = 1800): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: DEFAULT_HEADERS,
      cf: { cacheTtl },
    } as any);

    if (!r.ok) return null;
    const text = await r.text();
    if (text.length < 2000) return null;

    // Only flag as blocked if title explicitly says so
    const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
    if (titleMatch && /access\s*denied|403\s*forbidden|\brobot\b|cloudflare/i.test(titleMatch[1])) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

// Extract listing price/beds/baths from description strings, as fallback
export function extractFromText(text: string): Partial<ListingData> {
  const result: Partial<ListingData> = {};
  const priceMatch = text.match(/\$([0-9,]+(?:\.\d{1,2})?)\s*(?:M|million)?/i);
  if (priceMatch) {
    let p = parseFloat(priceMatch[1].replace(/,/g, ""));
    if (/m|million/i.test(priceMatch[0])) p *= 1_000_000;
    if (p > 100_000 && p < 20_000_000) result.price = Math.round(p);
  }
  const bedMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:bed|bd|br|bedroom)/i);
  if (bedMatch) result.bedrooms = parseFloat(bedMatch[1]);
  const bathMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:bath|ba|bathroom)/i);
  if (bathMatch) result.bathrooms = parseFloat(bathMatch[1]);
  const sqftMatch = text.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft|square\s*feet)/i);
  if (sqftMatch) result.sqft = parseInt(sqftMatch[1].replace(/,/g, ""));
  return result;
}

// Parse JSON-LD blocks from HTML and return all items
export function parseJsonLdBlocks(html: string): any[] {
  const blocks: any[] = [];
  const matches = html.matchAll(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1]);
      if (Array.isArray(parsed)) {
        blocks.push(...parsed);
      } else {
        blocks.push(parsed);
        if (parsed["@graph"] && Array.isArray(parsed["@graph"])) {
          blocks.push(...parsed["@graph"]);
        }
      }
    } catch {}
  }
  return blocks;
}

// Normalize status strings from various sources
export function normalizeStatus(raw: string | undefined): ListingStatus {
  if (!raw) return "unknown";
  const s = raw.toLowerCase();
  if (/active|for\s*sale/.test(s)) return "active";
  if (/pending|contingent|under\s*contract/.test(s)) return "pending";
  if (/sold|closed/.test(s)) return "sold";
  if (/withdrawn|removed|off\s*market|canceled/.test(s)) return "withdrawn";
  if (/coming\s*soon/.test(s)) return "coming_soon";
  return "unknown";
}
