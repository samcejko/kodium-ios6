// When the iPad runs short of memory: iOS closes the frontmost app without a word at about 15-25 MB available, and
// Kodium holds 260-310 MB of the iPad 2's 512 - with every editor it has shown kept made (the Keyboard Shortcuts editor
// 3 MB of the page's heap, an extension's page...) and the language services' workers (settings.json's JSON worker
// with the schema of every setting took 17 MB) - while the other apps and daemons take 10-25 MB more now and then. It
// was closed that way after a few windows (313 MB, 26 MB available). The app asks the workbench (src/KDAppDelegate.m)
// to let go of what it can make again:
// - level 1 (under 40 MB available, at most every 30 s): the editors' panes that are not on the screen, in every group
//   (made again when opened - their first opening's time again), but the text editor every file is shown in and the
//   Settings editor the warm-up made; and the language services' workers that are idle (started again when asked; on
//   their own they stop after 45 s without a request)
// - level 2 (iOS's memory warning, a few seconds before it closes the app): the Settings editor's pane too
// Garbage collection and the compiled code are the engine's relief, which comes with it.
import { getService } from '@codingame/monaco-vscode-api'
import { IEditorGroupsService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService.service'

interface DroppingPanes { kdDropHiddenPanes?(keep: (id: string) => boolean): number }
interface IdleWorkers { _stopWorker(): void, _worker: unknown, _lastUsedTime: number }

const TEXT_EDITORS = ['workbench.editors.files.textFileEditor', 'workbench.editors.textResourceEditor']
const SETTINGS_EDITOR = 'workbench.editor.settings2'

export async function watchMemory(): Promise<void> {
  const groups = await getService(IEditorGroupsService)
  ;(window as { __kd_relieve?: unknown }).__kd_relieve = (level: number) => {
    // (after the app's call has returned: it waits for the page meanwhile)
    setTimeout(() => {
      let panes = 0, workers = 0
      const keep = (id: string) => TEXT_EDITORS.includes(id) || (level < 2 && id === SETTINGS_EDITOR)
      for (const group of groups.groups) {
        try { panes += (group as unknown as { editorPane?: DroppingPanes }).editorPane?.kdDropHiddenPanes?.(keep) ?? 0 } catch { /* the group's own */ }
      }
      const now = Date.now()
      for (const manager of ((self as { __kdWorkerManagers?: IdleWorkers[] }).__kdWorkerManagers || [])) {
        // (one asked for in the last 5 s is in use)
        if (manager._worker && now - manager._lastUsedTime > 5000) { manager._stopWorker(); workers++ }
      }
      console.log('[kodium] memory relief ' + level + ': ' + panes + ' editor panes, ' + workers + ' language workers let go')
    }, 0)
    return 'relieving'
  }
}
