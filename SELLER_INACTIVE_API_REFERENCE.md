# Seller Inactive Feature - API Reference & Examples

## Quick Reference

### Main API Endpoint
```
PUT /admin/sellers/:sellerId/toggle-active
```

**Required Permission**: Admin or Super Admin
**Purpose**: Deactivate or reactivate a seller account

## API Examples

### 1. Deactivate Seller (Turn OFF)

**Request:**
```bash
curl -X PUT "http://localhost:3000/admin/sellers/user-abc123/toggle-active" \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": false,
    "reason": "Seller has not been active for 3 months"
  }'
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Seller account deactivated successfully. 42 active products have been deactivated.",
  "data": {
    "seller": {
      "id": "seller-cuid-12345",
      "userId": "user-cuid-xyz",
      "storeName": "Amazing Store",
      "isActive": false,
      "deactivatedAt": "2026-06-11T14:30:45.123Z",
      "deactivatedBy": "admin-cuid-999",
      "inactiveReason": "Seller has not been active for 3 months"
    },
    "productsDeactivated": 42
  }
}
```

---

### 2. Reactivate Seller (Turn ON)

**Request:**
```bash
curl -X PUT "http://localhost:3000/admin/sellers/user-abc123/toggle-active" \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": true
  }'
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Seller account activated successfully. Products remain in their current state.",
  "data": {
    "seller": {
      "id": "seller-cuid-12345",
      "userId": "user-cuid-xyz",
      "storeName": "Amazing Store",
      "isActive": true,
      "deactivatedAt": null,
      "deactivatedBy": null,
      "inactiveReason": null
    }
  }
}
```

---

### 3. Error: Invalid Request (isActive not boolean)

**Request:**
```bash
curl -X PUT "http://localhost:3000/admin/sellers/user-abc123/toggle-active" \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": "yes"
  }'
```

**Error Response (400):**
```json
{
  "success": false,
  "message": "isActive must be a boolean value (true or false)"
}
```

---

### 4. Error: Seller Not Found

**Request:**
```bash
curl -X PUT "http://localhost:3000/admin/sellers/non-existent-id/toggle-active" \
  -H "Authorization: Bearer your-admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": false,
    "reason": "Test"
  }'
```

**Error Response (404):**
```json
{
  "success": false,
  "message": "Seller not found"
}
```

---

## What Happens When Seller is Deactivated?

### Immediate Effects:
1. ✅ Seller is marked as inactive (`isActive = false`)
2. ✅ Deactivation reason is stored
3. ✅ Timestamp recorded (`deactivatedAt`)
4. ✅ Admin ID recorded (`deactivatedBy`)
5. ✅ All seller's active products are marked as inactive
6. ✅ Products get the deactivation reason saved

### For Inactive Sellers:
- ❌ **Cannot** add products
- ❌ **Cannot** edit products
- ❌ **Cannot** delete products
- ❌ **Cannot** request categories
- ❌ **Cannot** create/edit coupons
- ❌ **Cannot** request bank details changes
- ❌ **Cannot** request payouts
- ❌ **Cannot** edit profile information
- ❌ **Cannot** update order status/tracking
- ✅ **Can** login to their account
- ✅ **Can** view their products (read-only)
- ✅ **Can** view their orders (read-only)
- ✅ **Can** view their coupons (read-only)
- ✅ **Can** view their balance (read-only)

---

## Response When Inactive Seller Tries to Add Product

**Request:**
```bash
curl -X POST "http://localhost:3000/api/products/add" \
  -H "Authorization: Bearer seller-inactive-token" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "New Product",
    "price": 29.99,
    "stock": 100,
    "category": "Electronics",
    "weight": 1.5
  }'
```

**Error Response (403 Forbidden):**
```json
{
  "success": false,
  "message": "Your account has been deactivated. You cannot add products. Reason: Seller has not been active for 3 months"
}
```

---

## Response When Inactive Seller Tries to Request Payout

