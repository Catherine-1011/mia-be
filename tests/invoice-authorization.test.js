"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const Module = require("node:module");
const path = require("node:path");

const ordersPath = path.resolve(__dirname, "../controllers/orders.js");
const prismaPath = path.resolve(__dirname, "../config/prisma.js");
const cartPath = path.resolve(__dirname, "../controllers/cart.js");
const emailPath = path.resolve(__dirname, "../utils/emailService.js");
const notificationPath = path.resolve(__dirname, "../controllers/notification.js");
const orderNotificationPath = path.resolve(__dirname, "../controllers/orderNotification.js");
const commissionPath = path.resolve(__dirname, "../controllers/commission.js");
const stripePath = require.resolve("stripe");
const pdfkitPath = require.resolve("pdfkit");

class PDFDocumentMock extends EventEmitter {
  constructor() {
    super();
    this.page = { width: 595, height: 842 };
    let proxy;
    proxy = new Proxy(this, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        return () => proxy;
      },
    });
    return proxy;
  }
  widthOfString(value) { return String(value).length * 5; }
  end() {
    this.emit("data", Buffer.from("%PDF-1.4 invoice"));
    this.emit("end");
  }
}

function loadController(prisma, { realPdf = false } = {}) {
  delete require.cache[ordersPath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === prismaPath) return prisma;
    if (resolved === pdfkitPath && !realPdf) return PDFDocumentMock;
    if (resolved === stripePath) return function StripeMock() { return { paymentIntents: {}, refunds: {} }; };
    if (resolved === cartPath) return { calculateCartTotals: async () => ({}) };
    if (resolved === emailPath) return new Proxy({}, { get: () => async () => ({ success: true }) });
    if (resolved === notificationPath) return new Proxy({}, { get: () => async () => {} });
    if (resolved === orderNotificationPath) return { createOrderNotification: async () => {} };
    if (resolved === commissionPath) return { createCommissionEarned: async () => null };
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(ordersPath);
  } finally {
    Module._load = originalLoad;
  }
}

function replyMock() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    header(name, value) { this.headers[name] = value; return this; },
    send(payload) { this.payload = payload; return payload; },
  };
}

function order(overrides = {}) {
  return {
    id: "db-order-a", displayId: "ORDERA", userId: "customer-a", sellerId: "seller-a",
    status: "CONFIRMED", overallStatus: "CONFIRMED", createdAt: new Date("2026-01-01"),
    customerName: "Customer A", customerEmail: "a@example.com", customerPhone: "0400000000",
    shippingAddressLine: "1 Test St", shippingCity: "Darwin", shippingState: "NT",
    shippingZipCode: "0800", shippingCountry: "Australia", shippingPhone: "0400000000",
    paymentMethod: "Card", totalAmount: 10, items: [], subOrders: [], user: null,
    ...overrides,
  };
}

function subOrder(overrides = {}) {
  return {
    id: "sub-a", subDisplayId: "ORDERA-A", sellerId: "seller-a", status: "CONFIRMED",
    totalAmount: 10, shippingCost: 0, discountAmount: 0, couponCode: null,
    items: [], seller: { name: "Seller A" }, sellerProfile: null,
    parentOrder: order({ displayId: "ORDERA", user: null }),
    ...overrides,
  };
}

async function invoke(handler, request) {
  const reply = replyMock();
  await handler(request, reply);
  return reply;
}

test.beforeEach(() => {
  process.env.JWT_SECRET = "invoice-controller-test-secret-at-least-32-bytes";
});

