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
       '        const updater = this.kdToolbarUpdater || (this.kdToolbarUpdater = this._register(new RunOnceScheduler(() => this.kdUpdateEditorActionsToolbar(), 0)));\n' +
       // (after the next frame: an editor opened or switched to is drawn first, its actions come after it - they
       // came before, 75 ms of menus and context keys between the editor's lines and the screen)
       '        if (updater.isScheduled() || this.kdToolbarFrame) {\n            return;\n        }\n' +
       '        this.kdToolbarFrame = true;\n' +
       '        requestAnimationFrame(() => {\n            this.kdToolbarFrame = false;\n            updater.schedule();\n        });\n' +
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
// Every context menu also gave the menus' shared <style> its text again - the same text: the old WebKit then made its
// rule sets anew from all of the page's rules, and the engine's shim looked the text over again (0.23 s of an editor
// context menu's 0.87 in the profiler). The text is given when it is another.
// And at every change of a context key (dozens when an editor opens or a tab is switched), every scoped context key
// service below it - one per editor, view, list, widget: dozens - copied its whole context (a spread of all its keys)
// and made a Set of the copy's keys, to ask whether the change touched only keys of its own: on iOS 6 Set is the
// engine's shim, slow to fill. The keys are asked of the context itself now.
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
       '            const thisContextValues = thisContainer._value || thisContainer.value;\n            if (!allEventKeysInContext(e, thisContextValues)) {']]],
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
function quickerSettings() {
  return patchModules('kodium-quicker-settings', [
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
       '                const viewLineEndIndex = line.getViewLineCount() === 1 ? 0 : line.getViewLineNumberOfModelPosition(0, this.model.getLineMaxColumn(modelLineIndex + 1));']]],
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
    // its generator was the regenerator runtime's three calls and a try per element)
    ['/vs/base/common/linkedList.js', [
      ['    *[Symbol.iterator]() {\n        let node = this._first;\n        while (node !== Node.Undefined) {\n            yield node.element;\n            node = node.next;\n        }\n    }',
       '    [Symbol.iterator]() {\n' +
       '        const list = this;\n' +
       '        let node = Node.Undefined, first = true;\n' +
       '        const iterator = {\n' +
       '            next() {\n' +
       '                if (first) {\n                    first = false;\n                    node = list._first;\n                } else if (node !== Node.Undefined) {\n                    node = node.next;\n                }\n' +
       '                return node === Node.Undefined ? { done: true, value: undefined } : { done: false, value: node.element };\n' +
       '            },\n' +
       '            [Symbol.iterator]() {\n                return iterator;\n            }\n' +
       '        };\n' +
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

// A build for measuring the Settings editor (KODIUM_SETTINGS_TIMERS=1 .\web\build.ps1): marks along its opening -
// self.__kdMark(name) and self.__kdAdd(name, ms), when a measuring script has set them (renderers' renderTemplate and
// renderElement, the tree's splice summed) - and self.__kdResets: when the default settings were dropped, for which keys.
function settingsTimers() {
  if (!process.env.KODIUM_SETTINGS_TIMERS) return null
  const m = (n) => 'self.__kdMark && self.__kdMark("' + n + '");\n'
  return patchModules('kodium-settings-timers', [
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
// The Open Editors view, at every change of an editor's row - the first key after a save makes the file dirty, the
// first key in a file opened for a look pins it - redraws the row, which has the list tell its focus anew (twice): at
// each, the view reset its 13 context keys (the focused file's name, folder, language...) and set them again, every
// change told to every menu - 0.35 s of such a key's 0.55 in the profiler. The keys change now when what the focused
// row stands for does, in one change.
// The views' title bars (the Explorer's New File..., Open Editors', the Outline's, the Timeline's) made their toolbars
// anew whenever a context key their menus look at changed - opening a file, switching tabs - though the actions came
// out the same: a toolbar is made again when its actions (what they show and whether they are on) are others. The
// actions of a view's title get the view's context at run time, not the editor's.
function quickerViews() {
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
     'function kdActionsKey(actions) {\n' +
     '    let key = "";\n' +
     '    for (const a of actions) {\n' +
     '        key += a.id + "\\u0001" + a.label + "\\u0001" + a.tooltip + "\\u0001" + a.class + "\\u0001" + a.enabled + "\\u0001" + a.checked + "\\u0002";\n' +
     '        if (a.actions && a.actions.length) {\n            key += "[" + kdActionsKey(a.actions) + "]";\n        }\n' +
     '    }\n' +
     '    return key;\n' +
     '}\n'],
    ['/vs/workbench/contrib/files/browser/views/openEditorsView.js', [
      ['        this._register(this.list.onDidChangeFocus(e => {\n            resourceContext.reset();\n' +
       '            groupFocusedContext.reset();\n            dirtyEditorFocusedContext.reset();\n            readonlyEditorFocusedContext.reset();\n' +
       '            const element = e.elements.length ? e.elements[0] : undefined;\n',
       '        let kdFocused;\n' +
       '        this._register(this.list.onDidChangeFocus(e => {\n' +
       '            const kdElement = e.elements.length ? e.elements[0] : undefined;\n' +
       '            const kdNow = kdElement instanceof OpenEditor ? "e" + String(kdElement.getResource()) + "|" + (kdElement.editor.isDirty() && !kdElement.editor.isSaving()) + "|" + !!kdElement.editor.isReadonly()\n' +
       '                : kdElement ? "g" + kdElement.id : "";\n' +
       '            if (kdNow === kdFocused) {\n                return;\n            }\n' +
       '            kdFocused = kdNow;\n' +
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
       '    async setTreeInput() {\n        if (!this.isBodyVisible()) {\n            this.kdInputStale = true;\n']]]
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
  plugins: [eagerServices(), lazyExtensionHost(), inlineMarkdown(), quickerWorkers(), plainRules(), plainStyles(), plainFigures(), smootherEditor(), quickerSwitch(), quickerMenus(), quickerPalette(), quickerSettings(), settingsTimers(), openTimers(), memoryRelief(), lighterTyping(), fasterDomNode(), soonerFirstLines(), smootherScroll(), noGrammars(), emmetInCzech(), leaveOut(), leanerBundle(), quickerStart(), quickerViews(), nativeSelects(), plainTypedArrays(), moduleTimes(), bundledLicenses(), bundleReport()],
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
