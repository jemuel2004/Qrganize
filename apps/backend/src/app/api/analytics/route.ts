import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { computeWorkloadMonitoring } from '@/services/workloadMonitoring';
import {
  DAY_END_MIN, DAY_START_MIN, LUNCH_END_MIN, LUNCH_START_MIN, timeToMinutes,
} from '@/services/scheduleConflicts';

/*
 * Analytics for the active term.
 *
 * Room utilization is read off the timetable as it stood on a given date
 * (sessions created on or before it): a room's booked minutes per week ÷
 * bookable minutes per week (Mon–Sat, 7 AM–6 PM minus lunch). The range end
 * gives the current rate, the range start the "previous" one, and each month
 * end a trend point. Weekly patterns (by day / by time / class type) and
 * conflicts describe the timetable as it stands now.
 */

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK_CAPACITY_MIN = DAYS.length * (DAY_END_MIN - DAY_START_MIN - (LUNCH_END_MIN - LUNCH_START_MIN));
/** Two-hour buckets 7–9 AM … 3–5 PM, then the last part of the day (5–6 PM) */
const TIME_BUCKETS = Array.from({ length: Math.ceil((DAY_END_MIN - DAY_START_MIN) / 120) }, (_, i) => DAY_START_MIN + i * 120);
const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

type Kind = 'lec' | 'lab';
const kindOf = (roomType: unknown): Kind =>
  roomType === 'Laboratory' || roomType === 'Computer Lab' ? 'lab' : 'lec';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const toMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const toYmd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const manilaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
/** Percentage to one decimal, capped at 100 */
const pct = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 1000) / 10) : 0);

interface Session {
  ms_id: number; faculty_id: number | null; block_id: number; room_id: number | null;
  day: string; type: Kind; start: number; end: number; created_on: string;
  subject_code: string; block_name: string; faculty_name: string | null;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    /* ── Range (default: the last 30 days) ─────────────────────────────── */
    const sp = req.nextUrl.searchParams;
    let to = YMD.test(sp.get('to') ?? '') ? sp.get('to')! : manilaToday();
    let from = YMD.test(sp.get('from') ?? '') ? sp.get('from')! : toYmd(toMs(to) - 30 * DAY_MS);
    if (from > to) [from, to] = [to, from];
    if ((toMs(to) - toMs(from)) / DAY_MS > MAX_RANGE_DAYS) from = toYmd(toMs(to) - MAX_RANGE_DAYS * DAY_MS);

    const { schoolYear, semester } = await getActiveAcademicPeriod();
    const term = [semester ?? '', schoolYear ?? ''];
    const termJoin = `JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN blocks b ON b.id = bs.block_id`;
    const inTerm = `($1 = '' OR b.semester = $1) AND ($2 = '' OR b.academic_year = $2)`;
    const scheduled = `ms.status IN ('Assigned', 'Scheduled', 'Completed')`;

