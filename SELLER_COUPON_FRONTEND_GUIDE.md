# Seller Coupon System — Frontend Dashboard Guide

**Base URL:** `https://<your-api>/api/seller-coupons`  
**Auth header:** `Authorization: Bearer <token>`

Roles that carry seller-coupon access:

| Role | What they can do |
|---|---|
| `SELLER` | Manage their own coupons only |
| `ADMIN` / `SUPER_ADMIN` | Manage any seller's coupons; must supply `sellerId` on create |

---

## Coupon data model

```ts
interface SellerCoupon {
  id:           string;
  code:         string;             // always uppercase
  sellerId:     string;
  couponType:   "discount" | "bundle";

  // --- discount type fields (null when couponType = "bundle") ---
  discountType:  "percentage" | "flat" | null;
  discountValue: number | null;
  maxDiscount:   number | null;     // caps a % discount (ex-GST $)

  // --- bundle type fields (null when couponType = "discount") ---
  bundleQty:    number | null;      // buy N units...
  bundlePrice:  number | null;      // ...for this ex-GST fixed price

  // --- shared ---
  minQty:       number;             // minimum qualifying qty per product (default 1)
  productIds:   string[];           // [] = applies to all seller products
  expiresAt:    string;             // ISO 8601
  usageLimit:   number | null;      // null = unlimited
  usagePerUser: number;             // default 1
  usageCount:   number;             // total times redeemed
  isActive:     boolean;
  createdBy:    string;
  createdAt:    string;
  updatedAt:    string;
  softDeletedAt: string | null;
  softDeletedBy: string | null;
  restoredAt:   string | null;
  restoredBy:   string | null;

  // joined
  seller?: { id: string; name: string; email: string };
}
```

---

## 1. Create a coupon

**`POST /api/seller-coupons`**  
Auth required: `SELLER` | `ADMIN` | `SUPER_ADMIN`

### Seller creates for their own store

```json
{
  "code": "SUMMER10",
  "couponType": "discount",
  "discountType": "percentage",
  "discountValue": 10,
  "maxDiscount": 20,
  "minQty": 1,
  "productIds": [],
  "expiresAt": "2026-08-01T00:00:00.000Z",
  "usageLimit": 100,
  "usagePerUser": 1,
  "isActive": true
}
```

### Admin creates on behalf of a seller

Same body, plus the required `sellerId` field:

```json
{
  "sellerId": "clxxx123",
  "code": "FLASH50",
  "couponType": "discount",
  "discountType": "flat",
  "discountValue": 5,
  "productIds": ["prod_aaa", "prod_bbb"],
  "expiresAt": "2026-06-30T23:59:59.000Z",
  "usageLimit": 50,
  "usagePerUser": 1,
  "isActive": true
}
```

### Bundle offer example

```json
{
  "code": "BUY3FOR25",
  "couponType": "bundle",
  "bundleQty": 3,
  "bundlePrice": 25.00,
  "minQty": 3,
  "productIds": ["prod_ccc"],
  "expiresAt": "2026-07-15T00:00:00.000Z",
  "usageLimit": null,
  "usagePerUser": 2,
  "isActive": true
}
```

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | ✅ | Auto-uppercased; must be globally unique |
| `couponType` | `"discount"` \| `"bundle"` | ✅ | Drives which other fields are used |
| `discountType` | `"percentage"` \| `"flat"` | When `couponType=discount` | |
| `discountValue` | number | When `couponType=discount` | % must be 1–100 |
| `maxDiscount` | number | ❌ | Caps percentage savings (ex-GST $). Only for `percentage` type |
| `bundleQty` | integer ≥ 2 | When `couponType=bundle` | Units per bundle |
| `bundlePrice` | number > 0 | When `couponType=bundle` | Ex-GST fixed price for one complete bundle |
| `minQty` | integer | ❌ default `1` | Min quantity of a product before coupon applies |
| `productIds` | string[] | ❌ default `[]` | Empty array = all seller products qualify |
| `expiresAt` | ISO string | ✅ | Must be a future date |
| `usageLimit` | integer \| `null` | ❌ | `null` = unlimited |
| `usagePerUser` | integer | ❌ default `1` | |
| `isActive` | boolean | ❌ default `true` | |
| `sellerId` | string | Admin only ✅ | The seller to create the coupon for |

### Success response `201`

```json
{
  "success": true,
  "message": "Seller coupon created successfully",
  "coupon": { /* SellerCoupon object */ }
}
```

### Error responses

| Status | Message |
|---|---|
| 400 | `"Coupon code already exists"` |
| 400 | `"sellerId is required when an admin creates a seller coupon"` |
| 400 | `"discountValue is required for discount coupons"` |
| 400 | `"bundleQty must be at least 2"` |
| 400 | `"One or more productIds are invalid or do not belong to this seller"` |
| 404 | `"Seller not found"` (admin only) |

---

## 2. Fetch coupon list

**`GET /api/seller-coupons`**  
Auth required: `SELLER` | `ADMIN` | `SUPER_ADMIN`

