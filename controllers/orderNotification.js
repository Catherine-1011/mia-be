const prisma = require("../config/prisma");
const { 
  calculateSLADeadline, 
  calculateSLAStatus, 
  getSLAConfig 
} = require("../config/slaConfig");
const { 
  sendSellerOrderNotificationEmail,
  sendSLAWarningEmail 
} = require("../utils/emailService");
const {
  normalizeOrderStatus,
  validateStatusTransition,
  VALID_TARGET_STATUSES
} = require("../utils/orderStatusRules");

const normalizeTrackingNumber = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const ensureUniqueTrackingNumber = async ({ trackingNumber, excludeOrderId = null }) => {
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
      where: { trackingNumber: { equals: normalized, mode: 'insensitive' } },
      select: { id: true, subDisplayId: true }
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

// CREATE ORDER NOTIFICATION
const createOrderNotification = async (orderId, sellerId, type, priority = 'MEDIUM', additionalData = {}) => {
  try {
    // Check if OrderNotification model exists
    if (!prisma || !prisma.orderNotification) {
      console.error('❌ [OrderNotification] Prisma model not available — skipping creation.');
      return { success: false, message: 'Model not available' };
    }

    console.log(`📋 [OrderNotification] Creating: type=${type} | orderId=${orderId} | sellerId=${sellerId}`);

    const notification = await prisma.orderNotification.create({
      data: {
        orderId,
        sellerId,
        type,
        priority,
        status: 'PENDING',
        message: additionalData.message || `${type} required for order`,
        notes: additionalData.notes || null,
        slaDeadline: calculateSLADeadline(type),
        createdAt: new Date()
      }
    });

    console.log(`✅ [OrderNotification] Created id=${notification.id} type=${type}`);
    return notification;
  } catch (error) {
    console.error(`❌ [OrderNotification] Create failed — type=${type} orderId=${orderId} sellerId=${sellerId}:`, error.message);
    // Don't throw error to avoid breaking order creation
    return { success: false, error: error.message };
  }
};

// GET SELLER NOTIFICATIONS WITH SLA STATUS
exports.getSellerNotifications = async (request, reply) => {
  try {
    const authenticatedUserId = request.user.userId;
    const userRole = request.user.role;
    const { 
      page = 1, 
      limit = 20, 
      status, 
      priority, 
      type,
      slaStatus,
      sellerId: querySellerId  // Allow admin to query by sellerId
    } = request.query;

    // Determine which seller's notifications to fetch
    let sellerId = authenticatedUserId;
    let adminViewAll = false;
    
    // If admin, allow them to query notifications for a specific seller or see all
    if (['ADMIN', 'SUPER_ADMIN'].includes(userRole) && querySellerId) {
      sellerId = querySellerId;
    } else if (['ADMIN', 'SUPER_ADMIN'].includes(userRole) && !querySellerId) {
      // Admin with no sellerId — return all notifications across all sellers
      adminViewAll = true;
    } else if (userRole !== 'SELLER' && !['ADMIN', 'SUPER_ADMIN'].includes(userRole)) {
      // Only sellers and admins can view notifications
      return reply.status(403).send({
        success: false,
        message: "Only sellers and admins can view notifications"
      });
    }

    console.log(`Getting notifications for seller: ${sellerId} (requested by ${userRole})`);

    // Check if prisma and model are available
    if (!prisma) {
      console.error('Prisma client not available');
      return reply.status(500).send({
        success: false,
        message: 'Database connection error'
      });
    }

    // Check if OrderNotification table exists by trying to count
    try {
      await prisma.orderNotification.count();
    } catch (modelError) {
      console.error('OrderNotification model error:', modelError.message);
      
      // If table doesn't exist, return empty result for now
      if (modelError.code === 'P2021' || modelError.message.includes('does not exist')) {
        console.log('OrderNotification table does not exist yet, returning empty result');
        return reply.status(200).send({
          success: true,
          message: 'Order notification system is being set up. Please run database migrations.',
          notifications: [],
          summary: {
            total: 0,
            pending: 0,
            overdue: 0,
            critical: 0
          },
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: 0,
            pages: 0
          }
        });
      }
      
      throw modelError; // Re-throw if it's a different error
    }

    // Admin with no sellerId filter sees everything; otherwise filter by seller
    const where = adminViewAll ? {} : { sellerId };
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (type) where.type = type;

    const notifications = await prisma.orderNotification.findMany({
      where,
      include: {
        order: {
          select: {
            id: true,
            displayId: true,
            totalAmount: true,
            status: true,
            createdAt: true,
            customerName: true,
            customerEmail: true,
            customerPhone: true,
            subOrders: {
              select: {
                id: true,
                status: true,
                sellerId: true,
                subtotal: true
              }
            },
            items: {
              include: {
                product: {
                  select: {
                    id: true,
                    title: true,
                    price: true,
                    images: true
                  }
                }
              }
            }
          }
        }
      },
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'desc' }
      ],
      skip: (page - 1) * limit,
      take: parseInt(limit)
    });

    // Calculate SLA status for each notification
    const notificationsWithSLA = notifications.map(notification => {
      const slaStatus = calculateSLAStatus(notification);
      
      // Override the SLA indicator/status with the actual order/sub-order status 
      // as per recent requirements to show current status directly
      let actualStatus = notification.order?.status || 'PENDING';
      
      // If a seller is viewing this, show the specific sub-order status
      if (notification.sellerId && !adminViewAll && notification.order?.subOrders) {
        const relevantSubOrder = notification.order.subOrders.find(s => s.sellerId === notification.sellerId);
        if (relevantSubOrder) {
          actualStatus = relevantSubOrder.status;
        }
      }

      return {
        ...notification,
        slaStatus: actualStatus,       // Used by frontend to display status string
        slaIndicator: actualStatus,    // Replacing RED/YELLOW with actual status
        timeRemaining: Math.round(slaStatus.timeRemaining * 100) / 100,
        timeElapsed: Math.round(slaStatus.timeElapsed * 100) / 100,
        isOverdue: slaStatus.isOverdue,
        urgencyLevel: slaStatus.urgencyLevel,
        config: getSLAConfig(notification.type)
      };
    });

    // Filter by SLA status if requested
    let filteredNotifications = notificationsWithSLA;
    if (slaStatus) {
      filteredNotifications = notificationsWithSLA.filter(n => n.slaStatus === slaStatus);
    }

    const totalCount = await prisma.orderNotification.count({ where });

    return reply.status(200).send({
      success: true,
      notifications: filteredNotifications,
      summary: {
        total: totalCount,
        pending: filteredNotifications.filter(n => n.status === 'PENDING').length,
        overdue: filteredNotifications.filter(n => n.isOverdue).length,
        critical: filteredNotifications.filter(n => n.slaStatus === 'CRITICAL').length
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        pages: Math.ceil(totalCount / limit)
      }
    });

  } catch (error) {
    console.error("Get notifications error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// UPDATE ORDER STATUS AND MANAGE WORKFLOW
exports.updateOrderStatus = async (request, reply) => {
  try {
    const { orderId } = request.params;
    const {
      status,
      notes,
      trackingNumber,
      estimatedDelivery,
      reason,
      statusReason
    } = request.body;
    const authenticatedUserId = request.user.userId;
    const userRole = request.user.role;
    const normalizedStatus = normalizeOrderStatus(status);

    if (!normalizedStatus) {
      return reply.status(400).send({
        success: false,
        message: `Invalid status. Allowed values: ${VALID_TARGET_STATUSES.join(', ')}`
      });
    }

    const orderWhere = {
      id: orderId,
      ...(['ADMIN', 'SUPER_ADMIN'].includes(userRole) ? {} : {
        items: {
          some: {
            product: {
              sellerId: authenticatedUserId
            }
          }
        }
      })
    };

    // Verify authorization: admin can update any order, seller only their own products' orders
    const order = await prisma.order.findFirst({
      where: orderWhere,
      include: {
        items: {
          include: {
            product: true
          }
        }
      }
    });

    if (!order) {
      return reply.status(404).send({
        success: false,
        message: "Order not found or unauthorized"
      });
    }

    const finalReason = (statusReason || reason || '').trim();
    const transitionValidation = validateStatusTransition({
      currentStatus: order.status,
      nextStatus: normalizedStatus,
      trackingNumber,
      estimatedDelivery,
      reason: finalReason
    });

    if (!transitionValidation.isValid) {
      return reply.status(400).send({
        success: false,
        message: transitionValidation.message
      });
    }

    // Update order status
    const updateData = { 
      status: normalizedStatus,
      statusReason: ['CANCELLED', 'REFUND', 'PARTIAL_REFUND'].includes(normalizedStatus)
        ? finalReason
        : null,
      updatedAt: new Date()
    };
    
    if (normalizedStatus === 'SHIPPED') {
      const normalizedTrackingNumber = normalizeTrackingNumber(trackingNumber);
      await ensureUniqueTrackingNumber({
        trackingNumber: normalizedTrackingNumber,
        excludeOrderId: orderId
      });
      updateData.trackingNumber = normalizedTrackingNumber;
      updateData.estimatedDelivery = new Date(estimatedDelivery);
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: updateData
    });

    // Complete current notifications for this order
    await prisma.orderNotification.updateMany({
      where: {
        orderId,
        ...(['ADMIN', 'SUPER_ADMIN'].includes(userRole) ? {} : { sellerId: authenticatedUserId }),
        status: 'PENDING'
      },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        notes: notes || `Order status updated to ${normalizedStatus}`
      }
    });

    // Create next workflow notification based on new status
    if (['ADMIN', 'SUPER_ADMIN'].includes(userRole)) {
      const sellerIds = [...new Set(order.items.map(item => item.product?.sellerId).filter(Boolean))];
      for (const sellerId of sellerIds) {
        await createWorkflowNotification(orderId, sellerId, normalizedStatus);
      }
    } else {
      await createWorkflowNotification(orderId, authenticatedUserId, normalizedStatus);
    }

    return reply.status(200).send({
      success: true,
      message: "Order status updated successfully",
      order: updatedOrder
    });

  } catch (error) {
    if (error.code === 'TRACKING_NUMBER_CONFLICT') {
      return reply.status(409).send({
        success: false,
        message: error.message
      });
    }
    console.error("Update order status error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// MARK NOTIFICATION AS READ/ACKNOWLEDGED
exports.acknowledgeNotification = async (request, reply) => {
  try {
    const { notificationId } = request.params;
    const authenticatedUserId = request.user.userId;
    const userRole = request.user.role;

    // Build where clause based on user role
    let whereClause = { id: notificationId };
    
    // If seller, only allow acknowledging their own notifications
    if (userRole === 'SELLER') {
      whereClause.sellerId = authenticatedUserId;
    }
    // If admin, allow acknowledging any notification (no seller restriction)

    const notification = await prisma.orderNotification.findFirst({
      where: whereClause
    });

    if (!notification) {
      return reply.status(404).send({
        success: false,
        message: "Notification not found or unauthorized"
      });
    }

    await prisma.orderNotification.update({
      where: { id: notificationId },
      data: {
        status: 'IN_PROGRESS',
        acknowledgedAt: new Date()
      }
    });

    return reply.status(200).send({
      success: true,
      message: "Notification acknowledged"
    });

  } catch (error) {
    console.error("Acknowledge notification error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// GET SLA DASHBOARD METRICS
exports.getSLADashboard = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const userRole = request.user.role;
    const { timeframe = '30', sellerId: querySellerId } = request.query; // days

    // Admin: show all unless a specific sellerId is requested
    let notificationWhere;
    if (['ADMIN', 'SUPER_ADMIN'].includes(userRole)) {
      notificationWhere = querySellerId ? { sellerId: querySellerId } : {};
    } else {
      notificationWhere = { sellerId: userId };
    }

    // ── All-time counts (not time-filtered) ────────────────────────────────
    const allNotifications = await prisma.orderNotification.findMany({
      where: notificationWhere,
      select: { id: true, status: true, slaDeadline: true, createdAt: true, type: true, completedAt: true }
    });

    const totalNotifications   = allNotifications.length;
    const pendingNotifications = allNotifications.filter(n => n.status === 'PENDING').length;
    const overdueNotifications = allNotifications.filter(n => {
      const slaStatus = calculateSLAStatus(n);
      return slaStatus.isOverdue && n.status === 'PENDING';
    }).length;

    // ── Time-windowed SLA performance breakdown ─────────────────────────────
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(timeframe));

    const windowNotifications = await prisma.orderNotification.findMany({
      where: {
        ...notificationWhere,
        createdAt: { gte: startDate }
      },
      include: {
        order: {
          select: { id: true, totalAmount: true, customerName: true }
        }
      }
    });

    const slaPerformance = {};
    const notificationsByType = {};
    windowNotifications.forEach(notification => {
      const type = notification.type;
      if (!notificationsByType[type]) notificationsByType[type] = [];
      notificationsByType[type].push(notification);
    });

    for (const [type, typeNotifications] of Object.entries(notificationsByType)) {
      const completed = typeNotifications.filter(n => n.status === 'COMPLETED');
      const onTime = completed.filter(n =>
        n.completedAt && new Date(n.completedAt) <= new Date(n.slaDeadline)
      );
      slaPerformance[type] = {
        total: typeNotifications.length,
        completed: completed.length,
        onTime: onTime.length,
        breached: completed.length - onTime.length,
        pending: typeNotifications.filter(n => n.status === 'PENDING').length,
        percentage: completed.length > 0 ?
          Math.round((onTime.length / completed.length) * 100) : 0
      };
    }

    // ── Overall SLA % (all-time) ────────────────────────────────────────────
    const totalCompleted = allNotifications.filter(n => n.status === 'COMPLETED').length;
    const totalOnTime    = allNotifications.filter(n =>
      n.status === 'COMPLETED' && n.completedAt &&
      new Date(n.completedAt) <= new Date(n.slaDeadline)
    ).length;
    const overallSLA = totalCompleted > 0 ? Math.round((totalOnTime / totalCompleted) * 100) : 0;

    // ── Urgent: pending notifications whose deadline is within 2 hours ─────
    const urgentNotifications = await prisma.orderNotification.findMany({
      where: {
        ...notificationWhere,
        status: 'PENDING',
        slaDeadline: { lte: new Date(Date.now() + 2 * 60 * 60 * 1000) }
      },
      include: {
        order: { select: { id: true, customerName: true, totalAmount: true } }
      },
      orderBy: { slaDeadline: 'asc' }
    });

    return reply.status(200).send({
      success: true,
      dashboard: {
        overallSLA,
        totalNotifications,
        pendingNotifications,
        overdueNotifications,
        criticalNotifications: allNotifications.filter(n => {
          const s = calculateSLAStatus(n);
          return n.status === 'PENDING' && (s.status === 'CRITICAL' || s.status === 'BREACHED');
        }).length,
        slaPerformance,
        urgentNotifications: urgentNotifications.map(n => ({
          ...n,
          slaStatus: calculateSLAStatus(n)
        })),
        timeframeDays: parseInt(timeframe)
      }
    });

  } catch (error) {
    console.error("Get SLA dashboard error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// HELPER FUNCTIONS
const createWorkflowNotification = async (orderId, sellerId, currentStatus) => {
  const workflowMap = {
    'PENDING': 'ORDER_CONFIRMATION',
    'CONFIRMED': 'SHIPPING_PREPARATION', 
    'PROCESSING': 'ORDER_SHIPPED',
    'SHIPPED': 'ORDER_DELIVERED'
  };
  
  const nextType = workflowMap[currentStatus];
  if (nextType) {
    await createOrderNotification(
      orderId, 
      sellerId, 
      nextType, 
      'HIGH',
      { message: `${nextType.replace('_', ' ').toLowerCase()} required` }
    );
  }
};

// Check and update SLA status for pending notifications
const checkSLAStatus = async () => {
  try {
    // Safety check for database availability
    if (!prisma) {
      console.log("Prisma not available, skipping SLA check");
      return;
    }

    const pendingNotifications = await prisma.orderNotification.findMany({
      where: { status: 'PENDING' },
      include: { order: true }
    });

    if (!pendingNotifications || pendingNotifications.length === 0) {
      console.log("No pending notifications to check");
      return;
    }

    console.log(`Checking SLA status for ${pendingNotifications.length} notifications`);

    for (const notification of pendingNotifications) {
      const slaStatus = calculateSLAStatus(notification);
      
      // Update priority if changed
      if (slaStatus.priority !== notification.priority) {
        await prisma.orderNotification.update({
          where: { id: notification.id },
          data: { priority: slaStatus.priority }
        });

        console.log(`Updated notification ${notification.id} priority to ${slaStatus.priority}`);

        // Send warning email if critical or breached
        if (slaStatus.status === 'CRITICAL' || slaStatus.status === 'BREACHED') {
          try {
            const { sendSLAWarningEmail } = require('../utils/emailService');
            await sendSLAWarningEmail(
              notification.sellerId, 
              notification.orderId, 
              notification.type,
              slaStatus
            );
            console.log(`Sent SLA warning email for notification ${notification.id}`);
          } catch (emailError) {
            console.error("SLA warning email error (non-blocking):", emailError.message);
          }
        }
      }
    }
  } catch (error) {
    console.error("SLA status check error:", error);
    
    // Don't throw the error to prevent cron job from failing
    if (error.code === 'P1001' || error.message.includes('database')) {
      console.log("Database connection issue, will retry in next scheduled run");
    }
  }
};

// BACKFILL: Create notifications for all orders that do not have one yet
const backfillOrderNotifications = async () => {
  try {
    console.log('🔄 [Backfill] Starting order notification backfill...');

    // Fetch all orders
    const orders = await prisma.order.findMany({
      select: {
        id: true,
        status: true,
        items: {
          select: {
            product: {
              select: { sellerId: true }
            }
          }
        }
      }
    });

    let created = 0;
    let skipped = 0;

    for (const order of orders) {
      // Collect unique seller IDs for this order
      const sellerIds = [...new Set(order.items.map(i => i.product?.sellerId).filter(Boolean))];

      for (const sellerId of sellerIds) {
        // Check if a notification already exists for this order+seller
        const existing = await prisma.orderNotification.findFirst({
          where: { orderId: order.id, sellerId }
        });

        if (existing) {
          skipped++;
          continue;
        }

        // Map order status to notification type
        const typeMap = {
          PENDING:    'ORDER_PROCESSING',
          CONFIRMED:  'ORDER_CONFIRMATION',
          PROCESSING: 'SHIPPING_PREPARATION',
          SHIPPED:    'ORDER_SHIPPED',
          DELIVERED:  'ORDER_DELIVERED',
          CANCELLED:  'ORDER_CANCELLED',
          REFUND:     'ORDER_CANCELLED',
          PARTIAL_REFUND: 'ORDER_CANCELLED'
        };
        const type = typeMap[order.status] || 'ORDER_PROCESSING';
        const isComplete = ['DELIVERED', 'CANCELLED', 'REFUND', 'PARTIAL_REFUND'].includes(order.status);

        await prisma.orderNotification.create({
          data: {
            orderId: order.id,
            sellerId,
            type,
            priority: 'MEDIUM',
            status: isComplete ? 'COMPLETED' : 'PENDING',
            message: `Order #${order.id.slice(-8).toUpperCase()} — Status: ${order.status}`,
            slaDeadline: calculateSLADeadline(type),
            completedAt: isComplete ? new Date() : null
          }
        });
        created++;
      }
    }

    console.log(`✅ [Backfill] Done — Created: ${created}, Skipped (already existed): ${skipped}`);
    return { created, skipped };
  } catch (error) {
    console.error('❌ [Backfill] Error:', error.message);
    throw error;
  }
};

module.exports = {
  createOrderNotification,
  getSellerNotifications: exports.getSellerNotifications,
  updateOrderStatus: exports.updateOrderStatus,
  acknowledgeNotification: exports.acknowledgeNotification,
  getSLADashboard: exports.getSLADashboard,
  checkSLAStatus,
  backfillOrderNotifications
};