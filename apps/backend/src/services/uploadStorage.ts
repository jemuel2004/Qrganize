import fs from 'fs';
import path from 'path';

/*
 * Where uploaded files (profile photos, system logo) live.
 *   • UPLOAD_DIR set (production, e.g. a Render persistent disk mounted at
 *     /var/data/uploads) → files survive redeploys.
 *   • Not set (local development) → public/uploads, as before.
 * Stored URLs stay "/uploads/<sub>/<file>"; app/uploads/[...path] serves them.
 */

/** Files bundled with the app (default logo, seed photos) */
const BUNDLED_ROOT = path.join(process.cwd(), 'public', 'uploads');

export function uploadRoot(): string {
  const env = (process.env.UPLOAD_DIR || '').trim();
  return env ? path.resolve(env) : BUNDLED_ROOT;
}

/** Folder for one kind of upload, created when missing */
export function uploadDir(sub: 'profiles' | 'logo'): string {
  const dir = path.join(uploadRoot(), sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Path inside `root` for a stored "/uploads/…" URL, or null if it escapes the root */
function inside(root: string, stored: string): string | null {
  const rel = stored.split('?')[0].replace(/^\/+/, '').replace(/^uploads\//, '');
  if (!rel) return null;
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : null;
}

/** Existing local file for a stored "/uploads/…" URL (upload folder first, then bundled files) */
export function findUploadedFile(stored: string | null | undefined): string | null {
  if (!stored || !/^\/?uploads\//.test(stored.split('?')[0])) return null;
  for (const root of [uploadRoot(), BUNDLED_ROOT]) {
    const file = inside(root, stored);
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}

/** Delete a previously uploaded file (only inside the upload folder; never bundled files) */
export function deleteUploadedFile(stored: string | null | undefined): void {
  if (!stored) return;
  const file = inside(uploadRoot(), stored);
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* already gone */ }
}
