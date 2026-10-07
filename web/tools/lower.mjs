// Lowers a bundle to ES5 for iOS 6 with Surfari's jsfix.js (the same file the app on the iPad runs).
// What a classic script cannot hold is rewritten first: export statements, import.meta, and regular expressions with
// lookbehind (the old engine refuses the whole script for them; __vsc_re() builds a looser one at run time).
// Usage: node lower.mjs <input.js> <output.js> [--module]
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tp = path.join(here, '..', 'tp')
const [input, output] = process.argv.slice(2)
const asModule = process.argv.includes('--module')
const t0 = Date.now()
const since = () => ((Date.now() - t0) / 1000).toFixed(1) + ' s'

const ctx = vm.createContext({ console })
for (const f of ['acorn.js', 'unicode-props.js', 'jsfix.js']) {
  vm.runInContext(fs.readFileSync(path.join(tp, f), 'utf8'), ctx, { filename: f })
}
const { acorn, JSFix } = ctx

// every property name the code reads with a dot: an ES5 engine intercepts only keys that exist as accessors, so the
// Proxy stand-in gets them all in advance (VS Code calls methods of its RPC and service proxies by name)
const memberNames = new Set()

// CSS custom properties in the code's own strings: VS Code writes colours as var(--vscode-...) into style attributes and
// the stylesheets it makes, which the iOS 6 engine drops. Every string and template literal with a var(--...) becomes
// __kd_cssVar(<it>), which puts the current theme's values in on an engine without custom properties (vsc-prelude.js).
// (Not property keys, case labels or directives; a tagged template is wrapped as a whole.)
const hasVar = (s) => typeof s === 'string' && s.indexOf('var(--') >= 0
const templateHasVar = (t) => t.quasis.some((q, i) => hasVar(q.value.cooked) || (i < t.quasis.length - 1 && /var\(\s*$/.test(q.value.cooked || '')))

function prepare(src) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: asModule ? 'module' : 'script', allowHashBang: true, allowImportExportEverywhere: true })
  const edits = []
  const counts = {}
  const note = (w) => { counts[w] = (counts[w] || 0) + 1 }
  // (with a space before it: minified code has return`...` and case"..." with nothing between)
  const wrapVar = (n) => { edits.push([n.start, n.start, ' __kd_cssVar(']); edits.push([n.end, n.end, ')']); note('css var string') }
  // (each node with its parent: two stacks side by side)
  const stack = [ast], parentStack = [null]
  while (stack.length) {
    const n = stack.pop()
    const parent = parentStack.pop()
    if (n.type === 'Literal' && hasVar(n.value) && !(parent && (
      (parent.type === 'Property' && parent.key === n) || (parent.type === 'MethodDefinition' && parent.key === n) ||
      (parent.type === 'PropertyDefinition' && parent.key === n) || parent.type === 'SwitchCase' ||
      parent.type === 'ImportDeclaration' || parent.type === 'ExportAllDeclaration' || parent.type === 'ExportNamedDeclaration' ||
      (parent.type === 'ExpressionStatement' && parent.directive)))) wrapVar(n)
    else if (n.type === 'TemplateLiteral' && !(parent && parent.type === 'TaggedTemplateExpression') && templateHasVar(n)) wrapVar(n)
    else if (n.type === 'TaggedTemplateExpression' && templateHasVar(n.quasi)) wrapVar(n)
    if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') memberNames.add(n.property.name)
    if (n.type === 'ExportNamedDeclaration') {
      if (n.declaration) edits.push([n.start, n.declaration.start, ''])
      else edits.push([n.start, n.end, ';'])
      note('export')
    } else if (n.type === 'ExportDefaultDeclaration') {
      edits.push([n.start, n.declaration.start, 'var __vsc_export_default = '])
      edits.push([n.declaration.end, n.declaration.end, ';'])
      note('export default')
    } else if (n.type === 'ExportAllDeclaration' || n.type === 'ImportDeclaration') {
      edits.push([n.start, n.end, ';'])
      note(n.type)
    } else if (n.type === 'MetaProperty' && n.meta.name === 'import') {
      edits.push([n.start, n.end, '__vsc_meta'])
      note('import.meta')
    } else if (n.type === 'Literal' && n.regex && /\(\?<[=!]/.test(n.regex.pattern)) {
      edits.push([n.start, n.end, '__vsc_re(' + JSON.stringify(n.regex.pattern) + ',' + JSON.stringify(n.regex.flags) + ')'])
      note('lookbehind regex')
    }
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue
      const v = n[k]
      if (!v || typeof v !== 'object') continue
      if (Array.isArray(v)) { for (let i = v.length - 1; i >= 0; i--) if (v[i] && typeof v[i].type === 'string') { stack.push(v[i]); parentStack.push(n) } }
      else if (typeof v.type === 'string') { stack.push(v); parentStack.push(n) }
    }
  }
  console.log('edits:', JSON.stringify(counts), since())
  edits.sort((a, b) => b[0] - a[0] || b[1] - a[1])
  const parts = []
  let end = src.length
  for (const e of edits) {
    if (e[1] > end) throw new Error('overlapping edits at ' + e[0])
    parts.push(src.slice(e[1], end), e[2])
    end = e[0]
  }
  parts.push(src.slice(0, end))
  return parts.reverse().join('')
}

