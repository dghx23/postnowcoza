import type { NextApiRequest, NextApiResponse } from "next";
import { serialize } from "cookie";
import { getSessionUser } from "@/lib/session";
import {
  exchangeCodeForTokens,
  saveDeviceTokens,
  describeCredentialHealth,
  epsonCookieOptions,
  epsonRefreshCookieOptions,
  setNotificationSettings,
  buildEpsonWebhookCallbackUri,
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

  const { code, error, error_description } = req.query;
  if (error || typeof code !== "string") {
    console.error("Epson OAuth callback: provider returned an error", {
      error,
      error_description,
    });
    return res.redirect(302, "/printer?epson=error");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.access_token) {
      console.error("Epson OAuth callback: token response had no access_token", {
        keys: Object.keys(tokens ?? {}),
      });
      return res.redirect(302, "/printer?epson=error");
    }

    // Source of truth: DB (shared across staff). Cookies kept as a browser
    // cache so older clients still see a "connected" cookie if they look.
    await saveDeviceTokens(tokens);

    // Always-on job webhooks: Epson POSTs print outcomes into PostNow.
    try {
      await setNotificationSettings({
        notification: true,
        callbackUri: buildEpsonWebhookCallbackUri(),
      });
    } catch (notifErr) {
      console.error("Epson OAuth callback: auto-enable webhooks failed (non-fatal)", {
        message: (notifErr as Error).message,
      });
    }

    const cookieParts = [
      serialize(EPSON_ACCESS_COOKIE, tokens.access_token, epsonCookieOptions(tokens.expires_in ?? 3600)),
    ];
    if (tokens.refresh_token) {
      cookieParts.push(
        serialize(EPSON_REFRESH_COOKIE, tokens.refresh_token, epsonRefreshCookieOptions())
      );
    }
    // Official token response has no subject_id; device is bound to the token.
    // Keep a present marker so any remaining cookie-only checks pass.
    cookieParts.push(
      serialize(EPSON_DEVICE_ID_COOKIE, tokens.subject_id ?? "device", epsonRefreshCookieOptions())
    );
    res.setHeader("Set-Cookie", cookieParts);

    return res.redirect(302, "/printer?epson=connected");
  } catch (err) {
    const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
    console.error("Epson OAuth callback: token exchange failed", {
      status: axiosErr.response?.status,
      data: axiosErr.response?.data,
      message: axiosErr.message,
      ...describeCredentialHealth(),
    });
    return res.redirect(302, "/printer?epson=error");
  }
}
