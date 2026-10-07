// One classic script (IIFE) for iOS 6: everything, lazy parts included, in one file that tools/lower.mjs then lowers
// to ES5. The CSS goes to its own file. assets/licenses.txt lists every npm package that went into the bundle, with its
// licence text (the app's licence notices name it).
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'

function bundledLicenses() {
  return {
    name: 'kodium-licenses',
    generateBundle() {
      const packages = new Map()
      for (const id of this.getModuleIds()) {
        const m = id.replace(/\\/g, '/').match(/^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//)
        if (m && !packages.has(m[2])) packages.set(m[2], m[1])
      }
      const parts = []
      for (const [name, dir] of [...packages].sort((a, b) => a[0].localeCompare(b[0]))) {
        const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
        const files = fs.readdirSync(dir).filter((f) => /^(licen[sc]e|copying|notice|thirdpartynotices)(\.|-|$)/i.test(f)).sort()
        const texts = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim())
        const licence = typeof pj.license === 'string' ? pj.license : (pj.license && pj.license.type) || 'see the text'
        parts.push(`${name} ${pj.version} - ${licence}\n\n` + (texts.length ? texts.join('\n\n') : '(the package has no licence file)'))
      }
      this.emitFile({ type: 'asset', fileName: 'assets/licenses.txt',
                      source: 'Packages in the Kodium workbench bundle (' + parts.length + ')\n\n' + parts.join('\n\n' + '-'.repeat(78) + '\n\n') + '\n' })
    }
  }
}

// bundle-report.txt next to the build (not in assets, so not in the app): how much of the bundle each package, each part
// of VS Code (vs/workbench/contrib/... from whichever package) and each module is, before minifying - for trimming the
// workbench to the iPad 2's memory
function bundleReport() {
  return {
    name: 'kodium-bundle-report',
    generateBundle(_options, bundle) {
      const packages = new Map(), areas = new Map(), modules = []
      let total = 0
      const add = (map, key, n) => map.set(key, (map.get(key) || 0) + n)
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue
        for (const [id, m] of Object.entries(file.modules)) {
          const p = id.replace(/\\/g, '/')
          const pm = p.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/)
          const vs = p.match(/\/vscode\/src\/vs\/(.*)$/)
          add(packages, pm ? pm[1] : '(kodium)', m.renderedLength)
          add(areas, vs ? 'vs/' + vs[1].split('/').slice(0, vs[1].startsWith('workbench/') ? 3 : 2).join('/') : pm ? pm[1] : '(kodium)', m.renderedLength)
          modules.push([m.renderedLength, vs ? 'vs/' + vs[1] : pm ? pm[1] + '/' + pm[2] : p])
          total += m.renderedLength
        }
      }
      const kb = (n) => (n / 1024).toFixed(0).padStart(7) + ' KB'
      const list = (map, max) => [...map].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k, n]) => kb(n) + '  ' + k).join('\n')
      const short = (id) => { const p = id.replace(/\\/g, '/'); const vs = p.match(/\/vscode\/src\/(vs\/.*)$/); return vs ? vs[1] : p.replace(/^.*\/node_modules\//, '') }
      // what leaving out each contribution would take away: the modules only it brings in (the ones the entry no longer
      // reaches without it)
      const sizes = new Map()
      for (const file of Object.values(bundle)) if (file.type === 'chunk') for (const [id, m] of Object.entries(file.modules)) sizes.set(id, m.renderedLength)
      const entry = [...this.getModuleIds()].find((id) => this.getModuleInfo(id)?.isEntry)
      const reach = (skip) => {
        const seen = new Set([entry]), stack = [entry]
        while (stack.length) {
          const info = this.getModuleInfo(stack.pop())
          for (const next of [...(info?.importedIds || []), ...(info?.dynamicallyImportedIds || [])]) {
            if (next !== skip && !seen.has(next)) { seen.add(next); stack.push(next) }
          }
        }
        return seen
      }
      const all = reach(null)
      const contributions = []
      // (contributions, the extension host's main thread parts and chat's: modules imported for what they register)
      for (const id of all) {
        if (!/\.contribution\.js$|\/api\/browser\/mainThread\w+\.js$|\/[a-zA-Z]*[cC]hat\w*\.js$/.test(id.replace(/\\/g, '/'))) continue
        const without = reach(id)
        let only = 0
        for (const other of all) if (!without.has(other)) only += sizes.get(other) || 0
        const importers = (this.getModuleInfo(id)?.importers || []).map(short)
        contributions.push([only, short(id) + '  <- ' + importers.slice(0, 3).join(', ') + (importers.length > 3 ? ', ...' : '')])
      }
      const source = `Bundle before minifying: ${kb(total).trim()}, ${modules.length} modules\n\n` +
        `Packages\n${list(packages, 60)}\n\nParts of VS Code and other packages\n${list(areas, 150)}\n\n` +
        `Contributions: what only each brings in\n${contributions.sort((a, b) => b[0] - a[0]).slice(0, 150).map(([n, k]) => kb(n) + '  ' + k).join('\n')}\n\n` +
        `Modules\n${modules.sort((a, b) => b[0] - a[0]).slice(0, 150).map(([n, k]) => kb(n) + '  ' + k).join('\n')}\n`
      this.emitFile({ type: 'asset', fileName: 'bundle-report.txt', source })
    }
  }
}

