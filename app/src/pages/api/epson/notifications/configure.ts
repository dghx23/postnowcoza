import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import {
  buildEpsonWebhookCallbackUri,
  getNotificationSettings,
  setNotificationSettings,
} from "@/lib/epson";

/**
 * Staff: read/update Epson Connect notification webhook settings
 * (app-level — applies to jobs submitted with this client_id).
 *
 * POST body: { enabled?: boolean, callbackUri?: string }
 * Omitting callbackUri uses our default /api/epson/webhooks/job URL.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method === "GET") {
    try {
      const current = await getNotificationSettings();
      return res.status(200).json({
        ...current,
        recommendedCallbackUri: buildEpsonWebhookCallbackUri(),
      });
    } catch (err) {
      const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
      console.error("Epson get notification settings failed", {
        status: axiosErr.response?.status,
        data: axiosErr.response?.data,
        message: axiosErr.message,
      });
      return res.status(502).json({
        error: "Could not load Epson notification settings",
        detail: axiosErr.response?.data ?? axiosErr.message,
        recommendedCallbackUri: buildEpsonWebhookCallbackUri(),
      });
    }
  }

  if (req.method === "POST") {
    const body = (req.body ?? {}) as { enabled?: boolean; callbackUri?: string };
    const enabled = body.enabled !== false;
    const callbackUri =
      typeof body.callbackUri === "string" && body.callbackUri.trim()
        ? body.callbackUri.trim()
        : buildEpsonWebhookCallbackUri();

    if (!callbackUri.startsWith("https://")) {
      return res.status(400).json({
        error: "callbackUri must be a public HTTPS URL (Epson will POST job status there)",
      });
    }

    try {
      const updated = await setNotificationSettings({
        notification: enabled,
        callbackUri,
      });
      // Re-read in case Epson echoes a normalized URI
      let current = updated;
      try {
        current = await getNotificationSettings();
      } catch {
        /* use POST response */
      }
      return res.status(200).json({
        ok: true,
        ...current,
        recommendedCallbackUri: buildEpsonWebhookCallbackUri(),
        registeredCallbackUri: callbackUri,
      });
    } catch (err) {
      const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
      console.error("Epson set notification settings failed", {
        status: axiosErr.response?.status,
        data: axiosErr.response?.data,
        message: axiosErr.message,
        callbackUri,
      });
      return res.status(502).json({
        error: "Epson rejected notification settings update",
        detail: axiosErr.response?.data ?? axiosErr.message,
        attemptedCallbackUri: callbackUri,
      });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
