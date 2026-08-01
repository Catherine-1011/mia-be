const Stripe = require("stripe");
const crypto = require("crypto");
const prisma = require("../config/prisma");
const { calculateCartTotals } = require("./cart");
const { generateInvoiceBuffer, calcSellerCouponDiscount } = require("./orders");
const { lookupZone } = require("../utils/internationalShipping");

// ─── Short Display ID Generator ───────────────────────────────────────────────
const DISPLAY_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
async function generateDisplayId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = crypto.randomBytes(6);
    let id = '';
    for (let i = 0; i < 6; i++) id += DISPLAY_ID_CHARS[bytes[i] % DISPLAY_ID_CHARS.length];
    const existing = await prisma.order.findUnique({ where: { displayId: id } });
    if (!existing) return id;
  }
  throw new Error('Failed to generate a unique display ID after 10 attempts');
}
// ─────────────────────────────────────────────────────────────────────────────
const {
  sendOrderConfirmationEmail,
  sendFinanceOrderInvoiceEmail,
  sendDisputeAlertEmail,
  sendSellerPaymentReceivedEmail,
} = require("../utils/emailService");
const {
  notifyAdminNewOrder,
  notifySellerNewOrder,
} = require("./notification");
const { createOrderNotification } = require("./orderNotification");
const { createCommissionEarned, getCommissionForSeller, getDefaultCommission } = require("./commission");
const {
  calculateSellerPayout,
  calculateAlpaCommission,
} = require("../utils/commissionCalculator");
const {
  READINESS_MESSAGES: DIRECT_CHARGE_READINESS_MESSAGES,
  checkSellerPaymentReadiness,
} = require("../utils/sellerPaymentReadiness");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// New single-seller checkout uses true Direct Charges: the PaymentIntent is
// created on the seller's connected account with ALPA's application fee.
const USE_DIRECT_CHARGES_FOR_SINGLE_SELLER = true;

const STRIPE_DESCRIPTION_MAX_LENGTH = 255;
const STRIPE_WEBHOOK_PROCESSING_TIMEOUT_MS =
  Number(process.env.STRIPE_WEBHOOK_PROCESSING_TIMEOUT_MS || 10 * 60 * 1000);

const MIXED_SELLER_CHECKOUT_MESSAGE =
  "Your cart contains products from multiple sellers. Please complete checkout for one seller at a time.";

