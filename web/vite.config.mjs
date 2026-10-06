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
      for (const id of all) {
        if (!/\.contribution\.js$/.test(id)) continue
        const without = reach(id)
        let only = 0
        for (const other of all) if (!without.has(other)) only += sizes.get(other) || 0
        const importers = (this.getModuleInfo(id)?.importers || []).map(short)
        contributions.push([only, short(id) + '  <- ' + importers.slice(0, 3).join(', ') + (importers.length > 3 ? ', ...' : '')])
      }
      const source = `Bundle before minifying: ${kb(total).trim()}, ${modules.length} modules\n\n` +
        `Packages\n${list(packages, 60)}\n\nParts of VS Code and other packages\n${list(areas, 150)}\n\n` +
        `Contributions: what only each brings in\n${contributions.sort((a, b) => b[0] - a[0]).slice(0, 80).map(([n, k]) => kb(n) + '  ' + k).join('\n')}\n\n` +
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
// the merge editor (Git), call and type hierarchies (language servers), the refactoring preview and the search editor
const LEFT_OUT = [
  'vs/workbench/contrib/mergeEditor/browser/mergeEditor.contribution.js',
  'vs/workbench/contrib/callHierarchy/browser/callHierarchy.contribution.js',
  'vs/workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.js',
  'vs/workbench/contrib/bulkEdit/browser/preview/bulkEdit.contribution.js',
  'vs/workbench/contrib/searchEditor/browser/searchEditor.contribution.js'
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
  plugins: [eagerServices(), lazyExtensionHost(), inlineMarkdown(), leaveOut(), bundledLicenses(), bundleReport()],
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
