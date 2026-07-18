import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { getPrintSettings, updatePrintSettings } from "@/lib/printSettings";

const VALID_PROVIDERS = new Set(["EPSON", "EPSON_DIRECT"]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method === "GET") {
    const settings = await getPrintSettings();
    return res.status(200).json(settings);
  }

  if (req.method === "PATCH") {
    const { provider, epsonDirectEmail } = req.body ?? {};
    if (provider !== undefined && !VALID_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: "provider must be EPSON or EPSON_DIRECT" });
    }
    if (epsonDirectEmail !== undefined && epsonDirectEmail !== null && typeof epsonDirectEmail !== "string") {
      return res.status(400).json({ error: "epsonDirectEmail must be a string or null" });
    }

    const settings = await updatePrintSettings({
      ...(provider !== undefined ? { provider } : {}),
      ...(epsonDirectEmail !== undefined ? { epsonDirectEmail } : {}),
    });
    return res.status(200).json(settings);
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}
