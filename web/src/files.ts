// The iPad's own files: the app's Documents folder (shared through iTunes) as file:///Documents, the workspace. The app
// answers https://kodium.invalid/__kd/fs/<operation> (src/KDFiles.m); tools/serve.ps1 does the same for a folder on
// the PC, for trying the workbench in a desktop browser. Plain XMLHttpRequest: the iOS 6 engine has it with array
// buffers, and its fetch is a polyfill over it anyway.
import {
  registerFileSystemOverlay,
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
import * as vscode from 'vscode'

export const DOCUMENTS = '/Documents'
const API = location.href.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '') + '/__kd/fs/'

type Uri = { readonly path: string, toString(): string }

// file:///Documents/a/b -> "/a/b"; null outside Documents (another provider's)
function apiPath(resource: Uri): string | null {
  const p = resource.path
  if (p === DOCUMENTS) return '/'
  return p.startsWith(DOCUMENTS + '/') ? p.slice(DOCUMENTS.length) : null
}

function call(op: string, params: Record<string, string>, body?: Uint8Array, binary = false): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const query = Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&')
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

function check(xhr: XMLHttpRequest, resource: Uri): void {
  if (xhr.status === 200) return
  const code = xhr.status === 404 ? FileSystemProviderErrorCode.FileNotFound
    : xhr.status === 409 ? FileSystemProviderErrorCode.FileExists
    : xhr.status === 403 ? FileSystemProviderErrorCode.NoPermissions
    : FileSystemProviderErrorCode.Unknown
  throw FileSystemProviderError.create(resource.toString() + ' (' + xhr.status + ')', code)
}

function notHere(resource: Uri): never {
  throw FileSystemProviderError.create(resource.toString(), FileSystemProviderErrorCode.FileNotFound)
}

class DocumentsProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive
  private readonly changes = new Emitter<readonly IFileChange[]>()
  readonly onDidChangeFile = this.changes.event
  readonly onDidChangeCapabilities = new Emitter<void>().event

  // (no watching: what changes, changes through the workbench, whose file service reports it itself)
  watch() {
    return { dispose() {} }
  }

  async stat(resource: Uri): Promise<IStat> {
    const path = apiPath(resource) ?? notHere(resource)
    const xhr = await call('stat', { path })
    check(xhr, resource)
    const s = JSON.parse(xhr.responseText) as { type: number, size: number, mtime: number, ctime: number }
    return { type: s.type === 2 ? FileType.Directory : FileType.File, size: s.size, mtime: s.mtime, ctime: s.ctime }
  }

  async readdir(resource: Uri): Promise<[string, FileType][]> {
    const path = apiPath(resource) ?? notHere(resource)
    const xhr = await call('list', { path })
    check(xhr, resource)
    return (JSON.parse(xhr.responseText) as [string, number][]).map(([name, type]) => [name, type === 2 ? FileType.Directory : FileType.File])
  }

  async readFile(resource: Uri): Promise<Uint8Array> {
    const path = apiPath(resource) ?? notHere(resource)
    const xhr = await call('read', { path }, undefined, true)
    check(xhr, resource)
    return new Uint8Array(xhr.response as ArrayBuffer)
  }

  async writeFile(resource: Uri, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
    const path = apiPath(resource) ?? notHere(resource)
    check(await call('write', { path, create: opts.create ? '1' : '0', overwrite: opts.overwrite ? '1' : '0' }, content), resource)
  }

  async mkdir(resource: Uri): Promise<void> {
    const path = apiPath(resource) ?? notHere(resource)
    check(await call('mkdir', { path }), resource)
  }

  async delete(resource: Uri, opts: IFileDeleteOptions): Promise<void> {
    const path = apiPath(resource) ?? notHere(resource)
    check(await call('delete', { path, recursive: opts.recursive ? '1' : '0' }), resource)
  }

  async rename(from: Uri, to: Uri, opts: IFileOverwriteOptions): Promise<void> {
    const path = apiPath(from) ?? notHere(from)
    const target = apiPath(to) ?? notHere(to)
    check(await call('rename', { path, to: target, overwrite: opts.overwrite ? '1' : '0' }), from)
  }
}

const SAMPLES: [string, string][] = [
  ['/README.md', '# Kodium\n\nThis folder is the app\'s Documents: what you put here in iTunes (File Sharing) shows up in the\nexplorer, and what you save here you can copy back to the computer the same way.\n'],
  ['/hello.js', '// Kodium on iOS 6\nfunction greet(name) {\n  return \'Hello, \' + name + \'!\'\n}\n\nconsole.log(greet(\'iPad 2\'))\n']
]

// The provider, and two files to start with when Documents is empty (the first start)
export async function registerDocuments(): Promise<void> {
  const provider = new DocumentsProvider()
  registerFileSystemOverlay(2, provider)
  const root = vscode.Uri.file(DOCUMENTS)
  try {
    if ((await provider.readdir(root)).length) return
    const encoder = new TextEncoder()
    for (const [path, text] of SAMPLES) {
      await provider.writeFile(vscode.Uri.file(DOCUMENTS + path), encoder.encode(text), { create: true, overwrite: false, unlock: false, atomic: false })
    }
  } catch (e) {
    console.warn('Documents:', e)
  }
}
