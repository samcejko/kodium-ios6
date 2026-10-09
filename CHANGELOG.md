# Changelog

The changes of each Kodium version; the newest is at the top.

## [0.1.0] - unreleased

The first build.

- Snippets and full language configurations from VS Code's built-in language extensions: JavaScript, TypeScript,
  Markdown, HTML, CSS, JSON, Python, Java, PHP, Swift and shell scripts (for, foreach, log...; a JSDoc comment closes
  itself and goes on with " * " on Enter). Their TextMate grammars are left out of the app (Monarch colours the code).
  A "suggest" key on the row above the keyboard shows suggestions and snippets where the caret is (Ctrl+Space).
- JavaScript: syntax errors in the Problems panel and under the code (also in Czech), an outline of the file (Go to
  Symbol, Ctrl+Shift+O: functions, classes with their methods, objects, exports), Format Document, and within the
  file Go to Definition (F12), Find All References (Shift+F12) and Rename Symbol (F2) - which declaration a name means
  is worked out from the file's scopes (var and functions hoisted, let/const/class per block, parameters, catch,
  imports), and a rename keeps shorthands meaning the same ({a} becomes {a: b}, import {a} becomes import {a as b}).
  The page's own parser (acorn) does it; VS Code's TypeScript service, a worker of 10 MB, stays out.
- Emmet in HTML, PHP, CSS, SCSS and Less: an abbreviation (ul>li*3, div.box>p, a:link, m10, d:f) expands from the
  suggestions, as in VS Code.
- The Outline and Timeline views in the Explorer, as in VS Code: the symbols of the file in the editor (JavaScript's,
  JSON's, CSS's, HTML's, Markdown's headings - these read by Kodium itself: VS Code's Markdown extension has code, and
  its host is not started for them; # and underlined headings, nested by level, code blocks skipped; Python's classes,
  methods and functions likewise, nested by indentation), and its local
  history - the version kept at every save, to compare with or restore (Local History: Find Entry to Restore...). The breadcrumbs name the file's folders, not the symbol at the
  cursor (breadcrumbs.symbolPath: it worked the outline out again at every pause in typing).
