import React from "react";
import ReactDOM from "react-dom/client";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
