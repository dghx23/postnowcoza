import nodemailer from "nodemailer";
import { createCipheriv, randomBytes, scryptSync } from "crypto";
import { prisma } from "@/lib/db";
import { getDocumentBuffer } from "@/lib/storage";
import { logSyncException } from "@/lib/syncExceptions";

const SMTP_HOST = process.env.SMTP_HOST ?? "";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? "587");
const SMTP_USER = process.env.Zoho_PrintAgent_User ?? process.env.SMTP_USER ?? "";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD ?? "";
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || SMTP_USER || "noreply@postnow.co.za";

function getTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) {
    throw new Error("SMTP is not configured");
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
}

/** AES-256-GCM encrypt buffer; returns package + password used. */
export function encryptBufferWithPassword(
  plain: Buffer,
  password: string
): { encrypted: Buffer; filenameSuffix: string } {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  // salt | iv | tag | ciphertext
  const packaged = Buffer.concat([salt, iv, tag, enc]);
  return { encrypted: packaged, filenameSuffix: ".aes" };
}

export async function emailFacilityScan(input: {
  scanId: string;
  toEmail: string;
  subject: string;
  body: string;
  /** When set, attachment is AES-encrypted and password is included in the email. */
  password?: string | null;
}): Promise<{ ok: true; encrypted: boolean }> {
  const scan = await prisma.facilityScan.findUnique({ where: { id: input.scanId } });
  if (!scan) throw new Error("Scan not found");

  let buffer = await getDocumentBuffer(scan.storageKey);
  let attachName = scan.fileName.endsWith(".pdf") ? scan.fileName : `${scan.fileName}.pdf`;
  let contentType = scan.contentType || "application/pdf";
  let encrypted = false;
  const password = (input.password ?? "").trim();

  if (password) {
    const pack = encryptBufferWithPassword(buffer, password);
    buffer = pack.encrypted;
    attachName = `${attachName}${pack.filenameSuffix}`;
    contentType = "application/octet-stream";
    encrypted = true;
  }

  const textParts = [
    input.body.trim() || "Please find the attached scan from PostNow facility.",
    ``,
    scan.comments ? `Scan comments: ${scan.comments}` : null,
    encrypted
      ? `The attachment is password-protected (AES-256-GCM). Password: ${password}\nDecrypt with a tool that accepts salt(16)+iv(12)+tag(16)+ciphertext, or ask facility staff for a clear PDF.`
      : null,
    ``,
    `— PostNow E2 facility`,
  ].filter((x) => x != null);

  try {
    const transport = getTransport();
    await transport.sendMail({
      from: `PostNow <${SMTP_FROM_EMAIL}>`,
      to: input.toEmail.trim(),
      subject: input.subject.trim() || `PostNow scan — ${scan.fileName}`,
      text: textParts.join("\n"),
      attachments: [
        {
          filename: attachName,
          content: buffer,
          contentType,
        },
      ],
    });
    return { ok: true, encrypted };
  } catch (err) {
    await logSyncException({
      source: "scan",
      title: `Scan email failed · ${scan.fileName}`,
      detail: (err as Error).message,
      metadata: { scanId: scan.id, to: input.toEmail },
    });
    throw err;
  }
}
