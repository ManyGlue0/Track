import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Download, Minus, Plus, RefreshCw, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, on, type CodexStatus, type HolsterStatus, type HookStatus, type MenuStatus, type Settings as SettingsT } from "../lib/api";
import { spring } from "../lib/motion";
import { ACTIONS, accelerator, shortcutFor, type ActionId } from "../lib/shortcuts";
import { playSound } from "../lib/sounds";
import { useEscape, useStore } from "../lib/store";
import { fontStack } from "../lib/themes";
import { FontPicker } from "./FontPicker";
import { ShellGlyph } from "./TitleBar";
import { Button, IconButton, Keys, MenuItem, Modal, Popover, Segmented, Slider, Toggle, anchorFrom, type Anchor } from "./ui";

export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const close = useCallback(() => useStore.setState({ settingsOpen: false }), []);
  return (
    <Modal open={open} onClose={close} width={620} className="settings-modal">
      <SettingsBody onClose={close} />
    </Modal>
  );
}

function SettingsBody({ onClose }: { onClose: () => void }) {
  const s = useStore((st) => st.settings);
  const update = useStore((st) => st.updateSettings);
  const [version, setVersion] = useState("");
  const [dataDir, setDataDir] = useState("");
  useEffect(() => {
    api.appInfo().then((i) => {
      setVersion(i.version);
      setDataDir(i.dataDir);
    });
  }, []);
  if (!s) return null;

  return (
    <div className="settings">
      <div className="settings-head">
        <h2>Settings</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="settings-scroll">
        <Group title="Look">
          <Row label="Theme">
            <Segmented
              id="theme"
              value={s.theme}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              onChange={(theme) => void update({ theme })}
            />
          </Row>
          <Row label="Font" hint={<span className="font-sample" style={{ fontFamily: fontStack(s.fontFamily) }}>{"fn main() { 0O 1lI |> => != }"}</span>}>
            <FontPicker value={s.fontFamily} onChange={(fontFamily) => void update({ fontFamily })} />
          </Row>
          <Row label="Text size" hint="Ctrl+= and Ctrl+- change it from anywhere">
            <Stepper value={s.fontSize} min={9} max={24} onChange={(fontSize) => void update({ fontSize })} />
          </Row>
          <Row label="Line spacing">
            <Segmented
              id="line"
              value={String(s.lineHeight)}
              options={[
                { value: "1", label: "Compact" },
                { value: "1.2", label: "Normal" },
                { value: "1.4", label: "Roomy" },
              ]}
              onChange={(v) => void update({ lineHeight: Number(v) })}
            />
          </Row>
          <Row label="Cursor">
            <Segmented
              id="cursor"
              value={s.cursorStyle}
              options={[
                { value: "bar", label: "Bar" },
                { value: "block", label: "Block" },
                { value: "underline", label: "Underline" },
              ]}
              onChange={(cursorStyle) => void update({ cursorStyle })}
            />
          </Row>
          <Row label="Blinking cursor">
            <Toggle label="Blinking cursor" on={s.cursorBlink} onChange={(cursorBlink) => void update({ cursorBlink })} />
          </Row>
          <Row label="GPU text rendering" hint="Faster for terminals that print a flood of output; text looks a little heavier">
            <Toggle label="GPU text rendering" on={s.gpuRendering} onChange={(gpuRendering) => void update({ gpuRendering })} />
          </Row>
        </Group>

        <Group title="Terminals">
          <Row label="Default shell">
            <ShellSelect value={s.defaultShell} onChange={(defaultShell) => void update({ defaultShell })} />
          </Row>
          <Row
            label="Focusing a terminal"
            hint={s.focusMode === "popout" ? "The one you click pops out bigger, the rest wait behind" : "Click any terminal to type in it; cells keep their size"}
          >
            <Segmented
              id="focus"
              value={s.focusMode}
              options={[
                { value: "click", label: "Click to focus" },
                { value: "popout", label: "Pop out" },
              ]}
              onChange={(focusMode) => void update({ focusMode })}
            />
          </Row>
          <Row label="Copy on select">
            <Toggle label="Copy on select" on={s.copyOnSelect} onChange={(copyOnSelect) => void update({ copyOnSelect })} />
          </Row>
          <Row label="Right-click pastes" hint="Otherwise right-click opens the terminal's menu. Apps that use the mouse, like Claude Code, get the right-click themselves; Shift+right-click is always Track's">
            <Toggle label="Right-click pastes" on={s.rightClickPaste} onChange={(rightClickPaste) => void update({ rightClickPaste })} />
          </Row>
          <Row label="Scrollback">
            <Segmented
              id="scrollback"
              value={String(s.scrollback)}
              options={[
                { value: "5000", label: "5k lines" },
                { value: "10000", label: "10k" },
                { value: "50000", label: "50k" },
              ]}
              onChange={(v) => void update({ scrollback: Number(v) })}
            />
          </Row>
          <Row label="Follow folders" hint="pwsh, cmd and Git Bash report where they are, so headers show it and terminals reopen there">
            <Toggle label="Follow folders" on={s.shellIntegration} onChange={(shellIntegration) => void update({ shellIntegration })} />
          </Row>
        </Group>

        <Group title="When a terminal needs you">
          <Row label="Sounds" hint="Each screen picks its own sound">
            <Toggle label="Sounds" on={s.sounds} onChange={(sounds) => void update({ sounds })} />
          </Row>
          <Row label="Volume">
            <div className="row-slider">
              <Slider
                label="Volume"
                value={s.volume}
                onChange={(volume) => useStore.setState({ settings: { ...s, volume } })}
                onCommit={(volume) => {
                  void update({ volume });
                  void playSound("chime", volume);
                }}
              />
              <span className="volume-value">{Math.round(s.volume * 100)}%</span>
            </div>
          </Row>
          <Row label="Notify in Holster" hint="While Track is in the background, Holster shows what happened, with a button that opens the terminal">
            <Toggle label="Notify in Holster" on={s.holsterNotify} onChange={(holsterNotify) => void update({ holsterNotify })} />
          </Row>
          <Row label="Glow in Holster" hint={s.holsterNotify ? "Holster's tab lights up for a bell, or when Track is muted in Holster" : "Holster's tab lights up while Track is in the background"}>
            <Toggle label="Glow in Holster" on={s.holsterGlow} onChange={(holsterGlow) => void update({ holsterGlow })} />
          </Row>
        </Group>

        <Group title="AI agents">
          <ClaudeHookRow />
          <CodexRow />
          <Row label="Reopen chats" hint="When Track reopens, a terminal that was in a Claude Code or Codex chat picks it up where it was">
            <Toggle label="Reopen chats" on={s.resumeChats} onChange={(resumeChats) => void update({ resumeChats })} />
          </Row>
          {s.resumeChats && (
            <>
              <CommandRow label="Claude Code resumes with" value={s.claudeResume} fallback="claude --resume {id}" onSave={(claudeResume) => void update({ claudeResume })} />
              <CommandRow label="Codex resumes with" value={s.codexResume} fallback="codex resume {id}" onSave={(codexResume) => void update({ codexResume })} />
            </>
          )}
        </Group>

        <ShortcutsGroup settings={s} />

        <Group title="General">
          <Row label="Start with Windows" hint="Track waits in the tray until you need it">
            <Toggle label="Start with Windows" on={s.launchAtStartup} onChange={(launchAtStartup) => void update({ launchAtStartup })} />
          </Row>
          <ExplorerRow />
          <HolsterRow />
          <Row label="Data folder" hint={dataDir}>
            <Button variant="default" onClick={() => void revealItemInDir(dataDir + "\\settings.json")}>
              Open data folder
            </Button>
          </Row>
        </Group>

        <UpdatesGroup version={version} />
      </div>
    </div>
  );
}

