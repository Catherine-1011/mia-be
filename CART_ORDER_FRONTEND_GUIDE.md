# Cart & Order Frontend Integration Guide
## Supporting SIMPLE and VARIABLE Products

---

## Overview of Changes

The backend now supports two product types:
- **SIMPLE** — single price/stock, no variants (add `productId` only)
- **VARIABLE** — multiple variants (size × color combos), each with its own price/stock (must add `variantId` too)

---

## 1. Add to Cart

### `POST /api/cart/add`
**Headers:** `Authorization: Bearer <token>`

#### SIMPLE product
```json
{
  "productId": "cmobdf5km0001ft7p...",
  "quantity": 1
}
```

#### VARIABLE product (size + color variant)
```json
{
  "productId": "cmobdf5km0001ft7p...",
  "variantId": "cmobeajkl0003ft7p...",
  "quantity": 1
}
```

> ⚠️ For VARIABLE products, **`variantId` is required**. Without it you'll get:
> `400: "variantId is required for VARIABLE products"`

#### How to get the variantId on the frontend
When the user selects a size + color combination on the product detail page, call:
```
GET /api/products/:productId/variants
```
Match the selected attributes to the returned `variants` array — each variant has an `attributes` object like:
```json
{
  "id": "cmobeajkl0003ft7p...",
  "price": 495,
  "stock": 20,
  "attributes": {
    "size": { "value": "S", "displayValue": "S" },
    "color": { "value": "red", "displayValue": "Red", "hexColor": "#FF0000" }
  }
}
```
Use the matching variant's `id` as `variantId`.

---

## 2. View Cart

### `GET /api/cart/my-cart`
**Headers:** `Authorization: Bearer <token>`

**Optional query params:** `?shippingMethodId=xxx&gstId=xxx`

#### Response shape (each cart item):
```json
{
  "productId": "...",
  "variantId": "...",          // null for SIMPLE products
  "quantity": 2,
  "product": {
    "id": "...",
    "title": "Men's Shirt",
    "type": "VARIABLE",
    "featuredImage": "https://...",
    "sellerId": "..."
  },
  "variant": {                 // null for SIMPLE products
    "id": "...",
    "price": 495.00,
    "stock": 18,
    "sku": "SHIRT-S-RED",
    "images": [],
    "attributes": {
      "size":  { "value": "S",   "displayValue": "S",   "hexColor": null },
      "color": { "value": "red", "displayValue": "Red", "hexColor": "#FF0000" }
    }
  },
  "effectivePrice": 495.00     // use this for display — variant price for VARIABLE, product price for SIMPLE
}
```

#### Display logic
```js
// Price to show in cart
const displayPrice = item.effectivePrice;

// Variant label (e.g., "Size: S / Color: Red")
const variantLabel = item.variant
  ? Object.entries(item.variant.attributes)
      .map(([k, v]) => `${k}: ${v.displayValue}`)
      .join(' / ')
  : null;
```

---

## 3. Update Cart Quantity

### `PUT /api/cart/update`
**Headers:** `Authorization: Bearer <token>`

```json
{
  "productId": "...",
  "variantId": "...",   // required if item is VARIABLE; omit or null for SIMPLE
  "quantity": 3
}
```

---

## 4. Remove from Cart

### `DELETE /api/cart/remove/:productId`
**Headers:** `Authorization: Bearer <token>`

- **SIMPLE product:** `DELETE /api/cart/remove/PRODUCT_ID`
- **VARIABLE product:** `DELETE /api/cart/remove/PRODUCT_ID?variantId=VARIANT_ID`

> Without `?variantId`, the backend only removes SIMPLE items (or all items for that product). Always pass `variantId` for VARIABLE products.

---

## 5. Place Order

### `POST /api/orders/create`
**Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`

The cart is read server-side — you do **not** pass cart items in the body. Just pass checkout details:

```json
{
  "shippingAddress": {
    "addressLine": "123 Main Street",
    "city": "Mumbai",
    "state": "Maharashtra",
    "zipCode": "400001",
    "country": "India"
  },
  "city": "Mumbai",
  "state": "Maharashtra",
  "zipCode": "400001",
  "country": "India",
  "mobileNumber": "9876543210",
  "paymentMethod": "STRIPE",
  "shippingMethodId": "shipping-method-id-here",
  "gstId": "gst-id-here",
  "couponCode": "SAVE10"
}
```

**Required fields:** `shippingAddress`, `paymentMethod`, `shippingMethodId`  
**Optional:** `gstId`, `couponCode`, `city`, `state`, `zipCode`, `country`, `mobileNumber`

**Payment method:** Only `"STRIPE"` is accepted.

#### Response (single seller):
```json
{
  "success": true,
  "order": {
    "id": "...",
    "displayId": "AB12CD",
    "totalAmount": 990.00,
    "overallStatus": "CONFIRMED",
    "paymentStatus": "PENDING"
  }
}
```

#### Response (multi-seller):
```json
{
  "success": true,
  "order": {
    "id": "...",
    "displayId": "AB12CD",
    "subOrders": [
      { "id": "...", "subDisplayId": "AB12CD-A", "sellerId": "..." },
      { "id": "...", "subDisplayId": "AB12CD-B", "sellerId": "..." }
    ]
  }
}
```

---

## 6. Checkout Flow (Step by Step)

```
1. Product Detail Page
   └─ GET /api/products/:id/variants   → get all variants with attributes
   └─ User picks size + color → store selected variantId in state

2. Add to Cart
   └─ POST /api/cart/add  { productId, variantId, quantity }

3. Cart Page
   └─ GET /api/cart/my-cart            → get items with effectivePrice + variant.attributes
   └─ GET /api/cart/checkout-options   → get shipping methods + GST options

4. Checkout Page
   └─ User fills address + selects shipping method
   └─ Optionally apply coupon
   └─ GET /api/cart/my-cart?shippingMethodId=xxx  → show updated grand total

5. Place Order
   └─ POST /api/orders/create  { shippingAddress, paymentMethod, shippingMethodId, ... }
   └─ Redirect to payment (Stripe) with returned order.id
```

---

## 7. Variant Stock / Availability Check

Before letting the user add to cart or showing "Add to Cart" button:

```
GET /api/products/:productId/variants
```

Check `variant.stock > 0 && variant.isActive` for each combination.  
Disable the "Add to Cart" button if the selected variant has `stock === 0`.

---

## 8. Common Errors Reference

| Error | Cause | Fix |
|---|---|---|
| `variantId is required for VARIABLE products` | Missing variantId on VARIABLE add-to-cart | Always pass `variantId` for VARIABLE products |
| `Variant not found for this product` | Wrong variantId / productId mismatch | Re-fetch variants from `/api/products/:id/variants` |
| `This variant is currently unavailable` | `variant.isActive = false` | Don't show that variant as selectable |
| `Cannot add more than available stock (N)` | Requested qty > variant stock | Cap qty input to `variant.stock` |
| `Insufficient stock for product: X` | Stock ran out between cart add and order | Refresh cart and show stock warning |
| `Invalid or inactive shipping method` | shippingMethodId not found | Fetch fresh from `/api/cart/checkout-options` |
