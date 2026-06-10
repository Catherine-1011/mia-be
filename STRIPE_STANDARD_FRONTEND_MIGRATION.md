# Stripe Standard Connect — Frontend Migration Guide
## (Switching from Express to Standard)

Only the Stripe Connect touchpoints change in the frontend. Everything else — products, orders, seller dashboard,
all other onboarding steps — stays exactly the same.

---

## What Was (Express)

```
Step 6 of onboarding:

1. Call POST /api/seller-onboarding/stripe/connect
   → Backend silently creates a Stripe Express account

2. Call POST /api/seller-onboarding/stripe/onboarding-link  
   → Backend returns a hosted URL

3. window.location.href = url
   → Seller fills Stripe form, redirects back to your return_url

Seller Dashboard:
4. Call GET /api/seller-onboarding/stripe/login-link
   → Backend returns a one-time URL
   → window.open(url) — opens Stripe Express dashboard
```

---

## What Changes (Standard)

```
Step 6 of onboarding:

1. Call GET /api/seller-onboarding/stripe/oauth-url   ← NEW endpoint
   → Backend returns a Stripe OAuth URL

2. window.location.href = url
   → Seller logs into stripe.com (or creates account), fills KYC form
   → Stripe redirects to: https://madeinarnhemland.com.au/seller/stripe/callback?code=xxx&state=userId

3. NEW PAGE NEEDED: /seller/stripe/callback
   → Reads ?code and ?state from URL
   → Calls GET /api/seller-onboarding/stripe/oauth-callback?code=xxx&state=xxx
   → Backend stores stripeAccountId
   → Redirect to next onboarding step

Seller Dashboard:
4. GET /api/seller-onboarding/stripe/login-link   ← same endpoint, different response
   → Returns { url: "https://dashboard.stripe.com/login" }
   → window.open(url) — opens stripe.com (seller logs in with their own email)
```

---

## Change 1 — Stripe Connect Step in Onboarding

### Old code (Express — DELETE THIS)
```js
// Step 1: create account
const connectRes = await fetch('/api/seller-onboarding/stripe/connect', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
});

// Step 2: get onboarding link
const linkRes = await fetch('/api/seller-onboarding/stripe/onboarding-link', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    returnUrl: 'https://madeinarnhemland.com.au/seller/stripe/success',
    refreshUrl: 'https://madeinarnhemland.com.au/seller/stripe/refresh'
  })
});
const { url } = await linkRes.json();
window.location.href = url;
```

### New code (Standard — REPLACE WITH THIS)
```js
// Single call — get OAuth URL and redirect
const res = await fetch('/api/seller-onboarding/stripe/oauth-url', {
  method: 'GET',
  headers: { 'Authorization': `Bearer ${token}` }
});
const data = await res.json();

if (data.alreadyConnected) {
  // Seller already connected — skip to next step
  router.push('/apply/submit');
  return;
}

window.location.href = data.url; // redirects to stripe.com
```

---

## Change 2 — New Callback Page (ADD THIS)

Create a new page at the route `/seller/stripe/callback`.

Stripe will redirect here after the seller completes their Stripe account setup.

```jsx
// Page: /seller/stripe/callback
// This page has no visible UI — it just processes the callback and redirects

useEffect(() => {
  const processCallback = async () => {
    const params = new URLSearchParams(window.location.search);
    const code  = params.get('code');
    const state = params.get('state');   // this is the userId
    const error = params.get('error');

    // Seller cancelled or denied
    if (error) {
      router.push('/apply/stripe?error=cancelled');
      return;
    }

    if (!code || !state) {
      router.push('/apply/stripe?error=missing_params');
      return;
    }

    try {
      const res = await fetch(
        `/api/seller-onboarding/stripe/oauth-callback?code=${code}&state=${state}`
      );
      const data = await res.json();

      if (data.success) {
        // Connected successfully — continue to submit step
        router.push('/apply/submit');
      } else {
        router.push(`/apply/stripe?error=${encodeURIComponent(data.message)}`);
      }
    } catch (err) {
      router.push('/apply/stripe?error=server_error');
    }
  };

  processCallback();
}, []);

return (
  <div>
    <p>Connecting your Stripe account...</p>
    {/* Show a loading spinner here */}
  </div>
);
```

---

## Change 3 — Seller Dashboard "Go to Stripe" button

### Old code (Express)
```js
// Generated a one-time link that expired in minutes
const res = await fetch('/api/seller-onboarding/stripe/login-link', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const { url } = await res.json();
window.open(url, '_blank');
```

### New code (Standard — REPLACE WITH THIS)
```js
// Standard accounts just go to stripe.com directly
const res = await fetch('/api/seller-onboarding/stripe/login-link', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const data = await res.json();

if (data.success) {
  window.open('https://dashboard.stripe.com/login', '_blank');
  // OR: window.open(data.url, '_blank')  ← data.url is already dashboard.stripe.com/login
}
```

Or even simpler — just hardcode the button since the URL never changes:
```jsx
<a href="https://dashboard.stripe.com/login" target="_blank" rel="noreferrer">
  Go to Stripe Dashboard
</a>
```

---

## Nothing Else Changes

| Feature | Change needed? |
|---|---|
| Email + OTP step | ❌ No |
| Business details step | ❌ No |
| Cultural info step | ❌ No |
| Store profile step | ❌ No |
| KYC upload step | ❌ No |
| Submit for review step | ❌ No |
| Seller login | ❌ No |
| Resume application | ❌ No |
| Products management | ❌ No |
| Orders management | ❌ No |
| Earnings / commission view | ❌ No |
| Stripe connect step | ✅ **Yes — 2 changes above** |
| Stripe callback page | ✅ **Yes — new page** |
| Stripe dashboard button | ✅ **Yes — simpler now** |

---

## Stripe Dashboard Setting (Do Once)

In **Stripe Dashboard → Settings → Connect → OAuth settings**:

- Enable OAuth for Standard accounts
- Add redirect URI:
  ```
  https://madeinarnhemland.com.au/seller/stripe/callback
  ```

This must exactly match where Stripe redirects after the seller connects.

---

## Summary

```
Remove:  POST /stripe/connect          call
Remove:  POST /stripe/onboarding-link  call

Add:     GET  /stripe/oauth-url        call  (one line)
Add:     /seller/stripe/callback       page  (processes redirect from Stripe)

Change:  Stripe dashboard button       → link to stripe.com/login instead of one-time link
```
