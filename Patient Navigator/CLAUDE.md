# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Patient Navigator is a DPDPA-compliant patient data management SPA for Carcinome NGO's cancer care navigation program. It is a static site hosted on GitHub Pages, backed by Supabase (PostgreSQL + Auth + RLS). An Android WebView wrapper app adds call recording.

## Commands

No build step — this is vanilla HTML/CSS/JS deployed as static files to GitHub Pages. To test locally, serve the root directory with any static server:

```bash
npx serve .
```

### Database migrations

SQL files in `sql/` must be run in order against the Supabase project's SQL Editor:
1. `01_schema.sql` — tables, ENUMs, triggers
2. `02_rls_policies.sql` — Row Level Security
3. `03_functions.sql` — dashboard stats, scoring, admin RPCs
4. `05_audit_trigger.sql` — audit trail
5. `04_seed.sql` — (optional) sample data
6. Remaining `06`–`11` files add analytics functions, calling portal schema, follow-up logic, team hierarchy

### Node scripts (one-off admin tasks)

Scripts in `scripts/` use the `pg` npm package to connect directly to Supabase Postgres. Run with:

```bash
node scripts/<script>.js
```

These contain DB credentials and are gitignored in production.

## Architecture

### Frontend (SPA)

Entry point: `index.html` → `js/app.js` (ES6 module, loaded with `<script type="module">`).

**Routing**: Hash-based SPA router (`js/router.js`). Routes are registered in `app.js` init with auth and role guards. `#patients/abc-123` style params parse the ID from the hash path.

**Auth flow** (`js/auth.js`):
- Two-stage session init: tries Supabase `getSession()` (4s timeout), falls back to reading the session directly from localStorage. This prevents network issues from stranding users on the login screen.
- Profile is loaded from the `profiles` table after auth. `getUserRole()` reads from the cached profile.
- Signup uses email OTP flow: `sendSignupOtp()` → `verifySignupOtp()` → marks profile inactive → signs out. Admin must approve before the user can sign in.
- `onAuthStateChange` listener in `app.js` handles SIGNED_OUT (show login) and late SIGNED_IN (boot app shell).

**Page rendering**: Each route handler receives a `container` DOM element and optional `params`. Pages query Supabase directly — there is no intermediate API layer. All data access is gated by Postgres RLS policies.

**Role-based UI**: The sidebar (`js/components/sidebar.js`) filters nav items by role. Individual pages check `getUserRole()` or `isManagerOrAdmin()` to conditionally show admin-only elements.

**CSS**: Design tokens in `css/variables.css` (dark glassmorphism theme). Four stylesheets loaded in order: variables → base → components → layout.

### Database (Supabase/Postgres)

Core tables: `profiles` (extends `auth.users`), `patients`, `call_logs`, `audit_log`.

Security model: All data access enforced at the DB layer via RLS policies (`02_rls_policies.sql`). Helper functions (`get_user_role()`, `is_admin()`, `is_manager_or_admin()`) drive policy evaluation. The frontend has no server-side code — it uses the Supabase JS client with the anon key, and RLS ensures users only see what their role permits.

DPDPA compliance: `patients` table tracks consent (`consent_given`, `consent_date`, `consent_method`) with auto-calculated `data_retention_until` (consent_date + 3 years). All mutations are recorded in `audit_log` via triggers.

### Android app

WebView wrapper in `android/` loads the hosted portal URL. Native components:
- `MainActivity.java` — WebView setup, permission requests (microphone, phone state, call log), battery optimization, file upload handling
- `CallRecordingService.java` — foreground service for call recording
- `PhoneCallReceiver.java` — detects call start/end
- `NativeBridge.java` — JavaScript interface exposing native features to the web app
- `SupabaseUploader.java` — uploads recordings to Supabase Storage

The JS in the web portal calls `window.CarcinomeNative` methods — ensure any changes to the bridge API are reflected on both sides.

## Key patterns

- **Cache busting**: JS and CSS `<link>`/`<script>` tags include `?v=YYYYMMDDx` query strings. Bump the version in `index.html` and the `APP_BUILD` constant in `js/app.js` when deploying breaking changes.
- **No framework**: All DOM manipulation is direct. Pages render full HTML into their container via `innerHTML`. Event listeners are attached imperatively after render.
- **Error surfacing**: The boot watchdog in `index.html` detects CDN failures. The supabase client throws if the library didn't load (instead of returning null silently).
- **Toast notifications**: `showToast(message, type)` from `js/components/toast.js` for user feedback. Types: success, error, warning, info.
- **Supabase client is a singleton**: `getSupabase()` in `js/supabase.js` creates the client once.
