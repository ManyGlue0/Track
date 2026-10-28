# Track

Every terminal you run, in one calm window. Track holds up to sixteen real
shells per screen, across as many screens as you like, and tells you when one
of them needs you. It lives in the Holster dock as a window app.

## What it does

- **Screens are tabs.** Each one has a name, a color, a notification sound, a
  folder its terminals start in and, optionally, a command each new terminal
  there runs first (`claude`, `npm run dev`…). Terminals reopened when Track
  starts again come back as plain shells (or with their chat). Create them with the "+" sheet, or
  Ctrl+Shift+T for a quick one. Drag tabs to reorder, double-click to rename,
  middle-click to close. Tabs keep their full names; when they don't all fit,
  the bar scrolls (the ‹ › arrows or the mouse wheel) and the caret next to
  the screens' "+" lists every screen.
- **Any number of terminals, 1 to 16.** The grid picks the row count that fits
  the window best and spreads terminals evenly, so there are never holes.
  Adding or closing one reflows the rest with a spring.
- **Administrator terminals.** Right-click a shell in the "+ Terminal" menu →
  "Run as administrator". It opens in a normal cell marked with an amber shield. Windows won't
  let a normal app host an elevated shell, so Track starts a helper copy of
  itself elevated (`track --elevated-host`, one UAC prompt) that runs the admin
  consoles and streams them over a private named pipe. The helper ends with
  Track, or a minute after its last admin shell. Admin terminals reopened when
  Track starts wait for "Start as administrator" instead of prompting at login.
- **Real shells.** pwsh, Windows PowerShell, cmd, Git Bash and WSL distros,
  detected at start, run through ConPTY with a fresh copy of your environment
  (a PATH changed by an installer reaches new terminals without restarting).
- **Shells outlive the window.** Closing hides Track to the tray; only Quit ends
  the shells. After a quit or reboot, screens, names, colors and each
  terminal's folder come back (with fresh shells).
- **Attention.** The bell, OSC 9 / OSC 777 notifications and the Claude Code
  hook raise a ring on the cell, a red bell on its screen's tab and the
  screen's sound. While Track is in the background, Holster shows a
  notification ("Claude needs your permission to use Bash", with a Show button
  that opens that terminal); it's taken back once you've looked at the
  terminal. Going to the screen lands on the terminal that called.
- **At a glance on the tabs.** A screen's color dot turns into a spinner in
  that color while an agent works there.
- **Focus modes** (Settings): click to focus (cells keep their size), or pop out
  (the focused terminal springs into a large centered card).
- **Folder picker** of its own: Finder-style columns, a sidebar with pinned,
  recent, projects (git repos next to the ones you use), places and drives,
  git branches, a path bar with completion, type-ahead and full keyboard control.
- **Carry terminals around.** Grab a header and the live terminal follows the
  pointer while the others make room; drop it on a screen tab to move it there
  (Escape puts it back). Drop files from Explorer onto a terminal to paste
  their paths.
- **"Open in Track" in Explorer**, at the top level of the Windows 11
  right-click menu (folders and folder backgrounds). It opens a terminal in the
  screen whose folder holds that one, else the current screen, else a new
  screen. `track <folder>` from a shell does the same.
- **Any installed font** (Settings → Look), monospaced ones first.
  Ctrl+scroll over a terminal sizes that terminal's text alone.
