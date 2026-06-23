const prisma = require("../config/prisma");
const crypto = require("crypto");
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const os = require('os');
const { checkInventory } = require("../utils/checkInventory");
const { uploadToCloudinary } = require('../config/cloudinary');

// ─── Short Display ID Generator ───────────────────────────────────────────────
const DISPLAY_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

async function generateDisplayId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = crypto.randomBytes(6);
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += DISPLAY_ID_CHARS[bytes[i] % DISPLAY_ID_CHARS.length];
    }
    const existing = await prisma.order.findUnique({ where: { displayId: id } });
    if (!existing) return id;
  }
  throw new Error('Failed to generate a unique display ID after 10 attempts');
}
// ─────────────────────────────────────────────────────────────────────────────
const { 
  sendOrderConfirmationEmail, 
  sendOrderStatusEmail,
  sendSellerOrderNotificationEmail,
  sendAdminNewOrderEmail,
  sendSellerLowStockEmail,
  sendSellerOrderStatusEmail,
  sendFinanceOrderInvoiceEmail,
  sendAdminOrderStatusEmail,
  sendRefundRequestConfirmationEmail
} = require("../utils/emailService");
const {
  notifyCustomerOrderStatusChange,
  notifySellerNewOrder,
  notifyAdminNewOrder,
  notifySellerLowStock,
  notifyAdminOrderStatusChange,
  notifySellerOrderStatusChange
} = require("./notification");
const { createOrderNotification } = require("./orderNotification");
const { calculateCartTotals } = require("./cart");
const { normalizeOrderStatus, validateStatusTransition } = require("../utils/orderStatusRules");
const { createCommissionEarned } = require("./commission");
const { lookupZone } = require("../utils/internationalShipping");
const PDFDocument = require('pdfkit');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ─── Stripe Cancel / Refund Helper ───────────────────────────────────────────
// Called after an order is marked CANCELLED in the DB.
// - If the PaymentIntent was never captured → cancels it (no charge to customer)
// - If payment was already captured → issues a full refund with the cancellation reason as description
async function triggerStripeRefund(paymentIntentId, reason, displayId) {
  if (!paymentIntentId) return;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const desc = `Order ${displayId} cancelled — ${reason}`.slice(0, 255);

    if (pi.status === 'succeeded') {
      await stripe.refunds.create({
        payment_intent: paymentIntentId,
        reason: 'requested_by_customer',
        metadata: { displayId, cancellationReason: reason.slice(0, 500) }
      });
      console.log(`↩️  Stripe refund issued for order #${displayId}`);
    } else if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(pi.status)) {
      await stripe.paymentIntents.cancel(paymentIntentId);
      console.log(`❌ Stripe PaymentIntent cancelled for order #${displayId} (not yet captured)`);
    } else {
      console.log(`ℹ️  Stripe PI ${paymentIntentId} status "${pi.status}" — no action needed`);
    }
  } catch (err) {
    console.error(`⚠️  Stripe refund/cancel error for order #${displayId}:`, err.message);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Low Stock Alert Helper ───────────────────────────────────────────────────
// Checks each ordered product's stock after decrement.
// If stock <= 2: deactivates the product and fires notification + email (non-blocking).
const LOW_STOCK_THRESHOLD = 2;

const handleLowStockAlerts = async (productIds) => {
  try {
    for (const productId of productIds) {
      // Fetch product with type info
      const rows = await prisma.$queryRaw`
        SELECT p.id, p.title, p.stock, p.type, p."sellerId",
               u.email AS "sellerEmail", u.name AS "sellerName"
        FROM "products" p
        JOIN "users" u ON u.id = p."sellerId"
        WHERE p.id = ${productId}
          AND p."isActive" = true
      `;

      if (!rows || rows.length === 0) continue;
      const product = rows[0];

      let effectiveStock;

      if (product.type === 'VARIABLE') {
        // For VARIABLE products, check total stock across all active variants
        const variantStockRows = await prisma.$queryRaw`
          SELECT COALESCE(SUM(stock), 0)::int AS total_stock
          FROM "product_variants"
          WHERE "productId" = ${productId} AND "isActive" = true
        `;
        effectiveStock = variantStockRows[0]?.total_stock ?? 0;
      } else {
        effectiveStock = Number(product.stock ?? 0);
      }

      if (effectiveStock > LOW_STOCK_THRESHOLD) continue; // Enough stock — skip

      // Deactivate
      await prisma.$executeRaw`
        UPDATE "products"
        SET "isActive" = false, status = 'INACTIVE'
        WHERE id = ${product.id}
      `;
      console.log(`⚠️  Product "${product.title}" deactivated — effective stock: ${effectiveStock}`);

      // In-app notification (non-blocking)
      notifySellerLowStock(
        product.sellerId,
        product.id,
        product.title,
        effectiveStock
      ).catch(err => console.error("Low stock notification error:", err.message));

      // Email alert (non-blocking)
      if (product.sellerEmail) {
        sendSellerLowStockEmail(
          product.sellerEmail,
          product.sellerName || "Seller",
          product.title,
          effectiveStock,
          product.id
        ).then(result => {
          if (!result.success) console.warn(`⚠️  [Low Stock] Email not sent to ${product.sellerEmail}: ${result.error}`);
          else console.log(`✅ [Low Stock] Email sent to ${product.sellerEmail} for "${product.title}"`);
        }).catch(err => console.error("Low stock email error:", err.message));
      } else {
        console.warn(`⚠️  [Low Stock] No email address for seller ${product.sellerId} — email skipped`);
      }
    }
  } catch (err) {
    console.error("handleLowStockAlerts error (non-fatal):", err.message);
  }
};

// Export so the admin controller can reuse the same logic
module.exports.handleLowStockAlerts = handleLowStockAlerts;
// ─────────────────────────────────────────────────────────────────────────────

// ── Seller-coupon discount helper ─────────────────────────────────────────────
// Calculates the GST-inclusive discount amount for a SellerCoupon applied to a
// list of cart items.  Works for both createOrder (items from DB cart with
// product + productVariant) and createGuestOrder (items with product only).
function _calcSellerCouponDiscount(coupon, cartItems, gstRate) {
  const rate = parseFloat(gstRate) || 0;

  // Group qualifying items by productId
  const groups = {};
  for (const item of cartItems) {
    const pid = item.product?.id || item.productId;
    const sid = item.product?.sellerId;
    const qty = item.quantity || 0;
    const belongsToSeller = sid === coupon.sellerId;
    const inList = coupon.productIds.length === 0 || coupon.productIds.includes(pid);
    if (!belongsToSeller || !inList || qty <= 0) continue;

    const unitPriceIncl = item.productVariant
      ? Number(item.productVariant.price)
      : Number(item.product?.price || 0);

    if (!groups[pid]) groups[pid] = { totalQty: 0, totalInclSubtotal: 0 };
    groups[pid].totalQty          += qty;
    groups[pid].totalInclSubtotal += unitPriceIncl * qty;
  }

  let totalRegularExGST    = 0;
  let totalDiscountedExGST = 0;

  for (const g of Object.values(groups)) {
    // Convert inclusive price to ex-GST
    const regularExGST = rate > 0
      ? (g.totalInclSubtotal * 100) / (100 + rate)
      : g.totalInclSubtotal;
    totalRegularExGST += regularExGST;

    // minQty gate — no discount if group doesn't meet minimum
    if (g.totalQty < coupon.minQty) {
      totalDiscountedExGST += regularExGST;
      continue;
    }

    let discountedExGST;
    if (coupon.couponType === 'bundle') {
      const bundles    = Math.floor(g.totalQty / coupon.bundleQty);
      const remaining  = g.totalQty % coupon.bundleQty;
      const avgPerItem = regularExGST / g.totalQty;
      discountedExGST  = bundles * Number(coupon.bundlePrice) + remaining * avgPerItem;
    } else {
      let disc = 0;
      if (coupon.discountType === 'percentage') {
        disc = (regularExGST * Number(coupon.discountValue)) / 100;
        if (coupon.maxDiscount) disc = Math.min(disc, Number(coupon.maxDiscount));
      } else {
        disc = Math.min(Number(coupon.discountValue), regularExGST);
      }
      discountedExGST = regularExGST - disc;
    }
    totalDiscountedExGST += discountedExGST;
  }

  if (totalRegularExGST === 0) return 0;

  // Convert both sides back to GST-inclusive, return the savings
  const regularIncl    = totalRegularExGST    * (1 + rate / 100);
  const discountedIncl = totalDiscountedExGST * (1 + rate / 100);
  return parseFloat((regularIncl - discountedIncl).toFixed(2));
}

// Shared helper: normalize variant attributes for order/cart/refund responses.
function formatVariantAttributes(productVariant) {
  if (!productVariant?.variantAttributeValues?.length) return null;

  return productVariant.variantAttributeValues
    .map(vav => ({
      name: vav.attributeValue?.attribute?.name,
      displayName: vav.attributeValue?.attribute?.displayName,
      value: vav.attributeValue?.value,
      displayValue: vav.attributeValue?.displayValue,
      hexColor: vav.attributeValue?.hexColor
    }))
    .filter(attr => attr.name && attr.value);
}
// ─────────────────────────────────────────────────────────────────────────────

// Stock Management and Inventory Alert with SMS Notification
exports.createOrder = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { 
      shippingAddress, 
      paymentMethod, 
      shippingMethodId,     // Required for Australia (domestic) shipping
      internationalCountry, // Required for international shipping (mutually exclusive with shippingMethodId)
      gstId,
      country,
      city,
      zipCode,
      state,
      mobileNumber,
      couponCode
    } = request.body;

    // Treat the order as international when either internationalCountry or the top-level
    // country field is non-Australia. This covers frontends that store the destination
    // country in the address object (as 'country') rather than a separate param.
    const effectiveIntlCountry = (internationalCountry || country || '').trim();
    const isInternational = !!effectiveIntlCountry && effectiveIntlCountry.toLowerCase() !== 'australia';

    if (!shippingAddress || !paymentMethod || (!shippingMethodId && !isInternational)) {
      return reply.status(400).send({ success: false, message: "All fields including shipping method (or international country) are required" });
    }

    // Validate international country
    let intlZoneEntry = null;
    let shippingMethod = null;

    if (isInternational) {
      const intlCountry = effectiveIntlCountry;
      intlZoneEntry = lookupZone(intlCountry);
      shippingMethod = {
        id: null,
        name: `International (${intlCountry})`,
        cost: intlZoneEntry.cost,
        estimatedDays: '10-20 business days',
        zone: intlZoneEntry.zone,
        zoneName: intlZoneEntry.label,
        country: intlCountry
      };
    }

    // Only Stripe is accepted — COD is not supported
    const ALLOWED_PAYMENT_METHODS = ['STRIPE'];
    if (!ALLOWED_PAYMENT_METHODS.includes(paymentMethod.toUpperCase())) {
      return reply.status(400).send({
        success: false,
        message: `Payment method '${paymentMethod}' is not supported. Accepted methods: Stripe`
      });
    }

    // Get user details for SMS
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return reply.status(404).send({ success: false, message: "User not found" });
    }

    // Get user's cart with items, products, and variant details
    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: true,
            productVariant: {
              include: {
                variantAttributeValues: {
                  include: { attributeValue: { include: { attribute: true } } }
                }
              }
            }
          }
        }
      }
    });

    if (!cart || cart.items.length === 0) {
      return reply.status(400).send({ success: false, message: "Cart is empty" });
    }

    // Calculate proper cart totals including shipping and GST
    const cartCalculations = await calculateCartTotals(
      cart.items,
      isInternational ? null : shippingMethodId,
      gstId,
      isInternational ? intlZoneEntry.cost : null
    );

    // Get domestic shipping method details (international already resolved above)
    if (!isInternational) {
      const domesticMethod = await prisma.shippingMethod.findUnique({
        where: { id: shippingMethodId, isActive: true }
      });
      if (!domesticMethod) {
        return reply.status(400).send({ success: false, message: "Invalid or inactive shipping method" });
      }
      shippingMethod = domesticMethod;
    }

    // Use grand total from cart calculations
    const originalTotal = parseFloat(cartCalculations.grandTotal);

    // ── Coupon validation (server-side) ──────────────────────────────────────
    let appliedCoupon = null;
    let couponModel   = null; // 'seller' | 'legacy'
    let discountAmount = 0;

    if (couponCode) {
      const upper   = couponCode.toUpperCase();
      const gstRate = parseFloat(cartCalculations.gstPercentage) || 0;

      // Try seller coupon first
      const sellerCoupon = await prisma.sellerCoupon.findUnique({ where: { code: upper } });

      if (sellerCoupon && !sellerCoupon.softDeletedAt) {
        if (!sellerCoupon.isActive) {
          return reply.status(400).send({ success: false, message: 'This coupon is no longer active' });
        }
        if (new Date() > sellerCoupon.expiresAt) {
          return reply.status(400).send({ success: false, message: 'Coupon has expired' });
        }
        if (sellerCoupon.usageLimit !== null && sellerCoupon.usageCount >= sellerCoupon.usageLimit) {
          return reply.status(400).send({ success: false, message: 'Coupon usage limit has been reached' });
        }
        discountAmount = _calcSellerCouponDiscount(sellerCoupon, cart.items, gstRate);
        appliedCoupon  = sellerCoupon;
        couponModel    = 'seller';
      } else {
        // Fall back to legacy (admin) coupon
        const legacyCoupon = await prisma.coupon.findUnique({ where: { code: upper } });

        if (!legacyCoupon) {
          return reply.status(400).send({ success: false, message: 'Invalid coupon code' });
        }
        if (!legacyCoupon.isActive) {
          return reply.status(400).send({ success: false, message: 'This coupon is no longer active' });
        }
        if (new Date() > legacyCoupon.expiresAt) {
          return reply.status(400).send({ success: false, message: 'Coupon has expired' });
        }
        if (legacyCoupon.usageLimit !== null && legacyCoupon.usageCount >= legacyCoupon.usageLimit) {
          return reply.status(400).send({ success: false, message: 'Coupon usage limit has been reached' });
        }
        if (legacyCoupon.minCartValue !== null && originalTotal < legacyCoupon.minCartValue) {
          return reply.status(400).send({
            success: false,
            message: `Minimum cart value of $${legacyCoupon.minCartValue.toFixed(2)} required for this coupon`
          });
        }

        if (legacyCoupon.discountType === 'percentage') {
          discountAmount = parseFloat(((originalTotal * legacyCoupon.discountValue) / 100).toFixed(2));
          if (legacyCoupon.maxDiscount !== null) {
            discountAmount = Math.min(discountAmount, legacyCoupon.maxDiscount);
          }
        } else {
          discountAmount = Math.min(legacyCoupon.discountValue, originalTotal);
        }

        appliedCoupon = legacyCoupon;
        couponModel   = 'legacy';
      }
    }

    const totalAmount = parseFloat((originalTotal - discountAmount).toFixed(2));
    // ─────────────────────────────────────────────────────────────────────────

    let sellerNotifications = new Map();
    const orderItems = [];

    // Stock validation + prepare order items
    for (const item of cart.items) {
      const product = item.product;
      const variant = item.productVariant;

      // Check stock — from variant for VARIABLE products, from product for SIMPLE
      if (variant) {
        if (variant.stock < item.quantity) {
          return reply.status(400).send({
            success: false,
            message: `Insufficient stock for product: ${product.title} (variant: ${item.variantId})`
          });
        }
      } else {
        if (product.stock < item.quantity) {
          return reply.status(400).send({
            success: false,
            message: `Insufficient stock for product: ${product.title}`
          });
        }
      }

      // Use variant price for VARIABLE, product price for SIMPLE
      const itemPrice = variant ? Number(variant.price) : Number(product.price);
      const itemTotal = itemPrice * item.quantity;

      orderItems.push({
        productId: product.id,
        variantId: item.variantId || null,
        quantity: item.quantity,
        price: itemPrice
      });

      // Track seller products for notification
      if (!sellerNotifications.has(product.sellerId)) {
        sellerNotifications.set(product.sellerId, {
          productCount: 0,
          totalAmount: 0,
          products: [],
          sellerName: product.sellerName || null  // stored at product creation time
        });
      }
      const sellerData = sellerNotifications.get(product.sellerId);
      // Keep the most recent non-null sellerName we see
      if (product.sellerName && !sellerData.sellerName) sellerData.sellerName = product.sellerName;
      sellerData.productCount += item.quantity;
      sellerData.totalAmount += itemTotal;
      // Build variant-aware title for seller notifications
      const variantAttrs = item.productVariant?.variantAttributeValues
        ?.map(av => `${av.attributeValue?.attribute?.name}: ${av.attributeValue?.value}`)
        .filter(Boolean)
        .join(', ');
      const displayTitle = variantAttrs ? `${product.title} (${variantAttrs})` : product.title;
      sellerData.products.push({
        productId: product.id,
        title: displayTitle,
        quantity: item.quantity,
        price: itemPrice
      });
    }

    // Generate short alphanumeric display ID for the customer
    const displayId = await generateDisplayId();

    // Use transaction to ensure atomicity
    const order = await prisma.$transaction(async (tx) => {
      // Deduct stock — re-validate inside the transaction to prevent race conditions
      for (const item of cart.items) {
        if (item.variantId) {
          // VARIABLE product: deduct from variant stock
          const result = await tx.$executeRaw`
            UPDATE "product_variants"
            SET stock = stock - ${item.quantity}
            WHERE id = ${item.variantId} AND stock >= ${item.quantity}
          `;
          if (result === 0) {
            const variant = await tx.productVariant.findUnique({
              where: { id: item.variantId },
              select: { stock: true }
            });
            throw new Error(
              `Insufficient stock for variant "${item.variantId}". Available: ${variant?.stock ?? 0}, Requested: ${item.quantity}`
            );
          }
        } else {
          // SIMPLE product: deduct from product stock
          const result = await tx.$executeRaw`
            UPDATE "products"
            SET stock = stock - ${item.quantity}
            WHERE id = ${item.productId} AND stock >= ${item.quantity}
          `;
          if (result === 0) {
            const current = await tx.product.findUnique({
              where: { id: item.productId },
              select: { title: true, stock: true }
            });
            throw new Error(
              `Insufficient stock for "${current?.title ?? item.productId}". Available: ${current?.stock ?? 0}, Requested: ${item.quantity}`
            );
          }
        }
      }

      // Increment coupon usageCount inside the transaction (atomic)
      if (appliedCoupon) {
        if (couponModel === 'seller') {
          await tx.sellerCoupon.update({
            where: { id: appliedCoupon.id },
            data: { usageCount: { increment: 1 } }
          });
        } else {
          await tx.coupon.update({
            where: { id: appliedCoupon.id },
            data: { usageCount: { increment: 1 } }
          });
        }
      }

      // Check if this is a single seller or multi-seller order
      const isMultiSeller = sellerNotifications.size > 1;
      
      if (isMultiSeller) {
        // MULTI-SELLER ORDER: Create parent order + sub-orders
        const parentOrder = await tx.order.create({
          data: {
            displayId,
            userId,
            totalAmount,
            originalTotal,
            couponCode: appliedCoupon ? appliedCoupon.code : null,
            discountAmount: discountAmount > 0 ? discountAmount : null,
            shippingAddress: typeof shippingAddress === 'string' ? { address: shippingAddress } : {
              ...shippingAddress,
              // Include order breakdown for invoice purposes
              orderSummary: {
                subtotal: cartCalculations.subtotal,
                shippingCost: cartCalculations.shippingCost,
                totalShippingCost: cartCalculations.totalShippingCost,
                sellerCount: cartCalculations.sellerCount,
                gstPercentage: cartCalculations.gstPercentage,
                gstAmount: cartCalculations.gstAmount,
                grandTotal: cartCalculations.grandTotal,
                couponCode: appliedCoupon ? appliedCoupon.code : null,
                discountAmount,
                finalTotal: totalAmount,
                shippingMethod: {
                  id: shippingMethod.id,
                  name: shippingMethod.name,
                  cost: shippingMethod.cost,
                  estimatedDays: shippingMethod.estimatedDays
                },
                gstDetails: cartCalculations.gstDetails
              }
            },
            shippingAddressLine: typeof shippingAddress === 'string' ? shippingAddress : shippingAddress?.addressLine,
            shippingCity: city,
            shippingState: state,
            shippingZipCode: zipCode,
            shippingCountry: country,
            shippingPhone: mobileNumber,
            paymentMethod,
            overallStatus: "CONFIRMED",
            customerName: user.isDeleted ? 'Deleted User' : user.name,
            customerEmail: user.email,
            customerPhone: mobileNumber || user.phone || ''
          }
        });

        // Per-seller shipping cost (full rate applied to each seller)
        const perSellerShipping = parseFloat(cartCalculations.shippingCost);

        // Create sub-orders for each seller with their specific products
        const createdSubOrders = [];
        let subOrderIndex = 0;
        for (const [sellerId, sellerData] of sellerNotifications) {
          // Derive a customer-facing sub-display ID: parentDisplayId + alphabetic suffix (A, B, C...)
          const subSuffix = String.fromCharCode(65 + subOrderIndex); // 0→A, 1→B, …
          const subDisplayId = `${displayId}-${subSuffix}`;
          subOrderIndex++;

          // Each seller's subtotal = their product total + their own shipping cost
          const subOrderSubtotal = sellerData.totalAmount + perSellerShipping;

          // Create sub-order for this seller
          const subOrder = await tx.subOrder.create({
            data: {
              subDisplayId,
              parentOrderId: parentOrder.id,
              sellerId: sellerId,
              subtotal: subOrderSubtotal,
              status: "CONFIRMED"
            }
          });

          // Create order items for this sub-order
          const sellerItemsToCreate = cart.items
            .filter(item => item.product.sellerId === sellerId)
            .map(item => ({
              subOrderId: subOrder.id,
              productId: item.productId,
              variantId: item.variantId || null,
              quantity: item.quantity,
              price: item.productVariant ? Number(item.productVariant.price) : Number(item.product.price)
            }));

          await tx.orderItem.createMany({
            data: sellerItemsToCreate
          });

          createdSubOrders.push({
            ...subOrder,
            items: sellerItemsToCreate,
            sellerId: sellerId
          });
        }

        // Clear cart
        await tx.cartItem.deleteMany({
          where: { cartId: cart.id }
        });

        return {
          parentOrder,
          subOrders: createdSubOrders,
          isMultiSeller: true
        };
      } else {
        // SINGLE SELLER ORDER: Create simple order (no sub-orders needed)
        const [sellerId] = sellerNotifications.keys();
        const singleOrder = await tx.order.create({
          data: {
            displayId,
            userId,
            sellerId, // Link directly to seller
            totalAmount,
            originalTotal,
            couponCode: appliedCoupon ? appliedCoupon.code : null,
            discountAmount: discountAmount > 0 ? discountAmount : null,
            shippingAddress: typeof shippingAddress === 'string' ? { address: shippingAddress } : {
              ...shippingAddress,
              // Include order breakdown for invoice purposes
              orderSummary: {
                subtotal: cartCalculations.subtotal,
                shippingCost: cartCalculations.shippingCost,
                totalShippingCost: cartCalculations.totalShippingCost,
                sellerCount: cartCalculations.sellerCount,
                gstPercentage: cartCalculations.gstPercentage,
                gstAmount: cartCalculations.gstAmount,
                grandTotal: cartCalculations.grandTotal,
                couponCode: appliedCoupon ? appliedCoupon.code : null,
                discountAmount,
                finalTotal: totalAmount,
                shippingMethod: {
                  id: shippingMethod.id,
                  name: shippingMethod.name,
                  cost: shippingMethod.cost,
                  estimatedDays: shippingMethod.estimatedDays
                },
                gstDetails: cartCalculations.gstDetails
              }
            },
            shippingAddressLine: typeof shippingAddress === 'string' ? shippingAddress : shippingAddress?.addressLine,
            shippingCity: city,
            shippingState: state,
            shippingZipCode: zipCode,
            shippingCountry: country,
            shippingPhone: mobileNumber,
            paymentMethod,
            overallStatus: "CONFIRMED",
            status: "CONFIRMED", // Set individual status for single order
            customerName: user.isDeleted ? 'Deleted User' : user.name,
            customerEmail: user.email,
            customerPhone: mobileNumber || user.phone || ''
          }
        });

        // Create order items directly on the main order
        await tx.orderItem.createMany({
          data: orderItems.map(item => ({
            orderId: singleOrder.id,
            productId: item.productId,
            variantId: item.variantId || null,
            quantity: item.quantity,
            price: item.price
          }))
        });

        // Clear cart
        await tx.cartItem.deleteMany({
          where: { cartId: cart.id }
        });

        return {
          singleOrder,
          subOrders: [], // Empty for single seller
          isMultiSeller: false
        };
      }
    });

    const mainOrder = order.isMultiSeller ? order.parentOrder : order.singleOrder;
    const orderId = mainOrder.id;
    
    if (order.isMultiSeller) {
      console.log(`✅ Multi-seller Order created: Parent ${orderId} with ${order.subOrders.length} sub-orders`);
    } else {
      console.log(`✅ Single-seller Order created: ${orderId} (direct order, no sub-orders)`);
    }
    
    // Stock broadcasts are handled automatically by the Prisma middleware
    // in config/prisma.js — no manual broadcast needed here.

    // Check for low stock on all ordered products and deactivate + alert if <= 2
    handleLowStockAlerts(cart.items.map(i => i.productId));

    // ── Commission Earned — record 10 % platform fee per seller (non-blocking) ─
    for (const [sellerId, sellerData] of sellerNotifications) {
      let commissionOrderId;
      
      if (order.isMultiSeller) {
        // Use sub-order ID for commission tracking
        const sellerSubOrder = order.subOrders.find(sub => sub.sellerId === sellerId);
        commissionOrderId = sellerSubOrder?.id;
      } else {
        // Use main order ID for single seller
        commissionOrderId = orderId;
      }
      
      createCommissionEarned({
        orderId: commissionOrderId,
        sellerId,
        orderValue: sellerData.totalAmount,
        customerName: user.isDeleted ? 'Deleted User' : user.name,
        customerEmail: user.email,
        customerId: userId || null,
        sellerName: sellerData.sellerName || null
      }).catch(err => console.error(`Commission earned error (seller ${sellerId}):`, err.message));
    }
    // ──────────────────────────────────────────────────────────────────────────

    // Get seller names (DB lookup for accurate name) + product titles
    const sellerIdList = [...sellerNotifications.keys()];
    const sellerNameMap = new Map();
    await Promise.all(sellerIdList.map(async sid => {
      const s = await prisma.user.findUnique({
        where: { id: sid },
        select: { name: true, sellerProfile: { select: { storeName: true, businessName: true } } }
      });
      sellerNameMap.set(sid, s?.name || s?.sellerProfile?.storeName || s?.sellerProfile?.businessName || 'Unknown');
    }));
    const sellerNameList = [...sellerNameMap.values()];
    const allProductTitles = [];
    for (const [, sellerData] of sellerNotifications) {
      if (sellerData.products) {
        allProductTitles.push(...sellerData.products.map(p => p.title).filter(Boolean));
      }
    }

    // Create notifications for the main order (parent or single)
    const orderNotificationData = {
      customerName: user.isDeleted ? 'Deleted User' : user.name,
      sellerName: sellerNameList.length > 0 ? sellerNameList.join(', ') : 'Unknown',
      totalAmount: totalAmount.toFixed(2),
      itemCount: cart.items.length,
      productNames: allProductTitles,
      orderId: orderId // Use the main order ID
    };

    // Notify admins about new order
    notifyAdminNewOrder(orderId, orderNotificationData).catch(error => {
      console.error("Admin notification error (non-blocking):", error.message);
    });

    // Notify each seller about the new order (fired before reply — guaranteed delivery)
    for (const [sellerId, sellerData] of sellerNotifications) {
      // For multi-seller, use sub-order ID; for single seller, use main order ID
      const sellerOrderId = order.isMultiSeller 
        ? order.subOrders.find(sub => sub.sellerId === sellerId)?.id || orderId
        : orderId;
        
      notifySellerNewOrder(sellerId, sellerOrderId, {
        customerName: user.isDeleted ? 'Deleted User' : user.name,
        totalAmount: sellerData.totalAmount.toFixed(2),
        itemCount: sellerData.productCount,
        productNames: sellerData.products.map(p => p.title).filter(Boolean)
      }).catch(error => {
        console.error(`Seller order notification error (sellerId=${sellerId}):`, error.message);
      });
    }

    // Notify customer about their placed order (fired before reply — guaranteed delivery)
    notifyCustomerOrderStatusChange(userId, orderId, 'confirmed', {
      totalAmount: totalAmount.toFixed(2),
      itemCount: cart.items.length,
      productNames: allProductTitles
    }).catch(error => {
      console.error('Customer order placed notification error:', error.message);
    });

    // ── Helper: build a display title including variant attributes ───────────
    const getItemDisplayTitle = (item) => {
      const base = item.product.title;
      if (!item.productVariant) return base;
      const attrs = item.productVariant.variantAttributeValues
        ?.map(av => `${av.attributeValue?.attribute?.name}: ${av.attributeValue?.value}`)
        .filter(Boolean)
        .join(', ');
      return attrs ? `${base} (${attrs})` : base;
    };
    const getItemPrice = (item) => item.productVariant ? Number(item.productVariant.price) : Number(item.product.price);
    // ─────────────────────────────────────────────────────────────────────────

    // ── Fire all emails & notifications in background (non-blocking) ────────
    // Reply is sent immediately below; PDF generation + all outbound calls
    // run in the background so they never delay the API response.
    ;(async () => {
      try {
        // 1. Customer confirmation email (invoice download link is in the email)
        if (user.email) {
          console.log(`📧 Sending order confirmation email to customer: ${user.email}`);
          try {
            const emailResult = await sendOrderConfirmationEmail(user.email, user.name, {
              displayId: mainOrder.displayId,
              totalAmount,
              itemCount: cart.items.length,
              products: cart.items.map(item => ({
                title: getItemDisplayTitle(item),
                quantity: item.quantity,
                price: getItemPrice(item)
              })),
              shippingAddress,
              paymentMethod,
              customerPhone: mobileNumber || user.phone || '',
              orderSummary: {
                subtotal: cartCalculations.subtotal,
                subtotalExGST: cartCalculations.subtotalExGST,
                shippingCost: cartCalculations.totalShippingCost,
                gstPercentage: cartCalculations.gstPercentage,
                gstAmount: cartCalculations.gstAmount,
                grandTotal: cartCalculations.grandTotal,
                gstInclusive: true,
                couponCode: appliedCoupon ? appliedCoupon.code : null,
                discountAmount: discountAmount > 0 ? discountAmount : null,
                shippingMethod: {
                  name: shippingMethod.name,
                  cost: shippingMethod.cost,
                  estimatedDays: shippingMethod.estimatedDays
                }
              }
            });
            if (emailResult?.success) {
              console.log(`✅ Order confirmation email sent to ${user.email}`);
            } else {
              console.error(`❌ Order confirmation email failed for ${user.email}:`, emailResult?.error);
            }
          } catch (emailErr) {
            console.error(`❌ Order confirmation email error for ${user.email}:`, emailErr.message);
          }
        }

        // 1.5. Send order confirmation to super admins as well
        try {
          const superAdmins = await prisma.user.findMany({
            where: { role: 'SUPER_ADMIN' },
            select: { email: true, name: true }
          });
          for (const admin of superAdmins) {
            if (admin.email) {
              try {
                const adminConfirmResult = await sendOrderConfirmationEmail(admin.email, admin.name || 'Super Admin', {
                  displayId: mainOrder.displayId,
                  totalAmount,
                  itemCount: cart.items.length,
                  products: cart.items.map(item => ({
                    title: getItemDisplayTitle(item),
                    quantity: item.quantity,
                    price: getItemPrice(item)
                  })),
                  shippingAddress,
                  paymentMethod,
                  customerPhone: mobileNumber || user.phone || '',
                  customerName: user.name,
                  customerEmail: user.email,
                  isSuperAdminCopy: true,
                  orderSummary: {
                    subtotal: cartCalculations.subtotal,
                    subtotalExGST: cartCalculations.subtotalExGST,
                    shippingCost: cartCalculations.totalShippingCost,
                    gstPercentage: cartCalculations.gstPercentage,
                    gstAmount: cartCalculations.gstAmount,
                    grandTotal: cartCalculations.grandTotal,
                    gstInclusive: true,
                    couponCode: appliedCoupon ? appliedCoupon.code : null,
                    discountAmount: discountAmount > 0 ? discountAmount : null,
                    shippingMethod: {
                      name: shippingMethod.name,
                      cost: shippingMethod.cost,
                      estimatedDays: shippingMethod.estimatedDays
                    }
                  }
                });
                if (adminConfirmResult?.success) {
                  console.log(`✅ Super admin order confirmation sent to ${admin.email}`);
                } else {
                  console.error(`❌ Super admin order confirmation failed for ${admin.email}:`, adminConfirmResult?.error);
                }
              } catch (adminEmailErr) {
                console.error(`❌ Super admin order confirmation error for ${admin.email}:`, adminEmailErr.message);
              }
            }
          }
        } catch (adminListErr) {
          console.error('Error fetching super admins for order confirmation:', adminListErr.message);
        }

        // 2. Seller emails + SLA notifications — all DB lookups in parallel
        await Promise.all([...sellerNotifications.entries()].map(async ([sellerId, sellerData]) => {
          try {
            const seller = await prisma.user.findUnique({
              where: { id: sellerId },
              include: { sellerProfile: true }
            });
            if (seller) {
              // For SLA notification, use the appropriate order ID
              const sellerOrderId = order.isMultiSeller 
                ? order.subOrders.find(sub => sub.sellerId === sellerId)?.id || orderId
                : orderId;
                
              createOrderNotification(sellerOrderId, sellerId, 'ORDER_PROCESSING', 'HIGH', {
                message: `New order received from ${user.name}`,
                notes: `${sellerData.productCount} item(s), Total: $${sellerData.totalAmount.toFixed(2)}`
              }).catch(e => console.error("SLA notification error:", e.message));
              // In-app notification already fired before reply — only SLA + email needed here
            }
            if (seller && seller.email) {
              const sellerName = seller.sellerProfile?.storeName || seller.sellerProfile?.businessName || seller.name || 'Seller';
              console.log(`📧 Sending order notification email to seller: ${seller.email}`);
              try {
                const sellerEmailResult = await sendSellerOrderNotificationEmail(seller.email, sellerName, {
                  displayId: mainOrder.displayId,
                  productCount: sellerData.productCount,
                  totalAmount: sellerData.totalAmount,
                  products: sellerData.products,
                  shippingAddress,
                  paymentMethod,
                  customerName: user.isDeleted ? 'Deleted User' : user.name,
                  customerEmail: user.email,
                  customerPhone: mobileNumber || user.phone || ''
                });
                if (sellerEmailResult?.success) {
                  console.log(`✅ Seller order email sent to ${seller.email}`);
                } else {
                  console.error(`❌ Seller order email failed for ${seller.email}:`, sellerEmailResult?.error);
                }
              } catch (emailErr) {
                console.error(`❌ Seller order email error for ${seller.email}:`, emailErr.message);
              }
            } else {
              console.warn(`⚠️  No email for seller ${sellerId} — order email skipped`);
            }
          } catch (err) {
            console.error(`Error notifying seller ${sellerId}:`, err.message);
          }
        }));

        // 3. Admin order emails — notify SUPER_ADMIN only
        console.log('🔍 Attempting to send super admin notifications...');
        try {
          const admins = await prisma.user.findMany({
            where: { role: 'SUPER_ADMIN' },
            select: { email: true, name: true }
          });
          console.log(`📋 Found ${admins.length} super admins:`, admins.map(a => a.email));
          
          const allItems = cart.items.map(item => ({
            title: getItemDisplayTitle(item),
            quantity: item.quantity,
            price: getItemPrice(item)
          }));
          
          for (const admin of admins) {
            if (admin.email) {
              console.log(`📧 Sending admin order email to: ${admin.email}`);
              try {
                const adminEmailResult = await sendAdminNewOrderEmail(admin.email, admin.name || 'Admin', {
                  displayId: mainOrder.displayId,
                  customerName: user.isDeleted ? 'Deleted User' : user.name,
                  customerEmail: user.email,
                  customerPhone: mobileNumber || user.phone || '',
                  sellerNames: sellerNameList.join(', ') || 'Unknown',
                  totalAmount,
                  paymentMethod,
                  items: allItems
                });
                if (adminEmailResult?.success) {
                  console.log(`✅ Admin order email sent to ${admin.email}`);
                } else {
                  console.error(`❌ Admin order email failed for ${admin.email}:`, adminEmailResult?.error);
                }
              } catch (adminEmailErr) {
                console.error(`❌ Admin order email error for ${admin.email}:`, adminEmailErr.message);
              }
            } else {
              console.warn(`⚠️  Admin ${admin.name || 'Unknown'} has no email address`);
            }
          }
        } catch (adminEmailListErr) {
          console.error('❌ Error fetching admins for order email:', adminEmailListErr.message);
        }
      } catch (bgErr) {
        console.error('Background notification error:', bgErr.message);
      }
    })();

    return reply.status(200).send({
      success: true,
      message: "Order placed successfully! Confirmation email sent.",
      orderId: orderId,
      displayId: mainOrder.displayId,
      isMultiSeller: order.isMultiSeller,
      ...(order.isMultiSeller ? {
        subOrders: order.subOrders.map(sub => ({
          id: sub.id,
          sellerId: sub.sellerId, 
          subtotal: sub.subtotal,
          status: sub.status
        }))
      } : {
        sellerId: mainOrder.sellerId,
        status: mainOrder.status
      }),
      orderSummary: {
        subtotal: cartCalculations.subtotal,
        subtotalExGST: cartCalculations.subtotalExGST,
        shippingCost: cartCalculations.shippingCost,
        totalShippingCost: cartCalculations.totalShippingCost,
        sellerCount: cartCalculations.sellerCount,
        gstPercentage: cartCalculations.gstPercentage,
        gstAmount: cartCalculations.gstAmount,
        originalTotal,
        discountAmount: appliedCoupon ? discountAmount : null,
        coupon: appliedCoupon ? {
          code:          appliedCoupon.code,
          discountType:  appliedCoupon.discountType,
          discountValue: appliedCoupon.discountValue,
          maxDiscount:   appliedCoupon.maxDiscount,
          discountAmount
        } : null,
        totalAmount,
        gstInclusive: true,
        shippingMethod: {
          name: shippingMethod.name,
          estimatedDays: shippingMethod.estimatedDays
        }
      }
    });

  } catch (error) {
    console.error("Create order error:", error);
    // Insufficient stock is a client error (400), not a server error
    if (error.message && error.message.startsWith("Insufficient stock")) {
      return reply.status(400).send({ success: false, message: error.message });
    }
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// USER — VIEW MY ORDERS
exports.getMyOrders = async (request, reply) => {
  try {
    const userId = request.user.userId;
    
    const orders = await prisma.order.findMany({
      where: { userId },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                title: true,
                featuredImage: true,
                price: true,
                sellerId: true,
                seller: {
                  select: { id: true, name: true }
                }
              }
            },
            productVariant: {
              include: {
                variantAttributeValues: {
                  include: { attributeValue: { include: { attribute: true } } }
                }
              }
            }
          }
        },
        seller: {
          select: {
            id: true,
            name: true
          }
        },
        subOrders: {
          select: {
            id: true,
            sellerId: true,
            parentOrderId: true,
            status: true,
            statusReason: true,
            trackingNumber: true,
            estimatedDelivery: true,
            subtotal: true,
            createdAt: true,
            updatedAt: true,
            seller: {
              select: {
                id: true,
                name: true
              }
            },
            sellerProfile: {
              select: {
                businessName: true,
                storeName: true
              }
            },
            items: {
              include: {
                product: {
                  select: {
                    id: true,
                    title: true,
                    featuredImage: true,
                    price: true,
                    sellerId: true,
                    seller: {
                      select: { id: true, name: true }
                    }
                  }
                },
                productVariant: {
                  include: {
                    variantAttributeValues: {
                      include: { attributeValue: { include: { attribute: true } } }
                    }
                  }
                }
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Transform to handle both direct orders and multi-seller orders
    const transformedOrders = orders.map(order => {
      const isDirectOrder = !!order.sellerId; // Order has sellerId means it's a direct order
      const isMultiSellerOrder = order.subOrders && order.subOrders.length > 0;

      let allItems = [];
      let computedStatus = '';
      let subOrdersData = [];

      if (isDirectOrder) {
        // DIRECT ORDER (single seller)
        allItems = order.items.map(item => ({
          ...item,
          subOrderId: null, // No sub-order
          subOrderStatus: null,
          sellerId: order.sellerId,
          sellerName: order.seller?.name || 'Unknown Seller',
          trackingNumber: order.trackingNumber,
          estimatedDelivery: order.estimatedDelivery
        }));
        
        // Use the order's direct status
        computedStatus = order.status || order.overallStatus || 'CONFIRMED';
        
        // No sub-orders for direct orders
        subOrdersData = [];
        
      } else if (isMultiSellerOrder) {
        // MULTI-SELLER ORDER (has sub-orders)
        allItems = order.subOrders.flatMap(subOrder => 
          subOrder.items.map(item => ({
            ...item,
            subOrderId: subOrder.id,
            subOrderStatus: subOrder.status,
            sellerId: subOrder.sellerId,
            sellerName: subOrder.sellerProfile?.businessName || subOrder.sellerProfile?.storeName || subOrder.seller?.name || 'Unknown Seller',
            trackingNumber: subOrder.trackingNumber,
            estimatedDelivery: subOrder.estimatedDelivery
          }))
        );

        // Compute overall status from parent order and sub-orders
        // If parent order is CANCELLED, the entire order is CANCELLED regardless of sub-orders
        if (order.status === 'CANCELLED') {
          computedStatus = 'CANCELLED';
        } else {
          const subOrderStatuses = order.subOrders.map(sub => sub.status);
          
          if (subOrderStatuses.every(status => status === 'DELIVERED')) {
            computedStatus = 'DELIVERED';
          } else if (subOrderStatuses.every(status => status === 'CANCELLED')) {
            computedStatus = 'CANCELLED';
          } else if (subOrderStatuses.some(status => status === 'SHIPPED')) {
            computedStatus = 'SHIPPED';  
          } else if (subOrderStatuses.some(status => status === 'PROCESSING')) {
            computedStatus = 'PROCESSING';
          } else {
            computedStatus = subOrderStatuses[0] || 'CONFIRMED';
          }
        }

        // Sub-orders data for multi-seller orders
        subOrdersData = order.subOrders.map(sub => ({
          id: sub.id,
          sellerId: sub.sellerId,
          sellerName: sub.sellerProfile?.businessName || sub.sellerProfile?.storeName || sub.seller?.name || 'Unknown Seller',
          status: sub.status,
          trackingNumber: sub.trackingNumber,
          estimatedDelivery: sub.estimatedDelivery,
          subtotal: sub.subtotal,
          itemCount: sub.items.length,
          items: sub.items.map(item => ({
            id: item.id,
            productId: item.productId,
            variantId: item.variantId || null,
            productTitle: item.productVariant
              ? (() => { const a = item.productVariant.variantAttributeValues?.map(av => `${av.attributeValue?.attribute?.name}: ${av.attributeValue?.value}`).filter(Boolean).join(', '); return a ? `${item.product?.title} (${a})` : item.product?.title || 'Product'; })()
              : item.product?.title || 'Product',
            productImages: item.product?.featuredImage ? [item.product.featuredImage] : [],
            quantity: item.quantity,
            price: item.price
          }))
        }));
        
      } else {
        // OLD ORDER (no sellerId, no sub-orders) - determine if DIRECT based on seller count
        const uniqueSellerIds = new Set(order.items.map(item => item.product?.sellerId).filter(Boolean));
        
        if (uniqueSellerIds.size === 1) {
          // Only one seller involved - treat as DIRECT order
          const sellerId = Array.from(uniqueSellerIds)[0];
          
          allItems = order.items.map(item => ({
            ...item,
            subOrderId: null,
            subOrderStatus: null,
            sellerId: sellerId,
            sellerName: item.product?.seller?.name || 'Unknown Seller',
            trackingNumber: order.trackingNumber,
            estimatedDelivery: order.estimatedDelivery
          }));

          computedStatus = order.overallStatus || order.status || 'CONFIRMED';
          subOrdersData = [];
          
        } else if (uniqueSellerIds.size > 1) {
          // Legacy multi-seller order with no sub-orders — group items by seller
          const sellerItemsMap = new Map();
          for (const item of order.items) {
            const sid = item.product?.sellerId;
            if (!sid) continue;
            if (!sellerItemsMap.has(sid)) sellerItemsMap.set(sid, []);
            sellerItemsMap.get(sid).push(item);
          }

          allItems = order.items.map(item => ({
            ...item,
            subOrderId: null,
            subOrderStatus: null,
            sellerId: item.product?.sellerId || null,
            sellerName: item.product?.seller?.name || 'Unknown Seller',
            trackingNumber: order.trackingNumber,
            estimatedDelivery: order.estimatedDelivery
          }));

          computedStatus = order.overallStatus || order.status || 'CONFIRMED';

          // Build synthetic per-seller groupings so the frontend can show per-seller info
          subOrdersData = [...sellerItemsMap.entries()].map(([sid, items]) => ({
            id: null, // No real sub-order record exists
            sellerId: sid,
            sellerName: items[0]?.product?.seller?.name || 'Unknown Seller',
            status: computedStatus,
            trackingNumber: order.trackingNumber,
            estimatedDelivery: order.estimatedDelivery,
            subtotal: items.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0),
            itemCount: items.length,
            items: items.map(item => ({
              id: item.id,
              productId: item.productId,
              variantId: item.variantId || null,
              productTitle: item.productVariant
                ? (() => { const a = item.productVariant.variantAttributeValues?.map(av => `${av.attributeValue?.attribute?.name}: ${av.attributeValue?.value}`).filter(Boolean).join(', '); return a ? `${item.product?.title} (${a})` : item.product?.title || 'Product'; })()
                : item.product?.title || 'Product',
              productImages: item.product?.featuredImage ? [item.product.featuredImage] : [],
              quantity: item.quantity,
              price: item.price
            }))
          }));
        } else {
          // No items have sellerId at all — skip
          console.warn(`⚠️ Order ${order.id} has no recognisable sellers — skipping`);
          return null;
        }
      }

      // Calculate seller count properly for all order types
      let sellerCount = 0;
      if (isDirectOrder) {
        sellerCount = 1; // Direct order has exactly one seller
      } else if (isMultiSellerOrder) {
        sellerCount = subOrdersData.length; // Number of sub-orders = number of sellers
      } else {
        // Old order - count unique sellers from items
        const uniqueSellerIds = new Set(allItems.map(item => item.sellerId).filter(Boolean));
        sellerCount = uniqueSellerIds.size;
      }

      return {
        id: order.id,
        displayId: order.displayId,
        userId: order.userId,
        type: isDirectOrder ? 'DIRECT' : (isMultiSellerOrder ? 'MULTI_SELLER' : (sellerCount > 1 ? 'MULTI_SELLER' : 'DIRECT')),
        totalAmount: order.totalAmount,
        status: computedStatus,
        trackingNumber: order.trackingNumber,
        estimatedDelivery: order.estimatedDelivery,
        statusReason: order.statusReason,
        paymentMethod: order.paymentMethod,
        stripePaymentIntentId: order.stripePaymentIntentId,
        paymentStatus: order.paymentStatus,
        couponCode: order.couponCode,
        discountAmount: order.discountAmount,
        originalTotal: order.originalTotal,
        shippingAddress: order.shippingAddress,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        shippingAddressLine: order.shippingAddressLine,
        shippingCity: order.shippingCity,
        shippingState: order.shippingState,
        shippingZipCode: order.shippingZipCode,
        shippingCountry: order.shippingCountry,
        shippingPhone: order.shippingPhone,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        items: allItems,
        subOrders: subOrdersData,
        // Summary info
        sellerCount: sellerCount, // Use calculated seller count
        itemCount: allItems.length
      };
    });

    // Filter out any null orders (invalid structure)
    const validOrders = transformedOrders.filter(order => order !== null);

    return reply.status(200).send({ 
      success: true, 
      orders: validOrders,
      summary: {
        totalOrders: validOrders.length,
        directOrders: validOrders.filter(o => o.type === 'DIRECT').length,
        multiSellerOrders: validOrders.filter(o => o.type === 'MULTI_SELLER').length
      }
    });
  } catch (error) {
    console.error("Get my orders error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// USER — CANCEL ORDER (with SMS notification) - FIXED FOR SUB-ORDERS
exports.cancelOrder = async (request, reply) => {
  try {
    const displayId = request.params.id;
    const userId = request.user.userId;
    const { reason, statusReason } = request.body || {};

    const order = await prisma.order.findUnique({
      where: { displayId },
      include: {
        items: {
          include: {
            product: { select: { id: true, title: true, price: true, sellerId: true } }
          }
        },
        subOrders: true, // Include sub-orders for multi-seller orders
        user: { select: { id: true, name: true, email: true, isDeleted: true } } // Include user for invoice generation
      }
    });

    if (!order) return reply.status(404).send({ success: false, message: "Order not found" });

    if (order.userId !== userId) return reply.status(403).send({ success: false, message: "Not authorized" });

    // For multi-seller orders: ALL sub-orders must be CONFIRMED to cancel
    if (order.subOrders && order.subOrders.length > 0) {
      const allConfirmed = order.subOrders.every(sub => sub.status === 'CONFIRMED');
      if (!allConfirmed) {
        return reply.status(400).send({ 
          success: false, 
          message: "Cannot cancel order. All items from all sellers must be in CONFIRMED status before cancellation." 
        });
      }
      // Multi-seller order passed validation: all sub-orders are CONFIRMED
    } else {
      // For single-seller orders: allow PENDING or CONFIRMED
      if (!['PENDING', 'CONFIRMED'].includes(order.status)) {
        return reply.status(400).send({ success: false, message: "Order cannot be cancelled" });
      }
    }

    const orderId = order.id; // resolve to internal CUID for all remaining operations

    const finalReason = (statusReason || reason || '').trim();

    if (!finalReason) {
      return reply.status(400).send({
        success: false,
        message: "Reason is required for order cancellation request"
      });
    }

    const transitionValidation = validateStatusTransition({
      currentStatus: order.status === 'PENDING' ? 'CONFIRMED' : order.status,
      nextStatus: 'CANCELLED',
      reason: finalReason
    });

    if (!transitionValidation.isValid) {
      return reply.status(400).send({
        success: false,
        message: transitionValidation.message
      });
    }

    // Use transaction to ensure atomicity: cancel sub-orders and parent order together
    await prisma.$transaction(async (tx) => {
      // If multi-seller order: cancel all sub-orders first
      if (order.subOrders && order.subOrders.length > 0) {
        const updateResult = await tx.subOrder.updateMany({
          where: { parentOrderId: orderId },
          data: {
            status: "CANCELLED",
            statusReason: finalReason,
            updatedAt: new Date()
          }
        });
        console.log(`✅ Cancelled ${updateResult.count} sub-orders for order ${orderId}`);
      }

      // Then cancel the parent order
      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: {
          status: "CANCELLED",
          statusReason: finalReason,
          updatedAt: new Date()
        }
      });
      console.log(`✅ Cancelled parent order ${orderId}`);
    });

    // Trigger Stripe refund / cancellation (non-blocking — DB is already updated)
    triggerStripeRefund(order.stripePaymentIntentId, finalReason, order.displayId);

    // Send email notification about cancellation
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    // ── In-app notifications — always fire regardless of email ─────────────
    // Notify the customer
    notifyCustomerOrderStatusChange(userId, orderId, "cancelled", {
      totalAmount: order.totalAmount.toString(),
      itemCount: order.items?.length || 0,
      reason: finalReason
    }).catch(error => {
      console.error("Customer cancel notification error (non-blocking):", error.message);
    });

    // Notify all sellers whose products are in this cancelled order (in-app + email)
    // Also collect seller names so the admin notification can include them.
    const cancelledSellerIds = [...new Set(
      order.items.map(item => item.product?.sellerId).filter(Boolean)
    )];
    const readableOrderId = orderId.slice(-8).toUpperCase();
    const cancelledSellerNames = [];
    await Promise.all(cancelledSellerIds.map(async (sellerId) => {
      const sellerProducts = order.items
        .filter(item => item.product?.sellerId === sellerId)
        .map(item => item.product?.title || 'Product');

      // Fetch seller once — used for both the name and email
      const sellerUser = await prisma.user.findUnique({
        where: { id: sellerId },
        select: { email: true, name: true, sellerProfile: { select: { storeName: true, businessName: true } } }
      }).catch(() => null);

      const resolvedSellerName = sellerUser?.sellerProfile?.storeName
        || sellerUser?.sellerProfile?.businessName
        || sellerUser?.name
        || 'Unknown';
      cancelledSellerNames.push(resolvedSellerName);

      prisma.notification.create({
        data: {
          userId: sellerId,
          title: 'Order Cancelled by Customer',
          message: `Customer ${order.customerName || 'Customer'} cancelled order ${readableOrderId}. Items: ${sellerProducts.join(', ')}. Reason: ${finalReason}`,
          type: 'ORDER_CANCELLED',
          relatedId: orderId,
          relatedType: 'order',
          metadata: {
            orderId,
            reason: finalReason,
            customerName: order.customerName,
            cancelledProducts: sellerProducts
          }
        }
      }).catch(err => console.error(`Seller cancel notification error (sellerId=${sellerId}):`, err.message));

      if (sellerUser?.email) {
        sendSellerOrderStatusEmail(sellerUser.email, resolvedSellerName, {
          displayId: order.displayId, status: 'cancelled', updatedBy: 'Customer',
          customerName: order.customerName || 'Customer',
          totalAmount: order.totalAmount, reason: finalReason
        }).catch(err => console.error(`Seller cancel email error (sellerId=${sellerId}):`, err.message));
      }
    }));

    const cancelledSellerNameStr = cancelledSellerNames.join(', ') || 'Unknown';

    // Notify all admins (in-app + email) — now includes seller name(s)
    notifyAdminOrderStatusChange(orderId, 'cancelled', {
      customerName: (order.user?.isDeleted ? 'Deleted User' : order.user?.name) || order.customerName || 'Customer',
      sellerName: cancelledSellerNameStr,
      totalAmount: order.totalAmount.toString(),
      itemCount: order.items?.length || 0,
      reason: finalReason,
      updatedBy: 'Customer'
    }).catch(err => console.error("Admin cancel in-app notification error (non-blocking):", err.message));
    prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } })
      .then(admins => {
        for (const admin of admins) {
          if (admin.email) {
            sendAdminOrderStatusEmail(admin.email, admin.name, {
              displayId: order.displayId, status: 'cancelled', updatedBy: 'Customer',
              customerName: order.customerName || 'Customer',
              sellerName: cancelledSellerNameStr,
              totalAmount: order.totalAmount, reason: finalReason
            }).catch(err => console.error("Admin cancel email error (non-blocking):", err.message));
          }
        }
      }).catch(err => console.error("Admin lookup error for cancel email (non-blocking):", err.message));
    // ─────────────────────────────────────────────────────────────────────────

    // ── Generate invoice PDF for email attachment ──────────────────────────
    let invoicePDFBuffer = null;
    try {
      const invoiceShape = {
        id: order.id,
        displayId: order.displayId,
        createdAt: order.createdAt,
        status: 'CANCELLED',
        customerName: (order.user?.isDeleted ? 'Deleted User' : order.user?.name) || order.customerName,
        customerEmail: order.user?.email || order.customerEmail,
        customerPhone: order.user?.phone || order.customerPhone,
        shippingPhone: order.shippingPhone,
        shippingAddressLine: order.shippingAddressLine,
        shippingCity: order.shippingCity,
        shippingState: order.shippingState,
        shippingZipCode: order.shippingZipCode,
        shippingCountry: order.shippingCountry,
        shippingAddress: order.shippingAddress || null,
        totalAmount: order.totalAmount,
        paymentMethod: order.paymentMethod,
        discountAmount: order.discountAmount || null,
        couponCode: order.couponCode || null,
        items: order.items,
        subOrders: order.subOrders
      };
      invoicePDFBuffer = await generateInvoiceBuffer({ ...invoiceShape, _resolvedStatus: 'CANCELLED' });
    } catch (pdfError) {
      console.error("Invoice PDF generation error (non-blocking):", pdfError.message);
      // Continue with email sending even if PDF generation fails
    }

    // ── Email (only when email address is available) ──────────────────────
    if (user && user.email) {
      console.log(`📧 Sending cancellation email to customer: ${user.email}`);

      sendOrderStatusEmail(user.email, user.name, {
        displayId: order.displayId,
        status: "cancelled",
        reason: finalReason,
        totalAmount: order.totalAmount,
        paymentMethod: order.paymentMethod,
        orderDate: order.createdAt,
        shippingName: order.customerName,
        shippingAddress: order.shippingAddressLine,
        shippingCity: order.shippingCity,
        shippingState: order.shippingState,
        shippingZipCode: order.shippingZipCode,
        shippingCountry: order.shippingCountry,
        shippingPhone: order.shippingPhone,
        isGuest: false,
        invoicePDFBuffer: invoicePDFBuffer, // Add invoice PDF to email
        products: order.items?.map(item => ({
          title: item.product?.title || 'Product',
          quantity: item.quantity,
          price: parseFloat(item.price)
        }))
      }).catch(error => {
        console.error("Email error (non-blocking):", error.message);
      });
    }

    return reply.status(200).send({ success: true, message: "Order cancelled successfully. Email notification sent." });

  } catch (error) {
    console.error("Cancel order error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// GUEST — CANCEL ORDER (No authentication required) 
// Only allows cancellation when status is CONFIRMED for guest orders
// Works for multi-seller orders: all sub-orders must be CONFIRMED
exports.cancelGuestOrder = async (request, reply) => {
  try {
    const { displayId, customerEmail, reason } = request.body || {};

    if (!displayId || !customerEmail) {
      return reply.status(400).send({ 
        success: false, 
        message: "Display ID and customer email are required" 
      });
    }

    const order = await prisma.order.findFirst({
      where: { 
        displayId,
        customerEmail: customerEmail.trim(),
        userId: null // Only guest orders (no authenticated user) can be cancelled via this endpoint
      },
      include: {
        items: {
          include: {
            product: { select: { id: true, title: true, price: true, sellerId: true } }
          }
        },
        subOrders: true, // Include sub-orders for multi-seller orders
        user: { select: { id: true, name: true, email: true, isDeleted: true } } // Include user (for guest, this will be null)
      }
    });

    if (!order) {
      return reply.status(404).send({ 
        success: false, 
        message: "Order not found or email does not match" 
      });
    }

    // For guests: ONLY CONFIRMED status is allowed (stricter than authenticated users)
    if (order.status !== 'CONFIRMED') {
      return reply.status(400).send({ 
        success: false, 
        message: "Guest orders can only be cancelled when status is CONFIRMED" 
      });
    }

    // For multi-seller orders: ALL sub-orders must also be CONFIRMED
    if (order.subOrders && order.subOrders.length > 0) {
      const allConfirmed = order.subOrders.every(sub => sub.status === 'CONFIRMED');
      if (!allConfirmed) {
        return reply.status(400).send({ 
          success: false, 
          message: "Cannot cancel order. All items from all sellers must be in CONFIRMED status before cancellation." 
        });
      }
    }

    const orderId_internal = order.id; // Internal CUID

    const finalReason = (reason || 'Guest requested cancellation').trim();

    const transitionValidation = validateStatusTransition({
      currentStatus: 'CONFIRMED',
      nextStatus: 'CANCELLED',
      reason: finalReason
    });

    if (!transitionValidation.isValid) {
      return reply.status(400).send({
        success: false,
        message: transitionValidation.message
      });
    }

    // Use transaction to ensure atomicity: cancel sub-orders and parent order together
    await prisma.$transaction(async (tx) => {
      // If multi-seller order: cancel all sub-orders first
      if (order.subOrders && order.subOrders.length > 0) {
        const updateResult = await tx.subOrder.updateMany({
          where: { parentOrderId: orderId_internal },
          data: {
            status: "CANCELLED",
            statusReason: finalReason,
            updatedAt: new Date()
          }
        });
        console.log(`✅ Cancelled ${updateResult.count} guest sub-orders for order ${orderId_internal}`);
      }

      // Then cancel the parent order
      const updatedOrder = await tx.order.update({
        where: { id: orderId_internal },
        data: {
          status: "CANCELLED",
          statusReason: finalReason,
          updatedAt: new Date()
        }
      });
      console.log(`✅ Cancelled parent guest order ${orderId_internal}`);
    });

    // Trigger Stripe refund / cancellation (non-blocking — DB is already updated)
    triggerStripeRefund(order.stripePaymentIntentId, finalReason, order.displayId);

    // ── In-app notifications (non-blocking) ─────────────────────────────────
    // Notify all sellers whose products are in this cancelled order
    const cancelledSellerIds = [...new Set(
      order.items.map(item => item.product?.sellerId).filter(Boolean)
    )];
    const readableOrderId = orderId_internal.slice(-8).toUpperCase();
    const cancelledSellerNames = [];

    await Promise.all(cancelledSellerIds.map(async (sellerId) => {
      const sellerProducts = order.items
        .filter(item => item.product?.sellerId === sellerId)
        .map(item => item.product?.title || 'Product');

      const sellerUser = await prisma.user.findUnique({
        where: { id: sellerId },
        select: { email: true, name: true, sellerProfile: { select: { storeName: true, businessName: true } } }
      }).catch(() => null);

      const resolvedSellerName = sellerUser?.sellerProfile?.storeName
        || sellerUser?.sellerProfile?.businessName
        || sellerUser?.name
        || 'Unknown';
      cancelledSellerNames.push(resolvedSellerName);

      prisma.notification.create({
        data: {
          userId: sellerId,
          title: 'Guest Order Cancelled',
          message: `Guest customer cancelled order ${readableOrderId}. Items: ${sellerProducts.join(', ')}. Reason: ${finalReason}`,
          type: 'ORDER_CANCELLED',
          relatedId: orderId_internal,
          relatedType: 'order',
          metadata: {
            orderId: orderId_internal,
            reason: finalReason,
            customerEmail: order.customerEmail,
            cancelledProducts: sellerProducts
          }
        }
      }).catch(err => console.error(`Seller cancel notification error (sellerId=${sellerId}):`, err.message));

      if (sellerUser?.email) {
        sendSellerOrderStatusEmail(sellerUser.email, resolvedSellerName, {
          displayId: order.displayId, 
          status: 'cancelled', 
          updatedBy: 'Guest Customer',
          customerName: order.customerName || 'Guest',
          totalAmount: order.totalAmount, 
          reason: finalReason
        }).catch(err => console.error(`Seller cancel email error (sellerId=${sellerId}):`, err.message));
      }
    }));

    const cancelledSellerNameStr = cancelledSellerNames.join(', ') || 'Unknown';

    // Notify admins
    notifyAdminOrderStatusChange(orderId_internal, 'cancelled', {
      customerName: order.customerName || 'Guest',
      sellerName: cancelledSellerNameStr,
      totalAmount: order.totalAmount.toString(),
      itemCount: order.items?.length || 0,
      reason: finalReason,
      updatedBy: 'Guest Customer',
      isGuest: true
    }).catch(err => console.error("Admin cancel in-app notification error (non-blocking):", err.message));

    prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } })
      .then(admins => {
        for (const admin of admins) {
          if (admin.email) {
            sendAdminOrderStatusEmail(admin.email, admin.name, {
              displayId: order.displayId, 
              status: 'cancelled', 
              updatedBy: 'Guest Customer',
              customerName: order.customerName || 'Guest',
              sellerName: cancelledSellerNameStr,
              totalAmount: order.totalAmount, 
              reason: finalReason
            }).catch(err => console.error("Admin cancel email error (non-blocking):", err.message));
          }
        }
      }).catch(err => console.error("Admin lookup error for cancel email (non-blocking):", err.message));
    // ─────────────────────────────────────────────────────────────────────────

    // ── Generate invoice PDF for email attachment ──────────────────────────
    let invoicePDFBuffer = null;
    try {
      const invoiceShape = {
        id: order.id,
        displayId: order.displayId,
        createdAt: order.createdAt,
        status: 'CANCELLED',
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        shippingPhone: order.shippingPhone,
        shippingAddressLine: order.shippingAddressLine,
        shippingCity: order.shippingCity,
        shippingState: order.shippingState,
        shippingZipCode: order.shippingZipCode,
        shippingCountry: order.shippingCountry,
        shippingAddress: order.shippingAddress || null,
        totalAmount: order.totalAmount,
        paymentMethod: order.paymentMethod,
        discountAmount: order.discountAmount || null,
        couponCode: order.couponCode || null,
        items: order.items,
        subOrders: order.subOrders
      };
      invoicePDFBuffer = await generateInvoiceBuffer({ ...invoiceShape, _resolvedStatus: 'CANCELLED' });
    } catch (pdfError) {
      console.error("Invoice PDF generation error (non-blocking):", pdfError.message);
      // Continue with email sending even if PDF generation fails
    }

    // ── Email notification to guest ──────────────────────────────────────────
    if (order.customerEmail) {
      console.log(`📧 Sending cancellation email to guest: ${order.customerEmail}`);

      sendOrderStatusEmail(order.customerEmail, order.customerName, {
        displayId: order.displayId,
        status: "cancelled",
        reason: finalReason,
        totalAmount: order.totalAmount,
        paymentMethod: order.paymentMethod,
        orderDate: order.createdAt,
        shippingName: order.customerName,
        shippingAddress: order.shippingAddressLine,
        shippingCity: order.shippingCity,
        shippingState: order.shippingState,
        shippingZipCode: order.shippingZipCode,
        shippingCountry: order.shippingCountry,
        shippingPhone: order.shippingPhone,
        isGuest: true,
        invoicePDFBuffer: invoicePDFBuffer, // Add invoice PDF to email
        products: order.items?.map(item => ({
          title: item.product?.title || 'Product',
          quantity: item.quantity,
          price: parseFloat(item.price)
        }))
      }).catch(error => {
        console.error("Email error (non-blocking):", error.message);
      });
    }

    return reply.status(200).send({ 
      success: true, 
      message: "Order cancelled successfully. Confirmation email sent to your email address." 
    });

  } catch (error) {
    console.error("Guest cancel order error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

const formatRefundRequestFromTicket = (ticket, orderDisplayId = null) => {
  const message = ticket.message || '';
  // Stop reason at item list or JSON block
  const reasonMatch = message.match(/Reason:\s*([\s\S]+?)(?=\nRequested Items:|\n---ITEMS_JSON---|$)/i);

  // Parse per-item details from the structured blob
  let requestedItems = null;
  try {
    const match = message.match(/---ITEMS_JSON---\n([\s\S]+)/);
    if (match) {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed) && parsed.length > 0) requestedItems = parsed;
    }
  } catch { /* ignore */ }

  return {
    id: ticket.id,
    requestId: ticket.id,
    orderId: ticket.orderId || null,
    orderDisplayId: orderDisplayId ? `#${orderDisplayId}` : null,
    requestType: ticket.requestType || null,
    reason: reasonMatch?.[1]?.trim() || null,
    requestedItems,
    attachments: ticket.attachments || [],
    guestEmail: ticket.guestEmail || null,
    status: ({ OPEN: 'OPEN', IN_PROGRESS: 'APPROVED', RESOLVED: 'COMPLETED', CLOSED: 'REJECTED' }[ticket.status] || ticket.status),
    priority: ticket.priority,
    adminResponse: ticket.response,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt
  };
};

// USER — REQUEST REFUND
// Body: { items?: [{orderItemId, quantity, reason?, attachments?}], reason?, attachments? }
// - items omitted / empty  → full refund of all items
// - items is a subset      → partial refund; requestType auto-determined
// - per-item reason/attachments override the top-level ones for that item
exports.requestRefund = async (request, reply) => {
  try {
    const displayId = request.params.id;
    const userId = request.user.userId;
    const { items: requestedItems, reason, attachments } = request.body || {};

    // items must be an array if provided
    if (requestedItems !== undefined && !Array.isArray(requestedItems)) {
      return reply.status(400).send({ success: false, message: '"items" must be an array' });
    }

    const topLevelReason = (reason || '').trim();

    const order = await prisma.order.findUnique({
      where: { displayId },
      include: {
        items: {
          include: {
            product: { select: { id: true, sellerId: true, title: true, featuredImage: true } }
          }
        },
        subOrders: {
          include: {
            items: {
              include: {
                product: { select: { id: true, sellerId: true, title: true, featuredImage: true } }
              }
            }
          }
        },
        user: { select: { id: true, name: true, email: true, isDeleted: true } }
      }
    });

    if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });
    if (order.userId !== userId) return reply.status(403).send({ success: false, message: 'Not authorized' });

    const effectiveStatus = order.overallStatus || order.status;

    if (['CANCELLED', 'REFUND', 'PARTIAL_REFUND'].includes(effectiveStatus)) {
      return reply.status(400).send({
        success: false,
        message: `Cannot request a refund for an order in ${effectiveStatus} status`
      });
    }

    if (!['DELIVERED'].includes(effectiveStatus)) {
      return reply.status(400).send({
        success: false,
        message: `Refund requests can only be made for delivered orders. Current status: ${effectiveStatus}`
      });
    }

    const orderId = order.id;

    // ── Prevent duplicate refund requests ────────────────────────────────────
    const existingRefund = await prisma.supportTicket.findFirst({
      where: { orderId, category: 'REFUND_REQUEST' },
      select: { id: true, status: true }
    });
    if (existingRefund) {
      return reply.status(409).send({
        success: false,
        message: 'A refund request has already been submitted for this order.',
        existingRequestId: existingRefund.id,
        existingStatus: existingRefund.status
      });
    }

    // Flatten items from both direct order.items (single-seller) and
    // subOrder.items (multi-seller) into one unified map
    const subOrderItems = (order.subOrders || []).flatMap(so => so.items || []);
    const allOrderItems = [...order.items, ...subOrderItems];
    const orderItemMap = new Map(allOrderItems.map(i => [i.id, i]));

    // ── Resolve requested line items ─────────────────────────────────────────
    let resolvedItems; // [{ orderItem, requestedQty, reason, attachments }]

    if (!requestedItems || requestedItems.length === 0) {
      // Full refund — include all order items at their full quantities
      resolvedItems = allOrderItems.map(oi => ({
        orderItem:     oi,
        requestedQty:  oi.quantity,
        reason:        topLevelReason,
        attachments:   (attachments && Array.isArray(attachments)) ? attachments : []
      }));
    } else {
      // Validate each requested item
      const errors = [];
      resolvedItems = [];
      for (const ri of requestedItems) {
        if (!ri.orderItemId) { errors.push('Each item must have an "orderItemId"'); continue; }
        const oi = orderItemMap.get(ri.orderItemId);
        if (!oi) { errors.push(`Order item "${ri.orderItemId}" not found in this order`); continue; }
        const qty = parseInt(ri.quantity, 10);
        if (!qty || qty < 1 || qty > oi.quantity) {
          errors.push(`Invalid quantity ${qty} for item "${oi.product?.title || ri.orderItemId}" (max: ${oi.quantity})`);
          continue;
        }
        const itemReason = ((ri.reason || '').trim()) || topLevelReason;
        if (!itemReason) {
          errors.push(`A reason is required for item "${oi.product?.title || ri.orderItemId}"`);
          continue;
        }
        resolvedItems.push({
          orderItem:    oi,
          requestedQty: qty,
          reason:       itemReason,
          attachments:  (ri.attachments && Array.isArray(ri.attachments)) ? ri.attachments
                        : (attachments && Array.isArray(attachments)) ? attachments : []
        });
      }
      if (errors.length) return reply.status(400).send({ success: false, message: errors[0], errors });
      if (!resolvedItems.length) return reply.status(400).send({ success: false, message: 'No valid items provided' });
    }

    // At least a top-level or item-level reason is required
    const hasReason = resolvedItems.every(r => r.reason);
    if (!hasReason) {
      return reply.status(400).send({ success: false, message: 'A reason is required for all requested items' });
    }

    // ── Auto-determine refund type ────────────────────────────────────────────
    const totalOrderQty   = allOrderItems.reduce((s, i) => s + i.quantity, 0);
    const totalRequestQty = resolvedItems.reduce((s, r) => s + r.requestedQty, 0);
    const requestedItemIds = new Set(resolvedItems.map(r => r.orderItem.id));
    const allItemsCovered  = allOrderItems.every(i => requestedItemIds.has(i.id));
    const isFullRefund     = allItemsCovered && totalRequestQty === totalOrderQty;
    const normalizedRequestType = isFullRefund ? 'REFUND' : 'PARTIAL_REFUND';
    const ticketTitle      = isFullRefund ? 'Full Refund Request' : 'Partial Refund Request';
    const readableOrderId  = order.displayId;

    // ── Build structured message for storage ─────────────────────────────────
    // Use the first item's reason (or top-level) as the headline reason
    const headlineReason = topLevelReason || resolvedItems[0]?.reason || '';
    const itemsText = resolvedItems.map(r =>
      `- ${r.orderItem.product?.title || r.orderItem.id} (Qty: ${r.requestedQty})` +
      (r.reason !== headlineReason ? ` — ${r.reason}` : '')
    ).join('\n');

    // Structured JSON blob for seller/admin parsing
    const itemsBlob = resolvedItems.map(r => ({
      orderItemId: r.orderItem.id,
      productId:   r.orderItem.product?.id || r.orderItem.productId,
      title:       r.orderItem.product?.title || 'Product',
      image:       r.orderItem.product?.featuredImage || null,
      quantity:    r.requestedQty,
      price:       r.orderItem.price,
      reason:      r.reason,
      attachments: r.attachments
    }));

    const allAttachments = [...new Set(resolvedItems.flatMap(r => r.attachments))];

    const ticketMessage = [
      `Order ID: ${readableOrderId}`,
      `Reason: ${headlineReason}`,
      `Requested Items:\n${itemsText}`,
      `---ITEMS_JSON---`,
      JSON.stringify(itemsBlob)
    ].join('\n');

    const supportTicket = await prisma.supportTicket.create({
      data: {
        userId,
        orderId,
        requestType: normalizedRequestType,
        subject: `${ticketTitle} for Order ${readableOrderId}`,
        message: ticketMessage,
        category: 'REFUND_REQUEST',
        attachments: allAttachments
      }
    });

    // ── Notifications ─────────────────────────────────────────────────────────
    const sellerIds = [...new Set(order.items.map(i => i.product?.sellerId).filter(Boolean))];
    const admins    = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
      select: { id: true }
    });

    const notifTitle   = `${ticketTitle} Submitted`;
    const notifMessage = `${order.customerName || order.user?.name || 'Customer'} requested a ${normalizedRequestType.toLowerCase().replace('_', ' ')} for order ${readableOrderId}.`;
    const metadata     = {
      orderId,
      requestType: normalizedRequestType,
      reason: headlineReason,
      supportTicketId: supportTicket.id,
      totalAmount: order.totalAmount?.toString()
    };

    const notifRows = [
      ...admins.map(a => ({ userId: a.id, title: notifTitle, message: notifMessage, type: 'GENERAL', relatedId: orderId, relatedType: 'order', metadata })),
      ...sellerIds.map(sid => ({ userId: sid, title: notifTitle, message: notifMessage, type: 'GENERAL', relatedId: orderId, relatedType: 'order', metadata })),
      { userId, title: `${ticketTitle} Received`, message: `Your refund request for order ${readableOrderId} has been submitted and is under review.`, type: 'GENERAL', relatedId: orderId, relatedType: 'order', metadata }
    ];
    await prisma.notification.createMany({ data: notifRows });

    // ── Emails (non-blocking) ─────────────────────────────────────────────────
    const customerEmail = order.user?.email;
    const customerName  = (order.user?.isDeleted ? 'Deleted User' : order.user?.name) || order.customerName || 'Customer';

    // ── Generate invoice PDF for email attachment ──────────────────────────
    let invoicePDFBuffer = null;
    try {
      const invoiceShape = {
        id: order.id,
        displayId: order.displayId,
        createdAt: order.createdAt,
        status: order.status || 'CONFIRMED',
        customerName: (order.user?.isDeleted ? 'Deleted User' : order.user?.name) || order.customerName,
        customerEmail: order.user?.email || order.customerEmail,
        customerPhone: order.user?.phone || order.customerPhone,
        shippingPhone: order.shippingPhone,
        shippingAddressLine: order.shippingAddressLine,
        shippingCity: order.shippingCity,
        shippingState: order.shippingState,
        shippingZipCode: order.shippingZipCode,
        shippingCountry: order.shippingCountry,
        shippingAddress: order.shippingAddress || null,
        totalAmount: order.totalAmount,
        paymentMethod: order.paymentMethod,
        discountAmount: order.discountAmount || null,
        couponCode: order.couponCode || null,
        items: order.items,
        subOrders: order.subOrders
      };
      invoicePDFBuffer = await generateInvoiceBuffer(invoiceShape);
    } catch (pdfError) {
      console.error("Invoice PDF generation error (non-blocking):", pdfError.message);
      // Continue with email sending even if PDF generation fails
    }

    if (customerEmail) {
      sendRefundRequestConfirmationEmail(customerEmail, customerName, {
        displayId: order.displayId,
        ticketId: supportTicket.id,
        requestType: normalizedRequestType,
        reason: headlineReason,
        totalAmount: order.totalAmount,
        isGuest: false,
        items: itemsBlob
      }, invoicePDFBuffer).catch(err => console.error('Refund confirmation email error (non-blocking):', err.message));
    }

    prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } })
      .then(superAdmins => {
        for (const admin of superAdmins) {
          if (admin.email) {
            sendAdminOrderStatusEmail(admin.email, admin.name, {
              displayId: order.displayId,
              status: isFullRefund ? 'refund' : 'partial_refund',
              updatedBy: `Customer (${ticketTitle})`,
              customerName,
              reason: headlineReason,
              totalAmount: order.totalAmount
            }).catch(err => console.error('Admin refund email error (non-blocking):', err.message));
          }
        }
      }).catch(err => console.error('Admin list fetch error (non-blocking):', err.message));

    return reply.status(201).send({
      success: true,
      message: `${ticketTitle} submitted successfully`,
      request: {
        id:              supportTicket.id,
        orderId,
        orderDisplayId:  `${order.displayId}`,
        requestType:     normalizedRequestType,
        reason:          headlineReason,
        requestedItems:  itemsBlob,
        attachments:     allAttachments,
        status:          supportTicket.status,
        createdAt:       supportTicket.createdAt
      }
    });
  } catch (error) {
    console.error('Refund request error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// USER — TRACK MY FULL REFUND / PARTIAL REFUND REQUESTS
exports.getMyRefundRequests = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const tickets = await prisma.supportTicket.findMany({
      where: {
        userId,
        category: 'REFUND_REQUEST'
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderId: true,
        guestEmail: true,
        requestType: true,
        subject: true,
        message: true,
        status: true,
        priority: true,
        response: true,
        createdAt: true,
        updatedAt: true
      }
    });

    // Batch-fetch displayIds for all linked orders in one query
    const orderIds = [...new Set(tickets.map(t => t.orderId).filter(Boolean))];
    const linkedOrders = orderIds.length
      ? await prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, displayId: true }
        })
      : [];
    const displayIdMap = Object.fromEntries(linkedOrders.map(o => [o.id, o.displayId]));

    const formattedRequests = tickets.map(t =>
      formatRefundRequestFromTicket(t, displayIdMap[t.orderId] ?? null)
    );

    return reply.status(200).send({
      success: true,
      requests: formattedRequests,
      count: formattedRequests.length
    });
  } catch (error) {
    console.error('Get refund requests error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// USER — TRACK SINGLE REFUND REQUEST DETAILS
exports.getRefundRequestById = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { requestId } = request.params;

    const ticket = await prisma.supportTicket.findFirst({
      where: {
        id: requestId,
        userId,
        category: 'REFUND_REQUEST'
      },
      select: {
        id: true,
        orderId: true,
        guestEmail: true,
        requestType: true,
        subject: true,
        message: true,
        status: true,
        priority: true,
        response: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!ticket) {
      return reply.status(404).send({
        success: false,
        message: 'Refund request not found'
      });
    }

    let orderDisplayId = null;
    if (ticket.orderId) {
      const linked = await prisma.order.findUnique({
        where: { id: ticket.orderId },
        select: { displayId: true }
      });
      orderDisplayId = linked?.displayId ?? null;
    }

    return reply.status(200).send({
      success: true,
      request: formatRefundRequestFromTicket(ticket, orderDisplayId)
    });
  } catch (error) {
    console.error('Get refund request by id error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// GUEST & USER — FIND ORDER FOR REFUND (Find eligible delivered items)
exports.findOrderForRefund = async (request, reply) => {
  try {
    const { orderId, customerEmail } = request.body?.orderId ? request.body : request.query;

    if (!orderId || !customerEmail) {
      return reply.status(400).send({ success: false, message: "Order ID and customer email are required" });
    }

    const displayId = orderId.replace(/^#/, '').trim();
    const normalizedEmail = customerEmail.trim().toLowerCase();

    const order = await prisma.order.findUnique({
      where: { displayId },
      include: {
        user: { select: { email: true } },
        seller: { select: { id: true, name: true } },
        items: {
          include: {
            product: { select: { id: true, title: true, featuredImage: true, price: true, sellerId: true, type: true } },
            productVariant: {
              include: {
                variantAttributeValues: {
                  include: {
                    attributeValue: {
                      include: {
                        attribute: true
                      }
                    }
                  }
                }
              }
            }
          }
        },
        subOrders: {
          include: {
            items: {
              include: {
                product: { select: { id: true, title: true, featuredImage: true, price: true, sellerId: true, type: true } },
                productVariant: {
                  include: {
                    variantAttributeValues: {
                      include: {
                        attributeValue: {
                          include: {
                            attribute: true
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            seller: { select: { id: true, name: true } },
            sellerProfile: { select: { businessName: true, storeName: true } }
          }
        }
      }
    });

    if (!order) {
      return reply.status(404).send({ success: false, message: "Order not found" });
    }

    // Verify email (Check both guest email and registered user email)
    const orderEmail = (order.user?.email || order.customerEmail || '').trim().toLowerCase();
    if (orderEmail !== normalizedEmail) {
      return reply.status(403).send({ success: false, message: "Email does not match the order records" });
    }

    const isMultiSellerOrder = order.subOrders && order.subOrders.length > 0;
    let availableDeliveries = [];

    if (isMultiSellerOrder) {
      // Only include sub-orders that are DELIVERED
      const deliveredSubOrders = order.subOrders.filter(sub => sub.status === 'DELIVERED');
      
      availableDeliveries = deliveredSubOrders.map(sub => {
        const sellerName = sub.sellerProfile?.businessName || sub.sellerProfile?.storeName || sub.seller?.name || 'Unknown Seller';
        return {
          id: sub.id, // Internal subOrderId 
          displayId: order.displayId,
          sellerId: sub.sellerId,
          sellerName: sellerName,
          status: sub.status,
          deliveredAt: sub.updatedAt,
          items: sub.items.map(item => {
            const variantAttributes = formatVariantAttributes(item.productVariant);
            const displayTitle = variantAttributes?.length 
              ? `${item.product?.title} (${variantAttributes.map(a => `${a.name}: ${a.displayValue || a.value}`).join(', ')})`
              : (item.product?.title || 'Product');

            // Extract common variant attributes as direct properties for easy frontend access
            const directVariantProps = {};
            if (variantAttributes?.length) {
              variantAttributes.forEach(attr => {
                const key = attr.name.toLowerCase(); // size, color, style, etc.
                directVariantProps[key] = attr.displayValue || attr.value;
              });
            }

            return {
              orderItemId: item.id,
              productId: item.product?.id,
              variantId: item.variantId,
              ...directVariantProps, // ✅ Direct properties: size, color, etc.
              title: item.product?.title || 'Product',
              displayTitle,
              image: item.product?.featuredImage || null,
              quantity: item.quantity,
              price: item.price,
              variant: item.productVariant ? {
                id: item.productVariant.id,
                sku: item.productVariant.sku,
                attributes: variantAttributes
              } : null
            };
          })
        };
      });
    } else {
      // Direct order or old order without sub-orders
      const status = order.status || order.overallStatus;
      // Also allow 'DELIVERED' status 
      if (status === 'DELIVERED') {
        const sellerName = order.seller?.name || 'Unknown Seller'; 
        availableDeliveries = [{
          id: order.id,
          displayId: order.displayId,
          sellerId: order.sellerId,
          sellerName: sellerName,
          status: status,
          deliveredAt: order.updatedAt,
          items: order.items.map(item => {
            const variantAttributes = formatVariantAttributes(item.productVariant);
            const displayTitle = variantAttributes?.length 
              ? `${item.product?.title} (${variantAttributes.map(a => `${a.name}: ${a.displayValue || a.value}`).join(', ')})`
              : (item.product?.title || 'Product');

            // Extract common variant attributes as direct properties for easy frontend access
            const directVariantProps = {};
            if (variantAttributes?.length) {
              variantAttributes.forEach(attr => {
                const key = attr.name.toLowerCase(); // size, color, style, etc.
                directVariantProps[key] = attr.displayValue || attr.value;
              });
            }

            return {
              orderItemId: item.id,
              productId: item.product?.id,
              variantId: item.variantId,
              ...directVariantProps, // ✅ Direct properties: size, color, etc.
              title: item.product?.title || 'Product',
              displayTitle,
              image: item.product?.featuredImage || null,
              quantity: item.quantity,
              price: item.price,
              variant: item.productVariant ? {
                id: item.productVariant.id,
                sku: item.productVariant.sku,
                attributes: variantAttributes
              } : null
            };
          })
        }];
      }
    }

    return reply.status(200).send({
      success: true,
      order: {
        id: order.id,
        displayId: order.displayId,
        customerName: order.user?.name || order.customerName,
        customerEmail: order.user?.email || order.customerEmail,
        isGuest: !order.userId,
        eligibleRefundOrders: availableDeliveries
      }
    });

  } catch (error) {
    console.error('Find order for refund error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// GUEST — REQUEST REFUND
// Body (JSON): { orderId, customerEmail, items?, reason?, attachments? }
// Body (multipart): same fields; files are uploaded server-side and become top-level attachments
// - items omitted / empty  → full refund of all items
// - items is a subset      → partial refund; requestType auto-determined
// - per-item reason/attachments override the top-level ones for that item
exports.requestGuestRefund = async (request, reply) => {
  try {
    const normalizeReasonInput = (obj = {}) => (
      obj.reason ||
      obj.refundReason ||
      obj.statusReason ||
      obj.message ||
      ''
    );

    let payloadOrderId, customerEmail, topLevelReason, requestedItems, topLevelAttachments = [], uploadedImageUrls = [];

    if (request.isMultipart()) {
      const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
      const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
      const MAX_IMAGES = 5;
      const tempFiles = [];

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          if (uploadedImageUrls.length >= MAX_IMAGES) { part.file.resume(); continue; }
          if (!ALLOWED_MIME_TYPES.includes(part.mimetype)) { part.file.resume(); continue; }
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          const ext = path.extname(part.filename) || '.jpg';
          const filepath = path.join(os.tmpdir(), `refund-${uniqueSuffix}${ext}`);
          let size = 0;
          part.file.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_FILE_SIZE) part.file.destroy(new Error('File exceeds 5MB limit'));
          });
          try {
            await pipeline(part.file, fs.createWriteStream(filepath));
            tempFiles.push(filepath);
          } catch (e) {
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
          }
        } else {
          if (part.fieldname === 'orderId')        payloadOrderId    = part.value;
          else if (part.fieldname === 'customerEmail') customerEmail  = part.value;
          else if (['reason', 'refundReason', 'statusReason', 'message'].includes(part.fieldname)) topLevelReason = part.value;
          else if (part.fieldname === 'attachments') {
            try { topLevelAttachments = JSON.parse(part.value); } catch { /* ignore */ }
          }
          else if (part.fieldname === 'items') {
            try { requestedItems = JSON.parse(part.value); } catch { requestedItems = []; }
          }
        }
      }

      // Upload files to Cloudinary → go into top-level attachments
      for (const filepath of tempFiles) {
        try {
          const result = await uploadToCloudinary(filepath, 'refund-evidence');
          uploadedImageUrls.push(result.url);
        } catch (e) {
          console.error('Refund image upload error:', e.message);
        } finally {
          if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
        }
      }
      topLevelAttachments = [...topLevelAttachments, ...uploadedImageUrls];
    } else {
      const body = request.body || {};
      payloadOrderId     = body.orderId;
      customerEmail      = body.customerEmail;
      topLevelReason     = normalizeReasonInput(body);
      requestedItems     = body.items;
      topLevelAttachments = Array.isArray(body.attachments) ? body.attachments
        : Array.isArray(body.images) ? body.images : [];
    }

    if (!payloadOrderId || !customerEmail) {
      return reply.status(400).send({ success: false, message: 'orderId and customerEmail are required' });
    }
    if (requestedItems !== undefined && !Array.isArray(requestedItems)) {
      return reply.status(400).send({ success: false, message: '"items" must be an array' });
    }

    const displayId      = payloadOrderId.replace(/^#/, '').trim();
    const normalizedEmail = customerEmail.trim().toLowerCase();
    const finalTopReason  = (topLevelReason || '').trim();

    const order = await prisma.order.findUnique({
      where: { displayId },
      include: {
        user: { select: { id: true, email: true, name: true, isDeleted: true } },
        items: {
          include: {
            product: { select: { id: true, sellerId: true, title: true, featuredImage: true } }
          }
        },
        subOrders: {
          include: {
            items: {
              include: {
                product: { select: { id: true, sellerId: true, title: true, featuredImage: true } }
              }
            }
          }
        }
      }
    });

    if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });

    // Block registered (non-deleted) users from using the guest refund endpoint
    if (order.user && !order.user.isDeleted) {
      return reply.status(403).send({
        success: false,
        message: 'This order belongs to a registered account. Please log in to request a refund.'
      });
    }

    const orderEmail = (order.user?.email || order.customerEmail || '').trim().toLowerCase();
    if (orderEmail !== normalizedEmail) {
      return reply.status(403).send({ success: false, message: 'Email does not match order' });
    }

    const effectiveStatus = order.overallStatus || order.status;
    if (['CANCELLED', 'REFUND', 'PARTIAL_REFUND'].includes(effectiveStatus)) {
      return reply.status(400).send({ success: false, message: `Cannot request a refund for an order in ${effectiveStatus} status` });
    }
    if (effectiveStatus !== 'DELIVERED') {
      return reply.status(400).send({ success: false, message: `Refund requests can only be made for delivered orders. Current status: ${effectiveStatus}` });
    }

    const orderId = order.id;

    // ── Prevent duplicate refund requests ────────────────────────────────────
    const existingRefund = await prisma.supportTicket.findFirst({
      where: { orderId, category: 'REFUND_REQUEST' },
      select: { id: true, status: true }
    });
    if (existingRefund) {
      return reply.status(409).send({
        success: false,
        message: 'A refund request has already been submitted for this order.',
        existingRequestId: existingRefund.id,
        existingStatus: existingRefund.status
      });
    }

    // Flatten items across direct + subOrder items (multi-seller support)
    const subOrderItems = (order.subOrders || []).flatMap(so => so.items || []);
    const allOrderItems = [...order.items, ...subOrderItems];
    const orderItemMap  = new Map(allOrderItems.map(i => [i.id, i]));

    // ── Resolve requested line items ─────────────────────────────────────────
    let resolvedItems;

    if (!requestedItems || requestedItems.length === 0) {
      resolvedItems = allOrderItems.map(oi => ({
        orderItem:    oi,
        requestedQty: oi.quantity,
        reason:       finalTopReason,
        attachments:  topLevelAttachments
      }));
    } else {
      const errors = [];
      resolvedItems = [];
      for (const ri of requestedItems) {
        if (!ri.orderItemId) { errors.push('Each item must have an "orderItemId"'); continue; }
        const oi = orderItemMap.get(ri.orderItemId);
        if (!oi) { errors.push(`Order item "${ri.orderItemId}" not found in this order`); continue; }
        const qty = parseInt(ri.quantity, 10);
        if (!qty || qty < 1 || qty > oi.quantity) {
          errors.push(`Invalid quantity ${qty} for item "${oi.product?.title || ri.orderItemId}" (max: ${oi.quantity})`);
          continue;
        }
        const itemReason = (normalizeReasonInput(ri) || '').trim() || finalTopReason;
        if (!itemReason) {
          errors.push(`A reason is required for item "${oi.product?.title || ri.orderItemId}"`);
          continue;
        }
        resolvedItems.push({
          orderItem:    oi,
          requestedQty: qty,
          reason:       itemReason,
          attachments:  (ri.attachments && Array.isArray(ri.attachments)) ? ri.attachments : topLevelAttachments
        });
      }
      if (errors.length) return reply.status(400).send({ success: false, message: errors[0], errors });
      if (!resolvedItems.length) return reply.status(400).send({ success: false, message: 'No valid items provided' });
    }

    if (!resolvedItems.every(r => r.reason)) {
      return reply.status(400).send({ success: false, message: 'A reason is required for all requested items' });
    }

    // ── Auto-determine refund type ────────────────────────────────────────────
    const totalOrderQty    = allOrderItems.reduce((s, i) => s + i.quantity, 0);
    const totalRequestQty  = resolvedItems.reduce((s, r) => s + r.requestedQty, 0);
    const requestedItemIds = new Set(resolvedItems.map(r => r.orderItem.id));
    const allItemsCovered  = allOrderItems.every(i => requestedItemIds.has(i.id));
    const isFullRefund     = allItemsCovered && totalRequestQty === totalOrderQty;
    const normalizedRequestType = isFullRefund ? 'REFUND' : 'PARTIAL_REFUND';
    const ticketTitle      = isFullRefund ? 'Full Refund Request' : 'Partial Refund Request';
    const readableOrderId  = order.displayId;

    // ── Build structured message ──────────────────────────────────────────────
    const headlineReason = finalTopReason || resolvedItems[0]?.reason || '';
    const itemsText = resolvedItems.map(r =>
      `- ${r.orderItem.product?.title || r.orderItem.id} (Qty: ${r.requestedQty})` +
      (r.reason !== headlineReason ? ` — ${r.reason}` : '')
    ).join('\n');

    const itemsBlob = resolvedItems.map(r => ({
      orderItemId: r.orderItem.id,
      productId:   r.orderItem.product?.id || r.orderItem.productId,
      title:       r.orderItem.product?.title || 'Product',
      image:       r.orderItem.product?.featuredImage || null,
      quantity:    r.requestedQty,
      price:       r.orderItem.price,
      reason:      r.reason,
      attachments: r.attachments
    }));

    const allAttachments = [...new Set(resolvedItems.flatMap(r => r.attachments))];

    const ticketMessage = [
      `Order ID: ${readableOrderId}`,
      `Reason: ${headlineReason}`,
      `Requested Items:\n${itemsText}`,
      `---ITEMS_JSON---`,
      JSON.stringify(itemsBlob)
    ].join('\n');

    const supportTicket = await prisma.supportTicket.create({
      data: {
        userId:      order.userId || null,
        orderId,
        guestEmail:  normalizedEmail,
        requestType: normalizedRequestType,
        subject:     `${ticketTitle} for Order ${readableOrderId}`,
        message:     ticketMessage,
        category:    'REFUND_REQUEST',
        attachments: allAttachments
      }
    });

    // ── Notifications ─────────────────────────────────────────────────────────
    const sellerIds = [...new Set(allOrderItems.map(i => i.product?.sellerId).filter(Boolean))];
    const admins    = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
      select: { id: true }
    });

    const notifTitle   = `${ticketTitle} Submitted`;
    const notifMessage = `Guest ${order.customerName || normalizedEmail} requested a ${normalizedRequestType.toLowerCase().replace('_', ' ')} for order ${readableOrderId}.`;
    const metadata     = { orderId, requestType: normalizedRequestType, reason: headlineReason, supportTicketId: supportTicket.id, guestEmail: normalizedEmail, totalAmount: order.totalAmount?.toString() };

    const notifRows = [
      ...admins.map(a  => ({ userId: a.id,   title: notifTitle, message: notifMessage, type: 'GENERAL', relatedId: orderId, relatedType: 'order', metadata })),
      ...sellerIds.map(sid => ({ userId: sid, title: notifTitle, message: notifMessage, type: 'GENERAL', relatedId: orderId, relatedType: 'order', metadata }))
    ];
    if (notifRows.length) await prisma.notification.createMany({ data: notifRows });

    // ── Emails (non-blocking) ─────────────────────────────────────────────────
    const customerName = order.customerName || (order.user?.isDeleted ? 'Guest' : order.user?.name) || 'Guest';

    // ── Generate invoice PDF for email attachment ──────────────────────────
    let invoicePDFBuffer = null;
    try {
      const invoiceShape = {
        id: order.id,
        displayId: order.displayId,
        createdAt: order.createdAt,
        status: order.status || 'DELIVERED',
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        shippingPhone: order.shippingPhone,
        shippingAddressLine: order.shippingAddressLine,
        shippingCity: order.shippingCity,
        shippingState: order.shippingState,
        shippingZipCode: order.shippingZipCode,
        shippingCountry: order.shippingCountry,
        shippingAddress: order.shippingAddress || null,
        totalAmount: order.totalAmount,
        paymentMethod: order.paymentMethod,
        discountAmount: order.discountAmount || null,
        couponCode: order.couponCode || null,
        items: order.items,
        subOrders: order.subOrders
      };
      invoicePDFBuffer = await generateInvoiceBuffer(invoiceShape);
    } catch (pdfError) {
      console.error("Invoice PDF generation error (non-blocking):", pdfError.message);
      // Continue with email sending even if PDF generation fails
    }

    sendRefundRequestConfirmationEmail(normalizedEmail, customerName, {
      displayId:   order.displayId,
      ticketId:    supportTicket.id,
      requestType: normalizedRequestType,
      reason:      headlineReason,
      totalAmount: order.totalAmount,
      isGuest:     true,
      items:       itemsBlob
    }, invoicePDFBuffer).catch(err => console.error('Guest refund confirmation email error (non-blocking):', err.message));

    prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } })
      .then(superAdmins => {
        for (const admin of superAdmins) {
          if (admin.email) {
            sendAdminOrderStatusEmail(admin.email, admin.name, {
              displayId:    order.displayId,
              status:       isFullRefund ? 'refund' : 'partial_refund',
              updatedBy:    `Guest Customer (${ticketTitle})`,
              customerName: customerName,
              reason:       headlineReason,
              totalAmount:  order.totalAmount
            }).catch(err => console.error('Admin guest refund email error (non-blocking):', err.message));
          }
        }
      }).catch(err => console.error('Admin list error for guest refund email (non-blocking):', err.message));

    return reply.status(201).send({
      success: true,
      message: `${ticketTitle} submitted successfully`,
      request: {
        id:             supportTicket.id,
        orderId,
        orderDisplayId: `#${order.displayId}`,
        requestType:    normalizedRequestType,
        reason:         headlineReason,
        requestedItems: itemsBlob,
        attachments:    allAttachments,
        guestEmail:     normalizedEmail,
        status:         'OPEN',
        createdAt:      supportTicket.createdAt
      }
    });
  } catch (error) {
    console.error('Guest refund request error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// GUEST — TRACK REFUND REQUESTS BY ORDER + EMAIL
exports.getGuestRefundRequests = async (request, reply) => {
  try {
    const { orderId: displayId, customerEmail } = request.query;

    if (!displayId || !customerEmail) {
      return reply.status(400).send({
        success: false,
        message: 'orderId and customerEmail are required'
      });
    }

    const normalizedEmail = customerEmail.trim().toLowerCase();
    const order = await prisma.order.findUnique({ where: { displayId } });

    if (!order) {
      return reply.status(404).send({ success: false, message: 'Order not found' });
    }

    if (order.userId) {
      return reply.status(400).send({
        success: false,
        message: 'This endpoint is for guest orders only'
      });
    }

    if ((order.customerEmail || '').trim().toLowerCase() !== normalizedEmail) {
      return reply.status(403).send({ success: false, message: 'Email does not match order' });
    }

    const orderId = order.id; // resolve to internal CUID

    const requests = await prisma.supportTicket.findMany({
      where: {
        category: 'REFUND_REQUEST',
        orderId,
        guestEmail: normalizedEmail
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderId: true,
        guestEmail: true,
        requestType: true,
        subject: true,
        message: true,
        status: true,
        priority: true,
        response: true,
        createdAt: true,
        updatedAt: true
      }
    });

    const formattedRequests = requests.map(t =>
      formatRefundRequestFromTicket(t, order.displayId)
    );

    return reply.status(200).send({
      success: true,
      requests: formattedRequests,
      count: formattedRequests.length
    });
  } catch (error) {
    console.error('Get guest refund requests error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// GUEST — TRACK SINGLE REFUND REQUEST BY REQUEST ID + ORDER + EMAIL
exports.getGuestRefundRequestById = async (request, reply) => {
  try {
    const { requestId } = request.params;
    const { orderId: displayId, customerEmail } = request.query;

    if (!displayId || !customerEmail) {
      return reply.status(400).send({
        success: false,
        message: 'orderId and customerEmail are required'
      });
    }

    const normalizedEmail = customerEmail.trim().toLowerCase();
    const order = await prisma.order.findUnique({ where: { displayId } });

    if (!order) {
      return reply.status(404).send({ success: false, message: 'Order not found' });
    }

    if (order.userId) {
      return reply.status(400).send({
        success: false,
        message: 'This endpoint is for guest orders only'
      });
    }

    if ((order.customerEmail || '').trim().toLowerCase() !== normalizedEmail) {
      return reply.status(403).send({ success: false, message: 'Email does not match order' });
    }

    const orderId = order.id; // resolve to internal CUID

    const ticket = await prisma.supportTicket.findFirst({
      where: {
        id: requestId,
        category: 'REFUND_REQUEST',
        orderId,
        guestEmail: normalizedEmail
      },
      select: {
        id: true,
        orderId: true,
        guestEmail: true,
        requestType: true,
        subject: true,
        message: true,
        status: true,
        priority: true,
        response: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!ticket) {
      return reply.status(404).send({
        success: false,
        message: 'Refund request not found'
      });
    }

    return reply.status(200).send({
      success: true,
      request: formatRefundRequestFromTicket(ticket, order.displayId)
    });
  } catch (error) {
    console.error('Get guest refund request by id error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// USER — REORDER (Add all items from previous order to cart)
exports.reorder = async (request, reply) => {
  try {
    const displayId = request.params.id;
    const userId = request.user.userId;

    // Get the order with items
    const order = await prisma.order.findUnique({
      where: { displayId },
      include: {
        items: {
          include: {
            product: true
          }
        }
      }
    });

    if (!order) {
      return reply.status(404).send({ success: false, message: "Order not found" });
    }

    if (order.userId !== userId) {
      return reply.status(403).send({ success: false, message: "Not authorized to reorder this order" });
    }

    const orderId = order.id; // resolve to internal CUID (used later for cart ops)
    void orderId; // suppress unused variable warning — orderId kept for any extensions

    if (order.items.length === 0) {
      return reply.status(400).send({ success: false, message: "Order has no items to reorder" });
    }

    // Get or create user's cart
    let cart = await prisma.cart.findUnique({
      where: { userId },
      include: {
        items: true
      }
    });

    console.log(`📋 Found existing cart for user ${userId}:`, cart ? `Cart ID: ${cart.id}, Items: ${cart.items.length}` : 'No cart found');

    if (!cart) {
      cart = await prisma.cart.create({
        data: { userId },
        include: {
          items: true
        }
      });
      console.log(`🆕 Created new cart for user ${userId}: Cart ID: ${cart.id}`);
    }

    const addedItems = [];
    const unavailableItems = [];
    
    // Process each item from the order
    for (const orderItem of order.items) {
      const product = orderItem.product;
      
      // Check if product still exists and is available
      if (!product) {
        unavailableItems.push({
          productId: orderItem.productId,
          reason: "Product no longer exists"
        });
        continue;
      }

      // Check stock availability
      if (product.stock < orderItem.quantity) {
        unavailableItems.push({
          productId: product.id,
          title: product.title,
          requestedQuantity: orderItem.quantity,
          availableStock: product.stock,
          reason: "Insufficient stock"
        });
        continue;
      }

      // Check if item already exists in cart
      const existingCartItem = await prisma.cartItem.findFirst({
        where: {
          cartId: cart.id,
          productId: product.id
        }
      });

      console.log(`🔍 Checking product ${product.id} (${product.title}) in cart:`, existingCartItem ? `Found existing item with quantity ${existingCartItem.quantity}` : 'Not in cart');

      if (existingCartItem) {
        // Update existing cart item quantity
        const newQuantity = existingCartItem.quantity + orderItem.quantity;
        
        // Check if new quantity exceeds stock
        if (newQuantity > product.stock) {
          unavailableItems.push({
            productId: product.id,
            title: product.title,
            requestedQuantity: orderItem.quantity,
            currentCartQuantity: existingCartItem.quantity,
            availableStock: product.stock,
            reason: "Adding this quantity would exceed available stock"
          });
          continue;
        }

        const updatedItem = await prisma.cartItem.update({
          where: {
            id: existingCartItem.id
          },
          data: {
            quantity: newQuantity
          }
        });

        console.log(`📝 Updated cart item: Product ${product.id}, New quantity: ${updatedItem.quantity}`);

        addedItems.push({
          productId: product.id,
          title: product.title,
          quantity: orderItem.quantity,
          newTotalQuantity: newQuantity,
          action: "updated"
        });
      } else {
        // Create new cart item
        const newCartItem = await prisma.cartItem.create({
          data: {
            cartId: cart.id,
            productId: product.id,
            quantity: orderItem.quantity
          }
        });

        console.log(`➕ Created new cart item: Product ${product.id} (${product.title}), Quantity: ${newCartItem.quantity}, Cart Item ID: ${newCartItem.id}`);

        addedItems.push({
          productId: product.id,
          title: product.title,
          quantity: orderItem.quantity,
          action: "added"
        });
      }
    }

    console.log(`✅ Reorder processed for order ${orderId} - Added: ${addedItems.length}, Unavailable: ${unavailableItems.length}`);

    // Verify final cart state
    const finalCart = await prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                title: true
              }
            }
          }
        }
      }
    });

    console.log(`🛒 Final cart verification for user ${userId}:`, finalCart ? 
      `Cart ID: ${finalCart.id}, Total items: ${finalCart.items.length}` : 'Cart not found');
    
    if (finalCart && finalCart.items.length > 0) {
      console.log('📦 Cart contents:', finalCart.items.map(item => 
        `${item.product.title} (ID: ${item.productId}) - Qty: ${item.quantity}`
      ));
    }

    return reply.status(200).send({
      success: true,
      message: addedItems.length > 0 
        ? `Successfully added ${addedItems.length} items to cart for reorder`
        : "No items could be added to cart",
      data: {
        orderId,
        addedItems,
        unavailableItems,
        summary: {
          totalOrderItems: order.items.length,
          successfullyAdded: addedItems.length,
          unavailable: unavailableItems.length
        },
        debug: {
          cartId: finalCart?.id,
          finalCartItemCount: finalCart?.items.length || 0
        }
      }
    });

  } catch (error) {
    console.error("Reorder error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// GUEST CHECKOUT — route removed. No COD. Guests use Stripe via POST /api/payments/guest/create-intent.
// This function is intentionally unreachable via any route.
exports.createGuestOrder = async (request, reply) => {
  try {
    const { 
      items, // Array of { productId, quantity }
      customerName, 
      customerEmail, 
      customerPhone,
      shippingAddress,
      paymentMethod,
      shippingMethodId,     // Required for Australia (domestic) shipping
      internationalCountry, // Required for international shipping (mutually exclusive with shippingMethodId)
      gstId,
      country,
      city,
      zipCode,
      state,
      mobileNumber,
      couponCode            // Optional coupon code
    } = request.body;

    // Treat the order as international when either internationalCountry or the top-level
    // country field is non-Australia. This covers frontends that store the destination
    // country in the address object (as 'country') rather than a separate param.
    const effectiveIntlCountry = (internationalCountry || country || '').trim();
    const isInternational = !!effectiveIntlCountry && effectiveIntlCountry.toLowerCase() !== 'australia';

    // Validation
    if (!items || items.length === 0) {
      return reply.status(400).send({ success: false, message: "Order items are required" });
    }

    if (!customerName || !customerEmail || !customerPhone) {
      return reply.status(400).send({ success: false, message: "Customer name, email, and phone are required" });
    }

    if (!shippingAddress || !paymentMethod || (!shippingMethodId && !isInternational)) {
      return reply.status(400).send({ success: false, message: "Shipping address, payment method, and shipping method (or international country) are required" });
    }

    // Validate international country
    let intlZoneEntry = null;
    let shippingMethod = null;

    if (isInternational) {
      const intlCountry = effectiveIntlCountry;
      intlZoneEntry = lookupZone(intlCountry);
      shippingMethod = {
        id: null,
        name: `International (${intlCountry})`,
        cost: intlZoneEntry.cost,
        estimatedDays: '10-20 business days',
        zone: intlZoneEntry.zone,
        zoneName: intlZoneEntry.label,
        country: intlCountry
      };
    }

    // state and country are optional for now (will be required after migration)

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(customerEmail)) {
      return reply.status(400).send({ success: false, message: "Invalid email address" });
    }

    let sellerNotifications = new Map();
    const orderItems = [];
    const cartItems = []; // Build cart-like structure for calculations

    // Process each item in the order
    for (const item of items) {
      const { productId, quantity } = item;

      if (!productId || !quantity || quantity < 1) {
        return reply.status(400).send({ success: false, message: "Invalid item in order" });
      }

      // Fetch product
      const product = await prisma.product.findUnique({
        where: { id: productId }
      });

      if (!product) {
        return reply.status(404).send({ success: false, message: `Product ${productId} not found` });
      }

      // Check stock
      if (product.stock < quantity) {
        return reply.status(400).send({
          success: false,
          message: `Insufficient stock for product: ${product.title}`
        });
      }

      const itemPrice = Number(product.price);

      orderItems.push({
        productId: product.id,
        quantity,
        price: itemPrice
      });

      // Build cart-like structure for total calculations
      cartItems.push({
        product: product,
        quantity: quantity
      });

      // Track seller products for notification
      if (!sellerNotifications.has(product.sellerId)) {
        sellerNotifications.set(product.sellerId, {
          productCount: 0,
          totalAmount: 0,
          products: [],
          sellerName: product.sellerName || null  // stored at product creation time
        });
      }
      const sellerData = sellerNotifications.get(product.sellerId);
      // Keep the most recent non-null sellerName we see
      if (product.sellerName && !sellerData.sellerName) sellerData.sellerName = product.sellerName;
      sellerData.productCount += quantity;
      sellerData.totalAmount += itemPrice * quantity;
      sellerData.products.push({
        productId: product.id,
        title: product.title,
        quantity,
        price: itemPrice
      });
    }

    // Calculate proper totals including shipping and GST
    const cartCalculations = await calculateCartTotals(
      cartItems,
      isInternational ? null : shippingMethodId,
      gstId,
      isInternational ? intlZoneEntry.cost : null
    );

    // Get domestic shipping method details (international already resolved above)
    if (!isInternational) {
      const domesticMethod = await prisma.shippingMethod.findUnique({
        where: { id: shippingMethodId, isActive: true }
      });
      if (!domesticMethod) {
        return reply.status(400).send({ success: false, message: "Invalid or inactive shipping method" });
      }
      shippingMethod = domesticMethod;
    }

    const originalTotal = parseFloat(cartCalculations.grandTotal);

    // ── Coupon validation (server-side) ──────────────────────────────────────
    let appliedCoupon = null;
    let couponModel   = null; // 'seller' | 'legacy'
    let discountAmount = 0;

    if (couponCode) {
      const upper   = couponCode.toUpperCase();
      const gstRate = parseFloat(cartCalculations.gstPercentage) || 0;

      // Try seller coupon first
      const sellerCoupon = await prisma.sellerCoupon.findUnique({ where: { code: upper } });

      if (sellerCoupon && !sellerCoupon.softDeletedAt) {
        if (!sellerCoupon.isActive) {
          return reply.status(400).send({ success: false, message: 'This coupon is no longer active' });
        }
        if (new Date() > sellerCoupon.expiresAt) {
          return reply.status(400).send({ success: false, message: 'Coupon has expired' });
        }
        if (sellerCoupon.usageLimit !== null && sellerCoupon.usageCount >= sellerCoupon.usageLimit) {
          return reply.status(400).send({ success: false, message: 'Coupon usage limit has been reached' });
        }
        discountAmount = _calcSellerCouponDiscount(sellerCoupon, cartItems, gstRate);
        appliedCoupon  = sellerCoupon;
        couponModel    = 'seller';
      } else {
        // Fall back to legacy (admin) coupon
        const legacyCoupon = await prisma.coupon.findUnique({ where: { code: upper } });

        if (!legacyCoupon) {
          return reply.status(400).send({ success: false, message: 'Invalid coupon code' });
        }
        if (!legacyCoupon.isActive) {
          return reply.status(400).send({ success: false, message: 'This coupon is no longer active' });
        }
        if (new Date() > legacyCoupon.expiresAt) {
          return reply.status(400).send({ success: false, message: 'Coupon has expired' });
        }
        if (legacyCoupon.usageLimit !== null && legacyCoupon.usageCount >= legacyCoupon.usageLimit) {
          return reply.status(400).send({ success: false, message: 'Coupon usage limit has been reached' });
        }
        if (legacyCoupon.minCartValue !== null && originalTotal < legacyCoupon.minCartValue) {
          return reply.status(400).send({
            success: false,
            message: `Minimum cart value of $${legacyCoupon.minCartValue.toFixed(2)} required for this coupon`
          });
        }

        if (legacyCoupon.discountType === 'percentage') {
          discountAmount = parseFloat(((originalTotal * legacyCoupon.discountValue) / 100).toFixed(2));
          if (legacyCoupon.maxDiscount !== null) {
            discountAmount = Math.min(discountAmount, legacyCoupon.maxDiscount);
          }
        } else {
          discountAmount = Math.min(legacyCoupon.discountValue, originalTotal);
        }

        appliedCoupon = legacyCoupon;
        couponModel   = 'legacy';
      }
    }

    const totalAmount = parseFloat((originalTotal - discountAmount).toFixed(2));
    // ─────────────────────────────────────────────────────────────────────────

    // Generate short alphanumeric display ID for the customer
    const displayId = await generateDisplayId();

    // Create order using transaction
    const order = await prisma.$transaction(async (tx) => {
      // Deduct stock — re-validate inside the transaction to prevent race conditions
      for (const item of orderItems) {
        // Atomic decrement only if sufficient stock exists
        const result = await tx.$executeRaw`
          UPDATE "products"
          SET stock = stock - ${item.quantity}
          WHERE id = ${item.productId} AND stock >= ${item.quantity}
        `;
        if (result === 0) {
          const current = await tx.product.findUnique({
            where: { id: item.productId },
            select: { title: true, stock: true }
          });
          throw new Error(
            `Insufficient stock for "${current?.title ?? item.productId}". Available: ${current?.stock ?? 0}, Requested: ${item.quantity}`
          );
        }
      }

      // Increment coupon usageCount inside the transaction (atomic)
      if (appliedCoupon) {
        if (couponModel === 'seller') {
          await tx.sellerCoupon.update({
            where: { id: appliedCoupon.id },
            data: { usageCount: { increment: 1 } }
          });
        } else {
          await tx.coupon.update({
            where: { id: appliedCoupon.id },
            data: { usageCount: { increment: 1 } }
          });
        }
      }

      // Create order without userId (guest order) with shipping/GST details
      const newOrder = await tx.order.create({
        data: {
          displayId,
          totalAmount,
          originalTotal,
          couponCode: appliedCoupon ? appliedCoupon.code : null,
          discountAmount: discountAmount > 0 ? discountAmount : null,
          shippingAddress: typeof shippingAddress === 'string' ? { address: shippingAddress } : {
            ...shippingAddress,
            // Include order breakdown for invoice purposes
            orderSummary: {
              subtotal: cartCalculations.subtotal,
              shippingCost: cartCalculations.shippingCost,
              totalShippingCost: cartCalculations.totalShippingCost,
              sellerCount: cartCalculations.sellerCount,
              gstPercentage: cartCalculations.gstPercentage,
              gstAmount: cartCalculations.gstAmount,
              grandTotal: cartCalculations.grandTotal,
              couponCode: appliedCoupon ? appliedCoupon.code : null,
              discountAmount,
              finalTotal: totalAmount,
              shippingMethod: {
                id: shippingMethod.id,
                name: shippingMethod.name,
                cost: shippingMethod.cost,
                estimatedDays: shippingMethod.estimatedDays
              },
              gstDetails: cartCalculations.gstDetails
            }
          },
          shippingAddressLine: typeof shippingAddress === 'string' ? shippingAddress : shippingAddress?.addressLine,
          shippingCity: city,
          shippingState: state,
          shippingZipCode: zipCode,
          shippingCountry: country,
          shippingPhone: mobileNumber || customerPhone,
          paymentMethod,
          status: "CONFIRMED",
          customerName,
          customerEmail,
          customerPhone: mobileNumber || customerPhone || '',
          items: {
            create: orderItems
          }
        },
        include: {
          items: {
            include: {
              product: true
            }
          }
        }
      });

      return newOrder;
    });

    console.log(`✅ Guest order created: ${order.id}`);

    // Check for low stock on all ordered products and deactivate + alert if <= 2
    handleLowStockAlerts(orderItems.map(i => i.productId));

    // Get seller names (DB lookup for accurate name) + product titles
    const guestSellerIdList = [...sellerNotifications.keys()];
    const guestSellerNameMap = new Map();
    await Promise.all(guestSellerIdList.map(async sid => {
      const s = await prisma.user.findUnique({
        where: { id: sid },
        select: { name: true, sellerProfile: { select: { storeName: true, businessName: true } } }
      });
      guestSellerNameMap.set(sid, s?.name || s?.sellerProfile?.storeName || s?.sellerProfile?.businessName || 'Unknown');
    }));
    const guestSellerNameList = [...guestSellerNameMap.values()];
    const guestAllProductTitles = [];
    for (const [, sellerData] of sellerNotifications) {
      if (sellerData.products) {
        guestAllProductTitles.push(...sellerData.products.map(p => p.title).filter(Boolean));
      }
    }

    // Create notifications
    const orderNotificationData = {
      customerName,
      sellerName: guestSellerNameList.length > 0 ? guestSellerNameList.join(', ') : 'Unknown',
      totalAmount: totalAmount.toFixed(2),
      itemCount: order.items.length,
      productNames: guestAllProductTitles,
      orderId: order.id
    };

    // Notify admins about new guest order
    notifyAdminNewOrder(order.id, orderNotificationData).catch(error => {
      console.error("Admin notification error (non-blocking):", error.message);
    });

    // Notify each seller about the new guest order (fired before reply — guaranteed delivery)
    for (const [sellerId, sellerData] of sellerNotifications) {
      notifySellerNewOrder(sellerId, order.id, {
        customerName,
        totalAmount: sellerData.totalAmount.toFixed(2),
        itemCount: sellerData.productCount,
        productNames: sellerData.products.map(p => p.title).filter(Boolean)
      }).catch(error => {
        console.error(`Seller order notification error (sellerId=${sellerId}):`, error.message);
      });
    }
    // Guest orders: no in-app customer notification (guest has no user account / userId)
    // Guest receives email confirmation instead.

    // ── Fire all emails & notifications in background (non-blocking) ────────
    ;(async () => {
      try {
        // 1. Guest customer confirmation email (invoice download button is in the email)
        console.log(`📧 Sending order confirmation email to guest customer: ${customerEmail}`);
        try {
          const guestEmailResult = await sendOrderConfirmationEmail(customerEmail, customerName, {
            displayId: order.displayId,
            totalAmount,
            itemCount: order.items.length,
            products: order.items.map(item => ({
              title: item.product?.title || 'Product',
              quantity: item.quantity,
              price: item.price
            })),
            shippingAddress,
            paymentMethod,
            customerPhone,
            isGuest: true,
            orderSummary: {
              subtotal: cartCalculations.subtotal,
              subtotalExGST: cartCalculations.subtotalExGST,
              shippingCost: cartCalculations.totalShippingCost,
              gstPercentage: cartCalculations.gstPercentage,
              gstAmount: cartCalculations.gstAmount,
              grandTotal: cartCalculations.grandTotal,
              couponCode: appliedCoupon ? appliedCoupon.code : null,
              discountAmount: discountAmount > 0 ? discountAmount : null,
              shippingMethod: {
                name: shippingMethod.name,
                cost: shippingMethod.cost,
                estimatedDays: shippingMethod.estimatedDays
              }
            }
          });
          if (guestEmailResult?.success) {
            console.log(`✅ Guest order confirmation email sent to ${customerEmail}`);
          } else {
            console.error(`❌ Guest order confirmation email failed for ${customerEmail}:`, guestEmailResult?.error);
          }
        } catch (emailErr) {
          console.error(`❌ Guest order confirmation email error for ${customerEmail}:`, emailErr.message);
        }

        // 1.5. Send guest order confirmation to super admins as well
        try {
          const superAdmins = await prisma.user.findMany({
            where: { role: 'SUPER_ADMIN' },
            select: { email: true, name: true }
          });
          for (const admin of superAdmins) {
            if (admin.email) {
              try {
                const adminGuestConfirmResult = await sendOrderConfirmationEmail(admin.email, admin.name || 'Super Admin', {
                  displayId: order.displayId,
                  totalAmount,
                  itemCount: order.items.length,
                  products: order.items.map(item => ({
                    title: item.product?.title || 'Product',
                    quantity: item.quantity,
                    price: item.price
                  })),
                  shippingAddress,
                  paymentMethod,
                  customerPhone,
                  customerName,
                  customerEmail,
                  isSuperAdminCopy: true,
                  isGuest: true,
                  orderSummary: {
                    subtotal: cartCalculations.subtotal,
                    subtotalExGST: cartCalculations.subtotalExGST,
                    shippingCost: cartCalculations.totalShippingCost,
                    gstPercentage: cartCalculations.gstPercentage,
                    gstAmount: cartCalculations.gstAmount,
                    grandTotal: cartCalculations.grandTotal,
                    couponCode: appliedCoupon ? appliedCoupon.code : null,
                    discountAmount: discountAmount > 0 ? discountAmount : null,
                    shippingMethod: {
                      name: shippingMethod.name,
                      cost: shippingMethod.cost,
                      estimatedDays: shippingMethod.estimatedDays
                    }
                  }
                });
                if (adminGuestConfirmResult?.success) {
                  console.log(`✅ Super admin guest order confirmation sent to ${admin.email}`);
                } else {
                  console.error(`❌ Super admin guest order confirmation failed for ${admin.email}:`, adminGuestConfirmResult?.error);
                }
              } catch (adminEmailErr) {
                console.error(`❌ Super admin guest order confirmation error for ${admin.email}:`, adminEmailErr.message);
              }
            }
          }
        } catch (adminListErr) {
          console.error('Error fetching super admins for guest order confirmation:', adminListErr.message);
        }

        // 2. Seller emails + SLA notifications — all DB lookups in parallel
        await Promise.all([...sellerNotifications.entries()].map(async ([sellerId, sellerData]) => {
          try {
            const seller = await prisma.user.findUnique({
              where: { id: sellerId },
              include: { sellerProfile: true }
            });
            if (seller) {
              createOrderNotification(order.id, sellerId, 'ORDER_PROCESSING', 'HIGH', {
                message: `New guest order received from ${customerName}`,
                notes: `${sellerData.productCount} item(s), Total: $${sellerData.totalAmount.toFixed(2)}`
              }).catch(e => console.error("SLA notification error:", e.message));
            }
            if (seller && seller.email) {
              const sellerName = seller.sellerProfile?.storeName || seller.sellerProfile?.businessName || seller.name || 'Seller';
              console.log(`📧 Sending order notification email to seller: ${seller.email}`);
              try {
                const sellerEmailResult = await sendSellerOrderNotificationEmail(seller.email, sellerName, {
                  displayId: order.displayId,
                  productCount: sellerData.productCount,
                  totalAmount: sellerData.totalAmount,
                  products: sellerData.products,
                  shippingAddress,
                  paymentMethod,
                  customerName,
                  customerEmail,
                  customerPhone,
                  isGuest: true
                });
                if (sellerEmailResult?.success) {
                  console.log(`✅ Guest seller order email sent to ${seller.email}`);
                } else {
                  console.error(`❌ Guest seller order email failed for ${seller.email}:`, sellerEmailResult?.error);
                }
              } catch (emailErr) {
                console.error(`❌ Guest seller order email error for ${seller.email}:`, emailErr.message);
              }
            } else {
              console.warn(`⚠️  No email for seller ${sellerId} — guest order email skipped`);
            }
          } catch (err) {
            console.error(`Error notifying seller ${sellerId}:`, err.message);
          }
        }));

        // 3. Admin order emails for guest orders
        console.log('🔍 Attempting to send super admin notifications for guest order...');
        try {
          const admins = await prisma.user.findMany({
            where: { role: 'SUPER_ADMIN' },
            select: { email: true, name: true }
          });
          console.log(`📋 Found ${admins.length} super admins for guest order:`, admins.map(a => a.email));
          
          const guestSellerNames = [...sellerNotifications.keys()]
            .map(sid => guestSellerNameMap?.get(sid) || 'Unknown')
            .filter(Boolean)
            .join(', ');
          const allItems = order.items.map(item => ({
            title: item.product?.title || item.productId,
            quantity: item.quantity,
            price: item.price
          }));
          
          for (const admin of admins) {
            if (admin.email) {
              console.log(`📧 Sending guest admin order email to: ${admin.email}`);
              try {
                const adminEmailResult = await sendAdminNewOrderEmail(admin.email, admin.name || 'Admin', {
                  displayId: order.displayId,
                  customerName,
                  customerEmail,
                  customerPhone,
                  sellerNames: guestSellerNames || 'Unknown',
                  totalAmount,
                  paymentMethod,
                  items: allItems
                });
                if (adminEmailResult?.success) {
                  console.log(`✅ Admin guest order email sent to ${admin.email}`);
                } else {
                  console.error(`❌ Admin guest order email failed for ${admin.email}:`, adminEmailResult?.error);
                }
              } catch (adminEmailErr) {
                console.error(`❌ Admin guest order email error for ${admin.email}:`, adminEmailErr.message);
              }
            }
          }
        } catch (adminEmailListErr) {
          console.error('Error fetching admins for guest order email:', adminEmailListErr.message);
        }
      } catch (bgErr) {
        console.error('Background notification error (guest):', bgErr.message);
      }
    })();

    return reply.status(200).send({
      success: true,
      message: "Guest order placed successfully! Confirmation email sent.",
      orderId: order.id,
      displayId: order.displayId,
      orderSummary: {
        subtotal: cartCalculations.subtotal,
        subtotalExGST: cartCalculations.subtotalExGST,
        shippingCost: cartCalculations.shippingCost,
        totalShippingCost: cartCalculations.totalShippingCost,
        sellerCount: cartCalculations.sellerCount,
        gstPercentage: cartCalculations.gstPercentage,
        gstAmount: cartCalculations.gstAmount,
        originalTotal: originalTotal.toFixed(2),
        couponCode: appliedCoupon ? appliedCoupon.code : null,
        discountAmount: discountAmount > 0 ? discountAmount.toFixed(2) : null,
        totalAmount: totalAmount.toFixed(2),
        shippingMethod: {
          name: shippingMethod.name,
          estimatedDays: shippingMethod.estimatedDays
        }
      },
      customerEmail
    });

  } catch (error) {
    console.error("Create guest order error:", error);
    if (error.message && error.message.startsWith("Insufficient stock")) {
      return reply.status(400).send({ success: false, message: error.message });
    }
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// GUEST — TRACK ORDER by Order ID and Email
// Tracks any order by display ID + customer email — works for both guests and registered users.
exports.trackGuestOrder = async (request, reply) => {
  try {
    const { orderId: displayId, customerEmail } = request.query;

    if (!displayId || !customerEmail) {
      return reply.status(400).send({ success: false, message: "Order ID and customer email are required" });
    }

    const order = await prisma.order.findUnique({
      where: { displayId },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                title: true,
                featuredImage: true,
                price: true,
                type: true
              }
            },
            productVariant: {
              include: {
                variantAttributeValues: {
                  include: {
                    attributeValue: {
                      include: {
                        attribute: true
                      }
                    }
                  }
                }
              }
            }
          }
        },
        subOrders: {
          include: {
            items: {
              include: {
                product: {
                  select: {
                    id: true,
                    title: true,
                    featuredImage: true,
                    price: true,
                    type: true
                  }
                },
                productVariant: {
                  include: {
                    variantAttributeValues: {
                      include: {
                        attributeValue: {
                          include: {
                            attribute: true
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            seller: {
              select: { id: true, name: true }
            }
          }
        }
      }
    });

    if (!order) {
      return reply.status(404).send({ success: false, message: "Order not found" });
    }

    // Verify customer email matches — works for guests and registered users alike
    if (order.customerEmail?.toLowerCase() !== customerEmail?.toLowerCase()) {
      return reply.status(403).send({ success: false, message: "Email does not match order" });
    }

    // Helper to format item with variant data
    const formatOrderItem = (item, sellerName = null) => {
      const variantAttributes = formatVariantAttributes(item.productVariant);
      const displayTitle = variantAttributes?.length 
        ? `${item.product?.title} (${variantAttributes.map(a => `${a.name}: ${a.displayValue || a.value}`).join(', ')})`
        : (item.product?.title || 'Product');

      // Extract common variant attributes as direct properties for easy frontend access
      const directVariantProps = {};
      if (variantAttributes?.length) {
        variantAttributes.forEach(attr => {
          const key = attr.name.toLowerCase(); // size, color, style, etc.
          directVariantProps[key] = attr.displayValue || attr.value;
        });
      }

      return {
        id: item.id,
        quantity: item.quantity,
        price: item.price,
        variantId: item.variantId,
        ...directVariantProps, // ✅ Direct properties: size, color, etc.
        ...(sellerName && { sellerName }),
        product: {
          id: item.product?.id || null,
          title: item.product?.title || 'Product',
          displayTitle,
          featuredImage: item.product?.featuredImage || null,
          price: item.product?.price || item.price,
          type: item.product?.type
        },
        variant: item.productVariant ? {
          id: item.productVariant.id,
          price: item.productVariant.price,
          sku: item.productVariant.sku,
          stock: item.productVariant.stock,
          images: item.productVariant.images || [],
          attributes: variantAttributes
        } : null
      };
    };

    const isMultiSeller = order.orderType === 'MULTI_SELLER' ||
      (Array.isArray(order.subOrders) && order.subOrders.length > 0);

    // Shape sub-orders into a clean structure the frontend can consume directly
    const shapedSubOrders = isMultiSeller
      ? order.subOrders.map((sub, index) => ({
          id: sub.id,
          subDisplayId: sub.subDisplayId || `${order.displayId}-${String.fromCharCode(65 + index)}`,
          status: sub.status,
          trackingNumber: sub.trackingNumber || null,
          estimatedDelivery: sub.estimatedDelivery || null,
          subtotal: sub.subtotal,
          seller: {
            id: sub.seller?.id || null,
            name: sub.seller?.name || 'Unknown Seller'
          },
          items: sub.items.map(item => formatOrderItem(item))
        }))
      : undefined;

    // For MULTI_SELLER orders, items live on sub-orders — flatten for top-level items field
    const resolvedItems = isMultiSeller
      ? order.subOrders.flatMap(sub =>
          sub.items.map(item => formatOrderItem(item, sub.seller?.name || 'Unknown Seller'))
        )
      : order.items.map(item => formatOrderItem(item));

    // Extract orderSummary from the stored shippingAddress JSON blob (kept for legacy storage)
    const storedShipping = order.shippingAddress || {};
    const orderSummary = storedShipping.orderSummary || null;

    return reply.status(200).send({ 
      success: true, 
      order: {
        id: order.id,
        displayId: order.displayId,
        orderType: order.orderType,
        status: order.status || order.overallStatus,
        totalAmount: order.totalAmount,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        shippingAddress: {
          addressLine: order.shippingAddressLine,
          city: order.shippingCity,
          state: order.shippingState,
          zipCode: order.shippingZipCode,
          country: order.shippingCountry,
          phone: order.shippingPhone
        },
        orderSummary,
        // For MULTI_SELLER, tracking lives per sub-order; top-level is null
        trackingNumber: isMultiSeller ? null : (order.trackingNumber || null),
        estimatedDelivery: isMultiSeller ? null : (order.estimatedDelivery || null),
        items: resolvedItems,
        subOrders: shapedSubOrders,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt
      }
    });

  } catch (error) {
    console.error("Track order error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// Strip / replace characters outside Latin-1 that PDFKit built-in fonts cannot render.
const sanitizeForPDF = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/[‘’‚‛]/g, "'")  // smart single quotes
    .replace(/[“”„‟]/g, '"')  // smart double quotes
    .replace(/[–—]/g, '-')               // en-dash / em-dash
    .replace(/…/g, '...')                     // ellipsis
    .replace(/ /g, ' ')                       // non-breaking space
    .replace(/[^\x00-\xFF]/g, '');                 // strip anything above Latin-1
};

// ─── Invoice PDF Helper ────────────────────────────────────────────
// Accepts a unified order shape. Handles MULTI_SELLER (order.subOrders[]),
// sub-order specific (order.sellerName set, flat order.items), and legacy/direct.
// For multi-seller orders a separate A4 page is generated per seller in one PDF.
// Place your logo at:  <project-root>/assets/logo.png
const generateInvoiceBuffer = (order) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Brand colours
    const BRAND       = '#5A1E12';
    const BRAND_MID   = '#7D2E1E';
    const BRAND_LIGHT = '#F9EDE9';
    const L = 50;           // left x
    const R = 545;          // right x (595 - 50)
    const PAGE_H = doc.page.height;   // A4 = 841.89 pt
    // PDFKit autopage triggers at PAGE_H - margin(50) = ~791.89
    // Footer needs 2 lines of text: keep it well inside that limit
    const FOOTER_Y     = PAGE_H - 96; // divider line here → 3 footer lines fit safely under 791pt limit
    const MAX_CONTENT_Y = FOOTER_Y - 30; // items/summary must not pass this

    // Logo (optional) — place file at <project-root>/assets/logo.png
    const logoPath = path.join(__dirname, '../assets/logo.png');
    const hasLogo  = fs.existsSync(logoPath);

    const displayRef = order.displayId != null ? `${order.displayId}` : (order.id || 'N/A');

    // Per-seller shipping & GST rate from the orderSummary stored in shippingAddress JSON
    const storedSummary = (typeof order.shippingAddress === 'object' && order.shippingAddress?.orderSummary)
      ? order.shippingAddress.orderSummary
      : null;
    // Guest orders have no sub-orders — one invoice page covers ALL sellers, so use the
    // total shipping cost. Authenticated multi-seller orders have one page per seller,
    // so use the per-seller rate (each seller's page shows their own $20, etc.).
    const orderHasSubOrders = Array.isArray(order.subOrders) && order.subOrders.length > 0;
    const perSellerShipping = storedSummary
      ? parseFloat((orderHasSubOrders ? storedSummary.shippingCost : storedSummary.totalShippingCost) || 0)
      : 0;
    const gstRate = parseFloat(storedSummary?.gstPercentage || 10); // default AU GST 10%

    // ── Status stamp helpers ──────────────────────────────────────────────
    const terminalStatus = order._resolvedStatus || order.overallStatus || order.status || '';
    const isRefunded   = ['REFUND', 'PARTIAL_REFUND'].includes(terminalStatus);
    const isCancelled  = terminalStatus === 'CANCELLED';
    const stampText    = isRefunded ? 'REFUNDED' : isCancelled ? 'CANCELLED' : null;
    const stampColor   = isRefunded ? '#1565C0' : '#C62828'; // blue for refund, red for cancel

    const drawStatusStamp = () => {
      if (!stampText) return;
      doc.save();
      doc.translate(doc.page.width / 2, doc.page.height / 2);
      doc.rotate(-45);
      doc.fontSize(72).font('Helvetica-Bold')
         .fillOpacity(0.12).fillColor(stampColor)
         .text(stampText, -200, -40, { width: 400, align: 'center', lineBreak: false });
      doc.fillOpacity(1);
      doc.restore();
    };

    // ── Helper: draw a complete invoice page for one seller ───────────────
    // showOrderDiscount: true only on the last page (or single-seller) — coupon is order-level
    const formatABN = (abn) => {
      const d = String(abn).replace(/\D/g, '');
      return d.length === 11 ? `${d.slice(0,2)} ${d.slice(2,5)} ${d.slice(5,8)} ${d.slice(8)}` : abn;
    };

    const drawPage = (sellerName, sellerAbn, sellerAddress, items, showOrderDiscount = true) => {
      // Border — stays within the page
      doc.rect(18, 18, R - L + 64, PAGE_H - 36).lineWidth(1.5).stroke(BRAND);

      let y = 42;

      // ── Header: logo (left) + INVOICE title (right) ──
      if (hasLogo) {
        try { doc.image(logoPath, L, y, { height: 52 }); } catch (_) { /* skip if image fails */ }
      }
      doc.fillColor(BRAND).fontSize(22).font('Helvetica-Bold')
         .text('INVOICE', L, y, { align: 'right', width: R - L });
      doc.fillColor(BRAND_MID).fontSize(9.5).font('Helvetica')
         .text('Made in Arnhem Land', L, y + 27, { align: 'right', width: R - L });
      y += 64;

      // Header divider
      doc.moveTo(L, y).lineTo(R, y).lineWidth(2).stroke(BRAND);
      y += 12;

      // ── Status stamp (watermark) for refunded / cancelled orders ──
      drawStatusStamp();

      // ── Status badge (solid pill) shown below divider ──
      if (stampText) {
        const badgeW = 100;
        const badgeH = 18;
        const badgeX = R - badgeW;
        const badgeY = y;
        doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 4).fill(stampColor);
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
           .text(stampText, badgeX, badgeY + 4, { width: badgeW, align: 'center', lineBreak: false });
        y += badgeH + 6;
      }

      // ── Invoice meta ──
      const metaLabel = (txt, val, yy) => {
        doc.fillColor('#666').font('Helvetica-Bold').fontSize(9.5).text(txt, L, yy, { width: 75 });
        doc.fillColor('#333').font('Helvetica').fontSize(9.5).text(val, L + 75, yy, { width: 220 });
      };
      metaLabel('Invoice No:', displayRef, y);
      metaLabel('Date:',    new Date(order.createdAt).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }), y + 15);
      metaLabel('Payment:', order.paymentMethod || 'Credit/Debit Card', y + 30);
      if (sellerName) {
        let metaY = y + 45;
        metaLabel('Seller:', sanitizeForPDF(sellerName), metaY);
        metaY += 15;
        if (sellerAbn) { metaLabel('ABN:', sanitizeForPDF(formatABN(sellerAbn)), metaY); metaY += 15; }
        // Parse seller business address
        let addrObj = null;
        if (sellerAddress) {
          try { addrObj = typeof sellerAddress === 'string' ? JSON.parse(sellerAddress) : sellerAddress; } catch (_) {}
        }
        if (addrObj) {
          const addrLine1 = sanitizeForPDF(addrObj.street || '');
          const addrLine2 = sanitizeForPDF([addrObj.city, addrObj.state].filter(Boolean).join(', '));
          const addrLine3 = sanitizeForPDF([addrObj.postcode, addrObj.country].filter(Boolean).join(' '));
          if (addrLine1) { metaLabel('Address:', addrLine1, metaY); metaY += 15; }
          if (addrLine2) { metaLabel('', addrLine2, metaY); metaY += 15; }
          if (addrLine3) { metaLabel('', addrLine3, metaY); metaY += 15; }
        }
        y = metaY + 3;
      } else { y += 48; }

      // ── Bill To / Ship To boxes ──
      const boxW  = Math.floor((R - L - 8) / 2);
      const box2X = L + boxW + 8;
      const boxH  = 70;

      doc.rect(L,     y, boxW, boxH).lineWidth(0.5).stroke('#cccccc');
      doc.rect(box2X, y, boxW, boxH).lineWidth(0.5).stroke('#cccccc');
      doc.rect(L,     y, boxW, 17).fill(BRAND);
      doc.rect(box2X, y, boxW, 17).fill(BRAND);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5)
         .text('BILL TO', L + 7, y + 5, { width: boxW - 14 })
         .text('SHIP TO', box2X + 7, y + 5, { width: boxW - 14 });

      doc.fillColor('#333').font('Helvetica').fontSize(9);
      doc.text(sanitizeForPDF(order.customerName  || ''), L + 7,     y + 22, { width: boxW - 14, ellipsis: true, lineBreak: false });
      doc.text(sanitizeForPDF(order.customerEmail || ''), L + 7,     y + 34, { width: boxW - 14, ellipsis: true, lineBreak: false });
      doc.text(sanitizeForPDF(order.shippingPhone || order.customerPhone || ''), L + 7, y + 46, { width: boxW - 14, lineBreak: false });

      if (order.shippingAddressLine || order.shippingCity) {
        doc.text(sanitizeForPDF(order.shippingAddressLine || ''), box2X + 7, y + 22, { width: boxW - 14, ellipsis: true, lineBreak: false });
        doc.text(sanitizeForPDF([order.shippingCity, order.shippingState].filter(Boolean).join(', ')), box2X + 7, y + 34, { width: boxW - 14, ellipsis: true, lineBreak: false });
        doc.text(sanitizeForPDF([order.shippingZipCode, order.shippingCountry].filter(Boolean).join(' ')), box2X + 7, y + 46, { width: boxW - 14, lineBreak: false });
      }
      y += boxH + 16;

      // ── Items Table ──
      const C_QTY   = 260;
      const C_UNIT  = 310;
      const C_GST   = 380;
      const C_TOTAL = 460;
      const HDR_H   = 22;
      const ROW_H   = 20;
      const tableW  = R - L;

      // Table header row
      doc.rect(L, y, tableW, HDR_H).fill(BRAND);
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9.5);
      doc.text('Product',    L + 6,  y + 6, { width: C_QTY - L - 10 });
      doc.text('Qty',        C_QTY,  y + 6, { width: C_UNIT - C_QTY,   align: 'center' });
      doc.text('Unit Price', C_UNIT, y + 6, { width: C_GST - C_UNIT,   align: 'right'  });
      doc.text('GST',        C_GST,  y + 6, { width: C_TOTAL - C_GST,  align: 'right'  });
      doc.text('Total',      C_TOTAL,y + 6, { width: R - C_TOTAL - 6,  align: 'right'  });
      y += HDR_H;

      const tableStartY = y;
      let subtotal = 0;
      doc.font('Helvetica').fontSize(9);

      (items || []).forEach((item, idx) => {
        // Guard: stop rendering items if we're about to hit the summary+footer area
        if (y + ROW_H > MAX_CONTENT_Y - 100) return;
        const lineTotal = Number(item.price) * item.quantity;
        subtotal += lineTotal;

        // Build variant info string separately
        const variantAttrs = item.productVariant?.variantAttributeValues
          ?.map(av => `${av.attributeValue?.attribute?.name}: ${av.attributeValue?.value}`)
          .filter(Boolean).join(', ') || null;
        const rowH = variantAttrs ? ROW_H + 11 : ROW_H;

        doc.rect(L, y, tableW, rowH).fill(idx % 2 === 0 ? '#ffffff' : BRAND_LIGHT);
        doc.fillColor('#333');

        let gstPercentage = gstRate || 0;
        let pPrice = Number(item.price) || 0;
        let pPriceExGST = pPrice / (1 + (gstPercentage / 100));
        let gstAmt = (pPrice - pPriceExGST) * item.quantity;

        // Product title
        doc.font('Helvetica').fontSize(9).fillColor('#333')
           .text(sanitizeForPDF(item.product?.title || 'Product'), L + 6, y + 5, { width: C_QTY - L - 14, ellipsis: true });
        // Variant info on a separate smaller grey line
        if (variantAttrs) {
          doc.font('Helvetica').fontSize(7.5).fillColor('#888')
             .text(sanitizeForPDF(variantAttrs), L + 6, y + 16, { width: C_QTY - L - 14, ellipsis: true });
        }
        // Other columns vertically centred in the row
        const midY = y + (rowH / 2) - 4;
        doc.font('Helvetica').fontSize(9).fillColor('#333');
        doc.text(String(item.quantity),                            C_QTY,   midY, { width: C_UNIT - C_QTY,      align: 'center' });
        doc.text(`$${pPriceExGST.toFixed(2)}`,                    C_UNIT,  midY, { width: C_GST  - C_UNIT,     align: 'right'  });
        doc.text(`$${gstAmt.toFixed(2)} (${gstPercentage}%)`,     C_GST,   midY, { width: C_TOTAL - C_GST,     align: 'right'  });
        doc.text(`$${lineTotal.toFixed(2)}`,                       C_TOTAL, midY, { width: R - C_TOTAL - 6,     align: 'right'  });
        y += rowH;
      });

      // Recalculate subtotal from all items (guard above may have skipped some rows display-only)
      subtotal = (items || []).reduce((s, i) => s + Number(i.price) * i.quantity, 0);

      // Table outer border
      doc.rect(L, tableStartY - HDR_H, tableW, HDR_H + (y - tableStartY))
         .lineWidth(1).stroke('#dddddd');
      y += 14;

      // ── Summary block ──────────────────────────────────────────────────
      // Each seller page always shows its own items + its own shipping.
      // Coupon (order-level) is shown only on the last seller page.
      const displaySubtotal = subtotal;
      const displayShipping = perSellerShipping;
      const displayGstAmt   = displaySubtotal * gstRate / (100 + gstRate);
      const displayNetExGst = displaySubtotal - displayGstAmt;

      // Ensure summary block fits before the footer
      const summaryLines  = 3 + (displayShipping > 0 ? 1 : 0) + (parseFloat(order.discountAmount || 0) > 0 ? 1 : 0);
      const summaryHeight = summaryLines * 17 + 30; // rows + total line
      const summaryY      = y + summaryHeight > MAX_CONTENT_Y ? MAX_CONTENT_Y - summaryHeight : y;

      const sumRow = (label, value, yy, opts = {}) => {
        const { color = '#555', valueColor = '#333', bold = false, size = 10 } = opts;
        doc.fillColor(color).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size)
           .text(label, 330, yy, { width: 140 });
        doc.fillColor(valueColor).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size)
           .text(value, 330, yy, { width: R - 330, align: 'right' });
      };

      let sy = summaryY;

      // 1. Products subtotal (inc. GST)
      const subtotalLabel = 'Products Subtotal (inc. GST):';
      sumRow(subtotalLabel, `$${displaySubtotal.toFixed(2)}`, sy);
      sy += 17;

      // 2. GST included (extracted from subtotal: GST = subtotal × rate / (100 + rate))
      doc.fillColor('#888').font('Helvetica').fontSize(8.5)
         .text(`  GST included (${gstRate.toFixed(0)}%):`, 330, sy, { width: 150 });
      doc.fillColor('#888').fontSize(8.5)
         .text(`$${displayGstAmt.toFixed(2)}`, 330, sy, { width: R - 330, align: 'right' });
      sy += 14;
      doc.fillColor('#aaa').font('Helvetica').fontSize(8.5)
         .text('  Net amount (ex. GST):', 330, sy, { width: 150 });
      doc.fillColor('#aaa').fontSize(8.5)
         .text(`$${displayNetExGst.toFixed(2)}`, 330, sy, { width: R - 330, align: 'right' });
      sy += 16;

      // 3. Shipping
      if (displayShipping > 0) {
        const methodName = storedSummary?.shippingMethod?.name;
        const shippingLabel = methodName || 'Shipping';
        sumRow(`${shippingLabel}:`, `$${displayShipping.toFixed(2)}`, sy);
        sy += 17;
      }

      // 4. Coupon discount — shown on last page only (order-level discount)
      const discAmt = showOrderDiscount
        ? parseFloat(order.discountAmount || storedSummary?.discountAmount || 0)
        : 0;
      const discCode = order.couponCode || storedSummary?.couponCode || null;
      if (discAmt > 0) {
        sumRow(
          `Coupon Discount${discCode ? ` (${discCode})` : ''}:`,
          `-$${discAmt.toFixed(2)}`,
          sy,
          { color: '#2e7d32', valueColor: '#2e7d32' }
        );
        sy += 17;
      }

      // 5. Total line
      doc.moveTo(330, sy).lineTo(R, sy).lineWidth(1.5).stroke(BRAND);
      sy += 8;
      const pageTotal = displaySubtotal + displayShipping - discAmt;
      sumRow('Grand Total:', `$${pageTotal.toFixed(2)}`, sy, { bold: true, size: 12, color: BRAND, valueColor: BRAND });
      sy += 16;
      doc.fillColor('#999999').font('Helvetica-Oblique').fontSize(7.5)
         .text('All applicable taxes are included in the total.', 330, sy, { width: R - 330, align: 'right', lineBreak: false });

      // ── Footer — fixed at bottom, well within page bounds ────────────────
      doc.moveTo(L, FOOTER_Y - 10).lineTo(R, FOOTER_Y - 10).lineWidth(0.5).stroke('#cccccc');
      doc.fillColor('#aaaaaa').font('Helvetica').fontSize(8.5)
         .text('Thank you for shopping with Made in Arnhem Land!', L, FOOTER_Y, { align: 'center', width: R - L, lineBreak: false });
      doc.fillColor('#bbbbbb').font('Helvetica').fontSize(8)
         .text('Support: support@madeinarnhemland.com.au', L, FOOTER_Y + 14, { align: 'center', width: R - L, lineBreak: false });
    };

    const hasSubOrders = Array.isArray(order.subOrders) && order.subOrders.length > 0;

    // For single-seller orders: derive seller info from items if not already set
    let singleSellerName    = order.sellerName || null;
    let singleSellerAbn     = order.sellerAbn || null;
    let singleSellerAddress = order.sellerAddress || null;
    if (!hasSubOrders && !singleSellerName) {
      const firstProductSeller = order.items?.[0]?.product?.seller;
      if (firstProductSeller) {
        singleSellerName    = firstProductSeller.name || null;
        singleSellerAbn     = firstProductSeller.sellerProfile?.abn || null;
        singleSellerAddress = firstProductSeller.sellerProfile?.businessAddress || null;
      }
    }

    if (hasSubOrders) {
      // ── MULTI_SELLER: one A4 page per seller, all in one PDF ──
      // Coupon is order-level — show it only on the last seller page
      order.subOrders.forEach((sub, idx) => {
        if (idx > 0) doc.addPage({ size: 'A4', margin: 50 });
        const sellerLabel   = sub.seller?.name || sub.sellerName || 'Unknown Seller';
        const sellerAbn     = sub.sellerProfile?.abn || sub.seller?.sellerProfile?.abn || sub.sellerAbn || null;
        const sellerAddress = sub.sellerProfile?.businessAddress || sub.sellerAddress || null;
        const isLastPage    = idx === order.subOrders.length - 1;
        drawPage(sellerLabel, sellerAbn, sellerAddress, sub.items || [], isLastPage);
      });
    } else {
      // ── Single-seller / sub-order / legacy direct order ──
      drawPage(singleSellerName, singleSellerAbn, singleSellerAddress, order.items || [], true);
    }

    doc.end();
  });
};

// ─── Helper: build a unified invoice shape from a SubOrder record ──────────
const buildSubOrderShape = (sub) => ({
  id:                 sub.id,
  displayId:          sub.parentOrder?.displayId || null,
  subDisplayId:       sub.subDisplayId || null,
  createdAt:          sub.createdAt,
  status:             sub.status,
  sellerName:         sub.seller?.name || null,
  sellerAbn:          sub.sellerProfile?.abn || sub.seller?.sellerProfile?.abn || null,
  sellerAddress:      sub.sellerProfile?.businessAddress || null,
  customerName:       sub.parentOrder.customerName,
  customerEmail:      sub.parentOrder.customerEmail,
  customerPhone:      sub.parentOrder.customerPhone,
  shippingPhone:      sub.parentOrder.shippingPhone,
  shippingAddressLine: sub.parentOrder.shippingAddressLine,
  shippingCity:       sub.parentOrder.shippingCity,
  shippingState:      sub.parentOrder.shippingState,
  shippingZipCode:    sub.parentOrder.shippingZipCode,
  shippingCountry:    sub.parentOrder.shippingCountry,
  // Pass parent's shippingAddress JSON so perSellerShipping is resolved correctly
  shippingAddress:    sub.parentOrder.shippingAddress || null,
  totalAmount:        sub.subtotal,
  paymentMethod:      sub.parentOrder.paymentMethod,
  discountAmount:     null,
  couponCode:         null,
  items:              sub.items,
  subOrders:          null,
});

async function ensureSubDisplayId(prisma, subRecord, invoiceShape) {
  // If the invoiceShape lacks a displayId, fetch it from parent
  if (!invoiceShape.displayId && subRecord.parentOrderId) {
    const parent = await prisma.order.findUnique({ where: { id: subRecord.parentOrderId }, select: { displayId: true } });
    if (parent) invoiceShape.displayId = parent.displayId;
  }
  // Generate a subDisplayId dynamically if it is null
  if (!subRecord.subDisplayId && subRecord.parentOrderId && invoiceShape.displayId) {
    const parentWithStubs = await prisma.order.findUnique({
      where: { id: subRecord.parentOrderId },
      include: { subOrders: { orderBy: { createdAt: 'asc' }, select: { id: true } } }
    });
    if (parentWithStubs && parentWithStubs.subOrders) {
      const idx = parentWithStubs.subOrders.findIndex(s => s.id === subRecord.id);
      if (idx !== -1) {
        let suffix = '', n = idx;
        do {
          suffix = String.fromCharCode(65 + (n % 26)) + suffix;
          n = Math.floor(n / 26) - 1;
        } while (n >= 0);
        subRecord.subDisplayId = `${invoiceShape.displayId}-${suffix}`;
      }
    }
  }
  invoiceShape.displayId = subRecord.subDisplayId || invoiceShape.displayId || invoiceShape.id;
}

// Download Invoice as PDF (auth required)
exports.downloadInvoice = async (request, reply) => {
  try {
    const userId   = request.user.userId;
    const userRole = request.user.role;
    const { orderId } = request.params;

    const orderInclude = {
      items:     { include: { product: { select: { id: true, title: true, price: true, sellerId: true, seller: { select: { name: true, sellerProfile: { select: { abn: true, businessAddress: true } } } } } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
      subOrders: { include: { seller: { select: { name: true } }, sellerProfile: { select: { abn: true, businessAddress: true } }, items: { include: { product: { select: { id: true, title: true, price: true } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } } } },
      user:      { select: { name: true, email: true, phone: true, isDeleted: true } },
    };

    // ── Try as a parent / direct / legacy order first ──
    let invoiceShape = null;
    const orderRecord = await prisma.order.findFirst({
      where: {
        OR: [
          { id: orderId },
          { displayId: orderId }
        ]
      },
      include: orderInclude
    });

    if (orderRecord) {
      // Role-based access
      if (userRole === 'USER' && orderRecord.userId !== userId) {
        return reply.status(403).send({ success: false, message: "You don't have permission to access this order" });
      }
      if (userRole === 'SELLER') {
        const isSeller = orderRecord.sellerId === userId ||
          orderRecord.items.some(i => i.product?.sellerId === userId) ||
          orderRecord.subOrders?.some(s => s.sellerId === userId);
        if (!isSeller) return reply.status(403).send({ success: false, message: "You don't have permission to access this order" });
      }
      invoiceShape = {
        ...orderRecord,
        customerName:  (orderRecord.user?.isDeleted ? 'Deleted User' : orderRecord.user?.name) || orderRecord.customerName,
        customerEmail: orderRecord.user?.email || orderRecord.customerEmail,
        customerPhone: orderRecord.user?.phone || orderRecord.customerPhone,
      };
    } else {
      // ── Fall back: try as a SubOrder ID ──
      const subOrderInclude = {
        parentOrder: { select: { displayId: true, userId: true, customerName: true, customerEmail: true, customerPhone: true, shippingPhone: true, shippingAddressLine: true, shippingCity: true, shippingState: true, shippingZipCode: true, shippingCountry: true, shippingAddress: true, paymentMethod: true, user: { select: { name: true, email: true, phone: true, isDeleted: true } } } },
        items:       { include: { product: { select: { id: true, title: true, price: true } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
        seller:      { select: { name: true, email: true } },
        sellerProfile: { select: { abn: true, businessAddress: true } },
      };
      let subRecord = await prisma.subOrder.findFirst({
        where: {
          OR: [
            { id: orderId },
            { subDisplayId: orderId }
          ]
        },
        include: subOrderInclude
      });

      // Fallback: If DB 'subDisplayId' is null but frontend dynamically passed "PARENT_DISPLAY-A"
      if (!subRecord && orderId.includes('-')) {
        const [parentDisplayId] = orderId.split('-');
        const parentOrder = await prisma.order.findFirst({
          where: { displayId: parentDisplayId },
          include: { subOrders: { orderBy: { createdAt: 'asc' } } }
        });
        
        if (parentOrder && parentOrder.subOrders) {
          const toSubDisplayId = (parentId, idx) => {
            let suffix = '', n = idx;
            do {
              suffix = String.fromCharCode(65 + (n % 26)) + suffix;
              n = Math.floor(n / 26) - 1;
            } while (n >= 0);
            return `${parentId}-${suffix}`;
          };
          
          for (let i = 0; i < parentOrder.subOrders.length; i++) {
            if (toSubDisplayId(parentDisplayId, i) === orderId) {
              subRecord = await prisma.subOrder.findUnique({
                where: { id: parentOrder.subOrders[i].id },
                include: subOrderInclude
              });
              break;
            }
          }
        }
      }

      if (!subRecord) {
        return reply.status(404).send({ success: false, message: "Order not found or you don't have permission to access this order" });
      }
      // Role-based access for sub-orders
      if (userRole === 'USER' && subRecord.parentOrder.userId !== userId) {
        return reply.status(403).send({ success: false, message: "You don't have permission to access this order" });
      }
      if (userRole === 'SELLER' && subRecord.sellerId !== userId) {
        return reply.status(403).send({ success: false, message: "You don't have permission to access this order" });
      }
      invoiceShape = buildSubOrderShape(subRecord);
      await ensureSubDisplayId(prisma, subRecord, invoiceShape);
    }

    // Status guard — allow all statuses including REFUND/CANCELLED
    const resolvedStatus = invoiceShape.status || invoiceShape.overallStatus || 'CONFIRMED';
    const ALLOWED_STATUSES = ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED', 'REFUND', 'PARTIAL_REFUND', 'CANCELLED'];
    if (!ALLOWED_STATUSES.includes(resolvedStatus)) {
      return reply.status(400).send({ success: false, message: `Invoice is not available for orders with status: ${resolvedStatus}` });
    }

    const pdfBuffer = await generateInvoiceBuffer({ ...invoiceShape, _resolvedStatus: resolvedStatus });
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="invoice-${orderId}.pdf"`);
    return reply.send(pdfBuffer);
  } catch (error) {
    console.error("Download invoice error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// Download Sub-Order Invoice — seller-specific PDF (only that seller's items)
// GET /api/orders/invoice/sub/:subOrderId
// :subOrderId = subDisplayId without # prefix, e.g. "A4X9KR-A"
exports.downloadSubOrderInvoice = async (request, reply) => {
  try {
    const userId   = request.user.userId;
    const userRole = request.user.role;
    const { subOrderId } = request.params;

    const subOrderInclude = {
      parentOrder: {
        select: { displayId: true, userId: true, customerName: true, customerEmail: true, customerPhone: true, shippingPhone: true, shippingAddressLine: true, shippingCity: true, shippingState: true, shippingZipCode: true, shippingCountry: true, shippingAddress: true, paymentMethod: true, user: { select: { name: true, email: true, phone: true, isDeleted: true } } }
      },
      items: { include: { product: { select: { id: true, title: true, price: true } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
      seller: { select: { name: true, email: true } },
      sellerProfile: { select: { abn: true, businessAddress: true } },
    };

    let subRecord = await prisma.subOrder.findFirst({
      where: {
        OR: [
          { id: subOrderId },
          { subDisplayId: subOrderId }
        ]
      },
      include: subOrderInclude,
    });

    // Fallback: If DB 'subDisplayId' is null but frontend dynamically passed "PARENT_DISPLAY-A"
    if (!subRecord && subOrderId.includes('-')) {
      const [parentDisplayId] = subOrderId.split('-');
      const parentOrder = await prisma.order.findFirst({
        where: { displayId: parentDisplayId },
        include: { subOrders: { orderBy: { createdAt: 'asc' } } }
      });
      
      if (parentOrder && parentOrder.subOrders) {
        const toSubDisplayId = (parentId, idx) => {
          let suffix = '', n = idx;
          do {
            suffix = String.fromCharCode(65 + (n % 26)) + suffix;
            n = Math.floor(n / 26) - 1;
          } while (n >= 0);
          return `${parentId}-${suffix}`;
        };
        
        for (let i = 0; i < parentOrder.subOrders.length; i++) {
          if (toSubDisplayId(parentDisplayId, i) === subOrderId) {
            subRecord = await prisma.subOrder.findUnique({
              where: { id: parentOrder.subOrders[i].id },
              include: subOrderInclude
            });
            break;
          }
        }
      }
    }

    if (!subRecord) {
      return reply.status(404).send({ success: false, message: 'Sub-order not found' });
    }

    // Role-based access
    if (userRole === 'USER' && subRecord.parentOrder.userId !== userId) {
      return reply.status(403).send({ success: false, message: "You don't have permission to access this order" });
    }
    if (userRole === 'SELLER' && subRecord.sellerId !== userId) {
      return reply.status(403).send({ success: false, message: "You don't have permission to access this order" });
    }

    const resolvedStatus = subRecord.status || 'CONFIRMED';
    const ALLOWED_STATUSES = ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED', 'REFUND', 'PARTIAL_REFUND', 'CANCELLED'];
    if (!ALLOWED_STATUSES.includes(resolvedStatus)) {
      return reply.status(400).send({ success: false, message: `Invoice is not available for sub-orders with status: ${resolvedStatus}` });
    }

    const invoiceShape = buildSubOrderShape(subRecord);
    await ensureSubDisplayId(prisma, subRecord, invoiceShape);

    const pdfBuffer = await generateInvoiceBuffer({ ...invoiceShape, _resolvedStatus: resolvedStatus });
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="invoice-${subOrderId}.pdf"`);
    return reply.send(pdfBuffer);
  } catch (error) {
    console.error('Download sub-order invoice error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// Download Guest Order Invoice as PDF
exports.downloadGuestInvoice = async (request, reply) => {
  try {
    const { orderId, customerEmail } = request.query;

    if (!orderId || !customerEmail) {
      return reply.status(400).send({ success: false, message: "Order ID and customer email are required" });
    }

    const parentOrderSelect = {
      select: {
        displayId: true,
        userId: true, customerName: true, customerEmail: true, customerPhone: true,
        shippingPhone: true, shippingAddressLine: true, shippingCity: true,
        shippingState: true, shippingZipCode: true, shippingCountry: true,
        shippingAddress: true, paymentMethod: true,
      }
    };
    const orderInclude = {
      items:     { include: { product: { select: { id: true, title: true, price: true, seller: { select: { name: true, sellerProfile: { select: { abn: true, businessAddress: true } } } } } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
      subOrders: { include: { seller: { select: { name: true } }, sellerProfile: { select: { abn: true, businessAddress: true } }, items: { include: { product: { select: { id: true, title: true, price: true } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } } } },
    };

    // Try as parent order (email verified)
    let invoiceShape = null;
    const orderRecord = await prisma.order.findFirst({
      where: { displayId: orderId, customerEmail },
      include: orderInclude,
    });

    if (orderRecord) {
      invoiceShape = orderRecord;
    } else {
      // Fall back to sub-order (verify email against parent)
      const subRecord = await prisma.subOrder.findUnique({
        where: { id: orderId },
        include: {
          parentOrder: parentOrderSelect,
          items: { include: { product: { select: { id: true, title: true, price: true } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
          seller: { select: { name: true, email: true } },
          sellerProfile: { select: { abn: true, businessAddress: true } },
        },
      });
      if (!subRecord || subRecord.parentOrder.customerEmail !== customerEmail) {
        return reply.status(404).send({ success: false, message: "Order not found or email doesn't match" });
      }
      invoiceShape = buildSubOrderShape(subRecord);
      await ensureSubDisplayId(prisma, subRecord, invoiceShape);
    }

    const resolvedStatus = invoiceShape.status || invoiceShape.overallStatus || 'CONFIRMED';
    const ALLOWED_STATUSES = ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED', 'REFUND', 'PARTIAL_REFUND', 'CANCELLED'];
    if (!ALLOWED_STATUSES.includes(resolvedStatus)) {
      return reply.status(400).send({ success: false, message: `Invoice is not available for orders with status: ${resolvedStatus}` });
    }

    const pdfBuffer = await generateInvoiceBuffer({ ...invoiceShape, _resolvedStatus: resolvedStatus });
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="invoice-${orderId}.pdf"`);
    return reply.send(pdfBuffer);
  } catch (error) {
    console.error("Download guest invoice error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// ─── DEAD CODE REMOVED ─── old inline PDF generation replaced by generateInvoiceBuffer above
// placeholder kept so line references don't shift unexpectedly
const _guestInvoiceLegacyPlaceholder = null; // eslint-disable-line

// Download Invoice as PDF — public endpoint for email links
// No auth required: orderId is the short displayId shown to customers.
// GET /api/orders/invoice/public/:orderId
exports.downloadPublicInvoice = async (request, reply) => {
  try {
    const { orderId } = request.params;

    const orderInclude = {
      items:     { include: { product: { select: { id: true, title: true, price: true, seller: { select: { name: true, sellerProfile: { select: { abn: true, businessAddress: true } } } } } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
      subOrders: { include: { seller: { select: { name: true } }, sellerProfile: { select: { abn: true, businessAddress: true } }, items: { include: { product: { select: { id: true, title: true, price: true } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } } } },
      user:      { select: { name: true, email: true, phone: true, isDeleted: true } },
    };

    // Try parent / direct / legacy order first (by displayId)
    let invoiceShape = null;
    const orderRecord = await prisma.order.findFirst({ where: { displayId: orderId }, include: orderInclude });

    if (orderRecord) {
      invoiceShape = {
        ...orderRecord,
        customerName:  (orderRecord.user?.isDeleted ? 'Deleted User' : orderRecord.user?.name) || orderRecord.customerName,
        customerEmail: orderRecord.user?.email || orderRecord.customerEmail,
        customerPhone: orderRecord.user?.phone || orderRecord.customerPhone,
      };
    } else {
      // Fall back to sub-order
      const subRecord = await prisma.subOrder.findUnique({
        where: { id: orderId },
        include: {
          parentOrder: {
            select: {
              userId: true, customerName: true, customerEmail: true, customerPhone: true,
              shippingPhone: true, shippingAddressLine: true, shippingCity: true,
              shippingState: true, shippingZipCode: true, shippingCountry: true,
              shippingAddress: true, paymentMethod: true,
              user: { select: { name: true, email: true, phone: true, isDeleted: true } },
            }
          },
          items:  { include: { product: { select: { id: true, title: true, price: true } }, productVariant: { include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } } } } },
          seller: { select: { name: true, email: true } },
          sellerProfile: { select: { abn: true, businessAddress: true } },
        },
      });
      if (!subRecord) {
        return reply.status(404).send({ success: false, message: "Order not found" });
      }
      invoiceShape = buildSubOrderShape(subRecord);
      await ensureSubDisplayId(prisma, subRecord, invoiceShape);
    }

    const resolvedStatus = invoiceShape.status || invoiceShape.overallStatus || 'CONFIRMED';
    const ALLOWED_STATUSES = ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED', 'REFUND', 'PARTIAL_REFUND', 'CANCELLED'];
    if (!ALLOWED_STATUSES.includes(resolvedStatus)) {
      return reply.status(400).send({ success: false, message: `Invoice is not available for orders with status: ${resolvedStatus}` });
    }

    const pdfBuffer = await generateInvoiceBuffer({ ...invoiceShape, _resolvedStatus: resolvedStatus });
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="invoice-${orderId}.pdf"`);
    return reply.send(pdfBuffer);
  } catch (error) {
    console.error("Download public invoice error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};



module.exports.generateInvoiceBuffer = generateInvoiceBuffer;
module.exports.calcSellerCouponDiscount = _calcSellerCouponDiscount;
