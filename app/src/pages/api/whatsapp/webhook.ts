import type { NextApiRequest, NextApiResponse } from "next";
import { handleInboundMessage, type InboundWhatsAppMessage } from "@/lib/whatsappBookingBot";

/**
 * WhatsApp Cloud API webhook.
 *
 * GET  - Meta's one-time verification handshake when you register/change the
 *        webhook URL in the App dashboard: it calls back with hub.mode,
 *        hub.verify_token, hub.challenge and expects the raw challenge value
 *        echoed back if the token matches.
 * POST - Inbound events (messages, delivery/read statuses). Meta requires a
 *        fast 200 ack regardless of content or it will retry and eventually
 *        disable the subscription, so this acks immediately and drives the
 *        courier-booking conversation (src/lib/whatsappBookingBot.ts)
 *        fire-and-forget after logging.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(String(challenge ?? ""));
    }
    return res.status(403).json({ error: "Verification failed" });
  }

  if (req.method === "POST") {
    try {
      const entries = req.body?.entry ?? [];
      for (const entry of entries) {
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};
          for (const message of value.messages ?? []) {
            console.log("WhatsApp inbound message:", {
              from: message.from,
              type: message.type,
              text: message.text?.body,
              timestamp: message.timestamp,
            });

            const inbound: InboundWhatsAppMessage = {
              from: message.from,
              type:
                message.type === "text" ||
                message.type === "interactive" ||
                message.type === "location" ||
                message.type === "image" ||
                message.type === "video"
                  ? message.type
                  : "unknown",
              text:
                message.text?.body ??
                message.interactive?.button_reply?.title ??
                message.interactive?.list_reply?.title,
              location: message.location
                ? { latitude: message.location.latitude, longitude: message.location.longitude }
                : undefined,
            };

            // Fire-and-forget: Meta needs a fast ack, and any reply this
            // sends goes out over a separate outbound Graph API call, not
            // this response body.
            handleInboundMessage(inbound).catch((err) => {
              console.error("WhatsApp booking bot error:", err);
            });
          }
          for (const status of value.statuses ?? []) {
            console.log("WhatsApp status update:", {
              messageId: status.id,
              status: status.status,
              recipient: status.recipient_id,
            });
          }
        }
      }
    } catch (err) {
      console.error("WhatsApp webhook: failed to parse payload", err);
    }
    // Always 200 - Meta disables the subscription after repeated non-2xx acks.
    return res.status(200).json({ received: true });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
