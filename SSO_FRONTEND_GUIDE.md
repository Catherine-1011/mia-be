# SSO Frontend Integration Guide

## What's Working (Backend)
The SAML SSO flow is fully working on the backend:
1. Admin clicks "Made in Arnhemland" tile on AuthPoint portal
2. WatchGuard authenticates and sends SAML assertion to backend
3. Backend verifies it and redirects to:
   ```
   https://alpa-dashboard.vercel.app/login-callback?token=<JWT>&type=saml
   ```

## What Needs to Be Built (Frontend)

### Create `/login-callback` page

This page must:
1. Read `token` and `type` from the URL query params
2. Store the token
3. Redirect to the dashboard home

---

### Next.js App Router (`app/login-callback/page.tsx`)

```tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const type = params.get('type');

    if (token && type === 'saml') {
      // Store token — use whichever method your app already uses
      localStorage.setItem('token', token);
      // If you also use cookies:
      // document.cookie = `session_token=${token}; path=/; max-age=${15 * 60}`;

      // Redirect to dashboard home
      router.replace('/dashboard');
    } else {
      router.replace('/login?error=invalid_callback');
    }
  }, [router]);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <p>Signing you in...</p>
    </div>
  );
}
```

---

### Next.js Pages Router (`pages/login-callback.tsx`)

```tsx
import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function LoginCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const type = params.get('type');

    if (token && type === 'saml') {
      localStorage.setItem('token', token);
      router.replace('/dashboard');
    } else {
      router.replace('/login?error=invalid_callback');
    }
  }, [router]);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <p>Signing you in...</p>
    </div>
  );
}
```

---

### React (CRA / Vite) with React Router (`src/pages/LoginCallback.tsx`)

```tsx
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function LoginCallback() {
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const type = params.get('type');

    if (token && type === 'saml') {
      localStorage.setItem('token', token);
      navigate('/dashboard', { replace: true });
    } else {
      navigate('/login?error=invalid_callback', { replace: true });
    }
  }, [navigate]);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <p>Signing you in...</p>
    </div>
  );
}
```

Add the route in your router:
```tsx
<Route path="/login-callback" element={<LoginCallback />} />
```

---

## Important Notes

### Token Details
| Property | Value |
|---|---|
| Token type | JWT |
| Expiry | 60 minutes (admin SAML session) |
| Query param name | `token` |
| Type identifier | `type=saml` |

### The token contains:
```json
{
  "userId": "...",
  "uid": "...",
  "email": "mial.testing@alpa.asn.au",
  "role": "ADMIN",
  "jti": "..."
}
```

### After storing the token
Make sure your existing auth context / state management picks up the token from localStorage on page load. The user's role will be `ADMIN` so they should see the admin dashboard.

### Also add "Sign in with SSO" button (optional)
If you want admins to be able to start SSO from the dashboard login page (instead of only from AuthPoint portal), add a button that links to:
```
https://alpa-be.onrender.com/api/auth/saml/login
```
This triggers the SP-initiated SAML flow.
