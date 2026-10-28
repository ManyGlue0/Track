/** Where each terminal goes on a screen. Any count from 1 to 16, laid out
 *  the same way every time, whatever the window size: as many columns as the
 *  square root (rounded up), terminals spread evenly over the rows with the
 *  fuller rows on top, and every row filling the full width, so there are
 *  never holes. 16 is always 4×4, 9 is 3×3, 5 is 3 over 2, 7 is 3 / 2 / 2.
 *  A portrait window gets the same shapes turned on their side. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_TERMINALS = 16;
export const GAP = 8;

/** Terminals per row, top to bottom. */
export function rowCounts(n: number): number[] {
  if (n <= 0) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const base = Math.floor(n / rows);
  const extra = n % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

export function gridRects(n: number, width: number, height: number, gap = GAP): Rect[] {
  const counts = rowCounts(n);
  const portrait = height > width * 1.1;
  // In portrait, lay the same shape out in columns instead of rows.
  const [W, H] = portrait ? [height, width] : [width, height];
  const lines = counts.length;
  const lineH = (H - gap * (lines - 1)) / lines;
  const out: Rect[] = [];
  counts.forEach((k, r) => {
    const w = (W - gap * (k - 1)) / k;
    for (let c = 0; c < k; c++) {
      const rect = { x: c * (w + gap), y: r * (lineH + gap), w, h: lineH };
      out.push(portrait ? { x: rect.y, y: rect.x, w: rect.h, h: rect.w } : rect);
    }
  });
  return out;
}

/** The centered card a popped-out terminal springs into. */
export function popRect(width: number, height: number): Rect {
  const w = Math.round(Math.min(width - 48, Math.max(width * 0.72, Math.min(width, 720))));
  const h = Math.round(Math.min(height - 40, Math.max(height * 0.8, Math.min(height, 420))));
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

/** The neighbor of `from` in a direction, by rect centers (Alt+arrows). */
export function neighbor(rects: Rect[], from: number, dir: "left" | "right" | "up" | "down"): number {
  const a = rects[from];
  if (!a) return -1;
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  let best = -1;
  let bestD = Infinity;
  rects.forEach((b, i) => {
    if (i === from) return;
    const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const dx = bc.x - ac.x;
    const dy = bc.y - ac.y;
    const ok =
      (dir === "left" && dx < -1 && Math.abs(dy) < a.h) ||
      (dir === "right" && dx > 1 && Math.abs(dy) < a.h) ||
      (dir === "up" && dy < -1) ||
      (dir === "down" && dy > 1);
    if (!ok) return;
    const along = dir === "left" || dir === "right" ? Math.abs(dx) : Math.abs(dy);
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const d = along + across * 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}
