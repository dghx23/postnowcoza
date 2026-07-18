import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { parse, serialize } from "cookie";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { getSessionUser } from "@/lib/session";
import { getDocumentDownloadUrl } from "@/lib/storage";
import { getPrintProvider } from "@/lib/printSettings";
import {
  buildAuthorizeUrl,
  printPdf,
  refreshTokens,
  epsonCookieOptions,
  epsonRefreshCookieOptions,
  EPSON_ACCESS_COOKIE,
  EPSON_REFRESH_COOKIE,
  EPSON_DEVICE_ID_COOKIE,
} from "@/lib/epson";

// Same UPLOADED/QUEUED_FOR_PRINT -> PRINTED transitions the manual
// "Mark as Printed" button allows (src/pages/api/documents/[id]/status.ts) -
// this is just a second way to reach PRINTED, not a different state machine.
const PRINTABLE_STATUSES = new Set(["UPLOADED", "QUEUED_FOR_PRINT"]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return res.status(404).json({ error: "Document not found" });
  if (!PRINTABLE_STATUSES.has(document.status)) {
    return res.status(409).json({ error: `Cannot print a document in status ${document.status}` });
  }

  const provider = await getPrintProvider();
  if (provider === "LINUX_AGENT") {
    const existing = await prisma.linuxPrintJob.findFirst({
      where: { documentId: id, status: "PENDING" },
    });
    if (existing) {
      return res.status(409).json({ error: "Already queued for the Linux print agent" });
    }

    const job = await prisma.linuxPrintJob.create({ data: { documentId: id } });
    await appendAuditEvent({
      documentId: id,
      actorId: user.id,
      action: "linux_agent_print_queued",
      metadata: { via: "linux_agent", jobId: job.id },
      ip: req.socket.remoteAddress ?? undefined,
    });
    return res.status(200).json({ id: document.id, status: document.status, queuedForLinuxAgent: true });
  }

  const cookies = parse(req.headers.cookie ?? "");
  let accessToken = cookies[EPSON_ACCESS_COOKIE];
  const refreshToken = cookies[EPSON_REFRESH_COOKIE];
  const deviceId = cookies[EPSON_DEVICE_ID_COOKIE];

  if (!accessToken || !deviceId) {
    return res.status(401).json({
      error: "Not connected to Epson Connect",
      auth_url: buildAuthorizeUrl(document.id),
    });
  }

  const downloadUrl = await getDocumentDownloadUrl(document.storageKey);
  const fileRes = await axios.get<ArrayBuffer>(downloadUrl, { responseType: "arraybuffer" });
  const pdfBuffer = Buffer.from(fileRes.data);
  const jobName = `postnow-${document.id}`;

  let epsonJobId: string;
  try {
    epsonJobId = await printPdf(accessToken, pdfBuffer, jobName);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 401 && refreshToken) {
      try {
        const refreshed = await refreshTokens(refreshToken);
        accessToken = refreshed.access_token;
        res.setHeader("Set-Cookie", [
          serialize(EPSON_ACCESS_COOKIE, refreshed.access_token, epsonCookieOptions(refreshed.expires_in ?? 3600)),
          serialize(EPSON_REFRESH_COOKIE, refreshed.refresh_token ?? refreshToken, epsonRefreshCookieOptions()),
        ]);
        epsonJobId = await printPdf(accessToken, pdfBuffer, jobName);
      } catch (retryErr) {
        await appendAuditEvent({
          documentId: id,
          actorId: user.id,
          action: "epson_print_failed",
          metadata: { via: "epson_connect", reason: "session_expired", error: (retryErr as Error).message },
          ip: req.socket.remoteAddress ?? undefined,
        });
        return res.status(401).json({
          error: "Epson session expired, please reconnect",
          auth_url: buildAuthorizeUrl(document.id),
        });
      }
    } else {
      await appendAuditEvent({
        documentId: id,
        actorId: user.id,
        action: "epson_print_failed",
        metadata: { via: "epson_connect", reason: "request_failed", error: (err as Error).message },
        ip: req.socket.remoteAddress ?? undefined,
      });
      return res.status(502).json({ error: "Epson Connect print request failed" });
    }
  }

  await prisma.epsonPrintJob.create({
    data: { documentId: id, jobId: epsonJobId, status: "pending" },
  });

  const updated = await prisma.document.update({
    where: { id },
    data: { status: "PRINTED" },
  });

  await appendAuditEvent({
    documentId: id,
    actorId: user.id,
    action: `status_changed:${document.status}->PRINTED`,
    metadata: { via: "epson_connect" },
    ip: req.socket.remoteAddress ?? undefined,
  });

  return res.status(200).json({ id: updated.id, status: updated.status });
}
