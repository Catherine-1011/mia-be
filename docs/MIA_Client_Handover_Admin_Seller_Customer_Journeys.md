# Made in Arnhem Land Marketplace

Client Handover Document: Admin, Seller, Customer, Guest, Operations, and Technical Overview

Prepared for: Client Handover
Prepared on: 25 June 2026
Main website: https://madeinarnhemland.com.au
Dashboard portal: https://dashboard.madeinarnhemland.com.au
Backend API: https://backend.madeinarnhemland.com.au

## 1. Document Purpose

This document explains the current operational journey and functional scope for the Made in Arnhem Land marketplace. It is intended for client handover and gives the client a clear understanding of how the admin, seller, customer, and guest flows work, what each role can access, and where the production code, environment configuration, media storage, and database are hosted.

The platform is made up of three main codebases:

- Backend API: mia-be
- Main customer-facing website: mia-fe
- Dashboard portal for admin, seller, and customer accounts: mia-dashboard-fe

The production infrastructure is hosted on DigitalOcean. The backend, website frontend, dashboard frontend, media uploads, environment files, and database are all managed through the DigitalOcean setup.

## 2. Platform Overview

Made in Arnhem Land is a multi-vendor ecommerce marketplace. Sellers apply to join the platform, complete onboarding, connect payout details through Stripe Connect, and submit products for review. Admin users manage marketplace operations, approve sellers and products, manage orders, coupons, commissions, GST, shipping, blog content, categories, refunds, and customer/seller records. Customers can browse, purchase, track, cancel eligible orders, reorder, download invoices, and maintain a wishlist. Guest customers can also place and track orders without creating an account.

## 3. Production URLs and Portals

Main website:

- URL: https://madeinarnhemland.com.au
- Purpose: Public storefront, product browsing, cart, checkout, customer login/signup, seller onboarding, blog, guest order tracking, guest refunds, and policy pages.

Dashboard portal:

- URL: https://dashboard.madeinarnhemland.com.au
- Purpose: Admin dashboard, seller dashboard, and customer dashboard.
- Admin users log in through the dashboard portal.
- Sellers can access their dashboard after onboarding/login.
- Customers can access their customer dashboard for orders, profile, wishlist, and notifications.

Backend API:

- URL: https://backend.madeinarnhemland.com.au
- Purpose: API layer for authentication, products, sellers, orders, payments, coupons, categories, blogs, wishlist, cart, notifications, GST, shipping, commissions, and admin operations.

## 4. User Roles

The platform includes the following key role types:

- Admin / Super Admin: Marketplace operator with full administrative access.
- Seller: Approved marketplace seller who can manage store profile, products, orders, coupons, categories, earnings, and refunds.
- Customer / User: Registered shopper with account, cart, wishlist, orders, invoices, reorder, cancellations, refund requests, and profile access.
- Guest Customer: Shopper without an account who can browse, checkout, track orders, cancel eligible orders, request refunds, and download invoices using order details and email verification.

## 5. Admin Journey

### 5.1 Admin Login and Access

Admins access the portal at https://dashboard.madeinarnhemland.com.au.

The backend supports normal authentication and SAML/AuthPoint admin authentication. Admin SAML routes are configured under the backend authentication module. The backend CORS allowlist includes:

- https://madeinarnhemland.com.au
- https://www.madeinarnhemland.com.au
- https://dashboard.madeinarnhemland.com.au

Admin users should always use the dashboard portal for admin operations.

### 5.2 Admin Dashboard

The admin dashboard provides overview and operational screens for marketplace management. Current dashboard areas include:

- Dashboard home
- Analytics
- Orders
- Products
- Product recycle bin
- Sellers
- Seller detail pages
- Seller bank change requests
- Customers
- Customer detail pages
- Categories
- Category detail pages
- Coupons
- Seller coupons
- Blogs
- Commissions
- GST
- GST reconciliation
- Shipping
- Refunds
- Sponsored sections
- Newsletter
- Support
- Feedback
- Notifications
- Profile and settings