function moneyToMinorUnits(value) {
  return Math.round(Number(value || 0) * 100);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashOperationPayload(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function normalizeGuestItemsForOperation(items) {
  return [...items]
    .map((item) => ({
      productId: item.productId,
      variantId: item.variantId || null,
      quantity: Number(item.quantity),
    }))
    .sort((a, b) => `${a.productId}:${a.variantId}`.localeCompare(`${b.productId}:${b.variantId}`));
}

function checkoutOperationKey({ scope, subjectId, sellerId, amountInCents, requestHash, attemptNumber = 1 }) {
  return `payment:create:${scope}:${subjectId}:${sellerId || "seller"}:${amountInCents}:${requestHash.slice(0, 20)}:${attemptNumber}`;
}

async function claimApiOperation({ operationKey, operationType, requestHash, attemptNumber = 1 }) {
  try {
    const created = await prisma.apiIdempotencyOperation.create({
      data: { operationKey, operationType, requestHash, attemptNumber, status: "STARTED" },
    });
    return { ...created, claimedNew: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const existing = await prisma.apiIdempotencyOperation.findUnique({ where: { operationKey } });
  if (!existing) throw new Error(`Idempotency operation disappeared: ${operationKey}`);
  if (existing.requestHash !== requestHash) {
    const error = new Error("Idempotency operation key conflict");
    error.statusCode = 409;
    throw error;
  }
  return { ...existing, claimedNew: false };
}

async function markApiOperationCompleted({ operationKey, stripePaymentIntentId, orderId }) {
  if (!prisma.apiIdempotencyOperation?.update) return;
  await prisma.apiIdempotencyOperation.update({
    where: { operationKey },
    data: {
      status: "COMPLETED",
      stripePaymentIntentId,
      orderId,
      lastError: null,
    },
  });
}

async function markApiOperationFailed({ operationKey, error }) {
  if (!prisma.apiIdempotencyOperation?.update) return;
  await prisma.apiIdempotencyOperation.update({
    where: { operationKey },
    data: {
      status: "FAILED",
      lastError: error?.stack || error?.message || String(error),
    },
  });
}

function isUniqueConstraintError(error) {
  return error?.code === "P2002";
}

function extractPaymentIntentIdFromStripeEvent(event) {
  const object = event?.data?.object || {};
  if (event?.type?.startsWith("payment_intent.")) return object.id || null;
  if (event?.type?.startsWith("charge.") && !event.type.startsWith("charge.dispute.")) {
    return object.payment_intent || null;
  }
  if (event?.type?.startsWith("charge.dispute.")) {
    return object.payment_intent || null;
  }
  return null;
}

function disputeStatusFromStripe(dispute) {
  if (dispute?.status === "won") return "WON";
  if (dispute?.status === "lost") return "LOST";
  return "OPEN";
}

async function retrieveDisputeCharge({ chargeId, stripeAccountId }) {
  if (!chargeId) return null;
  return stripe.charges.retrieve(
    chargeId,
    stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
  );
}

async function findDisputedPaymentRecord({ paymentIntentId, stripeAccountId }) {
  if (!paymentIntentId) return null;
  const paymentRecord = await prisma.orderPaymentRecord.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    include: {
      order: { include: { user: { select: { email: true } } } },
      seller: { select: { email: true, name: true } },
    },
  });

  if (!paymentRecord) return null;
  if (stripeAccountId && paymentRecord.stripeAccountId !== stripeAccountId) {
    console.warn(
      `Stripe dispute account mismatch for PaymentIntent ${paymentIntentId}: event account ${stripeAccountId}, stored account ${paymentRecord.stripeAccountId || "platform"}`
    );
    return null;
  }

  return paymentRecord;
}

async function reverseHistoricalTransfersForDispute({ orderId, disputeId }) {
  const commissionsToReverse = await prisma.$queryRaw`
    SELECT id, stripe_transfer_id
    FROM commission_earned
    WHERE order_id               = ${orderId}
      AND stripe_transfer_id     IS NOT NULL
      AND stripe_transfer_status = 'transferred'
  `;

  for (const rec of commissionsToReverse) {
    try {
      await stripe.transfers.createReversal(
        rec.stripe_transfer_id,
        {
          metadata: { reason: "chargeback_dispute", orderId, disputeId },
        },
        {
          idempotencyKey: `dispute-reversal:${disputeId}:${rec.id}`,
        },
      );
      await prisma.$executeRaw`
        UPDATE commission_earned
        SET stripe_transfer_status = 'reversed',
            status                 = 'CANCELLED'::"CommissionStatus",
            updated_at             = NOW()
        WHERE id = ${rec.id}
      `;
    } catch (reverseErr) {
      console.error(`Transfer reversal failed for dispute (commissionId: ${rec.id}):`, reverseErr.message);
      throw reverseErr;
    }
  }
}

async function handleChargeDisputeEvent(event) {
  const dispute = event.data.object;
  const stripeAccountId = event.account || null;
  const chargeId = dispute.charge;
  const disputedCharge = await retrieveDisputeCharge({ chargeId, stripeAccountId });
  const paymentIntentId = dispute.payment_intent || disputedCharge?.payment_intent || null;
  const paymentRecord = await findDisputedPaymentRecord({ paymentIntentId, stripeAccountId });
  const disputeStatus = disputeStatusFromStripe(dispute);

  if (!paymentRecord) {
    console.warn(
      `Stripe dispute ${dispute.id} could not be matched to a payment record for PaymentIntent ${paymentIntentId || "unknown"}`
    );
    return;
  }

  await prisma.orderPaymentRecord.update({
    where: { id: paymentRecord.id },
    data: {
      stripeDisputeId: dispute.id,
      disputeStatus,
      paymentStatus: disputeStatus === "LOST" ? "FAILED" : paymentRecord.paymentStatus,
    },
  });

  if (event.type === "charge.dispute.created") {
    await prisma.order.updateMany({
      where: { id: paymentRecord.orderId },
      data: { paymentStatus: "DISPUTED" },
    });

    if (paymentRecord.paymentFlow !== "DIRECT_CHARGE") {
      await reverseHistoricalTransfersForDispute({ orderId: paymentRecord.orderId, disputeId: dispute.id });
    }

    const adminEmail = process.env.FINANCE_EMAIL_RECEIVER || "ritikkashyap013@gmail.com";
    await sendDisputeAlertEmail({
      adminEmail,
      adminName: "Admin",
      disputeId: dispute.id,
      amount: dispute.amount,
      currency: dispute.currency,
      reason: dispute.reason,
      orderId: paymentRecord.order?.id || paymentRecord.orderId,
      orderDisplayId: paymentRecord.order?.displayId || null,
      chargeId,
      customerEmail: disputedCharge?.billing_details?.email || paymentRecord.order?.user?.email || null,
    });

    if (paymentRecord.sellerId) {
      await createOrderNotification(paymentRecord.orderId, paymentRecord.sellerId, "PAYMENT_DISPUTED", "HIGH", {
        message: `Payment dispute ${dispute.id} opened for order ${paymentRecord.order?.displayId || paymentRecord.orderId}`,
        notes: dispute.reason || null,
      });
    }
  }

  if (event.type === "charge.dispute.closed") {
    const disputeWon = dispute.status === "won";
    await prisma.order.updateMany({
      where: { id: paymentRecord.orderId },
      data: {
        status: disputeWon ? "CONFIRMED" : "CANCELLED",
        paymentStatus: disputeWon ? "PAID" : "REFUNDED",
      },
    });
  }
}

async function claimStripeWebhookEvent(event) {
  const staleBefore = new Date(Date.now() - STRIPE_WEBHOOK_PROCESSING_TIMEOUT_MS);
  const paymentIntentId = extractPaymentIntentIdFromStripeEvent(event);
  const eventData = {
    eventId: event.id,
    eventType: event.type,
    stripeAccountId: event.account || null,
    paymentIntentId,
    status: "RECEIVED",
  };

  try {
    await prisma.stripeWebhookEvent.create({ data: eventData });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const claimed = await prisma.stripeWebhookEvent.updateMany({
    where: {
      eventId: event.id,
      OR: [
        { status: { in: ["RECEIVED", "FAILED"] } },
        { status: "PROCESSING", updatedAt: { lt: staleBefore } },
      ],
    },
    data: {
      status: "PROCESSING",
      attemptCount: { increment: 1 },
      lastError: null,
      stripeAccountId: event.account || null,
      paymentIntentId,
    },
  });

  if (claimed.count === 1) return { shouldProcess: true, status: "PROCESSING" };

  const existing = await prisma.stripeWebhookEvent.findUnique({
    where: { eventId: event.id },
    select: { status: true, updatedAt: true },
  });

  return {
    shouldProcess: false,
    status: existing?.status || "UNKNOWN",
    stale: existing?.status === "PROCESSING" && existing.updatedAt < staleBefore,
  };
}

async function markStripeWebhookEventProcessed(eventId) {
  await prisma.stripeWebhookEvent.update({
    where: { eventId },
    data: {
      status: "PROCESSED",
      processedAt: new Date(),
      lastError: null,
    },
  });
}

async function markStripeWebhookEventFailed(eventId, error) {
  await prisma.stripeWebhookEvent.update({
    where: { eventId },
    data: {
      status: "FAILED",
      lastError: error?.stack || error?.message || String(error),
      processedAt: null,
    },
  });
}

function buildDirectChargePaymentRecordData({
  orderId,
  sellerId,
  stripeAccountId,
  stripePaymentIntentId,
  itemTotal,
  shippingAmount,
  payout,
  commission,
  grossAmountCents,
  gstAmountCents,
  paymentStatus = "PENDING",
}) {
  return {
    orderId,
    sellerId,
    paymentFlow: "DIRECT_CHARGE",
    stripeAccountId,
    stripePaymentIntentId,
    currency: "aud",
    grossAmount: grossAmountCents ?? moneyToMinorUnits(Number(itemTotal || 0) + Number(shippingAmount || 0)),
    commissionBase: commission?.commissionBase ?? moneyToMinorUnits(itemTotal),
    applicationFeeAmount: commission?.applicationFeeAmount ?? 0,
    gstAmount: gstAmountCents ?? (payout?.gstAmount != null ? moneyToMinorUnits(payout.gstAmount) : 0),
    shippingAmount: moneyToMinorUnits(shippingAmount),
    paymentStatus,
    refundStatus: "NONE",
    disputeStatus: "NONE",
  };
}

function buildPlatformPaymentRecordData({
  orderId,
  sellerId,
  stripePaymentIntentId,
  itemTotal,
  shippingAmount,
  grossAmountCents,
  gstAmountCents,
  paymentStatus = "PENDING",
}) {
  return {
    orderId,
    sellerId,
    paymentFlow: "PLATFORM_ACCOUNT",
    stripeAccountId: null,
    stripePaymentIntentId,
    currency: "aud",
    grossAmount: grossAmountCents ?? moneyToMinorUnits(Number(itemTotal || 0) + Number(shippingAmount || 0)),
    commissionBase: 0,
    applicationFeeAmount: 0,
    gstAmount: gstAmountCents ?? 0,
    shippingAmount: moneyToMinorUnits(shippingAmount),
    paymentStatus,
    refundStatus: "NONE",
    disputeStatus: "NONE",
  };
}

function getItemUnitPrice(item) {
  return Number(item.productVariant?.price ?? item.product?.price ?? item.price ?? 0);
}

function getSellerItemsTotal(items) {
  return items.reduce((sum, item) => sum + getItemUnitPrice(item) * Number(item.quantity || 0), 0);
}

function getGstRateFromCartCalculations(cartCalculations) {
  return Number(cartCalculations?.gstPercentage || 10);
}

function getGstInclusiveBreakdown(amount, gstRatePct) {
  const gross = Number(amount || 0);
  const divisor = 100 + Number(gstRatePct || 0);
  if (gross <= 0 || divisor <= 100) return { exGst: gross, gst: 0 };
  const gst = gross * (Number(gstRatePct) / divisor);
  return { exGst: gross - gst, gst };
}

function buildDirectChargeStripeMetadata({
  order,
  sellerId,
  sellerStripeAccountId,
  productAmountCents,
  shippingAmountCents,
  gstAmountCents,
  commission,
  // Optional, additive fields — every existing caller keeps its exact prior
  // output unless it explicitly passes these. Callers override `paymentFlow`
  // via spread afterwards where a more specific value applies (e.g. the
  // multi-seller flows use DIRECT_CHARGE_MULTI_SELLER); the default here is
  // intentionally left as "DIRECT_CHARGE" for backward compatibility with the
  // legacy one-shot multi-seller endpoint's existing test coverage.
  subOrderId = null,
  isGuest = false,
  customerEmail = null,
}) {
  const metadata = {
    orderId: order.id,
    displayOrderId: order.displayId || order.id,
    sellerId,
    sellerStripeAccountId,
    paymentFlow: "DIRECT_CHARGE",
    productAmount: (Number(productAmountCents || 0) / 100).toFixed(2),
    shippingAmount: (Number(shippingAmountCents || 0) / 100).toFixed(2),
    gstAmount: (Number(gstAmountCents || 0) / 100).toFixed(2),
    commissionRate: String(commission?.commissionRate || "10%"),
    commissionAmount: (Number(commission?.applicationFeeAmount || 0) / 100).toFixed(2),
    guestCheckout: isGuest ? "true" : "false",
    environment: process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ? "test" : "live",
  };
  if (subOrderId) metadata.subOrderId = subOrderId;
  if (customerEmail) metadata.customerEmail = customerEmail;
  return metadata;
}

async function aggregateParentPaymentStatus(orderId, tx = prisma) {
  if (!tx.orderPaymentRecord?.findMany || !tx.order?.update) return null;
  const paymentRecords = await tx.orderPaymentRecord.findMany({
    where: { orderId },
    select: { paymentStatus: true, refundStatus: true },
  });
  if (!paymentRecords.length) return "PENDING";

  const allPaid = paymentRecords.every((record) => record.paymentStatus === "PAID");
  const anyPaid = paymentRecords.some((record) => record.paymentStatus === "PAID");
  const anyFailed = paymentRecords.some((record) => record.paymentStatus === "FAILED");
  const allRefunded = paymentRecords.every((record) => record.refundStatus === "FULL");
  const anyRefunded = paymentRecords.some((record) => ["PARTIAL", "FULL"].includes(record.refundStatus));

  let paymentStatus = "PENDING";
  if (allRefunded) paymentStatus = "REFUNDED";
  else if (anyRefunded) paymentStatus = "REFUND_PENDING";
  else if (allPaid) paymentStatus = "PAID";
  else if (anyPaid) paymentStatus = "PARTIALLY_PAID";
  else if (anyFailed) paymentStatus = "FAILED";

  await tx.order.update({
    where: { id: orderId },
    data: { paymentStatus },
  });
  return paymentStatus;
}

function buildSellerDirectChargePlan({ sellerId, items, cartCalculations, discountShare = 0 }) {
  const productAmount = getSellerItemsTotal(items);
  const shippingAmount = Number(cartCalculations.shippingCost || 0);
  const gstRatePct = getGstRateFromCartCalculations(cartCalculations);
  const discountedProductAmount = Math.max(0, productAmount - Number(discountShare || 0));
  const { exGst, gst } = getGstInclusiveBreakdown(discountedProductAmount, gstRatePct);
  const grossAmountCents = moneyToMinorUnits(discountedProductAmount + shippingAmount);
  const productAmountCents = moneyToMinorUnits(discountedProductAmount);
  const shippingAmountCents = moneyToMinorUnits(shippingAmount);
  const gstAmountCents = moneyToMinorUnits(gst);
  const commission = calculateAlpaCommission({
    eligibleProductSubtotalCents: moneyToMinorUnits(exGst),
    currency: "aud",
  });

  return {
    sellerId,
    items,
    productAmount,
    discountedProductAmount,
    shippingAmount,
    grossAmountCents,
    productAmountCents,
    shippingAmountCents,
    gstAmountCents,
    commission,
  };
}

function buildSellerPlatformPaymentPlan({ sellerId, items, cartCalculations, discountShare = 0 }) {
  const productAmount = getSellerItemsTotal(items);
  const shippingAmount = Number(cartCalculations.shippingCost || 0);
  const gstRatePct = getGstRateFromCartCalculations(cartCalculations);
  const discountedProductAmount = Math.max(0, productAmount - Number(discountShare || 0));
  const { gst } = getGstInclusiveBreakdown(discountedProductAmount, gstRatePct);
  const grossAmountCents = moneyToMinorUnits(discountedProductAmount + shippingAmount);

  return {
    sellerId,
    items,
    paymentAccountType: "PLATFORM",
    productAmount,
    discountedProductAmount,
    shippingAmount,
    grossAmountCents,
    productAmountCents: moneyToMinorUnits(discountedProductAmount),
    shippingAmountCents: moneyToMinorUnits(shippingAmount),
    gstAmountCents: moneyToMinorUnits(gst),
    commission: {
      commissionBase: 0,
      applicationFeeAmount: 0,
      currency: "aud",
    },
  };
}

function buildPaymentRecordCommissionOverrides(paymentRecord) {
  if (!paymentRecord) return {};
  if (paymentRecord.paymentFlow === "PLATFORM_ACCOUNT") {
    return {
      commissionAmountOverride: 0,
      netPayableOverride: 0,
      productValueExGSTOverride: 0,
      gstAmountOverride: Number(paymentRecord.gstAmount || 0) / 100,
      status: "PAID",
    };
  }
  if (paymentRecord.paymentFlow !== "DIRECT_CHARGE") return {};
  return {
    commissionAmountOverride: Number(paymentRecord.applicationFeeAmount || 0) / 100,
    netPayableOverride: 0,
    productValueExGSTOverride: Number(paymentRecord.commissionBase || 0) / 100,
    gstAmountOverride: Number(paymentRecord.gstAmount || 0) / 100,
    status: "PAID",
  };
}

function itemIsPlatformOwned(item) {
  return item?.product?.ownerType === "PLATFORM" || Boolean(item?.product?.platformAccountId);
}

function sellerIdsForSellerOnlyWorkflows(items) {
  return [
    ...new Set(
      (items || [])
        .filter((item) => !itemIsPlatformOwned(item))
        .map((item) => item.product?.sellerId)
        .filter(Boolean)
    ),
  ];
}

async function getSellerPaymentAccountType(sellerId, tx = prisma) {
  try {
    const sellerProfile = await tx.sellerProfile.findUnique({
      where: { userId: sellerId },
      select: { paymentAccountType: true },
    });
    return sellerProfile?.paymentAccountType || "CONNECTED";
  } catch (_) {
    return "CONNECTED";
  }
}

async function itemsBelongToPlatformOwner(items, tx = prisma) {
  const products = (items || []).map((item) => item.product).filter(Boolean);
  if (products.length > 0 && products.every((product) => Object.prototype.hasOwnProperty.call(product, "ownerType"))) {
    return products.some((product) => product.ownerType === "PLATFORM");
  }

  const productIds = [
    ...new Set(
      (items || [])
        .map((item) => item.product?.id || item.productId)
        .filter(Boolean)
    ),
  ];
  if (!productIds.length) return false;
  if (!tx.product?.findFirst) return false;

  const platformProduct = await tx.product.findFirst({
    where: {
      id: { in: productIds },
      ownerType: "PLATFORM",
      platformAccountId: { not: null },
    },
    select: { id: true },
  });
  return Boolean(platformProduct);
}

async function resolvePaymentAccountTypeForItems({ sellerId, items, tx = prisma }) {
  if (await itemsBelongToPlatformOwner(items, tx)) return "PLATFORM";
  return getSellerPaymentAccountType(sellerId, tx);
}

async function findSellerPaymentRecordForOrder({ orderId, sellerId }) {
  if (prisma.orderPaymentRecord.findFirst) {
    return prisma.orderPaymentRecord.findFirst({
      where: { orderId, sellerId },
      orderBy: { createdAt: "desc" },
    }).catch(() => null);
  }
  if (prisma.orderPaymentRecord.findMany) {
    const records = await prisma.orderPaymentRecord.findMany({
      where: { orderId, sellerId },
    }).catch(() => []);
    return records[0] || null;
  }
  return null;
}

async function buildSellerPaymentPlan({ sellerId, items, cartCalculations, discountShare = 0 }) {
  const paymentAccountType = await resolvePaymentAccountTypeForItems({ sellerId, items });
  if (paymentAccountType === "PLATFORM") {
    return buildSellerPlatformPaymentPlan({ sellerId, items, cartCalculations, discountShare });
  }
  const { stripeAccountId } = await requireDirectChargeReadySeller(sellerId);
  return {
    ...buildSellerDirectChargePlan({ sellerId, items, cartCalculations, discountShare }),
    paymentAccountType: "CONNECTED",
    stripeAccountId,
  };
}

function buildPaymentCompletionOutboxRows({ order, paymentIntentId, sellerIds }) {
  const basePayload = {
    orderId: order.id,
    displayId: order.displayId || order.id,
    paymentIntentId,
  };

  const rows = [
    {
      orderId: order.id,
      stripePaymentIntentId: paymentIntentId,
      type: "CUSTOMER_CONFIRMATION",
      payload: {
        ...basePayload,
        customerEmail: order.customerEmail || null,
        customerName: order.customerName || null,
      },
    },
    {
      orderId: order.id,
      stripePaymentIntentId: paymentIntentId,
      type: "ADMIN_NEW_ORDER_NOTIFICATION",
      payload: basePayload,
    },
  ];

  rows.push({
    orderId: order.id,
    stripePaymentIntentId: paymentIntentId,
    type: "SELLER_NEW_ORDER_NOTIFICATION",
    payload: { ...basePayload, sellerIds },
  });
  rows.push({
    orderId: order.id,
    stripePaymentIntentId: paymentIntentId,
    type: "SELLER_PAYMENT_NOTIFICATION",
    payload: { ...basePayload, sellerIds },
  });

  return rows;
}

exports.buildPaymentCompletionOutboxRows = buildPaymentCompletionOutboxRows;

function directChargeReadinessError(code, detail = null) {
  const error = new Error(DIRECT_CHARGE_READINESS_MESSAGES[code] || DIRECT_CHARGE_READINESS_MESSAGES.SELLER_LOOKUP_FAILED);
  error.code = code;
  error.detail = detail;
  error.statusCode = 409;
  return error;
}

async function requireDirectChargeReadySeller(sellerId, currency = "aud") {
  const readiness = await checkSellerPaymentReadiness({ prisma, stripe, sellerId, currency });
  if (!readiness.ready) throw directChargeReadinessError(readiness.reason, readiness.detail);
  return {
    stripeAccountId: readiness.stripeAccountId,
    account: readiness.account,
  };
}

function logStripeApiError(error) {
  console.error("[STRIPE TEST] Stripe API error", {
    type: error?.type,
    code: error?.code,
    message: error?.message,
    requestId: error?.requestId,
    statusCode: error?.statusCode,
  });
}

function truncateStripeDescription(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= STRIPE_DESCRIPTION_MAX_LENGTH) return text;
  return `${text.slice(0, STRIPE_DESCRIPTION_MAX_LENGTH - 3).trim()}...`;
}

function buildItemSummary(items = [], maxItems = 3) {
  const summary = items
    .map((item) => {
      const title = item.product?.title || item.title || "Item";
      const qty = item.quantity || 1;
      return `${qty}x ${title}`;
    })
    .filter(Boolean);

  if (summary.length <= maxItems) return summary.join(", ");
  return `${summary.slice(0, maxItems).join(", ")} +${summary.length - maxItems} more`;
}

function buildSellerTransactionDescription({
  order,
  customerName,
  customerEmail,
  items = [],
  amount,
  label = "Seller transfer",
  platformFee = null,
  gstAmount = null,
  shippingAmount = null,
}) {
  // If order is a SubOrder with subDisplayId, use it; otherwise fallback to displayId or id
  const displayId = order?.subDisplayId || order?.displayId || order?.id || "unknown";
  const itemSummary = buildItemSummary(items);
  const amountText = amount !== undefined && amount !== null ? ` | Amount A$${Number(amount).toFixed(2)}` : "";
  const customerBits = [customerName, customerEmail].filter(Boolean).join(" / ");
  
  // Build fees breakdown for display
  let feesBreakdown = "";
  if (platformFee !== null || gstAmount !== null || shippingAmount !== null) {
    const feeParts = [];
    if (platformFee !== null && platformFee > 0) feeParts.push(`Platform Fee A$${Number(platformFee).toFixed(2)}`);
    if (gstAmount !== null && gstAmount > 0) feeParts.push(`GST A$${Number(gstAmount).toFixed(2)}`);
    if (shippingAmount !== null && shippingAmount > 0) feeParts.push(`Shipping A$${Number(shippingAmount).toFixed(2)}`);
    if (feeParts.length > 0) {
      feesBreakdown = ` | Fees: ${feeParts.join(", ")}`;
    }
  }
  
  // ✅ CRITICAL: Always use the display ID (with -A, -B suffix), never the database ID
  return truncateStripeDescription(
    `Order ${displayId} | ${label} | Customer: ${customerBits || "N/A"} | Items: ${itemSummary || "Order items"}${amountText}${feesBreakdown}`
  );
}

function stripeMetadataValue(value) {
  return String(value ?? "").slice(0, 500);
}

function buildSellerStripeOrderMetadata({ order, subOrder = null, sellerId, customerName, customerEmail, items = [], amount }) {
  const itemCount = items.reduce((sum, item) => sum + (item.quantity || 0), 0);
  const orderId = subOrder?.id || order?.id;
  const displayId = subOrder?.subDisplayId || order?.displayId || order?.id;
  return {
    orderId:       stripeMetadataValue(orderId),
    displayId:     stripeMetadataValue(displayId),
    parentOrderId: stripeMetadataValue(order?.id),
    parentDisplayId: stripeMetadataValue(order?.displayId || order?.id),
    subOrderId:    stripeMetadataValue(subOrder?.id),
    subDisplayId:  stripeMetadataValue(subOrder?.subDisplayId),
    sellerId:      stripeMetadataValue(sellerId),
    customerName:  stripeMetadataValue(customerName || order?.customerName),
    customerEmail: stripeMetadataValue(customerEmail || order?.customerEmail),
    customerPhone: stripeMetadataValue(order?.customerPhone),
    itemSummary:   stripeMetadataValue(buildItemSummary(items)),
    itemCount:     stripeMetadataValue(itemCount),
    orderTotal:    amount !== undefined && amount !== null ? Number(amount).toFixed(2) : "",
  };
}

async function updateConnectedAccountDestinationPayment({ transferId, stripeAccountId, description, metadata }) {
  if (!transferId || !stripeAccountId) return;

  const transfer = await stripe.transfers.retrieve(transferId);
  const destinationPaymentId = transfer.destination_payment;
  if (!destinationPaymentId) return;

  await stripe.charges.update(
    destinationPaymentId,
    { description, metadata },
    { stripeAccount: stripeAccountId }
  );
}

async function getOrderStripeAccountId(order) {
  if (!order?.sellerId) return null;
  const sellerProfile = await prisma.sellerProfile.findUnique({
    where: { userId: order.sellerId },
    select: { stripeAccountId: true },
  });
  return sellerProfile?.stripeAccountId || null;
}

async function retrievePaymentIntentForOrder(paymentIntentId, order) {
  try {
    return {
      paymentIntent: await stripe.paymentIntents.retrieve(paymentIntentId),
      stripeAccountId: null,
    };
  } catch (platformErr) {
    const stripeAccountId = await getOrderStripeAccountId(order);
    if (!stripeAccountId) throw platformErr;
    return {
      paymentIntent: await stripe.paymentIntents.retrieve(paymentIntentId, {
        stripeAccount: stripeAccountId,
      }),
      stripeAccountId,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Create Stripe PaymentIntent + Pending Order
// POST /api/payments/create-intent
// Body: { shippingAddress, shippingMethodId, gstId, country, city, zipCode, state, mobileNumber }
// ─────────────────────────────────────────────────────────────────────────────
exports.createPaymentIntent = async (request, reply) => {
  let checkoutApiOperationKey = null;
  try {
    const userId = request.user.userId;
    const {
      shippingAddress,
      shippingMethodId,
      internationalCountry,
      gstId,
      country,
      city,
      zipCode,
      state,
      mobileNumber,
    } = request.body;

    const effectiveIntlCountry = (internationalCountry || country || '').trim();
    const isInternational = !!effectiveIntlCountry && effectiveIntlCountry.toLowerCase() !== 'australia';

    if (!shippingAddress || (!shippingMethodId && !isInternational)) {
      return reply.status(400).send({
        success: false,
        message: "shippingAddress and a shipping method (or international destination country) are required",
      });
    }

    // Get user
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.status(404).send({ success: false, message: "User not found" });
    }

    // Get cart
    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true, productVariant: true } } },
    });

    if (!cart || cart.items.length === 0) {
      return reply.status(400).send({ success: false, message: "Cart is empty" });
    }

    // Resolve shipping method — international uses zone lookup, domestic uses DB
    let shippingMethod;
    let intlZoneEntry = null;
    if (isInternational) {
      intlZoneEntry = lookupZone(effectiveIntlCountry);
      shippingMethod = {
        id: null,
        name: `International (${effectiveIntlCountry})`,
        cost: intlZoneEntry.cost,
        estimatedDays: '10-20 business days',
      };
    } else {
      shippingMethod = await prisma.shippingMethod.findUnique({
        where: { id: shippingMethodId, isActive: true },
      });
      if (!shippingMethod) {
        return reply.status(400).send({
          success: false,
          message: "Invalid or inactive shipping method",
        });
      }
    }

    // Stock check — use variant stock for VARIABLE products
    for (const item of cart.items) {
      const availableStock = item.productVariant
        ? item.productVariant.stock
        : (item.product.stock ?? 0);
      if (availableStock < item.quantity) {
        return reply.status(400).send({
          success: false,
          message: `Insufficient stock for: ${item.product.title}`,
        });
      }
    }

    // Calculate totals — pass international cost as 4th arg when applicable
    const cartCalculations = await calculateCartTotals(
      cart.items,
      isInternational ? null : shippingMethodId,
      gstId,
      isInternational ? intlZoneEntry.cost : null
    );
    const totalAmount = parseFloat(cartCalculations.grandTotal);

    // Stripe expects amount in smallest currency unit (cents for AUD)
    const amountInCents = Math.round(totalAmount * 100);

    // Build per-seller map before creating the PaymentIntent so single-seller
    // checkout can use a Direct Charge with application_fee_amount.
    const sellerItemsMap = new Map();
    for (const item of cart.items) {
      const sid = item.product.sellerId;
      if (!sellerItemsMap.has(sid)) sellerItemsMap.set(sid, []);
      sellerItemsMap.get(sid).push(item);
    }
    const isMultiSeller = sellerItemsMap.size > 1;
    if (isMultiSeller) {
      console.log("[STRIPE TEST] Phase 2A multi-seller Direct Charge checkout", {
        sellerCount: sellerItemsMap.size,
      });
    }
    const displayId = await generateDisplayId();
    const checkoutPaymentDescription = buildSellerTransactionDescription({
      order: { id: displayId, displayId },
      customerName: user.isDeleted ? 'Deleted User' : user.name,
      customerEmail: user.email,
      items: cart.items,
      amount: totalAmount,
      label: "Seller payment",
    });

    // Single-seller: true Direct Charge — PaymentIntent created on the seller's
    // connected Stripe account. Stripe deducts its fee from that account. ALPA
    // receives application_fee_amount as its 10% commission.
    // Multi-seller checkout is rejected above. The platform-owned Separate
    // Charges and Transfers code below is legacy-only for historical payments.
    let directChargeParams = {};
    let paymentIntentStripeAccountId = null;
    let directChargePaymentRecord = null;
    let singleSellerIdForOperation = null;
    
    if (!isMultiSeller && USE_DIRECT_CHARGES_FOR_SINGLE_SELLER) {
      const [singleSellerId] = sellerItemsMap.keys();
      singleSellerIdForOperation = singleSellerId;
      const itemTotal = cart.items.reduce((s, i) => s + Number(i.productVariant?.price ?? i.product.price) * i.quantity, 0);
      const perSellerShipping  = parseFloat(cartCalculations.shippingCost);
      const paymentAccountType = await resolvePaymentAccountTypeForItems({ sellerId: singleSellerId, items: cart.items });
      if (paymentAccountType === "PLATFORM") {
        directChargePaymentRecord = {
          paymentAccountType: "PLATFORM",
          sellerId: singleSellerId,
          itemTotal,
          shippingAmount: perSellerShipping,
          grossAmountCents: amountInCents,
          gstAmountCents: moneyToMinorUnits(cartCalculations.gstAmount),
        };
      } else {
        const { stripeAccountId } = await requireDirectChargeReadySeller(singleSellerId);
        const eligibleSubtotalCents = moneyToMinorUnits(cartCalculations.subtotalExGST);
        const commission = calculateAlpaCommission({
          eligibleProductSubtotalCents: eligibleSubtotalCents,
          currency: "aud",
        });
        // True Direct Charge: PaymentIntent is created on the seller's connected account.
        // Stripe automatically deducts its processing fee from the seller's balance.
        // ALPA's commission flows as application_fee_amount.
        // No transfer_data or on_behalf_of required.
        paymentIntentStripeAccountId = stripeAccountId;
        directChargeParams = {
          application_fee_amount: commission.applicationFeeAmount,
        };
        directChargePaymentRecord = {
          paymentAccountType: "CONNECTED",
          sellerId: singleSellerId,
          stripeAccountId,
          itemTotal,
          shippingAmount: perSellerShipping,
          commission,
          grossAmountCents: amountInCents,
          gstAmountCents: moneyToMinorUnits(cartCalculations.gstAmount),
        };
      }
    }

    const checkoutRequestHash = hashOperationPayload({
      userId,
      cartId: cart.id,
      amountInCents,
      sellerId: singleSellerIdForOperation,
      shippingMethodId: shippingMethodId || null,
      gstId: gstId || null,
      isInternational,
      effectiveIntlCountry,
      items: cart.items.map((item) => ({
        productId: item.product.id,
        variantId: item.variantId || null,
        quantity: item.quantity,
      })),
    });
    checkoutApiOperationKey = checkoutOperationKey({
      scope: "user",
      subjectId: `${userId}:${cart.id}`,
      sellerId: singleSellerIdForOperation,
      amountInCents,
      requestHash: checkoutRequestHash,
    });
    const checkoutOperation = await claimApiOperation({
      operationKey: checkoutApiOperationKey,
      operationType: "PAYMENT_INTENT_CREATE",
      requestHash: checkoutRequestHash,
      attemptNumber: 1,
    });
    if (checkoutOperation.status === "COMPLETED" && checkoutOperation.stripePaymentIntentId) {
      const existingOrder = checkoutOperation.orderId
        ? await prisma.order.findUnique({ where: { id: checkoutOperation.orderId } })
        : await prisma.order.findFirst({ where: { stripePaymentIntentId: checkoutOperation.stripePaymentIntentId } });
      const existingPaymentIntent = await stripe.paymentIntents.retrieve(
        checkoutOperation.stripePaymentIntentId,
        paymentIntentStripeAccountId ? { stripeAccount: paymentIntentStripeAccountId } : undefined,
      );
      return reply.status(200).send({
        success: true,
        clientSecret: existingPaymentIntent.client_secret,
        paymentIntentId: existingPaymentIntent.id,
        orderId: existingOrder?.id || checkoutOperation.orderId,
        displayId: existingOrder?.displayId,
        idempotent: true,
      });
    }
    if (!checkoutOperation.claimedNew && checkoutOperation.status === "STARTED") {
      return reply.status(202).send({
        success: true,
        status: "PAYMENT_CREATION_IN_PROGRESS",
        idempotent: true,
      });
    }

    if (isMultiSeller) {
      const sellerPlans = [];
      for (const [sellerId, items] of sellerItemsMap) {
        sellerPlans.push(await buildSellerPaymentPlan({ sellerId, items, cartCalculations }));
      }

      const shippingAddressData =
        typeof shippingAddress === "string"
          ? { address: shippingAddress }
          : {
              ...shippingAddress,
              orderSummary: {
                subtotal: cartCalculations.subtotal,
                subtotalExGST: cartCalculations.subtotalExGST,
                shippingCost: cartCalculations.shippingCost,
                totalShippingCost: cartCalculations.totalShippingCost,
                sellerCount: cartCalculations.sellerCount,
                gstPercentage: cartCalculations.gstPercentage,
                gstAmount: cartCalculations.gstAmount,
                grandTotal: cartCalculations.grandTotal,
                gstInclusive: true,
                shippingMethod: {
                  id: shippingMethod.id,
                  name: shippingMethod.name,
                  cost: shippingMethod.cost,
                  estimatedDays: shippingMethod.estimatedDays,
                },
                gstDetails: cartCalculations.gstDetails,
              },
            };

      const order = await prisma.$transaction(async (tx) => {
        const parentOrder = await tx.order.create({
          data: {
            displayId,
            userId,
            totalAmount,
            shippingAddress: shippingAddressData,
            shippingAddressLine:
              typeof shippingAddress === "string"
                ? shippingAddress
                : shippingAddress?.shippingAddress || shippingAddress?.addressLine || shippingAddress?.address || "",
            shippingCity: city || shippingAddress?.city || "",
            shippingState: state || shippingAddress?.state || "",
            shippingZipCode: zipCode || shippingAddress?.zipCode || "",
            shippingCountry: country || shippingAddress?.country || "Australia",
            shippingPhone: mobileNumber || shippingAddress?.mobileNumber || user.phone || "",
            paymentMethod: "Credit/Debit Card",
            status: "PENDING",
            overallStatus: "PENDING",
            paymentStatus: "PENDING",
            customerName: user.isDeleted ? "Deleted User" : user.name,
            customerEmail: user.email,
            customerPhone: mobileNumber || user.phone || "",
          },
        });

        for (const plan of sellerPlans) {
          const subOrderSubtotal = plan.discountedProductAmount + plan.shippingAmount;
          const subOrder = await tx.subOrder.create({
            data: {
              parentOrderId: parentOrder.id,
              sellerId: plan.sellerId,
              subtotal: subOrderSubtotal,
              status: "PENDING",
            },
          });
          await tx.orderItem.createMany({
            data: plan.items.map((i) => ({
              subOrderId: subOrder.id,
              productId: i.product.id,
              variantId: i.variantId || null,
              quantity: i.quantity,
              price: getItemUnitPrice(i),
            })),
          });
        }
        return parentOrder;
      });

      const payments = [];
      for (const plan of sellerPlans) {
        const isPlatformPayment = plan.paymentAccountType === "PLATFORM";
        const metadata = isPlatformPayment
          ? {
              orderId: order.id,
              displayOrderId: order.displayId || order.id,
              sellerId: plan.sellerId,
              paymentFlow: "PLATFORM_ACCOUNT",
              productAmount: (Number(plan.productAmountCents || 0) / 100).toFixed(2),
              shippingAmount: (Number(plan.shippingAmountCents || 0) / 100).toFixed(2),
              gstAmount: (Number(plan.gstAmountCents || 0) / 100).toFixed(2),
              commissionAmount: "0.00",
              environment: process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ? "test" : "live",
            }
          : buildDirectChargeStripeMetadata({
              order,
              sellerId: plan.sellerId,
              sellerStripeAccountId: plan.stripeAccountId,
              productAmountCents: plan.productAmountCents,
              shippingAmountCents: plan.shippingAmountCents,
              gstAmountCents: plan.gstAmountCents,
              commission: plan.commission,
            });
        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount: plan.grossAmountCents,
            currency: "aud",
            description: buildSellerTransactionDescription({
              order,
              customerName: order.customerName,
              customerEmail: order.customerEmail,
              items: plan.items,
              amount: plan.grossAmountCents / 100,
              label: "Seller payment",
            }),
            metadata: {
              ...metadata,
              userId,
              cartId: cart.id,
              chargeType: isPlatformPayment ? "platform" : "direct",
            },
            automatic_payment_methods: { enabled: true },
            ...(!isPlatformPayment && { application_fee_amount: plan.commission.applicationFeeAmount }),
          },
          {
            idempotencyKey: `${checkoutApiOperationKey}:${plan.sellerId}`,
            ...(!isPlatformPayment && { stripeAccount: plan.stripeAccountId }),
          },
        );

        const paymentRecord = await prisma.orderPaymentRecord.create({
          data: isPlatformPayment
            ? buildPlatformPaymentRecordData({
                orderId: order.id,
                sellerId: plan.sellerId,
                stripePaymentIntentId: paymentIntent.id,
                itemTotal: plan.discountedProductAmount,
                shippingAmount: plan.shippingAmount,
                grossAmountCents: plan.grossAmountCents,
                gstAmountCents: plan.gstAmountCents,
              })
            : buildDirectChargePaymentRecordData({
                orderId: order.id,
                sellerId: plan.sellerId,
                stripeAccountId: plan.stripeAccountId,
                stripePaymentIntentId: paymentIntent.id,
                itemTotal: plan.discountedProductAmount,
                shippingAmount: plan.shippingAmount,
                commission: plan.commission,
                grossAmountCents: plan.grossAmountCents,
                gstAmountCents: plan.gstAmountCents,
              }),
        });

        payments.push({
          orderPaymentId: paymentRecord.id,
          sellerId: plan.sellerId,
          stripeAccountId: isPlatformPayment ? null : plan.stripeAccountId,
          paymentFlow: isPlatformPayment ? "PLATFORM_ACCOUNT" : "DIRECT_CHARGE",
          paymentIntentId: paymentIntent.id,
          clientSecret: paymentIntent.client_secret,
          amount: plan.grossAmountCents,
          currency: "aud",
        });
      }

      await aggregateParentPaymentStatus(order.id);
      await markApiOperationCompleted({
        operationKey: checkoutApiOperationKey,
        stripePaymentIntentId: payments[0]?.paymentIntentId || null,
        orderId: order.id,
      });

      return reply.status(200).send({
        success: true,
        orderId: order.id,
        displayId: order.displayId,
        amount: amountInCents,
        displayAmount: totalAmount,
        currency: "aud",
        paymentFlow: "DIRECT_CHARGE",
        payments,
        orderSummary: {
          subtotal: cartCalculations.subtotal,
          subtotalExGST: cartCalculations.subtotalExGST,
          shippingCost: cartCalculations.shippingCost,
          totalShippingCost: cartCalculations.totalShippingCost,
          sellerCount: cartCalculations.sellerCount,
          gstAmount: cartCalculations.gstAmount,
          grandTotal: cartCalculations.grandTotal,
        },
      });
    }

    console.log("[STRIPE TEST] Payment creation started", {
      mode: process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ? "test" : "not-test",
      orderId: displayId,
      sellerCount: sellerItemsMap.size,
      amount: amountInCents,
      currency: "aud",
    });

    // Create Stripe PaymentIntent.
    // Single-seller: created on the seller's connected account (true Direct Charge).
    //   → Stripe deducts its fee from the connected account automatically.
    //   → ALPA receives application_fee_amount as commission.
    // Multi-seller: created on the platform account (Separate Charges + Transfers).
    //   → Stripe fee deducted proportionally from each seller's transfer.
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountInCents,
        currency: "aud",
        description: checkoutPaymentDescription,
        metadata: {
          userId,
          cartId: cart.id,
          chargeType: paymentIntentStripeAccountId ? 'direct' : 'platform',
        },
        automatic_payment_methods: { enabled: true },
        ...directChargeParams,
      },
      {
        // Idempotency key: prevents duplicate PaymentIntents if the request
        // is retried (network error, double-tap, etc.).
        idempotencyKey: checkoutApiOperationKey,
        ...(paymentIntentStripeAccountId && { stripeAccount: paymentIntentStripeAccountId }),
      },
    );

    console.log("[STRIPE TEST] Payment object created", {
      objectType: paymentIntent.object,
      id: paymentIntent.id,
      status: paymentIntent.status,
      livemode: paymentIntent.livemode,
      amount: paymentIntent.amount,
      connectedAccountId: paymentIntentStripeAccountId,
      requestId: paymentIntent.lastResponse?.requestId || null,
    });

    // Build shippingAddress JSON with order summary
    const shippingAddressData =
         typeof shippingAddress === "string"
        ? { address: shippingAddress }
        : {
            ...shippingAddress,
            orderSummary: {
              subtotal: cartCalculations.subtotal,
              subtotalExGST: cartCalculations.subtotalExGST,
              shippingCost: cartCalculations.shippingCost,
              totalShippingCost: cartCalculations.totalShippingCost,
              sellerCount: cartCalculations.sellerCount,
              gstPercentage: cartCalculations.gstPercentage,
              gstAmount: cartCalculations.gstAmount,
              grandTotal: cartCalculations.grandTotal,
              gstInclusive: true,
              shippingMethod: {
                id: shippingMethod.id,
                name: shippingMethod.name,
                cost: shippingMethod.cost,
                estimatedDays: shippingMethod.estimatedDays,
              },
              gstDetails: cartCalculations.gstDetails,
            },
          };

    const orderBaseData = {
      displayId,
      userId,
      totalAmount,
      shippingAddress: shippingAddressData,
      shippingAddressLine:
        typeof shippingAddress === "string"
          ? shippingAddress
          : shippingAddress?.shippingAddress || shippingAddress?.addressLine || shippingAddress?.address || "",
      shippingCity: city || shippingAddress?.city || "",
      shippingState: state || shippingAddress?.state || "",
      shippingZipCode: zipCode || shippingAddress?.zipCode || "",
      shippingCountry: country || shippingAddress?.country || "Australia",
      shippingPhone: mobileNumber || shippingAddress?.mobileNumber || user.phone || "",
      paymentMethod: "Credit/Debit Card",
      status: "CONFIRMED",
      paymentStatus: "PENDING",
      stripePaymentIntentId: paymentIntent.id,
      customerName: user.isDeleted ? 'Deleted User' : user.name,
      customerEmail: user.email,
      customerPhone: mobileNumber || user.phone || "",
    };

    // Create PENDING order — single seller sets sellerId directly; multi-seller uses sub-orders
    let order;
    if (isMultiSeller) {
      const perSellerShipping = parseFloat(cartCalculations.shippingCost);
      order = await prisma.$transaction(async (tx) => {
        const parentOrder = await tx.order.create({ data: orderBaseData });
        for (const [sellerId, items] of sellerItemsMap) {
          const productsSubtotal = items.reduce((sum, i) => sum + Number(i.product.price) * i.quantity, 0);
          const subOrderSubtotal = productsSubtotal + perSellerShipping;
          const subOrder = await tx.subOrder.create({
            data: { parentOrderId: parentOrder.id, sellerId, subtotal: subOrderSubtotal, status: "CONFIRMED" }
          });
          await tx.orderItem.createMany({
            data: items.map(i => ({
              subOrderId: subOrder.id,
              productId: i.product.id,
              variantId: i.variantId || null,
              quantity: i.quantity,
              price: Number(i.productVariant?.price ?? i.product.price),
            }))
          });
        }
        return parentOrder;
      });
    } else {
      const [sellerId] = sellerItemsMap.keys();
      order = await prisma.$transaction(async (tx) => {
        const createdOrder = await tx.order.create({
          data: {
            ...orderBaseData,
            sellerId,
            items: { create: cart.items.map(i => ({
              productId: i.product.id,
              variantId: i.variantId || null,
              quantity: i.quantity,
              price: Number(i.productVariant?.price ?? i.product.price),
            })) }
          },
          include: { items: { include: { product: true } } },
        });
        if (directChargePaymentRecord) {
          const isPlatformPayment = directChargePaymentRecord.paymentAccountType === "PLATFORM";
          await tx.orderPaymentRecord.create({
            data: isPlatformPayment
              ? buildPlatformPaymentRecordData({
                  orderId: createdOrder.id,
                  stripePaymentIntentId: paymentIntent.id,
                  sellerId: directChargePaymentRecord.sellerId,
                  itemTotal: directChargePaymentRecord.itemTotal,
                  shippingAmount: directChargePaymentRecord.shippingAmount,
                  grossAmountCents: directChargePaymentRecord.grossAmountCents,
                  gstAmountCents: directChargePaymentRecord.gstAmountCents,
                })
              : buildDirectChargePaymentRecordData({
                  orderId: createdOrder.id,
                  stripePaymentIntentId: paymentIntent.id,
                  ...directChargePaymentRecord,
                }),
          });
        }
        return createdOrder;
      });
    }

    const stripeOrderDescription = buildSellerTransactionDescription({
      order,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      items: cart.items,
      amount: totalAmount,
      label: "Made in Arnhem Land",
    });

    if (paymentIntentStripeAccountId) {
      // Reuse the shared Direct Charge metadata builder (same one the
      // multi-seller flows use) so single-seller PaymentIntents carry the
      // same reconciliation fields — this is metadata only, no amount or
      // application_fee_amount change.
      const directChargeMetadata = directChargePaymentRecord
        ? buildDirectChargeStripeMetadata({
            order,
            sellerId: directChargePaymentRecord.sellerId,
            sellerStripeAccountId: directChargePaymentRecord.stripeAccountId,
            productAmountCents: moneyToMinorUnits(directChargePaymentRecord.itemTotal),
            shippingAmountCents: moneyToMinorUnits(directChargePaymentRecord.shippingAmount),
            gstAmountCents: directChargePaymentRecord.gstAmountCents,
            commission: directChargePaymentRecord.commission,
            isGuest: false,
            customerEmail: order.customerEmail,
          })
        : {};
      await stripe.paymentIntents.update(paymentIntent.id, {
        metadata: {
          ...directChargeMetadata,
          paymentFlow: "DIRECT_CHARGE_SINGLE_SELLER",
          userId,
          cartId:       cart.id,
          orderId:      order.id,
          displayId:    order.displayId,
          customerName: order.customerName || "",
          customerEmail: order.customerEmail || "",
          itemSummary:  buildItemSummary(cart.items),
          orderTotal:   totalAmount.toFixed(2),
        },
        description: stripeOrderDescription,
      }, { stripeAccount: paymentIntentStripeAccountId });
    } else {
    // Update PaymentIntent metadata with order ID so it's visible in Stripe Dashboard
    await stripe.paymentIntents.update(paymentIntent.id, {
      metadata: {
        userId,
        cartId:       cart.id,
        orderId:      order.id,
        displayId:    order.displayId,
        customerName: order.customerName || "",
        customerEmail: order.customerEmail || "",
        itemSummary:  buildItemSummary(cart.items),
        orderTotal:   totalAmount.toFixed(2),
      },
      description: `Order ${order.displayId} — Made in Arnhem Land`,
    });

    await stripe.paymentIntents.update(paymentIntent.id, {
      description: stripeOrderDescription,
    });
    }

    await markApiOperationCompleted({
      operationKey: checkoutApiOperationKey,
      stripePaymentIntentId: paymentIntent.id,
      orderId: order.id,
    });

    return reply.status(200).send({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      stripeAccountId: paymentIntentStripeAccountId,
      orderId: order.id,
      displayId: order.displayId,
      amount: amountInCents,        // in cents (Stripe standard) — e.g. 9500 for $95.00 AUD
      displayAmount: totalAmount,   // in dollars, for UI display only — e.g. 95.00
      currency: "aud",
      orderSummary: {
        subtotal: cartCalculations.subtotal,
        subtotalExGST: cartCalculations.subtotalExGST,
        shippingCost: cartCalculations.shippingCost,
        totalShippingCost: cartCalculations.totalShippingCost,
        sellerCount: cartCalculations.sellerCount,
        gstAmount: cartCalculations.gstAmount,
        gstPercentage: cartCalculations.gstPercentage,
        gstInclusive: true,
        grandTotal: cartCalculations.grandTotal,
      },
    });
  } catch (error) {
    if (checkoutApiOperationKey) {
      try {
        await markApiOperationFailed({ operationKey: checkoutApiOperationKey, error });
      } catch (_) { /* best effort */ }
    }
    if (error?.statusCode === 409 && error?.code) {
      console.warn("[STRIPE TEST] Direct Charge readiness blocked checkout", {
        code: error.code,
        message: error.message,
      });
      return reply.status(409).send({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    logStripeApiError(error);
    console.error("❌ createPaymentIntent error:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to create payment intent",
      error: error.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Multi-seller "single checkout" flow (collect the card once, charge each
// seller's Direct Charge PaymentIntent separately). Verified against
// docs.stripe.com/connect/direct-charges-multiple-accounts — the customer's
// PaymentMethod is collected once on the PLATFORM account via SetupIntent,
// then cloned per connected account with stripe.paymentMethods.create(
// { customer, payment_method }, { stripeAccount }) and used to confirm a
// normal Direct Charge PaymentIntent (application_fee_amount, no
// transfer_data/destination, no stripe.transfers.create()) on each seller's
// own account. Single-seller checkout is untouched — it keeps using
// /create-intent above.
// ─────────────────────────────────────────────────────────────────────────────

// STEP 1 — Build the order + per-seller plan, collect the card once via a
// platform-account SetupIntent.
// POST /api/payments/multi-seller/setup
// ─────────────────────────────────────────────────────────────────────────────
exports.createMultiSellerCheckoutSetup = async (request, reply) => {
  let checkoutApiOperationKey = null;
  try {
    const userId = request.user.userId;
    const {
      shippingAddress,
      shippingMethodId,
      internationalCountry,
      gstId,
      country,
      city,
      zipCode,
      state,
      mobileNumber,
    } = request.body;

    const effectiveIntlCountry = (internationalCountry || country || '').trim();
    const isInternational = !!effectiveIntlCountry && effectiveIntlCountry.toLowerCase() !== 'australia';

    if (!shippingAddress || (!shippingMethodId && !isInternational)) {
      return reply.status(400).send({
        success: false,
        message: "shippingAddress and a shipping method (or international destination country) are required",
      });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.status(404).send({ success: false, message: "User not found" });
    }

    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true, productVariant: true } } },
    });

    if (!cart || cart.items.length === 0) {
      return reply.status(400).send({ success: false, message: "Cart is empty" });
    }

    let shippingMethod;
    let intlZoneEntry = null;
    if (isInternational) {
      intlZoneEntry = lookupZone(effectiveIntlCountry);
      shippingMethod = {
        id: null,
        name: `International (${effectiveIntlCountry})`,
        cost: intlZoneEntry.cost,
        estimatedDays: '10-20 business days',
      };
    } else {
      shippingMethod = await prisma.shippingMethod.findUnique({
        where: { id: shippingMethodId, isActive: true },
      });
      if (!shippingMethod) {
        return reply.status(400).send({ success: false, message: "Invalid or inactive shipping method" });
      }
    }

    for (const item of cart.items) {
      const availableStock = item.productVariant ? item.productVariant.stock : (item.product.stock ?? 0);
      if (availableStock < item.quantity) {
        return reply.status(400).send({ success: false, message: `Insufficient stock for: ${item.product.title}` });
      }
    }

    const cartCalculations = await calculateCartTotals(
      cart.items,
      isInternational ? null : shippingMethodId,
      gstId,
      isInternational ? intlZoneEntry.cost : null
    );
    const totalAmount = parseFloat(cartCalculations.grandTotal);
    const amountInCents = Math.round(totalAmount * 100);

    const sellerItemsMap = new Map();
    for (const item of cart.items) {
      const sid = item.product.sellerId;
      if (!sellerItemsMap.has(sid)) sellerItemsMap.set(sid, []);
      sellerItemsMap.get(sid).push(item);
    }

    if (sellerItemsMap.size <= 1) {
      return reply.status(400).send({
        success: false,
        message: "This cart has a single seller — use /api/payments/create-intent instead.",
      });
    }

    const displayId = await generateDisplayId();

    const checkoutRequestHash = hashOperationPayload({
      userId,
      cartId: cart.id,
      amountInCents,
      shippingMethodId: shippingMethodId || null,
      gstId: gstId || null,
      isInternational,
      effectiveIntlCountry,
      items: cart.items.map((item) => ({
        productId: item.product.id,
        variantId: item.variantId || null,
        quantity: item.quantity,
      })),
    });
    checkoutApiOperationKey = checkoutOperationKey({
      scope: "user",
      subjectId: `${userId}:${cart.id}`,
      sellerId: "multi-seller",
      amountInCents,
      requestHash: checkoutRequestHash,
    });
    const checkoutOperation = await claimApiOperation({
      operationKey: checkoutApiOperationKey,
      operationType: "MULTI_SELLER_SETUP_CREATE",
      requestHash: checkoutRequestHash,
      attemptNumber: 1,
    });
    if (checkoutOperation.status === "COMPLETED" && checkoutOperation.orderId) {
      const existingOrder = await prisma.order.findUnique({
        where: { id: checkoutOperation.orderId },
        include: { multiSellerCheckoutSession: true },
      });
      if (existingOrder?.multiSellerCheckoutSession) {
        const existingSetupIntent = await stripe.setupIntents.retrieve(
          existingOrder.multiSellerCheckoutSession.platformSetupIntentId,
        );
        return reply.status(200).send({
          success: true,
          orderId: existingOrder.id,
          displayId: existingOrder.displayId,
          clientSecret: existingSetupIntent.client_secret,
          amount: amountInCents,
          displayAmount: totalAmount,
          currency: "aud",
          sellerBreakdown: existingOrder.shippingAddress?.orderSummary?.multiSellerPlan || [],
          idempotent: true,
        });
      }
    }
    if (!checkoutOperation.claimedNew && checkoutOperation.status === "STARTED") {
      return reply.status(202).send({ success: true, status: "PAYMENT_CREATION_IN_PROGRESS", idempotent: true });
    }

    // Build each seller's Direct Charge plan up-front — reuses the exact same
    // math as the single-request multi-seller flow so amounts can never drift
    // between what's shown at checkout and what's charged at finalize time.
    const sellerPlans = [];
    for (const [sellerId, items] of sellerItemsMap) {
      sellerPlans.push(await buildSellerPaymentPlan({ sellerId, items, cartCalculations }));
    }

    const shippingAddressData =
      typeof shippingAddress === "string"
        ? { address: shippingAddress }
        : {
            ...shippingAddress,
            orderSummary: {
              subtotal: cartCalculations.subtotal,
              subtotalExGST: cartCalculations.subtotalExGST,
              shippingCost: cartCalculations.shippingCost,
              totalShippingCost: cartCalculations.totalShippingCost,
              sellerCount: cartCalculations.sellerCount,
              gstPercentage: cartCalculations.gstPercentage,
              gstAmount: cartCalculations.gstAmount,
              grandTotal: cartCalculations.grandTotal,
              gstInclusive: true,
              shippingMethod: {
                id: shippingMethod.id,
                name: shippingMethod.name,
                cost: shippingMethod.cost,
                estimatedDays: shippingMethod.estimatedDays,
              },
              gstDetails: cartCalculations.gstDetails,
            },
          };

    // ── Create the pending Order + SubOrders (same shape as the existing
    //    multi-seller branch in createPaymentIntent) inside one transaction,
    //    then persist the locked-in seller plan snapshot onto the Order so
    //    /finalize charges exactly what the customer saw at checkout. ──────
    const { order, sellerBreakdown } = await prisma.$transaction(async (tx) => {
      const parentOrder = await tx.order.create({
        data: {
          displayId,
          userId,
          totalAmount,
          shippingAddress: shippingAddressData,
          shippingAddressLine:
            typeof shippingAddress === "string"
              ? shippingAddress
              : shippingAddress?.shippingAddress || shippingAddress?.addressLine || shippingAddress?.address || "",
          shippingCity: city || shippingAddress?.city || "",
          shippingState: state || shippingAddress?.state || "",
          shippingZipCode: zipCode || shippingAddress?.zipCode || "",
          shippingCountry: country || shippingAddress?.country || "Australia",
          shippingPhone: mobileNumber || shippingAddress?.mobileNumber || user.phone || "",
          paymentMethod: "Credit/Debit Card",
          status: "PENDING",
          overallStatus: "PENDING",
          paymentStatus: "PENDING",
          customerName: user.isDeleted ? "Deleted User" : user.name,
          customerEmail: user.email,
          customerPhone: mobileNumber || user.phone || "",
        },
      });

      const breakdown = [];
      for (const plan of sellerPlans) {
        const subOrderSubtotal = plan.discountedProductAmount + plan.shippingAmount;
        const subOrder = await tx.subOrder.create({
          data: {
            parentOrderId: parentOrder.id,
            sellerId: plan.sellerId,
            subtotal: subOrderSubtotal,
            status: "PENDING",
          },
        });
        await tx.orderItem.createMany({
          data: plan.items.map((i) => ({
            subOrderId: subOrder.id,
            productId: i.product.id,
            variantId: i.variantId || null,
            quantity: i.quantity,
            price: getItemUnitPrice(i),
          })),
        });
        breakdown.push({
          sellerId: plan.sellerId,
          subOrderId: subOrder.id,
          stripeAccountId: plan.paymentAccountType === "PLATFORM" ? null : plan.stripeAccountId,
          paymentAccountType: plan.paymentAccountType,
          paymentFlow: plan.paymentAccountType === "PLATFORM" ? "PLATFORM_ACCOUNT" : "DIRECT_CHARGE",
          productAmountCents: plan.productAmountCents,
          shippingAmountCents: plan.shippingAmountCents,
          gstAmountCents: plan.gstAmountCents,
          grossAmountCents: plan.grossAmountCents,
          commission: plan.commission,
        });
      }

      // Lock the plan snapshot onto the order so /finalize never recomputes
      // amounts from a cart that may have since changed.
      await tx.order.update({
        where: { id: parentOrder.id },
        data: {
          shippingAddress: {
            ...shippingAddressData,
            orderSummary: { ...shippingAddressData.orderSummary, multiSellerPlan: breakdown },
          },
        },
      });

      return { order: parentOrder, sellerBreakdown: breakdown };
    });

    // ── Platform-side Customer + SetupIntent — collects the card ONCE. ─────
    const platformCustomer = await stripe.customers.create({
      email: user.email,
      name: user.isDeleted ? "Deleted User" : user.name,
      metadata: { orderId: order.id, displayId: order.displayId, userId },
    }, { idempotencyKey: `${checkoutApiOperationKey}:customer` });

    const setupIntent = await stripe.setupIntents.create({
      customer: platformCustomer.id,
      automatic_payment_methods: { enabled: true },
      metadata: {
        orderId: order.id,
        displayId: order.displayId,
        userId,
        paymentFlow: "DIRECT_CHARGE_MULTI_SELLER",
      },
    }, { idempotencyKey: `${checkoutApiOperationKey}:setup-intent` });

    await prisma.multiSellerCheckoutSession.create({
      data: {
        orderId: order.id,
        platformCustomerId: platformCustomer.id,
        platformSetupIntentId: setupIntent.id,
        status: "COLLECTING_PAYMENT_METHOD",
      },
    });

    await markApiOperationCompleted({
      operationKey: checkoutApiOperationKey,
      stripePaymentIntentId: null,
      orderId: order.id,
    });

    return reply.status(200).send({
      success: true,
      orderId: order.id,
      displayId: order.displayId,
      clientSecret: setupIntent.client_secret,
      amount: amountInCents,
      displayAmount: totalAmount,
      currency: "aud",
      paymentFlow: "DIRECT_CHARGE_MULTI_SELLER",
      sellerBreakdown,
      orderSummary: {
        subtotal: cartCalculations.subtotal,
        subtotalExGST: cartCalculations.subtotalExGST,
        shippingCost: cartCalculations.shippingCost,
        totalShippingCost: cartCalculations.totalShippingCost,
        sellerCount: cartCalculations.sellerCount,
        gstAmount: cartCalculations.gstAmount,
        grandTotal: cartCalculations.grandTotal,
      },
    });
  } catch (error) {
    if (checkoutApiOperationKey) {
      try {
        await markApiOperationFailed({ operationKey: checkoutApiOperationKey, error });
      } catch (_) { /* best effort */ }
    }
    if (error?.statusCode === 409 && error?.code) {
      return reply.status(409).send({ success: false, code: error.code, message: error.message });
    }
    logStripeApiError(error);
    console.error("❌ createMultiSellerCheckoutSetup error:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to set up multi-seller checkout",
      error: error.message,
    });
  }
};

