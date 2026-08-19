/* =========================================================================
   LEDGER — Multi-tenant Shop Admin Platform (API-driven frontend)
   Roles:  super_admin (platform) | tenant_admin | employee
   All data is fetched from the backend API; no localStorage business data.
   ========================================================================= */

const TOKEN_KEY = "ledger_token";
const USER_KEY = "ledger_user";

/* API base: same-origin by default. When the frontend is hosted on Vercel and the
   API runs on Render, auto-switch to the Render API unless overridden manually. */
const API_BASE =
  (typeof window !== "undefined" && window.LEDGER_API_BASE) ||
  (typeof location !== "undefined" && location.hostname.endsWith("vercel.app") ? "https://ledger-api-ftow.onrender.com" : "") || "";

/* ---------------------------------------------------------------------- */
/* API client                                                             */
/* ---------------------------------------------------------------------- */
const API = {
  token: null,
  setToken(t) { this.token = t; t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); },

  async request(path, { method = "GET", body } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = "Bearer " + this.token;
    const res = await fetch(API_BASE + "/api" + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && this.token) { logout(true); throw new Error("Session expired — please sign in again."); }
      throw new Error(data.error || "Request failed");
    }
    return data;
  },
  get(p) { return this.request(p); },
  post(p, b) { return this.request(p, { method: "POST", body: b }); },
  patch(p, b) { return this.request(p, { method: "PATCH", body: b }); },
  del(p) { return this.request(p, { method: "DELETE" }); }
};

/* ---------------------------------------------------------------------- */
/* State & helpers                                                         */
/* ---------------------------------------------------------------------- */
const state = {
  user: JSON.parse(localStorage.getItem(USER_KEY) || "null"),
  page: "dashboard",
  products: [],
  suppliers: [],
  customers: [],
  invoices: [],
  cart: []
};

function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function money(n) { return "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) + " · " +
         d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}
function toast(msg, isErr = false) {
  const el = document.getElementById("appToast");
  el.textContent = msg;
  el.style.background = isErr ? "var(--rust)" : "var(--ink)";
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 3000);
}
function bsModal(id) { return bootstrap.Modal.getOrCreateInstance(document.getElementById(id)); }

const ROLE_LABEL = {
  super_admin: "Platform super admin",
  tenant_admin: "Tenant admin",
  employee: "Employee"
};

/* ---------------------------------------------------------------------- */
/* Auth                                                                   */
/* ---------------------------------------------------------------------- */
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("loginBtn");
  btn.disabled = true; btn.textContent = "Signing in…";
  try {
    const data = await API.post("/auth/login", {
      username: document.getElementById("loginUser").value.trim(),
      password: document.getElementById("loginPass").value
    });
    API.setToken(data.token);
    state.user = data.user;
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    enterApp();
  } catch (err) {
    document.getElementById("loginError").textContent = err.message;
    document.getElementById("loginError").classList.remove("d-none");
  } finally {
    btn.disabled = false; btn.textContent = "Sign in";
  }
});

function logout(silent = false) {
  API.setToken(null);
  localStorage.removeItem(USER_KEY);
  state.user = null;
  state.cart = [];
  document.getElementById("appShell").classList.add("d-none");
  document.getElementById("loginScreen").classList.remove("d-none");
  if (!silent) toast("Signed out.");
}
document.getElementById("logoutBtn").addEventListener("click", () => logout());

async function enterApp() {
  const u = state.user;
  API.token = localStorage.getItem(TOKEN_KEY) || null;
  document.getElementById("loginScreen").classList.add("d-none");
  document.getElementById("appShell").classList.remove("d-none");
  document.getElementById("adminName").textContent = u.fullName || u.username;
  document.getElementById("adminRole").textContent = ROLE_LABEL[u.role] || u.role;
  document.getElementById("adminAvatar").textContent = (u.fullName || u.username || "A").charAt(0).toUpperCase();
  document.getElementById("brandTenant").textContent = u.role === "super_admin" ? "Platform" : (u.tenantName || "Shop Admin");
  document.getElementById("footStoreName").textContent = u.role === "super_admin" ? "StoreFlow Platform" : (u.tenantName || "Shop");
  document.getElementById("receiptStoreName").textContent = u.tenantName || "Shop";

  // Role-based navigation
  document.querySelectorAll(".nav-item").forEach(el => {
    const r = el.dataset.role || "all";
    const show = r === "all" ||
      (r === "tenant" && u.role !== "super_admin") ||
      (r === "tenantadmin" && u.role === "tenant_admin") ||
      (r === "super" && u.role === "super_admin");
    el.classList.toggle("d-none", !show);
  });

  goToPage(u.role === "super_admin" ? "platform" : "dashboard");
}

if (state.user && localStorage.getItem(TOKEN_KEY)) {
  API.token = localStorage.getItem(TOKEN_KEY);
  enterApp();
}

/* ---------------------------------------------------------------------- */
/* Navigation                                                              */
/* ---------------------------------------------------------------------- */
const PAGE_META = {
  dashboard: ["Dashboard", "Today at a glance"],
  platform: ["Platform dashboard", "Whole-platform overview"],
  billing: ["Billing / Sell", "Ring up a sale"],
  products: ["Products", "Manage what the shop stocks and sells"],
  inventory: ["Inventory", "Stock check, reorder alerts and adjustments"],
  suppliers: ["Suppliers", "Who you buy stock from"],
  customers: ["Customers", "Who buys from the shop"],
  invoices: ["Invoices", "Every sale ever billed"],
  payments: ["Payments", "Manual payment & credit tracking"],
  employees: ["Employees", "Manage staff access"],
  tenants: ["Tenants", "Create, revoke & delete tenants"],
  audit: ["Audit log", "Security-sensitive actions"]
};

