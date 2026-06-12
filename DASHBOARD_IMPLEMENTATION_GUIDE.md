# Seller Inactive Feature - Dashboard Implementation Guide

## Overview
This document provides implementation guidance for integrating the seller inactive/active toggle feature into the admin and seller dashboards.

---

## 1. Admin Dashboard - Seller Management

### Feature: Toggle Seller Active/Inactive Status

#### Location
- Path: `/admin/sellers` or `/admin/sellers/:sellerId`
- Section: Seller Details / Seller Actions

#### UI Components Required

**Button/Action**
```
[Deactivate Seller] / [Activate Seller]
```

**Modal/Form**
```
Title: "Deactivate Seller Account"
Fields:
  - Reason (Text Area) - Optional but recommended
  - Confirm checkbox
Button: "Deactivate" / "Cancel"
```

#### Admin Actions Flow

```
Admin views seller detail page
         ↓
Sees current status: "Active" or "Deactivated"
         ↓
If Active:
  - Shows "Deactivate Seller" button
  - Optional: Shows warning "This will deactivate all seller's products"
         ↓
If Deactivated:
  - Shows "Reactivate Seller" button
  - Shows deactivation info:
    * Date deactivated
    * Deactivated by (admin name)
    * Reason
         ↓
Admin clicks button
         ↓
Modal appears (for deactivation) or instant (for reactivation)
         ↓
Admin submits
         ↓
API call to: PUT /admin/sellers/:sellerId/toggle-active
         ↓
Success/Error displayed
         ↓
UI updates with new status
```

---

## 2. API Integration

### Endpoint
```
PUT /admin/sellers/:sellerId/toggle-active
```

### JavaScript/React Example

```javascript
// Deactivate Seller
async function deactivateSeller(sellerId, reason) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/admin/sellers/${sellerId}/toggle-active`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          isActive: false,
          reason: reason
        })
      }
    );

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message);
    }

    return {
      success: true,
      productsDeactivated: data.data.productsDeactivated,
      seller: data.data.seller
    };
  } catch (error) {
    console.error('Deactivation failed:', error);
    throw error;
  }
}

// Reactivate Seller
async function reactivateSeller(sellerId) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/admin/sellers/${sellerId}/toggle-active`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          isActive: true
        })
      }
    );

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message);
    }

    return {
      success: true,
      seller: data.data.seller
    };
  } catch (error) {
    console.error('Reactivation failed:', error);
    throw error;
  }
}
```

---

## 3. Admin Dashboard - Seller Details Page

### Display Information

#### Seller Status Section
```
┌─────────────────────────────────┐
│ SELLER ACCOUNT STATUS           │
├─────────────────────────────────┤
│ Status: ACTIVE / DEACTIVATED    │
│                                  │
│ ┌───────────────────────────┐    │
│ │  [Deactivate/Activate]    │    │
│ └───────────────────────────┘    │
│                                  │
│ If Deactivated:                  │
│ ├─ Deactivated On: 2026-06-11   │
│ ├─ Deactivated By: Admin Name   │
│ ├─ Reason: [reason text]        │
│ └─ Products Affected: 42        │
└─────────────────────────────────┘
```

#### Products Section
```
┌─────────────────────────────────┐
│ SELLER PRODUCTS                 │
├─────────────────────────────────┤
│ Total: 50                        │
│ Active: 42                       │
│ Inactive: 8                      │
│ Deleted: 0                       │
│                                  │
│ If Seller Deactivated:          │
│ ⚠️ All products are inactive due │
│    to seller account deactivation│
└─────────────────────────────────┘
```

---

## 4. Seller Dashboard - Inactive Seller View

### What Changes for Inactive Seller

#### Homepage/Dashboard
```
┌─────────────────────────────────────────────┐
│  ⚠️ ACCOUNT DEACTIVATED                     │
├─────────────────────────────────────────────┤
│ Your account has been deactivated.          │
│                                              │
│ Reason: Violation of marketplace terms      │
│                                              │
│ You can view your data but cannot:          │
│ • Add or edit products                      │
│ • Create or edit coupons                    │
│ • Request payouts or bank changes           │
│ • Update order status                       │
│                                              │
│ Contact support for more information        │
└─────────────────────────────────────────────┘
```