test("public invoice rejects ID-only links before querying and accepts exact signed links", async () => {
  let queries = 0;
  const record = order();
  const prisma = {
    order: { findFirst: async () => { queries += 1; return record; } },
    subOrder: { findUnique: async () => null },
  };
  const controller = loadController(prisma);
  const { createInvoiceAccessToken } = require("../utils/invoiceAccessToken");

  let reply = await invoke(controller.downloadPublicInvoice, { params: { orderId: "ORDERA" }, query: {} });
  assert.equal(reply.statusCode, 401);
  assert.equal(queries, 0);

  for (const token of ["malformed", createInvoiceAccessToken("ORDERB")]) {
    reply = await invoke(controller.downloadPublicInvoice, { params: { orderId: "ORDERA" }, query: { token } });
    assert.equal(reply.statusCode, 401);
    assert.equal(queries, 0);
  }

  reply = await invoke(controller.downloadPublicInvoice, {
    params: { orderId: "ORDERA" }, query: { token: createInvoiceAccessToken("ORDERA") },
  });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.headers["Content-Type"], "application/pdf");
  assert.equal(Buffer.isBuffer(reply.payload), true);
  assert.equal(queries, 1);
});

test("CUSTOMER ownership is enforced for parent and dedicated sub-order invoices", async () => {
  const parent = order();
  const sub = subOrder();
  const prisma = {
    order: { findFirst: async ({ where }) => where.OR ? parent : null },
    subOrder: { findFirst: async () => sub, findUnique: async () => sub, update: async () => sub },
  };
  const controller = loadController(prisma);

  let reply = await invoke(controller.downloadInvoice, {
    user: { userId: "customer-b", role: "CUSTOMER" }, params: { orderId: "ORDERA" },
  });
  assert.equal(reply.statusCode, 403);
  reply = await invoke(controller.downloadInvoice, {
    user: { userId: "customer-a", role: "CUSTOMER" }, params: { orderId: "ORDERA" },
  });
  assert.equal(reply.statusCode, 200);

  reply = await invoke(controller.downloadSubOrderInvoice, {
    user: { userId: "customer-b", role: "CUSTOMER" }, params: { subOrderId: "ORDERA-A" },
  });
  assert.equal(reply.statusCode, 403);
  reply = await invoke(controller.downloadSubOrderInvoice, {
    user: { userId: "customer-a", role: "CUSTOMER" }, params: { subOrderId: "ORDERA-A" },
  });
  assert.equal(reply.statusCode, 200);
});

test("seller isolation and admin/super-admin access remain unchanged", async () => {
  const sub = subOrder();
  const prisma = {
    order: { findFirst: async () => null },
    subOrder: { findFirst: async () => sub, findUnique: async () => sub, update: async () => sub },
  };
  const controller = loadController(prisma);

  for (const [role, userId, expected] of [
    ["SELLER", "seller-a", 200], ["SELLER", "seller-b", 403],
    ["ADMIN", "admin-a", 200], ["SUPER_ADMIN", "super-a", 200],
  ]) {
    const reply = await invoke(controller.downloadSubOrderInvoice, {
      user: { userId, role }, params: { subOrderId: "ORDERA-A" },
    });
    assert.equal(reply.statusCode, expected, `${role}/${userId}`);
  }
});

test("guest invoice keeps display-ID plus exact-email verification", async () => {
  const record = order({ userId: null });
  const prisma = {
    order: { findFirst: async ({ where }) => where.customerEmail === record.customerEmail ? record : null },
    subOrder: { findUnique: async () => null },
  };
  const controller = loadController(prisma);

  let reply = await invoke(controller.downloadGuestInvoice, {
    query: { orderId: "ORDERA", customerEmail: "wrong@example.com" },
  });
  assert.equal(reply.statusCode, 404);
  reply = await invoke(controller.downloadGuestInvoice, {
    query: { orderId: "ORDERA", customerEmail: "a@example.com" },
  });
  assert.equal(reply.statusCode, 200);
  assert.equal(Buffer.isBuffer(reply.payload), true);
});

test("invoice PDF still renders with the production PDF implementation", async () => {
  const controller = loadController({ order: {}, subOrder: {} }, { realPdf: true });
  const buffer = await controller.generateInvoiceBuffer(order());
  assert.equal(Buffer.isBuffer(buffer), true);
  assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
  assert.ok(buffer.length > 1000);
});
