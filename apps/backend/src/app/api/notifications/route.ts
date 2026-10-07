import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { CONDITION_TYPES_SQL, ensureNotificationsTable } from '@/services/notifications';
import { syncWorkloadMonitoringNotifications } from '@/services/workloadMonitoring';
import { syncClassReminders } from '@/services/classReminders';

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as {
      role?: string; faculty_id?: number; id?: number;
    } | null;

    if (!authUser?.role) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureNotificationsTable();
    if (authUser.role === 'admin' || authUser.role === 'department_chair' || authUser.role === 'program_chair') {
      await syncWorkloadMonitoringNotifications(false);
    }
    // Faculty: today's classes and the one starting now (made once each, see classReminders)
    if (authUser.role === 'instructor' && authUser.faculty_id) {
      await syncClassReminders(Number(authUser.faculty_id));
    }

    const { searchParams } = new URL(req.url);
    // Condition alerts come first (see ORDER BY), then the most recent events
    // A missing or unreadable limit (e.g. "abc" → NaN) falls back to 50 instead of reaching Postgres
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10) || 50, 1), 300);

    let result;
    let countResult;
    if (authUser.role === 'admin') {
      [result, countResult] = await Promise.all([
        query(`
          SELECT id, recipient_id, recipient_role, title, message, type,
                 is_read, created_at, related_module, related_id
          FROM   notifications
          WHERE  recipient_role = 'admin'
          ORDER  BY (type IN (${CONDITION_TYPES_SQL})) DESC, created_at DESC
          LIMIT  $1
        `, [limit]),
        query(`
          SELECT COUNT(*) AS cnt FROM notifications
          WHERE  recipient_role = 'admin' AND is_read = false
        `, []),
      ]);
    } else if (authUser.role === 'department_chair') {
      [result, countResult] = await Promise.all([
        query(`
          SELECT id, recipient_id, recipient_role, title, message, type,
                 is_read, created_at, related_module, related_id
          FROM   notifications
          WHERE  recipient_role = 'department_chair'
          ORDER  BY (type IN (${CONDITION_TYPES_SQL})) DESC, created_at DESC
          LIMIT  $1
        `, [limit]),
        query(`
          SELECT COUNT(*) AS cnt FROM notifications
          WHERE  recipient_role = 'department_chair' AND is_read = false
        `, []),
      ]);
    } else if (authUser.role === 'program_chair' && authUser.id) {
      [result, countResult] = await Promise.all([
        query(`
          SELECT id, recipient_id, recipient_role, title, message, type,
                 is_read, created_at, related_module, related_id
          FROM   notifications
          WHERE  recipient_role = 'program_chair'
            AND  recipient_id   = $1
          ORDER  BY (type IN (${CONDITION_TYPES_SQL})) DESC, created_at DESC
          LIMIT  $2
        `, [authUser.id, limit]),
        query(`
          SELECT COUNT(*) AS cnt FROM notifications
          WHERE  recipient_role = 'program_chair'
            AND  recipient_id   = $1
            AND  is_read        = false
        `, [authUser.id]),
      ]);
    } else if (authUser.role === 'instructor' && authUser.faculty_id) {
      [result, countResult] = await Promise.all([
        query(`
          SELECT id, recipient_id, recipient_role, title, message, type,
                 is_read, created_at, related_module, related_id
          FROM   notifications
          WHERE  recipient_role = 'instructor'
            AND  recipient_id   = $1
          ORDER  BY (type IN (${CONDITION_TYPES_SQL})) DESC, created_at DESC
          LIMIT  $2
        `, [authUser.faculty_id, limit]),
        query(`
          SELECT COUNT(*) AS cnt FROM notifications
          WHERE  recipient_role = 'instructor'
            AND  recipient_id   = $1
            AND  is_read        = false
        `, [authUser.faculty_id]),
      ]);
    } else {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const unread_count = parseInt(countResult.rows[0]?.cnt ?? '0', 10);
    return NextResponse.json({ notifications: result.rows, unread_count });
  } catch (error) {
    console.error('[GET /api/notifications]', error);
    return NextResponse.json({ error: 'Failed to load notifications.' }, { status: 500 });
  }
}
