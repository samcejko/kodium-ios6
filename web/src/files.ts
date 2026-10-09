// The iPad's own files: the app's Documents folder (shared through iTunes) as file:///Documents, the workspace; and
// VS Code's user data (vscode-userdata:/User/settings.json, keybindings.json, snippets...), which VS Code would keep in
// memory only, in the app's Library. The app answers https://kodium.invalid/__kd/fs/<operation> (src/KDFiles.m, with
// root=userdata for the second); tools/serve.ps1 does the same for folders on the PC, for trying the workbench in a
// desktop browser. Plain XMLHttpRequest: the iOS 6 engine has it with array buffers, and its fetch is a polyfill over it
// anyway.
import {
  registerFileSystemOverlay,
  registerCustomProvider,
  FileChangeType,
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IFileChange,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IFileWriteOptions,
  type IStat
} from '@codingame/monaco-vscode-files-service-override'
import { Emitter } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { Schemas } from '@codingame/monaco-vscode-api/vscode/vs/base/common/network'

export const DOCUMENTS = '/Documents'
const API = location.href.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '') + '/__kd/fs/'

type Root = 'documents' | 'userdata'

function call(root: Root, op: string, params: Record<string, string>, body?: Uint8Array, binary = false): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const all: Record<string, string> = root === 'documents' ? params : { ...params, root }
    const query = Object.keys(all).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(all[k])).join('&')
    const reading = op === 'stat' || op === 'list' || op === 'read'
    xhr.open(reading ? 'GET' : 'POST', API + op + '?' + query, true)
    if (binary) xhr.responseType = 'arraybuffer'
    xhr.onload = () => resolve(xhr)
    xhr.onerror = () => reject(FileSystemProviderError.create('The app did not answer (' + op + ')', FileSystemProviderErrorCode.Unavailable))
    // (a view of a part of a buffer goes as a copy of that part)
    const data = body ? (body.byteOffset === 0 && body.byteLength === body.buffer.byteLength ? body.buffer : body.slice().buffer) : null
    xhr.send(data as ArrayBuffer | null)
  })
}

// The same, synchronously: the request's answer as text (bytes as x-user-defined characters with binary)
function callSync(root: Root, op: string, params: Record<string, string>, binary = false): XMLHttpRequest {
  const xhr = new XMLHttpRequest()
  const all: Record<string, string> = root === 'documents' ? params : { ...params, root }
  xhr.open('GET', API + op + '?' + Object.keys(all).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(all[k])).join('&'), false)
  // (no response type for a synchronous request of a page)
  if (binary) xhr.overrideMimeType('text/plain; charset=x-user-defined')
  xhr.send(null)
  return xhr
}

// A file read on its own (none in the last 0.3 s) and small (64 KB or less) is read synchronously: a stat and a read
// of 5-8 ms each that the page waits for. Asynchronously they came back only once the WebThread had done everything
// else the opening of a file had for it (the tab, the editor drawn empty...): 110-140 ms on the iPad 2. Many reads in a
// row (a search) go the asynchronous way, as big files do, and the page goes on between them.
const SYNC_MAX = 64 * 1024
const SYNC_GAP = 300

function check(xhr: XMLHttpRequest, resource: URI): void {
  if (xhr.status === 200) return
  const code = xhr.status === 404 ? FileSystemProviderErrorCode.FileNotFound
    : xhr.status === 409 ? FileSystemProviderErrorCode.FileExists
    : xhr.status === 403 ? FileSystemProviderErrorCode.NoPermissions
    : FileSystemProviderErrorCode.Unknown
  throw FileSystemProviderError.create(resource.toString() + ' (' + xhr.status + ')', code)
}

function toStat(json: string): IStat {
  const s = JSON.parse(json) as { type: number, size: number, mtime: number, ctime: number }
  return { type: s.type === 2 ? FileType.Directory : FileType.File, size: s.size, mtime: s.mtime, ctime: s.ctime }
}

function notHere(resource: URI): never {
  throw FileSystemProviderError.create(resource.toString(), FileSystemProviderErrorCode.FileNotFound)
}

