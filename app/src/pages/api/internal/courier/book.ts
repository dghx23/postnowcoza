import type { NextApiRequest, NextApiResponse } from "next";
import { requireInternalAuth } from "@/lib/internalAuth";
import { createShipment } from "@/lib/bobgo";

/**
 * Internal, service-to-service proxy to Bob Go's shipment creation — same
 * shared-infra pattern as rates.ts. Returns Bob Go's raw response
 * (tracking_reference, submission_status, etc.) directly to the caller;
 * this app does not create a BobgoShipment row for it, since that table is
 * scoped to this app's own Document chain-of-custody flow. Sibling products
 * (Midl) persist the tracking reference on their own side.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireInternalAuth(req, res)) return;

  const {
    collection_address,
    collection_contact_name,
    collection_contact_mobile_number,
    collection_contact_email,
    delivery_address,
    delivery_contact_name,
    delivery_contact_mobile_number,
    delivery_contact_email,
    parcels,
    provider_slug,
    service_level_code,
    custom_tracking_reference,
    custom_order_number,
    declared_value,
    collection_min_date,
  } = req.body ?? {};

  const required = {
    collection_address,
    collection_contact_name,
    collection_contact_mobile_number,
    collection_contact_email,
    delivery_address,
    delivery_contact_name,
    delivery_contact_mobile_number,
    delivery_contact_email,
    provider_slug,
    service_level_code,
    custom_tracking_reference,
    custom_order_number,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => v === undefined || v === null || v === "")
    .map(([k]) => k);
  if (missing.length > 0 || !Array.isArray(parcels) || parcels.length === 0) {
    return res.status(400).json({
      error: `Missing required field(s): ${[...missing, ...(Array.isArray(parcels) && parcels.length > 0 ? [] : ["parcels"])].join(", ")}`,
    });
  }

  try {
    const result = await createShipment({
      collection_address,
      collection_contact_name,
      collection_contact_mobile_number,
      collection_contact_email,
      delivery_address,
      delivery_contact_name,
      delivery_contact_mobile_number,
      delivery_contact_email,
      parcels,
      provider_slug,
      service_level_code,
      custom_tracking_reference,
      custom_order_number,
      declared_value,
      collection_min_date,
    });
    return res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bob Go shipment creation failed.";
    return res.status(502).json({ error: message });
  }
}
