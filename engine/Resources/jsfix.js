/*
 * jsfix.js: ES2015-ES2022 syntax to ES5 for the JavaScriptCore of iOS 6.
 *
 * Runs in the app's own JavaScriptCore context on the rewriter thread (BRCSSRewriter), after acorn (MIT, fetched in CI
 * into Resources/js/acorn.js), and in desktop browsers for the tests (tools/jsfix-test.html). A script the engine
 * already parses (new Function) is left alone. Otherwise the acorn tree is analysed (scopes: block bindings that must
 * be renamed when they become function-scoped `var`s, loops whose closures capture per-iteration bindings) and printed
 * back as ES5 by a printer that lowers the newer syntax while it prints; subtrees without newer syntax are copied from
 * the source text. The helpers the output needs are prepended as function declarations (every script carries its own
 * copy; they are identical, so scripts redefining them do no harm).
 *
 * ES5 only in this file (it runs on the old engine itself).
 */
(function (root) {
    'use strict';

    var hasOwn = Object.prototype.hasOwnProperty;

    // ------------------------------------------------------------------------------------------------ runtime helpers
    // Written as functions here and emitted from their source text ("function __br_x" + everything from the "(").
    var RUNTIME = {
        // for...of: a function returning {done, value} steps (one reused object for arrays and array-likes)
        __br_iter: function (x) {
            if (x == null) throw new TypeError(x + ' is not iterable');
            var i = 0, step = { done: false, value: undefined }, it, S = typeof Symbol === 'function' ? Symbol.iterator : null;
            var list = function () { if (i < x.length) { step.value = x[i++]; return step; } step.done = true; step.value = undefined; return step; };
            // (Array.isArray: the engine's own, where Object.prototype.toString is the shim's that reads Symbol.toStringTag)
            if (Array.isArray(x)) return list;
            if (S && x[S] != null) { it = x[S](); return function () { return it.next(); }; }
            if (typeof x['@@iterator'] === 'function') { it = x['@@iterator'](); return function () { return it.next(); }; }
            if (typeof x === 'string') { x = x.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) || []; return list; }
            if (typeof x.length === 'number') return list;
            throw new TypeError(x + ' is not iterable');
        },
        // [...x], f(...x): a fresh array from any iterable. An array's holes come out as undefined, as its iterator
        // reads them: [...Array(8)].map(f) makes 8 items (with slice's holes map made none - rohlik.cz's skeleton
        // cards, and React threw the server's page away as not matching)
        __br_spread: function (x) {
            var a, i, n, s, next;
            if (Array.isArray(x)) {
                a = Array.prototype.slice.call(x);
                for (i = 0, n = a.length; i < n; i++) if (!(i in a)) a[i] = undefined;
                return a;
            }
            next = __br_iter(x);
            a = [];
            while (!(s = next()).done) a.push(s.value);
            return a;
        },
        // for await (x of it): the async iterator of it, or its sync iterator with each value awaited
        __br_asyncIter: function (x) {
            if (x == null) throw new TypeError(x + ' is not async iterable');
            var AS = typeof Symbol === 'function' ? Symbol.asyncIterator : null;
            if (AS && x[AS] != null) return x[AS]();
            if (typeof x['@@asyncIterator'] === 'function') return x['@@asyncIterator']();
            var next = __br_iter(x);
            return {
                next: function () {
                    var s = next(), done = s.done;
                    return Promise.resolve(s.value).then(function (v) { return { done: done, value: v }; });
                }
            };
        },
        // array destructuring: arrays as they are (with a rest element, holes read as undefined as in a spread), other
        // iterables read up to n items (all when n < 0)
        __br_arr: function (x, n) {
            if (Array.isArray(x)) return n < 0 ? __br_spread(x) : x;
            var next = __br_iter(x), a = [], s;
            while ((n < 0 || a.length < n) && !(s = next()).done) a.push(s.value);
            return a;
        },
        // {a, ...rest} = src
        __br_objRest: function (src, keys) {
            if (src == null) throw new TypeError('Cannot destructure ' + src);
            var out = {}, ex = {}, k, i;
            for (i = 0; i < keys.length; i++) ex['$' + keys[i]] = 1;
            for (k in src) {
                if (!Object.prototype.hasOwnProperty.call(src, k) || ex['$' + k]) continue;
                if (k === '__proto__') Object.defineProperty(out, k, { value: src[k], enumerable: true, writable: true, configurable: true });
                else out[k] = src[k];
            }
            if (Object.getOwnPropertySymbols && typeof src === 'object') {
                var syms = Object.getOwnPropertySymbols(src);
                for (i = 0; i < syms.length; i++) if (!ex['$' + String(syms[i])] && Object.prototype.propertyIsEnumerable.call(src, syms[i])) out[syms[i]] = src[syms[i]];
            }
            return out;
        },
        // {...src}: own enumerable properties copied
        __br_assignOwn: function (target, src) {
            if (src == null) return target;
            var k, i;
            for (k in src) {
                if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
                if (k === '__proto__') Object.defineProperty(target, k, { value: src[k], enumerable: true, writable: true, configurable: true });
                else target[k] = src[k];
            }
            if (Object.getOwnPropertySymbols && typeof src === 'object') {
                var syms = Object.getOwnPropertySymbols(src);
                for (i = 0; i < syms.length; i++) if (Object.prototype.propertyIsEnumerable.call(src, syms[i])) target[syms[i]] = src[syms[i]];
            }
            return target;
        },
        // object literal members after the first computed key or spread: [key, value, kind]* (0 data, 1 get, 2 set, 3 spread)
        __br_props: function (obj, list) {
            for (var i = 0; i < list.length; i += 3) {
                var k = list[i], v = list[i + 1], kind = list[i + 2];
                if (kind === 3) { __br_assignOwn(obj, v); continue; }
                if (kind === 0) { Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true }); continue; }
                var old = Object.getOwnPropertyDescriptor(obj, k), d = { enumerable: true, configurable: true };
                if (old && !('value' in old)) { d.get = old.get; d.set = old.set; }
                if (kind === 1) d.get = v; else d.set = v;
                Object.defineProperty(obj, k, d);
            }
            return obj;
        },
        // tagged templates: the strings array with .raw, frozen, one per call site
        __br_tpl: function (s, r) {
            Object.defineProperty(s, 'raw', { value: r });
            if (Object.freeze) { Object.freeze(r); Object.freeze(s); }
            return s;
        },
        // class C extends S
        __br_inherits: function (C, S) {
            if (S !== null && !(S && (typeof S === 'function' || typeof S === 'object') && S.prototype !== undefined)) throw new TypeError('Class extends value ' + S + ' is not a constructor or null');
            C.prototype = Object.create(S === null ? null : S.prototype, { constructor: { value: C, writable: true, configurable: true } });
            if (S === null) return;
            try { C.__proto__ = S; } catch (e) {}
            // the DOM interface objects of this engine are not functions: the class keeps call/apply
            if (typeof S !== 'function') { C.call = Function.prototype.call; C.apply = Function.prototype.apply; C.bind = Function.prototype.bind; }
        },
        // methods and accessors: [key, value, kind]* (0 method, 1 get, 2 set), not enumerable
        __br_defs: function (o, list) {
            for (var i = 0; i < list.length; i += 3) {
                var k = list[i], v = list[i + 1], kind = list[i + 2], d;
                if (kind === 0) d = { value: v, writable: true, configurable: true, enumerable: false };
                else {
                    var old = Object.getOwnPropertyDescriptor(o, k);
                    d = { configurable: true, enumerable: false };
                    if (old && !('value' in old)) { d.get = old.get; d.set = old.set; }
                    if (kind === 1) d.get = v; else d.set = v;
                }
                try { Object.defineProperty(o, k, d); } catch (e) { if (kind === 0) o[k] = v; }
            }
        },
        __br_class: function (C, proto, stat) {
            if (proto) __br_defs(C.prototype, proto);
            if (stat) __br_defs(C, stat);
            try { Object.defineProperty(C, '__br_c', { value: 1 }); } catch (e) {}
            return C;
        },
        // native constructors (built-ins, DOM interfaces) cannot be called on an existing object. (The hot helpers keep
        // try and inner functions in helpers of their own: the old engine charges a function that has one on every call.)
        __br_isNative: function (f) {
            if (typeof f !== 'function') return true;
            if (f.__br_c) return false;
            return Object.prototype.hasOwnProperty.call(f, '__br_n') ? f.__br_n : __br_nativeLook(f);
        },
        __br_nativeLook: function (f) {
            var n;
            try { n = /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(f)); } catch (e) { n = true; }
            try { Object.defineProperty(f, '__br_n', { value: n }); } catch (e2) {}
            return n;
        },
        // Proxy for scripts that use it without a fallback (Alpine's reactivity and scope proxies, Immer's drafts): an
        // ES5 engine intercepts only properties that exist as accessors, so the proxy gets one per key the handler's
        // ownKeys() reports (the target's own keys without that trap; enumerable as its getOwnPropertyDescriptor()
        // says), Vue's reactivity flags and Immer's state symbol; array proxies keep accessors a little past the end,
        // so push() reaches the set trap, and pass Array.isArray. Keys the page adds or deletes are not intercepted
        // when it happens: proxies of Proxy.revocable (Immer's drafts) hand them to the set / deleteProperty traps when
        // the state symbol is read (Immer reads it before it finalizes a draft). has and defineProperty are not
        // intercepted. Function targets call apply/construct.
        __br_Proxy: function (target, handler) {
            var P = __br_Proxy, slice = Array.prototype.slice, hasOwn = Object.prototype.hasOwnProperty;
            if (!P.revocable) {
                // (statics: the helper text calls __br_Proxy() once)
                P.ids = 0;
                P.pass = 0;
                P.revocable = function (t, h) {
                    P.rev = true;
                    var p = new P(t, h), off = P.off;
                    P.rev = false;
                    return { proxy: p, revoke: off };
                };
            }
            if (!(this instanceof P)) {
                // (__br_Proxy('revocable') is Proxy.revocable where the helper text comes after the script: the
                // statics are made above when it runs)
                if (handler === undefined && (target === undefined || target === 'revocable')) return target && P.revocable;
                throw new TypeError("Constructor Proxy requires 'new'");
            }
            if (target === null || (typeof target !== 'object' && typeof target !== 'function') || handler === null || typeof handler !== 'object') {
                throw new TypeError('Cannot create proxy with a non-object as target or handler');
            }
            var proxy, done = {}, getters = {}, isArr = Object.prototype.toString.call(target) === '[object Array]', slack = 0;
            var INNER = P.INNER || (P.INNER = { __br_proxyArray: 1, toJSON: 1, __br_sweep: 1, __br_resync: 1, __br_read: 1, __br_write: 1, __br_id: 1 });
            var INDEX = P.INDEX || (P.INDEX = /^(?:0|[1-9]\d*)$/);
            // a proxy of Proxy.revocable (an Immer draft) knows the drafts read through it (kids): when its state is
            // read, it and they look for keys the page added or deleted, as Immer is about to use them
            var kids = P.rev ? [] : null, kidIds = kids && {}, alive = true, pass = 0;
            var adopt = function (v) { var id = v.__br_id; if (id !== undefined && !kidIds[id]) { kidIds[id] = 1; kids.push(v); } };
            // (the receiver of a set is the target: Reflect.set(target, key, v, proxy) would find our accessor on the
            // proxy and refuse)
            var read = function (key) { return handler.get ? handler.get(target, key, proxy) : target[key]; };
            var write = function (key, v) { if (handler.set) handler.set(target, key, v, target); else target[key] = v; };
            var ownKeys = function () {
                if (!handler.ownKeys) return Object.getOwnPropertyNames(target);
                try { return handler.ownKeys(target); } catch (e) { return []; }
            };
            // as the trap says; array indices by the length, index keys of objects without asking the trap (Immer asks
            // its base for each key: a call and an object per key of a big map)
            var enumerable = function (key, len) {
                if (INDEX.test(key)) { if (isArr) return +key < len; if (handler.getOwnPropertyDescriptor) return true; }
                else if (isArr && key === 'length') return false;
                var d = null;
                try { d = handler.getOwnPropertyDescriptor ? handler.getOwnPropertyDescriptor(target, key) : Object.getOwnPropertyDescriptor(target, key); } catch (e) {}
                return !!(d && d.enumerable);
            };
            // (an Immer array draft's target is [state]: the length comes through the trap)
            var arrLength = function () {
                if (handler.getOwnPropertyDescriptor && handler.get) { var n = +read('length'); if (n >= 0) return n; }
                return target.length;
            };
            var proto = null;
            try { proto = handler.getPrototypeOf ? handler.getPrototypeOf(target) : Object.getPrototypeOf(target); } catch (e0) { proto = Object.getPrototypeOf(target); }
            // a Map / Set target (Vue's reactive collections have only a get trap that returns instrumented methods):
            // the methods go through the trap too, else they ran on this object and core-js refused ("Incompatible
            // receiver, Map required")
            var coll = false;
            try { coll = (typeof Map === 'function' && target instanceof Map) || (typeof Set === 'function' && target instanceof Set) ||
                         (typeof WeakMap === 'function' && target instanceof WeakMap) || (typeof WeakSet === 'function' && target instanceof WeakSet); } catch (e4) {}
            // names for proxies that answer any key through a get trap (motion's motion.div / motion.create, style
            // slots pt.root / pt.overlay of tailwind-variants): HTML and SVG tags and common slot names, as accessors
            // of one shared prototype that read through the proxy's own trap
            var NAMES = P.names || (P.names = (function () {
                var list = ('a abbr address area article aside audio b bdi bdo blockquote body br button canvas caption cite code col colgroup data ' +
                    'datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr ' +
                    'html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p ' +
                    'picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table ' +
                    'tbody td template textarea tfoot th thead time title tr track u ul var video wbr svg animate animateMotion animateTransform circle ' +
                    'clipPath defs desc ellipse feBlend feColorMatrix feComponentTransfer feComposite feDiffuseLighting feDisplacementMap feDropShadow ' +
                    'feFlood feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset feSpecularLighting feTile feTurbulence filter foreignObject ' +
                    'g image line linearGradient marker mask path pattern polygon polyline radialGradient rect stop switch symbol text textPath tspan use ' +
                    'view create custom root base overlay content description icon trigger item items wrapper container list close closeButton ' +
                    'actions action indicator thumb track range viewport arrow separator group groupLabel avatar badge subtitle caption heading ' +
                    'menuItem panel tab tabs tabList tooltip popover drawer sheet backdrop handle control value placeholder prefix suffix leading ' +
                    'trailing start end left right top bottom inner outer card cardHeader cardBody cardFooter headerContent footerContent media hint ' +
                    'error helper helperText message field checkbox radio slider bar fill spinner loader skeleton chip tag counter count dot divider ' +
                    'spacer cell row column navigation breadcrumb pagination page prev next previous logo brand buttons primary secondary').split(' ');
                var seen = {}, out = [];
                for (var n = 0; n < list.length; n++) if (!seen['$' + list[n]]) { seen['$' + list[n]] = 1; out.push(list[n]); }
                return out;
            })());
            var readOnly = !!handler.get && !handler.set && !handler.has && !handler.ownKeys && !handler.deleteProperty && !handler.defineProperty;
            if (typeof target === 'function') {
                proxy = function () {
                    var args = slice.call(arguments);
                    if (this instanceof proxy) return handler.construct ? handler.construct(target, args, proxy) : __br_new(target, args);
                    return handler.apply ? handler.apply(target, this, args) : target.apply(this, args);
                };
                proxy.prototype = target.prototype;
            } else if (readOnly && !isArr && !coll && (proto === Object.prototype || proto === null || proto === undefined)) {
                if (!P.factory) {
                    P.factory = Object.create(Object.prototype);
                    for (var fn = 0; fn < NAMES.length; fn++) (function (k) {
                        try {
                            Object.defineProperty(P.factory, k, { get: function () { var r = this.__br_read; return r ? r(k) : undefined; },
                                set: function (v) { var w = this.__br_write; if (w) w(k, v); }, configurable: true });
                        } catch (e8) {}
                    })(NAMES[fn]);
                }
                proxy = Object.create(P.factory);
                try { Object.defineProperty(proxy, '__br_read', { value: read }); Object.defineProperty(proxy, '__br_write', { value: write }); } catch (e9) {}
            } else proxy = Object.create(proto === undefined ? Object.prototype : proto);
            // (again when the key's enumerability changed: an array index past the end that got a value)
            var define = function (key, len) {
                if (typeof key !== 'string' || key.slice(0, 5) === '__br_') return;
                var en = enumerable(key, len), was = done['$' + key];
                if (was === en) return;
                done['$' + key] = en;
                var get = getters['$' + key] = kids === null ? function () { return read(key); }
                                                             : function () { var v = read(key); if (v !== null && typeof v === 'object') adopt(v); return v; };
                try {
                    Object.defineProperty(proxy, key, { get: get, set: function (v) { write(key, v); grown(key); }, enumerable: en, configurable: true });
                } catch (e) {}
            };
            var getterOf = proxy.__lookupGetter__ ? function (key) { return proxy.__lookupGetter__(key); }
                                                  : function (key) { var d = Object.getOwnPropertyDescriptor(proxy, key); return d && d.get; };
            // accessors for keys that are not the target's: read only through the trap (not counted, not swept)
            var special = function (key, state) {
                try {
                    Object.defineProperty(proxy, key, { get: function () { if (state && kids !== null) sweep(++P.pass); return read(key); },
                                                        set: function (v) { write(key, v); }, enumerable: false, configurable: true });
                } catch (e) {}
            };
            var extend = function (len) {
                var n = len + 16;
                for (var k = slack; k < n; k++) define(String(k), len);
                if (n > slack) slack = n;
            };
            var grown = function (key) {
                if (!isArr) return;
                var len = arrLength();
                if (key === 'length') { for (var k = len; k < slack; k++) define(String(k), len); }
                else define(key, len);
                extend(len);
            };
            var keys = function () {
                var list = ownKeys(), len = isArr ? arrLength() : 0;
                for (var k = 0; k < list.length; k++) define(list[k], len);
                if (isArr) extend(len);
            };
            // keys the page added (plain values, also where it had deleted our accessor: that delete first) or deleted
            // since: to the traps (nothing to do while the own names are as at the last look)
            var seen = null;
            var look = function () {
                var own = Object.getOwnPropertyNames(proxy), k, key, d, gone = [], changed = false;
                if (seen !== null && own.length === seen.length) {
                    for (k = 0; k < own.length && own[k] === seen[k]; k++) {}
                    if (k === own.length) return;
                }
                for (k = 0; k < own.length; k++) {
                    key = own[k];
                    if (INNER[key] || (getters['$' + key] && getterOf(key) === getters['$' + key])) continue;
                    d = Object.getOwnPropertyDescriptor(proxy, key);
                    if (d && 'value' in d) {
                        delete proxy[key];
                        if (done['$' + key] !== undefined && handler.deleteProperty) handler.deleteProperty(target, key);
                        done['$' + key] = getters['$' + key] = undefined;
                        write(key, d.value);
                        changed = true;
                    }
                }
                for (var dk in done) {
                    if (dk.charAt(0) === '$' && done[dk] !== undefined && !hasOwn.call(proxy, dk.slice(1))) gone.push(dk.slice(1));
                }
                if (gone.length) {
                    var still = {}, list = ownKeys();
                    for (k = 0; k < list.length; k++) if (typeof list[k] === 'string') still['$' + list[k]] = 1;
                    for (k = 0; k < gone.length; k++) {
                        key = gone[k];
                        done['$' + key] = getters['$' + key] = undefined;
                        if (still['$' + key]) { if (handler.deleteProperty) handler.deleteProperty(target, key); else delete target[key]; }
                    }
                    changed = true;
                }
                if (!changed) { seen = own; return; }
                keys();
                if (isArr) { var len = arrLength(); for (k = 0; k < gone.length; k++) if (INDEX.test(gone[k]) && +gone[k] < slack) define(gone[k], len); }
                seen = Object.getOwnPropertyNames(proxy);
            };
            // (this proxy and its kids, once in a pass; a revoked one no more)
            var sweep = function (n) {
                if (!alive || pass === n) return;
                pass = n;
                if (typeof proxy !== 'function') look();
                for (var i = 0; i < kids.length; i++) kids[i].__br_sweep(n);
            };
            if (kids !== null) {
                try { Object.defineProperty(proxy, '__br_sweep', { value: sweep }); Object.defineProperty(proxy, '__br_id', { value: ++P.ids }); } catch (e1) {}
                P.off = function () { alive = false; };
            }
            keys();
            // (keys a script adds to the target itself later: Object.assign to it asks its proxies to look again, see
            // shims.js - Pinia assigns a store's actions to toRaw(store))
            if (typeof target === 'object' && !isArr) {
                try {
                    Object.defineProperty(proxy, '__br_resync', { value: keys });
                    var px = target.__br_px;
                    if (!px) { px = []; Object.defineProperty(target, '__br_px', { value: px, configurable: true }); }
                    if (px.length < 8) px.push(proxy);
                } catch (e7) {}
            }
            // Vue's component proxy (target: the instance's ctx, { _: instance }): its keys come from setupState, data,
            // props, methods, computed... and most exist only after it is made. The options name them now; data and
            // setupState are watched as the instance gets them (this.setup() in mounted() was undefined: kosik.cz)
            var inst = target._;
            if (inst && typeof inst === 'object' && inst.ctx === target && 'setupState' in inst && 'vnode' in inst) {
                var addKeys = function (o, own) {
                    if (!o || (typeof o !== 'object' && typeof o !== 'function')) return;
                    var ks = own ? Object.getOwnPropertyNames(o) : [], k2;
                    if (!own) for (k2 in o) ks.push(k2);
                    for (var q = 0; q < ks.length; q++) if (typeof ks[q] === 'string' && !/^__(br|v)_/.test(ks[q]) && done['$' + ks[q]] === undefined) define(ks[q]);
                };
                var fromOptions = function (opt, depth) {
                    if (!opt || typeof opt !== 'object' || depth > 4) return;
                    addKeys(opt.methods, false); addKeys(opt.computed, false); addKeys(opt.props, false);
                    if (opt.inject) { if (Object.prototype.toString.call(opt.inject) === '[object Array]') { for (var q = 0; q < opt.inject.length; q++) if (done['$' + opt.inject[q]] === undefined) define(String(opt.inject[q])); } else addKeys(opt.inject, false); }
                    if (opt.mixins) for (var mx = 0; mx < opt.mixins.length; mx++) fromOptions(opt.mixins[mx], depth + 1);
                    if (opt['extends']) fromOptions(opt['extends'], depth + 1);
                };
                fromOptions(inst.type, 0);
                if (inst.propsOptions) addKeys(inst.propsOptions[0], true);
                addKeys(inst.props, true);
                if (inst.appContext) { addKeys(inst.appContext.config && inst.appContext.config.globalProperties, true); if (inst.appContext.mixins) for (var am = 0; am < inst.appContext.mixins.length; am++) fromOptions(inst.appContext.mixins[am], 1); }
                var pub = ['$', '$el', '$data', '$props', '$attrs', '$slots', '$refs', '$parent', '$root', '$host', '$emit', '$options', '$forceUpdate', '$nextTick', '$watch'];
                for (var pk = 0; pk < pub.length; pk++) if (done['$' + pub[pk]] === undefined) define(pub[pk]);
                // (one watcher per field, for all the instance's proxies: proxy and withProxy)
                var hooks = inst.__br_keyHooks;
                if (!hooks) {
                    hooks = [];
                    try { Object.defineProperty(inst, '__br_keyHooks', { value: hooks }); } catch (e5) { inst.__br_keyHooks = hooks; }
                    var watchField = function (name) {
                        var val = inst[name];
                        try { Object.defineProperty(inst, name, { get: function () { return val; }, set: function (v) { val = v; for (var h = 0; h < hooks.length; h++) hooks[h](v); }, enumerable: true, configurable: true }); } catch (e6) {}
                    };
                    watchField('setupState');
                    watchField('data');
                    watchField('props');
                }
                hooks.push(function (v) { addKeys(v, true); });
                addKeys(inst.setupState, true);
                addKeys(inst.data, true);
                addKeys(inst.props, true);
            }
            // a proxy that only reads and hands what the target lacks to an object the target holds (Twitch's router
            // wrapper, get: (e, t) => t in e ? e[t] : this.router[t]; router.state came back undefined and React Router
            // threw): the names of the objects among the target's values, those the trap answers, read through it. Only
            // for an instance of a class (the wrapper returns the proxy from its constructor): the trap runs for names
            // the page may never read, and a plain object's reading proxy is more often a watcher (Instagram's around its
            // Redux state makes a proxy of each value it reads, and one of undefined threw "Error creating proxy")
            if (readOnly && typeof target === 'object' && !isArr && !coll && proto !== null && proto !== undefined && proto !== Object.prototype) {
                var seenName = {}, asked = 0, own = Object.getOwnPropertyNames(target);
                for (var oi = 0; oi < own.length && asked < 400; oi++) {
                    var inner;
                    try { inner = target[own[oi]]; } catch (e10) { continue; }
                    if (inner === null || typeof inner !== 'object' || inner === target || inner.nodeType || inner.window === inner) continue;
                    for (var io = inner; io && io !== Object.prototype && asked < 400; io = Object.getPrototypeOf(io)) {
                        var names = Object.getOwnPropertyNames(io);
                        for (var ni = 0; ni < names.length && asked < 400; ni++) {
                            var nm = names[ni];
                            if (done['$' + nm] !== undefined || seenName['$' + nm] || nm === 'constructor' || nm.slice(0, 5) === '__br_' || hasOwn.call(target, nm)) continue;
                            seenName['$' + nm] = 1;
                            asked++;
                            var got;
                            try { got = handler.get(target, nm, proxy); } catch (e11) { continue; }
                            if (got !== undefined && !(nm in proxy)) special(nm, false);
                        }
                    }
                }
            }
            // a proxy of an empty object that hands every name to an object its trap reads them from (TikTok's device
            // info: a proxy of {} whose get(e, t) is {let i = p || (p = new c), r = i[t]; ...}), whose names the page reads
            // (K.cF.isHevcTypeSupported() was undefined and the feed page fell over): one read of a name every object
            // answers, from Object.prototype, while it notes where it was read tells that object; its names (and its
            // prototypes') then read through the trap as they are used
            var emptyTarget = false;
            if (readOnly && typeof target === 'object' && !isArr && !coll && proto === Object.prototype) {
                var tks = ownKeys();
                emptyTarget = true;
                for (var tki = 0; tki < tks.length && emptyTarget; tki++) if (String(tks[tki]).slice(0, 5) !== '__br_') emptyTarget = false;
            }
            if (emptyTarget) {
                if (!P.selfProbe) {
                    P.selfProbe = { on: false, seen: undefined };
                    try {
                        Object.defineProperty(Object.prototype, '__br_self', { get: function () {
                            var sp = P.selfProbe;
                            if (!sp.on) return undefined;
                            if (sp.seen === undefined) sp.seen = this;
                            return this;
                        }, configurable: true });
                    } catch (e12) {}
                }
                var sp = P.selfProbe, from;
                if (!sp.on) {
                    sp.on = true; sp.seen = undefined;
                    try { handler.get(target, '__br_self', proxy); } catch (e13) {}
                    from = sp.seen;
                    sp.on = false; sp.seen = undefined;
                }
                if (from !== undefined && from !== null && from !== target && from !== proxy && (typeof from === 'object' || typeof from === 'function')) {
                    for (var fo = from, depth = 0; fo && fo !== Object.prototype && fo !== Function.prototype && depth < 6; fo = Object.getPrototypeOf(fo), depth++) {
                        var fnames = Object.getOwnPropertyNames(fo);
                        for (var fi = 0; fi < fnames.length && fi < 800; fi++) {
                            var fname = fnames[fi];
                            if (fname === 'constructor' || fname.slice(0, 5) === '__br_' || done['$' + fname] !== undefined || hasOwn.call(proxy, fname)) continue;
                            special(fname, false);
                        }
                    }
                }
            }
            var flags = ['__v_skip', '__v_isReactive', '__v_isReadonly', '__v_isShallow', '__v_raw'];
            for (var f = 0; f < flags.length; f++) if (done['$' + flags[f]] === undefined) special(flags[f], false);
            // Immer's state (a registered symbol; the polyfilled ones are keys of their own)
            if (typeof Symbol === 'function' && Symbol['for']) { try { special(Symbol['for']('immer-state'), true); } catch (e3) {} }
            // (and its key where typeof tells no symbol: a script the engine takes as it is keeps its own typeof)
            if (P.rev) special('__$immer_state', true);
            // (the collection methods of a Map / Set target, see coll above)
            if (coll && handler.get) {
                var cm = ['get', 'set', 'has', 'add', 'delete', 'clear', 'forEach', 'size', 'keys', 'values', 'entries', '@@iterator'];
                for (var ci = 0; ci < cm.length; ci++) if (done['$' + cm[ci]] === undefined) define(cm[ci]);
                if (typeof Symbol === 'function' && Symbol.iterator && typeof Symbol.iterator !== 'string') { try { special(Symbol.iterator, false); } catch (e6) {} }
                else if (typeof Symbol === 'function' && typeof Symbol.iterator === 'string' && done['$' + Symbol.iterator] === undefined) define(Symbol.iterator);
            }
            // a factory proxy with a function target (framer-motion's motion.div) answers the names too (an object
            // target whose handler only has get inherits them, see P.factory)
            if (handler.get && !coll && typeof target === 'function') {
                for (var tg = 0; tg < NAMES.length; tg++) if (!(NAMES[tg] in proxy)) define(NAMES[tg]);
            }
            if (isArr) {
                try {
                    Object.defineProperty(proxy, '__br_proxyArray', { value: true });
                    Object.defineProperty(proxy, 'toJSON', { value: function () { return slice.call(proxy); }, configurable: true });
                } catch (e2) {}
                if (!Array.isArray.__brProxy) {
                    var isArray = Array.isArray;
                    Array.isArray = function (x) { return isArray(x) || (x !== null && typeof x === 'object' && x.__br_proxyArray === true); };
                    Array.isArray.__brProxy = true;
                }
                // (concat spreads only real arrays: `draft.list.concat([5])` gave [[1,2,3],5])
                var concat = Array.prototype.concat;
                if (!concat.__brProxy) {
                    var spread = function (x) { return x !== null && typeof x === 'object' && x.__br_proxyArray === true ? slice.call(x) : x; };
                    Array.prototype.concat = function () {
                        var args = slice.call(arguments);
                        for (var i = 0; i < args.length; i++) args[i] = spread(args[i]);
                        return concat.apply(spread(this), args);
                    };
                    Array.prototype.concat.__brProxy = true;
                }
            }
            return proxy;
        },
        // BigInt for scripts that call it without checking first (bigint literals too): an integer Number, exact up to
        // 2^53 (asUintN/asIntN within that); the operators then work on numbers. typeof BigInt stays the engine's.
        __br_BigInt: function (v) {
            if (!__br_BigInt.asUintN) {
                __br_BigInt.asUintN = function (bits, x) { var m = Math.pow(2, Math.min(bits, 53)); x = Number(x) % m; return x < 0 ? x + m : x; };
                __br_BigInt.asIntN = function (bits, x) { var m = Math.pow(2, Math.min(bits, 53)); x = __br_BigInt.asUintN(bits, x); return x >= m / 2 ? x - m : x; };
            }
            var n = v;
            if (typeof v === 'string') {
                var s = v.replace(/^\s+|\s+$/g, ''), neg = s.charAt(0) === '-';
                if (neg || s.charAt(0) === '+') s = s.slice(1);
                n = /^0x/i.test(s) ? parseInt(s.slice(2), 16) : /^0o/i.test(s) ? parseInt(s.slice(2), 8) : /^0b/i.test(s) ? parseInt(s.slice(2), 2) : s === '' ? 0 : /^\d+$/.test(s) ? Number(s) : NaN;
                if (neg) n = -n;
            } else if (typeof v === 'boolean') n = v ? 1 : 0;
            n = Number(n);
            if (isNaN(n) || !isFinite(n) || Math.floor(n) !== n) throw new RangeError('The value ' + v + ' cannot be converted to a BigInt');
            return n;
        },
        __br_new: function (C, a) {
            switch (a.length) {
                case 0: return new C();
                case 1: return new C(a[0]);
                case 2: return new C(a[0], a[1]);
                case 3: return new C(a[0], a[1], a[2]);
                case 4: return new C(a[0], a[1], a[2], a[3]);
            }
            return new (Function.prototype.bind.apply(C, [null].concat(Array.prototype.slice.call(a))))();
        },
        // super(...args) in a derived constructor: the object the constructor continues with
        __br_super: function (self, S, args) {
            if (S === null) return self;
            if (__br_isNative(S)) return __br_nativeSuper(self, S, args);
            var r2 = S.apply(self, args);
            return r2 !== null && (typeof r2 === 'object' || typeof r2 === 'function') ? r2 : self;
        },
        __br_nativeSuper: function (self, S, args) {
            var r = __br_new(S, args), p = Object.getPrototypeOf(self);
            if (p && r !== null && (typeof r === 'object' || typeof r === 'function')) { try { r.__proto__ = p; } catch (e) {} }
            return r;
        },
        // private fields: not enumerable
        __br_defp: function (o, k, v) {
            Object.defineProperty(o, k, { value: v, writable: true, configurable: true });
            return v;
        },
        // regular expressions with named groups: exec results get .groups
        // (the page shim's String.prototype.match/replace use exec for expressions marked __brRe: .groups, $<name>)
        // a literal lowered at build time (the s and u flags gone) keeps the flags it was written with for the page
        // shim's getters (flags, unicode, dotAll): moo's lexer throws unless all its rules agree on /u
        // (a literal is a new expression each time: always extensible, no try needed)
        __br_reFlags: function (re, flags, source) {
            var info = re.__brRe;
            if (info) { info.flags = flags; info.source = source; }
            else Object.defineProperty(re, '__brRe', { value: { flags: flags, source: source }, writable: true, configurable: true });
            return re;
        },
        __br_named: function (re, names) {
            var exec = re.exec;
            re.exec = function (s) {
                var m = exec.call(this, s);
                if (m) { var g = {}; for (var k in names) if (Object.prototype.hasOwnProperty.call(names, k)) g[k] = m[names[k]]; m.groups = g; }
                return m;
            };
            try { Object.defineProperty(re, '__brRe', { value: { names: names } }); } catch (e) {}
            // (String.prototype.match/replace/split look for such expressions from now on, see regexp-shim.js)
            var G = typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : null;
            if (G && G.__brNoteLowered) G.__brNoteLowered();
            return re;
        },
        // import(): the module loader of the page shim, when there is one
        __br_import: function (spec, base) {
            if (typeof window !== 'undefined' && window.__brImport) return window.__brImport(spec, base);
            return Promise.reject(new Error('import() is not supported: ' + spec));
        },
        // the text of a direct eval (the call stays direct, so the code still sees the caller's variables): lowered
        // by the page's transpiler when the engine refuses it
        __br_evalSrc: function (src) {
            if (typeof src !== 'string') return src;
            var G = typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : Function('return this')();
            var F = G.Function.__brNative || G.Function;
            try { F(src); return src; } catch (e) {
                if (!(e instanceof SyntaxError) || !G.__brTranspiler || !G.__brTranspiler()) return src;
                try { var out = G.JSFix.transpile(src, { evalCode: true }); return out === null ? src : out; } catch (e2) { return src; }
            }
        },
        // o.style = v: an element's style takes the text as its declarations (today's style attribute setter); the old
        // engine's style is read-only
        __br_setStyle: function (o, v) {
            if (o && o.nodeType === 1 && o.style && (v === null || typeof v !== 'object')) { o.style.cssText = v == null ? '' : String(v); return v; }
            o.style = v;
            return v;
        },
        // typeof x: a polyfilled symbol is an object in the old engine, and "symbol" today (Lit's noChange, a symbol, was
        // taken for a value to show: "Symbol(lit-noChange)_w.io24za40d" all over reddit)
        __br_typeof: function (o) {
            var t = typeof o;
            return t === 'object' && o !== null && typeof Symbol === 'function' && o.constructor === Symbol && o !== Symbol.prototype ? 'symbol' : t;
        },
        // o.constructor of an element: the old engine answers the element interface's constructor from a table of the
        // wrapper itself, whatever its prototype, so a custom element's class never showed (Lit reads
        // this.constructor.elementStyles, Stencil elm.constructor.style); the class is the first own constructor up the
        // prototype chain that is not the engine's
        __br_ctor: function (o) {
            // (an object the shims made for a class of theirs says so: a constructed CSSStyleSheet)
            if (o !== null && typeof o === 'object' && o.__brCtor) return o.__brCtor;
            if (o === null || o === undefined || typeof o !== 'object' || o.nodeType !== 1) return o.constructor;
            for (var p = Object.getPrototypeOf(o); p; p = Object.getPrototypeOf(p)) {
                if (!Object.prototype.hasOwnProperty.call(p, 'constructor')) continue;
                var c = p.constructor;
                if (typeof c === 'function' && c.prototype === p && !__br_isNative(c)) return c;
                break;
            }
            return o.constructor;
        },
        // o.type = v: a button's type is read-only in the old engine (today it sets the attribute): a TypeError in
        // strict code, and in sloppy code the button stayed a submit button
        __br_setType: function (o, v) {
            if (o && o.nodeType === 1 && /^button$/i.test(o.tagName)) { o.setAttribute('type', v); return v; }
            o.type = v;
            return v;
        },
        // delete el.dataset[key]: the old engine throws in strict code when there is no such attribute (today: true)
        __br_dsdel: function (el, key) {
            try { return delete el.dataset[key]; } catch (e) { return true; }
        },
        // delete o[k] in strict code. The old engine's elements have their DOM attributes (title, id, hidden, disabled,
        // name, value...) as own properties that cannot be deleted, so hasOwnProperty finds them and delete throws: Lit
        // deletes the reactive properties an element has of its own when it starts ("Unable to delete property." on
        // Reddit's components). Today those live on the prototypes and deleting one on an element does nothing: true.
        // (Other objects as they are; the try only for nodes)
        __br_del: function (o, k) {
            if (o !== null && typeof o === 'object' && typeof o.nodeType === 'number') return __br_delNode(o, k);
            return delete o[k];
        },
        __br_delNode: function (o, k) {
            try { return delete o[k]; } catch (e) { return true; }
        },
        // x instanceof C where C has a Symbol.hasInstance of its own: the old engine's instanceof knows only the prototype
        // chain (Zod 4 makes its schemas so that only the method knows them: "expected a Zod schema" on Pinterest). The
        // symbol's key is found once (a polyfilled symbol as a key costs a conversion each time); the one every function
        // inherits (core-js's) is the prototype chain again.
        __br_instanceof: function (x, C) {
            var k = __br_instanceof.k;
            if (k === undefined) {
                var S = typeof Symbol === 'function' ? Symbol : null, hi = S ? S.hasInstance : undefined;
                k = __br_instanceof.k = hi === undefined ? null : typeof hi === 'symbol' ? hi : String(hi);
                __br_instanceof.d = k === null ? undefined : Function.prototype[k];
            }
            if (k !== null && C !== null && (typeof C === 'function' || typeof C === 'object')) {
                var h = C[k];
                if (typeof h === 'function' && h !== __br_instanceof.d) return !!h.call(C, x);
            }
            return x instanceof C;
        },
        // `k in o` where k may be a polyfilled symbol: core-js puts an accessor for every symbol on Object.prototype (so
        // that obj[sym] = v works in an ES5 engine), and `sym in {}` came out true for every object (YouTube's signals
        // then took every owner for a computed and threw "zc"); the symbol's key is looked for below Object.prototype
        __br_in: function (k, o) {
            var S = typeof Symbol === 'function' ? Symbol : null;
            if (S && k !== null && typeof k === 'object' && S.prototype && Object.getPrototypeOf(k) === S.prototype && o !== null && (typeof o === 'object' || typeof o === 'function')) {
                var key = String(k), OP = Object.prototype;
                for (var p = o; p && p !== OP; p = Object.getPrototypeOf(p)) if (OP.hasOwnProperty.call(p, key)) return true;
                return false;
            }
            return k in o;
        },
        // async function expressions: Object.getPrototypeOf(async function () {}).constructor is an AsyncFunction
        // (Alpine compiles its expressions with it) whose functions return promises
        // (fn: a new function expression, whose prototype can always be set)
        __br_asyncFn: function (fn) {
            var G = typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : {};
            fn.__proto__ = G.__br_asyncProto || __br_asyncMake(G);
            return fn;
        },
        __br_asyncMake: function (G) {
            var proto = Object.create(Function.prototype);
            var AsyncFunction = function AsyncFunction() {
                var f = Function.apply(null, arguments);
                var w = function () { try { return Promise.resolve(f.apply(this, arguments)); } catch (e) { return Promise.reject(e); } };
                try { w.__proto__ = proto; } catch (e2) {}
                return w;
            };
            try { Object.defineProperty(proto, 'constructor', { value: AsyncFunction, writable: true, configurable: true }); } catch (e3) { proto.constructor = AsyncFunction; }
            AsyncFunction.prototype = proto;
            G.__br_asyncProto = proto;
            return proto;
        },
        // generators and async functions: the state machines the printer writes run on this (the protocol of
        // facebook/regenerator's runtime: wrap/async/awrap, context prev/next/sent, abrupt/finish/catch/delegateYield)
        __br_regen: function () {
            var G = typeof window !== 'undefined' ? window : {};
            if (G.__br_rtObj) return G.__br_rtObj;
            var hasOwn = Object.prototype.hasOwnProperty, Continue = {};
            var iterSym = typeof Symbol === 'function' && Symbol.iterator ? Symbol.iterator : '@@iterator';
            var Generator = function () {};
            var Gp = Generator.prototype;
            Gp[iterSym] = function () { return this; };
            if (iterSym !== '@@iterator') Gp['@@iterator'] = Gp[iterSym];
            Gp.toString = function () { return '[object Generator]'; };
            var tryCatch = function (fn, obj, arg) { try { return { type: 'normal', arg: fn.call(obj, arg) }; } catch (err) { return { type: 'throw', arg: err }; } };
            var values = function (iterable) {
                if (iterable) {
                    var m = iterable[iterSym] || iterable['@@iterator'];
                    if (m) return m.call(iterable);
                    if (typeof iterable.next === 'function') return iterable;
                    if (!isNaN(iterable.length)) {
                        var i = -1, next = function () { while (++i < iterable.length) { next.value = iterable[i]; next.done = false; return next; } next.value = undefined; next.done = true; return next; };
                        next.next = next;
                        return next;
                    }
                }
                throw new TypeError(iterable + ' is not iterable');
            };
            var resetEntry = function (entry) { var r = entry.completion || {}; r.type = 'normal'; delete r.arg; entry.completion = r; };
            var Context = function (tryLocs) {
                this.tryEntries = [{ tryLoc: 'root' }];
                for (var i = 0; i < tryLocs.length; i++) {
                    var locs = tryLocs[i], e = { tryLoc: locs[0] };
                    if (locs[1] != null) e.catchLoc = locs[1];
                    if (locs[2] != null) { e.finallyLoc = locs[2]; e.afterLoc = locs[3]; }
                    this.tryEntries.push(e);
                }
                this.prev = 0; this.next = 0; this.sent = undefined; this.done = false; this.delegate = null; this.method = 'next'; this.arg = undefined;
                for (var j = 0; j < this.tryEntries.length; j++) resetEntry(this.tryEntries[j]);
            };
            Context.prototype = {
                stop: function () {
                    this.done = true;
                    var root = this.tryEntries[0].completion;
                    if (root.type === 'throw') throw root.arg;
                    return this.rval;
                },
                dispatchException: function (exception) {
                    if (this.done) throw exception;
                    var ctx = this, record;
                    var handle = function (loc, caught) { record.type = 'throw'; record.arg = exception; ctx.next = loc; if (caught) { ctx.method = 'next'; ctx.arg = undefined; } return !!caught; };
                    for (var i = this.tryEntries.length - 1; i >= 0; --i) {
                        var entry = this.tryEntries[i];
                        record = entry.completion;
                        if (entry.tryLoc === 'root') return handle('end');
                        if (entry.tryLoc <= this.prev) {
                            var hasCatch = hasOwn.call(entry, 'catchLoc'), hasFinally = hasOwn.call(entry, 'finallyLoc');
                            if (hasCatch && this.prev < entry.catchLoc) return handle(entry.catchLoc, true);
                            if (hasFinally && this.prev < entry.finallyLoc) return handle(entry.finallyLoc);
                        }
                    }
                },
                abrupt: function (type, arg) {
                    var finallyEntry = null;
                    for (var i = this.tryEntries.length - 1; i >= 0; --i) {
                        var entry = this.tryEntries[i];
                        if (entry.tryLoc <= this.prev && hasOwn.call(entry, 'finallyLoc') && this.prev < entry.finallyLoc) { finallyEntry = entry; break; }
                    }
                    if (finallyEntry && (type === 'break' || type === 'continue') && finallyEntry.tryLoc <= arg && arg <= finallyEntry.finallyLoc) finallyEntry = null;
                    var record = finallyEntry ? finallyEntry.completion : {};
                    record.type = type;
                    record.arg = arg;
                    if (finallyEntry) { this.method = 'next'; this.next = finallyEntry.finallyLoc; return Continue; }
                    return this.complete(record);
                },
                complete: function (record, afterLoc) {
                    if (record.type === 'throw') throw record.arg;
                    if (record.type === 'break' || record.type === 'continue') this.next = record.arg;
                    else if (record.type === 'return') { this.rval = this.arg = record.arg; this.method = 'return'; this.next = 'end'; }
                    else if (record.type === 'normal' && afterLoc) this.next = afterLoc;
                    return Continue;
                },
                finish: function (finallyLoc) {
                    for (var i = this.tryEntries.length - 1; i >= 0; --i) {
                        var entry = this.tryEntries[i];
                        if (entry.finallyLoc === finallyLoc) { this.complete(entry.completion, entry.afterLoc); resetEntry(entry); return Continue; }
                    }
                },
                'catch': function (tryLoc) {
                    for (var i = this.tryEntries.length - 1; i >= 0; --i) {
                        var entry = this.tryEntries[i];
                        if (entry.tryLoc === tryLoc) {
                            var record = entry.completion, thrown;
                            if (record.type === 'throw') { thrown = record.arg; resetEntry(entry); }
                            return thrown;
                        }
                    }
                    throw new Error('illegal catch attempt');
                },
                delegateYield: function (iterable, resultName, nextLoc) {
                    this.delegate = { iterator: values(iterable), resultName: resultName, nextLoc: nextLoc };
                    if (this.method === 'next') this.arg = undefined;
                    return Continue;
                }
            };
            var invokeDelegate = function (delegate, ctx) {
                var method = delegate.iterator[ctx.method];
                if (method === undefined) {
                    ctx.delegate = null;
                    if (ctx.method === 'throw') {
                        if (delegate.iterator['return']) { ctx.method = 'return'; ctx.arg = undefined; invokeDelegate(delegate, ctx); if (ctx.method === 'throw') return Continue; }
                        ctx.method = 'throw';
                        ctx.arg = new TypeError("The iterator does not provide a 'throw' method");
                    }
                    return Continue;
                }
                var record = tryCatch(method, delegate.iterator, ctx.arg);
                if (record.type === 'throw') { ctx.method = 'throw'; ctx.arg = record.arg; ctx.delegate = null; return Continue; }
                var info = record.arg;
                if (!info) { ctx.method = 'throw'; ctx.arg = new TypeError('iterator result is not an object'); ctx.delegate = null; return Continue; }
                if (!info.done) return info;
                ctx[delegate.resultName] = info.value;
                ctx.next = delegate.nextLoc;
                if (ctx.method !== 'return') { ctx.method = 'next'; ctx.arg = undefined; }
                ctx.delegate = null;
                return Continue;
            };
            var wrap = function (innerFn, outerFn, self, tryLocs) {
                var gen = Object.create(Gp), ctx = new Context(tryLocs || []), state = 'start';
                gen._invoke = function (method, arg) {
                    if (state === 'running') throw new Error('Generator is already running');
                    if (state === 'done') { if (method === 'throw') throw arg; return { value: undefined, done: true }; }
                    ctx.method = method;
                    ctx.arg = arg;
                    for (;;) {
                        if (ctx.delegate) {
                            var dr = invokeDelegate(ctx.delegate, ctx);
                            if (dr) { if (dr === Continue) continue; return dr; }
                        }
                        if (ctx.method === 'next') ctx.sent = ctx.arg;
                        else if (ctx.method === 'throw') {
                            if (state === 'start') { state = 'done'; throw ctx.arg; }
                            ctx.dispatchException(ctx.arg);
                        } else if (ctx.method === 'return') ctx.abrupt('return', ctx.arg);
                        state = 'running';
                        var record = tryCatch(innerFn, self, ctx);
                        if (record.type === 'normal') {
                            state = ctx.done ? 'done' : 'yield';
                            if (record.arg === Continue) continue;
                            return { value: record.arg, done: ctx.done };
                        }
                        state = 'done';
                        ctx.method = 'throw';
                        ctx.arg = record.arg;
                    }
                };
                return gen;
            };
            Gp.next = function (arg) { return this._invoke('next', arg); };
            Gp['throw'] = function (arg) { return this._invoke('throw', arg); };
            Gp['return'] = function (arg) { return this._invoke('return', arg); };
            // an async function's or async generator's machine: awaited values ({__await}) resume it, other yields
            // resolve the pending next(); calls are queued
            var asyncIterSym = typeof Symbol === 'function' && Symbol.asyncIterator ? Symbol.asyncIterator : '@@asyncIterator';
            var AsyncIterator = function (gen, P) {
                var invoke = function (method, arg, resolve, reject) {
                    var record = tryCatch(gen[method], gen, arg);
                    if (record.type === 'throw') { reject(record.arg); return; }
                    var result = record.arg, value = result.value;
                    if (value && typeof value === 'object' && hasOwn.call(value, '__await')) {
                        P.resolve(value.__await).then(function (v) { invoke('next', v, resolve, reject); }, function (err) { invoke('throw', err, resolve, reject); });
                        return;
                    }
                    P.resolve(value).then(function (v) { result.value = v; resolve(result); }, function (err) { invoke('throw', err, resolve, reject); });
                };
                var previous = null;
                this._invoke = function (method, arg) {
                    var call = function () { return new P(function (resolve, reject) { invoke(method, arg, resolve, reject); }); };
                    return (previous = previous ? previous.then(call, call) : call());
                };
            };
            AsyncIterator.prototype.next = function (arg) { return this._invoke('next', arg); };
            AsyncIterator.prototype['throw'] = function (arg) { return this._invoke('throw', arg); };
            AsyncIterator.prototype['return'] = function (arg) { return this._invoke('return', arg); };
            AsyncIterator.prototype[asyncIterSym] = function () { return this; };
            if (asyncIterSym !== '@@asyncIterator') AsyncIterator.prototype['@@asyncIterator'] = AsyncIterator.prototype[asyncIterSym];
            var promiseImpl = function () { return G.Promise || (typeof Promise !== 'undefined' ? Promise : null); };
            var rt = {
                wrap: wrap,
                awrap: function (arg) { return { __await: arg }; },
                async: function (innerFn, outerFn, self, tryLocs) {
                    var it = new AsyncIterator(wrap(innerFn, outerFn, self, tryLocs), promiseImpl());
                    return it.next().then(function (r) { return r.done ? r.value : it.next(); });
                },
                // async function*: the async iterator itself
                asyncGen: function (innerFn, outerFn, self, tryLocs) { return new AsyncIterator(wrap(innerFn, outerFn, self, tryLocs), promiseImpl()); },
                // for (k in o) around a yield: the keys when the loop starts, skipping those deleted meanwhile
                keys: function (object) {
                    var keys = [];
                    for (var key in object) keys.push(key);
                    keys.reverse();
                    var next = function () {
                        while (keys.length) { var k = keys.pop(); if (k in object) { next.value = k; next.done = false; return next; } }
                        next.done = true;
                        return next;
                    };
                    return next;
                },
                values: values
            };
            G.__br_rtObj = rt;
            return rt;
        }
    };
    var RUNTIME_DEPS = { __br_spread: ['__br_iter'], __br_arr: ['__br_iter', '__br_spread'], __br_asyncIter: ['__br_iter'], __br_props: ['__br_assignOwn'], __br_class: ['__br_defs'],
                         __br_super: ['__br_isNative', '__br_new', '__br_nativeSuper'], __br_nativeSuper: ['__br_new'], __br_Proxy: ['__br_new'], __br_ctor: ['__br_isNative'],
                         __br_isNative: ['__br_nativeLook'], __br_asyncFn: ['__br_asyncMake'], __br_del: ['__br_delNode'] };

    // ------------------------------------------------------------------------------------------------ small utilities
    var hex4 = function (c) { return ('0000' + c.toString(16)).slice(-4); };
    var LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029), LS_G = new RegExp(LS, 'g'), PS_G = new RegExp(PS, 'g'), LSPS = new RegExp('[' + LS + PS + ']');
    var QUOTE_RE = new RegExp('["\\\\\\u0000-\\u001f\\u007f' + LS + PS + '\\ud800-\\udfff]|<\\/', 'g'), QUOTE_TEST = new RegExp(QUOTE_RE.source);
    var quoteChar = function (c) {
        switch (c) {
            case '"': return '\\"';
            case '\\': return '\\\\';
            case '\n': return '\\n';
            case '\r': return '\\r';
            case '\t': return '\\t';
            case '</': return '<\\/';
        }
        return '\\u' + hex4(c.charCodeAt(0));
    };
    // a double-quoted ES5 string literal (line separators, surrogates and "</" escaped)
    var quote = function (s) {
        s = String(s);
        return '"' + (QUOTE_TEST.test(s) ? s.replace(QUOTE_RE, quoteChar) : s) + '"';
    };
    var IDENT = /^[A-Za-z_$][\w$]*$/;
    var ES5_RESERVED = { 'break': 1, 'case': 1, 'catch': 1, 'continue': 1, 'debugger': 1, 'default': 1, 'delete': 1, 'do': 1, 'else': 1, 'finally': 1, 'for': 1,
        'function': 1, 'if': 1, 'in': 1, 'instanceof': 1, 'new': 1, 'return': 1, 'switch': 1, 'this': 1, 'throw': 1, 'try': 1, 'typeof': 1, 'var': 1,
        'void': 1, 'while': 1, 'with': 1, 'class': 1, 'const': 1, 'enum': 1, 'export': 1, 'extends': 1, 'import': 1, 'super': 1, 'null': 1, 'true': 1, 'false': 1 };
    var Unsupported = function (what) { this.what = what; this.message = 'unsupported: ' + what; };

    // ------------------------------------------------------------------------------------------------ precedence
    var BIN = { '??': 4, '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, '==': 9, '!=': 9, '===': 9, '!==': 9, '<': 10, '>': 10, '<=': 10, '>=': 10,
                'in': 10, 'instanceof': 10, '<<': 11, '>>': 11, '>>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13, '**': 14 };
    var P_SEQ = 1, P_ASSIGN = 2, P_COND = 3, P_UNARY = 15, P_POSTFIX = 16, P_CALL = 18, P_PRIMARY = 20;
    // the precedence of a node printed as it is in the source
    var precOf = function (n, src) {
        switch (n.type) {
            case 'SequenceExpression': return P_SEQ;
            case 'AssignmentExpression': case 'ArrowFunctionExpression': case 'YieldExpression': return P_ASSIGN;
            case 'ConditionalExpression': return P_COND;
            case 'LogicalExpression': case 'BinaryExpression': return BIN[n.operator];
            case 'UnaryExpression': case 'AwaitExpression': return P_UNARY;
            case 'UpdateExpression': return n.prefix ? P_UNARY : P_POSTFIX;
            case 'NewExpression': return src.charAt(n.end - 1) === ')' ? P_CALL : 17;
            case 'CallExpression': case 'MemberExpression': case 'TaggedTemplateExpression': case 'ChainExpression': case 'ImportExpression': return P_CALL;
        }
        return P_PRIMARY;
    };
    // statements that end in a semicolon (added when the source relied on automatic insertion)
    var SEMI_STMT = { ExpressionStatement: 1, VariableDeclaration: 1, ReturnStatement: 1, ThrowStatement: 1, BreakStatement: 1, ContinueStatement: 1,
                      DoWhileStatement: 1, DebuggerStatement: 1 };
    // a statement whose last part ended by automatic semicolon insertion (`for (...) f()` before a newline or "}")
    var endsWithoutSemi = function (src, n) {
        for (;;) {
            if (SEMI_STMT[n.type]) return src.charAt(n.end - 1) !== ';';
            if (n.type === 'IfStatement') n = n.alternate || n.consequent;
            else if (n.type === 'ForStatement' || n.type === 'ForInStatement' || n.type === 'ForOfStatement' || n.type === 'WhileStatement' ||
                     n.type === 'WithStatement' || n.type === 'LabeledStatement') n = n.body;
            else return false;
        }
    };
    var sliceStmt = function (src, n) {
        var code = src.slice(n.start, n.end);
        if (endsWithoutSemi(src, n)) code += ';';
        return code;
    };
    var isLoop = function (n) { return n.type === 'ForStatement' || n.type === 'ForInStatement' || n.type === 'ForOfStatement' || n.type === 'WhileStatement' || n.type === 'DoWhileStatement'; };
    var hasSpread = function (list) { for (var i = 0; i < list.length; i++) if (list[i] && list[i].type === 'SpreadElement') return true; return false; };

    // ------------------------------------------------------------------------------------------------ literals
    var regexNeedsWork = function (r) {
        return /[uysdv]/.test(r.flags) || /\(\?<[=!]|\(\?<[A-Za-z_$]|\\k<|\\[pP]\{|\\u\{/.test(r.pattern);
    };
    // a name the old engine may not read: beyond ASCII, ES2015 names follow ID_Start / ID_Continue of today's Unicode
    // (characters beyond the BMP, symbols like ℘ U+2118, letters added since), the engine the letter categories of 2012
    // (CNN's entity table has {𝒶:"ascr"} and {℘:"wp"}: "Invalid character"); or an escape in it (\u{...}). As a
    // property it is written as a string.
    var NON_ASCII = /[^\x00-\x7f]/;
    var nameDirty = function (id) { return NON_ASCII.test(id.name) || (typeof id.start === 'number' && id.end - id.start !== id.name.length); };
    var dotName = function (id) { return nameDirty(id) ? '[' + quote(id.name) + ']' : '.' + id.name; };
    var literalDirty = function (n) {
        if (n.bigint !== undefined) return true;
        if (n.regex) return regexNeedsWork(n.regex);
        if (typeof n.value === 'number') return /^0[bBoO]|_/.test(n.raw);
        if (typeof n.value === 'string') return n.raw.indexOf('\\u{') >= 0 || LSPS.test(n.raw);
        return false;
    };
    // "." outside character classes matches line terminators too (the s flag)
    var dotAll = function (p) {
        var out = '', inClass = false;
        for (var i = 0; i < p.length; i++) {
            var c = p.charAt(i);
            if (c === '\\') { out += c + p.charAt(i + 1); i++; continue; }
            if (inClass) { if (c === ']') inClass = false; out += c; continue; }
            if (c === '[') { inClass = true; out += c; continue; }
            out += c === '.' ? '[\\s\\S]' : c;
        }
        return out;
    };
    // named groups: the names go, \k<name> becomes a numbered backreference; the numbers are returned for .groups
    var stripNamedGroups = function (p) {
        var names = {}, count = 0, out = '', inClass = false, i, c, e;
        for (i = 0; i < p.length; i++) {
            c = p.charAt(i);
            if (c === '\\') {
                if (!inClass && p.charAt(i + 1) === 'k' && p.charAt(i + 2) === '<') {
                    e = p.indexOf('>', i);
                    if (e > 0 && hasOwn.call(names, p.slice(i + 3, e))) { out += '\\' + names[p.slice(i + 3, e)]; i = e; continue; }
                }
                out += c + p.charAt(i + 1); i++; continue;
            }
            if (inClass) { if (c === ']') inClass = false; out += c; continue; }
            if (c === '[') { inClass = true; out += c; continue; }
            if (c === '(') {
                if (p.charAt(i + 1) !== '?') { count++; out += c; continue; }
                if (p.charAt(i + 2) === '<' && p.charAt(i + 3) !== '=' && p.charAt(i + 3) !== '!') {
                    e = p.indexOf('>', i);
                    count++;
                    names[p.slice(i + 3, e)] = count;
                    out += '(';
                    i = e;
                    continue;
                }
            }
            out += c;
        }
        return { pattern: out, names: names };
    };
    var surrogates = function (cp) {
        cp -= 0x10000;
        return '\\u' + hex4(0xD800 + (cp >> 10)) + '\\u' + hex4(0xDC00 + (cp & 0x3FF));
    };
    // ---- the u flag. Property escapes (\p{...}) come from JSFIX_UNICODE (Resources/js/unicode-props.js, generated at
    // build time by tools/gen-unicode.js); code point sets are written as a BMP class plus surrogate pair alternatives,
    // astral characters and ranges likewise, "." matches a whole surrogate pair. null when the pattern cannot be
    // lowered (then it stays a RegExp constructor call, which fails only when that code runs).
    var GC_ALIAS = { Letter: 'L', Uppercase_Letter: 'Lu', Lowercase_Letter: 'Ll', Titlecase_Letter: 'Lt', Modifier_Letter: 'Lm', Other_Letter: 'Lo',
        Mark: 'M', Combining_Mark: 'M', Nonspacing_Mark: 'Mn', Spacing_Mark: 'Mc', Enclosing_Mark: 'Me', Number: 'N', Decimal_Number: 'Nd', digit: 'Nd',
        Letter_Number: 'Nl', Other_Number: 'No', Punctuation: 'P', punct: 'P', Connector_Punctuation: 'Pc', Dash_Punctuation: 'Pd', Open_Punctuation: 'Ps',
        Close_Punctuation: 'Pe', Initial_Punctuation: 'Pi', Final_Punctuation: 'Pf', Other_Punctuation: 'Po', Symbol: 'S', Math_Symbol: 'Sm',
        Currency_Symbol: 'Sc', Modifier_Symbol: 'Sk', Other_Symbol: 'So', Separator: 'Z', Space_Separator: 'Zs', Line_Separator: 'Zl',
        Paragraph_Separator: 'Zp', Control: 'Cc', cntrl: 'Cc', Format: 'Cf', Private_Use: 'Co', Other: 'C', Unassigned: 'Cn', Surrogate: 'Cs',
        Cased_Letter: 'LC' };
    var BIN_ALIAS = { Alpha: 'Alphabetic', space: 'White_Space', EPres: 'Emoji_Presentation', EMod: 'Emoji_Modifier', EBase: 'Emoji_Modifier_Base',
        EComp: 'Emoji_Component', ExtPict: 'Extended_Pictographic', Upper: 'Uppercase', Lower: 'Lowercase', IDS: 'ID_Start', IDC: 'ID_Continue',
        Dia: 'Diacritic', Ideo: 'Ideographic', RI: 'Regional_Indicator', Pat_Syn: 'Pattern_Syntax', Pat_WS: 'Pattern_White_Space', XIDS: 'XID_Start',
        XIDC: 'XID_Continue', Hex: 'Hex_Digit', AHex: 'ASCII_Hex_Digit', QMark: 'Quotation_Mark', Term: 'Terminal_Punctuation',
        STerm: 'Sentence_Terminal', VS: 'Variation_Selector', DI: 'Default_Ignorable_Code_Point', CI: 'Case_Ignorable', Join_C: 'Join_Control',
        Ext: 'Extender', Gr_Ext: 'Grapheme_Extend', UIdeo: 'Unified_Ideograph' };
    var SCRIPT_ALIAS = { Latn: 'Latin', Grek: 'Greek', Cyrl: 'Cyrillic', Armn: 'Armenian', Hebr: 'Hebrew', Arab: 'Arabic', Deva: 'Devanagari',
        Beng: 'Bengali', Geor: 'Georgian', Hang: 'Hangul', Hira: 'Hiragana', Kana: 'Katakana', Hani: 'Han', Zyyy: 'Common', Zinh: 'Inherited', Qaai: 'Inherited',
        Bopo: 'Bopomofo', Taml: 'Tamil', Telu: 'Telugu', Knda: 'Kannada', Mlym: 'Malayalam', Gujr: 'Gujarati', Guru: 'Gurmukhi', Orya: 'Oriya',
        Sinh: 'Sinhala', Khmr: 'Khmer', Laoo: 'Lao', Mymr: 'Myanmar', Tibt: 'Tibetan', Ethi: 'Ethiopic', Mong: 'Mongolian', Syrc: 'Syriac', Thaa: 'Thaana' };
    var uniCache = {};
    // the code point ranges [start, end, start, end...] of a property, null when unknown
    var uniRanges = function (spec) {
        var key, eq = spec.indexOf('=');
        if (eq >= 0) {
            var k = spec.slice(0, eq), v = spec.slice(eq + 1);
            if (k === 'gc' || k === 'General_Category') key = GC_ALIAS[v] || v;
            else if (k === 'sc' || k === 'Script' || k === 'scx' || k === 'Script_Extensions') key = 'Script=' + (SCRIPT_ALIAS[v] || v);
            else return null;
        } else key = GC_ALIAS[spec] || BIN_ALIAS[spec] || spec;
        if (hasOwn.call(uniCache, key)) return uniCache[key];
        var tables = root.JSFIX_UNICODE, enc = tables && hasOwn.call(tables, key) ? tables[key] : null;
        if (enc === null) return null;
        var out = [], prev = 0, parts = enc ? enc.split(',') : [];
        for (var i = 0; i < parts.length; i++) {
            var dash = parts[i].indexOf('-'), s = prev + parseInt(dash < 0 ? parts[i] : parts[i].slice(0, dash), 36);
            var e = dash < 0 ? s : s + parseInt(parts[i].slice(dash + 1), 36);
            out.push(s, e);
            prev = e;
        }
        uniCache[key] = out;
        return out;
    };
    // the complement of ranges within the BMP (surrogates excluded)
    var bmpComplement = function (r) {
        var out = [], next = 0;
        for (var i = 0; i < r.length && r[i] <= 0xFFFF; i += 2) { if (r[i] > next) out.push(next, r[i] - 1); next = r[i + 1] + 1; }
        if (next <= 0xFFFF) out.push(next, 0xFFFF);
        return out;
    };
    var cpEsc = function (cp) { return '\\u' + hex4(cp); };
    // surrogate pair alternatives for astral ranges [s, e, ...]
    var astralSource = function (r) {
        var alts = [];
        for (var i = 0; i < r.length; i += 2) {
            var s = r[i] - 0x10000, e = r[i + 1] - 0x10000, hs = 0xD800 + (s >> 10), ls = 0xDC00 + (s & 0x3FF), he = 0xD800 + (e >> 10), le = 0xDC00 + (e & 0x3FF);
            if (hs === he) { alts.push(cpEsc(hs) + (ls === le ? cpEsc(ls) : '[' + cpEsc(ls) + '-' + cpEsc(le) + ']')); continue; }
            alts.push(cpEsc(hs) + '[' + cpEsc(ls) + '-\\udfff]');
            if (he - hs > 1) alts.push('[' + cpEsc(hs + 1) + (he - hs > 2 ? '-' + cpEsc(he - 1) : '') + '][\\udc00-\\udfff]');
            alts.push(cpEsc(he) + '[\\udc00-' + cpEsc(le) + ']');
        }
        return alts.join('|');
    };
    // a set of code points as one regular expression atom
    var setAtom = function (bmpItems, astral) {
        var cls = bmpItems.length ? '[' + bmpItems.join('') + ']' : '';
        if (!astral.length) return cls || '[^\\s\\S]';
        return '(?:' + (cls ? cls + '|' : '') + astralSource(astral) + ')';
    };
    var splitRanges = function (r, bmpItems, astral) {
        for (var i = 0; i < r.length; i += 2) {
            var s = r[i], e = r[i + 1];
            if (s <= 0xFFFF) { var be = Math.min(e, 0xFFFF); bmpItems.push(s === be ? cpEsc(s) : cpEsc(s) + '-' + cpEsc(be)); }
            if (e > 0xFFFF) astral.push(Math.max(s, 0x10000), e);
        }
    };
    var SIMPLE_ESC = { n: 10, r: 13, t: 9, v: 11, f: 12, '0': 0 };
    // one escape at p[i] === "\\": {end, cp} for a character, {end, ranges, neg} for \p, {end, raw} for \d \w \s and friends
    var readEscape = function (p, i, inClass) {
        var c = p.charAt(i + 1), m;
        if (c === 'u' && p.charAt(i + 2) === '{') { var e = p.indexOf('}', i); return { end: e + 1, cp: parseInt(p.slice(i + 3, e), 16) }; }
        if (c === 'u' && /^[0-9a-fA-F]{4}$/.test(p.substr(i + 2, 4))) {
            var hi = parseInt(p.substr(i + 2, 4), 16);
            if (hi >= 0xD800 && hi <= 0xDBFF && p.substr(i + 6, 2) === '\\u' && /^[dD][c-fC-F][0-9a-fA-F]{2}$/.test(p.substr(i + 8, 4))) {
                return { end: i + 12, cp: 0x10000 + ((hi - 0xD800) << 10) + (parseInt(p.substr(i + 8, 4), 16) - 0xDC00) };
            }
            return { end: i + 6, cp: hi };
        }
        if ((c === 'p' || c === 'P') && p.charAt(i + 2) === '{') {
            var close = p.indexOf('}', i), r = uniRanges(p.slice(i + 3, close));
            if (!r) return null;
            return { end: close + 1, ranges: r, neg: c === 'P' };
        }
        if (c === 'x' && /^[0-9a-fA-F]{2}$/.test(p.substr(i + 2, 2))) return { end: i + 4, cp: parseInt(p.substr(i + 2, 2), 16) };
        if (c === 'c' && /[A-Za-z]/.test(p.charAt(i + 2))) return { end: i + 3, cp: p.charCodeAt(i + 2) % 32 };
        if (/[dDwWsS]/.test(c) || (!inClass && /[bB1-9k]/.test(c))) {
            if (!inClass && /[1-9]/.test(c)) { m = /^\d+/.exec(p.slice(i + 1)); return { end: i + 1 + m[0].length, raw: '\\' + m[0] }; }
            return { end: i + 2, raw: '\\' + c };
        }
        if (inClass && c === 'b') return { end: i + 2, cp: 8 };
        if (hasOwn.call(SIMPLE_ESC, c)) return { end: i + 2, cp: SIMPLE_ESC[c] };
        return { end: i + 2, cp: p.charCodeAt(i + 1) };   // identity escape (\. \/ \- ...)
    };
    // one character (or escape) at p[i]: as readEscape; a surrogate pair is one code point
    var readAtom = function (p, i, inClass) {
        if (p.charAt(i) === '\\') return readEscape(p, i, inClass);
        var code = p.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF && i + 1 < p.length) {
            var lo = p.charCodeAt(i + 1);
            if (lo >= 0xDC00 && lo <= 0xDFFF) return { end: i + 2, cp: 0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00) };
        }
        return { end: i + 1, cp: code };
    };
    var lowerUnicodeRegex = function (p) {
        var out = '', i = 0, n = p.length, a, items, astral;
        while (i < n) {
            var c = p.charAt(i);
            if (c === '[') {
                var neg = p.charAt(i + 1) === '^', j = i + (neg ? 2 : 1);
                items = []; astral = [];
                while (j < n && p.charAt(j) !== ']') {
                    a = readAtom(p, j, true);
                    if (!a) return null;
                    j = a.end;
                    if (a.cp !== undefined && p.charAt(j) === '-' && j + 1 < n && p.charAt(j + 1) !== ']') {
                        var b = readAtom(p, j + 1, true);
                        if (b && b.cp !== undefined) { splitRanges([a.cp, b.cp], items, astral); j = b.end; continue; }
                    }
                    if (a.cp !== undefined) splitRanges([a.cp, a.cp], items, astral);
                    else if (a.raw) items.push(a.raw);
                    else splitRanges(a.neg ? bmpComplement(a.ranges) : a.ranges, items, astral);
                }
                if (j >= n) return null;
                i = j + 1;
                // (a negated class leaves astral characters out: approximation)
                out += neg ? '[^' + items.join('') + ']' : setAtom(items, astral);
                continue;
            }
            if (c === '\\') {
                a = readEscape(p, i, false);
                if (!a) return null;
                if (a.raw) out += a.raw;
                else if (a.ranges) {
                    items = []; astral = [];
                    if (a.neg) { splitRanges(bmpComplement(a.ranges), items, astral); out += '(?:' + setAtom(items, []) + '|[\\ud800-\\udbff][\\udc00-\\udfff])'; }
                    else { splitRanges(a.ranges, items, astral); out += setAtom(items, astral); }
                } else if (a.cp > 0xFFFF) out += '(?:' + surrogates(a.cp) + ')';
                else out += p.slice(i, a.end).indexOf('\\u{') === 0 ? cpEsc(a.cp) : p.slice(i, a.end);
                i = a.end;
                continue;
            }
            if (c === '.') { out += '(?:[\\ud800-\\udbff][\\udc00-\\udfff]|[^\\n\\r\\u2028\\u2029])'; i++; continue; }
            a = readAtom(p, i, false);
            out += a.cp > 0xFFFF ? '(?:' + p.slice(i, a.end) + ')' : p.slice(i, a.end);
            i = a.end;
        }
        return out;
    };
    // \u{...} in a string literal's source; an escaped backslash is passed over whole, so "\\u{E0020}" (a backslash
    // and text: the source of a u pattern for new RegExp) stays text (it became a surrogate pair, and GSAP's SplitText
    // emoji pattern [\u{E0020}-\u{E007E}] a class with its range out of order)
    var unicodeEscapes = function (raw) {
        return raw.replace(/\\\\|\\u\{([0-9a-fA-F]+)\}/g, function (m, h) { if (!h) return m; var cp = parseInt(h, 16); return cp > 0xFFFF ? surrogates(cp) : '\\u' + hex4(cp); })
                  .replace(LS_G, '\\u2028').replace(PS_G, '\\u2029');
    };

    // ------------------------------------------------------------------------------------------------ scopes
    var LEXICAL = { 'let': 1, 'const': 1, 'class': 1, lexfn: 1, catchpat: 1 };
    // globals a top-level `let`/`const` must not turn into (a `var` there becomes a window property)
    var DANGEROUS_GLOBALS = { top: 1, parent: 1, self: 1, window: 1, location: 1, document: 1, name: 1, status: 1, frames: 1, length: 1, opener: 1,
        closed: 1, history: 1, navigator: 1, screen: 1, origin: 1, event: 1, external: 1, frameElement: 1, performance: 1, localStorage: 1,
        sessionStorage: 1, crypto: 1, caches: 1, console: 1, content: 1, find: 1, scroll: 1, stop: 1, open: 1, close: 1, print: 1, focus: 1, blur: 1 };

    var Scope = function (kind, parent, node, strict, loopNode) {
        this.kind = kind;
        this.parent = parent;
        this.node = node;
        this.strict = strict;
        this.decls = {};
        this.isFn = kind === 'program' || kind === 'function';
        this.fn = this.isFn ? this : parent.fn;
        this.loop = this.isFn ? null : (loopNode || parent.loop);
        if (this.isFn) { this.declCount = {}; this.free = {}; }
    };
    var Binding = function (name, kind, scope) {
        this.name = name;
        this.kind = kind;
        this.scope = scope;
        this.ids = [];
        this.refs = [];
        this.newName = null;
        this.loop = LEXICAL[kind] ? scope.loop : null;
    };
    var markDirty = function (n) { while (n && !n.$d) { n.$d = true; n = n.$p; } };
    // a comma before the closing parenthesis of a list (comments between them too)
    var trailingComma = function (src, from, to) {
        return /,\)/.test(src.slice(from, to).replace(/\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ''));
    };
    var hasUseStrict = function (stmts) {
        for (var i = 0; i < stmts.length && stmts[i].directive !== undefined; i++) if (stmts[i].directive === 'use strict') return true;
        return false;
    };

    // ------------------------------------------------------------------------------------------------ analysis
    var Walker = function (src) {
        this.src = src;
        this.names = {};       // '$' + every variable name in the program (fresh names avoid them)
        this.refs = [];        // [identifier, scope]* in the order met
        this.lexicals = [];
        this.fns = [];         // function-like nodes around the current node (arrows carry $arrow)
        this.loops = [];
        this.module = false;   // import/export met
        this.mod = null;       // module mode: {deps, depIndex, exports, stars}
        this.imports = [];     // import bindings
        this.tla = false;      // await at the top level of a module
        this.proxyShim = false;   // free references to Proxy become __br_Proxy (not the operand of typeof)
        this.bigintShim = false;  // the same for BigInt (and bigint literals call __br_BigInt)
        this.redos = [];          // functions lowered while parsing that must be analysed again (renamed names)
        this.visits = 0;          // nodes walked (the size of the tree a unit held, for stats)
        this.skippedNodes = [];   // functions the parser skipped (islands), met since the last resolve
        this.skippedStmts = [];   // statements it skipped
        this.renamedParams = [];  // parameter bindings renamed (skipped code may use them)
    };
    var W = Walker.prototype;
    W.inArrow = function () { var f = this.fns[this.fns.length - 1]; return !!(f && f.$arrow); };
    // `this` that prints differently: inside arrows (an alias), in field initialisers (the instance or the class) and in
    // derived constructors (the object super() returned)
    W.thisDirty = function () { var f = this.fns[this.fns.length - 1]; return !!(f && (f.$arrow || f.$field || f.$derived)); };
    // `arguments` of an arrow is the outer function's; in a generator or async function the body becomes an inner
    // function (the state machine): both use an alias
    W.argsDirty = function () { var f = this.fns[this.fns.length - 1]; return !!(f && (f.$arrow || f.generator || f.async)); };
    // inside a generator or async function the declarations move to the function around the state machine
    W.inGen = function () { var f = this.fns[this.fns.length - 1]; return !!(f && (f.generator || f.async)); };
    W.declare = function (scope, name, kind, id) {
        var target = (kind === 'var' || kind === 'fn') ? scope.fn : scope, key = '$' + name, b = target.decls[key];
        this.names[key] = 1;
        if (b && b.kind !== 'fnname') { b.ids.push(id); id.$b = b; return b; }
        b = new Binding(name, kind, target);
        target.decls[key] = b;
        var f = target.fn;
        f.declCount[key] = (f.declCount[key] || 0) + 1;
        b.ids.push(id);
        id.$b = b;
        if (LEXICAL[kind]) this.lexicals.push(b);
        return b;
    };
    W.ref = function (id, scope, write) {
        this.refs.push(id, scope);
        this.names['$' + id.name] = 1;
        if (write) id.$w = true;
    };
    W.list = function (list, p, s) {
        var d = false;
        for (var i = 0; i < list.length; i++) if (list[i] && this.v(list[i], p, s)) d = true;
        return d;
    };
    // statements of a block scope (a block, a switch, a catch body): in strict code function declarations are
    // block-scoped (the old engine rejects them there)
    W.stmts = function (list, p, s, nested) {
        var d = false, i, n;
        for (i = 0; i < list.length; i++) {
            n = list[i];
            if (n.type === 'FunctionDeclaration') {
                n.$p = p;
                if (nested && s.strict) { n.$lexfn = true; this.declare(s, n.id.name, 'lexfn', n.id); this.fn(n, p, s); markDirty(n); d = true; }
                else { this.declare(s, n.id.name, 'fn', n.id); if (this.fn(n, p, s)) d = true; }
                continue;
            }
            if (this.v(n, p, s)) d = true;
        }
        return d;
    };
    // a binding pattern: declared names (declKind) or assignment targets (declKind null); defaults and computed keys
    // are expressions
    W.pattern = function (n, p, s, declKind) {
        n.$p = p;
        var d = false, i;
        switch (n.type) {
            case 'Identifier':
                if (declKind) this.declare(s, n.name, declKind, n); else this.ref(n, s, true);
                if (!declKind && n.name === 'arguments' && this.argsDirty()) d = true;
                break;
            case 'MemberExpression':
                return this.v(n, p, s);
            case 'ObjectPattern':
                d = true;
                for (i = 0; i < n.properties.length; i++) {
                    var pr = n.properties[i];
                    pr.$p = n;
                    if (pr.type === 'RestElement') { this.pattern(pr.argument, pr, s, declKind); pr.$d = true; continue; }
                    if (pr.computed) this.v(pr.key, pr, s);
                    this.pattern(pr.value, pr, s, declKind);
                    pr.$d = true;
                }
                break;
            case 'ArrayPattern':
                d = true;
                for (i = 0; i < n.elements.length; i++) if (n.elements[i]) this.pattern(n.elements[i], n, s, declKind);
                break;
            case 'RestElement':
                d = true;
                this.pattern(n.argument, n, s, declKind);
                break;
            case 'AssignmentPattern':
                d = true;
                this.pattern(n.left, n, s, declKind);
                this.v(n.right, n, s);
                break;
            default:
                return this.v(n, p, s);
        }
        if (d) n.$d = true;
        return d;
    };
    W.fn = function (n, p, s) {
        n.$p = p;
        if (n.$raw) return this.rawRefs(n, s);
        var arrow = n.type === 'ArrowFunctionExpression';
        var body = n.body, strict = s.strict || (body.type === 'BlockStatement' && hasUseStrict(body.body));
        var fs = new Scope('function', s, n, strict);
        var d = arrow || n.generator || n.async, i;
        n.$arrow = arrow;
        n.$scope = fs;
        if (n.type === 'FunctionExpression' && n.id) { this.declare(fs, n.id.name, 'fnname', n.id); n.id.$p = n; }
        for (i = 0; i < n.params.length; i++) {
            if (n.params[i].type !== 'Identifier') d = true;
            if (this.pattern(n.params[i], n, fs, 'param')) d = true;
        }
        // trailing comma after the last parameter (ES2017)
        if (n.params.length && trailingComma(this.src, n.params[n.params.length - 1].end, body.start)) d = true;
        // (a parameter named like the function itself: the 2012 engine refuses `function e(e)` in strict code)
        if (n.id && this.avoidNameParam(fs, n.id.name)) d = true;
        this.fns.push(n);
        if (body.type === 'BlockStatement') { body.$p = n; if (this.stmts(body.body, body, fs, false)) { body.$d = true; d = true; } }
        else if (this.v(body, n, fs)) d = true;
        this.fns.pop();
        if (d) n.$d = true;
        return d;
    };
    // the parameter of that name gets another one (P.func prints parameters through bname); true when renamed
    W.avoidNameParam = function (fs, name) {
        var b = fs.decls['$' + name];
        if (!b || b.kind !== 'param' || b.newName) return false;
        var nn, k = 1;
        do { nn = name + '$' + k++; } while (this.names['$' + nn]);
        this.names['$' + nn] = 1;
        b.newName = nn;
        for (var j = 0; j < b.ids.length; j++) markDirty(b.ids[j]);
        this.renamedParams.push(b);
        return true;
    };
    W.cls = function (n, p, s) {
        n.$p = p;
        if (n.$raw) return this.rawRefs(n, s);
        var cs = new Scope('class', s, n, true), i, m;
        // the name inside the class body is its own binding (a declaration's outer binding keeps the id node)
        if (n.id) { this.declare(cs, n.id.name, 'classname', n.type === 'ClassDeclaration' ? { type: 'Identifier', name: n.id.name } : n.id); n.id.$p = n; }
        if (n.superClass) this.v(n.superClass, n, cs);
        var body = n.body.body;
        n.body.$p = n;
        for (i = 0; i < body.length; i++) {
            m = body[i];
            m.$p = n.body;
            if (m.type === 'MethodDefinition') {
                if (m.computed) this.v(m.key, m, cs);
                if (m.kind === 'constructor' && n.superClass) m.value.$derived = true;
                this.fn(m.value, m, cs);
                // (the constructor prints as function <class name>(...))
                if (m.kind === 'constructor' && n.id && m.value.$scope) this.avoidNameParam(m.value.$scope, n.id.name);
            } else if (m.type === 'PropertyDefinition' || m.type === 'StaticBlock') {
                if (m.computed) this.v(m.key, m, cs);
                // initialisers and static blocks run like methods: their own `this` (initialisers print it differently)
                var fs = new Scope('function', cs, m, true), marker = { $arrow: false, $field: m.type === 'PropertyDefinition' };
                this.fns.push(marker);
                if (m.type === 'StaticBlock') this.stmts(m.body, m, fs, false);
                else if (m.value) this.v(m.value, m, fs);
                this.fns.pop();
            }
            m.$d = true;
        }
        n.body.$d = true;
        n.$d = true;
        return true;
    };
    W.loop = function (n, s) {
        var ls = new Scope('block', s, n, s.strict, n);
        n.$scope = ls;
        this.loops.push(n);
        return ls;
    };
    // yield/await inside a loop body: the body cannot become a function
    W.noWrap = function (s) { for (var x = s; x && !x.isFn; x = x.parent) if (x.node && isLoop(x.node)) x.node.$noWrap = true; };
    // a typeof whose answer a polyfilled symbol changes: compared with "symbol" or "object", or used as a value
    var typeofSymbolish = function (n, p) {
        if (/^(Literal|TemplateLiteral|ObjectExpression|ArrayExpression|FunctionExpression|ArrowFunctionExpression|ClassExpression|ThisExpression)$/.test(n.argument.type)) return false;
        if (p && p.type === 'BinaryExpression' && /^[!=]==?$/.test(p.operator)) {
            var other = p.left === n ? p.right : p.left;
            if (other.type === 'Literal' && typeof other.value === 'string') return other.value === 'symbol' || other.value === 'object';
        }
        return true;
    };
    // a read of x.constructor that the helper may answer: not an assignment target, delete operand, method call, `new`
    // or tag callee, nor a link of an optional chain
    var ctorRead = function (n, p) {
        if (!p) return false;
        if (p.type === 'AssignmentExpression' || p.type === 'AssignmentPattern' || p.type === 'ForInStatement' || p.type === 'ForOfStatement') { if (p.left === n) return false; }
        else if (p.type === 'UpdateExpression' || p.type === 'ArrayPattern' || p.type === 'RestElement') return false;
        else if (p.type === 'UnaryExpression' && p.operator === 'delete') return false;
        else if ((p.type === 'CallExpression' || p.type === 'NewExpression') && p.callee === n) return false;
        else if (p.type === 'TaggedTemplateExpression' && p.tag === n) return false;
        else if (p.type === 'Property' && p.value === n && p.$p && p.$p.type === 'ObjectPattern') return false;
        for (var a = p; a; a = a.$p) {
            if (a.type === 'ChainExpression') return false;
            if (a.type !== 'MemberExpression' && a.type !== 'CallExpression') break;
        }
        return true;
    };
    W.v = function (n, p, s) {
        n.$p = p;
        this.visits++;
        var d = false, i, ls;
        switch (n.type) {
            case 'Identifier':
                this.ref(n, s, false);
                if (n.name === 'arguments' && this.argsDirty()) d = true;
                break;
            case 'Literal': d = literalDirty(n); break;
            case 'ThisExpression': d = this.thisDirty(); break;
            case 'Super': case 'MetaProperty': d = true; break;
            case 'ExpressionStatement': d = this.v(n.expression, n, s); break;
            case 'BlockStatement': {
                var bs = new Scope('block', s, n, s.strict);
                d = this.stmts(n.body, n, bs, true);
                break;
            }
            case 'EmptyStatement': case 'DebuggerStatement': break;
            case 'BrRawStatement': n.$scope = s; this.skippedStmts.push(n); break;   // (see islands, W.skippedRefs)
            case 'IfStatement':
                if (this.v(n.test, n, s)) d = true;
                if (this.v(n.consequent, n, s)) d = true;
                if (n.alternate && this.v(n.alternate, n, s)) d = true;
                break;
            case 'LabeledStatement': n.label.$p = n; d = this.v(n.body, n, s); break;
            case 'BreakStatement': case 'ContinueStatement': if (n.label) n.label.$p = n; break;
            case 'WithStatement': if (this.v(n.object, n, s)) d = true; if (this.v(n.body, n, s)) d = true; break;
            case 'ReturnStatement': case 'ThrowStatement': if (n.argument && this.v(n.argument, n, s)) d = true; break;
            case 'SwitchStatement': {
                if (this.v(n.discriminant, n, s)) d = true;
                var ss = new Scope('block', s, n, s.strict);
                for (i = 0; i < n.cases.length; i++) {
                    var c = n.cases[i];
                    c.$p = n;
                    var cd = false;
                    if (c.test && this.v(c.test, c, ss)) cd = true;
                    if (this.stmts(c.consequent, c, ss, true)) cd = true;
                    if (cd) { c.$d = true; d = true; }
                }
                break;
            }
            case 'TryStatement': {
                if (this.v(n.block, n, s)) d = true;
                if (n.handler) {
                    var h = n.handler, cs = new Scope('block', s, h, s.strict), hd = false;
                    h.$p = n;
                    if (!h.param) hd = true;
                    else if (h.param.type === 'Identifier') { this.declare(cs, h.param.name, 'catch', h.param); h.param.$p = h; }
                    else { this.pattern(h.param, h, cs, 'catchpat'); hd = true; }
                    h.body.$p = h;
                    var hbs = new Scope('block', cs, h.body, s.strict);
                    if (this.stmts(h.body.body, h.body, hbs, true)) { h.body.$d = true; hd = true; }
                    if (hd) { h.$d = true; d = true; }
                }
                if (n.finalizer && this.v(n.finalizer, n, s)) d = true;
                break;
            }
            case 'WhileStatement': case 'DoWhileStatement':
                ls = this.loop(n, s);
                if (this.v(n.test, n, ls)) d = true;
                if (this.v(n.body, n, ls)) d = true;
                break;
            case 'ForStatement':
                ls = this.loop(n, s);
                if (n.init && this.v(n.init, n, ls)) d = true;
                if (n.test && this.v(n.test, n, ls)) d = true;
                if (n.update && this.v(n.update, n, ls)) d = true;
                if (this.v(n.body, n, ls)) d = true;
                break;
            case 'ForInStatement': case 'ForOfStatement':
                ls = this.loop(n, s);
                if (n.type === 'ForOfStatement') { d = true; if (n.await) { this.noWrap(ls); if (!this.fns.length) this.tla = true; } }
                if (n.left.type === 'VariableDeclaration') { if (this.v(n.left, n, ls)) d = true; }
                else if (this.pattern(n.left, n, ls, null)) d = true;
                if (this.v(n.right, n, ls)) d = true;
                if (this.v(n.body, n, ls)) d = true;
                break;
            case 'FunctionDeclaration':
                // (declared by the statement list it is in)
                d = this.fn(n, p, s);
                break;
            case 'VariableDeclaration': {
                var kind = n.kind;
                // (in a generator the declarations move out of the state machine; at a module's top level they move
                // from the run function into the factory, where the export getters see them)
                if (kind !== 'var' || this.inGen() || (this.mod && !this.fns.length)) d = true;
                for (i = 0; i < n.declarations.length; i++) {
                    var dc = n.declarations[i];
                    dc.$p = n;
                    var dd = this.pattern(dc.id, dc, s, kind);
                    if (dc.init && this.v(dc.init, dc, s)) dd = true;
                    if (dd) { dc.$d = true; d = true; }
                }
                break;
            }
            case 'ClassDeclaration':
                this.declare(s, n.id.name, 'class', n.id);
                d = this.cls(n, p, s);
                break;
            case 'ClassExpression': d = this.cls(n, p, s); break;
            case 'FunctionExpression': case 'ArrowFunctionExpression': d = this.fn(n, p, s); break;
            case 'ArrayExpression': d = this.list(n.elements, n, s); break;
            case 'ObjectExpression':
                var seenKeys = {};
                for (i = 0; i < n.properties.length; i++) {
                    var pr = n.properties[i], pd = false;
                    pr.$p = n;
                    if (pr.type === 'SpreadElement') { this.v(pr.argument, pr, s); pr.$d = true; d = true; continue; }
                    // a key defined twice is an error in ES5 strict code (and for getters/setters everywhere): from the
                    // first repetition on the properties are defined one by one
                    if (!pr.computed && n.$dupAt === undefined) {
                        var pk = '$' + (pr.key.type === 'Identifier' ? pr.key.name : String(pr.key.value));
                        if (seenKeys[pk] && !(seenKeys[pk] !== 'init' && pr.kind !== 'init' && seenKeys[pk] !== pr.kind)) { n.$dupAt = i; d = true; }
                        seenKeys[pk] = seenKeys[pk] && seenKeys[pk] !== pr.kind ? 'both' : pr.kind;
                    }
                    if (pr.computed) { this.v(pr.key, pr, s); pd = true; }
                    else if (pr.key.type === 'Literal' && literalDirty(pr.key)) pd = true;
                    else if (pr.key.type === 'Identifier' && nameDirty(pr.key)) pd = true;
                    if (pr.method || pr.shorthand) pd = true;
                    if (this.v(pr.value, pr, s)) pd = true;
                    if (pd) { pr.$d = true; d = true; }
                }
                break;
            case 'SpreadElement': this.v(n.argument, n, s); d = true; break;
            case 'TemplateLiteral': this.list(n.expressions, n, s); d = true; break;
            case 'TaggedTemplateExpression': this.v(n.tag, n, s); n.quasi.$p = n; this.list(n.quasi.expressions, n.quasi, s); d = true; break;
            case 'UnaryExpression': case 'UpdateExpression':
                if (n.operator === 'typeof' && (n.argument.type === 'Identifier' || n.argument.type === 'MemberExpression')) n.argument.$typeof = true;   // (typeof Proxy stays the engine's)
                d = this.v(n.argument, n, s);
                // typeof of a polyfilled symbol (see __br_typeof), unless compared with a type it cannot change
                if (n.operator === 'typeof' && typeofSymbolish(n, p)) { n.$typeofSym = true; d = true; }
                // delete el.dataset.x throws in the old engine's strict code when there is no data-x (Next.js does it
                // at start): a helper deletes it
                if (n.operator === 'delete' && n.argument.type === 'MemberExpression' && n.argument.object.type === 'MemberExpression' &&
                    !n.argument.object.computed && n.argument.object.property.name === 'dataset' && n.argument.object.object.type !== 'Super') { n.$dsDelete = true; d = true; }
                // (any other delete of a property in strict code: see __br_del)
                else if (n.operator === 'delete' && s.strict && n.argument.type === 'MemberExpression' && n.argument.object.type !== 'Super' &&
                         n.argument.property.type !== 'PrivateIdentifier') { n.$del = true; d = true; }
                if (n.type === 'UpdateExpression' && n.argument.type === 'Identifier') n.argument.$w = true;
                break;
            case 'BinaryExpression':
                if (n.operator === '**') d = true;
                // `key in obj` with a key that may be a symbol goes through a helper (see __br_in)
                if (n.operator === 'in' && n.left.type !== 'PrivateIdentifier' && !(n.left.type === 'Literal' && (typeof n.left.value === 'string' || typeof n.left.value === 'number'))) { n.$in = true; d = true; }
                // (instanceof asks Symbol.hasInstance, see __br_instanceof)
                if (n.operator === 'instanceof') { n.$inst = true; d = true; }
                if (n.left.type === 'PrivateIdentifier') { d = true; n.left.$p = n; } else if (this.v(n.left, n, s)) d = true;
                if (this.v(n.right, n, s)) d = true;
                break;
            case 'LogicalExpression':
                if (n.operator === '??') d = true;
                if (this.v(n.left, n, s)) d = true;
                if (this.v(n.right, n, s)) d = true;
                break;
            case 'AssignmentExpression':
                if (n.operator === '**=' || n.operator === '||=' || n.operator === '&&=' || n.operator === '??=') d = true;
                if (n.left.type === 'Identifier') { this.ref(n.left, s, true); n.left.$p = n; if (n.left.name === 'arguments' && this.argsDirty()) d = true; }
                else if (this.pattern(n.left, n, s, null)) d = true;
                if (this.v(n.right, n, s)) d = true;
                // el.style = "..." (today it sets the style attribute; the old engine's style is read-only, a TypeError in
                // strict code) and button.type = "..." (read-only there too): through a helper
                if (n.operator === '=' && n.left.type === 'MemberExpression' && !n.left.computed && n.left.object.type !== 'Super' &&
                    (n.left.property.name === 'style' || n.left.property.name === 'type')) { n.$domSet = n.left.property.name; d = true; }
                break;
            case 'ConditionalExpression':
                if (this.v(n.test, n, s)) d = true;
                if (this.v(n.consequent, n, s)) d = true;
                if (this.v(n.alternate, n, s)) d = true;
                break;
            case 'SequenceExpression': d = this.list(n.expressions, n, s); break;
            case 'CallExpression': case 'NewExpression':
                // (a function called where it is written goes in parentheses when printed: see ExpressionStatement in P.S)
                if (WRAPPED_FN[n.callee.type] === 1) n.callee.$wrap = true;
                if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'eval' && !n.optional && n.arguments.length &&
                    n.arguments[0].type !== 'SpreadElement' && this.directEval(n)) d = true;
                if (n.callee.type === 'Super') { d = true; n.callee.$p = n; } else if (this.v(n.callee, n, s)) d = true;
                if (this.list(n.arguments, n, s)) d = true;
                if (n.optional) d = true;
                // trailing comma after the last argument (ES2017)
                if (n.arguments.length && trailingComma(this.src, n.arguments[n.arguments.length - 1].end, n.end)) d = true;
                break;
            case 'MemberExpression':
                if (WRAPPED_FN[n.object.type] === 1) n.object.$wrap = true;
                if (n.object.type === 'Super') { d = true; n.object.$p = n; } else if (this.v(n.object, n, s)) d = true;
                if (n.computed) { if (this.v(n.property, n, s)) d = true; }
                else { n.property.$p = n; if (n.property.type === 'PrivateIdentifier' || nameDirty(n.property)) d = true; }
                if (n.optional) d = true;
                // x.constructor read (a custom element's class, see __br_ctor)
                if (!n.computed && n.property.name === 'constructor' && n.object.type !== 'Super' && ctorRead(n, p)) { n.$ctor = true; d = true; }
                // globalThis.BigInt(...), window.Proxy: the stand-ins as for the bare names (Google Maps' app module
                // starts with globalThis.BigInt(0), a TypeError its module wrapper swallowed: no map), not for typeof
                if (!n.computed && n.object.type === 'Identifier' && GLOBAL_OBJECTS[n.object.name] === 1 && !n.$typeof && !(p && p.type === 'AssignmentExpression' && p.left === n) &&
                    ((n.property.name === 'BigInt' && this.bigintShim) || (n.property.name === 'Proxy' && this.proxyShim))) { n.$standin = n.property.name; d = true; }
                break;
            case 'ChainExpression': this.v(n.expression, n, s); d = true; break;
            case 'AwaitExpression': case 'YieldExpression':
                if (n.argument) this.v(n.argument, n, s);
                this.noWrap(s);
                if (!this.fns.length) this.tla = true;
                d = true;
                break;
            case 'ImportExpression': this.v(n.source, n, s); d = true; break;
            case 'ParenthesizedExpression': d = this.v(n.expression, n, s); break;
            case 'ImportDeclaration': case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration': case 'ExportAllDeclaration':
                this.module = true;
                d = true;
                if (this.mod) this.moduleDecl(n, s);
                break;
            default:
                throw new Unsupported(n.type);
        }
        if (d) n.$d = true;
        return d;
    };
    // ---- ES modules: imports become bindings that print as members of the dependency's namespace (live bindings),
    // exports are recorded for the getters of the module's namespace
    var specName = function (id) { return id.type === 'Identifier' ? id.name : String(id.value); };
    W.dep = function (spec) {
        var m = this.mod;
        if (!hasOwn.call(m.depIndex, '$' + spec)) { m.depIndex['$' + spec] = m.deps.length; m.deps.push(spec); }
        return m.depIndex['$' + spec];
    };
    W.moduleDecl = function (n, s) {
        var m = this.mod, i, sp, b;
        switch (n.type) {
            case 'ImportDeclaration': {
                var dep = this.dep(n.source.value);
                for (i = 0; i < n.specifiers.length; i++) {
                    sp = n.specifiers[i];
                    sp.$p = n;
                    sp.local.$p = sp;
                    b = this.declare(s, sp.local.name, 'import', sp.local);
                    b.imp = { dep: dep, name: sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.type === 'ImportNamespaceSpecifier' ? null : specName(sp.imported) };
                    this.imports.push(b);
                }
                return;
            }
            case 'ExportNamedDeclaration': {
                var decl = n.declaration;
                if (decl) {
                    decl.$p = n;
                    if (decl.type === 'FunctionDeclaration') { this.declare(s, decl.id.name, 'fn', decl.id); this.fn(decl, n, s); m.exports.push({ name: decl.id.name, id: decl.id }); }
                    else {
                        this.v(decl, n, s);
                        if (decl.type === 'ClassDeclaration') m.exports.push({ name: decl.id.name, id: decl.id });
                        else {
                            var ids = [];
                            var collect = function (p) {
                                if (!p) return;
                                if (p.type === 'Identifier') ids.push(p);
                                else if (p.type === 'ObjectPattern') { for (var k = 0; k < p.properties.length; k++) collect(p.properties[k].type === 'RestElement' ? p.properties[k].argument : p.properties[k].value); }
                                else if (p.type === 'ArrayPattern') { for (var j = 0; j < p.elements.length; j++) collect(p.elements[j]); }
                                else if (p.type === 'RestElement') collect(p.argument);
                                else if (p.type === 'AssignmentPattern') collect(p.left);
                            };
                            for (i = 0; i < decl.declarations.length; i++) collect(decl.declarations[i].id);
                            for (i = 0; i < ids.length; i++) m.exports.push({ name: ids[i].name, id: ids[i] });
                        }
                    }
                } else if (n.source) {
                    var dep2 = this.dep(n.source.value);
                    for (i = 0; i < n.specifiers.length; i++) { sp = n.specifiers[i]; m.exports.push({ name: specName(sp.exported), dep: dep2, from: specName(sp.local) }); }
                } else {
                    for (i = 0; i < n.specifiers.length; i++) {
                        sp = n.specifiers[i];
                        sp.$p = n;
                        sp.local.$p = sp;
                        this.ref(sp.local, s, false);
                        m.exports.push({ name: specName(sp.exported), id: sp.local });
                    }
                }
                return;
            }
            case 'ExportDefaultDeclaration': {
                var dd = n.declaration;
                dd.$p = n;
                if (dd.type === 'FunctionDeclaration') { if (dd.id) this.declare(s, dd.id.name, 'fn', dd.id); this.fn(dd, n, s); m.exports.push({ name: 'default', node: n }); }
                else if (dd.type === 'ClassDeclaration') { if (dd.id) this.declare(s, dd.id.name, 'class', dd.id); this.cls(dd, n, s); m.exports.push({ name: 'default', node: n }); }
                else { this.v(dd, n, s); m.exports.push({ name: 'default', node: n }); }
                return;
            }
            case 'ExportAllDeclaration': {
                var dep3 = this.dep(n.source.value);
                if (n.exported) m.exports.push({ name: specName(n.exported), dep: dep3, ns: true });
                else m.stars.push(dep3);
                return;
            }
        }
    };
    // eval(text) of ES2015+ code (feature tests, code built as text): a literal is lowered now, any other argument goes
    // through __br_evalSrc when it runs; either way the call stays a direct eval
    W.directEval = function (n) {
        var a = n.arguments[0];
        if (a.type === 'Literal' && typeof a.value === 'string') {
            if (engineParses(a.value)) return false;
            var out = null;
            try { out = transpile(a.value, { evalCode: true }); } catch (e) { out = null; }
            if (out === null) return false;
            n.$eval = true;
            n.$evalCode = out;
            return true;
        }
        n.$eval = true;
        return true;
    };
    // references to bindings, then the decisions: renames, loops that need a function per iteration. A function
    // lowered while parsing that uses a renamed binding is analysed again from its source (W.rewalk), which adds
    // references and declarations: those are resolved in the next round.
    W.resolve = function () {
        var ri = 0, li = 0, i, j, b;
        if (this.skippedNodes.length || this.skippedStmts.length) this.skippedRefs();
        for (;;) {
            ri = this.resolveRefs(ri);
            li = this.decideRenames(li);
            if (!this.redos.length) break;
            var list = this.redos;
            this.redos = [];
            for (i = 0; i < list.length; i++) this.rewalk(list[i]);
        }
        for (i = 0; i < this.loops.length; i++) {
            var l = this.loops[i];
            if (l.$wrap && !l.$noWrap) { markDirty(l); markWrapped(l.body); }
        }
        // imported names print as members of the dependency's namespace
        for (i = 0; i < this.imports.length; i++) {
            b = this.imports[i];
            for (j = 0; j < b.refs.length; j++) markDirty(b.refs[j]);
        }
    };
    W.resolveRefs = function (from) {
        var refs = this.refs, i, id, s, key, b, f, stop;
        for (i = from; i < refs.length; i += 2) {
            id = refs[i];
            s = refs[i + 1];
            key = '$' + id.name;
            b = null;
            for (var x = s; x; x = x.parent) { b = x.decls[key]; if (b) break; }
            if (id.$impCheck) {
                // (a function lowered while parsing printed this name as its import: it is analysed again when a
                // declaration around it has the same name, e.g. `var e = function () { return e = ..., e(); }` inside
                // a function of a module that imports an `e`; denik.cz)
                if (!b || b.kind !== 'import') this.redo(id.$raw);
            } else if (b) {
                b.refs.push(id);
                id.$b = b;
                // (a binding renamed in an earlier round)
                if (b.newName) { if (id.$rawStmt) throw new Unsupported('island-rename'); if (id.$raw) this.redo(id.$raw); else markDirty(id); }
                // (an imported name prints as a member of its dependency's namespace; a function lowered while
                // parsing before that import took it for a global: analysed again)
                if (b.kind === 'import') { if (id.$rawStmt) throw new Unsupported('island-rename'); if (id.$raw) this.redo(id.$raw); else markDirty(id); }
            }
            else if (id.name === 'Proxy' && this.proxyShim && !id.$typeof) { id.$proxy = true; markDirty(id); }
            else if (id.name === 'BigInt' && this.bigintShim && !id.$typeof) { id.$bigint = true; markDirty(id); }
            // the name is free in every function between the reference and the binding's function
            stop = b ? b.scope.fn : null;
            for (f = s.fn; f && f !== stop; f = f.parent ? f.parent.fn : null) f.free[key] = 1;
            // a closure in a loop capturing a binding of the iteration
            if (b && b.loop && s.fn !== b.scope.fn) { b.loop.$wrap = true; b.captured = true; }
        }
        return refs.length;
    };
    W.decideRenames = function (from) {
        var i, j, b, f, key;
        for (i = from; i < this.lexicals.length; i++) {
            b = this.lexicals[i];
            f = b.scope.fn;
            key = '$' + b.name;
            var need;
            if (b.scope !== f) need = f.declCount[key] > 1 || f.free[key] === 1;
            else need = f.kind === 'program' && !this.mod && hasOwn.call(DANGEROUS_GLOBALS, b.name);   // (a module's top level is not global)
            if (!need) continue;
            var nn, k = 1;
            do { nn = b.name + '$' + k++; } while (this.names['$' + nn]);
            this.names['$' + nn] = 1;
            b.newName = nn;
            for (j = 0; j < b.ids.length; j++) markDirty(b.ids[j]);
            for (j = 0; j < b.refs.length; j++) {
                if (b.refs[j].$rawStmt) throw new Unsupported('island-rename');   // (see W.skippedRefs)
                if (b.refs[j].$raw) this.redo(b.refs[j].$raw); else markDirty(b.refs[j]);
            }
        }
        return this.lexicals.length;
    };
    // a function lowered while parsing whose text cannot stay (a name it uses from outside is renamed): parsed again
    // from the source and analysed in its place, then printed like any other function (P.func)
    W.redo = function (rawRef) {
        var n = rawRef.node;
        if (!n.$raw.redo) { n.$raw.redo = true; this.redos.push(n); }
    };
    W.rewalk = function (n) {
        var raw = n.$raw, acorn = root.acorn;
        // (a parser made at position 0 and moved: one made at n.start counts the lines before it, a copy of the text)
        var p = new acorn.Parser({ ecmaVersion: 'latest', sourceType: this.mod ? 'module' : 'script', allowReturnOutsideFunction: !this.mod, allowReserved: true,
                                   locations: false }, this.src);
        p.pos = p.lastTokEnd = p.lastTokStart = n.start;
        p.strict = raw.strict;
        p.nextToken();
        stats.redos++;
        // (the value of a method, getter or setter starts at its parameters; a function or class alone, without the
        // call after it: `function e(s){...}(x)`; an arrow is a whole assignment expression)
        var fresh = n.type === 'ArrowFunctionExpression' ? p.parseMaybeAssign() :
            n.type === 'FunctionExpression' && this.src.charCodeAt(n.start) === 40 ?
            p.parseMethod(!!n.generator, !!n.async, !!(n.$p && n.$p.type === 'MethodDefinition' && n.$p.kind === 'constructor')) : p.parseExprAtom();
        if (n.type === 'FunctionDeclaration' && fresh.type === 'FunctionExpression') fresh.type = 'FunctionDeclaration';
        if (n.type === 'ClassDeclaration' && fresh.type === 'ClassExpression') fresh.type = 'ClassDeclaration';
        if (fresh.type !== n.type || fresh.start !== n.start || fresh.end !== n.end) throw new Unsupported('early-redo');
        raw.fresh = fresh;
        raw.text = null;
        var fns = this.fns;
        this.fns = [];
        if (isClassNode(fresh)) this.cls(fresh, n.$p, raw.scope); else this.fn(fresh, n.$p, raw.scope);
        this.fns = fns;
        markDirty(n);
    };
    var isClassNode = function (n) { return n.type === 'ClassDeclaration' || n.type === 'ClassExpression'; };
    // a function or class lowered while parsing (see W.early): the names it takes from outside are references from a
    // function of its own (closures in loops, renames); whether it changed decides for the code around it
    W.rawRefs = function (n, s) {
        var raw = n.$raw, rs = new Scope('function', s, n, s.strict), free = raw.free;
        raw.node = n;
        raw.scope = s;
        // (a function the parser skipped: the names it takes are looked for once every declaration is known)
        if (raw.skipped) { raw.rs = rs; this.skippedNodes.push(n); return false; }
        for (var j = 0; j < free.length; j++) this.ref({ type: 'Identifier', name: free[j].name, $raw: raw, $w: free[j].w, $impCheck: free[j].imp, start: n.start, end: n.end }, rs, false);
        if (raw.text === null) return false;
        n.$d = true;
        return true;
    };
    // A function whose body the parser skipped (the engine takes it as it is, see islands): it keeps its text
    W.skipped = function (n, strict) {
        n.$raw = { text: null, free: [], thisAlias: null, argsAlias: null, strict: strict, node: null, scope: null, fresh: null, redo: false, skipped: true, rs: null };
        n.params = [];
        n.body = null;
        n.$scope = null;
    };
    // The names the code the parser skipped takes from the code around it, as references: only names a rename or a loop
    // can concern (block-scoped declarations, renamed parameters) wherever its text has them but after a dot. That is
    // more than it really uses: a rename then has a skipped function parsed and analysed after all (see W.redo). A
    // skipped statement whose text has one is parsed and analysed in its place right away (see W.stmtAgain). Every
    // name this lowering adds has a $ in it, and those of the skipped text are taken beforehand (see lower).
    W.skippedRefs = function () {
        var all = this.skippedNodes.concat(this.skippedStmts), names = [], seen = {}, i, b, x;
        this.skippedNodes = [];
        this.skippedStmts = [];
        // (a let at the top of a function is neither renamed nor made per iteration: only the others count, and only
        // for code inside their functions, which alone can meet them or make their names free there)
        var add = function (b) {
            b.scope.fn.$islandNames = true;
            if (!hasOwn.call(seen, '$' + b.name)) { seen['$' + b.name] = 1; names.push(b.name.replace(/\$/g, '\\$')); }
        };
        for (i = 0; i < this.lexicals.length; i++) {
            b = this.lexicals[i];
            if (b.scope !== b.scope.fn || (b.scope.kind === 'program' && hasOwn.call(DANGEROUS_GLOBALS, b.name))) add(b);
        }
        for (i = 0; i < this.renamedParams.length; i++) add(this.renamedParams[i]);
        if (!names.length) return;
        var re = new RegExp('(^|[^\\w$.])(' + names.join('|') + ')(?![\\w$])', 'g'), m;
        for (i = 0; i < all.length; i++) {
            var n = all[i], raw = n.$raw, near = false;
            for (x = raw ? raw.scope : n.$scope; x && !near; x = x.parent) if (x.$islandNames) near = true;
            if (!near) continue;
            var text = this.src.slice(n.start, n.end), found = {}, count = 0;
            re.lastIndex = 0;
            if (!raw) { if (re.exec(text) !== null) this.stmtAgain(n); continue; }
            while (count < names.length && (m = re.exec(text)) !== null) {
                if (hasOwn.call(found, '$' + m[2])) continue;
                found['$' + m[2]] = 1;
                count++;
                var id = { type: 'Identifier', name: m[2], $w: true, start: n.start, end: n.end, $raw: raw };
                this.ref(id, raw.rs, false);
            }
        }
    };
    // Statements the parser skipped (a run of them up to a semicolon: `try{...}catch(e){...}if(x)return y;`) whose text
    // has a name a rename may concern (minified code: a `let e` in a block, an `e` in half the statements around it):
    // parsed now and analysed in their place, as they were never skipped. Their text stays unless something in them
    // changes (P.S prints them again then). Their var and function declarations count now too.
    W.stmtAgain = function (n) {
        var s = n.$scope, acorn = root.acorn, list = [];
        var p = new acorn.Parser({ ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowReserved: true, locations: false }, this.src);
        p.pos = p.lastTokEnd = p.lastTokStart = n.start;
        p.strict = s.strict;
        p.nextToken();
        while (p.start < n.end && p.type !== acorn.tokTypes.eof) list.push(p.parseStatement(null, false));
        var last = list.length ? list[list.length - 1] : null;
        if (!last || list[0].start !== n.start || last.end !== n.end) throw new Unsupported('island-statement ' + n.start + '-' + n.end + ' parsed ' + (last ? list[0].start + '-' + last.end : 'nothing'));
        stats.stmtAgain++;
        n.$fresh = list;
        // (the functions around them as the walk had them: code the parser skips is never in an arrow's body)
        var fns = this.fns;
        this.fns = s.fn && s.fn.node ? [s.fn.node] : [];
        try { if (this.stmts(list, n, s, false)) markDirty(n); } finally { this.fns = fns; }
    };
    // A function the parser just completed, lowered on its own: analysed below a stand-in for the scopes around it
    // (not parsed completely yet), printed, and emptied. It keeps its text (null: unchanged), the free names with
    // whether it writes them, and the placeholders an arrow used for the outer this/arguments (P.rawFunc).
    W.early = function (n, strict, printer) {
        var saved = [this.refs, this.lexicals, this.loops, this.fns, this.imports, this.redos, this.skippedNodes, this.renamedParams, this.skippedStmts];
        this.refs = []; this.lexicals = []; this.loops = []; this.fns = []; this.imports = []; this.redos = []; this.skippedNodes = []; this.renamedParams = [];
        this.skippedStmts = [];
        // (in a module the stand-in holds the imports parsed so far: they print as namespace members)
        var root = this.earlyRoot || new Scope('program', null, null, strict), i, id, e, v0 = this.visits;
        var raw = { text: null, free: [], thisAlias: null, argsAlias: null, strict: strict, node: null, scope: null, fresh: null, redo: false };
        try {
            if (isClassNode(n)) this.cls(n, null, root); else this.fn(n, null, root);
            if (this.visits - v0 > stats.maxUnit) stats.maxUnit = this.visits - v0;
            this.resolve();
            var seen = {};
            for (i = 0; i < this.refs.length; i += 2) {
                id = this.refs[i];
                // (a name taken for an import of the stand-in is checked in the real scopes too: a function around
                // this one that the parser had not finished may declare the same name, see resolveRefs)
                var imp = !!id.$b && id.$b.kind === 'import' && id.$b.scope === root && root === this.earlyRoot;
                if (id.$b && !imp) continue;
                e = seen[(imp ? '#' : '$') + id.name];
                if (!e) { e = seen[(imp ? '#' : '$') + id.name] = { name: id.name, w: false, imp: imp }; raw.free.push(e); }
                if (id.$w) e.w = true;
            }
            if (n.$d) {
                var out = printer.early(n);
                // (one flat string instead of a rope of every little piece the printer joined: reading a character
                // makes the engine copy the text together, and the pieces become garbage)
                stats.flat = (stats.flat + out.code.charCodeAt(0)) | 0;
                raw.text = out.code;
                raw.thisAlias = out.thisAlias;
                raw.argsAlias = out.argsAlias;
            }
        } finally {
            this.refs = saved[0]; this.lexicals = saved[1]; this.loops = saved[2]; this.fns = saved[3]; this.imports = saved[4]; this.redos = saved[5];
            this.skippedNodes = saved[6]; this.renamedParams = saved[7]; this.skippedStmts = saved[8];
            // (the shared stand-in must not keep the unit's identifiers alive)
            if (this.earlyRoot) for (var k in root.decls) if (hasOwn.call(root.decls, k)) root.decls[k].refs = [];
        }
        n.$raw = raw;
        if (isClassNode(n)) n.superClass = null; else n.params = [];
        n.body = null;
        n.$scope = null;
    };
    // inside a loop body that becomes a function: this/arguments, jumps out, returns and var declarations change
    var markWrapped = function (n) {
        if (!n || typeof n.type !== 'string') return;
        switch (n.type) {
            case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassDeclaration': case 'ClassExpression':
                return;
            case 'ThisExpression': case 'BreakStatement': case 'ContinueStatement': case 'ReturnStatement': case 'MetaProperty': case 'Super':
                markDirty(n);
                if (n.type !== 'ReturnStatement') return;
                break;
            case 'Identifier':
                if (n.name === 'arguments' && !n.$b) markDirty(n);
                return;
            case 'VariableDeclaration':
                if (n.kind === 'var') markDirty(n);
                break;
        }
        for (var k in n) {
            if (k.charAt(0) === '$' || !hasOwn.call(n, k)) continue;
            var v = n[k];
            if (!v || typeof v !== 'object') continue;
            if (Object.prototype.toString.call(v) === '[object Array]') { for (var i = 0; i < v.length; i++) markWrapped(v[i]); }
            else if (typeof v.type === 'string') markWrapped(v);
        }
    };

    // ------------------------------------------------------------------------------------------------ printer
    // one context per output function: temps and the aliases of this/arguments its inner arrows use
    var Ctx = function (kind, parent, node) {
        this.kind = kind;       // program | fn | arrow | method | ctor | dctor | static | loop | gen (a state machine)
        this.parent = parent;
        this.node = node;
        this.temps = [];
        this.tempSet = {};
        this.gen = null;
        var inherits = kind === 'arrow' || kind === 'loop' || kind === 'gen' || kind === 'modrun';
        this.thisCtx = inherits ? parent.thisCtx : this;
        this.thisAlias = null;
        this.argsAlias = null;
        this.ntAlias = null;
        this.jumps = [];
        this.superRef = inherits ? parent.superRef : null;
        this.derivedThis = null;
        this.superCtor = null;
        this.fieldNodes = null;
        this.className = null;
        this.loopInfo = null;
    };
    // (the variables of a state machine live in the function around it: they survive the yields)
    Ctx.prototype.declare = function (name) {
        if (this.kind === 'gen' || this.kind === 'modrun') return this.parent.declare(name);
        if (!this.tempSet['$' + name]) { this.tempSet['$' + name] = 1; this.temps.push(name); }
    };

    var Printer = function (src, walker, opts) {
        this.src = src;
        this.names = walker.names;
        this.bigintShim = walker.bigintShim;
        this.opts = opts || {};
        this.helpers = [];
        this.helperSet = {};
        this.ctx = null;
        this.program = null;
        this.uid = 0;
        this.prec = P_PRIMARY;
        this.privStack = [];
        // top-level names are globals shared with the page's other scripts: a per-script part keeps them apart
        var h = src.length;
        for (var i = 0; i < src.length; i += 97) h = ((h * 31) + src.charCodeAt(i)) | 0;
        this.pfx = (h >>> 0).toString(36).slice(0, 4);
    };
    var P = Printer.prototype;
    P.fresh = function (base) {
        var name;
        do { name = base + '$' + this.pfx + (++this.uid); } while (this.names['$' + name]);
        this.names['$' + name] = 1;
        return name;
    };
    P.temp = function (base) { var n = this.fresh(base || '_t'); this.ctx.declare(n); return n; };
    P.progTemp = function (base) { var n = this.fresh(base); this.program.declare(n); return n; };
    P.h = function (name) {
        if (!this.helperSet[name]) {
            var deps = RUNTIME_DEPS[name] || [];
            for (var i = 0; i < deps.length; i++) this.h(deps[i]);
            this.helperSet[name] = 1;
            this.helpers.push(name);
        }
        return name;
    };
    P.helperCode = function () {
        var out = '';
        for (var i = 0; i < this.helpers.length; i++) {
            var s = String(RUNTIME[this.helpers[i]]);
            out += 'function ' + this.helpers[i] + s.slice(s.indexOf('(')) + '\n';
            if (this.helpers[i] === '__br_BigInt') out += '__br_BigInt(0);\n';   // (its statics exist before a first call)
            if (this.helpers[i] === '__br_Proxy') out += '__br_Proxy();\n';
        }
        return out;
    };
    P.push = function (kind, node) { this.ctx = new Ctx(kind, this.ctx, node); return this.ctx; };
    P.pop = function () { this.ctx = this.ctx.parent; };
    // a var hoisted out of a loop function to the function around it
    P.hoistVar = function (name) { var c = this.ctx; while (c.kind === 'loop' || c.kind === 'gen' || c.kind === 'modrun') c = c.parent; c.declare(name); };
    // declarations that become assignments: `var` inside a loop function, every declaration inside a state machine
    // or the run function of a module (its variables live in the module's factory, where the export getters see them)
    P.hoisting = function (kind) { return (this.ctx.kind === 'loop' && kind === 'var') || this.ctx.kind === 'gen' || this.ctx.kind === 'modrun'; };
    P.declLine = function (c) {
        var parts = [];
        if (c.thisAlias) parts.push(c.thisAlias + '=this');
        if (c.argsAlias) parts.push(c.argsAlias + '=arguments');
        if (c.ntAlias) parts.push(c.ntAlias + '=' + c.ntCode);
        for (var i = 0; i < c.temps.length; i++) parts.push(c.temps[i]);
        return parts.length ? 'var ' + parts.join(',') + ';' : '';
    };
    P.thisCode = function () {
        var c = this.ctx, t = c.thisCtx;
        if (t.kind === 'dctor') return t.derivedThis;
        if (t.kind === 'static') return t.className;
        if (t === c) return 'this';
        if (!t.thisAlias) t.thisAlias = this.fresh('_this');
        return t.thisAlias;
    };
    P.argsCode = function () {
        var c = this.ctx, t = c.thisCtx;
        if (t === c || t.kind === 'program' || t.kind === 'static') return 'arguments';
        if (!t.argsAlias) t.argsAlias = this.fresh('_arguments');
        return t.argsAlias;
    };
    P.bname = function (id) { var b = id.$b; return b && b.newName ? b.newName : id.name; };
    P.privName = function (name) {
        for (var i = this.privStack.length - 1; i >= 0; i--) if (hasOwn.call(this.privStack[i], '$' + name)) return this.privStack[i]['$' + name];
        return '__br$' + name;
    };

    // ---- expressions
    P.E = function (n, min) {
        var code;
        if (n.$d) code = this.X(n);
        else { code = this.src.slice(n.start, n.end); this.prec = precOf(n, this.src); }
        if (this.prec < min || n.$wrap) { code = '(' + code + ')'; this.prec = P_PRIMARY; }
        return code;
    };
    var WRAPPED_FN = { FunctionExpression: 1, ArrowFunctionExpression: 1, ClassExpression: 1 };
    // the node an expression's text starts with (see ExpressionStatement)
    var leftmostNode = function (n) {
        for (var guard = 0; n && guard < 200; guard++) {
            switch (n.type) {
                case 'CallExpression': n = n.callee; break;
                case 'MemberExpression': n = n.object; break;
                case 'TaggedTemplateExpression': n = n.tag; break;
                case 'ChainExpression': n = n.expression; break;
                case 'AssignmentExpression': case 'BinaryExpression': case 'LogicalExpression': n = n.left; break;
                case 'ConditionalExpression': n = n.test; break;
                case 'SequenceExpression': n = n.expressions[0]; break;
                case 'UpdateExpression': if (n.prefix) return null; n = n.argument; break;
                default: return n;
            }
        }
        return null;
    };
    P.X = function (n) {
        var code;
        switch (n.type) {
            case 'Identifier':
                if (n.$b && n.$b.kind === 'import') { code = this.importRef(n.$b); this.prec = n.$b.imp.name === null ? P_PRIMARY : P_CALL; return code; }
                code = n.$b ? (n.$b.newName || n.name) : n.$proxy ? this.h('__br_Proxy') : n.$bigint ? this.h('__br_BigInt') : n.name === 'arguments' ? this.argsCode() : n.name;
                this.prec = P_PRIMARY;
                return code;
            case 'Literal': code = this.literal(n); return code;
            case 'ThisExpression': code = this.thisCode(); this.prec = P_PRIMARY; return code;
            case 'Raw': this.prec = n.prec || P_PRIMARY; return n.code;
            case 'ArrayExpression': return this.array(n);
            case 'ObjectExpression': return this.object(n);
            case 'FunctionExpression': case 'ArrowFunctionExpression':
                code = n.type === 'FunctionExpression' ? this.func(n, 'fn', n.id ? n.id.name : null, null) : this.func(n, 'arrow', null, null);
                if (n.async && !n.generator) { this.prec = P_CALL; return this.h('__br_asyncFn') + '(' + code + ')'; }
                this.prec = P_PRIMARY;
                return code;
            case 'ClassExpression': return this.classExpr(n, null);
            case 'TemplateLiteral': return this.template(n);
            case 'TaggedTemplateExpression': return this.tagged(n);
            case 'SequenceExpression': return this.sequence(n);
            case 'UnaryExpression': return this.unary(n);
            case 'UpdateExpression': return this.update(n);
            case 'BinaryExpression': return this.binary(n);
            case 'LogicalExpression': return this.logical(n);
            case 'AssignmentExpression': return this.assign(n);
            case 'ConditionalExpression':
                code = this.E(n.test, 4) + '?' + this.E(n.consequent, P_ASSIGN) + ':' + this.E(n.alternate, P_ASSIGN);
                this.prec = P_COND;
                return code;
            case 'CallExpression': return this.call(n);
            case 'NewExpression': return this.newExpr(n);
            case 'MemberExpression': return this.member(n);
            case 'ChainExpression': return this.chain(n.expression, null);
            case 'ImportExpression':
                code = this.h('__br_import') + '(' + this.E(n.source, P_ASSIGN) + ',' + quote(this.opts.url || '') + ')';
                this.prec = P_CALL;
                return code;
            case 'MetaProperty': return this.meta(n);
            case 'ParenthesizedExpression': return this.X(n.expression);
            case 'AwaitExpression': throw new Unsupported('await');
            case 'YieldExpression': throw new Unsupported('yield');
        }
        throw new Unsupported(n.type);
    };
    P.literal = function (n) {
        this.prec = P_PRIMARY;
        if (n.bigint !== undefined) { this.prec = P_CALL; return (this.bigintShim ? this.h('__br_BigInt') : 'BigInt') + '(' + quote(n.bigint) + ')'; }
        if (n.regex) return this.regex(n);
        if (typeof n.value === 'number') {
            if (!/^0[bBoO]|_/.test(n.raw)) return n.raw;
            return String(n.value);
        }
        if (typeof n.value === 'string') return unicodeEscapes(n.raw);
        return n.raw;
    };
    P.regex = function (n) {
        var pat = n.regex.pattern, flags = n.regex.flags, names = null;
        if (flags.indexOf('s') >= 0) { pat = dotAll(pat); flags = flags.replace('s', ''); }
        if (/\(\?<[A-Za-z_$]/.test(pat)) { var r = stripNamedGroups(pat); pat = r.pattern; names = r.names; }
        if (flags.indexOf('u') >= 0) { var u = lowerUnicodeRegex(pat); if (u !== null) { pat = u; flags = flags.replace('u', ''); } }
        var code;
        // what the old engine cannot do stays a constructor call: a SyntaxError only when that code runs
        if (/[yvd]/.test(flags) || flags.indexOf('u') >= 0 || /\(\?<[=!]/.test(pat)) { code = 'new RegExp(' + quote(pat) + ',' + quote(flags) + ')'; this.prec = P_CALL; }
        else code = '/' + pat + '/' + flags;
        if (names) {
            var parts = [];
            for (var k in names) if (hasOwn.call(names, k)) parts.push(quote(k) + ':' + names[k]);
            code = this.h('__br_named') + '(' + code + ',{' + parts.join(',') + '})';
            this.prec = P_CALL;
        }
        // (s or u lowered away here: the flags as written, in the order RegExp.prototype.flags gives them)
        var written = n.regex.flags;
        if ((written.indexOf('s') >= 0 && flags.indexOf('s') < 0) || (written.indexOf('u') >= 0 && flags.indexOf('u') < 0)) {
            var sorted = '', ORDER = 'dgimsuvy';
            for (var fi = 0; fi < ORDER.length; fi++) if (written.indexOf(ORDER.charAt(fi)) >= 0) sorted += ORDER.charAt(fi);
            code = this.h('__br_reFlags') + '(' + code + ',' + quote(sorted) + ',' + quote(n.regex.pattern) + ')';
            this.prec = P_CALL;
        }
        return code;
    };
    P.args = function (list) {
        var out = [];
        for (var i = 0; i < list.length; i++) out.push(this.E(list[i], P_ASSIGN));
        return out.join(',');
    };
    // elements with spreads as one array expression: [a].concat(__br_spread(b), [c])
    P.spreadArray = function (els) {
        var parts = [], cur = [], i, e;
        for (i = 0; i < els.length; i++) {
            e = els[i];
            if (e && e.type === 'SpreadElement') {
                if (cur.length) { parts.push('[' + cur.join(',') + ']'); cur = []; }
                parts.push(this.h('__br_spread') + '(' + this.E(e.argument, P_ASSIGN) + ')');
            } else cur.push(e ? this.E(e, P_ASSIGN) : 'void 0');
        }
        if (cur.length) parts.push('[' + cur.join(',') + ']');
        if (!parts.length) return '[]';
        if (parts.length === 1) return parts[0];
        return parts[0] + '.concat(' + parts.slice(1).join(',') + ')';
    };
    P.array = function (n) {
        var code;
        if (hasSpread(n.elements)) { code = this.spreadArray(n.elements); this.prec = P_CALL; return code; }
        var out = [];
        for (var i = 0; i < n.elements.length; i++) out.push(n.elements[i] ? this.E(n.elements[i], P_ASSIGN) : '');
        // a hole at the end needs its own comma: [a,,] has length 2
        code = '[' + out.join(',') + (n.elements.length && !n.elements[n.elements.length - 1] ? ',' : '') + ']';
        this.prec = P_PRIMARY;
        return code;
    };
    P.propKey = function (pr) {
        var k = pr.key;
        if (k.type === 'Identifier') return nameDirty(k) ? quote(k.name) : k.name;
        if (k.type === 'Literal') return literalDirty(k) ? quote(String(k.value)) : k.raw;
        return this.E(k, P_ASSIGN);
    };
    P.object = function (n) {
        var head = [], tail = [], dyn = false, i, pr, code;
        for (i = 0; i < n.properties.length; i++) {
            pr = n.properties[i];
            if (pr.type === 'SpreadElement') { dyn = true; tail.push('null', this.E(pr.argument, P_ASSIGN), '3'); continue; }
            if (pr.computed || (n.$dupAt !== undefined && i >= n.$dupAt)) dyn = true;
            var kind = pr.kind === 'get' ? 1 : pr.kind === 'set' ? 2 : 0;
            if (!dyn) {
                if (!pr.$d) { head.push(this.src.slice(pr.start, pr.end)); continue; }
                var key = this.propKey(pr);
                if (kind) head.push((kind === 1 ? 'get ' : 'set ') + key + this.func(pr.value, 'method', null, { accessor: true, superRef: 'Object.getPrototypeOf(this)' }));
                else if (pr.method) head.push(key + ':' + this.func(pr.value, 'method', null, { superRef: 'Object.getPrototypeOf(this)' }));
                else head.push(key + ':' + this.E(pr.value, P_ASSIGN));
                continue;
            }
            var k2 = pr.computed ? this.E(pr.key, P_ASSIGN) : pr.key.type === 'Identifier' ? quote(pr.key.name) : quote(String(pr.key.value));
            var val = kind || pr.method ? this.func(pr.value, 'method', null, { superRef: 'Object.getPrototypeOf(this)' }) : this.E(pr.value, P_ASSIGN);
            tail.push(k2, val, String(kind));
        }
        code = '{' + head.join(',') + '}';
        if (!tail.length) { this.prec = P_PRIMARY; return code; }
        this.prec = P_CALL;
        return this.h('__br_props') + '(' + code + ',[' + tail.join(',') + '])';
    };
    P.template = function (n) {
        var q = n.quasis, e = n.expressions, i;
        if (!e.length) { this.prec = P_PRIMARY; return quote(q[0].value.cooked); }
        var args = [];
        for (i = 0; i < e.length; i++) {
            args.push(this.E(e[i], P_ASSIGN));
            if (q[i + 1].value.cooked) args.push(quote(q[i + 1].value.cooked));
        }
        this.prec = P_CALL;
        return quote(q[0].value.cooked) + '.concat(' + args.join(',') + ')';
    };
    P.tagged = function (n) {
        var q = n.quasi.quasis, cooked = [], raw = [], i;
        for (i = 0; i < q.length; i++) {
            cooked.push(q[i].value.cooked === null || q[i].value.cooked === undefined ? 'void 0' : quote(q[i].value.cooked));
            raw.push(quote(q[i].value.raw));
        }
        var cache = this.progTemp('_tpl');
        var args = [cache + '||(' + cache + '=' + this.h('__br_tpl') + '([' + cooked.join(',') + '],[' + raw.join(',') + ']))'];
        for (i = 0; i < n.quasi.expressions.length; i++) args.push(this.E(n.quasi.expressions[i], P_ASSIGN));
        var tag = this.E(n.tag, P_CALL);
        this.prec = P_CALL;
        return tag + '(' + args.join(',') + ')';
    };
    P.sequence = function (n) {
        var out = [];
        for (var i = 0; i < n.expressions.length; i++) out.push(this.E(n.expressions[i], P_ASSIGN));
        this.prec = P_SEQ;
        return out.join(',');
    };
    P.unary = function (n) {
        var op = n.operator;
        if (op === 'delete' && n.argument.type === 'ChainExpression') return this.chain(n.argument.expression, 'delete');
        if (op === 'delete' && n.$dsDelete) {
            var target = n.argument, key = target.computed ? this.E(target.property, P_ASSIGN) : quote(target.property.name);
            var dsCode = this.h('__br_dsdel') + '(' + this.E(target.object.object, P_ASSIGN) + ',' + key + ')';
            this.prec = P_CALL;
            return dsCode;
        }
        if (op === 'delete' && n.$del) {
            var dt = n.argument, dk = dt.computed ? this.E(dt.property, P_ASSIGN) : quote(dt.property.name);
            var delCode = this.h('__br_del') + '(' + this.E(dt.object, P_ASSIGN) + ',' + dk + ')';
            this.prec = P_CALL;
            return delCode;
        }
        if (op === 'typeof' && n.$typeofSym) {
            var tcode;
            // (a bare name may be undeclared: typeof alone answers "undefined" for it without throwing)
            if (n.argument.type === 'Identifier') {
                var id = this.E(n.argument, P_UNARY);
                tcode = '(typeof ' + id + '==="undefined"?"undefined":' + this.h('__br_typeof') + '(' + id + '))';
                this.prec = P_PRIMARY;
            } else {
                tcode = this.h('__br_typeof') + '(' + this.E(n.argument, P_ASSIGN) + ')';
                this.prec = P_CALL;
            }
            return tcode;
        }
        var arg = this.E(n.argument, P_UNARY), code;
        if (/^[a-z]/.test(op)) code = op + ' ' + arg;
        else code = op + ((op === '-' || op === '+') && arg.charAt(0) === op ? ' ' : '') + arg;
        this.prec = P_UNARY;
        return code;
    };
    P.update = function (n) {
        var arg = this.E(n.argument, P_POSTFIX), code = n.prefix ? n.operator + arg : arg + n.operator;
        this.prec = n.prefix ? P_UNARY : P_POSTFIX;
        return code;
    };
    P.binary = function (n) {
        var op = n.operator, p = BIN[op], code;
        if (op === '**') { code = 'Math.pow(' + this.E(n.left, P_ASSIGN) + ',' + this.E(n.right, P_ASSIGN) + ')'; this.prec = P_CALL; return code; }
        if (n.left.type === 'PrivateIdentifier') { code = quote(this.privName(n.left.name)) + ' in ' + this.E(n.right, 11); this.prec = 10; return code; }
        if (n.$in) { code = this.h('__br_in') + '(' + this.E(n.left, P_ASSIGN) + ',' + this.E(n.right, P_ASSIGN) + ')'; this.prec = P_CALL; return code; }
        if (n.$inst) { code = this.h('__br_instanceof') + '(' + this.E(n.left, P_ASSIGN) + ',' + this.E(n.right, P_ASSIGN) + ')'; this.prec = P_CALL; return code; }
        code = this.E(n.left, p) + ' ' + op + ' ' + this.E(n.right, p + 1);
        this.prec = p;
        return code;
    };
    var isIdentCode = function (c) { return IDENT.test(c) && c !== 'arguments'; };
    P.logical = function (n) {
        var op = n.operator, code;
        if (op === '??') {
            var l = this.E(n.left, P_ASSIGN), r = this.E(n.right, P_ASSIGN);
            if (isIdentCode(l)) code = l + ' != null?' + l + ':' + r;
            else { var t = this.temp(); code = '(' + t + '=' + l + ') != null?' + t + ':' + r; }
            this.prec = P_COND;
            return code;
        }
        var p = BIN[op];
        code = this.E(n.left, p) + op + this.E(n.right, p + 1);
        this.prec = p;
        return code;
    };
    // a member expression's tail: .name, [expr], .<private>
    P.tail = function (n) {
        if (n.computed) return '[' + this.E(n.property, P_SEQ) + ']';
        if (n.property.type === 'PrivateIdentifier') return '.' + this.privName(n.property.name);
        return dotName(n.property);
    };
    P.member = function (n) {
        var code;
        if (n.$standin) { this.prec = P_PRIMARY; return this.h(n.$standin === 'BigInt' ? '__br_BigInt' : '__br_Proxy'); }
        if (n.$ctor) {
            code = this.h('__br_ctor') + '(' + this.E(n.object, P_ASSIGN) + ')';
            this.prec = P_CALL;
            return code;
        }
        if (n.object.type === 'Super') code = this.ctxSuper() + this.tail(n);
        else {
            var obj = this.E(n.object, P_CALL);
            if (n.object.type === 'Literal' && typeof n.object.value === 'number' && /^\d+$/.test(obj)) obj = '(' + obj + ')';
            code = obj + this.tail(n);
        }
        this.prec = P_CALL;
        return code;
    };
    P.ctxSuper = function () {
        var r = this.ctx.superRef;
        if (!r) throw new Unsupported('super outside a class');
        return r;
    };
    // an assignment target used twice (compound logical/exponent assignment): the first use evaluates the parts
    P.refParts = function (left) {
        if (left.type === 'Identifier') { var c = this.E(left, P_CALL); return { first: c, later: c }; }
        var obj = left.object.type === 'Super' ? this.ctxSuper() : this.E(left.object, P_CALL), objFirst = obj, objLater = obj;
        if (left.object.type !== 'Super' && !isIdentCode(obj) && obj !== 'this') { var t = this.temp(); objFirst = '(' + t + '=' + obj + ')'; objLater = t; }
        var keyFirst, keyLater;
        if (left.computed) {
            var k = this.E(left.property, P_SEQ);
            if (left.property.type === 'Literal' || isIdentCode(k)) keyFirst = keyLater = '[' + k + ']';
            else { var kt = this.temp(); keyFirst = '[' + kt + '=' + k + ']'; keyLater = '[' + kt + ']'; }
        } else keyFirst = keyLater = this.tail(left);
        return { first: objFirst + keyFirst, later: objLater + keyLater };
    };
    P.assign = function (n) {
        var op = n.operator, left = n.left, code;
        if (n.$domSet) {
            code = this.h(n.$domSet === 'type' ? '__br_setType' : '__br_setStyle') + '(' + this.E(left.object, P_ASSIGN) + ',' + this.E(n.right, P_ASSIGN) + ')';
            this.prec = P_CALL;
            return code;
        }
        if (left.type === 'ObjectPattern' || left.type === 'ArrayPattern') {
            var out = [], t = this.temp();
            out.push(t + '=' + this.E(n.right, P_ASSIGN));
            this.destructure(left, t, out, 'assign');
            out.push(t);
            this.prec = P_SEQ;
            return out.join(',');
        }
        if (op === '||=' || op === '&&=' || op === '??=') {
            var r = this.refParts(left), val = this.E(n.right, P_ASSIGN);
            if (op === '??=') { var v = this.temp(); code = '(' + v + '=' + r.first + ') != null?' + v + ':' + r.later + '=' + val; this.prec = P_COND; }
            else { code = r.first + (op === '||=' ? '||' : '&&') + '(' + r.later + '=' + val + ')'; this.prec = op === '||=' ? 4 : 5; }
            return code;
        }
        if (op === '**=') {
            var r2 = this.refParts(left);
            code = r2.first + '=Math.pow(' + r2.later + ',' + this.E(n.right, P_ASSIGN) + ')';
            this.prec = P_ASSIGN;
            return code;
        }
        code = this.E(left, P_CALL) + op + this.E(n.right, P_ASSIGN);
        this.prec = P_ASSIGN;
        return code;
    };
    // a callee that `new` can take without parentheses (no call inside)
    var simpleNewCallee = function (n) {
        while (n.type === 'MemberExpression' && !n.optional) n = n.object;
        return n.type === 'Identifier' || n.type === 'ThisExpression';
    };
    P.newExpr = function (n) {
        var code;
        if (hasSpread(n.arguments)) code = this.h('__br_new') + '(' + this.E(n.callee, P_ASSIGN) + ',' + this.spreadArray(n.arguments) + ')';
        else {
            var callee = this.E(n.callee, P_CALL);
            if (!simpleNewCallee(n.callee)) callee = '(' + callee + ')';
            code = 'new ' + callee + '(' + this.args(n.arguments) + ')';
        }
        this.prec = P_CALL;
        return code;
    };
    P.call = function (n) {
        var callee = n.callee, code;
        if (callee.type === 'Super') return this.superCall(n);
        if (n.optional) return this.chain(n, null);
        if (callee.type === 'MemberExpression' && callee.object.type === 'Super') {
            var fn = this.ctxSuper() + this.tail(callee), self = this.thisCode();
            code = hasSpread(n.arguments) ? fn + '.apply(' + self + ',' + this.spreadArray(n.arguments) + ')'
                                          : fn + '.call(' + self + (n.arguments.length ? ',' + this.args(n.arguments) : '') + ')';
            this.prec = P_CALL;
            return code;
        }
        if (hasSpread(n.arguments)) {
            var arr;
            if (callee.type === 'MemberExpression' && !callee.optional) {
                var obj = this.E(callee.object, P_CALL), thisVal = obj;
                if (!isIdentCode(obj) && obj !== 'this') { thisVal = this.temp(); obj = '(' + thisVal + '=' + obj + ')'; }
                var fcode = obj + this.tail(callee);
                arr = this.spreadArray(n.arguments);
                code = fcode + '.apply(' + thisVal + ',' + arr + ')';
            } else {
                var f = this.E(callee, P_CALL);
                arr = this.spreadArray(n.arguments);
                code = f + '.apply(void 0,' + arr + ')';
            }
            this.prec = P_CALL;
            return code;
        }
        if (n.$eval && callee.type === 'Identifier' && !callee.$b) {
            // (a local binding named eval is not the engine's eval)
            var rest = n.arguments.slice(1);
            code = 'eval(' + (n.$evalCode !== undefined ? quote(n.$evalCode) : this.h('__br_evalSrc') + '(' + this.E(n.arguments[0], P_ASSIGN) + ')') +
                   (rest.length ? ',' + this.args(rest) : '') + ')';
            this.prec = P_CALL;
            return code;
        }
        code = this.E(callee, P_CALL);
        // an imported function is called without the namespace as its `this`
        if (callee.type === 'Identifier' && callee.$b && callee.$b.kind === 'import' && callee.$b.imp.name !== null) code = '(0,' + code + ')';
        code += '(' + this.args(n.arguments) + ')';
        this.prec = P_CALL;
        return code;
    };
    // a reference to an imported binding: a member of the dependency's namespace (so it stays live)
    // the variables of a module's dependency namespaces and of import.meta, named when first needed (functions lowered
    // while parsing print before moduleCode)
    P.modVar = function (dep) {
        if (!this.modVars) this.modVars = [];
        return this.modVars[dep] || (this.modVars[dep] = this.fresh('_m'));
    };
    P.metaVar = function () { return this.metaName || (this.metaName = this.fresh('_meta')); };
    P.importRef = function (b) {
        var ns = this.modVar(b.imp.dep), name = b.imp.name;
        if (name === null) return ns;
        return ns + (IDENT.test(name) ? '.' + name : '[' + quote(name) + ']');
    };
    // optional chains: every "?." tests what is left of it once, the whole chain gives undefined when one is nullish
    P.chain = function (node, mode, baseCode) {
        var links = [], n = node, i, l;
        while (n.type === 'MemberExpression' || n.type === 'CallExpression') { links.unshift(n); n = n.type === 'MemberExpression' ? n.object : n.callee; }
        var cur = baseCode !== undefined ? baseCode : n.type === 'Super' ? this.ctxSuper() : this.E(n, P_CALL), conds = [], thisForCall = null;
        for (i = 0; i < links.length; i++) {
            l = links[i];
            if (l.optional) {
                if (isIdentCode(cur) || cur === 'this') conds.push(cur + '==null');
                else { var t = this.temp(); conds.push('(' + t + '=' + cur + ')==null'); cur = t; }
            }
            if (l.type === 'MemberExpression') {
                var nx = links[i + 1];
                if (nx && nx.type === 'CallExpression' && (nx.optional || hasSpread(nx.arguments))) {
                    // a method called with ?.() or with spread arguments (.apply): the object is its `this`
                    if (!isIdentCode(cur) && cur !== 'this') { var ot = this.temp(); cur = '(' + ot + '=' + cur + ')'; thisForCall = ot; }
                    else thisForCall = cur;
                } else thisForCall = null;
                cur = cur + this.tail(l);
            } else {
                var spread = hasSpread(l.arguments);
                if ((l.optional || spread) && thisForCall !== null) cur = cur + (spread ? '.apply(' + thisForCall + ',' + this.spreadArray(l.arguments) + ')' : '.call(' + thisForCall + (l.arguments.length ? ',' + this.args(l.arguments) : '') + ')');
                else if (spread) cur = cur + '.apply(void 0,' + this.spreadArray(l.arguments) + ')';
                else cur = cur + '(' + this.args(l.arguments) + ')';
                thisForCall = null;
            }
        }
        if (mode === 'delete') { this.prec = conds.length ? P_COND : P_UNARY; return conds.length ? conds.join('||') + '?true:delete ' + cur : 'delete ' + cur; }
        if (!conds.length) { this.prec = P_CALL; return cur; }
        this.prec = P_COND;
        return conds.join('||') + '?void 0:' + cur;
    };
    P.meta = function (n) {
        if (n.meta.name === 'new') {
            var t = this.ctx.thisCtx;
            if (t.kind === 'method' || t.kind === 'static' || t.kind === 'program') { this.prec = P_UNARY; return 'void 0'; }
            if (!t.ntAlias) t.ntAlias = this.fresh('_newTarget');
            this.prec = P_PRIMARY;
            return t.ntAlias;
        }
        if (this.opts.module) { this.prec = P_PRIMARY; return this.metaVar(); }
        throw new Unsupported('import.meta');
    };

    // ---- destructuring: 'target=value' strings into out; mode decl (declared names), hoist (names declared in the
    // function around a loop function), assign (any assignment target)
    P.destructure = function (p, value, out, mode) {
        var i, t, el;
        switch (p.type) {
            case 'Identifier': {
                var name = mode === 'assign' ? this.E(p, P_CALL) : this.bname(p);
                if (mode === 'hoist') this.hoistVar(name);
                out.push(name + '=' + value);
                return;
            }
            case 'MemberExpression':
                out.push(this.member(p) + '=' + value);
                return;
            case 'AssignmentPattern':
                t = this.temp();
                this.destructure(p.left, '(' + t + '=' + value + ')===void 0?' + this.E(p.right, P_ASSIGN) + ':' + t, out, mode);
                return;
            case 'ObjectPattern': {
                var props = p.properties, src = value, rest = props.length && props[props.length - 1].type === 'RestElement', keys = [];
                if (!(props.length === 1 && !rest && isIdentCode(value))) { t = this.temp(); out.push(t + '=' + value); src = t; }
                for (i = 0; i < props.length; i++) {
                    var pr = props[i], access;
                    if (pr.type === 'RestElement') { this.destructure(pr.argument, this.h('__br_objRest') + '(' + src + ',[' + keys.join(',') + '])', out, mode); continue; }
                    if (pr.computed) {
                        var kc = this.E(pr.key, P_ASSIGN);
                        if (rest && !isIdentCode(kc) && pr.key.type !== 'Literal') { var kt = this.temp(); out.push(kt + '=' + kc); kc = kt; }
                        access = src + '[' + kc + ']';
                        keys.push(kc);
                    } else if (pr.key.type === 'Identifier') { access = src + dotName(pr.key); keys.push(quote(pr.key.name)); }
                    else { access = src + '[' + quote(String(pr.key.value)) + ']'; keys.push(quote(String(pr.key.value))); }
                    this.destructure(pr.value, access, out, mode);
                }
                return;
            }
            case 'ArrayPattern': {
                var els = p.elements, hasRest = els.length && els[els.length - 1] && els[els.length - 1].type === 'RestElement';
                t = this.temp();
                out.push(t + '=' + this.h('__br_arr') + '(' + value + ',' + (hasRest ? -1 : els.length) + ')');
                for (i = 0; i < els.length; i++) {
                    el = els[i];
                    if (!el) continue;
                    if (el.type === 'RestElement') this.destructure(el.argument, t + '.slice(' + i + ')', out, mode);
                    else this.destructure(el, t + '[' + i + ']', out, mode);
                }
                return;
            }
        }
        throw new Unsupported('pattern ' + p.type);
    };

    // ---- functions
    // the function's length: the parameters before the first default or rest one (destructured ones count). Lowered
    // parameters are read from arguments, so the rest up to there get placeholder names: Vue gives setup() its
    // context only when setup.length > 1, and setup(props, { emit }) had come out with length 1 (kosik.cz)
    var arityOf = function (n) {
        for (var i = 0; i < n.params.length; i++) if (n.params[i].type === 'AssignmentPattern' || n.params[i].type === 'RestElement') return i;
        return n.params.length;
    };
    P.param = function (p, i) {
        var arg = 'arguments[' + i + ']', val;
        if (p.type === 'RestElement') { val = 'Array.prototype.slice.call(arguments,' + i + ')'; p = p.argument; }
        else if (p.type === 'AssignmentPattern') { val = 'arguments.length>' + i + '&&' + arg + '!==void 0?' + arg + ':' + this.E(p.right, P_ASSIGN); p = p.left; }
        else val = arg;
        // (bname: a parameter named like its function is renamed, see W.avoidNameParam)
        if (p.type === 'Identifier') return 'var ' + this.bname(p) + '=' + val + ';';
        var list = [];
        this.destructure(p, val, list, 'decl');
        return 'var ' + list.join(',') + ';';
    };
    // o: {superRef, supVar, fields, accessor}
    // a function lowered while parsing (W.early), below a stand-in function context: the outer this/arguments an
    // arrow in it needs are placeholders, replaced by P.rawFunc once the context around it is known
    P.early = function (n) {
        if (!this.program) { this.program = new Ctx('program', null, null); this.progInit = ''; }
        var saved = this.ctx, holder = new Ctx('fn', this.program, null), code;
        this.ctx = holder;
        try {
            code = isClassNode(n) ? this.classExpr(n, null) : n.type === 'ArrowFunctionExpression' ? this.func(n, 'arrow', null, null) : this.func(n, 'fn', n.id ? n.id.name : null, null);
        } finally { this.ctx = saved; }
        if (holder.temps.length || holder.ntAlias) throw new Unsupported('early-context');
        return { code: code, thisAlias: holder.thisAlias, argsAlias: holder.argsAlias };
    };
    var replaceName = function (code, name, by) {
        return code.replace(new RegExp('(^|[^\\w$])' + name.replace(/\$/g, '\\$') + '(?![\\w$])', 'g'), function (m, pre) { return pre + by; });
    };
    P.rawFunc = function (n) {
        var r = n.$raw, code = r.text;
        if (code === null) return this.src.slice(n.start, n.end);
        if (r.thisAlias || r.argsAlias) {
            this.push('arrow', n);
            if (r.thisAlias) code = replaceName(code, r.thisAlias, this.thisCode());
            if (r.argsAlias) code = replaceName(code, r.argsAlias, this.argsCode());
            this.pop();
        }
        return code;
    };
    P.func = function (n, kind, name, o) {
        if (n.$raw) return n.$raw.fresh ? this.func(n.$raw.fresh, kind, name, o) : this.rawFunc(n);
        if (n.async || n.generator) return this.genFunc(n, kind, name, o);
        var ctx = this.push(kind, n), i;
        if (o) {
            if (o.superRef !== undefined) ctx.superRef = o.superRef;
            if (o.supVar) ctx.superCtor = o.supVar;
            if (o.fields) ctx.fieldNodes = o.fields;
        }
        if (kind === 'dctor') { ctx.derivedThis = this.fresh('_this'); ctx.declare(ctx.derivedThis); }
        var params = [], pre = '', simple = n.params.length;
        for (i = 0; i < n.params.length; i++) if (n.params[i].type !== 'Identifier') { simple = i; break; }
        for (i = 0; i < simple; i++) params.push(this.bname(n.params[i]));
        for (i = simple; i < arityOf(n); i++) params.push(this.fresh('_p'));
        for (i = simple; i < n.params.length; i++) pre += this.param(n.params[i], i);
        if (kind === 'ctor' && ctx.fieldNodes) pre += this.fieldStmts(ctx.fieldNodes);
        var dirs = '', body;
        if (n.expression) body = 'return ' + this.E(n.body, P_ASSIGN) + ';';
        else {
            var st = n.body.body, k = 0;
            while (k < st.length && st[k].directive !== undefined) { dirs += sliceStmt(this.src, st[k]); k++; }
            body = this.block(k ? st.slice(k) : st, false);
        }
        if (kind === 'dctor') body += 'return ' + ctx.derivedThis + ';';
        if (ctx.ntAlias) {
            if (kind === 'ctor' || kind === 'dctor') ctx.ntCode = 'this.constructor';
            else { if (!name) name = this.fresh('_f'); ctx.ntCode = 'this instanceof ' + name + '?this.constructor:void 0'; }
        }
        this.pop();
        var head = o && o.accessor ? '' : 'function' + (name ? ' ' + name : '');
        return head + '(' + params.join(',') + '){' + dirs + this.declLine(ctx) + pre + body + '}';
    };

    // ---- classes
    P.classKey = function (m, priv) {
        if (m.key.type === 'PrivateIdentifier') return quote(priv['$' + m.key.name]);
        if (m.computed) return this.E(m.key, P_ASSIGN);
        if (m.key.type === 'Identifier') return quote(m.key.name);
        return quote(String(m.key.value));
    };
    P.fieldExprs = function (fields) {
        var out = [], target = this.thisCode();
        for (var i = 0; i < fields.length; i++) {
            var f = fields[i], val = f.m.value ? this.E(f.m.value, P_ASSIGN) : 'void 0';
            if (f.priv) out.push(this.h('__br_defp') + '(' + target + ',' + quote(f.priv) + ',' + val + ')');
            else if (f.keyTemp) out.push(target + '[' + f.keyTemp + ']=' + val);
            else out.push(target + f.access + '=' + val);
        }
        return out;
    };
    P.fieldStmts = function (fields) { var e = this.fieldExprs(fields); return e.length ? e.join(';') + ';' : ''; };
    P.superCall = function (n) {
        var t = this.ctx.thisCtx;
        if (t.kind !== 'dctor') throw new Unsupported('super() outside a derived constructor');
        var args = hasSpread(n.arguments) ? this.spreadArray(n.arguments) : '[' + this.args(n.arguments) + ']';
        var parts = [t.derivedThis + '=' + this.h('__br_super') + '(this,' + t.superCtor + ',' + args + ')'];
        if (t.fieldNodes) parts = parts.concat(this.fieldExprs(t.fieldNodes));
        parts.push(t.derivedThis);
        this.prec = P_SEQ;
        return parts.join(',');
    };
    P.classExpr = function (n, hint) {
        if (n.$raw) {
            if (n.$raw.fresh) return this.classExpr(n.$raw.fresh, hint);
            var rc = this.rawFunc(n);
            this.prec = P_CALL;
            return rc;
        }
        var name = n.id ? n.id.name : hint && IDENT.test(hint) && !ES5_RESERVED[hint] ? hint : this.fresh('_class');
        var supCode = n.superClass ? this.E(n.superClass, P_ASSIGN) : null;
        var supVar = supCode !== null ? this.fresh('_super') : null;
        var ctx = this.push('static', n);
        ctx.className = name;
        ctx.superRef = supVar;
        var priv = {}, members = n.body.body, i, m;
        for (i = 0; i < members.length; i++) {
            m = members[i];
            if (m.key && m.key.type === 'PrivateIdentifier' && !priv['$' + m.key.name]) priv['$' + m.key.name] = '__br$' + m.key.name + '$' + this.pfx + (++this.uid);
        }
        this.privStack.push(priv);
        var ctor = null, proto = [], stat = [], fields = [], statics = [], keyPre = '';
        for (i = 0; i < members.length; i++) {
            m = members[i];
            if (m.type === 'MethodDefinition') {
                if (m.kind === 'constructor') { ctor = m; continue; }
                var key = this.classKey(m, priv);
                var fn = this.func(m.value, 'method', null, { superRef: supVar ? (m.static ? supVar : supVar + '.prototype') : null });
                (m.static ? stat : proto).push(key, fn, m.kind === 'get' ? '1' : m.kind === 'set' ? '2' : '0');
            } else if (m.type === 'PropertyDefinition') {
                var f = { m: m };
                if (m.key.type === 'PrivateIdentifier') f.priv = priv['$' + m.key.name];
                else if (m.computed) { f.keyTemp = this.temp('_key'); keyPre += f.keyTemp + '=' + this.E(m.key, P_ASSIGN) + ';'; }
                else f.access = m.key.type === 'Identifier' ? dotName(m.key) : '[' + quote(String(m.key.value)) + ']';
                (m.static ? statics : fields).push(f);
            } else if (m.type === 'StaticBlock') statics.push({ block: m });
        }
        var ctorCode;
        if (ctor) ctorCode = this.func(ctor.value, supVar ? 'dctor' : 'ctor', name, { superRef: supVar ? supVar + '.prototype' : null, supVar: supVar, fields: fields });
        else {
            var cc = this.push(supVar ? 'dctor' : 'ctor', null), cbody;
            cc.superRef = supVar ? supVar + '.prototype' : null;
            if (supVar) {
                cc.derivedThis = this.fresh('_this');
                cc.declare(cc.derivedThis);
                cbody = cc.derivedThis + '=' + this.h('__br_super') + '(this,' + supVar + ',arguments);' + this.fieldStmts(fields) + 'return ' + cc.derivedThis + ';';
            } else cbody = this.fieldStmts(fields);
            this.pop();
            ctorCode = 'function ' + name + '(){' + this.declLine(cc) + cbody + '}';
        }
        var st = '';
        for (i = 0; i < statics.length; i++) {
            var s = statics[i];
            if (s.block) {
                var fnNode = { type: 'FunctionExpression', id: null, params: [], generator: false, async: false, expression: false, $d: true,
                               body: { type: 'BlockStatement', body: s.block.body, $d: true } };
                st += '(' + this.func(fnNode, 'fn', null, { superRef: supVar }) + ').call(' + name + ');';
                continue;
            }
            var v = s.m.value ? this.E(s.m.value, P_ASSIGN) : 'void 0';
            if (s.priv) st += this.h('__br_defp') + '(' + name + ',' + quote(s.priv) + ',' + v + ');';
            else if (s.keyTemp) st += name + '[' + s.keyTemp + ']=' + v + ';';
            else st += name + s.access + '=' + v + ';';
        }
        this.privStack.pop();
        var body = ctorCode + (supVar ? this.h('__br_inherits') + '(' + name + ',' + supVar + ');' : '') + keyPre +
                   this.h('__br_class') + '(' + name + ',' + (proto.length ? '[' + proto.join(',') + ']' : 'null') + ',' + (stat.length ? '[' + stat.join(',') + ']' : 'null') + ');' +
                   st + 'return ' + name + ';';
        this.pop();
        this.prec = P_CALL;
        return '(function(' + (supVar || '') + '){' + this.declLine(ctx) + body + '})(' + (supCode === null ? '' : supCode) + ')';
    };

    // ---- statements
    var MULTI = { VariableDeclaration: 1, FunctionDeclaration: 1, ClassDeclaration: 1, ForStatement: 1, ForInStatement: 1, ForOfStatement: 1,
                  WhileStatement: 1, DoWhileStatement: 1, LabeledStatement: 1 };
    P.S = function (n) {
        if (!n.$d) return sliceStmt(this.src, n);
        switch (n.type) {
            case 'ExpressionStatement': {
                // A statement that starts with a function goes in parentheses. Around the function itself: around the
                // whole, an assignment to a member of its call, (function(){return a,b}(x).y = z), is refused by the old
                // engine ("Expected token ')'", once the function holds a comma expression: imgur's lowered classes)
                var lead = leftmostNode(n.expression);
                if (lead && (lead.type === 'FunctionExpression' || lead.type === 'ClassExpression' || lead.type === 'ArrowFunctionExpression')) lead.$wrap = true;
                var code = this.E(n.expression, P_SEQ);
                if (/^(?:function\b|class\b|\{|let\s*\[)/.test(code)) code = '(' + code + ')';
                return code + ';';
            }
            case 'BlockStatement': return '{' + this.block(n.body, true) + '}';
            case 'EmptyStatement': return ';';
            case 'VariableDeclaration': { var v = this.varDecl(n, false); return v ? v + ';' : ''; }
            case 'FunctionDeclaration': return n.$lexfn ? this.lexFn(n) : this.func(n, 'fn', n.id.name, null);
            case 'ClassDeclaration': {
                var cn = this.bname(n.id);
                if (this.ctx.kind === 'gen' || this.ctx.kind === 'modrun') { this.hoistVar(cn); return cn + '=' + this.classExpr(n, null) + ';'; }
                return 'var ' + cn + '=' + this.classExpr(n, null) + ';';
            }
            case 'ReturnStatement': return this.ret(n);
            case 'IfStatement': return 'if(' + this.E(n.test, P_SEQ) + ')' + this.sub(n.consequent) + (n.alternate ? 'else ' + this.sub(n.alternate) : '');
            case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': case 'WhileStatement': case 'DoWhileStatement': return this.loop(n, []);
            case 'LabeledStatement': return this.labeled(n, []);
            case 'BreakStatement': case 'ContinueStatement': return this.jump(n);
            case 'ThrowStatement': return 'throw ' + this.E(n.argument, P_SEQ) + ';';
            case 'TryStatement': return this.tryStmt(n);
            case 'SwitchStatement': return this.switchStmt(n);
            case 'WithStatement': return 'with(' + this.E(n.object, P_SEQ) + ')' + this.sub(n.body);
            case 'DebuggerStatement': return 'debugger;';
            // (skipped statements parsed again: see W.stmtAgain)
            case 'BrRawStatement': if (n.$fresh) return this.block(n.$fresh, false); break;
            case 'ImportDeclaration': case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration': case 'ExportAllDeclaration': throw new Unsupported('module');
        }
        throw new Unsupported(n.type);
    };
    // a statement in the place of one statement (if/else/loop body): several output statements get braces
    P.sub = function (n) {
        var code = this.S(n);
        if (n.$d && MULTI[n.type]) code = '{' + code + '}';
        return code;
    };
    // a statement list; nested (a block below function level): strict function declarations become variables first
    P.block = function (list, nested) {
        var out = '', i, n;
        if (nested) for (i = 0; i < list.length; i++) if (list[i].type === 'FunctionDeclaration' && list[i].$lexfn) out += this.lexFn(list[i]);
        for (i = 0; i < list.length; i++) {
            n = list[i];
            if (nested && n.type === 'FunctionDeclaration' && n.$lexfn) continue;
            out += this.S(n);
        }
        return out;
    };
    P.lexFn = function (n) { return 'var ' + this.bname(n.id) + '=' + this.func(n, 'fn', n.id.name, null) + ';'; };
    // `var` list (or, inside a loop function, assignments to variables of the function around it)
    P.varDecl = function (n, forInit) {
        var hoist = this.hoisting(n.kind), parts = [], i, d, name, c;
        for (i = 0; i < n.declarations.length; i++) {
            d = n.declarations[i];
            if (d.id.type === 'Identifier') {
                name = this.bname(d.id);
                if (hoist) {
                    this.hoistVar(name);
                    if (d.init) parts.push(name + '=' + this.E(d.init, P_ASSIGN));
                    else if (n.kind !== 'var' && !forInit) parts.push(name + '=void 0');
                    continue;
                }
                if (d.init) {
                    c = this.E(d.init, P_ASSIGN);
                    if (forInit && /\bin\b/.test(c)) c = '(' + c + ')';
                    parts.push(name + '=' + c);
                } else parts.push(n.kind === 'var' || forInit ? name : name + '=void 0');
            } else {
                var list = [];
                this.destructure(d.id, d.init ? this.E(d.init, P_ASSIGN) : 'void 0', list, hoist ? 'hoist' : 'decl');
                parts = parts.concat(list);
            }
        }
        if (!parts.length) return '';
        return hoist ? parts.join(',') : 'var ' + parts.join(',');
    };
    P.ret = function (n) {
        var c = this.ctx;
        if (c.kind === 'loop') {
            var info = c.loopInfo;
            info.usesReturn = true;
            return '{' + this.outAssigns(info) + 'return{v:' + (n.argument ? this.E(n.argument, P_ASSIGN) : 'void 0') + '};}';
        }
        if (!n.argument) return c.kind === 'dctor' ? 'return ' + c.derivedThis + ';' : 'return;';
        return 'return ' + this.E(n.argument, P_SEQ) + ';';
    };
    P.labeled = function (n, labels) {
        labels = labels.concat([n.label.name]);
        var body = n.body;
        if (body.type === 'LabeledStatement') return this.labeled(body, labels);
        if (isLoop(body)) return this.loop(body, labels);
        this.ctx.jumps.push({ kind: 'label', labels: labels });
        var code = this.S(body);
        this.ctx.jumps.pop();
        return labels.join(':') + ':' + code;
    };
    P.outAssigns = function (info) {
        var s = '';
        for (var i = 0; i < info.out.length; i++) s += info.out[i][0] + '=' + info.out[i][1] + ';';
        return s;
    };
    P.jump = function (n) {
        var brk = n.type === 'BreakStatement', label = n.label ? n.label.name : null, st = this.ctx.jumps, i, e;
        for (i = st.length - 1; i >= 0; i--) {
            e = st[i];
            if (e.kind === 'boundary') {
                // out of a loop function: the call site does the jump
                var info = e.info, code;
                if (!label || info.labels.indexOf(label) >= 0) {
                    if (brk) { info.usesBreak = true; code = 'return "break";'; } else code = 'return;';
                } else {
                    var key = (brk ? 'b|' : 'c|') + label;
                    if (!info.jumpSet[key]) { info.jumpSet[key] = 1; info.jumps.push({ code: key, brk: brk, label: label }); }
                    code = 'return ' + quote(key) + ';';
                }
                var w = this.outAssigns(info);
                return w ? '{' + w + code + '}' : code;
            }
            if (label) { if ((e.kind === 'loop' || e.kind === 'label') && e.labels.indexOf(label) >= 0) break; }
            else if (e.kind === 'loop' || (brk && e.kind === 'switch')) break;
        }
        return (brk ? 'break' : 'continue') + (label ? ' ' + label : '') + ';';
    };
    P.switchStmt = function (n) {
        var disc = this.E(n.discriminant, P_SEQ), body = '';
        this.ctx.jumps.push({ kind: 'switch', labels: [] });
        for (var i = 0; i < n.cases.length; i++) {
            var c = n.cases[i];
            body += (c.test ? 'case ' + this.E(c.test, P_SEQ) + ':' : 'default:') + this.block(c.consequent, true);
        }
        this.ctx.jumps.pop();
        return 'switch(' + disc + '){' + body + '}';
    };
    P.tryStmt = function (n) {
        var code = 'try' + this.S(n.block);
        if (n.handler) {
            var h = n.handler, param = h.param, pre = '';
            if (!param) code += 'catch(' + this.fresh('_e') + ')';
            else if (param.type === 'Identifier') code += 'catch(' + param.name + ')';
            else {
                var ev = this.fresh('_e'), list = [];
                this.destructure(param, ev, list, 'decl');
                pre = 'var ' + list.join(',') + ';';
                code += 'catch(' + ev + ')';
            }
            code += '{' + pre + this.block(h.body.body, true) + '}';
        }
        if (n.finalizer) code += 'finally' + this.S(n.finalizer);
        return code;
    };
    P.bodyWithPre = function (body, pre) {
        if (!pre) return this.sub(body);
        if (body.type === 'BlockStatement') return '{' + pre + this.block(body.body, true) + '}';
        return '{' + pre + this.S(body) + '}';
    };
    // the binding statement of a for-in/for-of head for one value
    P.forBinding = function (left, value) {
        var hoist = left.type === 'VariableDeclaration' && this.hoisting(left.kind), list;
        if (left.type === 'VariableDeclaration') {
            var d = left.declarations[0];
            if (d.id.type === 'Identifier') {
                var nm = this.bname(d.id);
                if (hoist) { this.hoistVar(nm); return nm + '=' + value + ';'; }
                return 'var ' + nm + '=' + value + ';';
            }
            list = [];
            this.destructure(d.id, value, list, hoist ? 'hoist' : 'decl');
            return (hoist ? '' : 'var ') + list.join(',') + ';';
        }
        if (left.type === 'Identifier' || left.type === 'MemberExpression') return this.E(left, P_CALL) + '=' + value + ';';
        list = [];
        this.destructure(left, value, list, 'assign');
        return list.join(',') + ';';
    };
    P.loop = function (n, labels) {
        var prefix = labels.length ? labels.join(':') + ':' : '';
        if (n.$wrap && !n.$noWrap) return this.wrappedLoop(n, labels, prefix);
        var entry = { kind: 'loop', labels: labels }, code, jumps = this.ctx.jumps;
        switch (n.type) {
            case 'WhileStatement': {
                var test = this.E(n.test, P_SEQ);
                jumps.push(entry);
                code = 'while(' + test + ')' + this.sub(n.body);
                jumps.pop();
                break;
            }
            case 'DoWhileStatement': {
                jumps.push(entry);
                var b = this.sub(n.body);
                jumps.pop();
                code = 'do ' + b + 'while(' + this.E(n.test, P_SEQ) + ');';
                break;
            }
            case 'ForStatement': {
                var init = '';
                if (n.init) {
                    if (n.init.type === 'VariableDeclaration') init = this.varDecl(n.init, true);
                    else { init = this.E(n.init, P_SEQ); if (/\bin\b/.test(init)) init = '(' + init + ')'; }
                }
                var t2 = n.test ? this.E(n.test, P_SEQ) : '', u = n.update ? this.E(n.update, P_SEQ) : '';
                jumps.push(entry);
                code = 'for(' + init + ';' + t2 + ';' + u + ')' + this.sub(n.body);
                jumps.pop();
                break;
            }
            case 'ForInStatement': {
                var left = n.left, head, pre = '';
                if (left.type === 'VariableDeclaration' && left.declarations[0].id.type === 'Identifier') {
                    var nm = this.bname(left.declarations[0].id);
                    if (this.hoisting(left.kind)) { this.hoistVar(nm); head = nm; } else head = 'var ' + nm;
                } else if (left.type === 'Identifier' || left.type === 'MemberExpression') head = this.E(left, P_CALL);
                else { head = this.temp('_k'); pre = this.forBinding(left, head); }
                var right = this.E(n.right, P_SEQ);
                jumps.push(entry);
                code = 'for(' + head + ' in ' + right + ')' + this.bodyWithPre(n.body, pre);
                jumps.pop();
                break;
            }
            case 'ForOfStatement': {
                if (n.await) throw new Unsupported('for await');
                var it = this.temp('_it'), step = this.temp('_s'), rv = this.E(n.right, P_ASSIGN);
                var bind = this.forBinding(n.left, step + '.value');
                jumps.push(entry);
                code = 'for(' + it + '=' + this.h('__br_iter') + '(' + rv + ');!(' + step + '=' + it + '()).done;)' + this.bodyWithPre(n.body, bind);
                jumps.pop();
                break;
            }
        }
        return prefix + code;
    };
    // the head's names of for(let ...): parameters of the loop function
    var headBindings = function (decl) {
        var out = [];
        var walk = function (p) {
            if (!p) return;
            switch (p.type) {
                case 'Identifier': if (p.$b) out.push(p.$b); break;
                case 'ObjectPattern': for (var i = 0; i < p.properties.length; i++) walk(p.properties[i].type === 'RestElement' ? p.properties[i].argument : p.properties[i].value); break;
                case 'ArrayPattern': for (var j = 0; j < p.elements.length; j++) walk(p.elements[j]); break;
                case 'RestElement': walk(p.argument); break;
                case 'AssignmentPattern': walk(p.left); break;
            }
        };
        for (var k = 0; k < decl.declarations.length; k++) walk(decl.declarations[k].id);
        return out;
    };
    var writtenIn = function (b, node) {
        for (var i = 0; i < b.refs.length; i++) { var r = b.refs[i]; if (r.$w && r.start >= node.start && r.end <= node.end) return true; }
        return false;
    };
    // a loop whose closures capture bindings of the iteration: the body becomes a function called per iteration
    P.wrappedLoop = function (n, labels, prefix) {
        var info = { labels: labels, usesBreak: false, usesReturn: false, jumps: [], jumpSet: {}, out: [] };
        var fnName = this.fresh('_loop'), ret = this.temp('_ret'), params = [], args = [], i;
        if (n.type === 'ForStatement' && n.init && n.init.type === 'VariableDeclaration' && n.init.kind !== 'var') {
            var hb = headBindings(n.init);
            for (i = 0; i < hb.length; i++) {
                var nm = hb[i].newName || hb[i].name;
                params.push(nm);
                args.push(nm);
                if (writtenIn(hb[i], n.body)) info.out.push([this.temp('_out'), nm]);
            }
        }
        var val = null, it = null, step = null, key = null;
        if (n.type === 'ForInStatement' || n.type === 'ForOfStatement') { val = this.fresh('_v'); params.push(val); }
        if (n.type === 'ForOfStatement') { if (n.await) throw new Unsupported('for await'); it = this.temp('_it'); step = this.temp('_s'); args.push(step + '.value'); }
        if (n.type === 'ForInStatement') { key = this.temp('_k'); args.push(key); }
        var ctx = this.push('loop', n);
        ctx.loopInfo = info;
        ctx.jumps = [{ kind: 'boundary', info: info }];
        var pro = val ? this.forBinding(n.left, val) : '';
        var body = n.body.type === 'BlockStatement' ? this.block(n.body.body, true) : this.S(n.body);
        var fnCode = 'function(' + params.join(',') + '){' + this.declLine(ctx) + pro + body + this.outAssigns(info) + '}';
        this.pop();
        var call = ret + '=' + fnName + '(' + args.join(',') + ');';
        for (i = 0; i < info.out.length; i++) call += info.out[i][1] + '=' + info.out[i][0] + ';';
        this.ctx.jumps.push({ kind: 'loop', labels: labels });
        if (info.usesBreak) call += 'if(' + ret + '==="break")break;';
        for (i = 0; i < info.jumps.length; i++) {
            var j = info.jumps[i];
            call += 'if(' + ret + '===' + quote(j.code) + ')' + this.jump({ type: j.brk ? 'BreakStatement' : 'ContinueStatement', label: { name: j.label } });
        }
        if (info.usesReturn) call += 'if(typeof ' + ret + '==="object")' + this.ret({ type: 'ReturnStatement', argument: { type: 'Raw', code: ret + '.v', $d: true } });
        this.ctx.jumps.pop();
        var loopCode;
        switch (n.type) {
            case 'ForStatement': {
                var init = n.init ? (n.init.type === 'VariableDeclaration' ? this.varDecl(n.init, true) : this.E(n.init, P_SEQ)) : '';
                loopCode = 'for(' + init + ';' + (n.test ? this.E(n.test, P_SEQ) : '') + ';' + (n.update ? this.E(n.update, P_SEQ) : '') + '){' + call + '}';
                break;
            }
            case 'ForInStatement': loopCode = 'for(' + key + ' in ' + this.E(n.right, P_SEQ) + '){' + call + '}'; break;
            case 'ForOfStatement': loopCode = 'for(' + it + '=' + this.h('__br_iter') + '(' + this.E(n.right, P_ASSIGN) + ');!(' + step + '=' + it + '()).done;){' + call + '}'; break;
            case 'WhileStatement': loopCode = 'while(' + this.E(n.test, P_SEQ) + '){' + call + '}'; break;
            case 'DoWhileStatement': loopCode = 'do{' + call + '}while(' + this.E(n.test, P_SEQ) + ');'; break;
        }
        return 'var ' + fnName + '=' + fnCode + ';' + prefix + loopCode;
    };
    P.programCode = function (ast) {
        // (functions lowered while parsing may have declared program variables already)
        var ctx = this.program;
        if (ctx) { ctx.node = ast; this.ctx = ctx; } else { ctx = this.push('program', ast); this.program = ctx; this.progInit = ''; }
        var st = ast.body, dirs = '', k = 0;
        while (k < st.length && st[k].directive !== undefined) { dirs += sliceStmt(this.src, st[k]); k++; }
        var body = this.block(k ? st.slice(k) : st, false);
        this.pop();
        return dirs + this.helperCode() + this.declLine(ctx) + this.progInit + body;
    };
    // An ES module as __brModules.define(url, [dependency specifiers], factory). The factory holds the module's
    // variables and function declarations (functions are callable before the module runs, as with real modules),
    // registers live getters for the exports and returns [setters for the dependencies' namespaces, run]; the loader
    // in shims-extra.js fetches the graph, links it and calls run in dependency order.
    P.moduleCode = function (ast, w) {
        var mod = w.mod, st = ast.body, i, n, e, b;
        // (functions lowered while parsing may have declared program variables and named namespaces already)
        var ctx = this.program;
        if (ctx) { ctx.node = ast; this.ctx = ctx; } else { ctx = this.push('program', ast); this.program = ctx; this.progInit = ''; }
        for (i = 0; i < mod.deps.length; i++) ctx.declare(this.modVar(i));
        this.metaVar();
        var exName = this.fresh('_ex'), fdecls = '', getters = [], fname;
        var getter = function (name, code) { getters.push(quote(name) + ':function(){return ' + code + ';}'); };
        for (i = 0; i < st.length; i++) {
            n = st[i];
            var fd = n.type === 'FunctionDeclaration' ? n : (n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration') && n.declaration && n.declaration.type === 'FunctionDeclaration' ? n.declaration : null;
            if (!fd) continue;
            fname = fd.id ? fd.id.name : this.fresh('_default');
            fdecls += this.func(fd, 'fn', fname, null);
            if (n.type === 'ExportDefaultDeclaration') getter('default', fname);
        }
        var run = this.push('modrun', ast), body = '';
        // top-level await: run is an async function (a state machine) whose promise the loader waits for
        var machine = w.tla ? this.genBegin(ast) : null;
        for (i = 0; i < st.length; i++) {
            n = st[i];
            if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'FunctionDeclaration') continue;
            if (n.type === 'ExportNamedDeclaration') { if (n.declaration && n.declaration.type !== 'FunctionDeclaration') body += this.modStmt(n.declaration, machine); continue; }
            if (n.type === 'ExportDefaultDeclaration') {
                var dd = n.declaration;
                if (dd.type === 'FunctionDeclaration') continue;
                if (dd.type === 'ClassDeclaration' && dd.id) { body += this.modStmt(dd, machine); getter('default', this.bname(dd.id)); continue; }
                var dn = this.fresh('_default');
                this.hoistVar(dn);
                var dv = dd.type === 'ClassDeclaration' ? this.classExpr(dd, null) : machine ? this.gx(dd, false) : this.E(dd, P_ASSIGN);
                if (machine) this.gEmit(dn + '=' + dv + ';'); else body += dn + '=' + dv + ';';
                getter('default', dn);
                continue;
            }
            body += this.modStmt(n, machine);
        }
        if (machine) body = this.genEnd(machine, 'async', function () { return 'this'; });
        this.pop();
        for (i = 0; i < mod.exports.length; i++) {
            e = mod.exports[i];
            if (e.node) continue;   // (export default: above)
            if (e.id) {
                b = e.id.$b;
                getter(e.name, b ? (b.kind === 'import' ? this.importRef(b) : b.newName || b.name) : e.id.name);
            } else if (e.ns) getter(e.name, this.modVar(e.dep));
            else getter(e.name, this.modVar(e.dep) + (IDENT.test(e.from) ? '.' + e.from : '[' + quote(e.from) + ']'));
        }
        var setters = [], deps = [];
        for (i = 0; i < mod.deps.length; i++) { setters.push('function(n){' + this.modVar(i) + '=n;}'); deps.push(quote(mod.deps[i])); }
        this.pop();
        var factory = 'function(' + exName + ',' + this.metaName + '){"use strict";' + this.declLine(ctx) + this.progInit + fdecls +
                      exName + '({' + getters.join(',') + '},[' + mod.stars.join(',') + ']);return[[' + setters.join(',') + '],function(){' + body + '}];}';
        return this.helperCode() + '__brModules.define(' + quote(this.opts.url || '') + ',[' + deps.join(',') + '],' + factory + ');';
    };
    // a statement of the module's body: its code, or into the state machine (top-level await)
    P.modStmt = function (n, machine) {
        if (!machine) return this.S(n);
        this.gStmt(n, []);
        return '';
    };

    // ------------------------------------------------------------------------------------------------ generators
    // A generator or async function becomes a function returning rt.wrap(machine) / rt.async(machine): the body is
    // cut at every yield/await (and around jumps) into the cases of `while (1) switch (ctx.prev = ctx.next)`, the
    // variables live in the function around the machine, values that must survive a yield go into ctx.t0, t1...
    // (facebook/regenerator's emitter, printed as text here).
    var LEAP = { YieldExpression: 1, AwaitExpression: 1, BreakStatement: 1, ContinueStatement: 1, ReturnStatement: 1, ThrowStatement: 1 };
    var BOUNDARY = { FunctionDeclaration: 1, FunctionExpression: 1, ArrowFunctionExpression: 1, ClassDeclaration: 1, ClassExpression: 1 };
    var containsLeap = function (n) {
        if (!n || typeof n.type !== 'string') return false;
        if (n.$lp !== undefined) return n.$lp;
        var r = false;
        if (LEAP[n.type] || (n.type === 'ForOfStatement' && n.await)) r = true;
        else if (!BOUNDARY[n.type]) {
            for (var k in n) {
                if (k.charAt(0) === '$' || !hasOwn.call(n, k)) continue;
                var v = n[k];
                if (!v || typeof v !== 'object') continue;
                if (Object.prototype.toString.call(v) === '[object Array]') { for (var i = 0; i < v.length && !r; i++) if (containsLeap(v[i])) r = true; }
                else if (typeof v.type === 'string' && containsLeap(v)) r = true;
                if (r) break;
            }
        }
        n.$lp = r;
        return r;
    };
    var anyLeap = function (list) { for (var i = 0; i < list.length; i++) if (list[i] && containsLeap(list[i])) return true; return false; };
    var LOC = String.fromCharCode(1), LOC_RE = new RegExp(LOC + '(\\d+)' + LOC, 'g');
    var LITERAL_CODE = /^(?:\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|true|false|null|void 0)$/;
    var GenState = function (cv) {
        this.cv = cv;          // the context variable of the machine
        this.listing = [];     // statement code in order; a location is an index into it
        this.marks = {};       // location id -> index
        this.nloc = 0;
        this.tries = [];       // [tryLoc, catchLoc, finallyLoc, afterLoc]
        this.leaps = [];       // break/continue targets: {kind, labels, brk, cont}
        this.ntemp = 0;
    };
    P.gLoc = function () { return LOC + (++this.ctx.gen.nloc) + LOC; };
    P.gMark = function (loc) { var g = this.ctx.gen; g.marks[loc.slice(1, -1)] = g.listing.length; return loc; };
    P.gEmit = function (code) { this.ctx.gen.listing.push(code); };
    P.gJump = function (loc) { this.gEmit(this.ctx.gen.cv + '.next=' + loc + ';break;'); };
    P.gJumpIf = function (test, loc) { this.gEmit('if(' + test + '){' + this.ctx.gen.cv + '.next=' + loc + ';break;}'); };
    P.gJumpIfNot = function (test, loc) { this.gEmit('if(!(' + test + ')){' + this.ctx.gen.cv + '.next=' + loc + ';break;}'); };
    P.gTemp = function () { var g = this.ctx.gen; return g.cv + '.t' + (g.ntemp++); };
    P.gAssign = function (target, code) { this.gEmit(target + '=' + code + ';'); return target; };
    // the state machine records where it is at the start of try/catch/finally code (exceptions are routed by it)
    P.gPrev = function (loc) { this.gMark(loc); this.gEmit(this.ctx.gen.cv + '.prev=' + loc + ';'); };
    P.gExprStmt = function (code) { if (/^(?:function\b|class\b|\{|let\s*\[)/.test(code)) code = '(' + code + ')'; this.gEmit(code + ';'); };
    P.gAbrupt = function (type, arg) { this.gEmit('return ' + this.ctx.gen.cv + '.abrupt(' + quote(type) + (arg === null ? '' : ',' + arg) + ');'); };
    P.gTarget = function (label, cont) {
        var leaps = this.ctx.gen.leaps;
        for (var i = leaps.length - 1; i >= 0; i--) {
            var e = leaps[i];
            if (label) { if (e.labels.indexOf(label) >= 0 && (!cont || e.kind === 'loop')) return cont ? e.cont : e.brk; }
            else if (e.kind === 'loop' || (!cont && e.kind === 'switch')) return cont ? e.cont : e.brk;
        }
        throw new Unsupported('jump target');
    };
    P.rtName = function () {
        if (!this.rt) { this.rt = this.progTemp('_rt'); this.progInit += this.rt + '=' + this.h('__br_regen') + '();'; }
        return this.rt;
    };
    P.genFunc = function (n, kind, name, o) {
        var outer = this.push(kind, n), i;
        if (o && o.superRef !== undefined) outer.superRef = o.superRef;
        var params = [], pre = '', simple = n.params.length;
        for (i = 0; i < n.params.length; i++) if (n.params[i].type !== 'Identifier') { simple = i; break; }
        for (i = 0; i < simple; i++) params.push(this.bname(n.params[i]));
        for (i = simple; i < arityOf(n); i++) params.push(this.fresh('_p'));
        for (i = simple; i < n.params.length; i++) pre += this.param(n.params[i], i);
        var dirs = '', stmts;
        if (n.expression) stmts = [{ type: 'ReturnStatement', argument: n.body, $d: true }];
        else {
            var st = n.body.body, k = 0;
            while (k < st.length && st[k].directive !== undefined) { dirs += sliceStmt(this.src, st[k]); k++; }
            stmts = k ? st.slice(k) : st;
        }
        // the body's function declarations stay declarations of the outer function
        var fdecls = '';
        for (i = 0; i < stmts.length; i++) if (stmts[i].type === 'FunctionDeclaration') { stmts[i].$hoisted = true; fdecls += this.func(stmts[i], 'fn', stmts[i].id.name, null); }
        var inner = this.genBegin(n);
        for (i = 0; i < stmts.length; i++) this.gStmt(stmts[i], []);
        var body = this.genEnd(inner, n.async ? (n.generator ? 'asyncGen' : 'async') : 'wrap', function (p) { return kind === 'arrow' ? p.thisCode() : 'this'; });
        this.pop();
        var head = o && o.accessor ? '' : 'function' + (name ? ' ' + name : '');
        return head + '(' + params.join(',') + '){' + dirs + this.declLine(outer) + pre + fdecls + body + '}';
    };
    // a state machine in the current function context: genBegin opens it, the statements go in with gStmt, genEnd
    // closes it and returns the code that returns rt[method](machine) (self: `this` for the machine, in the outer
    // context)
    P.genBegin = function (n) {
        var inner = this.push('gen', n);
        inner.gen = new GenState(this.fresh('_context'));
        inner.gen.asyncGen = !!(n.async && n.generator);
        return inner;
    };
    P.genEnd = function (inner, method, self) {
        var g = inner.gen, cv = g.cv, i;
        var resolve = function (s) { return s.replace(LOC_RE, function (m, id) { return String(g.marks[id]); }); };
        var starts = {}, id, machine = '';
        for (id in g.marks) if (hasOwn.call(g.marks, id)) starts[g.marks[id]] = 1;
        for (i = 0; i < g.listing.length; i++) machine += (i === 0 || starts[i] ? 'case ' + i + ':' : '') + g.listing[i];
        // (an empty body still starts at 0: without that case `async () => {}` looped for ever in its while(1) - The Verge
        // froze in `a ??= (async () => {})()`)
        if (!g.listing.length || starts[g.listing.length]) machine += 'case ' + g.listing.length + ':';
        machine = resolve(machine) + 'case "end":return ' + cv + '.stop();';
        var tries = [];
        for (i = 0; i < g.tries.length; i++) {
            var t = g.tries[i];
            tries.push('[' + t[0] + (t[1] || t[2] ? ',' + (t[1] || '') : '') + (t[2] ? ',' + t[2] + ',' + t[3] : '') + ']');
        }
        var triesCode = tries.length ? resolve('[' + tries.join(',') + ']') : '';
        this.pop();
        var selfCode = self(this), rt = this.rtName();
        return 'return ' + rt + '.' + method + '(function(' + cv + '){' + this.declLine(inner) + 'while(1)switch(' + cv + '.prev=' + cv + '.next){' +
               machine + '}},null,' + selfCode + (triesCode ? ',' + triesCode : '') + ');';
    };
    // one statement into the machine
    P.gStmt = function (n, labels) {
        var g = this.ctx.gen, i, after, head, update, test, first, elseLoc, it, step;
        if (n.type === 'FunctionDeclaration') {
            if (!n.$hoisted) { var fname = this.bname(n.id); this.hoistVar(fname); this.gEmit(fname + '=' + this.func(n, 'fn', n.id.name, null) + ';'); }
            return;
        }
        if (!containsLeap(n)) { var code = this.S(n); if (code) this.gEmit(code); return; }
        switch (n.type) {
            case 'ExpressionStatement': this.gx(n.expression, true); return;
            case 'BlockStatement':
                // block functions first (they are hoisted in their block)
                for (i = 0; i < n.body.length; i++) if (n.body[i].type === 'FunctionDeclaration') this.gStmt(n.body[i], []);
                for (i = 0; i < n.body.length; i++) if (n.body[i].type !== 'FunctionDeclaration') this.gStmt(n.body[i], []);
                return;
            case 'LabeledStatement': {
                var lbls = labels.concat([n.label.name]);
                if (isLoop(n.body) || n.body.type === 'LabeledStatement') { this.gStmt(n.body, lbls); return; }
                after = this.gLoc();
                g.leaps.push({ kind: 'label', labels: lbls, brk: after });
                this.gStmt(n.body, []);
                g.leaps.pop();
                this.gMark(after);
                return;
            }
            case 'WhileStatement':
                head = this.gLoc(); after = this.gLoc();
                this.gMark(head);
                this.gJumpIfNot(this.gx(n.test, false), after);
                g.leaps.push({ kind: 'loop', labels: labels, brk: after, cont: head });
                this.gStmt(n.body, []);
                g.leaps.pop();
                this.gJump(head);
                this.gMark(after);
                return;
            case 'DoWhileStatement':
                first = this.gLoc(); test = this.gLoc(); after = this.gLoc();
                this.gMark(first);
                g.leaps.push({ kind: 'loop', labels: labels, brk: after, cont: test });
                this.gStmt(n.body, []);
                g.leaps.pop();
                this.gMark(test);
                this.gJumpIf(this.gx(n.test, false), first);
                this.gMark(after);
                return;
            case 'ForStatement':
                head = this.gLoc(); update = this.gLoc(); after = this.gLoc();
                if (n.init) { if (n.init.type === 'VariableDeclaration') this.gStmt(n.init, []); else this.gx(n.init, true); }
                this.gMark(head);
                if (n.test) this.gJumpIfNot(this.gx(n.test, false), after);
                g.leaps.push({ kind: 'loop', labels: labels, brk: after, cont: update });
                this.gStmt(n.body, []);
                g.leaps.pop();
                this.gMark(update);
                if (n.update) this.gx(n.update, true);
                this.gJump(head);
                this.gMark(after);
                return;
            case 'ForInStatement': case 'ForOfStatement': {
                if (n.await) {
                    // for await: each step is the awaited next() of the async iterator
                    head = this.gLoc(); after = this.gLoc();
                    it = this.gTemp();
                    this.gAssign(it, this.h('__br_asyncIter') + '(' + this.gx(n.right, false) + ')');
                    this.gMark(head);
                    var resume = this.gLoc();
                    this.gEmit(g.cv + '.next=' + resume + ';return ' + this.rtName() + '.awrap(' + it + '.next());');
                    this.gMark(resume);
                    step = this.gAssign(this.gTemp(), g.cv + '.sent');
                    this.gJumpIf(step + '.done', after);
                    this.gEmit(this.forBinding(n.left, step + '.value'));
                    g.leaps.push({ kind: 'loop', labels: labels, brk: after, cont: head });
                    this.gStmt(n.body, []);
                    g.leaps.pop();
                    this.gJump(head);
                    this.gMark(after);
                    return;
                }
                head = this.gLoc(); after = this.gLoc();
                it = this.gTemp();
                if (n.type === 'ForInStatement') this.gAssign(it, this.rtName() + '.keys(' + this.gx(n.right, false) + ')');
                else this.gAssign(it, this.h('__br_iter') + '(' + this.gx(n.right, false) + ')');
                this.gMark(head);
                step = this.gTemp();
                this.gJumpIf('(' + step + '=' + it + '()).done', after);
                this.gEmit(this.forBinding(n.left, step + '.value'));
                g.leaps.push({ kind: 'loop', labels: labels, brk: after, cont: head });
                this.gStmt(n.body, []);
                g.leaps.pop();
                this.gJump(head);
                this.gMark(after);
                return;
            }
            case 'BreakStatement': this.gAbrupt('break', this.gTarget(n.label && n.label.name, false)); return;
            case 'ContinueStatement': this.gAbrupt('continue', this.gTarget(n.label && n.label.name, true)); return;
            case 'SwitchStatement': {
                var disc = this.gAssign(this.gTemp(), this.gx(n.discriminant, false));
                after = this.gLoc();
                var defLoc = this.gLoc(), cond = defLoc, caseLocs = [], hasDefault = false;
                for (i = n.cases.length - 1; i >= 0; i--) {
                    var c = n.cases[i];
                    if (c.test) {
                        if (containsLeap(c.test)) throw new Unsupported('yield in case test');
                        caseLocs[i] = this.gLoc();
                        cond = disc + '===' + this.E(c.test, 10) + '?' + caseLocs[i] + ':' + cond;
                    } else { caseLocs[i] = defLoc; hasDefault = true; }
                }
                this.gEmit(g.cv + '.next=' + cond + ';break;');
                g.leaps.push({ kind: 'switch', labels: labels, brk: after });
                for (i = 0; i < n.cases.length; i++) {
                    this.gMark(caseLocs[i]);
                    for (var j = 0; j < n.cases[i].consequent.length; j++) this.gStmt(n.cases[i].consequent[j], []);
                }
                g.leaps.pop();
                if (!hasDefault) this.gMark(defLoc);
                this.gMark(after);
                return;
            }
            case 'IfStatement':
                elseLoc = n.alternate ? this.gLoc() : null;
                after = this.gLoc();
                this.gJumpIfNot(this.gx(n.test, false), elseLoc || after);
                this.gStmt(n.consequent, []);
                if (elseLoc) { this.gJump(after); this.gMark(elseLoc); this.gStmt(n.alternate, []); }
                this.gMark(after);
                return;
            case 'ReturnStatement': this.gAbrupt('return', n.argument ? this.gx(n.argument, false) : null); return;
            case 'ThrowStatement': this.gEmit('throw ' + this.gx(n.argument, false) + ';'); return;
            case 'VariableDeclaration': {
                for (i = 0; i < n.declarations.length; i++) {
                    var d = n.declarations[i];
                    if (!d.init) {
                        if (d.id.type === 'Identifier') { var vn = this.bname(d.id); this.hoistVar(vn); if (n.kind !== 'var') this.gEmit(vn + '=void 0;'); }
                        continue;
                    }
                    var v = this.gx(d.init, false);
                    if (d.id.type === 'Identifier') { var nm = this.bname(d.id); this.hoistVar(nm); this.gEmit(nm + '=' + v + ';'); }
                    else { var out = []; this.destructure(d.id, v, out, 'hoist'); this.gEmit(out.join(',') + ';'); }
                }
                return;
            }
            case 'TryStatement': {
                after = this.gLoc();
                var h = n.handler, catchLoc = h ? this.gLoc() : null, finLoc = n.finalizer ? this.gLoc() : null, tryLoc = this.gLoc();
                g.tries.push([tryLoc, catchLoc, finLoc, finLoc ? after : null]);
                this.gPrev(tryLoc);
                this.gStmt(n.block, []);
                if (catchLoc) {
                    this.gJump(finLoc || after);
                    this.gPrev(catchLoc);
                    var caught = g.cv + '["catch"](' + tryLoc + ')';
                    if (!h.param) this.gEmit(caught + ';');
                    else if (h.param.type === 'Identifier') {
                        // the catch variable becomes a variable of the outer function (under a fresh name)
                        var b = h.param.$b, en = this.fresh(h.param.name);
                        if (b) { b.newName = en; for (i = 0; i < b.refs.length; i++) markDirty(b.refs[i]); }
                        this.hoistVar(en);
                        this.gEmit(en + '=' + caught + ';');
                    } else { var list = [], ct = this.gTemp(); this.gEmit(ct + '=' + caught + ';'); this.destructure(h.param, ct, list, 'hoist'); this.gEmit(list.join(',') + ';'); }
                    this.gStmt(h.body, []);
                }
                if (finLoc) {
                    this.gPrev(finLoc);
                    this.gStmt(n.finalizer, []);
                    this.gEmit('return ' + g.cv + '.finish(' + finLoc + ');');
                }
                this.gMark(after);
                return;
            }
            case 'EmptyStatement': return;
        }
        throw new Unsupported('yield in ' + n.type);
    };
    // an expression into the machine: its value as code (a temporary when later parts yield), or emitted as a
    // statement (ignore)
    P.gx = function (n, ignore) {
        var g = this.ctx.gen, self = this, i, code, after, result, elseLoc;
        if (!containsLeap(n)) {
            if (ignore) { this.gExprStmt(this.E(n, P_SEQ)); return null; }
            return this.E(n, P_PRIMARY);
        }
        var kids = !(n.type === 'YieldExpression' || n.type === 'AwaitExpression') || containsLeap(n.argument);
        var viaTemp = function (temp, child, ignoreChild) {
            var r = self.gx(child, ignoreChild);
            if (ignoreChild) return r;
            if (temp || (kids && !LITERAL_CODE.test(r))) r = self.gAssign(temp || self.gTemp(), r);
            return r;
        };
        var finish = function (c) { if (ignore) { self.gExprStmt(c); return null; } return '(' + c + ')'; };
        // a list of arguments/elements with spreads as one array
        var listCode = function (els) {
            var parts = [], cur = [];
            for (var k = 0; k < els.length; k++) {
                var e = els[k];
                if (e && e.type === 'SpreadElement') { if (cur.length) { parts.push('[' + cur.join(',') + ']'); cur = []; } parts.push(self.h('__br_spread') + '(' + viaTemp(null, e.argument) + ')'); }
                else cur.push(e ? viaTemp(null, e) : 'void 0');
            }
            if (cur.length) parts.push('[' + cur.join(',') + ']');
            if (!parts.length) return '[]';
            return parts.length === 1 ? parts[0] : parts[0] + '.concat(' + parts.slice(1).join(',') + ')';
        };
        switch (n.type) {
            case 'YieldExpression': case 'AwaitExpression': {
                after = this.gLoc();
                var arg = n.argument ? this.gx(n.argument, false) : null;
                if (n.type === 'AwaitExpression') arg = this.rtName() + '.awrap(' + (arg === null ? 'void 0' : arg) + ')';
                if (n.delegate && g.asyncGen) {
                    // yield* in an async generator: await the inner iterator's next() and pass its values on (what the
                    // consumer sends goes to the inner iterator; its throw/return are not forwarded)
                    var itT = this.gAssign(this.gTemp(), this.h('__br_asyncIter') + '(' + arg + ')'), recv = this.gAssign(this.gTemp(), 'void 0');
                    var loopLoc = this.gLoc(), resumeLoc = this.gLoc(), sentLoc = this.gLoc();
                    this.gMark(loopLoc);
                    this.gEmit(g.cv + '.next=' + resumeLoc + ';return ' + this.rtName() + '.awrap(' + itT + '.next(' + recv + '));');
                    this.gMark(resumeLoc);
                    var stepT = this.gAssign(this.gTemp(), g.cv + '.sent');
                    this.gJumpIf(stepT + '.done', after);
                    this.gEmit(g.cv + '.next=' + sentLoc + ';return ' + stepT + '.value;');
                    this.gMark(sentLoc);
                    this.gAssign(recv, g.cv + '.sent');
                    this.gJump(loopLoc);
                    this.gMark(after);
                    return stepT + '.value';
                }
                if (n.delegate) {
                    var res = this.gTemp();
                    this.gEmit('return ' + g.cv + '.delegateYield(' + arg + ',' + quote(res.slice(g.cv.length + 1)) + ',' + after + ');');
                    this.gMark(after);
                    return res;
                }
                this.gEmit(g.cv + '.next=' + after + ';return' + (arg === null ? '' : ' ' + arg) + ';');
                this.gMark(after);
                return g.cv + '.sent';
            }
            case 'ParenthesizedExpression': return this.gx(n.expression, ignore);
            case 'MemberExpression':
                if (n.object.type === 'Super') return finish(this.ctxSuper() + (n.computed ? '[' + this.gx(n.property, false) + ']' : this.tail(n)));
                return finish(this.gx(n.object, false) + (n.computed ? '[' + viaTemp(null, n.property) + ']' : this.tail(n)));
            case 'CallExpression': {
                if (n.callee.type === 'Super' || n.optional) throw new Unsupported('yield in super()/optional call');
                var callee = n.callee, argsLeap = anyLeap(n.arguments), spread = hasSpread(n.arguments), calleeCode, thisVal = null;
                if (callee.type === 'MemberExpression' && callee.object.type === 'Super') {
                    calleeCode = this.ctxSuper() + (callee.computed ? '[' + viaTemp(null, callee.property) + ']' : this.tail(callee));
                    thisVal = this.thisCode();
                } else if (callee.type === 'MemberExpression' && (argsLeap || spread)) {
                    // the object is its `this`: evaluated first, kept in a temporary
                    thisVal = viaTemp(this.gTemp(), callee.object);
                    calleeCode = thisVal + (callee.computed ? '[' + viaTemp(null, callee.property) + ']' : this.tail(callee));
                } else if (callee.type === 'MemberExpression') calleeCode = this.gx(callee, false);
                else {
                    calleeCode = viaTemp(null, callee);
                    if (/[.[]/.test(calleeCode)) calleeCode = '(0,' + calleeCode + ')';
                }
                if (spread) code = calleeCode + '.apply(' + (thisVal || 'void 0') + ',' + listCode(n.arguments) + ')';
                else if (thisVal !== null && (argsLeap || callee.object.type === 'Super')) {
                    var al = [];
                    for (i = 0; i < n.arguments.length; i++) al.push(argsLeap ? viaTemp(null, n.arguments[i]) : this.E(n.arguments[i], P_ASSIGN));
                    code = calleeCode + '.call(' + [thisVal].concat(al).join(',') + ')';
                } else {
                    var a2 = [];
                    for (i = 0; i < n.arguments.length; i++) a2.push(argsLeap ? viaTemp(null, n.arguments[i]) : this.E(n.arguments[i], P_ASSIGN));
                    code = calleeCode + '(' + a2.join(',') + ')';
                }
                return finish(code);
            }
            case 'NewExpression': {
                var nc = viaTemp(null, n.callee);
                if (hasSpread(n.arguments)) return finish(this.h('__br_new') + '(' + nc + ',' + listCode(n.arguments) + ')');
                var na = [];
                for (i = 0; i < n.arguments.length; i++) na.push(viaTemp(null, n.arguments[i]));
                return finish('new (' + nc + ')(' + na.join(',') + ')');
            }
            case 'ArrayExpression': return finish(listCode(n.elements));
            case 'ObjectExpression': {
                var head = [], tail = [], dyn = false;
                for (i = 0; i < n.properties.length; i++) {
                    var pr = n.properties[i];
                    if (pr.type === 'SpreadElement') { dyn = true; tail.push('null', viaTemp(null, pr.argument), '3'); continue; }
                    var kind = pr.kind === 'get' ? 1 : pr.kind === 'set' ? 2 : 0;
                    var key = pr.computed ? viaTemp(null, pr.key) : pr.key.type === 'Identifier' ? quote(pr.key.name) : quote(String(pr.key.value));
                    var val = kind || pr.method ? this.func(pr.value, 'method', null, { superRef: 'Object.getPrototypeOf(this)' }) : viaTemp(null, pr.value);
                    if (pr.computed) dyn = true;
                    if (!dyn && !kind) head.push(key + ':' + val); else { dyn = true; tail.push(key, val, String(kind)); }
                }
                code = '{' + head.join(',') + '}';
                return finish(tail.length ? this.h('__br_props') + '(' + code + ',[' + tail.join(',') + '])' : code);
            }
            case 'TemplateLiteral': {
                var q = n.quasis, parts = [];
                for (i = 0; i < n.expressions.length; i++) { parts.push(viaTemp(null, n.expressions[i])); if (q[i + 1].value.cooked) parts.push(quote(q[i + 1].value.cooked)); }
                return finish(quote(q[0].value.cooked) + '.concat(' + parts.join(',') + ')');
            }
            case 'SequenceExpression': {
                for (i = 0; i < n.expressions.length - 1; i++) this.gx(n.expressions[i], true);
                return this.gx(n.expressions[n.expressions.length - 1], ignore);
            }
            case 'LogicalExpression': {
                after = this.gLoc();
                result = ignore ? null : this.gTemp();
                var left = viaTemp(result, n.left);
                if (n.operator === '&&') this.gJumpIfNot(left, after);
                else if (n.operator === '||') this.gJumpIf(left, after);
                else this.gJumpIf(left + '!=null', after);
                viaTemp(result, n.right, ignore);
                this.gMark(after);
                return result;
            }
            case 'ConditionalExpression': {
                elseLoc = this.gLoc(); after = this.gLoc();
                this.gJumpIfNot(this.gx(n.test, false), elseLoc);
                result = ignore ? null : this.gTemp();
                viaTemp(result, n.consequent, ignore);
                this.gJump(after);
                this.gMark(elseLoc);
                viaTemp(result, n.alternate, ignore);
                this.gMark(after);
                return result;
            }
            case 'UnaryExpression':
                if (n.operator === 'typeof' && n.$typeofSym) return finish(this.h('__br_typeof') + '(' + this.gx(n.argument, false) + ')');
                return finish(n.operator + (/^[a-z]/.test(n.operator) ? ' ' : '') + this.gx(n.argument, false));
            case 'BinaryExpression': {
                var l = viaTemp(null, n.left), r = viaTemp(null, n.right);
                if (n.$in) return finish(this.h('__br_in') + '(' + l + ',' + r + ')');
                if (n.$inst) return finish(this.h('__br_instanceof') + '(' + l + ',' + r + ')');
                return finish(n.operator === '**' ? 'Math.pow(' + l + ',' + r + ')' : l + ' ' + n.operator + ' ' + r);
            }
            case 'UpdateExpression': return finish(n.prefix ? n.operator + this.gx(n.argument, false) : this.gx(n.argument, false) + n.operator);
            case 'AssignmentExpression': {
                var op = n.operator, lhs;
                if (n.left.type === 'ObjectPattern' || n.left.type === 'ArrayPattern') {
                    var t = this.gAssign(this.gTemp(), this.gx(n.right, false)), outl = [];
                    this.destructure(n.left, t, outl, 'assign');
                    this.gEmit(outl.join(',') + ';');
                    return ignore ? null : t;
                }
                if (op === '||=' || op === '&&=' || op === '??=') {
                    // the target's parts first, its value tested, the right side only when it is assigned
                    var ref;
                    if (n.left.type === 'MemberExpression') {
                        var objT = n.left.object.type === 'Super' ? this.ctxSuper() : viaTemp(this.gTemp(), n.left.object);
                        ref = objT + (n.left.computed ? '[' + viaTemp(this.gTemp(), n.left.property) + ']' : this.tail(n.left));
                    } else ref = this.E(n.left, P_CALL);
                    after = this.gLoc();
                    result = this.gAssign(this.gTemp(), ref);
                    if (op === '||=') this.gJumpIf(result, after);
                    else if (op === '&&=') this.gJumpIfNot(result, after);
                    else this.gJumpIf(result + '!=null', after);
                    this.gAssign(result, ref + '=' + this.gx(n.right, false));
                    this.gMark(after);
                    return ignore ? null : result;
                }
                lhs = n.left.type === 'MemberExpression' ? (n.left.object.type === 'Super' ? this.ctxSuper() : viaTemp(null, n.left.object)) + (n.left.computed ? '[' + viaTemp(null, n.left.property) + ']' : this.tail(n.left)) : this.E(n.left, P_CALL);
                if (op === '=') return finish(lhs + '=' + this.gx(n.right, false));
                var saved = this.gAssign(this.gTemp(), lhs), rhs = this.gx(n.right, false);
                return finish(lhs + '=' + (op === '**=' ? 'Math.pow(' + saved + ',' + rhs + ')' : saved + ' ' + op.slice(0, -1) + ' ' + rhs));
            }
            case 'ChainExpression': {
                // (await x)?.y: only the start of the chain may wait
                var base = n.expression, linkLeap = false;
                while (base.type === 'MemberExpression' || base.type === 'CallExpression') {
                    if (base.type === 'MemberExpression' ? base.computed && containsLeap(base.property) : anyLeap(base.arguments)) linkLeap = true;
                    base = base.type === 'MemberExpression' ? base.object : base.callee;
                }
                if (!linkLeap) return finish(this.chain(n.expression, null, viaTemp(null, base)));
                // a link waits: the chain step by step, every value in a temporary (in evaluation order), a nullish
                // value before an optional link jumps to the undefined result
                if (base.type === 'Super') throw new Unsupported('yield inside an optional chain on super');
                var links = [], ln = n.expression, obj = null;
                while (ln.type === 'MemberExpression' || ln.type === 'CallExpression') { links.unshift(ln); ln = ln.type === 'MemberExpression' ? ln.object : ln.callee; }
                var chainOut = this.gTemp(), nullLoc = this.gLoc(), endLoc = this.gLoc(), cur = viaTemp(this.gTemp(), base);
                for (i = 0; i < links.length; i++) {
                    var lk = links[i];
                    if (lk.optional) this.gJumpIf(cur + '==null', nullLoc);
                    if (lk.type === 'MemberExpression') {
                        obj = cur;
                        cur = this.gAssign(this.gTemp(), cur + (lk.computed ? '[' + viaTemp(null, lk.property) + ']' : this.tail(lk)));
                        continue;
                    }
                    var callCode;
                    if (hasSpread(lk.arguments)) callCode = cur + '.apply(' + (obj !== null ? obj : 'void 0') + ',' + listCode(lk.arguments) + ')';
                    else {
                        var cargs = [];
                        for (var ai = 0; ai < lk.arguments.length; ai++) cargs.push(viaTemp(null, lk.arguments[ai]));
                        callCode = obj !== null ? cur + '.call(' + [obj].concat(cargs).join(',') + ')' : cur + '(' + cargs.join(',') + ')';
                    }
                    cur = this.gAssign(this.gTemp(), callCode);
                    obj = null;
                }
                this.gAssign(chainOut, cur);
                this.gJump(endLoc);
                this.gMark(nullLoc);
                this.gAssign(chainOut, 'void 0');
                this.gMark(endLoc);
                return finish(chainOut);
            }
        }
        throw new Unsupported('yield in ' + n.type);
    };

    // ------------------------------------------------------------------------------------------------ fast tokens
    // acorn's tokenizer on the old engine costs 5 to 14 us a token (twitch.js, 355k tokens: 4.8 s of its 10.7 s parse),
    // a lexer keeping its state in locals 0.8 us: every character goes through method calls and properties of the
    // parser there. nextToken gets a fast way for the common tokens (ASCII names and keywords, punctuation, plain
    // strings and numbers, spaces and comments) that ends in the state acorn's own methods leave; anything else (escapes,
    // other characters, templates, regular expressions, operators, a parser keeping locations or comments) is left to
    // them. Only for the acorn these paths were checked against (tools/fast-tokens-test.html compares tokens and trees).
    var fastTokens = function (acorn) {
        var P = acorn && acorn.Parser && acorn.Parser.prototype;
        if (!P || P.__brFastTokens || acorn.version !== '8.14.0' || !acorn.tokTypes || !acorn.keywordTypes) return;
        var tt = acorn.tokTypes, kwTypes = acorn.keywordTypes, origNextToken = P.nextToken, origSkipSpace = P.skipSpace;
        // (a regular expression without the u or v flag is not checked here: the engine the lowered script goes to
        // judges it anyway, and acorn's check runs in script, 55 ms for twitch.tv's 4 KB list of React prop names; with
        // those flags it is, jsfix lowers what they mean)
        var origValidate = P.validateRegExpPattern;
        if (origValidate) P.validateRegExpPattern = function (state) { if (state.switchU || state.switchV) return origValidate.call(this, state); };
        var NAME = tt.name, DOT = tt.dot, STRING = tt.string, NUM = tt.num, EOF = tt.eof;
        var PUNCT = [];
        PUNCT[40] = tt.parenL; PUNCT[41] = tt.parenR; PUNCT[59] = tt.semi; PUNCT[44] = tt.comma; PUNCT[91] = tt.bracketL;
        PUNCT[93] = tt.bracketR; PUNCT[123] = tt.braceL; PUNCT[125] = tt.braceR; PUNCT[58] = tt.colon;
        // (the words any of acorn's keyword lists has: only these are asked of the parser's own list)
        var kwCandidate = function (w) {
            switch (w.length) {
                case 2: return w === 'if' || w === 'in' || w === 'do';
                case 3: return w === 'var' || w === 'new' || w === 'for' || w === 'try';
                case 4: return w === 'this' || w === 'null' || w === 'true' || w === 'else' || w === 'case' || w === 'void' || w === 'with';
                case 5: return w === 'false' || w === 'break' || w === 'const' || w === 'class' || w === 'throw' || w === 'while' || w === 'catch' || w === 'super';
                case 6: return w === 'return' || w === 'typeof' || w === 'delete' || w === 'switch' || w === 'export' || w === 'import';
                case 7: return w === 'default' || w === 'finally' || w === 'extends';
                case 8: return w === 'function' || w === 'continue' || w === 'debugger';
                case 10: return w === 'instanceof';
            }
            return false;
        };
        // finishToken and updateContext without locations
        var finish = function (p, type, val) {
            p.end = p.pos;
            var prevType = p.type, update;
            p.type = type;
            p.value = val;
            if (type.keyword && prevType === DOT) p.exprAllowed = false;
            else if ((update = type.updateContext)) update.call(p, prevType);
            else p.exprAllowed = type.beforeExpr;
        };
        // (tt.name's updateContext)
        var finishName = function (p, word) {
            p.end = p.pos;
            var prevType = p.type, allowed = false;
            p.type = NAME;
            p.value = word;
            if (p.options.ecmaVersion >= 6 && prevType !== DOT) {
                if (word === 'of' && !p.exprAllowed || word === 'yield' && p.inGeneratorContext()) allowed = true;
            }
            p.exprAllowed = allowed;
        };
        P.nextToken = function () {
            var stack = this.context, cur = stack[stack.length - 1], opts = this.options;
            if (opts.locations || opts.onComment) return origNextToken.call(this);
            var input = this.input, len = input.length, pos = this.pos, c, e;
            if (!cur || !cur.preserveSpace) {
                while (pos < len) {
                    c = input.charCodeAt(pos);
                    if (c === 32 || (c > 8 && c < 14)) { pos++; continue; }
                    if (c === 47) {
                        e = input.charCodeAt(pos + 1);
                        if (e === 42) {
                            e = input.indexOf('*/', pos + 2);
                            if (e < 0) { this.pos = pos; origSkipSpace.call(this); pos = this.pos; break; }   // (acorn's error)
                            pos = e + 2;
                            continue;
                        }
                        if (e === 47) {
                            for (pos += 2; pos < len; pos++) { c = input.charCodeAt(pos); if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) break; }
                            continue;
                        }
                        break;
                    }
                    // (other space: acorn's own way on from here)
                    if (c >= 128) { this.pos = pos; origSkipSpace.call(this); pos = this.pos; }
                    break;
                }
            }
            this.pos = pos;
            this.start = pos;
            if (pos >= len) return finish(this, EOF, undefined);
            if (cur.override) return cur.override(this);
            c = input.charCodeAt(pos);
            if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95) {
                for (e = pos + 1; e < len; e++) {
                    c = input.charCodeAt(e);
                    if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 36 || c === 95)) break;
                }
                // (an escape or another character in the name: acorn's readWord)
                if (e < len && (c === 92 || c >= 128)) return this.readWord();
                var word = input.slice(pos, e);
                this.pos = e;
                this.containsEsc = false;
                if (e - pos > 1 && kwCandidate(word) && this.keywords.test(word)) return finish(this, kwTypes[word], word);
                return finishName(this, word);
            }
            var type = c < 128 ? PUNCT[c] : undefined;
            if (type !== undefined) { this.pos = pos + 1; return finish(this, type, undefined); }
            if (c === 34 || c === 39) {
                for (e = pos + 1; e < len; e++) {
                    var q = input.charCodeAt(e);
                    if (q === c) break;
                    if (q === 92 || q === 10 || q === 13 || q === 0x2028 || q === 0x2029) return this.readString(c);
                }
                if (e >= len) return this.readString(c);   // (acorn's error)
                this.pos = e + 1;
                return finish(this, STRING, input.slice(pos + 1, e));
            }
            if (c === 46) {
                e = input.charCodeAt(pos + 1);
                if (e !== 46 && !(e >= 48 && e <= 57)) { this.pos = pos + 1; return finish(this, DOT, undefined); }
                return this.getTokenFromCode(c);
            }
            if (c >= 48 && c <= 57) {
                for (e = pos + 1; e < len; e++) { c = input.charCodeAt(e); if (!(c >= 48 && c <= 57)) break; }
                // (not a plain decimal integer: a fraction, exponent, BigInt, separator, prefix, legacy octal, or a
                // name right after it)
                if ((e < len && ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 46 || c === 36 || c === 95 || c === 92 || c >= 128)) ||
                    (e - pos > 1 && input.charCodeAt(pos) === 48)) return this.getTokenFromCode(input.charCodeAt(pos));
                this.pos = e;
                return finish(this, NUM, parseFloat(input.slice(pos, e)));
            }
            if (c === 92) return this.readWord();   // (a name starting with an escape)
            if (c < 128) return this.getTokenFromCode(c);
            return this.readToken(this.fullCharCodeAtPos());
        };
        P.__brFastTokens = true;
    };

    // ------------------------------------------------------------------------------------------------ entry points
    // onFunction(node, strict, inClass): every `function` and arrow as soon as the parser completed it (the parser's
    // strictness is the surrounding code's again by then)
    // isl: where the parser skips (see islands): function bodies and runs of statements the engine takes as they are
    // are not parsed (isl.last: the start of the last one skipped)
    var parse = function (src, module, onFunction, onImport, isl) {
        var acorn = root.acorn;
        if (!acorn || !acorn.parse) throw new Unsupported('acorn missing');
        if (root.__brFastTokens !== false) fastTokens(acorn);
        var options = { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script', allowHashBang: true, allowReturnOutsideFunction: !module,
                        allowReserved: true, locations: false };
        if (!onFunction) return acorn.parse(src, options);
        var p = new acorn.Parser(options, src), classes = 0;
        if (isl) {
            var tt = acorn.tokTypes;
            // (the tokenizer goes on at the closing brace or semicolon: reading it leaves the context as parsing would)
            var jump = function (parser, end, type) {
                parser.pos = end - 1;
                parser.next();
                if (parser.type !== type || parser.start !== end - 1) throw new Unsupported('island-skip');
                parser.next();
            };
            p.__brParseFunctionBody = p.parseFunctionBody;
            // (never the body of an async function or a generator: the engine took the text after its `async`, and the
            // function must become a state machine; instagram.com's `async function(t,n,r){s(...)}` stayed so)
            p.parseFunctionBody = function (node, isArrowFunction, isMethod, forInit) {
                var end = !isArrowFunction && !isMethod && !node.async && !node.generator && this.type === tt.braceL && hasOwn.call(isl.fn, this.start) ? isl.fn[this.start] : 0;
                if (!end) return this.__brParseFunctionBody(node, isArrowFunction, isMethod, forInit);
                var body = this.startNode();
                body.body = [];
                isl.last = this.start;
                jump(this, end, tt.braceR);
                node.body = this.finishNode(body, 'BlockStatement');
                node.expression = false;
                node.$skipped = true;
                this.exitScope();
            };
            // (a statement whose first token changed the tokenizer's context is parsed: see islandStatements)
            p.__brParseStatement = p.parseStatement;
            p.parseStatement = function (context, topLevel, exports) {
                var end = hasOwn.call(isl.stmt, this.start) ? isl.stmt[this.start] : 0, type = this.type;
                if (!end || type === tt.parenL || type === tt.braceL || type === tt.backQuote || type === tt._function || type === tt._class) return this.__brParseStatement(context, topLevel, exports);
                var node = this.startNode();
                isl.last = this.start;
                jump(this, end, tt.semi);
                return this.finishNode(node, 'BrRawStatement');
            };
        }
        p.__brParseFunction = p.parseFunction;
        p.__brParseArrow = p.parseArrowExpression;
        p.__brParseClass = p.parseClass;
        p.parseClass = function (node, isStatement) {
            var n;
            classes++;
            try { n = this.__brParseClass(node, isStatement); } finally { classes--; }
            onFunction(n, this.strict, classes > 0);
            return n;
        };
        p.parseFunction = function (node, statement, allowExpressionBody, isAsync, forInit) {
            var n = this.__brParseFunction(node, statement, allowExpressionBody, isAsync, forInit);
            onFunction(n, this.strict, classes > 0);
            return n;
        };
        p.parseArrowExpression = function (node, params, isAsync, forInit) {
            var n = this.__brParseArrow(node, params, isAsync, forInit);
            onFunction(n, this.strict, classes > 0);
            return n;
        };
        if (onImport) {
            p.__brParseImport = p.parseImport;
            p.parseImport = function (node) { var n = this.__brParseImport(node); onImport(n); return n; };
        }
        return p.parse();
    };
    // free references to Proxy get the stand-in, except `typeof Proxy`: a library that looks first keeps its own way
    // without it (a bundle often holds both kinds)
    // (Proxy.revocable: Immer makes every draft with it)
    // (globalThis.BigInt(...) and the like count too: see $standin)
    var GLOBAL_OBJECTS = { globalThis: 1, window: 1, self: 1 };
    var PROXY_USE = /\bnew\s+Proxy\s*\(|(?:^|[^.\w$])Proxy\s*\.\s*revocable\s*\(/, BIGINT_USE = /(?:^|[^.\w$])(?:(?:globalThis|window|self)\s*\.\s*)?BigInt\s*[(.]/, DIRECT_EVAL = /(?:^|[^.\w$])eval\s*\(/;
    var BIGINT_TEXT = /(^|[^.\w$])(?:(?:globalThis|window|self)\s*\.\s*)?BigInt(\s*[(.])/g;
    var needsProxy = function (src) { return typeof root.Proxy !== 'function' && PROXY_USE.test(src); };
    var needsBigInt = function (src) { return typeof root.BigInt !== 'function' && BIGINT_USE.test(src); };
    // delete el.dataset.x in a script the engine takes as it is (see __br_dsdel; DuckDuckGo's Next.js chunks are ES5
    // and do it at start): a target of plain names goes through the helper in the text
    var DS_DELETE = /(^|[^\w$.])delete\s+((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*\.\s*dataset\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[([^\[\]\n]+)\])(?!\s*[.\[(\w$])/g;
    // this.constructor in a script the engine takes as it is that defines custom elements (TikTok's cookie banner, Lit
    // compiled to ES5 by Babel: this.constructor.elementProperties was undefined): the old engine answers an element's
    // interface constructor there (see __br_ctor), so the reads go through the helper in the text. Not an assignment
    // or a call of it.
    var CTOR_THIS = /(^|[^.\w$])this\s*\.\s*constructor\b(?!\s*(?:=(?!=)|\(|\+\+|--))/g;
    var needsCtor = function (src) {
        if (src.indexOf('customElements') < 0 || src.indexOf('constructor') < 0) return false;
        CTOR_THIS.lastIndex = 0;
        var found = CTOR_THIS.test(src);
        CTOR_THIS.lastIndex = 0;
        return found;
    };
    var ctorReads = function (src) {
        CTOR_THIS.lastIndex = 0;
        return src.replace(CTOR_THIS, '$1__br_ctor(this)');
    };
    var needsDsDelete = function (src) {
        if (src.indexOf('dataset') < 0) return false;
        DS_DELETE.lastIndex = 0;
        var found = DS_DELETE.test(src);
        DS_DELETE.lastIndex = 0;
        return found;
    };
    var dsDeletes = function (src) {
        DS_DELETE.lastIndex = 0;
        return src.replace(DS_DELETE, function (whole, head, target, name, key) {
            return head + '__br_dsdel(' + target + ',' + (name ? quote(name) : '(' + key + ')') + ')';
        });
    };
    // `key in obj` in a script the engine takes as it is that makes symbols (YouTube's es5 build tests `_.lsa in a` with
    // a symbol of core-js, whose setter on Object.prototype answers that for every object: its signals saw a reactive
    // context everywhere and threw "[Patch failed]", m.youtube.com stayed blank): a key and an object of plain names,
    // the test standing on its own (an operator of lower precedence or the end of an expression around it), go through
    // __br_in in the text. Not the head of a for-in; and only a key that looks like minified code (a name with . _ $ or
    // of two letters at most), so that words in strings stay as they are ("(only in English)").
    var SYM_IN = /([(,&|?:=;{}\[]|\breturn\s)(\s*)((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s+in\s+((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)(?=\s*(?:[)\];,:?}]|&&|\|\||[!=]==?|$))/g;
    var SYM_IN_KEYWORDS = { 'typeof': 1, 'void': 1, 'delete': 1, 'new': 1, 'in': 1, 'instanceof': 1, 'var': 1, 'let': 1, 'const': 1, 'return': 1, 'this': 0 };
    var needsSymIn = function (src) {
        if (src.indexOf('Symbol(') < 0 || src.indexOf(' in ') < 0) return false;
        SYM_IN.lastIndex = 0;
        var found = SYM_IN.test(src);
        SYM_IN.lastIndex = 0;
        return found;
    };
    var symIns = function (src) {
        SYM_IN.lastIndex = 0;
        return src.replace(SYM_IN, function (whole, head, space, key, obj, at) {
            if (SYM_IN_KEYWORDS[key] || SYM_IN_KEYWORDS[obj]) return whole;
            if (key.length > 2 && !/[._$]/.test(key)) return whole;
            // (for (k in o) / for (var k in o): a loop, not a test)
            if (head === '(' && /\bfor\s*$/.test(src.slice(Math.max(0, at - 8), at))) return whole;
            return head + space + '__br_in(' + key + ',' + obj + ')';
        });
    };
    // a script the engine parses that only needs the stand-ins: `new Proxy(` / `BigInt(` replaced in the text (no
    // parse of a big bundle for that), unless the script has a Proxy or BigInt of its own
    var STANDIN_OWN = /\b(?:class|function|var|let|const)\s+(?:Proxy|BigInt)\b|[(,]\s*(?:Proxy|BigInt)\s*[,)=]/;
    // framer-motion (motion.div, m.span...) looks first, `if ("u" < typeof Proxy) return fallback;` right before
    // `return new Proxy(factory, { get })`, and that fallback has no motion.div: React then fails with "element type is
    // invalid" and a Next.js page is replaced by its error page (nextjs.org). A guard like that, with the proxy right
    // after it, asks about the stand-in instead, so the proxy path runs (typeof Proxy elsewhere stays the engine's).
    var PROXY_GUARD = /(if\s*\(\s*)((["'])(?:u|undefined)\3\s*(?:<|===?)\s*typeof\s+Proxy\b|typeof\s+Proxy\s*(?:>|===?)\s*(["'])(?:u|undefined)\4)(\s*\)\s*return\b)/g;
    // Immer 6 to 9 decide at start whether they draft with proxies (`typeof Proxy !== "undefined" && typeof
    // Proxy.revocable !== "undefined" && ...`) and otherwise take their ES5 plugin, getPlugin("ES5"), which an app has
    // only when it loads it: without it every produce() threw "[Immer] minified error nr: 18 'ES5'" (regiojet.cz
    // showed its error page). In a script that asks for that plugin and does not register it (loadPlugin("ES5",
    // {...})), a check that Proxy exists followed by one of Proxy.revocable asks about the stand-in, made for Immer's
    // drafts; its Proxy.revocable is retargeted in the text too (the path that replaces only calls leaves it), in the
    // form that works before the helper text has run.
    var PROXY_REVOCABLE_GUARD = /((["'])(?:u|undefined)\2\s*(?:!==?|>)\s*typeof\s+Proxy\b|typeof\s+Proxy\s*(?:!==?|<)\s*(["'])(?:u|undefined)\3)(\s*&&(?:[^&|;,?:(){}]{0,40}?[^.\w$])?)Proxy\s*\.\s*revocable\b/g;
    var IMMER_ES5_USE = /\(\s*(["'])ES5\1\s*\)/, IMMER_ES5_PLUGIN = /\(\s*(["'])ES5\1\s*,/;
    var retargetProxyGuards = function (src) {
        if (src.indexOf('typeof') < 0 || !PROXY_USE.test(src)) return src;
        PROXY_GUARD.lastIndex = 0;
        src = src.replace(PROXY_GUARD, function (whole, head, guard, q1, q2, tail, offset, all) {
            var after = all.slice(offset + whole.length, offset + whole.length + 600);
            if (!/\bnew\s+Proxy\s*\(/.test(after)) return whole;
            return head + guard.replace(/typeof\s+Proxy/, 'typeof __br_Proxy') + tail;
        });
        if (src.indexOf('ES5') < 0 || !IMMER_ES5_USE.test(src) || IMMER_ES5_PLUGIN.test(src)) return src;
        PROXY_REVOCABLE_GUARD.lastIndex = 0;
        return src.replace(PROXY_REVOCABLE_GUARD, function (whole, guard, q1, q2, mid) {
            return guard.replace(/typeof\s+Proxy/, 'typeof __br_Proxy') + mid + "__br_Proxy('revocable')";
        });
    };
    var helperText = function (names) {
        var out = '', seen = {};
        var add = function (n) {
            if (seen[n]) return;
            seen[n] = 1;
            var deps = RUNTIME_DEPS[n] || [];
            for (var i = 0; i < deps.length; i++) add(deps[i]);
            var s = String(RUNTIME[n]);
            out += 'function ' + n + s.slice(s.indexOf('(')) + '\n';
            if (n === '__br_BigInt') out += '__br_BigInt(0);\n';
            if (n === '__br_Proxy') out += '__br_Proxy();\n';
        };
        for (var i = 0; i < names.length; i++) add(names[i]);
        return out;
    };
    // Big scripts are lowered function by function while they are parsed: the whole tree of a 1.5 MB bundle took
    // over 100 MB in the old engine (the app is killed at about 330 MB). A completed function or class of EARLY_FN
    // characters or more is analysed and printed on its own and only its text stays in the tree; arrows that use
    // super or new.target and functions with private names inside a class body wait for the code around them.
    // (YouTube's base.js, 1.5 MB: the whole tree is 380k nodes; with units from 64 characters on, the biggest unit
    // holds 36k, and the run is no slower)
    var EARLY_SCRIPT = 96 * 1024, EARLY_FN = 64, MEMORY_FLOOR_MB = 40;
    var EARLY_ARROW_SKIP = /\bsuper\b|\bnew\s*\.\s*target\b/g;
    var positions = function (src, re) {
        var out = [], m;
        re.lastIndex = 0;
        while ((m = re.exec(src)) !== null) out.push(m.index);
        return out;
    };
    // whether a sorted position list has one in [start, end)
    var occursIn = function (list, start, end) {
        var lo = 0, hi = list.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (list[mid] < start) lo = mid + 1; else hi = mid; }
        return lo < list.length && list[lo] < end;
    };
    var lower = function (src, opts, early, isl) {
        var module = !!opts.module;
        var w = new Walker(src);
        w.proxyShim = opts.proxy !== undefined ? !!opts.proxy : needsProxy(src);
        w.bigintShim = opts.bigint !== undefined ? !!opts.bigint : typeof root.BigInt !== 'function';
        if (module) w.mod = { deps: [], depIndex: {}, exports: [], stars: [] };
        var printer = new Printer(src, w, opts), onFunction = null, onImport = null, units = 0, checked = 0;
        if (early === false) isl = null;
        if (isl) {
            isl.last = -1;
            // every name this adds has a $ in it (x$1, _this$ab12): the skipped functions' names with one are taken
            var dollars = src.match(/[\w$]*\$[\w$]*/g) || [];
            for (var di = 0; di < dollars.length; di++) w.names['$' + dollars[di]] = 1;
        }
        // (the app's engines have __brAvailableMB: a lowering that would exhaust the iPad gives up, the script stays
        // as it is and the app survives)
        var floor = opts.memoryFloor || MEMORY_FLOOR_MB;
        var roomCheck = function () {
            if (typeof root.__brAvailableMB === 'function' && root.__brAvailableMB() < floor) throw new Unsupported('memory');
        };
        if (early !== false) {
            var supers = null, hashes = null;
            if (module) {
                // the imports as the parser meets them (bundlers interleave them with exports: a function lowered before
                // an import it uses is analysed again at the end, see resolveRefs)
                w.earlyRoot = new Scope('program', null, null, true);
                onImport = function (n) { w.moduleDecl(n, w.earlyRoot); };
            }
            onFunction = function (n, strict, inClass) {
                if ((++checked & 15) === 0) roomCheck();
                if (n.$skipped) { w.skipped(n, strict); return; }
                if (n.end - n.start < early) return;
                // (one around code the parser skipped is analysed with the code around it: see W.skippedRefs)
                if (isl && isl.last >= n.start) return;
                if (n.type === 'FunctionDeclaration' && !n.id) return;   // (export default function () {}: moduleCode names it)
                // (positions of every super/new.target and #, found once: a binary search per function instead of a
                // copy of its text)
                if (n.type === 'ArrowFunctionExpression' && occursIn(supers || (supers = positions(src, EARLY_ARROW_SKIP)), n.start, n.end)) return;
                if (inClass && occursIn(hashes || (hashes = positions(src, /#/g)), n.start, n.end)) return;
                w.early(n, strict, printer);
                units++;
                stats.early++;
            };
        }
        // (stats.phases: parse with the early units / walk / resolve / print, ms of the last run)
        var t0 = new Date().getTime();
        var ast = parse(src, module, onFunction, onImport, isl);
        // (a group of a script lowered on its own, see pieces)
        if (opts.flatTop) for (var fi = 0; fi < ast.body.length; fi++) if (blockDecl(ast.body[fi])) throw new Unsupported('flat-top');
        roomCheck();
        var ps = new Scope('program', null, ast, module || hasUseStrict(ast.body)), v0 = w.visits, t1 = new Date().getTime();
        w.stmts(ast.body, ast, ps, false);
        stats.outer = w.visits - v0;
        if (w.module && !module) throw new Unsupported('module');
        var t2 = new Date().getTime();
        roomCheck();
        w.resolve(ast);
        roomCheck();
        var t3 = new Date().getTime(), out = null;
        if (module) out = printer.moduleCode(ast, w);
        else {
            var dirty = false;
            for (var i = 0; i < ast.body.length; i++) if (ast.body[i].$d) { dirty = true; break; }
            if (dirty) out = printer.programCode(ast);
        }
        stats.phases = [t1 - t0, t2 - t1, t3 - t2, new Date().getTime() - t3].join('/');
        return out;
    };
    // the ES5 text for src; null when nothing needs lowering. Throws Unsupported for what it cannot do.
    // opts.module: src is an ES module; the result is its __brModules.define(opts.url, ...) registration
    // opts.early: false, or the size from which functions are lowered while parsing (default: EARLY_FN for big scripts)
    // skip: see islands (positions in src as it comes, which must not change here then)
    var transpile = function (src, opts, skip) {
        opts = opts || {};
        if (!skip && (opts.proxy !== undefined ? opts.proxy : needsProxy(src))) src = retargetProxyGuards(src);
        var early = opts.early !== undefined ? opts.early : src.length >= EARLY_SCRIPT ? EARLY_FN : false;
        // (a script with its own Proxy/BigInt needs every scope)
        if (early !== false && (STANDIN_OWN.test(src) || !root.acorn || !root.acorn.Parser)) early = false;
        if (early === false) return lower(src, opts, false);
        if (skip) {
            var again = stats.stmtAgain;
            try {
                var isl = lower(src, opts, early, skip);
                if (stats.stmtAgain > again) stats.note += ', ' + (stats.stmtAgain - again) + ' statements parsed again';
                return isl;
            } catch (ei) {
                // (the scanner went wrong somewhere, or what went wrong has nothing to do with islands: as usual)
                if (ei instanceof Unsupported && ei.what === 'memory') throw ei;
                stats.islandFallbacks++;
                stats.note = 'islands failed (' + ((ei && (ei.message || ei.what)) || String(ei)).slice(0, 80) + '), lowered as a whole';
            }
        }
        try { return lower(src, opts, early); } catch (e) {
            // a function lowered early uses a name the code around it renames afterwards (or needs more of the
            // context than a stand-in gives): the whole tree at once
            if (!(e instanceof Unsupported) || !/^early-/.test(e.what)) throw e;
            stats.fallbacks++;
            stats.fallbackWhy = e.what;
            return lower(src, opts, false);
        }
    };
    // (the engine's own constructor: in a page, Function is the shim that lowers what the engine refuses)
    var engineParses = function (src) {
        var F = root.Function.__brNative || root.Function;
        try { F(src); return true; } catch (e) { return false; }
    };
    // ---- Islands. An "ES5" bundle the engine refuses for a few pieces of newer syntax (a library its build did not
    // lower: seznam.cz's 4.4 MB client-bundle.es5.min.js carries Redux 5) is lowered only where it needs it: a function
    // the engine takes as it is keeps its text and is not even parsed. (acorn over that whole bundle took 52 s and
    // 130 MB on the iPad, and the bundle differs a little from one request to the next: the cache did not help.)
    var ISLAND_SCRIPT = 192 * 1024;
    var SCAN_REGEX_AFTER = { 'return': 1, 'typeof': 1, 'instanceof': 1, 'in': 1, 'of': 1, 'new': 1, 'delete': 1, 'void': 1, 'throw': 1,
                             'case': 1, 'do': 1, 'else': 1, 'yield': 1, 'await': 1 };
    var SCAN_BODY = 1000000;   // (a stack entry above this: the body of function <entry - SCAN_BODY>)
    // the lexer's classes of ASCII characters: 0 other punctuation, 1 space, 2 word (or number), 3 /, 4 quote, 5 `,
    // 6 opening bracket, 7 closing bracket, 8 ;, 9 ., 10 + or -; KW_FIRST: first letters of the words it looks at
    var SCAN_CLASS = [], SCAN_KW_FIRST = [];
    (function () {
        var c;
        for (c = 0; c < 128; c++) { SCAN_CLASS[c] = c <= 32 ? 1 : (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 2 : 0; SCAN_KW_FIRST[c] = 0; }
        SCAN_CLASS[36] = SCAN_CLASS[95] = SCAN_CLASS[92] = 2;
        SCAN_CLASS[47] = 3; SCAN_CLASS[34] = SCAN_CLASS[39] = 4; SCAN_CLASS[96] = 5;
        SCAN_CLASS[40] = SCAN_CLASS[91] = SCAN_CLASS[123] = 6; SCAN_CLASS[41] = SCAN_CLASS[93] = SCAN_CLASS[125] = 7;
        SCAN_CLASS[59] = 8; SCAN_CLASS[46] = 9; SCAN_CLASS[43] = SCAN_CLASS[45] = 10;
        var first = 'frtionvdceya';
        for (c = 0; c < first.length; c++) SCAN_KW_FIRST[first.charCodeAt(c)] = 1;
    })();
    // every `function` of src as [keyword, its body's {, after the body's }, the function around it or -1, and the
    // positions of the semicolons ending the statements of its body], in the order they start (fns.semis: those of the
    // program), from a small lexer (strings, templates, comments, regular expressions, brackets); null when it gets
    // lost. (A function whose body it did not find keeps -1: it is parsed as usual.)
    var scanFunctions = function (src) {
        var n = src.length, i = 0, c, k, fns = [], stack = [], cur = -1, pending = -1, pendingDepth = 0, regex = true, dot = false, semis = [];
        while (i < n) {
            c = src.charCodeAt(i);
            k = c < 128 ? SCAN_CLASS[c] : c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029 ? 1 : 2;
            if (k === 2) {   // a word or a number
                var s = i;
                for (i++; i < n; i++) {
                    c = src.charCodeAt(i);
                    if (c < 128 ? SCAN_CLASS[c] !== 2 : c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029) break;
                }
                // (after a dot it is a property name)
                var word = !dot && i - s >= 2 && i - s <= 10 && SCAN_KW_FIRST[src.charCodeAt(s)] === 1 ? src.substr(s, i - s) : '';
                if (word === 'function') {
                    var w = i;
                    while (w < n && src.charCodeAt(w) <= 32) w++;
                    if (src.charCodeAt(w) !== 58) { pending = fns.length; pendingDepth = stack.length; fns.push([s, -1, -1, cur]); }   // (not {function: 1})
                }
                regex = word !== '' && SCAN_REGEX_AFTER[word] === 1;
                dot = false;
                continue;
            }
            if (k === 0) { regex = true; dot = false; i++; continue; }
            switch (k) {
                case 1: i++; continue;
                case 3: {   // /
                    var c2 = src.charCodeAt(i + 1);
                    if (c2 === 47) { for (i += 2; i < n; i++) { c = src.charCodeAt(i); if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) break; } continue; }
                    if (c2 === 42) { var ce = src.indexOf('*/', i + 2); if (ce < 0) return null; i = ce + 2; continue; }
                    dot = false;
                    if (!regex) { i++; regex = true; continue; }   // (a division)
                    var inClass = false;
                    for (i++; i < n; i++) {
                        c = src.charCodeAt(i);
                        if (c === 92) { i++; continue; }
                        if (c === 10 || c === 13) return null;
                        if (inClass) { if (c === 93) inClass = false; }
                        else if (c === 91) inClass = true;
                        else if (c === 47) break;
                    }
                    if (i >= n) return null;
                    for (i++; i < n; i++) { c = src.charCodeAt(i); if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90))) break; }
                    regex = false;
                    continue;
                }
                case 4: {   // " ' (to the next quote not escaped: an even number of backslashes before it)
                    for (var qa = i + 1;;) {
                        var qe = src.indexOf(c === 34 ? '"' : "'", qa);
                        if (qe < 0) return null;
                        var bs = qe - 1;
                        while (src.charCodeAt(bs) === 92) bs--;
                        if ((qe - 1 - bs) % 2 === 0) { i = qe + 1; break; }
                        qa = qe + 1;
                    }
                    regex = false; dot = false;
                    continue;
                }
                case 7:
                    if (c === 125 && stack.length && stack[stack.length - 1] === -1) { stack.pop(); break; }   // the } that ends a ${: the template goes on
                    if (!stack.length) return null;
                    var top = stack.pop();
                    if (top >= SCAN_BODY) {
                        if (c !== 125) return null;
                        fns[top - SCAN_BODY][2] = i + 1;
                        cur = fns[top - SCAN_BODY][3];
                    } else if (top !== (c === 41 ? 40 : c === 93 ? 91 : 123)) return null;
                    i++;
                    // (after a block a regular expression may start; an object literal before a division would be odd)
                    regex = c === 125; dot = false;
                    continue;
                case 6:   // ( [ {
                    if (c === 123 && pending >= 0 && stack.length === pendingDepth) {   // the body of the function met last
                        fns[pending][1] = i;
                        stack.push(SCAN_BODY + pending);
                        cur = pending;
                        pending = -1;
                    } else stack.push(c);
                    i++; regex = true; dot = false;
                    continue;
                case 8:   // the semicolons that end statements of a function body or of the program
                    if (!stack.length) semis.push(i);
                    else if (stack[stack.length - 1] >= SCAN_BODY) { var sf = fns[stack[stack.length - 1] - SCAN_BODY]; (sf[4] || (sf[4] = [])).push(i); }
                    i++; regex = true; dot = false;
                    continue;
                case 9: dot = src.charCodeAt(i + 1) !== 46; regex = true; i++; continue;   // (... is no member access)
                case 10:   // (a++ / 2 divides: ++ and -- leave it as it was)
                    if (src.charCodeAt(i + 1) === c) { i += 2; dot = false; continue; }
                    regex = true; dot = false; i++;
                    continue;
            }
            // ` (or a template going on after a ${...})
            for (i++; i < n; i++) {
                var t = src.charCodeAt(i);
                if (t === 92) { i++; continue; }
                if (t === 96 || (t === 36 && src.charCodeAt(i + 1) === 123)) break;
            }
            if (i >= n) return null;
            if (src.charCodeAt(i) === 96) { i++; regex = false; }
            else { stack.push(-1); i += 2; regex = true; }
            dot = false;
        }
        if (stack.length) return null;
        fns.semis = semis;
        return fns;
    };
    // why the engine refuses code, for the log: its message and the start of the line it names
    var engineError = function (code) {
        var F = root.Function.__brNative || root.Function;
        try { F(code); return 'the parser of the tests refused it'; } catch (e) {
            var line = e && e.line ? e.line : 0, at = 0;
            // (the engine counts the lines of the function it made around the code: two before it)
            for (var n = 1; n < line - 2 && at >= 0; n++) at = code.indexOf('\n', at) + 1;
            return String(e && e.message) + (line ? ' at line ' + (line - 2) + ': ' + code.slice(at, at + 160).split('\n')[0] : '');
        }
    };
    // whether the engine takes code as it is, read as strict code (what the old engine takes only in sloppy code is
    // lowered as usual); tests put an ES5 parser in root.__brES5Parses
    var engineTakes = function (code) {
        if (typeof root.__brES5Parses === 'function') return !!root.__brES5Parses(code);
        var F = root.Function.__brNative || root.Function;
        try { F(code); return true; } catch (e) { return false; }
    };
    // Pieces of code in few engine calls (ISLAND_BATCH characters each: nearly all pass): a batch refused is halved
    // until each piece is known. A function goes in as an expression, statements as the body of a function of their
    // own, so that pieces cannot combine. A piece is the text of src between its segs ([from, to, from, to...]: with a }
    // between two, an emptied function), made only for the call (a level's pieces are most of the script).
    var ISLAND_BATCH = 64 * 1024;
    var islandPiece = function (segs, stmts, extra) {
        var size = 0;
        for (var i = 0; i < segs.length; i += 2) size += segs[i + 1] - segs[i];
        var p = { segs: segs, stmts: stmts, size: size };
        for (var k in extra) if (hasOwn.call(extra, k)) p[k] = extra[k];
        return p;
    };
    var checkPieces = function (src, pieces, ok, refused) {
        var bisect = function (from, to) {
            stats.islandChecks++;
            var code = '"use strict";';
            for (var i = from; i < to; i++) {
                var p = pieces[i], s = p.segs;
                code += p.stmts ? '(function(){' : '(';
                for (var j = 0; j < s.length; j += 2) code += (j ? '}' : '') + src.slice(s[j], s[j + 1]);
                code += p.stmts ? '\n});' : '\n);';
            }
            if (engineTakes(code)) { for (i = from; i < to; i++) ok.push(pieces[i]); return; }
            if (to - from === 1) { refused.push(pieces[from]); return; }
            var mid = (from + to) >> 1;
            bisect(from, mid);
            bisect(mid, to);
        };
        for (var i = 0, j; i < pieces.length; i = j) {
            var size = 0;
            for (j = i; j < pieces.length && (j === i || size + pieces[j].size <= ISLAND_BATCH); j++) size += pieces[j].size;
            bisect(i, j);
        }
    };
    var ISLAND_PIECE = 24;
    // Where the parser may skip in src, when that is most of it: {fn: {body start: body end} of functions the engine
    // takes as they are, stmt: {start: end} of runs of statements it takes (in a function it refuses, or the program),
    // last: where the parser last skipped (see lower)}; null otherwise.
    // From the outside in: a function the engine takes is kept whole, one it refuses is looked into (its functions and
    // then its statements between semicolons, with the functions kept emptied). The old engine takes const for a var:
    // a piece with a const is refused.
    var islandSkips = function (src) {
        var t0 = new Date().getTime(), arrows = 0, re = /=>/g;
        // (today's code has arrows all over: lowered as a whole, or by the lazy chunks)
        while (re.exec(src) !== null) if (++arrows > src.length / 2048) { stats.note = 'islands: too many arrows'; return null; }
        var fns = scanFunctions(src), tScan = new Date().getTime() - t0;
        if (!fns) { stats.note = 'islands: the scan got lost'; return null; }
        var consts = positions(src, /(^|[^\w$.])const(?![\w$])/g);
        var kids = [], roots = [], state = [], i, j, k, f;   // (state: 1 kept, 2 refused)
        for (i = 0; i < fns.length; i++) {
            if (fns[i][3] < 0) roots.push(i);
            else (kids[fns[i][3]] || (kids[fns[i][3]] = [])).push(i);
        }
        var fnSkip = {}, stmtSkip = {}, spans = [], level = roots, owners = [-1], ok, refused;
        stats.islandChecks = 0;
        while (level.length || owners.length) {
            // the functions of this level
            var pieces = [], next = [];
            for (i = 0; i < level.length; i++) {
                f = fns[k = level[i]];
                if (f[1] < 0 || f[2] - f[0] < ISLAND_PIECE) continue;
                // (one holding most of the script is refused like the script itself, usually: its parts are looked at;
                // an async one too, whose `async` the piece would not hold)
                if (f[2] - f[0] >= src.length / 2 || occursIn(consts, f[0], f[2]) || asyncBefore(src, f[0])) { state[k] = 2; continue; }
                pieces.push(islandPiece([f[0], f[2]], false, { k: k }));
            }
            ok = []; refused = [];
            checkPieces(src, pieces, ok, refused);
            for (i = 0; i < ok.length; i++) { f = fns[ok[i].k]; state[ok[i].k] = 1; fnSkip[f[1]] = f[2]; spans.push([f[1], f[2]]); }
            for (i = 0; i < refused.length; i++) state[refused[i].k] = 2;
            // the statements of the functions refused a level up (their functions are known now)
            pieces = [];
            for (i = 0; i < owners.length; i++) islandStatements(src, fns, owners[i], owners[i] < 0 ? roots : kids[owners[i]] || [], state, consts, pieces);
            ok = []; refused = [];
            checkPieces(src, pieces, ok, refused);
            for (i = 0; i < ok.length; i++) { stmtSkip[ok[i].key] = ok[i].end; spans.push([ok[i].key, ok[i].end]); }
            // down a level: into the functions refused here
            owners = [];
            for (i = 0; i < level.length; i++) {
                if (state[k = level[i]] !== 2) continue;
                owners.push(k);
                var list = kids[k];
                if (list) for (j = 0; j < list.length; j++) next.push(list[j]);
            }
            level = next;
        }
        // (what the parser will not see: the spans without the ones inside others)
        spans.sort(function (a, b) { return a[0] - b[0]; });
        var bytes = 0, reach = -1;
        for (i = 0; i < spans.length; i++) {
            if (spans[i][1] <= reach) continue;
            bytes += spans[i][1] - Math.max(spans[i][0], reach);
            reach = spans[i][1];
        }
        stats.note = 'islands: ' + ((bytes / src.length * 100) | 0) + ' % of ' + (src.length >> 10) + ' KB skipped (' + fns.length + ' functions, ' + stats.islandChecks +
                     ' checks, ' + (new Date().getTime() - t0) + ' ms, scan ' + tScan + ' ms)';
        return bytes >= src.length / 2 ? { fn: fnSkip, stmt: stmtSkip, last: -1 } : null;
    };
    // pieces for the statements of function owner (-1: the program) between the semicolons ending them: runs of
    // statements the parser can skip. Not the first (directives), not one before an else (not the whole statement then),
    // not one the parser's tokenizer reads differently when it skips its first token (a (, {, `, function or class
    // there), not one with a function refused; its functions kept go in empty. Nothing in a generator or async function:
    // its body becomes a state machine.
    var asyncBefore = function (src, at) { return /async\s*$/.test(src.slice(Math.max(0, at - 12), at)); };
    var islandStatements = function (src, fns, owner, children, state, consts, pieces) {
        var f = owner < 0 ? null : fns[owner], semis = f ? f[4] : fns.semis;
        if (!semis || !semis.length) return;
        var bodyStart = f ? f[1] + 1 : 0, c = 0, start = bodyStart, i, k;
        if (f) {
            k = f[0] + 8;
            while (k < src.length && src.charCodeAt(k) <= 32) k++;
            if (src.charCodeAt(k) === 42 || asyncBefore(src, f[0])) return;
        }
        for (i = 0; i < semis.length; start = semis[i] + 1, i++) {
            var end = semis[i] + 1;
            if (start === bodyStart || end - start < ISLAND_PIECE) continue;
            // (the first token: past spaces, comments and function declarations, which are functions of their own:
            // minified code puts the next statement right after one, with no semicolon between)
            var t = start, ch;
            for (;;) {
                while (t < end && src.charCodeAt(t) <= 32) t++;
                if (src.charCodeAt(t) === 47 && src.charCodeAt(t + 1) === 42) { var ce = src.indexOf('*/', t + 2); if (ce < 0 || ce >= end) break; t = ce + 2; continue; }
                if (src.charCodeAt(t) === 47 && src.charCodeAt(t + 1) === 47) { while (t < end && src.charCodeAt(t) !== 10) t++; continue; }
                if (src.charCodeAt(t) === 102 && /^function(?![\w$])/.test(src.substr(t, 9))) {
                    while (c < children.length && fns[children[c]][0] < t) c++;
                    if (c < children.length && fns[children[c]][0] === t && fns[children[c]][2] > 0 && fns[children[c]][2] < end) { t = fns[children[c]][2]; start = t; continue; }
                }
                break;
            }
            ch = src.charCodeAt(t);
            if (t >= end - 1 || end - start < ISLAND_PIECE || ch === 40 || ch === 123 || ch === 96 || ch === 42 || /^(?:function|class)(?![\w$])/.test(src.substr(t, 9))) continue;
            var after = end;
            while (after < src.length && src.charCodeAt(after) <= 32) after++;
            if (/^else(?![\w$])/.test(src.substr(after, 5))) continue;
            if (occursIn(consts, start - 1, end)) continue;   // (a position there is the character before the word)
            // its functions: kept ones emptied, a refused one rules it out
            while (c < children.length && fns[children[c]][0] < start) c++;
            var segs = [start], bad = false;
            for (var e = c; e < children.length && fns[children[e]][0] < end; e++) {
                var g = fns[children[e]];
                if (state[children[e]] === 2) { bad = true; break; }
                if (state[children[e]] !== 1) continue;
                segs.push(g[1] + 1, g[2]);
            }
            if (bad) continue;
            segs.push(end);
            pieces.push(islandPiece(segs, true, { key: t, end: end }));
        }
    };
    // ---- Lazy modules. A webpack chunk `(self.x=self.x||[]).push([[ids],{id:factory,...}])` registers factories that
    // run only when some module requires them, and a chunk often carries big ones a page never uses (Vimeo's front
    // page loads a 3.3 MB chunk that is one module: a minute and 170 MB to lower on the iPad). Factories of LAZY_MIN
    // characters or more become stubs; the app keeps their text and lowers one when the page first calls it (a
    // synchronous request to https://ios6-browser.invalid/lazy/<key>/<n>.js, see BRCSSRewriter lazyModule).
    var LAZY_SCRIPT = 256 * 1024, LAZY_MIN = 48 * 1024;
    var LAZY_HEAD = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*(?:(?:"use strict"|'use strict')\s*;?\s*)?\(\s*(?:self|window|globalThis|this)\s*(?:\.\s*[\w$]+|\[\s*["'][\w$]+["']\s*\])\s*=\s*(?:self|window|globalThis|this)\s*(?:\.\s*[\w$]+|\[\s*["'][\w$]+["']\s*\])\s*\|\|\s*\[\s*\]\s*\)\s*\.\s*push\s*\(\s*\[\s*\[[^\]]{0,400}\]\s*,\s*\{/;
    var LAZY_REGEX_AFTER = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
    // the end of a value starting at i (the index of the `,` or `}` that ends it at its own level), -1 when lost;
    // a small lexer: strings, templates, comments, regular expressions (after punctuation or a keyword) and brackets
    var skipValue = function (src, i) {
        var n = src.length, depth = 0, tpl = [], prev = 40, word = '';
        while (i < n) {
            var c = src.charCodeAt(i);
            if (c === 32 || c === 10 || c === 13 || c === 9 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029) { i++; continue; }
            if (c === 47) {   // /
                var c2 = src.charCodeAt(i + 1);
                if (c2 === 47) { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
                if (c2 === 42) { i = src.indexOf('*/', i + 2); if (i < 0) return -1; i += 2; continue; }
                var regex = word ? LAZY_REGEX_AFTER.test(word) : '(,=:[!&|?{};+-*%<>~^}'.indexOf(String.fromCharCode(prev)) >= 0;
                word = '';
                if (!regex) { prev = 47; i++; continue; }
                var cls = false;
                for (i++; i < n; i++) {
                    c = src.charCodeAt(i);
                    if (c === 92) { i++; continue; }
                    if (c === 10 || c === 13) return -1;
                    if (cls) { if (c === 93) cls = false; continue; }
                    if (c === 91) cls = true;
                    else if (c === 47) break;
                }
                i++;
                while (i < n && /[a-z]/.test(src.charAt(i))) i++;
                prev = 97;
                continue;
            }
            if (c === 34 || c === 39) {   // " '
                for (i++; i < n; i++) {
                    var q = src.charCodeAt(i);
                    if (q === 92) { i++; continue; }
                    if (q === c) break;
                    if (q === 10 || q === 13) return -1;
                }
                if (i >= n) return -1;
                i++; prev = 97; word = '';
                continue;
            }
            if (c === 96 || (c === 125 && tpl.length && tpl[tpl.length - 1] === depth)) {   // ` or the } closing a ${
                if (c === 125) { tpl.pop(); depth--; }
                for (i++; i < n; i++) {
                    var t = src.charCodeAt(i);
                    if (t === 92) { i++; continue; }
                    if (t === 96) break;
                    if (t === 36 && src.charCodeAt(i + 1) === 123) { depth++; tpl.push(depth); i++; break; }
                }
                if (i >= n) return -1;
                i++;
                prev = t === 96 ? 97 : 123; word = '';
                continue;
            }
            if (c === 40 || c === 91 || c === 123) { depth++; prev = c; word = ''; i++; continue; }
            if (c === 41 || c === 93 || c === 125) {
                if (depth === 0) return c === 125 ? i : -1;
                depth--; prev = c; word = ''; i++;
                continue;
            }
            if (c === 44 && depth === 0) return i;
            if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c > 127 || c === 92) {
                var s = i;
                while (i < n) {
                    c = src.charCodeAt(i);
                    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || c > 127) i++;
                    else if (c === 92 && src.charCodeAt(i + 1) === 117) i += 2;   // \u escape in a name
                    else if (c === 46 && s < i && src.charCodeAt(s) >= 48 && src.charCodeAt(s) <= 57) i++;   // 1.5
                    else break;
                }
                word = src.slice(s, i); prev = 97;
                continue;
            }
            prev = c; word = ''; i++;
        }
        return -1;
    };
    // [[start, end], ...] of the factories to keep for later, or null when src is not such a chunk
    var lazyParts = function (src) {
        var m = LAZY_HEAD.exec(src.slice(0, 4096));
        if (!m) return null;
        var i = m[0].length, n = src.length, parts = [];
        for (;;) {
            while (i < n && /[\s,]/.test(src.charAt(i))) i++;
            if (src.charAt(i) === '}') break;
            var key = /^(?:\d+|"[^"\\\n]*"|'[^'\\\n]*'|[\w$]+)\s*:\s*/.exec(src.slice(i, i + 300));
            if (!key) return null;
            var start = i + key[0].length, end = skipValue(src, start);
            if (end < 0) return null;
            var value = src.slice(start, Math.min(end, start + 60));
            if (end - start >= LAZY_MIN && /^(?:function\b|\(|[\w$]+\s*=>)/.test(value)) {
                var e = end;
                while (e > start && /\s/.test(src.charAt(e - 1))) e--;
                parts.push([start, e]);
            }
            i = end;
        }
        return parts.length ? parts : null;
    };
    // the page's side: a stub calls it with the part's key; the app answers with the part lowered as a program that
    // leaves the factory in __br_lazyValue
    var LAZY_RUNTIME = 'var __br_lazy=function(g){return g.__br_lazy||(g.__br_lazy=function(k,t,a){var c=g.__br_lazyCache||(g.__br_lazyCache={}),f=c[k];' +
        'if(!f){var x=new XMLHttpRequest();x.open("GET","https://ios6-browser.invalid/lazy/"+k+".js",false);x.send(null);' +
        'if(!(x.status===200||x.status===0&&x.responseText))throw new Error("Module "+k+" did not load ("+x.status+")");' +
        'var F=g.Function.__brNative||g.Function;f=c[k]=F(x.responseText+"\\n;return __br_lazyValue;").call(g)}return f.apply(t,a)})}(typeof self!=="undefined"?self:this);\n';
    var lazySkeleton = function (src, parts, key) {
        var out = [], at = 0;
        for (var i = 0; i < parts.length; i++) {
            out.push(src.slice(at, parts[i][0]), 'function(){return __br_lazy(' + quote(key + '/' + i) + ',this,arguments)}');
            at = parts[i][1];
        }
        out.push(src.slice(at));
        var body = out.join(''), directive = /^\s*(?:"use strict"|'use strict')\s*;?/.exec(body);
        // (after a directive prologue, so that it stays one)
        return directive ? directive[0] + '\n' + LAZY_RUNTIME + body.slice(directive[0].length) : LAZY_RUNTIME + body;
    };
    var stats = { runs: 0, skipped: 0, lowered: 0, failed: 0, ms: 0, last: '', early: 0, fallbacks: 0, redos: 0, maxUnit: 0, outer: 0, flat: 0,
                  checks: 0, phases: '', lazy: null, note: '', islandFallbacks: 0, islandChecks: 0, stmtAgain: 0 };
    // Islands for run(): {src: the text with the stand-ins in (they go in by text, the skipped functions keep theirs),
    // skip: see islandSkips (null: none), standins: their helpers}
    var islandPrep = function (src, opts, planned) {
        if (planned && planned.prep) { stats.note = planned.note; return planned.prep; }
        var prep = { src: src, skip: null, standins: [] };
        if (opts.module || opts.islands === false || src.length < ISLAND_SCRIPT || !root.acorn || !root.acorn.Parser || STANDIN_OWN.test(src)) return prep;
        var isrc = src, standins = [];
        if (needsProxy(isrc)) {
            isrc = isrc.replace(/\bnew\s+Proxy\s*\(/g, 'new __br_Proxy(').replace(/(^|[^.\w$])Proxy\s*\.\s*revocable\s*\(/g, "$1__br_Proxy('revocable')(");
            standins.push('__br_Proxy');
        }
        if (needsBigInt(isrc)) { isrc = isrc.replace(BIGINT_TEXT, '$1__br_BigInt$2'); standins.push('__br_BigInt'); }
        var skip = islandSkips(isrc);
        return skip ? { src: isrc, skip: skip, standins: standins } : prep;
    };
    // ---- Pieces. A big script that is a row of statements (webpack chunks pushed one after the other; CNN's 2 MB of
    // modules inline) is lowered a group of them at a time when there is no room for all of it at once: the tree of
    // 128 KB instead of megabytes (the whole of CNN's took 60 MB more than the iPad had left beside the page), and a
    // group the engine takes as it is keeps its text. A group lowered on its own holds nothing at its top that becomes
    // a new name there (a let in a block there, lowered to a var, could meet a name of another group).
    var PIECES_SCRIPT = 384 * 1024, PIECE_SIZE = 128 * 1024;
    // whether a statement at the top holds a declaration scoped to a block of it there (outside functions): a let,
    // const, class or function in a block, a destructured catch parameter
    var blockDecl = function (stmt) {
        var found = false;
        var walk = function (x, top) {
            if (found || !x || typeof x.type !== 'string') return;
            switch (x.type) {
                case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassExpression': return;
                case 'FunctionDeclaration': case 'ClassDeclaration': if (!top) found = true; return;
                case 'VariableDeclaration': if (x.kind !== 'var' && !top) { found = true; return; } break;
                case 'CatchClause': if (x.param && x.param.type !== 'Identifier') { found = true; return; } break;
            }
            for (var key in x) {
                if (key.charAt(0) === '$' || !x.hasOwnProperty(key)) continue;
                var v = x[key];
                if (!v || typeof v !== 'object') continue;
                if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) walk(v[i], false); }   // (the parser's arrays may be of another realm)
                else walk(v, false);
            }
        };
        walk(stmt, true);
        return found;
    };
    var pieceBounds = function (src) {
        var fns = scanFunctions(src);
        if (!fns) return null;
        var semis = fns.semis, bounds = [], start = 0;
        for (var i = 0; i < semis.length; i++) {
            if (semis[i] + 1 - start >= PIECE_SIZE) { bounds.push([start, semis[i] + 1]); start = semis[i] + 1; }
        }
        if (start < src.length) bounds.push([start, src.length]);
        return bounds.length > 1 ? bounds : null;
    };
    // For the app, when a big script does not fit at once: 'pieces' when it can go a group of statements at a time (the
    // next run() of it does), else ''. Costs a lexer pass, no parse.
    var shape = function (src, optsJSON) {
        var opts = null;
        try { opts = optsJSON ? JSON.parse(optsJSON) : {}; } catch (e) { opts = {}; }
        // (what plan() found stays when this finds nothing)
        if (opts.module || opts.force || src.length < PIECES_SCRIPT) return '';
        if (opts.proxy !== undefined ? opts.proxy : needsProxy(src)) src = retargetProxyGuards(src);
        if ((needsProxy(src) || needsBigInt(src)) && STANDIN_OWN.test(src)) return '';
        var bounds = null;
        try { bounds = pieceBounds(src); } catch (e) { bounds = null; }
        if (!bounds) return '';
        memo = { src: src, pieces: bounds };
        return 'pieces';
    };
    // A group lowered on its own holds the tree of 128 KB only: it may go on closer to the iPad's limit than a whole
    // lowering. A run given up for lack of memory keeps what it did (pieceState): the app waits for room and runs the
    // same text again, which goes on from there (CNN took the room back while its 2 MB of modules were lowered).
    var PIECES_FLOOR_MB = 32, pieceState = null;
    // the ES5 text of src a group at a time (null: nothing to change); throws Unsupported('memory') when the room runs
    // out, and Unsupported('flat-top') for a group that cannot go on its own
    var piecesRun = function (src, bounds, opts) {
        var st = pieceState && pieceState.src === src ? pieceState : null;
        pieceState = null;
        if (!st) {
            // (a directive prologue of the whole script holds for every group; in sloppy code a group starting with a
            // "use strict" of its own must not become strict: CNN starts every module so, in the middle of the script)
            st = { src: src, bounds: bounds, i: 0, out: [], used: [], seen: {}, lowered: 0, ms: 0, waits: 0,
                   prefix: /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*(["'])use strict\1/.test(src.slice(0, 4096)) ? '"use strict";' : ';' };
        } else st.waits++;
        var prefix = st.prefix, t0 = new Date().getTime(), popts = {}, k;
        var use = function (name) { if (!st.seen[name]) { st.seen[name] = 1; st.used.push(name); } };
        for (k in opts) if (opts.hasOwnProperty(k)) popts[k] = opts[k];
        popts.flatTop = true;
        popts.memoryFloor = PIECES_FLOOR_MB;
        for (; st.i < st.bounds.length; st.i++) {
            var piece = src.slice(st.bounds[st.i][0], st.bounds[st.i][1]), low = null;
            // (with a direct eval it is lowered even when the engine takes it: what the eval runs is lowered then too)
            var takes = engineTakes(prefix + piece), evals = DIRECT_EVAL.test(piece);
            if (!takes || evals) {
                try { low = transpile(prefix + piece, popts); } catch (e) {
                    if (e instanceof Unsupported && e.what === 'memory') { st.ms += new Date().getTime() - t0; pieceState = st; }
                    throw e;
                }
                if (low === null && !takes) throw new Unsupported('a group the engine refuses has nothing to lower');
            }
            if (low === null) {
                // (the stand-ins by text, as for a whole script the engine takes)
                if (needsProxy(piece)) { piece = piece.replace(/\bnew\s+Proxy\s*\(/g, 'new __br_Proxy(').replace(/(^|[^.\w$])Proxy\s*\.\s*revocable\s*\(/g, "$1__br_Proxy('revocable')("); use('__br_Proxy'); }
                if (needsBigInt(piece)) { piece = piece.replace(BIGINT_TEXT, '$1__br_BigInt$2'); use('__br_BigInt'); }
                if (needsDsDelete(piece)) { var dp = dsDeletes(piece); if (engineTakes(prefix + dp)) { piece = dp; use('__br_dsdel'); } }
                // (this.constructor of custom elements, as for a whole script: the script names customElements, maybe
                // in another group)
                if (st.ctor === undefined) st.ctor = needsCtor(src);
                if (st.ctor) { CTOR_THIS.lastIndex = 0; if (CTOR_THIS.test(piece)) { var cp = ctorReads(piece); if (engineTakes(prefix + cp)) { piece = cp; use('__br_ctor'); } } }
                // (key in obj with symbols: the script makes them, maybe in another group)
                if (st.symIn === undefined) st.symIn = src.indexOf('Symbol(') >= 0;
                if (st.symIn && piece.indexOf(' in ') >= 0) { var sip = symIns(piece); if (sip !== piece && engineTakes(prefix + sip)) { piece = sip; use('__br_in'); } }
                st.out.push(piece);
                continue;
            }
            if (prefix && low.slice(0, prefix.length) === prefix) low = low.slice(prefix.length);
            if (!engineTakes(prefix + low)) throw new Unsupported('a lowered group does not parse (' + engineError(prefix + low) + ')');
            st.out.push(low);
            st.lowered++;
        }
        st.ms += new Date().getTime() - t0;
        stats.note = 'pieces: ' + st.lowered + ' of ' + st.bounds.length + ' groups lowered in ' + st.ms + ' ms' + (st.waits ? ', ' + st.waits + ' waits for room' : '');
        if (!st.lowered && !st.used.length) return null;
        // (a group ends after a semicolon of the top; one lowered may end without one)
        var text = st.out.join('\n;');
        return st.used.length ? text + '\n;' + helperText(st.used) : text;
    };
    // For the app, before it makes room for a lowering: what run() will do with the script — 'es5' (nothing), 'stand-in'
    // (a few names replaced), 'islands' (pieces of it, see islands: little memory) or 'full' (all of it). What it found
    // out is kept for run() of the same text.
    var memo = null;
    var plan = function (src, optsJSON) {
        var opts = null;
        try { opts = optsJSON ? JSON.parse(optsJSON) : {}; } catch (e) { opts = {}; }
        memo = null;
        if (opts.module) return 'full';
        if (opts.proxy !== undefined ? opts.proxy : needsProxy(src)) src = retargetProxyGuards(src);
        var parses = !opts.force && engineParses(src);
        if (parses) {
            var evals = src.length < 300 * 1024 && DIRECT_EVAL.test(src);
            if (!needsProxy(src) && !needsBigInt(src) && !evals && !needsDsDelete(src) && !needsCtor(src) && !needsSymIn(src)) return 'es5';
            memo = { src: src, parses: true, prep: null, note: '' };
            return evals ? 'full' : 'stand-in';
        }
        stats.note = '';
        memo = { src: src, parses: false, prep: null, note: '' };
        memo.prep = islandPrep(src, opts, null);
        memo.note = stats.note;
        return memo.prep.skip ? 'islands' : 'full';
    };
    // for the app: '' when the engine takes the script as it is (or it cannot be lowered), else the ES5 text;
    // JSFix.last() tells which ("es5", "lowered", or why it failed)
    var run = function (src, optsJSON) {
        var opts = null;
        try { opts = optsJSON ? JSON.parse(optsJSON) : {}; } catch (e) { opts = {}; }
        stats.runs++;
        stats.note = '';
        // (the text as it came: the app cuts the lazy factories out of that, see below)
        var given = src;
        if (opts.proxy !== undefined ? opts.proxy : needsProxy(src)) src = retargetProxyGuards(src);
        if (opts.module) {
            // a module always becomes a registration; when it cannot, the loader is told why
            var mout = null, merr = '';
            try { mout = transpile(src, opts); } catch (em) { merr = (em && (em.message || em.what)) || String(em); }
            if (mout !== null && !engineParses(mout)) { try { new Function(mout); } catch (ep) { merr = 'output does not parse (' + ep.message + ')'; } mout = null; }   // eslint-disable-line no-new-func
            if (mout === null) {
                stats.failed++;
                stats.last = 'failed: ' + merr;
                return 'window.__brModules&&__brModules.fail(' + quote(opts.url || '') + ',' + quote(merr) + ');';
            }
            stats.lowered++;
            stats.last = 'module';
            return mout;
        }
        // (what plan() found out about this text)
        var planned = memo && memo.src === src ? memo : null;
        memo = null;
        // a big row of statements a group at a time (see pieces), or going on with one that waited for room
        var resume = pieceState && pieceState.src === src ? pieceState : null;
        if ((planned && planned.pieces) || resume) {
            var pt0 = new Date().getTime(), pout;
            try { pout = piecesRun(src, resume ? resume.bounds : planned.pieces, opts); } catch (ep) {
                // (a group with a new name at its top cannot go on its own: the whole script as usual)
                if (ep instanceof Unsupported && ep.what === 'flat-top') { planned = null; pout = undefined; }
                else {
                    stats.failed++;
                    stats.last = 'failed: ' + ((ep && (ep.message || ep.what)) || String(ep));
                    return '';
                }
            }
            stats.ms += new Date().getTime() - pt0;
            if (pout === null) { stats.skipped++; stats.last = 'es5'; return ''; }
            if (pout !== undefined) {
                stats.lowered++;
                stats.last = 'lowered';
                return pout;
            }
        }
        var tc = new Date().getTime(), parsesAsIs = !opts.force && (planned ? planned.parses : engineParses(src)), evals = false;
        stats.checks = new Date().getTime() - tc;
        if (parsesAsIs) {
            var np = needsProxy(src), nb = needsBigInt(src), nd = needsDsDelete(src), nc = needsCtor(src), ns = needsSymIn(src);
            // (a direct eval of ES2015+ text needs the tree even in a script the engine takes; not worth a big
            // script's parse)
            evals = src.length < 300 * 1024 && DIRECT_EVAL.test(src);
            if (!np && !nb && !nd && !nc && !ns && !evals) { stats.skipped++; stats.last = 'es5'; return ''; }
            if (!evals && (!(np || nb) || !STANDIN_OWN.test(src))) {
                // (the helpers go at the end: a directive prologue stays first, declarations are hoisted)
                var text = src, used = [];
                if (np) {
                    text = text.replace(/\bnew\s+Proxy\s*\(/g, 'new __br_Proxy(').replace(/(^|[^.\w$])Proxy\s*\.\s*revocable\s*\(/g, "$1__br_Proxy('revocable')(");
                    used.push('__br_Proxy');
                }
                if (nb) { text = text.replace(BIGINT_TEXT, '$1__br_BigInt$2'); used.push('__br_BigInt'); }
                if (nd) {
                    // (such a delete inside a string would no longer parse: then the deletes stay)
                    var dtext = dsDeletes(text);
                    if (engineParses(dtext)) { text = dtext; used.push('__br_dsdel'); }
                }
                if (nc) {
                    var ctext = ctorReads(text);
                    if (engineParses(ctext)) { text = ctext; used.push('__br_ctor'); }
                }
                if (ns) {
                    var stext = symIns(text);
                    if (stext !== text && engineParses(stext)) { text = stext; used.push('__br_in'); }
                }
                if (!used.length) { stats.skipped++; stats.last = 'es5'; return ''; }
                stats.lowered++;
                stats.last = 'stand-in';
                return text + '\n;' + helperText(used);
            }
        }
        // a big script the engine refuses for a few pieces only: just those are lowered (see islands)
        var prep = parsesAsIs ? null : islandPrep(src, opts, planned), skip = prep ? prep.skip : null, standins = prep ? prep.standins : [];
        if (skip) src = prep.src;
        // a webpack chunk with big factories: those are lowered when the page first calls them (the app keeps their
        // text: JSFix.lazy() tells where they are); anything unexpected and the whole script is lowered as usual.
        // (Where they are in the text the app has: the Proxy checks retargeted above made it longer, and factories cut
        // at those places did not parse, imdb.com; transpile() retargets the skeleton, the app each factory.)
        stats.lazy = null;
        if (!skip && opts.lazy && !opts.module && !parsesAsIs && given.length >= LAZY_SCRIPT) {
            var parts = null;
            try { parts = lazyParts(given); } catch (el) { parts = null; }
            if (parts) {
                var skeleton = lazySkeleton(given, parts, String(opts.lazy)), sout = null, sok = true;
                try { sout = transpile(skeleton, opts); } catch (es) { sok = !(es instanceof Unsupported) || es.what !== 'memory' ? false : 'memory'; }
                if (sok === 'memory') { stats.failed++; stats.last = 'failed: unsupported: memory'; return ''; }
                if (sok) {
                    if (sout === null) sout = skeleton;
                    if (sout.length > 1024 * 1024 || engineParses(sout)) {
                        stats.lazy = parts;
                        stats.lowered++;
                        stats.last = 'lowered';
                        return '/*br-lazy:' + parts.length + ':' + opts.lazy + '*/' + sout;
                    }
                }
            }
        }
        var t0 = new Date().getTime(), out = null;
        try { out = transpile(src, opts, skip); } catch (e2) {
            stats.failed++;
            stats.last = 'failed: ' + ((e2 && (e2.message || e2.what)) || String(e2));
            return '';
        }
        if (out !== null && standins.length) out += '\n;' + helperText(standins);
        stats.ms += new Date().getTime() - t0;
        if (out === null && parsesAsIs) { stats.skipped++; stats.last = 'es5'; return ''; }
        if (out === null) { stats.failed++; stats.last = 'failed: nothing to lower'; return ''; }
        tc = new Date().getTime();
        // (the engine's parse of a big output costs as much memory as a page's script: 50 MB for Vimeo's 4 MB; when
        // the input does not parse either, a bad output changes nothing for the page)
        var outParses = opts.force || (!parsesAsIs && out.length > 1024 * 1024) || engineParses(out);
        stats.checks += new Date().getTime() - tc;
        if (!outParses) {
            var why = '';
            try { new Function(out); } catch (e3) { why = e3.message; }   // eslint-disable-line no-new-func
            stats.failed++;
            stats.last = 'failed: output does not parse (' + why + ')';
            return '';
        }
        stats.lowered++;
        stats.last = 'lowered';
        return out;
    };
    // (lowerUnicode: the page's RegExp constructor lowers u/v patterns with it, see shims-extra.js)
    // (lazy: after a run that kept factories for later, "[[start,end],...]" of their text in the input, else '')
    // every runtime helper as global function declarations: the polyfill bundle carries them (tools/gen-helpers.js),
    // since lowered code a page keeps as text and runs later with new Function / eval (MediaWiki keeps its modules in
    // localStorage) no longer sees the helpers of the script it came from
    var helperSource = function () {
        var names = [];
        for (var k in RUNTIME) if (RUNTIME.hasOwnProperty(k)) names.push(k);
        return helperText(names);
    };
    // (note: how the last run went where it did something unusual, for the app's log: islands)
    root.JSFix = { transpile: transpile, run: run, plan: plan, shape: shape, stats: stats, last: function () { return stats.last; }, note: function () { return stats.note; },
                   phases: function () { return stats.phases; },
                   version: 1, Unsupported: Unsupported, lowerUnicode: lowerUnicodeRegex, scanFunctions: scanFunctions, islandSkips: islandSkips, fastTokens: fastTokens,
                   lazy: function () { return stats.lazy ? JSON.stringify(stats.lazy) : ''; }, lazyParts: lazyParts, helperSource: helperSource,
                   lazyScan: function (src) { var p = null; try { p = lazyParts(src); } catch (e) { p = null; } return p ? JSON.stringify(p) : ''; } };
})(this);
