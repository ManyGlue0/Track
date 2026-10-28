import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

// No browser chrome: no default context menu, no zoom or reload shortcuts.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, [contenteditable=true]")) e.preventDefault();
});
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.shiftKey && ["p", "r", "f", "g", "j", "u", "s"].includes(e.key.toLowerCase()) && !(e.target as HTMLElement).classList?.contains("xterm-helper-textarea")) e.preventDefault();
  if (e.key === "F5" || e.key === "F3" || e.key === "F7" || (e.key === "F12" && !import.meta.env.DEV)) e.preventDefault();
});
window.addEventListener("wheel", (e) => e.ctrlKey && e.preventDefault(), { passive: false });

// Terminals hold live state (xterm instances, PTY channels): in dev, reload the
// page on every change instead of hot-swapping modules. Shells keep running in
// the backend and reattach with their recent output.
if (import.meta.hot) import.meta.hot.on("vite:beforeUpdate", () => location.reload());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
