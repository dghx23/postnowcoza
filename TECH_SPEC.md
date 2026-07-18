# PostNow — Technical Specification

Status snapshot as of this document's writing. Covers architecture, data model,
third-party integrations, infrastructure, and what's outstanding.

## 1. Product summary

PostNow ("PostNow E2") is a POPIA-first secure physical document dispatch
service. A customer uploads a document that needs a wet-ink signature; PostNow
prints it, dispatches it by courier, gets it signed, and — if required —
returns it, with an immutable chain-of-custody audit trail at every step.

## 2. Domains & hosting split

| Domain | Purpose | Hosting |
|---|---|---|
| `postnow.co.za` / `www.postnow.co.za` | Public marketing site | GitHub Pages (repo root, branch `main`) |
| `app.postnow.co.za` | The actual E2 product (login, dispatch, tracking) | Vercel (Next.js app in `/app`) |

DNS is managed at GoDaddy. Records in place:
- `A` x4 → GitHub Pages IPs (185.199.108-111.153) — apex domain
- `CNAME www` → `dghx23.github.io.`
- `CNAME app` → `403674f131a44b1b.vercel-dns-017.com.` (Vercel's assigned target)

No CAA record is present (so no certificate-authority restriction). As of
writing, `app.postnow.co.za`'s DNS is correctly configured but SSL certificate
issuance on Vercel's side was intermittently failing ("Failed to Load Cert") —
DNS itself was verified correct; this needs a retry/recheck on the Vercel
Domains page.

## 3. Repository layout

Single repo `dghx23/postnowcoza`, two independent deployables:

```
/                     -> marketing site (static HTML/CSS, GitHub Pages)
  index.html
  styles.css
  CNAME                -> "postnow.co.za" (GitHub Pages custom domain)
  assets/               -> marketing site images
  .nojekyll             -> disables Jekyll processing so /app isn't touched

/app                  -> the E2 product (Next.js 14, Pages Router), Vercel
  src/pages/            -> routes (see section 5)
  src/lib/              -> integrations & business logic (see section 6)
  src/components/ui.tsx -> shared design-system components
  src/styles/globals.css-> design tokens + component styles
  prisma/               -> schema + migrations + seed script
  public/assets/        -> images used inside the app (facility photo etc.)
```

Branch model: development happened on `claude/godaddy-integration-b0thvc`,
which has been fast-forward-merged into `main`. Both GitHub Pages and Vercel
track `main`.

## 4. Data model (Prisma / Postgres)

```
User
  id, email, passwordHash, role (CUSTOMER|STAFF|ADMIN), consentedAt, createdAt

Document
  id, ownerId -> User
  status: UPLOADED -> QUEUED_FOR_PRINT -> PRINTED -> DISPATCHED -> IN_TRANSIT
          -> DELIVERED -> RETURN_REQUESTED -> RETURN_IN_TRANSIT -> RETURNED
  storageKey, checksum, encryptionKeyRef   (file itself lives in S3/R2, never in Postgres)
  recipientName/Phone/Email, streetAddress, localArea, city, zone, postalCode, country
  dispatchFee (Float?)   -- set from the Bob Go courier rate at booking time

AuditEvent   (append-only, hash-chained chain-of-custody log)
  id, documentId, actorId?, action, metadata (Json), ip, prevHash, hash, createdAt
  -- every insert's hash = sha256(documentId+actorId+action+metadata+prevHash)
  -- application code never updates or deletes rows in this table

BobgoShipment   (one row per courier leg — outbound dispatch, or a return)
  id, documentId, direction (OUTBOUND|RETURN), bobgoOrderId?, providerSlug,
  serviceLevelCode, trackingReference (unique), submissionStatus, trackingStatus,
  failedReason, waybillUrl, podUrl, rawPayload (Json)

Payment   (Bob Pay payment intent for a document's dispatch fee)
  id, documentId, customPaymentId (unique), bobpayUuid?, amount,
  status (UNPAID|PAID|FAILED|CANCELLED|REFUNDED), paymentMethod, paymentUrl, rawPayload
```

Migration: a single hand-generated initial migration
(`prisma/migrations/20260101000000_init/migration.sql`, produced via
`prisma migrate diff --from-empty` without needing a live DB connection).
`npm run build` runs `prisma generate && prisma migrate deploy && npm run seed
&& next build` — migrations and seeding both happen automatically on every
production build.

## 5. App routes

| Route | Purpose | Auth |
|---|---|---|
| `/login` | NextAuth credentials sign-in | public |
| `/dashboard` | Live metrics (active dispatches, in-transit, delivered, exceptions) + recent documents table | session required |
| `/dispatch/new` | Upload form: file + recipient/address fields | session required |
| `/tracking/[id]` | Real status timeline + chain-of-custody log + compliance badges for one document | session required, owner or staff |
| `/api/documents/upload` | POST — encrypts & stores file to S3/R2, creates `Document`, first `uploaded` audit event | session required |
| `/api/documents/[id]/status` | PATCH — staff-only manual status transitions (`UPLOADED→QUEUED_FOR_PRINT` etc.) | STAFF/ADMIN |
| `/api/documents/[id]/dispatch` | POST — books the outbound Bob Go shipment (see 6.1) | STAFF/ADMIN |
| `/api/documents/[id]/return` | POST — books the Bob Go managed return (see 6.1) | owner or STAFF/ADMIN |
| `/api/documents/[id]/pay` | POST — creates/returns a Bob Pay payment link for the dispatch fee | owner or STAFF/ADMIN |
| `/api/audit/[documentId]` | GET — full audit log for a document | owner or staff |
| `/api/webhooks/bobgo` | POST — Bob Go tracking/submission-status webhook receiver | HMAC-verified, no session |
| `/api/webhooks/bobpay` | POST — Bob Pay payment notification receiver | IP + signature verified, no session |
| `/api/auth/[...nextauth]` | NextAuth handler | — |

## 6. Third-party integrations

### 6.1 Bob Go (courier — dispatch & managed returns)

- `src/lib/bobgo.ts` — client for `/rates`, `/shipments`, `/orders`,
  `/orders/return`, `/shipments/waybill`, `/shipments/pod`,
  `/shipments/cancel`.
- `src/lib/dispatch.ts` — `dispatchDocument()`: rates the facility→customer
  route, books the cheapest available service level, sets `dispatchFee` from
  the rate, moves `Document.status` to `DISPATCHED`.
- `src/lib/returns.ts` — `initiateReturn()`: creates a Bob Go **order** first
  (required — `/orders/return` is a fulfillment on an order, and documents
  aren't e-commerce orders so one never otherwise exists), then rates and
  books the customer→facility return leg.
- `src/pages/api/webhooks/bobgo.ts` — verifies the `bobgo-webhook-signature`
  HMAC-SHA256 header against `BOBGO_WEBHOOK_SECRET`; on `tracking/updated`
  drives `Document.status` forward (in-transit/delivered/exception mapping)
  and fetches POD on delivery; on `shipment_submission_status/updated`
  updates `BobgoShipment.submissionStatus` and fetches the waybill on first
  success. Every payload is audit-logged verbatim before interpretation.
- **Known gap**: `BOBGO_API_TOKEN` could not be obtained — the account's "API
  keys" section in the Bob Go dashboard appeared inaccessible (suspected
  plan-gating), deferred. Webhook secret was generated and is set.

### 6.2 Bob Pay (payments — dispatch fee)

- `src/lib/bobpay.ts` — `createPaymentLink()` (`POST
  /payments/intents/link`), `validatePayment()` (`POST
  /payments/intents/validate`).
- `src/pages/api/documents/[id]/pay.ts` — creates a payment link for
  `Document.dispatchFee`, idempotent (returns the existing link if one's
  already unpaid/paid).
- `src/pages/api/webhooks/bobpay.ts` — three-layer verification before
  trusting a notification: (1) source IP must match Bob Pay's documented
  sandbox/production IPs, (2) the payload's `signature` field (MD5 over a
  fixed field order + account passphrase) must match, (3) the payload is
  re-confirmed via `validatePayment()`. Amount is cross-checked against the
  expected `Payment.amount` before marking paid.
