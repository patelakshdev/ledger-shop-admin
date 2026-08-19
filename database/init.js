import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import bcrypt from "bcryptjs";
import pg from "pg";
import { config } from "../server/config.js";
import { swapDatabase, appDatabaseUrl, sslFor } from "../server/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reset = process.argv.includes("--reset");

if (!config.databaseUrl) {
  console.error("FATAL: DATABASE_URL is not set. Add it to .env (see .env.example).");
  process.exit(1);
}

// The app lives in a dedicated database (`config.appDatabase`); on Render
// free-tier we bootstrap it over the same host as an existing instance DB.
const TARGET_DB = config.appDatabase;

// Demo tenant catalog — a mobile phone shop (Vivo, Realme, Redmi, …).
// [sku, name, category, cost_price, sell_price, stock_qty, reorder_level]
const PHONE_PRODUCTS = [
  ["MOB-VIVO-Y16", "Vivo Y16 (4GB/64GB)", "Smartphones", 9450, 9999, 12, 3],
  ["MOB-REAL-C55", "Realme C55 (6GB/128GB)", "Smartphones", 11800, 12499, 9, 3],
  ["MOB-REDM-12", "Redmi 12 (4GB/128GB)", "Smartphones", 10200, 10999, 7, 2],
  ["MOB-SAMS-A14", "Samsung Galaxy A14 (4GB/128GB)", "Smartphones", 12400, 12999, 5, 2],
  ["MOB-OPPO-A18", "OPPO A18 (4GB/128GB)", "Smartphones", 10250, 10999, 0, 2],
  ["MOB-VIVO-Y36", "Vivo Y36 (8GB/256GB)", "Smartphones", 16200, 17999, 6, 2],
  ["ACC-CHR-33W", "33W Fast Charger", "Accessories", 380, 599, 25, 10],
  ["ACC-CASE-Y16", "Back Cover for Vivo Y16", "Accessories", 120, 199, 40, 15],
  ["ACC-EAR-WIRE", "Wireless Earphones", "Accessories", 850, 1199, 15, 6],
  ["ACC-GUARD-GL", "Tempered Glass Guard", "Accessories", 60, 149, 50, 20],
];

