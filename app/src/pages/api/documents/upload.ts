import type { NextApiRequest, NextApiResponse } from "next";
import type { ReturnPreference } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { newStorageKey, putDocument } from "@/lib/storage";
import { appendAuditEvent } from "@/lib/audit";
import { getSessionUser } from "@/lib/session";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const deliveryAddressHeader = req.headers["x-delivery-address"];
  if (typeof deliveryAddressHeader !== "string") {
    return res.status(400).json({ error: "Missing x-delivery-address header" });
  }

  let deliveryAddress: {
    recipientName: string;
    recipientPhone: string;
    recipientEmail: string;
    streetAddress: string;
    localArea: string;
    city: string;
    zone: string;
    postalCode: string;
    country?: string;
    returnPreference?: ReturnPreference;
  };
  try {
    deliveryAddress = JSON.parse(deliveryAddressHeader);
  } catch {
    return res.status(400).json({ error: "x-delivery-address must be JSON" });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  if (body.length === 0) return res.status(400).json({ error: "Empty upload" });

  const filename = (req.headers["x-filename"] as string) ?? "document";
  const contentType = req.headers["content-type"] ?? "application/octet-stream";
  const checksum = createHash("sha256").update(body).digest("hex");
  const storageKey = newStorageKey(user.id, filename);
  const encryptionKeyRef = randomBytes(16).toString("hex");

  try {
    await putDocument(storageKey, body, contentType);
  } catch (err) {
    // Region/endpoint/bucket aren't secret - logging them (never the access
    // key/secret) lets us confirm which config this deployment is actually
    // running with, without exposing credentials.
    console.error("Document upload: failed to store file in R2", {
      message: (err as Error).message,
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT,
      bucket: process.env.S3_BUCKET,
      accessKeyIdLength: (process.env.S3_ACCESS_KEY_ID ?? "").length,
      secretAccessKeyLength: (process.env.S3_SECRET_ACCESS_KEY ?? "").length,
    });
    return res.status(502).json({ error: "Failed to store the uploaded file. Please try again shortly." });
  }

  const document = await prisma.document.create({
    data: {
      ownerId: user.id,
      storageKey,
      checksum,
      encryptionKeyRef,
      recipientName: deliveryAddress.recipientName,
      recipientPhone: deliveryAddress.recipientPhone,
      recipientEmail: deliveryAddress.recipientEmail,
      streetAddress: deliveryAddress.streetAddress,
      localArea: deliveryAddress.localArea,
      city: deliveryAddress.city,
      zone: deliveryAddress.zone,
      postalCode: deliveryAddress.postalCode,
      country: deliveryAddress.country ?? "ZA",
      returnPreference: deliveryAddress.returnPreference ?? "MANAGED",
    },
  });

  await appendAuditEvent({
    documentId: document.id,
    actorId: user.id,
    action: "uploaded",
    metadata: { filename, checksum },
    ip: req.socket.remoteAddress ?? undefined,
  });

  return res.status(201).json({ id: document.id, status: document.status });
}
