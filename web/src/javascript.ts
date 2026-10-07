// JavaScript without a language server. VS Code's comes from TypeScript's language service, which needs more memory
// than the iPad 2 has to spare (a worker of tens of megabytes); Kodium has a parser (acorn) and a formatter (js-beautify)
// instead, on the page's thread and only when they are asked:
// - syntax errors as problems (squiggles, the Problems view), checked once typing pauses;
// - the file's symbols - functions, classes and their members, variables - for the outline, the breadcrumbs and Go to
//   Symbol in Editor (Ctrl+Shift+O);
// - Format Document (Shift+Alt+F).
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
  for (const model of editor.getModels()) watch(model)
  editor.onDidCreateModel(watch)
}
