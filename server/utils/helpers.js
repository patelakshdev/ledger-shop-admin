import { query } from "../db.js";

/** Create an ApiError with a status code. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const ok = (res, data, status = 200) => res.status(status).json(data);

export const badRequest = (msg = "Bad request") => { throw new ApiError(400, msg); };
export const notFound = (msg = "Not found") => { throw new ApiError(404, msg); };
export const forbidden = (msg = "Forbidden") => { throw new ApiError(403, msg); };

/** Wrap async route handlers so rejections reach the error middleware. */
export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Write a security-audit row. Never throws — audit failures must not break requests. */
export async function audit(entry) {
  try {
    await query(
      `INSERT INTO audit_log (tenant_id, actor_id, actor_name, role, action, entity, entity_id, meta, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entry.tenantId || null,
        entry.actorId || null,
        entry.actorName || null,
        entry.role || null,
        entry.action,
        entry.entity || null,
        entry.entityId || null,
        entry.meta ? JSON.stringify(entry.meta) : "{}",
        entry.ip || null
      ]
    );
  } catch (e) {
    console.error("[audit] failed to write:", e.message);
  }
}

/** Basic string whitelist validator for short fields. */
export const str = (v, max = 200, field = "value") => {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length > max) badRequest(`${field} exceeds ${max} characters`);
  return s;
};

/** Numeric validator returning a non-negative number. */
export const num = (v, field = "value") => {
  const n = Number(v);
  if (Number.isNaN(n) || n < 0) badRequest(`${field} must be a non-negative number`);
  return n;
};

/** UUID-ish validator. */
export const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ""));
