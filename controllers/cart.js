const prisma = require("../config/prisma");
const { lookupZone } = require('../utils/internationalShipping');

/**
 * Calculate cart totals with shipping and GST
 * @param {Array} cartItems - Array of cart items with product details
 * @param {String} shippingMethodId - Selected shipping method ID (optional, for AU domestic)
 * @param {String} gstId - Selected GST ID (optional)
 * @param {Number|null} internationalShippingCost - Per-seller flat cost for international orders (optional)
 * @returns {Object} - Calculated totals
 */
const calculateCartTotals = async (cartItems, shippingMethodId = null, gstId = null, internationalShippingCost = null) => {
  try {
    // Calculate subtotal — use variant price for VARIABLE items, product price for SIMPLE
    const subtotal = cartItems.reduce((sum, item) => {
      const price = parseFloat(item.productVariant?.price ?? item.product?.price ?? 0);
      const quantity = item.quantity || 0;
      return sum + (price * quantity);
    }, 0);

    // Count unique sellers in the cart
    const sellerCount = Math.max(
      new Set(cartItems.map(i => i.product?.sellerId).filter(Boolean)).size,
      1
      );

    // Get shipping cost
    let shippingCost = 0;
    let selectedShipping = null;

    if (internationalShippingCost !== null) {
      // International shipping: cost passed directly (server-validated from zone map)
      shippingCost = parseFloat(internationalShippingCost);
    } else if (shippingMethodId) {
      const shipping = await prisma.shippingMethod.findUnique({
        where: { id: shippingMethodId, isActive: true }
      });
      if (shipping) {
        shippingCost = parseFloat(shipping.cost || 0);
        selectedShipping = shipping;
      }
    }

    // Each seller gets the full shipping cost — total shipping scales with seller count
    const totalShippingCost = shippingCost * sellerCount;

    // Get GST — either specific GST, or default, or first active (fallback chain)
    let gstDetails = null;
    if (gstId) {
      gstDetails = await prisma.gST.findFirst({
        where: { id: gstId, isActive: true }
      });
    }
    if (!gstDetails) {
      gstDetails = await prisma.gST.findFirst({
        where: { isActive: true, isDefault: true }
      });
    }
    if (!gstDetails) {
      // Final fallback: use any active GST record
      gstDetails = await prisma.gST.findFirst({
        where: { isActive: true }
      });
    }

    const gstPercentage = gstDetails ? parseFloat(gstDetails.percentage || 0) : 0;

    // Prices are GST-inclusive — extract the GST component from the subtotal.
    // Formula: GST = subtotal × rate / (100 + rate)
    // Example at 10%: $110 × 10 / 110 = $10  →  net ex-GST = $100
    const gstAmount = gstPercentage > 0
      ? (subtotal * gstPercentage) / (100 + gstPercentage)
      : 0;

    const subtotalExGST = subtotal - gstAmount;

    // grandTotal = subtotal (GST already included) + shipping per seller × seller count
    const grandTotal = subtotal + totalShippingCost;

    return {
      subtotal: subtotal.toFixed(2),                    // GST-inclusive product total
      subtotalExGST: subtotalExGST.toFixed(2),          // Net amount ex-GST
      shippingCost: shippingCost.toFixed(2),            // Per-seller shipping cost
      totalShippingCost: totalShippingCost.toFixed(2),  // Total shipping (shippingCost × sellerCount)
      sellerCount,
      gstPercentage: gstPercentage.toFixed(2),
      gstAmount: gstAmount.toFixed(2),                  // GST component extracted from subtotal
      grandTotal: grandTotal.toFixed(2),
      gstInclusive: true,
      selectedShipping,
      gstDetails
    };
  } catch (error) {
    console.error("Calculate cart totals error:", error);
    throw error;
  }
};

