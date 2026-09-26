import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { validateImageMagicBytes } from '@/server/validateUpload';
import fs from 'fs';
import path from 'path';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
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
    const ext      = extMap[file.type] ?? 'jpg';
    const filename = `faculty_${facultyId}.${ext}`;
    const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'profiles');

    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    // Remove old picture files for this faculty
    const existing = fs.readdirSync(uploadDir).filter(f => f.startsWith(`faculty_${facultyId}.`));
    for (const f of existing) fs.unlinkSync(path.join(uploadDir, f));

    const bytes = await file.arrayBuffer();
    fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(bytes));

    const storedPath  = `/uploads/profiles/${filename}`;
    const pictureUrl  = `${storedPath}?t=${Date.now()}`;

    await query('UPDATE faculty SET profile_picture = $1 WHERE id = $2', [storedPath, facultyId]);

    return NextResponse.json({ picture_url: pictureUrl });
  } catch (error) {
    console.error('[POST /api/instructor-accounts/[id]/picture]', error);
    return NextResponse.json({ error: 'Failed to upload picture.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
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
    if (row.rows.length > 0 && row.rows[0].profile_picture) {
      const stored: string = row.rows[0].profile_picture;
      // Resolve the stored path relative to public/ only — prevent traversal
      const normalized = path.normalize(stored.split('?')[0]).replace(/^(\.\.(\/|\\|$))+/, '');
      const filePath = path.join(process.cwd(), 'public', normalized);
      if (filePath.startsWith(path.join(process.cwd(), 'public')) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    await query('UPDATE faculty SET profile_picture = NULL WHERE id = $1', [facultyId]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/instructor-accounts/[id]/picture]', error);
    return NextResponse.json({ error: 'Failed to delete picture.' }, { status: 500 });
  }
}
