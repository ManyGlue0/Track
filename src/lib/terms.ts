/** Live terminals. Each xterm instance lives here, outside React, for as long
 *  as its terminal exists: switching screens or moving a terminal only moves
 *  its element between cells, so nothing is redrawn from scratch and nothing
 *  is lost. With GPU rendering on, only terminals on screen hold a WebGL
 *  context (browsers cap them). */

import { Channel } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { api, type Settings } from "./api";
import { freshTerms, useStore } from "./store";
import { fontStack, terminalTheme } from "./themes";

interface Entry {
  id: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  webgl: WebglAddon | null;
  /** WebGL failed for this terminal; stay on the DOM renderer. */
  noWebgl: boolean;
  opened: boolean;
  started: boolean;
  resizeTimer: number;
  ptySize: { cols: number; rows: number };
}

const entries = new Map<string, Entry>();

function isDark(): boolean {
  const s = useStore.getState();
  const theme = s.settings?.theme ?? "system";
  return theme === "dark" || (theme === "system" && s.systemDark);
}

function options(s: Settings | null): ITerminalOptions {
  return {
    allowProposedApi: true,
    allowTransparency: true,
    fontFamily: fontStack(s?.fontFamily),
    fontSize: s?.fontSize ?? 13,
    lineHeight: s?.lineHeight ?? 1.2,
    cursorStyle: s?.cursorStyle ?? "bar",
    cursorBlink: s?.cursorBlink ?? true,
    cursorInactiveStyle: "outline",
    cursorWidth: 2,
    scrollback: s?.scrollback ?? 10000,
    theme: terminalTheme(isDark()),
    windowsPty: { backend: "conpty", buildNumber: 26100 },
    // Pastel backgrounds (pwsh paints folders on ANSI blue) would wash out
    // white text: xterm darkens or lightens text only where it'd be unreadable.
    minimumContrastRatio: 3,
    rescaleOverlappingGlyphs: true,
    customGlyphs: true,
    smoothScrollDuration: 0,
    fastScrollSensitivity: 5,
    rightClickSelectsWord: false,
    altClickMovesCursor: true,
    scrollOnUserInput: true,
  };
}

export function get(id: string): Terminal | undefined {
  return entries.get(id)?.term;
}

/** This terminal's text size: its own (Ctrl+scroll) or the one in Settings. */
function sizeFor(id: string): number {
  const st = useStore.getState();
  return st.ws.terms[id]?.fontSize ?? st.settings?.fontSize ?? 13;
}

function ensure(id: string): Entry {
  const existing = entries.get(id);
  if (existing) return existing;
  const term = new Terminal({ ...options(useStore.getState().settings), fontSize: sizeFor(id) });
  const fit = new FitAddon();
  const search = new SearchAddon({ highlightLimit: 2000 });
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      // Like an editor: Ctrl+click opens, a plain click stays a click.
      if (event.ctrlKey) void openUrl(uri);
    }),
  );
  const host = document.createElement("div");
  host.className = "xterm-host";
  const entry: Entry = {
    id,
    term,
    fit,
    search,
    host,
    webgl: null,
    noWebgl: false,
    opened: false,
    started: false,
    resizeTimer: 0,
    ptySize: { cols: 0, rows: 0 },
  };
  term.onData((data) => void api.ptyWrite(id, data));
  term.onResize(({ cols, rows }) => schedulePtyResize(entry, cols, rows));
  term.onSelectionChange(() => {
    if (useStore.getState().settings?.copyOnSelect && term.hasSelection()) void writeText(term.getSelection());
  });
  entries.set(id, entry);
  return entry;
}

function schedulePtyResize(e: Entry, cols: number, rows: number) {
  clearTimeout(e.resizeTimer);
  e.resizeTimer = window.setTimeout(() => {
    if (!e.started || (e.ptySize.cols === cols && e.ptySize.rows === rows)) return;
    e.ptySize = { cols, rows };
    void api.ptyResize(e.id, cols, rows);
  }, 60);
}

function enableWebgl(e: Entry) {
  // The DOM renderer draws text at its true weight over the frosted cell; GPU
  // rendering is opt-in for very busy terminals.
  if (!useStore.getState().settings?.gpuRendering) return;
  if (e.webgl || e.noWebgl || !e.opened) return;
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => {
      gl.dispose();
      if (e.webgl === gl) e.webgl = null;
    });
    e.term.loadAddon(gl);
    e.webgl = gl;
  } catch {
    e.noWebgl = true;
  }
}

function disableWebgl(e: Entry) {
  if (!e.webgl) return;
  const gl = e.webgl;
  e.webgl = null;
  try {
    gl.dispose();
  } catch {
    /* already gone with its context */
  }
}

/** Shows terminal `id` inside `slot` (its cell), starting its shell the first time. */
export function attach(id: string, slot: HTMLElement) {
  const e = ensure(id);
  if (e.host.parentElement !== slot) slot.appendChild(e.host);
  if (!e.opened) {
    e.term.open(e.host);
    e.opened = true;
    e.term.textarea?.addEventListener("focus", () => useStore.getState().setFocused(id));
  }
  enableWebgl(e);
  requestAnimationFrame(() => {
    fitNow(id);
    if (!e.started) void start(e);
    e.term.refresh(0, e.term.rows - 1);
    // The focused terminal (a new one, or the one you left on this screen)
    // gets the keyboard as soon as it's on screen.
    const st = useStore.getState();
    if (st.focused === id && !st.sheet && !st.settingsOpen && !st.folderRequest) e.term.focus();
  });
}

/** The cell went away (another screen, or the terminal is moving). */
export function detach(id: string) {
  const e = entries.get(id);
  if (e) disableWebgl(e);
}

