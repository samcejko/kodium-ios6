// The app's site (Resources/site in the app, see src/KDSiteProtocol.m) from a web build: the page (web/site), the
// prelude and the lowered workbench with its assets - not the unlowered bundle or debugging copies.
//
// The stylesheet is rewritten here, once, by the engine's CSS rewriter (engine/Resources/cssfix.js, the same file the
// app runs) instead of on the iPad at the first start: with the variables of the default theme (web/theme) known, the
// rewriter puts their values in place, where it would otherwise leave the shim on the device to work them out element
// by element (VS Code sets them in a style of its own at run time). The output starts with /*kodium:rewritten*/,
// which tells the app to serve it as it is.
// Usage: node assemble-site.mjs <web/dist> <output folder>
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const [dist, out] = process.argv.slice(2)
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'assets'), { recursive: true })
fs.copyFileSync(path.join(web, 'site', 'index.html'), path.join(out, 'index.html'))
fs.copyFileSync(path.join(web, 'prelude', 'vsc-prelude.js'), path.join(out, 'vsc-prelude.js'))
let bytes = 0, files = 0
const copy = (from, to) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name)
    if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copy(a, b); continue }
    if (e.name === 'workbench.js' || e.name.endsWith('.dbg.js')) continue
    fs.copyFileSync(a, b)
    bytes += fs.statSync(b).size
    files++
  }
}
copy(path.join(dist, 'assets'), path.join(out, 'assets'))
for (const need of ['workbench.es5.js', 'workbench.es5.names.js', 'style.css']) {
  if (!fs.existsSync(path.join(out, 'assets', need))) throw new Error('assemble-site: ' + need + ' is missing (build first)')
}

// the stylesheet for the iOS 6 engine
const ctx = vm.createContext({})
vm.runInContext(fs.readFileSync(path.join(web, '..', 'engine', 'Resources', 'cssfix.js'), 'utf8'), ctx, { filename: 'cssfix.js' })
const theme = JSON.parse(fs.readFileSync(path.join(web, 'theme', 'dark-modern.json'), 'utf8'))
const cssPath = path.join(out, 'assets', 'style.css')

