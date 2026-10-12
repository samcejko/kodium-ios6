// The editor's worker - the words of the suggestions, among others - is made when something first asks it and goes
// after a minute without a request (vite.config.mjs quickerWorkers): it took 1.1 s on the iPad 2 to start, so the first
// suggestions in a file, and the first after a pause of a minute, came a second later than the others (2.6-3.1 s from
// the key instead of 1.4). The editor's focus and its edits ask it something small now - at most every 20 s, which
// keeps it while one types -, so that it starts while the suggestions' delay runs.
import { StandaloneServices } from '@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices'
import { ICodeEditorService } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/services/codeEditorService.service'
import { IEditorWorkerService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/services/editorWorker.service'
import type { ICodeEditor } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorBrowser'
import { warming } from './warmup'

const EVERY = 20000

export function warmEditorWorker(): void {
  const editors = StandaloneServices.get(ICodeEditorService)
  const worker = StandaloneServices.get(IEditorWorkerService)
  let last = 0
  const ask = (editor: ICodeEditor) => {
    const model = editor.getModel()
    // (not for the warm-up's editor behind the splash: the worker's 8 MB then, when memory is shortest)
    if (!model || warming || Date.now() - last < EVERY || !worker.canComputeWordRanges(model.uri)) return
    last = Date.now()
    worker.computeWordRanges(model.uri, { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }).catch(() => undefined)
  }
  const watch = (editor: ICodeEditor) => {
    editor.onDidFocusEditorText(() => ask(editor))
    editor.onDidChangeModelContent(() => ask(editor))
  }
  editors.listCodeEditors().forEach(watch)
  editors.onCodeEditorAdd(watch)
}
