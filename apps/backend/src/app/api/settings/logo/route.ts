import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { ensureSystemSettingsTable } from '@/database/schema-guard';
import { validateImageMagicBytes } from '@/infra/validateUpload';
import fs from 'fs';
import path from 'path';
import { withAudit } from '@/services/audit';
import { uploadDir as storageDir } from '@/services/uploadStorage';


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

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || (auth.role !== 'admin' && auth.role !== 'program_chair')) {
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
    const uploadDir = storageDir('logo');

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

async function DELETE_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || (auth.role !== 'admin' && auth.role !== 'program_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const uploadDir = storageDir('logo');
    {
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

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
export const DELETE = withAudit(DELETE_handler);
