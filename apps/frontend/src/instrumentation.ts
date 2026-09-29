// Runs once when the frontend server starts. Dev-only Turbopack workaround —
// migrations live in the backend app.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    /*
     * Next.js 16 + Turbopack (dev): intermittent route-tree race can leave
     * existing App Router pages/handlers returning HTML 404 for the whole
     * session (including /dashboard). A filesystem
     * event under src/app repairs the router — see vercel/next.js#97894.
     * Production `next start` is unaffected; this only runs in development.
     */
    if (process.env.NODE_ENV === 'development' && process.env.QRGANIZE_SKIP_ROUTER_WAKE !== '1') {
      try {
        const fs = await import('fs/promises');
        const os = await import('os');
        const path = await import('path');
        const stamp = path.join(os.tmpdir(), 'qrganize-frontend-router-wake');
        const WAKE_COOLDOWN_MS = 5 * 60 * 1000;
        let skip = false;
        try {
          const st = await fs.stat(stamp);
          skip = Date.now() - st.mtimeMs < WAKE_COOLDOWN_MS;
        } catch {
          /* no stamp yet */
        }
        if (!skip) {
          const wakeFile = path.join(process.cwd(), 'src', 'app', 'page.tsx');
          const now = new Date();
          await fs.utimes(wakeFile, now, now);
          await fs.writeFile(stamp, String(Date.now()));
          console.log('[startup] Dev router wake: touched src/app/page.tsx');
        }
      } catch (err) {
        console.warn('[startup] Dev router wake skipped:', err);
      }
    }
  }
}
