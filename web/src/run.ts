// Run: the active JavaScript file in a worker of its own (a loop that never ends can be stopped: the worker goes), its
// console in the Output panel. Code the iOS 6 engine cannot parse (ES2015 and later) goes to the engine's transpiler
// first (https://ios6-browser.invalid/lower, the app's own; a desktop browser runs it as it is).
// Made with the workbench's own registries, not as an extension: an extension would start the extension host when the
// workbench starts (3.5 s and 14 MB on the iPad 2), which otherwise waits for an installed extension that needs it.
import { Action2, MenuId, registerAction2 } from '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
import { ContextKeyExpr, RawContextKey } from '@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey'
import { IContextKeyService } from '@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey.service'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { Extensions as OutputExtensions, type IOutputChannelRegistry } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/output/common/output'
import { IOutputService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/output/common/output.service'
import { Registry } from '@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform'
import { Codicon } from '@codingame/monaco-vscode-api/vscode/vs/base/common/codicons'
import { KeyCode, KeyMod } from '@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes'
import { KeybindingWeight } from '@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry'
import { INotificationService } from '@codingame/monaco-vscode-api/vscode/vs/platform/notification/common/notification.service'
import type { ServicesAccessor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/instantiation'
import type { IContextKey } from '@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey'
import { ITerminalService } from '@codingame/monaco-vscode-terminal-service-override'
import { DOCUMENTS } from './files'

const cs = /^cs/i.test((window as { __kd_lang?: string }).__kd_lang || '')
const T = cs
  ? {
      run: 'Spustit JavaScript', stop: 'Zastavit', channel: 'Kodium: Spustit', running: 'Spouštím {0}…',
      finished: 'Hotovo za {0} ms (časovače programu běží dál, dokud ho nezastavíte nebo nespustíte znovu)',
      stopped: 'Zastaveno.', error: 'Chyba: {0}', notJs: 'Spustit lze jen soubor JavaScriptu.',
      runPython: 'Spustit Python v terminálu', notPython: 'Spustit lze jen soubor Pythonu.',
      saveToDocuments: 'Před spuštěním soubor uložte do složky Documents.'
    }
  : {
      run: 'Run JavaScript', stop: 'Stop', channel: 'Kodium: Run', running: 'Running {0}…',
      finished: 'Done in {0} ms (the program\'s timers go on until you stop it or run it again)',
      stopped: 'Stopped.', error: 'Error: {0}', notJs: 'Only a JavaScript file can be run.',
      runPython: 'Run Python in Terminal', notPython: 'Only a Python file can be run.',
      saveToDocuments: 'Save the file to Documents before running.'
    }
const fill = (s: string, v: string | number) => s.replace('{0}', String(v))

// The worker's code: ES5 as it is here (nothing lowers a string)
const RUNNER = [
  'self.onmessage = function (e) {',
  '  var code = e.data.code, lowerUrl = e.data.lower;',
  '  var fmt = function (v) {',
  '    if (typeof v === "string") return v;',
  '    if (v instanceof Error) return v.stack || String(v);',
  '    if (v === undefined || v === null || typeof v !== "object") return String(v);',
  '    try { return JSON.stringify(v, null, 2); } catch (x) { return Object.prototype.toString.call(v); }',
  '  };',
  '  var send = function (level, args) {',
  '    var parts = [];',
  '    for (var i = 0; i < args.length; i++) parts.push(fmt(args[i]));',
  '    self.postMessage({ type: "log", level: level, text: parts.join(" ") });',
  '  };',
  '  var con = {',
  '    log: function () { send("log", arguments); }, info: function () { send("info", arguments); },',
  '    warn: function () { send("warn", arguments); }, error: function () { send("error", arguments); },',
  '    debug: function () { send("debug", arguments); }',
  '  };',
  '  self.console = con;',
  '  var fn;',
  '  try { fn = new Function("console", code); }',
  '  catch (err) {',
  '    if (!(err instanceof SyntaxError) || !lowerUrl) { self.postMessage({ type: "error", text: String(err) }); return; }',
  '    var lowered = null;',
  '    try {',
  '      var x = new XMLHttpRequest();',
  '      x.open("POST", lowerUrl, false);',
  '      x.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");',
  '      x.send(code);',
  '      if (x.status === 200) lowered = x.responseText || code;',
  '    } catch (x2) {}',
  '    if (lowered === null) { self.postMessage({ type: "error", text: String(err) }); return; }',
  '    try { fn = new Function("console", lowered); } catch (err2) { self.postMessage({ type: "error", text: String(err2) }); return; }',
  '  }',
  '  var t0 = Date.now();',
  '  try { fn(con); } catch (err3) { self.postMessage({ type: "error", text: (err3 && err3.stack) || String(err3) }); return; }',
  '  self.postMessage({ type: "done", ms: Date.now() - t0 });',
  '};'
].join('\n')

// (the engine's transpiler answers on the iPad only)
const LOWER_URL = /iPad|iPhone|iPod/.test(navigator.userAgent) ? 'https://ios6-browser.invalid/lower' : ''
const CHANNEL = 'kodium.run'
const RUNNING = new RawContextKey<boolean>('kodium.running', false)
const isJavaScript = ContextKeyExpr.equals('resourceLangId', 'javascript')

Registry.as<IOutputChannelRegistry>(OutputExtensions.OutputChannels).registerChannel({ id: CHANNEL, label: T.channel, log: false })

let worker: Worker | null = null
let blobUrl: string | null = null
let running: IContextKey<boolean> | null = null
const end = () => {
  if (worker) worker.terminate()
  worker = null
  if (blobUrl) URL.revokeObjectURL(blobUrl)
  blobUrl = null
  running?.set(false)
}

registerAction2(class RunAction extends Action2 {
  constructor() {
    super({
      id: 'kodium.run',
      title: { value: T.run, original: 'Run JavaScript' },
      category: { value: 'Kodium', original: 'Kodium' },
      icon: Codicon.play,
      f1: true,
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: ContextKeyExpr.and(isJavaScript, RUNNING.negate()) }],
      keybinding: [
        { primary: KeyCode.F5, when: ContextKeyExpr.equals('editorLangId', 'javascript'), weight: KeybindingWeight.WorkbenchContrib },
        { primary: KeyMod.WinCtrl | KeyMod.Alt | KeyCode.KeyN, when: ContextKeyExpr.equals('editorLangId', 'javascript'), weight: KeybindingWeight.WorkbenchContrib }
      ]
    })
  }

  run(accessor: ServicesAccessor): void {
    const control = accessor.get(IEditorService).activeTextEditorControl as { getModel?: () => unknown } | undefined
    const model = control?.getModel?.() as { getLanguageId?: () => string, getValue: () => string, uri: { path: string } } | null | undefined
    if (!model || typeof model.getLanguageId !== 'function' || model.getLanguageId() !== 'javascript') {
      accessor.get(INotificationService).info(T.notJs)
      return
    }
    running = running ?? RUNNING.bindTo(accessor.get(IContextKeyService))
    const output = accessor.get(IOutputService)
    end()
    void output.showChannel(CHANNEL, true)
    const channel = output.getChannel(CHANNEL)
    const line = (text: string) => channel?.append(text + '\n')
    channel?.clear()
    line(fill(T.running, model.uri.path.split('/').pop() || ''))
    blobUrl = URL.createObjectURL(new Blob([RUNNER], { type: 'application/javascript' }))
    const w = new Worker(blobUrl)
    worker = w
    running.set(true)
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string, text?: string, ms?: number }
      if (m.type === 'log') line(m.text || '')
      else if (m.type === 'done') { line(fill(T.finished, m.ms || 0)); running?.set(false) }
      else if (m.type === 'error') { line(fill(T.error, m.text || '')); running?.set(false) }
    }
    w.onerror = (e: ErrorEvent) => {
      line(fill(T.error, e.message))
      running?.set(false)
      e.preventDefault()
    }
    w.postMessage({ code: model.getValue(), lower: LOWER_URL })
  }
})

