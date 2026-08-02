# Midl

Escrow + courier for South African peer-to-peer trade. Part of the [PostNow
Group](https://postnow.co.za).

**Live:** https://midl-postnow.vercel.app/

## What this is

`index.html` is the product/marketing site mockup — hero, plan comparison
(Essentials / Standard / Verified Delivery / Premium Vault), and a working
dashboard prototype (Overview, Orders, New Escrow, Tracking, Wallet,
Settings). It's a static, self-contained file: no build step, no backend
calls yet.

## Docs

- [`docs/BACKEND_DESIGN.md`](docs/BACKEND_DESIGN.md) — data model, deal
  state machine, trust-account and courier integration design.
- [`docs/POSTNOW_INFRA_REUSE.md`](docs/POSTNOW_INFRA_REUSE.md) — how Midl's
  backend reuses PostNow's existing GlobeMe/E2 infrastructure (Bob Go
  courier, PayFast, audit trail) instead of building from scratch. The
  `Deal`/`LedgerEntry`/`ConditionReport` schema this describes lives in
  `postnowcoza/app/prisma/schema.prisma` on the
  `claude/midl-platform-research-ohhhj2` branch (not yet merged to `main`).

## Deploy

Static HTML deployed to Vercel (project `midl-postnow`, team `post-now`).
Push to `main` here does not auto-deploy — redeploy manually via the Vercel
project until CI is wired up.
