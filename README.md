# Ledger — Multi-tenant Shop Admin Platform

A production-ready, **multi-tenant** shop admin panel: POS / billing, products, inventory,
suppliers, customers, invoices, **manual payment tracking**, employee management, and a
**super-admin console** to create / revoke / delete tenants — all data isolated per tenant.

Built on a real **PostgreSQL** database with a JWT-authenticated **Express API**.
Deploys free to **Vercel** (frontend + API) with the database on **Render**.

---

## Architecture

```
public/            Frontend (HTML/CSS/JS) — API-driven SPA, role-based UI
server/            Express API
  config.js        env config
  db.js            pg pool + transactions
  middleware/      JWT auth + RBAC (tenant isolation)
  routes/          auth, tenants, users, products, suppliers, customers,
                   invoices, payments, inventory, dashboard, audit
server.js          App entry (Express + static + /api). Vercel function.
database/
  schema.sql       PostgreSQL multi-tenant schema
  init.js          migrate + seed (super admin, demo tenant)
render.yaml        Render blueprint (PostgreSQL + optional staging API)
vercel.json        Vercel config (single Express serverless function)
```

## Multi-tenancy model

| Role | Scope | Capabilities |
|---|---|---|
| `super_admin` | Platform-wide | Create tenants, suspend/revoke access, delete tenants, platform dashboard, global audit log |
| `tenant_admin` | Own tenant | Full shop ops + create/edit/deactivate/delete employees, record manual payments |
| `employee` | Own tenant | Shop ops (billing, products, inventory, suppliers, customers, invoices, view payments) |

- Every business table has a `tenant_id` column and every query is scoped to the caller's tenant.
- Suspending a tenant **instantly blocks all its users** (enforced in `requireAuth`).
- Deleting a tenant requires it to be suspended first and destroys its data (cascade).
- `audit_log` records logins, tenant lifecycle, user changes and payments — viewable platform-wide by super admin, per-tenant for everyone else.
- Passwords are bcrypt-hashed; sessions are JWT with expiry; login is rate-limited.

## Manual payment tracking

- A sale with method `Credit / Ledger` creates a `credit` invoice with no payment record.
- **Payments → Record payment** adds money against an invoice; the balance updates
  (`invoice.total − SUM(payments)`), and the invoice status flips
  `credit → partially_paid → paid` automatically.
- Mistaken payments can be voided (status recomputed).

## Local development

```bash
npm install
# set up .env from .env.example (needs a PostgreSQL database — see below)
npm run db:init          # apply schema + create superadmin + demo tenant
npm run dev              # http://localhost:3000
```

Demo accounts (created by `db:init`):

| Role | Username | Password |
|---|---|---|
| Super admin | `superadmin` | `SuperAdmin@123` |
| Tenant admin | `corneradmin` | `TenantAdmin@123` |
| Employee | `cashier1` | `Employee@123` |

## Deployment

### Database + API — Render
Render free-tier PostgreSQL is internal-only, so the API runs **on Render** next to the DB.

1. Ensure you have one free Postgres instance (Render allows only one). Add a `ledger_shop`
   database to it (Dashboard → instance → connect via `psql` → `CREATE DATABASE ledger_shop;`),
   or let the app do it: `npm run db:init` auto-creates `ledger_shop` on the same host.
2. Deploy the API: Render dashboard → **New → Web Service** → select this repo
   (public) or connect your private repo. Use:
   - Build: `npm install`
   - Start: `npm run db:init && npm start`
   - Health check: `/api/health`
3. Add env vars on the service:
   - `DATABASE_URL` = **Internal** connection string of your Postgres. It may point
     at ANY existing database on the instance — the app auto-creates and uses its own
     `ledger_shop` database (override the name with `APP_DATABASE`).
   - `JWT_SECRET` = random string, `NODE_ENV=production`
   - `SUPER_ADMIN_USERNAME/PASSWORD` = super admin to seed on first boot

### Frontend — Vercel (static)
The SPA is deployed on Vercel and talks to the Render API over HTTPS.

```bash
npx vercel --prod
```
The frontend auto-detects the Render API (`https://ledger-api-ftow.onrender.com`) when hosted on
`*.vercel.app`; override it by setting `window.LEDGER_API_BASE` before `app.js` loads if needed.

- Frontend: https://ledger-shop-admin.vercel.app
- API: https://ledger-api-ftow.onrender.com (`/api/health` health check)


## Security

- bcrypt password hashing, JWT auth, helmet security headers, CORS, rate-limited login.
- Server-side tenant scoping on every query — a user can never read another tenant's rows.
- No secrets in the client; the API rejects suspended tenants and disabled users in real time.
- All sensitive actions are audit-logged with actor, action, metadata and IP.
