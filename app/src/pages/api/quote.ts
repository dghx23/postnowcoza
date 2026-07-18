import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { getRates } from "@/lib/courierguy";
import { FACILITY_ADDRESS, DOCUMENT_PARCEL } from "@/lib/facility";

interface QuoteRequestBody {
  streetAddress: string;
  localArea: string;
  city: string;
  zone: string;
  postalCode: string;
  country?: string;
  weightKg?: number;
}

// Standalone quote lookup for the dashboard "quote tool" - always rates
// from the facility address, since that's the only collection point this
// business dispatches from. Doesn't create a shipment or touch a Document;
// just a Courier Guy rates lookup.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = req.body as Partial<QuoteRequestBody>;
  if (!body.streetAddress || !body.localArea || !body.city || !body.zone || !body.postalCode) {
    return res.status(400).json({ error: "Missing delivery address fields" });
  }

  const deliveryAddress = {
    street_address: body.streetAddress,
    local_area: body.localArea,
    city: body.city,
    zone: body.zone,
    country: body.country ?? "ZA",
    code: body.postalCode,
  };

  const parcel = body.weightKg
    ? { ...DOCUMENT_PARCEL, submitted_weight_kg: body.weightKg }
    : DOCUMENT_PARCEL;

  try {
    const { rates } = await getRates({
      collection_address: FACILITY_ADDRESS,
      delivery_address: deliveryAddress,
      parcels: [parcel],
    });
    return res.status(200).json({ rates });
  } catch (err) {
    return res.status(502).json({ error: (err as Error).message });
  }
}
