// A press shows at once. What a tap does takes the iPad 2 0.3-1 s (a view, the panel, a file), and nothing showed until
// then: VS Code marks a button under the mouse (:hover), and taps come as touches that its Gesture handles itself (no
// mouse events follow, no :active either). So the element under the finger - a button of a toolbar or of the activity
// bar, a tab, a row of a list or a tree (suggestions, the palette's, the explorer's), a button, an item of the status
// bar, a section's header - is marked while the finger is on it (kd-pressed, styled in kodium.css): drawn in the next
// frame, before the tap's work begins at the finger's lifting. A finger that moves on (scrolling) unmarks it, and
// nothing is marked in the editor's text.
const PRESSABLE = ['action-item', 'monaco-button', 'tab', 'monaco-list-row', 'statusbar-item', 'pane-header',
  'monaco-breadcrumb-item', 'monaco-custom-toggle', 'monaco-text-button', 'button']

function pressable(target: EventTarget | null): HTMLElement | null {
  let node = target as HTMLElement | null
  for (let depth = 0; node && node.nodeType === 1 && depth < 12; depth++, node = node.parentElement) {
    const list = node.classList
    if (!list) return null
    if (list.contains('monaco-editor') || list.contains('monaco-workbench')) return null
    for (let i = 0; i < PRESSABLE.length; i++) if (list.contains(PRESSABLE[i])) return list.contains('disabled') ? null : node
  }
  return null
}

export function showPresses(): void {
  let pressed: HTMLElement | null = null, x = 0, y = 0
  const release = () => {
    if (pressed) pressed.classList.remove('kd-pressed')
    pressed = null
  }
  document.addEventListener('touchstart', (e: TouchEvent) => {
    release()
    if (e.touches.length !== 1) return
    const touch = e.touches[0]
    const element = pressable(touch.target)
    if (!element) return
    pressed = element
    x = touch.pageX
    y = touch.pageY
    element.classList.add('kd-pressed')
  }, true)
  document.addEventListener('touchmove', (e: TouchEvent) => {
    const touch = e.touches[0]
    if (pressed && (!touch || Math.abs(touch.pageX - x) > 10 || Math.abs(touch.pageY - y) > 10)) release()
  }, true)
  document.addEventListener('touchend', release, true)
  document.addEventListener('touchcancel', release, true)
}
