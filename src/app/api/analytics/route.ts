import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';

async function getActiveSchoolYearSemester(): Promise<{ schoolYear: string; semester: string }> {
  let schoolYear = '';
  try {
    const syRes = await query(
      "SELECT label FROM school_years WHERE status = 'Active' LIMIT 1",
    );
    schoolYear = String(syRes.rows[0]?.label ?? '');
  } catch {
    try {
      const ssRes = await query(
        "SELECT value FROM system_settings WHERE key = 'current_school_year'",
      );
      schoolYear = String(ssRes.rows[0]?.value ?? '');
    } catch {
      schoolYear = '';
    }
  }

  let semester = '';
  try {
    const semRes = await query(
      "SELECT value FROM system_settings WHERE key = 'current_semester'",
    );
    semester = String(semRes.rows[0]?.value ?? '');
  } catch {
    semester = '';
  }

  return { schoolYear, semester };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { schoolYear, semester } = await getActiveSchoolYearSemester();

    const sectionErrors: string[] = [];
    const catchSection = (name: string, fallback: { rows: unknown[] }) => (err: unknown) => {
      console.error(`[analytics] ${name} query failed:`, err);
      sectionErrors.push(name);
      return fallback;
    };

    const [
      monitoringRes,
      workloadByProgramRes,
      roomUtilizationRes,
      schedulesByDayRes,
      recentActivityRes,
    ] = await Promise.all([

      // Monitoring summary: total rooms, scanned today, issues today, vacant today
      query(`
        SELECT
          (SELECT COUNT(*) FROM rooms WHERE status = 'Active') AS total_rooms,
          (SELECT COUNT(DISTINCT room_id) FROM room_utilization_logs WHERE usage_date = CURRENT_DATE) AS scanned_today,
          (SELECT COUNT(*) FROM qr_scan_logs WHERE scan_date = CURRENT_DATE AND status IN ('Late','Overuse')) AS issues_today,
          (SELECT COUNT(*) FROM qr_scan_logs WHERE scan_date = CURRENT_DATE) AS total_scans_today
      `).catch(catchSection('monitoring', {
        rows: [{ total_rooms: 0, scanned_today: 0, issues_today: 0, total_scans_today: 0 }],
      })),

      /*
       * Workload distribution by program — assigned instructor loads (canonical source).
       * block_subjects has no faculty_id; faculty is on instructor_loads / master_schedule.
       */
      query(
        `
        SELECT
          p.name AS program_name,
          p.code AS program_code,
          COUNT(DISTINCT ms.id)::int AS total_subjects,
          COUNT(DISTINCT il.faculty_id)::int AS instructor_count
        FROM instructor_loads il
        JOIN master_schedule ms ON ms.id = il.master_schedule_id
        JOIN block_subjects bs ON bs.id = ms.block_subject_id
        JOIN blocks b ON b.id = bs.block_id
        JOIN programs p ON p.id = b.program_id
        WHERE COALESCE(p.is_active, true) = true
          AND ($1 = '' OR il.academic_year = $1 OR COALESCE(b.academic_year, '') = $1)
          AND ($2 = '' OR il.semester = $2 OR COALESCE(b.semester, '') = $2)
        GROUP BY p.id, p.name, p.code
        ORDER BY total_subjects DESC, p.code ASC
        LIMIT 8
        `,
        [schoolYear, semester],
      ).catch(catchSection('workload_by_program', { rows: [] })),

      // Room utilization: scheduled sessions (Assigned|Scheduled) vs scans (last 7 days)
      query(`
        SELECT
          r.id,
          r.room_name,
          r.room_type,
          COALESCE(r.building, '-') AS building,
          r.status,
          COALESCE(sch.cnt, 0)  AS scheduled_count,
          COALESCE(scan.cnt, 0) AS scanned_count
        FROM rooms r
        LEFT JOIN (
          SELECT ss.room_id, COUNT(*)::int AS cnt
          FROM schedule_sessions ss
          JOIN master_schedule ms ON ss.master_schedule_id = ms.id
          WHERE ms.status IN ('Assigned', 'Scheduled')
            AND ss.room_id IS NOT NULL
          GROUP BY ss.room_id
        ) sch ON sch.room_id = r.id
        LEFT JOIN (
          SELECT room_id, COUNT(*)::int AS cnt
          FROM room_utilization_logs
          WHERE usage_date >= CURRENT_DATE - INTERVAL '6 days'
          GROUP BY room_id
        ) scan ON scan.room_id = r.id
        WHERE r.status = 'Active'
        ORDER BY sch.cnt DESC NULLS LAST, r.room_name
      `).catch(catchSection('room_utilization', { rows: [] })),

      // Schedules by day of week (Mon–Sat academic days; include Assigned + Scheduled)
      query(`
        SELECT
          ss.day_of_week,
          COUNT(DISTINCT ss.master_schedule_id)::int AS count
        FROM schedule_sessions ss
        JOIN master_schedule ms ON ss.master_schedule_id = ms.id
        WHERE ms.status IN ('Assigned', 'Scheduled')
        GROUP BY ss.day_of_week
      `).catch(catchSection('schedules_by_day', { rows: [] })),

      // Recent QR scan activity (UI scrolls; keep a modest backend window)
      query(`
        SELECT
          ql.id,
          r.room_name,
          r.room_type,
          COALESCE(
            NULLIF(TRIM(f.name), ''),
            NULLIF(TRIM(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), ''),
            'Unknown'
          ) AS actor_name,
          ql.status,
          ql.scan_date::text AS event_date,
          ql.scan_time::text AS event_time
        FROM qr_scan_logs ql
        JOIN rooms r ON ql.room_id = r.id
        LEFT JOIN faculty f ON ql.faculty_id = f.id
        ORDER BY ql.scan_date DESC, ql.scan_time DESC
        LIMIT 20
      `).catch(catchSection('recent_activity', { rows: [] })),
    ]);

    const m = monitoringRes.rows[0] ?? {
      total_rooms: 0,
      scanned_today: 0,
      issues_today: 0,
      total_scans_today: 0,
    };

    return NextResponse.json({
      monitoring: {
        total_rooms:   parseInt(String(m.total_rooms), 10) || 0,
        scanned_today: parseInt(String(m.scanned_today), 10) || 0,
        issues_today:  parseInt(String(m.issues_today), 10) || 0,
        total_scans:   parseInt(String(m.total_scans_today), 10) || 0,
        vacant_today:  Math.max(
          0,
          (parseInt(String(m.total_rooms), 10) || 0) - (parseInt(String(m.scanned_today), 10) || 0),
        ),
      },
      workload_by_program: workloadByProgramRes.rows,
      room_utilization:    roomUtilizationRes.rows,
      schedules_by_day:    schedulesByDayRes.rows,
      recent_activity:     recentActivityRes.rows,
      meta: {
        school_year: schoolYear || null,
        semester: semester || null,
        section_errors: sectionErrors,
      },
    });
  } catch (error) {
    console.error('[analytics] GET failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
