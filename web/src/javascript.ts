// JavaScript without a language server. VS Code's comes from TypeScript's language service, which needs more memory
// than the iPad 2 has to spare (a worker of tens of megabytes); Kodium has a parser (acorn) and a formatter (js-beautify)
// instead, and only when they are asked:
// - syntax errors as problems (squiggles, the Problems view), checked once typing pauses - in a worker of their own
//   (workers/javascript.worker.ts): acorn took 0.9-1.4 s for a file of 1,500 lines on the iPad 2, and a key typed
//   then waited for it on the page's thread;
// - the file's symbols - functions, classes and their members, variables - for the outline, the breadcrumbs and Go to
//   Symbol in Editor (Ctrl+Shift+O), from the same worker;
// - Format Document (Shift+Alt+F);
// - Go to Definition (F12), Find All References (Shift+F12) and Rename Symbol (F2), within the file: which declaration
//   a name means is worked out from the file's scopes when one of them is asked for (parsed on the page's thread).
// (a .jsx file is JavaScript to Kodium's grammar, but acorn does not read JSX: no syntax check there)
import { editor, languages, MarkerSeverity, type IDisposable } from 'monaco-editor'
import { Parser, type Node } from 'acorn'
import beautify from 'js-beautify/js/lib/beautify.js'
import { parseOptions, documentSymbols, range, type AnyNode, type JsSymbol } from './jsSymbols'

const LANGUAGE = 'javascript'
const OWNER = 'kodium-javascript'
const TOO_BIG = 400 * 1024   // (characters: a bigger file is neither checked nor outlined)
const cs = /^cs/i.test((window as { __kd_lang?: string }).__kd_lang || '')

// acorn's messages in Czech, the common ones (the rest stay as acorn says them)
const CZECH: [RegExp, string][] = [
  [/^Unexpected token$/, 'Neočekávaný symbol'],
  [/^Unexpected character '(.*)'$/, 'Neočekávaný znak „$1“'],
  [/^Unterminated string constant$/, 'Neukončený řetězec'],
  [/^Unterminated template$/, 'Neukončená šablona (template literal)'],
  [/^Unterminated regular expression$/, 'Neukončený regulární výraz'],
  [/^Unterminated comment$/, 'Neukončený komentář'],
  [/^Identifier '(.*)' has already been declared$/, 'Identifikátor „$1“ už je deklarovaný'],
  [/^'return' outside of function$/, '„return“ mimo funkci'],
  [/^Unexpected keyword '(.*)'$/, 'Neočekávané klíčové slovo „$1“'],
  [/^The keyword '(.*)' is reserved$/, 'Klíčové slovo „$1“ je rezervované'],
  [/^Unexpected reserved word$/, 'Neočekávané rezervované slovo'],
  [/^Assigning to rvalue$/, 'Sem nelze přiřadit'],
  [/^Invalid regular expression flag$/, 'Neplatný příznak regulárního výrazu'],
  [/^Invalid regular expression: (.*)$/, 'Neplatný regulární výraz: $1'],
  [/^Invalid number$/, 'Neplatné číslo'],
  [/^Octal literal in strict mode$/, 'Osmičkové číslo ve striktním režimu'],
  [/^Expecting Unicode escape sequence \\uXXXX$/, 'Očekává se sekvence \\uXXXX'],
  [/^Unexpected string$/, 'Neočekávaný řetězec']
]
const message = (raw: string) => {
  const text = raw.replace(/ \(\d+:\d+\)$/, '')
  if (!cs) return text
  for (const [pattern, czech] of CZECH) if (pattern.test(text)) return text.replace(pattern, czech)
  return text
}

type SyntaxProblem = { message: string, pos: number, end: number }
type Parsed = { version: number, program: Node | null, error: SyntaxProblem | null }
const parsed = new Map<string, Parsed>()
const lastSymbols = new Map<string, languages.DocumentSymbol[]>()

