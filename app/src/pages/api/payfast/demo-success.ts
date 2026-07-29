// PayFast demo success handler for local development/preview.
// Simulates a successful payment confirmation and marks order as PAID.

import { NextApiRequest, NextApiResponse } from "next";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).end();
  }

  try {
    const { orderRef, amount } = req.query;
    if (!orderRef || typeof orderRef !== "string") {
      return res.status(400).json({ error: "missing_orderRef" });
    }

    // Find the order by reference.
    const order = await prisma.shoppingOrder.findUnique({ where: { orderRef } });
    if (!order) {
      return res.status(404).json({ error: "order_not_found" });
    }

    // Update order to PAID.
    await prisma.shoppingOrder.update({
      where: { id: order.id },
      data: {
        status: "PAID",
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
            .amount { font-size: 24px; font-weight: bold; color: #2563eb; }
            a { color: #2563eb; text-decoration: none; }
            a:hover { text-decoration: underline; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Payment Successful</h1>
            <p>Your GlobeMe order has been confirmed and payment received.</p>
            <p><strong>Order Reference:</strong> <span class="ref">${orderRef}</span></p>
            <p><strong>Amount:</strong> <span class="amount">R${amount}</span></p>
            <p>We're now processing your import from the US. You'll receive WhatsApp tracking updates shortly, including an ETA for delivery to your address.</p>
            <p><a href="/tracking/${orderRef}">View tracking &rarr;</a></p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("PayFast demo success error:", error);
    return res.status(500).json({ error: "internal_error" });
  }
}
