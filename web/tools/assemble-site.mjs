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
const codeNames = new Set(fs.readFileSync(path.join(out, 'assets', 'workbench.es5.js'), 'utf8').match(/--[A-Za-z][\w-]*/g) || [])
function settleStatically(text, vars) {
  const defined = new Set(text.match(/(?<=[{;\s])--[A-Za-z][\w-]*(?=\s*:)/g) || [])
  const dynamic = (name) => defined.has(name) || codeNames.has(name)
  const stats = { theme: 0, fallback: 0, dropped: 0, kept: 0, sizes: 0 }
  // var(...) in a value: null when the declaration has to go
  const resolve = (value, depth) => {
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
        const v = depth < 8 ? resolve(String(vars[name]), depth + 1) : null
        if (v === null) return null
        out += v; stats.theme++
      } else if (dynamic(name)) {
        out += value.slice(at, k); stats.kept++
      } else if (fallback !== null) {
        const v = depth < 8 ? resolve(fallback, depth + 1) : null
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
  const result = text.replace(/\{([^{}]*)\}/g, (all, body) => {
    if (body.indexOf('var(') < 0 && !INTRINSIC.test(body)) return all
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
      if (SIZE.test(prop) && INTRINSIC.test(value)) { stats.sizes++; continue }
      if (value.indexOf('var(') >= 0) {
        value = resolve(value, 0)
        if (value === null) { stats.dropped++; continue }
      }
      kept.push(decl.slice(0, colon + 1) + value)
    }
    return '{' + kept.join(';') + '}'
  })
  console.log('settled before the rewriter:', JSON.stringify(stats))
  return result
}
const css = settleStatically(fs.readFileSync(cssPath, 'utf8'), theme.vars)
// (the app's web view: the whole screen below the status bar of an iPad, in both orientations)
const options = { pageURL: 'https://kodium.invalid/index.html', viewportWidth: 768, devicePixelRatio: 1,
                  viewportPortrait: [768, 1004], viewportLandscape: [1024, 748], orientation: 'landscape' }
const result = JSON.parse(ctx.CSSFix.run('css', css, JSON.stringify(theme.vars), JSON.stringify(options)))
if (!result || typeof result.out !== 'string' || !result.out.length) throw new Error('assemble-site: the CSS rewriter gave nothing')
// The manifest is what the engine's shims redo after every change of the page. Kept: :has(), container queries and
// grids (few, and a grid's layout needs them). Left out: the marker rules (percentage heights, z-index and the like,
// where the engine's own layout is right for VS Code: the scan read the style of hundreds of elements a keystroke)
// and the variables VS Code sets at run time (each one it set had the variables pass look through every rule with
// one). Measured on the iPad 2 with both: 330 ms of shims a keystroke; without: 70.
result.out = result.out.replace(/\/\*br-manifest:([\s\S]*?)\*\/(\s*)$/, (all, json, tail) => {
  const m = JSON.parse(json)
  for (const kind of ['mk', 'cv']) if (Array.isArray(m[kind])) m[kind] = []
  return '/*br-manifest:' + JSON.stringify(m) + '*/' + tail
})
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
const nls = '/* VS Code\'s texts in Czech: @codingame/monaco-vscode-language-pack-cs (MIT; the vscode-loc translations, MIT) */\n' +
  '(function () {\n' + pack.replace(tail, '\n') + 'window._VSCODE_NLS_MESSAGES = content;\nwindow._VSCODE_NLS_LANGUAGE = \'cs\';\n})();\n'
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
