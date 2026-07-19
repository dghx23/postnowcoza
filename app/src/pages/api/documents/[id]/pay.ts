import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { buildPayfastCheckout, getPayfastConfig } from "@/lib/payfast";

const APP_URL = process.env.NEXTAUTH_URL ?? "https://app.postnow.co.za";

/**
 * Create or return a PayFast checkout for this document's dispatch fee.
 * Returns { action, fields } for a browser POST form, or redirects if preferred.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return res.status(404).json({ error: "Document not found" });
  if (document.ownerId !== user.id && user.role === "CUSTOMER") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const cfg = getPayfastConfig();
  if (!cfg.configured) {
    return res.status(503).json({
      error:
        "PayFast is not configured. Set Merchant_ID_Payfast and Merchant_Key_Payfast in Vercel.",
    });
  }

  // Ensure a fee exists — default if not yet set by rate booking.
  let fee = document.dispatchFee;
  if (fee == null || fee <= 0) {
    fee = Number(process.env.DEFAULT_DISPATCH_FEE ?? "149");
    if (!Number.isFinite(fee) || fee <= 0) fee = 149;
    await prisma.document.update({
      where: { id },
      data: { dispatchFee: fee },
    });
  }

  const existingPaid = await prisma.payment.findFirst({
    where: { documentId: id, status: "PAID" },
  });
  if (existingPaid) {
    return res.status(200).json({
      alreadyPaid: true,
      id: existingPaid.id,
      amount: existingPaid.amount,
      redirect: `/tracking/${id}?payment=success`,
    });
  }

  let payment = await prisma.payment.findFirst({
    where: { documentId: id, status: "UNPAID" },
    orderBy: { createdAt: "desc" },
  });

  const customPaymentId = payment?.customPaymentId ?? `pn-${id.slice(0, 12)}-${Date.now().toString(36)}`;

  if (!payment) {
    payment = await prisma.payment.create({
      data: {
        documentId: id,
        customPaymentId,
        amount: fee,
        status: "UNPAID",
        paymentMethod: "payfast",
      },
    });
  } else if (payment.amount !== fee) {
    payment = await prisma.payment.update({
      where: { id: payment.id },
      data: { amount: fee },
    });
  }

  const nameParts = document.recipientName.trim().split(/\s+/);
  const nameFirst = nameParts[0] ?? "Customer";
  const nameLast = nameParts.slice(1).join(" ") || "PostNow";

  const checkout = buildPayfastCheckout({
    amount: fee,
    itemName: "PostNow secure dispatch",
    itemDescription: `Dispatch fee · ref ${id.slice(0, 10).toUpperCase()}`,
    mPaymentId: payment.customPaymentId,
    email: document.recipientEmail || user.email || "",
    cellNumber: document.recipientPhone,
    nameFirst,
    nameLast,
    returnUrl: `${APP_URL}/pay/${id}?status=return`,
    cancelUrl: `${APP_URL}/pay/${id}?status=cancelled`,
    notifyUrl: `${APP_URL}/api/webhooks/payfast`,
    documentId: id,
  });

  // Store process URL for reference (not a hosted payment link — form POST).
  await prisma.payment.update({
    where: { id: payment.id },
    data: { paymentUrl: checkout.action },
  });

  return res.status(200).json({
    action: checkout.action,
    fields: checkout.fields,
    sandbox: checkout.sandbox,
    amount: fee,
    paymentId: payment.id,
    m_payment_id: payment.customPaymentId,
  });
}
