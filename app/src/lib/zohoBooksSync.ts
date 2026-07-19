import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { logSyncException } from "@/lib/syncExceptions";
import {
  createInvoice,
  findOrCreateContact,
  getInvoice,
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
      billingItem: { select: { name: true, zohoItemId: true } },
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
      const lineLabel = payment.billingItem?.name
        ? `${payment.billingItem.name} · #${ref}`
        : `PostNow dispatch fee · #${ref} · ${payment.document.recipientName} · ${payment.document.city}`;
      const invoice = await createInvoice({
        contactId: contact.contact_id,
        amount: payment.amount,
        reference: `PN-${ref}`,
        description: lineLabel,
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
        zohoBooksInvoiceStatus: payment.status === "PAID" ? "paid" : "sent",
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
    await logSyncException({
      source: "zoho_push",
      title: `Zoho push failed · payment ${paymentId.slice(0, 8)}`,
      detail: message,
      paymentId: payment.id,
      documentId: payment.documentId,
    });
    console.error("Zoho Books sync failed", { paymentId, message });
    return { ok: false, error: message };
  }
}

const AMOUNT_TOLERANCE = 0.05;

/**
 * Pull Zoho invoice status into PostNow.
 * If Books is fully paid and local is UNPAID → auto-mark PAID + audit.
 */
export async function pullPaymentFromZohoBooks(paymentId: string): Promise<{
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  zohoStatus?: string;
  localStatusChanged?: boolean;
  invoiceUrl?: string;
  error?: string;
}> {
  if (!zohoBooksConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { document: { select: { id: true } } },
  });
  if (!payment) return { ok: false, reason: "payment_not_found" };

  if (!payment.zohoBooksInvoiceId) {
    return { ok: true, skipped: true, reason: "no_invoice" };
  }

  try {
    const inv = await getInvoice(payment.zohoBooksInvoiceId);
    const zohoStatus = (inv.status || "").toLowerCase();
    const balance = typeof inv.balance === "number" ? inv.balance : null;
    const total = typeof inv.total === "number" ? inv.total : null;

    let localStatusChanged = false;
    const now = new Date();

    const data: {
      zohoBooksInvoiceStatus: string;
      zohoBooksBalance: number | null;
      zohoBooksLastPullAt: Date;
      zohoBooksSyncError: null;
      status?: "PAID";
      paymentMethod?: string;
      zohoBooksSyncedAt?: Date;
    } = {
      zohoBooksInvoiceStatus: zohoStatus,
      zohoBooksBalance: balance,
      zohoBooksLastPullAt: now,
      zohoBooksSyncError: null,
    };

    if (zohoStatus === "paid" && payment.status !== "PAID") {
      const amountOk =
        total == null || Math.abs(total - payment.amount) <= AMOUNT_TOLERANCE;
      if (amountOk) {
        data.status = "PAID";
        data.paymentMethod = payment.paymentMethod || "Zoho Books";
        data.zohoBooksSyncedAt = now;
        localStatusChanged = true;
      } else {
        await logSyncException({
          source: "zoho_pull",
          severity: "warn",
          title: `Amount mismatch on pull · ${paymentId.slice(0, 8)}`,
          detail: `Zoho total ${total} vs PostNow ${payment.amount}; not auto-marking PAID`,
          paymentId: payment.id,
          documentId: payment.documentId,
          metadata: { zohoStatus, total, localAmount: payment.amount },
        });
      }
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data,
    });

    if (localStatusChanged) {
      await appendAuditEvent({
        documentId: payment.documentId,
        action: "zoho_books_paid_inbound",
        metadata: {
          paymentId: payment.id,
          invoiceId: payment.zohoBooksInvoiceId,
          zohoStatus,
          amount: payment.amount,
          balance,
        },
      });
    }

    return {
      ok: true,
      zohoStatus,
      localStatusChanged,
      invoiceUrl: zohoBooksAppUrl(payment.zohoBooksInvoiceId),
    };
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? "Zoho pull failed";
    await prisma.payment.update({
      where: { id: payment.id },
      data: { zohoBooksSyncError: message },
    });
    await logSyncException({
      source: "zoho_pull",
      title: `Zoho pull failed · payment ${paymentId.slice(0, 8)}`,
      detail: message,
      paymentId: payment.id,
      documentId: payment.documentId,
    });
    await appendAuditEvent({
      documentId: payment.documentId,
      action: "zoho_books_sync_failed",
      metadata: { paymentId: payment.id, direction: "pull", error: message },
    });
    return { ok: false, error: message };
  }
}

export async function pullLinkedPaymentsFromZohoBooks(options?: {
  take?: number;
}): Promise<{
  ok: boolean;
  count: number;
  changed: number;
  results: Array<Awaited<ReturnType<typeof pullPaymentFromZohoBooks>> & { paymentId: string }>;
}> {
  const take = Math.min(options?.take ?? 50, 100);
  const rows = await prisma.payment.findMany({
    where: { zohoBooksInvoiceId: { not: null } },
    orderBy: { updatedAt: "desc" },
    take,
    select: { id: true },
  });
  const results = [];
  let changed = 0;
  for (const r of rows) {
    const res = await pullPaymentFromZohoBooks(r.id);
    if (res.localStatusChanged) changed += 1;
    results.push({ paymentId: r.id, ...res });
  }
  return { ok: true, count: results.length, changed, results };
}
