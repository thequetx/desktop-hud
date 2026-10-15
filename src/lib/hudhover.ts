/**
 * Hover fade (2026-10-02) — the renderer half. The main process polls the
 * cursor and sends each corner window the point inside it, or null
 * (electron/hudhover.cjs explains why it isn't forwarded mouse events). This
 * decides which bubble that point is over.
 */

export type HoverPoint = { x: number; y: number };
export type BubbleRect = { id: string; left: number; top: number; right: number; bottom: number };

/** The bubble under `point`, or null when it's over none (between bubbles, in
 *  the window's spare width beside a Fit bubble, or outside the window). */
export function hoveredBubble(point: HoverPoint | null, rects: BubbleRect[]): string | null {
  if (!point) return null;
  const hit = rects.find((r) => point.x >= r.left && point.x < r.right && point.y >= r.top && point.y < r.bottom);
  return hit ? hit.id : null;
}

/** The bubble rects of one stack, read from the DOM (`data-bub` on each). */
export function bubbleRects(root: ParentNode): BubbleRect[] {
  return [...root.querySelectorAll<HTMLElement>('[data-bub]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.bub ?? '', left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
}
