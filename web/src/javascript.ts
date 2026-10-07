// JavaScript without a language server. VS Code's comes from TypeScript's language service, which needs more memory
// than the iPad 2 has to spare (a worker of tens of megabytes); Kodium has a parser (acorn) and a formatter (js-beautify)
// instead, on the page's thread and only when they are asked:
// - syntax errors as problems (squiggles, the Problems view), checked once typing pauses;
// - the file's symbols - functions, classes and their members, variables - for the outline, the breadcrumbs and Go to
//   Symbol in Editor (Ctrl+Shift+O);
// - Format Document (Shift+Alt+F);
// - Go to Definition (F12), Find All References (Shift+F12) and Rename Symbol (F2), within the file: which declaration
//   a name means is worked out from the file's scopes when one of them is asked for.
// (a .jsx file is JavaScript to Kodium's grammar, but acorn does not read JSX: no syntax check there)
import { editor, languages, MarkerSeverity, type IDisposable, type IRange } from 'monaco-editor'
import { Parser, type Node } from 'acorn'
import beautify from 'js-beautify/js/lib/beautify.js'

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

type Parsed = { version: number, program: Node | null, error: { message: string, pos: number, end: number } | null }
const parsed = new Map<string, Parsed>()
const lastSymbols = new Map<string, languages.DocumentSymbol[]>()

// (a module when the file imports or exports at its top, else a script - in a module a script's sloppy code is an error)
function parse(model: editor.ITextModel): Parsed {
  const key = model.uri.toString(), version = model.getVersionId()
  const known = parsed.get(key)
  if (known && known.version === version) return known
  const text = model.getValue()
  let result: Parsed
  try {
    const program = Parser.parse(text, {
      ecmaVersion: 'latest', sourceType: /^\s*(import|export)\b/m.test(text) ? 'module' : 'script', locations: true,
      allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true
    }) as unknown as Node
    result = { version, program, error: null }
  } catch (e) {
    const err = e as { message?: string, pos?: number, raisedAt?: number }
    const pos = typeof err.pos === 'number' ? err.pos : 0
    result = { version, program: null, error: { message: message(String(err.message || e)), pos, end: Math.max(pos + 1, err.raisedAt || 0) } }
  }
  parsed.set(key, result)
  return result
}

// ---- syntax errors, once typing pauses (and the page is idle: vsc-prelude.js holds idle work while keys come)
const marked = new Set<string>()   // (the files with a problem of ours: only theirs are cleared)
function clear(model: editor.ITextModel): void {
  if (marked.delete(model.uri.toString())) editor.setModelMarkers(model, OWNER, [])
}
function check(model: editor.ITextModel): void {
  if (model.isDisposed() || model.getLanguageId() !== LANGUAGE) return
  if (/\.jsx$/i.test(model.uri.path) || model.getValueLength() > TOO_BIG) { clear(model); return }
  const { error } = parse(model)
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
    timer = window.setTimeout(() => { timer = undefined; window.requestIdleCallback(() => check(model)) }, 600)
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
    analyses.delete(model.uri.toString())
    lastSymbols.delete(model.uri.toString())
    marked.delete(model.uri.toString())
  })
}

// ---- the file's symbols
type AnyNode = Node & Record<string, any>
const SK = languages.SymbolKind

function range(node: AnyNode): IRange {
  const loc = node.loc!
  return { startLineNumber: loc.start.line, startColumn: loc.start.column + 1, endLineNumber: loc.end.line, endColumn: loc.end.column + 1 }
}
function symbol(name: string, kind: languages.SymbolKind, node: AnyNode, nameNode: AnyNode | null, children: languages.DocumentSymbol[]): languages.DocumentSymbol {
  return { name: name || '<anonymous>', detail: '', kind, tags: [], range: range(node), selectionRange: range(nameNode || node), children }
}
const isFunction = (n: AnyNode | null | undefined) => !!n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')
const keyName = (key: AnyNode) => key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : key.type === 'PrivateIdentifier' ? '#' + key.name : '[…]'
const source = (n: AnyNode): string => n.type === 'Identifier' ? n.name : n.type === 'ThisExpression' ? 'this'
  : n.type === 'MemberExpression' && !n.computed ? source(n.object) + '.' + keyName(n.property) : ''

