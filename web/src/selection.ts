// Text selection in the editor as iOS has it, for the finger. A long press puts the caret where the finger is and
// shows a loupe above it that follows the finger; a double tap selects a word (Monaco's own); a selection made by
// the finger gets iOS's two handles, which drag its ends (the loupe above the finger again), and the callout of its
// edits: Cut, Copy, Paste - Select, Select All and Paste for the caret, which a tap on the caret shows too - and
// More..., the editor's context menu (which a long press opened before). Copy and Paste are the system's pasteboard
// (web/prelude/vsc-prelude.js, the app's /__kd/app/copy and /paste; vite.config.mjs iosClipboard). VS Code's Gesture
// still makes the taps and the scrolling: a touch it saw begin, it sees end - its tap or context menu swallowed when
// the touch was ours.
import { StandaloneServices } from '@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices'
import { ICodeEditorService } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/services/codeEditorService.service'
import { ICommandService } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service'
import { MouseTargetType, type ICodeEditor } from '@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorBrowser'
import { EditorOption } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/config/editorOptions'
import { Selection } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/core/selection'
import type { Position } from '@codingame/monaco-vscode-api/vscode/vs/editor/common/core/position'
import type { IDisposable } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle'

const cs = /^cs/i.test((window as { __kd_lang?: string }).__kd_lang || '')
const T: Record<Action, string> = cs
  ? { cut: 'Vyjmout', copy: 'Kopírovat', paste: 'Vložit', select: 'Vybrat', selectAll: 'Vybrat vše', more: 'Další…' }
  : { cut: 'Cut', copy: 'Copy', paste: 'Paste', select: 'Select', selectAll: 'Select All', more: 'More…' }

type Action = 'cut' | 'copy' | 'paste' | 'select' | 'selectAll' | 'more'

const LONG_PRESS = 450 // ms
const SLOP = 10 // px a finger may move and still press
const LOUPE_R = 58 // the loupe's radius
const LOUPE_SCALE = 1.3
const LOUPE_GAP = 22 // between the loupe and the finger
const EDGE = 28 // a dragging finger this near the editor's top or bottom scrolls it

type Mode = 'none' | 'pending' | 'loupe' | 'handle'

let mode: Mode = 'none'
let editor: ICodeEditor | null = null // the touch's, or the one with the handles
let touchId = -1
let startX = 0
let startY = 0
let lastX = 0
let lastY = 0
let pressTimer = 0
let tapTimer = 0
let caretBefore: Position | null = null
// (a tap on the selection shows or hides its callout and keeps the selection, as on iOS)
let tapInSelection = false
let calloutWasShown = false
let lastTapEnd = 0
let swallowGesture = false
// (a handle's drag: the selection's other end, and where on the handle the finger is)
let anchor: Position | null = null
let offsetX = 0
let offsetY = 0
// (a handle held without moving is a tap on the selection: its box is the finger's, over the selection's ends)
let handleMoved = false
let scrollTimer = 0
// (the selection was made by the finger: it has handles)
let touchSelected = false
let listeners: IDisposable[] = []

let startHandle: HTMLElement | null = null
let endHandle: HTMLElement | null = null
let callout: HTMLElement | null = null
// (the loupe is the page's, above everything - above the editor's tabs too, for its first lines -, in a box with the
// editor's classes: the colours of the copied lines are the theme's rules for .monaco-editor)
let loupeHost: HTMLElement | null = null
let loupe: HTMLElement | null = null
let loupeContent: HTMLElement | null = null
let loupeLines: HTMLElement | null = null
let loupeOverlays: HTMLElement | null = null
let loupeCaret: HTMLElement | null = null
let loupeFrame = 0

function setTransform(element: HTMLElement, value: string): void {
  const style = element.style as CSSStyleDeclaration & { webkitTransform?: string }
  style.webkitTransform = value
  style.transform = value
}

function editorAt(target: EventTarget | null): ICodeEditor | null {
  if (!(target instanceof Node)) return null
  const editors = StandaloneServices.get(ICodeEditorService).listCodeEditors()
  for (let i = 0; i < editors.length; i++) {
    const node = editors[i].getDomNode()
    if (node && node.contains(target)) return editors[i]
  }
  return null
}

function textPosition(target: ICodeEditor, x: number, y: number): Position | null {
  const hit = target.getTargetAtClientPoint(x, y)
  if (!hit || (hit.type !== MouseTargetType.CONTENT_TEXT && hit.type !== MouseTargetType.CONTENT_EMPTY)) return null
  return hit.position
}

