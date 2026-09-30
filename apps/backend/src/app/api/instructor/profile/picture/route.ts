import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { validateImageMagicBytes } from '@/infra/validateUpload';
import { ensureInstructorGooglePicture } from '@/database/schema-guard';
import { customProfilePicturePath, resolveInstructorProfilePicture } from '@shared/instructorAvatar';
import { withAudit } from '@/services/audit';
import { deleteUploadsNamed, saveUpload } from '@/services/uploadStorage';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_BYTES = 5 * 1024 * 1024;

async function POST_handler(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get('picture') as File | null;

    if (!file || file.size === 0) {
      return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });
    }

    if (!ALLOWED_MIME.includes(file.type as (typeof ALLOWED_MIME)[number])) {
      return NextResponse.json({ error: 'Only JPEG, PNG, or WebP images are allowed.' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'File must be under 5 MB.' }, { status: 400 });
    }
    const magicCheck = await validateImageMagicBytes(file, [...ALLOWED_MIME]);
    if (!magicCheck.valid) {
      return NextResponse.json({ error: magicCheck.reason ?? 'Invalid file content.' }, { status: 400 });
    }

    const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    const ext = extMap[file.type] ?? 'jpg';
    const storedPath = await saveUpload('profiles', `faculty_${authUser.faculty_id}`, ext, file.type, Buffer.from(await file.arrayBuffer()));
    await query('UPDATE faculty SET profile_picture = $1 WHERE id = $2', [storedPath, authUser.faculty_id]);

    return NextResponse.json({
      picture_url: `${storedPath}?t=${Date.now()}`,
      has_custom_profile_picture: true,
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function DELETE_handler(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureInstructorGooglePicture();

    const row = await query(
      `SELECT f.profile_picture, ia.google_verified, ia.google_picture
       FROM faculty f
       LEFT JOIN instructor_accounts ia ON ia.faculty_id = f.id
       WHERE f.id = $1`,
      [authUser.faculty_id]
    );
    const stored: string | null = row.rows[0]?.profile_picture ?? null;

    if (customProfilePicturePath(stored)) {
      await deleteUploadsNamed('profiles', `faculty_${authUser.faculty_id}`);
    }

    await query('UPDATE faculty SET profile_picture = NULL WHERE id = $1', [authUser.faculty_id]);

    const pictureUrl = resolveInstructorProfilePicture({
      customPicture: null,
      googleVerified: row.rows[0]?.google_verified === true,
      googlePicture: row.rows[0]?.google_picture,
    });

    return NextResponse.json({
      success: true,
      picture_url: pictureUrl,
      has_custom_profile_picture: false,
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
export const DELETE = withAudit(DELETE_handler);
