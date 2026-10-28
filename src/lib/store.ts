import { useEffect } from "react";
import { create } from "zustand";
import { api, type AgentSession, type DeepPartial, type Settings, type ShellInfo, type TermInfo } from "./api";
import { MAX_TERMINALS } from "./layout";
import { isColorKey, type ColorKey } from "./palette";
import type { TermDrag } from "./drag";
import { DEFAULT_SOUND } from "./sounds";

// ---- the workspace (persisted) ---------------------------------------------------

export interface Screen {
  id: string;
  name: string;
  color: ColorKey | null;
  /** "chime" | "custom:<id>" | "none" */
  sound: string;
  volume: number;
  /** Where new terminals on this screen start. */
  cwd: string | null;
  /** Typed at the first prompt of each terminal opened here (not ones reopened with Track). */
  command: string | null;
  /** Terminal ids, in grid order. */
  terminals: string[];
}

export interface TermMeta {
  id: string;
  /** What the user called it; empty means "use the program's title". */
  name: string;
  color: ColorKey | null;
  shell: string;
  /** Last known folder: where it reopens after a restart. */
  cwd: string;
  /** Text size for this terminal only (Ctrl+scroll); null follows Settings. */
  fontSize: number | null;
  /** The AI chat that was running here, picked up again when Track reopens. */
  resume: AgentSession | null;
  /** Runs as administrator. */
  admin?: boolean;
}

export interface Workspace {
  version: 1;
  screens: Screen[];
  activeScreen: string;
  terms: Record<string, TermMeta>;
}

/** What a running terminal is up to (not persisted). */
export interface TermRuntime extends Partial<TermInfo> {
  /** "consent": an admin terminal reopened with Track, waiting for you to allow it. */
  status: "starting" | "running" | "exited" | "error" | "consent";
  error?: string;
  /** When its current shell started (ms), to tell a quick failure from a goodbye. */
  startedAt?: number;
}

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

export type SheetState = null | { mode: "new" } | { mode: "edit"; id: string };

export interface FolderRequest {
  title: string;
  initial: string | null;
  resolve: (path: string | null) => void;
}

/** Terminals opened in this session that haven't started their shell yet:
 *  only these run their screen's command (reopened ones come back plain). */
export const freshTerms = new Set<string>();

const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function freshScreen(name: string, patch: Partial<Screen> = {}): Screen {
  return { id: uid("s"), name, color: null, sound: DEFAULT_SOUND, volume: 0.8, cwd: null, command: null, terminals: [], ...patch };
}

function defaultWorkspace(): Workspace {
  const screen = freshScreen("Main");
  const t: TermMeta = { id: uid("t"), name: "", color: null, shell: "", cwd: "", fontSize: null, resume: null };
  screen.terminals.push(t.id);
  return { version: 1, screens: [screen], activeScreen: screen.id, terms: { [t.id]: t } };
}

/** Loads whatever is on disk defensively: a bad field never loses the rest. */
function sanitize(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Workspace>;
  const terms: Record<string, TermMeta> = {};
  for (const [id, t] of Object.entries(r.terms ?? {})) {
    if (!t || typeof t !== "object") continue;
    terms[id] = {
      id,
      name: typeof t.name === "string" ? t.name : "",
      color: isColorKey(t.color) ? t.color : null,
      shell: typeof t.shell === "string" ? t.shell : "",
      cwd: typeof t.cwd === "string" ? t.cwd : "",
      fontSize: typeof t.fontSize === "number" ? Math.max(8, Math.min(32, t.fontSize)) : null,
      resume:
        t.resume && typeof t.resume === "object" && typeof t.resume.id === "string" && (t.resume.tool === "claude" || t.resume.tool === "codex")
          ? { tool: t.resume.tool, id: t.resume.id }
          : null,
      ...(t.admin === true ? { admin: true } : {}),
    };
  }
  const seen = new Set<string>();
  const screens: Screen[] = (Array.isArray(r.screens) ? r.screens : [])
    .filter((s) => s && typeof s.id === "string")
    .map((s) => ({
      id: s.id,
      name: typeof s.name === "string" && s.name.trim() ? s.name : "Screen",
      color: isColorKey(s.color) ? s.color : null,
      sound: typeof s.sound === "string" ? s.sound : DEFAULT_SOUND,
      volume: typeof s.volume === "number" ? Math.max(0, Math.min(1, s.volume)) : 0.8,
      cwd: typeof s.cwd === "string" && s.cwd ? s.cwd : null,
      command: typeof s.command === "string" && s.command.trim() ? s.command : null,
      terminals: (Array.isArray(s.terminals) ? s.terminals : [])
        .filter((t) => terms[t] && !seen.has(t) && seen.add(t))
        .slice(0, MAX_TERMINALS),
    }));
  if (!screens.length) return null;
  for (const id of Object.keys(terms)) if (!seen.has(id)) delete terms[id];
  const active = screens.some((s) => s.id === r.activeScreen) ? r.activeScreen! : screens[0].id;
  return { version: 1, screens, activeScreen: active, terms };
}