exports.addToCart = async (request, reply) => {
  try {
    // Check if request body exists
    if (!request.body) {
      return reply.status(400).send({ success: false, message: "Request body is required" });
    }

    const { productId, variantId, quantity } = request.body;
    const userId = request.user.userId; // from auth middleware

    if (!productId) {
      return reply.status(400).send({ success: false, message: "productId is required" });
    }

    // Get product with type
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stock: true, type: true }
    });
    if (!product) {
      return reply.status(404).send({ success: false, message: "Product not found" });
    }

    // VARIABLE products MUST specify a variantId
    if (product.type === 'VARIABLE' && !variantId) {
      return reply.status(400).send({ success: false, message: "variantId is required for VARIABLE products" });
    }

    // Resolve available stock — from variant for VARIABLE, from product for SIMPLE
    let availableStock = product.stock;
    if (variantId) {
      const variant = await prisma.productVariant.findUnique({
        where: { id: variantId },
        select: { stock: true, productId: true, isActive: true }
      });
      if (!variant || variant.productId !== productId) {
        return reply.status(404).send({ success: false, message: "Variant not found for this product" });
      }
      if (!variant.isActive) {
        return reply.status(400).send({ success: false, message: "This variant is currently unavailable" });
      }
      availableStock = variant.stock;
    }

    // Find or create cart
    let cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: true }
    });

    let newQuantity = quantity || 1;

    if (!cart) {
      if (newQuantity > availableStock) {
        return reply.status(400).send({ success: false, message: `Cannot add more than available stock (${availableStock})` });
      }
      cart = await prisma.cart.create({
        data: {
          userId,
          items: {
            create: { productId, variantId: variantId || null, quantity: newQuantity }
          }
        },
        include: { items: true }
      });
    } else {
      // Check if same product+variant already in cart
      const existingItem = await prisma.cartItem.findFirst({
        where: {
          cartId: cart.id,
          productId,
          variantId: variantId || null
        }
      });

      if (existingItem) {
        const totalQuantity = existingItem.quantity + newQuantity;
        if (totalQuantity > availableStock) {
          return reply.status(400).send({ success: false, message: `Cannot add more than available stock (${availableStock})` });
        }
        await prisma.cartItem.update({
          where: { id: existingItem.id },
          data: { quantity: totalQuantity }
        });
      } else {
        if (newQuantity > availableStock) {
          return reply.status(400).send({ success: false, message: `Cannot add more than available stock (${availableStock})` });
        }
        await prisma.cartItem.create({
          data: { cartId: cart.id, productId, variantId: variantId || null, quantity: newQuantity }
        });
      }
    }

    // Fetch updated cart and deduplicate counts to avoid inflated values from leftover duplicate rows
    const updatedCart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: true }
    });
    const deduplicatedItems = new Map();
    updatedCart?.items.forEach(item => {
      const key = item.productId;
      if (deduplicatedItems.has(key)) {
        deduplicatedItems.get(key).qty += item.quantity;
      } else {
        deduplicatedItems.set(key, { qty: item.quantity });
      }
    });
    const cartItemCount = deduplicatedItems.size;
    const totalQuantity = Array.from(deduplicatedItems.values()).reduce((sum, i) => sum + i.qty, 0);

    return reply.status(200).send({
      success: true,
      message: "Product added to cart successfully",
      cartItemCount,
      totalQuantity
    });
  } catch (error) {
    console.error("Add to cart error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};


// VIEW CART (User only)
exports.getMyCart = async (request, reply) => {
  try {
    const userId = request.user.userId; // from auth middleware
    const { shippingMethodId, gstId, internationalCountry } = request.query; // Optional: domestic method ID or international country


    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                title: true,
                price: true,
                type: true,
                featuredImage: true,
                stock: true,
                category: true,
                sellerId: true
              }
            },
            productVariant: {
              include: {
                variantAttributeValues: {
                  include: {
                    attributeValue: {
                      include: { attribute: true }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });


    if (cart && cart.items.length > 0) {
    }

    if (!cart || cart.items.length === 0) {
      return reply.status(200).send({
        success: true,
        cart: [],
        message: "Cart is empty",
        cartItemCount: 0,
        totalQuantity: 0,
        availableShipping: [],
        calculations: {
          subtotal: "0.00",
          subtotalExGST: "0.00",
          shippingCost: "0.00",
          gstPercentage: "0.00",
          gstAmount: "0.00",
          grandTotal: "0.00",
          gstInclusive: true
        }
      });
    }

    // Deduplicate items by productId + variantId — guards against duplicate rows
    const deduplicatedMap = new Map();
    cart.items.forEach(item => {
      const key = `${item.productId}_${item.variantId || ''}`;
      if (deduplicatedMap.has(key)) {
        deduplicatedMap.get(key).quantity += item.quantity;
      } else {
        // Extract common variant attributes as direct properties for easy frontend access
        const directVariantProps = {};
        if (item.productVariant?.variantAttributeValues?.length) {
          item.productVariant.variantAttributeValues.forEach(vav => {
            const attrName = vav.attributeValue?.attribute?.name?.toLowerCase();
            const attrValue = vav.attributeValue?.displayValue || vav.attributeValue?.value;
            if (attrName && attrValue) {
              directVariantProps[attrName] = attrValue; // size, color, etc.
            }
          });
        }

        deduplicatedMap.set(key, {
          productId: item.productId,
          variantId: item.variantId || null,
          quantity: item.quantity,
          ...directVariantProps, // ✅ Direct properties: size, color, etc.
          product: item.product,
          // Variant info: price + full attribute array (matches /all products format)
          variant: item.productVariant ? {
            id: item.productVariant.id,
            price: parseFloat(item.productVariant.price),
            stock: item.productVariant.stock,
            sku: item.productVariant.sku,
            images: item.productVariant.images,
            attributes: (item.productVariant.variantAttributeValues || []).map((vav) => ({
              attributeId: vav.attributeValue?.attribute?.id ?? null,
              attributeName: vav.attributeValue?.attribute?.name ?? null,
              attributeDisplayName: vav.attributeValue?.attribute?.displayName ?? null,
              valueId: vav.attributeValue?.id ?? null,
              value: vav.attributeValue?.value ?? null,
              displayValue: vav.attributeValue?.displayValue ?? null,
              hexColor: vav.attributeValue?.hexColor ?? null
            }))
          } : null,
          // Effective price for display (variant overrides product)
          effectivePrice: item.productVariant
            ? parseFloat(item.productVariant.price)
            : parseFloat(item.product?.price || 0)
        });
      }
    });
    const cleanedCart = Array.from(deduplicatedMap.values());

    // Get available shipping methods
    const availableShipping = await prisma.shippingMethod.findMany({
      where: { isActive: true },
      orderBy: { cost: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        cost: true,
        estimatedDays: true
      }
    });

    // Get default GST
    const defaultGST = await prisma.gST.findFirst({
      where: { isActive: true, isDefault: true },
      select: {
        id: true,
        name: true,
        percentage: true,
        description: true
      }
    });

    // Calculate base totals (no shipping)
    const baseCalculations = await calculateCartTotals(cleanedCart, null, gstId);

    // Pre-calculate totals for every available shipping method so the frontend
    // never needs to re-fetch — it just reads shippingCalculations[id]
    const shippingCalculations = {};
    for (const method of availableShipping) {
      const calc = await calculateCartTotals(cleanedCart, method.id, gstId);
      shippingCalculations[method.id] = {
        shippingCost:      calc.shippingCost,       // per-seller rate
        totalShippingCost: calc.totalShippingCost,  // shippingCost × sellerCount
        sellerCount:       calc.sellerCount,
        grandTotal:        calc.grandTotal
      };
    }

    // If a specific shippingMethodId was requested use that, otherwise base (no shipping)
    let calculations = baseCalculations;
    let internationalShipping = null;

    if (internationalCountry && internationalCountry.trim().toLowerCase() !== 'australia') {
      // Check if international shipping is enabled by admin
      const siteSettings = await prisma.siteSettings.findUnique({ where: { id: 'global' } });
      if (siteSettings && !siteSettings.internationalShippingEnabled) {
        return reply.status(400).send({
          success: false,
          message: 'International shipping is currently unavailable. Only Australia shipping is available.'
        });
      }
      const intlZoneEntry = lookupZone(internationalCountry.trim());
      const intlCalc = await calculateCartTotals(cleanedCart, null, gstId, intlZoneEntry.cost);
      // Override shippingCost → totalShippingCost so the frontend's shipping display line
      // always shows the full charge (perSellerRate × sellerCount), not the per-seller rate.
      calculations = {
        ...intlCalc,
        shippingCost: intlCalc.totalShippingCost
      };
      internationalShipping = {
        country: internationalCountry.trim(),
        zone: intlZoneEntry.zone,
        zoneName: intlZoneEntry.label,
        costPerSeller: intlZoneEntry.cost,
        totalCost: parseFloat(intlCalc.totalShippingCost),
        sellerCount: intlCalc.sellerCount,
        estimatedDays: '10-20 business days'
      };
    } else if (shippingMethodId) {
      calculations = await calculateCartTotals(cleanedCart, shippingMethodId, gstId);
    }

    const cartItemCount = cleanedCart.length;
    const totalQuantity = cleanedCart.reduce((sum, item) => sum + item.quantity, 0);

    return reply.status(200).send({
      success: true,
      cart: cleanedCart,
      cartItemCount,
      totalQuantity,
      availableShipping,
      gst: defaultGST,
      calculations,
      shippingCalculations,  // keyed by shippingMethodId — ready-to-use totals per option
      ...(internationalShipping && { internationalShipping })
    });
  } catch (error) {
    console.error("Get cart error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

exports.updateCartQuantity = async (request, reply) => {
  try {
    const userId = request.user.userId;
    
    // Check if request body exists
    if (!request.body) {
      return reply.status(400).send({
        success: false,
        message: "Request body is required"
      });
    }

    const { productId, variantId, quantity } = request.body;

    if (!productId || quantity === undefined) {
      return reply.status(400).send({
        success: false,
        message: "productId and quantity are required"
      });
    }

    const cart = await prisma.cart.findUnique({
      where: { userId }
    });

    if (!cart) {
      return reply.status(404).send({
        success: false,
        message: "Cart not found"
      });
    }

    const cartItem = await prisma.cartItem.findFirst({
      where: {
        cartId: cart.id,
        productId,
        variantId: variantId || null
      }
    });

    if (!cartItem) {
      return reply.status(404).send({
        success: false,
        message: "Product not found in cart"
      });
    }

    // Validate against correct stock source
    if (variantId) {
      const variant = await prisma.productVariant.findUnique({
        where: { id: variantId },
        select: { stock: true }
      });
      if (variant && quantity > variant.stock) {
        return reply.status(400).send({ success: false, message: `Cannot set more than available stock (${variant.stock})` });
      }
    } else {
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { stock: true }
      });
      if (product && quantity > product.stock) {
        return reply.status(400).send({ success: false, message: `Cannot set more than available stock (${product.stock})` });
      }
    }

    // Update the quantity
    const updatedItem = await prisma.cartItem.update({
      where: { id: cartItem.id },
      data: { quantity }
    });

    reply.status(200).send({
      success: true,
      message: "Cart quantity updated successfully",
      item: {
        productId: updatedItem.productId,
        variantId: updatedItem.variantId || null,
        quantity: updatedItem.quantity
      }
    });
  } catch (err) {
    console.error("Update cart quantity error:", err);
    reply.status(500).send({
      success: false,
      message: err.message
    });
  }
};


exports.removeFromCart = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const productId = request.params.productId;
    const variantId = request.query.variantId || null; // ?variantId=xxx for VARIABLE products

    const cart = await prisma.cart.findUnique({
      where: { userId }
    });

    if (!cart) {
      return reply.status(404).send({ success: false, message: "Cart not found" });
    }

    // Delete the specific cart item (by productId + optional variantId)
    await prisma.cartItem.deleteMany({
      where: {
        cartId: cart.id,
        productId,
        variantId: variantId || null
      }
    });

    // Get updated cart
    const updatedCart = await prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: true
          }
        }
      }
    });

    return reply.status(200).send({
      success: true,
      message: "Product removed from cart",
      cart: updatedCart?.items || [],
    });
  } catch (error) {
    console.error("Remove from cart error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/**
 * Calculate cart totals for guest checkout
 * POST /api/cart/calculate-guest
 * Body: { items: [{ productId, variantId?, quantity }], shippingMethodId }
 */
exports.calculateGuestCart = async (request, reply) => {
  try {
    const { items, shippingMethodId, gstId, internationalCountry } = request.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({
        success: false,
        message: "Items array is required and must not be empty"
      });
    }

    // Validate all items have required fields
    for (const item of items) {
      if (!item.productId || !item.quantity) {
        return reply.status(400).send({
          success: false,
          message: "Each item must have productId and quantity"
        });
      }
    }

    // Fetch product details for all items
    const productIds = items.map(item => item.productId);
    const products = await prisma.product.findMany({
      where: {
        id: { in: productIds }
      },
      select: {
        id: true,
        title: true,
        price: true,
        featuredImage: true,
        stock: true,
        category: true,
        sellerId: true
      }
    });

    // Check if all products exist
    if (products.length !== items.length) {
      return reply.status(404).send({
        success: false,
        message: "One or more products not found"
      });
    }

    // Fetch variants for items that have a variantId
    const variantIds = items.map(i => i.variantId).filter(Boolean);
    const variants = variantIds.length > 0
      ? await prisma.productVariant.findMany({
          where: { id: { in: variantIds } },
          include: { variantAttributeValues: { include: { attributeValue: { include: { attribute: true } } } } }
        })
      : [];

    // Build cart items with product + variant details
    const cartItems = items.map(item => {
      const product = products.find(p => p.id === item.productId);
      const productVariant = item.variantId ? variants.find(v => v.id === item.variantId) : null;
      return {
        productId: item.productId,
        quantity: item.quantity,
        product,
        productVariant: productVariant || null
      };
    });

    // Check stock availability
    for (const item of cartItems) {
      if (item.productVariant) {
        // VARIABLE product — check variant stock
        if (item.productVariant.stock < item.quantity) {
          return reply.status(400).send({
            success: false,
            message: `Insufficient stock for ${item.product.title}. Available: ${item.productVariant.stock}`
          });
        }
      } else if (item.product.stock !== null && item.quantity > item.product.stock) {
        // SIMPLE product — check product stock (skip null)
        return reply.status(400).send({
          success: false,
          message: `Insufficient stock for ${item.product.title}. Available: ${item.product.stock}`
        });
      }
    }

    // Get available options for guest users
    const availableShipping = await prisma.shippingMethod.findMany({
      where: { isActive: true },
      orderBy: { cost: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        cost: true,
        estimatedDays: true
      }
    });

    const availableGST = await prisma.gST.findMany({
      where: { isActive: true },
      orderBy: { percentage: 'asc' },
      select: {
        id: true,
        name: true,
        percentage: true,
        description: true,
        isDefault: true
      }
    });

    const defaultGST = await prisma.gST.findFirst({
      where: { isActive: true, isDefault: true },
      select: {
        id: true,
        name: true,
        percentage: true,
        description: true
      }
    });

    // Pre-calculate totals for every available shipping method
    const shippingCalculations = {};
    for (const method of availableShipping) {
      const calc = await calculateCartTotals(cartItems, method.id, gstId);
      shippingCalculations[method.id] = {
        shippingCost:      calc.shippingCost,       // per-seller rate
        totalShippingCost: calc.totalShippingCost,  // shippingCost × sellerCount
        sellerCount:       calc.sellerCount,
        grandTotal:        calc.grandTotal
      };
    }

    // Calculate totals for the selected method (or base if none selected)
    let calculations;
    let internationalShipping = null;

    if (internationalCountry && internationalCountry.trim().toLowerCase() !== 'australia') {
      // Check if international shipping is enabled by admin
      const siteSettings = await prisma.siteSettings.findUnique({ where: { id: 'global' } });
      if (siteSettings && !siteSettings.internationalShippingEnabled) {
        return reply.status(400).send({
          success: false,
          message: 'International shipping is currently unavailable. Only Australia shipping is available.'
        });
      }
      const intlZoneEntry = lookupZone(internationalCountry.trim());
      const intlCalc = await calculateCartTotals(cartItems, null, gstId, intlZoneEntry.cost);
      // Override shippingCost → totalShippingCost so the frontend's shipping display line
      // always shows the full charge (perSellerRate × sellerCount), not the per-seller rate.
      calculations = {
        ...intlCalc,
        shippingCost: intlCalc.totalShippingCost
      };
      internationalShipping = {
        country: internationalCountry.trim(),
        zone: intlZoneEntry.zone,
        zoneName: intlZoneEntry.label,
        costPerSeller: intlZoneEntry.cost,
        totalCost: parseFloat(intlCalc.totalShippingCost),
        sellerCount: intlCalc.sellerCount,
        estimatedDays: '10-20 business days'
      };
    } else {
      calculations = await calculateCartTotals(cartItems, shippingMethodId, gstId);
    }

    return reply.status(200).send({
      success: true,
      cart: cartItems,
      availableShipping,
      availableGST,
      defaultGST,
      calculations,
      shippingCalculations,  // keyed by shippingMethodId — ready-to-use totals per option
      ...(internationalShipping && { internationalShipping })
    });
  } catch (error) {
    console.error("Calculate guest cart error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message
    });
  }
};

