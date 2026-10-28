import { AnimatePresence, motion } from "framer-motion";
import {
  ALargeSmall,
  ArrowRightLeft,
  Bell,
  BellRing,
  CircleCheck,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Ellipsis,
  Eraser,
  FolderOpen,
  Hand,
  Maximize2,
  MessageSquareOff,
  Minimize2,
  Pencil,
  RotateCcw,
  Search,
  ShieldCheck,
  TextSelect,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { requestClose as closeWithCheck } from "../lib/actions";
import { beginTermDrag, justDragged } from "../lib/drag";
import { api, type Attention } from "../lib/api";
import type { Rect } from "../lib/layout";
import { conceal, pageSpring, spring } from "../lib/motion";
import { colorVars } from "../lib/palette";
import { shortcutFor } from "../lib/shortcuts";
import { MAX_TERMINALS } from "../lib/layout";
import { shortPath, termName, useDark, useEscape, useStore } from "../lib/store";
import * as terms from "../lib/terms";
import { FindBar } from "./FindBar";
import { Button, ColorSwatches, IconButton, MenuItem, MenuKeys, MenuLabel, MenuSeparator, Popover, type Anchor } from "./ui";

const HOME = (() => {
  // The user folder, for "~" in headers. Learned from the first absolute cwd
  // a shell reports under C:\Users\<name>.
  return { value: "" };
})();

function homeOf(p: string): string {
  if (HOME.value) return HOME.value;
  const m = /^([A-Za-z]:\\Users\\[^\\]+)/i.exec(p);
  if (m) HOME.value = m[1];
  return HOME.value;
}

function attentionLabel(a: Attention): { icon: React.ReactNode; text: string } {
  switch (a.kind) {
    case "waiting":
      return { icon: <Hand size={12} strokeWidth={2.2} />, text: a.message || "Needs you" };
    case "done":
      return { icon: <CircleCheck size={12} strokeWidth={2.2} />, text: "Done" };
    case "notify":
      return { icon: <BellRing size={12} strokeWidth={2.2} />, text: a.message || "Notification" };
    default:
      return { icon: <Bell size={12} strokeWidth={2.2} />, text: "Bell" };
  }
}

interface Props {
  id: string;
  rect: Rect;
  popped: boolean;
  instant: boolean;
  /** Being carried: follows the pointer instead of springing to its slot. */
  lifted?: boolean;
  /** Carried over a screen tab: shrinks into the pointer at this point. */
  carryOrigin?: { x: number; y: number } | null;
}

export const TerminalCell = memo(function TerminalCell({ id, rect, popped, instant, lifted, carryOrigin }: Props) {
  const meta = useStore((s) => s.ws.terms[id]);
  const rt = useStore((s) => s.runtime[id]);
  const focused = useStore((s) => s.focused === id);
  const screenColor = useStore((s) => s.ws.screens.find((sc) => sc.terminals.includes(id))?.color ?? null);
  const shells = useStore((s) => s.shells);
  const renaming = useStore((s) => s.renaming === id);
  const finding = useStore((s) => s.finding === id);
  const settings = useStore((s) => s.settings);
  const dark = useDark();
  const slotRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const confirm = useStore((s) => (s.closing?.id === id ? s.closing.what : null));
  const fileOver = useStore((s) => s.fileOver === id);

  const cellRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | null>(null);

  // Ctrl+scroll sizes this terminal's text (and only this one's), with a
  // small badge saying where it is. Trackpads send many small deltas: they
  // add up to one step per notch.
  useLayoutEffect(() => {
    const el = cellRef.current!;
    let acc = 0;
    let hide = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      acc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (Math.abs(acc) < 50) return;
      const step = acc < 0 ? 1 : -1;
      acc = 0;
      const next = Math.max(8, Math.min(32, terms.termFontSize(id) + step));
      const global = useStore.getState().settings?.fontSize ?? 13;
      terms.setTermFontSize(id, next === global ? null : next);
      setZoom(next);
      clearTimeout(hide);
      hide = window.setTimeout(() => setZoom(null), 1100);
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true });
      clearTimeout(hide);
    };
  }, [id]);

  useLayoutEffect(() => {
    const slot = slotRef.current!;
    terms.attach(id, slot);
    let timer = 0;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => terms.fitNow(id), 70);
    });
    ro.observe(slot);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      terms.detach(id);
    };
  }, [id]);

  const color = meta?.color ?? screenColor;
  const name = termName(meta, rt, shells);
  const cwd = rt?.cwd || meta?.cwd || "";
  const att = rt?.attention ?? null;
  const working = rt?.agent === "working";
  const exited = rt?.status === "exited";
  const failed = rt?.status === "error";
  const consent = rt?.status === "consent";

  const focusMe = useCallback(
    (e: React.PointerEvent) => {
      // The menu is portaled out of the cell, but React still bubbles its
      // presses here: they're not clicks on the terminal ("Duplicate" focuses the copy).
      if (!cellRef.current?.contains(e.target as Node)) return;
      const st = useStore.getState();
      st.setFocused(id);
      // The header is also a handle: it pops out on click, not on press.
      const onHead = (e.target as HTMLElement).closest(".cell-head");
      if (!onHead && st.settings?.focusMode === "popout" && st.popped !== id) st.setPopped(id);
      requestAnimationFrame(() => terms.focus(id));
    },
    [id],
  );

  const requestClose = useCallback(() => void closeWithCheck(id), [id]);
  const cancelClose = useCallback(() => useStore.setState({ closing: null }), []);
  useEscape(confirm !== null, cancelClose);

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useStore.getState().setFocused(id);
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const onBodyContext = (e: React.MouseEvent) => {
    // As in Windows Terminal: a program that reads the mouse gets the
    // right-click (Claude Code pastes on it itself); Shift+right-click is Track's.
    if (terms.mouseTracking(id) && !e.shiftKey) {
      e.preventDefault();
      return;
    }
    if (settings?.rightClickPaste) {
      e.preventDefault();
      if (terms.hasSelection(id)) void terms.copySelection(id);
      else void terms.paste(id);
      return;
    }
    openMenu(e);
  };

  const label = att ? attentionLabel(att) : null;
  const progress = rt?.progress;

  return (
    <motion.div
      ref={cellRef}
      data-id={id}
      className={[
        "cell",
        focused && "focused",
        att && "attention",
        popped && "popped",
        lifted && "lifted",
        carryOrigin && "carried",
        fileOver && "file-over",
        color && "tinted",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        ...colorVars(color, dark),
        zIndex: lifted ? 40 : popped ? 30 : undefined,
        transformOrigin: carryOrigin ? `${carryOrigin.x}px ${carryOrigin.y}px` : undefined,
      }}
      initial={{ opacity: 0, scale: 0.97, x: rect.x, y: rect.y, width: rect.w, height: rect.h }}
      animate={{
        opacity: carryOrigin ? 0.92 : 1,
        scale: carryOrigin ? 0.36 : lifted ? 0.985 : 1,
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
      }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.14 } }}
      transition={
        instant
          ? { duration: 0 }
          : lifted
            ? // Glued to the pointer while carried; only the lift itself springs.
              { x: { duration: 0 }, y: { duration: 0 }, width: { duration: 0 }, height: { duration: 0 }, scale: spring, opacity: { duration: 0.15 } }
            : { ...pageSpring, opacity: { duration: 0.18 } }
      }
      onPointerDownCapture={focusMe}
    >
      <div
        className="cell-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          beginTermDrag(id, e, cellRef.current!);
        }}
        onClick={(e) => {
          if (justDragged() || (e.target as HTMLElement).closest("button, input")) return;
          const st = useStore.getState();
          if (st.settings?.focusMode === "popout" && st.popped !== id) st.setPopped(id);
        }}
        role="group"
        tabIndex={-1}
        aria-roledescription="terminal"
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          useStore.setState({ renaming: id });
        }}
        onContextMenu={openMenu}
      >
        <span className={`cell-dot ${working ? "working" : ""} ${exited ? "hollow" : ""}`}>
          {working && (
            <motion.svg
              className="cell-dot-spin"
              viewBox="0 0 16 16"
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1.1, ease: "linear" }}
            >
              <circle cx="8" cy="8" r="6" />
            </motion.svg>
          )}
        </span>
        {renaming ? (
          <RenameField id={id} initial={meta?.name ?? ""} placeholder={name} />
        ) : (
          <span className="cell-name">{name}</span>
        )}
        {meta?.admin && (
          <span className="cell-admin" title="Running as administrator">
            <ShieldCheck size={12} strokeWidth={2.2} />
          </span>
        )}
        {cwd && !renaming && <span className="cell-cwd">{shortPath(cwd, homeOf(cwd))}</span>}
        <span className="cell-spacer" />
        <AnimatePresence initial={false}>
          {label && !confirm && (
            <motion.span
              key={att!.kind}
              className={`cell-chip ${att!.kind}`}
              initial={{ opacity: 0, scale: 0.9, x: 6 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.92, transition: conceal }}
              transition={spring}
            >
              {label.icon}
              <span>{label.text}</span>
            </motion.span>
          )}
        </AnimatePresence>
        {confirm ? (
          <motion.span className="cell-confirm" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={spring}>
            <span>
              End <b>{confirm}</b>?
            </span>
            <button className="cell-confirm-btn danger" autoFocus onClick={() => useStore.getState().closeTerminal(id)}>
              End
            </button>
            <button className="cell-confirm-btn" onClick={cancelClose}>
              Cancel
            </button>
          </motion.span>
        ) : (
          <span className="cell-actions">
            <IconButton
              size="tiny"
              label={popped ? "Back to the grid" : "Pop out"}
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().setPopped(popped ? null : id);
                terms.focus(id);
              }}
            >
              {popped ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </IconButton>
            <IconButton size="tiny" label="More" onClick={(e) => openMenu(e)}>
              <Ellipsis size={14} />
            </IconButton>
            <IconButton size="tiny" className="danger" label="Close terminal" onClick={requestClose}>
              <X size={14} />
            </IconButton>
          </span>
        )}
        {progress && (
          <span className={`cell-progress state-${progress.state}`}>
            <span style={{ width: progress.state === 3 ? undefined : `${progress.value}%` }} />
          </span>
        )}
      </div>

      <div className="cell-body" onContextMenu={onBodyContext}>
        <div className="cell-slot" ref={slotRef} />
        <AnimatePresence>
          {zoom !== null && (
            <motion.div
              key="zoom"
              className="zoom-badge"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={spring}
            >
              <span className="zoom-size">{zoom}</span> px
              {meta?.fontSize == null && <span className="zoom-note">default</span>}
            </motion.div>
          )}
          {finding && <FindBar id={id} />}
          {consent && (
            <motion.div
              className="cell-ended"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6, transition: conceal }}
              transition={spring}
            >
              <span className="cell-ended-text">Administrator terminal</span>
              <Button variant="default" onClick={() => terms.restart(id)}>
                <ShieldCheck size={13} />
                Start as administrator
              </Button>
              <Button variant="ghost" onClick={() => useStore.getState().closeTerminal(id)}>
                Close
              </Button>
            </motion.div>
          )}
          {(exited || failed) && (
            <motion.div
              className="cell-ended"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6, transition: conceal }}
              transition={spring}
            >
              <span className="cell-ended-text">
                {failed
                  ? rt?.error || "Couldn't start the shell"
                  : rt?.exitCode === 0
                    ? "The shell ended"
                    : `The shell ended with code ${rt?.exitCode ?? "?"}`}
              </span>
              <Button variant="default" onClick={() => terms.restart(id)}>
                <RotateCcw size={13} />
                Restart
              </Button>
              <Button variant="ghost" onClick={() => useStore.getState().closeTerminal(id)}>
                Close
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <TerminalMenu id={id} anchor={menu} onClose={() => setMenu(null)} onClose2={requestClose} popped={popped} />
    </motion.div>
  );
});

