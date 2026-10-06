# Third-party notices

Kodium is released under the MIT License (see [LICENSE](LICENSE)). It is built from its own code, from the engine of
the Surfari browser (the same author, MIT; copied into `engine/`), and from the third-party components listed here,
each with the version the build uses, where it comes from and its licence. The copyright notices and licence texts
follow the list. Every npm package that goes into the workbench bundle is also listed, with its own licence text, in
`assets/licenses.txt` inside the app (`Kodium.app/site/assets/licenses.txt`), which the build makes from the bundle.

This file is assembled by `tools/make-notices.ps1` from `tools/notices-head.md` and the licence texts of Surfari's
notices (`THIRD_PARTY_NOTICES.md` of browser-ios6).

## Components

### The workbench (JavaScript, in `site/`)

| Component | Version | Licence | Source |
|---|---|---|---|
| monaco-vscode-api (`@codingame/monaco-vscode-api` and its `-service-override` and `-default-extension` packages) | 37.3.3 | MIT | https://github.com/CodinGame/monaco-vscode-api |
| Visual Studio Code (Code - OSS), the sources monaco-vscode-api is made of | the version monaco-vscode-api 37.3.3 is built from | MIT | https://github.com/microsoft/vscode |
| Codicons (the icon font, `codicon.ttf`) | as shipped in monaco-vscode-api 37.3.3 | CC BY 4.0 (the font), MIT (the code) | https://github.com/microsoft/vscode-codicons |
| marked | 14.0.0 | MIT | https://github.com/markedjs/marked |
| DOMPurify | 3.4.15 | Apache-2.0 (dual-licensed MPL-2.0 OR Apache-2.0; used under Apache-2.0) | https://github.com/cure53/DOMPurify |
| @vscode/diff | 0.0.2-7 | MIT | https://github.com/microsoft/vscode-diff |
| @vscode/iconv-lite-umd | 0.7.1 | MIT | https://github.com/microsoft/vscode-iconv-lite-umd |

The workbench is bundled by Vite and lowered to ES5 by Kodium's transpiler at build time (`web/`). jschardet, which
VS Code uses to guess file encodings, is replaced by a stub of Kodium's own (`web/src/stubs/jschardet.js`) and is not
in the app.

### Compiled into the app (the engine's libraries)

| Component | Version | Licence | Source |
|---|---|---|---|
| Mbed TLS (TLS 1.2, X.509, cryptography) | 3.6.7 | Apache-2.0 (dual-licensed Apache-2.0 OR GPL-2.0-or-later; used under Apache-2.0) | https://github.com/Mbed-TLS/mbedtls |
| Brotli (decoder only) | 1.1.0 | MIT | https://github.com/google/brotli |
| WOFF2 (decoder only) | 1.0.2 | MIT | https://github.com/google/woff2 |
| libwebp (decoder only) | 1.3.2 | BSD-3-Clause, with Google's Additional IP Rights Grant (patents) | https://github.com/webmproject/libwebp |

The app also links to zlib, libc++ and the other system libraries of iOS. They are part of the operating system and
are not distributed with Kodium.

### JavaScript the engine adds to the page and to workers

| Component | Version | Licence | Source |
|---|---|---|---|
| core-js (a custom bundle made with core-js-builder 3.41.0) | 3.41.0 | MIT | https://github.com/zloirock/core-js |
| regenerator-runtime | 0.13.11 | MIT | https://github.com/facebook/regenerator |
| whatwg-fetch | 3.6.20 | MIT | https://github.com/JakeChampion/fetch |
| intersection-observer (polyfill) | 0.12.2 | W3C Software and Document Notice and License (2015), as its source file states; the npm package metadata says Apache-2.0 | https://github.com/GoogleChromeLabs/intersection-observer |
| resize-observer-polyfill | 1.5.1 | MIT | https://github.com/que-etc/resize-observer-polyfill |
| picturefill | 3.0.3 | MIT | https://github.com/scottjehl/picturefill |
| dialog-polyfill | 0.5.6 | BSD-3-Clause | https://github.com/GoogleChrome/dialog-polyfill |
| object-fit-images | 3.2.4 | MIT | https://github.com/fregante/object-fit-images |
| IndexedDBShim (`indexeddbshim`) | 3.10.0 | MIT (dual-licensed MIT OR Apache-2.0; used under MIT) | https://github.com/indexeddbshim/IndexedDBShim |
| acorn (JavaScript parser of the transpiler) | 8.14.0 | MIT | https://github.com/acornjs/acorn |

Changes made at build time: acorn's directive check reads a 4096-character window instead of the rest of the input
(a `sed` line in the workflow), and object-fit-images is patched by `engine/tools/patch-ofi.js`. The minified copies
keep the licence comments of their sources.

IndexedDBShim's browser build contains these packages, all distributed inside `indexeddbshim.min.js`: typeson 5.8.2
(MIT), typeson-registry 1.0.0-alpha.20 (MIT), eventtargeter 0.4.0 (MIT), sync-promise (ISC, the fork used by
IndexedDBShim), path-browserify (MIT), process (MIT) and browser-pack (MIT).

### Code written after other projects (in the engine's page shims)

| What | Where | After | Licence |
|---|---|---|---|
| AES in the `crypto.subtle` implementation (precomputed S-box and round tables) | `shims-extra.js` | SJCL, the Stanford JavaScript Crypto Library | BSD-2-Clause (SJCL is dual-licensed BSD-2-Clause OR GPL-2.0-or-later; used under BSD-2-Clause) |
| Inflate of `DecompressionStream` | `shims-extra.js` | puff.c by Mark Adler (zlib's contrib/puff) | zlib License |

### Data

| Data | Where | Licence | Source |
|---|---|---|---|
| Unicode character property tables for `\p{...}` in regular expressions (generated at build time from the Unicode Character Database of the build machine's Node.js) | `js/unicode-props.js` | Unicode License v3 | https://www.unicode.org/ucd/ |
| CLDR locale data in the `Intl` implementation | `shims.js` | Unicode License v3 | https://cldr.unicode.org/ |
| Encoding labels and single-byte index tables of `TextDecoder` | `shims.js`, `worker-shims.js` | CC BY 4.0 | WHATWG Encoding Standard, https://encoding.spec.whatwg.org/ |
| CA certificates (Mozilla's root store as extracted by the curl project; fetched at build time, unchanged) | `cacert.pem` | MPL-2.0 | https://curl.se/docs/caextract.html |

### Used only to build Kodium (not distributed)

Theos, the LLVM/clang toolchain, the iOS 9.3 SDK, ldid, Node.js, npm, Vite (with Rollup and esbuild), core-js-builder
and terser.

