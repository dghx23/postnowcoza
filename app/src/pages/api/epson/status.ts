import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { parse } from "cookie";
import { getSessionUser } from "@/lib/session";
import { getDeviceInfo, getJobs, EPSON_ACCESS_COOKIE, EPSON_DEVICE_ID_COOKIE } from "@/lib/epson";

// Polled by the print queue / dashboard every ~30s, so this always returns
// 200 with a status payload rather than surfacing HTTP error codes for
// ordinary "not connected yet" states — the caller shouldn't have to treat
// that differently from any other status value.
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
    return res.status(200).json({
      status: "not_connected",
      message: "Not connected to Epson Connect",
      pendingJobs: 0,
      connected: false,
    });
  }

  try {
    const [device, jobs] = await Promise.all([getDeviceInfo(accessToken), getJobs(accessToken)]);
    const pendingJobs = jobs.filter((j) => j.status === "pending" || j.status === "processing").length;
    const connected = device.connected === true;

    let status: "online" | "busy" | "offline" = "offline";
    let message = "Printer offline";
    if (connected) {
      if (pendingJobs > 0) {
        status = "busy";
        message = `${pendingJobs} job${pendingJobs > 1 ? "s" : ""} pending`;
      } else {
        status = "online";
        message = "Ready";
      }
    }

    return res.status(200).json({
      status,
      message,
      pendingJobs,
      connected,
      productName: device.productName ?? "Printer",
      // Everything the Epson API actually returned, unfiltered - the
      // curated fields above only surface a few of these.
      raw: { device, jobs },
    });
  } catch (err) {
    return res.status(200).json({
      status: "unknown",
      message: "Unable to reach printer",
      pendingJobs: 0,
      connected: false,
      raw: axios.isAxiosError(err) ? { error: err.response?.data ?? err.message } : undefined,
    });
  }
}
