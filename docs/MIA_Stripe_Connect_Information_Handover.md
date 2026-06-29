# Made in Arnhem Land Marketplace

Stripe Connect Information Handover

Prepared for: Client Handover
Prepared on: 25 June 2026
Main website: https://madeinarnhemland.com.au
Dashboard portal: https://dashboard.madeinarnhemland.com.au
Backend API: https://backend.madeinarnhemland.com.au

## 1. Document Purpose

This document explains how Stripe is used in the Made in Arnhem Land marketplace for seller onboarding, seller payouts, platform commission, transactions, refunds, cancellations, and operational review.

The platform uses Stripe Connect with Standard connected accounts for sellers. This means each seller connects or creates their own Stripe account through Stripe, completes Stripe verification directly with Stripe, and can log in to Stripe using their own credentials.

## 2. Stripe Account Structure

The Stripe setup has two main account types:

- Platform Stripe account: controlled by the marketplace/admin.
- Seller Stripe connected accounts: owned by individual sellers through Stripe Standard accounts.

The platform Stripe account is used to operate the marketplace payment system, review connected sellers, monitor payments, review transfers, and track marketplace commission.

Each seller has a Stripe Standard connected account. A Standard connected account is a normal Stripe account connected to the platform through Stripe Connect OAuth. Sellers can access their own Stripe Dashboard directly from stripe.com.

## 3. Why Standard Stripe Accounts Are Used

Stripe Standard accounts are used because:

- Sellers can log in directly at https://dashboard.stripe.com/login.
- Stripe handles the seller account onboarding experience.
- Stripe collects and verifies seller information required for payment processing.
- Sellers have their own Stripe Dashboard.
- Sellers maintain a direct relationship with Stripe for their account.
- The platform can still connect the seller account to marketplace payments.

This avoids the platform having to build and maintain a full custom payout dashboard or store sensitive seller banking/identity verification data directly.

## 4. Seller Stripe Onboarding Journey

Seller Stripe onboarding is part of the seller onboarding process.

The seller journey is:

- Seller applies on the Made in Arnhem Land website.
- Seller completes platform onboarding details.
- Seller clicks the Stripe Connect setup button.
- Seller is redirected to Stripe's secure website.
- Seller creates or connects a Stripe Standard account.
- Seller completes Stripe verification requirements.
- Stripe redirects the seller back to the marketplace.
- The backend stores the connected Stripe account ID.
- The backend checks Stripe status such as onboarding complete, charges enabled, payouts enabled, ABN provided, and bank connected.
- Seller can proceed once the account is verified and ready.

Stripe information tracked by the platform includes:

- Stripe connected account ID.
- Stripe onboarding completion status.
- Charges enabled status.
- Payouts enabled status.
- KYC/verification status.
- ABN provided flag.
- Bank connected flag.
- Current Stripe requirements or errors.

## 5. Seller Verification Responsibility

All required Stripe verification is completed by the seller inside Stripe.

Stripe may ask the seller for:

- Legal name.
- Date of birth.
- Business information.
- ABN or business tax information where required.
- Identity verification documents.
- Bank account or payout details.
- Stripe Terms of Service acceptance.
- Additional compliance information if Stripe requires it later.

The seller is responsible for completing and maintaining their Stripe account verification. If Stripe requires more information later, the seller must log in to Stripe and provide it.

## 6. Seller Stripe Dashboard Access

Sellers can log in directly to Stripe:

- Stripe login: https://dashboard.stripe.com/login

The seller must use the same email/account they used when completing Stripe Connect setup.

From the seller Stripe Dashboard, the seller can review information related to their connected Stripe account, such as:

- Payments/transactions linked to their seller account.
- Transfers/payout activity.
- Account verification requirements.
- Payout/bank details managed by Stripe.
- Stripe account settings.
- Stripe notices or compliance requests.

The marketplace dashboard can also show Stripe connection status, but the seller’s full Stripe account access is through stripe.com.

## 7. Platform Admin Stripe Dashboard Access

The marketplace/platform admin can log in to the platform Stripe Dashboard.

From the platform Stripe Dashboard, admin can review:

- Platform payments.
- Connected accounts.
- Seller connected account status.
- Order-related payment records.
- PaymentIntents and charges.
- Transfers to connected sellers.
- Application/platform fees or commission.
- Refunds.
- Disputes/chargebacks.
- Webhook delivery status.
- Stripe Connect settings.

