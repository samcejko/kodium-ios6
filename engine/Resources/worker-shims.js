/*
 * What a worker scope of the old engine lacks and page scripts expect there (served with core-js, regenerator and
 * fetch as https://ios6-browser.invalid/worker-polyfills.js; the Worker shim of shims-extra.js imports it into blob
 * workers): TextEncoder / TextDecoder, crypto.getRandomValues and crypto.subtle.digest (SHA-1, SHA-256; proof of
 * work pages hash in workers).
 */
(function (self) {
    'use strict';
    // the old engine's workers have no console (vercel.com's turbopack worker stopped at its first console.log)
    if (!self.console) {
        var quiet = function () {};
        var con = {};
        var names = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'group', 'groupCollapsed', 'groupEnd',
                     'time', 'timeEnd', 'timeLog', 'count', 'countReset', 'assert', 'clear', 'profile', 'profileEnd', 'timeStamp'];
        for (var n = 0; n < names.length; n++) con[names[n]] = quiet;
        try { self.console = con; } catch (e0) {}
    }
    // current engines name the scope WorkerGlobalScope / DedicatedWorkerGlobalScope and scripts test
    // `self instanceof WorkerGlobalScope` (vercel.com's turbopack worker entry refused to start: "Worker entrypoint
    // must be loaded in a worker context"); the constructors take the prototypes of the scope's own chain
    if (!self.WorkerGlobalScope && typeof importScripts === 'function') {
        var illegal = function () { throw new TypeError('Illegal constructor'); };
        var own = Object.getPrototypeOf(self), base = own && Object.getPrototypeOf(own);
        if (!base || base === Object.prototype) base = own;
        if (own && own !== Object.prototype) {
            var WGS = function WorkerGlobalScope() { illegal(); };
            WGS.prototype = base;
            try { self.WorkerGlobalScope = WGS; } catch (e2) {}
            if (!self.DedicatedWorkerGlobalScope) {
                var DWGS = function DedicatedWorkerGlobalScope() { illegal(); };
                DWGS.prototype = own;
                try { self.DedicatedWorkerGlobalScope = DWGS; } catch (e3) {}
            }
        }
    }
    if (!self.performance) { try { self.performance = {}; } catch (e1) {} }
    if (self.performance && !self.performance.now) {
        var origin = Date.now();
        self.performance.now = function () { return Date.now() - origin; };
        self.performance.timeOrigin = origin;
    }
    // user timing in workers (Outlook's worker starts with performance.mark("WorkerEntry_LS"))
    if (self.performance && !self.performance.mark) {
        (function (perf) {
            var entries = [];
            var add = function (e) { entries.push(e); if (entries.length > 1000) entries.shift(); return e; };
            var timeOf = function (v) {
                if (typeof v === 'number') return v;
                if (typeof v === 'string') { for (var i = entries.length - 1; i >= 0; i--) if (entries[i].entryType === 'mark' && entries[i].name === v) return entries[i].startTime; throw new SyntaxError("The mark '" + v + "' does not exist."); }
                return undefined;
            };
            perf.mark = function (name, opts) {
                return add({ name: String(name), entryType: 'mark', startTime: opts && typeof opts.startTime === 'number' ? opts.startTime : perf.now(), duration: 0, detail: opts && opts.detail !== undefined ? opts.detail : null });
            };
            perf.measure = function (name, start, end) {
                var opts = start && typeof start === 'object' ? start : null, s, e;
                if (opts) { s = timeOf(opts.start); e = opts.end !== undefined ? timeOf(opts.end) : opts.duration !== undefined && s !== undefined ? s + opts.duration : perf.now(); if (s === undefined) s = opts.duration !== undefined ? e - opts.duration : 0; }
                else { s = start === undefined ? 0 : timeOf(start); e = end === undefined ? perf.now() : timeOf(end); }
                return add({ name: String(name), entryType: 'measure', startTime: s, duration: e - s, detail: opts && opts.detail !== undefined ? opts.detail : null });
            };
            perf.getEntries = function () { return entries.slice(); };
            perf.getEntriesByType = function (t) { var out = []; for (var i = 0; i < entries.length; i++) if (entries[i].entryType === t) out.push(entries[i]); return out; };
            perf.getEntriesByName = function (n, t) { var out = []; for (var i = 0; i < entries.length; i++) if (entries[i].name === n && (!t || entries[i].entryType === t)) out.push(entries[i]); return out; };
            var clear = function (type) { return function (n) { for (var i = entries.length - 1; i >= 0; i--) if (entries[i].entryType === type && (n === undefined || entries[i].name === n)) entries.splice(i, 1); }; };
            perf.clearMarks = clear('mark');
            perf.clearMeasures = clear('measure');
            perf.clearResourceTimings = function () {};
        })(self.performance);
    }
    // weak references hold on here (the engine has none; a registry is never told of a collection, which the standard
    // allows): Telegram's protocol worker makes a FinalizationRegistry at start
    if (!self.WeakRef) { self.WeakRef = function WeakRef(target) { this.__t = target; }; self.WeakRef.prototype.deref = function () { return this.__t; }; }
    if (!self.FinalizationRegistry) { self.FinalizationRegistry = function FinalizationRegistry() {}; self.FinalizationRegistry.prototype.register = function () {}; self.FinalizationRegistry.prototype.unregister = function () { return false; }; }
    // IndexedDB in workers: the WebSQL-backed shim the page gets too (see shims-extra.js), loaded on first use, where the
    // worker has WebSQL
    if (!self.indexedDB && typeof self.openDatabase === 'function' && typeof importScripts === 'function') {
        (function (G) {
            var names = ['indexedDB', 'IDBKeyRange', 'IDBFactory', 'IDBDatabase', 'IDBObjectStore', 'IDBIndex', 'IDBTransaction', 'IDBRequest', 'IDBOpenDBRequest', 'IDBCursor', 'IDBCursorWithValue', 'IDBVersionChangeEvent'];
            var loaded = false;
            var load = function () {
                if (loaded) return;
                loaded = true;
                for (var i = 0; i < names.length; i++) try { delete G[names[i]]; } catch (e) {}
                try {
                    importScripts('https://ios6-browser.invalid/indexeddbshim.js');
                    if (G.shimIndexedDB && G.shimIndexedDB.__useShim) G.shimIndexedDB.__useShim();
                    for (var j = 0; j < names.length; j++) {
                        var d = Object.getOwnPropertyDescriptor(G, names[j]);
                        if (d && d.get) { var v = G[names[j]]; Object.defineProperty(G, names[j], { value: v, writable: true, configurable: true }); }
                    }
                } catch (e2) {}
            };
            for (var k = 0; k < names.length; k++) (function (name) {
                var getter = function () {
                    load();
                    var d = Object.getOwnPropertyDescriptor(G, name);
                    return d && d.get === getter ? undefined : G[name];   // (still this getter: the shim did not come)
                };
                try { Object.defineProperty(G, name, { configurable: true, get: getter, set: function (v) { try { delete G[name]; } catch (e) {} G[name] = v; } }); } catch (e3) {}
            })(names[k]);
        })(self);
    }
    // BroadcastChannel within this worker (other contexts do not hear it; Telegram's protocol worker makes one at start)
    if (!self.BroadcastChannel) {
        (function (G) {
            var open = {};
            var BC = function BroadcastChannel(name) { this.name = String(name); this.onmessage = null; this.onmessageerror = null; this.__l = []; this.__closed = false; (open['$' + this.name] = open['$' + this.name] || []).push(this); };
            BC.prototype.postMessage = function (data) {
                if (this.__closed) throw new Error('InvalidStateError');
                var list = (open['$' + this.name] || []).slice(), from = this;
                setTimeout(function () {
                    for (var i = 0; i < list.length; i++) {
                        var c = list[i];
                        if (c === from || c.__closed) continue;
                        var ev = { type: 'message', data: data, target: c, currentTarget: c, origin: '', lastEventId: '' };
                        if (typeof c.onmessage === 'function') try { c.onmessage(ev); } catch (e) {}
                        for (var j = 0; j < c.__l.length; j++) try { c.__l[j].call(c, ev); } catch (e2) {}
                    }
                }, 0);
            };
            BC.prototype.addEventListener = function (type, fn) { if (type === 'message' && typeof fn === 'function') this.__l.push(fn); };
            BC.prototype.removeEventListener = function (type, fn) { for (var i = this.__l.length - 1; i >= 0; i--) if (this.__l[i] === fn) this.__l.splice(i, 1); };
            BC.prototype.close = function () { this.__closed = true; var l = open['$' + this.name] || []; for (var i = l.length - 1; i >= 0; i--) if (l[i] === this) l.splice(i, 1); };
            G.BroadcastChannel = BC;
        })(self);
    }
    // AbortController / AbortSignal, as in shims.js (fetch in workers takes a signal; AbortError / TimeoutError reasons)
    if (!self.AbortController) (function (G) {
        var named = function (name, msg) {
            try { var e = new G.DOMException(msg, name); if (e.name === name) return e; } catch (eD) {}
            var err = new Error(msg);
            err.name = name;
            return err;
        };
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
            s.dispatchEvent({ type: 'abort', target: s, currentTarget: s, isTrusted: true, bubbles: false, cancelable: false, defaultPrevented: false,
                eventPhase: 2, timeStamp: Date.now(), preventDefault: noop, stopPropagation: noop, stopImmediatePropagation: noop });
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
        G.AbortController = AbortController;
        G.AbortSignal = AbortSignal;
    })(self);
    // wss:// WebSockets through the app's TLS, as in shims-extra.js (a local ws:// address from /wsproxy; the engine's
    // own socket only when the app gives none - once the relay has the socket, a failure before opening is 'error' and
    // 'close', never a second try over the system's TLS; a socket object of the shims); relative and http(s) URLs taken
    // as today's browsers take them
    if (self.WebSocket && self.WebSocket.prototype && !self.WebSocket.__brLocal && typeof XMLHttpRequest !== 'undefined') (function (G) {
        var Native = G.WebSocket;
        var domException = function (name, msg) {
            try { var e = new G.DOMException(msg, name); if (e.name === name) return e; } catch (eD) {}
            var err = new Error(msg);
            err.name = name;
            return err;
        };
        var resolve = function (u) {
            var s = String(u);
            if (/^wss?:\/\//i.test(s)) return s;
            var base = String(G.location && G.location.href || ''), m = /^(https?):\/\/[^\/]+/i.exec(base);
            if (/^https?:\/\//i.test(s)) return s.replace(/^http(s?):/i, 'ws$1:');
            if (!m) return s;
            var origin = m[0].replace(/^http(s?):/i, 'ws$1:');
            if (s.charAt(0) === '/') return s.charAt(1) === '/' ? origin.split(':')[0] + ':' + s : origin + s;
            return origin + base.slice(m[0].length).replace(/[?#].*$/, '').replace(/[^\/]*$/, '') + s;
        };
        var local = function (target) {
            if (!/^wss:/i.test(target)) return null;
            if (G.__brTestWsProxy) return G.__brTestWsProxy(target);   // (tools/esnext-test.html)
            try {
                var x = new XMLHttpRequest();
                x.open('GET', 'https://ios6-browser.invalid/wsproxy?u=' + encodeURIComponent(target), false);
                x.send(null);
                return x.status === 200 ? JSON.parse(x.responseText).url : null;
            } catch (e) { return null; }
        };
        var noop = function () {};
        var make = function (url, protocols) { return protocols === undefined ? new Native(url) : new Native(url, protocols); };
        var fire = function (self, type, props) {
            var e = { type: type, target: self, currentTarget: self, srcElement: self, bubbles: false, cancelable: false, defaultPrevented: false,
                eventPhase: 2, isTrusted: true, timeStamp: Date.now(), preventDefault: noop, stopPropagation: noop, stopImmediatePropagation: noop };
            for (var k in props) e[k] = props[k];
            var h = self['on' + type], list = (self.__l[type] || []).slice();
            if (typeof h === 'function') try { h.call(self, e); } catch (err) { setTimeout(function () { throw err; }, 0); }
            for (var i = 0; i < list.length; i++) {
                if (list[i].once) self.removeEventListener(type, list[i].f);
                try { if (typeof list[i].f === 'function') list[i].f.call(self, e); else list[i].f.handleEvent(e); } catch (err2) { (function (x) { setTimeout(function () { throw x; }, 0); })(err2); }
            }
        };
        function WebSocket(url, protocols) {
            if (!(this instanceof WebSocket)) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator");
            var self = this, target = resolve(url), via = local(target), origin = target.replace(/^(wss?:\/\/[^\/?#]+).*$/i, '$1');
            self.url = target; self.readyState = 0; self.protocol = ''; self.extensions = '';
            self.onopen = self.onmessage = self.onerror = self.onclose = null;
            self.__l = {}; self.__type = 'blob'; self.__byPage = false;
            var attach = function (ws, proxied) {
                var opened = false;
                try { ws.binaryType = self.__type; } catch (e) {}
                ws.onopen = function () { opened = true; self.readyState = 1; self.protocol = ws.protocol || ''; self.extensions = ws.extensions || ''; fire(self, 'open', {}); };
                ws.onmessage = function (e) { fire(self, 'message', { data: e.data, origin: origin, lastEventId: '', ports: [] }); };
                ws.onerror = function () { if (!(proxied && !opened)) fire(self, 'error', {}); };
                ws.onclose = function (e) {
                    var code = e.code, reason = e.reason || '', clean = !!e.wasClean;
                    // (a server the app's TLS refused: the relay's 4015 "tls" becomes the error and 1015 of a failed TLS
                    // handshake, as in shims-extra.js. The relay failed before the socket opened: the page's one error, no
                    // second try - see above.)
                    if (proxied && code === 4015 && reason === 'tls' && !self.__byPage) { fire(self, 'error', {}); code = 1015; clean = false; }
                    else if (proxied && !opened && !self.__byPage) fire(self, 'error', {});
                    self.readyState = 3;
                    fire(self, 'close', { code: code, reason: reason, wasClean: clean });
                };
                return ws;
            };
            self.__ws = attach(make(via || target, protocols), !!via);
        }
        // (not below the engine's prototype: its url, readyState... can be getters there, which our own fields cannot pass)
        var WP = WebSocket.prototype = Object.create(G.EventTarget && G.EventTarget.prototype || Object.prototype);
        WP.constructor = WebSocket;
        WP.send = function (data) {
            if (this.readyState === 0) throw domException('InvalidStateError', "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
            return this.__ws.send(data);
        };
        WP.close = function (code, reason) {
            this.__byPage = true;
            if (this.readyState < 2) this.readyState = 2;
            return code === undefined ? this.__ws.close() : reason === undefined ? this.__ws.close(code) : this.__ws.close(code, reason);
        };
        WP.addEventListener = function (type, f, opts) {
            if (!f) return;
            var list = this.__l[type] || (this.__l[type] = []);
            for (var i = 0; i < list.length; i++) if (list[i].f === f) return;
            list.push({ f: f, once: !!(opts && typeof opts === 'object' && opts.once) });
        };
        WP.removeEventListener = function (type, f) {
            var list = this.__l[type] || [];
            for (var i = 0; i < list.length; i++) if (list[i].f === f) { list.splice(i, 1); return; }
        };
        WP.dispatchEvent = function (e) { fire(this, e.type, e); return true; };
        try {
            Object.defineProperty(WP, 'bufferedAmount', { configurable: true, get: function () { return this.__ws ? this.__ws.bufferedAmount : 0; } });
            Object.defineProperty(WP, 'binaryType', { configurable: true, get: function () { return this.__type; },
                set: function (v) { if (v === 'blob' || v === 'arraybuffer') { this.__type = v; try { this.__ws.binaryType = v; } catch (e) {} } } });
        } catch (eP) {}
        var states = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
        // (own properties: the engine's prototype below has them read-only, and assigning one in strict code throws)
        for (var s in states) {
            WebSocket[s] = states[s];
            try { Object.defineProperty(WP, s, { value: states[s], enumerable: true, configurable: true }); } catch (eS) {}
        }
        WebSocket.__brLocal = true;
        try { G.WebSocket = WebSocket; } catch (e2) {}
    })(self);
    // the Cache API (caches.open(name).put/match...), in memory for this worker's life (see shims-extra.js)
    if (!self.caches && self.Promise) {
        (function (G) {
            var P = G.Promise, total = [];
            var keyOf = function (req) { var u = typeof req === 'string' ? req : req && req.url; try { return new URL(String(u), G.location.href).href.replace(/#.*$/, ''); } catch (e) { return String(u); } };
            var Cache = function Cache() { this.__m = {}; };
            var copy = function (res) { try { return res && res.clone ? res.clone() : res; } catch (e) { return res; } };
            Cache.prototype.match = function (req) { var e = this.__m['$' + keyOf(req)]; return P.resolve(e ? copy(e.res) : undefined); };
            Cache.prototype.matchAll = function (req) { var out = [], k; if (req === undefined) { for (k in this.__m) out.push(copy(this.__m[k].res)); } else { var e = this.__m['$' + keyOf(req)]; if (e) out.push(copy(e.res)); } return P.resolve(out); };
            Cache.prototype.put = function (req, res) {
                var k = '$' + keyOf(req), m = this.__m;
                if (!m[k]) { total.push([m, k]); if (total.length > 150) { var old = total.shift(); delete old[0][old[1]]; } }
                m[k] = { req: typeof req === 'string' ? keyOf(req) : req, res: copy(res) };
                return P.resolve();
            };
            Cache.prototype.add = function (req) { var c = this; return G.fetch(req).then(function (res) { if (!res.ok) throw new TypeError('Request failed'); return c.put(req, res); }); };
            Cache.prototype.addAll = function (list) { var c = this, all = []; for (var i = 0; i < list.length; i++) all.push(c.add(list[i])); return P.all(all).then(function () {}); };
            Cache.prototype['delete'] = function (req) { var k = '$' + keyOf(req), had = !!this.__m[k]; delete this.__m[k]; return P.resolve(had); };
            Cache.prototype.keys = function () { var out = []; for (var k in this.__m) { var r = this.__m[k].req; out.push(typeof r === 'string' && G.Request ? new G.Request(r) : r); } return P.resolve(out); };
            var stores = {};
            var CacheStorage = function CacheStorage() {};
            CacheStorage.prototype.open = function (name) { var k = '$' + String(name); return P.resolve(stores[k] || (stores[k] = new Cache())); };
            CacheStorage.prototype.has = function (name) { return P.resolve(!!stores['$' + String(name)]); };
            CacheStorage.prototype['delete'] = function (name) { var k = '$' + String(name), had = !!stores[k]; delete stores[k]; return P.resolve(had); };
            CacheStorage.prototype.keys = function () { var out = []; for (var k in stores) out.push(k.slice(1)); return P.resolve(out); };
            CacheStorage.prototype.match = function (req) { for (var k in stores) { var e = stores[k].__m['$' + keyOf(req)]; if (e) return P.resolve(copy(e.res)); } return P.resolve(undefined); };
            G.Cache = Cache;
            G.CacheStorage = CacheStorage;
            G.caches = new CacheStorage();
        })(self);
    }
    if (!self.PerformanceObserver) {
        self.PerformanceObserver = function PerformanceObserver() {};
        self.PerformanceObserver.prototype.observe = function () {};
        self.PerformanceObserver.prototype.disconnect = function () {};
        self.PerformanceObserver.prototype.takeRecords = function () { return []; };
        self.PerformanceObserver.supportedEntryTypes = [];
    }
    // TextEncoder / TextDecoder after the Encoding standard. UTF-8: a stream ({ stream: true }) keeps an incomplete
    // sequence for the next call (a Czech letter split between two chunks turned the whole chunk into Latin-1 here),
    // invalid bytes become U+FFFD each (or a TypeError with fatal), a leading BOM goes unless ignoreBOM (JSON.parse
    // failed on it), views are read within their byteOffset/byteLength (a DataView or an Int8Array read its whole
    // buffer). Also UTF-16LE/BE, the single-byte windows-1252 (its labels latin1, ascii...), windows-1250, iso-8859-2
    // and x-user-defined; other labels throw RangeError as the standard says, so pages take their own fallback. encode
    // turns lone surrogates into U+FFFD (it threw), encodeInto. Valid UTF-8 goes through the engine's own decoder
    // (escape + decodeURIComponent), the rest through the standard's loop. (The same in shims.js.)
    if (!self.TextEncoder) (function (G) {
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
    })(self);
    var crypto = self.crypto;
    if (!crypto) { crypto = {}; try { self.crypto = crypto; } catch (e) {} }
    // crypto.getRandomValues: the values come from the app's generator (SecRandomCopyBytes), 4 KB at a time as hex from
    // https://ios6-browser.invalid/random by a synchronous request, and are not kept once handed out. Should that fail the
    // call throws: never Math.random, whose next outputs a few observed ones give away - crypto libraries make keys,
    // nonces and IVs in workers, and without a generator they stop instead of making guessable ones.
    if (!crypto.getRandomValues && typeof XMLHttpRequest !== 'undefined' && self.Uint8Array) (function (G) {
        var POOL = 4096, pool = null, used = POOL;
        var named = function (name, msg) {
            try { var e = new G.DOMException(msg, name); if (e.name === name) return e; } catch (eD) {}
            var err = new Error(msg);
            err.name = name;
            return err;
        };
        var nibble = function (c) { return c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1; };
        var refill = function () {
            var text = '', bytes, i, hi, lo;
            try {
                var x = new XMLHttpRequest();
                x.open('GET', 'https://ios6-browser.invalid/random?n=' + POOL, false);
                x.send(null);
                if (x.status === 200) text = String(x.responseText || '').replace(/\s+/g, '');
            } catch (e) { text = ''; }
            if (text.length !== POOL * 2) throw named('OperationError', 'No secure random source is available');
            bytes = new Uint8Array(POOL);
            for (i = 0; i < POOL; i++) {
                hi = nibble(text.charCodeAt(2 * i)); lo = nibble(text.charCodeAt(2 * i + 1));
                if (hi < 0 || lo < 0) throw named('OperationError', 'No secure random source is available');
                bytes[i] = (hi << 4) | lo;
            }
            pool = bytes;
            used = 0;
        };
        crypto.getRandomValues = function (arr) {
            // (integer typed arrays only, at most 65536 bytes, as the standard has it)
            if (!arr || typeof arr.byteLength !== 'number' || typeof arr.length !== 'number' || !arr.buffer || (G.DataView && arr instanceof G.DataView) ||
                (G.Float32Array && arr instanceof G.Float32Array) || (G.Float64Array && arr instanceof G.Float64Array))
                throw named('TypeMismatchError', "Failed to execute 'getRandomValues' on 'Crypto': The provided ArrayBufferView is of type 'Float' or not an integer array.");
            if (arr.byteLength > 65536) throw named('QuotaExceededError', "Failed to execute 'getRandomValues' on 'Crypto': The ArrayBufferView's byte length (" + arr.byteLength + ') exceeds the number of bytes of entropy available via this API (65536).');
            var out = new Uint8Array(arr.buffer, arr.byteOffset || 0, arr.byteLength), n = out.length, at = 0, take, k;
            while (at < n) {
                if (used >= POOL) refill();
                take = Math.min(n - at, POOL - used);
                for (k = 0; k < take; k++) { out[at + k] = pool[used + k]; pool[used + k] = 0; }
                used += take;
                at += take;
            }
            return arr;
        };
    })(self);
    if (!crypto.subtle && self.Promise) {
        var rotr = function (x, n) { return (x >>> n) | (x << (32 - n)); };
        var rotl = function (x, n) { return (x << n) | (x >>> (32 - n)); };
        var pad = function (bytes) {
            var l = bytes.length, len = ((l + 9 + 63) >> 6) << 6, msg = new Uint8Array(len), bits = l * 8, hi = Math.floor(bits / 4294967296), lo = bits >>> 0;
            msg.set(bytes);
            msg[l] = 0x80;
            msg[len - 8] = (hi >>> 24) & 255; msg[len - 7] = (hi >>> 16) & 255; msg[len - 6] = (hi >>> 8) & 255; msg[len - 5] = hi & 255;
            msg[len - 4] = (lo >>> 24) & 255; msg[len - 3] = (lo >>> 16) & 255; msg[len - 2] = (lo >>> 8) & 255; msg[len - 1] = lo & 255;
            return msg;
        };
        var words = function (msg, off, w) { for (var i = 0; i < 16; i++) w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3]; };
        var bytesOf = function (H) { var out = new Uint8Array(H.length * 4); for (var i = 0; i < H.length; i++) { out[i * 4] = H[i] >>> 24; out[i * 4 + 1] = (H[i] >>> 16) & 255; out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255; } return out; };
        var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
                 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
                 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
                 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
        var sha256 = function (bytes) {
            var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], msg = pad(bytes), w = new Array(64), i;
            for (var off = 0; off < msg.length; off += 64) {
                words(msg, off, w);
                for (i = 16; i < 64; i++) w[i] = (w[i - 16] + (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10))) | 0;
                var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
                for (i = 0; i < 64; i++) {
                    var t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
                    var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
                    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
                }
                H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
                H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
            }
            return bytesOf(H);
        };
        var sha1 = function (bytes) {
            var H = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0], msg = pad(bytes), w = new Array(80), i;
            for (var off = 0; off < msg.length; off += 64) {
                words(msg, off, w);
                for (i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
                var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4];
                for (i = 0; i < 80; i++) {
                    var f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
                    var k = i < 20 ? 0x5A827999 : i < 40 ? 0x6ED9EBA1 : i < 60 ? 0x8F1BBCDC : 0xCA62C1D6;
                    var t = (rotl(a, 5) + f + e + k + w[i]) | 0;
                    e = d; d = c; c = rotl(b, 30); b = a; a = t;
                }
                H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
            }
            return bytesOf(H);
        };
        var toBytes = function (data) {
            if (data instanceof ArrayBuffer) return new Uint8Array(data);
            if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
            return new Uint8Array(0);
        };
        var unsupported = function () { return self.Promise.reject(new Error('NotSupportedError: this operation is not available')); };
        crypto.subtle = {
            digest: function (algorithm, data) {
                var name = String(typeof algorithm === 'string' ? algorithm : (algorithm && algorithm.name) || '').toUpperCase().replace('-', '');
                try {
                    if (name === 'SHA256') return self.Promise.resolve(sha256(toBytes(data)).buffer);
                    if (name === 'SHA1') return self.Promise.resolve(sha1(toBytes(data)).buffer);
                } catch (e) { return self.Promise.reject(e); }
                return unsupported();
            },
            encrypt: unsupported, decrypt: unsupported, sign: unsupported, verify: unsupported, generateKey: unsupported, deriveKey: unsupported,
            deriveBits: unsupported, importKey: unsupported, exportKey: unsupported, wrapKey: unsupported, unwrapKey: unsupported
        };
    }
})(typeof self !== 'undefined' ? self : this);
