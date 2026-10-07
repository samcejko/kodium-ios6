// Markdown's outline: the headings (# Title, and a line underlined with === or ---), nested by their level, each the
// section down to the next heading of its level - what VS Code's Markdown extension gives the Outline view and Go to
// Symbol in Editor (Ctrl+Shift+O). That extension has code, and its host does not start for this; the headings are
// read here, on demand. The code blocks (``` and ~~~ fences) are skipped: a # in them is code.
import { languages, type editor } from 'monaco-editor'

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
// (a line a --- under would not make a heading of: a list item, a quote, a table row, a thematic break)
const NOT_PARAGRAPH = /^ {0,3}([-*+>|]|\d+[.)][ \t]|#|(-[ \t]*){3,}$|(\*[ \t]*){3,}$|(_[ \t]*){3,}$)/

function headings(model: editor.ITextModel): languages.DocumentSymbol[] {
  const lines = model.getLinesContent()
  const roots: languages.DocumentSymbol[] = []
  const open: { level: number, symbol: languages.DocumentSymbol }[] = []
  const close = (upTo: number, endLine: number) => {
    while (open.length && open[open.length - 1].level >= upTo) {
      const { symbol } = open.pop()!
      symbol.range = { ...symbol.range, endLineNumber: endLine, endColumn: Math.max(1, (lines[endLine - 1] || '').length + 1) }
    }
  }
  const add = (level: number, name: string, startLine: number, headingLine: number) => {
    close(level, Math.max(startLine - 1, 1))
    const symbol: languages.DocumentSymbol = {
      name: name || '#'.repeat(level), detail: '', kind: languages.SymbolKind.String, tags: [], children: [],
      range: { startLineNumber: startLine, startColumn: 1, endLineNumber: lines.length, endColumn: 1 },
      selectionRange: { startLineNumber: headingLine, startColumn: 1, endLineNumber: headingLine, endColumn: lines[headingLine - 1].length + 1 }
    }
    const parent = open[open.length - 1]
    if (parent) parent.symbol.children!.push(symbol)
    else roots.push(symbol)
    open.push({ level, symbol })
  }
  let fence: { char: string, length: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE.exec(line)
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.length && /^[`~]+[ \t]*$/.test(line.trim())) fence = null
      continue
    }
    if (f) { fence = { char: f[1][0], length: f[1].length }; continue }
    const atx = ATX.exec(line)
    if (atx) { add(atx[1].length, (atx[2] || '').trim(), i + 1, i + 1); continue }
    const under = i > 0 ? SETEXT.exec(line) : null
    const above = i > 0 ? lines[i - 1] : ''
    if (under && above.trim() && !NOT_PARAGRAPH.test(above) && !SETEXT.test(above) && !(i > 1 && lines[i - 2].trim() && !NOT_PARAGRAPH.test(lines[i - 2]) && !ATX.test(lines[i - 2]))) {
      add(under[1][0] === '=' ? 1 : 2, above.trim(), i, i)
    }
  }
  close(1, lines.length)
  return roots
}

export function registerMarkdown(): void {
  languages.registerDocumentSymbolProvider('markdown', { displayName: 'Kodium', provideDocumentSymbols: (model) => headings(model) })
}
