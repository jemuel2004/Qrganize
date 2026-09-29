// Runs once when the Next.js server process starts (Node.js runtime only).
// This ensures database migrations are always applied before any API route
// handles a request — no manual POST /api/setup call needed.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runMigrations } = await import('./database/migrate');
    try {
      await runMigrations();
      console.log('[startup] Database migrations completed.');
    } catch (err) {
      // Log but do not crash the server — a partial DB can still serve most routes
      console.error('[startup] Migration error (non-fatal):', err);
    }

    /*
     * Next.js 16 + Turbopack (dev): intermittent route-tree race can leave
     * existing App Router pages/handlers returning HTML 404 for the whole
     * session (including /dashboard and /api/settings/logo). A filesystem
     * event under src/app repairs the router — see vercel/next.js#97894.
     * Production `next start` is unaffected; this only runs in development.
     */
    if (process.env.NODE_ENV === 'development' && process.env.QRGANIZE_SKIP_ROUTER_WAKE !== '1') {
      try {
        const fs = await import('fs/promises');
        const os = await import('os');
        const path = await import('path');
        const stamp = path.join(os.tmpdir(), 'qrganize-backend-router-wake');
        const WAKE_COOLDOWN_MS = 5 * 60 * 1000;
        let skip = false;
        try {
          const st = await fs.stat(stamp);
          skip = Date.now() - st.mtimeMs < WAKE_COOLDOWN_MS;
        } catch {
          /* no stamp yet */
        }
        if (!skip) {
          const wakeFile = path.join(process.cwd(), 'src', 'app', 'api', 'settings', 'logo', 'route.ts');
          const now = new Date();
          await fs.utimes(wakeFile, now, now);
          await fs.writeFile(stamp, String(Date.now()));
          console.log('[startup] Dev router wake: touched src/app/api/settings/logo/route.ts');
        }
      } catch (err) {
        console.warn('[startup] Dev router wake skipped:', err);
      }
    }
  }
}
