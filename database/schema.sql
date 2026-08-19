-- =========================================================================
-- LEDGER — Multi-tenant Shop Admin Platform
-- PostgreSQL schema (works on Render PostgreSQL / Supabase / local PG 14+)
--
-- Tenancy model:
--   * tenants            — every shop/business is a tenant
--   * users              — super_admin (platform), tenant_admin, employee
--   * All business tables carry tenant_id and every query is scoped by it.
--   * Super admin can create, suspend (revoke) and delete tenants.
--   * Manual payment tracking lives in `payments` (invoice balance = total - paid).
--   * `audit_log` records security-sensitive actions for the audit trail.
-- =========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- -------------------------------------------------------------------------
-- Tenants (shops / businesses). Status controls platform access.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(150) NOT NULL,
  slug          VARCHAR(60) NOT NULL UNIQUE,
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended','deleted')),
  plan          VARCHAR(20) NOT NULL DEFAULT 'free'
                CHECK (plan IN ('free','pro','enterprise')),
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  suspended_at  TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------
-- Users. tenant_id NULL => platform super admin.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID,                          -- NULL = super admin
  username      VARCHAR(60) NOT NULL UNIQUE,
  email         VARCHAR(150),
  password_hash VARCHAR(255) NOT NULL,         -- bcrypt, never plain text
  full_name     VARCHAR(120) NOT NULL DEFAULT '',
  role          VARCHAR(20) NOT NULL DEFAULT 'employee'
                CHECK (role IN ('super_admin','tenant_admin','employee')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, username)
);

-- -------------------------------------------------------------------------
-- Suppliers
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  name            VARCHAR(150) NOT NULL,
  contact_person  VARCHAR(120),
  phone           VARCHAR(30) NOT NULL,
  email           VARCHAR(150),
  gstin           VARCHAR(20),
  address         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant ON suppliers(tenant_id);

-- -------------------------------------------------------------------------
-- Products
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  sku             VARCHAR(60) NOT NULL,
  name            VARCHAR(180) NOT NULL,
  category        VARCHAR(100) NOT NULL DEFAULT '',
  cost_price      NUMERIC(10,2) NOT NULL DEFAULT 0,
  sell_price      NUMERIC(10,2) NOT NULL DEFAULT 0,
  stock_qty       INT NOT NULL DEFAULT 0,
  reorder_level   INT NOT NULL DEFAULT 5,
  supplier_id     UUID,
  image_url       VARCHAR(500),
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_tenant_name ON products(tenant_id, name);

-- -------------------------------------------------------------------------
-- Customers
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  name          VARCHAR(150) NOT NULL,
  phone         VARCHAR(30) NOT NULL DEFAULT '',
  email         VARCHAR(150),
  address       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);

-- -------------------------------------------------------------------------
-- Invoices (POS tickets). customer_id NULL = walk-in.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  invoice_no      VARCHAR(30) NOT NULL,
  customer_id     UUID,
  subtotal        NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_pct         NUMERIC(5,2) NOT NULL DEFAULT 0,
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  payment_method  VARCHAR(30) NOT NULL DEFAULT 'Cash',
  status          VARCHAR(20) NOT NULL DEFAULT 'paid'
                  CHECK (status IN ('paid','credit','partially_paid','void')),
  billed_by       UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  FOREIGN KEY (billed_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, invoice_no)
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_date ON invoices(tenant_id, created_at);

-- -------------------------------------------------------------------------
-- Invoice line items
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   UUID NOT NULL,
  product_id   UUID,
  product_name VARCHAR(180) NOT NULL,     -- snapshot at time of sale
  qty          INT NOT NULL,
  unit_price   NUMERIC(10,2) NOT NULL,    -- snapshot at time of sale
  line_total   NUMERIC(10,2) GENERATED ALWAYS AS (qty * unit_price) STORED,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);

-- -------------------------------------------------------------------------
-- Manual payment tracking. One row per payment received against an invoice.
-- Outstanding balance = invoice.total - SUM(payments.amount).
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  invoice_id    UUID NOT NULL,
  amount        NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  method        VARCHAR(30) NOT NULL DEFAULT 'Cash',
  note          VARCHAR(255),
  received_by   UUID,
  paid_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

-- -------------------------------------------------------------------------
-- Inventory movement log
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  product_id   UUID NOT NULL,
  change_qty   INT NOT NULL,
  reason       VARCHAR(150) NOT NULL,
  reference    VARCHAR(60),
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_log_tenant ON inventory_log(tenant_id);

-- -------------------------------------------------------------------------
-- Security audit log (logins, tenant lifecycle, user management, payments)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID,
  actor_id    UUID,
  actor_name  VARCHAR(120),
  role        VARCHAR(20),
  action      VARCHAR(100) NOT NULL,       -- e.g. tenant.created, user.login
  entity      VARCHAR(60),                 -- e.g. tenants, users, payments
  entity_id   VARCHAR(64),
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id);

-- -------------------------------------------------------------------------
-- Views for dashboards
-- -------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_low_stock AS
  SELECT tenant_id, id, sku, name, stock_qty, reorder_level
  FROM products
  WHERE stock_qty <= reorder_level;

CREATE OR REPLACE VIEW v_today_sales AS
  SELECT tenant_id, COUNT(*) AS invoice_count, COALESCE(SUM(total),0) AS total_sales
  FROM invoices
  WHERE created_at::date = CURRENT_DATE
  GROUP BY tenant_id;
