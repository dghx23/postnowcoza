import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { getPrintSettings, updatePrintSettings } from "@/lib/printSettings";
import {
  PAPER_SIZES,
  PAPER_TYPES,
  PRINT_QUALITIES,
  PAPER_SOURCES,
  DOUBLE_SIDED,
} from "@/lib/printJobSettings";

const VALID_PROVIDERS = new Set(["EPSON", "EPSON_DIRECT"]);
const SIZE_SET = new Set(PAPER_SIZES.map((p) => p.value));
const TYPE_SET = new Set(PAPER_TYPES.map((p) => p.value));
const QUALITY_SET = new Set(PRINT_QUALITIES.map((p) => p.value));
const SOURCE_SET = new Set(PAPER_SOURCES.map((p) => p.value));
const DUPLEX_SET = new Set(DOUBLE_SIDED.map((p) => p.value));

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
    const body = req.body ?? {};
    const { provider, epsonDirectEmail } = body;
    if (provider !== undefined && !VALID_PROVIDERS.has(provider)) {
      return res.status(400).json({ error: "provider must be EPSON or EPSON_DIRECT" });
    }
    if (epsonDirectEmail !== undefined && epsonDirectEmail !== null && typeof epsonDirectEmail !== "string") {
      return res.status(400).json({ error: "epsonDirectEmail must be a string or null" });
    }
    if (body.printPaperSize !== undefined && !SIZE_SET.has(body.printPaperSize)) {
      return res.status(400).json({ error: "Invalid printPaperSize" });
    }
    if (body.printPaperType !== undefined && !TYPE_SET.has(body.printPaperType)) {
      return res.status(400).json({ error: "Invalid printPaperType" });
    }
    if (body.printQuality !== undefined && !QUALITY_SET.has(body.printQuality)) {
      return res.status(400).json({ error: "Invalid printQuality" });
    }
    if (body.printPaperSource !== undefined && !SOURCE_SET.has(body.printPaperSource)) {
      return res.status(400).json({ error: "Invalid printPaperSource" });
    }
    if (body.printDoubleSided !== undefined && !DUPLEX_SET.has(body.printDoubleSided)) {
      return res.status(400).json({ error: "Invalid printDoubleSided" });
    }
    if (body.printBorderless !== undefined && typeof body.printBorderless !== "boolean") {
      return res.status(400).json({ error: "printBorderless must be boolean" });
    }

    const settings = await updatePrintSettings({
      ...(provider !== undefined ? { provider } : {}),
      ...(epsonDirectEmail !== undefined ? { epsonDirectEmail } : {}),
      ...(body.printPaperSize !== undefined ? { printPaperSize: body.printPaperSize } : {}),
      ...(body.printPaperType !== undefined ? { printPaperType: body.printPaperType } : {}),
      ...(body.printQuality !== undefined ? { printQuality: body.printQuality } : {}),
      ...(body.printPaperSource !== undefined ? { printPaperSource: body.printPaperSource } : {}),
      ...(body.printBorderless !== undefined ? { printBorderless: body.printBorderless } : {}),
      ...(body.printDoubleSided !== undefined ? { printDoubleSided: body.printDoubleSided } : {}),
    });
    return res.status(200).json(settings);
  }

  res.setHeader("Allow", "GET, PATCH");
  return res.status(405).json({ error: "Method not allowed" });
}
