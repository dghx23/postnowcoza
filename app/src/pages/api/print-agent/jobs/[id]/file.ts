import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { isAuthorizedAgent } from "@/lib/printAgentAuth";
import { getDocumentDownloadUrl } from "@/lib/storage";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isAuthorizedAgent(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const job = await prisma.linuxPrintJob.findUnique({ where: { id }, include: { document: true } });
  if (!job) return res.status(404).json({ error: "Job not found" });

  const url = await getDocumentDownloadUrl(job.document.storageKey);
  return res.redirect(302, url);
}
