# Newsletter Campaign — Frontend Dashboard Integration Guide

## Base URL
```
/api/newsletter/campaigns
```
All campaign endpoints require an **admin auth token** in the request header:
```
Authorization: Bearer <admin_token>
```

---

## API Endpoints

### 1. Create Campaign (or Save Draft)
```
POST /api/newsletter/campaigns
Content-Type: multipart/form-data
```
**Form fields:**
| Field | Type | Required |
|-------|------|----------|
| `subject` | text | Yes |
| `content` | text (HTML) | Yes |
| `bannerImage` | file (JPEG/PNG/WEBP, max 5 MB) | No |
| `buttonText` | text | No |
| `buttonLink` | text | No |
| `saveDraft` | text (`"true"`) | No |

- `bannerImage` is a **file upload** — the server uploads it to Cloudinary and stores the resulting URL
- To omit the banner, simply don't include the `bannerImage` field

**Response:**
```json
{
  "success": true,
  "message": "Campaign saved as draft.",
  "data": {
    "id": "uuid",
    "subject": "Our Summer Sale is Here!",
    "content": "<p>...</p>",
    "bannerImage": "https://...",
    "buttonText": "Shop Now",
    "buttonLink": "https://...",
    "status": "DRAFT",
    "totalRecipients": 0,
    "sentCount": 0,
    "failedCount": 0,
    "createdAt": "2026-05-25T10:00:00.000Z",
    "updatedAt": "2026-05-25T10:00:00.000Z",
    "sentAt": null
  }
}
```

---

### 2. List Campaigns
```
GET /api/newsletter/campaigns?page=1&limit=20&status=DRAFT
```
**Query params:**
| Param | Type | Description |
|-------|------|-------------|
| `page` | number | Page number (default: 1) |
| `limit` | number | Items per page (default: 20) |
| `status` | string | Filter by `DRAFT`, `SENDING`, or `SENT` (optional) |

**Response:**
```json
{
  "success": true,
  "data": [ ...campaigns ],
  "pagination": {
    "total": 42,
    "page": 1,
    "limit": 20,
    "totalPages": 3
  }
}
```

---

### 3. Get Single Campaign
```
GET /api/newsletter/campaigns/:id
```
**Response:**
```json
{
  "success": true,
  "data": { ...campaign }
}
```

---

### 4. Update Campaign (Draft only)
```
PUT /api/newsletter/campaigns/:id
Content-Type: multipart/form-data
```
**Form fields** (all optional — only send what changed):
| Field | Type | Notes |
|-------|------|-------|
| `subject` | text | |
| `content` | text (HTML) | |
| `bannerImage` | file (JPEG/PNG/WEBP, max 5 MB) | Replaces existing banner |
| `removeBanner` | text (`"true"`) | Pass this to clear the banner image |
| `buttonText` | text | |
| `buttonLink` | text | |

> Only campaigns with status `DRAFT` can be updated. Returns `400` otherwise.

---

### 5. Delete Campaign
```
DELETE /api/newsletter/campaigns/:id
```
- Can delete `DRAFT` or `SENT` campaigns
- Returns `400` if campaign is currently `SENDING`

**Response:**
```json
{
  "success": true,
  "message": "Campaign deleted successfully."
}
```

---

### 6. Send Campaign
```
POST /api/newsletter/campaigns/:id/send
```
- No body required
- Responds immediately; emails are sent in the background
- Campaign status changes: `DRAFT` → `SENDING` → `SENT`
- `sentCount` and `failedCount` are updated live during sending

**Response:**
```json
{
  "success": true,
  "message": "Campaign sending started. Sending to 320 subscribers.",
  "data": {
    "id": "uuid",
    "totalRecipients": 320
  }
}
```

---

## Campaign Status Reference

| Status | Meaning |
|--------|---------|
| `DRAFT` | Not sent yet — can edit, delete, or send |
| `SENDING` | Currently being sent — cannot edit or delete |
| `SENT` | Fully sent — read-only, can delete |

---

## Suggested Dashboard UI

### Page: Campaign List (`/admin/newsletter/campaigns`)

```
┌──────────────────────────────────────────────┐
│  Newsletter Campaigns         [+ New Campaign]│
├────────────┬──────────┬──────────┬───────────┤
│ Subject    │ Status   │ Sent     │ Actions   │
├────────────┼──────────┼──────────┼───────────┤
│ Summer Sale│ SENT     │ 310/320  │ View  Del │
│ Flash Deal │ DRAFT    │ —        │ Edit Send │
│ New Arrival│ SENDING  │ 45/200   │ View  —   │
└────────────┴──────────┴──────────┴───────────┘
```

**Status badge colors:**
- `DRAFT` → grey/yellow
- `SENDING` → blue (with spinner)
- `SENT` → green

**Actions per status:**
| Status | Actions |
|--------|---------|
| `DRAFT` | Edit, Send, Delete |
| `SENDING` | View only (disable Send/Delete/Edit) |
| `SENT` | View, Delete |

---

### Page: Create / Edit Campaign (`/admin/newsletter/campaigns/new`)

**Form fields:**

| Field | Input type | Required |
|-------|-----------|----------|
| Subject | Text input | Yes |
| Content | Rich text editor (e.g. TipTap, Quill) | Yes |
| Banner Image | **File input** (JPEG/PNG/WEBP, max 5 MB) | No |
| Button Text | Text input | No |
| Button Link | URL input | No |

**Frontend example (React):**
```jsx
const formData = new FormData();
formData.append('subject', subject);
formData.append('content', content);
if (bannerFile) formData.append('bannerImage', bannerFile); // File object from <input type="file" />
if (buttonText) formData.append('buttonText', buttonText);
if (buttonLink) formData.append('buttonLink', buttonLink);

await fetch('/api/newsletter/campaigns', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: formData   // Do NOT set Content-Type manually — browser sets multipart boundary
});
```

**Buttons:**
- **Save Draft** → `POST /api/newsletter/campaigns` with `saveDraft: true`
- **Send Now** → `POST /api/newsletter/campaigns` then immediately `POST /api/newsletter/campaigns/:id/send`

---

### Page: View Campaign (`/admin/newsletter/campaigns/:id`)

Show all campaign details plus a stats row:

```
Total Recipients:  320
Successfully Sent: 310   ✅
Failed:             10   ❌
Sent At:           25 May 2026, 10:32 AM
```

For `SENDING` campaigns, **poll** `GET /api/newsletter/campaigns/:id` every 5 seconds to refresh `sentCount` and `failedCount` in real time.

---

## Polling During Send (React Example)

```js
useEffect(() => {
  if (campaign.status !== 'SENDING') return;

  const interval = setInterval(async () => {
    const res = await fetch(`/api/newsletter/campaigns/${campaign.id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    setCampaign(data.data);

    if (data.data.status === 'SENT') {
      clearInterval(interval);
    }
  }, 5000);

  return () => clearInterval(interval);
}, [campaign.status]);
```

---

## Error Handling

| HTTP Code | Scenario |
|-----------|---------|
| `400` | Missing required fields / campaign not in DRAFT / already sent |
| `401` | Missing or invalid admin token |
| `404` | Campaign ID not found |
| `500` | Server error |

Always check `success: false` and display `error` field in the response to the user.
