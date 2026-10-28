/** Carrying a terminal: grab its header and the live cell lifts and follows the
 *  pointer while the others make room. Over a screen tab it shrinks into the
 *  pointer, and dropping there moves it to that screen. Escape puts it back. */

import { gridRects } from "./layout";
import { useStore } from "./store";

export interface TermDrag {
  id: string;
  screenId: string;
  /** The order the grid shows while carrying (committed on drop). */
  order: string[];
  /** Where the pointer holds the cell, relative to its top-left. */
  grab: { x: number; y: number };
  size: { w: number; h: number };
  /** Pointer position in grid coordinates. */
  pointer: { x: number; y: number };
  /** A screen tab under the pointer (not the terminal's own). */
  overTab: string | null;
}

const THRESHOLD = 6;
let lastDragEnd = 0;

/** True right after a drag ended, so the release isn't taken for a click. */
export function justDragged(): boolean {
  return Date.now() - lastDragEnd < 250;
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function beginTermDrag(id: string, e: React.PointerEvent, cell: HTMLElement) {
  if (e.button !== 0) return;
  const grid = cell.parentElement;
  if (!grid) return;
  const start = { x: e.clientX, y: e.clientY };
  const cellBox = cell.getBoundingClientRect();
  let started = false;

  const update = (cx: number, cy: number) => {
    const d = useStore.getState().drag;
    if (!d) return;
    const g = grid.getBoundingClientRect();
    const pointer = { x: cx - g.left, y: cy - g.top };
    const under = document.elementFromPoint(cx, cy) as HTMLElement | null;
    const tab = under?.closest<HTMLElement>("[data-screen-tab]")?.dataset.screenTab ?? null;
    const overTab = tab && tab !== d.screenId ? tab : null;
    let order = d.order;
    if (!tab) {
      // Slots come from the layout, not the moving cells, so nothing oscillates.
      const rects = gridRects(order.length, Math.floor(g.width), Math.floor(g.height));
      const slot = rects.findIndex((r) => pointer.x >= r.x && pointer.x <= r.x + r.w && pointer.y >= r.y && pointer.y <= r.y + r.h);
      const from = order.indexOf(id);
      if (slot >= 0 && slot !== from) order = moveItem(order, from, slot);
    }
    useStore.setState({ drag: { ...d, pointer, overTab, order } });
  };

  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < THRESHOLD) return;
      const st = useStore.getState();
      const screen = st.screenOf(id);
      if (!screen) return finish(false);
      started = true;
      document.body.classList.add("carrying");
      useStore.setState({
        popped: null,
        drag: {
          id,
          screenId: screen.id,
          order: [...screen.terminals],
          grab: { x: start.x - cellBox.left, y: start.y - cellBox.top },
          size: { w: cellBox.width, h: cellBox.height },
          pointer: { x: 0, y: 0 },
          overTab: null,
        },
      });
    }
    update(ev.clientX, ev.clientY);
  };

  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    if (!started) return;
    lastDragEnd = Date.now();
    document.body.classList.remove("carrying");
    const st = useStore.getState();
    const d = st.drag;
    useStore.setState({ drag: null });
    if (!d || !commit) return;
    if (d.overTab) {
      const target = st.ws.screens.find((s) => s.id === d.overTab);
      if (target && st.moveTerminal(d.id, target.id)) {
        st.toast(`Moved to ${target.name}`, { label: "Go there", run: () => useStore.getState().setActiveScreen(target.id) });
      }
    } else {
      st.updateScreen(d.screenId, { terminals: d.order });
    }
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && started) {
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    }
  };

  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}