// The loops of the bundle's biggest function - the IIFE in which every module's top level runs - each in a little
// function of its own. JSC counts a function's loop iterations towards compiling it with its baseline JIT: about a
// hundred of them in the modules' top levels (keyCodes' tables were the first) and it compiled the whole bundle's top
// level, run once - 0.8 s of the start on the iPad 2, gone (the rest ran no slower without the JIT). The loop's own
// declarations stay in the big function, where later code reads them. (After the minifier, which merges declarations
// into a loop's head.)
function loopsOutOfTheBigFunction(src) {
  const ast = acorn.parse(src, { ecmaVersion: 5 })
  const isFn = (n) => n && (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration')
  const children = (n, f) => { for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && f(c)); else if (v && typeof v.type === 'string') f(v) } }
  let big = null
  const findBig = (n) => { if (isFn(n)) { if (!big || n.end - n.start > big.end - big.start) big = n; return } children(n, findBig) }
  findBig(ast)
  if (!big) return src
  const LOOPS = new Set(['ForStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement'])
  const found = []
  const findLoops = (n, parent) => {
    if (n !== big && isFn(n)) return
    if (LOOPS.has(n.type)) { found.push({ loop: n, target: parent && parent.type === 'LabeledStatement' ? parent : n }); return }
    children(n, (c) => findLoops(c, n))
  }
  findLoops(big.body, null)
  // (a loop stays where its body returns, reads arguments, or breaks to a label outside it)
  const movable = (target) => {
    let ok = true
    const labels = new Set()
    const check = (n) => {
      if (!ok || isFn(n)) return
      if (n.type === 'ReturnStatement' || (n.type === 'Identifier' && n.name === 'arguments')) ok = false
      if (n.type === 'LabeledStatement') labels.add(n.label.name)
      if ((n.type === 'BreakStatement' || n.type === 'ContinueStatement') && n.label && !labels.has(n.label.name)) ok = false
      children(n, check)
    }
    check(target)
    return ok
  }
  const edits = []
  for (const { loop, target } of found) {
    if (!movable(target)) continue
    let before = '', text = src.slice(target.start, target.end)
    const decl = loop.type === 'ForStatement' ? loop.init : loop.type === 'ForInStatement' ? loop.left : null
    if (decl && decl.type === 'VariableDeclaration') {
      if (loop.type === 'ForStatement') {
        before = 'var ' + decl.declarations.map((d) => src.slice(d.start, d.end)).join(',') + ';'
        text = src.slice(target.start, decl.start) + src.slice(decl.end, target.end)
      } else {
        before = 'var ' + decl.declarations[0].id.name + ';'
        text = src.slice(target.start, decl.start) + decl.declarations[0].id.name + src.slice(decl.end, target.end)
      }
    }
    edits.push([target.start, target.end, '{' + before + '(function(){' + text + '}).call(this);}'])
  }
  edits.sort((a, b) => b[0] - a[0])
  let out = src
  for (const [s, e, t] of edits) out = out.slice(0, s) + t + out.slice(e)
  console.log('loops out of the big function:', edits.length, 'of', found.length, since())
  return out
}

// Vite's IIFE output resolves its assets (the default themes' files, icons) against the running script's src, or the
// document's address: the page runs the bundle as an inline script (index.html), which has no src - those went to the
// site's root. The bundle's address instead (window.__vsc_meta, set by the page).
const VITE_ASSET_BASE = 'document.currentScript&&document.currentScript.tagName.toUpperCase()==="SCRIPT"&&document.currentScript.src||document.baseURI'
// And each asset's address was two URL objects, new URL(""+new URL(file, base).href, <the script's src>): the engine's
// URL (core-js's, in JavaScript) takes 6 ms a URL on the iPad 2, and the built-in extensions register their files when
// the bundle starts - half a second of the start. The file's address made of strings instead (__kdAsset, vsc-prelude.js:
// an object with href and toString, as the code reads them).
const ASSET_URL = /new URL\(""\+new URL\("([^"]+)",__vsc_meta\.url\)\.href,([A-Za-z_$][\w$]*)&&\2\.tagName\.toUpperCase\(\)==="SCRIPT"&&\2\.src\|\|new URL\("assets\/workbench\.js",document\.baseURI\)\.href\)/g
let assetURLs = 0
const src = fs.readFileSync(input, 'utf8').split(VITE_ASSET_BASE).join('__vsc_meta.url')
  .replace(ASSET_URL, (_, file) => { assetURLs++; return '__kdAsset(' + JSON.stringify(file) + ')' })
