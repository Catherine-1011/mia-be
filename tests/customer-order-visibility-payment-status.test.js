const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

const ordersControllerPath = path.resolve(__dirname, "../controllers/orders.js");
const prismaPath = path.resolve(__dirname, "../config/prisma.js");
const cartControllerPath = path.resolve(__dirname, "../controllers/cart.js");
const emailServicePath = path.resolve(__dirname, "../utils/emailService.js");
const notificationControllerPath = path.resolve(__dirname, "../controllers/notification.js");
const orderNotificationControllerPath = path.resolve(__dirname, "../controllers/orderNotification.js");
const commissionControllerPath = path.resolve(__dirname, "../controllers/commission.js");
const stripeModulePath = require.resolve("stripe");

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

function makeOrder(overrides = {}) {
  return {
    id: "order_paid",
    displayId: "ABC123",
    userId: "user_1",
    sellerId: "seller_1",
    totalAmount: 120,
    status: "CONFIRMED",
    overallStatus: "CONFIRMED",
    paymentMethod: "Credit/Debit Card",
    paymentStatus: "PAID",
    stripePaymentIntentId: "pi_paid",
    customerName: "Buyer",
    customerEmail: "buyer@example.com",
    customerPhone: "0400000000",
    shippingAddress: null,
    shippingAddressLine: "1 Test St",
    shippingCity: "Sydney",
    shippingState: "NSW",
    shippingZipCode: "2000",
    shippingCountry: "Australia",
    shippingPhone: "0400000000",
    trackingNumber: null,
    estimatedDelivery: null,
    statusReason: null,
    couponCode: null,
    discountAmount: null,
    originalTotal: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    seller: { id: "seller_1", name: "Seller" },
    items: [
      {
        id: "item_1",
        productId: "prod_1",
        variantId: null,
        quantity: 1,
        price: 110,
        product: {
          id: "prod_1",
          title: "Artwork",
          featuredImage: null,
          price: 110,
          sellerId: "seller_1",
          seller: { id: "seller_1", name: "Seller" },
        },
        productVariant: null,
      },
    ],
    subOrders: [],
    ...overrides,
  };
}

function loadOrdersController(prisma) {
  delete require.cache[ordersControllerPath];
  delete require.cache[prismaPath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === prismaPath) return prisma;
    if (resolved === stripeModulePath) return function StripeMock() {
      return {
        paymentIntents: {
          retrieve: async () => ({}),
          cancel: async () => ({}),
        },
        refunds: {
          create: async () => ({ status: "succeeded" }),
        },
      };
    };
    if (resolved === cartControllerPath) return { calculateCartTotals: async () => ({}) };
    if (resolved === emailServicePath) {
      return {
        sendOrderConfirmationEmail: async () => ({ success: true }),
        sendOrderStatusEmail: async () => ({ success: true }),
        sendSellerOrderNotificationEmail: async () => ({ success: true }),
        sendAdminNewOrderEmail: async () => ({ success: true }),
        sendSellerLowStockEmail: async () => ({ success: true }),
        sendSellerOrderStatusEmail: async () => ({ success: true }),
        sendFinanceOrderInvoiceEmail: async () => ({ success: true }),
        sendAdminOrderStatusEmail: async () => ({ success: true }),
        sendRefundRequestConfirmationEmail: async () => ({ success: true }),
      };
    }
    if (resolved === notificationControllerPath) {
      return {
        notifyCustomerOrderStatusChange: async () => {},
        notifySellerNewOrder: async () => {},
        notifyAdminNewOrder: async () => {},
        notifySellerLowStock: async () => {},
        notifyAdminOrderStatusChange: async () => {},
        notifySellerOrderStatusChange: async () => {},
      };
    }
    if (resolved === orderNotificationControllerPath) return { createOrderNotification: async () => {} };
    if (resolved === commissionControllerPath) return { createCommissionEarned: async () => null };
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(ordersControllerPath);
  } finally {
    Module._load = originalLoad;
  }
}

