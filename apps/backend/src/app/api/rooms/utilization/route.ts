import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { ensureQrScanLogsSchema, ensureRoomOccupancy, expireStaleOccupancy } from '@/services/ensureRoomOccupancy';

/**
 * GET /api/rooms/utilization?date=YYYY-MM-DD&view=daily|weekly|monthly[&room_id=N]
 *
 * "Are the rooms actually being used as scheduled?"
 *
 * For every scheduled class session (active term) that falls in the range,
 * matches the instructor's actual QR check-in for that room/day/time and
 * classifies it:
 *   Occupied     — checked in, class in progress (today)
 *   Completed    — checked in, class over
 *   Pending      — class started < 15 min ago, not checked in yet
 *   Not Checked  — check-in window passed with no scan
 *   Upcoming     — hasn't started yet
 *   Walk-in      — a check-in with no matching scheduled class
 * Plus each room's live status (Available / Pending / Occupied) and, with
 * room_id, that room's raw QR scan logs.
 */

type View = 'daily' | 'weekly' | 'monthly';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CHECKIN_EARLY_MIN = 30; // a scan up to 30 min before start counts
const PENDING_WINDOW_MIN = 15; // same 15-minute window as room reservations

const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + (m || 0); };

/* Date helpers on plain 'YYYY-MM-DD' strings (UTC math, no timezone drift) */
const parseD = (s: string) => new Date(`${s}T00:00:00Z`);
const fmtD = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = parseD(s); d.setUTCDate(d.getUTCDate() + n); return fmtD(d); };

