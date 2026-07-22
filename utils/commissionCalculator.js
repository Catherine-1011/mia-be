/**
 * Australian marketplace commission calculator.
 *
 * Rules (per platform policy):
 *  - Products are priced GST-inclusive at 10%
 *  - Commission is charged on the GST-EXCLUSIVE product price only
 *  - Shipping belongs 100% to the seller — no commission on shipping
 *
 * Example (10% GST, 10% commission, $100 product, $15 shipping):
 *   productValueExGST   = 100 / 1.10           = $90.91
 *   gstAmount           = 100 - 90.91           = $9.09
 *   commissionAmount    = 90.91 * 0.10          = $9.09
 *   sellerProductEarning= 90.91 - 9.09          = $81.82
 *   sellerTotalPayout   = 81.82 + 15            = $96.82  (what platform transfers to seller)
 *   platformRevenue     = 9.09 (commission)     stays with platform
 */

const GST_DIVISOR = 1.10;
const ALPA_COMMISSION_RATE_BPS = 1000; // 10.00%

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Calculate the full commission/payout breakdown for one seller's slice of an order.
 *
 * @param {number} productPriceGSTInclusive  Sum of (price × qty) for this seller's items (GST incl.)
 * @param {number} shippingAmount            Shipping amount allocated to this seller
 * @param {number} commissionRatePct         Commission rate as a percentage, e.g. 10 for 10%
 * @returns {{
 *   productPriceGSTInclusive: number,
 *   productValueExGST: number,
 *   gstAmount: number,
 *   commissionRatePct: number,
 *   commissionAmount: number,
 *   sellerProductEarning: number,
 *   shippingAmount: number,
 *   sellerTotalPayout: number,
 *   sellerTotalPayoutCents: number,
 *   commissionAmountCents: number,
 * }}
 */
function calculateSellerPayout(productPriceGSTInclusive, shippingAmount, commissionRatePct) {
  const commissionRate = commissionRatePct / 100;

  // Step 1: Remove GST from product price
  const productValueExGST = productPriceGSTInclusive / GST_DIVISOR;
  const gstAmount = productPriceGSTInclusive - productValueExGST;

  // Step 2: Commission on GST-exclusive product value only
  const commissionAmount = productValueExGST * commissionRate;

  // Step 3: Seller's product earning after commission
  const sellerProductEarning = productValueExGST - commissionAmount;

  // Step 4: Add shipping (seller keeps 100% of shipping)
  const sellerTotalPayout = sellerProductEarning + shippingAmount;

  return {
    productPriceGSTInclusive: round2(productPriceGSTInclusive),
    productValueExGST:        round2(productValueExGST),
    gstAmount:                round2(gstAmount),
    commissionRatePct,
    commissionAmount:         round2(commissionAmount),
    sellerProductEarning:     round2(sellerProductEarning),
    shippingAmount:           round2(shippingAmount),
    sellerTotalPayout:        round2(sellerTotalPayout),
    // Stripe requires integer cents
    sellerTotalPayoutCents:   Math.round(sellerTotalPayout * 100),
    commissionAmountCents:    Math.round(commissionAmount * 100),
  };
}

function toMinorUnits(value) {
  return Math.round(Number(value || 0) * 100);
}

function normalizeCents(value) {
  const cents = Number(value || 0);
  if (!Number.isFinite(cents)) {
    throw new Error("eligibleProductSubtotalCents must be a finite number");
  }
  return Math.max(0, Math.round(cents));
}

function calculateAlpaCommission({ eligibleProductSubtotalCents, currency = "aud" }) {
  const commissionBase = normalizeCents(eligibleProductSubtotalCents);
  return {
    commissionBase,
    applicationFeeAmount: Math.round((commissionBase * ALPA_COMMISSION_RATE_BPS) / 10000),
    currency: String(currency || "aud").toLowerCase(),
  };
}

function allocateOrderDiscountByLine({ lines, orderDiscountCents = 0 }) {
  const normalizedLines = (lines || []).map((line, index) => ({
    ...line,
    index,
    subtotalCents: normalizeCents(line.subtotalCents),
  }));
  const subtotalCents = normalizedLines.reduce((sum, line) => sum + line.subtotalCents, 0);
  const discountCents = Math.min(normalizeCents(orderDiscountCents), subtotalCents);

  if (subtotalCents === 0 || discountCents === 0) {
    return normalizedLines.map((line) => ({
      ...line,
      allocatedDiscountCents: 0,
      discountedSubtotalCents: line.subtotalCents,
    }));
  }

  const allocations = normalizedLines.map((line) => {
    const exact = (discountCents * line.subtotalCents) / subtotalCents;
    const floor = Math.floor(exact);
    return {
      ...line,
      allocatedDiscountCents: floor,
      remainder: exact - floor,
    };
  });

  let remaining = discountCents - allocations.reduce((sum, line) => sum + line.allocatedDiscountCents, 0);
  allocations.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < allocations.length && remaining > 0; i += 1) {
    allocations[i].allocatedDiscountCents += 1;
    remaining -= 1;
  }

  return allocations
    .sort((a, b) => a.index - b.index)
    .map(({ remainder, ...line }) => ({
      ...line,
      discountedSubtotalCents: Math.max(0, line.subtotalCents - line.allocatedDiscountCents),
    }));
}

function calculateDiscountedEligibleSubtotalCents({ items, orderDiscountCents = 0 }) {
  const lines = (items || []).map((item) => {
    const quantity = Number(item.quantity || 0);
    const unitCents = item.unitPriceCents != null
      ? normalizeCents(item.unitPriceCents)
      : toMinorUnits(item.unitPrice);
    const productDiscountCents = item.productDiscountCents != null
      ? normalizeCents(item.productDiscountCents)
      : toMinorUnits(item.productDiscount || 0);
    return {
      subtotalCents: Math.max(0, unitCents * quantity - productDiscountCents),
    };
  });

  return allocateOrderDiscountByLine({ lines, orderDiscountCents })
    .reduce((sum, line) => sum + line.discountedSubtotalCents, 0);
}

module.exports = {
  calculateSellerPayout,
  calculateAlpaCommission,
  allocateOrderDiscountByLine,
  calculateDiscountedEligibleSubtotalCents,
};
