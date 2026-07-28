import { prisma } from "./db";
import { sendWhatsAppText, normalizeWhatsAppTo } from "./whatsapp";
import { getRatesForWeight, type RateCardZone } from "./rateCards";

/**
 * Conversation engine for PostNow's WhatsApp courier-booking offering
 * (booking a pickup/locker drop-off and paying instantly via PayShap,
 * separate from the E2 document-dispatch product). Each inbound WhatsApp
 * message is handled statelessly by a Vercel function, so the current
 * step lives in the WhatsAppSession table (src/lib/db.ts) keyed by phone.
 *
 * pages/api/whatsapp/webhook.ts calls handleInboundMessage() with the
 * parsed Cloud API message and this module sends replies directly via
 * sendWhatsAppText — it doesn't return anything for the route to relay.
 */

const WEIGHT_BRACKETS: Array<{ id: string; label: string; weightKg: number }> = [
  { id: "w1", label: "≤ 1 kg", weightKg: 1 },
  { id: "w2", label: "1–5 kg", weightKg: 5 },
  { id: "w5", label: "5–10 kg", weightKg: 10 },
  { id: "w10", label: "10–20 kg", weightKg: 20 },
];

interface SessionData {
  pickupType?: "DOOR" | "LOCKER" | "BUSINESS";
  pickupAddress?: string;
  recipientName?: string;
  recipientPhone?: string;
  recipientAddress?: string;
  recipientCity?: string;
  recipientProvince?: string;
  recipientPostalCode?: string;
  parcels?: Array<{ weightKg: number; description: string }>;
  quote?: { courier: string; code: string; price: number };
  bookingId?: string;
  // GlobeMe shopping fields
  customerEmail?: string;
  customerPhone?: string;
  productUrl?: string;
  productWeight?: number;
  shipMethod?: "EXPRESS" | "STANDARD" | "ECONOMY";
  orderId?: string;
}

interface Session {
  phone: string;
  mode: string;
  step: string;
  data: SessionData;
}

async function loadSession(phone: string): Promise<Session> {
  const row = await prisma.whatsAppSession.upsert({
    where: { phone },
    update: {},
    create: { phone, mode: "idle", step: "start", data: {} },
  });
  return { phone, mode: row.mode, step: row.step, data: (row.data as SessionData) ?? {} };
}

async function saveSession(session: Session): Promise<void> {
  await prisma.whatsAppSession.update({
    where: { phone: session.phone },
    data: { mode: session.mode, step: session.step, data: session.data as object },
  });
}

async function reply(to: string, message: string): Promise<void> {
  await sendWhatsAppText({ to, message });
}

function generateBookingRef(): string {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `PN-${new Date().getFullYear()}-${n}`;
}

function buttonMenu(): string {
  return [
    "What would you like to do?",
    "",
    "1️⃣ Book a courier (PostNow Express)",
    "2️⃣ Track a parcel",
    "3️⃣ Get a quote",
    "4️⃣ Shop from US (GlobeMe)",
    "5️⃣ Help",
    "",
    "Reply with a number.",
  ].join("\n");
}

/** Normalized shape the webhook handler extracts from a Cloud API message. */
export interface InboundWhatsAppMessage {
  from: string; // wa_id, digits only
  type: "text" | "interactive" | "location" | "image" | "video" | "unknown";
  text?: string;
  location?: { latitude: number; longitude: number };
}

export async function handleInboundMessage(msg: InboundWhatsAppMessage): Promise<void> {
  const phone = normalizeWhatsAppTo(msg.from) || msg.from;
  const session = await loadSession(phone);
  const text = (msg.text ?? "").trim();
  const lower = text.toLowerCase();

  // Global shortcuts, from any state.
  if (["menu", "hi", "hello", "start", "cancel"].includes(lower)) {
    session.mode = "idle";
    session.step = "start";
    session.data = {};
    await saveSession(session);
    await reply(
      phone,
      `👋 Hi! I'm PostNow — book a courier pickup or locker drop-off right here and pay instantly with PayShap.\n\n${buttonMenu()}`,
    );
    return;
  }

  if (session.mode === "idle") {
    await handleMainMenu(session, lower, phone);
    return;
  }

  if (session.mode === "booking") {
    await handleBookingStep(session, msg, phone);
    return;
  }

  if (session.mode === "tracking") {
    await handleTrackingStep(session, text, phone);
    return;
  }

  if (session.mode === "quoting") {
    await handleQuotingStep(session, lower, phone);
    return;
  }

  if (session.mode === "shopping") {
    await handleShoppingStep(session, msg, phone);
    return;
  }

  // Fallback: reset to menu.
  session.mode = "idle";
  await saveSession(session);
  await reply(phone, buttonMenu());
}

