const prisma = require("../config/prisma");

// Helper function to create notifications
const createNotification = async (userId, title, message, type, relatedId = null, relatedType = null, metadata = null) => {
  try {
    const notification = await prisma.notification.create({
      data: {
        userId,
        title,
        message,
        type,
        relatedId,
        relatedType,
        metadata
      }
    });
    console.log(`🔔 Notification created for user ${userId}: ${title}`);
    return notification;
  } catch (error) {
    console.error(`[Notification] Failed to create notification (type: ${type}, userId: ${userId}):`, error.message);
    return null;
  }
};

// CUSTOMER NOTIFICATIONS
const notifyCustomerOrderStatusChange = async (userId, orderId, status, orderDetails = {}) => {
  console.log(`🔔 notifyCustomerOrderStatusChange called: userId=${userId}, orderId=${orderId}, status=${status}`);
  
  const statusMessages = {
    'confirmed': 'Your order has been confirmed',
    'processing': 'Your order is being prepared',
    'shipped': 'Your order has been shipped',
    'delivered': 'Your order has been delivered',
    'cancelled': 'Your order has been cancelled',
    'refund': 'Your order has been refunded',
    'partial_refund': 'Your order has been partially refunded'
  };

  const title = `Order ${status.charAt(0).toUpperCase() + status.slice(1)}`;
  const message = statusMessages[status] || `Your order status has been updated to ${status}`;

  console.log(`🔔 Creating notification: title="${title}", message="${message}"`);

  return await createNotification(
    userId,
    title,
    message,
    'ORDER_STATUS_CHANGED',
    orderId,
    'order',
    {
      status,
      totalAmount: orderDetails.totalAmount,
      itemCount: orderDetails.itemCount,
      reason: orderDetails.reason,
      trackingNumber: orderDetails.trackingNumber,
      estimatedDelivery: orderDetails.estimatedDelivery
      // Exclude customerName from metadata to prevent exposing deleted user info
    }
  );
};

// SELLER NOTIFICATIONS
const notifySellerNewOrder = async (sellerId, orderId, orderDetails = {}) => {
  const { customerName, totalAmount, itemCount, productNames } = orderDetails;

  const productLine = productNames && productNames.length > 0
    ? ` — Products: ${productNames.join(', ')}`
    : '';

  const title = 'New Order Received!';
  const message = `You received a new order from ${customerName || 'Customer'} for ${itemCount || 1} item(s) worth $${totalAmount || '0.00'}${productLine}`;

  return await createNotification(
    sellerId,
    title,
    message,
    'NEW_ORDER',
    orderId,  
    'order',
    orderDetails
  );
};

const notifySellerProductStatusChange = async (sellerId, productId, status, productTitle, reason = null) => {
  const statusMessages = {
    'ACTIVE': `Your product "${productTitle}" is now active and visible to customers`,
    'PENDING': `Your product "${productTitle}" is pending approval`,
    'INACTIVE': `Your product "${productTitle}" has been deactivated${reason ? `. Reason: ${reason}` : ''}`,
    'REJECTED': `Your product "${productTitle}" was rejected and needs review${reason ? `. Reason: ${reason}` : ''}`
  };

  const title = `Product ${status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}`;
  const message = statusMessages[status] || `Your product "${productTitle}" status has been updated`;

  return await createNotification(
    sellerId,
    title,
    message,
    'PRODUCT_STATUS_CHANGED',
    productId,
    'product',
    { status, productTitle, reason }
  );
};

const notifySellerLowStock = async (sellerId, productId, productTitle, currentStock, threshold = 5) => {
  const title = 'Low Stock Alert!';
  const message = `Your product "${productTitle}" is running low on stock (${currentStock} remaining). Consider restocking soon.`;

  return await createNotification(
    sellerId,
    title,
    message,
    'LOW_STOCK_ALERT',
    productId,
    'product',
    { productTitle, currentStock, threshold }
  );
};