function touchOf(list: TouchList): Touch | null {
  for (let i = 0; i < list.length; i++) if (list[i].identifier === touchId) return list[i]
  return null
}

// ---- the editor the touch UI is on: its handles follow its selection and its scrolling

function useEditor(target: ICodeEditor): void {
  if (editor === target && listeners.length) return
  for (const listener of listeners) listener.dispose()
  editor = target
  touchSelected = false
  listeners = [
    target.onDidChangeCursorSelection((e) => {
      if (mode === 'handle') return
      if (e.selection.isEmpty() || e.source === 'keyboard') touchSelected = false
      placeHandles()
      if (!touchSelected) hideCallout()
    }),
    target.onDidScrollChange(() => {
      placeHandles()
      hideCallout()
    }),
    target.onDidLayoutChange(() => placeHandles()),
    target.onDidChangeModel(() => {
      touchSelected = false
      placeHandles()
      hideCallout()
    }),
    target.onDidChangeModelContent(() => hideCallout()),
    target.onDidBlurEditorWidget(() => {
      if (mode !== 'none') return
      touchSelected = false
      placeHandles()
      hideCallout()
    }),
    target.onDidDispose(() => {
      for (const listener of listeners) listener.dispose()
      listeners = []
      if (editor === target) editor = null
      touchSelected = false
    })
  ]
}

// ---- handles

function makeHandle(start: boolean): HTMLElement {
  const handle = document.createElement('div')
  handle.className = 'kd-handle ' + (start ? 'kd-handle-start' : 'kd-handle-end')
  const knob = document.createElement('div')
  knob.className = 'kd-handle-knob'
  const bar = document.createElement('div')
  bar.className = 'kd-handle-bar'
  handle.appendChild(knob)
  handle.appendChild(bar)
  return handle
}

function placeHandle(target: ICodeEditor, handle: HTMLElement, position: Position, start: boolean): void {
  const at = target.getScrolledVisiblePosition(position)
  const layout = target.getLayoutInfo()
  const dom = target.getDomNode()
  if (!at || !dom || at.top + at.height < 0 || at.top > layout.height || at.left < layout.contentLeft - 1 || at.left > layout.width) {
    handle.style.display = 'none'
    return
  }
  if (handle.parentNode !== dom) dom.appendChild(handle)
  // (the element is the finger's: 44 px wide, the knob's 14 px past the line, 10 px more of reach)
  handle.style.display = 'block'
  handle.style.left = Math.round(at.left - 22) + 'px'
  handle.style.top = Math.round(start ? at.top - 24 : at.top) + 'px'
  handle.style.height = (at.height + 24) + 'px'
  const bar = handle.lastChild as HTMLElement
  bar.style.top = (start ? 24 : 0) + 'px'
  bar.style.height = at.height + 'px'
  const knob = handle.firstChild as HTMLElement
  knob.style.top = (start ? 12 : at.height) + 'px'
}

function placeHandles(): void {
  const target = editor
  const selection = target && target.getSelection()
  if (!target || !selection || selection.isEmpty() || !touchSelected) {
    if (startHandle) startHandle.style.display = 'none'
    if (endHandle) endHandle.style.display = 'none'
    return
  }
  if (!startHandle) startHandle = makeHandle(true)
  if (!endHandle) endHandle = makeHandle(false)
  placeHandle(target, startHandle, selection.getStartPosition(), true)
  placeHandle(target, endHandle, selection.getEndPosition(), false)
}

function handleOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Node)) return null
  if (startHandle && startHandle.style.display !== 'none' && startHandle.contains(target)) return startHandle
  if (endHandle && endHandle.style.display !== 'none' && endHandle.contains(target)) return endHandle
  return null
}

// ---- the loupe: the lines under the finger, drawn again bigger (copies of the editor's line elements)

