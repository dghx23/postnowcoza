// GlobeMe: US product import with landed-cost calculation & PayFast checkout.
// Reuses Bob Go courier backend; coordinates with ShoppingOrder model.

export interface LandedCostInput {
  itemPriceUsd: number;
  weightKg: number;
  shipMethod: "EXPRESS" | "STANDARD" | "ECONOMY";
  personalShopperFeeUsd: number;
  markupPercent: number;
  hsCode?: string;
  customDutyRate?: number; // if set, overrides rate lookup
  fxRateUsdZar?: number; // if not set, uses live rate
}

export interface LandedCostBreakdown {
  itemPriceUsd: number;
  shippingUsd: number;
  shopperFeeUsd: number;
  subtotalUsd: number; // item + shipping + shopper fee
  hsCode: string;
  dutyRatePercent: number;
  dutyUsd: number;
  vatPercent: number; // always 15% in SA
  vatUsd: number;
  landedCostUsd: number; // subtotal + duty + VAT
  markupPercent: number;
  markupUsd: number;
  finalQuoteUsd: number; // landed cost + markup
  fxRateUsdZar: number;
  finalQuoteZar: number;
  itemPriceCents: number;
  shippingCostCents: number;
  shopperFeeCents: number;
  dutyCents: number;
  vatCents: number;
  landedCostCents: number;
  finalQuoteCents: number;
}

const SHIP_METHODS_BASE_USD: Record<string, number> = {
  EXPRESS: 32,
  STANDARD: 22,
  ECONOMY: 14,
};

const EXTRA_WEIGHT_SURCHARGE_USD = 8; // per 0.5kg over 1kg

// Stub HS code lookup: in production, query Zonos Classify or SARS dataset.
// Returns (code, estimated duty rate %).
async function lookupHsCode(productName: string, productPrice: number): Promise<[string, number]> {
  // Placeholder: default to 20% duty (common for consumer goods into SA).
  // Real implementation: call Zonos API or internal SARS HS-code database.
  return ["8471.30.20", 0.20]; // Electronics HS code + 20% duty
}

// Calculate extra weight surcharge for weight > 1kg.
function calculateExtraWeightSurcharge(weightKg: number): number {
  if (weightKg <= 1) return 0;
  const excessKg = weightKg - 1;
  const halfKgUnits = Math.ceil(excessKg / 0.5);
  return halfKgUnits * EXTRA_WEIGHT_SURCHARGE_USD;
}

// Calculate landed cost breakdown. All USD except final ZAR conversion.
export async function calculateLandedCost(input: LandedCostInput): Promise<LandedCostBreakdown> {
  const itemPriceUsd = input.itemPriceUsd;
  const weightKg = input.weightKg;

  // Shipping cost
  const shipBaseUsd = SHIP_METHODS_BASE_USD[input.shipMethod] || SHIP_METHODS_BASE_USD.STANDARD;
  const extraWeightUsd = calculateExtraWeightSurcharge(weightKg);
  const shippingUsd = shipBaseUsd + extraWeightUsd;

  // Shopper fee (optional)
  const shopperFeeUsd = input.personalShopperFeeUsd || 0;

  // Subtotal before duty/VAT
  const subtotalUsd = itemPriceUsd + shippingUsd + shopperFeeUsd;

  // HS code & duty rate
  const [hsCode, dutyRatePercent] = input.hsCode
    ? [input.hsCode, input.customDutyRate || 0.20]
    : await lookupHsCode("", itemPriceUsd);

  // Duty is calculated on (item + insurance + freight).
  // Insurance is 0 for now (not in mockup); freight = shipping.
  const dutyableAmount = itemPriceUsd + shippingUsd;
  const dutyUsd = dutyableAmount * dutyRatePercent;

  // VAT is 15% on all costs including duty
  const vatPercent = 0.15;
  const vatableAmount = subtotalUsd + dutyUsd;
  const vatUsd = vatableAmount * vatPercent;

  // Landed cost
  const landedCostUsd = subtotalUsd + dutyUsd + vatUsd;

  // Apply markup
  const markupPercent = input.markupPercent;
  const markupUsd = landedCostUsd * (markupPercent / 100);
  const finalQuoteUsd = landedCostUsd + markupUsd;

  // FX conversion (cache the rate used so invoice is locked)
  const fxRateUsdZar = input.fxRateUsdZar || 18.5; // fallback to 18.5, real impl fetches live

  // Convert to cents for storage (avoid float precision issues)
  const breakdown: LandedCostBreakdown = {
    itemPriceUsd,
    shippingUsd,
    shopperFeeUsd,
    subtotalUsd,
    hsCode,
    dutyRatePercent,
    dutyUsd,
    vatPercent,
    vatUsd,
    landedCostUsd,
    markupPercent,
    markupUsd,
    finalQuoteUsd,
    fxRateUsdZar,
    finalQuoteZar: finalQuoteUsd * fxRateUsdZar,

    itemPriceCents: Math.round(itemPriceUsd * 100),
    shippingCostCents: Math.round(shippingUsd * 100),
    shopperFeeCents: Math.round(shopperFeeUsd * 100),
    dutyCents: Math.round(dutyUsd * 100),
    vatCents: Math.round(vatUsd * 100),
    landedCostCents: Math.round(landedCostUsd * 100),
    finalQuoteCents: Math.round(finalQuoteUsd * 100),
  };

  return breakdown;
}

// Verify PayFast webhook signature. Demo mode in development, real HMAC in production.
export function verifyPayFastWebhookSignature(
  body: Record<string, any>,
  signatureHeader: string | undefined
): boolean {
  // Demo mode in development: accept all webhook requests
  if (process.env.NODE_ENV === "development") {
    return true;
  }

  // Production: PayFast signs webhooks with MD5(concat(body_fields) + passphrase).
  // Requires PAYFAST_PASSPHRASE to be set in Vercel env.
  if (!signatureHeader || !process.env.PAYFAST_PASSPHRASE) {
    return false;
  }
  // TODO: implement real MD5 HMAC verification once PAYFAST_PASSPHRASE is set.
  return false;
}

// Check if PayFast is configured.
export function isPayFastConfigured(): boolean {
  // In development, allow demo mode without real credentials
  if (process.env.NODE_ENV === "development") {
    return true;
  }
  return !!(process.env.PAYFAST_MERCHANT_ID && process.env.PAYFAST_PASSPHRASE);
}

// Create a PayFast payment request. Demo mode in development, real integration in production.
export async function createPayFastRequest(input: {
  orderRef: string;
  amountZar: number;
  customerEmail: string;
  customerName: string;
  description: string;
}): Promise<string> {
  // Demo mode: return a mock PayFast URL for local testing
  if (process.env.NODE_ENV === "development") {
    return `/api/payfast/demo-success?orderRef=${input.orderRef}&amount=${input.amountZar}`;
  }

  if (!isPayFastConfigured()) {
    throw new Error(
      "PayFast not configured: set PAYFAST_MERCHANT_ID + PAYFAST_PASSPHRASE in Vercel env"
    );
  }

  // Production: call PayFast Hosted Payment Page API with order details.
  // Return payment URL (redirect customer to https://www.payfast.co.za/eng/process/...)
  throw new Error("PayFast integration — not yet implemented");
}
