import type { NextApiRequest, NextApiResponse } from "next";
import { serialize } from "cookie";
import { getSessionUser } from "@/lib/session";
import {
  exchangeCodeForTokens,
  epsonCookieOptions,
  epsonRefreshCookieOptions,
  EPSON_ACCESS_COOKIE,
  EPSON_REFRESH_COOKIE,
  EPSON_DEVICE_ID_COOKIE,
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
    console.error("Epson OAuth callback: provider returned an error", { error });
    return res.redirect(302, "/print-queue?epson=error");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.subject_id) {
      console.error("Epson OAuth callback: token response had no subject_id", {
        keys: Object.keys(tokens ?? {}),
      });
      return res.redirect(302, "/print-queue?epson=error");
    }

    res.setHeader("Set-Cookie", [
      serialize(EPSON_ACCESS_COOKIE, tokens.access_token, epsonCookieOptions(tokens.expires_in ?? 3600)),
      serialize(EPSON_REFRESH_COOKIE, tokens.refresh_token, epsonRefreshCookieOptions()),
      serialize(EPSON_DEVICE_ID_COOKIE, tokens.subject_id, epsonRefreshCookieOptions()),
    ]);

    return res.redirect(302, "/print-queue?epson=connected");
  } catch (err) {
    const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
    // client_id/client_secret aren't logged, only their lengths and whether
    // they have leading/trailing whitespace - we've twice now found env vars
    // corrupted by a stray copy-paste character (R2 secret, Courier Guy
    // key), so ruling that out here directly instead of guessing again.
    const clientId = process.env.EPSON_CLIENT_ID ?? "";
    const clientSecret = process.env.EPSON_CLIENT_SECRET ?? "";
    const redirectUri = process.env.EPSON_REDIRECT_URI ?? "";
    console.error("Epson OAuth callback: token exchange failed", {
      status: axiosErr.response?.status,
      data: axiosErr.response?.data,
      message: axiosErr.message,
      clientIdLength: clientId.length,
      clientIdHasWhitespace: clientId !== clientId.trim(),
      clientSecretLength: clientSecret.length,
      clientSecretHasWhitespace: clientSecret !== clientSecret.trim(),
      redirectUri,
    });
    return res.redirect(302, "/print-queue?epson=error");
  }
}