// the file's tree on the page's thread, for its scopes (definitions, references, renames)
function parse(model: editor.ITextModel): Parsed {
  const key = model.uri.toString(), version = model.getVersionId()
  const known = parsed.get(key)
  if (known && known.version === version) return known
  const text = model.getValue()
  let result: Parsed
  try {
    const program = Parser.parse(text, parseOptions(text)) as unknown as Node
    result = { version, program, error: null }
  } catch (e) {
    const err = e as { message?: string, pos?: number, raisedAt?: number }
    const pos = typeof err.pos === 'number' ? err.pos : 0
    result = { version, program: null, error: { message: message(String(err.message || e)), pos, end: Math.max(pos + 1, err.raisedAt || 0) } }
  }
  parsed.set(key, result)
  return result
}

// ---- the worker: a file's syntax error or its symbols, by the file's version. It goes after a minute without a
// request (and when memory runs short, src/memory.ts); a page whose worker does not start parses on its own thread.
// (stale: the worker was let go before it answered - nothing known then)
type Checked = { version: number, error: SyntaxProblem | null, symbols: languages.DocumentSymbol[] | null, stale?: boolean }
type Reply = { id: number, error: { message: string, pos: number, raisedAt: number } | null, symbols: JsSymbol[] | null }
const SITE = location.href.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '')
const pending = new Map<number, (reply: Reply | null) => void>()
const checking = new Map<string, { version: number, result: Promise<Checked> }>()
let nextId = 1, broken = false, idleTimer: number | undefined
const worker = {
  _worker: null as Worker | null,
  _lastUsedTime: 0,
  _stopWorker() {
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
    this._worker?.terminate()
    this._worker = null
    for (const done of pending.values()) done(null)
    pending.clear()
  }
}
;((self as { __kdWorkerManagers?: unknown[] }).__kdWorkerManagers || ((self as { __kdWorkerManagers?: unknown[] }).__kdWorkerManagers = [])).push(worker)
function ask(text: string): Promise<Reply | null> {
  if (broken) return Promise.resolve(null)
  if (!worker._worker) {
    try {
      const w = new Worker(SITE + '/assets/workers/javascript.worker.es5.js')
      w.onmessage = (e: MessageEvent) => {
        const reply = e.data as Reply, done = pending.get(reply.id)
        pending.delete(reply.id)
        done?.(reply)
      }
      w.onerror = () => { broken = true; worker._stopWorker() }
      worker._worker = w
    } catch { broken = true; return Promise.resolve(null) }
  }
  worker._lastUsedTime = Date.now()
  if (idleTimer !== undefined) clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => { idleTimer = undefined; if (!pending.size) worker._stopWorker() }, 60 * 1000)
  const id = nextId++
  return new Promise((resolve) => { pending.set(id, resolve); worker._worker!.postMessage({ id, text }) })
}
// (the same version asked for twice - the check and the outline - goes to the worker once)
function checked(model: editor.ITextModel): Promise<Checked> {
  const key = model.uri.toString(), version = model.getVersionId()
  const known = checking.get(key)
  if (known && known.version === version) return known.result
  const result = ask(model.getValue()).then((reply): Checked => {
    if (!reply && !broken) {
      if (checking.get(key)?.result === result) checking.delete(key)
      return { version, error: null, symbols: null, stale: true }
    }
    if (!reply) {
      const { program, error } = parse(model)
      return { version, error, symbols: program ? documentSymbols(program) as languages.DocumentSymbol[] : null }
    }
    const error = reply.error && { message: message(reply.error.message), pos: reply.error.pos, end: Math.max(reply.error.pos + 1, reply.error.raisedAt) }
    return { version, error, symbols: reply.symbols as languages.DocumentSymbol[] | null }
  })
  checking.set(key, { version, result })
  return result
}

// ---- syntax errors, once typing pauses (and the page is idle: vsc-prelude.js holds idle work while keys come)
const marked = new Set<string>()   // (the files with a problem of ours: only theirs are cleared)
function clear(model: editor.ITextModel): void {
  if (marked.delete(model.uri.toString())) editor.setModelMarkers(model, OWNER, [])
}
async function check(model: editor.ITextModel): Promise<void> {
  if (model.isDisposed() || model.getLanguageId() !== LANGUAGE) return
  if (/\.jsx$/i.test(model.uri.path) || model.getValueLength() > TOO_BIG) { clear(model); return }
  const { version, error, stale } = await checked(model)
  // (an answer for a version the file no longer has: the next check comes)
  if (stale || model.isDisposed() || model.getVersionId() !== version || model.getLanguageId() !== LANGUAGE) return
  if (!error) { clear(model); return }
  const start = model.getPositionAt(error.pos), end = model.getPositionAt(Math.min(error.end, model.getValueLength()))
  const sameSpot = end.lineNumber === start.lineNumber && end.column <= start.column
  marked.add(model.uri.toString())
  editor.setModelMarkers(model, OWNER, [{
    severity: MarkerSeverity.Error, source: 'JavaScript', message: error.message,
    startLineNumber: start.lineNumber, startColumn: start.column,
    endLineNumber: sameSpot ? start.lineNumber : end.lineNumber, endColumn: sameSpot ? start.column + 1 : end.column
  }])
}

