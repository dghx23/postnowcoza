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
  DISPATCHED -> IN_TRANSIT -> DELIVERED|RETURNED`. Allowed transitions are
  enforced in `src/pages/api/documents/[id]/status.ts`.
- `AuditEvent` is append-only and hash-chained (`src/lib/audit.ts`) — every
  upload, status change, and audit-log read is recorded here. Application
  code must never update or delete rows in this table.
- Uploaded files are encrypted server-side (S3 SSE) and never stored in
  Postgres — only their storage key and checksum are.

## Still to build

- Dispatch/courier API integration (webhook handler for tracking updates).
- Staff dashboard UI (print queue, dispatch queue).
- Data subject access/deletion endpoints (POPIA requirement).
- Rate limiting / virus scanning on upload.
