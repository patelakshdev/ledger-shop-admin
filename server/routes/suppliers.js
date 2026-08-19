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
    let where = `WHERE s.tenant_id = $1`;
    if (q) {
      params.push(`%${q}%`, `%${q}%`);
      where += ` AND (s.name ILIKE $2 OR s.contact_person ILIKE $3)`;
    }
    const { rows } = await query(
      `SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id) AS product_count
       FROM suppliers s ${where} ORDER BY s.name`,
      params
    );
    ok(res, { suppliers: rows });
  })
);

router.post(
  "/",
  asyncH(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 150, "name");
    if (!name) badRequest("Supplier name is required");
    const { rows } = await query(
      `INSERT INTO suppliers (tenant_id, name, contact_person, phone, email, gstin, address)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, contact_person, phone, email, gstin, address, created_at`,
      [req.user.tenantId, name, str(b.contactPerson, 120, "contactPerson"), str(b.phone, 30, "phone"), str(b.email, 150, "email"), str(b.gstin, 20, "gstin"), str(b.address, 1000, "address")]
    );
    ok(res, { supplier: rows[0] }, 201);
  })
);

router.patch(
  "/:id",
  asyncH(async (req, res) => {
    const { rows } = await query(`SELECT * FROM suppliers WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
    if (!rows[0]) notFound("Supplier not found");
    const b = req.body || {};
    const result = await query(
      `UPDATE suppliers SET name=$1, contact_person=$2, phone=$3, email=$4, gstin=$5, address=$6
       WHERE id=$7 AND tenant_id=$8
       RETURNING id, name, contact_person, phone, email, gstin, address`,
      [
        b.name !== undefined ? str(b.name, 150, "name") : rows[0].name,
        b.contactPerson !== undefined ? str(b.contactPerson, 120, "contactPerson") : rows[0].contact_person,
        b.phone !== undefined ? str(b.phone, 30, "phone") : rows[0].phone,
        b.email !== undefined ? str(b.email, 150, "email") : rows[0].email,
        b.gstin !== undefined ? str(b.gstin, 20, "gstin") : rows[0].gstin,
        b.address !== undefined ? str(b.address, 1000, "address") : rows[0].address,
        req.params.id,
        req.user.tenantId
      ]
    );
    ok(res, { supplier: result.rows[0] });
  })
);

router.delete(
  "/:id",
  asyncH(async (req, res) => {
    const { rows } = await query(
      `DELETE FROM suppliers WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [req.params.id, req.user.tenantId]
    );
    if (!rows[0]) notFound("Supplier not found");
    ok(res, { deleted: true, id: req.params.id });
  })
);

export default router;