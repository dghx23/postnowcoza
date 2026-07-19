# postnowcoza

South Africa’s **POPIA-first** secure physical document dispatch — upload, print, courier, wet-ink signature, return, with a full chain-of-custody audit trail.

| Surface | URL | Hosting |
|---------|-----|---------|
| Marketing site | [postnow.co.za](https://postnow.co.za) | GitHub Pages (repo root) |
| Product app (E2) | [app.postnow.co.za](https://app.postnow.co.za) | Vercel (`/app` Next.js 14) |

## Repository layout

```
/                     Marketing site (static HTML/CSS, GitHub Pages)
  index.html
  styles.css
  assets/
  docs/                 Extra product notes (e.g. parked customer portal)

/app                  Staff + product backend (Next.js Pages Router)
  README.md             App-focused setup & integration notes
  TECH_SPEC.md          Full technical specification (sibling of this file at repo root)
  prisma/               Schema, migrations, seed (roadmap items, staff bootstrap)
  src/pages/            UI routes + API handlers
  src/lib/              Business logic & third-party clients
```

Detailed architecture, data model, env vars, and integrations: **[TECH_SPEC.md](./TECH_SPEC.md)**.  
App local setup: **[app/README.md](./app/README.md)**.  
Customer portal is **parked** (staff ops is live): **[docs/CUSTOMER_PORTAL_PARKED.md](./docs/CUSTOMER_PORTAL_PARKED.md)**.

## What the live app does (staff ops first)

- **Staff manual job entry** (`/dispatch/new`) → tracking + **request payment** (email and/or WhatsApp)
- **PayFast** checkout for dispatch fees (`/pay/[id]`); branded payment-request email + WhatsApp templates
- **Print queue** + **Printer hub** (Epson Connect API and Epson Direct email-print)
- **Financial** ledger (`/finance`): facility payments, **two-way Zoho Books** (push/pull), **payment structure** workspace
- **Exception log** via ⚙ next to the staff user label (Zoho / structure errors)
- **Tracking** hub with STAFF badge, arrange-fee CTA for staff-created jobs, live courier card, chain of custody
- **Roadmap** tracker (includes HIGH item to configure Zoho Books env in Vercel when unlock allows)

## Branch & deploy

- Default branch: `main`
- Push to `main` → GitHub Pages (marketing) + Vercel rebuild (`/app`: `prisma generate && migrate deploy && seed && next build`)

## Secrets

Never commit credentials. Configure in Vercel (and local `.env.local` from `app/.env.example`). See TECH_SPEC §7 and the in-app **Roadmap** for Zoho / WhatsApp / SMTP cutovers.
