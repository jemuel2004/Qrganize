import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { ensureUserProfilePicture } from '@/server/schema-guard';
import { validateImageMagicBytes } from '@/server/validateUpload';
import fs from 'fs';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!authUser || (authUser.role !== 'admin' && authUser.role !== 'department_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get('picture') as File | null;

    if (!file || file.size === 0)
      return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });

    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type))
      return NextResponse.json({ error: 'Only JPEG, PNG, or WebP images are allowed.' }, { status: 400 });

    if (file.size > 5 * 1024 * 1024)
      return NextResponse.json({ error: 'File must be under 5 MB.' }, { status: 400 });

    const magicCheck = await validateImageMagicBytes(file, allowed);
    if (!magicCheck.valid)
      return NextResponse.json({ error: magicCheck.reason ?? 'Invalid file content.' }, { status: 400 });

    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    };
    const ext = extMap[file.type] ?? 'jpg';
    const userId = authUser.id!;
    const filename = `user_${userId}.${ext}`;
    const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'profiles');

    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    // Remove any existing picture for this user (all extensions)
    const existing = fs.readdirSync(uploadDir).filter(f => f.startsWith(`user_${userId}.`));
    for (const f of existing) fs.unlinkSync(path.join(uploadDir, f));

    const bytes = await file.arrayBuffer();
    fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(bytes));

    const storedPath = `/uploads/profiles/${filename}`;
    const pictureUrl = `${storedPath}?t=${Date.now()}`;

    // Ensure the column exists before writing (guard is idempotent, cached per process)
    await ensureUserProfilePicture();
    await query('UPDATE users SET profile_picture = $1 WHERE id = $2', [storedPath, userId]);

    return NextResponse.json({ picture_url: pictureUrl });
  } catch (error) {
    console.error('[POST /api/account/me/picture]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!authUser || (authUser.role !== 'admin' && authUser.role !== 'department_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = authUser.id!;

    // Ensure the column exists before querying it
    await ensureUserProfilePicture();

    const row = await query('SELECT profile_picture FROM users WHERE id = $1', [userId]);
    const stored: string | null = row.rows[0]?.profile_picture ?? null;

    if (stored) {
      const normalized = path.normalize(stored.split('?')[0]).replace(/^(\.\.(\/|\\|$))+/, '');
      const filePath = path.join(process.cwd(), 'public', normalized);
      const publicRoot = path.join(process.cwd(), 'public');
      if (filePath.startsWith(publicRoot) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await query('UPDATE users SET profile_picture = NULL WHERE id = $1', [userId]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/account/me/picture]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
