'use strict';

const prisma = require('../config/prisma');
const { log: auditLog, extractRequestMeta, ENTITY_TYPES, AUDIT_ACTIONS } = require('../utils/auditLogger');
const { sendSuperAdminCreatedSamlAdminEmail } = require('../utils/emailService');

const SAML_PASSWORD = 'SAML_MANAGED_ACCOUNT_NO_PASSWORD';

const samlUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
};

exports.createSamlUser = async (request, reply) => {
  try {
    const { name, email } = request.body || {};
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const normalizedEmail = typeof email === 'string' ? email.toLowerCase().trim() : '';

    if (!normalizedName) {
      return reply.status(400).send({ success: false, message: 'Full name is required' });
    }

    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return reply.status(400).send({ success: false, message: 'A valid email address is required' });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, role: true },
    });

    if (existingUser) {
      return reply.status(409).send({ success: false, message: 'A user with this email already exists' });
    }

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: normalizedName,
          email: normalizedEmail,
          role: 'ADMIN',
          password: SAML_PASSWORD,
          isVerified: true,
          emailVerified: true,
        },
        select: samlUserSelect,
      });

      const approval = await tx.samlApproval.create({
        data: {
          userId: user.id,
          status: 'APPROVED',
          approvedBy: request.user.userId,
          approvedAt: new Date(),
        },
        include: { user: { select: samlUserSelect } },
      });

      return { user, approval };
    });

    auditLog({
      entityType: ENTITY_TYPES.SAML_APPROVAL,
      entityId: created.user.id,
      action: AUDIT_ACTIONS.SAML_USER_CREATED,
      newData: { status: 'APPROVED', role: 'ADMIN', email: normalizedEmail, name: normalizedName },
      ...extractRequestMeta(request),
      reason: 'SAML admin allowlist record created by Super Admin',
    });

    try {
      const creator = await prisma.user.findUnique({
        where: { id: request.user.userId },
        select: { email: true, name: true },
      });

      if (creator?.email) {
        await sendSuperAdminCreatedSamlAdminEmail(creator.email, creator.name, {
          newAdminName: created.user.name,
          newAdminEmail: created.user.email,
          role: created.user.role,
          status: created.approval.status,
          createdAt: created.user.createdAt,
          createdByName: creator.name,
          createdByEmail: creator.email,
        });
      }
    } catch (emailError) {
      console.error('[SAML Admin] Failed to notify creator about new admin:', emailError.message);
    }

    return reply.status(201).send({
      success: true,
      message: 'Admin created successfully',
      data: created.approval,
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return reply.status(409).send({ success: false, message: 'A user with this email already exists' });
    }

    console.error('createSamlUser error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to create admin user' });
  }
};

