// Kodium's workbench: the VS Code workbench assembled from monaco-vscode-api's parts - what coding needs on the iPad 2
// (editor, files, search, problems, output, settings, keybindings, themes, extensions from Open VSX, running
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
// Extensions: Open VSX's gallery, and an extension host in the page (LocalProcess). Web extensions run there - the
// worker host would be an iframe and a worker, each with a copy of the engine's shims, on 512 MB - and their code is
// ES5 by the time it runs: the engine lowers JavaScript it fetches over the network, and the page's Function whatever
// else needs it. Declarative extensions (themes, snippets, keymaps) need no host at all.
import 'vscode/localExtensionHost'
import '@codingame/monaco-vscode-theme-defaults-default-extension'
import './run'
import './preview'
import { registerLanguages } from './languages'
import { followTheme } from './theme'
import { standInForLeftOutParts } from './exthost'
import { receiveFiles } from './share'
import { receiveKeys } from './keybar'
import { DOCUMENTS, registerAppFolders } from './files'
// (URI from VS Code's base, not the 'vscode' extension API: that brought the extension host's API and the extensions
// service with it, a seventh of the bundle, for one Uri.file)
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'

declare global {
  interface Window {
    __vsc_mark?: (name: string) => void
  }
}
const mark = (name: string) => window.__vsc_mark?.(name)

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
      // What the iPad 2 cannot afford at every keystroke. The editor's worker runs on the main thread here (no worker
      // of its own), so word suggestions, link and colour detection and the Unicode highlighting each went through the
      // whole file in it; the sticky scroll and bracket pair colours recompute as well; the blinking cursor changed the
      // page twice a second (and every change has the engine's shims run). Layer hints made composited layers the old
      // WebKit rebuilt at every layout. Typing went from a third of a second a key to a quarter with these alone.
      'editor.quickSuggestions': { other: 'off', comments: 'off', strings: 'off' },
      'editor.wordBasedSuggestions': 'off',
      'editor.occurrencesHighlight': 'off',
      'editor.links': false,
      'editor.colorDecorators': false,
      'editor.unicodeHighlight.ambiguousCharacters': false,
      'editor.unicodeHighlight.invisibleCharacters': false,
      'editor.unicodeHighlight.nonBasicASCII': false,
      'editor.stickyScroll.enabled': false,
      'editor.bracketPairColorization.enabled': false,
      'editor.cursorBlinking': 'solid',
      'editor.inlineSuggest.enabled': false,
      'editor.lightbulb.enabled': 'off',
      'editor.disableLayerHinting': true
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
  void followTheme()
  // (VS Code's commands for the app's developer commands over SSH: eval can install an extension, choose a theme...)
  const commands = await getService(ICommandService)
  ;(window as { __kd_commands?: unknown }).__kd_commands = (id: string, ...args: unknown[]) => commands.executeCommand(id, ...args)
}

start().catch((e) => {
  mark('failed: ' + (e && e.message))
  console.error(e)
})
