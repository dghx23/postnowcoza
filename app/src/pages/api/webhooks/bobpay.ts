import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { isKnownBobpayIp, verifyBobpaySignature } from "@/lib/bobpay-webhook";
import { validatePayment } from "@/lib/bobpay";

interface BobpayNotification {
  uuid: string;
  custom_payment_id: string;
  amount: number;
  paid_amount: number;
  status: "paid" | "unpaid" | "failed" | "cancelled" | "processing" | "refunded";
  payment_method: string;
  recipient_account_code: string;
  email?: string;
  mobile_number?: string;
  item_name?: string;
  item_description?: string;
  notify_url: string;
  success_url: string;
  pending_url: string;
  cancel_url: string;
  signature: string;
}

const STATUS_MAP: Record<string, "PAID" | "FAILED" | "CANCELLED" | "REFUNDED" | "UNPAID"> = {
  paid: "PAID",
  failed: "FAILED",
  cancelled: "CANCELLED",
  refunded: "REFUNDED",
  unpaid: "UNPAID",
  processing: "UNPAID",
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const forwardedFor = req.headers["x-forwarded-for"];
  const remoteIp = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(",")[0].trim()
    ?? req.socket.remoteAddress;

  if (!isKnownBobpayIp(remoteIp)) {
    return res.status(403).json({ error: "Unrecognized source IP" });
  }

  const payload = req.body as BobpayNotification;

  if (!verifyBobpaySignature(payload)) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  const payment = await prisma.payment.findUnique({ where: { customPaymentId: payload.custom_payment_id } });
  if (!payment) {
    // Acknowledge so Bob Pay doesn't retry forever, but nothing to reconcile against.
    return res.status(200).json({ received: true, unmatched: true });
  }

  if (payload.paid_amount !== payment.amount && payload.status === "paid") {
    await appendAuditEvent({
      documentId: payment.documentId,
      action: "payment_amount_mismatch",
      metadata: { expected: payment.amount, received: payload.paid_amount },
    });
    return res.status(400).json({ error: "Amount mismatch" });
  }

  try {
    const validation = await validatePayment(payload);
    if (!validation.valid) {
      return res.status(400).json({ error: "Payment could not be validated with Bob Pay" });
    }
  } catch (err) {
    await appendAuditEvent({
      documentId: payment.documentId,
      action: "payment_validation_failed",
      metadata: { error: (err as Error).message },
    });
    return res.status(502).json({ error: "Validation request failed" });
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: STATUS_MAP[payload.status] ?? "UNPAID",
      bobpayUuid: payload.uuid,
      paymentMethod: payload.payment_method,
      rawPayload: payload as unknown as object,
    },
  });

  await appendAuditEvent({
    documentId: payment.documentId,
    action: `payment_${payload.status}`,
    metadata: { uuid: payload.uuid, amount: payload.paid_amount, payment_method: payload.payment_method },
  });

  return res.status(200).json({ received: true });
}
