# Stripe Go-Live Checklist — Made in Arnhem Land

> **Purpose**: Everything you need to update when switching from Stripe **Test Mode** to **Live Mode**.

---

## 1. Environment Variables to Update

You need to update **5 values** in your `.env` (on Render or wherever you deploy):

| Variable | Where to get it | Current (Test) | Live Format |
|----------|----------------|----------------|-------------|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API Keys | `sk_test_51SzBii...` | `sk_live_51SzBii...` |
| `STRIPE_PUBLISHABLE_KEY` | Stripe Dashboard → Developers → API Keys | `pk_test_51SzBii...` | `pk_live_51SzBii...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers → Webhooks (create new live endpoint) | `whsec_Vm6tmO0P...` | `whsec_...` (new value) |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Stripe Dashboard → Developers → Webhooks (create new live Connect endpoint) | `whsec_kvJf0bUH...` | `whsec_...` (new value) |
| `STRIPE_CLIENT_ID` | Stripe Dashboard → Settings → Connect → Platform Settings | `ca_UUmqrb4Oi5...` | `ca_...` (live value) |

### Steps to get each key:

### 1a. API Keys (`STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY`)
1. Go to [https://dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)
2. **Toggle OFF** the "Test mode" switch (top-right of the dashboard)
3. Copy the **Publishable key** → `STRIPE_PUBLISHABLE_KEY`
4. Click **Reveal live key** → copy → `STRIPE_SECRET_KEY`

### 1b. Webhook Secret (`STRIPE_WEBHOOK_SECRET`)
1. Go to [https://dashboard.stripe.com/webhooks](https://dashboard.stripe.com/webhooks)
2. Make sure you are in **Live mode** (not test)
3. Click **Add endpoint**
4. Endpoint URL: `https://your-api-domain.com/api/payments/webhook`
5. Select these events:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.refunded`
   - `charge.dispute.created`
6. Click **Add endpoint**
7. Click **Reveal** on the Signing secret → copy → `STRIPE_WEBHOOK_SECRET`

### 1c. Connect Webhook Secret (`STRIPE_CONNECT_WEBHOOK_SECRET`)
1. Same webhooks page, click **Add endpoint** again
2. Endpoint URL: `https://your-api-domain.com/api/payments/connect-webhook`
3. **Important**: Toggle "Listen to events on **Connected accounts**"
4. Select these events:
   - `account.updated`
   - `charge.dispute.created`
   - `charge.dispute.funds_withdrawn`
   - `charge.dispute.closed`
5. Click **Add endpoint**
6. Reveal signing secret → copy → `STRIPE_CONNECT_WEBHOOK_SECRET`

### 1d. Connect Client ID (`STRIPE_CLIENT_ID`)
1. Go to [https://dashboard.stripe.com/settings/connect](https://dashboard.stripe.com/settings/connect)
2. Make sure you are in **Live mode**
3. Under **Integration** → copy the **Live mode client ID** → `STRIPE_CLIENT_ID`

---

## 2. Frontend Update

Update the frontend `.env` file:

| Variable | Value |
|----------|-------|
| `VITE_STRIPE_PUBLISHABLE_KEY` | Your new `pk_live_...` key |

This is the only frontend change needed.

---

## 3. Files That Use Stripe (No Code Changes Needed)

These files read from `process.env` — they automatically use whatever keys you set. **No code changes required.**

| File | What it does |
|------|-------------|
| `controllers/payment.js` | Main payment processing, webhook handler |
| `controllers/orders.js` | Refund/cancel operations |
| `controllers/stripeConnect.js` | Seller Connect onboarding, Connect webhook |

---

## 4. Stripe Dashboard Setup (Live Mode)

Before going live, verify these are configured in your **Live mode** Stripe Dashboard:

### 4a. Connect Settings
- Go to **Settings → Connect → Platform Settings**
- Set your platform name, icon, and brand color
- Set the **Redirect URI** to: `https://www.madeinarnhemland.com.au/seller/stripe/callback`
- Make sure **Standard accounts** are enabled
- Set country to **Australia** and currency to **AUD**

### 4b. Branding
- Go to **Settings → Branding**
- Upload your logo and set brand colors (used on Stripe-hosted pages)

### 4c. Business Details
- Go to **Settings → Business details**
- Make sure your ABN, address, and business info are complete
- This is required for live payouts

### 4d. Payout Schedule
- Go to **Settings → Payouts**
- Set your preferred payout schedule (daily, weekly, etc.)

---

## 5. Pre-Go-Live Testing Checklist

Before switching to live keys, verify these work in test mode:

- [ ] Customer can complete a payment (card checkout)
- [ ] Webhook receives `payment_intent.succeeded` and order status updates to PAID
- [ ] Failed payment webhook cancels the order and restores stock
- [ ] Seller can connect their Stripe account via OAuth
- [ ] Connect webhook receives `account.updated` and syncs seller status
- [ ] Refund processes correctly and reverses seller transfers
- [ ] Commission records are created after successful payment
- [ ] Seller transfers are created after order payment

---

## 6. Go-Live Steps (In Order)

1. **Complete all Stripe Dashboard setup** (Section 4 above)
2. **Create live webhook endpoints** in Stripe Dashboard (Section 1b + 1c)
3. **Update backend `.env`** on Render with all 5 live values
4. **Update frontend `.env`** with the live publishable key
5. **Redeploy** both backend and frontend
6. **Test with a real card** — make a small purchase (e.g., $1 product)
7. **Verify the webhook fires** — check Stripe Dashboard → Webhooks → see the event delivered
8. **Verify seller transfer** — if the test order has a seller, check their Stripe balance
9. **Test a refund** — refund the test order, verify stock restores

---

## 7. Rollback Plan

If something goes wrong after switching to live:
1. Replace live keys with test keys in Render `.env`
2. Redeploy
3. You're back in test mode — no real charges will process

---

## Summary: What Changes Where

| Location | What to update |
|----------|---------------|
| **Render Backend .env** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_CLIENT_ID` |
| **Frontend .env** | `VITE_STRIPE_PUBLISHABLE_KEY` |
| **Stripe Dashboard (Live)** | Create 2 webhook endpoints, configure Connect settings |
| **Backend code** | Nothing — no code changes needed |
| **Frontend code** | Nothing — no code changes needed |
