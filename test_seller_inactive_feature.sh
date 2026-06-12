#!/bin/bash

# Seller Inactive Feature - Test Commands
# Run these commands to test the seller inactive feature
# Replace the placeholders with actual values:
# - ADMIN_TOKEN: Your admin bearer token
# - BASE_URL: Your API base URL (default: http://localhost:3000)
# - SELLER_ID / USER_ID: The seller's user ID (from user table)

BASE_URL="http://localhost:3000"
ADMIN_TOKEN="your-admin-bearer-token-here"
SELLER_ID="user-id-to-deactivate"

echo "========================================"
echo "Seller Inactive Feature - Test Suite"
echo "========================================"
echo ""

# Test 1: Deactivate a Seller
echo "Test 1: Deactivate Seller"
echo "Endpoint: PUT /admin/sellers/:sellerId/toggle-active"
echo "Command:"
echo ""
curl -X PUT "${BASE_URL}/admin/sellers/${SELLER_ID}/toggle-active" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": false,
    "reason": "Violation of marketplace terms of service"
  }'
echo ""
echo ""

# Test 2: Verify Seller is Deactivated - Try to Add Product
echo "Test 2: Attempt to Add Product (Should FAIL with 403)"
echo "Endpoint: POST /api/products/add"
echo ""
curl -X POST "${BASE_URL}/api/products/add" \
  -H "Authorization: Bearer seller-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test Product",
    "price": 29.99,
    "stock": 100,
    "category": "Electronics",
    "weight": 1.5
  }'
echo ""
echo ""

# Test 3: Verify Seller is Deactivated - Try to Request Payout
echo "Test 3: Attempt to Request Payout (Should FAIL with 403)"
echo "Endpoint: POST /api/commissions/payout/request"
echo ""
curl -X POST "${BASE_URL}/api/commissions/payout/request" \
  -H "Authorization: Bearer seller-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "requestedAmount": 500
  }'
echo ""
echo ""

# Test 4: Verify Seller is Deactivated - Try to Update Profile
echo "Test 4: Attempt to Update Profile (Should FAIL with 403)"
echo "Endpoint: PUT /api/profile/seller-profile"
echo ""
curl -X PUT "${BASE_URL}/api/profile/seller-profile" \
  -H "Authorization: Bearer seller-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "storeName": "New Store Name"
  }'
echo ""
echo ""

# Test 5: Verify Seller is Deactivated - Try to Create Coupon
echo "Test 5: Attempt to Create Coupon (Should FAIL with 403)"
echo "Endpoint: POST /api/seller-coupons"
echo ""
curl -X POST "${BASE_URL}/api/seller-coupons" \
  -H "Authorization: Bearer seller-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "TEST20",
    "discountType": "percentage",
    "discountValue": 20,
    "isActive": true
  }'
echo ""
echo ""

# Test 6: Verify Seller Can Still View Products (Read-Only)
echo "Test 6: Get My Products (Should SUCCEED - Read Only)"
echo "Endpoint: GET /api/products/my-products"
echo ""
curl -X GET "${BASE_URL}/api/products/my-products" \
  -H "Authorization: Bearer seller-token-here"
echo ""
echo ""

# Test 7: Verify Seller Can Still View Orders (Read-Only)
echo "Test 7: Get My Orders (Should SUCCEED - Read Only)"
echo "Endpoint: GET /api/seller-orders"
echo ""
curl -X GET "${BASE_URL}/api/seller-orders" \
  -H "Authorization: Bearer seller-token-here"
echo ""
echo ""

# Test 8: Reactivate Seller
echo "Test 8: Reactivate Seller"
echo "Endpoint: PUT /admin/sellers/:sellerId/toggle-active"
echo ""
curl -X PUT "${BASE_URL}/admin/sellers/${SELLER_ID}/toggle-active" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": true
  }'
echo ""
echo ""

# Test 9: Verify Seller Can Add Product Again (After Reactivation)
echo "Test 9: Attempt to Add Product (Should SUCCEED - After Reactivation)"
echo "Endpoint: POST /api/products/add"
echo ""
curl -X POST "${BASE_URL}/api/products/add" \
  -H "Authorization: Bearer seller-token-here" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test Product After Reactivation",
    "price": 39.99,
    "stock": 50,
    "category": "Electronics",
    "weight": 1.0
  }'
echo ""
echo ""

# Test 10: Error Test - Missing isActive Parameter
echo "Test 10: Error Test - Missing isActive (Should FAIL with 400)"
echo ""
curl -X PUT "${BASE_URL}/admin/sellers/${SELLER_ID}/toggle-active" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Test reason"
  }'
echo ""
echo ""

# Test 11: Error Test - Invalid isActive Type
echo "Test 11: Error Test - Invalid isActive Type (Should FAIL with 400)"
echo ""
curl -X PUT "${BASE_URL}/admin/sellers/${SELLER_ID}/toggle-active" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": "yes",
    "reason": "Invalid type"
  }'
echo ""
echo ""

# Test 12: Error Test - Non-Existent Seller
echo "Test 12: Error Test - Non-Existent Seller (Should FAIL with 404)"
echo ""
curl -X PUT "${BASE_URL}/admin/sellers/invalid-seller-id/toggle-active" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": false,
    "reason": "Test"
  }'
echo ""
echo ""

echo "========================================"
echo "Test Suite Complete"
echo "========================================"
echo ""
echo "Expected Results:"
echo "✅ Test 1: Seller deactivated, X products deactivated"
echo "✅ Test 2: 403 Forbidden - Account deactivated"
echo "✅ Test 3: 403 Forbidden - Account deactivated"
echo "✅ Test 4: 403 Forbidden - Account deactivated"
echo "✅ Test 5: 403 Forbidden - Account deactivated"
echo "✅ Test 6: 200 OK - Returns seller products"
echo "✅ Test 7: 200 OK - Returns seller orders"
echo "✅ Test 8: Seller activated"
echo "✅ Test 9: 200 OK - Product added successfully"
echo "✅ Test 10: 400 Bad Request - isActive required"
echo "✅ Test 11: 400 Bad Request - isActive must be boolean"
echo "✅ Test 12: 404 Not Found - Seller not found"