async function handleMainMenu(session: Session, lower: string, phone: string) {
  if (lower === "1" || lower.includes("book")) {
    session.mode = "booking";
    session.step = "pickup_type";
    session.data = {};
    await saveSession(session);
    await reply(
      phone,
      "🚚 Let's book your pickup.\n\nWhere should we collect from?\n1️⃣ My door\n2️⃣ Locker drop-off\n3️⃣ Business address",
    );
    return;
  }
  if (lower === "2" || lower.includes("track")) {
    session.mode = "tracking";
    session.step = "await_ref";
    await saveSession(session);
    await reply(phone, "🔍 Send me your booking reference (e.g. PN-2026-1234).");
    return;
  }
  if (lower === "3" || lower.includes("quote")) {
    session.mode = "quoting";
    session.step = "await_weight";
    await saveSession(session);
    await reply(
      phone,
      "💰 What's the parcel weight?\n" +
        WEIGHT_BRACKETS.map((b, i) => `${i + 1}️⃣ ${b.label}`).join("\n"),
    );
    return;
  }
  if (lower === "4" || lower.includes("shop") || lower.includes("globeme")) {
    session.mode = "shopping";
    session.step = "await_product_url";
    session.data = { customerPhone: phone };
    await saveSession(session);
    await reply(
      phone,
      "🌍 Welcome to GlobeMe! Buy from the US and we'll deliver to SA.\n\nPaste a product link (Amazon, Walmart, eBay, etc.) and we'll calculate the landed cost.",
    );
    return;
  }
  if (lower === "5" || lower.includes("help")) {
    await reply(
      phone,
      "📖 PostNow services:\n• Book a courier (express door, locker, or business pickup)\n• Track a parcel\n• Get an instant quote\n• Shop from US via GlobeMe\n\nType \"menu\" any time to start over.\nSupport: support@postnow.co.za",
    );
    return;
  }
  await reply(phone, `Sorry, I didn't catch that.\n\n${buttonMenu()}`);
}

