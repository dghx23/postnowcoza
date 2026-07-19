/**
 * Zoho Books API v3 client (OAuth refresh-token).
 *
 * Env (Vercel):
 *   ZOHO_BOOKS_CLIENT_ID
 *   ZOHO_BOOKS_CLIENT_SECRET
 *   ZOHO_BOOKS_REFRESH_TOKEN
 *   ZOHO_BOOKS_ORGANIZATION_ID
 *   ZOHO_BOOKS_REGION          optional: com | eu | in | com.au | jp (default com)
 *   ZOHO_BOOKS_ITEM_ID         optional: inventory item for dispatch fee line
 *   ZOHO_BOOKS_APP_URL         optional deep-link base (default books.zoho.{region})
 *
 * Create a self-client at https://api-console.zoho.com with scopes:
 *   ZohoBooks.fullaccess.all  (or contacts/invoices/customerpayments write)
 * Generate refresh token once, store in Vercel.
 */

import axios from "axios";

export type ZohoRegion = "com" | "eu" | "in" | "com.au" | "jp";

function region(): ZohoRegion {
  const r = (process.env.ZOHO_BOOKS_REGION ?? "com").trim().toLowerCase();
  if (r === "eu" || r === "in" || r === "com.au" || r === "jp" || r === "com") return r;
  return "com";
}

function accountsHost(r: ZohoRegion): string {
  if (r === "eu") return "https://accounts.zoho.eu";
  if (r === "in") return "https://accounts.zoho.in";
  if (r === "com.au") return "https://accounts.zoho.com.au";
  if (r === "jp") return "https://accounts.zoho.jp";
  return "https://accounts.zoho.com";
}

function apiHost(r: ZohoRegion): string {
  if (r === "eu") return "https://www.zohoapis.eu";
  if (r === "in") return "https://www.zohoapis.in";
  if (r === "com.au") return "https://www.zohoapis.com.au";
  if (r === "jp") return "https://www.zohoapis.jp";
  return "https://www.zohoapis.com";
}

function booksAppHost(r: ZohoRegion): string {
  if (r === "eu") return "https://books.zoho.eu";
  if (r === "in") return "https://books.zoho.in";
  if (r === "com.au") return "https://books.zoho.com.au";
  if (r === "jp") return "https://books.zoho.jp";
  return "https://books.zoho.com";
}

export function zohoBooksConfigured(): boolean {
  return Boolean(
    process.env.ZOHO_BOOKS_CLIENT_ID?.trim() &&
      process.env.ZOHO_BOOKS_CLIENT_SECRET?.trim() &&
      process.env.ZOHO_BOOKS_REFRESH_TOKEN?.trim() &&
      process.env.ZOHO_BOOKS_ORGANIZATION_ID?.trim()
  );
}

export function zohoBooksOrgId(): string {
  return (process.env.ZOHO_BOOKS_ORGANIZATION_ID ?? "").trim();
}

/** Open Zoho Books in browser (org home or specific invoice). */
export function zohoBooksAppUrl(invoiceId?: string | null): string {
  const r = region();
  const custom = (process.env.ZOHO_BOOKS_APP_URL ?? "").trim().replace(/\/$/, "");
  const base = custom || `${booksAppHost(r)}/app/${zohoBooksOrgId()}`;
  if (invoiceId) return `${base}#/invoices/${invoiceId}`;
  return base;
}