registerAction2(class StopAction extends Action2 {
  constructor() {
    super({
      id: 'kodium.stop',
      title: { value: T.stop, original: 'Stop' },
      category: { value: 'Kodium', original: 'Kodium' },
      icon: Codicon.debugStop,
      f1: true,
      precondition: RUNNING,
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: RUNNING }]
    })
  }

  run(accessor: ServicesAccessor): void {
    const channel = accessor.get(IOutputService).getChannel(CHANNEL)
    if (worker) channel?.append(T.stopped + '\n')
    end()
  }
})

const isPython = ContextKeyExpr.equals('resourceLangId', 'python')

registerAction2(class RunPythonAction extends Action2 {
  constructor() {
    super({
      id: 'kodium.runPython',
      title: { value: T.runPython, original: 'Run Python in Terminal' },
      category: { value: 'Kodium', original: 'Kodium' },
      icon: Codicon.play,
      f1: true,
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: isPython }],
      keybinding: [
        { primary: KeyCode.F5, when: ContextKeyExpr.equals('editorLangId', 'python'), weight: KeybindingWeight.WorkbenchContrib },
        { primary: KeyMod.WinCtrl | KeyMod.Alt | KeyCode.KeyN, when: ContextKeyExpr.equals('editorLangId', 'python'), weight: KeybindingWeight.WorkbenchContrib }
      ]
    })
  }

  async run(accessor: ServicesAccessor): Promise<void> {
    const editorService = accessor.get(IEditorService)
    const control = editorService.activeTextEditorControl as { getModel?: () => unknown } | undefined
    const model = control?.getModel?.() as { getLanguageId?: () => string, uri: { scheme: string, path: string } } | null | undefined
    const notifications = accessor.get(INotificationService)
    if (!model || typeof model.getLanguageId !== 'function' || model.getLanguageId() !== 'python') {
      notifications.info(T.notPython)
      return
    }
    const path = model.uri.path
    if (model.uri.scheme !== 'file' || !path.startsWith(DOCUMENTS + '/')) {
      notifications.info(T.saveToDocuments)
      return
    }
    const activeEditor = editorService.activeEditor
    if (activeEditor?.isDirty()) {
      await editorService.saveAll({ includeUntitled: false })
    }
    const rel = path.slice(DOCUMENTS.length + 1)
    const escaped = rel.replace(/(["\\$`])/g, '\\$1')
    const terminalService = accessor.get(ITerminalService)
    const instance = terminalService.activeInstance ?? await terminalService.createTerminal()
    await terminalService.showPanel(true)
    instance.focus()
    await instance.sendText(`python3 "${escaped}"`, true)
  }
})
