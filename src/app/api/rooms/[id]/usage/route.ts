import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await query(`
      SELECT 1 FROM (
        SELECT room_id FROM schedule_sessions WHERE room_id = $1
        UNION ALL
        SELECT room_id FROM master_schedule   WHERE room_id = $1
      ) refs LIMIT 1
    `, [id]);
    return NextResponse.json({ in_use: result.rows.length > 0 });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
