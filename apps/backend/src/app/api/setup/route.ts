import { NextRequest, NextResponse } from 'next/server';
import { runMigrations } from '@/database/migrate';
import { getAuthUser } from '@/auth/auth';
import { withAudit } from '@/services/audit';

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const role = auth.role as string;
    if (role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await runMigrations();
    return NextResponse.json({ success: true, message: 'Database initialized successfully.' });
  } catch (error) {
    console.error('[POST /api/setup]', error);
    return NextResponse.json({ success: false, error: 'Migration failed.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
