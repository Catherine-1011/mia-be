const prisma = require("../config/prisma");

// Rate a product (buyer only - must have purchased it)
exports.rateProduct = async (request, reply) => {
  try {
    const { productId } = request.params;
    const { rating, review } = request.body;
    const buyerId = request.user && typeof request.user.userId === "string" ? request.user.userId : null;

    // Validate buyerId
    if (!buyerId) {
      return reply.status(401).send({
        success: false,
        message: "Unauthorized: User ID missing or invalid."
      });
    }

    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return reply.status(400).send({ 
        success: false, 
        message: "Rating must be between 1 and 5 stars" 
      });
    }

    // Check if product exists
    const product = await prisma.product.findUnique({
      where: { id: productId }
    });

    if (!product) {
      return reply.status(404).send({ 
        success: false, 
        message: "Product not found" 
      });
    }

    // Check if already rated by this buyer
    const existingRating = await prisma.rating.findUnique({
      where: {
        userId_productId: {
          userId: buyerId,
          productId: productId
        }
      }
    });

    if (existingRating) {
      return reply.status(400).send({ 
        success: false, 
        message: "You have already rated this product" 
      });
    }


    // Create rating and get the created record
    const ratingRef = await prisma.rating.create({
      data: {
        userId: buyerId,
        productId,
        rating: parseInt(rating),
        comment: review || ""
      }
    });

    // Calculate new average rating and total ratings for the product
    const ratings = await prisma.rating.findMany({
      where: { productId }
    });
    const totalRatings = ratings.length;
    const averageRating = totalRatings > 0 ? ratings.reduce((sum, r) => sum + r.rating, 0) / totalRatings : 0;

    reply.send({
      success: true,
      message: "Product rated successfully",
      ratingId: ratingRef.id,
      rating: parseInt(rating),
      averageRating: parseFloat(averageRating.toFixed(2)),
      totalRatings
    });

  } catch (error) {
    console.error("❌ Rate product error:", error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// Update a rating (buyer can edit their own rating)
exports.updateRating = async (request, reply) => {
  try {
    const { ratingId } = request.params;
    const { rating, review } = request.body;
    const buyerId = request.user && typeof request.user.userId === "string" ? request.user.userId : null;

    // Validate rating
    if (rating && (rating < 1 || rating > 5)) {
      return reply.status(400).send({ 
        success: false, 
        message: "Rating must be between 1 and 5 stars" 
      });
    }

    // Get rating
    const ratingDoc = await db.collection("ratings").doc(ratingId).get();
    if (!ratingDoc.exists) {
      return reply.status(404).send({ 
        success: false, 
        message: "Rating not found" 
      });
    }

    const ratingData = ratingDoc.data();

    // Verify ownership
    if (ratingData.buyerId !== buyerId) {
      return reply.status(403).send({ 
        success: false, 
        message: "You can only update your own ratings" 
      });
    }

    // Update rating
    const updateData = {
      updatedAt: new Date()
    };

    if (rating) updateData.rating = parseInt(rating);
    if (review !== undefined) updateData.review = review;

    await db.collection("ratings").doc(ratingId).update(updateData);

    // Recalculate product's average rating
    const productId = ratingData.productId;
    const ratingsSnapshot = await db.collection("ratings")
      .where("productId", "==", productId)
      .get();

    let sumRatings = 0;
    ratingsSnapshot.forEach(doc => {
      sumRatings += doc.data().rating;
    });

    const averageRating = sumRatings / ratingsSnapshot.size;

    await db.collection("products").doc(productId).update({
      averageRating: parseFloat(averageRating.toFixed(2)),
      updatedAt: new Date()
    });

    reply.send({ 
      success: true, 
      message: "Rating updated successfully",
      averageRating: parseFloat(averageRating.toFixed(2))
    });

  } catch (error) {
    console.error("❌ Update rating error:", error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// Delete a rating (buyer can delete their own rating)
exports.deleteRating = async (request, reply) => {
  try {
    const { ratingId } = request.params;
    const buyerId = request.user.uid;

    // Get rating
    const ratingDoc = await db.collection("ratings").doc(ratingId).get();
    if (!ratingDoc.exists) {
      return reply.status(404).send({ 
        success: false, 
        message: "Rating not found" 
      });
    }

    const ratingData = ratingDoc.data();

    // Verify ownership
    if (ratingData.buyerId !== buyerId) {
      return reply.status(403).send({ 
        success: false, 
        message: "You can only delete your own ratings" 
      });
    }

    const productId = ratingData.productId;

    // Delete rating
    await db.collection("ratings").doc(ratingId).delete();

    // Recalculate product's average rating
    const ratingsSnapshot = await db.collection("ratings")
      .where("productId", "==", productId)
      .get();

    const totalRatings = ratingsSnapshot.size;
    let averageRating = 0;

    if (totalRatings > 0) {
      let sumRatings = 0;
      ratingsSnapshot.forEach(doc => {
        sumRatings += doc.data().rating;
      });
      averageRating = sumRatings / totalRatings;
    }

    await db.collection("products").doc(productId).update({
      averageRating: parseFloat(averageRating.toFixed(2)),
      totalRatings: totalRatings,
      updatedAt: new Date()
    });

    reply.send({ 
      success: true, 
      message: "Rating deleted successfully"
    });

  } catch (error) {
    console.error("❌ Delete rating error:", error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// Get all ratings for a product (public)
exports.getProductRatings = async (request, reply) => {
  try {
    const { productId } = request.params;
    const { limit = 10, offset = 0, sortBy = "recent" } = request.query;

    // Check if product exists
    const product = await prisma.product.findUnique({
      where: { id: productId }
    });
    if (!product) {
      return reply.status(404).send({
        success: false,
        message: "Product not found"
      });
    }

    // Get all ratings for this product
    let ratingsArray = await prisma.rating.findMany({
      where: { productId },
      include: { user: true }
    });

    // Sort in memory
    if (sortBy === "highest") {
      ratingsArray.sort((a, b) => {
        if (b.rating !== a.rating) {
          return b.rating - a.rating;
        }
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
    } else {
      ratingsArray.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    // Apply pagination
    const startIndex = parseInt(offset);
    const endIndex = startIndex + parseInt(limit);
    const ratings = ratingsArray.slice(startIndex, endIndex).map(r => ({
      id: r.id,
      userId: r.userId,
      userName: (r.user && r.user.isDeleted) ? 'Deleted User' : (r.user ? r.user.name : 'Deleted User'),
      rating: r.rating,
      comment: r.comment,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }));

    // Calculate rating distribution
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    ratingsArray.forEach(ratingItem => {
      distribution[ratingItem.rating]++;
    });

    // Calculate average rating and total ratings
    const totalRatings = ratingsArray.length;
    const averageRating = totalRatings > 0 ? ratingsArray.reduce((sum, r) => sum + r.rating, 0) / totalRatings : 0;

    reply.send({
      success: true,
      product: {
        id: productId,
        name: product.title,
        averageRating: parseFloat(averageRating.toFixed(2)),
        totalRatings
      },
      ratings,
      distribution,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: totalRatings
      }
    });
  } catch (error) {
    console.error("❌ Get product ratings error:", error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// Get buyer's rating for a specific product
exports.getBuyerRating = async (request, reply) => {
  try {
    const { productId } = request.params;
    const buyerId = request.user.uid;

    const ratingSnapshot = await db.collection("ratings")
      .where("productId", "==", productId)
      .where("buyerId", "==", buyerId)
      .get();

    if (ratingSnapshot.empty) {
      return reply.send({ 
        success: true,
        hasRated: false,
        rating: null
      });
    }

    const ratingDoc = ratingSnapshot.docs[0];
    const ratingData = ratingDoc.data();

    reply.send({ 
      success: true,
      hasRated: true,
      rating: {
        id: ratingDoc.id,
        ...ratingData
      }
    });

  } catch (error) {
    console.error("❌ Get buyer rating error:", error);
    reply.status(500).send({ success: false, error: error.message });
  }
};

// Get all ratings by a buyer (buyer's rating history)
exports.getBuyerRatings = async (request, reply) => {
  try {
    const buyerId = request.user.uid;
    const { limit = 10, offset = 0 } = request.query;

    const ratingsSnapshot = await db.collection("ratings")
      .where("buyerId", "==", buyerId)
      .orderBy("createdAt", "desc")
      .limit(parseInt(limit))
      .offset(parseInt(offset))
      .get();

    const ratings = [];
    for (const doc of ratingsSnapshot.docs) {
      const ratingData = doc.data();
      
      // Get product info
      const productDoc = await db.collection("products").doc(ratingData.productId).get();
      const productData = productDoc.exists ? productDoc.data() : null;

      ratings.push({
        id: doc.id,
        ...ratingData,
        product: productData ? {
          id: ratingData.productId,
          name: productData.name,
          imageUrl: productData.imageUrl || ""
        } : null
      });
    }

    reply.send({ 
      success: true,
      ratings,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });

  } catch (error) {
    console.error("❌ Get buyer ratings error:", error);
    reply.status(500).send({ success: false, error: error.message });
  }
};