function showLoupe(target: ICodeEditor, x: number, y: number, caret: Position | null): void {
  const dom = target.getDomNode()
  if (!dom) return
  if (!loupeHost) {
    loupeHost = document.createElement('div')
    document.body.appendChild(loupeHost)
  }
  if (!loupe) {
    loupe = document.createElement('div')
    loupe.className = 'kd-loupe'
    loupeContent = document.createElement('div')
    loupeContent.className = 'kd-loupe-content'
    loupeOverlays = document.createElement('div')
    loupeOverlays.className = 'view-overlays'
    loupeLines = document.createElement('div')
    loupeLines.className = 'view-lines'
    loupeCaret = document.createElement('div')
    loupeCaret.className = 'kd-loupe-caret'
    loupeContent.appendChild(loupeOverlays)
    loupeContent.appendChild(loupeLines)
    loupeContent.appendChild(loupeCaret)
    loupe.appendChild(loupeContent)
    const glass = document.createElement('div')
    glass.className = 'kd-loupe-glass'
    loupe.appendChild(glass)
  }
  if (loupe.parentNode !== loupeHost || loupe.style.display === 'none') {
    loupeHost.className = 'kd-loupe-host ' + dom.className.replace(/\bfocused\b/, '')
    loupeHost.appendChild(loupe)
    // (the editor's font and background: the copied lines take them from here)
    const lines = dom.querySelector('.view-lines') as HTMLElement | null
    const background = dom.querySelector('.monaco-editor-background') as HTMLElement | null
    if (lines && loupeLines) {
      const style = getComputedStyle(lines)
      loupeLines.style.fontFamily = style.fontFamily
      loupeLines.style.fontSize = style.fontSize
      loupeLines.style.fontWeight = style.fontWeight
      loupeLines.style.lineHeight = style.lineHeight
      loupeLines.style.letterSpacing = style.letterSpacing
    }
    loupe.style.backgroundColor = background ? getComputedStyle(background).backgroundColor : ''
  }
  loupe.style.display = 'block'
  const rect = dom.getBoundingClientRect()
  const fx = x - rect.left
  const fy = y - rect.top
  const at = caret ? target.getScrolledVisiblePosition(caret) : null
  // (the loupe shows the finger's place: the line of the caret, around the finger)
  const cx = fx
  const cy = at ? at.top + at.height / 2 : fy
  // (in the page: above the finger, within the window)
  loupe.style.left = Math.round(Math.max(0, Math.min(window.innerWidth - 2 * LOUPE_R - 2, x - LOUPE_R))) + 'px'
  loupe.style.top = Math.round(Math.max(0, y - LOUPE_GAP - 2 * LOUPE_R)) + 'px'
  if (loupeContent) setTransform(loupeContent, 'translate(' + Math.round(LOUPE_R - cx * LOUPE_SCALE) + 'px,' + Math.round(LOUPE_R - cy * LOUPE_SCALE) + 'px) scale(' + LOUPE_SCALE + ')')
  if (loupeCaret) {
    if (at && (mode === 'loupe')) {
      loupeCaret.style.display = 'block'
      loupeCaret.style.left = at.left + 'px'
      loupeCaret.style.top = at.top + 'px'
      loupeCaret.style.height = at.height + 'px'
    } else loupeCaret.style.display = 'none'
  }
  // (the copies once the editor has drawn the new caret or selection: after its animation frame)
  if (!loupeFrame) {
    loupeFrame = requestAnimationFrame(() => {
      setTimeout(() => {
        loupeFrame = 0
        copyLines(target, cy)
      }, 0)
    })
  }
}

// the editor's lines and their overlays (the selection, the current line) near the loupe's middle, copied into it at
// their places in the editor
function copyLines(target: ICodeEditor, cy: number): void {
  const dom = target.getDomNode()
  if (!dom || !loupe || loupe.style.display === 'none' || !loupeLines || !loupeOverlays) return
  const rect = dom.getBoundingClientRect()
  const reach = LOUPE_R / LOUPE_SCALE + 20
  const copy = (selector: string, into: HTMLElement) => {
    while (into.firstChild) into.removeChild(into.firstChild)
    const rows = dom.querySelectorAll(selector)
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as HTMLElement
      if (loupe && loupe.contains(row)) continue
      const r = row.getBoundingClientRect()
      const top = r.top - rect.top
      if (top + r.height < cy - reach || top > cy + reach) continue
      const clone = row.cloneNode(true) as HTMLElement
      clone.style.position = 'absolute'
      clone.style.top = top + 'px'
      clone.style.left = (r.left - rect.left) + 'px'
      clone.style.width = r.width + 'px'
      clone.style.height = r.height + 'px'
      into.appendChild(clone)
    }
  }
  copy('.view-overlays > div', loupeOverlays)
  copy('.view-lines > .view-line', loupeLines)
}