| Query param | Type | Notes |
|---|---|---|
| `recycleBin` | `"true"` | Return soft-deleted coupons instead of active list |
| `sellerId` | string | Admin only — filter by seller |

### Seller view (no extra params needed)
```
GET /api/seller-coupons
Authorization: Bearer <seller-token>
```

### Admin view — all coupons
```
GET /api/seller-coupons
Authorization: Bearer <admin-token>
```

### Admin view — by seller
```
GET /api/seller-coupons?sellerId=clxxx123
Authorization: Bearer <admin-token>
```

### Recycle bin
```
GET /api/seller-coupons?recycleBin=true
Authorization: Bearer <seller-or-admin-token>
```

### Success response `200`

```json
{
  "success": true,
  "count": 3,
  "recycleBin": false,
  "coupons": [
    {
      "id": "clyyy456",
      "code": "SUMMER10",
      "couponType": "discount",
      "discountType": "percentage",
      "discountValue": 10,
      "maxDiscount": 20,
      "minQty": 1,
      "bundleQty": null,
      "bundlePrice": null,
      "productIds": [],
      "expiresAt": "2026-08-01T00:00:00.000Z",
      "usageLimit": 100,
      "usagePerUser": 1,
      "usageCount": 12,
      "isActive": true,
      "createdAt": "2026-05-01T10:00:00.000Z",
      "softDeletedAt": null,
      "seller": { "id": "clxxx123", "name": "Alice Store", "email": "alice@shop.com" }
    }
  ]
}
```

---

## 3. Fetch single coupon

**`GET /api/seller-coupons/:id`**  
Auth required: `SELLER` | `ADMIN` | `SUPER_ADMIN`

```
GET /api/seller-coupons/clyyy456
Authorization: Bearer <token>
```

### Success response `200`

```json
{
  "success": true,
  "coupon": { /* full SellerCoupon object including seller */ }
}
```

---

## 4. Update a coupon

**`PUT /api/seller-coupons/:id`**  
Auth required: `SELLER` (own) | `ADMIN` | `SUPER_ADMIN`

All fields are optional. Only include what you want to change.

```json
{
  "discountValue": 15,
  "maxDiscount": 30,
  "expiresAt": "2026-09-01T00:00:00.000Z",
  "isActive": false
}
```

Switching `couponType` from `"discount"` to `"bundle"` automatically nullifies `discountType`, `discountValue`, and `maxDiscount`, and vice versa.

### Success response `200`

```json
{
  "success": true,
  "message": "Coupon updated successfully",
  "coupon": { /* updated SellerCoupon object */ }
}
```

### Error responses

