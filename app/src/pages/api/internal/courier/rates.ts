import type { NextApiRequest, NextApiResponse } from "next";
import { requireInternalAuth } from "@/lib/internalAuth";
import { getRates } from "@/lib/bobgo";

/**
 * Internal, service-to-service proxy to Bob Go's rate lookup — lets sibling
 * PostNow Group products (Midl today) get real courier quotes using this
 * app's Bob Go credentials, without needing their own account or knowing
 * anything about this app's Document/BobgoShipment tables.
 *
 * Stateless: no DB write here. The caller is responsible for persisting
 * whatever it needs on its own side (e.g. Midl's Deal), keeping each
 * product's data independent even while sharing the courier integration.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!requireInternalAuth(req, res)) return;

  const { collection_address, delivery_address, parcels, declared_value } = req.body ?? {};
  if (!collection_address || !delivery_address || !Array.isArray(parcels) || parcels.length === 0) {
    return res.status(400).json({
      error: "collection_address, delivery_address and a non-empty parcels array are required.",
    });
  }

  try {
    const result = await getRates({ collection_address, delivery_address, parcels, declared_value });
    return res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bob Go rate lookup failed.";
    return res.status(502).json({ error: message });
  }
}