#### Product Management
```
Products Page (Read-Only)
├─ Can view all products
├─ Cannot: Add Product (button disabled)
├─ Cannot: Edit Product (edit button disabled)
├─ Cannot: Delete Product (delete button disabled)
├─ Message on buttons: "Account deactivated"
└─ Tooltip: Shows reason
```

#### Orders Page
```
Orders Page (Read-Only)
├─ Can view all orders
├─ Cannot: Update Status (disabled)
├─ Cannot: Update Tracking (disabled)
├─ Cannot: Cancel Order (disabled)
└─ Message: "Account deactivated - read-only access"
```

#### Payout Section
```
Payout Page (Read-Only)
├─ Can view redeemable balance
├─ Can view payout history
├─ Cannot: Request Payout (button disabled)
└─ Message: "Account deactivated"
```

#### Profile Section
```
Profile Page (Read-Only)
├─ Can view profile information
├─ Cannot: Edit Profile (all fields disabled)
├─ Cannot: Upload Images (buttons disabled)
├─ Cannot: Update Bank Details (disabled)
└─ Message: "Account deactivated - read-only"
```

---

## 5. Implementation Checklist

### Admin Dashboard
- [ ] Add "Seller Status" section to seller details page
- [ ] Show current status (Active/Deactivated)
- [ ] Display deactivation details (date, by whom, reason)
- [ ] Add toggle button (Deactivate/Activate)
- [ ] Create modal/form for deactivation with reason field
- [ ] Implement API call to toggle status
- [ ] Show confirmation message with product count affected
- [ ] Refresh seller data after toggle
- [ ] Add error handling
- [ ] Add success notifications
- [ ] Update products list to show deactivation reason
- [ ] Add audit trail/history view (optional)

### Seller Dashboard
- [ ] Add deactivation banner to homepage
- [ ] Disable "Add Product" button with tooltip
- [ ] Disable all product edit/delete actions
- [ ] Disable coupon creation/editing
- [ ] Disable payout request button
- [ ] Disable profile edit button
- [ ] Disable order status update
- [ ] Disable bank change request
- [ ] Show helpful message explaining restrictions
- [ ] Provide support contact information
- [ ] Keep read-only access to all data
- [ ] Allow seller to continue viewing their store

---

## 6. UI Component Examples

### React - Toggle Button Component

```javascript
import React, { useState } from 'react';

function SellerStatusToggle({ seller, onToggle }) {
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [reason, setReason] = useState('');

  const handleToggle = async () => {
    if (!seller.isActive && !reason) {
      alert('Please provide a reason for deactivation');
      return;
    }

    setLoading(true);
    try {
      const result = await deactivateSeller(seller.userId, reason);
      setShowModal(false);
      setReason('');
      onToggle(result.seller);
      alert(result.success ? 
        `${result.productsDeactivated} products deactivated` : 
        'Error occurred'
      );
    } catch (error) {
      alert('Error: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const isDeactivated = !seller.isActive;

  return (
    <div className="seller-status-section">
      <h3>Account Status</h3>
      
      <div className="status-display">
        <span className={`status-badge ${isDeactivated ? 'inactive' : 'active'}`}>
          {isDeactivated ? 'DEACTIVATED' : 'ACTIVE'}
        </span>
      </div>

      {isDeactivated && (
        <div className="deactivation-info">
          <p><strong>Deactivated:</strong> {new Date(seller.deactivatedAt).toLocaleDateString()}</p>
          <p><strong>By:</strong> {seller.deactivatedBy}</p>
          <p><strong>Reason:</strong> {seller.inactiveReason}</p>
        </div>
      )}

      <button
        onClick={() => isDeactivated ? handleToggle() : setShowModal(true)}
        disabled={loading}
        className={isDeactivated ? 'btn-activate' : 'btn-deactivate'}
      >
        {loading ? 'Processing...' : isDeactivated ? 'Activate Seller' : 'Deactivate Seller'}
      </button>

      {showModal && (
        <div className="modal">
          <div className="modal-content">
            <h4>Deactivate Seller</h4>
            <p>This will deactivate the seller account and all their products.</p>
            
            <textarea
              placeholder="Reason for deactivation (required)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="reason-input"
            />

            <div className="modal-actions">
              <button onClick={() => setShowModal(false)} className="btn-cancel">Cancel</button>
              <button onClick={handleToggle} className="btn-confirm">Deactivate</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SellerStatusToggle;
```

