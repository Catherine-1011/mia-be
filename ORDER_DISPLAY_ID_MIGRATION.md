# Order Display ID — API Migration Guide

**Date:** March 19, 2026  
**Affects:** Web App (customer-facing) · Dashboard (internal)

---

## What Changed and Why

Previously, every order had a long internal ID (CUID) that looked like this:

```
cmmn0cgd40008yoct3seytfz5
```

Customers were being exposed to this ugly, hard-to-remember string when tracking or managing orders.

We have now introduced a short **6-character alphanumeric `displayId`** that is shown to customers instead:

```
A4X9KR
```

The internal CUID still exists in the database but is **never exposed to customers** anymore. The `displayId` is what customers see in emails, order confirmation pages, and use to track/manage their orders.

---

## Existing Orders

Existing orders already had a numeric `displayId` (e.g. `1`, `2`, `3`). Those values have been **converted to strings** — so they will appear as `"1"`, `"2"`, `"3"` in the API. No data was lost.

All **new orders** will now get a random 6-character alphanumeric `displayId` like `"A4X9KR"`.

---

## Changes by Team

---

## Web App Dev Team (Customer-Facing)

### 1. Store `displayId` from Order Creation Response

When an order is placed (POST `/api/orders/create` or POST `/api/orders/guest/create`), the response now includes `displayId`. **You must store and display this to the customer** — this is what they will use for all future tracking.

**New response fields:**
```json
{
  "success": true,
  "orderId": "cmmn0cgd40008yoct3seytfz5",   // internal — not for display
  "displayId": "A4X9KR",                      // ← NEW — show this to customer
  ...
}
```

> Store `displayId` in your order confirmation page and send it in any confirmation UI. The customer must have this to track or manage their order.

---

### 2. All Customer-Facing Endpoints Now Use `displayId`

Every endpoint that previously needed the long CUID now accepts the short `displayId` instead.

#### Authenticated User Endpoints

| Endpoint | Old ID used | New ID to use |
|---|---|---|
| `PUT /api/orders/cancel/:id` | CUID | `displayId` |
| `POST /api/orders/refund-request/:id` | CUID | `displayId` |
| `POST /api/orders/reorder/:id` | CUID | `displayId` |
| `GET /api/orders/invoice/:orderId` | CUID | `displayId` |

**Before:**
```
PUT /api/orders/cancel/cmmn0cgd40008yoct3seytfz5
```

**After:**
```
PUT /api/orders/cancel/A4X9KR
```

---

#### Guest Endpoints

| Endpoint | Old query/body param | New value to send |
|---|---|---|
| `GET /api/orders/guest/track?orderId=` | CUID | `displayId` |
| `GET /api/orders/guest/invoice?orderId=` | CUID | `displayId` |
| `POST /api/orders/guest/refund-request` (body `orderId`) | CUID | `displayId` |
| `GET /api/orders/guest/refund-requests?orderId=` | CUID | `displayId` |
| `GET /api/orders/guest/refund-requests/:requestId?orderId=` | CUID | `displayId` |

**Before:**
```
GET /api/orders/guest/track?orderId=cmmn0cgd40008yoct3seytfz5&customerEmail=...
```

**After:**
```
GET /api/orders/guest/track?orderId=A4X9KR&customerEmail=...
```

---

### 3. `GET /api/orders/my-orders` — New `displayId` Field

The order list response now includes `displayId` on every order object.

```json
{
  "success": true,
  "orders": [
    {
      "id": "cmmn0cgd40008yoct3seytfz5",    // internal — do not display
      "displayId": "A4X9KR",                 // ← NEW — show this to customers
      "totalAmount": "59.99",
      "status": "CONFIRMED",
      ...
    }
  ]
}
```

Use `displayId` wherever you display an order reference to a customer (order history, order detail pages, emails, etc.).

---

### 4. Invoice — Public Link (No Change Needed)

```
GET /api/orders/invoice/public/:orderId
```

This endpoint is used in **emailed invoice links only** and still uses the internal CUID. This is intentional — the CUID acts as a security token since the link has no authentication. **Do not change how you generate these links.**

---

## Dashboard Dev Team

### What Does NOT Change for You

All seller and admin endpoints are **unchanged**. They still use the internal CUID. Examples:

- `PUT /api/seller-orders/update-status/:subOrderId` — still CUID
- `GET /api/admin/orders` — CUIDs still returned as `id`
- All other admin/seller endpoints — no changes

### What You Should Display

In the dashboard (order management tables, order detail pages), you should now **show `displayId` alongside or instead of the truncated CUID** so that when a customer contacts support with their short ID (e.g. `A4X9KR`), your team can easily identify the order.

Both `id` (CUID) and `displayId` are returned in order responses. Show `displayId` as the human-readable order reference.

**Example order object from the API:**
```json
{
  "id": "cmmn0cgd40008yoct3seytfz5",   // use this for internal API calls
  "displayId": "A4X9KR",                // show this in UI as "Order #A4X9KR"
  ...
}
```

---

## Quick Reference — Before vs After

### Authenticated Customer

```js
// BEFORE
const orderId = order.id; // "cmmn0cgd40008yoct3seytfz5"
await fetch(`/api/orders/cancel/${orderId}`, { method: 'PUT', ... });

// AFTER
const displayId = order.displayId; // "A4X9KR"
await fetch(`/api/orders/cancel/${displayId}`, { method: 'PUT', ... });
```

### Guest Customer

```js
// BEFORE
await fetch(`/api/orders/guest/track?orderId=${order.id}&customerEmail=${email}`);

// AFTER
await fetch(`/api/orders/guest/track?orderId=${order.displayId}&customerEmail=${email}`);
```

### Displaying Order Reference

```js
// BEFORE
<p>Order ID: {order.id.slice(-8).toUpperCase()}</p>  // hacky truncation

// AFTER
<p>Order #: {order.displayId}</p>  // clean, consistent, meaningful
```

---

## Summary Checklist

### Web App Dev
- [ ] After `POST /api/orders/create` — save and display `displayId` from response
- [ ] After `POST /api/orders/guest/create` — save and display `displayId` from response
- [ ] Order confirmation page — show `displayId` as the order reference
- [ ] Order history page (`GET /api/orders/my-orders`) — use `displayId` for display
- [ ] Cancel order — change URL param from CUID to `displayId`
- [ ] Refund request — change URL param from CUID to `displayId`
- [ ] Reorder — change URL param from CUID to `displayId`
- [ ] Invoice download (authenticated) — change URL param from CUID to `displayId`
- [ ] Guest order tracking — change `orderId` query param to `displayId`
- [ ] Guest invoice download — change `orderId` query param to `displayId`
- [ ] Guest refund request — change `orderId` body field to `displayId`
- [ ] Guest refund tracking — change `orderId` query param to `displayId`
- [ ] **Do NOT change** the public invoice link (`/invoice/public/:orderId`) — still uses CUID

### Dashboard Dev
- [ ] Display `displayId` as the order reference in all order tables/detail views
- [ ] Use `displayId` as the visible "Order #" that support staff can match to customer queries
- [ ] No API call changes needed — all dashboard/seller/admin endpoints still use CUID internally