### 5.3 Seller Management

Admin can manage the complete seller profile and seller lifecycle.

Admin seller capabilities include:

- View all sellers.
- Filter sellers by status.
- View pending sellers for review.
- Open complete seller profile details.
- View seller products.
- View seller orders.
- Suspend sellers.
- Toggle seller active/inactive status.
- Update seller notes.
- Update seller profile fields such as ABN, business name, and related business details.
- Sync seller Stripe KYC status.
- Bulk sync Stripe status for all sellers.
- Retry pending Stripe transfers for a seller.
- Assign a specific commission plan to a seller.
- Review and action seller bank change requests.

Important behavior:

- When a seller is marked inactive, seller products can be deactivated automatically.
- Seller Stripe Connect status can be synced by admin.
- Seller payout/bank change requests are reviewed by admin before changes are applied.

### 5.4 Product Management

Admin can manage marketplace products across all sellers.

Admin product capabilities include:

- View all products with status filters such as pending, approved, rejected, inactive, and all.
- Filter products by seller.
- View pending products submitted for approval.
- Approve products.
- Reject products with reason/note support.
- Bulk approve products.
- Activate or deactivate products.
- Edit seller products.
- Manage product variants and variant status.
- Soft delete products into recycle bin.
- Restore deleted products.
- Permanently delete products from recycle bin.
- Scan low-stock products and trigger deactivation/notifications.
- View product audit history.

Product approval lifecycle:

- Seller creates or updates a product.
- Product enters review/pending workflow when submitted.
- Admin reviews the product.
- Admin approves, rejects, activates, deactivates, or edits as required.
- Rejected or inactive products can be corrected and submitted again.

### 5.5 Category Management

Admin can manage marketplace categories and seller category requests.

Admin category capabilities include:

- View approved active categories.
- View category details.
- View category audit logs.
- Create categories directly as approved categories.
- Approve seller category requests.
- Reject seller category requests.
- Edit approved categories.
- Resubmit rejected categories where applicable.
- Soft delete categories.
- Restore deleted categories.
- Hard delete categories.

Seller category requests are part of the seller journey. Sellers can request categories; admin approves or rejects them.

### 5.6 Coupon Management

Admin can manage platform-level coupons and seller-level coupons.

Platform coupon capabilities include:

- View all coupons.
- View active coupons.
- Create coupons.
- Edit coupons.
- Soft delete coupons.
- Restore deleted coupons.
- Permanently delete coupons.
- Validate coupons during checkout.

Seller coupon capabilities from admin side include:

- View seller coupons grouped by seller.
- Filter by seller, active status, coupon type, recycle bin, and search terms.
- Create coupons on behalf of a seller.
- Edit seller coupons.
- Soft delete, restore, or hard delete seller coupons.

### 5.7 Order Management

Admin has full order visibility and can manage order progress.

Admin order capabilities include:

- View all orders.
- View detailed orders with customer and seller details.
- Filter orders by status, payment status, date range, search, and order type.
- View orders by seller.
- Update order or sub-order status.
- Update tracking information.
- Backfill order notifications.
- Export sales data.
- View sales analytics.
- View GST reports.

Order statuses are managed through backend order status rules. For multi-seller orders, individual seller sub-orders can have their own status while the parent order tracks the overall state.

### 5.8 Refund Management

Admin can manage customer and guest refund requests.

Admin refund capabilities include:

- View all refund requests.
- Review refund request details.
- Approve refund requests.
- Reject refund requests.
- Mark refund requests completed.
- Add admin response/message where supported.

Sellers can view refund requests related to their own orders, but admin controls the overall marketplace refund management.

### 5.9 Commission and Payout Management

Admin can configure commissions and monitor seller payout requests.

Admin commission capabilities include:

