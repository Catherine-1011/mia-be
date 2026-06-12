'use strict';

const prisma = require('../config/prisma');
const { log: auditLog, extractRequestMeta, AUDIT_ACTIONS, ENTITY_TYPES } = require('../utils/auditLogger');

// ── Role helpers ──────────────────────────────────────────────────────────────
const isAdminRole  = (role) => role === 'ADMIN' || role === 'SUPER_ADMIN';
const isSellerRole = (role) => role === 'SELLER';

// ── GST fetch helper ──────────────────────────────────────────────────────────
async function fetchGST(gstId = null) {
  let gst = null;
  if (gstId) {
    gst = await prisma.gST.findFirst({ where: { id: gstId, isActive: true } });
  }
  if (!gst) gst = await prisma.gST.findFirst({ where: { isActive: true, isDefault: true } });
  if (!gst) gst = await prisma.gST.findFirst({ where: { isActive: true } });
  return gst;
}

// Convert a GST-inclusive price to ex-GST price.
// Prices in this system are stored GST-inclusive.
// Formula: exGST = inclusivePrice * 100 / (100 + gstRate)
function toExGST(inclusivePrice, gstRate) {
  if (!gstRate || gstRate === 0) return inclusivePrice;
  return (inclusivePrice * 100) / (100 + gstRate);
}