const notifySellerOrderStatusChange = async (sellerId, orderId, status, orderDetails = {}) => {
  const statusMessages = {
    confirmed:      'has been confirmed',
    processing:     'is now being processed',
    shipped:        'has been shipped',
    delivered:      'has been delivered',
    cancelled:      'has been cancelled',
    refund:         'has been refunded',
    partial_refund: 'has been partially refunded'
  };

  const title = 'Order Status Updated by Admin';
  const statusText = statusMessages[status] || `has been updated to ${status.toUpperCase()}`;
  const message = `Order ${orderId.slice(-8).toUpperCase()} ${statusText}.${
    orderDetails.reason ? ` Reason: ${orderDetails.reason}` : ''
  }${
    orderDetails.trackingNumber ? ` Tracking: ${orderDetails.trackingNumber}` : ''
  }`;

  return await createNotification(
    sellerId,
    title,
    message,
    'ORDER_STATUS_CHANGED',
    orderId,
    'order',
    {
      status,
      totalAmount: orderDetails.totalAmount,
      itemCount: orderDetails.itemCount,
      reason: orderDetails.reason,
      trackingNumber: orderDetails.trackingNumber,
      estimatedDelivery: orderDetails.estimatedDelivery
      // Exclude customerName from metadata to prevent exposing deleted user info
    }
  );
};

// SELLER APPROVAL NOTIFICATIONS
const notifySellerApproved = async (sellerId, sellerName = 'Seller') => {
  const title = '✅ Your Account Has Been Approved!';
  const message = `Congratulations ${sellerName}! Your seller account has been approved by our admin team. You can now proceed with uploading products and setting up your store.`;

  return await createNotification(
    sellerId,
    title,
    message,
    'SELLER_APPROVED',
    sellerId,
    'seller',
    { approvalType: 'account' }
  );
};

const notifySellerApprovalRejected = async (sellerId, reason = 'Not specified', sellerName = 'Seller') => {
  const title = '❌ Your Account Application Was Not Approved';
  const message = `We reviewed your seller application, but it does not meet our current requirements. Reason: ${reason}. Please review and reapply after addressing the concerns.`;

  return await createNotification(
    sellerId,
    title,
    message,
    'SELLER_REJECTED',
    sellerId,
    'seller',
    { rejectionReason: reason }
  );
};

// CULTURAL APPROVAL NOTIFICATIONS
const notifySellerCulturalApproval = async (sellerId, approved, feedback = '', sellerName = 'Seller') => {
  let title, message;

  if (approved) {
    title = '✅ Cultural Approval Granted!';
    message = `Congratulations ${sellerName}! Your cultural background and story have been approved. Your store is now eligible to go live once you upload the minimum required products (5+ products recommended, start with 1-2 SKUs).`;
  } else {
    title = '⚠️ Cultural Approval Requires Review';
    message = `Your cultural information submission requires further review. Feedback: ${feedback || 'Please review your submission and resubmit.'}`;
  }

  return await createNotification(
    sellerId,
    title,
    message,
    'CULTURAL_APPROVAL',
    sellerId,
    'seller',
    { 
      approved,
      feedback,
      approvalType: 'cultural'
    }
  );
};

// PRODUCT RECOMMENDATION NOTIFICATION
const notifySellerProductRecommendation = async (sellerId, sellerName = 'Seller') => {
  const title = '📦 Product Upload Recommendations';
  const message = `Welcome to your seller dashboard, ${sellerName}! To maximize your store's success, we recommend uploading at least 5 products. You can start with 1-2 SKUs (Stock Keeping Units) per product and expand from there. More products increase visibility and customer trust.`;

  return await createNotification(
    sellerId,
    title,
    message,
    'PRODUCT_RECOMMENDATION',
    sellerId,
    'seller',
    { 
      recommendedCount: 5,
      minimumSKU: 1,
      suggestedSKU: 2
    }
  );
};

// CATEGORY REQUEST NOTIFICATIONS
const notifySellerCategoryApproved = async (sellerId, categoryDetails = {}) => {
  const { categoryName, approvalMessage, sellerName } = categoryDetails;
  
  const title = '✅ Category Request Approved!';
  const message = `Great news, ${sellerName || 'Seller'}! Your category request "${categoryName || 'Unknown'}" has been approved by our admin team.${approvalMessage ? ` Admin message: ${approvalMessage}` : ''}`;

  return await createNotification(
    sellerId,
    title,
    message,
    'CATEGORY_APPROVED',
    categoryDetails.categoryId,
    'category',
    { approvalMessage, categoryName }
  );
};

