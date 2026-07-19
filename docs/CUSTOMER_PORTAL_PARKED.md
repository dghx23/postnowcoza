# Customer portal — parked

The **live product** is the staff operations app (dashboard, print queue, printer hub, finance, manual job entry, payment requests, tracking).

## Reserved (do not remove)

| Route | Purpose |
|--------|---------|
| `/portal` | Parked customer portal home |
| `/portal/dispatch/new` | Customer **Create New Secure Dispatch** (self-serve) → after submit goes to classic **Pay dispatch fee** (`/pay/[id]?pay=1`) |
| `/pay/[id]` (customer / guest) | **Pay dispatch fee** — PayFast self-checkout + payment method logos. Used by portal customers and by emailed/WhatsApp payment-request tokens (`?token=`) |

## Live staff paths (do not mix)

| Route | Purpose |
|--------|---------|
| `/dispatch/new` | Staff manual job entry (same fields a customer would provide online) → **Request payment of dispatch fee** |
| `/pay/[id]` (staff, no token) | Request payment UI: **email** and/or **WhatsApp** with secure one-time pay link; optional **Pay now myself** via `?pay=1` |
| `/tracking/[id]` (staff-created) | STAFF badge; primary CTA **Arrange Dispatch Fee** (dark orange) → opens pay/request flow |
| `/finance` | Staff ledger, Zoho two-way, payment structure workspace (not customer billing) |

## Payment request channels (staff)

- **Email** — branded PostNow E2 HTML template (`src/lib/paymentRequestEmail.ts`), existing Vercel SMTP (roadmap: reconfigure to `info@postnow.co.za`)
- **WhatsApp** — same pay link; message template product-owned (operator supplies copy). Requires `WHATSAPP_*` env when sending via Cloud API

Guest opens `/pay/{id}?token=…&from=staff` without a staff session.

## When un-parking

1. Add customer nav (CUSTOMER role) pointing at `/portal`.
2. Ensure customer upload ownership / accounts match product rules.
3. Keep staff **request payment** (email/WhatsApp) separate from self-serve PayFast on the tracking page for customer-created jobs.
4. Do not route customers into `/finance` staff ledger or the ⚙ exception drawer.