**Request:**
```bash
curl -X POST "http://localhost:3000/api/commissions/payout/request" \
  -H "Authorization: Bearer seller-inactive-token" \
  -H "Content-Type: application/json" \
  -d '{
    "requestedAmount": 500
  }'
```

**Error Response (403 Forbidden):**
```json
{
  "success": false,
  "message": "Your account has been deactivated. You cannot request payouts. Reason: Seller has not been active for 3 months"
}
```

---

## Response When Inactive Seller Tries to Update Profile

**Request:**
```bash
curl -X PUT "http://localhost:3000/api/profile/seller-profile" \
  -H "Authorization: Bearer seller-inactive-token" \
  -H "Content-Type: application/json" \
  -d '{
    "storeName": "New Store Name"
  }'
```

**Error Response (403 Forbidden):**
```json
{
  "success": false,
  "message": "Your account has been deactivated. You cannot update your profile. Reason: Seller has not been active for 3 months"
}
```

---

## Response When Inactive Seller Tries to Update Order Status

**Request:**
```bash
curl -X PUT "http://localhost:3000/api/seller-orders/update-status/order-123" \
  -H "Authorization: Bearer seller-inactive-token" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "SHIPPED",
    "trackingNumber": "AU123456789"
  }'
```

**Error Response (403 Forbidden):**
```json
{
  "success": false,
  "message": "Your account has been deactivated. You cannot update order status. Reason: Seller has not been active for 3 months"
}
```

---

## Reactivation Notes

When you reactivate a seller (`isActive = true`):
- ✅ Seller can perform all operations again
- ⚠️ Previously deactivated products remain inactive (not auto-reactivated)
- ⚠️ Admin must manually reactivate products if needed
- ✅ All restrictions are immediately lifted

---

## Implementation Summary

### Files Modified:
1. `prisma/schema.prisma` - Added fields to SellerProfile
2. `controllers/admin.js` - New toggleSellerActiveStatus function
3. `controllers/product.js` - Added 3 inactive checks
4. `controllers/categories.js` - Added 1 inactive check
5. `controllers/coupon.js` - Added 2 inactive checks
6. `controllers/commission.js` - Added 1 inactive check
7. `controllers/sellerOnboarding.js` - Added 1 inactive check
8. `controllers/profile.js` - Added 1 inactive check
9. `controllers/sellerOrders.js` - Added 2 inactive checks
10. `routes/adminRoutes.js` - New route for toggle API

### Database Changes:
- ✅ `isActive` (Boolean, default: true)
- ✅ `inactiveReason` (String, optional)
- ✅ `deactivatedAt` (DateTime, optional)
- ✅ `deactivatedBy` (String, optional)
- ✅ Indexes created for performance

---

## Testing Tips

### Test Deactivation:
1. Create or find a seller account
2. Call the toggle API with `isActive: false`
3. Try adding a product as that seller (should fail with 403)
4. Check that seller's products are marked inactive

### Test Reactivation:
1. Reactivate the seller with `isActive: true`
2. Try adding a product as that seller (should succeed)
3. Seller should have full access again

### Verify Read-Only Access:
1. Deactivate a seller
2. Call GET endpoints for their products, orders, coupons (should work)
3. Call POST/PUT endpoints (should fail with 403)

---

## FAQs

**Q: Can a seller reactivate themselves?**
A: No. Only Admin and Super Admin can toggle the status via the API. Sellers cannot change their own status.

**Q: What happens to their products when deactivated?**
A: All active products are automatically deactivated. They can be manually reactivated by admin after seller reactivation if needed.

**Q: Can inactive sellers still view orders?**
A: Yes, they have read-only access. They can view their products, orders, and other data, but cannot make any modifications.

**Q: Is deactivation reversible?**
A: Yes, you can reactivate a seller anytime using the same API with `isActive: true`.

**Q: What's the difference between deactivated and suspended?**
A: Suspended (seller.status = SUSPENDED) is a different state. Deactivated (seller.isActive = false) is for operational restrictions while allowing login.
