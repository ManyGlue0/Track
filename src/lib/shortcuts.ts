/** Keyboard shortcuts. Windows Terminal conventions (Ctrl+Shift+…) so nothing
 *  collides with what shells and TUIs use (Ctrl+W, Ctrl+T, Ctrl+N…). */

export type ActionId =
  | "newTerminal"
  | "duplicateTerminal"
  | "closeTerminal"
  | "newScreen"
  | "editScreen"
  | "nextScreen"
  | "prevScreen"
  | "focusLeft"
  | "focusRight"
  | "focusUp"
  | "focusDown"
  | "popOut"
  | "find"
  | "rename"
  | "copy"
  | "paste"
  | "fontUp"
  | "fontDown"
  | "fontReset"
  | "settings";

export interface ActionDef {
  id: ActionId;
  label: string;
  group: "Terminals" | "Screens" | "Editing" | "View";
  default: string;
}

export const ACTIONS: ActionDef[] = [
  { id: "newTerminal", label: "New terminal", group: "Terminals", default: "Ctrl+Shift+N" },
  { id: "duplicateTerminal", label: "Duplicate terminal", group: "Terminals", default: "Ctrl+Shift+D" },
  { id: "closeTerminal", label: "Close terminal", group: "Terminals", default: "Ctrl+Shift+W" },
  { id: "popOut", label: "Pop out terminal", group: "Terminals", default: "Ctrl+Shift+Enter" },
  { id: "rename", label: "Rename terminal", group: "Terminals", default: "F2" },
  { id: "focusLeft", label: "Focus terminal left", group: "Terminals", default: "Alt+Left" },
  { id: "focusRight", label: "Focus terminal right", group: "Terminals", default: "Alt+Right" },
  { id: "focusUp", label: "Focus terminal above", group: "Terminals", default: "Alt+Up" },
  { id: "focusDown", label: "Focus terminal below", group: "Terminals", default: "Alt+Down" },
  { id: "newScreen", label: "New screen", group: "Screens", default: "Ctrl+Shift+T" },
  { id: "editScreen", label: "Edit screen", group: "Screens", default: "Ctrl+Shift+E" },
  { id: "nextScreen", label: "Next screen", group: "Screens", default: "Ctrl+Tab" },
  { id: "prevScreen", label: "Previous screen", group: "Screens", default: "Ctrl+Shift+Tab" },
  { id: "copy", label: "Copy", group: "Editing", default: "Ctrl+Shift+C" },
  { id: "paste", label: "Paste", group: "Editing", default: "Ctrl+Shift+V" },
  { id: "find", label: "Find", group: "Editing", default: "Ctrl+Shift+F" },
  { id: "fontUp", label: "Bigger text", group: "View", default: "Ctrl+=" },
  { id: "fontDown", label: "Smaller text", group: "View", default: "Ctrl+-" },
  { id: "fontReset", label: "Reset text size", group: "View", default: "Ctrl+0" },
  { id: "settings", label: "Settings", group: "View", default: "Ctrl+," },
];

const CODE_KEYS: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  NumpadAdd: "=",
  NumpadSubtract: "-",
  NumpadEnter: "Enter",
};

/** The key part of an accelerator, layout-independent where it matters. */
export function keyName(e: KeyboardEvent): string | null {
  const { code, key } = e;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad") && /\d$/.test(code)) return code.slice(6);
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  if (/^F\d{1,2}$/.test(key)) return key;
  if (key === " ") return "Space";
  if (["Tab", "Enter", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown"].includes(key)) return key;
  return key.length === 1 ? key.toUpperCase() : key;
}

export function accelerator(e: KeyboardEvent): string | null {
  const k = keyName(e);
  if (!k) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  return [...mods, k].join("+");
}

export function bindings(overrides: Record<string, string>): Map<string, ActionId> {
  const map = new Map<string, ActionId>();
  for (const a of ACTIONS) {
    const acc = overrides[a.id] ?? a.default;
    if (acc) map.set(acc, a.id);
  }
  return map;
}

export function shortcutFor(id: ActionId, overrides: Record<string, string>): string {
  return overrides[id] ?? ACTIONS.find((a) => a.id === id)?.default ?? "";
}

/** "Ctrl+Shift+N" → ["Ctrl", "Shift", "N"] for keycaps. */
export function keycaps(acc: string): string[] {
  if (!acc) return [];
  // "Ctrl++" style: a trailing plus is the key.
  const parts = acc.split("+");
  return parts.map((p, i) => (p === "" && i === parts.length - 1 ? "+" : p)).filter(Boolean);
}
