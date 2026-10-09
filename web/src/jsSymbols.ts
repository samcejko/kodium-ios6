// What acorn's tree of a JavaScript file says, shared by the page (javascript.ts) and the worker that parses in the
// background (workers/javascript.worker.ts): the options a file is parsed with, and its symbols - functions, classes
// and their members, variables - for the outline, the breadcrumbs and Go to Symbol in Editor. Without monaco: the
// kinds are the numbers of monaco's languages.SymbolKind.
import type { Node, Options } from 'acorn'

export interface Range { startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number }
export interface JsSymbol { name: string, detail: string, kind: number, tags: number[], range: Range, selectionRange: Range, children: JsSymbol[] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNode = Node & Record<string, any>

// (languages.SymbolKind)
const SK = { Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Function: 11, Variable: 12, Constant: 13 }

// (a module when the file imports or exports at its top, else a script - in a module a script's sloppy code is an error)
export function parseOptions(text: string): Options {
  return {
    ecmaVersion: 'latest', sourceType: /^\s*(import|export)\b/m.test(text) ? 'module' : 'script', locations: true,
    allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true
  }
}

export function range(node: AnyNode): Range {
  const loc = node.loc!
  return { startLineNumber: loc.start.line, startColumn: loc.start.column + 1, endLineNumber: loc.end.line, endColumn: loc.end.column + 1 }
}
function symbol(name: string, kind: number, node: AnyNode, nameNode: AnyNode | null, children: JsSymbol[]): JsSymbol {
  return { name: name || '<anonymous>', detail: '', kind, tags: [], range: range(node), selectionRange: range(nameNode || node), children }
}
const isFunction = (n: AnyNode | null | undefined) => !!n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')
const keyName = (key: AnyNode) => key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : key.type === 'PrivateIdentifier' ? '#' + key.name : '[…]'
const source = (n: AnyNode): string => n.type === 'Identifier' ? n.name : n.type === 'ThisExpression' ? 'this'
  : n.type === 'MemberExpression' && !n.computed ? source(n.object) + '.' + keyName(n.property) : ''

// what a function's body declares (functions, classes, and variables holding them), to a few levels
function inner(fn: AnyNode, depth: number): JsSymbol[] {
  const out: JsSymbol[] = []
  if (depth > 3 || !fn.body || fn.body.type !== 'BlockStatement') return out
  for (const s of fn.body.body) statement(s, out, depth + 1, false)
  return out
}
function members(cls: AnyNode, depth: number): JsSymbol[] {
  const out: JsSymbol[] = []
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
function objectMembers(obj: AnyNode, depth: number): JsSymbol[] {
  const out: JsSymbol[] = []
  for (const p of obj.properties) {
    if (p.type !== 'Property') continue
    if (p.method || isFunction(p.value)) out.push(symbol(keyName(p.key), SK.Method, p, p.key, inner(p.value, depth)))
    else if (p.kind === 'get' || p.kind === 'set') out.push(symbol(keyName(p.key), SK.Property, p, p.key, []))
    else if (p.value && p.value.type === 'ObjectExpression' && depth < 3) out.push(symbol(keyName(p.key), SK.Property, p, p.key, objectMembers(p.value, depth + 1)))
  }
  return out
}
function valueSymbol(name: string, varKind: string, node: AnyNode, nameNode: AnyNode, init: AnyNode | null, depth: number, top: boolean, out: JsSymbol[]) {
  if (isFunction(init)) out.push(symbol(name, SK.Function, node, nameNode, inner(init!, depth)))
  else if (init && init.type === 'ClassExpression') out.push(symbol(name, SK.Class, node, nameNode, members(init, depth)))
  else if (init && init.type === 'ObjectExpression') out.push(symbol(name, varKind === 'const' ? SK.Constant : SK.Variable, node, nameNode, objectMembers(init, depth)))
  else if (top) out.push(symbol(name, varKind === 'const' ? SK.Constant : SK.Variable, node, nameNode, []))
}
function statement(s: AnyNode, out: JsSymbol[], depth: number, top: boolean): void {
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

export function documentSymbols(program: Node): JsSymbol[] {
  const out: JsSymbol[] = []
  for (const s of (program as AnyNode).body) statement(s, out, 0, true)
  return out
}
