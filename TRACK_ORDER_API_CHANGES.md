# Order Tracking API — Breaking Changes

**Date:** March 19, 2026  
**Endpoint:** `GET /api/orders/guest/track`

---

## Summary

The order tracking endpoint has been updated to:

1. **Support registered users** — previously only intended for guests, the endpoint now works for any customer (guest or registered) using their order display ID and email.
2. **Remove duplicate/redundant fields** from the response to reduce payload size.
3. **Restructure the response** to be cleaner and more consistent.

---

## What Changed in the Response

### Fields Removed

| Field | Why Removed |
|---|---|
| `customerEmail` | Redundant — the caller already supplies it as a query parameter |
| `shippingAddressLine` | Duplicate — now inside the `shippingAddress` object |
| `shippingCity` | Duplicate — now inside the `shippingAddress` object |
| `shippingState` | Duplicate — now inside the `shippingAddress` object |
| `shippingZipCode` | Duplicate — now inside the `shippingAddress` object |
| `shippingCountry` | Duplicate — now inside the `shippingAddress` object |
| `shippingPhone` | Duplicate — now inside the `shippingAddress` object |

### Fields Added

| Field | Description |
|---|---|
| `displayId` | The human-readable order reference (e.g. `QSMQ2N`) — use this for display in UI |
| `orderSummary` | Moved to the top level (was previously buried inside `shippingAddress`) |

### Fields Restructured

**`shippingAddress`** — Previously a raw JSON blob with inconsistent keys, now a clean flat object:

```jsonc
// BEFORE
"shippingAddress": {
    "city": "DehraDun",
    "state": "Uttarakhand",
    "country": "Australia",
    "zipCode": "248001",
    "addressLine": "42 Haridwar Road, 42",
    "orderSummary": { ... }   // ← was wrongly nested here
},
"shippingAddressLine": "42 Haridwar Road, 42",  // ← duplicate
"shippingCity": "DehraDun",                      // ← duplicate
"shippingState": "Uttarakhand",                  // ← duplicate
"shippingZipCode": "248001",                     // ← duplicate
"shippingCountry": "Australia",                  // ← duplicate
"shippingPhone": "+91 6397731399",               // ← duplicate

// AFTER
"shippingAddress": {
    "addressLine": "42 Haridwar Road, 42",
    "city": "DehraDun",
    "state": "Uttarakhand",
    "zipCode": "248001",
    "country": "Australia",
    "phone": "+91 6397731399"
},
"orderSummary": { ... }   // ← now at top level
```

---

## Full Response Shape (After Changes)

```jsonc
{
    "success": true,
    "order": {
        "id": "cmmwgqtmo0001vq9jbpdmyl70",         // internal CUID
        "displayId": "QSMQ2N",                      // ← NEW: human-readable ref
        "orderType": "SINGLE_SELLER",
        "status": "CONFIRMED",
        "totalAmount": "515",
        "customerName": "Shubham Sharma",
        "customerPhone": "+91 6397731399",
        "shippingAddress": {                         // ← RESTRUCTURED (no more flat duplicates)
            "addressLine": "42 Haridwar Road, 42",
            "city": "DehraDun",
            "state": "Uttarakhand",
            "zipCode": "248001",
            "country": "Australia",
            "phone": "+91 6397731399"
        },
        "orderSummary": {                            // ← MOVED: was inside shippingAddress before
            "subtotal": "500.00",
            "gstAmount": "45.45",
            "couponCode": null,
            "finalTotal": 515,
            "grandTotal": "515.00",
            "gstDetails": { ... },
            "gstInclusive": true,
            "shippingCost": "15.00",
            "gstPercentage": "10.00",
            "subtotalExGST": "454.55",
            "discountAmount": 0,
            "shippingMethod": { ... }
        },
        "trackingNumber": null,
        "estimatedDelivery": null,
        "items": [
            {
                "id": "cmmwgqtmo0003vq9jz0t11f9n",
                "orderId": "cmmwgqtmo0001vq9jbpdmyl70",
                "subOrderId": null,
                "productId": "cmm8tzcmn001bkig51o2vloqh",
                "quantity": 1,
                "price": "500",
                "createdAt": "2026-03-18T19:57:44.448Z",
                "product": {
                    "id": "cmm8tzcmn001bkig51o2vloqh",
                    "title": "Carpet",
                    "featuredImage": "https://...",
                    "price": "500"
                }
            }
        ],
        "subOrders": null,   // populated for MULTI_SELLER orders, null otherwise
        "createdAt": "2026-03-18T19:57:44.448Z",
        "updatedAt": "2026-03-18T19:58:10.027Z"
    }
}
```

---

## Required Frontend Updates

### 1. Update shipping address field access

```js
// BEFORE
order.shippingAddressLine
order.shippingCity
order.shippingState
order.shippingZipCode
order.shippingCountry
order.shippingPhone

// AFTER
order.shippingAddress.addressLine
order.shippingAddress.city
order.shippingAddress.state
order.shippingAddress.zipCode
order.shippingAddress.country
order.shippingAddress.phone
```

### 2. Update order summary access

```js
// BEFORE
order.shippingAddress.orderSummary
order.shippingAddress.orderSummary.subtotal
order.shippingAddress.orderSummary.shippingMethod

// AFTER
order.orderSummary
order.orderSummary.subtotal
order.orderSummary.shippingMethod
```

### 3. Use `displayId` for display, `id` for API calls

```js
// Show to the user
`Order #${order.displayId}`   // e.g. "Order #QSMQ2N"

// Use internally for API requests that need the CUID
order.id   // e.g. "cmmwgqtmo0001vq9jbpdmyl70"
```

### 4. Remove any usage of `order.customerEmail` from the response

It is no longer returned. Use the email the user typed into the tracking form instead.

---

## Endpoint Usage (Unchanged)

Both guests and registered users use the exact same endpoint:

```
GET /api/orders/guest/track?orderId=QSMQ2N&customerEmail=user@example.com
```

| Query Param | Required | Description |
|---|---|---|
| `orderId` | Yes | The display ID (e.g. `QSMQ2N`) — shown on order confirmation page and email |
| `customerEmail` | Yes | The email address used when placing the order |

**Error responses (unchanged):**

| Status | Message | Cause |
|---|---|---|
| `400` | Order ID and customer email are required | Missing query params |
| `404` | Order not found | Display ID doesn't exist |
| `403` | Email does not match order | Wrong email for that order |
| `500` | Internal server error | Server-side failure |
