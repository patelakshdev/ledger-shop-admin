import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { asyncH, ok, badRequest, notFound, str, num, audit } from "../utils/helpers.js";
import { requireAuth, requireTenantMember } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireTenantMember);

const PAY_METHODS = ["Cash", "UPI", "Card", "Credit / Ledger"];
const isCredit = (m) => m === "Credit / Ledger" || m === "Credit";

// ---------------------------------------------------------------------------
// List invoices with outstanding balance (credit customers)
// ---------------------------------------------------------------------------
router.get(
  "/",
  asyncH(async (req, res) => {
    const { rows } = await query(
      `SELECT i.id, i.invoice_no, i.subtotal, i.discount_pct, i.tax_pct, i.total,
              i.payment_method, i.status, i.created_at,
              COALESCE(c.name, 'Walk-in customer') AS customer_name,
              c.id AS customer_id,
              COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid
       FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.tenant_id = $1
       ORDER BY i.created_at DESC`,
      [req.user.tenantId]
    );
    const invoices = rows.map((r) => ({
      ...r,
      outstanding: Number((Number(r.total) - Number(r.paid)).toFixed(2)),
      paymentsCount: null
    }));
    ok(res, { invoices });
  })
);

// ---------------------------------------------------------------------------
// Invoice detail (items + payments)
// ---------------------------------------------------------------------------
router.get(
  "/:id",
  asyncH(async (req, res) => {
    const { rows } = await query(
      `SELECT i.*, COALESCE(c.name, 'Walk-in customer') AS customer_name,
              COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [req.params.id, req.user.tenantId]
    );
    if (!rows[0]) notFound("Invoice not found");
    const inv = rows[0];
    const items = await query(`SELECT id, product_id, product_name, qty, unit_price, line_total FROM invoice_items WHERE invoice_id = $1`, [inv.id]);
    const payments = await query(
      `SELECT id, amount, method, note, received_by, paid_at FROM payments WHERE invoice_id = $1 ORDER BY paid_at DESC`,
      [inv.id]
    );
    ok(res, {
      invoice: {
        ...inv,
        paid: Number(inv.paid),
        outstanding: Number((Number(inv.total) - Number(inv.paid)).toFixed(2)),
        items: items.rows,
        payments: payments.rows
      }
    });
  })
);

// ---------------------------------------------------------------------------
// POST /invoices  — complete a sale atomically
//   * inserts invoice + items
//   * decrements stock and logs the movement
//   * marks invoice paid / credit / partially handled via manual payments
// ---------------------------------------------------------------------------
router.post(
  "/",
  asyncH(async (req, res) => {
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) badRequest("Invoice needs at least one line item");
    const method = PAY_METHODS.includes(b.paymentMethod) ? b.paymentMethod : "Cash";
    const discountPct = num(b.discountPct, "discountPct") || 0;
    const taxPct = num(b.taxPct, "taxPct") || 0;
    const customerId = b.customerId || null;
    const subtotal = num(b.subtotal, "subtotal");
    const total = num(b.total, "total");
    if (discountPct > 100) badRequest("Discount cannot exceed 100%");

    const result = await withTransaction(async (client) => {
      const seq = await client.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_no FROM 5) AS INT)), 1000) + 1 AS next_no
         FROM invoices WHERE tenant_id = $1`,
        [req.user.tenantId]
      );
      const nextNo = seq.rows[0].next_no;
      const invoiceNo = "INV-" + nextNo;
      const status = isCredit(method) ? "credit" : "paid";

      // validate stock for each line
      for (const it of items) {
        const qty = Number(it.qty) || 0;
        if (qty <= 0) badRequest("Line quantity must be positive");
        const product = await client.query(
          `SELECT id, stock_qty FROM products WHERE id = $1 AND tenant_id = $2`,
          [it.productId, req.user.tenantId]
        );
        if (!product.rows[0]) badRequest(`Product ${it.productId} not found`);
        if (product.rows[0].stock_qty < qty) {
          badRequest(`Not enough stock for one of the items`);
        }
      }

      const inv = await client.query(
        `INSERT INTO invoices (tenant_id, invoice_no, customer_id, subtotal, discount_pct, tax_pct, total, payment_method, status, billed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, invoice_no, created_at`,
        [req.user.tenantId, invoiceNo, customerId, subtotal, discountPct, taxPct, total, method, status, req.user.id]
      );

      for (const it of items) {
        const product = await client.query(
          `SELECT id, name, sell_price, stock_qty FROM products WHERE id = $1 AND tenant_id = $2`,
          [it.productId, req.user.tenantId]
        );
        const p = product.rows[0];
        await client.query(
          `INSERT INTO invoice_items (invoice_id, product_id, product_name, qty, unit_price)
           VALUES ($1,$2,$3,$4,$5)`,
          [inv.rows[0].id, p.id, p.name, Number(it.qty), p.sell_price]
        );
        await client.query(
          `UPDATE products SET stock_qty = GREATEST(0, stock_qty - $1), updated_at = now() WHERE id = $2 AND tenant_id = $3`,
          [Number(it.qty), p.id, req.user.tenantId]
        );
        await client.query(
          `INSERT INTO inventory_log (tenant_id, product_id, change_qty, reason, reference, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.tenantId, p.id, -Number(it.qty), "Sold — " + invoiceNo, invoiceNo, req.user.id]
        );
      }

      // automatic payment record for immediate (non-credit) sales
      if (status === "paid") {
        await client.query(
          `INSERT INTO payments (tenant_id, invoice_id, amount, method, note, received_by)
           VALUES ($1,$2,$3,$4,'Auto — full payment at sale', $5)`,
          [req.user.tenantId, inv.rows[0].id, total, method, req.user.id]
        );
      }

      await audit({
        action: "invoice.created",
        actorId: req.user.id,
        tenantId: req.user.tenantId,
        actorName: req.user.username,
        role: req.user.role,
        entity: "invoices",
        entityId: inv.rows[0].id,
        meta: { invoiceNo, total, method, status },
        ip: req.ip
      });

      return { invoice: inv.rows[0], status };
    });

    // load full invoice for the UI
    const { rows } = await query(
      `SELECT i.*, COALESCE(c.name,'Walk-in customer') AS customer_name,
              COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id),0) AS paid
       FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [result.invoice.id, req.user.tenantId]
    );
    const savedItems = await query(`SELECT * FROM invoice_items WHERE invoice_id = $1`, [result.invoice.id]);
    const payments = await query(`SELECT id, amount, method, note, paid_at FROM payments WHERE invoice_id = $1 ORDER BY paid_at DESC`, [result.invoice.id]);

    ok(res, {
      invoice: {
        ...rows[0],
        paid: Number(rows[0].paid),
        outstanding: Number((Number(rows[0].total) - Number(rows[0].paid)).toFixed(2)),
        items: savedItems.rows,
        payments: payments.rows
      }
    }, 201);
  })
);

export default router;