import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { query } from "../db.js";
import { asyncH, audit, ApiError, ok } from "../utils/helpers.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.post(
  "/login",
  asyncH(async (req, res) => {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!username || !password) throw new ApiError(400, "Username and password are required");

    const { rows } = await query(
      `SELECT u.id, u.tenant_id, u.username, u.full_name, u.role, u.is_active, u.password_hash,
              t.status AS tenant_status, t.name AS tenant_name
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE u.username = $1`,
      [username]
    );
    const user = rows[0];

    const valid = user && (await bcrypt.compare(password, user.password_hash));
    if (!valid) {
      await audit({ action: "auth.login_failed", meta: { username }, ip: req.ip });
      throw new ApiError(401, "Invalid username or password");
    }

    if (user.role !== "super_admin" && user.tenant_status === "suspended") {
      await audit({ action: "auth.login_blocked_suspended", tenantId: user.tenant_id, meta: { username }, ip: req.ip });
      throw new ApiError(403, "This tenant has been suspended by the platform administrator");
    }
    if (user.tenant_status === "deleted") {
      throw new ApiError(403, "This tenant has been deleted by the platform administrator");
    }
    if (!user.is_active) throw new ApiError(403, "This account has been deactivated");

    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    await audit({
      action: "auth.login",
      actorId: user.id,
      tenantId: user.tenant_id,
      actorName: user.full_name || user.username,
      role: user.role,
      entity: "users",
      entityId: user.id,
      ip: req.ip
    });

    const token = jwt.sign(
      { sub: user.id, role: user.role, tenant: user.tenant_id },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    ok(res, {
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
        tenantId: user.tenant_id,
        tenantName: user.tenant_name || null
      }
    });
  })
);

router.get(
  "/me",
  requireAuth,
  asyncH(async (req, res) => {
    ok(res, { user: req.user });
  })
);

export default router;
