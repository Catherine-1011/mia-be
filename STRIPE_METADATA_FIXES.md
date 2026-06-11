# Stripe Multi-Seller Metadata Fixes

## Summary
Fixed two critical issues in multi-seller order Stripe metadata handling:
1. **Sub-order display IDs** were being overwritten with parent order IDs
2. **Commission/fee information** was not properly exposed in connected accounts

---

## Issue 1: Sub-order Display ID Overwrite

### The Problem
When processing multi-seller orders with platform charges, the Stripe metadata was supposed to include the sub-order ID and display ID (e.g., "#1001-A"). However, the code was:

1. Building correct metadata with sub-order IDs via `buildSellerStripeOrderMetadata()`
2. Spreading that metadata into the transfer
3. **Immediately overwriting** with `orderId: order.id` (the parent order ID)

**Result**: Stripe showed parent order ID instead of sub-order ID, causing:
- Sellers to see wrong order reference in their Stripe dashboard
- Admins unable to link transfers to specific sub-orders
- Confusion about which order a transfer was for

### The Fix
**File**: `controllers/payment.js`
**Lines**: 1175-1192 (Platform Charge Path - `stripe.transfers.create()`)

**What changed**:
```javascript
// BEFORE (BUGGY):
metadata: {
  ...sellerStripeMetadata,  // includes correct subOrderId
  orderId: order.id,        // ← OVERWRITES with parent ID (BUG!)
  sellerId: sid,
  ...
}

// AFTER (FIXED):
metadata: {
  ...sellerStripeMetadata,  // NO OVERWRITE - spreads as-is
  sellerId: sid,            // Only add sellerId (not in metadata)
  commissionAmount: ...,
  ...
}
```

### Result
Metadata now properly includes:
- `orderId`: Sub-order ID (from `sellerStripeMetadata`)
- `subOrderId`: Sub-order ID for clarity
- `subDisplayId`: Sub-order display (e.g., "#1001-A")
- `displayId`: Sub-order display ID
- `parentOrderId`: Parent order ID (kept separate)
- `parentDisplayId`: Parent order display (kept separate)

Sellers now see correct sub-order IDs in their Stripe connected account.

---

## Issue 2: Commission/Fees Not Visible in Connected Account

### The Problem
The `updateConnectedAccountDestinationPayment()` function was receiving metadata, but not all commission/fee details needed for seller visibility:

**Missing fields**:
- `commissionRate`: The percentage rate applied (10%, 15%, etc.)
- `productValueExGST`: The base price used for commission calculation
- `platformFee`: Formatted fee amount
- `netEarning`: What the seller actually receives

**Result**: Sellers couldn't see:
- How the fee was calculated
- What percentage was applied
- The breakdown between fees and earnings

### The Fix
**File**: `controllers/payment.js`
**Lines**: 1197-1215 (Both paths - transfer creation and destination payment)

**Transfer metadata (line 1182-1191)**:
```javascript
metadata: {
  ...sellerStripeMetadata,
  sellerId: sid,
  commissionAmount:   payout.commissionAmount.toString(),
  commissionRate:     payout.commissionRatePct.toString(),      // ← ADDED
  gstAmount:          payout.gstAmount.toString(),
  shippingAmount:     payout.shippingAmount.toString(),
  sellerTotalPayout:  payout.sellerTotalPayout.toString(),
  productValueExGST:  payout.productValueExGST.toString(),      // ← ADDED
}
```

**Destination payment metadata (line 1205-1215)**:
```javascript
metadata: {
  ...sellerStripeMetadata,
  sellerId: sid,
  commissionAmount:  payout.commissionAmount.toString(),
  commissionRate:    payout.commissionRatePct.toString(),       // ← ADDED
  gstAmount:         payout.gstAmount.toString(),
  shippingAmount:    payout.shippingAmount.toString(),
  sellerTotalPayout: payout.sellerTotalPayout.toString(),
  platformFee:       payout.commissionAmount.toFixed(2),        // ← ADDED
  productValueExGST: payout.productValueExGST.toString(),       // ← ADDED
  netEarning:        payout.sellerProductEarning.toString(),    // ← ADDED
}
```

### Result
Sellers now see complete fee breakdown in Stripe:
- **commissionAmount**: Platform fee (e.g., $10.00)
- **commissionRate**: Rate applied (e.g., 10%)
- **productValueExGST**: Base price for commission (e.g., $100.00)
- **platformFee**: Fee in formatted currency
- **netEarning**: What seller receives (e.g., $90.00)
- **gstAmount**: GST portion
- **shippingAmount**: Per-seller shipping

Commission now shows correctly (not zero) with full transparency.

---

## Technical Details

### Commission Calculation Formula
For a GST-inclusive price:
```
Product Price (GST-included): $110.00
GST Amount: $110 / 11 = $10.00
Base Price (GST-excluded): $100.00
Commission (10%): $100 × 0.10 = $10.00
Seller Payout: $100 - $10 + $10 GST = $100.00
```

The `calculateSellerPayout()` function handles this:
- `productValueExGST`: Used for commission calculation only
- Commission applied to `productValueExGST`, NOT total with shipping
- GST is not subject to commission fees

### Multi-Seller Order Structure
```
Parent Order #1001
├─ Sub-order A (Seller 1)
│  ├─ Items: Product A, Product B
│  ├─ Commission: 10% on product value
│  └─ Display ID: #1001-A
├─ Sub-order B (Seller 2)
│  ├─ Items: Product C
│  ├─ Commission: 12% on product value
│  └─ Display ID: #1001-B
└─ Shipping: Split between sellers
```

Each sub-order generates its own transfer with correct metadata.

---

## Verification

### How to Verify Fix 1 (Display IDs)
1. Create multi-seller order
2. Go to Stripe Dashboard → Connected Accounts → Transfers
3. Check metadata: should show `subDisplayId` like "#1001-A", not parent order ID

### How to Verify Fix 2 (Commissions)
1. Create multi-seller order with non-zero items
2. Check transfer metadata in Stripe connected account
3. Verify `commissionAmount` is > 0 and `commissionRate` is visible
4. Confirm `netEarning` = `sellerTotalPayout` - `commissionAmount`

---

## Files Modified
- `controllers/payment.js` (lines 1175-1215)
  - Platform charge transfer creation
  - Destination payment metadata update

## Related Functions
- `buildSellerStripeOrderMetadata()`: Creates the base metadata (lines 100-115)
- `buildSellerTransactionDescription()`: Creates Stripe description (lines 63-98)
- `calculateSellerPayout()`: Calculates commission and payout amounts
- `updateConnectedAccountDestinationPayment()`: Updates destination charge with metadata

## Breaking Changes
None. Fixes preserve all existing logic and data structures.

---

## Notes
- Direct charge path (single-seller orders) unaffected
- Commission calculation logic unchanged
- GST handling unchanged
- All existing order flow preserved
- No database migrations required
