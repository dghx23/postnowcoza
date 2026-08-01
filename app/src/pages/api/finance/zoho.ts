import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { getZohoBooksPublicConfig, zohoBooksConfigured } from "@/lib/zohoBooks";
import {
  pullLinkedPaymentsFromZohoBooks,
  pullPaymentFromZohoBooks,
  syncCourierBookingToZohoBooks,
  syncPaymentToZohoBooks,
  syncShoppingOrderToZohoBooks,
} from "@/lib/zohoBooksSync";
import { prisma } from "@/lib/db";

/**
 * GET  — Zoho Books config status + app URL for finance UI links
 * POST — push / pull:
 *   { paymentId }              push one E2 payment
 *   { allUnsynced: true }      push recent PAID without full Books mapping —
 *                              across all three products (E2 Payment,
 *                              Express CourierBooking, GlobeMe ShoppingOrder)
 *   { pull: true, paymentId }  pull one linked invoice (E2 only — Express/
 *                              GlobeMe don't have a pull path yet)
 *   { pullAll: true }          pull all linked E2 invoices (capped)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method === "GET") {
    return res.status(200).json(getZohoBooksPublicConfig());
  }

  if (req.method === "POST") {
    if (!zohoBooksConfigured()) {
      return res.status(503).json({
        error:
          "Zoho Books is not configured. Set ZOHO_BOOKS_CLIENT_ID, ZOHO_BOOKS_CLIENT_SECRET, ZOHO_BOOKS_REFRESH_TOKEN, ZOHO_BOOKS_ORGANIZATION_ID in Vercel (see Roadmap).",
      });
    }

    const body = (req.body ?? {}) as {
      paymentId?: string;
      allUnsynced?: boolean;
      pull?: boolean;
      pullAll?: boolean;
    };

    if (body.pull && body.paymentId) {
      const result = await pullPaymentFromZohoBooks(body.paymentId);
      return res.status(result.ok ? 200 : 502).json(result);
    }

    if (body.pullAll) {
      const result = await pullLinkedPaymentsFromZohoBooks({ take: 50 });
      return res.status(200).json(result);
    }

    if (body.paymentId) {
      const result = await syncPaymentToZohoBooks(body.paymentId);
      return res.status(result.ok ? 200 : 502).json(result);
    }

    if (body.allUnsynced) {
      const zohoUnsynced = { OR: [{ zohoBooksInvoiceId: null }, { zohoBooksPaymentId: null }] };

      const [unpaidPayments, unpaidBookings, unpaidOrders] = await Promise.all([
        prisma.payment.findMany({
          where: { status: "PAID", ...zohoUnsynced },
          orderBy: { updatedAt: "desc" },
          take: 25,
        }),
        prisma.courierBooking.findMany({
          where: { status: "PAID", ...zohoUnsynced },
          orderBy: { updatedAt: "desc" },
          take: 25,
        }),
        prisma.shoppingOrder.findMany({
          where: { status: "PAID", ...zohoUnsynced },
          orderBy: { updatedAt: "desc" },
          take: 25,
        }),
      ]);

      const results: Array<{ product: "E2" | "EXPRESS" | "GLOBEME"; ref: string } & Awaited<ReturnType<typeof syncPaymentToZohoBooks>>> = [];
      for (const p of unpaidPayments) {
        results.push({ product: "E2", ref: p.id, ...(await syncPaymentToZohoBooks(p.id)) });
      }
      for (const b of unpaidBookings) {
        results.push({ product: "EXPRESS", ref: b.bookingRef, ...(await syncCourierBookingToZohoBooks(b.id)) });
      }
      for (const o of unpaidOrders) {
        results.push({ product: "GLOBEME", ref: o.orderRef, ...(await syncShoppingOrderToZohoBooks(o.id)) });
      }

      return res.status(200).json({
        ok: true,
        count: results.length,
        results,
      });
    }

    return res.status(400).json({
      error: "Provide paymentId, allUnsynced, pull+paymentId, or pullAll",
    });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
