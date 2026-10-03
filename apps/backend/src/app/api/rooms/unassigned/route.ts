import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { canManageRooms } from '@/services/rooms';
import { assignRooms, listRoomlessClasses } from '@/services/roomAutoAssign';
import { withAudit } from '@/services/audit';

/**
 * Classes this term that already have a day and time but no room
 * (services/roomAutoAssign.ts).
 *
 * GET  — grouped by faculty; each class lists the free rooms it may use
 *        and the room "Assign rooms automatically" would give it.
 * POST — gives classes a room:
 *        { session_id, room_id }         one class, the room chosen on screen
 *        { auto: true }                  every class without a room
 *        { auto: true, faculty_id }      one faculty member's classes
 *        A room is only used when no class is booked in it at that time —
 *        checked again here, under the same lock as Scheduling's save,
 *        whatever the screen showed.
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
    return NextResponse.json(await listRoomlessClasses(query, await activeTerm()));
  } catch (error) {
    console.error('[GET /api/rooms/unassigned]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageRooms(auth.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const toId = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
    const auto = body.auto === true;
    const sessionId = toId(body.session_id);
    const roomId = toId(body.room_id);
    if (!auto && !(sessionId && roomId)) {
      return NextResponse.json({ error: 'Choose a class and a room.' }, { status: 400 });
    }
    // auto with faculty_id (an id, or null for classes with no faculty) = that faculty only
    const faculty = auto && 'faculty_id' in body
      ? { id: body.faculty_id != null ? toId(body.faculty_id) : null }
      : undefined;
    if (faculty && body.faculty_id != null && faculty.id === null) {
      return NextResponse.json({ error: 'Choose a faculty member.' }, { status: 400 });
    }
    const term = await activeTerm();

    const outcome = await transaction(async (client) => {
      // One schedule change at a time — the same lock as Scheduling's save
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('qrganize:schedule-save'))`);
      return assignRooms((text, params) => client.query(text, params), { term, auto, sessionId, roomId, faculty });
    });

    if (outcome.missing) {
      return NextResponse.json({ error: 'That class already has a room, or is no longer scheduled.' }, { status: 409 });
    }
    if (!auto && outcome.assigned.length === 0) {
      return NextResponse.json({ error: outcome.skipped[0]?.reason ?? 'The room could not be set.' }, { status: 409 });
    }
    return NextResponse.json({ assigned: outcome.assigned, skipped: outcome.skipped });
  } catch (error) {
    console.error('[POST /api/rooms/unassigned]', error);
    return NextResponse.json({ error: 'Failed to set rooms.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
