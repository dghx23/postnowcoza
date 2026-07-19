import type { NextApiRequest, NextApiResponse } from "next";
import { sendWhatsAppText, isWhatsAppConfigured } from "@/lib/whatsapp";

/**
 * POST /api/whatsapp/send
 * Body: { to: string, message: string }
 * Sends a WhatsApp Cloud API text message via Meta Graph API.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { to, message } = req.body ?? {};

    if (!to || !message) {
      return res.status(400).json({ error: "Missing 'to' or 'message'" });
    }

    if (!isWhatsAppConfigured()) {
      return res.status(503).json({
        error:
          "WhatsApp is not configured (set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env.local)",
      });
    }

    const result = await sendWhatsAppText({ to: String(to), message: String(message) });
    return res.status(200).json({ success: true, data: result.raw, messageId: result.messageId });
  } catch (error) {
    console.error("WhatsApp send error:", error);
    return res.status(500).json({ error: (error as Error).message || "Internal server error" });
  }
}