function goToPage(page) {
  state.page = page;
  document.querySelectorAll(".page").forEach(p => p.classList.add("d-none"));
  document.getElementById("page-" + page).classList.remove("d-none");
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  const meta = PAGE_META[page];
  if (meta) {
    document.getElementById("pageTitle").textContent = meta[0];
    document.getElementById("pageSubtitle").textContent = meta[1];
  }
  document.getElementById("globalSearchResults").classList.add("d-none");
  document.getElementById("globalSearch").value = "";
  document.querySelector(".sidebar")?.classList.remove("open");

  const u = state.user;
  if (page === "dashboard") renderDashboard();
  if (page === "platform") renderPlatform();
  if (page === "billing") renderPOS();
  if (page === "products") renderProducts();
  if (page === "inventory") renderInventory();
  if (page === "suppliers") renderSuppliers();
  if (page === "customers") renderCustomers();
  if (page === "invoices") renderInvoices();
  if (page === "payments") renderPayments();
  if (page === "employees") renderEmployees();
  if (page === "tenants") renderTenants();
  if (page === "audit") renderAudit();
}

document.querySelectorAll("[data-page]").forEach(el => {
  el.addEventListener("click", () => {
    const page = el.dataset.page;
    if (document.getElementById("page-" + page)) goToPage(page);
  });
});