- View commission plans.
- Create commission plans.
- Edit commission plans.
- Set default commission.
- Delete commission plans.
- Assign commission plans to sellers.
- View commission earned per order.
- View commission earned summaries.
- View commission earned by order.
- Update commission earned status.
- View payout requests.
- Approve or reject payout requests.
- Debug seller balance if required.

The seller onboarding page currently communicates a marketplace commission of 10 percent of product sale value, with Stripe fees handled separately by Stripe.

### 5.10 Blog and Content Management

Admin can manage blog listing and blog content.

Blog capabilities include:

- View all public published blogs.
- View all admin blogs regardless of status.
- Create a blog.
- Edit blog details.
- Upload blog images.
- Delete blogs.
- Toggle publish/draft status.

The public website includes blog listing and blog detail pages.

### 5.11 GST, Shipping, Settings, and Operational Tools

Admin can manage marketplace configuration and operational settings.

GST capabilities:

- Create GST setting.
- View all GST settings.
- View active/default GST setting.
- Edit GST setting.
- Delete GST setting.
- Toggle GST active status.
- Set default GST setting.
- View GST reconciliation/reporting areas.

Shipping capabilities:

- Create shipping method.
- View all shipping methods.
- View active shipping methods for checkout.
- Edit shipping method.
- Delete shipping method.
- Toggle shipping method status.
- View international shipping settings/zones/rates.
- Toggle international shipping setting.

Other admin operations:

- Sponsored sections management.
- Newsletter management.
- Feedback review and deletion.
- Support ticket visibility.
- Site settings.
- Audit logs.
- User recycle bin and restore.
- User cleanup and PII anonymization tools.

## 6. Seller Journey

### 6.1 Seller Onboarding

Sellers start from the public website seller onboarding page:

- Website route: /sellerOnboarding
- Backend prefixes: /api/sellers and /api/seller-onboarding

Seller onboarding supports the following process:

- Initial seller application.
- Email OTP verification.
- Password setup.
- Resume onboarding with OTP if the seller started but did not finish.
- Forgot password and reset password.
- ABN validation during onboarding.
- Business details submission.
- Cultural identity / artist information.
- Store profile creation with store logo upload.
- KYC document upload.
- Bank details submission.
- Stripe Connect OAuth setup for seller payouts.
- Seller submits application for review.
- Admin reviews/approves seller as required.

Current onboarding form areas include:

- Email
- Phone
- Contact person
- Password
- Business name
- ABN
- Business type
- Business phone
- Business address
- Artist name
- Description
- Store name
- Store logo
- Store bio
- First name
- Last name
- Date of birth
- ID document
- Document type
- Bank name
- Account name
- BSB
- Account number
- Stripe payout account setup

Important seller onboarding notes:

- Seller documents and store logos are uploaded as seller documents/media.
- ABN can be validated before final submission.
- Seller can resume onboarding if interrupted.
- Stripe Connect is required for seller payouts.
- Sellers are told to complete Stripe setup before selling.
- After verification, seller account activation allows product listing.

### 6.2 Seller Login and Dashboard Access

Sellers can log in through the website or dashboard flow. After login, seller dashboard access is available at:

- https://dashboard.madeinarnhemland.com.au/sellerdashboard

Seller dashboard areas include:

- Seller dashboard home
- Products
- Product detail/edit
- Orders
- Order detail
- Refunds
- Categories
- Category detail
- Coupons
- Earnings
- Analytics
- Invoice
- Notifications
- Profile
- Bank details
- Settings
- Help

### 6.3 Seller Product Journey

Seller product capabilities include:

- Add product.
- Upload product images.
- View own products.
- View product detail.
- Edit own products.
- Manage simple products.
- Manage variable products with variants.
- Bulk save variants.
- Update variants.
- Toggle variant active/inactive status.
- View stock.
- Bulk stock updates.
- Deactivate own active products with a reason.
- Submit inactive or rejected product for admin review.
- Soft delete product to recycle bin.
- View recycle bin.
- Restore deleted product.

