import rateCardData from "./data/bobgo-rate-cards.json";

// Ingested from PostNow's actual Bob Go account (POS052) negotiated rate
// card export, week 2026.33 - static reference pricing across three zone
// tiers and multiple courier partners, used as a fallback quote source
// that doesn't depend on any live third-party API (unlike the Courier Guy
// Quote Tool, which calls their API directly and can fail/be misconfigured
// independently of this data). Not auto-refreshed - re-ingest a fresh
// export if Bob Go's rates change.
export type RateCardZone = "local" | "main" | "regional";

interface RateCardService {
  courier: string;
  code: string;
  prices: Array<number | null>;
}

interface RateCardZoneData {
  weights: number[];
  services: RateCardService[];
}

const DATA = rateCardData as Record<RateCardZone, RateCardZoneData>;

export interface RateCardQuote {
  courier: string;
  code: string;
  price: number;
}

// Courier rate cards price by weight bracket (the price for "1kg" covers
// anything up to 1kg, "2kg" up to 2kg, etc.) - find the smallest bracket
// that's still >= the actual weight, same convention the printed rate
// cards use.
export function getRatesForWeight(zone: RateCardZone, weightKg: number): RateCardQuote[] {
  const zoneData = DATA[zone];
  if (!zoneData) return [];

  let bracketIndex = zoneData.weights.findIndex((w) => w >= weightKg);
  if (bracketIndex === -1) bracketIndex = zoneData.weights.length - 1;

  const quotes: RateCardQuote[] = [];
  for (const service of zoneData.services) {
    const price = service.prices[bracketIndex];
    if (price != null) {
      quotes.push({ courier: service.courier, code: service.code, price });
    }
  }
  return quotes.sort((a, b) => a.price - b.price);
}
