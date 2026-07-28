// PayFast webhook: payment confirmation for GlobeMe shopping orders.
// Verifies signature, marks order as PAID, notifies customer over WhatsApp + email.

import { NextApiRequest, NextApiResponse } from "next";
import { PrismaClient } from "@prisma/client";
import { verifyPayFastWebhookSignature } from "@/lib/globeme";
import { sendWhatsAppText } from "@/lib/whatsapp";

const prisma = new PrismaClient();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  try {
    // Verify PayFast signature (stub until real HMAC implemented).
    const signatureHeader = req.headers["x-payfast-signature"] as string | undefined;
    if (!verifyPayFastWebhookSignature(req.body, signatureHeader)) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    // Extract order reference and payment status from PayFast webhook body.
    const { custom_str1: orderRef, payment_status: paymentStatus, pf_payment_id: payFastPaymentId } =
      req.body;

    if (!orderRef || !paymentStatus) {
      return res.status(400).json({ error: "missing_fields" });
    }

    // Only process "COMPLETE" payments.
    if (paymentStatus !== "COMPLETE") {
      console.log(`PayFast webhook: payment status ${paymentStatus} for ${orderRef}, ignoring`);
      return res.status(200).json({ ok: true });
    }

    // Find the shopping order.
    const order = await prisma.shoppingOrder.findUnique({ where: { orderRef } });
    if (!order) {
      console.warn(`PayFast webhook: order ${orderRef} not found`);
      return res.status(404).json({ error: "order_not_found" });
    }

    // Update order to PAID.
    await prisma.shoppingOrder.update({
      where: { id: order.id },
      data: {
        status: "PAID",
        payFastPaymentId,
        paidAt: new Date(),
      },
    });

    // Notify customer via email (basic template for now).
    console.log(`GlobeMe order ${orderRef} paid. Email notification would go to ${order.customerEmail}`);
    // TODO: send real email via SMTP

    // Notify recipient via WhatsApp if phone is set.
    if (order.recipientPhone) {
      await sendWhatsAppText({
        to: order.recipientPhone,
        message: `✅ Your GlobeMe order (${orderRef}) has been confirmed! We'll arrange import and delivery to ${order.recipientCity}. You'll get tracking updates here.`,
      });
    }

    // Notify customer via WhatsApp if phone is set.
    if (order.customerPhone) {
      await sendWhatsAppText({
        to: order.customerPhone,
        message: `✅ Payment received for order ${orderRef}. We're now processing your import. Tracking: https://postnow.co.za/tracking/${orderRef}`,
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("PayFast webhook error:", error);
    return res.status(500).json({ error: "internal_error" });
  }
}
