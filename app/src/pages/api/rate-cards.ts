import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { getRatesForWeight, type RateCardZone } from "@/lib/rateCards";

const ZONES: RateCardZone[] = ["local", "main", "regional"];

// Static Bob Go rate-card lookup - see rateCards.ts. Doesn't call any
// external API, so it works regardless of the live Courier Guy Quote
// Tool's connectivity.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { zone, weight } = req.query;
  if (typeof zone !== "string" || !ZONES.includes(zone as RateCardZone)) {
    return res.status(400).json({ error: `zone must be one of: ${ZONES.join(", ")}` });
  }

  const weightKg = Number(weight);
  if (typeof weight !== "string" || !Number.isFinite(weightKg) || weightKg <= 0) {
    return res.status(400).json({ error: "weight must be a positive number (kg)" });
  }

  const rates = getRatesForWeight(zone as RateCardZone, weightKg);
  return res.status(200).json({ zone, weightKg, rates });
}
