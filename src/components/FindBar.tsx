import { motion } from "framer-motion";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { spring } from "../lib/motion";
import { useDark, useEscape, useStore } from "../lib/store";
import * as terms from "../lib/terms";
import { IconButton } from "./ui";

/** Find in a terminal's scrollback: every match highlighted, the current one
 *  stronger, a live count, Enter / Shift+Enter to step. */
export function FindBar({ id }: { id: string }) {
  const [q, setQ] = useState("");
  const [count, setCount] = useState<{ index: number; total: number } | null>(null);
  const [caseSensitive, setCase] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const dark = useDark();
  const addon = terms.searchAddon(id);

  const close = useCallback(() => {
    addon?.clearDecorations();
    useStore.setState({ finding: null });
    requestAnimationFrame(() => terms.focus(id));
  }, [addon, id]);
  useEscape(true, close);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  useEffect(() => {
    if (!addon) return;
    const sub = addon.onDidChangeResults((r) => setCount(r.resultCount > 0 ? { index: r.resultIndex, total: r.resultCount } : { index: -1, total: 0 }));
    return () => sub.dispose();
  }, [addon]);

  const decorations = dark
    ? { matchBackground: "#3B3550", matchOverviewRuler: "#B2A2F5", activeMatchBackground: "#7A68C8", activeMatchColorOverviewRuler: "#B2A2F5" }
    : { matchBackground: "#E4DEFA", matchOverviewRuler: "#8D79DF", activeMatchBackground: "#B9ACEF", activeMatchColorOverviewRuler: "#6B5BD2" };

  const find = (dir: 1 | -1, query = q, incremental = false) => {
    if (!addon) return;
    if (!query) {
      addon.clearDecorations();
      setCount(null);
      return;
    }
    const opts = { caseSensitive, incremental, decorations };
    if (dir === 1) addon.findNext(query, opts);
    else addon.findPrevious(query, opts);
  };

  return (
    <motion.div
      className="find-bar"
      initial={{ opacity: 0, y: -8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.1 } }}
      transition={spring}
      onPointerDownCapture={(e) => e.stopPropagation()}
    >
      <input
        ref={ref}
        value={q}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value);
          find(1, e.target.value, true);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") find(e.shiftKey ? -1 : 1);
        }}
      />
      <span className="find-count">
        {count === null ? "" : count.total === 0 ? "No results" : `${count.index + 1} of ${count.total}`}
      </span>
      <button
        className={`find-case ${caseSensitive ? "on" : ""}`}
        aria-label="Match case"
        title="Match case"
        onClick={() => {
          setCase((v) => !v);
          setTimeout(() => find(1, q, true));
        }}
      >
        Aa
      </button>
      <IconButton size="tiny" label="Previous match" onClick={() => find(-1)}>
        <ChevronUp size={14} />
      </IconButton>
      <IconButton size="tiny" label="Next match" onClick={() => find(1)}>
        <ChevronDown size={14} />
      </IconButton>
      <IconButton size="tiny" label="Close find" onClick={close}>
        <X size={14} />
      </IconButton>
    </motion.div>
  );
}