Product types supported:

- Simple product: one price/stock.
- Variable product: multiple variants such as size/color, each with its own price and stock.

Seller product approval:

- Seller creates or updates product.
- Product may require admin approval before public listing.
- Seller can resubmit inactive/rejected products for review.
- Admin approves/rejects/activates/deactivates as required.

### 6.4 Seller Category Request Journey

Seller category capabilities include:

- View approved categories.
- Request a new category.
- View category detail.
- View category audit logs for own categories.
- Resubmit rejected category request after editing.
- Soft delete own categories where permitted.

Admin approves or rejects seller category requests.

### 6.5 Seller Order Journey

Seller order capabilities include:

- View all orders received by the seller.
- View order details.
- Update order status.
- Bulk update order status.
- Update tracking number and estimated delivery.
- Export sales report as CSV.
- View sales analytics.
- View refund requests for orders containing seller products.
- View refund request details for seller-owned order items.

Common order status flow:

- Confirmed
- Processing
- Shipped
- Delivered
- Cancelled/Refund-related states where applicable

For multi-seller checkout, each seller can manage their own sub-order status. Customers can see seller-specific progress for multi-seller orders.

### 6.6 Seller Coupons

Seller coupon capabilities include:

- Create seller coupon for their own store.
- View own seller coupons.
- View a single seller coupon.
- Update seller coupon.
- Soft delete seller coupon.
- Restore seller coupon.
- Permanently delete seller coupon from recycle bin.

Customers can browse active seller coupons and apply seller coupons to cart items.

### 6.7 Seller Earnings and Payouts

Seller dashboard includes earnings/analytics areas. Backend supports seller sales analytics, sales export, commission earned tracking, payout request workflows, and Stripe Connect payout setup.

Stripe Connect is used for seller payment routing and payout account status.

### 6.8 Seller Bank Details

Seller bank capabilities include:

- Submit bank details during onboarding.
- View current masked bank details in dashboard.
- Request bank details change.
- View bank change request history.

Admin reviews and approves/rejects bank change requests.

## 7. Customer Journey

### 7.1 Customer Signup and Login

Customers can sign up and log in from the main website. Authentication supports:

- Signup
- OTP verification
- Resend OTP
- Login
- Login OTP verification
- Forgot password
- Reset password
- Logout
- Dashboard SSO ticket exchange between website and dashboard

Customer dashboard is available under the dashboard portal:

- https://dashboard.madeinarnhemland.com.au/customerdashboard

Customer dashboard areas include:

- Dashboard home
- Orders
- Order detail
- Wishlist
- Profile
- Notifications
- Settings
- Return policy

### 7.2 Browse and Product Discovery

Customers can:

- Visit the main website.
- Browse product listing.
- Open product detail pages.
- View product images, price, stock, variants, and seller/product information.
- Read blogs and content pages.
- Use active coupons where applicable.

Products support simple and variable variants. For variable products, customers select the required variant before adding to cart.

### 7.3 Cart Journey

Authenticated customers can:

- Add product to cart.
- Add simple product using product ID and quantity.
- Add variable product using product ID, variant ID, and quantity.
- View cart.
- Update quantity.
- Remove product from cart.
- Sync guest cart after login.
- View checkout options such as shipping and GST.
- Apply coupons.

Guest users can calculate guest cart totals without authentication.

### 7.4 Wishlist Journey

Authenticated customers can:

- View wishlist.
- Add product to wishlist.
- Remove product from wishlist.
- Remove wishlist item by item ID.
- Toggle product in wishlist.
- Check whether a product is in wishlist.
- Clear wishlist.
- Move wishlist item to cart.
- Clean up invalid wishlist items for variant products.

### 7.5 Checkout and Payment Journey

Registered customers check out through Stripe PaymentIntent flow.

Checkout steps:

