// The explorer reads its folders again when it shows only when something changed while it was hidden (Kodium's patch of
// VS Code's explorer view, vite.config.mjs quickerViews): what changes outside the workbench is told here - a file from
// another app ("Open in Kodium"), and whatever iTunes File Sharing put into Documents while the app was in the
// background. (VS Code's refresh: the folders read again now if the explorer shows, else when it shows next.)
import { ICommandService } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service'
import { StandaloneServices } from '@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices'

export function filesChangedOutside(): void {
  void StandaloneServices.get(ICommandService).executeCommand('workbench.files.action.refreshFilesExplorer')
}

// The page's timers stop while the app is in the background: two ticks of a 2 s timer more than 6 s apart are a
// return to the foreground.
export function watchForeground(): void {
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    if (now - last > 6000) filesChangedOutside()
    last = now
  }, 2000)
}
