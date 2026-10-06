// Kodium's workbench: the VS Code workbench assembled from monaco-vscode-api's parts - only what coding needs (editor,
// files, search, Git, problems, output, settings, keybindings, themes, the extension host and the Open VSX gallery).
// Left out: AI/chat, notebooks, debugging, testing, walkthroughs, telemetry, sync.
import { initialize, LogLevel } from '@codingame/monaco-vscode-api'
import type { IWorkbenchConstructionOptions } from '@codingame/monaco-vscode-api'
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override'
import { initUserConfiguration } from '@codingame/monaco-vscode-configuration-service-override/common'
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
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import getExtensionGalleryServiceOverride from '@codingame/monaco-vscode-extension-gallery-service-override'
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getScmServiceOverride from '@codingame/monaco-vscode-scm-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'
import getSnippetServiceOverride from '@codingame/monaco-vscode-snippets-service-override'
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override'
import getStatusBarServiceOverride from '@codingame/monaco-vscode-view-status-bar-service-override'
import getSecretStorageServiceOverride from '@codingame/monaco-vscode-secret-storage-service-override'
import getAuthenticationServiceOverride from '@codingame/monaco-vscode-authentication-service-override'
import getMonarchServiceOverride from '@codingame/monaco-vscode-monarch-service-override'
import '@codingame/monaco-vscode-theme-defaults-default-extension'
import { registerLanguages } from './languages'
import { DOCUMENTS, registerDocuments } from './files'
import * as vscode from 'vscode'

declare global {
  interface Window {
    __vsc_mark?: (name: string) => void
  }
}
const mark = (name: string) => window.__vsc_mark?.(name)

async function start() {
  mark('main')
  // the workspace: the app's Documents folder (files.ts)
  await registerDocuments()

  await initUserConfiguration(
    JSON.stringify({
      'workbench.colorTheme': 'Default Dark Modern',
      'editor.minimap.enabled': false,
      'workbench.startupEditor': 'none',
      'editor.fontSize': 14
    })
  )
  mark('config')

  const options: IWorkbenchConstructionOptions = {
    enableWorkspaceTrust: false,
    developmentOptions: { logLevel: LogLevel.Info },
    windowIndicator: { label: 'iOS 6', tooltip: 'Kodium on iOS 6', command: '' },
    productConfiguration: {
      nameShort: 'Kodium',
      nameLong: 'Kodium',
      extensionsGallery: {
        serviceUrl: 'https://open-vsx.org/vscode/gallery',
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
      workspace: { folderUri: vscode.Uri.file(DOCUMENTS) }
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
      ...getAuthenticationServiceOverride(),
      ...getSecretStorageServiceOverride(),
      ...getExtensionServiceOverride({ enableWorkerExtensionHost: false }),
      ...getExtensionGalleryServiceOverride({ webOnly: true }),
      ...getExplorerServiceOverride(),
      ...getSearchServiceOverride(),
      ...getScmServiceOverride(),
      ...getMarkersServiceOverride(),
      ...getOutputServiceOverride(),
      ...getPreferencesServiceOverride(),
      ...getSnippetServiceOverride(),
      ...getWorkingCopyServiceOverride(),
      ...getStatusBarServiceOverride(),
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
}

start().catch((e) => {
  mark('failed: ' + (e && e.message))
  console.error(e)
})
