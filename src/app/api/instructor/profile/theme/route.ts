import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';

async function ensureThemeColumn() {
  await query(`
    ALTER TABLE instructor_accounts
    ADD COLUMN IF NOT EXISTS theme VARCHAR(20) NOT NULL DEFAULT 'light'
  `);
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureThemeColumn();

    const result = await query(
      'SELECT theme FROM instructor_accounts WHERE faculty_id = $1',
      [authUser.faculty_id]
    );

    const theme = result.rows[0]?.theme ?? 'light';
    return NextResponse.json({ theme });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { theme } = body ?? {};
    if (!['dark', 'light', 'system'].includes(theme)) {
      return NextResponse.json({ error: 'Invalid theme value.' }, { status: 400 });
    }

    await ensureThemeColumn();

    await query(
      'UPDATE instructor_accounts SET theme = $1 WHERE faculty_id = $2',
      [theme, authUser.faculty_id]
    );

    return NextResponse.json({ theme });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
