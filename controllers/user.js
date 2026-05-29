// ...existing code...
const prisma = require('../config/prisma');

exports.getAllUsers = async (request, reply) => {
  try {
    // Debug: log the user object
    console.log('Authenticated user:', request.user);
    if (!request.user || !['ADMIN', 'SUPER_ADMIN'].includes(request.user.role)) {
      return reply.status(403).send({ message: 'Access denied. Admins only.' });
    }
    const users = await prisma.user.findMany();
    reply.send(users);
  } catch (error) {
    reply.status(500).send({ message: 'Server error', error: error.message });
  }
};
// Get profile for authenticated user
exports.getProfile = async (request, reply) => {
  try {
    console.log('Request user:', request.user); // Add this debug log
    
    const userId = request.user?.id;
    
    if (!userId) {
      return reply.status(401).send({ 
        success: false,
        message: 'Unauthorized - User ID not found in token' 
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        profileImage: true,
        role: true,
        isVerified: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!user) {
      return reply.status(404).send({ 
        success: false,
        message: 'User not found' 
      });
    }

    reply.send({
      success: true,
      data: user
    });
  } catch (error) {
    console.error('Profile fetch error:', error);
    reply.status(500).send({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
};

// ==================== ADDRESS MANAGEMENT ====================

// Save a new address (token required)
exports.saveAddress = async (request, reply) => {
  try {
    const userId = request.user?.userId || request.user?.id;
    if (!userId) return reply.status(401).send({ success: false, message: 'Unauthorized' });

    const { shippingAddress, city, state, country, zipCode, mobileNumber, isDefault } = request.body;

    if (!shippingAddress || !city || !state || !country || !zipCode) {
      return reply.status(400).send({
        success: false,
        message: 'shippingAddress, city, state, country, and zipCode are required'
      });
    }

    // ── Duplicate check: all fields must match (case-insensitive, trimmed) ──
    const duplicate = await prisma.userAddress.findFirst({
      where: {
        userId,
        shippingAddress: { equals: shippingAddress.trim(), mode: 'insensitive' },
        city:            { equals: city.trim(),            mode: 'insensitive' },
        state:           { equals: state.trim(),           mode: 'insensitive' },
        country:         { equals: country.trim(),         mode: 'insensitive' },
        zipCode:         { equals: zipCode.trim(),         mode: 'insensitive' },
        mobileNumber:    mobileNumber
          ? { equals: mobileNumber.trim(), mode: 'insensitive' }
          : null
      }
    });

    if (duplicate) {
      return reply.status(409).send({
        success: false,
        message: 'You have already saved this address',
        data: duplicate
      });
    }

    // If this address is set as default, unset all others first
    if (isDefault) {
      await prisma.userAddress.updateMany({
        where: { userId },
        data: { isDefault: false }
      });
    }

    // Check if user has no addresses yet — make first one default automatically
    const existingCount = await prisma.userAddress.count({ where: { userId } });

    const address = await prisma.userAddress.create({
      data: {
        userId,
        shippingAddress: shippingAddress.trim(),
        city:            city.trim(),
        state:           state.trim(),
        country:         country.trim(),
        zipCode:         zipCode.trim(),
        mobileNumber:    mobileNumber ? mobileNumber.trim() : null,
        isDefault:       isDefault || existingCount === 0
      }
    });

    return reply.status(201).send({
      success: true,
      message: 'Address saved successfully',
      data: address
    });
  } catch (error) {
    console.error('saveAddress error:', error);
    reply.status(500).send({ success: false, message: 'Server error', error: error.message });
  }
};

// Get all saved addresses for the logged-in user (token required)
exports.getAddresses = async (request, reply) => {
  try {
    const userId = request.user?.userId || request.user?.id;
    if (!userId) return reply.status(401).send({ success: false, message: 'Unauthorized' });

    const addresses = await prisma.userAddress.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
    });

    return reply.send({
      success: true,
      data: addresses
    });
  } catch (error) {
    console.error('getAddresses error:', error);
    reply.status(500).send({ success: false, message: 'Server error', error: error.message });
  }
};

// Delete a saved address (token required)
exports.deleteAddress = async (request, reply) => {
  try {
    const userId = request.user?.userId || request.user?.id;
    if (!userId) return reply.status(401).send({ success: false, message: 'Unauthorized' });

    const { id } = request.params;

    const address = await prisma.userAddress.findFirst({ where: { id, userId } });
    if (!address) {
      return reply.status(404).send({ success: false, message: 'Address not found' });
    }

    await prisma.userAddress.delete({ where: { id } });

    // If deleted address was default, promote the most recent remaining one
    if (address.isDefault) {
      const next = await prisma.userAddress.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' }
      });
      if (next) await prisma.userAddress.update({ where: { id: next.id }, data: { isDefault: true } });
    }

    return reply.send({ success: true, message: 'Address deleted successfully' });
  } catch (error) {
    console.error('deleteAddress error:', error);
    reply.status(500).send({ success: false, message: 'Server error', error: error.message });
  }
};

// Set an address as default (token required)
exports.setDefaultAddress = async (request, reply) => {
  try {
    const userId = request.user?.userId || request.user?.id;
    if (!userId) return reply.status(401).send({ success: false, message: 'Unauthorized' });

    const { id } = request.params;

    const address = await prisma.userAddress.findFirst({ where: { id, userId } });
    if (!address) {
      return reply.status(404).send({ success: false, message: 'Address not found' });
    }

    // Unset all, then set the chosen one
    await prisma.userAddress.updateMany({ where: { userId }, data: { isDefault: false } });
    await prisma.userAddress.update({ where: { id }, data: { isDefault: true } });

    return reply.send({ success: true, message: 'Default address updated' });
  } catch (error) {
    console.error('setDefaultAddress error:', error);
    reply.status(500).send({ success: false, message: 'Server error', error: error.message });
  }
};
