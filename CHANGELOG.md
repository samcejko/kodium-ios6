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
- A file's text shows 0.3-0.6 s sooner when it opens (measured on the iPad 2, interleaved: README.md 1.63 -> 1.05 s,
  hello.js opened again 0.93 -> 0.63 s): the editor drew its lines at the next animation frame after the model was
  attached - after the workbench's own work for the opening and a paint of the editor without them; now at the end
  of opening the file, with its scroll position and options in place, so the first paint has the text.
- The first file opened after the start has its lines there 0.5 s sooner (0.63 s instead of 0.74-1.34 on the iPad 2,
  interleaved): files have an editor pane of their own (the text file editor), which the warm-up's untitled document
  did not make - that pane's editor and all of the editor's contributions were made at the first file. The warm-up
  makes them now, without a file. Any file opened has its lines there 0.13-0.2 s sooner (README.md 1.34 -> 1.13 s,
  hello.js opened again 0.66 -> 0.52 s): a small file (64 KB or less) read on its own is read synchronously - a stat
  and a read of 5-8 ms each that the page waits for, where the asynchronous ones came back only after everything else
  the opening had for the WebThread (110-140 ms) - and the editor's toolbar and the status bar's entries for the
  editor come after the next frame instead of before it (75 and 50 ms). Many reads in a row (a search) and big files
  go the asynchronous way.
- A finger's scroll no longer stops half way. A touch goes on to the element it began on, and the scroll under the
  finger recycles that element - a line of the editor, a row of a list - or draws it anew; from then on its moves
  reached no listener of the document, so the scroll stopped (measured with touches made on a line: 36 lines into a
  scroll of the editor, 3 rows into the command palette's list) and its momentum was lost, as was the end of the
  touch. Its moves and its end are passed on to the document now, and VS Code's gestures go to the editor or list
  that held the touch when it began. The app's collection of garbage in pauses, which took the stopped moves for a
  pause, no longer comes in the middle of a long scroll (0.45 s). And each move of a finger went through all the
  gesture targets of the workbench (~160: lists, editors, scrollable elements) asking each whether it holds the
  touch, through a generator (the LinkedList's iterator: the regenerator runtime's three calls and a try per
  element) - now they are found once when the touch begins, and LinkedLists (gesture targets, commands' handlers,
  keybindings) are gone through with a plain iterator: the command palette's list scrolls at 43-47 ms a frame
  instead of 48-55, and the garbage no longer brings a collection (0.5-0.6 s) into a scroll of the editor.
- The rows of lists keep their own icons: iOS 6 has no classList.value, with which VS Code clears a label's classes
  before it sets them, so a row used again kept the classes of everything it had shown (the command palette's rows had
  a CSS file's icon after Go to File, a row of the explorer could have another file's icon) and its list of classes
  grew. And rows come into a list a fifth sooner - the command palette scrolled by a finger at 51-57 ms a frame instead
  of 68-69 (a row a frame) and 35-39 instead of 43-53 (an ordinary scroll), keys typed while the suggestions are open
  ~10 % sooner (interleaved, iPad 2): the engine makes VS Code's flex rows old flexboxes, which lay all their children
  out once more whenever a flexible child has to grow, and five of them are nested in a row of the palette - its outer
  ones are as wide as they would grow now. A list writes a row's attributes and styles only when they change (the old
  WebKit restyles an element and what is in it for a value written again), and so do the suggestions for their rows'
  font styles, icons and labels, which they wrote anew at every key.
- A key reaches the screen another 9 % sooner in a big file (73 ms instead of 80 to its frame, the median of 40 keys,
  three interleaved rounds alike): every edit told the decorations' listeners that the decorations had changed (they
  move with the text), and the editor then built each of the ~55 drawn lines' rendering again only to compare it -
  the lines an edit touches are drawn again for the edit itself, and a decoration that just moved with the text
  changes no other line. Such a change, an edit's alone, now says so and the other lines are left as they are
  (checked: find highlights move with the text typed before them and with a line inserted above them).
