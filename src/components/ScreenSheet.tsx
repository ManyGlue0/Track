import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { CornerDownLeft, FolderGit2, FolderOpen, GitBranch, Music, Play, Plus, SquareTerminal, Trash2, Volume1, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CustomSound } from "../lib/api";
import { spring } from "../lib/motion";
import { colorVars, type ColorKey } from "../lib/palette";
import { BUILTIN, DEFAULT_SOUND, forgetCustom, playSound } from "../lib/sounds";
import { useDark, useStore, type Screen, type SheetState } from "../lib/store";
import { ColorSwatches, IconButton, Modal, Slider } from "./ui";

/** Create or edit a screen: its name, color, notification sound, the
 *  folder its terminals start in and the command they run first. */
export function ScreenSheet() {
  const sheet = useStore((s) => s.sheet);
  const close = useCallback(() => useStore.setState({ sheet: null }), []);
  // Keep showing the last sheet while it animates away.
  const last = useRef<SheetState>(null);
  if (sheet) last.current = sheet;
  const shown = sheet ?? last.current;
  return (
    <Modal open={!!sheet} onClose={close} width={500} className="screen-modal">
      {shown && <SheetBody key={shown.mode === "edit" ? shown.id : "new"} sheet={shown} />}
    </Modal>
  );
}

function SheetBody({ sheet }: { sheet: NonNullable<SheetState> }) {
  const editing = useStore((s) => (sheet.mode === "edit" ? s.ws.screens.find((x) => x.id === sheet.id) : undefined));
  const count = useStore((s) => s.ws.screens.length);
  const dark = useDark();
  const [name, setName] = useState(editing?.name ?? "");
  const [color, setColor] = useState<ColorKey | null>(editing?.color ?? null);
  const [sound, setSound] = useState(editing?.sound ?? DEFAULT_SOUND);
  const [volume, setVolume] = useState(editing?.volume ?? 0.8);
  const [cwd, setCwd] = useState<string | null>(editing?.cwd ?? null);
  const [command, setCommand] = useState(editing?.command ?? "");
  const [git, setGit] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 60);
  }, []);

  useEffect(() => {
    if (!cwd) return setGit(null);
    api.fsInfo(cwd).then((i) => setGit(i.git)).catch(() => setGit(null));
  }, [cwd]);

  const placeholder = editing ? editing.name : `Screen ${count + 1}`;

  const submit = () => {
    const patch: Partial<Screen> = { name: name.trim() || placeholder, color, sound, volume, cwd, command: command.trim() || null };
    const st = useStore.getState();
    if (editing) st.updateScreen(editing.id, patch);
    else st.addScreen(patch);
    useStore.setState({ sheet: null });
  };

  const pickFolder = async () => {
    const path = await useStore.getState().openFolderPicker("Where should this screen's terminals start?", cwd);
    if (path) {
      setCwd(path);
      if (!name.trim()) setName(path.split("\\").filter(Boolean).pop() ?? "");
    }
    nameRef.current?.focus();
  };

  return (
    <div
      className="sheet tinted"
      style={colorVars(color, dark)}
      onKeyDown={(e) => {
        // Enter creates the screen from anywhere, except on buttons that do their own thing.
        if (e.key === "Enter" && !(e.target as HTMLElement).closest(".btn, .folder-btn, .sound-add, .icon-btn, .sound-remove")) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="sheet-head">
        <motion.div className={`sheet-mark ${color ? "" : "neutral"}`} layout transition={spring}>
          <svg viewBox="0 0 24 24" width="22" height="22">
            <rect x="3" y="3" width="8" height="8" rx="2.4" />
            <rect x="13" y="3" width="8" height="8" rx="2.4" opacity=".55" />
            <rect x="3" y="13" width="8" height="8" rx="2.4" opacity=".55" />
            <rect x="13" y="13" width="8" height="8" rx="2.4" opacity=".55" />
          </svg>
        </motion.div>
        <div className="sheet-head-text">
          <div className="sheet-kicker">{editing ? "Edit screen" : "New screen"}</div>
          <input
            ref={nameRef}
            className="sheet-title"
            placeholder={placeholder}
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>

      <section className="sheet-field">
        <div className="field-label">Color</div>
        <ColorSwatches allowNone layoutId="sheet-swatch" value={color} onChange={(c) => setColor(c as ColorKey | null)} />
      </section>

      <section className="sheet-field">
        <div className="field-label">Starts in</div>
        <div className="folder-field">
          <button className="folder-btn" onClick={() => void pickFolder()}>
            {git ? <FolderGit2 size={16} className="git" /> : <FolderOpen size={16} />}
            <span className={`folder-path ${cwd ? "" : "faint"}`}>{cwd ?? "Your home folder"}</span>
            {git && (
              <span className="branch">
                <GitBranch size={11} />
                {git}
              </span>
            )}
            <span className="folder-choose">Choose…</span>
          </button>
          {cwd && (
            <IconButton size="small" label="Use the home folder" onClick={() => setCwd(null)}>
              <X size={14} />
            </IconButton>
          )}
        </div>
      </section>

      <section className="sheet-field">
        <div className="field-label">
          Runs at start
          <span className="field-hint">In every new terminal here</span>
        </div>
        <label className="command-field">
          <SquareTerminal size={16} />
          <input
            className="command-text"
            placeholder="Nothing, just the shell"
            value={command}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setCommand(e.target.value.replace(/[\r\n]+/g, " "))}
          />
          {command && (
            <IconButton size="small" label="Run nothing" onClick={() => setCommand("")}>
              <X size={14} />
            </IconButton>
          )}
        </label>
      </section>

      <section className="sheet-field">
        <div className="field-label">
          Notification sound
          <span className="field-hint">Plays when a terminal here needs you</span>
        </div>
        <SoundPicker value={sound} onChange={setSound} volume={volume} />
        <div className={`volume-row ${sound === "none" ? "muted" : ""}`}>
          <button className="volume-icon" aria-label="Preview" onClick={() => void playSound(sound, volume * (useStore.getState().settings?.volume ?? 0.7))}>
            {volume === 0 ? <VolumeX size={15} /> : volume < 0.5 ? <Volume1 size={15} /> : <Volume2 size={15} />}
          </button>
          <Slider
            label="Volume"
            value={volume}
            onChange={setVolume}
            onCommit={(v) => void playSound(sound, v * (useStore.getState().settings?.volume ?? 0.7))}
          />
          <span className="volume-value">{Math.round(volume * 100)}%</span>
        </div>
      </section>

      <div className="sheet-actions">
        <span className="sheet-hint">{editing ? "" : "It opens with one terminal, ready to go"}</span>
        <button className="btn btn-ghost" onClick={() => useStore.setState({ sheet: null })}>
          Cancel
        </button>
        <motion.button className="btn btn-primary" onClick={submit} whileTap={{ scale: 0.96 }} transition={spring}>
          {editing ? "Save" : "Create screen"}
          <span className="keycap" aria-hidden>
            <CornerDownLeft size={11} strokeWidth={2.4} />
          </span>
        </motion.button>
      </div>
    </div>
  );
}