function watch(model: editor.ITextModel): void {
  let timer: number | undefined, listening: IDisposable | undefined
  const later = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = window.setTimeout(() => { timer = undefined; window.requestIdleCallback(() => { void check(model) }) }, 600)
  }
  const follow = () => {
    listening?.dispose()
    listening = undefined
    if (model.getLanguageId() === LANGUAGE) { listening = model.onDidChangeContent(later); later() }
    else clear(model)
  }
  follow()
  model.onDidChangeLanguage(follow)
  model.onWillDispose(() => {
    if (timer !== undefined) clearTimeout(timer)
    listening?.dispose()
    parsed.delete(model.uri.toString())
    checking.delete(model.uri.toString())
    analyses.delete(model.uri.toString())
    lastSymbols.delete(model.uri.toString())
    // (its problem goes with it: the markers outlive the model, and the file opened again without the error kept it -
    // only a file in `marked` is cleared)
    clear(model)
  })
}

// ---- the file's symbols (the worker's; while the file does not parse - in the middle of typing - the last symbols
// that did)
async function symbols(model: editor.ITextModel): Promise<languages.DocumentSymbol[]> {
  const key = model.uri.toString()
  if (model.getValueLength() > TOO_BIG || /\.jsx$/i.test(model.uri.path)) return lastSymbols.get(key) || []
  const { symbols: found } = await checked(model)
  if (!found) return lastSymbols.get(key) || []
  lastSymbols.set(key, found)
  return found
}

// ---- definitions, references and renames, within the file: which declaration each name means (JavaScript's scopes:
// var and function declarations hoisted to their function, let/const/class to their block, parameters, catch,
// imports, a named function expression's own name). A name declared nowhere in the file is a global of the file.
type Binding = { name: string, decls: AnyNode[], refs: AnyNode[] }
type Scope = { parent: Scope | null, names: Map<string, Binding>, isFunction: boolean }
// (shorthand: the occurrence is also a property's or a specifier's name - {a}, import {a}, export {a} - which a rename
// must keep)
type Occurrence = { node: AnyNode, binding: Binding, shorthand: 'property' | 'import' | 'export' | null }
type Analysis = { version: number, occurrences: Occurrence[] }
const analyses = new Map<string, Analysis>()