async function handleBookingStep(
  session: Session,
  msg: InboundWhatsAppMessage,
  phone: string,
) {
  const text = (msg.text ?? "").trim();
  const lower = text.toLowerCase();

  if (session.step === "pickup_type") {
    const map: Record<string, SessionData["pickupType"]> = {
      "1": "DOOR",
      "2": "LOCKER",
      "3": "BUSINESS",
    };
    const chosen = map[text] ?? (lower.includes("door") ? "DOOR" : lower.includes("locker") ? "LOCKER" : undefined);
    if (!chosen) {
      await reply(phone, "Please reply 1 (door), 2 (locker) or 3 (business).");
      return;
    }
    session.data.pickupType = chosen;
    session.step = "pickup_address";
    await saveSession(session);
    await reply(
      phone,
      "📍 Share your pickup address (or share your WhatsApp location pin instead).",
    );
    return;
  }

  if (session.step === "pickup_address") {
    if (msg.type === "location" && msg.location) {
      session.data.pickupAddress = `${msg.location.latitude}, ${msg.location.longitude}`;
    } else if (text) {
      session.data.pickupAddress = text;
    } else {
      await reply(phone, "Please type the pickup address or share your location.");
      return;
    }
    session.step = "recipient_name";
    await saveSession(session);
    await reply(phone, "👤 Who's receiving this parcel? Send their name.");
    return;
  }

  if (session.step === "recipient_name") {
    if (!text) {
      await reply(phone, "Please send the recipient's name.");
      return;
    }
    session.data.recipientName = text;
    session.step = "recipient_phone";
    await saveSession(session);
    await reply(
      phone,
      "📱 And their WhatsApp/cellphone number? (You can also forward their contact card.)",
    );
    return;
  }

  if (session.step === "recipient_phone") {
    const normalized = normalizeWhatsAppTo(text);
    if (!normalized || normalized.length < 10) {
      await reply(phone, "That doesn't look like a valid number — please resend it (e.g. 082 123 4567).");
      return;
    }
    session.data.recipientPhone = normalized;
    session.step = "recipient_address";
    await saveSession(session);
    await reply(phone, "📍 What's the delivery address?");
    return;
  }

  if (session.step === "recipient_address") {
    if (!text) {
      await reply(phone, "Please send the delivery address.");
      return;
    }
    session.data.recipientAddress = text;
    session.step = "parcel_weight";
    await saveSession(session);
    await reply(
      phone,
      "📦 What's the parcel weight?\n" +
        WEIGHT_BRACKETS.map((b, i) => `${i + 1}️⃣ ${b.label}`).join("\n"),
    );
    return;
  }

  if (session.step === "parcel_weight") {
    const idx = Number(text) - 1;
    const bracket = WEIGHT_BRACKETS[idx];
    if (!bracket) {
      await reply(phone, "Please reply with a number from the list above.");
      return;
    }
    session.data.parcels = [{ weightKg: bracket.weightKg, description: bracket.label }];
    const zone: RateCardZone = "main"; // TODO: derive from pickup/recipient province once addresses are geocoded
    const quotes = getRatesForWeight(zone, bracket.weightKg);
    if (quotes.length === 0) {
      await reply(phone, "Sorry, no courier rates are available for that weight right now. Type \"menu\" to start over.");
      session.mode = "idle";
      await saveSession(session);
      return;
    }
    session.data.quote = quotes[0];
    session.step = "confirm_service";
    await saveSession(session);
    await reply(
      phone,
      `📋 Cheapest option: ${quotes[0].courier} — R${quotes[0].price.toFixed(2)}\n\n` +
        (quotes.length > 1
          ? `Other options:\n${quotes
              .slice(1, 4)
              .map((q) => `• ${q.courier} — R${q.price.toFixed(2)}`)
              .join("\n")}\n\n`
          : "") +
        "Reply \"yes\" to book the cheapest option, or \"cancel\" to start over.",
    );
    return;
  }

  if (session.step === "confirm_service") {
    if (!lower.startsWith("y")) {
      await reply(phone, "No problem — type \"menu\" to start over.");
      session.mode = "idle";
      await saveSession(session);
      return;
    }
    const quote = session.data.quote!;
    const bookingRef = generateBookingRef();
    const booking = await prisma.courierBooking.create({
      data: {
        bookingRef,
        status: "AWAITING_PAYMENT",
        senderPhone: phone,
        pickupType: session.data.pickupType ?? "DOOR",
        pickupAddress: session.data.pickupAddress,
        recipientName: session.data.recipientName,
        recipientPhone: session.data.recipientPhone,
        recipientAddress: session.data.recipientAddress,
        parcels: session.data.parcels as object,
        serviceLevel: quote.code,
        courier: quote.courier,
        price: quote.price,
      },
    });
    session.data.bookingId = booking.id;
    session.step = "await_payment";
    await saveSession(session);

    await reply(
      phone,
      `✅ Booking ${bookingRef} created — ${quote.courier}, R${quote.price.toFixed(2)}.\n\n` +
        "💳 We'll send a PayShap payment request to this number next. " +
        "(PayShap Request-to-Pay isn't wired up yet — see src/lib/payshap.ts — so this booking stays AWAITING_PAYMENT for now.)",
    );

    // TODO: once a PayShap PSP account exists, call createPayShapRequest()
    // here and move the booking to PAID from pages/api/payshap/webhook.ts
    // on confirmation, then notify both senderPhone and recipientPhone.

    session.mode = "idle";
    session.step = "start";
    await saveSession(session);
    return;
  }

  // Unknown step — reset.
  session.mode = "idle";
  session.step = "start";
  await saveSession(session);
  await reply(phone, buttonMenu());
}

