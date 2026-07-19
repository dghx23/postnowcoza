import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import {
  isImapConfigured,
  syncEpsonNotifications,
} from "@/lib/epsonNotifications";

/**
 * Pull Epson print outcome emails from the Zoho print-agent mailbox and
 * update EpsonPrintJob + audit trail.
 *
 * Auth: staff/admin session, OR Authorization: Bearer <CRON_SECRET> for
 * Vercel Cron / external schedulers.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization ?? "";
  const bearer =
    authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const isCron =
    Boolean(cronSecret) &&
    (bearer === cronSecret || req.headers["x-cron-secret"] === cronSecret);

  if (!isCron) {
    const user = await getSessionUser(req, res);
    if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  if (!isImapConfigured()) {
    return res.status(503).json({
      error:
        "IMAP not configured — set Zoho_PrintAgent_User and SMTP_PASSWORD (same mailbox as Email Print SMTP)",
      configured: false,
    });
  }

  const includeSeen =
    req.method === "POST" &&
    (req.body?.includeSeen === true || req.query.includeSeen === "1");

  try {
    const result = await syncEpsonNotifications({
      limit: Number(req.query.limit ?? req.body?.limit ?? 30) || 30,
      includeSeen,
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(502).json({
      error: (err as Error).message,
      configured: true,
    });
  }
}
