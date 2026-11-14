// Builds the sidecar into one executable that needs no Node on the user's machine, with
// `bun build --compile`. Tauri bundles the result as an external binary named for the target triple.
//
//   node build.mjs [target-triple]   -> ../src-tauri/binaries/marq-sidecar-<triple>[.exe]
//
// Without an argument it builds for this machine. Bun cross-compiles, so any triple below can be
// built from any OS (for a universal macOS app, build both darwin triples and `lipo` them).

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binaries = join(here, "../src-tauri/binaries");

const TARGETS = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-arm64",
};

const triple =
  process.argv[2] ?? execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
const target = TARGETS[triple];
if (!target) throw new Error(`no bun target for ${triple}; known: ${Object.keys(TARGETS).join(", ")}`);

mkdirSync(binaries, { recursive: true });
const out = join(binaries, `marq-sidecar-${triple}${triple.includes("windows") ? ".exe" : ""}`);
execFileSync("bun", ["build", join(here, "main.ts"), "--compile", `--target=${target}`, "--outfile", out], {
  stdio: "inherit",
  cwd: here,
  shell: process.platform === "win32",
});
console.log(`built ${out}`);
