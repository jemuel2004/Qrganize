# Deploying QRganize

| Part | Service | What runs there |
|---|---|---|
| **Database** | **Neon** | PostgreSQL |
| **Server** | **Render** | `apps/backend` — API, database access, uploaded photos/logo |
| **Client** | **Vercel** | `apps/frontend` — the web app users open |

```
Browser ──► Vercel (frontend) ──/api/*, /uploads/*──► Render (backend) ──► Neon (database)
```

The browser only ever talks to the Vercel address. Vercel forwards `/api/*` and
`/uploads/*` to Render, so login cookies stay on one domain and no CORS setup is needed.

Deploy in this order: **Neon → Render → Vercel → Google sign-in**.

---

## 0. Before you start

1. Push the project to **GitHub** (Render and Vercel deploy from it).
   `.env.local` files are git-ignored — secrets are entered in each dashboard instead.
2. Check locally that both apps build:
   ```bash
   npm ci
   npm run build
   ```

---

## 1. Neon — database

1. Create a project at <https://neon.tech> (region close to your Render region, e.g. **Singapore**).
2. **Connection Details** → turn **Pooled connection** on → copy the string. It looks like
   `postgresql://USER:PASSWORD@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
   This is your `DATABASE_URL`.

Then choose one:

- **Start fresh** — do nothing. On its first start the backend creates every table
  (migrations run automatically) and a starter admin account **`admin` / `admin123`**.
  **Log in and change that password immediately** (Settings → Password & Security).
- **Copy your local data** (faculty, curriculum, schedules, accounts):
  ```bash
  pg_dump --no-owner --no-acl -Fc "postgresql://postgres:YOUR_PASSWORD@localhost:5432/qr_ganized" -f qrganize.dump
  pg_restore --no-owner --no-acl -d "PASTE_NEON_DIRECT_URL_HERE" qrganize.dump
  ```
  Use Neon's **direct** (non-pooled) connection string for `pg_restore`.

---

## 2. Render — server (`apps/backend`)

1. Render → **New → Blueprint** → select the GitHub repo. Render reads `render.yaml`
   and creates **qrganize-backend**.
2. Fill in the values it asks for:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Neon **pooled** string from step 1 |
   | `GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | your Google OAuth client ID |
   | `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Gmail address, Gmail **App Password**, sender name |

   `JWT_SECRET` and `OTP_SECRET` are generated automatically; `UPLOAD_DIR`, `TRUST_PROXY`,
   `NODE_VERSION` and `NODE_ENV` are already set in `render.yaml`.
3. Deploy. When it's live, open `https://<your-service>.onrender.com/api/settings/logo` —
   it should return JSON such as `{"logoUrl":null}`. Copy the service URL for step 3.

### Uploaded photos and logo — the persistent disk

Render's normal file system is erased on every deploy/restart. `render.yaml` therefore
attaches a **1 GB disk at `/var/data`** and sets `UPLOAD_DIR=/var/data/uploads`, so profile
photos and the system logo survive. A disk needs a paid instance (**Starter**).

On the **Free** plan instead: delete the `disk:` block and the `UPLOAD_DIR` entry and set
`plan: free`. Everything works, but **uploaded photos and the logo are lost on each deploy or
restart**, and the service sleeps after 15 minutes idle (the first visit then takes ~1 minute).

---

## 3. Vercel — client (`apps/frontend`)

1. Vercel → **Add New → Project** → import the same repo.
2. **Root Directory:** `apps/frontend` (leave "Include files outside the root directory" **on** —
   the app uses `packages/shared`). Framework: **Next.js**. Install/Build commands come from
   `apps/frontend/vercel.json`.
3. **Environment Variables:**

   | Variable | Value |
   |---|---|
   | `BACKEND_URL` | the Render URL from step 2, e.g. `https://qrganize-backend.onrender.com` (no trailing `/`) |
   | `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | same Google client ID |

4. Deploy, then open the Vercel URL (e.g. `https://qrganize.vercel.app`) and log in.

---

## 4. Google sign-in

Google Cloud Console → **APIs & Services → Credentials** → your OAuth client →
**Authorized JavaScript origins** → add your Vercel URL (e.g. `https://qrganize.vercel.app`)
and any custom domain. Without this, "Sign in with Google" is refused on the live site.

---

## 5. After the first deploy

- [ ] Log in as admin; change the password if you started fresh.
- [ ] **Settings → School Year**: set the active school year and semester.
- [ ] **Settings → Day Combinations**: set this semester's allowed day combinations.
- [ ] Upload the system logo (Settings → System Logo) and check it still shows after a Render redeploy.
- [ ] Log in once as a faculty account and scan a room QR code on a phone (HTTPS is required for the camera — Vercel provides it).
- [ ] Send yourself a login code to confirm email works.

## Updating

Push to the main branch — Render and Vercel both redeploy automatically. Database changes
are applied by the backend's migrations on start; no manual SQL is needed.

## Environment variable reference

See `apps/backend/.env.example` and `apps/frontend/.env.example`.
