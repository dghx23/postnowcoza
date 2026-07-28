import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";

const REDACTED = "[REDACTED]";

/**
 * POPIA data subject rights, scoped per document (this app organizes
 * everything - audit trail, payments, print jobs - around Document, so
 * that's the natural unit here too). Deliberately NOT account-wide: a
 * customer with several documents would need this run per document. Full
 * account closure (removing login credentials across all their documents)
 * is a larger, separate operation this doesn't attempt.
 */
export async function exportDocumentPersonalData(documentId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      owner: { select: { email: true, createdAt: true } },
      payments: true,
      auditEvents: { orderBy: { createdAt: "asc" }, include: { actor: { select: { email: true } } } },
      subscribers: true,
    },
  });
  if (!document) throw new Error("Document not found");

  return {
    exportedAt: new Date().toISOString(),
    document: {
      id: document.id,
      status: document.status,
      createdAt: document.createdAt,
      recipient: {
        name: document.recipientName,
        phone: document.recipientPhone,
        email: document.recipientEmail,
      },
      deliveryAddress: {
        streetAddress: document.streetAddress,
        localArea: document.localArea,
        city: document.city,
        zone: document.zone,
        postalCode: document.postalCode,
        country: document.country,
      },
      returnPreference: document.returnPreference,
      printColorMode: document.printColorMode,
      printCopies: document.printCopies,
    },
    account: document.owner ? { email: document.owner.email, createdAt: document.owner.createdAt } : null,
    payments: document.payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      status: p.status,
      paymentMethod: p.paymentMethod,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    subscribers: document.subscribers.map((s) => ({
      channel: s.channel,
      destination: s.destination,
      createdAt: s.createdAt,
    })),
    auditTrail: document.auditEvents.map((e) => ({
      action: e.action,
      actor: e.actor?.email ?? null,
      createdAt: e.createdAt,
      metadata: e.metadata,
    })),
  };
}

/**
 * Redacts personal information on a document - recipient contact details,
 * delivery address, and any third-party subscribers - while deliberately
 * preserving Payment and AuditEvent history. Those exist for financial/
 * legal retention (tax records, the tamper-evident chain-of-custody trail
 * this product is built around) and POPIA itself allows retaining data
 * under a legitimate legal obligation despite an erasure request - this
 * isn't a loophole, it's the compliant middle ground between "delete
 * everything" and "delete nothing."
 */
export async function eraseDocumentPersonalData(input: {
  documentId: string;
  reason: string;
  actorId: string;
  ip?: string;
}): Promise<void> {
  if (!input.reason.trim()) {
    throw new Error("A reason is required to erase personal data");
  }

  const document = await prisma.document.findUnique({ where: { id: input.documentId } });
  if (!document) throw new Error("Document not found");

  // Logged before the mutation so the audit chain records the erasure
  // itself as an event - deliberately not embedding the values being
  // redacted, since that would defeat the point.
  await appendAuditEvent({
    documentId: document.id,
    actorId: input.actorId,
    action: "personal_data_erased",
    metadata: { reason: input.reason.trim() },
    ip: input.ip,
  });

  await prisma.documentSubscriber.deleteMany({ where: { documentId: document.id } });

  await prisma.document.update({
    where: { id: document.id },
    data: {
      recipientName: REDACTED,
      recipientPhone: REDACTED,
      recipientEmail: REDACTED,
      streetAddress: REDACTED,
      localArea: REDACTED,
      city: REDACTED,
      postalCode: REDACTED,
    },
  });
}
