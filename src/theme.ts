import { useEffect, useState } from "react";

export type Palette = "tarn" | "amber" | "nord" | "solarized" | "rose-pine";
type Mode = "system" | "light" | "dark";
export type Theme = { palette: Palette; mode: Mode };

export const PALETTES: { key: Palette; label: string }[] = [
  { key: "tarn", label: "Tarn" },
  { key: "amber", label: "Amber" },
  { key: "nord", label: "Nord" },
  { key: "solarized", label: "Solarized" },
  { key: "rose-pine", label: "Rosé Pine" },
];

const THEME_KEY = "marq.theme";

function load(): Theme {
  try {
    const v = JSON.parse(localStorage.getItem(THEME_KEY) ?? "null");
    if (v && PALETTES.some((p) => p.key === v.palette) && ["system", "light", "dark"].includes(v.mode)) return v;
  } catch {}
  return { palette: "tarn", mode: "system" };
}

/** Sets data-palette / data-theme on <html>. */
function apply({ palette, mode }: Theme) {
  const root = document.documentElement;
  root.dataset.palette = palette;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = mode;
}

// Before the first render, to avoid a flash.
apply(load());

const picked = () => {
  try {
    return localStorage.getItem(THEME_KEY) !== null;
  } catch {
    return false;
  }
};

/** [theme, pick (saved), fromConfig (used only until something is picked)]. */
export function useTheme() {
  const [theme, setTheme] = useState(load);
  useEffect(() => apply(theme), [theme]);
  const pick = (t: Theme) => {
    setTheme(t);
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(t));
    } catch {}
  };
  const fromConfig = (palette?: string, mode?: string) => {
    if (picked()) return;
    setTheme((t) => ({
      palette: PALETTES.some((p) => p.key === palette) ? (palette as Palette) : t.palette,
      mode: ["system", "light", "dark"].includes(mode ?? "") ? (mode as Mode) : t.mode,
    }));
  };
  return [theme, pick, fromConfig] as const;
}
