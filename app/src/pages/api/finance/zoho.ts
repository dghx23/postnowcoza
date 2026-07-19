import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { getZohoBooksPublicConfig, zohoBooksConfigured } from "@/lib/zohoBooks";
import {
  pullLinkedPaymentsFromZohoBooks,
  pullPaymentFromZohoBooks,
  syncPaymentToZohoBooks,
} from "@/lib/zohoBooksSync";
import { prisma } from "@/lib/db";

/**
 * GET  — Zoho Books config status + app URL for finance UI links
 * POST — push / pull:
 *   { paymentId }              push one
 *   { allUnsynced: true }      push recent PAID without full Books mapping
 *   { pull: true, paymentId }  pull one linked invoice
 *   { pullAll: true }          pull all linked (capped)
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
      const unpaidSync = await prisma.payment.findMany({
        where: {
          status: "PAID",
          OR: [{ zohoBooksInvoiceId: null }, { zohoBooksPaymentId: null }],
        },
        orderBy: { updatedAt: "desc" },
        take: 25,
      });
      const results = [];
      for (const p of unpaidSync) {
        results.push({ paymentId: p.id, ...(await syncPaymentToZohoBooks(p.id)) });
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
