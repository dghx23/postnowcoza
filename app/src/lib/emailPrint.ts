import nodemailer from "nodemailer";

// Epson "Email Print" - every Epson Connect-registered printer has its own
// assigned email address; attaching a PDF to a plain email sent to that
// address prints it, no OAuth app registration or API credentials needed
// at all. This is the whole appeal over the EPSON (cloud API) provider,
// which requires a working client_id/client_secret/API key/redirect URI -
// this only needs an SMTP account to send from.
const SMTP_HOST = process.env.SMTP_HOST ?? "";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? "587");
const SMTP_USER = process.env.SMTP_USER ?? "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD ?? "";
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || SMTP_USER;

function getTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) {
    throw new Error("SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD)");
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
}

export async function sendPrintEmail(toEmail: string, pdfBuffer: Buffer, filename: string, subject: string) {
  const transport = getTransport();
  await transport.sendMail({
    from: SMTP_FROM_EMAIL,
    to: toEmail,
    subject,
    text: "Sent by PostNow for printing via Epson Email Print.",
    attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
  });
}