type UpdateState =
  | { step: "idle" | "checking" | "latest" | "installing" }
  | { step: "available"; version: string }
  | { step: "downloading"; version: string; pct: number | null }
  | { step: "error"; message: string };

/** Checks GitHub for a newer Track when asked, and installs it on Update. */
function UpdatesGroup({ version }: { version: string }) {
  const [state, setState] = useState<UpdateState>({ step: "idle" });

  useEffect(
    () =>
      on<{ downloaded: number; total: number | null }>("update-progress", ({ downloaded, total }) =>
        setState((s) =>
          s.step === "downloading" ? { ...s, pct: total ? Math.min(100, Math.round((downloaded / total) * 100)) : null } : s,
        ),
      ),
    [],
  );

  const check = async () => {
    setState({ step: "checking" });
    try {
      const found = await api.updateCheck();
      setState(found ? { step: "available", version: found.version } : { step: "latest" });
    } catch (e) {
      setState({ step: "error", message: String(e) });
    }
  };
  const install = async (next: string) => {
    setState({ step: "downloading", version: next, pct: 0 });
    try {
      await api.updateInstall();
      setState({ step: "installing" });
    } catch (e) {
      setState({ step: "error", message: String(e) });
    }
  };

  const hint =
    state.step === "checking" ? (
      "Checking…"
    ) : state.step === "latest" ? (
      "You have the latest version"
    ) : state.step === "available" ? (
      `Version ${state.version} is ready. Track restarts: programs running in terminals stop, and the terminals reopen in their folders`
    ) : state.step === "downloading" ? (
      `Downloading ${state.version}${state.pct === null ? "…" : `, ${state.pct}%`}`
    ) : state.step === "installing" ? (
      "Installing. Track restarts by itself"
    ) : state.step === "error" ? (
      <span className="row-hint-error">{state.message}</span>
    ) : (
      "Looks for a newer version on GitHub"
    );

  return (
    <Group title="Updates">
      <Row label={version ? `Track ${version}` : "Track"} hint={hint}>
        {state.step === "available" ? (
          <Button variant="primary" onClick={() => void install(state.version)}>
            <Download size={14} /> Update
          </Button>
        ) : (
          <Button
            variant="default"
            disabled={state.step === "checking" || state.step === "downloading" || state.step === "installing"}
            onClick={() => void check()}
          >
            <RefreshCw size={14} className={state.step === "checking" ? "spin" : ""} /> Check
          </Button>
        )}
      </Row>
    </Group>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="group">
      <div className="group-title">{title}</div>
      <div className="group-card">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-label">{label}</div>
        {hint && <div className="row-hint">{hint}</div>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="stepper">
      <IconButton size="small" label="Smaller" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        <Minus size={14} />
      </IconButton>
      <span className="stepper-value">{value}</span>
      <IconButton size="small" label="Bigger" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        <Plus size={14} />
      </IconButton>
    </div>
  );
}

function ShellSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const shells = useStore((s) => s.shells);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const current = shells.find((s) => s.id === value) ?? shells[0];
  return (
    <>
      <button className="select" onClick={(e) => setAnchor(anchor ? null : anchorFrom(e.currentTarget, true))}>
        {current && <ShellGlyph kind={current.kind} />}
        <span>{current?.name ?? "None found"}</span>
        <ChevronDown size={14} />
      </button>
      <Popover anchor={anchor} onClose={() => setAnchor(null)} width={240}>
        <div className="menu">
          {shells.map((sh) => (
            <MenuItem
              key={sh.id}
              icon={<ShellGlyph kind={sh.kind} />}
              checked={sh.id === current?.id}
              onSelect={() => {
                setAnchor(null);
                onChange(sh.id);
              }}
            >
              {sh.name}
            </MenuItem>
          ))}
        </div>
      </Popover>
    </>
  );
}