// VS Code's delayed services are Proxies, which the iOS 6 engine lacks: the stand-in (vsc-prelude.js) needed an accessor
// for every name the bundle reads (36,000 of them, two closures each) and one for every method of each such service. They
// are created at once instead - which is what happens anyway on an engine without requestIdleCallback, where the
// "idle" creation runs on the next tick. (What is left to Proxy: the RPC and IPC proxies, with $methods and onEvents.)
function eagerServices() {
  const find = '        if (!supportsDelayedInstantiation) {'
  return {
    name: 'kodium-eager-services',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/vs/platform/instantiation/common/instantiationService.js')) return null
      if (code.split(find).length !== 2) this.error('kodium-eager-services: the instantiation service has another form')
      return { code: code.replace(find, '        if (true) {'), map: null }
    }
  }
}

// Edits of VS Code's modules as they come into the bundle. Each text to find must be there once: an update of
// monaco-vscode-api that changed it stops the build rather than leave the edit out.
function patchModules(name, patches) {
  return {
    name,
    transform(code, id) {
      const p = id.replace(/\\/g, '/')
      for (const [suffix, edits, prefix] of patches) {
        if (!p.endsWith(suffix)) continue
        for (const [find, replace] of edits) {
          if (code.split(find).length !== 2) this.error(name + ': ' + suffix + ' has another form')
          code = code.replace(find, () => replace)
        }
        return { code: (prefix || '') + code, map: null }
      }
      return null
    }
  }
}

// An extension's README, features and changelog in the page itself: VS Code shows them in a webview - an iframe with
// scripts of its own, which the iOS 6 engine does not run (the page said "No README available"), and the memory of
// another page. The HTML is the one VS Code made for it (sanitized); its links open in the browser, as there.
function inlineMarkdown() {
  return patchModules('kodium-inline-markdown', [
    ['/vs/workbench/contrib/extensions/browser/extensionEditor.js', [
      ['            const webview = this.contentDisposables.add(this.webviewService.createWebviewOverlay({',
       '            if (typeof document !== "undefined") {\n                return __kdInlineMarkdown(this, body, container);\n            }\n' +
       '            const webview = this.contentDisposables.add(this.webviewService.createWebviewOverlay({']],
     'function __kdInlineMarkdown(editor, html, container) {\n' +
     '    const at = html.indexOf("<body");\n' +
     '    const from = at < 0 ? 0 : html.indexOf(">", at) + 1;\n' +
     '    const to = html.lastIndexOf("</body>");\n' +
     '    const element = document.createElement("div");\n' +
     '    element.className = "kodium-markdown";\n' +
     '    element.tabIndex = 0;\n' +
     '    element.innerHTML = html.slice(from, to > from ? to : html.length).replace(/<a id="scroll-to-top"[\\s\\S]*?<\\/a>/, "");\n' +
     '    element.addEventListener("click", (e) => {\n' +
     '        let node = e.target;\n' +
     '        while (node && node !== element && !(node.tagName === "A" && node.getAttribute("href"))) node = node.parentNode;\n' +
     '        if (!node || node === element) return;\n' +
     '        e.preventDefault();\n' +
     '        const href = node.getAttribute("href");\n' +
     '        if (/^(https?|mailto):/i.test(href)) editor.openerService.open(href);\n' +
     '    });\n' +
     '    container.appendChild(element);\n' +
     '    return element;\n' +
     '}\n']
  ])
}