- A third less garbage in every pause of typing (1.7-1.9 MB instead of 2.6 in a file of 1,500 lines, so the
  collection - 0.4-0.5 s on the iPad 2 - comes that much less often): the folding regions, worked out again in each
  pause, replaced all their decorations even when typing had changed none of them, and every change of decorations has
  the editor build each drawn line's rendering again to compare (now the decorations stay when the regions are the
  same); and a file's backup - its whole text encoded and written to the backup store - was made 1 s after every pause,
  though the auto save writes the file 5 s after one: now 1 s before the auto save (untitled files and files the auto
  save leaves alone keep it at 1 s). iOS's memory warning, a few seconds before it may close the app, saves the
  changed files at once. And the regions themselves are worked out from the file's lines read at once instead of one
  by one from its piece tree: 8 ms instead of 22 for 1,500 lines.
- A file opened reaches the screen sooner (its first frame, the median of three interleaved rounds on the iPad 2, a
  collection before each: hello.js 1.02 s instead of 1.06, README.md 1.54 instead of 1.77, opened again 0.71 instead
  of 0.77 and 0.62 instead of 0.70): the Explorer's Open Editors list, made again whenever an editor opens or closes -
  its rows, the focus and the selection with their context keys, and a new height for the views around it: 25-200 ms
  - came right after the opening, before the new editor was drawn; it waits for the next frame now, as the editor's
  toolbar does. A file opened into an empty group (the first one, or after all were closed) has the group laid out
  for its tabs at once: the editor got the whole height first, then at the first frame the tabs' height and a second
  layout and drawing (40-70 ms of that frame; now 8-18). And a file's details are read synchronously too, as its text
  already was (15-19 ms from asking to the answer instead of 25-33).
- Long files open quicker and can be worked in at once (a file of 1,500 lines, two interleaved rounds on the iPad 2):
  the bracket highlight - the bracket matching the one at the cursor, or the brackets around it - built the tree of
  all the file's brackets right after every opening, 430-570 ms in which a tap or a key waited; it looks in the
  tokens around the cursor now, as VS Code did before that tree, unless the tree is there already (bracket pair colours
  or guides make it), 25-32 ms - and so does a typed closing bracket for the line to outdent to. An opening bracket
  typed in a file of more than 20,000 characters auto-closes without asking the tree whether a closing bracket is
  missing after it (the tree was built in that key: 0.4 s for 70 KB; smaller files ask as before). And the file's
  lines were projected for the view one by one with a search of the decorations' tree for injected text (inlay hints,
  ghost text) and a read of each line's text for the wrapping: without wrapping and with no injected text in the file
  - the usual case - that is skipped (the view made in 43-122 ms instead of 130-200). First frame 0.99-1.47 s instead
  of 1.16-1.59.
- A closing bracket typed right after Enter is outdented to its opening bracket's line again: the line counted as too
  costly to tokenize until the background tokenizer had caught up - which waits for a pause of 0.2 s - so typed sooner
  it stayed where Enter had put it.
- No more slow moments every 20-30 s while one works: JavaScriptCore throws all compiled code away whenever its pool of
  executable memory is more than half full (at every entry into JavaScript), and with the workbench's code compiled
  after ~7 calls a function, its ~8 MB filled in 20-30 s of work - the next two actions then ran 2-3 times slower at
  every step while everything was parsed and compiled again (a switch of editors 0.8-1.1 s instead of 0.45; a canary
  function's next call 48 ms instead of 2; a minute of switching spent 2.7 % of the WebThread compiling again; the
  JIT's memory went 3 -> 7 MB and back each time). The baseline JIT now takes a function after ~40 calls (BRJSCWarmUp
  600): only the code that runs often is compiled, and it fits. 24 switches of editors, two interleaved rounds each:
  3-4 at 0.8-1 s and a median of 0.47 s before, none and 0.43 s now (all 0.41-0.45); typing in a file of 1,500 lines
  the same at the median, the slowest tenth of the keys 127-156 ms instead of 160-230, Enter 161-167 instead of
  172-187. Opening files after a start too - less is compiled on the way, and the second opening no longer compiles
  most of what the first ran (first frame, two rounds: hello.js 0.63 s instead of 0.92-0.98, README.md 0.80 instead
  of 0.90-1.42, opened again 0.49 instead of 0.52-0.61 and 0.57 instead of 0.60-1.31). And WebKit's own answer to the
  kernel's memory pressure notices, which also throws the compiled code away, does that only when memory is critical
  now (the engine throws it away itself then).
