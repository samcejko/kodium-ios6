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
       '        else for (const commandPick of allCommandPicks) {']]]
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
  plugins: [eagerServices(), lazyExtensionHost(), inlineMarkdown(), quickerWorkers(), plainRules(), smootherEditor(), quickerSwitch(), quickerMenus(), quickerPalette(), quickerSettings(), noGrammars(), emmetInCzech(), leaveOut(), leanerBundle(), bundledLicenses(), bundleReport()],
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
