import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

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

  return prisma.auditEvent.create({
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
}