// VS Code's rules made at run time (decorations of the editor: every new one, as an extension or a find makes them)
// went one by one through the engine's stylesheet rewriter - a synchronous request to the app each. A rule with
// nothing the iOS 6 engine lacks goes in as it is; one with something modern (a variable, flex, transforms, newer
// selectors and functions...) still goes through the rewriter.
function plainRules() {
  return patchModules('kodium-plain-rules', [
    ['/vs/base/browser/domStylesheets.js', [
      ['    style.sheet?.insertRule(`${selector} {${cssText}}`, 0);', '    __kdInsertRule(style.sheet, `${selector} {${cssText}}`);']],
     'const __kdModernCSS = /var\\(|--[\\w-]+\\s*:|calc\\(|\\b(?:min|max|clamp)\\(|:(?:is|where|has|not)\\(|focus-(?:visible|within)|#[0-9a-f]{4}\\b|#[0-9a-f]{8}\\b|' +
     'rgba?\\([^)]*\\/|display\\s*:\\s*(?:inline-)?flex|\\bflex(?:-[a-z]+)?\\s*:|\\b(?:align|justify|place)-[a-z]+\\s*:|\\bgap\\s*:|transform|transition|animation|keyframes|' +
     'user-select|\\binset\\s*:|sticky|grid|\\bmask|\\bfilter\\s*:|appearance|object-fit|aspect-ratio|@supports|@container|@layer|color-mix|-content\\b|placeholder|backdrop|' +
     'writing-mode|text-decoration-(?:color|style|thickness)/i;\n' +
     'function __kdInsertRule(sheet, text) {\n' +
     '    if (!sheet) return;\n' +
     '    const native = typeof window !== "undefined" ? window.__brNativeInsertRule : undefined;\n' +
     '    if (native && !__kdModernCSS.test(text)) native.call(sheet, text, 0);\n' +
     '    else sheet.insertRule(text, 0);\n' +
     '}\n']
  ])
}

// Workers go sooner when nothing uses them (a worker is a script engine of its own on the iPad 2: about 8 MB each): the
// language services' after 45 s instead of 2 minutes, the editor's after a minute instead of five
function quickerWorkers() {
  const language = (lang) => [`/monaco-vscode-standalone-${lang}-language-features/languages/features/${lang}/workerManager.js`, [
    ['const STOP_WHEN_IDLE_FOR = 2 * 60 * 1e3;', 'const STOP_WHEN_IDLE_FOR = 45 * 1e3;'],
    ['this._idleCheckInterval = window.setInterval(() => this._checkIfIdle(), 30 * 1e3);',
     'this._idleCheckInterval = window.setInterval(() => this._checkIfIdle(), 15 * 1e3);']]]
  return patchModules('kodium-quicker-workers', [
    language('json'), language('css'), language('html'),
    ['/vs/editor/browser/services/editorWorkerService.js', [
      ['const STOP_WORKER_DELTA_TIME_MS = 5 * 60 * 1000;', 'const STOP_WORKER_DELTA_TIME_MS = 60 * 1000;']]]
  ])
}

// The editor's work at every keystroke on the iPad 2 (WebKit's profiler while typing, line by line):
// - a position in a line (the cursor, the scroll to it, indent guides) was measured in the page - getClientRects, a
//   layout of the whole page each time - because VS Code does not trust its own arithmetic on Safari, whose zoom changes
//   the width of the characters. Kodium's page cannot be zoomed, and the editor's font is monospaced: computed, as on
//   other browsers (lines with other than ASCII are still measured). VS Code also took the font for proportional: its
//   test of the font includes the arrow it draws tabs with when white space is shown, which iOS 6's Courier lacks
//   (another font draws it, 14 px wide against 8.41) - left out of the test.
// - the folding regions were worked out again 0.2 s after every change, and the matching bracket 0.05 s after every
//   move of the cursor - each new set of decorations had the editor check every line on the screen again. Now once
//   typing pauses (1 s, 0.3 s).
function smootherEditor() {
  return patchModules('kodium-smoother-editor', [
    ['/vs/editor/browser/viewParts/viewLines/viewLine.js', [
      ['    if (isLinux || isFirefox || isSafari) {', '    if (isLinux || isFirefox) {']]],
    ['/vs/editor/browser/config/fontMeasurements.js', [
      ['const rightwardsArrow = this._createRequest("→", CharWidthRequestType.Regular, all, monospace);',
       'const rightwardsArrow = this._createRequest("→", CharWidthRequestType.Regular, all, null);']]],
    ['/vs/editor/contrib/folding/browser/folding.js', [
      ['            min: 200\n', '            min: 1000\n']]],
    ['/vs/editor/contrib/bracketMatching/browser/bracketMatching.js', [
      ['new RunOnceScheduler(() => this._updateBrackets(), 50)', 'new RunOnceScheduler(() => this._updateBrackets(), 300)']]]
  ])
}

