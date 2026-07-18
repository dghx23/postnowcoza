import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { getPrintProvider, setPrintProvider } from "@/lib/printSettings";

const VALID_PROVIDERS = new Set(["EPSON", "LINUX_AGENT"]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method === "GET") {
    const provider = await getPrintProvider();
    return res.status(200).json({ provider });
  }

  if (req.method === "PATCH") {
    const { provider } = req.body ?? {};
    if (typeof provider !== "string" || !VALID_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: "provider must be EPSON or LINUX_AGENT" });
    }
    const updated = await setPrintProvider(provider as "EPSON" | "LINUX_AGENT");
    return res.status(200).json({ provider: updated });
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}
