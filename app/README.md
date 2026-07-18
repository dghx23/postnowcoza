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

## Still to build

- Staff dashboard UI (print queue, dispatch queue, exception handling for
  `collection-exception`/`delivery-exception`/`failed-*` tracking statuses).
- Data subject access/deletion endpoints (POPIA requirement).
- Rate limiting / virus scanning on upload.
- Endpoint to trigger a return from the customer-facing UI (the API route
  exists at `POST /api/documents/[id]/return`, no UI yet).
