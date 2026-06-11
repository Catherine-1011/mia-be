const prisma = require("../config/prisma");
const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { generateSalesReportCSV } = require("../utils/csvExport");
const { sendSellerApprovedEmail, sendSellerLowStockEmail, sendSellerProductApprovedEmail, sendSellerProductRejectedEmail, sendSellerProductActivatedEmail, sendSellerProductDeactivatedEmail, sendAdminLowStockDeactivationEmail, sendRefundStatusUpdateEmail, sendSellerRefundStatusEmail } = require("../utils/emailService");
const { uploadToCloudinary } = require("../config/cloudinary");
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const STRIPE_DESCRIPTION_MAX_LENGTH = 255;

function truncateStripeDescription(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= STRIPE_DESCRIPTION_MAX_LENGTH) return text;
  return `${text.slice(0, STRIPE_DESCRIPTION_MAX_LENGTH - 3).trim()}...`;
}

function buildRetryTransferDescription({ order, customerName, customerEmail, itemSummary, amount }) {
  const displayId = order?.displayId || order?.id || "unknown";
  const amountText = amount !== undefined && amount !== null ? ` | Amount A$${Number(amount).toFixed(2)}` : "";
  const customerBits = [customerName, customerEmail].filter(Boolean).join(" / ");
  return truncateStripeDescription(
    `Order ${displayId} | Retry seller payout | Customer: ${customerBits || "N/A"} | Items: ${itemSummary || "Order items"}${amountText}`
  );
}

// ── Role helper ───────────────────────────────────────────────────────────────
// SUPER_ADMIN has all the same operational rights as ADMIN.
// Use this everywhere instead of hardcoding role === 'ADMIN'.
const isAdminRole = (role) => role === 'ADMIN' || role === 'SUPER_ADMIN';

// ── Variant price enrichment ──────────────────────────────────────────────────
// For VARIABLE products, replaces price (null) with the variant price range string.
// Used by admin product list endpoints.
const enrichProductPrice = async (products) => {
  // Collect all VARIABLE product IDs for a single batch query
  const variableIds = products.filter(p => p.type === 'VARIABLE').map(p => p.id);

  const variantStatsMap = {};
  if (variableIds.length > 0) {
    const rows = await prisma.$queryRaw`
      SELECT "productId",
             MIN(price::numeric) as min_price,
             MAX(price::numeric) as max_price,
             SUM(stock)::int as total_stock
      FROM "product_variants"
      WHERE "productId" = ANY(${variableIds}::text[])
      GROUP BY "productId"
    `;
    for (const row of rows) {
      variantStatsMap[row.productId] = row;
    }
  }

  return products.map((product) => {
    if (product.type !== 'VARIABLE') {
      return { ...product, price: product.price ? parseFloat(product.price) : null };
    }
    const stats = variantStatsMap[product.id];
    const min = stats?.min_price ? parseFloat(stats.min_price) : null;
    const max = stats?.max_price ? parseFloat(stats.max_price) : null;
    const priceRange = min !== null && max !== null
      ? (min === max ? `${min}` : `${min} - ${max}`)
      : null;
    const totalStock = stats?.total_stock ?? 0;
    return { ...product, price: priceRange, stock: totalStock };
  });
};

