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

export interface ZohoSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  contactId?: string;
  invoiceId?: string;
  paymentId?: string;
  invoiceUrl?: string;
  error?: string;
}

interface ZohoSyncEntity {
  contact: { name: string; email: string; phone?: string };
  amount: number;
  reference: string;
  description: string;
  isPaid: boolean;
  paymentMethod?: string | null;
  existing: {
    zohoBooksContactId: string | null;
    zohoBooksInvoiceId: string | null;
    zohoBooksPaymentId: string | null;
  };
}

/**
 * Shared PostNow Group → Zoho Books core: contact → invoice → customer
 * payment (if paid). One Zoho Books org ("PostNow ZA") serves every product
 * — this function doesn't know or care which product's row it's syncing,
 * it just needs a contact + amount + reference + description and the
 * caller's existing Zoho IDs (for idempotency). Product-specific wrappers
 * below (syncPaymentToZohoBooks, syncCourierBookingToZohoBooks,
 * syncShoppingOrderToZohoBooks) adapt each product's own model into this
 * shape and persist the result back onto their own row.
 */
async function pushToZohoBooks(entity: ZohoSyncEntity): Promise<ZohoSyncResult & { newState?: { contactId: string; invoiceId: string; paymentId?: string } }> {
  const contact = entity.existing.zohoBooksContactId
    ? { contact_id: entity.existing.zohoBooksContactId }
    : await findOrCreateContact({ name: entity.contact.name, email: entity.contact.email, phone: entity.contact.phone });

  let invoiceId = entity.existing.zohoBooksInvoiceId;
  if (!invoiceId) {
    const invoice = await createInvoice({
      contactId: contact.contact_id,
      amount: entity.amount,
      reference: entity.reference,
      description: entity.description,
    });
    invoiceId = invoice.invoice_id;
  }

  let booksPaymentId = entity.existing.zohoBooksPaymentId ?? undefined;
  if (entity.isPaid && !booksPaymentId) {
    const pay = await markInvoicePaid({
      invoiceId,
      contactId: contact.contact_id,
      amount: entity.amount,
      paymentMode: entity.paymentMethod || "PostNow",
      reference: entity.reference,
    });
    booksPaymentId = pay.payment_id;
  }

  return {
    ok: true,
    contactId: contact.contact_id,
    invoiceId,
    paymentId: booksPaymentId,
    invoiceUrl: zohoBooksAppUrl(invoiceId),
    newState: { contactId: contact.contact_id, invoiceId, paymentId: booksPaymentId },
  };
}

/**
 * Push a PostNow E2 Payment into Zoho Books.
 * Idempotent when zohoBooksInvoiceId already set.
 */
export async function syncPaymentToZohoBooks(paymentId: string): Promise<ZohoSyncResult> {
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
    const ref = payment.documentId.slice(0, 10).toUpperCase();
    const description = payment.billingItem?.name
      ? `${payment.billingItem.name} · #${ref}`
      : `PostNow dispatch fee · #${ref} · ${payment.document.recipientName} · ${payment.document.city}`;

    const result = await pushToZohoBooks({
      contact: {
        name: payment.document.recipientName,
        email: payment.document.recipientEmail,
        phone: payment.document.recipientPhone,
      },
      amount: payment.amount,
      reference: `PN-${ref}`,
      description,
      isPaid: payment.status === "PAID",
      paymentMethod: payment.paymentMethod || "PayFast",
      existing: {
        zohoBooksContactId: payment.zohoBooksContactId,
        zohoBooksInvoiceId: payment.zohoBooksInvoiceId,
        zohoBooksPaymentId: payment.zohoBooksPaymentId,
      },
    });

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        zohoBooksContactId: result.newState!.contactId,
        zohoBooksInvoiceId: result.newState!.invoiceId,
        zohoBooksPaymentId: result.newState!.paymentId ?? null,
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
        contactId: result.contactId,
        invoiceId: result.invoiceId,
        booksPaymentId: result.paymentId ?? null,
        status: payment.status,
        invoiceUrl: result.invoiceUrl,
      },
    });

    return result;
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

/**
 * Push a PostNow Express CourierBooking into Zoho Books, tagged product=EXPRESS
 * via the "PN Express" reference prefix (Books has no first-class product
 * field, so this keeps products distinguishable in the ledger by reference/
 * description alone). Idempotent when zohoBooksInvoiceId already set.
 */