- The first action after a pause is no longer slower: JavaScriptCore threw all the workbench's compiled code away a
  minute after it last did, and the next action compiled again whatever it ran (a switch of editors took 1.8 s instead
  of 1.3). Surfari's engine keeps it while memory is plentiful (BRJSCKeepCode: 25 MB of bytecode and 3 MB of JIT code
  after a few minutes' use), lets JavaScriptCore throw it away again when memory gets tight, and throws it away at once
  when it is critical or memory is relieved. What runs only once at the start (every module's top level, the
  workbench's construction: 30 MB of bytecode and 7 MB of JIT code) is let go first, a minute after the start.
- A warm-up behind the splash: a longer start, then quicker first actions. The workbench does once, unseen, what one
  does first after a start - the command palette and Go to File (filtered too), the panel with its Problems view, the
  side bar and the Search view - and puts everything back as it was (the side bar, the panel, their views, the
  focus). The splash says how far it is ("Getting the editor ready… 2/5"); about 20 s on the iPad 2, where the first
  actions then take nearly what the next ones take (measured with and without, interleaved): the command palette
  0.75-1 s instead of 2.7, the panel 0.6-0.7 s instead of 2.3 and hiding it 0.4 s instead of 1.4, the Search view
  0.45 s instead of 1.35, hiding the side bar 0.33 s instead of 0.76. (An editor of its own typed into made no first
  action in an editor quicker: it is not part of it.) The compiled code has to stay for that: Surfari's engine keeps
  it once the start's code is gone, which JavaScriptCore threw away a minute after the start (or the engine at 75 s) -
  the warm-up's with it. The app throws the start's code away between two steps now, as soon as the engine can tell
  (22 s after launch), and the steps before that run once more at the end. Files from other apps wait until the
  warm-up is done. (localStorage kodium.noWarmUp = 1 leaves it out.)
- The Settings editor opens in 1.2-1.5 s the first time too (was 4.7 s on the iPad 2): the warm-up makes it and builds
  its tree (4.5 s more at the start). That only helps now that window.newWindowProfile, which lists the profiles, is
  registered with the start's other settings: VS Code registered it "eventually" - 40 s after the start on the iPad 2,
  after the warm-up - and every setting registered drops the default settings, so the tree was built again at the
  first opening. Making the editor also does less: each of the ~700 settings had its validator made with them, its
  ~8 messages put together in the display language whether they applied or not; a validator makes them when it first
  checks a value (the default settings 0.27 s -> 0.07 s). Opened again, it no longer asks for the installed extensions
  (0.45-0.55 s) - only after one was installed, removed or changed. And a setting changed while the editor was closed
  (in settings.json, by a command) shows its new value when it opens again: the row on the screen kept the old one.
- iOS no longer closes the app after a few windows: Kodium held 290-310 MB of the iPad 2's 512 once the Keyboard
  Shortcuts editor, settings.json and the Extensions view had been opened (every editor an editor group has shown stays
  made, settings.json's JSON worker with the schema of every setting took 17 MB), the other apps took 10-25 MB more, and
  at 26 MB available iOS ended it. Under 40 MB available the workbench now lets go of what it can make again: the
  editors' panes not on the screen (not the text editor nor the Settings editor the warm-up made - that one too at
  iOS's memory warning) and the language services' idle workers. Measured on the iPad 2 after those windows: 289 ->
  226 MB. An editor let go of opens as the first time again.
- Garbage is collected in a pause only once 12 MB were allocated since the last collection (was 4): a collection takes
  0.35-0.5 s on the iPad 2 however little there is to collect (the workbench's ~49 MB are gone through), and each one
  was a chance for the next touch or key to wait for it; the heap's 25-40 MB of free room takes the allocations
  meanwhile, so the app's memory stays as it was. (/__kd/app/idle?mb=, and /__kd/app/heap for measuring.)
- The Czech texts are only those the workbench asks for: 7 900 of the language pack's 22 600 messages (the file 1.3 MB
  -> 0.5 MB, ~11 000 fewer objects in the page's heap); a message left out would show in English. And localize() no
  longer builds the arguments object of every call (5 µs each on the iPad 2), thousands of them at every start.
- What is pressed shows at once, while the finger is on it: a button of a toolbar or the activity bar, a tab, a row
  of a list or tree (the explorer's, suggestions, the command palette's), a menu's item, a button, a status bar item,
  a section's header. What a tap does takes the iPad 2 0.3-1 s, and nothing showed until then: VS Code marks what is
  under the mouse, and taps come as touches it handles itself (no mouse events, no :active).
- Enter (and joining lines) no longer works out all ~160 options of the editor again for the new number of lines,
  which only the minimap reads - and it is off.
- Context menus open in 0.35-0.5 s instead of 0.75-0.9 (the editor's, measured on the iPad 2): every menu gave the
  menus' shared <style> its text again - the same text - and the old WebKit made its rule sets anew from all of the
  page's rules, and the engine's shim looked the text over again. The text is given when it is another.
- Every key does 7 % less inside it (in the profiler 100 ms instead of 108): typed arrays made from an array - line
  tokens, ~30 a key, the auto-indent check of every key among them - went through core-js's wrapper of the engine's
  constructors, which checks the constructor with Function.prototype.toString each time (1-3 ms on the iPad 2). They
  are made from a length now, which the wrapper hands straight to the engine.
- Suggestions come once typing pauses for a second (was half a second): on the on-screen keyboard that was often in the
  middle of a word, and with the list open every further key took 0.25-0.65 s instead of 0.2 (the list filtered and
  drawn again). The key bar's suggest key shows them at once.
- The history of places (Go Back, Go Forward) replaces its last entry at every move of the cursor while typing, and
  took the entry's editor's dispose listener off and put it on again each time - the same editor, three times a key.
  It stays on now.
- Opening files, switching tabs, the Settings editor and menus do less with context keys (a switch of tabs 8 % less in
  the profiler): at every change of a context key - dozens when an editor opens - every scoped context key service
  (one per editor, view, list and widget) copied its whole context and made a Set of its keys to see whether the
  change was only its own; iOS 6 has no Set of its own, the engine's stand-in is slow to fill. The keys are asked of
  the context itself.
- A line's height while scrolling (~365 times a frame) is the default at once when no line has a height of its own -
  in Kodium none has - instead of a binary search over those lines.
- Changed files are saved when the app goes to the background (the Home button, another app, a call), as VS Code saves
  when its window loses the focus: iOS may end an app in the background without a word, and auto save waited for a
  pause in typing. Auto save now comes after 5 s of pause instead of 2: every save made the next key make the file
  changed again - its tab, the Open Editors view and the editor's toolbar redrawn, 0.2-0.3 s more for that key on the
  iPad 2.
- The warm-up also opens and closes an editor of its own (an untitled document, nothing typed): the editor pane every
  file is shown in is made then, and the first two files open 0.16-0.18 s sooner.
- The views' title bars (Explorer, Open Editors, Outline, Timeline) make their toolbars again only when their actions
  change: the first file opened had all of them made anew though they came out the same.
- Every key does ~10 % less (in the profiler 80-100 ms inside a key instead of 97-120): whether the key should indent
  its line anew is worked out on the line's text with the brackets inside strings, comments and regular expressions
  taken out - new tokens were made for that at every key (13 ms of it; now 3.6). A line without a bracket in such a
  token, in one language, is that text already and is taken as it is - the same answers (checked by typing the same
  code with and without).
- Scrolling ~5 % faster (79-80 ms a frame instead of 83 on the iPad 2): the indent guides cost 11 ms of each frame and
  now 5. Each line's guides are kept while the text is the same (a scroll works out the lines it brings in, not all
  the lines on the screen), and without bracket pair guides (off by default) the indent guides no longer go through
  a queue of them with two array spreads per guide.
- The first key after a save (auto save saves after 2 s of pause) and the first key into a file opened for a look come
  sooner (in the profiler 0.34 s instead of 0.56 inside the key): the Open Editors view redraws the row of the editor
  that changed, and the list told its focus anew twice - at each, the view reset the 13 context keys of the focused
  row (the file's name, folder, language...) and set them again, and every change went to every menu. They change now
  when the focused row's file or state does, as one change.
- The keys of the row above the keyboard come up again as soon as the finger lifts, not once the workbench has typed
  the key (the script runs on the main thread, which drew the key cap only afterwards).
- Switching between editors does less (0.68 s on the iPad 2 instead of 0.84, when no garbage collection falls in): the
  menus of the menu bar are made when it opens, not again at every switch; the editor's toolbar is made once per
  switch, not twice (once for the editor that was going); the window's title (which iOS does not show) is put together
  when nothing is being typed or touched; the editor's settings for the file are worked out once. The glyph margin
  (breakpoints, the light bulb: neither is in Kodium) is off: 18 px more for the code.
- The menu bar's menu (the button at the top of the activity bar) opened under the side bar.
- JavaScript's garbage collection comes while the user pauses (1.5 s without input, and the page idle), not in the
  middle of the next action: JavaScriptCore collected on its own timer some seconds after a few megabytes were
  allocated - 0.3-0.6 s, inside every second or third switch of editors. Surfari's engine reads the heap's budget
  (BRJSEngine collectPageGarbageIfAllocated:) and collects once 4 MB were allocated, and JavaScriptCore's own timer
  is kept quiet (it still collected in every second switch, 0.65-0.9 s becoming 1.2-1.6 s); the allocation limit still
  collects when reached, and the start's garbage is collected once the workbench is up and the page idle. VS Code's
  background work also waits until the page is idle, not only 0.2 s after the last touch: the storage's flush of every
  component's state (every minute, 100 ms) ran between the steps of a switch of editors.
- Settings, Keyboard Shortcuts and an extension's page open as tabs again, not in VS Code's new overlay
  (workbench.editor.useModal: off): the overlay is an editor area of its own, made at every opening and thrown away
  with the editor in it at closing - the Settings editor took 7 s every time. In a tab it stays made, and opens again
  in 1.5 s, without building its tree again (which of the ~1000 settings goes under which heading: 40 000 tests of
  names against patterns), unless settings were registered or dropped meanwhile; values changed while it was closed
  show as before.
- Menus are made once, not twice (VS Code's MenuInfo refreshed again what its base class had just refreshed: sorting
  all items by title, collecting their conditions' keys), and a menu's sorted items are kept until the menu registry
  changes: the command palette's thousand commands, the editor's toolbar at every switch, context menus. The palette
  also shares one "Configure Keybinding" button among its commands, and with nothing typed yet no longer tests each
  command against the empty filter.
- The first seconds after the workbench appears are busy 1.5 s less (6.5 s of work instead of 8 on the iPad 2), so it
  answers sooner: the icons' stylesheet no longer declares 1900 CSS variables (which iOS 6 does not have), it and the
  Seti file icons' stylesheet are marked as rewritten for the engine instead of going through its CSS rewriter by a
  synchronous request at every start (nothing in them needed it but Seti's "unset"), the settings' migrations look only
  at keys the settings have, the sash sizes no longer go into a <style> of CSS variables (each new stylesheet makes the
  old WebKit rebuild its rule sets from all of the page's rules), and the paste/drop kinds' schema is left out.
- JSON with comments (themes, the file icons' theme, the languages' configurations, settings.json) is read by the
  engine's JSON.parse once comments and trailing commas are taken out, instead of VS Code's scanner character by
  character: 0.4 s less work after every start on the iPad 2 (16 documents). What JSON.parse cannot read still goes
  to the scanner.
- The file icons' theme is made once after a start, not three times: VS Code took it up again at every change of the
  languages and when its extension was registered, though it had just made it - read and parsed again, Seti's 1500
  selectors put together again, its 95 KB stylesheet given the same text again (which the old WebKit parses anew and
  rebuilds its rule sets from) and every view told to draw its icons again. It is made again only when a language
  brings an icon of its own, and a stylesheet given the text it already has is left alone (the color theme's after
  every start, too): 0.9 s less work after a start on the iPad 2 (7.2 s instead of 8.1).
- The workbench appears 0.4 s sooner and the seconds after it are busy 1.5 s less (5.8 s of work instead of 7.3 on
  the iPad 2): keybindings.json's schema (2600 commands with their titles and arguments) is made when something reads
  it - opening that file - not at the start, at each contribution to it and once more after the extensions; the
  color theme restored from the last start is not put in place a second time when the one loaded from its extension
  is the same (all of its rules made again and every listener told); the default settings are not made again from all
  1400 settings when nothing the start had cached of them differs; the extensions' context keys come as one change.
- The seconds after the start are busy another 1.1 s less (4.7 s instead of 5.8 on the iPad 2): the settings files'
  seven JSON schemas are made when first read, not after the extensions and at every change of the settings'
  registry; the default product icon theme restored from storage, then set again, no longer has the icons' 50 KB
  stylesheet made again; what was made of the file icon theme is stored with it and taken from there by the next start
  while its file, the languages' icons and the code are the same; the default settings' reload is skipped also when
  Kodium's defaults name a setting this VS Code does not have.
- Typing and scrolling are a quarter faster (a key 92 ms to the screen on the iPad 2 instead of 118-138; scrolling a
  long file 94 ms a frame instead of 131): ligatures off was the CSS font-feature-settings "liga" off, "calt" off on
  the editor's lines, and any feature settings make the iOS 6 engine lay out and draw all their text through Core
  Text's complex path (meant for scripts that need shaping). Off is no feature settings now; the engine's simple path
  draws no ligatures either. And the editor no longer inspects the accessibility setting in every settings layer at
  every frame (whether a screen reader is in use is kept until that setting changes).
- Scrolling another 14 % faster (84 ms a frame instead of 98): the line numbers and the status bar's items had
  tabular figures (font-variant-numeric, the 'tnum' feature to the iOS 6 engine) - the complex text path again, for
  every line number a scroll brings in; iOS 6's digits are of one width anyway. And the indent guides keep each line's
  indentation while the text is the same, instead of taking it from the text of every line on the screen at every
  frame.
- The side bar shows in 0.7 s instead of 1, the Explorer after the Search view in 0.5 s instead of 0.8: the explorer
  read all its folders again whenever it was shown, for file changes it might have missed. It does now when something
  changed while it was hidden; what changes outside the workbench - a file from another app, what iTunes File Sharing
  put into Documents while the app was in the background - refreshes it (on the return to the foreground).
- The Settings editor's first opening takes 4.6 s instead of 5 on the iPad 2: the ~1000 settings are sorted under
  their headings without trying every heading's patterns on every setting left (40 000 regular expression tests): a
  pattern is tried only on the settings whose names begin with its part before the first *, found in the names
  sorted once - the same settings come out under the same headings (checked against VS Code's way for all 177
  headings); and the default settings are no longer written out as JSON text twice whenever they are made - the
  version with the "Commonly Used" group, which nothing reads, is written only when asked for.
- The first command palette of a start opens 0.6 s sooner (2.7 s instead of 3.3 on the iPad 2), and the first of a
  menu, a list or a tree likewise: the styles VS Code writes at run time (a list's colours, a tree's indent guides,
  a menu's, the quick input's, the breadcrumbs', the editor's decoration rules) get the theme's values from Kodium's
  prelude and the rewriter's mark when that is all they lack, instead of going to the engine's rewriter - whose new
  text had the old WebKit make its rule sets from all the page's rules once more.
- The first suggestions after a start come 0.35 s sooner (1.15 s instead of 1.5 on the iPad 2): what VS Code works
  out of each snippet's body (whether it is trivial, uses the clipboard...) is kept in localStorage for the next
  starts, and the engine's grid shim makes its index of VS Code's grid rules in a pause after the start, not at the
  first page change that needs it.
- The engine's style pass after a change of the page (after nearly every key) takes 5 ms instead of 9: it no longer
  emulates VS Code's six :has() rules, which are all looks only (the code action menu's minimum width with a header,
  Markdown's task items without bullets, the actions of extensions' trees scrolled sideways, a wider panel filter
  while it has the focus, the compact command center).
- The panel shows in 0.4-0.7 s instead of 0.6-1: the Output view let go of its channel whenever the panel was hidden
  and took it up again when shown, its editor's whole view made anew; the channel stays now.
- The state VS Code stores every 5 s when the page is idle - between keys, too - is stored in half the time: the
  editor resolver kept inspecting two settings (the editor associations) in every settings layer for it; it keeps
  them until the configuration changes.
- Drop-downs (the Output's channels, the Settings editor's choices, the Search view's...) are the iPad's own <select>
  with the system's picker, as VS Code has them on a Mac: the drawn one was a list widget with a stylesheet of its own,
  made again at every opening of the panel.
- The command palette opens 50 ms sooner (0.70 s on the iPad 2 instead of 0.75, warm): its sort of the commands looked
  each one up in the history twice and compared labels with localeCompare in every one of its ~2600 comparisons; the
  history once per command now, and the labels' alphabetical order is kept while they stay the same.
- Object literals with computed keys, getters or setters, and every spread ({...options}), no longer go through core-js:
  a spread asked its Object.getOwnPropertySymbols, which walks all of the object's names through closures. Only an
  object with one of core-js's symbols still goes there (the command palette opens 2-3 % sooner, the start 0.1 s).
- The workbench starts another 0.35 s sooner: Kodium's 31 Monarch languages are registered together. One by one,
  each made VS Code build its languages' registry again from all languages so far and tell the settings' schema of
  all of them again (651 language merges, 31 schema updates).
- The workbench starts another 0.6 s sooner (13.7 s on the iPad 2): every class of the bundle got its methods (40 000)
  and its prototype (2 500) through core-js's Object.defineProperty and Object.create - its symbol polyfill's, which
  converts every key and lists a property map's symbols. The page's prelude gives the lowered code's class helpers
  the engine's own defineProperty for plain keys.
- The workbench starts 0.8 s sooner (14.2 s on the iPad 2 instead of 15.0): the loops in the modules' top levels (the
  key code tables first) made JavaScriptCore compile the whole bundle's top level with its JIT - code that runs once.
  Each loop now runs in a little function of its own (tools/lower.mjs), and the bundle's top level stays interpreted,
  no slower. (Found with a build that times every module's top level: KODIUM_MODTIMES=1.)
- The workbench's script is 1 MB smaller (13.4 MB, 216 modules fewer to parse and run at every start and keep in
  memory): VS Code's modules came in for a constant or for what the iPad never gets to - Copilot's inline completions'
  views and models, the comment editor, dictation and chat's speech-to-text (all for the diff editor's accessibility
  help), the remote explorer's port forwarding (for the remote view's id), MCP's and chat's services, the editor's GPU
  renderer, tree-sitter, the WebAssembly diff, the multi-file diff editor, the Windows and macOS keyboard layouts.
  The four web workers (the editor's, JSON's, CSS's, HTML's) are 380 KB smaller each: every one of them carried the
  WebAssembly diff's binary, which nothing runs. The stylesheet lost the floating panels' rules (an experimental
  setting, off), which the old WebKit still tried on the elements they end with at every insertion.
- The workbench starts 0.7 s sooner (16 s on the iPad 2, with the extensions above): each file of the bundle's
  assets (themes, icons, the extensions' files) got its address from two URL objects, 6 ms each with the engine's URL;
  now it is made of strings. The Markdown renderer's regular expressions with \p{...} are lowered for the engine once
  and kept (Surfari's regexp shim, for an app's page): the transpiler and its Unicode tables no longer load into the
  workbench at every start (25 000 objects less in its heap).
- Typing on the iPad 2 2.5 times quicker again (a key showed after 0.29-0.37 s with the IntelliSense of the last
  version, now 0.12-0.13 s), measured key by key with WebKit's profiler and the app's own sampler:
  - the engine's frame budget (meant for web pages that animate all the time) made every frame after one longer than
    20 ms wait as long again - the editor's frames take 40-60 ms on the iPad 2; an app's page now draws at once;
  - VS Code's background work (the rest of a file's tokens, values made when first wanted) runs once nothing was typed
    or touched for 0.2 s, not 1 ms after every key with 50 ms to spend;
  - the resize observer checks sizes in the page's frames: it found requestAnimationFrame only by the engine's prefixed
    name and checked on a timer between frames, a layout of its own after every change;
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
- The command palette opens in 1.1-1.2 s once it was open (1.5 s before; the first time 3.7 s, from 5.1) and other
  sorted lists sort faster: an ASCII string comparison in place of the engine's localeCompare, whose answers for
  other strings (Czech labels) are kept; super.x of the lowered code reads the prototype chain with the engine's own
  getOwnPropertyDescriptor, not core-js's (8000 times while the palette sorts). VS Code's rules made at run time
  with nothing the engine lacks go into the page as they are, not
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
