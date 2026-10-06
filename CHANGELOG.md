# Changelog

The changes of each Kodium version; the newest is at the top.

## [0.1.0] - unreleased

The first build.

- The VS Code workbench (monaco-vscode-api 37.3.3) lowered to ES5 for the iOS 6 engine, with an explorer, editor
  tabs, search, the command palette, settings, keybindings and themes; a small workspace in memory.
- The engine of the Surfari browser 1.0.0: TLS 1.2, the CSS rewriter, the page polyfills and shims, the JIT.
- Syntax highlighting for 31 languages (JavaScript, TypeScript, HTML, CSS, Markdown, Python, C, Objective-C, Swift...)
  with monaco's Monarch grammars in the colours of VS Code's theme: TextMate needs WebAssembly, which iOS 6 lacks.
- VS Code's texts in Czech on a device set to Czech (monaco-vscode-api's language pack).
- Colours on an engine without CSS custom properties: the stylesheet is rewritten at build time with the default
  theme's values, and the code's own var(--...) strings get them at run time.
- A splash with the loading steps (English and Czech), and the error if the workbench cannot start.
- The app's Documents folder (iTunes File Sharing) is the workspace.
- For the iPad 2's memory: the lowered workbench is minified (16.8 -> 13.1 MB), and extensions, Git, accounts and
  secret storage are left out until the extension host comes.
- Developer commands over SSH with the device's debug key: eval, snapshot, screen, mem, profile, reload.
- Transpiler fixes over Surfari's: `super.x` reads, writes and calls with getters and setters of the parent class.
- Fixes for the iOS 6 engine: Number's constants (`Number.POSITIVE_INFINITY` and the like, which the engine's `Number`
  lacked: every part of the workbench was laid out at 0 x 0), and reversed flex boxes, whose direction the engine passes
  down to everything inside them (the title bar was the wrong way round).
