import fs from 'fs';
import path from 'path';
import { query } from '@/database/db';
import { ensureUploadedFilesTable } from '@/database/schema-guard';

/*
 * Uploaded files (profile photos, system logo) are stored in the database
 * (uploaded_files table), so they survive restarts and redeploys on hosts
 * whose filesystem is temporary — e.g. Render's free plan wipes local files
 * whenever the instance spins down.
 *
 * Stored URLs stay "/uploads/<sub>/<file>"; app/uploads/[...path] serves them.
 * Reads fall back to files on disk (bundled default logo, seed photos, and
 * anything uploaded locally before the database store existed).
 */

/** Files bundled with the app (default logo, seed photos) */
const BUNDLED_ROOT = path.join(process.cwd(), 'public', 'uploads');

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

function diskRoots(): string[] {
  const env = (process.env.UPLOAD_DIR || '').trim();
  return env ? [path.resolve(env), BUNDLED_ROOT] : [BUNDLED_ROOT];
}

/** Normalised "/uploads/<sub>/<file>" key for a stored URL, or null if it is not an upload */
function uploadKey(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const rel = stored.split('?')[0].replace(/^\/+/, '');
  if (!/^uploads\/[\w.-]+\/[\w.-]+$/.test(rel) || rel.includes('..')) return null;
  return `/${rel}`;
}

/** LIKE pattern matching "<baseName>.<any extension>" in a folder (escapes _ and %) */
function namePattern(sub: string, baseName: string): string {
  return `/uploads/${sub}/${baseName.replace(/[\\_%]/g, m => `\\${m}`)}.%`;
}

/** Path inside `root` for an upload key, or null if it escapes the root */
function inside(root: string, key: string): string | null {
  const full = path.resolve(root, key.replace(/^\/uploads\//, ''));
  return full.startsWith(root + path.sep) ? full : null;
}

/** Existing file on disk for a stored "/uploads/…" URL (bundled or legacy uploads) */
export function findUploadedFile(stored: string | null | undefined): string | null {
  const key = uploadKey(stored);
  if (!key) return null;
  for (const root of diskRoots()) {
    const file = inside(root, key);
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Save an upload as "/uploads/<sub>/<baseName>.<ext>", replacing any earlier
 * file with the same base name (any extension). Returns the stored URL.
 */
export async function saveUpload(
  sub: 'profiles' | 'logo',
  baseName: string,
  ext: string,
  contentType: string,
  data: Buffer,
): Promise<string> {
  await ensureUploadedFilesTable();
  const key = `/uploads/${sub}/${baseName}.${ext}`;
  await query('DELETE FROM uploaded_files WHERE path LIKE $1 AND path <> $2', [namePattern(sub, baseName), key]);
  await query(
    `INSERT INTO uploaded_files (path, content_type, data, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (path) DO UPDATE SET content_type = $2, data = $3, updated_at = NOW()`,
    [key, contentType, data],
  );
  return key;
}

/** Contents of a stored "/uploads/…" URL — database first, then files on disk */
export async function readUpload(
  stored: string | null | undefined,
): Promise<{ data: Buffer; contentType: string } | null> {
  const key = uploadKey(stored);
  if (!key) return null;
  try {
    await ensureUploadedFilesTable();
    const row = await query('SELECT content_type, data FROM uploaded_files WHERE path = $1', [key]);
    if (row.rows[0]) return { data: row.rows[0].data as Buffer, contentType: row.rows[0].content_type as string };
  } catch (err) {
    console.error('[uploadStorage] read failed:', err);
  }
  const file = findUploadedFile(key);
  const contentType = file ? TYPES[path.extname(file).toLowerCase()] : undefined;
  if (!file || !contentType) return null;
  return { data: await fs.promises.readFile(file), contentType };
}

/** Delete a previously uploaded file (database copy and any legacy upload on disk; never bundled files) */
export async function deleteUploadedFile(stored: string | null | undefined): Promise<void> {
  const key = uploadKey(stored);
  if (!key) return;
  try {
    await ensureUploadedFilesTable();
    await query('DELETE FROM uploaded_files WHERE path = $1', [key]);
  } catch (err) {
    console.error('[uploadStorage] delete failed:', err);
  }
  const env = (process.env.UPLOAD_DIR || '').trim();
  const file = inside(env ? path.resolve(env) : BUNDLED_ROOT, key);
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch { /* already gone */ }
}

/** Delete every upload named "<baseName>.*" in a folder */
export async function deleteUploadsNamed(sub: 'profiles' | 'logo', baseName: string): Promise<void> {
  await ensureUploadedFilesTable();
  const rows = await query('SELECT path FROM uploaded_files WHERE path LIKE $1', [namePattern(sub, baseName)]);
  const keys = new Set<string>(rows.rows.map(r => r.path as string));
  for (const ext of ['png', 'jpg', 'webp', 'gif']) keys.add(`/uploads/${sub}/${baseName}.${ext}`);
  for (const key of keys) await deleteUploadedFile(key);
}