function hideLoupe(): void {
  if (loupe) loupe.style.display = 'none'
}

// ---- the callout

function hideCallout(): void {
  if (callout && callout.parentNode) callout.parentNode.removeChild(callout)
  callout = null
}

function showCallout(target: ICodeEditor): void {
  hideCallout()
  const dom = target.getDomNode()
  const model = target.getModel()
  const selection = target.getSelection()
  if (!dom || !model || !selection) return
  const writable = !target.getOption(EditorOption.readOnly)
  const actions: Action[] = selection.isEmpty()
    ? (writable ? ['select', 'selectAll', 'paste', 'more'] : ['select', 'selectAll', 'more'])
    : (writable ? ['cut', 'copy', 'paste', 'more'] : ['copy', 'more'])
  // what it points at: the selection's top (its first visible line) or the caret
  const layout = target.getLayoutInfo()
  const first = target.getScrolledVisiblePosition(selection.getStartPosition())
  const last = target.getScrolledVisiblePosition(selection.getEndPosition())
  if (!first || !last) return
  let top = first.top
  let bottom = last.top + last.height
  let x = selection.isEmpty() || first.top === last.top ? (first.left + last.left) / 2 : layout.contentLeft + (layout.width - layout.contentLeft) / 2
  if (bottom < 0 || top > layout.height) {
    // (a selection out of sight - Select All -: the middle of the editor)
    top = bottom = layout.height / 3
    x = layout.contentLeft + (layout.width - layout.contentLeft) / 2
  }
  top = Math.max(0, top)
  bottom = Math.min(layout.height, bottom)
  const element = document.createElement('div')
  element.className = 'kd-callout'
  for (const action of actions) {
    const item = document.createElement('div')
    item.className = 'kd-callout-item'
    item.textContent = T[action]
    item.setAttribute('data-action', action)
    element.appendChild(item)
  }
  const arrow = document.createElement('div')
  arrow.className = 'kd-callout-arrow'
  element.appendChild(arrow)
  element.style.visibility = 'hidden'
  dom.appendChild(element)
  callout = element
  const width = element.offsetWidth
  const height = element.offsetHeight
  const below = top - height - 12 < 0
  if (below) element.className += ' kd-below'
  const left = Math.max(4, Math.min(layout.width - width - 4, x - width / 2))
  element.style.left = Math.round(left) + 'px'
  element.style.top = Math.round(below ? bottom + 12 : top - height - 12) + 'px'
  arrow.style.left = Math.round(Math.max(10, Math.min(width - 28, x - left - 9))) + 'px'
  element.style.visibility = 'visible'
  let down: HTMLElement | null = null
  const itemOf = (node: EventTarget | null): HTMLElement | null => {
    for (let n = node as HTMLElement | null; n && n !== element; n = n.parentElement) if (n.getAttribute && n.getAttribute('data-action')) return n
    return null
  }
  element.addEventListener('touchstart', (e) => {
    e.preventDefault()
    e.stopPropagation()
    down = itemOf(e.target)
    if (down) down.className += ' kd-down'
  }, false)
  element.addEventListener('touchend', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (down) run(target, down.getAttribute('data-action') as Action)
  }, false)
  // (a mouse, in a desktop browser)
  element.addEventListener('mousedown', (e) => { e.preventDefault() }, false)
  element.addEventListener('click', (e) => {
    const item = itemOf(e.target)
    if (item) run(target, item.getAttribute('data-action') as Action)
  }, false)
}

function run(target: ICodeEditor, action: Action): void {
  hideCallout()
  const model = target.getModel()
  if (!model) return
  target.focus()
  const commands = StandaloneServices.get(ICommandService)
  if (action === 'cut') void commands.executeCommand('editor.action.clipboardCutAction')
  else if (action === 'copy') void commands.executeCommand('editor.action.clipboardCopyAction')
  else if (action === 'paste') void commands.executeCommand('editor.action.clipboardPasteAction')
  else if (action === 'more') void commands.executeCommand('editor.action.showContextMenu')
  else if (action === 'selectAll') {
    useEditor(target)
    target.setSelection(model.getFullModelRange())
    touchSelected = true
    placeHandles()
    showCallout(target)
  } else if (action === 'select') {
    const position = target.getPosition()
    if (!position) return
    // the word at the caret, else the one before it on the line
    let word = model.getWordAtPosition(position)
    if (!word) {
      const line = model.getLineContent(position.lineNumber)
      for (let column = Math.min(position.column - 1, line.length); column >= 1 && !word; column--) {
        word = model.getWordAtPosition({ lineNumber: position.lineNumber, column })
      }
    }
    if (!word) return
    useEditor(target)
    target.setSelection(new Selection(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn))
    touchSelected = true
    placeHandles()
    showCallout(target)
  }
}

