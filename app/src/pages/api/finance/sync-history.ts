import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { prisma } from "@/lib/db";

const ZOHO_SYNC_ACTIONS = ["zoho_books_synced", "zoho_books_sync_failed", "zoho_books_paid_inbound"];

/**
 * GET — recent Zoho Books push/pull events across all documents, for the
 * Finance Mapping page's "sync history" table. Reads the same AuditEvent
 * rows zohoBooksSync.ts already appends on every push/pull attempt.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const events = await prisma.auditEvent.findMany({
    where: { action: { in: ZOHO_SYNC_ACTIONS } },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { document: { select: { id: true, recipientName: true } } },
  });

  return res.status(200).json({
    events: events.map((e) => ({
      id: e.id,
      action: e.action,
      createdAt: e.createdAt.toISOString(),
      documentId: e.documentId,
      recipientName: e.document.recipientName,
      metadata: e.metadata,
    })),
  });
}
