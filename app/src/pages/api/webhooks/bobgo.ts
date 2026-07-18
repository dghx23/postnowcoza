import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { verifyBobgoSignature } from "@/lib/bobgo-webhook";
import { getPOD, getWaybill } from "@/lib/bobgo";
import { mapSubmissionStatus } from "@/lib/dispatch";

export const config = {
  api: { bodyParser: false },
};

// Tracking statuses that mean the shipment is actively moving, per document.
const IN_TRANSIT_STATUSES = new Set([
  "collected",
  "in-transit",
  "out-for-delivery",
  "ready-for-pickup",
]);
const EXCEPTION_STATUSES = new Set([
  "collection-exception",
  "delivery-exception",
  "failed-collection",
  "failed-delivery",
]);

async function readRawBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["bobgo-webhook-signature"] as string | undefined;

  if (!verifyBobgoSignature(rawBody, signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const payload = JSON.parse(rawBody.toString("utf8"));

  // Bob Go doesn't put a topic name in the payload body itself for most
  // topics, so we infer it from shape. `checkpoints` is unique to
  // tracking/updated; everything else is a shipment-record snapshot keyed
  // by `tracking_reference`.
  const trackingReference: string | undefined =
    payload.tracking_reference ?? payload.shipment_tracking_reference ?? payload.method_reference;

  if (!trackingReference) {
    // Nothing we can correlate to a shipment (e.g. an unrecognized topic) —
    // acknowledge so Bob Go doesn't disable the webhook, but don't process it.
    return res.status(200).json({ received: true, unhandled: true });
  }

  const shipment = await prisma.bobgoShipment.findUnique({ where: { trackingReference } });
  if (!shipment) {
    return res.status(200).json({ received: true, unmatched: true });
  }

  // Raw payload is recorded before any interpretation, so the audit trail
  // survives bugs in the mapping logic below.
  await appendAuditEvent({
    documentId: shipment.documentId,
    action: "bobgo_webhook_received",
    metadata: { trackingReference, payload },
  });

  await prisma.bobgoShipment.update({
    where: { id: shipment.id },
    data: { rawPayload: payload },
  });

  if (Array.isArray(payload.checkpoints)) {
    await handleTrackingUpdate(shipment.id, shipment.documentId, shipment.direction, payload.status);
  } else if (typeof payload.submission_status === "string") {
    await handleSubmissionStatusUpdate(shipment.id, payload.submission_status, payload.failed_reason);
  }

  return res.status(200).json({ received: true });
}

async function handleTrackingUpdate(
  shipmentId: string,
  documentId: string,
  direction: "OUTBOUND" | "RETURN",
  status: string
) {
  await prisma.bobgoShipment.update({
    where: { id: shipmentId },
    data: { trackingStatus: status },
  });

  if (IN_TRANSIT_STATUSES.has(status)) {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: direction === "RETURN" ? "RETURN_IN_TRANSIT" : "IN_TRANSIT" },
    });
  } else if (status === "delivered") {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: direction === "RETURN" ? "RETURNED" : "DELIVERED" },
    });

    try {
      const shipment = await prisma.bobgoShipment.findUniqueOrThrow({ where: { id: shipmentId } });
      if (shipment.trackingReference) {
        const pod = await getPOD(shipment.trackingReference);
        await prisma.bobgoShipment.update({ where: { id: shipmentId }, data: { podUrl: pod.url } });
        await appendAuditEvent({
          documentId,
          action: direction === "RETURN" ? "return_delivered_pod" : "delivered_pod",
          metadata: { pod_url: pod.url },
        });
      }
    } catch (err) {
      // POD fetch failing shouldn't block recording the delivery itself —
      // it can be retried manually from the shipment record.
      await appendAuditEvent({
        documentId,
        action: "pod_fetch_failed",
        metadata: { error: (err as Error).message },
      });
    }
  } else if (EXCEPTION_STATUSES.has(status)) {
    await appendAuditEvent({
      documentId,
      action: "shipment_exception",
      metadata: { status },
    });
  }
}

async function handleSubmissionStatusUpdate(
  shipmentId: string,
  submissionStatus: string,
  failedReason: string | null | undefined
) {
  const mapped = mapSubmissionStatus(submissionStatus);
  await prisma.bobgoShipment.update({
    where: { id: shipmentId },
    data: { submissionStatus: mapped, failedReason: failedReason ?? undefined },
  });

  if (mapped === "SUCCESS") {
    try {
      const shipment = await prisma.bobgoShipment.findUniqueOrThrow({ where: { id: shipmentId } });
      if (shipment.trackingReference && !shipment.waybillUrl) {
        const waybill = await getWaybill([shipment.trackingReference]);
        await prisma.bobgoShipment.update({
          where: { id: shipmentId },
          data: { waybillUrl: waybill.url },
        });
      }
    } catch {
      // Waybill can be fetched again later from the dashboard/API; not fatal here.
    }
  }
}