// ── Validation helpers ────────────────────────────────────────────────────────
function validateCouponFields(body, isUpdate = false) {
  const { couponType, discountType, discountValue, bundleQty, bundlePrice, expiresAt, code } = body;

  if (!isUpdate) {
    if (!code) return 'Coupon code is required';
    if (!expiresAt) return 'Expiry date is required';
  }

  const type = couponType || 'discount';

  if (!['discount', 'bundle'].includes(type)) {
    return 'couponType must be "discount" or "bundle"';
  }

  if (type === 'discount') {
    if (!isUpdate || discountType !== undefined) {
      const dt = discountType || 'percentage';
      if (!['percentage', 'flat'].includes(dt)) {
        return 'discountType must be "percentage" or "flat"';
      }
    }
    if (!isUpdate || discountValue !== undefined) {
      if (discountValue === undefined || discountValue === null) return 'discountValue is required for discount coupons';
      const dv = parseFloat(discountValue);
      if (isNaN(dv) || dv <= 0) return 'discountValue must be a positive number';
      const dt = discountType || 'percentage';
      if (dt === 'percentage' && dv > 100) return 'Percentage discount cannot exceed 100';
    }
  }

  if (type === 'bundle') {
    if (!isUpdate || bundleQty !== undefined) {
      if (!bundleQty || parseInt(bundleQty) < 2) return 'bundleQty must be at least 2';
    }
    if (!isUpdate || bundlePrice !== undefined) {
      if (bundlePrice === undefined || bundlePrice === null) return 'bundlePrice is required for bundle coupons';
      if (parseFloat(bundlePrice) <= 0) return 'bundlePrice must be a positive number';
    }
  }

  return null; // valid
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE SELLER COUPON
// Seller: creates for their own store. Admin: must provide sellerId in body.
// ─────────────────────────────────────────────────────────────────────────────
exports.createSellerCoupon = async (request, reply) => {
  try {
    const actor = request.user;

    // Determine sellerId
    let sellerId;
    if (isAdminRole(actor.role)) {
      sellerId = request.body?.sellerId;
      if (!sellerId) {
        return reply.status(400).send({ success: false, message: 'sellerId is required when an admin creates a seller coupon' });
      }
      // Verify the seller exists and has a SELLER role
      const seller = await prisma.user.findUnique({ where: { id: sellerId } });
      if (!seller || seller.role !== 'SELLER' || seller.isDeleted) {
        return reply.status(404).send({ success: false, message: 'Seller not found' });
      }
    } else {
      sellerId = actor.userId;
      
      // Check if seller is inactive (only for sellers, not admin)
      const seller = await prisma.sellerProfile.findUnique({
        where: { userId: sellerId }
      });
      
      if (!seller?.isActive) {
        return reply.status(403).send({
          success: false,
          message: "Your account has been deactivated. You cannot create coupons. Reason: " + (seller?.inactiveReason || "No reason provided")
        });
      }
    }

    const {
      code,
      couponType = 'discount',
      discountType = 'percentage',
      discountValue,
      maxDiscount,
      minQty = 1,
      bundleQty,
      bundlePrice,
      expiresAt,
      usageLimit,
      usagePerUser = 1,
      isActive = true,
      productIds = []   // [] means all seller products; non-empty restricts to listed products
    } = request.body;

    const validationError = validateCouponFields(request.body);
    if (validationError) {
      return reply.status(400).send({ success: false, message: validationError });
    }

    // Validate productIds — each must belong to this seller
    if (productIds.length > 0) {
      const products = await prisma.product.findMany({
        where: { id: { in: productIds }, sellerId, deletedAt: null }
      });
      if (products.length !== productIds.length) {
        return reply.status(400).send({
          success: false,
          message: 'One or more productIds are invalid or do not belong to this seller'
        });
      }
    }

    const upperCode = code.toUpperCase();
    const existing = await prisma.sellerCoupon.findUnique({ where: { code: upperCode } });
    if (existing) {
      return reply.status(400).send({ success: false, message: 'Coupon code already exists' });
    }

    const coupon = await prisma.sellerCoupon.create({
      data: {
        code:         upperCode,
        sellerId,
        couponType,
        discountType:  couponType === 'discount' ? discountType : null,
        discountValue: couponType === 'discount' ? parseFloat(discountValue) : null,
        maxDiscount:   couponType === 'discount' && maxDiscount ? parseFloat(maxDiscount) : null,
        minQty:        parseInt(minQty),
        bundleQty:     couponType === 'bundle' ? parseInt(bundleQty) : null,
        bundlePrice:   couponType === 'bundle' ? parseFloat(bundlePrice) : null,
        productIds:    Array.isArray(productIds) ? productIds : [],
        expiresAt:     new Date(expiresAt),
        usageLimit:    usageLimit ? parseInt(usageLimit) : null,
        usagePerUser:  parseInt(usagePerUser),
        isActive:      Boolean(isActive),
        createdBy:     actor.userId
      }
    });

    await auditLog({
      entityType:   ENTITY_TYPES.SELLER_COUPON,
      entityId:     coupon.id,
      action:       AUDIT_ACTIONS.SELLER_COUPON_CREATED,
      ...extractRequestMeta(request),
      previousData: null,
      newData:      coupon,
      reason:       `Seller coupon "${coupon.code}" created by ${actor.role.toLowerCase()} ${actor.userId}`
    });

    return reply.status(201).send({ success: true, message: 'Seller coupon created successfully', coupon });
  } catch (error) {
    console.error('Create seller coupon error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET SELLER COUPONS
// Seller: their own. Admin: all, or filter ?sellerId=xxx. Supports ?recycleBin=true
// ─────────────────────────────────────────────────────────────────────────────
exports.getSellerCoupons = async (request, reply) => {
  try {
    const actor = request.user;
    const recycleBin = request.query?.recycleBin === 'true';

    let where = recycleBin
      ? { softDeletedAt: { not: null } }
      : { softDeletedAt: null };

    if (isSellerRole(actor.role)) {
      where.sellerId = actor.userId;
    } else if (isAdminRole(actor.role) && request.query?.sellerId) {
      where.sellerId = request.query.sellerId;
    }

    const coupons = await prisma.sellerCoupon.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        seller: { select: { id: true, name: true, email: true } }
      }
    });

    return reply.send({ success: true, coupons, count: coupons.length, recycleBin });
  } catch (error) {
    console.error('Get seller coupons error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET SINGLE SELLER COUPON
// ─────────────────────────────────────────────────────────────────────────────
exports.getSellerCouponById = async (request, reply) => {
  try {
    const actor = request.user;
    const { id } = request.params;

    const coupon = await prisma.sellerCoupon.findUnique({
      where: { id },
      include: { seller: { select: { id: true, name: true, email: true } } }
    });

    if (!coupon) {
      return reply.status(404).send({ success: false, message: 'Coupon not found' });
    }

    // Sellers can only see their own coupons
    if (isSellerRole(actor.role) && coupon.sellerId !== actor.userId) {
      return reply.status(403).send({ success: false, message: 'Access denied' });
    }

    return reply.send({ success: true, coupon });
  } catch (error) {
    console.error('Get seller coupon by ID error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE SELLER COUPON
// ─────────────────────────────────────────────────────────────────────────────
exports.updateSellerCoupon = async (request, reply) => {
  try {
    const actor = request.user;
    const { id } = request.params;

    const existing = await prisma.sellerCoupon.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, message: 'Coupon not found' });
    }
    if (existing.softDeletedAt) {
      return reply.status(400).send({ success: false, message: 'Cannot edit a soft-deleted coupon. Restore it first.' });
    }
    if (isSellerRole(actor.role) && existing.sellerId !== actor.userId) {
      return reply.status(403).send({ success: false, message: 'Access denied' });
    }

    // Check if seller is inactive (only for sellers, not admin)
    if (isSellerRole(actor.role)) {
      const seller = await prisma.sellerProfile.findUnique({
        where: { userId: actor.userId }
      });
      
      if (!seller?.isActive) {
        return reply.status(403).send({
          success: false,
          message: "Your account has been deactivated. You cannot update coupons. Reason: " + (seller?.inactiveReason || "No reason provided")
        });
      }
    }

    const {
      code, couponType, discountType, discountValue, maxDiscount, minQty,
      bundleQty, bundlePrice, expiresAt, usageLimit, usagePerUser, isActive, productIds
    } = request.body;

    const validationError = validateCouponFields(request.body, true);
    if (validationError) {
      return reply.status(400).send({ success: false, message: validationError });
    }

    const updateData = {};

    if (code !== undefined) {
      const upperCode = code.toUpperCase();
      if (upperCode !== existing.code) {
        const conflict = await prisma.sellerCoupon.findUnique({ where: { code: upperCode } });
        if (conflict) return reply.status(400).send({ success: false, message: 'Coupon code already exists' });
      }
      updateData.code = upperCode;
    }

    const effectiveType = couponType || existing.couponType;
    if (couponType !== undefined) updateData.couponType = couponType;

    if (effectiveType === 'discount') {
      if (discountType  !== undefined) updateData.discountType  = discountType;
      if (discountValue !== undefined) updateData.discountValue = parseFloat(discountValue);
      if (maxDiscount   !== undefined) updateData.maxDiscount   = maxDiscount ? parseFloat(maxDiscount) : null;
      // Clear bundle fields when switching to discount
      if (couponType === 'discount') {
        updateData.bundleQty   = null;
        updateData.bundlePrice = null;
      }
    }

    if (effectiveType === 'bundle') {
      if (bundleQty   !== undefined) updateData.bundleQty   = parseInt(bundleQty);
      if (bundlePrice !== undefined) updateData.bundlePrice = parseFloat(bundlePrice);
      // Clear discount fields when switching to bundle
      if (couponType === 'bundle') {
        updateData.discountType  = null;
        updateData.discountValue = null;
        updateData.maxDiscount   = null;
      }
    }

    if (minQty       !== undefined) updateData.minQty       = parseInt(minQty);
    if (expiresAt    !== undefined) updateData.expiresAt    = new Date(expiresAt);
    if (usageLimit   !== undefined) updateData.usageLimit   = usageLimit ? parseInt(usageLimit) : null;
    if (usagePerUser !== undefined) updateData.usagePerUser = parseInt(usagePerUser);
    if (isActive     !== undefined) updateData.isActive     = Boolean(isActive);

    if (productIds !== undefined) {
      if (productIds.length > 0) {
        const targetSellerId = existing.sellerId;
        const products = await prisma.product.findMany({
          where: { id: { in: productIds }, sellerId: targetSellerId, deletedAt: null }
        });
        if (products.length !== productIds.length) {
          return reply.status(400).send({
            success: false,
            message: 'One or more productIds are invalid or do not belong to this seller'
          });
        }
      }
      updateData.productIds = productIds;
    }

    const updated = await prisma.sellerCoupon.update({ where: { id }, data: updateData });

    await auditLog({
      entityType:   ENTITY_TYPES.SELLER_COUPON,
      entityId:     id,
      action:       AUDIT_ACTIONS.SELLER_COUPON_UPDATED,
      ...extractRequestMeta(request),
      previousData: existing,
      newData:      updated,
      reason:       `Seller coupon "${updated.code}" updated by ${actor.role.toLowerCase()} ${actor.userId}`
    });

    return reply.send({ success: true, message: 'Coupon updated successfully', coupon: updated });
  } catch (error) {
    console.error('Update seller coupon error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SOFT DELETE SELLER COUPON
// ─────────────────────────────────────────────────────────────────────────────
exports.softDeleteSellerCoupon = async (request, reply) => {
  try {
    const actor = request.user;
    const { id } = request.params;
    const { reason } = request.body || {};

    const existing = await prisma.sellerCoupon.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, message: 'Coupon not found' });
    }
    if (existing.softDeletedAt) {
      return reply.status(400).send({ success: false, message: 'Coupon is already in the recycle bin' });
    }
    if (isSellerRole(actor.role) && existing.sellerId !== actor.userId) {
      return reply.status(403).send({ success: false, message: 'Access denied' });
    }

    const now = new Date();
    await prisma.sellerCoupon.update({
      where: { id },
      data: { softDeletedAt: now, softDeletedBy: actor.userId, isActive: false }
    });

    await auditLog({
      entityType:   ENTITY_TYPES.SELLER_COUPON,
      entityId:     id,
      action:       AUDIT_ACTIONS.SELLER_COUPON_SOFT_DELETED,
      ...extractRequestMeta(request),
      previousData: existing,
      newData:      { ...existing, softDeletedAt: now, softDeletedBy: actor.userId, isActive: false },
      reason:       reason || `Seller coupon "${existing.code}" moved to recycle bin`
    });

    return reply.send({
      success: true,
      message: `Coupon "${existing.code}" moved to recycle bin`,
      data: { id, code: existing.code, softDeletedAt: now }
    });
  } catch (error) {
    console.error('Soft delete seller coupon error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RESTORE SELLER COUPON
// ─────────────────────────────────────────────────────────────────────────────
exports.restoreSellerCoupon = async (request, reply) => {
  try {
    const actor = request.user;
    const { id } = request.params;

    const existing = await prisma.sellerCoupon.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, message: 'Coupon not found' });
    }
    if (!existing.softDeletedAt) {
      return reply.status(400).send({ success: false, message: 'Coupon is not in the recycle bin' });
    }
    if (isSellerRole(actor.role) && existing.sellerId !== actor.userId) {
      return reply.status(403).send({ success: false, message: 'Access denied' });
    }

    const now = new Date();
    const restored = await prisma.sellerCoupon.update({
      where: { id },
      data: { softDeletedAt: null, softDeletedBy: null, restoredAt: now, restoredBy: actor.userId }
    });

    await auditLog({
      entityType:   ENTITY_TYPES.SELLER_COUPON,
      entityId:     id,
      action:       AUDIT_ACTIONS.SELLER_COUPON_RESTORED,
      ...extractRequestMeta(request),
      previousData: existing,
      newData:      restored,
      reason:       `Seller coupon "${existing.code}" restored from recycle bin`
    });

    return reply.send({ success: true, message: `Coupon "${existing.code}" has been restored`, coupon: restored });
  } catch (error) {
    console.error('Restore seller coupon error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HARD DELETE SELLER COUPON (must be in recycle bin first)
// ─────────────────────────────────────────────────────────────────────────────
exports.hardDeleteSellerCoupon = async (request, reply) => {
  try {
    const actor = request.user;
    const { id } = request.params;
    const { reason } = request.body || {};

    const existing = await prisma.sellerCoupon.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ success: false, message: 'Coupon not found' });
    }
    if (!existing.softDeletedAt) {
      return reply.status(400).send({
        success: false,
        message: 'Coupon must be moved to the recycle bin before it can be permanently deleted'
      });
    }
    if (isSellerRole(actor.role) && existing.sellerId !== actor.userId) {
      return reply.status(403).send({ success: false, message: 'Access denied' });
    }

    // Write audit log BEFORE deleting
    await auditLog({
      entityType:   ENTITY_TYPES.SELLER_COUPON,
      entityId:     id,
      action:       AUDIT_ACTIONS.SELLER_COUPON_HARD_DELETED,
      ...extractRequestMeta(request),
      previousData: existing,
      newData:      null,
      reason:       reason || `Seller coupon "${existing.code}" permanently deleted`
    });

    await prisma.sellerCoupon.delete({ where: { id } });

    return reply.send({
      success: true,
      message: `Coupon "${existing.code}" has been permanently deleted. Audit logs are retained.`,
      data: { id, code: existing.code }
    });
  } catch (error) {
    console.error('Hard delete seller coupon error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET ACTIVE SELLER COUPONS (Public — browse available offers)
// Optional ?sellerId=xxx to filter by seller
// ─────────────────────────────────────────────────────────────────────────────
exports.getActiveSellerCoupons = async (request, reply) => {
  try {
    const now = new Date();
    const where = {
      isActive: true,
      softDeletedAt: null,
      expiresAt: { gt: now }
    };

    if (request.query?.sellerId) {
      where.sellerId = request.query.sellerId;
    }

    const coupons = await prisma.sellerCoupon.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id:           true,
        code:         true,
        sellerId:     true,
        couponType:   true,
        discountType:  true,
        discountValue: true,
        maxDiscount:   true,
        minQty:        true,
        bundleQty:     true,
        bundlePrice:   true,
        productIds:    true,
        expiresAt:     true,
        usagePerUser:  true,
        seller: { select: { id: true, name: true } }
      }
    });

    return reply.send({ success: true, coupons, count: coupons.length });
  } catch (error) {
    console.error('Get active seller coupons error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// APPLY SELLER COUPON — calculate discount on provided cart items (public)
//
// Body: {
//   code: "SUMMER10",
//   items: [
//     { productId: "...", variantId: "...", quantity: 2 },
//     { productId: "...", variantId: null,  quantity: 1 }
//   ],
//   gstId: "optional-gst-id"
// }
//
// Prices are stored GST-inclusive in this system.
// Discount is computed on the ex-GST subtotal; GST is re-added after discount.
// Items from other sellers are reported but receive no discount.
// ─────────────────────────────────────────────────────────────────────────────
exports.applySellerCoupon = async (request, reply) => {
  try {
    const { code, items, gstId } = request.body || {};

    if (!code) {
      return reply.status(400).send({ success: false, message: 'Coupon code is required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({ success: false, message: 'items array is required and must not be empty' });
    }

    // ── 1. Find and validate coupon ───────────────────────────────────────────
    const coupon = await prisma.sellerCoupon.findUnique({ where: { code: code.toUpperCase() } });

    if (!coupon || coupon.softDeletedAt) {
      return reply.status(404).send({ success: false, message: 'Invalid coupon code' });
    }
    if (!coupon.isActive) {
      return reply.status(400).send({ success: false, message: 'This coupon is no longer active' });
    }
    if (new Date() > coupon.expiresAt) {
      return reply.status(400).send({ success: false, message: 'This coupon has expired' });
    }
    if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
      return reply.status(400).send({ success: false, message: 'Coupon usage limit has been reached' });
    }

    // ── 2. Fetch product and variant info for all items ───────────────────────
    const productIds = [...new Set(items.map(i => i.productId).filter(Boolean))];
    const variantIds = [...new Set(items.map(i => i.variantId).filter(Boolean))];

    const [products, variants] = await Promise.all([
      prisma.product.findMany({
        where: { id: { in: productIds }, deletedAt: null },
        select: { id: true, title: true, sellerId: true, price: true, type: true }
      }),
      variantIds.length > 0
        ? prisma.productVariant.findMany({
            where: { id: { in: variantIds }, isActive: true },
            select: { id: true, productId: true, price: true }
          })
        : Promise.resolve([])
    ]);

    const productMap = Object.fromEntries(products.map(p => [p.id, p]));
    const variantMap = Object.fromEntries(variants.map(v => [v.id, v]));

    // ── 3. Fetch GST rate ─────────────────────────────────────────────────────
    const gst = await fetchGST(gstId);
    const gstRate = gst ? parseFloat(gst.percentage) : 0;

    // ── 4. Classify items: qualifying vs non-qualifying ───────────────────────
    // A qualifying item must:
    //   (a) belong to the coupon's seller
    //   (b) be in coupon.productIds (or productIds is empty → all seller products qualify)
    const qualifyingRaw = [];
    const nonQualifyingItems = [];

    for (const item of items) {
      const qty = parseInt(item.quantity) || 0;
      if (qty <= 0) continue;

      const product = productMap[item.productId];
      if (!product) {
        nonQualifyingItems.push({ ...item, reason: 'Product not found' });
        continue;
      }

      const belongsToSeller = product.sellerId === coupon.sellerId;
      const inProductList =
        coupon.productIds.length === 0 || coupon.productIds.includes(item.productId);

      if (!belongsToSeller || !inProductList) {
        nonQualifyingItems.push({ productId: item.productId, quantity: qty, reason: 'Not eligible for this coupon' });
        continue;
      }

      // Resolve GST-inclusive unit price
      let unitPriceIncl = 0;
      if (item.variantId && variantMap[item.variantId]) {
        unitPriceIncl = parseFloat(variantMap[item.variantId].price);
      } else {
        unitPriceIncl = parseFloat(product.price || 0);
      }

      qualifyingRaw.push({
        productId:     item.productId,
        productTitle:  product.title,
        variantId:     item.variantId || null,
        quantity:      qty,
        unitPriceIncl  // GST-inclusive
      });
    }

    // ── 5. Group qualifying items by productId ────────────────────────────────
    // Different variants of the same product aggregate their quantities for bundle/minQty purposes.
    const productGroups = {};
    for (const item of qualifyingRaw) {
      if (!productGroups[item.productId]) {
        productGroups[item.productId] = {
          productId:    item.productId,
          productTitle: item.productTitle,
          totalQty:     0,
          totalInclSubtotal: 0,
          variants: []
        };
      }
      const g = productGroups[item.productId];
      g.totalQty           += item.quantity;
      g.totalInclSubtotal  += item.unitPriceIncl * item.quantity;
      g.variants.push({
        variantId:     item.variantId,
        quantity:      item.quantity,
        unitPriceIncl: item.unitPriceIncl,
        unitPriceExGST: parseFloat(toExGST(item.unitPriceIncl, gstRate).toFixed(4))
      });
    }

    // ── 6. Apply discount / bundle logic per product group ───────────────────
    let totalRegularExGST   = 0;
    let totalDiscountedExGST = 0;
    const qualifyingBreakdown = [];

    for (const group of Object.values(productGroups)) {
      // ex-GST subtotal for this product (all variants combined)
      const regularExGST = toExGST(group.totalInclSubtotal, gstRate);

      // Check minQty threshold
      if (group.totalQty < coupon.minQty) {
        nonQualifyingItems.push({
          productId:    group.productId,
          productTitle: group.productTitle,
          totalQty:     group.totalQty,
          reason:       `Minimum quantity of ${coupon.minQty} not met (have ${group.totalQty})`
        });
        // Still add to regular total (no discount)
        totalRegularExGST   += regularExGST;
        totalDiscountedExGST += regularExGST;
        continue;
      }

      let discountedExGST = regularExGST;
      let discountBreakdown = {};

      if (coupon.couponType === 'bundle') {
        // Bundle: buy X for a fixed ex-GST price
        const completeBundles = Math.floor(group.totalQty / coupon.bundleQty);
        const remainingQty    = group.totalQty % coupon.bundleQty;

        // Average ex-GST price per item for remaining items
        const avgExGSTPerItem = regularExGST / group.totalQty;

        const bundleCost    = completeBundles * coupon.bundlePrice; // ex-GST
        const remainingCost = remainingQty * avgExGSTPerItem;       // ex-GST

        discountedExGST = bundleCost + remainingCost;
        const savings   = regularExGST - discountedExGST;

        discountBreakdown = {
          type:                  'bundle',
          bundleQty:             coupon.bundleQty,
          bundlePriceExGST:      parseFloat(coupon.bundlePrice.toFixed(2)),
          completeBundles,
          remainingQty,
          bundleCostExGST:       parseFloat(bundleCost.toFixed(2)),
          remainingCostExGST:    parseFloat(remainingCost.toFixed(2)),
          discountedExGSTSubtotal: parseFloat(discountedExGST.toFixed(2)),
          savingsExGST:          parseFloat(savings.toFixed(2))
        };

      } else {
        // Discount: percentage or flat on ex-GST subtotal
        let discount = 0;
        if (coupon.discountType === 'percentage') {
          discount = (regularExGST * coupon.discountValue) / 100;
          if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
        } else {
          // flat
          discount = Math.min(coupon.discountValue, regularExGST);
        }
        discountedExGST = regularExGST - discount;

        discountBreakdown = {
          type:                    coupon.discountType,
          discountValue:           coupon.discountValue,
          discountAppliedExGST:    parseFloat(discount.toFixed(2)),
          discountedExGSTSubtotal: parseFloat(discountedExGST.toFixed(2)),
          savingsExGST:            parseFloat(discount.toFixed(2))
        };
      }

      totalRegularExGST    += regularExGST;
      totalDiscountedExGST += discountedExGST;

      qualifyingBreakdown.push({
        productId:          group.productId,
        productTitle:       group.productTitle,
        totalQty:           group.totalQty,
        variants:           group.variants.map(v => ({
          variantId:      v.variantId,
          quantity:       v.quantity,
          unitPriceIncl:  parseFloat(v.unitPriceIncl.toFixed(2)),
          unitPriceExGST: v.unitPriceExGST
        })),
        regularExGSTSubtotal:    parseFloat(regularExGST.toFixed(2)),
        discountBreakdown
      });
    }

    const totalSavingsExGST     = totalRegularExGST - totalDiscountedExGST;
    const gstOnDiscounted       = totalDiscountedExGST * gstRate / 100;
    const discountedInclTotal   = totalDiscountedExGST + gstOnDiscounted;

    return reply.send({
      success: true,
      coupon: {
        id:           coupon.id,
        code:         coupon.code,
        couponType:   coupon.couponType,
        discountType:  coupon.discountType,
        discountValue: coupon.discountValue,
        maxDiscount:   coupon.maxDiscount,
        bundleQty:     coupon.bundleQty,
        bundlePrice:   coupon.bundlePrice,
        expiresAt:     coupon.expiresAt
      },
      eligibleSellerId: coupon.sellerId,
      qualifyingItems:  qualifyingBreakdown,
      nonQualifyingItems,
      summary: {
        gstRate:               parseFloat(gstRate.toFixed(2)),
        regularExGSTTotal:     parseFloat(totalRegularExGST.toFixed(2)),
        totalSavingsExGST:     parseFloat(totalSavingsExGST.toFixed(2)),
        discountedExGSTTotal:  parseFloat(totalDiscountedExGST.toFixed(2)),
        gstOnDiscountedAmount: parseFloat(gstOnDiscounted.toFixed(2)),
        discountedInclTotal:   parseFloat(discountedInclTotal.toFixed(2))
      }
    });
  } catch (error) {
    console.error('Apply seller coupon error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// ── Admin: list all seller coupons grouped by seller ─────────────────────────
// GET /api/admin/seller-coupons
// Query params:
//   sellerId   — filter to a single seller
//   isActive   — "true" | "false"
//   couponType — "discount" | "bundle"
//   recycleBin — "true" to show soft-deleted only
//   search     — partial match on coupon code
//   page       — 1-based (default 1)
//   limit      — per page (default 20)
exports.adminGetSellerCouponsBySeller = async (request, reply) => {
  try {
    const {
      sellerId,
      isActive,
      couponType,
      recycleBin,
      search,
      page  = '1',
      limit = '20',
    } = request.query;

    const pageNum  = Math.max(1, parseInt(page)  || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const skip     = (pageNum - 1) * limitNum;

    const where = {};

    if (recycleBin === 'true') {
      where.softDeletedAt = { not: null };
    } else {
      where.softDeletedAt = null;
    }

    if (sellerId)              where.sellerId   = sellerId;
    if (couponType)            where.couponType = couponType;
    if (isActive !== undefined) where.isActive  = isActive === 'true';
    if (search)                where.code       = { contains: search.toUpperCase(), mode: 'insensitive' };

    const [coupons, total] = await Promise.all([
      prisma.sellerCoupon.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: [{ sellerId: 'asc' }, { createdAt: 'desc' }],
        include: {
          seller: {
            select: {
              id: true,
              name: true,
              email: true,
              sellerProfile: {
                select: { storeName: true, businessName: true, status: true }
              }
            }
          }
        }
      }),
      prisma.sellerCoupon.count({ where })
    ]);

    // Group by seller
    const sellerMap = new Map();
    for (const coupon of coupons) {
      const sid = coupon.sellerId;
      if (!sellerMap.has(sid)) {
        sellerMap.set(sid, {
          seller: {
            id:           coupon.seller.id,
            name:         coupon.seller.name,
            email:        coupon.seller.email,
            storeName:    coupon.seller.sellerProfile?.storeName   || null,
            businessName: coupon.seller.sellerProfile?.businessName || null,
            status:       coupon.seller.sellerProfile?.status       || null,
          },
          coupons:         [],
          activeCoupons:   0,
          inactiveCoupons: 0,
        });
      }
      const entry = sellerMap.get(sid);
      const { seller: _s, ...couponData } = coupon;
      entry.coupons.push(couponData);
      if (coupon.isActive && !coupon.softDeletedAt) entry.activeCoupons++;
      else entry.inactiveCoupons++;
    }

    return reply.status(200).send({
      success: true,
      pagination: {
        total,
        page:       pageNum,
        limit:      limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
      sellers: [...sellerMap.values()],
    });
  } catch (error) {
    console.error('adminGetSellerCouponsBySeller error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};
