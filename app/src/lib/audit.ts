import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { notifyDocumentSubscribers } from "@/lib/subscriberNotifications";

interface AppendDocumentAuditEventInput {
  documentId: string;
  dealId?: undefined;
  actorId?: string;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

interface AppendDealAuditEventInput {
  documentId?: undefined;
  dealId: string;
  actorId?: string;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

type AppendAuditEventInput = AppendDocumentAuditEventInput | AppendDealAuditEventInput;

// Appends a tamper-evident audit row: each row's hash covers its own fields
// plus the previous row's hash, so editing history breaks the chain.
//
// One of documentId/dealId must be set (never both) — matches the
// AuditEvent_owner_check CHECK constraint added in migration
// 20260131000000_midl_deal_model. The hash chain is scoped per-owner: a
// Deal's chain and a Document's chain never interleave.
export async function appendAuditEvent(input: AppendAuditEventInput) {
  const owner = input.documentId
    ? { documentId: input.documentId }
    : { dealId: input.dealId as string };

  const last = await prisma.auditEvent.findFirst({
    where: owner,
    orderBy: { createdAt: "desc" },
  });

  const prevHash = last?.hash ?? null;
  const payload = JSON.stringify({
    ...owner,
    actorId: input.actorId ?? null,
    action: input.action,
    metadata: input.metadata ?? null,
    prevHash,
  });
  const hash = createHash("sha256").update(payload).digest("hex");

  const event = await prisma.auditEvent.create({
    data: {
      ...owner,
      actorId: input.actorId,
      action: input.action,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
      ip: input.ip,
      prevHash,
      hash,
    },
  });

  // Subscriber notifications are a Document-only concept today (see
  // notifyDocumentSubscribers) — Deal notifications go through Midl's own
  // buyer/seller notification path (see BACKEND_DESIGN.md §8), not this.
  if (input.documentId && input.action.startsWith("status_changed:")) {
    const newStatus = input.action.split("->")[1];
    if (newStatus) {
      try {
        await notifyDocumentSubscribers(input.documentId, newStatus);
      } catch (err) {
        console.error("appendAuditEvent: subscriber notify failed", { documentId: input.documentId, error: (err as Error).message });
      }
    }
  }

  return event;
}
