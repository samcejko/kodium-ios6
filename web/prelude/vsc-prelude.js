/* Kodium: what the lowered workbench needs besides the engine's page shims (Surfari's), and the startup marks.
   ES5 only: it runs before the workbench, on the iOS 6 engine as it is. */
(function (G) {
    'use strict';
    var t0 = G.__vsc_t0 || Date.now();
    G.__vsc_t0 = t0;
    var marks = G.__vsc_marks = G.__vsc_marks || [];
    var errors = G.__vsc_errors = [];
    // (diagnosis: with localStorage 'kodium.profileStartup' = '1' and WebKit's profiler on - kodium:jsprofile, then
    // kodium:reload - the start until the workbench is one profile, console.profiles)
    var profiling = false;
    try { profiling = !!G.localStorage && G.localStorage.getItem('kodium.profileStartup') === '1'; } catch (e0) {}
    if (profiling) { try { console.profile('kd-startup'); } catch (e1) { profiling = false; } }
    var mark = G.__vsc_mark = function (name) {
        var line = name + ' @' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
        marks.push(line);
        try { document.title = 'Kodium: ' + name; } catch (e) {}
        try { if (G.console && console.log) console.log('[vsc] ' + line); } catch (e2) {}
        if (profiling && name === 'workbench') { profiling = false; try { console.profileEnd('kd-startup'); } catch (e3) {} }
        if (name === 'workbench' && typeof G.__kd_afterStart === 'function') G.__kd_afterStart();
    };
    G.addEventListener('error', function (e) {
        if (errors.length < 60) errors.push(String(e.message) + ' (' + String(e.filename || '').split('/').pop() + ':' + e.lineno + ')');
    }, false);

    if (typeof G.globalThis === 'undefined') G.globalThis = G;

    // The address of a file next to the workbench's script (web/tools/lower.mjs puts this in place of Vite's two URL
    // objects for each asset: the engine's URL takes 6 ms on the iPad 2). With href and toString, as the code reads it.
    var assetBase = null;
    G.__kdAsset = function (name) {
        if (assetBase === null) {
            var u = String((G.__vsc_meta && G.__vsc_meta.url) || G.location.href);
            assetBase = u.slice(0, u.lastIndexOf('/') + 1);
        }
        var s = assetBase + name;
        return { href: s, toString: function () { return s; } };
    };

    // The engine's Number wrapper (Surfari's shims.js, the __brLean one) copies only the statics the iOS 6 engine lists
    // as own names, and that list lacks the ES1 constants: Number.POSITIVE_INFINITY was undefined, so the editor's
    // maximum size (new Dimension(Number.POSITIVE_INFINITY, ...)) was NaN and every split view laid out at 0 x 0
    (function () {
        var N = G.Number;
        var k = { MAX_VALUE: 1.7976931348623157e308, MIN_VALUE: 5e-324, NaN: NaN, NEGATIVE_INFINITY: -Infinity, POSITIVE_INFINITY: Infinity,
            MAX_SAFE_INTEGER: 9007199254740991, MIN_SAFE_INTEGER: -9007199254740991, EPSILON: 2.220446049250313e-16 };
        for (var n in k) {
            if (typeof N[n] !== 'number') {
                try { Object.defineProperty(N, n, { value: k[n], writable: false, enumerable: false, configurable: false }); } catch (e) { try { N[n] = k[n]; } catch (e2) {} }
            }
        }
    })();

    // The engine's flex shims (shims-extra.js) mark the children of every flex box and align them by measuring, after
    // every change of the page - 30 ms a keystroke in the editor - for what the rewritten stylesheet already lays out
    // right here
    G.__brNoFlexItems = true;
    G.__brNoAlignSelf = true;
    // and the shims that look a web page over after every change for what it might need (picture sizes and sources,
    // rows wider than the window, links to the page itself, :has() at every keystroke): 15-20 ms after every key
    G.__brLeanPage = true;

    // VS Code's background work (the rest of a file's tokens, values made when first wanted) asks for idle time. The
    // engine gives it a timer 1 ms later and 50 ms to spend - right after every key, so the next key waited behind it
    // (up to 90 ms on the iPad 2). It runs once nothing was typed or touched for 0.2 s and the page itself is idle (three
    // timers of 10 ms in a row came on time: between the steps of a switch of editors the storage's flush of every
    // component's state ran, 100 ms), or when its own timeout is up.
    // The engine's garbage collection while the user pauses, too: JavaScriptCore collects on a timer some seconds after
    // a few megabytes were allocated (11 s after 5 MB), and at once when the allocations reach the heap's size - in
    // the middle of the next action as often as not, 0.3-0.6 s in the workbench. Once nothing was typed or touched for
    // 1.5 s and the page itself is idle too (two timers of 100 ms in a row came on time: the Settings editor, say, takes
    // longer than 1.5 s to open), the app is asked to collect now (Surfari's engine, KDSiteProtocol /__kd/app/idle;
    // only on the iOS 6 engine).
    (function () {
        var last = 0, queue = [], timer = null, nextId = 1, pause = null, due = 0, onTime = false;
        var arm = function (ms) { due = Date.now() + ms; pause = setTimeout(paused, ms); };
        var paused = function () {
            pause = null;
            var now = Date.now(), quiet = now - last, late = now - due;
            if (quiet < 1500) { onTime = false; arm(1500 - quiet); return; }
            if (late > 50 || !onTime) { onTime = late <= 50; arm(100); return; }
            onTime = false;
            try { var x = new XMLHttpRequest(); x.open('GET', '/__kd/app/idle', true); x.send(null); } catch (e) {}
        };
        var noteInput = function () {
            last = Date.now();
            if (!pause && G.__brNative) { onTime = false; arm(1500); }
        };
        // (and once the workbench has started, as after an input: the start's garbage - JavaScriptCore's own timer,
        // which would have collected it, is kept quiet - is collected as soon as the page is idle)
        G.__kd_afterStart = noteInput;
        var names = ['keydown', 'keypress', 'input', 'compositionupdate', 'touchstart', 'touchmove', 'mousedown'];
        for (var i = 0; i < names.length; i++) document.addEventListener(names[i], noteInput, true);
        var runDue = 0, calm = 0;
        var schedule = function (ms) {
            if (timer) return;
            var delay = ms !== undefined ? ms : Math.max(10, 200 - (Date.now() - last));
            runDue = Date.now() + delay;
            timer = setTimeout(run, delay);
        };
        var run = function () {
            timer = null;
            var now = Date.now(), quiet = now - last >= 200, list = queue, start = now;
            calm = now - runDue <= 15 ? calm + 1 : 0;
            var ready = quiet && calm >= 3;
            queue = [];
            var idle = { didTimeout: false, timeRemaining: function () { return Math.max(0, 50 - (Date.now() - start)); } };
            var late = { didTimeout: true, timeRemaining: function () { return 0; } };
            for (var k = 0; k < list.length; k++) {
                var it = list[k];
                if (it.off) continue;
                var overdue = it.until && now >= it.until;
                if (!ready && !overdue) { queue.push(it); continue; }
                try { it.cb(ready ? idle : late); } catch (e) { setTimeout(function () { throw e; }, 0); }
            }
            if (queue.length) schedule(quiet ? 10 : undefined);
            else calm = 0;
        };
        G.requestIdleCallback = function (cb, opts) {
            var id = nextId++;
            queue.push({ id: id, cb: cb, until: opts && opts.timeout > 0 ? Date.now() + opts.timeout : 0 });
            schedule();
            return id;
        };
        G.cancelIdleCallback = function (id) {
            for (var j = 0; j < queue.length; j++) if (queue[j].id === id) queue[j].off = true;
        };
    })();
    // and what the engine's rewriter finds in the styles VS Code inserts at run time (its theme, icons, token colours)
    // reaches the shims without the marker rules, variable users and deferred values, as for the stylesheet (see
    // web/tools/assemble-site.mjs): the variables pass went through them at every variable VS Code set. The variables
    // these styles define stay (later styles are rewritten with them).
    var manifestAdd = G.__brManifestAdd;
    if (typeof manifestAdd === 'function' && !manifestAdd.__kd) {
        G.__brManifestAdd = function (add) {
            if (add && typeof add === 'object') {
                add.mk = []; add.cv = []; add.dv = [];
                // (the variables a rewritten style defines: VS Code's theme, see setThemeVars)
                if (add.vars && typeof add.vars === 'object') { try { setThemeVars(add.vars); } catch (e) {} }
            }
            return manifestAdd.call(this, add);
        };
        G.__brManifestAdd.__kd = true;
    }

    // The engine rewrites every style a script inserts (shims-extra.js runtimeCSS): a big one in the app, whose rewriter is
    // warm and keeps what it did; a small one with a copy of the rewriter it loads into the page for it - 344 KB of code
    // compiled into the workbench's own heap as it starts, for VS Code's small styles (a list's colours, an animation).
    // The small ones go to the app's rewriter too. (Were it busy, the style stays as it is: the few that need the
    // rewriter come with the workbench's start, when it is not.)
    if (!G.CSSFix) G.CSSFix = {
        run: function (kind, css, pv, opts) {
            try {
                var x = new XMLHttpRequest();
                x.open('POST', 'https://ios6-browser.invalid/cssrun', false);
                x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
                x.send(JSON.stringify([String(css), JSON.stringify(pv || {}), JSON.stringify(opts || {})]));
                return x.status === 200 && x.responseText ? x.responseText : null;
            } catch (e) { return null; }
        }
    };

    // String.prototype.localeCompare: the engine makes a collator for every call (70 µs each on the iPad 2), and VS Code
    // sorts with it - it has no Intl.Collator here: the command palette's thousand commands, the explorer's and quick
    // open's files. Two strings of plain ASCII are compared the way the collator orders them (punctuation, then
    // digits, then letters without regard to case; then lower case before upper); anything else goes to the engine's.
    (function () {
        var nativeCompare = String.prototype.localeCompare;
        if (typeof nativeCompare !== 'function') return;
        var rank = function (c) {
            if (c >= 97 && c <= 122) return 512 + c - 97;          // a-z
            if (c >= 65 && c <= 90) return 512 + c - 65;           // A-Z
            if (c >= 48 && c <= 57) return 256 + c - 48;           // 0-9
            return c;                                              // the rest of ASCII, in its own order
        };
        // (the engine's answers for the rest are kept: the same labels are sorted again every time the palette opens -
        // in Czech, with their diacritics, 1500 of its 3800 comparisons)
        var known = Object.create(null), knownCount = 0;
        var slow = function (a, b, args) {
            if (args.length > 1) return nativeCompare.apply(a, args);
            var key = a + '\u0001' + b, r = known[key];
            if (r !== undefined) return r;
            if (knownCount > 30000) { known = Object.create(null); knownCount = 0; }
            knownCount++;
            return (known[key] = nativeCompare.call(a, b));
        };
        String.prototype.localeCompare = function (that) {
            var a = String(this), b = String(that), n = Math.min(a.length, b.length), i, ca, cb, caseDiff = 0;
            for (i = 0; i < n; i++) {
                ca = a.charCodeAt(i); cb = b.charCodeAt(i);
                if (ca > 126 || cb > 126) return slow(a, b, arguments);
                if (ca === cb) continue;
                var ra = rank(ca), rb = rank(cb);
                if (ra !== rb) return ra < rb ? -1 : 1;
                if (!caseDiff) caseDiff = ca > cb ? -1 : 1;        // (the same letter: lower case first)
            }
            for (; i < a.length; i++) if (a.charCodeAt(i) > 126) return slow(a, b, arguments);
            for (; i < b.length; i++) if (b.charCodeAt(i) > 126) return slow(a, b, arguments);
            if (a.length !== b.length) return a.length < b.length ? -1 : 1;
            return caseDiff;
        };
    })();

    // The engine's visualViewport (shims.js) is the window's size when the page started, and its addEventListener does
    // nothing - and on iOS VS Code takes its size from there and lays out again on its resize event alone: after the
    // iPad turned, or the keyboard came up (the app shrinks the web view above it), the workbench kept its old size. Here
    // it is the window's size at every read, and its events are the window's.
    (function () {
        var vv = G.visualViewport;
        // (the engine's has the sizes as values of its own; a real one, in a desktop browser, has getters of its
        // prototype, and is left alone)
        var own = vv && Object.getOwnPropertyDescriptor(vv, 'width');
        if (!own || !('value' in own)) return;
        var live = function (name, read) {
            try { Object.defineProperty(vv, name, { get: read, enumerable: true, configurable: true }); } catch (e) {}
        };
        live('width', function () { return G.innerWidth; });
        live('height', function () { return G.innerHeight; });
        live('offsetLeft', function () { return 0; });
        live('offsetTop', function () { return 0; });
        live('pageLeft', function () { return G.pageXOffset || 0; });
        live('pageTop', function () { return G.pageYOffset || 0; });
        vv.addEventListener = function (type, fn, opts) { if (type === 'resize' || type === 'scroll') G.addEventListener(type, fn, opts); };
        vv.removeEventListener = function (type, fn, opts) { if (type === 'resize' || type === 'scroll') G.removeEventListener(type, fn, opts); };
    })();

    // The clipboard as VS Code uses it on WebKit: at every click and key it gets navigator.clipboard.write() of a
    // ClipboardItem ready, with a promise of the text that its next copy fulfils. The engine has no ClipboardItem (a
    // ReferenceError at every click and key) and only writeText (to the app's pasteboard), so a copy from VS Code's
    // menus went nowhere. Here the item holds its data and write() hands the text to writeText; an item that a later
    // click or key replaced (its promise cancelled) copies nothing, quietly.
    (function () {
        var clip = G.navigator && G.navigator.clipboard;
        if (typeof G.ClipboardItem !== 'undefined' || !clip || typeof clip.writeText !== 'function') return;
        var ClipboardItem = function (items) {
            this.__kdItems = items || {};
            this.types = Object.keys(this.__kdItems);
        };
        ClipboardItem.prototype.getType = function (type) { return Promise.resolve(this.__kdItems[type]); };
        G.ClipboardItem = ClipboardItem;
        var writeText = clip.writeText;
        try {
            clip.write = function (list) {
                var data = list && list[0] && list[0].__kdItems && list[0].__kdItems['text/plain'];
                if (data === undefined) return Promise.reject(new Error('only text can be copied'));
                return Promise.resolve(data).then(function (v) {
                    // (a Blob of the text, or the text)
                    return v && typeof v === 'object' && typeof v.text === 'function' ? v.text() : v;
                }).then(function (text) { return writeText.call(clip, String(text)); }, function () {});
            };
        } catch (e) {}
    })();

    // User Timing: the workbench marks its startup phases (performance.mark) and reads them back
    var P = G.performance || (G.performance = {});
    if (typeof P.now !== 'function') { var base = Date.now(); P.now = function () { return Date.now() - base; }; }
    if (typeof P.timeOrigin !== 'number') { try { P.timeOrigin = t0; } catch (e3) {} }
    if (typeof P.mark !== 'function') {
        var entries = [];
        P.mark = function (name, opts) {
            var entry = { name: String(name), entryType: 'mark', startTime: (opts && typeof opts.startTime === 'number') ? opts.startTime : P.now(), duration: 0, detail: opts && opts.detail };
            entries.push(entry);
            if (/^code\//.test(entry.name)) mark(entry.name);
            return entry;
        };
        P.measure = function (name) { var e = { name: String(name), entryType: 'measure', startTime: P.now(), duration: 0 }; entries.push(e); return e; };
        P.getEntries = function () { return entries.slice(); };
        P.getEntriesByType = function (t) { var o = []; for (var i = 0; i < entries.length; i++) if (entries[i].entryType === t) o.push(entries[i]); return o; };
        P.getEntriesByName = function (n, t) { var o = []; for (var i = 0; i < entries.length; i++) if (entries[i].name === n && (!t || entries[i].entryType === t)) o.push(entries[i]); return o; };
        P.clearMarks = function (n) { for (var i = entries.length - 1; i >= 0; i--) if (entries[i].entryType === 'mark' && (!n || entries[i].name === n)) entries.splice(i, 1); };
        P.clearMeasures = function () {};
    }

    // Regular expressions with lookbehind, which this engine cannot read: the lookbehind groups are left out (a
    // looser match), the rest of the expression stays
    var withoutLookbehind = function (p) {
        var out = '', i = 0, inClass = false;
        while (i < p.length) {
            var c = p.charAt(i);
            if (c === '\\') { out += p.substr(i, 2); i += 2; continue; }
            if (inClass) { if (c === ']') inClass = false; out += c; i++; continue; }
            if (c === '[') { inClass = true; out += c; i++; continue; }
            if (c === '(' && p.substr(i, 4) === '(?<=' || c === '(' && p.substr(i, 4) === '(?<!') {
                var depth = 0, j = i, cls = false;
                for (; j < p.length; j++) {
                    var d = p.charAt(j);
                    if (d === '\\') { j++; continue; }
                    if (cls) { if (d === ']') cls = false; continue; }
                    if (d === '[') { cls = true; continue; }
                    if (d === '(') depth++;
                    else if (d === ')' && --depth === 0) break;
                }
                i = j + 1;
                continue;
            }
            out += c;
            i++;
        }
        return out;
    };
    // ---- CSS custom properties in the code's own strings (see tools/lower.mjs): an engine without them (iOS 6) gets
    // the current theme's values put in place. The values: the default theme's, from the build (kd-theme.js, the same
    // the stylesheet was rewritten with), then whatever VS Code applies (its theme style, watched below). A variable
    // without a value and without a fallback stays as it was. ?novar tries this in a desktop browser.
    // (an element's own style says it: the engine's CSS.supports answers yes to var() - the engine has custom properties
    // in the stylesheets it rewrites, not in the styles the code sets - and every such value was left out on the iPad)
    var nativeVars = !/[?&]novar\b/.test(G.location ? G.location.search : '') && (function () {
        try {
            var probe = document.createElement('div');
            probe.style.cssText = 'color:var(--kd)';
            return probe.style.cssText.indexOf('var(') >= 0;
        } catch (e) {
            return false;
        }
    })();
    var themeVars = G.__kd_themeVars || {};
    var cssTrim = function (s) { return s.replace(/^\s+|\s+$/g, ''); };
    var resolveVars = function (text, depth) {
        var out = '', i = 0, at;
        while ((at = text.indexOf('var(', i)) >= 0) {
            var prev = at ? text.charAt(at - 1) : '';
            if (prev && /[\w-]/.test(prev)) { out += text.slice(i, at + 4); i = at + 4; continue; }   // (part of a longer name)
            out += text.slice(i, at);
            var k = at + 4, open = 1, comma = -1;
            for (; k < text.length && open; k++) {
                var c = text.charAt(k);
                if (c === '(') open++;
                else if (c === ')') open--;
                else if (c === ',' && open === 1 && comma < 0) comma = k;
            }
            if (open) return out + text.slice(at);
            var name = cssTrim(text.slice(at + 4, comma < 0 ? k - 1 : comma));
            var v = Object.prototype.hasOwnProperty.call(themeVars, name) ? String(themeVars[name]) : null;
            if (v !== null && v.indexOf('var(') >= 0 && depth < 8) v = resolveVars(v, depth + 1);
            if (v === null && comma >= 0) v = resolveVars(cssTrim(text.slice(comma + 1, k - 1)), depth + 1);
            out += v !== null ? v : text.slice(at, k);
            i = k;
        }
        return out + text.slice(i);
    };
    G.__kd_cssVar = function (text) {
        if (nativeVars || typeof text !== 'string' || text.indexOf('var(') < 0) return text;
        return resolveVars(text, 0);
    };
    // The theme VS Code applies: its <style class="contributedColorTheme"> with .monaco-workbench { --vscode-...: ...; }.
    // The engine rewrites that style as it goes in (custom properties out) and hands the values to its shims, where
    // __brManifestAdd below takes them; in a desktop browser (?novar) the text itself is read. A whole theme's worth of
    // them replaces the values (one the new theme lacks has none then).
    var setThemeVars = function (defs) {
        var k, changed = false;
        for (k in defs) if (defs.hasOwnProperty(k) && k.indexOf('--vscode-') === 0 && themeVars[k] !== defs[k]) { themeVars[k] = defs[k]; changed = true; }
        if (changed) themeChanged();
    };
    // (the workbench's own, from the theme service: web/src/theme.ts)
    G.__kd_setThemeVars = function (defs) { setThemeVars(defs); };
    // (the theme the stylesheet was settled with: its colours of the big surfaces, to tell it from another)
    var SIGNATURE = ['--vscode-editor-background', '--vscode-editor-foreground', '--vscode-sideBar-background', '--vscode-activityBar-background',
                     '--vscode-statusBar-background', '--vscode-titleBar-activeBackground', '--vscode-panel-background', '--vscode-tab-activeBackground'];
    var settledSignature = [];
    for (var si = 0; si < SIGNATURE.length; si++) settledSignature.push(String(themeVars[SIGNATURE[si]]));
    var readTheme = function () {
        var styles = document.getElementsByTagName('style');
        for (var i = 0; i < styles.length; i++) {
            if (!/(^|\s)contributedColorTheme(\s|$)/.test(styles[i].className)) continue;
            var text = styles[i].textContent || '', re = /(--[\w-]+)\s*:\s*([^;{}]+)/g, m, defs = {};
            if (text === readTheme.last) return;
            readTheme.last = text;
            while ((m = re.exec(text)) !== null) defs[m[1]] = cssTrim(m[2]);
            setThemeVars(defs);
            return;
        }
    };
    // Another theme than the one the stylesheet was settled with (Dark Modern, see web/tools/assemble-site.mjs): the
    // rules that took the theme's colours (assets/theme-template.txt) come again with the new ones, after the stylesheet.
    // (Its own style element: the engine leaves it as it is - plain colour declarations; going back removes it.)
    var templateText = null, overrideTimer = null;
    G.__kd_themeState = function () {
        var n = 0;
        for (var k in themeVars) if (themeVars.hasOwnProperty(k)) n++;
        return { vars: n, read: !!readTheme.last, template: templateText === null ? null : templateText.length, bg: themeVars['--vscode-sideBar-background'] };
    };
    var themeChanged = function () {
        if (nativeVars || overrideTimer) return;
        overrideTimer = setTimeout(function () {
            overrideTimer = null;
            var settled = true;
            for (var s = 0; s < SIGNATURE.length; s++) if (String(themeVars[SIGNATURE[s]]) !== settledSignature[s]) { settled = false; break; }
            var el = document.getElementById('kd-theme-override');
            if (settled) { if (el) el.parentNode.removeChild(el); return; }
            if (templateText === null) {
                try {
                    var x = new XMLHttpRequest();
                    x.open('GET', 'assets/theme-template.txt', false);
                    x.send(null);
                    templateText = x.status === 200 || x.status === 0 ? x.responseText : '';
                } catch (e) { templateText = ''; }
            }
            if (!templateText) return;
            if (!el) {
                el = document.createElement('style');
                el.id = 'kd-theme-override';
                el.__brOwn = true;
                document.head.appendChild(el);
            }
            el.textContent = resolveVars(templateText, 0);
        }, 0);
    };
    if (!nativeVars) {
        var MO = G.MutationObserver || G.WebKitMutationObserver;
        var watchHead = function () {
            if (!document.head || !MO) return;
            new MO(function () { readTheme(); }).observe(document.head, { childList: true, subtree: true, characterData: true });
        };
        if (document.head) watchHead(); else document.addEventListener('DOMContentLoaded', watchHead, false);
    }

    var reCache = {};
    G.__vsc_re = function (pattern, flags) {
        var key = flags + '/' + pattern, hit = reCache[key];
        if (hit) { hit.lastIndex = 0; return hit; }
        var re;
        try { re = new RegExp(pattern, flags); } catch (e) {
            try { re = new RegExp(withoutLookbehind(pattern), flags); } catch (e2) { re = /(?!)/; }
        }
        // (a literal is one object per evaluation in ES5 too: sharing it keeps lastIndex semantics close enough here)
        if (flags.indexOf('g') < 0 && flags.indexOf('y') < 0) reCache[key] = re;
        return re;
    };

    // Proxy stand-in (jsfix-helpers' __br_Proxy) made to fit VS Code: an ES5 engine sees only accessors that exist,
    // and the stand-in makes them for the target's own keys (and, for get-only proxies of plain objects, for the
    // names of a shared list). VS Code's delayed services are proxies of an empty object whose prototype is the
    // service's class (getPrototypeOf trap): their methods sit on that prototype and would run on the proxy itself,
    // without the get trap that binds them to the real instance. So every name of the prototype chain gets an
    // accessor through the traps as well.
    // (A lowered bundle declares its own copy of the helpers, which replaces the global one when the bundle starts:
    // it calls __vsc_afterHelpers() first thing, which wraps that copy again and gives it the bundle's names.)
    var installProxy = function () {
    var Orig = G.__br_Proxy;
    if (typeof Orig === 'function' && !Orig.__vsc) {
        var hasOwn = Object.prototype.hasOwnProperty;
        var through = function (p, target, handler, key) {
            try {
                Object.defineProperty(p, key, {
                    get: function () { return handler.get(target, key, p); },
                    set: function (v) { if (handler.set) handler.set(target, key, v, p); else target[key] = v; },
                    enumerable: false, configurable: true
                });
            } catch (e) {}
        };
        // (the stand-in keeps its statics - revocable, the shared prototype - on whatever the global name holds, and
        // checks `this instanceof __br_Proxy`: the wrapper shares its prototype, and the statics land on the wrapper)
        var VProxy = function (target, handler) {
            if (!(this instanceof VProxy)) return Orig(target, handler);
            var F = VProxy.factory, proto = null;
            if (handler && typeof handler.get === 'function' && target !== null && typeof target === 'object' &&
                Object.prototype.toString.call(target) !== '[object Array]') {
                try { proto = handler.getPrototypeOf ? handler.getPrototypeOf(target) : Object.getPrototypeOf(target); } catch (e0) { proto = null; }
            }
            if (!proto || proto === Object.prototype || !F) return new Orig(target, handler);
            // a class instance behind a get trap: every known name reads through the trap (the shared list as the
            // prototype), the class's own methods and accessors and the target's keys as accessors of the proxy
            var p = Object.create(F);
            try {
                Object.defineProperty(p, '__vsc_proto', { value: proto });   // (for instanceof, see VInst)
                Object.defineProperty(p, '__br_read', { value: function (k) { return handler.get(target, k, p); } });
                Object.defineProperty(p, '__br_write', { value: function (k, v) { if (handler.set) handler.set(target, k, v, p); else target[k] = v; } });
            } catch (e1) {}
            for (var o = proto; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
                var names = Object.getOwnPropertyNames(o);
                for (var i = 0; i < names.length; i++) {
                    var n = names[i];
                    if (n === 'constructor' || n.slice(0, 5) === '__br_' || hasOwn.call(p, n)) continue;
                    through(p, target, handler, n);
                }
            }
            var own = Object.getOwnPropertyNames(target);
            for (var j = 0; j < own.length; j++) if (!hasOwn.call(p, own[j]) && own[j].slice(0, 5) !== '__br_') through(p, target, handler, own[j]);
            return p;
        };
        VProxy.prototype = Orig.prototype;
        VProxy.__vsc = true;
        G.__br_Proxy = VProxy;
        try { new VProxy({}, { get: function () {} }); } catch (e4) {}   // (the statics, now on the wrapper)
    }
    // instanceof (the lowered code asks __br_instanceof): such a proxy is an instance of the class its getPrototypeOf
    // trap names, as with a real Proxy (the storage service, for one, is initialized only when it is one)
    var OrigInst = G.__br_instanceof;
    if (typeof OrigInst === 'function' && !OrigInst.__vsc) {
        var hasOwn2 = Object.prototype.hasOwnProperty, isProto = Object.prototype.isPrototypeOf;
        var VInst = function (x, C) {
            if (x !== null && typeof x === 'object' && typeof C === 'function' && hasOwn2.call(x, '__vsc_proto')) {
                var cp = C.prototype, xp = x.__vsc_proto;
                if (cp !== null && typeof cp === 'object' && (cp === xp || isProto.call(cp, xp))) return true;
            }
            return OrigInst(x, C);
        };
        VInst.__vsc = true;
        G.__br_instanceof = VInst;
    }
    // super.x of the lowered code (__br_superGet) walks the prototype chain with Object.getOwnPropertyDescriptor -
    // core-js's, with its checks for its symbols: 8000 times when the command palette sorts its commands. A string key
    // takes the engine's own function (page-prelude.js keeps it as __brNative).
    var OrigSuper = G.__br_superGet, nGOPD = G.__brNative && G.__brNative.getOwnPropertyDescriptor, protoOf = Object.getPrototypeOf;
    if (typeof OrigSuper === 'function' && !OrigSuper.__vsc && typeof nGOPD === 'function') {
        var VSuper = function (o, key, self) {
            if (typeof key !== 'string') return OrigSuper(o, key, self);
            for (var p = o; p; p = protoOf(p)) {
                var d = nGOPD(p, key);
                if (d) return d.get ? d.get.call(self) : d.value;
            }
        };
        VSuper.__vsc = true;
        G.__br_superGet = VSuper;
    }
    // A class's methods (__br_defs: 40 000 of them at the start) and its prototype (__br_inherits: 2 500) went through
    // core-js's Object.defineProperty and Object.create with a property map - its symbol polyfill's, which converts every
    // key and lists the map's symbols (WebKit's profiler: 2.5 s of a profiled start for the prototypes, 1 s for the
    // methods). A string key that is no core-js symbol ("Symbol(...)") takes the engine's own defineProperty; the
    // prototype is made with Object.create(proto) and gets its constructor the same way.
    var nDP = G.__brNative && G.__brNative.defineProperty;
    var plainKey = function (k) { return typeof k === 'string' && k.slice(0, 7) !== 'Symbol('; };
    var OrigDefs = G.__br_defs;
    if (typeof OrigDefs === 'function' && !OrigDefs.__vsc && typeof nDP === 'function' && typeof nGOPD === 'function') {
        var VDefs = function (t, e) {
            for (var r = 0; r < e.length; r += 3) {
                var o = e[r], fn = e[r + 1], kind = e[r + 2], d;
                if (!plainKey(o)) { OrigDefs(t, [o, fn, kind]); continue; }
                if (kind === 0) d = { value: fn, writable: true, configurable: true, enumerable: false };
                else {
                    var c = nGOPD(t, o);
                    d = { configurable: true, enumerable: false };
                    if (c && !('value' in c)) { d.get = c.get; d.set = c.set; }
                    if (kind === 1) d.get = fn; else d.set = fn;
                }
                try { nDP(t, o, d); } catch (x) { if (kind === 0) t[o] = fn; }
            }
        };
        VDefs.__vsc = true;
        G.__br_defs = VDefs;
    }
    var OrigInherits = G.__br_inherits;
    if (typeof OrigInherits === 'function' && !OrigInherits.__vsc && typeof nDP === 'function') {
        var fp = Function.prototype;
        var VInherits = function (t, e) {
            if (e !== null && (!e || typeof e !== 'function' && typeof e !== 'object' || e.prototype === undefined)) {
                throw new TypeError('Class extends value ' + e + ' is not a constructor or null');
            }
            var p = Object.create(e === null ? null : e.prototype);
            nDP(p, 'constructor', { value: t, writable: true, configurable: true });
            t.prototype = p;
            if (e !== null) {
                try { t.__proto__ = e; } catch (x) {}
                if (typeof e !== 'function') { t.call = fp.call; t.apply = fp.apply; t.bind = fp.bind; }
            }
        };
        VInherits.__vsc = true;
        G.__br_inherits = VInherits;
    }
    // Object literals the same way: computed keys, getters and setters (__br_props) took core-js's
    // getOwnPropertyDescriptor and defineProperty; and every spread {...x} (__br_assignOwn) asked core-js's
    // Object.getOwnPropertySymbols, which walks all the object's names through closures (the palette builds hundreds
    // of such objects at each opening). Its symbols are properties named "Symbol(...)": only an object that has one
    // goes to core-js for them.
    var nGOPN = G.__brNative && G.__brNative.getOwnPropertyNames, hasOwn3 = Object.prototype.hasOwnProperty;
    var hasSymbolKey = function (o) {
        var names = nGOPN(o);
        for (var i = 0; i < names.length; i++) { var k = names[i]; if (k.charCodeAt(0) === 83 && k.slice(0, 7) === 'Symbol(') return true; }
        return false;
    };
    var OrigAssign = G.__br_assignOwn;
    if (typeof OrigAssign === 'function' && !OrigAssign.__vsc && typeof nDP === 'function' && typeof nGOPN === 'function') {
        var VAssign = function (t, e) {
            if (e == null) return t;
            if (typeof e === 'object' && hasSymbolKey(e)) return OrigAssign(t, e);
            for (var r in e) {
                if (!hasOwn3.call(e, r)) continue;
                if (r === '__proto__') nDP(t, r, { value: e[r], enumerable: true, writable: true, configurable: true });
                else t[r] = e[r];
            }
            return t;
        };
        VAssign.__vsc = true;
        G.__br_assignOwn = VAssign;
    }
    // VS Code's StringBuilder - the HTML of every line the editor renders, at every keystroke, switch and scroll - ends
    // in TextDecoder('UTF-16LE').decode of a Uint16Array of the characters. iOS 6 has no TextDecoder: the engine's polyfill
    // pairs the bytes one by one and pushes each character into an array (15 000 pushes in a typing run). The
    // characters as they are instead, String.fromCharCode in chunks; a text with a lone surrogate (which a decoder
    // turns into U+FFFD) still goes to the polyfill.
    var TD = G.TextDecoder;
    if (TD && TD.prototype && typeof TD.prototype.decode === 'function' && !TD.prototype.decode.__vsc) {
        var origDecode = TD.prototype.decode, fromCC = String.fromCharCode;
        var loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
        var vDecode = function (input, options) {
            if (input && input.BYTES_PER_ELEMENT === 2 && typeof input.subarray === 'function' && this.encoding === 'utf-16le' &&
                !(options && options.stream) && !this.__dnf) {
                var n = input.length, s = '', i = (n && !this.ignoreBOM && input[0] === 0xFEFF) ? 1 : 0;
                for (; i < n; i += 8192) s += fromCC.apply(null, input.subarray(i, i + 8192 < n ? i + 8192 : n));
                if (!loneSurrogate.test(s)) return s;
            }
            return origDecode.apply(this, arguments);
        };
        vDecode.__vsc = true;
        TD.prototype.decode = vDecode;
    }
    var OrigProps = G.__br_props;
    if (typeof OrigProps === 'function' && !OrigProps.__vsc && typeof nDP === 'function' && typeof nGOPD === 'function') {
        var VProps = function (t, e) {
            for (var r = 0; r < e.length; r += 3) {
                var k = e[r], v = e[r + 1], kind = e[r + 2];
                if (kind === 3) { G.__br_assignOwn(t, v); continue; }
                if (!plainKey(k)) { OrigProps(t, [k, v, kind]); continue; }
                if (kind === 0) { nDP(t, k, { value: v, enumerable: true, writable: true, configurable: true }); continue; }
                var c = nGOPD(t, k), d = { enumerable: true, configurable: true };
                if (c && !('value' in c)) { d.get = c.get; d.set = c.set; }
                if (kind === 1) d.get = v; else d.set = v;
                nDP(t, k, d);
            }
            return t;
        };
        VProps.__vsc = true;
        G.__br_props = VProps;
    }
    // the property names the bundle reads (G.__vsc_proxyNames, from <bundle>.names.js): accessors of the shared
    // prototype of get-only proxies, so a trap sees them
    var P = G.__br_Proxy, f = P && P.factory, list = G.__vsc_proxyNames;
    if (f && list && f.__vsc_names !== list.length) {
        var add = function (k) {
            Object.defineProperty(f, k, { get: function () { var r = this.__br_read; return r ? r(k) : undefined; },
                                          set: function (v) { var w = this.__br_write; if (w) w(k, v); }, configurable: true });
        };
        for (var i2 = 0; i2 < list.length; i2++) if (!Object.prototype.hasOwnProperty.call(f, list[i2])) { try { add(list[i2]); } catch (e5) {} }
        try { Object.defineProperty(f, '__vsc_names', { value: list.length, configurable: true }); } catch (e6) {}
    }
    };
    installProxy();
    G.__vsc_afterHelpers = function () { installProxy(); mark('helpers'); };

    mark('prelude');
})(this);
