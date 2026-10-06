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
const css = fs.readFileSync(cssPath, 'utf8')
// (the app's web view: the whole screen below the status bar of an iPad, in both orientations)
const options = { pageURL: 'https://kodium.invalid/index.html', viewportWidth: 768, devicePixelRatio: 1,
                  viewportPortrait: [768, 1004], viewportLandscape: [1024, 748], orientation: 'landscape' }
const result = JSON.parse(ctx.CSSFix.run('css', css, JSON.stringify(theme.vars), JSON.stringify(options)))
if (!result || typeof result.out !== 'string' || !result.out.length) throw new Error('assemble-site: the CSS rewriter gave nothing')
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
