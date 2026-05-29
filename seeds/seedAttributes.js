const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedAttributes() {
  try {
    console.log('🌱 Seeding basic attributes for product variants...');

    // Create Size attribute
    const sizeAttribute = await prisma.attribute.upsert({
      where: { name: 'size' },
      update: {},
      create: {
        name: 'size',
        displayName: 'Size',
        isRequired: false,
        sortOrder: 1,
        isActive: true
      }
    });

    // Create Color attribute  
    const colorAttribute = await prisma.attribute.upsert({
      where: { name: 'color' },
      update: {},
      create: {
        name: 'color',
        displayName: 'Color',
        isRequired: false,
        sortOrder: 2,
        isActive: true
      }
    });

    // Create Material attribute
    const materialAttribute = await prisma.attribute.upsert({
      where: { name: 'material' },
      update: {},
      create: {
        name: 'material',
        displayName: 'Material',
        isRequired: false,
        sortOrder: 3,
        isActive: true
      }
    });

    console.log('✅ Attributes created successfully');

    // Create common size values
    const sizeValues = [
      { value: 'XS', displayValue: 'Extra Small', sortOrder: 1 },
      { value: 'S', displayValue: 'Small', sortOrder: 2 },
      { value: 'M', displayValue: 'Medium', sortOrder: 3 },
      { value: 'L', displayValue: 'Large', sortOrder: 4 },
      { value: 'XL', displayValue: 'Extra Large', sortOrder: 5 },
      { value: 'XXL', displayValue: '2X Large', sortOrder: 6 }
    ];

    for (const sizeVal of sizeValues) {
      await prisma.attributeValue.upsert({
        where: {
          attributeId_value: {
            attributeId: sizeAttribute.id,
            value: sizeVal.value
          }
        },
        update: {},
        create: {
          attributeId: sizeAttribute.id,
          value: sizeVal.value,
          displayValue: sizeVal.displayValue,
          sortOrder: sizeVal.sortOrder,
          isActive: true
        }
      });
    }

    // Create common color values
    const colorValues = [
      { value: 'Red', displayValue: 'Red', hexColor: '#FF0000', sortOrder: 1 },
      { value: 'Blue', displayValue: 'Blue', hexColor: '#0000FF', sortOrder: 2 },
      { value: 'Green', displayValue: 'Green', hexColor: '#008000', sortOrder: 3 },
      { value: 'Black', displayValue: 'Black', hexColor: '#000000', sortOrder: 4 },
      { value: 'White', displayValue: 'White', hexColor: '#FFFFFF', sortOrder: 5 },
      { value: 'Yellow', displayValue: 'Yellow', hexColor: '#FFFF00', sortOrder: 6 },
      { value: 'Purple', displayValue: 'Purple', hexColor: '#800080', sortOrder: 7 },
      { value: 'Orange', displayValue: 'Orange', hexColor: '#FFA500', sortOrder: 8 },
      { value: 'Pink', displayValue: 'Pink', hexColor: '#FFC0CB', sortOrder: 9 },
      { value: 'Gray', displayValue: 'Gray', hexColor: '#808080', sortOrder: 10 }
    ];

    for (const colorVal of colorValues) {
      await prisma.attributeValue.upsert({
        where: {
          attributeId_value: {
            attributeId: colorAttribute.id,
            value: colorVal.value
          }
        },
        update: {},
        create: {
          attributeId: colorAttribute.id,
          value: colorVal.value,
          displayValue: colorVal.displayValue,
          hexColor: colorVal.hexColor,
          sortOrder: colorVal.sortOrder,
          isActive: true
        }
      });
    }

    // Create common material values
    const materialValues = [
      { value: 'Cotton', displayValue: 'Cotton', sortOrder: 1 },
      { value: 'Polyester', displayValue: 'Polyester', sortOrder: 2 },
      { value: 'Wool', displayValue: 'Wool', sortOrder: 3 },
      { value: 'Leather', displayValue: 'Leather', sortOrder: 4 },
      { value: 'Silk', displayValue: 'Silk', sortOrder: 5 },
      { value: 'Denim', displayValue: 'Denim', sortOrder: 6 },
      { value: 'Linen', displayValue: 'Linen', sortOrder: 7 },
      { value: 'Canvas', displayValue: 'Canvas', sortOrder: 8 }
    ];

    for (const materialVal of materialValues) {
      await prisma.attributeValue.upsert({
        where: {
          attributeId_value: {
            attributeId: materialAttribute.id,
            value: materialVal.value
          }
        },
        update: {},
        create: {
          attributeId: materialAttribute.id,
          value: materialVal.value,
          displayValue: materialVal.displayValue,
          sortOrder: materialVal.sortOrder,
          isActive: true
        }
      });
    }

    console.log('✅ Attribute values seeded successfully');
    console.log('\n🎉 Product variants system is ready!');
    console.log('\nAvailable API endpoints:');
    console.log('- GET /api/attributes - Get all attributes with values');
    console.log('- POST /api/products - Create SIMPLE or VARIABLE products');
    console.log('- GET /api/products/:id - Get product with variants (if VARIABLE)');
    console.log('\nExample VARIABLE product creation:');
    console.log(JSON.stringify({
      title: "T-Shirt",
      description: "Cotton T-Shirt",
      type: "VARIABLE",
      category: "Clothing", 
      weight: 0.5,
      variants: [
        {
          price: 25.00,
          stock: 10,
          sku: "TSHIRT-RED-S",
          attributes: { color: "Red", size: "S" }
        },
        {
          price: 25.00,
          stock: 5,
          sku: "TSHIRT-BLUE-M", 
          attributes: { color: "Blue", size: "M" }
        }
      ]
    }, null, 2));

  } catch (error) {
    console.error('❌ Error seeding attributes:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  seedAttributes();
}

module.exports = { seedAttributes };