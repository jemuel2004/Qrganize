import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import {
  ensureRoomOccupancy,
  expireStaleOccupancy,
  ensureQrScanLogsSchema,
} from '@/server/ensureRoomOccupancy';

/* Module-level guard — DDL runs once per cold start, never on every request */
let analyticsTablesReady = false;

async function ensureAnalyticsTables() {
  if (analyticsTablesReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS qr_scan_logs (
      id                SERIAL PRIMARY KEY,
      room_id           INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
      faculty_id        INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
      master_schedule_id INTEGER,
      scan_time         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      scan_date         DATE        NOT NULL DEFAULT CURRENT_DATE,
      status            VARCHAR(20) NOT NULL DEFAULT 'Valid',
      notes             TEXT
    )
  `).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS room_utilization_logs (
      id                SERIAL PRIMARY KEY,
      room_id           INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
      faculty_id        INTEGER REFERENCES faculty(id) ON DELETE SET NULL,
      master_schedule_id INTEGER,
      usage_date        DATE        NOT NULL DEFAULT CURRENT_DATE,
      start_time        TIME,
      end_time          TIME,
      status            VARCHAR(20) NOT NULL DEFAULT 'Valid',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  analyticsTablesReady = true;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureRoomOccupancy();
    await ensureAnalyticsTables();
    await ensureQrScanLogsSchema();
    await expireStaleOccupancy();

    const { searchParams } = new URL(req.url);
    // Whitelist period to prevent any SQL injection through string interpolation
    const rawPeriod = searchParams.get('period') ?? 'weekly';
    const period = (['weekly', 'monthly', 'semester'] as const).includes(rawPeriod as 'weekly' | 'monthly' | 'semester')
      ? (rawPeriod as 'weekly' | 'monthly' | 'semester')
      : 'weekly';

    const periodFilter = period === 'monthly'
      ? "AND ro.reserved_at >= NOW() - INTERVAL '30 days'"
      : period === 'semester'
        ? "AND ro.reserved_at >= NOW() - INTERVAL '6 months'"
        : "AND ro.reserved_at >= NOW() - INTERVAL '7 days'";

    const scanPeriodFilter = period === 'monthly'
      ? "AND scan_time >= NOW() - INTERVAL '30 days'"
      : period === 'semester'
        ? "AND scan_time >= NOW() - INTERVAL '6 months'"
        : "AND scan_time >= NOW() - INTERVAL '7 days'";

    /* ── 1. Available rooms ─────────────────────────────────────── */
    const availableResult = await query(`
      SELECT r.id, r.room_name, r.room_type, r.building, r.capacity, r.status
      FROM   rooms r
      WHERE  r.status = 'Active'
        AND  NOT EXISTS (
               SELECT 1 FROM room_occupancy ro
               WHERE  ro.room_id = r.id
                 AND  ro.status IN ('Pending', 'Occupied')
             )
      ORDER BY r.room_name
    `);

    /* ── 2. Pending rooms ───────────────────────────────────────── */
    const pendingResult = await query(`
      SELECT
        ro.id, ro.room_id, ro.faculty_id, ro.status,
        ro.reserved_at, ro.expires_at,
        ro.scheduled_start, ro.scheduled_end,
        r.room_name, r.room_type, r.building,
        COALESCE(
          NULLIF(trim(COALESCE(f.name, '')), ''),
          NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')
        ) AS faculty_name,
        f.employee_id
      FROM  room_occupancy ro
      JOIN  rooms   r ON ro.room_id   = r.id
      JOIN  faculty f ON ro.faculty_id = f.id
      WHERE ro.status = 'Pending'
      ORDER BY ro.reserved_at DESC
    `);

    /* ── 3. Occupied rooms ──────────────────────────────────────── */
    const occupiedResult = await query(`
      SELECT
        ro.id, ro.room_id, ro.faculty_id, ro.status,
        ro.reserved_at, ro.occupied_at, ro.expires_at,
        ro.scheduled_start, ro.scheduled_end,
        r.room_name, r.room_type, r.building,
        COALESCE(
          NULLIF(trim(COALESCE(f.name, '')), ''),
          NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')
        ) AS faculty_name,
        f.employee_id,
        (SELECT c.subject_name
         FROM   schedule_sessions ss
         JOIN   master_schedule ms ON ss.master_schedule_id = ms.id
         JOIN   block_subjects  bs ON ms.block_subject_id   = bs.id
         JOIN   curriculums      c ON bs.curriculum_id       = c.id
         WHERE  ms.faculty_id = ro.faculty_id
           AND  ss.room_id   = ro.room_id
           AND  ss.day_of_week = TO_CHAR(NOW(), 'Day')::text::varchar
           AND  NOW()::time BETWEEN ss.start_time AND ss.end_time
         ORDER  BY ss.start_time
         LIMIT  1) AS current_subject
      FROM  room_occupancy ro
      JOIN  rooms   r ON ro.room_id   = r.id
      JOIN  faculty f ON ro.faculty_id = f.id
      WHERE ro.status = 'Occupied'
      ORDER BY ro.occupied_at DESC
    `);

    /* ── 4. Expired reservations (last 24 h) ────────────────────── */
    const expiredResult = await query(`
      SELECT
        ro.id, ro.room_id, ro.faculty_id,
        ro.reserved_at, ro.expires_at, ro.released_at,
        ro.status,
        ro.scheduled_start, ro.scheduled_end,
        r.room_name, r.room_type, r.building,
        COALESCE(
          NULLIF(trim(COALESCE(f.name, '')), ''),
          NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')
        ) AS faculty_name,
        f.employee_id
      FROM  room_occupancy ro
      JOIN  rooms   r ON ro.room_id   = r.id
      JOIN  faculty f ON ro.faculty_id = f.id
      WHERE ro.status = 'Expired'
        AND ro.reserved_at >= NOW() - INTERVAL '24 hours'
      ORDER BY ro.expires_at DESC
      LIMIT 50
    `);

    /* ── 5. Most utilized rooms (by period) ─────────────────────── */
    const mostUtilizedResult = await query(`
      SELECT
        r.id, r.room_name, r.room_type, r.building, r.capacity,
        COUNT(ro.id)::int AS usage_count,
        ROUND(
          COALESCE(SUM(
            EXTRACT(EPOCH FROM (COALESCE(ro.released_at, ro.expires_at, NOW()) - ro.reserved_at)) / 3600
          ), 0)::numeric, 2
        ) AS total_hours,
        ROUND(
          (COUNT(ro.id)::numeric / NULLIF(
            (SELECT COUNT(*)::numeric FROM room_occupancy ro2
             WHERE ro2.status IN ('Occupied','Released','Expired')
               AND ro2.room_id = r.id
             ), 0
          ) * 100), 1
        ) AS utilization_pct
      FROM  rooms r
      LEFT JOIN room_occupancy ro ON ro.room_id = r.id
        AND ro.status IN ('Occupied','Released','Expired')
        ${periodFilter.replace('AND ro.reserved_at', 'AND ro2.reserved_at').replace('ro2.reserved_at', 'ro.reserved_at')}
      WHERE r.status = 'Active'
      GROUP BY r.id, r.room_name, r.room_type, r.building, r.capacity
      ORDER BY usage_count DESC, total_hours DESC
    `).catch(() => ({ rows: [] }));

    /* ── 6a. Peak hours — hourly scan counts ────────────────────── */
    const peakHoursResult = await query(`
      SELECT
        EXTRACT(HOUR FROM scan_time)::int AS hour,
        COUNT(*)::int AS scan_count
      FROM  qr_scan_logs
      WHERE status IN ('Valid','Late')
        ${scanPeriodFilter}
      GROUP BY hour
      ORDER BY hour
    `).catch(() => ({ rows: [] }));

    /* ── 6b. Peak heatmap — day × hour grid ─────────────────────── */
    const heatmapResult = await query(`
      SELECT
        EXTRACT(DOW FROM scan_time)::int AS day_of_week,
        EXTRACT(HOUR FROM scan_time)::int AS hour,
        COUNT(*)::int AS scan_count
      FROM  qr_scan_logs
      WHERE status IN ('Valid','Late')
        ${scanPeriodFilter}
      GROUP BY day_of_week, hour
      ORDER BY day_of_week, hour
    `).catch(() => ({ rows: [] }));

    /* ── 7. Summary stats ───────────────────────────────────────── */
    const totalRooms    = availableResult.rows.length + pendingResult.rows.length + occupiedResult.rows.length;
    const utilizationRate = totalRooms > 0
      ? Math.round(((pendingResult.rows.length + occupiedResult.rows.length) / totalRooms) * 100)
      : 0;

    /* Build hourly array (0–23) with zeros for missing hours */
    const hourlyMap: Record<number, number> = {};
    for (const row of peakHoursResult.rows) {
      hourlyMap[Number(row.hour)] = Number(row.scan_count);
    }
    const hourly = Array.from({ length: 24 }, (_, h) => ({
      hour: h, count: hourlyMap[h] ?? 0,
    }));

    return NextResponse.json({
      available:      { count: availableResult.rows.length,  rooms:   availableResult.rows  },
      pending:        { count: pendingResult.rows.length,     records: pendingResult.rows    },
      occupied:       { count: occupiedResult.rows.length,    records: occupiedResult.rows   },
      expired:        { count: expiredResult.rows.length,     records: expiredResult.rows    },
      most_utilized:  { rooms: mostUtilizedResult.rows },
      peak_hours:     { hourly, heatmap: heatmapResult.rows },
      summary: {
        total_active_rooms:   totalRooms,
        utilization_rate:     utilizationRate,
        period,
      },
    });
  } catch (error) {
    console.error('[GET /api/rooms/analytics]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
