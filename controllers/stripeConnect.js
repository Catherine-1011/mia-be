/**
 * Stripe Connect controller — Australian seller onboarding
 *
 * Flow:
 *  1. POST /seller-onboarding/stripe/connect        → createConnectAccount
 *  2. POST /seller-onboarding/stripe/onboarding-link → getOnboardingLink
 *  3. GET  /seller-onboarding/stripe/status         → getConnectStatus
 *  4. POST /webhooks/stripe-connect                 → stripeConnectWebhook  (public, no auth)
 */

const Stripe = require("stripe");
const prisma = require("../config/prisma");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Create Stripe Express account for seller
//    Called once; idempotent — returns existing account if already created.
// ─────────────────────────────────────────────────────────────────────────────
exports.createConnectAccount = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sellerProfile: true },
    });

    if (!user || !user.sellerProfile) {
      return reply.status(404).send({ success: false, message: "Seller profile not found" });
    }

    const profile = user.sellerProfile;

    // Already connected — just return existing account ID
    if (profile.stripeAccountId) {
      return reply.status(200).send({
        success: true,
        message: "Stripe account already connected",
        stripeAccountId: profile.stripeAccountId,
        stripeOnboardingComplete: profile.stripeOnboardingComplete,
        stripeChargesEnabled: profile.stripeChargesEnabled,
        stripePayoutsEnabled: profile.stripePayoutsEnabled,
      });
    }

    // Determine business type
    // "sole_trader" and "individual" both map to Stripe's "individual"
    const rawType = (profile.businessType || "").toLowerCase();
    const businessType = ["company", "non_profit"].includes(rawType) ? "company" : "individual";

    // Parse stored business address (stored as JSON string or plain string)
    let addressObj = {};
    if (profile.businessAddress) {
      try {
        addressObj = typeof profile.businessAddress === "string"
          ? JSON.parse(profile.businessAddress)
          : profile.businessAddress;
      } catch {
        // plain string address — can't pre-fill structured fields
      }
    }

    // Build the Stripe account payload — pre-fill everything we already have
    // so the seller ONLY needs to add bank account + upload ID on Stripe's page.
    const accountPayload = {
      type: "express",
      country: "AU",
      email: user.email,
      business_type: businessType,
      capabilities: {
        transfers: { requested: true },
      },
      business_profile: {
        name: profile.businessName || profile.storeName || user.name,
        url: profile.website || undefined,
      },
      settings: {
        payouts: {
          schedule: { interval: "manual" }, // Platform controls payout timing
        },
      },
      metadata: {
        platformUserId: userId,
        sellerProfileId: profile.id,
        abn: profile.abn || "",
      },
    };

    // Pre-fill individual details (name split, address) so Stripe's form is shorter
    if (businessType === "individual") {
      const nameParts = (profile.contactPerson || user.name || "").trim().split(/\s+/);
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      accountPayload.individual = {
        ...(firstName && { first_name: firstName }),
        ...(lastName && { last_name: lastName }),
        email: user.email,
        phone: user.phone || undefined,
        // Pre-fill address if we have structured parts
        ...(addressObj.city && {
          address: {
            line1: addressObj.line1 || addressObj.street || addressObj.address || undefined,
            city: addressObj.city || undefined,
            state: addressObj.state || undefined,
            postal_code: addressObj.zipCode || addressObj.postalCode || undefined,
            country: "AU",
          },
        }),
      };
    }

    // Pre-fill company details
    if (businessType === "company") {
      accountPayload.company = {
        name: profile.businessName || undefined,
        phone: user.phone || undefined,
        tax_id: profile.abn || undefined, // ABN maps to tax_id for AU companies
        ...(addressObj.city && {
          address: {
            line1: addressObj.line1 || addressObj.street || addressObj.address || undefined,
            city: addressObj.city || undefined,
            state: addressObj.state || undefined,
            postal_code: addressObj.zipCode || addressObj.postalCode || undefined,
            country: "AU",
          },
        }),
      };
    }

    const account = await stripe.accounts.create(accountPayload);

    // Persist the account ID immediately
    await prisma.sellerProfile.update({
      where: { userId },
      data: { stripeAccountId: account.id },
    });

    return reply.status(201).send({
      success: true,
      message: "Stripe Connect account created",
      stripeAccountId: account.id,
    });
  } catch (error) {
    console.error("createConnectAccount error:", error);
    return reply.status(500).send({ success: false, message: "Failed to create Stripe account", detail: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Generate a fresh Stripe Account Link (onboarding URL)
//    AccountLinks expire after ~24 hours so always generate fresh.
//    Requires stripeAccountId to already exist (call createConnectAccount first).
// ─────────────────────────────────────────────────────────────────────────────
exports.getOnboardingLink = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const profile = await prisma.sellerProfile.findUnique({
      where: { userId },
      select: { stripeAccountId: true, stripeOnboardingComplete: true },
    });

    if (!profile) {
      return reply.status(404).send({ success: false, message: "Seller profile not found" });
    }

    if (!profile.stripeAccountId) {
      return reply.status(400).send({
        success: false,
        message: "No Stripe account found. Call /stripe/connect first.",
      });
    }

    const { returnUrl, refreshUrl } = request.body;

    const frontendBase = process.env.FRONTEND_URL || "http://localhost:3000";
    const defaultReturn = `${frontendBase}/seller/dashboard?stripe=success`;
    const defaultRefresh = `${frontendBase}/seller/dashboard/payouts?stripe=refresh`;

    const accountLink = await stripe.accountLinks.create({
      account: profile.stripeAccountId,
      refresh_url: refreshUrl || defaultRefresh,
      return_url: returnUrl || defaultReturn,
      type: "account_onboarding",
    });

    return reply.status(200).send({
      success: true,
      url: accountLink.url,
      expiresAt: accountLink.expires_at,
    });
  } catch (error) {
    console.error("getOnboardingLink error:", error);
    return reply.status(500).send({ success: false, message: "Failed to generate onboarding link", detail: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Get current Stripe Connect status (synced from Stripe + DB)
// ─────────────────────────────────────────────────────────────────────────────
exports.getConnectStatus = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const profile = await prisma.sellerProfile.findUnique({
      where: { userId },
      select: {
        stripeAccountId: true,
        stripeOnboardingComplete: true,
        stripeChargesEnabled: true,
        stripePayoutsEnabled: true,
      },
    });

    if (!profile) {
      return reply.status(404).send({ success: false, message: "Seller profile not found" });
    }

    if (!profile.stripeAccountId) {
      return reply.status(200).send({
        success: true,
        connected: false,
        stripeOnboardingComplete: false,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
      });
    }

    // Live-check with Stripe to get latest status
    const account = await stripe.accounts.retrieve(profile.stripeAccountId);

    // KYC verification status — for Express accounts, charges_enabled is the real indicator.
    // individual.verification.status is often "unverified" on Express even when fully approved.
    let stripeKycStatus;
    if (account.charges_enabled) {
      stripeKycStatus = "verified";
    } else if (account.details_submitted) {
      stripeKycStatus = "pending";
    } else {
      stripeKycStatus = "unverified";
    }

    const updates = {
      stripeOnboardingComplete: account.details_submitted,
      stripeChargesEnabled: account.charges_enabled,
      stripePayoutsEnabled: account.payouts_enabled,
      stripeKycStatus,
      stripeAbnProvided: account.company?.tax_id_provided || false,
      stripeBankConnected: (account.external_accounts?.total_count || 0) > 0,
    };

    // Keep DB in sync
    await prisma.sellerProfile.update({
      where: { userId },
      data: updates,
    });

    return reply.status(200).send({
      success: true,
      connected: true,
      stripeAccountId: profile.stripeAccountId,
      ...updates,
      // Business info from Stripe (for reference)
      stripeBusinessName: account.company?.name || account.business_profile?.name || null,
      // Note: actual ABN value is masked by Stripe — only abnProvided (boolean) is available
      requirements: account.requirements?.currently_due || [],
      eventuallyDue: account.requirements?.eventually_due || [],
      errors: account.requirements?.errors || [],
    });
  } catch (error) {
    console.error("getConnectStatus error:", error);
    return reply.status(500).send({ success: false, message: "Failed to retrieve Stripe status", detail: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. Stripe Connect Webhook
//    Listen for `account.updated` events to keep DB in sync automatically.
//    Register this endpoint in Stripe Dashboard → Webhooks (Connected accounts).
//    Set STRIPE_CONNECT_WEBHOOK_SECRET in .env
// ─────────────────────────────────────────────────────────────────────────────
exports.stripeConnectWebhook = async (request, reply) => {
  const sig = request.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(request.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Stripe Connect webhook signature error:", err.message);
    return reply.status(400).send({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === "account.updated") {
    const account = event.data.object;

    try {
      // For Express accounts, charges_enabled is the real KYC indicator
      let stripeKycStatus;
      if (account.charges_enabled) {
        stripeKycStatus = "verified";
      } else if (account.details_submitted) {
        stripeKycStatus = "pending";
      } else {
        stripeKycStatus = "unverified";
      }

      await prisma.sellerProfile.updateMany({
        where: { stripeAccountId: account.id },
        data: {
          stripeOnboardingComplete: account.details_submitted,
          stripeChargesEnabled: account.charges_enabled,
          stripePayoutsEnabled: account.payouts_enabled,
          stripeKycStatus,
          stripeAbnProvided: account.company?.tax_id_provided || false,
          stripeBankConnected: (account.external_accounts?.total_count || 0) > 0,
        },
      });
      console.log(`Stripe Connect: synced account ${account.id} — KYC: ${stripeKycStatus}`);
    } catch (err) {
      console.error("Stripe Connect webhook DB update error:", err.message);
    }
  }

  return reply.status(200).send({ received: true });
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. Admin: Trigger a payout transfer to a seller's Stripe Connect account
//    Called from admin payout approval flow.
//    amount is in AUD dollars (not cents).
// ─────────────────────────────────────────────────────────────────────────────
exports.createSellerTransfer = async (sellerUserId, amountAUD, description = "Seller payout") => {
  const profile = await prisma.sellerProfile.findUnique({
    where: { userId: sellerUserId },
    select: {
      stripeAccountId: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });

  if (!profile?.stripeAccountId) {
    throw new Error("Seller does not have a connected Stripe account");
  }

  if (!profile.stripePayoutsEnabled) {
    throw new Error("Seller Stripe account is not yet ready to receive payouts");
  }

  const amountInCents = Math.round(amountAUD * 100);

  const transfer = await stripe.transfers.create({
    amount: amountInCents,
    currency: "aud",
    destination: profile.stripeAccountId,
    description,
    metadata: {
      sellerUserId,
    },
  });

  return transfer;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /seller-onboarding/stripe/login-link
// Returns a one-time Stripe Express dashboard login URL for the authenticated seller
// ─────────────────────────────────────────────────────────────────────────────
exports.getSellerLoginLink = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sellerProfile: true },
    });

    if (!user || !user.sellerProfile) {
      return reply.status(404).send({ success: false, message: 'Seller profile not found.' });
    }

    const profile = user.sellerProfile;

    if (!profile.stripeAccountId) {
      return reply.status(400).send({
        success: false,
        message: 'No Stripe account linked. Please complete Stripe Connect onboarding first.'
      });
    }

    if (!profile.stripeOnboardingComplete) {
      return reply.status(400).send({
        success: false,
        message: 'Stripe onboarding is not yet complete. Please finish the onboarding process.'
      });
    }

    const loginLink = await stripe.accounts.createLoginLink(profile.stripeAccountId);

    return reply.send({
      success: true,
      url: loginLink.url,
      message: 'Stripe dashboard login link generated. This link is valid for a few minutes.'
    });
  } catch (err) {
    console.error('❌ getSellerLoginLink error:', err);

    if (err.type === 'StripeInvalidRequestError') {
      return reply.status(400).send({ success: false, message: err.message });
    }

    return reply.status(500).send({ success: false, message: 'Failed to generate Stripe login link.' });
  }
};