exports.getAllSamlUsers = async (request, reply) => {
  try {
    const { status, page = 1, limit = 50 } = request.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where = {};
    if (status) where.status = status;

    const [approvals, total] = await Promise.all([
      prisma.samlApproval.findMany({
        where,
        include: { user: { select: samlUserSelect } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.samlApproval.count({ where }),
    ]);

    // Include SUPER_ADMIN users who may not have a SAML approval record
    const superAdmins = await prisma.user.findMany({
      where: { role: 'SUPER_ADMIN' },
      select: samlUserSelect,
    });

    const approvalUserIds = new Set(approvals.map((a) => a.userId));
    const missingSuperAdmins = superAdmins
      .filter((sa) => !approvalUserIds.has(sa.id))
      .map((sa) => ({
        id: `virtual-${sa.id}`,
        userId: sa.id,
        status: 'APPROVED',
        approvedBy: 'SYSTEM',
        approvedAt: sa.createdAt,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: null,
        blockedBy: null,
        blockedAt: null,
        blockReason: null,
        archivedBy: null,
        archivedAt: null,
        archiveReason: null,
        createdAt: sa.createdAt,
        updatedAt: sa.createdAt,
        user: sa,
      }));

    const allData = [...missingSuperAdmins, ...approvals];

    return reply.send({
      success: true,
      data: allData,
      pagination: { page: Number(page), limit: Number(limit), total: total + missingSuperAdmins.length, totalPages: Math.ceil((total + missingSuperAdmins.length) / Number(limit)) },
    });
  } catch (error) {
    console.error('getAllSamlUsers error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to fetch SAML users' });
  }
};

exports.getPendingSamlUsers = async (request, reply) => {
  try {
    const approvals = await prisma.samlApproval.findMany({
      where: { status: 'PENDING' },
      include: { user: { select: samlUserSelect } },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send({ success: true, data: approvals, count: approvals.length });
  } catch (error) {
    console.error('getPendingSamlUsers error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to fetch pending SAML users' });
  }
};

exports.approveSamlUser = async (request, reply) => {
  try {
    const { userId } = request.params;
    const { role } = request.body || {};

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { samlApproval: true },
    });

    if (!user || user.password !== SAML_PASSWORD) {
      return reply.status(404).send({ success: false, message: 'SAML user not found' });
    }

    if (user.role === 'SUPER_ADMIN') {
      return reply.status(403).send({ success: false, message: 'Cannot modify Super Admin users' });
    }

    if (!user.samlApproval) {
      return reply.status(400).send({ success: false, message: 'No SAML approval record found for this user' });
    }

    if (user.samlApproval.status === 'APPROVED') {
      return reply.status(400).send({ success: false, message: 'User is already approved' });
    }

    if (user.samlApproval.status === 'ARCHIVED') {
      return reply.status(400).send({ success: false, message: 'User is archived. Unarchive the user before approving.' });
    }

    const previousData = { status: user.samlApproval.status, role: user.role };

    const assignRole = role === 'ADMIN' ? 'ADMIN' : 'ADMIN';

    const [updatedApproval] = await prisma.$transaction([
      prisma.samlApproval.update({
        where: { userId },
        data: {
          status: 'APPROVED',
          approvedBy: request.user.userId,
          approvedAt: new Date(),
          rejectedBy: null,
          rejectedAt: null,
          rejectionReason: null,
          archivedBy: null,
          archivedAt: null,
          archiveReason: null,
        },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { role: assignRole },
      }),
    ]);

    auditLog({
      entityType: ENTITY_TYPES.SAML_APPROVAL,
      entityId: userId,
      action: AUDIT_ACTIONS.SAML_USER_APPROVED,
      previousData,
      newData: { status: 'APPROVED', role: assignRole },
      ...extractRequestMeta(request),
      reason: `SAML user approved with role ${assignRole}`,
    });

    return reply.send({ success: true, message: 'User approved successfully', data: updatedApproval });
  } catch (error) {
    console.error('approveSamlUser error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to approve user' });
  }
};

exports.rejectSamlUser = async (request, reply) => {
  try {
    const { userId } = request.params;
    const { reason } = request.body || {};

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { samlApproval: true },
    });

    if (!user || user.password !== SAML_PASSWORD) {
      return reply.status(404).send({ success: false, message: 'SAML user not found' });
    }

    if (user.role === 'SUPER_ADMIN') {
      return reply.status(403).send({ success: false, message: 'Cannot modify Super Admin users' });
    }

    if (!user.samlApproval) {
      return reply.status(400).send({ success: false, message: 'No SAML approval record found' });
    }

    if (user.samlApproval.status === 'ARCHIVED') {
      return reply.status(400).send({ success: false, message: 'User is archived. Unarchive the user before rejecting.' });
    }

    const previousData = { status: user.samlApproval.status };

    const updatedApproval = await prisma.samlApproval.update({
      where: { userId },
      data: {
        status: 'REJECTED',
        rejectedBy: request.user.userId,
        rejectedAt: new Date(),
        rejectionReason: reason || null,
      },
    });

    auditLog({
      entityType: ENTITY_TYPES.SAML_APPROVAL,
      entityId: userId,
      action: AUDIT_ACTIONS.SAML_USER_REJECTED,
      previousData,
      newData: { status: 'REJECTED', rejectionReason: reason },
      ...extractRequestMeta(request),
      reason: reason || 'SAML user rejected',
    });

    return reply.send({ success: true, message: 'User rejected', data: updatedApproval });
  } catch (error) {
    console.error('rejectSamlUser error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to reject user' });
  }
};