function ClaudeHookRow() {
  const [st, setSt] = useState<HookStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.hookStatus().then(setSt);
  }, []);
  const act = async (f: () => Promise<HookStatus>) => {
    setBusy(true);
    try {
      setSt(await f());
    } catch (e) {
      useStore.getState().toast(String(e));
    } finally {
      setBusy(false);
    }
  };
  const on = st?.state === "on";
  const hint =
    st?.state === "error"
      ? st.message ?? "Couldn't read Claude Code's settings"
      : on
        ? "Claude Code tells Track when it's working, waiting for you or done, and which chat is open"
        : st?.state === "outdated"
          ? "Installed for another copy of Track. Reinstall to point it here."
          : "Adds a small hook to Claude Code: Track then knows when Claude waits for you, and can reopen its chats";
  return (
    <Row label="Claude Code" hint={hint}>
      {on ? (
        <div className="hook-on">
          <span className="hook-badge">
            <Check size={12} strokeWidth={2.6} /> Connected
          </span>
          <Button variant="ghost" disabled={busy} onClick={() => void act(api.hookRemove)}>
            Remove
          </Button>
        </div>
      ) : (
        <Button variant="default" disabled={busy || st?.state === "error"} onClick={() => void act(api.hookInstall)}>
          {st?.state === "outdated" ? "Reinstall hook" : "Install hook"}
        </Button>
      )}
    </Row>
  );
}

