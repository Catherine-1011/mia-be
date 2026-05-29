const prisma = require('../config/prisma');

/**
 * ADMIN ONLY - Create a new GST setting
 */
const createGST = async (request, reply) => {
  try {
    const { name, percentage, description, isActive, isDefault } = request.body;

    // Validate required fields
    if (!name || percentage === undefined) {
      return reply.status(400).send({
        success: false,
        message: "Name and percentage are required"
      });
    }

    // Validate percentage range (0-100)
    if (parseFloat(percentage) < 0 || parseFloat(percentage) > 100) {
      return reply.status(400).send({
        success: false,
        message: "GST percentage must be between 0 and 100"
      });
    }

    // Check if GST with same name exists
    const existingGST = await prisma.gST.findUnique({
      where: { name }
    });

    if (existingGST) {
      return reply.status(400).send({
        success: false,
        message: "A GST setting with this name already exists"
      });
    }

    // If this is being set as default, unset other defaults
    if (isDefault) {
      await prisma.gST.updateMany({
        where: { isDefault: true },
        data: { isDefault: false }
      });
    }

    // Create new GST setting
    const gst = await prisma.gST.create({
      data: {
        name,
        percentage: parseFloat(percentage),
        description,
        isActive: isActive !== undefined ? isActive : true,
        isDefault: isDefault || false
      }
    });

    return reply.status(201).send({
      success: true,
      message: "GST setting created successfully",
      data: gst
    });
  } catch (error) {
    console.error("Error creating GST:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to create GST setting",
      error: error.message
    });
  }
};

/**
 * PUBLIC - Get all active GST settings
 */
const getActiveGST = async (request, reply) => {
  try {
    const gstSettings = await prisma.gST.findMany({
      where: { isActive: true },
      orderBy: { percentage: 'asc' }
    });

    return reply.status(200).send({
      success: true,
      count: gstSettings.length,
      data: gstSettings
    });
  } catch (error) {
    console.error("Error fetching active GST settings:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to fetch GST settings",
      error: error.message
    });
  }
};

/**
 * PUBLIC - Get default GST setting
 */
