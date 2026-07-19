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

const IMAP_HOST = (process.env.IMAP_HOST ?? "imappro.zoho.com").trim();
const IMAP_PORT = Number(process.env.IMAP_PORT ?? "993");
// Trim — Vercel env paste often leaves trailing newlines that break IMAP AUTH.
const IMAP_USER = (
  process.env.Zoho_PrintAgent_User ??
  process.env.SMTP_USER ??
  ""
).trim();
const IMAP_PASSWORD = (process.env.SMTP_PASSWORD ?? "").trim();

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

/** Safe diagnostics for the UI / API when IMAP fails (no secrets). */
export function imapConfigDiag() {
  return {
    host: IMAP_HOST,
    port: IMAP_PORT,
    userSet: Boolean(IMAP_USER),
    userLooksLikeEmail: IMAP_USER.includes("@"),
    userLength: IMAP_USER.length,
    passwordSet: Boolean(IMAP_PASSWORD),
    passwordLength: IMAP_PASSWORD.length,
  };
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
  const uniq = [...new Set(ids)];
  if (uniq.length === 1) return uniq[0]!;
  return null;
}

function snippetOf(text: string, max = 280): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function formatImapError(stage: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const diag = imapConfigDiag();
  // ImapFlow often surfaces a bare "Command failed" — add context.
  return new Error(
    `IMAP ${stage} failed (${diag.host}:${diag.port}, user=${diag.userSet ? `${diag.userLength}ch${diag.userLooksLikeEmail ? "" : " (!email)"}` : "MISSING"}, pass=${diag.passwordSet ? `${diag.passwordLength}ch` : "MISSING"}): ${msg}`,
  );
}

async function openClient(): Promise<ImapFlow> {
  if (!isImapConfigured()) {
    throw new Error(
      "IMAP not configured — set Zoho_PrintAgent_User and SMTP_PASSWORD in Vercel (same mailbox as Email Print SMTP)",
    );
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
    logger: false,
    // Serverless-friendly: fail fast rather than hanging the function.
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

  try {
    await client.connect();
  } catch (err) {
    // Common Zoho mix-up: personal imap.zoho.com vs org imappro.zoho.com
    if (
      IMAP_HOST === "imappro.zoho.com" &&
      !process.env.IMAP_HOST // only auto-fallback when host wasn't overridden
    ) {
      try {
        await client.logout().catch(() => undefined);
      } catch {
        /* ignore */
      }
      const fallback = new ImapFlow({
        host: "imap.zoho.com",
        port: IMAP_PORT,
        secure: true,
        auth: { user: IMAP_USER, pass: IMAP_PASSWORD },
        logger: false,
        connectionTimeout: 20_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      });
      try {
        await fallback.connect();
        return fallback;
      } catch (err2) {
        throw formatImapError(
          "connect",
          new Error(
            `imappro.zoho.com → ${(err as Error).message}; imap.zoho.com → ${(err2 as Error).message}. ` +
              `Enable IMAP in Zoho Mail settings, confirm the password is the mailbox app/SMTP password, ` +
              `and set IMAP_HOST if your region uses a different host.`,
          ),
        );
      }
    }
    throw formatImapError("connect", err);
  }

  return client;
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

/**
 * Fetch recent messages that look like Epson notifications.
 *
 * Avoids IMAP SEARCH (Zoho often returns bare "Command failed" for combined
 * criteria). Instead we fetch the last N messages by sequence range and
 * filter in process.
 */
export async function fetchEpsonNotificationEmails(options?: {
  /** Max messages to inspect per run */
  limit?: number;
  /** Also re-read recent Seen mail (for debugging / backfill) */
  includeSeen?: boolean;
}): Promise<ParsedEpsonNotification[]> {
  const limit = options?.limit ?? 40;
  const includeSeen = options?.includeSeen ?? false;
  const client = await openClient();
  const out: ParsedEpsonNotification[] = [];
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  try {
    let lock;
    try {
      lock = await client.getMailboxLock("INBOX");
    } catch (err) {
      throw formatImapError("select INBOX", err);
    }

    try {
      const mailbox = client.mailbox;
      const total = mailbox && mailbox !== false ? mailbox.exists : 0;
      if (total === 0) return out;

      // Sequence range of the newest messages (1-based inclusive).
      const start = Math.max(1, total - limit + 1);
      const range = `${start}:${total}`;

      try {
        for await (const msg of client.fetch(range, {
          uid: true,
          source: true,
          envelope: true,
          flags: true,
          internalDate: true,
        })) {
          const flags = msg.flags ?? new Set<string>();
          const seen = flags.has("\\Seen");
          if (!includeSeen && seen) continue;

          const internal =
            msg.internalDate instanceof Date
              ? msg.internalDate.getTime()
              : msg.internalDate
                ? new Date(msg.internalDate).getTime()
                : Date.now();
          if (internal < sevenDaysAgo) continue;

          if (!msg.source) continue;

          let parsed;
          try {
            parsed = await simpleParser(
              Buffer.isBuffer(msg.source)
                ? msg.source
                : Buffer.from(msg.source as string),
            );
          } catch {
            continue;
          }

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

          if (!isEpsonishMail(from, subject, text)) continue;

          out.push({
            kind: classifyNotification(subject, text),
            documentId: extractDocumentId(subject, text),
            subject,
            from,
            messageId: parsed.messageId ?? null,
            snippet: snippetOf(text),
            uid: typeof msg.uid === "number" ? msg.uid : Number(msg.uid),
          });
        }
      } catch (err) {
        throw formatImapError("fetch recent mail", err);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  // Newest first for apply order stability.
  out.sort((a, b) => b.uid - a.uid);
  return out;
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
  results: Array<{
    uid: number;
    kind: EpsonNotifyKind;
    documentId: string | null;
    applied: boolean;
    reason: string;
    subject: string;
  }>;
  diag?: ReturnType<typeof imapConfigDiag>;
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
    return {
      configured: false,
      fetched: 0,
      applied: 0,
      results: [],
      diag: imapConfigDiag(),
    };
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
    diag: imapConfigDiag(),
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

  return syncEpsonNotifications({ limit: 40 });
}
