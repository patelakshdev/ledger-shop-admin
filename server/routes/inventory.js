import { Router } from "express";
import { query } from "../db.js";
import { asyncH, ok, badRequest, notFound, str, audit } from "../utils/helpers.js";
import { requireAuth, requireTenantMember } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireTenantMember);

// ---------------------------------------------------------------------------
// GET /inventory/log  — stock movement history
// ---------------------------------------------------------------------------
router.get(
  "/log",
  asyncH(async (req, res) => {
    const { rows } = await query(
      `SELECT l.id, l.change_qty, l.reason, l.reference, l.created_at,
              p.name AS product_name, p.sku
       FROM inventory_log l JOIN products p ON p.id = l.product_id
       WHERE l.tenant_id = $1 ORDER BY l.created_at DESC LIMIT 100`,
      [req.user.tenantId]
    );
    ok(res, { logs: rows });
  })
);

// ---------------------------------------------------------------------------
// POST /inventory/adjust  — manual stock adjustment (+/-) with reason
// ---------------------------------------------------------------------------
router.post(
  "/adjust",
  asyncH(async (req, res) => {
    const b = req.body || {};
    const productId = str(b.productId, 64, "productId");
    const change = Number(b.changeQty);
    if (!productId || Number.isNaN(change) || change === 0) badRequest("productId and a non-zero changeQty are required");
    const reason = str(b.reason, 150, "reason") || "Manual adjustment";

    const { rows } = await query(
      `UPDATE products SET stock_qty = GREATEST(0, stock_qty + $1), updated_at = now()
       WHERE id = $2 AND tenant_id = $3 RETURNING id, name, stock_qty`,
      [change, productId, req.user.tenantId]
    );
    if (!rows[0]) notFound("Product not found");

    await query(
      `INSERT INTO inventory_log (tenant_id, product_id, change_qty, reason, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.user.tenantId, productId, change, reason, req.user.id]
    );
    await audit({
      action: "inventory.adjust",
      actorId: req.user.id,
      tenantId: req.user.tenantId,
      actorName: req.user.username,
      role: req.user.role,
      entity: "products",
      entityId: productId,
      meta: { change, reason },
      ip: req.ip
    });

    ok(res, { product: rows[0], change, reason });
  })
);

// ---------------------------------------------------------------------------
// GET /inventory/low  — low / out-of-stock list
// ---------------------------------------------------------------------------
router.get(
  "/low",
  asyncH(async (req, res) => {
    const { rows } = await query(
      `SELECT id, sku, name, stock_qty, reorder_level
       FROM products WHERE tenant_id = $1 AND stock_qty <= reorder_level ORDER BY stock_qty ASC`,
      [req.user.tenantId]
    );
    ok(res, { lowStock: rows });
  })
);

export default router;