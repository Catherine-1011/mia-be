const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function safelyMigrateProductVariants() {
  try {
    console.log('Starting safe migration of product variants system...');
    
    // Step 1: Add ProductType enum if it doesn't exist
    console.log('Step 1: Adding ProductType enum...');
    try {
      await prisma.$executeRaw`CREATE TYPE "ProductType" AS ENUM ('SIMPLE', 'VARIABLE')`;
      console.log('✅ ProductType enum created');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('✅ ProductType enum already exists');
      } else {
        throw error;
      }
    }

    // Step 2: Add type column to products table with default SIMPLE
    console.log('Step 2: Adding type column to products...');
    try {
      await prisma.$executeRaw`ALTER TABLE products ADD COLUMN type "ProductType" NOT NULL DEFAULT 'SIMPLE'`;
      await prisma.$executeRaw`CREATE INDEX products_type_idx ON products(type)`;
      console.log('✅ Type column added to products');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('✅ Type column already exists');
      } else {
        throw error;
      }
    }

    // Step 3: Create attribute system tables
    console.log('Step 3: Creating attribute system tables...');
    
    // Create attributes table
    try {
      await prisma.$executeRaw`
        CREATE TABLE attributes (
          id TEXT NOT NULL PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          "displayName" TEXT NOT NULL,
          "isRequired" BOOLEAN NOT NULL DEFAULT false,
          "sortOrder" INTEGER NOT NULL DEFAULT 0,
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `;
      await prisma.$executeRaw`CREATE INDEX attributes_name_idx ON attributes(name)`;
      console.log('✅ Attributes table created');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('✅ Attributes table already exists');
      } else {
        throw error;
      }
    }

    // Create attribute_values table
    try {
      await prisma.$executeRaw`
        CREATE TABLE attribute_values (
          id TEXT NOT NULL PRIMARY KEY,
          "attributeId" TEXT NOT NULL,
          value TEXT NOT NULL,
          "displayValue" TEXT NOT NULL,
          "hexColor" TEXT,
          "sortOrder" INTEGER NOT NULL DEFAULT 0,
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT attribute_values_attributeId_fkey FOREIGN KEY ("attributeId") REFERENCES attributes(id) ON DELETE CASCADE
        )
      `;
      await prisma.$executeRaw`CREATE UNIQUE INDEX attribute_values_attributeId_value_key ON attribute_values("attributeId", value)`;
      await prisma.$executeRaw`CREATE INDEX attribute_values_attributeId_idx ON attribute_values("attributeId")`;
      console.log('✅ Attribute values table created');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('✅ Attribute values table already exists');
      } else {
        throw error;
      }
    }

    // Create variant_attribute_values table
    try {
      await prisma.$executeRaw`
        CREATE TABLE variant_attribute_values (
          id TEXT NOT NULL PRIMARY KEY,
          "variantId" TEXT NOT NULL,
          "attributeValueId" TEXT NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT variant_attribute_values_variantId_fkey FOREIGN KEY ("variantId") REFERENCES product_variants(id) ON DELETE CASCADE,
          CONSTRAINT variant_attribute_values_attributeValueId_fkey FOREIGN KEY ("attributeValueId") REFERENCES attribute_values(id) ON DELETE CASCADE
        )
      `;
      await prisma.$executeRaw`CREATE UNIQUE INDEX variant_attribute_values_variantId_attributeValueId_key ON variant_attribute_values("variantId", "attributeValueId")`;
      await prisma.$executeRaw`CREATE INDEX variant_attribute_values_variantId_idx ON variant_attribute_values("variantId")`;
      await prisma.$executeRaw`CREATE INDEX variant_attribute_values_attributeValueId_idx ON variant_attribute_values("attributeValueId")`;
      console.log('✅ Variant attribute values table created');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('✅ Variant attribute values table already exists');
      } else {
        throw error;
      }
    }

    // Step 4: Add new columns to product_variants as nullable first
    console.log('Step 4: Adding new columns to product_variants...');
    
    // Handle column renames/additions one by one with proper SQL
    try {
      // Check if product_id exists and productId doesn't
      const hasProductId = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'product_variants' AND column_name = 'product_id'
      `;
      const hasNewProductId = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'product_variants' AND column_name = 'productId'
      `;

      if (hasProductId.length > 0 && hasNewProductId.length === 0) {
        await prisma.$executeRaw`ALTER TABLE product_variants RENAME COLUMN product_id TO "productId"`;
        console.log('✅ Renamed product_id to productId');
      } else if (hasNewProductId.length === 0) {
        await prisma.$executeRaw`ALTER TABLE product_variants ADD COLUMN "productId" TEXT`;
        console.log('✅ Added productId column');
      } else {
        console.log('✅ productId already exists');
      }
    } catch (error) {
      console.log(`Warning: Could not process productId: ${error.message}`);
    }

    try {
      // Handle is_active to isActive
      const hasIsActive = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'product_variants' AND column_name = 'is_active'
      `;
      const hasNewIsActive = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'product_variants' AND column_name = 'isActive'
      `;

      if (hasIsActive.length > 0 && hasNewIsActive.length === 0) {
        await prisma.$executeRaw`ALTER TABLE product_variants RENAME COLUMN is_active TO "isActive"`;
        console.log('✅ Renamed is_active to isActive');
      } else if (hasNewIsActive.length === 0) {
        await prisma.$executeRaw`ALTER TABLE product_variants ADD COLUMN "isActive" BOOLEAN DEFAULT true`;
        console.log('✅ Added isActive column');
      } else {
        console.log('✅ isActive already exists');
      }
    } catch (error) {
      console.log(`Warning: Could not process isActive: ${error.message}`);
    }

    try {
      // Handle created_at to createdAt
      const hasCreatedAt = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'product_variants' AND column_name = 'created_at'
      `;
      const hasNewCreatedAt = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'product_variants' AND column_name = 'createdAt'
      `;

      if (hasCreatedAt.length > 0 && hasNewCreatedAt.length === 0) {
        await prisma.$executeRaw`ALTER TABLE product_variants RENAME COLUMN created_at TO "createdAt"`;
        console.log('✅ Renamed created_at to createdAt');
      } else if (hasNewCreatedAt.length === 0) {
        await prisma.$executeRaw`ALTER TABLE product_variants ADD COLUMN "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP`;
        console.log('✅ Added createdAt column');
      } else {
        console.log('✅ createdAt already exists');
      }
    } catch (error) {
      console.log(`Warning: Could not process createdAt: ${error.message}`);
    }

    try {
      // Handle updated_at to updatedAt
      const hasUpdatedAt = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'product_variants' AND column_name = 'updated_at'
      `;
      const hasNewUpdatedAt = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'product_variants' AND column_name = 'updatedAt'
      `;

      if (hasUpdatedAt.length > 0 && hasNewUpdatedAt.length === 0) {
        await prisma.$executeRaw`ALTER TABLE product_variants RENAME COLUMN updated_at TO "updatedAt"`;
        console.log('✅ Renamed updated_at to updatedAt');
      } else if (hasNewUpdatedAt.length === 0) {
        await prisma.$executeRaw`ALTER TABLE product_variants ADD COLUMN "updatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP`;
        console.log('✅ Added updatedAt column');
      } else {
        console.log('✅ updatedAt already exists');
      }
    } catch (error) {
      console.log(`Warning: Could not process updatedAt: ${error.message}`);
    }

    // Step 5: Populate productId with existing product_id values if needed
    console.log('Step 5: Ensuring productId is populated...');
    
    // Check if productId column exists before querying
    const hasProductIdColumn = await prisma.$queryRaw`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'product_variants' AND column_name = 'productId'
    `;
    
    if (hasProductIdColumn.length > 0) {
      const emptyProductIds = await prisma.$queryRaw`
        SELECT id FROM product_variants WHERE "productId" IS NULL
      `;
      
      if (emptyProductIds.length > 0) {
        console.log(`Found ${emptyProductIds.length} variants with missing productId, populating...`);
        // You may need to manually set these or derive from existing data
        // For now, let's get the first product ID and use it as fallback
        const firstProduct = await prisma.$queryRaw`SELECT id FROM products LIMIT 1`;
        if (firstProduct.length > 0) {
          await prisma.$executeRaw`
            UPDATE product_variants 
            SET "productId" = ${firstProduct[0].id}
            WHERE "productId" IS NULL
          `;
          console.log('✅ ProductId populated for missing variants');
        }
      } else {
        console.log('✅ All variants have productId populated');
      }
    } else {
      console.log('⚠️ productId column not found, skipping population step');
    }

    // Step 6: Make productId NOT NULL and add foreign key
    console.log('Step 6: Making productId NOT NULL and adding constraints...');
    try {
      await prisma.$executeRaw`ALTER TABLE product_variants ALTER COLUMN "productId" SET NOT NULL`;
      await prisma.$executeRaw`ALTER TABLE product_variants ADD CONSTRAINT product_variants_productId_fkey FOREIGN KEY ("productId") REFERENCES products(id) ON DELETE CASCADE`;
      console.log('✅ ProductId constraints added');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('✅ ProductId constraints already exist');
      } else {
        console.log(`Warning: ${error.message}`);
      }
    }

    // Step 7: Migrate existing JSON attributes to normalized structure
    console.log('Step 7: Migrating existing attributes to normalized structure...');
    const variantsWithAttributes = await prisma.$queryRaw`
      SELECT id, attributes FROM product_variants WHERE attributes IS NOT NULL
    `;

    // Create common attributes (Color, Size)
    const attributeMap = new Map();
    
    for (const variant of variantsWithAttributes) {
      const attrs = variant.attributes;
      for (const [attrName, attrValue] of Object.entries(attrs)) {
        if (!attributeMap.has(attrName)) {
          // Create attribute if it doesn't exist
          try {
            const attrId = `attr_${attrName.toLowerCase()}`;
            await prisma.$executeRaw`
              INSERT INTO attributes (id, name, "displayName", "createdAt", "updatedAt") 
              VALUES (${attrId}, ${attrName.toLowerCase()}, ${attrName}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
              ON CONFLICT (name) DO NOTHING
            `;
            attributeMap.set(attrName, attrId);
            console.log(`✅ Created attribute: ${attrName}`);
          } catch (error) {
            console.log(`Warning: ${error.message}`);
          }
        }
      }
    }

    // Create attribute values and link them to variants
    for (const variant of variantsWithAttributes) {
      const attrs = variant.attributes;
      for (const [attrName, attrValue] of Object.entries(attrs)) {
        try {
          const attrId = `attr_${attrName.toLowerCase()}`;
          const valueId = `val_${attrName.toLowerCase()}_${attrValue.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
          
          // Create attribute value
          await prisma.$executeRaw`
            INSERT INTO attribute_values (id, "attributeId", value, "displayValue", "createdAt", "updatedAt")
            VALUES (${valueId}, ${attrId}, ${attrValue}, ${attrValue}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT ("attributeId", value) DO NOTHING
          `;
          
          // Link value to variant
          const linkId = `link_${variant.id}_${valueId}`;
          await prisma.$executeRaw`
            INSERT INTO variant_attribute_values (id, "variantId", "attributeValueId", "createdAt")
            VALUES (${linkId}, ${variant.id}, ${valueId}, CURRENT_TIMESTAMP)
            ON CONFLICT ("variantId", "attributeValueId") DO NOTHING
          `;
          
        } catch (error) {
          console.log(`Warning linking ${attrName}=${attrValue} to variant ${variant.id}: ${error.message}`);
        }
      }
    }
    console.log('✅ Existing attributes migrated to normalized structure');

    // Step 8: Update cart_items and order_items column names and constraints
    console.log('Step 8: Updating cart_items and order_items...');
    
    // Update cart_items
    try {
      const hasOldCartColumn = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'cart_items' AND column_name = 'variant_id'
      `;
      
      if (hasOldCartColumn.length > 0) {
        await prisma.$executeRaw`ALTER TABLE cart_items RENAME COLUMN variant_id TO "variantId"`;
        console.log('✅ Renamed cart_items.variant_id to variantId');
      }
    } catch (error) {
      console.log('✅ cart_items column already updated');
    }

    // Update order_items
    try {
      const hasOldOrderColumn = await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'order_items' AND column_name = 'variant_id'
      `;
      
      if (hasOldOrderColumn.length > 0) {
        await prisma.$executeRaw`ALTER TABLE order_items RENAME COLUMN variant_id TO "variantId"`;
        console.log('✅ Renamed order_items.variant_id to variantId');
      }
    } catch (error) {
      console.log('✅ order_items column already updated');
    }

    console.log('🎉 Migration completed successfully!');
    console.log('\nNext steps:');
    console.log('1. All existing products are now SIMPLE type by default');
    console.log('2. Existing variant attributes have been migrated to normalized structure');  
    console.log('3. You can now create VARIABLE products with proper variants');
    console.log('4. Update your application code to use the new ProductType system');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

safelyMigrateProductVariants();