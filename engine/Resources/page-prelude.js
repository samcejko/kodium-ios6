// The first part of the page's polyfill bundle (before core-js): things the engine keeps as roots of its garbage
// collection, so that a page holding them stays in memory after it was left - its window, every object of its scripts,
// its document (27 000 objects of ours on example.com, 200 000 more on each visit of novinky.cz) - until iOS closed the
// app after a few pages.
// The engine's own Object functions, taken before core-js puts its Symbol checks in front of them: shims.js goes
// straight to them where a key cannot be one of core-js's symbols (the checks made defineProperty ten times and
// Object.assign seventeen times slower here, and bundles call them by the ten thousand).
(function () {
    try {
        Object.defineProperty(window, '__brNative', { value: { defineProperty: Object.defineProperty, getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
            keys: Object.keys, getOwnPropertyNames: Object.getOwnPropertyNames, stringify: window.JSON && JSON.stringify,
            propertyIsEnumerable: Object.prototype.propertyIsEnumerable }, writable: true, configurable: true });
    } catch (e) {}
    // requestAnimationFrame by its standard name before the polyfills that take it when they load: the resize
    // observer's found only the prefixed one and checked sizes on a 16 ms timer instead, between frames - a layout of
    // its own after every change of the page. (shims.js puts its frame budget in front of it later.)
    if (!window.requestAnimationFrame && window.webkitRequestAnimationFrame) {
        window.requestAnimationFrame = window.webkitRequestAnimationFrame;
        window.cancelAnimationFrame = window.webkitCancelAnimationFrame || window.webkitCancelRequestAnimationFrame;
    }
})();
(function () {
    var releases = [], gone = false;
    var release = function (e) {
        if (gone || e && e.type === 'pagehide' && e.persisted) return;    // (kept to come back to)
        gone = true;
        for (var i = 0; i < releases.length; i++) { try { releases[i](); } catch (x) {} }
    };

    // MutationObserver: the engine holds its callback and the page's window with strong references for as long as it
    // lives, and it lives while anything reaches it - the page, which that root keeps; disconnecting is not enough while
    // the page still holds the observer. So pages get stand-in observers that hold the engine's ones; when the page goes
    // away, those are disconnected and let go, nothing reaches them any more, and the roots go with them.
    // (The stand-ins also take the options of the current standard: attributeFilter/-OldValue imply attributes, and
    // characterDataOldValue implies characterData; this engine threw.)
    (function () {
        var Native = window.MutationObserver || window.WebKitMutationObserver;
        if (!Native || Native.__brBoxed) return;
        var live = [];
        var state = function (o) {
            var s = o && o.__brMO;
            if (!s) throw new TypeError('Illegal invocation');
            return s;
        };
        var MO = function MutationObserver(callback) {
            if (!(this instanceof MO)) throw new TypeError("Failed to construct 'MutationObserver': Please use the 'new' operator.");
            if (typeof callback !== 'function') throw new TypeError("Failed to construct 'MutationObserver': The callback provided as parameter 1 is not a function.");
            var s = { cb: callback, self: this, native: null };
            try { Object.defineProperty(this, '__brMO', { value: s, configurable: true }); } catch (e) { this.__brMO = s; }
        };
        MO.prototype.observe = function (target, options) {
            var s = state(this), o = options;
            if (gone) return;
            if (o && typeof o === 'object' &&
                (o.attributes === undefined && (o.attributeOldValue !== undefined || o.attributeFilter !== undefined) ||
                 o.characterData === undefined && o.characterDataOldValue !== undefined)) {
                var c = {};
                for (var k in o) c[k] = o[k];
                if (c.attributes === undefined && (c.attributeOldValue !== undefined || c.attributeFilter !== undefined)) c.attributes = true;
                if (c.characterData === undefined && c.characterDataOldValue !== undefined) c.characterData = true;
                o = c;
            }
            if (!s.native) {
                s.native = new Native(function (records) { return s.cb.call(s.self, records, s.self); });
                live.push(s);
            }
            s.native.observe(target, o);
        };
        MO.prototype.disconnect = function () {
            var s = state(this);
            if (!s.native) return;
            s.native.disconnect();
            s.native = null;    // (the next observe makes a new one)
            var i = live.indexOf(s);
            if (i >= 0) live.splice(i, 1);
        };
        MO.prototype.takeRecords = function () {
            var s = state(this);
            return s.native ? s.native.takeRecords() : [];
        };
        MO.prototype.constructor = MO;
        MO.toString = function () { return 'function MutationObserver() {\n    [native code]\n}'; };
        MO.__brBoxed = true;
        MO.__brNative = Native;
        try { window.MutationObserver = MO; } catch (e1) {}
        if (window.WebKitMutationObserver) { try { window.WebKitMutationObserver = MO; } catch (e2) {} }
        releases.push(function () {
            for (var i = 0; i < live.length; i++) {
                var s = live[i];
                if (s.native) { try { s.native.disconnect(); } catch (x) {} s.native = null; }
            }
            live = [];
        });
    })();

    // queueMicrotask, before core-js: its Promise then runs its callbacks through it. On iOS core-js does not use a
    // MutationObserver (an iOS 9 bug) and there is no Promise here, so every callback of a promise waited for a message
    // posted to the window: 0.2 ms a step, as a task of its own (the page could lay out and paint between the steps
    // of one chain), and the page's own message listeners got all those messages. The engine delivers mutation
    // records at the end of each script, as microtasks run; the observer is one of the stand-ins above, let go with
    // the page.
    // A job is four slots of the queue, a function and three arguments: the shims' Promise queues its reactions that
    // way (__brNative.queueJob), without a closure for each - a function that makes one gets a scope object on every
    // call here. Written by index: Array.prototype.push gets a wrapper later.
    (function () {
        var MO = window.MutationObserver;
        if (window.queueMicrotask || !MO || !MO.__brBoxed || !document.createTextNode) return;
        var queue = [], toggle = false, node = document.createTextNode('');
        var rethrow = function (e) { setTimeout(function () { throw e; }, 0); };
        var flush = function () {
            var q = queue;
            queue = [];
            for (var i = 0; i < q.length; i += 4) {
                try { q[i](q[i + 1], q[i + 2], q[i + 3]); } catch (e) { rethrow(e); }
            }
        };
        new MO(flush).observe(node, { characterData: true });
        var later = function (fn, a, b, c) { setTimeout(function () { fn(a, b, c); }, 0); };
        var queueJob = function (fn, a, b, c) {
            if (gone) { later(fn, a, b, c); return; }
            var n = queue.length;
            if (!n) node.data = (toggle = !toggle) ? '1' : '0';
            queue[n] = fn; queue[n + 1] = a; queue[n + 2] = b; queue[n + 3] = c;
        };
        window.queueMicrotask = function queueMicrotask(callback) {
            if (typeof callback !== 'function') throw new TypeError("Failed to execute 'queueMicrotask' on 'Window': The callback provided as parameter 1 is not a function.");
            queueJob(callback, undefined, undefined, undefined);
        };
        // (core-js puts a wrapper of its own in front, 27 us a call here: shims.js puts this one back, and its Promise
        // uses it)
        if (window.__brNative) { window.__brNative.queueMicrotask = window.queueMicrotask; window.__brNative.queueJob = queueJob; }
    })();

    // matchMedia listeners are such roots too (until the document is destroyed - never, while they keep it): they are
    // removed when the page goes away.
    (function () {
        var proto = null;
        try { proto = window.matchMedia && Object.getPrototypeOf(window.matchMedia('all')); } catch (e) {}
        var add = proto && proto.addListener, remove = proto && proto.removeListener;
        if (typeof add !== 'function' || typeof remove !== 'function' || add.__brBoxed) return;
        var heard = [];     // list, listener, list, listener, ...
        var find = function (list, fn) {
            for (var i = 0; i < heard.length; i += 2) if (heard[i] === list && heard[i + 1] === fn) return i;
            return -1;
        };
        proto.addListener = function (fn) {
            if (gone) return;
            if (typeof fn === 'function' && find(this, fn) < 0) heard.push(this, fn);
            return add.apply(this, arguments);
        };
        proto.removeListener = function (fn) {
            var i = find(this, fn);
            if (i >= 0) heard.splice(i, 2);
            return remove.apply(this, arguments);
        };
        proto.addListener.__brBoxed = true;
        releases.push(function () {
            for (var i = 0; i < heard.length; i += 2) { try { remove.call(heard[i], heard[i + 1]); } catch (x) {} }
            heard = [];
        });
    })();

    // A CustomEvent's detail is such a root while the event lives, so a page that keeps an event keeps itself. Custom
    // events are plain events here, with the detail as their own property (and the prototype of CustomEvent).
    (function () {
        var Native = window.CustomEvent, NP = Native && Native.prototype;
        var owner = document;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, 'createEvent')) owner = Object.getPrototypeOf(owner);
        var create = owner && owner.createEvent;
        if (!NP || typeof create !== 'function' || create.__brBoxed) return;
        var initEvent = null;
        try { initEvent = create.call(document, 'Event').initEvent; } catch (e) {}
        if (typeof initEvent !== 'function') return;
        var P = Object.create(NP);
        var detail = function (e, d) {
            try { Object.defineProperty(e, 'detail', { value: d, writable: true, enumerable: true, configurable: true }); } catch (x) { e.detail = d; }
        };
        P.initCustomEvent = function (type, bubbles, cancelable, d) {
            initEvent.call(this, type, bubbles, cancelable);
            detail(this, d === undefined ? null : d);
        };
        var make = function (doc, proto) {
            var e = create.call(doc, 'Event');
            e.__proto__ = proto;
            detail(e, null);
            return e;
        };
        owner.createEvent = function (kind) {
            if (typeof kind === 'string' && kind.toLowerCase() === 'customevent') return make(this, P);
            return create.apply(this, arguments);
        };
        owner.createEvent.__brBoxed = true;
        var CE = function CustomEvent(type, init) {
            if (!arguments.length) throw new TypeError("Failed to construct 'CustomEvent': 1 argument required, but only 0 present.");
            // (a subclass's prototype stays: ES5 classes call this with their own instance)
            var e = make(document, this instanceof CE ? Object.getPrototypeOf(this) : P);
            P.initCustomEvent.call(e, String(type), !!(init && init.bubbles), !!(init && init.cancelable), init ? init.detail : null);
            return e;
        };
        CE.prototype = P;
        P.constructor = CE;
        try { window.CustomEvent = CE; } catch (e3) {}
    })();

    // WebSQL (under this browser's IndexedDB): a transaction still waiting when its page is left - for the database file
    // that the next page of the same site is writing - holds its callbacks and the page's window as roots as long as it
    // waits; YouTube kept every page it was left for until iOS closed the app. So databases are opened by a hidden frame
    // of the page: the roots are then that frame's window and small go-betweens of it, which reach the page's callbacks
    // through a gate that closes when the page goes away. (No new transactions start after that.)
    (function () {
        var open = window.openDatabase;
        if (typeof open !== 'function' || open.__brBoxed) return;
        var fw = null, frame = null, gate = null, gates = [], make = null, calls = {}, next = 1;
        var end = function (g) {
            for (var i = 0; i < g.ids.length; i++) delete calls[g.ids[i]];
            g.ids = [];
            if (g.statements) {
                for (var j = 0; j < g.statements.length; j++) end(g.statements[j]);
                g.statements = [];
            }
        };
        var Tx = function (n, g) { this.__brN = n; this.__brG = g; };
        var dispatch = function (id, a, b) {
            var c = calls[id];
            if (!c) return;
            var g = c.group, fn = c.fn;
            if (c.kind === 'tx') return fn(g.tx || (g.tx = new Tx(a, g)));
            end(g);
            if (c.kind === 'st') return fn(g.tx, b);      // (statements: the page's transaction and the result or error)
            if (c.kind === 'create') return fn(g.db);
            return fn(a);                                  // (the transaction's error or success)
        };
        var helper = function () {
            if (fw && frame.parentNode && frame.contentWindow === fw) return true;
            fw = null;
            try {
                var root = document.head || document.documentElement;
                if (!root) return false;
                var f = document.createElement('iframe');
                f.style.cssText = 'display:none!important';
                f.setAttribute('aria-hidden', 'true');
                f.tabIndex = -1;
                root.appendChild(f);
                var w = f.contentWindow;
                if (!w || typeof w.openDatabase !== 'function') { root.removeChild(f); return false; }
                make = w.Function('gate', 'id', 'return function (a, b) { var f = gate.f; if (f) return f(id, a, b); };');
                gate = new w.Object();
                gate.f = dispatch;
                gates.push(gate);
                frame = f;
                fw = w;
                return true;
            } catch (e) { return false; }
        };
        var tramp = function (fn, kind, g) {
            if (typeof fn !== 'function') return fn === undefined ? null : fn;
            var id = next++;
            calls[id] = { fn: fn, kind: kind, group: g };
            g.ids.push(id);
            return make(gate, id);
        };
        Tx.prototype.executeSql = function (sql, args, cb, err) {
            var g = this.__brG, s = { ids: [], tx: this };
            g.statements.push(s);
            this.__brN.executeSql(sql, args, tramp(cb, 'st', s), tramp(err, 'st', s));
        };
        var Db = function (args) { this.__brArgs = args; this.__brN = null; this.__brW = null; };
        var native = function (d) {
            if (!helper()) throw new Error('The database is not available');
            // (a frame the page removed is replaced; the database is opened again in the new one)
            if (d.__brW !== fw) { d.__brN = fw.openDatabase.apply(fw, d.__brArgs); d.__brW = fw; }
            return d.__brN;
        };
        try { Object.defineProperty(Db.prototype, 'version', { get: function () { return native(this).version; }, configurable: true }); } catch (e) {}
        var run = function (k, n) {
            return function () {
                if (gone) return;
                var a = Array.prototype.slice.call(arguments, 0, n + 3), g = { ids: [], tx: null, statements: [] };
                a[n] = tramp(a[n], 'tx', g);
                a[n + 1] = tramp(a[n + 1], 'end', g);
                a[n + 2] = tramp(a[n + 2], 'end', g);
                var d = native(this);
                return d[k].apply(d, a);
            };
        };
        Db.prototype.transaction = run('transaction', 0);
        Db.prototype.readTransaction = run('readTransaction', 0);
        Db.prototype.changeVersion = run('changeVersion', 2);
        var od = function openDatabase(name, version, displayName, size, created) {
            var d = new Db([name, version, displayName, size]);
            if (gone) return d;
            if (!helper()) return open.apply(window, arguments);
            var g = { ids: [], db: d };
            d.__brN = created === undefined ? fw.openDatabase(name, version, displayName, size) :
                fw.openDatabase(name, version, displayName, size, tramp(created, 'create', g));
            d.__brW = fw;
            return d;
        };
        od.__brBoxed = true;
        try { window.openDatabase = od; } catch (e1) {}
        releases.push(function () {
            for (var i = 0; i < gates.length; i++) gates[i].f = null;
            gates = [];
            calls = {};
        });
    })();

    window.addEventListener('pagehide', release, false);
    window.addEventListener('unload', release, false);
})();