// ── Order display-ID helpers (used by all admin order endpoints) ──────────────
// Accepts the stored displayId Int (e.g. 1001) OR falls back to last-6-chars of CUID.
const toDisplayId = (idOrN) => {
  if (typeof idOrN === 'number') return `#${idOrN}`;
  const code = (idOrN || '').replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase();
  return `#${code}`;
};
// Sub-order display: #1001-A, #1001-B … (Excel-column style suffix)
const toSubDisplayId = (parentIdOrN, idx) => {
  let suffix = '', n = idx;
  do {
    suffix = String.fromCharCode(65 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  if (typeof parentIdOrN === 'number') return `#${parentIdOrN}-${suffix}`;
  const code = (parentIdOrN || '').replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase();
  return `#${code}-${suffix}`;
};

// ── Order status helpers ─────────────────────────────────────────────────────
const ORDER_STATUS_SEQUENCE = ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
const TERMINAL_STATUSES     = ['CANCELLED', 'REFUND', 'PARTIAL_REFUND'];

/**
 * Derive the correct parent status for a MULTI_SELLER order from its sub-orders.
 * Rules:
 *  • If ALL sub-orders are terminal → CANCELLED (all cancelled) or PARTIAL_REFUND
 *  • Otherwise → the MINIMUM (least-advanced) active sub-order status
 *    (parent only advances when every seller has moved forward)
 */
const deriveMultiSellerStatus = (subOrderStatuses, fallback = 'CONFIRMED') => {
  if (!subOrderStatuses || subOrderStatuses.length === 0) return fallback;
  const allTerminal = subOrderStatuses.every(s => TERMINAL_STATUSES.includes(s));
  if (allTerminal) {
    return subOrderStatuses.every(s => s === 'CANCELLED') ? 'CANCELLED' : 'PARTIAL_REFUND';
  }
  const active = subOrderStatuses.filter(s => !TERMINAL_STATUSES.includes(s));
  if (active.length === 0) return fallback;
  const minIdx = Math.min(...active.map(s => {
    const i = ORDER_STATUS_SEQUENCE.indexOf(s);
    return i === -1 ? Infinity : i;
  }));
  return minIdx !== Infinity ? ORDER_STATUS_SEQUENCE[minIdx] : fallback;
};

// Trim item objects — keep only fields the frontend needs
const formatOrderItem = (item) => ({
  id:        item.id,
  productId: item.productId,
  variantId: item.variantId || null,
  quantity:  item.quantity,
  price:     item.price != null ? parseFloat(item.price) : null,
  product:   item.product ? {
    id:            item.product.id,
    title:         item.product.title,
    featuredImage: item.product.featuredImage,
    price:         item.product.price != null ? parseFloat(item.product.price) : null
  } : null,
  variantAttributes: item.productVariant
    ? Object.fromEntries(
        (item.productVariant.variantAttributeValues || []).map(vav => [
          vav.attributeValue?.attribute?.displayName || vav.attributeValue?.attribute?.name,
          vav.attributeValue?.displayValue || vav.attributeValue?.value
        ])
      )
    : null
});

const trimItems = (items = []) => items.map(formatOrderItem);

const {
  notifySellerApproved,
  notifySellerApprovalRejected,
  notifySellerProductRecommendation,
  notifySellerProductStatusChange,
  notifySellerLowStock,
  notifyAdminLowStockDeactivation,
  notifySellerBankChangeApproved,
  notifySellerBankChangeRejected
} = require("./notification");
const { backfillOrderNotifications } = require("./orderNotification");
const { getCommissionForSeller } = require("./commission");
const { log: auditLog, extractRequestMeta, AUDIT_ACTIONS, ENTITY_TYPES } = require("../utils/auditLogger");
const LOW_STOCK_THRESHOLD = 2;

// SCAN & DEACTIVATE ALL LOW-STOCK PRODUCTS (Admin only)
// Sweeps all products where stock <= threshold AND isActive = true,
// deactivates them and sends the seller a notification + email for each one.
exports.scanLowStockProducts = async (request, reply) => {
  try {
    // Only scan SIMPLE products — VARIABLE products track stock at the variant level.
    const products = await prisma.$queryRaw`
      SELECT p.id, p.title, p.stock, p."sellerId",
             u.email AS "sellerEmail", u.name AS "sellerName"
      FROM "products" p
      JOIN "users" u ON u.id = p."sellerId"
      WHERE p."isActive" = true
        AND p.type = 'SIMPLE'
        AND p.stock <= ${LOW_STOCK_THRESHOLD}
        AND p."deletedAt" IS NULL
    `;

    if (products.length === 0) {
      return reply.status(200).send({
        success: true,
        message: "No low-stock active products found.",
        deactivated: 0
      });
    }

    const results = [];
    for (const product of products) {
      // Deactivate
      await prisma.$executeRaw`
        UPDATE "products"
        SET "isActive" = false, status = 'INACTIVE'::"ProductStatus"
        WHERE id = ${product.id}
      `;

      // In-app notification (non-blocking)
      notifySellerLowStock(
        product.sellerId,
        product.id,
        product.title,
        Number(product.stock)
      ).catch(err => console.error("Low stock notification error:", err.message));

      notifyAdminLowStockDeactivation(product.id, {
        productTitle: product.title,
        sellerName:   product.sellerName || 'Unknown',
        stock:        Number(product.stock)
      }).catch(err => console.error("Admin low stock deactivation notification error:", err.message));

      // Email (non-blocking)
      if (product.sellerEmail) {
        sendSellerLowStockEmail(
          product.sellerEmail,
          product.sellerName || "Seller",
          product.title,
          Number(product.stock),
          product.id
        ).then(result => {
          if (!result.success) console.warn(`⚠️  [Admin scan] Email not sent to ${product.sellerEmail}: ${result.error}`);
          else console.log(`✅ [Admin scan] Email sent to ${product.sellerEmail} for "${product.title}"`);
        }).catch(err => console.error("Low stock email error:", err.message));
      } else {
        console.warn(`⚠️  [Admin scan] No email for seller ${product.sellerId} — email skipped`);
      }

      // Email all admins (non-blocking)
      prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } })
        .then(admins => {
          for (const admin of admins) {
            if (admin.email) {
              sendAdminLowStockDeactivationEmail(admin.email, admin.name || 'Admin', {
                productTitle: product.title,
                sellerName:   product.sellerName || 'Unknown',
                stock:        Number(product.stock),
                productId:    product.id
              }).catch(err => console.error('Admin low stock deactivation email error:', err.message));
            }
          }
        }).catch(err => console.error('Admin lookup error (low stock deactivation email):', err.message));

      results.push({ productId: product.id, title: product.title, stock: Number(product.stock) });
      console.log(`⚠️  [Admin scan] Deactivated "${product.title}" — stock: ${product.stock}`);
    }

    return reply.status(200).send({
      success: true,
      message: `Scan complete. ${results.length} low-stock product(s) deactivated and sellers notified.`,
      deactivated: results.length,
      products: results
    });
  } catch (error) {
    console.error("scanLowStockProducts error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// GET ALL ORDERS (ADMIN ONLY) - Shows all orders across all sellers
exports.getAllOrders = async (request, reply) => {
  try {
    // Only admin can access
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    // Get all direct orders, sub-orders, and legacy orders
    const [directOrders, subOrders, legacyOrders] = await Promise.all([
      // Direct orders (single seller orders)
      prisma.order.findMany({
        where: {
          sellerId: { not: null } // Has direct seller assignment
        },
        orderBy: { createdAt: 'desc' },
        include: {
          items: {
            include: {
              product: {
                include: {
                  seller: {
                    select: { id: true, name: true, email: true }
                  }
                }
              }
            }
          },
          user: {
            select: { id: true, name: true, email: true, phone: true }
          }
        }
      }),

      // Sub-orders (multi-seller orders)
      prisma.subOrder.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          items: {
            include: {
              product: {
                include: {
                  seller: {
                    select: { id: true, name: true, email: true }
                  }
                }
              }
            }
          },
          seller: {
            select: { id: true, name: true, email: true }
          },
          parentOrder: {
            include: {
              user: {
                select: { id: true, name: true, email: true, phone: true }
              }
            }
          }
        }
      }),

      // Legacy orders (old orders without sellerId but with items)
      prisma.order.findMany({
        where: {
          sellerId: null, // No direct seller assignment
          items: {
            some: {} // Has items
          }
        },
        orderBy: { createdAt: 'desc' },
        include: {
          items: {
            include: {
              product: {
                include: {
                  seller: {
                    select: { id: true, name: true, email: true }
                  }
                }
              }
            }
          },
          user: {
            select: { id: true, name: true, email: true, phone: true }
          },
          subOrders: true // Check if it has sub-orders
        }
      })
    ]);

    // Filter legacy orders to exclude those with sub-orders (avoid duplicates)
    const filteredLegacyOrders = legacyOrders.filter(order => order.subOrders.length === 0);

    // Transform direct orders
    const transformedDirectOrders = directOrders.map(order => ({
      id:           order.id,
      displayId:    toDisplayId(order.displayId),
      type:         'DIRECT',
      sellerId:     order.sellerId,
      sellerName:   order.items[0]?.product?.seller?.name || 'Unknown',
      status:       order.status || order.overallStatus,
      totalAmount:  order.totalAmount,
      paymentStatus:  order.paymentStatus,
      customerName:   order.user?.name  || order.customerName,
      customerEmail:  order.user?.email || order.customerEmail,
      itemCount:    order.items.length,
      createdAt:    order.createdAt,
      updatedAt:    order.updatedAt,
      ...(order.user ? {} : { isGuest: 'guest' }),
    }));

    // Group sub-orders by parentOrderId so we can assign A/B/C suffixes correctly
    const subOrdersByParent = {};
    subOrders.forEach(sub => {
      if (!subOrdersByParent[sub.parentOrderId]) subOrdersByParent[sub.parentOrderId] = [];
      subOrdersByParent[sub.parentOrderId].push(sub);
    });

    // Transform sub-orders
    const transformedSubOrders = subOrders.map(subOrder => {
      const siblings    = subOrdersByParent[subOrder.parentOrderId];
      const idx         = siblings.indexOf(subOrder);
      // Derive the parent order's real status from ALL sibling sub-orders
      const parentStatus = deriveMultiSellerStatus(siblings.map(s => s.status));
      return {
        id:              subOrder.id,
        displaySubId:    toSubDisplayId(subOrder.parentOrder?.displayId ?? subOrder.parentOrderId, idx),
        parentOrderId:   subOrder.parentOrderId,
        parentDisplayId: toDisplayId(subOrder.parentOrder?.displayId ?? subOrder.parentOrderId),
        type:            'SUB_ORDER',
        sellerId:        subOrder.sellerId,
        sellerName:      subOrder.seller?.name || 'Unknown',
        status:          subOrder.status,
        parentStatus,
        totalAmount:     subOrder.subtotal,
        paymentStatus:   subOrder.parentOrder?.paymentStatus,
        customerName:    subOrder.parentOrder?.user?.name  || subOrder.parentOrder?.customerName,
        customerEmail:   subOrder.parentOrder?.user?.email || subOrder.parentOrder?.customerEmail,
        itemCount:       subOrder.items.length,
        createdAt:       subOrder.createdAt,
        updatedAt:       subOrder.updatedAt,
        ...(subOrder.parentOrder?.user ? {} : { isGuest: 'guest' }),
      };
    });

    // Transform legacy orders
    const transformedLegacyOrders = filteredLegacyOrders.map(order => {
      // Group items by seller
      const sellerGroups = {};
      order.items.forEach(item => {
        const sellerId = item.product?.sellerId;
        if (sellerId) {
          if (!sellerGroups[sellerId]) {
            sellerGroups[sellerId] = {
              sellerId:   sellerId,
              sellerName: item.product?.seller?.name || 'Unknown',
              items:      [],
              subtotal:   0,
            };
          }
          sellerGroups[sellerId].items.push(item);
          sellerGroups[sellerId].subtotal += parseFloat(item.price || 0) * item.quantity;
        }
      });

      // Assign A/B/C suffix per seller within this legacy order
      return Object.values(sellerGroups).map((group, idx) => ({
        id:              order.id,
        displaySubId:    toSubDisplayId(order.displayId, idx),
        parentOrderId:   order.id,
        parentDisplayId: toDisplayId(order.displayId),
        originalOrderId: order.id,
        type:            'SUB_ORDER',
        sellerId:        group.sellerId,
        sellerName:      group.sellerName,
        status:          order.status || order.overallStatus,
        totalAmount:     group.subtotal,
        paymentStatus:   order.paymentStatus,
        customerName:    order.user?.name  || order.customerName,
        customerEmail:   order.user?.email || order.customerEmail,
        itemCount:       group.items.length,
        createdAt:       order.createdAt,
        updatedAt:       order.updatedAt,
        ...(order.user ? {} : { isGuest: 'guest' }),
      }));
    }).flat();

    // Combine all orders and sort by creation date (newest first)
    const allOrders = [...transformedDirectOrders, ...transformedSubOrders, ...transformedLegacyOrders]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    console.log(`[Admin] Found ${allOrders.length} total orders: ${transformedDirectOrders.length} direct, ${transformedSubOrders.length} sub-orders, ${transformedLegacyOrders.length} legacy`);

    return reply.status(200).send({
      success: true,
      orders: allOrders,
      count: allOrders.length,
      breakdown: {
        direct: transformedDirectOrders.length,
        subOrders: transformedSubOrders.length + transformedLegacyOrders.length,
        total: allOrders.length
      }
    });
  } catch (error) {
    console.error('Get all orders error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// GET ORDERS BY SELLER ID (ADMIN ONLY) - Updated to include legacy orders
exports.getOrdersBySellerId = async (request, reply) => {
  try {
    // Only admin can access (route preHandler should enforce, but double-check)
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }
    const { sellerId } = request.params;
    
    // Get orders for this seller from multiple sources
    const [subOrders, directOrders, oldOrders] = await Promise.all([
      // Sub-orders for this specific seller (multi-seller orders)
      prisma.subOrder.findMany({
        where: {
          sellerId: sellerId
        },
        orderBy: {
          createdAt: 'desc'
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  title: true,
                  featuredImage: true,
                  price: true,
                  sellerId: true
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
          parentOrder: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  phone: true,
                  role: true,
                  createdAt: true
                }
              }
            }
          }
        }
      }),

      // Direct orders (single seller orders with sellerId)
      prisma.order.findMany({
        where: {
          sellerId: sellerId
        },
        orderBy: {
          createdAt: 'desc'
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  title: true,
                  featuredImage: true,
                  price: true,
                  sellerId: true
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
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              role: true,
              createdAt: true
            }
          }
        }
      }),

      // Old orders (sellerId=null) - check if they're DIRECT for this seller
      prisma.order.findMany({
        where: {
          sellerId: null,
          items: {
            some: {
              product: {
                sellerId: sellerId
              }
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  title: true,
                  featuredImage: true,
                  price: true,
                  sellerId: true
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
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              role: true,
              createdAt: true
            }
          }
        }
      })
    ]);

    // Process old orders to determine if they're DIRECT for this seller
    const processedOldOrders = oldOrders
      .map(order => {
        // Get only this seller's items
        const sellerItems = order.items.filter(item => item.product?.sellerId === sellerId);
        
        // Check if this order involves only this seller
        const uniqueSellerIds = new Set(order.items.map(item => item.product?.sellerId).filter(Boolean));
        const isDirectOrder = uniqueSellerIds.size === 1 && uniqueSellerIds.has(sellerId);
        
        if (sellerItems.length === 0) return null;
        
        return {
          ...order,
          items: sellerItems,
          isDirectOrder
        };
      })
      .filter(Boolean);

    // Combine direct orders with old direct orders
    const allDirectOrders = [...directOrders, ...processedOldOrders.filter(o => o.isDirectOrder)];
    const legacyMultiSellerOrders = processedOldOrders.filter(o => !o.isDirectOrder);

    console.log(`[Admin] Found ${allDirectOrders.length} direct orders, ${subOrders.length} sub-orders, and ${legacyMultiSellerOrders.length} legacy multi-seller orders for seller ${sellerId}`);

    // Fetch ALL siblings for every parent so A/B/C index is globally stable
    const parentIds = [...new Set(subOrders.map(s => s.parentOrderId))];
    const globalSubsByParent = {};
    if (parentIds.length > 0) {
      const allSiblings = await prisma.subOrder.findMany({
        where: { parentOrderId: { in: parentIds } },
        select: { id: true, parentOrderId: true },
        orderBy: { createdAt: 'asc' }
      });
      allSiblings.forEach(s => {
        if (!globalSubsByParent[s.parentOrderId]) globalSubsByParent[s.parentOrderId] = [];
        globalSubsByParent[s.parentOrderId].push(s.id);
      });
    }

    // Transform sub-orders to include parent order info and seller-specific data
    const transformedSubOrders = subOrders.map(subOrder => {
      const siblings = globalSubsByParent[subOrder.parentOrderId] || [];
      const idx      = siblings.indexOf(subOrder.id);
      return ({
      id: subOrder.id,
      displaySubId:    toSubDisplayId(subOrder.parentOrder?.displayId ?? subOrder.parentOrderId, idx),
      subOrderId: subOrder.id,
      parentOrderId: subOrder.parentOrderId,
      parentDisplayId: toDisplayId(subOrder.parentOrder?.displayId ?? subOrder.parentOrderId),
      sellerId: subOrder.sellerId,
      status: subOrder.status,
      trackingNumber: subOrder.trackingNumber,
      estimatedDelivery: subOrder.estimatedDelivery,
      subtotal: subOrder.subtotal,
      createdAt: subOrder.createdAt,
      updatedAt: subOrder.updatedAt,
      type: 'SUB_ORDER',
      
      // Parent order fields
      totalAmount: subOrder.parentOrder.totalAmount, // Full order total (for context)
      paymentMethod: subOrder.parentOrder.paymentMethod,
      paymentStatus: subOrder.parentOrder.paymentStatus,
      shippingAddress: subOrder.parentOrder.shippingAddress,
      shippingAddressLine: subOrder.parentOrder.shippingAddressLine,
      shippingCity: subOrder.parentOrder.shippingCity,
      shippingState: subOrder.parentOrder.shippingState,
      shippingZipCode: subOrder.parentOrder.shippingZipCode,
      shippingCountry: subOrder.parentOrder.shippingCountry,
      shippingPhone: subOrder.parentOrder.shippingPhone,
      customerName: subOrder.parentOrder.customerName,
      customerEmail: subOrder.parentOrder.customerEmail,
      customerPhone: subOrder.parentOrder.customerPhone,
      
      // Customer info
      user: subOrder.parentOrder.user,
      
      items: trimItems(subOrder.items),
      isSubOrder: true,
      sellerSpecific: true,
      ...(subOrder.parentOrder?.user ? {} : { isGuest: 'guest' })
    });});

    // Transform direct orders
    const transformedDirectOrders = allDirectOrders.map(order => ({
      id: order.id,
      displayId: toDisplayId(order.displayId),
      subOrderId: null,
      parentOrderId: null,
      sellerId: order.sellerId || sellerId,
      status: order.status || order.overallStatus,
      trackingNumber: order.trackingNumber,
      estimatedDelivery: order.estimatedDelivery,
      subtotal: order.totalAmount || order.items.reduce((sum, item) => sum + (parseFloat(item.price || 0) * item.quantity), 0),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      type: 'DIRECT',
      
      // Order fields
      totalAmount: order.totalAmount,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      shippingAddress: order.shippingAddress,
      shippingAddressLine: order.shippingAddressLine,
      shippingCity: order.shippingCity,
      shippingState: order.shippingState,
      shippingZipCode: order.shippingZipCode,
      shippingCountry: order.shippingCountry,
      shippingPhone: order.shippingPhone,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      
      user: order.user,
      items: trimItems(order.items),
      isSubOrder: false,
      sellerSpecific: true,
      ...(order.user ? {} : { isGuest: 'guest' })
    }));

    // Transform legacy multi-seller old orders (show only this seller's items)
    const transformedLegacyOrders = legacyMultiSellerOrders.map((order, idx) => ({
      id: order.id,
      displaySubId: toSubDisplayId(order.displayId, idx),
      subOrderId: null,
      parentOrderId: order.id,
      parentDisplayId: toDisplayId(order.displayId),
      sellerId: sellerId,
      status: order.status || order.overallStatus,
      trackingNumber: order.trackingNumber,
      estimatedDelivery: order.estimatedDelivery,
      subtotal: order.items.reduce((sum, item) => sum + (parseFloat(item.price || 0) * item.quantity), 0),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      type: 'SUB_ORDER',
      totalAmount: order.totalAmount,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      shippingAddress: order.shippingAddress,
      shippingAddressLine: order.shippingAddressLine,
      shippingCity: order.shippingCity,
      shippingState: order.shippingState,
      shippingZipCode: order.shippingZipCode,
      shippingCountry: order.shippingCountry,
      shippingPhone: order.shippingPhone,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      user: order.user,
      items: trimItems(order.items),
      isSubOrder: true,
      sellerSpecific: true,
      ...(order.user ? {} : { isGuest: 'guest' })
    }));

    // Combine all order types and sort by creation date (newest first)
    const allOrders = [...transformedDirectOrders, ...transformedSubOrders, ...transformedLegacyOrders]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    reply.send({ 
      success: true, 
      orders: allOrders, 
      count: allOrders.length,
      sellerId: sellerId,
      breakdown: {
        directOrders: transformedDirectOrders.length,
        subOrders: transformedSubOrders.length + transformedLegacyOrders.length,
        total: allOrders.length
      },
      note: "Showing direct and sub-orders for this specific seller."
    });
  } catch (error) {
    console.error('Get orders by sellerId error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// GET ALL USERS (role: "CUSTOMER", excluding deleted users)
exports.getAllUsers = async (request, reply) => {
  try {
    const { includeDeleted = false } = request.query;
    
    const whereClause = {
      role: "CUSTOMER",
      ...(includeDeleted !== 'true' ? { isDeleted: false } : {})
    };

    const users = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        isVerified: true,
        emailVerified: true,
        isDeleted: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const activeUsers = users.filter(u => !u.isDeleted);
    const deletedUsers = users.filter(u => u.isDeleted);

    return reply.status(200).send({ 
      success: true, 
      users: includeDeleted === 'true' ? users : activeUsers,
      count: includeDeleted === 'true' ? users.length : activeUsers.length,
      summary: {
        active: activeUsers.length,
        deleted: deletedUsers.length,
        total: users.length
      }
    });
  } catch (err) {
    console.error("Get all users error:", err);
    reply.status(500).send({ success: false, error: err.message });
  }
};

// SOFT DELETE USER — moves to recycle bin (Admin only)
exports.softDeleteUser = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { userId } = request.params;
    const { reason } = request.body || {};

    const existingUser = await prisma.user.findUnique({ 
      where: { id: userId },
      include: {
        orders: { select: { id: true, displayId: true } },
        sellerOrders: { select: { id: true, displayId: true } },
        sellerProfile: { select: { id: true, businessName: true } }
      }
    });

    if (!existingUser) {
      return reply.status(404).send({ success: false, message: 'User not found' });
    }

    if (existingUser.isDeleted) {
      return reply.status(400).send({ success: false, message: 'User is already in the recycle bin' });
    }

    // Prevent deletion of ADMIN/SUPER_ADMIN users
    if (['ADMIN', 'SUPER_ADMIN'].includes(existingUser.role)) {
      return reply.status(400).send({ success: false, message: 'Cannot delete admin users' });
    }

    const now = new Date();
    const adminId = request.user.userId || request.user.uid;

    // Soft delete the user - orders will be preserved due to onDelete: SetNull
    const deletedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        isDeleted: true,
        deletedAt: now,
        deletedBy: adminId,
        deletedReason: reason || 'User account deleted by admin',
        email: `deleted_${now.getTime()}_${existingUser.email}` // Prevent email conflicts
      }
    });

    // Immediately anonymize PII from all related tables — don't wait for 15-min scheduler
    const immediateCleanupErrors = [];

    // 1. Site feedback — match by userId AND by original email (covers guest submissions)
    const siteFeedbackWhere = existingUser.email
      ? { OR: [{ userId }, { email: existingUser.email }] }
      : { userId };
    await prisma.siteFeedback.updateMany({
      where: siteFeedbackWhere,
      data: { name: 'Deleted User', email: 'hidden@privacy.local' }
    }).catch(err => immediateCleanupErrors.push(`siteFeedback: ${err.message}`));

    // 2. Contact messages — no userId FK, must match by original email
    if (existingUser.email) {
      await prisma.contactMessage.updateMany({
        where: { email: existingUser.email },
        data: { fullName: 'Deleted User', email: 'hidden@privacy.local', phoneNumber: null }
      }).catch(err => immediateCleanupErrors.push(`contactMessage: ${err.message}`));
    }

    // 3. Commission records — store customerName/customerEmail directly, match by customerId
    await prisma.commissionEarned.updateMany({
      where: { customerId: userId },
      data: { customerName: 'Deleted User', customerEmail: 'hidden@privacy.local' }
    }).catch(err => immediateCleanupErrors.push(`commissionEarned: ${err.message}`));

    // 4. Notifications — clear any message/title text containing the user's name or email
    try {
      const orConditions = [];
      if (existingUser.name) {
        orConditions.push({ message: { contains: existingUser.name } });
        orConditions.push({ title:   { contains: existingUser.name } });
      }
      if (existingUser.email) {
        orConditions.push({ message: { contains: existingUser.email } });
        orConditions.push({ title:   { contains: existingUser.email } });
      }
      if (orConditions.length > 0) {
        const affectedNotifs = await prisma.notification.findMany({
          where: { OR: orConditions },
          select: { id: true, title: true, message: true, metadata: true }
        });
        for (const notif of affectedNotifs) {
          let title   = notif.title   || '';
          let message = notif.message || '';
          if (existingUser.name) {
            const re = new RegExp(existingUser.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            title   = title.replace(re, 'Deleted User');
            message = message.replace(re, 'Deleted User');
          }
          if (existingUser.email) {
            const re = new RegExp(existingUser.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            title   = title.replace(re, 'hidden@privacy.local');
            message = message.replace(re, 'hidden@privacy.local');
          }
          let metadata = notif.metadata;
          if (metadata) {
            try {
              let s = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
              if (existingUser.name)  s = s.replace(new RegExp(existingUser.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),  'gi'), 'Deleted User');
              if (existingUser.email) s = s.replace(new RegExp(existingUser.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'hidden@privacy.local');
              metadata = JSON.parse(s);
            } catch (_) {}
          }
          await prisma.notification.update({
            where: { id: notif.id },
            data: { title, message, metadata }
          });
        }
      }
    } catch (err) {
      immediateCleanupErrors.push(`notifications: ${err.message}`);
    }

    if (immediateCleanupErrors.length > 0) {
      console.warn(`[SoftDelete] Cleanup warnings for user ${userId}:`, immediateCleanupErrors);
    }

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType: ENTITY_TYPES.USER || 'USER',
      entityId: userId,
      action: AUDIT_ACTIONS.USER_SOFT_DELETED || 'USER_SOFT_DELETED',
      ...meta,
      previousData: existingUser,
      newData: deletedUser,
      reason: reason || `User "${existingUser.name}" moved to recycle bin`,
    });

    const orderCount = existingUser.orders.length + existingUser.sellerOrders.length;
    
    reply.send({
      success: true,
      message: `User "${existingUser.name}" moved to recycle bin. ${orderCount} orders preserved.`,
      data: { 
        id: userId, 
        name: existingUser.name,
        email: existingUser.email,
        deletedAt: now,
        preservedOrders: orderCount
      }
    });
  } catch (error) {
    console.error('Soft delete user error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// GET USER RECYCLE BIN — list all soft-deleted users (Admin only)
exports.getUserRecycleBin = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { page = 1, limit = 50, role } = request.query;
    const take = Math.min(Number(limit), 200);
    const offset = (Number(page) - 1) * take;

    const whereClause = {
      isDeleted: true,
      ...(role ? { role } : {})
    };

    const [deletedUsers, totalCount] = await Promise.all([
      prisma.user.findMany({
        where: whereClause,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isVerified: true,
          emailVerified: true,
          createdAt: true,
          deletedAt: true,
          deletedBy: true,
          deletedReason: true,
          orders: { select: { id: true, displayId: true, totalAmount: true } },
          sellerOrders: { select: { id: true, displayId: true, totalAmount: true } },
          sellerProfile: { select: { businessName: true, storeName: true } }
        },
        orderBy: { deletedAt: 'desc' },
        take,
        skip: offset
      }),
      prisma.user.count({ where: whereClause })
    ]);

    // Include admin who deleted each user
    const adminIds = [...new Set(deletedUsers.map(u => u.deletedBy).filter(Boolean))];
    const admins = await prisma.user.findMany({
      where: { id: { in: adminIds } },
      select: { id: true, name: true, email: true }
    });
    const adminMap = new Map(admins.map(a => [a.id, a]));

    const now = new Date();
    const formattedUsers = deletedUsers.map(user => {
      const minutesSinceDeleted = Math.floor((now - new Date(user.deletedAt)) / (1000 * 60));
      const minutesUntilCleanup = Math.max(0, 15 - minutesSinceDeleted);
      const isAnonymized = user.email.includes('@deleted.local');
      
      return {
        ...user,
        deletedByAdmin: adminMap.get(user.deletedBy) || null,
        orderCount: user.orders.length + user.sellerOrders.length,
        totalOrderValue: [...user.orders, ...user.sellerOrders]
          .reduce((sum, order) => sum + parseFloat(order.totalAmount || 0), 0),
        minutesSinceDeleted,
        minutesUntilAutoCleanup: isAnonymized ? 0 : minutesUntilCleanup,
        autoCleanupStatus: isAnonymized 
          ? 'ANONYMIZED' 
          : minutesUntilCleanup <= 5 
            ? `SCHEDULED_${minutesUntilCleanup}_MINUTES`
            : `PENDING_${minutesUntilCleanup}_MINUTES`,
        canRestore: !isAnonymized // Cannot restore anonymized users
      };
    });

    const summary = {
      total: totalCount,
      anonymized: formattedUsers.filter(u => u.autoCleanupStatus === 'ANONYMIZED').length,
      scheduledForCleanup: formattedUsers.filter(u => u.minutesUntilAutoCleanup <= 5 && u.minutesUntilAutoCleanup > 0).length,
      restorable: formattedUsers.filter(u => u.canRestore).length
    };

    reply.send({
      success: true,
      data: formattedUsers,
      pagination: {
        page: Number(page),
        limit: take,
        total: totalCount,
        totalPages: Math.ceil(totalCount / take)
      },
      summary,
      autoCleanupInfo: {
        schedule: 'Every 5 minutes (TESTING)',
        retentionPeriod: '15 minutes (TESTING)',
        description: 'User data automatically anonymized after 15 minutes in recycle bin (TESTING)'
      }
    });
  } catch (error) {
    console.error('Get user recycle bin error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// RESTORE USER from recycle bin (Admin only)
exports.restoreUser = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { userId } = request.params;

    const existingUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!existingUser) {
      return reply.status(404).send({ success: false, message: 'User not found' });
    }

    if (!existingUser.isDeleted) {
      return reply.status(400).send({ success: false, message: 'User is not in the recycle bin' });
    }

    // Check if user has been anonymized (cannot restore anonymized users)
    if (existingUser.email.includes('@deleted.local')) {
      return reply.status(400).send({
        success: false,
        message: 'Cannot restore anonymized user. User data was automatically cleaned up after 15 minutes in recycle bin (TESTING).'
      });
    }

    // Check if original email is available (remove the deleted prefix)
    const originalEmail = existingUser.email.replace(/^deleted_\d+_/, '');
    const emailConflict = await prisma.user.findFirst({
      where: {
        email: originalEmail,
        isDeleted: false,
        id: { not: userId }
      }
    });

    if (emailConflict) {
      return reply.status(400).send({ 
        success: false, 
        message: `Cannot restore user: email "${originalEmail}" is already in use by another active account` 
      });
    }

    const now = new Date();
    const adminId = request.user.userId || request.user.uid;

    const restoredUser = await prisma.user.update({
      where: { id: userId },
      data: {
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
        email: originalEmail // Restore original email
      }
    });

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType: ENTITY_TYPES.USER || 'USER',
      entityId: userId,
      action: AUDIT_ACTIONS.USER_RESTORED || 'USER_RESTORED',
      ...meta,
      previousData: existingUser,
      newData: restoredUser,
      reason: `User "${existingUser.name}" restored from recycle bin`,
    });

    reply.send({
      success: true,
      message: `User "${existingUser.name}" has been restored`,
      data: {
        id: userId,
        name: restoredUser.name,
        email: restoredUser.email,
        restoredAt: now
      }
    });
  } catch (error) {
    console.error('Restore user error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// AUTO-CLEANUP EXPIRED USERS — anonymize data after 15 minutes in recycle bin (TESTING) (Admin only)
exports.cleanupExpiredUsers = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const fifteenMinutesAgo = new Date();
    fifteenMinutesAgo.setMinutes(fifteenMinutesAgo.getMinutes() - 15);

    // Find users deleted more than 15 minutes ago (TESTING)
    const expiredUsers = await prisma.user.findMany({
      where: {
        isDeleted: true,
        deletedAt: {
          lte: fifteenMinutesAgo
        },
        // Don't process already anonymized users
        email: {
          not: {
            contains: '@deleted.local'
          }
        }
      },
      include: {
        orders: { select: { id: true, displayId: true } },
        sellerOrders: { select: { id: true, displayId: true } }
      }
    });

    if (expiredUsers.length === 0) {
      return reply.status(200).send({
        success: true,
        message: 'No expired users found for cleanup',
        processed: 0
      });
    }

    const adminId = request.user.userId || request.user.uid;
    const processedUsers = [];

    for (const user of expiredUsers) {
      try {
        const anonymizedEmail = `user${Date.now().toString().slice(-6)}@deleted.local`;
        const orderCount = user.orders.length + user.sellerOrders.length;

        // Anonymize user data but keep the record
        await prisma.user.update({
          where: { id: user.id },
          data: {
            name: 'Deleted User',
            email: anonymizedEmail,
            phone: null,
            profileImage: null,  // Remove profile photo
            password: 'ANONYMIZED_ACCOUNT', // Prevent any login attempts
            deletedReason: `Auto-anonymized after 8 hours by system on ${new Date().toISOString()} (TESTING)`
          }
        });

        // Update order records to show anonymized customer info
        if (orderCount > 0) {
          // Update customer orders with anonymized data
          await prisma.order.updateMany({
            where: { userId: user.id },
            data: {
              customerName: 'Deleted User',
              customerEmail: anonymizedEmail,
              customerPhone: 'Hidden',
              shippingAddressLine: 'Hidden Address',
              shippingCity: 'Hidden City',
              shippingState: 'Hidden State',
              shippingCountry: 'Hidden Country',
              shippingZipCode: 'Hidden',
              shippingPhone: 'Hidden',
              // Keep shippingAddress JSON as null or anonymize if exists
              shippingAddress: null
            }
          });

          // Note: Seller orders don't need customer info updates since they're seller-specific
        }

        // Anonymize user addresses (if any remain linked)
        await prisma.userAddress.updateMany({
          where: { userId: user.id },
          data: {
            shippingAddress: 'Hidden Address',
            city: 'Hidden City',
            state: 'Hidden State',
            country: 'Hidden Country',
            zipCode: 'Hidden',
            mobileNumber: 'Hidden'
          }
        });

        // Anonymize all other customer data
        await Promise.all([
          // Site feedback
          prisma.siteFeedback.updateMany({
            where: { userId: user.id },
            data: { 
              name: 'Deleted User',
              email: 'hidden@privacy.local'
            }
          }).catch(err => console.warn('[Manual-Cleanup] SiteFeedback error:', err.message)),

          // Contact messages — no userId FK, match by original email
          user.email
            ? prisma.contactMessage.updateMany({
                where: { email: user.email },
                data: { fullName: 'Deleted User', email: 'hidden@privacy.local', phoneNumber: null }
              }).catch(err => console.warn('[Manual-Cleanup] ContactMessage error:', err.message))
            : Promise.resolve(),

          // Commission records — store customerName/customerEmail directly
          prisma.commissionEarned.updateMany({
            where: { customerId: user.id },
            data: { customerName: 'Deleted User', customerEmail: 'hidden@privacy.local' }
          }).catch(err => console.warn('[Manual-Cleanup] CommissionEarned error:', err.message)),

          // Support tickets (no content changes needed - only user identity removal)
          // Support tickets will show as from deleted user through userId=null relationship
          
          // Product ratings/reviews (keep review content, identity removed through userId=null)
          // Ratings will show as anonymous through the deleted user relationship
          
          // Personal notifications (belonging to deleted user)
          prisma.notification.updateMany({
            where: { 
              userId: user.id,
              type: { in: ['GENERAL', 'PERSONAL'] }
            },
            data: { 
              title: 'Notification from Deleted User',
              message: 'Personal notification content hidden for privacy',
              metadata: null // Clear any personal metadata
            }
          }).catch(err => console.warn('[Manual-Cleanup] Notification error:', err.message))
        ]);
        
        // Update notifications containing user name or email (separate process)
        try {
          const orConditions = [];
          if (user.name) {
            orConditions.push({ message: { contains: user.name } });
            orConditions.push({ title: { contains: user.name } });
          }
          if (user.email) {
            orConditions.push({ message: { contains: user.email } });
            orConditions.push({ title: { contains: user.email } });
          }

          if (orConditions.length > 0) {
            const userNotifications = await prisma.notification.findMany({
              where: { OR: orConditions },
              select: { id: true, title: true, message: true, metadata: true }
            });
            
            for (const notif of userNotifications) {
              let updatedTitle = notif.title || '';
              let updatedMessage = notif.message || '';

              if (user.name) {
                const nameRe = new RegExp(user.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                updatedTitle = updatedTitle.replace(nameRe, 'Deleted User');
                updatedMessage = updatedMessage.replace(nameRe, 'Deleted User');
              }
              if (user.email) {
                const emailRe = new RegExp(user.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                updatedTitle = updatedTitle.replace(emailRe, 'hidden@privacy.local');
                updatedMessage = updatedMessage.replace(emailRe, 'hidden@privacy.local');
              }

              // Also sanitize metadata JSON
              let updatedMetadata = notif.metadata;
              if (updatedMetadata) {
                try {
                  let metaStr = typeof updatedMetadata === 'string'
                    ? updatedMetadata
                    : JSON.stringify(updatedMetadata);
                  if (user.name) {
                    metaStr = metaStr.replace(
                      new RegExp(user.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                      'Deleted User'
                    );
                  }
                  if (user.email) {
                    metaStr = metaStr.replace(
                      new RegExp(user.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                      'hidden@privacy.local'
                    );
                  }
                  updatedMetadata = JSON.parse(metaStr);
                } catch (_) {
                  // If metadata can't be parsed/stringified safely, leave as-is
                }
              }

              await prisma.notification.update({
                where: { id: notif.id },
                data: {
                  title: updatedTitle,
                  message: updatedMessage,
                  metadata: updatedMetadata
                }
              });
            }
            
            console.log(`[Manual-Cleanup] Updated ${userNotifications.length} notifications containing user name/email`);
          }
        } catch (notifError) {
          console.warn('[Manual-Cleanup] Notification content update error:', notifError.message);
        }

        // Log the anonymization
        const meta = extractRequestMeta(request);
        await auditLog({
          entityType: ENTITY_TYPES.USER || 'USER',
          entityId: user.id,
          action: AUDIT_ACTIONS.USER_AUTO_ANONYMIZED || 'USER_AUTO_ANONYMIZED',
          ...meta,
          previousData: { name: user.name, email: user.email, phone: user.phone },
          newData: { name: 'Deleted User', email: anonymizedEmail, phone: null },
          reason: `Auto-anonymized after 15 minutes in recycle bin (TESTING). ${orderCount} orders preserved.`,
        });

        processedUsers.push({
          id: user.id,
          originalName: user.name,
          originalEmail: user.email,
          orderCount,
          deletedAt: user.deletedAt,
          anonymizedAt: new Date()
        });

      } catch (userError) {
        console.error(`Error anonymizing user ${user.id}:`, userError);
      }
    }

    reply.send({
      success: true,
      message: `Successfully anonymized ${processedUsers.length} expired user accounts`,
      processed: processedUsers.length,
      total: expiredUsers.length,
      data: processedUsers.map(u => ({
        id: u.id,
        originalName: u.originalName,
        orderCount: u.orderCount,
        minutesSinceDeleted: Math.floor((new Date() - new Date(u.deletedAt)) / (1000 * 60)),
        anonymizedAt: u.anonymizedAt
      }))
    });

  } catch (error) {
    console.error('Cleanup expired users error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// BACKFILL PII ANONYMIZATION — one-time fix for records created before the auto-anonymize code was deployed
// Finds all soft-deleted users and anonymizes any stale PII in site_feedback and contact_messages
exports.backfillPiiAnonymization = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    // Get all deleted users (both anonymized and non-anonymized)
    const deletedUsers = await prisma.user.findMany({
      where: { isDeleted: true },
      select: { id: true, name: true, email: true }
    });

    let siteFeedbackFixed = 0;
    let contactMessageFixed = 0;

    for (const user of deletedUsers) {
      // Recover original email: remove the deleted_ prefix if present, or use as-is for @deleted.local
      const originalEmail = user.email.startsWith('deleted_')
        ? user.email.replace(/^deleted_\d+_/, '')
        : user.email; // already anonymized — use it to catch anything missed

      // Fix site_feedback rows still holding real email
      const sfResult = await prisma.siteFeedback.updateMany({
        where: {
          OR: [
            { userId: user.id },
            ...(originalEmail && !originalEmail.includes('@deleted.local')
              ? [{ email: originalEmail }]
              : [])
          ],
          NOT: { email: 'hidden@privacy.local' } // skip already-anonymized rows
        },
        data: { name: 'Deleted User', email: 'hidden@privacy.local' }
      }).catch(() => ({ count: 0 }));
      siteFeedbackFixed += sfResult.count;

      // Fix contact_message rows still holding real email
      if (originalEmail && !originalEmail.includes('@deleted.local')) {
        const cmResult = await prisma.contactMessage.updateMany({
          where: {
            email: originalEmail,
            NOT: { email: 'hidden@privacy.local' }
          },
          data: { fullName: 'Deleted User', email: 'hidden@privacy.local', phoneNumber: null }
        }).catch(() => ({ count: 0 }));
        contactMessageFixed += cmResult.count;
      }

      // Fix commission_earned rows still holding real customer name/email
      await prisma.commissionEarned.updateMany({
        where: {
          customerId: user.id,
          NOT: { customerEmail: 'hidden@privacy.local' }
        },
        data: { customerName: 'Deleted User', customerEmail: 'hidden@privacy.local' }
      }).catch(() => {});
    }

    return reply.status(200).send({
      success: true,
      message: 'Backfill complete',
      fixed: {
        siteFeedbackRows: siteFeedbackFixed,
        contactMessageRows: contactMessageFixed
      }
    });
  } catch (error) {
    console.error('Backfill PII anonymization error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// SCHEDULED AUTO-CLEANUP — Run this every 5 minutes via cron job or scheduler (TESTING: 15 minutes)
exports.autoCleanupExpiredUsers = async (retentionMinutes = 15) => {
  try {
    const cutoffTime = new Date();
    cutoffTime.setMinutes(cutoffTime.getMinutes() - retentionMinutes);

    const expiredUsers = await prisma.user.findMany({
      where: {
        isDeleted: true,
        deletedAt: { lte: cutoffTime },
        email: { not: { contains: '@deleted.local' } }
      },
      select: { id: true, name: true, email: true, deletedAt: true }
    });

    if (expiredUsers.length === 0) {
      console.log(`[Auto-Cleanup] No expired users to anonymize (${retentionMinutes}min testing)`);
      return { processed: 0, message: 'No expired users found' };
    }

    let processed = 0;
    for (const user of expiredUsers) {
      try {
        const anonymizedEmail = `user${Date.now().toString().slice(-6)}@deleted.local`;
        
        await prisma.user.update({
          where: { id: user.id },
          data: {
            name: 'Deleted User',
            email: anonymizedEmail,
            phone: null,
            profileImage: null,
            password: 'ANONYMIZED_ACCOUNT',
            deletedReason: `Auto-anonymized after ${retentionMinutes} minutes by system on ${new Date().toISOString()}`
          }
        });

        // Update related orders
        await prisma.order.updateMany({
          where: { userId: user.id },
          data: {
            customerName: 'Deleted User',
            customerEmail: anonymizedEmail,
            customerPhone: 'Hidden',
            shippingAddressLine: 'Hidden Address',
            shippingCity: 'Hidden City', 
            shippingState: 'Hidden State',
            shippingCountry: 'Hidden Country',
            shippingZipCode: 'Hidden',
            shippingPhone: 'Hidden',
            shippingAddress: null
          }
        });

        // Anonymize user addresses
        await prisma.userAddress.updateMany({
          where: { userId: user.id },
          data: {
            shippingAddress: 'Hidden Address',
            city: 'Hidden City',
            state: 'Hidden State', 
            country: 'Hidden Country',
            zipCode: 'Hidden',
            mobileNumber: 'Hidden'
          }
        });

        // Anonymize all other customer data
        await Promise.all([
          // Site feedback (preserve content, anonymize identity)
          prisma.siteFeedback.updateMany({
            where: { userId: user.id },
            data: { 
              name: 'Deleted User',
              email: 'hidden@privacy.local'
            }
          }).catch(err => console.warn('[Auto-Cleanup] SiteFeedback error:', err.message)),

          // Contact messages — no userId FK, match by original email
          user.email
            ? prisma.contactMessage.updateMany({
                where: { email: user.email },
                data: { fullName: 'Deleted User', email: 'hidden@privacy.local', phoneNumber: null }
              }).catch(err => console.warn('[Auto-Cleanup] ContactMessage error:', err.message))
            : Promise.resolve(),

          // Commission records — store customerName/customerEmail directly
          prisma.commissionEarned.updateMany({
            where: { customerId: user.id },
            data: { customerName: 'Deleted User', customerEmail: 'hidden@privacy.local' }
          }).catch(err => console.warn('[Auto-Cleanup] CommissionEarned error:', err.message)),

          // Support tickets (no content changes needed - only user identity removal)
          // Support tickets will show as from deleted user through userId=null relationship
          
          // Product ratings/reviews (keep review content, identity removed through userId=null)
          // Ratings will show as anonymous through the deleted user relationship
          
          // General notifications only (PERSONAL type doesn't exist)
          prisma.notification.updateMany({
            where: { 
              userId: user.id,
              type: 'GENERAL'
            },
            data: { 
              message: 'Personal notification content hidden for privacy',
              title: 'Privacy Notice',
              metadata: null
            }
          }).catch(err => console.warn('[Auto-Cleanup] Notification error:', err.message)),
          
          // Notifications mentioning deleted user's name or email in content  
          (async () => {
            const orConditions = [];
            if (user.name) {
              orConditions.push({ message: { contains: user.name } });
              orConditions.push({ title: { contains: user.name } });
            }
            if (user.email) {
              orConditions.push({ message: { contains: user.email } });
              orConditions.push({ title: { contains: user.email } });
            }

            if (orConditions.length === 0) return;

            const userNotifications = await prisma.notification.findMany({
              where: { OR: orConditions },
              select: { id: true, title: true, message: true, metadata: true }
            });
            
            for (const notif of userNotifications) {
              let updatedTitle = notif.title || '';
              let updatedMessage = notif.message || '';

              if (user.name) {
                const nameRe = new RegExp(user.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                updatedTitle = updatedTitle.replace(nameRe, 'Deleted User');
                updatedMessage = updatedMessage.replace(nameRe, 'Deleted User');
              }
              if (user.email) {
                const emailRe = new RegExp(user.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                updatedTitle = updatedTitle.replace(emailRe, 'hidden@privacy.local');
                updatedMessage = updatedMessage.replace(emailRe, 'hidden@privacy.local');
              }

              // Also sanitize metadata JSON
              let updatedMetadata = notif.metadata;
              if (updatedMetadata) {
                try {
                  let metaStr = typeof updatedMetadata === 'string'
                    ? updatedMetadata
                    : JSON.stringify(updatedMetadata);
                  if (user.name) {
                    metaStr = metaStr.replace(
                      new RegExp(user.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                      'Deleted User'
                    );
                  }
                  if (user.email) {
                    metaStr = metaStr.replace(
                      new RegExp(user.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
                      'hidden@privacy.local'
                    );
                  }
                  updatedMetadata = JSON.parse(metaStr);
                } catch (_) {
                  // If metadata can't be parsed/stringified safely, leave as-is
                }
              }

              await prisma.notification.update({
                where: { id: notif.id },
                data: {
                  title: updatedTitle,
                  message: updatedMessage,
                  metadata: updatedMetadata
                }
              });
            }
            
            console.log(`[Auto-Cleanup] Updated ${userNotifications.length} notifications containing user name/email`);
          })().catch(err => console.warn('[Auto-Cleanup] Notification content error:', err.message))
        ]);

        processed++;
        console.log(`[Auto-Cleanup] Anonymized user ${user.id} (${user.email})`);

      } catch (userError) {
        console.error(`[Auto-Cleanup] Failed to anonymize user ${user.id}:`, userError);
        // Continue with next user
      }
    }

    console.log(`[Auto-Cleanup] Successfully anonymized ${processed} expired users`);
    return { processed, message: `Anonymized ${processed} expired users` };

  } catch (error) {
    console.error('[Auto-Cleanup] Error:', error);
    throw error;
  }
};

// GET ALL SELLERS (from seller_profiles)
exports.getAllSellers = async (request, reply) => {
  try {
    const { status } = request.query || {};

    let rows;
    if (status) {
      const upperStatus = status.toUpperCase();
      rows = await prisma.$queryRaw`
        SELECT sp.id, sp."userId" AS "sellerId", sp."businessName", sp."storeName",
               sp."businessType", sp."businessAddress" AS address,
               sp."productCount", sp.status::text AS status,
               sp."minimumProductsUploaded", sp."onboardingStep",
               sp."bankDetails", sp."kycSubmitted",
               sp."createdAt", sp."updatedAt",
               sp.stripe_account_id          AS "stripeAccountId",
               sp.stripe_onboarding_complete AS "stripeOnboardingComplete",
               sp.stripe_charges_enabled     AS "stripeChargesEnabled",
               sp.stripe_payouts_enabled     AS "stripePayoutsEnabled",
               sp.stripe_kyc_status          AS "stripeKycStatus",
               sp.stripe_abn_provided        AS "stripeAbnProvided",
               sp.stripe_bank_connected      AS "stripeBankConnected",
               u.email, u.name AS "contactPerson", u.phone,
               c.id AS "commission_id", c.title AS "commission_title",
               c.type::text AS "commission_type", c.value AS "commission_value",
               c.description AS "commission_description",
               c."isDefault" AS "commission_isDefault",
               c."isActive" AS "commission_isActive"
        FROM seller_profiles sp
        JOIN users u ON u.id = sp."userId"
        LEFT JOIN commissions c ON c.id = sp.commission_id
        WHERE sp.status::text = ${upperStatus}
        ORDER BY sp."createdAt" DESC
      `;
    } else {
      rows = await prisma.$queryRaw`
        SELECT sp.id, sp."userId" AS "sellerId", sp."businessName", sp."storeName",
               sp."businessType", sp."businessAddress" AS address,
               sp."productCount", sp.status::text AS status,
               sp."minimumProductsUploaded", sp."onboardingStep",
               sp."bankDetails", sp."kycSubmitted",
               sp."createdAt", sp."updatedAt",
               sp.stripe_account_id          AS "stripeAccountId",
               sp.stripe_onboarding_complete AS "stripeOnboardingComplete",
               sp.stripe_charges_enabled     AS "stripeChargesEnabled",
               sp.stripe_payouts_enabled     AS "stripePayoutsEnabled",
               sp.stripe_kyc_status          AS "stripeKycStatus",
               sp.stripe_abn_provided        AS "stripeAbnProvided",
               sp.stripe_bank_connected      AS "stripeBankConnected",
               u.email, u.name AS "contactPerson", u.phone,
               c.id AS "commission_id", c.title AS "commission_title",
               c.type::text AS "commission_type", c.value AS "commission_value",
               c.description AS "commission_description",
               c."isDefault" AS "commission_isDefault",
               c."isActive" AS "commission_isActive"
        FROM seller_profiles sp
        JOIN users u ON u.id = sp."userId"
        LEFT JOIN commissions c ON c.id = sp.commission_id
        ORDER BY sp."createdAt" DESC
      `;
    }

    const formattedSellers = rows.map(row => ({
      id: row.id,
      applicationNumber: row.id,
      sellerId: row.sellerId,
      email: row.email,
      businessName: row.businessName,
      storeName: row.storeName,
      contactPerson: row.contactPerson,
      phone: row.phone,
      businessType: row.businessType,
      address: row.address,
      productCount: row.productCount,
      status: row.status,
      minimumProductsUploaded: row.minimumProductsUploaded,
      onboardingStep: row.onboardingStep,
      kycSubmitted: row.kycSubmitted,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      bankDetails: row.bankDetails,
      stripeConnect: row.stripeAccountId ? {
        accountId: row.stripeAccountId,
        onboardingComplete: row.stripeOnboardingComplete,
        chargesEnabled: row.stripeChargesEnabled,
        payoutsEnabled: row.stripePayoutsEnabled,
        kycStatus: row.stripeKycStatus || (row.stripeChargesEnabled ? "verified" : row.stripeOnboardingComplete ? "pending" : "unverified"),
        abnProvided: row.stripeAbnProvided,
        bankConnected: row.stripeBankConnected,
      } : null,
      commission: row.commission_id ? {
        id: row.commission_id,
        title: row.commission_title,
        type: row.commission_type,
        value: row.commission_value,
        description: row.commission_description,
        isDefault: row.commission_isDefault,
        isActive: row.commission_isActive
      } : null
    }));

    return reply.status(200).send({ 
      success: true, 
      sellers: formattedSellers,
      count: formattedSellers.length 
    });
  } catch (err) {
    console.error("Get all sellers error:", err);
    reply.status(500).send({ success: false, error: err.message });
  }
};

// GET SINGLE SELLER DETAILS
exports.getSellerDetails = async (request, reply) => {
  try {
    const sellerId = request.params.id;
    
    const seller = await prisma.sellerProfile.findUnique({
      where: { userId: sellerId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            createdAt: true
          }
        }
      }
    });
    
    if (!seller) {
      return reply.status(404).send({ 
        success: false, 
        message: "Seller not found" 
      });
    }

    // Use raw SQL so featuredImage is included in product responses
    const products = await prisma.$queryRaw`
      SELECT p.id, p.title, p.description, p.price, p.weight, p.category, p.stock,
             p."sellerId", p."sellerName", p."artistName", p.status, p."isActive",
             p.featured, p.tags, p."featuredImage", p.images AS "galleryImages",
             p."createdAt", p."updatedAt"
      FROM "products" p
      WHERE p."sellerId" = ${sellerId}
      ORDER BY p."createdAt" DESC
    `;

    // Get seller's orders (orders containing seller's products)
    const orders = await prisma.order.findMany({
      where: {
        items: {
          some: {
            product: {
              sellerId
            }
          }
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

    // Fetch commission assigned to this seller
    const commission = await getCommissionForSeller(sellerId).catch(() => null);

    return reply.status(200).send({ 
      success: true, 
      seller: {
        // Basic Info
        id: seller.id,
        sellerId: seller.userId,
        contactPerson: seller.contactPerson,
        
        // Business Info
        businessName: seller.businessName,
        businessType: seller.businessType,
        businessAddress: seller.businessAddress,
        abn: seller.abn,
        yearsInBusiness: seller.yearsInBusiness,
        
        // Store Info
        storeName: seller.storeName,
        storeDescription: seller.storeDescription,
        storeLogo: seller.storeLogo,
        storeBanner: seller.storeBanner,
        storeLocation: seller.storeLocation,
        
        // Business Summary
        businessSummary: seller.artistName,
        businessDescription: seller.artistDescription,
        
        // KYC Documents
        kycDocuments: seller.kycDocuments || [],
        kycSubmitted: seller.kycSubmitted,
        
        // Bank Details
        bankDetails: seller.bankDetails,
        
        // Stripe Connect — synced from Stripe after seller completes onboarding
        stripeConnect: seller.stripeAccountId ? {
          accountId: seller.stripeAccountId,
          onboardingComplete: seller.stripeOnboardingComplete,
          chargesEnabled: seller.stripeChargesEnabled,
          payoutsEnabled: seller.stripePayoutsEnabled,
          // KYC: derive from charges_enabled when DB value is stale/missing
          kycStatus: seller.stripeKycStatus && seller.stripeKycStatus !== "unverified"
            ? seller.stripeKycStatus
            : seller.stripeChargesEnabled
              ? "verified"
              : seller.stripeOnboardingComplete
                ? "pending"
                : "unverified",
          // ABN: actual value masked by Stripe — only whether it was submitted
          abnProvided: seller.stripeAbnProvided,
          // Whether seller added a bank account in Stripe
          bankConnected: seller.stripeBankConnected,
        } : null,
        
        // Commission
        commission: commission || null,
        
        // Status & Metrics
        status: seller.status,
        productCount: seller.productCount,
        minimumProductsUploaded: seller.minimumProductsUploaded,
        onboardingStep: seller.onboardingStep,
        
        // Admin Notes
        adminNotes: seller.adminNotes,
        
        // Verification Info
        verificationDocs: seller.verificationDocs,
        
        // Dates
        createdAt: seller.createdAt,
        updatedAt: seller.updatedAt,
        approvedAt: seller.approvedAt,
        rejectedAt: seller.rejectedAt,
        suspendedAt: seller.suspendedAt,
        activatedAt: seller.activatedAt,
        submittedForReviewAt: seller.submittedForReviewAt,
        
        // User Info
        userEmail: seller.user.email,
        userPhone: seller.user.phone,
        userCreatedAt: seller.user.createdAt
      },
      products,
      orders,
      statistics: {
        totalProducts: products.length,
        totalOrders: orders.length,
        activeProducts: products.filter(p => p.status === "ACTIVE").length,
        pendingOrders: orders.filter(o => o.status === "PENDING").length
      }
    });
  } catch (err) {
    console.error("Get seller details error:", err);
    reply.status(500).send({ success: false, error: err.message });
  }
};

// GET PRODUCTS OF A SPECIFIC SELLER
exports.getProductsBySeller = async (request, reply) => {
  try {
    const { sellerId } = request.params;
    
    // Check if seller exists
    const seller = await prisma.sellerProfile.findUnique({
      where: { userId: sellerId },
      include: { user: true }
    });
    
    if (!seller) {
      return reply.status(404).send({ 
        success: false, 
        message: "Seller not found" 
      });
    }

    const products = await prisma.$queryRaw`
      SELECT id, title, description, type, price, category, stock, "sellerId", "sellerName",
             "artistName", status, "isActive", featured, tags,
             "featuredImage", images AS "galleryImages",
             "rejectionReason", "createdAt", "updatedAt"
      FROM "products"
      WHERE "sellerId" = ${sellerId}
        AND "deletedAt" IS NULL
      ORDER BY "createdAt" DESC
    `;

    return reply.status(200).send({ 
      success: true, 
      products: await enrichProductPrice(products),
      count: products.length,
      seller: {
        id: seller.id,
        businessName: seller.businessName,
        storeName: seller.storeName
      }
    });
  } catch (err) {
    console.error("Get products by seller error:", err);
    reply.status(500).send({ success: false, error: err.message });
  }
};

// GET ALL PRODUCTS (Admin) — filterable by status + optional sellerId
// GET /admin/products?status=pending|approved|rejected|inactive|all&sellerId=xxx&page=1&limit=20
exports.getAllAdminProducts = async (request, reply) => {
  try {
    const { status = 'all', sellerId, page = 1, limit = 50 } = request.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Map friendly status names to DB enum values
    const statusMap = {
      pending:  'PENDING',
      approved: 'ACTIVE',
      active:   'ACTIVE',
      rejected: 'REJECTED',
      inactive: 'INACTIVE',
      all:      null
    };

    const dbStatus = statusMap[status.toLowerCase()] ?? null;

    // Build dynamic WHERE clause
    let products;
    if (dbStatus && sellerId) {
      products = await prisma.$queryRaw`
        SELECT p.id, p.title, p.description, p.type, p.price, p.weight, p.category, p.stock,
               p."sellerId", p."sellerName", p."artistName", p.status, p."isActive",
               p.featured, p.tags, p."featuredImage", p.images AS "galleryImages",
               p."rejectionReason", p."createdAt", p."updatedAt",
               u.name AS "seller_name", u.email AS "seller_email",
               sp."storeName", sp."businessName"
        FROM "products" p
        JOIN "users" u ON p."sellerId" = u.id
        LEFT JOIN "seller_profiles" sp ON sp."userId" = p."sellerId"
        WHERE p.status = ${dbStatus}::"ProductStatus"
          AND p."sellerId" = ${sellerId}
          AND p."deletedAt" IS NULL
        ORDER BY p."createdAt" DESC
        LIMIT ${parseInt(limit)} OFFSET ${offset}
      `;
    } else if (dbStatus) {
      products = await prisma.$queryRaw`
        SELECT p.id, p.title, p.description, p.type, p.price, p.weight, p.category, p.stock,
               p."sellerId", p."sellerName", p."artistName", p.status, p."isActive",
               p.featured, p.tags, p."featuredImage", p.images AS "galleryImages",
               p."rejectionReason", p."createdAt", p."updatedAt",
               u.name AS "seller_name", u.email AS "seller_email",
               sp."storeName", sp."businessName"
        FROM "products" p
        JOIN "users" u ON p."sellerId" = u.id
        LEFT JOIN "seller_profiles" sp ON sp."userId" = p."sellerId"
        WHERE p.status = ${dbStatus}::"ProductStatus"
          AND p."deletedAt" IS NULL
        ORDER BY p."createdAt" DESC
        LIMIT ${parseInt(limit)} OFFSET ${offset}
      `;
    } else if (sellerId) {
      products = await prisma.$queryRaw`
        SELECT p.id, p.title, p.description, p.type, p.price, p.weight, p.category, p.stock,
               p."sellerId", p."sellerName", p."artistName", p.status, p."isActive",
               p.featured, p.tags, p."featuredImage", p.images AS "galleryImages",
               p."rejectionReason", p."createdAt", p."updatedAt",
               u.name AS "seller_name", u.email AS "seller_email",
               sp."storeName", sp."businessName"
        FROM "products" p
        JOIN "users" u ON p."sellerId" = u.id
        LEFT JOIN "seller_profiles" sp ON sp."userId" = p."sellerId"
        WHERE p."sellerId" = ${sellerId}
          AND p."deletedAt" IS NULL
        ORDER BY p."createdAt" DESC
        LIMIT ${parseInt(limit)} OFFSET ${offset}
      `;
    } else {
      products = await prisma.$queryRaw`
        SELECT p.id, p.title, p.description, p.type, p.price, p.weight, p.category, p.stock,
               p."sellerId", p."sellerName", p."artistName", p.status, p."isActive",
               p.featured, p.tags, p."featuredImage", p.images AS "galleryImages",
               p."rejectionReason", p."createdAt", p."updatedAt",
               u.name AS "seller_name", u.email AS "seller_email",
               sp."storeName", sp."businessName"
        FROM "products" p
        JOIN "users" u ON p."sellerId" = u.id
        LEFT JOIN "seller_profiles" sp ON sp."userId" = p."sellerId"
        WHERE p."deletedAt" IS NULL
        ORDER BY p."createdAt" DESC
        LIMIT ${parseInt(limit)} OFFSET ${offset}
      `;
    }

    // Counts per status tab (always all sellers or filtered by sellerId)
    let counts;
    if (sellerId) {
      counts = await prisma.$queryRaw`
        SELECT status::text, COUNT(*)::int AS count
        FROM "products"
        WHERE "sellerId" = ${sellerId}
          AND "deletedAt" IS NULL
        GROUP BY status
      `;
    } else {
      counts = await prisma.$queryRaw`
        SELECT status::text, COUNT(*)::int AS count
        FROM "products"
        WHERE "deletedAt" IS NULL
        GROUP BY status
      `;
    }

    const countMap = { PENDING: 0, ACTIVE: 0, REJECTED: 0, INACTIVE: 0 };
    for (const row of counts) countMap[row.status] = row.count;

    // Shape each product
    const mapped = products.map(({ seller_name, seller_email, storeName, businessName, ...p }) => ({
      ...p,
      seller: {
        id: p.sellerId,
        name: seller_name,
        email: seller_email,
        storeName: storeName || null,
        businessName: businessName || null
      }
    }));

    // Enrich VARIABLE products with variant price range
    const enriched = await enrichProductPrice(mapped);

    return reply.send({
      success: true,
      products: enriched,
      count: enriched.length,
      counts: {
        all:      Object.values(countMap).reduce((a, b) => a + b, 0),
        pending:  countMap.PENDING,
        approved: countMap.ACTIVE,
        rejected: countMap.REJECTED,
        inactive: countMap.INACTIVE
      }
    });
  } catch (err) {
    console.error("Get all admin products error:", err);
    reply.status(500).send({ success: false, error: err.message });
  }
};

// GET PENDING SELLER APPROVALS
exports.getPendingSellers = async (request, reply) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT sp.id, sp."userId" AS "sellerId", sp."businessName", sp."storeName",
             sp."businessType", sp."businessAddress", sp."artistName" AS "businessSummary",
             sp."storeDescription", sp."storeLogo", sp.abn, sp."kycSubmitted",
             sp."onboardingStep", sp."productCount", sp.status::text AS status,
             sp."submittedForReviewAt", sp."createdAt", sp."updatedAt",
             u.email, u.name, u.phone,
             c.id AS "commission_id", c.title AS "commission_title",
             c.type::text AS "commission_type", c.value AS "commission_value",
             c.description AS "commission_description",
             c."isDefault" AS "commission_isDefault",
             c."isActive" AS "commission_isActive"
      FROM seller_profiles sp
      JOIN users u ON u.id = sp."userId"
      LEFT JOIN commissions c ON c.id = sp.commission_id
      WHERE sp.status = 'PENDING'
      ORDER BY sp."createdAt" DESC
    `;

    const formattedSellers = rows.map(row => ({
      id: row.id,
      applicationNumber: row.id,
      sellerId: row.sellerId,
      email: row.email,
      businessName: row.businessName,
      storeName: row.storeName,
      contactPerson: row.name,
      phone: row.phone,
      abn: row.abn,
      businessAddress: row.businessAddress,
      businessType: row.businessType,
      businessSummary: row.businessSummary,
      storeDescription: row.storeDescription,
      storeLogo: row.storeLogo,
      kycSubmitted: row.kycSubmitted,
      onboardingStep: row.onboardingStep,
      submittedForReviewAt: row.submittedForReviewAt,
      productCount: row.productCount,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      commission: row.commission_id ? {
        id: row.commission_id,
        title: row.commission_title,
        type: row.commission_type,
        value: row.commission_value,
        description: row.commission_description,
        isDefault: row.commission_isDefault,
        isActive: row.commission_isActive
      } : null
    }));

    return reply.status(200).send({ 
      success: true, 
      sellers: formattedSellers,
      count: formattedSellers.length 
    });
  } catch (err) {
    console.error("Get pending sellers error:", err);
    reply.status(500).send({ success: false, error: err.message });
  }
};

// APPROVE SELLER
exports.approveSeller = async (request, reply) => {
  try {
    const sellerId = request.params.id;
    
    console.log("📝 Approve seller - ID:", sellerId);
    
    if (!sellerId) {
      return reply.status(400).send({ 
        success: false, 
        message: "Seller ID is required" 
      });
    }
    
    const seller = await prisma.sellerProfile.findUnique({
      where: { userId: sellerId },
      include: { user: true }
    });
    
    if (!seller) {
      return reply.status(404).send({ 
        success: false, 
        message: "Seller not found" 
      });
    }

    await prisma.sellerProfile.update({
      where: { userId: sellerId },
      data: {
        status: "APPROVED",
        approvedAt: new Date()
      }
    });

    // Send approval notification
    await notifySellerApproved(sellerId, seller.user.name);

    // Send approval email to seller
    try {
      await sendSellerApprovedEmail(seller.user.email, seller.user.name || "Seller");
    } catch (emailErr) {
      console.error("Seller approval email error (non-fatal):", emailErr.message);
    }
    
    // Send product recommendation notification
    await notifySellerProductRecommendation(sellerId, seller.user.name);

    return reply.status(200).send({ 
      success: true, 
      message: "Seller approved successfully" 
    });
  } catch (err) {
    console.error("Approve seller error:", err);
    reply.status(500).send({ success: false, error: err.message });
  }
};

// REJECT SELLER
exports.rejectSeller = async (request, reply) => {
  try {
    const sellerId = request.params.id;
    const { reason } = request.body;
    
    console.log("📝 Reject seller - ID:", sellerId);
    
    if (!sellerId) {
      return reply.status(400).send({ 
        success: false, 
        message: "Seller ID is required" 
      });
    }
    
    const seller = await prisma.sellerProfile.findUnique({
      where: { userId: sellerId },
      include: { user: true }
    });
    
    if (!seller) {
      return reply.status(404).send({ 
        success: false, 
        message: "Seller not found" 
      });
    }

    await prisma.sellerProfile.update({
      where: { userId: sellerId },
      data: {
        status: "REJECTED",
        rejectionReason: reason || "Not specified",
        rejectedAt: new Date()
      }
    });

    // Send rejection notification
    await notifySellerApprovalRejected(sellerId, reason || "Not specified", seller.user.name);

    return reply.status(200).send({ 
      success: true, 
      message: "Seller rejected" 
    });
  } catch (err) {
    console.error("Reject seller error:", err);
    reply.status(500).send({ success: false, error: err.message });
  }
};

// SUSPEND SELLER
exports.suspendSeller = async (request, reply) => {
  try {
    const { sellerId } = request.params;
    const { reason } = request.body;
    
    const seller = await prisma.sellerProfile.findUnique({
      where: { userId: sellerId }
    });
    
    if (!seller) {
      return reply.status(404).send({ 
        success: false, 
        message: "Seller not found" 
      });
    }

    await prisma.sellerProfile.update({
      where: { userId: sellerId },
      data: {
        status: "SUSPENDED",
        suspensionReason: reason || "Not specified",
        suspendedAt: new Date()
      }
    });

    return reply.status(200).send({ 
      success: true, 
      message: "Seller suspended" 
    });
  } catch (err) {
    console.error("Suspend seller error:", err);
    reply.status(500).send({ success: false, error: err.message });
  }
};

// UPDATE SELLER NOTES
exports.updateSellerProfile = async (request, reply) => {
  try {
    const { sellerId } = request.params;
    const { abn, businessName, businessAddress, businessType, storeName, storeDescription, contactPerson, artistName, artistDescription } = request.body;

    const seller = await prisma.sellerProfile.findUnique({ where: { userId: sellerId } });
    if (!seller) {
      return reply.status(404).send({ success: false, message: "Seller not found" });
    }

    const updateData = {};
    if (abn !== undefined) updateData.abn = abn;
    if (businessName !== undefined) updateData.businessName = businessName;
    if (businessAddress !== undefined) updateData.businessAddress = businessAddress;
    if (businessType !== undefined) updateData.businessType = businessType;
    if (storeName !== undefined) updateData.storeName = storeName;
    if (storeDescription !== undefined) updateData.storeDescription = storeDescription;
    if (contactPerson !== undefined) updateData.contactPerson = contactPerson;
    if (artistName !== undefined) updateData.artistName = artistName;
    if (artistDescription !== undefined) updateData.artistDescription = artistDescription;

    await prisma.sellerProfile.update({ where: { userId: sellerId }, data: updateData });

    return reply.status(200).send({ success: true, message: "Seller profile updated successfully" });
  } catch (error) {
    console.error("updateSellerProfile error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

exports.updateSellerNotes = async (request, reply) => {
  try {
    const sellerId = request.params.id;
    const { notes } = request.body;

    const seller = await prisma.sellerProfile.findUnique({
      where: { userId: sellerId }
    });
    
    if (!seller) {
      return reply.status(404).send({ 
        success: false, 
        message: "Seller not found" 
      });
    }

    await prisma.sellerProfile.update({
      where: { userId: sellerId },
      data: {
        adminNotes: notes || ""
      }
    });

    reply.status(200).send({
      success: true,
      message: "Notes updated successfully"
    });
  } catch (error) {
    console.error("Update seller notes error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// ACTIVATE SELLER (GO LIVE)
exports.activateSeller = async (request, reply) => {
  try {
    const { id } = request.params;
    const adminId = request.user?.userId || "admin";

    const seller = await prisma.sellerProfile.findUnique({
      where: { userId: id }
    });

    if (!seller) {
      return reply.status(404).send({
        success: false,
        message: "Seller not found"
      });
    }

    // Validation checks
    if (seller.status !== "APPROVED") {
      return reply.status(400).send({
        success: false,
        message: "Seller must be approved before activation"
      });
    }

    if (seller.productCount < 1) {
      return reply.status(400).send({
        success: false,
        message: "Seller must upload at least 1-2 products before going live. 5+ products recommended."
      });
    }

    // Update seller to active status and activate pending products in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Update seller status
      const updatedSeller = await tx.sellerProfile.update({
        where: { userId: id },
        data: {
          status: "ACTIVE",
          activatedBy: adminId,
          activatedAt: new Date()
        }
      });

      // Activate all seller's pending products (status + isActive)
      const activatedProducts = await tx.product.updateMany({
        where: {
          sellerId: id,
          status: "PENDING"
        },
        data: {
          status: "ACTIVE"
        }
      });

      // Also flip isActive = true via raw SQL (field managed outside Prisma schema)
      await tx.$executeRaw`
        UPDATE "products"
        SET "isActive" = true
        WHERE "sellerId" = ${id} AND status = 'ACTIVE'
      `;

      return { updatedSeller, activatedCount: activatedProducts.count };
    });

    reply.status(200).send({
      success: true,
      message: `Seller is now LIVE! ${result.activatedCount} products activated and visible to customers.`,
      seller: result.updatedSeller,
      productsActivated: result.activatedCount
    });
  } catch (error) {
    console.error("Activate seller error:", error);
    reply.status(500).send({ success: false, message: "Server error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SYNC SELLER STRIPE STATUS
// POST /admin/sellers/stripe-sync/:id
// Fetches the latest status from Stripe for a seller's connected account and
// syncs it to the platform DB.  If charges_enabled = true the seller's
// platform status is also set to APPROVED (if not already APPROVED/ACTIVE).
// ─────────────────────────────────────────────────────────────────────────────
exports.syncSellerStripeStatus = async (request, reply) => {
  try {
    const { id } = request.params;

    const seller = await prisma.sellerProfile.findUnique({
      where: { userId: id },
      include: { user: true },
    });

    if (!seller) {
      return reply.status(404).send({ success: false, message: "Seller not found" });
    }

    if (!seller.stripeAccountId) {
      return reply.status(400).send({
        success: false,
        message: "This seller has not connected a Stripe account yet",
      });
    }

    // Fetch live data from Stripe
    const account = await stripe.accounts.retrieve(seller.stripeAccountId);

    // For Express accounts, charges_enabled is the real KYC indicator
    let stripeKycStatus;
    if (account.charges_enabled) {
      stripeKycStatus = "verified";
    } else if (account.details_submitted) {
      stripeKycStatus = "pending";
    } else {
      stripeKycStatus = "unverified";
    }

    // Only sync Stripe fields — admin must manually approve on the platform
    const stripeUpdates = {
      stripeOnboardingComplete: account.details_submitted,
      stripeChargesEnabled: account.charges_enabled,
      stripePayoutsEnabled: account.payouts_enabled,
      stripeKycStatus,
      stripeAbnProvided: account.company?.tax_id_provided || false,
      stripeBankConnected: (account.external_accounts?.total_count || 0) > 0,
    };

    await prisma.sellerProfile.update({
      where: { userId: id },
      data: stripeUpdates,
    });

    return reply.status(200).send({
      success: true,
      message: account.charges_enabled
        ? "Stripe KYC verified. You can now approve the seller on the platform."
        : "Stripe status synced. Stripe KYC is not yet complete.",
      stripeAccountId: seller.stripeAccountId,
      stripeKycStatus,
      stripeChargesEnabled: account.charges_enabled,
      stripePayoutsEnabled: account.payouts_enabled,
      stripeOnboardingComplete: account.details_submitted,
      stripeBankConnected: (account.external_accounts?.total_count || 0) > 0,
      platformStatus: shouldApprove ? "APPROVED" : seller.status,
      requirements: account.requirements?.currently_due || [],
      errors: account.requirements?.errors || [],
    });
  } catch (error) {
    console.error("syncSellerStripeStatus error:", error);
    return reply.status(500).send({ success: false, message: "Failed to sync Stripe status", detail: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RETRY PENDING STRIPE TRANSFERS FOR A SELLER
// POST /api/admin/sellers/retry-transfers/:id
// Finds all commission_earned records for this seller that are PENDING with no
// stripeTransferId and retries the Stripe transfer for each one.
// ─────────────────────────────────────────────────────────────────────────────
exports.retrySellerTransfers = async (request, reply) => {
  try {
    const { id: sellerId } = request.params;
    const { calculateSellerPayout } = require("../utils/commissionCalculator");
    const { getCommissionForSeller, getDefaultCommission } = require("./commission");

    const sellerProfile = await prisma.sellerProfile.findUnique({
      where: { userId: sellerId },
      select: { stripeAccountId: true, stripePayoutsEnabled: true, stripeChargesEnabled: true },
    });

    if (!sellerProfile) {
      return reply.status(404).send({ success: false, message: "Seller not found" });
    }

    if (!sellerProfile.stripeAccountId) {
      return reply.status(400).send({ success: false, message: "Seller has no connected Stripe account" });
    }

    if (!sellerProfile.stripeChargesEnabled) {
      return reply.status(400).send({ success: false, message: "Seller Stripe account is not yet enabled — run Stripe sync first" });
    }

    // Find all PENDING commission_earned rows with no transfer yet
    const pending = await prisma.$queryRaw`
      SELECT id, order_id, sub_order_id, order_value, shipping_amount, commission_rate
      FROM commission_earned
      WHERE seller_id = ${sellerId}
        AND status = 'PENDING'::"CommissionStatus"
        AND (stripe_transfer_id IS NULL OR stripe_transfer_id = '')
    `;

    if (pending.length === 0) {
      return reply.status(200).send({ success: true, message: "No pending transfers found", retried: 0 });
    }

    // Use the commission captured on the original order if available so the
    // seller's payout does not change when commission settings are updated later.
    const fallbackSellerCommission = await getCommissionForSeller(sellerId).catch(() => null);
    const fallbackDefaultCommission = await getDefaultCommission().catch(() => null);

    const results = [];

    for (const row of pending) {
      try {
        const productTotal = parseFloat(row.order_value);
        const shippingAmount = parseFloat(row.shipping_amount || 0);
        const storedCommissionRate = parseFloat(row.commission_rate);
        const commissionRatePct = Number.isFinite(storedCommissionRate)
          ? storedCommissionRate
          : fallbackSellerCommission
            ? parseFloat(fallbackSellerCommission.value)
            : fallbackDefaultCommission
              ? parseFloat(fallbackDefaultCommission.value)
              : 10;
        const payout = calculateSellerPayout(productTotal, shippingAmount, commissionRatePct);

        if (payout.sellerTotalPayoutCents <= 0) {
          results.push({ id: row.id, status: "skipped", reason: "payout <= 0" });
          continue;
        }

        // Get the charge ID from the order's PaymentIntent (needed for source_transaction)
        let latestChargeId = null;
        let orderForDescription = null;
        let subOrderForDescription = null;
        let itemSummary = "";
        if (row.order_id) {
          try {
            const order = await prisma.order.findUnique({
              where: { id: row.order_id },
              select: {
                id: true,
                displayId: true,
                stripePaymentIntentId: true,
                customerName: true,
                customerEmail: true,
              },
            });
            orderForDescription = order;
            if (row.sub_order_id) {
              subOrderForDescription = await prisma.subOrder.findUnique({
                where: { id: row.sub_order_id },
                select: { id: true, subDisplayId: true, parentOrderId: true },
              });
            }
            if (order?.stripePaymentIntentId) {
              const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
              latestChargeId = pi.latest_charge || null;
            }
            const orderItems = await prisma.orderItem.findMany({
              where: {
                OR: [
                  { orderId: row.order_id },
                  { subOrder: { is: { parentOrderId: row.order_id, sellerId } } },
                ],
              },
              include: { product: { select: { title: true } } },
              take: 4,
            });
            const itemParts = orderItems.map(item => `${item.quantity}x ${item.product?.title || "Item"}`);
            itemSummary = itemParts.length > 3
              ? `${itemParts.slice(0, 3).join(", ")} +${itemParts.length - 3} more`
              : itemParts.join(", ");
          } catch (e) {
            console.warn(`Could not retrieve charge ID for order ${row.order_id}: ${e.message}`);
          }
        }

        const retryDescription = buildRetryTransferDescription({
          order: subOrderForDescription || orderForDescription || { id: row.order_id },
          customerName: orderForDescription?.customerName,
          customerEmail: orderForDescription?.customerEmail,
          itemSummary,
          amount: payout.sellerTotalPayout,
        });

        const effectiveOrderId = row.sub_order_id || row.order_id || "";
        const effectiveDisplayId = subOrderForDescription?.subDisplayId || orderForDescription?.displayId || row.order_id || "";

        const transfer = await stripe.transfers.create({
          amount: payout.sellerTotalPayoutCents,
          currency: "aud",
          destination: sellerProfile.stripeAccountId,
          ...(latestChargeId && { source_transaction: latestChargeId }),
          description: `Retry payout — order ${effectiveDisplayId}`,
          metadata: {
            orderId: effectiveOrderId,
            displayId: effectiveDisplayId,
            parentOrderId: row.order_id || "",
            parentDisplayId: orderForDescription?.displayId || "",
            subOrderId: row.sub_order_id || "",
            subDisplayId: subOrderForDescription?.subDisplayId || "",
            sellerId,
            customerName: orderForDescription?.customerName || "",
            customerEmail: orderForDescription?.customerEmail || "",
            itemSummary,
            commissionAmount: payout.commissionAmount.toString(),
            sellerTotalPayout: payout.sellerTotalPayout.toString(),
            retried: "true",
          },
        });

        await stripe.transfers.update(transfer.id, {
          description: retryDescription,
        });

        await prisma.$executeRaw`
          UPDATE commission_earned
          SET stripe_transfer_id     = ${transfer.id},
              stripe_transfer_status = 'transferred',
              status                 = 'PAID'::"CommissionStatus",
              updated_at             = NOW()
          WHERE id = ${row.id}
        `;

        results.push({ id: row.id, status: "transferred", transferId: transfer.id, amount: payout.sellerTotalPayout });
        console.log(`💸 Retry transfer — seller: ${sellerId}, amount: $${payout.sellerTotalPayout}, transferId: ${transfer.id}`);
      } catch (err) {
        results.push({ id: row.id, status: "failed", error: err.message });
        console.error(`❌ Retry transfer failed for commission ${row.id}:`, err.message);
      }
    }

    const transferred = results.filter(r => r.status === "transferred").length;
    const failed = results.filter(r => r.status === "failed").length;

    return reply.status(200).send({
      success: true,
      message: `${transferred} transfer(s) sent, ${failed} failed`,
      retried: transferred,
      failed,
      results,
    });
  } catch (error) {
    console.error("retrySellerTransfers error:", error);
    return reply.status(500).send({ success: false, message: "Server error", detail: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// BULK SYNC ALL SELLERS' STRIPE STATUS
// POST /api/admin/sellers/stripe-sync-all
// Iterates every seller that has a stripeAccountId and pulls the latest status
// from Stripe. Returns a summary of how many were updated.
// ─────────────────────────────────────────────────────────────────────────────
exports.bulkSyncSellerStripeStatus = async (request, reply) => {
  try {
    const sellers = await prisma.sellerProfile.findMany({
      where: { stripeAccountId: { not: null } },
      select: {
        userId: true,
        stripeAccountId: true,
        stripeChargesEnabled: true,
        user: { select: { email: true, name: true } },
      },
    });

    if (sellers.length === 0) {
      return reply.status(200).send({ success: true, message: "No sellers with Stripe accounts found", synced: 0 });
    }

    const results = [];

    for (const seller of sellers) {
      try {
        const account = await stripe.accounts.retrieve(seller.stripeAccountId);

        let stripeKycStatus;
        if (account.charges_enabled) {
          stripeKycStatus = "verified";
        } else if (account.details_submitted) {
          stripeKycStatus = "pending";
        } else {
          stripeKycStatus = "unverified";
        }

        await prisma.sellerProfile.update({
          where: { userId: seller.userId },
          data: {
            stripeOnboardingComplete: account.details_submitted,
            stripeChargesEnabled: account.charges_enabled,
            stripePayoutsEnabled: account.payouts_enabled,
            stripeKycStatus,
            stripeAbnProvided: account.company?.tax_id_provided || false,
            stripeBankConnected: (account.external_accounts?.total_count || 0) > 0,
          },
        });

        // Send approved email if charges_enabled just flipped for the first time
        if (account.charges_enabled && !seller.stripeChargesEnabled) {
          const email = seller.user?.email;
          const name  = seller.user?.name || "Seller";
          if (email) {
            const { sendSellerStripeApprovedEmail } = require("../utils/emailService");
            sendSellerStripeApprovedEmail(email, name).catch((e) =>
              console.error("sendSellerStripeApprovedEmail error (bulk sync):", e.message)
            );
          }
        }

        results.push({ sellerId: seller.userId, stripeKycStatus, chargesEnabled: account.charges_enabled, status: "synced" });
      } catch (err) {
        console.error(`Stripe bulk sync error for seller ${seller.userId}:`, err.message);
        results.push({ sellerId: seller.userId, status: "error", error: err.message });
      }
    }

    const synced = results.filter(r => r.status === "synced").length;
    const errors = results.filter(r => r.status === "error").length;

    return reply.status(200).send({
      success: true,
      message: `Bulk sync complete — ${synced} synced, ${errors} errors`,
      synced,
      errors,
      results,
    });
  } catch (error) {
    console.error("bulkSyncSellerStripeStatus error:", error);
    return reply.status(500).send({ success: false, message: "Bulk sync failed", detail: error.message });
  }
};

// ==================== CATEGORY MANAGEMENT ====================

// GET ALL CATEGORIES WITH PRODUCT COUNTS (Admin , Seller only)
exports.getAllCategories = async (request, reply) => {
  try {
    if (!request.user || (!isAdminRole(request.user.role) && request.user.role !== 'SELLER')) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    // Get all products with their categories
    const products = await prisma.product.findMany({
      select: {
        id: true,
        category: true
      }
    });

    // Group categories manually after trimming whitespace
    const categoryMap = new Map();
    
    products.forEach(product => {
      const trimmedCategory = product.category?.trim();
      if (trimmedCategory) {
        if (categoryMap.has(trimmedCategory)) {
          categoryMap.set(trimmedCategory, categoryMap.get(trimmedCategory) + 1);
        } else {
          categoryMap.set(trimmedCategory, 1);
        }
      }
    });

    // Convert to array and sort by product count (highest first)
    const categories = Array.from(categoryMap.entries())
      .map(([name, productCount]) => ({ name, productCount }))
      .sort((a, b) => b.productCount - a.productCount);

    // Get total categories and total products
    const totalProducts = await prisma.product.count();
    const totalCategories = categories.length;

    reply.send({
      success: true,
      categories,
      summary: {
        totalCategories,
        totalProducts
      }
    });
  } catch (error) {
    console.error('Get all categories error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== COUPON MANAGEMENT ====================

// CREATE COUPON (Admin only)
exports.createCoupon = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const {
      code,
      discountType = 'percentage',
      discountValue,
      expiresAt,
      usageLimit,
      usagePerUser,
      minCartValue,
      maxDiscount,
      isActive = true
    } = request.body;

    if (!code || discountValue === undefined || !expiresAt) {
      return reply.status(400).send({
        success: false,
        message: 'Coupon code, discountValue, and expiry date are required'
      });
    }

    if (!['percentage', 'fixed'].includes(discountType)) {
      return reply.status(400).send({ success: false, message: 'discountType must be "percentage" or "fixed"' });
    }

    if (discountType === 'percentage' && (discountValue <= 0 || discountValue > 100)) {
      return reply.status(400).send({ success: false, message: 'Percentage discount must be between 1 and 100' });
    }

    if (discountType === 'fixed' && discountValue <= 0) {
      return reply.status(400).send({ success: false, message: 'Fixed discount must be greater than 0' });
    }

    const existingCoupon = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });
    if (existingCoupon) {
      return reply.status(400).send({ success: false, message: 'Coupon code already exists' });
    }

    const coupon = await prisma.coupon.create({
      data: {
        code: code.toUpperCase(),
        discountType,
        discountValue: parseFloat(discountValue),
        expiresAt: new Date(expiresAt),
        usageLimit: usageLimit ? parseInt(usageLimit) : null,
        usagePerUser: usagePerUser ? parseInt(usagePerUser) : null,
        minCartValue: minCartValue ? parseFloat(minCartValue) : null,
        maxDiscount: maxDiscount ? parseFloat(maxDiscount) : null,
        isActive,
        createdBy: request.user.userId || request.user.uid
      }
    });

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType: ENTITY_TYPES.COUPON,
      entityId:   coupon.id,
      action:     AUDIT_ACTIONS.COUPON_CREATED,
      ...meta,
      previousData: null,
      newData:      coupon,
      reason:       `Coupon "${coupon.code}" created by admin`,
    });

    reply.status(201).send({ success: true, message: 'Coupon created successfully', coupon });
  } catch (error) {
    console.error('Create coupon error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// GET ALL COUPONS (Admin — active list; use ?recycleBin=true for recycle bin)
exports.getAllCoupons = async (request, reply) => {
  try {
    const recycleBin = request.query?.recycleBin === 'true';

    const coupons = await prisma.coupon.findMany({
      where: recycleBin
        ? { softDeletedAt: { not: null } }
        : { softDeletedAt: null },
      orderBy: { createdAt: 'desc' }
    });

    reply.send({
      success: true,
      coupons,
      count: coupons.length,
      recycleBin
    });
  } catch (error) {
    console.error('Get all coupons error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// GET ACTIVE COUPONS (Public — for users to browse available offers)
exports.getActiveCoupons = async (request, reply) => {
  try {
    const now = new Date();
    const coupons = await prisma.coupon.findMany({
      where: {
        isActive: true,
        softDeletedAt: null,
        expiresAt: { gt: now }
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id:            true,
        code:          true,
        discountType:  true,
        discountValue: true,
        maxDiscount:   true,
        minCartValue:  true,
        expiresAt:     true,
        usagePerUser:  true
      }
    });

    reply.send({
      success: true,
      coupons,
      count: coupons.length
    });
  } catch (error) {
    console.error('Get active coupons error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// UPDATE COUPON (Admin only)
exports.updateCoupon = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { id } = request.params;
    const { code, discountType, discountValue, expiresAt, usageLimit, usagePerUser, minCartValue, maxDiscount, isActive } = request.body;

    // Check if coupon exists
    const existingCoupon = await prisma.coupon.findUnique({ where: { id } });
    if (!existingCoupon) {
      return reply.status(404).send({ success: false, message: 'Coupon not found' });
    }

    if (existingCoupon.softDeletedAt) {
      return reply.status(400).send({ success: false, message: 'Cannot edit a soft-deleted coupon. Restore it first.' });
    }

    const updateData = {};
    if (code) updateData.code = code.toUpperCase();
    if (discountType !== undefined) {
      if (!['percentage', 'fixed'].includes(discountType)) {
        return reply.status(400).send({ success: false, message: 'discountType must be "percentage" or "fixed"' });
      }
      updateData.discountType = discountType;
    }
    if (discountValue !== undefined) {
      const type = discountType || existingCoupon.discountType;
      if (type === 'percentage' && (discountValue <= 0 || discountValue > 100)) {
        return reply.status(400).send({ success: false, message: 'Percentage discount must be between 1 and 100' });
      }
      if (type === 'fixed' && discountValue <= 0) {
        return reply.status(400).send({ success: false, message: 'Fixed discount must be greater than 0' });
      }
      updateData.discountValue = parseFloat(discountValue);
    }
    if (expiresAt) updateData.expiresAt = new Date(expiresAt);
    if (usageLimit !== undefined) updateData.usageLimit = usageLimit !== null ? parseInt(usageLimit) : null;
    if (usagePerUser !== undefined) updateData.usagePerUser = usagePerUser !== null ? parseInt(usagePerUser) : null;
    if (minCartValue !== undefined) updateData.minCartValue = minCartValue !== null ? parseFloat(minCartValue) : null;
    if (maxDiscount !== undefined) updateData.maxDiscount = maxDiscount !== null ? parseFloat(maxDiscount) : null;
    if (isActive !== undefined) updateData.isActive = isActive;

    if (code) {
      const upper = code.toUpperCase();
      if (upper !== existingCoupon.code) {
        const conflict = await prisma.coupon.findUnique({ where: { code: upper } });
        if (conflict) return reply.status(400).send({ success: false, message: 'Coupon code already exists' });
      }
      updateData.code = upper;
    }

    if (discountType !== undefined) {
      if (!['percentage', 'flat'].includes(discountType))
        return reply.status(400).send({ success: false, message: "discountType must be 'percentage' or 'flat'" });
      updateData.discountType = discountType;
    }

    const effectiveType = discountType || existingCoupon.discountType;
    if (discountValue !== undefined) {
      if (effectiveType === 'percentage' && (discountValue <= 0 || discountValue > 100))
        return reply.status(400).send({ success: false, message: 'Percentage discount must be between 1 and 100' });
      if (effectiveType === 'flat' && discountValue <= 0)
        return reply.status(400).send({ success: false, message: 'Flat discount must be greater than 0' });
      updateData.discountValue = parseFloat(discountValue);
    }

    if (maxDiscount  !== undefined) updateData.maxDiscount  = maxDiscount  ? parseFloat(maxDiscount)  : null;
    if (minCartValue !== undefined) updateData.minCartValue = minCartValue ? parseFloat(minCartValue) : null;
    if (expiresAt    !== undefined) updateData.expiresAt    = new Date(expiresAt);
    if (usageLimit   !== undefined) updateData.usageLimit   = usageLimit   ? parseInt(usageLimit)     : null;
    if (usagePerUser !== undefined) updateData.usagePerUser = parseInt(usagePerUser);
    if (isActive     !== undefined) updateData.isActive     = Boolean(isActive);

    const updatedCoupon = await prisma.coupon.update({ where: { id }, data: updateData });

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType:   ENTITY_TYPES.COUPON,
      entityId:     id,
      action:       AUDIT_ACTIONS.COUPON_UPDATED,
      ...meta,
      previousData: existingCoupon,
      newData:      updatedCoupon,
      reason:       `Coupon "${updatedCoupon.code}" updated by admin`,
    });

    reply.send({ success: true, message: 'Coupon updated successfully', coupon: updatedCoupon });
  } catch (error) {
    console.error('Update coupon error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// SOFT DELETE COUPON — moves to recycle bin (Admin only)
exports.softDeleteCoupon = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { id } = request.params;
    const { reason } = request.body || {};

    const existingCoupon = await prisma.coupon.findUnique({ where: { id } });
    if (!existingCoupon) {
      return reply.status(404).send({ success: false, message: 'Coupon not found' });
    }

    if (existingCoupon.softDeletedAt) {
      return reply.status(400).send({ success: false, message: 'Coupon is already in the recycle bin' });
    }

    const now = new Date();
    const adminId = request.user.userId || request.user.uid;

    await prisma.coupon.update({
      where: { id },
      data: {
        softDeletedAt: now,
        softDeletedBy: adminId,
        isActive:      false,
      }
    });

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType:   ENTITY_TYPES.COUPON,
      entityId:     id,
      action:       AUDIT_ACTIONS.COUPON_SOFT_DELETED,
      ...meta,
      previousData: existingCoupon,
      newData:      { ...existingCoupon, softDeletedAt: now, softDeletedBy: adminId, isActive: false },
      reason:       reason || `Coupon "${existingCoupon.code}" moved to recycle bin`,
    });

    reply.send({
      success: true,
      message: `Coupon "${existingCoupon.code}" moved to recycle bin`,
      data: { id, code: existingCoupon.code, softDeletedAt: now }
    });
  } catch (error) {
    console.error('Soft delete coupon error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// RESTORE COUPON from recycle bin (Admin only)
exports.restoreCoupon = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { id } = request.params;

    const existingCoupon = await prisma.coupon.findUnique({ where: { id } });
    if (!existingCoupon) {
      return reply.status(404).send({ success: false, message: 'Coupon not found' });
    }

    if (!existingCoupon.softDeletedAt) {
      return reply.status(400).send({ success: false, message: 'Coupon is not in the recycle bin' });
    }

    const now = new Date();
    const adminId = request.user.userId || request.user.uid;

    const restoredCoupon = await prisma.coupon.update({
      where: { id },
      data: {
        softDeletedAt: null,
        softDeletedBy: null,
        restoredAt:    now,
        restoredBy:    adminId,
      }
    });

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType:   ENTITY_TYPES.COUPON,
      entityId:     id,
      action:       AUDIT_ACTIONS.COUPON_RESTORED,
      ...meta,
      previousData: existingCoupon,
      newData:      restoredCoupon,
      reason:       `Coupon "${existingCoupon.code}" restored from recycle bin`,
    });

    reply.send({
      success: true,
      message: `Coupon "${existingCoupon.code}" has been restored`,
      coupon: restoredCoupon
    });
  } catch (error) {
    console.error('Restore coupon error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};
// new
// HARD DELETE COUPON — permanent, irreversible (Admin only; must be in recycle bin first)
exports.hardDeleteCoupon = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { id } = request.params;
    const { reason } = request.body || {};

    const existingCoupon = await prisma.coupon.findUnique({ where: { id } });
    if (!existingCoupon) {
      return reply.status(404).send({ success: false, message: 'Coupon not found' });
    }

    if (!existingCoupon.softDeletedAt) {
      return reply.status(400).send({
        success: false,
        message: 'Coupon must be moved to the recycle bin before it can be permanently deleted'
      });
    }

    // Write audit log BEFORE deleting so the row snapshot is preserved
    const meta = extractRequestMeta(request);
    await auditLog({
      entityType:   ENTITY_TYPES.COUPON,
      entityId:     id,
      action:       AUDIT_ACTIONS.COUPON_HARD_DELETED,
      ...meta,
      previousData: existingCoupon,
      newData:      null,
      reason:       reason || `Coupon "${existingCoupon.code}" permanently deleted`,
    });

    await prisma.coupon.delete({ where: { id } });

    reply.send({
      success: true,
      message: `Coupon "${existingCoupon.code}" has been permanently deleted. Audit logs are retained.`,
      data: { id, code: existingCoupon.code }
    });
  } catch (error) {
    console.error('Hard delete coupon error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// VALIDATE COUPON (Customer use — preview discount before checkout)
exports.validateCoupon = async (request, reply) => {
  try {
    const { code, orderTotal } = request.body;

    if (!code) {
      return reply.status(400).send({ success: false, message: 'Coupon code is required' });
    }

    const coupon = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });

    if (!coupon) {
      return reply.status(404).send({ success: false, message: 'Invalid coupon code' });
    }

    if (coupon.softDeletedAt) {
      return reply.status(404).send({ success: false, message: 'Invalid coupon code' });
    }

    if (!coupon.isActive) {
      return reply.status(400).send({ success: false, message: 'This coupon is no longer active' });
    }

    if (new Date() > coupon.expiresAt) {
      return reply.status(400).send({ success: false, message: 'Coupon has expired' });
    }

    if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
      return reply.status(400).send({ success: false, message: 'Coupon usage limit has been reached' });
    }

    // Validate orderTotal and calculate discount
    let discountAmount = null;
    let finalTotal = null;

    if (orderTotal !== undefined) {
      const total = parseFloat(orderTotal);
      if (isNaN(total) || total <= 0) {
        return reply.status(400).send({ success: false, message: 'Order total must be a positive number' });
      }

      if (coupon.minCartValue !== null && total < coupon.minCartValue) {
        return reply.status(400).send({
          success: false,
          message: `Minimum cart value of $${coupon.minCartValue.toFixed(2)} required for this coupon`
        });
      }

      if (coupon.discountType === 'percentage') {
        discountAmount = parseFloat(((total * coupon.discountValue) / 100).toFixed(2));
        if (coupon.maxDiscount !== null) discountAmount = Math.min(discountAmount, coupon.maxDiscount);
      } else {
        discountAmount = Math.min(coupon.discountValue, total);
      }
    }

    reply.send({
      success: true,
      message: 'Coupon is valid',
      coupon: {
        id: coupon.id,
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        expiresAt: coupon.expiresAt,
        usageLimit: coupon.usageLimit,
        usageCount: coupon.usageCount,
        minCartValue: coupon.minCartValue,
        maxDiscount: coupon.maxDiscount,
        discountAmount
      }
    });
  } catch (error) {
    console.error('Validate coupon error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};


// Get Analysis and Sales Reports (Admin only)

// GET SALES ANALYTICS (ADMIN)
exports.getSalesAnalytics = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    // Extract query parameters for date filtering
    const { startDate, endDate } = request.query;
    
    // Set default date range (last 30 days) if no dates provided
    let dateFilter = {};
    let periodInfo = {};
    
    if (startDate || endDate) {
      // Use provided dates
      const start = startDate ? new Date(startDate) : null;
      const end = endDate ? new Date(endDate) : null;
      
      if (start && !isNaN(start.getTime())) {
        dateFilter.gte = start;
        periodInfo.startDate = start.toISOString().split('T')[0];
      }
      
      if (end && !isNaN(end.getTime())) {
        // Set end date to end of day
        const endOfDay = new Date(end);
        endOfDay.setHours(23, 59, 59, 999);
        dateFilter.lte = endOfDay;
        periodInfo.endDate = end.toISOString().split('T')[0];
      }
    } else {
      // Default to last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);
      
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      
      dateFilter = {
        gte: thirtyDaysAgo,
        lte: today
      };
      
      periodInfo = {
        startDate: thirtyDaysAgo.toISOString().split('T')[0],
        endDate: today.toISOString().split('T')[0]
      };
    }

    // Build where clause for orders query
    const whereClause = {
      ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}),
      paymentStatus: 'PAID',
      overallStatus: { notIn: ['CANCELLED'] }
    };

    // Get filtered orders with items, products, user, and seller info
    const orders = await prisma.order.findMany({
      where: whereClause,
      include: {
        items: { include: { product: { include: { seller: { include: { sellerProfile: { select: { businessName: true, storeName: true } } } } } } } },
        subOrders: { include: { items: { include: { product: { include: { seller: { include: { sellerProfile: { select: { businessName: true, storeName: true } } } } } } } } } },
        user: { select: { id: true, name: true } }
      }
    });

    let totalRevenue = 0;
    let totalOrders = orders.length;
    let totalItemsSold = 0;
    let statusBreakdown = {
      PENDING: 0,
      CONFIRMED: 0,
      PROCESSING: 0,
      SHIPPED: 0,
      DELIVERED: 0,
      CANCELLED: 0,
      REFUND: 0,
      PARTIAL_REFUND: 0
    };
    let productSales = {};
    let topProducts = [];

    orders.forEach(order => {
      totalRevenue += Number(order.totalAmount || 0);
      statusBreakdown[order.overallStatus || order.status || 'PENDING'] = (statusBreakdown[order.overallStatus || order.status || 'PENDING'] || 0) + 1;
      
      const allItems = order.subOrders && order.subOrders.length > 0 
        ? order.subOrders.flatMap(sub => sub.items || []) 
        : order.items || [];

      allItems.forEach(item => {
        totalItemsSold += item.quantity;
        const pid = item.productId;
        if (!productSales[pid]) {
          productSales[pid] = {
            productId: pid,
            title: item.product.title,
            sellerId: item.product.sellerId,
            sellerName: item.product.seller?.sellerProfile?.storeName || item.product.seller?.sellerProfile?.businessName || item.product.seller?.name || '',
            quantity: 0,
            revenue: 0
          };
        }
        productSales[pid].quantity += item.quantity;
        productSales[pid].revenue += Number(item.price) * item.quantity;
      });
    });

    // Top products by quantity sold
    topProducts = Object.values(productSales)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 10);

    const averageOrderValue = totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(2) : "0.00";

    reply.send({
      success: true,
      analytics: {
        totalRevenue: totalRevenue.toFixed(2),
        totalOrders,
        totalItemsSold,
        averageOrderValue,
        statusBreakdown,
        topProducts,
        period: periodInfo
      }
    });
  } catch (error) {
    console.error("Sales analytics error:", error);
    reply.status(500).send({ success: false, message: error.message });
  }
};

// EXPORT SALES CSV (ADMIN)
exports.exportSalesCSV = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    // Get all orders with items, products, user, and seller info
    const orders = await prisma.order.findMany({
      include: {
        items: { include: { product: { include: { seller: true } } } },
        user: { select: { id: true, name: true, email: true, phone: true } }
      }
    });

    // Transform orders for CSV utility
    const csvOrders = orders.map(order => ({
      id: order.id,
      createdAt: order.createdAt,
      status: order.status,
      paymentMethod: order.paymentMethod,
      trackingNumber: order.trackingNumber,
      estimatedDelivery: order.estimatedDelivery,
      customerName: order.user?.name,
      customerEmail: order.user?.email || order.customerEmail,
      customerPhone: order.user?.phone || order.customerPhone,
      shippingAddress: order.shippingAddress,
      shippingAddressLine: order.shippingAddressLine,
      shippingCity: order.shippingCity,
      shippingState: order.shippingState,
      shippingZipCode: order.shippingZipCode,
      shippingCountry: order.shippingCountry,
      shippingPhone: order.shippingPhone,
      products: order.items.map(item => ({
        productId: item.productId,
        title: item.product.title,
        price: item.price,
        quantity: item.quantity,
        sellerId: item.product.sellerId,
        sellerName: item.product.seller?.storeName || item.product.seller?.businessName || ''
      }))
    }));

    const csv = generateSalesReportCSV(csvOrders);

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename="sales_report.csv"');
    reply.send(csv);
  } catch (error) {
    console.error("Export sales CSV error:", error);
    reply.status(500).send({ success: false, message: error.message });
  }
};

// GET GST MONTHLY REPORT (ADMIN)
exports.getGstReport = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { month, year } = request.query;
    
    // Default to current month/year
    const today = new Date();
    const m = month ? parseInt(month, 10) - 1 : today.getMonth();
    const y = year ? parseInt(year, 10) : today.getFullYear();
    
    const startDate = new Date(y, m, 1);
    const endDate = new Date(y, m + 1, 0, 23, 59, 59, 999);
    
    const prevMonthStartDate = new Date(y, m - 1, 1);
    const prevMonthEndDate = new Date(y, m, 0, 23, 59, 59, 999);

    // Fetch active GST
    const activeGst = await prisma.gST.findFirst({
      where: { isActive: true },
      orderBy: { isDefault: 'desc' }
    });
    const defaultGstRate = activeGst ? parseFloat(activeGst.percentage) : 10.0;

    // Fetch this month's paid orders
    const currentOrders = await prisma.order.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        paymentStatus: 'PAID',
        overallStatus: { notIn: ['CANCELLED'] }
      },
      include: {
        items: { include: { product: { include: { seller: { include: { sellerProfile: { select: { businessName: true, storeName: true } } } } } } } },
        subOrders: { include: { items: { include: { product: { include: { seller: { include: { sellerProfile: { select: { businessName: true, storeName: true } } } } } } } } } },
        user: { select: { name: true } },
      }
    });

    // Fetch last month's paid orders summary for trend
    const prevOrdersRes = await prisma.order.aggregate({
      where: {
        createdAt: { gte: prevMonthStartDate, lte: prevMonthEndDate },
        paymentStatus: 'PAID',
        overallStatus: { notIn: ['CANCELLED'] }
      },
      _sum: { totalAmount: true },
      _count: { id: true }
    });

    const prevGross = parseFloat(prevOrdersRes._sum.totalAmount || 0);
    const prevOrdersCount = prevOrdersRes._count.id;
    const prevGst = prevGross - (prevGross / (1 + defaultGstRate / 100));

    let grossTotal = 0;
    const paymentMethods = {};
    const sellersData = {};
    const rateBreakdowns = {
      [defaultGstRate.toFixed(1)]: {
        rate: defaultGstRate,
        transactions: 0,
        netAmount: 0,
        gstAmount: 0,
        grossAmount: 0
      }
    };
    
    const transactions = [];

    currentOrders.forEach(order => {
      const orderGross = parseFloat(order.totalAmount || 0);
      grossTotal += orderGross;
      
      // The PDF Invoice logic computes GST exclusively on the items (Subtotal), 
      // treating shipping as GST-free.
      let itemsGross = 0;
      const allItems = order.subOrders && order.subOrders.length > 0 
        ? order.subOrders.flatMap(sub => sub.items || []) 
        : order.items || [];
        
      allItems.forEach(item => {
        itemsGross += parseFloat(item.price || 0) * item.quantity;
      });
      
      const orderGst = itemsGross - (itemsGross / (1 + defaultGstRate / 100));
      const orderNet = orderGross - orderGst;

      const rateKey = defaultGstRate.toFixed(1);
      rateBreakdowns[rateKey].transactions += 1;
      rateBreakdowns[rateKey].netAmount += orderNet;
      rateBreakdowns[rateKey].gstAmount += orderGst;
      rateBreakdowns[rateKey].grossAmount += orderGross;

      const pMethod = order.paymentMethod || 'Unknown';
      if (!paymentMethods[pMethod]) {
        paymentMethods[pMethod] = { count: 0, netAmount: 0, gstAmount: 0, grossAmount: 0, fees: 0 };
      }
      paymentMethods[pMethod].count += 1;
      paymentMethods[pMethod].grossAmount += orderGross;
      paymentMethods[pMethod].netAmount += orderNet;
      paymentMethods[pMethod].gstAmount += orderGst;
      
      // Estimate gateway fee (e.g. 1.75% + $0.30 for Stripe)
      const estFee = pMethod.toLowerCase().includes('stripe') || pMethod.toLowerCase().includes('card') 
        ? (orderGross * 0.0175) + 0.30 
        : (orderGross * 0.02);
      paymentMethods[pMethod].fees += estFee;

      // Group per-seller portions
      allItems.forEach(item => {
        const sid = item.product.sellerId || 'Unknown';
        if (!sellersData[sid]) {
          const sellerName = item.product.seller?.sellerProfile?.storeName || item.product.seller?.sellerProfile?.businessName || item.product.seller?.name || `Seller ${sid}`;
          sellersData[sid] = { sellerName, orderIds: new Set(), netSales: 0, gstCollected: 0 };
        }
        sellersData[sid].orderIds.add(order.id);
        const itemGross = parseFloat(item.price) * item.quantity;
        const itemNet = itemGross / (1 + defaultGstRate / 100);
        sellersData[sid].netSales += itemNet;
        sellersData[sid].gstCollected += (itemGross - itemNet);
      });

      transactions.push({
        orderId: order.displayId || order.id,
        date: order.createdAt,
        customerName: order.user?.name || order.customerName,
        paymentMethod: pMethod,
        netAmount: orderNet,
        gstRate: defaultGstRate,
        gstAmount: orderGst,
        totalAmount: orderGross,
        status: order.overallStatus,
        ref: order.stripePaymentIntentId || order.paypalOrderId || 'N/A'
      });
    });

    let gstTotal = 0;
    let netTotal = 0;
    Object.values(rateBreakdowns).forEach(rate => {
      gstTotal += rate.gstAmount;
      netTotal += rate.netAmount;
    });

    let growthPerc = 0;
    if (prevGross > 0) {
      growthPerc = ((grossTotal - prevGross) / prevGross) * 100;
    } else if (grossTotal > 0) {
      growthPerc = 100;
    }

    const sellerList = Object.values(sellersData).map(s => ({
      sellerName: s.sellerName,
      orders: s.orderIds.size,
      netSales: s.netSales,
      gstCollected: s.gstCollected
    })).sort((a,b) => b.netSales - a.netSales);

    reply.send({
      success: true,
      report: {
        period: {
          month: m + 1,
          year: y,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString()
        },
        executiveSummary: {
          totalOrders: currentOrders.length,
          grossRevenue: grossTotal,
          netRevenue: netTotal,
          gstCollected: gstTotal
        },
        trend: {
          prevOrders: prevOrdersCount,
          prevNetRevenue: prevGross - prevGst,
          prevGstCollected: prevGst,
          growthPercentage: growthPerc
        },
        gstBreakdown: Object.values(rateBreakdowns),
        paymentMethods: Object.entries(paymentMethods).map(([method, stats]) => ({
          method,
          transactions: stats.count,
          netAmount: stats.netAmount,
          gstAmount: stats.gstAmount,
          grossAmount: stats.grossAmount,
          fees: stats.fees,
          netReceived: stats.grossAmount - stats.fees
        })),
        topSellers: sellerList,
        transactions: transactions.slice(0, 1000)
      }
    });

  } catch (error) {
    console.error("GST report error:", error);
    reply.status(500).send({ success: false, message: error.message });
  }
};

// ==================== PRODUCT APPROVAL MANAGEMENT ====================

// GET ALL PENDING PRODUCTS (Admin only)
exports.getPendingProducts = async (request, reply) => {
  try {
    // Only admin can access
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const products = await prisma.$queryRaw`
      SELECT p.id, p.title, p.description, p.type, p.price, p.weight, p.category, p.stock,
             p."sellerId", p."sellerName", p."artistName", p.status, p."isActive",
             p.featured, p.tags, p."featuredImage", p.images AS "galleryImages",
             p."rejectionReason", p."createdAt", p."updatedAt",
             u.id AS "seller_id", u.name AS "seller_name", u.email AS "seller_email",
             sp.status AS "seller_profile_status"
      FROM "products" p
      JOIN "users" u ON p."sellerId" = u.id
      LEFT JOIN "SellerProfile" sp ON u.id = sp."userId"
      WHERE p.status = 'PENDING'
      ORDER BY p."createdAt" DESC
    `;

    const mapped = products.map(({ seller_id, seller_name, seller_email, seller_profile_status, ...p }) => ({
      ...p,
      seller: { id: seller_id, name: seller_name, email: seller_email },
      sellerProfileStatus: seller_profile_status || 'UNKNOWN'
    }));

    const enriched = await enrichProductPrice(mapped);

    reply.send({ 
      success: true, 
      products: enriched, 
      count: enriched.length,
      message: `${enriched.length} products pending approval`
    });
  } catch (error) {
    console.error("Get pending products error:", error);
    reply.status(500).send({ success: false, message: error.message });
  }
};

// APPROVE PRODUCT (Admin only)
exports.approveProduct = async (request, reply) => {
  try {
    // Only admin can access
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { productId } = request.params;

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        seller: {
          select: {
            id: true,
            name: true,
            email: true,
            sellerProfile: {
              select: {
                status: true
              }
            }
          }
        }
      }
    });

    if (!product) {
      return reply.status(404).send({
        success: false,
        message: "Product not found"
      });
    }

    const sellerStatus = product.seller?.sellerProfile?.status;
    if (sellerStatus && sellerStatus !== 'ACTIVE') {
      return reply.status(400).send({
        success: false,
        message: `Cannot approve product. The seller's account is currently '${sellerStatus}'. Please activate the Seller Account first!`
      });
    }

    // Update product to ACTIVE and clear any previous rejection reason
    const approvedProduct = await prisma.product.update({
      where: { id: productId },
      data: {
        status: "ACTIVE",
        rejectionReason: null  // clear any previous rejection reason
      }
    });

    // Update isActive using raw SQL since client doesn't recognize it yet
    await prisma.$executeRaw`UPDATE "products" SET "isActive" = true WHERE "id" = ${productId}`;

    // For VARIABLE products: verify at least one variant has stock; warn if none do
    if (product.type === 'VARIABLE') {
      const variantStock = await prisma.$queryRaw`
        SELECT COALESCE(SUM(stock), 0)::int AS total_stock
        FROM "product_variants"
        WHERE "productId" = ${productId} AND "isActive" = true
      `;
      const totalVariantStock = variantStock[0]?.total_stock ?? 0;
      if (totalVariantStock === 0) {
        console.warn(`⚠️  [approveProduct] VARIABLE product "${product.title}" approved but all variants have 0 stock`);
      }
    }

    // ── Audit log: product approved ───────────────────────────────────────
    auditLog({
      entityType:   ENTITY_TYPES.PRODUCT,
      entityId:     productId,
      action:       AUDIT_ACTIONS.PRODUCT_APPROVED,
      previousData: product,
      newData:      { ...product, status: 'ACTIVE', isActive: true, rejectionReason: null },
      ...extractRequestMeta(request),
    });

    // Send notification to seller about product approval
    await notifySellerProductStatusChange(product.sellerId, productId, "ACTIVE", product.title);
    console.log(`✅ [approveProduct] In-app notification sent to seller ${product.sellerId} for product "${product.title}"`);

    // Send email to seller about product approval
    // Use included relation first; fall back to direct DB lookup so email is
    // never silently skipped due to a missing Prisma include result.
    let sellerForEmail = product.seller;
    if (!sellerForEmail?.email) {
      console.warn(`⚠️  [approveProduct] product.seller missing — fetching seller ${product.sellerId} directly`);
      sellerForEmail = await prisma.user.findUnique({
        where: { id: product.sellerId },
        select: { id: true, name: true, email: true }
      });
    }
    if (sellerForEmail?.email) {
      console.log(`📧 [approveProduct] Sending approval email to seller ${sellerForEmail.email}`);
      try {
        const result = await sendSellerProductApprovedEmail(sellerForEmail.email, sellerForEmail.name, {
          productTitle: product.title,
          productId
        });
        if (result.success) {
          console.log(`✅ [approveProduct] Approval email sent to ${sellerForEmail.email}`);
        } else {
          console.error(`❌ [approveProduct] Email failed for ${sellerForEmail.email}:`, result.error);
        }
      } catch (emailErr) {
        console.error(`❌ [approveProduct] Email error for ${sellerForEmail.email}:`, emailErr.message);
      }
    } else {
      console.error(`❌ [approveProduct] Seller email still not found for sellerId=${product.sellerId} — email skipped`);
    }

    // Fetch updated product with featuredImage via raw SQL
    const rows = await prisma.$queryRaw`
      SELECT id, title, description, price, category, stock, "sellerId", "sellerName",
             "artistName", status, "isActive", featured, tags,
             "featuredImage", images AS "galleryImages",
             "rejectionReason", "createdAt", "updatedAt"
      FROM "products"
      WHERE id = ${productId}
    `;

    reply.send({
      success: true,
      message: "Product approved successfully",
      product: rows[0] || approvedProduct
    });
  } catch (error) {
    console.error("Approve product error:", error);
    reply.status(500).send({ success: false, message: error.message });
  }
};

// REJECT PRODUCT (Admin only)
exports.rejectProduct = async (request, reply) => {
  try {
    // Only admin can access
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { productId } = request.params;
    const body = request.body || {};
    const query = request.query || {};
    
    // Handle body or query params, and both 'reason' and 'rejectionReason' field names
    const reason = body.reason || body.rejectionReason || query.reason || query.rejectionReason;

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        seller: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    if (!product) {
      return reply.status(404).send({
        success: false,
        message: "Product not found"
      });
    }

    // Mark product as REJECTED (distinct from INACTIVE so admin can track it)
    await prisma.product.update({
      where: { id: productId },
      data: {
        status: "REJECTED",
        rejectionReason: reason || "No reason provided"
      }
    });
    // isActive managed outside Prisma schema regeneration — keep via raw SQL
    await prisma.$executeRaw`UPDATE "products" SET "isActive" = false WHERE "id" = ${productId}`;

    // ── Audit log: product rejected ───────────────────────────────────────
    auditLog({
      entityType:   ENTITY_TYPES.PRODUCT,
      entityId:     productId,
      action:       AUDIT_ACTIONS.PRODUCT_REJECTED,
      previousData: product,
      newData:      { ...product, status: 'REJECTED', isActive: false, rejectionReason: reason || 'No reason provided' },
      reason:       reason || 'No reason provided',
      ...extractRequestMeta(request),
    });

    // Send notification to seller about product rejection
    await notifySellerProductStatusChange(product.sellerId, productId, "REJECTED", product.title, reason || "No specific reason provided");
    console.log(`✅ [rejectProduct] In-app notification sent to seller ${product.sellerId} for product "${product.title}"`);

    // Send email to seller about product rejection
    // Use included relation first; fall back to direct DB lookup.
    let sellerForEmail = product.seller;
    if (!sellerForEmail?.email) {
      console.warn(`⚠️  [rejectProduct] product.seller missing — fetching seller ${product.sellerId} directly`);
      sellerForEmail = await prisma.user.findUnique({
        where: { id: product.sellerId },
        select: { id: true, name: true, email: true }
      });
    }
    if (sellerForEmail?.email) {
      console.log(`📧 [rejectProduct] Sending rejection email to seller ${sellerForEmail.email}`);
      try {
        const result = await sendSellerProductRejectedEmail(sellerForEmail.email, sellerForEmail.name, {
          productTitle: product.title,
          reason: reason || 'No specific reason provided',
          productId
        });
        if (result.success) {
          console.log(`✅ [rejectProduct] Rejection email sent to ${sellerForEmail.email}`);
        } else {
          console.error(`❌ [rejectProduct] Email failed for ${sellerForEmail.email}:`, result.error);
        }
      } catch (emailErr) {
        console.error(`❌ [rejectProduct] Email error for ${sellerForEmail.email}:`, emailErr.message);
      }
    } else {
      console.error(`❌ [rejectProduct] Seller email still not found for sellerId=${product.sellerId} — email skipped`);
    }

    reply.send({
      success: true,
      message: "Product rejected successfully",
      reason: reason || "No specific reason provided"
    });
  } catch (error) {
    console.error("Reject product error:", error);
    reply.status(500).send({ success: false, message: error.message });
  }
};

// ACTIVATE PRODUCT (Admin only) - set product live
exports.activateProduct = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { productId } = request.params;

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      return reply.status(404).send({ success: false, message: 'Product not found' });
    }

    await prisma.product.update({
      where: { id: productId },
      data: { status: 'ACTIVE' }
    });

    await prisma.$executeRaw`UPDATE "products" SET "isActive" = true WHERE "id" = ${productId}`;

    // For VARIABLE products, confirm they have variant stock before activating
    if (product.type === 'VARIABLE') {
      const variantStock = await prisma.$queryRaw`
        SELECT COALESCE(SUM(stock), 0)::int AS total_stock
        FROM "product_variants"
        WHERE "productId" = ${productId} AND "isActive" = true
      `;
      const totalVariantStock = variantStock[0]?.total_stock ?? 0;
      if (totalVariantStock === 0) {
        console.warn(`⚠️  [activateProduct] VARIABLE product "${product.title}" activated but all variants have 0 stock`);
      }
    }

    // ── Audit log: product activated ──────────────────────────────────────
    auditLog({
      entityType:   ENTITY_TYPES.PRODUCT,
      entityId:     productId,
      action:       AUDIT_ACTIONS.PRODUCT_ACTIVATED,
      previousData: product,
      newData:      { ...product, status: 'ACTIVE', isActive: true },
      ...extractRequestMeta(request),
    });

    // Send notification to seller
    await notifySellerProductStatusChange(product.sellerId, productId, "ACTIVE", product.title);

    // Email seller (non-blocking)
    prisma.user.findUnique({ where: { id: product.sellerId }, select: { email: true, name: true } })
      .then(sellerUser => {
        if (sellerUser?.email) {
          sendSellerProductActivatedEmail(sellerUser.email, sellerUser.name || 'Seller', {
            productTitle: product.title,
            productId
          }).catch(err => console.error('Seller activated email error:', err.message));
        }
      }).catch(err => console.error('Seller lookup error (activate email):', err.message));

    reply.send({ success: true, message: 'Product activated successfully' });
  } catch (error) {
    console.error('Activate product error:', error);
    reply.status(500).send({ success: false, message: error.message });
  }
};

// DEACTIVATE PRODUCT (Admin only) - hide product from public
exports.deactivateProduct = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { productId } = request.params;
    const body = request.body || {};
    const query = request.query || {};
    const reason = body.reason || body.rejectionReason || query.reason || query.rejectionReason;

    if (!reason || !reason.trim()) {
      return reply.status(400).send({
        success: false,
        message: 'A reason is required when deactivating a product. The seller will be notified with this reason.'
      });
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      return reply.status(404).send({ success: false, message: 'Product not found' });
    }

    await prisma.product.update({
      where: { id: productId },
      data: { 
        status: 'INACTIVE',
        rejectionReason: reason || null
      }
    });

    await prisma.$executeRaw`UPDATE "products" SET "isActive" = false WHERE "id" = ${productId}`;

    // ── Audit log: product deactivated ────────────────────────────────────
    auditLog({
      entityType:   ENTITY_TYPES.PRODUCT,
      entityId:     productId,
      action:       AUDIT_ACTIONS.PRODUCT_DEACTIVATED,
      previousData: product,
      newData:      { ...product, status: 'INACTIVE', isActive: false },
      reason:       reason || null,
      ...extractRequestMeta(request),
    });

    // Send notification to seller
    await notifySellerProductStatusChange(product.sellerId, productId, "INACTIVE", product.title, reason);

    // Email seller (non-blocking)
    prisma.user.findUnique({ where: { id: product.sellerId }, select: { email: true, name: true } })
      .then(sellerUser => {
        if (sellerUser?.email) {
          sendSellerProductDeactivatedEmail(sellerUser.email, sellerUser.name || 'Seller', {
            productTitle: product.title,
            reason,
            productId
          }).catch(err => console.error('Seller deactivated email error:', err.message));
        }
      }).catch(err => console.error('Seller lookup error (deactivate email):', err.message));

    reply.send({ success: true, message: 'Product deactivated successfully' });
  } catch (error) {
    console.error('Deactivate product error:', error);
    reply.status(500).send({ success: false, message: error.message });
  }
};

// BULK APPROVE PRODUCTS (Admin only)
exports.bulkApproveProducts = async (request, reply) => {
  try {
    // Only admin can access
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { productIds } = request.body;

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return reply.status(400).send({
        success: false,
        message: "Product IDs array is required"
      });
    }

    const result = await prisma.product.updateMany({
      where: {
        id: { in: productIds },
        status: "PENDING" // Only approve pending products
      },
      data: {
        status: "ACTIVE"
      }
    });

    // Update isActive using raw SQL for bulk approval
    await prisma.$executeRaw`UPDATE "products" SET "isActive" = true WHERE "id" = ANY(${productIds})`;

    // ── Audit log: bulk approved ─────────────────────────────────────────────
    auditLog({
      entityType: ENTITY_TYPES.PRODUCT,
      entityId:   'BULK',
      action:     AUDIT_ACTIONS.PRODUCT_BULK_APPROVED,
      newData:    { productIds, approvedCount: result.count },
      reason:     `Bulk approval of ${result.count} product(s)`,
      ...extractRequestMeta(request),
    });

    reply.send({
      success: true,
      message: `${result.count} products approved successfully`,
      approvedCount: result.count
    });
  } catch (error) {
    console.error("Bulk approve products error:", error);
    reply.status(500).send({ success: false, message: error.message });
  }
};

// ==================== REVENUE & ORDERS CHART (ADMIN) ====================
// GET /admin/analytics/revenue-chart?period=7D|30D|1Y
// Returns daily (7D/30D) or monthly (1Y) revenue & order count for DELIVERED orders
exports.getRevenueOrdersChart = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    // Extract query parameters for date filtering
    const { startDate: startDateParam, endDate: endDateParam } = request.query;
    
    // Set default date range (last 30 days) if no dates provided
    let startDate, endDate;
    
    if (startDateParam || endDateParam) {
      // Use provided dates
      startDate = startDateParam ? new Date(startDateParam) : new Date();
      endDate = endDateParam ? new Date(endDateParam) : new Date();
      
      // Validate dates
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return reply.status(400).send({ 
          success: false, 
          message: 'Invalid date format. Use YYYY-MM-DD format.' 
        });
      }
      
      if (startDate > endDate) {
        return reply.status(400).send({ 
          success: false, 
          message: 'Start date cannot be after end date.' 
        });
      }
    } else {
      // Default to last 30 days
      endDate = new Date();
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);
    }

    // Set time boundaries
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    // Determine if we should group by month (for ranges > 90 days) or by day
    const daysDifference = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    const groupByMonth = daysDifference > 90;

    // Query all orders grouped by date or month (based on when order was placed)
    let rows;
    if (groupByMonth) {
      rows = await prisma.$queryRaw`
        SELECT
          TO_CHAR(DATE_TRUNC('month', "createdAt"), 'YYYY-MM-DD') AS date,
          COUNT(*)::int                                            AS orders,
          COALESCE(SUM("totalAmount"), 0)::float                  AS revenue
        FROM orders
        WHERE "createdAt" >= ${startDate}
          AND "createdAt" <= ${endDate}
        GROUP BY DATE_TRUNC('month', "createdAt")
        ORDER BY DATE_TRUNC('month', "createdAt") ASC
      `;
    } else {
      rows = await prisma.$queryRaw`
        SELECT
          TO_CHAR(DATE("createdAt"), 'YYYY-MM-DD') AS date,
          COUNT(*)::int                            AS orders,
          COALESCE(SUM("totalAmount"), 0)::float   AS revenue
        FROM orders
        WHERE "createdAt" >= ${startDate}
          AND "createdAt" <= ${endDate}
        GROUP BY DATE("createdAt")
        ORDER BY DATE("createdAt") ASC
      `;
    }

    // Build a complete date list for the period (fill missing dates with 0)
    const resultMap = {};
    for (const row of rows) {
      resultMap[row.date] = { orders: row.orders, revenue: Number(row.revenue) };
    }

    const chartData = [];
    if (groupByMonth) {
      // Iterate month by month within the date range
      const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
      const endCursor = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
      
      while (cursor <= endCursor) {
        const key = cursor.toISOString().slice(0, 10); // YYYY-MM-DD (1st of month)
        chartData.push({
          date: key,
          orders: resultMap[key]?.orders ?? 0,
          revenue: resultMap[key]?.revenue ?? 0
        });
        cursor.setMonth(cursor.getMonth() + 1);
      }
    } else {
      // Iterate day by day within the date range
      const cursor = new Date(startDate);
      while (cursor <= endDate) {
        const key = cursor.toISOString().slice(0, 10); // YYYY-MM-DD
        chartData.push({
          date: key,
          orders: resultMap[key]?.orders ?? 0,
          revenue: resultMap[key]?.revenue ?? 0
        });
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    return reply.send({
      success: true,
      period: {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        groupBy: groupByMonth ? 'month' : 'day'
      },
      note: 'Revenue and order counts are based on all orders from the date they were placed (createdAt).',
      data: chartData
    });
  } catch (error) {
    console.error('Revenue orders chart error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// BACKFILL ORDER NOTIFICATIONS (Admin only)
// Creates OrderNotification records for all orders that don't have one yet.
// Run once after deployment to populate historical data.
exports.backfillOrderNotifications = async (request, reply) => {
  try {
    const result = await backfillOrderNotifications();
    return reply.status(200).send({
      success: true,
      message: `Backfill complete. Created ${result.created} notification(s), skipped ${result.skipped} (already existed).`,
      ...result
    });
  } catch (error) {
    console.error('Backfill notifications error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// ==================== PRODUCT RECYCLE BIN (Admin) ====================

/**
 * GET /admin/products/recycle-bin
 * Lists all soft-deleted products across all sellers.
 * Optional: ?sellerId=xxx &page=1 &limit=50
 */
exports.getAdminRecycleBin = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { sellerId, page = 1, limit = 50 } = request.query;
    const take   = Math.min(Number(limit), 200);
    const offset = (Number(page) - 1) * take;

    let products;
    if (sellerId) {
      products = await prisma.$queryRaw`
        SELECT p.id, p.title, p.price, p.category, p.stock, p."sellerId",
               p."sellerName", p.status, p."featuredImage",
               p."deletedAt", p."deletedBy", p."deletedByRole",
               p."createdAt", p."updatedAt",
               u.name AS "seller_name", u.email AS "seller_email"
        FROM "products" p
        JOIN "users" u ON u.id = p."sellerId"
        WHERE p."deletedAt" IS NOT NULL
          AND p."sellerId" = ${sellerId}
        ORDER BY p."deletedAt" DESC
        LIMIT ${take} OFFSET ${offset}
      `;
    } else {
      products = await prisma.$queryRaw`
        SELECT p.id, p.title, p.price, p.category, p.stock, p."sellerId",
               p."sellerName", p.status, p."featuredImage",
               p."deletedAt", p."deletedBy", p."deletedByRole",
               p."createdAt", p."updatedAt",
               u.name AS "seller_name", u.email AS "seller_email"
        FROM "products" p
        JOIN "users" u ON u.id = p."sellerId"
        WHERE p."deletedAt" IS NOT NULL
        ORDER BY p."deletedAt" DESC
        LIMIT ${take} OFFSET ${offset}
      `;
    }

    const countRows = sellerId
      ? await prisma.$queryRaw`SELECT COUNT(*)::int AS total FROM "products" WHERE "deletedAt" IS NOT NULL AND "sellerId" = ${sellerId}`
      : await prisma.$queryRaw`SELECT COUNT(*)::int AS total FROM "products" WHERE "deletedAt" IS NOT NULL`;
    const total = countRows[0]?.total ?? 0;

    return reply.send({
      success:  true,
      products: products.map(({ seller_name, seller_email, ...p }) => ({
        ...p,
        seller: { id: p.sellerId, name: seller_name, email: seller_email }
      })),
      meta: { total, page: Number(page), limit: take, pages: Math.ceil(total / take) }
    });
  } catch (error) {
    console.error('Get admin recycle bin error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/**
 * DELETE /admin/products/:productId/permanent
 * Permanently (hard) deletes a product that is already in the Recycle Bin.
 */
exports.permanentlyDeleteProduct = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }

    const { productId } = request.params;

    const rows = await prisma.$queryRaw`SELECT * FROM "products" WHERE id = ${productId}`;
    const product = rows[0];

    if (!product) {
      return reply.status(404).send({ success: false, message: 'Product not found.' });
    }

    if (!product.deletedAt) {
      return reply.status(400).send({
        success: false,
        message: 'Product is not in the Recycle Bin. Soft-delete it first before permanently deleting.'
      });
    }

    // Audit log before hard delete — last chance to record it
    await auditLog({
      entityType:   ENTITY_TYPES.PRODUCT,
      entityId:     productId,
      action:       AUDIT_ACTIONS.PRODUCT_PERMANENTLY_DELETED,
      previousData: product,
      reason:       request.body?.reason ?? `Permanently deleted from Recycle Bin by ${request.user.role} (${request.user.email})`,
      ...extractRequestMeta(request),
    });

    await prisma.product.delete({ where: { id: productId } });

    return reply.send({
      success: true,
      message: 'Product permanently deleted. This action cannot be undone.'
    });
  } catch (error) {
    console.error('Permanent delete product error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// ==================== AUDIT LOG QUERIES (Admin only) ====================

/**
 * GET /admin/audit-logs
 * Query params: entityType, entityId, actorId, action, from, to, page, limit
 */
exports.getAuditLogs = async (request, reply) => {
  try {
    const {
      entityType,
      entityId,
      actorId,
      action,
      from,
      to,
      page  = 1,
      limit = 50,
    } = request.query;

    const where = {};
    if (entityType) where.entityType = entityType;
    if (entityId)   where.entityId   = entityId;
    if (actorId)    where.actorId    = actorId;
    if (action)     where.action     = action;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   where.createdAt.lte = new Date(to);
    }

    const take = Math.min(Number(limit), 200); // hard cap
    const skip = (Number(page) - 1) * take;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return reply.send({
      success: true,
      data:    logs,
      meta: {
        total,
        page:  Number(page),
        limit: take,
        pages: Math.ceil(total / take),
      },
    });
  } catch (error) {
    console.error('Get audit logs error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

/**
 * GET /admin/audit-logs/products/:productId
 * Full immutable history for a single product, newest first.
 */
exports.getProductAuditHistory = async (request, reply) => {
  try {
    const { productId } = request.params;
    const { page = 1, limit = 50 } = request.query;
    const callerRole = request.user?.role;
    const callerId   = request.user?.userId;

    // ── Role gate: only ADMIN or SELLER may call this endpoint ───────────────
    if (!isAdminRole(callerRole) && callerRole !== 'SELLER') {
      return reply.status(403).send({
        success: false,
        message: 'Access denied. Admin or Seller account required.',
      });
    }

    // ── Seller ownership check ────────────────────────────────────────────────
    // Sellers may only view audit logs for their own products.
    if (callerRole === 'SELLER') {
      const product = await prisma.product.findUnique({
        where:  { id: productId },
        select: { sellerId: true },
      });

      if (!product) {
        return reply.status(404).send({ success: false, message: 'Product not found.' });
      }

      if (product.sellerId !== callerId) {
        return reply.status(403).send({
          success: false,
          message: 'You do not have permission to view audit logs for this product.',
        });
      }
    }

    const take = Math.min(Number(limit), 200);
    const skip = (Number(page) - 1) * take;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where:   { entityType: 'PRODUCT', entityId: productId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.auditLog.count({ where: { entityType: 'PRODUCT', entityId: productId } }),
    ]);

    // ── Strip internal-only fields from seller responses ─────────────────────
    const data = callerRole === 'SELLER'
      ? logs.map(({ actorIp, userAgent, requestId, ...entry }) => entry)
      : logs;

    return reply.send({
      success: true,
      productId,
      data,
      meta: {
        total,
        page:  Number(page),
        limit: take,
        pages: Math.ceil(total / take),
      },
    });
  } catch (error) {
    console.error('Get product audit history error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// ─── BANK CHANGE REQUESTS (Admin) ────────────────────────────────────────────

// GET /admin/bank-change-requests?status=PENDING|APPROVED|REJECTED&page=1&limit=20
exports.getBankChangeRequests = async (request, reply) => {
  try {
    const { status, page = 1, limit = 20 } = request.query;
    const take = Math.min(parseInt(limit, 10) || 20, 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = status ? { status } : {};

    const [requests, total] = await Promise.all([
      prisma.bankChangeRequest.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          seller: {
            select: {
              userId: true,
              storeName: true,
              businessName: true,
              bankDetails: true,
              user: { select: { email: true, name: true } }
            }
          }
        }
      }),
      prisma.bankChangeRequest.count({ where })
    ]);

    return reply.status(200).send({
      success: true,
      requests,
      pagination: {
        total,
        page: parseInt(page, 10),
        limit: take,
        pages: Math.ceil(total / take)
      }
    });
  } catch (error) {
    console.error('getBankChangeRequests error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// GET /admin/bank-change-requests/:id
exports.getBankChangeRequest = async (request, reply) => {
  try {
    const { id } = request.params;

    const changeRequest = await prisma.bankChangeRequest.findUnique({
      where: { id },
      include: {
        seller: {
          select: {
            userId: true,
            storeName: true,
            businessName: true,
            bankDetails: true,
            user: { select: { email: true, name: true } }
          }
        }
      }
    });

    if (!changeRequest) {
      return reply.status(404).send({ success: false, message: 'Bank change request not found' });
    }

    return reply.status(200).send({ success: true, request: changeRequest });
  } catch (error) {
    console.error('getBankChangeRequest error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// POST /admin/bank-change-requests/:id/approve
exports.approveBankChangeRequest = async (request, reply) => {
  try {
    const adminId = request.user.userId || request.user.id;
    const { id } = request.params;

    const changeRequest = await prisma.bankChangeRequest.findUnique({ where: { id } });

    if (!changeRequest) {
      return reply.status(404).send({ success: false, message: "Bank change request not found" });
    }

    if (changeRequest.status !== 'PENDING') {
      return reply.status(409).send({ success: false, message: `Request is already ${changeRequest.status.toLowerCase()}` });
    }

    // Apply the new bank details and mark request as approved in one transaction
    await prisma.$transaction([
      prisma.sellerProfile.update({
        where: { userId: changeRequest.sellerId },
        data: { bankDetails: changeRequest.newBankDetails }
      }),
      prisma.bankChangeRequest.update({
        where: { id },
        data: { status: 'APPROVED', reviewedBy: adminId }
      })
    ]);

    // Notify seller (non-blocking)
    prisma.user.findUnique({
      where: { id: changeRequest.sellerId },
      select: { name: true, email: true }
    }).then(seller => {
      if (seller) {
        notifySellerBankChangeApproved(changeRequest.sellerId, id, {
          sellerName: seller.name,
          sellerEmail: seller.email,
          newBankDetails: changeRequest.newBankDetails
        }).catch(err => console.error('Bank change approved notification error (non-blocking):', err.message));
      }
    }).catch(err => console.error('Seller lookup for bank notification error:', err.message));

    return reply.status(200).send({
      success: true,
      message: "Bank details change request approved and applied"
    });
  } catch (error) {
    console.error('approveBankChangeRequest error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// POST /admin/bank-change-requests/:id/reject
// Body: { reviewNote: string }
exports.rejectBankChangeRequest = async (request, reply) => {
  try {
    const adminId = request.user.userId || request.user.id;
    const { id } = request.params;
    const { reviewNote } = request.body || {};

    const changeRequest = await prisma.bankChangeRequest.findUnique({ where: { id } });

    if (!changeRequest) {
      return reply.status(404).send({ success: false, message: "Bank change request not found" });
    }

    if (changeRequest.status !== 'PENDING') {
      return reply.status(409).send({ success: false, message: `Request is already ${changeRequest.status.toLowerCase()}` });
    }

    await prisma.bankChangeRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewedBy: adminId,
        reviewNote: reviewNote ? reviewNote.trim() : null
      }
    });

    // Notify seller (non-blocking)
    prisma.user.findUnique({
      where: { id: changeRequest.sellerId },
      select: { name: true, email: true }
    }).then(seller => {
      if (seller) {
        notifySellerBankChangeRejected(changeRequest.sellerId, id, {
          sellerName: seller.name,
          sellerEmail: seller.email,
          reviewNote: reviewNote ? reviewNote.trim() : null
        }).catch(err => console.error('Bank change rejected notification error (non-blocking):', err.message));
      }
    }).catch(err => console.error('Seller lookup for bank notification error:', err.message));

    return reply.status(200).send({
      success: true,
      message: "Bank details change request rejected"
    });
  } catch (error) {
    console.error('rejectBankChangeRequest error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/orders/detailed
// Comprehensive order list for the admin dashboard.
// Returns every parent order with:
//   - Full customer info + shipping address
//   - Payment details (method, status, amounts, coupon)
//   - For MULTI_SELLER orders: sub-orders with seller profile + items
//   - For DIRECT orders:        seller info + items
//   - For LEGACY orders:        items grouped per seller
//
// Query params:
//   page            (default 1)
//   limit           (default 20, max 100)
//   status          OrderStatus filter on overallStatus
//   paymentStatus   PaymentStatus filter
//   search          Customer name or e-mail (case-insensitive)
//   from / to       ISO date range  (e.g. 2026-01-01 / 2026-03-31)
//   orderType       MULTI_SELLER | DIRECT | LEGACY  (omit for all)
// ─────────────────────────────────────────────────────────────────────────────
exports.getAllOrdersDetailed = async (request, reply) => {
  try {
    if (!request.user || !isAdminRole(request.user.role)) {
      return reply.status(403).send({ success: false, message: 'Access denied. Admins only.' });
    }

    const {
      page = 1,
      limit = 20,
      status,
      paymentStatus,
      search,
      from,
      to,
      orderType,
    } = request.query;

    const take = Math.min(parseInt(limit, 10) || 20, 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    // ── Build where clause ───────────────────────────────────────────────────
    const where = {};

    if (status)        where.overallStatus  = status;
    if (paymentStatus) where.paymentStatus  = paymentStatus;

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   where.createdAt.lte = new Date(to);
    }

    if (search) {
      where.OR = [
        { customerName:  { contains: search, mode: 'insensitive' } },
        { customerEmail: { contains: search, mode: 'insensitive' } },
        { user: { name:  { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (orderType === 'MULTI_SELLER') {
      where.subOrders = { some: {} };
    } else if (orderType === 'DIRECT') {
      where.sellerId  = { not: null };
      where.subOrders = { none: {} };
    } else if (orderType === 'LEGACY') {
      where.sellerId  = null;
      where.subOrders = { none: {} };
    }

    // ── Fetch orders + count ─────────────────────────────────────────────────
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, name: true, email: true, phone: true },
          },
          seller: {
            select: { id: true, name: true, email: true },
          },
          // Legacy / direct items
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  title: true,
                  featuredImage: true,
                  sellerId: true,
                  seller: { select: { id: true, name: true, email: true } },
                },
              },
              productVariant: {
                include: {
                  variantAttributeValues: {
                    include: { attributeValue: { include: { attribute: true } } }
                  }
                }
              },
            },
          },
          // Multi-seller sub-orders
          subOrders: {
            orderBy: { createdAt: 'asc' },
            include: {
              seller: {
                select: { id: true, name: true, email: true },
              },
              sellerProfile: {
                select: { storeName: true, businessName: true, storeLogo: true },
              },
              items: {
                include: {
                  product: {
                    select: { id: true, title: true, featuredImage: true },
                  },
                  productVariant: {
                    include: {
                      variantAttributeValues: {
                        include: { attributeValue: { include: { attribute: true } } }
                      }
                    }
                  },
                },
              },
            },
          },
        },
      }),
      prisma.order.count({ where }),
    ]);

    // ── Transform ────────────────────────────────────────────────────────────
    const transformed = orders.map(order => {
      const hasSubOrders    = order.subOrders.length > 0;
      const hasDirectSeller = !!order.sellerId;

      const detectedType = hasSubOrders
        ? 'MULTI_SELLER'
        : hasDirectSeller
          ? 'DIRECT'
          : 'LEGACY';

      // ── Customer ──
      const isGuest = !order.user && !order.userId;
      const customer = order.user
        ? { id: order.user.id,  name: order.user.name,  email: order.user.email,  phone: order.user.phone  }
        : { id: null,           name: order.customerName, email: order.customerEmail, phone: order.customerPhone };

      // ── Shipping address ──
      const shippingAddress = {
        line:    order.shippingAddressLine
                   || (order.shippingAddress && typeof order.shippingAddress === 'object'
                         ? order.shippingAddress.line || order.shippingAddress.address
                         : null),
        city:    order.shippingCity,
        state:   order.shippingState,
        zipCode: order.shippingZipCode,
        country: order.shippingCountry,
        phone:   order.shippingPhone,
      };

      // ── Order summary (subtotal, GST, shipping, coupon, total) ──
      // Stored inside shippingAddress JSON at order-creation time
      const rawSummary = (order.shippingAddress && typeof order.shippingAddress === 'object')
        ? order.shippingAddress.orderSummary || null
        : null;

      const orderSummary = rawSummary
        ? {
            subtotal:          rawSummary.subtotal          ?? null,
            shippingCost:      rawSummary.shippingCost       ?? null,
            totalShippingCost: rawSummary.totalShippingCost  ?? null,
            gstPercentage:     rawSummary.gstPercentage      ?? null,
            gstAmount:         rawSummary.gstAmount          ?? null,
            gstDetails:        rawSummary.gstDetails         || null,
            couponCode:        rawSummary.couponCode         || order.couponCode || null,
            discountAmount:    rawSummary.discountAmount     ?? (order.discountAmount != null ? parseFloat(order.discountAmount) : null),
            grandTotal:        rawSummary.grandTotal         ?? null,
            finalTotal:        rawSummary.finalTotal         ?? parseFloat(order.totalAmount),
            shippingMethod:    rawSummary.shippingMethod     || null,
          }
        : {
            // Fallback for older orders that pre-date orderSummary storage
            subtotal:          order.originalTotal != null ? parseFloat(order.originalTotal) : parseFloat(order.totalAmount),
            shippingCost:      null,
            totalShippingCost: null,
            gstPercentage:     null,
            gstAmount:         null,
            gstDetails:        null,
            couponCode:        order.couponCode || null,
            discountAmount:    order.discountAmount != null ? parseFloat(order.discountAmount) : null,
            grandTotal:        null,
            finalTotal:        parseFloat(order.totalAmount),
            shippingMethod:    null,
          };

      // ── Shared base fields ──
      // For MULTI_SELLER orders derive the real status live from sub-orders so stale
      // DB columns never cause a mismatch. For other types prefer status → overallStatus.
      const resolvedStatus = hasSubOrders
        ? deriveMultiSellerStatus(order.subOrders.map(s => s.status))
        : (order.status || order.overallStatus || 'CONFIRMED');

      const base = {
        id:                    order.id,
        displayId:             toDisplayId(order.displayId),
        orderType:             detectedType,
        ...(isGuest ? { isGuest: 'guest' } : {}),
        status:                resolvedStatus,
        overallStatus:         resolvedStatus,
        paymentStatus:         order.paymentStatus,
        paymentMethod:         order.paymentMethod || null,
        totalAmount:           parseFloat(order.totalAmount),
        originalTotal:         order.originalTotal  != null ? parseFloat(order.originalTotal)  : null,
        discountAmount:        order.discountAmount  != null ? parseFloat(order.discountAmount)  : null,
        couponCode:            order.couponCode      || null,
        stripePaymentIntentId: order.stripePaymentIntentId || null,
        orderSummary,
        customer,
        shippingAddress,
        createdAt:  order.createdAt,
        updatedAt:  order.updatedAt,
      };

      // ── MULTI_SELLER: return sub-orders ──
      if (hasSubOrders) {
        return {
          ...base,
          sellerCount: order.subOrders.length,
          subOrders: order.subOrders.map((sub, idx) => ({
            // Identification fields — parent + sub-order + seller
            subOrderId:        sub.id,
            subDisplayId:      toSubDisplayId(order.displayId, idx),
            parentOrderId:     sub.parentOrderId,
            parentDisplayId:   toDisplayId(order.displayId),
            sellerId:          sub.sellerId,
            sellerName:        sub.seller?.name  || null,
            sellerEmail:       sub.seller?.email || null,
            // Status & amounts
            status:            sub.status,
            subtotal:          parseFloat(sub.subtotal),
            trackingNumber:    sub.trackingNumber    || null,
            estimatedDelivery: sub.estimatedDelivery || null,
            // Full seller profile
            seller: {
              id:           sub.seller.id,
              name:         sub.seller.name,
              email:        sub.seller.email,
              storeName:    sub.sellerProfile?.storeName    || null,
              businessName: sub.sellerProfile?.businessName || null,
              storeLogo:    sub.sellerProfile?.storeLogo    || null,
            },
            items: sub.items.map(formatOrderItem),
            itemCount:  sub.items.length,
            createdAt:  sub.createdAt,
            updatedAt:  sub.updatedAt,
          })),
        };
      }

      // ── DIRECT: single seller ──
      if (hasDirectSeller) {
        const sellerInfo = order.seller
          || order.items[0]?.product?.seller
          || null;

        return {
          ...base,
          // Identification fields — order + seller
          orderId:    order.id,
          displayId:  toDisplayId(order.displayId),
          sellerId:   order.sellerId,
          sellerName: sellerInfo?.name  || null,
          sellerEmail: sellerInfo?.email || null,
          seller: sellerInfo
            ? { id: sellerInfo.id, name: sellerInfo.name, email: sellerInfo.email }
            : null,
          trackingNumber:    order.trackingNumber    || null,
          estimatedDelivery: order.estimatedDelivery || null,
          items: order.items.map(formatOrderItem),
          itemCount: order.items.length,
          subOrders: [],
        };
      }

      // ── LEGACY: group items by seller ──
      const sellerMap = {};
      order.items.forEach(item => {
        const sid    = item.product?.sellerId;
        const sData  = item.product?.seller;
        if (!sid) return;
        if (!sellerMap[sid]) {
          sellerMap[sid] = {
            seller:   sData ? { id: sData.id, name: sData.name, email: sData.email } : { id: sid },
            items:    [],
            subtotal: 0,
          };
        }
        sellerMap[sid].items.push(formatOrderItem(item));
        sellerMap[sid].subtotal += parseFloat(item.price || 0) * item.quantity;
      });

      return {
        ...base,
        trackingNumber:    order.trackingNumber    || null,
        estimatedDelivery: order.estimatedDelivery || null,
        sellers:   Object.values(sellerMap),
        items: order.items.map(formatOrderItem),
        itemCount: order.items.length,
        subOrders: [],
      };
    });

    return reply.status(200).send({
      success: true,
      orders: transformed,
      pagination: {
        total,
        page:  Number(page),
        limit: take,
        pages: Math.ceil(total / take),
      },
    });
  } catch (error) {
    console.error('getAllOrdersDetailed error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// ── Sponsored Section Management ─────────────────────────────────────────────

// Create sponsored section (Admin only)
exports.createSponsoredSection = async (request, reply) => {
  try {
    const { role } = request.user;
    if (!isAdminRole(role)) {
      return reply.status(403).send({ success: false, error: 'Forbidden' });
    }

    let requestData = {};
    let mediaUrl = null;
    let mediaType = 'IMAGE';

    // Check if request is multipart (for file uploads)
    if (request.isMultipart()) {
      console.log('Processing multipart form-data...');
      const parts = request.parts();

      for await (const part of parts) {
        console.log('Part detected - Type:', part.type, 'Fieldname:', part.fieldname, 'Value:', part.value);
        
        if (part.type === 'file') {
          // Handle file upload (media file - image or video)
          console.log('File detected:', part.filename, 'Fieldname:', part.fieldname);
          
          if (part.fieldname === 'media' || part.fieldname === 'mediaFile') {
            try {
              // Ensure uploads directory exists
              const uploadsDir = path.join(__dirname, '../uploads/');
              if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
              }

              const tempPath = path.join(uploadsDir, `${Date.now()}_${part.filename}`);
              
              // Write file using stream
              await pipeline(part.file, fs.createWriteStream(tempPath));
              console.log('File saved to temp path:', tempPath);

              // Determine media type by file extension or MIME type
              const fileExtension = path.extname(part.filename).toLowerCase();
              const mimeType = part.mimetype;
              
              if (mimeType.startsWith('video/') || ['.mp4', '.webm', '.mov', '.avi'].includes(fileExtension)) {
                mediaType = 'VIDEO';
              } else {
                mediaType = 'IMAGE';
              }

              // Upload to Cloudinary
              const uploadResult = await uploadToCloudinary(tempPath, 'sponsored');
              mediaUrl = uploadResult.url;
              
              console.log('✓ Cloudinary upload successful:', mediaUrl);

              // Clean up temp file
              try {
                await fs.promises.unlink(tempPath);
                console.log('✓ Temp file cleaned up');
              } catch (unlinkError) {
                console.log('Warning: Could not delete temp file:', unlinkError.message);
              }
            } catch (uploadError) {
              console.error('✗ File upload error:', uploadError);
              return reply.status(500).send({
                success: false,
                error: 'Failed to upload media file: ' + uploadError.message
              });
            }
          }
        } else {
          // Handle regular form fields (CREATE function)
          console.log('Field:', part.fieldname, '=', part.value);
          
          // Trim whitespace and store field
          if (part.fieldname) {
            requestData[part.fieldname] = part.value ? part.value.toString().trim() : part.value;
          }
        }
      }
    } else {
      // Handle JSON body
      requestData = request.body || {};
      mediaUrl = requestData.mediaUrl;
      mediaType = requestData.mediaType || 'IMAGE';
    }
    
    console.log('Processed data:', requestData);
    console.log('Media URL:', mediaUrl);
    console.log('Media Type:', mediaType);
    
    const { title, description, ctaText, ctaUrl, isActive, order } = requestData;

    // Use uploaded media URL if file was uploaded, otherwise use provided URL
    const finalMediaUrl = mediaUrl || requestData.mediaUrl;

    // Validate required fields
    if (!title || !description || !finalMediaUrl || !ctaText || !ctaUrl) {
      console.log('Validation failed - Missing fields:');
      console.log('title:', title);
      console.log('description:', description); 
      console.log('finalMediaUrl:', finalMediaUrl);
      console.log('ctaText:', ctaText);
      console.log('ctaUrl:', ctaUrl);
      
      return reply.status(400).send({ 
        success: false, 
        error: 'Title, description, media file/URL, ctaText, and ctaUrl are required',
        received: { title, description, finalMediaUrl, ctaText, ctaUrl }
      });
    }

    // Validate mediaType if provided in form data
    const finalMediaType = requestData.mediaType || mediaType;
    console.log('Final MediaType being validated:', finalMediaType, 'Type:', typeof finalMediaType);
    
    if (finalMediaType && !['IMAGE', 'VIDEO'].includes(finalMediaType.toString().toUpperCase().trim())) {
      return reply.status(400).send({ 
        success: false, 
        error: 'MediaType must be either IMAGE or VIDEO',
        received: finalMediaType
      });
    }

    const sponsoredSection = await prisma.sponsoredSection.create({
      data: {
        title,
        description,
        mediaUrl: finalMediaUrl,
        mediaType: finalMediaType ? finalMediaType.toString().toUpperCase().trim() : 'IMAGE',
        ctaText,
        ctaUrl,
        isActive: isActive ? isActive === 'true' || isActive === true : true,
        order: order ? parseInt(order) : null
      }
    });

    return reply.status(201).send({
      success: true,
      message: 'Sponsored section created successfully',
      data: sponsoredSection
    });
  } catch (error) {
    console.error('createSponsoredSection error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Get all sponsored sections for admin (active and inactive)
exports.getAllSponsoredSections = async (request, reply) => {
  try {
    const { role } = request.user;
    if (!isAdminRole(role)) {
      return reply.status(403).send({ success: false, error: 'Forbidden' });
    }

    const { page = 1, limit = 10, status } = request.query;
    const skip = (page - 1) * limit;
    const take = parseInt(limit);

    let whereCondition = {};
    if (status !== undefined) {
      whereCondition.isActive = status === 'active';
    }

    const [sponsoredSections, total] = await Promise.all([
      prisma.sponsoredSection.findMany({
        where: whereCondition,
        orderBy: [
          { order: 'asc' },
          { createdAt: 'desc' }
        ],
        skip,
        take
      }),
      prisma.sponsoredSection.count({ where: whereCondition })
    ]);

    return reply.status(200).send({
      success: true,
      data: sponsoredSections,
      pagination: {
        total,
        page: Number(page),
        limit: take,
        pages: Math.ceil(total / take)
      }
    });
  } catch (error) {
    console.error('getAllSponsoredSections error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Update sponsored section (Admin only)
exports.updateSponsoredSection = async (request, reply) => {
  try {
    const { role } = request.user;
    if (!isAdminRole(role)) {
      return reply.status(403).send({ success: false, error: 'Forbidden' });
    }

    const { id } = request.params;
    let requestData = {};
    let mediaUrl = null;
    let mediaType = null;

    // Check if request is multipart (for file uploads)
    if (request.isMultipart()) {
      console.log('Processing multipart form-data...');
      const parts = request.parts();

      for await (const part of parts) {
        if (part.type === 'file') {
          // Handle file upload (media file - image or video)
          console.log('File detected:', part.filename, 'Fieldname:', part.fieldname);
          
          if (part.fieldname === 'media' || part.fieldname === 'mediaFile') {
            try {
              // Ensure uploads directory exists
              const uploadsDir = path.join(__dirname, '../uploads/');
              if (!fs.existsSync(uploadsDir)) {
                fs.mkdirSync(uploadsDir, { recursive: true });
              }

              const tempPath = path.join(uploadsDir, `${Date.now()}_${part.filename}`);
              
              // Write file using stream
              await pipeline(part.file, fs.createWriteStream(tempPath));
              console.log('File saved to temp path:', tempPath);

              // Determine media type by file extension or MIME type
              const fileExtension = path.extname(part.filename).toLowerCase();
              const mimeType = part.mimetype;
              
              if (mimeType.startsWith('video/') || ['.mp4', '.webm', '.mov', '.avi'].includes(fileExtension)) {
                mediaType = 'VIDEO';
              } else {
                mediaType = 'IMAGE';
              }

              // Upload to Cloudinary
              const uploadResult = await uploadToCloudinary(tempPath, 'sponsored');
              mediaUrl = uploadResult.url;
              
              console.log('✓ Cloudinary upload successful:', mediaUrl);

              // Clean up temp file
              try {
                await fs.promises.unlink(tempPath);
                console.log('✓ Temp file cleaned up');
              } catch (unlinkError) {
                console.log('Warning: Could not delete temp file:', unlinkError.message);
              }
            } catch (uploadError) {
              console.error('✗ File upload error:', uploadError);
              return reply.status(500).send({
                success: false,
                error: 'Failed to upload media file: ' + uploadError.message
              });
            }
          }
        } else {
          // Handle regular form fields (UPDATE function)
          console.log('Field:', part.fieldname, '=', part.value);
          
          // Trim whitespace and store field
          if (part.fieldname) {
            requestData[part.fieldname] = part.value ? part.value.toString().trim() : part.value;
          }
        }
      }
    } else {
      // Handle JSON body
      requestData = request.body || {};
    }
    
    const { title, description, ctaText, ctaUrl, isActive, order } = requestData;

    // Check if sponsored section exists
    const existingSection = await prisma.sponsoredSection.findUnique({
      where: { id }
    });

    if (!existingSection) {
      return reply.status(404).send({ 
        success: false, 
        error: 'Sponsored section not found' 
      });
    }

    // Validate mediaType if provided
    const finalMediaType = requestData.mediaType || mediaType;
    if (finalMediaType && !['IMAGE', 'VIDEO'].includes(finalMediaType)) {
      return reply.status(400).send({ 
        success: false, 
        error: 'MediaType must be either IMAGE or VIDEO' 
      });
    }

    // Prepare update data
    const updateData = {};
    if (title !== undefined && title.trim()) updateData.title = title;
    if (description !== undefined && description.trim()) updateData.description = description;
    
    // Only update mediaUrl if we have a new file upload OR a new URL provided
    if (mediaUrl) {
      // New file was uploaded
      updateData.mediaUrl = mediaUrl;
    } else if (requestData.mediaUrl && requestData.mediaUrl.trim()) {
      // New URL provided in form data
      updateData.mediaUrl = requestData.mediaUrl;
    }
    // If neither, don't update mediaUrl - keep existing value
    
    if (finalMediaType !== undefined) updateData.mediaType = finalMediaType;
    if (ctaText !== undefined && ctaText.trim()) updateData.ctaText = ctaText;
    if (ctaUrl !== undefined && ctaUrl.trim()) updateData.ctaUrl = ctaUrl;
    if (isActive !== undefined) updateData.isActive = isActive === 'true' || isActive === true;
    if (order !== undefined) updateData.order = order ? parseInt(order) : null;
    if (order !== undefined) updateData.order = order ? parseInt(order) : null;

    const updatedSection = await prisma.sponsoredSection.update({
      where: { id },
      data: updateData
    });

    return reply.status(200).send({
      success: true,
      message: 'Sponsored section updated successfully',
      data: updatedSection
    });
  } catch (error) {
    console.error('updateSponsoredSection error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// Delete sponsored section (Admin only)
exports.deleteSponsoredSection = async (request, reply) => {
  try {
    const { role } = request.user;
    if (!isAdminRole(role)) {
      return reply.status(403).send({ success: false, error: 'Forbidden' });
    }

    const { id } = request.params;

    // Check if sponsored section exists
    const existingSection = await prisma.sponsoredSection.findUnique({
      where: { id }
    });

    if (!existingSection) {
      return reply.status(404).send({ 
        success: false, 
        error: 'Sponsored section not found' 
      });
    }

    await prisma.sponsoredSection.delete({
      where: { id }
    });

    return reply.status(200).send({
      success: true,
      message: 'Sponsored section deleted successfully'
    });
  } catch (error) {
    console.error('deleteSponsoredSection error:', error);
    return reply.status(500).send({ success: false, error: error.message });
  }
};

// ADMIN - GET ALL REFUND REQUESTS
exports.getAllRefundRequests = async (request, reply) => {
  try {
    const page = parseInt(request.query.page) || 1;
    const limit = parseInt(request.query.limit) || 20;
    const skip = (page - 1) * limit;

    const statusFilter = request.query.status;
    let whereClause = {
      category: 'REFUND_REQUEST'
    };

    if (statusFilter && statusFilter !== 'ALL') {
      whereClause.status = statusFilter;
    }

    const [tickets, totalCount] = await Promise.all([
      prisma.supportTicket.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, name: true, email: true } }
        }
      }),
      prisma.supportTicket.count({ where: whereClause })
    ]);

    // Fetch order details manually since there's no direct relation in Prisma
    const orderIds = [...new Set(tickets.map(t => t.orderId).filter(Boolean))];
    let ordersMap = new Map();
    if (orderIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: {
          id: true,
          displayId: true,
          totalAmount: true,
          status: true,
          customerName: true,
          customerEmail: true,
          user: { select: { id: true, name: true, email: true } },
          items: {
            select: {
              id: true,
              quantity: true,
              price: true,
              product: {
                select: {
                  id: true,
                  title: true,
                  featuredImage: true,
                  price: true,
                  category: true,
                  sellerName: true,
                  sellerId: true
                }
              }
            }
          },
          subOrders: {
            select: {
              id: true,
              sellerId: true,
              items: {
                select: {
                  id: true,
                  quantity: true,
                  price: true,
                  product: {
                    select: {
                      id: true,
                      title: true,
                      featuredImage: true,
                      price: true,
                      category: true,
                      sellerName: true,
                      sellerId: true
                    }
                  }
                }
              }
            }
          }
        }
      });
      orders.forEach(o => ordersMap.set(o.id, o));
    }

    const parseRequestedItems = (message) => {
      try {
        const match = (message || '').match(/---ITEMS_JSON---\n([\s\S]+)/);
        if (!match) return null;
        const parsed = JSON.parse(match[1].trim());
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
      } catch {
        return null;
      }
    };

    const parseRefundReason = (message) => {
      const reasonMatch = (message || '').match(/Reason:\s*([\s\S]+?)(?=\nRequested Items:|\n---ITEMS_JSON---|$)/i);
      return reasonMatch?.[1]?.trim() || null;
    };

    const formatOrderItems = (order) => {
      if (!order) return [];
      const direct = (order.items || []).map(item => ({
        id:          item.id,
        productId:   item.product?.id || null,
        title:       item.product?.title || 'Product',
        image:       item.product?.featuredImage || null,
        category:    item.product?.category || null,
        sellerName:  item.product?.sellerName || null,
        sellerId:    item.product?.sellerId || null,
        quantity:    item.quantity,
        price:       item.price
      }));
      const fromSubs = (order.subOrders || []).flatMap(s =>
        (s.items || []).map(item => ({
          id:          item.id,
          productId:   item.product?.id || null,
          title:       item.product?.title || 'Product',
          image:       item.product?.featuredImage || null,
          category:    item.product?.category || null,
          sellerName:  item.product?.sellerName || null,
          sellerId:    item.product?.sellerId || null,
          quantity:    item.quantity,
          price:       item.price
        }))
      );
      return direct.length > 0 ? direct : fromSubs;
    };

    const formattedTickets = tickets.map(ticket => {
      const order = ordersMap.get(ticket.orderId);
      const requestTypeDisplay =
        ticket.requestType === 'REFUND' ? 'Full Refund' :
        ticket.requestType === 'PARTIAL_REFUND' ? 'Partial Refund' :
        ticket.requestType || null;
      const allOrderItems = formatOrderItems(order);
      // Build a productId → image lookup from the DB-fetched order items
      const imageByProductId = Object.fromEntries(
        allOrderItems.map(i => [i.productId, i.image]).filter(([id]) => id)
      );
      const rawRequestedItems = parseRequestedItems(ticket.message);
      // Enrich requested items with the product image
      const requestedItems = rawRequestedItems
        ? rawRequestedItems.map(ri => ({
            ...ri,
            image: imageByProductId[ri.productId] ?? null
          }))
        : null;
      const customerName  = ticket.user?.name  || order?.user?.name  || order?.customerName  || null;
      const customerEmail = ticket.user?.email || ticket.guestEmail  || order?.user?.email || order?.customerEmail || null;
      return {
        ...ticket,
        requestType: requestTypeDisplay,
        reason: parseRefundReason(ticket.message),
        orderStatus: order?.status || 'UNKNOWN',
        orderDisplayId: order ? `#${order.displayId}` : null,
        orderTotalAmount: order?.totalAmount || 0,
        isGuest: !ticket.userId,
        customerName,
        customerEmail,
        // requestedItems: only what the customer selected (null = full order / no selection)
        requestedItems,
        // orderItems: all items in the order (for admin context)
        orderItems: allOrderItems
      };
    });

    // Map DB TicketStatus → refund-specific display status used across all endpoints
    // DB:  OPEN         → Open
    // DB:  IN_PROGRESS  → Approved
    // DB:  RESOLVED     → Completed
    // DB:  CLOSED       → Rejected
    const toRefundStatus = (dbStatus) => ({
      OPEN:        'OPEN',
      IN_PROGRESS: 'APPROVED',
      RESOLVED:    'COMPLETED',
      CLOSED:      'REJECTED'
    }[dbStatus] || dbStatus);

    const formattedWithStatus = formattedTickets.map(t => ({
      ...t,
      status: toRefundStatus(t.status)
    }));

    return reply.status(200).send({
      success: true,
      data: formattedWithStatus,
      pagination: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching refund requests:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// ── Refund status display ← DB enum mapping ──────────────────────────────────
// DB OPEN → OPEN | DB IN_PROGRESS → APPROVED | DB RESOLVED → COMPLETED | DB CLOSED → REJECTED
const REFUND_DB_TO_DISPLAY = { OPEN: 'OPEN', IN_PROGRESS: 'APPROVED', RESOLVED: 'COMPLETED', CLOSED: 'REJECTED' };
const REFUND_DISPLAY_TO_DB = { OPEN: 'OPEN', APPROVED: 'IN_PROGRESS', COMPLETED: 'RESOLVED', REJECTED: 'CLOSED' };
const REFUND_TRANSITIONS   = { OPEN: ['APPROVED', 'REJECTED'], APPROVED: ['COMPLETED'], REJECTED: [], COMPLETED: [] };

// ADMIN — UPDATE REFUND REQUEST STATUS
// Body: { status: 'APPROVED' | 'REJECTED' | 'COMPLETED', message?: string }
// APPROVED  → refund is confirmed, processing; notifies customer + sellers
// REJECTED  → refund denied;                   notifies customer + sellers
// COMPLETED → payment was issued; cancels CommissionEarned so sellers/admin revenue reflects the refund
exports.updateRefundRequestStatus = async (request, reply) => {
  try {
    const { id } = request.params;
    const { status, message } = request.body || {};

    if (!status || !REFUND_DISPLAY_TO_DB[status]) {
      return reply.status(400).send({
        success: false,
        message: `Invalid status. Use: APPROVED, REJECTED, or COMPLETED`
      });
    }

    const ticket = await prisma.supportTicket.findFirst({
      where: { id, category: 'REFUND_REQUEST' }
    });
    if (!ticket) return reply.status(404).send({ success: false, message: 'Refund request not found' });

    const currentDisplay = REFUND_DB_TO_DISPLAY[ticket.status] || 'OPEN';
    const allowed = REFUND_TRANSITIONS[currentDisplay] || [];
    if (!allowed.includes(status)) {
      return reply.status(400).send({
        success: false,
        message: `Cannot move from ${currentDisplay} to ${status}. Allowed: ${allowed.join(', ') || 'none'}`
      });
    }

    // ── Fetch order + involved sellers early (needed for Stripe refund + emails) ──
    let order = null;
    let sellerIds = [];
    if (ticket.orderId) {
      order = await prisma.order.findUnique({
        where: { id: ticket.orderId },
        include: {
          user:      { select: { id: true, name: true, email: true, isDeleted: true } },
          items:     { include: { product: { select: { id: true, sellerId: true } } } },
          subOrders: {
            include: {
              items: { include: { product: { select: { id: true, sellerId: true } } } }
            }
          }
        }
      });
      if (order) {
        sellerIds = [...new Set([
          ...order.subOrders.map(s => s.sellerId),
          ...(order.subOrders.flatMap(s => s.items || []).map(i => i.product?.sellerId)),
          ...order.items.map(i => i.product?.sellerId)
        ].filter(Boolean))];
      }
    }

    // ── Parse ticket items early (needed for partial refund amount calculation) ──
    let ticketRequestedItems = null;
    try {
      const itemMatch = (ticket.message || '').match(/---ITEMS_JSON---\n([\s\S]+)/);
      if (itemMatch) {
        const parsed = JSON.parse(itemMatch[1].trim());
        if (Array.isArray(parsed) && parsed.length > 0) ticketRequestedItems = parsed;
      }
    } catch { /* ignore */ }

    // ── Stripe Refund on APPROVED ─────────────────────────────────────────────
    // Stripe is called BEFORE the ticket DB update so the ticket status stays
    // unchanged if Stripe fails (admin can retry).
    // The charge.refunded webhook automatically reverses any seller transfers.
    let stripeRefundId = null;
    if (status === 'APPROVED' && order?.stripePaymentIntentId) {
      try {
        const refundParams = {
          payment_intent: order.stripePaymentIntentId,
          reason:         'requested_by_customer',
          metadata: {
            orderId:   order.id,
            ticketId:  ticket.id,
            adminNote: message?.trim() || '',
          },
        };
        // Partial refund — calculate amount only from the specific requested items
        if (ticket.requestType !== 'REFUND' && ticketRequestedItems?.length) {
          const partialAmount = ticketRequestedItems.reduce(
            (sum, item) => sum + parseFloat(item.price || 0) * (item.quantity || 1), 0
          );
          const amountCents = Math.round(partialAmount * 100);
          if (amountCents > 0) refundParams.amount = amountCents;
        }
        const stripeRefund = await stripe.refunds.create(refundParams);
        stripeRefundId = stripeRefund.id;
        console.log(`💳 Stripe refund created: ${stripeRefundId} for order ${order?.displayId}`);
      } catch (stripeErr) {
        console.error('Stripe refund failed:', stripeErr.message);
        return reply.status(502).send({
          success: false,
          message: `Stripe refund failed: ${stripeErr.message}. Refund request status unchanged — please retry.`,
        });
      }
    }

    // Update the ticket status (only reaches here if Stripe call succeeded or was not needed)
    const updatedTicket = await prisma.supportTicket.update({
      where: { id },
      data: {
        status:        REFUND_DISPLAY_TO_DB[status],
        response:      message?.trim() || ticket.response || null,
        stripeRefundId: stripeRefundId || undefined,
      }
    });

    // On APPROVED or COMPLETED: cancel CommissionEarned for this order.
    // Seller transfer reversal is handled automatically by the charge.refunded webhook.
    if (['APPROVED', 'COMPLETED'].includes(status) && ticket.orderId) {
      await prisma.commissionEarned.updateMany({
        where: { orderId: ticket.orderId, status: { not: 'CANCELLED' } },
        data:  { status: 'CANCELLED' }
      });
    }

    const displayId     = order ? `#${order.displayId}` : `#${id.slice(-6).toUpperCase()}`;
    const statusLabel   = { APPROVED: 'Approved', REJECTED: 'Rejected', COMPLETED: 'Completed' }[status];
    const customerName  = (order?.user?.isDeleted ? 'Deleted User' : order?.user?.name) || order?.customerName || 'Customer';
    const customerEmail = order?.user?.email || ticket.guestEmail;
    const customerId    = ticket.userId;

    // ── In-app notifications ──────────────────────────────────────────────────
    const notifMeta = { ticketId: id, status, orderDisplayId: displayId };
    const notifRows = [];

    if (customerId) {
      notifRows.push({
        userId:      customerId,
        title:       `Refund Request ${statusLabel}`,
        message:     message?.trim() || `Your refund request for order ${displayId} has been ${statusLabel.toLowerCase()}.`,
        type:        'GENERAL',
        relatedId:   ticket.orderId || id,
        relatedType: 'order',
        metadata:    notifMeta
      });
    }

    for (const sid of sellerIds) {
      notifRows.push({
        userId:      sid,
        title:       `Refund Request ${statusLabel}`,
        message:     message?.trim() || `A refund request for order ${displayId} has been ${statusLabel.toLowerCase()} by admin.`,
        type:        'GENERAL',
        relatedId:   ticket.orderId || id,
        relatedType: 'order',
        metadata:    notifMeta
      });
    }

    if (notifRows.length) await prisma.notification.createMany({ data: notifRows });

    // ── Emails (non-blocking) ─────────────────────────────────────────────────
    // ticketRequestedItems already parsed above (before Stripe call)
    const refundEmailPayload = {
      displayId:      order?.displayId,
      status,
      adminMessage:   message?.trim() || null,
      requestType:    ticket.requestType,
      totalAmount:    order?.totalAmount,
      requestedItems: ticketRequestedItems,
      customerName,
      isGuest:        !ticket.userId
    };

    if (customerEmail) {
      sendRefundStatusUpdateEmail(customerEmail, customerName, refundEmailPayload)
        .catch(err => console.error('Refund status customer email error (non-blocking):', err.message));
    }

    if (sellerIds.length && order) {
      prisma.user.findMany({ where: { id: { in: sellerIds } }, select: { id: true, name: true, email: true } })
        .then(sellers => {
          for (const seller of sellers) {
            if (!seller.email) continue;
            // Filter to only this seller's products
            const sellerProductIds = new Set(
              [...(order.items || []), ...(order.subOrders || []).flatMap(s => s.items || [])]
                .filter(i => i.product?.sellerId === seller.id)
                .map(i => i.product?.id)
                .filter(Boolean)
            );
            const sellerItems = ticketRequestedItems
              ? ticketRequestedItems.filter(ri => sellerProductIds.has(ri.productId))
              : null;
            sendSellerRefundStatusEmail(seller.email, seller.name, {
              ...refundEmailPayload,
              requestedItems: sellerItems
            }).catch(err => console.error('Refund status seller email error (non-blocking):', err.message));
          }
        }).catch(() => {});
    }

    return reply.status(200).send({
      success: true,
      message: `Refund request ${statusLabel.toLowerCase()} successfully`,
      request: {
        id:                   updatedTicket.id,
        status,
        adminMessage:         updatedTicket.response,
        stripeRefundProcessed: !!(stripeRefundId || updatedTicket.stripeRefundId),
        stripeRefundId:        stripeRefundId || updatedTicket.stripeRefundId || null,
        stripeNote: status === 'APPROVED'
          ? (stripeRefundId
              ? 'Stripe refund initiated — money is on its way to the customer.'
              : (order?.stripePaymentIntentId
                  ? 'Stripe refund was triggered.'
                  : 'No Stripe payment found for this order — process refund manually outside the platform.'))
          : (updatedTicket.stripeRefundId
              ? `Stripe refund ${updatedTicket.stripeRefundId} was previously processed.`
              : undefined),
      }
    });
  } catch (error) {
    console.error('Update refund status error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// ── SITE SETTINGS ────────────────────────────────────────────────────────────

// ADMIN - GET site settings
exports.getSiteSettings = async (request, reply) => {
  try {
    let settings = await prisma.siteSettings.findUnique({ where: { id: 'global' } });
    if (!settings) {
      settings = await prisma.siteSettings.create({
        data: { id: 'global', internationalShippingEnabled: true }
      });
    }
    return reply.status(200).send({ success: true, data: settings });
  } catch (error) {
    console.error('getSiteSettings error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// ADMIN - Toggle international shipping on/off
// PUT /api/admin/settings/international-shipping  body: { enabled: true|false }
exports.toggleInternationalShipping = async (request, reply) => {
  try {
    const { enabled } = request.body || {};
    if (typeof enabled !== 'boolean') {
      return reply.status(400).send({ success: false, message: '`enabled` (boolean) is required' });
    }
    const settings = await prisma.siteSettings.upsert({
      where: { id: 'global' },
      update: { internationalShippingEnabled: enabled },
      create: { id: 'global', internationalShippingEnabled: enabled }
    });
    return reply.status(200).send({
      success: true,
      message: `International shipping ${enabled ? 'enabled' : 'disabled'} successfully`,
      data: settings
    });
  } catch (error) {
    console.error('toggleInternationalShipping error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};






