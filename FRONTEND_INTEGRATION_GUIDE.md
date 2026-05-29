# Frontend Integration Guide - Multi-Seller Order System

## Overview

This document outlines the backend changes made to implement a **parent-child order architecture** for multi-seller orders, along with enhanced notification systems. This fixes the critical bug where sellers could see all products from multi-seller orders.

---

## 🚨 Critical Changes Summary

### 1. **Parent-Child Order Architecture**
- **Parent Order**: Contains customer info, payment, shipping details
- **Sub-Orders**: One per seller, contains only that seller's products
- **Seller Isolation**: Sellers can only see/manage their own sub-orders

### 2. **Enhanced Notification System**
- Category request notifications for admins
- Seller registration notifications for admins
- Improved order status notifications

---

## 📋 Database Schema Changes

### New Models Added

#### `SubOrder` Model
```prisma
model SubOrder {
  id              String   @id @default(cuid())
  parentOrderId   String
  sellerId        String
  status          String
  trackingNumber  String?
  estimatedDelivery DateTime?
  statusReason    String?
  subtotal        Decimal
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  
  parentOrder     Order @relation(fields: [parentOrderId], references: [id])
  seller          User @relation(fields: [sellerId], references: [id])
  items           OrderItem[]
}
```

#### Updated `Order` Model
```prisma
model Order {
  // ... existing fields
  subOrders       SubOrder[]  // NEW: Relationship to sub-orders
}
```

#### Updated `OrderItem` Model
```prisma
model OrderItem {
  // ... existing fields
  subOrderId      String?     // NEW: Links to SubOrder instead of Order
  subOrder        SubOrder? @relation(fields: [subOrderId], references: [id])
}
```

---

## 🔄 API Endpoint Changes

### 1. **Order Creation** (`POST /api/orders`)

#### **Before**: Single order with all products
#### **After**: Parent order + sub-orders per seller

**Response Structure (No Change for Frontend)**:
```json
{
  "success": true,
  "message": "Order placed successfully",
  "orderId": "parent-order-id",
  "totalAmount": 150.00
}
```

**Internal Changes**:
- Creates one parent `Order`
- Creates `SubOrder` for each unique seller
- Distributes `OrderItem`s to appropriate sub-orders

---

### 2. **Seller Order Management**

#### **Get Seller Orders** (`GET /api/seller/orders`)

**⚠️ IMPORTANT**: Response structure maintained for backward compatibility, but now returns `SubOrder` data formatted as regular orders.

**Response Changes**:
```json
{
  "success": true,
  "orders": [
    {
      "id": "suborder-id",           // ⚠️ This is now SubOrder ID
      "parentOrderId": "order-id",   // 🆕 NEW: Reference to parent order
      "status": "pending",
      "trackingNumber": null,
      "subtotal": 75.00,            // ⚠️ Only this seller's portion
      "items": [/* only seller's products */],
      "customerName": "John Doe",   // From parent order
      "customerEmail": "john@example.com",
      "shippingAddress": "...",     // From parent order
      // ... other fields from parent order
    }
  ],
  "count": 1
}
```

**Frontend Impact**: 
- **No changes needed** - response structure is identical
- Order IDs are now SubOrder IDs (transparent to frontend)
- Sellers only see their own products (bug fix)

---

#### **Update Order Status** (`PUT /api/seller/orders/:orderId/status`)

**⚠️ IMPORTANT**: `orderId` parameter is now `subOrderId`

**Request (No Change)**:
```json
{
  "status": "shipped",
  "trackingNumber": "TRK123456",
  "estimatedDelivery": "2026-03-15",
  "statusReason": "Package dispatched"
}
```

**Response (Updated)**:
```json
{
  "success": true,
  "message": "Order status updated successfully. Customer notified via email.",
  "updatedStatus": "SHIPPED",
  "subOrder": {                    // 🆕 Changed from "order"
    "id": "suborder-id",
    "status": "shipped",
    "trackingNumber": "TRK123456",
    "estimatedDelivery": "2026-03-15T00:00:00.000Z",
    "statusReason": "Package dispatched"
  }
}
```

**Frontend Impact**:
- Response field changed from `order` to `subOrder`
- Status updates now only affect this seller's portion of the order

---

### 3. **Customer Order Views** (Requires Updates)

#### **Get My Orders** (`GET /api/orders/my-orders`)

**⚠️ BREAKING CHANGE**: This endpoint needs frontend updates to display multi-seller orders correctly.

