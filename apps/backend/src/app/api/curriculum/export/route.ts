import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import {
  buildCurriculumWorkbook,
  type CurriculumExportGroup,
  type ExportLogo,
} from '@shared/curriculumExport';
import { withAudit } from '@/services/audit';
import { readUpload } from '@/services/uploadStorage';

interface ExportBody {
  programName?: string;
  programCode?: string;
  curriculumLabel?: string;
  groups?: CurriculumExportGroup[];
  logo?: { base64?: string; extension?: string } | null;
}

function isSubject(value: unknown): value is CurriculumExportGroup['subjects'][number] {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.subject_code === 'string' && typeof row.subject_name === 'string';
}

function normalizeGroups(raw: unknown): CurriculumExportGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(group => {
    if (!group || typeof group !== 'object') return [];
    const item = group as Record<string, unknown>;
    const subjects = Array.isArray(item.subjects) ? item.subjects.filter(isSubject).map(subject => ({
      subject_code: String(subject.subject_code),
      subject_name: String(subject.subject_name),
      lecture_hours: Number(subject.lecture_hours) || 0,
      laboratory_hours: Number(subject.laboratory_hours) || 0,
      units: Number(subject.units) || 0,
      prerequisites: String(subject.prerequisites ?? ''),
      grade: String(subject.grade ?? ''),
    })) : [];
    if (subjects.length === 0) return [];
    return [{
      yearLevel: String(item.yearLevel ?? ''),
      semester: String(item.semester ?? ''),
      subjects,
    }];
  });
}

async function resolveLogo(clientLogo?: ExportBody['logo']): Promise<ExportLogo | null> {
  if (clientLogo?.base64) {
    const buffer = Uint8Array.from(Buffer.from(clientLogo.base64, 'base64'));
    if (buffer.byteLength > 0 && buffer.byteLength < 1_500_000) {
      return {
        buffer,
        extension: clientLogo.extension === 'jpeg' || clientLogo.extension === 'jpg' ? 'jpeg' : 'png',
      };
    }
  }

  try {
    const result = await query("SELECT value FROM system_settings WHERE key = 'logo_url'");
    const stored = String(result.rows[0]?.value ?? '').split('?')[0];
    for (const url of [stored, '/uploads/logo/system-logo.png']) {
      const upload = await readUpload(url);
      if (!upload || upload.data.byteLength > 1_200_000) continue;
      if (upload.contentType !== 'image/png' && upload.contentType !== 'image/jpeg') continue;
      return { buffer: new Uint8Array(upload.data), extension: upload.contentType === 'image/jpeg' ? 'jpeg' : 'png' };
    }

    for (const file of [path.join(process.cwd(), 'public', 'nemlogo', 'NEMSU-logo.png')]) {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile() || stat.size > 1_200_000) continue;
      const buffer = new Uint8Array(await fs.readFile(file));
      const lower = file.toLowerCase();
      const extension = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'jpeg' : 'png';
      return { buffer, extension };
    }
  } catch {
    /* logo is optional */
  }
  return null;
}

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json() as ExportBody;
    const groups = normalizeGroups(body.groups);
    if (groups.length === 0) {
      return NextResponse.json({ error: 'No curriculum subjects to export.' }, { status: 400 });
    }

    const logo = await resolveLogo(body.logo);
    const buffer = await buildCurriculumWorkbook({
      programName: String(body.programName || body.programCode || 'Curriculum'),
      programCode: body.programCode,
      curriculumLabel: String(body.curriculumLabel || 'Curriculum'),
      groups,
    }, logo);

    const slug = String(body.programCode || 'Curriculum').replace(/[^\w-]+/g, '_');
    const version = String(body.curriculumLabel || 'Curriculum').replace(/\s+/g, '_');
    const filename = `${slug}_${version}_Curriculum.xlsx`;

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[POST /api/curriculum/export]', error);
    return NextResponse.json({ error: 'Could not generate the Excel template.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
