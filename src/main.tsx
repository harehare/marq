import React from "react";
import ReactDOM from "react-dom/client";
import { openUrl } from "@tauri-apps/plugin-opener";
import App from "./App";

// Unhandled Escape would leave full screen on macOS.
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") e.preventDefault();
});

// Keep the selection on right click instead of selecting the word under it.
window.addEventListener("mousedown", (e) => {
  const secondary = e.button === 2 || (e.button === 0 && e.ctrlKey);
  if (secondary && !(e.target as Element).closest?.("input, textarea, .cm-editor")) e.preventDefault();
});

// Links to the web open in the default browser. Followed in the window, they would replace the app
// with no way back (the backend blocks that too, as a last resort).
const EXTERNAL = /^(https?:|mailto:)/i;
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0) return;
  const a = (e.target as Element).closest?.("a[href]");
  const href = a?.getAttribute("href");
  if (!href || !EXTERNAL.test(href)) return;
  e.preventDefault();
  openUrl(href).catch((err) => console.error("marq: could not open", href, err));
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