// ---- the store --------------------------------------------------------------------------

interface Store {
  settings: Settings | null;
  systemDark: boolean;
  shells: ShellInfo[];
  ws: Workspace;
  loaded: boolean;
  runtime: Record<string, TermRuntime>;
  focused: string | null;
  popped: string | null;
  renaming: string | null;
  finding: string | null;
  sheet: SheetState;
  settingsOpen: boolean;
  folderRequest: FolderRequest | null;
  toasts: Toast[];
  windowActive: boolean;
  maximized: boolean;
  /** A terminal being carried to a new place (see drag.ts). */
  drag: TermDrag | null;
  /** A terminal asking "End node?" in its header before closing. */
  closing: { id: string; what: string } | null;
  /** The terminal under files being dragged in from Explorer. */
  fileOver: string | null;

  init: () => Promise<void>;
  loadSettings: () => Promise<void>;
  updateSettings: (patch: DeepPartial<Settings>) => Promise<void>;
  refreshShells: () => Promise<void>;

  activeScreen: () => Screen;
  screenOf: (termId: string) => Screen | undefined;
  setActiveScreen: (id: string) => void;
  addScreen: (patch?: Partial<Screen>, withTerminal?: boolean) => string;
  updateScreen: (id: string, patch: Partial<Screen>) => void;
  closeScreen: (id: string) => void;
  reorderScreens: (from: number, to: number) => void;

  addTerminal: (opts?: { screenId?: string; shell?: string; cwd?: string | null; color?: TermMeta["color"]; after?: string; admin?: boolean }) => string | null;
  /** A new terminal beside this one: same shell, same folder, same color. */
  duplicateTerminal: (id: string) => string | null;
  closeTerminal: (id: string) => void;
  updateTerm: (id: string, patch: Partial<TermMeta>) => void;
  moveTerminal: (id: string, screenId: string) => boolean;
  swapTerminals: (a: string, b: string) => void;

  setRuntime: (id: string, patch: Partial<TermRuntime>) => void;
  applyInfo: (info: TermInfo) => void;
  setFocused: (id: string | null) => void;
  setPopped: (id: string | null) => void;

  openFolderPicker: (title: string, initial: string | null) => Promise<string | null>;
  toast: (text: string, action?: Toast["action"]) => void;
  dismissToast: (id: number) => void;
}

let toastId = 0;
/** The terminal last focused on each screen, so coming back lands there. */
const lastFocus = new Map<string, string>();
let arriveTimer = 0;