async function handleTrackingStep(session: Session, text: string, phone: string) {
  const ref = text.trim();
  const booking = await prisma.courierBooking.findUnique({ where: { bookingRef: ref } });
  session.mode = "idle";
  session.step = "start";
  await saveSession(session);

  if (!booking) {
    await reply(phone, `I couldn't find a booking with reference "${ref}". Type "menu" to try again.`);
    return;
  }

  await reply(
    phone,
    `📦 ${booking.bookingRef}\nStatus: ${booking.status}\n${booking.courier ?? ""} ${
      booking.price ? `· R${booking.price.toFixed(2)}` : ""
    }`.trim(),
  );
}

async function handleQuotingStep(session: Session, lower: string, phone: string) {
  const idx = Number(lower) - 1;
  const bracket = WEIGHT_BRACKETS[idx];
  session.mode = "idle";
  session.step = "start";
  await saveSession(session);

  if (!bracket) {
    await reply(phone, "Please reply with a number from the list. Type \"menu\" to start over.");
    return;
  }

  const quotes = getRatesForWeight("main", bracket.weightKg);
  if (quotes.length === 0) {
    await reply(phone, "No rates available for that weight right now.");
    return;
  }

  await reply(
    phone,
    `💰 Quotes for ${bracket.label}:\n\n` +
      quotes
        .slice(0, 4)
        .map((q) => `• ${q.courier} — R${q.price.toFixed(2)}`)
        .join("\n") +
      "\n\nType \"menu\" to book one of these.",
  );
}

