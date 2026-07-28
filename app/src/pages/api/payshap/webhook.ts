import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { verifyPayShapWebhookSignature } from "@/lib/payshap";
import { sendWhatsAppText } from "@/lib/whatsapp";

/**
 * PayShap Request-to-Pay payment-confirmation webhook.
 *
 * The exact payload shape depends on which PSP (Ozow/Netcash/Electrum) is
 * eventually wired up in src/lib/payshap.ts — this handler assumes the
 * minimal fields any of them would send (a reference matching
 * CourierBooking.bookingRef, and a paid/failed status) and notifies both
 * the sender and recipient over WhatsApp once a booking is marked PAID.
 *
 * verifyPayShapWebhookSignature() always returns false until a PSP is
 * chosen (see src/lib/payshap.ts), so this route 501s rather than trusting
 * an unverifiable payload.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const signature = req.headers["x-payshap-signature"] as string | undefined;
  if (!verifyPayShapWebhookSignature(JSON.stringify(req.body ?? {}), signature)) {
    return res.status(501).json({
      error: "PayShap PSP is not configured yet — see src/lib/payshap.ts",
    });
  }

  const { reference, status } = req.body ?? {};
  const booking = await prisma.courierBooking.findUnique({ where: { bookingRef: reference } });
  if (!booking) {
    return res.status(404).json({ error: "Unknown booking reference" });
  }

  if (status !== "paid") {
    return res.status(200).json({ received: true });
  }

  await prisma.courierBooking.update({
    where: { id: booking.id },
    data: { status: "PAID", paidAt: new Date() },
  });

  await sendWhatsAppText({
    to: booking.senderPhone,
    message: `✅ Payment received for ${booking.bookingRef}. Your courier is being arranged — we'll keep you posted here.`,
  });

  if (booking.recipientPhone) {
    await sendWhatsAppText({
      to: booking.recipientPhone,
      message: `📦 A parcel is on its way to you (booking ${booking.bookingRef}). We'll message you here with delivery updates.`,
    });
  }

  return res.status(200).json({ received: true });
}