// ---- the touches

function cancelPress(): void {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = 0
  if (mode === 'pending') mode = 'none'
}

function beginLoupe(): void {
  pressTimer = 0
  const target = editor
  if (mode !== 'pending' || !target) return
  mode = 'loupe'
  hideCallout()
  touchSelected = false
  placeHandles()
  moveCaret(lastX, lastY)
}

function moveCaret(x: number, y: number): void {
  const target = editor
  if (!target) return
  const position = textPosition(target, x, y) || target.getTargetAtClientPoint(x, y)?.position || null
  if (position) {
    const current = target.getSelection()
    if (!current || !current.isEmpty() || !current.getPosition().equals(position)) target.setPosition(position)
  }
  showLoupe(target, x, y, target.getPosition())
  edgeScroll(y)
}

function beginHandle(handle: HTMLElement, touch: Touch): void {
  const target = editor
  const selection = target && target.getSelection()
  if (!target || !selection || selection.isEmpty()) return
  const start = handle === startHandle
  anchor = start ? selection.getEndPosition() : selection.getStartPosition()
  const moving = start ? selection.getStartPosition() : selection.getEndPosition()
  const at = target.getScrolledVisiblePosition(moving)
  const dom = target.getDomNode()
  if (!at || !dom) return
  const rect = dom.getBoundingClientRect()
  // (the finger is on the knob: the line it drags is the one beside the knob)
  offsetX = touch.clientX - (rect.left + at.left)
  offsetY = touch.clientY - (rect.top + at.top + at.height / 2)
  mode = 'handle'
  handleMoved = false
  touchId = touch.identifier
  startX = lastX = touch.clientX
  startY = lastY = touch.clientY
  hideCallout()
}

function moveHandle(x: number, y: number): void {
  const target = editor
  if (!target || !anchor) return
  const px = x - offsetX
  const py = y - offsetY
  const position = target.getTargetAtClientPoint(px, py)?.position
  if (position && !position.equals(anchor)) {
    target.setSelection(Selection.fromPositions(anchor, position))
    placeHandles()
  }
  showLoupe(target, px, py, null)
  edgeScroll(py)
}

// a dragging finger at the editor's top or bottom scrolls it, a line at a time, while it stays there
function edgeScroll(y: number): void {
  const target = editor
  const dom = target && target.getDomNode()
  if (!target || !dom) return
  const rect = dom.getBoundingClientRect()
  const direction = y < rect.top + EDGE ? -1 : y > rect.top + target.getLayoutInfo().height - EDGE ? 1 : 0
  if (!direction) {
    if (scrollTimer) clearInterval(scrollTimer)
    scrollTimer = 0
    return
  }
  if (scrollTimer) return
  scrollTimer = setInterval(() => {
    if (mode !== 'loupe' && mode !== 'handle') {
      clearInterval(scrollTimer)
      scrollTimer = 0
      return
    }
    target.setScrollTop(target.getScrollTop() + direction * target.getOption(EditorOption.lineHeight))
    if (mode === 'loupe') moveCaret(lastX, lastY)
    else moveHandle(lastX, lastY)
  }, 90) as unknown as number
}

function finishDrag(): void {
  const target = editor
  const was = mode
  mode = 'none'
  anchor = null
  if (scrollTimer) clearInterval(scrollTimer)
  scrollTimer = 0
  hideLoupe()
  if (!target) return
  target.focus()
  if (was === 'handle' && !handleMoved) {
    // (a tap on a handle: as on the selection, its callout comes or goes)
    if (!calloutWasShown) showCallout(target)
    return
  }
  const selection = target.getSelection()
  if (was === 'handle' && selection && !selection.isEmpty()) touchSelected = true
  placeHandles()
  showCallout(target)
}