async function handleShoppingStep(
  session: Session,
  msg: InboundWhatsAppMessage,
  phone: string,
) {
  const text = (msg.text ?? "").trim();
  const lower = text.toLowerCase();

  if (session.step === "await_product_url") {
    // Validate that text looks like a URL.
    if (!text.startsWith("http") && !text.includes("amazon") && !text.includes("walmart")) {
      await reply(phone, "Please paste a product link (e.g. https://amazon.com/...) or the ASIN.");
      return;
    }

    // Store URL and move to weight step.
    session.data.productUrl = text;
    session.step = "await_weight_shopping";
    await saveSession(session);

    await reply(
      phone,
      "📦 What's the estimated weight?\n" +
        "1️⃣ ≤ 1 kg\n" +
        "2️⃣ 1–2 kg\n" +
        "3️⃣ 2–5 kg\n" +
        "4️⃣ 5+ kg\n" +
        "Or reply with kg (e.g. 1.5)",
    );
    return;
  }

  if (session.step === "await_weight_shopping") {
    let weight = 1;
    if (lower === "1") weight = 0.5;
    else if (lower === "2") weight = 1.5;
    else if (lower === "3") weight = 3;
    else if (lower === "4") weight = 7;
    else if (/^\d+(\.\d+)?$/.test(text)) weight = parseFloat(text);

    session.data.productWeight = weight;
    session.step = "await_ship_method";
    await saveSession(session);

    await reply(
      phone,
      "🚚 Shipping method?\n" +
        "1️⃣ Express ($32)\n" +
        "2️⃣ Standard ($22)\n" +
        "3️⃣ Economy ($14)",
    );
    return;
  }

  if (session.step === "await_ship_method") {
    let shipMethod: "EXPRESS" | "STANDARD" | "ECONOMY" = "STANDARD";
    if (lower === "1") shipMethod = "EXPRESS";
    else if (lower === "3") shipMethod = "ECONOMY";

    session.data.shipMethod = shipMethod;
    session.step = "await_recipient_name";
    await saveSession(session);

    await reply(phone, "👤 Recipient's full name?");
    return;
  }

  if (session.step === "await_recipient_name") {
    session.data.recipientName = text;
    session.step = "await_recipient_email";
    await saveSession(session);

    await reply(phone, "📧 Recipient's email?");
    return;
  }

  if (session.step === "await_recipient_email") {
    session.data.customerEmail = text;
    session.step = "await_street_address";
    await saveSession(session);

    await reply(phone, "🏠 Street address? (e.g. 123 Main St)");
    return;
  }

  if (session.step === "await_street_address") {
    session.data.recipientAddress = text;
    session.step = "await_city";
    await saveSession(session);

    await reply(phone, "🏙️ City?");
    return;
  }

  if (session.step === "await_city") {
    session.data.recipientCity = text;
    session.step = "await_province";
    await saveSession(session);

    await reply(
      phone,
      "🗺️ Province?\n" +
        "1️⃣ Western Cape\n" +
        "2️⃣ Gauteng\n" +
        "3️⃣ KwaZulu-Natal\n" +
        "4️⃣ Other",
    );
    return;
  }

  if (session.step === "await_province") {
    let province = "Other";
    if (lower === "1") province = "Western Cape";
    else if (lower === "2") province = "Gauteng";
    else if (lower === "3") province = "KwaZulu-Natal";

    session.data.recipientProvince = province;
    session.step = "await_postal_code";
    await saveSession(session);

    await reply(phone, "📮 Postal code?");
    return;
  }

  if (session.step === "await_postal_code") {
    session.data.recipientPostalCode = text;
    session.step = "review_and_pay";
    await saveSession(session);

    // Create ShoppingOrder and calculate landed cost.
    const { calculateLandedCost } = await import("./globeme");
    const breakdown = await calculateLandedCost({
      itemPriceUsd: 150, // TODO: extract from product URL
      weightKg: session.data.productWeight || 1,
      shipMethod: session.data.shipMethod as "EXPRESS" | "STANDARD" | "ECONOMY" || "STANDARD",
      personalShopperFeeUsd: 0, // TODO: offer optional shopper fee
      markupPercent: 15,
    });

    // Create order in database.
    const orderRef = `GM-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const order = await prisma.shoppingOrder.create({
      data: {
        orderRef,
        status: "QUOTED",
        customerEmail: session.data.customerEmail || "unknown@example.com",
        customerPhone: phone,
        recipientName: session.data.recipientName || "Unknown",
        recipientPhone: phone,
        recipientStreet: session.data.recipientAddress || "Unknown",
        recipientCity: session.data.recipientCity || "Unknown",
        recipientProvince: session.data.recipientProvince || "Other",
        recipientPostalCode: session.data.recipientPostalCode || "0000",
        productUrl: session.data.productUrl || "",
        productWeight: session.data.productWeight,
        shipMethod: session.data.shipMethod as "EXPRESS" | "STANDARD" | "ECONOMY",
        itemPriceCents: breakdown.itemPriceCents,
        shippingCostCents: breakdown.shippingCostCents,
        landedCostCents: breakdown.landedCostCents,
        finalQuoteCents: breakdown.finalQuoteCents,
        finalQuoteZar: breakdown.finalQuoteZar,
        fxRateUsdzarSnapshot: breakdown.fxRateUsdZar,
      },
    });

    // Show breakdown.
    await reply(
      phone,
      `💰 Your GlobeMe quote (${orderRef}):\n` +
        `• Item: $${breakdown.itemPriceUsd.toFixed(2)}\n` +
        `• Shipping: $${breakdown.shippingUsd.toFixed(2)}\n` +
        `• Duty (${(breakdown.dutyRatePercent * 100).toFixed(0)}%): $${breakdown.dutyUsd.toFixed(2)}\n` +
        `• VAT (15%): $${breakdown.vatUsd.toFixed(2)}\n` +
        `• Total (landed): $${breakdown.landedCostUsd.toFixed(2)}\n` +
        `• With margin: $${breakdown.finalQuoteUsd.toFixed(2)} ≈ R${breakdown.finalQuoteZar.toFixed(2)}\n\n` +
        `Ready to check out? Reply "yes" or "menu" to cancel.`,
    );

    session.data.orderId = order.id;
    await saveSession(session);
    return;
  }

  if (session.step === "review_and_pay") {
    if (lower === "yes" || lower === "y" || lower === "confirm") {
      // TODO: create PayFast request and send link
      await reply(
        phone,
        `✅ Order confirmed! PayFast payment link would be sent here (stub until PAYFAST_MERCHANT_ID is set). Order ref: ${session.data.orderId}`,
      );

      // Reset.
      session.mode = "idle";
      session.step = "start";
      session.data = {};
      await saveSession(session);
      return;
    }

    if (lower === "menu" || lower === "cancel") {
      session.mode = "idle";
      session.step = "start";
      session.data = {};
      await saveSession(session);
      await reply(phone, buttonMenu());
      return;
    }

    await reply(phone, "Reply \"yes\" to proceed or \"menu\" to cancel.");
  }
}
