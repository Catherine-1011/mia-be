// Test script to demonstrate wishlist variant functionality
const axios = require('axios');

const baseURL = 'http://localhost:8000/api';
const token = 'your_auth_token_here'; // Replace with actual token

const headers = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json'
};

// Example 1: Trying to add VARIABLE product without variant (should fail)
async function testVariableProductWithoutVariant() {
  try {
    console.log('\n=== Test 1: Adding VARIABLE product without variant ===');
    const response = await axios.post(`${baseURL}/wishlist/cmobg85w4000118josaacegr2`, {
      // No variantId provided
    }, { headers });
    
    console.log('Response:', response.data);
  } catch (error) {
    console.log('Expected error:', error.response.data);
    // Should return: "Please select product options (size, color, etc.) before adding to wishlist"
  }
}

// Example 2: Adding VARIABLE product with proper variant
async function testVariableProductWithVariant() {
  try {
    console.log('\n=== Test 2: Adding VARIABLE product with variant ===');
    const response = await axios.post(`${baseURL}/wishlist/cmobg85w4000118josaacegr2`, {
      variantId: 'some_valid_variant_id' // Replace with actual variant ID
    }, { headers });
    
    console.log('Success response:', response.data);
    // Should show variant attributes like: [{ attribute: "Size", value: "S" }]
  } catch (error) {
    console.log('Error:', error.response.data);
  }
}

// Example 3: Get wishlist with enhanced data
async function testGetWishlist() {
  try {
    console.log('\n=== Test 3: Getting wishlist with variant data ===');
    const response = await axios.get(`${baseURL}/wishlist`, { headers });
    
    console.log('Wishlist items:');
    response.data.wishlist.forEach((item, index) => {
      console.log(`\nItem ${index + 1}:`);
      console.log(`- Product: ${item.product.title}`);
      console.log(`- Type: ${item.product.type}`);
      console.log(`- Display Price: ${item.product.displayPrice}`);
      console.log(`- Display Stock: ${item.product.displayStock}`);
      console.log(`- Has Variant: ${item.variantId ? 'Yes' : 'No'}`);
      
      if (item.variantAttributes.length > 0) {
        console.log('- Selected Options:');
        item.variantAttributes.forEach(attr => {
          console.log(`  * ${attr.attribute}: ${attr.value}`);
        });
      }
      
      if (item.needsVariantSelection) {
        console.log('- ⚠️  Needs variant selection!');
      }
    });
  } catch (error) {
    console.log('Error:', error.response.data);
  }
}

// Example 4: Clean up invalid wishlist items
async function testCleanupInvalidItems() {
  try {
    console.log('\n=== Test 4: Cleaning up invalid wishlist items ===');
    const response = await axios.post(`${baseURL}/wishlist/cleanup`, {}, { headers });
    
    console.log('Cleanup result:', response.data);
    // Will remove VARIABLE products that don't have variants
  } catch (error) {
    console.log('Error:', error.response.data);
  }
}

// Example 5: Move to cart with variant
async function testMoveToCartWithVariant() {
  try {
    console.log('\n=== Test 5: Moving wishlist item to cart ===');
    const response = await axios.post(`${baseURL}/wishlist/move-to-cart/cmobg85w4000118josaacegr2`, {
      variantId: 'some_valid_variant_id', // Replace with actual variant ID
      quantity: 1
    }, { headers });
    
    console.log('Move to cart result:', response.data);
  } catch (error) {
    console.log('Error:', error.response.data);
  }
}

// Run all tests
async function runAllTests() {
  console.log('🧪 Testing Wishlist Variant Functionality');
  
  await testVariableProductWithoutVariant();
  await testGetWishlist();
  await testCleanupInvalidItems();
  
  // Uncomment these when you have valid variant IDs:
  // await testVariableProductWithVariant();
  // await testMoveToCartWithVariant();
  
  console.log('\n✅ Tests completed!');
}

// Uncomment to run:
// runAllTests().catch(console.error);

module.exports = {
  testVariableProductWithoutVariant,
  testVariableProductWithVariant,
  testGetWishlist,
  testCleanupInvalidItems,
  testMoveToCartWithVariant
};