- And sooner again (the same measure, three interleaved rounds, all twelve pairs quicker: hello.js 0.93 s instead of
  0.94, README.md 1.41 instead of 1.62, opened again 0.63 instead of 0.65 and 0.61 instead of 0.63): the group's
  context keys for the editor that became active - a dozen (its kind, resource, whether it can be split, reverted...) -
  were set one by one on the workbench's context, each a change for every menu and scoped context: one change now.
  The Explorer selects the file of the active editor after its first frame, not before it (25-35 ms), and the
  highlight of the brackets at the cursor is worked out 0.3 s after the next frame instead of 0.3 s after the cursor
  moved - an opened file's cursor, model and focus set it going, and it fell before the file's first frame.
- The first key after a save no longer stalls - with the auto save 5 s after a pause in typing, that is the first key
  after every such pause, the one that makes the file "changed" again: 0.15 s to its frame instead of 0.17-0.23 (the
  medians of two interleaved rounds on the iPad 2; a key that changes nothing more takes ~0.07). The Open Editors
  view reset its 13 context keys and set them again when only whether the focused file is saved had changed: only
  that key changes now. Every change of context keys went to every menu - dozens - each asking three Sets (on iOS 6
  the engine's shim, slow) about every changed key, and the keys a view reset and set again counted twice: a menu's
  keys answer from an object now, and the changes told at once come as one list of keys, each once. And after the
  key's frame the editor's toolbar was made again - a new menu, new buttons, the same ones: it is made again only
  when its buttons are others, and its menu is kept while the editor's context is the same.
- Switching tabs: a switch redrew every tab - its label, icon, hover, close button, classes and colours - though
  only which one is active had changed; with the same tabs and labels only their active, selected and changed states
  are drawn again now, as VS Code does when a group becomes active (six tabs, 30 switches in two interleaved rounds:
  27 quicker, by 10-17 ms at the median, ~0.5 s each). A file's language by its name - ~200 registered extensions
  and names gone through - was worked out 7-9 times for each file opened (the tab's icon, the breadcrumbs', the model's
  language and its listeners): once per name now, until the registered associations change.
- Switching to or from a CSS file took 1.55-1.6 s (other files ~0.5 s): the swatch before each colour is coloured by a
  rule the editor makes at run time, and each such rule was a <style> element of its own, put into the page and then
  given its text - two rebuilds of the old WebKit's rule sets from all of the page's 570 KB of CSS, ~80 ms each on
  the iPad 2 - and the rules went 1 s after the editor stopped showing the file, so every switch to it made them all
  again (four colours: 0.65 s of the switch, and their removal stalled the next action). A rule with nothing the iOS 6
  engine lacks goes into one shared sheet now (natively: the rule sets are made again once, in the next frame), and
  a rule no longer used stays for 5 minutes. A switch to t1.css (four colours) 0.63-0.65 s instead of 1.54-1.55, from
  it 0.58 instead of 1.6, the first opening the same (1.1 s); the swatches keep their colours (checked, a colour typed
  in too). The same goes for the editor's other rules made at run time (inlay hints' styles and the like).
- Typing into the command palette: "view" took 2.3-2.4 s on the iPad 2 until the list showed the matching commands.
  For a filter of three letters or more VS Code also looks for "similar commands" with a TF-IDF calculator of all the
  commands' texts - and it made that calculator anew for every filter: each of ~490 texts cut into terms by a
  \p{Letter} expression (on iOS 6 a long lowered class: 5,000 regular expression runs) and counted in Maps of the
  engine's shim. The calculator is kept now while the commands' texts are the same, and a text's terms are kept by the
  text. And the filter's own word matching asked the engine's Set shim whether each character separates words (44,000
  times for "view") and kept its memo in a Map of the shim: plain arrays now. The matching commands show in 0.65 s,
  the first filter after a start in 0.84 (the same rows, checked).
- A terminal: VS Code's own terminal panel (Ctrl+`, Terminal: New Terminal; xterm.js, drawn with the DOM - iOS 6's
  web view has no WebGL) with shells of the iPad itself. iOS lets an app of /var/mobile/Applications start no process,
  so a new package does: Kodium Shell (Kodium-shell-<version>.deb) has launchd start a small daemon for each
  connection to 127.0.0.1:47070, which runs a login shell (bash) on a pseudo terminal as the user mobile, in the
  workspace's folder. It answers only Kodium: a connection has to name the token Kodium writes into its container at
  every start. Without the package the terminal says how to install it (in Czech too). Left out of VS Code's terminal:
  what needs its shell integration scripts (command history, quick fixes, sticky scroll, completions), voice input,
  the accessible view and type-ahead echo - 1.3 MB of the 2.1 it brought (the workbench grew by 1.5 MB). On the iPad 2
  a new terminal's prompt shows in 1.1-1.2 s (2.1 s when the panel opens with it), a key's echo comes in 40-110 ms,
  2000 lines of output in 1.3 s, Ctrl+C stops a command in 0.14 s.