const notifySellerCategoryRejected = async (sellerId, categoryDetails = {}) => {
  const { categoryName, rejectionMessage, sellerName } = categoryDetails;
  
  const title = '❌ Category Request Rejected';
  const message = `Your category request "${categoryName || 'Unknown'}" has been reviewed but was not approved. Reason: ${rejectionMessage || 'Not specified'}`;

  return await createNotification(
    sellerId,
    title,
    message,
    'CATEGORY_REJECTED',
    categoryDetails.categoryId,
    'category',
    { rejectionMessage, categoryName }
  );
};

const notifyAdminNewCategoryRequest = async (categoryId, categoryDetails = {}) => {
  const { categoryName, description, sellerName } = categoryDetails;
  
  const title = 'New Category Request';
  const message = `Seller ${sellerName || 'Unknown'} submitted a new category request "${categoryName || 'Untitled'}"${description ? ` — ${description}` : ''} for approval`;

  // Get all admin users
  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true }
  });

  const notifications = [];
  for (const admin of admins) {
    const notification = await createNotification(
      admin.id,
      title,
      message,
      'NEW_CATEGORY_REQUEST',
      categoryId,
      'category',
      categoryDetails
    );
    if (notification) notifications.push(notification);
  }

  return notifications;
};

const notifyAdminNewSellerApplication = async (sellerId, sellerDetails = {}) => {
  const { sellerName, email, applicationId, businessName } = sellerDetails;
  
  const title = 'New Seller Application';
  const message = `${sellerName || 'New Seller'} (${email}) has submitted a seller application${businessName ? ` for "${businessName}"` : ''} and is awaiting approval`;

  // Get all admin users
  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true }
  });

  const notifications = [];
  for (const admin of admins) {
    const notification = await createNotification(
      admin.id,
      title,
      message,
      'NEW_SELLER_APPLICATION',
      applicationId || sellerId,
      'seller',
      sellerDetails
    );
    if (notification) notifications.push(notification);
  }

  return notifications;
};

// ADMIN NOTIFICATIONS
const notifyAdminNewOrder = async (orderId, orderDetails = {}) => {
  const { customerName, sellerName, totalAmount, itemCount, productNames } = orderDetails;
  
  const productLine = productNames && productNames.length > 0
    ? ` — Products: ${productNames.join(', ')}`
    : '';

  const title = 'New Order Placed';
  const message = `New order from ${customerName || 'Customer'} to seller ${sellerName || 'Unknown'} for $${totalAmount || '0.00'} (${itemCount || 1} items)${productLine}`;

  // Get all admin users
  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true }
  });

  const notifications = [];
  for (const admin of admins) {
    const notification = await createNotification(
      admin.id,
      title,
      message,
      'NEW_ORDER',
      orderId,
      'order',
      orderDetails
    );
    if (notification) notifications.push(notification);
  }

  return notifications;
};

const notifyAdminNewProduct = async (productId, productDetails = {}) => {
  const { productTitle, sellerName } = productDetails;
  
  const title = 'New Product Submitted';
  const message = `Seller ${sellerName || 'Unknown'} submitted a new product "${productTitle || 'Untitled'}" for approval`;

  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true }
  });

  const notifications = [];
  for (const admin of admins) {
    const notification = await createNotification(
      admin.id,
      title,
      message,
      'NEW_PRODUCT_SUBMITTED',
      productId,
      'product',
      productDetails
    );
    if (notification) notifications.push(notification);
  }

  return notifications;
};

