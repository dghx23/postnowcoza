import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import {
  validatePayfastItn,
  verifyPayfastSignature,
} from "@/lib/payfast";
import { afterPaymentSucceeded } from "@/lib/autoDispatch";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
};

/**
 * PayFast Instant Transaction Notification (ITN).
 * Must respond with HTTP 200 quickly; PayFast POSTs application/x-www-form-urlencoded.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  // Next may already parse urlencoded into an object.
  const raw = req.body as Record<string, string | string[] | undefined>;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (Array.isArray(v)) data[k] = v[0] ?? "";
    else if (v != null) data[k] = String(v);
  }

  if (!verifyPayfastSignature(data)) {
    console.error("PayFast ITN: invalid signature", { m_payment_id: data.m_payment_id });
    return res.status(400).send("Invalid signature");
  }

  // Server-side revalidation (PayFast recommends this).
  const valid = await validatePayfastItn(data);
  if (!valid) {
    console.error("PayFast ITN: server validation failed", { m_payment_id: data.m_payment_id });
    return res.status(400).send("Invalid ITN");
  }

  const mPaymentId = data.m_payment_id;
  if (!mPaymentId) return res.status(400).send("Missing m_payment_id");

  const payment = await prisma.payment.findUnique({
    where: { customPaymentId: mPaymentId },
  });
  if (!payment) {
    // Acknowledge so PayFast stops retrying.
    return res.status(200).send("OK unmatched");
  }

  const pfStatus = (data.payment_status ?? "").toUpperCase();
  const amountGross = Number(data.amount_gross ?? data.amount ?? 0);

  if (pfStatus === "COMPLETE") {
    if (Math.abs(amountGross - payment.amount) > 0.05) {
      await appendAuditEvent({
        documentId: payment.documentId,
        action: "payment_amount_mismatch",
        metadata: {
          provider: "payfast",
          expected: payment.amount,
          received: amountGross,
        },
      });
      return res.status(400).send("Amount mismatch");
    }

    if (payment.status !== "PAID") {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "PAID",
          paymentMethod: data.payment_method ?? "payfast",
          bobpayUuid: data.pf_payment_id ?? data.payfast_payment_id ?? undefined,
          rawPayload: data as object,
        },
      });

      await appendAuditEvent({
        documentId: payment.documentId,
        action: "payment_paid",
        metadata: {
          provider: "payfast",
          pf_payment_id: data.pf_payment_id,
          amount: amountGross,
        },
      });

      // Book next-day courier if already printed; else queue for after print.
      try {
        await afterPaymentSucceeded(payment.documentId);
      } catch (err) {
        console.error("PayFast ITN: auto-dispatch error", err);
      }

      // Map paid fee into Zoho Books (contact + invoice + payment). Non-fatal.
      try {
        const { syncPaymentToZohoBooks } = await import("@/lib/zohoBooksSync");
        await syncPaymentToZohoBooks(payment.id);
      } catch (err) {
        console.error("PayFast ITN: Zoho Books sync error", err);
      }
    }
  } else if (pfStatus === "FAILED" || pfStatus === "CANCELLED") {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: pfStatus === "FAILED" ? "FAILED" : "CANCELLED",
        rawPayload: data as object,
      },
    });
    await appendAuditEvent({
      documentId: payment.documentId,
      action: pfStatus === "FAILED" ? "payment_failed" : "payment_cancelled",
      metadata: { provider: "payfast", payment_status: pfStatus },
    });
  }

  return res.status(200).send("OK");
}
