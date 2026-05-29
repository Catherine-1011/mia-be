# Seller Onboarding — Frontend Changes for Stripe Connect
## What to Change, What to Keep, Exact API Calls

---

## Old Flow vs New Flow

```
OLD (8 steps)                          NEW (7 steps)
─────────────────────────────────      ─────────────────────────────────
Step 1 → Apply (email, phone)          Step 1 → Apply (email, phone)        ✅ unchanged
Step 2 → OTP + Set Password            Step 2 → OTP + Set Password          ✅ unchanged
Step 3 → Business Details (ABN etc.)   Step 3 → Business Details (ABN etc.) ✅ KEEP — Stripe uses this data to pre-fill
Step 4 → Cultural Identity             Step 4 → Cultural Identity            ✅ unchanged
Step 5 → Store Profile (logo etc.)     Step 5 → Store Profile (logo etc.)   ✅ unchanged
Step 6 → KYC Documents                 ❌ REMOVED — Stripe handles identity
Step 7 → Bank Details (BSB/account)    Step 6 → Connect Stripe Account      🔄 REPLACED with Stripe button
Step 8 → Submit for Review             Step 7 → Submit for Review           ✅ unchanged
```

**Summary of changes:**
- ❌ **Remove**: KYC Documents upload step entirely
- 🔄 **Replace**: Bank Details form with a single "Connect with Stripe" button
- ✅ **Add**: Return URL handler (when Stripe redirects seller back)
- ✅ **Add**: Stripe status badge in seller dashboard

---

## Step-by-Step — What Each Step Now Does

---

### Step 1 — Apply as Seller
**No change needed.**

```
POST /api/seller-onboarding/apply

Body:
{
  "email":         "seller@email.com",
  "phone":         "0412345678",
  "contactPerson": "Jane Smith"
}

Response:
{
  "success": true,
  "message": "OTP sent to your email.",
  "email": "seller@email.com"
}
```

---

### Step 2 — Verify OTP & Set Password
**No change needed.**

```
POST /api/seller-onboarding/verify-otp

Body:
{
  "email":    "seller@email.com",
  "otp":      "123456",
  "password": "SecurePass123!"
}

Response:
{
  "success": true,
  "token": "eyJhbGci...",        ← save this as seller JWT
  "user": { "id": "...", ... },
  "sellerProfile": { "id": "...", "onboardingStep": 2, ... }
}
```
> 💾 Save `token` to localStorage — needed for all subsequent API calls.

---

### Step 3 — Business Details
**✅ KEEP THIS STEP — do not remove it.**  
This data is saved to your DB and then used to pre-fill Stripe's onboarding form.

```
POST /api/seller-onboarding/business-details
Authorization: Bearer <token>

Body:
{
  "businessName":    "Smith Art Co.",
  "abn":             "51 824 753 556",
  "businessAddress": {
    "line1":      "12 Main Street",
    "city":       "Darwin",
    "state":      "NT",
    "zipCode":    "0800",
    "country":    "AU"
  },
  "businessType":    "sole_trader",   // or "company", "partnership"
  "yearsInBusiness": 3
}

Response:
{
  "success": true,
  "message": "Business details submitted successfully",
  "sellerProfile": { ... }
}
```

**ABN validation (call before submitting):**
```
POST /api/seller-onboarding/validate-abn-public

Body: { "abn": "51 824 753 556" }

Response:
{
  "success": true,
  "valid": true,
  "businessName": "SMITH ART CO PTY LTD",
  "status": "Active"
}
```

---

### Step 4 — Cultural Identity
**No change needed.**

```
POST /api/seller-onboarding/cultural-info
Authorization: Bearer <token>

Body:
{
  "culturalBackground": "Yolŋu",
  "culturalStory":      "Our art tradition comes from..."
}
```

---

### Step 5 — Store Profile
**No change needed.**

```
POST /api/seller-onboarding/store-profile
Authorization: Bearer <token>
Content-Type: multipart/form-data

Fields:
  storeName        = "Smith Art Gallery"
  storeDescription = "Authentic Aboriginal artwork..."
  storeLogo        = <file upload>
```

---

### ~~Step 6 — KYC Documents~~ — REMOVED
**Delete this step from your frontend completely.**  
Stripe's hosted page will handle identity verification (passport/licence upload).

---

### Step 6 (was Step 7) — Connect Stripe Account
**This is the new step. Replace the entire bank details form.**

#### 6a. Create Stripe account + get onboarding link
Call both in sequence when seller clicks the button:

```
POST /api/seller-onboarding/stripe/connect
Authorization: Bearer <token>

Response:
{
  "success": true,
  "stripeAccountId": "acct_1AbcXXXXXXX"
}
```

Then immediately:
```
POST /api/seller-onboarding/stripe/onboarding-link
Authorization: Bearer <token>

Body:
{
  "returnUrl":  "https://yoursite.com/seller/onboarding?stripe=success",
  "refreshUrl": "https://yoursite.com/seller/onboarding?stripe=refresh"
}

Response:
{
  "success": true,
  "url": "https://connect.stripe.com/setup/e/acct_xxx/...",
  "expiresAt": 1748234567
}
```

