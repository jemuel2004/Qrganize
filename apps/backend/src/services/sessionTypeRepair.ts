import { query } from '@/database/db';

/* Once per cold start */
let done = false;

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Keeps schedule_sessions.type correct. Run before reading Lec/Lab sessions.
 *
 * 1. Legacy rows saved before `type` existed default to 'lec'. Only lab-only
 *    subjects are relabelled: the Lecture of a Lec + Lab subject may sit in a
 *    lab room, so room type alone can't say it's a Lab.
 * 2. An older version of (1) relabelled every session in a lab room, so some
 *    Lec + Lab subjects lost their Lecture (all sessions 'lab') and dropped
 *    those hours from the Workload Form. Restore the Lecture when exactly one
 *    split of the time slots matches the curriculum's Lec / Lab hours.
 */
export async function ensureSessionTypes(): Promise<void> {
  if (done) return;

  await query(`
    UPDATE schedule_sessions ss
    SET type = 'lab'
    FROM master_schedule ms
    JOIN block_subjects bs ON bs.id = ms.block_subject_id
    JOIN curriculums c ON c.id = bs.curriculum_id
    WHERE ss.master_schedule_id = ms.id
      AND ss.type = 'lec'
      AND COALESCE(c.lecture_hours, 0) = 0
      AND ss.room_id IN (SELECT id FROM rooms WHERE room_type IN ('Laboratory', 'Computer Lab'))
  `);

  const damaged = await query(`
    SELECT ms.id,
           c.lecture_hours::float    AS lec,
           c.laboratory_hours::float AS lab,
           json_agg(json_build_object('id', ss.id, 's', ss.start_time::text, 'e', ss.end_time::text)) AS sessions
    FROM master_schedule ms
    JOIN block_subjects bs ON bs.id = ms.block_subject_id
    JOIN curriculums c ON c.id = bs.curriculum_id
    JOIN schedule_sessions ss ON ss.master_schedule_id = ms.id
    WHERE COALESCE(c.lecture_hours, 0) > 0 AND COALESCE(c.laboratory_hours, 0) > 0
    GROUP BY ms.id, c.lecture_hours, c.laboratory_hours
    HAVING bool_and(ss.type = 'lab')
  `);

  for (const row of damaged.rows as { lec: number; lab: number; sessions: { id: number; s: string; e: string }[] }[]) {
    // A component meets at the same time on each of its days — group by time slot
    const slots = new Map<string, { ids: number[]; hours: number }>();
    for (const s of row.sessions) {
      const slot = slots.get(`${s.s}-${s.e}`) ?? { ids: [], hours: 0 };
      slot.ids.push(s.id);
      slot.hours += (toMinutes(s.e) - toMinutes(s.s)) / 60;
      slots.set(`${s.s}-${s.e}`, slot);
    }
    const list = [...slots.values()];
    if (list.length > 10) continue;
    const matches: number[][] = [];
    for (let mask = 1; mask < (1 << list.length) - 1; mask++) {
      let lecHours = 0;
      let labHours = 0;
      list.forEach((slot, i) => { if (mask & (1 << i)) lecHours += slot.hours; else labHours += slot.hours; });
      if (Math.abs(lecHours - row.lec) < 0.01 && Math.abs(labHours - row.lab) < 0.01) {
        matches.push(list.filter((_, i) => mask & (1 << i)).flatMap(slot => slot.ids));
      }
    }
    if (matches.length === 1) {
      await query(`UPDATE schedule_sessions SET type = 'lec' WHERE id = ANY($1::int[])`, [matches[0]]);
    }
  }

  done = true;
}
