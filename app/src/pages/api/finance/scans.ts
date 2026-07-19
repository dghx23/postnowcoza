import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { newScanStorageKey, putDocument } from "@/lib/storage";
import { emailFacilityScan } from "@/lib/scanEmail";
import { logSyncException } from "@/lib/syncExceptions";

/**
 * GET — list facility scans
 * POST — save scan:
 *   { action: "save", fileName, comments?, contentBase64, contentType? }
 *   { action: "email", scanId, to, subject, body, password? }
 * DELETE body { id }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method === "GET") {
    const scans = await prisma.facilityScan.findMany({
      orderBy: { createdAt: "desc" },
      take: 40,
    });
    return res.status(200).json({ scans });
  }

  if (req.method === "DELETE") {
    const id = typeof req.body?.id === "string" ? req.body.id : String(req.query.id ?? "");
    if (!id) return res.status(400).json({ error: "id required" });
    await prisma.facilityScan.delete({ where: { id } }).catch(() => null);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "POST") {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = String(body.action ?? "save");

    if (action === "email") {
      const scanId = String(body.scanId ?? "");
      const to = String(body.to ?? "").trim();
      const subject = String(body.subject ?? "").trim();
      const emailBody = String(body.body ?? "");
      const password = body.password ? String(body.password) : null;
      if (!scanId || !to) {
        return res.status(400).json({ error: "scanId and to required" });
      }
      try {
        const result = await emailFacilityScan({
          scanId,
          toEmail: to,
          subject,
          body: emailBody,
          password,
        });
        return res.status(200).json(result);
      } catch (err) {
        return res.status(502).json({ error: (err as Error).message });
      }
    }

    if (action === "save") {
      try {
        const rawName = String(body.fileName ?? "scan.pdf").trim();
        const safeName = rawName.replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "scan.pdf";
        const comments = body.comments ? String(body.comments).trim() : null;
        const b64 = String(body.contentBase64 ?? "").replace(/^data:[^;]+;base64,/, "");
        if (!b64) {
          return res.status(400).json({
            error: "contentBase64 required (Epson Connect scan PDF or staff-selected file)",
          });
        }
        const buf = Buffer.from(b64, "base64");
        if (buf.length > 40 * 1024 * 1024) {
          return res.status(400).json({ error: "File too large (max 40MB)" });
        }
        const contentType =
          String(body.contentType || "") ||
          (safeName.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream");
        const storageKey = newScanStorageKey(safeName);
        await putDocument(storageKey, buf, contentType);

        const scan = await prisma.facilityScan.create({
          data: {
            fileName: safeName,
            storageKey,
            contentType,
            sizeBytes: buf.length,
            comments,
            createdBy: user.email,
          },
        });
        return res.status(201).json({ scan });
      } catch (err) {
        await logSyncException({
          source: "scan",
          title: "Scan save failed",
          detail: (err as Error).message,
        });
        return res.status(502).json({ error: (err as Error).message });
      }
    }

    return res.status(400).json({ error: "Unknown action (save | email)" });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
