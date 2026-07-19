import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";

/**
 * Ingest Epson Connect notification emails from the Zoho print-agent mailbox
 * (same inbox that sends Epson Direct Email Print jobs) and reconcile
 * EpsonPrintJob + document status / audit trail.
 *
 * Epson owner-notification subjects/bodies vary by locale; we match keywords
 * and extract the document id from:
 *   - Email Print subjects we set: "PostNow document <id>"
 *   - Connect job names: "postnow-<id>"
 *   - Bare cuid-looking tokens in the body/subject
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "imappro.zoho.com";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? "993");
const IMAP_USER =
  process.env.Zoho_PrintAgent_User ?? process.env.SMTP_USER ?? "";
const IMAP_PASSWORD = process.env.SMTP_PASSWORD ?? "";

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
  return Boolean(IMAP_USER && IMAP_PASSWORD);
}

function classifyNotification(subject: string, text: string): EpsonNotifyKind {
  const hay = `${subject}\n${text}`.toLowerCase();

  // Errors first — "no printable data", "failed", "error", etc.
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

/** cuid-ish tokens (PostNow uses Prisma @default(cuid())). */
const CUID_RE = /\b(c[a-z0-9]{20,32})\b/gi;

function extractDocumentId(subject: string, text: string): string | null {
  const hay = `${subject}\n${text}`;

  const postnowDoc = hay.match(/PostNow\s+document\s+([a-z0-9]+)/i);
  if (postnowDoc?.[1]) return postnowDoc[1];

  const jobName = hay.match(/postnow-([a-z0-9]+)/i);
  if (jobName?.[1]) return jobName[1];

  const ids = [...hay.matchAll(CUID_RE)].map((m) => m[1]!.toLowerCase());
  // Prefer longer unique tokens
  const uniq = [...new Set(ids)];
  if (uniq.length === 1) return uniq[0]!;
  return null;
}

function snippetOf(text: string, max = 280): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

async function openClient(): Promise<ImapFlow> {
  if (!isImapConfigured()) {
    throw new Error(
      "IMAP not configured (Zoho_PrintAgent_User / SMTP_PASSWORD)",
    );
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false,
  });

  await client.connect();
  return client;
}

/**
 * Fetch recent messages that look like Epson notifications.
 * Marks processed messages as Seen so we don't re-apply them.
 */
export async function fetchEpsonNotificationEmails(options?: {
  /** Max messages to inspect per run */
  limit?: number;
  /** Also re-read recent Seen mail (for debugging / backfill) */
  includeSeen?: boolean;
}): Promise<ParsedEpsonNotification[]> {
  const limit = options?.limit ?? 30;
  const client = await openClient();
  const out: ParsedEpsonNotification[] = [];

  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Last 7 days — Epson notifications are near-real-time.
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const uids = await client.search(
        options?.includeSeen
          ? { since }
          : { seen: false, since },
        { uid: true },
      );

      // search may return false | number[]
      const list = Array.isArray(uids) ? uids.slice(-limit) : [];

      for (const uid of list) {
        const msg = await client.fetchOne(
          String(uid),
          { source: true, envelope: true },
          { uid: true },
        );
        if (!msg || !msg.source) continue;

        const parsed = await simpleParser(msg.source as Buffer);
        const subject = parsed.subject ?? msg.envelope?.subject ?? "";
        const from =
          parsed.from?.text ??
          msg.envelope?.from?.map((a) => a.address ?? a.name).join(", ") ??
          "";
        const text =
          parsed.text ||
          (typeof parsed.html === "string"
            ? parsed.html.replace(/<[^>]+>/g, " ")
            : "") ||
          "";

        // Only act on Epson-looking mail (sender domain or keywords).
        const fromLower = from.toLowerCase();
        const isEpsonish =
          fromLower.includes("epson") ||
          fromLower.includes("epsonconnect") ||
          /print\s+(job|request)/i.test(subject) ||
          /epson/i.test(subject) ||
          /no printable data/i.test(text);

        if (!isEpsonish) continue;

        out.push({
          kind: classifyNotification(subject, text),
          documentId: extractDocumentId(subject, text),
          subject,
          from,
          messageId: parsed.messageId ?? null,
          snippet: snippetOf(text),
          uid: typeof uid === "number" ? uid : Number(uid),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  return out;
}

async function resolveDocumentId(candidate: string | null): Promise<string | null> {
  if (!candidate) return null;
  const exact = await prisma.document.findUnique({
    where: { id: candidate },
    select: { id: true },
  });
  if (exact) return exact.id;

  // Prefix match (spoken / truncated refs)
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
    // "sent" is informational — we already know we submitted. Don't settle yet.
    return { applied: false, reason: `ignored_kind:${n.kind}` };
  }

  const documentId = await resolveDocumentId(n.documentId);
  if (!documentId) {
    return { applied: false, reason: "no_document_match" };
  }

  // Prefer the latest unsettled job for this document; else latest job overall.
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
    // Create a synthetic row so the UI still shows the outcome.
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

  // Failure / expired — put the document back in the queue if still PRINTED
  // so staff can fix and re-print.
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
  results: Array<{
    uid: number;
    kind: EpsonNotifyKind;
    documentId: string | null;
    applied: boolean;
    reason: string;
    subject: string;
  }>;
}

/**
 * Full sync: pull IMAP notifications and apply them to jobs/documents.
 * Safe to call frequently — only unread mail is processed by default.
 */
export async function syncEpsonNotifications(options?: {
  limit?: number;
  includeSeen?: boolean;
  markSeen?: boolean;
}): Promise<SyncEpsonNotificationsResult> {
  if (!isImapConfigured()) {
    return { configured: false, fetched: 0, applied: 0, results: [] };
  }

  const notifications = await fetchEpsonNotificationEmails({
    limit: options?.limit,
    includeSeen: options?.includeSeen,
  });

  const results: SyncEpsonNotificationsResult["results"] = [];
  let applied = 0;
  const uidsToMark: number[] = [];

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
    // Mark seen even when ignored (unknown/sent) so we don't re-scan forever.
    uidsToMark.push(n.uid);
  }

  if (options?.markSeen !== false && uidsToMark.length > 0) {
    await markUidsSeen(uidsToMark);
  }

  return {
    configured: true,
    fetched: notifications.length,
    applied,
    results,
  };
}

async function markUidsSeen(uids: number[]): Promise<void> {
  if (uids.length === 0) return;
  const client = await openClient();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * Lightweight gate used by the status poller: only hit IMAP when there are
 * unsettled print jobs waiting for confirmation.
 */
export async function syncIfPendingJobs(): Promise<SyncEpsonNotificationsResult | null> {
  if (!isImapConfigured()) return null;

  const pending = await prisma.epsonPrintJob.count({
    where: { status: { notIn: [...SETTLED] } },
  });
  if (pending === 0) return null;

  return syncEpsonNotifications({ limit: 20 });
}