function analyse(model: editor.ITextModel): Analysis | null {
  const key = model.uri.toString(), version = model.getVersionId()
  const known = analyses.get(key)
  if (known && known.version === version) return known
  if (model.getValueLength() > TOO_BIG || /\.jsx$/i.test(model.uri.path)) return null
  const { program } = parse(model)
  if (!program) return null
  const occurrences: Occurrence[] = []
  const root: Scope = { parent: null, names: new Map(), isFunction: true }
  const shorthands = new Map<AnyNode, Occurrence['shorthand']>()

  const binding = (scope: Scope, name: string): Binding => {
    let b = scope.names.get(name)
    if (!b) { b = { name, decls: [], refs: [] }; scope.names.set(name, b) }
    return b
  }
  const functionScope = (scope: Scope): Scope => { let s = scope; while (!s.isFunction && s.parent) s = s.parent; return s }
  const declare = (scope: Scope, id: AnyNode) => {
    const b = binding(scope, id.name)
    if (b.decls.indexOf(id) < 0) { b.decls.push(id); occurrences.push({ node: id, binding: b, shorthand: shorthands.get(id) || null }) }
  }
  const lookup = (scope: Scope, name: string): Binding => {
    for (let s: Scope | null = scope; s; s = s.parent) { const b = s.names.get(name); if (b) return b }
    return binding(root, name)   // (a global)
  }
  const reference = (scope: Scope, id: AnyNode) => {
    const b = lookup(scope, id.name)
    b.refs.push(id)
    occurrences.push({ node: id, binding: b, shorthand: shorthands.get(id) || null })
  }

  // the names a pattern binds (and the expressions in it: defaults, computed keys)
  const patternNames = (p: AnyNode | null, out: AnyNode[], exprs: AnyNode[]) => {
    if (!p) return
    switch (p.type) {
      case 'Identifier': out.push(p); break
      case 'ObjectPattern':
        for (const prop of p.properties) {
          if (prop.type === 'RestElement') { patternNames(prop.argument, out, exprs); continue }
          if (prop.computed) exprs.push(prop.key)
          if (prop.shorthand && prop.value.type === 'Identifier') shorthands.set(prop.value, 'property')
          else if (prop.shorthand && prop.value.type === 'AssignmentPattern' && prop.value.left.type === 'Identifier') shorthands.set(prop.value.left, 'property')
          patternNames(prop.value, out, exprs)
        }
        break
      case 'ArrayPattern': for (const e of p.elements) patternNames(e, out, exprs); break
      case 'RestElement': patternNames(p.argument, out, exprs); break
      case 'AssignmentPattern': patternNames(p.left, out, exprs); exprs.push(p.right); break
    }
  }
  const declarePattern = (scope: Scope, p: AnyNode, walkScope: Scope) => {
    const names: AnyNode[] = [], exprs: AnyNode[] = []
    patternNames(p, names, exprs)
    for (const id of names) declare(scope, id)
    for (const e of exprs) expression(e, walkScope)
  }

  // hoisting: the var and function declarations of a function's (or the program's) body, not inside nested functions
  const hoistVars = (node: AnyNode | null, scope: Scope) => {
    if (!node) return
    switch (node.type) {
      case 'VariableDeclaration':
        if (node.kind === 'var') for (const d of node.declarations) { const names: AnyNode[] = []; patternNames(d.id, names, []); for (const id of names) declare(scope, id) }
        return
      case 'BlockStatement': case 'StaticBlock': for (const s of node.body) hoistVars(s, scope); return
      case 'IfStatement': hoistVars(node.consequent, scope); hoistVars(node.alternate, scope); return
      case 'ForStatement': hoistVars(node.init, scope); hoistVars(node.body, scope); return
      case 'ForInStatement': case 'ForOfStatement': hoistVars(node.left, scope); hoistVars(node.body, scope); return
      case 'WhileStatement': case 'DoWhileStatement': case 'LabeledStatement': case 'WithStatement': hoistVars(node.body, scope); return
      case 'TryStatement': hoistVars(node.block, scope); if (node.handler) hoistVars(node.handler.body, scope); hoistVars(node.finalizer, scope); return
      case 'SwitchStatement': for (const c of node.cases) for (const s of c.consequent) hoistVars(s, scope); return
      case 'ExportNamedDeclaration': hoistVars(node.declaration, scope); return
    }
  }
  // a block's own declarations: let, const, class, and functions (those of a function's body too)
  const hoistLexical = (statements: AnyNode[], scope: Scope) => {
    for (let s of statements) {
      if (s.type === 'ExportNamedDeclaration' && s.declaration) s = s.declaration
      else if (s.type === 'ExportDefaultDeclaration' && (s.declaration.type === 'FunctionDeclaration' || s.declaration.type === 'ClassDeclaration')) s = s.declaration
      if (s.type === 'VariableDeclaration' && s.kind !== 'var') for (const d of s.declarations) { const names: AnyNode[] = []; patternNames(d.id, names, []); for (const id of names) declare(scope, id) }
      else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) declare(scope, s.id)
      else if (s.type === 'ImportDeclaration') {
        for (const sp of s.specifiers) {
          if (sp.type === 'ImportSpecifier' && sp.imported && sp.imported.type === 'Identifier' && sp.imported.name === sp.local.name && sp.imported.start === sp.local.start) shorthands.set(sp.local, 'import')
          declare(scope, sp.local)
        }
      }
    }
  }

  const functionNode = (fn: AnyNode, outer: Scope) => {
    let scope = outer
    if (fn.type === 'FunctionExpression' && fn.id) { scope = { parent: outer, names: new Map(), isFunction: false }; declare(scope, fn.id) }
    const inner: Scope = { parent: scope, names: new Map(), isFunction: true }
    for (const p of fn.params) declarePattern(inner, p, inner)
    if (fn.body.type === 'BlockStatement') {
      hoistVars(fn.body, inner)
      hoistLexical(fn.body.body, inner)
      for (const s of fn.body.body) statement(s, inner)
    } else expression(fn.body, inner)
  }
  const classNode = (cls: AnyNode, outer: Scope) => {
    let scope = outer
    if (cls.type === 'ClassExpression' && cls.id) { scope = { parent: outer, names: new Map(), isFunction: false }; declare(scope, cls.id) }
    if (cls.superClass) expression(cls.superClass, scope)
    for (const m of cls.body.body) {
      if (m.type === 'StaticBlock') { const b: Scope = { parent: scope, names: new Map(), isFunction: true }; hoistVars(m, b); hoistLexical(m.body, b); for (const s of m.body) statement(s, b); continue }
      if (m.computed) expression(m.key, scope)
      if (m.value) { if (m.type === 'MethodDefinition') functionNode(m.value, scope); else expression(m.value, scope) }
    }
  }
  const block = (statements: AnyNode[], outer: Scope) => {
    const scope: Scope = { parent: outer, names: new Map(), isFunction: false }
    hoistLexical(statements, scope)
    for (const s of statements) statement(s, scope)
  }
  const declaration = (d: AnyNode, scope: Scope) => {
    // (its names were hoisted; the defaults and computed keys of its patterns are expressions, then its value)
    const exprs: AnyNode[] = []
    patternNames(d.id, [], exprs)
    for (const e of exprs) expression(e, scope)
    if (d.init) expression(d.init, scope)
  }

  const statement = (s: AnyNode | null, scope: Scope): void => {
    if (!s) return
    switch (s.type) {
      case 'ExpressionStatement': expression(s.expression, scope); break
      case 'BlockStatement': block(s.body, scope); break
      case 'StaticBlock': block(s.body, scope); break
      case 'VariableDeclaration': for (const d of s.declarations) declaration(d, scope); break
      case 'FunctionDeclaration': functionNode(s, scope); break
      case 'ClassDeclaration': classNode(s, scope); break
      case 'ReturnStatement': case 'ThrowStatement': expression(s.argument, scope); break
      case 'IfStatement': expression(s.test, scope); statement(s.consequent, scope); statement(s.alternate, scope); break
      case 'LabeledStatement': statement(s.body, scope); break
      case 'WithStatement': expression(s.object, scope); statement(s.body, scope); break
      case 'WhileStatement': expression(s.test, scope); statement(s.body, scope); break
      case 'DoWhileStatement': statement(s.body, scope); expression(s.test, scope); break
      case 'ForStatement': {
        const loop: Scope = { parent: scope, names: new Map(), isFunction: false }
        if (s.init && s.init.type === 'VariableDeclaration') { hoistLexical([s.init], loop); statement(s.init, loop) } else expression(s.init, loop)
        expression(s.test, loop); expression(s.update, loop); statement(s.body, loop)
        break
      }
      case 'ForInStatement': case 'ForOfStatement': {
        const loop: Scope = { parent: scope, names: new Map(), isFunction: false }
        if (s.left.type === 'VariableDeclaration') { hoistLexical([s.left], loop); statement(s.left, loop) } else target(s.left, loop)
        expression(s.right, loop); statement(s.body, loop)
        break
      }
      case 'TryStatement':
        statement(s.block, scope)
        if (s.handler) {
          const c: Scope = { parent: scope, names: new Map(), isFunction: false }
          if (s.handler.param) declarePattern(c, s.handler.param, c)
          statement(s.handler.body, c)
        }
        statement(s.finalizer, scope)
        break
      case 'SwitchStatement': {
        expression(s.discriminant, scope)
        const cases: Scope = { parent: scope, names: new Map(), isFunction: false }
        const all: AnyNode[] = []
        for (const c of s.cases) all.push(...c.consequent)
        hoistLexical(all, cases)
        for (const c of s.cases) { expression(c.test, cases); for (const x of c.consequent) statement(x, cases) }
        break
      }
      case 'ExportNamedDeclaration':
        if (s.declaration) statement(s.declaration, scope)
        else if (!s.source) for (const sp of s.specifiers) {
          if (sp.local.type !== 'Identifier') continue
          if (sp.exported && sp.exported.type === 'Identifier' && sp.exported.start === sp.local.start) shorthands.set(sp.local, 'export')
          reference(scope, sp.local)
        }
        break
      case 'ExportDefaultDeclaration':
        if (s.declaration.type === 'FunctionDeclaration') functionNode(s.declaration, scope)
        else if (s.declaration.type === 'ClassDeclaration') classNode(s.declaration, scope)
        else expression(s.declaration, scope)
        break
    }
  }
  // an assignment's target: names are references (written), patterns hold more of them
  const target = (t: AnyNode | null, scope: Scope): void => {
    if (!t) return
    switch (t.type) {
      case 'Identifier': reference(scope, t); break
      case 'ObjectPattern':
        for (const p of t.properties) {
          if (p.type === 'RestElement') { target(p.argument, scope); continue }
          if (p.computed) expression(p.key, scope)
          if (p.shorthand && p.value.type === 'Identifier') shorthands.set(p.value, 'property')
          target(p.value, scope)
        }
        break
      case 'ArrayPattern': for (const e of t.elements) target(e, scope); break
      case 'RestElement': target(t.argument, scope); break
      case 'AssignmentPattern': target(t.left, scope); expression(t.right, scope); break
      default: expression(t, scope)
    }
  }
  const expression = (e: AnyNode | null, scope: Scope): void => {
    if (!e) return
    switch (e.type) {
      case 'Identifier': reference(scope, e); break
      case 'FunctionExpression': case 'ArrowFunctionExpression': functionNode(e, scope); break
      case 'ClassExpression': classNode(e, scope); break
      case 'MemberExpression': expression(e.object, scope); if (e.computed) expression(e.property, scope); break
      case 'ObjectExpression':
        for (const p of e.properties) {
          if (p.type === 'SpreadElement') { expression(p.argument, scope); continue }
          if (p.computed) expression(p.key, scope)
          if (p.shorthand && p.value.type === 'Identifier') shorthands.set(p.value, 'property')
          if (p.method || p.kind === 'get' || p.kind === 'set') functionNode(p.value, scope)
          else expression(p.value, scope)
        }
        break
      case 'AssignmentExpression': target(e.left, scope); expression(e.right, scope); break
      case 'UpdateExpression': case 'UnaryExpression': case 'SpreadElement': case 'AwaitExpression': case 'YieldExpression': expression(e.argument, scope); break
      case 'BinaryExpression': case 'LogicalExpression': expression(e.left, scope); expression(e.right, scope); break
      case 'ConditionalExpression': expression(e.test, scope); expression(e.consequent, scope); expression(e.alternate, scope); break
      case 'CallExpression': case 'NewExpression': expression(e.callee, scope); for (const a of e.arguments) expression(a, scope); break
      case 'ArrayExpression': for (const x of e.elements) expression(x, scope); break
      case 'SequenceExpression': for (const x of e.expressions) expression(x, scope); break
      case 'TemplateLiteral': for (const x of e.expressions) expression(x, scope); break
      case 'TaggedTemplateExpression': expression(e.tag, scope); expression(e.quasi, scope); break
      case 'ChainExpression': case 'ParenthesizedExpression': expression(e.expression, scope); break
      case 'ImportExpression': expression(e.source, scope); break
    }
  }

  const body = (program as AnyNode).body as AnyNode[]
  hoistVars({ type: 'BlockStatement', body } as AnyNode, root)
  hoistLexical(body, root)
  for (const s of body) statement(s, root)
  occurrences.sort((a, b) => a.node.start - b.node.start)
  const result = { version, occurrences }
  analyses.set(key, result)
  return result
}

