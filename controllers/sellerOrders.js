const prisma = require("../config/prisma");
const { sendOrderStatusEmail, sendSellerOrderStatusEmail, sendAdminOrderStatusEmail } = require("../utils/emailService");
const { notifyCustomerOrderStatusChange, notifyAdminOrderStatusChange, notifySellerOrderStatusChange } = require("./notification");
const {
  normalizeOrderStatus,
  validateStatusTransition,
  VALID_TARGET_STATUSES,
  ORDER_STATUS_SEQUENCE,
  TERMINAL_STATUSES
} = require("../utils/orderStatusRules");
const { calculateSellerPayout } = require("../utils/commissionCalculator");

const { 
  generateSalesReportCSV,
  generateSalesSummaryCSV 
} = require("../utils/csvExport");

// ── PII masking for deleted users ────────────────────────────────────────────
const maskDeletedUser = (user) => {
  if (!user) return null;
  if (!user.isDeleted) return user;
  return { ...user, name: 'Deleted User', email: null, phone: null };
};

// ── Order display-ID helpers ─────────────────────────────────────────────────
// Accepts stored displayId Int (e.g. 1001) OR falls back to last-6-chars of CUID.
const toDisplayId = (idOrN) => {
  if (typeof idOrN === 'number') return `#${idOrN}`;
  return `#${(idOrN || '').replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()}`;
};
// Sub-order suffix: A, B … Z, AA … (Excel-column style, 0-based index)
const toSubDisplayId = (parentIdOrN, idx) => {
  let suffix = '', n = idx;
  do { suffix = String.fromCharCode(65 + (n % 26)) + suffix; n = Math.floor(n / 26) - 1; } while (n >= 0);
  if (typeof parentIdOrN === 'number') return `#${parentIdOrN}-${suffix}`;
  return `#${(parentIdOrN || '').replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()}-${suffix}`;
};

// Trim item objects — keep only fields the frontend needs
const trimItems = (items = []) =>
  items.map(item => ({
    id:        item.id,
    productId: item.productId,
    variantId: item.variantId || null,
    quantity:  item.quantity,
    price:     item.price,
    product:   item.product ? {
      id:     item.product.id,
      title:  item.product.title,
      featuredImage: item.product.featuredImage,
      price:  item.product.price
    } : null,
    variantAttributes: item.productVariant
      ? Object.fromEntries(
          (item.productVariant.variantAttributeValues || []).map(vav => [
            vav.attributeValue?.attribute?.displayName || vav.attributeValue?.attribute?.name,
            vav.attributeValue?.displayValue || vav.attributeValue?.value
          ])
        )
      : null
  }));

// Helper function to map database status to display status
const mapStatusForDisplay = (dbStatus) => {
  // Handle undefined/null values
  if (!dbStatus) return 'pending';
  
  // Ensure dbStatus is a string
  if (typeof dbStatus !== 'string') return 'pending';
  
  const displayMap = {
    'PENDING': 'pending',
    'CONFIRMED': 'confirmed',
    'PROCESSING': 'processing',  // New status
    'SHIPPED': 'shipped',
    'DELIVERED': 'delivered',
    'CANCELLED': 'cancelled',
    'REFUND': 'refund',
    'PARTIAL_REFUND': 'partial_refund'
  };
  return displayMap[dbStatus] || dbStatus.toLowerCase();
};

// ─── Financial Summary Builder ────────────────────────────────────────────────
// Builds a unified financial breakdown for one seller's slice of an order.
// Works for both DIRECT orders and SUB-ORDERS (multi-seller).
//
// Sources (in priority order):
//   1. commissionRecord  — actual recorded CommissionEarned row (most accurate)
//   2. storedOrderSummary — JSON embedded in shippingAddress at order creation
//   3. items             — fallback: recompute from line items + defaults
//
// Australian rules: GST-inclusive pricing, commission on ex-GST only, seller keeps 100% shipping.
function round2(n) { return Math.round(n * 100) / 100; }

function buildFinancialSummary({ items = [], storedOrderSummary = null, commissionRecord = null, couponCode = null, couponDiscount = null, isSubOrder = false }) {
  // 1. Products subtotal (GST-inclusive) from line items
  const productsSubtotal = round2(items.reduce((sum, i) => sum + Number(i.price) * Number(i.quantity), 0));

  // 2. GST rate — prefer stored, default 10 % (Australia)
  const gstPercentage = storedOrderSummary?.gstPercentage ? parseFloat(storedOrderSummary.gstPercentage) : 10;
  const gstDivisor = 1 + gstPercentage / 100;

  // 3. Ex-GST product value
  const productsSubtotalExGST = round2(productsSubtotal / gstDivisor);
  const gstAmount = round2(productsSubtotal - productsSubtotalExGST);

  // 4. Shipping — prefer commission record (actual per-seller allocation), fall back to stored summary
  const shippingCost = commissionRecord?.shippingAmount != null
    ? round2(parseFloat(commissionRecord.shippingAmount))
    : storedOrderSummary?.shippingCost ? round2(parseFloat(storedOrderSummary.shippingCost)) : 0;

  // 5. Commission — use recorded values if available, otherwise recompute
  let platformCommissionRate, platformCommission, sellerProductEarning, sellerPayout;

  if (commissionRecord) {
    platformCommissionRate = parseFloat(commissionRecord.commissionRate);
    platformCommission     = round2(parseFloat(commissionRecord.commissionAmount));
    sellerProductEarning   = round2(parseFloat(commissionRecord.productValueExGST || productsSubtotalExGST) - platformCommission);
    sellerPayout           = round2(parseFloat(commissionRecord.netPayable));
  } else {
    const computed = calculateSellerPayout(productsSubtotal, shippingCost, 10);
    platformCommissionRate = computed.commissionRatePct;
    platformCommission     = computed.commissionAmount;
    sellerProductEarning   = computed.sellerProductEarning;
    sellerPayout           = computed.sellerTotalPayout;
  }

  // 6. Customer total for this seller's slice (products + shipping — coupon applied at parent level for sub-orders)
  const customerTotal = round2(productsSubtotal + shippingCost - (isSubOrder ? 0 : (couponDiscount ? parseFloat(couponDiscount) : 0)));

  return {
    // ── Customer perspective ──────────────────────────────────────────────────
    productsSubtotal,
    productsSubtotalExGST,
    gstAmount,
    gstPercentage,
    shippingCost,
    // Coupon: on DIRECT orders show the actual discount; on sub-orders show parent coupon for context only
    ...(isSubOrder
      ? { parentCouponCode: couponCode || null, parentCouponDiscount: couponDiscount ? round2(parseFloat(couponDiscount)) : null }
      : { couponCode: couponCode || null, couponDiscount: couponDiscount ? round2(parseFloat(couponDiscount)) : null }
    ),
    customerTotal,
    // ── Seller / platform perspective ─────────────────────────────────────────
    platformCommissionRate,
    platformCommission,
    sellerProductEarning,
    sellerPayout,
  };
}
// ─────────────────────────────────────────────────────────────────────────────

const normalizeTrackingNumber = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const ensureUniqueTrackingNumber = async ({ trackingNumber, excludeOrderId = null, excludeSubOrderId = null }) => {
  const normalized = normalizeTrackingNumber(trackingNumber);
  if (!normalized) return;

  const [orderConflict, subOrderConflict] = await Promise.all([
    prisma.order.findFirst({
      where: {
        trackingNumber: { equals: normalized, mode: 'insensitive' },
        ...(excludeOrderId ? { id: { not: excludeOrderId } } : {})
      },
      select: { id: true, displayId: true }
    }),
    prisma.subOrder.findFirst({
      where: {
        trackingNumber: { equals: normalized, mode: 'insensitive' },
        ...(excludeSubOrderId ? { id: { not: excludeSubOrderId } } : {})
      },
      select: { id: true, subDisplayId: true, parentOrderId: true }
    })
  ]);

  if (!orderConflict && !subOrderConflict) return;

  const conflictLabel = orderConflict
    ? `order ${orderConflict.displayId || orderConflict.id}`
    : `sub-order ${subOrderConflict.subDisplayId || subOrderConflict.id}`;

  const err = new Error(`Tracking number \"${normalized}\" is already used by ${conflictLabel}. Please enter a different tracking number.`);
  err.code = 'TRACKING_NUMBER_CONFLICT';
  throw err;
};


