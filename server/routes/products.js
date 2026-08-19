import { Router } from "express";
import { query } from "../db.js";
import { asyncH, ok, badRequest, notFound, str, num } from "../utils/helpers.js";
import { requireAuth, requireTenantMember } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireTenantMember);

// ---------------------------------------------------------------------------
// GET /products?search=  (tenant-scoped list with low-stock flag)
// ---------------------------------------------------------------------------
router.get(
  "/",
  asyncH(async (req, res) => {
    const q = String(req.query.search || "").trim();
    const params = [req.user.tenantId];
    let where = `WHERE p.tenant_id = $1`;
    if (q) {
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      where += ` AND (p.name ILIKE $2 OR p.sku ILIKE $3 OR p.category ILIKE $4)`;
    }
    const { rows } = await query(
      `SELECT p.id, p.sku, p.name, p.category, p.cost_price, p.sell_price, p.stock_qty,
              p.reorder_level, p.supplier_id, p.image_url, p.description, p.created_at,
              s.name AS supplier_name,
              CASE WHEN p.stock_qty <= 0 THEN 'out' WHEN p.stock_qty <= p.reorder_level THEN 'low' ELSE 'ok' END AS stock_status
       FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
       ${where} ORDER BY p.name`,
      params
    );
    ok(res, { products: rows });
  })
);

// ---------------------------------------------------------------------------
// POST /products
// ---------------------------------------------------------------------------
router.post(
  "/",
  asyncH(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 180, "name");
    if (!name) badRequest("Product name is required");
    const sku = str(b.sku, 60, "sku");
    if (!sku) badRequest("SKU is required");

    const values = {
      tenantId: req.user.tenantId,
      sku,
      name,
      category: str(b.category, 100, "category"),
      cost: num(b.costPrice, "costPrice"),
      price: num(b.sellPrice, "sellPrice"),
      stock: Number(b.stockQty) || 0,
      reorder: Number(b.reorderLevel) ?? 5,
      supplierId: b.supplierId || null,
      image: str(b.imageUrl, 500, "imageUrl"),
      description: str(b.description, 2000, "description")
    };
    let product;
    try {
      const { rows } = await query(
        `INSERT INTO products (tenant_id, sku, name, category, cost_price, sell_price, stock_qty, reorder_level, supplier_id, image_url, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, sku, name, category, cost_price, sell_price, stock_qty, reorder_level, supplier_id, image_url, description, created_at`,
        [values.tenantId, values.sku, values.name, values.category, values.cost, values.price, values.stock, values.reorder, values.supplierId, values.image, values.description]
      );
      product = rows[0];
    } catch (e) {
      if (e.code === "23505") badRequest("SKU already exists for this product");
      if (e.code === "23503") badRequest("Selected supplier does not exist");
      throw e;
    }
    ok(res, { product }, 201);
  })
);

// ---------------------------------------------------------------------------
// PATCH /products/:id
// ---------------------------------------------------------------------------
router.patch(
  "/:id",
  asyncH(async (req, res) => {
    const { rows } = await query(`SELECT * FROM products WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenantId]);
    if (!rows[0]) notFound("Product not found");
    const b = req.body || {};
    const updated = {
      sku: b.sku !== undefined ? str(b.sku, 60, "sku") : rows[0].sku,
      name: b.name !== undefined ? str(b.name, 180, "name") : rows[0].name,
      category: b.category !== undefined ? str(b.category, 100, "category") : rows[0].category,
      cost: b.costPrice !== undefined ? num(b.costPrice, "costPrice") : Number(rows[0].cost_price),
      price: b.sellPrice !== undefined ? num(b.sellPrice, "sellPrice") : Number(rows[0].sell_price),
      stock: b.stockQty !== undefined ? (Number(b.stockQty) || 0) : rows[0].stock_qty,
      reorder: b.reorderLevel !== undefined ? (Number(b.reorderLevel) ?? 5) : rows[0].reorder_level,
      supplierId: b.supplierId !== undefined ? b.supplierId || null : rows[0].supplier_id,
      image: b.imageUrl !== undefined ? str(b.imageUrl, 500, "imageUrl") : rows[0].image_url,
      description: b.description !== undefined ? str(b.description, 2000, "description") : rows[0].description
    };
    const result = await query(
      `UPDATE products SET sku=$1, name=$2, category=$3, cost_price=$4, sell_price=$5, stock_qty=$6,
              reorder_level=$7, supplier_id=$8, image_url=$9, description=$10, updated_at=now()
       WHERE id=$11 AND tenant_id=$12
       RETURNING id, sku, name, category, cost_price, sell_price, stock_qty, reorder_level, supplier_id, image_url, description`,
      [updated.sku, updated.name, updated.category, updated.cost, updated.price, updated.stock, updated.reorder, updated.supplierId, updated.image, updated.description, req.params.id, req.user.tenantId]
    );
    ok(res, { product: result.rows[0] });
  })
);

// ---------------------------------------------------------------------------
// DELETE /products/:id
// ---------------------------------------------------------------------------
router.delete(
  "/:id",
  asyncH(async (req, res) => {
    const { rows } = await query(
      `DELETE FROM products WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [req.params.id, req.user.tenantId]
    );
    if (!rows[0]) notFound("Product not found");
    ok(res, { deleted: true, id: req.params.id });
  })
);

export default router;