The platform Stripe account is the central place to review marketplace payment operations.

## 8. Admin and Seller Visibility

Both admin and seller can see Stripe-related information, but the view is different.

Admin can see:

- Platform transactions.
- Connected seller accounts.
- Seller verification status.
- Seller transfers.
- Platform commission/application fee records.
- Order payment references.
- Refund/dispute activity.

Seller can see:

- Their own Stripe Standard account.
- Their own seller transaction/payout activity.
- Their own Stripe verification requirements.
- Their own bank/payout account configuration.

The seller cannot see other sellers' Stripe accounts or platform-wide financial information.

## 9. Payment and Payout Flow

When a customer places an order, Stripe processes the card/payment transaction.

The platform uses Stripe Connect routing so that:

- The seller receives the seller portion for their order items.
- The platform/admin receives the platform commission.
- Stripe deducts Stripe processing/Connect fees as per Stripe policy.

For a single-seller order, the system can route the payment to that seller’s connected account and apply the platform commission/application fee.

For a multi-seller order, the platform records the parent order and seller sub-orders, then routes seller payouts/transfers for each seller portion while keeping marketplace commission records.

The backend records Stripe IDs and transaction metadata so the order can be traced from the marketplace dashboard to Stripe.

## 10. Commission Flow

The platform calculates marketplace commission using the configured commission plan.

Current implementation supports:

- Default commission.
- Seller-specific commission assignment.
- Commission earned per order.
- Commission earned summary.
- Commission status tracking.
- Payout request tracking.
- Admin commission review.

The seller payout is calculated after platform commission. Stripe fees are handled by Stripe separately according to the connected account and transaction setup.

## 11. Stripe Fee Handling

Stripe charges its own processing and Connect-related fees according to the Stripe account, payment method, region, card type, currency, payout method, and Stripe’s current pricing rules.

Important note:

- Stripe fees are not controlled by the marketplace application.
- Stripe fees can change according to Stripe policy.
- The client should always refer to the current Stripe pricing page and Stripe account dashboard for exact fees.

The platform documentation should avoid promising a fixed Stripe fee unless the client has confirmed it directly with Stripe.

## 12. Refund and Cancellation Flow

If an order is cancelled or refunded, the customer receives the refunded amount according to the refund/cancellation action.

Important refund behavior:

- If a payment is cancelled before it is completed/captured, Stripe may cancel it without a completed charge.
- If a payment has already succeeded, a refund is issued back to the original payment method.
- Stripe’s original processing fees are generally not returned by Stripe.
- Refunds and fee treatment are subject to Stripe’s current policy.
- If transfers were already made to sellers, the platform may need to reverse seller transfers or handle adjustment logic depending on the charge/transfer type and timing.

In this platform:

- Customer or guest can request cancellation/refund from the marketplace.
- Admin reviews refund requests.
- Admin can approve, reject, or complete refund requests.
- Approved Stripe refunds are triggered through the backend where a Stripe payment exists.
- Seller transfer reversal and commission cancellation are handled by backend logic/webhooks where applicable.
- Customer refund status is communicated through the platform.

## 13. What Happens to Money on Refund

When a refund is processed:

- The customer refund is sent back to the original payment method.
- Seller revenue and platform commission are adjusted according to the marketplace refund logic.
- Stripe keeps or applies fees according to Stripe’s policy.
- If the refund results in an insufficient Stripe balance, Stripe may handle the negative balance according to Stripe account rules.

Client-facing explanation:

The marketplace can refund the customer, but Stripe fee recovery is not guaranteed. Stripe determines whether any fee is returned or retained. The client should consider Stripe’s current refund policy as the source of truth.

## 14. Order and Transaction Traceability

Stripe records are connected to marketplace orders using metadata and descriptions.

The backend records and uses:

- Order ID.
- Display order ID.
- Sub-order ID.
- Sub-order display ID.
- Seller ID.
- Customer name.
- Customer email.
- Item summary.
- PaymentIntent ID.
- Transfer ID.
- Commission amount.
- Seller payout amount.
- Platform fee/commission amount.

This allows admin to cross-check an order between:

