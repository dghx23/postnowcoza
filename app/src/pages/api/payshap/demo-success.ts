// PayShap demo success handler for local development/preview.
// Simulates a successful payment confirmation and marks booking as PAID.

import { NextApiRequest, NextApiResponse } from "next";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).end();
  }

  try {
    const { ref, requestId } = req.query;
    if (!ref || typeof ref !== "string") {
      return res.status(400).json({ error: "missing_ref" });
    }

    // Find the booking by reference.
    const booking = await prisma.courierBooking.findUnique({ where: { bookingRef: ref } });
    if (!booking) {
      return res.status(404).json({ error: "booking_not_found" });
    }

    // Update booking to PAID.
    const requestIdStr = Array.isArray(requestId) ? requestId[0] : requestId || "DEMO-" + Date.now();
    await prisma.courierBooking.update({
      where: { id: booking.id },
      data: {
        status: "PAID",
        payShapRequestId: requestIdStr,
        paidAt: new Date(),
      },
    });

    // Return a success page
    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Payment Successful</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 40px; background: #f5f5f5; }
            .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
            h1 { color: #10b981; margin: 0 0 20px 0; }
            p { color: #666; line-height: 1.6; margin: 10px 0; }
            .ref { font-family: monospace; background: #f0f0f0; padding: 8px 12px; border-radius: 4px; }
            a { color: #2563eb; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Payment Successful</h1>
            <p>Your PayShap payment has been confirmed.</p>
            <p><strong>Booking Reference:</strong> <span class="ref">${ref}</span></p>
            <p><strong>Request ID:</strong> <span class="ref">${requestId}</span></p>
            <p>A courier will be assigned soon. You'll receive tracking updates via WhatsApp.</p>
            <p><a href="/tracking/${ref}">View tracking &rarr;</a></p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("PayShap demo success error:", error);
    return res.status(500).json({ error: "internal_error" });
  }
}
