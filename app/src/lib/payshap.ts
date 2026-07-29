/**
 * PayShap Request-to-Pay (RTP) integration.
 *
 * PayShap is SARB's real-time low-value payment rail — there is no single
 * public PayShap API to call directly. Access is always through a bank or
 * PSP that has PayShap RTP enabled (e.g. Ozow, Netcash, Electrum). Which
 * one PostNow uses, and its exact request/response contract, isn't decided
 * yet, so this module defines the provider-agnostic shape the rest of the
 * app depends on (src/lib/whatsappBookingBot.ts, pages/api/payshap/webhook.ts)
 * and a single place to wire in the real PSP call once an account exists.
 *
 * Env (Vercel):
 *   PAYSHAP_PSP              — which PSP client to use once implemented (e.g. "ozow")
 *   PAYSHAP_API_KEY
 *   PAYSHAP_API_SECRET
 *   PAYSHAP_MERCHANT_ID
 *   PAYSHAP_WEBHOOK_SECRET   — verifies inbound payment-confirmation webhooks
 */

export function isPayShapConfigured(): boolean {
  // In development, allow demo mode without real credentials
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  return Boolean(
    process.env.PAYSHAP_PSP &&
      process.env.PAYSHAP_API_KEY &&
      process.env.PAYSHAP_MERCHANT_ID,
  );
}

export interface PayShapRequestToPayInput {
  /** Recipient's ShapID — in practice just their WhatsApp/cellphone number. */
  shapId: string;
  amount: number;
  reference: string;
  /** Shown in the payer's banking app alongside the request. */
  description?: string;
}

export interface PayShapRequestToPayResult {
  requestId: string;
  status: "PENDING" | "SENT";
  raw: unknown;
}

/**
 * Sends a Request-to-Pay for the given amount to the payer's ShapID.
 *
 * In development mode, returns a mock successful request. In production,
 * requires real PSP credentials (Ozow/Netcash/Electrum).
 */
export async function createPayShapRequest(
  input: PayShapRequestToPayInput,
): Promise<PayShapRequestToPayResult> {
  // Demo mode for development/preview
  if (process.env.NODE_ENV === "development") {
    const requestId = `DEMO-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    return {
      requestId,
      status: "SENT",
      raw: { demo: true, input },
    };
  }

  if (!isPayShapConfigured()) {
    throw new Error(
      "PayShap is not configured — set PAYSHAP_PSP, PAYSHAP_API_KEY and PAYSHAP_MERCHANT_ID once a PSP (Ozow/Netcash/Electrum) account exists",
    );
  }

  throw new Error(
    `PayShap PSP integration for "${process.env.PAYSHAP_PSP}" is not implemented yet — see src/lib/payshap.ts`,
  );
}

/**
 * Verifies an inbound payment-confirmation webhook from the PSP.
 * In development mode, accepts all requests. In production, requires
 * real HMAC signature verification with PAYSHAP_WEBHOOK_SECRET.
 */
export function verifyPayShapWebhookSignature(
  _rawBody: string,
  _signatureHeader: string | undefined,
): boolean {
  // Demo mode: accept all webhook requests in development
  if (process.env.NODE_ENV === "development") {
    return true;
  }

  // Production: TODO replace with the PSP's actual signature scheme
  // (usually HMAC over the raw body using PAYSHAP_WEBHOOK_SECRET)
  return false;
}
