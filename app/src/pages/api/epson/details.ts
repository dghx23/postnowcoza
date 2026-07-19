import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { parse } from "cookie";
import { getSessionUser } from "@/lib/session";
import {
  getDeviceInfo,
  getDefaultPrintSettings,
  getPrintCapability,
  getNotificationSettings,
  getValidDeviceSession,
  isDeviceOnline,
  EPSON_ACCESS_COOKIE,
  EPSON_REFRESH_COOKIE,
} from "@/lib/epson";

// Snapshot of everything Epson reports about the linked printer.
// `authorized` = OAuth tokens present; `deviceOnline` = printer network online.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const cookies = parse(req.headers.cookie ?? "");
  const session = await getValidDeviceSession({
    accessToken: cookies[EPSON_ACCESS_COOKIE],
    refreshToken: cookies[EPSON_REFRESH_COOKIE],
  });

  if (!session?.accessToken) {
    return res.status(200).json({ connected: false, authorized: false, deviceOnline: false });
  }

  try {
    const accessToken = session.accessToken;
    // Document mode only — we don't print photos via this hub.
    const [device, defaults, documentCapability, notification] = await Promise.all([
      getDeviceInfo(accessToken),
      getDefaultPrintSettings(accessToken),
      getPrintCapability(accessToken, "document"),
      getNotificationSettings().catch(() => null),
    ]);

    const deviceOnline = isDeviceOnline(device);

    return res.status(200).json({
      // authorized + device payload loaded successfully
      connected: true,
      authorized: true,
      deviceOnline,
      device,
      defaults,
      capability: { document: documentCapability },
      notification,
    });
  } catch (err) {
    const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
    console.error("Epson details fetch failed", {
      status: axiosErr.response?.status,
      data: axiosErr.response?.data,
      message: axiosErr.message,
    });
    return res.status(axios.isAxiosError(err) ? 502 : 500).json({
      error: "Could not load printer details from Epson Connect",
      authorized: true,
      connected: false,
      deviceOnline: false,
    });
  }
}
