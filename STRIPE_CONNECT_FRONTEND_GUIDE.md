# Stripe Connect — Frontend Implementation Guide
## Australian Seller Onboarding

---

## The Big Question: What Does Stripe Handle vs Your Platform?

When a seller clicks "Connect with Stripe" and is redirected to Stripe's hosted page, **Stripe automatically collects and verifies:**

| Step (current platform) | Handled by Stripe? | Notes |
|---|---|---|
| Business Details (name, ABN, address, type) | ✅ YES — Stripe collects these | Stripe calls it "Business information" |
| Identity Verification (government ID, selfie) | ✅ YES — Stripe collects these | Stripe calls it "Personal details / Identity" |
| Bank Account (BSB + account number) | ✅ YES — Stripe collects these | For Australian accounts — BSB + account |
| Tax info (TFN / ABN) | ✅ YES — for AU | Stripe handles tax reporting compliance |
| Stripe's Terms of Service | ✅ YES — Stripe presents these | Seller must accept on Stripe's page |

**What your platform still keeps:**

| Step | Your Platform Handles | Why |
|---|---|---|
| Email + Phone + Contact Person | ✅ Your platform | Account creation, notifications |
| Store Profile (name, description, logo) | ✅ Your platform | Marketplace display data |
| KYC (your own document upload) | ✅ Optional — keep or remove | Admin-level compliance review |
| Product uploads (minimum 5) | ✅ Your platform | Marketplace readiness check |
| Admin approval | ✅ Your platform | You control who goes live |

> **In short:** Remove "Business Details" and "Bank Details" steps from your onboarding form.  
> Replace them with a single "Set up payouts" Stripe button. Stripe's hosted page will walk the seller through everything — identity, ABN, bank account — in a compliant Australian flow.

---

## New Onboarding Step Flow

```
OLD:  Step 1 → Step 2 → Step 3 (Business) → Step 4 → Step 5 (Store) → Step 6 (KYC) → Step 7 (Bank) → Step 8 (Submit)
NEW:  Step 1 → Step 2 →                      Step 3 → Step 4 (Store) →               → Step 5 (Stripe Connect) → Step 6 (Submit)
```

| Step | Name | Who handles |
|---|---|---|
| 1 | Email + OTP | Your platform |
| 2 | Password setup | Your platform |
| 3 | Cultural Identity | Your platform |
| 4 | Store Profile (name, logo, description) | Your platform |
| 5 | **Connect Stripe Account** | **Stripe (hosted page)** |
| 6 | Submit for admin review | Your platform |

---

## API Reference

Base URL: `https://your-api.com/api/seller-onboarding`  
All `/stripe/*` routes require the seller JWT in `Authorization: Bearer <token>`

### 1. Create Stripe Express Account (call once)
```
POST /stripe/connect
Authorization: Bearer <seller_token>
```
**Response (success):**
```json
{
  "success": true,
  "message": "Stripe Connect account created",
  "stripeAccountId": "acct_1AbcXXXXXXXXXXXX"
}
```
**Response (already exists):**
```json
{
  "success": true,
  "message": "Stripe account already connected",
  "stripeAccountId": "acct_1AbcXXXXXXXXXXXX",
  "stripeOnboardingComplete": false,
  "stripeChargesEnabled": false,
  "stripePayoutsEnabled": false
}
```

---

### 2. Get Stripe Onboarding URL
```
POST /stripe/onboarding-link
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "returnUrl":  "https://yoursite.com/seller/dashboard?stripe=success",
  "refreshUrl": "https://yoursite.com/seller/onboarding/payouts?stripe=refresh"
}
```
**Response:**
```json
{
  "success": true,
  "url": "https://connect.stripe.com/setup/e/acct_xxx/...",
  "expiresAt": 1748234567
}
```
> ⚠️ `url` expires in ~24 hours. Always call this fresh — never store the URL.

---

### 3. Check Stripe Connect Status
```
GET /stripe/status
Authorization: Bearer <seller_token>
```
**Response:**
```json
{
  "success": true,
  "connected": true,
  "stripeAccountId": "acct_1AbcXXXXXXXXXXXX",
  "stripeOnboardingComplete": true,
  "stripeChargesEnabled": true,
  "stripePayoutsEnabled": true,
  "requirements": [],
  "eventuallyDue": []
}
```