export function fitNow(id: string) {
  const e = entries.get(id);
  if (!e || !e.opened || !e.host.isConnected) return;
  const dims = e.fit.proposeDimensions();
  if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
  const cols = Math.max(10, dims.cols);
  const rows = Math.max(2, dims.rows);
  if (cols !== e.term.cols || rows !== e.term.rows) e.term.resize(cols, rows);
}

/** `consent`: you asked for this shell just now (a Restart, "Start as
 *  administrator"), so an admin terminal may show the UAC prompt. */
async function start(e: Entry, consent = false) {
  e.started = true;
  const st = useStore.getState();
  const meta = st.ws.terms[e.id];
  if (!meta) return;
  const screen = st.screenOf(e.id);
  st.setRuntime(e.id, { status: "starting", error: undefined, exitCode: null, attention: null, startedAt: Date.now() });
  const channel = new Channel<ArrayBuffer | number[] | string>();
  channel.onmessage = (data) => {
    if (data instanceof ArrayBuffer) e.term.write(new Uint8Array(data));
    else if (Array.isArray(data)) e.term.write(Uint8Array.from(data));
    else if (typeof data === "string") e.term.write(data);
  };
  e.ptySize = { cols: e.term.cols, rows: e.term.rows };
  // A chat that was open here when Track closed is picked up again. A newly
  // opened terminal runs its screen's command, if it has one.
  const fresh = freshTerms.delete(e.id);
  const s = st.settings;
  const resume = s?.resumeChats ? meta.resume : null;
  const template = resume ? (resume.tool === "claude" ? s?.claudeResume : s?.codexResume) : null;
  const resumeLine = resume && template?.includes("{id}") ? template.replaceAll("{id}", resume.id) : null;
  const startup = resumeLine ?? (fresh ? screen?.command?.trim() || null : null);
  try {
    const res = await api.ptySpawn(
      {
        id: e.id,
        shell: meta.shell,
        cwd: meta.cwd || screen?.cwd || null,
        cols: e.term.cols,
        rows: e.term.rows,
        startup,
        resume: resumeLine ? resume : null,
        admin: !!meta.admin,
        ask: fresh || consent,
      },
      channel as Channel<ArrayBuffer>,
    );
    useStore.getState().applyInfo(res.info);
    if (!meta.shell && res.info.shell) useStore.getState().updateTerm(e.id, { shell: res.info.shell });
  } catch (err) {
    e.started = false;
    if (String(err) === "admin-consent") useStore.getState().setRuntime(e.id, { status: "consent" });
    else useStore.getState().setRuntime(e.id, { status: "error", error: String(err) });
  }
}

/** Starts a fresh shell in a terminal whose process ended (or failed to start). */
export function restart(id: string) {
  const e = entries.get(id);
  if (!e) return;
  e.term.reset();
  e.started = false;
  void start(e, true);
  e.term.focus();
}

export function dispose(id: string) {
  const e = entries.get(id);
  if (!e) return;
  clearTimeout(e.resizeTimer);
  disableWebgl(e);
  e.term.dispose();
  e.host.remove();
  entries.delete(id);
}

export function focus(id: string) {
  const e = entries.get(id);
  if (e?.opened) e.term.focus();
}

export function blurAll() {
  for (const e of entries.values()) e.term.blur();
}

/** Applies font, cursor and theme changes to every terminal. */
export function applySettings() {
  const o = options(useStore.getState().settings);
  for (const e of entries.values()) {
    const t = e.term;
    if (t.options.fontFamily !== o.fontFamily) t.options.fontFamily = o.fontFamily;
    t.options.fontSize = sizeFor(e.id);
    t.options.lineHeight = o.lineHeight;
    t.options.cursorStyle = o.cursorStyle;
    t.options.cursorBlink = o.cursorBlink;
    t.options.scrollback = o.scrollback;
    t.options.theme = o.theme;
    if (useStore.getState().settings?.gpuRendering) {
      if (e.host.isConnected) enableWebgl(e);
    } else disableWebgl(e);
    fitNow(e.id);
  }
}

// ---- clipboard ---------------------------------------------------------------------------

/** The program in the terminal reads the mouse itself (Claude Code's
 *  fullscreen mode, vim, htop…): clicks are reported to it, not Track's. */
export function mouseTracking(id: string): boolean {
  const mode = entries.get(id)?.term.modes.mouseTrackingMode;
  return !!mode && mode !== "none";
}

export function hasSelection(id: string): boolean {
  return !!entries.get(id)?.term.hasSelection();
}

export async function copySelection(id: string): Promise<boolean> {
  const t = entries.get(id)?.term;
  if (!t?.hasSelection()) return false;
  await writeText(t.getSelection());
  t.clearSelection();
  return true;
}

export async function paste(id: string) {
  const t = entries.get(id)?.term;
  if (!t) return;
  const text = await readText().catch(() => "");
  if (text) t.paste(text);
  t.focus();
}

/** Types text as if pasted (bracketed when the program asked for it). */
export function pasteText(id: string, text: string) {
  const t = entries.get(id)?.term;
  if (!t) return;
  t.paste(text);
  t.focus();
}

export function selectAll(id: string) {
  entries.get(id)?.term.selectAll();
}

export function clear(id: string) {
  entries.get(id)?.term.clear();
}

// ---- search ----------------------------------------------------------------------------

export function searchAddon(id: string): SearchAddon | undefined {
  return entries.get(id)?.search;
}

/** Gives one terminal its own text size (null goes back to Settings). */
export function setTermFontSize(id: string, size: number | null) {
  useStore.getState().updateTerm(id, { fontSize: size });
  const e = entries.get(id);
  if (!e) return;
  e.term.options.fontSize = sizeFor(id);
  fitNow(id);
}

export function termFontSize(id: string): number {
  return sizeFor(id);
}
