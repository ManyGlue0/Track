import { AnimatePresence, motion } from "framer-motion";
import { Check, Ban } from "lucide-react";
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { spring } from "../lib/motion";
import { COLOR_KEYS, COLOR_NAMES, swatch } from "../lib/palette";
import { keycaps } from "../lib/shortcuts";
import { useDark, useEscape, useStore } from "../lib/store";

// ---- buttons ----------------------------------------------------------------------

type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: "small" | "tiny" };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, active, size, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={`icon-btn ${size ?? ""} ${active ? "active" : ""} ${className ?? ""}`}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Button({
  variant = "default",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  return <button className={`btn btn-${variant} ${className ?? ""}`} {...rest} />;
}

/** A shortcut as menus show it: one quiet line, never wrapped ("Ctrl+Shift+C"). */
export function MenuKeys({ combo }: { combo: string }) {
  if (!combo) return null;
  return <span className="menu-keys">{combo}</span>;
}

export function Keys({ combo, className }: { combo: string; className?: string }) {
  const caps = keycaps(combo);
  if (!caps.length) return null;
  return (
    <span className={`keys ${className ?? ""}`}>
      {caps.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

// ---- popover ------------------------------------------------------------------------

export interface Anchor {
  x: number;
  y: number;
  /** Align the popover's right edge to x instead of its left edge. */
  alignRight?: boolean;
}

export function anchorFrom(el: Element, alignRight = false): Anchor {
  const r = el.getBoundingClientRect();
  return { x: alignRight ? r.right : r.left, y: r.bottom + 6, alignRight };
}

export function Popover({
  anchor,
  onClose,
  children,
  width,
  className,
}: {
  anchor: Anchor | null;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const close = useCallback(() => onClose(), [onClose]);
  useEscape(anchor !== null, close);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = anchor.alignRight ? anchor.x - w : anchor.x;
    let top = anchor.y;
    let origin = anchor.alignRight ? "top right" : "top left";
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    if (top + h > window.innerHeight - 8) {
      top = Math.max(8, anchor.y - h - 12);
      origin = origin.replace("top", "bottom");
    }
    setPos({ left, top, origin });
  }, [anchor, children]);

  useEffect(() => {
    if (!anchor) return;
    const down = (e: PointerEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      // A popover opened from this one (it comes later in the page) isn't "outside".
      const other = (e.target as Element).closest?.(".popover");
      if (other && ref.current.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) return;
      onClose();
    };
    const blur = () => onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("blur", blur);
    };
  }, [anchor, onClose]);

  return createPortal(
    <AnimatePresence>
      {anchor && (
        <motion.div
          ref={ref}
          className={`popover ${className ?? ""}`}
          style={{
            left: pos?.left ?? anchor.x,
            top: pos?.top ?? anchor.y,
            width,
            visibility: pos ? "visible" : "hidden",
            transformOrigin: pos?.origin,
          }}
          initial={{ opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -2, transition: { duration: 0.12 } }}
          transition={spring}
          onContextMenu={(e) => e.preventDefault()}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function MenuItem({
  icon,
  children,
  onSelect,
  danger,
  checked,
  disabled,
  trailing,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <button className={`menu-item ${danger ? "danger" : ""}`} onClick={onSelect} disabled={disabled}>
      <span className="menu-icon">{icon}</span>
      <span className="menu-label">{children}</span>
      {trailing && <span className="menu-hint">{trailing}</span>}
      {checked && <Check size={14} className="menu-check" />}
    </button>
  );
}

export const MenuSeparator = () => <div className="menu-sep" />;
export const MenuLabel = ({ children }: { children: React.ReactNode }) => <div className="menu-section">{children}</div>;

// ---- small controls --------------------------------------------------------------------

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)}>
      <motion.span className="toggle-knob" layout transition={spring} />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  id,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  id: string;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="segmented-pill" transition={spring} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A range slider drawn like the rest of Track (no native track or thumb). */
export function Slider({
  value,
  onChange,
  onCommit,
  label,
  min = 0,
  max = 1,
  step = 0.01,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="slider" style={{ "--pct": `${pct}%` } as React.CSSProperties}>
      <div className="slider-track">
        <div className="slider-fill" />
      </div>
      <div className="slider-thumb" />
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}

export function StatusDot({ color, size = 7 }: { color: string; size?: number }) {
  return <span className="status-dot" style={{ background: color, width: size, height: size }} />;
}

/** The ten pastels, plus "none" when `allowNone`. */
export function ColorSwatches({
  value,
  onChange,
  allowNone,
  layoutId = "swatch-ring",
}: {
  value: string | null;
  onChange: (c: string | null) => void;
  allowNone?: boolean;
  layoutId?: string;
}) {
  const dark = useDark();
  return (
    <div className={`swatches ${allowNone ? "with-none" : ""}`}>
      {allowNone && (
        <motion.button
          title="No color"
          aria-label="No color"
          className={`swatch none ${value === null ? "on" : ""}`}
          whileHover={{ scale: 1.12 }}
          whileTap={{ scale: 0.92 }}
          transition={spring}
          onClick={() => onChange(null)}
        >
          <Ban size={12} strokeWidth={2.2} />
          {value === null && <motion.span layoutId={layoutId} className="swatch-ring neutral" transition={spring} />}
        </motion.button>
      )}
      {COLOR_KEYS.map((c) => {
        const s = swatch(c, dark)!;
        return (
          <motion.button
            key={c}
            title={COLOR_NAMES[c]}
            aria-label={COLOR_NAMES[c]}
            className={`swatch ${value === c ? "on" : ""}`}
            style={{ background: s.bg, borderColor: s.strong }}
            whileHover={{ scale: 1.12 }}
            whileTap={{ scale: 0.92 }}
            transition={spring}
            onClick={() => onChange(c)}
          >
            {value === c && <motion.span layoutId={layoutId} className="swatch-ring" style={{ borderColor: s.strong }} transition={spring} />}
          </motion.button>
        );
      })}
    </div>
  );
}

// ---- toasts --------------------------------------------------------------------------------

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className="toast"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 500, damping: 36 }}
          >
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ---- modal sheet ---------------------------------------------------------------------------

/** A centered sheet over a scrim, rising like a card. Escape and the scrim close it. */
export function Modal({
  open,
  onClose,
  children,
  width = 460,
  className,
  style,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  useEscape(open, onClose);
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="modal-layer">
          <motion.div
            className="modal-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
            onPointerDown={onClose}
          />
          <motion.div
            className={`modal ${className ?? ""}`}
            style={{ width, ...style }}
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.985, transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 420, damping: 36 }}
            onContextMenu={(e) => {
              if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
            }}
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