exports.blockSamlUser = async (request, reply) => {
  try {
    const { userId } = request.params;
    const { reason } = request.body || {};

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { samlApproval: true },
    });

    if (!user || user.password !== SAML_PASSWORD) {
      return reply.status(404).send({ success: false, message: 'SAML user not found' });
    }

    if (user.role === 'SUPER_ADMIN') {
      return reply.status(403).send({ success: false, message: 'Cannot block Super Admin users' });
    }

    if (!user.samlApproval) {
      return reply.status(400).send({ success: false, message: 'No SAML approval record found' });
    }

    if (user.samlApproval.status === 'ARCHIVED') {
      return reply.status(400).send({ success: false, message: 'User is archived. Unarchive the user before blocking.' });
    }

    const previousData = { status: user.samlApproval.status };

    const updatedApproval = await prisma.samlApproval.update({
      where: { userId },
      data: {
        status: 'BLOCKED',
        blockedBy: request.user.userId,
        blockedAt: new Date(),
        blockReason: reason || null,
        archivedBy: null,
        archivedAt: null,
        archiveReason: null,
      },
    });

    auditLog({
      entityType: ENTITY_TYPES.SAML_APPROVAL,
      entityId: userId,
      action: AUDIT_ACTIONS.SAML_USER_BLOCKED,
      previousData,
      newData: { status: 'BLOCKED', blockReason: reason },
      ...extractRequestMeta(request),
      reason: reason || 'SAML user blocked',
    });

    return reply.send({ success: true, message: 'User blocked', data: updatedApproval });
  } catch (error) {
    console.error('blockSamlUser error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to block user' });
  }
};

exports.unblockSamlUser = async (request, reply) => {
  try {
    const { userId } = request.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { samlApproval: true },
    });

    if (!user || user.password !== SAML_PASSWORD) {
      return reply.status(404).send({ success: false, message: 'SAML user not found' });
    }

    if (!user.samlApproval) {
      return reply.status(400).send({ success: false, message: 'No SAML approval record found' });
    }

    if (user.samlApproval.status === 'ARCHIVED') {
      return reply.status(400).send({ success: false, message: 'User is archived. Use unarchive instead.' });
    }

    if (user.samlApproval.status !== 'BLOCKED' && user.samlApproval.status !== 'REJECTED') {
      return reply.status(400).send({ success: false, message: 'User is not blocked or rejected' });
    }

    const previousData = { status: user.samlApproval.status };

    const updatedApproval = await prisma.samlApproval.update({
      where: { userId },
      data: {
        status: 'APPROVED',
        approvedBy: request.user.userId,
        approvedAt: new Date(),
        blockedBy: null,
        blockedAt: null,
        blockReason: null,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: null,
        archivedBy: null,
        archivedAt: null,
        archiveReason: null,
      },
    });

    auditLog({
      entityType: ENTITY_TYPES.SAML_APPROVAL,
      entityId: userId,
      action: AUDIT_ACTIONS.SAML_USER_UNBLOCKED,
      previousData,
      newData: { status: 'APPROVED' },
      ...extractRequestMeta(request),
      reason: 'SAML user unblocked and restored to approved',
    });

    return reply.send({ success: true, message: 'User unblocked and approved', data: updatedApproval });
  } catch (error) {
    console.error('unblockSamlUser error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to unblock user' });
  }
};

exports.changeSamlUserRole = async (request, reply) => {
  try {
    const { userId } = request.params;
    const { role } = request.body || {};

    if (!role || !['ADMIN'].includes(role)) {
      return reply.status(400).send({ success: false, message: 'Invalid role. Allowed: ADMIN' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { samlApproval: true },
    });

    if (!user || user.password !== SAML_PASSWORD) {
      return reply.status(404).send({ success: false, message: 'SAML user not found' });
    }

    if (user.role === 'SUPER_ADMIN') {
      return reply.status(403).send({ success: false, message: 'Cannot change Super Admin role' });
    }

    if (user.samlApproval?.status === 'ARCHIVED') {
      return reply.status(400).send({ success: false, message: 'User is archived. Unarchive the user before changing role.' });
    }

    const previousData = { role: user.role };

    await prisma.user.update({
      where: { id: userId },
      data: { role },
    });

    auditLog({
      entityType: ENTITY_TYPES.SAML_APPROVAL,
      entityId: userId,
      action: AUDIT_ACTIONS.SAML_USER_ROLE_CHANGED,
      previousData,
      newData: { role },
      ...extractRequestMeta(request),
      reason: `Role changed from ${user.role} to ${role}`,
    });

    return reply.send({ success: true, message: `User role changed to ${role}` });
  } catch (error) {
    console.error('changeSamlUserRole error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to change role' });
  }
};

