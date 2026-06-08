# Seller Resume Onboarding API Guide

## Overview

Allows a seller who left their application mid-way to continue from where they stopped.
OTP verification is required to prevent someone from resuming another person's application.

---

## Flow

```
POST /seller-onboarding/resume
        │
   canResume: false          canResume: true
        │                         │
  show message              OTP sent to email
  "start new app"                 │
                        POST /seller-onboarding/resume-verify-otp
                                  │
                        returns JWT + nextStep.redirectTo
                                  │
                        redirect to that step page
```

---

## API Endpoints

### 1. `POST /api/seller-onboarding/resume`

Check if an application exists for an email and send OTP if it does.

**Request**
```json
{
  "email": "seller@example.com"
}
```

**Response — no account found (404)**
```json
{
  "success": false,
  "canResume": false,
  "message": "No seller account found with this email. Please start a new application.",
  "action": "start_new",
  "startEndpoint": "/seller-onboarding/apply"
}
```

**Response — email entered but OTP was never verified (no data saved)**
```json
{
  "success": true,
  "canResume": false,
  "message": "No data has been saved for this email yet. Please start a new application.",
  "action": "start_new",
  "startEndpoint": "/seller-onboarding/apply"
}
```

**Response — application already approved**
```json
{
  "success": true,
  "canResume": false,
  "message": "Your seller application is already approved. Please log in to your dashboard.",
  "action": "login",
  "loginEndpoint": "/seller-onboarding/login"
}
```

**Response — account found, OTP sent** ✅
```json
{
  "success": true,
  "canResume": true,
  "message": "A verification code has been sent to your email. Please enter it to continue your application.",
  "action": "verify_otp",
  "verifyEndpoint": "/seller-onboarding/resume-verify-otp"
}
```

---

### 2. `POST /api/seller-onboarding/resume-verify-otp`

Verify the OTP and get a JWT token + the step to redirect to.

**Request**
```json
{
  "email": "seller@example.com",
  "otp": "482910"
}
```

**Response — invalid OTP (400)**
```json
{
  "success": false,
  "message": "Invalid OTP."
}
```

**Response — expired OTP (400)**
```json
{
  "success": false,
  "message": "OTP has expired. Please request a new one."
}
```

**Response — success** ✅
```json
{
  "success": true,
  "message": "Identity verified. Continuing your application.",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { ... },
  "nextStep": {
    "step": 5,
    "name": "Store Profile",
    "description": "Store name, description, and logo",
    "redirectTo": "/apply/store-profile"
  },
  "completedSteps": 4,
  "totalSteps": 8,
  "onboardingStatus": { ... }
}
```

---

## Step Redirect Map

| `nextStep.redirectTo` | Step | Page |
|---|---|---|
| `/apply/business-details` | 3 | Business name, ABN, address |
| `/apply/cultural-info` | 4 | Artist/cultural background |
| `/apply/store-profile` | 5 | Store name, description, logo |
| `/apply/kyc` | 6 | Identity documents |
| `/apply/bank-details` | 7 | Banking information |
| `/apply/submit` | 8 | Final review submission |

---

## Resend OTP

Call `/resume` again with the same email — it generates and sends a fresh OTP.

```json
POST /api/seller-onboarding/resume
{ "email": "seller@example.com" }
```

OTP expires after **10 minutes**.

---

## Security

- OTP is sent only to the registered email — a third party entering someone else's email cannot proceed without access to that inbox.
- The `pendingRegistration` row is deleted immediately after a successful OTP verification.
- JWT token expires in **30 days**.

---

## Frontend Usage

### Step 1 — Email screen

```js
const res = await fetch('/api/seller-onboarding/resume', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email })
});
const data = await res.json();

if (data.canResume === false) {
  if (data.action === 'start_new') showMessage("No saved data. Please start a new application.");
  if (data.action === 'login')    router.push('/seller/login');
  return;
}

// canResume: true → show OTP input screen
setStep('otp');
```

### Step 2 — OTP screen

```js
const res = await fetch('/api/seller-onboarding/resume-verify-otp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, otp })
});
const data = await res.json();

if (!data.success) {
  showError(data.message);
  return;
}

localStorage.setItem('sellerToken', data.token);
router.push(data.nextStep.redirectTo); // e.g. "/apply/store-profile"
```

### Authenticated step pages

All step pages after OTP verification must include the token:

```js
const res = await fetch('/api/seller-onboarding/business-details', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('sellerToken')}`
  },
  body: JSON.stringify(formData)
});
```
