import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Changes whenever the palette or light/dark mode does, so diagrams are drawn again in the new colors. */
function subscribeTheme(notify: () => void) {
  const mo = new MutationObserver(notify);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
  const mq = matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", notify);
  return () => {
    mo.disconnect();
    mq.removeEventListener("change", notify);
  };
}
const themeKey = () => {
  const { theme = "", palette = "" } = document.documentElement.dataset;
  return `${palette}/${theme}/${matchMedia("(prefers-color-scheme: dark)").matches}`;
};

/** Mermaid's "base" theme, colored from the app's CSS variables. */
function themeVariables() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    darkMode: css.colorScheme === "dark",
    fontFamily: v("--font"),
    fontSize: "13px",
    background: v("--bg"),
    primaryColor: v("--bg-raised"),
    primaryTextColor: v("--fg"),
    primaryBorderColor: v("--border-strong"),
    secondaryColor: v("--accent-soft"),
    tertiaryColor: v("--bg-sunken"),
    lineColor: v("--muted"),
    edgeLabelBackground: v("--bg"),
    textColor: v("--fg"),
    noteBkgColor: v("--accent-soft"),
    noteTextColor: v("--fg"),
    noteBorderColor: v("--border-strong"),
  };
}

let seq = 0;

/** Draws the diagram; mermaid is loaded on first use, so notes without diagrams do not pay for it. */
async function draw(code: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  // Notes and agent-written documents are not trusted: "strict" keeps scripts and click handlers out.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: themeVariables(),
  });
  return (await mermaid.render(`marq-mermaid-${seq++}`, code)).svg;
}

type State = { svg?: string; error?: string };

const SHADOW_CSS = "<style>:host{display:block;overflow-x:auto;text-align:center}svg{max-width:100%;height:auto}</style>";

/** A `mermaid` code block as a diagram. While the source does not parse, it shows the last good diagram and the error. */
export const Mermaid = memo(function Mermaid({ code }: { code: string }) {
  const theme = useSyncExternalStore(subscribeTheme, themeKey);
  const [state, setState] = useState<State>({});

  useEffect(() => {
    let stale = false;
    draw(code).then(
      (svg) => !stale && setState({ svg }),
      (e: unknown) => !stale && setState((s) => ({ svg: s.svg, error: e instanceof Error ? e.message : String(e) })),
    );
    return () => {
      stale = true;
    };
  }, [code, theme]);

  // In a shadow root: mermaid's class names (.note, .node, .label, .active…) are common words, and the
  // app's own rules for them would otherwise restyle parts of the diagram.
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    (el.shadowRoot ?? el.attachShadow({ mode: "open" })).innerHTML = state.svg ? SHADOW_CSS + state.svg : "";
  }, [state.svg]);

  return (
    <div className="mermaid-block">
      <div ref={host} />
      {state.error && (
        <>
          <div className="mermaid-error">{state.error}</div>
          {!state.svg && <pre>{code}</pre>}
        </>
      )}
    </div>
  );
});
