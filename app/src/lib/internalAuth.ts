import type { NextApiRequest, NextApiResponse } from "next";

/**
 * Service-to-service auth for /api/internal/* routes — sibling PostNow
 * Group products (Midl today) calling into this app's shared infra
 * (Bob Go courier credentials) without a user session. Not for
 * browser/customer traffic.
 *
 * Checks the `X-Internal-Secret` header against INTERNAL_API_SECRET.
 * Returns true and writes a 401 response if the check fails, so callers can
 * just `if (!requireInternalAuth(req, res)) return;`.
 */
export function requireInternalAuth(req: NextApiRequest, res: NextApiResponse): boolean {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) {
    res.status(501).json({ error: "INTERNAL_API_SECRET is not configured." });
    return false;
  }

  const provided = req.headers["x-internal-secret"];
  if (provided !== expected) {
    res.status(401).json({ error: "Invalid or missing X-Internal-Secret header." });
    return false;
  }

  return true;
}
