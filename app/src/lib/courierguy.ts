// The Courier Guy's own official Postman collection (uploaded 2026-07-18)
// confirms this API is built on the Shiplogic platform - same lineage as
// Bob Go (src/lib/bobgo.ts), which is why the request shape below mirrors
// bobgo.ts closely. Confirmed directly from that collection: base URL
// https://api.portal.thecourierguy.co.za (an earlier guess of api-tcg.co.za
// was wrong - real requests to it 404'd), Bearer token auth exactly like
// Bob Go ("Authorization": "Bearer <token>", per their Authentication
// section), and the /rates endpoint + collection_address/delivery_address/
// parcels shape.
const BASE_URL = process.env.COURIER_GUY_BASE_URL ?? "https://api.portal.thecourierguy.co.za";
const API_KEY = process.env.COURIER_GUY_API ?? "";

interface CourierGuyAddress {
  company?: string;
  type?: "residential" | "business" | "counter" | "locker";
  street_address: string;
  local_area: string;
  city: string;
  zone: string;
  country: string;
  code: string;
  lat?: number;
  lng?: number;
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
    // Never log API_KEY itself - only whether it's present, to diagnose an
    // empty/missing env var vs. a genuinely rejected key without leaking it.
    console.error("Courier Guy API request failed", {
      status: res.status,
      path,
      baseUrl: BASE_URL,
      apiKeyPresent: API_KEY.length > 0,
      apiKeyLength: API_KEY.length,
      body,
    });
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