function occurrenceAt(model: editor.ITextModel, position: { lineNumber: number, column: number }): Occurrence | null {
  const analysis = analyse(model)
  if (!analysis) return null
  const offset = model.getOffsetAt(position)
  for (const o of analysis.occurrences) {
    if (o.node.start > offset) break
    if (offset <= o.node.end) return o
  }
  return null
}
const where = (model: editor.ITextModel, node: AnyNode): languages.Location => ({ uri: model.uri, range: range(node) })

const KEYWORDS = new Set(('break case catch class const continue debugger default delete do else export extends false finally for function if ' +
  'import in instanceof new null return super switch this throw true try typeof var void while with yield let static enum await implements ' +
  'package protected interface private public arguments eval').split(' '))
const T = cs
  ? { cannot: 'Tohle nelze přejmenovat (není to jméno deklarované v tomto souboru).', invalid: '„{0}“ není platný identifikátor JavaScriptu.' }
  : { cannot: 'This cannot be renamed (it is not a name declared in this file).', invalid: '"{0}" is not a valid JavaScript identifier.' }

function rename(model: editor.ITextModel, position: { lineNumber: number, column: number }, newName: string): languages.WorkspaceEdit & languages.Rejection {
  const o = occurrenceAt(model, position)
  if (!o || !o.binding.decls.length) return { edits: [], rejectReason: T.cannot }
  if (!/^[A-Za-z_$À-￿][\w$À-￿]*$/.test(newName) || KEYWORDS.has(newName)) return { edits: [], rejectReason: T.invalid.replace('{0}', newName) }
  const versionId = model.getVersionId()
  const all = [...o.binding.decls, ...o.binding.refs]
  const seen = new Set<AnyNode>()
  const edits: languages.IWorkspaceTextEdit[] = []
  const analysis = analyse(model)!
  for (const node of all) {
    if (seen.has(node)) continue
    seen.add(node)
    const occ = analysis.occurrences.find((x) => x.node === node)
    const old = node.name as string
    // (a shorthand keeps the property's or the specifier's name)
    const text = occ && occ.shorthand === 'property' ? old + ': ' + newName
      : occ && occ.shorthand === 'import' ? old + ' as ' + newName
        : occ && occ.shorthand === 'export' ? newName + ' as ' + old : newName
    edits.push({ resource: model.uri, versionId, textEdit: { range: range(node), text } })
  }
  return { edits }
}

