const BASE_URL = process.env.BOBPAY_BASE_URL ?? "https://api.sandbox.bobpay.co.za";
const API_TOKEN = process.env.BOBPAY_API_TOKEN ?? "";

async function bobpayFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_TOKEN}`,
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bob Pay API error ${res.status} on ${path}: ${body}`);
  }

  return res.json() as Promise<T>;
}

export function createPaymentLink(input: {
  amount: number;
  email: string;
  mobile_number?: string;
  item_name: string;
  item_description?: string;
  custom_payment_id: string;
  notify_url: string;
  success_url: string;
  pending_url: string;
  cancel_url: string;
  short_url?: boolean;
}) {
  return bobpayFetch<{ url: string; short_url?: string }>("/payments/intents/link", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Confirms a webhook payload against Bob Pay's own record of the payment,
// on top of the local signature check — the signature only proves the
// payload wasn't tampered with, not that Bob Pay actually sent it.
export function validatePayment(webhookPayload: unknown) {
  return bobpayFetch<{ valid: boolean }>("/payments/intents/validate", {
    method: "POST",
    body: JSON.stringify(webhookPayload),
  });
}
