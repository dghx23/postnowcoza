const GRAPH_BASE_URL = "https://graph.facebook.com/v20.0";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN ?? "";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";

interface ListRow {
  id: string;
  title: string;
  description?: string;
}

interface ListSection {
  title: string;
  rows: ListRow[];
}

async function whatsappFetch(body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${GRAPH_BASE_URL}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });

  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`WhatsApp API error ${res.status}: ${responseBody}`);
  }

  return res.json();
}

export function sendTextMessage(to: string, body: string) {
  return whatsappFetch({
    to,
    type: "text",
    text: { body },
  });
}

export function sendListMenu(
  to: string,
  header: string,
  bodyText: string,
  buttonText: string,
  sections: ListSection[]
) {
  return whatsappFetch({
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: header },
      body: { text: bodyText },
      action: {
        button: buttonText,
        sections,
      },
    },
  });
}