    const [sessRes, classRes, roomsRes, loadsRes, facultyRes, monitoring] = await Promise.all([
      query(`
        SELECT ms.id AS ms_id, ms.faculty_id, bs.block_id, ss.room_id, ss.day_of_week AS day,
               COALESCE(ss.type, 'lec') AS type, ss.start_time::text AS start_time,
               ss.end_time::text AS end_time, ss.created_at::date::text AS created_on,
               c.subject_code, b.block_name,
               COALESCE(NULLIF(TRIM(f.name), ''), NULLIF(TRIM(CONCAT_WS(' ', f.first_name, f.last_name)), '')) AS faculty_name
        FROM schedule_sessions ss
        JOIN master_schedule ms ON ms.id = ss.master_schedule_id
        ${termJoin}
        JOIN curriculums c ON c.id = bs.curriculum_id
        LEFT JOIN faculty f ON f.id = ms.faculty_id
        WHERE ${scheduled} AND ${inTerm}
          AND ss.day_of_week IS NOT NULL AND ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
      `, term),
      // Every subject offering this term (scheduled or not) + its program
      query(`
        SELECT ms.id, ms.status, ms.faculty_id, COALESCE(p.code, 'Other') AS program_code
        FROM master_schedule ms
        ${termJoin}
        LEFT JOIN programs p ON p.id = b.program_id
        WHERE ${inTerm}
      `, term),
      // "In use" = held right now (QR occupancy) or a class is running in it now
      query(`
        SELECT r.id, r.room_name, r.room_type, r.status,
               (r.status = 'Active' AND (
                 EXISTS (SELECT 1 FROM room_occupancy ro WHERE ro.room_id = r.id AND ro.status IN ('Pending', 'Occupied'))
                 OR EXISTS (
                   SELECT 1 FROM schedule_sessions ss
                   JOIN master_schedule ms ON ms.id = ss.master_schedule_id
                   ${termJoin}
                   WHERE ss.room_id = r.id AND ${scheduled} AND ${inTerm}
                     AND ss.day_of_week = TRIM(to_char(NOW() AT TIME ZONE 'Asia/Manila', 'FMDay'))
                     AND (NOW() AT TIME ZONE 'Asia/Manila')::time >= ss.start_time
                     AND (NOW() AT TIME ZONE 'Asia/Manila')::time <  ss.end_time
                 )
               )) AS in_use
        FROM rooms r
      `, term),
      // Every load an instructor carries this term (subjects + overload / praise portions)
      query(`
        SELECT il.faculty_id, il.load_category AS category
        FROM instructor_loads il
        JOIN faculty f ON f.id = il.faculty_id AND f.is_active = true
        JOIN master_schedule ms ON ms.id = il.master_schedule_id
        ${termJoin}
        WHERE ${inTerm}
        UNION ALL
        SELECT o.faculty_id, CASE WHEN o.is_praise THEN 'Praise' ELSE 'Overload' END
        FROM overloads o
        JOIN faculty f ON f.id = o.faculty_id AND f.is_active = true
        WHERE ($1 = '' OR o.semester = $1) AND ($2 = '' OR o.academic_year = $2)
      `, term),
      query(`
        SELECT id, employment_status, position,
               COALESCE(NULLIF(TRIM(name), ''), NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), ''), 'Unnamed') AS name
        FROM faculty WHERE is_active = true
        ORDER BY name
      `),
      // Same workload rules as the Dashboard / notifications
      computeWorkloadMonitoring(),
    ]);

    /* ── Rooms ─────────────────────────────────────────────────────────── */
    const rooms = roomsRes.rows as { id: number; room_name: string; room_type: string; status: string; in_use: boolean }[];
    const active = rooms.filter(r => r.status === 'Active');
    const activeIds = new Set(active.map(r => r.id));
    const roomKind = new Map(rooms.map(r => [r.id, kindOf(r.room_type)]));

    const sessions: Session[] = (sessRes.rows as Record<string, unknown>[]).map(r => {
      const start = timeToMinutes(String(r.start_time));
      let end = timeToMinutes(String(r.end_time));
      if (end <= start) end += 24 * 60; // ends at midnight
      return {
        ms_id: Number(r.ms_id), faculty_id: r.faculty_id == null ? null : Number(r.faculty_id),
        block_id: Number(r.block_id), room_id: r.room_id == null ? null : Number(r.room_id),
        day: String(r.day), type: r.type === 'lab' ? 'lab' : 'lec', start, end, created_on: String(r.created_on),
        subject_code: String(r.subject_code ?? ''), block_name: String(r.block_name ?? ''),
        faculty_name: r.faculty_name == null ? null : String(r.faculty_name),
      };
    });

    /* ── Weekly booked room minutes, timetable as of a date ─────────────── */
    const roomSessions = sessions.filter(x => x.room_id != null && activeIds.has(x.room_id) && DAYS.includes(x.day));
    const bookedAsOf = (date: string) => {
      const perRoom = new Map<number, number>();
      for (const x of roomSessions) {
        if (x.created_on > date) continue; // not on the timetable yet
        perRoom.set(x.room_id!, (perRoom.get(x.room_id!) ?? 0) + (x.end - x.start));
      }
      const total = [...perRoom.values()].reduce((a, b) => a + b, 0);
      return { perRoom, rate: pct(total, WEEK_CAPACITY_MIN * active.length) };
    };

    const current = bookedAsOf(to);
    const previous = bookedAsOf(toYmd(toMs(from) - DAY_MS));

    const perRoom = active
      .map(r => ({ id: r.id, room_name: r.room_name, kind: kindOf(r.room_type), pct: pct(current.perRoom.get(r.id) ?? 0, WEEK_CAPACITY_MIN) }))
      .sort((a, b) => b.pct - a.pct || a.room_name.localeCompare(b.room_name));
    const mostUsed = perRoom.filter(r => r.pct > 0).slice(0, 5);

