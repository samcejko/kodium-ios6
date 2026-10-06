// The row of keys above the iPad's on-screen keyboard (src/KDKeyBar.m) gives its keys here: a character is typed as the
// keyboard types it (so brackets close themselves as usual); Tab, the arrows, undo and redo are the editor's commands.
// In a field of the workbench (the search, the command palette) the arrows move the caret along the text.
import { ICommandService } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service'
import { StandaloneServices } from '@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices'

const COMMANDS: Record<string, string> = {
  tab: 'tab', left: 'cursorLeft', right: 'cursorRight', up: 'cursorUp', down: 'cursorDown', undo: 'undo', redo: 'redo'
}

function inEditor(element: Element | null): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.classList && node.classList.contains('monaco-editor')) return true
  }
  return false
}

export function receiveKeys(): void {
  ;(window as { __kd_key?: (key: string) => string }).__kd_key = (key: string) => {
    const focused = document.activeElement as HTMLInputElement | null
    const command = COMMANDS[key]
    if (!command) {
      if (typeof key === 'string' && key.length === 1) document.execCommand('insertText', false, key)
      return 'ok'
    }
    if (inEditor(focused) || key === 'undo' || key === 'redo') {
      void StandaloneServices.get(ICommandService).executeCommand(command)
    } else if (focused && typeof focused.selectionStart === 'number' && (key === 'left' || key === 'right')) {
      const at = Math.max(0, Math.min(focused.value.length, (focused.selectionStart || 0) + (key === 'left' ? -1 : 1)))
      focused.setSelectionRange(at, at)
    }
    return 'ok'
  }
}
