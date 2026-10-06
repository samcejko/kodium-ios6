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

## Copyright notices and licence texts

### Mbed TLS

Copyright The Mbed TLS Contributors

Mbed TLS is dual-licensed under the Apache License 2.0 or the GNU General Public License v2.0 or later; Kodium uses
it under the Apache License 2.0 (full text below, under "Apache License 2.0"). The Mbed TLS release has no NOTICE
file. Kodium compiles the unchanged library sources with its own configuration header
(`engine/vendor/mbedtls_config_ios6.h`) in place of the default `mbedtls_config.h`.

### MIT-licensed components

These components are under the MIT License, whose text follows, with these copyright notices:

- Brotli: Copyright (c) 2009, 2010, 2013-2016 by the Brotli Authors.
- WOFF2: Copyright (c) 2013-2017 by the WOFF2 Authors.
- core-js: Copyright (c) 2014-2025 Denis Pushkarev
- regenerator-runtime: Copyright (c) 2014-present, Facebook, Inc.
- whatwg-fetch: Copyright (c) 2014-2023 GitHub, Inc.
- resize-observer-polyfill: Copyright (c) 2016 Denis Rul
- picturefill: Copyright (c) 2014 Filament Group
- object-fit-images: Copyright (c) Federico Brigante <bfred-it@users.noreply.github.com> (twitter.com/bfred_it)
- IndexedDBShim: Copyright 2014-2017 Parashuram N., Brett Zamir
- typeson and typeson-registry: Copyright (c) 2016 David Fahlander
- eventtargeter: Copyright (c) 2011 Mr.doob
- path-browserify: Copyright (c) 2013 James Halliday
- process: Copyright (c) 2013 Roman Shtylman <shtylman@gmail.com>
- browser-pack: James Halliday, released under the MIT license
- acorn: Copyright (C) 2012-2022 by various contributors (see AUTHORS in the acorn repository)
- Visual Studio Code (Code - OSS): Copyright (c) 2015 - present Microsoft Corporation
- monaco-vscode-api: Copyright (c) 2023 CodinGame
- marked: Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/); Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)
- @vscode/diff, @vscode/iconv-lite-umd: Copyright (c) Microsoft Corporation (iconv-lite: Copyright (c) 2011 Alexander Shtuchkin)

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### libwebp

```text
Copyright (c) 2010, Google Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google nor the names of its contributors may
    be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

Additional IP Rights Grant (Patents):

```text
Additional IP Rights Grant (Patents)
------------------------------------

"These implementations" means the copyrightable works that implement the WebM
codecs distributed by Google as part of the WebM Project.

Google hereby grants to you a perpetual, worldwide, non-exclusive, no-charge,
royalty-free, irrevocable (except as stated in this section) patent license to
make, have made, use, offer to sell, sell, import, transfer, and otherwise
run, modify and propagate the contents of these implementations of WebM, where
such license applies only to those patent claims, both currently owned by
Google and acquired in the future, licensable by Google that are necessarily
infringed by these implementations of WebM. This grant does not include claims
that would be infringed only as a consequence of further modification of these
implementations. If you or your agent or exclusive licensee institute or order
or agree to the institution of patent litigation or any other patent
enforcement activity against any entity (including a cross-claim or
counterclaim in a lawsuit) alleging that any of these implementations of WebM
or any code incorporated within any of these implementations of WebM
constitute direct or contributory patent infringement, or inducement of
patent infringement, then any patent rights granted to you under this License
for these implementations of WebM shall terminate as of the date such
litigation is filed.
```

### dialog-polyfill

```text
Copyright (c) 2013 The Chromium Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### intersection-observer

Copyright 2016 Google Inc. All Rights Reserved.
Licensed under the W3C Software and Document Notice and License (2015),
https://www.w3.org/copyright/software-license-2015/:

```text
License

By obtaining and/or copying this work, you (the licensee) agree that you have
read, understood, and will comply with the following terms and conditions.

Permission to copy, modify, and distribute this work, with or without
modification, for any purpose and without fee or royalty is hereby granted,
provided that you include the following on ALL copies of the work or portions
thereof, including modifications:

- The full text of this NOTICE in a location viewable to users of the
  redistributed or derivative work.
- Any pre-existing intellectual property disclaimers, notices, or terms and
  conditions. If none exist, the W3C Software and Document Short Notice should
  be included.
- Notice of any changes or modifications, through a copyright statement on the
  new code or document such as "This software or document includes material
  copied from or derived from [title and URI of the W3C document]. Copyright (c)
  [YEAR] W3C(R) (MIT, ERCIM, Keio, Beihang)."

Disclaimers

THIS WORK IS PROVIDED "AS IS," AND COPYRIGHT HOLDERS MAKE NO REPRESENTATIONS OR
WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO, WARRANTIES OF
MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE
SOFTWARE OR DOCUMENT WILL NOT INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS,
TRADEMARKS OR OTHER RIGHTS.

COPYRIGHT HOLDERS WILL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, SPECIAL OR
CONSEQUENTIAL DAMAGES ARISING OUT OF ANY USE OF THE SOFTWARE OR DOCUMENT.

The name and trademarks of copyright holders may NOT be used in advertising or
publicity pertaining to the work without specific, written prior permission.
Title to copyright in this work will at all times remain with copyright
holders.
```

### SJCL (the AES tables)

```text
SJCL is open. You can use, modify and redistribute it under a BSD
license or under the GNU GPL, version 2.0.

Copyright (c) 2009-2015, Emily Stark, Mike Hamburg and Dan Boneh at
Stanford University. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

1. Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### puff (the inflate of DecompressionStream)

```text
puff.h
Copyright (C) 2002-2013 Mark Adler, all rights reserved
version 2.3, 21 Jan 2013

This software is provided 'as-is', without any express or implied
warranty.  In no event will the author be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

Mark Adler    madler@alumni.caltech.edu
```

### sync-promise (inside IndexedDBShim)

sync-promise by Simon Friis Vindum, in the fork by Brett Zamir that IndexedDBShim uses, is under the ISC License:

```text
Copyright (c) Simon Friis Vindum

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Unicode data (Unicode Character Database, CLDR)

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

### WHATWG Encoding Standard

The encoding labels and index tables come from the Encoding Standard, https://encoding.spec.whatwg.org/,
Copyright (c) WHATWG (Apple, Google, Mozilla, Microsoft), licensed under the Creative Commons Attribution 4.0
International License, https://creativecommons.org/licenses/by/4.0/. The engine stores the tables in a compressed
form.

### Mozilla CA certificate list

`cacert.pem` holds the root certificates of Mozilla's CA certificate program as extracted from Mozilla's NSS
`certdata.txt` by the curl project, unchanged. This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at
https://mozilla.org/MPL/2.0/. The file itself is its source form; current versions are at
https://curl.se/ca/cacert.pem.

### Apache License 2.0

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### DOMPurify

Copyright 2025 Dr.-Ing. Mario Heiderich, Cure53. DOMPurify is dual-licensed under the Apache License 2.0 and the
Mozilla Public License 2.0; Kodium uses it under the Apache License 2.0 (full text above).

### Codicons

The Codicons icon font (`codicon.ttf`), Copyright (c) Microsoft Corporation, is licensed under the Creative Commons
Attribution 4.0 International License, https://creativecommons.org/licenses/by/4.0/ (its code under the MIT License).
Source: https://github.com/microsoft/vscode-codicons. Kodium ships the font as monaco-vscode-api has it, unchanged.
