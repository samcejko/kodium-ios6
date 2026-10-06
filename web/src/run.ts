// Kodium's own extension: Run - the active JavaScript file in a worker of its own (a loop that never ends can be
// stopped: the worker goes), its console in the Output panel. Code the iOS 6 engine cannot parse (ES2015 and later)
// goes to the engine's transpiler first (https://ios6-browser.invalid/lower, the app's own; a desktop browser runs it
// as it is). It runs as an extension of the in-page extension host, as the extensions from Open VSX do.
import { ExtensionHostKind, registerExtension } from '@codingame/monaco-vscode-api/extensions'

const cs = /^cs/i.test((window as { __kd_lang?: string }).__kd_lang || '')
const T = cs
  ? {
      run: 'Spustit JavaScript', stop: 'Zastavit', channel: 'Kodium: Spustit', running: 'Spouštím {0}…',
      finished: 'Hotovo za {0} ms (časovače programu běží dál, dokud ho nezastavíte nebo nespustíte znovu)',
      stopped: 'Zastaveno.', error: 'Chyba: {0}', notJs: 'Spustit lze jen soubor JavaScriptu.'
    }
  : {
      run: 'Run JavaScript', stop: 'Stop', channel: 'Kodium: Run', running: 'Running {0}…',
      finished: 'Done in {0} ms (the program\'s timers go on until you stop it or run it again)',
      stopped: 'Stopped.', error: 'Error: {0}', notJs: 'Only a JavaScript file can be run.'
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

const { getApi } = registerExtension({
  name: 'run',
  publisher: 'kodium',
  version: '0.1.0',
  displayName: 'Kodium Run',
  engines: { vscode: '*' },
  contributes: {
    commands: [
      { command: 'kodium.run', title: T.run, category: 'Kodium', icon: '$(play)' },
      { command: 'kodium.stop', title: T.stop, category: 'Kodium', icon: '$(debug-stop)' }
    ],
    menus: {
      'editor/title': [
        { command: 'kodium.run', when: 'resourceLangId == javascript && !kodium.running', group: 'navigation' },
        { command: 'kodium.stop', when: 'kodium.running', group: 'navigation' }
      ],
      commandPalette: [{ command: 'kodium.stop', when: 'kodium.running' }]
    },
    keybindings: [
      { command: 'kodium.run', key: 'f5', when: 'editorLangId == javascript' },
      { command: 'kodium.run', key: 'ctrl+alt+n', when: 'editorLangId == javascript' }
    ]
  }
}, ExtensionHostKind.LocalProcess, { system: true })

void getApi().then((vscode) => {
  // (the API for the app's developer commands over SSH: eval can run VS Code's commands - see tools/ipad.ps1)
  ;(window as { __kd_api?: unknown }).__kd_api = vscode
  const channel = vscode.window.createOutputChannel(T.channel)
  let worker: Worker | null = null
  let blobUrl: string | null = null
  const setRunning = (on: boolean) => { void vscode.commands.executeCommand('setContext', 'kodium.running', on) }
  const end = () => {
    if (worker) worker.terminate()
    worker = null
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    blobUrl = null
    setRunning(false)
  }
  vscode.commands.registerCommand('kodium.run', () => {
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.document.languageId !== 'javascript') {
      void vscode.window.showInformationMessage(T.notJs)
      return
    }
    end()
    channel.clear()
    channel.show(true)
    channel.appendLine(fill(T.running, editor.document.uri.path.split('/').pop() || ''))
    blobUrl = URL.createObjectURL(new Blob([RUNNER], { type: 'application/javascript' }))
    const w = new Worker(blobUrl)
    worker = w
    setRunning(true)
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string, text?: string, ms?: number }
      if (m.type === 'log') channel.appendLine(m.text || '')
      else if (m.type === 'done') { channel.appendLine(fill(T.finished, m.ms || 0)); setRunning(false) }
      else if (m.type === 'error') { channel.appendLine(fill(T.error, m.text || '')); setRunning(false) }
    }
    w.onerror = (e: ErrorEvent) => {
      channel.appendLine(fill(T.error, e.message))
      setRunning(false)
      e.preventDefault()
    }
    w.postMessage({ code: editor.document.getText(), lower: LOWER_URL })
  })
  vscode.commands.registerCommand('kodium.stop', () => {
    if (worker) channel.appendLine(T.stopped)
    end()
  })
})