- **Known gaps**: `BOBPAY_API_TOKEN` (requires one manual `POST /login` call
  with sandbox credentials — not yet made) and `BOBPAY_PASSPHRASE` (couldn't
  be located in the account UI) are both still unset. Payment link
  creation/webhook verification will fail until these are in.

### 6.3 Storage & auth

- **Postgres**: Neon (EU West London region). Note: the original connection
  string was accidentally pasted into a chat session and was rotated
  immediately as a precaution before being placed in Vercel.
- **Object storage**: Cloudflare R2, bucket `postnow-documents`, S3-compatible
  API (`src/lib/storage.ts` uses `@aws-sdk/client-s3`). Access scoped via an
  Object Read & Write token.
- **Auth**: NextAuth credentials provider, bcrypt password hashing, JWT
  session strategy. First login is bootstrapped via
  `prisma/seed.ts` using `SEED_STAFF_EMAIL` / `SEED_STAFF_PASSWORD` — there is
  no signup flow.

## 7. Environment variables

Full reference: `app/.env.example`. Categories: `DATABASE_URL`,
`NEXTAUTH_SECRET`/`NEXTAUTH_URL`, `S3_*` (5), `BOBGO_*` (3),
`FACILITY_*` (8, the print facility's address/contact — used as the
collection address for outbound and delivery address for returns),
`BOBPAY_*` (3), `SEED_STAFF_EMAIL`/`SEED_STAFF_PASSWORD`.

