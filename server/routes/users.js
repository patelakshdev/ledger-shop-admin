import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { asyncH, audit, ok, badRequest, notFound, str } from "../utils/helpers.js";
import { requireAuth, requireTenantMember, requireTenantAdmin } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth, requireTenantMember);

/**
 * tenant_id for this request: tenant admins work in their own tenant.
 * Super admin passing ?tenantId= can impersonate any tenant (platform control).
 */
const targetTenant = (req) =>
  req.user.role === "super_admin"
    ? String(req.query.tenantId || req.body?.tenantId || "")
    : req.user.tenantId;

// ---------------------------------------------------------------------------
// List employees of a tenant
// ---------------------------------------------------------------------------
router.get(
  "/",
  asyncH(async (req, res) => {
    const tenantId = targetTenant(req);
    if (!tenantId) badRequest("tenantId is required for super-admin access");
    const { rows } = await query(
      `SELECT id, username, email, full_name, role, is_active, last_login_at, created_at
       FROM users WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    ok(res, { users: rows });
  })
);

// ---------------------------------------------------------------------------
// Create an employee / tenant admin in the tenant
// ---------------------------------------------------------------------------
router.post(
  "/",
  requireTenantAdmin,
  asyncH(async (req, res) => {
    const tenantId = targetTenant(req);
    if (!tenantId) badRequest("tenantId is required");
    const username = str(req.body?.username, 60, "username");
    const password = String(req.body?.password || "");
    const role = ["employee", "tenant_admin"].includes(req.body?.role) ? req.body.role : "employee";
    if (!username || password.length < 6) badRequest("username and a password of at least 6 characters are required");

    const { rows: tenantRows } = await query(`SELECT id, name FROM tenants WHERE id = $1`, [tenantId]);
    if (!tenantRows[0]) notFound("Tenant not found");

    const hash = await bcrypt.hash(password, 10);
    let created;
    try {
      const { rows } = await query(
        `INSERT INTO users (tenant_id, username, password_hash, full_name, email, role)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, username, full_name, email, role, is_active, created_at`,
        [tenantId, username, hash, str(req.body?.fullName, 120, "fullName"), str(req.body?.email, 150, "email"), role]
      );
      created = rows[0];
    } catch (e) {
      if (e.code === "23505") badRequest("Username already exists in this tenant");
      throw e;
    }

    await audit({
      action: "user.created",
      actorId: req.user.id,
      tenantId,
      actorName: req.user.username,
      role: req.user.role,
      entity: "users",
      entityId: created.id,
      meta: { username, targetRole: role },
      ip: req.ip
    });
    ok(res, { user: created }, 201);
  })
);

// ---------------------------------------------------------------------------
// Update an employee (name, email, role, password, active toggle)
// ---------------------------------------------------------------------------
router.patch(
  "/:id",
  requireTenantAdmin,
  asyncH(async (req, res) => {
    const tenantId = targetTenant(req);
    const { rows } = await query(
      `SELECT u.*, t.name AS tenant_name FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1 AND u.tenant_id = $2`,
      [req.params.id, tenantId]
    );
    const user = rows[0];
    if (!user) notFound("User not found in this tenant");

    const fullName = req.body?.fullName !== undefined ? str(req.body.fullName, 120, "fullName") : user.full_name;
    const email = req.body?.email !== undefined ? str(req.body.email, 150, "email") : user.email;
    let role = user.role;
    if (req.body?.role) {
      if (!["employee", "tenant_admin"].includes(req.body.role)) badRequest("Invalid role");
      if (user.id === req.user.id) badRequest("You cannot change your own role");
      role = req.body.role;
    }
    let isActive = user.is_active;
    if (req.body?.isActive !== undefined) {
      isActive = Boolean(req.body.isActive);
      if (user.id === req.user.id && !isActive) badRequest("You cannot deactivate your own account");
    }
    let passwordHash = user.password_hash;
    if (req.body?.password) {
      if (String(req.body.password).length < 6) badRequest("New password must be at least 6 characters");
      passwordHash = await bcrypt.hash(String(req.body.password), 10);
    }

    await query(
      `UPDATE users SET full_name = $1, email = $2, role = $3, is_active = $4, password_hash = $5
       WHERE id = $6`,
      [fullName, email, role, isActive, passwordHash, user.id]
    );

    await audit({
      action: "user.updated",
      actorId: req.user.id,
      tenantId,
      actorName: req.user.username,
      role: req.user.role,
      entity: "users",
      entityId: user.id,
      meta: { username: user.username, changes: { fullName, role, isActive, passwordChanged: Boolean(req.body?.password) } },
      ip: req.ip
    });
    ok(res, { user: { id: user.id, username: user.username, fullName, email, role, isActive } });
  })
);

// ---------------------------------------------------------------------------
// Delete an employee (irreversible)
// ---------------------------------------------------------------------------
router.delete(
  "/:id",
  requireTenantAdmin,
  asyncH(async (req, res) => {
    const tenantId = targetTenant(req);
    const { rows } = await query(
      `SELECT id, username FROM users WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );
    if (!rows[0]) notFound("User not found in this tenant");
    if (rows[0].id === req.user.id) badRequest("You cannot delete your own account");

    await query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
    await audit({
      action: "user.deleted",
      actorId: req.user.id,
      tenantId,
      actorName: req.user.username,
      role: req.user.role,
      entity: "users",
      entityId: req.params.id,
      meta: { username: rows[0].username },
      ip: req.ip
    });
    ok(res, { deleted: true, id: req.params.id });
  })
);

export default router;