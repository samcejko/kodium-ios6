// Emmet, as VS Code has it built in: abbreviations - ul>li*3, div.box>p, a:link, m10, d:f - expand from the suggestions
// in HTML and CSS (and SCSS, Less, PHP). On the iPad's on-screen keyboard much less to type. (emmet-monaco-es: Emmet's
// own expander offered as suggestions; VS Code's Emmet is an extension with code, and its host costs 3 s and 14 MB.)
import * as monaco from 'monaco-editor'
import { emmetCSS, emmetHTML } from 'emmet-monaco-es'

export function registerEmmet(): void {
  emmetHTML(monaco, ['html', 'php'])
  emmetCSS(monaco, ['css', 'scss', 'less'])
}