- The terminal's start, 3.7 s on the iPad 2 until the prompt, half of it xterm.js's styles: its renderer's <style>
  elements went into the page empty and got their text after, were written again at every option VS Code set as the
  terminal opened (the same text), and each write had the old WebKit work the whole page's style out again (70-160 ms);
  the theme's 55 KB went through the engine's CSS rewriter in the page as well. One style per terminal now, written
  once and as the rewriter would have it (the -webkit- keyframes, rgba() colours), so the engine leaves it alone. The
  styles of the terminals' icons were written again at every terminal made (the same text, 65 ms each), and the
  terminal's menus asked its settings through a ternary search tree at every condition (0.2 s): the settings' context
  keys are kept in an object too.
- Go to Definition, Find All References and Rename Symbol in JavaScript answer at once (~15 ms) and no longer freeze the
  editor. They parsed the file on the page's thread whenever it had changed since the last time: ~1 s for 1,500 lines on
  the iPad 2, with the page frozen meanwhile. The worker that checks the syntax after each pause in typing now works out
  the file's scopes too (jsScopes.ts). Asked right after an edit, they wait for the worker's answer while the page stays
  free.
- A character typed while the suggestions are open shows sooner: a key after a pause had its new list drawn before
  the character appeared (median ~210-270 ms on the iPad 2 at a key every 0.35 s); now the character is drawn first
  and the list in the next frame (~130-150 ms). Keys in quick succession still leave the list alone until a pause,
  and accepting, moving in the list or a commit character draws the waiting list first.
- Format Document in CSS, HTML and JSON formats right away: it asked which formatter to use, in a dialog and then a
  list of two nameless entries both marked "(default)". Monaco's language services register a document formatter
  and a range formatter, and VS Code counted the range formatter as a second document formatter because neither
  comes from an extension. Format Selection still uses the range formatter.
- A JavaScript file's syntax error stays in the Problems panel only while the file is open: the error was kept after
  the file closed, and a file opened again without the error kept showing it.
- The text selection's loupe follows the finger smoothly: ~45 ms a frame on the iPad 2 instead of ~270 ms every other
  frame, and no half-second stall 1.5 s into a drag. It copied the editor's lines into itself one by one, reading each
  copy's place after the last copy went in, so WebKit laid the whole page out again ~14 times a move. Now the places
  are read first; lines are copied only when the finger reaches another line (a selection's handle copies only its
  overlays); the moves that come before the next frame are taken together; and the caret under the finger is the
  loupe's own until the finger is lifted (the editor drew its caret, current line and the status bar's column anew at
  every move). The loupe stops its touches, so the prelude's watch for input never saw them, and the garbage
  collection waiting for a pause ran in the middle of the drag. It watches at the window now. The glass and shadow are
  a layer of their own that is only moved.
- Where a tap or a finger falls in the text is worked out sooner, and so are the caret's column on a move up or down
  and the status bar's column: VS Code walked the line grapheme by grapheme (~85 µs a character on the iPad 2). A
  line whose characters are all below U+0300 (code, Czech too) is now counted character by character, tabs to their
  stops, with the same results as VS Code's walk in 1.4 million cases.
