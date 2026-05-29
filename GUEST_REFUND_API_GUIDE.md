# Guest Refund API Guide

All guest refund endpoints require **no authentication**. Identity is verified using `orderId` (display ID) and `customerEmail` on every request.

**Rate Limit:** 5 requests per minute per IP across all guest refund endpoints.

**Base URL:** `/api/orders`

---

## Table of Contents

1. [Step 1 — Find Eligible Order](#step-1--find-eligible-order)
2. [Step 2 — Submit Refund Request](#step-2--submit-refund-request)
   - [JSON Body (Simple)](#option-a-json-body-simple)
   - [Multipart Form (With Image Uploads)](#option-b-multipart-form-with-image-uploads)
   - [Multi-seller Orders](#multi-seller-orders)
3. [Step 3 — Track Refund Requests](#step-3--track-refund-requests)
4. [Step 4 — Get Single Refund Request](#step-4--get-single-refund-request)
5. [Status Values](#status-values)
6. [Error Reference](#error-reference)
7. [UI Flow](#ui-flow)

---

## Step 1 — Find Eligible Order

Before submitting a refund the frontend should call this to verify the order exists, confirm the email, and retrieve the deliverable items.

**`POST /api/orders/guest/track-for-refund`**

### Request Body

```json
{
  "orderId": "N50867",
  "customerEmail": "jane@example.com"
}
```

> `orderId` can be passed with or without the `#` prefix — both `"N50867"` and `"#N50867"` are accepted.

### Success Response `200`

```json
{
  "success": true,
  "order": {
    "id": "clx9...",
    "displayId": "N50867",
    "customerName": "Jane Doe",
    "customerEmail": "jane@example.com",
    "isGuest": true,
    "eligibleRefundOrders": [
      {
        "id": "clx9...",
        "displayId": "N50867",
        "sellerId": "clseller...",
        "sellerName": "Tech Store",
        "status": "DELIVERED",
        "deliveredAt": "2025-04-01T10:00:00.000Z",
        "items": [
          {
            "orderItemId": "clitem123...",
            "productId": "clprod...",
            "title": "Wireless Headphones",
            "image": "https://res.cloudinary.com/.../image.jpg",
            "quantity": 2,
            "price": "49.99"
          }
        ]
      }
    ]
  }
}
```

> `eligibleRefundOrders` only includes sub-orders (or the main order) with status `DELIVERED`. If the array is empty, the order has no items eligible for a refund yet.

Each item in the response includes `orderItemId` — use this directly when submitting the refund request.

---

## Step 2 — Submit Refund Request

**`POST /api/orders/guest/refund-request`**

Supports two content types:

### Option A: JSON Body (Simple)

**Content-Type:** `application/json`

#### Full Refund (all items, single reason)

```json
{
  "orderId": "N50867",
  "customerEmail": "jane@example.com",
  "reason": "Items arrived damaged"
}
```

> Omitting `items` or sending an empty array triggers a **full refund** covering all items in the order.

#### Partial Refund (specific items)

```json
{
  "orderId": "N50867",
  "customerEmail": "jane@example.com",
  "reason": "General reason (fallback)",
  "items": [
    {
      "orderItemId": "clitem123...",
      "quantity": 1,
      "reason": "Wrong size delivered"
    }
  ]
}
```

#### Per-item Attachments (JSON URLs)

If you already have Cloudinary URLs (e.g., uploaded separately), pass them per-item:

```json
{
  "orderId": "N50867",
  "customerEmail": "jane@example.com",
  "items": [
    {
      "orderItemId": "clitem123...",
      "quantity": 1,
      "reason": "Item has scratches",
      "attachments": [
        "https://res.cloudinary.com/.../scratch1.jpg",
        "https://res.cloudinary.com/.../scratch2.jpg"
      ]
    }
  ]
}
```

---

### Option B: Multipart Form (With Image Uploads)

**Content-Type:** `multipart/form-data`

Use this when the customer selects image files from their device to upload as refund evidence.

| Field | Type | Description |
|---|---|---|
| `orderId` | text | Display order ID |
| `customerEmail` | text | Customer email |
| `reason` | text | Top-level / fallback reason |
| `items` | text (JSON string) | Array of item objects (same shape as JSON body) |
| `attachments` | text (JSON string) | Pre-existing URL array (optional) |
| files | file | Any number of image files (up to 5) |

**File constraints:**
- Accepted types: `image/jpeg`, `image/png`, `image/webp`
- Max size per file: **5 MB**
- Max files: **5**
- Files are uploaded to Cloudinary automatically and merged with any existing `attachments` URLs

**Example (JavaScript `FormData`):**

```js
const formData = new FormData();
formData.append('orderId', 'N50867');
formData.append('customerEmail', 'jane@example.com');
formData.append('reason', 'Item arrived broken');
formData.append('items', JSON.stringify([
  { orderItemId: 'clitem123...', quantity: 1, reason: 'Cracked screen' }
]));
formData.append('file', imageFile1);   // File object from <input type="file">
formData.append('file', imageFile2);

const response = await fetch('/api/orders/guest/refund-request', {
  method: 'POST',
  body: formData
  // Do NOT set Content-Type manually — let the browser set it with the boundary
});
```

---

### Multi-seller Orders

If the order contains products from multiple sellers, include **all items you want to refund** in the `items` array, each with their own reason. Each seller will receive a notification and email listing only their affected products.

```json
{
  "orderId": "N50867",
  "customerEmail": "jane@example.com",
  "items": [
    {
      "orderItemId": "clitem_seller1_product...",
      "quantity": 1,
      "reason": "Wrong colour"
    },
    {
      "orderItemId": "clitem_seller2_product...",
      "quantity": 2,
      "reason": "Never arrived"
    }
  ]
}
```

> If you include all items at full quantity, the request is automatically treated as a **full refund**. Otherwise it becomes a **partial refund**. You do not set `requestType` manually — the server determines it.

---

### Success Response `201`

```json
{
  "success": true,
  "message": "Full Refund Request submitted successfully",
  "request": {
    "id": "clticket...",
    "orderId": "clx9...",
    "orderDisplayId": "#N50867",
    "requestType": "REFUND",
    "reason": "Items arrived damaged",
    "requestedItems": [
      {
        "orderItemId": "clitem123...",
        "productId": "clprod...",
        "title": "Wireless Headphones",
        "image": "https://res.cloudinary.com/.../image.jpg",
        "quantity": 2,
        "price": "49.99",
        "reason": "Items arrived damaged",
        "attachments": []
      }
    ],
    "attachments": [],
    "guestEmail": "jane@example.com",
    "status": "OPEN",
    "createdAt": "2025-04-08T12:00:00.000Z"
  }
}
```

`requestType` is either `"REFUND"` (full) or `"PARTIAL_REFUND"` (partial).

---

## Step 3 — Track Refund Requests

List all refund requests associated with a guest order.

**`GET /api/orders/guest/refund-requests?orderId=N50867&customerEmail=jane@example.com`**

### Query Parameters

| Param | Required | Description |
|---|---|---|
| `orderId` | ✅ | Display order ID (without `#`) |
| `customerEmail` | ✅ | Email used when placing the order |

### Success Response `200`

```json
{
  "success": true,
  "count": 1,
  "requests": [
    {
      "id": "clticket...",
      "orderId": "clx9...",
      "orderDisplayId": "#N50867",
      "requestType": "REFUND",
      "subject": "Full Refund Request for Order #N50867",
      "reason": "Items arrived damaged",
      "items": [
        {
          "orderItemId": "clitem123...",
          "productId": "clprod...",
          "title": "Wireless Headphones",
          "image": "https://res.cloudinary.com/.../image.jpg",
          "quantity": 2,
          "price": "49.99",
          "reason": "Items arrived damaged",
          "attachments": []
        }
      ],
      "attachments": [],
      "status": "OPEN",
      "adminMessage": null,
      "createdAt": "2025-04-08T12:00:00.000Z",
      "updatedAt": "2025-04-08T12:00:00.000Z"
    }
  ]
}
```

---

## Step 4 — Get Single Refund Request

**`GET /api/orders/guest/refund-requests/:requestId?orderId=N50867&customerEmail=jane@example.com`**

### Path Parameter

| Param | Description |
|---|---|
| `requestId` | The `id` returned when the refund request was created |

### Query Parameters

Same as Step 3 — `orderId` and `customerEmail` are required for identity verification.

### Success Response `200`

```json
{
  "success": true,
  "request": {
    "id": "clticket...",
    "orderId": "clx9...",
    "orderDisplayId": "#N50867",
    "requestType": "REFUND",
    "subject": "Full Refund Request for Order #N50867",
    "reason": "Items arrived damaged",
    "items": [ ... ],
    "attachments": [],
    "status": "APPROVED",
    "adminMessage": "Your refund has been approved. Please allow 5-6 business days.",
    "createdAt": "2025-04-08T12:00:00.000Z",
    "updatedAt": "2025-04-09T09:00:00.000Z"
  }
}
```

---

## Status Values

The `status` field uses display-friendly values:

| Status | Meaning |
|---|---|
| `OPEN` | Request received, pending admin review |
| `APPROVED` | Admin has approved the refund — processing in 5–6 business days |
| `COMPLETED` | Refund has been processed |
| `REJECTED` | Request was rejected (see `adminMessage` for reason) |

The customer and guest receive an email whenever the status changes. Check `adminMessage` to display any note left by the admin.

---

## Error Reference

| HTTP | Code scenario | Message |
|---|---|---|
| `400` | Missing `orderId` or `customerEmail` | `"orderId and customerEmail are required"` |
| `400` | `items` is not an array | `'"items" must be an array'` |
| `400` | Invalid quantity for an item | `"Invalid quantity X for item '...' (max: Y)"` |
| `400` | Missing reason for an item | `"A reason is required for item '...'"` |
| `400` | Order not in DELIVERED status | `"Refund requests can only be made for delivered orders. Current status: ..."` |
| `400` | Order already refunded/cancelled | `"Cannot request a refund for an order in REFUND status"` |
| `400` | Endpoint called for a registered user's order | `"This endpoint is for guest orders only"` |
| `403` | Email does not match | `"Email does not match order"` |
| `404` | Order not found | `"Order not found"` |
| `404` | Refund request not found | `"Refund request not found"` |
| `429` | Rate limit exceeded | `"Too many requests. Please try again in a minute."` |
| `500` | Server error | `error.message` |

---

## UI Flow

```
1. Order Lookup Page
   ├─ Input: Order ID + Email
   ├─ POST /guest/track-for-refund
   └─ Show eligible items (only DELIVERED)

2. Refund Form
   ├─ Customer selects items + quantities + per-item reasons
   ├─ Optional: upload images (multipart) or paste URLs (JSON)
   ├─ Full refund shortcut: select all items
   └─ POST /guest/refund-request

3. Confirmation Page
   ├─ Show request ID (save for tracking)
   ├─ Status: OPEN
   └─ "You will receive an email when your request is reviewed"

4. Track Page (optional)
   ├─ Input: Order ID + Email (again, no session)
   ├─ GET /guest/refund-requests → list
   ├─ GET /guest/refund-requests/:requestId → detail
   └─ Show status badge + adminMessage if present
```

> **Tip for the frontend:** After submission, save the `request.id` to `localStorage` so the customer can return to the tracking page without re-entering their details.