function ExplorerRow() {
  const [st, setSt] = useState<MenuStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.explorerStatus().then(setSt);
  }, []);
  const act = async (f: () => Promise<MenuStatus>) => {
    setBusy(true);
    try {
      setSt(await f());
    } catch (e) {
      useStore.getState().toast(String(e));
    } finally {
      setBusy(false);
    }
  };
  const on = st?.state === "on";
  const hint =
    st?.message ??
    (on
      ? "Right-click a folder, or inside one, and it's right at the top of the menu"
      : st?.state === "outdated"
        ? "Set up for another copy of Track. Add it again to point it here."
        : "Adds “Open in Track” to the top of the Explorer right-click menu");
  return (
    <Row label="Open in Track, in Explorer" hint={st ? hint : "Checking…"}>
      {on ? (
        <div className="hook-on">
          <span className="hook-badge">
            <Check size={12} strokeWidth={2.6} /> In the menu
          </span>
          <Button variant="ghost" disabled={busy} onClick={() => void act(api.explorerRemove)}>
            Remove
          </Button>
        </div>
      ) : (
        <Button variant="default" disabled={busy || !st || st.state === "unavailable"} onClick={() => void act(api.explorerInstall)}>
          {busy ? "Adding…" : st?.state === "outdated" ? "Add again" : "Add to Explorer"}
        </Button>
      )}
    </Row>
  );
}

function CodexRow() {
  const [st, setSt] = useState<CodexStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.codexStatus().then(setSt);
  }, []);
  if (!st || st.state === "missing") return null;
  const act = async (f: () => Promise<CodexStatus>) => {
    setBusy(true);
    try {
      setSt(await f());
    } catch (e) {
      useStore.getState().toast(String(e));
    } finally {
      setBusy(false);
    }
  };
  const on = st.state === "on";
  const passAlong = st.chained ? ` It keeps passing every notification on to ${st.chained}.` : "";
  const hint =
    st.state === "error"
      ? (st.message ?? "Couldn't read Codex's config")
      : on
        ? `Codex tells Track when a turn is done, and which chat is open.${passAlong}`
        : st.state === "outdated"
          ? "Set up for another copy of Track. Connect again to point it here."
          : `Joins Codex's notifications so Track knows when it's done and can reopen its chats.${passAlong}`;
  return (
    <Row label="Codex" hint={hint}>
      {on ? (
        <div className="hook-on">
          <span className="hook-badge">
            <Check size={12} strokeWidth={2.6} /> Connected
          </span>
          <Button variant="ghost" disabled={busy} onClick={() => void act(api.codexRemove)}>
            Remove
          </Button>
        </div>
      ) : (
        <Button variant="default" disabled={busy || st.state === "error"} onClick={() => void act(api.codexInstall)}>
          {st.state === "outdated" ? "Connect again" : "Connect"}
        </Button>
      )}
    </Row>
  );
}