// A folder of the app. toPath gives a resource's path in it ("/a/b"), null for one that is not there.
// (No watching: what changes, changes through the workbench. The workspace's changes the file service reports itself;
// the user data's are reported here, which is what makes VS Code read settings.json again when it is saved.)
class AppFolderProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive
  private readonly changes = new Emitter<readonly IFileChange[]>()
  readonly onDidChangeFile = this.changes.event
  readonly onDidChangeCapabilities = new Emitter<void>().event
  // (when the last synchronous read was; the stat it made, for the file service's stat that follows it)
  private lastSyncRead = 0
  private lastStat: { path: string, stat: IStat, at: number } | null = null

  constructor(
    private readonly root: Root,
    private readonly toPath: (resource: URI) => string | null,
    private readonly reportChanges: boolean
  ) {}

  watch() {
    return { dispose() {} }
  }

  private changed(...changes: IFileChange[]): void {
    this.lastStat = null
    if (this.reportChanges) this.changes.fire(changes)
  }

  async stat(resource: URI): Promise<IStat> {
    const path = this.toPath(resource) ?? notHere(resource)
    const last = this.lastStat
    if (last && last.path === path && Date.now() - last.at < 1000) return last.stat
    const xhr = await call(this.root, 'stat', { path })
    check(xhr, resource)
    return toStat(xhr.responseText)
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const path = this.toPath(resource) ?? notHere(resource)
    const xhr = await call(this.root, 'list', { path })
    check(xhr, resource)
    return (JSON.parse(xhr.responseText) as [string, number][]).map(([name, type]) => [name, type === 2 ? FileType.Directory : FileType.File])
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const path = this.toPath(resource) ?? notHere(resource)
    const now = Date.now()
    if (now - this.lastSyncRead > SYNC_GAP) {
      this.lastSyncRead = now
      const bytes = this.readSmall(path)
      if (bytes) return bytes
    } else this.lastSyncRead = now
    const xhr = await call(this.root, 'read', { path }, undefined, true)
    check(xhr, resource)
    return new Uint8Array(xhr.response as ArrayBuffer)
  }

  // a small file's bytes, read synchronously; null for anything else (a big file, a folder, an error: the
  // asynchronous way says what it is)
  private readSmall(path: string): Uint8Array | null {
    try {
      const statXhr = callSync(this.root, 'stat', { path })
      if (statXhr.status !== 200) return null
      const stat = toStat(statXhr.responseText)
      if (stat.type !== FileType.File || stat.size > SYNC_MAX) return null
      const xhr = callSync(this.root, 'read', { path }, true)
      if (xhr.status !== 200) return null
      const text = xhr.responseText
      const bytes = new Uint8Array(text.length)
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
      this.lastStat = { path, stat: { ...stat, size: bytes.length }, at: Date.now() }
      return bytes
    } catch {
      return null
    }
  }

  async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
    const path = this.toPath(resource) ?? notHere(resource)
    check(await call(this.root, 'write', { path, create: opts.create ? '1' : '0', overwrite: opts.overwrite ? '1' : '0' }, content), resource)
    this.changed({ type: FileChangeType.UPDATED, resource })
  }

  async mkdir(resource: URI): Promise<void> {
    const path = this.toPath(resource) ?? notHere(resource)
    check(await call(this.root, 'mkdir', { path }), resource)
    this.changed({ type: FileChangeType.ADDED, resource })
  }

  async delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
    const path = this.toPath(resource) ?? notHere(resource)
    check(await call(this.root, 'delete', { path, recursive: opts.recursive ? '1' : '0' }), resource)
    this.changed({ type: FileChangeType.DELETED, resource })
  }

  async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
    const path = this.toPath(from) ?? notHere(from)
    const target = this.toPath(to) ?? notHere(to)
    check(await call(this.root, 'rename', { path, to: target, overwrite: opts.overwrite ? '1' : '0' }), from)
    this.changed({ type: FileChangeType.DELETED, resource: from }, { type: FileChangeType.ADDED, resource: to })
  }
}

const SAMPLES: [string, string][] = [
  ['/README.md', '# Kodium\n\nThis folder is the app\'s Documents: what you put here in iTunes (File Sharing) shows up in the\nexplorer, and what you save here you can copy back to the computer the same way.\n'],
  ['/hello.js', '// Kodium on iOS 6\nfunction greet(name) {\n  return \'Hello, \' + name + \'!\'\n}\n\nconsole.log(greet(\'iPad 2\'))\n']
]

// The two folders (before the workbench starts), and two files to start with when Documents is empty (the first start)
export async function registerAppFolders(): Promise<void> {
  // file:///Documents/a/b -> "/a/b"; null outside Documents (another provider's)
  const documents = new AppFolderProvider('documents', (resource) => {
    const p = resource.path
    if (p === DOCUMENTS) return '/'
    return p.startsWith(DOCUMENTS + '/') ? p.slice(DOCUMENTS.length) : null
  }, false)
  registerFileSystemOverlay(2, documents)
  // vscode-userdata:/User/settings.json -> "/User/settings.json"
  registerCustomProvider(Schemas.vscodeUserData, new AppFolderProvider('userdata', (resource) => resource.path.startsWith('/') ? resource.path : null, true))

  const root = URI.file(DOCUMENTS)
  try {
    if ((await documents.readdir(root)).length) return
    const encoder = new TextEncoder()
    for (const [path, text] of SAMPLES) {
      await documents.writeFile(URI.file(DOCUMENTS + path), encoder.encode(text), { create: true, overwrite: false, unlock: false, atomic: false })
    }
  } catch (e) {
    console.warn('Documents:', e)
  }
}