// SELLER — VIEW ORDERS
exports.getSellerOrders = async (request, reply) => {
  try {
    const sellerId = request.user.userId; // From authenticateSeller middleware
    
    // Get both direct orders (single seller) and sub-orders (multi seller) for this seller
    const [directOrders, subOrders, oldOrders] = await Promise.all([
      // Direct orders (single seller orders)
      prisma.order.findMany({
        where: {
          sellerId: sellerId
        },
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
          },
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              isDeleted: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),

      // Sub-orders (multi-seller orders)
      prisma.subOrder.findMany({
        where: {
          sellerId: sellerId
        },
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
          },
          parentOrder: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  phone: true,
                  isDeleted: true
                }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),

      // Old orders (sellerId=null) - treat as DIRECT if only this seller's products
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
              isDeleted: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      })
    ]);

    // Filter old orders to only include this seller's items and determine if DIRECT
    const processedOldOrders = oldOrders
      .map(order => {
        // Get only this seller's items
        const sellerItems = order.items.filter(item => item.product?.sellerId === sellerId);
        
        // Check if this order involves only this seller
        const uniqueSellerIds = new Set(order.items.map(item => item.product?.sellerId).filter(Boolean));
        const isDirectOrder = uniqueSellerIds.size === 1 && uniqueSellerIds.has(sellerId);
        
        if (sellerItems.length === 0) return null; // No items for this seller
        
        return {
          ...order,
          items: sellerItems,
          isDirectOrder
        };
      })
      .filter(Boolean);


    // Combine direct orders with old direct orders
    const allDirectOrders = [...directOrders, ...processedOldOrders.filter(o => o.isDirectOrder)];
    // Legacy multi-seller old orders (show only this seller's items, like a sub-order)
    const legacyMultiSellerOrders = processedOldOrders.filter(o => !o.isDirectOrder);

    // ── Batch-fetch commission_earned records (one query for all orders) ──────
    const directOrderIds = allDirectOrders.map(o => o.id);
    const subOrderIds    = subOrders.map(s => s.id);
    const commissionRecords = (directOrderIds.length + subOrderIds.length) > 0
      ? await prisma.commissionEarned.findMany({
          where: {
            sellerId,
            OR: [
              ...(directOrderIds.length ? [{ orderId: { in: directOrderIds }, subOrderId: null }] : []),
              ...(subOrderIds.length    ? [{ subOrderId: { in: subOrderIds } }]                  : [])
            ]
          },
          select: {
            orderId: true, subOrderId: true,
            commissionRate: true, commissionAmount: true,
            netPayable: true, productValueExGST: true,
            gstAmount: true, shippingAmount: true
          }
        })
      : [];

    const commissionByOrderId    = {};
    const commissionBySubOrderId = {};
    commissionRecords.forEach(c => {
      if (c.subOrderId) commissionBySubOrderId[c.subOrderId] = c;
      else if (c.orderId) commissionByOrderId[c.orderId] = c;
    });
    // ─────────────────────────────────────────────────────────────────────────

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

    // Transform direct orders to unified format
    const transformedDirectOrders = allDirectOrders.map(order => {
      const storedSummary = order.shippingAddress?.orderSummary || null;
      const items = order.items || [];
      return {
        id:        order.id,
        displayId: toDisplayId(order.displayId),
        parentOrderId: null,
        type: 'DIRECT',
        status: mapStatusForDisplay(order.status || order.overallStatus),
        trackingNumber: order.trackingNumber,
        estimatedDelivery: order.estimatedDelivery,
        subtotal: order.totalAmount,
        originalTotal: order.originalTotal || order.totalAmount,
        couponCode: order.couponCode || null,
        discountAmount: order.discountAmount ? round2(parseFloat(order.discountAmount)) : null,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        items: trimItems(items),
        user: maskDeletedUser(order.user),
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        shippingAddress: order.shippingAddress,
        shippingAddressLine: order.shippingAddressLine,
        shippingCity: order.shippingCity,
        shippingState: order.shippingState,
        shippingZipCode: order.shippingZipCode,
        shippingCountry: order.shippingCountry,
        shippingPhone: order.shippingPhone,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        financialSummary: buildFinancialSummary({
          items,
          storedOrderSummary: storedSummary,
          commissionRecord: commissionByOrderId[order.id] || null,
          couponCode: order.couponCode || null,
          couponDiscount: order.discountAmount || null,
          isSubOrder: false
        })
      };
    });

    // Transform sub-orders to unified format (backward compatibility)
    const transformedSubOrders = subOrders.map(subOrder => {
      const siblings = globalSubsByParent[subOrder.parentOrderId] || [];
      const idx      = siblings.indexOf(subOrder.id);
      const parent   = subOrder.parentOrder;
      const storedSummary = parent?.shippingAddress?.orderSummary || null;
      const items = subOrder.items || [];
      return ({
        id:              subOrder.id,
        displaySubId:    toSubDisplayId(parent?.displayId ?? subOrder.parentOrderId, idx),
        parentOrderId:   subOrder.parentOrderId,
        parentDisplayId: toDisplayId(parent?.displayId ?? subOrder.parentOrderId),
        type: 'SUB_ORDER',
        status: mapStatusForDisplay(subOrder.status),
        trackingNumber: subOrder.trackingNumber,
        estimatedDelivery: subOrder.estimatedDelivery,
        subtotal: subOrder.subtotal,
        paymentMethod: parent?.paymentMethod,
        paymentStatus: parent?.paymentStatus,
        items: trimItems(items),
        user: maskDeletedUser(parent?.user),
        customerName: parent?.customerName,
        customerEmail: parent?.customerEmail,
        customerPhone: parent?.customerPhone,
        shippingAddress: parent?.shippingAddress,
        shippingAddressLine: parent?.shippingAddressLine,
        shippingCity: parent?.shippingCity,
        shippingState: parent?.shippingState,
        shippingZipCode: parent?.shippingZipCode,
        shippingCountry: parent?.shippingCountry,
        shippingPhone: parent?.shippingPhone,
        createdAt: subOrder.createdAt,
        updatedAt: subOrder.updatedAt,
        financialSummary: buildFinancialSummary({
          items,
          storedOrderSummary: storedSummary,
          commissionRecord: commissionBySubOrderId[subOrder.id] || null,
          couponCode: parent?.couponCode || null,
          couponDiscount: parent?.discountAmount || null,
          isSubOrder: true
        })
      });
    });

    // Transform legacy multi-seller old orders (show only this seller's items, like a sub-order)
    const transformedLegacyOrders = legacyMultiSellerOrders.map((order, idx) => {
      const storedSummary = order.shippingAddress?.orderSummary || null;
      const items = order.items || [];
      return {
        id:              order.id,
        displaySubId:    toSubDisplayId(order.displayId, idx),
        parentOrderId:   order.id,
        parentDisplayId: toDisplayId(order.displayId),
        type: 'SUB_ORDER',
        status: mapStatusForDisplay(order.status || order.overallStatus),
        trackingNumber: order.trackingNumber,
        estimatedDelivery: order.estimatedDelivery,
        subtotal: items.reduce((sum, i) => sum + Number(i.price) * Number(i.quantity), 0),
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        items: trimItems(items),
        user: maskDeletedUser(order.user),
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        shippingAddress: order.shippingAddress,
        shippingAddressLine: order.shippingAddressLine,
        shippingCity: order.shippingCity,
        shippingState: order.shippingState,
        shippingZipCode: order.shippingZipCode,
        shippingCountry: order.shippingCountry,
        shippingPhone: order.shippingPhone,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        financialSummary: buildFinancialSummary({
          items,
          storedOrderSummary: storedSummary,
          commissionRecord: commissionByOrderId[order.id] || null,
          couponCode: order.couponCode || null,
          couponDiscount: order.discountAmount || null,
          isSubOrder: true
        })
      };
    });

    // Combine and sort by creation date (newest first)
    const allOrders = [...transformedDirectOrders, ...transformedSubOrders, ...transformedLegacyOrders]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return reply.status(200).send({ 
      success: true, 
      orders: allOrders, 
      count: allOrders.length,
      breakdown: {
        directOrders: transformedDirectOrders.length,
        subOrders: transformedSubOrders.length + transformedLegacyOrders.length,
        total: allOrders.length
      }
    });
  } catch (error) {
    console.error("Get seller orders error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// SELLER/ADMIN — UPDATE ORDER STATUS (with SMS notification)
exports.updateOrderStatus = async (request, reply) => {
  try {
    const userId = request.user.userId; // From auth middleware
    const userRole = request.user.role; // From auth middleware
    const { orderId } = request.params; // This is now the subOrderId
    const {
      status,
      trackingNumber,
      estimatedDelivery,
      reason,
      statusReason
    } = request.body;

    const normalizedStatus = normalizeOrderStatus(status);
    
    if (!normalizedStatus) {
      return reply.status(400).send({
        success: false,
        message: `Invalid status. Allowed values: ${VALID_TARGET_STATUSES.join(', ')}`
      });
    }

    // Try to find the order - could be a direct order, sub-order, or legacy order
    let orderRecord = null;
    let isDirectOrder = false;
    let isSubOrder = false;
    let isLegacyOrder = false;
    
    // First try to find as a direct order (single seller)
    try {
      const directOrder = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          user: true,
          items: {
            include: {
              product: true
            }
          }
        }
      });
      
      if (directOrder && directOrder.sellerId) {
        // This is a direct order (single seller)
        orderRecord = {
          id: directOrder.id,
          sellerId: directOrder.sellerId,
          status: directOrder.status || directOrder.overallStatus,
          trackingNumber: directOrder.trackingNumber,
          estimatedDelivery: directOrder.estimatedDelivery,
          statusReason: directOrder.statusReason,
          subtotal: directOrder.totalAmount,
          items: directOrder.items,
          parentOrder: directOrder, // For unified structure
          customer: directOrder.user,
          customerName: directOrder.customerName,
          customerEmail: directOrder.customerEmail,
          createdAt: directOrder.createdAt,
          updatedAt: directOrder.updatedAt
        };
        isDirectOrder = true;
      } else if (directOrder && !directOrder.sellerId) {
        // This might be a legacy order, check if seller has items in it
        const sellerItems = directOrder.items.filter(item => item.product?.sellerId === userId);
        if (sellerItems.length > 0) {
          // This is a legacy order with seller's items
          const sellerSubtotal = sellerItems.reduce((sum, item) => {
            return sum + (parseFloat(item.price || 0) * item.quantity);
          }, 0);
          
          orderRecord = {
            id: directOrder.id,
            sellerId: userId, // Set seller ID for validation
            status: directOrder.status || directOrder.overallStatus,
            trackingNumber: directOrder.trackingNumber,
            estimatedDelivery: directOrder.estimatedDelivery,
            statusReason: directOrder.statusReason,
            subtotal: sellerSubtotal,
            items: sellerItems, // Only seller's items
            parentOrder: directOrder, // For unified structure
            customer: directOrder.user,
            customerName: directOrder.customerName,
            customerEmail: directOrder.customerEmail,
            createdAt: directOrder.createdAt,
            updatedAt: directOrder.updatedAt
          };
          isLegacyOrder = true;
        }
      }
    } catch (error) {
    }
    
    // If not a direct order, try to find as sub-order (multi-seller)
    if (!orderRecord) {
      try {
        const subOrderRecord = await prisma.subOrder.findUnique({
          where: { id: orderId },
          include: {
            parentOrder: {
              include: {
                user: true
              }
            },
            items: {
              include: {
                product: true
              }
            }
          }
        });
        
        if (subOrderRecord) {
          orderRecord = {
            id: subOrderRecord.id,
            sellerId: subOrderRecord.sellerId,
            status: subOrderRecord.status,
            trackingNumber: subOrderRecord.trackingNumber,
            estimatedDelivery: subOrderRecord.estimatedDelivery,
            statusReason: subOrderRecord.statusReason,
            subtotal: subOrderRecord.subtotal,
            items: subOrderRecord.items,
            parentOrder: subOrderRecord.parentOrder,
            customer: subOrderRecord.parentOrder.user,
            customerName: subOrderRecord.parentOrder.customerName,
            customerEmail: subOrderRecord.parentOrder.customerEmail,
            createdAt: subOrderRecord.createdAt,
            updatedAt: subOrderRecord.updatedAt
          };
          isSubOrder = true;
        }
      } catch (error) {
      }
    }
    
    // If order not found
    if (!orderRecord) {
      return reply.status(404).send({ success: false, message: "Order not found" });
    }

    // Permission check: Only the seller who owns this order or admin can update
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(userRole);
    if (!isAdmin && orderRecord.sellerId !== userId) {
      return reply.status(403).send({
        success: false,
        message: "You can only update your own orders"
      });
    }

    // Validate status transition
    const transitionCheck = validateStatusTransition({
      currentStatus: orderRecord.status,
      nextStatus: normalizedStatus,
      trackingNumber,
      estimatedDelivery,
      reason: reason || statusReason
    });
    if (!transitionCheck.isValid) {
      return reply.status(400).send({
        success: false,
        message: transitionCheck.message
      });
    }

    const normalizedTrackingNumber = normalizeTrackingNumber(trackingNumber);
    if (normalizedTrackingNumber) {
      await ensureUniqueTrackingNumber({
        trackingNumber: normalizedTrackingNumber,
        excludeOrderId: (isDirectOrder || isLegacyOrder) ? orderId : null,
        excludeSubOrderId: isSubOrder ? orderId : null
      });
    }

    // Prepare update data (only fields that exist on both Order and SubOrder)
    const updateData = {
      status: normalizedStatus,
      updatedAt: new Date()
    };

    if (trackingNumber !== undefined) updateData.trackingNumber = normalizedTrackingNumber;
    if (estimatedDelivery !== undefined) updateData.estimatedDelivery = estimatedDelivery ? new Date(estimatedDelivery) : null;
    if (statusReason !== undefined) updateData.statusReason = statusReason;

    // Update the appropriate record
    let updatedOrder;
    if (isDirectOrder) {
      // Update direct order
      updatedOrder = await prisma.order.update({
        where: { id: orderId },
        data: { ...updateData, overallStatus: normalizedStatus },
        include: {
          user: true,
          items: {
            include: {
              product: true
            }
          }
        }
      });
      
      // Update structure for unified response
      orderRecord = {
        ...orderRecord,
        status: updatedOrder.status,
        trackingNumber: updatedOrder.trackingNumber,
        estimatedDelivery: updatedOrder.estimatedDelivery,
        statusReason: updatedOrder.statusReason,
        updatedAt: updatedOrder.updatedAt
      };
    } else if (isLegacyOrder) {
      // Update legacy order (update the main order's status and tracking)
      updatedOrder = await prisma.order.update({
        where: { id: orderId },
        data: {
          status: normalizedStatus,
          overallStatus: normalizedStatus,
          trackingNumber: updateData.trackingNumber,
          estimatedDelivery: updateData.estimatedDelivery,
          statusReason: updateData.statusReason,
          updatedAt: updateData.updatedAt
        },
        include: {
          user: true,
          items: {
            where: {
              product: {
                sellerId: userId // Only seller's items
              }
            },
            include: {
              product: true
            }
          }
        }
      });
      
      // Update structure for unified response
      orderRecord = {
        ...orderRecord,
        status: updatedOrder.status || updatedOrder.overallStatus,
        trackingNumber: updatedOrder.trackingNumber,
        estimatedDelivery: updatedOrder.estimatedDelivery,
        statusReason: updatedOrder.statusReason,
        updatedAt: updatedOrder.updatedAt
      };
    } else {
      // Update sub-order
      updatedOrder = await prisma.subOrder.update({
        where: { id: orderId },
        data: updateData,
        include: {
          parentOrder: {
            include: {
              user: true
            }
          },
          items: {
            include: {
              product: true
            }
          }
        }
      });
      
      // Update structure for unified response
      orderRecord = {
        ...orderRecord,
        status: updatedOrder.status,
        trackingNumber: updatedOrder.trackingNumber,
        estimatedDelivery: updatedOrder.estimatedDelivery,
        statusReason: updatedOrder.statusReason,
        updatedAt: updatedOrder.updatedAt
      };

      // ── Aggregate parent order status from all sibling sub-orders ────────
      // Rule: parent advances only when ALL sub-orders have reached that status.
      // Fetch the parent's CURRENT status fresh from DB (the include data can be stale,
      // and for MULTI_SELLER orders `status` is nullable while `overallStatus` is not).
      const [parentRecord, allSiblings] = await Promise.all([
        prisma.order.findUnique({
          where: { id: updatedOrder.parentOrder.id },
          select: { status: true, overallStatus: true }
        }),
        prisma.subOrder.findMany({
          where: { parentOrderId: updatedOrder.parentOrder.id },
          select: { status: true }
        })
      ]);

      // Resolve actual current parent status (prefer status over overallStatus)
      const currentParentStatus = parentRecord?.status || parentRecord?.overallStatus || 'CONFIRMED';

      const siblingStatuses = allSiblings.map(s => s.status);
      let newParentStatus = currentParentStatus; // default: no change

      const allTerminal = siblingStatuses.every(s => TERMINAL_STATUSES.includes(s));
      if (allTerminal) {
        newParentStatus = siblingStatuses.every(s => s === 'CANCELLED') ? 'CANCELLED' : 'PARTIAL_REFUND';
      } else {
        const activeStatuses = siblingStatuses.filter(s => !TERMINAL_STATUSES.includes(s));
        if (activeStatuses.length > 0) {
          const minIndex = Math.min(...activeStatuses.map(s => {
            const idx = ORDER_STATUS_SEQUENCE.indexOf(s);
            return idx === -1 ? Infinity : idx;
          }));
          if (minIndex !== Infinity) {
            newParentStatus = ORDER_STATUS_SEQUENCE[minIndex];
          }
        }
      }

      if (newParentStatus !== currentParentStatus) {
        await prisma.order.update({
          where: { id: updatedOrder.parentOrder.id },
          data: { status: newParentStatus, overallStatus: newParentStatus, updatedAt: new Date() }
        });
      }
      // ── End aggregation ───────────────────────────────────────────────────
    }

    // Send notifications and emails for the order status update
    const customer = orderRecord.customer;
    const customerEmail = customer?.email || orderRecord.customerEmail;
    const customerName = (customer?.isDeleted ? 'Deleted User' : customer?.name) || orderRecord.customerName || 'Customer';
    
    if (customerEmail) {
      
      sendOrderStatusEmail(customerEmail, customerName, {
        displayId: orderRecord.parentOrder?.displayId || orderRecord.id,
        status: normalizedStatus.toLowerCase(),
        reason: statusReason || undefined,
        trackingNumber: orderRecord.trackingNumber,
        estimatedDelivery: orderRecord.estimatedDelivery,
        totalAmount: orderRecord.subtotal,
        paymentMethod: orderRecord.parentOrder.paymentMethod,
        orderDate: orderRecord.createdAt,
        shippingName: orderRecord.customerName,
        shippingAddress: orderRecord.parentOrder.shippingAddressLine,
        shippingCity: orderRecord.parentOrder.shippingCity,
        shippingState: orderRecord.parentOrder.shippingState,
        shippingZipCode: orderRecord.parentOrder.shippingZipCode,
        shippingCountry: orderRecord.parentOrder.shippingCountry,
        shippingPhone: orderRecord.parentOrder.shippingPhone,
        isGuest: !orderRecord.parentOrder.userId,
        orderSummary: (orderRecord.parentOrder?.shippingAddress || {}).orderSummary || undefined,
        products: orderRecord.items.map(item => ({
          title: item.product?.title || 'Product',
          quantity: item.quantity,
          price: parseFloat(item.price)
        }))
      }).catch(error => {
        console.error("Email error (non-blocking):", error.message);
      });

      // Create in-app notification for customer (only for logged-in users)
      if (customer?.id) {
        notifyCustomerOrderStatusChange(customer.id, orderRecord.id, normalizedStatus.toLowerCase(), {
          totalAmount: orderRecord.subtotal.toString(),
          itemCount: orderRecord.items.length,
          reason: statusReason || undefined,
          trackingNumber: orderRecord.trackingNumber,
          estimatedDelivery: orderRecord.estimatedDelivery
        }).catch(error => {
          console.error("Customer notification error (non-blocking):", error.message);
        });
      }

      // Notify admins about the status change
      if (userRole === "SELLER") {
        const seller = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
        const adminDetails = {
          customerName,
          sellerName: seller?.name || 'Unknown',
          totalAmount: orderRecord.subtotal.toString(),
          itemCount: orderRecord.items.length,
          reason: statusReason || undefined,
          trackingNumber: orderRecord.trackingNumber,
          estimatedDelivery: orderRecord.estimatedDelivery
        };
        
        // Notify all admins
        notifyAdminOrderStatusChange(orderRecord.id, normalizedStatus.toLowerCase(), adminDetails)
          .catch(err => console.error("Admin notification error (non-blocking):", err.message));
        
        // Email super admins only
        const admins = await prisma.user.findMany({ 
          where: { role: 'SUPER_ADMIN' }, 
          select: { email: true, name: true } 
        });
        
        for (const admin of admins) {
          if (admin.email) {
            sendAdminOrderStatusEmail(admin.email, admin.name, {
              displayId: orderRecord.parentOrder?.displayId || orderRecord.id,
              status: normalizedStatus.toLowerCase(),
              sellerName: seller?.name || 'Unknown',
              updatedBy: 'Seller',
              customerName,
              totalAmount: orderRecord.subtotal,
              reason: statusReason || undefined,
              trackingNumber: orderRecord.trackingNumber
            }).catch(err => console.error("Admin order status email error (non-blocking):", err.message));
          }
        }
      }

      // When ADMIN updates → notify the seller
      if (isAdmin) {
        notifySellerOrderStatusChange(orderRecord.sellerId, orderRecord.id, normalizedStatus.toLowerCase(), {
          customerName,
          totalAmount: orderRecord.subtotal.toString(),
          reason: statusReason || undefined,
          trackingNumber: orderRecord.trackingNumber
        }).catch(err => console.error("Seller notification error (non-blocking):", err.message));
        
        // Email the seller
        const sellerUser = await prisma.user.findUnique({ 
          where: { id: orderRecord.sellerId }, 
          select: { email: true, name: true } 
        });
        
        if (sellerUser?.email) {
          sendSellerOrderStatusEmail(sellerUser.email, sellerUser.name || 'Seller', {
            displayId: orderRecord.parentOrder?.displayId || orderRecord.id,
            status: normalizedStatus.toLowerCase(),
            customerName,
            totalAmount: orderRecord.subtotal,
            reason: statusReason || undefined,
            trackingNumber: orderRecord.trackingNumber,
            estimatedDelivery: orderRecord.estimatedDelivery
          }).catch(err => console.error("Seller order status email error (non-blocking):", err.message));
        }
      }
    }

    return reply.status(200).send({
      success: true,
      message: "Order status updated successfully. Customer notified via email.",
      updatedStatus: normalizedStatus,
      order: {
        id: orderRecord.id,
        type: isDirectOrder ? 'DIRECT' : (isLegacyOrder ? 'LEGACY' : 'SUB_ORDER'),
        status: mapStatusForDisplay(orderRecord.status),
        trackingNumber: orderRecord.trackingNumber,
        estimatedDelivery: orderRecord.estimatedDelivery,
        statusReason: orderRecord.statusReason,
        parentOrderId: isSubOrder ? orderRecord.parentOrder.id : null
      }
    });
  } catch (error) {
    if (error.code === 'TRACKING_NUMBER_CONFLICT') {
      return reply.status(409).send({ success: false, message: error.message });
    }
    console.error("Update order status error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// SELLER/ADMIN — UPDATE TRACKING INFO (with SMS notification)
exports.updateTrackingInfo = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const userRole = request.user.role;
    const { orderId } = request.params;
    const { trackingNumber, estimatedDelivery } = request.body;

    // ── Try direct order first ────────────────────────────────────────────
    let order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: true } }, user: true }
    });

    let isSubOrder = false;
    let subOrderRecord = null;

    // ── Fall back to sub-order lookup ─────────────────────────────────────
    if (!order) {
      subOrderRecord = await prisma.subOrder.findUnique({
        where: { id: orderId },
        include: {
          parentOrder: { include: { user: true } },
          items: { include: { product: true } }
        }
      });

      if (!subOrderRecord) {
        return reply.status(404).send({ success: false, message: "Order not found" });
      }

      isSubOrder = true;

      // Build a unified shape so the rest of the function works the same way
      order = {
        id: subOrderRecord.id,
        sellerId: subOrderRecord.sellerId,
        displayId: subOrderRecord.parentOrder.displayId,
        status: subOrderRecord.status,
        trackingNumber: subOrderRecord.trackingNumber,
        estimatedDelivery: subOrderRecord.estimatedDelivery,
        subtotal: subOrderRecord.subtotal,
        totalAmount: subOrderRecord.subtotal,
        items: subOrderRecord.items,
        user: subOrderRecord.parentOrder.user,
        customerName: subOrderRecord.parentOrder.customerName,
        customerEmail: subOrderRecord.parentOrder.customerEmail,
        paymentMethod: subOrderRecord.parentOrder.paymentMethod,
        shippingAddressLine: subOrderRecord.parentOrder.shippingAddressLine,
        shippingCity: subOrderRecord.parentOrder.shippingCity,
        shippingState: subOrderRecord.parentOrder.shippingState,
        shippingZipCode: subOrderRecord.parentOrder.shippingZipCode,
        shippingCountry: subOrderRecord.parentOrder.shippingCountry,
        shippingPhone: subOrderRecord.parentOrder.shippingPhone,
        shippingAddress: subOrderRecord.parentOrder.shippingAddress,
        userId: subOrderRecord.parentOrder.userId,
        createdAt: subOrderRecord.createdAt,
        parentOrderId: subOrderRecord.parentOrderId
      };
    }

    // ── Authorization ─────────────────────────────────────────────────────
    // Allow both ADMIN and SUPER_ADMIN full access
    const isAdminUser = userRole === "ADMIN" || userRole === "SUPER_ADMIN";
    
    if (!isAdminUser) {
      if (isSubOrder) {
        if (order.sellerId !== userId) {
          return reply.status(403).send({ success: false, message: "Unauthorized - this order doesn't belong to you" });
        }
      } else {
        const containsSellerItem = order.items.some((item) => item.product.sellerId === userId);
        if (!containsSellerItem) {
          return reply.status(403).send({ success: false, message: "Unauthorized - this order doesn't contain your products" });
        }
      }

      // Check if seller is inactive (only for sellers, not admin)
      const seller = await prisma.sellerProfile.findUnique({
        where: { userId }
      });
      
      if (!seller?.isActive) {
        return reply.status(403).send({
          success: false,
          message: "Your account has been deactivated. You cannot update order status. Reason: " + (seller?.inactiveReason || "No reason provided")
        });
      }
    }

    // ── Validate transition to SHIPPED ────────────────────────────────────
    const transitionValidation = validateStatusTransition({
      currentStatus: order.status,
      nextStatus: 'SHIPPED',
      trackingNumber,
      estimatedDelivery,
      reason: null
    });

    if (!transitionValidation.isValid) {
      return reply.status(400).send({ success: false, message: transitionValidation.message });
    }

    const normalizedTrackingNumber = normalizeTrackingNumber(trackingNumber);
    if (normalizedTrackingNumber) {
      await ensureUniqueTrackingNumber({
        trackingNumber: normalizedTrackingNumber,
        excludeOrderId: isSubOrder ? null : orderId,
        excludeSubOrderId: isSubOrder ? orderId : null
      });
    }

    // ── Persist the update ────────────────────────────────────────────────
    if (isSubOrder) {
      await prisma.subOrder.update({
        where: { id: orderId },
        data: {
          trackingNumber: normalizedTrackingNumber,
          estimatedDelivery: estimatedDelivery ? new Date(estimatedDelivery) : null,
          status: "SHIPPED"
        }
      });

      // Aggregate parent order status (same rule as updateOrderStatus)
      const [parentRecord2, allSiblings2] = await Promise.all([
        prisma.order.findUnique({ where: { id: order.parentOrderId }, select: { status: true, overallStatus: true } }),
        prisma.subOrder.findMany({ where: { parentOrderId: order.parentOrderId }, select: { status: true } })
      ]);
      const currentParentStatus2 = parentRecord2?.status || parentRecord2?.overallStatus || 'CONFIRMED';
      const siblingStatuses = allSiblings2.map(s => s.status);
      const allTerminal = siblingStatuses.every(s => TERMINAL_STATUSES.includes(s));
      let newParentStatus;
      if (allTerminal) {
        newParentStatus = siblingStatuses.every(s => s === 'CANCELLED') ? 'CANCELLED' : 'PARTIAL_REFUND';
      } else {
        const activeStatuses = siblingStatuses.filter(s => !TERMINAL_STATUSES.includes(s));
        const minIndex = Math.min(...activeStatuses.map(s => {
          const idx = ORDER_STATUS_SEQUENCE.indexOf(s);
          return idx === -1 ? Infinity : idx;
        }));
        newParentStatus = minIndex !== Infinity ? ORDER_STATUS_SEQUENCE[minIndex] : null;
      }
      if (newParentStatus && newParentStatus !== currentParentStatus2) {
        await prisma.order.update({
          where: { id: order.parentOrderId },
          data: { status: newParentStatus, overallStatus: newParentStatus, updatedAt: new Date() }
        });
      }
    } else {
      await prisma.order.update({
        where: { id: orderId },
        data: {
          trackingNumber: normalizedTrackingNumber,
          estimatedDelivery: estimatedDelivery ? new Date(estimatedDelivery) : null,
          status: "SHIPPED"
        }
      });
    }

    // ── Notifications & emails ────────────────────────────────────────────
    const customerEmail = order.user?.email || order.customerEmail;
    const customerName  = (order.user?.isDeleted ? 'Deleted User' : order.user?.name) || order.customerName || 'Customer';

    if (customerEmail) {
      sendOrderStatusEmail(customerEmail, customerName, {
        displayId: order.displayId,
        status: "shipped",
        trackingNumber: normalizedTrackingNumber,
        totalAmount: order.totalAmount,
        paymentMethod: order.paymentMethod,
        orderDate: order.createdAt,
        estimatedDelivery,
        shippingName: order.customerName,
        shippingAddress: order.shippingAddressLine,
        shippingCity: order.shippingCity,
        shippingState: order.shippingState,
        shippingZipCode: order.shippingZipCode,
        shippingCountry: order.shippingCountry,
        shippingPhone: order.shippingPhone,
        isGuest: !order.userId,
        orderSummary: (order.shippingAddress || {}).orderSummary || undefined,
        products: order.items?.map(item => ({
          title: item.product?.title || 'Product',
          quantity: item.quantity,
          price: parseFloat(item.price)
        }))
      }).catch(error => { console.error("Email error (non-blocking):", error.message); });

      if (order.user?.id) {
        notifyCustomerOrderStatusChange(order.user.id, orderId, "shipped", {
          totalAmount: order.totalAmount.toString(),
          itemCount: order.items.length,
          trackingNumber: normalizedTrackingNumber
        }).catch(error => { console.error("Customer notification error (non-blocking):", error.message); });
      }

      if (userRole === "SELLER") {
        const seller = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
        notifyAdminOrderStatusChange(orderId, "shipped", {
          customerName, sellerName: seller?.name || 'Unknown',
          totalAmount: order.totalAmount.toString(), itemCount: order.items.length, trackingNumber: normalizedTrackingNumber
        }).catch(err => console.error("Admin in-app notification error (non-blocking):", err.message));
        prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } })
          .then(admins => {
            for (const admin of admins) {
              if (admin.email) {
                sendAdminOrderStatusEmail(admin.email, admin.name, {
                  displayId: order.displayId, status: 'shipped',
                  sellerName: seller?.name || 'Unknown', updatedBy: 'Seller',
                  customerName, totalAmount: order.totalAmount, trackingNumber: normalizedTrackingNumber
                }).catch(err => console.error("Admin order status email error (non-blocking):", err.message));
              }
            }
          }).catch(err => console.error("Admin email lookup error (non-blocking):", err.message));
      }

      if (userRole === "ADMIN") {
        const sellerIds = isSubOrder
          ? [order.sellerId].filter(Boolean)
          : [...new Set(order.items.map(item => item.product?.sellerId).filter(Boolean))];
        for (const sellerId of sellerIds) {
          notifySellerOrderStatusChange(sellerId, orderId, "shipped", {
            customerName, totalAmount: order.totalAmount.toString(), trackingNumber: normalizedTrackingNumber
          }).catch(err => console.error("Seller in-app notification error (non-blocking):", err.message));
          prisma.user.findUnique({ where: { id: sellerId }, select: { email: true, name: true } })
            .then(sellerUser => {
              if (sellerUser?.email) {
                sendSellerOrderStatusEmail(sellerUser.email, sellerUser.name || 'Seller', {
                  displayId: order.displayId, status: 'shipped', customerName,
                  totalAmount: order.totalAmount, trackingNumber: normalizedTrackingNumber
                }).catch(err => console.error("Seller order status email error (non-blocking):", err.message));
              }
            }).catch(err => console.error("Seller email lookup error (non-blocking):", err.message));
        }
      }
    }

    return reply.status(200).send({ success: true, message: "Tracking info updated successfully. Customer notified via email." });

  } catch (error) {
    if (error.code === 'TRACKING_NUMBER_CONFLICT') {
      return reply.status(409).send({ success: false, message: error.message });
    }
    console.error("Update tracking info error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// SELLER/ADMIN — BULK UPDATE ORDER STATUS
exports.bulkUpdateOrderStatus = async (request, reply) => {
  try {
    const userId   = request.user.userId;
    const userRole = request.user.role;
    const isAdmin  = ['ADMIN', 'SUPER_ADMIN'].includes(userRole);

    const { orderIds, status, trackingNumber, estimatedDelivery, statusReason } = request.body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return reply.status(400).send({ success: false, message: "orderIds array is required" });
    }

    const normalizedStatus = normalizeOrderStatus(status);
    if (!normalizedStatus) {
      return reply.status(400).send({
        success: false,
        message: `Invalid status. Allowed values: ${VALID_TARGET_STATUSES.join(', ')}`
      });
    }

    const results = [];

    for (const orderEntry of orderIds) {
      // Each entry can be a plain string ID or an object { id, trackingNumber, estimatedDelivery, statusReason }
      const orderId               = typeof orderEntry === 'string' ? orderEntry : orderEntry.id;
      const entryTracking         = typeof orderEntry === 'object' ? (orderEntry.trackingNumber    ?? trackingNumber)    : trackingNumber;
      const entryEstimatedDelivery= typeof orderEntry === 'object' ? (orderEntry.estimatedDelivery ?? estimatedDelivery) : estimatedDelivery;
      const entryStatusReason     = typeof orderEntry === 'object' ? (orderEntry.statusReason      ?? statusReason)      : statusReason;

      if (!orderId || typeof orderId !== 'string') {
        results.push({ orderId, success: false, message: "Invalid or missing order ID" });
        continue;
      }

      try {
        // ── Resolve order record (sub-order, direct, or legacy) ───────────
        let orderRecord = null;
        let isDirectOrder = false;
        let isSubOrder    = false;
        let isLegacyOrder = false;

        // 1. Try direct / legacy order first
        const directOrder = await prisma.order.findUnique({
          where: { id: orderId },
          include: {
            user:  true,
            items: { include: { product: true } }
          }
        });

        if (directOrder) {
          if (directOrder.sellerId) {
            orderRecord  = {
              id:             directOrder.id,
              sellerId:       directOrder.sellerId,
              status:         directOrder.status || directOrder.overallStatus,
              trackingNumber: directOrder.trackingNumber,
              estimatedDelivery: directOrder.estimatedDelivery,
              statusReason:   directOrder.statusReason,
              subtotal:       directOrder.totalAmount,
              items:          directOrder.items,
              parentOrder:    directOrder,
              customer:       directOrder.user,
              customerName:   directOrder.customerName,
              customerEmail:  directOrder.customerEmail,
            };
            isDirectOrder = true;
          } else {
            // Legacy: no sellerId on order — check items
            const sellerItems = directOrder.items.filter(i => i.product?.sellerId === userId);
            if (sellerItems.length > 0 || isAdmin) {
              const effectiveItems = isAdmin ? directOrder.items : sellerItems;
              orderRecord = {
                id:             directOrder.id,
                sellerId:       isAdmin ? (directOrder.sellerId || userId) : userId,
                status:         directOrder.status || directOrder.overallStatus,
                trackingNumber: directOrder.trackingNumber,
                estimatedDelivery: directOrder.estimatedDelivery,
                statusReason:   directOrder.statusReason,
                subtotal:       effectiveItems.reduce((s, i) => s + parseFloat(i.price || 0) * i.quantity, 0),
                items:          effectiveItems,
                parentOrder:    directOrder,
                customer:       directOrder.user,
                customerName:   directOrder.customerName,
                customerEmail:  directOrder.customerEmail,
              };
              isLegacyOrder = true;
            }
          }
        }

        // 2. Fall back to sub-order
        if (!orderRecord) {
          const subRec = await prisma.subOrder.findUnique({
            where: { id: orderId },
            include: {
              parentOrder: { include: { user: true } },
              items: { include: { product: true } }
            }
          });

          if (subRec) {
            orderRecord = {
              id:             subRec.id,
              sellerId:       subRec.sellerId,
              status:         subRec.status,
              trackingNumber: subRec.trackingNumber,
              estimatedDelivery: subRec.estimatedDelivery,
              statusReason:   subRec.statusReason,
              subtotal:       subRec.subtotal,
              items:          subRec.items,
              parentOrder:    subRec.parentOrder,
              customer:       subRec.parentOrder.user,
              customerName:   subRec.parentOrder.customerName,
              customerEmail:  subRec.parentOrder.customerEmail,
            };
            isSubOrder = true;
          }
        }

        if (!orderRecord) {
          results.push({ orderId, success: false, message: "Order not found" });
          continue;
        }

        // ── Permission check ──────────────────────────────────────────────
        if (!isAdmin && orderRecord.sellerId !== userId) {
          results.push({ orderId, success: false, message: "Unauthorized — not your order" });
          continue;
        }

        // Check if seller is inactive (only for sellers, not admin)
        if (!isAdmin) {
          const seller = await prisma.sellerProfile.findUnique({
            where: { userId }
          });
          
          if (!seller?.isActive) {
            results.push({ 
              orderId, 
              success: false, 
              message: "Your account has been deactivated. You cannot update order status. Reason: " + (seller?.inactiveReason || "No reason provided")
            });
            continue;
          }
        }

        // ── Validate transition ───────────────────────────────────────────
        const transitionCheck = validateStatusTransition({
          currentStatus: orderRecord.status,
          nextStatus:    normalizedStatus,
          trackingNumber:    entryTracking,
          estimatedDelivery: entryEstimatedDelivery,
          reason:            entryStatusReason
        });
        if (!transitionCheck.isValid) {
          results.push({ orderId, success: false, message: transitionCheck.message });
          continue;
        }

        const normalizedEntryTracking = normalizeTrackingNumber(entryTracking);
        if (normalizedEntryTracking) {
          await ensureUniqueTrackingNumber({
            trackingNumber: normalizedEntryTracking,
            excludeOrderId: (isDirectOrder || isLegacyOrder) ? orderId : null,
            excludeSubOrderId: isSubOrder ? orderId : null
          });
        }

        // ── Build update payload ──────────────────────────────────────────
        const updateData = { status: normalizedStatus, updatedAt: new Date() };
        if (entryTracking          !== undefined) updateData.trackingNumber    = normalizedEntryTracking;
        if (entryEstimatedDelivery !== undefined) updateData.estimatedDelivery = entryEstimatedDelivery ? new Date(entryEstimatedDelivery) : null;
        if (entryStatusReason      !== undefined) updateData.statusReason      = entryStatusReason;

        // ── Persist ───────────────────────────────────────────────────────
        if (isDirectOrder || isLegacyOrder) {
          await prisma.order.update({
            where: { id: orderId },
            data:  { ...updateData, overallStatus: normalizedStatus }
          });
        } else {
          // Sub-order
          await prisma.subOrder.update({ where: { id: orderId }, data: updateData });

          // ── Aggregate parent order status ─────────────────────────────
          const [parentRecord, allSiblings] = await Promise.all([
            prisma.order.findUnique({
              where:  { id: orderRecord.parentOrder.id },
              select: { status: true, overallStatus: true }
            }),
            prisma.subOrder.findMany({
              where:  { parentOrderId: orderRecord.parentOrder.id },
              select: { status: true }
            })
          ]);

          const currentParentStatus = parentRecord?.status || parentRecord?.overallStatus || 'CONFIRMED';
          const siblingStatuses     = allSiblings.map(s => s.status);
          let   newParentStatus     = currentParentStatus;

          const allTerminal = siblingStatuses.every(s => TERMINAL_STATUSES.includes(s));
          if (allTerminal) {
            newParentStatus = siblingStatuses.every(s => s === 'CANCELLED') ? 'CANCELLED' : 'PARTIAL_REFUND';
          } else {
            const active = siblingStatuses.filter(s => !TERMINAL_STATUSES.includes(s));
            if (active.length > 0) {
              const minIndex = Math.min(...active.map(s => {
                const idx = ORDER_STATUS_SEQUENCE.indexOf(s);
                return idx === -1 ? Infinity : idx;
              }));
              if (minIndex !== Infinity) newParentStatus = ORDER_STATUS_SEQUENCE[minIndex];
            }
          }

          if (newParentStatus !== currentParentStatus) {
            await prisma.order.update({
              where: { id: orderRecord.parentOrder.id },
              data:  { status: newParentStatus, overallStatus: newParentStatus, updatedAt: new Date() }
            });
          }
        }

        // ── Non-blocking notifications ────────────────────────────────────
        const customer      = orderRecord.customer;
        const customerEmail = customer?.email || orderRecord.customerEmail;
        const customerName  = (customer?.isDeleted ? 'Deleted User' : customer?.name) || orderRecord.customerName || 'Customer';

        if (customerEmail) {
          sendOrderStatusEmail(customerEmail, customerName, {
            displayId:         orderRecord.parentOrder?.displayId || orderRecord.id,
            status:            normalizedStatus.toLowerCase(),
            reason:            entryStatusReason || undefined,
            trackingNumber:    normalizedEntryTracking || orderRecord.trackingNumber,
            estimatedDelivery: entryEstimatedDelivery || orderRecord.estimatedDelivery,
            totalAmount:       orderRecord.subtotal,
            paymentMethod:     orderRecord.parentOrder?.paymentMethod,
            orderDate:         orderRecord.createdAt,
            products: orderRecord.items.map(item => ({
              title:    item.product?.title || 'Product',
              quantity: item.quantity,
              price:    parseFloat(item.price)
            }))
          }).catch(err => console.error("Bulk status email error (non-blocking):", err.message));
        }

        if (customer?.id) {
          notifyCustomerOrderStatusChange(customer.id, orderRecord.id, normalizedStatus.toLowerCase(), {
            totalAmount: String(orderRecord.subtotal),
            itemCount:   orderRecord.items.length,
            reason:         entryStatusReason || undefined,
            trackingNumber: normalizedEntryTracking || updateData.trackingNumber
          }).catch(err => console.error("Bulk customer notification error (non-blocking):", err.message));
        }

        results.push({
          orderId,
          success: true,
          status:  mapStatusForDisplay(normalizedStatus),
          type:    isDirectOrder ? 'DIRECT' : (isLegacyOrder ? 'LEGACY' : 'SUB_ORDER')
        });

      } catch (innerErr) {
        console.error(`Bulk status update error for orderId ${orderId}:`, innerErr.message);
        results.push({ orderId, success: false, message: innerErr.message });
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed    = results.length - succeeded;

    return reply.status(200).send({
      success: true,
      message: `Bulk update complete — ${succeeded} updated, ${failed} failed.`,
      updatedStatus: normalizedStatus,
      results
    });

  } catch (error) {
    console.error("Bulk update order status error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// SELLER — BULK UPDATE STOCK
exports.bulkUpdateStock = async (request, reply) => {
  try {
    const sellerId = request.user.userId; // From authenticateSeller middleware
    const updates = request.body;

    if (!Array.isArray(updates) || updates.length === 0) {
      return reply.status(400).send({ success: false, message: "Updates array is required" });
    }

    let results = [];

    for (const item of updates) {
      const { productId, stock } = item;

      if (!productId || stock === undefined) {
        results.push({ productId, success: false, message: "productId and stock are required" });
        continue;
      }

      const product = await prisma.product.findUnique({
        where: { id: productId }
      });

      if (!product) {
        results.push({ productId, success: false, message: "Product not found" });
        continue;
      }

      // Check seller ownership
      if (product.sellerId !== sellerId) {
        results.push({ productId, success: false, message: "Unauthorized seller" });
        continue;
      }

      const newStock = Number(stock);
      const newStatus = newStock > 0 ? "ACTIVE" : "INACTIVE";

      await prisma.product.update({
        where: { id: productId },
        data: {
          stock: newStock,
          status: newStatus
        }
      });

      results.push({
        productId,
        success: true,
        stock: newStock,
        status: newStatus,
        message: "Stock updated successfully"
      });
    }

    return reply.status(200).send({
      success: true,
      message: "Bulk stock update completed",
      results
    });

  } catch (error) {
    return reply.status(500).send({ success: false, message: error.message });
  }
};





// SELLER — EXPORT SALES REPORT (CSV)
exports.exportSalesReport = async (request, reply) => {
  try {
    const sellerId = request.user.userId;
    const { startDate, endDate, reportType } = request.query;

    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      dateFilter.lte = end;
    }
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    // Fetch all three order types in parallel
    const [subOrders, directOrders, legacyOrders] = await Promise.all([

      // 1. Sub-orders (multi-seller architecture)
      prisma.subOrder.findMany({
        where: { sellerId, ...(hasDateFilter ? { createdAt: dateFilter } : {}) },
        include: {
          items: { include: { product: true } },
          parentOrder: {
            include: { user: { select: { id: true, name: true, email: true, phone: true, isDeleted: true } } }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),

      // 2. Direct orders (sellerId set on order)
      prisma.order.findMany({
        where: { sellerId, ...(hasDateFilter ? { createdAt: dateFilter } : {}) },
        include: {
          items: { include: { product: true } },
          user: { select: { id: true, name: true, email: true, phone: true, isDeleted: true } }
        },
        orderBy: { createdAt: 'desc' }
      }),

      // 3. Legacy orders (sellerId=null, items reference this seller)
      prisma.order.findMany({
        where: {
          sellerId: null,
          subOrders: { none: {} },
          items: { some: { product: { sellerId } } },
          ...(hasDateFilter ? { createdAt: dateFilter } : {})
        },
        include: {
          items: { include: { product: true } },
          user: { select: { id: true, name: true, email: true, phone: true, isDeleted: true } }
        },
        orderBy: { createdAt: 'desc' }
      })
    ]);

    // Helper: map items to the shape csvExport expects
    const toProducts = (items) =>
      items
        .filter(item => item.product?.sellerId === sellerId)
        .map(item => ({
          productId: item.product.id,          // ← fix: was spreading as 'id'
          title:     item.product.title || 'N/A',
          quantity:  item.quantity,
          price:     parseFloat(item.price),   // ← fix: Prisma Decimal → number
          sellerId:  item.product.sellerId,
        }));

    const sellerOrders = [];

    // Sub-orders
    subOrders.forEach(sub => {
      const p = sub.parentOrder;
      const maskedUser = maskDeletedUser(p.user);
      sellerOrders.push({
        id:                  sub.id,
        status:              sub.status || 'N/A',
        paymentMethod:       p.paymentMethod       || 'N/A',
        trackingNumber:      sub.trackingNumber     || null,
        estimatedDelivery:   sub.estimatedDelivery  || null,
        customerName:        maskedUser?.name  || p.customerName  || 'N/A',
        customerEmail:       maskedUser?.email || p.customerEmail || 'N/A',
        customerPhone:       maskedUser?.phone || p.customerPhone || 'N/A',
        shippingAddressLine: p.shippingAddressLine  || null,
        shippingCity:        p.shippingCity         || null,
        shippingState:       p.shippingState        || null,
        shippingZipCode:     p.shippingZipCode      || null,
        shippingCountry:     p.shippingCountry      || null,
        shippingPhone:       p.shippingPhone        || p.customerPhone || 'N/A',
        shippingAddress:     p.shippingAddress      || null,
        createdAt:           sub.createdAt,
        products: sub.items.map(item => ({
          productId: item.product?.id    || 'N/A',
          title:     item.product?.title || 'N/A',
          quantity:  item.quantity,
          price:     parseFloat(item.price),
          sellerId:  item.product?.sellerId,
        })),
      });
    });

    // Direct orders
    directOrders.forEach(order => {
      const products = toProducts(order.items);
      if (!products.length) return;
      const maskedUser = maskDeletedUser(order.user);
      sellerOrders.push({
        id:                  order.id,
        status:              order.status || order.overallStatus || 'N/A', // ← fix: overallStatus fallback
        paymentMethod:       order.paymentMethod       || 'N/A',
        trackingNumber:      order.trackingNumber      || null,
        estimatedDelivery:   order.estimatedDelivery   || null,
        customerName:        maskedUser?.name  || order.customerName  || 'N/A',
        customerEmail:       maskedUser?.email || order.customerEmail || 'N/A',
        customerPhone:       maskedUser?.phone || order.customerPhone || 'N/A',
        shippingAddressLine: order.shippingAddressLine || null,
        shippingCity:        order.shippingCity        || null,
        shippingState:       order.shippingState       || null,
        shippingZipCode:     order.shippingZipCode     || null,
        shippingCountry:     order.shippingCountry     || null,
        shippingPhone:       order.shippingPhone       || order.customerPhone || 'N/A',
        shippingAddress:     order.shippingAddress     || null,
        createdAt:           order.createdAt,
        products,
      });
    });

    // Legacy orders
    legacyOrders.forEach(order => {
      const products = toProducts(order.items);
      if (!products.length) return;
      const maskedUser = maskDeletedUser(order.user);
      sellerOrders.push({
        id:                  order.id,
        status:              order.status || order.overallStatus || 'N/A',
        paymentMethod:       order.paymentMethod       || 'N/A',
        trackingNumber:      order.trackingNumber      || null,
        estimatedDelivery:   order.estimatedDelivery   || null,
        customerName:        maskedUser?.name  || order.customerName  || 'N/A',
        customerEmail:       maskedUser?.email || order.customerEmail || 'N/A',
        customerPhone:       maskedUser?.phone || order.customerPhone || 'N/A',
        shippingAddressLine: order.shippingAddressLine || null,
        shippingCity:        order.shippingCity        || null,
        shippingState:       order.shippingState       || null,
        shippingZipCode:     order.shippingZipCode     || null,
        shippingCountry:     order.shippingCountry     || null,
        shippingPhone:       order.shippingPhone       || order.customerPhone || 'N/A',
        shippingAddress:     order.shippingAddress     || null,
        createdAt:           order.createdAt,
        products,
      });
    });

    sellerOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (sellerOrders.length === 0) {
      return reply.status(404).send({ success: false, message: "No sales data found for the specified period" });
    }


    let csv, filename;
    if (reportType === 'summary') {
      csv = generateSalesSummaryCSV(sellerOrders, sellerId);
      filename = `sales-summary-${sellerId}-${Date.now()}.csv`;
    } else {
      csv = generateSalesReportCSV(sellerOrders);
      filename = `sales-report-${sellerId}-${Date.now()}.csv`;
    }

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(csv);

  } catch (error) {
    console.error("Export sales report error:", error);
    return reply.status(500).send({ success: false, message: error.message || "Failed to generate sales report" });
  }
};

// SELLER — GET SALES ANALYTICS [PRISMA VERSION]
exports.getSalesAnalytics = async (request, reply) => {
  try {
    const sellerId = request.user.userId;
    const { startDate, endDate } = request.query;


    // Build optional date filter
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) {
        dateFilter.createdAt.gte = new Date(startDate);
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateFilter.createdAt.lte = end;
      }
    }

    const itemInclude = { include: { product: true } };

    // Query all three order sources — same strategy as getSellerOrders
    const [directOrders, subOrders, oldOrders] = await Promise.all([
      // 1. Direct orders assigned to this seller
      prisma.order.findMany({
        where: { sellerId: sellerId, ...dateFilter },
        include: { items: itemInclude }
      }),
      // 2. Sub-orders (multi-seller checkout)
      prisma.subOrder.findMany({
        where: { sellerId: sellerId, ...dateFilter },
        include: { items: itemInclude }
      }),
      // 3. Legacy orders (no sellerId) that contain this seller's products
      prisma.order.findMany({
        where: {
          sellerId: null,
          items: { some: { product: { sellerId: sellerId } } },
          ...dateFilter
        },
        include: { items: itemInclude }
      })
    ]);

    let totalRevenue = 0;
    let totalOrders = 0;
    let totalItemsSold = 0;
    const statusBreakdown = {
      PENDING: 0,
      CONFIRMED: 0,
      PROCESSING: 0,
      SHIPPED: 0,
      DELIVERED: 0,
      CANCELLED: 0
    };
    const productPerformance = new Map();

    const trackItems = (items, status) => {
      for (const item of items) {
        totalRevenue += Number(item.price) * item.quantity;
        totalItemsSold += item.quantity;
        if (!productPerformance.has(item.productId)) {
          productPerformance.set(item.productId, {
            title: item.product.title,
            quantitySold: 0,
            revenue: 0
          });
        }
        const perfData = productPerformance.get(item.productId);
        perfData.quantitySold += item.quantity;
        perfData.revenue += Number(item.price) * item.quantity;
      }
      totalOrders += 1;
      statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
    };

    // Process direct orders (all items belong to this seller)
    for (const order of directOrders) {
      const status = order.status || order.overallStatus;
      trackItems(order.items, status);
    }

    // Process sub-orders (items are already scoped to this seller)
    for (const subOrder of subOrders) {
      trackItems(subOrder.items, subOrder.status);
    }

    // Process legacy orders (filter to only this seller's items)
    for (const order of oldOrders) {
      const sellerItems = order.items.filter(item => item.product?.sellerId === sellerId);
      if (sellerItems.length > 0) {
        const status = order.status || order.overallStatus;
        trackItems(sellerItems, status);
      }
    }

    // Get top 5 performing products
    const topProducts = Array.from(productPerformance.entries())
      .map(([productId, data]) => ({
        productId,
        ...data
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const analytics = {
      totalRevenue: totalRevenue.toFixed(2),
      totalOrders,
      totalItemsSold,
      averageOrderValue: totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(2) : '0.00',
      statusBreakdown,
      topProducts,
      period: {
        startDate: startDate || 'All time',
        endDate: endDate || 'Present'
      }
    };


    return reply.status(200).send({
      success: true,
      analytics
    });

  } catch (error) {
    console.error("Get sales analytics error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message || "Failed to fetch analytics" 
    });
  }
};

// ── Helpers for refund request formatting ───────────────────────────────────

const formatRequestTypeLabel = (type) => {
  if (!type) return null;
  const map = {
    REFUND:          'Full Refund',
    PARTIAL_REFUND:  'Partial Refund'
  };
  return map[type.toUpperCase()] || type;
};

const parseRefundReason = (message) => {
  // Stop reason at "Requested Items:" list or JSON block so we don't capture extra content
  const reasonMatch = (message || '').match(/Reason:\s*([\s\S]+?)(?=\nRequested Items:|\n---ITEMS_JSON---|$)/i);
  return reasonMatch?.[1]?.trim() || null;
};

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

const getSellerItemsForOrder = (order, sellerId) => {
  // Items directly on the order belonging to this seller
  const directItems = (order.items || []).filter(i => i.product?.sellerId === sellerId);
  // Items via sub-orders belonging to this seller
  const subOrderItems = (order.subOrders || [])
    .filter(s => s.sellerId === sellerId)
    .flatMap(s => s.items || []);
  const combined = directItems.length > 0 ? directItems : subOrderItems;
  return combined.map(item => ({
    id:         item.id,
    productId:  item.product?.id || item.productId,
    title:      item.product?.title || 'Product',
    image:      item.product?.featuredImage || null,
    category:   item.product?.category || null,
    sellerName: item.product?.sellerName || null,
    quantity:   item.quantity,
    price:      item.price
  }));
};

// SELLER — LIST ALL REFUND REQUESTS FOR THIS SELLER'S ORDERS
exports.getSellerRefundRequests = async (request, reply) => {
  try {
    const sellerId = request.user.userId;

    // Step 1: Collect all order IDs that involve this seller
    const [directOrderIds, subOrderRefs, oldOrderIds] = await Promise.all([
      prisma.order.findMany({
        where: { sellerId },
        select: { id: true }
      }),
      prisma.subOrder.findMany({
        where: { sellerId },
        select: { parentOrderId: true }
      }),
      prisma.order.findMany({
        where: {
          sellerId: null,
          items: { some: { product: { sellerId } } }
        },
        select: { id: true }
      })
    ]);

    const allOrderIds = [...new Set([
      ...directOrderIds.map(o => o.id),
      ...subOrderRefs.map(s => s.parentOrderId),
      ...oldOrderIds.map(o => o.id)
    ])];

    if (allOrderIds.length === 0) {
      return reply.status(200).send({ success: true, requests: [], count: 0 });
    }

    // Step 2: Fetch refund request tickets for those orders
    const tickets = await prisma.supportTicket.findMany({
      where: {
        category: 'REFUND_REQUEST',
        orderId: { in: allOrderIds }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (tickets.length === 0) {
      return reply.status(200).send({ success: true, requests: [], count: 0 });
    }

    // Step 3: Fetch orders with seller-relevant items
    const ticketOrderIds = [...new Set(tickets.map(t => t.orderId).filter(Boolean))];
    const orders = await prisma.order.findMany({
      where: { id: { in: ticketOrderIds } },
      select: {
        id: true,
        displayId: true,
        status: true,
        overallStatus: true,
        totalAmount: true,
        customerName: true,
        customerEmail: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, isDeleted: true } },
        items: {
          include: {
            product: {
              select: { id: true, title: true, featuredImage: true, price: true, category: true, sellerName: true, sellerId: true }
            }
          }
        },
        subOrders: {
          where: { sellerId },
          select: {
            id: true,
            sellerId: true,
            subDisplayId: true,
            items: {
              include: {
                product: {
                  select: { id: true, title: true, featuredImage: true, price: true, category: true, sellerName: true, sellerId: true }
                }
              }
            }
          }
        }
      }
    });

    const orderMap = new Map(orders.map(o => [o.id, o]));

    const requests = tickets.map(ticket => {
      const order = ticket.orderId ? orderMap.get(ticket.orderId) : null;
      const sellerItems = order ? getSellerItemsForOrder(order, sellerId) : [];
      const maskedOrderUser = maskDeletedUser(order?.user);
      const customerName = maskedOrderUser?.name || order?.customerName || null;
      const customerEmail = maskedOrderUser?.email || order?.customerEmail || null;
      const requestedItems = parseRequestedItems(ticket.message);
      const sellerSubOrder = order?.subOrders?.find(s => s.sellerId === sellerId);
      const subOrderDisplayId = sellerSubOrder?.subDisplayId
        ? `#${sellerSubOrder.subDisplayId}`
        : null;

      // Filter requestedItems to only this seller's products
      const sellerProductIds = new Set(sellerItems.map(i => i.productId).filter(Boolean));
      const filteredRequestedItems = requestedItems
        ? requestedItems.filter(ri => sellerProductIds.has(ri.productId))
        : null;

      return {
        id:                 ticket.id,
        requestId:          ticket.id,
        orderId:            ticket.orderId,
        orderDisplayId:     order ? `#${order.displayId}` : null,
        subOrderDisplayId,
        requestType:        formatRequestTypeLabel(ticket.requestType),
        subject:            ticket.subject,
        reason:             parseRefundReason(ticket.message),
        status:             ({ OPEN: 'OPEN', IN_PROGRESS: 'APPROVED', RESOLVED: 'COMPLETED', CLOSED: 'REJECTED' }[ticket.status] || ticket.status),
        priority:           ticket.priority,
        attachments:        ticket.attachments || [],
        adminResponse:      ticket.response,
        customerName,
        customerEmail,
        order: order ? {
          id:          order.id,
          displayId:   `#${order.displayId}`,
          status:      order.status || order.overallStatus,
          totalAmount: order.totalAmount,
          createdAt:   order.createdAt
        } : null,
        requestedItems: filteredRequestedItems,
        sellerItems,
        createdAt:  ticket.createdAt,
        updatedAt:  ticket.updatedAt
      };
    });

    return reply.status(200).send({
      success: true,
      requests,
      count: requests.length
    });
  } catch (error) {
    console.error('Get seller refund requests error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// SELLER — GET SINGLE REFUND REQUEST DETAIL
exports.getSellerRefundRequestById = async (request, reply) => {
  try {
    const sellerId = request.user.userId;
    const { requestId } = request.params;

    const ticket = await prisma.supportTicket.findFirst({
      where: {
        id: requestId,
        category: 'REFUND_REQUEST'
      }
    });

    if (!ticket) {
      return reply.status(404).send({ success: false, message: 'Refund request not found' });
    }

    if (!ticket.orderId) {
      return reply.status(403).send({ success: false, message: 'Not authorized to view this request' });
    }

    // Verify the order belongs to this seller
    const order = await prisma.order.findFirst({
      where: {
        id: ticket.orderId,
        OR: [
          { sellerId },
          { subOrders: { some: { sellerId } } },
          { items: { some: { product: { sellerId } } } }
        ]
      },
      select: {
        id: true,
        displayId: true,
        status: true,
        overallStatus: true,
        totalAmount: true,
        customerName: true,
        customerEmail: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, isDeleted: true } },
        items: {
          include: {
            product: {
              select: { id: true, title: true, featuredImage: true, price: true, category: true, sellerName: true, sellerId: true }
            }
          }
        },
        subOrders: {
          where: { sellerId },
          select: {
            id: true,
            sellerId: true,
            subDisplayId: true,
            items: {
              include: {
                product: {
                  select: { id: true, title: true, featuredImage: true, price: true, category: true, sellerName: true, sellerId: true }
                }
              }
            }
          }
        }
      }
    });

    if (!order) {
      return reply.status(403).send({ success: false, message: 'Not authorized to view this request' });
    }

    const sellerItems = getSellerItemsForOrder(order, sellerId);
    const maskedOrderUser = maskDeletedUser(order.user);
    const customerName  = maskedOrderUser?.name  || order.customerName  || null;
    const customerEmail = maskedOrderUser?.email || order.customerEmail || null;
    const requestedItems = parseRequestedItems(ticket.message);
    const sellerSubOrder = order.subOrders?.find(s => s.sellerId === sellerId);
    const subOrderDisplayId = sellerSubOrder?.subDisplayId
      ? `#${sellerSubOrder.subDisplayId}`
      : null;

    // Filter requestedItems to only this seller's products
    const sellerProductIds = new Set(sellerItems.map(i => i.productId).filter(Boolean));
    const filteredRequestedItems = requestedItems
      ? requestedItems.filter(ri => sellerProductIds.has(ri.productId))
      : null;

    return reply.status(200).send({
      success: true,
      request: {
        id:               ticket.id,
        requestId:        ticket.id,
        orderId:          ticket.orderId,
        orderDisplayId:   `#${order.displayId}`,
        subOrderDisplayId,
        requestType:      formatRequestTypeLabel(ticket.requestType),
        subject:          ticket.subject,
        reason:           parseRefundReason(ticket.message),
        status:           ({ OPEN: 'OPEN', IN_PROGRESS: 'APPROVED', RESOLVED: 'COMPLETED', CLOSED: 'REJECTED' }[ticket.status] || ticket.status),
        priority:         ticket.priority,
        attachments:      ticket.attachments || [],
        adminResponse:    ticket.response,
        customerName,
        customerEmail,
        order: {
          id:          order.id,
          displayId:   `#${order.displayId}`,
          status:      order.status || order.overallStatus,
          totalAmount: order.totalAmount,
          createdAt:   order.createdAt
        },
        requestedItems: filteredRequestedItems,
        sellerItems,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt
      }
    });
  } catch (error) {
    console.error('Get seller refund request by id error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};