const notifyAdminProductPending = async (productId, productDetails = {}) => {
  const { productTitle, sellerName, changedFields } = productDetails;

  const changesLine = changedFields && changedFields.length > 0
    ? ` Changes made: ${changedFields.join(', ')}.`
    : '';

  const title = 'Product Pending Review';
  const message = `Seller ${sellerName || 'Unknown'} updated product "${productTitle || 'Untitled'}" — it requires your review and approval.${changesLine}`;

  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true }
  });

  const notifications = [];
  for (const admin of admins) {
    const notification = await createNotification(
      admin.id,
      title,
      message,
      'NEW_PRODUCT_SUBMITTED',
      productId,
      'product',
      productDetails
    );
    if (notification) notifications.push(notification);
  }

  return notifications;
};

const notifyAdminLowStockDeactivation = async (productId, productDetails = {}) => {
  const { productTitle, sellerName, stock } = productDetails;

  const title = 'Product Auto-Deactivated — Low Stock';
  const message = `Product "${productTitle || 'Untitled'}" from seller ${sellerName || 'Unknown'} has been automatically deactivated because stock dropped to ${stock} (threshold: ≤ 2).`;

  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true }
  });

  const notifications = [];
  for (const admin of admins) {
    const notification = await createNotification(
      admin.id,
      title,
      message,
      'PRODUCT_LOW_STOCK_DEACTIVATED',
      productId,
      'product',
      productDetails
    );
    if (notification) notifications.push(notification);
  }

  return notifications;
};

// ADMIN NOTIFICATION FOR ORDER STATUS CHANGES
const notifyAdminOrderStatusChange = async (orderId, status, orderDetails = {}) => {
  const { customerName, sellerName, totalAmount, itemCount } = orderDetails;
  
  const title = 'Order Status Updated';
  const message = `Order from ${customerName || 'Customer'} to seller ${sellerName || 'Unknown'} for $${totalAmount || '0.00'} has been updated to ${status}`;

  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true }
  });

  const notifications = [];
  for (const admin of admins) {
    const notification = await createNotification(
      admin.id,
      title,
      message,
      'ORDER_STATUS_CHANGED',
      orderId,
      'order',
      {
        status,
        sellerName: orderDetails.sellerName,
        totalAmount: orderDetails.totalAmount,
        itemCount: orderDetails.itemCount,
        reason: orderDetails.reason,
        trackingNumber: orderDetails.trackingNumber,
        estimatedDelivery: orderDetails.estimatedDelivery,
        updatedBy: orderDetails.updatedBy
        // Exclude customerName from metadata to prevent exposing deleted user info
      }
    );
    if (notification) notifications.push(notification);
  }

  return notifications;
};

// ── Bank Details Change Request Notifications ─────────────────────────────────

// Triggered when a seller submits a bank change request.
// All ADMIN users get an in-app notification only.
// All SUPER_ADMIN users get an in-app notification + email.
const notifyBankChangeRequested = async (requestId, details = {}) => {
  const { sellerName, storeName, newBankDetails } = details;

  const title = '🏦 Bank Details Change Request';
  const message = `Seller ${sellerName || 'Unknown'} (${storeName || ''}) has submitted a bank details change request and is awaiting review`;

  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true, role: true, email: true, name: true }
  });

  const { sendSuperAdminBankChangeRequestEmail } = require('../utils/emailService');

  const notifications = [];
  for (const admin of admins) {
    const notification = await createNotification(
      admin.id,
      title,
      message,
      'BANK_CHANGE_REQUESTED',
      requestId,
      'bank_change_request',
      { sellerName, storeName, newBankDetails }
    );
    if (notification) notifications.push(notification);

    // Email only for SUPER_ADMIN
    if (admin.role === 'SUPER_ADMIN') {
      sendSuperAdminBankChangeRequestEmail(admin.email, admin.name, {
        sellerName,
        storeName,
        requestId,
        newBankDetails
      }).catch(err => console.error('Bank change request email error (non-blocking):', err.message));
    }
  }

  return notifications;
};