// Shared by the authenticated and guest finalize endpoints: clones the
// platform PaymentMethod to each seller's connected account and confirms that
// seller's own Direct Charge PaymentIntent. `extraMetadata` differs between
// the two callers (userId vs isGuest/customerEmail) — everything else is
// identical, so this is the single place that logic lives.
async function chargeSellerPlansForConnectedAccounts({ order, session, sellerPlans, platformPaymentMethodId, extraMetadata = {} }) {
  const results = [];
  for (const plan of sellerPlans) {
    try {
      if (plan.paymentAccountType === "PLATFORM" || plan.paymentFlow === "PLATFORM_ACCOUNT") {
        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount: plan.grossAmountCents,
            currency: "aud",
            payment_method: platformPaymentMethodId,
            confirm: true,
            automatic_payment_methods: { enabled: true, allow_redirects: "never" },
            description: buildSellerTransactionDescription({
              order,
              customerName: order.customerName,
              customerEmail: order.customerEmail,
              amount: plan.grossAmountCents / 100,
              label: "Platform payment",
            }),
            metadata: {
              orderId: order.id,
              displayOrderId: order.displayId || order.id,
              sellerId: plan.sellerId,
              subOrderId: plan.subOrderId || "",
              paymentFlow: "PLATFORM_ACCOUNT",
              productAmount: (Number(plan.productAmountCents || 0) / 100).toFixed(2),
              shippingAmount: (Number(plan.shippingAmountCents || 0) / 100).toFixed(2),
              gstAmount: (Number(plan.gstAmountCents || 0) / 100).toFixed(2),
              commissionAmount: "0.00",
              ...extraMetadata,
              chargeType: "platform",
            },
          },
          { idempotencyKey: `charge:${order.id}:${plan.sellerId}:platform` },
        );

        await prisma.orderPaymentRecord.create({
          data: buildPlatformPaymentRecordData({
            orderId: order.id,
            sellerId: plan.sellerId,
            stripePaymentIntentId: paymentIntent.id,
            itemTotal: plan.productAmountCents / 100,
            shippingAmount: plan.shippingAmountCents / 100,
            grossAmountCents: plan.grossAmountCents,
            gstAmountCents: plan.gstAmountCents,
            paymentStatus: paymentIntent.status === "succeeded" ? "PAID" : "PENDING",
          }),
        });

        results.push({
          sellerId: plan.sellerId,
          stripeAccountId: null,
          paymentFlow: "PLATFORM_ACCOUNT",
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
          clientSecret: paymentIntent.status === "requires_action" ? paymentIntent.client_secret : undefined,
          amount: plan.grossAmountCents,
          currency: "aud",
        });
        continue;
      }

      // Clone the platform PaymentMethod to this seller's connected account.
      // Verified: docs.stripe.com/connect/direct-charges-multiple-accounts.
      const cloned = await stripe.paymentMethods.create(
        { customer: session.platformCustomerId, payment_method: platformPaymentMethodId },
        { stripeAccount: plan.stripeAccountId, idempotencyKey: `clone:${order.id}:${plan.sellerId}` },
      );

      const metadata = buildDirectChargeStripeMetadata({
        order,
        sellerId: plan.sellerId,
        sellerStripeAccountId: plan.stripeAccountId,
        productAmountCents: plan.productAmountCents,
        shippingAmountCents: plan.shippingAmountCents,
        gstAmountCents: plan.gstAmountCents,
        commission: plan.commission,
        subOrderId: plan.subOrderId || null,
        isGuest: extraMetadata.isGuest === "true",
        customerEmail: extraMetadata.customerEmail || order.customerEmail || null,
      });

      // Plain Direct Charge PaymentIntent — no transfer_data, no
      // destination, no stripe.transfers.create(). Confirmed immediately
      // with the cloned PaymentMethod so the customer never re-enters a card.
      const paymentIntent = await stripe.paymentIntents.create(
        {
          amount: plan.grossAmountCents,
          currency: "aud",
          payment_method: cloned.id,
          confirm: true,
          application_fee_amount: plan.commission.applicationFeeAmount,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          description: buildSellerTransactionDescription({
            order,
            customerName: order.customerName,
            customerEmail: order.customerEmail,
            amount: plan.grossAmountCents / 100,
            label: "Seller payment",
          }),
          // buildDirectChargeStripeMetadata hardcodes paymentFlow: "DIRECT_CHARGE"
          // (correct for the single-seller path it's shared with) — override it
          // here so Stripe Dashboard reconciliation can tell multi-seller Direct
          // Charges apart, per spec.
          metadata: { ...metadata, paymentFlow: "DIRECT_CHARGE_MULTI_SELLER", ...extraMetadata, chargeType: "direct" },
        },
        { idempotencyKey: `charge:${order.id}:${plan.sellerId}`, stripeAccount: plan.stripeAccountId },
      );

      // plan is the persisted breakdown snapshot (cents-only fields) — convert
      // back to dollars for buildDirectChargePaymentRecordData's itemTotal/
      // shippingAmount params, which it re-derives to minor units internally.
      const paymentRecordData = buildDirectChargePaymentRecordData({
        orderId: order.id,
        sellerId: plan.sellerId,
        stripeAccountId: plan.stripeAccountId,
        stripePaymentIntentId: paymentIntent.id,
        itemTotal: plan.productAmountCents / 100,
        shippingAmount: plan.shippingAmountCents / 100,
        commission: plan.commission,
        grossAmountCents: plan.grossAmountCents,
        gstAmountCents: plan.gstAmountCents,
      });
      await prisma.orderPaymentRecord.create({ data: paymentRecordData });

      results.push({
        sellerId: plan.sellerId,
        stripeAccountId: plan.stripeAccountId,
        paymentFlow: "DIRECT_CHARGE",
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status,
        clientSecret: paymentIntent.status === "requires_action" ? paymentIntent.client_secret : undefined,
        amount: plan.grossAmountCents,
        currency: "aud",
      });
    } catch (sellerError) {
      console.error(`[STRIPE TEST] Multi-seller finalize: seller ${plan.sellerId} charge failed:`, sellerError.message);
      // A synchronous decline at confirm:true still creates a real PaymentIntent
      // on Stripe (with last_payment_error set) — the Node SDK exposes it as
      // err.payment_intent. Use that real id for dashboard reconciliation;
      // only fall back to a synthetic id if Stripe didn't return one at all.
      const failedPaymentIntentId =
        sellerError.payment_intent?.id || `failed_${order.id}_${plan.sellerId}_${Date.now()}`;
      await prisma.orderPaymentRecord.create({
        data: buildDirectChargePaymentRecordData({
          orderId: order.id,
          sellerId: plan.sellerId,
          stripeAccountId: plan.stripeAccountId,
          stripePaymentIntentId: failedPaymentIntentId,
          itemTotal: plan.productAmountCents / 100,
          shippingAmount: plan.shippingAmountCents / 100,
          commission: plan.commission,
          grossAmountCents: plan.grossAmountCents,
          gstAmountCents: plan.gstAmountCents,
          paymentStatus: "FAILED",
        }),
      }).catch(() => {});

      results.push({
        sellerId: plan.sellerId,
        stripeAccountId: plan.stripeAccountId,
        paymentFlow: plan.paymentAccountType === "PLATFORM" ? "PLATFORM_ACCOUNT" : "DIRECT_CHARGE",
        status: "failed",
        error: sellerError.message,
      });
    }
  }
  return results;
}

