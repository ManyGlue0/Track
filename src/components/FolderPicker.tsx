import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronRight,
  Clock,
  CornerDownLeft,
  Download,
  Eye,
  EyeOff,
  FileText,
  Folder as FolderIcon,
  FolderGit2,
  FolderPlus,
  GitBranch,
  HardDrive,
  House,
  Monitor,
  Network,
  Pin,
  PinOff,
  Usb,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type Drive, type Folder, type Place } from "../lib/api";
import { spring } from "../lib/motion";
import { useStore, type FolderRequest } from "../lib/store";
import { Modal } from "./ui";

// ---- paths ------------------------------------------------------------------------------------

function trimSlash(p: string): string {
  if (/^[A-Za-z]:\\?$/.test(p)) return p.slice(0, 2).toUpperCase() + "\\";
  return p.replace(/[\\/]+$/, "");
}

/** `E:\a\b` → [`E:\`, `E:\a`, `E:\a\b`] (UNC shares work the same way). */
function chain(path: string): string[] {
  const p = trimSlash(path);
  let root: string;
  let rest: string[];
  if (p.startsWith("\\\\")) {
    const parts = p.slice(2).split("\\").filter(Boolean);
    if (parts.length < 2) return [p];
    root = `\\\\${parts[0]}\\${parts[1]}\\`;
    rest = parts.slice(2);
  } else {
    const parts = p.split("\\").filter(Boolean);
    root = (parts[0] ?? "C:").toUpperCase() + "\\";
    rest = parts.slice(1);
  }
  const out = [root];
  for (const part of rest) out.push(join(out[out.length - 1], part));
  return out;
}

function join(dir: string, name: string): string {
  return dir.endsWith("\\") ? dir + name : `${dir}\\${name}`;
}

function same(a: string, b: string): boolean {
  return trimSlash(a).toLowerCase() === trimSlash(b).toLowerCase();
}

function baseName(p: string): string {
  const c = trimSlash(p);
  if (c.endsWith("\\")) return c;
  return c.slice(c.lastIndexOf("\\") + 1);
}

// ---- picker -------------------------------------------------------------------------------------

type Listing = { loading: true } | { items: Folder[] } | { error: string };

const PLACE_ICONS: Record<string, React.ReactNode> = {
  home: <House size={15} />,
  desktop: <Monitor size={15} />,
  documents: <FileText size={15} />,
  downloads: <Download size={15} />,
};

export function FolderPicker() {
  const request = useStore((s) => s.folderRequest);
  // Keep showing the last request while the sheet animates away.
  const last = useRef<FolderRequest | null>(null);
  if (request) last.current = request;
  const shown = request ?? last.current;
  return (
    <Modal open={!!request} onClose={() => request?.resolve(null)} width={860} className="picker-modal">
      {shown && <PickerBody key={shown.title + (shown.initial ?? "")} request={shown} />}
    </Modal>
  );
}