| Field | Meaning |
|---|---|
| `connected: false` | Seller has never clicked Connect |
| `stripeOnboardingComplete: false` | Seller started but didn't finish |
| `stripeOnboardingComplete: true` | Seller submitted all info to Stripe |
| `stripeChargesEnabled: true` | Stripe verified — seller can receive transfers |
| `requirements: ["individual.id_number"]` | Stripe still needs something from the seller |

---

## Frontend Implementation

### Step 5 — Stripe Connect Component

```jsx
// StripeConnectStep.jsx

import { useState } from "react";

export default function StripeConnectStep({ token, onComplete }) {
  const [status, setStatus] = useState(null); // null | "loading" | "redirecting" | "done" | "error"
  const [connectStatus, setConnectStatus] = useState(null);

  // Check status on mount
  useEffect(() => {
    checkStatus();
  }, []);

  // Also check status when user returns from Stripe (stripe=success in URL)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("stripe") === "success") {
      checkStatus();
    }
  }, []);

  async function checkStatus() {
    setStatus("loading");
    try {
      const res = await fetch("/api/seller-onboarding/stripe/status", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setConnectStatus(data);

      if (data.stripeOnboardingComplete && data.stripeChargesEnabled) {
        setStatus("done");
        onComplete?.(); // notify parent to move to next step
      } else {
        setStatus(null);
      }
    } catch {
      setStatus("error");
    }
  }

  async function handleConnectStripe() {
    setStatus("loading");
    try {
      // Step 1: create account (idempotent — safe to call multiple times)
      await fetch("/api/seller-onboarding/stripe/connect", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      // Step 2: get onboarding link
      const res = await fetch("/api/seller-onboarding/stripe/onboarding-link", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          returnUrl:  `${window.location.origin}/seller/dashboard?stripe=success`,
          refreshUrl: `${window.location.origin}/seller/onboarding/payouts?stripe=refresh`,
        }),
      });

      const { url } = await res.json();

      // Step 3: redirect seller to Stripe's hosted onboarding
      setStatus("redirecting");
      window.location.href = url;

    } catch (err) {
      setStatus("error");
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Fully set up
  if (status === "done" || (connectStatus?.stripeOnboardingComplete && connectStatus?.stripeChargesEnabled)) {
    return (
      <div className="stripe-success">
        <span className="checkmark">✓</span>
        <h3>Payout account connected</h3>
        <p>Your Australian bank account is verified through Stripe. You'll receive payouts when orders are processed.</p>
      </div>
    );
  }

  // Started but incomplete — Stripe still needs info
  if (connectStatus?.connected && !connectStatus?.stripeOnboardingComplete) {
    const needsMore = connectStatus.requirements?.length > 0;
    return (
      <div className="stripe-incomplete">
        <h3>Almost there — Stripe needs a bit more info</h3>
        {needsMore && (
          <p>Stripe is waiting on: <strong>{connectStatus.requirements.join(", ")}</strong></p>
        )}
        <button onClick={handleConnectStripe} disabled={status === "loading" || status === "redirecting"}>
          {status === "loading" ? "Loading..." : "Continue Stripe setup →"}
        </button>
      </div>
    );
  }

  // Not connected yet
  return (
    <div className="stripe-connect-step">
      <h3>Set up your payout account</h3>
      <p>
        We use <strong>Stripe</strong> to securely collect your identity and Australian bank account details.
        This is required before you can receive payments.
      </p>

      <div className="stripe-handles">
        <p><strong>Stripe will collect:</strong></p>
        <ul>
          <li>Your full legal name and date of birth</li>
          <li>Government-issued ID (passport or driver licence)</li>
          <li>Your ABN or business registration (if applicable)</li>
          <li>Your Australian bank account (BSB + account number)</li>
        </ul>
      </div>

      <button
        className="btn-stripe-connect"
        onClick={handleConnectStripe}
        disabled={status === "loading" || status === "redirecting"}
      >
        {status === "loading"   && "Setting up..."}
        {status === "redirecting" && "Redirecting to Stripe..."}
        {!status && "Connect with Stripe →"}
      </button>

      <p className="stripe-notice">
        You'll be redirected to Stripe's secure website.
        Your bank details are never stored on our servers.
      </p>
    </div>
  );
}
```

---

### Handle Return URL

