/**
 * Stripe Connect controller — Australian seller onboarding (Standard accounts)
 *
 * Flow:
 *  1. GET  /seller-onboarding/stripe/oauth-url      → getOAuthUrl
 *       Seller is redirected to stripe.com to connect/create their own Stripe account.
 *  2. GET  /seller-onboarding/stripe/oauth-callback → handleOAuthCallback  (public)
 *       Stripe redirects back with ?code=xxx&state=userId → exchange for stripeAccountId.
 *  3. GET  /seller-onboarding/stripe/status         → getConnectStatus
 *  4. POST /webhooks/stripe-connect                 → stripeConnectWebhook  (public, no auth)
 *
 * Standard accounts log in at stripe.com directly — no login-link needed.
 *
 * ── Prerequisites ────────────────────────────────────────────────────────────
 * 1. In Stripe Dashboard → Settings → Connect → OAuth settings:
 *    - Enable OAuth for Standard accounts
 *    - Set redirect URI to: <FRONTEND_URL>/seller/stripe/callback  (or your backend callback)
 *    - Note your Client ID (looks like ca_xxxxxxxx) → set as STRIPE_CLIENT_ID in .env
 * 2. Add to .env:
 *    STRIPE_CLIENT_ID=ca_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 */

const Stripe = require("stripe");
const prisma = require("../config/prisma");
const { sendSellerStripeApprovedEmail, sendDisputeAlertEmail } = require("../utils/emailService");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Generate Stripe OAuth URL
//    Seller is redirected to stripe.com to connect/create their Standard account.
//    GET /seller-onboarding/stripe/oauth-url  (auth required)
// ─────────────────────────────────────────────────────────────────────────────
exports.getOAuthUrl = async (request, reply) => {
  try {
    const userId = request.user.userId;

    // Accept optional ABN via query param (?abn=XXXXXXXXXXX) or request body
    const submittedAbn = (request.query?.abn || request.body?.abn || '').toString().replace(/\s/g, '').trim();

    const profile = await prisma.sellerProfile.findUnique({
      where: { userId },
      select: { stripeAccountId: true, abn: true },
    });

    if (!profile) {
      return reply.status(404).send({ success: false, message: 'Seller profile not found' });
    }

    // If seller provided ABN and it's not yet in DB, save it now
    if (submittedAbn && !profile.abn) {
      await prisma.sellerProfile.update({
        where: { userId },
        data: { abn: submittedAbn },
      });
    }

    // Resolve the ABN to pre-fill in Stripe (prefer newly submitted, fall back to DB value)
    const abnForStripe = submittedAbn || profile.abn || '';

    // Already connected — skip OAuth, go straight to stripe.com
    if (profile.stripeAccountId) {
      return reply.status(200).send({
        success: true,
        alreadyConnected: true,
        message: 'Stripe account already connected. Visit stripe.com to access your dashboard.',
      });
    }

    const clientId = process.env.STRIPE_CLIENT_ID;
    if (!clientId) {
      return reply.status(500).send({
        success: false,
        message: 'STRIPE_CLIENT_ID is not configured on the server.',
      });
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const frontendBase = process.env.FRONTEND_URL || 'http://localhost:3000';
    const redirectUri  = `${frontendBase}/seller/stripe/callback`;

    // Build the OAuth authorisation URL — pre-fill seller details so they don't re-enter them
    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     clientId,
      scope:         'read_write',
      redirect_uri:  redirectUri,
      state:         userId,
      'stripe_user[email]':   user?.email || '',
      'stripe_user[country]': 'AU',
      'stripe_user[currency]': 'aud',
    });

    // Pre-fill ABN in Stripe's onboarding form if we have it
    if (abnForStripe) {
      params.set('stripe_user[business_tax_id]', abnForStripe);
    }

    const oauthUrl = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;

    return reply.status(200).send({
      success: true,
      url: oauthUrl,
      message: 'Redirect the seller to this URL to connect their Stripe account.',
    });
  } catch (error) {
    console.error('getOAuthUrl error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to generate OAuth URL', detail: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Handle Stripe OAuth Callback
//    Stripe redirects back to FRONTEND_URL/seller/stripe/callback?code=xxx&state=userId
//    The frontend calls this backend endpoint with those params.
//    GET /seller-onboarding/stripe/oauth-callback  (PUBLIC — no auth, verified via state)
// ─────────────────────────────────────────────────────────────────────────────
exports.handleOAuthCallback = async (request, reply) => {
  try {
    const { code, state: userId, error: oauthError, error_description } = request.query;

    // Stripe sends ?error=access_denied if seller cancels
    if (oauthError) {
      console.warn(`⚠️  Stripe OAuth denied by seller (userId: ${userId}): ${error_description}`);
      return reply.status(400).send({
        success: false,
        message: error_description || 'Stripe connection was cancelled.',
        error: oauthError,
      });
    }

    if (!code || !userId) {
      return reply.status(400).send({ success: false, message: 'Missing code or state parameter.' });
    }

    // Verify the seller exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sellerProfile: true },
    });

    if (!user || !user.sellerProfile) {
      return reply.status(404).send({ success: false, message: 'Seller not found.' });
    }

    // Exchange the authorisation code for the connected account ID
    const response = await stripe.oauth.token({
      grant_type: 'authorization_code',
      code,
    });

    const stripeAccountId = response.stripe_user_id;

    if (!stripeAccountId) {
      return reply.status(500).send({ success: false, message: 'Stripe did not return an account ID.' });
    }

    // Fetch live status from Stripe immediately
    const account = await stripe.accounts.retrieve(stripeAccountId);

    // Persist the connected account ID + initial status
    await prisma.sellerProfile.update({
      where: { userId },
      data: {
        stripeAccountId,
        stripeOnboardingComplete: account.details_submitted,
        stripeChargesEnabled:     account.charges_enabled,
        stripePayoutsEnabled:     account.payouts_enabled,
        stripeKycStatus:          account.charges_enabled ? 'verified' : account.details_submitted ? 'pending' : 'unverified',
        stripeAbnProvided:        account.company?.tax_id_provided || false,
        stripeBankConnected:      (account.external_accounts?.total_count || 0) > 0,
      },
    });


    return reply.status(200).send({
      success: true,
      message: 'Stripe account connected successfully.',
      stripeAccountId,
      stripeChargesEnabled: account.charges_enabled,
      stripePayoutsEnabled: account.payouts_enabled,
      stripeOnboardingComplete: account.details_submitted,
    });
  } catch (error) {
    console.error('handleOAuthCallback error:', error);
    return reply.status(500).send({ success: false, message: 'Failed to complete Stripe connection.', detail: error.message });
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

    // KYC verification status — charges_enabled is the reliable readiness signal
    // for whether this connected account can accept charges/transfers.
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

  if (!webhookSecret) {
    console.error("⚠️  STRIPE_CONNECT_WEBHOOK_SECRET is not set — rejecting webhook");
    return reply.status(400).send({ error: "Webhook secret not configured" });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(request.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("Stripe Connect webhook signature error:", err.message);
    return reply.status(400).send({ error: `Webhook error: ${err.message}` });
  }

  // ── account.updated ────────────────────────────────────────────────────────
  if (event.type === "account.updated") {
    const account = event.data.object;

    try {
      let stripeKycStatus;
      if (account.charges_enabled) {
        stripeKycStatus = "verified";
      } else if (account.details_submitted) {
        stripeKycStatus = "pending";
      } else {
        stripeKycStatus = "unverified";
      }

      // Fetch existing record to detect the charges_enabled flip
      const existing = await prisma.sellerProfile.findFirst({
        where: { stripeAccountId: account.id },
        select: {
          stripeChargesEnabled: true,
          user: { select: { email: true, name: true } },
        },
      });

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


      // Fire the "you're approved" email the FIRST time charges_enabled flips to true
      if (account.charges_enabled && existing && !existing.stripeChargesEnabled) {
        const email = existing.user?.email;
        const name  = existing.user?.name || "Seller";
        if (email) {
          sendSellerStripeApprovedEmail(email, name).catch((e) =>
            console.error("sendSellerStripeApprovedEmail error:", e.message)
          );
        }
      }
    } catch (err) {
      console.error("Stripe Connect webhook DB update error:", err.message);
    }
  }

  // ── charge.dispute.created ─────────────────────────────────────────────────
  // A customer filed a chargeback. Reverse the seller transfer immediately so
  // the platform doesn't go negative, and alert the admin.
  else if (event.type === "charge.dispute.created") {
    const dispute = event.data.object;
    const chargeId = dispute.charge;

    try {
      // Retrieve the charge to get the payment_intent
      const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null;
      const piId    = charge?.payment_intent;

      let disputedOrder = null;
      if (piId) {
        disputedOrder = await prisma.order.findFirst({
          where: { stripePaymentIntentId: piId },
          include: { user: { select: { email: true } } },
        });
      }

      // Reverse any seller transfer tied to this order
      if (disputedOrder) {
        const commissionsToReverse = await prisma.$queryRaw`
          SELECT id, stripe_transfer_id
          FROM commission_earned
          WHERE order_id              = ${disputedOrder.id}
            AND stripe_transfer_id    IS NOT NULL
            AND stripe_transfer_status = 'transferred'
        `;

        for (const rec of commissionsToReverse) {
          try {
            await stripe.transfers.createReversal(rec.stripe_transfer_id, {
              metadata: { reason: "chargeback_dispute", orderId: disputedOrder.id, disputeId: dispute.id },
            });
            await prisma.$executeRaw`
              UPDATE commission_earned
              SET stripe_transfer_status = 'reversed',
                  status                 = 'CANCELLED'::"CommissionStatus",
                  updated_at             = NOW()
              WHERE id = ${rec.id}
            `;
          } catch (reverseErr) {
            console.error(`❌ Transfer reversal failed for dispute (commissionId: ${rec.id}):`, reverseErr.message);
          }
        }
      }

      // Alert admin
      const adminEmail = process.env.FINANCE_EMAIL_RECEIVER || process.env.ADMIN_EMAIL || 'admin@madeinarnhemland.com.au';
      await sendDisputeAlertEmail({
        adminEmail,
        adminName: "Admin",
        disputeId: dispute.id,
        amount: dispute.amount,
        currency: dispute.currency,
        reason: dispute.reason,
        orderId: disputedOrder?.id || null,
        orderDisplayId: disputedOrder?.displayId || null,
        chargeId,
        customerEmail: charge?.billing_details?.email || disputedOrder?.user?.email || null,
      });

    } catch (err) {
      console.error("Stripe Connect dispute handler error:", err.message);
    }
  }

  // ── charge.dispute.funds_withdrawn ─────────────────────────────────────────
  // Stripe has withdrawn funds from the platform balance for the dispute.
  else if (event.type === "charge.dispute.funds_withdrawn") {
    const dispute = event.data.object;
  }

  // ── charge.dispute.closed ──────────────────────────────────────────────────
  // Dispute resolved. If won, funds returned; if lost, record the outcome.
  else if (event.type === "charge.dispute.closed") {
    const dispute = event.data.object;
  }

  else {
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
// Standard accounts log in at stripe.com directly.
// This endpoint just confirms the account is connected and returns the URL.
// ─────────────────────────────────────────────────────────────────────────────
exports.getSellerLoginLink = async (request, reply) => {
  try {
    const userId = request.user.userId;

    const profile = await prisma.sellerProfile.findUnique({
      where: { userId },
      select: { stripeAccountId: true, stripeOnboardingComplete: true },
    });

    if (!profile?.stripeAccountId) {
      return reply.status(400).send({
        success: false,
        message: 'No Stripe account linked. Please complete Stripe Connect onboarding first.'
      });
    }

    // Standard accounts — seller logs in at stripe.com with their own credentials.
    // No login-link API call needed.
    return reply.send({
      success: true,
      url: 'https://dashboard.stripe.com/login',
      dashboardType: 'standard',
      message: 'Log in at stripe.com with the email you used during Stripe Connect setup.',
      stripeAccountId: profile.stripeAccountId,
    });
  } catch (err) {
    console.error('❌ getSellerLoginLink error:', err);
    return reply.status(500).send({ success: false, message: 'Failed to get Stripe login info.' });
  }
};

// new