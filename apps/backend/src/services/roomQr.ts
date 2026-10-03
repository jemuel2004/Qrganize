import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { query } from '@/database/db';

/*
 * Room QR codes — one place that creates them.
 * A room's QR carries its unique qr_code_id (what the scanner looks up);
 * the rendered PNG is stored in qr_code_data. A room without a stored PNG is
 * "Not Generated" and cannot be scanned until the admin generates it.
 */

let columnReady = false;
/** qr_generated_at — when the current QR was issued (DDL once per cold start) */
export async function ensureRoomQrColumn() {
  if (columnReady) return;
  await query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ');
  columnReady = true;
}

export const hasQr = (qrCodeData: unknown) => typeof qrCodeData === 'string' && qrCodeData.startsWith('data:image/');

type Queryable = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Issue a fresh QR for a room (new id → any old printed copy stops working).
 * Pass `q` to write through an open transaction (e.g. a room it just created).
 */
export async function generateRoomQr(room: { id: number; room_name: string; room_type: string }, q: Queryable = query) {
  if (q === query) await ensureRoomQrColumn(); // a transaction caller has the column already
  const qrCodeId = `QR-${room.room_type.slice(0, 3).toUpperCase()}-${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const qrDataUrl = await QRCode.toDataURL(JSON.stringify({ type: 'room', code: qrCodeId, room: room.room_name }), {
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel: 'H',
  });
  const res = await q(
    `UPDATE rooms SET qr_code_id = $1, qr_code_data = $2, qr_generated_at = NOW() WHERE id = $3
     RETURNING qr_generated_at`,
    [qrCodeId, qrDataUrl, room.id],
  );
  return { qr_code_id: qrCodeId, qr_data_url: qrDataUrl, qr_generated_at: res.rows[0]?.qr_generated_at ?? null };
}
