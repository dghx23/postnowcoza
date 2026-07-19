import nodemailer from "nodemailer";
import { randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";

const SMTP_HOST = process.env.SMTP_HOST ?? "";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? "587");
const SMTP_USER = process.env.Zoho_PrintAgent_User ?? process.env.SMTP_USER ?? "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD ?? "";
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || SMTP_USER || "noreply@postnow.co.za";
const APP_URL = (process.env.NEXTAUTH_URL ?? "https://app.postnow.co.za").replace(/\/$/, "");

function getTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) {
    throw new Error("SMTP is not configured (SMTP_HOST / Zoho_PrintAgent_User / SMTP_PASSWORD)");
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
}

export function buildPaymentRequestToken(): string {
  return randomBytes(24).toString("hex");
}

export function paymentLinkFor(documentId: string, token: string): string {
  return `${APP_URL}/pay/${documentId}?token=${encodeURIComponent(token)}`;
}

export function getStoredPaymentRequestToken(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const t = (raw as { paymentRequestToken?: unknown }).paymentRequestToken;
  return typeof t === "string" && t.length >= 16 ? t : null;
}

export async function sendDispatchPaymentRequest(input: {
  documentId: string;
  toEmail: string;
  actorId?: string;
  ip?: string;
}): Promise<{ paymentId: string; token: string; payUrl: string; amount: number }> {
  const document = await prisma.document.findUnique({ where: { id: input.documentId } });
  if (!document) throw new Error("Document not found");

  let fee = document.dispatchFee;
  if (fee == null || fee <= 0) {
    fee = Number(process.env.DEFAULT_DISPATCH_FEE ?? "149") || 149;
    await prisma.document.update({
      where: { id: document.id },
      data: { dispatchFee: fee },
    });
  }

  const existingPaid = await prisma.payment.findFirst({
    where: { documentId: document.id, status: "PAID" },
  });
  if (existingPaid) {
    throw new Error("This dispatch fee is already paid");
  }

  let payment = await prisma.payment.findFirst({
    where: { documentId: document.id, status: "UNPAID" },
    orderBy: { createdAt: "desc" },
  });

  const token = buildPaymentRequestToken();
  const customPaymentId =
    payment?.customPaymentId ?? `pn-${document.id.slice(0, 12)}-${Date.now().toString(36)}`;

  const rawPayload = {
    paymentRequestToken: token,
    paymentRequestEmail: input.toEmail.trim().toLowerCase(),
    paymentRequestSentAt: new Date().toISOString(),
  };

  if (!payment) {
    payment = await prisma.payment.create({
      data: {
        documentId: document.id,
        customPaymentId,
        amount: fee,
        status: "UNPAID",
        paymentMethod: "payfast",
        rawPayload: rawPayload as Prisma.InputJsonValue,
      },
    });
  } else {
    payment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        amount: fee,
        rawPayload: {
          ...((payment.rawPayload && typeof payment.rawPayload === "object"
            ? payment.rawPayload
            : {}) as object),
          ...rawPayload,
        } as Prisma.InputJsonValue,
      },
    });
  }

  const payUrl = paymentLinkFor(document.id, token);
  const ref = document.id.slice(0, 10).toUpperCase();
  const colour = document.printColorMode === "color" ? "Colour" : "Black & white";
  const returnPref =
    document.returnPreference === "MANAGED" ? "Fully managed return via PostNow" : "Direct return";
  const address = [
    document.streetAddress,
    document.localArea,
    document.city,
    document.zone,
    document.postalCode,
  ]
    .filter(Boolean)
    .join(", ");

  const subject = `PostNow — payment request for dispatch #${ref}`;
  const text = [
    `Hello,`,
    ``,
    `PostNow has prepared a secure document dispatch and is requesting payment of the dispatch fee.`,
    ``,
    `Order details`,
    `-------------`,
    `Reference: #${ref}`,
    `Recipient: ${document.recipientName}`,
    `Deliver to: ${address}`,
    `Contact phone: ${document.recipientPhone || "—"}`,
    `Contact email: ${document.recipientEmail || "—"}`,
    `Print: ${colour} · ${document.printCopies} cop${document.printCopies === 1 ? "y" : "ies"}`,
    `Return: ${returnPref}`,
    `Amount due: R ${fee.toFixed(2)}`,
    ``,
    `Pay securely here:`,
    payUrl,
    ``,
    `After payment we print your document and book next-day courier collection from our facility.`,
    `You can track progress from the same link after paying.`,
    ``,
    `— PostNow E2`,
  ].join("\n");

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0A2540">
      <h2 style="margin:0 0 8px">Payment request — dispatch fee</h2>
      <p style="color:#4B5563;font-size:14px;line-height:1.5">
        PostNow has prepared a secure document dispatch. Please pay the fee below so we can print and book courier collection.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:20px 0">
        <tr><td style="padding:8px 0;color:#6B7280">Reference</td><td style="padding:8px 0;font-weight:700;text-align:right">#${ref}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280">Recipient</td><td style="padding:8px 0;font-weight:600;text-align:right">${escapeHtml(document.recipientName)}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280">Deliver to</td><td style="padding:8px 0;text-align:right;max-width:280px">${escapeHtml(address)}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280">Phone</td><td style="padding:8px 0;text-align:right">${escapeHtml(document.recipientPhone || "—")}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280">Print</td><td style="padding:8px 0;text-align:right">${colour} · ${document.printCopies} cop${document.printCopies === 1 ? "y" : "ies"}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280">Return</td><td style="padding:8px 0;text-align:right">${returnPref}</td></tr>
        <tr><td style="padding:12px 0;border-top:1px solid #E5E7EB;font-weight:700">Amount due</td><td style="padding:12px 0;border-top:1px solid #E5E7EB;font-weight:800;text-align:right;color:#0D9488;font-size:18px">R ${fee.toFixed(2)}</td></tr>
      </table>
      <p style="text-align:center;margin:28px 0">
        <a href="${payUrl}" style="display:inline-block;background:#0D9488;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">
          Pay dispatch fee securely
        </a>
      </p>
      <p style="font-size:12px;color:#9CA3AF;line-height:1.45">
        If the button does not work, open this link:<br/>
        <a href="${payUrl}" style="color:#0D9488;word-break:break-all">${payUrl}</a>
      </p>
      <p style="font-size:12px;color:#9CA3AF">— PostNow E2 · Secure physical document dispatch</p>
    </div>
  `;

  const transport = getTransport();
  await transport.sendMail({
    from: `PostNow <${SMTP_FROM_EMAIL}>`,
    to: input.toEmail.trim(),
    subject,
    text,
    html,
  });

  await appendAuditEvent({
    documentId: document.id,
    actorId: input.actorId,
    action: "payment_request_sent",
    metadata: {
      to: input.toEmail.trim().toLowerCase(),
      amount: fee,
      paymentId: payment.id,
      payUrl,
    },
    ip: input.ip,
  });

  return { paymentId: payment.id, token, payUrl, amount: fee };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Validate guest payment-request token for a document. */
export async function validatePaymentRequestToken(
  documentId: string,
  token: string | undefined | null
): Promise<boolean> {
  if (!token || typeof token !== "string" || token.length < 16) return false;
  const payment = await prisma.payment.findFirst({
    where: { documentId, status: "UNPAID" },
    orderBy: { createdAt: "desc" },
  });
  if (!payment) return false;
  const stored = getStoredPaymentRequestToken(payment.rawPayload);
  return stored === token;
}
