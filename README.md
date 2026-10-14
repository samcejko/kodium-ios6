# Kodium

A code editor for jailbroken iOS 6: the VS Code workbench on an iPad 2, running on the device itself.

**Status: early.** The workbench starts (explorer, editor tabs, search, the command palette, settings, keybindings,
themes), edits files with syntax highlighting for 31 languages, and speaks English or Czech; it has been checked in a
desktop browser with the same ES5 code the app ships, not yet on a device. Files live in memory for now, and
extensions are the next big step (see the plan below).

## How it works

- **The workbench** is VS Code's own (Code - OSS), assembled from the parts of
  [monaco-vscode-api](https://github.com/CodinGame/monaco-vscode-api) that coding needs (`web/src/main.ts`): AI, chat,
  notebooks, debugging, testing, walkthroughs, telemetry and sync are left out. Vite bundles it into one script.
- **ES5 for the iOS 6 engine**: the bundle is lowered at build time by Kodium's transpiler, which is the Surfari
  browser's `jsfix.js` with a few fixes (`web/tools/patch-jsfix.mjs`, `web/tools/lower.mjs`). `web/prelude` adds what
  the lowered workbench needs on top (VS Code's service proxies on the Proxy stand-in, `instanceof` for them, User
  Timing, regular expressions with lookbehind).
- **The engine**: the app is a full-screen UIWebView with the engine of the [Surfari](https://github.com/samcejko/surfari)
  browser (`engine/`, copied by `tools/sync-engine.ps1`): its own TLS 1.2 stack for the network (Mbed TLS), the CSS
  rewriter that makes modern stylesheets work on the 2012 WebKit, the page polyfills and shims, and the JIT inside
  the web view (the `dynamic-codesigning` entitlement). The workbench is served from the app at
  `https://kodium.invalid/` (`src/KDSiteProtocol.m`); its stylesheet is rewritten once and kept.
- **The terminal** is VS Code's (xterm.js), its shells the iPad's own: iOS lets an app of `/var/mobile/Applications`
  start no process, so the package **Kodium Shell** (`shell/`, `Kodium-shell-<version>.deb`) has launchd run
  `kodium-shelld` for each connection to `127.0.0.1:47070`: a login shell (bash) on a pseudo terminal, as the user
  mobile. It answers only Kodium - a connection has to name the token Kodium writes into its container at every start
  (`src/KDTerminal.m`, `web/src/terminal.ts`). Install it once, as root: `dpkg -i Kodium-shell-<version>.deb`.
- **Touch**: text is selected as on iOS (`web/src/selection.ts`) - a long press shows the loupe and puts the caret
  under the finger, a double tap selects a word, a selection has iOS's handles and the callout of its edits (Cut, Copy,
  Paste, Select, Select All, and More... for the editor's menu) -, and the clipboard is the system's pasteboard, both
  ways (`/__kd/app/copy` and `/paste`).

## Plan

1. The workbench on the device (this version): memory and speed on a 512 MB iPad 2.
2. Files of the iPad (folders in the app's Documents, shared through iTunes).
3. Node.js on iOS 6 (V8 for 32-bit ARM, with the JIT), then the open VS Code server on the iPad itself, with
   extensions from Open VSX.

## Building

No Mac is needed: `.github/workflows/build.yml` builds on Ubuntu with Theos, the iOS 9.3 SDK (deployment target 6.0)
and an LLVM toolchain, fetches what the engine needs (Mbed TLS, woff2, brotli, libwebp, the CA bundle, the polyfills),
builds the workbench (`web/`) and makes `Kodium-<version>.ipa` (with the JIT), `Kodium-<version>-nojit.ipa`,
`Kodium-<version>.deb` and the terminal's `Kodium-shell-<version>.deb` as Actions artifacts.

On Windows (no git needed):

```powershell
.\tools\sync-engine.ps1                     # copy Surfari's engine from ..\browser-ios6 and patch the transpiler
.\web\build.ps1                             # the workbench into web\dist (and web\dist\site, as the app has it)
.\tools\serve.ps1                           # web\dist on http://localhost:8767/ (site/index.html, es5test.html)
.\tools\gh-push.ps1 -Message "change"       # push the working tree via the REST API (tools\local.json: repo, token)
.\tools\gh-build.ps1 -Download              # wait for the build and download the packages
```

`web\build.ps1` uses `.tools\node\node.exe` (a portable Node.js, not in the repository) or `node` on the PATH; run
`npm ci` in `web` first.

## Support

Kodium is free. If it is useful to you, you can support the development at [ko-fi.com/samcejko](https://ko-fi.com/samcejko);
the status bar's "Kodium ♥" item opens the same page. Kodium is also in the repository `http://repo.samcejko.eu/`
(Cydia, Sileo, Zebra, Installer) together with the author's other iOS 6 apps.

## Licence

MIT (see [LICENSE](LICENSE)). The third-party components and their licences are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the npm packages of the workbench bundle also in
`site/assets/licenses.txt` inside the app. Kodium is not affiliated with Microsoft; "Visual Studio Code" is their
trademark.
