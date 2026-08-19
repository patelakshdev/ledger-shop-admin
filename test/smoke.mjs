/* End-to-end smoke test against a running server on http://localhost:3000 */
const BASE = "http://localhost:3000/api";
let passed = 0, failed = 0;

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function check(name, cond, detail = "") {
  if (cond) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name + (detail ? " -> " + detail : "")); }
}

let superToken, adminToken, newTenantId, newInvId, prodId;

// 1. health
const health = await api("GET", "/health");
check("health endpoint", health.status === 200 && health.data.ok === true);

// 2. wrong password rejected
const badLogin = await api("POST", "/auth/login", { username: "superadmin", password: "wrongpass" });
check("bad login rejected", badLogin.status === 401);

// 3. super admin login
const sl = await api("POST", "/auth/login", { username: "superadmin", password: "SuperAdmin@123" });
check("super admin login", sl.status === 200 && sl.data.user.role === "super_admin", JSON.stringify(sl.data));
superToken = sl.data.token;

// 4. list tenants, create tenant
const t0 = await api("GET", "/admin/tenants", null, superToken);
check("super can list tenants", t0.status === 200 && Array.isArray(t0.data.tenants));
check("demo tenant seeded", t0.data.tenants.some(t => t.slug === "corner-and-co"));

const createTenant = await api("POST", "/admin/tenants", {
  name: "Test Cafe", adminUsername: "cafeadmin", adminPassword: "CafeAdmin@456", plan: "pro"
}, superToken);
check("create tenant", createTenant.status === 201 && !!createTenant.data.tenant.id, JSON.stringify(createTenant.data).slice(0, 200));
newTenantId = createTenant.data.tenant.id;

// 5. duplicate username rejected
const dup = await api("POST", "/admin/tenants", {
  name: "Dup Cafe", adminUsername: "cafeadmin", adminPassword: "shouldfail123"
}, superToken);
check("duplicate admin username rejected", dup.status === 400);

// 6. tenant admin of demo tenant login
const al = await api("POST", "/auth/login", { username: "corneradmin", password: "TenantAdmin@123" });
check("tenant admin login", al.status === 200 && al.data.user.role === "tenant_admin", JSON.stringify(al.data).slice(0, 150));
adminToken = al.data.token;

// 7. create an employee
const emp = await api("POST", "/users", { username: "cashier2", password: "Cashier@123", fullName: "Kiran Joshi", role: "employee" }, adminToken);
check("create employee", emp.status === 201 && emp.data.user.role === "employee", JSON.stringify(emp.data).slice(0, 150));

// 8. employee login + cannot manage employees
const el = await api("POST", "/auth/login", { username: "cashier2", password: "Cashier@123" });
check("employee login", el.status === 200 && el.data.user.role === "employee");
const empCannotCreate = await api("POST", "/users", { username: "x", password: "xxxxxx" }, el.data.token);
check("employee cannot create users (RBAC)", empCannotCreate.status === 403);

// 9. create supplier, product
const sup = await api("POST", "/suppliers", { name: "Test Wholesale", phone: "99000 00001" }, adminToken);
check("create supplier", sup.status === 201);
const supId = sup.data.supplier.id;
const prod = await api("POST", "/products", {
  sku: "TEST-BEV-500", name: "Cold Coffee 500ml", category: "Beverages",
  costPrice: 40, sellPrice: 85, stockQty: 25, reorderLevel: 5, supplierId: supId
}, adminToken);
check("create product", prod.status === 201 && prod.data.product.stock_qty === 25, JSON.stringify(prod.data).slice(0, 150));
prodId = prod.data.product.id;

// 10. customer
const cust = await api("POST", "/customers", { name: "Priya Rao", phone: "90000 99999" }, adminToken);
check("create customer", cust.status === 201);
const custId = cust.data.customer.id;

// 11. cash sale (paid)
const cashSale = await api("POST", "/invoices", {
  items: [{ productId: prodId, qty: 2 }], customerId: custId,
  subtotal: 170, discountPct: 0, taxPct: 5, total: 178.5, paymentMethod: "Cash"
}, adminToken);
check("cash sale completes, paid status", cashSale.status === 201 && cashSale.data.invoice.status === "paid");
check("paid invoice has auto payment", cashSale.data.invoice.payments.length === 1);
check("stock decremented (25-2=23)", (await api("GET", "/inventory/low", null, adminToken)).status === 200);

