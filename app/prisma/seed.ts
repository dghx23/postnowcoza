import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Creates the first staff account so someone can actually log into the
// facility dashboard - there's no signup flow yet, this is the bootstrap.
// Set SEED_STAFF_EMAIL/SEED_STAFF_PASSWORD before running; skips silently
// if unset so this is safe to leave in the default build pipeline.
async function main() {
  const email = process.env.SEED_STAFF_EMAIL;
  const password = process.env.SEED_STAFF_PASSWORD;
  if (!email || !password) {
    console.log("SEED_STAFF_EMAIL/SEED_STAFF_PASSWORD not set, skipping seed.");
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash, role: "STAFF" },
  });
  console.log(`Staff user ready: ${user.email}`);

  const epsonDirectEmail = "postnow@print.epsonconnect.com";
  await prisma.printSettings.upsert({
    where: { id: "singleton" },
    update: { epsonDirectEmail },
    create: { id: "singleton", provider: "EPSON_DIRECT", epsonDirectEmail },
  });
  console.log(`Epson Direct email ready: ${epsonDirectEmail}`);

  // Staff roadmap tracker items — idempotent so every deploy keeps them present
  // without duplicating rows if someone already added them by hand.
  const roadmapItems: Array<{
    name: string;
    priority: "HIGH" | "MEDIUM" | "LOW";
    status: "NOT_STARTED" | "IN_PROGRESS" | "READY" | "IMPLEMENTED";
    comment: string;
  }> = [
    {
      name: "Grok Voice Agent",
      priority: "HIGH",
      status: "IN_PROGRESS",
      comment:
        "In-app voice assistant on /voice (xAI Grok Realtime). Read-only tools first: list documents, get status, live courier tracking, audit summary. Ephemeral client secrets keep XAI_API_KEY server-side. Next: customer actions (pay/return), staff ops tools, public marketing FAQ agent.",
    },
    {
      name: "Courier label maker (print-queue preview)",
      priority: "MEDIUM",
      status: "NOT_STARTED",
      comment:
        "Parked from Print Queue UI: shipping-label mock (PostNow / SECURE DISPATCH / deliver-to / tracking barcode) plus Instant Print flow diagram (PDF → Epson → PRINTED → history). Reintroduce when we generate real courier labels (Bob Go waybill) not just document PDF print.",
    },
    {
      name: "Customer portal (self-serve dispatch + pay)",
      priority: "HIGH",
      status: "NOT_STARTED",
      comment:
        "PARKED. Live app is staff ops. Reserved: /portal hub, /portal/dispatch/new (customer new dispatch → classic Pay dispatch fee self-serve), and /pay/[id] customer/guest mode (not staff request-payment email). Wire sidebar + auth for CUSTOMER when ready; staff keeps /dispatch/new → request payment by email.",
    },
    {
      name: "Reconfigure SMTP to info@postnow.co.za",
      priority: "MEDIUM",
      status: "NOT_STARTED",
      comment:
        "Payment-request emails currently use the existing Vercel SMTP (Zoho_PrintAgent_User / SMTP_*). Switch From + auth to info@postnow.co.za (or dedicated transactional mailbox), update SMTP_FROM_EMAIL / SMTP_USER / SMTP_PASSWORD (or Zoho app password) in Vercel, verify SPF/DKIM, and smoke-test staff “Send payment request email”. Keep branded HTML template unchanged.",
    },
    {
      name: "WhatsApp: put permanent token in Vercel + switch webhook to prod",
      priority: "HIGH",
      status: "NOT_STARTED",
      comment:
        "REMINDER (~24h after local Meta setup): (1) Paste the permanent WHATSAPP_ACCESS_TOKEN into Vercel env (also WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_WABA_ID, WHATSAPP_API_VERSION, WHATSAPP_VERIFY_TOKEN). (2) Redeploy. (3) In Meta → WhatsApp webhooks, change Callback URL from the local Cloudflare/ngrok tunnel to production https://app.postnow.co.za/api/whatsapp/webhook (same verify token). (4) Re-verify + subscribe messages/calls. (5) Smoke-test send + inbound webhook on prod.",
    },
    {
      name: "Configure Zoho Books API in Vercel (two-way finance)",
      priority: "HIGH",
      status: "NOT_STARTED",
      comment:
        "BLOCKED ~24h (cannot save Vercel env yet). After unlock, set on the PostNow app project: ZOHO_BOOKS_CLIENT_ID, ZOHO_BOOKS_CLIENT_SECRET, ZOHO_BOOKS_REFRESH_TOKEN, ZOHO_BOOKS_ORGANIZATION_ID (from Books → Settings → Organization Profile; required on every API call as organization_id), ZOHO_BOOKS_REGION (com|eu|in|com.au|jp — match your DC), optional ZOHO_BOOKS_ITEM_ID (default inventory item for dispatch fee line), optional ZOHO_BOOKS_APP_URL / NEXT_PUBLIC_ZOHO_BOOKS_URL. OAuth: api-console.zoho.com self-client scopes ZohoBooks.fullaccess.all (or contacts + invoices + customerpayments read/write). Generate refresh token once. Then smoke-test /finance: Push paid → Books, Refresh from Zoho (pull status; paid in Books auto-marks PostNow PAID), exception log under ⚙ next to user label. Docs: https://www.zoho.com/books/api/v3/introduction/#organization-id",
    },
    {
      name: "Payment structure → ledger entries → Zoho line items",
      priority: "HIGH",
      status: "IN_PROGRESS",
      comment:
        "Workspace on /finance#payment-structure (BillingItem codes/rates). Next: auto-apply active DISPATCH (or selected) line to new payments, map zohoItemId into createInvoice line items, surface billing line on every ledger row. Keep SyncException for structure/Zoho mismatches.",
    },
    {
      name: "Epson Connect native scan pull (facility scans)",
      priority: "MEDIUM",
      status: "NOT_STARTED",
      comment:
        "/finance#facility-scans currently saves staff-uploaded PDFs/images (Epson Connect file or local), email with PDF attach, optional AES encrypt + password in email. Next: pull scans directly from Epson Connect Scan API when available; native PDF password encryption if needed.",
    },
  ];

  for (const item of roadmapItems) {
    const existing = await prisma.feature.findFirst({ where: { name: item.name } });
    if (!existing) {
      await prisma.feature.create({
        data: {
          name: item.name,
          priority: item.priority,
          status: item.status,
          comment: item.comment,
          createdBy: "seed",
        },
      });
      console.log(`Roadmap feature ready: ${item.name}`);
    } else {
      console.log(`Roadmap feature already present: ${item.name}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
