// Runs the engine's CSS rewriter (engine/Resources/cssfix.js, as the app runs it in JavaScriptCore) over a stylesheet
// and reports what it did with the custom properties: for looking at what iOS 6 will get.
// Usage: node cssfix-run.mjs <input.css> <output.css> [pageVars.json]
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const [input, output, varsFile] = process.argv.slice(2)
const ctx = vm.createContext({ console })
vm.runInContext(fs.readFileSync(path.join(root, 'engine', 'Resources', 'cssfix.js'), 'utf8'), ctx, { filename: 'cssfix.js' })
const css = fs.readFileSync(input, 'utf8')
const vars = varsFile ? fs.readFileSync(varsFile, 'utf8') : '{}'
const opts = JSON.stringify({ pageURL: 'https://kodium.invalid/index.html', viewportWidth: 768, devicePixelRatio: 1,
  viewportPortrait: [768, 1004], viewportLandscape: [1024, 748], orientation: 'landscape' })
const t0 = Date.now()
const result = JSON.parse(ctx.CSSFix.run('css', css, vars, opts))
const ms = Date.now() - t0
const out = result.out || ''
fs.writeFileSync(output, out)
const manifest = (out.match(/\/\*br-manifest:([\s\S]*?)\*\/\s*$/) || [])[1]
let m = null
try { m = manifest ? JSON.parse(manifest) : null } catch (e) {}
const varsLeft = (out.replace(/\/\*br-manifest:[\s\S]*$/, '').match(/var\(--/g) || []).length
console.log(JSON.stringify({
  ms, inBytes: css.length, outBytes: out.length, varsLeftInOutput: varsLeft,
  resultKeys: Object.keys(result), vars: result.vars ? Object.keys(result.vars).length : 0, scoped: (result.scoped || []).length,
  manifestKeys: m ? Object.keys(m).map((k) => k + ':' + (Array.isArray(m[k]) ? m[k].length : typeof m[k])) : 'none (' + (manifest ? 'unparsed' : 'absent') + ')'
}, null, 1))
