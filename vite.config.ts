import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    react(),
    // React Compiler memoizes components and hooks. `REACT_COMPILER_LOG=1` lists the ones it leaves as they are, and why.
    babel({
      presets: [reactCompilerPreset({
        logger: process.env.REACT_COMPILER_LOG
          ? {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              logEvent(file: string | null, e: any) {
                if (e.kind !== "CompileError" && e.kind !== "CompileSkip" && e.kind !== "PipelineError") return;
                const d = e.detail?.options ?? e.detail ?? {};
                const at = d.loc?.start?.line ?? d.details?.find((x: any) => x.loc)?.loc?.start?.line ?? e.fnLoc?.start?.line ?? "?"; // eslint-disable-line @typescript-eslint/no-explicit-any
                const why = e.reason ?? d.reason ?? String(e.detail);
                console.warn(`[react-compiler] ${file?.replace(/^.*\/src\//, "src/")}:${at} (fn at ${e.fnLoc?.start?.line ?? "?"}) ${why}`);
              },
            }
          : undefined,
      })],
    }),
    // `REACT_DEVTOOLS=1 pnpm tauri dev` connects to the standalone React DevTools (`npx react-devtools`).
    {
      name: "react-devtools",
      apply: "serve",
      transformIndexHtml: () =>
        process.env.REACT_DEVTOOLS ? [{ tag: "script", attrs: { src: "http://localhost:8097" }, injectTo: "head-prepend" }] : [],
    },
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