- Text beyond ASCII - Czech - is decoded 10-80 times sooner: the engine's TextDecoder polyfill went through escape()
  and decodeURIComponent for any such text - 11.9 s for 342 KB at once on the iPad 2, 1.2 s in the chunks a file is
  read in (a file with diacritics opened, the extensions' gallery's answers, the terminal's output, the search's
  files). Kodium decodes UTF-8 itself now (0.14 s for the same; streaming, U+FFFD and fatal as the standard has
  them - checked against a desktop's decoder in 24,000 cases), and encodes it too (a file saved: 0.35 -> 0.12 s).
- The diff editor shows the changes (Compare, the Timeline's and Open Changes): the editor's worker threw at
  String.prototype.trimStart, which the engine's polyfills for workers lack (replaceAll and trimEnd too) - the worker's
  prelude has them now.
- Search in files works: the Search view found only what was in the files the workbench had listed as it started (a
  file put into Documents later was never searched - "function" in 20 new files: 1 match), and took no account of
  the files to include or exclude. Kodium's own search now: the app lists a folder's files at once, VS Code's own
  rules apply the include and exclude patterns (files.exclude, search.exclude, the view's fields), each file is
  searched with one regular expression over its text, and the results show as each file is done. Go to File finds
  every file too.
- The first suggestions in a file, and the first after a minute without typing, come as soon as the others: the
  editor's worker (the words of the suggestions) was started when they first asked it - 1.1 s on the iPad 2 before
  it answered - and stops after a minute without a request. The editor's focus and its edits start it now (asking
  it something small at most every 20 s), while the suggestions' delay runs: 1.5-1.7 s from the key to the list
  instead of 2.6-3.1 (the others 1.4).
- A pause in typing cost 0.2 s less in a long file: the folding regions, worked out again a second after the last
  key, were compared with the old ones through their decorations - each region's range worked out from its offsets
  in the text's tree, two line lengths besides - and now by their lines alone, while no edit added or took lines
  (1,500 lines on the iPad 2: ~0.24 s -> ~0.09 s, the rest is the regions' own computation). And the suggestions'
  list asked its widget's whole layout for every item's height at every key (~100 items, 20 ms).
- Text selection as on iOS (in Czech too): a long press puts the caret under the finger and shows the round loupe
  above it, which follows the finger; a double tap selects a word; a selection made with the finger has iOS's two blue
  handles, which drag its ends (the loupe again, the editor scrolling at its edges), and the black callout of its
  edits - Cut, Copy, Paste and More... (the editor's context menu, which a long press opened before); for the caret
  Select, Select All and Paste, and a tap on the caret shows it too. A tap on the selection shows or hides its callout
  and keeps the selection.
- Cut and Copy work: iOS 6 says it supports neither, and VS Code then made neither (the key bar's ctrl+c and ctrl+x
  did nothing, the editor's menu had no Cut and Copy); they put the selection into the system's pasteboard now
  through the app, as Paste reads it (the engine's clipboard wrote only within 5 s of a touch, and read nothing).
- Surfari's engine matched an expression with named groups at every character in String.prototype.matchAll (it
  copied the expression from what the lowering of the names kept: the names alone), so VS Code's split of the
  terminal's output threw at every piece and nothing reached the terminal; the terminal's links use it too. Kodium's
  prelude copies such an expression from its own source now. And VS Code sends a terminal's input only to a shell
  with a process ID: Kodium Shell 0.1.1 tells the app the shell's.
- The key bar has esc and ctrl: ctrl stays down for the next key, of the bar or of the on-screen keyboard - in the
  terminal Ctrl+C, Ctrl+D, Ctrl+Z and the like, in the editor its shortcuts (Ctrl+S save, F find, H replace, Z/Y
  undo/redo, / comment, D next occurrence, G go to line, P go to file, W close). In the terminal Tab, Esc and the arrows
  are the terminal's keys (a program's modes kept: vim, less).
- Searching the Settings: 2.3 s at every search on the iPad 2 until the matching settings showed, 10-12 s at the
  first after a start. After the settings matching the words, VS Code looks for "natural language" ones - a TF-IDF of
  all ~680 settings' texts, every description cut into terms by an expression the iOS 6 engine runs lowered, made anew
  at every search - and the matching settings, already drawn, reached the screen only after it. Kodium turns that off
  by default (workbench.settings.enableNaturalLanguageSearch: the search still looks in the names, ids, descriptions
  and values); turned on, its calculator is kept between searches and the matching settings are on the screen before
  it runs. And a word's match against a setting's name - or a command's label in the palette - is ruled out at once
  when the word cannot be in it (contiguous: not in it at all; otherwise: its letters not in order in it; checked
  against VS Code's own matching on 80,000 random cases), instead of trying every word start character by character;
  the letters and digits of each setting's id are kept instead of worked out by a lowered \p{L}\p{N} expression at
  every search. A search now shows its settings in 1.9 s, the first after a start in 3.7 s (the same rows, checked),
  and typing into the command palette in 0.55 s.
- The command palette opens a little sooner (0.75-0.77 s instead of 0.81-0.84): a tree given its items - the
  palette's ~490 commands, Go to File's files, the Explorer's - went through them with generators (each a state
  machine in iOS 6's JavaScript, 2-3 per item), and the list's focus, selection and anchor were asked about every
  item through the Set shim even when empty; arrays now, and an empty one answers at once.
- A file's line starts are found with the native indexOf instead of a loop over every character (a file of 70 KB:
  reading it 155 -> 138 ms).
- Some forty texts of the Czech interface came out in English (Close Editor, Select All, New Window, Tab actions,
  Group 4...): the app keeps only the Czech texts its code asks for, found by the calls' numbers in the bundle - and
  a call whose number fell on the next of the bundle's ~1000-character lines was not counted (other texts in every
  build). Such a call counts now: 7,979 texts instead of 7,926-7,935.
- Typing on while the suggestions are open: a key that comes less than 300 ms after the previous one no longer
  waits for the list to be drawn again - the list catches up once the typing pauses for 300 ms. Each key's new list
  was drawn in that key's own frame (its rows, the widget's layout, two forced layouts of the page: 300-350 ms of the
  ~420 a key took on the iPad 2), so keys typed in a row piled up behind each other; typed 200 ms apart, the median
  key now shows 250 ms after it is due instead of 580. Enter, Tab, the arrow keys, Page Up/Down and whatever reads the
  list (accepting, moving in it, the details, an item's commit characters) draw the waiting list first, so they act on
  the item for what was typed (checked: con, res, fun, ret accepted as config0, result, function, return either way).
- The suggestions come ~0.4 s sooner: the words of the open documents (the suggestions' "abc" items), which the
  editor's worker gathers at every list, took it 430-480 ms for a file of 1,500 lines on the iPad 2, now 91-97: they came
  out of a generator (lowered to ES5 for iOS 6, the regenerator runtime's machinery ran for every word) and each of
  them - 9,000 for 345 different words - went into a Set, a polyfill in the worker. Now a plain loop over the lines
  and the word regex's matches, a word looked up in a plain object first, and Number() asked only of what can be a
  number. The list shows 1.55 s after the key there (of which 1 s is quickSuggestionsDelay) instead of 1.9-2.3.
- Keys typed while the suggestions are open another ~10 % sooner (423 ms instead of 467 to the frame with 12 rows in
  the list, a file of 1,500 lines, interleaved): a label's matched letters - the suggestions' at every key, the
  palette's and quick open's as one types the filter - go into the text and highlight spans it has, where all of them
  were taken out and made again (each element attached and styled anew); and the focused suggestion's row is no
  longer drawn a second time once the item is "resolved" when its provider has nothing to resolve (the words of the
  document).
- A key reaches the screen a quarter sooner in a big file (144 ms instead of 199 to its frame in a file of 1,500 lines,
  interleaved), and Enter a little sooner (296 instead of 322). Every move of the cursor set its transition style to
  the same value - a change of the page in the key's own handling, which the engine's style setter took ~20 ms over
  and which had the page laid out before the frame that draws the key; it is set when it changes now. An Enter (or a
  deleted line) took the line that left the drawn range out of the page at once, in the key's handling, the same way
  (three of them: the line, its overlay, its number); they go at the start of the frame that draws the change.
  And a line drawn anew - the one typed in, the numbers below an Enter - keeps its elements: the new text, classes and
  styles go into those already on the page instead of the line being replaced, each a layer the engine took down and
  made again (keys another 8 % sooner, 94-97 ms instead of 104 to the frame in that file, Enter 3 %).
- JavaScript's syntax check and the file's symbols (the outline, Go to Symbol) come from a worker of their own: acorn
  parsed the file on the page's thread in every pause of typing, 0.9-1.4 s for a file of 1,500 lines on the iPad 2,
  and a key or a touch in that time waited for it. Go to Definition, Find All References and Rename still parse on
  the page when they are asked. The worker (134 KB) goes after a minute without a request, or when memory runs short.
- The code is coloured (Monarch) 2.4 times as fast: a file of 1,500 lines in 1.2 s instead of 2.8 on the iPad 2, and a
  file just opened has all its colours a fifth sooner (7.7 s instead of 9.2-11.6, interleaved). Monarch asked each
  rule whether its regex is a RegExp at every try (instanceof, through the lowering's Symbol.hasInstance helper),
  matched through String.prototype.match (the engine's regexp shim, a function more per try: exec is the same for
  Monarch's regexes, which have no g flag), went through the rules and cases with the lowered for...of (a function
  call per rule), sanitized every token's type anew and looked its colour up in a Map (the engine's stand-in) - the
  answers are kept now. instanceof in general is quicker too: the lowering's helper goes straight to the engine's
  own instanceof when the class has no Symbol.hasInstance of its own. The rest of a file is coloured in the page's
  idle time in steps of 5 ms instead of 1 (each step's tokens went through the model, the view and the bracket
  pairs), and stops at the next step when a key or a touch comes instead of going on for the rest of its 50 ms.
- Scrolling with a finger is twice as smooth: 32-36 ms a frame instead of 65-74 on the iPad 2 (the median, measured
  with touch events made in the page - the way a finger scrolls - interleaved), typing as quick as before. A frame in
  which lines came onto the screen cost ~65 ms and one that only moved them ~27: the old WebKit's style, layout,
  compositing and paint for a change of the editor's lines cost more than the lines themselves. The editor now draws
  10 lines more above and below the screen and keeps them while the screen's lines stay inside (2 lines to spare),
  then draws the next 10 - most frames only move what is drawn. Features see the lines on the screen as before (the
  view model's viewport), and suggestions or a hover whose line is off the screen stay hidden. Besides: a finger's
  moves were taken for mouse moves (the engine makes pointer events of touches): the position under the finger worked
  out (a forced layout and caretRangeFromPoint) and the hover's handlers run at every move - no longer; the line
  numbers and (without bracket pair guides) the indent guides keep each line's HTML while only the scroll position
  changes, and the guides no longer ask each line's length to see whether it wraps. And the layers of the lines and
  of the margin (composited) move by their transform instead of top: a change of top laid the page out at every frame,
  with the compositor's pass over all of the page's 300-500 layers (another 10 %: 26-31 ms a frame). The editor's
  hidden text area no longer gets the font's line height and then its own (19 px, then 1 px) at every frame and key.
  The scrollbars' sliders and the rows of every list (the explorer, quick open, the suggestions) are moved by their
  transform as well, and the hidden text area stays where it was put at the cursor while the editor scrolls (it goes
  there once the scrolling stops): another 10 %, 26-28 ms a frame instead of 30-32 (interleaved).
- The workbench's state (views, the editors' places, the history) is written every 60 s, as VS Code's desktop does,
  instead of every 5 s as in a browser tab: each time every component saved its state, 50-100 ms on the iPad 2 in the
  next pause of typing. The app writes it when it goes to the background, with the changed files.
- Scrolling: the first scroll of a file 10-15 % quicker (119 ms a frame instead of 131-140 on the iPad 2), the rest
  ~2 %. The engine's grid pass - after every change of the page has settled, every 150-300 ms while scrolling -
  queried the whole page nine times for the modal editor's grid, which never shows here (workbench.editor.useModal
  is off); and every line on the screen was laid out again at every frame through setTop/setHeight/setLineHeight,
  each making its "Npx" text before finding the value unchanged: the same value now returns at once.
- A keystroke allocates ~17 % less (an edit 150-180 KB -> 125-150 KB, measured with the engine's heap report): fewer
  garbage collections (0.35-0.5 s each) in and after typing. The window's timers no longer go through VS Code's
  wrapper for auxiliary windows (~30 timers are put off again at every key; Kodium has the one window), the log's
  trace and debug calls stop at once when their level is off (~10 a key copied their arguments through three
  loggers), and neither the links (off) nor the viewport's semantic tokens (no provider) work out a delay at every
  key - the semantic tokens at every frame of a scroll too. And in Czech, two labels that begin the same way with
  accented letters ("Otevřít s|oubor") are compared without the engine's collator where they differ in plain letters.
- iOS no longer closes the app after a few windows: Kodium held 290-310 MB of the iPad 2's 512 once the Keyboard
  Shortcuts editor, settings.json and the Extensions view had been opened (every editor an editor group has shown stays
  made, settings.json's JSON worker with the schema of every setting took 17 MB), the other apps took 10-25 MB more, and
  at 26 MB available iOS ended it. Under 48 MB available (before the engine's own relief at 40, which throws the
  compiled code away and leaves everything slow for a while) the workbench now lets go of what it can make again: the
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
- The warm-up also opens and closes an editor of its own (an untitled document, nothing typed): the editor pane of
  untitled documents is made then (and the first two files opened 0.16-0.18 s sooner: what it compiled).
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