async function ensureDatabase() {
  const originalUrl = config.databaseUrl;
  const currentDb = new URL(originalUrl).pathname.replace(/^\//, "") || "postgres";
  // DATABASE_URL may point at the target DB before it exists; fall back to a
  // database that is guaranteed present (`postgres` or the URL's own DB).
  const attempts = [originalUrl];
  if (currentDb === TARGET_DB) attempts.push(swapDatabase(originalUrl, "postgres"));

  let bootstrap;
  let connectErr;
  for (const url of attempts) {
    bootstrap = new pg.Client({ connectionString: url, ssl: sslFor(url) });
    try {
      await bootstrap.connect();
      connectErr = null;
      break;
    } catch (e) {
      connectErr = e;
      try { await bootstrap.end(); } catch {}
    }
  }
  if (!bootstrap || connectErr) {
    console.error("Could not reach database:", connectErr?.message);
    process.exit(1);
  }
  try {
    const exists = await bootstrap.query(`SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'`);
    if (!exists.rows.length) {
      console.log(`Creating database '${TARGET_DB}'...`);
      await bootstrap.query(`CREATE DATABASE "${TARGET_DB}"`);
    } else {
      console.log(`Database '${TARGET_DB}' already exists.`);
    }
  } finally {
    await bootstrap.end();
  }
  return appDatabaseUrl();
}

async function main() {
  const appUrl = await ensureDatabase();
  const pool = new pg.Pool({ connectionString: appUrl, ssl: sslFor(appUrl) });

  if (reset) {
    console.log("Resetting schema...");
    await pool.query(`
      DROP TABLE IF EXISTS audit_log, inventory_log, payments, invoice_items, invoices,
        customers, products, suppliers, users, tenants CASCADE;
    `);
  }

  console.log("Applying schema.sql...");
  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);

  const exists = await pool.query(`SELECT 1 FROM users WHERE role = 'super_admin' LIMIT 1`);
  if (!exists.rows.length) {
    console.log("Creating super admin...");
    const hash = await bcrypt.hash(config.superAdmin.password, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, full_name, email, role) VALUES ($1,$2,$3,$4,'super_admin')`,
      [config.superAdmin.username, hash, "Platform Super Admin", config.superAdmin.email]
    );
    console.log(`  super admin -> ${config.superAdmin.username} / ${config.superAdmin.password}`);
  } else {
    console.log("Super admin already exists — skipping.");
  }

  const demo = await pool.query(`SELECT id FROM tenants WHERE slug = 'corner-and-co'`);
  if (!demo.rows.length) {
    console.log("Seeding demo tenant 'Corner & Co.'...");
    const tenant = await pool.query(
      `INSERT INTO tenants (name, slug, plan) VALUES ('Corner & Co.','corner-and-co','free') RETURNING id`
    );
    const tid = tenant.rows[0].id;
    const adminHash = await bcrypt.hash("TenantAdmin@123", 10);
    const empHash = await bcrypt.hash("Employee@123", 10);
    await pool.query(
      `INSERT INTO users (tenant_id, username, password_hash, full_name, role) VALUES
       ($1,'corneradmin', $2, 'Corner Admin', 'tenant_admin'),
       ($1,'cashier1', $3, 'Rhea Shah', 'employee')`,
      [tid, adminHash, empHash]
    );
    const sup = await pool.query(
      `INSERT INTO suppliers (tenant_id, name, phone) VALUES ($1,'Prime Mobile Distributors','98200 91234') RETURNING id`,
      [tid]
    );
    const supId = sup.rows[0].id;
    await pool.query(
      `INSERT INTO products (tenant_id, sku, name, category, cost_price, sell_price, stock_qty, reorder_level, supplier_id) VALUES ` +
        PHONE_PRODUCTS.map((p, i) => `($${1 + i * 9}, $${2 + i * 9}, $${3 + i * 9}, $${4 + i * 9}, $${5 + i * 9}, $${6 + i * 9}, $${7 + i * 9}, $${8 + i * 9}, $${9 + i * 9})`).join(",\n       "),
      PHONE_PRODUCTS.flatMap((p) => [tid, ...p, supId])
    );
    await pool.query(
      `INSERT INTO customers (tenant_id, name, phone, email) VALUES
       ($1,'Arjun Patel','90000 33445','arjun@example.com'),
       ($1,'Meera Nair','90000 55667','')`,
      [tid]
    );
    console.log(`  tenant admin -> corneradmin / TenantAdmin@123`);
    console.log(`  employee     -> cashier1 / Employee@123`);
  } else {
    console.log("Demo tenant already exists — skipping.");
  }

  if (process.env.SEED_PHONE_CATALOG === "1") {
    console.log("Refreshing demo tenant catalog with phone products (SEED_PHONE_CATALOG=1)...");
    const demo = await pool.query(`SELECT id FROM tenants WHERE slug = 'corner-and-co'`);
    if (demo.rows[0]) {
      const tid = demo.rows[0].id;
      await pool.query(
        `UPDATE suppliers SET name = 'Prime Mobile Distributors', phone = '98200 91234'
         WHERE tenant_id = $1 AND name = 'Amber Wholesale Foods'`,
        [tid]
      );
      const sup = await pool.query(`SELECT id FROM suppliers WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [tid]);
      const supId = sup.rows[0].id;
      await pool.query(`DELETE FROM products WHERE tenant_id = $1`, [tid]);
      await pool.query(
        `INSERT INTO products (tenant_id, sku, name, category, cost_price, sell_price, stock_qty, reorder_level, supplier_id) VALUES ` +
          PHONE_PRODUCTS.map((p, i) => `($${1 + i * 9}, $${2 + i * 9}, $${3 + i * 9}, $${4 + i * 9}, $${5 + i * 9}, $${6 + i * 9}, $${7 + i * 9}, $${8 + i * 9}, $${9 + i * 9})`).join(",\n       "),
        PHONE_PRODUCTS.flatMap((p) => [tid, ...p, supId])
      );
      console.log(`  catalog updated with ${PHONE_PRODUCTS.length} products`);
    }
  }

  console.log("\nDone. Database ready.");
  await pool.end();
}

main().catch((e) => {
  console.error("Database init failed:", e.message);
  process.exit(1);
});
