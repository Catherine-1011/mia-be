const DEFAULT_SUPPORTED_COUNTRIES = new Set(["AU"]);
const DEFAULT_SUPPORTED_CURRENCIES = new Set(["aud"]);

const READINESS_MESSAGES = {
  SELLER_LOOKUP_FAILED: "Seller payment setup could not be verified. Please try again or contact support.",
  STRIPE_NOT_CONNECTED: "This seller has not connected Stripe yet. Please checkout with another seller or try again later.",
  CHARGES_DISABLED: "This seller's Stripe account is not ready to accept payments yet.",
  PAYOUTS_DISABLED: "This seller's Stripe payout setup is incomplete. Please try again later.",
  CAPABILITY_INACTIVE: "This seller's Stripe account is not ready for card payments yet.",
  VERIFICATION_REQUIRED: "This seller's Stripe account requires additional verification before checkout can continue.",
  ACCOUNT_RESTRICTED: "This seller's Stripe account is restricted and cannot accept payments right now.",
  UNSUPPORTED_COUNTRY: "This seller's Stripe account country is not supported for checkout.",
  UNSUPPORTED_CURRENCY: "This seller's Stripe account currency is not supported for checkout.",
  DIRECT_CHARGE_UNSUPPORTED: "This seller's Stripe account cannot accept Direct Charge checkout right now.",
};

function readinessResult(ready, reason = null, detail = null, extra = {}) {
  return { ready, reason, detail, ...extra };
}

function hasRequirementsDue(requirements = {}) {
  return ["currently_due", "past_due", "pending_verification"].some(
    (key) => Array.isArray(requirements[key]) && requirements[key].length > 0,
  );
}

function accountHasRestriction(account) {
  const requirements = account?.requirements || {};
  return Boolean(
    requirements.disabled_reason ||
    account?.disabled_reason ||
    (Array.isArray(requirements.errors) && requirements.errors.length > 0)
  );
}

function accountSupportsCurrency(account, currency) {
  if (!currency) return true;
  const normalized = String(currency).toLowerCase();
  const currencies = account?.settings?.card_payments?.supported_currencies;
  if (!Array.isArray(currencies) || currencies.length === 0) {
    return DEFAULT_SUPPORTED_CURRENCIES.has(normalized);
  }
  return currencies.map((value) => String(value).toLowerCase()).includes(normalized);
}

function accountSupportsDirectCharge(account) {
  if (!account?.id) return false;
  if (account.controller?.stripe_dashboard?.type === "none" && account.controller?.requirement_collection === "stripe") {
    return false;
  }
  return true;
}

async function checkSellerPaymentReadiness({ prisma, stripe, sellerId, currency = "aud" }) {
  let sellerProfile;
  try {
    sellerProfile = await prisma.sellerProfile.findUnique({
      where: { userId: sellerId },
      select: {
        stripeAccountId: true,
        paymentAccountType: true,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
      },
    });
  } catch (err) {
    return readinessResult(false, "SELLER_LOOKUP_FAILED", err.message);
  }

  if (sellerProfile?.paymentAccountType === "PLATFORM") {
    return readinessResult(true, null, null, {
      paymentAccountType: "PLATFORM",
      stripeAccountId: null,
      account: null,
    });
  }

  if (!sellerProfile?.stripeAccountId) return readinessResult(false, "STRIPE_NOT_CONNECTED");
  if (!sellerProfile.stripeChargesEnabled) return readinessResult(false, "CHARGES_DISABLED");
  if (!sellerProfile.stripePayoutsEnabled) return readinessResult(false, "PAYOUTS_DISABLED");

  let account;
  try {
    account = await stripe.accounts.retrieve(sellerProfile.stripeAccountId);
  } catch (err) {
    return readinessResult(false, "SELLER_LOOKUP_FAILED", err.message);
  }

  if (account.charges_enabled !== true) return readinessResult(false, "CHARGES_DISABLED");
  if (account.payouts_enabled !== true) return readinessResult(false, "PAYOUTS_DISABLED");
  if (account.capabilities?.card_payments !== "active") {
    return readinessResult(false, "CAPABILITY_INACTIVE");
  }
  if (hasRequirementsDue(account.requirements)) return readinessResult(false, "VERIFICATION_REQUIRED");
  if (accountHasRestriction(account)) return readinessResult(false, "ACCOUNT_RESTRICTED");
  if (account.country && !DEFAULT_SUPPORTED_COUNTRIES.has(String(account.country).toUpperCase())) {
    return readinessResult(false, "UNSUPPORTED_COUNTRY");
  }
  if (!accountSupportsCurrency(account, currency)) return readinessResult(false, "UNSUPPORTED_CURRENCY");
  if (!accountSupportsDirectCharge(account)) return readinessResult(false, "DIRECT_CHARGE_UNSUPPORTED");

  return readinessResult(true, null, null, {
    stripeAccountId: sellerProfile.stripeAccountId,
    paymentAccountType: "CONNECTED",
    account,
  });
}

module.exports = {
  READINESS_MESSAGES,
  checkSellerPaymentReadiness,
};
