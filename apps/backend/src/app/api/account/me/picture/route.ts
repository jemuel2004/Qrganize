import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { ensureUserProfilePicture } from '@/database/schema-guard';
import { validateImageMagicBytes } from '@/infra/validateUpload';
import { withAudit } from '@/services/audit';
import { deleteUploadedFile, saveUpload } from '@/services/uploadStorage';

async function POST_handler(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!authUser || !['admin', 'department_chair', 'program_chair'].includes(authUser.role ?? '')) {
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

    // Replaces any existing picture for this user (all extensions)
    const storedPath = await saveUpload('profiles', `user_${userId}`, ext, file.type, Buffer.from(await file.arrayBuffer()));
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

async function DELETE_handler(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!authUser || !['admin', 'department_chair', 'program_chair'].includes(authUser.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = authUser.id!;

    // Ensure the column exists before querying it
    await ensureUserProfilePicture();

    const row = await query('SELECT profile_picture FROM users WHERE id = $1', [userId]);
    const stored: string | null = row.rows[0]?.profile_picture ?? null;

    await deleteUploadedFile(stored);

    await query('UPDATE users SET profile_picture = NULL WHERE id = $1', [userId]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/account/me/picture]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
export const DELETE = withAudit(DELETE_handler);
