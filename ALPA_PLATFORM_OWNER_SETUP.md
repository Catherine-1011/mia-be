# ALPA Platform Account Setup

Admin-created ALPA products use a platform account identity for ownership and
payment routing. This identity is no longer required to be a seller and does not
need a `SellerProfile` or Stripe Connect account.

The backend reads the owning user ID from:

```env
ALPA_PLATFORM_OWNER_ID=<users.id>
```

That user must be an existing ADMIN, SUPER_ADMIN, or SAML admin. It must not be
a SELLER user. The required database shape is:

- `PlatformAccount.userId = ALPA_PLATFORM_OWNER_ID`
- `PlatformAccount.active = true`
- `PlatformAccount.paymentType = PLATFORM`

## Audit Existing Database

Run from `mia-be`:

```bash
npm run provision:platform-owner
```

If a valid platform account already exists, the script prints its user ID and
makes no database changes.

## Provision If Missing

Set `ALPA_PLATFORM_OWNER_ID` to the existing user that should represent the ALPA
platform account, then run:

```bash
npm run provision:platform-owner -- --create
```

The script creates or updates only the `platform_accounts` row. It does not:

- convert ADMIN users into SELLERS
- create seller profiles
- create duplicate seller accounts
- allow SELLER users as the platform account identity
- start Stripe Connect onboarding
- require a connected Stripe account

## Verification

1. Sign in as an approved `ADMIN`, approved SAML `ADMIN`, or `SUPER_ADMIN`.
2. Open Admin Dashboard -> Products -> Add Product.
3. Submit a simple product.
4. Confirm the created product has:
   - `creatorId = <logged-in admin user id>`
   - `ownerType = PLATFORM`
   - `platformAccountId = <active PlatformAccount.id>`
   - `status = PENDING`
   - `isActive = false`
5. Approve through the existing super-admin approval flow and confirm checkout
   uses `paymentFlow = PLATFORM_ACCOUNT` with no Stripe connected account.