Then redirect:
```js
window.location.href = response.url;
```

#### 6b. Check Stripe status (call on page load + after return from Stripe)
```
GET /api/seller-onboarding/stripe/status
Authorization: Bearer <token>

Response:
{
  "success": true,
  "connected": true,
  "stripeOnboardingComplete": true,
  "stripeChargesEnabled": true,
  "stripePayoutsEnabled": true,
  "requirements": []             // empty = fully set up
}
```

| `stripeOnboardingComplete` | `stripeChargesEnabled` | Meaning |
|---|---|---|
| `false` | `false` | Seller hasn't connected yet |
| `true` | `false` | Submitted but Stripe is still reviewing |
| `true` | `true` | ✅ Fully set up — can proceed to submit |

#### What to show on this step:
```
┌─────────────────────────────────────────────────────┐
│  Step 6 of 7 — Set Up Payouts                       │
│                                                     │
│  We use Stripe to securely verify your identity     │
│  and collect your Australian bank account.          │
│                                                     │
│  Stripe will ask you for:                           │
│   • Full legal name + date of birth                 │
│   • Government ID (passport or driver licence)      │
│   • ABN (pre-filled from your business details)     │
│   • BSB + bank account number                       │
│                                                     │
│  [  Connect with Stripe →  ]                        │
│                                                     │
│  Your bank details are never stored on our servers. │
└─────────────────────────────────────────────────────┘
```

---

### Step 7 (was Step 8) — Submit for Review
**No change needed** — but only enable this button when Stripe is connected.

```
POST /api/seller-onboarding/submit-for-review
Authorization: Bearer <token>

Response:
{
  "success": true,
  "message": "Application submitted for review",
  "sellerProfile": { "status": "PENDING_APPROVAL", ... }
}
```

> ⚠️ Add a guard: only allow Submit for Review if  
> `stripeOnboardingComplete === true && stripeChargesEnabled === true`

---

## Return URL Handler

When Stripe redirects the seller back to your site, read the `stripe` query param:

```js
// In your onboarding page (runs on mount / useEffect)

const params = new URLSearchParams(window.location.search);
const stripeParam = params.get("stripe");

if (stripeParam === "success") {
  // Clean up URL
  window.history.replaceState({}, "", window.location.pathname);

  // Check status with backend
  const status = await getStripeStatus(token);

  if (status.stripeOnboardingComplete && status.stripeChargesEnabled) {
    // Move to step 7 (Submit for Review)
    setCurrentStep(7);
    showToast("Payout account connected successfully!");
  } else if (status.requirements?.length > 0) {
    // Stripe still needs info — show "continue setup" button
    showToast("Stripe needs a bit more information. Please complete the setup.", "warning");
  } else {
    // Submitted but Stripe reviewing — show pending state
    showToast("Your information is being reviewed by Stripe. This may take 1–2 days.", "info");
  }
}

if (stripeParam === "refresh") {
  // AccountLink expired (24h) — generate a new one and redirect
  window.history.replaceState({}, "", window.location.pathname);
  const res = await generateOnboardingLink(token);
  window.location.href = res.url;
}
```

---

## Step Completion Logic (Stepper Component)

Update your stepper to mark Step 6 (Stripe) as complete based on:

```js
function isStripeStepComplete(sellerProfile) {
  return (
    sellerProfile.stripeOnboardingComplete === true &&
    sellerProfile.stripeChargesEnabled === true
  );
}

// Steps array — remove the old KYC and bank steps, add Stripe step
const steps = [
  { id: 1, label: "Account Setup",      complete: !!profile.emailVerified },
  { id: 2, label: "Business Details",   complete: !!(profile.businessName && profile.abn) },
  { id: 3, label: "Cultural Identity",  complete: true },
  { id: 4, label: "Store Profile",      complete: !!(profile.storeName && profile.storeDescription) },
  { id: 5, label: "Connect Stripe",     complete: isStripeStepComplete(profile) },
  { id: 6, label: "Submit for Review",  complete: profile.status === "PENDING_APPROVAL" },
];
```

---

## Dashboard — Payout Status Widget

Add this widget to the seller dashboard sidebar or settings page:

```
┌──────────────────────────────────────────┐
│ Payout Account                           │
│                                          │
│  ✅ Connected via Stripe                 │  ← if complete
│  Transfers to your AU bank are active.   │
│                                          │
│  ⚠️  Action Required                    │  ← if requirements exist
│  Stripe needs more info.                 │
│  [ Complete Stripe Setup → ]             │
│                                          │
│  ⏳ Under Review                        │  ← if submitted not yet enabled
│  Stripe is reviewing your account.       │
│  Usually 1–2 business days.             │
│                                          │
│  ○  Not Connected                       │  ← if not started
│  [ Set Up Payouts → ]                   │
└──────────────────────────────────────────┘
```