    /* ── Weekly patterns ───────────────────────────────────────────────── */
    const byDay = Object.fromEntries(DAYS.map(d => [d, { lec: 0, lab: 0 }]));
    const byTime = TIME_BUCKETS.map(start => ({ start, lec: 0, lab: 0 }));
    const components = { lec: new Set<number>(), lab: new Set<number>() };
    for (const s of sessions) {
      components[s.type].add(s.ms_id);
      const kind = s.room_id != null ? roomKind.get(s.room_id) : undefined;
      if (!kind) continue; // no room yet — not room usage
      if (byDay[s.day]) byDay[s.day][kind]++;
      for (const b of byTime) if (s.start < b.start + 120 && s.end > b.start) b[kind]++;
    }

    /* ── Conflicts in the current timetable (same rules as Scheduling) ─── */
    const clash = { instructor: 0, room: 0, block: 0 };
    const roomName = new Map(rooms.map(r => [r.id, r.room_name]));
    const classLabel = (x: Session) => `${x.subject_code} (${x.block_name})${x.faculty_name ? ` · ${x.faculty_name}` : ''}`;
    const conflictList: { type: 'instructor' | 'room' | 'block'; day: string; start: number; end: number; a: string; b: string; room: string | null }[] = [];
    const conflicted = new Set<number>(); // offerings involved in any clash
    const note = (type: 'instructor' | 'room' | 'block', a: Session, b: Session) => {
      clash[type]++;
      conflicted.add(a.ms_id).add(b.ms_id);
      conflictList.push({
        type, day: a.day, start: Math.max(a.start, b.start), end: Math.min(a.end, b.end),
        a: classLabel(a), b: classLabel(b), room: type === 'room' ? roomName.get(a.room_id!) ?? null : null,
      });
    };
    for (const day of DAYS) {
      const list = sessions.filter(s => s.day === day);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (a.ms_id === b.ms_id && a.type === b.type) continue;
          if (!(a.start < b.end && b.start < a.end)) continue;
          if (a.faculty_id != null && a.faculty_id === b.faculty_id) note('instructor', a, b);
          if (a.room_id != null && a.room_id === b.room_id && a.faculty_id !== b.faculty_id) note('room', a, b);
          if (a.block_id === b.block_id) note('block', a, b);
        }
      }
    }

    /* ── Instructors by heaviest load kind: Overload › Praise › Regular ── */
    const kinds = new Map<number, Set<string>>();
    for (const r of loadsRes.rows as { faculty_id: number; category: string }[]) {
      kinds.set(r.faculty_id, (kinds.get(r.faculty_id) ?? new Set()).add(r.category));
    }
    const loadOf = (set: Set<string> | undefined) =>
      !set ? null : set.has('Overload') ? 'Overload' : set.has('Praise') ? 'Praise' : 'Regular';
    const workload = { regular: 0, overload: 0, praise: 0 };
    for (const set of kinds.values()) workload[loadOf(set)!.toLowerCase() as keyof typeof workload]++;

    /* ── Trends: the 5 months up to the range end ──────────────────────── */
    const end = new Date(toMs(to));
    const trends = Array.from({ length: 5 }, (_, i) => {
      const m = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 4 + i, 1);
      const monthEnd = toYmd(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 3 + i, 0));
      const upTo = monthEnd < to ? monthEnd : to;
      return {
        month: new Date(m).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
        utilization: bookedAsOf(upTo).rate,
        classes: new Set(sessions.filter(s => s.created_on <= upTo).map(s => s.ms_id)).size,
      };
    });

    const facultyList = (facultyRes.rows as { id: number; name: string; employment_status: string | null; position: string | null }[])
      .map(f => ({ ...f, load: loadOf(kinds.get(f.id)) }));
    const permanent = facultyList.filter(f => f.employment_status === 'Permanent').length;
    /* ── Offerings: scheduled / unscheduled (by program) / with conflict ── */
    const offerings = classRes.rows as { id: number; status: string; faculty_id: number | null; program_code: string }[];
    const scheduledIds = new Set(sessions.map(x => x.ms_id));
    const unscheduledByProgram = new Map<string, number>();
    for (const o of offerings) {
      if (!scheduledIds.has(o.id)) unscheduledByProgram.set(o.program_code, (unscheduledByProgram.get(o.program_code) ?? 0) + 1);
    }
    const unassigned = offerings.filter(o => o.status === 'Unassigned' || o.faculty_id == null).length;

    /* ── Weekly occupancy heatmap: % of active rooms in use, day × hour ── */
    const HEAT_HOURS = Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 }, (_, i) => DAY_START_MIN / 60 + i);
    const heatmap = DAYS.map(day => ({
      day,
      values: HEAT_HOURS.map(h => {
        const inUse = new Set(roomSessions.filter(x => x.day === day && x.start < (h + 1) * 60 && x.end > h * 60).map(x => x.room_id));
        return active.length ? Math.round((inUse.size / active.length) * 100) : 0;
      }),
    }));
    const buckets: [string, (p: number) => boolean][] = [
      ['Under 50%', p => p < 50],
      ['50–75%', p => p >= 50 && p <= 75],
      ['76–90%', p => p > 75 && p <= 90],
      ['Over 90%', p => p > 90],
    ];

    return NextResponse.json({
      range: { from, to },
      term: { semester, school_year: schoolYear },
      kpis: {
        rooms: { total: active.length, lec: active.filter(r => kindOf(r.room_type) === 'lec').length, lab: active.filter(r => kindOf(r.room_type) === 'lab').length },
        utilization: current.rate,
        utilization_change: Math.round((current.rate - previous.rate) * 10) / 10,
        instructors: { total: facultyList.length, permanent, contractual: facultyList.length - permanent },
        conflicts: clash.instructor + clash.room + clash.block,
      },
      room_status: {
        in_use: active.filter(r => r.in_use).length,
        available: active.filter(r => !r.in_use).length,
        inactive: rooms.length - active.length,
      },
      usage_by_day: DAYS.map(d => ({ day: d, ...byDay[d] })),
      usage_by_time: byTime,
      most_used: mostUsed,
      least_used: perRoom.filter(r => !mostUsed.includes(r)).reverse().slice(0, 5),
      workload,
      class_types: { lec: components.lec.size, lab: components.lab.size },
      scheduling: {
        scheduled: new Set(sessions.map(s => s.ms_id)).size,
        unassigned,
        conflicts: clash.room + clash.block,
        instructor_conflicts: clash.instructor,
      },
      offerings: {
        total: offerings.length,
        scheduled: scheduledIds.size,
        conflicted: [...scheduledIds].filter(id => conflicted.has(id)).length,
        unscheduled_by_program: [...unscheduledByProgram].map(([program, count]) => ({ program, count })).sort((a, b) => b.count - a.count),
      },
      conflict_counts: { room: clash.room, faculty: clash.instructor, block: clash.block },
      // Complete / complete with overload / in progress / not started — per faculty
      faculty_load: (() => {
        const needsSchedule = new Set(monitoring.schedule_needed_instructors.map(i => i.faculty_id));
        return monitoring.faculty_loads.map(f => ({
          faculty_id: f.faculty_id,
          name: f.name,
          current: f.current_load,
          limit: f.regular_load_limit,
          unit: f.unit,
          status: f.status === 'OVERLOAD' ? 'overload'
            : f.status === 'COMPLETE' ? 'complete'
              : f.current_load > 0.001 ? 'in_progress' : 'not_started',
          needs_schedule: needsSchedule.has(f.faculty_id),
        }));
      })(),
      heatmap: { hours: HEAT_HOURS, days: heatmap },
      capacity: buckets.map(([label, test]) => ({ label, rooms: perRoom.filter(r => test(r.pct)).length })),
      trends,
      // Detail lists for the summary-card pop-ups
      details: {
        rooms: rooms
          .map(r => ({
            id: r.id, room_name: r.room_name, kind: kindOf(r.room_type),
            status: r.status !== 'Active' ? 'Inactive' : r.in_use ? 'In Use' : 'Available',
            pct: pct(current.perRoom.get(r.id) ?? 0, WEEK_CAPACITY_MIN),
          }))
          .sort((a, b) => a.room_name.localeCompare(b.room_name, undefined, { numeric: true })),
        faculty: facultyList,
        conflicts: conflictList.sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start - b.start),
      },
    });
  } catch (error) {
    console.error('[analytics] GET failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
