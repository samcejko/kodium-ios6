// JavaScript's syntax check, symbols and scopes off the page's thread: acorn took 0.9-1.4 s for a file of 1,500 lines on
// the iPad 2, in the page's next pause of typing - and a key typed then waited for it. A file's text comes in, its error
// (acorn's message, as it says it) or its symbols and the table of its names' scopes (jsScopes.ts: what Go to
// Definition, Find All References and Rename Symbol need) go back. See javascript.ts and tools/build-workers.mjs.
import { Parser, type Node } from 'acorn'
import { parseOptions, documentSymbols, type JsSymbol } from '../jsSymbols'
import { scopeTable, type ScopeTable } from '../jsScopes'

type Reply = { id: number, error: { message: string, pos: number, raisedAt: number } | null, symbols: JsSymbol[] | null, scopes: ScopeTable | null }
const post = (reply: Reply) => (self as unknown as { postMessage(data: unknown): void }).postMessage(reply)

self.onmessage = (e: MessageEvent) => {
  const { id, text } = e.data as { id: number, text: string }
  let program: Node
  try {
    program = Parser.parse(text, parseOptions(text))
  } catch (err) {
    const x = err as { message?: string, pos?: number, raisedAt?: number }
    post({ id, error: { message: String(x.message || err), pos: typeof x.pos === 'number' ? x.pos : 0, raisedAt: x.raisedAt || 0 }, symbols: null, scopes: null })
    return
  }
  let symbols: JsSymbol[] = []
  try { symbols = documentSymbols(program) } catch { /* none then */ }
  let scopes: ScopeTable | null = null
  try { scopes = scopeTable(program) } catch { /* the page works them out then */ }
  post({ id, error: null, symbols, scopes })
}
