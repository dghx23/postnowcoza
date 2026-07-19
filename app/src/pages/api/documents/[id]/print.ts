import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { parse } from "cookie";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { getSessionUser } from "@/lib/session";
import { getDocumentDownloadUrl } from "@/lib/storage";
import { getPrintSettings } from "@/lib/printSettings";
import { sendPrintEmail } from "@/lib/emailPrint";
import {
  buildAuthorizeUrl,
  printPdf,
  getValidDeviceSession,
  EPSON_ACCESS_COOKIE,
  EPSON_REFRESH_COOKIE,
} from "@/lib/epson";
import { maybeAutoDispatchIfPaid } from "@/lib/autoDispatch";

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

  const settings = await getPrintSettings();
  // Per-click override from Print Queue (Print EpsonAPI / Print EpsonMail).
  // Falls back to Printer Hub default when body.via is omitted.
  const bodyVia =
    req.body && typeof req.body === "object" && typeof (req.body as { via?: unknown }).via === "string"
      ? (req.body as { via: string }).via
      : null;
  const provider =
    bodyVia === "EPSON" || bodyVia === "EPSON_DIRECT" ? bodyVia : settings.provider;
  const epsonDirectEmail = settings.epsonDirectEmail;

  if (provider === "EPSON_DIRECT") {
    if (!epsonDirectEmail) {
      return res.status(400).json({
        error: "No printer email address configured. Set it on the Printing Method card on /printer first.",
      });
    }

    const downloadUrl = await getDocumentDownloadUrl(document.storageKey);
    const fileRes = await axios.get<ArrayBuffer>(downloadUrl, { responseType: "arraybuffer" });
    const pdfBuffer = Buffer.from(fileRes.data);

    if (pdfBuffer.length === 0 || pdfBuffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
      await appendAuditEvent({
        documentId: id,
        actorId: user.id,
        action: "email_print_failed",
        metadata: { via: "epson_direct", to: epsonDirectEmail, error: `Stored file is not a valid PDF (${pdfBuffer.length} bytes)` },
        ip: req.socket.remoteAddress ?? undefined,
      });
      return res.status(502).json({ error: "Stored document is not a valid PDF — re-upload it and try again." });
    }

    // Subject must include the document id so Epson owner-notification emails
    // (errors/completed) can be matched back via IMAP (see epsonNotifications.ts).
    const emailSubject = `PostNow document ${document.id}`;
    try {
      await sendPrintEmail(
        epsonDirectEmail,
        pdfBuffer,
        `${document.id}.pdf`,
        emailSubject,
      );
    } catch (err) {
      await appendAuditEvent({
        documentId: id,
        actorId: user.id,
        action: "email_print_failed",
        metadata: { via: "epson_direct", to: epsonDirectEmail, error: (err as Error).message },
        ip: req.socket.remoteAddress ?? undefined,
      });
      return res.status(502).json({ error: "Failed to send print email" });
    }

    // Track pending confirmation from Epson's email notifications.
    await prisma.epsonPrintJob.create({
      data: {
        documentId: id,
        jobId: `email-print:${document.id}:${Date.now()}`,
        status: "pending",
      },
    });

    const updated = await prisma.document.update({ where: { id }, data: { status: "PRINTED" } });
    await appendAuditEvent({
      documentId: id,
      actorId: user.id,
      action: `status_changed:${document.status}->PRINTED`,
      metadata: {
        via: "epson_direct",
        to: epsonDirectEmail,
        subject: emailSubject,
        await_email_confirmation: true,
      },
      ip: req.socket.remoteAddress ?? undefined,
    });
    // Paid + printed → book next-day collection automatically.
    try {
      await maybeAutoDispatchIfPaid(id, user.id);
    } catch {
      /* non-fatal */
    }
    return res.status(200).json({
      id: updated.id,
      status: updated.status,
      printConfirmation: "pending",
    });
  }

  const cookies = parse(req.headers.cookie ?? "");
  const session = await getValidDeviceSession({
    accessToken: cookies[EPSON_ACCESS_COOKIE],
    refreshToken: cookies[EPSON_REFRESH_COOKIE],
  });

  if (!session?.accessToken) {
    return res.status(401).json({
      error: "Not connected to Epson Connect",
      auth_url: buildAuthorizeUrl(document.id),
    });
  }

  const downloadUrl = await getDocumentDownloadUrl(document.storageKey);
  const fileRes = await axios.get<ArrayBuffer>(downloadUrl, { responseType: "arraybuffer" });
  const pdfBuffer = Buffer.from(fileRes.data);

  if (pdfBuffer.length === 0 || pdfBuffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    await appendAuditEvent({
      documentId: id,
      actorId: user.id,
      action: "epson_print_failed",
      metadata: { via: "epson_connect", reason: "invalid_pdf", error: `Stored file is not a valid PDF (${pdfBuffer.length} bytes)` },
      ip: req.socket.remoteAddress ?? undefined,
    });
    return res.status(502).json({ error: "Stored document is not a valid PDF — re-upload it and try again." });
  }

  const jobName = `postnow-${document.id}`;

  let epsonJobId: string;
  try {
    epsonJobId = await printPdf(session.accessToken, pdfBuffer, jobName);
  } catch (err) {
    // getValidDeviceSession already refreshed near-expiry tokens; a 401 here
    // usually means the refresh token itself is dead — force re-auth.
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      await appendAuditEvent({
        documentId: id,
        actorId: user.id,
        action: "epson_print_failed",
        metadata: {
          via: "epson_connect",
          reason: "session_expired",
          error: (err as Error).message,
          epson: err.response?.data,
        },
        ip: req.socket.remoteAddress ?? undefined,
      });
      return res.status(401).json({
        error: "Epson session expired, please reconnect",
        auth_url: buildAuthorizeUrl(document.id),
      });
    }
    await appendAuditEvent({
      documentId: id,
      actorId: user.id,
      action: "epson_print_failed",
      metadata: {
        via: "epson_connect",
        reason: "request_failed",
        error: (err as Error).message,
        epson: axios.isAxiosError(err) ? err.response?.data : undefined,
      },
      ip: req.socket.remoteAddress ?? undefined,
    });
    return res.status(502).json({ error: "Epson Connect print request failed" });
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

  try {
    await maybeAutoDispatchIfPaid(id, user.id);
  } catch {
    /* non-fatal */
  }

  return res.status(200).json({ id: updated.id, status: updated.status });
}
