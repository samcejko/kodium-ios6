// The theme's colours, for the code's own var(--vscode-...) strings and for the stylesheet's rules that took the default
// theme's colours (vsc-prelude.js puts those in again with these when another theme is chosen). VS Code writes them as
// custom properties into a style of its own, out of which the iOS 6 engine takes them: here they come from the theme
// itself, as VS Code makes them.
import { getService, IThemeService } from '@codingame/monaco-vscode-api/services'
import { asCssVariableName, getColorRegistry } from '@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/colorUtils'
import type { IColorTheme } from '@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/themeService'

function push(theme: IColorTheme): void {
  const set = (window as { __kd_setThemeVars?: (defs: Record<string, string>) => void }).__kd_setThemeVars
  if (!set) return
  const defs: Record<string, string> = {}
  for (const item of getColorRegistry().getColors()) {
    const color = theme.getColor(item.id, true)
    if (color) defs[asCssVariableName(item.id)] = color.toString()
  }
  set(defs)
}

export async function followTheme(): Promise<void> {
  const themeService = await getService(IThemeService)
  push(themeService.getColorTheme())
  themeService.onDidColorThemeChange(push)
}
