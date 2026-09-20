/**
 * Draw a bitmap with stepwise downscale so large sources stay sharp at small sizes
 * (Chrome/Windows otherwise smear a 1024px image into a 48px box).
 */
export function drawImageSmooth(
  dest: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  dest.imageSmoothingEnabled = true;
  dest.imageSmoothingQuality = 'high';

  if (sw <= dw * 1.5 && sh <= dh * 1.5) {
    dest.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    return;
  }

  let cur = document.createElement('canvas');
  cur.width = Math.max(1, Math.round(sw));
  cur.height = Math.max(1, Math.round(sh));
  const first = cur.getContext('2d');
  if (!first) {
    dest.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    return;
  }
  first.imageSmoothingEnabled = true;
  first.imageSmoothingQuality = 'high';
  first.drawImage(source, sx, sy, sw, sh, 0, 0, cur.width, cur.height);

  let cw = cur.width;
  let ch = cur.height;

  while (cw / 2 >= dw && ch / 2 >= dh) {
    const nw = Math.max(1, Math.round(cw / 2));
    const nh = Math.max(1, Math.round(ch / 2));
    const next = document.createElement('canvas');
    next.width = nw;
    next.height = nh;
    const ctx = next.getContext('2d');
    if (!ctx) break;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    cur = next;
    cw = nw;
    ch = nh;
  }

  dest.drawImage(cur, 0, 0, cw, ch, dx, dy, dw, dh);
}