- **AI chats come back.** With the Claude Code hook (and optionally Codex
  connected), Track remembers which chat runs in each terminal. When Track
  reopens, it types `claude --resume <id>` / `codex resume <id>` at that
  terminal's first prompt (templates editable in Settings → AI agents). A chat
  you end yourself (the shell's prompt comes back) is forgotten.
- The folder picker can make folders: "New folder" or Ctrl+Shift+N.
- **Duplicate** a terminal (its menu, or Ctrl+Shift+D): a new one right beside
  it, with the same shell, folder and color.
- **Right-click** pastes or opens the menu (Settings). Programs that read the
  mouse, like Claude Code's fullscreen mode, get the right-click themselves, as
  in Windows Terminal; Shift+right-click is always Track's.
- **Taskbar thumbnail and peek** show Track on its solid background: Windows
  leaves the acrylic out of peek, so Track hands it its own captures.

## Shortcuts

| | |
|---|---|
| New terminal | Ctrl+Shift+N |
| Duplicate terminal | Ctrl+Shift+D |
| Close terminal | Ctrl+Shift+W |
| New screen | Ctrl+Shift+T |
| Edit screen | Ctrl+Shift+E |
| Next / previous screen | Ctrl+Tab / Ctrl+Shift+Tab |
| Go to screen 1–9 | Ctrl+Alt+1…9 |
| Move focus | Alt+Arrows |
| Pop out | Ctrl+Shift+Enter |
| Find | Ctrl+Shift+F |
| Rename terminal | F2 |
| Copy / paste | Ctrl+Shift+C / Ctrl+Shift+V (Ctrl+C copies when text is selected; Ctrl+V pastes) |
| Text size | Ctrl+= / Ctrl+- / Ctrl+0 |
| Settings | Ctrl+, |

All of them except the screen numbers can be changed in Settings.

## Claude Code

Settings → AI agents → Claude Code → **Install hook** adds hooks for
SessionStart, UserPromptSubmit, Notification, PostToolUse, Stop and SessionEnd
to `~/.claude/settings.json`, each running `track.exe --hook <event>`. Inside a
Track terminal that reports to Track's loopback listener; anywhere else it
exits silently. "Needs you" is raised only for notifications that block on you
(permission prompts, questions); Claude's "waiting for your input" reminder and
status notes are ignored. PostToolUse marks Claude as working again once you've
answered a prompt. Your other hooks are left untouched, and Remove takes out
only Track's. Track updates its hooks by itself when a new version adds one.

## Explorer menu

Windows 11 only shows packaged commands at the top of the menu, so Track ships
`track_shell.dll` (the `shell-ext` crate, an `IExplorerCommand`) and registers
a sparse package (`src-tauri/sparse/AppxManifest.xml`) whose external location
is Track's folder. Settings → General → "Open in Track, in Explorer" adds or
removes it. Registering from loose files needs Windows Developer Mode; a
signed package would lift that (not done yet).

## How it's built

Tauri 2 (Rust) with React, TypeScript and Vite; xterm.js for rendering,
portable-pty (ConPTY) for the shells, Framer Motion for every animation.

- `src-tauri/src/pty.rs`: one ConPTY per terminal, owned by the backend so
  shells survive the window. Output streams to the UI over a raw-bytes channel
  and is kept (512 KB) for replay when the UI reloads.
- `src-tauri/src/scan.rs`: a small VT scanner for bells, notifications,
  titles, folders (OSC 7 / OSC 9;9) and progress (OSC 9;4).
- `src-tauri/src/shells.rs`: shell detection, the fresh environment, and the
  prompt integration that makes pwsh, cmd and Git Bash report their folder.
- `src-tauri/src/holster.rs`: manifest, health route, hook listener, preview
  state and the activity signal.
- `src-tauri/src/hook.rs`: the `--hook` client and the Claude Code settings
  install/remove.
- `src/lib/terms.ts`: the xterm registry; terminals live outside React, so
  switching screens or moving one never redraws from scratch.
- `src/lib/layout.ts`: the grid. `src/lib/drag.ts`: carrying terminals.
- `shell-ext/`: the Explorer command DLL. `src-tauri/src/explorer.rs`: its
  registration and the `--open` arguments.

Data lives in `%APPDATA%\app.track.desktop\` (`settings.json`,
`workspace.json`, custom `sounds\`, and the Holster preview).

## Develop

```
pnpm install
pnpm dev:app       # "Track Dev": its own data and window, never touches the
                   # installed Track's Holster tile, hooks or Explorer menu
pnpm tauri dev     # same identity as the installed app (don't run both)
pnpm release        # NSIS installer, per-user, with track_shell.dll
cargo build -p track-shell   # the Explorer DLL for dev (next to target/debug/track.exe)
pnpm app-icon       # regenerate icons from src-tauri/icons/track-icon.svg
```

`cargo test --manifest-path src-tauri/Cargo.toml` runs the backend tests.