async function callGetMyOrders(controller, prisma) {
  const reply = makeReply();
  await controller.getMyOrders({ user: { userId: "user_1" } }, reply);
  return reply;
}

test("My Orders only queries paid orders for the logged-in customer", async () => {
  const paidOrder = makeOrder();
  const prisma = {
    _findManyCalls: [],
    order: {
      findMany: async (args) => {
        prisma._findManyCalls.push(args);
        return [paidOrder];
      },
    },
  };
  const controller = loadOrdersController(prisma);

  const reply = await callGetMyOrders(controller, prisma);

  assert.equal(reply.statusCode, 200);
  assert.deepEqual(prisma._findManyCalls[0].where, { userId: "user_1", paymentStatus: "PAID" });
  assert.equal(reply.payload.orders.length, 1);
  assert.equal(reply.payload.orders[0].paymentStatus, "PAID");
  assert.equal(reply.payload.orders[0].status, "CONFIRMED");
});

test("pending, failed, and abandoned checkout orders are not returned as placed orders", async () => {
  const ordersInDatabase = [
    makeOrder({ id: "pending", paymentStatus: "PENDING", status: "PENDING", overallStatus: "PENDING", stripePaymentIntentId: "pi_pending" }),
    makeOrder({ id: "failed", paymentStatus: "FAILED", status: "PENDING", overallStatus: "PENDING", stripePaymentIntentId: "pi_failed" }),
    makeOrder({ id: "abandoned", paymentStatus: "PENDING", status: "PENDING", overallStatus: "PENDING", stripePaymentIntentId: "pi_abandoned" }),
  ];
  const prisma = {
    order: {
      findMany: async (args) => ordersInDatabase.filter((order) => (
        order.userId === args.where.userId &&
        order.paymentStatus === args.where.paymentStatus
      )),
    },
  };
  const controller = loadOrdersController(prisma);

  const reply = await callGetMyOrders(controller, prisma);

  assert.equal(reply.statusCode, 200);
  assert.deepEqual(reply.payload.orders, []);
});

test("successful single-seller payment still appears normally in My Orders", async () => {
  const prisma = {
    order: {
      findMany: async (args) => [makeOrder({ id: "paid", paymentStatus: args.where.paymentStatus, status: "CONFIRMED" })],
    },
  };
  const controller = loadOrdersController(prisma);

  const reply = await callGetMyOrders(controller, prisma);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.orders.length, 1);
  assert.equal(reply.payload.orders[0].type, "DIRECT");
  assert.equal(reply.payload.orders[0].paymentStatus, "PAID");
  assert.equal(reply.payload.orders[0].status, "CONFIRMED");
});

test("successful multi-seller payment still appears normally in My Orders", async () => {
  const paidMultiSellerOrder = makeOrder({
    id: "multi_paid",
    sellerId: null,
    items: [],
    subOrders: [
      {
        id: "sub_1",
        sellerId: "seller_1",
        parentOrderId: "multi_paid",
        status: "CONFIRMED",
        statusReason: null,
        trackingNumber: null,
        estimatedDelivery: null,
        subtotal: 120,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        seller: { id: "seller_1", name: "Seller" },
        sellerProfile: { businessName: "Seller Co", storeName: null },
        items: [
          {
            id: "item_1",
            productId: "prod_1",
            variantId: null,
            quantity: 1,
            price: 110,
            product: {
              id: "prod_1",
              title: "Artwork",
              featuredImage: null,
              price: 110,
              sellerId: "seller_1",
              seller: { id: "seller_1", name: "Seller" },
            },
            productVariant: null,
          },
        ],
      },
    ],
  });
  const prisma = {
    order: {
      findMany: async () => [paidMultiSellerOrder],
    },
  };
  const controller = loadOrdersController(prisma);

  const reply = await callGetMyOrders(controller, prisma);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.orders.length, 1);
  assert.equal(reply.payload.orders[0].type, "MULTI_SELLER");
  assert.equal(reply.payload.orders[0].paymentStatus, "PAID");
  assert.equal(reply.payload.orders[0].status, "CONFIRMED");
});
