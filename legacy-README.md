# Ledger — Shop Admin Panel

A premium, single-purpose **admin panel** for a shop owner: product details, inventory / stock check, billing (point-of-sale), supplier details, customer details, and a global search across all of it.

## Stack

- **Frontend:** HTML5, Tailwind CSS (CDN), Bootstrap 5 (modals, form components), vanilla JavaScript — no build step, no framework.
- **Data layer:** `app.js` currently stores data in the browser's `localStorage`, structured exactly like SQL tables (`products`, `suppliers`, `customers`, `invoices`, `invoice_items`, `inventory_log`). This makes the app fully working out of the box — no server required — while keeping the data shape ready to move to a real database.
- **Backend (for production use):** `schema.sql` is a ready-to-run **MySQL** schema matching that same data model. Point a small REST API (PHP, Node/Express, or Python/Flask) at it and swap the `loadDB()` / `saveDB()` functions in `app.js` for `fetch()` calls — the rest of the UI logic doesn't need to change.

## Running it

Just open `index.html` in a browser — everything works immediately with demo data pre-loaded (8 products, 3 suppliers, 3 customers).

**Demo login:** username `admin`, password `admin123` (pre-filled on the login screen). Change this in `DB.settings` inside `app.js`, or wire it to `admin_users` in the SQL schema once you add a backend.

## What's included

| Module | What it does |
|---|---|
| **Dashboard** | Today's sales, invoice count, low-stock alerts, customer count, recent activity |
| **Billing / Sell** | The "seller" screen — click products to build a sale ticket (styled like a real receipt), pick a customer, apply discount/tax, choose payment method, complete the sale and print the invoice. Stock decrements automatically. |
| **Products** | Full CRUD: name, SKU, category, cost & sell price, opening stock, reorder level, supplier link, image URL, description |
| **Inventory** | Live stock levels with Healthy / Low / Out-of-stock status, one-click stock adjustment (+/-) with a reason, and a full movement log |
| **Suppliers** | Full CRUD: company, contact person, phone, email, GSTIN, address; shows how many products each supplier feeds |
| **Customers** | Full CRUD: name, phone, email, address; tracks lifetime spend and order count automatically from billing |
| **Invoices** | Every sale ever billed, with a printable receipt-style invoice view |
| **Global search** | The top search bar searches products, customers, suppliers and invoices at once and jumps you straight to the result |

## Moving to a real backend later

1. Run `schema.sql` against a MySQL 8+ database.
2. Build a small REST API with endpoints like `GET/POST/PUT/DELETE /products`, `/suppliers`, `/customers`, `/invoices`.
3. In `app.js`, replace `loadDB()`/`saveDB()` (which read/write `localStorage`) with `fetch()` calls to those endpoints, and hash passwords properly (bcrypt) instead of the plain-text demo check.
4. Everything else — rendering, the POS cart, search, modals — talks to the `DB` object in memory and doesn't need to change.

## Files

- `index.html` — page structure, all modals
- `style.css` — the design system (colors, type, the receipt-style billing panel)
- `app.js` — all application logic and the data layer
- `schema.sql` — MySQL schema for a production backend
