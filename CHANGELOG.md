# Changelog

The changes of each Kodium version; the newest is at the top.

## [0.1.0] - unreleased

The first build.

- Typing on the iPad 2 about 40 % quicker again (a key showed after 0.29-0.37 s with the IntelliSense of the last
  version, now 0.15-0.22 s), measured key by key with WebKit's profiler and the app's own sampler:
  - positions in a line (the cursor, the scroll to it, indent guides) are computed, as VS Code does on other browsers,
    not measured in the page with a layout of it each time: VS Code does not trust its arithmetic on Safari, whose zoom
    changes the characters' widths (Kodium's page cannot be zoomed), and it took the font for proportional because
    iOS 6's Courier lacks the arrow VS Code draws tabs with;
  - the dots of selected white space are not drawn (worked out again for every line on the screen at every frame), and
    the editor's hidden text area for screen readers stays empty (500 characters around the cursor were written into
    it with the selection at every key, each time a layout of the page);
  - inline completions (ghost text, next edit suggestions: Copilot's) are left out - no extension that gives them runs
    on the iPad, and their models followed every key and every move of the cursor in every editor;
  - folding regions and the matching bracket are worked out once typing pauses (1 s, 0.3 s), not after every key;
  - the parts that change while one works (the tabs, the editor, the status bar, the side bar, the panel) are
    composited layers: after a layout the old engine maps every box it laid out through all of its ancestors up to
    the nearest layer - the page's root, 30 levels up, before (a tab's label: 90 -> 42 ms);
  - the engine's shims that look a web page over after every change (picture sizes, rows wider than the window, links
    to the page itself, :has() at every key) stay out of the workbench (window.__brLeanPage, Surfari's engine);
  - suggestions show once typing pauses for half a second (0.3 s brought them in the middle of words).
- The command palette and other sorted lists sort faster (an ASCII string comparison in place of the engine's
  localeCompare); VS Code's rules made at run time with nothing the engine lacks go into the page as they are, not
  through the stylesheet rewriter (a synchronous request to the app each); WebKit's free memory goes back to the system
  every 20 s while the app holds more than 200 MB. Developer commands: jsprofile (WebKit's JavaScript profiler on), mem
  with the page's layers and types=1; the lowered workbench comes in lines of 1000 characters, so that a profile or an
  error names a line.
- Extensions from Open VSX: the Extensions view (search, install, update, the "install from the publisher?" question).
  Web extensions run in an extension host in the page - their code lowered to ES5 by the engine as it comes from the
  network, or by the page's Function - and declarative ones (themes, snippets, keymaps, icon themes) need none. A
  theme from an extension colours the whole workbench: the stylesheet's rules with the theme's colours come again with
  the new ones (the engine has no custom properties). Open VSX's redirected assets (readme, changelog, icons, manifest)
  are fetched by the app, as the engine refuses a redirected cross-origin request. The extension host starts only when
  an extension with code is there, at the start or when one is installed: without one the workbench starts 3 s sooner
  and takes 14 MB less. An extension's README, features and changelog show in the page itself (VS Code's webview, an
  iframe with scripts of its own, does not run on iOS 6: it said "No README available").
- IntelliSense for JSON, CSS (SCSS, Less) and HTML: completion, hover, problems, formatting, colours and symbols, from
  monaco's language services - each in a web worker of its own, built for iOS 6 (the engine's polyfills and the
  Proxy stand-in in front of it), that starts when a file of its language opens and stops 45 s after its last use.
  Suggestions show as in VS Code once typing pauses (the words of the file in a JavaScript file); CSS colours as
  swatches.
- The editor's own worker (diffs, word suggestions) runs off the page's thread, which had it all. VS Code's file icons
  (Seti).
- Smoother on the iPad 2: the engine's memory relief comes only when iOS is about to close the app - its full garbage
  collection threw away all the compiled code, which the workbench then compiled again (a tenth of the time of
  switching tabs), and with 50-70 MB left on the iPad it came every few seconds while freeing next to nothing; no copy
  of the stylesheet rewriter is loaded into the workbench for its small styles (the app's rewriter does them); the
  minimap's section headers are no longer looked for in the whole file after every pause in typing (with the minimap
  off).