### React - Deactivation Banner

```javascript
function DeactivationBanner({ seller }) {
  if (seller.isActive) return null;

  return (
    <div className="alert alert-warning">
      <h4>⚠️ Account Deactivated</h4>
      <p>Your account has been deactivated by our team.</p>
      <p><strong>Reason:</strong> {seller.inactiveReason}</p>
      <p>You can view your data but cannot perform any actions.</p>
      <p>
        <a href="/contact-support">Contact Support</a> for more information.
      </p>
    </div>
  );
}
```

---

## 7. API Response Handling

### Success Response (Deactivation)
```javascript
{
  "success": true,
  "message": "Seller account deactivated successfully. 42 active products have been deactivated.",
  "data": {
    "seller": {
      "id": "seller-uuid",
      "userId": "user-uuid",
      "storeName": "Store Name",
      "isActive": false,
      "deactivatedAt": "2026-06-11T14:30:00Z",
      "deactivatedBy": "admin-uuid",
      "inactiveReason": "Violation of terms"
    },
    "productsDeactivated": 42
  }
}
```

### Error Response
```javascript
{
  "success": false,
  "message": "Seller not found" // or other error message
}
```

---

## 8. Styling Guide

### Status Badge
```css
.status-badge {
  padding: 8px 12px;
  border-radius: 4px;
  font-weight: bold;
  font-size: 12px;
}

.status-badge.active {
  background-color: #d4edda;
  color: #155724;
}

.status-badge.inactive {
  background-color: #f8d7da;
  color: #721c24;
}
```

### Deactivation Banner
```css
.alert {
  padding: 16px;
  margin-bottom: 16px;
  border-radius: 4px;
  border-left: 4px solid;
}

.alert-warning {
  background-color: #fff3cd;
  border-color: #ffc107;
  color: #856404;
}

.alert h4 {
  margin-top: 0;
}

.alert p {
  margin-bottom: 8px;
}
```

### Disabled State
```css
button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

button:disabled:hover {
  background-color: inherit;
}

.disabled-overlay {
  opacity: 0.5;
  pointer-events: none;
}
```

---

## 9. Testing Scenarios

### Test Case 1: Deactivate Seller
1. Navigate to seller details page
2. Click "Deactivate Seller" button
3. Enter reason in modal
4. Click "Deactivate"
5. Verify: Success message shown with product count
6. Verify: Status changed to "DEACTIVATED"
7. Verify: Deactivation info displayed
8. Verify: Seller cannot perform restricted actions

### Test Case 2: Reactivate Seller
1. View deactivated seller
2. Click "Activate Seller" button
3. Verify: No modal appears
4. Verify: Status changed to "ACTIVE"
5. Verify: Seller can perform all actions again

### Test Case 3: Seller Views Dashboard While Inactive
1. Login as inactive seller
2. Verify: Deactivation banner displayed
3. Verify: Add/Edit/Delete buttons are disabled
4. Verify: All pages in read-only mode
5. Verify: Helpful message shown

---

## 10. Notifications & Alerts

### To Admin (On Deactivation)
```
✅ Seller "Store Name" deactivated
42 products have been deactivated
```

### To Seller (Optional Email)
```
Subject: Your account has been deactivated

Dear Seller,

Your marketplace account has been deactivated effective immediately.

Reason: [reason provided]

You can still view your store and data, but you cannot:
- Add or edit products
- Create or manage coupons
- Request payouts
- Update order status

Contact us: support@marketplace.com
```

---

## 11. Rollback Plan

If you need to revert deactivated products:
```javascript
// Manual SQL to reactivate products
UPDATE products
SET isActive = true, status = 'ACTIVE'
WHERE sellerId = 'seller-id' 
  AND sellerInactiveReason IS NOT NULL;
```

---

## 12. Security Considerations

- ✅ Only Admin/Super Admin can toggle
- ✅ Seller cannot change own status
- ✅ All toggles logged with admin ID
- ✅ Reason field is audited
- ✅ No bypass in frontend validation
- ✅ Backend enforces all restrictions

---

## Next Steps

1. Implement admin dashboard components
2. Integrate API calls
3. Style components to match design
4. Test all user flows
5. Deploy to staging
6. Get approval from team
7. Deploy to production
