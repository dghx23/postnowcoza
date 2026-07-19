import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { detectShareChannel, shareBooking, subscribeToUpdates } from "@/lib/documentSharing";

/**
 * POST /api/documents/[id]/share
 * Body: { destination: string, subscribe?: boolean }
 * Sends this document's tracking link to someone else right now, and
 * optionally opts them in to future status-update notifications.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return res.status(404).json({ error: "Document not found" });

  const isOwner = document.ownerId === user.id;
  const isStaff = user.role === "STAFF" || user.role === "ADMIN";
  if (!isOwner && !isStaff) return res.status(403).json({ error: "Forbidden" });

  const body = (req.body ?? {}) as { destination?: string; subscribe?: boolean };
  const destination = (body.destination ?? "").trim();
  if (!destination) return res.status(400).json({ error: "Enter an email address or WhatsApp number" });

  const channel = detectShareChannel(destination);
  if (!channel) {
    return res.status(400).json({ error: "That doesn't look like a valid email address or WhatsApp number" });
  }

  const ip = req.socket.remoteAddress ?? undefined;

  try {
    await shareBooking({
      documentId: document.id,
      destination,
      channel,
      recipientName: document.recipientName,
      actorId: user.id,
      ip,
    });
  } catch (err) {
    return res.status(502).json({ error: (err as Error).message || "Failed to send" });
  }

  if (body.subscribe) {
    await subscribeToUpdates({ documentId: document.id, destination, channel, actorId: user.id, ip });
  }

  return res.status(200).json({ ok: true, channel, subscribed: Boolean(body.subscribe) });
}
