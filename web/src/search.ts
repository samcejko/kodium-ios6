// The search of the workspace's files (the Search view, Find in Files, Go to File): Kodium's own provider. The one
// monaco-vscode-api brings looked only at the files it had listed when the workbench started (a file put into Documents
// later was never searched - "function" in 20 new files: 1 match), took no account of the files to include or
// exclude, and split a whole file into lines again at every match it found. Here the app lists a folder's files at
// once (src/KDFiles.m walk: native, a few ms), VS Code's own QueryGlobTester applies the include and exclude patterns
// (files.exclude, search.exclude, the view's fields), and each file is read (four at a time) and searched with one
// regular expression over its text, the line of a match found in the line starts by a binary search. Results come as
// each file is done.
import { StandaloneServices } from '@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices'
import { ISearchService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search.service'
import { IFileService } from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files.service'
import {
  FileMatch,
  QueryGlobTester,
  SearchCompletionExitCode,
  SearchProviderType,
  SearchRange,
  TextSearchMatch,
  DEFAULT_MAX_SEARCH_RESULTS,
  type IFileMatch,
  type IFileQuery,
  type IFolderQuery,
  type ISearchComplete,
  type ISearchProgressItem,
  type ISearchResultProvider,
  type ITextQuery,
  type ITextSearchResult
} from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search'
import { createRegExp, fuzzyContains } from '@codingame/monaco-vscode-api/vscode/vs/base/common/strings'
import type { CancellationToken } from '@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation'
import { Schemas } from '@codingame/monaco-vscode-api/vscode/vs/base/common/network'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { DOCUMENTS, readDocument, walkDocuments } from './files'

// (a file this big or bigger is not searched, nor one with a NUL in its first 512 bytes: a binary file)
const MAX_FILE_SIZE = 5 * 1024 * 1024
const READERS = 4

interface Listed { path: string, size: number }

// the files below a folder of Documents, kept 3 s (Go to File asks at every key) or until the workbench changes one
const listings = new Map<string, { at: number, files: Listed[] }>()

async function filesBelow(folder: URI): Promise<Listed[] | null> {
  if (folder.scheme !== Schemas.file) return null
  const p = folder.path.replace(/\/+$/, '')
  if (p !== DOCUMENTS && !p.startsWith(DOCUMENTS + '/')) return null
  const inDocuments = p === DOCUMENTS ? '/' : p.slice(DOCUMENTS.length)
  const kept = listings.get(inDocuments)
  if (kept && Date.now() - kept.at < 3000) return kept.files
  const files = (await walkDocuments(inDocuments)).map(([path, size]) => ({ path, size }))
  listings.set(inDocuments, { at: Date.now(), files })
  return files
}

// a folder query's files that the query includes: [resource, path in Documents, size]
async function included(query: IFileQuery | ITextQuery, folderQuery: IFolderQuery): Promise<{ resource: URI, path: string, size: number }[]> {
  const files = await filesBelow(folderQuery.folder)
  if (!files) return []
  const folderPath = folderQuery.folder.path.replace(/\/+$/, '')
  const base = folderPath === DOCUMENTS ? '' : folderPath.slice(DOCUMENTS.length)
  const tester = new QueryGlobTester(query, folderQuery)
  // (for the patterns that look at a file's siblings: the folder's other files)
  const all = new Set<string>()
  for (const file of files) all.add(file.path)
  const out: { resource: URI, path: string, size: number }[] = []
  for (const file of files) {
    const relative = file.path.slice(base.length + 1)
    const slash = relative.lastIndexOf('/')
    const dir = file.path.slice(0, file.path.length - relative.length + slash + 1)
    const name = relative.slice(slash + 1)
    if (!tester.includedInQuerySync(relative, name, (sibling: string) => all.has(dir + sibling))) continue
    out.push({ resource: URI.file(DOCUMENTS + file.path), path: file.path, size: file.size })
  }
  return out
}

function complete(results: IFileMatch[], limitHit: boolean): ISearchComplete {
  return { results, limitHit, messages: [], exit: SearchCompletionExitCode.Normal }
}

// the line starts of a text (0, then after every \n)
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  return starts
}

// the line of an offset: the last line start at or before it
function lineOf(starts: number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return low
}

function lineText(text: string, starts: number[], line: number): string {
  const end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length
  const s = text.slice(starts[line], end)
  return s.charCodeAt(s.length - 1) === 13 ? s.slice(0, -1) : s
}

