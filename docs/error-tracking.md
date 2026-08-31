# Backend error tracking

Production application exceptions are reported to Sentry when `SENTRY_DSN` is configured in the deployment environment. Do not commit the DSN to this repository or place it in client-side configuration.

`SENTRY_ENVIRONMENT` may optionally identify the deployment; otherwise `NODE_ENV` is used.

When `SENTRY_DSN` is absent, tracking is a no-op and startup continues normally. Sentry initialization and capture failures are non-fatal. Request bodies, headers, cookies, query strings, user data, and common secret-bearing fields are removed before an event is sent. Error monitoring is enabled without performance tracing.