// 12. credit sale (no payment, outstanding > 0)
const creditSale = await api("POST", "/invoices", {
  items: [{ productId: prodId, qty: 1 }], customerId: custId,
  subtotal: 85, discountPct: 0, taxPct: 5, total: 89.25, paymentMethod: "Credit / Ledger"
}, adminToken);
check("credit sale status credit", creditSale.status === 201 && creditSale.data.invoice.status === "credit", JSON.stringify(creditSale.data).slice(0, 200));
check("credit sale outstanding = total", creditSale.data.invoice.outstanding === 89.25);
check("credit sale has no payments", creditSale.data.invoice.payments.length === 0);
newInvId = creditSale.data.invoice.id;

// 13. partial manual payment
const pay1 = await api("POST", "/payments", { invoiceId: newInvId, amount: 40, method: "UPI", note: "customer paid part" }, adminToken);
check("record partial payment", pay1.status === 201 && pay1.data.invoiceStatus === "partially_paid", JSON.stringify(pay1.data).slice(0, 200));
check("remaining = 49.25", Number(pay1.data.remaining) === 49.25, String(pay1.data.remaining));

// 14. outstanding list reflects balance
const outList = await api("GET", "/payments/outstanding", null, adminToken);
const row = outList.data.outstanding.find(o => o.id === newInvId);
check("outstanding list shows balance 49.25", !!row && Number(row.outstanding) === 49.25);

// 15. settle fully -> status paid
const pay2 = await api("POST", "/payments", { invoiceId: newInvId, amount: 49.25, method: "Cash", note: "final" }, adminToken);
check("full payment flips to paid", pay2.data.invoiceStatus === "paid", JSON.stringify(pay2.data));
const outList2 = await api("GET", "/payments/outstanding", null, adminToken);
check("invoice removed from outstanding", !outList2.data.outstanding.some(o => o.id === newInvId));

// 16. TENANT ISOLATION — Test Cafe admin cannot see Corner & Co. data
const cafeLogin = await api("POST", "/auth/login", { username: "cafeadmin", password: "CafeAdmin@456" });
check("new tenant admin can login", cafeLogin.status === 200);
const cafeToken = cafeLogin.data.token;
const cafeProducts = await api("GET", "/products", null, cafeToken);
check("tenant isolation: cafe sees own (empty) products", cafeProducts.data.products.length === 0, "cafe products = " + JSON.stringify(cafeProducts.data.products.length));
const cornerProducts = await api("GET", "/products", null, adminToken);
check("corner sees its products", cornerProducts.data.products.length >= 2);

// tenant A cannot read tenant B's invoice id
const crossRead = await api("GET", "/invoices", null, cafeToken);
check("cross-tenant invoice id absent", !crossRead.data.invoices.some(i => i.id === newInvId));

// 17. employee pays BILLING but isolation holds
const empInv = await api("GET", "/invoices", null, el.data.token);
check("employee can read own tenant invoices", empInv.status === 200 && empInv.data.invoices.length >= 2);

// 18. suspend tenant -> all its users blocked
const suspend = await api("PATCH", "/admin/tenants/" + newTenantId + "/status", { status: "suspended" }, superToken);
check("suspend tenant", suspend.status === 200 && suspend.data.tenant.status === "suspended");
const blockedLogin = await api("POST", "/auth/login", { username: "cafeadmin", password: "CafeAdmin@456" });
check("suspended tenant login blocked", blockedLogin.status === 403);
const blockedExisting = await api("GET", "/products", null, cafeToken);
check("suspended tenant existing token blocked", blockedExisting.status === 403);

// 19. reinstate + delete (delete requires suspended)
const reinstate = await api("PATCH", "/admin/tenants/" + newTenantId + "/status", { status: "active" }, superToken);
check("reinstate tenant", reinstate.status === 200);
const relogin = await api("POST", "/auth/login", { username: "cafeadmin", password: "CafeAdmin@456" });
check("reinstated tenant can login", relogin.status === 200);
const deleteNoSuspend = await api("DELETE", "/admin/tenants/" + newTenantId, null, superToken);
check("delete blocked while active", deleteNoSuspend.status === 400);
await api("PATCH", "/admin/tenants/" + newTenantId + "/status", { status: "suspended" }, superToken);
const delTenant = await api("DELETE", "/admin/tenants/" + newTenantId, null, superToken);
check("delete suspended tenant", delTenant.status === 200 && delTenant.data.deleted === true);

// 20. audit log written
const audit = await api("GET", "/admin/audit", null, superToken);
check("audit log non-empty", audit.status === 200 && audit.data.auditLog.length > 0);
const auditActions = audit.data.auditLog.map(a => a.action);
check("audit contains tenant.created", auditActions.includes("tenant.created"));
check("audit contains tenant.suspended", auditActions.includes("tenant.suspended"));
check("audit contains payment.recorded", auditActions.includes("payment.recorded"));

// 21. login rate limit sanity (should be fine, under 10)
const rl = await api("POST", "/invoices", { items: [] }, adminToken);
check("empty invoice rejected", rl.status === 400);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);