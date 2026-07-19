import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import {
  fetchRecentMailboxMessages,
  isMailboxConfigured,
  mailboxConfigDiag,
  parseRawMessage,
} from "@/lib/zohoMailbox";

/**
 * Ingest Epson Connect notification emails from the Zoho print-agent mailbox
 * and reconcile EpsonPrintJob + document status / audit trail.
 */

/** Terminal statuses we no longer try to update from mail. */
const SETTLED = new Set(["completed", "error_occurred", "canceled", "expired"]);

export type EpsonNotifyKind =
  | "completed"
  | "error_occurred"
  | "expired"
  | "sent"
  | "unknown";

export interface ParsedEpsonNotification {
  kind: EpsonNotifyKind;
  documentId: string | null;
  subject: string;
  from: string;
  messageId: string | null;
  snippet: string;
  uid: number;
}

export function isImapConfigured(): boolean {
  return isMailboxConfigured();
}

export function imapConfigDiag() {
  return mailboxConfigDiag();
}

function classifyNotification(subject: string, text: string): EpsonNotifyKind {
  const hay = `${subject}\n${text}`.toLowerCase();

  if (
    /no printable data/.test(hay) ||
    /\b(print\s+)?(job\s+)?(failed|failure|error|rejected|unable to print|could not print)\b/.test(
      hay,
    ) ||
    /エラー|失敗/.test(hay)
  ) {
    return "error_occurred";
  }

  if (/\b(expired|expiration|expire[sd]?)\b/.test(hay) || /期限切れ/.test(hay)) {
    return "expired";
  }

  if (
    /\b(successfully\s+completed|print(ing)?\s+(job\s+)?completed|job\s+completed|completed successfully|print\s+complete)\b/.test(
      hay,
    ) ||
    /完了/.test(hay)
  ) {
    return "completed";
  }

  if (
    /\b(print\s+request\s+has\s+been\s+sent|sent\s+to\s+(your\s+)?printer|print\s+request\s+sent)\b/.test(
      hay,
    )
  ) {
    return "sent";
  }

  return "unknown";
}

const CUID_RE = /\b(c[a-z0-9]{20,32})\b/gi;

function extractDocumentId(subject: string, text: string): string | null {
  const hay = `${subject}\n${text}`;

  const postnowDoc = hay.match(/PostNow\s+document\s+([a-z0-9]+)/i);
  if (postnowDoc?.[1]) return postnowDoc[1];

  const jobName = hay.match(/postnow-([a-z0-9]+)/i);
  if (jobName?.[1]) return jobName[1];

  const ids = [...hay.matchAll(CUID_RE)].map((m) => m[1]!.toLowerCase());
  const uniq = [...new Set(ids)];
  if (uniq.length === 1) return uniq[0]!;
  return null;
}

function snippetOf(text: string, max = 280): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function isEpsonishMail(from: string, subject: string, text: string): boolean {
  const fromLower = from.toLowerCase();
  return (
    fromLower.includes("epson") ||
    fromLower.includes("epsonconnect") ||
    /print\s+(job|request)/i.test(subject) ||
    /epson/i.test(subject) ||
    /no printable data/i.test(text) ||
    /postnow\s+document/i.test(subject)
  );
}

export async function fetchEpsonNotificationEmails(options?: {
  limit?: number;
  includeSeen?: boolean;
}): Promise<ParsedEpsonNotification[] & { transport?: string }> {
  const { transport, messages } = await fetchRecentMailboxMessages({
    limit: options?.limit ?? 40,
    includeSeen: options?.includeSeen,
  });

  const out: ParsedEpsonNotification[] = [];

  for (const msg of messages) {
    if (msg.seen && !options?.includeSeen) continue;

    let parsed;
    try {
      parsed = await parseRawMessage(msg.source);
    } catch {
      continue;
    }

    const subject = parsed.subject ?? "";
    const from = parsed.from?.text ?? "";
    const text =
      parsed.text ||
      (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "") ||
      "";

    if (!isEpsonishMail(from, subject, text)) continue;

    const uidNum = Number(String(msg.uidOrId).replace(/\D/g, "")) || Date.now();

    out.push({
      kind: classifyNotification(subject, text),
      documentId: extractDocumentId(subject, text),
      subject,
      from,
      messageId: parsed.messageId ?? null,
      snippet: snippetOf(text),
      uid: uidNum,
    });
  }

  // Attach transport for diagnostics on the result object.
  Object.assign(out, { transport });
  return out as ParsedEpsonNotification[] & { transport?: string };
}

