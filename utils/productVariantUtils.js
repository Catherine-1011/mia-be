const prisma = require("../config/prisma");

// Create attribute if it doesn't exist
const findOrCreateAttribute = async (name, displayName = null, valueType = 'text') => {
  const normalizedName = name.toLowerCase();
  
  let attribute = await prisma.attribute.findUnique({
    where: { name: normalizedName }
  });

  if (!attribute) {
    const resolvedValueType = ['text', 'number'].includes(valueType) ? valueType : 'text';
    attribute = await prisma.attribute.create({
      data: {
        name: normalizedName,
        displayName: displayName || name,
        valueType: resolvedValueType,
        isActive: true
      }
    });
  }

  return attribute;
};

// Create attribute value if it doesn't exist
const findOrCreateAttributeValue = async (attributeId, value, displayValue = null, hexColor = null) => {
  const valueString = value.toString();
  
  let attributeValue = await prisma.attributeValue.findUnique({
    where: {
      attributeId_value: {
        attributeId,
        value: valueString
      }
    }
  });

  if (!attributeValue) {
    attributeValue = await prisma.attributeValue.create({
      data: {
        attributeId,
        value: valueString,
        displayValue: displayValue || valueString,
        hexColor,
        isActive: true
      }
    });
  }

  return attributeValue;
};

// Get product variants with their attributes
const getProductVariantsWithAttributes = async (productId) => {
  const variantRows = await prisma.$queryRaw`
    SELECT pv.id, pv."productId", pv.price, pv.stock, pv.sku, pv."isActive",
           pv.images, pv."createdAt", pv."updatedAt",
           a.id as "attr_id", a.name as "attr_name", a."displayName" as "attr_display_name",
           a."valueType" as "attr_value_type",
           av.id as "attr_value_id", av.value as "attr_value", av."displayValue" as "attr_display_value",
           av."hexColor" as "attr_hex_color"
    FROM "product_variants" pv
    LEFT JOIN "variant_attribute_values" vav ON pv.id = vav."variantId"
    LEFT JOIN "attribute_values" av ON vav."attributeValueId" = av.id
    LEFT JOIN "attributes" a ON av."attributeId" = a.id
    WHERE pv."productId" = ${productId}
    ORDER BY pv."createdAt", a."sortOrder", av."sortOrder"
  `;

  // Group variants with their attributes
  const variantMap = new Map();
  
  variantRows.forEach(row => {
    if (!variantMap.has(row.id)) {
      variantMap.set(row.id, {
        id: row.id,
        productId: row.productId,
        price: row.price,
        stock: row.stock,
        sku: row.sku,
        isActive: row.isActive,
        images: row.images,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        attributes: {}
      });
    }
    
    const variant = variantMap.get(row.id);
    if (row.attr_name && row.attr_value) {
      variant.attributes[row.attr_name] = {
        value: row.attr_value,
        displayValue: row.attr_display_value,
        hexColor: row.attr_hex_color,
        valueType: row.attr_value_type || 'text'
      };
    }
  });
  
  return Array.from(variantMap.values());
};

// Calculate total stock for VARIABLE products
const calculateVariableProductStock = async (productId) => {
  const result = await prisma.$queryRaw`
    SELECT SUM(stock) as total_stock, COUNT(*) as variant_count, 
           SUM(CASE WHEN stock > 0 AND "isActive" = true THEN 1 ELSE 0 END) as active_variants
    FROM "product_variants" 
    WHERE "productId" = ${productId}
  `;
  
  return {
    totalStock: parseInt(result[0]?.total_stock || 0),
    variantCount: parseInt(result[0]?.variant_count || 0),
    activeVariants: parseInt(result[0]?.active_variants || 0)
  };
};

// Check if a product should be active based on stock rules
const shouldProductBeActive = async (productId, productType) => {
  if (productType === 'SIMPLE') {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stock: true, status: true }
    });
    return product?.status === 'ACTIVE' && product?.stock > 0;
  } else if (productType === 'VARIABLE') {
    const stockInfo = await calculateVariableProductStock(productId);
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { status: true }
    });
    return product?.status === 'ACTIVE' && stockInfo.activeVariants > 0;
  }
  return false;
};

// Validate SKU uniqueness
const isSkuUnique = async (sku, excludeVariantId = null) => {
  const whereClause = excludeVariantId 
    ? { sku, NOT: { id: excludeVariantId } }
    : { sku };
    
  const existingVariant = await prisma.productVariant.findUnique({
    where: whereClause
  });
  
  return !existingVariant;
};

module.exports = {
  findOrCreateAttribute,
  findOrCreateAttributeValue,
  getProductVariantsWithAttributes,
  calculateVariableProductStock,
  shouldProductBeActive,
  isSkuUnique
};