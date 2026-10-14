// One classic script (IIFE) for iOS 6: everything, lazy parts included, in one file that tools/lower.mjs then lowers
// to ES5. The CSS goes to its own file. assets/licenses.txt lists every npm package that went into the bundle, with its
// licence text (the app's licence notices name it).
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import { quickerDiffs } from './tools/quicker-diffs.mjs'

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

// A build for measuring the start only (KODIUM_MODTIMES=1 .\web\build.ps1): each module's code begins with __kdT(n), so
// window.__kdTimes has when each module's top level began to run (pairs of n and Date.now()); dist/modtimes.json names
// the modules. The time of a module is the gap to the next one.
function moduleTimes() {
  if (!process.env.KODIUM_MODTIMES) return null
  const ids = []
  return {
    name: 'kodium-module-times',
    transform(code, id) {
      if (id.startsWith('\0') || !/\.(m?js|ts)$/.test(id.split('?')[0])) return null
      ids.push(id.replace(/\\/g, '/'))
      return { code: '__kdT(' + (ids.length - 1) + ');\n' + code, map: null }
    },
    renderChunk(code) {
      return { code: 'var __kdTimes = window.__kdTimes = [], __kdT = function (i) { __kdTimes.push(i, Date.now()); };\n' + code, map: null }
    },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'modtimes.json', source: JSON.stringify(ids) }) }
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
// The editor's own rules made at run time (DynamicCssRules: a colour's swatch in CSS, inlay hints' styles) were a <style>
// element each, put into the page and then given its text: two rebuilds of the old WebKit's rule sets from all of the
// page's 570 KB of CSS, ~80 ms each on the iPad 2 - and they went 1 s after the editor stopped using them, so every
// switch to a CSS file made its colours' rules again (four colours: 0.65 s of a 1.6 s switch). A rule with nothing
// modern goes into one shared sheet now, natively (the rule sets are made again once, at the next frame), and a rule
// no longer used stays for 5 minutes.
function plainRules() {
  return patchModules('kodium-plain-rules', [
    ['/vs/editor/browser/editorDom.js', [
      ['        this._garbageCollectionScheduler = ( new RunOnceScheduler(() => this.garbageCollect(), 1000));',
       '        this._garbageCollectionScheduler = ( new RunOnceScheduler(() => this.garbageCollect(), 5 * 60 * 1000));'],
      ['            existingRule = ( new RefCountedCssRule(\n', '            existingRule = ( kdCssRule(RefCountedCssRule,\n']],
     'let kdSharedStyle;\n' +
     'function kdSharedSheet() {\n' +
     '    if (!kdSharedStyle || !kdSharedStyle.sheet || !kdSharedStyle.parentNode) {\n' +
     '        kdSharedStyle = document.createElement("style");\n' +
     '        kdSharedStyle.textContent = "/*br*/";\n' +
     '        document.head.appendChild(kdSharedStyle);\n' +
     '    }\n' +
     '    return kdSharedStyle.sheet;\n' +
     '}\n' +
     'const kdModernRule = /var\\(|--[\\w-]+\\s*:|calc\\(|\\b(?:min|max|clamp)\\(|:(?:is|where|has|not)\\(|#[0-9a-f]{4}\\b|#[0-9a-f]{8}\\b|rgba?\\([^)]*\\/|flex|transform|transition|animation|grid|\\bmask|\\bfilter\\s*:|appearance|color-mix|\\binset\\s*:|-content\\b|text-decoration-(?:color|style|thickness)/i;\n' +
     'class KdSharedCssRule {\n' +
     '    constructor(key, className, properties, text, insert) {\n' +
     '        this.key = key;\n' +
     '        this.className = className;\n' +
     '        this.properties = properties;\n' +
     '        this._referenceCount = 0;\n' +
     '        const sheet = kdSharedSheet();\n' +
     '        insert.call(sheet, text, sheet.cssRules.length);\n' +
     '        this._selector = "." + className;\n' +
     '    }\n' +
     '    dispose() {\n' +
     '        const sheet = kdSharedStyle && kdSharedStyle.sheet;\n' +
     '        const rules = sheet ? sheet.cssRules : [];\n' +
     '        for (let i = rules.length - 1; i >= 0; i--) {\n' +
     '            if (rules[i].selectorText === this._selector) {\n                sheet.deleteRule(i);\n                break;\n            }\n' +
     '        }\n' +
     '    }\n' +
     '    increaseRefCount() {\n        this._referenceCount++;\n    }\n' +
     '    decreaseRefCount() {\n        this._referenceCount--;\n    }\n' +
     '    hasReferences() {\n        return this._referenceCount > 0;\n    }\n' +
     '}\n' +
     'function kdCssRule(Original, key, className, container, properties) {\n' +
     '    const insert = typeof window !== "undefined" ? window.__brNativeInsertRule : undefined;\n' +
     '    if (!container && insert && typeof document !== "undefined" && document.head && typeof window.__kd_plainStyle === "function") {\n' +
     // (what vsc-prelude's __kd_plainStyle gives as plain - the theme's variables resolved, the rewriter's mark first)
     '        const plain = window.__kd_plainStyle(Original.prototype.getCssText.call(undefined, className, properties));\n' +
     '        const text = typeof plain === "string" && plain.slice(0, 6) === "/*br*/" ? plain.slice(6).replace(/\\/\\*[\\s\\S]*?\\*\\//g, "").trim() : "";\n' +
     '        if (text && !kdModernRule.test(text) && /^\\.[\\w-]+\\s*\\{[^{}]*\\}$/.test(text)) {\n' +
     '            try {\n                return new KdSharedCssRule(key, className, properties, text, insert);\n            } catch (e) {}\n' +
     '        }\n' +
     '    }\n' +
     '    return new Original(key, className, container, properties);\n' +
     '}\n'],
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

// The styles VS Code writes into <style> elements at run time - a list's colours, a tree's indent guides, a menu's, the
// quick input's, the breadcrumbs', the editor's decoration rules: through vsc-prelude's __kd_plainStyle, which gives a
// style that only lacks the theme's variables their values and the rewriter's mark. The engine's shim rewrote every
// such text once more, and the old WebKit made its rule sets again for the changed text (the first command palette of
// a start, the first menu, the first suggestions).
function plainStyles() {
  const prefix = 'const __kdPlain = (text) => typeof window !== "undefined" && window.__kd_plainStyle ? window.__kd_plainStyle(text) : text;\n'
  const wrap = (suffix, indent, target, value) =>
    [suffix, [[indent + target + '.textContent = ' + value + ';', indent + target + '.textContent = __kdPlain(' + value + ');']], prefix]
  return patchModules('kodium-plain-styles', [
    wrap('/vs/base/browser/ui/list/listWidget.js', '        ', 'this.styleElement', 'content.join("\\n")'),
    wrap('/vs/base/browser/ui/tree/abstractTree.js', '        ', 'this.styleElement', 'content.join("\\n")'),
    wrap('/vs/base/browser/ui/table/tableWidget.js', '        ', 'this.styleElement', 'content.join("\\n")'),
    wrap('/vs/platform/quickinput/browser/quickInputController.js', '                ', 'this.ui.styleSheet', 'newStyles'),
    wrap('/vs/base/browser/ui/menu/menu.js', '        ', 'this.styleSheet', 'getMenuWidgetCSS(style, isInShadowDOM(container))'),
    wrap('/vs/base/browser/ui/breadcrumbs/breadcrumbsWidget.js', '        ', 'styleElement', 'content'),
    wrap('/vs/editor/browser/editorDom.js', '        ', 'this._styleElement', 'this.getCssText(this.className, this.properties)'),
    wrap('/vs/base/browser/domStylesheets.js', '            ', 'this._styleSheet', 'cssStyle')
  ])
}

// A list's, a tree's and a table's style (colours, focus outlines, indent guides) was a <style> in the widget's own DOM,
// which VS Code takes out of the page with its view and puts back when the view comes again: the old WebKit parsed it
// again and made the rule sets of the whole page anew at once, for each such style (the Explorer's five, the Problems'
// two - the 150 ms of putting the Problems view back as the panel showed), and twice as a widget was made (the style
// went in empty, then got its text). Now its rules go into one shared sheet in the head (vsc-prelude.js
// __kd_sheetStyle), the rule sets are made once at the next frame, and they come out when the widget is disposed.
function sharedListStyles() {
  const prefix = 'const kdSheetStyle = (store) => typeof window !== "undefined" && window.__kd_sheetStyle ? window.__kd_sheetStyle(store) : null;\n'
  return patchModules('kodium-shared-list-styles', [
    ['/vs/base/browser/ui/list/listWidget.js', [
      ['            const styleElement = createStyleSheet(this.view.domNode);\n',
       '            const styleElement = kdSheetStyle(this.disposables) || createStyleSheet(this.view.domNode);\n'],
      // (a style controller of the widget's own - the Settings editor's trees - with a shared style: out with the list)
      ['            this.styleController = _options.styleController(this.view.domId);\n',
       '            this.styleController = _options.styleController(this.view.domId);\n' +
       '            const kdOwn = this.styleController && this.styleController.styleElement;\n' +
       '            if (kdOwn && kdOwn.kdShared) {\n                this.disposables.add({ dispose: () => kdOwn.remove() });\n            }\n']], prefix],
    // (the Settings editor's two trees made their own style controllers, each with a <style> in the tree's container,
    // which went into the page again seven times as the editor opened)
    ['/vs/workbench/contrib/preferences/browser/tocTree.js', [
      ['            styleController: id => ( new DefaultStyleController(createStyleSheet(container), id)),\n',
       '            styleController: id => ( new DefaultStyleController(kdSheetStyle(null) || createStyleSheet(container), id)),\n']], prefix],
    ['/vs/workbench/contrib/preferences/browser/settingsTree.js', [
      ['            styleController: id => ( new DefaultStyleController(createStyleSheet(container), id)),\n',
       '            styleController: id => ( new DefaultStyleController(kdSheetStyle(null) || createStyleSheet(container), id)),\n']], prefix],
    ['/vs/base/browser/ui/tree/abstractTree.js', [
      ['        this.styleElement = createStyleSheet(this.view.getHTMLElement());\n',
       '        this.styleElement = kdSheetStyle(this.disposables) || createStyleSheet(this.view.getHTMLElement());\n']], prefix],
    ['/vs/base/browser/ui/table/tableWidget.js', [
      ['        this.styleElement = createStyleSheet(this.domNode);\n',
       '        this.styleElement = kdSheetStyle(this.disposables) || createStyleSheet(this.domNode);\n']], prefix],
    // (the breadcrumbs' too: each new editor group made one, opening the Markdown preview to the side)
    ['/vs/base/browser/ui/breadcrumbs/breadcrumbsWidget.js', [
      ['        const styleElement = createStyleSheet(this._domNode);\n',
       '        const styleElement = kdSheetStyle(this._disposables) || createStyleSheet(this._domNode);\n']], prefix]
  ])
}

// A file's line starts - read when it opens, and of every piece of text an edit adds - were found by a charCodeAt loop
// over all its characters (also asking each whether it is plain ASCII): 70,000 calls for a file of 70 KB, half of its
// reading on the iPad 2 in the profiler. The line breaks are found with indexOf and the ASCII question with one
// regular expression now - both native - when the text has no carriage return other than in \r\n (else the loop).
function quickerLineStarts() {
  return patchModules('kodium-quicker-line-starts', [
    ['/vs/editor/common/model/pieceTreeTextBuffer/pieceTreeBase.js', [
      ['function createLineStartsFast(str, readonly = true) {\n    const r = [0];\n    let rLength = 1;\n',
       'function createLineStartsFast(str, readonly = true) {\n    const r = [0];\n    let rLength = 1;\n' +
       '    if (str.indexOf("\\r") === -1) {\n' +
       '        for (let at = str.indexOf("\\n"); at !== -1; at = str.indexOf("\\n", at + 1)) {\n            r[rLength++] = at + 1;\n        }\n' +
       '        return readonly ? createUintArray(r) : r;\n' +
       '    }\n'],
      ['    let cr = 0, lf = 0, crlf = 0;\n    let isBasicASCII = true;\n    for (let i = 0, len = str.length; i < len; i++) {\n',
       '    let cr = 0, lf = 0, crlf = 0;\n    let isBasicASCII = true;\n' +
       '    const kdFound = kdLineStarts(r, str);\n' +
       '    if (kdFound) {\n' +
       '        const kdResult = ( new LineStarts(createUintArray(r), 0, kdFound.lf, kdFound.crlf, kdFound.isBasicASCII));\n' +
       '        r.length = 0;\n' +
       '        return kdResult;\n' +
       '    }\n' +
       '    for (let i = 0, len = str.length; i < len; i++) {\n'],
      // (and the typed array filled by a loop: core-js's set() for typed arrays is a generic loop of its own)
      ['    r.set(arr, 0);\n    return r;\n}', '    for (let i = 0; i < arr.length; i++) {\n        r[i] = arr[i];\n    }\n    return r;\n}']],
     'function kdLineStarts(r, str) {\n' +
     '    let carriageReturns = 0;\n' +
     '    for (let at = str.indexOf("\\r"); at !== -1; at = str.indexOf("\\r", at + 1)) {\n        carriageReturns++;\n    }\n' +
     '    let rLength = 1, lf = 0, crlf = 0;\n' +
     '    for (let at = str.indexOf("\\n"); at !== -1; at = str.indexOf("\\n", at + 1)) {\n' +
     '        if (at > 0 && str.charCodeAt(at - 1) === 13) {\n            crlf++;\n        } else {\n            lf++;\n        }\n' +
     '        r[rLength++] = at + 1;\n' +
     '    }\n' +
     '    if (carriageReturns !== crlf) {\n        r.length = 1;\n        return null;\n    }\n' +
     '    return { lf, crlf, isBasicASCII: !/[^\\t\\n\\r\\x20-\\x7e]/.test(str) };\n' +
     '}\n']
  ])
}

// A tree given its items - the command palette's ~490 commands at every opening, Go to File's files, the Explorer's,
// the settings' - went through them with generators (ES5 here: a regenerator state machine per item, 2-3 of them for
// each, its empty children's too), and the list asked its focus, selection and anchor about every item: an empty trait
// still asked the engine's Set shim (1,500 calls), and the traits' look for their items among the deleted and inserted
// ones filled a Set and a Map of the shim with all of them (in the profiler 40 % of the palette's opening). The items
// go through arrays now, an empty trait answers at once, and the look-up uses plain objects.
function quickerTrees() {
  const mapNow = 'function kdMapNow(items, fn) {\n' +
    '    const out = [];\n' +
    '    if (Array.isArray(items)) {\n        for (let i = 0; i < items.length; i++) {\n            out[i] = fn(items[i], i);\n        }\n        return out;\n    }\n' +
    '    let i = 0;\n' +
    '    for (const item of items) {\n        out[i] = fn(item, i);\n        i++;\n    }\n' +
    '    return out;\n' +
    '}\n'
  const kdArray = 'function kdArray(items) {\n' +
    '    if (!items) {\n        return [];\n    }\n' +
    '    if (Array.isArray(items)) {\n        return items;\n    }\n' +
    '    const out = [];\n' +
    '    for (const item of items) {\n        out.push(item);\n    }\n' +
    '    return out;\n' +
    '}\n'
  return patchModules('kodium-quicker-trees', [
    // (and the elements not sorted while their sorter says it keeps them as they are: the command palette's and Go to
    // Symbol's lists without a filter - ~4,000 comparisons of 500 picks that all answered 0)
    ['/vs/base/browser/ui/tree/objectTreeModel.js', [
      ['            this.sorter = {\n                compare(a, b) {\n                    return options.sorter.compare(a.element, b.element);\n                }\n            };\n',
       '            this.sorter = {\n                compare(a, b) {\n                    return options.sorter.compare(a.element, b.element);\n                },\n' +
       '                kdKeepsOrder() {\n                    return !!options.sorter.kdKeepsOrder && options.sorter.kdKeepsOrder();\n                }\n            };\n'],
      // (- and a node's children already in order - the Outline's symbols by their places, a leaf's none - are not
      // sorted again: a look along them, the engine's sort only when one is out of order; a stable sort leaves them so)
      ['    preserveCollapseState(elements = Iterable.empty()) {\n        if (this.sorter) {\n            elements = [...elements].sort(this.sorter.compare.bind(this.sorter));\n        }\n        return Iterable.map(elements, treeElement => {\n',
       '    preserveCollapseState(elements = Iterable.empty()) {\n        if (this.sorter && !this.sorter.kdKeepsOrder()) {\n            elements = kdSortedCopy(elements, this.sorter);\n        }\n        return kdMapNow(elements, treeElement => {\n']],
     mapNow +
     'function kdSortedCopy(elements, sorter) {\n' +
     '    const items = Array.isArray(elements) ? elements : [...elements];\n' +
     '    for (let i = 1; i < items.length; i++) {\n' +
     '        if (sorter.compare(items[i - 1], items[i]) > 0) {\n' +
     '            return (items === elements ? items.slice() : items).sort(sorter.compare.bind(sorter));\n' +
     '        }\n' +
     '    }\n' +
     '    return items;\n' +
     '}\n'],
    ['/vs/platform/quickinput/browser/quickInputList.js', [
      ['                sorter: {\n                    compare: (element, otherElement) => {\n                        if (!this.sortByLabel || !this._lastQueryString) {\n                            return 0;\n                        }\n',
       '                sorter: {\n                    kdKeepsOrder: () => !this.sortByLabel || !this._lastQueryString,\n                    compare: (element, otherElement) => {\n                        if (!this.sortByLabel || !this._lastQueryString) {\n                            return 0;\n                        }\n']]],
    ['/vs/base/browser/ui/tree/indexTreeModel.js', [
      ['        const nodesToInsertIterator = Iterable.map(toInsert, el => this.createTreeNode(\n',
       '        const nodesToInsertIterator = kdMapNow(toInsert, el => this.createTreeNode(\n']],
     mapNow],
    // (an async data tree - the Search view's results - gave each node's children as a generator at every refresh,
    // which its model reads to the end anyway: an array now)
    ['/vs/base/browser/ui/tree/asyncDataTree.js', [
      ['            children: node.hasChildren ? Iterable.map(node.children, child => this.asTreeElement(child, viewStateContext)) : [],\n',
       '            children: node.hasChildren ? node.children.map(child => this.asTreeElement(child, viewStateContext)) : [],\n'],
      ['            children = Iterable.filter(children, e => {\n                const result = this.filter.filter(e, TreeVisibility.Visible);\n',
       '            children = kdArray(children).filter(e => {\n                const result = this.filter.filter(e, TreeVisibility.Visible);\n'],
      // (- and a node's children whose own children come at once - the Search view's results: each file's matches -
      // are refreshed in one go, not each through its own cancelable promise, two async functions and their awaits: a
      // search's results went through that ~300 times at every update, ES5's regenerator and the promise polyfill
      // ~2 s on the iPad 2; a child whose children come later, or one being refreshed already, goes the usual way)
      ['            await Promises.settled(\n                childrenToRefresh.map(child => this.doRefreshSubTree(child, recursive, viewStateContext))\n            );\n',
       '            await Promises.settled(\n                this.kdRefreshNow(childrenToRefresh, recursive, viewStateContext).map(child => this.doRefreshSubTree(child, recursive, viewStateContext))\n            );\n'],
      ['    async doRefreshNode(node, recursive, viewStateContext) {\n',
       '    kdRefreshNow(nodes, recursive, viewStateContext) {\n' +
       '        const later = [];\n' +
       '        const stack = nodes.slice().reverse();\n' +
       '        while (stack.length) {\n' +
       '            const child = stack.pop();\n' +
       '            if (child.refreshPromise || this.refreshPromises.get(child)) {\n                later.push(child);\n                continue;\n            }\n' +
       '            child.hasChildren = !!this.dataSource.hasChildren(child.element);\n' +
       '            let elements = [];\n' +
       '            if (child.hasChildren) {\n' +
       '                const got = this.doGetChildren(child);\n' +
       '                if (!isIterable(got)) {\n                    later.push(child);\n                    continue;\n                }\n' +
       '                elements = got;\n' +
       '            }\n' +
       '            const grandChildren = this.setChildren(child, elements, recursive, viewStateContext);\n' +
       '            child.stale = false;\n' +
       '            for (let i = grandChildren.length - 1; i >= 0; i--) {\n                stack.push(grandChildren[i]);\n            }\n' +
       '        }\n' +
       '        return later;\n' +
       '    }\n' +
       '    async doRefreshNode(node, recursive, viewStateContext) {\n']],
     kdArray],
    // (- and a compressed tree's - the Search view's results - compressed, decompressed, recompressed and spliced its
    // elements' children through generators at every update: ~3.7 ms an element on the iPad 2, a second for the first
    // 150 files of a search; arrays now)
    ['/vs/base/browser/ui/tree/compressedObjectTreeModel.js', [
      ['        children: Iterable.map(Iterable.from(element.children), noCompress),\n',
       '        children: kdArray(element.children).map(noCompress),\n'],
      ['        [children, childrenIterator] = Iterable.consume(Iterable.from(element.children), 2);\n',
       '        children = kdArray(element.children);\n        childrenIterator = undefined;\n'],
      ['        children: Iterable.map(Iterable.concat(children, childrenIterator), compress),\n',
       '        children: children.map(compress),\n'],
      ['        children = Iterable.map(Iterable.from(element.children), el => _decompress(el, 0));\n',
       '        children = kdArray(element.children).map(el => _decompress(el, 0));\n'],
      ['        children: Iterable.map(Iterable.from(treeElement.children), e => splice(e, element, children))\n',
       '        children: kdArray(treeElement.children).map(e => splice(e, element, children))\n'],
      ['            const compressedChildren = Iterable.map(children, this.enabled ? compress : noCompress);\n',
       '            const compressedChildren = kdArray(children).map(this.enabled ? compress : noCompress);\n'],
      ['        const decompressedRootChildren = Iterable.map(rootChildren, decompress);\n        const recompressedRootChildren = Iterable.map(decompressedRootChildren, enabled ? compress : noCompress);\n',
       '        const decompressedRootChildren = kdArray(rootChildren).map(decompress);\n        const recompressedRootChildren = decompressedRootChildren.map(enabled ? compress : noCompress);\n']],
     kdArray],
    ['/vs/base/browser/ui/tree/abstractTree.js', [
      ['    has(node) {\n        return ( this.nodeSet.has(node));\n    }\n    onDidModelSplice(\n        {\n            insertedNodes,\n            deletedNodes\n        }\n    ) {\n',
       '    has(node) {\n        return this.nodes.length > 0 && ( this.nodeSet.has(node));\n    }\n    onDidModelSplice(\n        {\n            insertedNodes,\n            deletedNodes\n        }\n    ) {\n' +
       '        if (this.nodes.length === 0) {\n            return;\n        }\n'],
      ['        const deletedNodesIdSet = ( new Set());\n', '        const deletedNodesIdSet = kdIdTable();\n'],
      ['        const insertedNodesMap = ( new Map());\n', '        const insertedNodesMap = kdIdTable();\n']],
     'function kdIdTable() {\n' +
     '    const table = Object.create(null);\n' +
     '    return {\n' +
     '        add(id) {\n            table["k" + id] = true;\n        },\n' +
     '        has(id) {\n            return table["k" + id] !== undefined;\n        },\n' +
     '        set(id, value) {\n            table["k" + id] = value;\n        },\n' +
     '        get(id) {\n            return table["k" + id];\n        }\n' +
     '    };\n' +
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
    // (the editor's worker computes a diff, and a diff opened a minute after the last use waited for its start - its
    // 425 KB loaded and run, 1.15 s on the iPad 2, of the first diff's 2-4 s. While the worker is not there, a diff of
    // files up to 1,000 lines in all is computed in the page - the worker's own code (tools/quicker-diffs.mjs), a few
    // ms; one that takes more than 300 ms goes to the worker after all -, and one of a few hundred lines always is (the
    // way to the worker and back took 50-140 ms); the diff editor starts the worker as it begins, for bigger diffs and
    // the links: kdLocalDiff, kdStart)
    ['/vs/editor/browser/services/editorWorkerService.js', [
      ['const STOP_WORKER_DELTA_TIME_MS = 5 * 60 * 1000;', 'const STOP_WORKER_DELTA_TIME_MS = 60 * 1000;'],
      ['    canComputeUnicodeHighlights(uri) {\n',
       '    kdStart() {\n        this._workerManager.withWorker().then(client => client._getProxy()).then(undefined, () => undefined);\n    }\n' +
       '    kdLocalDiff(original, modified, options, algorithm) {\n' +
       '        const a = this._modelService.getModel(original), b = this._modelService.getModel(modified);\n' +
       '        if (!a || !b || (algorithm !== "advanced" && algorithm !== "legacy")) {\n            return null;\n        }\n' +
       '        const lines = a.getLineCount() + b.getLineCount(), length = a.getValueLength() + b.getValueLength();\n' +
       '        const client = this._workerManager._editorWorkerClient;\n' +
       '        const ready = !!(client && client.kdReady);\n' +
       '        if (!ready) {\n            this.kdStart();\n        }\n' +
       // (files of a few hundred lines in the page even with the worker there: quicker than the way to it and back)
       '        if (lines > 1000 || length > 60000 || ready && (lines > 600 || length > 30000)) {\n            return null;\n        }\n' +
       '        try {\n' +
       '            const computer = algorithm === "legacy" ? kdLinesDiffComputers.getLegacy() : kdLinesDiffComputers.getDefault();\n' +
       '            const result = EditorWorker.computeDiff(a, b, { ...options, maxComputationTimeMs: Math.min(options.maxComputationTimeMs || 300, 300) }, computer);\n' +
       '            return result.quitEarly ? null : result;\n' +
       '        } catch (e) {\n            return null;\n        }\n' +
       '    }\n' +
       '    canComputeUnicodeHighlights(uri) {\n'],
      ['        const worker = await this._workerWithResources([original, modified],  true);\n        const result = await worker.$computeDiff(( original.toString()), ( modified.toString()), options, algorithm);\n',
       '        let result = this.kdLocalDiff(original, modified, options, algorithm);\n        if (!result) {\n' +
       '            const worker = await this._workerWithResources([original, modified],  true);\n            result = await worker.$computeDiff(( original.toString()), ( modified.toString()), options, algorithm);\n        }\n'],
      ['            await proxy.$ping();\n            return proxy;\n', '            await proxy.$ping();\n            this.kdReady = true;\n            return proxy;\n'],
      // (and the words of the file for the suggestions: in the page too while the worker is not there - the suggest
      // key tapped a minute after the last use waited for the worker's start, 1.1 s - for files up to 60 KB, as the
      // worker finds them; the worker is started meanwhile)
      ['        const client = await this._workerManager.withWorker();\n        const data = await client.textualSuggest(models, word?.word, wordDefRegExp);\n',
       '        const data = kdLocalWords(this._workerManager, this._modelService, models, word?.word, wordDefRegExp) ||\n' +
       '            await (await this._workerManager.withWorker()).textualSuggest(models, word?.word, wordDefRegExp);\n']],
     'import { linesDiffComputers as kdLinesDiffComputers } from "../../common/diff/linesDiffComputers.js";\n' +
     'function kdLocalWords(manager, modelService, uris, leading, wordDef) {\n' +
     '    const client = manager._editorWorkerClient;\n' +
     '    if (client && client.kdReady) {\n        return null;\n    }\n' +
     '    manager.withWorker().then(c => c._getProxy()).then(undefined, () => undefined);\n' +
     '    const models = [];\n' +
     '    let chars = 0;\n' +
     '    for (const uri of uris) {\n' +
     '        const m = modelService.getModel(uri);\n' +
     '        if (m) {\n            models.push(m);\n            chars += m.getValueLength();\n        }\n' +
     '    }\n' +
     '    if (!models.length || chars > 60000) {\n        return null;\n    }\n' +
     '    const t0 = Date.now();\n' +
     '    const re = new RegExp(wordDef.source, "g" + (wordDef.ignoreCase ? "i" : "") + (wordDef.multiline ? "m" : ""));\n' +
     '    const seen = Object.create(null), words = [];\n' +
     '    outer: for (const m of models) {\n' +
     '        const count = m.getLineCount();\n' +
     '        for (let line = 1; line <= count; line++) {\n' +
     '            const text = m.getLineContent(line);\n' +
     '            re.lastIndex = 0;\n' +
     '            let match;\n' +
     '            while ((match = re.exec(text))) {\n' +
     '                const w = match[0];\n' +
     '                if (w.length === 0) {\n                    break;\n                }\n' +
     '                if (w === leading || seen["k" + w] !== undefined) {\n                    continue;\n                }\n' +
     '                const first = w.charCodeAt(0);\n' +
     '                if ((first >= 48 && first <= 57 || first === 45 || first === 46 || first === 73) && !isNaN(Number(w))) {\n                    seen["k" + w] = 2;\n                    continue;\n                }\n' +
     '                seen["k" + w] = 1;\n' +
     '                words.push(w);\n' +
     '                if (words.length > 10000) {\n                    break outer;\n                }\n' +
     '            }\n' +
     '        }\n' +
     '    }\n' +
     '    return { words, duration: Date.now() - t0 };\n' +
     '}\n'],
    ['/vs/workbench/browser/parts/editor/textDiffEditor.js', [
      ['    createEditorControl(parent, configuration) {\n',
       '    createEditorControl(parent, configuration) {\n        kdStartEditorWorker(this.instantiationService);\n'],
      ['        this.inputLifecycleStopWatch = undefined;\n        await super.setInput(input, options, context, token);\n',
       '        this.inputLifecycleStopWatch = undefined;\n        kdStartEditorWorker(this.instantiationService);\n        await super.setInput(input, options, context, token);\n']],
     'import { IEditorWorkerService as KdEditorWorkerService } from "../../../../editor/common/services/editorWorker.service.js";\n' +
     'function kdStartEditorWorker(instantiationService) {\n' +
     '    try {\n' +
     '        const service = instantiationService.invokeFunction(accessor => accessor.get(KdEditorWorkerService));\n' +
     '        if (service && service.kdStart) {\n            service.kdStart();\n        }\n' +
     '    } catch (e) {}\n' +
     '}\n']
  ])
}

// Tabular figures (font-variant-numeric: tabular-nums, which the engine's rewriter makes the feature setting 'tnum') on
// the line numbers and the status bar's items: any feature setting sends text through Core Text's complex path (see
// smootherEditor), here for every line number a scroll brings in (97 -> 88 ms a frame). The digits of iOS 6's Courier
// and Helvetica are of one width anyway. Taken out of VS Code's stylesheets before the rewriter, which drops a rule
// that only sets the feature settings back to normal.
function plainFigures() {
  const files = ['/vs/editor/browser/viewParts/lineNumbers/lineNumbers.css',
    '/vs/workbench/browser/parts/statusbar/media/statusbarpart.css']
  return {
    name: 'kodium-plain-figures',
    enforce: 'pre',
    transform(code, id) {
      const p = id.replace(/\\/g, '/').replace(/\?.*$/, '')
      if (!files.some((f) => p.endsWith(f))) return null
      if (code.split('font-variant-numeric: tabular-nums;').length !== 2) this.error('kodium-plain-figures: ' + p + ' has another form')
      return { code: code.replace('font-variant-numeric: tabular-nums;', ''), map: null }
    }
  }
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
//   typing pauses (1 s, 0.3 s) - the bracket's 0.3 s from the next frame on: an opened file's model, cursor and focus
//   set it going, and it fell between the opening and the file's first frame (10-50 ms with the brackets' tree of the
//   whole file built).
// - ligatures off was the CSS font-feature-settings "liga" off, "calt" off on the editor's lines (and the suggestions'):
//   any feature settings make the iOS 6 engine set every run of text through Core Text's complex path, which it
//   otherwise takes only for scripts that need it - a sixth of the time of scrolling. Off is no feature settings now:
//   the simple path has no ligatures (a scroll of 3 lines took 113 ms a frame instead of 138).
// - the editor asked at every frame whether a screen reader is in use (to fill its hidden text area), which inspected
//   the setting editor.accessibilitySupport in every settings layer (a merge of the configuration models each time):
//   the answer is kept until that setting changes.
// - the indent guides took the indentation of every line on the screen at every frame of a scroll (each line's text
//   made from the piece tree and scanned), and of the lines around the cursor for the active guide: kept per line
//   while the text and the tab size stay the same.
// - the state VS Code stores every 5 s when the page is idle (between keys, too) had the editor resolver inspect two
//   settings (workbench.editorAssociations and the diff one) in every settings layer - half of the store's 0.12 s in
//   a profile: the associations are kept until the configuration changes.
// - every Enter (and every line joined) worked all ~160 editor options out again and compared them with the old ones,
//   for the new number of lines - which only the minimap's layout reads, and Kodium's minimap is off: with it off, the
//   number is noted for when it comes on (17 ms of an Enter's 70 in the profiler).
// - the history of places (Go Back) replaces its last entry at every move of the cursor while typing, and with it took
//   the entry's editor's dispose listener off and put it on again - the same editor (three times a key): it stays now.
// - a line's height and the heights of the lines above it - asked ~365 times a frame while scrolling - were a binary
//   search, with a closure, over the lines of special heights, which Kodium's editors have none of: with none, the
//   default height (times the lines) at once, as the search ended anyway.
// - the indent guides of every line on the screen, at every frame of a scroll, went through a queue of the line's
//   bracket pair guides - which are off - with two spreads per guide (lowered to ES5: copies through slice) and the
//   engine's push: without bracket pair guides, the indent guides alone (an eighth of a scroll frame in the profiler).
// - every key typed asks whether it should indent its line anew (the language's indentation rules), on the line's text
//   with the brackets inside strings, comments and regular expressions taken out - new tokens made for that, sliced,
//   typed arrays: 13 ms of a key in the profiler. A line with no bracket in such a token is that text already: taken as
//   it is (the same answers).
function smootherEditor() {
  return patchModules('kodium-smoother-editor', [
    ['/vs/editor/common/languages/autoIndent.js', [
      ['    const indentationContextProcessor = ( new IndentationContextProcessor(model, languageConfigurationService));\n' +
       '    const processedContextTokens = indentationContextProcessor.getProcessedTokenContextAroundRange(range);\n' +
       '    const beforeRangeText = processedContextTokens.beforeRangeProcessedTokens.getLineContent();\n' +
       '    const afterRangeText = processedContextTokens.afterRangeProcessedTokens.getLineContent();\n' +
       '    const textAroundRange = beforeRangeText + afterRangeText;\n' +
       '    const textAroundRangeWithCharacter = beforeRangeText + ch + afterRangeText;\n' +
       '    if (!indentRulesSupport.shouldDecrease(textAroundRange)',
       '    let beforeRangeText, afterRangeText;\n' +
       '    const kdLine = kdPlainLine(model, range, languageConfigurationService, languageId);\n' +
       '    if (kdLine !== null) {\n' +
       '        beforeRangeText = kdLine.substring(0, range.startColumn - 1);\n' +
       '        afterRangeText = kdLine.substring(range.endColumn - 1);\n' +
       '    } else {\n' +
       '        const indentationContextProcessor = ( new IndentationContextProcessor(model, languageConfigurationService));\n' +
       '        const processedContextTokens = indentationContextProcessor.getProcessedTokenContextAroundRange(range);\n' +
       '        beforeRangeText = processedContextTokens.beforeRangeProcessedTokens.getLineContent();\n' +
       '        afterRangeText = processedContextTokens.afterRangeProcessedTokens.getLineContent();\n' +
       '    }\n' +
       '    const textAroundRange = beforeRangeText + afterRangeText;\n' +
       '    const textAroundRangeWithCharacter = beforeRangeText + ch + afterRangeText;\n' +
       '    if (!indentRulesSupport.shouldDecrease(textAroundRange)']],
     '// (the line as it is - one language on it, no bracket in a string, comment or regex token - or null)\n' +
     'function kdPlainLine(model, range, languageConfigurationService, languageId) {\n' +
     '    if (range.startLineNumber !== range.endLineNumber) {\n        return null;\n    }\n' +
     '    const lineNumber = range.startLineNumber;\n' +
     '    model.tokenization.forceTokenization(lineNumber);\n' +
     '    const tokens = model.tokenization.getLineTokens(lineNumber);\n' +
     '    const text = tokens.getLineContent();\n' +
     '    const brackets = languageConfigurationService.getLanguageConfiguration(languageId).bracketsNew;\n' +
     '    let test = brackets.kdTest;\n' +
     '    if (test === undefined) {\n        test = brackets.kdTest = brackets.getBracketRegExp();\n    }\n' +
     '    const anyBracket = !!test && test.test(text);\n' +
     '    for (let i = 0, n = tokens.getCount(); i < n; i++) {\n' +
     '        if (tokens.getLanguageId(i) !== languageId) {\n            return null;\n        }\n' +
     '        const type = anyBracket ? tokens.getStandardTokenType(i) : 0;\n' +
     '        if ((type === 1 || type === 2 || type === 3) && test.test(text.substring(tokens.getStartOffset(i), tokens.getEndOffset(i)))) {\n            return null;\n        }\n' +
     '    }\n' +
     '    return text;\n' +
     '}\n'],
    ['/vs/editor/browser/viewParts/indentGuides/indentGuides.js', [
      ['        const result = [];\n        for (let lineNumber = visibleStartLineNumber; lineNumber <= visibleEndLineNumber; lineNumber++) {\n            const lineGuides = ( new Array());',
       '        const result = [];\n' +
       '        if (!bracketGuides) {\n' +
       '            for (let lineNumber = visibleStartLineNumber; lineNumber <= visibleEndLineNumber; lineNumber++) {\n' +
       '                const lineGuides = [];\n' +
       '                result[result.length] = lineGuides;\n' +
       '                const indentGuidesInLine = indentGuides ? indentGuides[lineNumber - visibleStartLineNumber] : 0;\n' +
       '                for (let indentLvl = 1; indentLvl <= indentGuidesInLine; indentLvl++) {\n' +
       '                    const isActive = activeIndentStartLineNumber <= lineNumber && lineNumber <= activeIndentEndLineNumber && indentLvl === activeIndentLevel;\n' +
       '                    lineGuides[lineGuides.length] = new IndentGuide((indentLvl - 1) * indentSize + 1, -1, "core-guide-indent lvl-" + ((indentLvl - 1) % 30) + (isActive ? " indent-active" : ""), null, -1, -1);\n' +
       '                }\n' +
       '            }\n' +
       '            return result;\n' +
       '        }\n' +
       '        for (let lineNumber = visibleStartLineNumber; lineNumber <= visibleEndLineNumber; lineNumber++) {\n            const lineGuides = ( new Array());']]],
    ['/vs/editor/common/viewLayout/lineHeights.js', [
      ['    heightForLineNumber(lineNumber) {\n        this._commit();\n',
       '    heightForLineNumber(lineNumber) {\n        this._commit();\n        if (this._orderedCustomLines.length === 0) {\n            return this._defaultLineHeight;\n        }\n'],
      ['    getAccumulatedLineHeightsIncludingLineNumber(lineNumber) {\n        this._commit();\n',
       '    getAccumulatedLineHeightsIncludingLineNumber(lineNumber) {\n        this._commit();\n        if (this._orderedCustomLines.length === 0) {\n            return this._defaultLineHeight * lineNumber;\n        }\n']]],
    ['/vs/workbench/services/history/browser/historyService.js', [
      ['        for (const removedEntry of removedEntries) {\n            this.editorHelper.clearOnEditorDispose(removedEntry.editor, this.mapEditorToDisposable);\n        }\n' +
       '        if (isEditorInput(editor)) {\n            this.editorHelper.onEditorDispose(editor, () => this.remove(editor), this.mapEditorToDisposable);\n        }\n' +
       '        this._onDidChange.fire();',
       '        const kdSameEditor = replace && removedEntries.length === 1 && removedEntries[0].editor === editor && ( this.mapEditorToDisposable.has(editor));\n' +
       '        if (!kdSameEditor) {\n' +
       '        for (const removedEntry of removedEntries) {\n            this.editorHelper.clearOnEditorDispose(removedEntry.editor, this.mapEditorToDisposable);\n        }\n' +
       '        if (isEditorInput(editor)) {\n            this.editorHelper.onEditorDispose(editor, () => this.remove(editor), this.mapEditorToDisposable);\n        }\n' +
       '        }\n' +
       '        this._onDidChange.fire();']]],
    ['/vs/editor/browser/config/editorConfiguration.js', [
      ['        this._viewLineCount = viewLineCount;\n        this._recomputeOptions();',
       '        this._viewLineCount = viewLineCount;\n' +
       '        if (!this.options.get(EditorOption.minimap).enabled) {\n            return;\n        }\n' +
       '        this._recomputeOptions();']]],
    ['/vs/workbench/services/editor/browser/editorResolverService.js', [
      ['    getAllUserAssociationsForSetting(settingId) {\n        const inspectedEditorAssociations = this.configurationService.inspect(settingId) || {};\n' +
       '        return this.mergeEditorAssociationSettings(\n',
       '    getAllUserAssociationsForSetting(settingId) {\n' +
       '        if (!this.kdAssociations) {\n' +
       '            this.kdAssociations = new Map();\n' +
       '            this._register(this.configurationService.onDidChangeConfiguration(() => this.kdAssociations.clear()));\n' +
       '        }\n' +
       '        let kept = this.kdAssociations.get(settingId);\n' +
       '        if (!kept) {\n' +
       '            kept = this.kdAllUserAssociationsForSetting(settingId);\n' +
       '            this.kdAssociations.set(settingId, kept);\n' +
       '        }\n' +
       '        return kept.slice();\n' +
       '    }\n' +
       '    kdAllUserAssociationsForSetting(settingId) {\n' +
       '        const inspectedEditorAssociations = this.configurationService.inspect(settingId) || {};\n' +
       '        return this.mergeEditorAssociationSettings(\n']]],
    ['/vs/editor/common/model/guidesTextModelPart.js', [
      // (and each line's guides kept while the text and the options are the same: a scroll works out the lines it
      // brings in, not all the lines on the screen at every frame)
      ['    getLinesIndentGuides(startLineNumber, endLineNumber) {\n        this.assertNotDisposed();\n        const lineCount = this.textModel.getLineCount();',
       '    getLinesIndentGuides(startLineNumber, endLineNumber) {\n' +
       '        this.assertNotDisposed();\n' +
       '        const kdKey = this.textModel.getVersionId() + ":" + this.textModel.getOptions().indentSize + ":" + this.textModel.getLanguageId();\n' +
       '        let kd = this.kdGuides;\n' +
       '        if (!kd || kd.key !== kdKey) {\n            kd = this.kdGuides = { key: kdKey, levels: [] };\n        }\n' +
       '        for (let i = startLineNumber; i <= endLineNumber;) {\n' +
       '            if (kd.levels[i] !== undefined) {\n                i++;\n                continue;\n            }\n' +
       '            let j = i;\n' +
       '            while (j < endLineNumber && kd.levels[j + 1] === undefined) {\n                j++;\n            }\n' +
       '            const part = this.kdLinesIndentGuides(i, j);\n' +
       '            for (let k = 0; k < part.length; k++) {\n                kd.levels[i + k] = part[k];\n            }\n' +
       '            i = j + 1;\n' +
       '        }\n' +
       '        return kd.levels.slice(startLineNumber, endLineNumber + 1);\n' +
       '    }\n' +
       '    kdLinesIndentGuides(startLineNumber, endLineNumber) {\n        this.assertNotDisposed();\n        const lineCount = this.textModel.getLineCount();'],
      ['    _computeIndentLevel(lineIndex) {\n        return computeIndentLevel(\n            this.textModel.getLineContent(lineIndex + 1),\n            this.textModel.getOptions().tabSize\n        );\n    }',
       '    _computeIndentLevel(lineIndex) {\n' +
       '        const version = this.textModel.getVersionId();\n' +
       '        const tabSize = this.textModel.getOptions().tabSize;\n' +
       '        let cache = this.kdIndents;\n' +
       '        if (!cache || cache.version !== version || cache.tabSize !== tabSize) {\n' +
       '            cache = this.kdIndents = { version, tabSize, levels: [] };\n' +
       '        }\n' +
       '        let level = cache.levels[lineIndex];\n' +
       '        if (level === undefined) {\n' +
       '            level = cache.levels[lineIndex] = computeIndentLevel(this.textModel.getLineContent(lineIndex + 1), tabSize);\n' +
       '        }\n' +
       '        return level;\n' +
       '    }']]],
    ['/vs/editor/common/config/editorOptions.js', [
      ['        this.OFF = "\\"liga\\" off, \\"calt\\" off";', '        this.OFF = "";']]],
    ['/vs/platform/accessibility/browser/accessibilityService.js', [
      ['            if (e.affectsConfiguration("editor.accessibilitySupport")) {\n                updateContextKey();',
       '            if (e.affectsConfiguration("editor.accessibilitySupport")) {\n                this.kdSupportValue = undefined;\n                updateContextKey();'],
      ['    getAccessibilitySupportConfigurationValue() {\n        const inspectedValue =',
       '    getAccessibilitySupportConfigurationValue() {\n' +
       '        if (this.kdSupportValue === undefined) {\n' +
       '            this.kdSupportValue = this.kdSupportValueNow();\n' +
       '        }\n' +
       '        return this.kdSupportValue;\n' +
       '    }\n' +
       '    kdSupportValueNow() {\n        const inspectedValue =']]],
    ['/vs/editor/browser/viewParts/viewLines/viewLine.js', [
      ['    if (isLinux || isFirefox || isSafari) {', '    if (isLinux || isFirefox) {']]],
    ['/vs/editor/browser/config/fontMeasurements.js', [
      ['const rightwardsArrow = this._createRequest("→", CharWidthRequestType.Regular, all, monospace);',
       'const rightwardsArrow = this._createRequest("→", CharWidthRequestType.Regular, all, null);']]],
    ['/vs/editor/contrib/folding/browser/folding.js', [
      ['            min: 200\n', '            min: 1000\n'],
      // (whether an edit since the regions' last update added or took lines: see foldingModel.js below)
      ['    onDidChangeModelContent(e) {\n',
       '    onDidChangeModelContent(e) {\n' +
       '        if (this.foldingModel && (e.isFlush || e.changes.some(c => c.range.startLineNumber !== c.range.endLineNumber || /[\\r\\n]/.test(c.text)))) {\n' +
       '            this.foldingModel.kdLinesMoved = true;\n' +
       '        }\n']]],
    // (an edit tells the decorations' listeners that the decorations changed - they moved with the text - and the view
    // then built every drawn line's rendering again to compare, ~55 lines at every key: 300-400 KB of garbage and the
    // most of the frame's own script. The lines an edit touches are drawn again for the edit itself, and a decoration
    // that only moved with it changes no other line: such a change - an edit's alone, nothing else in the same batch -
    // now says so, and the drawn lines are left as they are for it)
    ['/vs/editor/common/model/textModel.js', [
      ['    checkAffectedAndFire(options) {\n', '    checkAffectedAndFire(options) {\n        this.kdOther = true;\n'],
      ['    fire() {\n        this._affectsMinimap = true;\n        this._affectsOverviewRuler = true;\n        this._affectsGlyphMargin = true;\n        this.tryFire();\n    }\n',
       '    fire() {\n        this.kdOther = true;\n        this._affectsMinimap = true;\n        this._affectsOverviewRuler = true;\n        this._affectsGlyphMargin = true;\n        this.tryFire();\n    }\n' +
       '    kdFireForEdit() {\n        this.kdEdit = true;\n        this._affectsMinimap = true;\n        this._affectsOverviewRuler = true;\n        this._affectsGlyphMargin = true;\n        this.tryFire();\n    }\n'],
      ['            affectsLineNumber: this._affectsLineNumber\n        };\n',
       '            affectsLineNumber: this._affectsLineNumber,\n            kdEditOnly: !!this.kdEdit && !this.kdOther\n        };\n        this.kdEdit = false;\n        this.kdOther = false;\n'],
      ['                this._onDidChangeDecorations.fire();\n                const startLineNumber = change.range.startLineNumber;\n',
       '                this._onDidChangeDecorations.kdFireForEdit();\n                const startLineNumber = change.range.startLineNumber;\n']]],
    ['/vs/editor/common/viewEvents.js', [
      ['            this.affectsLineNumber = source.affectsLineNumber;\n        }\n',
       '            this.affectsLineNumber = source.affectsLineNumber;\n            this.kdEditOnly = !!source.kdEditOnly;\n        }\n']]],
    ['/vs/editor/browser/viewParts/viewLines/viewLines.js', [
      ['    onDecorationsChanged(e) {\n        const rendStartLineNumber = this._visibleLines.getStartLineNumber();\n',
       '    onDecorationsChanged(e) {\n        if (e.kdEditOnly) {\n            return false;\n        }\n        const rendStartLineNumber = this._visibleLines.getStartLineNumber();\n']]],
    // (the regions by indentation read the file line by line from the end, each line looked up in the text's piece
    // tree on its own: now its lines at once - 22 -> 8 ms for 1,500 lines on the iPad 2, in every pause of typing)
    ['/vs/editor/contrib/folding/browser/indentRangeProvider.js', [
      ['    for (let line = model.getLineCount(); line > 0; line--) {\n        const lineContent = model.getLineContent(line);\n',
       '    const kdLines = model.getLinesContent();\n    for (let line = model.getLineCount(); line > 0; line--) {\n        const lineContent = kdLines[line - 1];\n']]],
    // (the folding regions worked out again in every pause of typing replaced all their decorations - and a change of
    // decorations has the view build every drawn line's rendering again to compare: ~0.6 MB of garbage per pause in a
    // file of 1,500 lines - though typing in a line changes none of them. When no edit since the last update added or
    // took lines and the new regions are the old ones, all unfolded and the provider's, nothing is done: the old
    // regions' decorations are on their lines still. That was asked of the decorations themselves before - each one's
    // range worked out from its offsets in the piece tree, two line lengths per region besides: 0.2 s per pause on the
    // iPad 2 for a file of 1,500 lines, now ~5 ms.)
    ['/vs/editor/contrib/folding/browser/foldingModel.js', [
      ['    update(newRegions, selection) {\n',
       '    update(newRegions, selection) {\n' +
       '        if (!this.kdLinesMoved && kdSameRegions(this._regions, newRegions) && this._editorDecorationIds.length === newRegions.length) {\n' +
       '            return;\n' +
       '        }\n'],
      ['    updatePost(newRegions) {\n',
       '    updatePost(newRegions) {\n' +
       '        if (!this.kdLinesMoved && kdSameRegions(this._regions, newRegions) && this._editorDecorationIds.length === newRegions.length) {\n' +
       '            return;\n' +
       '        }\n' +
       '        this.kdLinesMoved = false;\n'],
      ['class FoldingModel {',
       'function kdSameRegions(a, b) {\n' +
       '    if (!a || !b || a.length !== b.length || a.length === 0) {\n        return false;\n    }\n' +
       '    for (let i = 0; i < a.length; i++) {\n' +
       '        if (a.getStartLineNumber(i) !== b.getStartLineNumber(i) || a.getEndLineNumber(i) !== b.getEndLineNumber(i) ||\n' +
       '            a.isCollapsed(i) || b.isCollapsed(i) || a.getSource(i) !== FoldSource.provider || b.getSource(i) !== FoldSource.provider ||\n' +
       '            a.getType(i) !== b.getType(i)) {\n' +
       '            return false;\n' +
       '        }\n' +
       '    }\n' +
       '    return true;\n' +
       '}\n' +
       'class FoldingModel {']]],
    ['/vs/editor/contrib/bracketMatching/browser/bracketMatching.js', [
      ['new RunOnceScheduler(() => this._updateBrackets(), 50)', 'kdAfterFrame(new RunOnceScheduler(() => this._updateBrackets(), 300))'],
      ['class BracketMatchingController extends Disposable {', AFTER_FRAME + 'class BracketMatchingController extends Disposable {']]],
    // (the bracket highlight - the bracket matching the one at the cursor, or the brackets around it - is looked for in
    // the tokens around the cursor, VS Code's search from before the brackets' tree, unless the tree is there already
    // (bracket pair colours or guides make it): the tree of the whole file was built for it right after every opening,
    // 430-570 ms for a file of 1,500 lines on the iPad 2, while one meant to read or type - now 25-32. A typed closing
    // bracket's outdent finds its opening bracket the same way (checked with fast and slow typing: brackcheck.js,
    // electric.js); auto-closing's question whether a closing bracket is missing, below, builds the tree in small files.)
    // (a line up to two after the first one whose tokens are out of date - the line Enter just made - counts as cheap to
    // tokenize when they are short: a closing bracket typed right after Enter outdented only once the background
    // tokenizer had caught up, which Kodium lets wait for a pause of 0.2 s - typed sooner, it stayed where it was)
    ['/vs/editor/common/model/textModelTokens.js', [
      ['        if (lineNumber === firstInvalidLineNumber && this._textModel.getLineLength(lineNumber) < Constants.CHEAP_TOKENIZATION_LENGTH_LIMIT) {\n            return true;\n        }\n        return false;\n    }',
       '        if (lineNumber === firstInvalidLineNumber && this._textModel.getLineLength(lineNumber) < Constants.CHEAP_TOKENIZATION_LENGTH_LIMIT) {\n            return true;\n        }\n' +
       '        if (lineNumber <= firstInvalidLineNumber + 2) {\n' +
       '            for (let kdLine = firstInvalidLineNumber; kdLine <= lineNumber; kdLine++) {\n' +
       '                if (this._textModel.getLineLength(kdLine) >= Constants.CHEAP_TOKENIZATION_LENGTH_LIMIT) {\n                    return false;\n                }\n' +
       '            }\n' +
       '            return true;\n' +
       '        }\n' +
       '        return false;\n    }']]],
    ['/vs/editor/common/model/bracketPairsTextModelPart/bracketPairsImpl.js', [
      ['    findMatchingBracketUp(_bracket, _position, maxDuration) {\n        const position = this.textModel.validatePosition(_position);\n        const languageId = this.textModel.getLanguageIdAtPosition(position.lineNumber, position.column);\n        if (this.canBuildAST) {',
       '    findMatchingBracketUp(_bracket, _position, maxDuration) {\n        const position = this.textModel.validatePosition(_position);\n        const languageId = this.textModel.getLanguageIdAtPosition(position.lineNumber, position.column);\n        if (this.canBuildAST && this.bracketPairsTree.value) {'],
      ['    matchBracket(position, maxDuration) {\n        if (this.canBuildAST) {',
       '    matchBracket(position, maxDuration) {\n        if (this.canBuildAST && this.bracketPairsTree.value) {'],
      // (and the brackets around the cursor, which the bracket highlight shows when the cursor is at none)
      ['    findEnclosingBrackets(_position, maxDuration) {\n        const position = this.textModel.validatePosition(_position);\n        if (this.canBuildAST) {',
       '    findEnclosingBrackets(_position, maxDuration) {\n        const position = this.textModel.validatePosition(_position);\n        if (this.canBuildAST && this.bracketPairsTree.value) {'],
      // (an opening bracket typed in a file of more than 20,000 characters without the tree auto-closes as it did before
      // the tree - without asking whether a closing bracket is missing after it, which built the tree in that key: 0.4 s
      // for 70 KB. In smaller files, and once the tree is there, the question is asked as before.)
      ['        this.bracketsRequested = true;\n        this.updateBracketPairsTree();\n        return this.bracketPairsTree.value?.object.hasUnmatchedClosingBracketAfter(position, openingBracketInfo) ?? false;',
       '        if (!this.bracketPairsTree.value && this.textModel.getValueLength() > 20000) {\n            return false;\n        }\n' +
       '        this.bracketsRequested = true;\n        this.updateBracketPairsTree();\n        return this.bracketPairsTree.value?.object.hasUnmatchedClosingBracketAfter(position, openingBracketInfo) ?? false;']]],
    // The symbols in the breadcrumbs (off by Kodium's default, main.ts): with them off, no outline of the file is kept for
    // the breadcrumbs - it was worked out again at every pause in typing (0.35 s) and followed every move of the cursor
    ['/vs/workbench/browser/parts/editor/breadcrumbsModel.js', [
      ['        this._disposables.add(this._cfgSymbolPath.onDidChange(_ => this._onDidUpdate.fire(this)));',
       '        this._disposables.add(this._cfgSymbolPath.onDidChange(_ => { if (editor) this._bindToEditor(editor); this._onDidUpdate.fire(this); }));'],
      ['        this._outlineDisposables.add(toDisposable(() => newCts.dispose(true)));\n        this._outlineService.createOutline(',
       '        this._outlineDisposables.add(toDisposable(() => newCts.dispose(true)));\n        if (this._cfgSymbolPath.getValue() === "off") return;\n        this._outlineService.createOutline(']]]
  ])
}

// kdAfterFrame(scheduler): a RunOnceScheduler whose delay begins after the next frame - for work that came between an
// editor opened or switched to and the screen (the page draws only once its scripts are done). Meanwhile it counts as
// scheduled (isScheduled()), as its owners want; cancel() and flush() work as before.
const AFTER_FRAME =
  'function kdAfterFrame(scheduler) {\n' +
  '    const schedule = scheduler.schedule;\n' +
  '    scheduler.schedule = function (delay = this.timeout) {\n' +
  '        this.cancel();\n' +
  '        const token = this.timeoutToken = { kdFrame: true };\n' +
  '        requestAnimationFrame(() => {\n' +
  '            if (this.timeoutToken === token) {\n                this.timeoutToken = undefined;\n                schedule.call(this, delay);\n            }\n' +
  '        });\n' +
  '    };\n' +
  '    return scheduler;\n' +
  '}\n'

// Switching between editors on the iPad 2 (1.3-1.8 s, WebKit's profiler: VS Code's reactions to the new editor, each
// a little - but some of them done for nothing):
// - the menus of the menu bar (File, Edit, Selection, View, Go...) were all made again whenever a context they depend on
//   changed - at every switch, and at the start; Kodium's menu bar is the compact one (the button at the top of the
//   activity bar), whose menus are only seen when it opens: they are made then, if something changed since
// - the editor's toolbar (run, preview, split, more...) was made twice per switch: once for the editor that was going
//   (VS Code redraws the tabs before the new editor has its model) and again when its contexts changed: now once, as
//   the switch is done - and not at all when its actions come out the same (a file's first change after a save); its
//   menu is kept while the editor's context is the same (it was made anew at every update)
// - a switch redrew every tab (label, icon, hover, close button, colours: 5-10 ms a tab); with the same tabs and labels
//   only their active, selected and dirty states are drawn again
// - the window's title (which iOS does not show) is put together when nothing is being typed or touched (it was at
//   every switch, and twice per autosave while typing: "dirty")
// - the editor's settings for the file were worked out twice per switch (the model, then the input): once
// - opening a file: the Explorer's Open Editors list is made again after the first frame, not before it, and a file
//   opened into an empty group is laid out for the tabs it brings at once (not again at the first frame); the
//   group's context keys for the new editor reach the workbench's context as one change, not a dozen; a file's
//   language by its name is worked out once, not 7-9 times (tab icon, breadcrumbs, model, its listeners...)
function quickerSwitch() {
  return patchModules('kodium-quicker-switch', [
    // (a switch to a file whose text is there already - another tab - no longer empties the text file editor first:
    // its editor took the old file's view down, told every listener of the editor that it had no model, and then made
    // the new file's view, which its setInput would have done in one step - ~20 ms of a switch on the iPad 2. The view
    // state of the file left - its cursor, its scroll - is kept as the clearing kept it; a file still being read is
    // shown only once it is, as before)
    ['/vs/workbench/browser/parts/editor/editorPanes.js', [
      ['            editorPane.clearInput();\n            const pendingSetInput = editorPane.setInput(editor, options, context, operation.token);\n',
       '            if (kdKeepsInput(editorPane, editor)) {\n                editorPane.saveCurrentEditorViewState();\n            } else {\n                editorPane.clearInput();\n            }\n            const pendingSetInput = editorPane.setInput(editor, options, context, operation.token);\n']],
     'function kdKeepsInput(pane, editor) {\n' +
     '    if (!pane.input || pane.getId() !== "workbench.editors.files.textFileEditor" || editor.typeId !== "workbench.editors.files.fileEditorInput" ||\n' +
     '        typeof pane.saveCurrentEditorViewState !== "function") {\n        return false;\n    }\n' +
     '    const model = editor.model;\n' +
     '    return editor.forceOpenAs !== 2 && !!model && typeof model.isResolved === "function" && model.isResolved() && !!model.textEditorModel;\n' +
     '}\n'],
    ['/vs/workbench/browser/parts/titlebar/menubarControl.js', [
      ['        };\n        for (const title of ( Object.keys(this.topLevelTitles))) {\n            const menu = this.menus[title];',
       '        };\n        this.kdUpdateActions = updateActions;\n        const kdLazy = this.currentCompactMenuMode !== undefined;\n' +
       '        for (const title of ( Object.keys(this.topLevelTitles))) {\n            const menu = this.menus[title];'],
      ['                this.reinstallDisposables.add(menu.onDidChange(() => {\n                    if (!this.focusInsideMenubar) {\n                        const actions = [];\n                        menuChangedDisposable.clear();',
       '                this.reinstallDisposables.add(menu.onDidChange(() => {\n                    if (kdLazy) {\n                        (this.kdDirty || (this.kdDirty = new Set())).add(title);\n                        return;\n                    }\n' +
       '                    if (!this.focusInsideMenubar) {\n                        const actions = [];\n                        menuChangedDisposable.clear();'],
      ['            const actions = [];\n            if (menu) {\n                this.updateActionsDisposables.clear();',
       '            const actions = [];\n            if (menu && kdLazy) {\n                (this.kdDirty || (this.kdDirty = new Set())).add(title);\n            } else if (menu) {\n                this.updateActionsDisposables.clear();'],
      ['            getCompactMenuActions: () => {', '            kdBeforeShow: () => this.kdRefreshMenus(),\n            getCompactMenuActions: () => {'],
      ['    getWebNavigationActions() {\n        if (!isWeb) {',
       '    kdRefreshMenus() {\n' +
       '        const dirty = this.kdDirty;\n' +
       '        if (!dirty || !dirty.size || !this.kdUpdateActions) {\n            return false;\n        }\n' +
       '        this.kdDirty = undefined;\n' +
       '        const stores = this.kdStores || (this.kdStores = new Map());\n' +
       '        for (const title of dirty) {\n' +
       '            const menu = this.menus[title];\n' +
       '            if (!menu) {\n                continue;\n            }\n' +
       '            let store = stores.get(title);\n' +
       '            if (!store) {\n                store = this._register(new DisposableStore());\n                stores.set(title, store);\n            }\n' +
       '            store.clear();\n' +
       '            const actions = [];\n' +
       '            this.kdUpdateActions(this.toActionsArray(menu), actions, title, store);\n' +
       '            this.menubar?.updateMenu({ actions, label: mnemonicMenuLabel(this.topLevelTitles[title]) });\n' +
       '        }\n' +
       '        return true;\n' +
       '    }\n' +
       '    getWebNavigationActions() {\n        if (!isWeb) {']]],
    ['/vs/base/browser/ui/menu/menubar.js', [
      ['    showCustomMenu(menuIndex, selectFirst = true) {\n',
       '    showCustomMenu(menuIndex, selectFirst = true) {\n        if (this.options.kdBeforeShow?.()) {\n            this.updateOverflowAction();\n        }\n']]],
    ['/vs/workbench/browser/parts/editor/multiEditorTabsControl.js', [
      // (a file opened into an empty group: its tabs appear, the group is laid out for them now - the editor got the
      // whole height first, then at the first frame the tabs' height and so a second layout and drawing: 40-70 ms)
      ['    handleOpenedEditors() {\n        this.updateTabsControlVisibility();\n',
       '    handleOpenedEditors() {\n        const kdWasEmpty = !!this.tabsAndActionsContainer?.classList.contains("empty");\n        this.updateTabsControlVisibility();\n' +
       '        if (kdWasEmpty && this.visible && this.dimensions.container && (!this.dimensions.used || this.dimensions.used.height !== this.computeHeight())) {\n' +
       '            this.dimensions.used = new Dimension(this.dimensions.container.width, this.computeHeight());\n' +
       '            this.groupView.relayout();\n' +
       '        }\n'],
      // (a switch to another tab - the same tabs, the same labels - redrew every tab: its label, icon, hover, close
      // button, classes and colours, 5-10 ms a tab on the iPad 2; what changed is which one is active: the tabs' active,
      // selected and dirty states are drawn again, as VS Code does when the group's activation changes)
      ['        let didChange = false;\n        if (\n        activeEditorChanged || oldTabLabels.length !== this.tabLabels.length || ( oldTabLabels.some(\n            (label, index) => !this.equalsEditorInputLabel(label, this.tabLabels.at(index))\n        ))) {\n',
       '        let didChange = false;\n' +
       '        const kdLabelsChanged = oldTabLabels.length !== this.tabLabels.length || oldTabLabels.some(\n            (label, index) => !this.equalsEditorInputLabel(label, this.tabLabels.at(index))\n        );\n' +
       '        if (activeEditorChanged && !kdLabelsChanged && this.kdSameTabs()) {\n' +
       '            const isGroupActive = this.groupsView.activeGroup === this.groupView;\n' +
       '            this.forEachTab((editor, tabIndex, tabContainer, tabLabelWidget, tabLabel, tabActionBar) => {\n' +
       '                this.redrawTabSelectedActiveAndDirty(isGroupActive, editor, tabContainer, tabActionBar);\n' +
       '            });\n' +
       '            this.updateEditorActionsToolbar();\n' +
       '            this.layout(this.dimensions, {\n                forceRevealActiveTab: true\n            });\n' +
       '            didChange = true;\n' +
       '        }\n' +
       '        else if (activeEditorChanged || kdLabelsChanged) {\n'],
      ['    redraw(options) {\n        if (this.tabsAndActionsContainer) {',
       '    kdSameTabs() {\n' +
       '        const drawn = this.kdDrawnTabs;\n' +
       '        const editors = this.tabsModel.getEditors(EditorsOrder.SEQUENTIAL);\n' +
       '        if (!drawn || drawn.length !== editors.length || this.tabCount !== editors.length) {\n            return false;\n        }\n' +
       '        for (let i = 0; i < editors.length; i++) {\n            if (drawn[i] !== editors[i]) {\n                return false;\n            }\n        }\n' +
       '        return true;\n' +
       '    }\n' +
       '    redraw(options) {\n' +
       '        this.kdDrawnTabs = this.tabsModel.getEditors(EditorsOrder.SEQUENTIAL).slice();\n' +
       '        if (this.tabsAndActionsContainer) {'],
      ['    updateEditorActionsToolbar() {\n        super.updateEditorActionsToolbar();\n        this.layout(this.dimensions);\n    }',
       '    updateEditorActionsToolbar() {\n' +
       '        const updater = this.kdToolbarUpdater || (this.kdToolbarUpdater = this._register(new RunOnceScheduler(() => this.kdUpdateEditorActionsToolbar(), 0)));\n' +
       // (after the next frame: an editor opened or switched to is drawn first, its actions come after it - they
       // came before, 75 ms of menus and context keys between the editor's lines and the screen)
       '        if (updater.isScheduled() || this.kdToolbarFrame) {\n            return;\n        }\n' +
       '        this.kdToolbarFrame = true;\n' +
       '        requestAnimationFrame(() => {\n            this.kdToolbarFrame = false;\n            updater.schedule();\n        });\n' +
       '    }\n' +
       '    kdUpdateEditorActionsToolbar() {\n        super.updateEditorActionsToolbar();\n        this.layout(this.dimensions);\n    }']]],
    // (the Explorer's Open Editors list, made again whenever an editor opens or closes - its rows, the focus and the
    // selection with their context keys, and a new height for the views around it: 25-200 ms - waits for the next frame
    // too: it came right after the opening, before the new editor reached the screen)
    ['/vs/workbench/contrib/files/browser/views/openEditorsView.js', [
      ['        }, this.structuralRefreshDelay)));\n        this.updateSize();\n',
       '        }, this.structuralRefreshDelay)));\n        kdAfterFrame(this.listRefreshScheduler);\n        this.updateSize();\n'],
      ['let OpenEditorsView = class OpenEditorsView extends ViewPane {', AFTER_FRAME + 'let OpenEditorsView = class OpenEditorsView extends ViewPane {']]],
    // (a group's context keys for its active editor - a dozen of them, the editor's kind, its resource, whether it can
    // be split, reverted... - were set one by one on the workbench's context, each change going to every menu and
    // scoped context: one change now, as the group's own context already had them)
    ['/vs/workbench/browser/parts/editor/editorGroupView.js', [
      ['        this._register(this.onDidModelChange(e => updateGroupContextKeys(e)));\n        this._register(this.onDidActiveEditorChange(() => observeActiveEditor()));\n',
       '        this._register(this.onDidModelChange(e => kdBufferedKeys(this.editorPartsView, () => updateGroupContextKeys(e))));\n' +
       '        this._register(this.onDidActiveEditorChange(() => kdBufferedKeys(this.editorPartsView, observeActiveEditor)));\n'],
      // (the editor toolbar's menu kept while the editor pane's context is the same - it was made anew at every update of
      // the toolbar: each switch, each change of a context key its items look at, a file's first change after a save)
      ['    createEditorActions(disposables, menuId = MenuId.EditorTitle) {\n',
       '    kdTitleMenu(menuId, contextKeyService) {\n' +
       '        const menus = this.kdTitleMenus || (this.kdTitleMenus = new Map());\n' +
       '        const kept = menus.get(menuId);\n' +
       '        if (kept && kept.service === contextKeyService) {\n            return kept.menu;\n        }\n' +
       '        kept?.menu.dispose();\n' +
       '        const menu = this.menuService.createMenu(menuId, contextKeyService, {\n            emitEventsForSubmenuChanges: true,\n            eventDebounceDelay: 0\n        });\n' +
       '        menus.set(menuId, { service: contextKeyService, menu });\n' +
       '        if (!this.kdTitleMenusKept) {\n' +
       '            this.kdTitleMenusKept = true;\n' +
       '            this._register(toDisposable(() => {\n                for (const entry of menus.values()) {\n                    entry.menu.dispose();\n                }\n                menus.clear();\n            }));\n' +
       '        }\n' +
       '        return menu;\n' +
       '    }\n' +
       '    createEditorActions(disposables, menuId = MenuId.EditorTitle) {\n'],
      ['            const editorTitleMenu = disposables.add(this.menuService.createMenu(menuId, editorScopedContextKeyService, {\n                emitEventsForSubmenuChanges: true,\n                eventDebounceDelay: 0\n            }));',
       '            const editorTitleMenu = this.kdTitleMenu(menuId, editorScopedContextKeyService);'],
      ['let EditorGroupView = EditorGroupView_1 = class EditorGroupView extends Themable {',
       'function kdBufferedKeys(parts, fn) {\n' +
       '    const keys = parts && parts.contextKeyService;\n' +
       '    if (keys && typeof keys.bufferChangeEvents === "function") {\n        keys.bufferChangeEvents(fn);\n    } else {\n        fn();\n    }\n' +
       '}\n' +
       'let EditorGroupView = EditorGroupView_1 = class EditorGroupView extends Themable {']]],
    // (a file's language by its name - the ~200 registered extensions and names gone through, by the tab's icon, the
    // breadcrumbs', the model's language selection, its first listener...: 7-9 times per file opened, ~14 % of the
    // opening in the profiler - worked out once per name until the associations change)
    ['/vs/editor/common/services/languagesAssociations.js', [
      ['function _registerLanguageAssociation(association, userConfigured, warnOnOverwrite) {\n',
       'function _registerLanguageAssociation(association, userConfigured, warnOnOverwrite) {\n    kdForgetAssociations();\n'],
      ['function clearPlatformLanguageAssociations() {\n', 'function clearPlatformLanguageAssociations() {\n    kdForgetAssociations();\n'],
      ['function clearConfiguredLanguageAssociations() {\n', 'function clearConfiguredLanguageAssociations() {\n    kdForgetAssociations();\n'],
      ['function getAssociations(resource, firstLine) {\n    let path;', 'function kdGetAssociations(resource, firstLine) {\n    let path;']],
     'let kdAssociations = Object.create(null), kdAssociationsCount = 0;\n' +
     'function kdForgetAssociations() {\n    kdAssociations = Object.create(null);\n    kdAssociationsCount = 0;\n}\n' +
     'function getAssociations(resource, firstLine) {\n' +
     '    if (!resource || typeof resource.toString !== "function" || (firstLine && firstLine.length > 200)) {\n' +
     '        return kdGetAssociations(resource, firstLine);\n' +
     '    }\n' +
     '    const key = resource.toString() + "\\u0001" + (firstLine || "");\n' +
     '    let found = kdAssociations[key];\n' +
     '    if (!found) {\n' +
     '        if (kdAssociationsCount >= 500) {\n            kdForgetAssociations();\n        }\n' +
     '        found = kdAssociations[key] = kdGetAssociations(resource, firstLine);\n' +
     '        kdAssociationsCount++;\n' +
     '    }\n' +
     '    return found;\n' +
     '}\n'],
    // (the editor's toolbars made again only when their actions are others: a file's first change after a save -
    // "dirty" - had the toolbar's menu tell a change, and the same buttons were made anew after the key's frame, a
    // 100 ms stall before the next key in the profiler)
    ['/vs/workbench/browser/parts/editor/editorTabsControl.js', [
      ['        editorActionsToolbar.setActions(prepareActions(primary), prepareActions(secondary));',
       '        kdSetToolbarActions(editorActionsToolbar, this.groupView.activeEditor, prepareActions(primary), prepareActions(secondary));'],
      ['        this.editorLayoutActionsToolbar.setActions(prepareActions(primary), prepareActions(secondary));',
       '        kdSetToolbarActions(this.editorLayoutActionsToolbar, this.groupView.activeEditor, prepareActions(primary), prepareActions(secondary));'],
      ['        editorActionsToolbar.setActions([], []);', '        kdSetToolbarActions(editorActionsToolbar, undefined, [], []);'],
      ['        this.editorLayoutActionsToolbar?.setActions([], []);',
       '        if (this.editorLayoutActionsToolbar) {\n            kdSetToolbarActions(this.editorLayoutActionsToolbar, undefined, [], []);\n        }']],
     'function kdToolbarKey(actions) {\n' +
     '    let key = "";\n' +
     '    for (let i = 0; i < actions.length; i++) {\n' +
     '        const a = actions[i];\n' +
     '        key += a.id + "\\u0001" + a.label + "\\u0001" + a.tooltip + "\\u0001" + a.class + "\\u0001" + a.enabled + "\\u0001" + a.checked + "\\u0001" +\n' +
     '            (a.hideActions ? a.hideActions.isHidden : "") + "\\u0001" + (a.alt ? a.alt.id + "/" + a.alt.enabled : "") + "\\u0001" +\n' +
     '            (a._options && a._options.arg ? String(a._options.arg) : "") + "\\u0002";\n' +
     '        if (a.actions && a.actions.length) {\n            key += "[" + kdToolbarKey(a.actions) + "]";\n        }\n' +
     '    }\n' +
     '    return key;\n' +
     '}\n' +
     'function kdSetToolbarActions(toolbar, editor, primary, secondary) {\n' +
     '    const key = kdToolbarKey(primary) + "||" + kdToolbarKey(secondary);\n' +
     '    if (toolbar.kdKey === key && toolbar.kdEditor === editor) {\n        return;\n    }\n' +
     '    toolbar.kdKey = key;\n' +
     '    toolbar.kdEditor = editor;\n' +
     '    toolbar.setActions(primary, secondary);\n' +
     '}\n'],
    ['/vs/workbench/browser/parts/titlebar/windowTitle.js', [
      ['this.titleUpdater = this._register(( new RunOnceScheduler(() => this.doUpdateTitle(), 0)));',
       'this.titleUpdater = this._register(( new RunOnceScheduler(() => {\n' +
       '            if (this.kdTitleWaits) {\n                return;\n            }\n' +
       '            this.kdTitleWaits = true;\n' +
       '            const later = typeof requestIdleCallback === "function" ? requestIdleCallback : setTimeout;\n' +
       '            later(() => {\n                this.kdTitleWaits = false;\n                this.doUpdateTitle();\n            }, { timeout: 5000 });\n' +
       '        }, 0)));']]],
    ['/vs/workbench/browser/parts/editor/textEditor.js', [
      ['        if (!configuration) {\n            return;\n        }\n        const editorConfiguration = this.computeConfiguration(configuration);',
       '        if (!configuration) {\n            return;\n        }\n' +
       '        const kdKey = [configuration, this.input, this.input?.isReadonly(), this.group, this.editorGroupService.count];\n' +
       '        if (this.lastAppliedEditorOptions && this.kdLastKey && kdKey.every((value, i) => value === this.kdLastKey[i])) {\n            return;\n        }\n' +
       '        this.kdLastKey = kdKey;\n' +
       '        const editorConfiguration = this.computeConfiguration(configuration);']]]
  ])
}

// Every menu VS Code makes - the editor's toolbar at every switch, a context menu, the command palette's thousand
// commands at every opening - went through the menu registry's items twice (MenuInfo's constructor refreshes again
// what its base class's constructor had just refreshed), each time sorting them (by group, order and title: 12 000
// localeCompare calls for the palette) and collecting the context keys of their conditions. Once now, and the sorted
// items of a menu are kept until the registry changes for it.
// Every context menu also gave the menus' shared <style> its text again - the same text: the old WebKit then made its
// rule sets anew from all of the page's rules, and the engine's shim looked the text over again (0.23 s of an editor
// context menu's 0.87 in the profiler). The text is given when it is another.
// And at every change of a context key (dozens when an editor opens or a tab is switched), every scoped context key
// service below it - one per editor, view, list, widget: dozens - copied its whole context (a spread of all its keys)
// and made a Set of the copy's keys, to ask whether the change touched only keys of its own: on iOS 6 Set is the
// engine's shim, slow to fill. The keys are asked of the context itself now. And every menu (dozens) asked each change
// whether it touched its keys - three Sets of the shim, asked about every key of the change, the keys a view reset and
// set again counted twice: a menu's keys answer from an object, and the changes told at once come as one list of keys,
// each once (a file's first change after a save: 98 ms of context changes in the profiler).
function quickerMenus() {
  // (the registry tells of its changes in a microtask: a version number counts them at once, and a menu's kept items
  // are good for one version)
  const registry = {
    name: 'kodium-menu-registry-version',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/vs/platform/actions/common/actions.js')) return null
      const find = 'this._onDidChangeMenu.fire('
      if (code.split(find).length !== 5) this.error('kodium-menu-registry-version: actions.js has another form')
      return { code: code.split(find).join('(this.kdVersion = (this.kdVersion || 0) + 1), ' + find), map: null }
    }
  }
  return [registry, patchModules('kodium-quicker-menus', [
    ['/vs/platform/contextkey/browser/contextKeyService.js', [
      ['function allEventKeysInContext(event, context) {\n    return event.allKeysContainedIn(( new Set(( Object.keys(context)))));\n}',
       'function allEventKeysInContext(event, context) {\n' +
       '    return event.allKeysContainedIn({ has: key => Object.prototype.hasOwnProperty.call(context, key) });\n}'],
      ['            const thisContextValues = thisContainer.value;\n            if (!allEventKeysInContext(e, thisContextValues)) {',
       '            const thisContextValues = thisContainer._value || thisContainer.value;\n            if (!allEventKeysInContext(e, thisContextValues)) {'],
      ['    affectsSome(keys) {\n        for (const key of this.keys) {\n            if (( keys.has(key))) {\n                return true;\n            }\n        }\n        return false;\n    }',
       '    affectsSome(keys) {\n        const own = this.keys;\n        for (let i = 0; i < own.length; i++) {\n            if (keys.has(own[i])) {\n                return true;\n            }\n        }\n        return false;\n    }'],
      ['    affectsSome(keys) {\n        for (const e of this.events) {\n            if (e.affectsSome(keys)) {\n                return true;\n            }\n        }\n        return false;\n    }',
       '    affectsSome(keys) {\n        const events = this.events;\n        for (let i = 0; i < events.length; i++) {\n            if (events[i].affectsSome(keys)) {\n                return true;\n            }\n        }\n        return false;\n    }'],
      ['            merge: input => ( new CompositeContextKeyChangeEvent(input))', '            merge: input => kdMergeKeyEvents(input)'],
      // (a config.* context key's value from an object: the values were kept in a ternary search tree alone, which
      // every read walked - the terminal's menus ask its settings, 2500 steps of it as a terminal opened, 0.2 s)
      ['        this._listener = this._configurationService.onDidChangeConfiguration(event => {\n            if (event.source === ConfigurationTarget.DEFAULT) {',
       '        this._listener = this._configurationService.onDidChangeConfiguration(event => {\n            this.kdValues = Object.create(null);\n' +
       '            if (event.source === ConfigurationTarget.DEFAULT) {'],
      ['        if (( this._values.has(key))) {\n            return this._values.get(key);\n        }\n',
       '        const kdValues = this.kdValues || (this.kdValues = Object.create(null));\n        if (key in kdValues) {\n            return kdValues[key];\n        }\n' +
       '        if (( this._values.has(key))) {\n            return kdValues[key] = this._values.get(key);\n        }\n'],
      ['        this._values.set(key, value);\n        return value;\n    }', '        this._values.set(key, value);\n        kdValues[key] = value;\n        return value;\n    }']],
     // (the changes a buffered or paused context tells at once - a view's reset and set of the same keys - as one list
     // of their keys, each once: every menu below asks each change about each of its keys)
     'function kdMergeKeyEvents(input) {\n' +
     '    const seen = Object.create(null), keys = [];\n' +
     '    const walk = e => {\n' +
     '        if (typeof e.key === "string") {\n' +
     '            if (seen[e.key] !== true) {\n                seen[e.key] = true;\n                keys.push(e.key);\n            }\n' +
     '        } else if (Array.isArray(e.keys)) {\n' +
     '            for (let i = 0; i < e.keys.length; i++) {\n' +
     '                if (seen[e.keys[i]] !== true) {\n                    seen[e.keys[i]] = true;\n                    keys.push(e.keys[i]);\n                }\n' +
     '            }\n' +
     '        } else if (Array.isArray(e.events)) {\n' +
     '            for (let i = 0; i < e.events.length; i++) {\n                if (!walk(e.events[i])) {\n                    return false;\n                }\n            }\n' +
     '        } else {\n            return false;\n        }\n' +
     '        return true;\n' +
     '    };\n' +
     '    for (let i = 0; i < input.length; i++) {\n' +
     '        if (!walk(input[i])) {\n            return new CompositeContextKeyChangeEvent(input);\n        }\n' +
     '    }\n' +
     '    return new ArrayContextKeyChangeEvent(keys);\n' +
     '}\n'],
    ['/vs/base/browser/ui/menu/menu.js', [
      ['        this.styleSheet.textContent = __kdPlain(getMenuWidgetCSS(style, isInShadowDOM(container)));',
       '        const kdCss = getMenuWidgetCSS(style, isInShadowDOM(container));\n' +
       '        if (this.styleSheet.kdCss !== kdCss) {\n' +
       '            this.styleSheet.kdCss = kdCss;\n' +
       '            this.styleSheet.textContent = __kdPlain(kdCss);\n' +
       '        }']]],
    ['/vs/platform/actions/common/menuService.js', [
      ['        const menuItems = this._sort(MenuRegistry.getMenuItems(this._id));', '        const menuItems = this._kdItems();'],
      ['    _sort(menuItems) {\n        return menuItems;\n    }',
       '    _sort(menuItems) {\n        return menuItems;\n    }\n    _kdItems() {\n        return this._sort(MenuRegistry.getMenuItems(this._id));\n    }'],
      ['        this._contextKeyService = _contextKeyService;\n        this.refresh();\n    }\n    createActionGroups(options) {',
       '        this._contextKeyService = _contextKeyService;\n    }\n    _kdItems() {\n        return __kdSortedMenuItems(this._id, () => this._sort(MenuRegistry.getMenuItems(this._id)));\n    }\n    createActionGroups(options) {'],
      ['        this._structureContextKeys = ( new Set());\n        this._preconditionContextKeys = ( new Set());\n        this._toggledContextKeys = ( new Set());',
       '        this._structureContextKeys = __kdKeySet();\n        this._preconditionContextKeys = __kdKeySet();\n        this._toggledContextKeys = __kdKeySet();']],
     // (a menu's context keys: a Set that answers has() from an object - the engine's Set shim was most of the time of
     // a context change, every menu asking it about every changed key)
     'function __kdKeySet() {\n' +
     '    const set = new Set();\n' +
     '    let known = Object.create(null);\n' +
     '    const add = set.add, remove = set.delete, clear = set.clear;\n' +
     '    set.add = function (key) {\n        known[key] = true;\n        return add.call(this, key);\n    };\n' +
     '    set.delete = function (key) {\n        delete known[key];\n        return remove.call(this, key);\n    };\n' +
     '    set.clear = function () {\n        known = Object.create(null);\n        return clear.call(this);\n    };\n' +
     '    set.has = key => known[key] === true;\n' +
     '    return set;\n' +
     '}\n' +
     'const __kdSorted = new Map();\n' +
     'function __kdSortedMenuItems(id, make) {\n' +
     '    const version = MenuRegistry.kdVersion || 0;\n' +
     '    let kept = __kdSorted.get(id);\n' +
     '    if (!kept || kept.version !== version) {\n' +
     '        kept = { version, items: make() };\n' +
     '        __kdSorted.set(id, kept);\n' +
     '    }\n' +
     '    return kept.items;\n' +
     '}\n']
  ])]
}

// The rows of the quick pick lists - the command palette's, Go to File's, Go to Symbol's - and Go to Symbol's opening
// (469 symbols of a long file: 1.3 s on the iPad 2):
// - a row's buttons (Configure Keybinding, Open to the Side...) were a toolbar cleared and made again at every render
//   of the row - each filtering, each scroll, Go to Symbol's reveal of the symbol at the cursor right after its first
//   rows: an action item, its hover and its classes, ~60 % of a row's render in the profiler. A row whose buttons look
//   the same (icons, tooltips, labels) keeps them; they run the new item's handler.
// - the symbols were sorted by their places three times - already in order, each sort ~4,000 comparisons through the
//   engine's sort with a function per comparison: a look along them first, sorted only when out of order
function quickerPicks() {
  const sortedOnce = 'function kdSortedOnce(items, compare) {\n' +
    '    for (let i = 1; i < items.length; i++) {\n' +
    '        if (compare(items[i - 1], items[i]) > 0) {\n            return items.sort(compare);\n        }\n' +
    '    }\n' +
    '    return items;\n' +
    '}\n'
  return patchModules('kodium-quicker-picks', [
    // (the list of a quick pick that went - the palette's 566 commands - emptied a little after it went, not as the
    // next one shows: ~40 ms of the next opening's)
    ['/vs/platform/quickinput/browser/quickInputController.js', [
      ['        controller.didHide(reason);\n    }\n    completeCloseAnimation() {',
       '        controller.didHide(reason);\n' +
       '        clearTimeout(this.kdClearTimer);\n' +
       '        this.kdClearTimer = setTimeout(() => {\n' +
       '            if (!this.controller && this.ui) {\n                this.ui.list.setElements([]);\n            }\n' +
       '        }, 600);\n' +
       '    }\n    completeCloseAnimation() {']]],
    ['/vs/platform/quickinput/browser/quickInputList.js', [
      ['        data.toDisposeElement.clear();\n        data.toolBar.setActions([]);\n    }\n',
       '        data.toDisposeElement.clear();\n        if (!data.kdActions) {\n            data.toolBar.setActions([]);\n        }\n    }\n'],
      ['            } = quickInputButtonsToActionArrays(buttons, "quick-input-item", button => element.fireButtonTriggered({\n                button,\n                item: element.item\n            }));\n' +
       '            data.toolBar.setActions(primary, secondary);\n            data.entry.classList.add("has-actions");\n        } else {\n            data.toolBar.setActions([]);\n',
       '            } = quickInputButtonsToActionArrays(buttons, "quick-input-item", button => element.fireButtonTriggered({\n                button,\n                item: element.item\n            }));\n' +
       '            if (!kdKeepActions(data, primary, secondary)) {\n                data.toolBar.setActions(primary, secondary);\n            }\n' +
       '            data.entry.classList.add("has-actions");\n        } else {\n            data.kdActions = undefined;\n            data.toolBar.setActions([]);\n']],
     'function kdKeepActions(data, primary, secondary) {\n' +
     '    let key = secondary.length ? null : "";\n' +
     '    for (let i = 0; key !== null && i < primary.length; i++) {\n' +
     '        const a = primary[i];\n' +
     '        key = Object.getPrototypeOf(a) === Object.prototype\n' +
     '            ? key + a.id + "\\u0001" + a.class + "\\u0001" + a.tooltip + "\\u0001" + a.label + "\\u0001" + a.enabled + "\\u0002" : null;\n' +
     '    }\n' +
     '    const kept = data.kdActions;\n' +
     '    if (key !== null && kept && kept.key === key && kept.actions.length === primary.length) {\n' +
     '        for (let i = 0; i < primary.length; i++) {\n            kept.actions[i].run = primary[i].run;\n        }\n' +
     '        return true;\n' +
     '    }\n' +
     '    data.kdActions = key === null ? undefined : { key, actions: primary };\n' +
     '    return false;\n' +
     '}\n'],
    // (- and the outline's elements gone through with their Maps' forEach, not for...of: ES5 here, each step of it an
    // iterator result and a [key, value] array from the engine's Map, ~3,400 of them after every pause of typing in a
    // file of 469 symbols - its size measured twice, its problems put on its symbols, the symbol at the cursor)
    ['/vs/editor/contrib/documentSymbols/browser/outlineModel.js', [
      ['        return roots.sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range));\n',
       '        return kdSortedOnce(roots, (a, b) => Range.compareRangesUsingStarts(a.range, b.range));\n'],
      ['        return bucket.sort(\n            (a, b) => Position.compare',
       '        return kdSortedOnce(bucket,\n            (a, b) => Position.compare'],
      ['        for (const [, child] of element.children) {\n            res += TreeElement.size(child);\n        }\n',
       '        element.children.forEach(child => {\n            res += TreeElement.size(child);\n        });\n'],
      ['        for (const [, item] of children) {\n            if (!item.symbol.range || !Range.containsPosition(item.symbol.range, position)) {\n',
       '        for (const item of kdValuesOf(children)) {\n            if (!item.symbol.range || !Range.containsPosition(item.symbol.range, position)) {\n'],
      ['        for (const [, child] of this.children) {\n            this._updateMarker(marker, child);\n        }\n',
       '        this.children.forEach(child => {\n            this._updateMarker(marker, child);\n        });\n'],
      ['        for (const [, child] of item.children) {\n            this._updateMarker(myMarkers, child);\n        }\n',
       '        item.children.forEach(child => {\n            this._updateMarker(myMarkers, child);\n        });\n'],
      ['        for (const child of ( this.children.values())) {\n            if (child instanceof OutlineElement) {\n',
       '        for (const child of kdValuesOf(this.children)) {\n            if (child instanceof OutlineElement) {\n']],
     sortedOnce +
     'function kdValuesOf(map) {\n' +
     '    const out = [];\n' +
     '    if (map.size) {\n        map.forEach(value => out.push(value));\n    }\n' +
     '    return out;\n' +
     '}\n'],
    ['/vs/editor/contrib/quickAccess/browser/gotoSymbolQuickAccess.js', [
      ['        const sortedFilteredSymbolPicks = filteredSymbolPicks.sort(\n            (symbolA, symbolB) =>',
       '        const sortedFilteredSymbolPicks = kdSortedOnce(filteredSymbolPicks,\n            (symbolA, symbolB) =>'],
      // (- its picks, the symbol at the cursor made the active one and the end of "busy" were three updates of the
      // pick, each laying the widget out to measure its list - after the rows the one before had drawn: one update)
      ['                if (items.length > 0) {\n                    picker.items = items;\n',
       '                if (items.length > 0 && typeof picker.kdBatch === "function") {\n' +
       '                    picker.kdBatch(() => {\n' +
       '                        picker.items = items;\n' +
       '                        if (positionToEnclose && query.original.length === 0) {\n' +
       '                            const candidate = findLast(items, item => Boolean(\n' +
       '                                item.type !== "separator" && item.range && Range.containsPosition(item.range.decoration, positionToEnclose)\n' +
       '                            ));\n' +
       '                            if (candidate) {\n                                picker.activeItems = [candidate];\n                            }\n' +
       '                        }\n' +
       '                        if (!token.isCancellationRequested) {\n                            picker.busy = false;\n                        }\n' +
       '                    });\n' +
       '                } else if (items.length > 0) {\n                    picker.items = items;\n'],
      ['            } finally {\n                if (!token.isCancellationRequested) {\n                    picker.busy = false;\n                }\n            }\n',
       '            } finally {\n                if (!token.isCancellationRequested && picker.busy) {\n                    picker.busy = false;\n                }\n            }\n']],
     sortedOnce],
    ['/vs/platform/quickinput/browser/quickInput.js', [
      ['    update() {\n        if (!this.visible) {\n            return;\n        }\n        const scrollTopBefore = this.keepScrollPosition ? this.scrollTop : 0;\n',
       '    kdBatch(fn) {\n' +
       '        this.kdHold = (this.kdHold || 0) + 1;\n' +
       '        try {\n            fn();\n        } finally {\n            this.kdHold--;\n        }\n' +
       '        if (!this.kdHold) {\n            this.update();\n        }\n' +
       '    }\n' +
       '    update() {\n        if (!this.visible || this.kdHold) {\n            return;\n        }\n        const scrollTopBefore = this.keepScrollPosition ? this.scrollTop : 0;\n']]]
  ])
}

// The Outline view in the Explorer, with a long file (469 symbols): every move of the cursor made its whole tree again
// half a second later - a frame of ~0.4 s on the iPad 2 after each arrow key or tap - though only which symbol is the
// cursor's had changed (the outline says so: affectOnlyActiveElement), and that one is revealed by a listener of its
// own. A change of the text still makes the tree again, cheaper:
// - its filter asked the settings, through the resource's folder and language, whether each symbol's kind is shown
//   (outline.showFunctions...): ~0.9 ms a symbol; the answers are kept for the task that asks them
// - each symbol's children went from the outline's Map to the tree through the engine's iterators and a generator per
//   symbol (ES5: a regenerator state machine): arrays now
function quickerOutline() {
  return patchModules('kodium-quicker-outline', [
    // (- and a switch to another editor made the Outline's tree for it - the tree's widget and all its symbols - before
    // the frame that shows the editor: after that frame now. The widget - its list, scroll bars, find, context keys,
    // ~0.3 s on the iPad 2 - was made anew for every editor: the one before is kept and given the new outline's symbols
    // when it shows the same kind of outline (its renderers, filter, sorter and identities hold nothing of a file), and
    // when they are the symbols it shows - the same file, unchanged, the view shown again - they stay as they are)
    ['/vs/workbench/contrib/outline/browser/outlinePane.js', [
      ['        const didCapture = this._captureViewState();\n        this._editorControlDisposables.clear();\n',
       '        const didCapture = this._captureViewState();\n        this.kdKeep = true;\n        try {\n            this._editorControlDisposables.clear();\n        } finally {\n            this.kdKeep = false;\n        }\n'],
      // (and kept while the view is hidden - another view of the side bar shown, the side bar closed - for when it
      // shows again; a kept tree is out of the page's layout until it is given its symbols, after the frame that
      // shows the view: put back in that frame, its old rows cost 0.2 s before the view could show)
      ['            if (!visible) {\n                this._editorListener.clear();\n                this._editorPaneDisposables.clear();\n                this._editorControlDisposables.clear();\n',
       '            if (!visible) {\n                this._editorListener.clear();\n                this._editorPaneDisposables.clear();\n' +
       '                this._captureViewState();\n' +
       '                this.kdKeep = true;\n                try {\n                    this._editorControlDisposables.clear();\n                } finally {\n                    this.kdKeep = false;\n                }\n'],
      ['        const sorter = ( new OutlineTreeSorter(newOutline.config.comparator, this._outlineViewState.sortBy));\n        const tree = this._instantiationService.createInstance(\n',
       '        const kdKept = this.kdKeptTree;\n' +
       '        this.kdKeptTree = undefined;\n' +
       '        const kdReuse = !!kdKept && kdKept.kdKind === newOutline.outlineKind && kdKept.kdCollapse === !!newOutline.config.options.collapseByDefault &&\n' +
       '            kdSameTypes(kdKept.kdRendererTypes, newOutline.config.renderers) && !!kdKept.kdSorter;\n' +
       '        if (kdKept && !kdReuse) {\n            kdKept.dispose();\n        }\n' +
       '        const sorter = kdReuse ? kdKept.kdSorter : ( new OutlineTreeSorter(newOutline.config.comparator, this._outlineViewState.sortBy));\n' +
       '        let kdFresh = kdReuse, kdSame = false;\n' +
       '        if (kdReuse) {\n            sorter.order = this._outlineViewState.sortBy;\n            kdKept.dataSource = newOutline.config.treeDataSource;\n            kdKept.getHTMLElement().style.display = "";\n' +
       '            const kdOld = kdKept.getInput();\n' +
       '            if (kdOld && kdOld._outlineModel && newOutline._outlineModel && kdOld._outlineModel.children === newOutline._outlineModel.children) {\n' +
       '                kdKept.input = newOutline;\n                kdFresh = false;\n                kdSame = true;\n' +
       '            }\n' +
       '        }\n' +
       '        const tree = kdReuse ? kdKept : this._instantiationService.createInstance(\n'],
      ['            } else if (!tree.getInput()) {\n                this._domNode.classList.remove("message");\n',
       '            } else if (kdSame) {\n                kdSame = false;\n                this._domNode.classList.remove("message");\n' +
       '            } else if (!tree.getInput() || kdFresh) {\n                kdFresh = false;\n                this._domNode.classList.remove("message");\n'],
      ['        this._tree = tree;\n        this._editorControlDisposables.add(toDisposable(() => {\n            tree.dispose();\n            this._tree = undefined;\n        }));\n',
       '        this._tree = tree;\n' +
       '        tree.kdKind = newOutline.outlineKind;\n' +
       '        tree.kdCollapse = !!newOutline.config.options.collapseByDefault;\n' +
       '        tree.kdRendererTypes = newOutline.config.renderers.map(r => r.constructor);\n' +
       '        tree.kdSorter = sorter;\n' +
       '        this._editorControlDisposables.add(toDisposable(() => {\n' +
       '            if (this.kdKeep && !this.kdKeptTree) {\n                this.kdKeptTree = tree;\n                tree.getHTMLElement().style.display = "none";\n            } else {\n                tree.dispose();\n            }\n' +
       '            this._tree = undefined;\n' +
       '        }));\n'],
      ['    dispose() {\n        this._disposables.dispose();\n',
       '    dispose() {\n        this.kdKeptTree?.dispose();\n        this.kdKeptTree = undefined;\n        this._disposables.dispose();\n'],
      ['        if (cts.token.isCancellationRequested) {\n            newOutline?.dispose();\n            return;\n        }\n        this._editorControlDisposables.add(newOutline);\n',
       '        if (cts.token.isCancellationRequested) {\n            newOutline?.dispose();\n            return;\n        }\n' +
       '        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));\n' +
       '        if (cts.token.isCancellationRequested) {\n            newOutline?.dispose();\n            return;\n        }\n' +
       '        this._editorControlDisposables.add(newOutline);\n'],
      // (- and after a change of the text, when the symbols are the same ones - the same names, kinds and nesting, only
      // their places moved - the tree's nodes are given the new symbols and its rows on the screen drawn again: making
      // the tree again was ~500 nodes created, filtered and sorted after every pause of typing in a long file)
      ['            } else {\n                this._domNode.classList.remove("message");\n                tree.updateChildren();\n            }\n',
       '            } else {\n                this._domNode.classList.remove("message");\n                if (!kdUpdateInPlace(tree)) {\n                    tree.updateChildren();\n                }\n            }\n'],
      ['        this._editorControlDisposables.add(newOutline.onDidChange(updateTree));\n',
       '        this._editorControlDisposables.add(newOutline.onDidChange(e => {\n' +
       '            if (e && e.affectOnlyActiveElement && tree.getInput()) {\n                return;\n            }\n' +
       '            updateTree();\n' +
       '        }));\n']],
     'function kdUpdateInPlace(tree) {\n' +
     '    const model = tree.model, identity = tree.identityProvider, source = tree.dataSource, view = tree.view;\n' +
     '    if (!model || !model.nodes || !identity || !source || !view || typeof model.getNode !== "function" || typeof model.rerender !== "function") {\n        return false;\n    }\n' +
     '    const kind = element => element && element.symbol ? element.symbol.kind : (element && element.constructor);\n' +
     '    const pairs = [];\n' +
     '    const same = (parentNode, parentElement) => {\n' +
     '        const found = source.getChildren(parentElement);\n' +
     '        const items = Array.isArray(found) ? found : [...found];\n' +
     '        const nodes = parentNode.children;\n' +
     '        if (items.length !== nodes.length) {\n            return false;\n        }\n' +
     '        for (let i = 0; i < items.length; i++) {\n' +
     '            const node = nodes[i], item = items[i];\n' +
     '            if (String(identity.getId(node.element)) !== String(identity.getId(item)) || kind(node.element) !== kind(item)) {\n                return false;\n            }\n' +
     '            pairs.push(node, item);\n' +
     '            if (!same(node, item)) {\n                return false;\n            }\n' +
     '        }\n' +
     '        return true;\n' +
     '    };\n' +
     '    if (!same(model.getNode(null), tree.getInput())) {\n        return false;\n    }\n' +
     '    for (let i = 0; i < pairs.length; i += 2) {\n' +
     '        const node = pairs[i], item = pairs[i + 1];\n' +
     '        if (node.element !== item) {\n            model.nodes.delete(node.element);\n            node.element = item;\n            model.nodes.set(item, node);\n        }\n' +
     '    }\n' +
     '    const first = view.firstVisibleIndex, last = Math.min(view.lastVisibleIndex, view.length - 1);\n' +
     '    for (let i = Math.max(first, 0); i <= last; i++) {\n        model.rerender(view.element(i).element);\n    }\n' +
     '    if (typeof tree.rerenderStickyScroll === "function") {\n        tree.rerenderStickyScroll();\n    }\n' +
     '    return true;\n' +
     '}\n' +
     'function kdSameTypes(types, renderers) {\n' +
     '    if (!types || types.length !== renderers.length) {\n        return false;\n    }\n' +
     '    for (let i = 0; i < types.length; i++) {\n        if (!renderers[i] || renderers[i].constructor !== types[i]) {\n            return false;\n        }\n    }\n' +
     '    return true;\n' +
     '}\n'],
    ['/vs/workbench/contrib/codeEditor/browser/outline/documentSymbolsTree.js', [
      ['        const configKey = `${this._prefix}.${configName}`;\n        return this._textResourceConfigService.getValue(outline?.uri, configKey);\n',
       '        const configKey = `${this._prefix}.${configName}`;\n' +
       '        if (!kdFilterListens) {\n' +
       '            kdFilterListens = true;\n' +
       '            this._textResourceConfigService.onDidChangeConfiguration(() => {\n                kdFilterValues = undefined;\n            });\n' +
       '        }\n' +
       '        let kdValues = kdFilterValues;\n' +
       '        if (!kdValues) {\n' +
       '            kdValues = kdFilterValues = Object.create(null);\n' +
       '            setTimeout(() => {\n                kdFilterValues = undefined;\n            }, 0);\n' +
       '        }\n' +
       '        const kdKey = String(outline?.uri) + "\\u0001" + configKey;\n' +
       '        let kdValue = kdValues[kdKey];\n' +
       '        if (kdValue === undefined) {\n            kdValue = kdValues[kdKey] = this._textResourceConfigService.getValue(outline?.uri, configKey);\n        }\n' +
       '        return kdValue;\n']],
     'let kdFilterValues, kdFilterListens = false;\n'],
    // (- a change of the file's problems made the tree again too - after each pause of typing that changed a message -
    // though the symbols show only how many errors and warnings each has and the worst: only when that changed now)
    ['/vs/workbench/contrib/codeEditor/browser/outline/documentSymbolsOutline.js', [
      ['                    return ( parent.children.values());\n', '                    return kdValues(parent.children);\n'],
      ['                    return ( this._outlineModel.children.values());\n', '                    return kdValues(this._outlineModel.children);\n'],
      ['                if (isEqual(model.uri, textModel.uri)) {\n                    this._applyMarkersToOutline(model);\n                    this._onDidChange.fire({});\n                }\n',
       '                if (isEqual(model.uri, textModel.uri)) {\n' +
       '                    const kdBefore = kdMarkerState(model);\n' +
       '                    this._applyMarkersToOutline(model);\n' +
       '                    if (kdMarkerState(model) !== kdBefore) {\n                        this._onDidChange.fire({});\n                    }\n' +
       '                }\n']],
     'function kdValues(map) {\n' +
     '    const out = [];\n' +
     '    if (map.size) {\n        map.forEach(value => out.push(value));\n    }\n' +
     '    return out;\n' +
     '}\n' +
     'function kdMarkerState(model) {\n' +
     '    let state = "";\n' +
     '    const visit = element => {\n' +
     '        if (element.marker) {\n            state += element.id + "\\u0001" + element.marker.count + "\\u0001" + element.marker.topSev + "\\u0002";\n        }\n' +
     '        if (element.children && element.children.size) {\n            element.children.forEach(visit);\n        }\n' +
     '    };\n' +
     '    model.children.forEach(visit);\n' +
     '    return state;\n' +
     '}\n'],
    ['/vs/base/browser/ui/tree/dataTree.js', [
      ['        const children = [...this.dataSource.getChildren(element)];\n        const elements = Iterable.map(children, element => {\n',
       '        const kdSource = this.dataSource.getChildren(element);\n' +
       '        const children = Array.isArray(kdSource) ? kdSource.slice() : [...kdSource];\n' +
       '        const elements = children.map(element => {\n']]]
  ])
}

// The command palette at every opening (the profiler, after the menus' kept items above): each of the ~1000 commands
// got a "Configure Keybinding" button of its own (an array, an object, a localize and a class name each), and with
// nothing typed yet each was still tested against the empty filter (4000 calls of the filters, all matching).
// Typing into it ("view": 2.4 s until the list changed on the iPad 2): the "similar commands" calculator was made
// anew for every filter, and the filters asked the engine's Set and Map shims about every character.
function quickerPalette() {
  return patchModules('kodium-quicker-palette', [
    ['/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.js', [
      ['        return [...this.getCodeEditorCommandPicks(), ...this.getGlobalCommandPicks()].map(picks => ({\n            ...picks,\n            buttons: [{\n                iconClass: ThemeIcon.asClassName(Codicon.gear),\n                tooltip: ( localize(17512, "Configure Keybinding"))\n            }],',
       '        const kdButtons = [{\n            iconClass: ThemeIcon.asClassName(Codicon.gear),\n            tooltip: ( localize(17512, "Configure Keybinding"))\n        }];\n' +
       '        return [...this.getCodeEditorCommandPicks(), ...this.getGlobalCommandPicks()].map(picks => ({\n            ...picks,\n            buttons: kdButtons,'],
      // (its commands: those of the palette's menu whose condition holds and which are enabled - what a menu made for
      // them gave, without making the menu: ~440 actions, each with an action to hide it and one to set its keybinding,
      // and the context keys of all their conditions collected, at every opening - ~110 ms on the iPad 2)
      ['        const globalCommandsMenu = this.menuService.getMenuActions(MenuId.CommandPalette, scopedContextKeyService);\n' +
       '        const globalCommandsMenuActions = globalCommandsMenu.reduce((r, [, actions]) => [...r, ...actions], []).filter(action => action instanceof MenuItemAction && action.enabled);\n',
       '        const globalCommandsMenuActions = kdPaletteActions(scopedContextKeyService);\n']],
     'import { MenuRegistry as KdMenuRegistry, isIMenuItem as kdIsIMenuItem } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";\n' +
     'function kdPaletteActions(contextKeyService) {\n' +
     '    const out = [];\n' +
     '    for (const item of KdMenuRegistry.getMenuItems(MenuId.CommandPalette)) {\n' +
     '        if (!kdIsIMenuItem(item) || !contextKeyService.contextMatchesRules(item.when)) {\n            continue;\n        }\n' +
     '        if (item.command.precondition && !contextKeyService.contextMatchesRules(item.command.precondition)) {\n            continue;\n        }\n' +
     '        out.push({ item: item.command });\n' +
     '    }\n' +
     '    return out;\n' +
     '}\n'],
    ['/vs/platform/quickinput/browser/commandsQuickAccess.js', [
      ['        const filteredCommandPicks = [];\n        for (const commandPick of allCommandPicks) {',
       '        const filteredCommandPicks = [];\n' +
       '        if (!filter) {\n' +
       '            for (const commandPick of allCommandPicks) {\n' +
       '                commandPick.highlights = { label: [], detail: this.options.showAlias && commandPick.commandAlias ? [] : undefined };\n' +
       '                filteredCommandPicks.push(commandPick);\n' +
       '            }\n' +
       '        }\n' +
       '        else for (const commandPick of allCommandPicks) {'],
      // (the sort: each pick's count in the history and its label's place in alphabetical order worked out once per
      // opening, not in each of its ~2600 comparisons - two lookups in the history and a localeCompare each; the
      // labels' order is kept while the labels stay the same)
      ['        filteredCommandPicks.sort((commandPickA, commandPickB) => {',
       '        let kdRank = this.kdLabelRank;\n' +
       '        if (!kdRank || filteredCommandPicks.some((p) => !kdRank.has(p.label))) {\n' +
       '            const labels = [...new Set([...(kdRank ? kdRank.keys() : []), ...filteredCommandPicks.map((p) => p.label)])].sort((a, b) => a.localeCompare(b));\n' +
       '            kdRank = this.kdLabelRank = new Map(labels.map((label, i) => [label, i]));\n' +
       '        }\n' +
       '        for (const p of filteredCommandPicks) { p.kdCounter = this.commandsHistory.peek(p.commandId); p.kdRank = kdRank.get(p.label); }\n' +
       '        filteredCommandPicks.sort((commandPickA, commandPickB) => {'],
      ['            const commandACounter = this.commandsHistory.peek(commandPickA.commandId);\n            const commandBCounter = this.commandsHistory.peek(commandPickB.commandId);',
       '            const commandACounter = commandPickA.kdCounter;\n            const commandBCounter = commandPickB.kdCounter;'],
      ['            return commandPickA.label.localeCompare(commandPickB.label);\n        });',
       '            return commandPickA.kdRank - commandPickB.kdRank;\n        });'],
      ['            const isInHistory = !!this.commandsHistory.peek(commandPick.commandId);',
       '            const isInHistory = !!commandPick.kdCounter;'],
      // (the "similar commands" of a typed filter: a TF-IDF calculator of all the commands' texts, made anew - every
      // text cut into terms, counted in Maps of the engine's shim - at every key typed into the palette: kept while the
      // commands' texts are the same, only the filter's scores worked out)
      ['            const tfidf = ( new TfIdfCalculator());\n            tfidf.updateDocuments(allCommandPicks.map(commandPick => ({\n                key: commandPick.commandId,\n                textChunks: [this.getTfIdfChunk(commandPick)]\n            })));\n',
       '            const tfidf = this.kdTfIdf(allCommandPicks);\n'],
      ['    async _getPicks(filter, _disposables, token, runOptions) {\n',
       '    kdTfIdf(allCommandPicks) {\n' +
       '        const docs = allCommandPicks.map(commandPick => ({\n            key: commandPick.commandId,\n            textChunks: [this.getTfIdfChunk(commandPick)]\n        }));\n' +
       '        let key = "";\n' +
       '        for (const doc of docs) {\n            key += doc.key + "\\u0001" + doc.textChunks[0] + "\\u0002";\n        }\n' +
       '        if (this.kdTfIdfKey !== key) {\n' +
       '            const tfidf = new TfIdfCalculator();\n' +
       '            tfidf.updateDocuments(docs);\n' +
       '            this.kdTfIdfCalculator = tfidf;\n' +
       '            this.kdTfIdfKey = key;\n' +
       '        }\n' +
       '        return this.kdTfIdfCalculator;\n' +
       '    }\n' +
       '    async _getPicks(filter, _disposables, token, runOptions) {\n']]],
    // (and a text's terms - cut by a \p{Letter} expression, lowered for iOS 6 into a long class: 5,000 exec calls,
    // a second of the profile - are kept by text: a command whose label changed, or one added, makes the calculator
    // anew from the kept terms)
    ['/vs/base/common/tfIdf.js', [
      ['    static termFrequencies(input) {\n        return countMapFrom(TfIdfCalculator.splitTerms(input));\n    }',
       '    static termFrequencies(input) {\n' +
       '        let kept = TfIdfCalculator.kdTerms;\n' +
       '        if (!kept || TfIdfCalculator.kdTermCount > 4000) {\n            kept = TfIdfCalculator.kdTerms = Object.create(null);\n            TfIdfCalculator.kdTermCount = 0;\n        }\n' +
       '        let tf = kept["k" + input];\n' +
       '        if (!tf) {\n            tf = kept["k" + input] = countMapFrom(TfIdfCalculator.splitTerms(input));\n            TfIdfCalculator.kdTermCount++;\n        }\n' +
       '        return tf;\n' +
       '    }']]],
    // (the filters' words: whether a character separates words was asked of the engine's Set shim - 44,000 times
    // for one filter typed into the palette - and so were the characters' alternatives and each match's memo, a Map:
    // plain arrays now)
    ['/vs/base/common/filters.js', [
      ['function isWordSeparator(code) {\n    return isWhitespace(code) || ( wordSeparators.has(code));\n}',
       'const kdWordSeparator = [];\nwordSeparators.forEach(code => {\n    kdWordSeparator[code] = true;\n});\n' +
       'function isWordSeparator(code) {\n    return isWhitespace(code) || kdWordSeparator[code] === true;\n}'],
      ['const alternateCharsCache = ( new Map());\nfunction getAlternateCodes(code) {\n    if (( alternateCharsCache.has(code))) {\n        return alternateCharsCache.get(code);\n    }\n',
       'const alternateCharsCache = ( new Map());\nconst kdAlternateCodes = [];\nfunction getAlternateCodes(code) {\n' +
       '    const kdKnown = kdAlternateCodes[code];\n    if (kdKnown !== undefined) {\n        return kdKnown === null ? undefined : kdKnown;\n    }\n'],
      ['    alternateCharsCache.set(code, result);\n    return result;\n', '    kdAlternateCodes[code] = result === undefined ? null : result;\n    return result;\n'],
      // (a match of a word with no separator and no alternative characters takes its characters as they are: a
      // contiguous one is the word itself at a word's start in the target, any other its characters in order - not
      // in the target so, no match, at once: the Settings' search asked every setting's name character by character,
      // the palette every command's label)
      ['    const memo = ( new Map());\n    while (targetIndex < target.length) {\n',
       '    if ((contiguous ? target.indexOf(word) === -1 : !kdInOrder(word, target)) && kdPlainWord(word)) {\n        return null;\n    }\n' +
       '    const memo = kdMemo();\n    while (targetIndex < target.length) {\n']],
     'function kdMemo() {\n    const kept = [];\n    return {\n        get(key) {\n            return kept[key];\n        },\n        set(key, value) {\n            kept[key] = value;\n        }\n    };\n}\n' +
     'function kdPlainWord(word) {\n' +
     '    for (let i = 0; i < word.length; i++) {\n' +
     '        const code = word.charCodeAt(i);\n' +
     '        if (isWordSeparator(code) || getAlternateCodes(code)) {\n            return false;\n        }\n' +
     '    }\n' +
     '    return true;\n' +
     '}\n' +
     'function kdInOrder(word, target) {\n' +
     '    let at = 0;\n' +
     '    for (let i = 0; i < word.length; i++) {\n' +
     '        at = target.indexOf(word.charAt(i), at);\n' +
     '        if (at === -1) {\n            return false;\n        }\n' +
     '        at++;\n' +
     '    }\n' +
     '    return true;\n' +
     '}\n'],
    // (and when it is on, the settings matching the words reach the screen before it runs: they waited for it - the
    // page is drawn only when the script is idle)
    ['/vs/workbench/contrib/preferences/browser/settingsEditor2.js', [
      ['            if (!localResults || !localResults.exactMatch) {\n                await this.doRemoteSearch(query, searchInProgress.token);\n            }\n',
       '            if (!localResults || !localResults.exactMatch) {\n' +
       '                if (this.preferencesSearchService.remoteSearchAllowed) {\n' +
       '                    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));\n' +
       '                    if (searchInProgress.token.isCancellationRequested) {\n                        return;\n                    }\n' +
       '                }\n' +
       '                await this.doRemoteSearch(query, searchInProgress.token);\n' +
       '            }\n']]],
    // (the Settings' "similar settings", if turned on - Kodium's default is off, web/src/main.ts: a TF-IDF calculator of
    // all the settings' texts, made anew at every search - kept while the settings' documents are the same, as the
    // provider keeps them)
    ['/vs/workbench/contrib/preferences/browser/preferencesSearch.js', [
      ['        const tfIdfCalculator = ( new TfIdfCalculator());\n        tfIdfCalculator.updateDocuments(this._documents);\n',
       '        if (this.kdCalculatorFor !== this._documents) {\n' +
       '            this.kdCalculator = ( new TfIdfCalculator()).updateDocuments(this._documents);\n' +
       '            this.kdCalculatorFor = this._documents;\n' +
       '        }\n' +
       '        const tfIdfCalculator = this.kdCalculator;\n'],
      // (and the letters and digits of the search and of each setting's id - a \p{L}\p{N} expression, lowered for iOS 6
      // into a class of 5 KB - kept by text: twice per setting at every search)
      ['    _toAlphaNumeric(s) {\n        return s.replace(/[^\\p{L}\\p{N}]+/gu, "");\n    }',
       '    _toAlphaNumeric(s) {\n' +
       '        if (kdAlphaNumericCount > 5000) {\n            kdAlphaNumeric = Object.create(null);\n            kdAlphaNumericCount = 0;\n        }\n' +
       '        const kept = kdAlphaNumeric["k" + s];\n' +
       '        if (kept !== undefined) {\n            return kept;\n        }\n' +
       '        kdAlphaNumericCount++;\n' +
       '        return kdAlphaNumeric["k" + s] = s.replace(/[^\\p{L}\\p{N}]+/gu, "");\n' +
       '    }']],
     'let kdAlphaNumeric = Object.create(null), kdAlphaNumericCount = 0;\n']
  ])
}

// The Settings editor opened in 7 s on the iPad 2 every time: VS Code builds its tree again at each opening - which
// of the ~1000 settings goes under which of 60 headings (40 000 tests of their names against patterns, 2.3 s in the
// profiler), the extensions' headings, then every element of the tree. Nothing of it changes while the editor is
// closed, unless settings are registered or dropped (an extension, a different set of defaults: other groups then) -
// a changed value reaches the closed editor's tree as before. Opened again with the same groups (the same headings,
// with as many settings each: VS Code makes the group objects again whenever its defaults change), it shows the tree
// it has, its rows drawn again.
// (and the first opening: each heading's patterns - "editor.cursor*" and the like - were tried on every setting left,
// a regular expression each; now only on the settings whose names begin with the pattern's part before its first *,
// found in the names sorted once - the same settings come out, 0.8 s less on the iPad 2)
// (and the default settings were written out twice as JSON text with their descriptions - with the "Commonly Used"
// group and without it - whenever they were made, for the Settings editor too; only the second is ever read, by the
// default settings' JSON view: the first is written when asked for)
// (and each of the ~700 settings got its validator made with them: its checks, each with its message put together in
// the display language whether it applies or not - 5400 messages, for a value checked only when a row shows it. A
// validator makes them when it first checks a value; it reads the setting's schema as before)
// (and window.newWindowProfile, which lists the profiles, is registered with the start's other settings, not "eventually"
// - 30-45 s after the start on the iPad 2, the page busy: it came after the warm-up had made the Settings editor's tree,
// and every setting registered drops the default settings, so the tree was built again at the first opening)
// (and Keyboard Shortcuts sorted its ~2000 entries by their labels and commands at every opening - ~22,000 comparisons,
// a localeCompare or two each, the Czech labels mostly the engine's slow way: the order that came out is kept, each
// entry's place by its id and label, and the same entries opened again are put in their places - two numbers compared)
// (and made all its ~1,600 entries anew at every opening - each command looked up in the menus, its labels put
// together in the display language: ~360 ms on the iPad 2. The entries made last are taken again while the
// keybindings - the resolver's list -, the registered commands and menus, the extensions and the labels' count are
// the same; and whether a command has a default keybinding is looked up, not searched for in the ~600 that have one)
function quickerSettings() {
  return patchModules('kodium-quicker-settings', [
    ['/vs/workbench/services/preferences/browser/keybindingsEditorModel.js', [
      ['        this._keybindingItems = this._keybindingItemsSortedByPrecedence.slice(0).sort((a, b) => KeybindingsEditorModel_1.compareKeybindingData(a, b));\n',
       '        this._keybindingItems = kdSortKeybindings(this._keybindingItemsSortedByPrecedence.slice(0));\n'],
      // (the entries made at the last opening, while the keybindings - the resolver's list -, the registered commands and
      // menus, the extensions and the labels' count are the same)
      ['    async resolve(\n        actionLabels = ( new Map())\n    ) {\n        const extensions = this.getExtensionsMapping();\n',
       '    async resolve(\n        actionLabels = ( new Map())\n    ) {\n' +
       '        const kdKeybindings = this.keybindingsService.getKeybindings();\n' +
       '        const kdExtensions = this.extensionService.extensions.length;\n' +
       '        kdWatchRegistries();\n' +
       '        if (kdResolved && kdResolved.keybindings === kdKeybindings && kdResolved.version === kdRegistryVersion && kdResolved.extensions === kdExtensions && kdResolved.labels === actionLabels.size) {\n' +
       '            this._keybindingItemsSortedByPrecedence = kdResolved.byPrecedence.slice(0);\n' +
       '            this._keybindingItems = kdResolved.items.slice(0);\n' +
       '            return super.resolve();\n' +
       '        }\n' +
       '        const extensions = this.getExtensionsMapping();\n'],
      ['        this._keybindingItems = kdSortKeybindings(this._keybindingItemsSortedByPrecedence.slice(0));\n        return super.resolve();\n',
       '        this._keybindingItems = kdSortKeybindings(this._keybindingItemsSortedByPrecedence.slice(0));\n' +
       '        kdResolved = { keybindings: kdKeybindings, version: kdRegistryVersion, extensions: kdExtensions, labels: actionLabels.size,\n' +
       '            byPrecedence: this._keybindingItemsSortedByPrecedence.slice(0), items: this._keybindingItems.slice(0) };\n' +
       '        return super.resolve();\n'],
      // (whether a command has a default keybinding: looked up, not searched for in the ~600 commands that have one)
      ['                commandsWithDefaultKeybindings.indexOf(command) === -1,\n', '                kdNotDefault(commandsWithDefaultKeybindings, command),\n']],
     'import { CommandsRegistry as KdCommandsRegistry } from "../../../../platform/commands/common/commands.js";\n' +
     'import { MenuRegistry as KdMenuRegistry } from "../../../../platform/actions/common/actions.js";\n' +
     'let kdResolved = null;\n' +
     'let kdRegistryVersion = 0;\n' +
     'let kdWatching = false;\n' +
     'function kdWatchRegistries() {\n' +
     '    if (kdWatching) {\n        return;\n    }\n' +
     '    kdWatching = true;\n' +
     '    KdMenuRegistry.onDidChangeMenu(() => kdRegistryVersion++);\n' +
     '    KdCommandsRegistry.onDidRegisterCommand(() => kdRegistryVersion++);\n' +
     '}\n' +
     'let kdDefaultsTable = null;\n' +
     'function kdNotDefault(list, command) {\n' +
     '    let table = kdDefaultsTable;\n' +
     '    if (!table || table.list !== list) {\n' +
     '        table = kdDefaultsTable = { list, set: Object.create(null) };\n' +
     '        for (let i = 0; i < list.length; i++) {\n            table.set["k" + list[i]] = true;\n        }\n' +
     '    }\n' +
     '    return table.set["k" + command] !== true;\n' +
     '}\n' +
     'let kdOrder = null;\n' +
     'function kdSortKeybindings(items) {\n' +
     '    const key = item => KeybindingsEditorModel_1.getId(item) + "\\u0001" + (item.commandLabel || "");\n' +
     '    const keys = items.map(key);\n' +
     '    if (kdOrder && kdOrder.count === items.length && keys.every(k => kdOrder.places["k" + k] !== undefined)) {\n' +
     '        const placed = items.map((item, i) => ({ place: kdOrder.places["k" + keys[i]], item }));\n' +
     '        placed.sort((x, y) => x.place - y.place);\n' +
     '        return placed.map(x => x.item);\n' +
     '    }\n' +
     '    const sorted = items.sort((a, b) => KeybindingsEditorModel_1.compareKeybindingData(a, b));\n' +
     '    const places = Object.create(null);\n' +
     '    for (let i = 0; i < sorted.length; i++) {\n        places["k" + key(sorted[i])] = i;\n    }\n' +
     '    kdOrder = { count: sorted.length, places };\n' +
     '    return sorted;\n' +
     '}\n'],
    // (and its layout - as it shows, before its entries are made, and after - measured the page twice each time: the
    // width of its search actions and the height of its header, both the same every time - 96 ms when it came back into
    // the page on the iPad 2: measured once now)
    ['/vs/workbench/contrib/preferences/browser/keybindingsEditor.js', [
      ['        this.searchWidget.inputBox.inputElement.style.paddingRight = `${getTotalWidth(this.actionsContainer) + 12}px`;\n',
       '        const kdWidth = this.kdActionsWidth || getTotalWidth(this.actionsContainer);\n' +
       '        if (kdWidth > 0) {\n            this.kdActionsWidth = kdWidth;\n        }\n' +
       '        this.searchWidget.inputBox.inputElement.style.paddingRight = `${kdWidth + 12}px`;\n'],
      ['        const tableHeight = this.dimension.height - (getDomNodePagePosition(this.headerContainer).height + 12) ;\n',
       '        const kdSmall = this.headerContainer.classList.contains("small") ? 1 : 0;\n' +
       '        let kdHeader = this.kdHeaderHeights && this.kdHeaderHeights[kdSmall];\n' +
       '        if (!kdHeader) {\n' +
       '            kdHeader = getDomNodePagePosition(this.headerContainer).height;\n' +
       '            if (kdHeader > 0) {\n                (this.kdHeaderHeights || (this.kdHeaderHeights = []))[kdSmall] = kdHeader;\n            }\n' +
       '        }\n' +
       '        const tableHeight = this.dimension.height - (kdHeader + 12) ;\n'],
      // (the table's width too: the editor's less what its padding takes, measured the first time)
      ['        this.keybindingsTable.layout(tableHeight);\n    }\n',
       '        const kdInsets = this.kdTableInsets || (this.kdTableInsets = []);\n' +
       '        this.keybindingsTable.layout(tableHeight, kdInsets[kdSmall] !== undefined ? this.dimension.width - kdInsets[kdSmall] : undefined);\n' +
       '        if (kdInsets[kdSmall] === undefined && this.keybindingsTable.cachedWidth > 0) {\n            kdInsets[kdSmall] = this.dimension.width - this.keybindingsTable.cachedWidth;\n        }\n' +
       '    }\n']]],
    ['/vs/workbench/browser/workbench.contribution.js', [
      ['        DynamicWindowConfiguration.ID,\n        DynamicWindowConfiguration,\n        WorkbenchPhase.Eventually\n',
       '        DynamicWindowConfiguration.ID,\n        DynamicWindowConfiguration,\n        WorkbenchPhase.AfterRestored\n']]],
    ['/vs/workbench/services/preferences/common/preferencesValidation.js', [
      ['function createValidator(prop) {\n    const type = Array.isArray(prop.type) ? prop.type : [prop.type];',
       'function createValidator(prop) {\n    let validate;\n    return value => (validate || (validate = kdCreateValidator(prop)))(value);\n}\n' +
       'function kdCreateValidator(prop) {\n    const type = Array.isArray(prop.type) ? prop.type : [prop.type];']]],
    ['/vs/workbench/services/preferences/common/preferencesModels.js', [
      ['    getContent(forceUpdate = false) {\n        if (!this._content || forceUpdate) {\n            this.initialize();\n        }\n        return this._content;\n    }',
       '    getContent(forceUpdate = false) {\n' +
       '        if (!this._allSettingsGroups || forceUpdate) {\n            this.initialize();\n        }\n' +
       '        if (this._content === undefined) {\n' +
       '            this._content = this.toContent(this._allSettingsGroups, 0);\n' +
       '            this._contentWithoutMostCommonlyUsed = this.toContent(this._allSettingsGroups, 1);\n' +
       '        }\n' +
       '        return this._content;\n    }'],
      ['        this._allSettingsGroups = this.parse();\n        this._content = this.toContent(this._allSettingsGroups, 0);\n',
       '        this._allSettingsGroups = this.parse();\n        this._content = undefined;\n']]],
    ['/vs/workbench/contrib/preferences/browser/settingsTree.js', [
      ['function getMatchingSettings(allSettings, filter) {\n    const result = [];\n',
       'function kdSettingsByPrefix(allSettings, patterns) {\n' +
       '    let index = allSettings.kdIndex;\n' +
       '    if (!index) {\n' +
       '        index = allSettings.kdIndex = Array.from(allSettings, s => [s.key.toLowerCase(), s]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);\n' +
       '    }\n' +
       '    const found = new Set();\n' +
       '    for (const pattern of patterns) {\n' +
       '        const star = pattern.indexOf("*");\n' +
       '        const prefix = (star < 0 ? pattern : pattern.slice(0, star)).toLowerCase();\n' +
       '        let lo = 0, hi = index.length;\n' +
       '        while (lo < hi) {\n' +
       '            const mid = (lo + hi) >> 1;\n' +
       '            if (index[mid][0] < prefix) lo = mid + 1; else hi = mid;\n' +
       '        }\n' +
       '        for (let i = lo; i < index.length && index[i][0].lastIndexOf(prefix, 0) === 0; i++) {\n' +
       '            const setting = index[i][1];\n' +
       '            if (allSettings.has(setting) && settingMatches(setting, pattern)) found.add(setting);\n' +
       '        }\n' +
       '    }\n' +
       '    return found;\n' +
       '}\n' +
       'function getMatchingSettings(allSettings, filter) {\n    const result = [];\n' +
       '    const patterns = filter.include?.keyPatterns;\n' +
       '    if (patterns && !filter.include.tags?.length && !filter.exclude?.keyPatterns &&\n' +
       '        !patterns.some(pattern => pattern.startsWith("@tag:") || pattern.indexOf("*") === 0)) {\n' +
       '        const excludeTags = filter.exclude?.tags || [];\n' +
       '        for (const setting of kdSettingsByPrefix(allSettings, patterns)) {\n' +
       '            if (excludeTags.length && excludeTags.some(tag => setting.tags?.includes(tag))) continue;\n' +
       '            result.push(setting);\n' +
       '            if (!( multiGroupTocSettings.has(setting.key))) {\n' +
       '                allSettings.delete(setting);\n' +
       '            }\n' +
       '        }\n' +
       '        return result;\n' +
       '    }\n']]],
    ['/vs/workbench/contrib/preferences/browser/settingsEditor2.js', [
      ['        this._setOptions(options);\n        this.onConfigUpdate(undefined, true).then(() => {',
       '        this._setOptions(options);\n        (this.kdSameTree(model) ? this.kdShowTree() : this.onConfigUpdate(undefined, true)).then(() => {'],
      ['    async refreshInstalledExtensionsList() {\n        const installedExtensions = await this.extensionManagementService.getInstalled();\n',
       '    kdTreeShape(groups) {\n' +
       '        return groups.map(group => group.id + ":" + group.sections.reduce((n, section) => n + section.settings.length, 0)).join(",");\n' +
       '    }\n' +
       '    kdSameTree(model) {\n' +
       '        return !!(this.settingsTreeModel.value && this.kdTreeGroups && !this.kdTreeStale && this.kdTreeAdvanced === this.canShowAdvancedSettings() &&\n' +
       '            !this.viewState.query && !this.searchResultModel && this.kdTreeShape(model.settingsGroups) === this.kdTreeGroups);\n' +
       '    }\n' +
       '    async kdShowTree() {\n' +
       '        const stale = this.kdStaleRows || [];\n' +
       '        this.kdStaleRows = undefined;\n' +
       '        stale.forEach((element, i) => { if (stale.indexOf(element) === i) this.refreshSingleElement(element); });\n' +
       '        this.settingsTree.rerender();\n' +
       '        this.tocTree.rerender();\n' +
       '    }\n' +
       '    async refreshInstalledExtensionsList() {\n' +
       '        if (!this.kdInstalledWatched) {\n' +
       '            this.kdInstalledWatched = true;\n' +
       '            const service = this.extensionManagementService, changed = () => { this.kdInstalledKnown = false; };\n' +
       '            for (const event of [service.onDidUpdateExtensionMetadata, service.onDidChangeProfile, service.onProfileAwareDidInstallExtensions, service.onProfileAwareDidUninstallExtension]) {\n' +
       '                if (event) this._register(event(changed));\n' +
       '            }\n' +
       '        }\n' +
       '        if (this.kdInstalledKnown) return;\n' +
       '        this.kdInstalledKnown = true;\n' +
       '        let installedExtensions;\n' +
       '        try { installedExtensions = await this.extensionManagementService.getInstalled(); } catch (e) { this.kdInstalledKnown = false; throw e; }\n'],
      ['        this._register(extensionManagementService.onDidInstallExtensions(() => {\n            this.refreshInstalledExtensionsList();',
       '        this._register(extensionManagementService.onDidInstallExtensions(() => {\n            this.kdInstalledKnown = false;\n            this.refreshInstalledExtensionsList();'],
      ['        this._register(extensionManagementService.onDidUninstallExtension(() => {\n            this.refreshInstalledExtensionsList();',
       '        this._register(extensionManagementService.onDidUninstallExtension(() => {\n            this.kdInstalledKnown = false;\n            this.refreshInstalledExtensionsList();'],
      ['    refreshSingleElement(element) {\n',
       '    refreshSingleElement(element) {\n        if (!this.isVisible()) {\n            (this.kdStaleRows || (this.kdStaleRows = [])).push(element);\n            return;\n        }\n'],
      ['            this.settingsTree.setChildren(null, createGroupIterator(this.currentSettingsModel.root));\n        }\n',
       '            this.settingsTree.setChildren(null, createGroupIterator(this.currentSettingsModel.root));\n        } else if (!this.isVisible()) {\n            this.kdTreeStale = true;\n        }\n'],
      ['            this.tocTree.setChildren(null, createTOCIterator(this.tocTreeModel));\n        }\n',
       '            this.tocTree.setChildren(null, createTOCIterator(this.tocTreeModel));\n        } else {\n            this.kdTreeStale = true;\n        }\n'],
      ['        const groups = this.defaultSettingsEditorModel.settingsGroups.slice(1);\n        const coreSettingsGroups = [], extensionSettingsGroups = [];',
       '        this.kdTreeGroups = this.kdTreeShape(this.defaultSettingsEditorModel.settingsGroups);\n        this.kdTreeAdvanced = this.canShowAdvancedSettings();\n        this.kdTreeStale = false;\n' +
       '        const groups = this.defaultSettingsEditorModel.settingsGroups.slice(1);\n        const coreSettingsGroups = [], extensionSettingsGroups = [];']]]
  ])
}

// What a keystroke made for nothing (measured on the iPad 2 with the engine's heap report: an edit allocates 150-180 KB,
// and every 12 MB of it is a garbage collection of 0.35-0.5 s at the next pause, every ~50 MB one in the middle of
// typing):
// - the window's setTimeout and clearTimeout went through VS Code's wrapper for auxiliary windows - arrays of the
//   arguments, the windows' Map asked for its size - ~30 times a key (every debounced task is put off again); Kodium
//   has the one window: the browser's own stay
// - every logService.trace() and debug() - the editor's text area, the history of places... ~10 a key - copied its
//   arguments through three loggers before the last one found the level off (Info here): they stop at the start
// - the links (off: editor.links) and the viewport's semantic tokens (no provider) worked out how long to wait from the
//   languages' providers at every key - and the semantic tokens at every frame of a scroll too
function lighterTyping() {
  return patchModules('kodium-lighter-typing', [
    ['/vs/workbench/browser/window.js', [
      ['        this.enableMultiWindowAwareTimeout(targetWindow, dom);\n', '']]],
    // (the workbench's state flushed every 60 s, as VS Code's desktop does, not every 5 as in a browser tab: each
    // flush had every component save its state - 50-100 ms on the iPad 2, in the next pause of typing; the app flushes
    // it when it goes to the background, web/src/main.ts __kd_saveAll)
    ['/vs/workbench/services/storage/browser/storageService.js', [
      ['this.BROWSER_DEFAULT_FLUSH_INTERVAL = 5 * 1000;', 'this.BROWSER_DEFAULT_FLUSH_INTERVAL = 60 * 1000;']]],
    // (Monarch asks each rule whether its regex is a RegExp or a function of the state at every try - 35,000 times
    // for a file of 1,000 lines: the answer is kept with the regex it was given for; an action's cases are tried with
    // an index, not the lowered for...of's function call per case)
    ['/vs/editor/standalone/common/monarch/monarchCompile.js', [
      ['    resolveRegex(state) {\n        if (this.regex instanceof RegExp) {\n            return this.regex;\n        } else {\n            return this.regex(state);\n        }\n    }',
       '    resolveRegex(state) {\n        if (this.kdRegex !== this.regex) {\n            this.kdRegex = this.regex;\n            this.kdIsRegExp = this.regex instanceof RegExp;\n        }\n' +
       '        return this.kdIsRegExp ? this.regex : this.regex(state);\n    }'],
      ['                for (const _case of cases) {\n                    const didmatch = (!_case.test || _case.test(id, matches, state, eos));\n',
       '                for (let kdIndex = 0; kdIndex < cases.length; kdIndex++) {\n                    const _case = cases[kdIndex];\n                    const didmatch = (!_case.test || _case.test(id, matches, state, eos));\n']]],
    // (and tries the rules with an index and the regex's own exec - the lowered for...of called a function for each
    // rule, and String.prototype.match went through the engine's regexp shim; Monarch's regexes have no g flag, for
    // which match is exec -, with a rule's regex taken without a call when it is one. A token's type is sanitized
    // once, and the tokens go in without Array.prototype.push: the engine's stand-in, two functions more a push.)
    ['/vs/editor/standalone/common/monarch/monarchLexer.js', [
      ['                for (const rule of rules) {\n                    if (pos === 0 || !rule.matchOnlyAtLineStart) {\n                        matches = restOfLine.match(rule.resolveRegex(state));\n',
       '                for (let kdIndex = 0; kdIndex < rules.length; kdIndex++) {\n                    const rule = rules[kdIndex];\n                    if (pos === 0 || !rule.matchOnlyAtLineStart) {\n' +
       '                        const kdRegex = rule.kdRegex === rule.regex && rule.kdIsRegExp ? rule.regex : rule.resolveRegex(state);\n' +
       '                        matches = kdRegex.exec(restOfLine);\n'],
      ['                    const token = (result === "" ? "" : result + this._lexer.tokenPostfix);\n                    tokenType = sanitize(token);\n',
       '                    const token = (result === "" ? "" : result + this._lexer.tokenPostfix);\n                    tokenType = kdSanitize(token);\n'],
      ['        this._lastTokenMetadata = metadata;\n        this._tokens.push(startOffset);\n        this._tokens.push(metadata);\n',
       '        this._lastTokenMetadata = metadata;\n        const kdTokens = this._tokens;\n        kdTokens[kdTokens.length] = startOffset;\n        kdTokens[kdTokens.length] = metadata;\n'],
      ['function findBracket(lexer, matched) {\n',
       'const kdSanitized = { count: 0, types: Object.create(null) };\n' +
       'function kdSanitize(token) {\n' +
       '    let type = kdSanitized.types[token];\n' +
       '    if (type === undefined) {\n' +
       '        if (++kdSanitized.count > 2000) {\n            kdSanitized.count = 1;\n            kdSanitized.types = Object.create(null);\n        }\n' +
       '        type = kdSanitized.types[token] = sanitize(token);\n' +
       '    }\n' +
       '    return type;\n' +
       '}\n' +
       'function findBracket(lexer, matched) {\n']]],
    // (an Enter or a deleted line took the editor's lines out of the page at once, in the key's own handling - a line,
    // its overlay and its number: the page was laid out and its layers put together again before the frame that draws
    // the key, 80-130 ms on the iPad 2 between the key and its frame. They go at the start of that frame's rendering
    // now, with the rest of its changes; a line that left the drawn range is off the screen until then.)
    ['/vs/editor/browser/view/viewLayer.js', [
      ['    onFlushed(e, flushDom) {\n        if (flushDom) {\n',
       '    kdRemoveLeft() {\n        const nodes = this.kdLeft;\n        if (nodes) {\n            this.kdLeft = null;\n            for (let i = 0; i < nodes.length; i++) {\n                nodes[i].remove();\n            }\n        }\n    }\n' +
       '    onFlushed(e, flushDom) {\n        this.kdRemoveLeft();\n        if (flushDom) {\n'],
      ['    onLinesDeleted(e) {\n        const deleted = this._linesCollection.onLinesDeleted(e.fromLineNumber, e.toLineNumber);\n        if (deleted) {\n            for (let i = 0, len = deleted.length; i < len; i++) {\n                const lineDomNode = deleted[i].getDomNode();\n                lineDomNode?.remove();\n            }\n        }\n',
       '    onLinesDeleted(e) {\n        const deleted = this._linesCollection.onLinesDeleted(e.fromLineNumber, e.toLineNumber);\n        if (deleted) {\n            for (let i = 0, len = deleted.length; i < len; i++) {\n                const lineDomNode = deleted[i].getDomNode();\n                if (lineDomNode) {\n                    (this.kdLeft || (this.kdLeft = [])).push(lineDomNode);\n                }\n            }\n        }\n'],
      ['    onLinesInserted(e) {\n        const deleted = this._linesCollection.onLinesInserted(e.fromLineNumber, e.toLineNumber);\n        if (deleted) {\n            for (let i = 0, len = deleted.length; i < len; i++) {\n                const lineDomNode = deleted[i].getDomNode();\n                lineDomNode?.remove();\n            }\n        }\n',
       '    onLinesInserted(e) {\n        const deleted = this._linesCollection.onLinesInserted(e.fromLineNumber, e.toLineNumber);\n        if (deleted) {\n            for (let i = 0, len = deleted.length; i < len; i++) {\n                const lineDomNode = deleted[i].getDomNode();\n                if (lineDomNode) {\n                    (this.kdLeft || (this.kdLeft = [])).push(lineDomNode);\n                }\n            }\n        }\n'],
      ['    renderLines(viewportData) {\n        const inp = this._linesCollection._get();\n',
       '    renderLines(viewportData) {\n        this.kdRemoveLeft();\n        const inp = this._linesCollection._get();\n'],
      // (and a line drawn anew - its text, its overlays, its number after an Enter above it - keeps its elements: the
      // new ones' attributes and text go into those that are already there, of the same tag, instead of the line being
      // replaced - each replaced line, and its positioned parts, was a layer the engine took down and made again)
      ['                const source = hugeDomNode.firstChild;\n                const lineDomNode = line.getDomNode();\n                lineDomNode.replaceWith(source);\n                line.setDomNode(source);\n',
       '                const source = hugeDomNode.firstChild;\n                const lineDomNode = line.getDomNode();\n' +
       '                if (lineDomNode.tagName === source.tagName) {\n                    kdMorph(lineDomNode, source);\n                    hugeDomNode.removeChild(source);\n                    line.setDomNode(lineDomNode);\n                } else {\n' +
       '                    lineDomNode.replaceWith(source);\n                    line.setDomNode(source);\n                }\n'],
      ['class ViewLayerRenderer {',
       'function kdMorph(target, source) {\n' +
       '    const attrs = source.attributes;\n' +
       '    for (let i = 0; i < attrs.length; i++) {\n        const a = attrs[i];\n        if (target.getAttribute(a.name) !== a.value) {\n            target.setAttribute(a.name, a.value);\n        }\n    }\n' +
       '    const old = target.attributes;\n' +
       '    for (let i = old.length - 1; i >= 0; i--) {\n        if (!source.hasAttribute(old[i].name)) {\n            target.removeAttribute(old[i].name);\n        }\n    }\n' +
       '    let t = target.firstChild, s = source.firstChild;\n' +
       '    while (t && s) {\n' +
       '        const tNext = t.nextSibling, sNext = s.nextSibling;\n' +
       '        if (t.nodeType === 3 && s.nodeType === 3) {\n            if (t.nodeValue !== s.nodeValue) {\n                t.nodeValue = s.nodeValue;\n            }\n' +
       '        } else if (t.nodeType === 1 && s.nodeType === 1 && t.tagName === s.tagName) {\n            kdMorph(t, s);\n' +
       '        } else {\n            target.replaceChild(s, t);\n        }\n' +
       '        t = tNext;\n        s = sNext;\n' +
       '    }\n' +
       '    while (t) {\n        const next = t.nextSibling;\n        target.removeChild(t);\n        t = next;\n    }\n' +
       '    while (s) {\n        const next = s.nextSibling;\n        target.appendChild(s);\n        s = next;\n    }\n' +
       '}\n' +
       'class ViewLayerRenderer {']]],
    // (and the cursor's transition, set to the same value at every move of the cursor - a change of its style in the
    // key's own handling, the same layout before the frame: set when it changes)
    ['/vs/editor/browser/viewParts/viewCursors/viewCursor.js', [
      ['        if (pauseAnimation) {\n            this._domNode.domNode.style.transitionProperty = "none";\n        } else {\n            this._domNode.domNode.style.transitionProperty = "";\n        }\n',
       '        const kdTransition = pauseAnimation ? "none" : "";\n        if (this.kdTransition !== kdTransition) {\n            this.kdTransition = kdTransition;\n            this._domNode.domNode.style.transitionProperty = kdTransition;\n        }\n']]],
    // (the rest of a file's tokens is made in the page's idle time, in steps until the 50 ms given are spent: it stops
    // at the next step once a key or a touch came - timeRemaining() is 0 then, vsc-prelude.js - instead of going on to
    // the end with the input's frame waiting behind it. A step is 5 ms instead of 1: each one's tokens went to the
    // model, the view's parts and the bracket pairs on their own, and the next step came through a message event.)
    ['/vs/editor/common/model/textModelTokens.js', [
      ['            this._backgroundTokenizeForAtLeast1ms();\n            if (Date.now() < endTime) {\n',
       '            this._backgroundTokenizeForAtLeast1ms();\n            if (Date.now() < endTime && deadline.timeRemaining() > 0) {\n'],
      ['        do {\n            if (sw.elapsed() > 1) {\n                break;\n            }\n',
       '        do {\n            if (sw.elapsed() > 5) {\n                break;\n            }\n']]],
    ['/vs/platform/log/common/logService.js', [
      ['    trace(message, ...args) {\n        this.logger.trace(message, ...args);\n    }',
       '    trace(message) {\n        const level = this.logger.getLevel();\n        if (level === 0 || level > 1) {\n            return;\n        }\n        this.logger.trace.apply(this.logger, arguments);\n    }'],
      ['    debug(message, ...args) {\n        this.logger.debug(message, ...args);\n    }',
       '    debug(message) {\n        const level = this.logger.getLevel();\n        if (level === 0 || level > 2) {\n            return;\n        }\n        this.logger.debug.apply(this.logger, arguments);\n    }']]],
    // (a file's first change after a save - an autosave's, every few seconds of typing: the model is dirty at once, the
    // event that says so comes after the frame with the typed letter. Its listeners - the tab's and Open Editors' dirty
    // dots, the dirty count's badge, the context keys of the group, of the working copies and of Open Editors, each
    // change of them gone through every menu and scoped context - took ~70 ms before that frame, and the styles they
    // changed had the editor's next read of its text area lay out the workbench: 27 ms more. The autosave and the
    // backup are scheduled by the content's change, as before.)
    ['/vs/workbench/services/textfile/common/textFileEditorModel.js', [
      ['                this.trace("onModelContentChanged() - model content changed and marked as dirty");\n                this.setDirty(true);\n',
       '                this.trace("onModelContentChanged() - model content changed and marked as dirty");\n                this.kdSetDirtyAfterFrame();\n'],
      ['    setDirty(dirty) {\n        if (!this.isResolved()) {\n            return;\n        }\n',
       '    kdSetDirtyAfterFrame() {\n' +
       '        if (!this.isResolved()) {\n            return;\n        }\n' +
       '        const wasDirty = this.dirty;\n' +
       '        this.doSetDirty(true);\n' +
       '        if (wasDirty || this.kdDirtyFrame) {\n            return;\n        }\n' +
       '        this.kdDirtyFrame = true;\n' +
       '        requestAnimationFrame(() => setTimeout(() => {\n' +
       '            this.kdDirtyFrame = false;\n' +
       '            if (!this.isDisposed()) {\n                this._onDidChangeDirty.fire();\n            }\n' +
       '        }, 20));\n' +
       '    }\n' +
       '    setDirty(dirty) {\n        if (!this.isResolved()) {\n            return;\n        }\n']]],
    // (and Open Editors draws its row's dirty dot - the class its renderer sets - instead of making the row again, 17 ms
    // of its label; the focus set again only when the row has it, for the context key that follows its dirty state)
    ['/vs/workbench/contrib/files/browser/views/openEditorsView.js', [
      ['                case GroupModelChangeKind.EDITOR_DIRTY:\n                case GroupModelChangeKind.EDITOR_STICKY:\n',
       '                case GroupModelChangeKind.EDITOR_DIRTY:\n                    if (this.kdDirtyRow(index, e.editor)) {\n                        break;\n                    }\n                case GroupModelChangeKind.EDITOR_STICKY:\n'],
      ['    getIndex(group, editor) {\n',
       '    kdDirtyRow(index, editor) {\n' +
       '        const view = this.list && this.list.view;\n' +
       '        if (index < 0 || !editor || !view || typeof view.domElement !== "function" || index >= view.length) {\n            return false;\n        }\n' +
       '        const row = view.domElement(index);\n' +
       '        if (row) {\n            row.classList.toggle("dirty", editor.isDirty() && !editor.isSaving());\n        }\n' +
       '        const focus = this.list.getFocus();\n' +
       '        if (focus.length === 1 && focus[0] === index) {\n            this.list.setFocus(focus);\n        }\n' +
       '        return true;\n' +
       '    }\n' +
       '    getIndex(group, editor) {\n']]],
    ['/vs/editor/contrib/links/browser/links.js', [
      ['        this._register(editor.onDidChangeModelContent(e => {\n            if (!this.editor.hasModel()) {\n                return;\n            }\n            this.computeLinks.schedule(',
       '        this._register(editor.onDidChangeModelContent(e => {\n            if (!this.editor.hasModel() || !this.editor.getOption(EditorOption.links)) {\n                return;\n            }\n            this.computeLinks.schedule(']]],
    ['/vs/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js', [
      ['            if (this._editor.hasModel()) {\n                this._tokenizeViewport.schedule(this._debounceInformation.get(this._editor.getModel()));',
       '            if (this._editor.hasModel() && (this._provider._entries.length || this._editor.getModel().tokenization.hasSomeSemanticTokens())) {\n                this._tokenizeViewport.schedule(this._debounceInformation.get(this._editor.getModel()));']]]
  ])
}

// A file opened is drawn with the editor's state it opens with: the text editor drew its lines at the next animation
// frame after the model was attached - after the workbench's own work for the opening (the tab, the listeners of the
// active editor, ~200 ms on the iPad 2) and a paint of the editor without them; drawn at the end of its setInput (the
// view state restored, the options applied), the first paint has the text. The frame then finds nothing to draw.
// The status bar's entries for the editor (cursor position, indentation, encoding, language...) are updated after
// the frame, not in it: 50 ms of the first frame of an opening, and a part of every key's.
function soonerFirstLines() {
  return patchModules('kodium-sooner-first-lines', [
    ['/vs/workbench/contrib/files/browser/editors/textFileEditor.js', [
      ['            if (control.handleInitialized) {\n                control.handleInitialized();\n            }\n',
       '            if (control.handleInitialized) {\n                control.handleInitialized();\n            }\n            control.render();\n']]],
    ['/vs/workbench/browser/parts/editor/editorStatus.js', [
      ['            this.delayedRender.value = runAtThisOrScheduleAtNextAnimationFrame(getWindowById(this.targetWindowId, true).window, () => {\n' +
       '                this.delayedRender.clear();\n' +
       '                const toRender = this.toRender;\n' +
       '                this.toRender = undefined;\n' +
       '                if (toRender) {\n' +
       '                    this.doRenderNow();\n' +
       '                }\n' +
       '            });',
       '            const kdWindow = getWindowById(this.targetWindowId, true).window;\n' +
       '            this.delayedRender.value = runAtThisOrScheduleAtNextAnimationFrame(kdWindow, () => {\n' +
       '                const kdHandle = kdWindow.setTimeout(() => {\n' +
       '                    this.delayedRender.clear();\n' +
       '                    const toRender = this.toRender;\n' +
       '                    this.toRender = undefined;\n' +
       '                    if (toRender) {\n' +
       '                        this.doRenderNow();\n' +
       '                    }\n' +
       '                }, 0);\n' +
       '                this.delayedRender.value = { dispose: () => kdWindow.clearTimeout(kdHandle) };\n' +
       '            });']]]
  ])
}
// Scrolling with a finger (measured on the iPad 2 with touch events made in the page, which is the way a finger
// goes: VS Code's Gesture turns them into the editor's scroll):
// - the engine makes pointer events of touches (its Pointer Events polyfill), and the editor took every pointermove
//   of a finger for a mouse move: the position under it worked out (a forced layout, caretRangeFromPoint) and the
//   hover's and the links' handlers run, at every move of the finger - a quarter of a scrolling frame in the
//   profiler. A finger's moves scroll (Gesture) or select nothing: they are not mouse moves.
// - the line numbers made each line's HTML anew at every frame (two view-to-model conversions a line and a template):
//   kept while only the scroll position changes (any other change of the editor drops them).
// - the indent guides asked each line's length (the piece tree) to see over how many view lines it wraps - one, when
//   its projection has one line; and without bracket pair guides (off by default) each line's guides are kept while
//   its indentation, the active guide on it and the scroll width stay: their HTML and the position of column 1 were
//   made anew for every line at every frame.
// - lines drawn ahead: a frame in which lines came onto the screen cost ~65 ms, one that only moved them ~27 (the old
//   WebKit's style, layout, compositing and paint for any change of the lines, more than for the lines themselves).
//   The editor draws 10 lines more above and below the screen and keeps them while the screen's lines stay inside
//   with 2 lines to spare; then it draws the next ones, again 10 around. Features see the lines on the screen as before
//   (the view model's viewport), and a content widget whose line is off the screen stays hidden.
function smootherScroll() {
  return patchModules('kodium-smoother-scroll', [
    ['/vs/editor/browser/controller/pointerHandler.js', [
      ['            pointerEvents.onPointerMove(this.viewHelper.viewDomNode, e => this._onMouseMove(e))',
       '            pointerEvents.onPointerMove(this.viewHelper.viewDomNode, e => {\n' +
       '                if (e.browserEvent.pointerType !== "touch") {\n                    this._onMouseMove(e);\n                }\n' +
       '            })']]],
    ['/vs/editor/browser/viewParts/lineNumbers/lineNumbers.js', [
      ['    onConfigurationChanged(e) {\n        this._readConfig();\n        return true;\n    }',
       '    onConfigurationChanged(e) {\n        this._readConfig();\n        this.kdLines = null;\n        return true;\n    }'],
      ['            this._activeModelLineNumber = this._lastCursorModelPosition.lineNumber;\n            shouldRender = true;',
       '            this._activeModelLineNumber = this._lastCursorModelPosition.lineNumber;\n            this.kdLines = null;\n            shouldRender = true;'],
      ['    onFlushed(e) {\n        return true;\n    }\n    onLinesChanged(e) {\n        return true;\n    }\n    onLinesDeleted(e) {\n        return true;\n    }\n    onLinesInserted(e) {\n        return true;\n    }',
       '    onFlushed(e) {\n        this.kdLines = null;\n        return true;\n    }\n    onLinesChanged(e) {\n        this.kdLines = null;\n        return true;\n    }\n' +
       '    onLinesDeleted(e) {\n        this.kdLines = null;\n        return true;\n    }\n    onLinesInserted(e) {\n        this.kdLines = null;\n        return true;\n    }'],
      ['    onZonesChanged(e) {\n        return true;\n    }\n    onDecorationsChanged(e) {\n        return e.affectsLineNumber;\n    }',
       '    onZonesChanged(e) {\n        this.kdLines = null;\n        return true;\n    }\n    onDecorationsChanged(e) {\n        if (e.affectsLineNumber) {\n            this.kdLines = null;\n        }\n        return e.affectsLineNumber;\n    }'],
      ['        const output = [];\n        for (let lineNumber = visibleStartLineNumber; lineNumber <= visibleEndLineNumber; lineNumber++) {\n            const lineIndex = lineNumber - visibleStartLineNumber;\n',
       '        const output = [];\n' +
       '        let kdLines = null;\n' +
       '        if (!lineNoDecorations.length && this._renderLineNumbers === RenderLineNumbersType.On && !this._renderCustomLineNumbers) {\n' +
       '            kdLines = this.kdLines;\n' +
       '            if (!kdLines || kdLines.count > 600) {\n                kdLines = this.kdLines = { count: 0, html: Object.create(null) };\n            }\n' +
       '        }\n' +
       '        for (let lineNumber = visibleStartLineNumber; lineNumber <= visibleEndLineNumber; lineNumber++) {\n            const lineIndex = lineNumber - visibleStartLineNumber;\n' +
       '            if (kdLines) {\n                const kept = kdLines.html[lineNumber];\n                if (kept !== undefined) {\n                    output[lineIndex] = kept;\n                    continue;\n                }\n            }\n'],
      ['            output[lineIndex] = (`<div class="${LineNumbersOverlay.CLASS_NAME}${lineHeightClassName}${extraClassNames}" style="left:${this._lineNumbersLeft}px;width:${this._lineNumbersWidth}px;">${renderLineNumber}</div>`);',
       '            output[lineIndex] = (`<div class="${LineNumbersOverlay.CLASS_NAME}${lineHeightClassName}${extraClassNames}" style="left:${this._lineNumbersLeft}px;width:${this._lineNumbersWidth}px;">${renderLineNumber}</div>`);\n' +
       '            if (kdLines) {\n                kdLines.html[lineNumber] = output[lineIndex];\n                kdLines.count++;\n            }']]],
    ['/vs/editor/common/viewModel/viewModelLines.js', [
      ['                const viewLineEndIndex = line.getViewLineNumberOfModelPosition(0, this.model.getLineMaxColumn(modelLineIndex + 1));',
       '                const viewLineEndIndex = line.getViewLineCount() === 1 ? 0 : line.getViewLineNumberOfModelPosition(0, this.model.getLineMaxColumn(modelLineIndex + 1));'],
      // (a file's lines are projected for the view at every opening and switch: each line's injected text - inlay
      // hints, ghost text - was looked for in the decorations' tree, 1,500 searches for a file of 1,500 lines, and its
      // text read to work out the wrapping. A model with no injected text at all - the usual one - answers none at
      // once; see also monospaceLineBreaksComputer.js below)
      ['        const context = _context ?? {\n            getLineContent: lineNumber => {\n                return this.model.getLineContent(lineNumber);\n            },\n            getLineInjectedText: lineNumber => {\n                return this.model.getLineInjectedText(lineNumber, this._editorId);\n            }\n        };',
       '        const kdNoInjectedText = !_context && this.model.getInjectedTextDecorations(this._editorId).length === 0;\n' +
       '        const context = _context ?? {\n            getLineContent: lineNumber => {\n                return this.model.getLineContent(lineNumber);\n            },\n            getLineInjectedText: lineNumber => {\n                return kdNoInjectedText ? [] : this.model.getLineInjectedText(lineNumber, this._editorId);\n            }\n        };']]],
    // (without wrapping, a line with nothing injected has no line breaks - createLineBreaks answers null for it: its
    // text is not read for that now)
    ['/vs/editor/common/viewModel/monospaceLineBreaksComputer.js', [
      ['                    const injectedText = context.getLineInjectedText(lineNumber);\n                    const lineText = context.getLineContent(lineNumber);\n',
       '                    const injectedText = context.getLineInjectedText(lineNumber);\n' +
       '                    if (wrappingColumn === -1 && !(injectedText && injectedText.length)) {\n                        result[i] = null;\n                        continue;\n                    }\n' +
       '                    const lineText = context.getLineContent(lineNumber);\n']]],
    ['/vs/editor/browser/view.js', [
      ['                const viewportData = ( new ViewportData(\n                    this._selections,\n                    partialViewportData,',
       '                const viewportData = ( new ViewportData(\n                    this._selections,\n                    this.kdRenderedLines(partialViewportData),'],
      ['    _createCoordinatedRendering() {\n',
       '    kdRenderedLines(visible) {\n' +
       '        const viewLayout = this._context.viewLayout;\n' +
       '        const linesLayout = viewLayout._linesLayout;\n' +
       '        if (!linesLayout || typeof linesLayout.getLinesViewportData !== "function") {\n            return visible;\n        }\n' +
       '        const viewport = viewLayout.getCurrentViewport();\n' +
       '        const lineHeight = this._context.configuration.options.get(EditorOption.lineHeight);\n' +
       '        const top = viewport.top, bottom = viewport.top + viewport.height, scrollHeight = viewLayout.getScrollHeight();\n' +
       '        let range = this.kdRange;\n' +
       '        if (!range || range.height !== viewport.height || (top < range.top + 2 * lineHeight && range.top > 0) || (bottom > range.bottom - 2 * lineHeight && range.bottom < scrollHeight)) {\n' +
       '            range = this.kdRange = { top: Math.max(0, top - 10 * lineHeight), bottom: Math.min(scrollHeight, bottom + 10 * lineHeight), height: viewport.height };\n' +
       '        }\n' +
       '        if (range.top >= top && range.bottom <= bottom) {\n            return visible;\n        }\n' +
       '        const data = linesLayout.getLinesViewportData(range.top, range.bottom);\n' +
       '        data.centeredLineNumber = visible.centeredLineNumber;\n' +
       '        data.completelyVisibleStartLineNumber = visible.completelyVisibleStartLineNumber;\n' +
       '        data.completelyVisibleEndLineNumber = visible.completelyVisibleEndLineNumber;\n' +
       '        return data;\n' +
       '    }\n' +
       '    _createCoordinatedRendering() {\n']]],
    // (the lines' layer and the margin's - composited, layer hinting - are moved by their transform instead of top and
    // left: a change of top laid the page out at every frame of a scroll, with the compositor's pass over all of the
    // page's ~300-500 layers; a transform is the compositor's alone)
    ['/vs/editor/browser/viewParts/viewLines/viewLines.js', [
      ['        this._linesContent.setLayerHinting(this._canUseLayerHinting);\n        this._linesContent.setContain("strict");\n' +
       '        const adjustedScrollTop = this._context.viewLayout.getCurrentScrollTop() - viewportData.bigNumbersDelta;\n' +
       '        this._linesContent.setTop(-adjustedScrollTop);\n        this._linesContent.setLeft(-this._context.viewLayout.getCurrentScrollLeft());',
       '        this._linesContent.setLayerHinting(this._canUseLayerHinting);\n        this._linesContent.setContain("strict");\n' +
       '        const adjustedScrollTop = this._context.viewLayout.getCurrentScrollTop() - viewportData.bigNumbersDelta;\n' +
       '        if (this._canUseLayerHinting) {\n' +
       '            this._linesContent.setTop(0);\n            this._linesContent.setLeft(0);\n' +
       '            __kdMoveLayer(this._linesContent, -this._context.viewLayout.getCurrentScrollLeft(), -adjustedScrollTop);\n' +
       '        } else {\n' +
       '            this._linesContent.setTop(-adjustedScrollTop);\n            this._linesContent.setLeft(-this._context.viewLayout.getCurrentScrollLeft());\n' +
       '        }'],
      ['class ViewLines extends ViewPart {',
       'function __kdMoveLayer(node, x, y) {\n' +
       '    const transform = "translate3d(" + x + "px, " + y + "px, 0px)";\n' +
       '    if (node.kdTransform === transform) {\n        return;\n    }\n' +
       '    node.kdTransform = transform;\n' +
       '    node._layerHint = true;\n' +
       '    const style = node.domNode.style;\n' +
       '    if ("webkitTransform" in style) {\n        style.webkitTransform = transform;\n    } else {\n        style.transform = transform;\n    }\n' +
       '}\n' +
       'self.__kdMoveLayer = __kdMoveLayer;\n' +
       'class ViewLines extends ViewPart {']]],
    ['/vs/editor/browser/viewParts/margin/margin.js', [
      ['        const adjustedScrollTop = ctx.scrollTop - ctx.bigNumbersDelta;\n        this._domNode.setTop(-adjustedScrollTop);',
       '        const adjustedScrollTop = ctx.scrollTop - ctx.bigNumbersDelta;\n' +
       '        if (this._canUseLayerHinting && self.__kdMoveLayer) {\n' +
       '            this._domNode.setTop(0);\n            self.__kdMoveLayer(this._domNode, 0, -adjustedScrollTop);\n' +
       '        } else {\n            this._domNode.setTop(-adjustedScrollTop);\n        }']]],
    // (the hidden textarea got the font's line height and then its own - 19px, then 1px - at every render of the
    // editor: a change of its style at every frame of a scroll and every key, a layout of the page each time. The
    // font is applied when it changes. And while the editor scrolls, the textarea stays where it was put at the
    // cursor - its top changed at every frame in which the cursor's line was on the screen, a layout of the page each:
    // it goes to the cursor once the scrolling stops, or at once when the cursor moves.)
    ['/vs/editor/browser/controller/editContext/textArea/textAreaEditContext.js', [
      ['        const tac = this.textAreaCover;\n        applyFontInfo(ta, this._fontInfo);\n',
       '        const tac = this.textAreaCover;\n        if (this.kdFontInfo !== this._fontInfo) {\n            this.kdFontInfo = this._fontInfo;\n            applyFontInfo(ta, this._fontInfo);\n        }\n'],
      ['    onScrollChanged(e) {\n        this._scrollLeft = e.scrollLeft;\n        this._scrollTop = e.scrollTop;\n        return true;\n    }',
       '    onScrollChanged(e) {\n        this._scrollLeft = e.scrollLeft;\n        this._scrollTop = e.scrollTop;\n' +
       '        if (e.scrollTopChanged) {\n            this.kdScrolledAt = Date.now();\n        }\n        return true;\n    }'],
      ['        this._doRender({\n            lastRenderPosition: this._primaryCursorPosition,\n            top: top,\n',
       '        if (this.kdKeepPlace()) {\n            return;\n        }\n' +
       '        this._doRender({\n            lastRenderPosition: this._primaryCursorPosition,\n            top: top,\n'],
      ['    _renderAtTopLeft() {\n',
       '    kdKeepPlace() {\n' +
       '        if (Date.now() - (this.kdScrolledAt || 0) >= 250 || !this._lastRenderPosition || !this._lastRenderPosition.equals(this._primaryCursorPosition)) {\n' +
       '            return false;\n' +
       '        }\n' +
       '        if (!this.kdLate) {\n' +
       '            if (!this.kdLateRegistered) {\n' +
       '                this.kdLateRegistered = true;\n' +
       '                this._register({ dispose: () => {\n                    clearTimeout(this.kdLate);\n                    this.kdLate = 0;\n                } });\n' +
       '            }\n' +
       '            this.kdLate = setTimeout(() => {\n                this.kdLate = 0;\n                this._render();\n            }, 300);\n' +
       '        }\n' +
       '        return true;\n' +
       '    }\n' +
       '    _renderAtTopLeft() {\n']]],
    // (a LinkedList - the gesture targets, a command's handlers, keybindings - is gone through with a plain iterator:
    // its generator was the regenerator runtime's three calls and a try per element. Its own Symbol.iterator is set by
    // assignment: as a computed key of the literal it went through the engine's property helper and core-js's
    // defineProperty - 1,550 times as the Keyboard Shortcuts editor listed the commands, 0.4 s on the iPad 2)
    ['/vs/base/common/linkedList.js', [
      ['    *[Symbol.iterator]() {\n        let node = this._first;\n        while (node !== Node.Undefined) {\n            yield node.element;\n            node = node.next;\n        }\n    }',
       '    [Symbol.iterator]() {\n' +
       '        const list = this;\n' +
       '        let node = Node.Undefined, first = true;\n' +
       '        const iterator = {\n' +
       '            next() {\n' +
       '                if (first) {\n                    first = false;\n                    node = list._first;\n                } else if (node !== Node.Undefined) {\n                    node = node.next;\n                }\n' +
       '                return node === Node.Undefined ? { done: true, value: undefined } : { done: false, value: node.element };\n' +
       '            }\n' +
       '        };\n' +
       '        iterator[Symbol.iterator] = function () {\n            return iterator;\n        };\n' +
       '        return iterator;\n' +
       '    }']]],
    // (a touch whose element left the page - the scroll under the finger recycled its line or row, vsc-prelude.js
    // passes its moves on to the document - still goes to the targets that held it when it began: their contains()
    // no longer finds it, and the scroll stopped half way, its momentum too)
    ['/vs/base/browser/touch.js', [
      ['                rollingPageY: [touch.pageY]\n            };\n            const evt = this.newGestureEvent(EventType.Start, touch.target);\n',
       '                rollingPageY: [touch.pageY],\n                kdTargets: this.kdTargetsOf(touch.target)\n            };\n' +
       '            const evt = this.newGestureEvent(EventType.Start, touch.target);\n            evt.kdTargets = this.activeTouches[touch.identifier].kdTargets;\n'],
      ['                const evt = this.newGestureEvent(EventType.Tap, data.initialTarget);\n',
       '                const evt = this.newGestureEvent(EventType.Tap, data.initialTarget);\n                evt.kdTargets = data.kdTargets;\n'],
      ['                const evt = this.newGestureEvent(EventType.Contextmenu, data.initialTarget);\n',
       '                const evt = this.newGestureEvent(EventType.Contextmenu, data.initialTarget);\n                evt.kdTargets = data.kdTargets;\n'],
      ['                const dispatchTo = [...this.targets].filter(t => data.initialTarget instanceof Node && t.contains(data.initialTarget));\n',
       '                const dispatchTo = data.kdTargets.filter(t => !kdDetached(t));\n'],
      ['            this.dispatchEvent(this.newGestureEvent(EventType.End, data.initialTarget));\n',
       '            const kdEnd = this.newGestureEvent(EventType.End, data.initialTarget);\n            kdEnd.kdTargets = data.kdTargets;\n            this.dispatchEvent(kdEnd);\n'],
      ['            const evt = this.newGestureEvent(EventType.Change, data.initialTarget);\n            evt.translationX = touch.pageX - data.rollingPageX.at(-1);\n',
       '            const evt = this.newGestureEvent(EventType.Change, data.initialTarget);\n            evt.kdTargets = data.kdTargets;\n            evt.translationX = touch.pageX - data.rollingPageX.at(-1);\n'],
      // (and every event of a touch goes to the targets found when it began: each move went through all the gesture
      // targets of the workbench - ~160 lists, editors, scrollable elements - with contains(), the list's iterator a
      // generator; 40 % of the script's time in a list's scroll)
      ['        if (event.initialTarget instanceof Node) {\n            for (const ignoreTarget of this.ignoreTargets) {\n',
       '        if (event.kdTargets) {\n' +
       '            const kdTargets = event.kdTargets;\n' +
       '            for (let i = 0; i < kdTargets.length; i++) {\n                if (!kdDetached(kdTargets[i])) {\n                    kdTargets[i].dispatchEvent(event);\n                    this.dispatched = true;\n                }\n            }\n' +
       '            return;\n' +
       '        }\n' +
       '        if (event.initialTarget instanceof Node) {\n            for (const ignoreTarget of this.ignoreTargets) {\n'],
      ['    inertia(targetWindow, dispatchTo, t1, vX, dirX, x, vY, dirY, y) {\n',
       '    kdTargetsOf(node) {\n' +
       '        const targets = [];\n' +
       '        if (!(node instanceof Node)) {\n            return targets;\n        }\n' +
       '        for (const ignoreTarget of this.ignoreTargets) {\n            if (ignoreTarget.contains(node)) {\n                return targets;\n            }\n        }\n' +
       '        for (const target of this.targets) {\n' +
       '            if (target.contains(node)) {\n' +
       '                let depth = 0;\n                let now = node;\n' +
       '                while (now && now !== target) {\n                    depth++;\n                    now = now.parentElement;\n                }\n' +
       '                targets.push([depth, target]);\n' +
       '            }\n' +
       '        }\n' +
       '        targets.sort((a, b) => a[0] - b[0]);\n' +
       '        return targets.map(t => t[1]);\n' +
       '    }\n' +
       '    inertia(targetWindow, dispatchTo, t1, vX, dirX, x, vY, dirY, y) {\n'],
      ['class Gesture extends Disposable {',
       'function kdDetached(node) {\n' +
       '    return node instanceof Node && !!node.ownerDocument && !node.ownerDocument.documentElement.contains(node);\n' +
       '}\n' +
       'class Gesture extends Disposable {']]],
    // (a list's rows - their container composited, VS Code's transformOptimization - are moved by its transform too:
    // its top laid the page out at every frame of a list's scroll, the explorer's, quick open's, the suggestions')
    ['/vs/base/browser/ui/list/listView.js', [
      ['            this.rowsContainer.style.contain = "strict";\n        }\n',
       '            this.rowsContainer.style.contain = "strict";\n            this.kdMoveRows = true;\n        }\n'],
      ['        if (renderLeft !== undefined) {\n            this.rowsContainer.style.left = `-${renderLeft}px`;\n        }\n        this.rowsContainer.style.top = `-${renderTop}px`;\n',
       '        if (this.kdMoveRows) {\n' +
       '            if (renderLeft !== undefined) {\n                this.kdRenderLeft = renderLeft;\n            }\n' +
       '            const kdTransform = "translate3d(" + -(this.kdRenderLeft || 0) + "px, " + -renderTop + "px, 0px)";\n' +
       '            if (this.kdTransform !== kdTransform) {\n                this.kdTransform = kdTransform;\n                this.rowsContainer.style.transform = kdTransform;\n            }\n' +
       '        } else {\n' +
       '            if (renderLeft !== undefined) {\n                this.rowsContainer.style.left = `-${renderLeft}px`;\n            }\n' +
       '            this.rowsContainer.style.top = `-${renderTop}px`;\n' +
       '        }\n']]],
    // (a scrollbar's slider - composited, layer hinting - is moved by its transform, as the lines: its top laid the
    // page out at every frame of a scroll, in the editor and in every list)
    ['/vs/base/browser/ui/scrollbar/verticalScrollbar.js', [
      ['        this.slider.setHeight(sliderSize);\n        this.slider.setTop(sliderPosition);\n',
       '        this.slider.setHeight(sliderSize);\n' +
       '        if (self.__kdMoveLayer) {\n            this.slider.setTop(0);\n            self.__kdMoveLayer(this.slider, 0, sliderPosition);\n' +
       '        } else {\n            this.slider.setTop(sliderPosition);\n        }\n']]],
    ['/vs/base/browser/ui/scrollbar/horizontalScrollbar.js', [
      ['        this.slider.setWidth(sliderSize);\n        this.slider.setLeft(sliderPosition);\n',
       '        this.slider.setWidth(sliderSize);\n' +
       '        if (self.__kdMoveLayer) {\n            this.slider.setLeft(0);\n            self.__kdMoveLayer(this.slider, sliderPosition, 0);\n' +
       '        } else {\n            this.slider.setLeft(sliderPosition);\n        }\n']]],
    // (a content widget - hover, suggestions, parameter hints - whose line is drawn but off the screen stays hidden, as
    // when only the lines on the screen were drawn)
    ['/vs/editor/browser/viewParts/contentWidgets/contentWidgets.js', [
      ['            const top = ctx.getVerticalOffsetForLineNumber(position.lineNumber) - ctx.scrollTop;\n            const lineHeight = ctx.getLineHeightForLineNumber(position.lineNumber);\n',
       '            const top = ctx.getVerticalOffsetForLineNumber(position.lineNumber) - ctx.scrollTop;\n            const lineHeight = ctx.getLineHeightForLineNumber(position.lineNumber);\n' +
       '            if (top + lineHeight <= 0 || top >= ctx.viewportHeight) {\n                return null;\n            }\n']]],
    ['/vs/editor/browser/viewParts/indentGuides/indentGuides.js', [
      ['        const activeCursorPosition = this._primaryPosition;\n        const indents = this.getGuidesByLine(',
       '        const activeCursorPosition = this._primaryPosition;\n' +
       '        if (this._bracketPairGuideOptions.bracketPairs === false && this._bracketPairGuideOptions.indentation) {\n' +
       '            this.kdPrepareIndentGuides(ctx, visibleStartLineNumber, visibleEndLineNumber, scrollWidth, activeCursorPosition);\n' +
       '            return;\n' +
       '        }\n' +
       '        const indents = this.getGuidesByLine('],
      ['    getGuidesByLine(visibleStartLineNumber, visibleEndLineNumber, activeCursorPosition) {\n',
       // (the guides of indentation alone - no bracket pair guides: the same HTML as below, each line's kept while its
       // indentation, the active guide on it and the scroll width stay; a scroll makes the lines it brings in)
       '    kdPrepareIndentGuides(ctx, start, end, scrollWidth, activeCursorPosition) {\n' +
       '        const viewModel = this._context.viewModel;\n' +
       '        const end2 = Math.min(end + 1, viewModel.getLineCount());\n' +
       '        const levels = viewModel.getLinesIndentGuides(start, end2);\n' +
       '        let activeStart = 0, activeEnd = 0, activeLevel = 0;\n' +
       '        if (this._bracketPairGuideOptions.highlightActiveIndentation !== false && activeCursorPosition) {\n' +
       '            const info = viewModel.getActiveIndentGuide(activeCursorPosition.lineNumber, start, end2);\n' +
       '            activeStart = info.startLineNumber;\n            activeEnd = info.endLineNumber;\n            activeLevel = info.indent;\n' +
       '        }\n' +
       '        const indentSize = viewModel.model.getOptions().indentSize;\n' +
       '        let kd = this.kdLines;\n' +
       '        if (!kd || kd.scrollWidth !== scrollWidth || kd.indentSize !== indentSize || kd.count > 600) {\n' +
       '            kd = this.kdLines = { scrollWidth, indentSize, count: 0, lines: Object.create(null) };\n' +
       '        }\n' +
       '        const output = [];\n' +
       '        for (let lineNumber = start; lineNumber <= end; lineNumber++) {\n' +
       '            const lineIndex = lineNumber - start;\n' +
       '            const level = levels[lineIndex] || 0;\n' +
       '            const active = activeStart <= lineNumber && lineNumber <= activeEnd ? activeLevel : 0;\n' +
       '            const kept = kd.lines[lineNumber];\n' +
       '            if (kept !== undefined && kept.level === level && kept.active === active) {\n                output[lineIndex] = kept.html;\n                continue;\n            }\n' +
       '            let result = "";\n' +
       '            if (level > 0) {\n' +
       '                const leftOffset = ctx.visibleRangeForPosition(( new Position(lineNumber, 1)))?.left ?? 0;\n' +
       '                for (let indentLvl = 1; indentLvl <= level; indentLvl++) {\n' +
       '                    const left = leftOffset + (indentLvl - 1) * indentSize * this._spaceWidth;\n' +
       '                    if (left > scrollWidth || (this._maxIndentLeft > 0 && left > this._maxIndentLeft)) {\n                        break;\n                    }\n' +
       '                    result += `<div class="core-guide core-guide-indent lvl-${(indentLvl - 1) % 30}${indentLvl === active ? " indent-active" : ""} vertical" style="left:${left}px;width:${this._spaceWidth}px"></div>`;\n' +
       '                }\n' +
       '            }\n' +
       '            output[lineIndex] = result;\n' +
       '            kd.lines[lineNumber] = { level, active, html: result };\n' +
       '            kd.count++;\n' +
       '        }\n' +
       '        this._renderResult = output;\n' +
       '    }\n' +
       '    getGuidesByLine(visibleStartLineNumber, visibleEndLineNumber, activeCursorPosition) {\n'],
      ['        this._bracketPairGuideOptions = options.get(EditorOption.guides);\n        return true;\n    }',
       '        this._bracketPairGuideOptions = options.get(EditorOption.guides);\n        this.kdLines = null;\n        return true;\n    }'],
      ['    onFlushed(e) {\n        return true;\n    }\n    onLinesChanged(e) {\n        return true;\n    }\n    onLinesDeleted(e) {\n        return true;\n    }\n    onLinesInserted(e) {\n        return true;\n    }',
       '    onFlushed(e) {\n        this.kdLines = null;\n        return true;\n    }\n    onLinesChanged(e) {\n        this.kdLines = null;\n        return true;\n    }\n' +
       '    onLinesDeleted(e) {\n        this.kdLines = null;\n        return true;\n    }\n    onLinesInserted(e) {\n        this.kdLines = null;\n        return true;\n    }'],
      ['    onZonesChanged(e) {\n        return true;\n    }\n    onLanguageConfigurationChanged(e) {\n        return true;\n    }',
       '    onZonesChanged(e) {\n        this.kdLines = null;\n        return true;\n    }\n    onLanguageConfigurationChanged(e) {\n        this.kdLines = null;\n        return true;\n    }']]]
  ])
}

// The editor lays out every line on the screen at every frame of a scroll - its view lines, its overlays, its margin:
// setTop, setHeight and setLineHeight of each, ~400 calls a frame - and FastDomNode made the value's "Npx" string
// before it found it unchanged (it nearly always is: a line keeps its place in the content while the content moves).
// The value it was given last is kept as well: the same value returns at once (the string is that of the value).
function fasterDomNode() {
  return {
    name: 'kodium-faster-dom-node',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/vs/base/browser/fastDomNode.js')) return null
      let n = 0
      const out = code.replace(/    (set\w+)\((_\w+)\) \{\n        const (\w+) = numberAsPixels\(\2\);\n/g, (all, name, raw, value) => {
        n++
        return '    ' + name + '(' + raw + ') {\n        if (' + raw + ' === this.kdLast_' + value + ') {\n            return;\n        }\n' +
          '        this.kdLast_' + value + ' = ' + raw + ';\n        const ' + value + ' = numberAsPixels(' + raw + ');\n'
      })
      if (n < 10) this.error('kodium-faster-dom-node: fastDomNode.js has another form (' + n + ' setters)')
      return { code: out, map: null }
    }
  }
}

// An editor's overlay widgets, laid out at its first frame and after every change of its size (the panel or the side
// bar shown or hidden, a diff opened: both its editors), measured the page twice in the middle of the frame's writes:
// the editor's place on the page, which only a widget fixed outside the editor needs, and the height of iOS's keyboard
// button (a textarea in each editor's corner, VS Code's iPadShowKeyboard: 36 px by its CSS) - each a layout of the
// whole page then (20-30 ms on the iPad 2). The place is measured when such a widget needs it, the button's height once.
function calmerOverlayWidgets() {
  return patchModules('kodium-calmer-overlay-widgets', [
    ['/vs/editor/browser/viewParts/overlayWidgets/overlayWidgets.js', [
      ['    prepareRender(ctx) {\n        this._viewDomNodeRect = getDomNodePagePosition(this._viewDomNode.domNode);\n    }',
       '    prepareRender(ctx) {\n        this.kdRectStale = true;\n    }'],
      ['                const editorBoundingBox = this._viewDomNodeRect;\n',
       '                if (this.kdRectStale) {\n                    this._viewDomNodeRect = getDomNodePagePosition(this._viewDomNode.domNode);\n                    this.kdRectStale = false;\n                }\n' +
       '                const editorBoundingBox = this._viewDomNodeRect;\n'],
      ['                const widgetHeight = domNode.domNode.clientHeight;\n',
       '                const kdKeyboard = widgetData.widget.getId() === "editor.contrib.ShowKeyboardWidget";\n' +
       '                const widgetHeight = kdKeyboard && kdKeyboardHeight || domNode.domNode.clientHeight;\n' +
       '                if (kdKeyboard && widgetHeight > 0) {\n                    kdKeyboardHeight = widgetHeight;\n                }\n']],
     'let kdKeyboardHeight = 0;\n']
  ])
}

// What the workbench lets go of when the iPad runs short of memory (web/src/memory.ts, asked by src/KDAppDelegate.m):
// an editor group keeps the pane of every kind of editor it has shown (EditorPanes) - kdDropHiddenPanes(keep) disposes
// those not on the screen whose id keep() does not want (kdPreparePane(typeId) makes one ahead, for the warm-up);
// the language services' workers (JSON, CSS, HTML) are listed
// for it (self.__kdWorkerManagers), to be stopped before their 45 s without a request (quickerWorkers) are up:
// settings.json's JSON worker, with the schema of every setting, took 17 MB of the iPad 2's memory.
function memoryRelief() {
  const workerManager = (lang) => ['/languages/features/' + lang + '/workerManager.js', [
    ['    this._defaults = defaults;\n', '    this._defaults = defaults;\n    (self.__kdWorkerManagers || (self.__kdWorkerManagers = [])).push(this);\n']]]
  return patchModules('kodium-memory-relief', [
    ['/vs/workbench/browser/parts/editor/editorPanes.js', [
      ['    closeEditor(editor) {\n',
       '    kdDropHiddenPanes(keep) {\n' +
       '        const dropped = this.editorPanes.filter(pane => pane !== this._activeEditorPane && !keep(pane.getId()));\n' +
       '        if (!dropped.length) {\n            return 0;\n        }\n' +
       '        this.editorPanes = this.editorPanes.filter(pane => !dropped.includes(pane));\n' +
       '        for (const pane of dropped) {\n' +
       '            this.mapEditorPaneToPendingSetInput.delete(pane);\n' +
       '            try {\n                pane.getContainer()?.remove();\n                this._store.delete(pane);\n            } catch (error) {\n                this.logService.error(error);\n            }\n' +
       '        }\n' +
       '        return dropped.length;\n' +
       '    }\n' +
       // (and the warm-up's: a kind of editor pane made before anything is shown in it, its editor's contributions
       // all made too - web/src/warmup.ts, for the text file editor every file is shown in)
       '    kdPreparePane(typeId) {\n' +
       '        if (this.editorPanes.some(pane => pane.getId() === typeId)) {\n            return false;\n        }\n' +
       '        const descriptor = this.editorPanesRegistry.getEditorPaneByType(typeId);\n' +
       '        if (!descriptor) {\n            return false;\n        }\n' +
       '        const editorPane = this.doInstantiateEditorPane(descriptor);\n' +
       '        if (!editorPane.getContainer()) {\n' +
       '            const editorPaneContainer = $(".editor-instance");\n' +
       '            this.editorPanesParent.appendChild(editorPaneContainer);\n' +
       '            try {\n                editorPane.create(editorPaneContainer);\n            } finally {\n' +
       '                editorPaneContainer.remove();\n                hide(editorPaneContainer);\n            }\n' +
       '        }\n' +
       '        const contributions = editorPane.getControl?.()?._contributions;\n' +
       '        if (typeof contributions?._instantiateSome === "function") {\n' +
       '            for (const phase of [1, 2, 3]) {\n                contributions._instantiateSome(phase);\n            }\n' +
       '        }\n' +
       '        return true;\n' +
       '    }\n' +
       '    closeEditor(editor) {\n']]],
    workerManager('json'), workerManager('css'), workerManager('html')
  ])
}

// Keyboard Shortcuts' table and the Settings editor's tree are scrolled by their rows' transform as the other lists are
// (listView.js kdMoveRows, smootherScroll): VS Code leaves both without the lists' transform optimization - a row's
// "when" editor put its suggestions out of place, in Chromium - and the rows' top laid the page out at every frame of
// a finger's scroll: ~110-130 ms a frame on the iPad 2. (The "when" editor's suggestions go into a container of their
// own beside the table, not into its rows.)
//
// And the big scrolling lists - the Explorer, the Search view's results, the Problems, the Outline, the Timeline,
// Keyboard Shortcuts - draw rows ahead, as the editor draws lines ahead (smootherScroll): a frame of a finger's scroll
// cost ~15 ms when it only moved the rows and ~50 ms when a row came onto the screen (the Explorer on the iPad 2: the
// old WebKit's style, layout, layers and the ResizeObserver polyfill's measuring for any change of the rows, the row
// itself ~2-5 ms), which at a finger's pace was nearly every frame. The rows drawn are those of a stretch up to 88 px
// longer above and 176 px below the screen that moves by 88 px at a time, so rows change every few frames, four at a
// time. (Not the lists made again at every key - the command palette's, the suggestions' - nor those whose rows have
// heights of their own to measure.)
const KD_OVERSCAN_USERS = ['FileExplorer', 'SearchView', 'MarkersView', 'OutlinePane', 'TimelinePane', 'KeybindingsEditor']
function smootherLists() {
  return patchModules('kodium-smoother-lists', [
    ['/vs/base/browser/ui/list/listWidget.js', [
      ['        const viewOptions = {\n            ..._options,\n            dnd: _options.dnd && ( new ListViewDragAndDrop(this, _options.dnd))\n        };\n',
       '        const viewOptions = {\n            ..._options,\n            dnd: _options.dnd && ( new ListViewDragAndDrop(this, _options.dnd)),\n            kdUser: user\n        };\n']]],
    ['/vs/base/browser/ui/list/listView.js', [
      ['        this.supportDynamicHeights = options.supportDynamicHeights ?? DefaultOptions.supportDynamicHeights;\n',
       '        this.supportDynamicHeights = options.supportDynamicHeights ?? DefaultOptions.supportDynamicHeights;\n' +
       '        this.kdOverscan = !this.supportDynamicHeights && ' + JSON.stringify(KD_OVERSCAN_USERS) + '.indexOf(options.kdUser) !== -1 ? 88 : 0;\n'],
      ['    get lastVisibleIndex() {\n        const range = this.getRenderRange(this.lastRenderTop, this.lastRenderHeight);\n',
       '    get lastVisibleIndex() {\n        const range = this.kdOverscan ? this.getVisibleRange(this.lastRenderTop, this.lastRenderHeight) : this.getRenderRange(this.lastRenderTop, this.lastRenderHeight);\n'],
      ['    getRenderRange(renderTop, renderHeight) {\n        const range = this.getVisibleRange(renderTop, renderHeight);\n',
       '    kdOverscanRange(renderTop, renderHeight) {\n' +
       '        const step = this.kdOverscan;\n' +
       '        const base = Math.floor(Math.max(0, renderTop) / step) * step;\n' +
       '        const top = Math.max(0, base - step);\n' +
       '        return this.getVisibleRange(top, base + renderHeight + 2 * step - top);\n' +
       '    }\n' +
       '    getRenderRange(renderTop, renderHeight) {\n' +
       '        const range = this.kdOverscan && renderHeight > 0 ? this.kdOverscanRange(renderTop, renderHeight) : this.getVisibleRange(renderTop, renderHeight);\n']]],
    ['/vs/workbench/contrib/preferences/browser/keybindingsEditor.js', [
      ['                openOnSingleClick: false,\n                transformOptimization: false\n',
       '                openOnSingleClick: false,\n                transformOptimization: true\n']]],
    ['/vs/workbench/contrib/preferences/browser/settingsTree.js', [
      ['            renderIndentGuides: RenderIndentGuides.None,\n            transformOptimization: false\n',
       '            renderIndentGuides: RenderIndentGuides.None,\n            transformOptimization: true\n']]],
    // (- and a file's decorations - the Explorer's, asked for each row drawn, given asynchronously and none for almost
    // every file - told no change when an answer of none came for a question still open: nothing had been shown for it.
    // Each such answer had every file label in the workbench ask whether it was affected, and the folders' labels
    // gather their children's decorations again - every file below them - through generators: ~25 ms each, at almost
    // every frame of a scroll through the Explorer)
    ['/vs/workbench/services/decorations/browser/decorationsService.js', [
      ['        const old = map.get(provider);\n        map.set(provider, deco);\n        if (deco || old) {\n',
       '        const old = map.get(provider);\n        map.set(provider, deco);\n        if (deco || (old && !(old instanceof DecorationDataRequest))) {\n']]]
  ])
}

// A row of a tree drawn for another file (the Explorer's as a finger scrolls, four rows every few frames): its label's
// hover - five listeners and their disposables - is given the new file's tooltip, not made again.
function quickerRows() {
  return patchModules('kodium-quicker-rows', [
    ['/vs/base/browser/ui/iconLabel/iconLabel.js', [
      ['    setupHover(htmlElement, tooltip) {\n        const previousCustomHover = this.customHovers.get(htmlElement);\n',
       '    setupHover(htmlElement, tooltip) {\n        const previousCustomHover = this.customHovers.get(htmlElement);\n' +
       '        if (previousCustomHover && tooltip && typeof previousCustomHover.update === "function") {\n' +
       '            void previousCustomHover.update(tooltip);\n' +
       '            return;\n' +
       '        }\n']]]
  ])
}

// A build for measuring the editor's renders (KODIUM_RENDER_TIMERS=1 .\web\build.ps1): each render's phases, and each
// view part's prepareRender and render by its element's class, in ms - an entry a render pushed to self.__kdRenderLog
// when a measuring script has set it to an array.
function renderTimers() {
  if (!process.env.KODIUM_RENDER_TIMERS) return null
  return patchModules('kodium-render-timers', [
    ['/vs/editor/browser/view.js', [
      ['    _createCoordinatedRendering() {\n        return {\n',
       '    _createCoordinatedRendering() {\n        return kdTimeRendering({\n'],
      ['                for (const viewPart of viewPartsToRender) {\n                    viewPart.prepareRender(ctx);\n                }\n',
       '                for (const viewPart of viewPartsToRender) {\n                    const kdT = Date.now();\n                    viewPart.prepareRender(ctx);\n                    kdPartTime("p:", viewPart, Date.now() - kdT);\n                }\n'],
      ['                for (const viewPart of viewPartsToRender) {\n                    viewPart.render(ctx);\n                    viewPart.onDidRender();\n                }\n            }\n        };\n    }\n',
       '                for (const viewPart of viewPartsToRender) {\n                    const kdT = Date.now();\n                    viewPart.render(ctx);\n                    viewPart.onDidRender();\n                    kdPartTime("r:", viewPart, Date.now() - kdT);\n                }\n            }\n        });\n    }\n']],
     'function kdTimeRendering(r) {\n' +
     '    const wrap = (name, fn) => function () {\n' +
     '        const log = self.__kdRenderLog;\n' +
     '        if (!Array.isArray(log)) {\n            return fn.apply(this, arguments);\n        }\n' +
     '        const t = Date.now();\n' +
     '        const result = fn.apply(this, arguments);\n' +
     '        if (name === "prepareRenderText" || !log.kdCurrent) {\n            log.kdCurrent = { at: t };\n            log.push(log.kdCurrent);\n        }\n' +
     '        log.kdCurrent[name] = (log.kdCurrent[name] || 0) + Date.now() - t;\n' +
     '        return result;\n' +
     '    };\n' +
     '    return { prepareRenderText: wrap("prepareRenderText", r.prepareRenderText), renderText: wrap("renderText", r.renderText), prepareRender: wrap("prepareRender", r.prepareRender), render: wrap("render", r.render) };\n' +
     '}\n' +
     'function kdPartTime(kind, part, ms) {\n' +
     '    const log = self.__kdRenderLog;\n' +
     '    if (!Array.isArray(log) || !log.kdCurrent) {\n        return;\n    }\n' +
     '    if (!part.kdLabel) {\n' +
     '        const node = (part.domNode && part.domNode.domNode) || (part._domNode && part._domNode.domNode) || part._domNode || part.domNode;\n' +
     '        const cls = node && typeof node.className === "string" ? node.className.split(" ")[0] : "";\n' +
     '        part.kdLabel = cls || "part";\n' +
     '    }\n' +
     '    const key = kind + part.kdLabel;\n' +
     '    log.kdCurrent[key] = (log.kdCurrent[key] || 0) + ms;\n' +
     '}\n']
  ])
}

// A build for measuring which listeners of VS Code's events take the time (KODIUM_LISTENER_TIMERS=1 .\web\build.ps1):
// every listener's call of 3 ms or more reported to self.__kdTask("listener", the listener, ms), when a measuring script
// has set it - nested ones too, and a listener given with its `this` as itself (not as the bound function)
function listenerTimers() {
  if (!process.env.KODIUM_LISTENER_TIMERS) return null
  return patchModules('kodium-listener-timers', [
    ['/vs/base/common/event.js', [
      ['            if (thisArgs) {\n                callback = callback.bind(thisArgs);\n            }\n            const contained = ( new UniqueContainer(callback));\n',
       '            const kdFn = callback;\n            if (thisArgs) {\n                callback = callback.bind(thisArgs);\n            }\n            const contained = ( new UniqueContainer(callback));\n            contained.kdFn = kdFn;\n'],
      ['        try {\n            listener.value(value);\n        } catch (e) {\n            errorHandler(e);\n        }\n',
       '        const kdT = self.__kdTask ? Date.now() : 0;\n        try {\n            listener.value(value);\n        } catch (e) {\n            errorHandler(e);\n        }\n' +
       '        if (kdT) {\n            const kdMs = Date.now() - kdT;\n            if (kdMs >= 3 && self.__kdTask) {\n                self.__kdTask("listener", listener.kdFn || listener.value, kdMs);\n            }\n        }\n']]],
  ])
}

// A build for measuring the opening of a file (KODIUM_OPEN_TIMERS=1 .\web\build.ps1): self.__kdMark(name) along the
// way from the editor service to the editor's model and view, when a measuring script has set it.
function openTimers() {
  if (!process.env.KODIUM_OPEN_TIMERS) return null
  const m = (n) => 'self.__kdMark && self.__kdMark("' + n + '");\n'
  return patchModules('kodium-open-timers', [
    ['/vs/workbench/services/editor/browser/editorService.js', [
      ['    async openEditor(editor, optionsOrPreferredGroup, preferredGroup) {\n        let typedEditor = undefined;\n',
       '    async openEditor(editor, optionsOrPreferredGroup, preferredGroup) {\n        ' + m('editorService.openEditor') + '        let typedEditor = undefined;\n'],
      ['            typedEditor = isEditorInput(editor) ? editor : await this.textEditorService.resolveTextEditor(editor);\n',
       '            typedEditor = isEditorInput(editor) ? editor : await this.textEditorService.resolveTextEditor(editor);\n            ' + m('input made')]]],
    ['/vs/workbench/browser/parts/editor/editorGroupView.js', [
      ['    async doOpenEditor(editor, options, internalOptions) {\n', '    async doOpenEditor(editor, options, internalOptions) {\n        ' + m('group.doOpenEditor')],
      ['        const showEditorResult = this.doShowEditor(openedEditor, {', '        ' + m('group model opened') + '        const showEditorResult = this.doShowEditor(openedEditor, {'],
      ['        if (!internalOptions?.skipTitleUpdate) {\n            this.titleControl.openEditor(editor, internalOptions);',
       '        ' + m('pane opening started') + '        if (!internalOptions?.skipTitleUpdate) {\n            this.titleControl.openEditor(editor, internalOptions);\n            ' + m('title control')],
      ['                if (changed) {\n                    this._onDidActiveEditorChange.fire({',
       '                ' + m('pane opened') + '                if (changed) {\n                    this._onDidActiveEditorChange.fire({'],
      ['                if (error) {\n                    this._onDidOpenEditorFail.fire(editor);', '                ' + m('active editor change fired') + '                if (error) {\n                    this._onDidOpenEditorFail.fire(editor);']]],
    ['/vs/workbench/contrib/files/browser/editors/textFileEditor.js', [
      ['        mark("code/willSetInputToTextFileEditor");\n        await super.setInput(input, options, context, token);\n',
       '        ' + m('textFileEditor.setInput') + '        mark("code/willSetInputToTextFileEditor");\n        await super.setInput(input, options, context, token);\n        ' + m('super.setInput')],
      ['            const resolvedModel = await input.resolve(options);\n', '            const resolvedModel = await input.resolve(options);\n            ' + m('model resolved')],
      ['            control.setModel(textFileModel.textEditorModel);\n', '            control.setModel(textFileModel.textEditorModel);\n            ' + m('setModel done')],
      ['            control.updateOptions(this.getReadonlyConfiguration(textFileModel.isReadonly()));\n',
       '            ' + m('view state restored') + '            control.updateOptions(this.getReadonlyConfiguration(textFileModel.isReadonly()));\n            ' + m('readonly options')],
      ['        mark("code/didSetInputToTextFileEditor");\n', '        ' + m('setInput done') + '        mark("code/didSetInputToTextFileEditor");\n']]],
    // (an editor pane: its input set)
    ['/vs/workbench/browser/parts/editor/editorPanes.js', [
      ['        } = await this.doSetInput(pane, editor, options, context);\n',
       '        } = await this.doSetInput(pane, editor, options, context);\n        ' + m('panes: input set')]]],
    // (the command palette: all the commands' picks, sorted, made; the picker given them)
    ['/vs/platform/quickinput/browser/commandsQuickAccess.js', [
      ['        const allCommandPicks = await this.getCommandPicks(token);\n',
       '        ' + m('cmd: getPicks') + '        const allCommandPicks = await this.getCommandPicks(token);\n        ' + m('cmd: all picks')],
      ['        const commandPicks = [];\n        let addOtherSeparator = false;\n',
       '        ' + m('cmd: sorted') + '        const commandPicks = [];\n        let addOtherSeparator = false;\n'],
      ['        if (!this.hasAdditionalCommandPicks(filter, token)) {\n            return commandPicks;\n        }\n',
       '        ' + m('cmd: picks made') + '        if (!this.hasAdditionalCommandPicks(filter, token)) {\n            return commandPicks;\n        }\n']]],
    ['/vs/platform/quickinput/browser/quickInputController.js', [
      ['        ui.container.style.display = "";\n        this.updateLayout();\n',
       '        ui.container.style.display = "";\n        ' + m('qi: layout') + '        this.updateLayout();\n        ' + m('qi: laid out')],
      ['        this.onShowEmitter.fire();\n        ui.inputBox.setFocus();\n',
       '        ' + m('qi: onShow') + '        this.onShowEmitter.fire();\n        ' + m('qi: focus') + '        ui.inputBox.setFocus();\n        ' + m('qi: focused')]]],
    ['/vs/platform/quickinput/browser/quickInput.js', [
      ['        this.ui.show(this);\n        this._visible.set(true, undefined);\n',
       '        ' + m('qi: ui.show') + '        this.ui.show(this);\n        ' + m('qi: ui shown') + '        this._visible.set(true, undefined);\n'],
      ['        if (this.buttons.length) {\n            this.buttonsUpdated = true;\n        }\n        this.update();\n    }\n',
       '        if (this.buttons.length) {\n            this.buttonsUpdated = true;\n        }\n        ' + m('qi: update') + '        this.update();\n        ' + m('qi: updated') + '    }\n']]],
    ['/vs/platform/quickinput/browser/quickAccess.js', [
      ['        picker.show();\n        if (visibleSelection && visibleValue === value) {\n',
       '        ' + m('qa: show') + '        picker.show();\n        ' + m('qa: shown') + '        if (visibleSelection && visibleValue === value) {\n']]],
    ['/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.js', [
      ['        return globalCommandPicks;\n    }\n', '        ' + m('cmd: global picks') + '        return globalCommandPicks;\n    }\n']]],
    ['/vs/platform/quickinput/browser/pickerQuickAccess.js', [
      ['                picker.items = items;\n                if (activeItem) {\n                    picker.activeItems = [activeItem];\n                }\n                return true;\n',
       '                ' + m('pick: will set items') + '                picker.items = items;\n                ' + m('pick: items set') + '                if (activeItem) {\n                    picker.activeItems = [activeItem];\n                }\n                return true;\n']]],
    // (Go to Symbol: the symbols there, the picks made, the picker updated with them)
    ['/vs/editor/contrib/quickAccess/browser/gotoSymbolQuickAccess.js', [
      ['        const symbolsPromise = this.getDocumentSymbols(model, token);\n',
       '        ' + m('sym: provide') + '        const symbolsPromise = this.getDocumentSymbols(model, token);\n        symbolsPromise.then(() => { ' + m('sym: symbols').trim() + ' });\n'],
      ['                const items = await this.doGetSymbolPicks(symbolsPromise, query, undefined, picksCts.value.token, model);\n',
       '                const items = await this.doGetSymbolPicks(symbolsPromise, query, undefined, picksCts.value.token, model);\n                ' + m('sym: picks made')],
      ['                    picker.kdBatch(() => {\n', '                    ' + m('sym: batch') + '                    picker.kdBatch(() => {\n'],
      ['                } else if (items.length > 0) {\n                    picker.items = items;\n',
       '                    ' + m('sym: picker updated') + '                } else if (items.length > 0) {\n                    picker.items = items;\n']]],
    // (views made active or inactive by a change of context keys, and the title areas of composites updated)
    ['/vs/workbench/services/views/common/viewContainerModel.js', [
      ['        if (addedActiveItems.length || removedActiveItems.length) {\n            this._onDidChangeActiveViewDescriptors.fire(({\n',
       '        if (addedActiveItems.length || removedActiveItems.length) {\n' +
       '            self.__kdMark && self.__kdMark("views of " + this.viewContainer.id + ": +" + addedActiveItems.map(a => a.item.viewDescriptor.id).join(",") + " -" + removedActiveItems.map(r => r.viewDescriptor.id).join(","));\n' +
       '            this._onDidChangeActiveViewDescriptors.fire(({\n']]],
    ['/vs/workbench/browser/parts/compositePart.js', [
      ['    onTitleAreaUpdate(compositeId) {\n        const composite = this.instantiatedCompositeItems.get(compositeId);\n',
       '    onTitleAreaUpdate(compositeId) {\n        self.__kdMark && self.__kdMark("title area of " + compositeId + (this.activeComposite?.getId() === compositeId ? " (active)" : ""));\n' +
       '        const composite = this.instantiatedCompositeItems.get(compositeId);\n']]],
    // (a new editor group: its view made, put into the grid, announced)
    ['/vs/workbench/browser/parts/editor/editorPart.js', [
      ['            newGroupView = this.doCreateGroupView(groupToCopy);\n            this.gridWidget.addView(\n',
       '            ' + m('addGroup') + '            newGroupView = this.doCreateGroupView(groupToCopy);\n            ' + m('group view made') + '            this.gridWidget.addView(\n'],
      ['            this.updateContainer();\n            this._onDidAddGroup.fire(newGroupView);\n            this.notifyGroupIndexChange();\n',
       '            ' + m('grid view added') + '            this.updateContainer();\n            this._onDidAddGroup.fire(newGroupView);\n            ' + m('onDidAddGroup fired') + '            this.notifyGroupIndexChange();\n            ' + m('group index notified')]]],
    // (the diff editor's: its widget made, its input's models, the diff, the models set)
    ['/vs/workbench/browser/parts/editor/textDiffEditor.js', [
      ['        this.diffEditorControl = this._register(\n            this.instantiationService.createInstance(DiffEditorWidget, parent, configuration, {})\n        );\n',
       '        ' + m('diff widget: will make') + '        this.diffEditorControl = this._register(\n            this.instantiationService.createInstance(DiffEditorWidget, parent, configuration, {})\n        );\n        ' + m('diff widget made')],
      ['    async setInput(input, options, context, token) {\n        if (this._previousViewModel) {\n',
       '    async setInput(input, options, context, token) {\n        ' + m('diff.setInput') + '        if (this._previousViewModel) {\n'],
      ['        await super.setInput(input, options, context, token);\n        try {\n            const resolvedModel = await input.resolve();\n',
       '        await super.setInput(input, options, context, token);\n        ' + m('diff super.setInput') + '        try {\n            const resolvedModel = await input.resolve();\n            ' + m('diff models resolved')],
      ['            this._previousViewModel = vm;\n            await vm?.waitForDiff();\n            control.setModel(vm);\n',
       '            this._previousViewModel = vm;\n            ' + m('diff view model made') + '            await vm?.waitForDiff();\n            ' + m('diff computed') + '            control.setModel(vm);\n            ' + m('diff setModel done')],
      ['            control.handleInitialized();\n', '            ' + m('diff options set') + '            control.handleInitialized();\n            ' + m('diff initialized')]]],
    ['/vs/workbench/services/textfile/common/textFileEditorModel.js', [
      ['        mark("code/willResolveTextFileEditorModel");\n', '        mark("code/willResolveTextFileEditorModel");\n        ' + m('model.resolve')],
      ['            const resolvedFromBackup = await this.resolveFromBackup(options);\n', '            const resolvedFromBackup = await this.resolveFromBackup(options);\n            ' + m('backup looked for')],
      ['            this.setOrphaned(false);\n            if (currentVersionId !== this.versionId) {', '            ' + m('read') + '            this.setOrphaned(false);\n            if (currentVersionId !== this.versionId) {'],
      ['        const textModel = this.createTextEditorModel(value, resource, this.preferredLanguageId);\n        this.installModelListeners(textModel);\n        this.autoDetectLanguage();\n',
       '        ' + m('createTextEditorModel') + '        const textModel = this.createTextEditorModel(value, resource, this.preferredLanguageId);\n        ' + m('text model made') + '        this.installModelListeners(textModel);\n        this.autoDetectLanguage();\n        ' + m('language detected')],
      ['        this.setDirty(!!dirty);\n        this._onDidResolve.fire(options?.reason ?? TextFileResolveReason.OTHER);\n',
       '        this.setDirty(!!dirty);\n        ' + m('will fire onDidResolve') + '        this._onDidResolve.fire(options?.reason ?? TextFileResolveReason.OTHER);\n        ' + m('onDidResolve fired')]]],
    ['/vs/editor/browser/widget/codeEditor/codeEditorWidget.js', [
      ['            const detachedModel = this._detachModel();\n            this._attachModel(model);\n',
       '            ' + m('setModel: will detach') + '            const detachedModel = this._detachModel();\n            ' + m('detached') + '            this._attachModel(model);\n            ' + m('attached (view made)')],
      ['            this._onDidChangeModel.fire(e);\n            this._postDetachModelCleanup(detachedModel);\n',
       '            ' + m('will fire onDidChangeModel') + '            this._onDidChangeModel.fire(e);\n            ' + m('onDidChangeModel fired') + '            this._postDetachModelCleanup(detachedModel);\n'],
      ['            this._contributionsDisposable = this._contributions.onAfterModelAttached();\n',
       '            this._contributionsDisposable = this._contributions.onAfterModelAttached();\n            ' + m('contributions after attach')],
      // (which code editors are made, and where)
      ['        this._contributions.initialize(this, contributions, this._instantiationService);\n',
       '        this._contributions.initialize(this, contributions, this._instantiationService);\n' +
       '        self.__kdMark && self.__kdMark("code editor #" + this._id + " made in " + String(domElement.className || "").slice(0, 40) + " < " + String(domElement.parentNode && domElement.parentNode.className || "").slice(0, 40) + (codeEditorWidgetOptions.isSimpleWidget ? " (simple)" : "") + " | " + String(new Error().stack || "").split("\\n").slice(1, 9).join(" | "));\n']]],
    ['/vs/workbench/services/textfile/browser/textFileService.js', [
      ['            bufferStream = await this.fileService.readFileStream(resource, options, cts.token);\n',
       '            bufferStream = await this.fileService.readFileStream(resource, options, cts.token);\n            ' + m('stream (stat) ready')],
      ['            const decoder = await this.doGetDecodedStream(resource, bufferStream.value, options);\n',
       '            const decoder = await this.doGetDecodedStream(resource, bufferStream.value, options);\n            ' + m('decoder ready')],
      ['            value: await createTextBufferFactoryFromStream(decoder.stream)\n',
       '            value: await createTextBufferFactoryFromStream(decoder.stream).then(kdV => { self.__kdMark && self.__kdMark("text buffer made"); return kdV; })\n']]],
    ['/vs/platform/files/common/fileService.js', [
      ['    async validateReadFile(resource, options) {\n        const stat = await this.resolve(resource, {\n            resolveMetadata: true\n        });\n',
       '    async validateReadFile(resource, options) {\n        const stat = await this.resolve(resource, {\n            resolveMetadata: true\n        });\n        ' + m('stat resolved')]]],
    // (a file's background tokenization done)
    ['/vs/editor/common/model/tokens/tokenizerSyntaxTokenBackend.js', [
      ['                    const newState = BackgroundTokenizationState.Completed;\n',
       '                    self.__kdMark && self.__kdMark("tokenized");\n                    const newState = BackgroundTokenizationState.Completed;\n']]],
    // every context key set: self.__kdCtx(key, changed, ms of its change event's listeners, listeners)
    ['/vs/platform/contextkey/browser/contextKeyService.js', [
      ['        if (myContext.setValue(key, value)) {\n            this._onDidChangeContext.fire(( new SimpleContextKeyChangeEvent(key)));\n        }',
       '        const kdT = self.__kdCtx ? Date.now() : 0;\n' +
       '        if (myContext.setValue(key, value)) {\n            this._onDidChangeContext.fire(( new SimpleContextKeyChangeEvent(key)));\n' +
       '            kdT && self.__kdCtx(key, true, Date.now() - kdT, this._onDidChangeContext._size);\n' +
       '        } else if (kdT) self.__kdCtx(key, false, 0, 0);']]],
    // what the timers and animation frames of VS Code's own schedulers ran: self.__kdTask(kind, runner, ms)
    ['/vs/base/common/async.js', [
      ['    onTimeout() {\n        this.timeoutToken = undefined;\n        if (this.runner) {\n            this.doRun();\n        }\n    }',
       '    onTimeout() {\n        this.timeoutToken = undefined;\n        if (this.runner) {\n            const kdT = Date.now();\n            this.doRun();\n            self.__kdTask && self.__kdTask("scheduler", this.runner, Date.now() - kdT);\n        }\n    }']]],
    ['/vs/base/browser/dom.js', [
      ['        try {\n            this._runner();\n        } catch (e) {',
       '        try {\n            const kdT = Date.now();\n            this._runner();\n            self.__kdTask && self.__kdTask("frame item", this._runner, Date.now() - kdT);\n        } catch (e) {']]],
    // the editor's view parts, each timed: self.__kdPart(name, "events" | "prepare" | "render" | "renderText", ms) -
    // their handling of the view model's events (a key's synchronous part), and the frame's rendering; the outgoing
    // events (the editor's own listeners: contributions) as "outgoing <kind>". A part is named by its DOM node's class
    // or by its first own fields (self.__kdPartName).
    ['/vs/editor/browser/view.js', [
      ['            prepareRender: (viewPartsToRender, ctx) => {\n                for (const viewPart of viewPartsToRender) {\n                    viewPart.prepareRender(ctx);\n                }\n            },\n' +
       '            render: (viewPartsToRender, ctx) => {\n                for (const viewPart of viewPartsToRender) {\n                    viewPart.render(ctx);\n                    viewPart.onDidRender();\n                }\n            }',
       '            prepareRender: (viewPartsToRender, ctx) => {\n                for (const viewPart of viewPartsToRender) {\n                    const kdT = Date.now();\n                    viewPart.prepareRender(ctx);\n' +
       '                    self.__kdPart && self.__kdPart(self.__kdPartName(viewPart), "prepare", Date.now() - kdT);\n                }\n            },\n' +
       '            render: (viewPartsToRender, ctx) => {\n                for (const viewPart of viewPartsToRender) {\n                    const kdT = Date.now();\n                    viewPart.render(ctx);\n                    viewPart.onDidRender();\n' +
       '                    self.__kdPart && self.__kdPart(self.__kdPartName(viewPart), "render", Date.now() - kdT);\n                }\n            }'],
      ['                if (this._viewLines.shouldRender()) {\n                    this._viewLines.renderText(viewportData);\n                    this._viewLines.onDidRender();\n                }\n',
       '                if (this._viewLines.shouldRender()) {\n                    const kdT = Date.now();\n                    this._viewLines.renderText(viewportData);\n                    this._viewLines.onDidRender();\n' +
       '                    self.__kdPart && self.__kdPart("view-lines", "renderText", Date.now() - kdT);\n                }\n']],
     'self.__kdPartName = function (part) {\n' +
     '    if (part.kdName) return part.kdName;\n' +
     '    let name = "";\n' +
     '    const nodes = [part._domNode, part.domNode, part._linesContent];\n' +
     '    for (const n of nodes) {\n        const el = n && (n.domNode || n);\n        if (el && typeof el.className === "string" && el.className) { name = el.className.split(" ")[0]; break; }\n    }\n' +
     '    if (!name) name = Object.keys(part).filter(k => k !== "_context" && k !== "_store" && k !== "_isDisposed" && k !== "_shouldRender").slice(0, 2).join(",") || "part";\n' +
     '    part.kdName = name;\n' +
     '    return name;\n' +
     '};\n'],
    ['/vs/editor/common/viewModelEventDispatcher.js', [
      ['            for (const eventHandler of eventHandlers) {\n                eventHandler.handleEvents(events);\n            }\n',
       '            for (const eventHandler of eventHandlers) {\n                const kdT = Date.now();\n                eventHandler.handleEvents(events);\n' +
       '                self.__kdPart && self.__kdPart(self.__kdPartName ? self.__kdPartName(eventHandler) : "?", "events", Date.now() - kdT);\n            }\n'],
      ['            this._onEvent.fire(event);\n',
       '            const kdT = Date.now();\n            this._onEvent.fire(event);\n            self.__kdPart && self.__kdPart("outgoing " + event.kind, "events", Date.now() - kdT);\n']]]
  ])
}

// A build for measuring keys typed while the suggestions are open (KODIUM_SUGGEST_TIMERS=1 .\web\build.ps1):
// self.__kdAdd(name, ms) around the refilter, the widget's steps and each row's render, when a script has set it.
function suggestTimers() {
  if (!process.env.KODIUM_SUGGEST_TIMERS) return null
  const t = (name, code) => 'const kdT_' + name.replace(/\W/g, '') + ' = Date.now();\n' + code +
    'self.__kdAdd && self.__kdAdd("' + name + '", Date.now() - kdT_' + name.replace(/\W/g, '') + ');\n'
  return patchModules('kodium-suggest-timers', [
    ['/vs/editor/contrib/suggest/browser/suggestModel.js', [
      ['            if (!editorIsComposing && this._triggerState !== undefined) {\n                this._refilterCompletionItems();\n',
       '            if (!editorIsComposing && this._triggerState !== undefined) {\n' + t('refilter', '                this._refilterCompletionItems();\n')],
      // (and the way to the first list: self.__kdMark at the trigger, when the providers answered - with their times)
      ['    trigger(options) {\n', '    trigger(options) {\n        self.__kdMark && self.__kdMark("suggest trigger");\n'],
      ['        Promise.all([completions, wordDistance]).then(async ([completions, wordDistance]) => {\n',
       '        Promise.all([completions, wordDistance]).then(async ([completions, wordDistance]) => {\n' +
       '            self.__kdMark && self.__kdMark("suggest answers " + JSON.stringify(completions.durations));\n']]],
    ['/vs/editor/contrib/suggest/browser/suggestWidget.js', [
      ['    showSuggestions(completionModel, selectionIndex, isFrozen, isAuto, noFocus) {\n',
       '    showSuggestions(completionModel, selectionIndex, isFrozen, isAuto, noFocus) {\n        self.__kdMark && self.__kdMark("showSuggestions");\n'],
      ['        const visibleCount = this._completionModel.items.length;\n',
       t('items', '        const visibleCount = this._completionModel.items.length;\n')],
      ['            this._list.splice(0, this._list.length, this._completionModel.items);\n            this._setState(isFrozen ? State.Frozen : State.Open);\n',
       t('list splice', '            this._list.splice(0, this._list.length, this._completionModel.items);\n') +
       t('setState', '            this._setState(isFrozen ? State.Frozen : State.Open);\n')],
      ['            this._list.setFocus(noFocus ? [] : [selectionIndex]);\n',
       t('setFocus', '            this._list.setFocus(noFocus ? [] : [selectionIndex]);\n')],
      ['            this._layout(this.element.size);\n            this._details.widget.domNode.classList.remove("focused");\n',
       t('frame layout', '            this._layout(this.element.size);\n') + '            this._details.widget.domNode.classList.remove("focused");\n'],
      // (inside fewerRowWrites' condition: this plugin comes after it)
      ['this._list.splice(index, 1, [item]);',
       '{ const kdT_resolvedrow = Date.now(); this._list.splice(index, 1, [item]); self.__kdAdd && self.__kdAdd("resolved row", Date.now() - kdT_resolvedrow); }']]],
    // (the folding regions by indentation, each computation timed)
    ['/vs/editor/contrib/folding/browser/indentRangeProvider.js', [
      ['function computeRanges(model, offSide, markers, foldingRangesLimit = foldingRangesLimitDefault) {\n',
       'function computeRanges(model, offSide, markers, foldingRangesLimit = foldingRangesLimitDefault) {\n    const kdT0 = Date.now();\n'],
      ['    return result.toIndentRanges(model);\n}',
       '    const kdRanges = result.toIndentRanges(model);\n    self.__kdAdd && self.__kdAdd("fold ranges", Date.now() - kdT0);\n    return kdRanges;\n}']]],
    // (the documents' words: when the worker was asked, when it answered, how long it took itself)
    ['/vs/editor/browser/services/editorWorkerService.js', [
      ['        const client = await this._workerManager.withWorker();\n        const data = await client.textualSuggest(models, word?.word, wordDefRegExp);\n',
       '        self.__kdMark && self.__kdMark("words asked");\n' +
       '        const client = await this._workerManager.withWorker();\n        self.__kdMark && self.__kdMark("words: worker ready");\n' +
       '        const data = await client.textualSuggest(models, word?.word, wordDefRegExp);\n' +
       '        self.__kdMark && self.__kdMark("words: " + (data ? data.words.length + " in " + data.duration + " ms in the worker" : "none"));\n']]],
    ['/vs/editor/contrib/suggest/browser/suggestWidgetRenderer.js', [
      ['    renderElement(element, index, data) {\n', '    renderElement(element, index, data) {\n        const kdT0 = Date.now();\n'],
      ['\n    }\n    disposeTemplate(templateData) {', '\n        self.__kdAdd && self.__kdAdd("row render", Date.now() - kdT0);\n    }\n    disposeTemplate(templateData) {']]]
  ])
}

// A build for measuring the Settings editor (KODIUM_SETTINGS_TIMERS=1 .\web\build.ps1): marks along its opening -
// self.__kdMark(name) and self.__kdAdd(name, ms), when a measuring script has set them (renderers' renderTemplate and
// renderElement, the tree's splice summed) - and self.__kdResets: when the default settings were dropped, for which keys.
function settingsTimers() {
  if (!process.env.KODIUM_SETTINGS_TIMERS) return null
  const m = (n) => 'self.__kdMark && self.__kdMark("' + n + '");\n'
  return patchModules('kodium-settings-timers', [
    // (and Keyboard Shortcuts: the model's items, the labels, the table)
    ['/vs/workbench/contrib/preferences/browser/keybindingsEditor.js', [
      ['        return super.setInput(input, options, context, token).then(() => this.render(!!(options && options.preserveFocus)));',
       '        return super.setInput(input, options, context, token).then(() => this.render(!!(options && options.preserveFocus))).then(kdR => { ' + m('kb: setInput done').trim() + ' return kdR; });'],
      ['    layout(dimension) {\n        this.dimension = dimension;\n        this.layoutSearchWidget(dimension);\n',
       '    layout(dimension) {\n        ' + m('kb: layout') + '        this.dimension = dimension;\n        this.layoutSearchWidget(dimension);\n        ' + m('kb: search widget laid out')],
      ['        this.defineKeybindingWidget.layout(this.dimension);\n        this.layoutKeybindingsTable();\n        this._onLayout.fire();\n',
       '        this.defineKeybindingWidget.layout(this.dimension);\n        ' + m('kb: table layout') + '        this.layoutKeybindingsTable();\n        this._onLayout.fire();\n'],
      ['        this.layoutKeybindingsTable();\n        this._onLayout.fire();\n    }\n',
       '        this.layoutKeybindingsTable();\n        this._onLayout.fire();\n        ' + m('kb: layout done') + '    }\n'],
      ['    focus() {\n        super.focus();\n        const activeKeybindingEntry = this.activeKeybindingEntry;\n',
       '    focus() {\n        ' + m('kb: focus') + '        super.focus();\n        const activeKeybindingEntry = this.activeKeybindingEntry;\n'],
      ['            this.keybindingsEditorModel = await input.resolve();\n            await this.keybindingsEditorModel.resolve(this.getActionsLabels());\n            this.renderKeybindingsEntries(false, preserveFocus);\n',
       '            this.keybindingsEditorModel = await input.resolve();\n            ' + m('kb: labels') + '            const kdLabels = this.getActionsLabels();\n            ' + m('kb: model.resolve') +
       '            await this.keybindingsEditorModel.resolve(kdLabels);\n            ' + m('kb: entries') + '            this.renderKeybindingsEntries(false, preserveFocus);\n            ' + m('kb: entries rendered')],
      ['            const keybindingsEntries = this.keybindingsEditorModel.fetch(filter, this.sortByPrecedenceAction.checked);\n',
       '            const keybindingsEntries = this.keybindingsEditorModel.fetch(filter, this.sortByPrecedenceAction.checked);\n            ' + m('kb: fetched')],
      ['            this.keybindingsTable.splice(0, this.keybindingsTable.length, this.tableEntries);\n            this.layoutKeybindingsTable();\n',
       '            ' + m('kb: will splice') + '            this.keybindingsTable.splice(0, this.keybindingsTable.length, this.tableEntries);\n            ' + m('kb: spliced') + '            this.layoutKeybindingsTable();\n            ' + m('kb: laid out')]]],
    ['/vs/workbench/services/preferences/browser/keybindingsEditorModel.js', [
      ['        const commandsWithDefaultKeybindings = this.keybindingsService.getDefaultKeybindings().map(keybinding => keybinding.command);\n',
       '        ' + m('kbm: bound items') + '        const commandsWithDefaultKeybindings = this.keybindingsService.getDefaultKeybindings().map(keybinding => keybinding.command);\n'],
      ['        this._keybindingItemsSortedByPrecedence = distinct(\n', '        ' + m('kbm: unbound items') + '        this._keybindingItemsSortedByPrecedence = distinct(\n'],
      ['        return super.resolve();\n    }\n    static getId(keybindingItem) {', '        ' + m('kbm: sorted') + '        return super.resolve();\n    }\n    static getId(keybindingItem) {']]],
    ['/vs/workbench/services/preferences/common/preferencesModels.js', [
      ['            if (e.source === ConfigurationTarget.DEFAULT) {\n                this.reset();',
       '            if (e.source === ConfigurationTarget.DEFAULT) {\n                (self.__kdResets = self.__kdResets || []).push(Math.round(performance.now()) + ":" + [...e.affectedKeys].slice(0, 6).join("|") + ":" + e.affectedKeys.size);\n                this.reset();'],
      ['        this._allSettingsGroups = this.parse();\n        this._content = undefined;\n        this._contentWithoutMostCommonlyUsed = this.toContent(this._allSettingsGroups, 1);\n',
       '        ' + m('parse') + '        this._allSettingsGroups = this.parse();\n        ' + m('parsed') + '        this._content = undefined;\n        this._contentWithoutMostCommonlyUsed = this.toContent(this._allSettingsGroups, 1);\n        ' + m('toContent') ],
      ['        return this.sortGroups(groups);', '        ' + m('registered') + '        try { return this.sortGroups(groups); } finally { ' + m('sorted') + ' }'],
      ['        this.initAllSettingsMap(settingsGroups);\n        const mostCommonlyUsed = this.getMostCommonlyUsedSettings();',
       '        this.initAllSettingsMap(settingsGroups);\n        const mostCommonlyUsed = this.getMostCommonlyUsedSettings();\n        ' + m('commonly')]]],
    ['/vs/workbench/contrib/preferences/browser/settingsEditor2.js', [
      ['    createEditor(parent) {\n', '    createEditor(parent) {\n        ' + m('createEditor')],
      ['        this.createHeader(this.rootElement);\n        this.createBody(this.rootElement);',
       '        this.createHeader(this.rootElement);\n        ' + m('header') + '        this.createBody(this.rootElement);'],
      ['        this._register(this.searchWidget.onDidFocus(() => {', '        ' + m('search widget') + '        this._register(this.searchWidget.onDidFocus(() => {'],
      ['        this.settingsTargetsWidget.settingsTarget = ConfigurationTarget.USER_LOCAL;', '        ' + m('targets widget') + '        this.settingsTargetsWidget.settingsTarget = ConfigurationTarget.USER_LOCAL;'],
      ['        this.createTOC(this.tocTreeContainer);\n        this.createSettingsTree(this.settingsTreeContainer);',
       '        this.createTOC(this.tocTreeContainer);\n        ' + m('toc') + '        this.createSettingsTree(this.settingsTreeContainer);\n        ' + m('settings tree')],
      ['        this.settingsTree = this._register(this.instantiationService.createInstance(\n            SettingsTree,',
       '        ' + m('renderers') + '        this.settingsTree = this._register(this.instantiationService.createInstance(\n            SettingsTree,'],
      ['        this._register(this.settingsTree.onDidScroll(() => {',
       '        for (const r of this.settingRenderers.allRenderers) for (const k of ["renderTemplate", "renderElement"]) { const f = r[k]; if (f) r[k] = function () { const t = Date.now(); try { return f.apply(this, arguments); } finally { self.__kdAdd && self.__kdAdd(k, Date.now() - t); } }; }\n' +
       '        { const v = this.settingsTree.view, f = v.splice; v.splice = function () { const t = Date.now(); try { return f.apply(this, arguments); } finally { self.__kdAdd && self.__kdAdd("view.splice", Date.now() - t); } }; }\n' +
       '        this._register(this.settingsTree.onDidScroll(() => {'],
      ['        await this.refreshInstalledExtensionsList();\n    }\n', '        await this.refreshInstalledExtensionsList();\n        ' + m('setInput done') + '    }\n'],
      ['    layout(dimension) {\n        this.dimension = dimension;', '    layout(dimension) {\n        ' + m('layout') + '        this.dimension = dimension;'],
      ['        this.settingsTree.rerender();\n        this.tocTree.rerender();\n', '        ' + m('kdShowTree') + '        this.settingsTree.rerender();\n        ' + m('rerendered') + '        this.tocTree.rerender();\n        ' + m('toc rerendered')],
      ['        try { installedExtensions = await this.extensionManagementService.getInstalled(); }',
       '        ' + m('getInstalled') + '        try { installedExtensions = await this.extensionManagementService.getInstalled(); ' + m('installed') + ' }'],
      ['        this.addCtrlAInterceptor(this.rootElement);', '        ' + m('created') + '        this.addCtrlAInterceptor(this.rootElement);'],
      ['        const model = await this.input.resolve();', '        ' + m('setInput') + '        const model = await this.input.resolve();\n        ' + m('input resolved')],
      ['        this.kdTreeGroups = this.kdTreeShape(', '        ' + m('onConfigUpdate') + '        this.kdTreeGroups = this.kdTreeShape('],
      ['        } else if (!this.isVisible()) {\n            this.kdTreeStale = true;\n',
       '        } else if (!this.isVisible()) {\n            (self.__kdLog = self.__kdLog || []).push(Math.round(performance.now()) + " tree stale (refreshTree hidden)");\n            this.kdTreeStale = true;\n'],
      ['        } else {\n            this.kdTreeStale = true;\n',
       '        } else {\n            (self.__kdLog = self.__kdLog || []).push(Math.round(performance.now()) + " tree stale (refreshTOCTree hidden)");\n            this.kdTreeStale = true;\n'],
      ['    async kdShowTree() {\n', '    async kdShowTree() {\n        (self.__kdLog = self.__kdLog || []).push(Math.round(performance.now()) + " kdShowTree, stale rows " + (this.kdStaleRows ? this.kdStaleRows.length : 0));\n'],
      ['    updateElementsByKey(keys) {\n', '    updateElementsByKey(keys) {\n        (self.__kdLog = self.__kdLog || []).push(Math.round(performance.now()) + " updateElementsByKey " + keys.size + (this.isVisible() ? " visible" : " hidden") + ": " + [...keys].slice(0, 4).join("|"));\n'],
      ['    kdSameTree(model) {\n', '    kdSameTree(model) {\n        (self.__kdLog = self.__kdLog || []).push(Math.round(performance.now()) + " kdSameTree: model " + !!this.settingsTreeModel.value + ", groups " + !!this.kdTreeGroups + ", stale " + !!this.kdTreeStale + ", advanced " + (this.kdTreeAdvanced === this.canShowAdvancedSettings()) + ", query " + !!this.viewState.query + ", search " + !!this.searchResultModel);\n'],
      ['        const settingsResult = resolveSettingsTree(tocData, coreSettingsGroups, filter);',
       '        ' + m('groups') + '        const settingsResult = resolveSettingsTree(tocData, coreSettingsGroups, filter);\n        ' + m('tree resolved')],
      ['        const additionalGroups = [];\n        let setAdditionalGroups = false;', '        const additionalGroups = [];\n        let setAdditionalGroups = false;\n        ' + m('toggle?')],
      ['        resolvedSettingsRoot.children.unshift(getCommonlyUsedData(groups));',
       '        ' + m('extension toc') + '        resolvedSettingsRoot.children.unshift(getCommonlyUsedData(groups));\n        ' + m('commonly used')],
      ['            this.refreshModels(resolvedSettingsRoot);\n            const cachedState',
       '            ' + m('models') + '            this.refreshModels(resolvedSettingsRoot);\n            ' + m('models done') + '            const cachedState'],
      ['                this.refreshTOCTree();\n                const rootChildren', '                this.refreshTOCTree();\n                ' + m('toc tree') + '                const rootChildren'],
      ['                this.refreshTree();\n                this.tocTree.collapseAll();',
       '                ' + m('refreshTree') + '                this.refreshTree();\n                ' + m('tree') + '                this.tocTree.collapseAll();\n                ' + m('collapsed')]]]
  ])
}

// A column's place on the screen (CursorColumns): VS Code walks the line by graphemes (their break table, an iterator
// object a character) - ~85 us a character on the iPad 2, ~2.6 ms for a 30-character line - in the hit test of every
// tap and of every move of the loupe's finger, at each cursor move up or down, for the status bar's column at every
// cursor move. A character below U+0300 that the next one is not a combining mark after (they start at U+0300) is a
// grapheme of its own, neither wide nor an emoji: such lines - code, Czech letters too - are counted by characters
// (tabs to their stops); any other character and the walk is VS Code's from the start. Code points (the status bar)
// differ from characters only at surrogates (U+D800 up).
function quickerColumns() {
  return patchModules('kodium-quicker-columns', [
    ['/vs/editor/common/core/cursorColumns.js', [
      ['    static visibleColumnFromColumn(lineContent, column, tabSize) {\n        const textLen = Math.min(column - 1, lineContent.length);\n',
       '    static visibleColumnFromColumn(lineContent, column, tabSize) {\n        const textLen = Math.min(column - 1, lineContent.length);\n' +
       '        let kdResult = 0, kdAt = 0;\n' +
       '        for (; kdAt < textLen; kdAt++) {\n' +
       '            const kdCode = lineContent.charCodeAt(kdAt);\n' +
       '            if (kdCode === CharCode.Tab) {\n                kdResult = kdResult + tabSize - kdResult % tabSize;\n            }\n' +
       '            else if (kdCode < 0x300) {\n                kdResult++;\n            }\n' +
       '            else {\n                break;\n            }\n' +
       '        }\n' +
       '        if (kdAt === textLen) {\n            return kdResult;\n        }\n'],
      ['    static toStatusbarColumn(lineContent, column, tabSize) {\n        const text = lineContent.substring(0, Math.min(column - 1, lineContent.length));\n',
       '    static toStatusbarColumn(lineContent, column, tabSize) {\n' +
       '        const kdLen = Math.min(column - 1, lineContent.length);\n' +
       '        let kdResult = 0, kdAt = 0;\n' +
       '        for (; kdAt < kdLen; kdAt++) {\n' +
       '            const kdCode = lineContent.charCodeAt(kdAt);\n' +
       '            if (kdCode === CharCode.Tab) {\n                kdResult = kdResult + tabSize - kdResult % tabSize;\n            }\n' +
       '            else if (kdCode < 0xD800) {\n                kdResult++;\n            }\n' +
       '            else {\n                break;\n            }\n' +
       '        }\n' +
       '        if (kdAt === kdLen) {\n            return kdResult + 1;\n        }\n' +
       '        const text = lineContent.substring(0, Math.min(column - 1, lineContent.length));\n'],
      ['        const lineContentLength = lineContent.length;\n        const iterator = new GraphemeIterator(lineContent);\n',
       '        const lineContentLength = lineContent.length;\n' +
       '        let kdBefore = 0;\n' +
       '        for (let kdAt = 0; kdAt < lineContentLength; kdAt++) {\n' +
       '            const kdCode = lineContent.charCodeAt(kdAt);\n' +
       '            if (kdCode >= 0x300 || (kdAt + 1 < lineContentLength && lineContent.charCodeAt(kdAt + 1) >= 0x300)) {\n                kdBefore = -1;\n                break;\n            }\n' +
       '            const kdAfter = kdCode === CharCode.Tab ? kdBefore + tabSize - kdBefore % tabSize : kdBefore + 1;\n' +
       '            if (kdAfter >= visibleColumn) {\n                return kdAfter - visibleColumn < visibleColumn - kdBefore ? kdAt + 2 : kdAt + 1;\n            }\n' +
       '            kdBefore = kdAfter;\n' +
       '        }\n' +
       '        if (kdBefore !== -1) {\n            return lineContentLength + 1;\n        }\n' +
       '        const iterator = new GraphemeIterator(lineContent);\n']]]
  ])
}

// Format Document in CSS, HTML and JSON asked which formatter to take ("There are multiple formatters...", a pick of
// two nameless entries, both "(default)"): monaco's language services register a document and a range formatter, and
// VS Code adds a range formatter as a document formatter too unless the same extension has one - they come from no
// extension. A range formatter of no extension is not added when a document formatter of no extension is there
// (VS Code takes "no extension" as one already: both were the default). Format Selection keeps the range formatter.
function singleFormatters() {
  return patchModules('kodium-single-formatters', [
    ['/vs/editor/contrib/format/browser/format.js', [
      ['            seen.add(formatter.extensionId);\n        }\n        result.push({',
       '            seen.add(formatter.extensionId);\n        }\n' +
       '        else if (result.some(f => !f.extensionId)) {\n            continue;\n        }\n' +
       '        result.push({']]]
  ])
}

// The terminal's start, 2.4 s on the iPad 2 before the shell was asked for, half of it xterm.js's styles. Its DOM
// renderer has a <style> for the cells' size and one for the theme (256 colours, the cursor), its scroll bar another:
// each went into the page empty and got its text after, the renderer's two again at every option set (VS Code sets a
// dozen as the terminal opens) - the same text as often as not - and every write had the old WebKit work out the whole
// page's style again (70-160 ms); the 55 KB of the theme's went through the engine's rewriter in the page as well
// (0.2-0.3 s). Now each terminal has one style - the cells' rule, the theme's, the scroll bar's - that goes in with
// its text, written again only when the text changed, and written as the rewriter would have it (vsc-prelude.js
// __kd_xtermStyle), so the engine's shim leaves it alone.
function quickerTerminal() {
  return patchModules('kodium-quicker-terminal', [
    ['/@xterm/xterm/lib/xterm.mjs', [
      ['this._dimensionsStyleElement||(this._dimensionsStyleElement=this._document.createElement("style"),this._screenElement.appendChild(this._dimensionsStyleElement));' +
       'let t=`${this._terminalSelector} .xterm-rows span { display: inline-block; height: 100%; vertical-align: top;}`;this._dimensionsStyleElement.textContent=t,',
       'this._dimensionsStyleElement||(this._dimensionsStyleElement=this._document.createElement("style"));'],
      ['this._themeStyleElement||(this._themeStyleElement=this._document.createElement("style"),this._screenElement.appendChild(this._themeStyleElement));' +
       'let t=`${this._terminalSelector} .xterm-rows { pointer-events: none;',
       'this._themeStyleElement||(this._themeStyleElement=this._document.createElement("style"));' +
       'let t=`${this._terminalSelector} .xterm-rows span { display: inline-block; height: 100%; vertical-align: top;}${this._terminalSelector} .xterm-rows { pointer-events: none;'],
      ['this._themeStyleElement.textContent=t}',
       't+=`.xterm .xterm-scrollable-element > .xterm-scrollbar > .xterm-slider { background: ${e.scrollbarSliderBackground.css}; }' +
       '.xterm .xterm-scrollable-element > .xterm-scrollbar > .xterm-slider:hover { background: ${e.scrollbarSliderHoverBackground.css}; }' +
       '.xterm .xterm-scrollable-element > .xterm-scrollbar > .xterm-slider.xterm-active { background: ${e.scrollbarSliderActiveBackground.css}; }`,' +
       'this._kdThemeText!==t&&(this._kdThemeText=t,this._themeStyleElement.textContent=self.__kd_xtermStyle?self.__kd_xtermStyle(t):t),' +
       'this._themeStyleElement.parentNode||(this._document.head||this._screenElement).appendChild(this._themeStyleElement)}'],
      ['this._styleElement=s.mainDocument.createElement("style"),t.appendChild(this._styleElement),this._register(E(()=>this._styleElement.remove())),' +
       'this._register(j.runAndSubscribe(l.onChangeColors,()=>{this._styleElement.textContent=[',
       'this._register(j.runAndSubscribe(l.onChangeColors,()=>{void [']]],
    // (and the workbench's styles of the terminals' icons and colours, written again at every terminal made or
    // closed - 4 writes as one opened, 65 ms each - mostly the same text: an icon's rule came once per terminal. The
    // view's goes into the head with its first text - mostly never: the default icons need none - instead of into the
    // view's DOM, which goes out of the page and back with the panel's views, and the empty <style> the view put
    // there besides, used by nothing, is left out. xterm.js's goes into the head too instead of the terminal's DOM:
    // the old WebKit parsed its 58 KB again whenever the terminal came back into the page, and made the page's rule
    // sets anew at once - see sharedListStyles. Its ~770 rules put into the lists' shared sheet one by one instead
    // made a new terminal no quicker.)
    // (- and the view makes no terminal when it shows or gets the focus while the warm-up has it shown,
    // self.__kd_viewOnly: the warm-up makes the view - its tabs, their list, its title bar's actions - without a shell,
    // and a terminal shows in it as it would: the view makes one as it shows empty, the first time since the start, or
    // gets the focus empty. The panel shown again opens its last view with the focus: the warm-up started a shell
    // whenever that was the Terminal)
    ['/vs/workbench/contrib/terminal/browser/terminalView.js', [
      ['    _initializeTerminal(checkRestoredTerminals) {\n        if (this.isBodyVisible() &&',
       '    _initializeTerminal(checkRestoredTerminals) {\n        if (typeof self !== "undefined" && self.__kd_viewOnly) {\n            return;\n        }\n        if (this.isBodyVisible() &&'],
      ['            if (this._terminalGroupService.instances.length === 0 && !this._isTerminalBeingCreated) {\n',
       '            if (this._terminalGroupService.instances.length === 0 && !this._isTerminalBeingCreated && !(typeof self !== "undefined" && self.__kd_viewOnly)) {\n'],
      ['        createStyleSheet(this._parentDomElement);\n', ''],
      ['        this._styleElement = createStyleSheet(container);\n',
       '        this._styleElement = document.createElement("style");\n'],
      ['        this._styleElement.textContent = css;\n    }\n};\nTerminalThemeIconStyle = ',
       '        if (css !== (this.kdCss || "")) {\n            this.kdCss = css;\n            this._styleElement.textContent = css;\n' +
       '            if (!this._styleElement.parentNode) {\n                document.head.appendChild(this._styleElement);\n            }\n' +
       '        }\n    }\n};\nTerminalThemeIconStyle = ']]],
    ['/vs/workbench/contrib/terminal/browser/terminalService.js', [
      ['        let css = "";\n        const productIconTheme = this._themeService.getProductIconTheme();',
       '        let css = "", kdRule;\n        const productIconTheme = this._themeService.getProductIconTheme();'],
      ['                        css += inline`.monaco-workbench .terminal-tab.codicon-${className(icon.id)}::before\n',
       '                        kdRule = inline`.monaco-workbench .terminal-tab.codicon-${className(icon.id)}::before\n'],
      ['font-family: ${stringValue(def.font?.id ?? "codicon")} !important;}`;\n',
       'font-family: ${stringValue(def.font?.id ?? "codicon")} !important;}`;\n                        if (css.indexOf(kdRule) === -1) css += kdRule;\n'],
      ['        css += getColorStyleContent(colorTheme);\n        this._styleElement.textContent = css;\n',
       '        css += getColorStyleContent(colorTheme);\n        if (css !== (this.kdCss || "")) {\n            this.kdCss = css;\n            this._styleElement.textContent = css;\n        }\n']]]
  ])
}

// A build for measuring the Search view (KODIUM_SEARCH_TIMERS=1 .\web\build.ps1): self.__kdAdd(name, ms) around the
// results' renderers, the async tree's refreshes and renders, the results model's add, the view's tree refreshes
// (the async ones until they settle), when a script has set it.
function searchTimers() {
  if (!process.env.KODIUM_SEARCH_TIMERS) return null
  const wrap = 'function kdTime(proto, name, label) {\n' +
    '    const f = proto[name];\n' +
    '    if (typeof f !== "function") return;\n' +
    '    proto[name] = function () {\n' +
    '        const t = Date.now();\n' +
    '        let r;\n' +
    '        try { r = f.apply(this, arguments); } finally { if (!(r && typeof r.then === "function")) self.__kdAdd && self.__kdAdd(label, Date.now() - t); }\n' +
    '        if (r && typeof r.then === "function") r.then(() => self.__kdAdd && self.__kdAdd(label + " (settled)", Date.now() - t), () => {});\n' +
    '        return r;\n' +
    '    };\n' +
    '}\n'
  return patchModules('kodium-search-timers', [
    ['/vs/workbench/contrib/search/browser/searchResultsView.js', [
      ['export { FileMatchRenderer, FolderMatchRenderer, MatchRenderer, SearchAccessibilityProvider, SearchDelegate, TextSearchResultRenderer };',
       'for (const [C, n] of [[TextSearchResultRenderer, "text"], [FolderMatchRenderer, "folder"], [FileMatchRenderer, "file"], [MatchRenderer, "match"]]) {\n' +
       '    kdTime(C.prototype, "renderTemplate", n + ".renderTemplate");\n    kdTime(C.prototype, "renderElement", n + ".renderElement");\n}\n' +
       'export { FileMatchRenderer, FolderMatchRenderer, MatchRenderer, SearchAccessibilityProvider, SearchDelegate, TextSearchResultRenderer };']],
     wrap],
    ['/vs/base/browser/ui/tree/asyncDataTree.js', [
      ['export { AsyncDataTree, CompressibleAsyncDataTree };',
       'kdTime(AsyncDataTree.prototype, "render", "tree.render");\nkdTime(AsyncDataTree.prototype, "updateChildren", "tree.updateChildren");\n' +
       'kdTime(AsyncDataTree.prototype, "refreshNode", "tree.refreshNode");\n' +
       'export { AsyncDataTree, CompressibleAsyncDataTree };']],
     wrap],
    ['/vs/workbench/contrib/search/browser/searchTreeModel/searchResult.js', [
      ['export { SearchResultImpl };', 'kdTime(SearchResultImpl.prototype, "add", "results.add");\nkdTime(SearchResultImpl.prototype, "clear", "results.clear");\nexport { SearchResultImpl };']],
     wrap],
    ['/vs/workbench/contrib/search/browser/searchView.js', [
      ['export { SearchView, SearchViewPosition, getEditorSelectionFromMatch, getSelectionTextFromEditor };',
       'kdTime(RefreshTreeController.prototype, "refreshTree", "view.refreshTree");\nkdTime(SearchView.prototype, "onSearchComplete", "view.onSearchComplete");\n' +
       'kdTime(SearchView.prototype, "updateSearchResultCount", "view.updateSearchResultCount");\n' +
       'export { SearchView, SearchViewPosition, getEditorSelectionFromMatch, getSelectionTextFromEditor };']],
     wrap]
  ])
}

// The search of the workspace's files is Kodium's (web/src/search.ts): monaco-vscode-api's provider is not made - it
// listed the whole workspace through the file service as the workbench started, and searched only those files.
function ownSearch() {
  return patchModules('kodium-own-search', [
    ['/monaco-vscode-search-service-override/common.js', [
      ['            const workspaceSearchProvider = new WorkspaceSearchProvider(fileService, logService, workspaceContextService, undefined, configurationService);\n' +
       '            this.registerSearchResultProvider(Schemas.file, SearchProviderType.file, workspaceSearchProvider);\n' +
       '            this.registerSearchResultProvider(Schemas.file, SearchProviderType.text, workspaceSearchProvider);\n',
       '            // (Kodium\'s provider: web/src/search.ts)\n']]],
    // (a search's results in a single file are opened when it completes, as VS Code opens them for a search it
    // restores: with search.collapseResults "auto" - Kodium's default - a lone file of 11-49 matches stayed closed)
    ['/vs/workbench/contrib/search/browser/searchView.js', [
      ['        if (completed?.exit === SearchCompletionExitCode.NewSearchStarted) {\n            return;\n        }\n        SearchContext.AIResultsRequested.bindTo',
       '        if (completed?.exit === SearchCompletionExitCode.NewSearchStarted) {\n            return;\n        }\n' +
       '        if (allResults) {\n            await this.expandIfSingularResult().catch(() => undefined);\n        }\n' +
       '        SearchContext.AIResultsRequested.bindTo']]]
  ])
}

// Cut and Copy in the app. VS Code makes them only where document.queryCommandSupported('cut'/'copy') says yes - iOS 6
// says no, so there were none (the key bar's ctrl+x and ctrl+c, the editor's menu, the selection's callout did
// nothing) - and copies by execCommand('copy'), whose copy event iOS 6 never fires (the engine's own copy took the
// textarea's "vscode-placeholder" then). In the app they are made, and they write the editor's selection through the
// clipboard service, as VS Code does in Electron when the event fails to come; a cut then deletes it.
function iosClipboard() {
  return patchModules('kodium-ios-clipboard', [
    ['/vs/editor/contrib/clipboard/browser/clipboard.js', [
      ['const supportsCut = (isNative || (document.queryCommandSupported', 'const supportsCut = (isNative || kdInApp || (document.queryCommandSupported'],
      ['const supportsCopy = (isNative || (document.queryCommandSupported', 'const supportsCopy = (isNative || kdInApp || (document.queryCommandSupported'],
      ['function executeClipboardCopyWithWorkaround(editor, clipboardService) {\n',
       'function executeClipboardCopyWithWorkaround(editor, clipboardService) {\n' +
       '    if (kdInApp) {\n' +
       '        const { dataToCopy } = generateDataToCopyAndStoreInMemory(editor._getViewModel(), undefined, isFirefox);\n' +
       '        void clipboardService.writeText(dataToCopy.text);\n' +
       '        return;\n' +
       '    }\n'],
      ['            if (focusedEditor.getOption(EditorOption.effectiveEditContext) && browserCommand === "cut") {',
       '            if ((focusedEditor.getOption(EditorOption.effectiveEditContext) || kdInApp) && browserCommand === "cut") {']],
     'const kdInApp = typeof location === "object" && location.hostname === "kodium.invalid";\n']
  ])
}

// A build for measuring a terminal's start (KODIUM_TERMINAL_TIMERS=1 .\web\build.ps1): self.__kdMark(name) along the
// way from the command to the shell's start, self.__kdAdd(name, ms) for each terminal contribution's making and opening.
function terminalTimers() {
  if (!process.env.KODIUM_TERMINAL_TIMERS) return null
  const m = (n) => 'self.__kdMark && self.__kdMark("' + n + '");\n'
  return patchModules('kodium-terminal-timers', [
    ['/vs/workbench/contrib/terminal/browser/terminalService.js', [
      ['    async createTerminal(options) {\n', '    async createTerminal(options) {\n        ' + m('createTerminal')],
      ['        this._evaluateLocalCwd(shellLaunchConfig);', '        ' + m('profile and cwd') + '        this._evaluateLocalCwd(shellLaunchConfig);'],
      ['        const parent = await this._getSplitParent(options?.location);', '        ' + m('location') + '        const parent = await this._getSplitParent(options?.location);'],
      ['        this._extensionService.activateByEvent("onTerminal:*");\n        let instance;',
       '        this._extensionService.activateByEvent("onTerminal:*");\n        ' + m('activateByEvent') + '        let instance;'],
      ['            instance = this._createTerminal(shellLaunchConfig, location, options);\n        }',
       '            instance = this._createTerminal(shellLaunchConfig, location, options);\n            ' + m('_createTerminal done') + '        }']]],
    ['/vs/workbench/contrib/terminal/browser/terminalInstance.js', [
      ['        this._initDimensions();\n        this._processManager = this._createProcessManager();\n',
       '        ' + m('instance: dims') + '        this._initDimensions();\n        this._processManager = this._createProcessManager();\n        ' + m('instance: process manager')],
      ['        this._xtermReadyPromise = this._createXterm();\n        this._xtermReadyPromise.then(async () => {\n            await this._containerReadyBarrier.wait();\n',
       '        this._xtermReadyPromise = this._createXterm();\n        ' + m('instance: _createXterm called') + '        this._xtermReadyPromise.then(async () => {\n            ' + m('xterm ready') +
       '            await this._containerReadyBarrier.wait();\n            ' + m('container ready')],
      ['            await this._createProcess();\n            if (this.shellLaunchConfig.attachPersistentProcess) {',
       '            ' + m('_createProcess') + '            await this._createProcess();\n            ' + m('_createProcess done') + '            if (this.shellLaunchConfig.attachPersistentProcess) {'],
      ['        const contributionDescs = TerminalExtensionsRegistry.getTerminalContributions();',
       '        ' + m('contributions') + '        const contributionDescs = TerminalExtensionsRegistry.getTerminalContributions();'],
      ['            let contribution;\n            try {\n', '            let contribution;\n            const kdT = Date.now();\n            try {\n'],
      ['                this._contributions.set(desc.id, contribution);\n            } catch (err) {',
       '                this._contributions.set(desc.id, contribution);\n                self.__kdAdd && self.__kdAdd("contrib " + desc.id, Date.now() - kdT);\n            } catch (err) {'],
      ['        const Terminal = await TerminalInstance_1.getXtermConstructor(this._keybindingService, this._contextKeyService);',
       '        ' + m('xterm constructor') + '        const Terminal = await TerminalInstance_1.getXtermConstructor(this._keybindingService, this._contextKeyService);\n        ' + m('xterm constructor loaded')],
      ['        this.xterm = xterm;\n        this._resizeDebouncer', '        ' + m('XtermTerminal made') + '        this.xterm = xterm;\n        this._resizeDebouncer'],
      ['        this._register(this._processManager.onProcessData(e => this._onProcessData(e)));',
       '        ' + m('xterm listeners') + '        this._register(this._processManager.onProcessData(e => this._onProcessData(e)));'],
      ['        const trusted = this._isRemoteResolverTerminal || (await this._trust());',
       '        ' + m('trust') + '        const trusted = this._isRemoteResolverTerminal || (await this._trust());\n        ' + m('trusted')],
      ['        const originalIcon = this.shellLaunchConfig.icon;\n', '        ' + m('pm.createProcess') + '        const originalIcon = this.shellLaunchConfig.icon;\n'],
      ['        const screenElement = xterm.attachToElement(xtermHost);\n        for (const contribution of ( this._contributions.values())) {',
       '        ' + m('_open: xterm.attachToElement') + '        const screenElement = xterm.attachToElement(xtermHost);\n        ' + m('_open: attached') +
       '        for (const contribution of ( this._contributions.values())) {\n            const kdT = Date.now();\n            try {'],
      ['            } else {\n                contribution.xtermOpen?.(this.xterm);\n            }\n        }\n',
       '            } else {\n                contribution.xtermOpen?.(this.xterm);\n            }\n            } finally { self.__kdAdd && self.__kdAdd("xtermOpen " + (contribution.constructor && contribution.constructor.ID || contribution.constructor.name), Date.now() - kdT); }\n        }\n        ' + m('_open: contributions opened')],
      ['        this._widgetManager.attachToElement(screenElement);\n', '        ' + m('_open: widgets') + '        this._widgetManager.attachToElement(screenElement);\n'],
      ['        this.updateConfig();\n        if (xterm.raw.options.disableStdin) {', '        ' + m('_open: updateConfig') + '        this.updateConfig();\n        ' + m('_open: config updated') + '        if (xterm.raw.options.disableStdin) {']]],
    ['/vs/workbench/contrib/terminal/browser/terminalProcessManager.js', [
      ['        this._processListeners = [newProcess.onProcessReady(e => {\n', '        this._processListeners = [newProcess.onProcessReady(e => {\n            ' + m('pm: process ready')],
      ['            this._onProcessReady.fire(e);\n            if (this._preLaunchInputQueue.length > 0 && this._process) {',
       '            this._onProcessReady.fire(e);\n            ' + m('pm: ready listeners done') + '            if (this._preLaunchInputQueue.length > 0 && this._process) {'],
      ['        const result = await newProcess.start();\n', '        ' + m('pm: start') + '        const result = await newProcess.start();\n        ' + m('pm: started')],
      ['        await this._terminalProfileResolverService.resolveShellLaunchConfig(shellLaunchConfig, {\n            remoteAuthority: undefined,',
       '        ' + m('pm: resolveShellLaunchConfig') + '        await this._terminalProfileResolverService.resolveShellLaunchConfig(shellLaunchConfig, {\n            remoteAuthority: undefined,'],
      ['        const activeWorkspaceRootUri = this._historyService.getLastActiveWorkspaceRoot(Schemas.file);\n        const initialCwd',
       '        ' + m('pm: cwd') + '        const activeWorkspaceRootUri = this._historyService.getLastActiveWorkspaceRoot(Schemas.file);\n        const initialCwd'],
      ['        const env = await this._resolveEnvironment(backend, variableResolver, shellLaunchConfig);\n        const options = {\n            shellIntegration: {\n                enabled: this._configurationService.getValue(TerminalSettingId.ShellIntegrationEnabled),\n                suggestEnabled: this._configurationService.getValue(TerminalContribSettingId.SuggestEnabled),\n                nonce: this.shellIntegrationNonce\n            },\n            windowsUseConptyDll: this._terminalConfigurationService.config.windowsUseConptyDll ?? false,\n            environmentVariableCollections: this._extEnvironmentVariableCollection ? ',
       '        ' + m('pm: environment') + '        const env = await this._resolveEnvironment(backend, variableResolver, shellLaunchConfig);\n        ' + m('pm: environment done') + '        const options = {\n            shellIntegration: {\n                enabled: this._configurationService.getValue(TerminalSettingId.ShellIntegrationEnabled),\n                suggestEnabled: this._configurationService.getValue(TerminalContribSettingId.SuggestEnabled),\n                nonce: this.shellIntegrationNonce\n            },\n            windowsUseConptyDll: this._terminalConfigurationService.config.windowsUseConptyDll ?? false,\n            environmentVariableCollections: this._extEnvironmentVariableCollection ? ']]],
    ['/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.js', [
      ['        this.raw = this._register(( new xtermCtor({', '        ' + m('xterm: new Terminal') + '        this.raw = this._register(( new xtermCtor({'],
      ['        this._updateSmoothScrolling();\n        this._core = this.raw._core;', '        ' + m('xterm: Terminal made') + '        this._updateSmoothScrolling();\n        this._core = this.raw._core;'],
      ['        this._updateUnicodeVersion();\n        this._markNavigationAddon =', '        ' + m('xterm: addons') + '        this._updateUnicodeVersion();\n        this._markNavigationAddon ='],
      ['        this._shellIntegrationAddon = ( new ShellIntegrationAddon(', '        ' + m('xterm: shell integration addon') + '        this._shellIntegrationAddon = ( new ShellIntegrationAddon('],
      ['        this._xtermAddonLoader.importAddon("clipboard").then(', '        ' + m('xterm: addons loaded') + '        this._xtermAddonLoader.importAddon("clipboard").then(']]]
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
  // (the integrated browser's editor input: imported for nothing it registers; the GPU renderer's debugging commands)
  'vs/workbench/contrib/browserView/common/browserEditorInput.js',
  'vs/editor/contrib/gpu/browser/gpuActions.js',
  // (the stylesheet of the floating panels - an experimental setting, off: 81 rules under .floating-panels, which the
  // old WebKit still tried at every style recalculation of the elements their last part names, 38 KB)
  'vs/workbench/browser/media/floatingPanels.css',
  // (the terminal's parts Kodium's shells cannot serve or the iPad does without - 1.3 MB of 2.1: the accessible view of
  // its buffer, voice input with chat's speech service, completions, history, quick fixes, sticky scroll and command
  // guide - these four need VS Code's shell integration scripts, which the Kodium Shell daemon's bash does not run -,
  // type-ahead echo for slow remote shells, notifications, chat hints, telemetry, developer commands, external terminals
  // and the WSL hint of Windows)
  ...['accessibility/browser/terminal.accessibility', 'voice/browser/terminal.voice', 'suggest/browser/terminal.suggest',
      'typeAhead/browser/terminal.typeAhead', 'history/browser/terminal.history', 'quickFix/browser/terminal.quickFix',
      'stickyScroll/browser/terminal.stickyScroll', 'notification/browser/terminal.notification',
      'inlineHint/browser/terminal.initialHint', 'developer/browser/terminal.developer', 'telemetry/browser/terminal.telemetry',
      'wslRecommendation/browser/terminal.wslRecommendation', 'commandGuide/browser/terminal.commandGuide']
    .map((name) => 'vs/workbench/contrib/terminalContrib/' + name + '.contribution.js'),
  'vs/workbench/contrib/externalTerminal/browser/externalTerminal.contribution.js',
  ...['EditorTabs', 'Comments', 'Testing', 'Task', 'TerminalService', 'TerminalShellIntegration', 'DebugService', 'SCM',
      'CLICommands', 'TunnelService', 'Speech', 'ManagedSockets', 'DataChannels', 'Browsers']
    .map((name) => 'vs/workbench/api/browser/mainThread' + name + '.js')
]
function leaveOut() {
  return {
    name: 'kodium-leave-out',
    load(id) {
      const p = id.replace(/\\/g, '/')
      return LEFT_OUT.some((suffix) => p.endsWith('/' + suffix)) ? (p.endsWith('.css') ? '' : 'export {}') : null
    }
  }
}

// The explorer read all its folders again whenever it was shown - the side bar shown again, the Explorer after the
// Search view (0.3-0.5 s of the 1 s of each on the iPad 2) - "to compensate for missing file events". It does now only
// when something changed while it was hidden (a refresh it skipped, the folders it was not given) or it has no folders
// yet. What changes outside the workbench - files from another app, iTunes File Sharing while the app is in the
// background - Kodium tells it (src/explorer.ts).
// And the Output view let go of its channel whenever the panel was hidden, and took it up again when shown: the
// editor's whole view made anew (a quarter of the panel's 0.8-1 s). The channel stays now (a channel that changes
// while hidden is shown as it is then).
// The first suggestions of a start in a language parsed the body of every snippet of that language (146 for
// JavaScript: whether it is trivial, uses the clipboard...), half of the first list's 1.5 s on the iPad 2: what came
// of each body is kept in localStorage, for the next starts (the same body gives the same answers).
// The Open Editors view, at every change of an editor's row - the first key after a save makes the file dirty, the
// first key in a file opened for a look pins it - redraws the row, which has the list tell its focus anew (twice): at
// each, the view reset its 13 context keys (the focused file's name, folder, language...) and set them again, every
// change told to every menu - 0.35 s of such a key's 0.55 in the profiler. The keys change now when what the focused
// row stands for does, in one change - and when only whether its file is saved changed, only the key that says so.
// The views' title bars (the Explorer's New File..., Open Editors', the Outline's, the Timeline's) made their toolbars
// anew whenever a context key their menus look at changed - opening a file, switching tabs - though the actions came
// out the same: a toolbar is made again when its actions (what they show and whether they are on) are others. The
// actions of a view's title get the view's context at run time, not the editor's. The same for the side bar's and the
// panel's own title bars - the Terminal's (its profiles' dropdown, split, kill...) was made twice as a second editor
// group opened (the Markdown preview to the side: ~130 ms) and at many a switch of editors.
function quickerViews() {
  const actionsKey = 'function kdActionsKey(actions) {\n' +
    '    let key = "";\n' +
    '    for (const a of actions) {\n' +
    '        key += a.id + "\\u0001" + a.label + "\\u0001" + a.tooltip + "\\u0001" + a.class + "\\u0001" + a.enabled + "\\u0001" + a.checked + "\\u0001" +\n' +
    '            (a.hideActions ? a.hideActions.isHidden : "") + "\\u0002";\n' +
    '        if (a.actions && a.actions.length) {\n            key += "[" + kdActionsKey(a.actions) + "]";\n        }\n' +
    '    }\n' +
    '    return key;\n' +
    '}\n'
  return patchModules('kodium-quicker-views', [
    ['/vs/workbench/browser/parts/views/viewPane.js', [
      ['            this.toolbar.setActions(\n                prepareActions(primaryActions),\n                prepareActions(this.menuActions.getSecondaryActions())\n            );\n            this.toolbar.context = this.getActionsContext();',
       '            const kdPrimary = prepareActions(primaryActions), kdSecondary = prepareActions(this.menuActions.getSecondaryActions());\n' +
       '            const kdKey = kdActionsKey(kdPrimary) + "||" + kdActionsKey(kdSecondary);\n' +
       '            if (kdKey !== this.kdActionsKey) {\n' +
       '                this.kdActionsKey = kdKey;\n' +
       '                this.toolbar.setActions(kdPrimary, kdSecondary);\n' +
       '            }\n' +
       '            this.toolbar.context = this.getActionsContext();']],
     actionsKey],
    ['/vs/workbench/browser/parts/compositePart.js', [
      ['            this.toolBar?.setActions(prepareActions(primaryActions), prepareActions(secondaryActions), menuIds);\n',
       '            const kdPrimary = prepareActions(primaryActions), kdSecondary = prepareActions(secondaryActions);\n' +
       '            const kdKey = (composite ? composite.getId() : "") + "||" + kdActionsKey(kdPrimary) + "||" + kdActionsKey(kdSecondary) + "||" +\n' +
       '                (menuIds ? menuIds.map(m => m.id).join(",") : "");\n' +
       '            if (kdKey !== this.kdActionsKey) {\n' +
       '                this.kdActionsKey = kdKey;\n' +
       '                this.toolBar?.setActions(kdPrimary, kdSecondary, menuIds);\n' +
       '            }\n']],
     actionsKey],
    ['/vs/workbench/contrib/files/browser/views/openEditorsView.js', [
      ['        this._register(this.list.onDidChangeFocus(e => {\n            resourceContext.reset();\n' +
       '            groupFocusedContext.reset();\n            dirtyEditorFocusedContext.reset();\n            readonlyEditorFocusedContext.reset();\n' +
       '            const element = e.elements.length ? e.elements[0] : undefined;\n',
       '        let kdFocused, kdFocusedRow;\n' +
       '        this._register(this.list.onDidChangeFocus(e => {\n' +
       '            const kdElement = e.elements.length ? e.elements[0] : undefined;\n' +
       '            const kdRow = kdElement instanceof OpenEditor ? "e" + String(kdElement.getResource()) + "|" + !!kdElement.editor.isReadonly()\n' +
       '                : kdElement ? "g" + kdElement.id : "";\n' +
       '            const kdDirty = kdElement instanceof OpenEditor && kdElement.editor.isDirty() && !kdElement.editor.isSaving();\n' +
       '            const kdNow = kdRow + "|" + kdDirty;\n' +
       '            if (kdNow === kdFocused) {\n                return;\n            }\n' +
       // (the same row, only saved or changed: the one key that says so)
       '            const kdOnlyDirty = kdFocused !== undefined && kdRow === kdFocusedRow;\n' +
       '            kdFocused = kdNow;\n' +
       '            kdFocusedRow = kdRow;\n' +
       '            if (kdOnlyDirty) {\n                dirtyEditorFocusedContext.set(kdDirty);\n                return;\n            }\n' +
       '            this.contextKeyService.bufferChangeEvents(() => {\n' +
       '            resourceContext.reset();\n' +
       '            groupFocusedContext.reset();\n            dirtyEditorFocusedContext.reset();\n            readonlyEditorFocusedContext.reset();\n' +
       '            const element = e.elements.length ? e.elements[0] : undefined;\n'],
      ['            } else if (element) {\n                groupFocusedContext.set(true);\n            }\n        }));',
       '            } else if (element) {\n                groupFocusedContext.set(true);\n            }\n            });\n        }));']]],
    ['/vs/workbench/contrib/snippets/browser/snippetsFile.js', [
      ['class SnippetBodyInsights {\n    constructor(body) {\n',
       'const kdInsightsKey = "kodium.snippetInsights." + (String(SnippetParser.prototype.parse) + String(SnippetParser.prototype._parse)).length;\n' +
       'let kdInsights;\n' +
       'let kdInsightsTimer;\n' +
       'function kdKnownInsights() {\n' +
       '    if (!kdInsights) {\n' +
       '        kdInsights = new Map();\n' +
       '        try {\n' +
       '            const raw = localStorage.getItem(kdInsightsKey);\n' +
       '            if (raw) for (const entry of JSON.parse(raw)) kdInsights.set(entry[0], entry[1]);\n' +
       '        } catch (e) {}\n' +
       '    }\n' +
       '    return kdInsights;\n' +
       '}\n' +
       'function kdKeepInsights(body, insights) {\n' +
       '    kdKnownInsights().set(body, insights);\n' +
       '    clearTimeout(kdInsightsTimer);\n' +
       '    kdInsightsTimer = setTimeout(() => {\n' +
       '        try {\n' +
       '            for (let i = localStorage.length - 1; i >= 0; i--) {\n' +
       '                const key = localStorage.key(i);\n' +
       '                if (key && key !== kdInsightsKey && key.indexOf("kodium.snippetInsights.") === 0) localStorage.removeItem(key);\n' +
       '            }\n' +
       '            localStorage.setItem(kdInsightsKey, JSON.stringify(Array.from(kdInsights)));\n' +
       '        } catch (e) {}\n' +
       '    }, 5000);\n' +
       '}\n' +
       'class SnippetBodyInsights {\n    constructor(body) {\n' +
       '        const known = kdKnownInsights().get(body);\n' +
       '        if (known) {\n' +
       '            this.isBogous = known[0];\n' +
       '            this.isTrivial = known[1];\n' +
       '            this.usesClipboardVariable = known[2];\n' +
       '            this.usesSelectionVariable = known[3];\n' +
       '            this.codeSnippet = known.length > 4 ? known[4] : body;\n' +
       '            return;\n' +
       '        }\n' +
       '        this.kdCompute(body);\n' +
       '        const insights = [this.isBogous, this.isTrivial, this.usesClipboardVariable, this.usesSelectionVariable];\n' +
       '        if (this.codeSnippet !== body) insights.push(this.codeSnippet);\n' +
       '        kdKeepInsights(body, insights);\n' +
       '    }\n' +
       '    kdCompute(body) {\n']]],
    ['/vs/workbench/contrib/output/browser/outputView.js', [
      ['        this.editor.setVisible(visible);\n        if (!visible) {\n            this.clearInput();\n        }\n',
       '        this.editor.setVisible(visible);\n']]],
    ['/vs/workbench/contrib/files/browser/views/explorerView.js', [
      ['            if (visible) {\n                await this.setTreeInput();\n',
       '            if (visible) {\n' +
       '                if (!this.tree.getInput() || this.kdInputStale) {\n' +
       '                    this.kdInputStale = false;\n' +
       '                    await this.setTreeInput();\n' +
       '                }\n'],
      ['    refresh(recursive, item, cancelEditing = true) {\n        if (!this.tree || !this.isBodyVisible()',
       '    refresh(recursive, item, cancelEditing = true) {\n' +
       '        if (this.tree && !this.isBodyVisible()) {\n' +
       '            this.kdInputStale = true;\n' +
       '        }\n' +
       '        if (!this.tree || !this.isBodyVisible()'],
      ['    async setTreeInput() {\n        if (!this.isBodyVisible()) {\n',
       '    async setTreeInput() {\n        if (!this.isBodyVisible()) {\n            this.kdInputStale = true;\n'],
      // (the file of the editor opened or switched to is selected in the tree after the next frame: the editor is drawn
      // first - the tree's reveal, focus and selection came before it, 25-35 ms)
      ['        this._register(this.editorService.onDidActiveEditorChange(() => {\n            this.selectActiveFile();\n        }));\n',
       '        this._register(this.editorService.onDidActiveEditorChange(() => {\n' +
       '            if (this.kdSelectWaits) {\n                return;\n            }\n' +
       '            this.kdSelectWaits = true;\n' +
       '            requestAnimationFrame(() => setTimeout(() => {\n' +
       '                this.kdSelectWaits = false;\n' +
       '                this.selectActiveFile().catch(() => undefined);\n' +
       '            }, 0));\n' +
       '        }));\n']]]
  ])
}

// Typed arrays made from an array - line tokens, ~500 of them in 18 typed keys, the auto-indent check of every key
// among them: core-js wraps the iOS 6 engine's constructors, and from an array-like its wrapper checks the constructor
// with Function.prototype.toString, 1-3 ms each on the iPad 2 (~10 ms of a key in the profiler). `new XArray(...)` in
// VS Code's modules becomes vsc-prelude's __kdTypedArray(XArray, ...), which makes them from a length (handed straight
// to the engine) and fills them. (A worker has no prelude: there the module's stand-in constructs as before.)
function plainTypedArrays() {
  const find = /\bnew (Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float32|Float64)Array\((?!\s*\))/g
  const head = 'const __kdTA = typeof self !== "undefined" && self.__kdTypedArray || function (C, a, b, c) {\n' +
    '    return arguments.length > 3 ? new C(a, b, c) : arguments.length > 2 ? new C(a, b) : arguments.length > 1 ? new C(a) : new C();\n' +
    '};\n'
  let count = 0
  return {
    name: 'kodium-plain-typed-arrays',
    transform(code, id) {
      const p = id.replace(/\\/g, '/').replace(/\?.*$/, '')
      if (!/\.m?js$/.test(p) || !p.includes('/node_modules/@codingame/')) return null
      find.lastIndex = 0
      if (!find.test(code)) return null
      find.lastIndex = 0
      const body = code.replace(find, (m, kind) => { count++; return '__kdTA(' + kind + 'Array, ' })
      // (a module's own constant, before its imports - which are hoisted anyway)
      return { code: head + body, map: null }
    },
    buildEnd() {
      if (count) console.log('kodium-plain-typed-arrays: ' + count + ' typed arrays')
    }
  }
}

// Drop-downs as the iPad's own <select>, as VS Code has them on a Mac (and in the Settings editor on an iPad with pointer
// events): its drawn one is a List widget with a <style> element of its own, made again whenever a view's toolbar is -
// the Output's channel picker at every opening of the panel - and every new <style> made the old WebKit rebuild its
// rule sets from all of the page's 5000 rules. The system's picker is the touch one, too.
function nativeSelects() {
  return patchModules('kodium-native-selects', [
    ['/vs/base/browser/ui/selectBox/selectBox.js', [
      ['        if (isMacintosh && !selectBoxOptions?.useCustomDrawn) {', '        if (true) {']]]
  ])
}

// classList.value is newer than the iOS 6 engine (nor does its polyfill have it): VS Code's "classList.value = ''" before
// adding a label's classes was only an expando there, so a recycled row's icon label kept the classes of every file it
// had shown (the command palette's rows had a CSS file's icon classes after Go to File, the explorer's rows the file
// icons of other files - whichever rule came last won) and the lists grew longer with each. The class attribute set at
// once instead, and the label's container only when it changes (an attribute written again restyles its subtree in
// the old WebKit, the same value or not). (vsc-prelude has a value property for the rest.)
function oldTokenLists() {
  return patchModules('kodium-old-token-lists', [
    ['/vs/base/browser/ui/iconLabel/iconLabel.js', [
      ['        this._element.classList.value = "";\n        this._element.classList.add(...classNames);\n',
       '        this._element.className = classNames.join(" ");\n'],
      ['        this.labelContainer.classList.value = "";\n        this.labelContainer.classList.add(...containerClasses);\n',
       '        const kdContainerClasses = containerClasses.join(" ");\n' +
       '        if (this.labelContainer.className !== kdContainerClasses) {\n            this.labelContainer.className = kdContainerClasses;\n        }\n']]],
    ['/vs/base/browser/ui/button/button.js', [
      ['        this._iconElement.classList.value = "";\n        this._iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));\n',
       '        this._iconElement.className = ThemeIcon.asClassNameArray(icon).join(" ");\n']]]
  ])
}

// A list's rows written only where something changed. The old WebKit restyles an element's whole subtree for an
// attribute or inline style written again with the same value, and a list writes nine of them per row at every render
// of it: the suggestions' list renders all its rows again at every key typed while it is open (the same items at the
// same places, only the matched letters differ), and its renderer set eleven font styles per row each time.
function fewerRowWrites() {
  const updateItem =
    '    updateItemInDOM(item, index) {\n' +
    '        item.row.domNode.style.top = `${this.elementTop(index)}px`;\n' +
    '        if (this.setRowHeight) {\n' +
    '            item.row.domNode.style.height = `${item.size}px`;\n' +
    '        }\n' +
    '        if (this.setRowLineHeight) {\n' +
    '            item.row.domNode.style.lineHeight = `${item.size}px`;\n' +
    '        }\n' +
    '        item.row.domNode.setAttribute("data-index", `${index}`);\n' +
    '        item.row.domNode.setAttribute("data-last-element", index === this.length - 1 ? "true" : "false");\n' +
    '        item.row.domNode.setAttribute("data-parity", index % 2 === 0 ? "even" : "odd");\n' +
    '        item.row.domNode.setAttribute(\n' +
    '            "aria-setsize",\n' +
    '            String(this.accessibilityProvider.getSetSize(item.element, index, this.length))\n' +
    '        );\n' +
    '        item.row.domNode.setAttribute(\n' +
    '            "aria-posinset",\n' +
    '            String(this.accessibilityProvider.getPosInSet(item.element, index))\n' +
    '        );\n' +
    '        item.row.domNode.setAttribute("id", this.getElementDomId(index));\n' +
    '        item.row.domNode.classList.toggle("drop-target", item.dropTarget);\n' +
    '    }\n'
  return patchModules('kodium-fewer-row-writes', [
    ['/vs/base/browser/ui/list/listView.js', [
      ['const DefaultOptions = {',
       'function kdSetAttribute(node, name, value) {\n' +
       '    if (node.getAttribute(name) !== value) {\n        node.setAttribute(name, value);\n    }\n' +
       '}\n' +
       'function kdSetStyle(style, name, value) {\n' +
       '    if (style[name] !== value) {\n        style[name] = value;\n    }\n' +
       '}\n' +
       'const DefaultOptions = {'],
      ['        item.row.domNode.setAttribute("role", role);\n', '        kdSetAttribute(item.row.domNode, "role", role);\n'],
      ['        item.row.domNode.draggable = !!uri;\n',
       '        if (item.row.domNode.draggable !== !!uri) {\n            item.row.domNode.draggable = !!uri;\n        }\n'],
      [updateItem,
       '    updateItemInDOM(item, index) {\n' +
       '        const kdNode = item.row.domNode;\n' +
       '        kdSetStyle(kdNode.style, "top", `${this.elementTop(index)}px`);\n' +
       '        if (this.setRowHeight) {\n            kdSetStyle(kdNode.style, "height", `${item.size}px`);\n        }\n' +
       '        if (this.setRowLineHeight) {\n            kdSetStyle(kdNode.style, "lineHeight", `${item.size}px`);\n        }\n' +
       '        kdSetAttribute(kdNode, "data-index", `${index}`);\n' +
       '        kdSetAttribute(kdNode, "data-last-element", index === this.length - 1 ? "true" : "false");\n' +
       '        kdSetAttribute(kdNode, "data-parity", index % 2 === 0 ? "even" : "odd");\n' +
       '        kdSetAttribute(kdNode, "aria-setsize", String(this.accessibilityProvider.getSetSize(item.element, index, this.length)));\n' +
       '        kdSetAttribute(kdNode, "aria-posinset", String(this.accessibilityProvider.getPosInSet(item.element, index)));\n' +
       '        kdSetAttribute(kdNode, "id", this.getElementDomId(index));\n' +
       '        if (kdNode.classList.contains("drop-target") !== !!item.dropTarget) {\n' +
       '            kdNode.classList.toggle("drop-target", !!item.dropTarget);\n' +
       '        }\n' +
       '    }\n']]],
    // (and a label looked for its icon path node - which only this method makes - with querySelector at every
    // render, a list's row's label at every row drawn: now only when it may have one)
    ['/vs/base/browser/ui/iconLabel/iconLabel.js', [
      ['        this.domNode.element.setAttribute("aria-label", ariaLabel);\n',
       '        if (this.domNode.element.getAttribute("aria-label") !== ariaLabel) {\n' +
       '            this.domNode.element.setAttribute("aria-label", ariaLabel);\n' +
       '        }\n'],
      ['        const existingIconNode = this.domNode.element.querySelector(".monaco-icon-label-iconpath");\n',
       '        const existingIconNode = options?.iconPath || this.kdIconPath ? this.domNode.element.querySelector(".monaco-icon-label-iconpath") : null;\n' +
       '        this.kdIconPath = !!options?.iconPath;\n']]],
    // (a label's matched letters - the suggestions', the palette's, quick open's at every key - into the text and the
    // highlight spans it has: they were all taken out and made again, each element attached and styled anew)
    ['/vs/base/browser/ui/highlightedlabel/highlightedLabel.js', [
      ['        reset(this.domNode, ...children);\n', '        kdMorphChildren(this.domNode, children);\n'],
      ['class HighlightedLabel extends Disposable {',
       'function kdOnlyText(el) {\n' +
       '    const first = el.firstChild;\n' +
       '    return first && first === el.lastChild && first.nodeType === 3 ? first.nodeValue : null;\n' +
       '}\n' +
       'function kdMorphChildren(parent, children) {\n' +
       '    let node = parent.firstChild, i = 0;\n' +
       '    for (; i < children.length && node; i++) {\n' +
       '        const want = children[i];\n' +
       '        if (typeof want === "string") {\n' +
       '            if (node.nodeType !== 3) {\n                break;\n            }\n' +
       '            if (node.nodeValue !== want) {\n                node.nodeValue = want;\n            }\n' +
       '        } else {\n' +
       '            const text = node.nodeType === 1 && node.tagName === want.tagName && node.className === want.className && kdOnlyText(node) !== null ? kdOnlyText(want) : null;\n' +
       '            if (text === null) {\n                break;\n            }\n' +
       '            if (node.firstChild.nodeValue !== text) {\n                node.firstChild.nodeValue = text;\n            }\n' +
       '        }\n' +
       '        node = node.nextSibling;\n' +
       '    }\n' +
       '    while (node) {\n        const next = node.nextSibling;\n        parent.removeChild(node);\n        node = next;\n    }\n' +
       '    for (; i < children.length; i++) {\n' +
       '        const child = children[i];\n' +
       '        parent.appendChild(typeof child === "string" ? parent.ownerDocument.createTextNode(child) : child);\n' +
       '    }\n' +
       '}\n' +
       'class HighlightedLabel extends Disposable {']]],
    // (a file's backup - the whole text encoded and written to the backup store - 1 s after every pause in typing,
    // though Kodium's auto save writes the file itself 5 s after one: now 1 s before the auto save. Untitled files and
    // files the auto save leaves alone keep theirs at 1 s; what a crash could lose is the last 4 s of typing)
    ['/vs/workbench/services/workingCopy/common/workingCopyBackupTracker.js', [
      ['            backupScheduleDelay = this.filesConfigurationService.hasShortAutoSaveDelay(workingCopy.resource) ? "delayed" : "default";\n        }\n',
       '            backupScheduleDelay = this.filesConfigurationService.hasShortAutoSaveDelay(workingCopy.resource) ? "delayed" : "default";\n' +
       '            const kdAuto = this.filesConfigurationService.getAutoSaveConfiguration(workingCopy.resource);\n' +
       '            if (backupScheduleDelay === "default" && kdAuto.autoSave === "afterDelay" && kdAuto.autoSaveDelay > 2000 && !kdAuto.isOutOfWorkspace && !kdAuto.autoSaveWhenNoErrors) {\n' +
       '                return kdAuto.autoSaveDelay - 1000;\n' +
       '            }\n' +
       '        }\n']]],
    // (the focused suggestion's row drawn again once the item is resolved - for nothing when its provider has no
    // resolving to do, as the words of the document)
    ['/vs/editor/contrib/suggest/browser/suggestWidget.js', [
      ['                this._ignoreFocusEvents = true;\n                this._list.splice(index, 1, [item]);\n                this._list.setFocus([index]);\n                this._ignoreFocusEvents = false;\n',
       '                if (typeof item.provider.resolveCompletionItem === "function") {\n' +
       '                    this._ignoreFocusEvents = true;\n                    this._list.splice(index, 1, [item]);\n                    this._list.setFocus([index]);\n                    this._ignoreFocusEvents = false;\n' +
       '                }\n']]],
    ['/vs/editor/contrib/suggest/browser/suggestWidgetRenderer.js', [
      ['            const letterSpacingPx = `${letterSpacing}px`;\n',
       '            const letterSpacingPx = `${letterSpacing}px`;\n' +
       '            const kdFont = [fontSizePx, fontWeight, letterSpacingPx, fontFamily, fontFeatureSettings, fontVariationSettings, lineHeightPx].join("|");\n' +
       '            if (root.kdFont === kdFont) {\n                return;\n            }\n' +
       '            root.kdFont = kdFont;\n'],
      ['        data.colorspan.style.backgroundColor = "";\n',
       '        if (data.colorspan.style.backgroundColor) {\n            data.colorspan.style.backgroundColor = "";\n        }\n'],
      ['            data.icon.className = "icon hide";\n' +
       '            data.iconContainer.className = "";\n' +
       '            data.iconContainer.classList.add(\n' +
       '                "suggest-icon",\n' +
       '                ...ThemeIcon.asClassNameArray(CompletionItemKinds.toIcon(completion.kind))\n' +
       '            );\n',
       '            if (data.icon.className !== "icon hide") {\n                data.icon.className = "icon hide";\n            }\n' +
       '            const kdIconClasses = ["suggest-icon", ...ThemeIcon.asClassNameArray(CompletionItemKinds.toIcon(completion.kind))].join(" ");\n' +
       '            if (data.iconContainer.className !== kdIconClasses) {\n                data.iconContainer.className = kdIconClasses;\n            }\n'],
      ['            data.parametersLabel.textContent = "";\n' +
       '            data.detailsLabel.textContent = stripNewLines(completion.detail || "");\n',
       '            kdText(data.parametersLabel, "");\n' +
       '            kdText(data.detailsLabel, stripNewLines(completion.detail || ""));\n'],
      ['            data.parametersLabel.textContent = stripNewLines(completion.label.detail || "");\n' +
       '            data.detailsLabel.textContent = stripNewLines(completion.label.description || "");\n',
       '            kdText(data.parametersLabel, stripNewLines(completion.label.detail || ""));\n' +
       '            kdText(data.detailsLabel, stripNewLines(completion.label.description || ""));\n'],
      ['        if (this._editor.getOption(EditorOption.suggest).showInlineDetails) {\n' +
       '            show(data.detailsLabel);\n' +
       '        } else {\n' +
       '            hide(data.detailsLabel);\n' +
       '        }\n',
       '        kdDisplay(data.detailsLabel, this._editor.getOption(EditorOption.suggest).showInlineDetails ? "" : "none");\n'],
      ['            data.right.classList.remove("can-expand-details");\n' +
       '            hide(data.readMore);\n' +
       '            data.readMore.onmousedown = null;\n' +
       '            data.readMore.onclick = null;\n',
       '            if (data.right.classList.contains("can-expand-details")) {\n                data.right.classList.remove("can-expand-details");\n            }\n' +
       '            kdDisplay(data.readMore, "none");\n' +
       '            if (data.readMore.onmousedown) {\n                data.readMore.onmousedown = null;\n            }\n' +
       '            if (data.readMore.onclick) {\n                data.readMore.onclick = null;\n            }\n'],
      ['function stripNewLines(str) {',
       'function kdText(node, text) {\n' +
       '    if (node.textContent !== text) {\n        node.textContent = text;\n    }\n' +
       '}\n' +
       // (show() and hide() as in dom.js, aria-hidden too)
       'function kdDisplay(node, display) {\n' +
       '    if (node.style.display !== display) {\n' +
       '        node.style.display = display;\n' +
       '        if (display) {\n            node.setAttribute("aria-hidden", "true");\n        } else {\n            node.removeAttribute("aria-hidden");\n        }\n' +
       '    }\n' +
       '}\n' +
       'function stripNewLines(str) {']]]
  ])
}

// Keys typed in a row while the suggestions are open: each key's new list was drawn in that key's own frame - its rows,
// the widget's layout and two forced layouts of the page, 300-350 ms of the ~420 a key took to show on the iPad 2
// (against ~95 without the list). A key that comes less than 300 ms after the previous one now leaves the list as it
// is, and the list is drawn once the typing pauses for 300 ms; a key after a longer pause has its character drawn
// first and the list right after that frame. Whatever reads the list - accepting (Enter, Tab), moving in it, the
// details, a commit character of an item that has them - draws the waiting list first, so that it acts on the right
// item; hiding the list drops it.
function suggestPause() {
  const flushFirst = (method) => ['    ' + method + ' {\n', '    ' + method + ' {\n        this.kdFlush();\n']
  return patchModules('kodium-suggest-pause', [
    ['/vs/editor/contrib/suggest/browser/suggestWidget.js', [
      ['    showSuggestions(completionModel, selectionIndex, isFrozen, isAuto, noFocus) {\n        this._contentWidget.setPosition(this.editor.getPosition());\n',
       '    showSuggestions(completionModel, selectionIndex, isFrozen, isAuto, noFocus) {\n' +
       // (a list that came empty is not kept waiting: it closes the widget, and an Enter meanwhile has to be a new line)
       '        const kdNow = Date.now(), kdInARow = kdNow - (this.kdLastShow || 0) < 300;\n' +
       '        if (!this.kdFlushing) {\n            this.kdLastShow = kdNow;\n        }\n' +
       '        if (!this.kdFlushing && !isFrozen && this._state === State.Open && this._completionModel && completionModel.items.length > 0) {\n' +
       '            const kdPending = this.kdPending = [completionModel, selectionIndex, isFrozen, isAuto, noFocus];\n' +
       '            self.__kdSuggestWaiting = this;\n' +
       '            clearTimeout(this.kdPendingTimer);\n' +
       '            if (kdInARow) {\n                this.kdPendingTimer = setTimeout(() => this.kdFlush(), 300);\n            }\n' +
       '            else {\n' +
       '                requestAnimationFrame(() => {\n' +
       '                    if (this.kdPending === kdPending) {\n                        this.kdPendingTimer = setTimeout(() => this.kdFlush(), 20);\n                    }\n' +
       '                });\n' +
       '            }\n' +
       '            return;\n' +
       '        }\n' +
       '        this.kdDrop();\n' +
       '        this._contentWidget.setPosition(this.editor.getPosition());\n'],
      ['    focusSelected() {\n',
       '    kdFlush() {\n' +
       '        const pending = this.kdPending;\n' +
       '        this.kdDrop();\n' +
       '        if (pending && this._state !== State.Hidden) {\n' +
       '            this.kdFlushing = true;\n' +
       '            try {\n                this.showSuggestions(...pending);\n            } finally {\n                this.kdFlushing = false;\n            }\n' +
       '        }\n' +
       '    }\n' +
       '    kdDrop() {\n' +
       '        clearTimeout(this.kdPendingTimer);\n' +
       '        this.kdPendingTimer = undefined;\n' +
       '        this.kdPending = undefined;\n' +
       '        if (self.__kdSuggestWaiting === this) {\n            self.__kdSuggestWaiting = undefined;\n        }\n' +
       '    }\n' +
       '    kdFlushIfCommitCharacters() {\n' +
       '        const pending = this.kdPending;\n' +
       '        if (!pending) {\n            return;\n        }\n' +
       '        const model = pending[0];\n' +
       '        if (model.kdCommits === undefined) {\n' +
       '            model.kdCommits = model.items.some(item => !!(item.completion.commitCharacters && item.completion.commitCharacters.length));\n' +
       '        }\n' +
       '        if (model.kdCommits) {\n            this.kdFlush();\n        }\n' +
       '    }\n' +
       '    focusSelected() {\n        this.kdFlush();\n'],
      flushFirst('selectNextPage()'),
      flushFirst('selectNext()'),
      flushFirst('selectLast()'),
      flushFirst('selectPreviousPage()'),
      flushFirst('selectPrevious()'),
      flushFirst('selectFirst()'),
      flushFirst('getFocusedItem()'),
      flushFirst('toggleDetailsFocus()'),
      flushFirst('toggleDetails(focused = false)'),
      flushFirst('toggleExplainMode()'),
      ['    hideWidget() {\n', '    hideWidget() {\n        this.kdDrop();\n'],
      ['    showTriggered(auto, delay) {\n', '    showTriggered(auto, delay) {\n        this.kdDrop();\n'],
      // (the list asks every item's height at every new list - ~100 at a key -, and each answer made the widget's whole
      // layout: options, the details' borders, a Dimension; 20 ms a key on the iPad 2. The item's height alone now)
      ['            getHeight: _element => this.getLayoutInfo().itemHeight,\n',
       '            getHeight: _element => clamp(this.editor.getOption(EditorOption.suggestLineHeight) || this.editor.getOption(EditorOption.fontInfo).lineHeight, 8, 1000),\n'],
      // (a key that the keybindings may give to the list - Enter, Tab, the arrows, Page Up/Down - draws the waiting
      // list before they are looked up: its context keys, "makes a text edit" for Enter, are the new list's then)
      ['export { SuggestContentWidget, SuggestWidget, editorSuggestWidgetFocusOutline,',
       'if (typeof document !== "undefined") {\n' +
       '    document.addEventListener("keydown", e => {\n' +
       '        const k = e.keyCode;\n' +
       '        if (self.__kdSuggestWaiting && (k === 9 || k === 13 || k === 33 || k === 34 || k === 38 || k === 40)) {\n' +
       '            self.__kdSuggestWaiting.kdFlush();\n' +
       '        }\n' +
       '    }, true);\n' +
       '}\n' +
       'export { SuggestContentWidget, SuggestWidget, editorSuggestWidgetFocusOutline,']]],
    ['/vs/editor/contrib/suggest/browser/suggestCommitCharacters.js', [
      ['        this._disposables.add(editor.onWillType(text => {\n',
       '        this._disposables.add(editor.onWillType(text => {\n            widget.kdFlushIfCommitCharacters?.();\n']]]
  ])
}

// The start: Kodium registers monaco's 31 Monarch languages one by one (src/languages.ts), and every registration had
// the languages' registry made again from all languages so far and the settings' schema told of all of them as
// override identifiers - 651 language merges and 31 schema updates (0.9 s of a profiled start). Registered together
// now, with one change event (ModesRegistry.kdRegisterLanguages).
// And what the workbench does in the first seconds after it appears (VS Code's own log on the iPad 2: contributions of
// 100-200 ms each): the settings' migrations inspected all ~100 old keys at every start, though the settings had none
// of them - only the keys the settings have (all, with a language section in them); the sash sizes went into a <style>
// of CSS variables, which the iOS 6 engine does not have - only a full rebuild of its rule sets (the sizes still reach
// the sashes, in code); the schema of the paste/drop kinds (settings' suggestions) is left out.
// (and localize() - thousands of calls at a start, every label - made the array of its format arguments from the
// function's arguments object even when there were none: the old engine builds the whole arguments object for that,
// 5 µs a call on the iPad 2 against 0.2 for reading arguments.length)
function quickerStart() {
  return patchModules('kodium-quicker-start', [
    ['/vscode/src/vs/nls.js', [
      ['function localize(data , message , ...args) {\n',
       'const kdNoArgs = [];\nfunction localize(data , message) {\n    const args = arguments.length > 2 ? Array.prototype.slice.call(arguments, 2) : kdNoArgs;\n'],
      ['function localize2(data , originalMessage, ...args) {\n',
       'function localize2(data , originalMessage) {\n    const args = arguments.length > 2 ? Array.prototype.slice.call(arguments, 2) : kdNoArgs;\n']]],
    ['/vs/workbench/common/configuration.js', [
      ['    async migrateConfigurations(migrations) {\n',
       '    async migrateConfigurations(migrations) {\n' +
       '        try {\n' +
       '            const k = this.configurationService.keys();\n' +
       '            const present = [...(k.user || []), ...(k.workspace || []), ...(k.workspaceFolder || []), ...(k.memory || [])];\n' +
       '            if (!present.some((key) => key.startsWith("["))) {\n' +
       '                migrations = migrations.filter((m) => present.some((key) => key === m.key || m.key.startsWith(key + ".")));\n' +
       '            }\n' +
       '        } catch (e) {}\n' +
       '        if (!migrations.length) return;\n']]],
    ['/vs/workbench/contrib/sash/browser/sash.js', [
      ['        this.styleSheet = createStyleSheet();', '        this.styleSheet = { textContent: "" };']]],
    // (the icons' stylesheet, 950 icons: each also got two CSS variables in one :root rule of 1900 declarations, which
    // the iOS 6 engine parses and drops - not made; and the CSS helpers it calls 8000 times without reduce and spread)
    ['/vs/platform/theme/browser/iconsStyleSheet.js', [
      ['                const fontFamilyVar = inline`--vscode-icon-${className(contribution.id)}-font-family`;\n' +
       '                const contentVar = inline`--vscode-icon-${className(contribution.id)}-content`;\n', ''],
      ['                    rootAttribs.push(\n                        inline`${fontFamilyVar}: ${stringValue(fontContribution.id)};`,\n' +
       '                        inline`${contentVar}: ${stringValue(definition.fontCharacter)};`\n                    );\n', ''],
      ["                    rootAttribs.push(\n                        inline`${contentVar}: ${stringValue(definition.fontCharacter)}; ${fontFamilyVar}: 'codicon';`\n                    );\n", ''],
      ['            rules.push(inline`:root, :host { ${rootAttribs.join(" ")} }`);\n', '']]],
    // (every <style> VS Code writes goes through the engine's CSS rewriter, a big one by a synchronous request to the
    // app - the icons' 50 KB and the file icons' 95 KB after every start. Kodium's own icons and Seti's file icons have
    // nothing the rewriter changes (it compacts the white space, and makes Seti's "unset" "initial"): marked as
    // rewritten (/*br*/), which the engine's shim leaves alone; another icon theme still goes through it)
    // (and a stylesheet given the text it already has is not given it again: the old WebKit made a new one of it all the
    // same, with its rule sets rebuilt; the text given last is kept, as the engine's rewriter may have changed the one
    // in the page)
    // (the color theme: restored at the start from the last one's storage, it was taken up again once its extension
    // was registered - the same theme, read from its files - and put in place as a new one: its 100 KB of rules made
    // again from the 300 theming participants and every listener told (Kodium's token colours, its theme variables,
    // the colours' schema, the status bar...): 1.4 s of a profiled start. Now when what it would store is what the
    // restored one was stored as, the loaded theme only takes the restored one's place)
    ['/vs/workbench/services/themes/browser/workbenchThemeService.js', [
      ['            codiconStyleSheet.textContent = iconsStyleSheet.getCSS();',
       '            const css = iconsStyleSheet.getCSS();\n' +
       '            const text = css.indexOf("@font-face") < 0 && css.indexOf("var(") < 0 ? "/*br*/" + css : css;\n' +
       '            if (codiconStyleSheet.kdText !== text) {\n' +
       '                codiconStyleSheet.kdText = text;\n' +
       '                codiconStyleSheet.textContent = text;\n' +
       '            }'],
      ['function _applyRules(styleSheetContent, rulesClassName) {\n',
       'const kdAppliedRules = {};\n' +
       'function _applyRules(styleSheetContent, rulesClassName) {\n' +
       '    if (rulesClassName === "contributedFileIconTheme" && styleSheetContent.indexOf("seti") >= 0 &&\n' +
       '        !/var\\(|calc\\(|@supports|@container|:has\\(|:is\\(|:where\\(|display\\s*:\\s*(inline-)?(flex|grid)|clamp\\(|color-mix\\(/.test(styleSheetContent)) {\n' +
       '        styleSheetContent = "/*br*/" + styleSheetContent.replace(/:\\s*unset\\b/g, ": initial");\n' +
       '    }\n'],
      ['        elStyle.textContent = styleSheetContent;\n    } else {\n        themeStyles[0].textContent = styleSheetContent;\n    }\n',
       '        elStyle.textContent = styleSheetContent;\n        kdAppliedRules[rulesClassName] = styleSheetContent;\n' +
       '    } else if (kdAppliedRules[rulesClassName] !== styleSheetContent) {\n' +
       '        themeStyles[0].textContent = styleSheetContent;\n        kdAppliedRules[rulesClassName] = styleSheetContent;\n    }\n'],
      ['        let themeData = ColorThemeData.fromStorageData(this.storageService);\n',
       '        let themeData = ColorThemeData.fromStorageData(this.storageService);\n        const kdStored = themeData;\n'],
      ['        themeData.setCustomizations(this.settings);\n        this.applyTheme(themeData, undefined, true);\n',
       '        themeData.setCustomizations(this.settings);\n        this.applyTheme(themeData, undefined, true);\n' +
       '        if (themeData === kdStored) {\n' +
       '            this.kdRestoredColorTheme = themeData;\n' +
       '            this.kdRestoredColorThemeJSON = this.storageService.get(ColorThemeData.STORAGE_KEY, StorageScope.PROFILE);\n' +
       '        }\n'],
      ['    async internalSetColorTheme(themeIdOrTheme, settingsTarget) {\n',
       '    kdSwapIfSameAsRestored(themeData) {\n' +
       '        const restored = this.kdRestoredColorTheme;\n' +
       '        if (!restored || this.currentColorTheme !== restored || themeData === restored || themeData.id !== restored.id) {\n' +
       '            return false;\n' +
       '        }\n' +
       '        this.kdRestoredColorTheme = undefined;\n' +
       '        let json;\n' +
       '        try {\n' +
       '            themeData.toStorage({ store: (key, value) => { json = value; } });\n' +
       '        } catch (e) {\n' +
       '            return false;\n' +
       '        }\n' +
       '        if (json === undefined || json !== this.kdRestoredColorThemeJSON) {\n' +
       '            return false;\n' +
       '        }\n' +
       '        this.currentColorTheme = themeData;\n' +
       '        this.colorThemeWatcher.update(themeData);\n' +
       '        getColorRegistry().notifyThemeUpdate(themeData);\n' +
       '        return true;\n' +
       '    }\n' +
       '    async internalSetColorTheme(themeIdOrTheme, settingsTarget) {\n'],
      ['            await themeData.ensureLoaded(this.extensionResourceLoaderService);\n' +
       '            themeData.setCustomizations(this.settings);\n' +
       '            return this.applyTheme(themeData, settingsTarget);\n',
       '            await themeData.ensureLoaded(this.extensionResourceLoaderService);\n' +
       '            themeData.setCustomizations(this.settings);\n' +
       '            if (this.kdSwapIfSameAsRestored(themeData)) {\n' +
       '                return this.settings.setColorTheme(this.currentColorTheme, settingsTarget);\n' +
       '            }\n' +
       '            return this.applyTheme(themeData, settingsTarget);\n'],
      ['                    await theme.ensureLoaded(this.extensionResourceLoaderService);\n' +
       '                    theme.setCustomizations(this.settings);\n' +
       '                    await this.applyTheme(theme, undefined, true);\n',
       '                    await theme.ensureLoaded(this.extensionResourceLoaderService);\n' +
       '                    theme.setCustomizations(this.settings);\n' +
       '                    if (!this.kdSwapIfSameAsRestored(theme)) {\n' +
       '                        await this.applyTheme(theme, undefined, true);\n' +
       '                    }\n'],
      // (the file icon theme: VS Code took it up again at every change of the languages - Kodium's, then the extensions' -
      // and when the theme's extension was registered, though it had just taken it up: read again, all of Seti's
      // 1500 selectors made again, the stylesheet given its same text and every view told to draw its icons again.
      // The loader keeps what it made of a theme for as long as the languages' own icons stay the same; a reload that
      // changes nothing changes nothing, and the restored theme (the last start's) changed for the same one is no news)
      ['            await this.currentFileIconTheme.reload(this.fileIconThemeLoader);\n' +
       '            this.applyAndSetFileIconTheme(this.currentFileIconTheme);\n',
       '            const kdTheme = this.currentFileIconTheme;\n' +
       '            const kdWas = kdTheme.isLoaded ? [kdTheme.styleSheetContent, kdTheme.hasFileIcons, kdTheme.hasFolderIcons, kdTheme.hidesExplorerArrows] : undefined;\n' +
       '            await this.currentFileIconTheme.reload(this.fileIconThemeLoader);\n' +
       '            if (kdWas && kdTheme === this.currentFileIconTheme && kdWas[0] === kdTheme.styleSheetContent && kdWas[1] === kdTheme.hasFileIcons &&\n' +
       '                kdWas[2] === kdTheme.hasFolderIcons && kdWas[3] === kdTheme.hidesExplorerArrows) {\n' +
       '                return;\n' +
       '            }\n' +
       '            this.applyAndSetFileIconTheme(this.currentFileIconTheme);\n'],
      ['    applyAndSetFileIconTheme(iconThemeData, silent = false) {\n        this.currentFileIconTheme = iconThemeData;\n',
       '    applyAndSetFileIconTheme(iconThemeData, silent = false) {\n' +
       '        const kdPrev = this.currentFileIconTheme;\n' +
       '        if (kdPrev && kdPrev !== iconThemeData && kdPrev.id === iconThemeData.id && kdPrev.styleSheetContent === iconThemeData.styleSheetContent &&\n' +
       '            kdPrev.hasFileIcons === iconThemeData.hasFileIcons && kdPrev.hasFolderIcons === iconThemeData.hasFolderIcons &&\n' +
       '            kdPrev.hidesExplorerArrows === iconThemeData.hidesExplorerArrows) {\n' +
       '            silent = true;\n' +
       '        }\n' +
       '        this.currentFileIconTheme = iconThemeData;\n'],
      // (the product icon theme likewise: the default one restored from storage, then the default one again - news
      // that had the icons' 50 KB stylesheet made again from the 950 icons)
      ['    applyAndSetProductIconTheme(iconThemeData, silent = false) {\n        this.currentProductIconTheme = iconThemeData;\n',
       '    kdSameStored(a, b) {\n' +
       '        if (!a || !b || a === b || a.id !== b.id) {\n' +
       '            return false;\n' +
       '        }\n' +
       '        let ja, jb;\n' +
       '        try {\n' +
       '            a.toStorage({ store: (key, value) => { ja = value; } });\n' +
       '            b.toStorage({ store: (key, value) => { jb = value; } });\n' +
       '        } catch (e) {\n' +
       '            return false;\n' +
       '        }\n' +
       '        return ja !== undefined && ja === jb;\n' +
       '    }\n' +
       '    applyAndSetProductIconTheme(iconThemeData, silent = false) {\n' +
       '        if (!silent && this.kdSameStored(this.currentProductIconTheme, iconThemeData)) {\n' +
       '            silent = true;\n' +
       '        }\n' +
       '        this.currentProductIconTheme = iconThemeData;\n']]],
    // (and what was made of the theme is stored with it, under a key of its file's place, its text's length and hash,
    // the languages' icons and the processing code: the next start takes it from there when they are the same, instead
    // of making Seti's 1500 selectors again - 0.65 s of a profile)
    ['/vs/workbench/services/themes/browser/fileIconThemeData.js', [
      ['                case "watch":\n                    theme[key] = data[key];\n',
       '                case "watch":\n                case "kdKey":\n                    theme[key] = data[key];\n'],
      ['            return theme;\n        } catch (e) {\n            return undefined;\n        }\n    }\n    toStorage(storageService) {\n',
       '            FileIconThemeData.kdStored = theme;\n' +
       '            return theme;\n        } catch (e) {\n            return undefined;\n        }\n    }\n    toStorage(storageService) {\n'],
      ['            watch: this.watch\n        });\n',
       '            watch: this.watch,\n            kdKey: this.kdKey\n        });\n'],
      ['    loadIconThemeDocument(location) {\n        return this.fileService.readExtensionResource(location).then(content => {\n',
       '    loadIconThemeDocument(location, kdContent) {\n' +
       '        return (kdContent !== undefined ? Promise.resolve(kdContent) : this.fileService.readExtensionResource(location)).then(content => {\n'],
      ['    load(data) {\n        if (!data.location) {\n            return Promise.resolve(data.styleSheetContent);\n        }\n' +
       '        return this.loadIconThemeDocument(data.location).then(iconThemeDocument => {\n' +
       '            const result = this.processIconThemeDocument(data.id, data.location, iconThemeDocument);\n',
       '    kdLanguageIcons() {\n' +
       '        let icons = "";\n' +
       '        for (const languageId of this.languageService.getRegisteredLanguageIds()) {\n' +
       '            const icon = this.languageService.getIcon(languageId);\n' +
       '            if (icon) icons += languageId + " " + icon.dark + " " + icon.light + "\\n";\n' +
       '        }\n' +
       '        return icons;\n' +
       '    }\n' +
       '    kdStoreKey(location, content) {\n' +
       '        let h = 0;\n' +
       '        for (let i = 0; i < content.length; i++) {\n' +
       '            h = ((h << 5) - h + content.charCodeAt(i)) | 0;\n' +
       '        }\n' +
       '        return location.toString() + "\\n" + content.length + ":" + h + ":" + String(this.processIconThemeDocument).length + "\\n" + this.kdLanguageIcons();\n' +
       '    }\n' +
       '    load(data) {\n        if (!data.location) {\n            return Promise.resolve(data.styleSheetContent);\n        }\n' +
       '        const kdDone = !data.watch && this.kdLast && this.kdLast.key === data.location.toString() + "\\n" + this.kdLanguageIcons() ? this.kdLast.result : undefined;\n' +
       '        if (kdDone) {\n' +
       '            data.styleSheetContent = kdDone.content;\n' +
       '            data.hasFileIcons = kdDone.hasFileIcons;\n' +
       '            data.hasFolderIcons = kdDone.hasFolderIcons;\n' +
       '            data.hidesExplorerArrows = kdDone.hidesExplorerArrows;\n' +
       '            data.isLoaded = true;\n' +
       '            return Promise.resolve(data.styleSheetContent);\n' +
       '        }\n' +
       '        let kdKey;\n' +
       '        return this.fileService.readExtensionResource(data.location).then(content => {\n' +
       '            kdKey = data.watch ? undefined : this.kdStoreKey(data.location, content);\n' +
       '            const stored = FileIconThemeData.kdStored;\n' +
       '            if (kdKey && stored && stored.id === data.id && stored.kdKey === kdKey && typeof stored.styleSheetContent === "string") {\n' +
       '                return { kdStored: { content: stored.styleSheetContent, hasFileIcons: !!stored.hasFileIcons, hasFolderIcons: !!stored.hasFolderIcons, hidesExplorerArrows: !!stored.hidesExplorerArrows } };\n' +
       '            }\n' +
       '            return this.loadIconThemeDocument(data.location, content);\n' +
       '        }).then(iconThemeDocument => {\n' +
       '            const result = iconThemeDocument.kdStored || this.processIconThemeDocument(data.id, data.location, iconThemeDocument);\n' +
       '            data.kdKey = kdKey;\n' +
       '            if (!data.watch) this.kdLast = { key: data.location.toString() + "\\n" + this.kdLanguageIcons(), result };\n']]],
    // (JSON with comments - themes, the Seti icon theme's 70 KB, the languages' configurations: 16 documents after every
    // start - went through VS Code's own scanner, character by character: the comments and trailing commas out by
    // regular expression and the engine's JSON.parse instead; whatever that cannot read, the scanner as before)
    ['/vs/base/common/json.js', [
      ['function parse(text, errors = [], options = ParseOptions.DEFAULT) {\n',
       'const kdNoFast = {};\n' +
       'function kdFastParse(text) {\n' +
       '    try {\n' +
       '        let clean = text.replace(/("(?:[^"\\\\]|\\\\.)*")|\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n\\r]*/g, (m, str) => str !== undefined ? str : "");\n' +
       '        clean = clean.replace(/("(?:[^"\\\\]|\\\\.)*")|,(\\s*[}\\]])/g, (m, str, close) => str !== undefined ? str : close);\n' +
       '        return /\\S/.test(clean) ? JSON.parse(clean) : kdNoFast;\n' +
       '    } catch (e) { return kdNoFast; }\n' +
       '}\n' +
       'function parse(text, errors = [], options = ParseOptions.DEFAULT) {\n' +
       '    if (typeof text === "string" && options && options.allowTrailingComma && !options.disallowComments) {\n' +
       '        const fast = kdFastParse(text);\n' +
       '        if (fast !== kdNoFast) return fast;\n' +
       '    }\n']]],
    ['/vs/base/browser/cssValue.js', [
      ['    return asFragment(strings.reduce((result, str, i) => {\n        const value = values[i] || "";\n        return result + str + value;\n    }, ""));',
       '    let result = "";\n    for (let i = 0; i < strings.length; i++) result += strings[i] + (values[i] || "");\n    return asFragment(result);'],
      ['        this._parts.push(...parts);', '        for (let i = 0; i < parts.length; i++) this._parts.push(parts[i]);']]],
    ['/vs/workbench/contrib/dropOrPasteInto/browser/dropOrPasteInto.contribution.js', [
      ['registerWorkbenchContribution2(\n    DropOrPasteSchemaContribution.ID,\n    DropOrPasteSchemaContribution,\n    WorkbenchPhase.Eventually\n);', '']]],
    // (the schema of keybindings.json - every command's id, title and arguments, 2600 commands: made again at every
    // start, at each contribution to it and once the extensions were registered, 0.7 s each in a profile, for a file
    // hardly ever opened. Marked out of date instead, and made when something reads it)
    ['/vs/workbench/services/keybinding/browser/keybindingService.js', [
      ['        this.kbsJsonSchema.updateSchema(this._contributions.flatMap(x => x.contribution.getSchemaAdditions()));',
       '        this.kbsJsonSchema.updateSchema(() => this._contributions.flatMap(x => x.contribution.getSchemaAdditions()));'],
      ['        this.schemaRegistry = ( Registry.as(Extensions.JSONContribution));\n' +
       '        this.schemaRegistry.registerSchema(KeybindingsJsonSchema.schemaId, this.schema);\n' +
       '    }\n' +
       '    updateSchema(additionalContributions) {\n',
       '        const kdDefinitions = this.schema.definitions;\n' +
       '        Object.defineProperty(this.schema, "definitions", {\n' +
       '            enumerable: true,\n' +
       '            configurable: true,\n' +
       '            get: () => {\n' +
       '                if (this.kdStale) {\n' +
       '                    this.kdStale = false;\n' +
       '                    const additions = this.kdAdditions;\n' +
       '                    this.kdUpdateSchema(typeof additions === "function" ? additions() : additions || []);\n' +
       '                }\n' +
       '                return kdDefinitions;\n' +
       '            }\n' +
       '        });\n' +
       '        this.schemaRegistry = ( Registry.as(Extensions.JSONContribution));\n' +
       '        this.schemaRegistry.registerSchema(KeybindingsJsonSchema.schemaId, this.schema);\n' +
       '    }\n' +
       '    updateSchema(additionalContributions) {\n' +
       '        this.kdAdditions = additionalContributions;\n' +
       '        if (!this.kdStale) {\n' +
       '            this.kdStale = true;\n' +
       '            this.schemaRegistry.notifySchemaChanged(KeybindingsJsonSchema.schemaId);\n' +
       '        }\n' +
       '    }\n' +
       '    kdUpdateSchema(additionalContributions) {\n'],
      ['        this.commandsSchemas.push(...additionalContributions);\n' +
       '        this.schemaRegistry.notifySchemaChanged(KeybindingsJsonSchema.schemaId);\n',
       '        this.commandsSchemas.push(...additionalContributions);\n']]],
    // (a context key per extension, "extensionEnabled:<id>", made one by one once the extensions were registered: each
    // a change of the context every menu and view checked its conditions against - together now, as one change)
    ['/vs/workbench/contrib/extensions/browser/extensionEnablementContext.js', [
      ['    _reconcile() {\n',
       '    _reconcile() {\n        this.contextKeyService.bufferChangeEvents(() => this.kdReconcile());\n    }\n    kdReconcile() {\n']]],
    // (the default settings were made again from all 1400 settings once the extensions were registered, and compared
    // with the ones before, key by key - to drop what the last start had cached of the defaults' overrides (Kodium's
    // own defaults, extensions'); when each of those is what the registry has now, or a setting it does not have (the
    // defaults hold only the registry's settings), that changes nothing: the cache is dropped without the rest)
    // (and the settings files' seven JSON schemas - each of the 1400 settings sorted into them by scope - were made after
    // the extensions were registered and again at every change of the settings' registry: 0.4 s each in a profile, for
    // settings.json's suggestions. Registered once as stand-ins whose fields make them all when first read)
    ['/vs/workbench/services/configuration/browser/configurationService.js', [
      ['        case ConfigurationTarget.DEFAULT:\n            this.reloadDefaultConfiguration();\n            return;\n',
       '        case ConfigurationTarget.DEFAULT:\n' +
       '            if (this.defaultConfiguration.kdReloadChangesNothing && this.defaultConfiguration.kdReloadChangesNothing()) {\n' +
       '                return;\n' +
       '            }\n' +
       '            this.reloadDefaultConfiguration();\n            return;\n'],
      ['    registerConfigurationSchemas() {\n        for (const key of ( Object.keys(allSettings.properties))) {\n',
       '    registerConfigurationSchemas() {\n' +
       '        this.kdBuilt = undefined;\n' +
       '        if (!this.kdStandIns) {\n' +
       '            this.kdStandIns = {};\n' +
       '            for (const name of ["defaultSettingsSchema", "userSettingsSchema", "profileSettingsSchema", "machineSettingsSchema",\n' +
       '                "workspaceSettingsSchema", "folderSettingsSchema", "configDefaultsSchema"]) {\n' +
       '                const standIn = {};\n' +
       '                for (const field of ["type", "description", "properties", "patternProperties", "additionalProperties",\n' +
       '                    "allowTrailingCommas", "allowComments"]) {\n' +
       '                    Object.defineProperty(standIn, field, {\n' +
       '                        enumerable: true,\n' +
       '                        configurable: true,\n' +
       '                        get: () => {\n' +
       '                            if (!this.kdBuilt) {\n' +
       '                                this.kdBuilt = this.kdBuildConfigurationSchemas();\n' +
       '                            }\n' +
       '                            return this.kdBuilt[name][field];\n' +
       '                        }\n' +
       '                    });\n' +
       '                }\n' +
       '                this.kdStandIns[name] = standIn;\n' +
       '            }\n' +
       '        }\n' +
       '        this.registerSchemas(this.kdStandIns);\n' +
       '    }\n' +
       '    kdBuildConfigurationSchemas() {\n' +
       '        for (const key of ( Object.keys(allSettings.properties))) {\n'],
      ['        this.registerSchemas({\n            defaultSettingsSchema,\n',
       '        return ({\n            defaultSettingsSchema,\n']]],
    ['/vs/workbench/services/configuration/browser/configuration.js', [
      ['    hasCachedConfigurationDefaultsOverrides() {\n',
       '    kdReloadChangesNothing() {\n' +
       '        const cached = this.cachedConfigurationDefaultsOverrides;\n' +
       '        const properties = this.configurationRegistry.getConfigurationProperties();\n' +
       '        for (const key of Object.keys(cached)) {\n' +
       '            const property = properties[key];\n' +
       '            if (property && !equals(property.default, cached[key])) {\n' +
       '                return false;\n' +
       '            }\n' +
       '        }\n' +
       '        this.cachedConfigurationDefaultsOverrides = {};\n' +
       '        this.updateCachedConfigurationDefaultsOverrides();\n' +
       '        return true;\n' +
       '    }\n' +
       '    hasCachedConfigurationDefaultsOverrides() {\n']]],
    ['/vs/editor/common/languages/modesRegistry.js', [
      ['        this._languages.push(def);\n        this._onDidChangeLanguages.fire(undefined);',
       '        this._languages.push(def);\n        if (!this.kdBatch) this._onDidChangeLanguages.fire(undefined);'],
      ['    getLanguages() {',
       '    kdRegisterLanguages(defs) {\n        this.kdBatch = true;\n        try { return defs.map((def) => this.registerLanguage(def)); }\n' +
       '        finally { this.kdBatch = false; this._onDidChangeLanguages.fire(undefined); }\n    }\n    getLanguages() {']]]
  ])
}

// Modules that came into the bundle for a constant, or for something the iPad never gets to (scratchpad graph analysis,
// what each module alone brings in): every one of them is parsed and run at each start, and kept in memory.
// - the diff editor's accessibility help asked the editor's (which nothing registers) whether comments are there: it
//   brought the comment editor, dictation, chat's speech-to-text and the inline completions' controller, views and
//   models (Copilot's ghost text, left out above) - 670 KB
// - the remote explorer and its port forwarding (120 KB) for the remote view's id, the ports' model for a three-value
//   enum; MCP's management service and configuration for "ws", "mcp" and another key; chat's language models for
//   "copilot" and an enum, chat hooks' schema for a converter of them; tasks for "settings"; chat's view model and
//   outline for Go to Symbol in a chat (there is none); the agents' Codex account menu
// - the editor's GPU rendering (an experimental setting; WebGPU), tree-sitter tokens (WebAssembly), the WebAssembly
//   and native diff computers (other settings; the default one stays), the multi-file diff editor of monaco's own API
// - the Windows and macOS keyboard layouts: on the iPad VS Code takes the platform for Linux, the only set it loads
// 1.8 MB of 24 MB before minifying, 216 modules; the lowered script 1 MB smaller (14.4 -> 13.4 MB).
function leanerBundle() {
  return patchModules('kodium-leaner-bundle', [
    ['/vs/workbench/contrib/codeEditor/browser/diffEditorAccessibilityHelp.js', [
      ["import { getCommentCommandInfo } from '../../accessibility/browser/editorAccessibilityHelp.js';",
       'const getCommentCommandInfo = () => undefined;']]],
    ['/vs/workbench/api/browser/viewsExtensionPoint.js', [
      ["import { VIEWLET_ID } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/remote/browser/remoteExplorer';",
       'const VIEWLET_ID = "workbench.view.remote";']]],
    ['/vs/workbench/contrib/mcp/common/mcpTypes.js', [
      ["import { WORKSPACE_FOLDER_CONFIG_ID_PREFIX } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';",
       'const WORKSPACE_FOLDER_CONFIG_ID_PREFIX = "ws";']]],
    ['/vs/workbench/api/common/extHostLanguageModels.js', [
      ["import { COPILOT_VENDOR_ID } from '../../contrib/chat/common/languageModels.js';", 'const COPILOT_VENDOR_ID = "copilot";']]],
    ['/vs/workbench/api/common/extHostTypeConverters.js', [
      ["import { ChatMessageRole } from '../../contrib/chat/common/languageModels.js';",
       'const ChatMessageRole = { System: 0, User: 1, Assistant: 2 };'],
      ["import { resolveEffectiveCommand } from '../../contrib/chat/common/promptSyntax/hookSchema.js';",
       'const resolveEffectiveCommand = () => undefined;']]],
    ['/@codingame/monaco-vscode-api/missing-services.js', [
      ["import { PortsEnablement } from './vscode/src/vs/workbench/services/remote/common/remoteExplorerService.js';",
       'const PortsEnablement = { Disabled: 0, ViewOnly: 1, AdditionalFeatures: 2 };']]],
    ['/vs/workbench/api/common/extHostTask.js', [
      ["import { USER_TASKS_GROUP_KEY } from '../../contrib/tasks/common/tasks.js';", 'const USER_TASKS_GROUP_KEY = "settings";']]],
    ['/vs/workbench/api/browser/mainThreadAuthentication.js', [
      ["import { mcpEnterpriseManagedAuthIdpSection } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/mcp/common/mcpConfiguration';",
       'const mcpEnterpriseManagedAuthIdpSection = "mcp.enterpriseManagedAuth.idp";']]],
    ['/vs/workbench/contrib/preferences/browser/preferencesRenderers.js', [
      ["import { mcpConfigurationSection } from '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/mcp/common/mcpConfiguration';",
       'const mcpConfigurationSection = "mcp";']]],
    ['/vs/workbench/contrib/codeEditor/browser/quickaccess/gotoSymbolQuickAccess.js', [
      ["import '../../../chat/browser/chat.js';", ''],
      ["import { isRequestVM } from '../../../chat/common/model/chatViewModel.js';", 'const isRequestVM = () => false;'],
      ["import { ChatOutline } from '../../../chat/browser/chatOutline.js';", 'const ChatOutline = undefined;']]],
    ['/vs/workbench/browser/parts/globalCompositeBar.js', [
      ["import { createCodexAccountMenuActions, shouldShowCodexAccount } from '../../services/agentHost/browser/codexAccountService.js';",
       'const createCodexAccountMenuActions = () => [], shouldShowCodexAccount = () => false;']]],
    ['/vs/editor/browser/view.js', [
      ["import { ViewGpuContext } from './gpu/viewGpuContext.js';", 'const ViewGpuContext = undefined;'],
      ["import { ViewLinesGpu } from './viewParts/viewLinesGpu/viewLinesGpu.js';", 'const ViewLinesGpu = undefined;'],
      ['if (this._context.configuration.options.get(EditorOption.experimentalGpuAcceleration) === "on") {', 'if (false) {']]],
    ['/vs/editor/common/model/tokens/tokenizationTextModelPart.js', [
      ["import { TreeSitterSyntaxTokenBackend } from './treeSitter/treeSitterSyntaxTokenBackend.js';", 'const TreeSitterSyntaxTokenBackend = undefined;'],
      ['if (this._useTreeSitter.read(reader)) {', 'if (this._useTreeSitter.read(reader) && TreeSitterSyntaxTokenBackend) {']]],
    ['/vs/editor/common/diff/linesDiffComputers.js', [
      ["import { getExternalLinesDiffComputer } from './externalLinesDiffComputer.js';",
       'const getExternalLinesDiffComputer = async () => new DefaultLinesDiffComputer();']]],
    ['/vs/editor/standalone/browser/standaloneEditor.js', [
      ["import { MultiDiffEditorWidget } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/widget/multiDiffEditor/multiDiffEditorWidget';",
       "class MultiDiffEditorWidget { constructor() { throw new Error('Kodium: no multi-file diff editor'); } }"]]],
    ['/vs/workbench/services/keybinding/browser/keyboardLayoutService.js', [
      ["return import('./keyboardLayouts/layout.contribution.darwin.js');", "return import('./keyboardLayouts/layout.contribution.linux.js');"],
      ["return import('./keyboardLayouts/layout.contribution.win.js');", "return import('./keyboardLayouts/layout.contribution.linux.js');"]]]
  ])
}

export default defineConfig({
  base: './',
  plugins: [eagerServices(), lazyExtensionHost(), inlineMarkdown(), quickerWorkers(), plainRules(), plainStyles(), sharedListStyles(), plainFigures(), smootherEditor(), quickerLineStarts(), quickerTrees(), quickerSwitch(), quickerMenus(), quickerPalette(), quickerPicks(), quickerOutline(), quickerSettings(), smootherLists(), quickerRows(), renderTimers(), settingsTimers(), quickerTerminal(), terminalTimers(), quickerColumns(), singleFormatters(), iosClipboard(), ownSearch(), searchTimers(), openTimers(), listenerTimers(), memoryRelief(), lighterTyping(), fasterDomNode(), calmerOverlayWidgets(), quickerDiffs(), soonerFirstLines(), smootherScroll(), noGrammars(), emmetInCzech(), leaveOut(), leanerBundle(), quickerStart(), quickerViews(), nativeSelects(), oldTokenLists(), fewerRowWrites(), suggestPause(), suggestTimers(), plainTypedArrays(), moduleTimes(), bundledLicenses(), bundleReport()],
  // (jschardet, LGPL, guesses file encodings only when the user turns that on: a stub that never guesses)
  resolve: { alias: [{ find: /^jschardet(\/.*)?$/, replacement: path.resolve(import.meta.dirname, 'src/stubs/jschardet.js') },
    // (the terminal's WebGL, image and ligature addons, which iOS 6 cannot use: src/stubs/xterm-addon.js)
    { find: /^@xterm\/addon-(webgl|image|ligatures)(\/.*)?$/, replacement: path.resolve(import.meta.dirname, 'src/stubs/xterm-addon.js') }] },
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
