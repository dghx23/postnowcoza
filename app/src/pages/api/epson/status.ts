import type { NextApiRequest, NextApiResponse } from "next";
import axios from "axios";
import { parse } from "cookie";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getDeviceInfo, getJobStatus, EPSON_ACCESS_COOKIE, EPSON_DEVICE_ID_COOKIE } from "@/lib/epson";

const IN_FLIGHT_STATUSES = new Set(["preparing", "reserved", "pending", "processing"]);
const SETTLED_STATUSES = new Set(["canceled", "error_occurred", "completed", "expired"]);

// Epson has no "list all jobs" endpoint - only lookup by ID - so we poll
// every job we've recorded as still in-flight and reconcile its real status.
// Jobs expire after 3 days on Epson's side regardless, so this list never
// grows unbounded even if a job's terminal status is never observed.
async function pollPendingJobs(accessToken: string): Promise<number> {
  const tracked = await prisma.epsonPrintJob.findMany({
    where: { status: { notIn: [...SETTLED_STATUSES] } },
  });

  let pending = 0;
  for (const job of tracked) {
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

// Real print history from our own audit trail (not Epson's job list, which
// only covers jobs still known to their API) - every print attempt through
// this app writes an audit event either on success
// (documents/[id]/print.ts's "status_changed:...->PRINTED" with
// metadata.via=epson_connect) or failure ("epson_print_failed").
async function getRecentJobs(): Promise<{ recentJobs: RecentJob[]; today: { success: number; failed: number } }> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const events = await prisma.auditEvent.findMany({
    where: {
      OR: [
        { action: "epson_print_failed" },
        { action: { contains: "->PRINTED" }, metadata: { path: ["via"], equals: "epson_connect" } },
      ],
    },
    include: { document: { select: { recipientName: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const recentJobs: RecentJob[] = events.slice(0, 10).map((e) => ({
    documentId: e.documentId,
    recipientName: e.document.recipientName,
    status: e.action === "epson_print_failed" ? "failed" : "success",
    time: e.createdAt.toISOString(),
  }));

  const todayEvents = events.filter((e) => e.createdAt >= startOfToday);
  const today = {
    success: todayEvents.filter((e) => e.action !== "epson_print_failed").length,
    failed: todayEvents.filter((e) => e.action === "epson_print_failed").length,
  };

  return { recentJobs, today };
}

// Polled by the print queue / dashboard every ~30s, so this always returns
// 200 with a status payload rather than surfacing HTTP error codes for
// ordinary "not connected yet" states — the caller shouldn't have to treat
// that differently from any other status value.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { recentJobs, today } = await getRecentJobs();

  const cookies = parse(req.headers.cookie ?? "");
  const accessToken = cookies[EPSON_ACCESS_COOKIE];
  const deviceId = cookies[EPSON_DEVICE_ID_COOKIE];

  if (!accessToken || !deviceId) {
    return res.status(200).json({
      status: "not_connected",
      message: "Not connected to Epson Connect",
      pendingJobs: 0,
      connected: false,
      recentJobs,
      today,
    });
  }

  try {
    const [device, pendingJobs] = await Promise.all([getDeviceInfo(accessToken), pollPendingJobs(accessToken)]);
    const connected = device.connected === true;

    let status: "online" | "busy" | "offline" = "offline";
    let message = "Printer offline";
    if (connected) {
      if (pendingJobs > 0) {
        status = "busy";
        message = `${pendingJobs} job${pendingJobs > 1 ? "s" : ""} pending`;
      } else {
        status = "online";
        message = "Ready";
      }
    }

    return res.status(200).json({
      status,
      message,
      pendingJobs,
      connected,
      productName: device.productName ?? "Printer",
      serialNumber: device.serialNumber,
      recentJobs,
      today,
      // Everything the Epson device-info call returned, unfiltered - there's
      // no raw "jobs list" to include since Epson has no such endpoint.
      raw: { device, pendingJobs },
    });
  } catch (err) {
    return res.status(200).json({
      status: "unknown",
      message: "Unable to reach printer",
      pendingJobs: 0,
      connected: false,
      recentJobs,
      today,
      raw: axios.isAxiosError(err) ? { error: err.response?.data ?? err.message } : undefined,
    });
  }
}