- Customer adds products to cart.
- Customer opens cart/checkout.
- System reads cart server-side.
- Customer selects shipping method and enters shipping address.
- Customer optionally applies GST/coupon details.
- Backend creates Stripe PaymentIntent.
- Frontend mounts Stripe Payment Element using returned client secret.
- Customer confirms payment.
- Backend confirms payment and creates/updates order records.
- Customer receives order confirmation and can track from dashboard.

The backend also supports PayPal environment variables, but the current documented cart/order guide focuses on Stripe checkout.

### 7.6 Customer Order Management

Authenticated customers can:

- View their orders.
- View order detail.
- Track order status.
- Cancel eligible orders.
- Request refund or partial refund.
- Track refund requests.
- View a single refund request.
- Reorder from previous order.
- Download full invoice PDF.
- Download sub-order invoice PDF where applicable.

Invoice behavior:

- Authenticated invoice route is available for customers, users, sellers, and admin.
- Public invoice route exists for email invoice download.
- Guest invoice route exists for guest order access.

### 7.7 Customer Reorder

Customers can reorder from a previous order. The reorder action adds all eligible items from a previous order back into the cart. Product/variant stock should still be checked before final checkout.

## 8. Guest Customer Journey

Guest customers can place orders without account login.

Guest capabilities include:

- Browse website.
- Add products to guest cart on frontend.
- Calculate guest cart totals.
- Checkout through Stripe.
- Track order by order ID and email.
- Download guest invoice by verified order details.
- Cancel eligible guest order by order ID and customer email.
- Find delivered items eligible for refund.
- Create guest refund request.
- Track guest refund requests.
- View single guest refund request.

Guest checkout notes:

- Guest checkout is Stripe-only.
- Guest order tracking requires order ID and customer email.
- Guest cancellation is only allowed for eligible orders, such as orders still in confirmed state.
- Guest refund and cancellation endpoints are rate-limited.

Guest website routes include:

- /guest/track-order
- /guest/refund
- /guest/order-success

## 9. Order, Invoice, Refund, and Tracking Summary

Order handling supports:

- Registered customer orders.
- Guest orders.
- Multi-seller orders.
- Seller sub-orders.
- Parent order status and seller-specific sub-order statuses.
- Tracking numbers and estimated delivery.
- Invoice generation using PDFKit.
- Public invoice download links.
- Refund request tracking for customers and guests.
- Seller refund visibility for seller-owned items.
- Admin refund approval/rejection/completion.

Multi-seller order behavior:

- One customer order can contain products from multiple sellers.
- Backend tracks sub-orders per seller.
- Sellers manage status/tracking for their own sub-orders.
- Customer and guest order tracking can show product/seller-specific progress.

## 10. Media Uploads and Storage

Media uploads are stored in DigitalOcean Spaces.

DigitalOcean Spaces is used for:

- Product images.
- Blog images.
- Seller documents.
- Store logos.
- Uploaded media assets.

Backend environment variables related to media/storage include:

- DO_SPACES_BUCKET
- DO_SPACES_CDN_ENDPOINT
- DO_SPACES_ENDPOINT
- DO_SPACES_KEY
- DO_SPACES_REGION
- DO_SPACES_SECRET

The codebase also contains legacy Cloudinary variables and migration scripts, but current handover notes should treat DigitalOcean Spaces as the active media upload destination.

## 11. Database

The database is hosted in the DigitalOcean setup. The backend uses Prisma as the ORM.

Backend database configuration:

- Prisma schema: prisma/schema.prisma
- Migration folder: prisma/migrations
- Database connection variable: DATABASE_URL
- Backend Prisma client config: config/prisma.js

Database maintenance should be handled carefully through the backend project and production environment variables.

## 12. Environment Files and Production Access Notes

Environment values are stored both in DigitalOcean and in code files on the droplet. Secret values should not be shared in client-facing email or documents unless the client explicitly requests secure credential transfer.

Production droplet access instructions provided:

