# Building and distribution

Marq is a [Tauri 2](https://tauri.app) app. Tasks are collected in the `justfile`; run `just` to list them.

> [!WARNING]
> Release builds do not bundle the Node sidecar yet, so a bundled app cannot run agent sessions. Until it is bundled, use `just dev` to run sessions.

## Requirements

Everywhere: Rust (stable), Node.js, [pnpm](https://pnpm.io), [just](https://just.systems) and, for the docs, [mdBook](https://rust-lang.github.io/mdBook/).

| OS | Extra requirements |
| --- | --- |
| macOS | Xcode command line tools. Add the other architecture with `rustup target add x86_64-apple-darwin` for a universal build. |
| Windows | Visual Studio Build Tools (C++ workload) and WebView2 (preinstalled on Windows 11). |
| Linux | `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf` and a C toolchain (`build-essential`), plus `rpm` for `.rpm` bundles. |

Marq links libgit2 statically and pushes with the `git` command, so it needs no OpenSSL or libssh2 to build. At run time `git` must be installed (and `gh` to create pull requests).

`just doctor` checks that the tools are on your `PATH`.

## Build

Tauri does not cross-compile desktop bundles: build each OS on that OS (a CI matrix is the usual way).

| OS | Command | Output (`src-tauri/target/release/bundle/`) |
| --- | --- | --- |
| macOS | `just build-macos` | `dmg/*.dmg`, `macos/Marq.app` |
| macOS (universal) | `just build-macos-universal` | `target/universal-apple-darwin/release/bundle/` |
| Windows | `just build-windows` | `nsis/*-setup.exe`, `msi/*.msi` |
| Linux | `just build-linux` | `deb/*.deb`, `rpm/*.rpm`, `appimage/*.AppImage` |
| This OS | `just build` | The default bundles for the OS you are on |

`just dist` runs the build for the current OS and copies the installers into `dist-app/` with the version in their names, and writes `SHA256SUMS`, ready to attach to a GitHub release.

## Distribution

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` (`just bump 0.2.0` does all three).
2. Build on each OS and collect the files with `just dist`.
3. Upload the files and `SHA256SUMS` to a GitHub release.

Unsigned builds work, but the OS warns about them:

- **macOS**: sign with a Developer ID certificate and notarize, or Gatekeeper blocks the app. Tauri signs and notarizes when `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` are set. Without them, users can open the app with right-click → Open.
- **Windows**: SmartScreen warns about unsigned installers until the app builds reputation. Sign with a code signing certificate (`bundle.windows.certificateThumbprint` in `tauri.conf.json`).
- **Linux**: no signing needed. The AppImage runs anywhere with a recent glibc, so build on the oldest distribution you support.

Possible later steps: Homebrew cask (macOS), winget (Windows), and the Tauri updater plugin for in-app updates.

## Documentation and site

The site has two parts that deploy together to Cloudflare Pages:

- `site/` is the landing page (`site/index.html`).
- `docs/` is this book. `book.toml` builds it into `site/book/`, which is served at `/book/`.

| Command | Does |
| --- | --- |
| `just docs` | Build the book into `site/book/` |
| `just docs-serve` | Serve the book with live reload |
| `just site-serve` | Build the book and serve the whole site locally |
| `just deploy` | Build the book and upload `site/` to Cloudflare Pages with `wrangler pages deploy` |

Run `pnpm dlx wrangler login` once before the first `just deploy`. The Pages project is named `marq` (see `wrangler.jsonc`).