/**
 * PUBLIC - Get checkout options (shipping methods and GST) for guest users
 */
const getCheckoutOptions = async (request, reply) => {
  try {
    // Get available shipping methods
    const availableShipping = await prisma.shippingMethod.findMany({
      where: { isActive: true },
      orderBy: { cost: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        cost: true,
        estimatedDays: true
      }
    });

    // Get all active GST options
    const availableGST = await prisma.gST.findMany({
      where: { isActive: true },
      orderBy: { percentage: 'asc' },
      select: {
        id: true,
        name: true,
        percentage: true,
        description: true,
        isDefault: true
      }
    });

    // Get default GST
    const defaultGST = await prisma.gST.findFirst({
      where: { isActive: true, isDefault: true },
      select: {
        id: true,
        name: true,
        percentage: true,
        description: true
      }
    });

    return reply.status(200).send({
      success: true,
      data: {
        shipping: availableShipping,
        gst: {
          options: availableGST,
          default: defaultGST
        }
      }
    });
  } catch (error) {
    console.error("Get checkout options error:", error);
    return reply.status(500).send({
      success: false,
      message: error.message
    });
  }
};

// Export the helper function for use in other controllers
exports.calculateCartTotals = calculateCartTotals;
exports.getCheckoutOptions = getCheckoutOptions;

