# Refund Request API — Frontend Integration Guide

## Overview

The refund system supports two user types:
- **Authenticated users** — use JWT-authenticated endpoints
- **Guests** — use email+orderId verification endpoints (legacy format, see §4)

`requestType` is **never sent by the frontend** — the backend auto-determines it:
- All order items at full quantities → `REFUND` (Full Refund)
- Subset of items or quantities → `PARTIAL_REFUND` (Partial Refund)

---

## 1. Find Eligible Order for Refund

Use this before showing the refund form to fetch order items and validate eligibility.

```
POST /api/orders/guest/track-for-refund
Content-Type: application/json
```

Works for both guests and logged-in users.

**Request:**
```json
{
  "orderId": "N50867",
  "customerEmail": "customer@example.com"
}
```

**Success Response `200`:**
```json
{
  "success": true,
  "order": {
    "id": "cmc...",
    "displayId": "N50867",
    "status": "DELIVERED",
    "totalAmount": "120.00",
    "customerName": "Jane Smith",
    "items": [
      {
        "id": "cmc_item_1",
        "productId": "cmc_prod_1",
        "title": "Blue T-Shirt",
        "quantity": 2,
        "price": "40.00",
        "image": "https://res.cloudinary.com/..."
      },
      {
        "id": "cmc_item_2",
        "productId": "cmc_prod_2",
        "title": "Black Jeans",
        "quantity": 1,
        "price": "40.00",
        "image": "https://res.cloudinary.com/..."
      }
    ]
  }
}
```

**Use this response to:**
- Pre-populate the refund form with order items
- Show item images, names, and max quantities
- Check eligibility (must be `DELIVERED` status)

---

## 2. Submit Refund Request (Authenticated User)

```
POST /api/orders/refund-request/:displayId
Authorization: Bearer <token>
Content-Type: application/json
```

### 2a. Full Refund (all items — single seller or same reason for all)

Omit `items` entirely or send an empty array when one reason applies to everything.
The backend copies the top-level `reason` to every item automatically.

```json
{
  "reason": "Items arrived damaged and not usable",
  "attachments": [
    "https://res.cloudinary.com/your-cloud/image/upload/v1/refund-evidence/abc.jpg"
  ]
}
```

### 2b. Full Refund (multi-seller order, different reasons per seller's items)

> **Important:** In multi-seller orders each seller only sees **their own items and their reason**.
> If the reason differs per seller, you must send the `items` array even for a full refund.
> The backend will still auto-detect it as `REFUND` because all items are included at full quantity.

```json
{
  "items": [
    {
      "orderItemId": "cmc_item_1",
      "quantity": 2,
      "reason": "Seller A — wrong colour received",
      "attachments": ["https://res.cloudinary.com/your-cloud/image/upload/v1/refund-evidence/shirt.jpg"]
    },
    {
      "orderItemId": "cmc_item_2",
      "quantity": 1,
      "reason": "Seller B — item arrived broken",
      "attachments": []
    }
  ]
}
```

Seller A sees only item 1 with reason "wrong colour received".
Seller B sees only item 2 with reason "item arrived broken".
The admin sees both with their individual reasons.
`requestType` is auto-set to `REFUND` (full) by the backend.

### 2b. Partial Refund (specific items/quantities)

Include only the items being returned.

```json
{
  "items": [
    {
      "orderItemId": "cmc_item_1",
      "quantity": 1,
      "reason": "Wrong size received",
      "attachments": [
        "https://res.cloudinary.com/your-cloud/image/upload/v1/refund-evidence/shirt.jpg"
      ]
    },
    {
      "orderItemId": "cmc_item_2",
      "quantity": 1,
      "reason": "Item was defective",
      "attachments": []
    }
  ],
  "reason": "Fallback reason if an item has none",
  "attachments": []
}
```

**Field reference:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `items` | `array` | No | Omit or empty = full refund |
| `items[].orderItemId` | `string` | Yes | From order items list |
| `items[].quantity` | `number` | Yes | 1 to the ordered quantity |
| `items[].reason` | `string` | No | Per-item reason; falls back to top-level `reason` |
| `items[].attachments` | `string[]` | No | Pre-uploaded Cloudinary URLs for this item |
| `reason` | `string` | No* | Top-level fallback reason (*required if items have none) |
| `attachments` | `string[]` | No | Top-level fallback attachments |

