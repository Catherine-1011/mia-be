# International Shipping Toggle — Integration Guide

## Overview

Admins can now enable or disable international shipping from the dashboard.
When disabled, only Australia shipping is available — both on the website (checkout) and in the cart API.

---

## Backend API Reference

### Public Endpoint (Website)

#### `GET /api/shipping/settings`
Returns whether international shipping is currently enabled.
No authentication required.

**Response:**
```json
{
  "success": true,
  "data": {
    "internationalShippingEnabled": true
  }
}
```

---

### Admin Endpoints (Dashboard)

#### `GET /api/admin/settings`
Returns all site settings. Requires admin authentication.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "global",
    "internationalShippingEnabled": true,
    "updatedAt": "2026-06-03T00:00:00.000Z"
  }
}
```

---

#### `PUT /api/admin/settings/international-shipping`
Enable or disable international shipping. Requires admin authentication.

**Request Body:**
```json
{
  "enabled": false
}
```

**Response (success):**
```json
{
  "success": true,
  "message": "International shipping disabled successfully",
  "data": {
    "id": "global",
    "internationalShippingEnabled": false,
    "updatedAt": "2026-06-03T00:00:00.000Z"
  }
}
```

**Response (bad request):**
```json
{
  "success": false,
  "message": "`enabled` (boolean) is required"
}
```

---

## Website (Frontend) Integration

### 1. Fetch the setting on the checkout/address page

Call this once when the address/shipping step loads:

```js
const fetchShippingSettings = async () => {
  const { data } = await axios.get('/api/shipping/settings');
  return data.data.internationalShippingEnabled; // true or false
};
```

---

### 2. Hide or lock the country dropdown

If `internationalShippingEnabled === false`, restrict the country selector to Australia only.

```jsx
const [intlEnabled, setIntlEnabled] = useState(true);

useEffect(() => {
  fetchShippingSettings().then(enabled => setIntlEnabled(enabled));
}, []);

// In the country dropdown:
const countryOptions = intlEnabled
  ? allCountries                          // show all countries
  : allCountries.filter(c => c.iso2 === 'AU'); // Australia only

// Optionally show a notice to the user:
{!intlEnabled && (
  <p className="text-sm text-red-500">
    International shipping is currently unavailable. We ship to Australia only.
  </p>
)}
```

---

### 3. Cart API behaviour when disabled

If a user somehow submits a non-Australia country while international shipping is disabled, the cart API will return:

```json
{
  "success": false,
  "message": "International shipping is currently unavailable. Only Australia shipping is available."
}
```

Handle this in your cart update / checkout flow:

```js
if (!response.data.success) {
  showError(response.data.message);
}
```

---

## Admin Dashboard Integration

### 1. Fetch current setting on the Settings page

```js
const fetchSettings = async () => {
  const { data } = await axios.get('/api/admin/settings', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  return data.data; // { id, internationalShippingEnabled, updatedAt }
};
```

---

### 2. Toggle UI component

```jsx
const [intlEnabled, setIntlEnabled] = useState(true);
const [saving, setSaving] = useState(false);

useEffect(() => {
  fetchSettings().then(s => setIntlEnabled(s.internationalShippingEnabled));
}, []);

const handleToggle = async (newValue) => {
  setSaving(true);
  try {
    const { data } = await axios.put(
      '/api/admin/settings/international-shipping',
      { enabled: newValue },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    if (data.success) {
      setIntlEnabled(newValue);
      showSuccess(data.message);
    }
  } catch (err) {
    showError('Failed to update setting');
  } finally {
    setSaving(false);
  }
};

// Render:
<div className="flex items-center justify-between">
  <div>
    <h3 className="font-semibold">International Shipping</h3>
    <p className="text-sm text-gray-500">
      When disabled, only Australia shipping will be available at checkout.
    </p>
  </div>
  <Toggle
    checked={intlEnabled}
    onChange={handleToggle}
    disabled={saving}
  />
</div>
```

---

## Behaviour Summary

| Admin sets | What happens on website |
|---|---|
| `enabled: true` (default) | All countries available at checkout |
| `enabled: false` | Country dropdown locked to Australia only + notice shown |

- The setting takes effect **immediately** — no cache, no restart needed.
- Existing orders are **not affected** — only new checkout sessions.
- Default value is `true` (international shipping enabled) after the migration.

---

## Production Setup (One-time)

Run this SQL on the production database before deploying:

```sql
-- File: add_site_settings.sql (already in the repo root)
CREATE TABLE IF NOT EXISTS "site_settings" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "internationalShippingEnabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "site_settings" ("id", "internationalShippingEnabled", "updatedAt")
VALUES ('global', true, NOW())
ON CONFLICT ("id") DO NOTHING;
```

Then deploy the backend and run `npm install` (no new packages — Prisma client was regenerated).
