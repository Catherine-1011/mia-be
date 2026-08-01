const prisma = require("../config/prisma");
const { Prisma } = require('@prisma/client');
const { invalidateCache } = require('../utils/cacheInvalidation');
const {
  notifySellerProductStatusChange,
  notifySellerLowStock,
  notifyAdminNewProduct,
  notifyAdminProductPending,
  notifyAdminLowStockDeactivation,
  notifyAdminProductSubmitReview,
  notifyAdminProductSellerDeactivated,
  notifyAdminVariantStatusChange,
  notifySellerVariantStatusChange
} = require("./notification");
const {
  sendSellerLowStockEmail,
  sendAdminProductPendingEmail,
  sendAdminProductSellerDeactivatedEmail,
  sendAdminProductSubmitReviewEmail,
  sendSellerProductSelfDeactivatedEmail,
  sendSellerProductSubmitReviewConfirmEmail
} = require("../utils/emailService");
const auditLogger = require("../utils/auditLogger");
const { log: auditLog, extractRequestMeta, AUDIT_ACTIONS, ENTITY_TYPES } = auditLogger;

const LOW_STOCK_THRESHOLD = 2;

// ADD PRODUCT (Seller only)
exports.addProduct = async (request, reply) => {
  let { 
    title, description, price, stock, category, featured, tags, artistName, 
    "artist name": artistNameWithSpace, weight, type, variants 
  } = request.body;
  
  // Handle both artistName and "artist name" field formats
  const finalArtistName = artistName || artistNameWithSpace || null;
  
  // Set product type (default to SIMPLE for backward compatibility)
  const productType = type && ['SIMPLE', 'VARIABLE'].includes(type.toUpperCase()) 
    ? type.toUpperCase() 
    : 'SIMPLE';
  
  // Parse type conversion for common fields
  if (typeof weight === 'string') weight = parseFloat(weight);
  featured = featured === 'true' || featured === true ? true : false;
  
  // Parse tags - can be single string or array
  let parsedTags = [];
  if (tags) {
    if (Array.isArray(tags)) {
      parsedTags = tags.filter(tag => tag && tag.trim() !== '');
    } else if (typeof tags === 'string') {
      parsedTags = tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '');
    }
  }
  
  // Validate based on product type
  if (productType === 'SIMPLE') {
    // SIMPLE products: require price and stock, no variants
    if (typeof price === 'string') price = parseFloat(price);
    if (typeof stock === 'string') stock = parseInt(stock);
    
    if (price === undefined || price === null || stock === undefined || stock === null) {
      return reply.status(400).send({
        success: false,
        message: "SIMPLE products require price and stock"
      });
    }
    
    if (variants && variants.length > 0) {
      return reply.status(400).send({
        success: false,
        message: "SIMPLE products cannot have variants"
      });
    }
  } else if (productType === 'VARIABLE') {
    // VARIABLE products: require variants array, no direct price/stock
    if (price !== undefined || stock !== undefined) {
      return reply.status(400).send({
        success: false,
        message: "VARIABLE products should not have direct price/stock. Use variants instead."
      });
    }
    
    // Parse variants if string
    let parsedVariants = [];
    if (typeof variants === 'string') {
      try {
        parsedVariants = JSON.parse(variants);
      } catch (e) {
        return reply.status(400).send({
          success: false,
          message: "Invalid variants JSON format"
        });
      }
    } else if (Array.isArray(variants)) {
      parsedVariants = variants;
    }
    
    if (!parsedVariants || parsedVariants.length === 0) {
      return reply.status(400).send({
        success: false,
        message: "VARIABLE products require at least one variant"
      });
    }
    
    // Validate each variant
    for (let i = 0; i < parsedVariants.length; i++) {
      const variant = parsedVariants[i];
      
      if (!variant.price || !variant.stock) {
        return reply.status(400).send({
          success: false,
          message: `Variant ${i + 1} must have price and stock`
        });
      }
      
      if (!variant.sku) {
        return reply.status(400).send({
          success: false,
          message: `Variant ${i + 1} must have a unique SKU`
        });
      }
      
      if (!variant.attributes || Object.keys(variant.attributes).length === 0) {
        return reply.status(400).send({
          success: false,
          message: `Variant ${i + 1} must have at least one attribute (e.g., color, size)`
        });
      }
      
      // Convert variant price/stock to proper types
      if (typeof variant.price === 'string') variant.price = parseFloat(variant.price);
      if (typeof variant.stock === 'string') variant.stock = parseInt(variant.stock);
    }
    
    variants = parsedVariants;
  }

  let featuredImageUrl = null;
  let galleryImages = [];
  const { uploadToCloudinary } = require("../config/cloudinary");

  // If files were uploaded, upload them to Cloudinary
  if (request.files && request.files.length > 0) {
    for (const file of request.files) {
      try {
        const result = await uploadToCloudinary(file.path, 'products');
        if (file.fieldname === 'featuredImage') {
          featuredImageUrl = result.url; // Only one featured image
        } else if (file.fieldname === 'galleryImages') {
          galleryImages.push(result.url); // Gallery images field
        }
      } catch (err) {
        console.error('Cloudinary upload error:', err);
      }
    }
  } else {
    // Fallback: images provided as URLs in the body
    if (request.body.featuredImage) {
      featuredImageUrl = typeof request.body.featuredImage === 'string'
        ? request.body.featuredImage
        : request.body.featuredImage[0];
    }
    if (request.body.galleryImages) {
      if (Array.isArray(request.body.galleryImages)) {
        galleryImages = request.body.galleryImages.filter(img => img && img.trim() !== '');
      } else if (typeof request.body.galleryImages === 'string') {
        galleryImages = [request.body.galleryImages].filter(img => img && img.trim() !== '');
      }
    }
    // Backward compat: old 'images' field maps first to featuredImage, rest to gallery
    if (!featuredImageUrl && !galleryImages.length && request.body.images) {
      const imgs = Array.isArray(request.body.images) ? request.body.images : [request.body.images];
      featuredImageUrl = imgs[0] || null;
      galleryImages = imgs.slice(1);
    }
  }

  // Remove duplicates from gallery images
  galleryImages = [...new Set(galleryImages)];

  // Debug logging

  try {
    const sellerId = request.user.userId; // From authenticateSeller middleware

    // Check if seller is approved and active
    const seller = await prisma.sellerProfile.findUnique({
      where: { userId: sellerId },
      include: { user: true }
    });
    
    if (!seller) {
      return reply.status(404).send({ success: false, message: "Seller account not found" });
    }

    // Validate required fields
    if (!title || !category || weight === undefined || weight === null) {
      return reply.status(400).send({
        success: false,
        message: "Title, category, and weight are required"
      });
    }

    if (weight <= 0) {
      return reply.status(400).send({
        success: false,
        message: "Weight must be greater than 0"
      });
    }

    if (seller.status !== "APPROVED" && seller.status !== "ACTIVE") {
      return reply.status(403).send({ 
        success: false, 
        message: "Your seller account must be approved before adding products. Current status: " + seller.status 
      });
    }

    // Check if seller is inactive
    if (!seller.isActive) {
      return reply.status(403).send({
        success: false,
        message: "Your account has been deactivated. You cannot add products. Reason: " + (seller.inactiveReason || "No reason provided")
      });
    }

    // Determine product status based on user role
    const userRole = request.user.role; // From auth middleware
    let productStatus = "PENDING"; // Default for sellers - requires approval
    let isActive = false; // Will be set via raw SQL
    
    if (userRole === "ADMIN") {
      // Admin products go live immediately
      productStatus = "ACTIVE";
      isActive = true;
    } else {
      // Seller products always require approval
      productStatus = "PENDING";
      isActive = false;
    }

    // ── PRE-TRANSACTION: Resolve all attribute IDs outside the transaction ──────
    // NeonDB serverless times out when too many sequential round trips happen
    // inside a single transaction. We resolve/upsert all attributes + values
    // first (outside the tx), then only do fast inserts inside the transaction.
    let resolvedAttributeValueIds = {}; // key: "attrName:attrValue" → attributeValueId

    if (productType === 'VARIABLE' && variants && variants.length > 0) {
      // Check SKU uniqueness before starting the transaction
      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        if (variant.sku) {
          const existing = await prisma.productVariant.findUnique({ where: { sku: variant.sku } });
          if (existing) {
            return reply.status(400).send({ success: false, message: `SKU "${variant.sku}" already exists` });
          }
        }

        if (variant.attributes && typeof variant.attributes === 'object') {
          for (const [attrName, attrValue] of Object.entries(variant.attributes)) {
            const key = `${attrName.toLowerCase()}:${attrValue.toString()}`;
            if (resolvedAttributeValueIds[key]) continue; // already resolved

            // Upsert attribute (find or create) — outside transaction
            let attribute = await prisma.attribute.findUnique({
              where: { name: attrName.toLowerCase() }
            });
            if (!attribute) {
              attribute = await prisma.attribute.create({
                data: { name: attrName.toLowerCase(), displayName: attrName, isActive: true }
              });
            }

            // Upsert attribute value — outside transaction
            let attributeValue = await prisma.attributeValue.findUnique({
              where: { attributeId_value: { attributeId: attribute.id, value: attrValue.toString() } }
            });
            if (!attributeValue) {
              attributeValue = await prisma.attributeValue.create({
                data: {
                  attributeId: attribute.id,
                  value: attrValue.toString(),
                  displayValue: attrValue.toString(),
                  isActive: true
                }
              });
            }

            resolvedAttributeValueIds[key] = attributeValue.id;
          }
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── NO-TRANSACTION approach for NeonDB serverless compatibility ─────────────
    // NeonDB serverless drops connections between async JS awaits, making
    // Prisma interactive transactions (callback form) unreliable.
    // We use manual rollback instead: create product first, then variants.
    // On any failure, delete the product (cascades to variants automatically).
    let product;
    let createdVariants = [];

    try {
      // Step 1: Create the main product record
      product = await prisma.product.create({
        data: {
          title,
          description,
          type: productType,
          price: productType === 'SIMPLE' ? price : null,
          weight,
          stock: productType === 'SIMPLE' ? stock : null,
          category,
          sellerId,
          sellerName: seller.storeName || seller.businessName,
          artistName: finalArtistName,
          images: galleryImages,
          status: productStatus,
          featured,
          tags: parsedTags
        }
      });

      // Step 2: Set isActive and featuredImage via raw SQL
      await prisma.$executeRaw`UPDATE "products" SET "isActive" = ${isActive} WHERE "id" = ${product.id}`;
      if (featuredImageUrl) {
        await prisma.$executeRaw`UPDATE "products" SET "featuredImage" = ${featuredImageUrl} WHERE "id" = ${product.id}`;
      }

      // Step 3: Create variants and link attributes (VARIABLE products only)
      if (productType === 'VARIABLE' && variants && variants.length > 0) {
        for (const variant of variants) {
          const createdVariant = await prisma.productVariant.create({
            data: {
              productId: product.id,
              price: variant.price,
              stock: variant.stock,
              sku: variant.sku,
              isActive: true,
              images: variant.images || []
            }
          });

          // Link pre-resolved attribute value IDs (resolved before this block)
          if (variant.attributes && typeof variant.attributes === 'object') {
            for (const [attrName, attrValue] of Object.entries(variant.attributes)) {
              const key = `${attrName.toLowerCase()}:${attrValue.toString()}`;
              const attributeValueId = resolvedAttributeValueIds[key];
              if (attributeValueId) {
                await prisma.variantAttributeValue.create({
                  data: { variantId: createdVariant.id, attributeValueId }
                });
              }
            }
          }

          createdVariants.push({ ...createdVariant, attributes: variant.attributes });
        }
      }

    } catch (createError) {
      // Manual rollback: delete the product if it was created (cascades to variants/attributes)
      if (product?.id) {
        try {
          await prisma.product.delete({ where: { id: product.id } });
          console.warn(`🗑️ Rolled back product ${product.id} after creation error`);
        } catch (rollbackError) {
          console.error('Rollback failed:', rollbackError.message);
        }
      }
      throw createError;
    }

    // ── Audit log: product created ────────────────────────────────────────────
    auditLog({
      entityType: ENTITY_TYPES.PRODUCT,
      entityId:   product.id,
      action:     AUDIT_ACTIONS.PRODUCT_CREATED,
      newData:    { 
        ...product, 
        type: productType,
        isActive, 
        featuredImage: featuredImageUrl,
        variantsCount: createdVariants.length
      },
      ...extractRequestMeta(request),
    });

    // Update seller product count
    await prisma.sellerProfile.update({
      where: { userId: sellerId },
      data: {
        productCount: { increment: 1 },
        minimumProductsUploaded: true
      }
    });

    // ── Low stock auto-deactivation logic ──────────────────────────────────────
    let lowStockTriggered = false;
    
    if (productType === 'SIMPLE') {
      // For SIMPLE products, check the main product stock
      if (isActive && stock <= LOW_STOCK_THRESHOLD) {
        await prisma.$executeRaw`UPDATE "products" SET "isActive" = false, status = 'INACTIVE' WHERE id = ${product.id}`;
        isActive = false;
        lowStockTriggered = true;
      }
    } else if (productType === 'VARIABLE') {
      // For VARIABLE products, check if ALL variants are low stock
      const totalVariantStock = createdVariants.reduce((sum, v) => sum + v.stock, 0);
      const hasActiveVariants = createdVariants.some(v => v.stock > LOW_STOCK_THRESHOLD);
      
      if (isActive && !hasActiveVariants && totalVariantStock <= LOW_STOCK_THRESHOLD) {
        await prisma.$executeRaw`UPDATE "products" SET "isActive" = false, status = 'INACTIVE' WHERE id = ${product.id}`;
        isActive = false;
        lowStockTriggered = true;
      }
    }

    if (lowStockTriggered) {
      // ── Audit log: auto-deactivated due to low stock ───────────────────────
      const stockInfo = productType === 'SIMPLE' 
        ? `Stock: ${stock}` 
        : `Total variant stock: ${createdVariants.reduce((sum, v) => sum + v.stock, 0)}`;
      
      auditLog({
        entityType:   ENTITY_TYPES.PRODUCT,
        entityId:     product.id,
        action:       AUDIT_ACTIONS.PRODUCT_AUTO_DEACTIVATED_LOW_STOCK,
        previousData: { ...product, isActive: true },
        newData:      { ...product, isActive: false, status: 'INACTIVE' },
        reason:       `${stockInfo} at or below low-stock threshold (${LOW_STOCK_THRESHOLD})`,
        ...extractRequestMeta(request),
      });

      const sellerUser = await prisma.user.findUnique({
        where: { id: sellerId },
        select: { email: true, name: true }
      });

      const lowStockValue = productType === 'SIMPLE' ? stock : createdVariants.reduce((sum, v) => sum + v.stock, 0);
      
      notifySellerLowStock(sellerId, product.id, product.title, lowStockValue)
        .catch(err => console.error("Low stock notification error (addProduct):", err.message));

      notifyAdminLowStockDeactivation(product.id, {
        productTitle: product.title,
        sellerName:   seller.storeName || seller.businessName || 'Unknown',
        stock: lowStockValue,
        productType
      }).catch(err => console.error("Admin low stock deactivation notification error (addProduct):", err.message));

      if (sellerUser?.email) {
        sendSellerLowStockEmail(sellerUser.email, sellerUser.name || "Seller",
          product.title, lowStockValue, product.id)
          .then(result => {
            if (!result.success) console.warn(`⚠️  [Low Stock] Email not sent to ${sellerUser.email}: ${result.error}`);
            else console.log(`✅ [Low Stock] Email sent to ${sellerUser.email} for "${product.title}"`);
          })
          .catch(err => console.error("Low stock email error (addProduct):", err.message));
      } else {
        console.warn(`⚠️  [Low Stock] No email for seller ${sellerId} — email skipped`);
      }
    }

    // ── Notify all admins about new product pending review ───────────────────
    if (userRole === "SELLER" && productStatus === "PENDING") {
      try {
        const sellerUserInfo = await prisma.user.findUnique({
          where: { id: sellerId },
          select: { name: true }
        });
        const pendingDetails = {
          productTitle: title,
          sellerName: sellerUserInfo?.name || seller.storeName || seller.businessName || 'Unknown'
        };

        // In-app notifications for all admins (failure must not block email)
        try {
          await notifyAdminNewProduct(product.id, pendingDetails);
        } catch (inAppErr) {
          console.error('❌ [addProduct] In-app notification error (non-fatal):', inAppErr.message);
        }

        // Email all admins — separate try/catch so notification failure never blocks email
        try {
          const admins = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } });
          for (const admin of admins) {
            if (admin.email) {
              const result = await sendAdminProductPendingEmail(admin.email, admin.name, {
                productTitle: title,
                sellerName: pendingDetails.sellerName,
                productId: product.id
              });
              if (result.success) {
              } else {
                console.error(`❌ [addProduct] Failed to email admin ${admin.email}:`, result.error);
              }
            } else {
              console.warn(`⚠️  [addProduct] Admin user has no email address — skipping`);
            }
          }
        } catch (emailErr) {
          console.error('❌ [addProduct] Admin email error:', emailErr.message);
        }
      } catch (notifyErr) {
        console.error('❌ [addProduct] Admin notification/email block error:', notifyErr.message);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    await invalidateCache('products');
    return reply.status(200).send({ 
      success: true, 
      message: "Product added successfully",
      productId: product.id,
      productType: productType,
      product: {
        id: product.id,
        title: product.title,
        description: product.description,
        type: productType,
        price: productType === 'SIMPLE' ? product.price : null,
        stock: productType === 'SIMPLE' ? product.stock : null,
        category: product.category,
        featuredImage: featuredImageUrl,
        galleryImages: product.images,
        artistName: product.artistName,
        status: product.status,
        isActive: isActive,
        featured: product.featured,
        tags: product.tags,
        variants: productType === 'VARIABLE' ? createdVariants : undefined
      },
      note: userRole === "ADMIN" ? "Product is live" : "Product submitted for admin review - will be live after approval",
      totalProducts: seller.productCount + 1,
      variantsCreated: createdVariants.length
    });

    // ── [DEAD CODE REMOVED] Notification block was here but after return ──

  } catch (err) {
    console.error("Add product error:", err);
    
    // Handle specific Prisma transaction errors
    if (err.message?.includes('Transaction not found') || err.message?.includes('Transaction ID is invalid')) {
      console.warn("⚠️ Transaction expired - this may indicate a timeout or connection issue");
      return reply.status(500).send({ 
        success: false, 
        error: "Database transaction timed out. Please try again. If this persists, please contact support.",
        code: "TRANSACTION_TIMEOUT"
      });
    }
    
    // Handle other Prisma-specific errors
    if (err.code?.startsWith('P')) {
      return reply.status(500).send({ 
        success: false, 
        error: `Database error: ${err.message}`,
        code: err.code 
      });
    }
    
    // Handle SKU uniqueness errors
    if (err.message?.includes('SKU') && err.message?.includes('already exists')) {
      return reply.status(400).send({ 
        success: false, 
        error: err.message,
        code: "DUPLICATE_SKU"
      });
    }
    
    // Generic error fallback
    return reply.status(500).send({ 
      success: false, 
      error: err.message || "An unexpected error occurred while creating the product"
    });
  }
};

