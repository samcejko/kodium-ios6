// Which declaration each name of a JavaScript file means - its scopes: var and function declarations hoisted to their
// function, let/const/class to their block, parameters, catch, imports, a named function or class expression's own
// name; a name declared nowhere in the file is a global of the file. Shared by the page (javascript.ts: Go to
// Definition, Find All References, Rename Symbol) and the worker that parses in the background
// (workers/javascript.worker.ts), which works it out together with the syntax check: the page then has it without
// parsing the file itself (1.5 s on the page's thread for 1,500 lines on the iPad 2, the first F12 in such a file).
// The result is a table a worker can post cheaply: per occurrence of a name, in the order of the text, FIELDS numbers -
// start and end offset, start line and column, end line and column (monaco's, 1-based), its binding, flags - each
// number as two characters of 15 bits (no surrogates), and the bindings' names.
import type { Node } from 'acorn'
import type { AnyNode } from './jsSymbols'

export const FIELDS = 8
export const START = 0, END = 1, START_LINE = 2, START_COLUMN = 3, END_LINE = 4, END_COLUMN = 5, BINDING = 6, FLAGS = 7
// (flags: a declaration; a shorthand - {a}, import {a}, export {a} - whose name a rename must keep)
export const DECL = 1, SHORT_PROPERTY = 2, SHORT_IMPORT = 4, SHORT_EXPORT = 8
export interface ScopeTable { table: string, names: string[] }

export function count(t: ScopeTable): number {
  return t.table.length / (FIELDS * 2)
}
export function field(t: ScopeTable, i: number, f: number): number {
  const at = (i * FIELDS + f) * 2
  return t.table.charCodeAt(at) | (t.table.charCodeAt(at + 1) << 15)
}
// the occurrence whose name is at the offset (the first one, in the text's order), or -1
export function occurrenceAt(t: ScopeTable, offset: number): number {
  let lo = 0, hi = count(t) - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (field(t, mid, START) <= offset) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  // (back to the first of the occurrences starting there)
  while (found > 0 && field(t, found - 1, START) === field(t, found, START)) found--
  return found >= 0 && offset <= field(t, found, END) ? found : -1
}
// a binding's occurrences, in the text's order, each once
export function occurrencesOf(t: ScopeTable, binding: number): number[] {
  const out: number[] = []
  let last = -1
  for (let i = 0, n = count(t); i < n; i++) {
    if (field(t, i, BINDING) !== binding) continue
    const start = field(t, i, START)
    if (start === last) continue
    last = start
    out.push(i)
  }
  return out
}

type Binding = { index: number, name: string }
type Scope = { parent: Scope | null, names: Map<string, Binding>, isFunction: boolean }
type Occurrence = { node: AnyNode, binding: Binding, flags: number }

export function scopeTable(program: Node): ScopeTable {
  const occurrences: Occurrence[] = []
  const bindings: Binding[] = []
  const declared = new Set<AnyNode>()
  const root: Scope = { parent: null, names: new Map(), isFunction: true }
  const shorthands = new Map<AnyNode, number>()

  const binding = (scope: Scope, name: string): Binding => {
    let b = scope.names.get(name)
    if (!b) { b = { index: bindings.length, name }; bindings.push(b); scope.names.set(name, b) }
    return b
  }
  const declare = (scope: Scope, id: AnyNode) => {
    const b = binding(scope, id.name)
    if (declared.has(id)) return
    declared.add(id)
    occurrences.push({ node: id, binding: b, flags: DECL | (shorthands.get(id) || 0) })
  }
  const lookup = (scope: Scope, name: string): Binding => {
    for (let s: Scope | null = scope; s; s = s.parent) { const b = s.names.get(name); if (b) return b }
    return binding(root, name)   // (a global)
  }
  const reference = (scope: Scope, id: AnyNode) => {
    occurrences.push({ node: id, binding: lookup(scope, id.name), flags: shorthands.get(id) || 0 })
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
          if (prop.shorthand && prop.value.type === 'Identifier') shorthands.set(prop.value, SHORT_PROPERTY)
          else if (prop.shorthand && prop.value.type === 'AssignmentPattern' && prop.value.left.type === 'Identifier') shorthands.set(prop.value.left, SHORT_PROPERTY)
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
          if (sp.type === 'ImportSpecifier' && sp.imported && sp.imported.type === 'Identifier' && sp.imported.name === sp.local.name && sp.imported.start === sp.local.start) shorthands.set(sp.local, SHORT_IMPORT)
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
        for (const c of s.cases) for (const x of c.consequent) all.push(x)
        hoistLexical(all, cases)
        for (const c of s.cases) { expression(c.test, cases); for (const x of c.consequent) statement(x, cases) }
        break
      }
      case 'ExportNamedDeclaration':
        if (s.declaration) statement(s.declaration, scope)
        else if (!s.source) for (const sp of s.specifiers) {
          if (sp.local.type !== 'Identifier') continue
          if (sp.exported && sp.exported.type === 'Identifier' && sp.exported.start === sp.local.start) shorthands.set(sp.local, SHORT_EXPORT)
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
          if (p.shorthand && p.value.type === 'Identifier') shorthands.set(p.value, SHORT_PROPERTY)
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
          if (p.shorthand && p.value.type === 'Identifier') shorthands.set(p.value, SHORT_PROPERTY)
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

  // the table: two characters of 15 bits a number
  const parts: string[] = []
  const put = (v: number) => { parts.push(String.fromCharCode(v & 0x7fff, (v >>> 15) & 0x7fff)) }
  for (let i = 0; i < occurrences.length; i++) {
    const o = occurrences[i], loc = o.node.loc!
    put(o.node.start); put(o.node.end)
    put(loc.start.line); put(loc.start.column + 1); put(loc.end.line); put(loc.end.column + 1)
    put(o.binding.index); put(o.flags)
  }
  return { table: parts.join(''), names: bindings.map((b) => b.name) }
}