function RenameField({ id, initial, placeholder }: { id: string; initial: string; placeholder: string }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useCallback(
    (save: boolean) => {
      if (save) useStore.getState().updateTerm(id, { name: value.trim() });
      useStore.setState({ renaming: null });
      requestAnimationFrame(() => terms.focus(id));
    },
    [id, value],
  );
  useEscape(true, () => done(false));
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="cell-rename"
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(true);
      }}
      onBlur={() => done(true)}
    />
  );
}

function TerminalMenu({
  id,
  anchor,
  onClose,
  onClose2,
  popped,
}: {
  id: string;
  anchor: Anchor | null;
  onClose: () => void;
  onClose2: () => void;
  popped: boolean;
}) {
  const meta = useStore((s) => s.ws.terms[id]);
  const screens = useStore((s) => s.ws.screens);
  const exited = useStore((s) => s.runtime[id]?.status === "exited" || s.runtime[id]?.status === "error");
  const cwd = useStore((s) => s.runtime[id]?.cwd || s.ws.terms[id]?.cwd || "");
  const overrides = useStore((s) => s.settings?.shortcuts ?? {});
  const dark = useDark();
  const here = screens.find((s) => s.terminals.includes(id));
  const others = screens.filter((s) => s.id !== here?.id);
  const selection = anchor ? terms.hasSelection(id) : false;
  const run = (f: () => void) => () => {
    onClose();
    f();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={258}>
      <div className="menu">
        <MenuItem icon={<Copy size={15} />} disabled={!selection} onSelect={run(() => void terms.copySelection(id))} trailing={<MenuKeys combo={shortcutFor("copy", overrides)} />}>
          Copy
        </MenuItem>
        <MenuItem icon={<ClipboardPaste size={15} />} onSelect={run(() => void terms.paste(id))} trailing={<MenuKeys combo={shortcutFor("paste", overrides)} />}>
          Paste
        </MenuItem>
        <MenuItem icon={<TextSelect size={15} />} onSelect={run(() => terms.selectAll(id))}>
          Select all
        </MenuItem>
        <MenuItem icon={<Search size={15} />} onSelect={run(() => useStore.setState({ finding: id }))} trailing={<MenuKeys combo={shortcutFor("find", overrides)} />}>
          Find
        </MenuItem>
        <MenuItem icon={<Eraser size={15} />} onSelect={run(() => terms.clear(id))}>
          Clear scrollback
        </MenuItem>
        {meta?.fontSize != null && (
          <MenuItem icon={<ALargeSmall size={15} />} onSelect={run(() => terms.setTermFontSize(id, null))} trailing={<span className="menu-keys">{meta.fontSize} px</span>}>
            Reset text size
          </MenuItem>
        )}
        {meta?.resume && (
          <MenuItem icon={<MessageSquareOff size={15} />} onSelect={run(() => useStore.getState().updateTerm(id, { resume: null }))} trailing={<span className="menu-keys">{meta.resume.tool === "claude" ? "Claude" : "Codex"}</span>}>
            Don't reopen this chat
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          icon={<FolderOpen size={15} />}
          disabled={!cwd}
          onSelect={run(() => api.fsReveal(cwd).catch((e) => useStore.getState().toast(String(e))))}
        >
          Open in File Explorer
        </MenuItem>
        <MenuItem
          icon={<CopyPlus size={15} />}
          disabled={(here?.terminals.length ?? 0) >= MAX_TERMINALS}
          onSelect={run(() => useStore.getState().duplicateTerminal(id))}
          trailing={<MenuKeys combo={shortcutFor("duplicateTerminal", overrides)} />}
        >
          Duplicate
        </MenuItem>
        <MenuItem icon={<Pencil size={15} />} onSelect={run(() => useStore.setState({ renaming: id }))} trailing={<MenuKeys combo={shortcutFor("rename", overrides)} />}>
          Rename
        </MenuItem>
        <MenuItem
          icon={popped ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          onSelect={run(() => useStore.getState().setPopped(popped ? null : id))}
          trailing={<MenuKeys combo={shortcutFor("popOut", overrides)} />}
        >
          {popped ? "Back to the grid" : "Pop out"}
        </MenuItem>
        <MenuLabel>Color</MenuLabel>
        <div className="menu-swatches">
          <ColorSwatches
            allowNone
            layoutId={`term-color-${id}`}
            value={meta?.color ?? null}
            onChange={(c) => useStore.getState().updateTerm(id, { color: c as typeof meta.color })}
          />
        </div>
        {others.length > 0 && (
          <>
            <MenuLabel>
              <ArrowRightLeft size={12} /> Move to
            </MenuLabel>
            {others.slice(0, 8).map((s) => (
              <MenuItem
                key={s.id}
                icon={<span className="menu-screen-dot" style={colorVars(s.color, dark)} />}
                onSelect={run(() => {
                  if (useStore.getState().moveTerminal(id, s.id)) {
                    useStore.getState().toast(`Moved to ${s.name}`, { label: "Go", run: () => useStore.getState().setActiveScreen(s.id) });
                  }
                })}
                trailing={<span className="menu-count">{s.terminals.length}</span>}
              >
                {s.name}
              </MenuItem>
            ))}
          </>
        )}
        <MenuSeparator />
        {exited && (
          <MenuItem icon={<RotateCcw size={15} />} onSelect={run(() => terms.restart(id))}>
            Restart
          </MenuItem>
        )}
        <MenuItem icon={<X size={15} />} danger onSelect={run(onClose2)} trailing={<MenuKeys combo={shortcutFor("closeTerminal", overrides)} />}>
          Close terminal
        </MenuItem>
      </div>
    </Popover>
  );
}
