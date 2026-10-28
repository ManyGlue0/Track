import { api } from "./api";
import { MAX_TERMINALS, neighbor, type Rect } from "./layout";
import type { ActionId } from "./shortcuts";
import { useStore } from "./store";
import * as terms from "./terms";

/** Closes a terminal, asking first (inline, in its header) when a program is
 *  still running in it. */
export async function requestClose(id: string) {
  const st = useStore.getState();
  if (st.runtime[id]?.status === "running") {
    const busy = await api.ptyBusy(id).catch(() => null);
    if (busy) {
      useStore.setState({ closing: { id, what: busy } });
      return;
    }
  }
  useStore.getState().closeTerminal(id);
}

export function focusTerm(id: string) {
  const st = useStore.getState();
  st.setFocused(id);
  if (st.settings?.focusMode === "popout") st.setPopped(id);
  requestAnimationFrame(() => terms.focus(id));
}

function moveFocus(dir: "left" | "right" | "up" | "down") {
  const st = useStore.getState();
  const screen = st.activeScreen();
  if (!screen.terminals.length) return;
  const current = st.focused && screen.terminals.includes(st.focused) ? st.focused : null;
  if (!current) return focusTerm(screen.terminals[0]);
  // Read the cells' real positions: the grid is the source of truth.
  const rects: Rect[] = screen.terminals.map((id) => {
    const el = document.querySelector<HTMLElement>(`.cell[data-id="${id}"]`);
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 0, y: 0, w: 0, h: 0 };
  });
  // A popped-out terminal floats; navigate as if it were back in its cell.
  if (st.popped) {
    useStore.setState({ popped: null });
  }
  const i = neighbor(rects, screen.terminals.indexOf(current), dir);
  if (i >= 0) focusTerm(screen.terminals[i]);
}

function cycleScreen(step: number) {
  const st = useStore.getState();
  const screens = st.ws.screens;
  const i = screens.findIndex((s) => s.id === st.ws.activeScreen);
  const next = screens[(i + step + screens.length) % screens.length];
  st.setActiveScreen(next.id);
}

export function goToScreen(n: number) {
  const st = useStore.getState();
  const screens = st.ws.screens;
  const target = n === 9 ? screens[screens.length - 1] : screens[n - 1];
  if (target) st.setActiveScreen(target.id);
}

export function runAction(action: ActionId) {
  const st = useStore.getState();
  const f = st.focused;
  const fontSize = st.settings?.fontSize ?? 13;
  switch (action) {
    case "newTerminal":
      st.addTerminal();
      break;
    case "duplicateTerminal":
      if (f) st.duplicateTerminal(f);
      break;
    case "closeTerminal":
      if (f) void requestClose(f);
      break;
    case "newScreen":
      st.addScreen();
      break;
    case "editScreen":
      useStore.setState({ sheet: { mode: "edit", id: st.ws.activeScreen } });
      break;
    case "nextScreen":
      cycleScreen(1);
      break;
    case "prevScreen":
      cycleScreen(-1);
      break;
    case "focusLeft":
      moveFocus("left");
      break;
    case "focusRight":
      moveFocus("right");
      break;
    case "focusUp":
      moveFocus("up");
      break;
    case "focusDown":
      moveFocus("down");
      break;
    case "popOut":
      if (f) st.setPopped(st.popped === f ? null : f);
      break;
    case "find":
      if (f) useStore.setState({ finding: f });
      break;
    case "rename":
      if (f) useStore.setState({ renaming: f });
      break;
    case "copy":
      if (f) void terms.copySelection(f);
      break;
    case "paste":
      if (f) void terms.paste(f);
      break;
    case "fontUp":
      void st.updateSettings({ fontSize: Math.min(24, fontSize + 1) });
      break;
    case "fontDown":
      void st.updateSettings({ fontSize: Math.max(9, fontSize - 1) });
      break;
    case "fontReset":
      void st.updateSettings({ fontSize: 13 });
      break;
    case "settings":
      useStore.setState({ settingsOpen: true });
      break;
  }
}

/** "Open in Track" from Explorer (or `track <folder>`): a new terminal in the
 *  screen whose folder holds this one, else the current screen, else (when
 *  that's full) a new screen named after the folder. */
export function openFolders(paths: string[]) {
  for (const path of paths) {
    const st = useStore.getState();
    const p = path.toLowerCase();
    const owner = st.ws.screens
      .filter((s) => {
        if (!s.cwd) return false;
        const c = s.cwd.toLowerCase().replace(/\\+$/, "");
        return p === c || p.startsWith(c + "\\");
      })
      .sort((a, b) => (b.cwd?.length ?? 0) - (a.cwd?.length ?? 0))[0];
    let target = owner ?? st.activeScreen();
    if (target.terminals.length >= MAX_TERMINALS) {
      const name = path.split("\\").filter(Boolean).pop() ?? "Folder";
      const id = st.addScreen({ name, cwd: path }, false);
      target = useStore.getState().ws.screens.find((s) => s.id === id)!;
    }
    st.setActiveScreen(target.id);
    useStore.getState().addTerminal({ screenId: target.id, cwd: path });
  }
  if (paths[0]) void api.noteRecent(paths[0]).then((settings) => useStore.setState({ settings }));
}