// The built-in language extensions bring their TextMate grammars, which Kodium never reads (no TextMate tokenizer here:
// it needs WebAssembly; monaco's Monarch grammars colour the code): their files stay out of the app (1.6 MB), the
// extensions' entries for them point at an empty document.
function noGrammars() {
  return {
    name: 'kodium-no-grammars',
    transform(code, id) {
      if (!/\/@codingame\/monaco-vscode-[\w-]+-default-extension\/index\.js$/.test(id.replace(/\\/g, '/'))) return null
      const out = code.replace(/new URL\('\.\/resources\/[^']+\.tmLanguage(?:\.json)?', import\.meta\.url\)\.toString\(\)/g, '"data:application/json,{}"')
      return out === code ? null : { code: out, map: null }
    }
  }
}

// Emmet's suggestions say what they are in English only (emmet-monaco-es): in Czech as VS Code's language pack says it
function emmetInCzech() {
  return {
    name: 'kodium-emmet-czech',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/emmet-monaco-es/dist/emmet-monaco.esm.js')) return null
      const out = code.replace(/'Emmet [aA]bbreviation'/g, '__kdEmmetDetail')
      if (out === code) this.error('kodium-emmet-czech: emmet-monaco-es has another form')
      return { code: 'const __kdEmmetDetail = /^cs/i.test((typeof window !== "undefined" && window.__kd_lang) || "") ? "Zkratka Emmet" : "Emmet Abbreviation";\n' + out, map: null }
    }
  }
}

// The extension host in the page starts only for an extension with code it can run: VS Code starts it at once
// for any extension it hosts, the default themes and snippets included - 3.5 s and 14 MB more at every start on the
// iPad 2, for nothing to run. Lazily, and counting only extensions with code, it starts when one is installed or
// enabled, or at the start when one is there.
function lazyExtensionHost() {
  return patchModules('kodium-lazy-extension-host', [
    ['/@codingame/monaco-vscode-extensions-service-override/index.js', [
      ['createInstance(localExtensionHost, runningLocation, ExtensionHostStartup.EagerAutoStart,',
       'createInstance(localExtensionHost, runningLocation, ExtensionHostStartup.LazyAutoStart,']]],
    ['/vs/workbench/services/extensions/common/lazyCreateExtensionHostManager.js', [
      ['        if (myExtensions.length > 0) {', '        if (__kdWithCode(myExtensions, allExtensions).length > 0) {'],
      // (a change without code for a host not made: nothing to wait for - the default themes register before the
      // service starts, and waiting for its start under the registry's lock locked the workbench's start; a host made
      // later is given every extension there is then)
      ['    async deltaExtensions(extensionsDelta) {\n        await this._startCalled.wait();',
       '    async deltaExtensions(extensionsDelta) {\n        if (!this._actual && __kdWithCode(extensionsDelta.myToAdd, extensionsDelta.toAdd).length === 0) {\n            return;\n        }\n        await this._startCalled.wait();'],
      ['        if (extensionsDelta.myToAdd.length > 0) {', '        if (__kdWithCode(extensionsDelta.myToAdd, extensionsDelta.toAdd).length > 0) {']],
     // (code a host in the page can run: an extension's browser entry - its main is for Node)
     'function __kdWithCode(ids, descriptions) {\n' +
     '    const code = new Set();\n' +
     '    for (const d of descriptions || []) if (d && d.browser) code.add(String(d.identifier.value).toLowerCase());\n' +
     '    return (ids || []).filter((id) => code.has(String(id.value).toLowerCase()));\n' +
     '}\n'],
    // (a host made later is given the extensions there are then - the registry's, as VS Code gives a host it starts
    // again: the list of the start is kept from the start, without what came since)
    ['/vs/workbench/services/extensions/browser/extensionService.js', [
      ['                if (isInitialStart) {',
       '                if (isInitialStart && desiredRunningLocation.kind !== ExtensionHostKind.LocalProcess) {']]],
    // (the 'vscode' module's default API came when the workbench started, from the host it started: the start waited for
    // a host that now comes later. It comes with the host; nothing of Kodium's own uses it. And a host started lazily
    // starts its extensions itself, as VS Code's worker host does: nothing else asks it to.)
    ['/node_modules/vscode/localExtensionHost.js', [
      ['    defaultApi = await createLocalApi();', '    void createLocalApi().then((api) => { defaultApi = api; });'],
      ['autoStart: this.startup === ExtensionHostStartup.EagerAutoStart,',
       'autoStart: this.startup === ExtensionHostStartup.EagerAutoStart || this.startup === ExtensionHostStartup.LazyAutoStart,']]]
  ])
}

