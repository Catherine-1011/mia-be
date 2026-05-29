# Wishlist with Variant Support - Frontend Guide

## Overview
The wishlist now supports product variants! When users select specific variant combinations (like size "S" and color "CK"), that exact variant is saved to their wishlist.

## Key Changes

### 1. Adding to Wishlist with Variant
```javascript
// For VARIABLE products, include variantId in request body
const addToWishlist = async (productId, variantId) => {
  const response = await fetch(`/api/wishlist/${productId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ 
      variantId: variantId // Required for VARIABLE products
    })
  });
  
  const data = await response.json();
  
  if (data.success) {
    console.log(`Action: ${data.action}`); // "added" or "removed"
    console.log(`In wishlist: ${data.isInWishlist}`);
    
    if (data.action === 'added') {
      console.log('Variant attributes:', data.wishlistItem.variantAttributes);
      // Example: [{ attribute: "Size", value: "S" }, { attribute: "Color", value: "CK" }]
    }
  }
};
```

### 2. Checking if Variant is in Wishlist
```javascript
const checkWishlistStatus = async (productId, variantId) => {
  const response = await fetch(`/api/wishlist/check/${productId}?variantId=${variantId}`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  const data = await response.json();
  return data.isInWishlist;
};
```

### 3. Getting Wishlist with Variant Details
```javascript
const getWishlist = async () => {
  const response = await fetch('/api/wishlist', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  const data = await response.json();
  
  data.wishlist.forEach(item => {
    console.log('Product:', item.product.title);
    console.log('Display Price:', item.product.displayPrice); // Variant price if available
    console.log('Display Stock:', item.product.displayStock); // Variant stock if available
    
    if (item.variantAttributes.length > 0) {
      console.log('Selected variant:');
      item.variantAttributes.forEach(attr => {
        console.log(`- ${attr.attribute}: ${attr.value}`);
      });
    }
  });
};
```

### 4. Moving from Wishlist to Cart
```javascript
const moveToCart = async (productId, variantId, quantity = 1) => {
  const response = await fetch(`/api/wishlist/move-to-cart/${productId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      variantId: variantId,
      quantity: quantity
    })
  });
  
  const data = await response.json();
  
  if (data.success) {
    console.log('Moved to cart successfully!');
    // The exact variant that was in wishlist is now in cart
  }
};
```

### 5. Removing Specific Variant from Wishlist
```javascript
const removeFromWishlist = async (productId, variantId) => {
  const response = await fetch(`/api/wishlist/${productId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      variantId: variantId
    })
  });
  
  return response.json();
};
```

## UI Implementation Tips

### 1. Variant Selection Before Adding to Wishlist
```javascript
// For VARIABLE products, ensure variant is selected before allowing wishlist add
const handleWishlistClick = (product) => {
  if (product.type === 'VARIABLE') {
    if (!selectedVariantId) {
      alert('Please select product options before adding to wishlist');
      return;
    }
  }
  
  addToWishlist(product.id, selectedVariantId);
};
```

### 2. Display Variant Info in Wishlist
```jsx
// React example
const WishlistItem = ({ item }) => {
  return (
    <div className="wishlist-item">
      <img src={item.product.displayImage} alt={item.product.title} />
      <div>
        <h3>{item.product.title}</h3>
        <p>Price: ${item.product.displayPrice}</p>
        <p>Stock: {item.product.displayStock}</p>
        
        {item.variantAttributes.length > 0 && (
          <div className="variant-info">
            <strong>Selected:</strong>
            {item.variantAttributes.map(attr => (
              <span key={attr.attribute} className="variant-badge">
                {attr.attribute}: {attr.value}
              </span>
            ))}
          </div>
        )}
        
        <button onClick={() => moveToCart(item.productId, item.variantId)}>
          Add to Cart
        </button>
        <button onClick={() => removeFromWishlist(item.productId, item.variantId)}>
          Remove
        </button>
      </div>
    </div>
  );
};
```

### 3. Handle Multiple Variants of Same Product
```javascript
// Users can now wishlist different variants of the same product
// For example: Same shirt in different sizes/colors
const wishlistItems = [
  { productId: 'shirt123', variantId: 'shirt123-S-red', variantAttributes: [{ attribute: 'Size', value: 'S' }, { attribute: 'Color', value: 'Red' }] },
  { productId: 'shirt123', variantId: 'shirt123-M-blue', variantAttributes: [{ attribute: 'Size', value: 'M' }, { attribute: 'Color', value: 'Blue' }] }
];
```

## Error Handling

```javascript
const addToWishlist = async (productId, variantId) => {
  try {
    const response = await fetch(`/api/wishlist/${productId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ variantId })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      if (response.status === 400 && data.message.includes('variantId is required')) {
        throw new Error('Please select product options before adding to wishlist');
      }
      throw new Error(data.message || 'Failed to update wishlist');
    }
    
    return data;
  } catch (error) {
    console.error('Wishlist error:', error);
    throw error;
  }
};
```

## Migration Required

Before using this new functionality, run the database migration:

```bash
# Option 1: Using the Node.js migration script
node migrate_wishlist_variants.js

# Option 2: Using SQL directly
psql -d your_database -f add_wishlist_variants.sql
```

This will:
- Add `variantId` column to the wishlists table
- Update unique constraints to allow multiple variants per product
- Add proper foreign key relationships
- Create necessary indexes