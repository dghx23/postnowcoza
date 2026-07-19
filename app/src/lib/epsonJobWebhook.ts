import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import type { EpsonJobStatus } from "@/lib/epson";

/**
 * Apply Epson Connect job-status webhooks (and optional job-status poll results)
 * into EpsonPrintJob + audit trail — same transparency path as IMAP email
 * notifications, but keyed by Connect jobId instead of email subject.
 *
 * Typical Epson callback body (v1 samples; v2 is similar):
 * {
 *   "Param": {
 *     "JobId": "...",
 *     "JobStatus": { "Status": "Completed", "StatusReason": "...", "UpdateDate": "..." }
 *   }
 * }
 * Also accepts flat { jobId, status } / { JobId, Status }.
 */

const SETTLED = new Set(["completed", "error_occurred", "canceled", "expired"]);
const FAILURE = new Set(["error_occurred", "expired", "canceled"]);
const IN_FLIGHT = new Set([
  "preparing",
  "reserved",
  "pending",
  "processing",
  "media_empty",
  "media_jam",
  "marker_supply_empty",
  "stopped_other",
]);

export interface ParsedConnectJobNotification {
  jobId: string;
  status: EpsonJobStatus | string;
  statusReason: string | null;
  updateDate: string | null;
  raw: unknown;
}

export function normalizeEpsonJobStatus(raw: unknown): string {
  if (raw == null) return "unknown";
  const s = String(raw).trim();
  if (!s) return "unknown";
  // Already snake_case enum
  const lower = s.toLowerCase().replace(/\s+/g, "_");
  const map: Record<string, string> = {
    pending: "pending",
    pending_held: "pending",
    jobqueued: "pending",
    preparing: "preparing",
    reserved: "reserved",
    processing: "processing",
    printing: "processing",
    completed: "completed",
    complete: "completed",
    success: "completed",
    canceled: "canceled",
    cancelled: "canceled",
    expired: "expired",
    error: "error_occurred",
    error_occurred: "error_occurred",
    erroroccurred: "error_occurred",
    failed: "error_occurred",
    media_empty: "media_empty",
    mediaempty: "media_empty",
    media_jam: "media_jam",
    mediajam: "media_jam",
    marker_supply_empty: "marker_supply_empty",
    markersupplyempty: "marker_supply_empty",
    stopped_other: "stopped_other",
    stoppedother: "stopped_other",
  };
  return map[lower] ?? lower;
}

/** Pull jobId + status from several possible Epson payload shapes. */
export function parseConnectWebhookBody(body: unknown): ParsedConnectJobNotification | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  // Nested Param (common Epson sample)
  const param =
    b.Param && typeof b.Param === "object"
      ? (b.Param as Record<string, unknown>)
      : b.param && typeof b.param === "object"
        ? (b.param as Record<string, unknown>)
        : null;

  const jobStatusObj =
    (param?.JobStatus && typeof param.JobStatus === "object"
      ? (param.JobStatus as Record<string, unknown>)
      : null) ||
    (param?.jobStatus && typeof param.jobStatus === "object"
      ? (param.jobStatus as Record<string, unknown>)
      : null) ||
    (b.JobStatus && typeof b.JobStatus === "object"
      ? (b.JobStatus as Record<string, unknown>)
      : null) ||
    (b.jobStatus && typeof b.jobStatus === "object"
      ? (b.jobStatus as Record<string, unknown>)
      : null);

  const jobIdRaw =
    param?.JobId ??
    param?.jobId ??
    b.JobId ??
    b.jobId ??
    b.job_id ??
    (typeof b.id === "string" ? b.id : null);

  const statusRaw =
    jobStatusObj?.Status ??
    jobStatusObj?.status ??
    b.Status ??
    b.status ??
    null;

  const jobId = jobIdRaw != null ? String(jobIdRaw).trim() : "";
  if (!jobId) return null;

  const status = normalizeEpsonJobStatus(statusRaw);
  const statusReason =
    (jobStatusObj?.StatusReason != null
      ? String(jobStatusObj.StatusReason)
      : jobStatusObj?.statusReason != null
        ? String(jobStatusObj.statusReason)
        : b.StatusReason != null
          ? String(b.StatusReason)
          : null) || null;
  const updateDate =
    (jobStatusObj?.UpdateDate != null
      ? String(jobStatusObj.UpdateDate)
      : jobStatusObj?.updateDate != null
        ? String(jobStatusObj.updateDate)
        : null) || null;

  return { jobId, status, statusReason, updateDate, raw: body };
}