// ─────────────────────────────────────────────
// POST /api/cart/sync  — Guest → Authenticated merge
// ─────────────────────────────────────────────
exports.syncCart = async (request, reply) => {
  try {
    const userId = request.user.userId;

    // ── 1. Validate payload ──────────────────────────────────────────────────
    const { guest_cart } = request.body || {};

    if (!Array.isArray(guest_cart) || guest_cart.length === 0) {
      return reply.status(400).send({
        success: false,
        code: "INVALID_PAYLOAD",
        message: "guest_cart must be a non-empty array"
      });
    }

    // Deduplicate guest items by product_id — sum quantities for duplicates
    const guestMap = new Map();
    for (const item of guest_cart) {
      if (!item.product_id || typeof item.quantity !== "number" || item.quantity < 1) {
        return reply.status(400).send({
          success: false,
          code: "INVALID_PAYLOAD",
          message: "Each guest_cart item requires a valid product_id and quantity >= 1"
        });
      }
      const prev = guestMap.get(item.product_id) || 0;
      guestMap.set(item.product_id, prev + Math.floor(item.quantity));
    }

    // ── 2. Validate products exist in DB ─────────────────────────────────────
    const guestProductIds = Array.from(guestMap.keys());

    const validProducts = await prisma.product.findMany({
      where: { id: { in: guestProductIds } },
      select: { id: true, title: true, price: true, stock: true, featuredImage: true }
    });

    const validProductMap = new Map(validProducts.map(p => [p.id, p]));
    const removedItems = guestProductIds.filter(id => !validProductMap.has(id));

    // ── 3. Find or create the user's DB cart ─────────────────────────────────
    let cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: true }
    });

    if (!cart) {
      cart = await prisma.cart.create({
        data: { userId },
        include: { items: true }
      });
    }

    // Build a fast lookup of existing DB cart items: productId → CartItem
    const dbItemMap = new Map(cart.items.map(i => [i.productId, i]));

    // ── 4. Merge: upsert each valid guest item ────────────────────────────────
    const MAX_QUANTITY = 99;

    for (const [productId, guestQty] of guestMap.entries()) {
      const product = validProductMap.get(productId);
      if (!product) continue; // orphaned — skip

      const existing = dbItemMap.get(productId);

      if (existing) {
        // Product exists in both → SUM, capped at stock & MAX_QUANTITY
        const merged = Math.min(existing.quantity + guestQty, product.stock, MAX_QUANTITY);
        await prisma.cartItem.update({
          where: { id: existing.id },
          data: { quantity: merged }
        });
      } else {
        // Net new from guest → insert capped at stock & MAX_QUANTITY
        const capped = Math.min(guestQty, product.stock, MAX_QUANTITY);
        await prisma.cartItem.create({
          data: {
            cartId: cart.id,
            productId,
            quantity: capped
          }
        });
      }
    }

    // ── 5. Fetch the final consolidated cart from DB ──────────────────────────
    const updatedCart = await prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                title: true,
                price: true,
                featuredImage: true,
                stock: true
              }
            }
          }
        }
      }
    });

    // ── 6. Build response ─────────────────────────────────────────────────────
    const cartItems = updatedCart.items.map(item => ({
      product_id: item.productId,
      quantity: item.quantity,
      price: parseFloat(item.product.price || 0),
      name: item.product.title,
      thumbnail: item.product.featuredImage || null
    }));

    const totalPrice = cartItems.reduce(
      (sum, i) => sum + i.price * i.quantity,
      0
    );

    const status = removedItems.length > 0 ? "partial" : "merged";

    const response = {
      status,
      cart: cartItems,
      meta: {
        items_count: cartItems.length,
        total_price: parseFloat(totalPrice.toFixed(2)),
        merged_at: new Date().toISOString()
      }
    };

    if (removedItems.length > 0) {
      response.removed_items = removedItems;
    }

    return reply.status(200).send(response);
  } catch (error) {
    console.error("Cart sync error:", error);
    return reply.status(500).send({
      success: false,
      code: "SYNC_FAILED",
      message: error.message
    });
  }
};