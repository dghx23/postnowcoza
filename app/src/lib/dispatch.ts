import type { SubmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { getRates, createShipment } from "@/lib/bobgo";
import { FACILITY_ADDRESS, FACILITY_CONTACT, DOCUMENT_PARCEL } from "@/lib/facility";

// Kicks off the outbound leg: our facility -> customer. Call this once a
// document has been marked PRINTED. Rates must be requested first — Bob Go
// rejects shipment creation with a provider/service level that wasn't
// confirmed available for this specific route.
export async function dispatchDocument(
  documentId: string,
  actorId: string,
  options?: { collectionMinDate?: string; preserveDispatchFee?: boolean },
) {
  const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });

  if (document.status !== "PRINTED") {
    throw new Error(`Cannot dispatch a document in status ${document.status}`);
  }

  const existing = await prisma.bobgoShipment.findFirst({
    where: { documentId, direction: "OUTBOUND" },
  });
  if (existing) {
    throw new Error(`Outbound shipment already exists for document ${documentId}`);
  }

  const deliveryAddress = {
    street_address: document.streetAddress,
    local_area: document.localArea,
    city: document.city,
    zone: document.zone,
    country: document.country,
    code: document.postalCode,
  };

  const { rates } = await getRates({
    collection_address: FACILITY_ADDRESS,
    delivery_address: deliveryAddress,
    parcels: [DOCUMENT_PARCEL],
  });

  if (rates.length === 0) {
    throw new Error(`No courier rates available for document ${documentId}`);
  }

  // Cheapest available service level. Swap for a different rule (fastest,
  // preferred courier) here if the business wants one later.
  const chosen = rates.reduce((a, b) => (a.total_price <= b.total_price ? a : b));

  const shipment = await createShipment({
    collection_address: FACILITY_ADDRESS,
    collection_contact_name: FACILITY_CONTACT.name,
    collection_contact_email: FACILITY_CONTACT.email,
    collection_contact_mobile_number: FACILITY_CONTACT.mobile_number,
    delivery_address: deliveryAddress,
    delivery_contact_name: document.recipientName,
    delivery_contact_email: document.recipientEmail,
    delivery_contact_mobile_number: document.recipientPhone,
    parcels: [DOCUMENT_PARCEL],
    provider_slug: chosen.provider_slug,
    service_level_code: chosen.service_level_code,
    custom_tracking_reference: document.id,
    custom_order_number: document.id,
    ...(options?.collectionMinDate
      ? { collection_min_date: options.collectionMinDate }
      : {}),
  });

  await prisma.bobgoShipment.create({
    data: {
      documentId: document.id,
      direction: "OUTBOUND",
      providerSlug: chosen.provider_slug,
      serviceLevelCode: chosen.service_level_code,
      trackingReference: shipment.tracking_reference,
      submissionStatus: mapSubmissionStatus(shipment.submission_status),
      failedReason: shipment.failed_reason ?? undefined,
    },
  });

  // Keep the fee the customer already paid if set; otherwise store the rate.
  const fee =
    options?.preserveDispatchFee && document.dispatchFee != null
      ? document.dispatchFee
      : chosen.total_price;

  await prisma.document.update({
    where: { id: document.id },
    data: { status: "DISPATCHED", dispatchFee: fee },
  });

  await appendAuditEvent({
    documentId: document.id,
    actorId,
    action: "dispatch_created",
    metadata: {
      provider_slug: chosen.provider_slug,
      service_level_code: chosen.service_level_code,
      tracking_reference: shipment.tracking_reference,
      collection_min_date: options?.collectionMinDate ?? null,
    },
  });

  return shipment;
}

export function mapSubmissionStatus(status: string): SubmissionStatus {
  const map: Record<string, SubmissionStatus> = {
    "pending-rates": "PENDING_RATES",
    "pending-submission": "PENDING_SUBMISSION",
    success: "SUCCESS",
    "no-rates": "NO_RATES",
    "failed-will-retry": "FAILED_WILL_RETRY",
    "failed-indefinitely": "FAILED_INDEFINITELY",
  };
  return map[status] ?? "PENDING_SUBMISSION";
}
