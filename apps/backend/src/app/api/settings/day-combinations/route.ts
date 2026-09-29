import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { transaction } from '@/database/db';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { getTermDayCombinations } from '@/services/dayCombinations';
import { withAudit } from '@/services/audit';
import { daysKey, parseDays } from '@shared/dayCombination';

/*
 * Semester Day Combinations (Settings → Day Combinations).
 *   GET ?academic_year=&semester=  — defaults to the active term; any signed-in
 *        user (Scheduling, Class Program and the workload print all read it).
 *   PUT { academic_year, semester, combinations: [{ days, is_active }] } —
 *        saves the term's whole list (Admin / Program Chair, like Settings).
 * Existing schedules are never changed; the list only governs new scheduling.
 */

const MAX_COMBINATIONS = 30;

async function resolveTerm(academicYear: unknown, semester: unknown) {
  const ay = String(academicYear ?? '').trim();
  const sem = String(semester ?? '').trim();
  if (ay && sem) return { academic_year: ay, semester: sem };
  const period = await getActiveAcademicPeriod();
  return { academic_year: ay || period.schoolYear || '', semester: sem || period.semester || '' };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const sp = new URL(req.url).searchParams;
    const term = await resolveTerm(sp.get('academic_year'), sp.get('semester'));
    const combinations = await getTermDayCombinations(term.academic_year, term.semester);
    return NextResponse.json({
      ...term,
      combinations,
      /** true when scheduling is limited to the active combinations */
      restricted: combinations.some(c => c.is_active),
    });
  } catch (error) {
    console.error('[GET /api/settings/day-combinations]', error);
    return NextResponse.json({ error: 'Failed to load day combinations.' }, { status: 500 });
  }
}

async function PUT_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (auth.role !== 'admin' && auth.role !== 'program_chair') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({})) as {
      academic_year?: unknown; semester?: unknown; combinations?: unknown;
    };
    const term = await resolveTerm(body.academic_year, body.semester);
    if (!term.academic_year || !term.semester) {
      return NextResponse.json({ error: 'Set the active school year and semester first.' }, { status: 400 });
    }
    if (!Array.isArray(body.combinations)) {
      return NextResponse.json({ error: 'combinations must be a list.' }, { status: 400 });
    }
    if (body.combinations.length > MAX_COMBINATIONS) {
      return NextResponse.json({ error: `At most ${MAX_COMBINATIONS} day combinations per semester.` }, { status: 400 });
    }

    // Validate every entry: readable days, no duplicates
    const seen = new Set<string>();
    const rows: { key: string; is_active: boolean }[] = [];
    for (const raw of body.combinations as { days?: unknown; is_active?: unknown }[]) {
      const days = parseDays(Array.isArray(raw?.days) ? raw.days.map(String) : String(raw?.days ?? ''));
      if (!days) return NextResponse.json({ error: 'Each day combination needs at least one valid day.' }, { status: 400 });
      const key = daysKey(days);
      if (seen.has(key)) return NextResponse.json({ error: `${key} is listed twice.` }, { status: 400 });
      seen.add(key);
      rows.push({ key, is_active: raw?.is_active !== false });
    }

    await transaction(async client => {
      await client.query(
        'DELETE FROM semester_day_combinations WHERE academic_year = $1 AND semester = $2',
        [term.academic_year, term.semester],
      );
      for (let i = 0; i < rows.length; i++) {
        await client.query(
          `INSERT INTO semester_day_combinations (academic_year, semester, days, is_active, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [term.academic_year, term.semester, rows[i].key, rows[i].is_active, i],
        );
      }
    });

    const combinations = await getTermDayCombinations(term.academic_year, term.semester);
    return NextResponse.json({ ...term, combinations, restricted: combinations.some(c => c.is_active) });
  } catch (error) {
    console.error('[PUT /api/settings/day-combinations]', error);
    return NextResponse.json({ error: 'Failed to save day combinations.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const PUT = withAudit(PUT_handler);
