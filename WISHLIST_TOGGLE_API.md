# Wishlist Toggle API — Frontend Integration Guide

## Overview

The wishlist **POST** endpoint now works as a **toggle**. Calling it once adds the product; calling it again removes it. You no longer need to call the DELETE endpoint separately for a heart/bookmark button.

---

## Toggle Endpoint (Primary — use this for UI buttons)

### `POST /api/wishlist/:productId`

Requires: **Bearer token** (logged-in user)

| Scenario | Action taken | HTTP status |
|---|---|---|
| Product **not** in wishlist | Adds it | `200` |
| Product **already** in wishlist | Removes it | `200` |
| Product not found | Error | `404` |
| Product inactive | Error | `400` |

### Response — Added
```json
{
  "success": true,
  "message": "Product added to wishlist",
  "action": "added",
  "isInWishlist": true,
  "wishlistItem": {
    "id": "...",
    "userId": "...",
    "productId": "...",
    "product": {
      "id": "...",
      "title": "Handmade Bark Painting",
      "price": "120.00",
      "featuredImage": "https://...",
      "stock": 5
    }
  }
}
```

### Response — Removed
```json
{
  "success": true,
  "message": "Product removed from wishlist",
  "action": "removed",
  "isInWishlist": false
}
```

### Key fields to read
| Field | Type | Use |
|---|---|---|
| `action` | `"added"` \| `"removed"` | Drive UI feedback ("Added to wishlist!" toast etc.) |
| `isInWishlist` | `boolean` | Set the heart/bookmark button filled or empty |

---

## All Wishlist Endpoints

| Method | URL | Description | Auth |
|---|---|---|---|
| `POST` | `/api/wishlist/:productId` | **Toggle** add/remove | ✅ Required |
| `PUT` | `/api/wishlist/toggle/:productId` | Same toggle (legacy) | ✅ Required |
| `DELETE` | `/api/wishlist/:productId` | Explicit remove only | ✅ Required |
| `GET` | `/api/wishlist` | Get user's full wishlist | ✅ Required |
| `GET` | `/api/wishlist/check/:productId` | Check if product is wishlisted | ✅ Required |
| `DELETE` | `/api/wishlist` | Clear entire wishlist | ✅ Required |
| `POST` | `/api/wishlist/move-to-cart/:productId` | Move item to cart | ✅ Required |

---

## Recommended UI Implementation

### Heart / Bookmark Button Pattern

```js
// Example (React)
const toggleWishlist = async (productId) => {
  const res = await fetch(`/api/wishlist/${productId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();

  if (data.success) {
    setIsWishlisted(data.isInWishlist);           // update button state
    showToast(data.action === "added"
      ? "Added to wishlist ❤️"
      : "Removed from wishlist"
    );
  }
};
```

### Check wishlist state on page load

Use `GET /api/wishlist/check/:productId` to know the initial state of the heart button when a product page loads.

```js
const checkWishlist = async (productId) => {
  const res = await fetch(`/api/wishlist/check/${productId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const { isInWishlist } = await res.json();
  setIsWishlisted(isInWishlist);
};
```

---

## What Changed

| Before | After |
|---|---|
| `POST /:productId` returned `400` if already in wishlist | `POST /:productId` now **removes** it (toggle) |
| Response had no `action` or `isInWishlist` fields | Both fields always present in response |
| Status code `201` on add | Status code `200` for both add and remove |

> No breaking changes to the `DELETE`, `GET`, or other endpoints.
