import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import {
  createInvoice,
  findOrCreateContact,
  markInvoicePaid,
  zohoBooksAppUrl,
  zohoBooksConfigured,
} from "@/lib/zohoBooks";

/**
 * Push a PostNow Payment into Zoho Books:
 * contact (customer) → invoice → customer payment (if PAID).
 * Idempotent when zohoBooksInvoiceId already set.
 */
export async function syncPaymentToZohoBooks(paymentId: string): Promise<{
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  contactId?: string;
  invoiceId?: string;
  paymentId?: string;
  invoiceUrl?: string;
  error?: string;
}> {
  if (!zohoBooksConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      document: {
        select: {
          id: true,
          recipientName: true,
          recipientEmail: true,
          recipientPhone: true,
          streetAddress: true,
          city: true,
          postalCode: true,
        },
      },
    },
  });

  if (!payment) return { ok: false, reason: "payment_not_found" };

  if (payment.zohoBooksInvoiceId && payment.status === "PAID" && payment.zohoBooksPaymentId) {
    return {
      ok: true,
      skipped: true,
      reason: "already_synced",
      contactId: payment.zohoBooksContactId ?? undefined,
      invoiceId: payment.zohoBooksInvoiceId,
      paymentId: payment.zohoBooksPaymentId,
      invoiceUrl: zohoBooksAppUrl(payment.zohoBooksInvoiceId),
    };
  }

  try {
    const contact =
      payment.zohoBooksContactId
        ? { contact_id: payment.zohoBooksContactId }
        : await findOrCreateContact({
            name: payment.document.recipientName,
            email: payment.document.recipientEmail,
            phone: payment.document.recipientPhone,
          });

    let invoiceId = payment.zohoBooksInvoiceId;
    if (!invoiceId) {
      const ref = payment.documentId.slice(0, 10).toUpperCase();
      const invoice = await createInvoice({
        contactId: contact.contact_id,
        amount: payment.amount,
        reference: `PN-${ref}`,
        description: `PostNow dispatch fee · #${ref} · ${payment.document.recipientName} · ${payment.document.city}`,
      });
      invoiceId = invoice.invoice_id;
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          zohoBooksContactId: contact.contact_id,
          zohoBooksInvoiceId: invoiceId,
          zohoBooksSyncError: null,
        },
      });
    }

    let booksPaymentId = payment.zohoBooksPaymentId ?? undefined;
    if (payment.status === "PAID" && !booksPaymentId) {
      const pay = await markInvoicePaid({
        invoiceId,
        contactId: contact.contact_id,
        amount: payment.amount,
        paymentMode: payment.paymentMethod || "PayFast",
        reference: payment.customPaymentId,
      });
      booksPaymentId = pay.payment_id;
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        zohoBooksContactId: contact.contact_id,
        zohoBooksInvoiceId: invoiceId,
        zohoBooksPaymentId: booksPaymentId ?? null,
        zohoBooksSyncedAt: new Date(),
        zohoBooksSyncError: null,
      },
    });

    await appendAuditEvent({
      documentId: payment.documentId,
      action: "zoho_books_synced",
      metadata: {
        paymentId: payment.id,
        contactId: contact.contact_id,
        invoiceId,
        booksPaymentId: booksPaymentId ?? null,
        status: payment.status,
        invoiceUrl: zohoBooksAppUrl(invoiceId),
      },
    });

    return {
      ok: true,
      contactId: contact.contact_id,
      invoiceId,
      paymentId: booksPaymentId,
      invoiceUrl: zohoBooksAppUrl(invoiceId),
    };
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? "Zoho sync failed";
    await prisma.payment.update({
      where: { id: payment.id },
      data: { zohoBooksSyncError: message },
    });
    await appendAuditEvent({
      documentId: payment.documentId,
      action: "zoho_books_sync_failed",
      metadata: { paymentId: payment.id, error: message },
    });
    console.error("Zoho Books sync failed", { paymentId, message });
    return { ok: false, error: message };
  }
}
