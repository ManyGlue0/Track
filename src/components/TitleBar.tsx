import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "framer-motion";
import {
  BellRing,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy as RestoreIcon,
  FolderOpen,
  FolderSearch,
  Minus,
  Pencil,
  Plus,
  Settings2,
  ShieldCheck,
  Square,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ShellInfo } from "../lib/api";
import { api } from "../lib/api";
import { MAX_TERMINALS } from "../lib/layout";
import { spring } from "../lib/motion";
import { colorVars } from "../lib/palette";
import { shortcutFor } from "../lib/shortcuts";
import { useDark, useEscape, useStore, type Screen } from "../lib/store";
import { ColorSwatches, IconButton, MenuItem, MenuLabel, MenuSeparator, Popover, anchorFrom, type Anchor } from "./ui";

export function TitleBar() {
  const screens = useStore((s) => s.ws.screens);
  const active = useStore((s) => s.ws.activeScreen);
  const maximized = useStore((s) => s.maximized);
  const overrides = useStore((s) => s.settings?.shortcuts ?? {});
  const strip = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  // Many screens: the strip scrolls (arrows, or the mouse wheel sideways).
  // Faded edges say there's more; the list next to "+" reaches every screen.
  useLayoutEffect(() => {
    const el = strip.current!;
    const measure = () => {
      // The arrows' own room counts as room: tabs that would fit without them
      // don't overflow (otherwise the arrows would keep themselves on screen).
      const arrows = [...(el.parentElement?.querySelectorAll<HTMLElement>(".tab-scroll") ?? [])];
      const room = el.clientWidth + arrows.reduce((n, a) => n + a.offsetWidth + 4, 0);
      const fits = el.scrollWidth <= room + 1;
      const left = !fits && el.scrollLeft > 1;
      const right = !fits && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    };
    const ro = new ResizeObserver(() => {
      reveal(el, useStore.getState().ws.activeScreen, "instant");
      measure();
    });
    ro.observe(el);
    const mo = new MutationObserver(() => {
      for (const c of el.children) ro.observe(c);
      measure();
    });
    mo.observe(el, { childList: true });
    for (const c of el.children) ro.observe(c);
    el.addEventListener("scroll", measure, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    measure();
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("scroll", measure);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  // The screen you're on is always in view, clear of the faded edges.
  useEffect(() => {
    reveal(strip.current, active, "smooth");
  }, [active, screens.length]);

  const overflowing = edges.left || edges.right;
  const page = (dir: 1 | -1) => {
    const el = strip.current;
    if (el) el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.7), behavior: "smooth" });
  };

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <BrandMark />
      </div>
      {overflowing && (
        <button className="tab-scroll" aria-label="Scroll screens left" disabled={!edges.left} onClick={() => page(-1)}>
          <ChevronLeft size={15} />
        </button>
      )}
      <SortableContext items={screens.map((s) => `tab:${s.id}`)} strategy={horizontalListSortingStrategy}>
        <nav ref={strip} className={["tabs", edges.left && "fade-left", edges.right && "fade-right"].filter(Boolean).join(" ")} data-tauri-drag-region>
          {screens.map((s) => (
            <ScreenTab key={s.id} screen={s} />
          ))}
        </nav>
      </SortableContext>
      {overflowing && (
        <button className="tab-scroll" aria-label="Scroll screens right" disabled={!edges.right} onClick={() => page(1)}>
          <ChevronRight size={15} />
        </button>
      )}
      <ScreensButton newLabel={`New screen (${shortcutFor("newScreen", overrides)} for a quick one)`} />
      <div className="titlebar-fill" data-tauri-drag-region />
      <NewTerminalButton />
      <IconButton label={`Settings (${shortcutFor("settings", overrides)})`} onClick={() => useStore.setState({ settingsOpen: true })}>
        <Settings2 size={16} />
      </IconButton>
      <div className="caption">
        <button className="caption-btn" aria-label="Minimize" onClick={() => void getCurrentWindow().minimize()}>
          <Minus size={15} strokeWidth={1.6} />
        </button>
        <button className="caption-btn" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => void getCurrentWindow().toggleMaximize()}>
          {maximized ? <RestoreIcon size={12} strokeWidth={1.7} style={{ transform: "scaleX(-1)" }} /> : <Square size={12} strokeWidth={1.7} />}
        </button>
        <button className="caption-btn close" aria-label="Hide to tray" onClick={() => void api.hideWindow()}>
          <X size={16} strokeWidth={1.6} />
        </button>
      </div>
    </header>
  );
}

