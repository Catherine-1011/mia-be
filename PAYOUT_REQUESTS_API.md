# Seller Payout Requests — API Integration Guide

> **Audience:** Frontend / Dashboard Team (Seller Portal & Admin Dashboard)
> **Base URL:** All seller endpoints are prefixed with `/api/commissions`, admin endpoints with `/api/admin/commissions`
> **Auth:** Every protected endpoint requires a Bearer token in the `Authorization` header
> **Last Updated:** March 10, 2026

```
Authorization: Bearer <jwt_token>
```

---

## Quick Reference

| # | Who | Method | Endpoint | Purpose |
|---|-----|--------|----------|---------|
| 1 | Seller | `GET` | `/api/commissions/payout/redeemable` | Get redeemable vs locked balance summary |
| 2 | Seller | `POST` | `/api/commissions/payout/request` | Submit a payout request |
| 3 | Seller | `GET` | `/api/commissions/payout/requests` | View own payout request history |
| 4 | Seller | `GET` | `/api/commissions/earned/my` | View individual commission records (updated — now includes redeemable split) |
| 5 | Admin | `GET` | `/api/admin/commissions/payout-requests` | List all payout requests across all sellers |
| 6 | Admin | `PUT` | `/api/admin/commissions/payout-requests/:id/status` | Approve / Reject / Complete a payout request |

---

## Table of Contents

