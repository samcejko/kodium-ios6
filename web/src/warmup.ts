// The warm-up before the splash goes: a longer start, then quick answers (the user's wish). What the workbench does
// for the first time takes two to four times as long on the iPad 2 as the next time - JavaScriptCore compiles the code
// it runs for the first time (to machine code after some runs), VS Code makes the widgets, the engine's shims make
// their indexes: the command palette 2.7 s the first time and 0.8 s the next, the panel 2 s and then 0.6, the first
// suggestions 1.1 s and then 0.4, the first keys of a start slower than the next. So while the splash still shows,
// the workbench does once or twice, unseen, what one does first: the command palette and Go to File (with a filter
// too), the panel with the Problems view, the side bar and the Search view, an editor of its own (an untitled
// JavaScript document, never saved) with typing as the keyboard types, suggestions and find, the Settings editor.
// Then everything is as it was - the side bar, the panel, their views, the editors, the focus - the garbage is
// collected, and the splash goes. (localStorage 'kodium.noWarmUp' = '1' leaves it out: what the first time costs.)
// The compiled code has to stay for that: Surfari's engine keeps it once the start's code was thrown away - which
// JavaScriptCore did a minute after the start, or the engine at 75 s, right when one had begun to work: the warm-up's
// went with it, and the editor's first actions were as slow as without one. So the app throws the start's code away
// between two steps (as soon as the engine can tell, 22 s after launch: src/KDSiteProtocol.m /__kd/app/keepcode), and
// the steps before it run again at the end.
import { getService } from '@codingame/monaco-vscode-api'
import { ICommandService } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service'
import { IQuickInputService } from '@codingame/monaco-vscode-api/vscode/vs/platform/quickinput/common/quickInput.service'
import { IWorkbenchLayoutService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService.service'
import { Parts } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService'
import { IPaneCompositePartService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/panecomposite/browser/panecomposite.service'
import { ViewContainerLocation } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/views'
import { IEditorService } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'

// (while it runs: files from other apps wait - share.ts - and the splash says how far it is)
export let warming = false

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
// (n frames, or a little while when frames do not come: a page in the background has none)
const frames = (n: number) => new Promise<void>((resolve) => {
  let done = false
  const finish = () => { if (!done) { done = true; resolve() } }
  const step = (left: number) => { if (left <= 0) finish(); else window.requestAnimationFrame(() => step(left - 1)) }
  step(n)
  setTimeout(finish, 50 * n + 100)
})
const shown = (selector: string) => {
  const e = document.querySelector(selector) as HTMLElement | null
  return !!e && e.offsetWidth > 0 && e.offsetHeight > 0
}
const some = (selector: string) => document.querySelectorAll(selector).length > 0
// the app's answer: 'done' (thrown away, now or before), 'later' (too early) or 'no' (no code kept, or not the iPad)
const ON_DEVICE = location.hostname === 'kodium.invalid'
const keepCode = () => new Promise<string>((resolve) => {
  if (!ON_DEVICE) return resolve('no')
  try {
    const x = new XMLHttpRequest()
    x.open('GET', '/__kd/app/keepcode', true)
    x.onload = () => resolve(String(x.responseText || 'no'))
    x.onerror = () => resolve('no')
    x.send(null)
    setTimeout(() => resolve('no'), 5000)
  } catch { resolve('no') }
})
// until test() holds (then two frames, as the screen shows it), at most ms; each wait in window.__kd_warmLaps
const laps: [string, number, boolean][] = []
async function until(test: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now(), end = start + ms
  for (;;) {
    let ok = false
    try { ok = test() } catch { ok = false }
    if (ok) await frames(2)
    if (ok || Date.now() > end) {
      laps.push([String(test).replace(/\s+/g, ' ').slice(0, 90), Date.now() - start, ok])
      return ok
    }
    await sleep(20)
  }
}

export async function warmUp(): Promise<void> {
  try {
    if (localStorage.getItem('kodium.noWarmUp') === '1') return
  } catch { /* no storage: warm up */ }
  warming = true
  const cs = /^cs/i.test((window as { __kd_lang?: string }).__kd_lang || '')
  const say = (step: number, of: number) => {
    const show = (window as { __kd_splashStep?: (text: string) => void }).__kd_splashStep
    if (show) show((cs ? 'Příprava editoru… ' : 'Getting the editor ready… ') + step + '/' + of)
  }
  try {
    const commands = await getService(ICommandService)
    const quick = await getService(IQuickInputService)
    const layout = await getService(IWorkbenchLayoutService)
    const panes = await getService(IPaneCompositePartService)
    const editors = await getService(IEditorService)
    const run = (id: string, ...args: unknown[]) => commands.executeCommand(id, ...args).catch(() => undefined)

    // what to come back to
    const focused = document.activeElement as HTMLElement | null
    const sideBar = layout.isVisible(Parts.SIDEBAR_PART, window)
    const panel = layout.isVisible(Parts.PANEL_PART, window)
    // (the view shown - or, hidden, the one it shows when it comes back)
    const view = (where: ViewContainerLocation) => panes.getActivePaneComposite(where)?.getId() ?? panes.getLastActivePaneCompositeId(where)
    const sideView = view(ViewContainerLocation.Sidebar)
    const panelView = view(ViewContainerLocation.Panel)

    const quickShown = () => shown('.quick-input-widget')
    const quickRows = () => quickShown() && some('.quick-input-widget .monaco-list-row')
    const pick = async (value: string) => {
      quick.quickAccess.show(value)
      // (rows, or a list that stays empty - Go to File without recent files)
      if (await until(quickShown, 5000)) await until(quickRows, 1500)
      await quick.cancel()
      await until(() => !quickShown(), 2000)
    }

    const steps: (() => Promise<unknown>)[] = [
      // the command palette, empty and filtered
      async () => { await pick('>'); await pick('>vie') },
      // Go to File
      async () => { await pick(''); await pick('hel') },
      // the panel, its Problems view, as it was
      async () => {
        if (!panel) { layout.setPartHidden(false, Parts.PANEL_PART); await until(() => shown('.part.panel'), 5000) }
        // (opened, not toggled: workbench.actions.view.problems hides the panel when the Problems view has the focus -
        // which showing the panel gave it, when it was the last one)
        await panes.openPaneComposite('workbench.panel.markers', ViewContainerLocation.Panel, false)
        await until(() => shown('.part.panel .composite[id="workbench.panel.markers"]'), 3000)
        if (panelView) await panes.openPaneComposite(panelView, ViewContainerLocation.Panel, false)
        layout.setPartHidden(true, Parts.PANEL_PART)
        await until(() => !shown('.part.panel'), 3000)
        layout.setPartHidden(false, Parts.PANEL_PART)
        await until(() => shown('.part.panel'), 3000)
        if (!panel) { layout.setPartHidden(true, Parts.PANEL_PART); await until(() => !shown('.part.panel'), 3000) }
      },
      // the side bar, the Search view, the Explorer
      async () => {
        layout.setPartHidden(sideBar, Parts.SIDEBAR_PART)
        await until(() => shown('.part.sidebar') === !sideBar, 3000)
        layout.setPartHidden(!sideBar, Parts.SIDEBAR_PART)
        await until(() => shown('.part.sidebar') === sideBar, 3000)
        await run('workbench.view.search')
        await until(() => shown('.search-view'), 3000)
        await run('workbench.view.explorer')
        await until(() => shown('.explorer-folders-view'), 3000)
      },
      // an editor: typing (the iOS 6 keyboard's way, into the editor's text area), suggestions, find
      async () => {
        const pane = await editors.openEditor({ resource: URI.from({ scheme: 'untitled', path: 'kodium-warm-up.js' }), languageId: 'javascript', options: { pinned: false } })
        const input = pane?.input
        if (!pane || !input) return
        try {
          const control = pane.getControl() as { getDomNode?(): HTMLElement | null } | undefined
          const root = () => control?.getDomNode?.() ?? null
          const area = () => root()?.querySelector('textarea') as HTMLTextAreaElement | null
          await until(() => !!area() && !!root()?.querySelector('.view-line'), 5000)
          area()?.focus()
          const text = 'const a = [1, 2];\na.map((x) => '
          for (const ch of text) {
            document.execCommand('insertText', false, ch)
            await frames(1)
          }
          for (let k = 0; k < 2; k++) {
            await run('editor.action.triggerSuggest')
            await until(() => shown('.part.editor .suggest-widget.visible') && some('.part.editor .suggest-widget .monaco-list-row'), 4000)
            await run('hideSuggestWidget')
          }
          await run('actions.find')
          await until(() => shown('.part.editor .find-widget.visible'), 3000)
          await run('closeFindWidget')
          await run('editor.action.selectAll')
          await run('deleteLeft')
        } finally {
          // gone again, never saved (its backup with it)
          await input.revert(pane.group.id).catch(() => undefined)
          await pane.group.closeEditor(input, { preserveFocus: true }).catch(() => undefined)
        }
      },
      // the Settings editor
      async () => {
        await run('workbench.action.openSettings2')
        await until(() => shown('.settings-editor') && some('.settings-editor .setting-item'), 15000)
        const settings = editors.activeEditorPane
        if (settings && settings.input && /settings/i.test(settings.input.typeId)) await settings.group.closeEditor(settings.input, { preserveFocus: true })
      }
    ]
    // (how long each step took: window.__kd_warmTimes, for the developer commands)
    const times: number[] = (window as { __kd_warmTimes?: number[] }).__kd_warmTimes = []
    ;(window as { __kd_warmLaps?: unknown }).__kd_warmLaps = laps
    // (the start's code thrown away before a step - asked before each until it is - and the steps before it once more)
    let asking = true, again = 0
    const ask = async (before: number) => {
      const answer = await keepCode()
      if (answer === 'later') return
      asking = false
      if (answer === 'done') again = before
    }
    const order: number[] = steps.map((_, i) => i)
    for (let k = 0; k < order.length; k++) {
      if (asking) {
        await ask(k)
        if (!asking) for (let i = 0; i < again; i++) order.push(i)
      }
      say(k + 1, order.length)
      const t0 = Date.now()
      try { await steps[order[k]]() } catch { /* a step that fails leaves the rest */ }
      times.push(Date.now() - t0)
      await sleep(30)
    }
    // (a warm-up done before the app could throw the code away - not seen on the iPad 2: waits for it, then all again)
    for (let tries = 0; asking && tries < 15; tries++) {
      await sleep(1000)
      await ask(steps.length)
      if (!asking) for (let i = 0; i < again; i++) { try { await steps[i]() } catch { /* the rest */ } }
    }

    // as it was
    try {
      if (sideView && view(ViewContainerLocation.Sidebar) !== sideView) await panes.openPaneComposite(sideView, ViewContainerLocation.Sidebar, false)
      if (panelView && view(ViewContainerLocation.Panel) !== panelView) await panes.openPaneComposite(panelView, ViewContainerLocation.Panel, false)
      if (layout.isVisible(Parts.SIDEBAR_PART, window) !== sideBar) layout.setPartHidden(!sideBar, Parts.SIDEBAR_PART)
      if (layout.isVisible(Parts.PANEL_PART, window) !== panel) layout.setPartHidden(!panel, Parts.PANEL_PART)
      if (focused && focused !== document.body && document.body.contains(focused)) focused.focus()
      else if (editors.activeEditorPane) editors.activeEditorPane.focus()
      else (document.activeElement as HTMLElement | null)?.blur?.()
    } catch { /* the workbench's own state then */ }
    await frames(2)
    // the garbage of it all collected now, not in the middle of the first action (the app's idle collection)
    await new Promise<void>((resolve) => {
      try {
        const x = new XMLHttpRequest()
        x.open('GET', '/__kd/app/idle', true)
        x.onload = x.onerror = () => resolve()
        x.send(null)
        setTimeout(resolve, 3000)
      } catch { resolve() }
    })
  } finally {
    warming = false
  }
}