/** A command template, saved when you leave the field. `{id}` is the chat. */
function CommandRow({ label, value, fallback, onSave }: { label: string; value: string; fallback: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = text.includes("{id}");
  const commit = () => {
    const v = text.trim() || fallback;
    if (!v.includes("{id}")) return;
    if (v !== value) onSave(v);
    setText(v);
  };
  return (
    <Row label={label} hint={valid ? "{id} is the chat's id. Add your usual flags if you like." : "Keep {id} in it: that's where the chat's id goes"}>
      <input
        className={`command-input ${valid ? "" : "invalid"}`}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            e.stopPropagation();
            setText(value);
          }
        }}
      />
    </Row>
  );
}

function HolsterRow() {
  const [st, setSt] = useState<HolsterStatus | null>(null);
  useEffect(() => {
    api.holsterStatus().then(setSt);
  }, []);
  if (!st) return null;
  const text = !st.installed
    ? "Holster isn't installed on this PC"
    : st.error
      ? st.error
      : st.registered
        ? st.warnings.length
          ? st.warnings.join(" · ")
          : "Track has its tile in the dock"
        : "Registering…";
  return (
    <Row label="Holster" hint={text}>
      <span className={`holster-dot ${st.installed && st.registered && !st.error ? "ok" : st.error ? "err" : ""}`} />
    </Row>
  );
}

function ShortcutsGroup({ settings }: { settings: SettingsT }) {
  const overrides = settings.shortcuts ?? {};
  const [recording, setRecording] = useState<ActionId | null>(null);
  const update = useStore((s) => s.updateSettings);

  const save = (id: ActionId, acc: string | null) => {
    const next = { ...overrides };
    const def = ACTIONS.find((a) => a.id === id)!.default;
    if (acc === null || acc === def) delete next[id];
    else next[id] = acc;
    void update({ shortcuts: next });
  };

  useEscape(recording !== null, () => setRecording(null));

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      const acc = accelerator(e);
      if (!acc) return;
      if (acc === "Backspace" || acc === "Delete") {
        save(recording, "");
      } else {
        // One action per combination: taking it from another action frees it there.
        const taken = ACTIONS.find((a) => a.id !== recording && shortcutFor(a.id, overrides) === acc);
        if (taken) {
          const next = { ...overrides, [taken.id]: "", [recording]: acc };
          void update({ shortcuts: next });
          useStore.getState().toast(`${acc} moved from “${taken.label}”`);
        } else save(recording, acc);
      }
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, overrides]);

  const groups = ["Terminals", "Screens", "Editing", "View"] as const;
  return (
    <section className="group">
      <div className="group-title">
        Shortcuts
        <span className="group-hint">Click one to change it. Backspace clears it.</span>
      </div>
      <div className="group-card shortcuts">
        {groups.map((g) => (
          <div key={g} className="shortcut-group">
            {ACTIONS.filter((a) => a.group === g).map((a) => {
              const acc = shortcutFor(a.id, overrides);
              const changed = overrides[a.id] !== undefined;
              return (
                <div key={a.id} className="shortcut-row">
                  <span className="shortcut-label">{a.label}</span>
                  {changed && (
                    <IconButton size="tiny" label="Reset to default" onClick={() => save(a.id, null)}>
                      <RotateCcw size={12} />
                    </IconButton>
                  )}
                  <button className={`shortcut-keys ${recording === a.id ? "recording" : ""}`} onClick={() => setRecording(recording === a.id ? null : a.id)}>
                    <AnimatePresence mode="wait" initial={false}>
                      {recording === a.id ? (
                        <motion.span key="rec" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={spring}>
                          Press keys…
                        </motion.span>
                      ) : acc ? (
                        <motion.span key={acc} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                          <Keys combo={acc} />
                        </motion.span>
                      ) : (
                        <motion.span key="none" className="faint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                          None
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        <div className="shortcut-row fixed">
          <span className="shortcut-label">Go to screen 1–9</span>
          <span className="shortcut-keys static">
            <Keys combo="Ctrl+Alt+1" />
          </span>
        </div>
      </div>
    </section>
  );
}
