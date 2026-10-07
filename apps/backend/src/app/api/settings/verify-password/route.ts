import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import bcrypt from 'bcryptjs';
import { withAudit } from '@/services/audit';

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || (auth.role !== 'admin')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { password } = await req.json();
    if (!password || typeof password !== 'string') {
      return NextResponse.json({ valid: false, error: 'Password is required.' });
    }

    const result = await query('SELECT password_hash FROM users WHERE id = $1', [auth.id]);
    if (!result.rows[0]) {
      return NextResponse.json({ valid: false, error: 'User not found.' });
    }

    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    return NextResponse.json({ valid });
  } catch (error) {
    console.error('[POST /api/settings/verify-password]', error);
    return NextResponse.json({ valid: false, error: 'Verification failed.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
