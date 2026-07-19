import type { PaymentStatus } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Financial summary for dashboard (and future /finance pages).
 *
 * - Staff/Admin: facility-wide view (all documents).
 * - Customer: owner-scoped view only (their documents).
 *
 * Keep query + shape here so staff full view and customer billing view
 * can grow independently without duplicating Prisma filters.
 */
export type FinanceScope = "staff" | "customer";

export interface FinancePaymentRow {
  id: string;
  documentId: string;
  shortId: string;
  amount: number;
  status: PaymentStatus;
  paymentMethod: string | null;
  createdAt: string;
  updatedAt: string;
  recipientName: string;
  /** Staff-only: document owner email */
  ownerEmail: string | null;
}

export interface FinanceSummary {
  scope: FinanceScope;
  /** Sum of PAID payments updated today (local day). */
  paidToday: number;
  /** Sum of PAID payments updated this calendar month. */
  paidMonth: number;
  /** Sum of all PAID payments in scope. */
  paidAllTime: number;
  /** Count of PAID payments all-time. */
  paidCount: number;
  /** Sum of UNPAID amounts still open. */
  outstanding: number;
  /** Count of UNPAID payments. */
  unpaidCount: number;
  /** Count of FAILED payments (staff attention). */
  failedCount: number;
  /** Count of REFUNDED payments. */
  refundedCount: number;
  recentPayments: FinancePaymentRow[];
}

function startOfLocalDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfLocalMonth(d = new Date()): Date {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * @param ownerId - when set, limit to that customer's documents (customer view).
 *                  when null/undefined, all documents (staff full view).
 */
export async function getFinanceSummary(options: {
  ownerId?: string | null;
  recentLimit?: number;
}): Promise<FinanceSummary> {
  const ownerId = options.ownerId ?? null;
  const isCustomer = Boolean(ownerId);
  const scope: FinanceScope = isCustomer ? "customer" : "staff";
  const documentFilter = ownerId ? { ownerId } : {};
  const paymentWhere = { document: documentFilter };
  const recentLimit = options.recentLimit ?? (isCustomer ? 8 : 12);

  const dayStart = startOfLocalDay();
  const monthStart = startOfLocalMonth();

  const [
    paidTodayAgg,
    paidMonthAgg,
    paidAllAgg,
    outstandingAgg,
    unpaidCount,
    failedCount,
    refundedCount,
    recent,
  ] = await Promise.all([
    prisma.payment.aggregate({
      where: { ...paymentWhere, status: "PAID", updatedAt: { gte: dayStart } },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { ...paymentWhere, status: "PAID", updatedAt: { gte: monthStart } },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { ...paymentWhere, status: "PAID" },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.payment.aggregate({
      where: { ...paymentWhere, status: "UNPAID" },
      _sum: { amount: true },
    }),
    prisma.payment.count({ where: { ...paymentWhere, status: "UNPAID" } }),
    prisma.payment.count({ where: { ...paymentWhere, status: "FAILED" } }),
    prisma.payment.count({ where: { ...paymentWhere, status: "REFUNDED" } }),
    prisma.payment.findMany({
      where: paymentWhere,
      orderBy: { updatedAt: "desc" },
      take: recentLimit,
      include: {
        document: {
          select: {
            id: true,
            recipientName: true,
            // Staff ledger shows who paid; customers never see other owners.
            ...(isCustomer ? {} : { owner: { select: { email: true } } }),
          },
        },
      },
    }),
  ]);

  const recentPayments: FinancePaymentRow[] = recent.map((p) => {
    const doc = p.document as {
      recipientName: string;
      owner?: { email: string } | null;
    };
    return {
      id: p.id,
      documentId: p.documentId,
      shortId: p.documentId.slice(0, 8).toUpperCase(),
      amount: p.amount,
      status: p.status,
      paymentMethod: p.paymentMethod,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      recipientName: doc.recipientName,
      ownerEmail: doc.owner?.email ?? null,
    };
  });

  return {
    scope,
    paidToday: paidTodayAgg._sum.amount ?? 0,
    paidMonth: paidMonthAgg._sum.amount ?? 0,
    paidAllTime: paidAllAgg._sum.amount ?? 0,
    paidCount: paidAllAgg._count._all,
    outstanding: outstandingAgg._sum.amount ?? 0,
    unpaidCount,
    failedCount,
    refundedCount,
    recentPayments,
  };
}

export function formatZar(amount: number, fractionDigits = 2): string {
  return `R ${amount.toLocaleString("en-ZA", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

export function paymentStatusLabel(status: PaymentStatus): string {
  switch (status) {
    case "PAID":
      return "Paid";
    case "UNPAID":
      return "Due";
    case "FAILED":
      return "Failed";
    case "CANCELLED":
      return "Cancelled";
    case "REFUNDED":
      return "Refunded";
    default:
      return status;
  }
}