// a file's matches, one result per line with all of that line's ranges (as VS Code's ripgrep gives them); null when
// the file has none. limit: how many more matches the search wants.
function searchText(text: string, regexp: RegExp, query: ITextQuery, limit: number): { results: ITextSearchResult[], count: number } | null {
  regexp.lastIndex = 0
  let match = regexp.exec(text)
  if (!match) return null
  const starts = lineStarts(text)
  const results: ITextSearchResult[] = []
  let count = 0
  let line = -1
  let ranges: SearchRange[] = []
  let preview = ''
  const flush = () => {
    if (ranges.length) results.push(new TextSearchMatch(preview, ranges, query.previewOptions))
    ranges = []
  }
  while (match && count < limit) {
    const start = match.index
    const end = start + match[0].length
    const startLine = lineOf(starts, start)
    const endLine = end > start ? lineOf(starts, end - 1) : startLine
    if (startLine !== line || endLine !== startLine) {
      flush()
      line = startLine
      preview = startLine === endLine ? lineText(text, starts, startLine)
        : text.slice(starts[startLine], endLine + 1 < starts.length ? starts[endLine + 1] - 1 : text.length)
    }
    const endColumn = end - starts[endLine] - (end > start && text.charCodeAt(end - 1) === 10 ? 1 : 0)
    ranges.push(new SearchRange(startLine, start - starts[startLine], endLine, endColumn))
    count++
    if (endLine !== startLine) {
      flush()
      line = -1
    }
    if (match[0].length === 0) regexp.lastIndex++
    match = regexp.exec(text)
  }
  flush()
  return { results, count }
}

const decoder = new TextDecoder('utf-8')

function isBinary(bytes: Uint8Array): boolean {
  for (let i = 0, n = Math.min(bytes.length, 512); i < n; i++) if (bytes[i] === 0) return true
  return false
}

class DocumentsSearch implements ISearchResultProvider {
  async getAIName(): Promise<string | undefined> {
    return undefined
  }

  async fileSearch(query: IFileQuery, token?: CancellationToken): Promise<ISearchComplete> {
    const max = query.maxResults || DEFAULT_MAX_SEARCH_RESULTS
    const pattern = (query.filePattern || '').replace(/\s/g, '').toLowerCase()
    const results: IFileMatch[] = []
    let limitHit = false
    for (const folderQuery of query.folderQueries) {
      if (token?.isCancellationRequested) break
      for (const file of await included(query, folderQuery)) {
        if (pattern && !fuzzyContains(file.path.toLowerCase(), pattern)) continue
        if (results.length >= max || query.exists) {
          limitHit = true
          break
        }
        results.push({ resource: file.resource })
      }
      if (limitHit) break
    }
    return complete(query.exists ? [] : results, limitHit)
  }

  async textSearch(query: ITextQuery, onProgress?: (p: ISearchProgressItem) => void, token?: CancellationToken): Promise<ISearchComplete> {
    const pattern = query.contentPattern
    const regexp = createRegExp(pattern.pattern, !!pattern.isRegExp, {
      matchCase: !!pattern.isCaseSensitive, wholeWord: !!pattern.isWordMatch, multiline: !!pattern.isMultiline, global: true, unicode: !!pattern.isUnicode
    })
    const max = query.maxResults || DEFAULT_MAX_SEARCH_RESULTS
    const maxSize = Math.min(query.maxFileSize || MAX_FILE_SIZE, MAX_FILE_SIZE)
    const files: { resource: URI, path: string }[] = []
    for (const folderQuery of query.folderQueries) {
      for (const file of await included(query, folderQuery)) if (file.size > 0 && file.size < maxSize) files.push(file)
    }
    const matches: IFileMatch[] = []
    let count = 0
    let next = 0
    const reader = async (): Promise<void> => {
      while (next < files.length && count < max && !token?.isCancellationRequested) {
        const file = files[next++]
        let bytes: Uint8Array | null = null
        try { bytes = await readDocument(file.path) } catch { bytes = null }
        if (!bytes || isBinary(bytes) || token?.isCancellationRequested || count >= max) continue
        const found = searchText(decoder.decode(bytes), regexp, query, max - count)
        if (!found) continue
        count += found.count
        const match = new FileMatch(file.resource)
        match.results = found.results
        matches.push(match)
        onProgress?.(match)
      }
    }
    const readers: Promise<void>[] = []
    for (let i = 0; i < READERS; i++) readers.push(reader())
    await Promise.all(readers)
    return complete(matches, count >= max)
  }

  async clearCache(): Promise<void> {
    listings.clear()
  }
}

// Kodium's provider for the file: scheme (Documents), in place of monaco-vscode-api's (vite.config.mjs makes none)
export function registerSearch(): void {
  const provider = new DocumentsSearch()
  const search = StandaloneServices.get(ISearchService)
  search.registerSearchResultProvider(Schemas.file, SearchProviderType.file, provider)
  search.registerSearchResultProvider(Schemas.file, SearchProviderType.text, provider)
  StandaloneServices.get(IFileService).onDidFilesChange(() => listings.clear())
}
