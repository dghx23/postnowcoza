import { createHash } from "crypto";

/**
 * PayFast custom integration (https://developers.payfast.co.za).
 *
 * Env (Vercel):
 *   Merchant_ID_Payfast  / PAYFAST_MERCHANT_ID
 *   Merchant_Key_Payfast / PAYFAST_MERCHANT_KEY
 *   PAYFAST_PASSPHRASE   (optional but recommended)
 *   PAYFAST_SANDBOX=true for sandbox.payfast.co.za
 */

export function getPayfastConfig() {
  const merchantId = (
    process.env.Merchant_ID_Payfast ??
    process.env.PAYFAST_MERCHANT_ID ??
    ""
  ).trim();
  const merchantKey = (
    process.env.Merchant_Key_Payfast ??
    process.env.PAYFAST_MERCHANT_KEY ??
    ""
  ).trim();
  const passphrase = (process.env.PAYFAST_PASSPHRASE ?? "").trim();
  // Production by default on Vercel; set PAYFAST_SANDBOX=true for sandbox keys.
  const useSandbox =
    process.env.PAYFAST_SANDBOX === "true" || process.env.PAYFAST_SANDBOX === "1";

  const processUrl = useSandbox
    ? "https://sandbox.payfast.co.za/eng/process"
    : "https://www.payfast.co.za/eng/process";

  const validateUrl = useSandbox
    ? "https://sandbox.payfast.co.za/eng/query/validate"
    : "https://www.payfast.co.za/eng/query/validate";

  return {
    merchantId,
    merchantKey,
    passphrase,
    processUrl,
    validateUrl,
    sandbox: useSandbox,
    configured: Boolean(merchantId && merchantKey),
  };
}

/** PayFast param encoding: spaces as +, URI-encoded, uppercase hex for %XX */
function pfEncode(value: string): string {
  return encodeURIComponent(value.trim())
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Build MD5 signature over attribute=value pairs in submission order.
 * Empty values are excluded. Passphrase appended last if set.
 */
export function generatePayfastSignature(
  data: Record<string, string | number | undefined | null>,
  passphrase?: string,
): string {
  const pairs: string[] = [];
  for (const [key, raw] of Object.entries(data)) {
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (value === "") continue;
    if (key === "signature") continue;
    pairs.push(`${key}=${pfEncode(value)}`);
  }
  let paramString = pairs.join("&");
  const pass = (passphrase ?? getPayfastConfig().passphrase).trim();
  if (pass) {
    paramString += `&passphrase=${pfEncode(pass)}`;
  }
  return createHash("md5").update(paramString).digest("hex");
}

export function verifyPayfastSignature(
  data: Record<string, string>,
  passphrase?: string,
): boolean {
  const received = (data.signature ?? "").toLowerCase();
  if (!received) return false;
  const { signature: _drop, ...rest } = data;
  const expected = generatePayfastSignature(rest, passphrase).toLowerCase();
  return expected === received;
}

export interface PayfastCheckoutFields {
  merchant_id: string;
  merchant_key: string;
  return_url: string;
  cancel_url: string;
  notify_url: string;
  name_first?: string;
  name_last?: string;
  email_address: string;
  cell_number?: string;
  m_payment_id: string;
  amount: string;
  item_name: string;
  item_description?: string;
  custom_str1?: string;
  custom_str2?: string;
  email_confirmation?: string;
  confirmation_address?: string;
  signature: string;
}

export function buildPayfastCheckout(input: {
  amount: number;
  itemName: string;
  itemDescription?: string;
  mPaymentId: string;
  email: string;
  cellNumber?: string;
  nameFirst?: string;
  nameLast?: string;
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
  documentId: string;
}): { action: string; fields: PayfastCheckoutFields; sandbox: boolean } {
  const cfg = getPayfastConfig();
  if (!cfg.configured) {
    throw new Error(
      "PayFast is not configured — set Merchant_ID_Payfast and Merchant_Key_Payfast in Vercel",
    );
  }

  const amount = input.amount.toFixed(2);
  const base: Record<string, string> = {
    merchant_id: cfg.merchantId,
    merchant_key: cfg.merchantKey,
    return_url: input.returnUrl,
    cancel_url: input.cancelUrl,
    notify_url: input.notifyUrl,
    email_address: input.email,
    m_payment_id: input.mPaymentId,
    amount,
    item_name: input.itemName.slice(0, 100),
    custom_str1: input.documentId,
    email_confirmation: "1",
    confirmation_address: input.email,
  };

  if (input.itemDescription) {
    base.item_description = input.itemDescription.slice(0, 255);
  }
  if (input.cellNumber) {
    // PayFast expects digits, often without leading +
    base.cell_number = input.cellNumber.replace(/[^\d]/g, "").replace(/^27/, "0");
  }
  if (input.nameFirst) base.name_first = input.nameFirst.slice(0, 100);
  if (input.nameLast) base.name_last = input.nameLast.slice(0, 100);

  const signature = generatePayfastSignature(base, cfg.passphrase);

  return {
    action: cfg.processUrl,
    sandbox: cfg.sandbox,
    fields: { ...base, signature } as PayfastCheckoutFields,
  };
}

/** Server-to-server validation of an ITN payload (PayFast recommend this). */
export async function validatePayfastItn(
  body: Record<string, string>,
): Promise<boolean> {
  const cfg = getPayfastConfig();
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) params.append(k, v);
  }

  try {
    const res = await fetch(cfg.validateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const text = (await res.text()).trim();
    return text === "VALID";
  } catch {
    return false;
  }
}

/** Next calendar day YYYY-MM-DD in Africa/Johannesburg. */
export function nextBusinessCollectionDate(from = new Date()): string {
  // Simple: tomorrow (calendar). Could skip Sundays later if needed.
  const d = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  // Format as local SA date
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // YYYY-MM-DD
}
