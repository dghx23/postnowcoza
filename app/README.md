# PostNow app (`app.postnow.co.za`)

Next.js 14 (Pages Router) product backend: staff operations, document custody, print, dispatch, payments, finance, and audit trail. Marketing site lives at the repo root (`postnow.co.za`).

Full architecture and env catalogue: **[../TECH_SPEC.md](../TECH_SPEC.md)**.  
Customer portal is parked: **[../docs/CUSTOMER_PORTAL_PARKED.md](../docs/CUSTOMER_PORTAL_PARKED.md)**.

## Local setup

```bash
cp .env.example .env.local
npm install
npx prisma migrate dev
npm run dev
```

Build (matches Vercel):

```bash
npm run build   # prisma generate && migrate deploy && seed && next build
```

Seed creates the bootstrap staff user (if `SEED_STAFF_*` set) and idempotent **roadmap** rows.

## Product surfaces (staff)

| Route | Role |
|-------|------|
| `/dashboard` | Metrics, recent jobs, quote tool, finance summary card |
| `/dispatch/new` | **Staff** manual job entry → redirect to request payment |
| `/tracking`, `/tracking/[id]` | Hub + document home (status, pay CTA, print log, courier, custody) |
| `/pay/[id]` | Staff: **request payment** (email + WhatsApp). Guest/customer: PayFast pay (`?token=` or `?pay=1`) |
| `/finance` | Full ledger, Zoho two-way, **payment structure**, **facility scans** |
| `/print-queue`, `/printer` | Queue + Epson Connect / Direct hub |
| `/roadmap` | Internal feature tracker |
| `/portal/*` | **Parked** customer self-serve (do not remove) |

Sidebar ⚙ (staff): **sync exception log** (Zoho push/pull, billing structure, scans).

## Data model (high level)

- **Document** — status pipeline, address, print prefs, `createdVia` / `staffCreatorEmail`, `dispatchFee`
- **Payment** — UNPAID→PAID… PayFast; Zoho Books ids + pull snapshot fields; optional `billingItemId`
- **BillingItem** — payment-structure rates (workspace on `/finance`)
- **SyncException** — open/resolved exception log for two-way sync
- **FacilityScan** — saved facility scans (S3) for email/archive
- **AuditEvent** — append-only hash-chained custody log
- **BobgoShipment**, **EpsonPrintJob**, **PrintSettings**, **Feature** — as in TECH_SPEC

Migrations run on deploy (`prisma/migrations/*`). Latest relevant: Zoho map, staff-created docs, two-way finance + scans.

## Payments

### PayFast (primary checkout)

- `src/lib/payfast.ts` + `/api/documents/[id]/pay` + `/api/webhooks/payfast`
- On **PAID**, ITN path can **push** the payment to Zoho Books (`syncPaymentToZohoBooks`)

### Staff payment request

- Email: branded HTML template in `src/lib/paymentRequestEmail.ts` (existing SMTP / Vercel SMTP)
- WhatsApp: same secure pay link; **message copy is product-owned** — implement only what is supplied (`src/lib/whatsapp.ts`, `request-payment` channel `whatsapp`)
- API: `POST /api/documents/[id]/request-payment` `{ channel: "email"|"whatsapp", email?|phone? }`
- Guest access: one-time `token` on `/pay/[id]?token=…&from=staff`

### Bob Pay

Legacy client + webhook remain; product checkout is PayFast. See TECH_SPEC.

## Zoho Books (two-way finance)

| Direction | Behaviour |
|-----------|-----------|
| **Push** | Contact → invoice → customer payment when PAID (or manual Sync) |
| **Pull** | `GET` invoice; store status/balance; if Books **paid** and local UNPAID → **auto-mark PAID** + audit `zoho_books_paid_inbound` |

- Client: `src/lib/zohoBooks.ts` (OAuth refresh, always sends `organization_id`)
- Orchestration: `src/lib/zohoBooksSync.ts`
- API: `GET/POST /api/finance/zoho` — `paymentId`, `allUnsynced`, `pull`+`paymentId`, `pullAll`
- UI: `/finance` — Push paid → Books, Refresh from Zoho, per-row Push/Pull, Invoice ↗
- Failures: `SyncException` + payment `zohoBooksSyncError`

**Env (Vercel):** `ZOHO_BOOKS_CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`, **`ORGANIZATION_ID`**, `REGION`, optional `ITEM_ID` / app URL. Org id docs: [Zoho Books API — organization id](https://www.zoho.com/books/api/v3/introduction/#organization-id).  
Roadmap item **Configure Zoho Books API in Vercel (two-way finance)** holds the full cutover checklist when env unlock allows.

## Payment structure & scans

- **Billing lines:** `GET/POST/PUT/DELETE /api/finance/billing-items` — codes/rates that will map into ledger rows and Zoho line items (workspace on `/finance#payment-structure`)
- **Scans:** `POST /api/finance/scans` `{ action: "save"|"email", … }` — save PDF/image to R2, email attachment, optional AES encrypt + password in email body (`src/lib/scanEmail.ts`)
- Epson Connect **native** scan pull is roadmap (upload path is live)

## Printing (Epson)

- **EPSON** — Connect OAuth + print API (`src/lib/epson.ts`), job webhooks, status/history
- **EPSON_DIRECT** — Email Print via SMTP to printer address
- Owner-notification IMAP reconcile: `src/lib/epsonNotifications.ts` + cron/status

## Dispatch & tracking

- Bob Go: `dispatch.ts` / `returns.ts` / webhooks
- Live tracking: `/api/documents/[id]/live-tracking`
- Staff-created jobs: `createdVia=STAFF`, tracking STAFF badge; pay CTA **Arrange Dispatch Fee** (dark orange) vs customer green **Pay dispatch fee**

## WhatsApp

Outbound helper: `src/lib/whatsapp.ts`, `POST /api/whatsapp/send`.  
Webhook: `/api/whatsapp/webhook`.  
**Product logic and templates are fed by the operator** — do not invent WhatsApp flows without explicit copy/rules.

## Roadmap seed / ensure

`prisma/seed.ts` and `/roadmap` ensure rows including:

- Grok Voice Agent, customer portal (parked), SMTP → `info@postnow.co.za`
- **Configure Zoho Books API in Vercel (two-way finance)** (HIGH)
- Payment structure → ledger → Zoho (HIGH / in progress)
- Epson native scan pull (MEDIUM)
- WhatsApp permanent token + prod webhook (HIGH)

## Still to build / known gaps

- Wire billing lines automatically onto every new payment + Zoho `item_id`
- POPIA data-subject export/deletion endpoints
- Upload rate limiting / virus scan
- Zoho env live smoke after Vercel unlock
- Native PDF password (current scan encrypt is AES package + password in email)
- Voice agent remains roadmap / partial (`/voice`)

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run seed` | Staff user + roadmap features |
| `npm run bobgo:rates` | Refresh static Bob Go rate card JSON (optional) |