/** Scrolls the tab strip just enough to show a screen's tab whole. */
function reveal(strip: HTMLElement | null, screenId: string, behavior: ScrollBehavior) {
  const tab = strip?.querySelector(`[data-screen-tab="${screenId}"]`);
  if (!strip || !tab) return;
  const pad = 30; // the faded edge
  const r = tab.getBoundingClientRect();
  const s = strip.getBoundingClientRect();
  if (r.left < s.left + pad) strip.scrollBy({ left: r.left - s.left - pad, behavior });
  else if (r.right > s.right - pad) strip.scrollBy({ left: r.right - s.right + pad, behavior });
}

/** "+" makes a screen; the caret lists every screen (handy when they don't
 *  all fit on the bar). Same split look as "+ Terminal". */
function ScreensButton({ newLabel }: { newLabel: string }) {
  const [menu, setMenu] = useState<Anchor | null>(null);
  const screens = useStore((s) => s.ws.screens);
  const active = useStore((s) => s.ws.activeScreen);
  const runtime = useStore((s) => s.runtime);
  const dark = useDark();
  const btn = useRef<HTMLButtonElement>(null);
  const calling = screens.reduce((n, sc) => n + sc.terminals.filter((t) => runtime[t]?.attention).length, 0);
  return (
    <div className="split screens-split">
      <button className="split-main" aria-label="New screen" title={newLabel} onClick={() => useStore.setState({ sheet: { mode: "new" } })}>
        <Plus size={15} strokeWidth={2.2} />
      </button>
      <button
        ref={btn}
        className={`split-more ${menu ? "open" : ""}`}
        aria-label="All screens"
        onClick={() => setMenu(menu ? null : anchorFrom(btn.current!, true))}
      >
        <ChevronDown size={14} />
        {calling > 0 && <span className="tab-list-dot" />}
      </button>
      <Popover anchor={menu} onClose={() => setMenu(null)} width={250}>
        <div className="menu screens-menu">
          <MenuLabel>Screens</MenuLabel>
          {screens.map((sc) => {
            const needs = sc.terminals.filter((t) => runtime[t]?.attention).length;
            const working = sc.terminals.some((t) => runtime[t]?.agent === "working");
            return (
              <MenuItem
                key={sc.id}
                icon={<span className={`menu-screen-dot ${working ? "working" : ""}`} style={colorVars(sc.color, dark)} />}
                checked={sc.id === active}
                onSelect={() => {
                  setMenu(null);
                  useStore.getState().setActiveScreen(sc.id);
                }}
                trailing={
                  needs > 0 ? (
                    <span className="tab-needs">
                      <BellRing size={12} strokeWidth={2.4} />
                      {needs > 1 && <span className="tab-needs-count">{needs}</span>}
                    </span>
                  ) : (
                    <span className="menu-count">{sc.terminals.length}</span>
                  )
                }
              >
                {sc.name}
              </MenuItem>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}

function BrandMark() {
  return (
    <svg viewBox="0 0 96 96" width="18" height="18" aria-label="Track">
      <rect x="8" y="8" width="38" height="38" rx="11" fill="#7AD6AF" />
      <rect x="50" y="8" width="38" height="38" rx="11" fill="#89BCF2" />
      <rect x="8" y="50" width="38" height="38" rx="11" fill="#B2A2F5" />
      <rect x="50" y="50" width="38" height="38" rx="11" fill="#F2A887" />
    </svg>
  );
}

/** The screen's color dot; while an agent works on the screen, the dot
 *  becomes a spinner in that color. */
function TabMark({ working }: { working: boolean }) {
  return (
    <span className="tab-mark">
      <AnimatePresence initial={false}>
        {working ? (
          <motion.svg
            key="spin"
            className="tab-spin"
            viewBox="0 0 16 16"
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1, rotate: 360 }}
            exit={{ opacity: 0, scale: 0.4 }}
            transition={{ opacity: { duration: 0.18 }, scale: spring, rotate: { repeat: Infinity, duration: 1.1, ease: "linear" } }}
          >
            <circle cx="8" cy="8" r="5.5" />
          </motion.svg>
        ) : (
          <motion.span
            key="dot"
            className="tab-color"
            initial={{ opacity: 0, scale: 0.3 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.3 }}
            transition={spring}
          />
        )}
      </AnimatePresence>
    </span>
  );
}

function ScreenTab({ screen }: { screen: Screen }) {
  const active = useStore((s) => s.ws.activeScreen === screen.id);
  const needs = useStore((s) => screen.terminals.filter((t) => s.runtime[t]?.attention).length);
  const working = useStore((s) => screen.terminals.some((t) => s.runtime[t]?.agent === "working"));
  const carryingHere = useStore((s) => s.drag?.overTab === screen.id);
  const dark = useDark();
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [confirm, setConfirm] = useState<Anchor | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: `tab:${screen.id}` });

  const close = useCallback(() => {
    const running = screen.terminals.filter((t) => useStore.getState().runtime[t]?.status === "running").length;
    if (running > 0 && ref.current) setConfirm(anchorFrom(ref.current));
    else useStore.getState().closeScreen(screen.id);
  }, [screen]);

  const terminalOver = carryingHere;
  const full = screen.terminals.length >= MAX_TERMINALS;

  return (
    <>
      <div
        ref={(el) => {
          setNodeRef(el);
          ref.current = el;
        }}
        className={["tab", active && "active", isDragging && "dragging", terminalOver && (full ? "drop-full" : "drop-target")].filter(Boolean).join(" ")}
        style={{
          ...colorVars(screen.color, dark),
          transform: transform ? `translate3d(${Math.round(transform.x)}px, 0, 0)` : undefined,
          transition: transition ?? undefined,
        }}
        {...attributes}
        {...listeners}
        role="tab"
        data-screen-tab={screen.id}
        aria-selected={active}
        onClick={() => useStore.getState().setActiveScreen(screen.id)}
        onDoubleClick={() => setRenaming(true)}
        onMouseDown={(e) => {
          // Middle-click closes; without this, a scrollable tab bar starts
          // the browser's autoscroll and swallows the click.
          if (e.button === 1) e.preventDefault();
        }}
        onAuxClick={(e) => {
          if (e.button === 1) close();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {active && <motion.span layoutId="tab-pill" className="tab-pill" transition={spring} />}
        {(screen.color || working) && <TabMark working={working} />}
        {renaming ? (
          <TabRename screen={screen} onDone={() => setRenaming(false)} />
        ) : (
          <span className="tab-name">{screen.name}</span>
        )}
        <AnimatePresence initial={false}>
          {needs > 0 && (
            <motion.span
              key="needs"
              className="tab-needs"
              aria-label={needs > 1 ? `${needs} terminals need you` : "A terminal needs you"}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={spring}
            >
              <motion.span
                className="tab-bell"
                // One short ring each time it shows up.
                initial={{ rotate: 0 }}
                animate={{ rotate: [0, -16, 13, -9, 5, 0] }}
                transition={{ duration: 0.7, ease: "easeOut", delay: 0.1 }}
              >
                <BellRing size={12} strokeWidth={2.4} />
              </motion.span>
              {needs > 1 && <span className="tab-needs-count">{needs}</span>}
            </motion.span>
          )}
        </AnimatePresence>
        <button
          className="tab-close"
          aria-label={`Close ${screen.name}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      </div>

      <Popover anchor={menu} onClose={() => setMenu(null)} width={230}>
        <div className="menu">
          <MenuItem
            icon={<SquarePen size={15} />}
            onSelect={() => {
              setMenu(null);
              useStore.setState({ sheet: { mode: "edit", id: screen.id } });
            }}
          >
            Edit screen…
          </MenuItem>
          <MenuItem
            icon={<Pencil size={15} />}
            onSelect={() => {
              setMenu(null);
              setRenaming(true);
            }}
          >
            Rename
          </MenuItem>
          <MenuLabel>Color</MenuLabel>
          <div className="menu-swatches">
            <ColorSwatches
              allowNone
              layoutId={`screen-color-${screen.id}`}
              value={screen.color}
              onChange={(c) => useStore.getState().updateScreen(screen.id, { color: c as Screen["color"] })}
            />
          </div>
          <MenuSeparator />
          <MenuItem
            icon={<SquareTerminal size={15} />}
            disabled={full}
            onSelect={() => {
              setMenu(null);
              useStore.getState().setActiveScreen(screen.id);
              useStore.getState().addTerminal({ screenId: screen.id });
            }}
          >
            New terminal here
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<X size={15} />}
            danger
            onSelect={() => {
              setMenu(null);
              close();
            }}
          >
            Close screen
          </MenuItem>
        </div>
      </Popover>

      <Popover anchor={confirm} onClose={() => setConfirm(null)} width={260}>
        <div className="confirm">
          <div className="confirm-title">Close {screen.name}?</div>
          <div className="confirm-text">
            {screen.terminals.length === 1 ? "Its terminal ends" : `Its ${screen.terminals.length} terminals end`}, along with anything
            running in them.
          </div>
          <div className="confirm-actions">
            <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              autoFocus
              onClick={() => {
                setConfirm(null);
                useStore.getState().closeScreen(screen.id);
              }}
            >
              Close screen
            </button>
          </div>
        </div>
      </Popover>
    </>
  );
}

function TabRename({ screen, onDone }: { screen: Screen; onDone: () => void }) {
  const [value, setValue] = useState(screen.name);
  const ref = useRef<HTMLInputElement>(null);
  const finish = useCallback(
    (save: boolean) => {
      if (save && value.trim()) useStore.getState().updateScreen(screen.id, { name: value.trim() });
      onDone();
    },
    [onDone, screen.id, value],
  );
  useEscape(true, () => finish(false));
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="tab-rename"
      value={value}
      size={Math.max(4, value.length)}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** "+" starts the default shell in the screen's folder; the chevron offers
 *  every detected shell and recent folders. Right-click a shell for "Run as
 *  administrator". */
function NewTerminalButton() {
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [adminMenu, setAdminMenu] = useState<{ anchor: Anchor; shell: ShellInfo } | null>(null);
  const shells = useStore((s) => s.shells);
  const settings = useStore((s) => s.settings);
  const screen = useStore((s) => s.ws.screens.find((x) => x.id === s.ws.activeScreen));
  const full = (screen?.terminals.length ?? 0) >= MAX_TERMINALS;
  const chevron = useRef<HTMLButtonElement>(null);
  const defaultShell = shells.find((s) => s.id === settings?.defaultShell) ?? shells[0];
  const recents = (settings?.recentFolders ?? []).filter((f) => f !== screen?.cwd).slice(0, 5);
  const overrides = settings?.shortcuts ?? {};

  const add = (opts: { shell?: string; cwd?: string | null; admin?: boolean }) => {
    setMenu(null);
    setAdminMenu(null);
    useStore.getState().addTerminal(opts);
  };

  return (
    <div className={`split ${full ? "disabled" : ""}`}>
      <button
        className="split-main"
        disabled={full}
        aria-label="New terminal"
        title={full ? `This screen is full (${MAX_TERMINALS} terminals)` : `New terminal (${shortcutFor("newTerminal", overrides)})`}
        onClick={() => add({})}
      >
        <Plus size={15} strokeWidth={2.2} />
        <span>Terminal</span>
      </button>
      <button
        ref={chevron}
        className="split-more"
        disabled={full}
        aria-label="New terminal with…"
        title="Choose a shell or folder"
        onClick={() => setMenu(menu ? null : anchorFrom(chevron.current!, true))}
      >
        <ChevronDown size={14} />
      </button>
      <Popover
        anchor={menu}
        onClose={() => {
          setMenu(null);
          setAdminMenu(null);
        }}
        width={268}
      >
        <div className="menu">
          <MenuLabel>Shell</MenuLabel>
          {shells.map((s) => (
            <ShellRow
              key={s.id}
              shell={s}
              isDefault={s.id === defaultShell?.id}
              active={adminMenu?.shell.id === s.id}
              onOpen={() => add({ shell: s.id })}
              onMenu={(anchor) => setAdminMenu({ anchor, shell: s })}
            />
          ))}
          <MenuSeparator />
          <MenuLabel>Folder</MenuLabel>
          {screen?.cwd && (
            <MenuItem icon={<FolderOpen size={15} />} onSelect={() => add({ cwd: screen.cwd })} trailing={<span className="menu-tag">Screen</span>}>
              <span className="menu-path">{lastPart(screen.cwd)}</span>
            </MenuItem>
          )}
          {recents.map((f) => (
            <MenuItem key={f} icon={<FolderOpen size={15} />} onSelect={() => add({ cwd: f })}>
              <span className="menu-path" data-full={f}>
                {lastPart(f)}
                <span className="menu-path-parent">{parentPart(f)}</span>
              </span>
            </MenuItem>
          ))}
          <MenuItem
            icon={<FolderSearch size={15} />}
            onSelect={async () => {
              setMenu(null);
              const path = await useStore.getState().openFolderPicker("Open a terminal in…", screen?.cwd ?? null);
              if (path) useStore.getState().addTerminal({ cwd: path });
            }}
          >
            Choose folder…
          </MenuItem>
        </div>
      </Popover>
      <Popover anchor={adminMenu?.anchor ?? null} onClose={() => setAdminMenu(null)} width={210}>
        <div className="menu">
          <MenuItem icon={<ShieldCheck size={15} className="admin-icon" />} onSelect={() => adminMenu && add({ shell: adminMenu.shell.id, admin: true })}>
            Run as administrator
          </MenuItem>
        </div>
      </Popover>
    </div>
  );
}

/** A shell in the menu: click opens it, right-click offers "Run as administrator". */
function ShellRow({
  shell,
  isDefault,
  active,
  onOpen,
  onMenu,
}: {
  shell: ShellInfo;
  isDefault: boolean;
  active: boolean;
  onOpen: () => void;
  onMenu: (at: Anchor) => void;
}) {
  return (
    <button
      className={`menu-item ${active ? "menu-item-held" : ""}`}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <span className="menu-icon">
        <ShellGlyph kind={shell.kind} />
      </span>
      <span className="menu-label">{shell.name}</span>
      {isDefault && (
        <span className="menu-hint">
          <span className="menu-tag">Default</span>
        </span>
      )}
    </button>
  );
}

export function ShellGlyph({ kind }: { kind: string }) {
  const label = { pwsh: "PS", powershell: "PS", cmd: "C:", bash: "$", wsl: "🐧" }[kind] ?? ">";
  return <span className={`shell-glyph ${kind}`}>{kind === "wsl" ? <SquareTerminal size={13} /> : label}</span>;
}

function lastPart(p: string) {
  const parts = p.split("\\").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function parentPart(p: string) {
  const parts = p.split("\\").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("\\") : "";
}

