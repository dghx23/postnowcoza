import nodemailer from "nodemailer";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { sendWhatsAppText, normalizeWhatsAppTo, isValidWhatsAppPhone } from "@/lib/whatsapp";

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

export type ShareChannel = "email" | "whatsapp";

/** Auto-detect whether a typed destination is an email address or a phone number. */
export function detectShareChannel(input: string): ShareChannel | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? "email" : null;
  return isValidWhatsAppPhone(trimmed) ? "whatsapp" : null;
}

function trackingUrl(documentId: string): string {
  return `${APP_URL}/tracking/${documentId}`;
}

/** Send the tracking link for this document to someone else, once, right now. */
export async function shareBooking(input: {
  documentId: string;
  destination: string;
  channel: ShareChannel;
  recipientName: string;
  actorId?: string;
  ip?: string;
}): Promise<void> {
  const url = trackingUrl(input.documentId);

  if (input.channel === "email") {
    const transport = getTransport();
    await transport.sendMail({
      from: `PostNow <${SMTP_FROM_EMAIL}>`,
      to: input.destination.trim(),
      subject: `PostNow — tracking for ${input.recipientName}'s document`,
      text: [
        `${input.recipientName}'s document is being handled by PostNow.`,
        ``,
        `Track it here: ${url}`,
        ``,
        `— PostNow · POPIA · Chain of Custody · Zero-Touch`,
      ].join("\n"),
      html: `<p>${escapeHtml(input.recipientName)}'s document is being handled by PostNow.</p><p><a href="${url}">${url}</a></p><p style="color:#8fa0aa;font-size:12px;">— PostNow · POPIA · Chain of Custody · Zero-Touch</p>`,
    });
  } else {
    const to = normalizeWhatsAppTo(input.destination);
    await sendWhatsAppText({
      to,
      message: [`📦 PostNow — tracking for ${input.recipientName}'s document`, ``, url].join("\n"),
    });
  }

  await appendAuditEvent({
    documentId: input.documentId,
    actorId: input.actorId,
    action: "booking_shared",
    metadata: { channel: input.channel, to: input.destination.trim() },
    ip: input.ip,
  });
}

/** Opt a destination in to future status-update notifications for this document. */
export async function subscribeToUpdates(input: {
  documentId: string;
  destination: string;
  channel: ShareChannel;
  actorId?: string;
  ip?: string;
}): Promise<void> {
  const destination =
    input.channel === "whatsapp" ? normalizeWhatsAppTo(input.destination) : input.destination.trim().toLowerCase();

  const existing = await prisma.documentSubscriber.findFirst({
    where: { documentId: input.documentId, channel: input.channel, destination },
  });
  if (!existing) {
    await prisma.documentSubscriber.create({
      data: { documentId: input.documentId, channel: input.channel, destination },
    });
  }

  await appendAuditEvent({
    documentId: input.documentId,
    actorId: input.actorId,
    action: "subscriber_added",
    metadata: { channel: input.channel, destination },
    ip: input.ip,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