**Success Response `201`:**
```json
{
  "success": true,
  "message": "Partial Refund Request submitted successfully",
  "request": {
    "id": "cmc_ticket_id",
    "orderId": "cmc_order_id",
    "orderDisplayId": "#N50867",
    "requestType": "PARTIAL_REFUND",
    "reason": "Fallback reason if an item has none",
    "requestedItems": [
      {
        "orderItemId": "cmc_item_1",
        "productId": "cmc_prod_1",
        "title": "Blue T-Shirt",
        "image": "https://res.cloudinary.com/...",
        "quantity": 1,
        "price": "40.00",
        "reason": "Wrong size received",
        "attachments": ["https://res.cloudinary.com/..."]
      },
      {
        "orderItemId": "cmc_item_2",
        "productId": "cmc_prod_2",
        "title": "Black Jeans",
        "image": "https://res.cloudinary.com/...",
        "quantity": 1,
        "price": "40.00",
        "reason": "Item was defective",
        "attachments": []
      }
    ],
    "attachments": [],
    "status": "OPEN",
    "createdAt": "2026-04-07T10:00:00.000Z"
  }
}
```

---

## 3. Track Refund Requests (Authenticated User)

### List All

```
GET /api/orders/refund-requests
Authorization: Bearer <token>
```

**Response `200`:**
```json
{
  "success": true,
  "count": 2,
  "requests": [
    {
      "id": "cmc_ticket_id",
      "requestId": "cmc_ticket_id",
      "orderId": "cmc_order_id",
      "orderDisplayId": "#N50867",
      "requestType": "PARTIAL_REFUND",
      "reason": "Wrong size received",
      "requestedItems": [ ... ],
      "attachments": [],
      "guestEmail": null,
      "status": "OPEN",
      "priority": "MEDIUM",
      "adminResponse": null,
      "createdAt": "2026-04-07T10:00:00.000Z",
      "updatedAt": "2026-04-07T10:00:00.000Z"
    }
  ]
}
```

### Single by Request ID

```
GET /api/orders/refund-requests/:requestId
Authorization: Bearer <token>
```

Returns the same shape as a single item from the list above under `.request`.

---

## 4. Guest Refund Request (Legacy Format)

> **Note:** The guest endpoint currently uses the original request body format. Send `requestType` explicitly.

```
POST /api/orders/guest/refund-request
Content-Type: application/json   (or multipart/form-data for file uploads)
```

**JSON body:**
```json
{
  "orderId": "N50867",
  "customerEmail": "guest@example.com",
  "requestType": "refund",
  "reason": "Damaged on arrival",
  "items": [
    { "productId": "cmc_prod_1", "title": "Blue T-Shirt", "quantity": 1 }
  ],
  "images": [
    "https://res.cloudinary.com/your-cloud/image/upload/v1/refund-evidence/abc.jpg"
  ]
}
```

**`requestType` values:**
- `"refund"` → Full Refund
- `"partial_refund"` → Partial Refund

**Form-data file upload (alternative):**

Send as `multipart/form-data`. Files are uploaded for you server-side to Cloudinary.

| Field | Type | Notes |
|-------|------|-------|
| `orderId` | text | |
| `customerEmail` | text | |
| `requestType` | text | `"refund"` or `"partial_refund"` |
| `reason` | text | |
| `items` | text (JSON) | JSON-stringified array |
| `file` (multiple) | file | JPEG/PNG/WEBP, max 5MB each, max 5 files |

**Success Response `200`:**
```json
{
  "success": true,
  "message": "Full Refund Request submitted successfully",
  "ticketId": "cmc_ticket_id",
  "request": {
    "id": "cmc_ticket_id",
    "orderId": "cmc_order_id",
    "displayId": "N50867",
    "requestType": "REFUND",
    "reason": "Damaged on arrival",
    "guestEmail": "guest@example.com",
    "attachments": ["https://res.cloudinary.com/..."],
    "status": "OPEN",
    "createdAt": "2026-04-07T10:00:00.000Z"
  }
}
```

### Track Guest Refund Requests

