const prisma = require("../config/prisma");
const { randomUUID } = require("crypto");
const auditLogger = require("../utils/auditLogger");
const { log: auditLog, extractRequestMeta, AUDIT_ACTIONS, ENTITY_TYPES } = auditLogger;
const { notifyAdminNewCategoryRequest, notifySellerCategoryApproved, notifySellerCategoryRejected } = require("./notification");
const { sendSuperAdminCategoryRequestEmail, sendSellerCategoryApprovedEmail, sendSellerCategoryRejectedEmail } = require("../utils/emailService");

// ==================== GET ALL CATEGORIES ====================

// GET ALL CATEGORIES (Shows approved + active categories. Pending/rejected shown for admin.)
exports.getAllCategories = async (request, reply) => {
  try {
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(request.user.role);

    const products = await prisma.product.findMany({
      select: { category: true, sellerId: true }
    });

    // Group categories from products
    const categoryMap = new Map();
    const sellerCategoryMap = new Map();

    products.forEach(product => {
      const trimmedCategory = product.category?.trim();
      if (trimmedCategory) {
        if (categoryMap.has(trimmedCategory)) {
          categoryMap.set(trimmedCategory, categoryMap.get(trimmedCategory) + 1);
        } else {
          categoryMap.set(trimmedCategory, 1);
        }
        if (!isAdmin && product.sellerId === request.user?.userId) {
          const key = trimmedCategory;
          sellerCategoryMap.set(key, (sellerCategoryMap.get(key) || 0) + 1);
        }
      }
    });

    // Get approved, active (not soft-deleted) categories from category_requests
    let approvedCategoryRequests = [];
    try {
      approvedCategoryRequests = await prisma.$queryRaw`
        SELECT cr."id", cr."categoryName", cr."description",
               cr."requestedBy", cr."approvalMessage", cr."approvedAt",
               u."role" as requester_role
        FROM "category_requests" cr
        LEFT JOIN "users" u ON cr."requestedBy" = u."id"
        WHERE cr."status" = 'APPROVED'
          AND cr."softDeletedAt" IS NULL
      `;
    } catch (error) {
      console.warn('Could not fetch approved categories from requests:', error.message);
    }

    // Merge categories from products and approved requests
    approvedCategoryRequests.forEach(cat => {
      if (!categoryMap.has(cat.categoryName)) {
        categoryMap.set(cat.categoryName, {
          id: cat.id,
          productCount: 0,
          requestedBy: cat.requestedBy,
          requesterRole: cat.requester_role,
          approvalMessage: cat.approvalMessage,
          approvedAt: cat.approvedAt,
        });
      } else {
        const existing = categoryMap.get(cat.categoryName);
        if (typeof existing === 'number') {
          categoryMap.set(cat.categoryName, {
            id: cat.id,
            productCount: existing,
            requestedBy: cat.requestedBy,
            requesterRole: cat.requester_role,
          });
        }
      }
    });

    const approvedCategories = Array.from(categoryMap.entries())
      .filter(([, data]) => typeof data !== 'number')
      .map(([name, data]) => ({
        id: data.id,
        categoryName: name,
        ...(isAdmin && { totalProductCount: data.productCount || 0 }),
        ...(!isAdmin && { myProductCount: sellerCategoryMap.get(name) || 0 }),
        requestedBySeller: data.requesterRole === 'SELLER',
        requestedByMe: !isAdmin && data.requestedBy === request.user?.userId,
        ...(isAdmin && data.approvalMessage && { approvalMessage: data.approvalMessage }),
        ...(isAdmin && data.approvedAt && { approvedAt: data.approvedAt })
      }))
      .sort((a, b) => {
        if (isAdmin) return (b.totalProductCount || 0) - (a.totalProductCount || 0);
        if (a.requestedByMe && !b.requestedByMe) return -1;
        if (!a.requestedByMe && b.requestedByMe) return 1;
        return a.categoryName.localeCompare(b.categoryName);
      });

    let pendingRequests = [];
    let rejectedRequests = [];
    let myPendingRequests = [];
    let myRejectedRequests = [];

    try {
      if (isAdmin) {
        pendingRequests = await prisma.$queryRaw`
          SELECT cr."id", cr."categoryName", cr."description",
                 cr."requestedAt", cr."requestedBy",
                 u."id" as seller_id, u."email", u."name" as seller_name,
                 sp."storeName", sp."businessName", sp."status" as seller_status
          FROM "category_requests" cr
          LEFT JOIN "users" u ON cr."requestedBy" = u."id"
          LEFT JOIN "seller_profiles" sp ON u."id" = sp."userId"
          WHERE cr."status" = 'PENDING'
            AND cr."softDeletedAt" IS NULL
          ORDER BY cr."requestedAt" DESC
        `;

        rejectedRequests = await prisma.$queryRaw`
          SELECT cr."id", cr."categoryName", cr."rejectionMessage",
                 cr."rejectedAt", cr."rejectedBy",
                 u."id" as seller_id, u."email", u."name" as seller_name,
                 sp."storeName", sp."businessName"
          FROM "category_requests" cr
          LEFT JOIN "users" u ON cr."requestedBy" = u."id"
          LEFT JOIN "seller_profiles" sp ON u."id" = sp."userId"
          WHERE cr."status" = 'REJECTED'
            AND cr."softDeletedAt" IS NULL
          ORDER BY cr."rejectedAt" DESC
        `;
      } else {
        myPendingRequests = await prisma.$queryRaw`
          SELECT "id", "categoryName", "description",
                 "requestedAt", "status"
          FROM "category_requests"
          WHERE "requestedBy" = ${request.user?.userId}
            AND "status" = 'PENDING'
            AND "softDeletedAt" IS NULL
          ORDER BY "requestedAt" DESC
        `;

        myRejectedRequests = await prisma.$queryRaw`
          SELECT "id", "categoryName", "rejectionMessage",
                 "rejectedAt", "status"
          FROM "category_requests"
          WHERE "requestedBy" = ${request.user?.userId}
            AND "status" = 'REJECTED'
            AND "softDeletedAt" IS NULL
          ORDER BY "rejectedAt" DESC
        `;
      }
    } catch (tableError) {
      console.warn('CategoryRequest table not yet created:', tableError.message);
    }

    const totalProducts = await prisma.product.count();
    const totalCategories = approvedCategories.length;

    let myTotalProducts = 0;
    if (!isAdmin) {
      myTotalProducts = products.filter(p => p.sellerId === request.user?.userId).length;
    }

    if (isAdmin) {
      reply.send({
        success: true,
        data: {
          approvedCategories,
          totalApproved: approvedCategories.length,
          totalProducts,
          totalCategories,
          pendingRequests,
          rejectedRequests,
          totalPending: pendingRequests.length,
          totalRejected: rejectedRequests.length
        }
      });
    } else {
      reply.send({
        success: true,
        data: {
          approvedCategories,
          totalCategories,
          myTotalProducts,
          myPendingRequests,
          totalMyPending: myPendingRequests.length,
          myRejectedRequests: myRejectedRequests.map(req => ({
            id: req.id,
            categoryName: req.categoryName,
            rejectionMessage: req.rejectionMessage,
            rejectedAt: req.rejectedAt,
            status: req.status
          })),
          totalMyRejected: myRejectedRequests.length
        }
      });
    }
  } catch (error) {
    console.error('Get all categories error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== CREATE CATEGORIES DIRECTLY (Admin Only) ====================

exports.createCategoryDirect = async (request, reply) => {
  try {
    const { categories } = request.body;

    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return reply.status(400).send({ success: false, message: 'Please provide an array of category names' });
    }

    const invalidCategories = categories.filter(cat => !cat || typeof cat !== 'string' || cat.trim() === '');
    if (invalidCategories.length > 0) {
      return reply.status(400).send({ success: false, message: 'All category names must be non-empty strings' });
    }

    const trimmedCategories = [...new Set(categories.map(c => c.trim()))];

    const existingProducts = await prisma.product.findMany({ select: { category: true }, distinct: ['category'] });
    const existingCategories = existingProducts.map(p => p.category?.trim()).filter(c => c);

    let existingRequests = [];
    try {
      existingRequests = await prisma.$queryRaw`
        SELECT "categoryName" FROM "category_requests"
        WHERE "status" IN ('APPROVED', 'PENDING')
      `;
    } catch (error) {
      console.warn('Could not fetch existing requests:', error.message);
    }

    const existingRequestNames = existingRequests.map(r => r.categoryName?.trim());
    const newCategories = trimmedCategories.filter(
      cat => !existingCategories.includes(cat) && !existingRequestNames.includes(cat)
    );

    if (newCategories.length === 0) {
      return reply.status(400).send({ success: false, message: 'All provided categories already exist' });
    }

    const meta = extractRequestMeta(request);
    const createdCategories = [];

    for (const categoryName of newCategories) {
      const newId = randomUUID();
      try {
        await prisma.$executeRaw`
          INSERT INTO "category_requests" (
            "id", "categoryName", "description",
            "requestedBy", "status", "approvedBy", "approvedAt", "requestedAt", "updatedAt"
          ) VALUES (
            ${newId}, ${categoryName}, NULL,
            NULL, 'APPROVED', ${request.user?.userId}, NOW(), NOW(), NOW()
          )
        `;

        const newSnapshot = {
          id: newId, categoryName, status: 'APPROVED',
          approvedBy: request.user?.userId, approvedAt: new Date(), requestedBy: null
        };

        await auditLog({
          entityType: ENTITY_TYPES.CATEGORY,
          entityId:   newId,
          action:     AUDIT_ACTIONS.CATEGORY_CREATED,
          ...meta,
          newData:    newSnapshot,
          reason:     `Admin created category "${categoryName}" directly`,
        });

        createdCategories.push({ categoryName, status: 'APPROVED', createdBy: request.user?.userId, createdAt: new Date() });
      } catch (error) {
        console.error(`Error creating category ${categoryName}:`, error.message);
      }
    }

    reply.status(201).send({
      success: true,
      message: `${createdCategories.length} categor${createdCategories.length === 1 ? 'y' : 'ies'} created successfully`,
      data: {
        created: createdCategories,
        totalCreated: createdCategories.length,
        skipped: trimmedCategories.length - createdCategories.length,
        skippedCategories: trimmedCategories.filter(cat => !newCategories.includes(cat))
      }
    });
  } catch (error) {
    console.error('Create category error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== REQUEST A NEW CATEGORY ====================

exports.requestCategory = async (request, reply) => {
  try {
    const { categoryName, description } = request.body;

    if (!categoryName || categoryName.trim() === '') {
      return reply.status(400).send({ success: false, message: 'Category name is required' });
    }

    const existingCategory = await prisma.$queryRaw`
      SELECT id FROM "category_requests"
      WHERE LOWER("categoryName") = LOWER(${categoryName.trim()})
        AND "status" IN ('APPROVED', 'PENDING')
      LIMIT 1
    `;

    if (existingCategory && existingCategory.length > 0) {
      return reply.status(400).send({
        success: false,
        message: `Category "${categoryName}" already exists or is pending approval`
      });
    }

    const newId = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "category_requests" (
        "id", "categoryName", "description",
        "requestedBy", "status", "requestedAt", "updatedAt"
      ) VALUES (
        ${newId}, ${categoryName.trim()},
        ${description || null},
        ${request.user?.userId || null}, 'PENDING',
        NOW(), NOW()
      )
    `;

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType: ENTITY_TYPES.CATEGORY,
      entityId:   newId,
      action:     AUDIT_ACTIONS.CATEGORY_REQUESTED,
      ...meta,
      newData: {
        id: newId, categoryName: categoryName.trim(),
        description: description || null,
        status: 'PENDING', requestedBy: request.user?.userId || null
      },
      reason: `Category "${categoryName.trim()}" submitted for approval`,
    });

    // Get seller information for notifications
    const seller = await prisma.user.findUnique({
      where: { id: request.user?.userId },
      select: { name: true, email: true }
    });

    // Send notifications to all admins (admin + super admin)
    const categoryDetails = {
      categoryName: categoryName.trim(),
      description: description || null,
      sellerName: seller?.name || 'Unknown Seller'
    };
    
    try {
      await notifyAdminNewCategoryRequest(newId, categoryDetails);
      console.log(`🔔 Notifications sent to admins for category request: ${categoryName.trim()}`);
    } catch (notificationError) {
      console.error('Failed to send notifications to admins:', notificationError);
    }

    // Send emails only to super admins
    try {
      const superAdmins = await prisma.user.findMany({
        where: { role: 'SUPER_ADMIN' },
        select: { email: true, name: true }
      });

      for (const admin of superAdmins) {
        if (admin.email) {
          await sendSuperAdminCategoryRequestEmail(admin.email, admin.name, {
            categoryName: categoryName.trim(),
            description: description || null,
            sellerName: seller?.name || 'Unknown Seller',
            categoryId: newId
          });
        }
      }
      console.log(`📧 Emails sent to ${superAdmins.length} super admins for category request: ${categoryName.trim()}`);
    } catch (emailError) {
      console.error('Failed to send emails to super admins:', emailError);
    }

    reply.status(201).send({
      success: true,
      message: 'Category request submitted successfully',
      data: {
        id: newId,
        categoryName: categoryName.trim(),
        description: description || null,
        status: 'PENDING'
      }
    });
  } catch (error) {
    console.error('Request category error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== APPROVE CATEGORY REQUEST ====================

exports.approveCategory = async (request, reply) => {
  try {
    const { id } = request.params;
    const { approvalMessage } = request.body;

    const categoryRequest = await prisma.$queryRaw`
      SELECT * FROM "category_requests" WHERE "id" = ${id}
    `;

    if (!categoryRequest || categoryRequest.length === 0) {
      return reply.status(404).send({ success: false, message: 'Category request not found' });
    }

    const category = categoryRequest[0];
    if (category.status !== 'PENDING') {
      return reply.status(400).send({ success: false, message: `Cannot approve a ${category.status.toLowerCase()} request` });
    }

    await prisma.$executeRaw`
      UPDATE "category_requests"
      SET "status" = 'APPROVED',
          "approvedBy" = ${request.user?.userId},
          "approvalMessage" = ${approvalMessage || null},
          "approvedAt" = NOW(),
          "updatedAt" = NOW()
      WHERE "id" = ${id}
    `;

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType:   ENTITY_TYPES.CATEGORY,
      entityId:     id,
      action:       AUDIT_ACTIONS.CATEGORY_APPROVED,
      ...meta,
      previousData: category,
      newData:      { ...category, status: 'APPROVED', approvedBy: request.user?.userId, approvalMessage: approvalMessage || null, approvedAt: new Date() },
      reason:       approvalMessage || null,
    });

    // Get seller information for notifications
    const seller = await prisma.user.findUnique({
      where: { id: category.requestedBy },
      select: { name: true, email: true }
    });

    // Send notification to seller
    if (seller && category.requestedBy) {
      try {
        await notifySellerCategoryApproved(category.requestedBy, {
          categoryName: category.categoryName,
          approvalMessage: approvalMessage || null,
          sellerName: seller.name,
          categoryId: id
        });
        console.log(`🔔 Approval notification sent to seller for category: ${category.categoryName}`);
      } catch (notificationError) {
        console.error('Failed to send approval notification to seller:', notificationError);
      }

      // Send email to seller
      if (seller.email) {
        try {
          await sendSellerCategoryApprovedEmail(seller.email, seller.name, {
            categoryName: category.categoryName,
            approvalMessage: approvalMessage || null,
            categoryId: id
          });
          console.log(`📧 Approval email sent to seller for category: ${category.categoryName}`);
        } catch (emailError) {
          console.error('Failed to send approval email to seller:', emailError);
        }
      }
    }

    reply.send({
      success: true,
      message: 'Category approved successfully',
      data: { id, categoryName: category.categoryName, status: 'APPROVED', approvalMessage: approvalMessage || null }
    });
  } catch (error) {
    console.error('Approve category error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== REJECT CATEGORY REQUEST ====================

exports.rejectCategory = async (request, reply) => {
  try {
    const { id } = request.params;
    const { rejectionMessage } = request.body;

    if (!rejectionMessage || rejectionMessage.trim() === '') {
      return reply.status(400).send({ success: false, message: 'Rejection message is required' });
    }

    const categoryRequest = await prisma.$queryRaw`
      SELECT * FROM "category_requests" WHERE "id" = ${id}
    `;

    if (!categoryRequest || categoryRequest.length === 0) {
      return reply.status(404).send({ success: false, message: 'Category request not found' });
    }

    const category = categoryRequest[0];
    if (category.status !== 'PENDING') {
      return reply.status(400).send({ success: false, message: `Cannot reject a ${category.status.toLowerCase()} request` });
    }

    await prisma.$executeRaw`
      UPDATE "category_requests"
      SET "status" = 'REJECTED',
          "rejectedBy" = ${request.user?.userId},
          "rejectionMessage" = ${rejectionMessage.trim()},
          "rejectedAt" = NOW(),
          "updatedAt" = NOW()
      WHERE "id" = ${id}
    `;

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType:   ENTITY_TYPES.CATEGORY,
      entityId:     id,
      action:       AUDIT_ACTIONS.CATEGORY_REJECTED,
      ...meta,
      previousData: category,
      newData:      { ...category, status: 'REJECTED', rejectedBy: request.user?.userId, rejectionMessage: rejectionMessage.trim(), rejectedAt: new Date() },
      reason:       rejectionMessage.trim(),
    });

    // Get seller information for notifications
    const seller = await prisma.user.findUnique({
      where: { id: category.requestedBy },
      select: { name: true, email: true }
    });

    // Send notification to seller
    if (seller && category.requestedBy) {
      try {
        await notifySellerCategoryRejected(category.requestedBy, {
          categoryName: category.categoryName,
          rejectionMessage: rejectionMessage.trim(),
          sellerName: seller.name,
          categoryId: id
        });
        console.log(`🔔 Rejection notification sent to seller for category: ${category.categoryName}`);
      } catch (notificationError) {
        console.error('Failed to send rejection notification to seller:', notificationError);
      }

      // Send email to seller
      if (seller.email) {
        try {
          await sendSellerCategoryRejectedEmail(seller.email, seller.name, {
            categoryName: category.categoryName,
            rejectionMessage: rejectionMessage.trim(),
            categoryId: id
          });
          console.log(`📧 Rejection email sent to seller for category: ${category.categoryName}`);
        } catch (emailError) {
          console.error('Failed to send rejection email to seller:', emailError);
        }
      }
    }

    reply.send({
      success: true,
      message: 'Category request rejected successfully',
      data: { id, categoryName: category.categoryName, status: 'REJECTED', rejectionMessage: rejectionMessage.trim() }
    });
  } catch (error) {
    console.error('Reject category error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== EDIT CATEGORY (Admin — edits an approved category) ====================

exports.editCategory = async (request, reply) => {
  try {
    const { id } = request.params;
    const { categoryName, description } = request.body;

    if (!categoryName || categoryName.trim() === '') {
      return reply.status(400).send({ success: false, message: 'Category name is required' });
    }

    const categoryRequest = await prisma.$queryRaw`
      SELECT * FROM "category_requests" WHERE "id" = ${id}
    `;

    if (!categoryRequest || categoryRequest.length === 0) {
      return reply.status(404).send({ success: false, message: 'Category not found' });
    }

    const category = categoryRequest[0];

    if (category.softDeletedAt) {
      return reply.status(400).send({ success: false, message: 'Cannot edit a soft-deleted category. Restore it first.' });
    }

    if (category.status !== 'APPROVED') {
      return reply.status(400).send({ success: false, message: 'Only approved categories can be directly edited by admin. Use approve/reject for pending requests.' });
    }

    // Check for name conflict with another category
    if (categoryName.trim().toLowerCase() !== category.categoryName.toLowerCase()) {
      const conflict = await prisma.$queryRaw`
        SELECT id FROM "category_requests"
        WHERE LOWER("categoryName") = LOWER(${categoryName.trim()})
          AND "id" != ${id}
          AND "status" IN ('APPROVED', 'PENDING')
        LIMIT 1
      `;
      if (conflict && conflict.length > 0) {
        return reply.status(400).send({ success: false, message: `Category name "${categoryName.trim()}" is already in use` });
      }
    }

    await prisma.$executeRaw`
      UPDATE "category_requests"
      SET "categoryName" = ${categoryName.trim()},
          "description"  = ${description ?? category.description},
          "updatedAt"    = NOW()
      WHERE "id" = ${id}
    `;

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType:   ENTITY_TYPES.CATEGORY,
      entityId:     id,
      action:       AUDIT_ACTIONS.CATEGORY_EDITED,
      ...meta,
      previousData: category,
      newData: {
        ...category,
        categoryName:  categoryName.trim(),
        description:   description ?? category.description,
        updatedAt:     new Date()
      },
      reason: `Admin edited category`,
    });

    reply.send({
      success: true,
      message: 'Category updated successfully',
      data: {
        id,
        categoryName: categoryName.trim(),
        description:   description ?? category.description,
        status: category.status
      }
    });
  } catch (error) {
    console.error('Edit category error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== RESUBMIT CATEGORY (Seller re-edits a REJECTED request) ====================

exports.resubmitCategory = async (request, reply) => {
  try {
    const { id } = request.params;
    const { categoryName, description } = request.body;

    if (!categoryName || categoryName.trim() === '') {
      return reply.status(400).send({ success: false, message: 'Category name is required' });
    }

    const categoryRequest = await prisma.$queryRaw`
      SELECT * FROM "category_requests" WHERE "id" = ${id}
    `;

    if (!categoryRequest || categoryRequest.length === 0) {
      return reply.status(404).send({ success: false, message: 'Category request not found' });
    }

    const category = categoryRequest[0];

    // Only the original requester (or admin) can resubmit
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(request.user.role);
    if (!isAdmin && category.requestedBy !== request.user.userId) {
      return reply.status(403).send({ success: false, message: 'You can only resubmit your own category requests' });
    }

    if (category.status !== 'REJECTED') {
      return reply.status(400).send({ success: false, message: 'Only rejected requests can be resubmitted' });
    }

    if (category.softDeletedAt) {
      return reply.status(400).send({ success: false, message: 'Cannot resubmit a soft-deleted category request' });
    }

    // Name conflict check (excluding self)
    if (categoryName.trim().toLowerCase() !== category.categoryName.toLowerCase()) {
      const conflict = await prisma.$queryRaw`
        SELECT id FROM "category_requests"
        WHERE LOWER("categoryName") = LOWER(${categoryName.trim()})
          AND "id" != ${id}
          AND "status" IN ('APPROVED', 'PENDING')
        LIMIT 1
      `;
      if (conflict && conflict.length > 0) {
        return reply.status(400).send({ success: false, message: `Category name "${categoryName.trim()}" is already in use` });
      }
    }

    await prisma.$executeRaw`
      UPDATE "category_requests"
      SET "status"        = 'PENDING',
          "categoryName"  = ${categoryName.trim()},
          "description"   = ${description ?? category.description},
          "rejectionMessage" = NULL,
          "rejectedBy"    = NULL,
          "rejectedAt"    = NULL,
          "requestedAt"   = NOW(),
          "updatedAt"     = NOW()
      WHERE "id" = ${id}
    `;

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType:   ENTITY_TYPES.CATEGORY,
      entityId:     id,
      action:       AUDIT_ACTIONS.CATEGORY_RESUBMITTED,
      ...meta,
      previousData: category,
      newData: {
        ...category,
        status:        'PENDING',
        categoryName:  categoryName.trim(),
        description:   description ?? category.description,
        rejectionMessage: null, rejectedBy: null, rejectedAt: null,
        requestedAt:   new Date(), updatedAt: new Date()
      },
      reason: `Category request re-edited and resubmitted for approval`,
    });

    // GET SELLER INFORMATION FOR NOTIFICATIONS
    const seller = await prisma.user.findUnique({
      where: { id: category.requestedBy },
      select: { name: true, email: true }
    });

    // Send notifications to all admins (admin + super admin)
    const categoryDetails = {
      categoryName: categoryName.trim(),
      description: description ?? category.description,
      sellerName: seller?.name || 'Unknown Seller'
    };
    
    try {
      await notifyAdminNewCategoryRequest(id, categoryDetails);
      console.log(`🔔 Resubmit notifications sent to admins for category: ${categoryName.trim()}`);
    } catch (notificationError) {
      console.error('Failed to send resubmit notifications to admins:', notificationError);
    }

    // Send emails only to super admins
    try {
      const superAdmins = await prisma.user.findMany({
        where: { role: 'SUPER_ADMIN' },
        select: { email: true, name: true }
      });

      for (const admin of superAdmins) {
        if (admin.email) {
          await sendSuperAdminCategoryRequestEmail(admin.email, admin.name, {
            categoryName: categoryName.trim(),
            description: description ?? category.description,
            sellerName: seller?.name || 'Unknown Seller',
            categoryId: id
          });
        }
      }
      console.log(`📧 Resubmit emails sent to ${superAdmins.length} super admins for category: ${categoryName.trim()}`);
    } catch (emailError) {
      console.error('Failed to send resubmit emails to super admins:', emailError);
    }

    reply.send({
      success: true,
      message: 'Category request resubmitted for approval',
      data: {
        id,
        categoryName: categoryName.trim(),
        description:   description ?? category.description,
        status: 'PENDING'
      }
    });
  } catch (error) {
    console.error('Resubmit category error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== SOFT DELETE CATEGORY (Admin Only) ====================

exports.softDeleteCategory = async (request, reply) => {
  try {
    const { id } = request.params;
    const { reason } = request.body || {};

    const categoryRequest = await prisma.$queryRaw`
      SELECT * FROM "category_requests" WHERE "id" = ${id}
    `;

    if (!categoryRequest || categoryRequest.length === 0) {
      return reply.status(404).send({ success: false, message: 'Category not found' });
    }

    const category = categoryRequest[0];

    if (category.softDeletedAt) {
      return reply.status(400).send({ success: false, message: 'Category is already soft-deleted' });
    }

    // Sellers can only soft-delete their own category requests
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(request.user.role);
    if (!isAdmin && category.requestedBy !== request.user.userId) {
      return reply.status(403).send({ success: false, message: 'You can only delete your own category requests' });
    }

    await prisma.$executeRaw`
      UPDATE "category_requests"
      SET "softDeletedAt" = NOW(),
          "softDeletedBy" = ${request.user?.userId},
          "updatedAt"     = NOW()
      WHERE "id" = ${id}
    `;

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType:   ENTITY_TYPES.CATEGORY,
      entityId:     id,
      action:       AUDIT_ACTIONS.CATEGORY_SOFT_DELETED,
      ...meta,
      previousData: category,
      newData:      { ...category, softDeletedAt: new Date(), softDeletedBy: request.user?.userId },
      reason:       reason || `Category "${category.categoryName}" moved to recycle bin`,
    });

    reply.send({
      success: true,
      message: `Category "${category.categoryName}" has been soft-deleted (moved to recycle bin)`,
      data: { id, categoryName: category.categoryName, softDeletedAt: new Date() }
    });
  } catch (error) {
    console.error('Soft delete category error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== RESTORE CATEGORY (Admin Only) ====================

exports.restoreCategory = async (request, reply) => {
  try {
    const { id } = request.params;

    const categoryRequest = await prisma.$queryRaw`
      SELECT * FROM "category_requests" WHERE "id" = ${id}
    `;

    if (!categoryRequest || categoryRequest.length === 0) {
      return reply.status(404).send({ success: false, message: 'Category not found' });
    }

    const category = categoryRequest[0];

    if (!category.softDeletedAt) {
      return reply.status(400).send({ success: false, message: 'Category is not soft-deleted' });
    }

    await prisma.$executeRaw`
      UPDATE "category_requests"
      SET "softDeletedAt" = NULL,
          "softDeletedBy" = NULL,
          "restoredAt"    = NOW(),
          "restoredBy"    = ${request.user?.userId},
          "updatedAt"     = NOW()
      WHERE "id" = ${id}
    `;

    const meta = extractRequestMeta(request);
    await auditLog({
      entityType:   ENTITY_TYPES.CATEGORY,
      entityId:     id,
      action:       AUDIT_ACTIONS.CATEGORY_RESTORED,
      ...meta,
      previousData: category,
      newData:      { ...category, softDeletedAt: null, softDeletedBy: null, restoredAt: new Date(), restoredBy: request.user?.userId },
      reason:       `Category "${category.categoryName}" restored from recycle bin`,
    });

    reply.send({
      success: true,
      message: `Category "${category.categoryName}" has been restored`,
      data: { id, categoryName: category.categoryName, status: category.status, restoredAt: new Date() }
    });
  } catch (error) {
    console.error('Restore category error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== HARD DELETE CATEGORY (Admin Only — permanent, irreversible) ====================

exports.hardDeleteCategory = async (request, reply) => {
  try {
    const { id } = request.params;
    const { reason } = request.body || {};

    const categoryRequest = await prisma.$queryRaw`
      SELECT * FROM "category_requests" WHERE "id" = ${id}
    `;

    if (!categoryRequest || categoryRequest.length === 0) {
      return reply.status(404).send({ success: false, message: 'Category not found' });
    }

    const category = categoryRequest[0];

    // Must be in the recycle bin before a permanent delete is permitted
    if (!category.softDeletedAt) {
      return reply.status(400).send({
        success: false,
        message: 'Category must be moved to the recycle bin before it can be permanently deleted'
      });
    }

    // Write the audit log BEFORE deleting so the row snapshot is preserved
    const meta = extractRequestMeta(request);
    await auditLog({
      entityType:   ENTITY_TYPES.CATEGORY,
      entityId:     id,
      action:       AUDIT_ACTIONS.CATEGORY_HARD_DELETED,
      ...meta,
      previousData: category,
      newData:      null,
      reason:       reason || `Category "${category.categoryName}" permanently deleted`,
    });

    await prisma.$executeRaw`
      DELETE FROM "category_requests" WHERE "id" = ${id}
    `;

    reply.send({
      success: true,
      message: `Category "${category.categoryName}" has been permanently deleted. Audit logs are retained.`,
      data: { id, categoryName: category.categoryName }
    });
  } catch (error) {
    console.error('Hard delete category error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== GET SOFT-DELETED CATEGORIES (Admin — recycle bin) ====================

exports.getSoftDeletedCategories = async (request, reply) => {
  try {
    const deleted = await prisma.$queryRaw`
      SELECT cr."id", cr."categoryName", cr."description", cr."status",
             cr."softDeletedAt", cr."softDeletedBy",
             u."email" as deleted_by_email, u."name" as deleted_by_name
      FROM "category_requests" cr
      LEFT JOIN "users" u ON cr."softDeletedBy" = u."id"
      WHERE cr."softDeletedAt" IS NOT NULL
      ORDER BY cr."softDeletedAt" DESC
    `;

    reply.send({
      success: true,
      data: {
        deletedCategories: deleted,
        total: deleted.length
      }
    });
  } catch (error) {
    console.error('Get soft-deleted categories error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== GET CATEGORY AUDIT LOGS (Admin Only) ====================

exports.getCategoryLogs = async (request, reply) => {
  try {
    const { id } = request.params;
    const { action } = request.query;
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(request.user.role);

    // Sellers may only view logs for a category they originally requested
    if (!isAdmin) {
      const rows = await prisma.$queryRaw`
        SELECT "requestedBy" FROM "category_requests" WHERE "id" = ${id} LIMIT 1
      `;
      if (!rows || rows.length === 0) {
        return reply.status(404).send({ success: false, message: 'Category not found' });
      }
      if (rows[0].requestedBy !== request.user.userId) {
        return reply.status(403).send({ success: false, message: 'Access denied' });
      }
    }

    const where = {
      entityType: ENTITY_TYPES.CATEGORY,
      entityId:   id,
      ...(action ? { action } : {})
    };

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'asc' }
    });

    if (logs.length === 0) {
      return reply.status(404).send({ success: false, message: 'No audit logs found for this category' });
    }

    // Strip sensitive internal fields (actorId, actorEmail, actorIp, userAgent)
    // before returning to sellers — actorRole is safe to expose
    const sellerSafeFields = (log) => ({
      id:            log.id,
      action:        log.action,
      actorRole:     log.actorRole,
      changedFields: log.changedFields ?? [],
      newData:       log.newData ?? null,
      reason:        log.reason ?? null,
      createdAt:     log.createdAt
    });

    reply.send({
      success: true,
      data: {
        categoryId: id,
        logs: isAdmin ? logs : logs.map(sellerSafeFields),
        total: logs.length
      }
    });
  } catch (error) {
    console.error('Get category logs error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// ==================== GET ALL CATEGORY AUDIT LOGS (Admin Only) ====================

exports.getAllCategoryLogs = async (request, reply) => {
  try {
    const { page = 1, limit = 50, action } = request.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where = { entityType: ENTITY_TYPES.CATEGORY };
    if (action) where.action = action;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit)
      }),
      prisma.auditLog.count({ where })
    ]);

    reply.send({
      success: true,
      data: {
        logs,
        total,
        page: Number(page),
        totalPages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    console.error('Get all category logs error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};


// ==================== GET SINGLE CATEGORY DETAIL ====================
// Admin: any category (including soft-deleted)
// Seller: approved categories OR their own requested categories (any status, including soft-deleted)

exports.getCategoryDetail = async (request, reply) => {
  try {
    const { id } = request.params;
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(request.user.role);

    const rows = await prisma.$queryRaw`
      SELECT cr.*,
             u."email"  AS requested_by_email,
             u."name"   AS requested_by_name,
             sp."storeName", sp."businessName",
             ab."email" AS approved_by_email,
             ab."name"  AS approved_by_name,
             rb."email" AS rejected_by_email,
             rb."name"  AS rejected_by_name,
             sd."email" AS soft_deleted_by_email,
             sd."name"  AS soft_deleted_by_name
      FROM "category_requests" cr
      LEFT JOIN "users" u  ON cr."requestedBy"  = u."id"
      LEFT JOIN "seller_profiles" sp ON u."id" = sp."userId"
      LEFT JOIN "users" ab ON cr."approvedBy"   = ab."id"
      LEFT JOIN "users" rb ON cr."rejectedBy"   = rb."id"
      LEFT JOIN "users" sd ON cr."softDeletedBy" = sd."id"
      WHERE cr."id" = ${id}
      LIMIT 1
    `;

    if (!rows || rows.length === 0) {
      return reply.status(404).send({ success: false, message: 'Category not found' });
    }

    const category = rows[0];

    // Sellers can only see approved categories OR their own requests
    if (!isAdmin) {
      const isOwner   = category.requestedBy === request.user.userId;
      const isApproved = category.status === 'APPROVED';
      if (!isOwner && !isApproved) {
        return reply.status(403).send({ success: false, message: 'Access denied' });
      }
    }

    reply.send({ success: true, data: category });
  } catch (error) {
    console.error('Get category detail error:', error);
    reply.status(500).send({ success: false, error: error.message });
  }
};