async function resolveDocumentId(candidate: string | null): Promise<string | null> {
  if (!candidate) return null;
  const exact = await prisma.document.findUnique({
    where: { id: candidate },
    select: { id: true },
  });
  if (exact) return exact.id;

  const matches = await prisma.document.findMany({
    where: { id: { startsWith: candidate } },
    take: 2,
    select: { id: true },
  });
  if (matches.length === 1) return matches[0]!.id;
  return null;
}

async function applyNotification(
  n: ParsedEpsonNotification,
): Promise<{ applied: boolean; reason: string; documentId?: string }> {
  if (n.kind === "unknown" || n.kind === "sent") {
    return { applied: false, reason: `ignored_kind:${n.kind}` };
  }

  const documentId = await resolveDocumentId(n.documentId);
  if (!documentId) {
    return { applied: false, reason: "no_document_match" };
  }

  let job = await prisma.epsonPrintJob.findFirst({
    where: { documentId, status: { notIn: [...SETTLED] } },
    orderBy: { createdAt: "desc" },
  });
  if (!job) {
    job = await prisma.epsonPrintJob.findFirst({
      where: { documentId },
      orderBy: { createdAt: "desc" },
    });
  }

  if (!job) {
    job = await prisma.epsonPrintJob.create({
      data: {
        documentId,
        jobId: `email-notify:${n.messageId ?? n.uid}:${Date.now()}`,
        status: "pending",
      },
    });
  }

  if (SETTLED.has(job.status) && job.status === n.kind) {
    return { applied: false, reason: "already_settled", documentId };
  }

  await prisma.epsonPrintJob.update({
    where: { id: job.id },
    data: { status: n.kind },
  });

  if (n.kind === "completed") {
    await appendAuditEvent({
      documentId,
      action: "epson_print_confirmed",
      metadata: {
        via: "email_notification",
        jobId: job.jobId,
        subject: n.subject,
        snippet: n.snippet,
        from: n.from,
      },
    });
    return { applied: true, reason: "completed", documentId };
  }

  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (doc?.status === "PRINTED") {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "QUEUED_FOR_PRINT" },
    });
    await appendAuditEvent({
      documentId,
      action: `status_changed:PRINTED->QUEUED_FOR_PRINT`,
      metadata: {
        via: "email_notification",
        reason: n.kind,
        subject: n.subject,
        snippet: n.snippet,
      },
    });
  }

  await appendAuditEvent({
    documentId,
    action: "epson_print_failed",
    metadata: {
      via: "email_notification",
      jobId: job.jobId,
      outcome: n.kind,
      subject: n.subject,
      snippet: n.snippet,
      from: n.from,
    },
  });

  return { applied: true, reason: n.kind, documentId };
}

export interface SyncEpsonNotificationsResult {
  configured: boolean;
  fetched: number;
  applied: number;
  transport?: string;
  results: Array<{
    uid: number;
    kind: EpsonNotifyKind;
    documentId: string | null;
    applied: boolean;
    reason: string;
    subject: string;
  }>;
  diag?: ReturnType<typeof mailboxConfigDiag>;
}

export async function syncEpsonNotifications(options?: {
  limit?: number;
  includeSeen?: boolean;
  markSeen?: boolean;
}): Promise<SyncEpsonNotificationsResult> {
  if (!isMailboxConfigured()) {
    return {
      configured: false,
      fetched: 0,
      applied: 0,
      results: [],
      diag: mailboxConfigDiag(),
    };
  }

  const notifications = await fetchEpsonNotificationEmails({
    limit: options?.limit,
    includeSeen: options?.includeSeen,
  });
  const transport = (notifications as { transport?: string }).transport;

  const results: SyncEpsonNotificationsResult["results"] = [];
  let applied = 0;

  for (const n of notifications) {
    const outcome = await applyNotification(n);
    if (outcome.applied) applied += 1;
    results.push({
      uid: n.uid,
      kind: n.kind,
      documentId: outcome.documentId ?? n.documentId,
      applied: outcome.applied,
      reason: outcome.reason,
      subject: n.subject,
    });
  }

  return {
    configured: true,
    fetched: notifications.length,
    applied,
    transport,
    results,
    diag: mailboxConfigDiag(),
  };
}

export async function syncIfPendingJobs(): Promise<SyncEpsonNotificationsResult | null> {
  if (!isMailboxConfigured()) return null;

  const pending = await prisma.epsonPrintJob.count({
    where: { status: { notIn: [...SETTLED] } },
  });
  if (pending === 0) return null;

  return syncEpsonNotifications({ limit: 40 });
}
