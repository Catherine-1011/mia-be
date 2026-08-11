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
const crypto = require("crypto");

const Stripe = require("stripe");
const prisma = require("../config/prisma");
const { sendSellerStripeApprovedEmail, sendDisputeAlertEmail } = require("../utils/emailService");
const { createNotification } = require("./notification");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const STRIPE_WEBHOOK_PROCESSING_TIMEOUT_MS =
  Number(process.env.STRIPE_WEBHOOK_PROCESSING_TIMEOUT_MS || 10 * 60 * 1000);

function extractPaymentIntentIdFromStripeEvent(event) {
  const object = event?.data?.object || {};
  if (event?.type?.startsWith("payment_intent.")) return object.id || null;
  if (event?.type?.startsWith("charge.") && !event.type.startsWith("charge.dispute.")) {
    return object.payment_intent || null;
  }
  if (event?.type?.startsWith("charge.dispute.")) {
    return object.payment_intent || null;
  }
  return null;
}

function isUniqueConstraintError(error) {
  return error?.code === "P2002";
}

function formatStripeAmount(amount, currency = "aud") {
  const major = Number(amount || 0) / 100;
  return `${currency.toUpperCase()} ${major.toFixed(2)}`;
}

async function findExistingPayoutRequestForStripePayout(payout, stripeAccountId) {
  if (!stripeAccountId || !payout?.id) return null;

  const sellerProfile = await prisma.sellerProfile.findFirst({
    where: { stripeAccountId },
    select: {
      userId: true,
      storeName: true,
      businessName: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

  if (!sellerProfile?.userId) {
    console.log("[Stripe Connect payout] No seller profile found for connected account", {
      stripeAccountId,
      payoutId: payout.id,
    });
    return null;
  }

  const amountMajor = Number(payout.amount || 0) / 100;
  const payoutRequest = await prisma.payoutRequest.findFirst({
    where: {
      sellerId: sellerProfile.userId,
      requestedAmount: amountMajor,
      status: { in: ["PENDING", "APPROVED"] },
    },
    orderBy: { createdAt: "desc" },
  });

  return payoutRequest ? { payoutRequest, sellerProfile } : { payoutRequest: null, sellerProfile };
}

async function recordPayoutPaidIfExisting(payout, stripeAccountId) {
  const match = await findExistingPayoutRequestForStripePayout(payout, stripeAccountId);
  if (!match?.payoutRequest) {
    console.log("[Stripe Connect payout.paid] No existing payout request matched; log only", {
      payoutId: payout.id,
      stripeAccountId,
      amount: payout.amount,
      currency: payout.currency,
    });
    return null;
  }

  const adminNote = [
    match.payoutRequest.adminNote,
    `Stripe payout paid: ${payout.id} (${formatStripeAmount(payout.amount, payout.currency)})`,
  ].filter(Boolean).join("\n");

  return prisma.payoutRequest.update({
    where: { id: match.payoutRequest.id },
    data: {
      status: "COMPLETED",
      processedAt: payout.arrival_date ? new Date(payout.arrival_date * 1000) : new Date(),
      adminNote,
    },
  });
}

async function notifyPayoutFailedIfAvailable({ payout, stripeAccountId, sellerProfile, payoutRequest }) {
  if (!createNotification) return;

  const amountText = formatStripeAmount(payout.amount, payout.currency);
  const failureMessage = payout.failure_message || payout.failure_code || "Stripe reported the payout failed.";
  const metadata = {
    stripePayoutId: payout.id,
    stripeAccountId,
    amount: payout.amount,
    currency: payout.currency,
    failureCode: payout.failure_code || null,
    failureMessage: payout.failure_message || null,
  };

  try {
    const admins = await prisma.user.findMany({
      where: { role: { in: ["ADMIN", "SUPER_ADMIN"] } },
      select: { id: true },
    });

    for (const admin of admins) {
      await createNotification(
        admin.id,
        "Stripe payout failed",
        `Stripe payout ${payout.id} failed for ${sellerProfile?.user?.name || sellerProfile?.storeName || "seller"} (${amountText}). ${failureMessage}`,
        "GENERAL",
        payoutRequest?.id || payout.id,
        payoutRequest ? "payout_request" : "stripe_payout",
        metadata,
      );
    }

    if (sellerProfile?.userId) {
      await createNotification(
        sellerProfile.userId,
        "Payout failed",
        `A Stripe payout for ${amountText} failed. Please review your Stripe payout details or contact support.`,
        "GENERAL",
        payoutRequest?.id || payout.id,
        payoutRequest ? "payout_request" : "stripe_payout",
        metadata,
      );
    }
  } catch (err) {
    console.error("[Stripe Connect payout.failed] Notification error:", err.message);
  }
}

async function recordPayoutFailedIfExisting(payout, stripeAccountId) {
  const match = await findExistingPayoutRequestForStripePayout(payout, stripeAccountId);
  const failureDetail = payout.failure_message || payout.failure_code || "unknown failure";

  if (!match?.payoutRequest) {
    console.log("[Stripe Connect payout.failed] No existing payout request matched; log only", {
      payoutId: payout.id,
      stripeAccountId,
      amount: payout.amount,
      currency: payout.currency,
      failureCode: payout.failure_code,
      failureMessage: payout.failure_message,
    });
    await notifyPayoutFailedIfAvailable({
      payout,
      stripeAccountId,
      sellerProfile: match?.sellerProfile,
      payoutRequest: null,
    });
    return null;
  }

  const adminNote = [
    match.payoutRequest.adminNote,
    `Stripe payout failed: ${payout.id} (${formatStripeAmount(payout.amount, payout.currency)}). ${failureDetail}`,
  ].filter(Boolean).join("\n");

  const updated = await prisma.payoutRequest.update({
    where: { id: match.payoutRequest.id },
    data: { adminNote },
  });

  await notifyPayoutFailedIfAvailable({
    payout,
    stripeAccountId,
    sellerProfile: match.sellerProfile,
    payoutRequest: match.payoutRequest,
  });

  return updated;
}

async function claimStripeWebhookEvent(event) {
  const staleBefore = new Date(Date.now() - STRIPE_WEBHOOK_PROCESSING_TIMEOUT_MS);
  const paymentIntentId = extractPaymentIntentIdFromStripeEvent(event);
  try {
    await prisma.stripeWebhookEvent.create({
      data: {
        eventId: event.id,
        eventType: event.type,
        stripeAccountId: event.account || null,
        paymentIntentId,
        status: "RECEIVED",
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }

  const claimed = await prisma.stripeWebhookEvent.updateMany({
    where: {
      eventId: event.id,
      OR: [
        { status: { in: ["RECEIVED", "FAILED"] } },
        { status: "PROCESSING", updatedAt: { lt: staleBefore } },
      ],
    },
    data: {
      status: "PROCESSING",
      attemptCount: { increment: 1 },
      lastError: null,
      stripeAccountId: event.account || null,
      paymentIntentId,
    },
  });

  if (claimed.count === 1) return { shouldProcess: true };

  const existing = await prisma.stripeWebhookEvent.findUnique({
    where: { eventId: event.id },
    select: { status: true },
  });
  return { shouldProcess: false, status: existing?.status || "PROCESSING" };
}

async function markStripeWebhookEventProcessed(eventId) {
  await prisma.stripeWebhookEvent.update({
    where: { eventId },
    data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
  });
}

async function markStripeWebhookEventFailed(eventId, error) {
  await prisma.stripeWebhookEvent.update({
    where: { eventId },
    data: {
      status: "FAILED",
      lastError: String(error?.message || error).slice(0, 4000),
    },
  });
}

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

  try {
    const claim = await claimStripeWebhookEvent(event);
    if (!claim.shouldProcess) {
      return reply.status(200).send({
        received: true,
        duplicate: claim.status === "PROCESSED",
        processing: claim.status === "PROCESSING",
      });
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
      throw err;
    }
  }

  // ── charge.dispute.created ─────────────────────────────────────────────────
  // Observational connected-account payout events.
  else if (event.type === "payout.paid") {
    const payout = event.data.object;
    const stripeAccountId = event.account || null;

    console.log("[Stripe Connect payout.paid]", {
      payoutId: payout.id,
      stripeAccountId,
      amount: payout.amount,
      currency: payout.currency,
      arrivalDate: payout.arrival_date || null,
      status: payout.status,
    });

    await recordPayoutPaidIfExisting(payout, stripeAccountId);
  }

  else if (event.type === "payout.failed") {
    const payout = event.data.object;
    const stripeAccountId = event.account || null;

    console.error("[Stripe Connect payout.failed]", {
      payoutId: payout.id,
      stripeAccountId,
      amount: payout.amount,
      currency: payout.currency,
      failureCode: payout.failure_code || null,
      failureMessage: payout.failure_message || null,
      status: payout.status,
    });

    await recordPayoutFailedIfExisting(payout, stripeAccountId);
  }

  // A customer filed a chargeback. Reverse the seller transfer immediately so
  // the platform doesn't go negative, and alert the admin.
  else if (event.type === "charge.dispute.created") {
    const dispute = event.data.object;
    const chargeId = dispute.charge;

    try {
      // Retrieve the charge to get the payment_intent
      const charge = chargeId
        ? await stripe.charges.retrieve(
            chargeId,
            event.account ? { stripeAccount: event.account } : undefined,
          )
        : null;
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
            await stripe.transfers.createReversal(
              rec.stripe_transfer_id,
              { metadata: { reason: "chargeback_dispute", orderId: disputedOrder.id, disputeId: dispute.id } },
              { idempotencyKey: `connect-dispute-reversal:${dispute.id}:${rec.id}` },
            );
            await prisma.$executeRaw`
              UPDATE commission_earned
              SET stripe_transfer_status = 'reversed',
                  status                 = 'CANCELLED'::"CommissionStatus",
                  updated_at             = NOW()
              WHERE id = ${rec.id}
            `;
          } catch (reverseErr) {
            console.error(`❌ Transfer reversal failed for dispute (commissionId: ${rec.id}):`, reverseErr.message);
            throw reverseErr;
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
      throw err;
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

  await markStripeWebhookEventProcessed(event.id);
  return reply.status(200).send({ received: true });
  } catch (error) {
    console.error("Stripe Connect webhook processing error:", error.message);
    if (event?.id) {
      try {
        await markStripeWebhookEventFailed(event.id, error);
      } catch (markError) {
        console.error("Failed to mark Stripe Connect webhook event FAILED:", markError.message);
      }
    }
    return reply.status(500).send({ error: "Webhook processing failed" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. Admin: Trigger a legacy/manual Stripe Transfer to a seller's connected account.
//    New Direct Charge checkout does not use this helper.
//    amount is in AUD dollars (not cents).
// ─────────────────────────────────────────────────────────────────────────────
async function createLegacySellerTransfer(sellerUserId, amountAUD, description = "Legacy seller transfer") {
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

  const transfer = await stripe.transfers.create(
    {
      amount: amountInCents,
      currency: "aud",
      destination: profile.stripeAccountId,
      description,
      metadata: {
        sellerUserId,
      },
    },
    { idempotencyKey: `connect-manual-transfer:${sellerUserId}:${amountInCents}:${crypto.createHash("sha256").update(description || "").digest("hex").slice(0, 16)}` },
  );

  return transfer;
}

exports.createLegacySellerTransfer = createLegacySellerTransfer;
exports.createSellerTransfer = createLegacySellerTransfer;

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
