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

No CAA record is present (so no certificate-authority restriction).
`app.postnow.co.za`'s DNS and SSL certificate are both confirmed working in
production (an earlier intermittent "Failed to Load Cert" issue on Vercel's
side has since resolved on its own).

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
  returnPreference: DIRECT | MANAGED   -- Option A/B from the return pathway, default MANAGED
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

Feature   (internal staff roadmap tracker - unrelated to the product/audit trail)
  id, name, priority (HIGH|MEDIUM|LOW), status (NOT_STARTED|IN_PROGRESS|READY|IMPLEMENTED),
  comment?, checked, createdBy, createdAt, updatedAt

EpsonPrintJob   (tracks Epson job IDs we create, since Epson has no "list jobs" endpoint)
  id, documentId -> Document, jobId (unique, Epson's own job ID), status, createdAt, updatedAt

PrintSettings   (singleton row, id fixed to "singleton" - which printing backend is active)
  id, provider (EPSON|EPSON_DIRECT), epsonDirectEmail?, updatedAt
```

Migrations are hand-generated via `prisma migrate diff` (schema-to-schema,
no live DB connection needed) rather than `migrate dev`, since there's no
local database in this environment:
- `20260101000000_init` — initial schema
- `20260102000000_return_preference` — adds `Document.returnPreference`
- `20260103000000_add_feature_tracker` — adds the `Feature` model
- `20260104000000_epson_print_jobs` — adds the `EpsonPrintJob` model
- `20260105000000_linux_print_agent` — adds `PrintSettings` and `LinuxPrintJob`
  (superseded by the next migration below — the Linux Print Agent feature
  was replaced with Epson Direct almost immediately after being built)
- `20260106000000_epson_direct_email_print` — renames `PrintProvider`'s
  `LINUX_AGENT` value to `EPSON_DIRECT`, drops `LinuxPrintJob`, adds
  `PrintSettings.epsonDirectEmail`

`npm run build` runs `prisma generate && prisma migrate deploy && npm run seed
&& next build` — migrations and seeding both happen automatically on every
production build.

## 5. App routes

| Route | Purpose | Auth |
|---|---|---|
| `/login` | NextAuth credentials sign-in | public |
| `/dashboard` | Live metrics (active dispatches, in-transit, delivered, exceptions) + recent documents table + staff Quote Tool (see 6.4) | session required |
| `/dispatch/new` | Upload form: file + recipient/address fields (with address autocomplete, see 6.5) + return preference (Direct/Fully Managed) | session required |
| `/roadmap` | Internal feature/task tracker for staff — not customer-facing, not part of the audit trail | STAFF/ADMIN |
| `/tracking/[id]` | Status timeline + live courier tracking card (polled, see 6.3.1) + chain-of-custody log + compliance badges for one document | session required, owner or staff |
| `/print-queue` | Staff print queue: search/filter/sort, documents in `UPLOADED`/`QUEUED_FOR_PRINT`, download original file, mark as printed, one-click print via Epson Connect, live printer status with drill-down; each row links through to `/tracking/[id]` | STAFF/ADMIN |
| `/printer` | Full printer details page: identity, default print settings, complete capability matrix, notification config, raw response (see 6.3.2) | STAFF/ADMIN |
| `/api/documents/upload` | POST — encrypts & stores file to S3/R2, creates `Document`, first `uploaded` audit event | session required |
| `/api/documents/[id]/status` | PATCH — staff-only manual status transitions (`UPLOADED→QUEUED_FOR_PRINT`, `UPLOADED→PRINTED`, `QUEUED_FOR_PRINT→PRINTED`, etc.) | STAFF/ADMIN |
| `/api/documents/[id]/download` | GET — presigned R2 download URL for the original file, audit-logs the download | owner or staff |
| `/api/documents/[id]/print` | POST — sends the document's PDF to the connected Epson printer, marks `PRINTED` on success (see 6.3) | STAFF/ADMIN |
| `/api/epson/callback` | GET — Epson OAuth redirect target, exchanges code for tokens, stores in HTTP-only cookies | STAFF/ADMIN |
| `/api/epson/status` | GET — polled printer status (online/busy/offline + pending job count) | STAFF/ADMIN |
| `/api/documents/[id]/dispatch` | POST — books the outbound Bob Go shipment (see 6.1) | STAFF/ADMIN |
| `/api/documents/[id]/return` | POST — books the Bob Go managed return (see 6.1) | owner or STAFF/ADMIN |
| `/api/documents/[id]/pay` | POST — creates/returns a Bob Pay payment link for the dispatch fee | owner or STAFF/ADMIN |
| `/api/audit/[documentId]` | GET — full audit log for a document | owner or staff |
| `/api/webhooks/bobgo` | POST — Bob Go tracking/submission-status webhook receiver | HMAC-verified, no session |
| `/api/webhooks/bobpay` | POST — Bob Pay payment notification receiver | IP + signature verified, no session |
| `/api/auth/[...nextauth]` | NextAuth handler | — |
| `/api/quote` | POST — Courier Guy rate lookup from the facility to a given address, dashboard-only tool, doesn't touch any `Document` (see 6.4) | STAFF/ADMIN |
| `/api/geocode/autocomplete` | GET — proxies OpenStreetMap Nominatim for address suggestions on the dispatch form (see 6.5) | session required |
| `/api/features` | GET/POST — list/create roadmap items (add is via a modal popup on `/roadmap`) | STAFF/ADMIN |
| `/api/features/[id]` | PATCH/DELETE — update or remove a roadmap item | STAFF/ADMIN |
| `/api/documents/[id]/live-tracking` | GET — live Bob Go tracking status/checkpoints for a document's most recent shipment (see 6.3.1) | owner or STAFF/ADMIN |
| `/api/epson/details` | GET — device info + default settings + full capability matrix + notification settings in one call, powers `/printer` (see 6.3.2) | STAFF/ADMIN |
| `/api/print-settings` | GET/PATCH — current printing backend (Epson Connect or Epson Direct) plus the configured Epson Direct email address, powers the toggle on `/printer` (see 6.3.3) | STAFF/ADMIN |
| `/api/epson/notifications/sync` | GET/POST — IMAP-pull Epson owner-notification emails from the Zoho print-agent mailbox and reconcile `EpsonPrintJob` + audit trail (see 6.3.4) | STAFF/ADMIN or `CRON_SECRET` |
| `/voice` | In-app Grok Voice Agent UI (mic session + transcript) — read-only status/tracking (see 6.7) | session required |
| `/api/voice/session` | POST — mints a short-lived xAI ephemeral client secret for the browser WebSocket | session required |
| `/api/voice/tools/list-documents` | GET/POST — recent documents the caller may see | session required |
| `/api/voice/tools/get-document` | GET/POST — status + delivery summary (no PDF bytes / storage keys) | owner or staff |
| `/api/voice/tools/live-tracking` | GET/POST — live Bob Go checkpoints for a document's latest shipment | owner or staff |
| `/api/voice/tools/audit-summary` | GET/POST — chain-of-custody summary for voice narration | owner or staff |

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

### 6.3 Epson Connect (printing)

Initially built from two conflicting provided specs (pure guesswork), then
"corrected" via web search (which turned out to still be wrong in several
places), then finally corrected for real against Epson's **official OpenAPI
v2 spec** (user-supplied document, 2026-07-18) — this is the first version
of this integration built from a primary source rather than search-engine
inference, and every path/field/header below is read directly from that
spec rather than reconstructed by analogy.

**Confirmed facts (from the official spec):**
- OAuth: `GET {AUTH_BASE}/auth/authorize?response_type=code&client_id=...&redirect_uri=...&scope=device`,
  token exchange/refresh at `POST {AUTH_BASE}/auth/token`. The device ID
  comes from `subject_id` on the token response, not a separate lookup.
- Every `printing/*` call requires **both** `Authorization: Bearer <device
  token>` **and** `x-api-key: <key>` headers together — confirmed from the
  spec's own code samples. An earlier version treated `x-api-key` as
  optional; it is not.
- **No device ID appears in any path.** The device token itself is already
  scoped to exactly one printer, so `printing/devices/info`,
  `printing/jobs`, and `printing/jobs/{jobId}` are all unqualified — the
  previously "verified via web search" `printing/printers/{deviceId}/...`
  path prefix does not exist in the real API.
- Job creation: `POST /printing/jobs` with a **camelCase** body — `jobName`,
  `printMode` (`document`/`photo`), `printSettings` (`paperSize` e.g.
  `ps_a4`, `paperType` e.g. `pt_plainpaper`, `borderless`, `printQuality`,
  `paperSource`, `colorMode`, plus optional `doubleSided`/`copies`/etc.) —
  not the snake_case `print_setting`/`media_size` shape used previously.
  Response: `{ jobId, uploadUri }`.
- File upload happens on a **separate host**, `upload.epsonconnect.com`:
  `POST {uploadUri}&File=1.pdf` (the returned `uploadUri` already carries a
  `Key` query param; `File` naming the extension must be appended), body is
  the raw file bytes with a matching `Content-Type` (e.g. `application/pdf`).
- Execute: `POST /printing/jobs/{jobId}/print`, no body.
- **There is no "list all jobs" endpoint** — only `GET /printing/jobs/{jobId}`
  (single job by ID) exists. The previous `getJobs()` called an endpoint
  that doesn't exist in the real API. Pending-job tracking is now done by
  recording every job ID we create in a new `EpsonPrintJob` table
  (`documentId`, `jobId`, `status`) and polling each individually
  (`src/pages/api/epson/status.ts`'s `pollPendingJobs()`) — jobs expire on
  Epson's side after 3 days regardless, so this list is self-bounding.
- API v1 (`/api/1/`) was discontinued 2026-04-01; v2 (`/api/2/`) is current
  and is what's implemented.

- `src/lib/epson.ts` — OAuth authorize URL, token exchange/refresh,
  `printPdf()` (create → upload → print, returns the `jobId`),
  `getDeviceInfo()`, `getJobStatus(jobId)`.
- `src/pages/api/epson/callback.ts` — OAuth redirect target
  (`EPSON_REDIRECT_URI`), stores access/refresh tokens and the device ID
  (from `subject_id`) in HTTP-only cookies. Staff/admin only, checked via
  `getSessionUser` — the same pattern as every other API route, not
  `getServerSession` + `session.user.role` directly, which the originally
  supplied specs used but which doesn't work here: this app's NextAuth config
  has no `jwt`/`session` callback copying `role` onto the session object, so
  `session.user.role` is always `undefined` at runtime.
- `src/pages/api/documents/[id]/print.ts` — validates the document is in a
  printable status, downloads the PDF from R2, sends it to Epson, retries
  once via refresh token on a 401, records the returned `jobId` in
  `EpsonPrintJob`, then updates `Document.status` to `PRINTED` and appends an
  audit event through the existing `appendAuditEvent()` hash-chain helper (an
  originally supplied spec instead wrote a raw `prisma.auditEvent.create`
  with a literal `hash: 'pending'` string, which would have broken the
  tamper-evident audit chain that's the whole point of this table — not
  used). Print failures also append an `epson_print_failed` audit event so
  the printer drill-down (below) has real failure history to show.
- `src/pages/api/epson/status.ts` + `PrinterStatus` component
  (`src/components/ui.tsx`) — polls printer online/busy/offline + pending
  job count every 30s. Clicking the status line opens a drill-down panel
  (printer identity/serial/status, pending-jobs count, today's print
  success rate, a recent-print-jobs table sourced from our own audit trail,
  and a raw-API-response toggle for debugging) — shown on the print queue
  and dashboard headers, staff only.

### 6.3.1 Live courier tracking on the tracking page

- `src/lib/bobgo.ts`'s `getTrackingEvents(trackingReference)` calls Bob Go's
  `GET /tracking?tracking_reference=...` at view time (not just relying on
  webhook-delivered status cached on `BobgoShipment`, which can lag or be
  missed).
- `src/pages/api/documents/[id]/live-tracking.ts` — session-gated (owner or
  staff), looks up the most recent `BobgoShipment` for the document and
  returns its live status + checkpoint events, or 404 if no shipment has
  been booked yet.
- `src/pages/tracking/[id].tsx` — polls this endpoint on mount and every 60s,
  rendering a "Live Courier Tracking" card (reference, live status, a
  Date/Status/Location/Message table of checkpoints) above the existing
  chain-of-custody log, distinct loading/not-booked/error states.
- Post-upload experience: `dispatch/new.tsx` redirects to
  `/tracking/[id]?submitted=1` on success; the tracking page shows a
  dismissable "✅ Document received securely" banner on that first visit
  (the query param is stripped via shallow routing, same pattern as the
  print queue's Epson-connected banner), a "🔗 Copy tracking link" button,
  and a new "Dispatch Summary" card (delivery address, contact info, return
  preference, submitted time) so the customer can verify what was actually
  submitted. Raw `AuditEvent.action` strings (e.g.
  `status_changed:UPLOADED->PRINTED`) are now rendered through a
  `formatAuditAction()` helper into plain language (e.g. "Status updated:
  Secure Intake & Printing") in the Chain of Custody Log.

### 6.3.2 Printer details page

- `src/lib/epson.ts` — added `getDefaultPrintSettings()` (`GET
  /printing/capability/default`), `getPrintCapability(printMode)` (`GET
  /printing/capability/{document|photo}` — full capability matrix: color
  modes, resolutions, and every paper size × paper type × source × quality ×
  duplex combination the device supports), and `getNotificationSettings()`
  (`GET /printing/settings/notification`) — all read directly from the
  official spec, same as the rest of 6.3.
- `src/pages/api/epson/details.ts` — staff-only, fetches device info +
  defaults + both print-mode capabilities + notification settings in
  parallel and returns them together (or `{connected: false}` if not yet
  connected).
- `src/pages/printer.tsx` — a dedicated full page (not just the print
  queue's dropdown panel) showing everything the API reports: printer
  identity, current default print settings, the full capability matrix for
  both document and photo modes, notification config, and a raw-JSON
  toggle. Linked from the nav bar (`showPrintQueue` also gates this link)
  and from the `PrinterStatus` panel's "View full printer details →" link.

### 6.3.3 Epson Direct / Email Print (alternative to Epson Connect)

A second printing backend, selectable via a **Printing Method** toggle on
`/printer` — staff choose Epson Connect (cloud API, OAuth) or **Epson
Direct**, which uses Epson's built-in **Email Print** feature: every
Epson Connect-registered printer has its own assigned email address, and
attaching a PDF to a plain email sent to that address prints it
immediately. No OAuth app registration, `client_id`/`client_secret`,
redirect URI, or API key is needed at all — only an SMTP account to send
the email from.

This replaced an earlier "Linux Print Agent" design (a pull-based agent
script polling from an Ubuntu machine) within the same session it was
built — Epson Direct achieves the same goal (a working alternative to the
often-unreliable Epson Connect OAuth setup) with far less moving
infrastructure: no agent script/systemd service to run anywhere, no
bearer-token auth scheme, no polling loop. `20260105000000_linux_print_agent`
and `20260106000000_epson_direct_email_print` are both still in the
migration history — the second migration cleanly supersedes the first
(drops `LinuxPrintJob`, renames the `LINUX_AGENT` enum value to
`EPSON_DIRECT`) rather than editing already-applied migration files.

- **Data model**: `PrintSettings` (singleton row, `id` fixed to the literal
  string `"singleton"`) holds both the current `PrintProvider` (`EPSON` or
  `EPSON_DIRECT`) and `epsonDirectEmail` (the printer's own assigned Email
  Print address, staff-editable).
- `src/lib/printSettings.ts` — `getPrintSettings()`/`updatePrintSettings()`,
  both `upsert` against the singleton row so no seed step is needed.
- `src/lib/emailPrint.ts` — `sendPrintEmail()`, a thin `nodemailer` wrapper
  building an SMTP transport from `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/
  `SMTP_PASSWORD`/`SMTP_FROM_EMAIL`. Any SMTP account works — the actual
  deployment uses a dedicated `print@postnow.co.za` mailbox on Zoho Mail
  (`smtppro.zoho.com:587`) created specifically for this, rather than
  routing through a personal inbox.
- `src/pages/api/print-settings.ts` — GET/PATCH, staff-only, backs the
  toggle and email-address field on `/printer`.
- `src/pages/api/documents/[id]/print.ts` — checks the current provider
  first. If `EPSON_DIRECT`, it downloads the PDF from R2, emails it to
  `epsonDirectEmail` via `sendPrintEmail()`, and — like the Epson Connect
  path — marks `Document.status` `PRINTED` immediately once the email send
  succeeds (there's no delivery/print confirmation from Epson's side
  either way, so both providers use "we successfully handed it off" as the
  completion signal, not "it's confirmed physically printed"). On send
  failure, appends an `email_print_failed` audit event and leaves the
  document unchanged so staff can retry or switch providers. Returns 400
  if no `epsonDirectEmail` is configured yet.
- `print-queue.tsx` relabels the print button "📧 Email to Printer" when
  this mode is active (vs. "🖨️ Print (API)" for Epson Connect) — otherwise
  behaves identically to the Epson Connect button (removes the row from
  the queue on success, since both are synchronous from the UI's
  perspective).

### 6.3.4 Epson email notifications → platform (print confirmation)

Epson can email the Connect account owner when a print request is sent,
completed, expires, or errors (including "No printable data was sent" for
Email Print). That owner mailbox is the same Zoho account used as SMTP
sender for Epson Direct: `postnowprint.agent@postnow.co.za`
(`Zoho_PrintAgent_User` + `SMTP_PASSWORD`).

Pipeline:
1. Email Print submit (`print.ts`, `EPSON_DIRECT`) creates an
   `EpsonPrintJob` with `jobId` `email-print:<documentId>:<ts>` and status
   `pending`, subject line `PostNow document <id>` so notifications can be
   matched. Document still moves to `PRINTED` on successful SMTP submit
   (workflow continues) while confirmation is pending.
2. `src/lib/epsonNotifications.ts` connects over IMAP
   (`IMAP_HOST` default `imappro.zoho.com:993`), reads unread mail that
   looks Epson-related, classifies completed / error / expired / sent, and
   extracts the document id from the subject/body.
3. On **completed** → `EpsonPrintJob.status = completed`, audit
   `epson_print_confirmed`.
4. On **error/expired** → job settled, audit `epson_print_failed`; if the
   document is still `PRINTED`, it is rolled back to `QUEUED_FOR_PRINT` so
   staff can re-print.
5. Triggers: (a) automatic when `/api/epson/status` sees pending jobs,
   (b) manual "Check mailbox now" on `/printer`,
   (c) Vercel Cron every 5 minutes → `/api/epson/notifications/sync`
   (requires `CRON_SECRET` Bearer for unattended calls on Pro; staff session
   works without it).

UI: tracking page shows a "Print confirmation" card from the latest
`EpsonPrintJob`; PrinterStatus recent-jobs includes confirmation failures
and successes.

### 6.4 Courier Guy Quote Tool

- `src/lib/courierguy.ts` — `getRates()` only (no shipment creation — this is
  a rate-check tool for the dashboard, not a dispatch mechanism). Base URL
  confirmed via a user-supplied real Postman collection to be
  `https://api.portal.thecourierguy.co.za` — an earlier web-search-derived
  guess (`api-tcg.co.za`) was wrong (confirmed both by a live 404 in
  production and by this sandbox's network policy blocking that host
  outright at the CONNECT level). Bearer-token auth
  (`Authorization: Bearer <API key>`) is confirmed directly from the
  collection's own auth documentation. Modeled closely on `bobgo.ts`'s
  request shape since The Courier Guy's API is built on the same
  **Shiplogic** platform as Bob Go, which is why the field names match
  (`collection_address`/`delivery_address`/`parcels`). `CourierGuyAddress`
  also accepts optional `type` (`residential`/`business`/`counter`/`locker`)
  and `lat`/`lng` per their docs' accuracy recommendation.
- `src/pages/api/quote.ts` — always rates from the facility address (the
  only collection point this business dispatches from) to a staff-entered
  delivery address, optionally with `lat`/`lng` from address autocomplete.
  Purely a quote lookup, doesn't create or touch any
  `Document`/`BobgoShipment`.
- UI: a "Quote Tool" card on `/dashboard`, staff only, with the same address
  autocomplete as the dispatch form (see 6.5).

### 6.5 Address autocomplete

- `src/pages/api/geocode/autocomplete.ts` — proxies OpenStreetMap's free
  Nominatim geocoder (no API key required), used on both the "Physical
  Address" field on `/dispatch/new` and the Quote Tool's delivery-address
  field on `/dashboard` (the latter also captures `lat`/`lng` for more
  accurate Courier Guy rating). Constrained to South Africa
  (`countrycodes=za`), debounced client-side (350ms), returns up to 5
  suggestions that populate street/suburb/city/province/postal code (and
  lat/lng, where used) on selection.
- Chosen over a paid provider (Google Places, etc.) since no such API key
  was provided/requested — this works immediately with no account setup,
  at the cost of address-matching quality being noticeably rougher than a
  commercial geocoder for South African addresses specifically.

### 6.6 Storage & auth

- **Postgres**: Neon (EU West London region). Note: the original connection
  string was accidentally pasted into a chat session and was rotated
  immediately as a precaution before being placed in Vercel.
- **Object storage**: Cloudflare R2, bucket `postnow-documents`, S3-compatible
  API (`src/lib/storage.ts` uses `@aws-sdk/client-s3`). Access scoped via an
  Object Read & Write token. **Real production bug found and fixed**:
  `.env.example` documented `S3_REGION="af-south-1"`, but R2's SigV4 request
  signature only validates against the literal region string `"auto"` — any
  other value makes every upload fail with `SignatureDoesNotMatch`. Because
  `/api/documents/upload.ts` didn't catch storage errors, this crashed into
  Vercel's default HTML error page instead of a JSON response, which
  surfaced to users as a confusing "Unexpected token '<'" error in the
  browser. Fixed by correcting the env var default and wrapping the
  `putDocument()` call in a try/catch that returns a clean JSON 502. Also
  hit the same *shape* of bug twice more on other credentials — a corrupted
  R2 secret access key (65 chars pasted where R2 expects exactly 64,
  evidently a trailing newline from copy/paste) and a Courier Guy API key
  one character too long (33 vs. the expected 32) — both caught by adding
  temporary non-secret diagnostic logging (credential *lengths* and
  whitespace-trim checks, never the values themselves) rather than by
  guessing. This is now a known failure pattern worth checking first
  whenever a newly-pasted credential produces an otherwise-unexplained auth
  rejection.
- **Auth**: NextAuth credentials provider, bcrypt password hashing, JWT
  session strategy. First login is bootstrapped via
  `prisma/seed.ts` using `SEED_STAFF_EMAIL` / `SEED_STAFF_PASSWORD` — there is
  no signup flow. **Important gotcha that affects every staff-gated route**:
  this NextAuth config has no `jwt`/`session` callback that copies `role`
  onto the session object, so `session.user.role` is **always `undefined`**
  at runtime — checking it directly (as several pasted specs assumed) silently
  lets every request through as unauthorized rather than actually gating
  anything. The fix used everywhere in this codebase is either
  `getSessionUser()` (`src/lib/session.ts`, for API routes) or the
  `getServerSession()` + `prisma.user.findUnique({where:{email}})` pattern
  (for `getServerSideProps` in pages) — both re-fetch the real role from
  Postgres instead of trusting the session payload.

### 6.7 Feature Roadmap tracker (internal staff tool)

- `/roadmap` (`src/pages/roadmap.tsx`) — not a third-party integration, but a
  lightweight internal planning tool for staff: add/track/prioritize planned
  features (`Feature` model — name, priority, status, comment, checked),
  entirely separate from the customer-facing product and the audit trail.
  CRUD via `/api/features` and `/api/features/[id]`.
- Adding a feature opens via a **modal popup** (`Modal` component in
  `src/components/ui.tsx`, reusable) triggered by a "+ Add Feature" button,
  rather than an always-visible inline form.
- Built from a large pasted spec that (like other pasted specs this session)
  assumed `session.user.role` works (see the gotcha above — it was corrected
  to the real pattern), used Tailwind classes (this codebase has no
  Tailwind, only the custom `globals.css` design system), a nested
  `/staff/roadmap` route (corrected to the flat `/roadmap` this app actually
  uses), and — a real bug — sorted the `priority` enum as a plain string
  column, which gives `HIGH < LOW < MEDIUM` alphabetically instead of
  high-to-low; fixed with an explicit `PRIORITY_RANK` map used for sorting
  both server- and client-side.

### 6.7 Grok Voice Agent (xAI Realtime)

In-app speech-to-speech agent at `/voice`, powered by the Grok Voice Agent
API (`wss://api.x.ai/v1/realtime`). Architecture:

1. Browser (logged-in session) calls `POST /api/voice/session`.
2. Server uses `XAI_API_KEY` to mint an ephemeral client secret via
   `POST https://api.x.ai/v1/realtime/client_secrets` (default TTL 300s).
3. Browser opens the realtime WebSocket with subprotocol
   `xai-client-secret.<token>` — the real API key never reaches the client.
4. Session is configured with PostNow-specific instructions and **custom
   function tools**. When the model calls a tool, the client executes it
   against our Next.js routes (with the user's session cookie) and returns
   `function_call_output`.

Read-only tools (v1): `list_documents`, `get_document`, `live_tracking`,
`audit_summary`. Access control reuses owner-or-staff rules; document ids
may be full cuids or short spoken prefixes (`findAccessibleDocument` in
`src/lib/voiceAccess.ts`). Tools never return storage keys, checksums, or
PDF bytes.

Key files:
- `src/pages/voice.tsx` — page shell
- `src/components/VoiceAgent.tsx` — mic / WebSocket / playback
- `src/lib/voiceAgentConfig.ts` — instructions + tool schemas + client executors
- `src/pages/api/voice/**` — session mint + tool backends

Requires `XAI_API_KEY` in Vercel. Optional `XAI_VOICE_MODEL` (defaults to
`grok-voice-latest`).

## 7. Environment variables

Full reference: `app/.env.example`. Categories: `DATABASE_URL`,
`NEXTAUTH_SECRET`/`NEXTAUTH_URL`, `S3_*` (5), `BOBGO_*` (3),
`FACILITY_*` (8, the print facility's address/contact — used as the
collection address for outbound and delivery address for returns),
`BOBPAY_*` (3), `SEED_STAFF_EMAIL`/`SEED_STAFF_PASSWORD`, `EPSON_*` (up to 6:
`CLIENT_ID`/`CLIENT_SECRET`/`REDIRECT_URI` required, `API_KEY` and the two
base-URL overrides optional), `COURIER_GUY_API` (required for the quote
tool) / `COURIER_GUY_BASE_URL` (optional override), `SMTP_*` (4 required —
`HOST`/`PORT`/`USER`/`PASSWORD` — plus optional `SMTP_FROM_EMAIL`; only
needed if using Epson Direct instead of Epson Connect — see 6.3.3),
`XAI_API_KEY` (required for `/voice`) / optional `XAI_VOICE_MODEL`. No env
vars needed for address autocomplete (Nominatim requires no API key) or
the roadmap tracker.

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
- **Real outage caused and fixed**: the repo was briefly made private (for
  reasons unrelated to Pages), which took `postnow.co.za` down with a 404 —
  GitHub Pages doesn't serve from a private repo without a paid GitHub plan.
  Fixed by making the repo public again; this was double-checked as safe
  first via a full `git log --all -p` plus a working-tree grep confirming no
  real secrets exist anywhere in the repo's history (all credentials have
  only ever lived in Vercel's env var UI, never committed).

## 9. Verified working (as of writing)

**Confirmed live against the real production deployment** (not just
type-checked):
- Marketing site live at `postnow.co.za`; app live at `app.postnow.co.za`
  with a valid SSL certificate (the earlier "Failed to Load Cert" issue has
  since resolved).
- Login/session handling, the dashboard, and its real metrics (against the
  live Neon database, not placeholder data).
- Document upload → R2 storage → `Document` row creation, end-to-end,
  after fixing the `S3_REGION` bug (see 6.6).
- The print queue: a real uploaded document correctly appears on
  `/print-queue`, and manually marking it `PRINTED` via the queue's button
  works and is reflected on its tracking page.
- The tracking page: full status timeline, Dispatch Summary card, live
  courier tracking card (correctly shows "not booked yet" for a document
  with no shipment), chain-of-custody log with plain-language event labels,
  and compliance badges all render correctly for a real document.
- The Epson Connect OAuth round-trip *reaches* both Epson's `/auth/authorize`
  and `/auth/token` endpoints (confirmed via live logs) — but every attempt
  so far is rejected with `invalid_client` (see outstanding work #10); no
  successful connection or live print has happened yet.
- The Courier Guy Quote Tool reaches `api.portal.thecourierguy.co.za/rates`
  for real — but every attempt is rejected with a 401 (see outstanding work
  #11); no successful quote has come back yet.

**Built and type-checked, not yet exercised live** (blocked on the above two
integrations, or simply not tried yet):
- Print queue table: search/return-type filter/sort controls, summary
  tiles, links from each row to `/tracking/[id]`.
- The full `/printer` details page (identity, defaults, capability matrix,
  notification settings) — depends on a working Epson connection to show
  real data; currently correctly reports "not connected."
- The staff Feature Roadmap tracker, including its add-feature modal.
- Address autocomplete on both the dispatch form and the Quote Tool.
- Bob Go dispatch/returns and Bob Pay payments — blocked on missing API
  tokens (see outstanding work #1–2), never called live.

## 10. Outstanding work

1. **Bob Go API token** — blocked on account access; may need Bob Go support
   to unlock, or a plan upgrade.
2. **Bob Pay API token & passphrase** — need the manual login API call and to
   locate the passphrase in account settings.
3. **`app.postnow.co.za` SSL** — ✅ resolved. Confirmed working in production;
   the earlier intermittent "Failed to Load Cert" issue cleared on its own.
4. **End-to-end test of a real document** — upload → dispatch → payment →
   tracking has not yet been exercised against live Bob Go/Bob Pay sandbox
   APIs (blocked on items 1–2).
5. **POPIA data subject rights** — export/deletion endpoints not built.
6. **Upload hardening** — no virus scanning or rate limiting yet.
7. **Payment UI** — the `/pay` endpoint exists but there's no button on the
   tracking page to trigger it yet.
8. **Bob Pay token refresh** — the JWT expires after 30 days; no automated
   renewal exists.
9. **Print queue verification** — ✅ done. Migration applied cleanly; a real
   document was uploaded, appeared on `/print-queue`, and was successfully
   marked `PRINTED` via the manual button.
10. **Epson Connect live test — actively blocked, in progress.** The
    OAuth flow now reaches Epson's token endpoint (confirmed via live
    logging), but every attempt fails with `invalid_client` from
    `auth.epsonconnect.com/auth/token` — Epson is rejecting the
    `client_id`/`client_secret` pair itself, not anything about our request
    shape. Tried so far: regenerating a brand-new app in the Epson developer
    console (developer.epsonconnect.com) and updating
    `EPSON_CLIENT_ID`/`EPSON_CLIENT_SECRET`/`EPSON_API_KEY` in Vercel — still
    `invalid_client` after redeploying. Added temporary diagnostic logging
    to `callback.ts` (credential lengths + leading/trailing-whitespace
    flags, never the actual values, plus the exact `EPSON_REDIRECT_URI`
    being sent) to rule out the same "corrupted copy-paste" bug class that
    hit the R2 secret and Courier Guy key (see 6.6) — not yet confirmed
    whether that's the cause here too, or whether the Redirect URI
    registered against the Epson app doesn't exactly match
    `EPSON_REDIRECT_URI`. Next step: re-check that diagnostic log output
    after the next connection attempt.
11. **Courier Guy Quote Tool live test — actively blocked.** Base URL and
    Bearer-header auth are confirmed correct from a real Postman collection
    (see 6.4), but every real call to `/rates` gets a 401 "Authentication
    failed" from Courier Guy. Diagnostic logging (`courierguy.ts`) showed
    `COURIER_GUY_API` is 33 characters where a standard key is 32 —
    the same trailing-character-from-paste bug hit twice already elsewhere
    (see 6.6). Needs the value re-pasted carefully in Vercel and confirmed
    at exactly 32 characters before retesting.
12. **Deliberately not built** — a later prompt asked for: a `labelStatus`
    field on `Document`, a home-grown courier label generator (a Python
    agent using `reportlab` to draw a label PDF with its own fabricated
    tracking number, polling a `GET /api/labels/pending` endpoint and
    storing Epson tokens in a flat file `~/.epson_tokens.json`), and an
    "Instant Print" button distinct from the existing "Print (API)" one.
    Not implemented because: (a) file-based token storage cannot work at
    all on Vercel's serverless model — there is no persistent filesystem
    across function invocations; (b) it duplicates functionality Bob Go
    already provides properly (`BobgoShipment.waybillUrl`, the courier's own
    official tracking reference) with a fabricated fallback tracking number
    instead, which risks real packages carrying labels the courier's own
    system doesn't recognize; (c) it introduces a third status enum
    overlapping `Document.status` and `BobgoShipment.submissionStatus`. If a
    genuine local-print-agent (a script on a machine physically connected to
    a printer, for when Epson Connect Cloud isn't reliable) is still wanted,
    it needs scoping as its own feature with a real auth mechanism suited to
    an unattended script — not a reuse of the browser-session OAuth cookie
    flow.
