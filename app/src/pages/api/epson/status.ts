import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { parse } from "cookie";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import {
  getDeviceInfo,
  getJobStatus,
  getValidDeviceSession,
  isDeviceOnline,
  EPSON_ACCESS_COOKIE,
  EPSON_REFRESH_COOKIE,
} from "@/lib/epson";
import { syncIfPendingJobs } from "@/lib/epsonNotifications";

const IN_FLIGHT_STATUSES = new Set(["preparing", "reserved", "pending", "processing"]);
const SETTLED_STATUSES = new Set(["canceled", "error_occurred", "completed", "expired"]);

function isEmailPrintJob(jobId: string) {
  return jobId.startsWith("email-print:") || jobId.startsWith("email-notify:");
}

/**
 * Poll tracked Epson Connect jobs only (DB + job status API).
 * Does NOT call IMAP — mailbox sync is slow and was blocking the hub on
 * "Updating… / Offline" while details already showed Online.
 */
async function pollPendingJobs(accessToken: string | null): Promise<number> {
  const tracked = await prisma.epsonPrintJob.findMany({
    where: { status: { notIn: [...SETTLED_STATUSES] } },
  });

  let pending = 0;
  for (const job of tracked) {
    if (isEmailPrintJob(job.jobId) || !accessToken) {
      if (IN_FLIGHT_STATUSES.has(job.status) || job.status === "pending") pending += 1;
      continue;
    }
    try {
      const live = await getJobStatus(accessToken, job.jobId);
      if (live.status !== job.status) {
        await prisma.epsonPrintJob.update({ where: { id: job.id }, data: { status: live.status } });
      }
      if (IN_FLIGHT_STATUSES.has(live.status)) pending += 1;
    } catch {
      await prisma.epsonPrintJob.update({ where: { id: job.id }, data: { status: "expired" } });
    }
  }
  return pending;
}

export interface RecentJob {
  documentId: string;
  recipientName: string;
  /** success | failed | pending | attention */
  status: "success" | "failed" | "pending" | "attention";
  time: string;
  via: string | null;
  viaLabel: string;
  jobId: string;
  customerColor: string | null;
  printedColor: string | null;
  customerCopies: number | null;
  printedCopies: number | null;
  pages: number | null;
  paperSize: string | null;
  quality: string | null;
  hasIssue: boolean;
  issueLabel: string | null;
  comment: string | null;
}

function viaLabel(via: string | null, jobId: string): string {
  if (via === "manual_mark" || jobId.startsWith("manual-mark:")) return "MANUAL";
  if (via === "epson_direct" || jobId.startsWith("email-")) return "EpsonMail";
  if (via === "epson_connect") return "EpsonAPI";
  return "Print";
}

function colorLabel(mode: string | null | undefined): string | null {
  if (!mode) return null;
  return mode === "color" ? "Colour" : "B&W";
}

async function getRecentJobs(): Promise<{
  recentJobs: RecentJob[];
  today: { success: number; failed: number; pending: number };
}> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const jobs = await prisma.epsonPrintJob.findMany({
    orderBy: { updatedAt: "desc" },
    take: 15,
    include: {
      document: { select: { id: true, recipientName: true } },
    },
  });

  const recentJobs: RecentJob[] = jobs.map((job) => {
    const failed = ["error_occurred", "expired", "canceled"].includes(job.status);
    const attention = ["media_empty", "media_jam", "marker_supply_empty", "stopped_other"].includes(
      job.status
    );
    const pending = !failed && !attention && !["completed"].includes(job.status);

    let status: RecentJob["status"] = "success";
    if (failed) status = "failed";
    else if (attention) status = "attention";
    else if (pending) status = "pending";

    const settings =
      job.printSettings && typeof job.printSettings === "object"
        ? (job.printSettings as Record<string, unknown>)
        : null;
    const outcome =
      job.outcomeDetail && typeof job.outcomeDetail === "object"
        ? (job.outcomeDetail as Record<string, unknown>)
        : null;

    const pagesRaw =
      outcome?.totalPages ??
      outcome?.pages ??
      (outcome?.raw && typeof outcome.raw === "object"
        ? (outcome.raw as { totalPages?: number }).totalPages
        : null);
    const pages =
      typeof pagesRaw === "number" && Number.isFinite(pagesRaw) ? pagesRaw : null;

    const paperSize =
      typeof settings?.paperSize === "string" ? settings.paperSize.replace(/^ps_/, "").toUpperCase() : null;
    const quality =
      typeof settings?.printQuality === "string" ? String(settings.printQuality) : null;

    const comment =
      typeof outcome?.comment === "string"
        ? outcome.comment
        : typeof (outcome as { note?: string } | null)?.note === "string"
          ? String((outcome as { note?: string }).note)
          : null;

    const hasIssue = failed || attention;
    let issueLabel: string | null = null;
    if (failed) issueLabel = job.status.replace(/_/g, " ");
    else if (attention) issueLabel = job.status.replace(/_/g, " ");

    return {
      documentId: job.documentId,
      recipientName: job.document.recipientName,
      status,
      time: job.updatedAt.toISOString(),
      via: job.via,
      viaLabel: viaLabel(job.via, job.jobId),
      jobId: job.jobId,
      customerColor: colorLabel(job.customerColorMode),
      printedColor: colorLabel(job.printedColorMode),
      customerCopies: job.customerCopies,
      printedCopies: job.printedCopies,
      pages,
      paperSize,
      quality,
      hasIssue,
      issueLabel,
      comment,
    };
  });

  const pendingJobs = await prisma.epsonPrintJob.count({
    where: {
      status: { notIn: [...SETTLED_STATUSES] },
      createdAt: { gte: startOfToday },
    },
  });

  const todayJobs = await prisma.epsonPrintJob.findMany({
    where: { createdAt: { gte: startOfToday } },
    select: { status: true, via: true },
  });

  const today = {
    success: todayJobs.filter((j) => j.status === "completed").length,
    failed: todayJobs.filter((j) =>
      ["error_occurred", "expired", "canceled"].includes(j.status)
    ).length,
    pending: pendingJobs,
  };

  return { recentJobs, today };
}

