set shell := ["bash", "-cu"]
set windows-shell := ["powershell.exe", "-NoProfile", "-Command"]

version := `node -p "require('./package.json').version"`
bundle := "src-tauri/target/release/bundle"

# List the tasks
default:
    @just --list

# ── Develop ───────────────────────────────────────────────

# Install dependencies (also installs sidecar/)
install:
    pnpm install

# Run the app from source (agent sessions work only in this mode)
dev:
    pnpm tauri dev

# Type check, clippy and Rust tests
check:
    pnpm check

# Check that the build tools are installed
doctor:
    #!/usr/bin/env bash
    ok=1
    for t in node pnpm cargo rustc just mdbook; do
        if command -v "$t" >/dev/null; then echo "ok       $t"; else echo "MISSING  $t"; ok=0; fi
    done
    [ "$ok" = 1 ]

# ── Demo ──────────────────────────────────────────────────

# Create the demo vault and sample project (default ~/marq-demo): just demo-setup [dest]
[unix]
demo-setup dest="~/marq-demo":
    examples/setup.sh "$(eval echo {{dest}})"

# Convert a screen recording into site/assets/demo.mp4 and demo.gif (needs ffmpeg and gifski)
[unix]
demo-media input:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p site/assets
    ffmpeg -y -i "{{input}}" -vf "fps=15,scale=1280:-2:flags=lanczos" -c:v libx264 -crf 24 -pix_fmt yuv420p -an -movflags +faststart site/assets/demo.mp4
    frames="$(mktemp -d)"
    ffmpeg -y -i "{{input}}" -vf "fps=12,scale=960:-2:flags=lanczos" "$frames/%04d.png"
    gifski --fps 12 --width 960 -o site/assets/demo.gif "$frames"/*.png
    ls -lh site/assets/demo.*

# ── Build the app ─────────────────────────────────────────
# Tauri does not cross-compile: run each recipe on its own OS.

# Build the agent sidecar into one executable (no Node needed on the user's machine)
sidecar:
    pnpm --dir sidecar build

# Build the default bundles for the current OS
build: sidecar
    pnpm tauri build --config src-tauri/tauri.bundle.conf.json

# macOS: .app and .dmg (this machine's architecture)
[macos]
build-macos: sidecar
    pnpm tauri build --config src-tauri/tauri.bundle.conf.json --bundles app,dmg

# macOS: a universal (arm64 + x86_64) .app and .dmg
[macos]
build-macos-universal:
    rustup target add aarch64-apple-darwin x86_64-apple-darwin
    pnpm tauri build --target universal-apple-darwin --bundles app,dmg

# Windows: NSIS installer (.exe) and .msi
[windows]
build-windows: sidecar
    pnpm tauri build --config src-tauri/tauri.bundle.conf.json --bundles nsis,msi

# Linux: .deb, .rpm and .AppImage
[linux]
build-linux: sidecar
    pnpm tauri build --config src-tauri/tauri.bundle.conf.json --bundles deb,rpm,appimage

# ── Distribute ────────────────────────────────────────────

# Build for this OS and gather the installers into dist-app/ with SHA256SUMS
[unix]
dist: build
    #!/usr/bin/env bash
    set -euo pipefail
    out=dist-app
    root=src-tauri/target
    [ -d "$root/universal-apple-darwin/release/bundle" ] && root=$root/universal-apple-darwin
    rm -rf "$out" && mkdir -p "$out"
    find "$root/release/bundle" -type f \( -name '*.dmg' -o -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) -exec cp {} "$out/" \;
    (cd "$out" && { shasum -a 256 * 2>/dev/null || sha256sum *; } > SHA256SUMS)
    ls -l "$out"

# Build for this OS and gather the installers into dist-app/ with SHA256SUMS
[windows]
dist: build
    New-Item -ItemType Directory -Force dist-app | Out-Null
    Remove-Item dist-app/* -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path "{{bundle}}" -Recurse -Include *.exe,*.msi | Where-Object { $_.FullName -match 'nsis|msi' } | Copy-Item -Destination dist-app
    Get-ChildItem dist-app -File | ForEach-Object { "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  $($_.Name)" } | Set-Content dist-app/SHA256SUMS

# Set the version in package.json, Cargo.toml and tauri.conf.json: just bump 0.2.0
bump new:
    node -e "const fs=require('fs');const v='{{new}}';const j=(f,m)=>{const t=JSON.parse(fs.readFileSync(f));m(t);fs.writeFileSync(f,JSON.stringify(t,null,2)+'\n')};j('package.json',t=>t.version=v);j('src-tauri/tauri.conf.json',t=>t.version=v);const c='src-tauri/Cargo.toml';fs.writeFileSync(c,fs.readFileSync(c,'utf8').replace(/^version = \".*\"/m,'version = \"'+v+'\"'))"
    cargo update --manifest-path src-tauri/Cargo.toml -p marq --offline
    @echo "version is now {{new}} (was {{version}})"

# ── Docs and site ─────────────────────────────────────────

# Build the book into site/book/
docs:
    mdbook build

# Serve the book with live reload
docs-serve:
    mdbook serve --open

# Build everything and serve the whole site (landing page + /book/) locally
site-serve: docs
    pnpm dlx serve site

# Build the site and upload it to Cloudflare Pages
deploy: docs
    pnpm dlx wrangler pages deploy site --project-name marq

# Remove build output
clean:
    rm -rf site/book dist dist-app
