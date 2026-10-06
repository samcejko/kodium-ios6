/* Kodium: what the lowered workbench needs besides the engine's page shims (Surfari's), and the startup marks.
   ES5 only: it runs before the workbench, on the iOS 6 engine as it is. */
(function (G) {
    'use strict';
    var t0 = G.__vsc_t0 || Date.now();
    G.__vsc_t0 = t0;
    var marks = G.__vsc_marks = G.__vsc_marks || [];
    var errors = G.__vsc_errors = [];
    var mark = G.__vsc_mark = function (name) {
        var line = name + ' @' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
        marks.push(line);
        try { document.title = 'Kodium: ' + name; } catch (e) {}
        try { if (G.console && console.log) console.log('[vsc] ' + line); } catch (e2) {}
    };
    G.addEventListener('error', function (e) {
        if (errors.length < 60) errors.push(String(e.message) + ' (' + String(e.filename || '').split('/').pop() + ':' + e.lineno + ')');
    }, false);

    if (typeof G.globalThis === 'undefined') G.globalThis = G;

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
    var nativeVars = !/[?&]novar\b/.test(G.location ? G.location.search : '') &&
                     !!(G.CSS && typeof G.CSS.supports === 'function' && G.CSS.supports('color', 'var(--kd)'));
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
    // the theme VS Code applies: its <style class="contributedColorTheme"> with .monaco-workbench { --vscode-...: ...; }
    // (a theme chosen later changes the values for what is made from then on)
    var readTheme = function () {
        var styles = document.getElementsByTagName('style');
        for (var i = 0; i < styles.length; i++) {
            if (!/(^|\s)contributedColorTheme(\s|$)/.test(styles[i].className)) continue;
            var text = styles[i].textContent || '', re = /(--[\w-]+)\s*:\s*([^;{}]+)/g, m, n = 0;
            if (text === readTheme.last) return;
            readTheme.last = text;
            while ((m = re.exec(text)) !== null) { themeVars[m[1]] = cssTrim(m[2]); n++; }
            return;
        }
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
