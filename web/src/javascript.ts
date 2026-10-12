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
//   a name means, from the file's scopes - which the same worker works out with each check (jsScopes.ts).
// (a .jsx file is JavaScript to Kodium's grammar, but acorn does not read JSX: no syntax check there)
import { editor, languages, MarkerSeverity, type IDisposable } from 'monaco-editor'
import { Parser, type Node } from 'acorn'
import beautify from 'js-beautify/js/lib/beautify.js'
import { parseOptions, documentSymbols, type JsSymbol } from './jsSymbols'
import {
  scopeTable, occurrenceAt, occurrencesOf, field, BINDING, FLAGS, DECL, SHORT_PROPERTY, SHORT_IMPORT, SHORT_EXPORT,
  START_LINE, START_COLUMN, END_LINE, END_COLUMN, type ScopeTable
} from './jsScopes'

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
type Reply = { id: number, error: { message: string, pos: number, raisedAt: number } | null, symbols: JsSymbol[] | null, scopes?: ScopeTable | null }
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
    // (the scopes of this version, for F12 and the like - none while it does not parse)
    const known = analyses.get(key)
    if (!known || known.version < version) analyses.set(key, { version, scopes: reply.scopes || null })
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

// ---- definitions, references and renames, within the file: the table of the file's scopes (jsScopes.ts) for its
// version - the worker's, which comes with its check: the first F12 in a long file no longer parses it on the page's
// thread (1.5 s for 1,500 lines on the iPad 2, the page frozen). A version the worker has not answered for is asked
// for (a check of it under way is waited for); parsed here only when the worker cannot.
type Analysis = { version: number, scopes: ScopeTable | null }
const analyses = new Map<string, Analysis>()

async function scopesOf(model: editor.ITextModel): Promise<ScopeTable | null> {
  const key = model.uri.toString(), version = model.getVersionId()
  if (model.getValueLength() > TOO_BIG || /\.jsx$/i.test(model.uri.path)) return null
  const known = analyses.get(key)
  if (known && known.version === version) return known.scopes
  if (!broken) {
    await checked(model)
    const answered = analyses.get(key)
    if (answered && answered.version === version) return answered.scopes
  }
  // (the file changed meanwhile: what was asked about is gone)
  if (model.isDisposed() || model.getVersionId() !== version) return null
  const { program } = parse(model)
  const scopes = program ? scopeTable(program) : null
  analyses.set(key, { version, scopes })
  return scopes
}

type At = { table: ScopeTable, index: number, binding: number }
async function occurrence(model: editor.ITextModel, position: { lineNumber: number, column: number }): Promise<At | null> {
  const table = await scopesOf(model)
  if (!table || model.isDisposed()) return null
  const index = occurrenceAt(table, model.getOffsetAt(position))
  return index < 0 ? null : { table, index, binding: field(table, index, BINDING) }
}
const rangeOf = (t: ScopeTable, i: number) => ({
  startLineNumber: field(t, i, START_LINE), startColumn: field(t, i, START_COLUMN), endLineNumber: field(t, i, END_LINE), endColumn: field(t, i, END_COLUMN)
})
const where = (model: editor.ITextModel, t: ScopeTable, i: number): languages.Location => ({ uri: model.uri, range: rangeOf(t, i) })
const declared = (t: ScopeTable, list: number[]) => list.some((i) => (field(t, i, FLAGS) & DECL) !== 0)

const KEYWORDS = new Set(('break case catch class const continue debugger default delete do else export extends false finally for function if ' +
  'import in instanceof new null return super switch this throw true try typeof var void while with yield let static enum await implements ' +
  'package protected interface private public arguments eval').split(' '))
const T = cs
  ? { cannot: 'Tohle nelze přejmenovat (není to jméno deklarované v tomto souboru).', invalid: '„{0}“ není platný identifikátor JavaScriptu.' }
  : { cannot: 'This cannot be renamed (it is not a name declared in this file).', invalid: '"{0}" is not a valid JavaScript identifier.' }

async function rename(model: editor.ITextModel, position: { lineNumber: number, column: number }, newName: string): Promise<languages.WorkspaceEdit & languages.Rejection> {
  const versionId = model.getVersionId()
  const at = await occurrence(model, position)
  const list = at ? occurrencesOf(at.table, at.binding) : []
  if (!at || !declared(at.table, list)) return { edits: [], rejectReason: T.cannot }
  if (!/^[A-Za-z_$À-￿][\w$À-￿]*$/.test(newName) || KEYWORDS.has(newName)) return { edits: [], rejectReason: T.invalid.replace('{0}', newName) }
  const old = at.table.names[at.binding]
  const edits: languages.IWorkspaceTextEdit[] = list.map((i) => {
    const flags = field(at.table, i, FLAGS)
    // (a shorthand keeps the property's or the specifier's name)
    const text = flags & SHORT_PROPERTY ? old + ': ' + newName
      : flags & SHORT_IMPORT ? old + ' as ' + newName
        : flags & SHORT_EXPORT ? newName + ' as ' + old : newName
    return { resource: model.uri, versionId, textEdit: { range: rangeOf(at.table, i), text } }
  })
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
    provideDefinition: async (model, position) => {
      const at = await occurrence(model, position)
      if (!at) return []
      return occurrencesOf(at.table, at.binding).filter((i) => (field(at.table, i, FLAGS) & DECL) !== 0).map((i) => where(model, at.table, i))
    }
  })
  languages.registerReferenceProvider(LANGUAGE, {
    provideReferences: async (model, position, context) => {
      const at = await occurrence(model, position)
      if (!at) return []
      return occurrencesOf(at.table, at.binding)
        .filter((i) => context.includeDeclaration || (field(at.table, i, FLAGS) & DECL) === 0)
        .map((i) => where(model, at.table, i))
    }
  })
  languages.registerRenameProvider(LANGUAGE, {
    provideRenameEdits: (model, position, newName) => rename(model, position, newName),
    resolveRenameLocation: async (model, position) => {
      const at = await occurrence(model, position)
      if (!at || !declared(at.table, occurrencesOf(at.table, at.binding))) {
        const word = model.getWordAtPosition(position)
        const range = { startLineNumber: position.lineNumber, startColumn: word ? word.startColumn : position.column, endLineNumber: position.lineNumber, endColumn: word ? word.endColumn : position.column }
        return { range, text: word ? word.word : '', rejectReason: T.cannot }
      }
      return { range: rangeOf(at.table, at.index), text: at.table.names[at.binding] }
    }
  })
  for (const model of editor.getModels()) watch(model)
  editor.onDidCreateModel(watch)
}