// after a tap that VS Code's Gesture made: a word it selected (a double tap) gets handles and the callout; a tap on the
// caret, once no second tap followed, the callout
function afterTap(target: ICodeEditor): void {
  const before = caretBefore
  setTimeout(() => {
    const selection = target.getSelection()
    if (selection && !selection.isEmpty() && target.hasTextFocus()) {
      useEditor(target)
      touchSelected = true
      placeHandles()
      showCallout(target)
      return
    }
    if (!before || !selection || !selection.getPosition().equals(before)) return
    tapTimer = setTimeout(() => {
      tapTimer = 0
      const now = target.getSelection()
      if (now && now.isEmpty() && now.getPosition().equals(before) && target.hasTextFocus()) showCallout(target)
    }, 320) as unknown as number
  }, 0)
}

export function touchSelection(): void {
  ;(window as { __kd_selDebug?: unknown }).__kd_selDebug = () => ({ mode, touchSelected, tapInSelection, calloutWasShown, lastTapEnd: Date.now() - lastTapEnd, callout: !!callout, editor: !!editor })
  const swallow = (e: Event) => {
    if (!swallowGesture) return
    e.stopPropagation()
    e.preventDefault()
  }
  window.addEventListener('-monaco-gesturetap', swallow, true)
  window.addEventListener('-monaco-gesturecontextmenu', swallow, true)

  window.addEventListener('touchstart', (e: TouchEvent) => {
    if (tapTimer) clearTimeout(tapTimer)
    tapTimer = 0
    if (e.touches.length !== 1) {
      cancelPress()
      if (mode === 'loupe' || mode === 'handle') finishDrag()
      return
    }
    const touch = e.touches[0]
    if (callout && callout.contains(touch.target as Node)) return
    calloutWasShown = !!callout
    hideCallout()
    const handle = handleOf(touch.target)
    if (handle) {
      // (VS Code's Gesture never hears of this touch)
      e.preventDefault()
      e.stopPropagation()
      beginHandle(handle, touch)
      return
    }
    const target = editorAt(touch.target)
    const at = target && target.hasModel() ? textPosition(target, touch.clientX, touch.clientY) : null
    if (!target || !at) return
    useEditor(target)
    mode = 'pending'
    touchId = touch.identifier
    startX = lastX = touch.clientX
    startY = lastY = touch.clientY
    const selection = target.getSelection()
    tapInSelection = touchSelected && !!selection && !selection.isEmpty() && selection.containsPosition(at) && Date.now() - lastTapEnd > 400
    caretBefore = selection && selection.isEmpty() && target.hasTextFocus() ? selection.getPosition() : null
    pressTimer = setTimeout(beginLoupe, LONG_PRESS) as unknown as number
  }, true)

  window.addEventListener('touchmove', (e: TouchEvent) => {
    if (mode === 'none') return
    const touch = touchOf(e.changedTouches)
    if (!touch) return
    lastX = touch.clientX
    lastY = touch.clientY
    if (mode === 'pending') {
      if (Math.abs(lastX - startX) > SLOP || Math.abs(lastY - startY) > SLOP) cancelPress()
      return
    }
    // (the loupe's or the handle's: no scrolling - VS Code's Gesture keeps the touch where it began)
    e.preventDefault()
    e.stopPropagation()
    if (mode === 'loupe') moveCaret(lastX, lastY)
    else if (handleMoved || Math.abs(lastX - startX) > SLOP || Math.abs(lastY - startY) > SLOP) {
      handleMoved = true
      moveHandle(lastX, lastY)
    }
  }, true)

  const end = (e: TouchEvent) => {
    if (mode === 'none') return
    const touch = touchOf(e.changedTouches)
    if (!touch) return
    if (mode === 'pending') {
      cancelPress()
      if (e.type !== 'touchend' || !editor) return
      if (tapInSelection) {
        // (the Gesture's tap would put the caret there: the selection stays, its callout comes or goes)
        swallowGesture = true
        setTimeout(() => { swallowGesture = false }, 0)
        e.preventDefault()
        if (!calloutWasShown) showCallout(editor)
      } else afterTap(editor)
      lastTapEnd = Date.now()
      return
    }
    e.preventDefault()
    if (mode === 'handle') e.stopPropagation()
    else {
      // (the Gesture saw this touch begin: it hears its end, but its tap or context menu goes nowhere)
      swallowGesture = true
      setTimeout(() => { swallowGesture = false }, 0)
    }
    if (e.type === 'touchcancel') {
      mode = 'none'
      hideLoupe()
      return
    }
    finishDrag()
  }
  window.addEventListener('touchend', end, true)
  window.addEventListener('touchcancel', end, true)
}