export const useStore = create<Store>((set, get) => ({
  settings: null,
  systemDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  shells: [],
  ws: defaultWorkspace(),
  loaded: false,
  runtime: {},
  focused: null,
  popped: null,
  renaming: null,
  finding: null,
  sheet: null,
  settingsOpen: false,
  folderRequest: null,
  toasts: [],
  windowActive: document.hasFocus(),
  maximized: false,
  drag: null,
  closing: null,
  fileOver: null,

  init: async () => {
    const [settings, raw] = await Promise.all([api.getSettings(), api.loadWorkspace()]);
    const ws = sanitize(raw) ?? defaultWorkspace();
    const first = ws.screens.find((s) => s.id === ws.activeScreen)?.terminals[0] ?? null;
    set({ settings, ws, loaded: true, focused: first });
    await get().refreshShells();
    // WSL distros are detected in the background; pick them up a bit later.
    setTimeout(() => get().refreshShells(), 3500);
  },
  loadSettings: async () => set({ settings: await api.getSettings() }),
  updateSettings: async (patch) => {
    const prev = get().settings;
    // Optimistic: controls move at once; the backend's answer is the truth.
    if (prev) set({ settings: { ...prev, ...(patch as Partial<Settings>) } as Settings });
    try {
      set({ settings: await api.updateSettings(patch) });
    } catch (e) {
      get().toast(String(e));
      await get().loadSettings();
    }
  },
  refreshShells: async () => set({ shells: await api.listShells() }),

  activeScreen: () => {
    const { ws } = get();
    return ws.screens.find((s) => s.id === ws.activeScreen) ?? ws.screens[0];
  },
  screenOf: (termId) => get().ws.screens.find((s) => s.terminals.includes(termId)),
  setActiveScreen: (id) => {
    const { ws } = get();
    if (ws.activeScreen === id || !ws.screens.some((s) => s.id === id)) return;
    const target = ws.screens.find((s) => s.id === id)!;
    const cur = get().focused;
    if (cur) lastFocus.set(ws.activeScreen, cur);
    // Land where you're needed: the terminal that most recently asked for you,
    // else the one you left here.
    const rt = get().runtime;
    const calling = target.terminals
      .filter((t) => rt[t]?.attention)
      .sort((a, b) => (rt[b]!.attention!.at ?? 0) - (rt[a]!.attention!.at ?? 0))[0];
    const remembered = lastFocus.get(id);
    const focused = calling ?? (remembered && target.terminals.includes(remembered) ? remembered : (target.terminals[0] ?? null));
    set({ ws: { ...ws, activeScreen: id }, popped: null, finding: null, focused });
    // Acknowledge after a beat, so you see which one called before its ring fades.
    clearTimeout(arriveTimer);
    arriveTimer = window.setTimeout(() => void api.ptyFocus(get().focused), calling ? 1400 : 0);
  },
  addScreen: (patch = {}, withTerminal = true) => {
    const { ws, settings } = get();
    const used = new Set(ws.screens.map((s) => s.name));
    let n = ws.screens.length + 1;
    while (used.has(`Screen ${n}`)) n++;
    const screen = freshScreen(patch.name?.trim() || `Screen ${n}`, patch);
    const terms = { ...ws.terms };
    if (withTerminal) {
      const t: TermMeta = { id: uid("t"), name: "", color: null, shell: settings?.defaultShell ?? "", cwd: screen.cwd ?? "", fontSize: null, resume: null };
      terms[t.id] = t;
      freshTerms.add(t.id);
      screen.terminals = [t.id];
    }
    set({ ws: { ...ws, screens: [...ws.screens, screen], activeScreen: screen.id, terms }, popped: null, focused: screen.terminals[0] ?? null });
    return screen.id;
  },
  updateScreen: (id, patch) => {
    const { ws } = get();
    set({ ws: { ...ws, screens: ws.screens.map((s) => (s.id === id ? { ...s, ...patch } : s)) } });
  },
  closeScreen: (id) => {
    const { ws } = get();
    const idx = ws.screens.findIndex((s) => s.id === id);
    if (idx < 0) return;
    for (const t of ws.screens[idx].terminals) endTerminal(t);
    const terms = { ...ws.terms };
    for (const t of ws.screens[idx].terminals) delete terms[t];
    let screens = ws.screens.filter((s) => s.id !== id);
    let active = ws.activeScreen;
    if (!screens.length) {
      const fresh = defaultWorkspace();
      screens = fresh.screens;
      Object.assign(terms, fresh.terms);
      active = screens[0].id;
    } else if (active === id) {
      active = screens[Math.min(idx, screens.length - 1)].id;
    }
    const runtime = { ...get().runtime };
    for (const t of ws.screens[idx].terminals) delete runtime[t];
    set({ ws: { ...ws, screens, activeScreen: active, terms }, runtime, popped: null });
  },
  reorderScreens: (from, to) => {
    const { ws } = get();
    const screens = [...ws.screens];
    const [moved] = screens.splice(from, 1);
    screens.splice(to, 0, moved);
    set({ ws: { ...ws, screens } });
  },

  addTerminal: (opts = {}) => {
    const { ws, settings } = get();
    const screen = ws.screens.find((s) => s.id === (opts.screenId ?? ws.activeScreen));
    if (!screen) return null;
    if (screen.terminals.length >= MAX_TERMINALS) {
      get().toast(`A screen holds up to ${MAX_TERMINALS} terminals. Start a new screen for more.`);
      return null;
    }
    const t: TermMeta = {
      id: uid("t"),
      name: "",
      color: opts.color ?? null,
      shell: opts.shell ?? settings?.defaultShell ?? "",
      cwd: opts.cwd ?? screen.cwd ?? "",
      fontSize: null,
      resume: null,
      ...(opts.admin ? { admin: true } : {}),
    };
    freshTerms.add(t.id);
    const at = opts.after ? screen.terminals.indexOf(opts.after) + 1 : 0;
    const terminals = at > 0 ? [...screen.terminals.slice(0, at), t.id, ...screen.terminals.slice(at)] : [...screen.terminals, t.id];
    set({
      ws: {
        ...ws,
        terms: { ...ws.terms, [t.id]: t },
        screens: ws.screens.map((s) => (s.id === screen.id ? { ...s, terminals } : s)),
      },
      focused: t.id,
      popped: null,
    });
    return t.id;
  },
  duplicateTerminal: (id) => {
    const { ws, runtime } = get();
    const meta = ws.terms[id];
    const screen = ws.screens.find((s) => s.terminals.includes(id));
    if (!meta || !screen) return null;
    return get().addTerminal({
      screenId: screen.id,
      shell: meta.shell,
      cwd: runtime[id]?.cwd || meta.cwd || null,
      color: meta.color,
      after: id,
      admin: meta.admin,
    });
  },
  closeTerminal: (id) => {
    const { ws, focused, popped } = get();
    const screen = get().screenOf(id);
    endTerminal(id);
    const terms = { ...ws.terms };
    delete terms[id];
    const runtime = { ...get().runtime };
    delete runtime[id];
    let nextFocus = focused;
    if (focused === id && screen) {
      const i = screen.terminals.indexOf(id);
      const rest = screen.terminals.filter((t) => t !== id);
      nextFocus = rest[Math.min(i, rest.length - 1)] ?? null;
    }
    set({
      ws: { ...ws, terms, screens: ws.screens.map((s) => ({ ...s, terminals: s.terminals.filter((t) => t !== id) })) },
      runtime,
      focused: nextFocus,
      popped: popped === id ? null : popped,
      renaming: get().renaming === id ? null : get().renaming,
      closing: get().closing?.id === id ? null : get().closing,
      finding: get().finding === id ? null : get().finding,
    });
    if (nextFocus) requestAnimationFrame(() => focusTerminal(nextFocus!));
  },
  updateTerm: (id, patch) => {
    const { ws } = get();
    if (!ws.terms[id]) return;
    set({ ws: { ...ws, terms: { ...ws.terms, [id]: { ...ws.terms[id], ...patch } } } });
  },
  moveTerminal: (id, screenId) => {
    const { ws } = get();
    const from = get().screenOf(id);
    const to = ws.screens.find((s) => s.id === screenId);
    if (!from || !to || from.id === to.id) return false;
    if (to.terminals.length >= MAX_TERMINALS) {
      get().toast(`${to.name} already holds ${MAX_TERMINALS} terminals`);
      return false;
    }
    set({
      ws: {
        ...ws,
        screens: ws.screens.map((s) =>
          s.id === from.id
            ? { ...s, terminals: s.terminals.filter((t) => t !== id) }
            : s.id === to.id
              ? { ...s, terminals: [...s.terminals, id] }
              : s,
        ),
      },
      popped: get().popped === id ? null : get().popped,
    });
    return true;
  },
  swapTerminals: (a, b) => {
    const { ws } = get();
    set({
      ws: {
        ...ws,
        screens: ws.screens.map((s) => {
          const ia = s.terminals.indexOf(a);
          const ib = s.terminals.indexOf(b);
          if (ia < 0 || ib < 0) return s;
          const terminals = [...s.terminals];
          [terminals[ia], terminals[ib]] = [terminals[ib], terminals[ia]];
          return { ...s, terminals };
        }),
      },
    });
  },

  setRuntime: (id, patch) =>
    set((s) => ({ runtime: { ...s.runtime, [id]: { ...(s.runtime[id] ?? { status: "starting" }), ...patch } } })),
  applyInfo: (info) => {
    const { runtime, ws } = get();
    if (!ws.terms[info.id]) return;
    const prev = runtime[info.id];
    const status = info.exitCode !== null ? "exited" : "running";
    set({ runtime: { ...runtime, [info.id]: { ...prev, ...info, status } } });
    // Remember the folder so a restart reopens there.
    if (info.cwd && ws.terms[info.id].cwd !== info.cwd) get().updateTerm(info.id, { cwd: info.cwd });
  },
  setFocused: (id) => {
    if (get().focused === id) return;
    set({ focused: id });
    void api.ptyFocus(id);
  },
  setPopped: (id) => set({ popped: id }),

  openFolderPicker: (title, initial) =>
    new Promise((resolve) => {
      get().folderRequest?.resolve(null);
      set({
        folderRequest: {
          title,
          initial,
          resolve: (path) => {
            set({ folderRequest: null });
            resolve(path);
          },
        },
      });
    }),
  toast: (text, action) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, action }] }));
    setTimeout(() => get().dismissToast(id), action ? 6000 : 3600);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// The terminal registry is loaded lazily to keep xterm out of this module's