| Status | Message |
|---|---|
| 400 | `"Cannot edit a soft-deleted coupon. Restore it first."` |
| 403 | `"Access denied"` (seller tried to edit another seller's coupon) |
| 404 | `"Coupon not found"` |

---

## 5. Soft delete (move to recycle bin)

**`DELETE /api/seller-coupons/:id`**  
Auth required: `SELLER` (own) | `ADMIN` | `SUPER_ADMIN`

```json
{ "reason": "Promotion ended early" }
```
`reason` is optional.

### Success response `200`

```json
{
  "success": true,
  "message": "Coupon \"SUMMER10\" moved to recycle bin",
  "data": {
    "id": "clyyy456",
    "code": "SUMMER10",
    "softDeletedAt": "2026-05-01T12:00:00.000Z"
  }
}
```

---

## 6. Restore from recycle bin

**`PATCH /api/seller-coupons/:id/restore`**  
Auth required: `SELLER` (own) | `ADMIN` | `SUPER_ADMIN`

No body needed.

### Success response `200`

```json
{
  "success": true,
  "message": "Coupon \"SUMMER10\" has been restored",
  "coupon": { /* SellerCoupon object with softDeletedAt: null */ }
}
```

---

## 7. Permanent delete (hard delete)

**`DELETE /api/seller-coupons/:id/permanent`**  
Auth required: `SELLER` (own) | `ADMIN` | `SUPER_ADMIN`

> ⚠ The coupon **must be in the recycle bin** (`softDeletedAt` is set) before this succeeds.

```json
{ "reason": "Data cleanup" }
```

### Success response `200`

```json
{
  "success": true,
  "message": "Coupon \"SUMMER10\" has been permanently deleted. Audit logs are retained.",
  "data": { "id": "clyyy456", "code": "SUMMER10" }
}
```

---

## 8. Browse active coupons (public — no auth)

**`GET /api/seller-coupons/active`**

| Query param | Notes |
|---|---|
| `sellerId` | Filter by seller (optional) |

### Success response `200`

```json
{
  "success": true,
  "count": 2,
  "coupons": [
    {
      "id": "clyyy456",
      "code": "SUMMER10",
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
    }
  ]
}
```

---

## 9. Apply coupon — discount preview (public — no auth)

**`POST /api/seller-coupons/apply`**

This is the core endpoint that the cart/checkout page calls to preview what the customer will pay after applying a coupon.

### Request body

```json
{
  "code": "SUMMER10",
  "gstId": "optional-gst-record-id",
  "items": [
    { "productId": "prod_aaa", "variantId": "var_111", "quantity": 2 },
    { "productId": "prod_aaa", "variantId": "var_222", "quantity": 1 },
    { "productId": "prod_bbb", "variantId": null,       "quantity": 4 },
    { "productId": "prod_zzz", "variantId": null,       "quantity": 1 }
  ]
}
```

`gstId` is optional — the system falls back to the default active GST rate automatically.

### How items are grouped

Items from the same product (e.g. different color/size variants) are **aggregated together** for quantity and bundle threshold checks. `prod_zzz` above belongs to a different seller, so it gets no discount and is listed under `nonQualifyingItems`.

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
    },
    {
      "productId": "prod_bbb",
      "productTitle": "Ceramic Bowl",
      "totalQty": 4,
      "variants": [
        { "variantId": null, "quantity": 4, "unitPriceIncl": 33.00, "unitPriceExGST": 30.00 }
      ],
      "regularExGSTSubtotal": 120.00,
      "discountBreakdown": {
        "type": "percentage",
        "discountValue": 10,
        "discountAppliedExGST": 12.00,
        "discountedExGSTSubtotal": 108.00,
        "savingsExGST": 12.00
      }
    }
  ],
  "nonQualifyingItems": [
    {
      "productId": "prod_zzz",
      "quantity": 1,
      "reason": "Not eligible for this coupon"
    }
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

### Bundle offer response example

When `couponType = "bundle"` (e.g. buy 3 for $25), the `discountBreakdown` shape changes:

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

### Error responses for apply

| Status | Message |
|---|---|
| 400 | `"Coupon code is required"` |
| 400 | `"items array is required and must not be empty"` |
| 400 | `"This coupon is no longer active"` |
| 400 | `"This coupon has expired"` |
| 400 | `"Coupon usage limit has been reached"` |
| 404 | `"Invalid coupon code"` |

---

## Dashboard UI implementation notes

### Seller dashboard — Coupon management page

**Initial load**
1. `GET /api/seller-coupons` — fetch coupon list and display in a table.
2. Show `code`, `couponType`, `discountType/Value` or `bundleQty/bundlePrice`, `expiresAt`, `usageCount / usageLimit`, `isActive` status badge.

**Create coupon flow**
1. Show a form with a `couponType` toggle: **Discount** / **Bundle**.
2. When `Discount` is selected render: `discountType` radio (percentage / flat), `discountValue`, optional `maxDiscount`.
3. When `Bundle` is selected render: `bundleQty`, `bundlePrice` (label it "Fixed price for bundle (ex-GST)").
4. Common fields: `code`, `minQty`, `productIds` multi-select (load seller's products from `/api/products?sellerId=me`), `expiresAt` date-picker, `usageLimit`, `usagePerUser`.
5. `POST /api/seller-coupons` on submit.

**Edit coupon**
1. Pre-fill form from `GET /api/seller-coupons/:id`.
2. `PUT /api/seller-coupons/:id` on save.
3. When switching `couponType`, clear the opposing type's fields before saving.

**Delete / Recycle bin flow**
- Soft delete: `DELETE /api/seller-coupons/:id` — moves to bin.
- To view bin: `GET /api/seller-coupons?recycleBin=true`.
- Restore: `PATCH /api/seller-coupons/:id/restore`.
- Permanent delete: `DELETE /api/seller-coupons/:id/permanent` (only show this button when `softDeletedAt` is set).

---

### Admin dashboard — Seller coupon panel

**View all seller coupons**
```
GET /api/seller-coupons
GET /api/seller-coupons?sellerId=<id>   // scoped to one seller
```

**Create on behalf of a seller**
- Same form as seller, but add a **Seller** dropdown (load from `/api/admin/sellers`).
- Include `sellerId` in the POST body.

**All management actions** (edit, soft delete, restore, hard delete) work identically to the seller flow. No extra params needed — admin token grants full access automatically.

---

### Cart / Checkout — applying a coupon

```
POST /api/seller-coupons/apply
```

Typical flow:

1. Customer enters a coupon code in the cart.
2. Send **all** cart items (including items from other sellers) — the API automatically separates qualifying and non-qualifying items.
3. Display the `summary` block to show the customer their savings.
4. Use `discountedInclTotal` as the new payable amount for qualifying items.
5. Add non-qualifying item totals at full price on top of that.
6. On order creation, pass the coupon code to the order so backend can record it.

**Reading the summary**

| Field | Display as |
|---|---|
| `regularExGSTTotal` | Subtotal (ex-GST) before discount |
| `totalSavingsExGST` | You save (ex-GST) |
| `discountedExGSTTotal` | Discounted subtotal (ex-GST) |
| `gstOnDiscountedAmount` | GST (10%) |
| `discountedInclTotal` | **Total payable (GST-inclusive)** |

---

## Common error shape

All error responses follow:

```json
{
  "success": false,
  "message": "Human-readable error message"
}
```

Validation / business rule errors return `400`. Auth errors return `401` or `403`. Not found returns `404`.
