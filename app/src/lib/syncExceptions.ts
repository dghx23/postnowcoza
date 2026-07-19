import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export type SyncExceptionSource =
  | "zoho_push"
  | "zoho_pull"
  | "payment_structure"
  | "other";

export async function logSyncException(input: {
  source: SyncExceptionSource;
  title: string;
  detail?: string;
  severity?: "error" | "warn" | "info";
  paymentId?: string;
  documentId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.syncException.create({
      data: {
        source: input.source,
        severity: input.severity ?? "error",
        title: input.title.slice(0, 240),
        detail: input.detail?.slice(0, 4000) ?? null,
        paymentId: input.paymentId ?? null,
        documentId: input.documentId ?? null,
        metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    console.error("Failed to write SyncException", err);
  }
}

export async function listOpenSyncExceptions(take = 40) {
  return prisma.syncException.findMany({
    where: { resolved: false },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export async function resolveSyncException(id: string) {
  return prisma.syncException.update({
    where: { id },
    data: { resolved: true, resolvedAt: new Date() },
  });
}

export async function countOpenSyncExceptions() {
  return prisma.syncException.count({ where: { resolved: false } });
}