const getDefaultGST = async (request, reply) => {
  try {
    const defaultGST = await prisma.gST.findFirst({
      where: { 
        isActive: true,
        isDefault: true 
      }
    });

    if (!defaultGST) {
      return reply.status(404).send({
        success: false,
        message: "No default GST setting found"
      });
    }

    return reply.status(200).send({
      success: true,
      data: defaultGST
    });
  } catch (error) {
    console.error("Error fetching default GST:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to fetch default GST",
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Get all GST settings (including inactive)
 */
const getAllGST = async (request, reply) => {
  try {
    const gstSettings = await prisma.gST.findMany({
      orderBy: { createdAt: 'desc' }
    });

    return reply.status(200).send({
      success: true,
      count: gstSettings.length,
      data: gstSettings
    });
  } catch (error) {
    console.error("Error fetching GST settings:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to fetch GST settings",
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Get single GST setting by ID
 */
const getGSTById = async (request, reply) => {
  try {
    const { id } = request.params;

    const gst = await prisma.gST.findUnique({
      where: { id }
    });

    if (!gst) {
      return reply.status(404).send({
        success: false,
        message: "GST setting not found"
      });
    }

    return reply.status(200).send({
      success: true,
      data: gst
    });
  } catch (error) {
    console.error("Error fetching GST setting:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to fetch GST setting",
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Update GST setting
 */
const updateGST = async (request, reply) => {
  try {
    const { id } = request.params;
    const { name, percentage, description, isActive, isDefault } = request.body;

    // Check if GST setting exists
    const existingGST = await prisma.gST.findUnique({
      where: { id }
    });

    if (!existingGST) {
      return reply.status(404).send({
        success: false,
        message: "GST setting not found"
      });
    }

    // Validate percentage if provided
    if (percentage !== undefined) {
      if (parseFloat(percentage) < 0 || parseFloat(percentage) > 100) {
        return reply.status(400).send({
          success: false,
          message: "GST percentage must be between 0 and 100"
        });
      }
    }

    // If name is being updated, check for duplicates
    if (name && name !== existingGST.name) {
      const duplicateName = await prisma.gST.findUnique({
        where: { name }
      });

      if (duplicateName) {
        return reply.status(400).send({
          success: false,
          message: "A GST setting with this name already exists"
        });
      }
    }

    // If setting as default, unset other defaults
    if (isDefault === true) {
      await prisma.gST.updateMany({
        where: { 
          id: { not: id },
          isDefault: true 
        },
        data: { isDefault: false }
      });
    }

    // Update GST setting
    const updatedGST = await prisma.gST.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(percentage !== undefined && { percentage: parseFloat(percentage) }),
        ...(isActive !== undefined && { isActive }),
        ...(isDefault !== undefined && { isDefault })
      }
    });

    return reply.status(200).send({
      success: true,
      message: "GST setting updated successfully",
      data: updatedGST
    });
  } catch (error) {
    console.error("Error updating GST setting:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to update GST setting",
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Delete GST setting
 */
const deleteGST = async (request, reply) => {
  try {
    const { id } = request.params;

    // Check if GST setting exists
    const existingGST = await prisma.gST.findUnique({
      where: { id }
    });

    if (!existingGST) {
      return reply.status(404).send({
        success: false,
        message: "GST setting not found"
      });
    }

    // Prevent deletion of default GST
    if (existingGST.isDefault) {
      return reply.status(400).send({
        success: false,
        message: "Cannot delete the default GST setting. Please set another GST as default first."
      });
    }

    // Delete the GST setting
    await prisma.gST.delete({
      where: { id }
    });

    return reply.status(200).send({
      success: true,
      message: "GST setting deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting GST setting:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to delete GST setting",
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Toggle GST active status
 */
const toggleGSTStatus = async (request, reply) => {
  try {
    const { id } = request.params;

    const gst = await prisma.gST.findUnique({
      where: { id }
    });

    if (!gst) {
      return reply.status(404).send({
        success: false,
        message: "GST setting not found"
      });
    }

    // Prevent deactivating default GST
    if (gst.isDefault && gst.isActive) {
      return reply.status(400).send({
        success: false,
        message: "Cannot deactivate the default GST setting. Please set another GST as default first."
      });
    }

    // Toggle the isActive status
    const updatedGST = await prisma.gST.update({
      where: { id },
      data: { isActive: !gst.isActive }
    });

    return reply.status(200).send({
      success: true,
      message: `GST setting ${updatedGST.isActive ? 'activated' : 'deactivated'} successfully`,
      data: updatedGST
    });
  } catch (error) {
    console.error("Error toggling GST status:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to toggle GST status",
      error: error.message
    });
  }
};

/**
 * ADMIN ONLY - Set GST as default
 */
const setDefaultGST = async (request, reply) => {
  try {
    const { id } = request.params;

    const gst = await prisma.gST.findUnique({
      where: { id }
    });

    if (!gst) {
      return reply.status(404).send({
        success: false,
        message: "GST setting not found"
      });
    }

    // Unset all other defaults
    await prisma.gST.updateMany({
      where: { 
        id: { not: id },
        isDefault: true 
      },
      data: { isDefault: false }
    });

    // Set this GST as default and active
    const updatedGST = await prisma.gST.update({
      where: { id },
      data: { 
        isDefault: true,
        isActive: true 
      }
    });

    return reply.status(200).send({
      success: true,
      message: "GST setting set as default successfully",
      data: updatedGST
    });
  } catch (error) {
    console.error("Error setting default GST:", error);
    return reply.status(500).send({
      success: false,
      message: "Failed to set default GST",
      error: error.message
    });
  }
};

module.exports = {
  createGST,
  getActiveGST,
  getDefaultGST,
  getAllGST,
  getGSTById,
  updateGST,
  deleteGST,
  toggleGSTStatus,
  setDefaultGST
};
