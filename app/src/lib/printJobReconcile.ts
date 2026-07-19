import { prisma } from "@/lib/db";
import { getJobStatus, getValidDeviceSession } from "@/lib/epson";
import { applyConnectJobNotification, normalizeEpsonJobStatus } from "@/lib/epsonJobWebhook";
import { syncEpsonNotifications, isImapConfigured } from "@/lib/epsonNotifications";

const SETTLED = new Set(["completed", "error_occurred", "canceled", "expired"]);

function isEmailJob(jobId: string) {
  return jobId.startsWith("email-print:") || jobId.startsWith("email-notify:") || jobId.startsWith("manual-mark:");
}

/**
 * Cross-match platform print submissions with printer feedback:
 * - Epson Connect API jobs → live GET /printing/jobs/{jobId}
 * - Email Print jobs → IMAP/POP owner-notification sync
 *
 * Safe to call from Print Queue refresh or staff actions.
 */
export async function reconcilePrintJobs(options?: {
  /** Max in-flight Connect jobs to poll (default 15) */
  connectLimit?: number;
  /** Also pull mailbox even if no email jobs pending */
  forceMailbox?: boolean;
}): Promise<{
  connectPolled: number;
  connectUpdated: number;
  mailboxFetched: number;
  mailboxApplied: number;
  mailboxConfigured: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  let connectPolled = 0;
  let connectUpdated = 0;
  let mailboxFetched = 0;
  let mailboxApplied = 0;

  const pending = await prisma.epsonPrintJob.findMany({
    where: { status: { notIn: [...SETTLED] } },
    orderBy: { updatedAt: "desc" },
    take: 40,
  });

  const connectPending = pending.filter((j) => !isEmailJob(j.jobId));
  const emailPending = pending.filter(
    (j) => j.jobId.startsWith("email-print:") || j.jobId.startsWith("email-notify:")
  );

  // ── Connect API live status ──────────────────────────────────────────
  if (connectPending.length > 0) {
    const session = await getValidDeviceSession();
    if (!session?.accessToken) {
      errors.push("Epson Connect not linked — cannot poll Connect job status");
    } else {
      const limit = options?.connectLimit ?? 15;
      for (const job of connectPending.slice(0, limit)) {
        connectPolled += 1;
        try {
          const live = await getJobStatus(session.accessToken, job.jobId);
          const status = normalizeEpsonJobStatus(live.status);
          if (status && status !== job.status) {
            const result = await applyConnectJobNotification({
              jobId: job.jobId,
              status,
              statusReason: null,
              updateDate: live.updateDate ?? null,
              raw: { source: "poll", ...live },
            });
            if (result.applied) connectUpdated += 1;
          }
        } catch (err) {
          // Job may have expired on Epson — mark expired if 404-ish
          const msg = (err as Error).message ?? "poll failed";
          const status = (err as { response?: { status?: number } }).response?.status;
          if (status === 404) {
            await applyConnectJobNotification({
              jobId: job.jobId,
              status: "expired",
              statusReason: "job_not_found_on_epson",
              updateDate: null,
              raw: { source: "poll", error: msg },
            });
            connectUpdated += 1;
          } else {
            errors.push(`job ${job.jobId.slice(0, 12)}…: ${msg}`);
          }
        }
      }
    }
  }

  // ── Email Print / owner mailbox ──────────────────────────────────────
  const mailboxConfigured = isImapConfigured();
  if (mailboxConfigured && (emailPending.length > 0 || options?.forceMailbox)) {
    try {
      const sync = await syncEpsonNotifications({ includeSeen: true, limit: 40 });
      mailboxFetched = sync.fetched;
      mailboxApplied = sync.applied;
      if (!sync.configured) {
        errors.push("Mailbox not fully configured");
      }
    } catch (err) {
      errors.push(`Mailbox: ${(err as Error).message}`);
    }
  } else if (emailPending.length > 0 && !mailboxConfigured) {
    errors.push("Email print jobs pending but Zoho IMAP/POP is not configured");
  }

  return {
    connectPolled,
    connectUpdated,
    mailboxFetched,
    mailboxApplied,
    mailboxConfigured,
    errors,
  };
}
