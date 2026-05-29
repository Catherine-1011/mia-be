# Seller Coupon — Customer Website Integration Guide

These are the only two endpoints the customer-facing website needs.  
No authentication is required for either call.

---

## Endpoint 1 — Browse active coupons

Use this on a "Offers" or "Deals" page, or to show available coupons for a seller's store page.

```
GET /api/seller-coupons/active
GET /api/seller-coupons/active?sellerId=<sellerId>   // scoped to one seller's store
```

### Response

```json
{
  "success": true,
  "count": 2,
  "coupons": [
    {
      "id": "clyyy456",
      "code": "SUMMER10",
      "sellerId": "clxxx123",
      "couponType": "discount",
      "discountType": "percentage",
      "discountValue": 10,
      "maxDiscount": 20,
      "minQty": 1,
      "bundleQty": null,
      "bundlePrice": null,
      "productIds": [],
      "expiresAt": "2026-08-01T00:00:00.000Z",
      "usagePerUser": 1,
      "seller": { "id": "clxxx123", "name": "Alice Store" }
    },
    {
      "id": "clzzz789",
      "code": "BUY3FOR25",
      "sellerId": "clxxx123",
      "couponType": "bundle",
      "discountType": null,
      "discountValue": null,
      "maxDiscount": null,
      "minQty": 3,
      "bundleQty": 3,
      "bundlePrice": 25.00,
      "productIds": ["prod_ccc"],
      "expiresAt": "2026-07-15T00:00:00.000Z",
      "usagePerUser": 2,
      "seller": { "id": "clxxx123", "name": "Alice Store" }
    }
  ]
}
```

### How to render a coupon card

Read `couponType` first to decide what label to show:

```js
function getCouponLabel(coupon) {
  if (coupon.couponType === 'bundle') {
    return `Buy ${coupon.bundleQty} for $${coupon.bundlePrice.toFixed(2)}`;
  }
  if (coupon.discountType === 'percentage') {
    const cap = coupon.maxDiscount ? ` (up to $${coupon.maxDiscount} off)` : '';
    return `${coupon.discountValue}% off${cap}`;
  }
  // flat
  return `$${coupon.discountValue.toFixed(2)} off`;
}
```

| Field | Display purpose |
|---|---|
| `code` | Show as a copyable badge |
| `couponType` | Drive the label format above |
| `productIds.length === 0` | Show "All products" ; otherwise "Selected products only" |
| `minQty > 1` | Show "Min. qty: N" |
| `expiresAt` | Show "Expires DD MMM YYYY" |
| `usagePerUser` | Show "Up to N uses per customer" |

---

## Endpoint 2 — Apply coupon in cart / checkout

Call this whenever the customer types a coupon code into the cart. It returns a full discount breakdown without placing any order.

```
POST /api/seller-coupons/apply
Content-Type: application/json
```

### Request body

Send the coupon code and **every item currently in the cart**. Include items from all sellers — the API automatically splits qualifying from non-qualifying items.

```json
{
  "code": "SUMMER10",
  "items": [
    { "productId": "prod_aaa", "variantId": "var_111", "quantity": 2 },
    { "productId": "prod_aaa", "variantId": "var_222", "quantity": 1 },
    { "productId": "prod_bbb", "variantId": null,       "quantity": 4 },
    { "productId": "prod_zzz", "variantId": null,       "quantity": 1 }
  ]
}
```

- `variantId` — pass `null` for simple (non-variant) products
- `gstId` — optional; omit it and the system uses the default GST rate automatically

---

### Success response `200`

```json
{
  "success": true,
  "coupon": {
    "id": "clyyy456",
    "code": "SUMMER10",
    "couponType": "discount",
    "discountType": "percentage",
    "discountValue": 10,
    "maxDiscount": 20,
    "bundleQty": null,
    "bundlePrice": null,
    "expiresAt": "2026-08-01T00:00:00.000Z"
  },
  "eligibleSellerId": "clxxx123",
  "qualifyingItems": [
    {
      "productId": "prod_aaa",
      "productTitle": "Handcrafted Mug",
      "totalQty": 3,
      "variants": [
        { "variantId": "var_111", "quantity": 2, "unitPriceIncl": 22.00, "unitPriceExGST": 20.00 },
        { "variantId": "var_222", "quantity": 1, "unitPriceIncl": 22.00, "unitPriceExGST": 20.00 }
      ],
      "regularExGSTSubtotal": 60.00,
      "discountBreakdown": {
        "type": "percentage",
        "discountValue": 10,
        "discountAppliedExGST": 6.00,
        "discountedExGSTSubtotal": 54.00,
        "savingsExGST": 6.00
      }
    }
  ],
  "nonQualifyingItems": [
    { "productId": "prod_zzz", "quantity": 1, "reason": "Not eligible for this coupon" }
  ],
  "summary": {
    "gstRate": 10.00,
    "regularExGSTTotal": 180.00,
    "totalSavingsExGST": 18.00,
    "discountedExGSTTotal": 162.00,
    "gstOnDiscountedAmount": 16.20,
    "discountedInclTotal": 178.20
  }
}
```

