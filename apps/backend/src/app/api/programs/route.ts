import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { withAudit } from '@/services/audit';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const result = await query('SELECT * FROM programs WHERE is_active = true ORDER BY code');
    return NextResponse.json({ programs: result.rows });
  } catch (error) {
    console.error('[GET /api/programs]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || (auth.role !== 'admin' && auth.role !== 'program_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { code, name, department } = await req.json();
    if (!code || !name) return NextResponse.json({ error: 'Code and name are required' }, { status: 400 });

    const result = await query(
      'INSERT INTO programs (code, name, department) VALUES ($1, $2, $3) RETURNING *',
      [code.toUpperCase(), name, department]
    );
    return NextResponse.json({ program: result.rows[0] }, { status: 201 });
  } catch (error) {
    if (String(error).includes('unique')) return NextResponse.json({ error: 'Program code already exists' }, { status: 409 });
    console.error('[POST /api/programs]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
