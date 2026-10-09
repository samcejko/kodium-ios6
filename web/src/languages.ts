// Syntax highlighting without TextMate: VS Code's TextMate grammars need the Oniguruma regular expression engine, which
// is WebAssembly, and iOS 6 has none. monaco's Monarch grammars (plain JavaScript regular expressions) instead, for the
// languages people write on an iPad, and a small one of Kodium's own for JSON (settings.json, package.json...).
// The languages are registered once the workbench's services run (registering them earlier would start the editor's
// own services first); each grammar is loaded when a file of its language opens.
import { editor, languages } from 'monaco-editor'
import { getService, IThemeService } from '@codingame/monaco-vscode-api/services'
import { TokenizationRegistry } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages'
import { ModesRegistry } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages/modesRegistry'
import { Color } from '@codingame/monaco-vscode-api/vscode/vs/base/common/color'
import { generateTokensCSSForColorMap } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages/supports/tokenization'

type Grammar = { conf: languages.LanguageConfiguration, language: languages.IMonarchLanguage }
type Definition = languages.ILanguageExtensionPoint & { load: () => Promise<Grammar> }

// (the definitions of standalone-languages' register.js files; the import paths written out, as the bundler needs them)
const DEFINITIONS: Definition[] = [
  { id: 'javascript', extensions: ['.js', '.es6', '.jsx', '.mjs', '.cjs'], firstLine: '^#!.*\\bnode', filenames: ['jakefile'], aliases: ['JavaScript', 'javascript', 'js'], mimetypes: ['text/javascript'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/javascript/javascript.js') },
  { id: 'typescript', extensions: ['.ts', '.tsx', '.cts', '.mts'], aliases: ['TypeScript', 'ts', 'typescript'], mimetypes: ['text/typescript'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/typescript/typescript.js') },
  { id: 'html', extensions: ['.html', '.htm', '.shtml', '.xhtml', '.mdoc', '.jsp', '.asp', '.aspx', '.jshtm'], aliases: ['HTML', 'htm', 'html', 'xhtml'], mimetypes: ['text/html', 'text/x-jshtm', 'text/template', 'text/ng-template'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/html/html.js') },
  { id: 'css', extensions: ['.css'], aliases: ['CSS', 'css'], mimetypes: ['text/css'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/css/css.js') },
  { id: 'scss', extensions: ['.scss'], aliases: ['Sass', 'sass', 'scss'], mimetypes: ['text/x-scss', 'text/scss'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/scss/scss.js') },
  { id: 'less', extensions: ['.less'], aliases: ['Less', 'less'], mimetypes: ['text/x-less', 'text/less'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/less/less.js') },
  { id: 'markdown', extensions: ['.md', '.markdown', '.mdown', '.mkdn', '.mkd', '.mdwn', '.mdtxt', '.mdtext'], aliases: ['Markdown', 'markdown'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/markdown/markdown.js') },
  { id: 'python', extensions: ['.py', '.rpy', '.pyw', '.cpy', '.gyp', '.gypi'], aliases: ['Python', 'py'], firstLine: '^#!/.*\\bpython[0-9.-]*\\b', load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/python/python.js') },
  { id: 'shell', extensions: ['.sh', '.bash'], aliases: ['Shell', 'sh'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/shell/shell.js') },
  { id: 'c', extensions: ['.c', '.h'], aliases: ['C', 'c'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/cpp/cpp.js') },
  { id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'], aliases: ['C++', 'Cpp', 'cpp'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/cpp/cpp.js') },
  { id: 'objective-c', extensions: ['.m'], aliases: ['Objective-C'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/objective-c/objective-c.js') },
  { id: 'swift', aliases: ['Swift', 'swift'], extensions: ['.swift'], mimetypes: ['text/swift'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/swift/swift.js') },
  { id: 'java', extensions: ['.java', '.jav'], aliases: ['Java', 'java'], mimetypes: ['text/x-java-source', 'text/x-java'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/java/java.js') },
  { id: 'kotlin', extensions: ['.kt', '.kts'], aliases: ['Kotlin', 'kotlin'], mimetypes: ['text/x-kotlin-source', 'text/x-kotlin'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/kotlin/kotlin.js') },
  { id: 'csharp', extensions: ['.cs', '.csx', '.cake'], aliases: ['C#', 'csharp'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/csharp/csharp.js') },
  { id: 'go', extensions: ['.go'], aliases: ['Go'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/go/go.js') },
  { id: 'rust', extensions: ['.rs', '.rlib'], aliases: ['Rust', 'rust'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/rust/rust.js') },
  { id: 'php', extensions: ['.php', '.php4', '.php5', '.phtml', '.ctp'], aliases: ['PHP', 'php'], mimetypes: ['application/x-php'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/php/php.js') },
  { id: 'ruby', extensions: ['.rb', '.rbx', '.rjs', '.gemspec', '.pp'], filenames: ['rakefile', 'Gemfile'], aliases: ['Ruby', 'rb'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/ruby/ruby.js') },
  { id: 'perl', extensions: ['.pl', '.pm'], aliases: ['Perl', 'pl'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/perl/perl.js') },
  { id: 'lua', extensions: ['.lua'], aliases: ['Lua', 'lua'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/lua/lua.js') },
  { id: 'dart', extensions: ['.dart'], aliases: ['Dart', 'dart'], mimetypes: ['text/x-dart-source', 'text/x-dart'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/dart/dart.js') },
  { id: 'sql', extensions: ['.sql'], aliases: ['SQL'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/sql/sql.js') },
  { id: 'xml', extensions: ['.xml', '.xsd', '.dtd', '.ascx', '.csproj', '.config', '.props', '.targets', '.wxi', '.wxl', '.wxs', '.xaml', '.svg', '.svgz', '.opf', '.xslt', '.xsl', '.plist'], firstLine: '(\\<\\?xml.*)|(\\<svg)|(\\<\\!doctype\\s+svg)', aliases: ['XML', 'xml'], mimetypes: ['text/xml', 'application/xml', 'application/xaml+xml', 'application/xml-dtd'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/xml/xml.js') },
  { id: 'yaml', extensions: ['.yaml', '.yml'], aliases: ['YAML', 'yaml', 'YML', 'yml'], mimetypes: ['application/x-yaml', 'text/x-yaml'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/yaml/yaml.js') },
  { id: 'ini', extensions: ['.ini', '.properties', '.gitconfig'], filenames: ['config', '.gitattributes', '.gitconfig', '.editorconfig'], aliases: ['Ini', 'ini'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/ini/ini.js') },
  { id: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'], aliases: ['Dockerfile'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/dockerfile/dockerfile.js') },
  { id: 'powershell', extensions: ['.ps1', '.psm1', '.psd1'], aliases: ['PowerShell', 'powershell', 'ps', 'ps1'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/powershell/powershell.js') },
  { id: 'bat', extensions: ['.bat', '.cmd'], aliases: ['Batch', 'bat'], load: () => import('@codingame/monaco-vscode-standalone-languages/languages/definitions/bat/bat.js') }
]

// JSON with comments (VS Code's own files are JSONC): keys as variables, as VS Code's themes colour them
const JSON_GRAMMAR: Grammar = {
  conf: {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [
      { open: '{', close: '}', notIn: ['string'] },
      { open: '[', close: ']', notIn: ['string'] },
      { open: '"', close: '"', notIn: ['string'] }
    ]
  },
  language: {
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'variable'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/[{}[\],:]/, 'delimiter']
      ],
      comment: [
        [/[^*/]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[*/]/, 'comment']
      ]
    }
  }
}
DEFINITIONS.push({
  id: 'json', extensions: ['.json', '.jsonc', '.code-workspace', '.babelrc', '.eslintrc', '.jshintrc', '.webmanifest'],
  filenames: ['settings.json', 'keybindings.json', 'launch.json', 'tasks.json', 'tsconfig.json', 'jsconfig.json'],
  aliases: ['JSON', 'json'], mimetypes: ['application/json'], load: () => Promise.resolve(JSON_GRAMMAR)
})

// ---- The colours. Monarch asks the theme for a "tokenTheme" (monaco's own themes have one), which VS Code's themes
// (ColorThemeData) do not have, so every token came out in the default colour. Kodium gives them one: a Monarch token
// name is looked up in the VS Code theme's TextMate rules (their scopes match by prefix, as "string" does
// "string.js"), through another scope where VS Code names the same thing differently.
const SCOPE_OF: Record<string, string> = {
  number: 'constant.numeric', regexp: 'string.regexp', 'string.escape': 'constant.character.escape', 'string.invalid': 'invalid',
  type: 'entity.name.type', 'type.identifier': 'entity.name.type', identifier: 'variable', 'variable.predefined': 'variable.language',
  constant: 'constant.language', predefined: 'support.function', annotation: 'entity.name.function.decorator',
  tag: 'entity.name.tag', metatag: 'entity.name.tag', 'attribute.name': 'entity.other.attribute-name', 'attribute.value': 'string',
  'keyword.flow': 'keyword.control', operator: 'keyword.operator', delimiter: 'punctuation', emphasis: 'markup.italic',
  strong: 'markup.bold'
}
// (the layout of a token's metadata: editor/common/encodedTokenAttributes MetadataConsts)
const FONT_STYLE_OFFSET = 11, FOREGROUND_OFFSET = 15, BACKGROUND_OFFSET = 24, TOKEN_TYPE_OFFSET = 8, DEFAULT_FG = 1, DEFAULT_BG = 2

interface ThemeStyle { foreground?: unknown, bold?: boolean, italic?: boolean, underline?: boolean, strikethrough?: boolean }
interface VSCodeTheme {
  resolveScopes(scopes: string[][]): ThemeStyle | undefined
  getTokenColorIndex(): { get(color: unknown): number }
  readonly tokenColorMap: string[]
  __kdTokenTheme?: { match(languageId: number, token: string): number }
}

function makeTokenTheme(theme: VSCodeTheme) {
  // (asked at every token: an object's own property, not the engine's Map stand-in - a function of the shim per get)
  const cache: Record<string, number> = Object.create(null)
  const index = theme.getTokenColorIndex()
  return {
    match(languageId: number, token: string): number {
      let metadata = cache[token]
      if (metadata === undefined) {
        const parts = token.split('.')
        let scope = token
        for (let n = parts.length; n > 0; n--) {
          const alias = SCOPE_OF[parts.slice(0, n).join('.')]
          if (alias) { scope = [alias].concat(parts.slice(n)).join('.'); break }
        }
        const style = theme.resolveScopes([[scope]])
        const fg = (style && style.foreground && index.get(style.foreground)) || DEFAULT_FG
        const fontStyle = style ? (style.italic ? 1 : 0) | (style.bold ? 2 : 0) | (style.underline ? 4 : 0) | (style.strikethrough ? 8 : 0) : 0
        // (comments, strings and regular expressions are told apart for brackets and auto-closing, as monaco does)
        const type = /\bcomment\b/.test(token) ? 1 : /\bstring\b/.test(token) ? 2 : /\bregexp?\b/.test(token) ? 3 : 0
        metadata = ((fg << FOREGROUND_OFFSET) | (fontStyle << FONT_STYLE_OFFSET) | (type << TOKEN_TYPE_OFFSET) | (DEFAULT_BG << BACKGROUND_OFFSET)) >>> 0
        cache[token] = metadata
      }
      return (metadata | languageId) >>> 0
    }
  }
}

// The colours by number that tokens carry, and the editor's .mtk<n> classes for them: VS Code's TextMate service sets
// both when a theme applies, and there is no TextMate service here
let tokenColorStyle: HTMLStyleElement | undefined
function applyTokenColors(theme: VSCodeTheme): void {
  const map = theme.tokenColorMap
  const colors: Color[] = [null as unknown as Color]   // (0 is no colour)
  for (let i = 1; i < map.length; i++) colors[i] = Color.fromHex(map[i])
  if (!tokenColorStyle) {
    tokenColorStyle = document.createElement('style')
    tokenColorStyle.className = 'kodium-token-colors'
    document.head.appendChild(tokenColorStyle)
  }
  tokenColorStyle.textContent = generateTokensCSSForColorMap(colors)
  // (the editors tokenize their files again: a theme numbers its colours its own way)
  TokenizationRegistry.setColorMap(colors)
}

// as monaco's own registerLanguage (standalone-languages' _.contribution.js), with the grammar loaded once
export async function registerLanguages(): Promise<void> {
  const themeService = await getService(IThemeService)
  const proto = Object.getPrototypeOf(themeService.getColorTheme()) as object
  if (!('tokenTheme' in proto)) {
    Object.defineProperty(proto, 'tokenTheme', {
      configurable: true,
      get(this: VSCodeTheme) { return this.__kdTokenTheme || (this.__kdTokenTheme = makeTokenTheme(this)) }
    })
  }
  // (all at once: one by one, each had the languages' registry and the settings' schema made again for all so far -
  // see quickerStart in vite.config.mjs)
  const registry = ModesRegistry as unknown as { kdRegisterLanguages?: (defs: languages.ILanguageExtensionPoint[]) => void }
  const points = DEFINITIONS.map(({ load: _load, ...point }) => point)
  if (registry.kdRegisterLanguages) registry.kdRegisterLanguages(points)
  else points.forEach((point) => languages.register(point))
  for (const def of DEFINITIONS) {
    const { load } = def
    let loading: Promise<Grammar> | undefined
    const grammar = () => (loading ??= load())
    languages.registerTokensProviderFactory(def.id, { create: async () => (await grammar()).language })
    languages.onLanguageEncountered(def.id, async () => { languages.setLanguageConfiguration(def.id, (await grammar()).conf) })
  }
  // the files open already (restored at start) were read before their languages were known: their tokenizers now,
  // then the colours, which has them tokenized again
  await Promise.all(editor.getModels().map((model) => TokenizationRegistry.getOrCreate(model.getLanguageId())))
  applyTokenColors(themeService.getColorTheme() as unknown as VSCodeTheme)
  themeService.onDidColorThemeChange((theme) => applyTokenColors(theme as unknown as VSCodeTheme))
}
