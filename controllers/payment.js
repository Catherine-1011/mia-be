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
  sendSellerPayoutTransferEmail,
} = require("../utils/emailService");
const {
  notifyAdminNewOrder,
  notifySellerNewOrder,
} = require("./notification");
const { createOrderNotification } = require("./orderNotification");
const { createCommissionEarned, getCommissionForSeller, getDefaultCommission } = require("./commission");
const { calculateSellerPayout } = require("../utils/commissionCalculator");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Keep checkout PaymentIntents on the platform account so the frontend can
// confirm them with the platform publishable key. Single-seller orders still
// route funds to the seller through Connect destination charges.
const USE_DIRECT_CHARGES_FOR_SINGLE_SELLER = true;

const STRIPE_DESCRIPTION_MAX_LENGTH = 255;

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
  label = "Seller payout",
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

    // Build per-seller map BEFORE creating PaymentIntent so we can use
    // Direct Charges (application_fee + transfer_data) for single-seller orders
    const sellerItemsMap = new Map();
    for (const item of cart.items) {
      const sid = item.product.sellerId;
      if (!sellerItemsMap.has(sid)) sellerItemsMap.set(sid, []);
      sellerItemsMap.get(sid).push(item);
    }
    const isMultiSeller = sellerItemsMap.size > 1;
    const displayId = await generateDisplayId();
    const destinationPaymentDescription = buildSellerTransactionDescription({
      order: { id: displayId, displayId },
      customerName: user.isDeleted ? 'Deleted User' : user.name,
      customerEmail: user.email,
      items: cart.items,
      amount: totalAmount,
      label: "Seller payment",
    });

    // For single-seller: use a platform PaymentIntent with transfer_data —
    // checkout stays compatible with the existing frontend while Stripe routes
    // funds to the connected seller account and ALPA takes application_fee.
    // For multi-seller: fall back to Separate Charges + Transfers (Stripe limitation:
    // a single PaymentIntent can only have one transfer_data destination).
    let directChargeParams = {};
    let paymentIntentStripeAccountId = null;
    if (!isMultiSeller && USE_DIRECT_CHARGES_FOR_SINGLE_SELLER) {
      const [singleSellerId] = sellerItemsMap.keys();
      const sellerProfile = await prisma.sellerProfile.findUnique({
        where:  { userId: singleSellerId },
        select: { stripeAccountId: true, stripeChargesEnabled: true },
      });
      if (sellerProfile?.stripeAccountId && sellerProfile?.stripeChargesEnabled) {
        // Calculate commission (application fee) for this seller
        const sellerCommission   = await getCommissionForSeller(singleSellerId);
        const resolvedCommission = sellerCommission || (await getDefaultCommission());
        const commissionRatePct  = resolvedCommission ? parseFloat(resolvedCommission.value) : 10;
        const itemTotal = cart.items.reduce((s, i) => s + Number(i.productVariant?.price ?? i.product.price) * i.quantity, 0);
        const perSellerShipping  = parseFloat(cartCalculations.shippingCost);
        const payout = calculateSellerPayout(itemTotal, perSellerShipping, commissionRatePct);
        // Check if seller has card_payments capability before using on_behalf_of.
        // The PaymentIntent itself must remain on the platform account.
        let cardPaymentsActive = false;
        try {
          const acct = await stripe.accounts.retrieve(sellerProfile.stripeAccountId);
          cardPaymentsActive = acct.capabilities?.card_payments === 'active';
        } catch (e) {
          console.warn(`⚠️  Could not retrieve seller Stripe capabilities: ${e.message}`);
        }
        directChargeParams = {
          ...(cardPaymentsActive && { on_behalf_of: sellerProfile.stripeAccountId }),
          application_fee_amount: payout.commissionAmountCents,
          transfer_data: {
            destination: sellerProfile.stripeAccountId,
          },
        };
      }
    }

    // Create Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "aud",
      description: destinationPaymentDescription,
      metadata: {
        userId,
        cartId: cart.id,
        chargeType: Object.keys(directChargeParams).length ? 'direct' : 'platform',
      },
      automatic_payment_methods: { enabled: true },
      ...directChargeParams,
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
      order = await prisma.order.create({
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
        description: stripeOrderDescription,
      });
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
    console.error("❌ createPaymentIntent error:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to create payment intent",
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

    if (paymentIntent.status !== "succeeded") {
      return reply.status(400).send({
        success: false,
        message: `Payment not successful. Stripe status: ${paymentIntent.status}`,
      });
    }

    // Idempotency — if already confirmed, just return success
    if (order.paymentStatus === "PAID") {
      return reply.status(200).send({
        success: true,
        message: "Payment already confirmed",
        orderId: order.id,
        displayId: order.displayId,
      });
    }

    // Deduct stock, clear cart, mark PAID, send confirmation email, notify admins.
    // handlePaymentSucceeded is the single source of truth — works for webhook,
    // logged-in confirm, and guest confirm paths without duplication.
    await handlePaymentSucceeded(paymentIntentId);

    return reply.status(200).send({
      success: true,
      message: "Payment confirmed and order placed successfully",
      orderId: order.id,
      displayId: order.displayId,
      status: "CONFIRMED",
      paymentStatus: "PAID",
    });
  } catch (error) {
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
    console.error("❌ Stripe webhook signature verification failed:", err.message);
    return reply.status(400).send({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        await handlePaymentSucceeded(pi.id);
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        const failReason = pi.last_payment_error?.message || 'Card declined';

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

          console.log(`❌ Payment failed — Order #${failedOrder.displayId} cancelled, stock restored. Reason: ${failReason}`);
        } else {
          await prisma.order.updateMany({
            where: { stripePaymentIntentId: pi.id },
            data: { paymentStatus: 'FAILED' },
          });
          console.log(`⚠️ Payment failed for PaymentIntent: ${pi.id}. Reason: ${failReason}`);
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

        // chargeType is stored on the PaymentIntent metadata (not charge metadata)
        let chargeType = 'platform';
        try {
          const pi = await stripe.paymentIntents.retrieve(piId);
          chargeType = pi.metadata?.chargeType || 'platform';
        } catch (e) {
          console.warn(`⚠️  Could not retrieve PaymentIntent for chargeType check: ${e.message}`);
        }

        if (chargeType === 'direct') {
          // Stripe automatically reversed the application fee — nothing to do
          console.log(`↩️  Direct Charge refunded for PI ${piId} — Stripe handled application fee reversal automatically`);
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
            await stripe.transfers.createReversal(rec.stripe_transfer_id, {
              metadata: { reason: "order_refunded", orderId: refundedOrder.id },
            });
            await prisma.$executeRaw`
              UPDATE commission_earned
              SET stripe_transfer_status = 'reversed',
                  status                 = 'CANCELLED'::"CommissionStatus",
                  updated_at             = NOW()
              WHERE id = ${rec.id}
            `;
            console.log(`↩️  Transfer reversed — commissionId: ${rec.id}, transferId: ${rec.stripe_transfer_id}`);
          } catch (reverseErr) {
            console.error(`❌ Transfer reversal failed (commissionId: ${rec.id}):`, reverseErr.message);
          }
        }
        break;
      }
      case "charge.dispute.created": {
        const dispute = event.data.object;
        const chargeId = dispute.charge;
        const disputedCharge = chargeId ? await stripe.charges.retrieve(chargeId) : null;
        const piId = disputedCharge?.payment_intent || null;

        // Look up the order
        let disputedOrder = null;
        if (piId) {
          disputedOrder = await prisma.order.findFirst({
            where: { stripePaymentIntentId: piId },
            include: { user: { select: { email: true } } }
          });
        }

        const adminEmail = process.env.FINANCE_EMAIL_RECEIVER || 'ritikkashyap013@gmail.com';
        await sendDisputeAlertEmail({
          adminEmail,
          adminName: 'Admin',
          disputeId: dispute.id,
          amount: dispute.amount,
          currency: dispute.currency,
          reason: dispute.reason,
          orderId: disputedOrder?.id || null,
          orderDisplayId: disputedOrder?.displayId || null,
          chargeId,
          customerEmail: disputedCharge?.billing_details?.email || disputedOrder?.user?.email || null,
        });

        console.log(`🚨 Dispute created — ID: ${dispute.id}, Amount: ${dispute.amount}, Reason: ${dispute.reason}, Order: ${disputedOrder?.displayId || 'unknown'}`);
        break;
      }
      default:
        console.log(`Unhandled Stripe event: ${event.type}`);
    }

    return reply.status(200).send({ received: true });
  } catch (error) {
    console.error("❌ Webhook handler error:", error);
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
async function handlePaymentSucceeded(paymentIntentId) {
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
    console.log(`ℹ️  handlePaymentSucceeded: ${paymentIntentId} already processed — skipping`);
    return false;
  }

  // Retrieve PaymentIntent from Stripe to get latest_charge + chargeType (needed for transfers).
  // Captured once here so the per-seller loop never needs a redundant API call.
  let latestChargeId = null;
  let piChargeType = 'platform'; // default — overridden below if PI is retrievable
  let retrievedPaymentIntentStripeAccountId = null;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    latestChargeId = pi.latest_charge || null;
    piChargeType   = pi.metadata?.chargeType || 'platform';
  } catch (e) {
    console.warn(`⚠️  Could not retrieve PaymentIntent for charge ID / chargeType: ${e.message}`);
  }

  // Fetch the now-PAID order for stock deduction, email, and notifications.
  const order = await prisma.order.findFirst({
    where: { stripePaymentIntentId: paymentIntentId },
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

  try {
    const { paymentIntent: pi, stripeAccountId } = await retrievePaymentIntentForOrder(paymentIntentId, order);
    latestChargeId = pi.latest_charge || latestChargeId;
    piChargeType   = pi.metadata?.chargeType || piChargeType;
    retrievedPaymentIntentStripeAccountId = stripeAccountId || null;
  } catch (e) {
    console.warn(`Could not retrieve PaymentIntent with order context: ${e.message}`);
  }

  // Build a flat list of all items (direct items + sub-order items)
  const allItems = [
    ...(order.items || []),
    ...(order.subOrders?.flatMap(sub => sub.items) || [])
  ];

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
  });

  console.log(`✅ Order ${order.id} confirmed (paymentIntentId: ${paymentIntentId})`);

  // ── Send confirmation email ─────────────────────────────────────────────
  // Uses order.customerEmail which is always stored at order-creation time for
  // both guest and logged-in orders, so this works for every payment path
  // (webhook, /confirm, /guest/confirm) without any extra lookup.
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
      let title = base;
      if (variant?.variantAttributeValues?.length) {
        const attrs = variant.variantAttributeValues
          .map(av => `${av.attributeValue?.attribute?.name}: ${av.attributeValue?.value}`)
          .filter(Boolean).join(', ');
        if (attrs) title = `${base} (${attrs})`;
      }
      const price = variant ? Number(variant.price) : Number(item.price);
      return { title, quantity: item.quantity, price };
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

  if (toEmail) {
    sendOrderConfirmationEmail(toEmail, toName, orderDetailsForEmail)
      .catch((e) => console.error('Email error (non-blocking):', e.message));
  } else {
    console.warn(`⚠️  No customerEmail on order ${order.id} — confirmation email skipped`);
  }

  // ── Send Finance Copy with Invoice PDF attached ───────────────────────
  try {
    const invoiceOrderRecord = await prisma.order.findUnique({
      where: { id: order.id },
      include: {
        items:     { include: { product: { select: { id: true, title: true, price: true, sellerId: true } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
        subOrders: { include: { seller: { select: { name: true } }, items: { include: { product: { select: { id: true, title: true, price: true } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } } } },
        user:      { select: { name: true, email: true, phone: true } },
      }
    });

    if (invoiceOrderRecord) {
      const invoiceShape = {
        ...invoiceOrderRecord,
        customerName:  (invoiceOrderRecord.user?.isDeleted ? 'Deleted User' : invoiceOrderRecord.user?.name) || invoiceOrderRecord.customerName,
        customerEmail: invoiceOrderRecord.user?.email || invoiceOrderRecord.customerEmail,
        customerPhone: invoiceOrderRecord.user?.phone || invoiceOrderRecord.customerPhone,
      };
      const financePdfBuffer = await generateInvoiceBuffer(invoiceShape);
      await sendFinanceOrderInvoiceEmail(invoiceShape, financePdfBuffer);
    }
  } catch (financeErr) {
    console.error('Error generating finance email/invoice (non-blocking):', financeErr);
  }

  // ── Notify admins ───────────────────────────────────────────────────────
  // Resolve seller display names and product titles from all items (direct + sub-order)
  const sellerIdSet = [...new Set(allItems.map(i => i.product?.sellerId).filter(Boolean))];
  const sellerDisplayNames = await Promise.all(sellerIdSet.map(async sid => {
    const s = await prisma.user.findUnique({ where: { id: sid }, select: { name: true, sellerProfile: { select: { storeName: true, businessName: true } } } });
    return s?.name || s?.sellerProfile?.storeName || s?.sellerProfile?.businessName || 'Unknown';
  }));
  const productTitles = allItems.map(i => i.product?.title).filter(Boolean);

  notifyAdminNewOrder(order.id, {
    customerName: toName,
    sellerName:   sellerDisplayNames.join(', ') || 'Unknown',
    totalAmount:  Number(order.totalAmount).toFixed(2),
    itemCount:    allItems.length,
    productNames: productTitles,
    orderId:      order.id,
  }).catch((e) => console.error('Admin notification error (non-blocking):', e.message));

  // Send Super Admin Copy of Order Confirmation
  prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } })
    .then(admins => {
      for (const admin of admins) {
        if (admin.email) {
          sendOrderConfirmationEmail(admin.email, admin.name || 'Super Admin', {
            ...orderDetailsForEmail,
            isSuperAdminCopy: true
          }).catch(e => console.error('Admin order email error (non-blocking):', e.message));
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
    const sellerTransactionDescription = buildSellerTransactionDescription({
      order: sellerSubOrder || order,
      customerName: toName,
      customerEmail: order.customerEmail,
      items: sellerItems,
      label: "Seller payout",
    });
    createOrderNotification(order.id, sid, 'ORDER_PROCESSING', 'HIGH', {
      message: `New order received from ${toName}`,
      notes: `${itemCount} item(s), Total: $${itemTotal.toFixed(2)}`
    }).catch((e) => console.error('SLA notification error (non-blocking):', e.message));
    notifySellerNewOrder(sid, order.id, {
      customerName: toName,
      totalAmount: itemTotal.toFixed(2),
      itemCount,
      productNames
    }).catch((e) => console.error('Seller in-app notification error (non-blocking):', e.message));

    // Send Seller Email Notification
    prisma.user.findUnique({ where: { id: sid }, select: { email: true, name: true, sellerProfile: { select: { storeName: true, businessName: true } } } })
      .then(seller => {
        if (seller && seller.email) {
          const sellerSubOrder = order.subOrders && order.subOrders.find(sub => sub.sellerId === sid || sub.seller?.id === sid);
          const sName = seller.name || seller.sellerProfile?.storeName || seller.sellerProfile?.businessName || 'Seller';
          
          sendOrderConfirmationEmail(seller.email, sName, {
            ...orderDetailsForEmail,
            isSellerCopy: true,
            subOrderId: sellerSubOrder ? sellerSubOrder.id : undefined,
            products: sellerItems.map(i => ({
              title: i.product?.title,
              quantity: i.quantity,
              price: Number(i.price)
            })),
            totalAmount: itemTotal // Correct totally to just the seller's total
          }).catch(e => console.error('Seller order email error:', e.message));
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
    }).catch((e) => { console.error('Commission earned error (non-blocking):', e.message); return null; });

    // ── Stripe Payout ───────────────────────────────────────────────────────
    // Direct Charge orders: Stripe already routed funds to the seller and
    // collected ALPA's application fee automatically — no manual transfer needed.
    // Platform (multi-seller) orders: create a manual transfer as before.
    // piChargeType is resolved once above (from the single PaymentIntent retrieval)
    // so this never triggers a redundant Stripe API call inside the seller loop.
    const isDirectCharge = piChargeType === 'direct';
    const sellerStripeMetadata = buildSellerStripeOrderMetadata({
      order,
      subOrder: sellerSubOrder,
      sellerId: sid,
      customerName: toName,
      customerEmail: order.customerEmail,
      items: sellerItems,
      amount: itemTotal,
    });

    if (isDirectCharge) {
      // Direct Charge — Stripe handled payout automatically.
      // Update the auto-generated transfer and destination payment with order
      // details so the seller sees useful context in their Standard dashboard.
      (async () => {
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
              console.log(`📝 Seller Stripe payment updated — transferId: ${autoTransferId}, order: ${order.displayId}`);
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
      console.log(`✅ Direct Charge — seller ${sid} payout handled by Stripe automatically`);

      // Notify seller by email (non-blocking)
      const sellerUser = await prisma.user.findUnique({
        where: { id: sid },
        select: { email: true, name: true },
      });
      if (sellerUser?.email) {
        sendSellerPayoutTransferEmail(sellerUser.email, sellerUser.name || 'Seller', {
          orderId:        order.id,
          orderDisplayId: order.displayId || order.id,
          amount:         itemTotal,
          currency:       'AUD',
        }).catch((e) => console.error('sendSellerPayoutTransferEmail error:', e.message));
      }
    } else {
      // Platform charge (multi-seller) — manually transfer seller's net payout
      (async () => {
        try {
          const sellerProfile = await prisma.sellerProfile.findUnique({
            where:  { userId: sid },
            select: { stripeAccountId: true, stripePayoutsEnabled: true, user: { select: { email: true, name: true } } },
          });

          if (!sellerProfile?.stripeAccountId || !sellerProfile?.stripePayoutsEnabled) {
            console.log(`⏳ Seller ${sid} has no active Stripe account — transfer skipped, manual payout required`);
            return;
          }

          const sellerCommission   = await getCommissionForSeller(sid);
          const resolvedCommission = sellerCommission || (await getDefaultCommission());
          const commissionRatePct  = resolvedCommission ? parseFloat(resolvedCommission.value) : 10;
          const payout = calculateSellerPayout(itemTotal, perSellerShipping, commissionRatePct);

          if (payout.sellerTotalPayoutCents <= 0) {
            console.warn(`⚠️  Seller ${sid} payout would be ≤ $0 — transfer skipped`);
            return;
          }

          const payoutTransactionDescription = buildSellerTransactionDescription({
            order: sellerSubOrder || order,
            customerName: toName,
            customerEmail: order.customerEmail,
            items: sellerItems,
            amount: payout.sellerTotalPayout,
            label: "Seller payout",
            platformFee: payout.commissionAmount,
            gstAmount: payout.gstAmount,
            shippingAmount: payout.shippingAmount,
          });

          const transfer = await stripe.transfers.create({
            amount:      payout.sellerTotalPayoutCents,
            currency:    "aud",
            destination: sellerProfile.stripeAccountId,
            ...(latestChargeId && { source_transaction: latestChargeId }),
            description: payoutTransactionDescription,
            metadata: {
              ...sellerStripeMetadata,
              sellerId:           sid,
              commissionAmount:   payout.commissionAmount.toString(),
              commissionRate:     payout.commissionRatePct.toString(),
              gstAmount:          payout.gstAmount.toString(),
              shippingAmount:     payout.shippingAmount.toString(),
              sellerTotalPayout:  payout.sellerTotalPayout.toString(),
              productValueExGST:  payout.productValueExGST.toString(),
            },
          });

          console.log(`💸 Transfer created — seller: ${sid}, amount: $${payout.sellerTotalPayout}, transferId: ${transfer.id}`);

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
          if (sellerEmail) {
            sendSellerPayoutTransferEmail(sellerEmail, sellerName, {
              orderId:        order.id,
              orderDisplayId: order.displayId || order.id,
              amount:         payout.sellerTotalPayout,
              currency:       'AUD',
            }).catch((e) => console.error('sendSellerPayoutTransferEmail error:', e.message));
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
    const displayId = await generateDisplayId();
    const guestDestinationPaymentDescription = buildSellerTransactionDescription({
      order: { id: displayId, displayId },
      customerName,
      customerEmail,
      items: cartItems,
      amount: totalAmount,
      label: "Seller payment",
    });

    let guestDirectChargeParams = {};
    let guestPaymentIntentStripeAccountId = null;
    if (!guestIsMultiSeller && USE_DIRECT_CHARGES_FOR_SINGLE_SELLER) {
      const [singleSellerId] = guestSellerMap.keys();
      const sellerProfile = await prisma.sellerProfile.findUnique({
        where:  { userId: singleSellerId },
        select: { stripeAccountId: true, stripeChargesEnabled: true },
      });
      if (sellerProfile?.stripeAccountId && sellerProfile?.stripeChargesEnabled) {
        const sellerCommission   = await getCommissionForSeller(singleSellerId);
        const resolvedCommission = sellerCommission || (await getDefaultCommission());
        const commissionRatePct  = resolvedCommission ? parseFloat(resolvedCommission.value) : 10;
        const itemTotal = cartItems.reduce((s, i) => s + (i.productVariant ? Number(i.productVariant.price) : Number(i.product.price)) * i.quantity, 0);
        const perSellerShipping  = parseFloat(cartCalculations.shippingCost);
        const payout = calculateSellerPayout(itemTotal, perSellerShipping, commissionRatePct);
        // Check if seller has card_payments capability before using on_behalf_of.
        // The PaymentIntent itself must remain on the platform account.
        let guestCardPaymentsActive = false;
        try {
          const acct = await stripe.accounts.retrieve(sellerProfile.stripeAccountId);
          guestCardPaymentsActive = acct.capabilities?.card_payments === 'active';
        } catch (e) {
          console.warn(`⚠️  Could not retrieve seller Stripe capabilities: ${e.message}`);
        }
        guestDirectChargeParams = {
          ...(guestCardPaymentsActive && { on_behalf_of: sellerProfile.stripeAccountId }),
          application_fee_amount: payout.commissionAmountCents,
          transfer_data: {
            destination: sellerProfile.stripeAccountId,
          },
        };
      }
    }

    // Create Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "aud",
      description: guestDestinationPaymentDescription,
      metadata: {
        isGuest: "true",
        customerEmail,
        chargeType: Object.keys(guestDirectChargeParams).length ? 'direct' : 'platform',
      },
      automatic_payment_methods: { enabled: true },
      ...guestDirectChargeParams,
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
      order = await prisma.order.create({
        data: {
          ...guestOrderBaseData,
          sellerId: singleSellerId,
          items: { create: orderItems },
        },
      });
    }

    console.log(`✅ Guest Stripe PaymentIntent created: ${paymentIntent.id}, order: ${order.id}`);

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
        description: guestStripeOrderDescription,
      });
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
    console.error("❌ createGuestPaymentIntent error:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to create guest payment intent",
      error: error.message,
    });
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
    if (order.paymentStatus === "PAID") {
      return reply.status(200).send({
        success: true,
        message: "Payment already confirmed",
        orderId: order.id,
        displayId: order.displayId,
      });
    }

    // Deduct stock, clear cart, mark PAID, send confirmation email, notify admins.
    // handlePaymentSucceeded is the single source of truth — works for webhook,
    // logged-in confirm, and guest confirm paths without duplication.
    await handlePaymentSucceeded(paymentIntentId);

    console.log(`✅ Guest Stripe payment confirmed for order: ${order.id}`);

    return reply.status(200).send({
      success: true,
      message: "Guest payment confirmed and order placed successfully",
      orderId: order.id,
      displayId: order.displayId,
      status: "CONFIRMED",
      paymentStatus: "PAID",
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
