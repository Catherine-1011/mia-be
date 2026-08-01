# ALPA Platform Owner Setup

Admin-created ALPA products need an internal seller identity. The product create
endpoint continues to read this ID from:

```env
ALPA_PLATFORM_OWNER_ID=<user.id>
```

## Audit Existing Database

Run from `mia-be`:

```bash
npm run provision:platform-owner
```

If a valid platform owner already exists, the script prints the user ID and makes
no database changes.

The required database shape is:

- `User.role = SELLER`
- `SellerProfile.status = ACTIVE`
- `SellerProfile.isActive = true`
- `SellerProfile.paymentAccountType = PLATFORM`
- `SellerProfile.stripeAccountId = null`

## Provision If Missing

If audit mode reports that no valid owner exists, run:

```bash
npm run provision:platform-owner -- --create
```

This creates or repairs only the reserved internal identity:

- `name = ALPA Platform Internal`
- `email = alpa.platform.internal@alpa.asn.au`
- `role = SELLER`
- `SellerProfile.status = ACTIVE`
- `SellerProfile.isActive = true`
- `SellerProfile.paymentAccountType = PLATFORM`
- `SellerProfile.stripeAccountId = null`

It does not create a Stripe connected account, start seller onboarding, require
ABN data, or alter payment, checkout, refund, webhook, or commission logic.

After the script prints the user ID, configure the backend runtime environment:

```env
ALPA_PLATFORM_OWNER_ID=<printed-user-id>
```

Restart or redeploy the backend after changing the environment variable.

## Verification

1. Sign in as an approved `ADMIN`, approved SAML `ADMIN`, or `SUPER_ADMIN`.
2. Open Admin Dashboard -> Products -> Add Product.
3. Submit a simple product.
4. Confirm the created product has:
   - `sellerId = ALPA_PLATFORM_OWNER_ID`
   - `status = PENDING`
   - `isActive = false`
5. Approve through the existing super-admin approval flow and confirm it becomes
   active through the existing product approval path.
