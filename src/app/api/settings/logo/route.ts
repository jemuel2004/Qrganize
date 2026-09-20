import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { ensureSystemSettingsTable } from '@/server/schema-guard';
import { validateImageMagicBytes } from '@/server/validateUpload';
import fs from 'fs';
import path from 'path';


export async function GET() {
  try {
    await ensureSystemSettingsTable();
    const result = await query("SELECT value FROM system_settings WHERE key = 'logo_url'");
    const logoUrl = result.rows[0]?.value ?? null;
    return NextResponse.json({ logoUrl });
  } catch {
    return NextResponse.json({ logoUrl: null });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || auth.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get('logo') as File | null;

    if (!file || file.size === 0) {
      return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });
    }

    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      return NextResponse.json({ error: 'Only PNG, JPG, or WEBP images are allowed.' }, { status: 400 });
    }
    if (file.size > 4 * 1024 * 1024) {
      return NextResponse.json({ error: 'File size must be under 4 MB.' }, { status: 400 });
    }
    const magicCheck = await validateImageMagicBytes(file, allowed);
    if (!magicCheck.valid) {
      return NextResponse.json({ error: magicCheck.reason ?? 'Invalid file content.' }, { status: 400 });
    }

    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png':  'png',
      'image/webp': 'webp',
    };
    const ext       = extMap[file.type] ?? 'png';
    const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'logo');

    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    // Remove any previous logo files
    const existing = fs.readdirSync(uploadDir).filter(f => f.startsWith('system-logo.'));
    for (const f of existing) fs.unlinkSync(path.join(uploadDir, f));

    const filename = `system-logo.${ext}`;
    const bytes    = await file.arrayBuffer();
    fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(bytes));

    const storedPath = `/uploads/logo/${filename}`;
    const logoUrl    = `${storedPath}?t=${Date.now()}`;

    await ensureSystemSettingsTable();
    await query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('logo_url', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [storedPath],
    );

    return NextResponse.json({ logoUrl });
  } catch (error) {
    console.error('[POST /api/settings/logo]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || auth.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'logo');
    if (fs.existsSync(uploadDir)) {
      const existing = fs.readdirSync(uploadDir).filter(f => f.startsWith('system-logo.'));
      for (const f of existing) fs.unlinkSync(path.join(uploadDir, f));
    }

    await ensureSystemSettingsTable();
    await query("DELETE FROM system_settings WHERE key = 'logo_url'");

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/settings/logo]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
