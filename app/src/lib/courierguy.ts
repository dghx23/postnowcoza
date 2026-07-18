// The Courier Guy's direct API (api-tcg.co.za) is built on the Shiplogic
// platform - the same lineage as Bob Go (src/lib/bobgo.ts), confirmed via
// search ("Ship Logic API documentation... also manages The Courier Guy
// integrations"). That's why the request shape below mirrors bobgo.ts
// closely (collection_address/delivery_address/parcels). Verified via web
// search on 2026-07-18 (Epson-style: their docs sites block automated
// fetches, so this is search-engine-indexed content, not a primary-source
// read): production base URL, and that the API is Shiplogic-based. NOT
// independently confirmed: whether the API key goes in an Authorization
// header vs a query parameter (implemented as a Bearer header, matching
// Bob Go's convention, since search results only said "authentication is
// via an api_key parameter" without specifying placement) - confirm
// against a real response before relying on this.
const BASE_URL = process.env.COURIER_GUY_BASE_URL ?? "https://api-tcg.co.za";
const API_KEY = process.env.COURIER_GUY_API ?? "";

interface CourierGuyAddress {
  company?: string;
  street_address: string;
  local_area: string;
  city: string;
  zone: string;
  country: string;
  code: string;
}

interface CourierGuyParcel {
  submitted_length_cm: number;
  submitted_width_cm: number;
  submitted_height_cm: number;
  submitted_weight_kg: number;
}

export interface CourierGuyRate {
  service_level_code?: string;
  service_name?: string;
  total_price?: number;
  [key: string]: unknown;
}

async function courierGuyFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Courier Guy API error ${res.status} on ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// Door-to-door rates only (the "D2D" variant) - the quote tool doesn't
// support locker collection/delivery points.
export function getRates(input: {
  collection_address: CourierGuyAddress;
  delivery_address: CourierGuyAddress;
  parcels: CourierGuyParcel[];
  declared_value?: number;
}): Promise<{ rates: CourierGuyRate[] }> {
  return courierGuyFetch("/rates", { method: "POST", body: JSON.stringify(input) });
}