export interface ApplyConnectJobResult {
  applied: boolean;
  reason: string;
  documentId?: string;
  jobId?: string;
  status?: string;
}

/**
 * Match Epson jobId → EpsonPrintJob, update status, write audit for
 * completed / failed, re-queue document on failure when still PRINTED.
 */
export async function applyConnectJobNotification(
  parsed: ParsedConnectJobNotification
): Promise<ApplyConnectJobResult> {
  const job = await prisma.epsonPrintJob.findUnique({ where: { jobId: parsed.jobId } });
  if (!job) {
    // Soft-create is wrong here — unknown Connect job IDs aren't our documents.
    return { applied: false, reason: "unknown_job_id", jobId: parsed.jobId, status: parsed.status };
  }

  const nextStatus = parsed.status;
  if (job.status === nextStatus && SETTLED.has(job.status)) {
    return {
      applied: false,
      reason: "already_settled",
      documentId: job.documentId,
      jobId: job.jobId,
      status: job.status,
    };
  }

  // Always record latest non-empty status from Epson (including in-flight).
  if (job.status !== nextStatus) {
    await prisma.epsonPrintJob.update({
      where: { id: job.id },
      data: { status: nextStatus },
    });
  }

  const metaBase = {
    via: "epson_connect_webhook",
    jobId: job.jobId,
    status: nextStatus,
    statusReason: parsed.statusReason,
    updateDate: parsed.updateDate,
    raw: parsed.raw,
  };

  const printLog = {
    customerRequested: {
      colorMode: job.customerColorMode,
      copies: job.customerCopies,
    },
    printed: {
      colorMode: job.printedColorMode,
      copies: job.printedCopies,
      settings: job.printSettings,
    },
    via: job.via ?? "epson_connect",
  };

  if (nextStatus === "completed") {
    await prisma.epsonPrintJob.update({
      where: { id: job.id },
      data: {
        confirmedAt: new Date(),
        outcomeDetail: { ...metaBase, printLog } as object,
      },
    });
    await appendAuditEvent({
      documentId: job.documentId,
      action: "epson_print_confirmed",
      metadata: { ...metaBase, printLog },
    });
    return {
      applied: true,
      reason: "completed",
      documentId: job.documentId,
      jobId: job.jobId,
      status: nextStatus,
    };
  }

  if (FAILURE.has(nextStatus)) {
    await prisma.epsonPrintJob.update({
      where: { id: job.id },
      data: {
        confirmedAt: new Date(),
        outcomeDetail: { ...metaBase, printLog, outcome: nextStatus } as object,
      },
    });
    const doc = await prisma.document.findUnique({ where: { id: job.documentId } });
    if (doc?.status === "PRINTED") {
      await prisma.document.update({
        where: { id: job.documentId },
        data: { status: "QUEUED_FOR_PRINT" },
      });
      await appendAuditEvent({
        documentId: job.documentId,
        action: "status_changed:PRINTED->QUEUED_FOR_PRINT",
        metadata: { ...metaBase, reason: nextStatus, printLog },
      });
    }
    await appendAuditEvent({
      documentId: job.documentId,
      action: "epson_print_failed",
      metadata: { ...metaBase, outcome: nextStatus, printLog },
    });
    return {
      applied: true,
      reason: nextStatus,
      documentId: job.documentId,
      jobId: job.jobId,
      status: nextStatus,
    };
  }

  // In-flight / attention states — status on job row is enough; audit for sticky issues.
  if (IN_FLIGHT.has(nextStatus) && nextStatus !== "pending" && nextStatus !== "processing" && nextStatus !== "preparing" && nextStatus !== "reserved") {
    await prisma.epsonPrintJob.update({
      where: { id: job.id },
      data: { outcomeDetail: { ...metaBase, printLog } as object },
    });
    await appendAuditEvent({
      documentId: job.documentId,
      action: "epson_print_attention",
      metadata: { ...metaBase, printLog },
    });
    return {
      applied: true,
      reason: `attention:${nextStatus}`,
      documentId: job.documentId,
      jobId: job.jobId,
      status: nextStatus,
    };
  }

  return {
    applied: true,
    reason: `status:${nextStatus}`,
    documentId: job.documentId,
    jobId: job.jobId,
    status: nextStatus,
  };
}

export function verifyWebhookKey(queryKey: unknown): boolean {
  const expected = (process.env.EPSON_WEBHOOK_SECRET || process.env.CRON_SECRET || "").trim();
  // If no secret configured, accept (Epson must still hit a public HTTPS URL).
  if (!expected) return true;
  return typeof queryKey === "string" && queryKey === expected;
}
