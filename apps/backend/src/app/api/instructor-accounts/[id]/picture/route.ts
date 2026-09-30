import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { validateImageMagicBytes } from '@/infra/validateUpload';
import { withAudit } from '@/services/audit';
import { deleteUploadedFile, saveUpload } from '@/services/uploadStorage';

type Params = { params: Promise<{ id: string }> };

async function POST_handler(req: NextRequest, { params }: Params) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: rawId } = await params;
    const facultyId = parseInt(rawId, 10);
    if (!Number.isInteger(facultyId) || facultyId <= 0) {
      return NextResponse.json({ error: 'Invalid faculty ID.' }, { status: 400 });
    }

    const formData = await req.formData();
    const file = formData.get('picture') as File | null;

    if (!file || file.size === 0)
      return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });

    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.type))
      return NextResponse.json({ error: 'Only JPEG, PNG, WebP, or GIF images are allowed.' }, { status: 400 });

    if (file.size > 5 * 1024 * 1024)
      return NextResponse.json({ error: 'File must be under 5 MB.' }, { status: 400 });

    const magicCheck = await validateImageMagicBytes(file, allowed);
    if (!magicCheck.valid)
      return NextResponse.json({ error: magicCheck.reason ?? 'Invalid file content.' }, { status: 400 });

    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    };
    const ext = extMap[file.type] ?? 'jpg';

    // Replaces old picture files for this faculty
    const storedPath  = await saveUpload('profiles', `faculty_${facultyId}`, ext, file.type, Buffer.from(await file.arrayBuffer()));
    const pictureUrl  = `${storedPath}?t=${Date.now()}`;

    await query('UPDATE faculty SET profile_picture = $1 WHERE id = $2', [storedPath, facultyId]);

    return NextResponse.json({ picture_url: pictureUrl });
  } catch (error) {
    console.error('[POST /api/instructor-accounts/[id]/picture]', error);
    return NextResponse.json({ error: 'Failed to upload picture.' }, { status: 500 });
  }
}

async function DELETE_handler(req: NextRequest, { params }: Params) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: rawId } = await params;
    const facultyId = parseInt(rawId, 10);
    if (!Number.isInteger(facultyId) || facultyId <= 0) {
      return NextResponse.json({ error: 'Invalid faculty ID.' }, { status: 400 });
    }

    const row = await query('SELECT profile_picture FROM faculty WHERE id = $1', [facultyId]);
    // Only files inside the upload folder can be removed — prevents traversal
    await deleteUploadedFile(row.rows[0]?.profile_picture ?? null);

    await query('UPDATE faculty SET profile_picture = NULL WHERE id = $1', [facultyId]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/instructor-accounts/[id]/picture]', error);
    return NextResponse.json({ error: 'Failed to delete picture.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
export const DELETE = withAudit(DELETE_handler);
