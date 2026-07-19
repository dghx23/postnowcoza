import nodemailer from "nodemailer";
import { randomBytes } from "crypto";
import type { Document, Payment, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { sendWhatsAppText, normalizeWhatsAppTo } from "@/lib/whatsapp";

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

export function paymentLinkFor(documentId: string, token: string, fromStaff = false): string {
  const base = `${APP_URL}/pay/${documentId}?token=${encodeURIComponent(token)}`;
  return fromStaff ? `${base}&from=staff` : base;
}

export function getStoredPaymentRequestToken(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const t = (raw as { paymentRequestToken?: unknown }).paymentRequestToken;
  return typeof t === "string" && t.length >= 16 ? t : null;
}

type PreparedPaymentRequest = {
  document: Document;
  payment: Payment;
  token: string;
  payUrl: string;
  amount: number;
  ref: string;
  colour: string;
  returnPref: string;
  address: string;
  shortAddress: string;
  firstName: string;
  printLabel: string;
};

function firstNameOf(name: string): string {
  const t = name.trim();
  if (!t) return "Customer";
  return t.split(/\s+/)[0] || t;
}

function shortAddressOf(document: Document): string {
  // Compact line for WhatsApp: "3 Karee St, Gqeberha 6005"
  const street = (document.streetAddress || "").trim();
  const city = (document.city || "").trim();
  const postal = (document.postalCode || "").trim();
  const parts: string[] = [];
  if (street) {
    parts.push(
      street
        .replace(/\bStreet\b/gi, "St")
        .replace(/\bAvenue\b/gi, "Ave")
        .replace(/\bRoad\b/gi, "Rd")
        .replace(/\bDrive\b/gi, "Dr")
    );
  }
  if (city && postal) parts.push(`${city} ${postal}`);
  else if (city) parts.push(city);
  else if (postal) parts.push(postal);
  return parts.join(", ") || "—";
}

/** Ensure fee, unpaid payment row, and a fresh one-time pay token/link. */
async function preparePaymentRequest(
  documentId: string,
  extraPayload: Record<string, unknown> = {},
  manualEntry?: { justification: string; isTestEntry: boolean }
): Promise<PreparedPaymentRequest> {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) throw new Error("Document not found");

  if (document.createdVia === "STAFF" && !manualEntry?.justification.trim()) {
    throw new Error("Justification is required for staff-created manual entries");
  }

  let fee = document.dispatchFee;
  if (fee == null || fee <= 0) {
    fee = Number(process.env.DEFAULT_DISPATCH_FEE ?? "149") || 149;
    await prisma.document.update({
      where: { id: document.id },
      data: { dispatchFee: fee },
    });
  }

  const existingResolved = await prisma.payment.findFirst({
    where: { documentId: document.id, status: { in: ["PAID", "WAIVED"] } },
  });
  if (existingResolved) {
    throw new Error(
      existingResolved.status === "WAIVED"
        ? "This dispatch fee was already processed at no cost"
        : "This dispatch fee is already paid"
    );
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
    paymentRequestSentAt: new Date().toISOString(),
    ...extraPayload,
  };

  const manualEntryFields = manualEntry
    ? { manualEntryJustification: manualEntry.justification.trim(), isTestEntry: manualEntry.isTestEntry }
    : {};

  if (!payment) {
    payment = await prisma.payment.create({
      data: {
        documentId: document.id,
        customPaymentId,
        amount: fee,
        status: "UNPAID",
        paymentMethod: "payfast",
        rawPayload: rawPayload as Prisma.InputJsonValue,
        ...manualEntryFields,
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
        ...manualEntryFields,
      },
    });
  }

  const payUrl = paymentLinkFor(document.id, token, true);
  const ref = document.id.slice(0, 10).toUpperCase();
  const colour = document.printColorMode === "color" ? "Colour" : "Black & white";
  const returnPref =
    document.returnPreference === "MANAGED"
      ? "Fully managed return via PostNow E2"
      : "Direct return";
  const address = [
    document.streetAddress,
    document.localArea,
    document.city,
    document.zone,
    document.postalCode,
  ]
    .filter(Boolean)
    .join(", ");
  const printLabel = `${colour} · ${document.printCopies} cop${document.printCopies === 1 ? "y" : "ies"}`;

  return {
    document,
    payment,
    token,
    payUrl,
    amount: fee,
    ref,
    colour,
    returnPref,
    address,
    shortAddress: shortAddressOf(document),
    firstName: firstNameOf(document.recipientName),
    printLabel,
  };
}

