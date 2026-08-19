import { Router } from "express";
import { query } from "../db.js";
import { asyncH, ok, badRequest, notFound, str } from "../utils/helpers.js";
import { requireAuth, requireTenantMember } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireTenantMember);

router.get(
  "/",
  asyncH(async (req, res) => {
    const q = String(req.query.search || "").trim();
    const params = [req.user.tenantId];
    let where = `WHERE c.tenant_id = $1`;
    if (q) {
      params.push(`%${q}%`, `%${q}%`);
      where += ` AND (c.name ILIKE $2 OR c.phone ILIKE $3)`;
    }
    const { rows } = await query(
      `SELECT c.id, c.name, c.phone, c.email, c.address, c.created_at,
              COALESCE((SELECT SUM(i.total) FROM invoices i WHERE i.customer_id = c.id), 0) AS total_spent,
              (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id) AS order_count
       FROM customers c ${where} ORDER BY c.name`,
      params
    );
    ok(res, { customers: rows });
  })
);

router.post(
  "/",
  asyncH(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 150, "name");
    if (!name) badRequest("Customer name is required");
    const { rows } = await query(
      `INSERT INTO customers (tenant_id, name, phone, email, address)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, phone, email, address, created_at`,
      [req.user.tenantId, name, str(b.phone, 30, "phone"), str(b.email, 150, "email"), str(b.address, 1000, "address")]
    );
    ok(res, { customer: rows[0] }, 201);
  })
);

router.patch(
  "/:id",
  asyncH(async (req, res) => {
    const { rows } = await query(`SELECT * FROM customers WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
    if (!rows[0]) notFound("Customer not found");
    const b = req.body || {};
    const result = await query(
      `UPDATE customers SET name=$1, phone=$2, email=$3, address=$4
       WHERE id=$5 AND tenant_id=$6
       RETURNING id, name, phone, email, address`,
      [
        b.name !== undefined ? str(b.name, 150, "name") : rows[0].name,
        b.phone !== undefined ? str(b.phone, 30, "phone") : rows[0].phone,
        b.email !== undefined ? str(b.email, 150, "email") : rows[0].email,
        b.address !== undefined ? str(b.address, 1000, "address") : rows[0].address,
        req.params.id,
        req.user.tenantId
      ]
    );
    ok(res, { customer: result.rows[0] });
  })
);

router.delete(
  "/:id",
  asyncH(async (req, res) => {
    const { rows } = await query(
      `DELETE FROM customers WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [req.params.id, req.user.tenantId]
    );
    if (!rows[0]) notFound("Customer not found");
    ok(res, { deleted: true, id: req.params.id });
  })
);

export default router;