exports.archiveSamlUser = async (request, reply) => {
  try {
    const { userId } = request.params;
    const { reason } = request.body || {};

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { samlApproval: true },
    });

    if (!user || user.password !== SAML_PASSWORD) {
      return reply.status(404).send({ success: false, message: 'SAML user not found' });
    }

    if (user.role === 'SUPER_ADMIN') {
      return reply.status(403).send({ success: false, message: 'Cannot archive Super Admin users' });
    }

    if (!user.samlApproval) {
      return reply.status(400).send({ success: false, message: 'No SAML approval record found' });
    }

    if (user.samlApproval.status === 'ARCHIVED') {
      return reply.status(400).send({ success: false, message: 'User is already archived' });
    }

    const previousData = {
      status: user.samlApproval.status,
      blockedBy: user.samlApproval.blockedBy,
      blockedAt: user.samlApproval.blockedAt,
      blockReason: user.samlApproval.blockReason,
      rejectedBy: user.samlApproval.rejectedBy,
      rejectedAt: user.samlApproval.rejectedAt,
      rejectionReason: user.samlApproval.rejectionReason,
    };

    const updatedApproval = await prisma.samlApproval.update({
      where: { userId },
      data: {
        status: 'ARCHIVED',
        archivedBy: request.user.userId,
        archivedAt: new Date(),
        archiveReason: reason || null,
        blockedBy: null,
        blockedAt: null,
        blockReason: null,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: null,
      },
    });

    auditLog({
      entityType: ENTITY_TYPES.SAML_APPROVAL,
      entityId: userId,
      action: AUDIT_ACTIONS.SAML_USER_ARCHIVED,
      previousData,
      newData: { status: 'ARCHIVED', archiveReason: reason || null },
      ...extractRequestMeta(request),
      reason: reason || 'SAML user archived',
    });

    return reply.send({ success: true, message: 'User archived', data: updatedApproval });
  } catch (error) {
    console.error('archiveSamlUser error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to archive user' });
  }
};

exports.unarchiveSamlUser = async (request, reply) => {
  try {
    const { userId } = request.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { samlApproval: true },
    });

    if (!user || user.password !== SAML_PASSWORD) {
      return reply.status(404).send({ success: false, message: 'SAML user not found' });
    }

    if (!user.samlApproval) {
      return reply.status(400).send({ success: false, message: 'No SAML approval record found' });
    }

    if (user.samlApproval.status !== 'ARCHIVED') {
      return reply.status(400).send({ success: false, message: 'User is not archived' });
    }

    const previousData = {
      status: user.samlApproval.status,
      archivedBy: user.samlApproval.archivedBy,
      archivedAt: user.samlApproval.archivedAt,
      archiveReason: user.samlApproval.archiveReason,
    };

    const updatedApproval = await prisma.samlApproval.update({
      where: { userId },
      data: {
        status: 'APPROVED',
        approvedBy: request.user.userId,
        approvedAt: new Date(),
        archivedBy: null,
        archivedAt: null,
        archiveReason: null,
      },
    });

    auditLog({
      entityType: ENTITY_TYPES.SAML_APPROVAL,
      entityId: userId,
      action: AUDIT_ACTIONS.SAML_USER_UNARCHIVED,
      previousData,
      newData: { status: 'APPROVED' },
      ...extractRequestMeta(request),
      reason: 'SAML user unarchived and restored to approved',
    });

    return reply.send({ success: true, message: 'User unarchived and approved', data: updatedApproval });
  } catch (error) {
    console.error('unarchiveSamlUser error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to unarchive user' });
  }
};
