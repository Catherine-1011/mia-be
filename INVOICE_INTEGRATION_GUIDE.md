# Invoice Download — Dashboard Integration Guide

> **Audience:** Frontend / Dashboard developers  
> **Backend base URL:** `https://alpa-be.onrender.com` (or your env's `BACKEND_URL`)

---

## Key concept: always use `displayId`, never the internal CUID

Every order has two IDs:

| Field | Example | Use |
|---|---|---|
| `id` | `cljx8k2...` (26 chars) | Internal DB key — **never shown to users** |
| `displayId` | `A4X9KR` (6 chars) | Customer-facing reference — **always use this** |

All three invoice endpoints accept **only `displayId`** as the order identifier. Passing an internal CUID will return `404`.

---

## Endpoints

### 1. Authenticated Invoice (Seller Dashboard / Admin Dashboard)

```
GET /api/orders/invoice/:orderId
Authorization: Bearer <jwt_token>
```

- `:orderId` = `order.displayId` (e.g. `A4X9KR`)
- Roles allowed: `USER`, `SELLER`, `ADMIN`, `SUPER_ADMIN`
- Access rules:
  - `USER` — can only download their own orders
  - `SELLER` — can only download orders that contain their products
  - `ADMIN` / `SUPER_ADMIN` — can download any order
- Returns: `application/pdf` binary stream (Content-Disposition: attachment)

**Example (Seller Dashboard):**
```js
// order.displayId comes from your orders list API response
const response = await fetch(
  `${BACKEND_URL}/api/orders/invoice/${order.displayId}`,
  { headers: { Authorization: `Bearer ${sellerToken}` } }
);
const blob = await response.blob();
const url = URL.createObjectURL(blob);
// trigger download
const a = document.createElement('a');
a.href = url;
a.download = `invoice-${order.displayId}.pdf`;
a.click();
```

**Example (Admin Dashboard):**
```js
const response = await fetch(
  `${BACKEND_URL}/api/orders/invoice/${order.displayId}`,
  { headers: { Authorization: `Bearer ${adminToken}` } }
);
```

---

### 2. Sub-Order Invoice (Seller Dashboard — multi-vendor orders)

```
GET /api/orders/invoice/sub/:subOrderId
Authorization: Bearer <jwt_token>
```

- `:subOrderId` = `subOrder.subDisplayId` **without** the `#` prefix — e.g. `A4X9KR-A`
- Roles allowed: `SELLER`, `ADMIN`, `SUPER_ADMIN`
- Access rules:
  - `SELLER` — can only download their **own** sub-orders (`subOrder.sellerId === userId`)
  - `ADMIN` / `SUPER_ADMIN` — can download any sub-order
- The PDF contains **only that seller's items, their subtotal, and the sub-order status** — no other sellers' sections, no parent grand total
- Invoice `#` shown on the PDF = `subDisplayId` (e.g. `#A4X9KR-A`)

#### `subDisplayId` format

```
{parentOrder.displayId}-{seller suffix}
```

| Parent `displayId` | First seller | Second seller | Third seller |
|---|---|---|---|
| `A4X9KR` | `A4X9KR-A` | `A4X9KR-B` | `A4X9KR-C` |

The suffix is assigned alphabetically in the order the sellers were added at checkout (A = first, B = second, etc.).

`subDisplayId` is returned in the orders list API response on every `subOrders[]` item:

```json
{
  "id": "cljx8k2abc...",
  "displayId": "A4X9KR",
  "subOrders": [
    {
      "id": "cljx9m3def...",
      "subDisplayId": "A4X9KR-A",
      "sellerId": "...",
      "status": "CONFIRMED",
      "subtotal": 79.99
    },
    {
      "id": "cljx9m3ghi...",
      "subDisplayId": "A4X9KR-B",
      "sellerId": "...",
      "status": "SHIPPED",
      "subtotal": 69.99
    }
  ]
}
```

**Example (Seller Dashboard — sub-order invoice):**
```js
// subOrder.subDisplayId comes from the parent order's subOrders[] array
const response = await fetch(
  `${BACKEND_URL}/api/orders/invoice/sub/${subOrder.subDisplayId}`,
  { headers: { Authorization: `Bearer ${sellerToken}` } }
);
const blob = await response.blob();
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = `invoice-${subOrder.subDisplayId}.pdf`;
a.click();
```

---

### 3. Full Parent Invoice (Admin Dashboard — all sellers in one PDF)

Same as endpoint #1 — pass the parent `displayId`. The PDF will render one section per seller with a grand total.

---

### 4. Public Invoice (Email links — no auth required)

```
GET /api/orders/invoice/public/:orderId
```

- `:orderId` = `order.displayId`
- No `Authorization` header needed — designed for links embedded in confirmation emails
- This endpoint is called when a logged-in customer clicks "Download Invoice" in their email

---

### 5. Guest Invoice (Guest orders — email-verified)

```
GET /api/orders/guest/invoice?orderId=<displayId>&customerEmail=<email>
```

- Both query params are required
- Email must match the email recorded on the order (verification layer)
- Used for guest order confirmation emails

---

## Order Types and which endpoint to call

| Order type | How to detect | Endpoint to call |
|---|---|---|
| **Direct order** (single seller) | `subOrders` array is empty or absent | `GET /invoice/:displayId` |
| **Multi-vendor order — full PDF** (admin) | `subOrders.length > 0` | `GET /invoice/:displayId` (all sellers) |
| **Multi-vendor order — seller slice** | `subOrders.length > 0` and you are a seller | `GET /invoice/sub/:subDisplayId` |

### Direct Order
- Items belong directly to the `Order` record
- Invoice shows a single flat table of items

### Multi-Vendor Order
- Items are split across child `SubOrder` records (one per seller)
- Invoice shows one section per seller with a per-seller subtotal, then a grand total
- You still pass the **parent order's `displayId`** to the invoice endpoint — the backend renders all sellers automatically

---

## What the Invoice PDF contains

| Field | Source |
|---|---|
| **Invoice #** | `order.displayId` (e.g. `#A4X9KR`) |
| Date | `order.createdAt` |
| Status | `order.status` / `order.overallStatus` |
| Bill To | customer name, email, phone |
| Ship To | shipping address fields |
| Items | product title, qty, unit price, line total |
| Coupon discount | shown only when `discountAmount > 0` |
| Subtotal / Total | calculated from items; Grand Total from `order.totalAmount` |
| Payment Method | `order.paymentMethod` |

For multi-vendor orders, each seller section also shows:
- Seller name
- Sub-order status
- Seller subtotal

---

## Invoice availability by order status

The invoice endpoint will return `400` if the order status is not one of:

```
CONFIRMED | PROCESSING | PACKED | SHIPPED | DELIVERED
```

Orders in `PENDING`, `CANCELLED`, `REFUND`, `PARTIAL_REFUND` etc. will not generate a PDF. Your UI should hide or disable the download button for these statuses.

---

## How to get `displayId` from the API

All order list and detail endpoints return `displayId` in the response. Example response shape:

```json
{
  "id": "cljx8k2abc....",
  "displayId": "A4X9KR",
  "status": "CONFIRMED",
  "overallStatus": "CONFIRMED",
  "totalAmount": 149.99,
  ...
}
```

Always read `displayId` when constructing the invoice URL, **not** `id`.

---

## Order Confirmation Email

When an order is placed, the customer automatically receives a confirmation email containing:
- Order `displayId` in the subject line and body
- "Track Order" button → customer dashboard / guest tracking URL
- "Download Invoice" button → calls one of the two endpoints above (public or guest) using `displayId`
- Matching PDF attached to the email (if generated)

No action is required from the dashboard for this — it is fully automated by the backend at order creation and payment confirmation time.

---

## Common mistakes to avoid

| Wrong | Right |
|---|---|
| `/api/orders/invoice/cljx8k2abc...` (CUID) | `/api/orders/invoice/A4X9KR` (displayId) |
| `/api/orders/invoice/sub/cljx9m3def...` (SubOrder CUID) | `/api/orders/invoice/sub/A4X9KR-A` (subDisplayId) |
| Passing `order.id` | Passing `order.displayId` |
| Passing `subOrder.id` | Passing `subOrder.subDisplayId` |
| Calling full-parent invoice for a seller's sub-order | Use `/invoice/sub/:subDisplayId` for seller-specific downloads |
| Calling the endpoint for `PENDING` / `CANCELLED` orders | Check status first, hide button if not invocable |
| Omitting `Authorization` header for seller/admin routes | Always include `Bearer <token>` |

---

## Error responses

| Status | Meaning |
|---|---|
| `400` | Invoice not available for this order status |
| `403` | Authenticated user does not have permission to access this order |
| `404` | Order not found (likely passed CUID instead of displayId, or order doesn't exist) |
| `500` | Server error — check backend logs |