When Stripe redirects the seller back to your `returnUrl` (e.g. `/seller/dashboard?stripe=success`), check the status:

```jsx
// In your dashboard or onboarding page

useEffect(() => {
  const params = new URLSearchParams(window.location.search);

  if (params.get("stripe") === "success") {
    // Clean up URL
    window.history.replaceState({}, "", window.location.pathname);
    
    // Check status with backend
    fetchStripeStatus().then((status) => {
      if (status.stripeOnboardingComplete) {
        showNotification("Payout account connected successfully!");
      } else if (status.requirements?.length > 0) {
        showNotification("Stripe still needs some information. Please complete the setup.", "warning");
      }
    });
  }

  if (params.get("stripe") === "refresh") {
    // AccountLink expired — generate a new one and redirect
    window.history.replaceState({}, "", window.location.pathname);
    regenerateStripeLink(); // calls POST /stripe/onboarding-link again
  }
}, []);
```

---

## Seller Dashboard — Payout Status Widget

```jsx
// StripePayoutStatus.jsx — show in seller dashboard sidebar

export function StripePayoutStatus({ token }) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    fetch("/api/seller-onboarding/stripe/status", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then(setStatus);
  }, []);

  if (!status) return null;

  if (!status.connected) {
    return (
      <div className="payout-widget warning">
        <strong>⚠ Payout account not set up</strong>
        <p>You need to connect your bank account before you can receive payouts.</p>
        <a href="/seller/onboarding/payouts">Set up now →</a>
      </div>
    );
  }

  if (status.stripeOnboardingComplete && status.stripeChargesEnabled) {
    return (
      <div className="payout-widget success">
        <strong>✓ Payouts active</strong>
        <p>Your Australian bank account is connected via Stripe.</p>
      </div>
    );
  }

  if (status.requirements?.length > 0) {
    return (
      <div className="payout-widget warning">
        <strong>⚠ Action required by Stripe</strong>
        <p>Stripe needs more information to activate your payouts.</p>
        <button onClick={() => regenerateAndRedirect(token)}>
          Complete Stripe setup →
        </button>
      </div>
    );
  }

  return (
    <div className="payout-widget pending">
      <strong>⏳ Stripe review in progress</strong>
      <p>Stripe is reviewing your information. This usually takes 1–2 business days.</p>
    </div>
  );
}
```

---

## What the Stripe Hosted Page Looks Like (AU)

When the seller lands on Stripe's page they will see these sections **in order**:

```
1. Personal details
   └─ Legal first and last name
   └─ Date of birth
   └─ Home address (Australia)

2. Identity verification
   └─ Upload: Australian passport OR driver licence
   └─ Stripe verifies automatically (usually instant)

3. Business information  ← replaces your "Business Details" step
   └─ ABN (Australian Business Number)
   └─ Business name (if applicable)
   └─ Business address

4. Bank account  ← replaces your "Bank Details" step
   └─ BSB number
   └─ Account number
   └─ Account holder name

5. Stripe Terms of Service
   └─ Seller accepts Stripe's ToS
```

---

## Environment Variables Needed

Add to both backend `.env` and your deployment (Render / Railway / etc):

```
# Already exists — for payment processing:
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# New — for Stripe Connect account events:
STRIPE_CONNECT_WEBHOOK_SECRET=whsec_...    ← get from Stripe Dashboard

# Already in backend — needed for onboarding link redirect URLs:
FRONTEND_URL=https://yourfrontend.com
```

---

## Stripe Dashboard Setup (One-time)

1. Go to [Stripe Dashboard → Settings → Connect](https://dashboard.stripe.com/settings/connect)
2. Enable **Express** accounts
3. Set your platform name, icon, and brand color (sellers see this on Stripe's page)
4. Go to **Webhooks → Add endpoint**
   - URL: `https://your-api.com/api/payments/connect-webhook`
   - Select: **Connect** (not Standard)
   - Events: `account.updated`
5. Copy the signing secret → set as `STRIPE_CONNECT_WEBHOOK_SECRET` in `.env`

---

## Local Testing with Stripe CLI

```bash
# Terminal 1 — run your backend
nodemon server.js

# Terminal 2 — forward connect webhooks
stripe listen \
  --forward-connect-to localhost:5000/api/payments/connect-webhook \
  --events account.updated

# To simulate a seller completing onboarding:
stripe trigger account.updated
```