// Triggered when an admin approves a bank change request.
// The seller gets an in-app notification + email.
const notifySellerBankChangeApproved = async (sellerId, requestId, details = {}) => {
  const { sellerName, sellerEmail, newBankDetails } = details;

  const title = '✅ Bank Details Change Approved';
  const message = 'Your bank details change request has been approved. Your new bank details are now active.';

  const notification = await createNotification(
    sellerId,
    title,
    message,
    'BANK_CHANGE_APPROVED',
    requestId,
    'bank_change_request',
    { newBankDetails }
  );

  if (sellerEmail) {
    const { sendSellerBankChangeApprovedEmail } = require('../utils/emailService');
    sendSellerBankChangeApprovedEmail(sellerEmail, sellerName || 'Seller', {
      requestId,
      newBankDetails
    }).catch(err => console.error('Bank change approved email error (non-blocking):', err.message));
  }

  return notification;
};

// Triggered when an admin rejects a bank change request.
// The seller gets an in-app notification + email.
const notifySellerBankChangeRejected = async (sellerId, requestId, details = {}) => {
  const { sellerName, sellerEmail, reviewNote } = details;

  const title = '❌ Bank Details Change Request Not Approved';
  const message = reviewNote
    ? `Your bank details change request was not approved. Reason: ${reviewNote}`
    : 'Your bank details change request was not approved. Your existing bank details remain unchanged.';

  const notification = await createNotification(
    sellerId,
    title,
    message,
    'BANK_CHANGE_REJECTED',
    requestId,
    'bank_change_request',
    { reviewNote }
  );

  if (sellerEmail) {
    const { sendSellerBankChangeRejectedEmail } = require('../utils/emailService');
    sendSellerBankChangeRejectedEmail(sellerEmail, sellerName || 'Seller', {
      requestId,
      reviewNote
    }).catch(err => console.error('Bank change rejected email error (non-blocking):', err.message));
  }

  return notification;
};

// GENERAL NOTIFICATION APIs

// Get notifications for user
exports.getNotifications = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { page = 1, limit = 20, unreadOnly = false } = request.query;
    
    const whereClause = { userId };
    if (unreadOnly === 'true') {
      whereClause.isRead = false;
    }

    const notifications = await prisma.notification.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: parseInt(limit)
    });

    const [unreadCount, totalCount] = await Promise.all([
      prisma.notification.count({ where: { userId, isRead: false } }),
      prisma.notification.count({ where: whereClause })
    ]);

    return reply.status(200).send({
      success: true,
      notifications,
      unreadCount,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount
      }
    });

  } catch (error) {
    console.error("Get notifications error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// Mark notification as read
exports.markAsRead = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { notificationId } = request.params;

    await prisma.notification.update({
      where: { 
        id: notificationId,
        userId // Ensure user owns the notification
      },
      data: { isRead: true }
    });

    return reply.status(200).send({
      success: true,
      message: "Notification marked as read"
    });

  } catch (error) {
    console.error("Mark as read error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// Mark all notifications as read
exports.markAllAsRead = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const result = await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true }
    });

    return reply.status(200).send({
      success: true,
      message: `Marked ${result.count} notifications as read`
    });

  } catch (error) {
    console.error("Mark all as read error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// Delete notification
exports.deleteNotification = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { notificationId } = request.params;

    await prisma.notification.delete({
      where: { 
        id: notificationId,
        userId
      }
    });

    return reply.status(200).send({
      success: true,
      message: "Notification deleted"
    });

  } catch (error) {
    console.error("Delete notification error:", error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// Sent to all admins when a seller submits a product for review (to be activated).
// productDetails: { productTitle, sellerName, reviewNote }
const notifyAdminProductSubmitReview = async (productId, productDetails = {}) => {
  const { productTitle, sellerName, reviewNote } = productDetails;

  const noteText = reviewNote ? ` Seller's note: "${reviewNote}".` : '';
  const title = 'Product Submitted for Review';
  const message = `Seller ${sellerName || 'Unknown'} has submitted product "${productTitle || 'Untitled'}" for review and activation.${noteText}`;

  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true }
  });

  const notifications = [];
  for (const admin of admins) {
    const notification = await createNotification(
      admin.id,
      title,
      message,
      'NEW_PRODUCT_SUBMITTED',
      productId,
      'product',
      productDetails
    );
    if (notification) notifications.push(notification);
  }

  return notifications;
};

