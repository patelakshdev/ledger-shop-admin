import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { query } from "../db.js";
import { ApiError, forbidden, asyncH } from "../utils/helpers.js";

const BEARER = /^Bearer (.+)$/i;

/**
 * Loads the fresh user row (so disabled users / suspended tenants are
 * rejected immediately) and attaches req.user.
 */
export const requireAuth = asyncH(async (req, _res, next) => {
  const header = req.headers.authorization || "";
  const match = header.match(BEARER);
  if (!match) throw new ApiError(401, "Authentication required");

  let payload;
  try {
    payload = jwt.verify(match[1], config.jwtSecret);
  } catch {
    throw new ApiError(401, "Invalid or expired token");
  }

  const { rows } = await query(
    `SELECT u.id, u.tenant_id, u.username, u.full_name, u.role, u.is_active,
            t.status AS tenant_status, t.slug AS tenant_slug, t.name AS tenant_name
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [payload.sub]
  );
  const user = rows[0];
  if (!user) throw new ApiError(401, "User no longer exists");

  // tenant isolation: suspended/revoked tenant blocks ALL its users
  if (user.role !== "super_admin" && user.tenant_status === "suspended") {
    throw new ApiError(403, "Your tenant has been suspended by the platform administrator");
  }
  if (user.tenant_status === "deleted") {
    throw new ApiError(403, "Your tenant has been deleted by the platform administrator");
  }
  if (!user.is_active) throw new ApiError(403, "Your account has been deactivated");

  req.user = {
    id: user.id,
    tenantId: user.tenant_id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    tenantSlug: user.tenant_slug,
    tenantName: user.tenant_name
  };
  next();
});

/** Restrict to one or more roles. */
export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new ApiError(403, "You do not have permission to perform this action"));
  }
  next();
};

export const requireSuperAdmin = requireRole("super_admin");
export const requireTenantAdmin = requireRole("super_admin", "tenant_admin");
export const requireTenantMember = (req, _res, next) => {
  if (req.user.role === "super_admin") return next(new ApiError(403, "Super admin has no tenant scope"));
  next();
};

/** Super admin may act platform-wide; everyone else only inside their tenant. */
export const scopeId = (req) => (req.user.role === "super_admin" ? null : req.user.tenantId);

export function requireLogin(_req, _res, next) { forbidden("Login required"); }
