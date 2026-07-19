const BASE_URL = process.env.BOBGO_BASE_URL ?? "https://api.sandbox.bobgo.co.za/v2";
const API_TOKEN = process.env.BOBGO_API_TOKEN ?? "";

interface BobgoAddress {
  company?: string;
  street_address: string;
  local_area: string;
  city: string;
  zone: string;
  country: string;
  code: string;
}

interface BobgoParcel {
  description: string;
  submitted_length_cm: number;
  submitted_width_cm: number;
  submitted_height_cm: number;
  submitted_weight_kg: number;
  custom_parcel_reference?: string;
}

interface RateOption {
  id: number;
  provider_slug: string;
  service_level_code: string;
  service_name: string;
  total_price: number;
}

async function bobgoFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_TOKEN}`,
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bob Go API error ${res.status} on ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

export function getRates(input: {
  collection_address: BobgoAddress;
  delivery_address: BobgoAddress;
  parcels: BobgoParcel[];
  declared_value?: number;
}): Promise<{ rates: RateOption[] }> {
  return bobgoFetch("/rates", { method: "POST", body: JSON.stringify(input) });
}

export function createShipment(input: {
  collection_address: BobgoAddress;
  collection_contact_name: string;
  collection_contact_mobile_number: string;
  collection_contact_email: string;
  delivery_address: BobgoAddress;
  delivery_contact_name: string;
  delivery_contact_mobile_number: string;
  delivery_contact_email: string;
  parcels: BobgoParcel[];
  provider_slug: string;
  service_level_code: string;
  custom_tracking_reference: string;
  custom_order_number: string;
  declared_value?: number;
  /** Preferred earliest collection date YYYY-MM-DD (e.g. next-day booking). */
  collection_min_date?: string;
}) {
  return bobgoFetch<{
    id: number;
    tracking_reference: string;
    submission_status: string;
    failed_reason: string | null;
  }>("/shipments", { method: "POST", body: JSON.stringify(input) });
}

export function createOrder(input: {
  channel_order_number: string;
  customer_name: string;
  customer_surname: string;
  customer_email: string;
  customer_phone: string;
  currency: string;
  delivery_address: BobgoAddress;
  order_items: Array<{
    description: string;
    sku: string;
    unit_price: number;
    qty: number;
    unit_weight_kg: number;
  }>;
  payment_status: string;
}) {
  return bobgoFetch<{ id: number }>("/orders", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function createReturn(input: {
  order_id: number;
  parcels: BobgoParcel[];
  delivery_address: BobgoAddress;
  collection_address: BobgoAddress;
  collection_contact_name: string;
  collection_contact_email: string;
  collection_contact_mobile_number: string;
  delivery_contact_name: string;
  delivery_contact_email: string;
  delivery_contact_mobile_number: string;
  collection_min_date: string;
  provider_slug: string;
  service_level_code: string;
  instructions_collection?: string;
  instructions_delivery?: string;
  declared_value?: number | null;
}) {
  return bobgoFetch<{
    id: number;
    tracking_reference: string;
    submission_status: string;
    failed_reason: string | null;
  }>("/orders/return", { method: "POST", body: JSON.stringify(input) });
}

export function getWaybill(trackingReferences: string[]) {
  const query = encodeURIComponent(JSON.stringify(trackingReferences));
  return bobgoFetch<{ url: string }>(`/shipments/waybill?tracking_references=${query}`);
}

export function getPOD(trackingReference: string) {
  return bobgoFetch<{ url: string }>(
    `/shipments/pod?tracking_reference=${encodeURIComponent(trackingReference)}`
  );
}

export function cancelShipment(trackingReference: string) {
  return bobgoFetch<{ success: boolean }>("/shipments/cancel", {
    method: "POST",
    body: JSON.stringify({ tracking_reference: trackingReference }),
  });
}

export interface TrackingCheckpoint {
  date: string;
  status: string;
  location?: string;
  message?: string;
}

export function getTrackingEvents(trackingReference: string) {
  return bobgoFetch<{ status: string; tracking_events: TrackingCheckpoint[] }>(
    `/tracking?tracking_reference=${encodeURIComponent(trackingReference)}`
  );
}
