import { Router } from "express";
import { query } from "../db.js";
import { asyncH, ok } from "../utils/helpers.js";
import { requireAuth, requireTenantMember } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireTenantMember);

router.get(
  "/",
  asyncH(async (req, res) => {
    const tid = req.user.tenantId;

    const [products, customers, today, low, recent, invTotal, payTotal] = await Promise.all([
      query(`SELECT COUNT(*)::int AS count FROM products WHERE tenant_id = $1`, [tid]),
      query(`SELECT COUNT(*)::int AS count FROM customers WHERE tenant_id = $1`, [tid]),
      query(`SELECT COUNT(*)::int AS invoice_count, COALESCE(SUM(total),0) AS total FROM invoices WHERE tenant_id = $1 AND created_at::date = CURRENT_DATE`, [tid]),
      query(`SELECT COUNT(*)::int AS count FROM products WHERE tenant_id = $1 AND stock_qty <= reorder_level`, [tid]),
      query(
        `SELECT i.invoice_no, COALESCE(c.name,'Walk-in customer') AS customer_name,
                (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id)::int AS item_count,
                i.total, i.created_at
         FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
         WHERE i.tenant_id = $1 ORDER BY i.created_at DESC LIMIT 6`,
        [tid]
      ),
      query(`SELECT COALESCE(SUM(total),0) AS revenue FROM invoices WHERE tenant_id = $1`, [tid]),
      query(`SELECT COALESCE(SUM(amount),0) AS collected FROM payments WHERE tenant_id = $1`, [tid])
    ]);

    const [lowRows, recentRows] = await Promise.all([
      query(`SELECT id, name, stock_qty, reorder_level FROM products WHERE tenant_id = $1 AND stock_qty <= reorder_level ORDER BY stock_qty ASC LIMIT 6`, [tid]),
      query(
        `SELECT i.id, i.invoice_no, i.total,
                COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id),0) AS paid
         FROM invoices i WHERE i.tenant_id = $1 AND i.status IN ('credit','partially_paid')
         ORDER BY i.created_at DESC LIMIT 6`,
        [tid]
      )
    ]);

    ok(res, {
      stats: {
        products: products.rows[0].count,
        customers: customers.rows[0].count,
        todaySales: Number(today.rows[0].total),
        todayInvoices: today.rows[0].invoice_count,
        lowStock: low.rows[0].count,
        lifetimeRevenue: Number(invTotal.rows[0].revenue),
        collected: Number(payTotal.rows[0].collected)
      },
      recentInvoices: recent.rows,
      lowStockList: lowRows.rows,
      creditList: recentRows.rows
    });
  })
);

export default router;