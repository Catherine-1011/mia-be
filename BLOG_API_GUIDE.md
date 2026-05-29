# Blog API Guide for Frontend Dashboard

## Base URL
```
{baseUrl}/api/blogs
```

## Authentication
All admin endpoints require authentication. Include the authorization header:
```
Authorization: Bearer {your-jwt-token}
```

---

## 📝 Blog Data Structure

### Blog Object
```json
{
  "id": "string",
  "title": "string",
  "slug": "string (unique)",
  "content": "string",
  "coverImage": "string (URL)",
  "shortDescription": "string | null",
  "tags": "string[] (array)",
  "ctaText": "string | null",
  "status": "DRAFT | PUBLISHED",
  "createdAt": "ISO string",
  "updatedAt": "ISO string"
}
```

---

## 🔧 Admin Endpoints

### 1. Create Blog
**POST** `/api/blogs` (Admin only)

**Content-Type:** `multipart/form-data`

**Form Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | ✅ Yes | Blog title |
| content | string | ✅ Yes | Main blog content/body |
| slug | string | ❌ No | URL slug (auto-generated if not provided) |
| coverImage | file | ✅ Yes | Cover image file upload |
| shortDescription | string | ❌ No | Brief summary/excerpt |
| tags | string | ❌ No | JSON array or comma-separated tags |
| ctaText | string | ❌ No | Call-to-action text |

**Tags Format Options:**
```javascript
// Option 1: JSON array (recommended)
tags: '["javascript", "tutorial", "api"]'

// Option 2: Comma-separated
tags: 'javascript,tutorial,api'

// Option 3: Single tag
tags: 'tutorial'
```

**Success Response (201):**
```json
{
  "success": true,
  "message": "Blog created",
  "blog": {
    "id": "blog_id_here",
    "title": "My Blog Post",
    "slug": "my-blog-post",
    "content": "Blog content...",
    "coverImage": "https://cloudinary.com/image.jpg",
    "shortDescription": "Brief description",
    "tags": ["javascript", "tutorial"],
    "ctaText": "Read more",
    "status": "DRAFT",
    "createdAt": "2026-03-20T10:30:00Z",
    "updatedAt": "2026-03-20T10:30:00Z"
  }
}
```

**Error Response (400):**
```json
{
  "success": false,
  "message": "title is required and cannot be empty",
  "received": { "title": "undefined" }
}
```

---

### 2. Update Blog
**PUT** `/api/blogs/{id}` (Admin only)

**Content-Type:** `multipart/form-data`

**URL Parameters:**
- `id` - Blog ID or slug

**Form Fields:** (All optional for updates)
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | ❌ No | New blog title |
| content | string | ❌ No | New blog content |
| slug | string | ❌ No | New URL slug |
| coverImage | file | ❌ No | New cover image file |
| shortDescription | string | ❌ No | New description |
| tags | string | ❌ No | New tags |
| ctaText | string | ❌ No | New CTA text |

**Success Response (200):**
```json
{
  "success": true,
  "message": "Blog updated",
  "blog": { /* updated blog object */ }
}
```

---

### 3. Delete Blog
**DELETE** `/api/blogs/{id}` (Admin only)

**URL Parameters:**
- `id` - Blog ID or slug

**Success Response (200):**
```json
{
  "success": true,
  "message": "Blog deleted"
}
```

---

### 4. Toggle Publish Status
**PATCH** `/api/blogs/{id}/toggle-publish` (Admin only)

**URL Parameters:**
- `id` - Blog ID or slug

**Success Response (200):**
```json
{
  "success": true,
  "message": "Blog is now published",
  "blog": { /* updated blog object */ }
}
```

---

### 5. Get All Blogs (Admin View)
**GET** `/api/blogs/admin` (Admin only)

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| status | string | all | Filter: `DRAFT`, `PUBLISHED` |
| page | number | 1 | Page number |
| limit | number | 10 | Items per page |

**Example:**
```
GET /api/blogs/admin?status=DRAFT&page=1&limit=20
```

**Success Response (200):**
```json
{
  "success": true,
  "total": 25,
  "page": 1,
  "totalPages": 3,
  "blogs": [
    { /* blog object */ },
    { /* blog object */ }
  ]
}
```