/**
 * Polled every ~30s by Printer Hub / dashboard.
 * Fast path: device info + DB job counts. IMAP only when ?sync=1 or
 * fire-and-forget after response isn't possible on Vercel — so mailbox
 * sync stays on the dedicated notifications/sync button and daily cron.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const wantSync =
    req.query.sync === "1" || req.query.sync === "true" || req.query.sync === "yes";

  // Optional mailbox pull — never on the default poll path.
  if (wantSync) {
    try {
      await syncIfPendingJobs();
    } catch {
      /* non-fatal */
    }
  }

  const cookies = parse(req.headers.cookie ?? "");
  const session = await getValidDeviceSession({
    accessToken: cookies[EPSON_ACCESS_COOKIE],
    refreshToken: cookies[EPSON_REFRESH_COOKIE],
  });
  const accessToken = session?.accessToken ?? null;

  // Parallel: device reachability + job reconciliation (no IMAP).
  const [pendingFromJobs, history, deviceResult] = await Promise.all([
    pollPendingJobs(accessToken),
    getRecentJobs(),
    accessToken
      ? getDeviceInfo(accessToken)
          .then((device) => ({ ok: true as const, device }))
          .catch((err: unknown) => ({
            ok: false as const,
            err,
          }))
      : Promise.resolve(null),
  ]);

  const { recentJobs, today } = history;

  if (!accessToken) {
    return res.status(200).json({
      status: pendingFromJobs > 0 ? "busy" : "not_connected",
      message:
        pendingFromJobs > 0
          ? `${pendingFromJobs} print confirmation${pendingFromJobs > 1 ? "s" : ""} pending`
          : "Not linked to Epson Connect",
      pendingJobs: pendingFromJobs,
      authorized: false,
      connected: false,
      reachability: "unlinked",
      recentJobs,
      today: { ...today, pending: pendingFromJobs },
    });
  }

  if (!deviceResult || !deviceResult.ok) {
    const err = deviceResult && !deviceResult.ok ? deviceResult.err : null;
    return res.status(200).json({
      status: pendingFromJobs > 0 ? "busy" : "unknown",
      message:
        pendingFromJobs > 0
          ? `${pendingFromJobs} print confirmation(s) pending`
          : "Linked — unable to reach Epson device API",
      pendingJobs: pendingFromJobs,
      authorized: true,
      connected: false,
      reachability: "error",
      recentJobs,
      today: { ...today, pending: pendingFromJobs },
      raw: axios.isAxiosError(err) ? { error: err.response?.data ?? err.message } : undefined,
    });
  }

  const device = deviceResult.device;
  const connected = isDeviceOnline(device);

  let status: "online" | "busy" | "offline" = "offline";
  let message = "Linked · printer offline / sleeping";
  if (connected) {
    if (pendingFromJobs > 0) {
      status = "busy";
      message = `Ready · ${pendingFromJobs} job${pendingFromJobs > 1 ? "s" : ""} pending`;
    } else {
      status = "online";
      message = "Ready";
    }
  } else if (pendingFromJobs > 0) {
    status = "busy";
    message = `${pendingFromJobs} confirmation${pendingFromJobs > 1 ? "s" : ""} pending · printer offline`;
  }

  return res.status(200).json({
    status,
    message,
    pendingJobs: pendingFromJobs,
    authorized: true,
    connected,
    reachability: connected ? "online" : "offline",
    productName: device.productName ?? "Printer",
    serialNumber: device.serialNumber,
    recentJobs,
    today: { ...today, pending: pendingFromJobs },
    raw: { device, pendingJobs: pendingFromJobs },
  });
}
