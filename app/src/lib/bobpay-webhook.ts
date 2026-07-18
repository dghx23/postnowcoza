import { createHash } from "crypto";

// Static source IPs documented by Bob Pay for webhook delivery.
const SANDBOX_IP = "13.246.115.225";
const PRODUCTION_IP = "13.246.100.25";

export function isKnownBobpayIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace("::ffff:", "");
  return normalized === SANDBOX_IP || normalized === PRODUCTION_IP;
}

interface BobpayWebhookPayload {
  recipient_account_code: string;
  custom_payment_id: string;
  email?: string;
  mobile_number?: string;
  amount: number;
  item_name?: string;
  item_description?: string;
  notify_url: string;
  success_url: string;
  pending_url: string;
  cancel_url: string;
  signature: string;
}

// Bob Pay's own MD5(key=value&...&passphrase=SECRET) scheme, field order
// fixed per their docs. Field order and encoding must match exactly or
// every signature will mismatch.
export function verifyBobpaySignature(payload: BobpayWebhookPayload): boolean {
  const passphrase = process.env.BOBPAY_PASSPHRASE;
  if (!passphrase) return false;

  const pairs = [
    `recipient_account_code=${encodeURIComponent(payload.recipient_account_code)}`,
    `custom_payment_id=${encodeURIComponent(payload.custom_payment_id)}`,
    `email=${encodeURIComponent(payload.email ?? "")}`,
    `mobile_number=${encodeURIComponent(payload.mobile_number ?? "")}`,
    `amount=${payload.amount.toFixed(2)}`,
    `item_name=${encodeURIComponent(payload.item_name ?? "")}`,
    `item_description=${encodeURIComponent(payload.item_description ?? "")}`,
    `notify_url=${encodeURIComponent(payload.notify_url)}`,
    `success_url=${encodeURIComponent(payload.success_url)}`,
    `pending_url=${encodeURIComponent(payload.pending_url)}`,
    `cancel_url=${encodeURIComponent(payload.cancel_url)}`,
  ];
  const signatureString = `${pairs.join("&")}&passphrase=${passphrase}`;
  const expected = createHash("md5").update(signatureString).digest("hex");

  return expected === payload.signature;
}
