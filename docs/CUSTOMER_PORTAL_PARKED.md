# Customer portal — parked

The **live product** is the staff operations app (dashboard, print queue, printer hub, finance, manual job entry).

## Reserved (do not remove)

| Route | Purpose |
|--------|---------|
| `/portal` | Parked customer portal home |
| `/portal/dispatch/new` | Customer **Create New Secure Dispatch** (self-serve) → after submit goes to classic **Pay dispatch fee** (`/pay/[id]?pay=1`) |
| `/pay/[id]` (customer / guest) | **Pay dispatch fee** — PayFast self-checkout + payment method logos. Used by portal customers and by emailed payment-request tokens (`?token=`) |

## Live staff paths (do not mix)

| Route | Purpose |
|--------|---------|
| `/dispatch/new` | Staff manual job entry (same fields as customer) → **Request payment of dispatch fee** (email payer) |
| `/pay/[id]` (staff, no token) | Request payment email UI; optional “Pay now myself” via `?pay=1` |

## When un-parking

1. Add customer nav (CUSTOMER role) pointing at `/portal`.
2. Ensure customer upload ownership / accounts match product rules.
3. Keep staff payment-request email flow separate from self-serve PayFast.
