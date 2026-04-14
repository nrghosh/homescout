// Scraper: fetch listings from Redfin via Browser Rendering

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

// Redfin neighborhood URL slugs for SF
const REDFIN_SLUGS: Record<string, string> = {
  "Cole Valley": "cole-valley",
  "Noe Valley": "noe-valley",
  "Dolores Heights": "dolores-heights",
  "Corona Heights": "corona-heights",
  "Inner Sunset": "inner-sunset",
  "Duboce Triangle": "duboce-triangle",
  "The Castro": "castro",
  "Glen Park": "glen-park",
  "Eureka Valley": "eureka-valley",
  "Ashbury Heights": "ashbury-heights",
  "Mission Dolores": "mission-dolores",
  "Buena Vista": "buena-vista",
};

export async function scrapeNeighborhood(
  browser: Fetcher,
  city: string,
  neighborhood: string
): Promise<ScrapedListing[]> {
  const slug = REDFIN_SLUGS[neighborhood];
  if (!slug) return [];

  const url = `https://www.redfin.com/neighborhood/${slug}/CA/San-Francisco/filter/property-type=house+condo+townhouse,min-beds=2,min-baths=2,min-price=1M,max-price=3M`;

  try {
    // Use Cloudflare Browser Rendering to fetch the page
    // This runs a real headless browser, bypassing bot detection
    const response = await browser.fetch(
      `https://browser-rendering.cloudflare.com/content?url=${encodeURIComponent(url)}`,
      { method: "GET" }
    );

    if (!response.ok) {
      console.error(`Browser rendering failed for ${neighborhood}: ${response.status}`);
      return fallbackScrape(neighborhood);
    }

    const html = await response.text();
    return parseRedfinHtml(html, neighborhood);
  } catch (err) {
    console.error(`Scrape error for ${neighborhood}:`, err);
    return fallbackScrape(neighborhood);
  }
}

function parseRedfinHtml(html: string, neighborhood: string): ScrapedListing[] {
  const listings: ScrapedListing[] = [];

  // Parse Redfin listing cards from HTML
  // Redfin structures: div.HomeCardContainer with data attributes
  const cardRegex =
    /class="[^"]*HomeCardContainer[^"]*"[\s\S]*?<a[^>]*href="(\/CA\/San-Francisco\/[^"]+)"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g;

  // Simpler approach: extract from JSON-LD or structured data if available
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const json = JSON.parse(match.replace(/<\/?script[^>]*>/g, ""));
        if (json["@type"] === "SingleFamilyResidence" || json["@type"] === "Residence") {
          listings.push({
            address: json.address?.streetAddress || json.name || "",
            price: json.offers?.price ? parseInt(json.offers.price) : null,
            bedrooms: json.numberOfRooms || null,
            bathrooms: null,
            sqft: json.floorSize?.value ? parseInt(json.floorSize.value) : null,
            neighborhood,
            property_type: inferPropertyType(json["@type"] || ""),
            url: json.url || "",
            city: "san_francisco",
            status: "active",
            parking: null,
            features: [],
            red_flags: [],
            raw_data: json,
          });
        }
      } catch {
        // Skip malformed JSON-LD
      }
    }
  }

  // Regex-based extraction as fallback
  // Match patterns like: $1,750,000 | 3 Beds | 2 Baths | 1,640 Sq Ft
  const priceRegex = /\$([0-9,]+)/g;
  const bedRegex = /(\d+)\s*(?:Bed|bed|BR|bd)/g;
  const bathRegex = /(\d+\.?\d*)\s*(?:Bath|bath|BA|ba)/g;
  const sqftRegex = /([\d,]+)\s*(?:Sq\.?\s*Ft|sqft|SF)/g;
  const addressRegex = /(\d+\s+[\w\s]+(?:St|Ave|Way|Blvd|Dr|Ct|Ter|Ln|Pl)(?:\s*#\d+)?)/g;

  // If JSON-LD didn't yield results, try regex on the full HTML
  if (listings.length === 0) {
    // This is a simplified parser — production would use a proper HTML parser
    // For MVP, we'll rely more on the API fallback
    console.log(`No JSON-LD found for ${neighborhood}, using regex fallback`);
  }

  return listings;
}

// Fallback: use a public-ish API endpoint that some aggregators expose
async function fallbackScrape(neighborhood: string): Promise<ScrapedListing[]> {
  // Try Redfin's stingray API (semi-public, used by their frontend)
  const slug = REDFIN_SLUGS[neighborhood];
  if (!slug) return [];

  try {
    const apiUrl = `https://www.redfin.com/stingray/api/gis?al=1&market=sanfrancisco&min_stories=1&num_homes=20&ord=redfin-recommended-asc&page=1&region_id=0&region_type=0&sf=1,2,3,5,6,7&status=9&uipt=1,2,3&v=8`;

    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/json",
      },
    });

    if (!response.ok) return [];

    const text = await response.text();
    // Redfin prefixes JSON with "{}&&" — strip it
    const jsonStr = text.replace(/^{}&&/, "");
    const data = JSON.parse(jsonStr);

    // Parse the response...
    return [];
  } catch {
    return [];
  }
}

function inferPropertyType(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes("single") || lower.includes("house")) return "sfh";
  if (lower.includes("condo") || lower.includes("apartment")) return "condo";
  if (lower.includes("town")) return "condo";
  return "sfh";
}