function PickerBody({ request }: { request: FolderRequest }) {
  const settings = useStore((s) => s.settings);
  const [places, setPlaces] = useState<Place[]>([]);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [projects, setProjects] = useState<Folder[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [hidden, setHidden] = useState(false);
  const [gitOf, setGitOf] = useState<Record<string, string | null>>({});
  /** "New folder" is being named, inside the selected folder. */
  const [creating, setCreating] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const pathInput = useRef<HTMLInputElement>(null);

  // First paint: places, drives, projects; start where asked, else where you were last.
  useEffect(() => {
    let dead = false;
    Promise.all([api.fsPlaces(), api.fsDrives()]).then(async ([pl, dr]) => {
      if (dead) return;
      setPlaces(pl);
      setDrives(dr);
      const candidates = [request.initial, settings?.recentFolders[0], pl[0]?.path].filter(Boolean) as string[];
      for (const c of candidates) {
        const info = await api.fsInfo(c).catch(() => null);
        if (info?.exists) {
          if (!dead) setPath(trimSlash(info.path));
          return;
        }
      }
      if (!dead) setPath(dr[0]?.path ?? "C:\\");
    });
    api.fsProjects().then((p) => !dead && setProjects(p)).catch(() => {});
    return () => {
      dead = true;
    };
  }, [request.initial, settings?.recentFolders]);

  const load = useCallback(
    (dir: string, force = false) => {
      const key = `${hidden ? "h" : ""}${dir.toLowerCase()}`;
      if (!force && listings[key]) return;
      setListings((l) => ({ ...l, [key]: l[key] ?? { loading: true } }));
      api
        .fsList(dir, hidden)
        .then((items) => {
          setListings((l) => ({ ...l, [key]: { items } }));
          setGitOf((g) => {
            const next = { ...g };
            for (const f of items) next[f.path.toLowerCase()] = f.git;
            return next;
          });
        })
        .catch((e) => setListings((l) => ({ ...l, [key]: { error: String(e) } })));
    },
    [hidden, listings],
  );

  const dirs = useMemo(() => (path ? chain(path) : []), [path]);
  useEffect(() => {
    for (const d of dirs) load(d);
  }, [dirs, load]);

  const listing = (dir: string): Listing | undefined => listings[`${hidden ? "h" : ""}${dir.toLowerCase()}`];

  // Columns are sized so a whole number of them fills the area; going deeper
  // slides by exactly one column, never leaving one cut in half.
  const [areaW, setAreaW] = useState(0);
  useLayoutEffect(() => {
    const el = columnsRef.current!;
    const ro = new ResizeObserver(() => setAreaW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const perView = Math.max(1, Math.floor(areaW / 210));
  const colW = areaW ? areaW / perView : 238;
  useLayoutEffect(() => {
    const el = columnsRef.current;
    if (!el) return;
    // After the columns (and any leaving ones) have laid out.
    const raf = requestAnimationFrame(() =>
      el.scrollTo({ left: Math.max(0, dirs.length - perView) * colW, behavior: "smooth" }),
    );
    return () => cancelAnimationFrame(raf);
  }, [dirs, perView, colW, listings]);

  const choose = useCallback(
    async (p: string | null) => {
      if (!p) return;
      const s = await api.noteRecent(p).catch(() => null);
      if (s) useStore.setState({ settings: s });
      request.resolve(trimSlash(p));
    },
    [request],
  );

  const pinned = (settings?.pinnedFolders ?? []).some((f) => path && same(f, path));
  const togglePin = () => {
    if (!path || !settings) return;
    const next = pinned ? settings.pinnedFolders.filter((f) => !same(f, path)) : [...settings.pinnedFolders, trimSlash(path)];
    void useStore.getState().updateSettings({ pinnedFolders: next });
  };

  // ---- keyboard ----
  const siblingsOf = (p: string): Folder[] => {
    const c = chain(p);
    if (c.length < 2) return [];
    const l = listing(c[c.length - 2]);
    return l && "items" in l ? l.items : [];
  };
  const childrenOf = (p: string): Folder[] => {
    const l = listing(p);
    return l && "items" in l ? l.items : [];
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!path || (e.target as HTMLElement).tagName === "INPUT") return;
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      setCreating(true);
      return;
    }
    const sibs = siblingsOf(path);
    const i = sibs.findIndex((f) => same(f.path, path));
    const move = (to: Folder | undefined) => {
      if (to) {
        e.preventDefault();
        setPath(to.path);
      }
    };
    if (e.key === "ArrowDown") {
      if (dirs.length < 2) move(childrenOf(path)[0]);
      else move(sibs[Math.min(sibs.length - 1, i + 1)]);
    } else if (e.key === "ArrowUp") {
      move(sibs[Math.max(0, i - 1)]);
    } else if (e.key === "ArrowRight") {
      move(childrenOf(path)[0]);
    } else if (e.key === "ArrowLeft") {
      if (dirs.length > 1) {
        e.preventDefault();
        setPath(dirs[dirs.length - 2]);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      void choose(path);
    } else if ((e.ctrlKey && e.key.toLowerCase() === "l") || e.key === "/") {
      e.preventDefault();
      pathInput.current?.focus();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
      // Type-ahead within the current column.
      const now = Date.now();
      const t = typeahead.current;
      t.text = now - t.at < 700 ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
      t.at = now;
      const pool = dirs.length < 2 ? childrenOf(path) : sibs;
      move(pool.find((f) => f.name.toLowerCase().startsWith(t.text)));
    }
  };

  const recents = (settings?.recentFolders ?? []).slice(0, 6);
  const pins = settings?.pinnedFolders ?? [];
  const git = path ? gitOf[trimSlash(path).toLowerCase()] : null;

  return (
    <div className="picker" tabIndex={-1} onKeyDown={onKey} autoFocus ref={(el) => el?.focus({ preventScroll: true })}>
      <div className="picker-head">
        <div className="picker-title">{request.title}</div>
        <button className="picker-hidden" onClick={() => setCreating(true)} disabled={!path} title="New folder (Ctrl+Shift+N)">
          <FolderPlus size={14} />
          <span>New folder</span>
        </button>
        <button
          className={`picker-hidden ${hidden ? "on" : ""}`}
          onClick={() => setHidden((h) => !h)}
          aria-pressed={hidden}
          title={hidden ? "Hide hidden folders" : "Show hidden folders"}
        >
          {hidden ? <Eye size={14} /> : <EyeOff size={14} />}
          <span>Hidden</span>
        </button>
      </div>
      <PathBar inputRef={pathInput} path={path} onGo={(p) => setPath(trimSlash(p))} onChoose={(p) => void choose(p)} />

      <div className="picker-main">
        <aside className="picker-side">
          {pins.length > 0 && (
            <SideSection title="Pinned">
              {pins.map((p) => (
                <SideItem key={p} icon={<Pin size={14} />} label={baseName(p)} hint={p} on={!!path && same(p, path)} onClick={() => setPath(p)} />
              ))}
            </SideSection>
          )}
          {recents.length > 0 && (
            <SideSection title="Recent">
              {recents.map((p) => (
                <SideItem key={p} icon={<Clock size={14} />} label={baseName(p)} hint={p} on={!!path && same(p, path)} onClick={() => setPath(p)} />
              ))}
            </SideSection>
          )}
          {projects.length > 0 && (
            <SideSection title="Projects">
              {projects.slice(0, 12).map((f) => (
                <SideItem
                  key={f.path}
                  icon={<FolderGit2 size={14} />}
                  label={f.name}
                  hint={f.path}
                  on={!!path && same(f.path, path)}
                  onClick={() => setPath(f.path)}
                />
              ))}
            </SideSection>
          )}
          <SideSection title="Places">
            {places.map((p) => (
              <SideItem key={p.id} icon={PLACE_ICONS[p.id]} label={p.name} hint={p.path} on={!!path && same(p.path, path)} onClick={() => setPath(p.path)} />
            ))}
          </SideSection>
          <SideSection title="Drives">
            {drives.map((d) => (
              <SideItem
                key={d.letter}
                icon={d.kind === "removable" ? <Usb size={14} /> : d.kind === "network" ? <Network size={14} /> : <HardDrive size={14} />}
                label={`${d.label} (${d.letter}:)`}
                hint={d.path}
                on={!!path && same(d.path, path)}
                onClick={() => setPath(d.path)}
              />
            ))}
          </SideSection>
        </aside>

        <div className="picker-columns" ref={columnsRef}>
          <AnimatePresence initial={false}>
            {dirs.map((dir, ci) => {
              const l = listing(dir);
              const selected = dirs[ci + 1];
              return (
                <motion.div
                  key={dir.toLowerCase()}
                  className="picker-col"
                  style={{ width: colW }}
                  initial={{ opacity: 0, x: 14 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0 } }}
                  transition={spring}
                >
                  {creating && path && same(dir, path) && (
                    <NewFolderRow
                      parent={path}
                      taken={l && "items" in l ? l.items.map((f) => f.name) : []}
                      onDone={(created) => {
                        setCreating(false);
                        if (created) {
                          load(path, true);
                          setPath(created);
                        }
                      }}
                    />
                  )}
                  {!l || "loading" in l ? (
                    <Skeleton />
                  ) : "error" in l ? (
                    <div className="picker-note">{l.error}</div>
                  ) : l.items.length === 0 ? (
                    <div className="picker-note">No folders inside</div>
                  ) : (
                    l.items.map((f) => {
                      const on = !!selected && same(f.path, selected);
                      return (
                        <button
                          key={f.path}
                          className={`picker-row ${on ? "on" : ""} ${on && ci === dirs.length - 2 ? "current" : ""} ${f.hidden ? "is-hidden" : ""}`}
                          onClick={() => setPath(f.path)}
                          onDoubleClick={() => void choose(f.path)}
                          ref={(el) => {
                            if (on && el) el.scrollIntoView({ block: "nearest" });
                          }}
                        >
                          {f.git ? <FolderGit2 size={15} className="picker-row-icon git" /> : <FolderIcon size={15} className="picker-row-icon" />}
                          <span className="picker-row-name">{f.name}</span>
                          {f.git && (
                            <span className="branch">
                              <GitBranch size={11} />
                              {f.git}
                            </span>
                          )}
                          <ChevronRight size={13} className="picker-row-chev" />
                        </button>
                      );
                    })
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      <div className="picker-foot">
        <div className="picker-sel">
          {path && (
            <>
              {git ? <FolderGit2 size={16} className="picker-sel-icon git" /> : <FolderIcon size={16} className="picker-sel-icon" />}
              <span className="picker-sel-path">{path}</span>
              {git && (
                <span className="branch">
                  <GitBranch size={11} />
                  {git}
                </span>
              )}
            </>
          )}
        </div>
        <button className={`btn btn-ghost pin-toggle ${pinned ? "on" : ""}`} onClick={togglePin} disabled={!path}>
          {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          {pinned ? "Unpin" : "Pin"}
        </button>
        <button className="btn btn-ghost" onClick={() => request.resolve(null)}>
          Cancel
        </button>
        <motion.button className="btn btn-primary" disabled={!path} onClick={() => void choose(path)} whileTap={{ scale: 0.96 }} transition={spring}>
          Select
          <span className="keycap" aria-hidden>
            <CornerDownLeft size={11} strokeWidth={2.4} />
          </span>
        </motion.button>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="picker-skeleton">
      {[72, 54, 64, 46].map((w, i) => (
        <span key={i} style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function SideSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="side-section">
      <div className="side-title">{title}</div>
      {children}
    </div>
  );
}

function SideItem({ icon, label, hint, on, onClick }: { icon: React.ReactNode; label: string; hint: string; on: boolean; onClick: () => void }) {
  return (
    <button className={`side-item ${on ? "on" : ""}`} onClick={onClick} data-hint={hint}>
      <span className="side-icon">{icon}</span>
      <span className="side-label">{label}</span>
    </button>
  );
}

/** Type a path; suggestions complete it. Enter goes there, Tab completes. */
function PathBar({
  path,
  onGo,
  onChoose,
  inputRef,
}: {
  path: string | null;
  onGo: (p: string) => void;
  onChoose: (p: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [text, setText] = useState<string | null>(null);
  const [hints, setHints] = useState<Folder[]>([]);
  const [hi, setHi] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const editing = text !== null;

  useEffect(() => {
    if (text === null) {
      setHints([]);
      return;
    }
    const t = setTimeout(() => {
      api.fsComplete(text).then((h) => {
        setHints(h);
        setHi(-1);
      });
    }, 70);
    return () => clearTimeout(t);
  }, [text]);

  const go = async (value: string, choose = false) => {
    const info = await api.fsInfo(value).catch(() => null);
    if (info?.exists) {
      setText(null);
      setError(null);
      onGo(info.path);
      if (choose) onChoose(info.path);
      return;
    }
    setError("No folder at that path");
    setTimeout(() => setError(null), 1800);
  };

  return (
    <div className={`pathbar ${error ? "error" : ""}`}>
      <ChevronRight size={14} className="pathbar-caret" />
      <input
        ref={inputRef}
        value={editing ? text : (path ?? "")}
        spellCheck={false}
        placeholder="Type a path, like E:\Projects"
        onFocus={(e) => {
          setText(path ?? "");
          requestAnimationFrame(() => e.target.select());
        }}
        onBlur={() => setTimeout(() => setText(null), 120)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => Math.min(hints.length - 1, h + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(-1, h - 1));
          } else if (e.key === "Tab" && hints.length) {
            e.preventDefault();
            setText(join(hints[Math.max(0, hi)].path, ""));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const target = hi >= 0 ? hints[hi].path : (text ?? "");
            void go(target, e.ctrlKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setText(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <AnimatePresence>
        {error && (
          <motion.span className="pathbar-error" initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
            {error}
          </motion.span>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {editing && hints.length > 0 && (
          <motion.div
            className="pathbar-hints"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -2, transition: { duration: 0.1 } }}
            transition={spring}
          >
            {hints.map((h, i) => (
              <button
                key={h.path}
                className={`pathbar-hint ${i === hi ? "on" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void go(h.path);
                }}
              >
                {h.git ? <FolderGit2 size={14} className="git" /> : <FolderIcon size={14} />}
                <span>{h.path}</span>
                {h.git && (
                  <span className="branch">
                    <GitBranch size={11} />
                    {h.git}
                  </span>
                )}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The name field for a new folder, at the top of the folder it goes in. */
function NewFolderRow({ parent, taken, onDone }: { parent: string; taken: string[]; onDone: (created: string | null) => void }) {
  const initial = useMemo(() => {
    const lower = new Set(taken.map((t) => t.toLowerCase()));
    if (!lower.has("new folder")) return "New folder";
    let n = 2;
    while (lower.has(`new folder (${n})`)) n++;
    return `New folder (${n})`;
  }, [taken]);
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const f = await api.fsCreateDir(parent, name);
      onDone(f.path);
    } catch (e) {
      setError(String(e));
      setBusy(false);
      ref.current?.focus();
    }
  };
  return (
    <motion.div className="picker-new" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <div className={`picker-row editing ${error ? "error" : ""}`}>
        <FolderPlus size={15} className="picker-row-icon" />
        <input
          ref={ref}
          value={name}
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onDone(null);
            }
          }}
          onBlur={() => {
            if (!busy && !error) onDone(null);
          }}
        />
      </div>
      {error && <div className="picker-new-error">{error}</div>}
    </motion.div>
  );
}
