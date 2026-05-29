const prisma = require("../config/prisma");

// Helper function to get variant attributes for display
const getVariantAttributes = async (variantId) => {
  if (!variantId) return [];
  
  const variantAttributes = await prisma.variantAttributeValue.findMany({
    where: { variantId },
    include: {
      attributeValue: {
        include: {
          attribute: true
        }
      }
    }
  });
  
  return variantAttributes.map(va => ({
    attribute: va.attributeValue.attribute.displayName,
    value: va.attributeValue.displayValue,
    hexColor: va.attributeValue.hexColor
  }));
};

// ADD / TOGGLE PRODUCT IN WISHLIST
// If the product is already in the wishlist it will be removed (toggle behaviour).
// Response always includes `action` ("added" | "removed") and `isInWishlist` (bool).
exports.addToWishlist = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { productId } = request.params;
    const { variantId } = request.body || {};

    // Check if product exists
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, title: true, status: true, type: true, isActive: true }
    });

    if (!product) {
      return reply.status(404).send({ 
        success: false, 
        message: "Product not found" 
      });
    }

    if (product.status !== "ACTIVE" || !product.isActive) {
      return reply.status(400).send({ 
        success: false, 
        message: "Cannot add inactive product to wishlist" 
      });
    }

    // For VARIABLE products, variantId is required
    if (product.type === 'VARIABLE' && !variantId) {
      return reply.status(400).send({ 
        success: false, 
        message: "Please select product options (size, color, etc.) before adding to wishlist",
        requiresVariant: true,
        productType: product.type
      });
    }

    // For SIMPLE products, variantId should not be provided
    if (product.type === 'SIMPLE' && variantId) {
      return reply.status(400).send({ 
        success: false, 
        message: "This product does not have variants"
      });
    }

    // For VARIABLE products, validate the variant
    if (variantId) {
      const variant = await prisma.productVariant.findUnique({
        where: { id: variantId },
        select: { id: true, productId: true, isActive: true, price: true, stock: true }
      });
      
      if (!variant || variant.productId !== productId || !variant.isActive) {
        return reply.status(404).send({ 
          success: false, 
          message: "Selected product variant is not available" 
        });
      }
    }

    // Check if already in wishlist (considering variant)
    let existingWishlist;
    
    if (variantId) {
      // Use compound unique constraint when we have a variantId
      existingWishlist = await prisma.wishlist.findUnique({
        where: {
          userId_productId_variantId: {
            userId,
            productId,
            variantId
          }
        }
      });
    } else {
      // Use findFirst when variantId is null
      existingWishlist = await prisma.wishlist.findFirst({
        where: {
          userId,
          productId,
          variantId: null
        }
      });
    }

    if (existingWishlist) {
      // Already in wishlist — remove it (toggle off)
      if (variantId) {
        await prisma.wishlist.delete({
          where: {
            userId_productId_variantId: {
              userId,
              productId,
              variantId
            }
          }
        });
      } else {
        await prisma.wishlist.delete({
          where: {
            id: existingWishlist.id
          }
        });
      }

      return reply.status(200).send({
        success: true,
        message: "Product removed from wishlist",
        action: "removed",
        isInWishlist: false
      });
    }

    // Not in wishlist — add it (toggle on)
    const wishlistItem = await prisma.wishlist.create({
      data: {
        userId,
        productId,
        variantId: variantId || null
      },
      include: {
        product: {
          select: {
            id: true,
            title: true,
            price: true,
            featuredImage: true,
            stock: true,
            type: true
          }
        },
        productVariant: variantId ? {
          select: {
            id: true,
            price: true,
            stock: true,
            sku: true,
            images: true
          }
        } : false
      }
    });

    // Get variant attributes if it's a variant
    const variantAttributes = await getVariantAttributes(variantId);

    return reply.status(200).send({
      success: true,
      message: "Product added to wishlist",
      action: "added",
      isInWishlist: true,
      wishlistItem: {
        ...wishlistItem,
        variantAttributes
      }
    });

  } catch (error) {
    console.error("Add to wishlist error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// REMOVE PRODUCT FROM WISHLIST
exports.removeFromWishlist = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { productId } = request.params;
    const { variantId } = request.body || {};

    console.log(`[removeFromWishlist] User: ${userId}, Product: ${productId}, Variant: ${variantId}`);

    // For deletion, if no variantId is provided in body, try to find any item with that productId
    let wishlistItem;
    
    if (variantId) {
      // Look for specific variant
      wishlistItem = await prisma.wishlist.findUnique({
        where: {
          userId_productId_variantId: {
            userId,
            productId,
            variantId
          }
        }
      });
    } else {
      // Look for any item with this productId (could be variant or non-variant)
      wishlistItem = await prisma.wishlist.findFirst({
        where: {
          userId,
          productId
        }
      });
    }

    if (!wishlistItem) {
      // Try to find what exists for this user and product
      const existingItems = await prisma.wishlist.findMany({
        where: {
          userId,
          productId
        },
        select: {
          id: true,
          variantId: true,
          product: {
            select: {
              title: true,
              type: true
            }
          }
        }
      });
      
      console.log(`[removeFromWishlist] No item found. Existing items for this product:`, existingItems);
      
      return reply.status(404).send({ 
        success: false, 
        message: variantId ? 
          "This specific product variant is not in your wishlist" :
          "This product is not in your wishlist",
        existingItems: existingItems.map(item => ({
          id: item.id,
          variantId: item.variantId,
          productTitle: item.product.title
        }))
      });
    }

    console.log(`[removeFromWishlist] Found wishlist item:`, {
      id: wishlistItem.id,
      productId: wishlistItem.productId,
      variantId: wishlistItem.variantId
    });

    // Remove from wishlist using the item ID (most reliable)
    await prisma.wishlist.delete({
      where: {
        id: wishlistItem.id
      }
    });

    console.log(`[removeFromWishlist] Successfully removed item:`, wishlistItem.id);

    return reply.status(200).send({
      success: true,
      message: "Product removed from wishlist successfully",
      removedItem: {
        id: wishlistItem.id,
        productId: wishlistItem.productId,
        variantId: wishlistItem.variantId
      }
    });

  } catch (error) {
    console.error("Remove from wishlist error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// GET USER'S WISHLIST
exports.getWishlist = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { page = 1, limit = 20 } = request.query;

    const wishlist = await prisma.wishlist.findMany({
      where: { userId },
      include: {
        product: {
          select: {
            id: true,
            title: true,
            description: true,
            price: true,
            featuredImage: true,
            stock: true,
            status: true,
            category: true,
            type: true,
            seller: {
              select: {
                id: true,
                name: true
              }
            }
          }
        },
        productVariant: {
          select: {
            id: true,
            price: true,
            stock: true,
            sku: true,
            images: true,
            isActive: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: parseInt(limit)
    });

    const totalCount = await prisma.wishlist.count({
      where: { userId }
    });

    // Enrich wishlist items with variant attributes
    const enrichedWishlist = await Promise.all(
      wishlist.map(async (item) => {
        const variantAttributes = await getVariantAttributes(item.variantId);
        
        // Determine the display price and stock
        let displayPrice, displayStock, displayImage;
        let needsVariantSelection = false;
        
        // Extract common variant attributes as direct properties for easy frontend access
        const directVariantProps = {};
        if (variantAttributes?.length) {
          variantAttributes.forEach(attr => {
            const key = attr.name?.toLowerCase(); // size, color, style, etc.
            if (key && attr.displayValue) {
              directVariantProps[key] = attr.displayValue;
            }
          });
        }
        
        if (item.product.type === 'VARIABLE') {
          if (item.productVariant && item.variantId) {
            // Has valid variant data
            displayPrice = item.productVariant.price;
            displayStock = item.productVariant.stock;
            displayImage = item.productVariant.images?.[0] || item.product.featuredImage;
          } else {
            // VARIABLE product without variant - this should not happen with new validation
            needsVariantSelection = true;
            displayPrice = "Please select options";
            displayStock = "N/A";
            displayImage = item.product.featuredImage;
          }
        } else {
          // SIMPLE product
          displayPrice = item.product.price;
          displayStock = item.product.stock;
          displayImage = item.product.featuredImage;
        }
        
        return {
          id: item.id,
          productId: item.productId,
          variantId: item.variantId,
          ...directVariantProps, // ✅ Direct properties: size, color, etc.
          product: {
            ...item.product,
            displayPrice,
            displayStock,
            displayImage
          },
          variant: item.productVariant,
          variantAttributes,
          needsVariantSelection,
          addedAt: item.createdAt
        };
      })
    );

    return reply.status(200).send({
      success: true,
      wishlist: enrichedWishlist,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        pages: Math.ceil(totalCount / limit)
      }
    });

  } catch (error) {
    console.error("Get wishlist error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// CHECK IF PRODUCT IS IN WISHLIST
exports.isInWishlist = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { productId } = request.params;
    const { variantId } = request.query;

    let wishlistItem;
    
    if (variantId) {
      // Use compound unique constraint when we have a variantId
      wishlistItem = await prisma.wishlist.findUnique({
        where: {
          userId_productId_variantId: {
            userId,
            productId,
            variantId
          }
        }
      });
    } else {
      // Use findFirst when checking for items without variantId
      wishlistItem = await prisma.wishlist.findFirst({
        where: {
          userId,
          productId,
          variantId: null
        }
      });
    }

    return reply.status(200).send({
      success: true,
      isInWishlist: !!wishlistItem,
      wishlistItem: wishlistItem || null
    });

  } catch (error) {
    console.error("Check wishlist error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// CLEAR ENTIRE WISHLIST
exports.clearWishlist = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const result = await prisma.wishlist.deleteMany({
      where: { userId }
    });

    return reply.status(200).send({
      success: true,
      message: `Wishlist cleared successfully. ${result.count} items removed.`
    });

  } catch (error) {
    console.error("Clear wishlist error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// MOVE WISHLIST ITEM TO CART
exports.moveToCart = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { productId } = request.params;
    const { quantity = 1, variantId } = request.body;

    console.log(`[moveToCart] User: ${userId}, Product: ${productId}, Variant: ${variantId}, Quantity: ${quantity}`);

    // Check if productId is provided
    if (!productId) {
      return reply.status(400).send({ 
        success: false, 
        message: "ProductId is required. Use POST /api/wishlist/move-to-cart/:productId" 
      });
    }

    // Validate quantity
    if (isNaN(quantity) || quantity <= 0) {
      return reply.status(400).send({ 
        success: false, 
        message: "Invalid quantity. Must be a positive number." 
      });
    }

    // Check if product is in wishlist (with specific variant)
    let wishlistItem;
    
    if (variantId) {
      wishlistItem = await prisma.wishlist.findUnique({
        where: {
          userId_productId_variantId: {
            userId,
            productId,
            variantId
          }
        },
        include: {
          product: {
            select: {
              id: true,
              title: true,
              stock: true,
              type: true,
              status: true,
              isActive: true
            }
          },
          productVariant: {
            select: {
              id: true,
              stock: true,
              price: true,
              isActive: true
            }
          }
        }
      });
    } else {
      wishlistItem = await prisma.wishlist.findFirst({
        where: {
          userId,
          productId,
          variantId: null
        },
        include: {
          product: {
            select: {
              id: true,
              title: true,
              stock: true,
              type: true,
              status: true,
              isActive: true
            }
          }
        }
      });
    }

    if (!wishlistItem) {
      return reply.status(404).send({ 
        success: false, 
        message: "Product variant not found in wishlist" 
      });
    }

    // Check if product/variant is active
    if (wishlistItem.product.status !== 'ACTIVE' || !wishlistItem.product.isActive) {
      return reply.status(400).send({ 
        success: false, 
        message: "Product is no longer available" 
      });
    }

    // For VARIABLE products, ensure we have valid variant
    if (wishlistItem.product.type === 'VARIABLE') {
      if (!variantId || !wishlistItem.productVariant || !wishlistItem.productVariant.isActive) {
        return reply.status(400).send({ 
          success: false, 
          message: "Please select product options before adding to cart",
          needsVariantSelection: true
        });
      }
    }

    // Check stock availability
    const availableStock = variantId ? 
      wishlistItem.productVariant.stock : 
      wishlistItem.product.stock;
    
    if (availableStock < quantity) {
      return reply.status(400).send({ 
        success: false, 
        message: `Insufficient stock. Only ${availableStock} available.` 
      });
    }

    // Get or create cart
    let cart = await prisma.cart.findUnique({
      where: { userId }
    });

    if (!cart) {
      cart = await prisma.cart.create({
        data: { userId }
      });
    }

    // Check if product/variant already in cart
    const existingCartItem = await prisma.cartItem.findFirst({
      where: {
        cartId: cart.id,
        productId,
        variantId: variantId || null
      }
    });

    if (existingCartItem) {
      // Update quantity (ensure we don't exceed stock)
      const newQuantity = existingCartItem.quantity + parseInt(quantity);
      console.log(`[moveToCart] Existing cart item found. Current: ${existingCartItem.quantity}, Adding: ${quantity}, New total: ${newQuantity}`);
      
      if (newQuantity > availableStock) {
        return reply.status(400).send({ 
          success: false, 
          message: `Cannot add more items. Total would exceed available stock (${availableStock}).` 
        });
      }
      
      await prisma.cartItem.update({
        where: {
          id: existingCartItem.id
        },
        data: {
          quantity: newQuantity
        }
      });
      console.log(`[moveToCart] Updated cart item quantity to: ${newQuantity}`);
    } else {
      // Add new cart item
      console.log(`[moveToCart] Creating new cart item with quantity: ${quantity}`);
      await prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId,
          variantId: variantId || null,
          quantity: parseInt(quantity)
        }
      });
    }

    // Remove from wishlist
    console.log(`[moveToCart] Removing from wishlist - Product: ${productId}, Variant: ${variantId}, WishlistItemId: ${wishlistItem.id}`);
    
    try {
      if (variantId) {
        await prisma.wishlist.delete({
          where: {
            userId_productId_variantId: {
              userId,
              productId,
              variantId
            }
          }
        });
      } else {
        await prisma.wishlist.delete({
          where: {
            id: wishlistItem.id
          }
        });
      }
      console.log(`[moveToCart] Successfully removed from wishlist`);
    } catch (deleteError) {
      console.error(`[moveToCart] Error removing from wishlist:`, deleteError);
      // Don't fail the whole operation if wishlist removal fails
    }

    return reply.status(200).send({
      success: true,
      message: "Product moved to cart successfully",
      addedQuantity: parseInt(quantity),
      productId,
      variantId
    });

  } catch (error) {
    console.error("Move to cart error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// TOGGLE PRODUCT IN WISHLIST (Add if not present, remove if present)
exports.toggleWishlist = async (request, reply) => {
  // Just call the main addToWishlist method since it already handles toggle behavior
  return exports.addToWishlist(request, reply);
};

// REMOVE WISHLIST ITEM BY ID
exports.removeWishlistItemById = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { itemId } = request.params;

    // Check if item exists and belongs to user
    const wishlistItem = await prisma.wishlist.findUnique({
      where: { id: itemId },
      include: {
        product: {
          select: {
            id: true,
            title: true,
            type: true
          }
        }
      }
    });

    console.log(`[removeWishlistItemById] User: ${userId}, ItemId: ${itemId}`);

    if (!wishlistItem) {
      console.log(`[removeWishlistItemById] Item not found: ${itemId}`);
      return reply.status(404).send({ 
        success: false, 
        message: "Wishlist item not found" 
      });
    }

    // Verify ownership
    if (wishlistItem.userId !== userId) {
      console.log(`[removeWishlistItemById] Ownership mismatch. Item belongs to: ${wishlistItem.userId}, requested by: ${userId}`);
      return reply.status(403).send({ 
        success: false, 
        message: "Not authorized to remove this item" 
      });
    }

    console.log(`[removeWishlistItemById] Found item:`, {
      id: wishlistItem.id,
      productTitle: wishlistItem.product.title,
      variantId: wishlistItem.variantId
    });

    // Remove the item
    await prisma.wishlist.delete({
      where: { id: itemId }
    });

    console.log(`[removeWishlistItemById] Successfully removed item: ${itemId}`);

    return reply.status(200).send({
      success: true,
      message: "Item removed from wishlist successfully",
      removedItem: {
        id: itemId,
        productTitle: wishlistItem.product.title,
        productId: wishlistItem.productId,
        variantId: wishlistItem.variantId
      }
    });

  } catch (error) {
    console.error("Remove wishlist item by ID error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// MOVE WISHLIST ITEM TO CART BY ITEM ID
exports.moveToCartById = async (request, reply) => {
  try {
    const userId = request.user.userId;
    const { itemId } = request.params;
    const { quantity = 1 } = request.body;

    // Get wishlist item with full details
    const wishlistItem = await prisma.wishlist.findUnique({
      where: { id: itemId },
      include: {
        product: {
          select: {
            id: true,
            title: true,
            stock: true,
            type: true,
            status: true,
            isActive: true
          }
        },
        productVariant: {
          select: {
            id: true,
            stock: true,
            price: true,
            isActive: true
          }
        }
      }
    });

    if (!wishlistItem) {
      return reply.status(404).send({ 
        success: false, 
        message: "Wishlist item not found" 
      });
    }

    // Verify ownership
    if (wishlistItem.userId !== userId) {
      return reply.status(403).send({ 
        success: false, 
        message: "Not authorized to access this item" 
      });
    }

    // Check if product/variant is active
    if (wishlistItem.product.status !== 'ACTIVE' || !wishlistItem.product.isActive) {
      return reply.status(400).send({ 
        success: false, 
        message: "Product is no longer available" 
      });
    }

    // For VARIABLE products, ensure we have valid variant
    if (wishlistItem.product.type === 'VARIABLE') {
      if (!wishlistItem.variantId || !wishlistItem.productVariant || !wishlistItem.productVariant.isActive) {
        return reply.status(400).send({ 
          success: false, 
          message: "Product variant is no longer available",
          needsVariantSelection: true
        });
      }
    }

    // Check stock availability
    const availableStock = wishlistItem.variantId ? 
      wishlistItem.productVariant.stock : 
      wishlistItem.product.stock;
    
    if (availableStock < quantity) {
      return reply.status(400).send({ 
        success: false, 
        message: `Insufficient stock. Only ${availableStock} available.` 
      });
    }

    // Get or create cart
    let cart = await prisma.cart.findUnique({
      where: { userId }
    });

    if (!cart) {
      cart = await prisma.cart.create({
        data: { userId }
      });
    }

    // Check if product/variant already in cart
    const existingCartItem = await prisma.cartItem.findFirst({
      where: {
        cartId: cart.id,
        productId: wishlistItem.productId,
        variantId: wishlistItem.variantId || null
      }
    });

    if (existingCartItem) {
      // Update quantity (ensure we don't exceed stock)
      const newQuantity = existingCartItem.quantity + quantity;
      if (newQuantity > availableStock) {
        return reply.status(400).send({ 
          success: false, 
          message: `Cannot add more items. Total would exceed available stock (${availableStock}).` 
        });
      }
      
      await prisma.cartItem.update({
        where: {
          id: existingCartItem.id
        },
        data: {
          quantity: newQuantity
        }
      });
    } else {
      // Add new cart item
      await prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId: wishlistItem.productId,
          variantId: wishlistItem.variantId || null,
          quantity
        }
      });
    }

    // Remove from wishlist
    await prisma.wishlist.delete({
      where: { id: itemId }
    });

    return reply.status(200).send({
      success: true,
      message: "Product moved to cart successfully",
      addedQuantity: quantity,
      productTitle: wishlistItem.product.title
    });

  } catch (error) {
    console.error("Move to cart by ID error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};

// CLEAN UP INVALID WISHLIST ITEMS (VARIABLE products without variants)
exports.cleanupInvalidWishlistItems = async (request, reply) => {
  try {
    const userId = request.user.userId;

    // Find VARIABLE products in wishlist that don't have variantId
    const invalidItems = await prisma.wishlist.findMany({
      where: {
        userId,
        variantId: null,
        product: {
          type: 'VARIABLE'
        }
      },
      include: {
        product: {
          select: {
            id: true,
            title: true,
            type: true
          }
        }
      }
    });

    if (invalidItems.length === 0) {
      return reply.status(200).send({
        success: true,
        message: "No invalid items found",
        removedCount: 0
      });
    }

    // Remove invalid items
    const result = await prisma.wishlist.deleteMany({
      where: {
        userId,
        variantId: null,
        product: {
          type: 'VARIABLE'
        }
      }
    });

    return reply.status(200).send({
      success: true,
      message: `Removed ${result.count} invalid wishlist items. Please re-add these products with specific options selected.`,
      removedCount: result.count,
      removedItems: invalidItems.map(item => ({
        productId: item.productId,
        productTitle: item.product.title
      }))
    });

  } catch (error) {
    console.error("Cleanup wishlist error:", error);
    return reply.status(500).send({ 
      success: false, 
      message: error.message 
    });
  }
};