// ---- formatting
function format(model: editor.ITextModel, options: languages.FormattingOptions): languages.TextEdit[] {
  const text = model.getValue()
  const out = (beautify as { js_beautify: (code: string, options: Record<string, unknown>) => string }).js_beautify(text, {
    indent_size: options.tabSize, indent_char: options.insertSpaces ? ' ' : '\t', indent_with_tabs: !options.insertSpaces,
    preserve_newlines: true, max_preserve_newlines: 2, end_with_newline: /\n$/.test(text), brace_style: 'collapse,preserve-inline'
  })
  return out === text ? [] : [{ range: model.getFullModelRange(), text: out }]
}

export function registerJavaScript(): void {
  languages.registerDocumentSymbolProvider(LANGUAGE, { displayName: 'Kodium', provideDocumentSymbols: (model) => symbols(model) })
  languages.registerDocumentFormattingEditProvider(LANGUAGE, { displayName: 'Kodium (js-beautify)', provideDocumentFormattingEdits: (model, options) => format(model, options) })
  languages.registerDefinitionProvider(LANGUAGE, {
    provideDefinition: (model, position) => {
      const o = occurrenceAt(model, position)
      return o ? o.binding.decls.map((d) => where(model, d)) : []
    }
  })
  languages.registerReferenceProvider(LANGUAGE, {
    provideReferences: (model, position, context) => {
      const o = occurrenceAt(model, position)
      if (!o) return []
      const nodes = context.includeDeclaration ? [...o.binding.decls, ...o.binding.refs] : [...o.binding.refs]
      return nodes.sort((a, b) => a.start - b.start).map((n) => where(model, n))
    }
  })
  languages.registerRenameProvider(LANGUAGE, {
    provideRenameEdits: (model, position, newName) => rename(model, position, newName),
    resolveRenameLocation: (model, position) => {
      const o = occurrenceAt(model, position)
      if (!o || !o.binding.decls.length) {
        const word = model.getWordAtPosition(position)
        const at = { startLineNumber: position.lineNumber, startColumn: word ? word.startColumn : position.column, endLineNumber: position.lineNumber, endColumn: word ? word.endColumn : position.column }
        return { range: at, text: word ? word.word : '', rejectReason: T.cannot }
      }
      return { range: range(o.node), text: o.node.name as string }
    }
  })
  for (const model of editor.getModels()) watch(model)
  editor.onDidCreateModel(watch)
}
