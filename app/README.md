# postnow app backend

Deploys to `app.postnow.co.za`. Handles auth, document upload, print/dispatch
status transitions, and the chain-of-custody audit trail. The marketing site
at `postnow.co.za` (repo root) is separate and unrelated to this deploy.

## Local setup

```
cp .env.example .env.local
npm install
npx prisma migrate dev
npm run dev
```

## Data model

- `Document.status` moves through `UPLOADED -> QUEUED_FOR_PRINT -> PRINTED ->
  DISPATCHED -> IN_TRANSIT -> DELIVERED -> RETURN_REQUESTED ->
  RETURN_IN_TRANSIT -> RETURNED`. Allowed forward transitions are enforced in
  `src/pages/api/documents/[id]/status.ts`; the dispatch/return legs are
  driven by Bob Go webhooks instead (see below).
- `AuditEvent` is append-only and hash-chained (`src/lib/audit.ts`) — every
  upload, status change, and audit-log read is recorded here. Application
  code must never update or delete rows in this table.
- Uploaded files are encrypted server-side (S3 SSE) and never stored in
  Postgres — only their storage key and checksum are.

## Dispatch and returns (Bob Go)

- `src/lib/bobgo.ts` — thin client over the Bob Go v2 API (rates, shipments,
  orders, returns, waybill, POD).
- `src/lib/dispatch.ts` — `dispatchDocument()`: rates the facility-to-customer
  route, books the cheapest available service level, and moves the document
  to `DISPATCHED`. Call this once a document is `PRINTED`.
- `src/lib/returns.ts` — `initiateReturn()`: creates a Bob Go order (required
  before a return can be booked, since documents aren't e-commerce orders)
  and books the customer-to-facility leg via `/orders/return`.
- `src/pages/api/webhooks/bobgo.ts` — receives `tracking/updated` and
  `shipment_submission_status/updated` webhooks, verifies the
  `bobgo-webhook-signature` HMAC header against `BOBGO_WEBHOOK_SECRET`, and
  drives `Document.status` and `BobgoShipment` forward. Every payload is
  audit-logged verbatim before interpretation.
- On final delivery of either leg, the proof-of-delivery is fetched and
  stored (`BobgoShipment.podUrl`) as the closing audit event for that leg.

To wire this up in the Bob Go dashboard: Settings -> Webhook subscriptions ->
create a secret (put it in `BOBGO_WEBHOOK_SECRET`), then subscribe
`https://app.postnow.co.za/api/webhooks/bobgo` to `tracking/updated` and
`shipment_submission_status/updated`.

## Payments (Bob Pay)

- `src/lib/bobpay.ts` — `createPaymentLink()` (wraps `POST
  /payments/intents/link`) and `validatePayment()` (wraps `POST
  /payments/intents/validate`).
- `src/pages/api/documents/[id]/pay.ts` — creates (or returns the existing)
  payment link for a document's dispatch fee. Requires
  `Document.dispatchFee` to already be set, which happens automatically in
  `dispatchDocument()` from the courier rate at booking time.
- `src/pages/api/webhooks/bobpay.ts` — receives Bob Pay's payment
  notification. Defense in depth, all three required: (1) source IP must be
  Bob Pay's documented sandbox/production IP (`src/lib/bobpay-webhook.ts`),
  (2) the `signature` field's MD5 must match `BOBPAY_PASSPHRASE`, (3) the
  payload is re-confirmed against Bob Pay via `validatePayment()`. Also
  checks `paid_amount` against the amount we expected before marking a
  `Payment` as `PAID`.
- `BOBPAY_API_TOKEN` is a JWT from `POST /login` that expires after 30 days
  — there's no refresh flow built yet, so this needs manual (or scheduled)
  renewal.

## Printing (Epson Connect)

Rewritten directly against Epson's official OpenAPI v2 spec (see
TECH_SPEC.md section 6.3) — paths, camelCase field names, both required
auth headers, and the separate upload host are all read straight from that
spec rather than inferred, but this has never yet been run against a live
Epson account/printer. Confirm end-to-end before relying on it.

- `src/lib/epson.ts` — OAuth token exchange/refresh, `printPdf()` (creates
  the job via `POST /printing/jobs`, uploads the file to the returned
  `uploadUri` on `upload.epsonconnect.com`, then executes via
  `POST /printing/jobs/{jobId}/print`; returns the `jobId`),
  `getDeviceInfo()`, `getJobStatus(jobId)`. Every call sends both
  `Authorization: Bearer` and `x-api-key` headers — both are required.
- `src/pages/api/epson/callback.ts` — OAuth redirect target
  (`EPSON_REDIRECT_URI`). Staff/admin only. Stores `access_token`/
  `refresh_token`/device ID (`subject_id` from the token response) in
  HTTP-only cookies.
- `src/pages/api/documents/[id]/print.ts` — sends a document's PDF straight
  to the connected printer, records the returned job ID in `EpsonPrintJob`,
  and marks it `PRINTED` on success. Returns `auth_url` in a 401 if not yet
  connected; the print queue UI redirects the browser there to start the
  OAuth flow.
- `src/pages/api/epson/status.ts` — polled every 30s by the `PrinterStatus`
  component (print queue + dashboard header, staff only) to show
  online/busy/offline plus a pending-job count. Since Epson has no "list
  jobs" endpoint, pending jobs are counted by polling every `EpsonPrintJob`
  we've recorded as not yet settled. Clicking the status line opens a
  drill-down panel: printer identity, pending jobs, today's print success
  rate, a recent-jobs table sourced from our own audit trail, and a
  raw-API-response toggle.

## Quote Tool (Courier Guy)

- `src/lib/courierguy.ts` — `getRates()`, always quoting from the facility
  address (the only collection point this business dispatches from) to a
  given delivery address. Base URL (`https://api.portal.thecourierguy.co.za`)
  and Bearer-token auth are confirmed from a real Postman collection. Built
  on the same request shape as Bob Go since The Courier Guy's direct API is
  Shiplogic-based. No shipment is created, no `Document` is touched — purely
  a rate lookup, shown as a card on `/dashboard` with the same address
  autocomplete as the dispatch form.

## Address autocomplete

`src/pages/api/geocode/autocomplete.ts` proxies OpenStreetMap's free
Nominatim geocoder (no API key needed), used on the delivery address field
on `/dispatch/new` and the Quote Tool on `/dashboard`. South Africa only,
debounced 350ms client-side.

## Live courier tracking

`/tracking/[id]` polls `/api/documents/[id]/live-tracking` on mount and every
60s, which calls Bob Go's tracking endpoint directly for the document's most
recent shipment rather than relying only on cached webhook status. Shows a
"Live Courier Tracking" card with the tracking reference, live status, and a
checkpoint table (date/status/location/message) above the chain-of-custody
log.

## Feature Roadmap

`/roadmap` (staff only) — a lightweight internal tracker for planned
features (`Feature` model), unrelated to the customer-facing product or the
audit trail. Adding a feature opens a modal popup (rather than an
always-visible inline form). CRUD via `/api/features` and
`/api/features/[id]`.

## Still to build

- Data subject access/deletion endpoints (POPIA requirement).
- Rate limiting / virus scanning on upload.
- UI to launch a document's payment link and reflect `Payment.status` on
  the tracking page (the API exists, no UI yet).
- Bob Pay API token refresh automation (currently a manual 30-day rotation).
- Verify the Epson Connect integration against a real account/printer.
- Verify the Courier Guy Quote Tool against a real `COURIER_GUY_API`
  credential (auth header placement is a guess — see TECH_SPEC.md 6.4).
