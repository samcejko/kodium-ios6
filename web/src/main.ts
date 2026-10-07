// Kodium's workbench: the VS Code workbench assembled from monaco-vscode-api's parts - what coding needs on the iPad 2
// (editor, files, search, problems, output, outline, local history, settings, keybindings, themes and file icons,
// extensions from Open VSX, IntelliSense for JSON, CSS and HTML, JavaScript's problems and outline, Emmet, running
// JavaScript, the preview of HTML and Markdown, files from and to other apps). Left out for memory (the iPad 2 has
// 512 MB): Git, accounts and secret storage; and AI/chat, notebooks, debugging, testing, walkthroughs, telemetry, sync.
import { initialize, getService, LogLevel } from '@codingame/monaco-vscode-api'
import { ICommandService } from '@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service'
import type { IWorkbenchConstructionOptions } from '@codingame/monaco-vscode-api'
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override'
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getNotificationServiceOverride from '@codingame/monaco-vscode-notifications-service-override'
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override'
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override'
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'
import getSnippetServiceOverride from '@codingame/monaco-vscode-snippets-service-override'
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override'
import getStatusBarServiceOverride from '@codingame/monaco-vscode-view-status-bar-service-override'
import getMonarchServiceOverride from '@codingame/monaco-vscode-monarch-service-override'
import getExtensionGalleryServiceOverride from '@codingame/monaco-vscode-extension-gallery-service-override'
// The Outline and Timeline views of the Explorer: a file's symbols, and its local history - the versions VS Code keeps
// at every save (working copy service), to compare or restore
import getOutlineServiceOverride from '@codingame/monaco-vscode-outline-service-override'
import getTimelineServiceOverride from '@codingame/monaco-vscode-timeline-service-override'
// Extensions: Open VSX's gallery, and an extension host in the page (LocalProcess). Web extensions run there - the
// worker host would be an iframe and a worker, each with a copy of the engine's shims, on 512 MB - and their code is
// ES5 by the time it runs: the engine lowers JavaScript it fetches over the network, and the page's Function whatever
// else needs it. Declarative extensions (themes, snippets, keymaps) need no host at all.
import 'vscode/localExtensionHost'
import '@codingame/monaco-vscode-theme-defaults-default-extension'
// VS Code's file icons (Seti)
import '@codingame/monaco-vscode-theme-seti-default-extension'
// VS Code's built-in language extensions, for what they declare besides their TextMate grammars (Kodium colours with
// monaco's Monarch grammars; the grammar files are left out of the build, see vite.config.mjs): the snippets (for,
// foreach, log... in JavaScript and TypeScript, Markdown's, Java's, PHP's, Swift's, the shell's) and the full language
// configurations (comments, brackets, indentation and Enter rules - a JSDoc comment goes on with the next line)
import '@codingame/monaco-vscode-javascript-default-extension'
import '@codingame/monaco-vscode-typescript-basics-default-extension'
import '@codingame/monaco-vscode-markdown-basics-default-extension'
import '@codingame/monaco-vscode-html-default-extension'
import '@codingame/monaco-vscode-css-default-extension'
import '@codingame/monaco-vscode-json-default-extension'
import '@codingame/monaco-vscode-python-default-extension'
import '@codingame/monaco-vscode-java-default-extension'
import '@codingame/monaco-vscode-php-default-extension'
import '@codingame/monaco-vscode-swift-default-extension'
import '@codingame/monaco-vscode-shellscript-default-extension'
// IntelliSense for JSON, CSS (SCSS, Less) and HTML: monaco's language services, each in a worker of its own that starts
// when a file of its language is opened (they register for when the services run)
import { jsonDefaults } from '@codingame/monaco-vscode-standalone-json-language-features'
import '@codingame/monaco-vscode-standalone-css-language-features'
import '@codingame/monaco-vscode-standalone-html-language-features'
import './run'
import './preview'
import { registerLanguages } from './languages'
import { followTheme } from './theme'
import { standInForLeftOutParts } from './exthost'
import { receiveFiles } from './share'
import { receiveKeys } from './keybar'
import { registerJavaScript } from './javascript'
import { registerEmmet } from './emmet'
import { registerMarkdown } from './markdown'
import { registerPython } from './python'
import { DOCUMENTS, registerAppFolders } from './files'
// (URI from VS Code's base, not the 'vscode' extension API: that brought the extension host's API and the extensions
// service with it, a seventh of the bundle, for one Uri.file)
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import { Registry } from '@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform'
import { Extensions as WorkbenchExtensions } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/contributions'

