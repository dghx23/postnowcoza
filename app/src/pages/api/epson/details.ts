import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { parse } from "cookie";
import { getSessionUser } from "@/lib/session";
import {
  getDeviceInfo,
  getDefaultPrintSettings,
  getPrintCapability,
  getNotificationSettings,
  EPSON_ACCESS_COOKIE,
  EPSON_DEVICE_ID_COOKIE,
} from "@/lib/epson";

// Everything the Epson Connect API can report about the connected printer,
// beyond the online/busy/offline summary in status.ts - device identity,
// its current default print settings, its full print capability matrix for
// both document and photo modes (every paper size/type/source/quality/
// duplex combination it supports), and its webhook notification config.
// This is a snapshot fetched on demand (not polled), since none of it
// changes moment to moment the way job/pending-count status does.
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
  const accessToken = cookies[EPSON_ACCESS_COOKIE];
  const deviceId = cookies[EPSON_DEVICE_ID_COOKIE];

  if (!accessToken || !deviceId) {
    return res.status(200).json({ connected: false });
  }

  try {
    const [device, defaults, documentCapability, photoCapability, notification] = await Promise.all([
      getDeviceInfo(accessToken),
      getDefaultPrintSettings(accessToken),
      getPrintCapability(accessToken, "document"),
      getPrintCapability(accessToken, "photo"),
      getNotificationSettings(accessToken),
    ]);

    return res.status(200).json({
      connected: true,
      device,
      defaults,
      capability: { document: documentCapability, photo: photoCapability },
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
    });
  }
}