1. [Overview & Concept](#1-overview--concept)
2. [Immediate Payout Availability](#2-immediate-payout-availability)
3. [How the Payout Cycle Works](#3-how-the-payout-cycle-works)
4. [Seller Endpoints](#4-seller-endpoints)
   - 4.1 [Get Redeemable Balance Summary](#41-get-apicommissionspayoutredeemable)
   - 4.2 [Submit a Payout Request](#42-post-apicommissionspayoutrequest)
   - 4.3 [My Payout Request History](#43-get-apicommissionspayoutrequests)
   - 4.4 [My Commission Earned (Updated)](#44-get-apicommissionsearned-my-updated)
5. [Admin Endpoints](#5-admin-endpoints)
   - 5.1 [List All Payout Requests](#51-get-apiadmincommissionspayout-requests)
   - 5.2 [Update Payout Request Status](#52-put-apiadmincommissionspayout-requestsidstatus)
6. [Data Models](#6-data-models)
7. [Status Reference](#7-status-reference)
8. [Error Reference](#8-error-reference)
9. [UI Implementation Guide](#9-ui-implementation-guide)

---

## 1. Overview & Concept

When a customer places an order, the platform automatically records a **Commission Earned** entry for every seller whose products appear in that order. Each record tracks:

- **Order Value** — the seller's gross share (their items × quantity)
- **Commission Amount** — the platform fee deducted (e.g. 10%)
- **Net Payable** — the amount the seller is owed (`orderValue − commissionAmount`)

Previously, net payable amounts simply accumulated with a manual admin `PAID` mark. With this feature, sellers can **actively request payouts** against their available ("redeemable") balance through their dashboard.

**Key rules:**
- All PENDING commission earnings are **immediately available** for payout — no waiting period required.
- A seller can only have **one open (PENDING) payout request** at a time.
- A seller may request a **partial amount** (up to their full redeemable balance) or leave the amount blank to request the full redeemable balance.
- All amounts are in **AUD**.

---

## 2. The 30-Day Eligibility Rule

Every `commission_earned` record has a `createdAt` timestamp set when the order was placed. The redeemable split works as follows:

```
Total Net Payable (PENDING)
        │
        ├── created_at ≤ 30 days ago  →  redeemableAmount  ✅ Can request payout
        └── created_at > 30 days ago  →  lockedAmount       🔒 Not yet eligible
```

**Example:**

| Order | Order Date | Net Payable | Eligible? |
|-------|-----------|-------------|-----------|
| #1    | Jan 1     | $90.00      | ✅ Yes    |
| #2    | Jan 5     | $90.00      | ✅ Yes    |
| #3    | Jan 10    | $90.00      | ✅ Yes    |
| #4    | Feb 25    | $90.00      | ✅ Yes    |
| #5    | Feb 28    | $90.00      | ✅ Yes    |
| #6    | Mar 3     | $90.00      | ✅ Yes    |
| #7    | Mar 5     | $90.00      | ✅ Yes    |
| #8    | Mar 7     | $90.00      | ✅ Yes    |
| #9    | Mar 9     | $90.00      | ✅ Yes    |
| #10   | Mar 10    | $90.00      | ✅ Yes    |

> All pending commission earnings are immediately available for withdrawal.

| Field               | Value    |
|---------------------|---------|
| Total Net Payable   | $900.00  |
| **Redeemable Now**  | **$900.00** ✅ |
| Locked              | $0.00    |

The seller can request a payout of **up to $900.00** immediately.

---

## 3. How the Payout Cycle Works

```
Order placed → commission_earned record created
               status = PENDING, created_at = now()
                           │
                  ┌────────┴────────┐
                  │ PENDING earnings │
                  │ redeemableAmount │
                  │ (immediately     │
                  │ available) ✅    │
                  └────────┬────────┘
                           │
             Seller views redeemable balance
             GET /api/commissions/payout/redeemable
                           │
             Seller submits payout request
             POST /api/commissions/payout/request
             { requestedAmount: 900.00 }  ← optional (defaults to full redeemable)
                           │
             payout_requests record created
             status = PENDING
                           │
             ┌─────────────┴──────────────┐
             │                            │
         Admin APPROVES              Admin REJECTS
         (in-review / confirmed)     (with reason)
             │                            │
             │                     Seller notified
             ▼                     (status = REJECTED)
         Admin transfers funds externally
         (bank transfer to seller's registered bank account)
             │
         Admin marks COMPLETED
         PUT /api/admin/commissions/payout-requests/:id/status
         { status: "COMPLETED" }
             │
             ▼
         All eligible commission_earned rows for that seller
         automatically marked PAID ✅
```

> **Important:** The platform does **not** execute bank transfers automatically. Admin must complete the transfer externally and then mark the request as `COMPLETED`.

---

## 4. Seller Endpoints

> All seller endpoints require a user with role `SELLER`.

---

### 4.1 `GET /api/commissions/payout/redeemable`

Returns the seller's current balance split — total pending, redeemable (eligible for payout), locked, and total already paid. Also returns any open payout request so the UI can prevent duplicate submissions.

**Example Request**

```http
GET /api/commissions/payout/redeemable
Authorization: Bearer <seller_token>
```

**Example Response `200 OK`**

```json
{
  "success": true,
  "summary": {
    "totalPending": 900.00,
    "redeemableAmount": 450.00,
    "lockedAmount": 450.00,
    "totalPaid": 270.00,
    "eligibleOrderCount": 5
  },
  "pendingPayoutRequest": null
}
```

**Example Response when a payout request is already open:**

```json
{
  "success": true,
  "summary": {
    "totalPending": 900.00,
    "redeemableAmount": 450.00,
    "lockedAmount": 450.00,
    "totalPaid": 270.00,
    "eligibleOrderCount": 5
  },
  "pendingPayoutRequest": {
    "id": "pr_abc123",
    "requestedAmount": "450.00",
    "redeemableAtRequest": "450.00",
    "createdAt": "2026-03-10T08:00:00.000Z"
  }
}
```

**Field Descriptions**

| Field | Description |
|-------|-------------|
| `totalPending` | Total net payable across all PENDING commission records |
| `redeemableAmount` | Equal to `totalPending` - all earnings are immediately available |
| `lockedAmount` | Always 0 - no payout restrictions |
| `totalPaid` | Sum of net payable already marked as PAID (historical payouts) |
| `eligibleOrderCount` | Number of commission records contributing to `redeemableAmount` |
| `pendingPayoutRequest` | Open payout request if one exists, otherwise `null` |

---

### 4.2 `POST /api/commissions/payout/request`

Submit a payout request. The `requestedAmount` is optional — if omitted the full redeemable balance is requested.

**Request Body**

```json
{
  "requestedAmount": 250.00,
  "note": "Monthly payout — March 2026"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `requestedAmount` | number | No | Amount to request. Must be ≤ redeemable balance. Defaults to full redeemable balance if omitted. |
| `note` | string | No | Optional message from the seller to admin |

**Example Request**

```http
POST /api/commissions/payout/request
Authorization: Bearer <seller_token>
Content-Type: application/json

{
  "requestedAmount": 250.00,
  "note": "Monthly payout — March 2026"
}
```

**Example Response `201 Created`**

```json
{
  "success": true,
  "message": "Payout request submitted successfully.",
  "payoutRequest": {
    "id": "pr_abc123",
    "requestedAmount": "250.00",
    "redeemableAtRequest": "450.00",
    "status": "PENDING",
    "createdAt": "2026-03-10T08:00:00.000Z"
  }
}
```

**Validation Rules**

| Scenario | Status | Message |
|----------|--------|---------|
| Already has an open PENDING request | `400` | "You already have a pending payout request..." |
| No redeemable amount available | `400` | "No redeemable amount available. You have no pending commission earnings..." |
| `requestedAmount` exceeds redeemable balance | `400` | "Requested amount ($X) exceeds your redeemable balance ($Y)" |
| `requestedAmount` is zero or negative | `400` | "requestedAmount must be a positive number" |

---

### 4.3 `GET /api/commissions/payout/requests`

View the seller's own payout request history, paginated.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Page number (default: `1`) |
| `limit` | integer | No | Records per page, max 50 (default: `20`) |

**Example Request**

```http
GET /api/commissions/payout/requests?page=1&limit=20
Authorization: Bearer <seller_token>
```

**Example Response `200 OK`**

```json
{
  "success": true,
  "data": [
    {
      "id": "pr_abc123",
      "requestedAmount": "250.00",
      "redeemableAtRequest": "450.00",
      "status": "COMPLETED",
      "sellerNote": "Monthly payout — March 2026",
      "adminNote": "Paid via ANZ transfer",
      "processedAt": "2026-03-12T14:00:00.000Z",
      "createdAt": "2026-03-10T08:00:00.000Z",
      "updatedAt": "2026-03-12T14:00:00.000Z"
    },
    {
      "id": "pr_def456",
      "requestedAmount": "450.00",
      "redeemableAtRequest": "450.00",
      "status": "PENDING",
      "sellerNote": null,
      "adminNote": null,
      "processedAt": null,
      "createdAt": "2026-03-10T09:00:00.000Z",
      "updatedAt": "2026-03-10T09:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 2,
    "totalPages": 1
  }
}
```

---

### 4.4 `GET /api/commissions/earned/my` (Updated)

The existing endpoint for viewing individual commission records. The `totals` object now shows immediate availability for all pending earnings.

**Example Response `200 OK` (totals section — updated)**

```json
{
  "success": true,
  "data": [ ...commission records... ],
  "totals": {
    "totalOrderValue": 1000.00,
    "totalCommissionDeducted": 100.00,
    "totalNetPayable": 900.00,
    "totalPaid": 270.00,
    "totalPending": 630.00,
    "redeemableAmount": 450.00,
    "lockedAmount": 180.00,
    "eligibleOrderCount": 5
  },
  "pagination": { ... }
}
```

> **Note:** Use [4.1 Redeemable Summary](#41-get-apicommissionspayoutredeemable) for the wallet/balance header card. Use this endpoint for the detailed commission records table.

---

## 5. Admin Endpoints

> All admin endpoints require a user with role `ADMIN`.

---

### 5.1 `GET /api/admin/commissions/payout-requests`

List all payout requests across all sellers, with full seller and bank details included. Supports filtering and pagination.

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page` | integer | No | Page number (default: `1`) |
| `limit` | integer | No | Records per page, max 100 (default: `20`) |
| `status` | string | No | Filter by status: `PENDING`, `APPROVED`, `REJECTED`, `COMPLETED` |
| `sellerId` | string | No | Filter by a specific seller's user ID |
| `from` | ISO date | No | Filter requests created on or after this date |
| `to` | ISO date | No | Filter requests created on or before this date |

**Example Request**

```http
GET /api/admin/commissions/payout-requests?status=PENDING&page=1
Authorization: Bearer <admin_token>
```

**Example Response `200 OK`**

```json
{
  "success": true,
  "data": [
    {
      "id": "pr_abc123",
      "sellerId": "user_seller1",
      "requestedAmount": "250.00",
      "redeemableAtRequest": "450.00",
      "status": "PENDING",
      "sellerNote": "Monthly payout — March 2026",
      "adminNote": null,
      "processedAt": null,
      "processedBy": null,
      "createdAt": "2026-03-10T08:00:00.000Z",
      "updatedAt": "2026-03-10T08:00:00.000Z",
      "sellerName": "Jane Doe",
      "storeName": "Artisan Co.",
      "businessName": "Artisan Pty Ltd",
      "bankDetails": {
        "bankName": "ANZ",
        "accountName": "Jane Doe",
        "bsb": "012-345",
        "accountNumber": "123456789"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 7,
    "totalPages": 1
  }
}
```

**Field Descriptions**

| Field | Description |
|-------|-------------|
| `requestedAmount` | The amount the seller requested for payout |
| `redeemableAtRequest` | Snapshot of their redeemable balance when the request was submitted |
| `status` | Current status of the payout request |
| `sellerNote` | Optional note from the seller |
| `adminNote` | Admin note added when processing |
| `processedAt` | Timestamp when the request was actioned |
| `processedBy` | userId of the admin who processed it |
| `bankDetails` | Seller's registered bank details — use this to execute the transfer |

---

### 5.2 `PUT /api/admin/commissions/payout-requests/:id/status`

Update the status of a payout request. Use this to progress a request through the workflow.

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | The payout request ID |

**Request Body**

```json
{
  "status": "COMPLETED",
  "adminNote": "Paid via ANZ transfer on 12 March 2026"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | Yes | One of: `APPROVED`, `REJECTED`, `COMPLETED` |
| `adminNote` | string | No | Note visible to admin (e.g. transfer reference) |

**Valid Status Transitions**

```
PENDING → APPROVED    (admin confirms they will process it)
PENDING → REJECTED    (admin declines with a reason — include adminNote)
APPROVED → COMPLETED  (admin has transferred funds externally)
PENDING → COMPLETED   (shortcut — skip APPROVED if processing immediately)
```

**Example Request**

```http
PUT /api/admin/commissions/payout-requests/pr_abc123/status
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "status": "COMPLETED",
  "adminNote": "Paid via ANZ bank transfer — ref TXN98765"
}
```

**Example Response `200 OK`**

```json
{
  "success": true,
  "message": "Payout request marked as COMPLETED"
}
```

> **Auto-PAID side effect on COMPLETED:** When a request is marked `COMPLETED`, the server automatically marks every eligible `commission_earned` record for that seller (status = `PENDING`) as `PAID`. No manual action required.

**Validation**

| Scenario | Status | Message |
|----------|--------|---------|
| Invalid status value | `400` | "status must be one of: APPROVED, REJECTED, COMPLETED" |
| Payout request ID not found | `404` | "Payout request not found" |

---

## 6. Data Models

### PayoutRequest

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (cuid) | Unique ID |
| `sellerId` | string | The seller's user ID |
| `requestedAmount` | decimal | Amount the seller requested |
| `redeemableAtRequest` | decimal | Snapshot of redeemable balance at time of submission |
| `status` | PayoutRequestStatus | Current status (see below) |
| `sellerNote` | string \| null | Optional note from the seller |
| `adminNote` | string \| null | Admin note added during processing |
| `processedAt` | datetime \| null | When the request was actioned |
| `processedBy` | string \| null | Admin userId who processed it |
| `createdAt` | datetime | When the request was submitted |
| `updatedAt` | datetime | Last updated |

### CommissionEarned (unchanged — reference)

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique ID |
| `orderId` | string | The order that triggered this commission |
| `sellerId` | string | Seller's user ID |
| `orderValue` | decimal | Seller's gross order total |
| `commissionRate` | decimal | Platform rate used (% or flat) |
| `commissionAmount` | decimal | Platform fee deducted |
| `netPayable` | decimal | Amount owed to seller |
| `status` | CommissionStatus | `PENDING` \| `PAID` \| `CANCELLED` |
| `createdAt` | datetime | When the commission record was created (= order date) |

---

## 7. Status Reference

### PayoutRequestStatus

| Status | Meaning | Who Sets It |
|--------|---------|-------------|
| `PENDING` | Request submitted, awaiting admin review | System (on submission) |
| `APPROVED` | Admin has confirmed and will process the transfer | Admin |
| `REJECTED` | Admin declined the request | Admin |
| `COMPLETED` | Transfer done; commission records auto-marked PAID | Admin |

### CommissionStatus

| Status | Meaning |
|--------|---------|
| `PENDING` | Accumulated but not yet paid out |
| `PAID` | Payout has been completed (auto-set when payout request = COMPLETED) |
| `CANCELLED` | Voided (e.g. order was refunded) |

---

## 8. Error Reference

| HTTP Status | `success` | Typical Cause |
|-------------|-----------|---------------|
| `400` | `false` | Validation failure — see `message` field for detail |
| `401` | `false` | Missing or expired Bearer token |
| `403` | `false` | Role mismatch (e.g. seller calling admin endpoint) |
| `404` | `false` | Resource not found (payout request ID invalid) |
| `500` | `false` | Server error — see `error` field |

---

## 9. UI Implementation Guide

### Seller Dashboard

#### Earnings / Wallet Card (Header)

Call `GET /api/commissions/payout/redeemable` on page load. Build a card like:

```
┌──────────────────────────────────────────────────────────────────────┐
│  My Earnings                                                         │
│                                                                      │
│  Total Pending     Redeemable Now    Locked          Total Paid      │
│  $900.00           $450.00 ✅        $450.00 🔒       $270.00        │
│                                                                      │
│  Eligible orders: 5                                                  │
│                                                                      │
│  [  Request Payout  ]   ← disabled if redeemableAmount = 0          │
│                         ← disabled if pendingPayoutRequest != null   │
└──────────────────────────────────────────────────────────────────────┘
```

- **Disable** the "Request Payout" button if:
  - `redeemableAmount === 0` → show tooltip: *"No pending earnings available for withdrawal at this time."*
  - `pendingPayoutRequest !== null` → show tooltip: *"You already have a pending payout request."*

#### Request Payout Modal

```
Amount to Request:  [ $450.00 ] (pre-filled with redeemableAmount, editable)
Note (optional):    [ ______________________________________________ ]

                                             [ Cancel ]  [ Submit Request ]
```

- Pre-fill the amount field with `summary.redeemableAmount`
- Validate client-side that the entered amount ≤ `redeemableAmount`
- On success (`201`), show a success banner and reload the wallet card
- On `400` (duplicate request), show the error message from the API

#### Payout Request History Tab

Call `GET /api/commissions/payout/requests`. Render a table:

| Submitted | Requested | Redeemable At Request | Status | Note | Admin Note |
|-----------|-----------|-----------------------|--------|------|------------|
| Mar 10    | $250.00   | $450.00               | 🟡 PENDING | ... | — |
| Feb 5     | $300.00   | $300.00               | ✅ COMPLETED | ... | Paid via ANZ |

**Status badge colours:**
- `PENDING` → Yellow
- `APPROVED` → Blue
- `REJECTED` → Red
- `COMPLETED` → Green

---

### Admin Dashboard

#### Payout Requests Page

Call `GET /api/admin/commissions/payout-requests` with optional filters. Render a table:

| Seller | Store | Requested | Redeemable At Request | Status | Submitted | Actions |
|--------|-------|-----------|----------------------|--------|-----------|---------|
| Jane Doe | Artisan Co. | $250.00 | $450.00 | 🟡 PENDING | Mar 10 | [Approve] [Reject] |
| John Smith | Craft House | $180.00 | $180.00 | 🔵 APPROVED | Mar 8 | [Complete] |

**Filter bar:** Status dropdown + date range pickers + Seller ID search field.

#### Payout Request Detail / Action Panel

When admin clicks a row, show a side panel or modal with:
- Full request details
- **Bank Details** — pulled from `bankDetails` field in the response
  ```
  Bank:           ANZ
  Account Name:   Jane Doe
  BSB:            012-345
  Account No.:    123456789
  ```
- Action buttons:

| Current Status | Available Actions |
|---------------|-------------------|
| `PENDING` | **Approve**, **Reject** (with note), **Complete** (shortcut) |
| `APPROVED` | **Complete** (with note), **Reject** |
| `REJECTED` | Read-only |
| `COMPLETED` | Read-only |

- When marking `COMPLETED`, prompt admin to add a transfer reference as the `adminNote`
- After a successful `COMPLETED` action, show a confirmation: *"X commission record(s) have been automatically marked as PAID."*

#### Summary Stats Card

Add to the existing commission summary cards:

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Pending Payout  │  │ Approved Payout  │  │ Completed Today  │
│  Requests        │  │ Requests         │  │                  │
│       7          │  │       3          │  │      $1,230.00   │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

These counts can be derived by calling `GET /api/admin/commissions/payout-requests?status=PENDING` and `?status=APPROVED` on page load.

---

*For questions about this integration, refer to the backend team or check `controllers/commission.js` and `routes/commissionRoute.js` / `routes/adminRoutes.js`.*
