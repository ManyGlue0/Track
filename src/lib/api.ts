import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WindowBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  maximized: boolean;
}

export interface Settings {
  theme: "system" | "light" | "dark";
  defaultShell: string;
  focusMode: "click" | "popout";
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "bar" | "block" | "underline";
  cursorBlink: boolean;
  gpuRendering: boolean;
  scrollback: number;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  shellIntegration: boolean;
  sounds: boolean;
  volume: number;
  holsterNotify: boolean;
  holsterGlow: boolean;
  resumeChats: boolean;
  claudeResume: string;
  codexResume: string;
  launchAtStartup: boolean;
  pinnedFolders: string[];
  recentFolders: string[];
  shortcuts: Record<string, string>;
  window: WindowBounds | null;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface ShellInfo {
  id: string;
  name: string;
  path: string;
  kind: "pwsh" | "powershell" | "cmd" | "bash" | "wsl";
}

export interface Attention {
  kind: "bell" | "notify" | "waiting" | "done";
  message: string;
  at: number;
}

export interface AgentSession {
  tool: "claude" | "codex";
  id: string;
}

export interface TermInfo {
  id: string;
  pid: number | null;
  shell: string;
  shellName: string;
  shellKind: string;
  title: string;
  cwd: string;
  attention: Attention | null;
  agent: string | null;
  progress: { state: number; value: number } | null;
  exitCode: number | null;
  agentSession: AgentSession | null;
}

export interface Folder {
  name: string;
  path: string;
  git: string | null;
  hidden: boolean;
}

export interface Place {
  id: string;
  name: string;
  path: string;
}

export interface Drive {
  letter: string;
  label: string;
  path: string;
  kind: "fixed" | "removable" | "network" | "other";
}

export interface FolderInfo {
  exists: boolean;
  path: string;
  name: string;
  git: string | null;
}

export interface CustomSound {
  id: string;
  name: string;
  file: string;
}

export interface HookStatus {
  state: "missing" | "off" | "on" | "outdated" | "error";
  path: string;
  message: string | null;
}

export interface MenuStatus {
  state: "on" | "off" | "outdated" | "unavailable";
  message: string | null;
  developerMode: boolean;
}

export interface CodexStatus {
  state: "missing" | "off" | "on" | "outdated" | "error";
  chained: string | null;
  message: string | null;
}

export interface HolsterStatus {
  installed: boolean;
  registered: boolean;
  error: string | null;
  warnings: string[];
  port: number;
}

export interface SpawnRequest {
  id: string;
  shell: string;
  cwd: string | null;
  cols: number;
  rows: number;
  /** Typed at the first prompt of a fresh shell (resuming a chat). */
  startup?: string | null;
  resume?: AgentSession | null;
  /** Run as administrator (through Track's elevated helper). */
  admin?: boolean;
  /** An admin shell may show the UAC prompt now. */
  ask?: boolean;
}

export const api = {
  appInfo: () => invoke<{ version: string; dataDir: string }>("app_info"),
  updateCheck: () => invoke<{ version: string; notes: string | null } | null>("update_check"),
  updateInstall: () => invoke<void>("update_install"),
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (patch: DeepPartial<Settings>) => invoke<Settings>("update_settings", { patch }),
  loadWorkspace: () => invoke<unknown | null>("load_workspace"),
  saveWorkspace: (workspace: unknown) => invoke<void>("save_workspace", { workspace }),

  listFonts: () => invoke<{ name: string; mono: boolean }[]>("list_fonts"),
  listShells: () => invoke<ShellInfo[]>("list_shells"),
  ptySpawn: (request: SpawnRequest, onData: Channel<ArrayBuffer>) =>
    invoke<{ info: TermInfo; reattached: boolean }>("pty_spawn", { request, onData }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
  ptyAck: (id: string) => invoke<void>("pty_ack", { id }),
  ptyFocus: (id: string | null) => invoke<void>("pty_focus", { id }),
  ptyBusy: (id: string) => invoke<string | null>("pty_busy", { id }),

  fsList: (path: string, hidden = false) => invoke<Folder[]>("fs_list", { path, hidden }),
  fsPlaces: () => invoke<Place[]>("fs_places"),
  fsDrives: () => invoke<Drive[]>("fs_drives"),
  fsComplete: (input: string) => invoke<Folder[]>("fs_complete", { input }),
  fsProjects: () => invoke<Folder[]>("fs_projects"),
  fsCreateDir: (parent: string, name: string) => invoke<Folder>("fs_create_dir", { parent, name }),
  fsInfo: (path: string) => invoke<FolderInfo>("fs_info", { path }),
  fsReveal: (path: string) => invoke<void>("fs_reveal", { path }),
  noteRecent: (path: string) => invoke<Settings>("note_recent", { path }),

  soundsList: () => invoke<CustomSound[]>("sounds_list"),
  soundImport: (path: string) => invoke<CustomSound>("sound_import", { path }),
  soundRead: (id: string) => invoke<ArrayBuffer>("sound_read", { id }),
  soundRemove: (id: string) => invoke<void>("sound_remove", { id }),

  hookStatus: () => invoke<HookStatus>("hook_status"),
  hookInstall: () => invoke<HookStatus>("hook_install"),
  hookRemove: () => invoke<HookStatus>("hook_remove"),
  codexStatus: () => invoke<CodexStatus>("codex_status"),
  codexInstall: () => invoke<CodexStatus>("codex_install"),
  codexRemove: () => invoke<CodexStatus>("codex_remove"),
  holsterStatus: () => invoke<HolsterStatus>("holster_status"),

  takePendingOpen: () => invoke<string[]>("take_pending_open"),
  explorerStatus: () => invoke<MenuStatus>("explorer_status"),
  explorerInstall: () => invoke<MenuStatus>("explorer_install"),
  explorerRemove: () => invoke<MenuStatus>("explorer_remove"),
  hideWindow: () => invoke<void>("window_hide"),
  quit: () => invoke<void>("app_quit"),
};

export function on<T>(event: string, cb: (payload: T) => void): () => void {
  let un: UnlistenFn | null = null;
  let dead = false;
  listen<T>(event, (e) => cb(e.payload)).then((u) => {
    if (dead) u();
    else un = u;
  });
  return () => {
    dead = true;
    un?.();
  };
}
