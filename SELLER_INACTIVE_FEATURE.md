# Seller Inactive Feature Documentation

## Overview
This feature allows Admin and Super Admin users to deactivate seller accounts, preventing inactive sellers from performing any operational activities while still allowing them to log in.

## Features Implemented

### 1. Seller Active/Inactive Status
- **New Field**: `isActive` (Boolean, default: true) on SellerProfile model
- **New Fields**: `inactiveReason`, `deactivatedAt`, `deactivatedBy` for tracking
- All sellers are active by default

### 2. Restricted Actions for Inactive Sellers

When a seller is marked as inactive (`isActive = false`), they cannot:

#### Product Management
- ❌ Add new products
- ❌ Edit/update existing products
- ❌ Delete products
- ✅ View their products (read-only)

#### Category Management
- ❌ Request new categories

#### Coupon Management
- ❌ Create new coupons
- ❌ Edit/update existing coupons
- ✅ View their coupons (read-only)

#### Bank & Payout Management
- ❌ Request bank details changes
- ❌ Submit payout requests
- ✅ View their balance and payout history (read-only)

#### Profile Management
- ❌ Update profile information (name, storeName, etc.)
- ✅ View their profile (read-only)

#### Order Management
- ❌ Update order status (Packed, Shipped, Delivered)
- ❌ Update tracking numbers
- ✅ View their orders (read-only)

### 3. Admin API: Toggle Seller Active/Inactive

**Endpoint**: `PUT /admin/sellers/:sellerId/toggle-active`

**Authentication**: Admin or Super Admin only

**Request Body**:
```json
{
  "isActive": true|false,
  "reason": "Optional reason for deactivation"
}
```

**Response on Deactivation** (isActive = false):
```json
{
  "success": true,
  "message": "Seller account deactivated successfully. X active products have been deactivated.",
  "data": {
    "seller": {
      "id": "seller-uuid",
      "userId": "user-uuid",
      "storeName": "Store Name",
      "isActive": false,
      "deactivatedAt": "2026-06-11T10:30:00Z",
      "deactivatedBy": "admin-uuid",
      "inactiveReason": "Reason provided"
    },
    "productsDeactivated": 15
  }
}
```

**Response on Activation** (isActive = true):
```json
{
  "success": true,
  "message": "Seller account activated successfully. Products remain in their current state.",
  "data": {
    "seller": {
      "id": "seller-uuid",
      "userId": "user-uuid",
      "storeName": "Store Name",
      "isActive": true,
      "deactivatedAt": null,
      "deactivatedBy": null,
      "inactiveReason": null
    }
  }
}
```

### 4. Automatic Product Deactivation

When a seller is deactivated:
- All their active products are automatically deactivated
- `product.isActive` is set to `false`
- `product.status` is set to `INACTIVE`
- `product.sellerInactiveReason` is set to the deactivation reason
- Products can be manually reactivated by admins if needed after seller reactivation

## Implementation Details

### Files Modified

#### 1. **Prisma Schema** (`prisma/schema.prisma`)
- Added fields to `SellerProfile` model:
  - `isActive`: Boolean (default: true)
  - `inactiveReason`: String (optional)
  - `deactivatedAt`: DateTime (optional)
  - `deactivatedBy`: String (optional)

#### 2. **Controllers**

**controllers/product.js**
- `addProduct()`: Added check for seller.isActive
- `updateProduct()`: Added check for seller.isActive
- `deleteProduct()`: Added check for seller.isActive

**controllers/categories.js**
- `requestCategory()`: Added check for seller.isActive

**controllers/coupon.js**
- `createSellerCoupon()`: Added check for seller.isActive
- `updateSellerCoupon()`: Added check for seller.isActive

**controllers/commission.js**
- `requestPayout()`: Added check for seller.isActive

**controllers/sellerOnboarding.js**
- `requestBankDetailsChange()`: Added check for seller.isActive

**controllers/profile.js**
- `updateSellerProfile()`: Added check for seller.isActive

**controllers/sellerOrders.js**
- `updateOrderStatus()`: Added check for seller.isActive
- `bulkUpdateOrderStatus()`: Added check for seller.isActive

**controllers/admin.js**
- NEW: `toggleSellerActiveStatus()`: Admin function to toggle seller status and deactivate products

#### 3. **Routes**

**routes/adminRoutes.js**
- NEW: `PUT /admin/sellers/:sellerId/toggle-active` - Toggle seller active/inactive status

### Error Response Format

When an inactive seller attempts a restricted action, they receive:
```json
{
  "success": false,
  "message": "Your account has been deactivated. You cannot [action]. Reason: [reason provided]"
}
```

HTTP Status: `403 Forbidden`

## Usage Examples

### Example 1: Deactivate a Seller

```bash
curl -X PUT http://localhost:3000/admin/sellers/user-123/toggle-active \
  -H "Authorization: Bearer admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": false,
    "reason": "Violation of terms of service"
  }'
```

### Example 2: Reactivate a Seller

```bash
curl -X PUT http://localhost:3000/admin/sellers/user-123/toggle-active \
  -H "Authorization: Bearer admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": true
  }'
```

### Example 3: Attempt to Add Product (as Inactive Seller)

```bash
# Response: 403 Forbidden
{
  "success": false,
  "message": "Your account has been deactivated. You cannot add products. Reason: Violation of terms of service"
}
```

## Database Migration

Run the migration SQL to add the required columns:

```bash
npm run migrate:add-seller-inactive
```

Or manually execute: `migrations/add_seller_inactive_feature.sql`

## Testing Checklist

- [ ] Admin can deactivate a seller via API
- [ ] Admin can reactivate a seller via API
- [ ] Deactivating a seller automatically deactivates all their active products
- [ ] Inactive seller cannot add products
- [ ] Inactive seller cannot edit products
- [ ] Inactive seller cannot delete products
- [ ] Inactive seller cannot request categories
- [ ] Inactive seller cannot create coupons
- [ ] Inactive seller cannot edit coupons
- [ ] Inactive seller cannot request payouts
- [ ] Inactive seller cannot request bank changes
- [ ] Inactive seller cannot edit profile
- [ ] Inactive seller cannot update order status
- [ ] Inactive seller CAN still login
- [ ] Inactive seller CAN view their data (read-only)
- [ ] Reactivated seller can perform all operations again
- [ ] Admin/Super Admin are not affected by this feature

## Security Considerations

1. Only Admin and Super Admin can toggle seller status
2. Seller status cannot be changed by sellers themselves
3. Deactivation is reversible (can be reactivated)
4. All deactivations are tracked (deactivatedBy, deactivatedAt)
5. Reason for deactivation is stored for audit purposes
6. Products are automatically deactivated but not deleted
7. Customers can still view inactive products (read-only) but cannot purchase

## Future Enhancements

1. Add seller notification system to alert when account is deactivated
2. Add automatic reactivation rules (e.g., after dispute resolution)
3. Add bulk deactivation/reactivation for multiple sellers
4. Add suspension reasons classification (violation, non-payment, etc.)
5. Add audit logs for all deactivation events

## Related Features

- **Seller Suspension**: Different from inactive - seller account is SUSPENDED status
- **Product Deactivation**: Sellers can self-deactivate products; admins can force deactivation
- **Seller Approval**: Initial seller onboarding approval process
- **Commission Management**: Payout restrictions apply to inactive sellers