**Current Response** (needs updating):
```json
{
  "success": true,
  "orders": [
    {
      "id": "parent-order-id",
      "totalAmount": 150.00,
      "status": "pending",           // ⚠️ Needs aggregation logic
      "items": [/* all items */],
      "createdAt": "2026-03-10",
      "subOrders": [                 // 🆕 NEW: Sub-order details
        {
          "id": "suborder-1",
          "sellerId": "seller-1",
          "sellerName": "Shop A",
          "status": "shipped",
          "trackingNumber": "TRK123",
          "subtotal": 75.00,
          "items": [/* seller 1 items */]
        },
        {
          "id": "suborder-2", 
          "sellerId": "seller-2",
          "sellerName": "Shop B",
          "status": "pending",
          "trackingNumber": null,
          "subtotal": 75.00,
          "items": [/* seller 2 items */]
        }
      ]
    }
  ]
}
```

**Required Frontend Updates**:
1. **Display sub-orders separately** within each parent order
2. **Show individual tracking numbers** per seller
3. **Display different statuses** per sub-order
4. **Handle partial shipments** (some sellers shipped, others pending)

---

## 🔔 Notification System Changes

### 1. **New Category Request Notifications**

#### **Admin Dashboard** - New notification types:
- `CATEGORY_REQUEST` - New category submitted for approval
- `CATEGORY_REQUEST_RESUBMITTED` - Category resubmitted after rejection

**API**: `GET /api/notifications`
```json
{
  "type": "CATEGORY_REQUEST",
  "title": "New Category Request: Electronics > Smartphones", 
  "message": "John Doe has submitted a new category request",
  "data": {
    "categoryName": "Smartphones",
    "parentCategory": "Electronics",
    "submitterId": "user-id",
    "submitterName": "John Doe"
  }
}
```

### 2. **New Seller Registration Notifications**

#### **Admin Dashboard** - New notification type:
- `SELLER_APPLICATION` - New seller application submitted

```json
{
  "type": "SELLER_APPLICATION", 
  "title": "New Seller Application",
  "message": "Jane Smith has applied to become a seller",
  "data": {
    "applicantId": "user-id",
    "applicantName": "Jane Smith",
    "businessName": "Jane's Store"
  }
}
```

### 3. **Enhanced Order Notifications**

**Order status notifications now reference SubOrder IDs**:
```json
{
  "type": "ORDER_STATUS_CHANGED",
  "title": "Order Shipped",
  "message": "Your order from Shop A has been shipped", 
  "data": {
    "orderId": "suborder-id",        // ⚠️ Now SubOrder ID
    "parentOrderId": "order-id",     // 🆕 Parent order reference
    "status": "shipped",
    "trackingNumber": "TRK123",
    "sellerName": "Shop A"
  }
}
```

---

## 🛠️ Required Frontend Updates

### **High Priority (Breaking Changes)**

1. **Customer Order Details Page**
   - Display sub-orders as separate sections
   - Show individual tracking per seller
   - Handle mixed statuses (some shipped, some pending)
   - Update order status aggregation logic

2. **Admin Notifications**
   - Add handlers for `CATEGORY_REQUEST` notifications
   - Add handlers for `SELLER_APPLICATION` notifications  
   - Update notification icons/styling for new types

### **Medium Priority (Enhanced UX)**

1. **Order Confirmation Emails**
   - Update templates to show sub-order breakdown
   - Include seller information per sub-order

2. **Seller Dashboard**
   - Update status update success messages
   - Handle new `subOrder` response field

### **Testing Recommendations**

1. **Multi-Seller Order Flow**:
   - Create order with products from 2+ sellers
   - Verify sellers only see their products
   - Test independent status updates per seller
   - Verify customer sees aggregated view

2. **Notification Testing**:
   - Submit category requests as regular user
   - Apply as seller and verify admin notifications
   - Test order status notifications with sub-orders

---

## 🔍 Backward Compatibility

### **Safe Changes** (No Frontend Updates Needed)
- Seller order listing API (maintains response structure)
- Order creation API (same response)
- Basic order status updates (same request format)

### **Breaking Changes** (Frontend Updates Required)
- Customer order details (needs sub-order display)
- Order status response field (`order` → `subOrder`)
- Notification data structure (new types and SubOrder IDs)

---

## 🚀 Migration Notes

### **Database Migration**
- All existing orders remain as parent orders
- New orders will create sub-orders automatically
- No data loss during migration

### **API Versioning**
- Current endpoints maintained for compatibility
- New sub-order fields added to responses
- Frontend can implement changes incrementally

---

## 📞 Support

For questions about these changes or integration support:
- Check the updated API documentation
- Test with sample multi-seller orders
- Verify notification system with category/seller applications

---

**Last Updated**: March 10, 2026  
**Backend Version**: v2.0.0 (Multi-Seller Orders)