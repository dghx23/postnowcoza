import type { NextApiRequest, NextApiResponse } from "next";
import { serialize } from "cookie";
import { getSessionUser } from "@/lib/session";
import {
  exchangeCodeForTokens,
  epsonCookieOptions,
  epsonRefreshCookieOptions,
  EPSON_ACCESS_COOKIE,
  EPSON_REFRESH_COOKIE,
} from "@/lib/epson";

// Redirect target for Epson's OAuth flow (EPSON_REDIRECT_URI in Vercel must
// point here: https://app.postnow.co.za/api/epson/callback). Only staff/admin
// can complete this — the session cookie survives the round trip since it's
// a same-site top-level navigation.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.redirect(302, "/login");
  }

  const { code, error } = req.query;
  if (error || typeof code !== "string") {
    return res.redirect(302, "/print-queue?epson=error");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);

    res.setHeader("Set-Cookie", [
      serialize(EPSON_ACCESS_COOKIE, tokens.access_token, epsonCookieOptions(tokens.expires_in ?? 3600)),
      serialize(EPSON_REFRESH_COOKIE, tokens.refresh_token, epsonRefreshCookieOptions()),
    ]);

    return res.redirect(302, "/print-queue?epson=connected");
  } catch {
    return res.redirect(302, "/print-queue?epson=error");
  }
}
