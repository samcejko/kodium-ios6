/* shims.js - small browser API shims for the iOS 6 WebKit, loaded after core-js, regenerator, fetch,
 * IntersectionObserver and ResizeObserver polyfills. ES5 only. */
(function (window, document) {
    'use strict';
    var Ep = window.Element && window.Element.prototype;

    // Functions of the shims that stand in for the engine's (Date, Map, Set, WeakMap, Promise, Number) read as native
    // code, as core-js's own did: String(fn) through a toString of their own, and Function.prototype.toString.call(fn)
    // - which core-js replaces, and lodash's isNative asks (a Map it took for a polyfill made it keep object keys in a
    // list) - through core-js's record of the function: under the "state" key of its shared store for our core-js,
    // and in the shared WeakMap (shared.state) that a page's own core-js 3 keeps its records in.
    var NATIVE_TEMPLATE = String(String).split('String'), nativeSources = [];
    var shareSources = function () {
        var shared = window['__core-js_shared__'], WM = window.WeakMap;
        if (!shared || !WM || !WM.__brLean || !nativeSources.length) return;
        var store = shared.state;
        try { if (!store) store = shared.state = new WM(); } catch (e) { return; }
        if (typeof store.has !== 'function' || typeof store.set !== 'function') return;
        for (var i = 0; i < nativeSources.length; i += 2) if (!store.has(nativeSources[i])) store.set(nativeSources[i], { source: nativeSources[i + 1], facade: nativeSources[i] });
        nativeSources.length = 0;
    };
    var looksNative = function (fn, name) {
        var src = NATIVE_TEMPLATE.join(name), shared = window['__core-js_shared__'], STATE = shared && shared.keys && shared.keys.state;
        try { Object.defineProperty(fn, 'toString', { value: function toString() { return src; }, writable: true, configurable: true }); } catch (e) {}
        if (typeof STATE === 'string') try { Object.defineProperty(fn, STATE, { value: { source: src, facade: fn }, writable: true, configurable: true }); } catch (e2) {}
        nativeSources.push(fn, src);
        shareSources();
    };

    // Object.prototype.toString as in ES2015: an object's Symbol.toStringTag names it. core-js's Map, Set, Promise...
    // came out "[object Object]", and libraries tell types that way: Vue made a reactive Map with the handlers of a
    // plain object, so its methods ran on the proxy ("Incompatible receiver, Map required": kosik.cz), lodash's
    // clones and comparisons took them for plain objects too.
    (function () {
        var TAG = window.Symbol && window.Symbol.toStringTag, native = Object.prototype.toString;
        if (!TAG || native.__brTag) return;
        try { if (window.Map && native.call(new window.Map()) === '[object Map]') return; } catch (e0) {}
        // (core-js's symbol is an object: as a key it went through its toString on every call, most of the time taken;
        // no try either, a function with one makes a scope object per call here, and a throwing getter throws today too)
        var KEY = typeof TAG === 'symbol' ? TAG : String(TAG);
        var toString = function toString() {
            var s = native.call(this);
            if (s !== '[object Object]') return s;
            var t = this[KEY];
            return typeof t === 'string' ? '[object ' + t + ']' : s;
        };
        toString.__brTag = true;
        try { Object.defineProperty(Object.prototype, 'toString', { value: toString, writable: true, configurable: true, enumerable: false }); } catch (e1) {}
    })();

    // requestAnimationFrame (only the webkit prefixed one exists)
    if (!window.requestAnimationFrame) {
        window.requestAnimationFrame = window.webkitRequestAnimationFrame || function (cb) { return window.setTimeout(function () { cb(Date.now()); }, 16); };
        window.cancelAnimationFrame = window.webkitCancelAnimationFrame || window.webkitCancelRequestAnimationFrame || function (id) { window.clearTimeout(id); };
    }
    // Frames on a budget: a page that draws every frame (stripe.com's WebGL gradient) kept the page's thread busy all
    // the time on this hardware, and taps, scrolling and the rest of the page waited. After a frame that took more
    // than 20 ms the next one waits as long again: such drawing gets about half the time, and the animation runs slower.
    (function () {
        var native = window.requestAnimationFrame;
        if (!native || native.__brBudget) return;
        var queue = [], nextId = 1, pending = false, lastCost = 0, lastEnd = 0;
        var run = function (ts) {
            pending = false;
            var list = queue, t0 = Date.now();
            queue = [];
            for (var i = 0; i < list.length; i++) {
                if (list[i].off) continue;
                try { list[i].cb(ts); } catch (e) { window.setTimeout(function () { throw e; }, 0); }
            }
            lastEnd = Date.now();
            lastCost = lastEnd - t0;
        };
        var schedule = function () {
            if (pending) return;
            pending = true;
            // (an app's page - window.__brLeanPage, see shims-extra.js - draws only in answer to the user: its next
            // frame does not wait; Kodium's editor took 40-60 ms a frame, and the frame after it came that much later)
            var wait = lastCost > 20 && window.__brLeanPage !== true ? lastEnd + lastCost - Date.now() : 0;
            if (wait > 0) window.setTimeout(function () { native.call(window, run); }, wait);
            else native.call(window, run);
        };
        window.requestAnimationFrame = function (cb) {
            var id = nextId++;
            queue.push({ id: id, cb: cb });
            schedule();
            return id;
        };
        window.cancelAnimationFrame = function (id) {
            for (var i = 0; i < queue.length; i++) if (queue[i].id === id) queue[i].off = true;
        };
        window.requestAnimationFrame.__brBudget = true;
        if (window.webkitRequestAnimationFrame) {
            window.webkitRequestAnimationFrame = window.requestAnimationFrame;
            window.webkitCancelAnimationFrame = window.webkitCancelRequestAnimationFrame = window.cancelAnimationFrame;
        }
    })();
    if (!window.MutationObserver && window.WebKitMutationObserver) window.MutationObserver = window.WebKitMutationObserver;
    if (!window.requestIdleCallback) {
        window.requestIdleCallback = function (cb) { return window.setTimeout(function () { var start = Date.now(); cb({ didTimeout: false, timeRemaining: function () { return Math.max(0, 50 - (Date.now() - start)); } }); }, 1); };
        window.cancelIdleCallback = function (id) { window.clearTimeout(id); };
    }

    // Dates: the old engine reads a date and time without an offset ("2026-09-27T10:00") as UTC, and refuses forms
    // every current browser takes: a space for the T ("2026-09-27 10:00:00"), offsets without a colon (+0200), 1-digit
    // months and days. Since ES2015 a date-time without an offset is local time (a date alone stays UTC): times on
    // pages were two hours off, and "Invalid Date" broke others (sport.cz). Date and Date.parse read these forms here;
    // everything else goes to the engine's own parser.
    (function () {
        var ND = window.Date;
        if (!ND || ND.__brNative) return;
        var ISO = /^([+-]\d{6}|\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:(?:[Tt]|\s+)(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:([Zz])|([+-])(\d{2}):?(\d{2})?)?)?$/;
        var readDate = function (s) {
            var m = ISO.exec(s);
            if (!m) return ND.parse(s);
            var y = +m[1], mo = m[2] ? m[2] - 1 : 0, d = m[3] ? +m[3] : 1;
            var h = m[4] ? +m[4] : 0, mi = m[5] ? +m[5] : 0, sec = m[6] ? +m[6] : 0, ms = m[7] ? +(m[7] + '00').slice(0, 3) : 0;
            if (mo > 11 || d < 1 || d > 31 || h > 24 || mi > 59 || sec > 59 || (h === 24 && (mi || sec || ms))) return NaN;
            // UTC: an offset, or a date alone in the standard form; local: a date-time without an offset, or a date
            // alone written otherwise (2026-9-7, like the other browsers)
            var utc = m[8] || m[9] || (!m[4] && (!m[2] || m[2].length === 2) && (!m[3] || m[3].length === 2)), t;
            if (utc) {
                t = ND.UTC(y, mo, d, h, mi, sec, ms);
                if (y >= 0 && y < 100) { var u = new ND(t); u.setUTCFullYear(y); t = u.getTime(); }
                if (m[9]) t -= (m[9] === '-' ? -1 : 1) * (+m[10] * 60 + (m[11] ? +m[11] : 0)) * 60000;
            } else {
                var l = new ND(y, mo, d, h, mi, sec, ms);
                if (y >= 0 && y < 100) l.setFullYear(y);
                t = l.getTime();
            }
            return t;
        };
        var isDate = function (v) { return Object.prototype.toString.call(v) === '[object Date]'; };
        // (the try in a function of its own, and no getPrototypeOf for a plain new Date(): a function with a try costs
        // 2.3 us more on every call here, core-js's getPrototypeOf 1.4 - new Date() took 10.6 us, the engine's 2.4)
        var setProto = function (r, p) { try { r.__proto__ = p; } catch (e) {} };
        // (a declaration: it keeps its name, and a named function expression reads every outer variable through a
        // scope object of its own here, a microsecond and more per call)
        var D = Date;
        function Date(year, month, day, hours, minutes, seconds, ms) {
            if (!(this instanceof D)) return ND();   // (called as a function: the current time as text)
            var n = arguments.length, r;
            if (n === 0) r = new ND();
            else if (n === 1) {
                // (a date object keeps its milliseconds: the engine went through its text)
                r = typeof year === 'number' ? new ND(year) : typeof year === 'string' ? new ND(readDate(year)) : isDate(year) ? new ND(year.getTime()) : new ND(year);
            } else {
                // (as many arguments as given: a missing one is not undefined to the engine)
                switch (n) {
                    case 2: r = new ND(year, month); break;
                    case 3: r = new ND(year, month, day); break;
                    case 4: r = new ND(year, month, day, hours); break;
                    case 5: r = new ND(year, month, day, hours, minutes); break;
                    case 6: r = new ND(year, month, day, hours, minutes, seconds); break;
                    default: r = new ND(year, month, day, hours, minutes, seconds, ms);
                }
            }
            // (a subclass constructing: its prototype)
            if (this.constructor !== D) { var p = Object.getPrototypeOf(this); if (p !== D.prototype) setProto(r, p); }
            return r;
        }
        D.prototype = ND.prototype;
        D.parse = function parse(s) { return readDate(String(s)); };
        D.UTC = ND.UTC;
        D.now = ND.now;
        looksNative(D, 'Date');
        D.__brNative = ND;
        try { Object.defineProperty(ND.prototype, 'constructor', { value: D, writable: true, configurable: true, enumerable: false }); } catch (e1) { ND.prototype.constructor = D; }
        window.Date = D;
    })();

    // performance: the old engine has no Navigation/User Timing (iOS 8 brought them). Times are taken from here (the
    // polyfills run first in the page, so this is close to the start of the document): the network part of a
    // navigation is not known and counts as instant; the document's own moments are filled in as they happen.
    if (!window.performance) window.performance = {};
    var perf = window.performance, t0 = (perf.timing && perf.timing.navigationStart) || Date.now();
    if (!perf.now) perf.now = function () { return Date.now() - t0; };
    if (!perf.timeOrigin) perf.timeOrigin = t0;
    if (!perf.timing) {
        var timing = {}, T_FIELDS = ['navigationStart', 'unloadEventStart', 'unloadEventEnd', 'redirectStart', 'redirectEnd', 'fetchStart', 'domainLookupStart', 'domainLookupEnd',
                                     'connectStart', 'connectEnd', 'secureConnectionStart', 'requestStart', 'responseStart', 'responseEnd', 'domLoading', 'domInteractive',
                                     'domContentLoadedEventStart', 'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd'];
        for (var tf = 0; tf < T_FIELDS.length; tf++) timing[T_FIELDS[tf]] = /^(unload|redirect|secureConnection|dom[A-Z]|domContent|domComplete|loadEvent)/.test(T_FIELDS[tf]) ? 0 : t0;
        timing.domLoading = t0;
        timing.toJSON = function () { var o = {}; for (var i = 0; i < T_FIELDS.length; i++) o[T_FIELDS[i]] = this[T_FIELDS[i]]; return o; };
        perf.timing = timing;
        var stamp = function (names) { var now = Date.now(); for (var i = 0; i < names.length; i++) if (!timing[names[i]]) timing[names[i]] = now; };
        var interactive = function () { stamp(['domInteractive', 'domContentLoadedEventStart']); setTimeout(function () { stamp(['domContentLoadedEventEnd']); }, 0); };
        if (document.readyState === 'interactive' || document.readyState === 'complete') interactive();
        else document.addEventListener('DOMContentLoaded', interactive, false);
        window.addEventListener('load', function () { stamp(['domInteractive', 'domContentLoadedEventStart', 'domContentLoadedEventEnd', 'domComplete', 'loadEventStart']); setTimeout(function () { stamp(['loadEventEnd']); }, 0); }, false);
    }
    if (!perf.navigation) perf.navigation = { type: 0, redirectCount: 0, TYPE_NAVIGATE: 0, TYPE_RELOAD: 1, TYPE_BACK_FORWARD: 2, TYPE_RESERVED: 255, toJSON: function () { return { type: this.type, redirectCount: this.redirectCount }; } };
    // the entry interfaces (rohlik.cz: `entry instanceof PerformanceNavigationTiming` was a ReferenceError)
    var perfClass = function (name, parent) {
        if (window[name]) return window[name];
        var C = function () { throw new TypeError('Illegal constructor'); };
        try { C.prototype = Object.create(parent ? parent.prototype : Object.prototype); C.prototype.constructor = C; } catch (e) {}
        window[name] = C;
        return C;
    };
    var PerfEntry = perfClass('PerformanceEntry', null);
    var PerfResource = perfClass('PerformanceResourceTiming', PerfEntry);
    var PerfNavigation = perfClass('PerformanceNavigationTiming', PerfResource);
    var PerfMark = perfClass('PerformanceMark', PerfEntry);
    var PerfMeasure = perfClass('PerformanceMeasure', PerfEntry);
    perfClass('PerformancePaintTiming', PerfEntry);
    perfClass('PerformanceEventTiming', PerfEntry);
    perfClass('PerformanceLongTaskTiming', PerfEntry);
    perfClass('LargestContentfulPaint', PerfEntry);
    perfClass('LayoutShift', PerfEntry);
    perfClass('PerformanceObserverEntryList', null);
    var perfObject = function (C, fields) { var o; try { o = Object.create(C.prototype); } catch (e) { o = {}; } for (var k in fields) if (fields.hasOwnProperty(k)) o[k] = fields[k]; return o; };
    if (!perf.getEntries) {
        // User Timing (mark / measure) and a navigation entry made from the timing above
        var entries = [];
        var navigationEntry = function () {
            var t = perf.timing, rel = function (v) { return v ? v - t0 : 0; };
            var e = perfObject(PerfNavigation, { name: location.href, entryType: 'navigation', startTime: 0, initiatorType: 'navigation', type: 'navigate', redirectCount: 0,
                      workerStart: 0, redirectStart: 0, redirectEnd: 0, fetchStart: 0, domainLookupStart: 0, domainLookupEnd: 0, connectStart: 0, connectEnd: 0,
                      secureConnectionStart: 0, requestStart: 0, responseStart: 0, responseEnd: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0,
                      unloadEventStart: 0, unloadEventEnd: 0, domInteractive: rel(t.domInteractive), domContentLoadedEventStart: rel(t.domContentLoadedEventStart),
                      domContentLoadedEventEnd: rel(t.domContentLoadedEventEnd), domComplete: rel(t.domComplete), loadEventStart: rel(t.loadEventStart), loadEventEnd: rel(t.loadEventEnd),
                      nextHopProtocol: '', serverTiming: [] });
            e.duration = e.loadEventEnd;
            e.toJSON = function () { var o = {}; for (var k in this) if (typeof this[k] !== 'function') o[k] = this[k]; return o; };
            return e;
        };
        var all = function () { return [navigationEntry()].concat(entries); };
        perf.getEntries = function () { return all(); };
        perf.getEntriesByType = function (type) { var out = [], list = all(); for (var i = 0; i < list.length; i++) if (list[i].entryType === type) out.push(list[i]); return out; };
        perf.getEntriesByName = function (name, type) { var out = [], list = all(); for (var i = 0; i < list.length; i++) if (list[i].name === name && (!type || list[i].entryType === type)) out.push(list[i]); return out; };
        var entry = function (name, type, start, duration, detail) { return perfObject(type === 'mark' ? PerfMark : PerfMeasure, { name: String(name), entryType: type, startTime: start, duration: duration, detail: detail === undefined ? null : detail, toJSON: function () { return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration, detail: this.detail }; } }); };
        var timeOf = function (v) {
            if (typeof v === 'number') return v;
            if (typeof v === 'string') {
                for (var i = entries.length - 1; i >= 0; i--) if (entries[i].entryType === 'mark' && entries[i].name === v) return entries[i].startTime;
                if (perf.timing[v]) return perf.timing[v] - t0;
                throw new SyntaxError("Failed to execute 'measure': The mark '" + v + "' does not exist.");
            }
            return undefined;
        };
        perf.mark = function (name, opts) {
            var e = entry(name, 'mark', opts && typeof opts.startTime === 'number' ? opts.startTime : perf.now(), 0, opts && opts.detail);
            entries.push(e);
            if (entries.length > 2000) entries.shift();
            return e;
        };
        perf.measure = function (name, start, end) {
            var opts = start && typeof start === 'object' ? start : null, s, e2;
            if (opts) { s = timeOf(opts.start); e2 = opts.end !== undefined ? timeOf(opts.end) : opts.duration !== undefined && s !== undefined ? s + opts.duration : perf.now(); if (s === undefined) s = opts.duration !== undefined ? e2 - opts.duration : 0; }
            else { s = start === undefined ? 0 : timeOf(start); e2 = end === undefined ? perf.now() : timeOf(end); }
            var m = entry(name, 'measure', s, e2 - s, opts && opts.detail);
            entries.push(m);
            if (entries.length > 2000) entries.shift();
            return m;
        };
        var clear = function (type) { return function (name) { for (var i = entries.length - 1; i >= 0; i--) if (entries[i].entryType === type && (name === undefined || entries[i].name === name)) entries.splice(i, 1); }; };
        perf.clearMarks = clear('mark');
        perf.clearMeasures = clear('measure');
        perf.clearResourceTimings = function () {};
        perf.setResourceTimingBufferSize = function () {};
    }
    if (!perf.toJSON) perf.toJSON = function () { return { timeOrigin: perf.timeOrigin, timing: perf.timing && perf.timing.toJSON ? perf.timing.toJSON() : perf.timing, navigation: perf.navigation }; };
    if (!window.PerformanceObserver) {
        window.PerformanceObserver = function () {};
        window.PerformanceObserver.prototype.observe = function () {};
        window.PerformanceObserver.prototype.disconnect = function () {};
        window.PerformanceObserver.prototype.takeRecords = function () { return []; };
        window.PerformanceObserver.supportedEntryTypes = [];
    }

    // Element helpers
    if (Ep) {
        if (!Ep.matches) Ep.matches = Ep.webkitMatchesSelector || Ep.msMatchesSelector || function (s) {
            var list = (this.document || this.ownerDocument).querySelectorAll(s), i = list.length;
            while (--i >= 0 && list.item(i) !== this) {}
            return i > -1;
        };
        if (!Ep.closest) Ep.closest = function (s) { var el = this; while (el && el.nodeType === 1) { if (el.matches(s)) return el; el = el.parentNode; } return null; };
        var toNodes = function toNodes(args) {
            var frag = document.createDocumentFragment();
            for (var i = 0; i < args.length; i++) { var a = args[i]; frag.appendChild(a instanceof Node ? a : document.createTextNode(String(a))); }
            return frag;
        };
        var CN = [Ep, window.CharacterData && window.CharacterData.prototype, window.DocumentType && window.DocumentType.prototype];
        for (var c = 0; c < CN.length; c++) {
            var P = CN[c];
            if (!P) continue;
            if (!P.remove) P.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
            if (!P.before) P.before = function () { if (this.parentNode) this.parentNode.insertBefore(toNodes(arguments), this); };
            if (!P.after) P.after = function () { if (this.parentNode) this.parentNode.insertBefore(toNodes(arguments), this.nextSibling); };
            if (!P.replaceWith) P.replaceWith = function () { if (this.parentNode) this.parentNode.replaceChild(toNodes(arguments), this); };
        }
        var PN = [Ep, window.Document && window.Document.prototype, window.DocumentFragment && window.DocumentFragment.prototype];
        for (var p = 0; p < PN.length; p++) {
            var Q = PN[p];
            if (!Q) continue;
            if (!Q.append) Q.append = function () { this.appendChild(toNodes(arguments)); };
            if (!Q.prepend) Q.prepend = function () { this.insertBefore(toNodes(arguments), this.firstChild); };
            if (!Q.replaceChildren) Q.replaceChildren = function () { while (this.lastChild) this.removeChild(this.lastChild); this.appendChild(toNodes(arguments)); };
        }
        // ParentNode properties on fragments and documents, element siblings of text nodes (the old engine has them on
        // elements only): walkers of template.content and shadow roots met undefined (lit.dev's declarative shadow DOM
        // polyfill went through i = i.firstElementChild and then read i.tagName)
        var parentProps = {
            firstElementChild: function () { for (var c = this.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) return c; return null; },
            lastElementChild: function () { for (var c = this.lastChild; c; c = c.previousSibling) if (c.nodeType === 1) return c; return null; },
            childElementCount: function () { var n = 0; for (var c = this.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) n++; return n; },
            children: function () {
                var list = [];
                for (var c = this.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) list.push(c);
                list.item = function (i) { return this[i] || null; };
                return list;
            }
        };
        var siblingProps = {
            nextElementSibling: function () { for (var c = this.nextSibling; c; c = c.nextSibling) if (c.nodeType === 1) return c; return null; },
            previousElementSibling: function () { for (var c = this.previousSibling; c; c = c.previousSibling) if (c.nodeType === 1) return c; return null; }
        };
        var addProps = function (proto, probe, props) {
            if (!proto || !probe) return;
            for (var name in props) if (props.hasOwnProperty(name) && !(name in probe)) {
                try { Object.defineProperty(proto, name, { get: props[name], configurable: true, enumerable: true }); } catch (e) {}
            }
        };
        try {
            addProps(window.DocumentFragment && window.DocumentFragment.prototype, document.createDocumentFragment(), parentProps);
            addProps(window.Document && window.Document.prototype, document, parentProps);
            addProps(window.CharacterData && window.CharacterData.prototype, document.createTextNode(''), siblingProps);
        } catch (eParent) {}
        // SVG (and other non-HTML) elements: what the old engine has on HTML elements only and current browsers on every
        // element - children, classList, innerHTML/outerHTML, insertAdjacentHTML, tabIndex (o2.cz read i.children.length
        // of an <svg>; icon scripts toggle classes on <svg> and fill it by innerHTML). On Element.prototype: an HTML
        // element has the engine's own on itself and never gets there.
        (function () {
            var svg = document.createElementNS && document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            if (!svg) return;
            addProps(Ep, svg, { children: parentProps.children });
            var define = function (name, desc) {
                if (name in svg) return;
                desc.configurable = true;
                try { Object.defineProperty(Ep, name, desc); } catch (e) {}
            };
            // the class attribute as a token list (a snapshot with the methods writing the attribute back)
            var tokensOf = function (el) { var v = el.getAttribute('class'); v = v ? String(v).trim() : ''; return v ? v.split(/\s+/) : []; };
            var TL = {
                item: function (i) { return this[i] === undefined ? null : this[i]; },
                contains: function (t) { return tokensOf(this.__el).indexOf(String(t)) >= 0; },
                add: function () { var l = tokensOf(this.__el); for (var i = 0; i < arguments.length; i++) if (l.indexOf(String(arguments[i])) < 0) l.push(String(arguments[i])); this.__el.setAttribute('class', l.join(' ')); },
                remove: function () { var l = tokensOf(this.__el), out = [], i, k; for (i = 0; i < l.length; i++) { for (k = 0; k < arguments.length; k++) if (l[i] === String(arguments[k])) break; if (k === arguments.length) out.push(l[i]); } this.__el.setAttribute('class', out.join(' ')); },
                toggle: function (t, force) { var has = this.contains(t); if (force === undefined ? has : !force) { this.remove(t); return false; } this.add(t); return true; },
                replace: function (a, b) { var l = tokensOf(this.__el), i = l.indexOf(String(a)); if (i < 0) return false; l[i] = String(b); this.__el.setAttribute('class', l.join(' ')); return true; },
                supports: function () { return true; },
                forEach: function (fn, self) { var l = tokensOf(this.__el); for (var i = 0; i < l.length; i++) fn.call(self, l[i], i, this); },
                toString: function () { return this.__el.getAttribute('class') || ''; }
            };
            define('classList', { get: function () {
                var l = tokensOf(this), o = Object.create(TL);
                o.__el = this;
                for (var i = 0; i < l.length; i++) o[i] = l[i];
                o.length = l.length;
                o.value = this.getAttribute('class') || '';
                return o;
            } });
            // markup through the HTML parser, as an HTML document does it: inside <svg> it makes SVG elements
            var parse = function (html) {
                var box = document.createElement('div');
                box.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg">' + html + '</svg>';
                var frag = document.createDocumentFragment(), from = box.firstChild;
                while (from && from.firstChild) frag.appendChild(from.firstChild);
                return frag;
            };
            var serialize = function (nodes) {
                var box = document.createElement('div');
                for (var i = 0; i < nodes.length; i++) box.appendChild(nodes[i].cloneNode(true));
                return box.innerHTML;
            };
            define('innerHTML', {
                get: function () { var l = []; for (var c = this.firstChild; c; c = c.nextSibling) l.push(c); return serialize(l); },
                set: function (v) { var frag = parse(v === null ? '' : String(v)); while (this.firstChild) this.removeChild(this.firstChild); this.appendChild(frag); }
            });
            define('outerHTML', {
                get: function () { return serialize([this]); },
                set: function (v) { if (this.parentNode) this.parentNode.replaceChild(parse(String(v)), this); }
            });
            if (!svg.insertAdjacentHTML) Ep.insertAdjacentHTML = function (where, html) {
                var frag = parse(String(html)), w = String(where).toLowerCase();
                if (w === 'beforebegin') { if (this.parentNode) this.parentNode.insertBefore(frag, this); }
                else if (w === 'afterbegin') this.insertBefore(frag, this.firstChild);
                else if (w === 'beforeend') this.appendChild(frag);
                else if (w === 'afterend') { if (this.parentNode) this.parentNode.insertBefore(frag, this.nextSibling); }
                else throw new Error("SyntaxError: The value provided ('" + where + "') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or 'afterEnd'.");
            };
            define('tabIndex', {
                get: function () { var v = this.getAttribute('tabindex'); return v === null ? -1 : (parseInt(v, 10) || 0); },
                set: function (v) { this.setAttribute('tabindex', String(v)); }
            });
        })();
        if (!Ep.getAttributeNames) Ep.getAttributeNames = function () { var r = [], a = this.attributes; for (var i = 0; i < a.length; i++) r.push(a[i].name); return r; };
        if (!Ep.toggleAttribute) Ep.toggleAttribute = function (name, force) { var has = this.hasAttribute(name); if (force === undefined ? has : !force) { if (has) this.removeAttribute(name); return false; } this.setAttribute(name, ''); return true; };
        // classList.toggle(name, force) and classList.replace
        var probe = document.createElement('div');
        if (probe.classList) {
            probe.classList.toggle('a', false);
            if (probe.classList.contains('a')) {
                var origToggle = window.DOMTokenList.prototype.toggle;
                window.DOMTokenList.prototype.toggle = function (name, force) {
                    if (force === undefined) return origToggle.call(this, name);
                    if (force) { this.add(name); return true; }
                    this.remove(name); return false;
                };
            }
            if (!window.DOMTokenList.prototype.replace) window.DOMTokenList.prototype.replace = function (a, b) { if (!this.contains(a)) return false; this.remove(a); this.add(b); return true; };
        }
        if (!Ep.animate) {
            Ep.animate = function () {
                var anim = { playState: 'finished', currentTime: 0, playbackRate: 1, onfinish: null, oncancel: null,
                    cancel: function () {}, finish: function () {}, pause: function () {}, play: function () {}, reverse: function () {},
                    addEventListener: function () {}, removeEventListener: function () {} };
                anim.finished = window.Promise ? window.Promise.resolve(anim) : null;
                anim.ready = anim.finished;
                setTimeout(function () { if (typeof anim.onfinish === 'function') anim.onfinish({ target: anim }); }, 0);
                return anim;
            };
            Ep.getAnimations = function () { return []; };
        }
        if (!Ep.scrollIntoViewIfNeeded) Ep.scrollIntoViewIfNeeded = function () { this.scrollIntoView(); };
        var origScrollIntoView = Ep.scrollIntoView;
        Ep.scrollIntoView = function (arg) { if (arg && typeof arg === 'object') return origScrollIntoView.call(this, arg.block !== 'end'); return origScrollIntoView.apply(this, arguments); };
    }
    // scrollTo / scrollBy with an options object
    function wrapScroll(obj, name) {
        var orig = obj[name];
        if (typeof orig !== 'function') return;
        obj[name] = function (x, y) {
            if (x && typeof x === 'object') return orig.call(this, x.left || 0, x.top || 0);
            return orig.call(this, x, y);
        };
    }
    wrapScroll(window, 'scrollTo'); wrapScroll(window, 'scrollBy'); wrapScroll(window, 'scroll');
    if (Ep) { wrapScroll(Ep, 'scrollTo'); wrapScroll(Ep, 'scrollBy'); }

    // Object.defineProperty(fn, 'name' | 'length', ...): a function's name and length are fixed in the old engine
    // (today they are configurable, and bundlers rename functions and set their arity that way). Refused, they stay
    // as they are instead of the page's script failing ("Attempting to change value of a readonly property").
    // A string key that cannot be one of core-js's symbols (their keys read "Symbol(...)") on anything but
    // Object.prototype (core-js keeps a copy of what is defined there) goes to the engine's own defineProperty and
    // getOwnPropertyDescriptor, without core-js's checks in front (see page-prelude.js); Object.keys likewise (core-js's
    // symbols are never enumerable).
    (function () {
        var nativeDP = Object.defineProperty, nativeDPs = Object.defineProperties, N = window.__brNative || {};
        var engineDP = N.defineProperty !== nativeDP ? N.defineProperty : null, OP = Object.prototype;
        var probe = function f(a) {}, fixed = false;
        try { nativeDP(probe, 'length', { value: 2, configurable: true }); } catch (e) { fixed = true; }
        // (the checks written out, and the try in a function of its own: a call more costs a few microseconds here, and
        // a function with a try makes a scope object on every call)
        // (not even tried: the engine refuses every change of them with an exception, 125 us here - esbuild's keepNames
        // and TypeScript's __name helper name every function and class of a bundle that way)
        var fixedName = function (o) { return o; };
        // A non-enumerable data property under a core-js symbol (libraries mark their objects so: seznam.cz defined one
        // on 150 000 arrays, 6.5 s at 42 us each through core-js, which turns the symbol into its key string four times
        // over): what core-js does, written out - the key's string, the object's list of hidden (non-enumerable)
        // symbols, the engine's defineProperty. The list's own key is found once on a probe.
        var SymC = window.Symbol, HIDDEN = null, engineNames = N.getOwnPropertyNames, hasOwn = OP.hasOwnProperty;
        if (engineDP && engineNames && typeof SymC === 'function') {
            try {
                var ps = SymC('br-probe'), pobj = {};
                if (typeof ps === 'object') {
                    nativeDP(pobj, ps, { value: 1, writable: true, configurable: true });
                    var ptag = String(ps), pnames = engineNames(pobj);
                    for (var pi = 0; pi < pnames.length; pi++) {
                        var pv = pnames[pi] !== ptag ? pobj[pnames[pi]] : null;
                        if (pv && typeof pv === 'object' && pv[ptag] === true) HIDDEN = pnames[pi];
                    }
                    if (HIDDEN && (pobj[ps] !== 1 || !hasOwn.call(pobj, ptag))) HIDDEN = null;
                }
            } catch (eP) { HIDDEN = null; }
        }
        var hiddenSymbol = function (o, k, d) {
            var tag = String(k);
            if (!hasOwn.call(o, HIDDEN)) engineDP(o, HIDDEN, { value: Object.create(null), writable: true, configurable: true, enumerable: false });
            o[HIDDEN][tag] = true;
            return engineDP(o, tag, d);
        };
        // (a number key, an array index, is never a symbol: core-js's own createProperty, which a site's copy of core-js
        // uses for every item its concat/map/slice/splice replacements write, took the whole way round - seznam.cz: 140 000
        // items at 50 us, 7 s)
        if (fixed || engineDP) Object.defineProperty = function (o, k, d) {
            if (typeof k === 'string') {
                if (fixed && (k === 'name' || k === 'length') && typeof o === 'function') return fixedName(o, k, d);
                if (engineDP && k.charCodeAt(0) !== 83 && o !== OP) return engineDP(o, k, d);
            } else if (typeof k === 'number') {
                if (engineDP && o !== OP) return engineDP(o, k, d);
            } else if (HIDDEN && k instanceof SymC && o !== OP && o !== null && (typeof o === 'object' || typeof o === 'function') &&
                       d !== null && typeof d === 'object' && !d.enumerable && !d.get && !d.set) return hiddenSymbol(o, k, d);
            return nativeDP(o, k, d);
        };
        var nativeGOPD = Object.getOwnPropertyDescriptor, engineGOPD = N.getOwnPropertyDescriptor !== nativeGOPD ? N.getOwnPropertyDescriptor : null;
        if (engineGOPD) Object.getOwnPropertyDescriptor = function getOwnPropertyDescriptor(o, k) {
            if (((typeof k === 'string' && k.charCodeAt(0) !== 83) || typeof k === 'number') && o !== OP && o !== null && (typeof o === 'object' || typeof o === 'function')) return engineGOPD(o, k);
            return nativeGOPD(o, k);
        };
        var engineKeys = N.keys;
        if (engineKeys && Object.keys !== engineKeys) Object.keys = function keys(o) {
            if (typeof o === 'object' ? o !== null : typeof o === 'function') return engineKeys(o);
            if (o === null || o === undefined) throw new TypeError('Cannot convert undefined or null to object');
            return engineKeys(Object(o));
        };
        // A strict function's arguments and caller are its own properties here that throw "Type error" when read;
        // current engines have none on such functions (classes, strict and arrow functions). lidl.cz wrapped every
        // method of a class it found through Object.getOwnPropertyNames and read e[o] for each name.
        // (and the hidden records of the shims' Promise, Map/Set and the objects used as keys: not the page's)
        var namesOf = Object.getOwnPropertyNames, engineDesc = N.getOwnPropertyDescriptor || Object.getOwnPropertyDescriptor;
        var INTERNAL = { __brO: 1, __brP: 1, __brC: 1 };
        // (names straight from the engine also hold core-js's symbols and hidden keys, all named "Symbol(...)_...":
        // those go too, as core-js's own getOwnPropertyNames leaves them out)
        var withoutPoison = function (o, names, engine) {
            var fn = typeof o === 'function', out = null, nm, drop, c;
            for (var i = 0; i < names.length; i++) {
                nm = names[i];
                drop = false;
                if (typeof nm === 'string') {
                    c = nm.charCodeAt(0);
                    if (c === 95 && INTERNAL[nm] === 1) drop = true;
                    else if (c === 83 && engine && nm.lastIndexOf('Symbol(', 0) === 0) drop = true;
                    else if (fn && (nm === 'arguments' || nm === 'caller')) { var d = engineDesc(o, nm); if (d && d.get) drop = true; }
                }
                if (drop) { if (out === null) out = names.slice(0, i); }
                else if (out !== null) out.push(nm);
            }
            return out === null ? names : out;
        };
        // (an object's names from the engine: core-js's getOwnPropertyNames filters them with its own forEach in JS,
        // 25 us for {a: 1}; primitives still go its way, the engine's throws for them)
        var engineNamesOf = N.getOwnPropertyNames && N.getOwnPropertyNames !== namesOf ? N.getOwnPropertyNames : null;
        if (namesOf) Object.getOwnPropertyNames = function getOwnPropertyNames(o) {
            if (engineNamesOf !== null && o !== null && (typeof o === 'object' || typeof o === 'function')) return withoutPoison(o, engineNamesOf(o), true);
            return withoutPoison(o, namesOf(o), false);
        };
        // (core-js's Reflect.ownKeys took the names its own way: the same names here, then the symbols)
        var ownKeysOf = window.Reflect && window.Reflect.ownKeys;
        if (ownKeysOf) window.Reflect.ownKeys = function ownKeys(o) {
            if (engineNamesOf !== null && o !== null && (typeof o === 'object' || typeof o === 'function')) {
                var names = withoutPoison(o, engineNamesOf(o), true), syms = Object.getOwnPropertySymbols(o);
                return syms.length ? names.concat(syms) : names;
            }
            return withoutPoison(o, ownKeysOf(o), false);
        };
        // (Babel's object spread asks every object for its symbols: an object without a property named "Symbol(...",
        // as core-js names them, has none, which core-js found out calling two functions per property)
        var nativeGOPS = Object.getOwnPropertySymbols, engineNames = N.getOwnPropertyNames;
        // (one that has such properties - webpack gives every module's exports a Symbol.toStringTag - hands core-js a
        // stand-in with just those names, in their order, to find the symbols of)
        if (nativeGOPS && engineNames && engineNames !== Object.getOwnPropertyNames && engineDP) Object.getOwnPropertySymbols = function getOwnPropertySymbols(o) {
            if (o === OP || o === null || o === undefined) return nativeGOPS(o);
            var names = engineNames(Object(o)), some = null;
            for (var i = 0; i < names.length; i++) {
                if (names[i].charCodeAt(0) !== 83) continue;
                if (!some) some = {};
                engineDP(some, names[i], { value: true, configurable: true });
            }
            return some ? nativeGOPS(some) : [];
        };
        // JSON.stringify: core-js's (which its Symbol brings along) calls a replacer of its own for every value to leave
        // its symbols out, six times slower here. A symbol gets a toJSON that gives undefined instead, which the engine's
        // stringify then leaves out as the standard does, and lone surrogates are escaped afterwards (well-formed
        // JSON.stringify, which core-js added as well). At the top (key '') it gives {}: Object(symbol) is the symbol
        // itself here, and a page's own core-js checks that a boxed symbol turns into '{}' (else it puts its own in).
        var engineStringify = N.stringify, SymP = window.Symbol && window.Symbol.prototype;
        if (engineStringify && window.JSON && JSON.stringify !== engineStringify && SymP && typeof SymP === 'object') {
            try { nativeDP(SymP, 'toJSON', { value: function (key) { return key === '' ? {} : undefined; }, writable: true, configurable: true }); } catch (eS) { SymP = null; }
            var LONE = /[\uD800-\uDFFF]/g;
            var escapeLone = function (match, offset, string) {
                var c = match.charCodeAt(0), prev = string.charCodeAt(offset - 1), next = string.charCodeAt(offset + 1);
                var lead = c <= 0xDBFF;
                if ((lead && !(next >= 0xDC00 && next <= 0xDFFF)) || (!lead && !(prev >= 0xD800 && prev <= 0xDBFF))) return '\\u' + c.toString(16);
                return match;
            };
            // (this engine hands a replacer the index of an array item as a number)
            var stringKeys = function (replacer) { return function (k, v) { return replacer.call(this, String(k), v); }; };
            // (no function inside, no apply, no arguments: a function that makes a closure gets a scope object on every
            // call here, even when it makes none - the wrapper cost 6.6 us, the engine's stringify of a number 2.2)
            var SURROGATE = /[\uD800-\uDFFF]/;
            if (SymP) JSON.stringify = function stringify(value, replacer, space) {
                var out;
                if (typeof replacer === 'function') out = engineStringify(value, stringKeys(replacer), space);
                else out = replacer === undefined && space === undefined ? engineStringify(value) : engineStringify(value, replacer, space);
                return typeof out === 'string' && SURROGATE.test(out) ? out.replace(LONE, escapeLone) : out;
            };
        }
        // Object.defineProperties: each property through the defineProperty above (the engine's for ordinary keys, a
        // function's name/length handled, core-js for its symbols), the symbols among the descriptors through the
        // getOwnPropertySymbols above. core-js's own went through its symbol machinery in JS for every key: 357 us a
        // call on seznam.cz (1308 calls in its DOMContentLoaded handler).
        // (core-js's propertyIsEnumerable for its symbols: to the engine their properties are all non-enumerable)
        var own = Object.prototype.hasOwnProperty, pieDP = Object.prototype.propertyIsEnumerable;
        if (engineKeys) Object.defineProperties = function (o, props) {
            if (o === null || (typeof o !== 'object' && typeof o !== 'function')) throw new TypeError('Object.defineProperties called on non-object');
            if (props === null || props === undefined) throw new TypeError('Cannot convert undefined or null to object');
            var P = Object(props), keys = engineKeys(P), dp = Object.defineProperty, i;
            for (i = 0; i < keys.length; i++) dp(o, keys[i], P[keys[i]]);
            var syms = Object.getOwnPropertySymbols ? Object.getOwnPropertySymbols(P) : [];
            for (i = 0; i < syms.length; i++) if (pieDP.call(P, syms[i])) dp(o, syms[i], P[syms[i]]);
            return o;
        };
        else if (fixed) Object.defineProperties = function (o, props) {
            if (typeof o !== 'function' || !props || !(own.call(props, 'name') || own.call(props, 'length'))) return nativeDPs(o, props);
            var rest = {}, k;
            for (k in props) if (own.call(props, k)) { if (k === 'name' || k === 'length') Object.defineProperty(o, k, props[k]); else rest[k] = props[k]; }
            return nativeDPs(o, rest);
        };
    })();

    // Array methods as a page's own core-js tests them, with the engine's own doing the work. Failing its tests, a legacy
    // bundle's core-js replaced them with JS versions: push (core-js 3.26 on, in nearly every such bundle) wrote every
    // item and asked for the length's descriptor on each call; concat, map, filter, slice and splice wrote every item
    // through Object.defineProperty (seznam.cz: 140 000 of them, 7 s); sort became a merge sort in JS. The tests ask for
    // the constructor's Symbol.species (the kind of array made), Symbol.isConcatSpreadable, an array-like's length past
    // 2^32 - 1, a TypeError for push()/unshift() on a read-only length and for sort(null). An ordinary array takes the
    // engine's own method after a check or two. (tools/babel-test/corejs-replace.html lists what core-js replaces.)
    (function () {
        var AP = Array.prototype, S = window.Symbol, N = window.__brNative || {}, isArray = Array.isArray;
        if (!isArray || AP.push.__brAP) return;
        var def = N.defineProperty || Object.defineProperty, gopd = N.getOwnPropertyDescriptor || Object.getOwnPropertyDescriptor;
        var put = function (A, i, v) { def(A, i, { value: v, writable: true, enumerable: true, configurable: true }); };
        var toLen = function (v) { v = +v; return v > 0 ? (v > 9007199254740991 ? 9007199254740991 : Math.floor(v)) : 0; };
        var toInt = function (v) { v = +v; return v !== v ? 0 : v < 0 ? Math.ceil(v) : Math.floor(v); };
        var rel = function (v, len) { var r = toInt(v); return r < 0 ? Math.max(len + r, 0) : Math.min(r, len); };
        var readOnly = function (o) { var d = gopd(o, 'length'); return !!d && d.writable === false; };
        var LENGTH_RO = 'Cannot assign to read only property \'length\' of object \'[object Array]\'';
        var nPush = AP.push, nUnshift = AP.unshift, nSort = AP.sort;
        AP.push = function push(item) {
            var n = arguments.length;
            if (isArray(this)) {
                if (n === 0 && readOnly(this)) throw new TypeError(LENGTH_RO);
                return n === 1 ? nPush.call(this, item) : nPush.apply(this, arguments);
            }
            // (the engine counts an array-like's length modulo 2^32)
            var O = Object(this), len = toLen(O.length);
            if (len + n < 4294967295) return nPush.apply(O, arguments);
            for (var i = 0; i < n; i++) O[len + i] = arguments[i];
            O.length = len + n;
            return len + n;
        };
        AP.push.__brAP = true;
        AP.unshift = function unshift(item) {
            if (arguments.length === 0 && isArray(this) && readOnly(this)) throw new TypeError(LENGTH_RO);
            return nUnshift.apply(this, arguments);
        };
        AP.sort = function sort(comparefn) {
            if (this === null || this === undefined) throw new TypeError('Array.prototype.sort called on null or undefined');
            if (comparefn !== undefined && typeof comparefn !== 'function') throw new TypeError('The comparison function must be either a function or undefined');
            return comparefn === undefined ? nSort.call(this) : nSort.call(this, comparefn);
        };
        var SPECIES = S && S.species, SPREAD = S && S.isConcatSpreadable;
        if (!SPECIES || !SPREAD) return;
        // (their keys as strings: a lookup by a polyfilled symbol turns it into that string every time)
        var SK = typeof SPECIES === 'symbol' ? SPECIES : String(SPECIES), CK = typeof SPREAD === 'symbol' ? SPREAD : String(SPREAD);
        // the constructor ArraySpeciesCreate uses for an array whose constructor is not Array; undefined: a plain array
        // (an Array of any realm: its prototype is an array itself)
        var speciesOf = function (o) {
            var C = o.constructor;
            if (C !== null && (typeof C === 'object' || typeof C === 'function')) { C = C[SK]; if (C === null) C = undefined; }
            return C === undefined || C === Array || (typeof C === 'function' && isArray(C.prototype)) ? undefined : C;
        };
        var special = function (o) { return o !== null && o !== undefined && o.constructor !== Array && isArray(o) ? speciesOf(o) : undefined; };
        var spreadable = function (e) {
            if (e === null || (typeof e !== 'object' && typeof e !== 'function')) return false;
            var s = e[CK];
            return s !== undefined ? !!s : isArray(e);
        };
        var nConcat = AP.concat, nMap = AP.map, nFilter = AP.filter, nSlice = AP.slice, nSplice = AP.splice;
        AP.concat = function concat(a) {
            var n = arguments.length, i, C = special(this), plain = C === undefined && (this === null || this === undefined || this[CK] === undefined);
            for (i = 0; plain && i < n; i++) { var e = arguments[i]; if (e !== null && typeof e === 'object' && e[CK] !== undefined) plain = false; }
            if (plain) return n === 1 ? nConcat.call(this, a) : nConcat.apply(this, arguments);
            var O = Object(this), A = C === undefined ? [] : new C(0), k = 0, j, len, E;
            for (i = -1; i < n; i++) {
                E = i < 0 ? O : arguments[i];
                if (spreadable(E)) { len = toLen(E.length); for (j = 0; j < len; j++, k++) if (j in E) put(A, k, E[j]); }
                else put(A, k++, E);
            }
            A.length = k;
            return A;
        };
        AP.map = function map(fn, thisArg) {
            var C = special(this);
            if (C === undefined) return nMap.call(this, fn, thisArg);
            if (typeof fn !== 'function') throw new TypeError(fn + ' is not a function');
            var len = toLen(this.length), A = new C(len);
            for (var k = 0; k < len; k++) if (k in this) put(A, k, fn.call(thisArg, this[k], k, this));
            return A;
        };
        AP.filter = function filter(fn, thisArg) {
            var C = special(this);
            if (C === undefined) return nFilter.call(this, fn, thisArg);
            if (typeof fn !== 'function') throw new TypeError(fn + ' is not a function');
            var len = toLen(this.length), A = new C(0), to = 0;
            for (var k = 0; k < len; k++) if (k in this) { var v = this[k]; if (fn.call(thisArg, v, k, this)) put(A, to++, v); }
            return A;
        };
        AP.slice = function slice(start, end) {
            var C = special(this);
            if (C === undefined) return nSlice.call(this, start, end);
            var len = toLen(this.length), k = rel(start, len), fin = end === undefined ? len : rel(end, len), A = new C(Math.max(fin - k, 0)), n = 0;
            for (; k < fin; k++, n++) if (k in this) put(A, n, this[k]);
            A.length = n;
            return A;
        };
        AP.splice = function splice(start, deleteCount) {
            var C = special(this), removed = nSplice.apply(this, arguments);
            if (C === undefined) return removed;
            var A = new C(removed.length);
            for (var i = 0; i < removed.length; i++) put(A, i, removed[i]);
            A.length = removed.length;
            return A;
        };
    })();
    // parseInt / parseFloat of a symbol throw, as a string of one does: core-js checks that (with a polyfilled symbol,
    // which turns into its key string) and, failing, put its own parseInt / parseFloat around the engine's (trim and a
    // regular expression per call). Number.parseInt / parseFloat stay the same functions.
    (function () {
        var SymC = window.Symbol, nPI = window.parseInt, nPF = window.parseFloat;
        if (typeof SymC !== 'function' || typeof SymC() !== 'object' || nPI.__brSym) return;
        var SYM_TO_STRING = 'Cannot convert a Symbol value to a string';
        window.parseInt = function parseInt(s, radix) {
            if (s !== null && typeof s === 'object' && s instanceof SymC) throw new TypeError(SYM_TO_STRING);
            return nPI(s, radix);
        };
        window.parseInt.__brSym = true;
        window.parseFloat = function parseFloat(s) {
            if (s !== null && typeof s === 'object' && s instanceof SymC) throw new TypeError(SYM_TO_STRING);
            return nPF(s);
        };
        // (the same functions, as the standard has them: our core-js had put JS versions there, failing the symbol check)
        Number.parseInt = window.parseInt;
        Number.parseFloat = window.parseFloat;
    })();
    // Map, Set, WeakMap and WeakSet, lean, in place of core-js's (new Map 25 us, get/has 6.5, set 9.5; new WeakMap with a
    // set and a get 47 us here). Entries in insertion order as a linked list (iterators and forEach go on across deletions
    // and see what is added meanwhile); keys found through dictionaries by kind: strings, numbers (-0 is 0, NaN is NaN),
    // the rest of the primitives, and objects by an id in one hidden record per object (__brO, made once, which also keeps
    // the values of the weak maps it is a key of: the weak maps themselves hold nothing). An object that takes no more
    // properties (frozen) goes to a short list of its own.
    (function () {
        var N = window.__brNative || {}, OldMap = window.Map;
        if (!OldMap || OldMap.__brLean) return;
        var def = N.defineProperty || Object.defineProperty, S = window.Symbol, isExt = Object.isExtensible;
        var keyOf = function (sym) { return !sym ? null : typeof sym === 'symbol' ? sym : String(sym); };
        var ITER = keyOf(S && S.iterator);
        var hide = function (o, k, v) { def(o, k, { value: v, writable: true, configurable: true, enumerable: false }); };
        var seq = 0;
        // the hidden record of an object: {o, id, w (weak values by map id)}; null when it takes no more properties
        var recordOf = function (o, make) {
            var r = o.__brO;
            if (r !== undefined && r !== null && r.o === o) return r;
            if (!make || (isExt && !isExt(o))) return null;
            r = { o: o, id: ++seq, w: null };
            try { hide(o, '__brO', r); } catch (e) { return null; }
            return r;
        };
        var isObj = function (k) { return k !== null && (typeof k === 'object' || typeof k === 'function'); };
        // ---- Map and Set: a state record {first, last, size, s, n, m, o, f}
        var makeState = function () {
            return { first: null, last: null, size: 0, s: Object.create(null), n: Object.create(null), m: Object.create(null), o: Object.create(null), f: [] };
        };
        var stateOf = function (x, kind) {
            var st = isObj(x) ? x.__brC : undefined;
            if (st === undefined || st === null || st.self !== x || st.kind !== kind) throw new TypeError('Method ' + kind + '.prototype function called on incompatible receiver ' + x);
            return st;
        };
        var find = function (st, k) {
            switch (typeof k) {
                case 'string': return st.s[k];
                case 'number': return st.n['' + k];
                case 'object': case 'function':
                    if (k === null) return st.m['null'];
                    var r = recordOf(k, false);
                    if (r !== null) return st.o[r.id];
                    for (var i = 0; i < st.f.length; i++) if (st.f[i].k === k) return st.f[i];
                    return undefined;
                // (an engine's own symbols - a desktop browser running these shims: they cannot become text)
                case 'symbol': return st.y !== undefined ? st.y[k] : undefined;
                default: return st.m[typeof k + ':' + k];
            }
        };
        var index = function (st, k, e, add) {
            switch (typeof k) {
                case 'string': if (add) st.s[k] = e; else delete st.s[k]; return;
                case 'number': if (add) st.n['' + k] = e; else delete st.n['' + k]; return;
                case 'object': case 'function':
                    if (k === null) { if (add) st.m['null'] = e; else delete st.m['null']; return; }
                    var r = recordOf(k, add);
                    if (r !== null) { if (add) st.o[r.id] = e; else delete st.o[r.id]; return; }
                    if (add) st.f.push(e);
                    else for (var i = 0; i < st.f.length; i++) if (st.f[i] === e) { st.f.splice(i, 1); break; }
                    return;
                case 'symbol':
                    if (add) { if (st.y === undefined) st.y = {}; st.y[k] = e; } else if (st.y !== undefined) delete st.y[k];
                    return;
                default: if (add) st.m[typeof k + ':' + k] = e; else delete st.m[typeof k + ':' + k];
            }
        };
        var add = function (st, k, v) {
            var e = find(st, k);
            if (e !== undefined) { e.v = v; return; }
            if (k === 0) k = 0;   // (-0 becomes +0)
            e = { k: k, v: v, next: null, prev: st.last, removed: false };
            if (st.last !== null) st.last.next = e; else st.first = e;
            st.last = e;
            st.size++;
            index(st, k, e, true);
        };
        var remove = function (st, k) {
            var e = find(st, k);
            if (e === undefined) return false;
            index(st, k, e, false);
            e.removed = true;
            // (unlinked, but its next stays: an iterator standing on it goes on from there)
            if (e.prev !== null) e.prev.next = e.next; else st.first = e.next;
            if (e.next !== null) e.next.prev = e.prev; else st.last = e.prev;
            st.size--;
            return true;
        };
        var clearAll = function (st) {
            for (var e = st.first; e !== null; e = e.next) e.removed = true;
            st.first = st.last = null;
            st.size = 0;
            st.s = Object.create(null); st.n = Object.create(null); st.m = Object.create(null); st.o = Object.create(null); st.f = []; st.y = undefined;
        };
        // iterators: kind 0 keys, 1 values, 2 entries. Each kind's prototype holds next itself and sits right below
        // %IteratorPrototype% (core-js's, with the iterator helpers map, filter, toArray...), as the native ones do: a
        // page's own core-js sets the prototype of every Map/Set iterator prototype it finds to %IteratorPrototype%, so
        // a shared level between the two lost next ("e.next is not a function" on seznam and duckduckgo)
        var IterProto = null;
        try { if (ITER !== null) IterProto = Object.getPrototypeOf(Object.getPrototypeOf([][ITER]())); } catch (eI) { IterProto = null; }
        var next = function next() {
            if (this.__done) return { value: undefined, done: true };
            var e = this.__cur === null ? this.__st.first : this.__cur.next;
            while (e !== null && e.removed) e = e.next;
            if (e === null) { this.__done = true; this.__st = null; return { value: undefined, done: true }; }
            this.__cur = e;
            return { value: this.__kind === 0 ? e.k : this.__kind === 1 ? e.v : [e.k, e.v], done: false };
        };
        var self = function () { return this; };
        var TAG = S && S.toStringTag;
        var tagged = function (o, name) { if (TAG) try { Object.defineProperty(o, TAG, { value: name, configurable: true }); } catch (e) {} };
        // (the tag each kind of iterator reads as: "[object Map Iterator]")
        var iterProto = function (tag) {
            var p = IterProto ? Object.create(IterProto) : {};
            hide(p, 'next', next);
            if (ITER !== null) hide(p, ITER, self);
            hide(p, '@@iterator', self);
            tagged(p, tag);
            return p;
        };
        var MapIter = function (st, kind) { this.__st = st; this.__cur = null; this.__kind = kind; this.__done = false; };
        MapIter.prototype = iterProto('Map Iterator');
        var SetIter = function (st, kind) { this.__st = st; this.__cur = null; this.__kind = kind; this.__done = false; };
        SetIter.prototype = iterProto('Set Iterator');
        // fill from an iterable: arrays directly, others step by step (closed when adding throws). An arguments object is
        // iterable today and has no iterator here: taken like an array (Facebook's `new Set(arguments)`: "[object
        // Arguments] is not iterable", the page stayed empty)
        var fill = function (target, iterable, pairs) {
            if (iterable === null || iterable === undefined) return;
            var adder = pairs ? target.set : target.add;
            if (typeof adder !== 'function') throw new TypeError("'" + (pairs ? 'set' : 'add') + "' returned for property is not a function");
            var list = Array.isArray(iterable) || (typeof iterable === 'object' && Object.prototype.toString.call(iterable) === '[object Arguments]') ? iterable : null, i, it = null, step, item;
            if (list === null) {
                var getIt = ITER !== null ? iterable[ITER] : undefined;
                if ((getIt === undefined || getIt === null) && typeof iterable['@@iterator'] === 'function') getIt = iterable['@@iterator'];
                if (typeof getIt !== 'function') throw new TypeError(iterable + ' is not iterable');
                it = getIt.call(iterable);
            }
            for (i = 0; ; i++) {
                if (list !== null) { if (i >= list.length) break; item = list[i]; }
                else { step = it.next(); if (step.done) break; item = step.value; }
                if (pairs) {
                    if (!isObj(item)) {
                        if (it && typeof it['return'] === 'function') it['return']();
                        throw new TypeError('Iterator value ' + item + ' is not an entry object');
                    }
                    adder.call(target, item[0], item[1]);
                } else adder.call(target, item);
            }
        };
        var construct = function (self, C, kind) {
            if (!(self instanceof C) || (isObj(self) && self.__brC !== undefined && self.__brC !== null && self.__brC.self === self)) throw new TypeError("Constructor " + kind + " requires 'new'");
            var st = makeState();
            st.self = self;
            st.kind = kind;
            hide(self, '__brC', st);
            return st;
        };
        // (the constructors as declarations: they keep their names, and a named function expression reads every outer
        // variable through a scope object of its own here, a microsecond and more per call)
        var M = Map, St = Set, WM = WeakMap, WS = WeakSet;
        function Map(iterable) {
            construct(this, M, 'Map');
            if (iterable !== null && iterable !== undefined) fill(this, iterable, true);
        }
        var MP = M.prototype;
        hide(MP, 'get', function get(k) { var e = find(stateOf(this, 'Map'), k); return e === undefined ? undefined : e.v; });
        hide(MP, 'set', function set(k, v) { add(stateOf(this, 'Map'), k, v); return this; });
        hide(MP, 'has', function has(k) { return find(stateOf(this, 'Map'), k) !== undefined; });
        hide(MP, 'delete', function (k) { return remove(stateOf(this, 'Map'), k); });
        hide(MP, 'clear', function clear() { clearAll(stateOf(this, 'Map')); });
        // (the loop written out: no closure, no call more per entry)
        hide(MP, 'forEach', function forEach(fn, thisArg) {
            var st = stateOf(this, 'Map');
            if (typeof fn !== 'function') throw new TypeError(fn + ' is not a function');
            for (var e = st.first; e !== null; e = e.next) if (!e.removed) fn.call(thisArg, e.v, e.k, this);
        });
        hide(MP, 'keys', function () { return new MapIter(stateOf(this, 'Map'), 0); });
        hide(MP, 'values', function () { return new MapIter(stateOf(this, 'Map'), 1); });
        hide(MP, 'entries', function () { return new MapIter(stateOf(this, 'Map'), 2); });
        if (ITER !== null) hide(MP, ITER, MP.entries);
        hide(MP, '@@iterator', MP.entries);
        def(MP, 'size', { get: function () { return stateOf(this, 'Map').size; }, configurable: true, enumerable: false });
        hide(MP, 'getOrInsert', function getOrInsert(k, v) { var st = stateOf(this, 'Map'), e = find(st, k); if (e !== undefined) return e.v; add(st, k, v); return v; });
        hide(MP, 'getOrInsertComputed', function getOrInsertComputed(k, fn) {
            var st = stateOf(this, 'Map'), e = find(st, k);
            if (typeof fn !== 'function') throw new TypeError(fn + ' is not a function');
            if (e !== undefined) return e.v;
            var v = fn(k);
            add(st, k, v);
            return v;
        });
        tagged(MP, 'Map');
        hide(M, 'groupBy', function groupBy(items, fn) {
            var out = new M(), i = 0;
            if (typeof fn !== 'function') throw new TypeError(fn + ' is not a function');
            Array.from(items).forEach(function (v) { var k = fn(v, i++), list = out.get(k); if (list === undefined) out.set(k, [v]); else list.push(v); });
            return out;
        });
        function Set(iterable) {
            construct(this, St, 'Set');
            if (iterable !== null && iterable !== undefined) fill(this, iterable, false);
        }
        var SP = St.prototype;
        hide(SP, 'add', function add2(v) { var st = stateOf(this, 'Set'); if (find(st, v) === undefined) add(st, v, v); return this; });
        hide(SP, 'has', function has(v) { return find(stateOf(this, 'Set'), v) !== undefined; });
        hide(SP, 'delete', function (v) { return remove(stateOf(this, 'Set'), v); });
        hide(SP, 'clear', function clear() { clearAll(stateOf(this, 'Set')); });
        hide(SP, 'forEach', function forEach(fn, thisArg) {
            var st = stateOf(this, 'Set');
            if (typeof fn !== 'function') throw new TypeError(fn + ' is not a function');
            for (var e = st.first; e !== null; e = e.next) if (!e.removed) fn.call(thisArg, e.k, e.k, this);
        });
        // (named "values": a page's own core-js checks that name before it keeps Set's iterators)
        function values() { return new SetIter(stateOf(this, 'Set'), 0); }
        hide(SP, 'values', values);
        hide(SP, 'keys', SP.values);
        hide(SP, 'entries', function () { return new SetIter(stateOf(this, 'Set'), 2); });
        if (ITER !== null) hide(SP, ITER, SP.values);
        hide(SP, '@@iterator', SP.values);
        def(SP, 'size', { get: function () { return stateOf(this, 'Set').size; }, configurable: true, enumerable: false });
        tagged(SP, 'Set');
        // the set methods (ES2025) over the other's size, has and keys
        var setRecord = function (o) {
            if (!isObj(o)) throw new TypeError('The argument must be an object');
            var size = +o.size;
            if (size !== size) throw new TypeError("The 'size' property must be a number");
            if (typeof o.has !== 'function' || typeof o.keys !== 'function') throw new TypeError('The argument must have has and keys methods');
            return o;
        };
        var otherKeys = function (o, fn) {
            var it = o.keys(), step;
            while (!(step = it.next()).done) if (fn(step.value) === false) { if (typeof it['return'] === 'function') it['return'](); return; }
        };
        var copyOf = function (set) { var out = new St(); set.forEach(function (v) { out.add(v); }); return out; };
        hide(SP, 'union', function union(other) { var o = setRecord(other), out = copyOf(this); otherKeys(o, function (v) { out.add(v); }); return out; });
        hide(SP, 'intersection', function intersection(other) { var o = setRecord(other), out = new St(); this.forEach(function (v) { if (o.has(v)) out.add(v); }); return out; });
        hide(SP, 'difference', function difference(other) { var o = setRecord(other), out = new St(); this.forEach(function (v) { if (!o.has(v)) out.add(v); }); return out; });
        hide(SP, 'symmetricDifference', function symmetricDifference(other) {
            var o = setRecord(other), me = this, out = copyOf(this);
            otherKeys(o, function (v) { if (me.has(v)) out['delete'](v); else out.add(v); });
            return out;
        });
        hide(SP, 'isSubsetOf', function isSubsetOf(other) { var o = setRecord(other), ok = true; this.forEach(function (v) { if (ok && !o.has(v)) ok = false; }); return ok; });
        hide(SP, 'isSupersetOf', function isSupersetOf(other) { var o = setRecord(other), me = this, ok = true; otherKeys(o, function (v) { if (!me.has(v)) { ok = false; return false; } }); return ok; });
        hide(SP, 'isDisjointFrom', function isDisjointFrom(other) { var o = setRecord(other), ok = true; this.forEach(function (v) { if (ok && o.has(v)) ok = false; }); return ok; });
        // ---- WeakMap and WeakSet: each has an id; the values sit in the key's own record (w), frozen keys in a list
        var wseq = 0;
        var weakState = function (x, kind) {
            var st = isObj(x) ? x.__brC : undefined;
            if (st === undefined || st === null || st.self !== x || st.kind !== kind) throw new TypeError('Method ' + kind + '.prototype function called on incompatible receiver ' + x);
            return st;
        };
        var weakKey = function (k, kind) { if (!isObj(k)) throw new TypeError('Invalid value used ' + (kind === 'WeakSet' ? 'in weak set' : 'as weak map key')); };
        var wFind = function (st, k) { for (var i = 0; i < st.f.length; i += 2) if (st.f[i] === k) return i; return -1; };
        var wGet = function (st, k) {
            if (!isObj(k)) return undefined;
            var r = recordOf(k, false);
            if (r !== null) return r.w === null ? undefined : r.w[st.id];
            var i = wFind(st, k);
            return i < 0 ? undefined : st.f[i + 1];
        };
        var wHas = function (st, k) {
            if (!isObj(k)) return false;
            var r = recordOf(k, false);
            if (r !== null) return r.w !== null && st.id in r.w;
            return wFind(st, k) >= 0;
        };
        var wSet = function (st, k, v) {
            var r = recordOf(k, true);
            if (r !== null) { if (r.w === null) r.w = Object.create(null); r.w[st.id] = v; return; }
            var i = wFind(st, k);
            if (i >= 0) st.f[i + 1] = v; else st.f.push(k, v);
        };
        var wDelete = function (st, k) {
            if (!isObj(k)) return false;
            var r = recordOf(k, false);
            if (r !== null) { if (r.w === null || !(st.id in r.w)) return false; delete r.w[st.id]; return true; }
            var i = wFind(st, k);
            if (i < 0) return false;
            st.f.splice(i, 2);
            return true;
        };
        var weakConstruct = function (self, C, kind) {
            if (!(self instanceof C) || (isObj(self) && self.__brC !== undefined && self.__brC !== null && self.__brC.self === self)) throw new TypeError("Constructor " + kind + " requires 'new'");
            var st = { self: self, kind: kind, id: 'w' + (++wseq), f: [] };
            hide(self, '__brC', st);
            return st;
        };
        function WeakMap(iterable) {
            weakConstruct(this, WM, 'WeakMap');
            if (iterable !== null && iterable !== undefined) fill(this, iterable, true);
        }
        var WMP = WM.prototype;
        hide(WMP, 'get', function get(k) { return wGet(weakState(this, 'WeakMap'), k); });
        hide(WMP, 'set', function set(k, v) { var st = weakState(this, 'WeakMap'); weakKey(k, 'WeakMap'); wSet(st, k, v); return this; });
        hide(WMP, 'has', function has(k) { return wHas(weakState(this, 'WeakMap'), k); });
        hide(WMP, 'delete', function (k) { return wDelete(weakState(this, 'WeakMap'), k); });
        tagged(WMP, 'WeakMap');
        function WeakSet(iterable) {
            weakConstruct(this, WS, 'WeakSet');
            if (iterable !== null && iterable !== undefined) fill(this, iterable, false);
        }
        var WSP = WS.prototype;
        hide(WSP, 'add', function add3(v) { var st = weakState(this, 'WeakSet'); weakKey(v, 'WeakSet'); wSet(st, v, true); return this; });
        hide(WSP, 'has', function has(v) { return wHas(weakState(this, 'WeakSet'), v); });
        hide(WSP, 'delete', function (v) { return wDelete(weakState(this, 'WeakSet'), v); });
        tagged(WSP, 'WeakSet');
        var nativeLooking = function (C, name) {
            var sp = S && S.species;
            if (sp) try { Object.defineProperty(C, sp, { get: function () { return this; }, configurable: true }); } catch (e) {}
            C.__brLean = true;
            looksNative(C, name);
        };
        nativeLooking(M, 'Map'); nativeLooking(St, 'Set'); nativeLooking(WM, 'WeakMap'); nativeLooking(WS, 'WeakSet');
        try { window.Map = M; window.Set = St; window.WeakMap = WM; window.WeakSet = WS; } catch (eG) {}
        shareSources();
    })();

    // Lean versions of the ES2015+ methods pages call all the time, in place of core-js's: its general helpers cost
    // microseconds each here (ToString asks every value's class, a bound call per string function), so that
    // 'abc'.startsWith('a') took 30 us, includes 24 us, padStart 48 us, Object.entries 36 us and Array.from of eight
    // items 180 us (YouTube: 33 000 startsWith, 1.5 s). They keep what core-js's feature tests ask (IsRegExp through
    // Symbol.match, holes read as undefined, iterators closed, fromCodePoint.length 1, assign reading enumerability as
    // it goes), so a page's own copy of core-js keeps them.
    (function () {
        var SP = String.prototype, AP = Array.prototype, S = window.Symbol, N = window.__brNative || {};
        if (SP.startsWith && SP.startsWith.__brLean) return;
        var isArray = Array.isArray, toStr0 = Object.prototype.toString, nIndexOf = AP.indexOf, SymC = typeof S === 'function' ? S : null;
        var keyOf = function (sym) { return !sym ? null : typeof sym === 'symbol' ? sym : String(sym); };
        var MATCH = keyOf(S && S.match), ITER = keyOf(S && S.iterator);
        var def = N.defineProperty || Object.defineProperty, pie = N.propertyIsEnumerable || Object.prototype.propertyIsEnumerable;
        var hidden = function (o, k, fn) { fn.__brLean = true; def(o, k, { value: fn, writable: true, configurable: true, enumerable: false }); };
        var toInt = function (v) { v = +v; return v !== v ? 0 : v === Infinity || v === -Infinity ? v : v < 0 ? Math.ceil(v) : Math.floor(v); };
        var toLen = function (v) { v = toInt(v); return v > 0 ? (v > 9007199254740991 ? 9007199254740991 : v) : 0; };
        var thisStr = function (v, name) {
            if (v === null || v === undefined) throw new TypeError('String.prototype.' + name + ' called on null or undefined');
            return typeof v === 'string' ? v : String(v);
        };
        // ToString of an argument: a (polyfilled) symbol throws
        var argStr = function (v) {
            if (typeof v === 'string') return v;
            if (SymC && v !== null && typeof v === 'object' && v instanceof SymC) throw new TypeError('Cannot convert a Symbol value to a string');
            return String(v);
        };
        var notRegExp = function (v, name) {
            if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return;
            var m = MATCH !== null ? v[MATCH] : undefined;
            if (m !== undefined ? !!m : toStr0.call(v) === '[object RegExp]') throw new TypeError('First argument to String.prototype.' + name + ' must not be a regular expression');
        };
        var thisObj = function (v, name) {
            if (v === null || v === undefined) throw new TypeError('Array.prototype.' + name + ' called on null or undefined');
            return Object(v);
        };
        var callable = function (fn) { if (typeof fn !== 'function') throw new TypeError(fn + ' is not a function'); };
        // (the common call first, a string with a string and nothing else, written out: every call and every read of
        // arguments[i] costs here)
        hidden(SP, 'startsWith', function startsWith(search) {
            var s = this, t = search, p = 0;
            if (typeof s !== 'string') s = thisStr(s, 'startsWith');
            if (typeof t !== 'string') { notRegExp(t, 'startsWith'); t = argStr(t); }
            if (arguments.length > 1) { p = toInt(arguments[1]); if (p < 0) p = 0; else if (p > s.length) p = s.length; }
            return s.length - p >= t.length && (p === 0 && t.length === 1 ? s.charAt(0) === t : s.substr(p, t.length) === t);
        });
        hidden(SP, 'endsWith', function endsWith(search) {
            var s = this, t = search, end;
            if (typeof s !== 'string') s = thisStr(s, 'endsWith');
            if (typeof t !== 'string') { notRegExp(t, 'endsWith'); t = argStr(t); }
            end = s.length;
            if (arguments.length > 1 && arguments[1] !== undefined) { end = toInt(arguments[1]); if (end < 0) end = 0; else if (end > s.length) end = s.length; }
            return end >= t.length && s.substr(end - t.length, t.length) === t;
        });
        hidden(SP, 'includes', function includes(search) {
            var s = this, t = search;
            if (typeof s !== 'string') s = thisStr(s, 'includes');
            if (typeof t !== 'string') { notRegExp(t, 'includes'); t = argStr(t); }
            return (arguments.length > 1 ? s.indexOf(t, toInt(arguments[1])) : s.indexOf(t)) !== -1;
        });
        var pad = function (self, name, maxLength, fill, atStart) {
            var s = thisStr(self, name), len = toLen(maxLength);
            if (len <= s.length) return s;
            var f = fill === undefined ? ' ' : argStr(fill);
            if (f === '') return s;
            var need = len - s.length;
            while (f.length < need) f += f;
            f = f.length > need ? f.slice(0, need) : f;
            return atStart ? f + s : s + f;
        };
        hidden(SP, 'padStart', function padStart(maxLength) { return pad(this, 'padStart', maxLength, arguments[1], true); });
        hidden(SP, 'padEnd', function padEnd(maxLength) { return pad(this, 'padEnd', maxLength, arguments[1], false); });
        hidden(SP, 'repeat', function repeat(count) {
            var s = thisStr(this, 'repeat'), n = toInt(count), out = '';
            if (n < 0 || n === Infinity) throw new RangeError('Invalid count value: ' + n);
            while (n > 0) { if (n % 2 === 1) out += s; n = Math.floor(n / 2); if (n) s += s; }
            return out;
        });
        hidden(SP, 'codePointAt', function codePointAt(pos) {
            var s = thisStr(this, 'codePointAt'), i = toInt(pos);
            if (i < 0 || i >= s.length) return undefined;
            var a = s.charCodeAt(i);
            if (a < 0xD800 || a > 0xDBFF || i + 1 === s.length) return a;
            var b = s.charCodeAt(i + 1);
            return b < 0xDC00 || b > 0xDFFF ? a : (a - 0xD800) * 0x400 + b - 0xDC00 + 0x10000;
        });
        hidden(String, 'fromCodePoint', function fromCodePoint(x) {
            var out = '', fcc = String.fromCharCode;
            for (var i = 0; i < arguments.length; i++) {
                var c = +arguments[i];
                if (c !== toInt(c) || c < 0 || c > 0x10FFFF) throw new RangeError(arguments[i] + ' is not a valid code point');
                out += c < 0x10000 ? fcc(c) : fcc(Math.floor((c - 0x10000) / 0x400) + 0xD800, (c - 0x10000) % 0x400 + 0xDC00);
            }
            return out;
        });
        hidden(AP, 'includes', function includes(el) {
            // (an array, one value that is neither NaN nor undefined: the engine's indexOf)
            if (arguments.length === 1 && el === el && el !== undefined && isArray(this)) return nIndexOf.call(this, el) !== -1;
            var O = thisObj(this, 'includes'), len = toLen(O.length);
            if (!len) return false;
            var k = arguments.length > 1 ? toInt(arguments[1]) : 0;
            if (k < 0) { k += len; if (k < 0) k = 0; }
            if (el !== el) { for (; k < len; k++) { var v = O[k]; if (v !== v) return true; } return false; }
            if (el !== undefined) return nIndexOf.call(O, el, k) !== -1;
            for (; k < len; k++) if (O[k] === undefined) return true;   // (holes read as undefined)
            return false;
        });
        var findIn = function (self, name, fn, thisArg, last, wantIndex) {
            var O = thisObj(self, name), len = toLen(O.length);
            callable(fn);
            for (var n = 0; n < len; n++) {
                var k = last ? len - 1 - n : n, v = O[k];
                if (fn.call(thisArg, v, k, O)) return wantIndex ? k : v;
            }
            return wantIndex ? -1 : undefined;
        };
        hidden(AP, 'find', function find(fn) { return findIn(this, 'find', fn, arguments[1], false, false); });
        hidden(AP, 'findIndex', function findIndex(fn) { return findIn(this, 'findIndex', fn, arguments[1], false, true); });
        hidden(AP, 'findLast', function findLast(fn) { return findIn(this, 'findLast', fn, arguments[1], true, false); });
        hidden(AP, 'findLastIndex', function findLastIndex(fn) { return findIn(this, 'findLastIndex', fn, arguments[1], true, true); });
        var flatInto = function (out, src, depth) {
            var len = toLen(src.length);
            for (var i = 0; i < len; i++) {
                if (!(i in src)) continue;
                var v = src[i];
                if (depth > 0 && isArray(v)) flatInto(out, v, depth - 1); else out.push(v);
            }
            return out;
        };
        hidden(AP, 'flat', function flat() {
            var O = thisObj(this, 'flat'), d = arguments.length && arguments[0] !== undefined ? toInt(arguments[0]) : 1;
            return flatInto([], O, d);
        });
        hidden(AP, 'flatMap', function flatMap(fn) {
            var O = thisObj(this, 'flatMap'), len = toLen(O.length), out = [], thisArg = arguments[1];
            callable(fn);
            for (var i = 0; i < len; i++) {
                if (!(i in O)) continue;
                var v = fn.call(thisArg, O[i], i, O);
                if (isArray(v)) flatInto(out, v, 0); else out.push(v);
            }
            return out;
        });
        // Array.from: arrays, strings, array-likes and core-js's Set and Map directly; other iterables step by step,
        // closed (their return()) when the map function throws; another constructor than Array: core-js's
        var nFrom = Array.from, CSet = window.Set, CMap = window.Map;
        // (their callbacks made in functions of their own: a function that makes a closure over its variables gets a
        // scope object on every call here, whether it makes it or not)
        var setItems = function (set) { var out = []; set.forEach(function (v) { out.push(v); }); return out; };
        var mapItems = function (map) { var out = []; map.forEach(function (v, k) { out.push([k, v]); }); return out; };
        var fromIterator = function (it, mapFn, thisArg) {
            var out = [], step, i = 0;
            while (!(step = it.next()).done) {
                if (mapFn) {
                    try { out.push(mapFn.call(thisArg, step.value, i++)); } catch (e) {
                        var ret = it['return'];
                        if (typeof ret === 'function') { try { ret.call(it); } catch (e2) {} }
                        throw e;
                    }
                } else out.push(step.value);
            }
            return out;
        };
        Array.from = function from(items) {
            var i, len, out;
            // (an array alone into an array: a copy, holes read as undefined)
            if (arguments.length === 1 && (this === Array || this === undefined) && isArray(items)) {
                len = items.length; out = new Array(len);
                for (i = 0; i < len; i++) out[i] = items[i];
                return out;
            }
            var mapFn = arguments.length > 1 ? arguments[1] : undefined, thisArg = arguments[2];
            if (this !== Array && this !== undefined && this !== null && this !== window && typeof this === 'function' && nFrom) return nFrom.apply(this, arguments);
            if (mapFn !== undefined) callable(mapFn); else mapFn = null;
            if (items === null || items === undefined) throw new TypeError(items + ' is not iterable');
            if (isArray(items)) {
                len = items.length; out = new Array(len);
                for (i = 0; i < len; i++) out[i] = mapFn ? mapFn.call(thisArg, items[i], i) : items[i];
                return out;
            }
            if (typeof items === 'string') {
                out = items.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || [];
                if (mapFn) for (i = 0; i < out.length; i++) out[i] = mapFn.call(thisArg, out[i], i);
                return out;
            }
            if (CSet && items instanceof CSet) out = setItems(items);
            else if (CMap && items instanceof CMap) out = mapItems(items);
            else {
                var getIt = ITER !== null ? items[ITER] : undefined;
                if (getIt === undefined && typeof items['@@iterator'] === 'function') getIt = items['@@iterator'];
                // (a NodeList, arguments...: the array iterator reads index by index, as the loop below does)
                if (getIt !== undefined && getIt !== null && !(ITER !== null && getIt === AP[ITER])) {
                    callable(getIt);
                    return fromIterator(getIt.call(items), mapFn, thisArg);
                }
                var O = Object(items);
                len = toLen(O.length); out = new Array(len);
                for (i = 0; i < len; i++) out[i] = O[i];
            }
            if (mapFn) for (i = 0; i < out.length; i++) out[i] = mapFn.call(thisArg, out[i], i);
            return out;
        };
        Array.from.__brLean = true;
        var ownEntries = function (o, values) {
            if (o === null || o === undefined) throw new TypeError('Cannot convert undefined or null to object');
            var O = Object(o), keys = Object.keys(O), out = [];
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (!pie.call(O, k)) continue;   // (made non-enumerable by a getter meanwhile)
                out.push(values ? O[k] : [k, O[k]]);
            }
            return out;
        };
        hidden(Object, 'entries', function entries(o) { return ownEntries(o, false); });
        // (no name: the minifier keeps every function named "values", see tools/minify-page-scripts.js)
        hidden(Object, 'values', function (o) { return ownEntries(o, true); });
        hidden(Object, 'fromEntries', function fromEntries(iterable) {
            if (iterable === null || iterable === undefined) throw new TypeError(iterable + ' is not iterable');
            var out = {}, list = isArray(iterable) ? iterable : Array.from(iterable);
            for (var i = 0; i < list.length; i++) {
                var e = list[i];
                if (e === null || (typeof e !== 'object' && typeof e !== 'function')) throw new TypeError('Iterator value ' + e + ' is not an entry object');
                var k = e[0];
                if (!(SymC && k instanceof SymC)) k = String(k);
                // (an own property even for __proto__; a symbol through core-js, which keeps its own books on them)
                if (k === '__proto__') def(out, k, { value: e[1], writable: true, enumerable: true, configurable: true });
                else out[k] = e[1];
            }
            return out;
        });
        var gops = Object.getOwnPropertySymbols;
        hidden(Object, 'assign', function assign(target, source) {
            if (target === null || target === undefined) throw new TypeError('Cannot convert undefined or null to object');
            var T = Object(target);
            for (var i = 1; i < arguments.length; i++) {
                var src = arguments[i];
                if (src === null || src === undefined) continue;
                var Sx = Object(src), keys = Object.keys(Sx), j, k;
                for (j = 0; j < keys.length; j++) { k = keys[j]; if (pie.call(Sx, k)) T[k] = Sx[k]; }
                if (gops && typeof Sx === 'object') {
                    var syms = gops(Sx);
                    for (j = 0; j < syms.length; j++) if (Object.prototype.propertyIsEnumerable.call(Sx, syms[j])) T[syms[j]] = Sx[syms[j]];
                }
            }
            return T;
        });
        // replaceAll (core-js's: 82 us for 'a-b-c'.replaceAll('-', '+')): a global regular expression goes to replace, a
        // string pattern without $ in the replacement to split/join, the rest through the positions of the matches
        var REPLACE = keyOf(S && S.replace);
        var substitute = function (rep, matched, str, pos) {
            if (rep.indexOf('$') < 0) return rep;
            return rep.replace(/\$([$&'`])/g, function (all, t) {
                return t === '$' ? '$' : t === '&' ? matched : t === '`' ? str.slice(0, pos) : str.slice(pos + matched.length);
            });
        };
        hidden(SP, 'replaceAll', function replaceAll(searchValue, replaceValue) {
            var s = this;
            if (typeof s !== 'string') s = thisStr(s, 'replaceAll');
            if (searchValue !== null && searchValue !== undefined && typeof searchValue !== 'string') {
                var m = MATCH !== null && typeof searchValue === 'object' ? searchValue[MATCH] : undefined;
                if (m !== undefined ? !!m : toStr0.call(searchValue) === '[object RegExp]') {
                    var flags = String(searchValue.flags !== undefined ? searchValue.flags : (searchValue.global ? 'g' : ''));
                    if (flags.indexOf('g') < 0) throw new TypeError('replaceAll must be called with a global RegExp');
                }
                var replacer = REPLACE !== null && (typeof searchValue === 'object' || typeof searchValue === 'function') ? searchValue[REPLACE] : undefined;
                if (replacer !== undefined && replacer !== null) return replacer.call(searchValue, s, replaceValue);
                if (m !== undefined ? !!m : toStr0.call(searchValue) === '[object RegExp]') return s.replace(searchValue, replaceValue);
            }
            var search = argStr(searchValue), fn = typeof replaceValue === 'function', rep = fn ? null : argStr(replaceValue), out = '', p;
            // ('' matches before every code unit and at the end)
            if (!search.length) {
                for (p = 0; p <= s.length; p++) out += (fn ? String(replaceValue('', p, s)) : substitute(rep, '', s, p)) + s.charAt(p);
                return out;
            }
            if (!fn && rep.indexOf('$') < 0) return s.split(search).join(rep);
            var last = 0;
            for (p = s.indexOf(search); p !== -1; p = s.indexOf(search, last)) {
                out += s.slice(last, p) + (fn ? String(replaceValue(search, p, s)) : substitute(rep, search, s, p));
                last = p + search.length;
            }
            return out + s.slice(last);
        });
        hidden(SP, 'at', function at(index) {
            var s = this;
            if (typeof s !== 'string') s = thisStr(s, 'at');
            var k = toInt(index);
            if (k < 0) k += s.length;
            return k < 0 || k >= s.length ? undefined : s.charAt(k);
        });
        // trim, trimStart (= trimLeft) and trimEnd (= trimRight): the engine's, which also takes away U+200B and U+180E
        // (white space in older Unicode, not any more), so core-js put its own in (a regular expression replace per
        // call); only a string that has one of those two is trimmed here by hand
        var nTrim = SP.trim, nTrimL = SP.trimLeft, nTrimR = SP.trimRight, ODD_WS = /[\u200B\u180E]/;
        var isWS = function (c) {
            return c === 32 || (c >= 9 && c <= 13) || c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 ||
                c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
        };
        var trimBy = function (s, start, end) {
            var i = 0, j = s.length;
            if (start) while (i < j && isWS(s.charCodeAt(i))) i++;
            if (end) while (j > i && isWS(s.charCodeAt(j - 1))) j--;
            return s.slice(i, j);
        };
        // (declarations, in a function of their own: core-js checks their names, and a named function expression reads
        // every outer variable through a scope object of its own here, a microsecond and more per call)
        (function () {
            if (!nTrim || !nTrimL || !nTrimR) return;
            function trim() {
                var s = this;
                if (typeof s !== 'string') s = thisStr(s, 'trim');
                var r = nTrim.call(s);
                return r.length === s.length || !ODD_WS.test(s) ? r : trimBy(s, true, true);
            }
            function trimStart() {
                var s = this;
                if (typeof s !== 'string') s = thisStr(s, 'trimStart');
                var r = nTrimL.call(s);
                return r.length === s.length || !ODD_WS.test(s) ? r : trimBy(s, true, false);
            }
            function trimEnd() {
                var s = this;
                if (typeof s !== 'string') s = thisStr(s, 'trimEnd');
                var r = nTrimR.call(s);
                return r.length === s.length || !ODD_WS.test(s) ? r : trimBy(s, false, true);
            }
            hidden(SP, 'trim', trim);
            hidden(SP, 'trimStart', trimStart); hidden(SP, 'trimLeft', trimStart);
            hidden(SP, 'trimEnd', trimEnd); hidden(SP, 'trimRight', trimEnd);
        })();
        // Number: the engine's reads no '0b101' / '0o17' strings, so core-js put a Number of its own in place (a trim and
        // a parse in JS for every string); this one hands everything else straight to the engine's
        (function () {
            var NNumber = window.Number;
            if (NNumber(' 0o1') === 1 || NNumber.__brLean) return;
            // (only a string that starts with 0b / 0o, or a sign and 0x, is read here)
            var PREFIXED = /^\s*(?:0[bBoO]|[+-]0[xX])/;
            var toNumber = function (v) {
                if (typeof v === 'string') {
                    if (v.length > 2 && PREFIXED.test(v)) {
                        var t = trimBy(v, true, true), c1 = t.charCodeAt(1) | 32;
                        // ('+0x1' / '-0x1' are NaN: no sign before a prefix)
                        if (t.charAt(0) !== '0' || (c1 !== 98 && c1 !== 111)) return NaN;
                        var radix = c1 === 98 ? 2 : 8, digits = t.slice(2);
                        if (!digits.length || (radix === 2 ? /[^01]/ : /[^0-7]/).test(digits)) return NaN;
                        return parseInt(digits, radix);
                    }
                    return NNumber(v);
                }
                if (v !== null && typeof v === 'object' && SymC && v instanceof SymC) throw new TypeError('Cannot convert a Symbol value to a number');
                return NNumber(v);
            };
            var NumberW = Number;
            function Number(value) {
                // (numbers, and strings that are short or start with a digit 1-9, go to the engine at once: one call
                // less, which is most of the cost here. The shims are strict: this is undefined for Number(x), the new
                // object for new Number(x) - which gets the engine's wrapper object.)
                var n, c;
                if (typeof value === 'string') n = value.length < 3 || ((c = value.charCodeAt(0)) >= 49 && c <= 57) ? NNumber(value) : toNumber(value);
                else if (typeof value === 'number') n = value;
                else n = value !== undefined ? toNumber(value) : arguments.length ? NaN : 0;
                return this instanceof NumberW ? new NNumber(n) : n;
            }
            var names = Object.getOwnPropertyNames(NNumber);
            for (var ni = 0; ni < names.length; ni++) {
                var nm = names[ni];
                if (nm === 'prototype' || nm === 'length' || nm === 'name' || nm === 'arguments' || nm === 'caller') continue;
                try { def(NumberW, nm, Object.getOwnPropertyDescriptor(NNumber, nm)); } catch (eN) {}
            }
            NumberW.prototype = NNumber.prototype;
            def(NNumber.prototype, 'constructor', { value: NumberW, writable: true, configurable: true, enumerable: false });
            looksNative(NumberW, 'Number');
            NumberW.__brLean = true;
            try { window.Number = NumberW; } catch (eW) {}
        })();
        // Date#toJSON: the engine's throws for an invalid date (null in ES5.1 on), so core-js put its own in
        var nToJSON = Date.prototype.toJSON;
        if (nToJSON && (function () { try { return new Date(NaN).toJSON() !== null; } catch (e) { return true; } })()) {
            hidden(Date.prototype, 'toJSON', function toJSON(key) {
                var O = Object(this), tv;
                if (O instanceof Date) tv = O.getTime();
                else { tv = O.valueOf(); if (tv !== null && (typeof tv === 'object' || typeof tv === 'function')) tv = O.toString(); }
                if (typeof tv === 'number' && (tv !== tv || tv === Infinity || tv === -Infinity)) return null;
                return O.toISOString();
            });
        }
        var nOf = Array.of;
        Array.of = function of() {
            if (this === Array || this === undefined || typeof this !== 'function') return AP.slice.call(arguments);
            return nOf.apply(this, arguments);
        };
        // getOwnPropertyDescriptors (core-js's: 121 us for two keys; Babel's object spread helper calls it for every
        // other source): the engine's names and descriptors, symbols through core-js
        var engineNames = N.getOwnPropertyNames, engineGOPD = N.getOwnPropertyDescriptor;
        if (engineNames && engineGOPD) hidden(Object, 'getOwnPropertyDescriptors', function getOwnPropertyDescriptors(o) {
            if (o === null || o === undefined) throw new TypeError('Cannot convert undefined or null to object');
            var O = Object(o), names = engineNames(O), out = {}, i, d;
            for (i = 0; i < names.length; i++) {
                var k = names[i];
                if (k.charCodeAt(0) === 83 && k.slice(0, 7) === 'Symbol(') continue;   // (core-js's symbols and their books)
                if (k === '__brO' || k === '__brP' || k === '__brC') continue;         // (the shims' own records)
                d = engineGOPD(O, k);
                if (d === undefined) continue;
                if (k === '__proto__') def(out, k, { value: d, writable: true, enumerable: true, configurable: true });
                else out[k] = d;
            }
            if (gops) {
                var syms = gops(O);
                for (i = 0; i < syms.length; i++) { d = Object.getOwnPropertyDescriptor(O, syms[i]); if (d !== undefined) out[syms[i]] = d; }
            }
            return out;
        });
    })();

    // Promise, lean, in place of core-js's: its general machinery made every step cost 50-100 us here (new Promise 46-68,
    // Promise.resolve 81, then 98), and async functions take several per await. The standard's algorithms as they are
    // (reactions as microtasks through queueMicrotask, thenables adopted in a job of their own, species for subclasses,
    // unhandledrejection / rejectionhandled events on window), the state in one hidden property. Subclasses the ES5 way
    // (Promise.call(this, executor), as lowered classes do) work, as with core-js.
    (function () {
        var N = window.__brNative || {}, Old = window.Promise, qm = N.queueMicrotask || window.queueMicrotask;
        // (queueMicrotask itself without core-js's wrapper in front: 27 us a call there, React's scheduler calls it too)
        if (N.queueMicrotask && window.queueMicrotask !== N.queueMicrotask) try { window.queueMicrotask = N.queueMicrotask; } catch (eQ) {}
        if (!Old || Old.__brLean || typeof qm !== 'function') return;
        var def = N.defineProperty || Object.defineProperty, S = window.Symbol;
        var keyOf = function (sym) { return !sym ? null : typeof sym === 'symbol' ? sym : String(sym); };
        var SPECIES = keyOf(S && S.species), ITER = keyOf(S && S.iterator), TAG = S && S.toStringTag;
        var PENDING = 0, FULFILLED = 1, REJECTED = 2, ERR = {}, lastError = null, NOOP = function () {};
        var hide = function (o, k, v) { def(o, k, { value: v, writable: true, configurable: true, enumerable: false }); };
        // (the tries in small functions of their own: a function with a try makes a scope object on every call here)
        var try0 = function (fn) { try { return fn(); } catch (e) { lastError = e; return ERR; } };
        var try1 = function (fn, a) { try { return fn(a); } catch (e) { lastError = e; return ERR; } };
        var tryCall2 = function (fn, self, a, b) { try { return fn.call(self, a, b); } catch (e) { lastError = e; return ERR; } };
        var getThen = function (x) { try { return x.then; } catch (e) { lastError = e; return ERR; } };
        // (its own state: the record names the promise, so one inherited through Object.create does not count)
        var stateOf = function (p) {
            if (p === null || typeof p !== 'object') return null;
            var st = p.__brP;
            return st !== undefined && st !== null && st.p === p ? st : null;
        };
        // (a declaration: it keeps its name, and a named function expression reads every outer variable through a
        // scope object of its own here)
        var P = Promise;
        function Promise(executor) {
            if (!(this instanceof P) || stateOf(this)) throw new TypeError("Promise constructor cannot be invoked without 'new'");
            if (typeof executor !== 'function') throw new TypeError('Promise resolver ' + executor + ' is not a function');
            var st = init(this), fns = resolvers(st);
            if (tryCall2(executor, undefined, fns[0], fns[1]) === ERR) fns[1](lastError);
        }
        // (one descriptor for all: an object less per promise)
        var PD = { value: null, writable: true, configurable: true, enumerable: false };
        var init = function (p) {
            var st = { s: PENDING, v: undefined, r: null, h: false, p: p, reported: false };
            PD.value = st;
            def(p, '__brP', PD);
            PD.value = null;
            return st;
        };
        // jobs: a function and three arguments through page-prelude's queue, no closure each (a function that makes a
        // closure over its variables gets a scope object on every call here); else a closure through queueMicrotask
        var later = N.queueJob || function (fn, a, b, c) { qm(function () { fn(a, b, c); }); };
        // a promise of ours made without an executor (then, resolve, all...)
        var Internal = function () { init(this); };
        Internal.prototype = P.prototype;
        // the resolving functions of a promise: the first call wins
        var resolvers = function (st) {
            var done = false;
            return [function (v) { if (!done) { done = true; resolveWith(st, v); } }, function (e) { if (!done) { done = true; settle(st, REJECTED, e); } }];
        };
        var resolveWith = function (st, x) {
            if (x === st.p) return settle(st, REJECTED, new TypeError('Chaining cycle detected for promise #<Promise>'));
            if (x !== null && (typeof x === 'object' || typeof x === 'function')) {
                var then = getThen(x);
                if (then === ERR) return settle(st, REJECTED, lastError);
                if (typeof then === 'function') { later(thenableJob, st, then, x); return; }
            }
            settle(st, FULFILLED, x);
        };
        var unhandled = [], checking = false;
        var settle = function (st, state, v) {
            if (st.s !== PENDING) return;
            st.s = state;
            st.v = v;
            var r = st.r;
            st.r = null;
            if (r !== null) {
                if (r.length === undefined) queueReaction(r, state, v);
                else for (var i = 0; i < r.length; i++) queueReaction(r[i], state, v);
            }
            if (state === REJECTED && !st.h) {
                unhandled.push(st);
                if (!checking) { checking = true; setTimeout(checkUnhandled, 0); }
            }
        };
        var fire = function (type, st) {
            var ev;
            try { ev = document.createEvent('Event'); ev.initEvent(type, false, true); } catch (e) { return true; }
            ev.promise = st.p;
            ev.reason = st.v;
            var go = window.dispatchEvent(ev);
            var h = window['on' + type];
            if (typeof h === 'function') { try { if (h.call(window, ev) === false) go = false; } catch (e2) {} }
            return go && !ev.defaultPrevented;
        };
        var checkUnhandled = function () {
            checking = false;
            var list = unhandled;
            unhandled = [];
            for (var i = 0; i < list.length; i++) {
                var st = list[i];
                if (st.h) continue;
                st.reported = true;
                if (fire('unhandledrejection', st) && window.console && console.error) {
                    try { console.error('Unhandled Promise Rejection:', st.v); } catch (e) {}
                }
            }
        };
        // (NewPromiseResolveThenableJob: a promise of ours with its own then takes the other's state through a reaction
        // of its own, without resolving functions and a call of then)
        var thenableJob = function (st, then, x) {
            var xs = then === protoThen && x.constructor === P ? stateOf(x) : null;
            if (xs !== null) { subscribe(xs, { c: { st: st }, f: null, r: null }); return; }
            var fns = resolvers(st);
            if (tryCall2(then, x, fns[0], fns[1]) === ERR) fns[1](lastError);
        };
        var reactionJob = function (re, state, v) {
            var handler = state === FULFILLED ? re.f : re.r, out;
            if (handler === null) { if (state === FULFILLED) capResolve(re.c, v); else capReject(re.c, v); return; }
            out = try1(handler, v);
            if (out === ERR) capReject(re.c, lastError); else capResolve(re.c, out);
        };
        var queueReaction = function (re, state, v) { later(reactionJob, re, state, v); };
        // (a reaction on a promise: kept while it is pending, queued when it is settled)
        var subscribe = function (st, re) {
            if (st.s === PENDING) {
                if (st.r === null) st.r = re;
                else if (st.r.length === undefined) st.r = [st.r, re];
                else st.r[st.r.length] = re;
            } else {
                if (st.s === REJECTED && !st.h && st.reported) fire('rejectionhandled', st);
                queueReaction(re, st.s, st.v);
            }
            st.h = true;
        };
        // a capability: {st} for ours, {resolve, reject, promise} for another constructor's
        var capResolve = function (c, v) { if (c.st) resolveWith(c.st, v); else c.resolve(v); };
        var capReject = function (c, e) { if (c.st) settle(c.st, REJECTED, e); else c.reject(e); };
        var newCap = function (C) {
            if (C === P) { var p = new Internal(); return { st: p.__brP, promise: p }; }
            return foreignCap(C);
        };
        // (another constructor's: its executor is a closure, in a function of its own)
        var foreignCap = function (C) {
            if (typeof C !== 'function') throw new TypeError('Promise resolve or reject function is not callable');
            var c = { resolve: undefined, reject: undefined, promise: undefined };
            c.promise = new C(function (res, rej) {
                if (c.resolve !== undefined || c.reject !== undefined) throw new TypeError('Promise executor has already been invoked with non-undefined arguments');
                c.resolve = res; c.reject = rej;
            });
            if (typeof c.resolve !== 'function' || typeof c.reject !== 'function') throw new TypeError('Promise resolve or reject function is not callable');
            return c;
        };
        var speciesOf = function (o) {
            var C = o.constructor;
            if (C === P || C === undefined) return P;
            if (C === null || (typeof C !== 'object' && typeof C !== 'function')) throw new TypeError('object.constructor is not an object');
            var Sp = SPECIES !== null ? C[SPECIES] : undefined;
            return Sp === undefined || Sp === null ? P : Sp;
        };
        var proto = P.prototype;
        var protoThen = function then(onFulfilled, onRejected) {
            var st = stateOf(this);
            if (!st) throw new TypeError('Method Promise.prototype.then called on incompatible receiver ' + this);
            var c = newCap(speciesOf(this));
            subscribe(st, { c: c, f: typeof onFulfilled === 'function' ? onFulfilled : null, r: typeof onRejected === 'function' ? onRejected : null });
            return c.promise;
        };
        hide(proto, 'then', protoThen);
        hide(proto, 'catch', function (onRejected) { return this.then(undefined, onRejected); });
        hide(proto, 'finally', function (onFinally) {
            if (this === null || (typeof this !== 'object' && typeof this !== 'function')) throw new TypeError('Promise.prototype.finally called on a non-object');
            var C = speciesOf(this);
            if (typeof onFinally !== 'function') return this.then(onFinally, onFinally);
            return this.then(function (v) {
                return resolveBy(C, onFinally()).then(function () { return v; });
            }, function (e) {
                return resolveBy(C, onFinally()).then(function () { throw e; });
            });
        });
        proto.constructor = P;
        hide(proto, 'constructor', P);
        if (TAG) try { Object.defineProperty(proto, TAG, { value: 'Promise', configurable: true }); } catch (eT) {}
        // PromiseResolve(C, x)
        var resolveBy = function (C, x) {
            var st = stateOf(x);
            if (st && x.constructor === C) return x;
            var c = newCap(C);
            capResolve(c, x);
            return c.promise;
        };
        hide(P, 'resolve', function resolve(x) {
            if (this === null || (typeof this !== 'object' && typeof this !== 'function')) throw new TypeError('PromiseResolve called on non-object');
            return resolveBy(this, x);
        });
        hide(P, 'reject', function reject(e) { var c = newCap(this); capReject(c, e); return c.promise; });
        hide(P, 'withResolvers', function withResolvers() { var c = newCap(this); if (c.st) { var f = resolvers(c.st); return { promise: c.promise, resolve: f[0], reject: f[1] }; } return { promise: c.promise, resolve: c.resolve, reject: c.reject }; });
        hide(P, 'try', function (fn) {
            var c = newCap(this), args = Array.prototype.slice.call(arguments, 1);
            var out = try0(function () { return fn.apply(undefined, args); });
            if (out === ERR) capReject(c, lastError); else capResolve(c, out);
            return c.promise;
        });
        // the items of an iterable: an array as it is, anything else through Array.from (iterators closed there)
        var itemsOf = function (it) {
            if (Array.isArray(it)) return it;
            if (it === null || it === undefined || (ITER !== null && typeof it[ITER] !== 'function' && typeof it !== 'string')) throw new TypeError(it + ' is not iterable');
            return Array.from(it);
        };
        var combine = function (C, iterable, kind) {
            var c = newCap(C), list, i, remaining = 1, values = [];
            var fail = function (e) { capReject(c, e); };
            var got = try0(function () { list = itemsOf(iterable); return 0; });
            if (got === ERR) { fail(lastError); return c.promise; }
            var resolveItem = C === P ? function (x) { return resolveBy(P, x); } : function (x) { return C.resolve(x); };
            var each = function (index, item) {
                var p = resolveItem(item), called = false;
                if (kind === 'race') { p.then(function (v) { capResolve(c, v); }, fail); return; }
                values[index] = undefined;
                remaining++;
                var ok = function (v) {
                    if (called) return; called = true;
                    values[index] = kind === 'allSettled' ? { status: 'fulfilled', value: v } : v;
                    if (--remaining === 0) { if (kind === 'any') fail(anyError(values)); else capResolve(c, values); }
                };
                var bad = function (e) {
                    if (called) return; called = true;
                    if (kind === 'all') { fail(e); return; }
                    values[index] = kind === 'allSettled' ? { status: 'rejected', reason: e } : e;
                    if (--remaining === 0) { if (kind === 'any') fail(anyError(values)); else capResolve(c, values); }
                };
                if (kind === 'any') p.then(function (v) { if (!called) { called = true; capResolve(c, v); } }, bad);
                else p.then(ok, bad);
            };
            for (i = 0; i < list.length; i++) {
                var r = try0((function (idx, item) { return function () { each(idx, item); return 0; }; })(i, list[i]));
                if (r === ERR) { fail(lastError); return c.promise; }
            }
            if (kind !== 'race' && --remaining === 0) { if (kind === 'any') fail(anyError(values)); else capResolve(c, values); }
            return c.promise;
        };
        var anyError = function (errors) {
            var AE = window.AggregateError;
            if (typeof AE === 'function') return new AE(errors, 'All promises were rejected');
            var e = new Error('All promises were rejected'); e.name = 'AggregateError'; e.errors = errors; return e;
        };
        hide(P, 'all', function all(iterable) { return combine(this, iterable, 'all'); });
        hide(P, 'allSettled', function allSettled(iterable) { return combine(this, iterable, 'allSettled'); });
        hide(P, 'any', function any(iterable) { return combine(this, iterable, 'any'); });
        hide(P, 'race', function race(iterable) { return combine(this, iterable, 'race'); });
        if (SPECIES !== null) try { Object.defineProperty(P, S.species, { get: function () { return this; }, configurable: true }); } catch (eS) {}
        looksNative(P, 'Promise');
        P.__brLean = true;
        try { window.Promise = P; } catch (eP) {}
    })();

    // document.currentScript: the running script's URL is read from a stack trace (the first frame that is not this
    // bundle's) and matched with the script elements; inline and eval'd code, or no stack, get the last script element
    // (the running one while the document is parsed). Chunk loaders (Turbopack, webpack's publicPath) read it.
    if (!('currentScript' in document)) {
        var stackURLs = function () {
            try { throw new Error(); } catch (err) {
                var s = String(err.stack || ''), out = [], re = /((?:https?|file):\/\/[^\s@]+?):\d+(?::\d+)?\s*$/gm, m;
                while ((m = re.exec(s))) out.push(m[1]);
                return out;
            }
        };
        var ownScriptURL = stackURLs()[0] || null;
        try {
            Object.defineProperty(document, 'currentScript', { configurable: true, get: function () {
                var scripts = document.getElementsByTagName('script'), urls = stackURLs();
                for (var i = 0; i < urls.length; i++) {
                    if (urls[i] === ownScriptURL) continue;
                    for (var j = scripts.length - 1; j >= 0; j--) if (scripts[j].src === urls[i]) return scripts[j];
                    break;
                }
                return scripts.length ? scripts[scripts.length - 1] : null;
            } });
        } catch (e) {}
    }
    if (!document.scrollingElement) {
        try { Object.defineProperty(document, 'scrollingElement', { get: function () { return document.body; } }); } catch (e2) {}
    }
    if (!document.head) document.head = document.getElementsByTagName('head')[0];

    // Events
    if (!window.CustomEvent || typeof window.CustomEvent !== 'function') {
        window.CustomEvent = function (type, params) { params = params || {}; var e = document.createEvent('CustomEvent'); e.initCustomEvent(type, !!params.bubbles, !!params.cancelable, params.detail); return e; };
    }
    try { new window.Event('x'); } catch (e3) {
        window.Event = function (type, params) { params = params || {}; var e = document.createEvent('Event'); e.initEvent(type, !!params.bubbles, !!params.cancelable); return e; };
    }
    if (!window.KeyboardEvent || typeof window.KeyboardEvent !== 'function') {}
    if (!window.EventTarget) {
        // (new EventTarget(), its subclasses and objects made from its prototype: a listener store of their own)
        var listenersOf = function (t) {
            if (!Object.prototype.hasOwnProperty.call(t, '__listeners')) {
                try { Object.defineProperty(t, '__listeners', { value: {}, writable: true, configurable: true }); } catch (e) { t.__listeners = {}; }
            }
            return t.__listeners;
        };
        window.EventTarget = function EventTarget() { listenersOf(this); };
        window.EventTarget.prototype.addEventListener = function (t, f) { if (!f) return; var all = listenersOf(this), l = all[t] || (all[t] = []); if (l.indexOf(f) < 0) l.push(f); };
        window.EventTarget.prototype.removeEventListener = function (t, f) { var l = listenersOf(this)[t] || []; var i = l.indexOf(f); if (i >= 0) l.splice(i, 1); };
        window.EventTarget.prototype.dispatchEvent = function (e) {
            var l = (listenersOf(this)[e.type] || []).slice();
            for (var i = 0; i < l.length; i++) { var f = l[i]; if (typeof f === 'function') f.call(this, e); else if (f && typeof f.handleEvent === 'function') f.handleEvent(e); }
            return !e.defaultPrevented;
        };
    }

    // AbortController / AbortSignal: the default reasons are DOMExceptions named AbortError / TimeoutError (pages test
    // e.name === 'AbortError' to tell a cancelled request from a failed one), listeners get the signal as this and may
    // be objects with handleEvent, { once } is kept, one throwing listener does not stop the others; AbortSignal.any.
    // (the same in worker-shims.js)
    if (!window.AbortController) (function () {
        var named = function (name, msg) {
            try { var e = new window.DOMException(msg, name); if (e.name === name) return e; } catch (eD) {}
            var err = new Error(msg);
            err.name = name;
            return err;
        };
        // (declarations: constructor.name is read by some libraries' isAbortSignal)
        function AbortSignal() { this.aborted = false; this.reason = undefined; this.onabort = null; this.__l = []; }
        function AbortController() { this.signal = new AbortSignal(); }
        var SP = AbortSignal.prototype;
        SP.addEventListener = function (t, f, opts) {
            if (t !== 'abort' || !f) return;
            for (var i = 0; i < this.__l.length; i++) if (this.__l[i].f === f) return;
            this.__l.push({ f: f, once: !!(opts && typeof opts === 'object' && opts.once) });
        };
        SP.removeEventListener = function (t, f) {
            for (var i = 0; i < this.__l.length; i++) if (this.__l[i].f === f) { this.__l.splice(i, 1); return; }
        };
        var call = function (self, f, e) {
            try {
                if (typeof f === 'function') f.call(self, e);
                else if (f && typeof f.handleEvent === 'function') f.handleEvent(e);
            } catch (err) { setTimeout(function () { throw err; }, 0); }
        };
        SP.dispatchEvent = function (e) {
            var list = this.__l.slice();
            for (var i = 0; i < list.length; i++) {
                if (list[i].once) this.removeEventListener('abort', list[i].f);
                call(this, list[i].f, e);
            }
            if (typeof this.onabort === 'function') call(this, this.onabort, e);
            return true;
        };
        SP.throwIfAborted = function () { if (this.aborted) throw this.reason; };
        var noop = function () {};
        var abort = function (s, reason) {
            if (s.aborted) return;
            s.aborted = true;
            s.reason = reason === undefined ? named('AbortError', 'signal is aborted without reason') : reason;
            s.dispatchEvent({ type: 'abort', target: s, currentTarget: s, srcElement: s, isTrusted: true, bubbles: false, cancelable: false,
                defaultPrevented: false, eventPhase: 2, timeStamp: Date.now(), preventDefault: noop, stopPropagation: noop, stopImmediatePropagation: noop });
        };
        AbortSignal.abort = function (reason) { var s = new AbortSignal(); abort(s, reason); return s; };
        AbortSignal.timeout = function (ms) {
            var s = new AbortSignal();
            setTimeout(function () { abort(s, named('TimeoutError', 'signal timed out')); }, ms);
            return s;
        };
        AbortSignal.any = function (signals) {
            var s = new AbortSignal(), list = Array.from ? Array.from(signals) : Array.prototype.slice.call(signals), i;
            for (i = 0; i < list.length; i++) if (list[i].aborted) { abort(s, list[i].reason); return s; }
            var follow = function () { abort(s, this.reason); };
            for (i = 0; i < list.length; i++) list[i].addEventListener('abort', follow, { once: true });
            return s;
        };
        AbortController.prototype.abort = function (reason) { abort(this.signal, reason); };
        window.AbortController = AbortController;
        window.AbortSignal = AbortSignal;
    })();

    // TextEncoder / TextDecoder after the Encoding standard. UTF-8: a stream ({ stream: true }) keeps an incomplete
    // sequence for the next call (a Czech letter split between two chunks turned the whole chunk into Latin-1 here),
    // invalid bytes become U+FFFD each (or a TypeError with fatal), a leading BOM goes unless ignoreBOM (JSON.parse
    // failed on it), views are read within their byteOffset/byteLength (a DataView or an Int8Array read its whole
    // buffer). Also UTF-16LE/BE, the single-byte windows-1252 (its labels latin1, ascii...), windows-1250, iso-8859-2
    // and x-user-defined; other labels throw RangeError as the standard says, so pages take their own fallback. encode
    // turns lone surrogates into U+FFFD (it threw), encodeInto. Valid UTF-8 goes through the engine's own decoder
    // (escape + decodeURIComponent), the rest through the standard's loop. (The same in worker-shims.js.)
    if (!window.TextEncoder) (function (G) {
        var U8 = G.Uint8Array, slice = Array.prototype.slice, own = Object.prototype.hasOwnProperty, NON_ASCII = /[^\x00-\x7f]/;
        var invalid = function () { return new TypeError('The encoded data was not valid.'); };
        // (apply takes only so many arguments: 4096 code units at a time)
        var codesToString = function (codes) {
            if (codes.length <= 4096) return String.fromCharCode.apply(null, codes);
            var s = '';
            for (var i = 0; i < codes.length; i += 4096) s += String.fromCharCode.apply(null, codes.slice(i, i + 4096));
            return s;
        };
        var latin1 = function (bytes, from, to) {
            var s = '';
            for (var i = from; i < to; i += 4096) s += String.fromCharCode.apply(null, slice.call(bytes, i, Math.min(to, i + 4096)));
            return s;
        };
        var utf8Bytes = function (str, out) {
            for (var i = 0; i < str.length; i++) {
                var c = str.charCodeAt(i), c2;
                if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length && (c2 = str.charCodeAt(i + 1)) >= 0xDC00 && c2 <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00); i++; }
                else if (c >= 0xD800 && c <= 0xDFFF) c = 0xFFFD;
                if (c < 0x80) out.push(c);
                else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
                else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
                else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
            }
            return out;
        };
        function TextEncoder() {}
        TextEncoder.prototype.encoding = 'utf-8';
        TextEncoder.prototype.encode = function (str) {
            str = str === undefined ? '' : String(str);
            var bin = null;
            if (!NON_ASCII.test(str)) bin = str;
            else try { bin = unescape(encodeURIComponent(str)); } catch (e) { bin = null; }   // (a lone surrogate: the loop)
            if (bin === null) return new U8(utf8Bytes(str, []));
            var n = bin.length, out = new U8(n);
            for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
            return out;
        };
        // (whole characters only, as many as fit)
        TextEncoder.prototype.encodeInto = function (str, dest) {
            str = String(str);
            var read = 0, written = 0, room = dest.length, c, c2, units, need;
            while (read < str.length) {
                c = str.charCodeAt(read); units = 1;
                if (c >= 0xD800 && c <= 0xDBFF && read + 1 < str.length && (c2 = str.charCodeAt(read + 1)) >= 0xDC00 && c2 <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00); units = 2; }
                else if (c >= 0xD800 && c <= 0xDFFF) c = 0xFFFD;
                need = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
                if (written + need > room) break;
                if (need === 1) dest[written++] = c;
                else if (need === 2) { dest[written++] = 0xC0 | (c >> 6); dest[written++] = 0x80 | (c & 63); }
                else if (need === 3) { dest[written++] = 0xE0 | (c >> 12); dest[written++] = 0x80 | ((c >> 6) & 63); dest[written++] = 0x80 | (c & 63); }
                else { dest[written++] = 0xF0 | (c >> 18); dest[written++] = 0x80 | ((c >> 12) & 63); dest[written++] = 0x80 | ((c >> 6) & 63); dest[written++] = 0x80 | (c & 63); }
                read += units;
            }
            return { read: read, written: written };
        };
        var LABELS = {
            'utf-8': ['unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'utf-8', 'utf8', 'x-unicode20utf8'],
            'utf-16le': ['csunicode', 'iso-10646-ucs-2', 'ucs-2', 'unicode', 'unicodefeff', 'utf-16', 'utf-16le'],
            'utf-16be': ['unicodefffe', 'utf-16be'],
            'windows-1252': ['ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100', 'iso8859-1', 'iso88591',
                'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252'],
            'windows-1250': ['cp1250', 'windows-1250', 'x-cp1250'],
            'iso-8859-2': ['csisolatin2', 'iso-8859-2', 'iso-ir-101', 'iso8859-2', 'iso88592', 'iso_8859-2', 'iso_8859-2:1987', 'l2', 'latin2'],
            'x-user-defined': ['x-user-defined']
        };
        var byLabel = {}, enc, li;
        for (enc in LABELS) for (li = 0; li < LABELS[enc].length; li++) byLabel[LABELS[enc][li]] = enc;
        // bytes 0x80-0xFF of the single-byte encodings (the desktop browser's own decoders wrote them out)
        var HIGH = {
            'windows-1252': '20ac,81,201a,192,201e,2026,2020,2021,2c6,2030,160,2039,152,8d,17d,8f,90,2018,2019,201c,201d,2022,2013,2014,2dc,2122,161,203a,153,9d,17e,178',
            'windows-1250': '20ac,81,201a,83,201e,2026,2020,2021,88,2030,160,2039,15a,164,17d,179,90,2018,2019,201c,201d,2022,2013,2014,98,2122,161,203a,15b,165,17e,17a,' +
                'a0,2c7,2d8,141,a4,104,a6,a7,a8,a9,15e,ab,ac,ad,ae,17b,b0,b1,2db,142,b4,b5,b6,b7,b8,105,15f,bb,13d,2dd,13e,17c,154,c1,c2,102,c4,139,106,c7,10c,c9,118,cb,11a,cd,ce,10e,' +
                '110,143,147,d3,d4,150,d6,d7,158,16e,da,170,dc,dd,162,df,155,e1,e2,103,e4,13a,107,e7,10d,e9,119,eb,11b,ed,ee,10f,111,144,148,f3,f4,151,f6,f7,159,16f,fa,171,fc,fd,163,2d9',
            'iso-8859-2': '80,81,82,83,84,85,86,87,88,89,8a,8b,8c,8d,8e,8f,90,91,92,93,94,95,96,97,98,99,9a,9b,9c,9d,9e,9f,' +
                'a0,104,2d8,141,a4,13d,15a,a7,a8,160,15e,164,179,ad,17d,17b,b0,105,2db,142,b4,13e,15b,2c7,b8,161,15f,165,17a,2dd,17e,17c,154,c1,c2,102,c4,139,106,c7,10c,c9,118,cb,11a,cd,ce,10e,' +
                '110,143,147,d3,d4,150,d6,d7,158,16e,da,170,dc,dd,162,df,155,e1,e2,103,e4,13a,107,e7,10d,e9,119,eb,11b,ed,ee,10f,111,144,148,f3,f4,151,f6,f7,159,16f,fa,171,fc,fd,163,2d9'
        };
        var tables = {};
        var tableOf = function (e) {
            var t = tables[e];
            if (t) return t;
            t = tables[e] = [];
            var h = e === 'x-user-defined' ? [] : HIGH[e].split(',');
            for (var i = 0; i < 128; i++) t[i] = e === 'x-user-defined' ? 0xF780 + i : i < h.length ? parseInt(h[i], 16) : 0x80 + i;
            return t;
        };
        var newState = function () { return { cp: 0, need: 0, seen: 0, lower: 0x80, upper: 0xBF, bom: false, lead: -1, hi: -1 }; };
        // the standard's UTF-8 decoder over bytes[i..end), the state carried in st
        var step = function (bytes, i, end, st, fatal, out) {
            var cp = st.cp, need = st.need, seen = st.seen, lower = st.lower, upper = st.upper, b;
            while (i < end) {
                b = bytes[i];
                if (need === 0) {
                    i++;
                    if (b < 0x80) out.push(b);
                    else if (b >= 0xC2 && b <= 0xDF) { need = 1; cp = b & 0x1F; }
                    else if (b >= 0xE0 && b <= 0xEF) { if (b === 0xE0) lower = 0xA0; else if (b === 0xED) upper = 0x9F; need = 2; cp = b & 0xF; }
                    else if (b >= 0xF0 && b <= 0xF4) { if (b === 0xF0) lower = 0x90; else if (b === 0xF4) upper = 0x8F; need = 3; cp = b & 7; }
                    else { if (fatal) throw invalid(); out.push(0xFFFD); }
                    continue;
                }
                if (b < lower || b > upper) {
                    // (the byte is not taken: it starts over)
                    cp = need = seen = 0; lower = 0x80; upper = 0xBF;
                    if (fatal) throw invalid();
                    out.push(0xFFFD);
                    continue;
                }
                i++;
                lower = 0x80; upper = 0xBF;
                cp = (cp << 6) | (b & 0x3F);
                if (++seen === need) {
                    if (cp > 0xFFFF) { cp -= 0x10000; out.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); } else out.push(cp);
                    cp = need = seen = 0;
                }
            }
            st.cp = cp; st.need = need; st.seen = seen; st.lower = lower; st.upper = upper;
        };
        // (where an incomplete last sequence starts, for a stream)
        var tailStart = function (bytes, from, end) {
            for (var k = end - 1; k >= from && k >= end - 3; k--) {
                var b = bytes[k];
                if ((b & 0xC0) === 0x80) continue;
                return k + (b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1) > end ? k : end;
            }
            return end;
        };
        var utf8 = function (bytes, st, fatal, stream) {
            var end = bytes.length, i = 0, codes = [], head = '', mid = '';
            while (i < end && st.need) { step(bytes, i, i + 1, st, fatal, codes); i++; }   // (the rest of the last chunk's sequence)
            if (codes.length) { head = codesToString(codes); codes = []; }
            var cut = stream ? tailStart(bytes, i, end) : end;
            if (cut > i) {
                var bin = latin1(bytes, i, cut), t = null;
                if (!NON_ASCII.test(bin)) t = bin;
                else try { t = decodeURIComponent(escape(bin)); } catch (e) { t = null; }
                if (t === null) { step(bytes, i, cut, st, fatal, codes); mid = codesToString(codes); codes = []; }
                else mid = t;
            }
            if (cut < end) step(bytes, cut, end, st, fatal, codes);
            if (!stream && st.need) {
                st.cp = st.need = st.seen = 0; st.lower = 0x80; st.upper = 0xBF;
                if (fatal) throw invalid();
                codes.push(0xFFFD);
            }
            return head + mid + (codes.length ? codesToString(codes) : '');
        };
        var utf16 = function (bytes, st, fatal, stream, be) {
            var codes = [], unit, hi;
            for (var i = 0; i < bytes.length; i++) {
                if (st.lead < 0) { st.lead = bytes[i]; continue; }
                unit = be ? (st.lead << 8) | bytes[i] : (bytes[i] << 8) | st.lead;
                st.lead = -1;
                if (st.hi >= 0) {
                    hi = st.hi; st.hi = -1;
                    if (unit >= 0xDC00 && unit <= 0xDFFF) { codes.push(hi, unit); continue; }
                    if (fatal) throw invalid();
                    codes.push(0xFFFD);
                }
                if (unit >= 0xD800 && unit <= 0xDBFF) { st.hi = unit; continue; }
                if (unit >= 0xDC00 && unit <= 0xDFFF) { if (fatal) throw invalid(); codes.push(0xFFFD); continue; }
                codes.push(unit);
            }
            if (!stream && (st.lead >= 0 || st.hi >= 0)) {
                st.lead = st.hi = -1;
                if (fatal) throw invalid();
                codes.push(0xFFFD);
            }
            return codesToString(codes);
        };
        var single = function (bytes, e) {
            var t = tableOf(e), codes = [], s = '', b;
            for (var i = 0; i < bytes.length; i++) {
                b = bytes[i];
                codes.push(b < 0x80 ? b : t[b - 0x80]);
                if (codes.length === 4096) { s += String.fromCharCode.apply(null, codes); codes = []; }
            }
            return s + (codes.length ? String.fromCharCode.apply(null, codes) : '');
        };
        var bytesOf = function (input) {
            if (input === undefined || input === null) return new U8(0);
            if (input instanceof U8) return input;
            if (G.ArrayBuffer && input instanceof G.ArrayBuffer) return new U8(input);
            if (input.buffer && typeof input.byteLength === 'number') return new U8(input.buffer, input.byteOffset || 0, input.byteLength);
            if (typeof input.byteLength === 'number') return new U8(input);   // (an ArrayBuffer of another frame)
            if (typeof input.length === 'number') return new U8(input);
            throw new TypeError("The provided value is not of type '(ArrayBuffer or ArrayBufferView)'");
        };
        function TextDecoder(label, options) {
            var l = label === undefined ? 'utf-8' : String(label).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
            if (!own.call(byLabel, l)) throw new RangeError("The encoding label provided ('" + label + "') is invalid.");
            this.encoding = byLabel[l];
            this.fatal = !!(options && options.fatal);
            this.ignoreBOM = !!(options && options.ignoreBOM);
            this.__st = null;
            this.__dnf = false;
        }
        TextDecoder.prototype.decode = function (input, options) {
            var stream = !!(options && options.stream), bytes = bytesOf(input), e = this.encoding, out;
            if (!this.__dnf || !this.__st) this.__st = newState();
            this.__dnf = stream;
            var st = this.__st;
            if (e === 'utf-8') out = utf8(bytes, st, this.fatal, stream);
            else if (e === 'utf-16le' || e === 'utf-16be') out = utf16(bytes, st, this.fatal, stream, e === 'utf-16be');
            else out = single(bytes, e);
            // (the BOM: the stream's first code point, if it is U+FEFF, for UTF-8 and UTF-16)
            if (!st.bom && out.length) {
                st.bom = true;
                if (!this.ignoreBOM && out.charCodeAt(0) === 0xFEFF && e.slice(0, 4) === 'utf-') out = out.slice(1);
            }
            return out;
        };
        G.TextEncoder = TextEncoder;
        G.TextDecoder = TextDecoder;
    })(window);

    // crypto: random values come from the engine's own getRandomValues (a cryptographic generator) and from nothing
    // else. Math.random gives its next outputs away after a few observed ones, so where the engine has no generator
    // getRandomValues and randomUUID stay missing and code that makes keys, nonces or session ids fails instead of
    // quietly getting guessable ones. randomUUID: 122 random bits from that generator, version 4 as the standard has it.
    if (!window.crypto) window.crypto = {};
    if (!window.crypto.randomUUID && typeof window.crypto.getRandomValues === 'function') (function (c) {
        var fill = c.getRandomValues;
        var uuid = function () {
            var b = new Uint8Array(16), s = '', i;
            fill.call(c, b);
            b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
            for (i = 0; i < 16; i++) { s += (b[i] + 256).toString(16).slice(1); if (i === 3 || i === 5 || i === 7 || i === 9) s += '-'; }
            return s;
        };
        // (on the Crypto prototype first, as subtle in shims-extra.js: an expando on the engine's Crypto wrapper vanishes
        // when the old engine garbage-collects the wrapper and makes a new one - device logs showed randomUUID gone so;
        // on the object itself only when that did not take, as for a plain crypto object)
        var proto = Object.getPrototypeOf(c);
        if (proto && proto !== Object.prototype) try { proto.randomUUID = uuid; } catch (e) {}
        if (c.randomUUID !== uuid) try { c.randomUUID = uuid; } catch (e2) {}
    })(window.crypto);

    // navigator
    if (!navigator.sendBeacon) navigator.sendBeacon = function (url, data) { try { var x = new XMLHttpRequest(); x.open('POST', url, true); x.send(data); } catch (e) {} return true; };
    if (!navigator.languages) try { navigator.languages = [navigator.language || 'en']; } catch (e4) {}
    // (both listener methods: RxJS fromEvent(navigator.connection, 'change') throws 'Invalid event target' otherwise)
    if (!navigator.connection) navigator.connection = { effectiveType: '3g', saveData: false, onchange: null, addEventListener: function () {}, removeEventListener: function () {}, dispatchEvent: function () { return true; } };
    // navigator.clipboard is provided by shims-extra.js (writes go to the app)
    if (!navigator.serviceWorker) navigator.serviceWorker = { register: function () { return window.Promise ? window.Promise.reject(new Error('unsupported')) : null; }, getRegistrations: function () { return window.Promise ? window.Promise.resolve([]) : null; },
        getRegistration: function () { return window.Promise ? window.Promise.resolve(undefined) : null; }, startMessages: function () {}, addEventListener: function () {}, removeEventListener: function () {},
        controller: null, oncontrollerchange: null, onmessage: null, ready: window.Promise ? new window.Promise(function () {}) : null };
    if (!navigator.storage) navigator.storage = { estimate: function () { return window.Promise ? window.Promise.resolve({ quota: 0, usage: 0 }) : null; } };
    if (!('onLine' in navigator)) navigator.onLine = true;
    if (!navigator.mediaDevices) navigator.mediaDevices = { getUserMedia: function () { return window.Promise ? window.Promise.reject(new Error('unsupported')) : null; }, enumerateDevices: function () { return window.Promise ? window.Promise.resolve([]) : null; } };

    // console
    var con = window.console = window.console || {};
    var names = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'group', 'groupEnd', 'groupCollapsed', 'table', 'time', 'timeEnd', 'timeLog', 'count', 'assert', 'dir', 'dirxml'];
    for (var n = 0; n < names.length; n++) if (!con[names[n]]) con[names[n]] = con.log || function () {};

    // matchMedia listeners (addEventListener form)
    if (window.matchMedia) {
        var mql = window.matchMedia('(min-width: 1px)');
        if (mql && !mql.addEventListener) {
            var MQ = Object.getPrototypeOf(mql);
            MQ.addEventListener = function (t, f) { if (t === 'change') this.addListener(f); };
            MQ.removeEventListener = function (t, f) { if (t === 'change') this.removeListener(f); };
        }
    }

    // Intl: iOS 6 has none. A usable implementation for the languages this device meets (Czech, Slovak, English,
    // German, Polish and a generic fallback): numbers, currencies, dates, plurals, relative times, lists, collation.
    if (!window.Intl) (function () {
        var Intl = window.Intl = {};
        var canon = function (loc) {
            var l = loc && typeof loc === 'object' && loc.length !== undefined ? loc[0] : loc;
            if (l && typeof l === 'object' && l.baseName) l = l.baseName;
            return String(l || navigator.language || 'en').replace(/_/g, '-');
        };
        var lang = function (loc) { return canon(loc).split('-')[0].toLowerCase(); };
        var supportedOf = function (list) { var a = typeof list === 'string' ? [list] : (list || []), out = []; for (var i = 0; i < a.length; i++) if (typeof a[i] === 'string') out.push(a[i]); return out; };
        var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
        // ---- numbers
        // (the spaces are no-break ones, as current engines write them, U+202F narrow in French: a server-rendered
        // page compares its text with the page scripts' own, and a plain space made React throw the whole page away
        // and build it again, rohlik.cz)
        var NB = ' ';
        var SEP = { cs: [NB, ','], sk: [NB, ','], pl: [NB, ','], de: ['.', ','], fr: [' ', ','], it: ['.', ','], es: ['.', ','], ru: [NB, ','], hu: [NB, ','], nl: ['.', ','], pt: ['.', ','], sv: [NB, ','], da: ['.', ','], fi: [NB, ','], nb: [NB, ','], tr: ['.', ','], uk: [NB, ','], en: [',', '.'] };
        var CURRENCY = { CZK: ['Kč', 1], EUR: ['€', 1], USD: ['$', 0], GBP: ['£', 0], PLN: ['zł', 1], HUF: ['Ft', 1], CHF: ['CHF', 0], JPY: ['¥', 0], SEK: ['kr', 1], NOK: ['kr', 1], DKK: ['kr', 1], RUB: ['₽', 1], UAH: ['₴', 1], CNY: ['CN¥', 0], INR: ['₹', 0], BRL: ['R$', 0], CAD: ['CA$', 0], AUD: ['A$', 0] };
        var COMPACT = { cs: ['tis.', 'mil.', 'mld.', 'bil.'], sk: ['tis.', 'mil.', 'mld.', 'bil.'], pl: ['tys.', 'mln', 'mld', 'bln'], de: ['Tsd.', 'Mio.', 'Mrd.', 'Bio.'], en: ['K', 'M', 'B', 'T'] };
        // Numbers are rounded as the engines do it: the shortest decimal that reads back as the number (String(x)), half
        // away from zero (toFixed rounds the binary value: 1.005 gave "1.00", the engines "1.01", 12345 in scientific
        // notation "1.234E4" for "1.235E4"). A decimal is { d: digits, p: point }, the value 0.d x 10^p.
        var decimalOf = function (x) {
            var s = String(x), e = 0, k = s.indexOf('e');
            if (k >= 0) { e = +s.slice(k + 1); s = s.slice(0, k); }
            var dot = s.indexOf('.'), d = dot < 0 ? s : s.slice(0, dot) + s.slice(dot + 1), p = (dot < 0 ? s.length : dot) + e, z = 0;
            while (z < d.length - 1 && d.charAt(z) === '0') z++;
            d = d.slice(z).replace(/0+$/, '');
            return d ? { d: d, p: p - z } : { d: '0', p: 1 };
        };
        var zeros = function (n) { var s = ''; while (n-- > 0) s += '0'; return s; };
        var plusOne = function (s) {
            var i = s.length - 1;
            while (i >= 0 && s.charAt(i) === '9') i--;
            return i < 0 ? '1' + zeros(s.length) : s.slice(0, i) + String.fromCharCode(s.charCodeAt(i) + 1) + zeros(s.length - i - 1);
        };
        // the digits of q rounded to f fraction digits (f < 0: to tens, hundreds...); carry: one more digit before the point
        var roundTo = function (q, f) {
            var n = q.p + f, d = q.d, r, carry = false;
            if (n <= 0) r = n === 0 && d.charAt(0) >= '5' ? '1' : '0';
            else { r = d.length >= n ? d.slice(0, n) : d + zeros(n - d.length); if (d.charAt(n) >= '5') { r = plusOne(r); carry = r.length > n; } }
            if (f < 0) { if (r !== '0') r += zeros(-f); f = 0; }
            while (r.length <= f) r = '0' + r;
            return { i: r.slice(0, r.length - f), f: r.slice(r.length - f), carry: carry };
        };
        var trimFraction = function (f, max, min) {
            f = f.slice(0, max);
            var cut = f.length;
            while (cut > min && f.charAt(cut - 1) === '0') cut--;
            f = f.slice(0, cut);
            return f.length < min ? f + zeros(min - f.length) : f;
        };
        // ECMA-402 rounding by fraction digits, significant digits or both (roundingPriority morePrecision / lessPrecision:
        // the result that rounds at the lower / higher digit): the digits before and after the point, as NumberFormat
        // shows them and PluralRules counts them (1 with minimumFractionDigits 2 is "1.00": other in English)
        var fixedDigits = function (q, minF, maxF) { var r = roundTo(q, maxF); return { i: r.i, f: trimFraction(r.f, maxF, minF), mag: -maxF }; };
        var sigDigits = function (q, minS, maxS) {
            var e = q.d === '0' ? 0 : q.p - 1, r = roundTo(q, maxS - 1 - e), mag = e - maxS + 1;
            if (r.carry) e++;
            return { i: r.i, f: trimFraction(r.f, Math.max(0, maxS - 1 - e), Math.max(0, minS - 1 - e)), mag: mag };
        };
        var roundDigits = function (q, o, minF, maxF) {
            if (typeof q === 'number') q = decimalOf(q);
            var sig = o.minimumSignificantDigits !== undefined || o.maximumSignificantDigits !== undefined;
            var both = o.roundingPriority === 'morePrecision' || o.roundingPriority === 'lessPrecision';
            var fr = !sig || both ? fixedDigits(q, minF, maxF) : null;
            if (!sig && !both) return fr;
            var sr = sigDigits(q, o.minimumSignificantDigits || 1, o.maximumSignificantDigits || 21);
            if (!fr) return sr;
            return (o.roundingPriority === 'morePrecision' ? sr.mag <= fr.mag : sr.mag > fr.mag) ? sr : fr;
        };
        // (NumberFormat, DateTimeFormat and Collator can be called without new: Intl.NumberFormat(lang).format(x) had
        // no this, kosik.cz)
        var NumberFormat = function NumberFormat(locale, opts) {
            if (!(this instanceof NumberFormat)) return new NumberFormat(locale, opts);
            this.locale = canon(locale); this.opts = opts || {};
        };
        NumberFormat.prototype.formatToParts = function (n) {
            var o = this.opts, lg = lang(this.locale), sep = SEP[lg] || SEP.en, v = Number(n), parts = [];
            if (isNaN(v)) return [{ type: 'nan', value: 'NaN' }];
            if (!isFinite(v)) return [{ type: v < 0 ? 'minusSign' : 'plusSign', value: v < 0 ? '-' : '' }, { type: 'infinity', value: '∞' }];
            var style = o.style || 'decimal', currency = o.currency ? String(o.currency).toUpperCase() : null;
            var q = decimalOf(Math.abs(v)), zero = q.d === '0', unitSuffix = '', idx = -1, exp = null;
            if (style === 'percent') q.p += 2;
            var sci = o.notation === 'scientific' || o.notation === 'engineering', compact = o.notation === 'compact';
            // (compact: thousands, millions... by the digits before the point; scientific: one digit before the point,
            // engineering: an exponent that is a multiple of 3)
            if (compact && !zero && q.p >= 4) { idx = Math.min(3, Math.floor((q.p - 1) / 3) - 1); q.p -= 3 * (idx + 1); }
            if (sci) { exp = zero ? 0 : q.p - 1; if (o.notation === 'engineering') exp -= ((exp % 3) + 3) % 3; q.p -= exp; }
            var minF = o.minimumFractionDigits, maxF = o.maximumFractionDigits;
            // (compact numbers keep two significant digits: 1.2K, 12K, 123K)
            if (maxF === undefined) maxF = style === 'currency' ? (currency === 'JPY' || currency === 'HUF' ? 0 : 2) : style === 'percent' && !sci ? 0 : compact ? (zero || q.p <= 1 ? 1 : 0) : 3;
            if (minF === undefined) minF = style === 'currency' ? maxF : 0;
            if (minF > maxF) maxF = minF;
            var dg = roundDigits(q, o, minF, maxF);
            // (rounded up past the unit: 999.96K is 1M, 9.9999 is 1E1)
            var over = sci ? (o.notation === 'engineering' ? 3 : 1) : compact && idx < 3 ? 3 : 0;
            if (over && dg.i.length > over) {
                if (sci) exp += over; else idx++;
                q.p -= over;
                dg = roundDigits(q, o, minF, compact && o.maximumFractionDigits === undefined ? (q.p <= 1 ? 1 : 0) : maxF);
            }
            if (idx >= 0) unitSuffix = (lg === 'en' ? '' : NB) + (COMPACT[lg] || COMPACT.en)[idx];
            var intPart = dg.i, frac = dg.f, shownZero = /^0*$/.test(intPart + frac), neg = v < 0 || (v === 0 && 1 / v < 0);
            if (o.minimumIntegerDigits) while (intPart.length < o.minimumIntegerDigits) intPart = '0' + intPart;
            // Polish, Spanish and Portuguese group only from five digits on (CLDR minimumGroupingDigits 2), compact numbers
            // too by default (3000T)
            var ug = o.useGrouping === undefined && compact ? 'min2' : o.useGrouping;
            var grouping = ug !== false && !(ug === 'min2' && intPart.length < 5) && (lg !== 'pl' && lg !== 'es' && lg !== 'pt' || intPart.length > 4 || ug === true || ug === 'always');
            var groups = [];
            if (grouping) { var s = intPart; while (s.length > 3) { groups.unshift(s.slice(-3)); s = s.slice(0, -3); } groups.unshift(s); } else groups.push(intPart);
            var sd = o.signDisplay || 'auto';
            var sign = sd === 'never' || (shownZero && (sd === 'exceptZero' || sd === 'negative')) ? '' : neg ? (sd === 'negative' || sd === 'auto' || sd === 'always' || sd === 'exceptZero' ? '-' : '') : sd === 'always' || sd === 'exceptZero' ? '+' : '';
            var cur = style === 'currency' && currency ? (o.currencyDisplay === 'code' ? currency : o.currencyDisplay === 'name' ? currency : (CURRENCY[currency] ? CURRENCY[currency][0] : currency)) : null;
            var curAfter = cur ? (lg === 'en' ? 0 : (CURRENCY[currency] && o.currencyDisplay !== 'code' ? CURRENCY[currency][1] : 1)) : 0;
            if (sign) parts.push({ type: sign === '-' ? 'minusSign' : 'plusSign', value: sign });
            if (cur && !curAfter) parts.push({ type: 'currency', value: cur }, { type: 'literal', value: lg === 'en' ? '' : NB });
            for (var g = 0; g < groups.length; g++) { if (g) parts.push({ type: 'group', value: sep[0] }); parts.push({ type: 'integer', value: groups[g] }); }
            if (frac) parts.push({ type: 'decimal', value: sep[1] }, { type: 'fraction', value: frac });
            if (exp !== null) {
                parts.push({ type: 'exponentSeparator', value: 'E' });
                if (exp < 0) parts.push({ type: 'exponentMinusSign', value: '-' });
                parts.push({ type: 'exponentInteger', value: String(Math.abs(exp)) });
            }
            if (unitSuffix) parts.push({ type: 'compact', value: unitSuffix });
            if (style === 'percent') parts.push({ type: 'literal', value: lg === 'en' ? '' : NB }, { type: 'percentSign', value: '%' });
            if (style === 'unit' && o.unit) {
                // (long names in English: "1 bit", "1E4 bits"; other languages keep the short ones)
                var one = exp === null && pluralFor('en', +(intPart + (frac ? '.' + frac : '')), false, frac.length) === 'one';
                parts.push({ type: 'literal', value: ' ' }, { type: 'unit', value: o.unitDisplay === 'long' && lg === 'en' ? unitLongEn(String(o.unit), one) : UNIT_SHORT[o.unit] || o.unit });
            }
            if (cur && curAfter) parts.push({ type: 'literal', value: NB }, { type: 'currency', value: cur });
            var out = [];
            for (var i = 0; i < parts.length; i++) if (parts[i].value !== '') out.push(parts[i]);
            return out;
        };
        var UNIT_SHORT = { kilometer: 'km', meter: 'm', centimeter: 'cm', millimeter: 'mm', kilogram: 'kg', gram: 'g', liter: 'l', milliliter: 'ml', celsius: '°C', fahrenheit: '°F', percent: '%', second: 's', minute: 'min', hour: 'h', day: 'd', byte: 'B', kilobyte: 'kB', megabyte: 'MB', gigabyte: 'GB', 'kilometer-per-hour': 'km/h', 'mile-per-hour': 'mph', mile: 'mi', foot: 'ft', inch: 'in' };
        var UNIT_LONG_EN = { foot: ['foot', 'feet'], inch: ['inch', 'inches'], century: ['century', 'centuries'], celsius: ['degree Celsius', 'degrees Celsius'], fahrenheit: ['degree Fahrenheit', 'degrees Fahrenheit'], percent: ['percent', 'percent'] };
        var unitLongEn = function (u, one) {
            var per = u.indexOf('-per-');
            if (per > 0) return unitLongEn(u.slice(0, per), one) + ' per ' + unitLongEn(u.slice(per + 5), true);
            return UNIT_LONG_EN[u] ? UNIT_LONG_EN[u][one ? 0 : 1] : one ? u : u + 's';
        };
        NumberFormat.prototype.format = function (n) { var p = this.formatToParts(n), s = ''; for (var i = 0; i < p.length; i++) s += p[i].value; return s; };
        NumberFormat.prototype.formatRange = function (a, b) { return this.format(a) + ' – ' + this.format(b); };
        NumberFormat.prototype.resolvedOptions = function () {
            var o = this.opts, r = { locale: this.locale, numberingSystem: 'latn', style: o.style || 'decimal', useGrouping: o.useGrouping === undefined ? 'auto' : o.useGrouping, notation: o.notation || 'standard', signDisplay: o.signDisplay || 'auto', minimumIntegerDigits: o.minimumIntegerDigits || 1, minimumFractionDigits: o.minimumFractionDigits === undefined ? 0 : o.minimumFractionDigits, maximumFractionDigits: o.maximumFractionDigits === undefined ? 3 : o.maximumFractionDigits, roundingPriority: o.roundingPriority || 'auto' };
            if (o.minimumSignificantDigits !== undefined || o.maximumSignificantDigits !== undefined) { r.minimumSignificantDigits = o.minimumSignificantDigits || 1; r.maximumSignificantDigits = o.maximumSignificantDigits || 21; }
            if (o.notation === 'compact') r.compactDisplay = o.compactDisplay || 'short';
            if (o.currency) { r.currency = String(o.currency).toUpperCase(); r.currencyDisplay = o.currencyDisplay || 'symbol'; r.currencySign = o.currencySign || 'standard'; }
            if (o.unit) { r.unit = o.unit; r.unitDisplay = o.unitDisplay || 'short'; }
            return r;
        };
        NumberFormat.supportedLocalesOf = supportedOf;
        Intl.NumberFormat = NumberFormat;
        // ---- dates
        var L = {
            cs: { months: ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'], monthsStandalone: ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'], monthsShort: ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'], days: ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'], daysShort: ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'], numeric: 'd. m. y', dayMonth: 'd. m.', long: 'd. MMMM y', medium: 'd. M. y', h24: true, dayFirst: true, dateTimeSep: ' ', dayPeriods: ['dop.', 'odp.'] },
            sk: { months: ['januára', 'februára', 'marca', 'apríla', 'mája', 'júna', 'júla', 'augusta', 'septembra', 'októbra', 'novembra', 'decembra'], monthsStandalone: ['január', 'február', 'marec', 'apríl', 'máj', 'jún', 'júl', 'august', 'september', 'október', 'november', 'december'], monthsShort: ['jan', 'feb', 'mar', 'apr', 'máj', 'jún', 'júl', 'aug', 'sep', 'okt', 'nov', 'dec'], days: ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'], daysShort: ['ne', 'po', 'ut', 'st', 'št', 'pi', 'so'], numeric: 'd. m. y', dayMonth: 'd. m.', long: 'd. MMMM y', medium: 'd. M. y', h24: true, dayFirst: true, dateTimeSep: ' ', dayPeriods: ['AM', 'PM'] },
            de: { months: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'], monthsShort: ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'], days: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'], daysShort: ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'], numeric: 'd.m.y', dayMonth: 'd.m.', long: 'd. MMMM y', medium: 'dd.mm.y', h24: true, dayFirst: true, dateTimeSep: ', ', dayPeriods: ['AM', 'PM'] },
            pl: { months: ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'], monthsStandalone: ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'], monthsShort: ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'], days: ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'], daysShort: ['niedz.', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.'], numeric: 'dd.mm.y', dayMonth: 'dd.mm', long: 'd MMMM y', medium: 'd MMM y', h24: true, dayFirst: true, dateTimeSep: ', ', dayPeriods: ['AM', 'PM'] },
            en: { months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'], monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], daysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], numeric: 'm/d/y', dayMonth: 'm/d', long: 'MMMM d, y', medium: 'MMM d, y', h24: false, dayFirst: false, dateTimeSep: ', ', dayPeriods: ['AM', 'PM'] }
        };
        var localeData = function (loc) {
            var lg = lang(loc), d = L[lg] || L.en, region = canon(loc).split('-')[1];
            if (lg === 'en' && region && region !== 'US') return { months: d.months, monthsShort: d.monthsShort, days: d.days, daysShort: d.daysShort, numeric: 'dd/mm/y', dayMonth: 'dd/mm', long: 'd MMMM y', medium: 'd MMM y', h24: true, dayFirst: true, dateTimeSep: ', ', dayPeriods: d.dayPeriods };
            return d;
        };
        // (as in the engines, dateStyle / timeStyle do not mix with single fields: FormatJS takes an engine that allows
        // it for an old one and puts its own DateTimeFormat in)
        var DTF_FIELDS = ['weekday', 'era', 'year', 'month', 'day', 'dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits', 'timeZoneName'];
        var DateTimeFormat = function DateTimeFormat(locale, opts) {
            if (!(this instanceof DateTimeFormat)) return new DateTimeFormat(locale, opts);
            this.locale = canon(locale); this.opts = opts || {}; this.data = localeData(this.locale);
            var o = this.opts;
            if (o.dateStyle !== undefined || o.timeStyle !== undefined) {
                for (var i = 0; i < DTF_FIELDS.length; i++) if (o[DTF_FIELDS[i]] !== undefined) throw new TypeError("Can't set option " + DTF_FIELDS[i] + ' when ' + (o.dateStyle !== undefined ? 'dateStyle' : 'timeStyle') + ' is used');
            }
        };
        var fields = function (d, utc) {
            return utc ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds() }
                       : { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), wd: d.getDay(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), ms: d.getMilliseconds() };
        };
        DateTimeFormat.prototype.formatToParts = function (date) {
            var d = date instanceof Date ? date : new Date(date === undefined ? Date.now() : date);
            if (isNaN(d.getTime())) throw new RangeError('Invalid time value');
            var o = this.opts, data = this.data, utc = /^(utc|gmt|etc\/utc)$/i.test(o.timeZone || ''), f = fields(d, utc), parts = [];
            var lit = function (v) { parts.push({ type: 'literal', value: v }); };
            var wantDate = o.dateStyle || o.year || o.month || o.day || o.weekday || o.era;
            var wantTime = o.timeStyle || o.hour || o.minute || o.second || o.dayPeriod || o.fractionalSecondDigits;
            var yearS = o.year === '2-digit' ? String(f.y).slice(-2) : String(f.y);
            var dayS = o.day === '2-digit' ? pad2(f.d) : String(f.d);
            var monthStyle = o.month || (o.dateStyle === 'full' || o.dateStyle === 'long' ? 'long' : o.dateStyle === 'medium' ? (/^(cs|sk|de)$/.test(lang(this.locale)) ? 'numeric' : 'short') : 'numeric');
            if (!wantDate && !wantTime) { wantDate = true; monthStyle = 'numeric'; o = { year: 'numeric', month: 'numeric', day: 'numeric' }; }
            if (wantDate) {
                var weekday = o.weekday || (o.dateStyle === 'full' ? 'long' : null);
                if (weekday) { parts.push({ type: 'weekday', value: weekday === 'long' ? data.days[f.wd] : data.daysShort[f.wd] }); if (o.month || o.dateStyle || o.day) lit(data.dayFirst ? ' ' : ', '); }
                var hasY = o.year || o.dateStyle, hasM = o.month || o.dateStyle, hasD = o.day || o.dateStyle;
                if (monthStyle === 'long' || monthStyle === 'short' || monthStyle === 'narrow') {
                    var mName = monthStyle === 'long' ? ((hasD || !data.monthsStandalone) ? data.months[f.mo] : data.monthsStandalone[f.mo]) : data.monthsShort[f.mo];
                    if (data.dayFirst) {
                        if (hasD) { parts.push({ type: 'day', value: dayS }); lit(/^(cs|sk|de|hu|fi|da|nb)$/.test(lang(this.locale)) ? '. ' : ' '); }
                        parts.push({ type: 'month', value: mName });
                        if (hasY) { lit(' '); parts.push({ type: 'year', value: yearS }); }
                    } else {
                        parts.push({ type: 'month', value: mName });
                        if (hasD) { lit(' '); parts.push({ type: 'day', value: dayS }); }
                        if (hasY) { lit(', '); parts.push({ type: 'year', value: yearS }); }
                    }
                } else if (hasM || hasD || hasY) {
                    var monS = o.month === '2-digit' || /mm/.test(data.numeric) ? pad2(f.mo + 1) : String(f.mo + 1);
                    if (/dd/.test(data.numeric)) dayS = pad2(f.d);
                    var sepD = data.numeric.indexOf('/') >= 0 ? '/' : data.numeric.indexOf(' ') >= 0 ? '. ' : '.';
                    var seq = [];
                    if (data.dayFirst) { if (hasD) seq.push(['day', dayS]); if (hasM) seq.push(['month', monS]); if (hasY) seq.push(['year', yearS]); }
                    else { if (hasM) seq.push(['month', monS]); if (hasD) seq.push(['day', dayS]); if (hasY) seq.push(['year', yearS]); }
                    for (var i = 0; i < seq.length; i++) {
                        parts.push({ type: seq[i][0], value: seq[i][1] });
                        if (i < seq.length - 1) lit(sepD);
                        else if (sepD !== '/' && seq[i][0] !== 'year' && data.dayFirst) lit(sepD.charAt(0));
                    }
                }
                if (wantTime) lit(data.dateTimeSep);   // ("Sep 28, 2026, 2:05 PM", "28. 9. 2026 14:05")
            }
            if (wantTime) {
                var h12 = o.hour12 !== undefined ? o.hour12 : (o.hourCycle ? o.hourCycle === 'h12' || o.hourCycle === 'h11' : !data.h24);
                var hour = f.h, period = null;
                if (h12) { period = hour < 12 ? data.dayPeriods[0] : data.dayPeriods[1]; hour = hour % 12; if (hour === 0 && o.hourCycle !== 'h11') hour = 12; }
                else if (hour === 0 && o.hourCycle === 'h24') hour = 24;
                var showH = o.hour || o.timeStyle, showM = o.minute || o.timeStyle, showS = o.second || (o.timeStyle && o.timeStyle !== 'short');
                if (showH) parts.push({ type: 'hour', value: o.hour === '2-digit' || (!h12 && o.hour !== 'numeric') ? pad2(hour) : String(hour) });
                if (showM) { if (showH) lit(':'); parts.push({ type: 'minute', value: pad2(f.mi) }); }
                if (showS) { lit(':'); parts.push({ type: 'second', value: pad2(f.s) }); }
                if (o.fractionalSecondDigits) { lit('.'); parts.push({ type: 'fractionalSecond', value: String(f.ms + 1000).slice(1, 1 + o.fractionalSecondDigits) }); }
                if (period && showH) { lit(' '); parts.push({ type: 'dayPeriod', value: period }); }
                if (o.timeZoneName) { lit(' '); parts.push({ type: 'timeZoneName', value: utc ? 'UTC' : 'GMT' + (d.getTimezoneOffset() ? (d.getTimezoneOffset() > 0 ? '-' : '+') + Math.abs(d.getTimezoneOffset() / 60) : '') }); }
            }
            return parts;
        };
        DateTimeFormat.prototype.format = function (d) { var p = this.formatToParts(d), s = ''; for (var i = 0; i < p.length; i++) s += p[i].value; return s; };
        DateTimeFormat.prototype.formatRange = function (a, b) { return this.format(a) + ' – ' + this.format(b); };
        DateTimeFormat.prototype.formatRangeToParts = function (a, b) { return this.formatToParts(a).concat([{ type: 'literal', value: ' – ' }], this.formatToParts(b)); };
        DateTimeFormat.prototype.resolvedOptions = function () { var o = this.opts, r = { locale: this.locale, calendar: 'gregory', numberingSystem: 'latn', timeZone: o.timeZone || 'Europe/Prague' }; var keys = ['weekday', 'era', 'year', 'month', 'day', 'hour', 'minute', 'second', 'timeZoneName', 'hour12', 'dateStyle', 'timeStyle']; for (var i = 0; i < keys.length; i++) if (o[keys[i]] !== undefined) r[keys[i]] = o[keys[i]]; return r; };
        DateTimeFormat.supportedLocalesOf = supportedOf;
        Intl.DateTimeFormat = DateTimeFormat;
        // ---- plural rules (CLDR): cs/sk one, few (2-4), many (fractions), other; pl one, few, many, other; ru/uk; en/de/... one, other
        // (v: the fraction digits shown, when known: "1.00" is not an integer for the rules)
        var pluralFor = function (lg, n, ordinal, v) {
            var i = Math.floor(Math.abs(n)), isInt = v === undefined ? Math.abs(n) === i : v === 0;
            if (ordinal) {
                if (lg === 'en') { var m10 = i % 10, m100 = i % 100; return m10 === 1 && m100 !== 11 ? 'one' : m10 === 2 && m100 !== 12 ? 'two' : m10 === 3 && m100 !== 13 ? 'few' : 'other'; }
                return 'other';
            }
            switch (lg) {
                case 'cs': case 'sk': return !isInt ? 'many' : i === 1 ? 'one' : i >= 2 && i <= 4 ? 'few' : 'other';
                case 'pl': { var p10 = i % 10, p100 = i % 100; return !isInt ? 'other' : i === 1 ? 'one' : p10 >= 2 && p10 <= 4 && (p100 < 12 || p100 > 14) ? 'few' : 'many'; }
                case 'ru': case 'uk': { var r10 = i % 10, r100 = i % 100; return !isInt ? 'other' : r10 === 1 && r100 !== 11 ? 'one' : r10 >= 2 && r10 <= 4 && (r100 < 12 || r100 > 14) ? 'few' : 'many'; }
                case 'fr': case 'pt': return i === 0 || i === 1 ? 'one' : 'other';
                case 'ja': case 'zh': case 'ko': case 'vi': case 'th': case 'tr': case 'hu': return 'other';
                default: return isInt && i === 1 ? 'one' : 'other';
            }
        };
        var PluralRules = function PluralRules(locale, opts) { this.locale = canon(locale); this.opts = opts || {}; this.type = this.opts.type === 'ordinal' ? 'ordinal' : 'cardinal'; };
        // (the number as NumberFormat shows it with the digit options: 1 with minimumFractionDigits 2 is "1.00")
        PluralRules.prototype.select = function (n) {
            var o = this.opts, x = Number(n);
            if (!isFinite(x)) return 'other';
            var minF = o.minimumFractionDigits || 0, maxF = o.maximumFractionDigits !== undefined ? o.maximumFractionDigits : Math.max(minF, 3);
            var d = roundDigits(Math.abs(x), o, minF, Math.max(minF, maxF));
            return pluralFor(lang(this.locale), +(d.i + (d.f ? '.' + d.f : '')), this.type === 'ordinal', d.f.length);
        };
        PluralRules.prototype.selectRange = function (a, b) { return this.select(b); };
        PluralRules.prototype.resolvedOptions = function () {
            var o = this.opts, lg = lang(this.locale), minF = o.minimumFractionDigits || 0;
            var r = { locale: this.locale, type: this.type, minimumIntegerDigits: o.minimumIntegerDigits || 1, minimumFractionDigits: minF, maximumFractionDigits: o.maximumFractionDigits !== undefined ? o.maximumFractionDigits : Math.max(minF, 3),
                      pluralCategories: this.type === 'ordinal' ? (lg === 'en' ? ['one', 'two', 'few', 'other'] : ['other']) : lg === 'cs' || lg === 'sk' || lg === 'pl' || lg === 'ru' || lg === 'uk' ? ['one', 'few', 'many', 'other'] : lg === 'ja' || lg === 'zh' || lg === 'ko' || lg === 'vi' || lg === 'th' || lg === 'tr' || lg === 'hu' ? ['other'] : ['one', 'other'], roundingPriority: o.roundingPriority || 'auto' };
            if (o.minimumSignificantDigits !== undefined || o.maximumSignificantDigits !== undefined) { r.minimumSignificantDigits = o.minimumSignificantDigits || 1; r.maximumSignificantDigits = o.maximumSignificantDigits || 21; }
            return r;
        };
        PluralRules.supportedLocalesOf = supportedOf;
        Intl.PluralRules = PluralRules;
        // ---- relative time
        var RT = {
            cs: { units: { second: ['sekundu', 'sekundy', 'sekund'], minute: ['minutu', 'minuty', 'minut'], hour: ['hodinu', 'hodiny', 'hodin'], day: ['den', 'dny', 'dní'], week: ['týden', 'týdny', 'týdnů'], month: ['měsíc', 'měsíce', 'měsíců'], quarter: ['čtvrtletí', 'čtvrtletí', 'čtvrtletí'], year: ['rok', 'roky', 'let'] }, past: 'před {0}', future: 'za {0}', pastUnits: { second: ['sekundou', 'sekundami', 'sekundami'], minute: ['minutou', 'minutami', 'minutami'], hour: ['hodinou', 'hodinami', 'hodinami'], day: ['dnem', 'dny', 'dny'], week: ['týdnem', 'týdny', 'týdny'], month: ['měsícem', 'měsíci', 'měsíci'], quarter: ['čtvrtletím', 'čtvrtletími', 'čtvrtletími'], year: ['rokem', 'lety', 'lety'] }, auto: { day: { '-1': 'včera', '0': 'dnes', '1': 'zítra', '-2': 'předevčírem', '2': 'pozítří' }, week: { '-1': 'minulý týden', '0': 'tento týden', '1': 'příští týden' }, month: { '-1': 'minulý měsíc', '0': 'tento měsíc', '1': 'příští měsíc' }, year: { '-1': 'loni', '0': 'letos', '1': 'příští rok' }, second: { '0': 'nyní' } } },
            en: { units: { second: ['second', 'seconds'], minute: ['minute', 'minutes'], hour: ['hour', 'hours'], day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], quarter: ['quarter', 'quarters'], year: ['year', 'years'] }, past: '{0} ago', future: 'in {0}', auto: { day: { '-1': 'yesterday', '0': 'today', '1': 'tomorrow' }, week: { '-1': 'last week', '0': 'this week', '1': 'next week' }, month: { '-1': 'last month', '0': 'this month', '1': 'next month' }, year: { '-1': 'last year', '0': 'this year', '1': 'next year' }, second: { '0': 'now' } } },
            de: { units: { second: ['Sekunde', 'Sekunden'], minute: ['Minute', 'Minuten'], hour: ['Stunde', 'Stunden'], day: ['Tag', 'Tagen'], week: ['Woche', 'Wochen'], month: ['Monat', 'Monaten'], quarter: ['Quartal', 'Quartalen'], year: ['Jahr', 'Jahren'] }, past: 'vor {0}', future: 'in {0}', auto: { day: { '-1': 'gestern', '0': 'heute', '1': 'morgen' }, week: { '-1': 'letzte Woche', '0': 'diese Woche', '1': 'nächste Woche' }, month: { '-1': 'letzten Monat', '0': 'diesen Monat', '1': 'nächsten Monat' }, year: { '-1': 'letztes Jahr', '0': 'dieses Jahr', '1': 'nächstes Jahr' }, second: { '0': 'jetzt' } } }
        };
        RT.sk = RT.cs;
        var RelativeTimeFormat = function RelativeTimeFormat(locale, opts) { this.locale = canon(locale); this.opts = opts || {}; };
        RelativeTimeFormat.prototype.format = function (value, unit) {
            var lg = lang(this.locale), t = RT[lg] || RT.en, u = String(unit).replace(/s$/, ''), v = Number(value);
            if (!t.units[u]) throw new RangeError('Invalid unit argument for format(): ' + unit);
            if (this.opts.numeric === 'auto' && t.auto[u] && t.auto[u][String(v)]) return t.auto[u][String(v)];
            var n = Math.abs(v), form = pluralFor(lg, n), names = (v < 0 && t.pastUnits ? t.pastUnits : t.units)[u];
            var word = names.length === 3 ? (form === 'one' ? names[0] : form === 'few' ? names[1] : names[2]) : (form === 'one' ? names[0] : names[1]);
            var num = new NumberFormat(this.locale).format(n);
            return (v < 0 || (v === 0 && 1 / v < 0) ? t.past : t.future).replace('{0}', num + ' ' + word);
        };
        RelativeTimeFormat.prototype.formatToParts = function (value, unit) { return [{ type: 'literal', value: this.format(value, unit) }]; };
        RelativeTimeFormat.prototype.resolvedOptions = function () { return { locale: this.locale, style: this.opts.style || 'long', numeric: this.opts.numeric || 'always', numberingSystem: 'latn' }; };
        RelativeTimeFormat.supportedLocalesOf = supportedOf;
        Intl.RelativeTimeFormat = RelativeTimeFormat;
        // ---- lists, collation, display names, locales, segmenter
        var LIST = { cs: [' a ', ' nebo '], sk: [' a ', ' alebo '], de: [' und ', ' oder '], pl: [' i ', ' lub '], fr: [' et ', ' ou '], es: [' y ', ' o '], en: [' and ', ' or '] };
        var ListFormat = function ListFormat(locale, opts) { this.locale = canon(locale); this.opts = opts || {}; };
        ListFormat.prototype.format = function (list) {
            var a = [], i; for (i = 0; i < list.length; i++) a.push(String(list[i]));
            var lg = lang(this.locale), w = LIST[lg] || LIST.en, word = this.opts.type === 'disjunction' ? w[1] : this.opts.type === 'unit' ? (this.opts.style === 'narrow' ? ' ' : ', ') : w[0];
            if (a.length <= 1) return a.join('');
            if (a.length === 2) return a[0] + word + a[1];
            return a.slice(0, -1).join(', ') + (lg === 'en' && this.opts.type !== 'unit' ? ',' : '') + word + a[a.length - 1];
        };
        ListFormat.prototype.formatToParts = function (list) { return [{ type: 'literal', value: this.format(list) }]; };
        ListFormat.prototype.resolvedOptions = function () { return { locale: this.locale, type: this.opts.type || 'conjunction', style: this.opts.style || 'long' }; };
        ListFormat.supportedLocalesOf = supportedOf;
        Intl.ListFormat = ListFormat;
        var Collator = function Collator(locale, opts) {
            if (!(this instanceof Collator)) return new Collator(locale, opts);
            this.locale = canon(locale); this.opts = opts || {}; var self = this; this.compare = function (a, b) { return self.compareStrings(a, b); };
        };
        Collator.prototype.compareStrings = function (a, b) {
            a = String(a); b = String(b);
            var o = this.opts;
            if (o.sensitivity === 'base' || o.sensitivity === 'accent') { a = a.toLowerCase(); b = b.toLowerCase(); }
            if (o.ignorePunctuation) { a = a.replace(/[\s\-_.,;:!?'"()]/g, ''); b = b.replace(/[\s\-_.,;:!?'"()]/g, ''); }
            if (o.numeric) {
                var ra = a.match(/(\d+|\D+)/g) || [], rb = b.match(/(\d+|\D+)/g) || [];
                for (var i = 0; i < Math.min(ra.length, rb.length); i++) {
                    var da = /^\d/.test(ra[i]), db = /^\d/.test(rb[i]);
                    var c = da && db ? (parseInt(ra[i], 10) - parseInt(rb[i], 10)) : ra[i].localeCompare(rb[i]);
                    if (c) return c < 0 ? -1 : 1;
                }
                return ra.length - rb.length;
            }
            var r = a.localeCompare(b);
            return r < 0 ? -1 : r > 0 ? 1 : 0;
        };
        Collator.prototype.resolvedOptions = function () { return { locale: this.locale, usage: this.opts.usage || 'sort', sensitivity: this.opts.sensitivity || 'variant', ignorePunctuation: !!this.opts.ignorePunctuation, collation: 'default', numeric: !!this.opts.numeric, caseFirst: this.opts.caseFirst || 'false' }; };
        Collator.supportedLocalesOf = supportedOf;
        Intl.Collator = Collator;
        // display names: English complete for regions, Czech for the common ones (else the English name); the tables are
        // text until first used. (A region FormatJS asks about, CA, or a script, arab, that came back as its code made
        // it put its own DisplayNames in.)
        var DN = {
            en: {
                region: 'AC:Ascension Island|AD:Andorra|AE:United Arab Emirates|AF:Afghanistan|AG:Antigua & Barbuda|AI:Anguilla|AL:Albania|AM:Armenia|AO:Angola|AQ:Antarctica|AR:Argentina|AS:American Samoa|AT:Austria|AU:Australia|AW:Aruba|AX:Åland Islands|AZ:Azerbaijan|BA:Bosnia & Herzegovina|BB:Barbados|BD:Bangladesh|BE:Belgium|BF:Burkina Faso|BG:Bulgaria|BH:Bahrain|BI:Burundi|BJ:Benin|BL:St. Barthélemy|BM:Bermuda|BN:Brunei|BO:Bolivia|BQ:Caribbean Netherlands|BR:Brazil|BS:Bahamas|BT:Bhutan|BV:Bouvet Island|BW:Botswana|BY:Belarus|BZ:Belize|CA:Canada|CC:Cocos (Keeling) Islands|CD:Congo - Kinshasa|CF:Central African Republic|CG:Congo - Brazzaville|CH:Switzerland|CI:Côte d’Ivoire|CK:Cook Islands|CL:Chile|CM:Cameroon|CN:China|CO:Colombia|CP:Clipperton Island|CR:Costa Rica|CU:Cuba|CV:Cape Verde|CW:Curaçao|CX:Christmas Island|CY:Cyprus|CZ:Czechia|DE:Germany|DG:Diego Garcia|DJ:Djibouti|DK:Denmark|DM:Dominica|DO:Dominican Republic|DZ:Algeria|EA:Ceuta & Melilla|EC:Ecuador|EE:Estonia|EG:Egypt|EH:Western Sahara|ER:Eritrea|ES:Spain|ET:Ethiopia|EU:European Union|EZ:Eurozone|FI:Finland|FJ:Fiji|FK:Falkland Islands|FM:Micronesia|FO:Faroe Islands|FR:France|GA:Gabon|GB:United Kingdom|GD:Grenada|GE:Georgia|GF:French Guiana|GG:Guernsey|GH:Ghana|GI:Gibraltar|GL:Greenland|GM:Gambia|GN:Guinea|GP:Guadeloupe|GQ:Equatorial Guinea|GR:Greece|GS:South Georgia & South Sandwich Islands|GT:Guatemala|GU:Guam|GW:Guinea-Bissau|GY:Guyana|HK:Hong Kong|HM:Heard & McDonald Islands|HN:Honduras|HR:Croatia|HT:Haiti|HU:Hungary|IC:Canary Islands|ID:Indonesia|IE:Ireland|IL:Israel|IM:Isle of Man|IN:India|IO:British Indian Ocean Territory|IQ:Iraq|IR:Iran|IS:Iceland|IT:Italy|JE:Jersey|JM:Jamaica|JO:Jordan|JP:Japan|KE:Kenya|KG:Kyrgyzstan|KH:Cambodia|KI:Kiribati|KM:Comoros|KN:St. Kitts & Nevis|KP:North Korea|KR:South Korea|KW:Kuwait|KY:Cayman Islands|KZ:Kazakhstan|LA:Laos|LB:Lebanon|LC:St. Lucia|LI:Liechtenstein|LK:Sri Lanka|LR:Liberia|LS:Lesotho|LT:Lithuania|LU:Luxembourg|LV:Latvia|LY:Libya|MA:Morocco|MC:Monaco|MD:Moldova|ME:Montenegro|MF:St. Martin|MG:Madagascar|MH:Marshall Islands|MK:North Macedonia|ML:Mali|MM:Myanmar (Burma)|MN:Mongolia|MO:Macao|MP:Northern Mariana Islands|MQ:Martinique|MR:Mauritania|MS:Montserrat|MT:Malta|MU:Mauritius|MV:Maldives|MW:Malawi|MX:Mexico|MY:Malaysia|MZ:Mozambique|NA:Namibia|NC:New Caledonia|NE:Niger|NF:Norfolk Island|NG:Nigeria|NI:Nicaragua|NL:Netherlands|NO:Norway|NP:Nepal|NR:Nauru|NU:Niue|NZ:New Zealand|OM:Oman|PA:Panama|PE:Peru|PF:French Polynesia|PG:Papua New Guinea|PH:Philippines|PK:Pakistan|PL:Poland|PM:St. Pierre & Miquelon|PN:Pitcairn Islands|PR:Puerto Rico|PS:Palestinian Territories|PT:Portugal|PW:Palau|PY:Paraguay|QA:Qatar|QO:Outlying Oceania|RE:Réunion|RO:Romania|RS:Serbia|RU:Russia|RW:Rwanda|SA:Saudi Arabia|SB:Solomon Islands|SC:Seychelles|SD:Sudan|SE:Sweden|SG:Singapore|SH:St. Helena|SI:Slovenia|SJ:Svalbard & Jan Mayen|SK:Slovakia|SL:Sierra Leone|SM:San Marino|SN:Senegal|SO:Somalia|SR:Suriname|SS:South Sudan|ST:São Tomé & Príncipe|SV:El Salvador|SX:Sint Maarten|SY:Syria|SZ:Eswatini|TA:Tristan da Cunha|TC:Turks & Caicos Islands|TD:Chad|TF:French Southern Territories|TG:Togo|TH:Thailand|TJ:Tajikistan|TK:Tokelau|TL:Timor-Leste|TM:Turkmenistan|TN:Tunisia|TO:Tonga|TR:Türkiye|TT:Trinidad & Tobago|TV:Tuvalu|TW:Taiwan|TZ:Tanzania|UA:Ukraine|UG:Uganda|UM:U.S. Outlying Islands|UN:United Nations|US:United States|UY:Uruguay|UZ:Uzbekistan|VA:Vatican City|VC:St. Vincent & Grenadines|VE:Venezuela|VG:British Virgin Islands|VI:U.S. Virgin Islands|VN:Vietnam|VU:Vanuatu|WF:Wallis & Futuna|WS:Samoa|XK:Kosovo|YE:Yemen|YT:Mayotte|ZA:South Africa|ZM:Zambia|ZW:Zimbabwe|001:world|002:Africa|003:North America|005:South America|009:Oceania|011:Western Africa|013:Central America|014:Eastern Africa|015:Northern Africa|017:Middle Africa|018:Southern Africa|019:Americas|021:Northern America|029:Caribbean|030:Eastern Asia|034:Southern Asia|035:Southeast Asia|039:Southern Europe|053:Australasia|054:Melanesia|057:Micronesian Region|061:Polynesia|142:Asia|143:Central Asia|145:Western Asia|150:Europe|151:Eastern Europe|154:Northern Europe|155:Western Europe|202:Sub-Saharan Africa|419:Latin America',
                language: 'af:Afrikaans|am:Amharic|ar:Arabic|az:Azerbaijani|be:Belarusian|bg:Bulgarian|bn:Bangla|bs:Bosnian|ca:Catalan|cs:Czech|cy:Welsh|da:Danish|de:German|el:Greek|en:English|eo:Esperanto|es:Spanish|et:Estonian|eu:Basque|fa:Persian|fi:Finnish|fil:Filipino|fr:French|ga:Irish|gl:Galician|gu:Gujarati|he:Hebrew|hi:Hindi|hr:Croatian|hu:Hungarian|hy:Armenian|id:Indonesian|is:Icelandic|it:Italian|ja:Japanese|ka:Georgian|kk:Kazakh|km:Khmer|kn:Kannada|ko:Korean|ky:Kyrgyz|la:Latin|lb:Luxembourgish|lo:Lao|lt:Lithuanian|lv:Latvian|mk:Macedonian|ml:Malayalam|mn:Mongolian|mr:Marathi|ms:Malay|mt:Maltese|my:Burmese|nb:Norwegian Bokmål|ne:Nepali|nl:Dutch|nn:Norwegian Nynorsk|no:Norwegian|pa:Punjabi|pl:Polish|ps:Pashto|pt:Portuguese|ro:Romanian|rom:Romany|ru:Russian|sk:Slovak|sl:Slovenian|sq:Albanian|sr:Serbian|sv:Swedish|sw:Swahili|ta:Tamil|te:Telugu|tg:Tajik|th:Thai|tk:Turkmen|tl:Tagalog|tr:Turkish|uk:Ukrainian|ur:Urdu|uz:Uzbek|vi:Vietnamese|yi:Yiddish|zh:Chinese|zu:Zulu|und:Unknown language',
                dialect: 'ar-001:Modern Standard Arabic|de-AT:Austrian German|de-CH:Swiss High German|en-AU:Australian English|en-CA:Canadian English|en-GB:British English|en-US:American English|es-419:Latin American Spanish|es-ES:European Spanish|es-MX:Mexican Spanish|fr-CA:Canadian French|fr-CH:Swiss French|nl-BE:Flemish|pt-BR:Brazilian Portuguese|pt-PT:European Portuguese|ro-MD:Moldavian|zh-Hans:Simplified Chinese|zh-Hant:Traditional Chinese',
                script: 'Arab:Arabic|Armn:Armenian|Beng:Bangla|Brai:Braille|Cyrl:Cyrillic|Deva:Devanagari|Ethi:Ethiopic|Geor:Georgian|Grek:Greek|Gujr:Gujarati|Guru:Gurmukhi|Hang:Hangul|Hani:Han|Hans:Simplified|Hant:Traditional|Hebr:Hebrew|Hira:Hiragana|Jpan:Japanese|Kana:Katakana|Khmr:Khmer|Knda:Kannada|Kore:Korean|Laoo:Lao|Latn:Latin|Mlym:Malayalam|Mong:Mongolian|Mymr:Myanmar|Orya:Odia|Sinh:Sinhala|Taml:Tamil|Telu:Telugu|Thaa:Thaana|Thai:Thai|Tibt:Tibetan|Zmth:Mathematical Notation|Zsye:Emoji|Zsym:Symbols|Zxxx:Unwritten|Zyyy:Common|Zzzz:Unknown Script',
                currency: 'AED:United Arab Emirates Dirham|AUD:Australian Dollar|BGN:Bulgarian Lev|BRL:Brazilian Real|CAD:Canadian Dollar|CHF:Swiss Franc|CNY:Chinese Yuan|CZK:Czech Koruna|DKK:Danish Krone|EUR:Euro|GBP:British Pound|HKD:Hong Kong Dollar|HUF:Hungarian Forint|ILS:Israeli New Shekel|INR:Indian Rupee|JPY:Japanese Yen|KRW:South Korean Won|MXN:Mexican Peso|NOK:Norwegian Krone|NZD:New Zealand Dollar|PLN:Polish Zloty|RON:Romanian Leu|RUB:Russian Ruble|SEK:Swedish Krona|SGD:Singapore Dollar|THB:Thai Baht|TRY:Turkish Lira|UAH:Ukrainian Hryvnia|USD:US Dollar|ZAR:South African Rand',
                calendar: 'buddhist:Buddhist Calendar|chinese:Chinese Calendar|gregory:Gregorian Calendar|hebrew:Hebrew Calendar|islamic:Hijri Calendar|iso8601:ISO-8601 Calendar|japanese:Japanese Calendar|persian:Persian Calendar',
                dateTimeField: 'era:era|year:year|quarter:quarter|month:month|weekOfYear:week|weekday:day of the week|day:day|dayPeriod:AM/PM|hour:hour|minute:minute|second:second|timeZoneName:time zone'
            },
            cs: {
                region: 'AD:Andorra|AE:Spojené arabské emiráty|AF:Afghánistán|AL:Albánie|AM:Arménie|AR:Argentina|AT:Rakousko|AU:Austrálie|AZ:Ázerbájdžán|BA:Bosna a Hercegovina|BD:Bangladéš|BE:Belgie|BG:Bulharsko|BR:Brazílie|BY:Bělorusko|CA:Kanada|CH:Švýcarsko|CI:Pobřeží slonoviny|CL:Chile|CN:Čína|CO:Kolumbie|CR:Kostarika|CU:Kuba|CY:Kypr|CZ:Česko|DE:Německo|DK:Dánsko|DO:Dominikánská republika|DZ:Alžírsko|EC:Ekvádor|EE:Estonsko|EG:Egypt|ES:Španělsko|ET:Etiopie|EU:Evropská unie|FI:Finsko|FR:Francie|GB:Spojené království|GE:Gruzie|GR:Řecko|HK:Hongkong|HR:Chorvatsko|HU:Maďarsko|ID:Indonésie|IE:Irsko|IL:Izrael|IN:Indie|IQ:Irák|IR:Írán|IS:Island|IT:Itálie|JO:Jordánsko|JP:Japonsko|KE:Keňa|KP:Severní Korea|KR:Jižní Korea|KZ:Kazachstán|LB:Libanon|LI:Lichtenštejnsko|LT:Litva|LU:Lucembursko|LV:Lotyšsko|MA:Maroko|MC:Monako|MD:Moldavsko|ME:Černá Hora|MK:Severní Makedonie|MN:Mongolsko|MT:Malta|MX:Mexiko|MY:Malajsie|NG:Nigérie|NL:Nizozemsko|NO:Norsko|NZ:Nový Zéland|PE:Peru|PH:Filipíny|PK:Pákistán|PL:Polsko|PT:Portugalsko|QA:Katar|RO:Rumunsko|RS:Srbsko|RU:Rusko|SA:Saúdská Arábie|SE:Švédsko|SG:Singapur|SI:Slovinsko|SK:Slovensko|SM:San Marino|SY:Sýrie|TH:Thajsko|TN:Tunisko|TR:Turecko|TW:Tchaj-wan|UA:Ukrajina|US:Spojené státy|UY:Uruguay|UZ:Uzbekistán|VA:Vatikán|VE:Venezuela|VN:Vietnam|XK:Kosovo|ZA:Jihoafrická republika|001:svět|150:Evropa|419:Latinská Amerika',
                language: 'ar:arabština|be:běloruština|bg:bulharština|bn:bengálština|ca:katalánština|cs:čeština|cy:velština|da:dánština|de:němčina|el:řečtina|en:angličtina|eo:esperanto|es:španělština|et:estonština|eu:baskičtina|fa:perština|fi:finština|fr:francouzština|ga:irština|gl:galicijština|he:hebrejština|hi:hindština|hr:chorvatština|hu:maďarština|hy:arménština|id:indonéština|is:islandština|it:italština|ja:japonština|ka:gruzínština|ko:korejština|la:latina|lb:lucemburština|lt:litevština|lv:lotyština|mk:makedonština|mt:maltština|nb:norština (bokmål)|nl:nizozemština|no:norština|pl:polština|pt:portugalština|ro:rumunština|rom:romština|ru:ruština|sk:slovenština|sl:slovinština|sq:albánština|sr:srbština|sv:švédština|th:thajština|tr:turečtina|uk:ukrajinština|ur:urdština|vi:vietnamština|yi:jidiš|zh:čínština|und:neznámý jazyk',
                dialect: 'en-AU:angličtina (Austrálie)|en-CA:angličtina (Kanada)|en-GB:angličtina (Velká Británie)|en-US:angličtina (USA)|es-419:španělština (Latinská Amerika)|fr-CA:francouzština (Kanada)|nl-BE:vlámština|pt-BR:portugalština (Brazílie)|zh-Hans:čínština (zjednodušená)|zh-Hant:čínština (tradiční)',
                script: 'Arab:arabské|Armn:arménské|Cyrl:cyrilice|Deva:dévanágarí|Geor:gruzínské|Grek:řecké|Hans:zjednodušené|Hant:tradiční|Hebr:hebrejské|Jpan:japonské|Kore:korejské|Latn:latinka|Thai:thajské|Zyyy:obecné|Zzzz:neznámé písmo',
                currency: 'AUD:australský dolar|CAD:kanadský dolar|CHF:švýcarský frank|CNY:čínský jüan|CZK:česká koruna|DKK:dánská koruna|EUR:euro|GBP:britská libra|HUF:maďarský forint|JPY:japonský jen|NOK:norská koruna|PLN:polský zlotý|RUB:ruský rubl|SEK:švédská koruna|UAH:ukrajinská hřivna|USD:americký dolar',
                calendar: 'gregory:gregoriánský kalendář',
                dateTimeField: 'era:letopočet|year:rok|quarter:čtvrtletí|month:měsíc|weekOfYear:týden|weekday:den v týdnu|day:den|dayPeriod:část dne|hour:hodina|minute:minuta|second:sekunda|timeZoneName:časové pásmo'
            }
        };
        var dnTable = function (lg, type) {
            var d = DN[lg] || DN.en, t = d[type];
            if (typeof t === 'string') {
                var items = t.split('|');
                t = d[type] = Object.create(null);
                for (var i = 0; i < items.length; i++) { var c = items[i].indexOf(':'); t[items[i].slice(0, c)] = items[i].slice(c + 1); }
            }
            return t || {};
        };
        var dnName = function (lg, type, key) { var v = dnTable(lg, type)[key]; return v !== undefined || lg === 'en' ? v : dnTable('en', type)[key]; };
        var DN_CODE = { region: /^(?:[a-z]{2}|\d{3})$/i, script: /^[a-z]{4}$/i, currency: /^[a-z]{3}$/i, language: /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i, calendar: /^[a-z0-9]{3,8}(?:-[a-z0-9]{3,8})*$/i, dateTimeField: /^[a-z]+$/i };
        var DisplayNames = function DisplayNames(locale, opts) {
            if (!(this instanceof DisplayNames)) throw new TypeError("Constructor Intl.DisplayNames requires 'new'");
            this.locale = canon(locale); this.opts = opts || {};
            if (!DN_CODE[this.opts.type]) throw new TypeError(this.opts.type === undefined ? 'Required option "type" is missing' : 'Value ' + this.opts.type + ' out of range for Intl.DisplayNames options property type');
        };
        DisplayNames.prototype.of = function (code) {
            var type = this.opts.type, lg = lang(this.locale), s = String(code), name;
            if (!DN_CODE[type].test(s) || (type === 'dateTimeField' && dnTable('en', type)[s] === undefined)) throw new RangeError('invalid_argument');
            if (type === 'region') s = s.toUpperCase();
            else if (type === 'script') s = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
            else if (type === 'currency') s = s.toUpperCase();
            else if (type === 'calendar') s = s.toLowerCase();
            if (type === 'language') {
                var parts = s.split('-'), base = parts[0].toLowerCase(), script = '', region = '';
                for (var i = 1; i < parts.length; i++) {
                    if (/^[a-z]{4}$/i.test(parts[i]) && !script && !region) script = parts[i].charAt(0).toUpperCase() + parts[i].slice(1).toLowerCase();
                    else if (/^(?:[a-z]{2}|\d{3})$/i.test(parts[i]) && !region) region = parts[i].toUpperCase();
                }
                s = base + (script ? '-' + script : '') + (region ? '-' + region : '');
                name = this.opts.languageDisplay !== 'standard' ? dnName(lg, 'dialect', s) : undefined;
                if (name === undefined) {
                    name = dnName(lg, 'language', base);
                    if (name !== undefined && (script || region)) {
                        var more = [];
                        if (script) more.push(dnName(lg, 'script', script) || script);
                        if (region) more.push(dnName(lg, 'region', region) || region);
                        name += ' (' + more.join(', ') + ')';
                    }
                }
            } else name = dnName(lg, type, s);
            return name !== undefined ? name : this.opts.fallback === 'none' ? undefined : s;
        };
        DisplayNames.prototype.resolvedOptions = function () {
            var r = { locale: this.locale, style: this.opts.style || 'long', type: this.opts.type, fallback: this.opts.fallback || 'code' };
            if (this.opts.type === 'language') r.languageDisplay = this.opts.languageDisplay || 'dialect';
            return r;
        };
        DisplayNames.supportedLocalesOf = supportedOf;
        Intl.DisplayNames = DisplayNames;
        // Locale: the fields are getters of the prototype, as in the engines (FormatJS looks for variants there), with
        // the Locale Info methods (getWeekInfo...); without them FormatJS puts its own Locale in
        var LIKELY = { en: 'Latn-US', cs: 'Latn-CZ', sk: 'Latn-SK', de: 'Latn-DE', pl: 'Latn-PL', fr: 'Latn-FR', es: 'Latn-ES', it: 'Latn-IT', pt: 'Latn-BR', nl: 'Latn-NL', hu: 'Latn-HU', sv: 'Latn-SE', da: 'Latn-DK', fi: 'Latn-FI', nb: 'Latn-NO', no: 'Latn-NO', tr: 'Latn-TR', ro: 'Latn-RO', hr: 'Latn-HR', sl: 'Latn-SI', ru: 'Cyrl-RU', uk: 'Cyrl-UA', bg: 'Cyrl-BG', sr: 'Cyrl-RS', el: 'Grek-GR', he: 'Hebr-IL', ar: 'Arab-EG', fa: 'Arab-IR', hi: 'Deva-IN', th: 'Thai-TH', vi: 'Latn-VN', id: 'Latn-ID', ja: 'Jpan-JP', ko: 'Kore-KR', zh: 'Hans-CN', und: 'Latn-US' };
        var SUNDAY_FIRST = ' AG AS BD BR BS BT BW BZ CA CN CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW ';
        var H12_REGIONS = ' US CA AU NZ IN PH PK BD EG SA MX CO ';
        var ZONES = { CZ: ['Europe/Prague'], SK: ['Europe/Bratislava'], DE: ['Europe/Berlin', 'Europe/Busingen'], AT: ['Europe/Vienna'], PL: ['Europe/Warsaw'], HU: ['Europe/Budapest'], GB: ['Europe/London'], IE: ['Europe/Dublin'], FR: ['Europe/Paris'], IT: ['Europe/Rome'], ES: ['Africa/Ceuta', 'Atlantic/Canary', 'Europe/Madrid'], NL: ['Europe/Amsterdam'], CH: ['Europe/Zurich'], UA: ['Europe/Kyiv'], JP: ['Asia/Tokyo'], CN: ['Asia/Shanghai', 'Asia/Urumqi'], IN: ['Asia/Kolkata'],
                      US: ['America/Adak', 'America/Anchorage', 'America/Chicago', 'America/Denver', 'America/Detroit', 'America/Los_Angeles', 'America/New_York', 'America/Phoenix', 'Pacific/Honolulu'] };
        var LOCALE_KEYS = { ca: 'calendar', co: 'collation', fw: 'firstDayOfWeek', hc: 'hourCycle', kf: 'caseFirst', kn: 'numeric', nu: 'numberingSystem' };
        var Locale = function Locale(tag, opts) {
            if (!(this instanceof Locale)) throw new TypeError("Constructor Intl.Locale requires 'new'");
            if (tag instanceof Locale) tag = tag.toString();
            if (typeof tag !== 'string' && (tag === null || typeof tag !== 'object')) throw new TypeError("First argument to Intl.Locale constructor can't be empty or missing");
            var parts = String(tag).replace(/_/g, '-').split('-'), k = 1, f = { language: parts[0].toLowerCase(), rest: '' }, key;
            if (!/^[a-z]{2,8}$/.test(f.language)) throw new RangeError('Incorrect locale information provided');
            if (parts[k] && /^[a-z]{4}$/i.test(parts[k])) { f.script = parts[k].charAt(0).toUpperCase() + parts[k].slice(1).toLowerCase(); k++; }
            if (parts[k] && /^(?:[a-z]{2}|\d{3})$/i.test(parts[k])) { f.region = parts[k].toUpperCase(); k++; }
            var vars = [];
            while (parts[k] && /^(?:[a-z0-9]{5,8}|\d[a-z0-9]{3})$/i.test(parts[k])) vars.push(parts[k++].toLowerCase());
            if (vars.length) f.variants = vars.join('-');
            // (-u- keywords; other extensions and private use kept as they are)
            while (k < parts.length) {
                if (parts[k].toLowerCase() === 'u') {
                    k++;
                    while (k < parts.length && parts[k].length > 1) {
                        key = parts[k++].toLowerCase();
                        var val = [];
                        while (k < parts.length && parts[k].length > 2) val.push(parts[k++].toLowerCase());
                        if (LOCALE_KEYS[key]) f[LOCALE_KEYS[key]] = val.length ? val.join('-') : 'true';
                    }
                } else { f.rest = '-' + parts.slice(k).join('-').toLowerCase(); break; }
            }
            if (opts) {
                var names = ['language', 'script', 'region', 'calendar', 'collation', 'hourCycle', 'caseFirst', 'numberingSystem', 'firstDayOfWeek'];
                for (var n = 0; n < names.length; n++) if (opts[names[n]] !== undefined) f[names[n]] = String(opts[names[n]]);
                if (opts.numeric !== undefined) f.numeric = opts.numeric ? 'true' : 'false';
            }
            Object.defineProperty(this, '__br_l', { value: f });
        };
        var localeField = function (name, fn) { Object.defineProperty(Locale.prototype, name, { get: fn || function () { return this.__br_l[name]; }, configurable: true }); };
        localeField('language'); localeField('script'); localeField('region'); localeField('variants'); localeField('calendar'); localeField('collation');
        localeField('hourCycle'); localeField('caseFirst'); localeField('numberingSystem'); localeField('firstDayOfWeek');
        localeField('numeric', function () { return this.__br_l.numeric === 'true'; });
        localeField('baseName', function () { var f = this.__br_l; return f.language + (f.script ? '-' + f.script : '') + (f.region ? '-' + f.region : '') + (f.variants ? '-' + f.variants : ''); });
        Locale.prototype.toString = function () {
            var f = this.__br_l, u = '';
            for (var key in LOCALE_KEYS) if (LOCALE_KEYS.hasOwnProperty(key) && f[LOCALE_KEYS[key]] !== undefined) u += '-' + key + (f[LOCALE_KEYS[key]] === 'true' ? '' : '-' + f[LOCALE_KEYS[key]]);
            return this.baseName + (u ? '-u' + u : '') + f.rest;
        };
        Locale.prototype.toJSON = Locale.prototype.toString;
        var likelyOf = function (f) { return (LIKELY[f.language] || 'Latn-US').split('-'); };
        Locale.prototype.maximize = function () {
            var f = this.__br_l, l = likelyOf(f);
            return new Locale(this.toString(), { script: f.script || l[0], region: f.region || l[1] });
        };
        Locale.prototype.minimize = function () {
            var f = this.__br_l, l = likelyOf(f);
            return new Locale(f.language + (f.script && f.script !== l[0] ? '-' + f.script : '') + (f.region && f.region !== l[1] ? '-' + f.region : '') + (f.variants ? '-' + f.variants : ''));
        };
        var regionOf = function (loc) { return loc.__br_l.region || likelyOf(loc.__br_l)[1]; };
        var LOCALE_INFO = {
            getCalendars: function () { return [this.__br_l.calendar || 'gregory']; },
            getCollations: function () { return this.__br_l.collation ? [this.__br_l.collation] : ['emoji', 'eor']; },
            getHourCycles: function () { return [this.__br_l.hourCycle || (H12_REGIONS.indexOf(' ' + regionOf(this) + ' ') >= 0 ? 'h12' : 'h23')]; },
            getNumberingSystems: function () { return [this.__br_l.numberingSystem || 'latn']; },
            getTimeZones: function () { var r = this.__br_l.region; return r ? (ZONES[r] || []).slice() : undefined; },
            getTextInfo: function () { return { direction: /^(?:ar|he|iw|fa|ur|yi|ps|sd|ug|dv|ckb)$/.test(this.__br_l.language) ? 'rtl' : 'ltr' }; },
            getWeekInfo: function () {
                var r = regionOf(this), fw = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }[this.__br_l.firstDayOfWeek];
                return { firstDay: fw || (SUNDAY_FIRST.indexOf(' ' + r + ' ') >= 0 ? 7 : 1), weekend: [6, 7] };
            }
        };
        // (and the older getters: locale.weekInfo, locale.hourCycles...)
        for (var li in LOCALE_INFO) if (LOCALE_INFO.hasOwnProperty(li)) {
            Locale.prototype[li] = LOCALE_INFO[li];
            localeField(li.charAt(3).toLowerCase() + li.slice(4), LOCALE_INFO[li]);
        }
        Intl.Locale = Locale;
        var Segmenter = function Segmenter(locale, opts) { this.locale = canon(locale); this.granularity = opts && opts.granularity || 'grapheme'; };
        Segmenter.prototype.segment = function (str) {
            str = String(str);
            var re = this.granularity === 'word' ? /[\wÀ-ɏЀ-ӿ]+|[^\wÀ-ɏЀ-ӿ]/g : this.granularity === 'sentence' ? /[^.!?]+[.!?]*\s*/g : /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g;
            var out = [], m, wordLike = this.granularity === 'word';
            while ((m = re.exec(str)) !== null) out.push({ segment: m[0], index: m.index, input: str, isWordLike: wordLike ? /[\wÀ-ɏЀ-ӿ]/.test(m[0]) : undefined });
            out.containing = function (i) { for (var k = 0; k < out.length; k++) if (i >= out[k].index && i < out[k].index + out[k].segment.length) return out[k]; return undefined; };
            return out;
        };
        Segmenter.prototype.resolvedOptions = function () { return { locale: this.locale, granularity: this.granularity }; };
        Segmenter.supportedLocalesOf = supportedOf;
        Intl.Segmenter = Segmenter;
        var DurationFormat = function DurationFormat(locale, opts) { this.locale = canon(locale); this.opts = opts || {}; };
        DurationFormat.prototype.format = function (d) { var keys = ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds'], out = [], lg = lang(this.locale); var rtf = new RelativeTimeFormat(this.locale); for (var i = 0; i < keys.length; i++) if (d && d[keys[i]]) { var s = rtf.format(d[keys[i]], keys[i]); out.push(s.replace(lg === 'en' ? /^in /: /^za /, '')); } return out.join(lg === 'en' ? ', ' : ' '); };
        DurationFormat.prototype.formatToParts = function (d) { return [{ type: 'literal', value: this.format(d) }]; };
        DurationFormat.supportedLocalesOf = supportedOf;
        Intl.DurationFormat = DurationFormat;
        // (the case of each part as the standard writes it; a tag that is not one throws, as in the engines)
        Intl.getCanonicalLocales = function (l) {
            var a = supportedOf(l), out = [];
            for (var i = 0; i < a.length; i++) { var c = new Locale(a[i]).toString(); if (out.indexOf(c) < 0) out.push(c); }
            return out;
        };
        Intl.supportedValuesOf = function (key) { switch (key) { case 'currency': { var c = []; for (var k in CURRENCY) if (CURRENCY.hasOwnProperty(k)) c.push(k); return c.sort(); } case 'calendar': return ['gregory']; case 'numberingSystem': return ['latn']; case 'timeZone': return ['Europe/Prague', 'UTC']; case 'unit': { var u = []; for (var uk in UNIT_SHORT) if (UNIT_SHORT.hasOwnProperty(uk)) u.push(uk); return u.sort(); } case 'collation': return ['default']; } return []; };
        // the locale-aware methods of Number and Date go through the implementation above when arguments are given
        var origNumToLocale = Number.prototype.toLocaleString;
        Number.prototype.toLocaleString = function (locales, opts) { if (locales === undefined && opts === undefined) return origNumToLocale.call(this); try { return new NumberFormat(locales, opts).format(Number(this)); } catch (e) { return origNumToLocale.call(this); } };
        // ECMA-402 ToDateTimeOptions: the date / time defaults apply only when the caller named no field of that group
        var DATE_DEFAULTS = { year: 'numeric', month: 'numeric', day: 'numeric' }, TIME_DEFAULTS = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
        var dateMethod = function (name, wantDate, wantTime) {
            var orig = Date.prototype[name];
            Date.prototype[name] = function (locales, opts) {
                if (locales === undefined && opts === undefined) return orig.call(this);
                var o = {}, k;
                if (opts) for (k in opts) if (opts.hasOwnProperty(k)) o[k] = opts[k];
                var hasDate = !!(o.weekday || o.year || o.month || o.day || o.dateStyle || o.era), hasTime = !!(o.hour || o.minute || o.second || o.timeStyle || o.dayPeriod || o.fractionalSecondDigits);
                if (!hasDate && !hasTime) {
                    if (wantDate) for (k in DATE_DEFAULTS) if (DATE_DEFAULTS.hasOwnProperty(k)) o[k] = DATE_DEFAULTS[k];
                    if (wantTime) for (k in TIME_DEFAULTS) if (TIME_DEFAULTS.hasOwnProperty(k)) o[k] = TIME_DEFAULTS[k];
                } else if (name === 'toLocaleDateString' && !hasDate) { for (k in DATE_DEFAULTS) if (DATE_DEFAULTS.hasOwnProperty(k)) o[k] = DATE_DEFAULTS[k]; }
                else if (name === 'toLocaleTimeString' && !hasTime) { for (k in TIME_DEFAULTS) if (TIME_DEFAULTS.hasOwnProperty(k)) o[k] = TIME_DEFAULTS[k]; }
                try { return new DateTimeFormat(locales, o).format(this); } catch (e) { return orig.call(this); }
            };
        };
        dateMethod('toLocaleDateString', true, false);
        dateMethod('toLocaleTimeString', false, true);
        dateMethod('toLocaleString', true, true);
    })();

    // IndexedDB is missing on iOS 6: expose a stub that fails cleanly (many libraries feature-detect it)
    if (!window.indexedDB) {
        window.indexedDB = null;
    }

    // customElements: registry stub so definitions do not throw (rendering of custom elements is not emulated)
    if (!window.customElements) {
        var registry = {};
        window.customElements = {
            __brStub: true,   // replaced by the upgrading registry in shims-extra.js
            define: function (name, ctor) { registry[name] = ctor; },
            get: function (name) { return registry[name]; },
            whenDefined: function () { return window.Promise ? window.Promise.resolve() : null; },
            upgrade: function () {}
        };
    }
    if (!window.HTMLTemplateElement) {
        window.HTMLTemplateElement = function () {};
    }
    if (window.HTMLUnknownElement && !('content' in document.createElement('template'))) {
        // <template> polyfill: expose .content as a document fragment of the children and hide the element
        var style = document.createElement('style');
        style.__brOwn = true;
        // (data-precedence: React 19 skips such styles in <head> when it hydrates; it took this one for the page's
        // first <style> and threw the page away over its text - vercel.com)
        style.setAttribute('data-precedence', 'br');
        style.textContent = 'template{display:none!important}';
        (document.head || document.documentElement).appendChild(style);
        var proto = Object.getPrototypeOf(document.createElement('template'));
        try {
            Object.defineProperty(proto, 'content', { get: function () {
                if (!this.__content) {
                    var frag = document.createDocumentFragment();
                    while (this.firstChild) frag.appendChild(this.firstChild);
                    this.__content = frag;
                }
                return this.__content;
            } });
        } catch (e5) {}
    }

    // structuredClone: the structured clone algorithm for data (shared and cyclic references, Date, RegExp, Map, Set,
    // boxed primitives, ArrayBuffer and views, Error; Blob/File/ImageData shared; undefined kept, class instances
    // become plain objects); functions, symbols and DOM nodes throw DataCloneError. (A JSON round trip turned dates
    // into strings and Maps into {}.)
    if (!window.structuredClone) (function () {
        var hasOwn = Object.prototype.hasOwnProperty, toStr = Object.prototype.toString;
        var VIEWS = { Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1, Int16Array: 1, Uint16Array: 1, Int32Array: 1, Uint32Array: 1, Float32Array: 1, Float64Array: 1, BigInt64Array: 1, BigUint64Array: 1 };
        var SHARED = { Blob: 1, File: 1, FileList: 1, ImageData: 1, ImageBitmap: 1, CryptoKey: 1 };
        var cloneError = function (what) {
            var e;
            try { e = new window.DOMException(what + ' could not be cloned.', 'DataCloneError'); } catch (x) { e = null; }
            if (!e || e.name !== 'DataCloneError') { e = new Error(what + ' could not be cloned.'); e.name = 'DataCloneError'; e.code = 25; }
            return e;
        };
        var tagOf = function (v) {
            if (typeof window.Map === 'function' && v instanceof window.Map) return 'Map';
            if (typeof window.Set === 'function' && v instanceof window.Set) return 'Set';
            return toStr.call(v).slice(8, -1);
        };
        window.structuredClone = function structuredClone(value) {
            if (arguments.length === 0) throw new TypeError("Failed to execute 'structuredClone' on 'Window': 1 argument required, but only 0 present.");
            var memo = typeof window.Map === 'function' ? new window.Map() : null, keys = [], vals = [];
            var remember = function (o, c) { if (memo) memo.set(o, c); else { keys.push(o); vals.push(c); } return c; };
            var clone = function (v) {
                var t = typeof v;
                if (v === null || (t !== 'object' && t !== 'function')) {
                    if (t === 'symbol') throw cloneError('Symbol()');
                    return v;
                }
                if (t === 'function') throw cloneError(String(v).slice(0, 80));
                var known = memo ? memo.get(v) : (function () { for (var i = 0; i < keys.length; i++) if (keys[i] === v) return vals[i]; })();
                if (known !== undefined) return known;
                var tag = tagOf(v), c, i;
                if (tag === 'Symbol') throw cloneError('Symbol()');   // (a polyfilled one is an object)
                if (SHARED[tag]) return v;
                if (VIEWS[tag]) return remember(v, new v.constructor(clone(v.buffer), v.byteOffset, v.length));
                switch (tag) {
                    case 'Date': return remember(v, new Date(v.getTime()));
                    case 'RegExp':
                        return remember(v, new RegExp(v.source, typeof v.flags === 'string' ? v.flags : (v.global ? 'g' : '') + (v.ignoreCase ? 'i' : '') + (v.multiline ? 'm' : '')));
                    case 'Boolean': case 'Number': case 'String': return remember(v, Object(v.valueOf()));
                    case 'ArrayBuffer': return remember(v, v.slice(0));
                    case 'DataView': return remember(v, new DataView(clone(v.buffer), v.byteOffset, v.byteLength));
                    case 'Map':
                        c = remember(v, new window.Map());
                        v.forEach(function (val, key) { c.set(clone(key), clone(val)); });
                        return c;
                    case 'Set':
                        c = remember(v, new window.Set());
                        v.forEach(function (val) { c.add(clone(val)); });
                        return c;
                    case 'Error': case 'EvalError': case 'RangeError': case 'ReferenceError': case 'SyntaxError': case 'TypeError': case 'URIError':
                        var E = window[v.name] && /Error$/.test(v.name) ? window[v.name] : Error;
                        c = remember(v, new E(v.message));
                        if (v.stack) try { c.stack = String(v.stack); } catch (es) {}
                        return c;
                    case 'Array':
                        c = remember(v, new Array(v.length));
                        for (i = 0; i < v.length; i++) if (i in v) c[i] = clone(v[i]);
                        return c;
                }
                if (v.nodeType || v === window || v.window === v || tag === 'Promise' || tag === 'WeakMap' || tag === 'WeakSet') throw cloneError(tag || 'The object');
                c = remember(v, {});
                for (var k in v) if (hasOwn.call(v, k)) c[k] = clone(v[k]);
                return c;
            };
            return clone(value);
        };
    })();
    // matchMedia with today's queries (the rewriter does the same for stylesheets, see fixMedia in cssfix.js): range
    // syntax, rem (refused by the old engine inside media queries: the whole query fails; there it means the initial
    // font size, like em), and hover / pointer / prefers-* features it does not know (a touch device with the defaults)
    if (window.matchMedia && !window.matchMedia.__brFix) (function () {
        var nativeMatchMedia = window.matchMedia;
        var strict = function (v, op, up) {
            var m = /^(-?[\d.]+)(px|em|rem)$/i.exec(v.replace(/^\s+|\s+$/g, ''));
            if (op.length > 1 || !m) return v;
            var n = parseFloat(m[1]) + (up ? 1 : -1) * (/px/i.test(m[2]) ? 0.02 : 0.001);
            return (Math.round(n * 1000) / 1000) + m[2];
        };
        var fixQuery = function (q) {
            return String(q)
                .replace(/\(\s*(-?[\d.]+(?:px|em|rem))\s*(<=|<)\s*(width|height)\s*(<=|<)\s*(-?[\d.]+(?:px|em|rem))\s*\)/gi, function (m, a, o1, f, o2, b) { return '(min-' + f + ': ' + strict(a, o1, true) + ') and (max-' + f + ': ' + strict(b, o2, false) + ')'; })
                .replace(/\(\s*(width|height)\s*(>=|>)\s*([^)]+?)\s*\)/gi, function (m, f, o, v) { return '(min-' + f + ': ' + strict(v, o, true) + ')'; })
                .replace(/\(\s*(width|height)\s*(<=|<)\s*([^)]+?)\s*\)/gi, function (m, f, o, v) { return '(max-' + f + ': ' + strict(v, o, false) + ')'; })
                .replace(/(\d*\.?\d+)rem\b/gi, '$1em')
                .replace(/\(\s*(?:any-)?hover\s*:\s*none\s*\)|\(\s*(?:any-)?pointer\s*:\s*coarse\s*\)|\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)|\(\s*prefers-color-scheme\s*:\s*light\s*\)|\(\s*prefers-contrast\s*:\s*no-preference\s*\)|\(\s*forced-colors\s*:\s*none\s*\)|\(\s*display-mode\s*:\s*browser\s*\)|\(\s*scripting\s*:\s*enabled\s*\)|\(\s*dynamic-range\s*:\s*standard\s*\)/gi, '(min-width: 0px)')
                .replace(/\(\s*(?:any-)?hover(?:\s*:\s*hover)?\s*\)|\(\s*(?:any-)?pointer\s*:\s*(?:fine|none)\s*\)|\(\s*prefers-reduced-motion(?:\s*:\s*reduce)?\s*\)|\(\s*prefers-color-scheme\s*:\s*dark\s*\)|\(\s*prefers-contrast\s*:\s*[a-z]+\s*\)|\(\s*forced-colors\s*:\s*active\s*\)|\(\s*display-mode\s*:\s*[a-z-]+\s*\)|\(\s*dynamic-range\s*:\s*high\s*\)/gi, '(max-width: 0px)');
        };
        var wrapped = function matchMedia(query) { return nativeMatchMedia.call(window, fixQuery(query)); };
        wrapped.__brFix = true;
        wrapped.__brNative = nativeMatchMedia;
        try { window.matchMedia = wrapped; } catch (eMM) {}
    })();
    // Object.assign onto an element (a helper that makes a node from a tag and properties): what the old engine keeps
    // read-only goes through the attribute (a button's type; today that property sets it), and void elements ignore
    // innerText (today they take it, here it throws DOM Exception 7). Other failures stay failures.
    if (Object.assign && !Object.assign.__brDom) (function () {
        var nativeAssign = Object.assign, hasOwn = Object.prototype.hasOwnProperty;
        var put = function (el, k, v) {
            try { el[k] = v; } catch (e) {
                if (k === 'type' && /^button$/i.test(el.tagName)) el.setAttribute('type', v);
                else if (k !== 'innerText') throw e;
            }
        };
        // (keys assigned to the target of the transpiler's Proxy stand-in reach its proxies: Pinia builds a store as
        // reactive({...}) and then assigns its actions and state to toRaw(store), store.getCartProduct was undefined)
        // (the tries in functions of their own, called when needed: a function with a try makes a scope object on every
        // call here)
        var resyncAll = function (px) { for (var i = 0; i < px.length; i++) { try { px[i].__br_resync(); } catch (e) {} } };
        var resync = function (target) {
            var px = target && target.__br_px;
            if (px) resyncAll(px);
        };
        // (a source whose own properties are all enumerable has no core-js symbol, which are never enumerable: its keys
        // are copied here, core-js's assign checked every key of it for one)
        // (each key still enumerable when its turn comes, as the standard reads it: a getter may hide the ones after it,
        // and a page's own core-js checks exactly that - failing, it put its own assign in, 9 us a call here)
        var N = window.__brNative || {}, engineKeys = N.keys, engineNames = N.getOwnPropertyNames, pie = N.propertyIsEnumerable;
        var copy = function (target, args) {
            if (!engineKeys || !engineNames || !pie || target === null || target === undefined) return nativeAssign.apply(Object, args);
            var to = Object(target);
            for (var i = 1; i < args.length; i++) {
                var s = args[i];
                if (s === null || s === undefined) continue;
                var from = Object(s), keys = engineKeys(from), n = keys.length, k;
                if (engineNames(from).length !== n) { nativeAssign(to, from); continue; }
                // (the values read first; only when reading them changed the keys - a getter - each key's enumerability
                // is asked for, a call per key)
                var vals = new Array(n);
                for (k = 0; k < n; k++) vals[k] = from[keys[k]];
                if (engineKeys(from).length === n) { for (k = 0; k < n; k++) to[keys[k]] = vals[k]; }
                else { for (k = 0; k < n; k++) if (pie.call(from, keys[k])) to[keys[k]] = vals[k]; }
            }
            return to;
        };
        var toElement = function (target, args) {
            try { var out = copy(target, args); resync(target); return out; } catch (e) {
                for (var i = 1; i < args.length; i++) {
                    var s = args[i];
                    if (s === null || s === undefined) continue;
                    for (var k in s) if (hasOwn.call(s, k)) put(target, k, s[k]);
                }
                return target;
            }
        };
        var El = window.Element;
        Object.assign = function assign(target) {
            if (El && target instanceof El) return toElement(target, arguments);
            var out = copy(target, arguments);
            resync(target);
            return out;
        };
        Object.assign.__brDom = true;
    })();
    if (!window.reportError) window.reportError = function (e) { if (con.error) con.error(e); };
    if (!window.ResizeObserver) window.ResizeObserver = function () {}; // provided by the polyfill before this file normally
    if (!window.IdleDeadline) window.IdleDeadline = function () {};
    if (!window.Notification) { window.Notification = function () {}; window.Notification.permission = 'denied'; window.Notification.requestPermission = function () { return window.Promise ? window.Promise.resolve('denied') : null; }; }
    if (!window.BroadcastChannel) { window.BroadcastChannel = function (name) { this.name = name; }; window.BroadcastChannel.prototype.postMessage = function () {}; window.BroadcastChannel.prototype.close = function () {}; window.BroadcastChannel.prototype.addEventListener = function () {}; window.BroadcastChannel.prototype.removeEventListener = function () {}; }
    if (!window.Worker) { window.Worker = function () { throw new Error('Web Workers are not supported'); }; }
    if (!window.WebSocket && window.MozWebSocket) window.WebSocket = window.MozWebSocket;
    if (!window.visualViewport) window.visualViewport = { width: window.innerWidth, height: window.innerHeight, scale: 1, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, addEventListener: function () {}, removeEventListener: function () {} };
    if (!window.screen.orientation) try { window.screen.orientation = { type: window.innerWidth > window.innerHeight ? 'landscape-primary' : 'portrait-primary', angle: 0, addEventListener: function () {}, removeEventListener: function () {} }; } catch (e6) {}
    if (!('devicePixelRatio' in window)) window.devicePixelRatio = 1;
    if (!window.CSS) window.CSS = {};
    if (!window.CSS.supports) window.CSS.supports = function (p, v) { if (v === undefined) { var m = /^\(?\s*([a-z-]+)\s*:\s*(.*?)\s*\)?$/i.exec(p || ''); if (!m) return false; p = m[1]; v = m[2]; } var s = document.createElement('div').style; try { s.setProperty(p, v); return s.getPropertyValue(p) !== ''; } catch (e) { return false; } };
    if (!window.CSS.escape) window.CSS.escape = function (s) { return String(s).replace(/([^\w-])/g, '\\$1'); };
    if (!window.CSS.registerProperty) window.CSS.registerProperty = function () {};
    if (!window.CSSStyleSheet.prototype.replaceSync) { window.CSSStyleSheet.prototype.replaceSync = function () {}; window.CSSStyleSheet.prototype.replace = function () { return window.Promise ? window.Promise.resolve(this) : null; }; }
    try { if (!('adoptedStyleSheets' in document)) document.adoptedStyleSheets = []; } catch (e7) {}

    // ---- Interface objects as functions. Most of them are objects in the old engine (typeof Event === 'object'):
    // Babel's class helpers refuse them as superclasses ("Super expression must either be null or a function") and
    // feature tests that check typeof fail. Each becomes a function of the same name with the same prototype and
    // constants; `new` makes the native object (a subclass's instance gets the subclass's prototype). The event
    // constructors the old engine refuses (MouseEvent, KeyboardEvent, UIEvent, TouchEvent) and the node constructors
    // (Text, Comment, DocumentFragment, Range, File) are built from the document's factory methods.
    (function () {
        var gopn = Object.getOwnPropertyNames, getProto = Object.getPrototypeOf, SKIP = { prototype: 1, length: 1, name: 1, arguments: 1, caller: 1 };
        var construct = function (Native, a) {
            switch (a.length) {
                case 0: return new Native();
                case 1: return new Native(a[0]);
                case 2: return new Native(a[0], a[1]);
                case 3: return new Native(a[0], a[1], a[2]);
                default: return new Native(a[0], a[1], a[2], a[3]);
            }
        };
        var wrap = function (name, build) {
            var Native = window[name];
            if (!Native || typeof Native === 'function' || !Native.prototype) return;
            var W = null;
            var make = function (self, args) {
                var obj = build ? build(args) : construct(Native, args);
                // (a subclass constructing: its prototype on the native object)
                if (self && typeof self === 'object' && self !== window && W && self instanceof W && getProto(self) !== W.prototype && obj && typeof obj === 'object') {
                    try { obj.__proto__ = getProto(self); } catch (e) {}
                }
                return obj;
            };
            // (a function with the interface's name: code prints and compares constructor names)
            try { W = Function('make', 'return function ' + name + '() { return make(this, arguments); };')(make); } catch (e0) { W = function () { return make(this, arguments); }; }
            var keys = [];
            try { keys = gopn(Native); } catch (e1) { for (var k in Native) keys.push(k); }
            try { var pk = gopn(Native.prototype); for (var p = 0; p < pk.length; p++) if (/^[A-Z][A-Z0-9_]*$/.test(pk[p])) keys.push(pk[p]); } catch (e2) {}
            for (var i = 0; i < keys.length; i++) {
                if (SKIP[keys[i]] || W.hasOwnProperty(keys[i])) continue;
                try { W[keys[i]] = Native[keys[i]] !== undefined ? Native[keys[i]] : Native.prototype[keys[i]]; } catch (e3) {}
            }
            W.prototype = Native.prototype;
            try { Object.defineProperty(Native.prototype, 'constructor', { value: W, writable: true, configurable: true, enumerable: false }); } catch (e4) { try { Native.prototype.constructor = W; } catch (e5) {} }
            W.__brNative = Native;
            try { window[name] = W; } catch (e6) {}
        };
        var flag = function (init, key) { return !!(init && init[key]); };
        var num = function (init, key) { return init && typeof init[key] === 'number' ? init[key] : 0; };
        wrap('Event');
        wrap('UIEvent', function (a) { var init = a[1] || {}, e = document.createEvent('UIEvents'); e.initUIEvent(String(a[0]), flag(init, 'bubbles'), flag(init, 'cancelable'), init.view || window, num(init, 'detail')); return e; });
        wrap('MouseEvent', function (a) {
            var init = a[1] || {}, e = document.createEvent('MouseEvents');
            e.initMouseEvent(String(a[0]), flag(init, 'bubbles'), flag(init, 'cancelable'), init.view || window, num(init, 'detail'), num(init, 'screenX'), num(init, 'screenY'),
                             num(init, 'clientX'), num(init, 'clientY'), flag(init, 'ctrlKey'), flag(init, 'altKey'), flag(init, 'shiftKey'), flag(init, 'metaKey'), num(init, 'button'), init.relatedTarget || null);
            return e;
        });
        wrap('KeyboardEvent', function (a) {
            var init = a[1] || {}, e = document.createEvent('KeyboardEvent');
            e.initKeyboardEvent(String(a[0]), flag(init, 'bubbles'), flag(init, 'cancelable'), init.view || window, init.keyIdentifier || '', num(init, 'location'),
                                flag(init, 'ctrlKey'), flag(init, 'altKey'), flag(init, 'shiftKey'), flag(init, 'metaKey'), false);
            // (key, code and keyCode as given: the page shims read them back, see shims-extra.js KeyboardEvent.key)
            var extra = { key: init.key, code: init.code, repeat: !!init.repeat, isComposing: !!init.isComposing };
            for (var x in extra) if (extra[x] !== undefined) try { Object.defineProperty(e, x, { value: extra[x], configurable: true }); } catch (err) {}
            return e;
        });
        wrap('TouchEvent', function (a) { var init = a[1] || {}, e = document.createEvent('UIEvents'); e.initUIEvent(String(a[0]), flag(init, 'bubbles'), flag(init, 'cancelable'), init.view || window, 0);
            e.touches = init.touches || []; e.targetTouches = init.targetTouches || []; e.changedTouches = init.changedTouches || []; return e; });
        var events = ['ErrorEvent', 'PopStateEvent', 'HashChangeEvent', 'AnimationEvent', 'TransitionEvent', 'MessageEvent', 'ProgressEvent', 'CloseEvent', 'StorageEvent', 'WheelEvent',
                      'CompositionEvent', 'TextEvent', 'BeforeUnloadEvent', 'PageTransitionEvent', 'WebKitAnimationEvent', 'WebKitTransitionEvent', 'OverflowEvent', 'DeviceOrientationEvent', 'DeviceMotionEvent'];
        for (var ev = 0; ev < events.length; ev++) wrap(events[ev]);
        var things = ['WebSocket', 'Image', 'Audio', 'Option', 'DOMParser', 'XMLSerializer', 'FileReader', 'MutationObserver', 'WebKitMutationObserver', 'EventSource', 'MessageChannel',
                      'SharedWorker', 'XPathEvaluator', 'XSLTProcessor', 'ArrayBuffer', 'DataView', 'Node', 'Element', 'Document', 'CharacterData', 'Attr', 'NodeList', 'HTMLCollection',
                      'SVGElement', 'CSSStyleSheet', 'CSSRule', 'CanvasRenderingContext2D', 'WebGLRenderingContext', 'Storage', 'Selection', 'DOMImplementation', 'TreeWalker', 'NodeIterator'];
        for (var t = 0; t < things.length; t++) wrap(things[t]);
        if (window.WebKitMutationObserver && window.MutationObserver && window.MutationObserver.__brNative === window.WebKitMutationObserver.__brNative) window.WebKitMutationObserver = window.MutationObserver;
        wrap('Text', function (a) { return document.createTextNode(a.length ? String(a[0]) : ''); });
        wrap('Comment', function (a) { return document.createComment(a.length ? String(a[0]) : ''); });
        wrap('DocumentFragment', function () { return document.createDocumentFragment(); });
        wrap('Range', function () { return document.createRange(); });
        // new File(parts, name, options): a Blob with the name and date, and File's prototype
        wrap('File', function (a) {
            var opts = a[2] || {}, b = new window.Blob(a[0] || [], opts.type ? { type: opts.type } : {});
            try { b.__proto__ = window.File.prototype; } catch (e) {}
            try { Object.defineProperty(b, 'name', { value: String(a[1]), configurable: true }); } catch (e2) { b.name = String(a[1]); }
            try { Object.defineProperty(b, 'lastModified', { value: typeof opts.lastModified === 'number' ? opts.lastModified : Date.now(), configurable: true }); } catch (e3) {}
            try { Object.defineProperty(b, '__brName', { value: String(a[1]), configurable: true }); } catch (e4) {}
            return b;
        });
    })();
})(window, document);
