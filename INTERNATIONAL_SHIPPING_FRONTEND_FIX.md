# International Shipping — Multi-Seller Fix (Frontend)

## The problem

For **domestic** (Australia) shipping, the frontend already calls the cart endpoint with `shippingMethodId` and reads `calculations.totalShippingCost` — this multiplies correctly per seller.

For **international** shipping, the frontend is currently calling the rate endpoint:

```
GET /api/shipping/international/rate?country=Belarus  ← ❌ WRONG for cart summary
```

That endpoint always returns the flat per-seller rate ($93.25). It knows nothing about the cart or how many sellers are in it. That is why the total never doubles.

---

## The fix — mirror exactly what you do for domestic

### Domestic flow (already working ✅)

```
User selects Standard/Express
         ↓
GET /api/cart/my-cart?shippingMethodId=<id>
         ↓
Display calculations.totalShippingCost   ← seller-multiplied total
Display calculations.grandTotal
```

### International flow (needs to match the same pattern)

```
User selects country (e.g. Belarus)
         ↓
GET /api/cart/my-cart?internationalCountry=Belarus    ← authenticated
  OR
POST /api/cart/calculate-guest  { internationalCountry: "Belarus", items: [...] }
         ↓
Display calculations.shippingCost    ← already equals totalShippingCost for intl
Display calculations.grandTotal
```

> `calculations.shippingCost` for international orders is pre-set by the backend to equal `totalShippingCost` (rate × seller count). You can also read `calculations.totalShippingCost` — both are identical for international.

---

## Side-by-side comparison

| | Domestic | International |
|---|---|---|
| Trigger | User picks Standard / Express | User picks a country |
| API call | `GET /api/cart/my-cart?shippingMethodId=<id>` | `GET /api/cart/my-cart?internationalCountry=<name>` |
| Shipping display field | `calculations.totalShippingCost` | `calculations.shippingCost` (= totalShippingCost) |
| Grand total field | `calculations.grandTotal` | `calculations.grandTotal` |
| 2-seller example | $15 × 2 = **$30** | $93.25 × 2 = **$186.50** |

---

## Concrete example (2 sellers, Belarus, Zone 4)

### API call
```
GET /api/cart/my-cart?internationalCountry=Belarus
Authorization: Bearer <token>
```

### Response (relevant fields)
```json
{
  "calculations": {
    "subtotal": "200.00",
    "shippingCost": "186.50",       ← USE THIS for the shipping display line
    "totalShippingCost": "186.50",  ← same value
    "sellerCount": 2,
    "gstAmount": "18.18",
    "grandTotal": "386.50"          ← USE THIS for the grand total
  },
  "internationalShipping": {
    "country": "Belarus",
    "zone": "Zone 4",
    "zoneName": "UK & Europe",
    "costPerSeller": 93.25,         ← only if you need to show per-seller breakdown
    "totalCost": 186.50,
    "sellerCount": 2,
    "estimatedDays": "10-20 business days"
  }
}
```

---

## What to change in the code

### Before (broken)
```js
// Called once when country changes — only returns flat per-seller rate
const rateRes = await fetch(`/api/shipping/international/rate?country=${country}`);
const { data } = await rateRes.json();
setShipping(data.cost);          // ❌ $93.25 — ignores seller count
setGrandTotal(subtotal + data.cost);
```

### After (correct)
```js
// Called when country changes — returns seller-multiplied totals
const cartRes = await fetch(
  `/api/cart/my-cart?internationalCountry=${encodeURIComponent(country)}`,
  { headers: { Authorization: `Bearer ${token}` } }
);
const { calculations } = await cartRes.json();
setShipping(calculations.shippingCost);   // ✅ $186.50 for 2 sellers
setGrandTotal(calculations.grandTotal);   // ✅ correct total
```

### For guest checkout
```js
const cartRes = await fetch('/api/cart/calculate-guest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items: cartItems,           // [{ productId, quantity }]
    internationalCountry: country
  })
});
const { calculations } = await cartRes.json();
setShipping(calculations.shippingCost);   // ✅ seller-multiplied
setGrandTotal(calculations.grandTotal);   // ✅ correct total
```

---

## The `/rate` endpoint — when to use it

```
GET /api/shipping/international/rate?country=Belarus
```

Only use this for **showing a quick price preview in the zone/country dropdown** — before the user has confirmed their selection and before you need accurate cart totals. It is intentionally lightweight and has no cart context.

**Never use its `cost` value to compute or display the final shipping charge.**
