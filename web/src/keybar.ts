// The row of keys above the iPad's on-screen keyboard (src/KDKeyBar.m) gives its keys here: a character is typed as the
// keyboard types it (the editor's type command: brackets close themselves as usual; in a field of the workbench, the
// search or the command palette, as text the field gets); Tab, the arrows, undo and redo are the editor's commands, and
// in a field the arrows move the caret along the text. Suggest shows the editor's suggestions and snippets (Ctrl+Space).
// In the terminal (web/src/terminal.ts) the keys are the terminal's: Tab, Esc and the arrows go to xterm.js as keys of a
// keyboard would, so a program's modes are kept (vim's arrows, less). Ctrl stays down for the next key - of the row or of
// the on-screen keyboard -: in the terminal Ctrl+C and the like, in the editor its shortcuts (save, find, comment...).
import { ICommandService } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service'
import { StandaloneServices } from '@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices'

const COMMANDS: Record<string, string> = {
  tab: 'tab', suggest: 'editor.action.triggerSuggest', left: 'cursorLeft', right: 'cursorRight', up: 'cursorUp', down: 'cursorDown',
  undo: 'undo', redo: 'redo'
}

// keys of a keyboard for the terminal: [key, keyCode]
const TERMINAL_KEYS: Record<string, [string, number]> = {
  tab: ['Tab', 9], esc: ['Escape', 27], left: ['ArrowLeft', 37], up: ['ArrowUp', 38], right: ['ArrowRight', 39], down: ['ArrowDown', 40]
}

// Ctrl + a key in the editor: VS Code's shortcuts of that key (a keyboard's Ctrl does not exist on the iPad's)
const EDITOR_CTRL: Record<string, string> = {
  s: 'workbench.action.files.save', f: 'actions.find', h: 'editor.action.startFindReplaceAction', z: 'undo', y: 'redo',
  a: 'editor.action.selectAll', c: 'editor.action.clipboardCopyAction', x: 'editor.action.clipboardCutAction',
  v: 'editor.action.clipboardPasteAction', '/': 'editor.action.commentLine', d: 'editor.action.addSelectionToNextFindMatch',
  g: 'workbench.action.gotoLine', p: 'workbench.action.quickOpen', ' ': 'editor.action.triggerSuggest',
  w: 'workbench.action.closeActiveEditor', '`': 'workbench.action.terminal.toggleTerminal'
}

function within(element: Element | null, className: string): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.classList && node.classList.contains(className)) return true
  }
  return false
}

const inEditor = (element: Element | null): boolean => within(element, 'monaco-editor')
const inTerminal = (element: Element | null): boolean => within(element, 'xterm')

// a keydown as the keyboard's, for xterm.js (its textarea): it turns it into the terminal's sequence by its modes
function terminalKey(target: Element, key: string, keyCode: number, ctrl: boolean): void {
  const e = document.createEvent('Events') as Event & Record<string, unknown>
  e.initEvent('keydown', true, true)
  const fields: Record<string, unknown> = {
    key, keyCode, which: keyCode, charCode: 0, code: keyCode >= 65 && keyCode <= 90 ? 'Key' + key.toUpperCase() : key,
    ctrlKey: ctrl, shiftKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, location: 0
  }
  for (const name of Object.keys(fields)) {
    try {
      Object.defineProperty(e, name, { value: fields[name], configurable: true })
    } catch {
      e[name] = fields[name]
    }
  }
  target.dispatchEvent(e)
}

// a character with Ctrl in the terminal: as a keydown with its key code (letters and the few others xterm.js knows)
function terminalCtrlChar(target: Element, ch: string): void {
  const lower = ch.toLowerCase()
  const code = lower >= 'a' && lower <= 'z' ? lower.toUpperCase().charCodeAt(0)
    : ({ '[': 219, '\\': 220, ']': 221, ' ': 32, '2': 50, '6': 54, '-': 189, '/': 191 } as Record<string, number>)[lower]
  if (code) terminalKey(target, lower, code, true)
}

let ctrl = false

function releaseCtrl(): void {
  if (!ctrl) return
  ctrl = false
  const xhr = new XMLHttpRequest()
  xhr.open('GET', location.href.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '') + '/__kd/app/ctrl-up', true)
  xhr.send(null)
}

// a character with Ctrl, wherever the focus is
function ctrlChar(ch: string, focused: Element | null): void {
  releaseCtrl()
  if (focused && inTerminal(focused)) terminalCtrlChar(focused, ch)
  else {
    const command = EDITOR_CTRL[ch.toLowerCase()]
    if (command) void StandaloneServices.get(ICommandService).executeCommand(command)
  }
}

export function receiveKeys(): void {
  // (a key of the on-screen keyboard while ctrl is down: it goes with Ctrl instead of being typed)
  document.addEventListener('keypress', (e: KeyboardEvent) => {
    if (!ctrl || !e.charCode) return
    e.preventDefault()
    e.stopPropagation()
    ctrlChar(String.fromCharCode(e.charCode), document.activeElement)
  }, true)

  ;(window as { __kd_key?: (key: string) => string }).__kd_key = (key: string) => {
    const focused = document.activeElement as HTMLInputElement | null
    const commands = StandaloneServices.get(ICommandService)
    if (key === 'ctrl') {
      ctrl = !ctrl
      return 'ok'
    }
    if (focused && inTerminal(focused)) {
      const terminal = TERMINAL_KEYS[key]
      if (terminal) {
        terminalKey(focused, terminal[0], terminal[1], ctrl)
        releaseCtrl()
      } else if (typeof key === 'string' && key.length === 1) {
        if (ctrl) ctrlChar(key, focused)
        else document.execCommand('insertText', false, key)
      }
      return 'ok'
    }
    if (key === 'esc') {
      releaseCtrl()
      for (const command of ['hideSuggestWidget', 'closeParameterHints', 'closeFindWidget', 'leaveSnippet', 'workbench.action.closeQuickOpen']) {
        commands.executeCommand(command).then(undefined, () => undefined)
      }
      return 'ok'
    }
    const command = COMMANDS[key]
    if (!command) {
      if (typeof key !== 'string' || key.length !== 1) return 'ok'
      if (ctrl) ctrlChar(key, focused)
      else if (inEditor(focused)) void commands.executeCommand('type', { text: key })
      else document.execCommand('insertText', false, key)
      return 'ok'
    }
    releaseCtrl()
    if (inEditor(focused) || key === 'undo' || key === 'redo') {
      void commands.executeCommand(command)
    } else if (focused && typeof focused.selectionStart === 'number' && (key === 'left' || key === 'right')) {
      const at = Math.max(0, Math.min(focused.value.length, (focused.selectionStart || 0) + (key === 'left' ? -1 : 1)))
      focused.setSelectionRange(at, at)
    }
    return 'ok'
  }
}