```
GET /api/orders/guest/refund-requests?orderId=N50867&customerEmail=guest@example.com
GET /api/orders/guest/refund-requests/:requestId?orderId=N50867&customerEmail=guest@example.com
```

Both require `orderId` and `customerEmail` as query params for verification.

---

## 5. Uploading Attachments

Images must be uploaded to Cloudinary before submitting the refund form (for the auth user endpoint). Use the existing upload endpoint:

```
POST /api/upload/image
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

Collect the returned URL and include it in `attachments` or `items[].attachments`.

For guests, files can be sent directly in the `multipart/form-data` refund request and are uploaded server-side.

---

## 6. Status Values

| Value | Display Label | Meaning |
|-------|--------------|---------|
| `OPEN` | Under Review | Submitted, awaiting admin action |
| `IN_PROGRESS` | In Progress | Admin is processing |
| `RESOLVED` | Resolved | Refund approved/processed |
| `CLOSED` | Closed | Request closed |

---

## 7. Error Responses

All errors return:
```json
{
  "success": false,
  "message": "Human-readable error message"
}
```

**Common error scenarios:**

| HTTP | Message | Fix |
|------|---------|-----|
| `400` | `"items" must be an array` | Send `items` as `[]` or array |
| `400` | `Order item "..." not found in this order` | `orderItemId` doesn't belong to this order |
| `400` | `Invalid quantity 5 for item "..." (max: 2)` | Quantity exceeds what was ordered |
| `400` | `A reason is required for item "..."` | Add `reason` per item or top-level |
| `400` | `Refund requests can only be made for delivered orders` | Order not yet delivered |
| `400` | `Cannot request a refund for an order in REFUND status` | Already refunded |
| `403` | `Not authorized` | User doesn't own this order |
| `404` | `Order not found` | Wrong `displayId` |

---

## 8. Recommended UI Flow

### Step 1 — Order Selection
Show user their delivered orders. Each order gets a **"Request Refund"** button.

### Step 2 — Item Selection
Call `POST /api/orders/guest/track-for-refund` (or use cached order data) to list all items.

- Show checkboxes next to each item
- For selected items, show a quantity spinner (1 to ordered qty)
- **Always show a per-item reason field** — even if the user selects all items for a full refund
  - For single-seller orders: a single top-level reason field is fine (sent without `items`)
  - For multi-seller orders: always use the `items` array with per-item reasons so each seller sees only their relevant reason
- If user selects all items at full qty → UI can show "Full Refund" badge (backend auto-detects)

### Step 3 — Reason & Attachments
- **Top-level reason** — shown when doing a full refund or as a fallback
- **Per-item reason** — shown when partial; each selected item gets its own reason field
- **Attachments** — upload images (pre-upload via `/api/upload/image`), then store URLs

### Step 4 — Submit
```javascript
// Full refund — single seller or same reason for all items
const res = await fetch(`/api/orders/refund-request/${order.displayId}`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    reason: 'All items arrived damaged',
    attachments: uploadedUrls
  })
});

// Full refund — multi-seller order (send items array so each seller gets the right reason)
const res = await fetch(`/api/orders/refund-request/${order.displayId}`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    items: order.items.map(item => ({
      orderItemId: item.id,
      quantity: item.quantity,          // full quantity = full refund
      reason: item.reason,             // per-item reason per seller
      attachments: item.uploadedUrls ?? []
    }))
    // no top-level reason needed when every item has its own
  })
});

// Partial refund — subset of items/quantities
const res = await fetch(`/api/orders/refund-request/${order.displayId}`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    items: selectedItems.map(item => ({
      orderItemId: item.id,
      quantity: item.selectedQty,
      reason: item.reason,
      attachments: item.uploadedUrls ?? []
    })),
    reason: globalReasonFallback    // fallback if any item is missing a reason
  })
});

const data = await res.json();
if (data.success) {
  // Show confirmation with data.request.orderDisplayId and data.request.requestType
}
```

### Step 5 — Confirmation & Tracking
- Display `request.orderDisplayId`, `request.requestType`, and `request.status`
- Customer receives a confirmation email automatically
- Link to `GET /api/orders/refund-requests/:requestId` for status polling