declare global {
  interface Window {
    __vsc_mark?: (name: string) => void
  }
}
const mark = (name: string) => window.__vsc_mark?.(name)

// The workers by the label the workbench asks for (tools/build-workers.mjs): the editor's - diffs, word suggestions,
// links off the page's thread, which had them all on the iPad - and the language services'. Any other runs in the
// page as before.
const WORKERS: Record<string, string> = { editorWorkerService: 'editor', json: 'json', css: 'css', html: 'html' }
const SITE = location.href.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '')
;(window as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker | undefined {
    const name = WORKERS[label]
    // (with the page's language, which a worker of the iOS 6 engine does not know: worker-prelude.js)
    return name ? new Worker(SITE + '/assets/workers/' + name + '.worker.es5.js?lang=' + encodeURIComponent(navigator.language || 'en')) : undefined
  }
}
// (JSON with comments, as VS Code's own files are; its colours stay those of Kodium's grammar, see languages.ts)
jsonDefaults.setDiagnosticsOptions({ ...jsonDefaults.diagnosticsOptions, comments: 'ignore', trailingCommas: 'warning' })
jsonDefaults.setModeConfiguration({ ...jsonDefaults.modeConfiguration, tokens: false })

async function start() {
  mark('main')
  standInForLeftOutParts()
  // the workspace (the app's Documents folder) and the user's settings (files.ts)
  await registerAppFolders()
  mark('config')

  const options: IWorkbenchConstructionOptions = {
    // Kodium's defaults: the user's settings.json holds only what the user changes
    configurationDefaults: {
      // (the theme's id as VS Code knows it now: 'Default Dark Modern' is migrated in settings.json only, and a
      // default it could not find left it to fall back on Light+ or Dark 2026, whichever it had last)
      'workbench.colorTheme': 'Dark Modern',
      'editor.minimap.enabled': false,
      'workbench.startupEditor': 'none',
      'editor.fontSize': 14,
      // (the on-screen keyboard has no Cmd+S, and iOS ends the app without asking when memory runs short)
      'files.autoSave': 'afterDelay',
      'files.autoSaveDelay': 2000,
      // Suggestions (IntelliSense) as VS Code shows them, once typing pauses for half a second: worked out in the
      // workers (the words of the file in the editor's, the rest in the language services'), the list drawn only then -
      // not at every key while typing on (on the on-screen keyboard keys come 0.25-0.4 s apart: at 0.3 s the list came
      // in the middle of words, and drawing it held the next key back)
      'editor.quickSuggestions': { other: 'on', comments: 'off', strings: 'off' },
      'editor.quickSuggestionsDelay': 500,
      'editor.wordBasedSuggestions': 'currentDocument',
      // (CSS colours as swatches, from the language service)
      'editor.colorDecorators': true,
      // What the iPad 2 cannot afford at every keystroke. The sticky scroll and bracket pair colours recompute; the
      // blinking cursor changed the page twice a second (and every change has the engine's shims run); the highlight of
      // a word's other places follows every move of the cursor. Layer hints made composited layers the old WebKit
      // rebuilt at every layout. The minimap's section headers were looked for in the whole file after every pause in
      // typing, with the minimap off.
      'editor.occurrencesHighlight': 'off',
      'editor.links': false,
      'editor.minimap.showRegionSectionHeaders': false,
      'editor.minimap.showMarkSectionHeaders': false,
      'editor.unicodeHighlight.ambiguousCharacters': false,
      'editor.unicodeHighlight.invisibleCharacters': false,
      'editor.unicodeHighlight.nonBasicASCII': false,
      'editor.stickyScroll.enabled': false,
      'editor.bracketPairColorization.enabled': false,
      'editor.cursorBlinking': 'solid',
      'editor.inlineSuggest.enabled': false,
      'editor.lightbulb.enabled': 'off',
      'editor.disableLayerHinting': true,
      // (measured with WebKit's profiler while typing on the iPad 2) The dots of selected white space: worked out again
      // for every line on the screen at every frame - a sixth of the time of a keystroke. And the text VS Code keeps in
      // its hidden text area for screen readers - 500 characters around the cursor, written again with the selection
      // at every keystroke, each time a layout of the page: empty, as VS Code has it on a desktop without a screen reader
      // (keys still come as keys)
      'editor.renderWhitespace': 'none',
      'editor.accessibilitySupport': 'off',
      // (the glyph margin holds breakpoints and the light bulb, neither of which Kodium has: 18 px more for the code)
      'editor.glyphMargin': false,
      // The breadcrumbs name the file's folders; the symbol where the cursor is would need the file's outline worked out
      // again at every pause in typing (the Outline view and Go to Symbol have them)
      'breadcrumbs.symbolPath': 'off',
      // Settings, Keyboard Shortcuts and an extension's page open as tabs, not over the workbench: the overlay is an
      // editor area of its own, made at every opening and thrown away at closing with the editor in it - the Settings
      // editor took 7 s every time on the iPad 2; in a tab it stays made
      'workbench.editor.useModal': 'off'
    },
    enableWorkspaceTrust: false,
    developmentOptions: { logLevel: LogLevel.Info },
    windowIndicator: { label: 'iOS 6', tooltip: 'Kodium on iOS 6', command: '' },
    productConfiguration: {
      nameShort: 'Kodium',
      nameLong: 'Kodium',
      extensionsGallery: {
        serviceUrl: 'https://open-vsx.org/vscode/gallery',
        itemUrl: 'https://open-vsx.org/vscode/item',
        publisherUrl: '',
        resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
        extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
        controlUrl: '',
        nlsBaseUrl: ''
      }
    },
    workspaceProvider: {
      trusted: true,
      async open() {
        return false
      },
      workspace: { folderUri: URI.file(DOCUMENTS) }
    }
  }

  await initialize(
    {
      ...getLogServiceOverride(),
      ...getEnvironmentServiceOverride(),
      ...getLifecycleServiceOverride(),
      ...getStorageServiceOverride(),
      ...getConfigurationServiceOverride(),
      ...getKeybindingsServiceOverride(),
      ...getThemeServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getMonarchServiceOverride(),
      ...getModelServiceOverride(),
      ...getNotificationServiceOverride(),
      ...getDialogsServiceOverride(),
      ...getExplorerServiceOverride(),
      ...getSearchServiceOverride(),
      ...getMarkersServiceOverride(),
      ...getOutputServiceOverride(),
      ...getPreferencesServiceOverride(),
      ...getSnippetServiceOverride(),
      ...getWorkingCopyServiceOverride(),
      ...getOutlineServiceOverride(),
      ...getTimelineServiceOverride(),
      ...getStatusBarServiceOverride(),
      ...getExtensionGalleryServiceOverride({ webOnly: true }),
      ...getWorkbenchServiceOverride(),
      ...getQuickAccessServiceOverride({
        isKeybindingConfigurationVisible: () => true,
        shouldUseGlobalPicker: () => true
      })
    },
    document.body,
    options
  )
  await registerLanguages()
  mark('workbench')
  receiveFiles()
  receiveKeys()
  registerJavaScript()
  registerMarkdown()
  registerPython()
  registerEmmet()
  void followTheme()
  // (VS Code's commands for the app's developer commands over SSH: eval can install an extension, choose a theme...)
  const commands = await getService(ICommandService)
  ;(window as { __kd_commands?: unknown }).__kd_commands = (id: string, ...args: unknown[]) => commands.executeCommand(id, ...args)
  // (and the time each of the workbench's contributions took to create, by phase - what VS Code's Startup Performance
  // view shows: [[id, ms], ...] for phases 1-4)
  ;(window as { __kd_contribTimes?: unknown }).__kd_contribTimes = () => {
    const timings = (Registry.as(WorkbenchExtensions.Workbench) as unknown as { timings: Map<number, [string, number][]> }).timings
    const out: Record<string, [string, number][]> = {}
    timings.forEach((list, phase) => { out[phase] = list.slice() })
    return out
  }
}

start().catch((e) => {
  mark('failed: ' + (e && e.message))
  console.error(e)
})
