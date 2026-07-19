import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";

/** Find-or-create the draft (UNPAID) Payment row for a document's dispatch fee. */
async function ensureDraftPayment(documentId: string) {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) throw new Error("Document not found");

  const existingResolved = await prisma.payment.findFirst({
    where: { documentId, status: { in: ["PAID", "WAIVED", "CANCELLED"] } },
    orderBy: { createdAt: "desc" },
  });
  if (existingResolved) {
    throw new Error(`This dispatch fee is already ${existingResolved.status.toLowerCase()}`);
  }

  let fee = document.dispatchFee;
  if (fee == null || fee <= 0) {
    fee = Number(process.env.DEFAULT_DISPATCH_FEE ?? "149") || 149;
    await prisma.document.update({ where: { id: document.id }, data: { dispatchFee: fee } });
  }

  let payment = await prisma.payment.findFirst({
    where: { documentId, status: "UNPAID" },
    orderBy: { createdAt: "desc" },
  });
  if (!payment) {
    payment = await prisma.payment.create({
      data: {
        documentId,
        customPaymentId: `pn-${documentId.slice(0, 12)}-${Date.now().toString(36)}`,
        amount: fee,
        status: "UNPAID",
        paymentMethod: "payfast",
      },
    });
  }
  return { document, payment };
}

/** Staff cancels a manual entry's payment request instead of sending it. */
export async function cancelManualPayment(input: {
  documentId: string;
  justification: string;
  isTestEntry: boolean;
  actorId?: string;
  ip?: string;
}): Promise<void> {
  if (!input.justification.trim()) {
    throw new Error("Justification is required to cancel");
  }
  const { document, payment } = await ensureDraftPayment(input.documentId);

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: "CANCELLED",
      manualEntryJustification: input.justification.trim(),
      cancelledJustification: input.justification.trim(),
      isTestEntry: input.isTestEntry,
    },
  });

  await appendAuditEvent({
    documentId: document.id,
    actorId: input.actorId,
    action: "payment_request_cancelled",
    metadata: {
      paymentId: payment.id,
      justification: input.justification.trim(),
      isTestEntry: input.isTestEntry,
    },
    ip: input.ip,
  });
}

/**
 * Staff processes a manual entry at no cost (at PostNow's expense). The
 * document proceeds as if paid, but this is tracked as a loss, not revenue -
 * deliberately not pushed to Zoho Books automatically (see TECH_SPEC 6.2.6),
 * since whether a write-off should be reflected there is an accounting
 * decision, not one this code should make silently.
 */
export async function waivePayment(input: {
  documentId: string;
  justification: string;
  amount: number;
  isTestEntry: boolean;
  actorId?: string;
  ip?: string;
}): Promise<void> {
  if (!input.justification.trim()) {
    throw new Error("Justification is required to process at no cost");
  }
  if (!(input.amount > 0)) {
    throw new Error("Enter the exact loss amount");
  }
  const { document, payment } = await ensureDraftPayment(input.documentId);

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: "WAIVED",
      manualEntryJustification: input.justification.trim(),
      waivedJustification: input.justification.trim(),
      waivedAmount: input.amount,
      isTestEntry: input.isTestEntry,
    },
  });

  await appendAuditEvent({
    documentId: document.id,
    actorId: input.actorId,
    action: "payment_waived",
    metadata: {
      paymentId: payment.id,
      justification: input.justification.trim(),
      amount: input.amount,
      isTestEntry: input.isTestEntry,
    },
    ip: input.ip,
  });
}