console.log('read', input, src.length, 'characters,', assetURLs, 'asset URLs made of strings')
const text = prepare(src)
acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script' })
console.log('prepared text parses as a script', since())
let out = JSFix.run(text, JSON.stringify({ force: true, bigint: true, proxy: true, url: 'http://vsc.invalid/' + path.basename(input) }))
console.log('jsfix:', JSFix.last(), '|', JSFix.note(), '|', out ? out.length : 0, 'characters', since())
if (!out) throw new Error('jsfix gave nothing: ' + JSFix.last())
try {
  // jsfix puts the helpers it uses in front as global function declarations, which replace the page's when the
  // script starts: the page's prelude wraps them again first thing (__vsc_afterHelpers)
  const es5 = acorn.parse(out, { ecmaVersion: 5 })
  console.log('ES5 check: OK', since())
  const first = es5.body.find((st) => !(st.type === 'FunctionDeclaration' && st.id.name.startsWith('__br_')))
  if (first) out = out.slice(0, first.start) + 'typeof __vsc_afterHelpers=="function"&&__vsc_afterHelpers();\n' + out.slice(first.start)
  // Short names and no white space (esbuild, Vite's own minifier; nothing else is changed): the lowering's temporaries
  // (_this$46s626321...) were 2.6 MB, and the iOS 6 engine keeps a script's whole text for as long as the page lives
  // (a function is compiled from it when first called). The globals - the helpers, __vsc_*, __kd_* - keep their names.
  // ASCII only (the rest as \u escapes, 0.4 MB more): with 72,000 characters beyond Latin-1 the engine held the text as
  // UTF-16, 25 MB, and lexed it as such; ASCII can stay 8-bit.
  const { transformSync } = await import('esbuild')
  const before = out.length
  // (minifySyntax too: the engine keeps the text as UTF-16 for as long as the page lives, two bytes a character)
  // (lines of about 1000 characters, not one line: WebKit's profiler and error stacks name a function by its line, and
  // the minified names say nothing - a line of the file points at the code)
  out = transformSync(out, { minifyIdentifiers: true, minifyWhitespace: true, minifySyntax: true, target: 'es5', charset: 'ascii', legalComments: 'none', lineLimit: 1000 }).code
  acorn.parse(out, { ecmaVersion: 5 })
  console.log('minified:', (before / 1048576).toFixed(1), 'MB ->', (out.length / 1048576).toFixed(1), 'MB, still ES5', since())
  out = loopsOutOfTheBigFunction(out)
  acorn.parse(out, { ecmaVersion: 5 })
} catch (e) {
  console.log('ES5 check FAILED:', e.message, e.pos !== undefined ? JSON.stringify(out.substr(Math.max(0, e.pos - 160), 320)) : '')
  process.exitCode = 1
}
fs.writeFileSync(output, out)
console.log('written', output, fs.statSync(output).size, 'bytes', since())

// the names for the Proxy stand-in (jsfix-helpers' __br_Proxy keeps one shared prototype of accessors for proxies
// that only have a get trap): added to it before the bundle runs. Only the names such proxies are read by - the
// methods ($name) and events (onName) of the RPC and IPC proxies: VS Code's services are no proxies here (eagerServices
// in vite.config.mjs), and every name is two closures on the iPad (all 36,000 of them were megabytes)
const skip = new Set(Object.getOwnPropertyNames(Object.prototype).concat(Object.getOwnPropertyNames(Function.prototype), ['prototype', 'length', 'name', 'arguments', 'caller']))
// And the methods of the language workers (JSON, CSS, HTML: their *Worker classes), which the page calls through
// monaco's proxy of a worker's module (a get-only Proxy too: doValidation, doComplete...)
const workerMethods = new Set()
for (const lang of ['json', 'css', 'html']) {
  const file = path.join(here, '..', 'node_modules', '@codingame', `monaco-vscode-standalone-${lang}-language-features`, 'languages', 'features', lang, lang + 'Worker.js')
  if (!fs.existsSync(file)) continue
  const stack = [acorn.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' })]
  while (stack.length) {
    const n = stack.pop()
    if (!n || typeof n.type !== 'string') continue
    if (n.type === 'MethodDefinition' && n.kind === 'method' && !n.static && n.key.type === 'Identifier') workerMethods.add(n.key.name)
    for (const k in n) {
      const v = n[k]
      if (Array.isArray(v)) stack.push(...v)
      else if (v && typeof v.type === 'string') stack.push(v)
    }
  }
}
const names = [...new Set([...memberNames, ...workerMethods])].filter((n) => !skip.has(n) && !n.startsWith('__br_') &&
  (n[0] === '$' || /^on[A-Z]/.test(n) || workerMethods.has(n))).sort()
const namesScript = `/* property names of ${path.basename(input)}, for the Proxy stand-in (see vsc-prelude.js) */
window.__vsc_proxyNames = ${JSON.stringify(names.join(' '))}.split(' ');
`
const namesFile = output.replace(/\.js$/, '') + '.names.js'
fs.writeFileSync(namesFile, namesScript)
console.log('names for the Proxy stand-in:', names.length, '->', namesFile)
// (CI runners of private repositories have 7 GB)
console.log('peak memory:', Math.round(process.resourceUsage().maxRSS / 1024), 'MB')
