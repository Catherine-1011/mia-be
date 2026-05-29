const prisma = require("../config/prisma");
const { findOrCreateAttribute, findOrCreateAttributeValue } = require("../utils/productVariantUtils");

// GET ALL ATTRIBUTES (Public/Seller - for form dropdowns)
exports.getAllAttributes = async (request, reply) => {
  try {
    const attributes = await prisma.attribute.findMany({
      where: { isActive: true },
      include: {
        attributeValues: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' }
        }
      },
      orderBy: { sortOrder: 'asc' }
    });

    return reply.status(200).send({
      success: true,
      attributes: attributes.map(attr => ({
        id: attr.id,
        name: attr.name,
        displayName: attr.displayName,
        valueType: attr.valueType || 'text',
        isRequired: attr.isRequired,
        values: attr.attributeValues.map(val => ({
          id: val.id,
          value: val.value,
          displayValue: val.displayValue,
          hexColor: val.hexColor
        }))
      }))
    });
  } catch (err) {
    console.error("Get attributes error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// CREATE ATTRIBUTE (Admin only)
exports.createAttribute = async (request, reply) => {
  try {
    const { name, displayName, isRequired, sortOrder, valueType, values } = request.body;

    if (!name || !displayName) {
      return reply.status(400).send({
        success: false,
        message: "Name and displayName are required"
      });
    }

    // Validate valueType
    const resolvedValueType = ['text', 'number'].includes(valueType) ? valueType : 'text';

    // Check if attribute already exists
    const existing = await prisma.attribute.findUnique({
      where: { name: name.toLowerCase() }
    });

    if (existing) {
      return reply.status(409).send({
        success: false,
        message: "Attribute with this name already exists"
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Create the attribute
      const attribute = await tx.attribute.create({
        data: {
          name: name.toLowerCase(),
          displayName,
          valueType: resolvedValueType,
          isRequired: isRequired || false,
          sortOrder: sortOrder || 0,
          isActive: true
        }
      });

      // Create attribute values if provided
      const createdValues = [];
      if (values && Array.isArray(values)) {
        for (const val of values) {
          if (val.value) {
            const attributeValue = await tx.attributeValue.create({
              data: {
                attributeId: attribute.id,
                value: val.value,
                displayValue: val.displayValue || val.value,
                hexColor: val.hexColor || null,
                sortOrder: val.sortOrder || 0,
                isActive: true
              }
            });
            createdValues.push(attributeValue);
          }
        }
      }

      return { attribute, values: createdValues };
    });

    return reply.status(201).send({
      success: true,
      message: "Attribute created successfully",
      attribute: {
        ...result.attribute,
        values: result.values
      }
    });
  } catch (err) {
    console.error("Create attribute error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// UPDATE ATTRIBUTE (Admin only)
exports.updateAttribute = async (request, reply) => {
  try {
    const { id } = request.params;
    const { displayName, isRequired, sortOrder, isActive, valueType } = request.body;

    const attribute = await prisma.attribute.findUnique({
      where: { id }
    });

    if (!attribute) {
      return reply.status(404).send({
        success: false,
        message: "Attribute not found"
      });
    }

    const updatedAttribute = await prisma.attribute.update({
      where: { id },
      data: {
        displayName: displayName || attribute.displayName,
        valueType: ['text', 'number'].includes(valueType) ? valueType : attribute.valueType,
        isRequired: isRequired !== undefined ? isRequired : attribute.isRequired,
        sortOrder: sortOrder !== undefined ? sortOrder : attribute.sortOrder,
        isActive: isActive !== undefined ? isActive : attribute.isActive
      }
    });

    return reply.status(200).send({
      success: true,
      message: "Attribute updated successfully",
      attribute: updatedAttribute
    });
  } catch (err) {
    console.error("Update attribute error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// ADD ATTRIBUTE VALUE (Admin only)
exports.addAttributeValue = async (request, reply) => {
  try {
    const { attributeId } = request.params;
    const { value, displayValue, hexColor, sortOrder } = request.body;

    if (!value) {
      return reply.status(400).send({
        success: false,
        message: "Value is required"
      });
    }

    // Check if attribute exists
    const attribute = await prisma.attribute.findUnique({
      where: { id: attributeId }
    });

    if (!attribute) {
      return reply.status(404).send({
        success: false,
        message: "Attribute not found"
      });
    }

    // Check if value already exists for this attribute
    const existing = await prisma.attributeValue.findUnique({
      where: {
        attributeId_value: {
          attributeId,
          value
        }
      }
    });

    if (existing) {
      return reply.status(409).send({
        success: false,
        message: "This attribute value already exists"
      });
    }

    const attributeValue = await prisma.attributeValue.create({
      data: {
        attributeId,
        value,
        displayValue: displayValue || value,
        hexColor,
        sortOrder: sortOrder || 0,
        isActive: true
      }
    });

    return reply.status(201).send({
      success: true,
      message: "Attribute value added successfully",
      attributeValue
    });
  } catch (err) {
    console.error("Add attribute value error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// GET ATTRIBUTE VALUES (Public - for specific attribute)
exports.getAttributeValues = async (request, reply) => {
  try {
    const { attributeId } = request.params;

    const attributeValues = await prisma.attributeValue.findMany({
      where: { 
        attributeId,
        isActive: true 
      },
      orderBy: { sortOrder: 'asc' }
    });

    return reply.status(200).send({
      success: true,
      attributeValues
    });
  } catch (err) {
    console.error("Get attribute values error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// DELETE ATTRIBUTE (Admin only)
exports.deleteAttribute = async (request, reply) => {
  try {
    const { id } = request.params;

    // Check if attribute is in use
    const attributeInUse = await prisma.variantAttributeValue.findFirst({
      where: {
        attributeValue: {
          attributeId: id
        }
      }
    });

    if (attributeInUse) {
      return reply.status(400).send({
        success: false,
        message: "Cannot delete attribute that is currently in use by products"
      });
    }

    await prisma.$transaction(async (tx) => {
      // Delete all attribute values first
      await tx.attributeValue.deleteMany({
        where: { attributeId: id }
      });

      // Then delete the attribute
      await tx.attribute.delete({
        where: { id }
      });
    });

    return reply.status(200).send({
      success: true,
      message: "Attribute deleted successfully"
    });
  } catch (err) {
    console.error("Delete attribute error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

module.exports = {
  getAllAttributes: exports.getAllAttributes,
  createAttribute: exports.createAttribute,
  updateAttribute: exports.updateAttribute,
  addAttributeValue: exports.addAttributeValue,
  getAttributeValues: exports.getAttributeValues,
  deleteAttribute: exports.deleteAttribute
};