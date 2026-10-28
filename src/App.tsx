import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { goToScreen, openFolders, runAction } from "./lib/actions";
import { api, on, type AgentSession, type Attention, type TermInfo } from "./lib/api";
import { pageSpring } from "./lib/motion";
import { accelerator, bindings } from "./lib/shortcuts";
import { DEFAULT_SOUND, playSound } from "./lib/sounds";
import { handleEscape, useDark, useStore } from "./lib/store";
import * as terms from "./lib/terms";
import { FolderPicker } from "./components/FolderPicker";
import { Grid } from "./components/Grid";
import { ScreenSheet } from "./components/ScreenSheet";
import { Settings } from "./components/Settings";
import { TitleBar } from "./components/TitleBar";
import { Toasts } from "./components/ui";

export default function App() {
  const loaded = useStore((s) => s.loaded);
  const screen = useStore((s) => s.ws.screens.find((x) => x.id === s.ws.activeScreen) ?? s.ws.screens[0]);
  const index = useStore((s) => s.ws.screens.findIndex((x) => x.id === s.ws.activeScreen));
  const settings = useStore((s) => s.settings);
  const dark = useDark();
  const lastIndex = useRef(index);
  const dir = index >= lastIndex.current ? 1 : -1;
  useEffect(() => {
    lastIndex.current = index;
  }, [index]);

  // ---- boot + backend events ----
  useEffect(() => {
    void useStore
      .getState()
      .init()
      .then(() => api.takePendingOpen())
      .then((folders) => folders.length && openFolders(folders));
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMedia = () => useStore.setState({ systemDark: media.matches });
    media.addEventListener("change", onMedia);

    const win = getCurrentWindow();
    const syncMax = () => win.isMaximized().then((m) => useStore.setState({ maximized: m }));
    void syncMax();
    const unResize = win.onResized(() => void syncMax());

    const onFocus = () => useStore.setState({ windowActive: true });
    const onBlur = () => useStore.setState({ windowActive: false });
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);

    const offs = [
      on<TermInfo>("term-info", (info) => useStore.getState().applyInfo(info)),
      on<{ id: string; attention: Attention }>("term-attention", ({ id }) => {
        const st = useStore.getState();
        if (!st.settings?.sounds) return;
        const screen = st.screenOf(id);
        void playSound(screen?.sound ?? DEFAULT_SOUND, (screen?.volume ?? 0.8) * st.settings.volume);
      }),
      on<TermInfo>("term-exit", (info) => {
        const st = useStore.getState();
        const rt = st.runtime[info.id];
        st.applyInfo(info);
        // Typing `exit` closes the terminal, like closing a tab. A shell that
        // dies right away (or with an error) stays, so you can see why.
        const lived = rt?.startedAt ? Date.now() - rt.startedAt : 0;
        if (info.exitCode === 0 && lived > 2500) st.closeTerminal(info.id);
      }),
      on("window-shown", () => {
        // Read it late: "Open in Track" adds (and focuses) a terminal right after.
        setTimeout(() => {
          const f = useStore.getState().focused;
          if (f) terms.focus(f);
        }, 60);
      }),
      on<string[]>("open-folders", (folders) => openFolders(folders)),
      // "Show" on a Holster notification: straight to that terminal.
      on<string>("show-terminal", (id) => {
        const st = useStore.getState();
        const screen = st.screenOf(id);
        if (!screen) return;
        st.setActiveScreen(screen.id);
        useStore.getState().setFocused(id);
        setTimeout(() => terms.focus(id), 80);
      }),
      // Remember which chat runs where, so reopening Track picks it up again.
      on<{ id: string; session: AgentSession | null }>("term-agent", ({ id, session }) => {
        useStore.getState().updateTerm(id, { resume: session });
      }),
      on<string>("navigate", (to) => {
        if (to === "settings") useStore.setState({ settingsOpen: true });
      }),
    ];

    // Files dragged in from Explorer paste their paths into the terminal under the pointer.
    const unDrop = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      const cellAt = (pos: { x: number; y: number }) => {
        const el = document.elementFromPoint(pos.x / devicePixelRatio, pos.y / devicePixelRatio);
        return (el?.closest(".cell[data-id]") as HTMLElement | null)?.dataset.id ?? null;
      };
      if (p.type === "over" || p.type === "enter") {
        const id = cellAt(p.position);
        if (useStore.getState().fileOver !== id) useStore.setState({ fileOver: id });
      } else if (p.type === "drop") {
        const id = cellAt(p.position);
        useStore.setState({ fileOver: null });
        if (id && p.paths.length) {
          const quoted = p.paths.map((x) => (/[\s&()^;,'`!%]/.test(x) ? `"${x}"` : x));
          terms.pasteText(id, quoted.join(" "));
          useStore.getState().setFocused(id);
        }
      } else {
        useStore.setState({ fileOver: null });
      }
    });

    return () => {
      offs.forEach((off) => off());
      media.removeEventListener("change", onMedia);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      void unResize.then((u) => u());
      void unDrop.then((u) => u());
    };
  }, []);

  // ---- theme (crossfades) and terminal options ----
  useLayoutEffect(() => {
    const root = document.documentElement;
    const next = dark ? "dark" : "light";
    if (root.dataset.theme === next) return;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (root.dataset.theme && doc.startViewTransition) {
      doc.startViewTransition(() =>
        flushSync(() => {
          root.dataset.theme = next;
          terms.applySettings();
        }),
      );
    } else {
      root.dataset.theme = next;
      terms.applySettings();
    }
  }, [dark]);

  useEffect(() => {
    if (settings) terms.applySettings();
  }, [settings?.fontFamily, settings?.fontSize, settings?.cursorStyle, settings?.cursorBlink, settings?.scrollback, settings?.lineHeight, settings?.gpuRendering]);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const st = useStore.getState();
      const target = e.target as HTMLElement;
      const inXterm = target.classList?.contains("xterm-helper-textarea");
      const inField = !inXterm && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape") {
        // Overlays first (menus, find, rename); otherwise Escape belongs to the program.
        if (!inField && handleEscape()) consume();
        return;
      }
      if (inField || st.folderRequest || st.sheet || st.settingsOpen) return;
      if (e.ctrlKey && e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        consume();
        goToScreen(Number(e.code.slice(5)));
        return;
      }
      const acc = accelerator(e);
      if (!acc) return;
      if (inXterm && st.focused) {
        // Ctrl+C copies when there's a selection, otherwise it interrupts.
        if (acc === "Ctrl+C" && terms.hasSelection(st.focused)) {
          consume();
          void terms.copySelection(st.focused);
          return;
        }
        if (acc === "Ctrl+V") {
          consume();
          void terms.paste(st.focused);
          return;
        }
      }
      const action = bindings(st.settings?.shortcuts ?? {}).get(acc);
      if (!action) return;
      consume();
      runAction(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // ---- drag & drop: tabs among tabs (terminals are carried by drag.ts) ----
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const a = String(active.id);
    const o = String(over.id);
    const st = useStore.getState();
    if (a.startsWith("tab:") && o.startsWith("tab:") && a !== o) {
      const from = st.ws.screens.findIndex((s) => `tab:${s.id}` === a);
      const to = st.ws.screens.findIndex((s) => `tab:${s.id}` === o);
      if (from >= 0 && to >= 0) st.reorderScreens(from, to);
    }
  };

  if (!loaded) return <div className="boot" />;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div className="app">
        <TitleBar />
        <main className="stage">
          <AnimatePresence mode="wait" initial={false} custom={dir}>
            <motion.div
              key={screen.id}
              className="stage-screen"
              custom={dir}
              initial="enter"
              animate="center"
              exit="exit"
              variants={{
                enter: (d: number) => ({ opacity: 0, x: d * 28 }),
                center: { opacity: 1, x: 0, transition: { ...pageSpring, opacity: { duration: 0.18 } } },
                exit: (d: number) => ({ opacity: 0, x: d * -20, transition: { duration: 0.1, ease: "easeIn" } }),
              }}
            >
              <Grid screen={screen} />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <ScreenSheet />
      <Settings />
      <FolderPicker />
      <Toasts />
    </DndContext>
  );
}
