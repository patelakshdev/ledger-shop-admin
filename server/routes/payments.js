import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { asyncH, ok, badRequest, notFound, str, num, audit } from "../utils/helpers.js";
import { requireAuth, requireTenantMember } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireTenantMember);

// ---------------------------------------------------------------------------
// GET /payments — payment history (optionally for one invoice)
// ---------------------------------------------------------------------------
router.get(
  "/",
  asyncH(async (req, res) => {
    const invoiceId = String(req.query.invoiceId || "");
    const params = [req.user.tenantId];
    let where = `WHERE p.tenant_id = $1`;
    if (invoiceId) {
      params.push(invoiceId);
      where += ` AND p.invoice_id = $2`;
    }
    const { rows } = await query(
      `SELECT p.id, p.invoice_id, i.invoice_no, p.amount, p.method, p.note, p.received_by,
              u.full_name AS received_by_name, p.paid_at
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN users u ON u.id = p.received_by
       ${where} ORDER BY p.paid_at DESC`,
      params
    );
    ok(res, { payments: rows });
  })
);

// ---------------------------------------------------------------------------
// GET /payments/outstanding — credit customers & unpaid balances
// ---------------------------------------------------------------------------
router.get(
  "/outstanding",
  asyncH(async (req, res) => {
    const { rows } = await query(
      `SELECT i.id, i.invoice_no, i.created_at,
              COALESCE(c.name, 'Walk-in customer') AS customer_name,
              COALESCE(c.phone, '') AS customer_phone,
              i.total,
              COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid
       FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.tenant_id = $1 AND i.status IN ('credit','partially_paid')
       ORDER BY i.created_at DESC`,
      [req.user.tenantId]
    );
    const list = rows.map((r) => ({
      ...r,
      paid: Number(r.paid),
      outstanding: Number((Number(r.total) - Number(r.paid)).toFixed(2))
    }));
    const totalOutstanding = list.reduce((s, r) => s + r.outstanding, 0);
    ok(res, { outstanding: list, totalOutstanding });
  })
);

// ---------------------------------------------------------------------------
// POST /payments — record a manual payment against an invoice
// ---------------------------------------------------------------------------
router.post(
  "/",
  asyncH(async (req, res) => {
    const b = req.body || {};
    const invoiceId = str(b.invoiceId, 64, "invoiceId");
    if (!invoiceId) badRequest("invoiceId is required");
    const amount = num(b.amount, "amount");
    if (amount <= 0) badRequest("Payment amount must be greater than zero");
    const method = str(b.method, 30, "method") || "Cash";

    const result = await withTransaction(async (client) => {
      const inv = await client.query(
        `SELECT id, total, status FROM invoices WHERE id = $1 AND tenant_id = $2`,
        [invoiceId, req.user.tenantId]
      );
      if (!inv.rows[0]) badRequest("Invoice not found in this tenant");
      const total = Number(inv.rows[0].total);

      const pay = await client.query(
        `INSERT INTO payments (tenant_id, invoice_id, amount, method, note, received_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, amount, method, note, paid_at`,
        [req.user.tenantId, invoiceId, amount, method, str(b.note, 255, "note"), req.user.id]
      );

      const agg = await client.query(
        `SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE invoice_id = $1`,
        [invoiceId]
      );
      const paid = Number(agg.rows[0].paid);
      const status = paid >= total ? "paid" : "partially_paid";
      await client.query(`UPDATE invoices SET status = $1 WHERE id = $2`, [status, invoiceId]);

      return { payment: pay.rows[0], paid, status };
    });

    await audit({
      action: "payment.recorded",
      actorId: req.user.id,
      tenantId: req.user.tenantId,
      actorName: req.user.username,
      role: req.user.role,
      entity: "payments",
      entityId: result.payment.id,
      meta: { invoiceId, amount, method },
      ip: req.ip
    });

    ok(res, {
      payment: result.payment,
      paid: result.paid,
      invoiceStatus: result.status,
      remaining: Number((Number((await query(`SELECT total, status FROM invoices WHERE id = $1`, [invoiceId])).rows[0].total) - result.paid).toFixed(2))
    }, 201);
  })
);

// ---------------------------------------------------------------------------
// DELETE /payments/:id — void a mistaken payment (reverts invoice status)
// ---------------------------------------------------------------------------
router.delete(
  "/:id",
  asyncH(async (req, res) => {
    const result = await withTransaction(async (client) => {
      const pay = await client.query(
        `SELECT id, invoice_id, amount FROM payments WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, req.user.tenantId]
      );
      if (!pay.rows[0]) badRequest("Payment not found in this tenant");

      await client.query(`DELETE FROM payments WHERE id = $1`, [req.params.id]);

      const agg = await client.query(
        `SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE invoice_id = $1`,
        [pay.rows[0].invoice_id]
      );
      const paid = Number(agg.rows[0].paid);
      const inv = await client.query(`SELECT total FROM invoices WHERE id = $1`, [pay.rows[0].invoice_id]);
      const total = Number(inv.rows[0].total);
      const status = paid >= total ? "paid" : paid > 0 ? "partially_paid" : "credit";
      await client.query(`UPDATE invoices SET status = $1 WHERE id = $2`, [status, pay.rows[0].invoice_id]);

      return { id: req.params.id, paid, status };
    });

    await audit({
      action: "payment.voided",
      actorId: req.user.id,
      tenantId: req.user.tenantId,
      actorName: req.user.username,
      role: req.user.role,
      entity: "payments",
      entityId: req.params.id,
      ip: req.ip
    });
    ok(res, { deleted: true, ...result });
  })
);

export default router;