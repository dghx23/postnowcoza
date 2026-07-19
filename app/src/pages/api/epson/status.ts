import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { parse } from "cookie";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import {
  getDeviceInfo,
  getJobStatus,
  getValidDeviceSession,
  EPSON_ACCESS_COOKIE,
  EPSON_REFRESH_COOKIE,
} from "@/lib/epson";
import { syncIfPendingJobs } from "@/lib/epsonNotifications";

const IN_FLIGHT_STATUSES = new Set(["preparing", "reserved", "pending", "processing"]);
const SETTLED_STATUSES = new Set(["canceled", "error_occurred", "completed", "expired"]);

// Epson has no "list all jobs" endpoint - only lookup by ID - so we poll
// every job we've recorded as still in-flight and reconcile its real status.
// Jobs expire after 3 days on Epson's side regardless, so this list never
// grows unbounded even if a job's terminal status is never observed.
//
// Email-Print jobs use jobIds like "email-print:…" — those are confirmed via
// IMAP (syncIfPendingJobs), not the Epson Connect job API.
function isEmailPrintJob(jobId: string) {
  return jobId.startsWith("email-print:") || jobId.startsWith("email-notify:");
}

async function pollPendingJobs(accessToken: string | null): Promise<number> {
  try {
    await syncIfPendingJobs();
  } catch {
    // IMAP blips shouldn't break the printer status widget.
  }

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
      // Job no longer resolvable (expired/deleted on Epson's side) - stop
      // counting it as pending without guessing at a terminal status.
      await prisma.epsonPrintJob.update({ where: { id: job.id }, data: { status: "expired" } });
    }
  }
  return pending;
}

interface RecentJob {
  documentId: string;
  recipientName: string;
  status: "success" | "failed";
  time: string;
}

async function getRecentJobs(): Promise<{
  recentJobs: RecentJob[];
  today: { success: number; failed: number; pending: number };
}> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const events = await prisma.auditEvent.findMany({
    where: {
      OR: [
        { action: "epson_print_failed" },
        { action: "email_print_failed" },
        { action: "epson_print_confirmed" },
        { action: { contains: "->PRINTED" } },
      ],
    },
    include: { document: { select: { recipientName: true } } },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  const recentJobs: RecentJob[] = events.slice(0, 10).map((e) => {
    const failed =
      e.action === "epson_print_failed" || e.action === "email_print_failed";
    return {
      documentId: e.documentId,
      recipientName: e.document.recipientName,
      status: failed ? "failed" : "success",
      time: e.createdAt.toISOString(),
    };
  });

  const todayEvents = events.filter((e) => e.createdAt >= startOfToday);
  const pendingJobs = await prisma.epsonPrintJob.count({
    where: {
      status: { notIn: [...SETTLED_STATUSES] },
      createdAt: { gte: startOfToday },
    },
  });

  const today = {
    success: todayEvents.filter(
      (e) =>
        e.action === "epson_print_confirmed" ||
        (e.action.includes("->PRINTED") &&
          e.action !== "epson_print_failed" &&
          e.action !== "email_print_failed"),
    ).length,
    failed: todayEvents.filter(
      (e) => e.action === "epson_print_failed" || e.action === "email_print_failed",
    ).length,
    pending: pendingJobs,
  };

  return { recentJobs, today };
}

// Polled by the print queue / dashboard every ~30s, so this always returns
// 200 with a status payload rather than surfacing HTTP error codes for
// ordinary "not connected yet" states.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const cookies = parse(req.headers.cookie ?? "");
  const session = await getValidDeviceSession({
    accessToken: cookies[EPSON_ACCESS_COOKIE],
    refreshToken: cookies[EPSON_REFRESH_COOKIE],
  });
  const accessToken = session?.accessToken ?? null;

  const pendingFromJobs = await pollPendingJobs(accessToken);
  const { recentJobs, today } = await getRecentJobs();

  if (!accessToken) {
    return res.status(200).json({
      status: pendingFromJobs > 0 ? "busy" : "not_connected",
      message:
        pendingFromJobs > 0
          ? `${pendingFromJobs} print confirmation${pendingFromJobs > 1 ? "s" : ""} pending`
          : "Not connected to Epson Connect (Email Print notifications still sync)",
      pendingJobs: pendingFromJobs,
      /** OAuth device tokens present (DB/cookies) — distinct from printer network online. */
      authorized: false,
      connected: false,
      recentJobs,
      today: { ...today, pending: pendingFromJobs },
    });
  }

  try {
    const device = await getDeviceInfo(accessToken);
    const connected = device.connected === true;

    let status: "online" | "busy" | "offline" = "offline";
    let message = "Printer offline";
    if (connected) {
      if (pendingFromJobs > 0) {
        status = "busy";
        message = `${pendingFromJobs} job${pendingFromJobs > 1 ? "s" : ""} pending`;
      } else {
        status = "online";
        message = "Ready";
      }
    } else if (pendingFromJobs > 0) {
      status = "busy";
      message = `${pendingFromJobs} confirmation${pendingFromJobs > 1 ? "s" : ""} pending`;
    }

    return res.status(200).json({
      status,
      message,
      pendingJobs: pendingFromJobs,
      authorized: true,
      connected,
      productName: device.productName ?? "Printer",
      serialNumber: device.serialNumber,
      recentJobs,
      today: { ...today, pending: pendingFromJobs },
      raw: { device, pendingJobs: pendingFromJobs },
    });
  } catch (err) {
    return res.status(200).json({
      status: pendingFromJobs > 0 ? "busy" : "unknown",
      message:
        pendingFromJobs > 0
          ? `${pendingFromJobs} print confirmation(s) pending`
          : "Unable to reach printer",
      pendingJobs: pendingFromJobs,
      // Tokens exist but device API failed — still authorized for disconnect UI.
      authorized: true,
      connected: false,
      recentJobs,
      today: { ...today, pending: pendingFromJobs },
      raw: axios.isAxiosError(err) ? { error: err.response?.data ?? err.message } : undefined,
    });
  }
}