/**
 * WhatsApp payment-request template (staff-sent).
 * Keep under Meta free-form limits; link is the one-time secure pay URL.
 */
export function buildWhatsAppPaymentRequestMessage(p: PreparedPaymentRequest): string {
  const { document, amount, ref, printLabel, shortAddress, payUrl } = p;
  const returnShort =
    document.returnPreference === "MANAGED" ? "Managed" : "Direct";
  const amountLabel = amount.toFixed(2);

  return [
    `🔔 PAYMENT REQUEST`,
    ``,
    `To: ${document.recipientName || p.firstName} | Ref: #${ref}`,
    `Amount: R ${amountLabel}`,
    `Address: ${shortAddress}`,
    `Print: ${printLabel} | Return: ${returnShort}`,
    ``,
    `🔗 Pay now (expires after use):`,
    payUrl,
    ``,
    `PostNow • POPIA • Chain of Custody • Zero‑Touch`,
  ].join("\n");
}

/** Branded HTML email for staff payment requests (table layout for clients). */
export function buildPaymentRequestEmailHtml(p: PreparedPaymentRequest): string {
  const { document, amount, ref, returnPref, address, payUrl, firstName, printLabel } = p;
  const amountLabel = amount.toFixed(2);
  const phone = document.recipientPhone || "—";
  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PostNow Dispatch Payment</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f6f9; padding: 20px 0;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; max-width: 600px; box-shadow: 0 4px 12px rgba(0,0,0,0.06);">
                    <!-- Header -->
                    <tr>
                        <td style="padding: 28px 30px 16px 30px; border-bottom: 1px solid #e8ecf1; background-color: #fafbfc;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td>
                                        <span style="font-size: 26px; font-weight: 700; color: #0b2b5e; letter-spacing: -0.5px;">Post<span style="font-weight: 300;">Now</span></span>
                                    </td>
                                    <td align="right" style="font-size: 12px; color: #6b7a8f; font-weight: 500; letter-spacing: 0.3px; text-transform: uppercase;">
                                        E2
                                    </td>
                                </tr>
                                <tr>
                                    <td colspan="2" style="padding-top: 6px;">
                                        <span style="font-size: 14px; color: #3d4e6a; font-weight: 400; letter-spacing: -0.1px;">POPIA-first secure document dispatch — print, courier, sign, return.</span>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding: 30px 30px 10px 30px;">
                            <p style="margin: 0; font-size: 16px; color: #1a1a1a;">Dear <strong>${escapeHtml(firstName)}</strong>,</p>
                            <p style="margin: 12px 0 0 0; font-size: 15px; color: #333; line-height: 1.6;">
                                A secure document dispatch has been prepared for you. Please review the details and complete your payment using the secure link below.
                            </p>

                            <!-- Order Summary Box -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 20px; background-color: #f9fafc; border: 1px solid #e1e5ec; border-radius: 10px;">
                                <tr>
                                    <td style="padding: 20px;">
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td style="font-size: 14px; color: #5a6378; padding: 4px 0;">Reference</td>
                                                <td style="font-size: 14px; font-weight: 600; text-align: right; padding: 4px 0; color: #0b2b5e;">#${escapeHtml(ref)}</td>
                                            </tr>
                                            <tr>
                                                <td style="font-size: 14px; color: #5a6378; padding: 4px 0;">Recipient</td>
                                                <td style="font-size: 14px; font-weight: 600; text-align: right; padding: 4px 0; color: #0b2b5e;">${escapeHtml(document.recipientName)}</td>
                                            </tr>
                                            <tr>
                                                <td style="font-size: 14px; color: #5a6378; padding: 4px 0; vertical-align: top;">Delivery address</td>
                                                <td style="font-size: 14px; font-weight: 600; text-align: right; padding: 4px 0; color: #0b2b5e; max-width: 320px;">${escapeHtml(address)}</td>
                                            </tr>
                                            <tr>
                                                <td style="font-size: 14px; color: #5a6378; padding: 4px 0;">Phone</td>
                                                <td style="font-size: 14px; font-weight: 600; text-align: right; padding: 4px 0; color: #0b2b5e;">${escapeHtml(phone)}</td>
                                            </tr>
                                            <tr>
                                                <td style="font-size: 14px; color: #5a6378; padding: 4px 0;">Print</td>
                                                <td style="font-size: 14px; font-weight: 600; text-align: right; padding: 4px 0; color: #0b2b5e;">${escapeHtml(printLabel)}</td>
                                            </tr>
                                            <tr>
                                                <td style="font-size: 14px; color: #5a6378; padding: 4px 0;">Return</td>
                                                <td style="font-size: 14px; font-weight: 600; text-align: right; padding: 4px 0; color: #0b2b5e;">${escapeHtml(returnPref)}</td>
                                            </tr>
                                            <tr>
                                                <td style="font-size: 14px; color: #5a6378; padding: 4px 0;">Service</td>
                                                <td style="font-size: 14px; font-weight: 600; text-align: right; padding: 4px 0; color: #0b2b5e;">Secure physical document dispatch</td>
                                            </tr>
                                            <tr>
                                                <td colspan="2" style="padding-top: 15px; font-size: 28px; font-weight: 700; color: #0b2b5e;">R ${amountLabel}</td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <!-- Payment Button -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 24px;">
                                <tr>
                                    <td align="center">
                                        <a href="${payUrl}" style="display: inline-block; background-color: #2e6edf; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 6px; font-weight: 600; font-size: 16px; letter-spacing: 0.2px; box-shadow: 0 2px 6px rgba(46,110,223,0.25);">Pay R${amountLabel} now</a>
                                    </td>
                                </tr>
                            </table>

                            <p style="margin: 20px 0 0 0; font-size: 13px; color: #6b7280;">
                                This is a one‑time secure payment link. It will expire after use.
                            </p>

                            <p style="margin: 16px 0 0 0; font-size: 13px; color: #6b7280; line-height: 1.5;">
                                We accept: Visa, Mastercard, American Express, Instant EFT, Apple Pay, Samsung Pay, Google Pay, Capitec Pay, Mobicred, SnapScan, Zapper, Masterpass, RCS, and more.
                            </p>

                            <p style="margin: 16px 0 0 0; font-size: 12px; color: #99a0af; line-height: 1.45; word-break: break-all;">
                                If the button does not work, open this link:<br/>
                                <a href="${payUrl}" style="color: #2e6edf;">${payUrl}</a>
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding: 0 30px 30px 30px;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #e8ecf1;">
                                <tr>
                                    <td align="center" style="padding-bottom: 12px;">
                                        <span style="font-size: 18px; font-weight: 700; color: #0b2b5e; letter-spacing: -0.3px;">Post<span style="font-weight: 300;">Now</span></span>
                                    </td>
                                </tr>
                                <tr>
                                    <td align="center" style="padding-bottom: 14px;">
                                        <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto;">
                                            <tr>
                                                <td style="padding: 4px 10px; background-color: #eef1f6; border-radius: 20px; font-size: 11px; font-weight: 600; color: #0b2b5e; letter-spacing: 0.2px; white-space: nowrap;">POPIA Compliant</td>
                                                <td style="width: 6px;"></td>
                                                <td style="padding: 4px 10px; background-color: #eef1f6; border-radius: 20px; font-size: 11px; font-weight: 600; color: #0b2b5e; letter-spacing: 0.2px; white-space: nowrap;">Chain of Custody</td>
                                                <td style="width: 6px;"></td>
                                                <td style="padding: 4px 10px; background-color: #eef1f6; border-radius: 20px; font-size: 11px; font-weight: 600; color: #0b2b5e; letter-spacing: 0.2px; white-space: nowrap;">Zero-Touch</td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                                <tr>
                                    <td align="center" style="font-size: 12px; color: #99a0af;">
                                        © ${year} PostNow. Secure physical document dispatch.
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

function buildPaymentRequestEmailText(p: PreparedPaymentRequest): string {
  const { document, amount, ref, returnPref, address, payUrl, firstName, printLabel } = p;
  return [
    `Dear ${firstName},`,
    ``,
    `A secure document dispatch has been prepared for you. Please review the details and complete your payment using the secure link below.`,
    ``,
    `Reference: #${ref}`,
    `Recipient: ${document.recipientName}`,
    `Delivery address: ${address}`,
    `Phone: ${document.recipientPhone || "—"}`,
    `Print: ${printLabel}`,
    `Return: ${returnPref}`,
    `Service: Secure physical document dispatch`,
    `Amount: R ${amount.toFixed(2)}`,
    ``,
    `Pay now (one-time link, expires after use):`,
    payUrl,
    ``,
    `We accept: Visa, Mastercard, American Express, Instant EFT, Apple Pay, Samsung Pay, Google Pay, Capitec Pay, Mobicred, SnapScan, Zapper, Masterpass, RCS, and more.`,
    ``,
    `— PostNow E2 · POPIA · Chain of Custody · Zero-Touch`,
  ].join("\n");
}

export async function sendDispatchPaymentRequest(input: {
  documentId: string;
  toEmail: string;
  actorId?: string;
  ip?: string;
  manualEntry?: { justification: string; isTestEntry: boolean };
}): Promise<{ paymentId: string; token: string; payUrl: string; amount: number }> {
  const prepared = await preparePaymentRequest(
    input.documentId,
    {
      paymentRequestEmail: input.toEmail.trim().toLowerCase(),
      paymentRequestChannel: "email",
    },
    input.manualEntry
  );

  const { document, payment, token, payUrl, amount, ref } = prepared;

  const subject = `PostNow — payment request for dispatch #${ref}`;
  const text = buildPaymentRequestEmailText(prepared);
  const html = buildPaymentRequestEmailHtml(prepared);

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
      channel: "email",
      to: input.toEmail.trim().toLowerCase(),
      amount,
      paymentId: payment.id,
      payUrl,
      ...(input.manualEntry
        ? { justification: input.manualEntry.justification.trim(), isTestEntry: input.manualEntry.isTestEntry }
        : {}),
    },
    ip: input.ip,
  });

  return { paymentId: payment.id, token, payUrl, amount };
}

