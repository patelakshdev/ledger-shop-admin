import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { config } from "./server/config.js";
import { ApiError } from "./server/utils/helpers.js";

import authRoutes from "./server/routes/auth.js";
import tenantRoutes from "./server/routes/tenants.js";
import userRoutes from "./server/routes/users.js";
import productRoutes from "./server/routes/products.js";
import supplierRoutes from "./server/routes/suppliers.js";
import customerRoutes from "./server/routes/customers.js";
import invoiceRoutes from "./server/routes/invoices.js";
import paymentRoutes from "./server/routes/payments.js";
import inventoryRoutes from "./server/routes/inventory.js";
import dashboardRoutes from "./server/routes/dashboard.js";
import auditRoutes from "./server/routes/audit.js";

const app = express();
app.set("trust proxy", 1);

// --- Security hardening ---------------------------------------------------
app.use(helmet());
app.use(cors({ origin: config.clientOrigin === "*" ? true : config.clientOrigin }));
app.use(express.json({ limit: "256kb" }));
app.use(
  "/api/auth/login",
  rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false })
);

// --- API routes -----------------------------------------------------------
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.use("/api/auth", authRoutes);
app.use("/api/admin/tenants", tenantRoutes);
app.use("/api/admin/audit", auditRoutes);
app.use("/api/users", userRoutes);
app.use("/api/products", productRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/dashboard", dashboardRoutes);

// --- Static frontend ------------------------------------------------------
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.use(express.static(publicDir));
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

// --- API 404 + error handler ----------------------------------------------
app.use("/api", (_req, _res, next) => next(new ApiError(404, "Endpoint not found")));
app.use((err, _req, res, _next) => {
  const status = err instanceof ApiError ? err.status : err.statusCode || 500;
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({
    error: status >= 500 ? "Internal server error" : err.message || "Error"
  });
});

export default app;

// --- Local dev server ------------------------------------------------------
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  app.listen(config.port, () => {
    console.log(`\n  Ledger multi-tenant platform running`);
    console.log(`  ➜ http://localhost:${config.port}`);
    console.log(`  ➜ API health: http://localhost:${config.port}/api/health\n`);
  });
}