---

### 6. Get Single Blog (Admin View)
**GET** `/api/blogs/admin/{id}` (Admin only)

**URL Parameters:**
- `id` - Blog ID or slug

**Success Response (200):**
```json
{
  "success": true,
  "blog": { /* complete blog object */ }
}
```

---

## 🌐 Public Endpoints

### 7. Get Published Blogs
**GET** `/api/blogs/public`

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| page | number | 1 | Page number |
| limit | number | 10 | Items per page |

**Success Response (200):**
```json
{
  "success": true,
  "total": 15,
  "page": 1,
  "totalPages": 2,
  "blogs": [
    { /* published blog object */ }
  ]
}
```

---

### 8. Get Single Published Blog
**GET** `/api/blogs/public/{id}`

**URL Parameters:**
- `id` - Blog ID or slug

**Success Response (200):**
```json
{
  "success": true,
  "blog": { /* published blog object */ }
}
```

---

## 🚨 Error Responses

### Common Error Codes

**400 - Bad Request**
```json
{
  "success": false,
  "message": "title is required and cannot be empty",
  "received": { "title": "undefined" }
}
```

**401 - Unauthorized**
```json
{
  "success": false,
  "message": "Access denied"
}
```

**404 - Not Found**
```json
{
  "success": false,
  "message": "Blog not found"
}
```

**409 - Conflict**
```json
{
  "success": false,
  "message": "A blog with slug 'my-blog-post' already exists"
}
```

**500 - Server Error**
```json
{
  "success": false,
  "message": "Internal server error message"
}
```

---

## 🎯 Frontend Implementation Examples

### JavaScript/Fetch Examples

#### Create Blog
```javascript
const createBlog = async (formData) => {
  const response = await fetch('/api/blogs', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData // FormData with fields
  });
  
  return response.json();
};

// Usage
const formData = new FormData();
formData.append('title', 'My Blog Post');
formData.append('content', 'Blog content here...');
formData.append('coverImage', imageFile);
formData.append('tags', '["javascript", "tutorial"]');
formData.append('shortDescription', 'Brief description');

const result = await createBlog(formData);
```

#### Get Published Blogs
```javascript
const getBlogs = async (page = 1, limit = 10) => {
  const response = await fetch(`/api/blogs/public?page=${page}&limit=${limit}`);
  return response.json();
};

// Usage
const { blogs, total, totalPages } = await getBlogs(1, 10);
```

#### Update Blog Status
```javascript
const togglePublish = async (blogId) => {
  const response = await fetch(`/api/blogs/${blogId}/toggle-publish`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  return response.json();
};
```

---

## 📱 Dashboard Features to Implement

### Blog Management Dashboard
1. **Blog List View**
   - Display all blogs with status indicators
   - Pagination controls
   - Filter by status (Draft/Published)
   - Search functionality

2. **Blog Create/Edit Form**
   - Title input (required)
   - Content editor (rich text)
   - Cover image upload with preview
   - Short description textarea
   - Tags input (with autocomplete)
   - CTA text input
   - Save as Draft / Publish buttons

3. **Blog Actions**
   - Edit button → opens edit form
   - Delete button → confirmation dialog
   - Toggle publish status
   - Preview published blog

### Frontend State Management
```javascript
// Example blog state structure
const blogState = {
  blogs: [],
  currentBlog: null,
  loading: false,
  pagination: {
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0
  },
  filters: {
    status: 'all' // 'all', 'DRAFT', 'PUBLISHED'
  }
};
```

---

## 🛡️ Security Notes

1. **File Upload Security**
   - Only image files allowed for coverImage
   - File size limits enforced
   - Images uploaded to Cloudinary

2. **Input Validation**
   - Title and content are required
   - Slug uniqueness enforced
   - HTML sanitization for content

3. **Authorization**
   - Admin routes require valid JWT token
   - Public routes accessible without auth

---

## 🔄 Status Workflow

```
DRAFT → (toggle-publish) → PUBLISHED
PUBLISHED → (toggle-publish) → DRAFT
```

Draft blogs are only visible in admin panel.
Published blogs appear in both admin panel and public API.

---

This guide should provide your frontend team with everything they need to integrate with the Blog API! 🚀