export async function sendDispatchPaymentRequestWhatsApp(input: {
  documentId: string;
  toPhone: string;
  actorId?: string;
  ip?: string;
  manualEntry?: { justification: string; isTestEntry: boolean };
}): Promise<{ paymentId: string; token: string; payUrl: string; amount: number; to: string }> {
  const toNorm = normalizeWhatsAppTo(input.toPhone);
  if (!toNorm || toNorm.length < 10) {
    throw new Error("A valid phone number is required for WhatsApp");
  }

  const prepared = await preparePaymentRequest(
    input.documentId,
    {
      paymentRequestPhone: toNorm,
      paymentRequestChannel: "whatsapp",
    },
    input.manualEntry
  );

  const message = buildWhatsAppPaymentRequestMessage(prepared);
  const result = await sendWhatsAppText({ to: toNorm, message });

  await appendAuditEvent({
    documentId: prepared.document.id,
    actorId: input.actorId,
    action: "payment_request_sent",
    metadata: {
      channel: "whatsapp",
      to: toNorm,
      amount: prepared.amount,
      paymentId: prepared.payment.id,
      payUrl: prepared.payUrl,
      whatsappMessageId: result.messageId,
      ...(input.manualEntry
        ? { justification: input.manualEntry.justification.trim(), isTestEntry: input.manualEntry.isTestEntry }
        : {}),
    },
    ip: input.ip,
  });

  return {
    paymentId: prepared.payment.id,
    token: prepared.token,
    payUrl: prepared.payUrl,
    amount: prepared.amount,
    to: toNorm,
  };
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
