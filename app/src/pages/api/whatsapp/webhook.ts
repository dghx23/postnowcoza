import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { getRates } from "@/lib/bobgo";
import { FACILITY_ADDRESS, DOCUMENT_PARCEL } from "@/lib/facility";
import { sendTextMessage, sendListMenu } from "@/lib/whatsapp";

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
// Pragmatic first pass: User has no phone field in the schema, so we gate
// the staff-only dash_summary intent against an env allowlist instead of a
// DB lookup. TODO: once User gets a phone column, replace this with a role
// check against the sender's WhatsApp number.
const STAFF_NUMBERS = (process.env.WHATSAPP_STAFF_NUMBERS ?? "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);

const MENU_SECTIONS = [
  {
    title: "PostNow",
    rows: [
      { id: "track_doc", title: "Track my document", description: "Get the latest status" },
      { id: "get_quote", title: "Get a courier quote", description: "Estimate a delivery price" },
      { id: "dash_summary", title: "Dispatch summary", description: "Staff only" },
    ],
  },
];

// Normalizes phone numbers for comparison: strips everything but digits and
// drops a leading country code prefix ambiguity by comparing the last 9
// digits (South African mobile numbers are 9 digits after the leading 0/27).
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-9);
}

function sendMenu(to: string) {
  return sendListMenu(
    to,
    "PostNow",
    "Hi! What would you like to do?",
    "Choose an option",
    MENU_SECTIONS
  );
}

async function handleTrackDoc(to: string) {
  const target = normalizePhone(to);
  const documents = await prisma.document.findMany({
    include: { bobgoShipments: true },
    orderBy: { updatedAt: "desc" },
  });
  const match = documents.find((doc) => normalizePhone(doc.recipientPhone) === target);

  if (!match) {
    await sendTextMessage(
      to,
      "I couldn't find a document linked to this number. Please reply with your document reference number."
    );
    return;
  }

  const shipment = match.bobgoShipments.find((s) => s.direction === "OUTBOUND") ?? match.bobgoShipments[0];
  const trackingLine = shipment?.trackingReference
    ? `Tracking ref: ${shipment.trackingReference} (${shipment.trackingStatus ?? "no update yet"})`
    : "No courier shipment booked yet.";

  await sendTextMessage(to, `Status: ${match.status}\n${trackingLine}`);
}

async function handleGetQuoteIntro(to: string) {
  await sendTextMessage(
    to,
    "Reply with: quote <destination city> <weight in kg>\nExample: quote Cape Town 0.5"
  );
}

async function handleQuoteText(to: string, text: string) {
  const match = text.match(/^quote\s+(.+)\s+([\d.]+)$/i);
  if (!match) {
    await sendTextMessage(
      to,
      "Sorry, I couldn't parse that. Reply with: quote <destination city> <weight in kg>"
    );
    return;
  }

  const city = match[1].trim();
  const weightKg = parseFloat(match[2]);

  try {
    const { rates } = await getRates({
      collection_address: FACILITY_ADDRESS,
      // Only the city is known from this simplified chat flow, so the rest
      // of the delivery address is left blank — good enough for an
      // indicative quote, not for actually booking a shipment.
      delivery_address: {
        street_address: "",
        local_area: "",
        city,
        zone: "",
        country: "ZA",
        code: "",
      },
      parcels: [{ ...DOCUMENT_PARCEL, submitted_weight_kg: weightKg }],
    });

    const top3 = [...rates].sort((a, b) => a.total_price - b.total_price).slice(0, 3);
    if (top3.length === 0) {
      await sendTextMessage(to, `No rates found for ${city}. Please double-check the city name.`);
      return;
    }

    const lines = top3.map((r) => `${r.service_name}: R${r.total_price.toFixed(2)}`);
    await sendTextMessage(to, `Top options to ${city}:\n${lines.join("\n")}`);
  } catch (err) {
    console.error("WhatsApp quote lookup failed", err);
    await sendTextMessage(to, "Sorry, I couldn't get a quote right now. Please try again shortly.");
  }
}

async function handleDashSummary(to: string) {
  if (!STAFF_NUMBERS.includes(normalizePhone(to))) {
    await sendTextMessage(to, "Sorry, this option is only available to PostNow staff.");
    return;
  }

  const [active, inTransit, delivered, exceptions] = await Promise.all([
    prisma.document.count({ where: { status: { in: ["DISPATCHED", "QUEUED_FOR_PRINT", "PRINTED"] } } }),
    prisma.document.count({ where: { status: { in: ["IN_TRANSIT", "RETURN_IN_TRANSIT"] } } }),
    prisma.document.count({ where: { status: { in: ["DELIVERED", "RETURNED"] } } }),
    prisma.bobgoShipment.count({ where: { failedReason: { not: null } } }),
  ]);

  await sendTextMessage(
    to,
    `Dispatch summary:\nActive: ${active}\nIn transit: ${inTransit}\nDelivered: ${delivered}\nExceptions: ${exceptions}`
  );
}

// Looks up a document by its CUID id/reference as typed in free text, for
// the "reply with your reference number" fallback after a failed phone
// lookup in handleTrackDoc.
async function handleReferenceLookup(to: string, ref: string): Promise<boolean> {
  const doc = await prisma.document.findUnique({
    where: { id: ref },
    include: { bobgoShipments: true },
  });
  if (!doc) return false;

  const shipment = doc.bobgoShipments.find((s) => s.direction === "OUTBOUND") ?? doc.bobgoShipments[0];
  const trackingLine = shipment?.trackingReference
    ? `Tracking ref: ${shipment.trackingReference} (${shipment.trackingStatus ?? "no update yet"})`
    : "No courier shipment booked yet.";

  await sendTextMessage(to, `Status: ${doc.status}\n${trackingLine}`);
  return true;
}

async function handleInboundText(to: string, text: string) {
  const trimmed = text.trim();

  if (/^quote\s+/i.test(trimmed)) {
    await handleQuoteText(to, trimmed);
    return;
  }

  // Document ids in this schema are cuids (alphanumeric, ~25 chars,
  // starting with "c") - treat anything matching that shape as a reference
  // lookup attempt before falling back to the menu.
  if (/^c[a-z0-9]{20,}$/i.test(trimmed)) {
    const found = await handleReferenceLookup(to, trimmed);
    if (found) return;
    await sendTextMessage(to, "I couldn't find a document with that reference. Please check and try again.");
    return;
  }

  await sendMenu(to);
}

async function handleListReply(to: string, id: string) {
  switch (id) {
    case "track_doc":
      await handleTrackDoc(to);
      break;
    case "get_quote":
      await handleGetQuoteIntro(to);
      break;
    case "dash_summary":
      await handleDashSummary(to);
      break;
    default:
      await sendMenu(to);
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ error: "Verification failed" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Always ack 200 quickly so Meta doesn't retry-storm us; errors are
  // logged server-side instead of surfaced to the caller.
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      // Delivery/status callbacks and other non-message events - nothing to do.
      return res.status(200).json({ received: true });
    }

    const from: string = message.from;

    // Note: inbound WhatsApp messages aren't tied to a Document at receipt
    // time (we don't yet know which document, if any, the sender means),
    // so they fall outside the Document-scoped AuditEvent model. Left out
    // of the audit trail as out of scope for this first pass.

    if (message.type === "interactive" && message.interactive?.type === "list_reply") {
      await handleListReply(from, message.interactive.list_reply.id);
    } else if (message.type === "text") {
      await handleInboundText(from, message.text?.body ?? "");
    } else {
      await sendMenu(from);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("WhatsApp webhook error", err);
    return res.status(200).json({ received: true, error: true });
  }
}