Backend:

- Open DigitalOcean droplet web console.
- Run: cd mia-be
- Open env file: nano .env

Main website frontend:

- Open DigitalOcean droplet web console.
- Run: cd mia-fe
- Open env file: nano .env.local

Dashboard frontend:

- Open DigitalOcean droplet web console.
- Run: cd mia-dashboard-fe
- Open env file: nano .env.local

Maintenance note:

- In the local dashboard repository, the environment file currently appears as .env rather than .env.local. On the droplet, check both .env.local and .env if a value is not found.

Backend environment variable groups include:

- App URLs: FRONTEND_URL, DASHBOARD_URL, BACKEND_URL
- Database: DATABASE_URL
- Authentication/session: JWT_SECRET, SESSION_KEY
- SAML/AuthPoint: SAML_ENTRY_POINT, SAML_CALLBACK_URL, SAML_IDP_CERT
- Stripe: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_CLIENT_ID, STRIPE_WEBHOOK_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET
- PayPal: PAYPAL_MODE, PAYPAL_BASE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID
- DigitalOcean Spaces: DO_SPACES_BUCKET, DO_SPACES_CDN_ENDPOINT, DO_SPACES_ENDPOINT, DO_SPACES_KEY, DO_SPACES_REGION, DO_SPACES_SECRET
- Email: SENDER_EMAIL, SENDER_NAME, REPLY_TO_EMAIL, FINANCE_EMAIL_RECEIVER, DUO_CIRCLE_USER, DUO_CIRCLE_PASS
- Location: MAPBOX_ACCESS_TOKEN
- ABN validation: ABN_GUID
- Runtime: NODE_ENV

Frontend website environment variable currently includes:

- NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN

Dashboard frontend environment variable currently includes:

- NEXT_PUBLIC_API_URL

## 13. Codebase Structure

Backend repository: mia-be

Key backend folders:

- controllers: business logic for admin, sellers, products, orders, cart, coupons, blogs, etc.
- routes: API route definitions.
- middlewares: authentication, role checks, upload handling, rate limiting.
- prisma: schema and migrations.
- utils: invoice generation, email, Stripe/commission helpers, schedulers, stock sockets, audit logger.
- uploads: local uploaded files from development or legacy/local storage.

Main website repository: mia-fe

Key frontend areas:

- app/page.tsx: homepage.
- app/shop: public shop listing and product detail pages.
- app/cart and app/shop/cart: cart pages.
- app/checkout: checkout flow.
- app/sellerOnboarding: seller onboarding.
- app/guest/track-order: guest tracking.
- app/guest/refund: guest refund.
- app/blog: blog listing/detail.
- hooks: cart, wishlist, product, auth, coupon, and stock hooks.
- components/checkout: checkout and Stripe payment forms.

Dashboard repository: mia-dashboard-fe

Key dashboard areas:

- app/(admindashboard)/admindashboard: admin dashboard pages.
- app/(sellerdashboard)/sellerdashboard: seller dashboard pages.
- app/(customerdashboard)/customerdashboard: customer dashboard pages.
- app/(auth): login, register, forgot password, callbacks, verification.
- components/shared: shared dashboard components, notifications, refund dialog, audit history.
- lib/api.ts: API client configuration.

## 14. Backend API Summary

Primary backend route prefixes include:

- /api/auth
- /api/upload
- /api/products
- /api/cart
- /api/orders
- /api/seller/orders
- /api/sellers
- /api/seller-onboarding
- /api/support
- /api/admin
- /api/ratings
- /api/users
- /api/coupons
- /api/seller-coupons
- /api/notifications
- /api/wishlist
- /api/categories
- /api/shipping
- /api/gst
- /api/feedback
- /api/payments
- /api/blogs
- /api/commissions
- /api/public

## 15. Background Jobs and Automation

The backend starts several scheduled/automated tasks after server startup:

