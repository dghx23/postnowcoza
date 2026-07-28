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
 * TODO: this throws until a PSP is chosen and credentialed — no fabricated
 * success path. Once wired up, this should call that PSP's RTP endpoint
 * and map its response onto PayShapRequestToPayResult.
 */
export async function createPayShapRequest(
  input: PayShapRequestToPayInput,
): Promise<PayShapRequestToPayResult> {
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
 * TODO: replace with the PSP's actual signature scheme (usually HMAC over
 * the raw body using PAYSHAP_WEBHOOK_SECRET) once chosen.
 */
export function verifyPayShapWebhookSignature(
  _rawBody: string,
  _signatureHeader: string | undefined,
): boolean {
  return false;
}
