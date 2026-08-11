const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const adminControllerPath = path.resolve(__dirname, "../controllers/admin.js");
const prismaPath = path.resolve(__dirname, "../config/prisma.js");

function makeReply() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return payload;
    },
  };
}

function makeStripeMock({ refundStatus = "succeeded", failRefund = false } = {}) {
  return {
    refunds: {
      createCalls: [],
      create: async function(params, options) {
        this.createCalls.push({ params, options });
        if (failRefund) throw new Error("stripe unavailable");
        return { id: "re_123", status: refundStatus, payment_intent: params.payment_intent };
      },
    },
    transfers: {
      createReversal: async () => ({ id: "trr_1" }),
    },
  };
}

function paymentRecord(overrides = {}) {
  return {
    id: "opr_seller_a",
    orderId: "order_1",
    sellerId: "seller_a",
    paymentFlow: "DIRECT_CHARGE",
    stripeAccountId: "acct_a",
    stripePaymentIntentId: "pi_seller_a",
    grossAmount: 12000,
    refundStatus: "NONE",
    paymentStatus: "PAID",
    ...overrides,
  };
}

function makeOrder({ records = [paymentRecord()] } = {}) {
  return {
    id: "order_1",
    displayId: "MIA-1",
    stripePaymentIntentId: records[0]?.stripePaymentIntentId || "pi_seller_a",
    totalAmount: 120,
    user: { id: "customer_1", name: "Customer", email: "customer@example.test", isDeleted: false },
    paymentRecords: records,
    items: records
      .filter((record) => record.sellerId)
      .map((record) => ({
        productId: `prod_${record.sellerId}`,
        quantity: 1,
        price: 120,
        product: { id: `prod_${record.sellerId}`, sellerId: record.sellerId, title: "Item", price: 120 },
      })),
    subOrders: records
      .filter((record) => record.sellerId)
      .map((record) => ({
        sellerId: record.sellerId,
        items: [{
          productId: `prod_${record.sellerId}`,
          quantity: 1,
          price: 120,
          product: { id: `prod_${record.sellerId}`, sellerId: record.sellerId, title: "Item", price: 120 },
        }],
      })),
  };
}

function makePrisma({ ticket, order, commissionRows = [] }) {
  return {
    _commissionRows: commissionRows,
    order: {
      findUnique: async () => order,
    },
    supportTicket: {
      findFirst: async () => ticket,
      update: async ({ data }) => ({ ...ticket, ...data }),
    },
    orderPaymentRecord: {
      update: async ({ where, data }) => {
        const record = order.paymentRecords.find((row) => row.id === where.id);
        Object.assign(record, data);
        return record;
      },
    },
    commissionEarned: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of commissionRows) {
          if (where.orderId !== undefined && row.orderId !== where.orderId) continue;
          if (where.sellerId !== undefined && row.sellerId !== where.sellerId) continue;
          if (where.status?.not !== undefined && row.status === where.status.not) continue;
          Object.assign(row, data);
          count++;
        }
        return { count };
      },
    },
    notification: {
      createMany: async () => ({}),
    },
    user: {
      findMany: async () => [],
    },
    $queryRaw: async () => [],
    $executeRaw: async () => ({}),
  };
}

function loadAdminController({ prisma, stripeMock }) {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const resolved = (() => {
      try {
        return Module._resolveFilename(request, parent);
      } catch (_) {
        return request;
      }
    })();
    if (request === "stripe") {
      return function Stripe() {
        return stripeMock;
      };
    }
    if (resolved === prismaPath) return prisma;
    if (request.includes("emailService")) {
      return {
        sendRefundStatusUpdateEmail: async () => {},
        sendSellerRefundStatusEmail: async () => {},
      };
    }
    if (request.includes("orders")) return { generateInvoiceBuffer: async () => null };
    if (request.includes("csvExport")) return {};
    if (request.includes("commissionCalculator")) return {};
    if (request.includes("cloudinary")) return {};
    if (request.includes("cacheInvalidation")) return {};
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[adminControllerPath];
  const controller = require(adminControllerPath);
  Module._load = originalLoad;
  return controller;
}

async function approveRefund({ refundStatus = "succeeded", failRefund = false, records, commissionRows, ticketOverrides = {} }) {
  const order = makeOrder({ records });
  const ticket = {
    id: "ticket_1",
    orderId: order.id,
    status: "OPEN",
    category: "REFUND_REQUEST",
    requestType: "REFUND",
    message: "",
    ...ticketOverrides,
  };
  const prisma = makePrisma({ ticket, order, commissionRows });
  const stripeMock = makeStripeMock({ refundStatus, failRefund });
  const controller = loadAdminController({ prisma, stripeMock });
  const reply = makeReply();

  await controller.updateRefundRequestStatus(
    { params: { id: ticket.id }, body: { status: "APPROVED", message: "approved" } },
    reply,
  );

  return { reply, prisma, stripeMock, order };
}