export async function syncCourierBookingToZohoBooks(bookingId: string): Promise<ZohoSyncResult> {
  if (!zohoBooksConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }

  const booking = await prisma.courierBooking.findUnique({ where: { id: bookingId } });
  if (!booking) return { ok: false, reason: "booking_not_found" };
  if (!booking.price) return { ok: false, reason: "no_price_set" };

  if (booking.zohoBooksInvoiceId && booking.status === "PAID" && booking.zohoBooksPaymentId) {
    return {
      ok: true,
      skipped: true,
      reason: "already_synced",
      contactId: booking.zohoBooksContactId ?? undefined,
      invoiceId: booking.zohoBooksInvoiceId,
      paymentId: booking.zohoBooksPaymentId,
      invoiceUrl: zohoBooksAppUrl(booking.zohoBooksInvoiceId),
    };
  }

  try {
    const ref = booking.bookingRef;
    const result = await pushToZohoBooks({
      contact: {
        name: booking.recipientName || `WhatsApp ${booking.senderPhone}`,
        // Express bookings come from WhatsApp — no email captured today, so
        // Zoho gets a synthetic placeholder tied to the sender's number.
        email: `${booking.senderPhone}@express.postnow.co.za`,
        phone: booking.senderPhone,
      },
      amount: booking.price,
      reference: ref,
      description: `PostNow Express courier · ${ref} · ${booking.recipientName ?? booking.senderPhone}`,
      isPaid: booking.status === "PAID",
      paymentMethod: "PayShap",
      existing: {
        zohoBooksContactId: booking.zohoBooksContactId,
        zohoBooksInvoiceId: booking.zohoBooksInvoiceId,
        zohoBooksPaymentId: booking.zohoBooksPaymentId,
      },
    });

    await prisma.courierBooking.update({
      where: { id: booking.id },
      data: {
        zohoBooksContactId: result.newState!.contactId,
        zohoBooksInvoiceId: result.newState!.invoiceId,
        zohoBooksPaymentId: result.newState!.paymentId ?? null,
        zohoBooksSyncedAt: new Date(),
        zohoBooksSyncError: null,
        zohoBooksInvoiceStatus: booking.status === "PAID" ? "paid" : "sent",
      },
    });

    return result;
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? "Zoho sync failed";
    await prisma.courierBooking.update({
      where: { id: booking.id },
      data: { zohoBooksSyncError: message },
    });
    await logSyncException({
      source: "zoho_push",
      title: `Zoho push failed · Express booking ${booking.bookingRef}`,
      detail: message,
      metadata: { product: "EXPRESS", bookingId: booking.id, bookingRef: booking.bookingRef },
    });
    console.error("Zoho Books sync failed (CourierBooking)", { bookingId, message });
    return { ok: false, error: message };
  }
}

/**
 * Push a GlobeMe ShoppingOrder into Zoho Books. Idempotent when
 * zohoBooksInvoiceId already set.
 */
export async function syncShoppingOrderToZohoBooks(orderId: string): Promise<ZohoSyncResult> {
  if (!zohoBooksConfigured()) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }

  const order = await prisma.shoppingOrder.findUnique({ where: { id: orderId } });
  if (!order) return { ok: false, reason: "order_not_found" };
  if (order.finalQuoteZar == null) return { ok: false, reason: "no_price_set" };

  if (order.zohoBooksInvoiceId && order.status === "PAID" && order.zohoBooksPaymentId) {
    return {
      ok: true,
      skipped: true,
      reason: "already_synced",
      contactId: order.zohoBooksContactId ?? undefined,
      invoiceId: order.zohoBooksInvoiceId,
      paymentId: order.zohoBooksPaymentId,
      invoiceUrl: zohoBooksAppUrl(order.zohoBooksInvoiceId),
    };
  }

  try {
    const ref = order.orderRef;
    const result = await pushToZohoBooks({
      contact: {
        name: order.recipientName,
        email: order.customerEmail,
        phone: order.customerPhone ?? order.recipientPhone,
      },
      amount: order.finalQuoteZar,
      reference: ref,
      description: `GlobeMe import · ${ref} · ${order.productName ?? order.productUrl}`,
      isPaid: order.status === "PAID",
      paymentMethod: "PayFast",
      existing: {
        zohoBooksContactId: order.zohoBooksContactId,
        zohoBooksInvoiceId: order.zohoBooksInvoiceId,
        zohoBooksPaymentId: order.zohoBooksPaymentId,
      },
    });

    await prisma.shoppingOrder.update({
      where: { id: order.id },
      data: {
        zohoBooksContactId: result.newState!.contactId,
        zohoBooksInvoiceId: result.newState!.invoiceId,
        zohoBooksPaymentId: result.newState!.paymentId ?? null,
        zohoBooksSyncedAt: new Date(),
        zohoBooksSyncError: null,
        zohoBooksInvoiceStatus: order.status === "PAID" ? "paid" : "sent",
      },
    });

    return result;
  } catch (err) {
    const message = (err as Error).message?.slice(0, 500) ?? "Zoho sync failed";
    await prisma.shoppingOrder.update({
      where: { id: order.id },
      data: { zohoBooksSyncError: message },
    });
    await logSyncException({
      source: "zoho_push",
      title: `Zoho push failed · GlobeMe order ${order.orderRef}`,
      detail: message,
      metadata: { product: "GLOBEME", orderId: order.id, orderRef: order.orderRef },
    });
    console.error("Zoho Books sync failed (ShoppingOrder)", { orderId, message });
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