function SoundPicker({ value, onChange, volume }: { value: string; onChange: (s: string) => void; volume: number }) {
  const [custom, setCustom] = useState<CustomSound[]>([]);
  const master = useStore((s) => s.settings?.volume ?? 0.7);

  useEffect(() => {
    api.soundsList().then(setCustom).catch(() => {});
  }, []);

  const pick = (id: string) => {
    onChange(id);
    void playSound(id, volume * master);
  };

  const add = async () => {
    const file = await openDialog({
      title: "Choose a notification sound",
      multiple: false,
      filters: [{ name: "Sounds", extensions: ["wav", "mp3", "ogg", "m4a", "flac"] }],
    });
    if (typeof file !== "string") return;
    try {
      const s = await api.soundImport(file);
      setCustom((c) => [...c, s]);
      pick(`custom:${s.id}`);
    } catch (e) {
      useStore.getState().toast(String(e));
    }
  };

  const remove = async (s: CustomSound) => {
    await api.soundRemove(s.id).catch(() => {});
    forgetCustom(s.id);
    setCustom((c) => c.filter((x) => x.id !== s.id));
    if (value === `custom:${s.id}`) onChange(DEFAULT_SOUND);
  };

  return (
    <div className="sounds">
      <SoundChip on={value === "none"} onClick={() => onChange("none")} icon={<VolumeX size={13} />}>
        Silent
      </SoundChip>
      {BUILTIN.map((s) => (
        <SoundChip key={s.id} on={value === s.id} onClick={() => pick(s.id)} icon={<Play size={11} fill="currentColor" />}>
          {s.name}
        </SoundChip>
      ))}
      <AnimatePresence initial={false}>
        {custom.map((s) => (
          <motion.span key={s.id} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={spring}>
            <SoundChip
              on={value === `custom:${s.id}`}
              onClick={() => pick(`custom:${s.id}`)}
              icon={<Music size={12} />}
              onRemove={() => void remove(s)}
            >
              {s.name}
            </SoundChip>
          </motion.span>
        ))}
      </AnimatePresence>
      <button className="sound-add" onClick={() => void add()}>
        <Plus size={13} strokeWidth={2.2} />
        Add sound…
      </button>
    </div>
  );
}

function SoundChip({
  on,
  onClick,
  icon,
  children,
  onRemove,
}: {
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  onRemove?: () => void;
}) {
  return (
    <button className={`sound-chip ${on ? "on" : ""}`} onClick={onClick}>
      {on && <motion.span layoutId="sound-pill" className="sound-pill" transition={spring} />}
      <span className="sound-icon">{icon}</span>
      <span className="sound-name">{children}</span>
      {onRemove && (
        <span
          className="sound-remove"
          role="button"
          aria-label="Remove sound"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 size={11} />
        </span>
      )}
    </button>
  );
}