function rangeFor(date: string, view: View): { start: string; end: string } {
  if (view === 'weekly') {
    const dow = parseD(date).getUTCDay();          // 0 Sun … 6 Sat
    const start = addDays(date, dow === 0 ? -6 : 1 - dow); // Monday
    return { start, end: addDays(start, 6) };
  }
  if (view === 'monthly') {
    const d = parseD(date);
    const start = fmtD(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
    const end = fmtD(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    return { start, end };
  }
  return { start: date, end: date };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await ensureRoomOccupancy();
    await ensureQrScanLogsSchema();
    await expireStaleOccupancy();

    const clock = (await query(`SELECT CURRENT_DATE::text AS today, to_char(LOCALTIME, 'HH24:MI') AS now_hm`)).rows[0];
    const today: string = clock.today;
    const nowMin = toMin(clock.now_hm);

    const { searchParams } = new URL(req.url);
    const rawDate = searchParams.get('date') ?? today;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && !Number.isNaN(parseD(rawDate).getTime()) ? rawDate : today;
    const rawView = searchParams.get('view') ?? 'daily';
    const view: View = rawView === 'weekly' || rawView === 'monthly' ? rawView : 'daily';
    const roomIdParam = Number.parseInt(searchParams.get('room_id') ?? '', 10);
    const roomId = Number.isInteger(roomIdParam) && roomIdParam > 0 ? roomIdParam : null;
    const { start, end } = rangeFor(date, view);

    const { schoolYear, semester } = await getActiveAcademicPeriod();

    /* Rooms + live status */
    const roomsRes = await query(`
      SELECT r.id, r.room_name, r.room_type, r.building, r.capacity,
             ro.status AS live_status, ro.occupied_at, ro.reserved_at,
             COALESCE(NULLIF(TRIM(f.name), ''), TRIM(CONCAT_WS(' ', f.first_name, f.last_name))) AS live_faculty
      FROM rooms r
      LEFT JOIN room_occupancy ro ON ro.room_id = r.id AND ro.status IN ('Pending', 'Occupied')
      LEFT JOIN faculty f ON f.id = ro.faculty_id
      WHERE r.status = 'Active' AND ($1::int IS NULL OR r.id = $1)
      ORDER BY r.room_type, r.room_name
    `, [roomId]);

    /* Scheduled sessions with a room, active term */
    const sessRes = await query(`
      SELECT ss.id AS session_id, ss.day_of_week, ss.start_time::text AS start_time, ss.end_time::text AS end_time,
             COALESCE(ss.type, 'lec') AS type, ss.room_id, ms.id AS ms_id, ms.faculty_id,
             ss.created_at::date::text AS created_on,
             COALESCE(NULLIF(TRIM(f.name), ''), TRIM(CONCAT_WS(' ', f.first_name, f.last_name))) AS faculty_name,
             c.subject_code, c.subject_name, b.block_name, b.year_level, p.code AS program_code
      FROM schedule_sessions ss
      JOIN master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN curriculums c ON c.id = bs.curriculum_id
      JOIN blocks b ON b.id = bs.block_id
      JOIN programs p ON p.id = b.program_id
      JOIN rooms r ON r.id = ss.room_id AND r.status = 'Active'
      LEFT JOIN faculty f ON f.id = ms.faculty_id
      WHERE ss.room_id IS NOT NULL
        AND ms.faculty_id IS NOT NULL
        AND ms.status IN ('Assigned', 'Scheduled', 'Completed')
        AND ($1 = '' OR b.semester = $1)
        AND ($2 = '' OR b.academic_year = $2)
        AND ($3::int IS NULL OR ss.room_id = $3)
    `, [semester ?? '', schoolYear ?? '', roomId]);

    /* Actual check-ins (Valid / Late; reservation-only logs don't count) */
    const scanRes = await query(`
      SELECT q.id, q.room_id, q.faculty_id, q.master_schedule_id, q.scan_date::text AS scan_date,
             to_char(q.scan_time, 'HH24:MI') AS scan_hm, q.status,
             COALESCE(NULLIF(TRIM(f.name), ''), TRIM(CONCAT_WS(' ', f.first_name, f.last_name))) AS faculty_name
      FROM qr_scan_logs q
      LEFT JOIN faculty f ON f.id = q.faculty_id
      WHERE q.scan_date BETWEEN $1::date AND $2::date
        AND q.status IN ('Valid', 'Late')
        AND COALESCE(q.notes, '') NOT ILIKE '%pending%'
        AND q.room_id IS NOT NULL
        AND ($3::int IS NULL OR q.room_id = $3)
      ORDER BY q.scan_time
    `, [start, end, roomId]);

    /* Occupancy durations — used to time check-ins that match no current class */
    const walkRes = await query(`
      SELECT ro.room_id, ro.faculty_id, ro.occupied_at::date::text AS d,
             to_char(ro.occupied_at, 'HH24:MI') AS start_hm,
             to_char(COALESCE(ro.released_at, LEAST(ro.expires_at, NOW())), 'HH24:MI') AS end_hm,
             GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(ro.released_at, LEAST(ro.expires_at, NOW())) - ro.occupied_at)) / 3600) AS hrs
      FROM room_occupancy ro
      WHERE ro.occupied_at IS NOT NULL
        AND ro.occupied_at::date BETWEEN $1::date AND $2::date
        AND ($3::int IS NULL OR ro.room_id = $3)
    `, [start, end, roomId]);

    const roomById = new Map(roomsRes.rows.map(r => [Number(r.id), r]));
    const scans = scanRes.rows.map(s => ({ ...s, used: false }));

    type Row = {
      key: string; date: string; day: string; room_id: number; room_name: string; room_type: string;
      subject_code: string | null; subject_name: string | null; component: string | null;
      block: string | null; faculty_id: number | null; faculty_name: string | null;
      start: string | null; end: string | null; scan_time: string | null; late: boolean;
      status: 'Occupied' | 'Completed' | 'Pending' | 'Not Checked' | 'Upcoming' | 'Walk-in';
      hours_scheduled: number; hours_used: number;
    };
    const rows: Row[] = [];

    for (let d = start; d <= end; d = addDays(d, 1)) {
      const dayName = DAYS[parseD(d).getUTCDay()];
      for (const s of sessRes.rows) {
        if (s.day_of_week !== dayName) continue;
        // A class only counts from the day it was put on the schedule — no
        // phantom "Not Checked" rows for dates before it existed
        if (s.created_on && d < s.created_on) continue;
        const room = roomById.get(Number(s.room_id));
        if (!room) continue;
        const st = String(s.start_time).slice(0, 5);
        const et = String(s.end_time).slice(0, 5);
        const stM = toMin(st);
        const etM = toMin(et) > stM ? toMin(et) : toMin(et) + 1440;
        const scan = scans.find(x =>
          !x.used && Number(x.room_id) === Number(s.room_id) && Number(x.faculty_id) === Number(s.faculty_id)
          && x.scan_date === d && toMin(x.scan_hm) >= stM - CHECKIN_EARLY_MIN && toMin(x.scan_hm) <= etM);
        if (scan) scan.used = true;

        const isToday = d === today;
        const future = d > today || (isToday && nowMin < stM);
        let status: Row['status'];
        let used = 0;
        if (scan) {
          const from = Math.max(stM, toMin(scan.scan_hm));
          const to = isToday ? Math.min(etM, Math.max(nowMin, from)) : etM;
          used = Math.max(0, to - from) / 60;
          status = isToday && nowMin < etM ? 'Occupied' : 'Completed';
        } else if (future) {
          status = 'Upcoming';
        } else if (isToday && nowMin < stM + PENDING_WINDOW_MIN && nowMin < etM) {
          status = 'Pending';
        } else {
          status = 'Not Checked';
        }
        rows.push({
          key: `${d}-${s.session_id}`, date: d, day: dayName, room_id: Number(s.room_id),
          room_name: room.room_name, room_type: room.room_type,
          subject_code: s.subject_code, subject_name: s.subject_name, component: s.type,
          block: `${s.program_code} ${String(s.year_level ?? '').match(/\d+/)?.[0] ?? ''}${s.block_name}`.trim(),
          faculty_id: Number(s.faculty_id), faculty_name: s.faculty_name,
          start: st, end: et, scan_time: scan ? scan.scan_hm : null, late: scan?.status === 'Late',
          status, hours_scheduled: (etM - stM) / 60, hours_used: Math.round(used * 100) / 100,
        });
      }
    }

    // Check-ins with no matching class → walk-ins
    for (const x of scans) {
      if (x.used) continue;
      const room = roomById.get(Number(x.room_id));
      if (!room) continue;
      const w = walkRes.rows.find(o => Number(o.room_id) === Number(x.room_id) && Number(o.faculty_id) === Number(x.faculty_id) && o.d === x.scan_date);
      const live = x.scan_date === today && room.live_status === 'Occupied';
      rows.push({
        key: `walk-${x.id}`, date: x.scan_date, day: DAYS[parseD(x.scan_date).getUTCDay()], room_id: Number(x.room_id),
        room_name: room.room_name, room_type: room.room_type,
        subject_code: null, subject_name: null, component: null, block: null,
        faculty_id: x.faculty_id ? Number(x.faculty_id) : null, faculty_name: x.faculty_name,
        start: w?.start_hm ?? x.scan_hm, end: live ? null : (w?.end_hm ?? null), scan_time: x.scan_hm, late: false,
        status: live ? 'Occupied' : 'Walk-in', hours_scheduled: 0,
        hours_used: w ? Math.round(Number(w.hrs) * 100) / 100 : 0,
      });
    }

    rows.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? '').localeCompare(b.start ?? '') || a.room_name.localeCompare(b.room_name, undefined, { numeric: true }));

    /* Raw scan logs for one room (usage history page) */
    let logs: unknown[] = [];
    if (roomId) {
      logs = (await query(`
        SELECT q.id, q.scan_date::text AS scan_date, to_char(q.scan_time, 'HH24:MI') AS scan_hm, q.status, q.notes,
               q.scheduled_start::text AS scheduled_start, q.scheduled_end::text AS scheduled_end,
               COALESCE(NULLIF(TRIM(f.name), ''), TRIM(CONCAT_WS(' ', f.first_name, f.last_name))) AS faculty_name
        FROM qr_scan_logs q LEFT JOIN faculty f ON f.id = q.faculty_id
        WHERE q.room_id = $1 AND q.scan_date BETWEEN $2::date AND $3::date
        ORDER BY q.scan_time DESC
        LIMIT 200
      `, [roomId, start, end])).rows;
    }

    // Next day (after this range) with scheduled classes — for the "no classes" jump
    let nextClassDate: string | null = null;
    const classDays = new Set(sessRes.rows.map(s => s.day_of_week as string));
    if (classDays.size > 0) {
      for (let i = 1, d = addDays(end, 1); i <= 14; i++, d = addDays(d, 1)) {
        const dayName = DAYS[parseD(d).getUTCDay()];
        if (sessRes.rows.some(s => s.day_of_week === dayName && (!s.created_on || d >= s.created_on))) { nextClassDate = d; break; }
      }
    }

    return NextResponse.json({
      today, now: clock.now_hm, date, view, range: { start, end }, next_class_date: nextClassDate,
      term: { semester, school_year: schoolYear },
      rooms: roomsRes.rows.map(r => ({
        id: Number(r.id), room_name: r.room_name, room_type: r.room_type, building: r.building,
        capacity: r.capacity, live_status: r.live_status ?? 'Available', live_faculty: r.live_faculty ?? null,
      })),
      activity: rows,
      logs,
    });
  } catch (error) {
    console.error('[GET /api/rooms/utilization]', error);
    return NextResponse.json({ error: 'Failed to load room utilization.' }, { status: 500 });
  }
}
