import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { dispatchDocument } from "@/lib/dispatch";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  try {
    const shipment = await dispatchDocument(id, user.id);
    return res.status(201).json(shipment);
  } catch (err) {
    return res.status(422).json({ error: (err as Error).message });
  }
}
