import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import {
  imapConfigDiag,
  isImapConfigured,
  syncEpsonNotifications,
} from "@/lib/epsonNotifications";

// IMAP round-trips can exceed the default serverless budget on cold starts.
export const config = {
  maxDuration: 60,
};

/**
 * Pull Epson print outcome emails from the Zoho print-agent mailbox and
 * update EpsonPrintJob + audit trail.
 *
 * Auth: staff/admin session, OR Authorization: Bearer <CRON_SECRET> for
 * Vercel Cron / external schedulers.
 *
 * Query: ?includeSeen=1 to re-scan recent read mail (backfill).
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
        "IMAP not configured — set Zoho_PrintAgent_User and SMTP_PASSWORD in Vercel (same mailbox as Email Print SMTP). Values are trimmed of whitespace.",
      configured: false,
      diag: imapConfigDiag(),
    });
  }

  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const includeSeen =
    body.includeSeen === true ||
    req.query.includeSeen === "1" ||
    req.query.includeSeen === "true";

  try {
    const result = await syncEpsonNotifications({
      limit: Number(req.query.limit ?? body.limit ?? 40) || 40,
      includeSeen,
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(502).json({
      error: (err as Error).message,
      configured: true,
      diag: imapConfigDiag(),
    });
  }
}