// GET MY PRODUCTS (Seller only)
exports.getMyProducts = async (request, reply) => {
  try {
    const sellerId = request.user.userId;
    const includeVariants = request.query.includeVariants !== 'false'; // Include variants by default, pass ?includeVariants=false to skip

    const products = await prisma.$queryRaw`
      SELECT id, title, description, type, price, category, stock, "sellerId", "sellerName",
             "artistName", status, "isActive", featured, tags,
             "featuredImage", images AS "galleryImages",
             "rejectionReason", "createdAt", "updatedAt"
      FROM "products"
      WHERE "sellerId" = ${sellerId}
        AND "owner_type" = 'SELLER'::"ProductOwnerType"
        AND "deletedAt" IS NULL
      ORDER BY "createdAt" DESC
    `;

    // Enhance products with variant information for seller dashboard
    const enhancedProducts = await Promise.all(products.map(async (product) => {
      let variantInfo = null;
      let variants = null;
      let totalStock = product.stock;
      let priceInfo = product.price ? parseFloat(product.price) : null;
      
      if (product.type === 'VARIABLE') {
        // Get summary variant information for VARIABLE products
        const variantDetails = await prisma.$queryRaw`
          SELECT 
            COUNT(*)::int as "totalVariants",
            COUNT(CASE WHEN "isActive" = true THEN 1 END)::int as "activeVariants",
            SUM(stock)::int as "totalStock",
            MIN(price::numeric) as "minPrice",
            MAX(price::numeric) as "maxPrice",
            AVG(price::numeric) as "avgPrice"
          FROM "product_variants"
          WHERE "productId" = ${product.id}
        `;
        
        if (variantDetails[0]) {
          const details = variantDetails[0];
          totalStock = details.totalStock || 0;
          
          variantInfo = {
            totalVariants: details.totalVariants || 0,
            activeVariants: details.activeVariants || 0,
            priceRange: details.minPrice && details.maxPrice ? 
              `$${parseFloat(details.minPrice)} - $${parseFloat(details.maxPrice)}` : null,
            avgPrice: details.avgPrice ? parseFloat(details.avgPrice) : null
          };
          
          priceInfo = variantInfo.priceRange;
        }
        
        // Optionally include detailed variants with attributes
        if (includeVariants) {
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
            WHERE pv."productId" = ${product.id}
            ORDER BY pv."createdAt", a."sortOrder", av."sortOrder"
          `;
          
          // Group variants with their attributes
          const variantMap = new Map();
          
          variantRows.forEach(row => {
            if (!variantMap.has(row.id)) {
              variantMap.set(row.id, {
                id: row.id,
                productId: row.productId,
                price: parseFloat(row.price),
                stock: row.stock,
                sku: row.sku,
                isActive: row.isActive,
                images: row.images || [],
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                attributes: {}
              });
            }
            
            const variant = variantMap.get(row.id);
            if (row.attr_name && row.attr_value) {
              variant.attributes[row.attr_name] = {
                valueType: row.attr_value_type || 'text',
                value: row.attr_value,
                displayValue: row.attr_display_value,
                hexColor: row.attr_hex_color
              };
            }
          });
          
          variants = Array.from(variantMap.values());
        }
      }

      const result = {
        ...product,
        // For VARIABLE products, override price with the range (no $ sign); keep numeric for SIMPLE
        price: product.type === 'VARIABLE' ? (variantInfo?.priceRange ? variantInfo.priceRange.replace(/\$/g, '').trim() : null) : (product.price ? parseFloat(product.price) : null),
        stock: totalStock,
        // Enhanced seller dashboard fields
        displayPrice: priceInfo,
        totalStock: totalStock,
        productType: product.type || 'SIMPLE',
        variantInfo: variantInfo // Only present for VARIABLE products
      };
      
      // Add detailed variants if requested (default: true)
      if (variants !== null) {
        result.variants = variants;
      }
      
      return result;
    }));

    return reply.status(200).send({ 
      success: true, 
      products: enhancedProducts,
      count: enhancedProducts.length 
    });
  } catch (err) {
    console.error("Get my products error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// GET PRODUCT VARIANTS (Public - for VARIABLE products)
exports.getProductVariants = async (request, reply) => {
  try {
    const productId = request.params.id;
    
    // First check if product exists and is VARIABLE type
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, type: true, title: true, isActive: true }
    });
    
    if (!product) {
      return reply.status(404).send({ 
        success: false, 
        message: "Product not found" 
      });
    }
    
    if (product.type !== 'VARIABLE') {
      return reply.status(400).send({ 
        success: false, 
        message: "This endpoint is only for VARIABLE products. This product is SIMPLE type." 
      });
    }
    
    // Get variants with their attributes
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
          price: parseFloat(row.price),
          stock: row.stock,
          sku: row.sku,
          isActive: row.isActive,
          images: row.images || [],
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          attributes: {}
        });
      }
      
      const variant = variantMap.get(row.id);
      if (row.attr_name && row.attr_value) {
        variant.attributes[row.attr_name] = {
          valueType: row.attr_value_type || 'text',
          value: row.attr_value,
          displayValue: row.attr_display_value,
          hexColor: row.attr_hex_color
        };
      }
    });
    
    const variants = Array.from(variantMap.values());
    
    // Calculate summary statistics
    const summary = {
      totalVariants: variants.length,
      activeVariants: variants.filter(v => v.isActive).length,
      totalStock: variants.reduce((sum, v) => sum + v.stock, 0),
      priceRange: variants.length > 0 ? {
        min: Math.min(...variants.map(v => v.price)),
        max: Math.max(...variants.map(v => v.price))
      } : null
    };
    
    return reply.status(200).send({
      success: true,
      product: {
        id: product.id,
        title: product.title,
        type: product.type,
        isActive: product.isActive
      },
      variants: variants,
      summary: summary
    });
  } catch (err) {
    console.error("Get product variants error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// GET PRODUCT BY ID (Public)
exports.getProductById = async (request, reply) => {
  try {
    const id = request.params.id;

    const rows = await prisma.$queryRaw`
      SELECT p.id, p.title, p.description, p.type, p.price, p.weight, p.category, p.stock,
             p."sellerId", p."sellerName", p."artistName", p.status, p."isActive",
             p.featured, p.tags, p."featuredImage", p.images AS "galleryImages",
             p."createdAt", p."updatedAt",
             u.id AS "seller_id", u.name AS "seller_name", u.email AS "seller_email"
      FROM "products" p
      JOIN "users" u ON p."sellerId" = u.id
      WHERE p.id = ${id}
        AND p."deletedAt" IS NULL
    `;

    if (!rows.length) {
      return reply.status(404).send({ success: false, message: "Product not found" });
    }

    const row = rows[0];
    const { seller_id, seller_name, seller_email, ...productFields } = row;

    let variants = [];
    
    // If this is a VARIABLE product, fetch its variants with attributes
    if (row.type === 'VARIABLE') {
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
        WHERE pv."productId" = ${id}
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
            valueType: row.attr_value_type || 'text',
            value: row.attr_value,
            displayValue: row.attr_display_value,
            hexColor: row.attr_hex_color
          };
        }
      });
      
      variants = Array.from(variantMap.values());
    }

    return reply.status(200).send({
      success: true,
      product: {
        ...productFields,
        variants: variants.length > 0 ? variants : undefined,
        seller: { id: seller_id, name: seller_name, email: seller_email }
      }
    });
  } catch (err) {
    console.error("Get product by ID error:", err);
    reply.status(500).send({ success: false, error: err.message });
  }
};

// UPDATE PRODUCT (Seller or Admin)
exports.updateProduct = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const userRole = request.user.role; // From auth middleware
    
    const product = await prisma.product.findUnique({
      where: { id: request.params.id }
    });

    if (!product || product.deletedAt) {
      return reply.status(404).send({ success: false, message: "Product not found" });
    }

    // Check authorization: only seller (owner), admin, or super admin can update
    if (userRole !== "ADMIN" && userRole !== "SUPER_ADMIN" && product.sellerId !== userId) {
      return reply.status(403).send({ success: false, message: "You are not authorized to update this product" });
    }

    // Check if seller is inactive (only for sellers, not admin)
    if (userRole === "SELLER") {
      const seller = await prisma.sellerProfile.findUnique({
        where: { userId }
      });
      
      if (!seller?.isActive) {
        return reply.status(403).send({
          success: false,
          message: "Your account has been deactivated. You cannot update products. Reason: " + (seller?.inactiveReason || "No reason provided")
        });
      }
    }

    // Support both JSON and form/multipart bodies
    const body = request.body || {};
    let { title, description, price, weight, stock, category, featured, tags, artistName, "artist name": artistNameWithSpace } = body;
    
    // Handle both artistName and "artist name" field formats
    const finalArtistName = artistName || artistNameWithSpace;
    
    let featuredImageUrl = undefined; // undefined = don't change; null = clear it
    let galleryImages = [];
    let hasGalleryUpdate = false;
    const { uploadToCloudinary } = require("../config/cloudinary");

    // Parse existingGalleryImages from body (URLs the frontend wants to keep)
    let existingGalleryImages = [];
    if (body.existingGalleryImages) {
      existingGalleryImages = Array.isArray(body.existingGalleryImages)
        ? body.existingGalleryImages
        : [body.existingGalleryImages];
      // Filter out empty strings
      existingGalleryImages = existingGalleryImages.filter(img => img && img.trim() !== '');
    }

    // Array to collect new uploaded gallery files
    let newGalleryFiles = [];

    // If files were uploaded, upload them to Cloudinary
    if (request.files) {
      let filesArray = Array.isArray(request.files) ? request.files : [request.files];
      if (filesArray.length > 0) {
        for (const file of filesArray) {
          try {
            const result = await uploadToCloudinary(file.path, 'products');
            if (file.fieldname === 'featuredImage') {
              featuredImageUrl = result.url;
            } else if (file.fieldname === 'galleryImages') {
              newGalleryFiles.push(result.url);
            }
          } catch (err) {
            console.error('Cloudinary upload error:', err);
          }
        }
      }
    } else {
      // Fallback: images provided as URLs in the body
      if (body.featuredImage !== undefined) {
        featuredImageUrl = typeof body.featuredImage === 'string' ? body.featuredImage : body.featuredImage[0];
      }
      if (body.galleryImages) {
        if (Array.isArray(body.galleryImages)) {
          newGalleryFiles = body.galleryImages;
        } else if (typeof body.galleryImages === 'string') {
          newGalleryFiles = [body.galleryImages];
        }
      }
      // Backward compat: old 'images' field maps first to featuredImage, rest to gallery
      if (featuredImageUrl === undefined && !newGalleryFiles.length && body.images) {
        const imgs = Array.isArray(body.images) ? body.images : [body.images];
        featuredImageUrl = imgs[0] || undefined;
        newGalleryFiles = imgs.slice(1);
      }
    }

    // Debug logging

    // MERGE existing images with new uploaded images
    let allGalleryImages = [];
    
    // Handle edge cases according to the guide
    if (newGalleryFiles.length > 0 && existingGalleryImages.length > 0) {
      // User added new files AND has existing images - merge both
      allGalleryImages = [...existingGalleryImages, ...newGalleryFiles];
      hasGalleryUpdate = true;
    } else if (newGalleryFiles.length > 0 && existingGalleryImages.length === 0) {
      // User deleted all old images but added new files - use only new files
      allGalleryImages = newGalleryFiles;
      hasGalleryUpdate = true;
    } else if (newGalleryFiles.length === 0 && existingGalleryImages.length > 0) {
      // User didn't add new files but has existing images - keep existing as-is
      allGalleryImages = existingGalleryImages;
      hasGalleryUpdate = true;
    } else if (body.existingGalleryImages !== undefined || body.keepExistingGallery !== undefined) {
      // Explicit gallery update (even if empty)
      allGalleryImages = [];
      hasGalleryUpdate = true;
    }

    // Remove duplicates
    const uniqueGalleryImages = [...new Set(allGalleryImages)];
    
    if (hasGalleryUpdate) {
      galleryImages = uniqueGalleryImages;
    }


    // Parse price, weight and stock to correct types, ignore empty string
    if (typeof price === 'string' && price.trim() !== '') price = parseFloat(price);
    else if (typeof price === 'string') price = undefined;
    if (typeof weight === 'string' && weight.trim() !== '') weight = parseFloat(weight);
    else if (typeof weight === 'string') weight = undefined;
    if (typeof stock === 'string' && stock.trim() !== '') stock = parseInt(stock);
    else if (typeof stock === 'string') stock = undefined;

    // Validate weight if provided
    if (weight !== undefined && weight <= 0) {
      return reply.status(400).send({
        success: false,
        message: "Weight must be greater than 0"
      });
    }

    // Parse featured to boolean
    let parsedFeatured = undefined;
    if (featured !== undefined) {
      parsedFeatured = featured === 'true' || featured === true ? true : false;
    }

    // Parse tags - can be single string or array
    let parsedTags = undefined;
    if (tags) {
      if (Array.isArray(tags)) {
        parsedTags = tags.filter(tag => tag && tag.trim() !== '');
      } else if (typeof tags === 'string') {
        parsedTags = tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '');
      }
    }

    // Build human-readable list of changed fields for admin notification
    const changedFields = [];
    if (title          !== undefined && title          !== '' && title          !== product.title)                        changedFields.push('Title');
    if (description    !== undefined && description    !== '' && description    !== product.description)                  changedFields.push('Description');
    if (price          !== undefined                          && parseFloat(price)  !== parseFloat(product.price))        changedFields.push(`Price (${product.price} → ${price})`);
    if (weight         !== undefined                          && parseFloat(weight) !== parseFloat(product.weight))       changedFields.push(`Weight (${product.weight} → ${weight})`);
    if (stock          !== undefined                          && parseInt(stock)    !== product.stock)                    changedFields.push(`Stock (${product.stock} → ${stock})`);
    if (category       !== undefined && category       !== '' && category       !== product.category)                    changedFields.push('Category');
    if (finalArtistName !== undefined && finalArtistName !== '' && finalArtistName !== product.artistName)               changedFields.push('Artist Name');
    if (parsedFeatured !== undefined && parsedFeatured !== product.featured)                                              changedFields.push('Featured');
    if (parsedTags     !== undefined)                                                                                     changedFields.push('Tags');
    if (featuredImageUrl !== undefined)                                                                                   changedFields.push('Featured Image');
    if (hasGalleryUpdate)                                                                                                 changedFields.push('Gallery Images');

    // Determine if product needs re-approval after update
    let newStatus = product.status; // Keep current status by default
    let newIsActive = true; // Assume active for now
    
    if (userRole === "SELLER" && product.sellerId === userId) {
      // Seller editing their own product - always goes back to PENDING for re-approval
      // This covers both normal edits AND re-submissions after a REJECTED status
      newStatus = "PENDING";
      newIsActive = false;
    }
    // Admin edits don't change approval status

    // Only update fields that are not undefined and not empty string
    const updateData = {};
    if (title !== undefined && title !== '') updateData.title = title;
    if (description !== undefined && description !== '') updateData.description = description;
    if (price !== undefined && price !== '') updateData.price = price;
    if (weight !== undefined && weight !== '') updateData.weight = weight;
    if (stock !== undefined && stock !== '') updateData.stock = stock;
    if (category !== undefined && category !== '') updateData.category = category;
    if (hasGalleryUpdate) updateData.images = galleryImages;
    if (parsedFeatured !== undefined) updateData.featured = parsedFeatured;
    if (parsedTags !== undefined) updateData.tags = parsedTags;
    if (finalArtistName !== undefined && finalArtistName !== '') updateData.artistName = finalArtistName;

    // Clear rejection reason when seller re-submits a rejected product
    if (userRole === "SELLER" && product.status === "REJECTED") {
      updateData.rejectionReason = null;
    }
    
    // Set status for approval workflow
    updateData.status = newStatus;

    const updatedProduct = await prisma.product.update({
      where: { id: request.params.id },
      data: updateData
    });

    // Update isActive and featuredImage using raw SQL
    await prisma.$executeRaw`UPDATE "products" SET "isActive" = ${newIsActive} WHERE "id" = ${request.params.id}`;
    if (featuredImageUrl !== undefined) {
      await prisma.$executeRaw`UPDATE "products" SET "featuredImage" = ${featuredImageUrl} WHERE "id" = ${request.params.id}`;
    }

    // ── Audit log: product updated ────────────────────────────────────────────
    auditLog({
      entityType:   ENTITY_TYPES.PRODUCT,
      entityId:     request.params.id,
      action:       AUDIT_ACTIONS.PRODUCT_UPDATED,
      previousData: product,
      newData:      updatedProduct,
      ...extractRequestMeta(request),
    });

    // ── Low stock auto-deactivation ──────────────────────────────────────────
    // Work out the effective stock after this update.
    // Skip for VARIABLE products — they track stock at the variant level (product.stock is NULL).
    let lowStockTriggered = false;
    const finalStock = (stock !== undefined && stock !== '') ? stock : product.stock;
    const isVariableProduct = (product.type === 'VARIABLE') || updatedProduct.type === 'VARIABLE';
    if (!isVariableProduct && finalStock != null && finalStock <= LOW_STOCK_THRESHOLD) {
      // Force inactive regardless of role or status
      await prisma.$executeRaw`
        UPDATE "products"
        SET "isActive" = false, status = 'INACTIVE'
        WHERE id = ${request.params.id}
      `;
      newIsActive = false;
      lowStockTriggered = true;

      // ── Audit log: auto-deactivated due to low stock ───────────────────────
      auditLog({
        entityType:   ENTITY_TYPES.PRODUCT,
        entityId:     request.params.id,
        action:       AUDIT_ACTIONS.PRODUCT_AUTO_DEACTIVATED_LOW_STOCK,
        previousData: { ...updatedProduct, isActive: true },
        newData:      { ...updatedProduct, isActive: false, status: 'INACTIVE' },
        reason:       `Stock (${finalStock}) at or below low-stock threshold (${LOW_STOCK_THRESHOLD})`,
        ...extractRequestMeta(request),
      });

      // Fetch seller email for notification
      const sellerUser = await prisma.user.findUnique({
        where: { id: product.sellerId },
        select: { email: true, name: true }
      });

      notifySellerLowStock(
        product.sellerId,
        request.params.id,
        updatedProduct.title,
        finalStock
      ).catch(err => console.error("Low stock notification error:", err.message));

      notifyAdminLowStockDeactivation(request.params.id, {
        productTitle: updatedProduct.title,
        sellerName:   product.sellerName || 'Unknown',
        stock:        finalStock
      }).catch(err => console.error("Admin low stock deactivation notification error:", err.message));

      if (sellerUser?.email) {
        sendSellerLowStockEmail(
          sellerUser.email,
          sellerUser.name || "Seller",
          updatedProduct.title,
          finalStock,
          request.params.id
        ).then(result => {
          if (!result.success) console.warn(`⚠️  [Low Stock] Email not sent to ${sellerUser.email}: ${result.error}`);
          else console.log(`✅ [Low Stock] Email sent to ${sellerUser.email} for "${updatedProduct.title}"`);
        }).catch(err => console.error("Low stock email error:", err.message));
      } else {
        console.warn(`⚠️  [Low Stock] No email for seller ${product.sellerId} — email skipped`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Notify admin when seller edit sends product back to PENDING ───────
    if (userRole === "SELLER" && newStatus === "PENDING" && !lowStockTriggered) {
      try {
        const sellerUser = await prisma.user.findUnique({
          where: { id: userId },
          select: { name: true }
        });
        const pendingDetails = {
          productTitle: title || product.title,
          sellerName: sellerUser?.name || 'Unknown',
          changedFields
        };

        // In-app notifications for all admins (failure must not block email)
        try {
          await notifyAdminProductPending(request.params.id, pendingDetails);
        } catch (inAppErr) {
          console.error('❌ [updateProduct] In-app notification error (non-fatal):', inAppErr.message);
        }

        // Email all admins — separate try/catch so notification failure never blocks email
        try {
          const admins = await prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } });
          for (const admin of admins) {
            if (admin.email) {
              const result = await sendAdminProductPendingEmail(admin.email, admin.name, {
                productTitle: pendingDetails.productTitle,
                sellerName: pendingDetails.sellerName,
                productId: request.params.id
              });
              if (result.success) {
              } else {
                console.error(`❌ [updateProduct] Failed to email admin ${admin.email}:`, result.error);
              }
            } else {
              console.warn(`⚠️  [updateProduct] Admin user has no email address — skipping`);
            }
          }
        } catch (emailErr) {
          console.error('❌ [updateProduct] Admin email error:', emailErr.message);
        }
      } catch (notifyErr) {
        console.error('❌ [updateProduct] Admin notification/email block error:', notifyErr.message);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const resolvedFeaturedImage = featuredImageUrl !== undefined ? featuredImageUrl : product.featuredImage;
    const { images: _imgs, ...productFields } = updatedProduct;

    await invalidateCache('products');
    return reply.status(200).send({
      success: true,
      message: userRole === "SELLER" && newStatus === "PENDING" ? 
        "Product updated and sent for admin review" : 
        "Product updated successfully",
      product: {
        ...productFields,
        featuredImage: resolvedFeaturedImage,
        galleryImages: updatedProduct.images,
        isActive: newIsActive
      },
      requiresApproval: userRole === "SELLER" && newStatus === "PENDING"
    });
  } catch (err) {
    console.error("Update product error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// DELETE PRODUCT — soft delete (moves to Recycle Bin)
exports.deleteProduct = async (request, reply) => {
  try {
    const userId   = request.user.userId;
    const userRole = request.user.role;

    // Support both :id (product routes) and :productId (admin routes)
    const productId = request.params.id || request.params.productId;

    const product = await prisma.product.findUnique({
      where: { id: productId }
    });

    if (!product || product.deletedAt) {
      return reply.status(404).send({ success: false, message: "Product not found" });
    }

    // Only the owning seller or an admin may delete
    if (userRole !== "ADMIN" && userRole !== "SUPER_ADMIN" && product.sellerId !== userId) {
      return reply.status(403).send({ success: false, message: "You are not authorized to delete this product" });
    }

    // Check if seller is inactive (only for sellers, not admin)
    if (userRole === "SELLER") {
      const seller = await prisma.sellerProfile.findUnique({
        where: { userId }
      });
      
      if (!seller?.isActive) {
        return reply.status(403).send({
          success: false,
          message: "Your account has been deactivated. You cannot delete products. Reason: " + (seller?.inactiveReason || "No reason provided")
        });
      }
    }

    const now = new Date();

    // Soft delete — mark deleted, deactivate, keep the row
    await prisma.$executeRaw`
      UPDATE "products"
      SET "deletedAt"     = ${now},
          "deletedBy"     = ${userId},
          "deletedByRole" = ${userRole},
          "isActive"      = false,
          status          = 'INACTIVE'::"ProductStatus"
      WHERE id = ${productId}
    `;

    // Audit log
    auditLog({
      entityType:   ENTITY_TYPES.PRODUCT,
      entityId:     productId,
      action:       AUDIT_ACTIONS.PRODUCT_DELETED,
      previousData: product,
      newData:      { ...product, deletedAt: now, deletedBy: userId, deletedByRole: userRole, deletedByEmail: request.user.email, isActive: false, status: 'INACTIVE' },
      reason:       request.body?.reason ?? `Moved to Recycle Bin by ${userRole} (${request.user.email})`,
      ...extractRequestMeta(request),
    });

    // Update seller product count
    let newCount = null;
    if (userRole === "SELLER") {
      const seller = await prisma.sellerProfile.findUnique({ where: { userId } });
      newCount = Math.max(0, (seller?.productCount || 1) - 1);
      await prisma.sellerProfile.update({
        where: { userId },
        data:  { productCount: newCount, minimumProductsUploaded: newCount >= 1 }
      });
    }

    await invalidateCache('products');
    return reply.status(200).send({
      success: true,
      message: "Product moved to Recycle Bin. It can be restored from there.",
      ...(newCount !== null && { totalProducts: newCount })
    });
  } catch (err) {
    console.error("Delete product error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// GET RECYCLE BIN — seller sees their own deleted products
exports.getRecycleBin = async (request, reply) => {
  try {
    const sellerId = request.user.userId;

    const products = await prisma.$queryRaw`
      SELECT id, title, description, price, category, stock, "sellerId", "sellerName",
             "artistName", status, featured, tags,
             "featuredImage", images AS "galleryImages",
             "rejectionReason", "deletedAt", "deletedBy", "deletedByRole",
             "createdAt", "updatedAt"
      FROM "products"
      WHERE "sellerId" = ${sellerId}
        AND "owner_type" = 'SELLER'::"ProductOwnerType"
        AND "deletedAt" IS NOT NULL
      ORDER BY "deletedAt" DESC
    `;

    return reply.status(200).send({ success: true, products, count: products.length });
  } catch (err) {
    console.error("Get recycle bin error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// RESTORE PRODUCT from Recycle Bin
exports.restoreProduct = async (request, reply) => {
  try {
    const userId   = request.user.userId;
    const userRole = request.user.role;

    // Support both :id (seller routes) and :productId (admin routes)
    const productId = request.params.id || request.params.productId;

    // Fetch including soft-deleted rows
    const rows = await prisma.$queryRaw`
      SELECT * FROM "products" WHERE id = ${productId}
    `;
    const product = rows[0];

    if (!product) {
      return reply.status(404).send({ success: false, message: "Product not found" });
    }

    if (!product.deletedAt) {
      return reply.status(400).send({ success: false, message: "Product is not in the Recycle Bin" });
    }

    // Ownership check for sellers
    if (userRole !== "ADMIN" && userRole !== "SUPER_ADMIN" && product.sellerId !== userId) {
      return reply.status(403).send({ success: false, message: "You are not authorized to restore this product" });
    }

    // Sellers restore to PENDING (re-approval required); Admins/SuperAdmins restore to INACTIVE (can activate manually)
    const restoredStatus = (userRole === "ADMIN" || userRole === "SUPER_ADMIN") ? "INACTIVE" : "PENDING";

    await prisma.$executeRaw`
      UPDATE "products"
      SET "deletedAt"     = NULL,
          "deletedBy"     = NULL,
          "deletedByRole" = NULL,
          "isActive"      = false,
          status          = ${restoredStatus}::"ProductStatus"
      WHERE id = ${productId}
    `;

    // Audit log
    auditLog({
      entityType:   ENTITY_TYPES.PRODUCT,
      entityId:     productId,
      action:       AUDIT_ACTIONS.PRODUCT_RESTORED,
      previousData: product,
      newData:      {
        ...product,
        deletedAt:       null,
        deletedBy:       null,
        deletedByRole:   null,
        restoredAt:      new Date(),
        restoredById:    userId,
        restoredByEmail: request.user.email,
        restoredByRole:  userRole,
        isActive:        false,
        status:          restoredStatus,
      },
      reason:       `Restored by ${userRole} (${request.user.email}). Status set to ${restoredStatus} — ${userRole === 'SELLER' ? 'awaiting admin approval' : 'activate when ready'}.`,
      ...extractRequestMeta(request),
    });

    // Update seller product count back up
    const sellerIdToUpdate = userRole === "SELLER" ? userId : product.sellerId;
    const seller = await prisma.sellerProfile.findUnique({ where: { userId: sellerIdToUpdate } });
    if (seller) {
      const newCount = (seller.productCount || 0) + 1;
      await prisma.sellerProfile.update({
        where: { userId: sellerIdToUpdate },
        data:  { productCount: newCount, minimumProductsUploaded: newCount >= 1 }
      });
    }

    await invalidateCache('products');
    return reply.status(200).send({
      success: true,
      message: userRole === "ADMIN"
        ? "Product restored. Set it to Active when ready."
        : "Product restored and submitted for admin review.",
      restoredStatus
    });
  } catch (err) {
    console.error("Restore product error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// GET PRODUCT STOCK BY ID  (Public — lightweight, used for polling / page-load checks)
exports.getProductStock = async (request, reply) => {
  try {
    const { id } = request.params;

    const rows = await prisma.$queryRaw`
      SELECT id, stock, "isActive", status
      FROM "products"
      WHERE id = ${id}
        AND "deletedAt" IS NULL
    `;

    if (!rows.length) {
      return reply.status(404).send({ success: false, message: 'Product not found' });
    }

    const p = rows[0];
    return reply.status(200).send({
      success: true,
      productId: p.id,
      stock: p.stock,
      isAvailable: p.isActive && p.stock > 0,
      isActive: p.isActive
    });
  } catch (err) {
    console.error('Get product stock error:', err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// BULK STOCK CHECK (Public — used by cart page on load to validate all items at once)
exports.getBulkStock = async (request, reply) => {
  try {
    const { productIds } = request.body;

    if (!Array.isArray(productIds) || productIds.length === 0) {
      return reply.status(400).send({ success: false, message: 'productIds array is required' });
    }

    // Limit to 100 products per request to prevent abuse
    const ids = productIds.slice(0, 100);

    const products = await prisma.product.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, stock: true, isActive: true }
    });

    const stockMap = {};
    products.forEach((p) => {
      stockMap[p.id] = {
        productId: p.id,
        stock: p.stock,
        isAvailable: p.isActive && p.stock > 0,
        isActive: p.isActive
      };
    });

    // Include entries for any IDs not found in DB (treat as unavailable)
    ids.forEach((id) => {
      if (!stockMap[id]) {
        stockMap[id] = { productId: id, stock: 0, isAvailable: false, isActive: false };
      }
    });

    return reply.status(200).send({
      success: true,
      stock: stockMap
    });
  } catch (err) {
    console.error('Bulk stock check error:', err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// GET ALL PRODUCTS (Public - only active sellers' products)
exports.getAllProducts = async (request, reply) => {
  try {
    const { sellerId } = request.query || {};
    const sellerFilter = sellerId ? Prisma.sql`AND p."sellerId" = ${sellerId}` : Prisma.empty;

    const products = await prisma.$queryRaw`
      SELECT
        p.id, p.title, p.description, p.type, p.price, p.weight, p.category, p.stock,
        p."sellerId", p."sellerName", p."artistName", p.status, p."isActive",
        p.featured, p.tags, p."featuredImage", p.images,
        p."createdAt", p."updatedAt",
        u.name AS "sellerUserName",
        ROUND(AVG(r.rating)::numeric, 1)  AS "avgRating",
        COUNT(r.id)::int                  AS "ratingCount"
      FROM "products" p
      JOIN "users" u ON p."sellerId" = u.id
      JOIN "seller_profiles" sp ON u.id = sp."userId"
      LEFT JOIN "ratings" r ON r."productId" = p.id
      WHERE p."isActive" = true AND sp.status = 'ACTIVE'
        AND p."deletedAt" IS NULL
        ${sellerFilter}
      GROUP BY p.id, u.name
      ORDER BY p."createdAt" DESC
    `;

    // Enhance products with full variant data for VARIABLE products
    const enhancedProducts = await Promise.all(products.map(async (product) => {
      let priceRange = null;
      let totalStock = product.stock;
      let variantCount = 0;
      let hasVariants = product.type === 'VARIABLE';
      let variants = [];

      if (hasVariants) {
        // Fetch full variant data including attribute values
        const rawVariants = await prisma.productVariant.findMany({
          where: { productId: product.id, isActive: true },
          include: {
            variantAttributeValues: {
              include: {
                attributeValue: {
                  include: {
                    attribute: {
                      select: { id: true, name: true, displayName: true }
                    }
                  }
                }
              }
            }
          },
          orderBy: { createdAt: 'asc' }
        });

        variants = rawVariants.map((v) => ({
          id: v.id,
          sku: v.sku,
          price: parseFloat(v.price),
          stock: v.stock,
          images: v.images,
          isActive: v.isActive,
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
          attributes: v.variantAttributeValues.map((vav) => ({
            attributeId: vav.attributeValue.attribute.id,
            attributeName: vav.attributeValue.attribute.name,
            attributeDisplayName: vav.attributeValue.attribute.displayName,
            valueType: vav.attributeValue.attribute.valueType || 'text',
            valueId: vav.attributeValue.id,
            value: vav.attributeValue.value,
            displayValue: vav.attributeValue.displayValue,
            hexColor: vav.attributeValue.hexColor ?? null
          }))
        }));

        variantCount = variants.length;
        totalStock = variants.reduce((sum, v) => sum + (v.stock || 0), 0);

        if (variantCount > 0) {
          const prices = variants.map((v) => v.price);
          const min = Math.min(...prices);
          const max = Math.max(...prices);
          priceRange = min === max ? `$${min}` : `$${min} - $${max}`;
        }
      }

      return {
        ...product,
        featuredImage: product.featuredImage || null,
        galleryImages: product.images,
        avgRating: product.avgRating ? parseFloat(product.avgRating) : null,
        ratingCount: product.ratingCount ?? 0,
        // For VARIABLE products, override price with the range (no $ sign); keep numeric for SIMPLE
        price: hasVariants ? (priceRange ? priceRange.replace(/\$/g, '').trim() : null) : (product.price ? parseFloat(product.price) : null),
        displayPrice: hasVariants ? priceRange : (product.price ? `$${parseFloat(product.price)}` : null),
        stock: totalStock,
        totalStock: totalStock,
        variantCount: variantCount,
        productType: product.type || 'SIMPLE',
        variants: variants
      };
    }));

    return reply.status(200).send({ success: true, products: enhancedProducts, count: enhancedProducts.length });
  } catch (err) {
    console.error("Get all products error:", err);
    return reply.status(500).send({ success: false, error: err.message });
  }
};

// ── SELLER: DEACTIVATE MY PRODUCT ────────────────────────────────────────────
// Seller can deactivate their own product with a mandatory reason.
// Product moves to INACTIVE status. Admin is notified with the reason.
exports.deactivateMyProduct = async (request, reply) => {
  try {
    const sellerId = request.user.userId;
    const { id: productId } = request.params;
    const body = request.body || {};
    const inactiveReason = body.reason || body.inactiveReason;

    if (!inactiveReason || !inactiveReason.trim()) {
      return reply.status(400).send({ success: false, message: 'A reason is required to deactivate your product.' });
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { seller: { select: { id: true, name: true, email: true } } }
    });

    if (!product) {
      return reply.status(404).send({ success: false, message: 'Product not found.' });
    }

    // Ensure the seller owns this product
    if (product.sellerId !== sellerId) {
      return reply.status(403).send({ success: false, message: 'You do not own this product.' });
    }

    // Only active products can be deactivated by seller
    if (product.status !== 'ACTIVE') {
      return reply.status(400).send({
        success: false,
        message: `Product cannot be deactivated — current status is ${product.status}. Only ACTIVE products can be deactivated.`
      });
    }

    // Deactivate
    await prisma.product.update({
      where: { id: productId },
      data: {
        status: 'INACTIVE',
        sellerInactiveReason: inactiveReason.trim()
      }
    });
    await prisma.$executeRaw`UPDATE "products" SET "isActive" = false WHERE "id" = ${productId}`;

    auditLog({
      entityType: ENTITY_TYPES.PRODUCT,
      entityId: productId,
      action: AUDIT_ACTIONS.PRODUCT_DEACTIVATED,
      previousData: product,
      newData: { ...product, status: 'INACTIVE', isActive: false, sellerInactiveReason: inactiveReason.trim() },
      reason: inactiveReason.trim(),
      ...extractRequestMeta(request)
    });

    // Notify admins (in-app)
    notifyAdminProductSellerDeactivated(productId, {
      productTitle: product.title,
      sellerName: product.seller?.name || 'Unknown',
      inactiveReason: inactiveReason.trim()
    }).catch(err => console.error('Admin deactivate notification error:', err.message));

    // Email seller confirmation (non-blocking)
    if (product.seller?.email) {
      sendSellerProductSelfDeactivatedEmail(product.seller.email, product.seller.name || 'Seller', {
        productTitle: product.title,
        productId,
        inactiveReason: inactiveReason.trim()
      }).catch(err => console.error('Seller self-deactivate email error:', err.message));
    }

    // Email admins (non-blocking)
    prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } })
      .then(admins => {
        for (const admin of admins) {
          sendAdminProductSellerDeactivatedEmail(admin.email, admin.name || 'Admin', {
            productTitle: product.title,
            productId,
            sellerName: product.seller?.name || 'Unknown',
            inactiveReason: inactiveReason.trim()
          }).catch(err => console.error('Admin deactivate email error:', err.message));
        }
      }).catch(err => console.error('Admin lookup error (deactivate email):', err.message));

    await invalidateCache('products');
    return reply.send({ success: true, message: 'Product deactivated successfully.' });
  } catch (error) {
    console.error('Seller deactivate product error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// ── SELLER: SUBMIT PRODUCT FOR REVIEW ────────────────────────────────────────
// Seller submits an INACTIVE or REJECTED product for admin review.
// Product moves to PENDING. Admin is notified with the seller's note.
// Seller CANNOT make a product directly ACTIVE — only admin can approve it.
exports.submitProductForReview = async (request, reply) => {
  try {
    const sellerId = request.user.userId;
    const { id: productId } = request.params;
    const body = request.body || {};
    const reviewNote = body.reviewNote || body.note || body.reason || '';

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { seller: { select: { id: true, name: true, email: true } } }
    });

    if (!product) {
      return reply.status(404).send({ success: false, message: 'Product not found.' });
    }

    if (product.sellerId !== sellerId) {
      return reply.status(403).send({ success: false, message: 'You do not own this product.' });
    }

    // Only INACTIVE or REJECTED products can be submitted for review
    if (!['INACTIVE', 'REJECTED'].includes(product.status)) {
      return reply.status(400).send({
        success: false,
        message: `Product cannot be submitted for review — current status is ${product.status}. Only INACTIVE or REJECTED products can be submitted.`
      });
    }

    // Set status to PENDING and store the review note
    await prisma.product.update({
      where: { id: productId },
      data: {
        status: 'PENDING',
        reviewNote: reviewNote.trim() || null,
        rejectionReason: null   // clear old rejection reason on new review request
      }
    });
    await prisma.$executeRaw`UPDATE "products" SET "isActive" = false WHERE "id" = ${productId}`;

    auditLog({
      entityType: ENTITY_TYPES.PRODUCT,
      entityId: productId,
      action: AUDIT_ACTIONS.PRODUCT_UPDATED,
      previousData: product,
      newData: { ...product, status: 'PENDING', reviewNote: reviewNote.trim() || null },
      reason: 'Seller submitted product for admin review',
      ...extractRequestMeta(request)
    });

    // Notify admins (in-app)
    notifyAdminProductSubmitReview(productId, {
      productTitle: product.title,
      sellerName: product.seller?.name || 'Unknown',
      reviewNote: reviewNote.trim() || null
    }).catch(err => console.error('Admin submit-review notification error:', err.message));

    // Email admins (non-blocking)
    prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { email: true, name: true } })
      .then(admins => {
        for (const admin of admins) {
          sendAdminProductSubmitReviewEmail(admin.email, admin.name || 'Admin', {
            productTitle: product.title,
            productId,
            sellerName: product.seller?.name || 'Unknown',
            reviewNote: reviewNote.trim() || null
          }).catch(err => console.error('Admin submit-review email error:', err.message));
        }
      }).catch(err => console.error('Admin lookup error (submit-review email):', err.message));

    // Email seller confirmation (non-blocking)
    if (product.seller?.email) {
      sendSellerProductSubmitReviewConfirmEmail(product.seller.email, product.seller.name || 'Seller', {
        productTitle: product.title,
        productId,
        reviewNote: reviewNote.trim() || null
      }).catch(err => console.error('Seller submit-review confirm email error:', err.message));
    }

    await invalidateCache('products');
    return reply.send({
      success: true,
      message: 'Product submitted for review. An admin will review and approve it shortly.'
    });
  } catch (error) {
    console.error('Seller submit-for-review error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// ── Auto-reactivation helper for VARIABLE products ────────────────────────────
// After any variant stock update, check if the parent VARIABLE product was
// deactivated due to low stock. If at least one variant now has stock above
// the threshold, reactivate the product automatically.
const autoReactivateIfStocked = async (productId) => {
  try {
    // Only act on VARIABLE products that are currently INACTIVE
    const rows = await prisma.$queryRaw`
      SELECT id, title, status, "isActive", type
      FROM "products"
      WHERE id = ${productId} AND type = 'VARIABLE'
    `;
    if (!rows || rows.length === 0) return;
    const product = rows[0];

    // Only reactivate if it was deactivated (not manually deactivated by seller/admin)
    if (product.status !== 'INACTIVE') return;

    // Check if any variant now has sufficient stock
    const variantStock = await prisma.$queryRaw`
      SELECT COALESCE(SUM(stock), 0)::int AS total_stock,
             COUNT(CASE WHEN stock > ${LOW_STOCK_THRESHOLD} THEN 1 END)::int AS stocked_variants
      FROM "product_variants"
      WHERE "productId" = ${productId} AND "isActive" = true
    `;

    const totalStock = variantStock[0]?.total_stock ?? 0;
    const stockedVariants = variantStock[0]?.stocked_variants ?? 0;

    if (stockedVariants > 0 || totalStock > LOW_STOCK_THRESHOLD) {
      await prisma.$executeRaw`
        UPDATE "products"
        SET "isActive" = true, status = 'ACTIVE'
        WHERE id = ${productId}
      `;
    }
  } catch (err) {
    console.error('autoReactivateIfStocked error (non-fatal):', err.message);
  }
};
// ─────────────────────────────────────────────────────────────────────────────

// UPDATE VARIANT (Seller/Admin)
// PUT /api/products/:productId/variants/:variantId
// Body: { price?, stock?, sku?, isActive?, images? }
exports.updateVariant = async (request, reply) => {
  try {
    const { productId, variantId } = request.params;
    const userId = request.user.userId;
    const userRole = request.user.role;

    // Verify the variant belongs to the product
    const variant = await prisma.productVariant.findUnique({
      where: { id: variantId },
      include: { product: true }
    });

    if (!variant || variant.productId !== productId) {
      return reply.status(404).send({ success: false, message: 'Variant not found for this product' });
    }

    // Sellers can only update their own product variants
    if (userRole === 'SELLER' && variant.product.sellerId !== userId) {
      return reply.status(403).send({ success: false, message: 'You do not have permission to update this variant' });
    }

    let { price, stock, sku, isActive, images } = request.body || {};

    if (typeof price === 'string' && price.trim() !== '') price = parseFloat(price);
    else if (typeof price === 'string') price = undefined;

    if (typeof stock === 'string' && stock.trim() !== '') stock = parseInt(stock);
    else if (typeof stock === 'string') stock = undefined;

    if (stock !== undefined && stock < 0) {
      return reply.status(400).send({ success: false, message: 'Stock cannot be negative' });
    }

    const updateData = {};
    if (price !== undefined) updateData.price = price;
    if (stock !== undefined) updateData.stock = stock;
    if (sku !== undefined && sku !== '') updateData.sku = sku;
    if (isActive !== undefined) updateData.isActive = isActive === true || isActive === 'true';
    if (Array.isArray(images)) updateData.images = images;

    // Capture old isActive before updating (for notification comparison)
    const isActiveChanging = isActive !== undefined && updateData.isActive !== variant.isActive;

    const updatedVariant = await prisma.productVariant.update({
      where: { id: variantId },
      data: updateData
    });

    // Auto-reactivate the parent product if stock was restored
    if (stock !== undefined) {
      await autoReactivateIfStocked(productId);
    }

    // Fire variant-status notifications only when isActive actually changed
    if (isActiveChanging) {
      // Resolve acting user's display name for the notification message
      const actingUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, sellerProfile: { select: { storeName: true, businessName: true } } }
      });
      const changedByName = actingUser?.name
        || actingUser?.sellerProfile?.storeName
        || actingUser?.sellerProfile?.businessName
        || userId;

      const notificationDetails = {
        productTitle: variant.product.title,
        variantSku: updatedVariant.sku,
        changedBy: changedByName,
        changedByRole: userRole
      };
      notifyAdminVariantStatusChange(productId, variantId, updatedVariant.isActive, notificationDetails)
        .catch(err => console.error('notifyAdminVariantStatusChange error (non-fatal):', err.message));
      if ((userRole === 'ADMIN' || userRole === 'SUPER_ADMIN') && variant.product.sellerId) {
        notifySellerVariantStatusChange(
          variant.product.sellerId, productId, variantId, updatedVariant.isActive, notificationDetails
        ).catch(err => console.error('notifySellerVariantStatusChange error (non-fatal):', err.message));
      }
    }

    await invalidateCache('products');
    return reply.status(200).send({
      success: true,
      message: 'Variant updated successfully',
      variant: {
        id: updatedVariant.id,
        productId: updatedVariant.productId,
        price: parseFloat(updatedVariant.price),
        stock: updatedVariant.stock,
        sku: updatedVariant.sku,
        isActive: updatedVariant.isActive,
        images: updatedVariant.images
      }
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return reply.status(409).send({ success: false, message: `SKU already exists` });
    }
    console.error('updateVariant error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// TOGGLE VARIANT STATUS (Seller/Admin)
// PATCH /api/products/:productId/variants/:variantId/toggle-status
// Body: { isActive: boolean }  — explicitly set, or omit to flip the current value
exports.toggleVariantStatus = async (request, reply) => {
  try {
    const { productId, variantId } = request.params;
    const userId = request.user.userId;
    const userRole = request.user.role;

    // Load variant + parent product + attributes for notification message
    const variant = await prisma.productVariant.findUnique({
      where: { id: variantId },
      include: {
        product: { select: { id: true, title: true, sellerId: true, type: true, status: true } },
        variantAttributeValues: {
          include: {
            attributeValue: {
              include: { attribute: { select: { displayName: true, name: true } } }
            }
          }
        }
      }
    });

    if (!variant || variant.productId !== productId) {
      return reply.status(404).send({ success: false, message: 'Variant not found for this product' });
    }

    // Sellers can only toggle variants on their own products
    if (userRole === 'SELLER' && variant.product.sellerId !== userId) {
      return reply.status(403).send({ success: false, message: 'You do not have permission to update this variant' });
    }

    // Determine the new status — explicit body value or flip current
    let newIsActive;
    if (request.body && request.body.isActive !== undefined) {
      newIsActive = request.body.isActive === true || request.body.isActive === 'true';
    } else {
      newIsActive = !variant.isActive;
    }

    // No-op if already in that state
    if (newIsActive === variant.isActive) {
      return reply.status(200).send({
        success: true,
        message: `Variant is already ${newIsActive ? 'active' : 'inactive'}`,
        variant: { id: variantId, isActive: newIsActive }
      });
    }

    await prisma.productVariant.update({
      where: { id: variantId },
      data: { isActive: newIsActive }
    });

    // When re-activating a variant, check if the parent product should also come back
    if (newIsActive) {
      await autoReactivateIfStocked(productId);
    }

    // Build a human-readable attribute label for notifications (e.g. "Red / Size 8")
    const variantAttributes = variant.variantAttributeValues
      .map(vav => vav.attributeValue.displayValue || vav.attributeValue.value)
      .join(' / ') || null;

    // Resolve acting user's display name for the notification message
    const actingUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, sellerProfile: { select: { storeName: true, businessName: true } } }
    });
    const changedByName = actingUser?.name
      || actingUser?.sellerProfile?.storeName
      || actingUser?.sellerProfile?.businessName
      || userId;

    const notificationDetails = {
      productTitle: variant.product.title,
      variantSku: variant.sku,
      variantAttributes,
      changedBy: changedByName,
      changedByRole: userRole
    };

    // Notify admins whenever a variant status changes
    await notifyAdminVariantStatusChange(productId, variantId, newIsActive, notificationDetails).catch(err =>
      console.error('notifyAdminVariantStatusChange error (non-fatal):', err.message)
    );

    // If admin toggled a seller's variant, also notify the seller
    if ((userRole === 'ADMIN' || userRole === 'SUPER_ADMIN') && variant.product.sellerId) {
      await notifySellerVariantStatusChange(
        variant.product.sellerId, productId, variantId, newIsActive, notificationDetails
      ).catch(err => console.error('notifySellerVariantStatusChange error (non-fatal):', err.message));
    }

    await invalidateCache('products');
    return reply.status(200).send({
      success: true,
      message: `Variant ${newIsActive ? 'activated' : 'deactivated'} successfully`,
      variant: { id: variantId, productId, isActive: newIsActive }
    });
  } catch (error) {
    console.error('toggleVariantStatus error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};

// BULK SAVE VARIANTS (Seller/Admin)
// PUT /api/products/:productId/variants/bulk
// Replaces the full variant set for a VARIABLE product.
// Body: { variants: [{ id?, sku, price, stock, isActive?, images?, attributes: { color: "Blue", size: "8" } }] }
exports.bulkSaveVariants = async (request, reply) => {
  try {
    const { productId } = request.params;
    const userId = request.user.userId;
    const userRole = request.user.role;

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.deletedAt) {
      return reply.status(404).send({ success: false, message: 'Product not found' });
    }
    if (product.type !== 'VARIABLE') {
      return reply.status(400).send({ success: false, message: 'Only VARIABLE products have variants' });
    }
    if (userRole === 'SELLER' && product.sellerId !== userId) {
      return reply.status(403).send({ success: false, message: 'You do not have permission to update this product' });
    }

    let { variants } = request.body || {};
    if (typeof variants === 'string') {
      try { variants = JSON.parse(variants); } catch {
        return reply.status(400).send({ success: false, message: 'Invalid variants JSON' });
      }
    }
    if (!Array.isArray(variants) || variants.length === 0) {
      return reply.status(400).send({ success: false, message: 'variants array is required and must not be empty' });
    }

    // Validate each variant
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      if (v.price === undefined || v.price === null || v.stock === undefined || v.stock === null) {
        return reply.status(400).send({ success: false, message: `Variant ${i + 1} must have price and stock` });
      }
      if (!v.sku) {
        return reply.status(400).send({ success: false, message: `Variant ${i + 1} must have a SKU` });
      }
      if (!v.attributes || Object.keys(v.attributes).length === 0) {
        return reply.status(400).send({ success: false, message: `Variant ${i + 1} must have at least one attribute` });
      }
      if (typeof v.price === 'string') v.price = parseFloat(v.price);
      if (typeof v.stock === 'string') v.stock = parseInt(v.stock);
    }

    // ── Pre-resolve all attribute + attribute value IDs (batched queries) ──────
    const resolvedAttributeValueIds = {}; // "attrName:attrValue" → attributeValueId

    // Collect all unique attribute names and deduplicated (name, value) needs
    const uniqueAttrNamesSet = new Set();
    const seenKeys = new Set();
    const uniqueAttrValueNeeds = [];
    for (const variant of variants) {
      for (const [attrName, attrData] of Object.entries(variant.attributes)) {
        const isObject = attrData !== null && typeof attrData === 'object';
        const attrValue = isObject ? attrData.value : attrData;
        const hexColor  = isObject ? (attrData.hexColor || null) : null;
        const valueType = isObject ? (attrData.valueType || 'text') : 'text';
        const key = `${attrName.toLowerCase()}:${attrValue.toString()}`;
        uniqueAttrNamesSet.add(attrName.toLowerCase());
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          uniqueAttrValueNeeds.push({ attrName, attrValue, hexColor, valueType, key });
        }
      }
    }

    const uniqueAttrNames = Array.from(uniqueAttrNamesSet);

    // Batch fetch all existing attributes in one query
    const existingAttrs = await prisma.attribute.findMany({ where: { name: { in: uniqueAttrNames } } });
    const attrMap = {};
    for (const attr of existingAttrs) attrMap[attr.name] = attr;

    // Create any missing attributes (sequential, but typically none in production)
    for (const name of uniqueAttrNames) {
      if (!attrMap[name]) {
        const hint = uniqueAttrValueNeeds.find(n => n.attrName.toLowerCase() === name);
        const resolvedValueType = hint && ['text', 'number'].includes(hint.valueType) ? hint.valueType : 'text';
        attrMap[name] = await prisma.attribute.create({
          data: { name, displayName: hint ? hint.attrName : name, valueType: resolvedValueType, isActive: true }
        });
      }
    }

    // Attach resolved attributeId to each need
    const attrValueLookups = uniqueAttrValueNeeds.map(n => ({
      ...n,
      attributeId: attrMap[n.attrName.toLowerCase()].id
    }));

    // Batch fetch all existing attribute values in one query
    const existingAttrValues = await prisma.attributeValue.findMany({
      where: { OR: attrValueLookups.map(l => ({ attributeId: l.attributeId, value: l.attrValue.toString() })) }
    });
    const attrValueMap = {};
    for (const av of existingAttrValues) attrValueMap[`${av.attributeId}:${av.value}`] = av;

    // Create missing attribute values + handle hexColor backfill (sequential for safety)
    for (const need of attrValueLookups) {
      const lookupKey = `${need.attributeId}:${need.attrValue.toString()}`;
      let attributeValue = attrValueMap[lookupKey];
      if (!attributeValue) {
        attributeValue = await prisma.attributeValue.create({
          data: {
            attributeId: need.attributeId,
            value: need.attrValue.toString(),
            displayValue: need.attrValue.toString(),
            hexColor: need.hexColor,
            isActive: true
          }
        });
      } else if (need.hexColor && !attributeValue.hexColor) {
        // Backfill missing hexColor if caller provides one
        attributeValue = await prisma.attributeValue.update({
          where: { id: attributeValue.id },
          data: { hexColor: need.hexColor }
        });
      }
      resolvedAttributeValueIds[need.key] = attributeValue.id;
    }
    // ─────────────────────────────────────────────────────────────────────────

    const incomingIds = new Set(variants.filter(v => v.id).map(v => v.id));

    // Get existing variants for this product
    const existingVariants = await prisma.productVariant.findMany({ where: { productId } });
    const existingIds = new Set(existingVariants.map(v => v.id));

    // Delete variants that are NOT in the incoming set
    // onDelete: Cascade on VariantAttributeValue handles the junction table automatically
    const toDeleteIds = existingVariants.filter(v => !incomingIds.has(v.id)).map(v => v.id);
    if (toDeleteIds.length > 0) {
      await prisma.productVariant.deleteMany({ where: { id: { in: toDeleteIds } } });
    }

    const savedVariants = [];

    // ── Helper: build attribute link rows for createMany ─────────────────────
    const buildAttrLinks = (variantId, attributes) =>
      Object.entries(attributes)
        .map(([attrName, attrData]) => {
          const attrValue = (attrData !== null && typeof attrData === 'object') ? attrData.value : attrData;
          const key = `${attrName.toLowerCase()}:${attrValue.toString()}`;
          return resolvedAttributeValueIds[key]
            ? { variantId, attributeValueId: resolvedAttributeValueIds[key] }
            : null;
        })
        .filter(Boolean);

    // ── Process UPDATEs and CREATEs in parallel ───────────────────────────────
    const toUpdate = variants.filter(v => v.id && existingIds.has(v.id));
    const toCreate = variants.filter(v => !v.id || !existingIds.has(v.id));

    await Promise.all([
      ...toUpdate.map(async (variant) => {
        await prisma.productVariant.update({
          where: { id: variant.id },
          data: {
            price: variant.price,
            stock: variant.stock,
            sku: variant.sku,
            isActive: variant.isActive !== undefined ? (variant.isActive === true || variant.isActive === 'true') : true,
            ...(Array.isArray(variant.images) ? { images: variant.images } : {})
          }
        });
        // Replace attribute links: delete old, bulk insert new
        await prisma.variantAttributeValue.deleteMany({ where: { variantId: variant.id } });
        const attrLinks = buildAttrLinks(variant.id, variant.attributes);
        if (attrLinks.length > 0) {
          await prisma.variantAttributeValue.createMany({ data: attrLinks });
        }
        savedVariants.push(variant.id);
      }),
      ...toCreate.map(async (variant) => {
        // ── CREATE new variant (DB unique constraint on sku handles duplicates via P2002) ──
        const created = await prisma.productVariant.create({
          data: {
            productId,
            price: variant.price,
            stock: variant.stock,
            sku: variant.sku,
            isActive: variant.isActive !== undefined ? (variant.isActive === true || variant.isActive === 'true') : true,
            images: Array.isArray(variant.images) ? variant.images : []
          }
        });
        const attrLinks = buildAttrLinks(created.id, variant.attributes);
        if (attrLinks.length > 0) {
          await prisma.variantAttributeValue.createMany({ data: attrLinks });
        }
        savedVariants.push(created.id);
      })
    ]);

    // Recalculate product stock
    const { calculateVariableProductStock } = require('../utils/productVariantUtils');
    const { totalStock } = await calculateVariableProductStock(productId);
    await prisma.$executeRaw`UPDATE "products" SET stock = NULL WHERE id = ${productId}`;

    // Auto-reactivate product if it now has stock
    await autoReactivateIfStocked(productId);

    await invalidateCache('products');
    return reply.status(200).send({
      success: true,
      message: `${savedVariants.length} variant(s) saved successfully`,
      variantCount: savedVariants.length,
      totalStock
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return reply.status(409).send({ success: false, message: 'SKU already exists' });
    }
    console.error('bulkSaveVariants error:', error);
    return reply.status(500).send({ success: false, message: error.message });
  }
};