export function getZohoBooksPublicConfig() {
  return {
    configured: zohoBooksConfigured(),
    organizationId: zohoBooksOrgId() || null,
    region: region(),
    appUrl: zohoBooksConfigured() ? zohoBooksAppUrl() : null,
  };
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export async function getZohoBooksAccessToken(): Promise<string> {
  if (!zohoBooksConfigured()) {
    throw new Error("Zoho Books is not configured (CLIENT_ID/SECRET/REFRESH_TOKEN/ORGANIZATION_ID)");
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const r = region();
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_BOOKS_REFRESH_TOKEN!.trim(),
    client_id: process.env.ZOHO_BOOKS_CLIENT_ID!.trim(),
    client_secret: process.env.ZOHO_BOOKS_CLIENT_SECRET!.trim(),
    grant_type: "refresh_token",
  });

  const res = await axios.post(`${accountsHost(r)}/oauth/v2/token`, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  const accessToken = res.data?.access_token as string | undefined;
  const expiresIn = Number(res.data?.expires_in ?? 3600);
  if (!accessToken) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(res.data)}`);
  }
  cachedToken = {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return accessToken;
}

async function booksRequest<T = unknown>(
  method: "GET" | "POST" | "PUT",
  path: string,
  data?: unknown
): Promise<T> {
  const token = await getZohoBooksAccessToken();
  const orgId = zohoBooksOrgId();
  const url = `${apiHost(region())}/books/v3${path}`;
  const res = await axios.request({
    method,
    url,
    params: { organization_id: orgId },
    data,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
  });
  return res.data as T;
}

export interface ZohoContact {
  contact_id: string;
  contact_name?: string;
}

export async function findOrCreateContact(input: {
  name: string;
  email?: string | null;
  phone?: string | null;
}): Promise<ZohoContact> {
  const email = (input.email ?? "").trim();
  if (email) {
    try {
      const found = await booksRequest<{ contacts?: ZohoContact[] }>(
        "GET",
        `/contacts?email=${encodeURIComponent(email)}`
      );
      if (found.contacts?.[0]?.contact_id) return found.contacts[0];
    } catch {
      /* create below */
    }
  }

  const body = {
    contact_name: input.name.trim() || email || "PostNow customer",
    contact_type: "customer",
    email: email || undefined,
    phone: input.phone?.trim() || undefined,
    billing_address: undefined as undefined,
  };

  const created = await booksRequest<{ contact: ZohoContact }>("POST", "/contacts", body);
  if (!created.contact?.contact_id) {
    throw new Error(`Zoho create contact failed: ${JSON.stringify(created)}`);
  }
  return created.contact;
}

export interface ZohoInvoice {
  invoice_id: string;
  invoice_number?: string;
  status?: string;
}

export async function createInvoice(input: {
  contactId: string;
  amount: number;
  reference: string;
  description: string;
  date?: string; // YYYY-MM-DD
}): Promise<ZohoInvoice> {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const itemId = (process.env.ZOHO_BOOKS_ITEM_ID ?? "").trim();

  const lineItem = itemId
    ? {
        item_id: itemId,
        name: "PostNow secure dispatch",
        description: input.description,
        rate: input.amount,
        quantity: 1,
      }
    : {
        name: "PostNow secure dispatch",
        description: input.description,
        rate: input.amount,
        quantity: 1,
      };

  const body = {
    customer_id: input.contactId,
    reference_number: input.reference.slice(0, 50),
    date,
    line_items: [lineItem],
    notes: "Synced from PostNow dispatch fee payment.",
  };

  const created = await booksRequest<{ invoice: ZohoInvoice }>("POST", "/invoices", body);
  if (!created.invoice?.invoice_id) {
    throw new Error(`Zoho create invoice failed: ${JSON.stringify(created)}`);
  }
  return created.invoice;
}

export async function markInvoicePaid(input: {
  invoiceId: string;
  contactId: string;
  amount: number;
  paymentMode?: string;
  reference?: string;
  date?: string;
}): Promise<{ payment_id: string }> {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  // Zoho Books: POST /customerpayments with invoices array
  const body = {
    customer_id: input.contactId,
    payment_mode: input.paymentMode || "PayFast",
    amount: input.amount,
    date,
    reference_number: (input.reference ?? "").slice(0, 50) || undefined,
    invoices: [
      {
        invoice_id: input.invoiceId,
        amount_applied: input.amount,
      },
    ],
  };

  const created = await booksRequest<{ payment: { payment_id: string } }>(
    "POST",
    "/customerpayments",
    body
  );
  if (!created.payment?.payment_id) {
    // Some orgs use different response shapes — try mark as sent/paid via invoice status
    try {
      await booksRequest("POST", `/invoices/${input.invoiceId}/status/sent`);
    } catch {
      /* ignore */
    }
    throw new Error(`Zoho record payment failed: ${JSON.stringify(created)}`);
  }
  return created.payment;
}
