import { AnimatePresence, motion } from "framer-motion";
import { FolderOpen, SquareTerminal } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { gridRects, popRect } from "../lib/layout";
import { pageSpring } from "../lib/motion";
import { shortcutFor } from "../lib/shortcuts";
import { useStore, type Screen } from "../lib/store";
import { TerminalCell } from "./TerminalCell";
import { Button, Keys } from "./ui";

/** One screen's terminals. Mounted per screen: switching screens swaps grids. */
export function Grid({ screen }: { screen: Screen }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // While the window itself resizes, cells follow instantly instead of springing.
  const [instant, setInstant] = useState(true);
  const popped = useStore((s) => s.popped);

  useLayoutEffect(() => {
    const el = ref.current!;
    let settle = 0;
    let first = true;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
      if (!first) setInstant(true);
      first = false;
      clearTimeout(settle);
      settle = window.setTimeout(() => setInstant(false), 160);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      clearTimeout(settle);
      ro.disconnect();
    };
  }, []);

  const drag = useStore((s) => (s.drag?.screenId === screen.id ? s.drag : null));
  // While a terminal is carried, the grid shows where everything will land.
  const ids = drag ? drag.order : screen.terminals;
  const rects = useMemo(() => (size ? gridRects(ids.length, size.w, size.h) : []), [ids.length, size]);
  const pop = size ? popRect(size.w, size.h) : null;
  const poppedHere = popped && ids.includes(popped) ? popped : null;
  const landing = drag && !drag.overTab ? rects[ids.indexOf(drag.id)] : null;

  return (
    <div className="grid" ref={ref}>
      {size && (
        <AnimatePresence>
          {ids.map((id, i) => {
            const carried = drag?.id === id;
            const rect = carried
              ? { x: drag.pointer.x - drag.grab.x, y: drag.pointer.y - drag.grab.y, w: drag.size.w, h: drag.size.h }
              : poppedHere === id && pop
                ? pop
                : rects[i];
            return (
              <TerminalCell
                key={id}
                id={id}
                rect={rect}
                popped={poppedHere === id}
                instant={instant}
                lifted={carried}
                carryOrigin={carried && drag.overTab ? drag.grab : null}
              />
            );
          })}
        </AnimatePresence>
      )}
      <AnimatePresence>
        {landing && (
          <motion.div
            className="landing"
            initial={{ opacity: 0, x: landing.x, y: landing.y, width: landing.w, height: landing.h }}
            animate={{ opacity: 1, x: landing.x, y: landing.y, width: landing.w, height: landing.h }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ ...pageSpring, opacity: { duration: 0.15 } }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {poppedHere && (
          <motion.div
            className="pop-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
            transition={{ duration: 0.22 }}
            onPointerDown={() => useStore.getState().setPopped(null)}
          />
        )}
      </AnimatePresence>
      {ids.length === 0 && <EmptyScreen screen={screen} />}
    </div>
  );
}

function EmptyScreen({ screen }: { screen: Screen }) {
  const overrides = useStore((s) => s.settings?.shortcuts ?? {});
  return (
    <motion.div
      className="empty"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 38, delay: 0.05 }}
    >
      <div className="empty-icon">
        <SquareTerminal size={24} />
      </div>
      <h3>No terminals here yet</h3>
      <p>
        Start one and it takes the whole screen. Add more whenever you like, up to sixteen.
        {screen.cwd && (
          <span className="empty-cwd">
            <FolderOpen size={13} />
            {screen.cwd}
          </span>
        )}
      </p>
      <Button variant="primary" onClick={() => useStore.getState().addTerminal()}>
        New terminal
        <Keys combo={shortcutFor("newTerminal", overrides)} className="on-primary" />
      </Button>
    </motion.div>
  );
}
