import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { notifyDocumentSubscribers } from "@/lib/subscriberNotifications";

interface AppendAuditEventInput {
  documentId: string;
  actorId?: string;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

// Appends a tamper-evident audit row: each row's hash covers its own fields
// plus the previous row's hash, so editing history breaks the chain.
export async function appendAuditEvent(input: AppendAuditEventInput) {
  const last = await prisma.auditEvent.findFirst({
    where: { documentId: input.documentId },
    orderBy: { createdAt: "desc" },
  });

  const prevHash = last?.hash ?? null;
  const payload = JSON.stringify({
    documentId: input.documentId,
    actorId: input.actorId ?? null,
    action: input.action,
    metadata: input.metadata ?? null,
    prevHash,
  });
  const hash = createHash("sha256").update(payload).digest("hex");

  const event = await prisma.auditEvent.create({
    data: {
      documentId: input.documentId,
      actorId: input.actorId,
      action: input.action,
      metadata: input.metadata as Prisma.InputJsonValue | undefined,
      ip: input.ip,
      prevHash,
      hash,
    },
  });

  if (input.action.startsWith("status_changed:")) {
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
