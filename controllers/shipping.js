const prisma = require('../config/prisma');
const { INTERNATIONAL_ZONES, lookupZone } = require('../utils/internationalShipping');
const { invalidateCache } = require('../utils/cacheInvalidation');

/**
 * PUBLIC - Get all international shipping zones with their countries
 * GET /api/shipping/international/zones
 */
const getInternationalZones = async (request, reply) => {
  try {
    const zones = INTERNATIONAL_ZONES.map(({ zone, label, cost, countries }) => ({
      zone,
      label,
      cost,
      countries: countries.sort()
    }));

    return reply.status(200).send({
      success: true,
      data: zones
    });
  } catch (error) {
    console.error('Error fetching international zones:', error);
    return reply.status(500).send({
      success: false,
      message: 'Failed to fetch international zones',
      error: error.message
    });
  }
};

/**
 * PUBLIC - Get international shipping rate for a specific country
 * GET /api/shipping/international/rate?country=<countryName>
 */
const getInternationalRate = async (request, reply) => {
  try {
    const { country } = request.query;

    if (!country || !country.trim()) {
      return reply.status(400).send({
        success: false,
        message: 'country query parameter is required'
      });
    }

    const countryTrimmed = country.trim();

    // Special case: Australia is handled by standard/express, not international
    if (countryTrimmed.toLowerCase() === 'australia') {
      return reply.status(400).send({
        success: false,
        message: 'Use standard or express shipping for Australia'
      });
    }

    const zoneEntry = lookupZone(countryTrimmed);

    return reply.status(200).send({
      success: true,
      data: {
        country: countryTrimmed,
        zone: zoneEntry.zone,
        zoneName: zoneEntry.label,
        cost: zoneEntry.cost,
        name: 'International',
        estimatedDays: '10-20 business days',
        description: `International shipping to ${countryTrimmed} (${zoneEntry.zone} – ${zoneEntry.label})`
      }
    });
  } catch (error) {
    console.error('Error fetching international shipping rate:', error);
    return reply.status(500).send({
      success: false,
      message: 'Failed to fetch international shipping rate',
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Create a new shipping method
 */
const createShippingMethod = async (request, reply) => {
  try {
    const { name, description, cost, estimatedDays, isActive } = request.body;

    // Validate required fields
    if (!name || cost === undefined) {
      return reply.status(400).send({
        success: false,
        message: "Name and cost are required"
      });
    }

    // Check if shipping method with same name exists
    const existingMethod = await prisma.shippingMethod.findUnique({
      where: { name }
    });

    if (existingMethod) {
      return reply.status(400).send({
        success: false,
        message: "A shipping method with this name already exists"
      });
    }

    // Create new shipping method
    const shippingMethod = await prisma.shippingMethod.create({
      data: {
        name,
        description,
        cost: parseFloat(cost),
        estimatedDays,
        isActive: isActive !== undefined ? isActive : true
      }
    });

    await invalidateCache('checkout');
    return reply.status(201).send({
      success: true,
      message: "Shipping method created successfully",
      data: shippingMethod
    });
  } catch (error) {
    console.error("Error creating shipping method:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to create shipping method",
      error: error.message
    });
  }
};

/**
 * PUBLIC - Get all active shipping methods for customers
 */
const getActiveShippingMethods = async (request, reply) => {
  try {
    const shippingMethods = await prisma.shippingMethod.findMany({
      where: { isActive: true },
      orderBy: { cost: 'asc' } // Show cheapest first
    });

    return reply.status(200).send({
      success: true,
      count: shippingMethods.length,
      data: shippingMethods
    });
  } catch (error) {
    console.error("Error fetching active shipping methods:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to fetch shipping methods",
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Get all shipping methods (including inactive)
 */
const getAllShippingMethods = async (request, reply) => {
  try {
    const shippingMethods = await prisma.shippingMethod.findMany({
      orderBy: { createdAt: 'desc' }
    });

    return reply.status(200).send({
      success: true,
      count: shippingMethods.length,
      data: shippingMethods
    });
  } catch (error) {
    console.error("Error fetching shipping methods:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to fetch shipping methods",
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Get single shipping method by ID
 */
const getShippingMethodById = async (request, reply) => {
  try {
    const { id } = request.params;

    const shippingMethod = await prisma.shippingMethod.findUnique({
      where: { id }
    });

    if (!shippingMethod) {
      return reply.status(404).send({
        success: false,
        message: "Shipping method not found"
      });
    }

    return reply.status(200).send({
      success: true,
      data: shippingMethod
    });
  } catch (error) {
    console.error("Error fetching shipping method:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to fetch shipping method",
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Update shipping method
 */
const updateShippingMethod = async (request, reply) => {
  try {
    const { id } = request.params;
    const { name, description, cost, estimatedDays, isActive } = request.body;

    // Check if shipping method exists
    const existingMethod = await prisma.shippingMethod.findUnique({
      where: { id }
    });

    if (!existingMethod) {
      return reply.status(404).send({
        success: false,
        message: "Shipping method not found"
      });
    }

    // If name is being updated, check for duplicates
    if (name && name !== existingMethod.name) {
      const duplicateName = await prisma.shippingMethod.findUnique({
        where: { name }
      });

      if (duplicateName) {
        return reply.status(400).send({
          success: false,
          message: "A shipping method with this name already exists"
        });
      }
    }

    // Update shipping method
    const updatedMethod = await prisma.shippingMethod.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(cost !== undefined && { cost: parseFloat(cost) }),
        ...(estimatedDays !== undefined && { estimatedDays }),
        ...(isActive !== undefined && { isActive })
      }
    });

    await invalidateCache('checkout');
    return reply.status(200).send({
      success: true,
      message: "Shipping method updated successfully",
      data: updatedMethod
    });
  } catch (error) {
    console.error("Error updating shipping method:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to update shipping method",
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Delete shipping method
 */
const deleteShippingMethod = async (request, reply) => {
  try {
    const { id } = request.params;

    // Check if shipping method exists
    const existingMethod = await prisma.shippingMethod.findUnique({
      where: { id }
    });

    if (!existingMethod) {
      return reply.status(404).send({
        success: false,
        message: "Shipping method not found"
      });
    }

    // Delete the shipping method
    await prisma.shippingMethod.delete({
      where: { id }
    });

    await invalidateCache('checkout');
    return reply.status(200).send({
      success: true,
      message: "Shipping method deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting shipping method:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to delete shipping method",
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Toggle shipping method active status
 */
const toggleShippingMethodStatus = async (request, reply) => {
  try {
    const { id } = request.params;

    const shippingMethod = await prisma.shippingMethod.findUnique({
      where: { id }
    });

    if (!shippingMethod) {
      return reply.status(404).send({
        success: false,
        message: "Shipping method not found"
      });
    }

    // Toggle the isActive status
    const updatedMethod = await prisma.shippingMethod.update({
      where: { id },
      data: { isActive: !shippingMethod.isActive }
    });

    await invalidateCache('checkout');
    return reply.status(200).send({
      success: true,
      message: `Shipping method ${updatedMethod.isActive ? 'activated' : 'deactivated'} successfully`,
      data: updatedMethod
    });
  } catch (error) {
    console.error("Error toggling shipping method status:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to toggle shipping method status",
      error: error.message
    });
  }
};

/**
 * PUBLIC - Get global shipping settings (e.g. is international shipping enabled?)
 * GET /api/shipping/settings
 */
const getShippingSettings = async (request, reply) => {
  try {
    const settings = await prisma.siteSettings.findUnique({ where: { id: 'global' } });
    return reply.status(200).send({
      success: true,
      data: {
        internationalShippingEnabled: settings?.internationalShippingEnabled ?? true
      }
    });
  } catch (error) {
    console.error('Error fetching shipping settings:', error);
    return reply.status(500).send({ success: false, message: 'Failed to fetch shipping settings' });
  }
};

module.exports = {
  createShippingMethod,
  getActiveShippingMethods,
  getAllShippingMethods,
  getShippingMethodById,
  updateShippingMethod,
  deleteShippingMethod,
  toggleShippingMethodStatus,
  getInternationalZones,
  getInternationalRate,
  getShippingSettings
};
