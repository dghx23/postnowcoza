import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";

export interface AddressSuggestion {
  displayName: string;
  streetAddress: string;
  localArea: string;
  city: string;
  zone: string;
  postalCode: string;
}

interface NominatimResult {
  display_name: string;
  address?: {
    road?: string;
    house_number?: string;
    suburb?: string;
    neighbourhood?: string;
    city?: string;
    town?: string;
    village?: string;
    county?: string;
    state?: string;
    postcode?: string;
  };
}

// Free, no-API-key geocoder (OpenStreetMap Nominatim). Their usage policy
// requires a real identifying User-Agent and no more than ~1 request/sec -
// fine for staff typing a delivery address, not for bulk lookups. Proxied
// through our own API (rather than called from the browser) so we control
// that header and can add rate limiting later if needed.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { q } = req.query;
  if (typeof q !== "string" || q.trim().length < 3) {
    return res.status(200).json({ suggestions: [] });
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "za");
  url.searchParams.set("limit", "5");
  url.searchParams.set("q", q);

  try {
    const nominatimRes = await fetch(url.toString(), {
      headers: { "User-Agent": "PostNow-Dispatch/1.0 (support@postnow.co.za)" },
    });
    if (!nominatimRes.ok) throw new Error(`Nominatim error ${nominatimRes.status}`);

    const results = (await nominatimRes.json()) as NominatimResult[];
    const suggestions: AddressSuggestion[] = results.map((r) => {
      const a = r.address ?? {};
      const streetAddress = [a.house_number, a.road].filter(Boolean).join(" ");
      return {
        displayName: r.display_name,
        streetAddress: streetAddress || a.road || "",
        localArea: a.suburb ?? a.neighbourhood ?? "",
        city: a.city ?? a.town ?? a.village ?? a.county ?? "",
        zone: a.state ?? "",
        postalCode: a.postcode ?? "",
      };
    });

    return res.status(200).json({ suggestions });
  } catch {
    return res.status(200).json({ suggestions: [] });
  }
}