---

### Reading the summary block

These six fields are all you need for the cart UI:

| Response field | Cart UI label |
|---|---|
| `summary.regularExGSTTotal` | Subtotal (ex-GST) |
| `summary.totalSavingsExGST` | Coupon savings |
| `summary.discountedExGSTTotal` | Discounted subtotal (ex-GST) |
| `summary.gstOnDiscountedAmount` | GST (applied after discount) |
| `summary.discountedInclTotal` | **Total payable** |

> GST is always calculated **after** the discount is deducted, so the customer never overpays tax.

---

### Bundle offer — what changes in the response

When `couponType = "bundle"` the `discountBreakdown` inside each qualifying item has a different shape:

```json
"discountBreakdown": {
  "type": "bundle",
  "bundleQty": 3,
  "bundlePriceExGST": 25.00,
  "completeBundles": 1,
  "remainingQty": 1,
  "bundleCostExGST": 25.00,
  "remainingCostExGST": 10.00,
  "discountedExGSTSubtotal": 35.00,
  "savingsExGST": 5.00
}
```

The `summary` block is the same shape regardless of coupon type — always use `summary.discountedInclTotal` as the final payable amount.

---

### Error responses

| HTTP status | `message` | What to show the customer |
|---|---|---|
| `404` | `"Invalid coupon code"` | "This coupon code doesn't exist." |
| `400` | `"This coupon has expired"` | "This coupon has expired." |
| `400` | `"This coupon is no longer active"` | "This coupon is no longer available." |
| `400` | `"Coupon usage limit has been reached"` | "This coupon has reached its usage limit." |

If `success: true` but `qualifyingItems` is empty (all items fell into `nonQualifyingItems`), show: **"None of your cart items are eligible for this coupon."**

---

## Complete cart implementation example

```js
async function applyCoupon(code, cartItems) {
  // cartItems shape: [{ productId, variantId, quantity }]
  const res = await fetch('/api/seller-coupons/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, items: cartItems })
  });

  const data = await res.json();

  if (!data.success) {
    // Show data.message as inline error under the coupon input
    return null;
  }

  if (data.qualifyingItems.length === 0) {
    // Show: "None of your cart items are eligible for this coupon."
    return null;
  }

  // All you need from the response to update the cart UI:
  return {
    code:              data.coupon.code,
    couponType:        data.coupon.couponType,
    eligibleSellerId:  data.eligibleSellerId,
    savings:           data.summary.totalSavingsExGST,
    gst:               data.summary.gstOnDiscountedAmount,
    total:             data.summary.discountedInclTotal,
    nonQualifying:     data.nonQualifyingItems    // items not covered by this coupon
  };
}
```

### Cart price breakdown UI (what to render)

```
Subtotal (ex-GST)              $180.00
Coupon SUMMER10               −$18.00
Discounted subtotal (ex-GST)  $162.00
GST (10%)                      $16.20
─────────────────────────────────────
Total payable                 $178.20
```

If the cart has non-qualifying items, add their full-price totals **before** the grand total line and note which seller's coupon was applied.

---

## Important notes

1. **`productIds: []` means all products** from that seller qualify — you don't need to filter on the frontend before calling apply.
2. **Different variants of the same product count together** toward `minQty` and bundle thresholds — you don't need to aggregate them yourself.
3. The apply endpoint is **read-only** — it never modifies the order or decrements the usage count. That happens on the backend when the order is placed.
4. A coupon is **seller-scoped** — it will never affect products from a different seller in the same cart. Products from other sellers are returned in `nonQualifyingItems` and should be charged at their full price.
