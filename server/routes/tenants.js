import { Router } from "express";
import bcrypt from "bcryptjs";
import { query, withTransaction } from "../db.js";
import { asyncH, audit, ok, badRequest, notFound, ApiError, str } from "../utils/helpers.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireSuperAdmin);

// ---------------------------------------------------------------------------
// List tenants (platform overview)
// ---------------------------------------------------------------------------
router.get(
  "/",
  asyncH(async (req, res) => {
    const { rows } = await query(
      `SELECT t.id, t.name, t.slug, t.status, t.plan, t.created_at, t.suspended_at,
              (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
              (SELECT COUNT(*) FROM invoices i WHERE i.tenant_id = t.id) AS invoice_count,
              (SELECT COALESCE(SUM(total),0) FROM invoices i WHERE i.tenant_id = t.id) AS revenue
       FROM tenants t
       ORDER BY t.created_at DESC`
    );
    ok(res, { tenants: rows });
  })
);

// ---------------------------------------------------------------------------
// Tenant detail + stats
// ---------------------------------------------------------------------------
router.get(
  "/:id",
  asyncH(async (req, res) => {
    const { rows } = await query(
      `SELECT t.*,
              (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
              (SELECT COUNT(*) FROM products p WHERE p.tenant_id = t.id) AS product_count,
              (SELECT COUNT(*) FROM invoices i WHERE i.tenant_id = t.id) AS invoice_count,
              (SELECT COALESCE(SUM(total),0) FROM invoices i WHERE i.tenant_id = t.id) AS revenue,
              (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.tenant_id = t.id) AS collected
       FROM tenants t WHERE t.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) notFound("Tenant not found");
    ok(res, { tenant: rows[0] });
  })
);

// ---------------------------------------------------------------------------
// Create tenant + its tenant_admin (super admin can control the platform)
// ---------------------------------------------------------------------------
router.post(
  "/",
  asyncH(async (req, res) => {
    const name = str(req.body?.name, 150, "name");
    const adminUsername = str(req.body?.adminUsername, 60, "adminUsername");
    const adminPassword = String(req.body?.adminPassword || "");
    const plan = ["free", "pro", "enterprise"].includes(req.body?.plan) ? req.body.plan : "free";
    if (!name || !adminUsername || adminPassword.length < 8) {
      badRequest("name, adminUsername (>=3 chars) and a password of at least 8 characters are required");
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(adminUsername)) {
      badRequest("adminUsername may only contain lowercase letters, digits and hyphens");
    }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) ||
                 adminUsername.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60);

    const hash = await bcrypt.hash(adminPassword, 10);
    let result;
    try {
      result = await withTransaction(async (client) => {
        const tenant = await client.query(
          `INSERT INTO tenants (name, slug, plan) VALUES ($1,$2,$3) RETURNING *`,
          [name, slug, plan]
        );
        const admin = await client.query(
          `INSERT INTO users (tenant_id, username, password_hash, full_name, email, role)
           VALUES ($1,$2,$3,$4,$5,'tenant_admin') RETURNING id, username, full_name, email, role`,
          [tenant.rows[0].id, adminUsername, hash, "Tenant Admin", String(req.body?.adminEmail || "").trim()]
        );
        return { tenant: tenant.rows[0], admin: admin.rows[0] };
      });
    } catch (e) {
      if (e.code === "23505") badRequest("Admin username already exists");
      if (e.code === "23514" || e.code === "22P02") badRequest("Invalid tenant data");
      throw e;
    }

    await audit({
      action: "tenant.created",
      actorId: req.user.id,
      actorName: req.user.username,
      role: req.user.role,
      entity: "tenants",
      entityId: result.tenant.id,
      meta: { name, slug, adminUsername },
      ip: req.ip
    });

    ok(res, { tenant: result.tenant, adminUser: result.admin }, 201);
  })
);

// ---------------------------------------------------------------------------
// Revoke / suspend a tenant (blocks ALL its users instantly)
// ---------------------------------------------------------------------------
router.patch(
  "/:id/status",
  asyncH(async (req, res) => {
    const status = req.body?.status;
    if (!["active", "suspended"].includes(status)) badRequest("status must be 'active' or 'suspended'");
    const { rows } = await query(
      `UPDATE tenants SET status = $1::varchar,
              suspended_at = CASE WHEN $1::varchar = 'suspended' THEN now() ELSE NULL END
       WHERE id = $2 RETURNING id, name, status`,
      [status, req.params.id]
    );
    if (!rows[0]) notFound("Tenant not found");

    await audit({
      action: status === "suspended" ? "tenant.suspended" : "tenant.reinstated",
      actorId: req.user.id,
      actorName: req.user.username,
      role: req.user.role,
      entity: "tenants",
      entityId: rows[0].id,
      meta: { name: rows[0].name },
      ip: req.ip
    });
    ok(res, { tenant: rows[0] });
  })
);

// ---------------------------------------------------------------------------
// Hard-delete a tenant (destroys its data) — tenant must be suspended first
// ---------------------------------------------------------------------------
router.delete(
  "/:id",
  asyncH(async (req, res) => {
    const { rows } = await query(`SELECT * FROM tenants WHERE id = $1`, [req.params.id]);
    if (!rows[0]) notFound("Tenant not found");
    if (rows[0].status !== "suspended") {
      badRequest("Suspend the tenant before deleting it — this prevents accidental data loss");
    }
    await query(`DELETE FROM tenants WHERE id = $1`, [req.params.id]);

    await audit({
      action: "tenant.deleted",
      actorId: req.user.id,
      actorName: req.user.username,
      role: req.user.role,
      entity: "tenants",
      entityId: rows[0].id,
      meta: { name: rows[0].name },
      ip: req.ip
    });
    ok(res, { deleted: true, id: req.params.id });
  })
);

export default router;
