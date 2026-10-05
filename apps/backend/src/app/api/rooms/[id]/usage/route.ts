import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { parseId } from '@/database/ids';
import { getAuthUser } from '@/auth/auth';

/**
 * Which classes are scheduled in this room — shown before a room is
 * deactivated or deleted so the admin knows what it affects.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const sessions = await query(`
      SELECT c.subject_code, COALESCE(ss.type, 'lec') AS type, b.block_name, p.code AS program_code,
             ss.day_of_week AS day, ss.start_time::text AS start_time, ss.end_time::text AS end_time,
             b.semester, b.academic_year
      FROM schedule_sessions ss
      JOIN master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN block_subjects  bs ON bs.id = ms.block_subject_id
      JOIN curriculums     c  ON c.id  = bs.curriculum_id
      JOIN blocks          b  ON b.id  = bs.block_id
      JOIN programs        p  ON p.id  = b.program_id
      WHERE ss.room_id = $1
      ORDER BY b.academic_year DESC, b.semester,
        CASE ss.day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
          WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END,
        ss.start_time
    `, [id]);
    const masterRefs = await query('SELECT COUNT(*)::int AS n FROM master_schedule WHERE room_id = $1', [id]);

    const count = sessions.rows.length;
    return NextResponse.json({
      in_use: count > 0 || Number(masterRefs.rows[0]?.n ?? 0) > 0,
      session_count: count,
      sessions: sessions.rows.slice(0, 8),
    });
  } catch (error) {
    console.error('[GET /api/rooms/[id]/usage]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
