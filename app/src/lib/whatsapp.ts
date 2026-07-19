/**
 * WhatsApp Cloud API (Meta Graph) helpers.
 */

const DEFAULT_API_VERSION = "v25.0";

export function isWhatsAppConfigured(): boolean {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return Boolean(
    token &&
      token !== "your_permanent_token_here" &&
      phoneNumberId
  );
}

/**
 * Normalize a phone number to digits only for the Graph API.
 * SA local numbers starting with 0 → country code 27.
 */
export function normalizeWhatsAppTo(phone: string): string {
  let digits = String(phone).replace(/\D/g, "");
  if (!digits) return "";
  // South Africa: 0XXXXXXXXX → 27XXXXXXXXX
  if (digits.length === 10 && digits.startsWith("0")) {
    digits = `27${digits.slice(1)}`;
  }
  // Already has leading 27 without +
  return digits;
}

export function isValidWhatsAppPhone(phone: string): boolean {
  const to = normalizeWhatsAppTo(phone);
  // E.164 without + : typically 10–15 digits
  return to.length >= 10 && to.length <= 15;
}

export async function sendWhatsAppText(input: {
  to: string;
  message: string;
}): Promise<{ messageId?: string; raw: unknown }> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || DEFAULT_API_VERSION;

  if (!token || token === "your_permanent_token_here" || !phoneNumberId) {
    throw new Error(
      "WhatsApp is not configured (set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID)"
    );
  }

  const to = normalizeWhatsAppTo(input.to);
  if (!to || !isValidWhatsAppPhone(input.to)) {
    throw new Error("A valid phone number is required for WhatsApp");
  }
  if (!input.message?.trim()) {
    throw new Error("Message body is required");
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: {
        body: input.message.trim(),
        preview_url: true,
      },
    }),
  });

  const data = (await response.json()) as {
    error?: { message?: string };
    messages?: Array<{ id?: string }>;
  };

  if (!response.ok) {
    const msg =
      data?.error?.message ||
      (typeof data?.error === "string" ? data.error : null) ||
      `WhatsApp API error (${response.status})`;
    console.error("WhatsApp Error:", data);
    throw new Error(msg);
  }

  return {
    messageId: data.messages?.[0]?.id,
    raw: data,
  };
}
