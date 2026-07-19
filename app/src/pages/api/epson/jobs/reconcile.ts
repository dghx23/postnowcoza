import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { reconcilePrintJobs } from "@/lib/printJobReconcile";

/**
 * Staff: cross-match pending platform print submissions with printer feedback
 * (Connect job status API + Zoho mailbox for Email Print).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const result = await reconcilePrintJobs({ forceMailbox: true });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("Print job reconcile failed", (err as Error).message);
    return res.status(502).json({ error: (err as Error).message });
  }
}
