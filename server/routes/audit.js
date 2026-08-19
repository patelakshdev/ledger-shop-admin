import { Router } from "express";
import { query } from "../db.js";
import { asyncH, ok } from "../utils/helpers.js";
import { requireAuth, requireTenantMember } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Audit log. Super admin sees the whole platform; tenants see their own rows.
// ---------------------------------------------------------------------------
router.get(
  "/",
  asyncH(async (req, res) => {
    const isSuper = req.user.role === "super_admin";
    const params = [];
    let where = "";
    if (!isSuper) {
      params.push(req.user.tenantId);
      where = `WHERE tenant_id = $1`;
    }
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    params.push(limit);

    const { rows } = await query(
      `SELECT id, tenant_id, actor_name, role, action, entity, entity_id, meta, ip, created_at
       FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    ok(res, { auditLog: rows });
  })
);

export default router;