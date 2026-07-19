import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import {
  countOpenSyncExceptions,
  listOpenSyncExceptions,
  resolveSyncException,
} from "@/lib/syncExceptions";
import { prisma } from "@/lib/db";

/**
 * GET  — open (or all recent) sync exceptions for the settings panel
 * POST — { id, resolve: true } mark resolved
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method === "GET") {
    const includeResolved = req.query.all === "1" || req.query.all === "true";
    const rows = includeResolved
      ? await prisma.syncException.findMany({
          orderBy: { createdAt: "desc" },
          take: 60,
        })
      : await listOpenSyncExceptions(40);
    const openCount = await countOpenSyncExceptions();
    return res.status(200).json({ openCount, exceptions: rows });
  }

  if (req.method === "POST") {
    const body = (req.body ?? {}) as { id?: string; resolve?: boolean };
    if (!body.id || !body.resolve) {
      return res.status(400).json({ error: "Provide { id, resolve: true }" });
    }
    const updated = await resolveSyncException(body.id);
    return res.status(200).json({ ok: true, exception: updated });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