// ---- What can be settled before the rewriter is settled here, so that the engine's shims have nothing to keep up
// for it on the iPad: they redo their work after every change of the page, and with VS Code's stylesheet that was a
// third of a second a keystroke (measured: emulating fit-content for three elements 336 ms a pass, the variables
// pass 50 ms each time VS Code set one of its own).
// - var(): a variable of the theme gets its value; one nobody defines (not the theme, not a rule here, not the code)
//   its fallback, and without one the declaration goes (a browser drops it as well: invalid when computed); the
//   variables VS Code's code sets on elements (tab and activity bar sizes, the zoom factor...) stay for the engine.
// - fit-content, min-content, max-content and fill-available sizes, which the engine lacks and the shims emulated by
//   measuring: the declarations go (as the engine itself ignores them).
// - The declarations that took the theme's variables are kept as theme-template.txt as well, var() and all: when
//   another theme is chosen (an extension's), vsc-prelude.js fills them with its values and puts them after the
//   stylesheet, the engine having no custom properties of its own. (Text, not .css: the app runs every stylesheet it
//   serves through the engine's rewriter, which took the var() declarations out of it.)
const codeNames = new Set(fs.readFileSync(path.join(out, 'assets', 'workbench.es5.js'), 'utf8').match(/--[A-Za-z][\w-]*/g) || [])
// the blocks of at-rules (@media and the like): prelude, where the block starts and ends
function atRuleBlocks(text) {
  const blocks = [], stack = []
  let quote = null, start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; start = i + 1 }
    else if (c === '{') { stack.push({ prelude: text.slice(start, i).trim(), start: i }); start = i + 1 }
    else if (c === '}') { const b = stack.pop(); if (b && b.prelude.startsWith('@')) blocks.push({ prelude: b.prelude, start: b.start, end: i }); start = i + 1 }
    else if (c === ';') start = i + 1
  }
  return blocks
}
function settleStatically(text, vars) {
  const defined = new Set(text.match(/(?<=[{;\s])--[A-Za-z][\w-]*(?=\s*:)/g) || [])
  const dynamic = (name) => defined.has(name) || codeNames.has(name)
  const stats = { theme: 0, fallback: 0, dropped: 0, kept: 0, sizes: 0 }
  const atBlocks = atRuleBlocks(text)
  const template = []   // [at-rule preludes, selector, declarations]
  let usedTheme = false
  // var(...) in a value: null when the declaration has to go; keepTheme leaves the theme's variables as they are
  const resolve = (value, depth, keepTheme) => {
    let out = '', i = 0, at
    while ((at = value.indexOf('var(', i)) >= 0) {
      out += value.slice(i, at)
      let k = at + 4, open = 1, comma = -1
      for (; k < value.length && open; k++) {
        const c = value[k]
        if (c === '(') open++
        else if (c === ')') open--
        else if (c === ',' && open === 1 && comma < 0) comma = k
      }
      if (open) return out + value.slice(at)
      const name = value.slice(at + 4, comma < 0 ? k - 1 : comma).trim()
      const fallback = comma < 0 ? null : value.slice(comma + 1, k - 1).trim()
      if (Object.prototype.hasOwnProperty.call(vars, name) && !defined.has(name)) {
        usedTheme = true
        if (keepTheme) { out += value.slice(at, k); i = k; continue }
        const v = depth < 8 ? resolve(String(vars[name]), depth + 1, false) : null
        if (v === null) return null
        out += v; stats.theme++
      } else if (dynamic(name)) {
        out += value.slice(at, k); stats.kept++
      } else if (fallback !== null) {
        const v = depth < 8 ? resolve(fallback, depth + 1, keepTheme) : null
        if (v === null) return null
        out += v; stats.fallback++
      } else return null
      i = k
    }
    return out + value.slice(i)
  }
  const SIZE = /^(-webkit-)?(min-|max-)?(width|height)$|^(-webkit-)?flex-basis$/i
  const INTRINSIC = /(^|[\s(,:])(-webkit-|-moz-)?(fit-content|min-content|max-content|fill-available)\b/i
  // each innermost block's declarations, split at semicolons outside strings and parentheses (data: URLs have them)
  const result = text.replace(/\{([^{}]*)\}/g, (all, body, offset) => {
    if (body.indexOf('var(') < 0 && !INTRINSIC.test(body)) return all
    // (its selector: back to the end of what came before; the at-rules around it, keyframes and fonts left out)
    let s = offset
    while (s > 0 && text[s - 1] !== '}' && text[s - 1] !== '{' && text[s - 1] !== ';') s--
    const selector = text.slice(s, offset).trim()
    const around = atBlocks.filter((b) => b.start < offset && offset < b.end).sort((a, b) => a.start - b.start).map((b) => b.prelude)
    const forTemplate = !selector.startsWith('@') && !around.some((p) => /^@(-webkit-)?(keyframes|font-face)/i.test(p))
    const themed = []
    const parts = []
    let depth = 0, quote = null, start = 0
    for (let i = 0; i < body.length; i++) {
      const c = body[i]
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
      if (c === '"' || c === "'") quote = c
      else if (c === '(') depth++
      else if (c === ')') depth--
      else if (c === ';' && !depth) { parts.push(body.slice(start, i)); start = i + 1 }
    }
    parts.push(body.slice(start))
    const kept = []
    for (const decl of parts) {
      const colon = decl.indexOf(':')
      const prop = colon < 0 ? '' : decl.slice(0, colon).trim()
      if (colon < 0 || prop.startsWith('--')) { kept.push(decl); continue }
      let value = decl.slice(colon + 1)
      if (SIZE.test(prop) && INTRINSIC.test(value)) {
        stats.sizes++
        // a width or height of the content's size becomes auto (a box's child takes its content's size by itself, and
        // the declaration often undoes a width: 100% of a broader rule - a dialog's buttons each took the whole row);
        // a minimum or maximum goes
        if (/^(-webkit-)?(width|height)$/i.test(prop) && !/fill-available/i.test(value)) kept.push(decl.slice(0, colon + 1) + 'auto')
        continue
      }
      if (value.indexOf('var(') >= 0) {
        usedTheme = false
        const original = value
        value = resolve(value, 0, false)
        if (value === null) { stats.dropped++; continue }
        if (usedTheme && forTemplate) {
          const withVars = resolve(original, 0, true)
          if (withVars !== null) themed.push(prop + ':' + withVars)
        }
      }
      kept.push(decl.slice(0, colon + 1) + value)
    }
    if (themed.length) template.push([around, selector, themed])
    return '{' + kept.join(';') + '}'
  })
  console.log('settled before the rewriter:', JSON.stringify(stats), '- theme template:', template.length, 'rules')
  return { css: result, template }
}
const settled = settleStatically(fs.readFileSync(cssPath, 'utf8'), theme.vars)
const css = settled.css
// the template: the rules in their order, each in its at-rules
fs.writeFileSync(path.join(out, 'assets', 'theme-template.txt'), settled.template.map(([around, selector, decls]) =>
  around.reduceRight((inner, prelude) => prelude + '{' + inner + '}', selector + '{' + decls.join(';') + '}')).join('\n') + '\n')
// (the app's web view: the whole screen below the status bar of an iPad, in both orientations)
const options = { pageURL: 'https://kodium.invalid/index.html', viewportWidth: 768, devicePixelRatio: 1,
                  viewportPortrait: [768, 1004], viewportLandscape: [1024, 748], orientation: 'landscape' }
const result = JSON.parse(ctx.CSSFix.run('css', css, JSON.stringify(theme.vars), JSON.stringify(options)))
if (!result || typeof result.out !== 'string' || !result.out.length) throw new Error('assemble-site: the CSS rewriter gave nothing')
// The manifest is what the engine's shims redo after every change of the page. Kept: container queries and grids (a
// grid's layout needs them). Left out: the marker rules (percentage heights, z-index and the like, where the engine's
// own layout is right for VS Code: the scan read the style of hundreds of elements a keystroke) and the variables VS
// Code sets at run time (each one it set had the variables pass look through every rule with one) - measured on the
// iPad 2 with both: 330 ms of shims a keystroke; without: 70 - and the six :has() rules, all of them looks only (a
// minimum width of the code action menu with a header, no bullets for Markdown's task items, the actions of extensions'
// trees when scrolled sideways, a wider filter of the panel while it has the focus, the compact command center): 3 ms
// of the 7 ms of every pass, and a pass after nearly every key.
// (and of the grids, the modal editor's: workbench.editor.useModal is off, it never shows - its nine rules had the grid
// pass query the whole page nine times for nothing, the pass that runs after every change of the page has settled,
// every 150-300 ms while the editor scrolls: 450 of the 740 ms of querySelectorAll in a profiled scroll. The extension
// page's "More Info" grid stays.)
result.out = result.out.replace(/\/\*br-manifest:([\s\S]*?)\*\/(\s*)$/, (all, json, tail) => {
  const m = JSON.parse(json)
  for (const kind of ['mk', 'cv', 'has']) if (Array.isArray(m[kind])) m[kind] = []
  if (Array.isArray(m.gd)) m.gd = m.gd.filter((e) => !(Array.isArray(e.s) && e.s.length && e.s.every((s) => s.indexOf('.monaco-modal-editor-block') >= 0)))
  return '/*br-manifest:' + JSON.stringify(m) + '*/' + tail
})
// No rule whose last part checks a place among siblings or a sibling - :first-child, :last-child, :nth-child(), + or ~ -
// with no class, id or attribute of its own: the old WebKit checks such a rule on every element of the page, and the
// check marks the element's parent for good. A marked element's children share no styles (each is matched against all
// the rules again), and an element put in before or after one of them has that one's whole subtree styled again: one
// after the workbench at the end of body (a measuring element, the selection's loupe) or before the workbench's grid
// restyled the whole page, ~32 ms on the iPad 2 - none now. Kodium's own (kodium.css) are written without; the
// rewriter's and VS Code's are rewritten here.
//
// The rewriter's float layout for the extension page's "More Info" grid (a name and a value an entry) took the right
// margin off every second child with *:nth-child(2n). The same layout without it: the margin on the name only.
{
  const entry = '.extension-editor>.body>.content>.details>.additional-details-container .more-info-container>.more-info>.more-info-entry:not(.br-grid)'
  const nth = entry + ' > *:nth-child(2n){margin-right:0}'
  const all = entry + ' > *{'
  const at = result.out.indexOf(all), end = at < 0 ? -1 : result.out.indexOf('}', at)
  if (result.out.indexOf(nth) >= 0 && end > 0 && result.out.slice(at, end).indexOf('margin-right:6px') >= 0) {
    const rule = result.out.slice(at, end + 1)
    result.out = result.out.replace(nth, '').replace(rule, rule.replace('margin-right:6px', 'margin-right:0') + '\n' + entry + ' > .more-info-entry-name{margin-right:6px}')
  } else {
    console.warn('assemble-site: the "More Info" grid\'s float rules were not where they were - left as the rewriter made them')
  }
}
// The rewriter's gap of a flex box: "box > * + *" with the margin. The margin goes on every child, and a first box of
// the container's own (::before, empty) takes it back - a row's to the right, a column's below.
{
  let gaps = 0
  result.out = result.out.replace(/(^|[{}\n])([^{}@]+?)\{(margin-left|margin-top):([^;{}]+)\}/g, (all, before, sels, prop, value) => {
    const list = sels.split(',').map((s) => s.trim())
    if (!list.length || !list.every((s) => / > \* \+ \*$/.test(s))) return all
    const boxes = list.map((s) => s.replace(/ > \* \+ \*$/, ''))
    gaps++
    const back = prop === 'margin-left' ? 'margin-right' : 'margin-bottom'
    return before + boxes.map((b) => b + ' > *').join(',') + '{' + prop + ':' + value + '}\n' +
      boxes.map((b) => b + '::before').join(',') + '{content:"";display:block;' + back + ':-' + value.trim() + '}'
  })
  if (!gaps) console.warn('assemble-site: no gap rules of the rewriter ("> * + *") found')
}
// VS Code's Markdown of a setting's description: a bottom margin on all but the last of its elements (*:not(:last-child)).
// The block elements Markdown makes, named (a list's items are left as they are).
{
  const md = '.settings-editor>.settings-body .settings-tree-container .setting-item-contents .setting-item-markdown'
  const rule = md + ' *:not(:last-child){margin-bottom:8px}'
  if (result.out.indexOf(rule) >= 0) {
    const blocks = ['p', 'ul', 'ol', 'pre', 'blockquote', 'table', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']
    result.out = result.out.replace(rule, blocks.map((t) => md + ' ' + t + ':not(:last-child)').join(',') + '{margin-bottom:8px}')
  } else {
    console.warn('assemble-site: the settings\' Markdown rule was not where it was - left as VS Code wrote it')
  }
}
// (and a look that none is left - a new VS Code version could bring one: told, not changed)
{
  const universal = []
  for (const m of result.out.matchAll(/(?:^|[{}\n])([^{}@]+?)\{/g)) {
    for (const sel of m[1].split(',')) {
      // (the selector's last part - its pseudo-classes' arguments in it - and the combinator before it)
      const s = sel.trim()
      const part = /(?:^|\s*([>+~ ])\s*)((?:[^\s>+~(]|\([^)]*\))+)$/.exec(s)
      if (!part) continue
      const bare = part[2].replace(/::?[\w-]+(\([^)]*\))?/g, '')
      if (bare !== '' && bare !== '*') continue
      if (/:(first-child|last-child|only-child|nth-|first-of-type|last-of-type|only-of-type)/.test(part[2]) || part[1] === '+' || part[1] === '~') universal.push(s)
    }
  }
  if (universal.length) console.warn('assemble-site: universal sibling or place rules left: ' + universal.slice(0, 5).join(' | '))
}
// The rewriter writes flex-direction: *-reverse as -webkit-box-direction: reverse too, which the iOS 6 engine inherits
// (flex-direction is not inherited): .monaco-workbench.mac .part.titlebar{flex-direction:row-reverse}, for the one
// child of the title bar, turned the whole title bar around. Every element gets the initial value as its own; the
// rule of a reversed box still wins (any selector is more specific than *).
const boxDirectionReset = '*{-webkit-box-direction:normal}\n'
fs.writeFileSync(cssPath, '/*kodium:rewritten*/\n' + boxDirectionReset + result.out)

// SVG images whose root element has an opacity (the editor's watermark, at 0.3): the iOS 6 engine ignores it there and
// draws them at full strength, so it goes on a group around the content instead
let svgs = 0
for (const name of fs.readdirSync(path.join(out, 'assets'))) {
  if (!name.endsWith('.svg')) continue
  const file = path.join(out, 'assets', name)
  const svg = fs.readFileSync(file, 'utf8')
  const m = svg.match(/<svg\b([^>]*?)\sopacity="([^"]*)"([^>]*)>([\s\S]*)<\/svg>\s*$/)
  if (!m) continue
  fs.writeFileSync(file, svg.slice(0, m.index) + `<svg${m[1]}${m[3]}><g opacity="${m[2]}">${m[4]}</g></svg>\n`)
  svgs++
}
// VS Code's texts in Czech (monaco-vscode-api's language pack, built for this version: the messages by the numbers the
// bundle asks for). A classic script the page loads before the workbench on a Czech device: the texts must be there
// before the first one is used.
const pack = fs.readFileSync(path.join(web, 'node_modules', '@codingame', 'monaco-vscode-language-pack-cs', 'translations', 'main.i18n.json.js'), 'utf8')
const tail = /\n\s*export\s*\{\s*content\s+as\s+default\s*\};?\s*$/
if (!/^var content = \[/.test(pack) || !tail.test(pack)) throw new Error('assemble-site: the Czech language pack has another form')
const packCtx = vm.createContext({})
vm.runInContext(pack.replace(tail, '\n'), packCtx)
const messages = packCtx.content
if (!Array.isArray(messages) || messages.length < 1000) throw new Error('assemble-site: the Czech language pack has no messages')
// Only the messages the bundle asks for: the pack has all of VS Code's (22 600), the bundle's code numbers ~8 000 of
// them - every call with a number as its first argument counts, more than are messages - and the rest were 1.6 MB of
// strings in the page's heap, all the time. Each one left out is a 0, for which VS Code takes its English text.
const bundleCode = fs.readFileSync(path.join(out, 'assets', 'workbench.es5.js'), 'utf8')
const asked = new Set()
// (the bundle is in lines of ~1000 characters: a line may end right after the call's "(" - a dozen texts of every build
// came out in English, others in each build)
for (const m of bundleCode.matchAll(/[\w$]\(\s*(\d{1,5})\s*,/g)) asked.add(+m[1])
// (two buttons of the "trust the publisher?" question came out as "Důvěřovat vydavateli &> Nainstalovat" in the
// translation: the "&&" of an ampersand gone wrong)
const kept = messages.map((text, i) => asked.has(i) && typeof text === 'string' ? text.replace(/ &> Nainstalovat$/, ' a nainstalovat') : 0)
const keptCount = kept.filter((text) => text !== 0).length
const nls = '/* VS Code\'s texts in Czech: @codingame/monaco-vscode-language-pack-cs (MIT; the vscode-loc translations, MIT) */\n' +
  '(function () {\nvar content = ' + JSON.stringify(kept).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ';\n' +
  'window._VSCODE_NLS_MESSAGES = content;\nwindow._VSCODE_NLS_LANGUAGE = \'cs\';\n})();\n'
console.log('Czech messages:', keptCount, 'of', messages.length, '(' + (nls.length / 1024).toFixed(0) + ' KB)')
const acornCtx = vm.createContext({})
vm.runInContext(fs.readFileSync(path.join(web, 'tp', 'acorn.js'), 'utf8'), acornCtx)
acornCtx.acorn.parse(nls, { ecmaVersion: 5 })   // (the iOS 6 engine reads it as it is)
fs.writeFileSync(path.join(out, 'nls.cs.js'), nls)

// the same values for the code's own strings (__kd_cssVar in vsc-prelude.js)
fs.writeFileSync(path.join(out, 'kd-theme.js'), '/* the variables of VS Code\'s default theme (' + theme.theme + '), see web/theme */\n' +
  'window.__kd_themeVars = ' + JSON.stringify(theme.vars) + ';\n')
const manifest = (result.out.match(/\/\*br-manifest:([\s\S]*?)\*\/\s*$/) || [])[1]
const counts = manifest ? Object.entries(JSON.parse(manifest)).map(([k, v]) => k + ' ' + (Array.isArray(v) ? v.length : '')).join(', ') : 'none'
console.log('style.css for iOS 6:', (css.length / 1024).toFixed(0), 'KB ->', (result.out.length / 1024).toFixed(0), 'KB; manifest:', counts)
console.log('SVG images with the opacity on a group:', svgs)
console.log('site:', files + 2, 'files,', (bytes / 1048576).toFixed(1), 'MB ->', out)
