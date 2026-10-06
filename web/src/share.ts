// Files in and out of the iPad. "Open in Kodium" from another app (Mail, Safari, Dropbox...): the app puts the file into
// Documents and asks the workbench to open it (src/KDAppDelegate.m, KDWorkbenchViewController.m openReceivedFile). And
// Share... (the explorer's menu, a tab's menu, the command palette): the system's menu for a file - Open In..., Mail,
// Print, Copy - through https://kodium.invalid/__kd/app/share (src/KDSiteProtocol.m).
import { Action2, MenuId, registerAction2 } from '@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions'
import { ContextKeyExpr } from '@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { INotificationService } from '@codingame/monaco-vscode-api/vscode/vs/platform/notification/common/notification.service'
import { StandaloneServices } from '@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices'
import { EditorResourceAccessor } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import type { ServicesAccessor } from '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/instantiation'
import { DOCUMENTS } from './files'

const cs = /^cs/i.test((window as { __kd_lang?: string }).__kd_lang || '')
const T = cs
  ? { share: 'Sdílet…', received: 'Soubor {0} přišel z jiné aplikace a je v Dokumentech.', ipadOnly: 'Sdílet lze na iPadu.' }
  : { share: 'Share…', received: '{0} came from another app and is in the Documents.', ipadOnly: 'Sharing works on the iPad.' }
const fill = (s: string, v: string) => s.replace('{0}', v)

const ON_DEVICE = location.hostname === 'kodium.invalid'
const API = location.href.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '') + '/__kd/app/'

// the app's call when a file came (the answer "ok": taken; anything else, the app asks again a second later)
export function receiveFiles(): void {
  ;(window as { __kd_receive?: (path: string) => string }).__kd_receive = (path: string) => {
    if (typeof path !== 'string' || path.charAt(0) !== '/') return 'ok'
    void StandaloneServices.get(IEditorService).openEditor({ resource: URI.file(DOCUMENTS + path), options: { pinned: true } })
    StandaloneServices.get(INotificationService).info(fill(T.received, path.slice(1)))
    return 'ok'
  }
}

registerAction2(class ShareAction extends Action2 {
  constructor() {
    super({
      id: 'kodium.share',
      title: { value: T.share, original: 'Share...' },
      category: { value: 'Kodium', original: 'Kodium' },
      f1: true,
      menu: [
        { id: MenuId.ExplorerContext, group: '6_copypath', order: 30, when: ContextKeyExpr.not('explorerResourceIsFolder') },
        { id: MenuId.EditorTitleContext, group: '1_copy', order: 30 }
      ]
    })
  }

  run(accessor: ServicesAccessor, resource?: unknown): void {
    const target = URI.isUri(resource) ? resource : EditorResourceAccessor.getOriginalUri(accessor.get(IEditorService).activeEditor)
    if (!target || target.scheme !== 'file' || target.path.indexOf(DOCUMENTS + '/') !== 0) return
    if (!ON_DEVICE) {
      accessor.get(INotificationService).info(T.ipadOnly)
      return
    }
    // (the menu points at what was tapped: the explorer's row or the tab, focused by the tap)
    let query = 'path=' + encodeURIComponent(target.path.slice(DOCUMENTS.length))
    const focused = document.activeElement as HTMLElement | null
    if (focused && focused !== document.body && typeof focused.getBoundingClientRect === 'function') {
      const r = focused.getBoundingClientRect()
      query += '&x=' + Math.round(r.left) + '&y=' + Math.round(r.top) + '&w=' + Math.round(r.width) + '&h=' + Math.round(r.height)
    }
    const xhr = new XMLHttpRequest()
    xhr.open('GET', API + 'share?' + query, true)
    xhr.send(null)
  }
})