- SLA monitoring.
- Low-stock product scan/deactivation scheduler.
- Order notification backfill.
- User cleanup scheduler for expired deleted users and PII anonymization.
- GST report scheduler.
- Email verification reminder scheduler.
- Socket.io stock bridge for real-time stock updates.

## 16. Security and Access Control

The backend uses authentication middleware and role checks to restrict access.

Access patterns:

- Admin routes use admin middleware.
- Seller routes use seller authentication.
- Shared seller/admin operations use role checks for SELLER, ADMIN, or SUPER_ADMIN.
- Customer routes use authenticated user checks.
- Guest flows avoid account login but require order ID/email verification and rate limiting for sensitive actions.
- SAML/AuthPoint is configured for admin login flow.

Important handover recommendation:

- Do not expose secret values in general documentation.
- Transfer credentials through a secure channel only.
- Confirm which client staff require admin access.
- Rotate any shared admin credentials after handover if applicable.
- Keep DigitalOcean, Stripe, email, and database credentials restricted to authorized technical owners.

## 17. Recommended Client Handover Checklist

Before final handover, confirm the following items with the client:

- Client has access to DigitalOcean droplet.
- Client has access to DigitalOcean Spaces bucket.
- Client has database access or database backup procedure.
- Client has Stripe account/admin access.
- Client has email provider access.
- Client has domain/DNS access for madeinarnhemland.com.au.
- Client has admin dashboard login.
- Client understands how seller approval works.
- Client understands how product approval works.
- Client understands how refunds are reviewed and completed.
- Client understands how seller payouts and Stripe Connect work.
- Client knows where environment files are stored.
- Client knows where the three codebases are located on the droplet.
- Client has a process for requesting future updates.

## 18. Operational Notes for Client

Day-to-day admin operations should be done from the dashboard portal:

- Review new sellers.
- Approve/reject seller applications.
- Review new products.
- Approve/reject products.
- Monitor orders and seller fulfilment.
- Manage refunds.
- Manage coupons and seller coupons.
- Manage categories.
- Update shipping/GST settings if required.
- Review commissions and payouts.
- Publish or update blogs.
- Review feedback and support requests.

Technical operations should be handled by a developer or technical administrator:

- Environment file updates.
- Database migrations.
- Backend deployment/restart.
- Frontend deployment/restart.
- Media bucket configuration.
- Stripe webhook changes.
- SAML/AuthPoint changes.
- DNS/domain changes.

## 19. Known Production Infrastructure Summary

Hosting:

- DigitalOcean droplet hosts the code for backend, frontend website, and dashboard frontend.

Code locations on droplet:

- mia-be: backend API
- mia-fe: main website frontend
- mia-dashboard-fe: dashboard frontend

Media:

- DigitalOcean Spaces bucket is used for uploads.

Database:

- Database is hosted in the DigitalOcean environment and connected through DATABASE_URL.

Environment:

- Backend env file: mia-be/.env
- Website env file: mia-fe/.env.local
- Dashboard env file: mia-dashboard-fe/.env.local, with note to also check .env if needed

## 20. Final Summary

The Made in Arnhem Land platform is ready to be handed over as a multi-vendor marketplace with clear role-based journeys:

- Admin manages the full marketplace from the dashboard portal, including sellers, products, orders, refunds, categories, coupons, blogs, commissions, payouts, shipping, GST, users, feedback, and settings.
- Sellers onboard through the website, complete OTP/ABN/KYC/store/bank/Stripe setup, then manage products, categories, coupons, orders, tracking, analytics, earnings, bank changes, and refunds from the seller dashboard.
- Customers shop from the main website and manage cart, wishlist, checkout, orders, cancellations, refunds, reorder, invoices, tracking, profile, and notifications.
- Guests can place orders, track orders, cancel eligible orders, request refunds, and download invoices using order ID and email verification.

All three applications are connected to the backend API and production services hosted through the DigitalOcean environment.
