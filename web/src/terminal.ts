// The terminal panel: VS Code's own (monaco-vscode-api's terminal service, xterm.js), its shells on the iPad itself.
// iOS lets Kodium - an app of /var/mobile/Applications - start no process: the app (src/KDTerminal.m) connects to the
// Kodium Shell package's daemon (shell/kodium-shelld.c), which runs a login shell (bash) on a pseudo terminal as the
// user mobile. A shell's output comes by long polls of /__kd/term/read - the app answers as soon as there is some, or
// after 20 s with nothing - its input goes by POSTs of /__kd/term/write, as UTF-8.
import getTerminalServiceOverride, {
  ITerminalService,
  SimpleTerminalBackend,
  SimpleTerminalProcess,
  type ITerminalChildProcess
} from '@codingame/monaco-vscode-terminal-service-override'
import type { IProcessReadyEvent } from '@codingame/monaco-vscode-api/vscode/vs/platform/terminal/common/terminal'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { StandaloneServices } from '@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices'

const API = location.href.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '') + '/__kd/term/'

const cs = /^cs/i.test((window as { __kd_lang?: string }).__kd_lang || '')
// (what the terminal shows when the package is missing: it can be installed with Cydia's dpkg from the PC, see README)
const NO_DAEMON = cs
  ? 'Terminál Kodia potřebuje balíček Kodium Shell (Kodium-shell-*.deb): iOS aplikaci nedovolí spustit žádný proces,\r\n' +
    'shelly spouští démon z balíčku. Nainstalujte ho (dpkg -i) a otevřete terminál znovu.\r\n'
  : 'Kodium needs the package Kodium Shell (Kodium-shell-*.deb) for its terminal: iOS lets an app start no\r\n' +
    'process, the package\'s daemon runs the shells. Install it (dpkg -i) and open the terminal again.\r\n'

function call(op: string, params: Record<string, string | number>, body?: Uint8Array, binary = false): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const query = Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]))).join('&')
    xhr.open(body ? 'POST' : 'GET', API + op + '?' + query, true)
    if (binary) xhr.responseType = 'arraybuffer'
    xhr.onload = () => resolve(xhr)
    xhr.onerror = () => reject(new Error('The app did not answer (' + op + ')'))
    const data = body ? (body.byteOffset === 0 && body.byteLength === body.buffer.byteLength ? body.buffer : body.slice().buffer) : null
    xhr.send(data as ArrayBuffer | null)
  })
}

class KodiumShell extends SimpleTerminalProcess {
  private session = 0
  private ended = false
  private readonly decoder = new TextDecoder('utf-8')
  private readonly encoder = new TextEncoder()
  private readonly exited: Emitter<number | undefined>
  // (VS Code's process manager listens for "ready" from before start() and sends the input only to a shell with a
  // process ID: the base class fires it with ours (0) on a timer from the constructor, so start() fires its own)
  private readonly ready = new Emitter<IProcessReadyEvent>()
  // (input typed while the shell is being started, sent once it is)
  private pending: string[] = []

  constructor(id: number, cwd: string, private cols: number, private rows: number,
    private readonly output: Emitter<string>, exited: Emitter<number | undefined>) {
    super(id, 0, cwd, output.event)
    this.exited = exited
    this.onProcessExit = exited.event
    this.onProcessReady = this.ready.event
  }

  async start (): Promise<undefined | { message: string }> {
    let xhr: XMLHttpRequest
    try {
      xhr = await call('open', { cols: this.cols, rows: this.rows, cwd: this.cwd })
    } catch (e) {
      return { message: String(e) }
    }
    if (xhr.status === 503) {
      this.ended = true
      setTimeout(() => this.output.fire(NO_DAEMON), 0)
      return undefined
    }
    if (xhr.status !== 200) return { message: 'The shell did not start (' + xhr.status + ' ' + xhr.responseText + ')' }
    // (the shell's process ID, from Kodium Shell 0.1.1 on; the session's before)
    const opened = JSON.parse(xhr.responseText) as { id: number, pid?: number }
    this.session = opened.id
    this.ready.fire({ pid: opened.pid || opened.id, cwd: this.cwd, windowsPty: undefined })
    for (const data of this.pending) this.input(data)
    this.pending = []
    this.read()
    return undefined
  }

  // the shell's output, read after read until it ends
  private read (): void {
    if (this.ended) return
    call('read', { id: this.session }, undefined, true).then((xhr) => {
      if (xhr.status === 200) {
        const text = this.decoder.decode(new Uint8Array(xhr.response as ArrayBuffer), { stream: true })
        if (text) this.output.fire(text)
        this.read()
      } else if (xhr.status === 204) {
        this.read()
      } else {
        this.ended = true
        this.exited.fire(0)
      }
    }, () => {
      // (the app was busy or the page went to the background: again in a moment)
      setTimeout(() => this.read(), 1000)
    })
  }

  input (data: string): void {
    if (this.ended) return
    if (!this.session) {
      this.pending.push(data)
      return
    }
    void call('write', { id: this.session }, this.encoder.encode(data))
  }

  resize (cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    if (this.session && !this.ended) void call('resize', { id: this.session, cols, rows })
  }

  shutdown (): void {
    if (this.session && !this.ended) void call('close', { id: this.session })
    this.ended = true
  }

  sendSignal (signal: string): void {
    // (a signal by its character on the terminal: the pseudo terminal's line discipline sends it to the foreground)
    const chars: Record<string, string> = { SIGINT: '\x03', SIGQUIT: '\x1c', SIGTSTP: '\x1a' }
    if (chars[signal]) this.input(chars[signal])
  }

  clearBuffer (): void {}
}

class KodiumTerminalBackend extends SimpleTerminalBackend {
  override getDefaultSystemShell = async (): Promise<string> => '/bin/bash'
  override createProcess = async (_shell: unknown, cwd: string, cols: number, rows: number): Promise<ITerminalChildProcess> => {
    return new KodiumShell(++lastId, cwd || '/Documents', cols, rows, new Emitter<string>(), new Emitter<number | undefined>())
  }
}

let lastId = 0

export function getTerminalOverride (): ReturnType<typeof getTerminalServiceOverride> {
  const backend = new KodiumTerminalBackend()
  backend.setReady()
  return getTerminalServiceOverride(backend)
}

// (for the tests over SSH: the active terminal's lines as xterm.js keeps them, whatever is drawn - a line the terminal
// wrapped joined again; null without a terminal)
;(window as { __kd_terminalLines?: unknown }).__kd_terminalLines = (): string[] | null => {
  const xterm = StandaloneServices.get(ITerminalService).activeInstance?.xterm?.raw
  if (!xterm) return null
  const buffer = xterm.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (!line) continue
    if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true)
    else lines.push(line.translateToString(true))
  }
  return lines
}