/* ---------------------------------------------------------------------- */
/* Tenant dashboard                                                        */
/* ---------------------------------------------------------------------- */
async function renderDashboard() {
  try {
    const d = await API.get("/dashboard");
    const s = d.stats;
    document.getElementById("statProducts").textContent = s.products;
    document.getElementById("statCustomers").textContent = s.customers;
    document.getElementById("statTodaySales").textContent = money(s.todaySales);
    document.getElementById("statTodayCount").textContent = s.todayInvoices + " invoice" + (s.todayInvoices === 1 ? "" : "s") + " raised";
    document.getElementById("statLowStock").textContent = s.lowStock;

    const recent = document.getElementById("dashRecentInvoices");
    recent.innerHTML = d.recentInvoices.length ? d.recentInvoices.map(inv => `
      <tr>
        <td class="mono">${escapeHtml(inv.invoice_no)}</td>
        <td>${escapeHtml(inv.customer_name)}</td>
        <td>${inv.item_count}</td>
        <td class="cell-strong">${money(inv.total)}</td>
        <td>${fmtDate(inv.created_at)}</td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="5">No sales billed yet — head to Billing / Sell.</td></tr>`;

    const low = document.getElementById("dashLowStock");
    low.innerHTML = d.lowStockList.length ? d.lowStockList.map(p => `
      <tr><td class="cell-strong">${escapeHtml(p.name)}</td><td>${p.stock_qty}</td><td>${p.reorder_level}</td></tr>`
    ).join("") : `<tr class="empty-row"><td colspan="3">Everything is comfortably stocked.</td></tr>`;

    const out = document.getElementById("dashOutstanding");
    out.innerHTML = d.creditList.length ? d.creditList.map(i => `
      <tr>
        <td class="mono">${escapeHtml(i.invoice_no)}</td>
        <td>${escapeHtml(i.customer_name)}</td>
        <td>${money(i.total)}</td>
        <td>${money(i.paid)}</td>
        <td class="cell-strong">${money(Number(i.total) - Number(i.paid))}</td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="5">No credit / outstanding invoices.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}

/* ---------------------------------------------------------------------- */
/* Platform dashboard (super admin)                                        */
/* ---------------------------------------------------------------------- */
async function renderPlatform() {
  try {
    const { tenants } = await API.get("/admin/tenants");
    const active = tenants.filter(t => t.status === "active");
    const suspended = tenants.filter(t => t.status === "suspended");
    const revenue = tenants.reduce((s, t) => s + Number(t.revenue), 0);
    const users = tenants.reduce((s, t) => s + Number(t.user_count), 0);

    document.getElementById("pTenants").textContent = active.length;
    document.getElementById("pRevenue").textContent = money(revenue);
    document.getElementById("pSuspended").textContent = suspended.length;
    document.getElementById("pUsers").textContent = users;

    document.getElementById("pTenantsBody").innerHTML = tenants.length ? tenants.map(t => `
      <tr>
        <td class="cell-strong">${escapeHtml(t.name)}</td>
        <td>${statusTag(t.status)}</td>
        <td>${escapeHtml(t.plan)}</td>
        <td>${t.user_count}</td>
        <td>${t.invoice_count}</td>
        <td class="cell-strong">${money(t.revenue)}</td>
        <td>${fmtDate(t.created_at)}</td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="7">No tenants yet — create one from the Tenants page.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}

/* ---------------------------------------------------------------------- */
/* Products                                                               */
/* ---------------------------------------------------------------------- */
async function loadProducts() {
  const data = await API.get("/products");
  state.products = data.products;
}
async function loadSuppliers() {
  const data = await API.get("/suppliers");
  state.suppliers = data.suppliers;
}
async function loadCustomers() {
  const data = await API.get("/customers");
  state.customers = data.customers;
}
async function loadInvoices() {
  const data = await API.get("/invoices");
  state.invoices = data.invoices;
}

async function renderProducts(filter = "") {
  try {
    if (!state.products.length) await loadProducts();
    const q = filter.trim().toLowerCase();
    const rows = state.products.filter(p => !q ||
      p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
    document.getElementById("productsTableBody").innerHTML = rows.length ? rows.map(p => `
      <tr>
        <td class="mono">${escapeHtml(p.sku)}</td>
        <td class="cell-strong">${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.category)}</td>
        <td class="mono">${money(p.cost_price)}</td>
        <td class="mono">${money(p.sell_price)}</td>
        <td>${p.stock_qty}</td>
        <td>${escapeHtml(p.supplier_name || "—")}</td>
        <td class="text-nowrap">
          <button class="icon-btn" onclick="editProduct('${p.id}')">Edit</button>
          <button class="icon-btn danger" onclick="deleteProduct('${p.id}')">Delete</button>
        </td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="8">No products match that filter.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}
document.getElementById("productFilter").addEventListener("input", e => renderProducts(e.target.value));

document.getElementById("addProductBtn").addEventListener("click", async () => {
  document.getElementById("productForm").reset();
  document.getElementById("productId").value = "";
  document.getElementById("productModalTitle").textContent = "Add product";
  document.getElementById("productReorder").value = 5;
  await populateSupplierSelect();
  bsModal("productModal").show();
});

async function populateSupplierSelect() {
  await loadSuppliers();
  const sel = document.getElementById("productSupplier");
  sel.innerHTML = `<option value="">— None —</option>` + state.suppliers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}

function editProduct(id) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;
  document.getElementById("productModalTitle").textContent = "Edit product";
  document.getElementById("productId").value = p.id;
  document.getElementById("productName").value = p.name;
  document.getElementById("productSku").value = p.sku;
  document.getElementById("productCategory").value = p.category;
  document.getElementById("productSupplier").value = p.supplier_id || "";
  document.getElementById("productCost").value = p.cost_price;
  document.getElementById("productPrice").value = p.sell_price;
  document.getElementById("productStock").value = p.stock_qty;
  document.getElementById("productReorder").value = p.reorder_level;
  document.getElementById("productImage").value = p.image_url || "";
  document.getElementById("productDescription").value = p.description || "";
  bsModal("productModal").show();
}

async function deleteProduct(id) {
  if (!confirm("Remove this product? This can't be undone.")) return;
  try {
    await API.del("/products/" + id);
    state.products = state.products.filter(p => p.id !== id);
    toast("Product removed.");
  } catch (e) { toast(e.message, true); }
}

document.getElementById("productForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("productId").value;
  const data = {
    name: document.getElementById("productName").value.trim(),
    sku: document.getElementById("productSku").value.trim(),
    category: document.getElementById("productCategory").value.trim(),
    supplierId: document.getElementById("productSupplier").value || null,
    costPrice: parseFloat(document.getElementById("productCost").value) || 0,
    sellPrice: parseFloat(document.getElementById("productPrice").value) || 0,
    stockQty: parseInt(document.getElementById("productStock").value) || 0,
    reorderLevel: parseInt(document.getElementById("productReorder").value) || 0,
    imageUrl: document.getElementById("productImage").value.trim(),
    description: document.getElementById("productDescription").value.trim()
  };
  try {
    if (id) { await API.patch("/products/" + id, data); toast("Product updated."); }
    else { await API.post("/products", data); toast("Product added."); }
    state.products = [];
    bsModal("productModal").hide();
    renderProducts(document.getElementById("productFilter").value);
  } catch (err) { toast(err.message, true); }
});

/* ---------------------------------------------------------------------- */
/* Inventory                                                              */
/* ---------------------------------------------------------------------- */
function stockTag(p) {
  if (p.stock_qty <= 0) return `<span class="tag tag-out">Out of stock</span>`;
  if (p.stock_qty <= p.reorder_level) return `<span class="tag tag-low">Low stock</span>`;
  return `<span class="tag tag-ok">Healthy</span>`;
}

async function renderInventory(filter = "") {
  try {
    if (!state.products.length) await loadProducts();
    const q = filter.trim().toLowerCase();
    const rows = state.products.filter(p => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    document.getElementById("inventoryTableBody").innerHTML = rows.length ? rows.map(p => `
      <tr>
        <td class="mono">${escapeHtml(p.sku)}</td>
        <td class="cell-strong">${escapeHtml(p.name)}</td>
        <td>${p.stock_qty}</td>
        <td>${p.reorder_level}</td>
        <td>${stockTag(p)}</td>
        <td><button class="icon-btn" onclick="openStockModal('${p.id}')">Adjust</button></td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="6">No products match that filter.</td></tr>`;

    const logData = await API.get("/inventory/log");
    document.getElementById("inventoryLogBody").innerHTML = logData.logs.length ? logData.logs.map(l => `
      <tr>
        <td>${fmtDate(l.created_at)}</td>
        <td>${escapeHtml(l.product_name)}</td>
        <td style="color:${l.change_qty < 0 ? "var(--rust)" : "var(--green)"}; font-weight:600;">${l.change_qty > 0 ? "+" : ""}${l.change_qty}</td>
        <td>${escapeHtml(l.reason)}</td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="4">No stock movements logged yet.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}
document.getElementById("inventoryFilter").addEventListener("input", e => renderInventory(e.target.value));

function openStockModal(id) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;
  document.getElementById("stockProductId").value = id;
  document.getElementById("stockProductLabel").innerHTML = `<strong>${escapeHtml(p.name)}</strong> — currently <strong>${p.stock_qty}</strong> in stock.`;
  document.getElementById("stockChange").value = "";
  bsModal("stockModal").show();
}

document.getElementById("stockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("stockProductId").value;
  const change = parseInt(document.getElementById("stockChange").value);
  if (!id || isNaN(change) || change === 0) return;
  try {
    await API.post("/inventory/adjust", {
      productId: id,
      changeQty: change,
      reason: document.getElementById("stockReason").value
    });
    state.products = [];
    bsModal("stockModal").hide();
    renderInventory(document.getElementById("inventoryFilter").value);
    toast("Stock updated.");
  } catch (err) { toast(err.message, true); }
});

/* ---------------------------------------------------------------------- */
/* Suppliers                                                              */
/* ---------------------------------------------------------------------- */
async function renderSuppliers(filter = "") {
  try {
    if (!state.suppliers.length) await loadSuppliers();
    const q = filter.trim().toLowerCase();
    const rows = state.suppliers.filter(s => !q || s.name.toLowerCase().includes(q) || (s.contact_person || "").toLowerCase().includes(q));
    document.getElementById("suppliersTableBody").innerHTML = rows.length ? rows.map(s => `
      <tr>
        <td class="cell-strong">${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.contact_person || "—")}</td>
        <td class="mono">${escapeHtml(s.phone)}</td>
        <td>${escapeHtml(s.email || "—")}</td>
        <td>${s.product_count} product${s.product_count === 1 ? "" : "s"}</td>
        <td class="text-nowrap">
          <button class="icon-btn" onclick="editSupplier('${s.id}')">Edit</button>
          <button class="icon-btn danger" onclick="deleteSupplier('${s.id}')">Delete</button>
        </td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="6">No suppliers match that filter.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}
document.getElementById("supplierFilter").addEventListener("input", e => renderSuppliers(e.target.value));

document.getElementById("addSupplierBtn").addEventListener("click", () => {
  document.getElementById("supplierForm").reset();
  document.getElementById("supplierId").value = "";
  document.getElementById("supplierModalTitle").textContent = "Add supplier";
  bsModal("supplierModal").show();
});

function editSupplier(id) {
  const s = state.suppliers.find(x => x.id === id);
  if (!s) return;
  document.getElementById("supplierModalTitle").textContent = "Edit supplier";
  document.getElementById("supplierId").value = s.id;
  document.getElementById("supplierName").value = s.name;
  document.getElementById("supplierContact").value = s.contact_person || "";
  document.getElementById("supplierPhone").value = s.phone;
  document.getElementById("supplierEmail").value = s.email || "";
  document.getElementById("supplierGst").value = s.gstin || "";
  document.getElementById("supplierAddress").value = s.address || "";
  bsModal("supplierModal").show();
}

async function deleteSupplier(id) {
  const inUse = state.products.some(p => p.supplier_id === id);
  if (!confirm(inUse ? "Products still reference this supplier. Delete anyway?" : "Remove this supplier?")) return;
  try {
    await API.del("/suppliers/" + id);
    state.suppliers = state.suppliers.filter(s => s.id !== id);
    toast("Supplier removed.");
  } catch (e) { toast(e.message, true); }
}

document.getElementById("supplierForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("supplierId").value;
  const data = {
    name: document.getElementById("supplierName").value.trim(),
    contactPerson: document.getElementById("supplierContact").value.trim(),
    phone: document.getElementById("supplierPhone").value.trim(),
    email: document.getElementById("supplierEmail").value.trim(),
    gstin: document.getElementById("supplierGst").value.trim(),
    address: document.getElementById("supplierAddress").value.trim()
  };
  try {
    if (id) { await API.patch("/suppliers/" + id, data); toast("Supplier updated."); }
    else { await API.post("/suppliers", data); toast("Supplier added."); }
    state.suppliers = [];
    bsModal("supplierModal").hide();
    renderSuppliers(document.getElementById("supplierFilter").value);
  } catch (err) { toast(err.message, true); }
});

/* ---------------------------------------------------------------------- */
/* Customers                                                              */
/* ---------------------------------------------------------------------- */
async function renderCustomers(filter = "") {
  try {
    if (!state.customers.length) await loadCustomers();
    const q = filter.trim().toLowerCase();
    const rows = state.customers.filter(c => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q));
    document.getElementById("customersTableBody").innerHTML = rows.length ? rows.map(c => `
      <tr>
        <td class="cell-strong">${escapeHtml(c.name)}</td>
        <td class="mono">${escapeHtml(c.phone)}</td>
        <td>${escapeHtml(c.email || "—")}</td>
        <td class="mono">${money(c.total_spent)}</td>
        <td>${c.order_count}</td>
        <td class="text-nowrap">
          <button class="icon-btn" onclick="editCustomer('${c.id}')">Edit</button>
          <button class="icon-btn danger" onclick="deleteCustomer('${c.id}')">Delete</button>
        </td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="6">No customers match that filter.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}
document.getElementById("customerFilter").addEventListener("input", e => renderCustomers(e.target.value));

document.getElementById("addCustomerBtn").addEventListener("click", () => {
  document.getElementById("customerForm").reset();
  document.getElementById("customerId").value = "";
  document.getElementById("customerModalTitle").textContent = "Add customer";
  bsModal("customerModal").show();
});

function editCustomer(id) {
  const c = state.customers.find(x => x.id === id);
  if (!c) return;
  document.getElementById("customerModalTitle").textContent = "Edit customer";
  document.getElementById("customerId").value = c.id;
  document.getElementById("customerName").value = c.name;
  document.getElementById("customerPhone").value = c.phone;
  document.getElementById("customerEmail").value = c.email || "";
  document.getElementById("customerAddress").value = c.address || "";
  bsModal("customerModal").show();
}

async function deleteCustomer(id) {
  if (!confirm("Remove this customer?")) return;
  try {
    await API.del("/customers/" + id);
    state.customers = state.customers.filter(c => c.id !== id);
    toast("Customer removed.");
  } catch (e) { toast(e.message, true); }
}

document.getElementById("customerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("customerId").value;
  const data = {
    name: document.getElementById("customerName").value.trim(),
    phone: document.getElementById("customerPhone").value.trim(),
    email: document.getElementById("customerEmail").value.trim(),
    address: document.getElementById("customerAddress").value.trim()
  };
  try {
    if (id) { await API.patch("/customers/" + id, data); toast("Customer updated."); }
    else { await API.post("/customers", data); toast("Customer added."); }
    state.customers = [];
    bsModal("customerModal").hide();
    renderCustomers(document.getElementById("customerFilter").value);
  } catch (err) { toast(err.message, true); }
});

/* ---------------------------------------------------------------------- */
/* Invoices                                                               */
/* ---------------------------------------------------------------------- */
function invStatusTag(s) {
  const map = { paid: "tag-ok", credit: "tag-low", partially_paid: "tag-low", void: "tag-out" };
  return `<span class="tag ${map[s] || "tag-low"}">${escapeHtml(String(s || "paid").replace(/_/g, " "))}</span>`;
}

async function renderInvoices(filter = "") {
  try {
    if (!state.invoices.length) await loadInvoices();
    const q = filter.trim().toLowerCase();
    const rows = [...state.invoices]
      .filter(i => !q || i.invoice_no.toLowerCase().includes(q) || i.customer_name.toLowerCase().includes(q));
    document.getElementById("invoicesTableBody").innerHTML = rows.length ? rows.map(i => `
      <tr>
        <td class="mono">${escapeHtml(i.invoice_no)}</td>
        <td>${escapeHtml(i.customer_name)}</td>
        <td>${i.item_count ?? "—"}</td>
        <td>${escapeHtml(i.payment_method)}</td>
        <td>${invStatusTag(i.status)}</td>
        <td class="cell-strong">${money(i.total)}</td>
        <td>${money(i.paid)}</td>
        <td style="color:${Number(i.outstanding) > 0 ? "var(--rust)" : "var(--green)"}; font-weight:600;">${money(i.outstanding)}</td>
        <td>${fmtDate(i.created_at)}</td>
        <td class="text-nowrap">
          <button class="icon-btn" onclick="viewInvoice('${i.id}')">View</button>
          ${Number(i.outstanding) > 0 ? `<button class="icon-btn" onclick="openPaymentModal('${i.id}')">Pay</button>` : ""}
        </td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="10">No invoices billed yet.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}
document.getElementById("invoiceFilter").addEventListener("input", e => renderInvoices(e.target.value));

async function viewInvoice(id) {
  try {
    const { invoice } = await API.get("/invoices/" + id);
    renderInvoicePreview(invoice);
    bsModal("invoiceModal").show();
  } catch (e) { toast(e.message, true); }
}

function renderInvoicePreview(inv) {
  const html = `
    <div class="print-invoice" id="printArea">
      <h4>${escapeHtml(state.user.tenantName || "Shop")}</h4>
      <div class="pi-sub">Tax Invoice</div>
      <div class="pi-meta"><span>Invoice</span><span>${escapeHtml(inv.invoice_no)}</span></div>
      <div class="pi-meta"><span>Date</span><span>${fmtDate(inv.created_at)}</span></div>
      <div class="pi-meta"><span>Customer</span><span>${escapeHtml(inv.customer_name)}</span></div>
      <div class="pi-meta"><span>Payment</span><span>${escapeHtml(inv.payment_method)}</span></div>
      <div class="pi-meta"><span>Status</span><span>${escapeHtml(inv.status)}</span></div>
      <table>
        <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amt</th></tr></thead>
        <tbody>
          ${inv.items.map(it => `<tr><td>${escapeHtml(it.product_name)}</td><td>${it.qty}</td><td>${money(it.unit_price)}</td><td>${money(it.line_total)}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="pi-meta"><span>Subtotal</span><span>${money(inv.subtotal)}</span></div>
      <div class="pi-meta"><span>Discount (${inv.discount_pct}%)</span><span>-${money(inv.subtotal * inv.discount_pct / 100)}</span></div>
      <div class="pi-meta"><span>Tax (${inv.tax_pct}%)</span><span>+${money((inv.subtotal - inv.subtotal * inv.discount_pct / 100) * inv.tax_pct / 100)}</span></div>
      <div class="pi-total-row"><span>Total</span><span>${money(inv.total)}</span></div>
      <div class="pi-meta"><span>Paid</span><span>${money(inv.paid)}</span></div>
      <div class="pi-total-row"><span>Balance</span><span>${money(inv.outstanding)}</span></div>
      ${inv.payments?.length ? `<table><thead><tr><th>Payment</th><th>Method</th><th>Amount</th><th>Date</th></tr></thead>
        <tbody>${inv.payments.map(p => `<tr><td>${escapeHtml(p.method)}</td><td>${escapeHtml(p.note || "")}</td><td>${money(p.amount)}</td><td>${fmtDate(p.paid_at)}</td></tr>`).join("")}</tbody></table>` : ""}
    </div>
    <div class="modal-footer">
      <button type="button" class="btn-ghost" data-bs-dismiss="modal">Close</button>
      <button type="button" class="btn-brass" onclick="printInvoice()">Print</button>
    </div>`;
  document.getElementById("invoicePreviewContent").innerHTML = html;
}

function printInvoice() {
  const content = document.getElementById("printArea").innerHTML;
  const w = window.open("", "_blank", "width=420,height=650");
  w.document.write(`<html><head><title>Invoice</title>
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
    <style>
      body{font-family:'JetBrains Mono',monospace;padding:20px;color:#0E1420;}
      h4{font-family:'Sora',sans-serif;font-weight:700;text-align:center;margin-bottom:0;}
      .pi-sub{text-align:center;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6B7686;margin-bottom:16px;}
      table{width:100%;font-size:12px;border-collapse:collapse;margin:14px 0;}
      th{text-align:left;border-bottom:1px solid #0E1420;font-size:10.5px;text-transform:uppercase;}
      td{padding:5px 2px;border-bottom:1px dashed #E5E8ED;}
      .pi-meta{display:flex;justify-content:space-between;font-size:11.5px;color:#6B7686;margin-bottom:4px;}
      .pi-total-row{display:flex;justify-content:space-between;font-size:14px;font-weight:700;border-top:1px solid #0E1420;padding-top:8px;margin-top:6px;}
    </style></head><body>${content}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

/* ---------------------------------------------------------------------- */
/* POS billing                                                            */
/* ---------------------------------------------------------------------- */
async function renderPOS() {
  try {
    if (!state.products.length) await loadProducts();
    if (!state.customers.length) await loadCustomers();
    const sel = document.getElementById("posCustomerSelect");
    const current = sel.value;
    sel.innerHTML = `<option value="">Walk-in customer</option>` +
      state.customers.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    sel.value = current;
    renderPosGrid(document.getElementById("posSearch").value);
    renderCart();
  } catch (e) { toast(e.message, true); }
}

function renderPosGrid(filter = "") {
  const q = filter.trim().toLowerCase();
  const grid = document.getElementById("posProductGrid");
  const items = state.products.filter(p => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
  grid.innerHTML = items.length ? items.map(p => `
    <div class="pos-card ${p.stock_qty <= 0 ? "out-of-stock" : ""}" onclick="${p.stock_qty > 0 ? `addToCart('${p.id}')` : ""}">
      <div class="pos-card-img">${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="">` : "No image"}</div>
      <div class="pos-card-name">${escapeHtml(p.name)}</div>
      <div class="pos-card-meta">${p.stock_qty > 0 ? p.stock_qty + " in stock" : "Out of stock"}</div>
      <div class="pos-card-price">${money(p.sell_price)}</div>
    </div>`).join("") : `<p class="receipt-empty">No products match that search.</p>`;
}
document.getElementById("posSearch").addEventListener("input", e => renderPosGrid(e.target.value));

function productById(id) { return state.products.find(p => p.id === id); }

function addToCart(id) {
  const p = productById(id);
  if (!p || p.stock_qty <= 0) return;
  const line = state.cart.find(c => c.productId === id);
  const currentQty = line ? line.qty : 0;
  if (currentQty >= p.stock_qty) { toast("No more stock available for " + p.name); return; }
  if (line) line.qty++;
  else state.cart.push({ productId: id, qty: 1 });
  renderCart();
}

function changeQty(id, delta) {
  const line = state.cart.find(c => c.productId === id);
  if (!line) return;
  const p = productById(id);
  line.qty += delta;
  if (line.qty <= 0) state.cart = state.cart.filter(c => c.productId !== id);
  else if (p && line.qty > p.stock_qty) line.qty = p.stock_qty;
  renderCart();
}
function removeFromCart(id) { state.cart = state.cart.filter(c => c.productId !== id); renderCart(); }

function cartTotals() {
  const subtotal = state.cart.reduce((s, c) => { const p = productById(c.productId); return s + (p ? p.sell_price * c.qty : 0); }, 0);
  const discountPct = parseFloat(document.getElementById("posDiscount").value) || 0;
  const taxPct = parseFloat(document.getElementById("posTax").value) || 0;
  const afterDiscount = subtotal - subtotal * discountPct / 100;
  const total = afterDiscount + afterDiscount * taxPct / 100;
  return { subtotal, discountPct, taxPct, total };
}

function renderCart() {
  const wrap = document.getElementById("posCartLines");
  wrap.innerHTML = state.cart.length ? state.cart.map(c => {
    const p = productById(c.productId);
    if (!p) return "";
    return `
      <div class="receipt-line">
        <div class="receipt-line-name">
          ${escapeHtml(p.name)}
          <div class="receipt-line-sub">
            <button type="button" class="qty-btn" onclick="changeQty('${p.id}',-1)">&minus;</button>
            ${c.qty}
            <button type="button" class="qty-btn" onclick="changeQty('${p.id}',1)">+</button>
            <span>&times; ${money(p.sell_price)}</span>
          </div>
        </div>
        <div>
          <div class="receipt-line-amt">${money(p.sell_price * c.qty)}</div>
          <button type="button" class="receipt-line-remove" onclick="removeFromCart('${p.id}')">remove</button>
        </div>
      </div>`;
  }).join("") : `<p class="receipt-empty">No items yet — tap a product to add it.</p>`;

  const t = cartTotals();
  document.getElementById("posSubtotal").textContent = money(t.subtotal);
  document.getElementById("posTotal").textContent = money(t.total);
}
document.getElementById("posDiscount").addEventListener("input", renderCart);
document.getElementById("posTax").addEventListener("input", renderCart);
document.getElementById("posClear").addEventListener("click", () => { state.cart = []; renderCart(); });

document.getElementById("posCharge").addEventListener("click", async () => {
  if (!state.cart.length) { toast("Add at least one product to the ticket."); return; }
  const btn = document.getElementById("posCharge");
  btn.disabled = true;
  const t = cartTotals();
  try {
    const payload = {
      items: state.cart.map(c => ({ productId: c.productId, qty: c.qty })),
      customerId: document.getElementById("posCustomerSelect").value || null,
      subtotal: t.subtotal,
      discountPct: t.discountPct,
      taxPct: t.taxPct,
      total: t.total,
      paymentMethod: document.getElementById("posPayment").value
    };
    const { invoice } = await API.post("/invoices", payload);
    state.cart = [];
    state.invoices = [];
    document.getElementById("posDiscount").value = 0;
    document.getElementById("posCustomerSelect").value = "";
    await loadProducts();
    renderPosGrid(document.getElementById("posSearch").value);
    renderCart();
    renderInvoicePreview(invoice);
    bsModal("invoiceModal").show();
    toast("Sale completed — " + invoice.invoice_no);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------------------------------------------------------------- */
/* Payments — manual payment tracking                                      */
/* ---------------------------------------------------------------------- */
async function renderPayments() {
  try {
    const { outstanding, totalOutstanding } = await API.get("/payments/outstanding");
    const { payments } = await API.get("/payments");

    const out = document.getElementById("outstandingTableBody");
    out.innerHTML = outstanding.length ? outstanding.map(i => `
      <tr>
        <td class="mono">${escapeHtml(i.invoice_no)}</td>
        <td class="cell-strong">${escapeHtml(i.customer_name)}</td>
        <td>${escapeHtml(i.customer_phone || "—")}</td>
        <td>${fmtDate(i.created_at)}</td>
        <td>${money(i.total)}</td>
        <td>${money(i.paid)}</td>
        <td style="color:var(--rust); font-weight:600;">${money(i.outstanding)}</td>
        <td><button class="icon-btn" onclick="openPaymentModal('${i.id}')">Record payment</button></td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="8">No outstanding balances — all invoices settled.</td></tr>`;

    const pay = document.getElementById("paymentsTableBody");
    pay.innerHTML = payments.length ? payments.map(p => `
      <tr>
        <td>${fmtDate(p.paid_at)}</td>
        <td class="mono">${escapeHtml(p.invoice_no)}</td>
        <td>${escapeHtml(p.method)}</td>
        <td class="cell-strong">${money(p.amount)}</td>
        <td>${escapeHtml(p.received_by_name || p.received_by || "—")}</td>
        <td>${escapeHtml(p.note || "—")}</td>
        <td><button class="icon-btn danger" onclick="voidPayment('${p.id}')">Void</button></td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="7">No payments recorded yet.</td></tr>`;

    if (totalOutstanding > 0) {
      toast(`Total outstanding across credit sales: ${money(totalOutstanding)}`);
    }
  } catch (e) { toast(e.message, true); }
}

function openPaymentModal(invoiceId) {
  const inv = state.invoices.find(i => i.id === invoiceId) ||
    { invoice_no: invoiceId, total: 0, outstanding: 0, customer_name: "" };
  document.getElementById("paymentInvoiceId").value = invoiceId;
  document.getElementById("paymentInvoiceLabel").innerHTML =
    `<strong>Invoice ${escapeHtml(inv.invoice_no)}</strong> — ${escapeHtml(inv.customer_name || "")}<br>
     Balance due: <strong>${money(inv.outstanding ?? inv.total)}</strong>`;
  document.getElementById("paymentAmount").value = "";
  document.getElementById("paymentNote").value = "";
  bsModal("paymentModal").show();
}

document.getElementById("paymentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const invoiceId = document.getElementById("paymentInvoiceId").value;
  try {
    await API.post("/payments", {
      invoiceId,
      amount: parseFloat(document.getElementById("paymentAmount").value),
      method: document.getElementById("paymentMethod").value,
      note: document.getElementById("paymentNote").value.trim()
    });
    bsModal("paymentModal").hide();
    state.invoices = [];
    renderPayments();
    toast("Payment recorded.");
  } catch (err) { toast(err.message, true); }
});

async function voidPayment(id) {
  if (!confirm("Void this payment? The invoice balance will be recalculated.")) return;
  try {
    await API.del("/payments/" + id);
    state.invoices = [];
    renderPayments();
    toast("Payment voided.");
  } catch (e) { toast(e.message, true); }
}

/* ---------------------------------------------------------------------- */
/* Employees (tenant admin)                                                */
/* ---------------------------------------------------------------------- */
async function renderEmployees() {
  try {
    const { users } = await API.get("/users");
    document.getElementById("employeesTableBody").innerHTML = users.length ? users.map(u => `
      <tr>
        <td class="cell-strong">${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.full_name || "—")}</td>
        <td>${escapeHtml(u.email || "—")}</td>
        <td>${escapeHtml(u.role.replace("_", " "))}</td>
        <td>${u.is_active ? `<span class="tag tag-ok">Active</span>` : `<span class="tag tag-out">Deactivated</span>`}</td>
        <td>${u.last_login_at ? fmtDate(u.last_login_at) : "Never"}</td>
        <td class="text-nowrap">
          <button class="icon-btn" onclick="editEmployee('${u.id}')">Edit</button>
          <button class="icon-btn danger" onclick="deleteEmployee('${u.id}','${escapeHtml(u.username)}')">Delete</button>
        </td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="7">No employees yet — add one to give staff access.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}

document.getElementById("addEmployeeBtn").addEventListener("click", () => {
  document.getElementById("employeeForm").reset();
  document.getElementById("employeeId").value = "";
  document.getElementById("employeeModalTitle").textContent = "Add employee";
  document.getElementById("employeePassLabel").textContent = "Password";
  document.getElementById("employeeActive").value = "true";
  document.getElementById("employeeRole").value = "employee";
  document.getElementById("employeePassword").required = true;
  document.getElementById("employeePassword").disabled = false;
  bsModal("employeeModal").show();
});

function editEmployee(id) {
  // need the row data — refetch
  API.get("/users").then(({ users }) => {
    const u = users.find(x => x.id === id);
    if (!u) return;
    document.getElementById("employeeModalTitle").textContent = "Edit " + u.username;
    document.getElementById("employeeId").value = u.id;
    document.getElementById("employeeUsername").value = u.username;
    document.getElementById("employeeUsername").disabled = true;
    document.getElementById("employeeName").value = u.full_name || "";
    document.getElementById("employeeEmail").value = u.email || "";
    document.getElementById("employeeRole").value = u.role;
    document.getElementById("employeeActive").value = String(u.is_active);
    document.getElementById("employeePassLabel").textContent = "New password (leave blank to keep)";
    document.getElementById("employeePassword").required = false;
    document.getElementById("employeePassword").disabled = false;
    bsModal("employeeModal").show();
  }).catch(e => toast(e.message, true));
}

document.getElementById("employeeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("employeeId").value;
  const username = document.getElementById("employeeUsername").value.trim();
  const password = document.getElementById("employeePassword").value;
  const data = {
    username,
    fullName: document.getElementById("employeeName").value.trim(),
    email: document.getElementById("employeeEmail").value.trim(),
    role: document.getElementById("employeeRole").value,
    isActive: document.getElementById("employeeActive").value === "true"
  };
  if (password) data.password = password;
  try {
    if (id) { await API.patch("/users/" + id, data); toast("Employee updated."); }
    else { await API.post("/users", data); toast("Employee added."); }
    bsModal("employeeModal").hide();
    document.getElementById("employeeUsername").disabled = false;
    renderEmployees();
  } catch (err) { toast(err.message, true); }
});

async function deleteEmployee(id, username) {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  try {
    await API.del("/users/" + id);
    renderEmployees();
    toast("Employee deleted.");
  } catch (e) { toast(e.message, true); }
}

/* ---------------------------------------------------------------------- */
/* Tenants (super admin)                                                   */
/* ---------------------------------------------------------------------- */
function statusTag(s) {
  const map = { active: "tag-ok", suspended: "tag-low", deleted: "tag-out" };
  return `<span class="tag ${map[s] || "tag-low"}">${escapeHtml(s)}</span>`;
}

async function renderTenants() {
  try {
    const { tenants } = await API.get("/admin/tenants");
    document.getElementById("tenantsTableBody").innerHTML = tenants.length ? tenants.map(t => `
      <tr>
        <td class="cell-strong">${escapeHtml(t.name)}</td>
        <td class="mono">${escapeHtml(t.slug)}</td>
        <td>${escapeHtml(t.plan)}</td>
        <td>${statusTag(t.status)}</td>
        <td>${t.user_count}</td>
        <td>${t.invoice_count}</td>
        <td>${money(t.revenue)}</td>
        <td>${fmtDate(t.created_at)}</td>
        <td class="text-nowrap">
          ${t.status === "active"
            ? `<button class="icon-btn danger" onclick="suspendTenant('${t.id}','${escapeHtml(t.name)}')">Revoke</button>
               <button class="icon-btn danger" onclick="deleteTenant('${t.id}','${escapeHtml(t.name)}')">Delete</button>`
            : `<button class="icon-btn" onclick="reinstateTenant('${t.id}','${escapeHtml(t.name)}')">Reinstate</button>
               ${t.status === "suspended" ? `<button class="icon-btn danger" onclick="deleteTenant('${t.id}','${escapeHtml(t.name)}')">Delete</button>` : ""}`}
        </td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="9">No tenants yet.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}

document.getElementById("addTenantBtn").addEventListener("click", () => {
  document.getElementById("tenantForm").reset();
  bsModal("tenantModal").show();
});

document.getElementById("tenantForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await API.post("/admin/tenants", {
      name: document.getElementById("tenantName").value.trim(),
      plan: document.getElementById("tenantPlan").value,
      adminUsername: document.getElementById("tenantAdminUser").value.trim(),
      adminEmail: document.getElementById("tenantAdminEmail").value.trim(),
      adminPassword: document.getElementById("tenantAdminPass").value
    });
    bsModal("tenantModal").hide();
    renderTenants();
    toast("Tenant created.");
  } catch (err) { toast(err.message, true); }
});

async function suspendTenant(id, name) {
  if (!confirm(`Revoke access for "${name}"? All of its users will be blocked immediately.`)) return;
  try {
    await API.patch(`/admin/tenants/${id}/status`, { status: "suspended" });
    renderTenants();
    toast("Tenant suspended — access revoked.");
  } catch (e) { toast(e.message, true); }
}

async function reinstateTenant(id, name) {
  if (!confirm(`Reinstate access for "${name}"?`)) return;
  try {
    await API.patch(`/admin/tenants/${id}/status`, { status: "active" });
    renderTenants();
    toast("Tenant reinstated.");
  } catch (e) { toast(e.message, true); }
}

async function deleteTenant(id, name) {
  if (!confirm(`PERMANENTLY DELETE tenant "${name}" and all its data? This cannot be undone.`)) return;
  if (!confirm("Final warning: this destroys every product, invoice and payment record of this tenant. Continue?")) return;
  try {
    await API.del("/admin/tenants/" + id);
    renderTenants();
    toast("Tenant deleted.");
  } catch (e) { toast(e.message, true); }
}

/* ---------------------------------------------------------------------- */
/* Audit log                                                               */
/* ---------------------------------------------------------------------- */
async function renderAudit() {
  try {
    const { auditLog } = await API.get("/admin/audit");
    document.getElementById("auditTableBody").innerHTML = auditLog.length ? auditLog.map(a => `
      <tr>
        <td class="mono">${fmtDate(a.created_at)}</td>
        <td>${escapeHtml(a.actor_name || "system")}</td>
        <td>${escapeHtml(a.role || "—")}</td>
        <td class="cell-strong">${escapeHtml(a.action)}</td>
        <td>${escapeHtml(a.entity || "—")} ${a.entity_id ? `<span class="mono">· ${escapeHtml(String(a.entity_id).slice(0, 8))}…</span>` : ""}</td>
        <td>${escapeHtml(JSON.stringify(a.meta || {}))}</td>
        <td class="mono">${escapeHtml(a.ip || "—")}</td>
      </tr>`).join("") : `<tr class="empty-row"><td colspan="7">No audit entries yet.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}

/* ---------------------------------------------------------------------- */
/* Global search (tenant data only)                                        */
/* ---------------------------------------------------------------------- */
const gsInput = document.getElementById("globalSearch");
const gsResults = document.getElementById("globalSearchResults");

gsInput.addEventListener("input", async () => {
  const q = gsInput.value.trim().toLowerCase();
  if (!q) { gsResults.classList.add("d-none"); return; }
  if (state.user.role === "super_admin") { gsResults.classList.add("d-none"); return; }

  const [products, customers, suppliers, invoices] = await Promise.all([
    API.get("/products?search=" + encodeURIComponent(q)),
    API.get("/customers?search=" + encodeURIComponent(q)),
    API.get("/suppliers?search=" + encodeURIComponent(q)),
    API.get("/invoices").then(d => d.invoices)
  ]).catch(() => [{ products: [] }, { customers: [] }, { suppliers: [] }, []]);

  const p = products.products.slice(0, 4);
  const c = customers.customers.slice(0, 4);
  const s = suppliers.suppliers.slice(0, 4);
  const inv = invoices.filter(i => i.invoice_no.toLowerCase().includes(q) || i.customer_name.toLowerCase().includes(q)).slice(0, 4);

  let html = "";
  const group = (label, list, render) => list.length ? `<div class="gs-group-label">${label}</div>` + list.map(render).join("") : "";
  html += group("Products", p, x => `<div class="gs-result-item" onclick="jumpTo('products')"><span>${escapeHtml(x.name)}</span><small class="mono">${escapeHtml(x.sku)}</small></div>`);
  html += group("Customers", c, x => `<div class="gs-result-item" onclick="jumpTo('customers')"><span>${escapeHtml(x.name)}</span><small>${escapeHtml(x.phone)}</small></div>`);
  html += group("Suppliers", s, x => `<div class="gs-result-item" onclick="jumpTo('suppliers')"><span>${escapeHtml(x.name)}</span><small>${escapeHtml(x.phone)}</small></div>`);
  html += group("Invoices", inv, x => `<div class="gs-result-item" onclick="jumpTo('invoices')"><span>${escapeHtml(x.invoice_no)}</span><small>${money(x.total)}</small></div>`);

  gsResults.innerHTML = html || `<div class="gs-empty">No matches found.</div>`;
  gsResults.classList.remove("d-none");
});

function jumpTo(page) {
  goToPage(page);
  gsResults.classList.add("d-none");
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".global-search")) gsResults.classList.add("d-none");
});

/* ---------------------------------------------------------------------- */
/* Expose handlers used in inline onclick attributes                       */
/* ---------------------------------------------------------------------- */
window.addToCart = addToCart;
window.changeQty = changeQty;
window.removeFromCart = removeFromCart;
window.editProduct = editProduct;
window.deleteProduct = deleteProduct;
window.openStockModal = openStockModal;
window.editSupplier = editSupplier;
window.deleteSupplier = deleteSupplier;
window.editCustomer = editCustomer;
window.deleteCustomer = deleteCustomer;
window.viewInvoice = viewInvoice;
window.openPaymentModal = openPaymentModal;
window.voidPayment = voidPayment;
window.editEmployee = editEmployee;
window.deleteEmployee = deleteEmployee;
window.suspendTenant = suspendTenant;
window.reinstateTenant = reinstateTenant;
window.deleteTenant = deleteTenant;
window.printInvoice = printInvoice;
window.jumpTo = jumpTo;