// import graph (and its init order).
let terms: typeof import("./terms") | null = null;
import("./terms").then((m) => (terms = m));

function endTerminal(id: string) {
  void api.ptyKill(id);
  terms?.dispose(id);
}

export function focusTerminal(id: string) {
  terms?.focus(id);
}

// ---- persistence ------------------------------------------------------------------------

let saveTimer = 0;
useStore.subscribe((state, prev) => {
  if (!state.loaded || state.ws === prev.ws) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    api.saveWorkspace(useStore.getState().ws).catch((e) => console.error("save workspace", e));
  }, 400);
});

// ---- hooks --------------------------------------------------------------------------------

export function useDark(): boolean {
  const theme = useStore((s) => s.settings?.theme ?? "system");
  const systemDark = useStore((s) => s.systemDark);
  return theme === "dark" || (theme === "system" && systemDark);
}

/** Escape handling, innermost overlay first. Handlers register while open. */
const escapeStack: (() => void)[] = [];

export function useEscape(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    escapeStack.push(onEscape);
    return () => {
      const i = escapeStack.lastIndexOf(onEscape);
      if (i >= 0) escapeStack.splice(i, 1);
    };
  }, [active, onEscape]);
}

export function handleEscape(): boolean {
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return false;
  top();
  return true;
}

