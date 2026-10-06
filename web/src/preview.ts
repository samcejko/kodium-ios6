// Preview: an HTML page as a browser shows it, a Markdown file as it reads, beside the file (Open Preview: the button
// above an HTML or Markdown file, the explorer's menu, Ctrl+Shift+V).
// The page comes from the app as a web site of its own, https://preview.kodium.invalid/<path in Documents>
// (src/KDSiteProtocol.m): another origin than the workbench's, so that its scripts cannot reach into the workbench, and
// through the engine's rewriters as a web page in Surfari (modern scripts lowered, modern CSS rewritten). It is loaded
// again whenever a file is saved (auto save: two seconds after typing). Markdown is rendered here, as it is typed.
import { EditorPane, registerEditorPane } from '@codingame/monaco-vscode-workbench-service-override'
import { EditorInput } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor/editorInput'
import { EditorInputCapabilities, EditorResourceAccessor, type IEditorOpenContext, type IUntypedEditorInput } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor'
import { SIDE_GROUP } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { ITextFileService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/textfile/common/textfiles.service'
import { ITextModelService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/services/resolverService.service'
import { ILanguageService } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages/language.service'
import { IOpenerService } from '@codingame/monaco-vscode-api/vscode/vs/platform/opener/common/opener.service'
import { INotificationService } from '@codingame/monaco-vscode-api/vscode/vs/platform/notification/common/notification.service'
import { StandaloneServices } from '@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices'
import { Action2, MenuId, registerAction2 } from '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
import { ContextKeyExpr } from '@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey'
import { KeybindingWeight } from '@codingame/monaco-vscode-api/vscode/vs/platform/keybinding/common/keybindingsRegistry'
import { KeyCode, KeyMod } from '@codingame/monaco-vscode-api/vscode/vs/base/common/keyCodes'
import { Codicon } from '@codingame/monaco-vscode-api/vscode/vs/base/common/codicons'
import { DisposableStore } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { basename, extname, isEqual } from '@codingame/monaco-vscode-api/vscode/vs/base/common/resources'
import { renderMarkdown } from '@codingame/monaco-vscode-api/vscode/vs/base/browser/markdownRenderer'
import { tokenizeToString } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/languages/textToHtmlTokenizer'
import type { CancellationToken } from '@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation'
import type { Dimension } from '@codingame/monaco-vscode-api/vscode/vs/base/browser/dom'
import type { IEditorGroup } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService'
import type { IEditorOptions } from '@codingame/monaco-vscode-api/vscode/vs/platform/editor/common/editor'
import type { ServicesAccessor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/instantiation'
import { DOCUMENTS } from './files'
import './kodium.css'

const cs = /^cs/i.test((window as { __kd_lang?: string }).__kd_lang || '')
const T = cs
  ? { open: 'Otevřít náhled vedle', reload: 'Načíst náhled znovu', title: 'Náhled: {0}', none: 'Náhled je pro soubory HTML a Markdown.' }
  : { open: 'Open Preview to the Side', reload: 'Reload Preview', title: 'Preview {0}', none: 'There is a preview for HTML and Markdown files.' }
const fill = (s: string, v: string) => s.replace('{0}', v)

// (the app answers the preview's site; a desktop browser trying the workbench gets it from tools/serve.ps1)
const SITE = location.hostname === 'kodium.invalid'
  ? 'https://preview.kodium.invalid'
  : location.href.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '') + '/__kd/preview'

type Kind = 'html' | 'markdown'
function kindOf(resource: URI | undefined): Kind | null {
  if (!resource || resource.scheme !== 'file' || !resource.path.startsWith(DOCUMENTS + '/')) return null
  const ext = extname(resource).toLowerCase()
  if (ext === '.html' || ext === '.htm' || ext === '.xhtml') return 'html'
  if (ext === '.md' || ext === '.markdown' || ext === '.mdown' || ext === '.mkd') return 'markdown'
  return null
}

// file:///Documents/a b/c.html -> <site>/a%20b/c.html
function siteUrl(resource: URI): string {
  return SITE + resource.path.slice(DOCUMENTS.length).split('/').map(encodeURIComponent).join('/')
}

// <site>/a%20b/c.md -> file:///Documents/a b/c.md (a link between the files of the preview)
function documentOf(link: string): URI | null {
  if (link.slice(0, SITE.length + 1) !== SITE + '/') return null
  const path = link.slice(SITE.length).replace(/[?#].*$/, '')
  try {
    return URI.file(DOCUMENTS + path.split('/').map(decodeURIComponent).join('/'))
  } catch {
    return null
  }
}

class PreviewInput extends EditorInput {
  static readonly ID = 'kodium.preview.input'

  constructor(private readonly file: URI) {
    super()
  }

  override get resource(): URI {
    return this.file
  }

  override get typeId(): string {
    return PreviewInput.ID
  }

  override get editorId(): string {
    return PreviewPane.ID
  }

  override get capabilities(): EditorInputCapabilities {
    return EditorInputCapabilities.Readonly
  }

  override getName(): string {
    return fill(T.title, basename(this.resource))
  }

  override getIcon() {
    return Codicon.openPreview
  }

  override matches(other: EditorInput | IUntypedEditorInput): boolean {
    return this === other || (other instanceof PreviewInput && isEqual(other.resource, this.resource))
  }
}

class PreviewPane extends EditorPane {
  static readonly ID = 'kodium.preview'
  private root!: HTMLElement
  private frame: HTMLIFrameElement | null = null
  private readonly shown = this._register(new DisposableStore())

  constructor(group: IEditorGroup) {
    super(PreviewPane.ID, group)
  }

  protected createEditor(parent: HTMLElement): void {
    this.root = document.createElement('div')
    this.root.className = 'kodium-preview'
    parent.appendChild(this.root)
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
    await super.setInput(input, options, context, token)
    if (token.isCancellationRequested || !(input instanceof PreviewInput)) return
    this.shown.clear()
    this.root.textContent = ''
    this.frame = null
    const page = kindOf(input.resource) === 'html'
    if (page) this.root.classList.add('kodium-page')
    else this.root.classList.remove('kodium-page')
    if (page) this.showPage(input.resource)
    else await this.showMarkdown(input.resource, token)
  }

  override clearInput(): void {
    this.shown.clear()
    if (this.root) this.root.textContent = ''
    this.frame = null
    super.clearInput()
  }

  layout(dimension: Dimension): void {
    this.root.style.width = dimension.width + 'px'
    this.root.style.height = dimension.height + 'px'
  }

  override focus(): void {
    super.focus()
    this.root.focus()
  }

  reload(): void {
    // (the same address again: a frame loads it anew)
    if (this.frame) this.frame.src = this.frame.src
  }

  private showPage(resource: URI): void {
    const frame = document.createElement('iframe')
    frame.className = 'kodium-preview-frame'
    frame.src = siteUrl(resource)
    this.root.appendChild(frame)
    this.frame = frame
    let timer = 0
    this.shown.add(StandaloneServices.get(ITextFileService).files.onDidSave(() => {
      clearTimeout(timer)
      timer = window.setTimeout(() => this.reload(), 300)
    }))
    this.shown.add({ dispose: () => clearTimeout(timer) })
  }

  private async showMarkdown(resource: URI, token: CancellationToken): Promise<void> {
    const reference = await StandaloneServices.get(ITextModelService).createModelReference(resource)
    if (token.isCancellationRequested) {
      reference.dispose()
      return
    }
    this.shown.add(reference)
    const model = reference.object.textEditorModel
    const element = document.createElement('div')
    element.className = 'kodium-markdown'
    this.root.appendChild(element)
    const languages = StandaloneServices.get(ILanguageService)
    // (the folder of the file: the base of its relative pictures and links)
    const base = URI.parse(siteUrl(resource).replace(/[^/]*$/, ''))
    let rendered: { dispose(): void } | undefined
    const render = () => {
      rendered?.dispose()
      rendered = renderMarkdown({ value: model.getValue(), supportHtml: true, baseUri: base }, {
        actionHandler: (link) => this.follow(link),
        // (code in the colours of the editor's grammars)
        codeBlockRenderer: async (language, value) => {
          const div = document.createElement('div')
          div.innerHTML = await tokenizeToString(languages, value, languages.getLanguageIdByLanguageName(language) ?? languages.getLanguageIdByMimeType(language) ?? null)
          return div
        }
      }, element)
    }
    render()
    let timer = 0
    this.shown.add(model.onDidChangeContent(() => {
      clearTimeout(timer)
      timer = window.setTimeout(render, 400)
    }))
    this.shown.add({ dispose: () => { clearTimeout(timer); rendered?.dispose() } })
  }

  // a link of the Markdown: another file of the Documents opens in Kodium (its preview when it has one), the web outside
  private follow(link: string): void {
    const target = documentOf(link)
    if (target) {
      const editors = StandaloneServices.get(IEditorService)
      if (kindOf(target) === 'markdown') void editors.openEditor(new PreviewInput(target), { pinned: true }, this.group)
      else void editors.openEditor({ resource: target, options: { pinned: true } }, this.group)
      return
    }
    if (/^(https?|mailto):/i.test(link)) void StandaloneServices.get(IOpenerService).open(link)
  }
}

registerEditorPane(PreviewPane.ID, 'Preview', PreviewPane, [PreviewInput])

const CAN_PREVIEW = ContextKeyExpr.or(
  ContextKeyExpr.equals('resourceLangId', 'html'),
  ContextKeyExpr.equals('resourceLangId', 'markdown')
)
const PREVIEW_ACTIVE = ContextKeyExpr.equals('activeEditor', PreviewPane.ID)

registerAction2(class OpenPreviewAction extends Action2 {
  constructor() {
    super({
      id: 'kodium.preview.open',
      title: { value: T.open, original: 'Open Preview to the Side' },
      category: { value: 'Kodium', original: 'Kodium' },
      icon: Codicon.openPreview,
      f1: true,
      menu: [
        { id: MenuId.EditorTitle, group: 'navigation', when: CAN_PREVIEW },
        { id: MenuId.ExplorerContext, group: 'navigation', order: 20, when: CAN_PREVIEW }
      ],
      keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV, when: CAN_PREVIEW, weight: KeybindingWeight.WorkbenchContrib }
    })
  }

  run(accessor: ServicesAccessor, resource?: unknown): Promise<unknown> | void {
    const editors = accessor.get(IEditorService)
    const target = URI.isUri(resource) ? resource : EditorResourceAccessor.getOriginalUri(editors.activeEditor) ?? undefined
    if (!kindOf(target)) {
      accessor.get(INotificationService).info(T.none)
      return
    }
    return editors.openEditor(new PreviewInput(target as URI), { pinned: true, preserveFocus: true }, SIDE_GROUP)
  }
})

registerAction2(class ReloadPreviewAction extends Action2 {
  constructor() {
    super({
      id: 'kodium.preview.reload',
      title: { value: T.reload, original: 'Reload Preview' },
      category: { value: 'Kodium', original: 'Kodium' },
      icon: Codicon.refresh,
      f1: true,
      precondition: PREVIEW_ACTIVE,
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: PREVIEW_ACTIVE }]
    })
  }

  run(accessor: ServicesAccessor): void {
    const pane = accessor.get(IEditorService).activeEditorPane
    if (pane instanceof PreviewPane) pane.reload()
  }
})
