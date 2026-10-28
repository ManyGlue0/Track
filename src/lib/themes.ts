import type { ITheme } from "@xterm/xterm";

/** Terminal colors tuned to sit on Track's frosted cells: pastel in the dark,
 *  inked in the light, every ANSI color readable on its own background. The
 *  background is fully transparent (alpha 00) so the cell's material shows
 *  through, but keeps the cell's real tone in its RGB: xterm measures text
 *  contrast against it. */

const DARK: ITheme = {
  background: "#17171B00",
  foreground: "#E6E6EC",
  cursor: "#B2A2F5",
  cursorAccent: "#17171B",
  selectionBackground: "rgba(165, 150, 245, 0.34)",
  selectionInactiveBackground: "rgba(165, 150, 245, 0.18)",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.20)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.32)",
  scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.42)",
  black: "#3A3A44",
  red: "#F0798A",
  green: "#7AD6AF",
  yellow: "#EACA68",
  blue: "#89BCF2",
  magenta: "#D19EE1",
  cyan: "#7FD3D8",
  white: "#D4D4DC",
  brightBlack: "#6E6E7A",
  brightRed: "#F59CAA",
  brightGreen: "#9BE3C4",
  brightYellow: "#F2D98C",
  brightBlue: "#A9CEF6",
  brightMagenta: "#DEB6EA",
  brightCyan: "#A3E2E6",
  brightWhite: "#F6F6F9",
};

const LIGHT: ITheme = {
  background: "#F3F3F600",
  foreground: "#1F1F26",
  cursor: "#6B5BD2",
  cursorAccent: "#FFFFFF",
  selectionBackground: "rgba(107, 91, 210, 0.22)",
  selectionInactiveBackground: "rgba(107, 91, 210, 0.12)",
  scrollbarSliderBackground: "rgba(20, 20, 40, 0.20)",
  scrollbarSliderHoverBackground: "rgba(20, 20, 40, 0.32)",
  scrollbarSliderActiveBackground: "rgba(20, 20, 40, 0.42)",
  black: "#2E2E38",
  red: "#C93C55",
  green: "#2B8A63",
  yellow: "#9E750C",
  blue: "#336CBB",
  magenta: "#904CA8",
  cyan: "#1C8590",
  white: "#7D7D88",
  brightBlack: "#62626E",
  brightRed: "#DC566D",
  brightGreen: "#37A378",
  brightYellow: "#B88E1C",
  brightBlue: "#4F8AD6",
  brightMagenta: "#AA66C2",
  brightCyan: "#2CA0AA",
  brightWhite: "#A2A2AC",
};

export function terminalTheme(dark: boolean): ITheme {
  return dark ? DARK : LIGHT;
}

export const FONT_FAMILY = '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace';
export const DEFAULT_FONT = "Cascadia Mono";

/** The CSS font stack for a chosen family (falls back to Track's default). */
export function fontStack(family: string | undefined | null): string {
  const f = family?.trim();
  return f ? `"${f.replace(/"/g, "")}", ${FONT_FAMILY}` : FONT_FAMILY;
}
