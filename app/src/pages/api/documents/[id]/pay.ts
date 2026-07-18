import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { createPaymentLink } from "@/lib/bobpay";

// Base URL of this deployment, used to build the notify/success/pending/
// cancel URLs Bob Pay redirects/notifies against.
const APP_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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
  if (!document.dispatchFee) {
    return res.status(422).json({ error: "Document has no dispatch fee set yet — dispatch it first" });
  }

  const existing = await prisma.payment.findFirst({
    where: { documentId: id, status: { in: ["UNPAID", "PAID"] } },
  });
  if (existing) {
    return res.status(200).json({ url: existing.paymentUrl, id: existing.id });
  }

  const customPaymentId = `${document.id}-dispatch`;

  const link = await createPaymentLink({
    amount: document.dispatchFee,
    email: document.recipientEmail,
    mobile_number: document.recipientPhone,
    item_name: "PostNow secure dispatch",
    item_description: `Dispatch fee for document ${document.id}`,
    custom_payment_id: customPaymentId,
    notify_url: `${APP_URL}/api/webhooks/bobpay`,
    success_url: `${APP_URL}/tracking/${document.id}?payment=success`,
    pending_url: `${APP_URL}/tracking/${document.id}?payment=pending`,
    cancel_url: `${APP_URL}/tracking/${document.id}?payment=cancelled`,
    short_url: true,
  });

  const payment = await prisma.payment.create({
    data: {
      documentId: document.id,
      customPaymentId,
      amount: document.dispatchFee,
      paymentUrl: link.short_url ?? link.url,
    },
  });

  return res.status(201).json({ url: payment.paymentUrl, id: payment.id });
}
