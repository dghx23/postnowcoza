import type { NextApiRequest, NextApiResponse } from "next";
import {
  applyConnectJobNotification,
  parseConnectWebhookBody,
  verifyWebhookKey,
} from "@/lib/epsonJobWebhook";

/**
 * Epson Connect job-status callback.
 * Register via POST /api/epson/notifications/configure (or Printer Hub).
 * Default URL: https://app.postnow.co.za/api/epson/webhooks/job?key=<EPSON_WEBHOOK_SECRET>
 *
 * No session auth — Epson's cloud POSTs here. Optional ?key= shared secret.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    // Handy health check when configuring the callback in Epson console / our UI.
    return res.status(200).json({
      ok: true,
      service: "epson-connect-job-webhook",
      hint: "Epson POSTs job status JSON here after you enable notifications.",
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!verifyWebhookKey(req.query.key)) {
    console.warn("Epson webhook: rejected bad or missing key");
    return res.status(401).json({ error: "Unauthorized" });
  }

  let body: unknown = req.body;
  // Some gateways send a raw string
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* keep string */
    }
  }

  const parsed = parseConnectWebhookBody(body);
  if (!parsed) {
    console.warn("Epson webhook: unparseable body", {
      keys: body && typeof body === "object" ? Object.keys(body as object) : typeof body,
    });
    // 200 so Epson doesn't retry forever on unexpected shapes we can't map.
    return res.status(200).json({ ok: false, reason: "unparseable" });
  }

  try {
    const result = await applyConnectJobNotification(parsed);
    console.info("Epson webhook applied", {
      jobId: parsed.jobId,
      status: parsed.status,
      applied: result.applied,
      reason: result.reason,
      documentId: result.documentId,
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("Epson webhook handler failed", {
      message: (err as Error).message,
      jobId: parsed.jobId,
      status: parsed.status,
    });
    // 500 lets Epson retry transient DB issues
    return res.status(500).json({ error: "Failed to apply job notification" });
  }
}
