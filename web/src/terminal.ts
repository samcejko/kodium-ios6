// The terminal panel: VS Code's own (monaco-vscode-api's terminal service, xterm.js), its shells on the iPad itself.
// iOS lets Kodium - an app of /var/mobile/Applications - start no process: the app (src/KDTerminal.m) connects to the
// Kodium Shell package's daemon (shell/kodium-shelld.c), which runs a login shell (bash) on a pseudo terminal as the
// user mobile. A shell's output comes by long polls of /__kd/term/read - the app answers as soon as there is some, or
// after 20 s with nothing - its input goes by POSTs of /__kd/term/write, as UTF-8.
import getTerminalServiceOverride, {
  SimpleTerminalBackend,
  SimpleTerminalProcess,
  type ITerminalChildProcess
} from '@codingame/monaco-vscode-terminal-service-override'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'

const API = location.href.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '') + '/__kd/term/'

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

// (what the terminal shows when the package is missing: it can be installed with Cydia's dpkg from the PC, see README)
const NO_DAEMON = 'Kodium needs the package Kodium Shell (Kodium-shell-*.deb) for its terminal: iOS lets an app start no\r\n' +
  'process, the package\'s daemon runs the shells. Install it (dpkg -i) and open the terminal again.\r\n'

class KodiumShell extends SimpleTerminalProcess {
  private session = 0
  private ended = false
  private readonly decoder = new TextDecoder('utf-8')
  private readonly encoder = new TextEncoder()
  private readonly exited: Emitter<number | undefined>
  // (input typed while the shell is being started, sent once it is)
  private pending: string[] = []

  constructor(id: number, cwd: string, private cols: number, private rows: number,
    private readonly output: Emitter<string>, exited: Emitter<number | undefined>) {
    super(id, 0, cwd, output.event)
    this.exited = exited
    this.onProcessExit = exited.event
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
    this.session = (JSON.parse(xhr.responseText) as { id: number }).id
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
