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
//   typing pauses (1 s, 0.3 s).
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
function smootherEditor() {
  return patchModules('kodium-smoother-editor', [
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
      ['            min: 200\n', '            min: 1000\n']]],
    ['/vs/editor/contrib/bracketMatching/browser/bracketMatching.js', [
      ['new RunOnceScheduler(() => this._updateBrackets(), 50)', 'new RunOnceScheduler(() => this._updateBrackets(), 300)']]],
    // The symbols in the breadcrumbs (off by Kodium's default, main.ts): with them off, no outline of the file is kept for
    // the breadcrumbs - it was worked out again at every pause in typing (0.35 s) and followed every move of the cursor
    ['/vs/workbench/browser/parts/editor/breadcrumbsModel.js', [
      ['        this._disposables.add(this._cfgSymbolPath.onDidChange(_ => this._onDidUpdate.fire(this)));',
       '        this._disposables.add(this._cfgSymbolPath.onDidChange(_ => { if (editor) this._bindToEditor(editor); this._onDidUpdate.fire(this); }));'],
      ['        this._outlineDisposables.add(toDisposable(() => newCts.dispose(true)));\n        this._outlineService.createOutline(',
       '        this._outlineDisposables.add(toDisposable(() => newCts.dispose(true)));\n        if (this._cfgSymbolPath.getValue() === "off") return;\n        this._outlineService.createOutline(']]]
  ])
}

// Switching between editors on the iPad 2 (1.3-1.8 s, WebKit's profiler: VS Code's reactions to the new editor, each
// a little - but some of them done for nothing):
// - the menus of the menu bar (File, Edit, Selection, View, Go...) were all made again whenever a context they depend on
//   changed - at every switch, and at the start; Kodium's menu bar is the compact one (the button at the top of the
//   activity bar), whose menus are only seen when it opens: they are made then, if something changed since
// - the editor's toolbar (run, preview, split, more...) was made twice per switch: once for the editor that was going
//   (VS Code redraws the tabs before the new editor has its model) and again when its contexts changed: now once, as
//   the switch is done
// - the window's title (which iOS does not show) is put together when nothing is being typed or touched (it was at
//   every switch, and twice per autosave while typing: "dirty")
// - the editor's settings for the file were worked out twice per switch (the model, then the input): once
function quickerSwitch() {
  return patchModules('kodium-quicker-switch', [
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
      ['    updateEditorActionsToolbar() {\n        super.updateEditorActionsToolbar();\n        this.layout(this.dimensions);\n    }',
       '    updateEditorActionsToolbar() {\n' +
       '        (this.kdToolbarUpdater || (this.kdToolbarUpdater = this._register(new RunOnceScheduler(() => this.kdUpdateEditorActionsToolbar(), 0)))).schedule();\n' +
       '    }\n' +
       '    kdUpdateEditorActionsToolbar() {\n        super.updateEditorActionsToolbar();\n        this.layout(this.dimensions);\n    }']]],
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
    ['/vs/platform/actions/common/menuService.js', [
      ['        const menuItems = this._sort(MenuRegistry.getMenuItems(this._id));', '        const menuItems = this._kdItems();'],
      ['    _sort(menuItems) {\n        return menuItems;\n    }',
       '    _sort(menuItems) {\n        return menuItems;\n    }\n    _kdItems() {\n        return this._sort(MenuRegistry.getMenuItems(this._id));\n    }'],
      ['        this._contextKeyService = _contextKeyService;\n        this.refresh();\n    }\n    createActionGroups(options) {',
       '        this._contextKeyService = _contextKeyService;\n    }\n    _kdItems() {\n        return __kdSortedMenuItems(this._id, () => this._sort(MenuRegistry.getMenuItems(this._id)));\n    }\n    createActionGroups(options) {']],
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

// The command palette at every opening (the profiler, after the menus' kept items above): each of the ~1000 commands
// got a "Configure Keybinding" button of its own (an array, an object, a localize and a class name each), and with
// nothing typed yet each was still tested against the empty filter (4000 calls of the filters, all matching).
function quickerPalette() {
  return patchModules('kodium-quicker-palette', [
    ['/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.js', [
      ['        return [...this.getCodeEditorCommandPicks(), ...this.getGlobalCommandPicks()].map(picks => ({\n            ...picks,\n            buttons: [{\n                iconClass: ThemeIcon.asClassName(Codicon.gear),\n                tooltip: ( localize(17512, "Configure Keybinding"))\n            }],',
       '        const kdButtons = [{\n            iconClass: ThemeIcon.asClassName(Codicon.gear),\n            tooltip: ( localize(17512, "Configure Keybinding"))\n        }];\n' +
       '        return [...this.getCodeEditorCommandPicks(), ...this.getGlobalCommandPicks()].map(picks => ({\n            ...picks,\n            buttons: kdButtons,']]],
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
       '            const isInHistory = !!commandPick.kdCounter;']]]
  ])
}

