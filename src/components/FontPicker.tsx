import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { DEFAULT_FONT, fontStack } from "../lib/themes";
import { Popover, anchorFrom, type Anchor } from "./ui";

interface Font {
  name: string;
  mono: boolean;
}

let cache: Promise<Font[]> | null = null;
const loadFonts = () => (cache ??= api.listFonts().catch(() => []));

/** Pick the terminal font. Every name is drawn in its own face; monospaced
 *  fonts come first, "All fonts" shows the rest, and any typed name can be used. */
export function FontPicker({ value, onChange }: { value: string; onChange: (family: string) => void }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [fonts, setFonts] = useState<Font[]>([]);
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (anchor) {
      void loadFonts().then(setFonts);
      setQ("");
      setHi(0);
      setTimeout(() => input.current?.focus(), 30);
    }
  }, [anchor]);

  const current = value.trim() || DEFAULT_FONT;

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return fonts.filter((f) => (all || f.mono || needle) && (!needle || f.name.toLowerCase().includes(needle)));
  }, [fonts, q, all]);
  const typedIsNew = q.trim() && !fonts.some((f) => f.name.toLowerCase() === q.trim().toLowerCase());
  const options: { name: string; label?: string }[] = [
    ...(q.trim() ? [] : [{ name: "", label: `Default (${DEFAULT_FONT})` }]),
    ...shown.map((f) => ({ name: f.name })),
    ...(typedIsNew ? [{ name: q.trim(), label: `Use “${q.trim()}”` }] : []),
  ];

  const pick = (name: string) => {
    onChange(name);
    setAnchor(null);
  };

  useEffect(() => {
    listRef.current?.querySelector(".font-row.hi")?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  return (
    <>
      <button className="select font-select" onClick={(e) => setAnchor(anchor ? null : anchorFrom(e.currentTarget, true))}>
        <span style={{ fontFamily: fontStack(value) }}>{current}</span>
        <ChevronDown size={14} />
      </button>
      <Popover anchor={anchor} onClose={() => setAnchor(null)} width={300} className="font-pop">
        <label className="font-search">
          <Search size={14} />
          <input
            ref={input}
            value={q}
            placeholder="Search or type a font name"
            spellCheck={false}
            onChange={(e) => {
              setQ(e.target.value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((h) => Math.min(options.length - 1, h + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((h) => Math.max(0, h - 1));
              } else if (e.key === "Enter" && options[hi]) {
                e.preventDefault();
                pick(options[hi].name);
              }
            }}
          />
        </label>
        <div className="font-list" ref={listRef}>
          {options.map((o, i) => {
            // Exactly one check: the default row when nothing is chosen, else the chosen font.
            const on = !o.label?.startsWith("Use") && o.name === value.trim();
            return (
              <button
                key={`${o.label ?? ""}${o.name}`}
                className={`font-row ${i === hi ? "hi" : ""}`}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(o.name)}
              >
                <span className="font-name" style={{ fontFamily: fontStack(o.name) }}>
                  {o.label ?? o.name}
                </span>
                {on && <Check size={14} className="menu-check" />}
              </button>
            );
          })}
          {fonts.length > 0 && options.length === 0 && <div className="font-empty">No fonts match</div>}
        </div>
        <label className="font-all">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          <span className={`font-check ${all ? "on" : ""}`}>{all && <Check size={11} strokeWidth={3} />}</span>
          Show all fonts, not just monospaced
        </label>
      </Popover>
    </>
  );
}
