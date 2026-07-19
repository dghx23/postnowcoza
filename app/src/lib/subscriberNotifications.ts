import nodemailer from "nodemailer";
import { prisma } from "@/lib/db";
import { sendWhatsAppText } from "@/lib/whatsapp";

// Deliberately does not import from "@/lib/audit" - appendAuditEvent calls
// notifyDocumentSubscribers on every status change, so a dependency the
// other way would be circular.

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

/** Short, friendly status wording for share/update messages (matches StatusPill). */
const STATUS_LABEL: Record<string, string> = {
  UPLOADED: "Submitted",
  QUEUED_FOR_PRINT: "In intake",
  PRINTED: "Printed",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In transit",
  DELIVERED: "Delivered",
  RETURN_REQUESTED: "Return requested",
  RETURN_IN_TRANSIT: "Return in transit",
  RETURNED: "Returned",
};
export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.toLowerCase().replace(/_/g, " ");
}

/**
 * Fan out a status-change notification to every subscriber of a document.
 * Called once, from appendAuditEvent itself, so every status-change call
 * site in the app gets this for free without touching each one.
 */
export async function notifyDocumentSubscribers(documentId: string, newStatus: string): Promise<void> {
  const subscribers = await prisma.documentSubscriber.findMany({ where: { documentId } });
  if (subscribers.length === 0) return;

  const url = `${APP_URL}/tracking/${documentId}`;
  const label = statusLabel(newStatus);

  for (const sub of subscribers) {
    try {
      if (sub.channel === "email") {
        const transport = getTransport();
        await transport.sendMail({
          from: `PostNow <${SMTP_FROM_EMAIL}>`,
          to: sub.destination,
          subject: `PostNow update — ${label}`,
          text: `Status update: ${label}\n\nTrack it here: ${url}`,
          html: `<p>Status update: <strong>${escapeHtml(label)}</strong></p><p><a href="${url}">${url}</a></p>`,
        });
      } else {
        await sendWhatsAppText({
          to: sub.destination,
          message: `📦 PostNow update: ${label}\n\n${url}`,
        });
      }
    } catch (err) {
      console.error("notifyDocumentSubscribers: failed to notify one subscriber", {
        documentId,
        channel: sub.channel,
        error: (err as Error).message,
      });
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
