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
import { resolveJobPrintSettings, type JobPrintSettings } from "@/lib/printJobSettings";
import { customerRequestFromDocument, recordPrintJobSubmission } from "@/lib/printJobLog";

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

  const facility = await getPrintSettings();
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
    via?: string;
    settings?: Partial<JobPrintSettings>;
  };

  const bodyVia = typeof body.via === "string" ? body.via : null;
  const provider =
    bodyVia === "EPSON" || bodyVia === "EPSON_DIRECT" ? bodyVia : facility.provider;
  const epsonDirectEmail = facility.epsonDirectEmail;

  const jobSettings = resolveJobPrintSettings({
    facility: {
      printPaperSize: facility.printPaperSize,
      printPaperType: facility.printPaperType,
      printQuality: facility.printQuality,
      printPaperSource: facility.printPaperSource,
      printBorderless: facility.printBorderless,
      printDoubleSided: facility.printDoubleSided,
    },
    customer: {
      printColorMode: document.printColorMode,
      printCopies: document.printCopies,
    },
    override: body.settings ?? null,
  });

  if (provider === "EPSON_DIRECT") {
    if (!epsonDirectEmail) {
      return res.status(400).json({
        error: "No printer email address configured. Set it on the Printer Hub first.",
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
        metadata: {
          via: "epson_direct",
          to: epsonDirectEmail,
          error: `Stored file is not a valid PDF (${pdfBuffer.length} bytes)`,
          printSettings: jobSettings,
        },
        ip: req.socket.remoteAddress ?? undefined,
      });
      return res.status(502).json({ error: "Stored document is not a valid PDF — re-upload it and try again." });
    }

    // Note customer prefs in subject — Email Print cannot set color/copies via API.
    const colorLabel = jobSettings.colorMode === "color" ? "colour" : "B&W";
    const emailSubject = `PostNow document ${document.id} · ${colorLabel} · ${jobSettings.copies}x`;
    try {
      await sendPrintEmail(epsonDirectEmail, pdfBuffer, `${document.id}.pdf`, emailSubject);
    } catch (err) {
      await appendAuditEvent({
        documentId: id,
        actorId: user.id,
        action: "email_print_failed",
        metadata: {
          via: "epson_direct",
          to: epsonDirectEmail,
          error: (err as Error).message,
          printSettings: jobSettings,
        },
        ip: req.socket.remoteAddress ?? undefined,
      });
      return res.status(502).json({ error: "Failed to send print email" });
    }

    const customer = customerRequestFromDocument(document);
    const { summary } = await recordPrintJobSubmission({
      documentId: id,
      jobId: `email-print:${document.id}:${Date.now()}`,
      via: "epson_direct",
      actorId: user.id,
      customer,
      printed: jobSettings,
      status: "pending",
      extraMeta: {
        to: epsonDirectEmail,
        subject: emailSubject,
        await_email_confirmation: true,
        note: "Email Print cannot force colour/copies on the device; prefs recorded for audit.",
      },
      ip: req.socket.remoteAddress ?? undefined,
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
        printLog: summary,
      },
      ip: req.socket.remoteAddress ?? undefined,
    });
    try {
      await maybeAutoDispatchIfPaid(id, user.id);
    } catch {
      /* non-fatal */
    }
    return res.status(200).json({
      id: updated.id,
      status: updated.status,
      printConfirmation: "pending",
      printSettings: jobSettings,
      printLog: summary,
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
      metadata: {
        via: "epson_connect",
        reason: "invalid_pdf",
        error: `Stored file is not a valid PDF (${pdfBuffer.length} bytes)`,
      },
      ip: req.socket.remoteAddress ?? undefined,
    });
    return res.status(502).json({ error: "Stored document is not a valid PDF — re-upload it and try again." });
  }

  const jobName = `postnow-${document.id}`;

  let epsonJobId: string;
  try {
    epsonJobId = await printPdf(session.accessToken, pdfBuffer, jobName, jobSettings);
  } catch (err) {
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
          printSettings: jobSettings,
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
        printSettings: jobSettings,
      },
      ip: req.socket.remoteAddress ?? undefined,
    });
    return res.status(502).json({
      error: "Epson Connect print request failed",
      detail: axios.isAxiosError(err) ? err.response?.data : undefined,
    });
  }

  const customer = customerRequestFromDocument(document);
  const { summary } = await recordPrintJobSubmission({
    documentId: id,
    jobId: epsonJobId,
    via: "epson_connect",
    actorId: user.id,
    customer,
    printed: jobSettings,
    status: "pending",
    extraMeta: { epsonJobId },
    ip: req.socket.remoteAddress ?? undefined,
  });

  const updated = await prisma.document.update({
    where: { id },
    data: { status: "PRINTED" },
  });

  await appendAuditEvent({
    documentId: id,
    actorId: user.id,
    action: `status_changed:${document.status}->PRINTED`,
    metadata: {
      via: "epson_connect",
      epsonJobId,
      printLog: summary,
    },
    ip: req.socket.remoteAddress ?? undefined,
  });

  try {
    await maybeAutoDispatchIfPaid(id, user.id);
  } catch {
    /* non-fatal */
  }

  return res.status(200).json({
    id: updated.id,
    status: updated.status,
    printSettings: jobSettings,
    epsonJobId,
    printLog: summary,
  });
}