// what a function's body declares (functions, classes, and variables holding them), to a few levels
function inner(fn: AnyNode, depth: number): languages.DocumentSymbol[] {
  const out: languages.DocumentSymbol[] = []
  if (depth > 3 || !fn.body || fn.body.type !== 'BlockStatement') return out
  for (const s of fn.body.body) statement(s, out, depth + 1, false)
  return out
}
function members(cls: AnyNode, depth: number): languages.DocumentSymbol[] {
  const out: languages.DocumentSymbol[] = []
  for (const m of cls.body.body) {
    if (m.type === 'MethodDefinition') {
      const kind = m.kind === 'constructor' ? SK.Constructor : m.kind === 'get' || m.kind === 'set' ? SK.Property : SK.Method
      out.push(symbol(keyName(m.key), kind, m, m.key, inner(m.value, depth)))
    } else if (m.type === 'PropertyDefinition') {
      out.push(symbol(keyName(m.key), isFunction(m.value) ? SK.Method : SK.Field, m, m.key, isFunction(m.value) ? inner(m.value, depth) : []))
    }
  }
  return out
}
function objectMembers(obj: AnyNode, depth: number): languages.DocumentSymbol[] {
  const out: languages.DocumentSymbol[] = []
  for (const p of obj.properties) {
    if (p.type !== 'Property') continue
    if (p.method || isFunction(p.value)) out.push(symbol(keyName(p.key), SK.Method, p, p.key, inner(p.value, depth)))
    else if (p.kind === 'get' || p.kind === 'set') out.push(symbol(keyName(p.key), SK.Property, p, p.key, []))
    else if (p.value && p.value.type === 'ObjectExpression' && depth < 3) out.push(symbol(keyName(p.key), SK.Property, p, p.key, objectMembers(p.value, depth + 1)))
  }
  return out
}
function valueSymbol(name: string, varKind: string, node: AnyNode, nameNode: AnyNode, init: AnyNode | null, depth: number, top: boolean, out: languages.DocumentSymbol[]) {
  if (isFunction(init)) out.push(symbol(name, SK.Function, node, nameNode, inner(init!, depth)))
  else if (init && init.type === 'ClassExpression') out.push(symbol(name, SK.Class, node, nameNode, members(init, depth)))
  else if (init && init.type === 'ObjectExpression') out.push(symbol(name, varKind === 'const' ? SK.Constant : SK.Variable, node, nameNode, objectMembers(init, depth)))
  else if (top) out.push(symbol(name, varKind === 'const' ? SK.Constant : SK.Variable, node, nameNode, []))
}
function statement(s: AnyNode, out: languages.DocumentSymbol[], depth: number, top: boolean): void {
  switch (s.type) {
    case 'FunctionDeclaration': out.push(symbol(s.id ? s.id.name : 'default', SK.Function, s, s.id, inner(s, depth))); break
    case 'ClassDeclaration': out.push(symbol(s.id ? s.id.name : 'default', SK.Class, s, s.id, members(s, depth))); break
    case 'VariableDeclaration':
      for (const d of s.declarations) if (d.id.type === 'Identifier') valueSymbol(d.id.name, s.kind, d, d.id, d.init, depth, top, out)
      break
    case 'ExportNamedDeclaration': if (s.declaration) statement(s.declaration, out, depth, top); break
    case 'ExportDefaultDeclaration':
      if (s.declaration.type === 'FunctionDeclaration' || s.declaration.type === 'ClassDeclaration') statement(s.declaration, out, depth, top)
      else valueSymbol('default', 'const', s, s, s.declaration, depth, top, out)
      break
    case 'ExpressionStatement': {
      // (a.b = function..., module.exports = {...}, Foo.prototype.bar = function...)
      const e = s.expression
      if (e.type === 'AssignmentExpression' && e.operator === '=' && (e.left.type === 'MemberExpression' || e.left.type === 'Identifier')) {
        const name = source(e.left)
        if (name && (isFunction(e.right) || e.right.type === 'ClassExpression' || (e.right.type === 'ObjectExpression' && top))) valueSymbol(name, 'var', s, e.left, e.right, depth, false, out)
      }
      break
    }
  }
}

function symbols(model: editor.ITextModel): languages.DocumentSymbol[] {
  const key = model.uri.toString()
  if (model.getValueLength() > TOO_BIG || /\.jsx$/i.test(model.uri.path)) return lastSymbols.get(key) || []
  const { program } = parse(model)
  // (while the file does not parse - in the middle of typing - the last symbols that did)
  if (!program) return lastSymbols.get(key) || []
  const out: languages.DocumentSymbol[] = []
  for (const s of (program as AnyNode).body) statement(s, out, 0, true)
  lastSymbols.set(key, out)
  return out
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
