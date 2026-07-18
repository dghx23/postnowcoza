import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getTrackingEvents } from "@/lib/bobgo";

// Live pull from the courier at view time, rather than only relying on
// webhook-delivered updates cached in BobgoShipment.trackingStatus - a
// webhook can lag or be missed, this always reflects what the courier
// says right now.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return res.status(404).json({ error: "Document not found" });

  const isStaff = user.role === "STAFF" || user.role === "ADMIN";
  if (!isStaff && document.ownerId !== user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const shipment = await prisma.bobgoShipment.findFirst({
    where: { documentId: id },
    orderBy: { createdAt: "desc" },
  });

  if (!shipment?.trackingReference) {
    return res.status(404).json({ error: "No courier shipment booked for this document yet" });
  }

  try {
    const live = await getTrackingEvents(shipment.trackingReference);
    return res.status(200).json({
      trackingReference: shipment.trackingReference,
      status: live.status,
      events: live.tracking_events,
    });
  } catch (err) {
    return res.status(502).json({ error: (err as Error).message });
  }
}
