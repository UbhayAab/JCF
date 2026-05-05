# Patient Navigator — Carcinome NGO

A DPDPA-compliant patient data management system for cancer care navigation.

## Quick Start

### 1. Set Up Supabase

1. Go to [supabase.com](https://supabase.com) → Create a new project
2. Choose **South Asia (Mumbai)** region
3. Set a strong database password

### 2. Run Database Migrations

In Supabase Dashboard → **SQL Editor**, run these files **in order**:

1. `sql/01_schema.sql` — Creates tables, ENUMs, triggers
2. `sql/02_rls_policies.sql` — Enables Row Level Security
3. `sql/03_functions.sql` — Dashboard stats, scoring, admin functions
4. `sql/05_audit_trigger.sql` — Audit trail triggers
5. `sql/04_seed.sql` — (Optional) Sample data

### 3. Configure Frontend

Open `js/config.js` and replace:

```javascript
SUPABASE_URL: 'https://YOUR-PROJECT-ID.supabase.co',
SUPABASE_ANON_KEY: 'eyJ...',
```

Find these values in Supabase Dashboard → **Settings → API**.

### 4. Create Admin User

1. Go to Supabase Dashboard → **Authentication → Users**
2. Click **Add User** → enter email + password
3. Go to **SQL Editor** and run:

```sql
UPDATE public.profiles SET role = 'admin' WHERE id = '<user-uuid>';
```

### 5. Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR-USERNAME/patient-navigator.git
git push -u origin main
```

Then in GitHub: **Settings → Pages → Source: main branch → root**.

Your app will be live at: `https://YOUR-USERNAME.github.io/patient-navigator/`

### 6. Start Using

1. Open the deployed URL
2. Sign in with the admin account you created
3. Go to Admin → promote other users as needed

## Security Architecture

- **Row Level Security (RLS)** — Database-level access control
- **Role-Based Access Control** — Admin, Manager, Caller roles
- **DPDPA Compliance** — Consent tracking, audit logs, data retention
- **No server-side code exposed** — All security enforced in Postgres

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (ES6 modules) |
| Backend | Supabase (PostgreSQL + Auth + RLS) |
| Hosting | GitHub Pages (static) |
| Auth | Supabase Auth (email/password) |
| Icons | Inline SVG |
| Fonts | Google Fonts (Inter) |
