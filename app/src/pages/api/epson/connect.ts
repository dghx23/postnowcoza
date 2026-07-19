import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { buildAuthorizeUrl, epsonCredentialsConfigured } from "@/lib/epson";

// Staff click-through to start Epson Connect device OAuth.
// GET /api/epson/connect → 302 to auth.epsonconnect.com/auth/authorize
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.redirect(302, "/login");
  }

  if (!epsonCredentialsConfigured()) {
    return res.redirect(302, "/printer?epson=error&reason=missing_credentials");
  }

  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  return res.redirect(302, buildAuthorizeUrl(state));
}