test("admin full refund only marks completed when Stripe refund succeeded", async () => {
  const records = [paymentRecord()];
  const { reply, order } = await approveRefund({ records, commissionRows: [] });

  assert.equal(reply.statusCode, 200);
  assert.equal(order.paymentRecords[0].refundStatus, "FULL");
  assert.equal(order.paymentRecords[0].paymentStatus, "REFUNDED");
});

test("admin partial refund marks PARTIAL for succeeded Stripe refund", async () => {
  const records = [paymentRecord()];
  const requestedItems = [{ productId: "prod_seller_a", price: 60, quantity: 1 }];
  const { order } = await approveRefund({
    records,
    commissionRows: [],
    ticketOverrides: {
      requestType: "PARTIAL_REFUND",
      message: `---ITEMS_JSON---\n${JSON.stringify(requestedItems)}`,
    },
  });

  assert.equal(order.paymentRecords[0].refundStatus, "PARTIAL");
  assert.equal(order.paymentRecords[0].paymentStatus, "PAID");
});

test("admin partial refund does not cancel full seller commission", async () => {
  const records = [paymentRecord()];
  const commissionRows = [{ id: "ce_a", orderId: "order_1", sellerId: "seller_a", status: "PAID" }];
  const requestedItems = [{ productId: "prod_seller_a", price: 60, quantity: 1 }];

  await approveRefund({
    records,
    commissionRows,
    ticketOverrides: {
      requestType: "PARTIAL_REFUND",
      message: `---ITEMS_JSON---\n${JSON.stringify(requestedItems)}`,
    },
  });

  assert.equal(commissionRows[0].status, "PAID");
});

test("admin pending refund does not falsely mark FULL/PARTIAL or REFUNDED", async () => {
  const records = [paymentRecord()];
  const { order } = await approveRefund({ refundStatus: "pending", records, commissionRows: [] });

  assert.equal(order.paymentRecords[0].refundStatus, "NONE");
  assert.equal(order.paymentRecords[0].paymentStatus, "REFUND_PENDING");
});

test("admin requires_action refund uses pending semantics", async () => {
  const records = [paymentRecord()];
  const { order } = await approveRefund({ refundStatus: "requires_action", records, commissionRows: [] });

  assert.equal(order.paymentRecords[0].refundStatus, "NONE");
  assert.equal(order.paymentRecords[0].paymentStatus, "REFUND_PENDING");
});

test("admin failed refund does not approve ticket or mark payment refunded", async () => {
  const records = [paymentRecord()];
  const { reply, order } = await approveRefund({ refundStatus: "failed", records, commissionRows: [] });

  assert.equal(reply.statusCode, 502);
  assert.equal(order.paymentRecords[0].refundStatus, "FAILED");
  assert.equal(order.paymentRecords[0].paymentStatus, "PAID");
});

test("admin refund throw leaves ticket and payment record unchanged for retry", async () => {
  const records = [paymentRecord()];
  const { reply, order } = await approveRefund({ failRefund: true, records, commissionRows: [] });

  assert.equal(reply.statusCode, 502);
  assert.equal(order.paymentRecords[0].refundStatus, "NONE");
  assert.equal(order.paymentRecords[0].paymentStatus, "PAID");
});

test("admin retry uses deterministic Stripe idempotency key", async () => {
  const records = [paymentRecord()];
  const { stripeMock } = await approveRefund({ records, commissionRows: [] });

  assert.equal(stripeMock.refunds.createCalls[0].options.idempotencyKey, "refund:opr_seller_a:ticket_1");
});

test("admin approval cancels only refunded seller commission in two-seller order", async () => {
  const records = [
    paymentRecord({ id: "opr_seller_a", sellerId: "seller_a", stripeAccountId: "acct_a", stripePaymentIntentId: "pi_seller_a" }),
    paymentRecord({ id: "opr_seller_b", sellerId: "seller_b", stripeAccountId: "acct_b", stripePaymentIntentId: "pi_seller_b" }),
  ];
  const commissionRows = [
    { id: "ce_a", orderId: "order_1", sellerId: "seller_a", status: "PAID" },
    { id: "ce_b", orderId: "order_1", sellerId: "seller_b", status: "PAID" },
  ];

  await approveRefund({ records, commissionRows });

  assert.equal(commissionRows.find((row) => row.sellerId === "seller_a").status, "CANCELLED");
  assert.equal(commissionRows.find((row) => row.sellerId === "seller_b").status, "PAID");
});

test("admin approval of seller refund in mixed ALPA order does not touch platform commission rows", async () => {
  const records = [
    paymentRecord({ id: "opr_seller_a", sellerId: "seller_a", stripeAccountId: "acct_a", stripePaymentIntentId: "pi_seller_a" }),
    paymentRecord({ id: "opr_platform", sellerId: null, paymentFlow: "PLATFORM_ACCOUNT", stripeAccountId: null, stripePaymentIntentId: "pi_platform" }),
  ];
  const commissionRows = [{ id: "ce_a", orderId: "order_1", sellerId: "seller_a", status: "PAID" }];

  await approveRefund({ records, commissionRows });

  assert.equal(commissionRows[0].status, "CANCELLED");
});
