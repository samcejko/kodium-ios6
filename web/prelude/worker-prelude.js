/* Kodium: what a lowered worker (web/tools/build-workers.mjs) needs besides the engine's polyfills for workers - the
   same helpers as the page's prelude (vsc-prelude.js; keep the two alike), without what is for a document.
   ES5 only: it runs on the iOS 6 engine as it is. */
(function (G) {
    'use strict';
    if (typeof G.globalThis === 'undefined') G.globalThis = G;

    // the ES1 constants of Number (see vsc-prelude.js)
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

    // A worker's navigator of the old engine has no language (VS Code reads navigator.language.toLowerCase() as it
    // starts): the page's, which it gives in the worker's address (src/main.ts)
    (function () {
        var nav = G.navigator;
        if (!nav || typeof nav.language === 'string') return;
        var m = /[?&]lang=([^&#]*)/.exec(G.location ? String(G.location.search) : ''), lang = m ? decodeURIComponent(m[1]) : 'en';
        try { Object.defineProperty(nav, 'language', { value: lang, configurable: true, enumerable: true }); } catch (e) { try { nav.language = lang; } catch (e2) {} }
    })();

    // String methods that the engine's polyfills for workers lack (checked on the iPad: these three; normalize too,
    // which VS Code does without): the diff editor's diff threw at trimStart, and showed no change
    (function () {
        var S = String.prototype;
        var define = function (name, fn) {
            if (typeof S[name] === 'function') return;
            try { Object.defineProperty(S, name, { value: fn, writable: true, configurable: true }); } catch (e) { S[name] = fn; }
        };
        define('trimStart', S.trimLeft || function () { return String(this).replace(/^[\s﻿\xA0]+/, ''); });
        define('trimEnd', S.trimRight || function () { return String(this).replace(/[\s﻿\xA0]+$/, ''); });
        define('replaceAll', function (search, replacement) {
            var s = String(this);
            if (search instanceof RegExp) {
                if (!search.global) throw new TypeError('replaceAll must be called with a global RegExp');
                return s.replace(search, replacement);
            }
            return s.replace(new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replacement);
        });
    })();

    // (a worker of the old engine has no performance object)
    var P = G.performance || (G.performance = {});
    if (typeof P.now !== 'function') { var base = Date.now(); P.now = function () { return Date.now() - base; }; }
    if (typeof P.mark !== 'function') P.mark = function () {};
    if (typeof P.measure !== 'function') P.measure = function () {};

    // import.meta.url of the lowered code: the worker's own script
    G.__vsc_meta = { url: G.location ? String(G.location.href) : '' };
    // CSS variables in the code's strings (the page puts the theme's values in): nothing to put in here
    G.__kd_cssVar = function (text) { return text; };

    // regular expressions with lookbehind (see vsc-prelude.js)
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
    var reCache = {};
    G.__vsc_re = function (pattern, flags) {
        var key = flags + '/' + pattern, hit = reCache[key];
        if (hit) { hit.lastIndex = 0; return hit; }
        var re;
        try { re = new RegExp(pattern, flags); } catch (e) {
            try { re = new RegExp(withoutLookbehind(pattern), flags); } catch (e2) { re = /(?!)/; }
        }
        if (flags.indexOf('g') < 0 && flags.indexOf('y') < 0) reCache[key] = re;
        return re;
    };

    // the Proxy stand-in made to fit VS Code, and the names the worker reads through it (see vsc-prelude.js; the
    // worker's channels to the page are get-only proxies of $methods)
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
            var VProxy = function (target, handler) {
                if (!(this instanceof VProxy)) return Orig(target, handler);
                var F = VProxy.factory, proto = null;
                if (handler && typeof handler.get === 'function' && target !== null && typeof target === 'object' &&
                    Object.prototype.toString.call(target) !== '[object Array]') {
                    try { proto = handler.getPrototypeOf ? handler.getPrototypeOf(target) : Object.getPrototypeOf(target); } catch (e0) { proto = null; }
                }
                if (!proto || proto === Object.prototype || !F) return new Orig(target, handler);
                var p = Object.create(F);
                try {
                    Object.defineProperty(p, '__vsc_proto', { value: proto });
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
            try { new VProxy({}, { get: function () {} }); } catch (e4) {}
        }
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
        var PX = G.__br_Proxy, f = PX && PX.factory, list = G.__vsc_proxyNames;
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
    G.__vsc_afterHelpers = function () { installProxy(); };
})(self);
