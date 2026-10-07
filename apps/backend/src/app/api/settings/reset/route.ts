import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query, transaction } from '@/database/db';
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
      return NextResponse.json({ error: 'Password is required.' }, { status: 400 });
    }

    // Re-verify password server-side
    const userResult = await query('SELECT password_hash FROM users WHERE id = $1', [auth.id]);
    if (!userResult.rows[0]) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }
    const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!valid) {
      return NextResponse.json({ error: 'Incorrect password. Reset cancelled.' }, { status: 403 });
    }

    // Perform reset inside a transaction
    await transaction(async (client) => {
      // Clear scan/utilization logs
      await client.query('DELETE FROM qr_scan_logs');
      await client.query('DELETE FROM room_utilization_logs');
      await client.query('DELETE FROM violations');
      await client.query('DELETE FROM room_change_requests');
      await client.query('DELETE FROM room_occupancy');

      // Clear workload-specific data
      await client.query('DELETE FROM praise');
      await client.query('DELETE FROM instructor_load_deductions');

      // Clear schedule data (cascades to schedule_sessions, instructor_loads, overloads)
      await client.query('DELETE FROM master_schedule');

      // Reset block_subjects status back to Unscheduled
      await client.query("UPDATE block_subjects SET status = 'Unscheduled'");
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[settings/reset]', err);
    return NextResponse.json({ error: 'Reset failed. Please try again.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