// Contributions the service overrides bring that Kodium has no use for yet (each is imported only for what it registers):
// the merge editor (Git), call and type hierarchies (language servers), the refactoring preview and the search editor;
// VS Code's splash (Kodium has its own) and the "modern UI" (a setting that is off, with 14 stylesheets).
// And the extension host's main thread parts of what an extension cannot do on the iPad - comments (pull requests),
// tests, tasks, terminals, debugging, source control, CLI commands, tunnels, speech, sockets - and the editor tabs API,
// which brings every kind of editor there is (chat, notebooks, the merge editor...) to tell tabs apart: half a megabyte.
// They get an empty stand-in (web/src/exthost.ts): an extension that calls one of them gets an error from that call.
// And inline completions (ghost text, next edit suggestions - Copilot's): no extension that gives them runs on the iPad,
// yet their models followed every keystroke and every move of the cursor in every editor (a third of the time of the
// typing command in WebKit's profiler).
const LEFT_OUT = [
  'vs/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js',
  'vs/workbench/contrib/inlineCompletions/browser/inlineCompletions.contribution.js',
  'vs/workbench/contrib/mergeEditor/browser/mergeEditor.contribution.js',
  'vs/workbench/contrib/callHierarchy/browser/callHierarchy.contribution.js',
  'vs/workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.js',
  'vs/workbench/contrib/bulkEdit/browser/preview/bulkEdit.contribution.js',
  'vs/workbench/contrib/searchEditor/browser/searchEditor.contribution.js',
  'vs/workbench/contrib/splash/browser/splash.contribution.js',
  'vs/workbench/contrib/modernUI/browser/modernUI.contribution.js',
  ...['EditorTabs', 'Comments', 'Testing', 'Task', 'TerminalService', 'TerminalShellIntegration', 'DebugService', 'SCM',
      'CLICommands', 'TunnelService', 'Speech', 'ManagedSockets', 'DataChannels', 'Browsers']
    .map((name) => 'vs/workbench/api/browser/mainThread' + name + '.js')
]
function leaveOut() {
  return {
    name: 'kodium-leave-out',
    load(id) {
      const p = id.replace(/\\/g, '/')
      return LEFT_OUT.some((suffix) => p.endsWith('/' + suffix)) ? 'export {}' : null
    }
  }
}

export default defineConfig({
  base: './',
  plugins: [eagerServices(), lazyExtensionHost(), inlineMarkdown(), quickerWorkers(), plainRules(), smootherEditor(), noGrammars(), emmetInCzech(), leaveOut(), bundledLicenses(), bundleReport()],
  // (jschardet, LGPL, guesses file encodings only when the user turns that on: a stub that never guesses)
  resolve: { alias: [{ find: /^jschardet(\/.*)?$/, replacement: path.resolve(import.meta.dirname, 'src/stubs/jschardet.js') }] },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'esbuild',
    sourcemap: false,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 100000,
    rollupOptions: {
      input: 'index.html',
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/workbench.js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  },
  worker: { format: 'iife' }
})
