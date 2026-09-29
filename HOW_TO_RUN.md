# How to Run QRganize

## Prerequisites

Before running the system, make sure the following are installed on your machine:

| Tool | Version | Download |
|------|---------|----------|
| Node.js | v18 or higher | https://nodejs.org |
| PostgreSQL | v14 or higher | https://www.postgresql.org/download |
| npm | comes with Node.js | — |

---

## 1. Set Up the Database

Open **pgAdmin** or **psql** and create the database:

```sql
CREATE DATABASE qr_ganized;
```

> The database name must be exactly `qr_ganized`.

---

## 2. Configure Environment Variables

QRganize has two apps, each with its own env file.

**Backend** — create `apps/backend/.env.local` (database + all secrets live only here):

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/qr_ganized
JWT_SECRET=instructor_workload_secret_key_2025
NEXTAUTH_SECRET=instructor_workload_secret_key_2025
GOOGLE_CLIENT_ID=your-google-client-id
NEXT_PUBLIC_GOOGLE_CLIENT_ID=your-google-client-id
TRUST_PROXY=true
```

**Frontend** — create `apps/frontend/.env.local` (no secrets):

```env
BACKEND_URL=http://localhost:4000
NEXT_PUBLIC_GOOGLE_CLIENT_ID=your-google-client-id
```

Replace `YOUR_PASSWORD` with your PostgreSQL password.

> If you already have an `.env.local` file, skip this step — it is already configured.

Password login now requires a 6-digit email verification code. Add these **server-only** variables to `apps/backend/.env.local` (never `NEXT_PUBLIC_*`):

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-gmail@gmail.com
SMTP_PASS=your-16-character-app-password
SMTP_FROM=QRganize <your-gmail@gmail.com>
```

Gmail setup for development:
1. Turn on 2-Step Verification on the Gmail account that will send codes.
2. Create an [App Password](https://myaccount.google.com/apppasswords) for Mail.
3. Put that App Password in `SMTP_PASS` — not the Gmail login password.

Google Instructor sign-in does **not** send a second email code. Google already proves control of that account.

---

## 3. Install Dependencies

Open a terminal in the project folder and run:

```bash
npm install
```

This installs all required packages (Next.js, PostgreSQL driver, bcryptjs, etc.).

---

## 4. Run the Development Server

```bash
npm run dev
```

This starts **both** apps: the backend (API + database) on port 4000 and the frontend (website) on port 3000.
You can also run them separately with `npm run dev:backend` and `npm run dev:frontend`.

The first time you run this, the system will **automatically**:
- Create all database tables (users, programs, faculty, schedules, rooms, etc.)
- Create the default admin account
- Seed initial data (programs, rooms)
- Run all database migrations

Wait for this message in the terminal before opening the browser:

```
✓ Ready in ...ms
Migrations and seed data completed successfully.
```

---

## 5. Open the App

Open your browser and go to:

```
http://localhost:3000
```

---

## 6. Default Login Credentials

### Admin Account

| Field | Value |
|-------|-------|
| Username | `admin` |
| Password | `admin123` |

### Instructor Accounts

Instructor accounts are created by the admin through the **Faculty Profiles** page. Each instructor logs in with the username and password set during their profile creation.

---

## 7. Stopping the Server

Press `Ctrl + C` in the terminal to stop the development server.

---

## Common Issues

### "Database connection refused"
- Make sure PostgreSQL is running.
- Check that the password in `apps/backend/.env.local` matches your PostgreSQL password.
- Verify the database `qr_ganized` exists.

### "Migrations and seed data" not appearing
- The migrations run automatically on the first full server start.
- If you only changed a file and the server hot-reloaded (HMR), stop the server with `Ctrl + C` and restart it with `npm run dev`.

### Port 3000 or 4000 already in use
- Stop the other process using that port. The frontend uses 3000 and the backend 4000
  (set in `apps/frontend/package.json` / `apps/backend/package.json`). If you move the
  backend, update `BACKEND_URL` in `apps/frontend/.env.local`.

### Pages redirect to the login screen right after signing in
- The frontend could not reach the backend. Make sure both apps are running
  (`npm run dev`) and `BACKEND_URL` points at the backend.

### "Table does not exist" errors
- Stop the server completely (`Ctrl + C`) and restart it with `npm run dev`.
- Migrations only run on a full server restart, not on hot-reload.

---

## Project Structure (Quick Reference)

```
qrganize/
├── apps/
│   ├── frontend/           # Website: pages, UI, page gate (no database)
│   └── backend/            # API routes, auth, services, database, migrations, uploads
│       └── database/       # schema.sql + seed.sql
├── packages/shared/        # Logic used by both apps
├── scripts/dev.mjs         # Starts both apps
└── package.json            # npm workspaces
```

See the README for the full tree and the separate-deployment guide.

---

## Building for Production

```bash
npm run build            # builds the backend, then the frontend
npm run start:backend    # port 4000
npm run start:frontend   # port 3000
```

Each app can run on a different server — see **Deploying separately** in the README.

> For production, use a proper PostgreSQL server and set strong values for `JWT_SECRET` and `NEXTAUTH_SECRET`.
