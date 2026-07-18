import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import { getRates, createOrder, createReturn } from "@/lib/bobgo";
import { FACILITY_ADDRESS, FACILITY_CONTACT, DOCUMENT_PARCEL } from "@/lib/facility";
import { mapSubmissionStatus } from "@/lib/dispatch";

// The reverse leg: customer -> our facility. Bob Go's /orders/return
// endpoint is a fulfillment on an order, so a Bob Go order must exist first;
// we create one on first use since documents aren't e-commerce orders and
// otherwise never get one.
export async function initiateReturn(documentId: string, actorId: string) {
  const document = await prisma.document.findUniqueOrThrow({
    where: { id: documentId },
    include: { owner: true, bobgoShipments: true },
  });

  if (document.status !== "DELIVERED") {
    throw new Error(`Cannot return a document in status ${document.status}`);
  }

  const collectionAddress = {
    street_address: document.streetAddress,
    local_area: document.localArea,
    city: document.city,
    zone: document.zone,
    country: document.country,
    code: document.postalCode,
  };

  let bobgoOrderId = document.bobgoShipments.find((s) => s.bobgoOrderId)?.bobgoOrderId;

  if (!bobgoOrderId) {
    const [customerName, ...rest] = document.owner.email.split("@")[0].split(".");
    const order = await createOrder({
      channel_order_number: document.id,
      customer_name: customerName || document.recipientName,
      customer_surname: rest.join(" ") || document.recipientName,
      customer_email: document.owner.email,
      customer_phone: document.recipientPhone,
      currency: "ZAR",
      delivery_address: collectionAddress,
      order_items: [
        {
          description: "Document dispatch",
          sku: document.id,
          unit_price: 0,
          qty: 1,
          unit_weight_kg: DOCUMENT_PARCEL.submitted_weight_kg,
        },
      ],
      payment_status: "paid",
    });
    bobgoOrderId = order.id;
  }

  const { rates } = await getRates({
    collection_address: collectionAddress,
    delivery_address: FACILITY_ADDRESS,
    parcels: [DOCUMENT_PARCEL],
  });

  if (rates.length === 0) {
    throw new Error(`No courier rates available for return of document ${documentId}`);
  }

  const chosen = rates.reduce((a, b) => (a.total_price <= b.total_price ? a : b));

  const collectionMinDate = new Date();
  collectionMinDate.setDate(collectionMinDate.getDate() + 1);

  const returnShipment = await createReturn({
    order_id: bobgoOrderId,
    parcels: [DOCUMENT_PARCEL],
    delivery_address: FACILITY_ADDRESS,
    collection_address: collectionAddress,
    collection_contact_name: document.recipientName,
    collection_contact_email: document.recipientEmail,
    collection_contact_mobile_number: document.recipientPhone,
    delivery_contact_name: FACILITY_CONTACT.name,
    delivery_contact_email: FACILITY_CONTACT.email,
    delivery_contact_mobile_number: FACILITY_CONTACT.mobile_number,
    collection_min_date: collectionMinDate.toISOString(),
    provider_slug: chosen.provider_slug,
    service_level_code: chosen.service_level_code,
  });

  await prisma.bobgoShipment.create({
    data: {
      documentId: document.id,
      direction: "RETURN",
      bobgoOrderId,
      providerSlug: chosen.provider_slug,
      serviceLevelCode: chosen.service_level_code,
      trackingReference: returnShipment.tracking_reference,
      submissionStatus: mapSubmissionStatus(returnShipment.submission_status),
      failedReason: returnShipment.failed_reason ?? undefined,
    },
  });

  await prisma.document.update({
    where: { id: document.id },
    data: { status: "RETURN_REQUESTED" },
  });

  await appendAuditEvent({
    documentId: document.id,
    actorId,
    action: "return_requested",
    metadata: {
      bobgo_order_id: bobgoOrderId,
      provider_slug: chosen.provider_slug,
      service_level_code: chosen.service_level_code,
      tracking_reference: returnShipment.tracking_reference,
    },
  });

  return returnShipment;
}