// The Settings editor opened in 7 s on the iPad 2 every time: VS Code builds its tree again at each opening - which
// of the ~1000 settings goes under which of 60 headings (40 000 tests of their names against patterns, 2.3 s in the
// profiler), the extensions' headings, then every element of the tree. Nothing of it changes while the editor is
// closed, unless settings are registered or dropped (an extension, a different set of defaults: other groups then) -
// a changed value reaches the closed editor's tree as before. Opened again with the same groups (the same headings,
// with as many settings each: VS Code makes the group objects again whenever its defaults change), it shows the tree
// it has, its rows drawn again.
function quickerSettings() {
  return patchModules('kodium-quicker-settings', [
    ['/vs/workbench/contrib/preferences/browser/settingsEditor2.js', [
      ['        this._setOptions(options);\n        this.onConfigUpdate(undefined, true).then(() => {',
       '        this._setOptions(options);\n        (this.kdSameTree(model) ? this.kdShowTree() : this.onConfigUpdate(undefined, true)).then(() => {'],
      ['    async refreshInstalledExtensionsList() {',
       '    kdTreeShape(groups) {\n' +
       '        return groups.map(group => group.id + ":" + group.sections.reduce((n, section) => n + section.settings.length, 0)).join(",");\n' +
       '    }\n' +
       '    kdSameTree(model) {\n' +
       '        return !!(this.settingsTreeModel.value && this.kdTreeGroups && this.kdTreeAdvanced === this.canShowAdvancedSettings() &&\n' +
       '            !this.viewState.query && !this.searchResultModel && this.kdTreeShape(model.settingsGroups) === this.kdTreeGroups);\n' +
       '    }\n' +
       '    async kdShowTree() {\n' +
       '        this.settingsTree.rerender();\n' +
       '        this.tocTree.rerender();\n' +
       '    }\n' +
       '    async refreshInstalledExtensionsList() {'],
      ['        const groups = this.defaultSettingsEditorModel.settingsGroups.slice(1);\n        const coreSettingsGroups = [], extensionSettingsGroups = [];',
       '        this.kdTreeGroups = this.kdTreeShape(this.defaultSettingsEditorModel.settingsGroups);\n        this.kdTreeAdvanced = this.canShowAdvancedSettings();\n' +
       '        const groups = this.defaultSettingsEditorModel.settingsGroups.slice(1);\n        const coreSettingsGroups = [], extensionSettingsGroups = [];']]]
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
function quickerViews() {
  return patchModules('kodium-quicker-views', [
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
       '    async setTreeInput() {\n        if (!this.isBodyVisible()) {\n            this.kdInputStale = true;\n']]]
  ])
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

// The start: Kodium registers monaco's 31 Monarch languages one by one (src/languages.ts), and every registration had
// the languages' registry made again from all languages so far and the settings' schema told of all of them as
// override identifiers - 651 language merges and 31 schema updates (0.9 s of a profiled start). Registered together
// now, with one change event (ModesRegistry.kdRegisterLanguages).
// And what the workbench does in the first seconds after it appears (VS Code's own log on the iPad 2: contributions of
// 100-200 ms each): the settings' migrations inspected all ~100 old keys at every start, though the settings had none
// of them - only the keys the settings have (all, with a language section in them); the sash sizes went into a <style>
// of CSS variables, which the iOS 6 engine does not have - only a full rebuild of its rule sets (the sizes still reach
// the sashes, in code); the schema of the paste/drop kinds (settings' suggestions) is left out.
function quickerStart() {
  return patchModules('kodium-quicker-start', [
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
  plugins: [eagerServices(), lazyExtensionHost(), inlineMarkdown(), quickerWorkers(), plainRules(), plainStyles(), plainFigures(), smootherEditor(), quickerSwitch(), quickerMenus(), quickerPalette(), quickerSettings(), noGrammars(), emmetInCzech(), leaveOut(), leanerBundle(), quickerStart(), quickerViews(), nativeSelects(), moduleTimes(), bundledLicenses(), bundleReport()],
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
