import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { canManageRooms } from '@/services/rooms';
import { listSplitMajorClasses, putSplitMajorClassesInOneRoom } from '@/services/majorRoomRule';
import { withAudit } from '@/services/audit';

/**
 * Major classes this term whose Lecture and Laboratory are still in two rooms
 * (or in a lecture room) — saved before the one-room rule, e.g. by the Excel
 * workload import (services/majorRoomRule.ts).
 *
 * GET  — each class with the one laboratory it can move into
 * POST — moves them: only rooms change (days and times stay), a room is only
 *        used where no other class is in it then, under the same lock as
 *        Scheduling's save. Nothing is saved if a room would be double-booked.
 */

async function activeTerm() {
  const { semester, schoolYear } = await getActiveAcademicPeriod();
  return { semester: semester ?? '', schoolYear: schoolYear ?? '' };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json(await listSplitMajorClasses(query, await activeTerm()));
  } catch (error) {
    console.error('[GET /api/rooms/one-room]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageRooms(auth.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const term = await activeTerm();
    try {
      const outcome = await transaction(async (client) => {
        // One schedule change at a time — the same lock as Scheduling's save
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('qrganize:schedule-save'))`);
        return putSplitMajorClassesInOneRoom((text, params) => client.query(text, params), term);
      });
      return NextResponse.json({ moved: outcome.moved, left: outcome.left });
    } catch (err) {
      if (err instanceof Error && /double-booked/.test(err.message)) {
        return NextResponse.json({ error: 'Rooms changed while saving — nothing was moved. Please try again.' }, { status: 409 });
      }
      throw err;
    }
  } catch (error) {
    console.error('[POST /api/rooms/one-room]', error);
    return NextResponse.json({ error: 'Failed to move the classes.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