**Operational lesson learned during setup**: Vercel's bulk `.env`-paste
feature creates a row for every key even when no value is supplied. Twice
during setup, a variable showed as "Added" in the Vercel UI but actually held
an empty string, causing confusing runtime failures (`DATABASE_URL` empty →
Prisma validation error at build time; `NEXTAUTH_SECRET` empty → NextAuth
`NO_SECRET` runtime error on every auth request). If anything behaves as if
an env var isn't set despite showing as present, check the actual value isn't
blank before assuming a code bug.

## 8. Deployment pipeline

- Push to `main` → GitHub Pages rebuilds the marketing site; Vercel rebuilds
  the app (Root Directory = `app`, Framework = Next.js).
- Vercel build command: `prisma generate && prisma migrate deploy && npm run
  seed && next build` — schema migrations and the staff-user seed both run
  automatically on every deploy, no manual step required.
- No CI/test suite wired up yet — verification so far has been `tsc --noEmit`
  locally plus manual testing via the deployed Vercel preview.

## 9. Verified working (as of writing)

- Marketing site live at `postnow.co.za`.
- App deployed on Vercel, reachable at `postnowcoza.vercel.app`.
- Login, session handling, and the dashboard all confirmed working against
  the real Neon database (dashboard correctly showed zeroed real metrics, not
  prototype placeholder data).
- Custom domain `app.postnow.co.za` DNS correctly configured; SSL certificate
  issuance pending/retrying at time of writing.

## 10. Outstanding work

1. **Bob Go API token** — blocked on account access; may need Bob Go support
   to unlock, or a plan upgrade.
2. **Bob Pay API token & passphrase** — need the manual login API call and to
   locate the passphrase in account settings.
3. **`app.postnow.co.za` SSL** — recheck/retry certificate issuance on Vercel.
4. **End-to-end test of a real document** — upload → dispatch → payment →
   tracking has not yet been exercised against live Bob Go/Bob Pay sandbox
   APIs (blocked on items 1–2).
5. **Staff dashboard for the print queue** — moving a document from
   `UPLOADED` → `PRINTED` is currently API-only (`PATCH
   /api/documents/[id]/status`), no UI.
6. **POPIA data subject rights** — export/deletion endpoints not built.
7. **Upload hardening** — no virus scanning or rate limiting yet.
8. **Payment UI** — the `/pay` endpoint exists but there's no button on the
   tracking page to trigger it yet.
9. **Bob Pay token refresh** — the JWT expires after 30 days; no automated
   renewal exists.