- Themes from extensions colour the whole workbench on the iPad too: the theme's colours come from VS Code's theme
  service (the engine takes the custom properties out of the theme's style), and the rules that took the default
  theme's colours are kept as text (the stylesheet rewriter had emptied them). Dialogs, buttons and other parts that
  VS Code colours from its code got no colour on the iPad (the engine's CSS.supports says yes to var(), which the
  engine's own styles do not have): the trust dialog of an extension had no background.
- Files from and to other apps: "Open in Kodium" (Mail, Safari, Dropbox...) puts the file into the Documents and opens
  it; Share... in the explorer's menu and a tab's menu shows the system's menu (Open In..., Mail, Print, Copy).
- A row of keys above the on-screen keyboard, in the keyboard's own look, in place of WebKit's Previous/Next/Done bar:
  Tab, the arrows (held, they go on), brackets and the other characters code needs, undo and redo.
- Smaller for the iPad 2: VS Code's own splash, the "modern UI" (off, 14 stylesheets) and the extension host's parts
  for what an extension cannot do on the iPad (comments, tests, tasks, terminals, debugging, source control, the
  editor tabs API) are left out: the workbench script 14.4 -> 13.9 MB, the stylesheet 703 -> 593 KB; 278 MB at the
  most after the start with an extension running (from 290).
- Preview of HTML and Markdown beside the file (Open Preview: the button above the file, the explorer's menu,
  Ctrl+Shift+V). A page shows as Surfari's engine shows the web - its scripts lowered, its CSS rewritten - from the
  Documents as a site of its own (another origin than the workbench's, which it cannot reach into), and loads again
  when a file is saved. Markdown is rendered as it is typed, its code in the colours of the editor's grammars.
- Run JavaScript (the play button above a JavaScript file, F5, Ctrl+Alt+N): the file runs in a worker of its own, its
  console goes to the Output panel ("Kodium: Run"), modern syntax goes through the engine's transpiler first; Stop ends
  a program that does not.

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
- The user's settings, keybindings and snippets are kept (Library/Application Support/Kodium): VS Code in a browser keeps
  them in memory only. Kodium's own defaults (the theme, no minimap, auto save) are defaults, not entries in them.
- Auto save after a second: the on-screen keyboard has no Cmd+S, and iOS ends an app that runs short of memory.
- The workbench fits itself above the on-screen keyboard and lays itself out again when the iPad turns (the engine's
  visualViewport, which VS Code follows on iOS, kept the size of the start and never told of a change).
- Typing on the iPad 2, measured key by key (from about a second until a key showed): the stylesheet is settled when
  the app is built (the theme's variables, the sizes the engine lacks), so that the engine's shims no longer redo it
  after every change of the page; the editor's costliest helpers are off by default (word suggestions, link, colour and
  Unicode detection, the sticky scroll, bracket pair colours, the blinking cursor); the workbench's script is kept as
  text by the engine (it decoded all 12 MB again for each function it compiled); the engine's memory relief waits
  until 290 MB. The same for the styles VS Code inserts at run time (theme, icons). The theme is Dark Modern again (the
  default named it as older VS Code did, and a light theme came). Measured on the iPad 2: the time until a typed key
  shows went from about 0.9 s to 0.16 s, and the engine's shims from 330 ms a key to 13.
- For the iPad 2's memory: the lowered workbench is minified (16.8 -> 12.0 MB); extensions, Git, accounts and secret
  storage are left out until the extension host comes, and so are the merge editor, call and type hierarchies, the
  refactoring preview and the search editor; VS Code's services are created at once instead of behind proxies, which
  the engine has to imitate with an accessor for every name (36,000 of them, now 1,900). About 245 MB once started
  (from 290).
- Developer commands over SSH with the device's debug key: eval, snapshot, screen, mem, profile, reload.
- Transpiler fixes over Surfari's: `super.x` reads, writes and calls with getters and setters of the parent class.
- Fixes for the iOS 6 engine: Number's constants (`Number.POSITIVE_INFINITY` and the like, which the engine's `Number`
  lacked: every part of the workbench was laid out at 0 x 0), reversed flex boxes, whose direction the engine passes
  down to everything inside them (the title bar was the wrong way round), and SVG images with an opacity on the root
  element, which the engine ignores (the editor's watermark was black).