// Sent to all admins when a seller deactivates their own product (with reason).
// productDetails: { productTitle, sellerName, inactiveReason }
const notifyAdminProductSellerDeactivated = async (productId, productDetails = {}) => {
  const { productTitle, sellerName, inactiveReason } = productDetails;

  const reasonText = inactiveReason ? ` Reason: "${inactiveReason}".` : '';
  const title = 'Product Deactivated by Seller';
  const message = `Seller ${sellerName || 'Unknown'} has deactivated product "${productTitle || 'Untitled'}".${reasonText}`;

  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true }
  });

  const notifications = [];
  for (const admin of admins) {
    const notification = await createNotification(
      admin.id,
      title,
      message,
      'GENERAL',
      productId,
      'product',
      productDetails
    );
    if (notification) notifications.push(notification);
  }

  return notifications;
};

// ── Variant Status Change Notifications ──────────────────────────────────────

// Sent to all admins when ANY user (seller or admin) toggles a variant's status.
// details: { productTitle, variantSku, variantAttributes, changedBy, changedByRole }
const notifyAdminVariantStatusChange = async (productId, variantId, isActive, details = {}) => {
  const { productTitle, variantSku, variantAttributes, changedBy, changedByRole } = details;

  const action = isActive ? 'activated' : 'deactivated';
  const attrText = variantAttributes ? ` (${variantAttributes})` : '';
  const actor = (changedByRole === 'ADMIN' || changedByRole === 'SUPER_ADMIN')
    ? `Admin ${changedBy || ''}`.trim()
    : `Seller ${changedBy || 'Unknown'}`;

  const title = `Variant ${isActive ? 'Activated' : 'Deactivated'}`;
  const message = `${actor} has ${action} variant SKU "${variantSku || variantId}"${attrText} of product "${productTitle || 'Unknown'}".`;

  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true }
  });

  const notifications = [];
  for (const admin of admins) {
    const notification = await createNotification(
      admin.id,
      title,
      message,
      'PRODUCT_STATUS_CHANGED',
      productId,
      'product',
      { variantId, variantSku, variantAttributes, isActive, changedBy, changedByRole, productTitle }
    );
    if (notification) notifications.push(notification);
  }

  return notifications;
};

// Sent to the seller when an admin toggles one of their variant's status.
// details: { productTitle, variantSku, variantAttributes }
const notifySellerVariantStatusChange = async (sellerId, productId, variantId, isActive, details = {}) => {
  const { productTitle, variantSku, variantAttributes } = details;

  const action = isActive ? 'activated' : 'deactivated';
  const attrText = variantAttributes ? ` (${variantAttributes})` : '';

  const title = `Product Variant ${isActive ? 'Activated' : 'Deactivated'}`;
  const message = `Your variant SKU "${variantSku || variantId}"${attrText} of product "${productTitle || 'Unknown'}" has been ${action} by an admin.`;

  return await createNotification(
    sellerId,
    title,
    message,
    'PRODUCT_STATUS_CHANGED',
    productId,
    'product',
    { variantId, variantSku, variantAttributes, isActive, productTitle }
  );
};

// Export helper functions for use in other controllers
module.exports = {
  ...module.exports,
  createNotification,
  notifyCustomerOrderStatusChange,
  notifySellerNewOrder,
  notifySellerProductStatusChange,
  notifySellerLowStock,
  notifySellerOrderStatusChange,
  notifySellerApproved,
  notifySellerApprovalRejected,
  notifySellerCulturalApproval,
  notifySellerProductRecommendation,
  notifySellerCategoryApproved,
  notifySellerCategoryRejected,
  notifyAdminNewCategoryRequest,
  notifyAdminNewSellerApplication,
  notifyAdminNewOrder,
  notifyAdminNewProduct,
  notifyAdminProductPending,
  notifyAdminOrderStatusChange,
  notifyAdminLowStockDeactivation,
  notifyAdminProductSubmitReview,
  notifyAdminProductSellerDeactivated,
  notifyBankChangeRequested,
  notifySellerBankChangeApproved,
  notifySellerBankChangeRejected,
  notifyAdminVariantStatusChange,
  notifySellerVariantStatusChange
};