// STEP 2 — Clone the collected PaymentMethod to each seller's connected
// account and confirm each seller's own Direct Charge PaymentIntent.
// POST /api/payments/multi-seller/finalize
// Body: { orderId }
// ─────────────────────────────────────────────────────────────────────────────
exports.finalizeMultiSellerCheckout = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { orderId } = request.body;
    if (!orderId) {
      return reply.status(400).send({ success: false, message: "orderId is required" });
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { multiSellerCheckoutSession: true },
    });
    if (!order) {
      return reply.status(404).send({ success: false, message: "Order not found" });
    }
    const session = order.multiSellerCheckoutSession;
    if (!session) {
      return reply.status(400).send({ success: false, message: "No multi-seller checkout session for this order" });
    }

    const sellerPlans = order.shippingAddress?.orderSummary?.multiSellerPlan;
    if (!Array.isArray(sellerPlans) || !sellerPlans.length) {
      return reply.status(400).send({ success: false, message: "No seller plan found for this order" });
    }

    // Idempotent finalize: if already charging/completed, return the
    // payment records already on file instead of charging sellers twice.
    if (session.status !== "COLLECTING_PAYMENT_METHOD") {
      const existingRecords = await prisma.orderPaymentRecord.findMany({ where: { orderId: order.id } });
      return reply.status(200).send({
        success: true,
        orderId: order.id,
        displayId: order.displayId,
        idempotent: true,
        payments: existingRecords.map((r) => ({
          sellerId: r.sellerId,
          stripeAccountId: r.stripeAccountId,
          paymentIntentId: r.stripePaymentIntentId,
          status: r.paymentStatus,
        })),
      });
    }

    const setupIntent = await stripe.setupIntents.retrieve(session.platformSetupIntentId);
    if (setupIntent.status !== "succeeded" || !setupIntent.payment_method) {
      return reply.status(400).send({
        success: false,
        message: `Card setup not complete. Stripe SetupIntent status: ${setupIntent.status}`,
      });
    }
    const platformPaymentMethodId = setupIntent.payment_method;

    // Atomically claim the session so a concurrent/duplicate finalize call
    // can't charge every seller twice (same pattern as claimStripeWebhookEvent).
    const claimed = await prisma.multiSellerCheckoutSession.updateMany({
      where: { orderId: order.id, status: "COLLECTING_PAYMENT_METHOD" },
      data: { status: "CHARGING_SELLERS", platformPaymentMethodId },
    });
    if (claimed.count !== 1) {
      const existingRecords = await prisma.orderPaymentRecord.findMany({ where: { orderId: order.id } });
      return reply.status(200).send({
        success: true,
        orderId: order.id,
        displayId: order.displayId,
        idempotent: true,
        payments: existingRecords.map((r) => ({
          sellerId: r.sellerId,
          stripeAccountId: r.stripeAccountId,
          paymentIntentId: r.stripePaymentIntentId,
          status: r.paymentStatus,
        })),
      });
    }

    const results = await chargeSellerPlansForConnectedAccounts({
      order,
      session,
      sellerPlans,
      platformPaymentMethodId,
      extraMetadata: { userId },
    });

    const paymentStatus = await aggregateParentPaymentStatus(order.id);
    const allSucceeded = results.every((r) => r.status === "succeeded");
    const anySucceeded = results.some((r) => r.status === "succeeded");
    await prisma.multiSellerCheckoutSession.update({
      where: { orderId: order.id },
      data: { status: allSucceeded ? "COMPLETED" : anySucceeded ? "PARTIALLY_COMPLETED" : "FAILED" },
    });

    return reply.status(200).send({
      success: true,
      orderId: order.id,
      displayId: order.displayId,
      paymentStatus,
      payments: results,
    });
  } catch (error) {
    logStripeApiError(error);
    console.error("❌ finalizeMultiSellerCheckout error:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to finalize multi-seller checkout",
      error: error.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Confirm payment after Stripe processes it on the frontend
// POST /api/payments/confirm
// Body: { paymentIntentId }
// ─────────────────────────────────────────────────────────────────────────────
exports.confirmPayment = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { paymentIntentId } = request.body;

    if (!paymentIntentId) {
      return reply.status(400).send({
        success: false,
        message: "paymentIntentId is required",
      });
    }

    // Find the associated order
    const order = await prisma.order.findFirst({
      where: { stripePaymentIntentId: paymentIntentId, userId },
      include: { items: { include: { product: true } } },
    });

    if (!order) {
      return reply.status(404).send({
        success: false,
        message: "Order not found for this payment",
      });
    }

    // Verify payment with Stripe. Direct charges live under the seller's
    // connected account, so fall back to that account if platform lookup fails.
    const { paymentIntent } = await retrievePaymentIntentForOrder(paymentIntentId, order);

    console.log("[STRIPE TEST] Payment confirmation verified", {
      orderId: order.id,
      paymentIntentId: paymentIntent.id,
      chargeId: paymentIntent.latest_charge || null,
      status: paymentIntent.status,
      livemode: paymentIntent.livemode,
      requestId: paymentIntent.lastResponse?.requestId || null,
    });

    if (paymentIntent.status !== "succeeded") {
      return reply.status(400).send({
        success: false,
        message: `Payment not successful. Stripe status: ${paymentIntent.status}`,
      });
    }

    // Idempotency — if already confirmed, just return success
    // The verified Stripe webhook is authoritative for permanent completion.
    // Frontend confirmation only reports that Stripe accepted/submitted payment.
    if (order.paymentStatus === "PAID") {
      return reply.status(200).send({
        success: true,
        message: "Payment already confirmed by Stripe webhook",
        orderId: order.id,
        displayId: order.displayId,
        status: order.status,
        paymentStatus: order.paymentStatus,
        stripeStatus: paymentIntent.status,
      });
    }

    return reply.status(202).send({
      success: true,
      message: "Payment submitted. Awaiting secure confirmation from Stripe.",
      orderId: order.id,
      displayId: order.displayId,
      status: "AWAITING_WEBHOOK_CONFIRMATION",
      paymentStatus: order.paymentStatus,
      stripeStatus: paymentIntent.status,
      awaitingWebhook: true,
    });
  } catch (error) {
    logStripeApiError(error);
    console.error("❌ confirmPayment error:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to confirm payment",
      error: error.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 (Optional / Server-side safety net) — Stripe Webhook
// POST /api/payments/webhook
// Raw body required — registered with a buffer content-type parser in routes
// ─────────────────────────────────────────────────────────────────────────────
exports.stripeWebhook = async (request, reply) => {
  const sig = request.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    // request.rawBody is the raw Buffer set by the scoped content-type parser
    event = stripe.webhooks.constructEvent(request.rawBody, sig, webhookSecret);
  } catch (err) {
    logStripeApiError(err);
    console.error("❌ Stripe webhook signature verification failed:", err.message);
    return reply.status(400).send({ error: `Webhook Error: ${err.message}` });
  }

  try {
    const claim = await claimStripeWebhookEvent(event);
    if (!claim.shouldProcess) {
      return reply.status(200).send({
        received: true,
        duplicate: claim.status === "PROCESSED",
        processing: claim.status === "PROCESSING",
      });
    }

    console.log("[STRIPE TEST] Webhook received", {
      eventId: event.id,
      eventType: event.type,
      livemode: event.livemode,
      account: event.account || null,
      objectId: event.data?.object?.id || null,
    });
    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        // Pass event.account so Direct Charge PIs (on connected accounts) are
        // retrieved with the correct Stripe API context.
        await handlePaymentSucceeded(pi.id, event.account || null);
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        const failReason = pi.last_payment_error?.message || 'Card declined';
        const failedPaymentRecord = await prisma.orderPaymentRecord.findUnique({
          where: { stripePaymentIntentId: pi.id },
        }).catch(() => null);

        if (failedPaymentRecord) {
          await prisma.orderPaymentRecord.update({
            where: { id: failedPaymentRecord.id },
            data: { paymentStatus: "FAILED" },
          });
          await aggregateParentPaymentStatus(failedPaymentRecord.orderId);
          break;
        }

        // Find the order
        const failedOrder = await prisma.order.findFirst({
          where: { stripePaymentIntentId: pi.id },
          include: { items: true }
        });

        if (failedOrder && failedOrder.status === 'PENDING') {
          // Mark order as FAILED and payment as FAILED
          await prisma.order.update({
            where: { id: failedOrder.id },
            data: { status: 'CANCELLED', paymentStatus: 'FAILED' }
          });

          // Restore stock for each item
          for (const item of failedOrder.items) {
            await prisma.product.update({
              where: { id: item.productId },
              data: { stock: { increment: item.quantity } }
            });
          }

        } else {
          await prisma.order.updateMany({
            where: { stripePaymentIntentId: pi.id },
            data: { paymentStatus: 'FAILED' },
          });
        }
        break;
      }
      case "charge.refunded": {
        // Direct Charge orders: Stripe automatically reverses the application fee — nothing to do.
        // Platform (multi-seller) orders: reverse any manual transfers so sellers
        // don't keep funds for refunded orders.
        const charge = event.data.object;
        const piId   = charge.payment_intent;
        if (!piId) break;
        const webhookRefundStatus =
          Number(charge.amount_refunded || 0) >= Number(charge.amount || 0) ? 'FULL' : 'PARTIAL';
        await prisma.orderPaymentRecord.updateMany({
          where: { stripePaymentIntentId: piId },
          data: { refundStatus: webhookRefundStatus },
        });
        const refundedPaymentRecord = await prisma.orderPaymentRecord.findUnique({
          where: { stripePaymentIntentId: piId },
        }).catch(() => null);
        if (refundedPaymentRecord) {
          await aggregateParentPaymentStatus(refundedPaymentRecord.orderId);
        }

        // chargeType is stored on the PaymentIntent metadata (not charge metadata)
        let chargeType = 'platform';
        try {
          // Direct Charge refund events arrive with event.account set to the connected account.
          const pi = event.account
            ? await stripe.paymentIntents.retrieve(piId, { stripeAccount: event.account })
            : await stripe.paymentIntents.retrieve(piId);
          chargeType = pi.metadata?.chargeType || 'platform';
        } catch (e) {
          // If retrieval fails and event.account is present, this is a Direct Charge refund
          // on a connected account — Stripe handles application fee reversal automatically.
          if (event.account) chargeType = 'direct';
          else console.warn(`⚠️  Could not retrieve PaymentIntent for chargeType check: ${e.message}`);
        }

        if (chargeType === 'direct') {
          // Stripe automatically reverses the application_fee_amount on the connected account.
          // Also cancel the commission record so dashboards reflect the reversal.
          const refundedOrder = await prisma.order.findFirst({
            where: { stripePaymentIntentId: piId },
            select: { id: true },
          });
          if (refundedOrder) {
            await prisma.commissionEarned.updateMany({
              where: { orderId: refundedOrder.id, status: { not: 'CANCELLED' } },
              data: { status: 'CANCELLED', stripeTransferStatus: 'reversed' },
            });
          }
          break;
        }

        // Platform (multi-seller) charge — reverse manual transfers for each seller
        const refundedOrder = await prisma.order.findFirst({
          where: { stripePaymentIntentId: piId },
          select: { id: true },
        });
        if (!refundedOrder) break;

        const commissionsToReverse = await prisma.$queryRaw`
          SELECT id, stripe_transfer_id
          FROM commission_earned
          WHERE order_id               = ${refundedOrder.id}
            AND stripe_transfer_id     IS NOT NULL
            AND stripe_transfer_status = 'transferred'
        `;

        for (const rec of commissionsToReverse) {
          try {
            await stripe.transfers.createReversal(
              rec.stripe_transfer_id,
              { metadata: { reason: "order_refunded", orderId: refundedOrder.id } },
              { idempotencyKey: `refund-webhook-reversal:${event.id}:${rec.id}` },
            );
            await prisma.$executeRaw`
              UPDATE commission_earned
              SET stripe_transfer_status = 'reversed',
                  status                 = 'CANCELLED'::"CommissionStatus",
                  updated_at             = NOW()
              WHERE id = ${rec.id}
            `;
          } catch (reverseErr) {
            console.error(`❌ Transfer reversal failed (commissionId: ${rec.id}):`, reverseErr.message);
          }
        }
        break;
      }
      case "charge.dispute.created": {
        await handleChargeDisputeEvent(event);
        break;
      }
      case "charge.dispute.updated": {
        await handleChargeDisputeEvent(event);
        break;
      }
      case "charge.dispute.closed": {
        await handleChargeDisputeEvent(event);
        break;
      }
      case "account.updated": {
        // Connected account onboarding status changed — sync charges/payouts
        // enabled flags so the checkout path knows whether a seller can accept payments.
        const account = event.data.object;
        if (account.id) {
          await prisma.sellerProfile.updateMany({
            where: { stripeAccountId: account.id },
            data: {
              stripeChargesEnabled: account.charges_enabled ?? false,
              stripePayoutsEnabled: account.payouts_enabled ?? false,
            },
          });
        }
        break;
      }
      default:
    }

    await markStripeWebhookEventProcessed(event.id);
    return reply.status(200).send({ received: true });
  } catch (error) {
    console.error("❌ Webhook handler error:", error);
    if (event?.id) {
      try {
        await markStripeWebhookEventFailed(event.id, error);
      } catch (markError) {
        console.error("Failed to mark Stripe webhook event FAILED:", markError.message);
      }
    }
    return reply.status(500).send({ error: "Webhook processing failed" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/status/:orderId — Check payment + order status
// ─────────────────────────────────────────────────────────────────────────────
exports.getPaymentStatus = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { orderId } = request.params;

    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      select: {
        id: true,
        displayId: true,
        status: true,
        paymentStatus: true,
        paymentMethod: true,
        stripePaymentIntentId: true,
        totalAmount: true,
        createdAt: true,
      },
    });

    if (!order) {
      return reply.status(404).send({ success: false, message: "Order not found" });
    }

    return reply.status(200).send({ success: true, order });
  } catch (error) {
    console.error("❌ getPaymentStatus error:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to get payment status",
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — shared between /confirm endpoint and webhook
// ─────────────────────────────────────────────────────────────────────────────
async function handlePaymentSucceeded(paymentIntentId, connectedAccountId = null) {
  const phase2PaymentRecord = await prisma.orderPaymentRecord.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    include: { order: true },
  }).catch(() => null);

  if (phase2PaymentRecord?.order && phase2PaymentRecord.order.stripePaymentIntentId === null) {
    const paymentRecordClaim = await prisma.orderPaymentRecord.updateMany({
      where: {
        stripePaymentIntentId: paymentIntentId,
        paymentStatus: { not: "PAID" },
      },
      data: { paymentStatus: "PAID" },
    });

    if (paymentRecordClaim.count === 0) {
      const existingOutboxCount = await prisma.paymentCompletionOutbox.count({
        where: { orderId: phase2PaymentRecord.orderId },
      }).catch(() => 0);
      if (
        phase2PaymentRecord.paymentStatus !== "PAID" ||
        phase2PaymentRecord.order?.status === "CONFIRMED" ||
        existingOutboxCount > 0
      ) {
        return false;
      }
    }

    const parentPaymentStatus = await aggregateParentPaymentStatus(phase2PaymentRecord.orderId);
    if (parentPaymentStatus !== "PAID") {
      return true;
    }

    const parentClaim = await prisma.order.updateMany({
      where: {
        id: phase2PaymentRecord.orderId,
        paymentStatus: "PAID",
        status: { not: "CONFIRMED" },
      },
      data: { status: "CONFIRMED" },
    });

    if (parentClaim.count === 0) {
      const existingOutboxCount = await prisma.paymentCompletionOutbox.count({
        where: { orderId: phase2PaymentRecord.orderId },
      }).catch(() => 0);
      if (existingOutboxCount > 0) {
        return false;
      }
    }
  } else {
  // ── Atomic claim ──────────────────────────────────────────────────────────
  // Both the Stripe webhook and the frontend /confirm endpoint call this
  // function. Without a lock, both can read paymentStatus=PENDING, both
  // process the order, and both send a confirmation email.
  //
  // The updateMany below is a single atomic SQL UPDATE … WHERE paymentStatus !=
  // 'PAID'. Only ONE concurrent caller will get count=1 and proceed; every
  // other caller gets count=0 and exits immediately — no duplicate emails.
  const claimed = await prisma.order.updateMany({
    where: {
      stripePaymentIntentId: paymentIntentId,
      paymentStatus: { not: "PAID" },
    },
    data: { paymentStatus: "PAID" },
  });

  if (claimed.count === 0) {
    const recoveryOrder = await prisma.order.findFirst({
      where: { stripePaymentIntentId: paymentIntentId },
      select: { id: true, status: true, paymentStatus: true },
    });
    if (!recoveryOrder || recoveryOrder.paymentStatus !== "PAID" || recoveryOrder.status === "CONFIRMED") {
      return false;
    }
    const existingOutboxCount = await prisma.paymentCompletionOutbox.count({
      where: { orderId: recoveryOrder.id },
    }).catch(() => 0);
    if (existingOutboxCount > 0) {
      return false;
    }
    console.warn("[PaymentCompletion] recovering paid order without completion outbox", {
      orderId: recoveryOrder.id,
      paymentIntentId,
      status: recoveryOrder.status,
      paymentStatus: recoveryOrder.paymentStatus,
    });
  }
  }

  // Retrieve PaymentIntent from Stripe to get latest_charge + chargeType (needed for transfers).
  // Captured once here so the per-seller loop never needs a redundant API call.
  let latestChargeId = null;
  let piChargeType = 'platform'; // default — overridden below if PI is retrievable
  let retrievedPaymentIntentStripeAccountId = connectedAccountId || null;
  try {
    // For Direct Charge PIs (on connected accounts), use the connected account context
    // directly rather than failing and falling back.
    const pi = connectedAccountId
      ? await stripe.paymentIntents.retrieve(paymentIntentId, { stripeAccount: connectedAccountId })
      : await stripe.paymentIntents.retrieve(paymentIntentId);
    latestChargeId = pi.latest_charge || null;
    piChargeType   = connectedAccountId ? 'direct' : (pi.metadata?.chargeType === 'direct' ? 'direct' : 'platform');
  } catch (e) {
    console.warn(`⚠️  Could not retrieve PaymentIntent for charge ID / chargeType: ${e.message}`);
  }

  // Fetch the now-PAID order for stock deduction, email, and notifications.
  const order = await prisma.order.findFirst({
    where: phase2PaymentRecord?.orderId
      ? { id: phase2PaymentRecord.orderId }
      : { stripePaymentIntentId: paymentIntentId },
    include: {
      items: { include: { product: true, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
      subOrders: {
        include: {
          items: { include: { product: true, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
          seller: { select: { id: true, name: true } }
        }
      }
    },
  });

  if (!order) return false;

  const paymentRecord = await prisma.orderPaymentRecord.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
  }).catch(() => null);

  try {
    const { paymentIntent: pi, stripeAccountId } = await retrievePaymentIntentForOrder(paymentIntentId, order);
    latestChargeId = pi.latest_charge || latestChargeId;
    piChargeType   = connectedAccountId ? 'direct' : (pi.metadata?.chargeType === 'direct' ? 'direct' : piChargeType);
    retrievedPaymentIntentStripeAccountId = stripeAccountId || null;
  } catch (e) {
    console.warn(`Could not retrieve PaymentIntent with order context: ${e.message}`);
  }

  // For multi-seller platform charges: retrieve the actual Stripe processing fee
  // from the charge balance_transaction so it can be distributed proportionally
  // across seller transfers — making each seller absorb their share of Stripe fees
  // (mirrors Direct Charge behaviour where Stripe debits the connected account).
  let totalStripeFeeInCents = 0;
  if (piChargeType !== 'direct' && latestChargeId) {
    try {
      const chargeWithBT = await stripe.charges.retrieve(latestChargeId, {
        expand: ['balance_transaction'],
      });
      totalStripeFeeInCents = chargeWithBT.balance_transaction?.fee || 0;
    } catch (e) {
      console.warn(`⚠️  Could not retrieve Stripe fee from balance_transaction: ${e.message}`);
    }
  }

  // Build a flat list of all items (direct items + sub-order items)
  const allItems = [
    ...(order.items || []),
    ...(order.subOrders?.flatMap(sub => sub.items) || [])
  ];
  const completionSellerIds = sellerIdsForSellerOnlyWorkflows(allItems);

  const cart = order.userId
    ? await prisma.cart.findUnique({ where: { userId: order.userId } })
    : null;

  await prisma.$transaction(async (tx) => {
    for (const item of allItems) {
      if (item.variantId) {
        // VARIABLE product — deduct from the variant
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { stock: { decrement: item.quantity } },
        });
      } else {
        // SIMPLE product — deduct from the product itself
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: item.quantity } },
        });
      }
    }

    if (cart) {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    }

    // Increment coupon usageCount if a coupon was applied
    if (order.couponCode) {
      await tx.coupon.updateMany({
        where: { code: order.couponCode },
        data: { usageCount: { increment: 1 } },
      });
    }

    // paymentStatus already set to PAID atomically above — only update
    // the fulfilment status here.
    await tx.order.update({
      where: { id: order.id },
      data: { status: "CONFIRMED" },
    });

    await tx.paymentCompletionOutbox.createMany({
      data: buildPaymentCompletionOutboxRows({
        order,
        paymentIntentId,
        sellerIds: completionSellerIds,
      }),
      skipDuplicates: true,
    });
  });


  // ── Send confirmation email ─────────────────────────────────────────────
  // Uses order.customerEmail which is always stored at order-creation time for
  // both guest and logged-in orders, so this works for every payment path
  // (webhook, /confirm, /guest/confirm) without any extra lookup.
  const paymentCompletionNotificationsQueued = true;
  const toEmail = order.customerEmail;
  const toName  = order.customerName || 'Customer';
  const orderDetailsForEmail = {
    displayId:     order.displayId,
    customerEmail: toEmail,
    totalAmount:   Number(order.totalAmount),
    itemCount:     allItems.length,
    products:      allItems.map((item) => {
      const base = item.product?.title || 'Product';
      const variant = item.productVariant;
      let variantInfo = null;
      if (variant?.variantAttributeValues?.length) {
        const attrs = variant.variantAttributeValues
          .map(av => `${av.attributeValue?.attribute?.name}: ${av.attributeValue?.value}`)
          .filter(Boolean).join(', ');
        if (attrs) variantInfo = attrs;
      }
      const price = variant ? Number(variant.price) : Number(item.price);
      return { title: base, variantInfo, quantity: item.quantity, price };
    }),
    // Pass structured address so the email template can render city/state/zip
    shippingAddress: {
      addressLine: order.shippingAddressLine,
      city:        order.shippingCity,
      state:       order.shippingState,
      zipCode:     order.shippingZipCode,
      country:     order.shippingCountry,
    },
    paymentMethod:   order.paymentMethod || 'STRIPE',
    customerPhone:   order.customerPhone || '',
    customerName:    toName,
    orderSummary:    order.shippingAddress && typeof order.shippingAddress === 'object' && order.shippingAddress.orderSummary ? {
      ...order.shippingAddress.orderSummary,
      // Always show total shipping (across all sellers), not per-seller rate
      shippingCost: order.shippingAddress.orderSummary.totalShippingCost || order.shippingAddress.orderSummary.shippingCost,
    } : undefined,
    isGuest:         !order.userId, // guest orders use /guest/track-order?orderId=...&email=...
  };

  // ── Generate invoice PDF for all confirmation emails ───────────────────
  let invoicePDFBuffer = null;
  try {
    const invoiceOrderRecord = await prisma.order.findUnique({
      where: { id: order.id },
      include: {
        items:     { include: { product: { select: { id: true, title: true, price: true, sellerId: true, seller: { select: { name: true, sellerProfile: { select: { abn: true, businessAddress: true } } } } } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
        subOrders: { include: { seller: { select: { name: true } }, sellerProfile: { select: { abn: true, businessAddress: true } }, items: { include: { product: { select: { id: true, title: true, price: true } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } } } },
        user:      { select: { name: true, email: true, phone: true, isDeleted: true } },
      }
    });

    if (invoiceOrderRecord) {
      const invoiceShape = {
        ...invoiceOrderRecord,
        customerName:  (invoiceOrderRecord.user?.isDeleted ? 'Deleted User' : invoiceOrderRecord.user?.name) || invoiceOrderRecord.customerName,
        customerEmail: invoiceOrderRecord.user?.email || invoiceOrderRecord.customerEmail,
        customerPhone: invoiceOrderRecord.user?.phone || invoiceOrderRecord.customerPhone,
      };
      invoicePDFBuffer = await generateInvoiceBuffer(invoiceShape);
    }
  } catch (pdfErr) {
    console.error('Invoice PDF generation error (non-blocking):', pdfErr.message);
  }

  if (!paymentCompletionNotificationsQueued && toEmail) {
    sendOrderConfirmationEmail(toEmail, toName, orderDetailsForEmail, invoicePDFBuffer)
      .catch((e) => console.error('Email error (non-blocking):', e.message));
  } else if (!paymentCompletionNotificationsQueued) {
    console.warn(`⚠️  No customerEmail on order ${order.id} — confirmation email skipped`);
  }

  // ── Send Finance Copy with Invoice PDF attached ───────────────────────
  try {
    const invoiceOrderRecord = await prisma.order.findUnique({
      where: { id: order.id },
      include: {
        items:     { include: { product: { select: { id: true, title: true, price: true, sellerId: true, seller: { select: { name: true, sellerProfile: { select: { abn: true, businessAddress: true } } } } } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
        subOrders: { include: { seller: { select: { name: true } }, sellerProfile: { select: { abn: true, businessAddress: true } }, items: { include: { product: { select: { id: true, title: true, price: true } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } } } },
        user:      { select: { name: true, email: true, phone: true, isDeleted: true } },
      }
    });

    if (!paymentCompletionNotificationsQueued && invoiceOrderRecord) {
      const invoiceShape = {
        ...invoiceOrderRecord,
        customerName:  (invoiceOrderRecord.user?.isDeleted ? 'Deleted User' : invoiceOrderRecord.user?.name) || invoiceOrderRecord.customerName,
        customerEmail: invoiceOrderRecord.user?.email || invoiceOrderRecord.customerEmail,
        customerPhone: invoiceOrderRecord.user?.phone || invoiceOrderRecord.customerPhone,
      };
      const financePdfBuffer = invoicePDFBuffer || await generateInvoiceBuffer(invoiceShape);
      await sendFinanceOrderInvoiceEmail(invoiceShape, financePdfBuffer);
    }
  } catch (financeErr) {
    console.error('Error generating finance email/invoice (non-blocking):', financeErr);
  }

  // ── Notify admins ───────────────────────────────────────────────────────
  // Resolve seller display names and product titles from all items (direct + sub-order)
  const sellerIdSet = sellerIdsForSellerOnlyWorkflows(allItems);
  const sellerDisplayNames = await Promise.all(sellerIdSet.map(async sid => {
    const s = await prisma.user.findUnique({ where: { id: sid }, select: { name: true, sellerProfile: { select: { storeName: true, businessName: true } } } });
    return s?.name || s?.sellerProfile?.storeName || s?.sellerProfile?.businessName || 'Unknown';
  }));
  const productTitles = allItems.map(i => i.product?.title).filter(Boolean);

  if (!paymentCompletionNotificationsQueued) notifyAdminNewOrder(order.id, {
    customerName: toName,
    sellerName:   sellerDisplayNames.join(', ') || 'Unknown',
    totalAmount:  Number(order.totalAmount).toFixed(2),
    itemCount:    allItems.length,
    productNames: productTitles,
    orderId:      order.id,
  }).catch((e) => console.error('Admin notification error (non-blocking):', e.message));

  // Send Super Admin Copy of Order Confirmation
  if (!paymentCompletionNotificationsQueued) prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } })
    .then(admins => {
      for (const admin of admins) {
        if (admin.email) {
          sendOrderConfirmationEmail(admin.email, admin.name || 'Super Admin', {
            ...orderDetailsForEmail,
            isSuperAdminCopy: true
          }, invoicePDFBuffer).catch(e => console.error('Admin order email error (non-blocking):', e.message));
        }
      }
    }).catch(e => console.error('Error fetching admins for order emails:', e.message));

  // ── Create SLA + in-app notifications for each seller ──────────────────
  // Per-seller shipping: stored as orderSummary.shippingCost at order creation time
  const perSellerShipping = parseFloat(
    order.shippingAddress?.orderSummary?.shippingCost || 0
  );

  for (const sid of sellerIdSet) {
    const sellerItems = allItems.filter(i => i.product?.sellerId === sid);
    const itemCount = sellerItems.reduce((s, i) => s + i.quantity, 0);
    const itemTotal = sellerItems.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
    const productNames = sellerItems.map(i => i.product?.title).filter(Boolean);
    const sellerSubOrder = order.subOrders?.find((sub) => sub.sellerId === sid || sub.seller?.id === sid) || null;
    const sellerPaymentRecord =
      await findSellerPaymentRecordForOrder({ orderId: order.id, sellerId: sid })
      || (paymentRecord?.sellerId === sid ? paymentRecord : null);
    const isDirectCharge = sellerPaymentRecord?.paymentFlow === 'DIRECT_CHARGE' || (!sellerPaymentRecord && piChargeType === 'direct');
    const isPlatformAccountPayment = sellerPaymentRecord?.paymentFlow === 'PLATFORM_ACCOUNT';
    const isConnectedAccountWebhook = Boolean(connectedAccountId);
    
    // Legacy Separate Charges and Transfers needs a seller transfer amount.
    // Direct Charge settlement is owned by Stripe; the backend only records
    // ALPA's application fee and must not calculate a seller payout.
    let payout = null;
    if (!isDirectCharge && !isPlatformAccountPayment && !isConnectedAccountWebhook) {
      const sellerCommission = await getCommissionForSeller(sid);
      const resolvedCommission = sellerCommission || (await getDefaultCommission());
      const commissionRatePct = resolvedCommission ? parseFloat(resolvedCommission.value) : 10;
      payout = calculateSellerPayout(itemTotal, perSellerShipping, commissionRatePct);
    }
    const directChargePlatformFee = Number(sellerPaymentRecord?.applicationFeeAmount || 0) / 100;
    const directChargeGstAmount = Number(sellerPaymentRecord?.gstAmount || 0) / 100;
    const directChargeSellerGross = itemTotal + perSellerShipping;
    const paymentSettledByStripe = isDirectCharge || isPlatformAccountPayment || isConnectedAccountWebhook;
    
    // ── Build transaction description. Direct Charges show gross payment details;
    // legacy transfers show the calculated transfer payout.
    const sellerTransactionDescription = buildSellerTransactionDescription({
      order: sellerSubOrder || order,
      customerName: toName,
      customerEmail: order.customerEmail,
      items: sellerItems,
      amount: paymentSettledByStripe ? directChargeSellerGross : payout.sellerTotalPayout,
      label: isPlatformAccountPayment ? "Platform payment" : paymentSettledByStripe ? "Direct Charge payment" : "Legacy seller transfer",
      platformFee: paymentSettledByStripe ? directChargePlatformFee : payout.commissionAmount,
      gstAmount: paymentSettledByStripe ? directChargeGstAmount : payout.gstAmount,
      shippingAmount: paymentSettledByStripe ? perSellerShipping : payout.shippingAmount,
    });
    if (!paymentCompletionNotificationsQueued) createOrderNotification(order.id, sid, 'ORDER_PROCESSING', 'HIGH', {
      message: `New order received from ${toName}`,
      notes: `${itemCount} item(s), Total: $${itemTotal.toFixed(2)}`
    }).catch((e) => console.error('SLA notification error (non-blocking):', e.message));
    if (!paymentCompletionNotificationsQueued) notifySellerNewOrder(sid, order.id, {
      customerName: toName,
      totalAmount: itemTotal.toFixed(2),
      itemCount,
      productNames
    }).catch((e) => console.error('Seller in-app notification error (non-blocking):', e.message));

    // Send Seller Email Notification
    if (!paymentCompletionNotificationsQueued) prisma.user.findUnique({ where: { id: sid }, select: { email: true, name: true, sellerProfile: { select: { storeName: true, businessName: true } } } })
      .then(seller => {
        if (seller && seller.email) {
          const sellerSubOrder = order.subOrders && order.subOrders.find(sub => sub.sellerId === sid || sub.seller?.id === sid);
          const sName = seller.name || seller.sellerProfile?.storeName || seller.sellerProfile?.businessName || 'Seller';

          // Per-seller shipping is stored as shippingCost (not totalShippingCost) on the parent orderSummary
          const sellerShipping = parseFloat(order.shippingAddress?.orderSummary?.shippingCost || 0);
          const gstPct = parseFloat(order.shippingAddress?.orderSummary?.gstPercentage || 10);
          const sellerGstAmount = itemTotal * (gstPct / (100 + gstPct));
          const sellerSubtotalExGST = itemTotal - sellerGstAmount;

          sendOrderConfirmationEmail(seller.email, sName, {
            ...orderDetailsForEmail,
            isSellerCopy: true,
            subOrderId: sellerSubOrder ? sellerSubOrder.id : undefined,
            products: sellerItems.map(i => {
              const sv = i.productVariant;
              let variantInfo = null;
              if (sv?.variantAttributeValues?.length) {
                const attrs = sv.variantAttributeValues
                  .map(av => `${av.attributeValue?.attribute?.name}: ${av.attributeValue?.value}`)
                  .filter(Boolean).join(', ');
                if (attrs) variantInfo = attrs;
              }
              return { title: i.product?.title, variantInfo, quantity: i.quantity, price: Number(i.price) };
            }),
            totalAmount: itemTotal + sellerShipping,
            orderSummary: {
              ...order.shippingAddress?.orderSummary,
              subtotal: itemTotal,
              subtotalExGST: sellerSubtotalExGST,
              gstAmount: sellerGstAmount,
              shippingCost: sellerShipping,
            },
          }, invoicePDFBuffer).catch(e => console.error('Seller order email error:', e.message));
        }
      }).catch(e => console.error('Error fetching seller for order email:', e.message));

    // ── Commission Earned ───────────────────────────────────────────────────
    // Records commission using GST-exclusive product price only (shipping excluded).
    const sellerSubOrderId = sellerSubOrder?.id || null;
    
    // Ensure subDisplayId is populated: either from DB or construct it based on seller position
    let subDisplayIdForStipe = sellerSubOrder?.subDisplayId;
    if (!subDisplayIdForStipe && sellerSubOrder && order.subOrders) {
      // Find the position of this seller in the subOrders array
      const sellerIndex = order.subOrders.findIndex(sub => sub.id === sellerSubOrder.id);
      if (sellerIndex >= 0) {
        const suffix = String.fromCharCode(65 + sellerIndex); // A, B, C, etc.
        subDisplayIdForStipe = `${order.displayId}-${suffix}`;
      }
    }
    
    // Ensure sellerSubOrder has the subDisplayId for the description function
    if (sellerSubOrder && !sellerSubOrder.subDisplayId && subDisplayIdForStipe) {
      sellerSubOrder.subDisplayId = subDisplayIdForStipe;
    }

    const commissionEarnedId = await createCommissionEarned({
      orderId:        order.id,
      subOrderId:     sellerSubOrderId,
      sellerId:       sid,
      orderValue:     itemTotal,
      shippingAmount: perSellerShipping,
      customerName:   toName,
      customerEmail:  order.customerEmail,
      customerId:     order.userId || null,
      sellerName:     sellerDisplayNames[sellerIdSet.indexOf(sid)] || null,
      ...buildPaymentRecordCommissionOverrides(sellerPaymentRecord),
    });
    if (!commissionEarnedId) {
      throw new Error(`Commission earned record was not created for seller ${sid}`);
    }

    // ── Direct Charge or legacy seller transfer settlement ──────────────────
    // Direct Charge orders: Stripe already routed funds to the seller and
    // collected ALPA's application fee automatically — no manual transfer needed.
    // Legacy platform-owned orders: retain transfer creation for historical
    // Separate Charges and Transfers settlement only.
    // piChargeType is resolved once above (from the single PaymentIntent retrieval)
    // so this never triggers a redundant Stripe API call inside the seller loop.
    const sellerStripeMetadata = buildSellerStripeOrderMetadata({
      order,
      subOrder: sellerSubOrder,
      sellerId: sid,
      customerName: toName,
      customerEmail: order.customerEmail,
      items: sellerItems,
      amount: itemTotal,
    });

    if (paymentSettledByStripe) {
      // Direct Charge: Stripe handled seller settlement automatically.
      // Platform Account: ALPA owns the platform payment; no seller transfer is needed.
      // Do not create seller transfers in this branch. If an old Stripe object
      // exposes a related transfer, only enrich metadata for reconciliation.
      await (async () => {
        if (isPlatformAccountPayment) return;
        try {
          if (latestChargeId) {
            const stripeAccountOptions = retrievedPaymentIntentStripeAccountId
              ? { stripeAccount: retrievedPaymentIntentStripeAccountId }
              : undefined;
            const charge = await stripe.charges.retrieve(latestChargeId, stripeAccountOptions);
            await stripe.charges.update(latestChargeId, {
              description: sellerTransactionDescription,
              metadata: sellerStripeMetadata,
            }, stripeAccountOptions);
            const autoTransferId = charge.transfer;
            if (autoTransferId) {
              await stripe.transfers.update(autoTransferId, {
                description: sellerTransactionDescription,
                metadata: sellerStripeMetadata,
              });
              const sellerProfile = await prisma.sellerProfile.findUnique({
                where: { userId: sid },
                select: { stripeAccountId: true },
              });
              await updateConnectedAccountDestinationPayment({
                transferId: autoTransferId,
                stripeAccountId: sellerProfile?.stripeAccountId,
                description: sellerTransactionDescription,
                metadata: sellerStripeMetadata,
              });
              if (commissionEarnedId) {
                await prisma.$executeRaw`
                  UPDATE commission_earned
                  SET stripe_transfer_id     = ${autoTransferId},
                      stripe_transfer_status = 'direct_charge',
                      updated_at             = NOW()
                  WHERE id = ${commissionEarnedId}
                `;
              }
            } else if (commissionEarnedId) {
              await prisma.$executeRaw`
                UPDATE commission_earned
                SET stripe_transfer_status = 'direct_charge',
                    status                 = 'PAID'::"CommissionStatus",
                    updated_at             = NOW()
                WHERE id = ${commissionEarnedId}
              `;
            }
          }
        } catch (e) {
          console.error(`⚠️  Could not update auto-transfer description for seller ${sid}:`, e.message);
        }
      })();

      // Notify seller by email (non-blocking)
      const sellerUser = await prisma.user.findUnique({
        where: { id: sid },
        select: { email: true, name: true },
      });
      if (!paymentCompletionNotificationsQueued && sellerUser?.email) {
        sendSellerPaymentReceivedEmail(sellerUser.email, sellerUser.name || 'Seller', {
          orderId:        order.id,
          orderDisplayId: order.displayId || order.id,
          amount:         itemTotal,
          currency:       'AUD',
        }).catch((e) => console.error('sendSellerPaymentReceivedEmail error:', e.message));
      }
    } else {
      // Legacy platform-owned settlement path.
      // Legacy Separate Charges and Transfers settlement.
      // Retained only for historical/platform-owned PaymentIntents that still
      // require seller transfers. New checkout must not enter this branch.
      // Commission: Preserved — 10% on GST-exclusive price, shipping excluded.
      // ──────────────────────────────────────────────────────────────────────────
      await (async () => {
        try {
          const sellerProfile = await prisma.sellerProfile.findUnique({
            where:  { userId: sid },
            select: { stripeAccountId: true, stripePayoutsEnabled: true, user: { select: { email: true, name: true } } },
          });

          if (!sellerProfile?.stripeAccountId || !sellerProfile?.stripePayoutsEnabled) {
            return;
          }

          const sellerCommission   = await getCommissionForSeller(sid);
          const resolvedCommission = sellerCommission || (await getDefaultCommission());
          const commissionRatePct  = resolvedCommission ? parseFloat(resolvedCommission.value) : 10;
          const payout = calculateSellerPayout(itemTotal, perSellerShipping, commissionRatePct);

          if (payout.sellerTotalPayoutCents <= 0) {
            console.warn(`Seller ${sid} transfer amount would be <= $0 - legacy transfer skipped`);
            return;
          }

          // Deduct this seller's proportional share of the Stripe processing fee.
          // Platform pays Stripe for Separate C+T — we pass the cost back to each
          // seller so the economics match Direct Charge behaviour (SOW requirement).
          const totalAmountCents = Math.round(Number(order.totalAmount) * 100);
          const sellerGrossCents = Math.round((itemTotal + perSellerShipping) * 100);
          const sellerStripeFeeShare = (totalAmountCents > 0 && totalStripeFeeInCents > 0)
            ? Math.round(totalStripeFeeInCents * sellerGrossCents / totalAmountCents)
            : 0;
          const finalTransferCents = Math.max(1, payout.sellerTotalPayoutCents - sellerStripeFeeShare);

          const payoutTransactionDescription = buildSellerTransactionDescription({
            order: sellerSubOrder || order,
            customerName: toName,
            customerEmail: order.customerEmail,
            items: sellerItems,
            amount: payout.sellerTotalPayout,
            label: "Legacy seller transfer",
            platformFee: payout.commissionAmount,
            gstAmount: payout.gstAmount,
            shippingAmount: payout.shippingAmount,
          });

          const transfer = await stripe.transfers.create(
            {
              amount:      finalTransferCents,
              currency:    "aud",
              destination: sellerProfile.stripeAccountId,
              ...(latestChargeId && { source_transaction: latestChargeId }),
              description: payoutTransactionDescription,
              metadata: {
                ...sellerStripeMetadata,
                sellerId:            sid,
                commissionAmount:    payout.commissionAmount.toString(),
                commissionRate:      payout.commissionRatePct.toString(),
                gstAmount:           payout.gstAmount.toString(),
                shippingAmount:      payout.shippingAmount.toString(),
                sellerTotalPayout:   payout.sellerTotalPayout.toString(),
                productValueExGST:   payout.productValueExGST.toString(),
                stripeFeeDeducted:   (sellerStripeFeeShare / 100).toFixed(2),
                finalTransferAmount: (finalTransferCents / 100).toFixed(2),
              },
            },
            { idempotencyKey: `transfer:create:${order.id}:${sid}:${commissionEarnedId}` },
          );


          console.log("[STRIPE TEST] Seller transfer created", {
            orderId: order.id,
            sellerId: sid,
            connectedAccountId: sellerProfile.stripeAccountId,
            transferId: transfer.id,
            amount: transfer.amount,
            livemode: transfer.livemode,
            sourceTransaction: transfer.source_transaction || null,
            requestId: transfer.lastResponse?.requestId || null,
          });

          await stripe.transfers.update(transfer.id, {
            description: payoutTransactionDescription,
          });

          await updateConnectedAccountDestinationPayment({
            transferId: transfer.id,
            stripeAccountId: sellerProfile.stripeAccountId,
            description: payoutTransactionDescription,
            metadata: {
              ...sellerStripeMetadata,
              sellerId:          sid,
              commissionAmount:  payout.commissionAmount.toString(),
              commissionRate:    payout.commissionRatePct.toString(),
              gstAmount:         payout.gstAmount.toString(),
              shippingAmount:    payout.shippingAmount.toString(),
              sellerTotalPayout: payout.sellerTotalPayout.toString(),
              platformFee:       payout.commissionAmount.toFixed(2),
              productValueExGST: payout.productValueExGST.toString(),
              netEarning:        payout.sellerProductEarning.toString(),
            },
          });

          // Notify seller by email (non-blocking)
          const sellerEmail = sellerProfile.user?.email;
          const sellerName  = sellerProfile.user?.name || sellerDisplayNames[sellerIdSet.indexOf(sid)] || 'Seller';
          if (!paymentCompletionNotificationsQueued && sellerEmail) {
            sendSellerPaymentReceivedEmail(sellerEmail, sellerName, {
              orderId:        order.id,
              orderDisplayId: order.displayId || order.id,
              amount:         payout.sellerTotalPayout,
              currency:       'AUD',
            }).catch((e) => console.error('sendSellerPaymentReceivedEmail error:', e.message));
          }

          if (commissionEarnedId) {
            await prisma.$executeRaw`
              UPDATE commission_earned
              SET stripe_transfer_id     = ${transfer.id},
                  stripe_transfer_status = 'transferred',
                  updated_at             = NOW()
              WHERE id = ${commissionEarnedId}
            `;
          }
        } catch (transferErr) {
          logStripeApiError(transferErr);
          console.error(`❌ Stripe transfer failed for seller ${sid} (non-fatal):`, transferErr.message);
        }
      })();
    }
    // ───────────────────────────────────────────────────────────────────────
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// GUEST — Create Stripe PaymentIntent + Pending Order (no auth required)
// POST /api/payments/guest/create-intent
// Body: { items, customerName, customerEmail, customerPhone, shippingAddress,
//         shippingMethodId, gstId, country, city, zipCode, state, mobileNumber, couponCode }
// ─────────────────────────────────────────────────────────────────────────────
exports.createGuestPaymentIntent = async (request, reply) => {
  let guestCheckoutApiOperationKey = null;
  try {
    const {
      items,
      customerName,
      customerEmail,
      customerPhone,
      shippingAddress,
      shippingMethodId,
      internationalCountry,
      gstId,
      country,
      city,
      zipCode,
      state,
      mobileNumber,
      couponCode,
    } = request.body;

    const effectiveIntlCountry = (internationalCountry || country || '').trim();
    const isInternational = !!effectiveIntlCountry && effectiveIntlCountry.toLowerCase() !== 'australia';

    // Basic validation
    if (!items || items.length === 0) {
      return reply.status(400).send({ success: false, message: "Order items are required" });
    }
    if (!customerName || !customerEmail || !customerPhone) {
      return reply.status(400).send({ success: false, message: "Customer name, email, and phone are required" });
    }
    if (!shippingAddress || (!shippingMethodId && !isInternational)) {
      return reply.status(400).send({ success: false, message: "shippingAddress and a shipping method (or international destination country) are required" });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customerEmail)) {
      return reply.status(400).send({ success: false, message: "Invalid email address" });
    }

    // Resolve shipping method — international uses zone lookup, domestic uses DB
    let shippingMethod;
    let intlZoneEntry = null;
    if (isInternational) {
      intlZoneEntry = lookupZone(effectiveIntlCountry);
      shippingMethod = {
        id: null,
        name: `International (${effectiveIntlCountry})`,
        cost: intlZoneEntry.cost,
        estimatedDays: '10-20 business days',
      };
    } else {
      shippingMethod = await prisma.shippingMethod.findUnique({
        where: { id: shippingMethodId, isActive: true },
      });
      if (!shippingMethod) {
        return reply.status(400).send({ success: false, message: "Invalid or inactive shipping method" });
      }
    }

    // Fetch and validate products + build cart-like structure
    const cartItems = [];
    const orderItems = [];

    for (const item of items) {
      const { productId, variantId, quantity } = item;
      if (!productId || !quantity || quantity < 1) {
        return reply.status(400).send({ success: false, message: "Invalid item in order" });
      }

      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product) {
        return reply.status(404).send({ success: false, message: `Product ${productId} not found` });
      }

      let variant = null;
      if (variantId) {
        variant = await prisma.productVariant.findUnique({
          where: { id: variantId },
          include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } }
        });
        if (!variant) {
          return reply.status(404).send({ success: false, message: `Variant ${variantId} not found` });
        }
        if (variant.stock < quantity) {
          return reply.status(400).send({ success: false, message: `Insufficient stock for: ${product.title}` });
        }
      } else {
        if (product.stock < quantity) {
          return reply.status(400).send({ success: false, message: `Insufficient stock for: ${product.title}` });
        }
      }

      const itemPrice = variant ? Number(variant.price) : Number(product.price);
      cartItems.push({ product, productVariant: variant, quantity });
      orderItems.push({ productId: product.id, variantId: variantId || null, quantity, price: itemPrice });
    }

    // Calculate totals — pass international cost as 4th arg when applicable
    const cartCalculations = await calculateCartTotals(
      cartItems,
      isInternational ? null : shippingMethodId,
      gstId,
      isInternational ? intlZoneEntry.cost : null
    );
    const originalTotal = parseFloat(cartCalculations.grandTotal);

    // ── Coupon validation ──────────────────────────────────────────────────
    let appliedCoupon = null;
    let discountAmount = 0;

    if (couponCode) {
      const upper   = couponCode.toUpperCase();
      const gstRate = parseFloat(cartCalculations.gstPercentage) || 0;

      // Try seller coupon first
      const sellerCoupon = await prisma.sellerCoupon.findUnique({ where: { code: upper } });

      if (sellerCoupon && !sellerCoupon.softDeletedAt) {
        if (!sellerCoupon.isActive) return reply.status(400).send({ success: false, message: "Coupon is no longer active" });
        if (new Date() > sellerCoupon.expiresAt) return reply.status(400).send({ success: false, message: "Coupon has expired" });
        if (sellerCoupon.usageLimit !== null && sellerCoupon.usageCount >= sellerCoupon.usageLimit)
          return reply.status(400).send({ success: false, message: "Coupon usage limit reached" });
        discountAmount = calcSellerCouponDiscount(sellerCoupon, cartItems, gstRate);
        appliedCoupon  = sellerCoupon;
      } else {
        // Fall back to legacy (admin) coupon
        const coupon = await prisma.coupon.findUnique({ where: { code: upper } });
        if (!coupon) return reply.status(400).send({ success: false, message: "Invalid coupon code" });
        if (!coupon.isActive) return reply.status(400).send({ success: false, message: "Coupon is no longer active" });
        if (new Date() > coupon.expiresAt) return reply.status(400).send({ success: false, message: "Coupon has expired" });
        if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit)
          return reply.status(400).send({ success: false, message: "Coupon usage limit reached" });
        if (coupon.minCartValue !== null && originalTotal < coupon.minCartValue)
          return reply.status(400).send({
            success: false,
            message: `Minimum cart value of $${coupon.minCartValue.toFixed(2)} required`,
          });

        if (coupon.discountType === "percentage") {
          discountAmount = parseFloat(((originalTotal * coupon.discountValue) / 100).toFixed(2));
          if (coupon.maxDiscount !== null) discountAmount = Math.min(discountAmount, coupon.maxDiscount);
        } else {
          discountAmount = Math.min(coupon.discountValue, originalTotal);
        }
        appliedCoupon = coupon;
      }
    }

    const totalAmount = parseFloat((originalTotal - discountAmount).toFixed(2));
    const amountInCents = Math.round(totalAmount * 100);
    // ──────────────────────────────────────────────────────────────────────

    // Build per-seller map BEFORE PaymentIntent so we can use Direct Charges
    // for single-seller guest orders (same logic as logged-in flow)
    const guestSellerMap = new Map();
    for (const { product, productVariant, quantity } of cartItems) {
      const sid = product.sellerId;
      if (!guestSellerMap.has(sid)) guestSellerMap.set(sid, []);
      guestSellerMap.get(sid).push({ product, productVariant, quantity });
    }
    const guestIsMultiSeller = guestSellerMap.size > 1;
    if (guestIsMultiSeller) {
      console.log("[STRIPE TEST] Phase 2A guest multi-seller Direct Charge checkout", {
        sellerCount: guestSellerMap.size,
      });
    }
    const displayId = await generateDisplayId();
    const guestCheckoutPaymentDescription = buildSellerTransactionDescription({
      order: { id: displayId, displayId },
      customerName,
      customerEmail,
      items: cartItems,
      amount: totalAmount,
      label: "Seller payment",
    });

    let guestDirectChargeParams = {};
    let guestPaymentIntentStripeAccountId = null;
    let guestDirectChargePaymentRecord = null;
    let guestSingleSellerIdForOperation = null;
    if (!guestIsMultiSeller && USE_DIRECT_CHARGES_FOR_SINGLE_SELLER) {
      const [singleSellerId] = guestSellerMap.keys();
      guestSingleSellerIdForOperation = singleSellerId;
      const itemTotal = cartItems.reduce((s, i) => s + (i.productVariant ? Number(i.productVariant.price) : Number(i.product.price)) * i.quantity, 0);
      const perSellerShipping  = parseFloat(cartCalculations.shippingCost);
      const paymentAccountType = await resolvePaymentAccountTypeForItems({ sellerId: singleSellerId, items: cartItems });
      if (paymentAccountType === "PLATFORM") {
        guestDirectChargePaymentRecord = {
          paymentAccountType: "PLATFORM",
          sellerId: singleSellerId,
          itemTotal,
          shippingAmount: perSellerShipping,
          grossAmountCents: amountInCents,
          gstAmountCents: moneyToMinorUnits(cartCalculations.gstAmount),
        };
      } else {
        const { stripeAccountId } = await requireDirectChargeReadySeller(singleSellerId);
        const eligibleSubtotalCents = Math.max(
          0,
          moneyToMinorUnits(cartCalculations.subtotalExGST) - moneyToMinorUnits(discountAmount),
        );
        const commission = calculateAlpaCommission({
          eligibleProductSubtotalCents: eligibleSubtotalCents,
          currency: "aud",
        });
        // True Direct Charge: PaymentIntent is created on the seller's connected account.
        // Stripe automatically deducts its processing fee from the seller's balance.
        // ALPA's commission flows as application_fee_amount.
        guestPaymentIntentStripeAccountId = stripeAccountId;
        guestDirectChargeParams = {
          application_fee_amount: commission.applicationFeeAmount,
        };
        guestDirectChargePaymentRecord = {
          paymentAccountType: "CONNECTED",
          sellerId: singleSellerId,
          stripeAccountId,
          itemTotal,
          shippingAmount: perSellerShipping,
          commission,
          grossAmountCents: amountInCents,
          gstAmountCents: moneyToMinorUnits(cartCalculations.gstAmount),
        };
      }
    }

    const normalizedGuestEmail = customerEmail.trim().toLowerCase();
    const guestCheckoutRequestHash = hashOperationPayload({
      customerEmail: normalizedGuestEmail,
      customerPhone,
      amountInCents,
      sellerId: guestSingleSellerIdForOperation,
      shippingMethodId: shippingMethodId || null,
      gstId: gstId || null,
      isInternational,
      effectiveIntlCountry,
      couponCode: couponCode || null,
      items: normalizeGuestItemsForOperation(items),
    });
    guestCheckoutApiOperationKey = checkoutOperationKey({
      scope: "guest",
      subjectId: normalizedGuestEmail,
      sellerId: guestSingleSellerIdForOperation,
      amountInCents,
      requestHash: guestCheckoutRequestHash,
    });
    const guestCheckoutOperation = await claimApiOperation({
      operationKey: guestCheckoutApiOperationKey,
      operationType: "PAYMENT_INTENT_CREATE",
      requestHash: guestCheckoutRequestHash,
      attemptNumber: 1,
    });
    if (guestCheckoutOperation.status === "COMPLETED" && guestCheckoutOperation.stripePaymentIntentId) {
      const existingOrder = guestCheckoutOperation.orderId
        ? await prisma.order.findUnique({ where: { id: guestCheckoutOperation.orderId } })
        : await prisma.order.findFirst({ where: { stripePaymentIntentId: guestCheckoutOperation.stripePaymentIntentId } });
      const existingPaymentIntent = await stripe.paymentIntents.retrieve(
        guestCheckoutOperation.stripePaymentIntentId,
        guestPaymentIntentStripeAccountId ? { stripeAccount: guestPaymentIntentStripeAccountId } : undefined,
      );
      return reply.status(200).send({
        success: true,
        clientSecret: existingPaymentIntent.client_secret,
        paymentIntentId: existingPaymentIntent.id,
        stripeAccountId: guestPaymentIntentStripeAccountId,
        orderId: existingOrder?.id || guestCheckoutOperation.orderId,
        displayId: existingOrder?.displayId,
        idempotent: true,
      });
    }
    if (!guestCheckoutOperation.claimedNew && guestCheckoutOperation.status === "STARTED") {
      return reply.status(202).send({
        success: true,
        status: "PAYMENT_CREATION_IN_PROGRESS",
        idempotent: true,
      });
    }

    if (guestIsMultiSeller) {
      const originalSubtotal = cartItems.reduce(
        (sum, item) => sum + getItemUnitPrice(item) * Number(item.quantity || 0),
        0,
      );
      const guestSellerPlans = [];
      for (const [sellerId, sellerItems] of guestSellerMap) {
        const sellerSubtotal = getSellerItemsTotal(sellerItems);
        const discountShare = originalSubtotal > 0
          ? Number(discountAmount || 0) * (sellerSubtotal / originalSubtotal)
          : 0;
        guestSellerPlans.push(await buildSellerPaymentPlan({
            sellerId,
            items: sellerItems,
            cartCalculations,
            discountShare,
        }));
      }

      const shippingAddressData =
        typeof shippingAddress === "string"
          ? { address: shippingAddress }
          : {
              ...shippingAddress,
              orderSummary: {
                subtotal: cartCalculations.subtotal,
                subtotalExGST: cartCalculations.subtotalExGST,
                shippingCost: cartCalculations.shippingCost,
                totalShippingCost: cartCalculations.totalShippingCost,
                sellerCount: cartCalculations.sellerCount,
                gstPercentage: cartCalculations.gstPercentage,
                gstAmount: cartCalculations.gstAmount,
                grandTotal: cartCalculations.grandTotal,
                couponCode: appliedCoupon ? appliedCoupon.code : null,
                discountAmount,
                finalTotal: totalAmount,
                gstInclusive: true,
                shippingMethod: {
                  id: shippingMethod.id,
                  name: shippingMethod.name,
                  cost: shippingMethod.cost,
                  estimatedDays: shippingMethod.estimatedDays,
                },
                gstDetails: cartCalculations.gstDetails,
              },
            };

      const order = await prisma.$transaction(async (tx) => {
        const parentOrder = await tx.order.create({
          data: {
            displayId,
            totalAmount,
            originalTotal,
            couponCode: appliedCoupon ? appliedCoupon.code : null,
            discountAmount: discountAmount > 0 ? discountAmount : null,
            shippingAddress: shippingAddressData,
            shippingAddressLine:
              typeof shippingAddress === "string"
                ? shippingAddress
                : shippingAddress?.shippingAddress || shippingAddress?.addressLine || shippingAddress?.address || "",
            shippingCity: city || shippingAddress?.city || "",
            shippingState: state || shippingAddress?.state || "",
            shippingZipCode: zipCode || shippingAddress?.zipCode || "",
            shippingCountry: country || shippingAddress?.country || "Australia",
            shippingPhone: mobileNumber || customerPhone,
            paymentMethod: "Credit/Debit Card",
            status: "PENDING",
            overallStatus: "PENDING",
            paymentStatus: "PENDING",
            customerName,
            customerEmail,
            customerPhone: mobileNumber || customerPhone || "",
          },
        });

        for (const plan of guestSellerPlans) {
          const subOrderSubtotal = plan.discountedProductAmount + plan.shippingAmount;
          const subOrder = await tx.subOrder.create({
            data: {
              parentOrderId: parentOrder.id,
              sellerId: plan.sellerId,
              subtotal: subOrderSubtotal,
              status: "PENDING",
            },
          });
          await tx.orderItem.createMany({
            data: plan.items.map((i) => ({
              subOrderId: subOrder.id,
              productId: i.product.id,
              variantId: i.productVariant?.id || null,
              quantity: i.quantity,
              price: getItemUnitPrice(i),
            })),
          });
        }
        return parentOrder;
      });

      const payments = [];
      for (const plan of guestSellerPlans) {
        const isPlatformPayment = plan.paymentAccountType === "PLATFORM";
        const metadata = isPlatformPayment
          ? {
              orderId: order.id,
              displayOrderId: order.displayId || order.id,
              sellerId: plan.sellerId,
              paymentFlow: "PLATFORM_ACCOUNT",
              productAmount: (Number(plan.productAmountCents || 0) / 100).toFixed(2),
              shippingAmount: (Number(plan.shippingAmountCents || 0) / 100).toFixed(2),
              gstAmount: (Number(plan.gstAmountCents || 0) / 100).toFixed(2),
              commissionAmount: "0.00",
              environment: process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ? "test" : "live",
            }
          : buildDirectChargeStripeMetadata({
              order,
              sellerId: plan.sellerId,
              sellerStripeAccountId: plan.stripeAccountId,
              productAmountCents: plan.productAmountCents,
              shippingAmountCents: plan.shippingAmountCents,
              gstAmountCents: plan.gstAmountCents,
              commission: plan.commission,
            });
        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount: plan.grossAmountCents,
            currency: "aud",
            description: buildSellerTransactionDescription({
              order,
              customerName: order.customerName,
              customerEmail: order.customerEmail,
              items: plan.items,
              amount: plan.grossAmountCents / 100,
              label: "Seller payment",
            }),
            metadata: {
              ...metadata,
              isGuest: "true",
              customerEmail,
              chargeType: isPlatformPayment ? "platform" : "direct",
            },
            automatic_payment_methods: { enabled: true },
            ...(!isPlatformPayment && { application_fee_amount: plan.commission.applicationFeeAmount }),
          },
          {
            idempotencyKey: `${guestCheckoutApiOperationKey}:${plan.sellerId}`,
            ...(!isPlatformPayment && { stripeAccount: plan.stripeAccountId }),
          },
        );

        const paymentRecord = await prisma.orderPaymentRecord.create({
          data: isPlatformPayment
            ? buildPlatformPaymentRecordData({
                orderId: order.id,
                sellerId: plan.sellerId,
                stripePaymentIntentId: paymentIntent.id,
                itemTotal: plan.discountedProductAmount,
                shippingAmount: plan.shippingAmount,
                grossAmountCents: plan.grossAmountCents,
                gstAmountCents: plan.gstAmountCents,
              })
            : buildDirectChargePaymentRecordData({
                orderId: order.id,
                sellerId: plan.sellerId,
                stripeAccountId: plan.stripeAccountId,
                stripePaymentIntentId: paymentIntent.id,
                itemTotal: plan.discountedProductAmount,
                shippingAmount: plan.shippingAmount,
                commission: plan.commission,
                grossAmountCents: plan.grossAmountCents,
                gstAmountCents: plan.gstAmountCents,
              }),
        });

        payments.push({
          orderPaymentId: paymentRecord.id,
          sellerId: plan.sellerId,
          stripeAccountId: isPlatformPayment ? null : plan.stripeAccountId,
          paymentFlow: isPlatformPayment ? "PLATFORM_ACCOUNT" : "DIRECT_CHARGE",
          paymentIntentId: paymentIntent.id,
          clientSecret: paymentIntent.client_secret,
          amount: plan.grossAmountCents,
          currency: "aud",
        });
      }

      await aggregateParentPaymentStatus(order.id);
      await markApiOperationCompleted({
        operationKey: guestCheckoutApiOperationKey,
        stripePaymentIntentId: payments[0]?.paymentIntentId || null,
        orderId: order.id,
      });

      return reply.status(200).send({
        success: true,
        orderId: order.id,
        displayId: order.displayId,
        amount: amountInCents,
        displayAmount: totalAmount,
        currency: "aud",
        paymentFlow: "DIRECT_CHARGE",
        payments,
        orderSummary: {
          subtotal: cartCalculations.subtotal,
          subtotalExGST: cartCalculations.subtotalExGST,
          shippingCost: cartCalculations.shippingCost,
          totalShippingCost: cartCalculations.totalShippingCost,
          sellerCount: cartCalculations.sellerCount,
          gstAmount: cartCalculations.gstAmount,
          grandTotal: cartCalculations.grandTotal,
          couponCode: appliedCoupon ? appliedCoupon.code : null,
          discountAmount,
          finalTotal: totalAmount,
        },
      });
    }

    console.log("[STRIPE TEST] Payment creation started", {
      mode: process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ? "test" : "not-test",
      orderId: displayId,
      sellerCount: guestSellerMap.size,
      amount: amountInCents,
      currency: "aud",
    });

    // Create Stripe PaymentIntent.
    // Single-seller guest: created on the seller's connected account (true Direct Charge).
    // Multi-seller guest: created on the platform account (Separate Charges + Transfers).
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountInCents,
        currency: "aud",
        description: guestCheckoutPaymentDescription,
        metadata: {
          isGuest: "true",
          customerEmail,
          chargeType: guestPaymentIntentStripeAccountId ? 'direct' : 'platform',
        },
        automatic_payment_methods: { enabled: true },
        ...guestDirectChargeParams,
      },
      {
        // Idempotency key: prevents duplicate PaymentIntents on retry.
        // Uses displayId (generated just above) so retries for the same guest session
        // are stable even without a persistent cartId.
        idempotencyKey: guestCheckoutApiOperationKey,
        ...(guestPaymentIntentStripeAccountId && { stripeAccount: guestPaymentIntentStripeAccountId }),
      },
    );

    console.log("[STRIPE TEST] Payment object created", {
      objectType: paymentIntent.object,
      id: paymentIntent.id,
      status: paymentIntent.status,
      livemode: paymentIntent.livemode,
      amount: paymentIntent.amount,
      connectedAccountId: guestPaymentIntentStripeAccountId,
      requestId: paymentIntent.lastResponse?.requestId || null,
    });

    // Build shippingAddress JSON with order summary
    const shippingAddressData =
      typeof shippingAddress === "string"
        ? { address: shippingAddress }
        : {
            ...shippingAddress,
            orderSummary: {
              subtotal: cartCalculations.subtotal,
              subtotalExGST: cartCalculations.subtotalExGST,
              shippingCost: cartCalculations.shippingCost,
              totalShippingCost: cartCalculations.totalShippingCost,
              sellerCount: cartCalculations.sellerCount,
              gstPercentage: cartCalculations.gstPercentage,
              gstAmount: cartCalculations.gstAmount,
              grandTotal: cartCalculations.grandTotal,
              couponCode: appliedCoupon ? appliedCoupon.code : null,
              discountAmount,
              finalTotal: totalAmount,
              gstInclusive: true,
              shippingMethod: {
                id: shippingMethod.id,
                name: shippingMethod.name,
                cost: shippingMethod.cost,
                estimatedDays: shippingMethod.estimatedDays,
              },
              gstDetails: cartCalculations.gstDetails,
            },
          };

    // Create PENDING guest order (stock deducted on payment success via webhook / confirm)
    const guestOrderBaseData = {
      displayId,
      // userId intentionally omitted — guest order
      totalAmount,
      originalTotal,
      couponCode: appliedCoupon ? appliedCoupon.code : null,
      discountAmount: discountAmount > 0 ? discountAmount : null,
      shippingAddress: shippingAddressData,
      shippingAddressLine:
        typeof shippingAddress === "string"
          ? shippingAddress
          : shippingAddress?.shippingAddress || shippingAddress?.addressLine || shippingAddress?.address || "",
      shippingCity: city || shippingAddress?.city || "",
      shippingState: state || shippingAddress?.state || "",
      shippingZipCode: zipCode || shippingAddress?.zipCode || "",
      shippingCountry: country || shippingAddress?.country || "Australia",
      shippingPhone: mobileNumber || customerPhone,
      paymentMethod: "Credit/Debit Card",
      status: "CONFIRMED",
      overallStatus: "CONFIRMED",
      paymentStatus: "PENDING",
      stripePaymentIntentId: paymentIntent.id,
      customerName,
      customerEmail,
      customerPhone: mobileNumber || customerPhone || "",
    };

    let order;
    if (guestIsMultiSeller) {
      const perSellerShipping = parseFloat(cartCalculations.shippingCost);
      order = await prisma.$transaction(async (tx) => {
        const parentOrder = await tx.order.create({ data: guestOrderBaseData });
        for (const [sellerId, sellerItems] of guestSellerMap) {
          const productsSubtotal = sellerItems.reduce((sum, i) => sum + (i.productVariant ? Number(i.productVariant.price) : Number(i.product.price)) * i.quantity, 0);
          const subOrderSubtotal = productsSubtotal + perSellerShipping;
          const subOrder = await tx.subOrder.create({
            data: { parentOrderId: parentOrder.id, sellerId, subtotal: subOrderSubtotal, status: "CONFIRMED" }
          });
          await tx.orderItem.createMany({
            data: sellerItems.map(i => ({
              subOrderId: subOrder.id,
              productId: i.product.id,
              variantId: i.productVariant?.id || null,
              quantity: i.quantity,
              price: i.productVariant ? Number(i.productVariant.price) : Number(i.product.price)
            }))
          });
        }
        return parentOrder;
      });
    } else {
      const [singleSellerId] = guestSellerMap.keys();
      order = await prisma.$transaction(async (tx) => {
        const createdOrder = await tx.order.create({
          data: {
            ...guestOrderBaseData,
            sellerId: singleSellerId,
            items: { create: orderItems },
          },
        });
        if (guestDirectChargePaymentRecord) {
          const isPlatformPayment = guestDirectChargePaymentRecord.paymentAccountType === "PLATFORM";
          await tx.orderPaymentRecord.create({
            data: isPlatformPayment
              ? buildPlatformPaymentRecordData({
                  orderId: createdOrder.id,
                  stripePaymentIntentId: paymentIntent.id,
                  sellerId: guestDirectChargePaymentRecord.sellerId,
                  itemTotal: guestDirectChargePaymentRecord.itemTotal,
                  shippingAmount: guestDirectChargePaymentRecord.shippingAmount,
                  grossAmountCents: guestDirectChargePaymentRecord.grossAmountCents,
                  gstAmountCents: guestDirectChargePaymentRecord.gstAmountCents,
                })
              : buildDirectChargePaymentRecordData({
                  orderId: createdOrder.id,
                  stripePaymentIntentId: paymentIntent.id,
                  ...guestDirectChargePaymentRecord,
                }),
          });
        }
        return createdOrder;
      });
    }


    // Update PaymentIntent metadata with order ID so it's visible in Stripe Dashboard
    const guestStripeOrderDescription = buildSellerTransactionDescription({
      order,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      items: cartItems,
      amount: totalAmount,
      label: "Made in Arnhem Land guest order",
    });

    if (guestPaymentIntentStripeAccountId) {
      // Reuse the shared Direct Charge metadata builder (same one the
      // multi-seller flows use) so single-seller guest PaymentIntents carry
      // the same reconciliation fields — metadata only, no amount or
      // application_fee_amount change.
      const guestDirectChargeMetadata = guestDirectChargePaymentRecord
        ? buildDirectChargeStripeMetadata({
            order,
            sellerId: guestDirectChargePaymentRecord.sellerId,
            sellerStripeAccountId: guestDirectChargePaymentRecord.stripeAccountId,
            productAmountCents: moneyToMinorUnits(guestDirectChargePaymentRecord.itemTotal),
            shippingAmountCents: moneyToMinorUnits(guestDirectChargePaymentRecord.shippingAmount),
            gstAmountCents: guestDirectChargePaymentRecord.gstAmountCents,
            commission: guestDirectChargePaymentRecord.commission,
            isGuest: true,
            customerEmail,
          })
        : {};
      await stripe.paymentIntents.update(paymentIntent.id, {
        metadata: {
          ...guestDirectChargeMetadata,
          paymentFlow: "DIRECT_CHARGE_SINGLE_SELLER",
          isGuest:      "true",
          customerEmail,
          orderId:      order.id,
          displayId:    order.displayId,
          customerName: order.customerName || "",
          itemSummary:  buildItemSummary(cartItems),
          orderTotal:   totalAmount.toFixed(2),
        },
        description: guestStripeOrderDescription,
      }, { stripeAccount: guestPaymentIntentStripeAccountId });
    } else {
    await stripe.paymentIntents.update(paymentIntent.id, {
      metadata: {
        isGuest:      "true",
        customerEmail,
        orderId:      order.id,
        displayId:    order.displayId,
        customerName: order.customerName || "",
        itemSummary:  buildItemSummary(cartItems),
        orderTotal:   totalAmount.toFixed(2),
      },
      description: `Order ${order.displayId} — Made in Arnhem Land (Guest)`,
    });

    await stripe.paymentIntents.update(paymentIntent.id, {
      description: guestStripeOrderDescription,
    });
    }

    await markApiOperationCompleted({
      operationKey: guestCheckoutApiOperationKey,
      stripePaymentIntentId: paymentIntent.id,
      orderId: order.id,
    });

    return reply.status(200).send({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      stripeAccountId: guestPaymentIntentStripeAccountId,
      orderId: order.id,
      displayId: order.displayId,
      amount: amountInCents,
      displayAmount: totalAmount,
      currency: "aud",
      orderSummary: {
        subtotal: cartCalculations.subtotal,
        subtotalExGST: cartCalculations.subtotalExGST,
        shippingCost: cartCalculations.shippingCost,
        totalShippingCost: cartCalculations.totalShippingCost,
        sellerCount: cartCalculations.sellerCount,
        gstAmount: cartCalculations.gstAmount,
        gstPercentage: cartCalculations.gstPercentage,
        gstInclusive: true,
        originalTotal: originalTotal.toFixed(2),
        couponCode: appliedCoupon ? appliedCoupon.code : null,
        discountAmount: discountAmount > 0 ? discountAmount.toFixed(2) : null,
        grandTotal: totalAmount.toFixed(2),
      },
    });
  } catch (error) {
    if (guestCheckoutApiOperationKey) {
      try {
        await markApiOperationFailed({ operationKey: guestCheckoutApiOperationKey, error });
      } catch (_) { /* best effort */ }
    }
    if (error?.statusCode === 409 && error?.code) {
      console.warn("[STRIPE TEST] Direct Charge readiness blocked guest checkout", {
        code: error.code,
        message: error.message,
      });
      return reply.status(409).send({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    logStripeApiError(error);
    console.error("❌ createGuestPaymentIntent error:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to create guest payment intent",
      error: error.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GUEST — Multi-seller single checkout (mirrors createMultiSellerCheckoutSetup
// above, no auth — guest identity is the customerEmail on the order, same
// pattern already used by confirmGuestPayment/getGuestPaymentStatus).
// POST /api/payments/multi-seller/guest/setup
// ─────────────────────────────────────────────────────────────────────────────
exports.createGuestMultiSellerCheckoutSetup = async (request, reply) => {
  let guestCheckoutApiOperationKey = null;
  try {
    const {
      items,
      customerName,
      customerEmail,
      customerPhone,
      shippingAddress,
      shippingMethodId,
      internationalCountry,
      gstId,
      country,
      city,
      zipCode,
      state,
      mobileNumber,
      couponCode,
    } = request.body;

    const effectiveIntlCountry = (internationalCountry || country || '').trim();
    const isInternational = !!effectiveIntlCountry && effectiveIntlCountry.toLowerCase() !== 'australia';

    if (!items || items.length === 0) {
      return reply.status(400).send({ success: false, message: "Order items are required" });
    }
    if (!customerName || !customerEmail || !customerPhone) {
      return reply.status(400).send({ success: false, message: "Customer name, email, and phone are required" });
    }
    if (!shippingAddress || (!shippingMethodId && !isInternational)) {
      return reply.status(400).send({ success: false, message: "shippingAddress and a shipping method (or international destination country) are required" });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customerEmail)) {
      return reply.status(400).send({ success: false, message: "Invalid email address" });
    }

    let shippingMethod;
    let intlZoneEntry = null;
    if (isInternational) {
      intlZoneEntry = lookupZone(effectiveIntlCountry);
      shippingMethod = {
        id: null,
        name: `International (${effectiveIntlCountry})`,
        cost: intlZoneEntry.cost,
        estimatedDays: '10-20 business days',
      };
    } else {
      shippingMethod = await prisma.shippingMethod.findUnique({ where: { id: shippingMethodId, isActive: true } });
      if (!shippingMethod) {
        return reply.status(400).send({ success: false, message: "Invalid or inactive shipping method" });
      }
    }

    const cartItems = [];
    for (const item of items) {
      const { productId, variantId, quantity } = item;
      if (!productId || !quantity || quantity < 1) {
        return reply.status(400).send({ success: false, message: "Invalid item in order" });
      }
      const product = await prisma.product.findUnique({ where: { id: productId } });
      if (!product) {
        return reply.status(404).send({ success: false, message: `Product ${productId} not found` });
      }
      let variant = null;
      if (variantId) {
        variant = await prisma.productVariant.findUnique({ where: { id: variantId } });
        if (!variant) {
          return reply.status(404).send({ success: false, message: `Variant ${variantId} not found` });
        }
        if (variant.stock < quantity) {
          return reply.status(400).send({ success: false, message: `Insufficient stock for: ${product.title}` });
        }
      } else if (product.stock < quantity) {
        return reply.status(400).send({ success: false, message: `Insufficient stock for: ${product.title}` });
      }
      cartItems.push({ product, productVariant: variant, quantity });
    }

    const cartCalculations = await calculateCartTotals(
      cartItems,
      isInternational ? null : shippingMethodId,
      gstId,
      isInternational ? intlZoneEntry.cost : null
    );
    const originalTotal = parseFloat(cartCalculations.grandTotal);

    // ── Coupon validation — same rules as createGuestPaymentIntent ──────────
    let appliedCoupon = null;
    let discountAmount = 0;
    if (couponCode) {
      const upper   = couponCode.toUpperCase();
      const gstRate = parseFloat(cartCalculations.gstPercentage) || 0;
      const sellerCoupon = await prisma.sellerCoupon.findUnique({ where: { code: upper } });
      if (sellerCoupon && !sellerCoupon.softDeletedAt) {
        if (!sellerCoupon.isActive) return reply.status(400).send({ success: false, message: "Coupon is no longer active" });
        if (new Date() > sellerCoupon.expiresAt) return reply.status(400).send({ success: false, message: "Coupon has expired" });
        if (sellerCoupon.usageLimit !== null && sellerCoupon.usageCount >= sellerCoupon.usageLimit)
          return reply.status(400).send({ success: false, message: "Coupon usage limit reached" });
        discountAmount = calcSellerCouponDiscount(sellerCoupon, cartItems, gstRate);
        appliedCoupon  = sellerCoupon;
      } else {
        const coupon = await prisma.coupon.findUnique({ where: { code: upper } });
        if (!coupon) return reply.status(400).send({ success: false, message: "Invalid coupon code" });
        if (!coupon.isActive) return reply.status(400).send({ success: false, message: "Coupon is no longer active" });
        if (new Date() > coupon.expiresAt) return reply.status(400).send({ success: false, message: "Coupon has expired" });
        if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit)
          return reply.status(400).send({ success: false, message: "Coupon usage limit reached" });
        if (coupon.minCartValue !== null && originalTotal < coupon.minCartValue)
          return reply.status(400).send({ success: false, message: `Minimum cart value of $${coupon.minCartValue.toFixed(2)} required` });
        if (coupon.discountType === "percentage") {
          discountAmount = parseFloat(((originalTotal * coupon.discountValue) / 100).toFixed(2));
          if (coupon.maxDiscount !== null) discountAmount = Math.min(discountAmount, coupon.maxDiscount);
        } else {
          discountAmount = Math.min(coupon.discountValue, originalTotal);
        }
        appliedCoupon = coupon;
      }
    }

    const totalAmount = parseFloat((originalTotal - discountAmount).toFixed(2));
    const amountInCents = Math.round(totalAmount * 100);

    const guestSellerMap = new Map();
    for (const { product, productVariant, quantity } of cartItems) {
      const sid = product.sellerId;
      if (!guestSellerMap.has(sid)) guestSellerMap.set(sid, []);
      guestSellerMap.get(sid).push({ product, productVariant, quantity });
    }

    if (guestSellerMap.size <= 1) {
      return reply.status(400).send({
        success: false,
        message: "This cart has a single seller — use /api/payments/guest/create-intent instead.",
      });
    }

    const displayId = await generateDisplayId();
    const normalizedGuestEmail = customerEmail.trim().toLowerCase();

    const guestCheckoutRequestHash = hashOperationPayload({
      customerEmail: normalizedGuestEmail,
      customerPhone,
      amountInCents,
      shippingMethodId: shippingMethodId || null,
      gstId: gstId || null,
      isInternational,
      effectiveIntlCountry,
      couponCode: couponCode || null,
      items: normalizeGuestItemsForOperation(items),
    });
    guestCheckoutApiOperationKey = checkoutOperationKey({
      scope: "guest",
      subjectId: normalizedGuestEmail,
      sellerId: "multi-seller",
      amountInCents,
      requestHash: guestCheckoutRequestHash,
    });
    const guestCheckoutOperation = await claimApiOperation({
      operationKey: guestCheckoutApiOperationKey,
      operationType: "GUEST_MULTI_SELLER_SETUP_CREATE",
      requestHash: guestCheckoutRequestHash,
      attemptNumber: 1,
    });
    if (guestCheckoutOperation.status === "COMPLETED" && guestCheckoutOperation.orderId) {
      const existingOrder = await prisma.order.findUnique({
        where: { id: guestCheckoutOperation.orderId },
        include: { multiSellerCheckoutSession: true },
      });
      if (existingOrder?.multiSellerCheckoutSession) {
        const existingSetupIntent = await stripe.setupIntents.retrieve(
          existingOrder.multiSellerCheckoutSession.platformSetupIntentId,
        );
        return reply.status(200).send({
          success: true,
          orderId: existingOrder.id,
          displayId: existingOrder.displayId,
          clientSecret: existingSetupIntent.client_secret,
          amount: amountInCents,
          displayAmount: totalAmount,
          currency: "aud",
          sellerBreakdown: existingOrder.shippingAddress?.orderSummary?.multiSellerPlan || [],
          idempotent: true,
        });
      }
    }
    if (!guestCheckoutOperation.claimedNew && guestCheckoutOperation.status === "STARTED") {
      return reply.status(202).send({ success: true, status: "PAYMENT_CREATION_IN_PROGRESS", idempotent: true });
    }

    const originalSubtotal = cartItems.reduce(
      (sum, item) => sum + getItemUnitPrice(item) * Number(item.quantity || 0),
      0,
    );
    const sellerPlans = [];
    for (const [sellerId, sellerItems] of guestSellerMap) {
      const sellerSubtotal = getSellerItemsTotal(sellerItems);
      const discountShare = originalSubtotal > 0
        ? Number(discountAmount || 0) * (sellerSubtotal / originalSubtotal)
        : 0;
      sellerPlans.push(await buildSellerPaymentPlan({
        sellerId,
        items: sellerItems,
        cartCalculations,
        discountShare,
      }));
    }

    const shippingAddressData =
      typeof shippingAddress === "string"
        ? { address: shippingAddress }
        : {
            ...shippingAddress,
            orderSummary: {
              subtotal: cartCalculations.subtotal,
              subtotalExGST: cartCalculations.subtotalExGST,
              shippingCost: cartCalculations.shippingCost,
              totalShippingCost: cartCalculations.totalShippingCost,
              sellerCount: cartCalculations.sellerCount,
              gstPercentage: cartCalculations.gstPercentage,
              gstAmount: cartCalculations.gstAmount,
              grandTotal: cartCalculations.grandTotal,
              couponCode: appliedCoupon ? appliedCoupon.code : null,
              discountAmount,
              finalTotal: totalAmount,
              gstInclusive: true,
              shippingMethod: {
                id: shippingMethod.id,
                name: shippingMethod.name,
                cost: shippingMethod.cost,
                estimatedDays: shippingMethod.estimatedDays,
              },
              gstDetails: cartCalculations.gstDetails,
            },
          };

    const { order, sellerBreakdown } = await prisma.$transaction(async (tx) => {
      const parentOrder = await tx.order.create({
        data: {
          displayId,
          totalAmount,
          originalTotal,
          couponCode: appliedCoupon ? appliedCoupon.code : null,
          discountAmount: discountAmount > 0 ? discountAmount : null,
          shippingAddress: shippingAddressData,
          shippingAddressLine:
            typeof shippingAddress === "string"
              ? shippingAddress
              : shippingAddress?.shippingAddress || shippingAddress?.addressLine || shippingAddress?.address || "",
          shippingCity: city || shippingAddress?.city || "",
          shippingState: state || shippingAddress?.state || "",
          shippingZipCode: zipCode || shippingAddress?.zipCode || "",
          shippingCountry: country || shippingAddress?.country || "Australia",
          shippingPhone: mobileNumber || customerPhone,
          paymentMethod: "Credit/Debit Card",
          status: "PENDING",
          overallStatus: "PENDING",
          paymentStatus: "PENDING",
          customerName,
          customerEmail,
          customerPhone: mobileNumber || customerPhone || "",
        },
      });

      const breakdown = [];
      for (const plan of sellerPlans) {
        const subOrderSubtotal = plan.discountedProductAmount + plan.shippingAmount;
        const subOrder = await tx.subOrder.create({
          data: { parentOrderId: parentOrder.id, sellerId: plan.sellerId, subtotal: subOrderSubtotal, status: "PENDING" },
        });
        await tx.orderItem.createMany({
          data: plan.items.map((i) => ({
            subOrderId: subOrder.id,
            productId: i.product.id,
            variantId: i.productVariant?.id || null,
            quantity: i.quantity,
            price: getItemUnitPrice(i),
          })),
        });
        breakdown.push({
          sellerId: plan.sellerId,
          subOrderId: subOrder.id,
          stripeAccountId: plan.paymentAccountType === "PLATFORM" ? null : plan.stripeAccountId,
          paymentAccountType: plan.paymentAccountType,
          paymentFlow: plan.paymentAccountType === "PLATFORM" ? "PLATFORM_ACCOUNT" : "DIRECT_CHARGE",
          productAmountCents: plan.productAmountCents,
          shippingAmountCents: plan.shippingAmountCents,
          gstAmountCents: plan.gstAmountCents,
          grossAmountCents: plan.grossAmountCents,
          commission: plan.commission,
        });
      }

      await tx.order.update({
        where: { id: parentOrder.id },
        data: {
          shippingAddress: {
            ...shippingAddressData,
            orderSummary: { ...shippingAddressData.orderSummary, multiSellerPlan: breakdown },
          },
        },
      });

      return { order: parentOrder, sellerBreakdown: breakdown };
    });

    const platformCustomer = await stripe.customers.create({
      email: customerEmail,
      name: customerName,
      metadata: { orderId: order.id, displayId: order.displayId, isGuest: "true" },
    }, { idempotencyKey: `${guestCheckoutApiOperationKey}:customer` });

    const setupIntent = await stripe.setupIntents.create({
      customer: platformCustomer.id,
      automatic_payment_methods: { enabled: true },
      metadata: {
        orderId: order.id,
        displayId: order.displayId,
        isGuest: "true",
        customerEmail,
        paymentFlow: "DIRECT_CHARGE_MULTI_SELLER",
      },
    }, { idempotencyKey: `${guestCheckoutApiOperationKey}:setup-intent` });

    await prisma.multiSellerCheckoutSession.create({
      data: {
        orderId: order.id,
        platformCustomerId: platformCustomer.id,
        platformSetupIntentId: setupIntent.id,
        status: "COLLECTING_PAYMENT_METHOD",
      },
    });

    await markApiOperationCompleted({ operationKey: guestCheckoutApiOperationKey, stripePaymentIntentId: null, orderId: order.id });

    return reply.status(200).send({
      success: true,
      orderId: order.id,
      displayId: order.displayId,
      clientSecret: setupIntent.client_secret,
      amount: amountInCents,
      displayAmount: totalAmount,
      currency: "aud",
      paymentFlow: "DIRECT_CHARGE_MULTI_SELLER",
      sellerBreakdown,
      orderSummary: {
        subtotal: cartCalculations.subtotal,
        subtotalExGST: cartCalculations.subtotalExGST,
        shippingCost: cartCalculations.shippingCost,
        totalShippingCost: cartCalculations.totalShippingCost,
        sellerCount: cartCalculations.sellerCount,
        gstAmount: cartCalculations.gstAmount,
        grandTotal: cartCalculations.grandTotal,
        couponCode: appliedCoupon ? appliedCoupon.code : null,
        discountAmount,
        finalTotal: totalAmount,
      },
    });
  } catch (error) {
    if (guestCheckoutApiOperationKey) {
      try { await markApiOperationFailed({ operationKey: guestCheckoutApiOperationKey, error }); } catch (_) {}
    }
    if (error?.statusCode === 409 && error?.code) {
      return reply.status(409).send({ success: false, code: error.code, message: error.message });
    }
    logStripeApiError(error);
    console.error("❌ createGuestMultiSellerCheckoutSetup error:", error);
    return reply.status(500).send({ success: false, message: "Failed to set up guest multi-seller checkout", error: error.message });
  }
};

// GUEST — finalize (mirrors finalizeMultiSellerCheckout above). Ownership is
// verified via customerEmail instead of a JWT userId, same trust model as
// confirmGuestPayment/getGuestPaymentStatus elsewhere in this file.
// POST /api/payments/multi-seller/guest/finalize
// Body: { orderId, customerEmail }
// ─────────────────────────────────────────────────────────────────────────────
exports.finalizeGuestMultiSellerCheckout = async (request, reply) => {
  try {
    const { orderId, customerEmail } = request.body;
    if (!orderId || !customerEmail) {
      return reply.status(400).send({ success: false, message: "orderId and customerEmail are required" });
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, userId: null },
      include: { multiSellerCheckoutSession: true },
    });
    if (!order || order.customerEmail.trim().toLowerCase() !== customerEmail.trim().toLowerCase()) {
      return reply.status(404).send({ success: false, message: "Guest order not found" });
    }
    const session = order.multiSellerCheckoutSession;
    if (!session) {
      return reply.status(400).send({ success: false, message: "No multi-seller checkout session for this order" });
    }

    const sellerPlans = order.shippingAddress?.orderSummary?.multiSellerPlan;
    if (!Array.isArray(sellerPlans) || !sellerPlans.length) {
      return reply.status(400).send({ success: false, message: "No seller plan found for this order" });
    }

    if (session.status !== "COLLECTING_PAYMENT_METHOD") {
      const existingRecords = await prisma.orderPaymentRecord.findMany({ where: { orderId: order.id } });
      return reply.status(200).send({
        success: true,
        orderId: order.id,
        displayId: order.displayId,
        idempotent: true,
        payments: existingRecords.map((r) => ({
          sellerId: r.sellerId,
          stripeAccountId: r.stripeAccountId,
          paymentIntentId: r.stripePaymentIntentId,
          status: r.paymentStatus,
        })),
      });
    }

    const setupIntent = await stripe.setupIntents.retrieve(session.platformSetupIntentId);
    if (setupIntent.status !== "succeeded" || !setupIntent.payment_method) {
      return reply.status(400).send({ success: false, message: `Card setup not complete. Stripe SetupIntent status: ${setupIntent.status}` });
    }
    const platformPaymentMethodId = setupIntent.payment_method;

    const claimed = await prisma.multiSellerCheckoutSession.updateMany({
      where: { orderId: order.id, status: "COLLECTING_PAYMENT_METHOD" },
      data: { status: "CHARGING_SELLERS", platformPaymentMethodId },
    });
    if (claimed.count !== 1) {
      const existingRecords = await prisma.orderPaymentRecord.findMany({ where: { orderId: order.id } });
      return reply.status(200).send({
        success: true,
        orderId: order.id,
        displayId: order.displayId,
        idempotent: true,
        payments: existingRecords.map((r) => ({
          sellerId: r.sellerId,
          stripeAccountId: r.stripeAccountId,
          paymentIntentId: r.stripePaymentIntentId,
          status: r.paymentStatus,
        })),
      });
    }

    const results = await chargeSellerPlansForConnectedAccounts({
      order,
      session,
      sellerPlans,
      platformPaymentMethodId,
      extraMetadata: { isGuest: "true", customerEmail: order.customerEmail },
    });

    const paymentStatus = await aggregateParentPaymentStatus(order.id);
    const allSucceeded = results.every((r) => r.status === "succeeded");
    const anySucceeded = results.some((r) => r.status === "succeeded");
    await prisma.multiSellerCheckoutSession.update({
      where: { orderId: order.id },
      data: { status: allSucceeded ? "COMPLETED" : anySucceeded ? "PARTIALLY_COMPLETED" : "FAILED" },
    });

    return reply.status(200).send({
      success: true,
      orderId: order.id,
      displayId: order.displayId,
      paymentStatus,
      payments: results,
    });
  } catch (error) {
    logStripeApiError(error);
    console.error("❌ finalizeGuestMultiSellerCheckout error:", error);
    return reply.status(500).send({ success: false, message: "Failed to finalize guest multi-seller checkout", error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GUEST — Confirm Stripe Payment (no auth required)
// POST /api/payments/guest/confirm
// Body: { paymentIntentId, customerEmail }
// ─────────────────────────────────────────────────────────────────────────────
exports.confirmGuestPayment = async (request, reply) => {
  try {
    const { paymentIntentId, customerEmail } = request.body;

    if (!paymentIntentId || !customerEmail) {
      return reply.status(400).send({
        success: false,
        message: "paymentIntentId and customerEmail are required",
      });
    }

    // Verify payment with Stripe
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (stripeErr) {
      const orderForStripe = await prisma.order.findFirst({
        where: {
          stripePaymentIntentId: paymentIntentId,
          customerEmail,
          userId: null,
        },
      });
      if (orderForStripe) {
        try {
          ({ paymentIntent } = await retrievePaymentIntentForOrder(paymentIntentId, orderForStripe));
        } catch (connectedErr) {
          console.error("Stripe connected-account retrieve error:", connectedErr.message);
        }
      }
      if (paymentIntent?.status !== "succeeded") {
      console.error("❌ Stripe retrieve error:", stripeErr.message);
      return reply.status(400).send({
        success: false,
        message: "Failed to verify payment with Stripe",
      });
      }
    }

    // If Stripe says it already succeeded, honour that and proceed to confirmation
    // (handles redirect-based methods like Klarna/Zip that can trigger double-confirm)
    if (paymentIntent.status !== "succeeded") {
      return reply.status(400).send({
        success: false,
        message: `Payment not successful. Stripe status: ${paymentIntent.status}`,
      });
    }

    // Find the guest order — matched by paymentIntentId + customerEmail (no userId)
    const order = await prisma.order.findFirst({
      where: {
        stripePaymentIntentId: paymentIntentId,
        customerEmail,
        userId: null, // guest orders only
      },
      include: { items: { include: { product: true } } },
    });

    if (!order) {
      return reply.status(404).send({
        success: false,
        message: "Guest order not found for this payment",
      });
    }

    // Idempotency guard
    // The verified Stripe webhook is authoritative for permanent completion.
    // Guest confirmation only reports that Stripe accepted/submitted payment.
    if (order.paymentStatus === "PAID") {
      return reply.status(200).send({
        success: true,
        message: "Payment already confirmed by Stripe webhook",
        orderId: order.id,
        displayId: order.displayId,
        status: order.status,
        paymentStatus: order.paymentStatus,
        stripeStatus: paymentIntent.status,
      });
    }

    return reply.status(202).send({
      success: true,
      message: "Payment submitted. Awaiting secure confirmation from Stripe.",
      orderId: order.id,
      displayId: order.displayId,
      status: "AWAITING_WEBHOOK_CONFIRMATION",
      paymentStatus: order.paymentStatus,
      stripeStatus: paymentIntent.status,
      awaitingWebhook: true,
    });
  } catch (error) {
    console.error("❌ confirmGuestPayment error:", error);
    // Stripe API errors (e.g. payment_intent_unexpected_state) are user-facing
    if (error.type === "StripeInvalidRequestError") {
      return reply.status(400).send({
        success: false,
        message: error.message,
        stripeCode: error.code,
      });
    }
    return reply.status(500).send({
      success: false,
      message: "Failed to confirm guest payment",
      error: error.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GUEST — Check payment + order status (no auth - verified by email)
// GET /api/payments/guest/status?orderId=xxx&customerEmail=xxx
// ─────────────────────────────────────────────────────────────────────────────
exports.getGuestPaymentStatus = async (request, reply) => {
  try {
    const { orderId, customerEmail } = request.query;

    if (!orderId || !customerEmail) {
      return reply.status(400).send({
        success: false,
        message: "orderId and customerEmail are required",
      });
    }

    const order = await prisma.order.findFirst({
      where: { id: orderId, customerEmail, userId: null },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        paymentMethod: true,
        totalAmount: true,
        createdAt: true,
      },
    });

    if (!order) {
      return reply.status(404).send({ success: false, message: "Order not found" });
    }

    return reply.status(200).send({ success: true, order });
  } catch (error) {
    console.error("❌ getGuestPaymentStatus error:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to get guest payment status",
    });
  }
};

