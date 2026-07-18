import { createHmac, timingSafeEqual } from "crypto";

// Bob Go signs each webhook body with HMAC-SHA256 over the raw payload,
// sent in the `bobgo-webhook-signature` header. Verify against the raw
// (unparsed) request body — parsing and re-serializing first would drift
// from what was actually signed.
export function verifyBobgoSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = process.env.BOBGO_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
