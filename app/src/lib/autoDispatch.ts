import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { dispatchDocument } from "@/lib/dispatch";
import { nextBusinessCollectionDate } from "@/lib/payfast";

/**
 * After payment is confirmed:
 * - If the document is already PRINTED, book the outbound courier now
 *   (collection targeted for the next day where the API supports it).
 * - Otherwise leave a clear audit marker so print → dispatch can pick it up.
 */
export async function afterPaymentSucceeded(documentId: string) {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) return { booked: false, reason: "document_not_found" as const };

  const collectionDate = nextBusinessCollectionDate();

  await appendAuditEvent({
    documentId,
    action: "payment_received",
    metadata: {
      provider: "payfast",
      schedule_collection: collectionDate,
      note: "Courier collection to be booked for next day once printed (or immediately if already printed)",
    },
  });

  if (document.status === "PRINTED") {
    try {
      // Use system actor — payment webhook has no session user.
      const systemUser = await prisma.user.findFirst({
        where: { role: { in: ["ADMIN", "STAFF"] } },
        orderBy: { createdAt: "asc" },
      });
      const actorId = systemUser?.id ?? document.ownerId;
      const shipment = await dispatchDocument(documentId, actorId, {
        collectionMinDate: collectionDate,
      });
      await appendAuditEvent({
        documentId,
        action: "auto_dispatch_after_payment",
        metadata: {
          collection_min_date: collectionDate,
          tracking_reference: shipment.tracking_reference,
        },
      });
      return { booked: true, collectionDate, tracking: shipment.tracking_reference };
    } catch (err) {
      await appendAuditEvent({
        documentId,
        action: "auto_dispatch_failed",
        metadata: {
          collection_min_date: collectionDate,
          error: (err as Error).message,
        },
      });
      return { booked: false, reason: "dispatch_failed" as const, error: (err as Error).message };
    }
  }

  // Not printed yet — flag for auto-dispatch when status hits PRINTED.
  await appendAuditEvent({
    documentId,
    action: "auto_dispatch_queued",
    metadata: {
      collection_min_date: collectionDate,
      wait_for: "PRINTED",
    },
  });

  return { booked: false, reason: "awaiting_print" as const, collectionDate };
}

/** Call from print/status transitions when document becomes PRINTED. */
export async function maybeAutoDispatchIfPaid(documentId: string, actorId: string) {
  const payment = await prisma.payment.findFirst({
    where: { documentId, status: "PAID" },
    orderBy: { createdAt: "desc" },
  });
  if (!payment) return null;

  const existingShipment = await prisma.bobgoShipment.findFirst({
    where: { documentId, direction: "OUTBOUND" },
  });
  if (existingShipment) return null;

  const collectionDate = nextBusinessCollectionDate();
  try {
    const shipment = await dispatchDocument(documentId, actorId, {
      collectionMinDate: collectionDate,
    });
    await appendAuditEvent({
      documentId,
      actorId,
      action: "auto_dispatch_after_print",
      metadata: {
        collection_min_date: collectionDate,
        tracking_reference: shipment.tracking_reference,
        triggered_by: "print_complete_with_paid",
      },
    });
    return shipment;
  } catch (err) {
    await appendAuditEvent({
      documentId,
      actorId,
      action: "auto_dispatch_failed",
      metadata: { error: (err as Error).message, collection_min_date: collectionDate },
    });
    return null;
  }
}
