# Customize: Logo Image Upload

## Objective
Add logo image upload to `/admin/customize` so the status-page badge can be replaced by a real image (PNG/JPG/WebP/SVG) applied globally. Today only `logo_text`/`logo_color` exist; per-page `logo_url` is API-only.

## Problem / Why
Users want branding with an actual logo, not just a letter badge. The Customize button only exposed text + color.

## Scope
- Upload UI in `views/admin/customize.ejs` (file picker + preview + remove).
- Server-side validation + storage in `src/routes/admin-extra.js` (base64 data-URI, 200 KB cap, MIME whitelist `png|jpe?g|webp|svg+xml`).
- Persisted via `settings.set('custom_logo_image', ...)`.
- Rendered in `views/partials/_logo.ejs` as `<img class="logo">`, fallback to text badge.
- No new npm dependencies (base64 data-URI through urlencoded parser with route-scoped 512 kb limit).

## Constraints
- Express `express.json()` + `express.urlencoded()` only; no multer/busboy.
- CSRF required on admin POST (existing `_csrf` pattern).
- Admin-only mutation (`requireAdmin`).
- Keep existing scratch/verify_*.js harnesses green (no test framework).

## Tasks
- [x] T1: Upload UI in customize.ejs with client-side FileReader → base64 + remove checkbox.
- [x] T2: Server POST /customize handles `logo_image` + `logo_remove`; validates MIME + 200 KB cap; stores/ deletes `custom_logo_image`; redirects with flash (`logo_saved`/`logo_removed`/error msgs).
- [x] T3: `_logo.ejs` renders `<img class="logo">` from `customization.logo_image` data-URI, else text badge.
- [x] T4: Route-scoped urlencoded limit (512 kb) for `/admin/customize` so ~200 KB base64 posts fit.
- [x] T5: New regression harness `scratch/verify_logo.js` (18 checks): upload→persist→render→size reject→mime reject→remove→plain-save keeps logo.
- [x] T6: Full verification: all 8 harnesses PASS (256 total checks); independent verifier approved (security: XSS/SQLi/SVG/cache/flash all clean).

## Authorized Scope
Files: views/admin/customize.ejs, src/routes/admin-extra.js, src/db/models.js, views/partials/_logo.ejs, src/app.js, src/middleware/session.js, scratch/verify_logo.js, odd/tasks/customize-logo-upload.md

## Acceptance
- Admin uploads logo → status page shows it immediately (cache cleared).
- Oversized/non-image files rejected server-side (not just client-side).
- "Remove logo" returns to text badge. Plain save keeps existing logo.
- All existing harnesses still pass.

## Checks (evidence)
- `node scratch/verify_logo.js` → 18/18 PASS, exit 0.
- `for t in verify_plan verify_multigroup verify_deps verify_smoke verify_e2e verify_update; do node scratch/$t.js; done` → all PASS.
- Independent verifier: status=approved; MIME regex probed with 17 adversarial payloads (all rejected); `<%= %>` escaping + `ejs.escape` confirmed; cache invalidation confirmed; `requireAdmin` + CSRF chain confirmed.

## Outcome
COMPLETE — 256 checks green. Not yet committed/pushed. Next: commit as work unit → push → optionally deploy to yoda.
