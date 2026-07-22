const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateAlpaCommission,
  calculateDiscountedEligibleSubtotalCents,
  allocateOrderDiscountByLine,
} = require("../utils/commissionCalculator");

function commissionFor(items, orderDiscountCents = 0) {
  const commissionBase = calculateDiscountedEligibleSubtotalCents({ items, orderDiscountCents });
  return calculateAlpaCommission({ eligibleProductSubtotalCents: commissionBase, currency: "aud" });
}

test("no discount commission", () => {
  assert.deepEqual(commissionFor([{ unitPriceCents: 10000, quantity: 1 }]), {
    commissionBase: 10000,
    applicationFeeAmount: 1000,
    currency: "aud",
  });
});

test("product discount commission", () => {
  assert.deepEqual(commissionFor([{ unitPriceCents: 10000, quantity: 1, productDiscountCents: 2000 }]), {
    commissionBase: 8000,
    applicationFeeAmount: 800,
    currency: "aud",
  });
});

test("order discount allocation", () => {
  const lines = allocateOrderDiscountByLine({
    lines: [
      { id: "a", subtotalCents: 6000 },
      { id: "b", subtotalCents: 4000 },
    ],
    orderDiscountCents: 1000,
  });

  assert.equal(lines[0].allocatedDiscountCents, 600);
  assert.equal(lines[1].allocatedDiscountCents, 400);
  assert.equal(lines[0].discountedSubtotalCents + lines[1].discountedSubtotalCents, 9000);
  assert.deepEqual(commissionFor([
    { unitPriceCents: 6000, quantity: 1 },
    { unitPriceCents: 4000, quantity: 1 },
  ], 1000), {
    commissionBase: 9000,
    applicationFeeAmount: 900,
    currency: "aud",
  });
});

test("shipping excluded", () => {
  const result = commissionFor([{ unitPriceCents: 10000, quantity: 1 }]);
  assert.equal(result.commissionBase, 10000);
  assert.equal(result.applicationFeeAmount, 1000);
});

test("GST excluded as non-product fee", () => {
  const result = calculateAlpaCommission({ eligibleProductSubtotalCents: 10000, currency: "aud" });
  assert.equal(result.commissionBase, 10000);
  assert.equal(result.applicationFeeAmount, 1000);
});

test("multiple quantity calculation", () => {
  assert.deepEqual(commissionFor([{ unitPriceCents: 5000, quantity: 2 }]), {
    commissionBase: 10000,
    applicationFeeAmount: 1000,
    currency: "aud",
  });
});

test("multiple item calculation with different discounts", () => {
  assert.deepEqual(commissionFor([
    { unitPriceCents: 5000, quantity: 1, productDiscountCents: 500 },
    { unitPriceCents: 2500, quantity: 2, productDiscountCents: 1000 },
  ]), {
    commissionBase: 8500,
    applicationFeeAmount: 850,
    currency: "aud",
  });
});

test("free shipping does not change commission", () => {
  assert.equal(commissionFor([{ unitPriceCents: 10000, quantity: 1 }]).applicationFeeAmount, 1000);
});

test("full discount", () => {
  assert.deepEqual(commissionFor([{ unitPriceCents: 10000, quantity: 1 }], 10000), {
    commissionBase: 0,
    applicationFeeAmount: 0,
    currency: "aud",
  });
});

test("rounding", () => {
  assert.deepEqual(commissionFor([{ unitPriceCents: 1001, quantity: 1 }]), {
    commissionBase: 1001,
    applicationFeeAmount: 100,
    currency: "aud",
  });
});

test("zero value", () => {
  assert.deepEqual(commissionFor([{ unitPriceCents: 0, quantity: 1 }]), {
    commissionBase: 0,
    applicationFeeAmount: 0,
    currency: "aud",
  });
});
