/**
 * Room QR outputs — download one PNG, print one or many, or export all to
 * Excel. Shared by QR Generator and Reports so both produce the same output.
 */

export interface RoomQR {
  id: number;
  room_name: string;
  room_type: string;
  building: string | null;
  capacity: number | null;
  generated: boolean;
  qr_code_id: string | null;
  qr_data_url: string | null;
  qr_generated_at: string | null;
  /** The QR holds the scan link — a phone's own camera opens it */
  camera_ready?: boolean;
  /** The address the QR opens (https://<site>/room/<code>) */
  qr_link?: string | null;
}

export function downloadQR(room: RoomQR) {
  if (!room.qr_data_url) return;
  const a = document.createElement('a');
  a.href = room.qr_data_url;
  a.download = `QR_${room.room_name.replace(/[^\w-]+/g, '_')}.png`;
  a.click();
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** One printable card — shared by Print (one) and Print All */
const cardHtml = (r: RoomQR) => `
  <div class="card">
    <div class="brand">QRganize</div>
    <img src="${esc(r.qr_data_url ?? '')}" alt="QR ${esc(r.room_name)}" />
    <div class="name">${esc(r.room_name)}</div>
    <div class="meta">${esc([r.room_type, r.building].filter(Boolean).join(' · '))}</div>
    <div class="id">${esc(r.qr_code_id ?? '')}</div>
    <div class="hint">Scan to check in to this room</div>
  </div>`;

/** Open the printable QR cards. Returns false when nothing to print or the pop-up was blocked. */
export function printRooms(rooms: RoomQR[], title: string): boolean {
  const list = rooms.filter(r => r.generated && r.qr_data_url);
  if (!list.length) return false;
  const single = list.length === 1;
  const win = window.open('', '_blank', single ? 'width=520,height=640' : 'width=960,height=720');
  if (!win) return false;
  win.document.write(`<!DOCTYPE html><html><head><title>${esc(title)}</title><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #fff; padding: 24px; color: #0B2A5B; }
    h1 { text-align: center; font-size: 16px; letter-spacing: .08em; text-transform: uppercase; color: #12408F; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(${single ? 1 : 3}, 1fr); gap: 18px; ${single ? 'max-width: 340px; margin: 40px auto;' : ''} }
    .card { text-align: center; padding: 20px 16px; border: 2px solid #D6E0EF; border-radius: 14px; break-inside: avoid; }
    .brand { font-size: 11px; font-weight: 900; letter-spacing: .1em; text-transform: uppercase; color: #1D5BD6; margin-bottom: 10px; }
    img { width: ${single ? 240 : 170}px; height: ${single ? 240 : 170}px; display: block; margin: 0 auto 10px; }
    .name { font-size: ${single ? 22 : 15}px; font-weight: 900; }
    .meta { font-size: 11px; color: #475569; margin-top: 2px; }
    .id { display: inline-block; margin-top: 8px; font-family: monospace; font-size: 9px; color: #64748B; background: #F4F7FC; border: 1px solid #E2E8F0; border-radius: 4px; padding: 2px 6px; }
    .hint { font-size: 9px; color: #94A3B8; margin-top: 6px; }
    @page { margin: .5in; }
  </style></head><body>
    ${single ? '' : `<h1>${esc(title)}</h1>`}
    <div class="grid">${list.map(cardHtml).join('')}</div>
  </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); win.close(); }, 450);
  return true;
}

/** Download the generated QR codes as a formatted Excel file. Returns false when none are generated. */
export async function downloadQrExcel(rooms: RoomQR[], title = 'Room QR Codes'): Promise<boolean> {
  const list = rooms.filter(r => r.generated && r.qr_data_url);
  if (!list.length) return false;
  const { buildRoomQrWorkbook } = await import('@shared/roomQrExport');
  const buffer = await buildRoomQrWorkbook(list.map(r => ({
    room_name: r.room_name, room_type: r.room_type, building: r.building, capacity: r.capacity,
    qr_code_id: r.qr_code_id, qr_data_url: r.qr_data_url!,
  })), title);
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[^\w-]+/g, '_')}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
