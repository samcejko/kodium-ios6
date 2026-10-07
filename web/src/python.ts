// Python's outline: classes and functions (methods in a class), nested by their indentation, each down to the next line
// indented as little - for the Outline view and Go to Symbol in Editor (Ctrl+Shift+O), which VS Code gets from the
// Python extension (with code, and a language server Kodium has no room for). Read on demand; the lines of a
// triple-quoted string are skipped.
import { languages, type editor } from 'monaco-editor'

const DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_À-￿][\wÀ-￿]*)/
const CLASS = /^(\s*)class\s+([A-Za-z_À-￿][\wÀ-￿]*)/
const width = (indent: string) => indent.replace(/\t/g, '        ').length

function definitions(model: editor.ITextModel): languages.DocumentSymbol[] {
  const lines = model.getLinesContent()
  const roots: languages.DocumentSymbol[] = []
  const open: { indent: number, symbol: languages.DocumentSymbol, isClass: boolean }[] = []
  let lastCode = 0   // (the last line with code: where a closed definition ends)
  const close = (indent: number) => {
    while (open.length && open[open.length - 1].indent >= indent) {
      const { symbol } = open.pop()!
      const end = Math.max(lastCode, symbol.range.startLineNumber)
      symbol.range = { ...symbol.range, endLineNumber: end, endColumn: lines[end - 1].length + 1 }
    }
  }
  let quote: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (quote) {
      if (line.indexOf(quote) >= 0) quote = null
      lastCode = i + 1
      continue
    }
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] === '#') continue
    const indent = width(/^\s*/.exec(line)![0])
    close(indent)
    const def = DEF.exec(line), cls = def ? null : CLASS.exec(line)
    if (def || cls) {
      const name = (def || cls)![2]
      const parent = open[open.length - 1]
      const kind = cls ? languages.SymbolKind.Class : parent && parent.isClass ? (name === '__init__' ? languages.SymbolKind.Constructor : languages.SymbolKind.Method) : languages.SymbolKind.Function
      const at = line.indexOf(name, (def || cls)![1].length)
      const symbol: languages.DocumentSymbol = {
        name, detail: '', kind, tags: [], children: [],
        range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: line.length + 1 },
        selectionRange: { startLineNumber: i + 1, startColumn: at + 1, endLineNumber: i + 1, endColumn: at + 1 + name.length }
      }
      if (parent) parent.symbol.children!.push(symbol)
      else roots.push(symbol)
      open.push({ indent, symbol, isClass: !!cls })
    }
    lastCode = i + 1
    // (a string opened and not closed on this line: its next lines are text)
    for (const q of ['"""', "'''"]) {
      const first = line.indexOf(q)
      if (first >= 0 && line.indexOf(q, first + 3) < 0) { quote = q; break }
    }
  }
  close(0)
  return roots
}

export function registerPython(): void {
  languages.registerDocumentSymbolProvider('python', { displayName: 'Kodium', provideDocumentSymbols: (model) => definitions(model) })
}
