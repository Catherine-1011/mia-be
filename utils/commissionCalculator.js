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

module.exports = { calculateSellerPayout };