**API call for widget:**
```
GET /api/seller-onboarding/stripe/status
Authorization: Bearer <token>
```

---

## Files to Change in Frontend

| File | Change |
|---|---|
| `SellerOnboarding.jsx` (or equivalent) | Remove KYC step, replace bank step with Stripe step, update step count from 8→7 |
| `StepIndicator.jsx` (or stepper) | Update steps array (remove KYC + bank, add Stripe Connect) |
| `KYCUpload.jsx` | ❌ Delete or hide this component |
| `BankDetails.jsx` | ❌ Delete or hide this component |
| Create `StripeConnect.jsx` | New component for Step 6 |
| `SellerDashboard.jsx` | Add Stripe payout status widget |
| `router.js` / routing | Handle `?stripe=success` and `?stripe=refresh` on return URL page |

---

## Environment Variable Needed in Frontend

```
NEXT_PUBLIC_API_URL=https://alpa-be.onrender.com/api
# or for Vite:
VITE_API_URL=https://alpa-be.onrender.com/api
```

---

## Full Stripe Connect Step — React Component

```jsx
// StripeConnectStep.jsx

import { useState, useEffect } from "react";

const API = process.env.NEXT_PUBLIC_API_URL; // or import.meta.env.VITE_API_URL

export default function StripeConnectStep({ token, onComplete }) {
  const [stripeStatus, setStripeStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  // Check on mount and when returning from Stripe
  useEffect(() => {
    checkStripeStatus();

    const params = new URLSearchParams(window.location.search);
    if (params.get("stripe") === "refresh") {
      window.history.replaceState({}, "", window.location.pathname);
      handleConnect(); // regenerate link and redirect
    }
  }, []);

  async function checkStripeStatus() {
    try {
      const res = await fetch(`${API}/seller-onboarding/stripe/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setStripeStatus(data);

      // Auto-advance if fully complete
      if (data.stripeOnboardingComplete && data.stripeChargesEnabled) {
        onComplete?.();
      }
    } catch (err) {
      console.error("Failed to check Stripe status", err);
    }
  }

  async function handleConnect() {
    setLoading(true);
    try {
      // 1. Create Stripe account (idempotent — safe to call multiple times)
      await fetch(`${API}/seller-onboarding/stripe/connect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      // 2. Get onboarding link
      const res = await fetch(`${API}/seller-onboarding/stripe/onboarding-link`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          returnUrl:  `${window.location.origin}/seller/onboarding?stripe=success`,
          refreshUrl: `${window.location.origin}/seller/onboarding?stripe=refresh`,
        }),
      });

      const { url } = await res.json();

      // 3. Redirect to Stripe-hosted page
      window.location.href = url;
    } catch (err) {
      console.error("Stripe connect failed", err);
      setLoading(false);
    }
  }

  // ── States ─────────────────────────────────────────────────────────────────

  // Fully set up
  if (stripeStatus?.stripeOnboardingComplete && stripeStatus?.stripeChargesEnabled) {
    return (
      <div className="stripe-step-complete">
        <span>✅</span>
        <h3>Payout account connected</h3>
        <p>Your Australian bank account is verified. You will receive payouts via Stripe.</p>
      </div>
    );
  }

  // Started but Stripe still needs info
  if (stripeStatus?.connected && !stripeStatus?.stripeOnboardingComplete) {
    return (
      <div className="stripe-step-incomplete">
        <h3>Almost there — Stripe needs a bit more info</h3>
        {stripeStatus.requirements?.length > 0 && (
          <p>Still required: <strong>{stripeStatus.requirements.join(", ")}</strong></p>
        )}
        <button onClick={handleConnect} disabled={loading}>
          {loading ? "Loading..." : "Continue Stripe setup →"}
        </button>
      </div>
    );
  }

  // Submitted — Stripe reviewing
  if (stripeStatus?.stripeOnboardingComplete && !stripeStatus?.stripeChargesEnabled) {
    return (
      <div className="stripe-step-reviewing">
        <h3>⏳ Under review by Stripe</h3>
        <p>Stripe is reviewing your account. This usually takes 1–2 business days.</p>
      </div>
    );
  }

  // Not started yet
  return (
    <div className="stripe-step-connect">
      <h3>Set up your payout account</h3>
      <p>
        We use <strong>Stripe</strong> to verify your identity and securely collect
        your Australian bank details. You will be redirected to Stripe's website.
      </p>

      <ul>
        <li>Full legal name + date of birth</li>
        <li>Government ID (passport or driver licence)</li>
        <li>ABN — pre-filled from your business details</li>
        <li>BSB + bank account number</li>
      </ul>

      <button onClick={handleConnect} disabled={loading}>
        {loading ? "Setting up..." : "Connect with Stripe →"}
      </button>

      <p className="note">
        Your bank details are never stored on our servers — handled entirely by Stripe.
      </p>
    </div>
  );
}
```