/** Display name: the user's, else the program's title, else the shell's. */
export function termName(meta: TermMeta | undefined, rt: TermRuntime | undefined, shells: ShellInfo[]): string {
  if (meta?.name.trim()) return meta.name.trim();
  const title = cleanTitle(rt?.title ?? "");
  if (title) return title;
  return rt?.shellName || shells.find((s) => s.id === meta?.shell)?.name || shells[0]?.name || "Terminal";
}

/** Shell titles are often just the exe path; keep what's meaningful. */
function cleanTitle(t: string): string {
  const s = t.trim();
  if (!s) return "";
  if (/^[A-Za-z]:\\.*\.exe$/i.test(s)) return "";
  if (/^(Administrator: )?(Windows PowerShell|PowerShell|Command Prompt)$/i.test(s)) return "";
  return s.replace(/^[✳✻✽✶✢·*]\s*/, "");
}

/** `E:\GitProjects\Holster` → `~\…\Holster` style short form for headers. */
export function shortPath(p: string, home?: string): string {
  if (!p) return "";
  let s = p;
  if (home && s.toLowerCase().startsWith(home.toLowerCase())) s = "~" + s.slice(home.length);
  const parts = s.split("\\").filter(Boolean);
  if (parts.length <= 3) return s;
  return `${parts[0]}\\…\\${parts.slice(-2).join("\\")}`;
}
