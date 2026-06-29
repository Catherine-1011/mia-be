'use strict';

const prisma = require('../config/prisma');
const { log: auditLog, extractRequestMeta, ENTITY_TYPES, AUDIT_ACTIONS } = require('../utils/auditLogger');

const SAML_PASSWORD = 'SAML_MANAGED_ACCOUNT_NO_PASSWORD';

const samlUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
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

    const previousData = { status: user.samlApproval.status };

    const updatedApproval = await prisma.samlApproval.update({
      where: { userId },
      data: {
        status: 'BLOCKED',
        blockedBy: request.user.userId,
        blockedAt: new Date(),
        blockReason: reason || null,
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