- Admin dashboard.
- Seller dashboard.
- Backend database.
- Stripe platform dashboard.
- Seller Stripe connected account dashboard.

## 15. Stripe Webhooks

Stripe webhooks keep the system updated.

Important webhook areas include:

- Payment success confirmation.
- Stripe Connect account status updates.
- Seller account verification status changes.
- Refund/dispute events.
- Transfer/dispute handling where applicable.

Backend environment variables used for webhooks include:

- STRIPE_WEBHOOK_SECRET
- STRIPE_CONNECT_WEBHOOK_SECRET

Webhook setup should be reviewed in the Stripe Dashboard whenever domains, backend URLs, or deployment environments change.

## 16. Required Stripe Environment Variables

Backend environment variables related to Stripe include:

- STRIPE_SECRET_KEY
- STRIPE_PUBLISHABLE_KEY
- STRIPE_CLIENT_ID
- STRIPE_WEBHOOK_SECRET
- STRIPE_CONNECT_WEBHOOK_SECRET

These values should remain private and must not be shared in public documentation.

## 17. Operational Responsibilities

Marketplace admin is responsible for:

- Maintaining the platform Stripe account.
- Reviewing connected seller accounts.
- Reviewing transactions, refunds, and disputes.
- Ensuring webhooks are active.
- Ensuring Stripe live/test mode is correct.
- Reviewing commission and payout records.
- Communicating with sellers if Stripe requires additional verification.

Seller is responsible for:

- Creating or connecting their own Stripe Standard account.
- Completing Stripe verification.
- Maintaining payout/bank details in Stripe.
- Responding to Stripe compliance requests.
- Logging into Stripe directly to review their account.

Stripe is responsible for:

- Secure payment processing.
- Seller account onboarding flow.
- Identity and business verification.
- Card/payment processing fees.
- Stripe Dashboard account tools.
- Stripe payout infrastructure.
- Stripe compliance requirements.

## 18. Important Client Notes

Use the Stripe platform dashboard for payment operations review.

Use the marketplace admin dashboard for marketplace order management, refund approval, seller status, product/order operations, and commission records.

Use the seller Stripe dashboard only for that seller’s connected Stripe account.

Do not manually edit Stripe transactions unless the operational impact is understood. Manual Stripe refunds, reversals, or transfers can cause the marketplace database and Stripe records to become out of sync if not also reflected in the platform.

If a manual Stripe action is required, record it in the admin notes and reconcile it against the order in the dashboard.

## 19. Recommended Stripe Handover Checklist

Before final handover, confirm:

- Client has access to the platform Stripe account.
- Stripe account is in live mode for production.
- Stripe Connect is configured.
- Stripe OAuth client ID is stored in backend environment variables.
- Stripe webhook endpoints are configured for backend production URL.
- STRIPE_WEBHOOK_SECRET is set.
- STRIPE_CONNECT_WEBHOOK_SECRET is set.
- Test payment/refund flow has been verified.
- Seller onboarding/Stripe connection has been verified.
- Admin can see connected accounts in Stripe.
- Seller can log in directly to stripe.com.
- Refund and fee behavior has been explained to client.
- Client understands Stripe fees are controlled by Stripe.

## 20. Official Stripe References

Stripe Standard connected accounts:

- https://docs.stripe.com/connect/accounts
- https://docs.stripe.com/connect/standard-accounts

Stripe refunds:

- https://docs.stripe.com/refunds

Stripe Connect charge and transfer behavior:

- https://docs.stripe.com/connect/charges
- https://docs.stripe.com/connect/destination-charges
- https://docs.stripe.com/connect/separate-charges-and-transfers

## 21. Final Summary

Made in Arnhem Land uses Stripe Connect with Standard connected accounts for sellers. Sellers complete their Stripe verification directly with Stripe and can log in to stripe.com to access their own Stripe Dashboard. The platform admin uses the platform Stripe Dashboard to review connected accounts, orders, payments, transfers, commissions, refunds, and disputes.

When an order is placed, the marketplace uses Stripe Connect payment routing so the seller receives their seller portion and the platform receives its commission, while Stripe applies its own processing and Connect fees according to Stripe policy. If an order is cancelled or refunded, customer refund handling is processed through Stripe and the marketplace refund workflow, while Stripe fee treatment remains subject to Stripe’s current rules.
