/* shims-extra.js - larger browser API emulations for the iOS 6 WebKit, loaded after shims.js:
 * new-tab handling for window.open / target=_blank, pointer events, page visibility, fullscreen,
 * streams, shadow DOM emulated in the light DOM, custom element upgrades, <dialog> registration,
 * WebRTC / speech / payment / credential stubs that fail cleanly, crypto.subtle digests, canvas
 * helpers, responsive image properties. ES5 only. */
(function (window, document) {
    'use strict';
    var Ep = window.Element && window.Element.prototype;
    var Np = window.Node && window.Node.prototype;
    var P = window.Promise;
    function noop() {}
    // CSS property names in lower case, remembered: the style wrappers below each lower-cased every name they got (a
    // string made per call; style.setProperty cost 30 us here, the engine's 5). Custom property names stay as given.
    // The query methods as they are before the wrappers below (:scope, :read-only, the selector cache): a selector
    // without ':' that the engine took once goes straight to them (three wrappers made querySelectorAll 25 us, the
    // engine's 15). Per owner: an element's method does not take a document.
    var QUERY_BEFORE = [];
    (function () {
        var owners = [Ep, window.Document && window.Document.prototype, window.DocumentFragment && window.DocumentFragment.prototype];
        for (var i = 0; i < owners.length; i++) if (owners[i]) QUERY_BEFORE.push({ owner: owners[i], one: owners[i].querySelector, all: owners[i].querySelectorAll,
            is: owners[i].matches || owners[i].webkitMatchesSelector, up: owners[i].closest });
    })();
    function queryBefore(owner, kind) {
        for (var i = 0; i < QUERY_BEFORE.length; i++) if (QUERY_BEFORE[i].owner === owner) return QUERY_BEFORE[i][kind];
        return undefined;
    }
    var LOWER_NAMES = Object.create(null), lowerNames = 0;
    function lowerName(n) {
        var l = LOWER_NAMES[n];
        if (l === undefined) {
            l = n.toLowerCase();
            if (lowerNames < 2000) { LOWER_NAMES[n] = l; lowerNames++; }
        }
        return l;
    }
    function resolved(v) { return P ? P.resolve(v) : null; }
    function domException(name, message) {
        var e = new Error(message || name);
        e.name = name;
        e.code = name === 'NotSupportedError' ? 9 : name === 'AbortError' ? 20 : name === 'NotFoundError' ? 8 : 0;
        return e;
    }
    function rejectWith(name, message) { return function () { return P ? P.reject(domException(name, message)) : null; }; }
    // an iterator over a list (what keys() / values() / entries() of set-like and map-like interfaces return)
    function listIterator(list) {
        var i = 0, it = { next: function () { return i < list.length ? { value: list[i++], done: false } : { value: undefined, done: true }; } };
        if (window.Symbol && window.Symbol.iterator) it[window.Symbol.iterator] = function () { return this; };
        return it;
    }
    // Style methods for the shims' own values: the engine's own for a property it knows by that name, the page's
    // (wrapped) ones otherwise. The wrappers further down (custom properties, standard names of prefixed properties,
    // flexbox forms, the transition crash guard) are there for the page's calls; they cost 20-40 us a call here, and the
    // custom properties runtime makes thousands a pass (nextjs.org). Transition lists and display always take them.
    var ENGINE_STYLE = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype;
    var esGet = ENGINE_STYLE && ENGINE_STYLE.getPropertyValue, esSet = ENGINE_STYLE && ENGINE_STYLE.setProperty,
        esPri = ENGINE_STYLE && ENGINE_STYLE.getPropertyPriority, esRemove = ENGINE_STYLE && ENGINE_STYLE.removeProperty;
    var engineProps = {}, engineProbe = null;
    function engineProp(p) {
        var key = '$' + p, r = engineProps[key];
        if (r !== undefined) return r;
        r = false;
        if (esGet && typeof p === 'string' && !/^--|transition|^display$/i.test(p)) {
            try {
                if (!engineProbe) engineProbe = document.createElement('div').style;
                esSet.call(engineProbe, p, 'inherit', '');
                r = esGet.call(engineProbe, p) === 'inherit';
                esRemove.call(engineProbe, p);
            } catch (e) { r = false; }
        }
        return (engineProps[key] = r);
    }
    function styleGet(st, p) { return engineProp(p) ? esGet.call(st, p) : st.getPropertyValue(p); }
    function stylePriority(st, p) { return engineProp(p) ? esPri.call(st, p) : st.getPropertyPriority(p); }
    function styleSet(st, p, v, pr) { if (engineProp(p)) esSet.call(st, p, v, pr || ''); else st.setProperty(p, v, pr || ''); }
    function styleRemove(st, p) { if (engineProp(p)) esRemove.call(st, p); else st.removeProperty(p); }
    // -webkit-calc() values in the engine's Length properties crash WebKit 536 once the element restyles while such a
    // property is transitioned (see guardCalcTransitions in cssfix.js; nextjs.org: a custom property made a height a
    // calc at run time next to `transition-property: height`). Values the shims set go in as px then: calcRisk() says
    // whether a value needs that (the page transitions the property somewhere), calcToPx() measures it with the value
    // in place (the callers hold the element's transitions) or evaluates it, [[longhand, px]] or null.
    var CALC_CRASH = { width: 0, height: 0, 'min-width': 0, 'min-height': 0, 'max-width': 0, 'max-height': 0, top: 0, right: 0, bottom: 0, left: 0,
        'margin-top': 0, 'margin-right': 0, 'margin-bottom': 0, 'margin-left': 0, 'padding-top': 0, 'padding-right': 0, 'padding-bottom': 0,
        'padding-left': 0, 'text-indent': 0, '-webkit-background-size': 0,
        margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'], padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'] };
    function calcRisk(p, v) {
        if (!CALC_CRASH.hasOwnProperty(p) || String(v).indexOf('-webkit-calc(') < 0) return false;
        var trans = null;
        try { trans = runtimeCSS.transSet(); } catch (e) { trans = null; }
        if (!trans) return true;
        if (trans[p] || trans.all) return true;
        var parts = CALC_CRASH[p];
        if (parts) for (var i = 0; i < parts.length; i++) if (trans[parts[i]]) return true;
        return false;
    }
    function calcToPx(el, p, v, important) {
        var names = CALC_CRASH[p] || [p], out = [], st = el.style, i;
        var prev = st.getPropertyValue(p), prevPriority = st.getPropertyPriority(p);
        st.setProperty(p, v, important ? 'important' : '');
        var cs = getComputedStyle(el);
        for (i = 0; i < names.length && out; i++) {
            var got = cs.getPropertyValue(names[i]);
            if (!/^-?\d*\.?\d+px$/.test(got)) got = null;
            if (got === null && !CALC_CRASH[p] && window.__brDeferred && window.__brDeferred.lengthPx) got = window.__brDeferred.lengthPx(el, names[i], v);
            if (got === null) out = null; else out.push([names[i], got]);
        }
        if (prev) st.setProperty(p, prev, prevPriority); else st.removeProperty(p);
        return out;
    }
    function fire(target, type, detail) {
        try {
            var e = document.createEvent('Event');
            e.initEvent(type, true, false);
            if (detail) for (var k in detail) e[k] = detail[k];
            target.dispatchEvent(e);
        } catch (e2) {}
    }
    function defineAttrProp(proto, name, attr) {
        if (!proto || name in proto) return;
        try {
            Object.defineProperty(proto, name, {
                get: function () { return this.getAttribute(attr || name) || ''; },
                set: function (v) { this.setAttribute(attr || name, v); },
                configurable: true
            });
        } catch (e) {}
    }
    function defineBoolAttrProp(proto, name) {
        if (!proto || name in proto) return;
        try {
            Object.defineProperty(proto, name, {
                get: function () { return this.hasAttribute(name) && this.getAttribute(name) !== 'false'; },
                set: function (v) { if (v) this.setAttribute(name, 'true'); else this.removeAttribute(name); },
                configurable: true
            });
        } catch (e) {}
    }
    // a <style> of the shims: data-precedence makes React 19 skip it in <head> when it hydrates (it took the shims'
    // styles for the page's own and threw the page away over their text: vercel.com)
    function ownStyleElement() {
        var s = document.createElement('style');
        s.__brOwn = true;   // already in a form the engine takes (see the runtime style rewriting)
        s.setAttribute('data-precedence', 'br');
        return s;
    }
    function addStyle(css) {
        var s = ownStyleElement();
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
    }
    function onReady(fn) {
        if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(fn, 0);
        else document.addEventListener('DOMContentLoaded', fn, false);
    }
    // adds or removes one of the state classes cssfix substitutes for pseudo-classes the engine lacks
    function setStateClass(el, cls, on) {
        if (!el || el.nodeType !== 1) return;
        try {
            var cur = ' ' + (el.className && typeof el.className === 'string' ? el.className : '') + ' ';
            var has = cur.indexOf(' ' + cls + ' ') >= 0;
            if (on && !has) el.className = (el.className ? el.className + ' ' : '') + cls;
            else if (!on && has) el.className = cur.replace(' ' + cls + ' ', ' ').replace(/^\s+|\s+$/g, '');
        } catch (e) {}
    }
    // One observer for everything that reacts to new DOM nodes. observeAdded: every element added; observeAddedTree:
    // callbacks that go through an element's whole subtree get only the topmost elements of a batch - one under an
    // element of the same batch was covered by that one's pass. (The parser reports every element it adds: each
    // subtree query ran for the parent, the child, the grandchild..., 0.1-0.2 ms an element, 800 on example.com.)
    // A page of an app built on this engine (window.__brLeanPage = true, Kodium's workbench) has its stylesheet made for
    // the engine beforehand and sizes its own pictures and canvases: the shims that look the page over after every change
    // for what a web page might need (picture sizes and sources, rows wider than the window, links to the page itself)
    // stay out of it - on the iPad 2 they took 15-20 ms after every keystroke in the editor.
    function leanPage() { return window.__brLeanPage === true; }
    var addedCallbacks = [], treeCallbacks = [], settledCallbacks = [], settleTimer = null;
    function observeAdded(fn) { addedCallbacks.push(fn); }
    function observeAddedTree(fn) { treeCallbacks.push(fn); }
    function onSettled(fn) { settledCallbacks.push(fn); }
    if (window.MutationObserver) {
        var mo = new MutationObserver(function (records) {
            var tops = [], nTree = treeCallbacks.length, el, c, t, covered;
            for (var r = 0; r < records.length; r++) {
                var added = records[r].addedNodes;
                for (var i = 0; i < added.length; i++) {
                    el = added[i];
                    if (el.nodeType !== 1) continue;
                    for (c = 0; c < addedCallbacks.length; c++) try { addedCallbacks[c](el); } catch (e) {}
                    if (!nTree) continue;
                    // (the last few tops: the parser adds a subtree in document order)
                    covered = false;
                    for (t = tops.length - 1; t >= 0 && t >= tops.length - 4; t--) if (tops[t].contains(el)) { covered = true; break; }
                    if (covered) continue;
                    tops.push(el);
                    for (c = 0; c < nTree; c++) try { treeCallbacks[c](el); } catch (e2) {}
                }
                var removed = records[r].removedNodes;
                for (var j = 0; j < removed.length; j++) if (removed[j].nodeType === 1 && removed[j].__brUpgraded) disconnectTree(removed[j]);
            }
            if (settledCallbacks.length && !settleTimer) settleTimer = setTimeout(function () { settleTimer = null; for (var s = 0; s < settledCallbacks.length; s++) try { settledCallbacks[s](); } catch (e) {} }, 150);
        });
        var startObserving = function () { try { mo.observe(document.documentElement || document, { childList: true, subtree: true }); } catch (e) {} };
        if (document.documentElement) startObserving(); else document.addEventListener('DOMContentLoaded', startObserving, false);
    }

    // ---- Blob. The old engine writes typed-array parts as their text ("1,2,3" instead of three bytes) and cannot
    // read blob: URLs with XMLHttpRequest (NETWORK_ERR), which fetch() of an object URL and IndexedDB (it reads a Blob
    // back synchronously to store it) need. Views become array buffers, and blobs made here remember their parts (up
    // to 4 MB) so that their bytes can be given synchronously (BlobTools.bytes, used by the request wrapper below).
    var BlobTools = (function () {
        var NativeBlob = window.Blob;
        if (!NativeBlob || NativeBlob.__brWrapped) return null;
        var LIMIT = 4 * 1024 * 1024, urls = {}, force = window.__brForceXHR === 'all';
        var viewsBroken = force;
        try { viewsBroken = viewsBroken || new NativeBlob([new Uint8Array([1, 2, 3])]).size !== 3; } catch (e) {}
        var isView = function (p) { return !!p && typeof p === 'object' && !(p instanceof ArrayBuffer) && p.buffer instanceof ArrayBuffer && typeof p.byteOffset === 'number' && typeof p.byteLength === 'number'; };
        var toBuffer = function (v) { var copy = new Uint8Array(v.byteLength); copy.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); return copy.buffer; };
        var hide = function (obj, name, value) { try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true, enumerable: false }); } catch (e) { obj[name] = value; } };
        var sizeOf = function (p) { return typeof p === 'string' ? p.length * 3 : p instanceof ArrayBuffer ? p.byteLength : isView(p) ? p.byteLength : p && typeof p.size === 'number' ? p.size : String(p).length * 3; };
        var WrappedBlob = function Blob(parts, opts) {
            var fixed = parts;
            if (parts && typeof parts.length === 'number' && viewsBroken) {
                fixed = [];
                for (var i = 0; i < parts.length; i++) fixed.push(isView(parts[i]) ? toBuffer(parts[i]) : parts[i]);
            }
            var b = arguments.length > 1 ? new NativeBlob(fixed, opts) : arguments.length ? new NativeBlob(fixed) : new NativeBlob();
            var list = fixed && typeof fixed.length === 'number' ? Array.prototype.slice.call(fixed) : [], total = 0;
            for (var j = 0; j < list.length && total <= LIMIT; j++) total += sizeOf(list[j]);
            if (total <= LIMIT) hide(b, '__brParts', list);
            return b;
        };
        WrappedBlob.prototype = NativeBlob.prototype;
        WrappedBlob.__brWrapped = true;
        try { window.Blob = WrappedBlob; } catch (e0) {}
        // (a slice of a blob whose bytes are known is known too; the old engine has only webkitSlice)
        var nativeSlice = NativeBlob.prototype.slice || NativeBlob.prototype.webkitSlice;
        if (nativeSlice) {
            NativeBlob.prototype.slice = function (start, end) {
                var r = nativeSlice.apply(this, arguments), size = this.size;
                var clamp = function (v, d) { v = v === undefined ? d : Math.floor(Number(v) || 0); return v < 0 ? Math.max(size + v, 0) : Math.min(v, size); };
                var s = clamp(start, 0), e = clamp(end, size);
                hide(r, '__brFrom', [this, s, Math.max(s, e)]);
                return r;
            };
        }
        var watch = function (owner) {
            if (!owner || !owner.createObjectURL || owner.createObjectURL.__brBlobURLs) return;
            var create = owner.createObjectURL, revoke = owner.revokeObjectURL;
            owner.createObjectURL = function (obj) {
                var u = create.apply(this, arguments);
                if (obj && typeof obj.size === 'number') urls[u] = obj;
                return u;
            };
            owner.createObjectURL.__brBlobURLs = true;
            if (revoke) owner.revokeObjectURL = function (u) { delete urls[u]; return revoke.apply(this, arguments); };
        };
        try { watch(window.URL); if (window.webkitURL !== window.URL) watch(window.webkitURL); } catch (e1) {}
        var utf8Bytes = function (s) {
            var b = unescape(encodeURIComponent(s)), out = new Uint8Array(b.length);
            for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
            return out;
        };
        // the bytes of a blob made on this page (Uint8Array), or null when they are not known
        var bytes = function (b, depth) {
            try { return bytesOf(b, depth); } catch (e) { return null; }
        };
        var bytesOf = function (b, depth) {
            if (!b || (depth || 0) > 8) return null;
            if (b.__brBytes) return b.__brBytes;
            var result = null;
            if (b.__brParts) {
                var chunks = [], total = 0;
                for (var i = 0; i < b.__brParts.length; i++) {
                    var p = b.__brParts[i], c;
                    if (typeof p === 'string') c = utf8Bytes(p);
                    else if (p instanceof ArrayBuffer) c = new Uint8Array(p);
                    else if (isView(p)) c = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
                    else if (p && typeof p.size === 'number' && typeof p.slice === 'function') { c = bytes(p, (depth || 0) + 1); if (!c) return null; }
                    else c = utf8Bytes(String(p));
                    chunks.push(c);
                    total += c.length;
                }
                result = new Uint8Array(total);
                for (var k = 0, at = 0; k < chunks.length; k++) { result.set(chunks[k], at); at += chunks[k].length; }
            } else if (b.__brFrom) {
                var whole = bytes(b.__brFrom[0], (depth || 0) + 1);
                result = whole ? whole.subarray(b.__brFrom[1], b.__brFrom[2]) : null;
            } else if (b.size === 0) result = new Uint8Array(0);
            if (result && result.length !== b.size) return null;   // (not what the engine holds)
            if (result) hide(b, '__brBytes', result);
            return result;
        };
        // blob.text() / arrayBuffer() / stream() of today's Blob (and File), through FileReader
        var BP = NativeBlob.prototype;
        var readAs = function (blob, how) {
            return new P(function (resolve, reject) {
                var known = how === 'arraybuffer' ? bytes(blob) : null;
                if (known) { resolve(known.buffer.slice(known.byteOffset, known.byteOffset + known.length)); return; }
                var r = new FileReader();
                r.onload = function () { resolve(r.result); };
                r.onerror = function () { reject(r.error || domException('NotReadableError', 'The blob could not be read')); };
                if (how === 'text') r.readAsText(blob, 'utf-8'); else r.readAsArrayBuffer(blob);
            });
        };
        if (P && window.FileReader) {
            if (!BP.text) BP.text = function () { return readAs(this, 'text'); };
            if (!BP.arrayBuffer) BP.arrayBuffer = function () { return readAs(this, 'arraybuffer'); };
            if (!BP.bytes) BP.bytes = function () { return readAs(this, 'arraybuffer').then(function (b) { return new Uint8Array(b); }); };
            if (!BP.stream && window.ReadableStream) BP.stream = function () {
                var blob = this;
                return new window.ReadableStream({ start: function (c) { return readAs(blob, 'arraybuffer').then(function (b) { c.enqueue(new Uint8Array(b)); c.close(); }, function (e) { c.error(e); }); } });
            };
        }
        return { bytes: bytes, forURL: function (u) { return urls.hasOwnProperty(u) ? urls[u] : null; } };
    })();

    // ---- FormData: the old engine's FormData has only append(). The entries are kept alongside (from the form's
    // controls like a submission, and from every append/set/delete) for get/getAll/has/set/delete/entries/keys/values/
    // forEach; a FormData changed by set or delete is rebuilt when it is sent (see the request wrapper).
    var FormDataTools = (function () {
        var NativeFD = window.FormData;
        if (!NativeFD || NativeFD.__brWrapped) return null;
        var probe = new NativeFD();
        if (typeof probe.get === 'function' && typeof probe.entries === 'function' && !window.__brForceXHR) return null;
        var hideProp = function (obj, name, value) { try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true, enumerable: false }); } catch (e) { obj[name] = value; } };
        var isBlob = function (v) { return !!v && typeof v === 'object' && typeof v.size === 'number' && typeof v.type === 'string' && (typeof v.slice === 'function' || typeof v.webkitSlice === 'function'); };
        var entryValue = function (v, filename) {
            if (!isBlob(v)) return String(v);
            if (filename !== undefined) { try { hideProp(v, '__brName', String(filename)); } catch (e) {} }
            return v;
        };
        // the successful controls of a form, as a submission would send them
        var collect = function (form) {
            var out = [];
            if (!form || !form.elements) return out;
            var els = form.elements;
            for (var i = 0; i < els.length; i++) {
                var el = els[i], name = el.name, type = (el.type || '').toLowerCase(), tag = (el.tagName || '').toLowerCase();
                if (!name || el.disabled) continue;
                if (tag === 'fieldset' || tag === 'object' || tag === 'output') continue;
                if (type === 'submit' || type === 'image' || type === 'button' || type === 'reset') continue;   // (the submitter is appended by the constructor)
                if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
                if (type === 'file') {
                    var files = el.files;
                    if (!files || !files.length) out.push([name, new Blob([], { type: 'application/octet-stream' })]);
                    else for (var f = 0; f < files.length; f++) out.push([name, files[f]]);
                    continue;
                }
                if (tag === 'select') {
                    for (var o = 0; o < el.options.length; o++) if (el.options[o].selected && !el.options[o].disabled) out.push([name, el.options[o].value]);
                    continue;
                }
                out.push([name, type === 'checkbox' || type === 'radio' ? (el.hasAttribute('value') ? el.value : 'on') : el.value]);
            }
            return out;
        };
        var list = function (fd) { if (!fd.__brList) hideProp(fd, '__brList', []); return fd.__brList; };
        var FD = function FormData(form, submitter) {
            var fd = form ? new NativeFD(form) : new NativeFD();
            hideProp(fd, '__brList', collect(form));
            if (submitter && submitter.name) fd.append(submitter.name, submitter.value || '');
            return fd;
        };
        FD.prototype = NativeFD.prototype;
        FD.__brWrapped = true;
        var FP = NativeFD.prototype, nativeAppend = FP.append;
        FP.append = function (name, value, filename) {
            list(this).push([String(name), entryValue(value, filename)]);
            return arguments.length > 2 ? nativeAppend.call(this, name, value, filename) : nativeAppend.call(this, name, value);
        };
        FP.get = function (name) { var l = list(this); name = String(name); for (var i = 0; i < l.length; i++) if (l[i][0] === name) return l[i][1]; return null; };
        FP.getAll = function (name) { var l = list(this), out = []; name = String(name); for (var i = 0; i < l.length; i++) if (l[i][0] === name) out.push(l[i][1]); return out; };
        FP.has = function (name) { return this.get(name) !== null; };
        FP['delete'] = function (name) {
            var l = list(this); name = String(name);
            for (var i = l.length - 1; i >= 0; i--) if (l[i][0] === name) l.splice(i, 1);
            hideProp(this, '__brDirty', true);
        };
        FP.set = function (name, value, filename) {
            var l = list(this), done = false; name = String(name);
            for (var i = 0; i < l.length; i++) {
                if (l[i][0] !== name) continue;
                if (!done) { l[i] = [name, entryValue(value, filename)]; done = true; } else { l.splice(i, 1); i--; }
            }
            if (!done) l.push([name, entryValue(value, filename)]);
            hideProp(this, '__brDirty', true);
        };
        var iter = function (fd, pick) {
            var l = list(fd).slice(), i = 0;
            var it = { next: function () { return i < l.length ? { value: pick(l[i++]), done: false } : { value: undefined, done: true }; } };
            if (window.Symbol && window.Symbol.iterator) it[window.Symbol.iterator] = function () { return it; };
            return it;
        };
        FP.entries = function () { return iter(this, function (e) { return [e[0], e[1]]; }); };
        FP.keys = function () { return iter(this, function (e) { return e[0]; }); };
        FP.values = function () { return iter(this, function (e) { return e[1]; }); };
        FP.forEach = function (fn, thisArg) { var l = list(this).slice(); for (var i = 0; i < l.length; i++) fn.call(thisArg, l[i][1], l[i][0], this); };
        if (window.Symbol && window.Symbol.iterator) FP[window.Symbol.iterator] = FP.entries;
        try { window.FormData = FD; } catch (e0) {}
        return {
            // the FormData to send: a changed one is built again from its entries
            forSending: function (fd) {
                if (!fd || !fd.__brDirty || !fd.__brList) return fd;
                var fresh = new NativeFD(), l = fd.__brList;
                for (var i = 0; i < l.length; i++) {
                    var v = l[i][1];
                    if (isBlob(v) && v.__brName) nativeAppend.call(fresh, l[i][0], v, v.__brName); else nativeAppend.call(fresh, l[i][0], v);
                }
                return fresh;
            }
        };
    })();

    // form.requestSubmit([submitter]): validation, a cancelable submit event (onsubmit handlers see it), then the
    // submission with the submitter's name and value
    if (window.HTMLFormElement && !window.HTMLFormElement.prototype.requestSubmit) {
        window.HTMLFormElement.prototype.requestSubmit = function (submitter) {
            if (submitter !== undefined && submitter !== null) {
                if (!/^(submit|image)$/i.test(submitter.type || '')) throw new TypeError('The specified element is not a submit button.');
                if (submitter.form !== this) throw domException('NotFoundError', 'The specified element is not owned by this form element.');
            }
            if (!this.noValidate && typeof this.checkValidity === 'function' && !this.checkValidity()) return;
            var ev = document.createEvent('Event');
            ev.initEvent('submit', true, true);
            try { ev.submitter = submitter || null; } catch (e) {}
            if (!this.dispatchEvent(ev)) return;
            var extra = null;
            if (submitter && submitter.name) {
                extra = document.createElement('input');
                extra.type = 'hidden';
                extra.name = submitter.name;
                extra.value = submitter.value || '';
                this.appendChild(extra);
            }
            window.HTMLFormElement.prototype.submit.call(this);
            if (extra && extra.parentNode) extra.parentNode.removeChild(extra);
        };
    }

    // ---- XMLHttpRequest with every responseType. The old engine keeps responseType as an own, non-configurable
    // property of each request that takes only '', text, document and arraybuffer ('blob' is ignored, 'json'
    // throws), so fetch() (which asks for blobs) turned binary answers into text. A request object in front of the
    // native one takes every type: a blob comes from an arraybuffer, json from the text. It also times requests out
    // (the old engine has no timeout).
    (function () {
        var Native = window.XMLHttpRequest;
        if (!Native || Native.__brWrapped || !window.Blob) return;
        var probe = new Native(), accepts = function (t) { try { probe.responseType = t; return probe.responseType === t; } catch (e) { return false; } };
        try { probe.open('GET', location.href, true); } catch (e0) {}
        var nativeBlob = accepts('blob'), nativeJSON = accepts('json'), nativeTimeout = 'ontimeout' in probe;
        try { probe.responseType = ''; } catch (e1) {}
        if (window.__brForceXHR === 'all') nativeBlob = nativeJSON = nativeTimeout = false;   // (tools/xhr-test.html)
        if ((nativeBlob && nativeJSON && nativeTimeout && !window.__brForceXHR) || !accepts('arraybuffer')) return;
        var EVENTS = ['readystatechange', 'loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'];
        var TYPES = { '': 1, text: 1, document: 1, arraybuffer: 1, blob: 1, json: 1 };
        var EventProto = window.ProgressEvent ? window.ProgressEvent.prototype : window.Event ? window.Event.prototype : Object.prototype;
        // the page's handlers see the request object they know as target and this
        var makeEvent = function (type, e, target) {
            var ev;
            try { ev = Object.create(EventProto); } catch (e2) { ev = {}; }
            var own = { type: type, target: target, currentTarget: target, srcElement: target, eventPhase: 2, bubbles: false, cancelable: false,
                        defaultPrevented: false, isTrusted: true, timeStamp: (e && e.timeStamp) || new Date().getTime(),
                        lengthComputable: !!(e && e.lengthComputable), loaded: (e && e.loaded) || 0, total: (e && e.total) || 0 };
            for (var k in own) try { Object.defineProperty(ev, k, { value: own[k], writable: true, configurable: true, enumerable: true }); } catch (e3) { ev[k] = own[k]; }
            ev.preventDefault = function () { this.defaultPrevented = true; };
            ev.stopPropagation = noop;
            ev.stopImmediatePropagation = function () { this.__brStop = true; };
            return ev;
        };
        var rethrow = function (err) { setTimeout(function () { throw err; }, 0); };
        var XHR = function XMLHttpRequest() {
            var self = this, x = new Native();
            this.__x = x;
            this.__type = '';
            this.__on = {};
            this.__value = undefined;
            this.__timer = null;
            this.__timedOut = false;
            this.__timeout = 0;
            for (var i = 0; i < EVENTS.length; i++) (function (type) {
                x.addEventListener(type, function (e) { self.__fire(type, e); }, false);
            })(EVENTS[i]);
        };
        var XP = XHR.prototype;
        XP.__fire = function (type, e) {
            var x = this.__x;
            if (type === 'readystatechange' && x.readyState === 4 && this.__timer) { clearTimeout(this.__timer); this.__timer = null; }
            if (type === 'abort' && this.__timedOut) type = 'timeout';
            var ev = e && e.__brOwnEvent ? e : makeEvent(type, e, this);
            var h = this['on' + type];
            if (typeof h === 'function') { try { h.call(this, ev); } catch (err) { rethrow(err); } }
            var list = this.__on[type];
            if (!list) return;
            list = list.slice();
            for (var i = 0; i < list.length && !ev.__brStop; i++) {
                var l = list[i];
                if (l.once) this.removeEventListener(type, l.fn);
                try { if (typeof l.fn === 'function') l.fn.call(this, ev); else if (l.fn && typeof l.fn.handleEvent === 'function') l.fn.handleEvent(ev); } catch (err2) { rethrow(err2); }
            }
        };
        XP.addEventListener = function (type, fn, opts) {
            if (!fn) return;
            var list = this.__on[type] || (this.__on[type] = []);
            for (var i = 0; i < list.length; i++) if (list[i].fn === fn) return;
            list.push({ fn: fn, once: !!(opts && typeof opts === 'object' && opts.once) });
        };
        XP.removeEventListener = function (type, fn) {
            var list = this.__on[type];
            if (list) for (var i = 0; i < list.length; i++) if (list[i].fn === fn) { list.splice(i, 1); return; }
        };
        XP.dispatchEvent = function (ev) {
            try { ev.__brOwnEvent = true; } catch (e) {}
            this.__fire(ev.type, ev);
            return !ev.defaultPrevented;
        };
        XP.open = function (method, url) {
            this.__value = undefined;
            this.__timedOut = false;
            this.__async = arguments.length < 3 || !!arguments[2];
            // a blob: URL of a blob made on this page is answered here (the engine cannot read them)
            var blob = BlobTools && /^blob:/i.test(String(url)) && /^get$/i.test(String(method)) ? BlobTools.forURL(String(url)) : null;
            var known = blob ? BlobTools.bytes(blob) : null;
            if (known) {
                this.__fake = { state: 1, bytes: known, type: blob.type || '', blob: blob, mime: '' };
                this.__fire('readystatechange');
                return;
            }
            this.__fake = null;
            this.__ct = false;
            var opened = this.__x.open.apply(this.__x, arguments);
            // (what was set before open, see withCredentials)
            if (this.__wc !== undefined) try { this.__x.withCredentials = this.__wc; } catch (e1) {}
            if (this.__type) {
                var t = this.__type, n = (t === 'blob' && !nativeBlob) ? 'arraybuffer' : (t === 'json' && !nativeJSON) ? 'text' : t;
                try { if (this.__x.responseType !== n) this.__x.responseType = n; } catch (e2) {}
            }
            return opened;
        };
        XP.send = function (body) {
            var self = this, x = this.__x, f = this.__fake;
            if (f) {
                var n = f.bytes.length, progress = { lengthComputable: true, loaded: n, total: n };
                var finish = function () {
                    if (f.aborted) return;
                    f.state = 2; self.__fire('readystatechange');
                    f.state = 3; self.__fire('readystatechange');
                    f.state = 4; self.__fire('readystatechange');
                    self.__fire('load', progress);
                    self.__fire('loadend', progress);
                };
                self.__fire('loadstart', { lengthComputable: true, loaded: 0, total: n });
                if (this.__async) setTimeout(finish, 0); else finish();
                return;
            }
            if (this.__timeout > 0 && this.__async && !nativeTimeout) {
                this.__timer = setTimeout(function () { self.__timer = null; if (x.readyState !== 4) { self.__timedOut = true; x.abort(); } }, this.__timeout);
            }
            if (FormDataTools && body) body = FormDataTools.forSending(body);
            // the type today's browsers give a text or URLSearchParams body the page did not type (the old engine sends
            // text as application/xml, URLSearchParams as its text the same way; servers parse by the type)
            if (!this.__ct && body !== null && body !== undefined) {
                var USP = window.URLSearchParams;
                if (typeof body === 'string') { try { x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8'); } catch (e3) {} }
                else if (USP && body instanceof USP) { body = String(body); try { x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8'); } catch (e4) {} }
            }
            return arguments.length ? x.send(body) : x.send();
        };
        XP.abort = function () {
            if (this.__timer) { clearTimeout(this.__timer); this.__timer = null; }
            var f = this.__fake;
            if (f) {
                if (f.aborted || f.state === 4) return;
                f.aborted = true;
                f.state = 4; this.__fire('readystatechange');
                this.__fire('abort');
                this.__fire('loadend');
                f.state = 0;
                return;
            }
            return this.__x.abort();
        };
        // (the bytes as the text of a response: UTF-8, or one character per byte for x-user-defined)
        var fakeText = function (f) {
            var b = f.bytes, s = '', chunk = 8192, user = /x-user-defined/i.test(f.mime);
            for (var i = 0; i < b.length; i += chunk) {
                var part = b.subarray(i, Math.min(b.length, i + chunk)), codes = [];
                for (var k = 0; k < part.length; k++) codes.push(user && part[k] >= 0x80 ? 0xF700 + part[k] : part[k]);
                s += String.fromCharCode.apply(null, codes);
            }
            if (user) return s;
            try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
        };
        XP.setRequestHeader = function (name) {
            if (this.__fake) return;
            if (String(name).toLowerCase() === 'content-type') this.__ct = true;
            return this.__x.setRequestHeader.apply(this.__x, arguments);
        };
        XP.overrideMimeType = function (m) { if (this.__fake) { this.__fake.mime = String(m); return; } return this.__x.overrideMimeType.apply(this.__x, arguments); };
        XP.getResponseHeader = function (name) {
            var f = this.__fake;
            if (!f) return this.__x.getResponseHeader.apply(this.__x, arguments);
            if (f.state < 2) return null;
            var n = String(name).toLowerCase();
            return n === 'content-type' ? f.type || null : n === 'content-length' ? String(f.bytes.length) : null;
        };
        XP.getAllResponseHeaders = function () {
            var f = this.__fake;
            if (!f) return this.__x.getAllResponseHeaders.apply(this.__x, arguments);
            return f.state < 2 ? '' : (f.type ? 'Content-Type: ' + f.type + '\r\n' : '') + 'Content-Length: ' + f.bytes.length + '\r\n';
        };
        var fakeGetters = {
            readyState: function (f) { return f.state; },
            status: function (f) { return f.state >= 2 && !f.aborted ? 200 : 0; },
            statusText: function (f) { return f.state >= 2 && !f.aborted ? 'OK' : ''; },
            responseText: function (f) { return f.state === 4 && !f.aborted ? (f.text !== undefined ? f.text : (f.text = fakeText(f))) : ''; },
            responseXML: function () { return null; },
            responseURL: function (f) { return ''; },
            upload: function (f, x) { return x.upload; }
        };
        var getters = ['readyState', 'status', 'statusText', 'responseText', 'responseXML', 'responseURL', 'upload'];
        for (var g = 0; g < getters.length; g++) (function (name) {
            Object.defineProperty(XP, name, { get: function () { return this.__fake ? fakeGetters[name](this.__fake, this.__x) : this.__x[name]; }, configurable: true, enumerable: true });
        })(getters[g]);
        // (withCredentials and responseType before open(): today's XHR takes them, the old engine throws INVALID_STATE_ERR
        // (TikTok's request library sets them first); kept, and given to the native request once it is opened)
        Object.defineProperty(XP, 'withCredentials', {
            get: function () { return this.__wc !== undefined ? this.__wc : this.__x.withCredentials; },
            set: function (v) { this.__wc = !!v; try { this.__x.withCredentials = !!v; } catch (e) {} },
            configurable: true, enumerable: true
        });
        Object.defineProperty(XP, 'timeout', {
            get: function () { return nativeTimeout ? this.__x.timeout : this.__timeout; },
            set: function (v) { if (nativeTimeout) this.__x.timeout = v; else this.__timeout = Math.max(0, Number(v) || 0); },
            configurable: true, enumerable: true
        });
        Object.defineProperty(XP, 'responseType', {
            get: function () { return this.__type; },
            set: function (t) {
                t = String(t);
                if (!TYPES[t]) return;
                var n = (t === 'blob' && !nativeBlob) ? 'arraybuffer' : (t === 'json' && !nativeJSON) ? 'text' : t;
                if (!this.__fake) try { this.__x.responseType = n; } catch (e) {}
                this.__type = t;
                this.__value = undefined;
            },
            configurable: true, enumerable: true
        });
        Object.defineProperty(XP, 'response', {
            get: function () {
                var x = this.__x, t = this.__type, f = this.__fake;
                if (f) {
                    if (t === '' || t === 'text') return this.responseText;
                    if (f.state !== 4 || f.aborted) return null;
                    if (t === 'arraybuffer') return f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.length);
                    if (t === 'blob') return f.blob;
                    if (t === 'json') { try { return JSON.parse(this.responseText); } catch (e0) { return null; } }
                    return null;
                }
                if ((t === 'blob' && !nativeBlob) || (t === 'json' && !nativeJSON)) {
                    if (x.readyState !== 4) return null;
                    if (this.__value === undefined) {
                        if (t === 'blob') {
                            var type = (x.getResponseHeader('Content-Type') || '').toLowerCase();
                            this.__value = x.response ? new Blob([x.response], { type: type }) : null;
                        } else {
                            var text = x.responseText;
                            try { this.__value = text ? JSON.parse(text) : null; } catch (e) { this.__value = null; }
                        }
                    }
                    return this.__value;
                }
                return 'response' in x ? x.response : x.responseText;
            },
            configurable: true, enumerable: true
        });
        for (var h = 0; h < EVENTS.length; h++) XP['on' + EVENTS[h]] = null;
        var STATES = ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'];
        for (var s = 0; s < STATES.length; s++) { XHR[STATES[s]] = s; XP[STATES[s]] = s; }
        XP.toString = function () { return '[object XMLHttpRequest]'; };
        XHR.__brWrapped = true;
        XHR.__brNative = Native;
        window.XMLHttpRequest = XHR;
    })();

    // ---- New tabs: window.open and target=_blank links go to the app (brtab: scheme handled natively)
    function sendToApp(scheme, payload) {
        try {
            var f = document.createElement('iframe');
            f.style.display = 'none';
            f.src = scheme + ':' + encodeURIComponent(payload);
            (document.body || document.documentElement).appendChild(f);
            setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 100);
            return true;
        } catch (e) { return false; }
    }
    function absoluteURL(url) {
        try { var a = document.createElement('a'); a.href = String(url); return a.href; } catch (e) { return String(url); }
    }
    function openInNewTab(url) {
        url = absoluteURL(url);
        if (!/^https?:/i.test(url)) return false;
        return sendToApp('brtab', url);
    }
    function frameExists(name) { try { return !!window.frames[name]; } catch (e) { return false; } }
    // The page's diagnostics for the app's log (brlog:) - load timing, errors, refused popups - only on a developer's
    // device, where the app puts window.__brDebugLog at the start of the polyfills: elsewhere nothing logs them, and
    // each would cost the page a hidden frame (and the timing a timer a second) for nothing
    var brDebugLog = !!window.__brDebugLog;
    // Popup blocking: window.open only counts within a moment of a tap, click or key press
    var lastGesture = 0, blockedPopups = 0;
    function noteGesture() { lastGesture = Date.now(); }
    var gestureEvents = ['touchend', 'click', 'keydown', 'mouseup', 'submit'];
    for (var ge = 0; ge < gestureEvents.length; ge++) document.addEventListener(gestureEvents[ge], noteGesture, true);
    window.open = function (url, name, features) {
        if (name === '_self' || name === '_top' || name === '_parent') { if (url) window.location.href = url; return window; }
        if (name && frameExists(name)) { try { window.frames[name].location.href = url; } catch (e) {} return window.frames[name]; }
        if (Date.now() - lastGesture > 2000) {
            if (brDebugLog && blockedPopups++ < 3) sendToApp('brlog', 'Popup blocked: ' + String(url || '').slice(0, 200));
            return null;
        }
        if (!url || url === 'about:blank' || String(url).charAt(0) === '#') url = '';
        var fake = { closed: false, focus: noop, blur: noop, postMessage: noop, opener: window, name: name || '', addEventListener: noop, removeEventListener: noop,
                     document: { write: noop, writeln: noop, close: noop, open: noop, body: null, title: '' } };
        fake.close = function () { fake.closed = true; };
        var loc = { assign: function (v) { loc.href = v; }, replace: function (v) { loc.href = v; }, toString: function () { return loc.__h || ''; } };
        try {
            Object.defineProperty(loc, 'href', { get: function () { return loc.__h || ''; }, set: function (v) { loc.__h = String(v); openInNewTab(v); } });
            Object.defineProperty(fake, 'location', { get: function () { return loc; }, set: function (v) { loc.href = String(v); } });
        } catch (e) { fake.location = loc; }
        if (url) openInNewTab(url);
        return fake;
    };
    document.addEventListener('click', function (e) {
        if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey) return;
        var a = e.target;
        while (a && a.nodeType === 1 && a.tagName !== 'A' && a.tagName !== 'AREA') a = a.parentNode;
        if (!a || a.nodeType !== 1) return;
        var target = (a.getAttribute('target') || '').toLowerCase();
        var href = a.getAttribute('href');
        if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
        if (target === '_blank' || (target && target !== '_self' && target !== '_top' && target !== '_parent' && !frameExists(target))) {
            if (openInNewTab(a.href)) e.preventDefault();
        }
    }, false);
    // Load timing for the app's log: when the DOM was ready, when the page finished, and the longest stretch
    // during which the engine was too busy to run a 1 s timer (JavaScript or layout work).
    var brT0 = Date.now(), lastTick = brT0, maxGap = 0, maxGapAt = 0, tickTimer = null;
    if (brDebugLog) {
        tickTimer = setInterval(function () { var now = Date.now(), gap = now - lastTick - 1000; if (gap > maxGap) { maxGap = gap; maxGapAt = lastTick - brT0; } lastTick = now; }, 1000);
        document.addEventListener('DOMContentLoaded', function () { sendToApp('brlog', 'timing: DOMContentLoaded after ' + (Date.now() - brT0) + ' ms, busy gap so far ' + maxGap + ' ms'); }, false);
        window.addEventListener('load', function () {
            sendToApp('brlog', 'timing: load after ' + (Date.now() - brT0) + ' ms, longest busy gap ' + maxGap + ' ms at ' + maxGapAt + ' ms, scripts ' + document.scripts.length + ', errors ' + reportedErrors + ', nodes ' + document.getElementsByTagName('*').length);
            setTimeout(function () { clearInterval(tickTimer); tickTimer = null; }, 30000);
        }, false);
    }
    // Uncaught errors of the page reach the app's log (brlog: scheme) so that broken sites can be diagnosed over SSH
    var reportedErrors = 0;
    window.addEventListener('error', function (e) {
        // (a script of its own URL that does not parse: the app drops its cached copy, so that the next visit gets it
        // lowered again - IKEA's recommendation chunks sat in the cache as they came, with a year to live)
        var file = e.filename || '';
        if (/SyntaxError/.test(e.message || '') && /^https?:/.test(file) && file.split('#')[0] !== location.href.split('#')[0]) sendToApp('brevict', file);
        if (!brDebugLog || reportedErrors >= 5) return;
        reportedErrors++;
        var src = (e.filename || '').split('/').slice(-1)[0];
        sendToApp('brlog', 'JS error: ' + (e.message || 'error') + ' @ ' + src + ':' + (e.lineno || 0) + ' page ' + location.hostname);
    }, false);
    // Debugging (BRDebugJSErrors in the app puts window.__brDebugErrors at the start of the polyfills): errors of
    // scripts from other hosts reach onerror only as "Script error.", so callbacks (timers, animation frames, event
    // listeners) and promise rejections are caught here, where the real error is visible, logged and thrown again.
    if (window.__brDebugErrors) (function () {
        var logged = 0;
        var describe = function (err) {
            if (!err || typeof err !== 'object') return String(err);
            var where = err.sourceURL ? ' @ ' + String(err.sourceURL).split('/').slice(-1)[0] + ':' + (err.line || 0) : '';
            var stack = typeof err.stack === 'string' ? ' | ' + err.stack.split('\n').slice(0, 4).join(' < ') : '';
            return (err.name || 'Error') + ': ' + (err.message || '') + where + stack;
        };
        var report = function (kind, err) {
            if (logged >= 20 || (err && err.__brLogged)) return;
            logged++;
            try { if (err && typeof err === 'object') err.__brLogged = true; } catch (e) {}
            sendToApp('brlog', 'JS debug (' + kind + '): ' + describe(err).slice(0, 600) + ' page ' + location.hostname);
        };
        // (and the callbacks that keep the page busy for long: which one, with the start of its text)
        var slow = 0;
        var noteSlow = function (what, ms, text) {
            if (ms < 1500 || slow >= 15) return;
            slow++;
            sendToApp('brlog', 'JS debug (slow ' + what + '): ' + ms + ' ms' + (text ? ' in ' + String(text).replace(/\s+/g, ' ').slice(0, 900) : '') + ' page ' + location.hostname);
        };
        window.__brNoteSlow = noteSlow;
        var guard = function (fn, kind) {
            if (typeof fn !== 'function') return fn;
            if (fn.__brGuard) return fn.__brGuard;
            var g = function () {
                var t0 = Date.now();
                try { return fn.apply(this, arguments); } catch (err) { report(kind, err); throw err; } finally { noteSlow(kind, Date.now() - t0, fn); }
            };
            try { Object.defineProperty(fn, '__brGuard', { value: g, configurable: true }); } catch (e) {}
            return g;
        };
        // a script that ran long: its load event comes long after the last tick of the busy-gap timer
        document.addEventListener('load', function (e) {
            var s = e.target;
            if (!s || s.tagName !== 'SCRIPT' || !tickTimer) return;
            noteSlow('script',Date.now() - lastTick - 1000, 'since the last tick, up to the load of ' + (s.src || 'an inline script'));
        }, true);
        var timers = ['setTimeout', 'setInterval', 'requestAnimationFrame', 'webkitRequestAnimationFrame', 'queueMicrotask', 'setImmediate', 'requestIdleCallback'];
        for (var t = 0; t < timers.length; t++) (function (name) {
            var orig = window[name];
            if (typeof orig !== 'function') return;
            window[name] = function (fn) { var args = Array.prototype.slice.call(arguments); args[0] = guard(fn, name); return orig.apply(this, args); };
        })(timers[t]);
        var owners = [window.Node && window.Node.prototype, window, window.XMLHttpRequest && window.XMLHttpRequest.prototype];
        for (var o = 0; o < owners.length; o++) (function (owner) {
            if (!owner || !owner.addEventListener) return;
            var add = owner.addEventListener, remove = owner.removeEventListener;
            owner.addEventListener = function (type, fn, opts) { return add.call(this, type, typeof fn === 'function' ? guard(fn, type) : fn, opts); };
            owner.removeEventListener = function (type, fn, opts) { return remove.call(this, type, typeof fn === 'function' && fn.__brGuard ? fn.__brGuard : fn, opts); };
        })(owners[o]);
        window.addEventListener('unhandledrejection', function (e) { report('promise', e && (e.reason !== undefined ? e.reason : e.detail)); }, false);
        window.addEventListener('error', function (e) { if (e && e.error) report('onerror', e.error); }, false);
        // errors a library catches itself (React's error boundaries: Next.js then shows "This page couldn't load") end
        // in console.error
        if (window.console && typeof window.console.error === 'function') {
            var origConsoleError = window.console.error;
            window.console.error = function () {
                try {
                    if (logged < 20) {
                        var parts = [];
                        for (var i = 0; i < arguments.length && i < 4; i++) {
                            var a = arguments[i];
                            parts.push(a && typeof a === 'object' && (a.message !== undefined || a.stack) ? describe(a) : String(a).slice(0, 300));
                            if (a && typeof a === 'object') { try { a.__brLogged = true; } catch (e1) {} }
                        }
                        logged++;
                        sendToApp('brlog', 'JS debug (console.error): ' + parts.join(' ').slice(0, 700) + ' page ' + location.hostname);
                    }
                } catch (e2) {}
                return origConsoleError.apply(window.console, arguments);
            };
        }
    })();
    // Web Share goes to the app's share sheet
    if (!navigator.share) {
        navigator.share = function (data) {
            data = data || {};
            // (the app's share sheet opens only within 5 s of the user's tap on the page, see the clipboard below)
            if (Date.now() - lastGesture >= 5000) return rejectWith('NotAllowedError', 'share needs a tap of the user')();
            var ok = sendToApp('brshare', JSON.stringify({ title: data.title || '', text: data.text || '', url: data.url ? absoluteURL(data.url) : '' }));
            return ok ? resolved() : rejectWith('AbortError', 'share failed')();
        };
        navigator.canShare = function (data) { return !!(data && (data.url || data.text || data.title)); };
    }
    // Clipboard writes go to the system pasteboard through the app; window.print() opens the print dialog
    try {
        navigator.clipboard = {
            // (the app copies only within 5 s of the user's tap on the page, as browsers want a user activation: later the
            // page hears that it failed)
            writeText: function (text) { return Date.now() - lastGesture < 5000 && sendToApp('brcopy', String(text)) ? resolved() : rejectWith('NotAllowedError', 'copy failed')(); },
            write: function () { return rejectWith('NotAllowedError', 'only text can be copied')(); },
            readText: function () { return rejectWith('NotAllowedError', 'reading the clipboard is not allowed')(); },
            read: function () { return rejectWith('NotAllowedError', 'reading the clipboard is not allowed')(); }
        };
        window.print = function () { sendToApp('brprint', '1'); };
    } catch (e) {}   // a desktop browser (the smoke test) has a read-only navigator.clipboard
    try {
        var execCommandOrig = document.execCommand;
        document.execCommand = function (cmd) {
            var r = false;
            try { r = execCommandOrig.apply(document, arguments); } catch (e) {}
            if (String(cmd).toLowerCase() === 'copy') {
                var t = String(window.getSelection()), a = document.activeElement;
                if (!t && a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') && typeof a.selectionStart === 'number') t = String(a.value || '').substring(a.selectionStart, a.selectionEnd);
                if (t) { sendToApp('brcopy', t); r = true; }
            }
            return r;
        };
    } catch (e) {}

    // ---- Pointer events: touches and mouse events are mirrored as pointer events
    if (!window.PointerEvent) {
        var nextPointerId = 2, activeTouches = {}, activeTouchCount = 0, lastTouchTime = 0;
        var makePointerEvent = function makePointerEvent(type, src, touch, pointerType, id, isPrimary) {
            var e = document.createEvent('MouseEvents');
            var bubbles = type !== 'pointerenter' && type !== 'pointerleave';
            var cancelable = type !== 'pointercancel' && type !== 'pointerenter' && type !== 'pointerleave';
            e.initMouseEvent(type, bubbles, cancelable, window, 0,
                touch ? touch.screenX : (src.screenX || 0), touch ? touch.screenY : (src.screenY || 0),
                touch ? touch.clientX : (src.clientX || 0), touch ? touch.clientY : (src.clientY || 0),
                !!src.ctrlKey, !!src.altKey, !!src.shiftKey, !!src.metaKey, src.button || 0, src.relatedTarget || null);
            e.pointerId = id;
            e.pointerType = pointerType;
            e.isPrimary = isPrimary;
            e.width = e.height = pointerType === 'touch' ? 20 : 1;
            e.pressure = (type === 'pointerdown' || (type === 'pointermove' && (pointerType === 'touch' || src.buttons))) ? 0.5 : 0;
            e.tangentialPressure = 0;
            e.tiltX = e.tiltY = e.twist = 0;
            e.buttons = (type === 'pointerup' || type === 'pointercancel') ? 0 : (src.buttons !== undefined ? src.buttons : (type === 'pointermove' && pointerType === 'mouse' ? 0 : 1));
            e.getCoalescedEvents = function () { return [e]; };
            e.getPredictedEvents = function () { return []; };
            return e;
        };
        var touchHandler = function touchHandler(type) {
            return function (ev) {
                lastTouchTime = Date.now();
                var touches = ev.changedTouches;
                for (var i = 0; i < touches.length; i++) {
                    var t = touches[i], key = 't' + t.identifier;
                    if (!activeTouches[key]) { activeTouches[key] = { id: nextPointerId++, primary: activeTouchCount === 0 }; activeTouchCount++; }
                    var info = activeTouches[key];
                    var target = t.target && t.target.nodeType === 1 ? t.target : (t.target && t.target.parentNode) || ev.target;
                    var pe = makePointerEvent(type, ev, t, 'touch', info.id, info.primary);
                    try { target.dispatchEvent(pe); } catch (e) {}
                    if (pe.defaultPrevented && ev.cancelable) ev.preventDefault();
                    if (type === 'pointerup' || type === 'pointercancel') { delete activeTouches[key]; activeTouchCount = Math.max(0, activeTouchCount - 1); }
                }
            };
        };
        document.addEventListener('touchstart', touchHandler('pointerdown'), true);
        document.addEventListener('touchmove', touchHandler('pointermove'), true);
        document.addEventListener('touchend', touchHandler('pointerup'), true);
        document.addEventListener('touchcancel', touchHandler('pointercancel'), true);
        var mouseMap = { mousedown: 'pointerdown', mousemove: 'pointermove', mouseup: 'pointerup', mouseover: 'pointerover', mouseout: 'pointerout' };
        for (var mname in mouseMap) (function (mtype, ptype) {
            document.addEventListener(mtype, function (ev) {
                if (Date.now() - lastTouchTime < 1500) return;   // mouse events synthesized from a tap
                var pe = makePointerEvent(ptype, ev, null, 'mouse', 1, true);
                try { ev.target.dispatchEvent(pe); } catch (e) {}
                if (pe.defaultPrevented && ev.cancelable) ev.preventDefault();
            }, true);
        })(mname, mouseMap[mname]);
        window.PointerEvent = function PointerEvent(type, init) {
            init = init || {};
            return makePointerEvent(type, init, null, init.pointerType || 'mouse', init.pointerId || 1, init.isPrimary !== false);
        };
        if (Ep) {
            Ep.setPointerCapture = noop;
            Ep.releasePointerCapture = noop;
            Ep.hasPointerCapture = function () { return false; };
        }
        if (!('maxTouchPoints' in navigator)) try { navigator.maxTouchPoints = 'ontouchstart' in window ? 5 : 0; } catch (e) {}
        var pointerNames = ['pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointercancel', 'gotpointercapture', 'lostpointercapture'];
        var defineHandlerProps = function defineHandlerProps(obj) {
            if (!obj || ('onpointerdown' in obj)) return;
            for (var i = 0; i < pointerNames.length; i++) (function (type) {
                try {
                    Object.defineProperty(obj, 'on' + type, {
                        get: function () { return this['__on' + type] || null; },
                        set: function (fn) {
                            var old = this['__on' + type];
                            if (old) this.removeEventListener(type, old, false);
                            this['__on' + type] = typeof fn === 'function' ? fn : null;
                            if (fn) this.addEventListener(type, fn, false);
                        },
                        configurable: true
                    });
                } catch (e) {}
            })(pointerNames[i]);
        };
        defineHandlerProps(window);
        defineHandlerProps(document);
        defineHandlerProps(Ep);
    }
    // the app shows its own menu on a long press over links and images
    try { document.documentElement.style.webkitTouchCallout = 'none'; } catch (e) {}

    // ---- Page visibility
    if (!('hidden' in document) && !('webkitHidden' in document)) {
        var pageHidden = false;
        try {
            Object.defineProperty(document, 'hidden', { get: function () { return pageHidden; }, configurable: true });
            Object.defineProperty(document, 'visibilityState', { get: function () { return pageHidden ? 'hidden' : 'visible'; }, configurable: true });
            Object.defineProperty(document, 'webkitHidden', { get: function () { return pageHidden; }, configurable: true });
            Object.defineProperty(document, 'webkitVisibilityState', { get: function () { return pageHidden ? 'hidden' : 'visible'; }, configurable: true });
        } catch (e) {}
        document.onvisibilitychange = null;
        window.addEventListener('pagehide', function () { pageHidden = true; fire(document, 'visibilitychange'); }, false);
        window.addEventListener('pageshow', function () { pageHidden = false; fire(document, 'visibilitychange'); }, false);
    }

    // ---- Fullscreen: videos use the native player, other elements are pinned to the viewport
    if (!('fullscreenEnabled' in document) && !('webkitFullscreenEnabled' in document)) {
        var fsElement = null;
        try {
            Object.defineProperty(document, 'fullscreenEnabled', { get: function () { return true; }, configurable: true });
            Object.defineProperty(document, 'webkitFullscreenEnabled', { get: function () { return true; }, configurable: true });
            Object.defineProperty(document, 'fullscreenElement', { get: function () { return fsElement; }, configurable: true });
            Object.defineProperty(document, 'webkitFullscreenElement', { get: function () { return fsElement; }, configurable: true });
            Object.defineProperty(document, 'webkitCurrentFullScreenElement', { get: function () { return fsElement; }, configurable: true });
            Object.defineProperty(document, 'fullscreen', { get: function () { return !!fsElement; }, configurable: true });
            Object.defineProperty(document, 'webkitIsFullScreen', { get: function () { return !!fsElement; }, configurable: true });
        } catch (e) {}
        document.onfullscreenchange = null;
        document.onfullscreenerror = null;
        var leaveFullscreen = function leaveFullscreen() {
            var el = fsElement;
            fsElement = null;
            if (!el) return resolved();
            setStateClass(el, 'br-fullscreen', false);
            if (el.tagName === 'VIDEO' && el.webkitExitFullscreen) { try { el.webkitExitFullscreen(); } catch (e) {} }
            else {
                el.style.cssText = el.__brFsStyle || '';
                if (el.__brFsScroll !== undefined) try { window.scrollTo(0, el.__brFsScroll); } catch (e2) {}
                el.__brFsStyle = undefined;
            }
            fire(document, 'fullscreenchange');
            fire(document, 'webkitfullscreenchange');
            fire(el, 'fullscreenchange');
            return resolved();
        };
        document.exitFullscreen = document.webkitExitFullscreen = document.webkitCancelFullScreen = leaveFullscreen;
        if (Ep) Ep.requestFullscreen = Ep.webkitRequestFullscreen = Ep.webkitRequestFullScreen = function () {
            var el = this;
            if (fsElement && fsElement !== el) leaveFullscreen();
            fsElement = el;
            setStateClass(el, 'br-fullscreen', true);
            if (el.tagName === 'VIDEO' && el.webkitEnterFullscreen) {
                try { el.webkitEnterFullscreen(); } catch (e) {}
                el.addEventListener('webkitendfullscreen', function onEnd() { el.removeEventListener('webkitendfullscreen', onEnd, false); if (fsElement === el) leaveFullscreen(); }, false);
            } else {
                el.__brFsStyle = el.style.cssText;
                el.__brFsScroll = window.pageYOffset;
                el.style.cssText += ';position:fixed !important;top:0 !important;left:0 !important;width:100% !important;height:100% !important;max-width:none !important;max-height:none !important;margin:0 !important;z-index:2147483647 !important;background:#000';
                try { window.scrollTo(0, 0); } catch (e3) {}
            }
            fire(document, 'fullscreenchange');
            fire(document, 'webkitfullscreenchange');
            fire(el, 'fullscreenchange');
            return resolved();
        };
        document.addEventListener('keydown', function (e) { if (e.keyCode === 27 && fsElement) leaveFullscreen(); }, false);
    }

    // ---- Gamepad, pointer lock, VR
    if (!navigator.getGamepads) navigator.getGamepads = navigator.webkitGetGamepads = function () { return []; };
    if (!window.Gamepad) window.Gamepad = function Gamepad() {};
    if (!window.GamepadEvent) window.GamepadEvent = function GamepadEvent() {};
    if (Ep && !Ep.requestPointerLock) {
        Ep.requestPointerLock = Ep.webkitRequestPointerLock = function () { setTimeout(function () { fire(document, 'pointerlockerror'); }, 0); };
        document.exitPointerLock = document.webkitExitPointerLock = noop;
        try { Object.defineProperty(document, 'pointerLockElement', { get: function () { return null; }, configurable: true }); } catch (e) {}
    }
    if (!navigator.getVRDisplays) navigator.getVRDisplays = function () { return resolved([]); };
    if (!navigator.xr) navigator.xr = { isSessionSupported: function () { return resolved(false); }, requestSession: rejectWith('NotSupportedError', 'WebXR is not available'), addEventListener: noop, removeEventListener: noop };

    // ---- Web components: shadow roots live in the light DOM, custom elements are upgraded by prototype swap
    if (Ep && !Ep.attachShadow) {
        window.ShadowRoot = window.ShadowRoot || function ShadowRoot() {};
        window.HTMLSlotElement = window.HTMLSlotElement || function HTMLSlotElement() {};
        Ep.attachShadow = function (init) {
            if (this.shadowRoot) return this.shadowRoot;
            // (from now on addEventListener asks whether its target is a slot: it costs a DOM call a listener)
            window.__brShadowUsed = true;
            var host = this;
            var inline = /^(span|a|b|i|em|strong|label|button|small|code)$/i.test(host.tagName);
            var root = document.createElement(inline ? 'span' : 'div');
            root.setAttribute('data-shadow-root', '');
            root.host = host;
            root.mode = (init && init.mode) || 'open';
            root.delegatesFocus = !!(init && init.delegatesFocus);
            // (constructed sheets adopted here get <style> copies inside the root, see the constructable stylesheets; so
            // do the sheets the host's tag claimed, see __brHostSheets)
            var rootSheets = [];
            var allSheets = function () {
                var extra = window.__brHostSheets ? window.__brHostSheets.forTag(host.tagName.toLowerCase()) : [];
                return extra.length ? rootSheets.concat(extra) : rootSheets;
            };
            root.__brRestyle = function () { if (window.__brAdoptInto) window.__brAdoptInto(root, allSheets()); };
            try {
                Object.defineProperty(root, 'adoptedStyleSheets', { configurable: true, get: function () { return rootSheets; },
                    set: function (v) { rootSheets = v ? Array.prototype.slice.call(v) : []; root.__brRestyle(); } });
            } catch (e0) { root.adoptedStyleSheets = []; }
            // the first children the root gets claim the component sheets a library put in the document just before
            var nativeInsert = root.insertBefore, nativeAppend = root.appendChild;
            var claim = function () { var hs = window.__brHostSheets; if (hs) { hs.claim(host); hs.sync(root, host); } };
            root.insertBefore = function (node, ref) { claim(); return nativeInsert.call(this, node, ref === undefined ? null : ref); };
            root.appendChild = function (node) { claim(); return nativeAppend.call(this, node); };
            root.getElementById = function (id) { return root.querySelector('[id="' + String(id).replace(/"/g, '\\"') + '"]'); };
            root.elementFromPoint = function (x, y) { return document.elementFromPoint(x, y); };
            root.elementsFromPoint = function (x, y) { var el = document.elementFromPoint(x, y); return el ? [el] : []; };
            root.getSelection = function () { return document.getSelection(); };
            try { Object.defineProperty(root, 'activeElement', { get: function () { return document.activeElement; } }); } catch (e) {}
            host.appendChild(root);
            try { Object.defineProperty(host, 'shadowRoot', { value: root, configurable: true, writable: true }); } catch (e2) { host.shadowRoot = root; }
            if (window.__brHostSheets) window.__brHostSheets.sync(root, host);
            return root;
        };
        // (an element without a root answers null, as today: Reddit's `e.shadowRoot !== null` held for undefined, and
        // then 'undefined' is not an object (evaluating 'e.shadowRoot.mode'); a host has its root as its own property)
        if (!('shadowRoot' in Ep)) try { Object.defineProperty(Ep, 'shadowRoot', { configurable: true, get: function () { return null; } }); } catch (eSR) {}
        addStyle('[data-shadow-root]{display:inherit}');
        // A slot's nodes stay where they are in the host (nothing is projected), so a slot that is not shown (display:
        // none from the root's styles or its hidden attribute) hides them here: developer.mozilla.org's language menu
        // (hidden by ":host(:not([loaded],:focus-within)) slot[name=dropdown]{display:none}") stood open on every page.
        // Run by the style passes and after taps and focus changes (menus open on them).
        var slotShown = function (slot, root) {
            for (var n = slot; n && n !== root; n = n.parentNode) if (n.nodeType === 1 && getComputedStyle(n).display === 'none') return false;
            return true;
        };
        var syncSlots = function () {
            var slots = document.querySelectorAll('[data-shadow-root] slot');
            for (var i = 0; i < slots.length; i++) {
                var slot = slots[i], root = slot.parentNode;
                while (root && !(root.nodeType === 1 && root.hasAttribute('data-shadow-root'))) root = root.parentNode;
                var host = root && root.host;
                if (!host) continue;
                var shown = slotShown(slot, root), name = slot.getAttribute('name') || '';
                for (var c = host.firstChild; c; c = c.nextSibling) {
                    if (c.nodeType !== 1 || c === root || (c.getAttribute('slot') || '') !== name) continue;
                    if (!shown && !c.__brSlotHid) {
                        c.__brSlotHid = [c.style.getPropertyValue('display'), c.style.getPropertyPriority('display')];
                        c.style.setProperty('display', 'none', 'important');
                    } else if (shown && c.__brSlotHid) {
                        if (c.__brSlotHid[0]) c.style.setProperty('display', c.__brSlotHid[0], c.__brSlotHid[1]); else c.style.removeProperty('display');
                        c.__brSlotHid = null;
                    }
                }
            }
        };
        window.__brSyncSlots = syncSlots;
        // Events of a slot's nodes: they are not inside the slot here, so the listeners of a slot (a menu that opens on a
        // click on its slotted button: mdn-dropdown) are called by one on the document for the events that come from the
        // slot's nodes, as the path of an event goes through the slot in a real shadow tree.
        var slotTypes = {};
        var slotOf = function (node) {   // the slot a light child of a host goes to
            var host = node.parentNode, root = host && host.shadowRoot;
            if (!root || root.nodeType !== 1 || root === node || !root.hasAttribute('data-shadow-root')) return null;
            var name = node.nodeType === 1 ? node.getAttribute('slot') || '' : '', slots = root.getElementsByTagName('slot');
            for (var i = 0; i < slots.length; i++) if ((slots[i].getAttribute('name') || '') === name) return slots[i];
            return null;
        };
        var runSlotListeners = function (e, capture) {
            for (var n = e.target; n && n !== document; n = n.parentNode) {
                var slot = slotOf(n);
                if (!slot || !slot.__brSlotL) continue;
                var list = slot.__brSlotL.slice(0);
                for (var i = 0; i < list.length; i++) {
                    var r = list[i];
                    if (r.type !== e.type || r.capture !== capture) continue;
                    try { if (typeof r.fn === 'function') r.fn.call(slot, e); else r.fn.handleEvent(e); } catch (err) { setTimeout(function () { throw err; }, 0); }
                }
            }
        };
        // What a slot gets: the host's children with its name in their slot attribute (text goes to the default slot),
        // for the first slot of that name in the root only; with flatten, a slot's own children when nothing goes to it
        // and the nodes of the slots among them. (Reddit's tab groups and menus read them: "'undefined' is not a
        // function (evaluating 't.assignedElements({flatten:!0})')".)
        var rootOfSlot = function (slot) {
            var root = slot.parentNode;
            while (root && !(root.nodeType === 1 && root.hasAttribute('data-shadow-root'))) root = root.parentNode;
            return root;
        };
        var slotNodes = function (slot, flatten) {
            var out = [], root = rootOfSlot(slot), host = root && root.host, name = slot.getAttribute('name') || '', c, i;
            if (host && root.getElementsByTagName) {
                var slots = root.getElementsByTagName('slot'), first = null;
                for (i = 0; i < slots.length && !first; i++) if ((slots[i].getAttribute('name') || '') === name) first = slots[i];
                if (first === slot) for (c = host.firstChild; c; c = c.nextSibling) {
                    if (c === root) continue;
                    if (c.nodeType === 1 ? (c.getAttribute('slot') || '') === name : c.nodeType === 3 && !name) out.push(c);
                }
            }
            if (!flatten) return out;
            if (!out.length && host) for (c = slot.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 || c.nodeType === 3) out.push(c);
            var flat = [];
            for (i = 0; i < out.length; i++) {
                if (out[i].nodeType === 1 && out[i].tagName === 'SLOT' && rootOfSlot(out[i])) flat = flat.concat(slotNodes(out[i], true));
                else flat.push(out[i]);
            }
            return flat;
        };
        var slotProto = Object.getPrototypeOf(document.createElement('slot'));
        if (slotProto && !slotProto.assignedNodes) {
            slotProto.assignedNodes = function (opts) { return this.tagName === 'SLOT' ? slotNodes(this, !!(opts && opts.flatten)) : []; };
            slotProto.assignedElements = function (opts) {
                var all = this.tagName === 'SLOT' ? slotNodes(this, !!(opts && opts.flatten)) : [], out = [];
                for (var i = 0; i < all.length; i++) if (all[i].nodeType === 1) out.push(all[i]);
                return out;
            };
            slotProto.assign = function () {};   // (manual slot assignment: nodes stay where they are here)
        }
        if (Np && !('assignedSlot' in Np)) try { Object.defineProperty(Np, 'assignedSlot', { configurable: true, get: function () { return this.nodeType === 1 || this.nodeType === 3 ? slotOf(this) : null; } }); } catch (eAS) {}
        // slotchange: once a slot has a listener for it, fired when what goes to it changes (and once it has nodes)
        var watchSlot = function (slot) {
            if (slot.__brSlotWatch) return;
            slot.__brSlotWatch = true;
            var last = [], host = null, obs = null;
            var check = function () {
                var root = rootOfSlot(slot), h = root && root.host;
                if (h !== host) {
                    if (obs) obs.disconnect();
                    host = h;
                    obs = null;
                    // (the host's children and their slot attributes; the root's own changes cost a look at the children)
                    if (host && window.MutationObserver) { obs = new MutationObserver(check); obs.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['slot', 'name'] }); }
                }
                var now = slotNodes(slot, false), same = now.length === last.length;
                for (var i = 0; same && i < now.length; i++) same = now[i] === last[i];
                if (same) return;
                last = now;
                try { var ev = document.createEvent('Event'); ev.initEvent('slotchange', true, false); slot.dispatchEvent(ev); } catch (eSC) {}
            };
            setTimeout(check, 0);
        };
        window.__brSlotListen = function (slot, type, fn, options) {
            if (type === 'slotchange') { watchSlot(slot); return; }   // (dispatched on the slot itself, see watchSlot)
            var capture = options && typeof options === 'object' ? !!options.capture : !!options;
            (slot.__brSlotL || (slot.__brSlotL = [])).push({ type: type, fn: fn, capture: capture });
            var key = type + (capture ? '|c' : '|b');
            if (slotTypes[key]) return;
            slotTypes[key] = true;
            // (focus and blur do not bubble: seen on the way down)
            document.addEventListener(type, function (e) { runSlotListeners(e, capture); }, capture || type === 'focus' || type === 'blur');
        };
        var slotSoon = function () { setTimeout(syncSlots, 0); };
        document.addEventListener('click', slotSoon, true);
        document.addEventListener('focus', slotSoon, true);
        document.addEventListener('blur', slotSoon, true);
    }
    if (Np && !Np.getRootNode) Np.getRootNode = function () { var n = this; while (n.parentNode) n = n.parentNode; return n; };
    if (Ep && !Ep.checkVisibility) Ep.checkVisibility = function (opts) {
        // rendered at all (display:none anywhere up the tree gives no boxes), optionally visibility and opacity too
        if (!this.getClientRects().length) return false;
        var cs = getComputedStyle(this);
        if (opts && (opts.checkVisibilityCSS || opts.visibilityProperty) && cs.visibility !== 'visible') return false;
        if (opts && (opts.checkOpacity || opts.opacityProperty)) { for (var n = this; n && n.nodeType === 1; n = n.parentNode) if (parseFloat(getComputedStyle(n).opacity) === 0) return false; }
        return true;
    };
    if (Np && !('isConnected' in Np)) try { Object.defineProperty(Np, 'isConnected', { get: function () { return document.documentElement.contains(this); } }); } catch (e) {}
    if (window.HTMLLinkElement && !('import' in document.createElement('link'))) {
        try { Object.defineProperty(window.HTMLLinkElement.prototype, 'import', { get: function () { return null; }, configurable: true }); } catch (e) {}
    }

    var registry = {}, waiters = {};
    function disconnectTree(root) {
        var list = [root].concat(Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll('*') : []));
        for (var i = 0; i < list.length; i++) if (list[i].__brUpgraded && list[i].disconnectedCallback) try { list[i].disconnectedCallback(); } catch (e) {}
    }
    // connecting: the element was just inserted (an upgraded one gets connectedCallback again)
    function upgradeElement(el, connecting) {
        var name = el.tagName ? el.tagName.toLowerCase() : '';
        var isAttr = el.getAttribute && el.getAttribute('is');
        var ctor = registry[name] || (isAttr && registry[isAttr.toLowerCase()]);
        if (!ctor) return;
        if (connecting && el.shadowRoot && window.__brHostSheets) window.__brHostSheets.sync(el.shadowRoot, el);
        if (el.__brUpgraded) {
            if (connecting && el.connectedCallback) { flushAttrChanges(el); try { el.connectedCallback(); } catch (e0) {} }
            return;
        }
        el.__brUpgraded = true;
        if (!el.__brConstructed) {
            // (classes are lowered to ES5 by the network layer: their constructors can be called on the element)
            try { if (Object.setPrototypeOf) Object.setPrototypeOf(el, ctor.prototype); else el.__proto__ = ctor.prototype; } catch (e) {}
            try { ctor.call(el); } catch (e2) { if (window.console && console.error) console.error(e2); }
        }
        try {
            var observed = (Object.prototype.hasOwnProperty.call(ctor, '__brObservedAtDefine') ? ctor.__brObservedAtDefine : ctor.observedAttributes) || [];
            for (var i = 0; i < observed.length; i++) if (el.hasAttribute(observed[i]) && el.attributeChangedCallback) el.attributeChangedCallback(observed[i], null, el.getAttribute(observed[i]), null);
            // later changes of the observed attributes
            if (observed.length && el.attributeChangedCallback && window.MutationObserver) {
                var attrChanges = function (records) {
                    for (var r = 0; r < records.length; r++) {
                        var an = records[r].attributeName, old = records[r].oldValue, k;
                        // (the value this change made: the old value of the next change of that attribute in the batch,
                        // else today's)
                        for (k = r + 1; k < records.length && records[k].attributeName !== an; k++) {}
                        var now = k < records.length ? records[k].oldValue : el.getAttribute(an);
                        // An attribute set to the value it had is not told. Native custom elements are told at once,
                        // while Lit still knows it reflects that property itself; told later, it set the property again,
                        // and for a DOM property the old engine keeps on the element itself (id, title, hidden...) that
                        // is the attribute again: Reddit's posts set their id thousands of times, the page stood still.
                        if (old === now) continue;
                        try { el.attributeChangedCallback(an, old, now, null); } catch (e5) { if (window.console && console.error) console.error(e5); }
                    }
                };
                var attrObserver = new MutationObserver(attrChanges);
                attrObserver.observe(el, { attributes: true, attributeOldValue: true, attributeFilter: Array.prototype.slice.call(observed) });
                el.__brAttrObserver = attrObserver;
                el.__brAttrChanges = attrChanges;
            }
        } catch (e3) {}
        try { if (el.connectedCallback && document.documentElement.contains(el)) el.connectedCallback(); } catch (e4) {}
    }
    // Attribute changes still waiting in the element's observer, told now: native custom elements hear of an attribute
    // at once, and a script that sets attributes and then inserts the element finds them in connectedCallback (TikTok's
    // cookie banner read its user-config-ele-id there, still unset: JSON.parse(undefined))
    function flushAttrChanges(el) {
        var ob = el.__brAttrObserver, handle = el.__brAttrChanges;
        if (!ob || !handle || !ob.takeRecords) return;
        var records = null;
        try { records = ob.takeRecords(); } catch (e) { records = null; }
        if (records && records.length) handle(records);
    }
    function upgradeTree(root, connecting) {
        if (!root || (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11)) return;
        if (root.nodeType === 1) upgradeElement(root, connecting);
        var all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (var i = 0; i < all.length; i++) {
            var t = all[i].tagName.toLowerCase();
            if (t.indexOf('-') >= 0 || all[i].hasAttribute('is')) upgradeElement(all[i], connecting);
        }
    }
    if (!window.customElements || window.customElements.__brStub) {
        var registryAPI = {
            __brStub: false,
            define: function (name, ctor) {
                name = String(name).toLowerCase();
                if (registry[name]) throw domException('NotSupportedError', 'custom element already defined: ' + name);
                // (read at the definition, as the native API does: Lit's `static get observedAttributes()` finalizes the
                // class - its elementProperties - and an element made first found none: TikTok's "'undefined' is not an
                // object (evaluating 'this.constructor.elementProperties.forEach')")
                if (ctor && ctor.prototype && typeof ctor.prototype.attributeChangedCallback === 'function') try { ctor.__brObservedAtDefine = ctor.observedAttributes; } catch (e0) {}
                registry[name] = ctor;
                upgradeTree(document);
                if (window.__brUndefinedActive) window.__brMarkUndefined(document);
                if (waiters[name]) { var w = waiters[name]; delete waiters[name]; for (var i = 0; i < w.length; i++) w[i](ctor); }
            },
            get: function (name) { return registry[String(name).toLowerCase()]; },
            getName: function (ctor) { for (var k in registry) if (registry[k] === ctor) return k; return null; },
            whenDefined: function (name) {
                name = String(name).toLowerCase();
                if (registry[name]) return resolved(registry[name]);
                if (!P) return null;
                return new P(function (res) { (waiters[name] = waiters[name] || []).push(res); });
            },
            upgrade: function (root) { upgradeTree(root); }
        };
        try { window.customElements = registryAPI; } catch (e) { try { Object.defineProperty(window, 'customElements', { value: registryAPI, configurable: true }); } catch (e2) {} }
        observeAddedTree(function (el) { for (var k in registry) { upgradeTree(el, true); return; } });
        // document.createElement('my-el') of a defined element runs its constructor at once (as the native API does)
        var ceCreate = document.createElement, ceNativeCreate = ceCreate;
        // (no arguments object and no lower-casing for a name without a dash: this runs for every element a page makes,
        // and reading arguments costs a microsecond a call here)
        document.createElement = function (name) {
            var el = ceCreate.call(document, name);
            if (typeof name === 'string' && name.indexOf('-') > 0) { var n = name.toLowerCase(); if (registry[n]) upgradeElement(el, false); }
            return el;
        };
        // :defined (rewritten to :not(.br-undefined)): custom elements without a definition carry the class; only on
        // pages whose styles use :defined (the manifest block turns this on)
        window.__brMarkUndefined = function (root) {
            window.__brUndefinedActive = true;
            var mark = function (el) { var t = el.tagName ? el.tagName.toLowerCase() : ''; if (t.indexOf('-') > 0) setStateClass(el, 'br-undefined', !registry[t]); };
            if (root && root.nodeType === 1) mark(root);
            var all = root && root.getElementsByTagName ? root.getElementsByTagName('*') : [];
            for (var i = 0; i < all.length; i++) mark(all[i]);
        };
        observeAddedTree(function (el) { if (window.__brUndefinedActive) window.__brMarkUndefined(el); });
        window.CustomElementRegistry = function CustomElementRegistry() {};
        // ES5 subclasses call HTMLElement.call(this): make the base constructor callable
        (function () {
            var NativeHTMLElement = window.HTMLElement;
            if (!NativeHTMLElement) return;
            var callable = false;
            try { NativeHTMLElement.call(document.createElement('div')); callable = true; } catch (e) {}
            if (callable) return;
            // called on the element being upgraded it is that element; `new MyElement()` gets a real element of the name
            // the class was defined with (the constructor continues on it)
            var Wrapped = function HTMLElement() {
                var isElement = false;
                try { isElement = !!this && this.nodeType === 1; } catch (e4) {}   // (newer engines throw on a non-node)
                if (!this || isElement) return this;
                var proto = Object.getPrototypeOf(this), name = null;
                for (var k in registry) if (registry.hasOwnProperty(k) && registry[k].prototype === proto) { name = k; break; }
                if (!name) return this;
                var el = ceNativeCreate.call(document, name);
                el.__brConstructed = true;
                try { el.__proto__ = proto; } catch (e3) {}
                return el;
            };
            Wrapped.prototype = NativeHTMLElement.prototype;
            try { Object.defineProperty(Wrapped, 'name', { value: 'HTMLElement' }); } catch (e2) {}
            window.HTMLElement = Wrapped;
        })();
    }

    // ---- <dialog> (dialog-polyfill in the bundle, registered automatically)
    if (window.dialogPolyfill && !('showModal' in document.createElement('dialog'))) {
        var dp = window.dialogPolyfill;
        addStyle('dialog{position:absolute;left:0;right:0;width:-webkit-fit-content;width:fit-content;height:-webkit-fit-content;height:fit-content;margin:auto;border:solid;padding:1em;background:white;color:black;display:block}' +
                 'dialog:not([open]){display:none}dialog+.backdrop{position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,0.1)}' +
                 '._dialog_overlay{position:fixed;top:0;right:0;bottom:0;left:0}dialog.fixed{position:fixed;top:50%;-webkit-transform:translate(0,-50%);transform:translate(0,-50%)}');
        // :modal (cssfix rewrites it to .br-modal) follows showModal()/close()
        var registerDialog = function (el) {
            try { dp.registerDialog(el); } catch (e) { return; }
            if (el.__brModalWrapped || typeof el.showModal !== 'function') return;
            el.__brModalWrapped = true;
            var origShowModal = el.showModal, origClose = el.close;
            el.showModal = function () { var r = origShowModal.apply(this, arguments); setStateClass(this, 'br-modal', true); return r; };
            el.close = function () { setStateClass(this, 'br-modal', false); return origClose.apply(this, arguments); };
        };
        var registerDialogs = function registerDialogs(root) {
            if (root.nodeType === 1 && root.tagName === 'DIALOG') registerDialog(root);
            if (root.nodeType === 1 && !root.firstElementChild) return;
            var list = root.getElementsByTagName ? root.getElementsByTagName('dialog') : [];
            for (var i = 0; i < list.length; i++) registerDialog(list[i]);
        };
        var origCreateElement = document.createElement;
        document.createElement = function (name) {
            var el = origCreateElement.call(document, name);
            if (typeof name === 'string' && name.length === 6 && name.toLowerCase() === 'dialog') registerDialog(el);
            return el;
        };
        onReady(function () { registerDialogs(document); });
        observeAddedTree(registerDialogs);
        if (!window.HTMLDialogElement) window.HTMLDialogElement = function HTMLDialogElement() {};
    }

    // ---- Responsive images: picturefill does the work, the DOM properties make feature checks pass
    var IMGp = window.HTMLImageElement && window.HTMLImageElement.prototype;
    if (!window.HTMLPictureElement) window.HTMLPictureElement = function HTMLPictureElement() {};
    if (IMGp) {
        defineAttrProp(IMGp, 'srcset');
        defineAttrProp(IMGp, 'sizes');
        defineAttrProp(IMGp, 'loading');
        defineAttrProp(IMGp, 'decoding');
        if (!('currentSrc' in IMGp)) try { Object.defineProperty(IMGp, 'currentSrc', { get: function () { return this.src; }, configurable: true }); } catch (e) {}
        if (!IMGp.decode) IMGp.decode = function () {
            var img = this;
            if (!P) return null;
            return new P(function (res, rej) {
                if (img.complete) return res();
                img.addEventListener('load', function () { res(); }, false);
                img.addEventListener('error', function () { rej(domException('EncodingError', 'The image could not be decoded')); }, false);
            });
        };
    }
    if (window.HTMLSourceElement) { defineAttrProp(window.HTMLSourceElement.prototype, 'srcset'); defineAttrProp(window.HTMLSourceElement.prototype, 'sizes'); }
    // (object-fit-images: the first call takes every picture and starts its own load listener, which redoes a picture
    // whose address changed; later calls hand it only the pictures it has not seen - it wrote five styles into every
    // picture it knew at every settle of the page, each a change of the style attribute for every MutationObserver)
    var ofiStarted = false;
    function runResponsiveImages() {
        if (leanPage()) return;
        try { if (window.picturefill) window.picturefill(); } catch (e) {}
        try {
            if (!window.objectFitImages) return;
            if (!ofiStarted) { ofiStarted = true; window.objectFitImages(null, { watchMQ: false }); return; }
            var imgs = document.getElementsByTagName('img'), fresh = [];
            for (var i = 0; i < imgs.length; i++) if (!imgs[i]['bfred-it:object-fit-images']) fresh.push(imgs[i]);
            if (fresh.length) window.objectFitImages(fresh, { watchMQ: false });
        } catch (e2) {}
    }
    onReady(runResponsiveImages);
    onSettled(runResponsiveImages);
    (function () {
        var OFI = 'bfred-it:object-fit-images', setAttr = Element.prototype.setAttribute;
        // object-fit-images shows a transparent placeholder in the element and paints the picture as its background.
        // Its placeholder, an SVG, hid the picture here: an <img> showing an SVG that WebKit already holds takes it
        // for opaque and skips its own background, so every picture after the first of the same size stayed blank
        // (YouTube's thumbnails). The placeholder is a transparent GIF instead (the build patches the polyfill to
        // ask for it). ImageIO refuses a GIF whose screen is much bigger than its single pixel, so the GIF keeps
        // only the picture's proportions, in a few thousand pixels: enough for a box with one auto side. A box
        // with both sides auto follows the picture's own size, where object-fit changes nothing: it shows the
        // picture itself (its specified sizes are read while it is hidden, when WebKit reports them as written).
        var GIF_TAIL = '\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x01D\x00;';
        var gifs = {}, ours = {};
        var proportions = function (w, h) {
            // the last convergent of the continued fraction of w/h whose terms multiply to at most 3600, at most 50:1
            var swap = w < h, x = swap ? h / w : w / h;
            if (x > 50) x = 50;
            var p0 = 1, q0 = 0, p1 = Math.floor(x), q1 = 1, r = x - p1;
            while (r > 1e-9) {
                r = 1 / r;
                var a = Math.floor(r), p2 = a * p1 + p0, q2 = a * q1 + q0;
                if (p2 * q2 > 3600) break;
                p0 = p1; q0 = q1; p1 = p2; q1 = q2;
                r -= a;
            }
            return swap ? [q1, p1] : [p1, q1];
        };
        var gif = function (w, h) {
            w = Math.round(w) || 1; h = Math.round(h) || 1;
            var pq = w * h <= 3600 && w <= 50 * h && h <= 50 * w ? [w, h] : proportions(w, h), key = pq[0] + 'x' + pq[1];
            if (!gifs[key]) {
                gifs[key] = 'data:image/gif;base64,' + btoa('GIF89a' + String.fromCharCode(pq[0] & 255, pq[0] >> 8, pq[1] & 255, pq[1] >> 8) + GIF_TAIL);
                ours[gifs[key]] = true;
            }
            return gifs[key];
        };
        // (read for many pictures at once and kept per window size: each read hides the picture, which lays the page
        // out again - one layout per picture took seznam.cz's 101 pictures 10 s, at every settle)
        var autoKey = function () { return window.innerWidth + 'x' + window.innerHeight; };
        window.__brOfiPrep = function (list) {
            var key = autoKey(), todo = [], saved = [], i, s;
            for (i = 0; i < list.length; i++) if (list[i].__brAutoKey !== key) todo.push(list[i]);
            for (i = 0; i < todo.length; i++) {
                s = todo[i].style;
                saved.push(s.getPropertyValue('display'), s.getPropertyPriority('display'));
                s.setProperty('display', 'none', 'important');
            }
            for (i = 0; i < todo.length; i++) {
                var cs = getComputedStyle(todo[i]);
                todo[i].__brAuto = cs.width === 'auto' && cs.height === 'auto';
                todo[i].__brAutoKey = key;
            }
            for (i = 0; i < todo.length; i++) {
                s = todo[i].style;
                if (saved[2 * i]) s.setProperty('display', saved[2 * i], saved[2 * i + 1]); else s.removeProperty('display');
            }
        };
        var bothAuto = function (el) {
            if (el.__brAutoKey !== autoKey()) window.__brOfiPrep([el]);
            return el.__brAuto;
        };
        window.__brOfiPH = function (el, w, h) {
            try {
                // (the attribute: the copy of a picture without an address yet reads the page's own address)
                var st = el[OFI];
                if (st && st.img && st.img.getAttribute('src') && bothAuto(el)) return st.img.src;
            } catch (e) {}
            return gif(w, h);
        };
        // Pictures that got their address after the polyfill took them (lazy loading: YouTube's thumbnails): it
        // cannot follow the src property on this engine (the element's own, which cannot be redefined), so it kept
        // painting an empty address and the page showed the picture uncropped. When such a picture loads, the
        // polyfill's copy takes the new address and the element its placeholder again (the polyfill's own load
        // handler, on the body, right after this one, paints the background from it). A picture the old engine
        // squeezed to a 1 px wide or high box gets its size too (see fixThinPicture / fixPercentHeight).
        // (the sizes of loaded pictures are read in batches, all of them before any change: a read right after a
        // change lays the page out again, and pages load dozens of pictures)
        var loaded = [], loadedTimer = 0;
        var checkLoaded = function () {
            loadedTimer = 0;
            var list = loaded, odd = [], i;
            loaded = [];
            try {
                for (i = 0; i < list.length; i++) {
                    var w = list[i].offsetWidth, h = list[i].offsetHeight;
                    if ((h <= 2 && w >= 20) || (w <= 2 && h >= 10)) odd.push(list[i]);
                }
                for (i = 0; i < odd.length; i++) { fixPercentHeight(odd[i]); fixThinPicture(odd[i]); }
            } catch (x) {}
        };
        document.addEventListener('load', function (e) {
            var el = e.target;
            if (!el || el.tagName !== 'IMG') return;
            try {
                var st = el[OFI], cur = el.src;
                if (st && st.img && cur && !ours[cur] && cur.indexOf('data:image/svg+xml') !== 0 && cur !== st.img.src) {
                    st.img.src = cur;
                    setAttr.call(el, 'data-ofi-src', cur);
                    var ph = window.__brOfiPH(el, el.naturalWidth || 1, el.naturalHeight || 0);
                    if (ph !== cur) setAttr.call(el, 'src', ph);
                }
            } catch (x) {}
            loaded.push(el);
            if (!loadedTimer) loadedTimer = setTimeout(checkLoaded, 120);
        }, true);
    })();

    // ---- Streams (single-process, promise based; fetch responses expose a body stream over the buffered bytes)
    if (!window.ReadableStream && P) {
        var ReadableStream = function ReadableStream(source) {
            var self = this;
            self.locked = false;
            self.__queue = [];
            self.__closed = false;
            self.__error = null;
            self.__waiters = [];
            self.__source = source || {};
            self.__controller = {
                desiredSize: 1,
                enqueue: function (chunk) { if (self.__closed) throw new TypeError('The stream is closed'); self.__queue.push(chunk); self.__flush(); },
                close: function () { self.__closed = true; self.__flush(); },
                error: function (e) { self.__error = e || new Error('stream error'); self.__closed = true; self.__flush(); }
            };
            try {
                if (self.__source.start) { var r = self.__source.start(self.__controller); if (r && r.then) r.then(null, self.__controller.error); }
            } catch (e) { self.__controller.error(e); }
        };
        ReadableStream.prototype.__flush = function () {
            while (this.__waiters.length && (this.__queue.length || this.__closed)) {
                var w = this.__waiters.shift();
                if (this.__queue.length) w.resolve({ value: this.__queue.shift(), done: false });
                else if (this.__error) w.reject(this.__error);
                else w.resolve({ value: undefined, done: true });
            }
            if (this.__closed && !this.__queue.length && this.__onClosed) { var done = this.__onClosed; this.__onClosed = null; done(); }
        };
        ReadableStream.prototype.__pull = function () {
            var self = this;
            if (self.__closed || !self.__source.pull || self.__pulling) return;
            self.__pulling = true;
            try {
                var r = self.__source.pull(self.__controller);
                if (r && r.then) r.then(function () { self.__pulling = false; if (self.__waiters.length) self.__pull(); }, function (e) { self.__pulling = false; self.__controller.error(e); });
                else { self.__pulling = false; if (self.__waiters.length && !self.__queue.length) setTimeout(function () { self.__pull(); }, 0); }
            } catch (e) { self.__pulling = false; self.__controller.error(e); }
        };
        ReadableStream.prototype.getReader = function () {
            var self = this;
            if (self.locked) throw new TypeError('The stream is locked');
            self.locked = true;
            return {
                read: function () {
                    return new P(function (resolve, reject) {
                        self.__waiters.push({ resolve: resolve, reject: reject });
                        self.__flush();
                        if (self.__waiters.length) self.__pull();
                    });
                },
                cancel: function (reason) { self.locked = false; return self.cancel(reason); },
                releaseLock: function () { self.locked = false; },
                closed: new P(function (resolve) { self.__onClosed = resolve; if (self.__closed && !self.__queue.length) { self.__onClosed = null; resolve(); } })
            };
        };
        ReadableStream.prototype.cancel = function (reason) {
            this.__closed = true;
            this.__queue = [];
            try { if (this.__source.cancel) this.__source.cancel(reason); } catch (e) {}
            this.__flush();
            if (this.__onClosed) { var done = this.__onClosed; this.__onClosed = null; done(); }
            return resolved();
        };
        // two branches with queues of their own, each getting every chunk (Next.js tees its initial page data: one
        // stream shared by both readers gave each only part of the chunks, and React failed with "Connection closed");
        // the source is cancelled once both branches are
        ReadableStream.prototype.tee = function () {
            var reader = this.getReader(), ctrl = [null, null], canceled = [false, false], inflight = null;
            var each = function (fn) { for (var i = 0; i < 2; i++) if (!canceled[i] && ctrl[i]) { try { fn(ctrl[i]); } catch (e) {} } };
            var pump = function () {
                if (inflight) return inflight;
                inflight = reader.read().then(function (r) {
                    inflight = null;
                    if (r.done) each(function (c) { c.close(); });
                    else each(function (c) { c.enqueue(r.value); });
                }, function (err) { inflight = null; each(function (c) { c.error(err); }); });
                return inflight;
            };
            var branch = function (i) {
                return new ReadableStream({
                    start: function (c) { ctrl[i] = c; },
                    pull: function () { return pump(); },
                    cancel: function (reason) { canceled[i] = true; if (canceled[1 - i]) return reader.cancel(reason); }
                });
            };
            return [branch(0), branch(1)];
        };
        ReadableStream.prototype.pipeTo = function (dest) {
            var reader = this.getReader(), writer = dest.getWriter();
            function step() { return reader.read().then(function (r) { if (r.done) return writer.close(); return P.resolve(writer.write(r.value)).then(step); }); }
            return step();
        };
        ReadableStream.prototype.pipeThrough = function (pair) { this.pipeTo(pair.writable); return pair.readable; };
        window.ReadableStream = ReadableStream;
        window.ReadableStreamDefaultReader = function ReadableStreamDefaultReader() {};
        var WritableStream = function WritableStream(sink) {
            this.locked = false;
            this.__sink = sink || {};
            try { if (this.__sink.start) this.__sink.start({ error: noop }); } catch (e) {}
        };
        WritableStream.prototype.getWriter = function () {
            var self = this;
            self.locked = true;
            return {
                write: function (chunk) { try { var r = self.__sink.write && self.__sink.write(chunk, { error: noop }); return r && r.then ? r : resolved(); } catch (e) { return P.reject(e); } },
                close: function () { try { var r = self.__sink.close && self.__sink.close(); return r && r.then ? r : resolved(); } catch (e) { return P.reject(e); } },
                abort: function (reason) { try { if (self.__sink.abort) self.__sink.abort(reason); } catch (e) {} return resolved(); },
                releaseLock: function () { self.locked = false; },
                ready: resolved(), closed: resolved(), desiredSize: 1
            };
        };
        WritableStream.prototype.abort = function () { return resolved(); };
        WritableStream.prototype.close = function () { return resolved(); };
        window.WritableStream = WritableStream;
        window.WritableStreamDefaultWriter = function WritableStreamDefaultWriter() {};
        var TransformStream = function TransformStream(transformer) {
            transformer = transformer || {};
            var readableController = null;
            this.readable = new ReadableStream({ start: function (c) { readableController = c; } });
            var tc = { enqueue: function (chunk) { readableController.enqueue(chunk); }, error: function (e) { readableController.error(e); }, terminate: function () { readableController.close(); }, desiredSize: 1 };
            this.writable = new WritableStream({
                write: function (chunk) { if (transformer.transform) return transformer.transform(chunk, tc); tc.enqueue(chunk); },
                close: function () { var r = transformer.flush ? transformer.flush(tc) : null; return P.resolve(r).then(function () { readableController.close(); }); },
                abort: function (reason) { readableController.error(reason); }
            });
        };
        window.TransformStream = TransformStream;
        window.ByteLengthQueuingStrategy = function ByteLengthQueuingStrategy(o) { this.highWaterMark = o && o.highWaterMark; this.size = function (c) { return c.byteLength; }; };
        window.CountQueuingStrategy = function CountQueuingStrategy(o) { this.highWaterMark = o && o.highWaterMark; this.size = function () { return 1; }; };
        // (a character split between two chunks is kept for the next one)
        window.TextDecoderStream = function TextDecoderStream(label, options) {
            var dec = new TextDecoder(label, options);
            var t = new TransformStream({
                transform: function (chunk, c) { var s = dec.decode(chunk, { stream: true }); if (s) c.enqueue(s); },
                flush: function (c) { var s = dec.decode(); if (s) c.enqueue(s); }
            });
            this.readable = t.readable; this.writable = t.writable; this.encoding = dec.encoding; this.fatal = dec.fatal; this.ignoreBOM = dec.ignoreBOM;
        };
        window.TextEncoderStream = function TextEncoderStream() {
            var enc = new TextEncoder();
            var t = new TransformStream({ transform: function (chunk, c) { c.enqueue(enc.encode(String(chunk))); } });
            this.readable = t.readable; this.writable = t.writable; this.encoding = 'utf-8';
        };
        if (window.Response && window.Response.prototype && !('body' in window.Response.prototype)) {
            try {
                // (the body is read when the stream is: ofetch - every Nuxt site - looks at response.body before it
                // calls response.json(), which then threw "Already read" and pilulka.cz showed its error page)
                Object.defineProperty(window.Response.prototype, 'body', { get: function () {
                    var self = this, started = false;
                    if (self.__brBody) return self.__brBody;
                    if (!self.arrayBuffer) return null;
                    self.__brBody = new ReadableStream({ pull: function (c) {
                        if (started) return;
                        started = true;
                        var p;
                        try { p = self.arrayBuffer(); } catch (e) { c.error(e); return; }
                        return p.then(function (buf) { c.enqueue(new Uint8Array(buf)); c.close(); }, function (e) { c.error(e); });
                    } });
                    return self.__brBody;
                }, configurable: true });
            } catch (e) {}
        }
        // new Response(readableStream): the fetch polyfill takes strings, blobs and buffers only (Next.js wraps the
        // RSC data of client-side navigations this way); the body is collected when a reader method asks for it
        var BaseResponse = window.Response;
        if (BaseResponse && !BaseResponse.__brStreams) {
            var StreamResponse = function Response(body, init) {
                if (!(body instanceof ReadableStream)) return arguments.length ? new BaseResponse(body, init) : new BaseResponse();
                var r = new BaseResponse(null, init), stream = body, collected = null;
                var collect = function () {
                    if (collected) return collected;
                    try { r.bodyUsed = true; } catch (e) {}   // (a getter in engines with their own Response)
                    collected = new P(function (resolve, reject) {
                        var reader = stream.getReader(), parts = [], total = 0;
                        var step = function () {
                            reader.read().then(function (x) {
                                if (x.done) {
                                    var out = new Uint8Array(total), at = 0;
                                    for (var i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
                                    resolve(out.buffer);
                                    return;
                                }
                                var v = x.value;
                                if (typeof v === 'string') v = new TextEncoder().encode(v);
                                else if (!(v instanceof Uint8Array)) v = new Uint8Array(v.buffer || v);
                                parts.push(v);
                                total += v.length;
                                step();
                            }, reject);
                        };
                        step();
                    });
                    return collected;
                };
                r.__brBody = stream;   // (the body getter above hands out the stream itself)
                r.arrayBuffer = collect;
                r.text = function () { return collect().then(function (b) { return new TextDecoder().decode(new Uint8Array(b)); }); };
                r.json = function () { return r.text().then(function (t) { return JSON.parse(t); }); };
                r.blob = function () { return collect().then(function (b) { return new Blob([b]); }); };
                r.clone = function () { var pair = stream.tee(); stream = pair[0]; return new StreamResponse(pair[1], { status: r.status, statusText: r.statusText, headers: r.headers }); };
                return r;
            };
            StreamResponse.prototype = BaseResponse.prototype;
            for (var rk in BaseResponse) if (BaseResponse.hasOwnProperty(rk)) StreamResponse[rk] = BaseResponse[rk];
            StreamResponse.__brStreams = true;
            window.Response = StreamResponse;
        }
    }

    // ---- WebRTC, media capture and recording: present, but every attempt fails cleanly
    if (!window.RTCPeerConnection && !window.webkitRTCPeerConnection) {
        var rtcUnsupported = rejectWith('NotSupportedError', 'WebRTC is not available on this device');
        var RTCPeerConnection = function RTCPeerConnection(config) {
            this.localDescription = null; this.remoteDescription = null; this.currentLocalDescription = null; this.currentRemoteDescription = null;
            this.signalingState = 'stable'; this.iceConnectionState = 'new'; this.iceGatheringState = 'new'; this.connectionState = 'new';
            this.canTrickleIceCandidates = null; this.sctp = null; this.__config = config || {};
            this.__l = {};
        };
        RTCPeerConnection.prototype = {
            createOffer: rtcUnsupported, createAnswer: rtcUnsupported, setLocalDescription: rtcUnsupported, setRemoteDescription: rtcUnsupported, addIceCandidate: rtcUnsupported,
            createDataChannel: function (label) { return { label: label, readyState: 'closed', bufferedAmount: 0, ordered: true, binaryType: 'blob', send: function () { throw domException('InvalidStateError', 'RTCDataChannel is closed'); }, close: noop, addEventListener: noop, removeEventListener: noop, dispatchEvent: function () { return true; } }; },
            addTrack: function (track) { return { track: track, replaceTrack: rtcUnsupported, getParameters: function () { return {}; }, setParameters: rtcUnsupported, getStats: function () { return resolved(new Map()); } }; },
            removeTrack: noop, addTransceiver: function () { return {}; }, getSenders: function () { return []; }, getReceivers: function () { return []; }, getTransceivers: function () { return []; },
            addStream: noop, removeStream: noop, getLocalStreams: function () { return []; }, getRemoteStreams: function () { return []; },
            getStats: function () { return resolved(new Map()); }, getConfiguration: function () { return this.__config; }, setConfiguration: noop, restartIce: noop, close: noop,
            addEventListener: function (t, f) { (this.__l[t] = this.__l[t] || []).push(f); }, removeEventListener: function (t, f) { var l = this.__l[t] || []; var i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }, dispatchEvent: function () { return true; }
        };
        RTCPeerConnection.generateCertificate = rtcUnsupported;
        window.RTCPeerConnection = window.webkitRTCPeerConnection = window.mozRTCPeerConnection = RTCPeerConnection;
        window.RTCSessionDescription = function RTCSessionDescription(init) { this.type = init && init.type; this.sdp = (init && init.sdp) || ''; this.toJSON = function () { return { type: this.type, sdp: this.sdp }; }; };
        window.RTCIceCandidate = function RTCIceCandidate(init) { init = init || {}; this.candidate = init.candidate || ''; this.sdpMid = init.sdpMid || null; this.sdpMLineIndex = init.sdpMLineIndex === undefined ? null : init.sdpMLineIndex; this.toJSON = function () { return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex }; }; };
        var rtcNames = ['RTCDataChannel', 'RTCIceGatherer', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCSctpTransport', 'RTCCertificate', 'RTCPeerConnectionIceEvent', 'RTCDataChannelEvent', 'RTCTrackEvent', 'RTCStatsReport', 'RTCError'];
        for (var rn = 0; rn < rtcNames.length; rn++) if (!window[rtcNames[rn]]) window[rtcNames[rn]] = (function (n) { var f = function () {}; try { Object.defineProperty(f, 'name', { value: n }); } catch (e) {} return f; })(rtcNames[rn]);
        window.RTCIceGatherer.prototype.getLocalCandidates = function () { return []; };
    }
    if (!window.MediaStream) {
        window.MediaStream = window.webkitMediaStream = function MediaStream() { this.id = 'ms-' + Math.random().toString(36).slice(2); this.active = false; };
        window.MediaStream.prototype = { getTracks: function () { return []; }, getAudioTracks: function () { return []; }, getVideoTracks: function () { return []; }, getTrackById: function () { return null; }, addTrack: noop, removeTrack: noop, clone: function () { return new window.MediaStream(); }, addEventListener: noop, removeEventListener: noop, dispatchEvent: function () { return true; } };
        window.MediaStreamTrack = function MediaStreamTrack() { this.readyState = 'ended'; this.enabled = false; this.muted = true; this.kind = ''; this.label = ''; this.id = ''; };
        window.MediaStreamTrack.prototype = { stop: noop, clone: function () { return new window.MediaStreamTrack(); }, getSettings: function () { return {}; }, getConstraints: function () { return {}; }, getCapabilities: function () { return {}; }, applyConstraints: function () { return resolved(); }, addEventListener: noop, removeEventListener: noop };
    }
    if (!window.MediaRecorder) {
        window.MediaRecorder = function MediaRecorder() { throw domException('NotSupportedError', 'MediaRecorder is not available on this device'); };
        window.MediaRecorder.isTypeSupported = function () { return false; };
    }
    if (navigator.mediaDevices) {
        if (!navigator.mediaDevices.getDisplayMedia) navigator.mediaDevices.getDisplayMedia = rejectWith('NotAllowedError', 'Screen capture is not available');
        if (!navigator.mediaDevices.getSupportedConstraints) navigator.mediaDevices.getSupportedConstraints = function () { return {}; };
        if (!navigator.mediaDevices.addEventListener) { navigator.mediaDevices.addEventListener = noop; navigator.mediaDevices.removeEventListener = noop; }
    }
    if (!navigator.getUserMedia) {
        navigator.getUserMedia = navigator.webkitGetUserMedia = function (constraints, ok, err) { setTimeout(function () { if (err) err(domException('NotAllowedError', 'Camera and microphone are not available')); }, 0); };
    }
    if (!window.ImageCapture) window.ImageCapture = function ImageCapture() { throw domException('NotSupportedError', 'ImageCapture is not available'); };

    // ---- Speech
    // Speech synthesis on the system voices (VoiceServices through the app, see BRSpeech.m): utterances queue here and
    // go to the app one at a time; the app reports the start, word boundaries and the end, which this polls for.
    if (!window.speechSynthesis) (function () {
        var BASE = 'https://ios6-browser.invalid/speech/';
        var voices = [], queue = [], current = null, paused = false, lastSeq = 0, pollTimer = null, uidSeq = 0, voicesAsked = false;
        var askVoices = function () { if (!voicesAsked) { voicesAsked = true; loadVoices(0); } };
        var request = function (action, params, cb) {
            var qs = [];
            if (params) for (var k in params) if (params.hasOwnProperty(k) && params[k] !== undefined && params[k] !== null) qs.push(k + '=' + encodeURIComponent(params[k]));
            try {
                var x = new XMLHttpRequest();
                x.open('GET', BASE + action + (qs.length ? '?' + qs.join('&') : ''), true);
                x.onreadystatechange = function () {
                    if (x.readyState !== 4 || !cb) return;
                    var r = null;
                    try { r = JSON.parse(x.responseText); } catch (e) {}
                    cb(r);
                };
                x.send(null);
            } catch (e2) { if (cb) cb(null); }
        };
        var makeEvent = function (type, props) {
            var ev;
            try { ev = document.createEvent('Event'); ev.initEvent(type, false, false); } catch (e) { ev = { type: type }; }
            for (var k in props) if (props.hasOwnProperty(k)) try { ev[k] = props[k]; } catch (e2) {}
            return ev;
        };
        var fire = function (target, type, props) {
            var ev = makeEvent(type, props || {});
            if (typeof target['on' + type] === 'function') try { target['on' + type](ev); } catch (e) {}
            var ls = target.__l && target.__l[type] ? target.__l[type].slice() : [];
            for (var i = 0; i < ls.length; i++) try { ls[i].call(target, ev); } catch (e2) {}
        };
        var eventTarget = {
            addEventListener: function (t, f) { if (!this.__l) this.__l = {}; (this.__l[t] = this.__l[t] || []).push(f); },
            removeEventListener: function (t, f) { var l = this.__l && this.__l[t]; if (!l) return; var i = l.indexOf(f); if (i >= 0) l.splice(i, 1); },
            dispatchEvent: function (e) { fire(this, e.type, {}); return true; }
        };
        var SpeechSynthesisVoice = function SpeechSynthesisVoice(v) {
            this.voiceURI = 'com.apple.voiceservices.' + v.lang; this.name = v.name; this.lang = v.lang; this.localService = true; this['default'] = !!v['default'];
        };
        var SpeechSynthesisUtterance = function SpeechSynthesisUtterance(text) {
            this.text = text === undefined ? '' : String(text); this.lang = ''; this.voice = null; this.volume = 1; this.rate = 1; this.pitch = 1;
            this.onstart = this.onend = this.onerror = this.onpause = this.onresume = this.onmark = this.onboundary = null;
        };
        SpeechSynthesisUtterance.prototype = { constructor: SpeechSynthesisUtterance, addEventListener: eventTarget.addEventListener,
            removeEventListener: eventTarget.removeEventListener, dispatchEvent: eventTarget.dispatchEvent };
        var wordLength = function (text, at) { var m = /^[^\s]+/.exec(String(text).slice(at)); return m ? m[0].length : 0; };
        var synth = {
            __brStub: false, onvoiceschanged: null,
            speak: function (u) {
                if (!u || typeof u.text !== 'string') throw new TypeError('speak() needs a SpeechSynthesisUtterance');
                askVoices();
                queue.push(u);
                next();
            },
            cancel: function () {
                var q = queue;
                queue = [];
                for (var i = 0; i < q.length; i++) fire(q[i], 'error', { error: 'canceled', utterance: q[i], charIndex: 0, elapsedTime: 0 });
                if (current) {
                    var u = current;
                    current = null;
                    request('cancel');
                    fire(u, 'error', { error: 'interrupted', utterance: u, charIndex: 0, elapsedTime: 0 });
                }
                paused = false;
            },
            pause: function () { if (paused) return; paused = true; if (current) request('pause'); },
            resume: function () { if (!paused) return; paused = false; if (current) request('resume'); else next(); },
            // the system voices arrive a moment later with a voiceschanged event, as in other browsers
            getVoices: function () { askVoices(); return voices.slice(); },
            addEventListener: eventTarget.addEventListener, removeEventListener: eventTarget.removeEventListener, dispatchEvent: eventTarget.dispatchEvent
        };
        try {
            Object.defineProperty(synth, 'speaking', { get: function () { return !!current; } });
            Object.defineProperty(synth, 'pending', { get: function () { return queue.length > 0; } });
            Object.defineProperty(synth, 'paused', { get: function () { return paused; } });
        } catch (e) {}
        var next = function () {
            if (current || paused || !queue.length) return;
            var u = current = queue.shift();
            u.__id = 'u' + (++uidSeq) + '-' + Math.random().toString(36).slice(2, 8);
            u.__started = false;
            var lang = u.lang || (u.voice && u.voice.lang) || (document.documentElement && document.documentElement.lang) || navigator.language || '';
            // an engine that never reports the end does not hold up the queue for ever
            u.__deadline = Date.now() + 10000 + u.text.length * 150 / Math.max(0.1, u.rate || 1);
            request('speak', { id: u.__id, text: u.text, lang: lang, rate: u.rate, pitch: u.pitch, volume: u.volume });
            if (!pollTimer) pollTimer = setTimeout(poll, 100);
        };
        var finish = function (u, type, props) {
            if (current !== u) return;
            current = null;
            fire(u, type, props);
            next();
        };
        var poll = function () {
            pollTimer = null;
            request('events', { since: lastSeq }, function (events) {
                if (events) for (var i = 0; i < events.length; i++) {
                    var e = events[i], u = current;
                    if (e.seq > lastSeq) lastSeq = e.seq;
                    if (!u || e.id !== u.__id) continue;
                    var base = { utterance: u, elapsedTime: e.elapsed || 0, charIndex: e['char'] || 0 };
                    if (e.type === 'start' && !u.__started) { u.__started = true; fire(u, 'start', base); }
                    else if (e.type === 'boundary') { base.name = 'word'; base.charLength = wordLength(u.text, base.charIndex); fire(u, 'boundary', base); }
                    else if (e.type === 'pause') fire(u, 'pause', base);
                    else if (e.type === 'resume') fire(u, 'resume', base);
                    else if (e.type === 'end') { base.charIndex = u.text.length; finish(u, 'end', base); }
                    else if (e.type === 'error') { base.error = 'synthesis-failed'; finish(u, 'error', base); }
                }
                if (current && !paused && current.__deadline && Date.now() > current.__deadline) finish(current, 'error', { error: 'synthesis-failed', utterance: current, charIndex: 0, elapsedTime: 0 });
                if (current || queue.length) pollTimer = setTimeout(poll, current ? 120 : 400);
            });
        };
        var loadVoices = function (tries) {
            request('info', null, function (info) {
                if (info && info.loading && tries < 30) { setTimeout(function () { loadVoices(tries + 1); }, 300); return; }
                voices = [];
                var list = (info && info.voices) || [];
                for (var i = 0; i < list.length; i++) voices.push(new SpeechSynthesisVoice(list[i]));
                if (voices.length) fire(synth, 'voiceschanged', {});
            });
        };
        window.speechSynthesis = synth;
        window.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
        window.SpeechSynthesisVoice = SpeechSynthesisVoice;
        window.SpeechSynthesis = function SpeechSynthesis() { throw new TypeError('Illegal constructor'); };
        window.SpeechSynthesisEvent = function SpeechSynthesisEvent(type, init) { return makeEvent(type, init || {}); };
        window.SpeechSynthesisErrorEvent = function SpeechSynthesisErrorEvent(type, init) { return makeEvent(type, init || {}); };
    })();
    // ---- Read aloud (the app's menu): the page's main text, block by block, on the system voices, following CSS Speech
    // (speak, speak-as, pause, rest, cue, voice-*) as the rewriter left it in the manifest; the block being spoken is
    // :current (class br-current, with its ancestors), the ones read :past, the ones to come :future.
    (function () {
        var run = null, raStyle = null;
        var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1, OBJECT: 1, VIDEO: 1, AUDIO: 1, SELECT: 1, TEXTAREA: 1, BUTTON: 1, INPUT: 1, NAV: 1 };
        var BLOCK = /^(block|list-item|table-cell|table-caption|-webkit-box|table|inline-block)$/;
        var STRENGTH_MS = { none: 0, 'x-weak': 100, weak: 250, medium: 500, strong: 800, 'x-strong': 1200 };
        var trimS = function (s) { return String(s).replace(/^\s+|\s+$/g, ''); };
        var props = function (el) { try { return window.__brDeferred ? window.__brDeferred.speech(el) : {}; } catch (e) { return {}; } };
        var ms = function (v) {
            v = trimS(v || '').toLowerCase();
            if (STRENGTH_MS.hasOwnProperty(v)) return STRENGTH_MS[v];
            var m = /^(\d*\.?\d+)(m?s)$/.exec(v);
            return m ? parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1) : 0;
        };
        var pair = function (shorthand, before, after) {   // pause / rest: "<before> <after>?"
            var t = shorthand ? trimS(shorthand).split(/\s+/) : [];
            return [before !== undefined ? ms(before) : ms(t[0]), after !== undefined ? ms(after) : ms(t.length > 1 ? t[1] : t[0])];
        };
        var rateOf = function (v) {
            var r = 1, t = trimS(v || '').toLowerCase().split(/\s+/);
            for (var i = 0; i < t.length; i++) {
                var k = { 'x-slow': 0.5, slow: 0.75, medium: 1, normal: 1, fast: 1.4, 'x-fast': 1.9 }[t[i]];
                if (k) r *= k; else if (/%$/.test(t[i])) r *= parseFloat(t[i]) / 100;
            }
            return Math.max(0.1, Math.min(10, r || 1));
        };
        var pitchOf = function (v) {
            var p = 1, t = trimS(v || '').toLowerCase().split(/\s+/), abs = t.indexOf('absolute') >= 0;
            for (var i = 0; i < t.length; i++) {
                var k = { 'x-low': 0.6, low: 0.8, medium: 1, high: 1.25, 'x-high': 1.5 }[t[i]], m;
                if (k) p *= k;
                else if ((m = /^([+-]?\d*\.?\d+)(k?)hz$/.exec(t[i]))) { var hz = parseFloat(m[1]) * (m[2] ? 1000 : 1); p = abs ? hz / 150 : p * (150 + hz) / 150; }   // around a 150 Hz voice
                else if ((m = /^([+-]?\d*\.?\d+)st$/.exec(t[i]))) p *= Math.pow(2, parseFloat(m[1]) / 12);
                else if ((m = /^([+-]?\d*\.?\d+)%$/.exec(t[i]))) p *= 1 + parseFloat(m[1]) / 100;
            }
            return Math.max(0, Math.min(2, p));
        };
        var volumeOf = function (v) {   // null: silent
            var t = trimS(v || '').toLowerCase();
            if (t === 'silent') return null;
            var vol = 1, parts = t.split(/\s+/);
            for (var i = 0; i < parts.length; i++) {
                var k = { 'x-soft': 0.2, soft: 0.45, medium: 0.7, loud: 0.85, 'x-loud': 1 }[parts[i]], m;
                if (k) vol = k; else if ((m = /^([+-]?\d*\.?\d+)db$/.exec(parts[i]))) vol *= Math.pow(10, parseFloat(m[1]) / 20);
            }
            return Math.max(0, Math.min(1, vol));
        };
        var voiceFor = function (family, lang) {
            var voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
            if (family && family !== 'preserve') {
                var names = family.split(',');
                for (var i = 0; i < names.length; i++) {
                    var n = trimS(names[i]).replace(/^["']|["']$/g, '').toLowerCase();
                    for (var k = 0; k < voices.length; k++) if (voices[k].name.toLowerCase() === n) return voices[k];
                }
            }
            return null;   // the language picks the voice
        };
        // speak-as: spell-out letters, digits one by one, punctuation spoken or left out
        var speakAs = function (text, how) {
            how = String(how || '').toLowerCase();
            if (/spell-out/.test(how)) text = text.replace(/(\S)(?=\S)/g, '$1 ');
            else if (/digits/.test(how)) text = text.replace(/(\d)(?=\d)/g, '$1 ');
            if (/no-punctuation/.test(how)) text = text.replace(/[.,;:!?"'()\[\]{}…–—]/g, ' ');
            return text;
        };
        // the main text of the page: an article / main region when there is one with real text, else the body
        var mainRoot = function () {
            var best = null, bestLen = 0, cands = document.querySelectorAll('article, main, [role="main"]');
            for (var i = 0; i < cands.length; i++) { var l = (cands[i].textContent || '').length; if (l > bestLen) { best = cands[i]; bestLen = l; } }
            return best && bestLen > 400 ? best : document.body;
        };
        var rendered = function (el) { return !!(el.getClientRects && el.getClientRects().length); };
        var segmentsOf = function (root) {
            var segs = [], blocks = [], cache = [], walker = document.createTreeWalker(root, 4, null, false), node, byBlock = {};
            var blockOf = function (el) {
                for (var n = el; n && n !== root; n = n.parentNode) {
                    if (n.nodeType !== 1) continue;
                    if (n.__brRAb === undefined) { n.__brRAb = BLOCK.test(getComputedStyle(n).display) ? 1 : 0; cache.push(n); }
                    if (n.__brRAb) return n;
                }
                return root;
            };
            while ((node = walker.nextNode())) {
                var text = node.data;
                if (!/\S/.test(text)) continue;
                var parent = node.parentNode, skip = false;
                for (var a = parent; a && a !== root.parentNode; a = a.parentNode) {
                    if (a.nodeType !== 1) continue;
                    if (SKIP[a.nodeName.toUpperCase()] || a.getAttribute('aria-hidden') === 'true' || a.id === 'br-read-aloud') { skip = true; break; }
                }
                if (skip) continue;
                var sp = props(parent);
                if (sp.speak === 'never') continue;
                if (sp.speak !== 'always' && !rendered(parent)) continue;
                var block = blockOf(parent);
                var seg = block.__brRAseg;
                if (!seg || seg.run !== run) {
                    seg = block.__brRAseg = { el: block, text: '', run: run };
                    segs.push(seg);
                }
                seg.text += (seg.text ? ' ' : '') + speakAs(text.replace(/\s+/g, ' '), sp['speak-as']);
            }
            for (var c = 0; c < cache.length; c++) cache[c].__brRAb = undefined;
            // long blocks go in sentence-sized pieces (word boundaries and pausing stay close to the text)
            var out = [];
            for (var s = 0; s < segs.length; s++) {
                var t = trimS(segs[s].text);
                if (!t) continue;
                while (t.length > 1200) {
                    var cut = t.lastIndexOf('. ', 1000);
                    if (cut < 200) cut = t.lastIndexOf(' ', 1000);
                    if (cut < 200) cut = 1000;
                    out.push({ el: segs[s].el, text: t.slice(0, cut + 1), part: true });
                    t = trimS(t.slice(cut + 1));
                }
                out.push({ el: segs[s].el, text: t });
            }
            return out;
        };
        var langOf = function (el) {
            for (var n = el; n && n.nodeType === 1; n = n.parentNode) { var l = n.getAttribute('lang') || n.getAttribute('xml:lang'); if (l) return l; }
            return navigator.language || '';
        };
        var mark = function (el, cls, on) { for (var n = el; n && n.nodeType === 1; n = n.parentNode) setStateClass(n, cls, on); };
        var bar = function () {
            var b = document.getElementById('br-read-aloud');
            if (b) return b;
            b = document.createElement('div');
            b.id = 'br-read-aloud';
            b.style.cssText = 'position:fixed;left:50%;bottom:16px;margin-left:-150px;width:300px;z-index:2147483647;background:rgba(30,30,32,.92);color:#fff;' +
                'font:15px/1.2 "Helvetica Neue",Helvetica,sans-serif;border-radius:22px;padding:6px;box-shadow:0 4px 18px rgba(0,0,0,.35);-webkit-user-select:none;text-align:center';
            b.innerHTML = '<span data-a="pause" style="display:inline-block;padding:9px 14px">❚❚</span><span data-a="info" style="display:inline-block;padding:9px 10px;min-width:90px;color:#ccc"></span><span data-a="stop" style="display:inline-block;padding:9px 14px">✕</span>';
            b.addEventListener('click', function (e) {
                var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
                if (a === 'stop') api.stop();
                else if (a === 'pause') { if (run && run.paused) api.resume(); else api.pause(); }
            }, false);
            document.body.appendChild(b);
            return b;
        };
        var updateBar = function () {
            var b = document.getElementById('br-read-aloud');
            if (!b || !run) return;
            b.querySelector('[data-a="pause"]').textContent = run.paused ? '▶' : '❚❚';
            b.querySelector('[data-a="info"]').textContent = (run.index + 1) + ' / ' + run.segs.length;
        };
        var wait = function (msec, next) { if (msec > 0) setTimeout(next, msec); else next(); };
        var playCue = function (value, next) {
            var m = /url\(\s*(["']?)([^"')]+)\1\s*\)\s*([+-]?\d*\.?\d+)?\s*(db)?/i.exec(value || '');
            if (!m) { next(); return; }
            var done = false, finish = function () { if (!done) { done = true; next(); } };
            try {
                var au = new Audio(m[2]);
                if (m[3]) au.volume = Math.max(0, Math.min(1, Math.pow(10, parseFloat(m[3]) / 20)));
                au.addEventListener('ended', finish, false);
                au.addEventListener('error', finish, false);
                au.play();
                setTimeout(finish, 8000);
            } catch (e) { finish(); }
        };
        var scrollTo = function (el) {
            var r = el.getBoundingClientRect();
            if (r.top < 0 || r.bottom > window.innerHeight) window.scrollTo(window.pageXOffset, Math.max(0, r.top + window.pageYOffset - window.innerHeight / 3));
        };
        var step = function (token) {
            if (!run || run.token !== token || run.paused) return;
            var seg = run.segs[run.index];
            if (!seg) { api.stop(); return; }
            var prev = run.segs[run.index - 1];
            if (prev && prev.el !== seg.el) { mark(prev.el, 'br-current', false); setStateClass(prev.el, 'br-ra-block', false); setStateClass(prev.el, 'br-past', true); }
            setStateClass(seg.el, 'br-future', false);
            mark(seg.el, 'br-current', true);
            setStateClass(seg.el, 'br-ra-block', true);
            scrollTo(seg.el);
            updateBar();
            var sp = props(seg.el), first = !prev || prev.el !== seg.el, last = !(run.segs[run.index + 1] && run.segs[run.index + 1].el === seg.el);
            var pauses = pair(sp.pause, sp['pause-before'], sp['pause-after']), rests = pair(sp.rest, sp['rest-before'], sp['rest-after']);
            var cueParts = (sp.cue || '').match(/url\([^)]*\)(\s*[+-]?\d*\.?\d+db)?|none/gi) || [];
            var cueBefore = sp['cue-before'] || cueParts[0], cueAfter = sp['cue-after'] || cueParts[1] || cueParts[0];
            var vol = volumeOf(sp['voice-volume']);
            var afterSpeech = function () {
                if (!run || run.token !== token) return;
                wait(last ? rests[1] : 0, function () {
                    (last && cueAfter && cueAfter !== 'none' ? playCue : function (v, n) { n(); })(cueAfter, function () {
                        wait(last ? pauses[1] : 0, function () {
                            if (!run || run.token !== token) return;
                            run.index++;
                            step(token);
                        });
                    });
                });
            };
            wait(first ? pauses[0] : 0, function () {
                (first && cueBefore && cueBefore !== 'none' ? playCue : function (v, n) { n(); })(cueBefore, function () {
                    wait(first ? rests[0] : 0, function () {
                        if (!run || run.token !== token) return;
                        if (vol === null) { afterSpeech(); return; }   // voice-volume: silent
                        var u = new window.SpeechSynthesisUtterance(seg.text);
                        u.lang = langOf(seg.el);
                        u.rate = rateOf(sp['voice-rate']);
                        u.pitch = pitchOf(sp['voice-pitch']);
                        u.volume = vol;
                        u.voice = voiceFor(sp['voice-family'], u.lang);
                        u.onend = afterSpeech;
                        u.onerror = function (e) { if (e && (e.error === 'interrupted' || e.error === 'canceled')) return; afterSpeech(); };
                        run.utterance = u;
                        window.speechSynthesis.speak(u);
                    });
                });
            });
        };
        var clearMarks = function () {
            if (!run) return;
            for (var i = 0; i < run.segs.length; i++) {
                var el = run.segs[i].el;
                mark(el, 'br-current', false);
                setStateClass(el, 'br-past', false); setStateClass(el, 'br-future', false); setStateClass(el, 'br-ra-block', false);
            }
        };
        var api = {
            start: function () {
                if (!window.speechSynthesis) return false;
                api.stop();
                if (!raStyle) {
                    raStyle = ownStyleElement();
                    raStyle.textContent = '.br-ra-block{background-color:rgba(255,214,0,.28)!important;box-shadow:0 0 0 4px rgba(255,214,0,.28)!important}';
                    (document.head || document.documentElement).appendChild(raStyle);
                }
                try { if (window.__brDeferred) window.__brDeferred.apply(); } catch (e) {}   // the speech properties of the elements
                run = { token: {}, index: 0, paused: false, segs: [] };
                run.segs = segmentsOf(mainRoot());
                if (!run.segs.length) { run = null; return false; }
                for (var i = 0; i < run.segs.length; i++) setStateClass(run.segs[i].el, 'br-future', true);
                bar();
                step(run.token);
                return true;
            },
            stop: function () {
                if (!run) return;
                clearMarks();
                run.token = null;
                run = null;
                try { window.speechSynthesis.cancel(); } catch (e) {}
                var b = document.getElementById('br-read-aloud');
                if (b && b.parentNode) b.parentNode.removeChild(b);
            },
            pause: function () { if (!run || run.paused) return; run.paused = true; try { window.speechSynthesis.pause(); } catch (e) {} updateBar(); },
            resume: function () {
                if (!run || !run.paused) return;
                run.paused = false;
                if (window.speechSynthesis.speaking) window.speechSynthesis.resume(); else step(run.token);
                updateBar();
            },
            toggle: function () { if (run) { api.stop(); return false; } return api.start(); },
            state: function () { return run ? { index: run.index, total: run.segs.length, paused: run.paused } : null; }
        };
        window.__brReadAloud = api;
    })();
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
        var SpeechRecognition = function SpeechRecognition() { this.continuous = false; this.interimResults = false; this.lang = ''; this.maxAlternatives = 1; this.onresult = this.onerror = this.onend = this.onstart = this.onnomatch = null; };
        SpeechRecognition.prototype.start = function () {
            var self = this;
            setTimeout(function () { if (self.onstart) self.onstart({}); if (self.onerror) self.onerror({ error: 'not-allowed', message: 'Speech recognition is not available' }); if (self.onend) self.onend({}); }, 0);
        };
        SpeechRecognition.prototype.stop = SpeechRecognition.prototype.abort = noop;
        SpeechRecognition.prototype.addEventListener = function (t, f) { this['on' + t] = f; };
        SpeechRecognition.prototype.removeEventListener = function (t) { this['on' + t] = null; };
        window.SpeechRecognition = window.webkitSpeechRecognition = SpeechRecognition;
        window.SpeechGrammarList = window.webkitSpeechGrammarList = function SpeechGrammarList() { this.length = 0; this.addFromString = noop; this.addFromURI = noop; };
        window.SpeechRecognitionEvent = window.webkitSpeechRecognitionEvent = function SpeechRecognitionEvent() {};
    }

    // ---- crypto.subtle: SHA digests here, the rest further down (brSubtle)
    // Key bytes, and what is made of them, go only through this code's own arithmetic and through the elements and
    // lengths of arrays it made itself (own properties in this engine) - never through a method, a constructor or a Math
    // function a page can put in place: a page script that replaced Uint8Array.prototype.set, Array.prototype.push or
    // indexOf read the bytes of keys made not extractable, or used a key for what its usages do not allow. Typed arrays
    // come from the constructor of before any page script. (Not its set either: core-js may have put its own there,
    // which looks things up on the array it gets.)
    var CryptoU8 = window.Uint8Array;
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }
    // The end of a message for SHA-1/2: its bytes after the whole blocks, 0x80, zeros, and the length in bits big-endian
    // in the last 8 bytes (of the 16 that SHA-384/512 keep for it). `total` is the length hashed, a key block hashed in
    // front of the message counted in. Only this tail is copied: the whole blocks are read from the message itself.
    function hashTail(bytes, from, total, bs, lenBytes) {
        var rem = bytes.length - from, n = rem + 1 + lenBytes > bs ? 2 * bs : bs, t = new CryptoU8(n), i;
        for (i = 0; i < rem; i++) t[i] = bytes[from + i];
        t[rem] = 0x80;
        var bits = total * 8, hi = (bits / 4294967296) | 0, lo = bits >>> 0;
        t[n - 8] = (hi >>> 24) & 255; t[n - 7] = (hi >>> 16) & 255; t[n - 6] = (hi >>> 8) & 255; t[n - 5] = hi & 255;
        t[n - 4] = (lo >>> 24) & 255; t[n - 3] = (lo >>> 16) & 255; t[n - 2] = (lo >>> 8) & 255; t[n - 1] = lo & 255;
        return t;
    }
    function readWords(msg, off, w, n) { for (var i = 0; i < n; i++) w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3]; }
    function wordsToBytes(H) { var out = new CryptoU8(H.length * 4); for (var i = 0; i < H.length; i++) { out[i * 4] = H[i] >>> 24; out[i * 4 + 1] = (H[i] >>> 16) & 255; out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255; } return out; }
    var K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
                0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
                0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
                0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    // one 64-byte block at `off` of msg into the state H (w: the message schedule, an array of the caller's)
    function sha256Block(H, w, msg, off) {
        var i;
        readWords(msg, off, w, 16);
        for (i = 16; i < 64; i++) {
            var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
        for (i = 0; i < 64; i++) {
            var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
            var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    // pre: a block hashed in front of bytes (HMAC's key block), or nothing
    function sha256(bytes, pre) {
        var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        var w = [], l = bytes.length, full = l - l % 64, tail = hashTail(bytes, full, (pre ? 64 : 0) + l, 64, 8), off;
        if (pre) sha256Block(H, w, pre, 0);
        for (off = 0; off < full; off += 64) sha256Block(H, w, bytes, off);
        for (off = 0; off < tail.length; off += 64) sha256Block(H, w, tail, off);
        return wordsToBytes(H);
    }
    function sha1Block(H, w, msg, off) {
        var i;
        readWords(msg, off, w, 16);
        for (i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4];
        for (i = 0; i < 80; i++) {
            var f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            var t = (rotl(a, 5) + f + e + k + w[i]) | 0;
            e = d; d = c; c = rotl(b, 30); b = a; a = t;
        }
        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
    }
    function sha1(bytes, pre) {
        var H = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
        var w = [], l = bytes.length, full = l - l % 64, tail = hashTail(bytes, full, (pre ? 64 : 0) + l, 64, 8), off;
        if (pre) sha1Block(H, w, pre, 0);
        for (off = 0; off < full; off += 64) sha1Block(H, w, bytes, off);
        for (off = 0; off < tail.length; off += 64) sha1Block(H, w, tail, off);
        return wordsToBytes(H);
    }
    function toBytes(data) {
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
        if (typeof data === 'string') return new TextEncoder().encode(data);
        return new Uint8Array(0);
    }
    // Blob URLs: core-js replaces URL and the old engine only has webkitURL.createObjectURL
    if (window.URL && !window.URL.createObjectURL && window.webkitURL && window.webkitURL.createObjectURL) {
        var nativeURLObject = window.webkitURL;
        window.URL.createObjectURL = function (blob) { return nativeURLObject.createObjectURL(blob); };
        window.URL.revokeObjectURL = function (url) { return nativeURLObject.revokeObjectURL(url); };
    }
    // ---- crypto.subtle beyond digests: SHA-384/512, HMAC sign/verify, AES-GCM/CBC/CTR encrypt/decrypt, PBKDF2 and HKDF,
    // secret keys imported, exported (raw bytes or JWK) and generated. Public-key algorithms stay unavailable. Written
    // from the specifications (AES after SJCL's table method); tools/crypto-test.html compares every operation with a
    // current browser's own. (AWS WAF's challenge in front of imdb.com encrypts with AES-GCM: it failed here.)
    // (the notice is here rather than at the AES code below: the minifier keeps a /*! comment in front of a statement it
    // leaves alone, and the var statements there are merged)
    /*! The AES code below (aesTables, aesKey, aesBlock) follows aes.js of the Stanford Javascript Crypto Library (SJCL):
     * Copyright 2009-2010 Emily Stark, Mike Hamburg, Dan Boneh, Stanford University. All rights reserved.
     * SJCL is dual-licensed under the GNU GPL version 2.0 or higher and the 2-clause BSD license; used here under the
     * 2-clause BSD license:
     * Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
     * following conditions are met:
     * 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the
     *    following disclaimer.
     * 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
     *    following disclaimer in the documentation and/or other materials provided with the distribution.
     * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
     * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
     * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
     * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
     * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
     * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
     * USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
     */
    var brSubtle = (function () {
        if (!P || !window.Uint8Array) return null;
        var K512 = [0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65, 0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b, 0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3, 0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec, 0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817];
        var H512 = [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1, 0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179];
        var H384 = [0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939, 0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4];
        var TWO32 = 4294967296;
        // SHA-512 on 64-bit words kept as (high, low) 32-bit halves; a carry is (x / TWO32) | 0, x never negative here
        // (not Math.floor: the sums it got hold message words, the key's in HMAC)
        var add64 = function (H, k, xh, xl) { var s = (H[k + 1] >>> 0) + (xl >>> 0); H[k] = (H[k] + xh + ((s / TWO32) | 0)) | 0; H[k + 1] = s | 0; };
        var sha512Block = function (H, W, msg, off) {
            var i, p;
            for (i = 0; i < 32; i++) { p = off + i * 4; W[i] = (msg[p] << 24) | (msg[p + 1] << 16) | (msg[p + 2] << 8) | msg[p + 3]; }
            for (i = 16; i < 80; i++) {
                var xh = W[2 * i - 30], xl = W[2 * i - 29];
                var s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
                var s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
                xh = W[2 * i - 4]; xl = W[2 * i - 3];
                var s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
                var s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
                var lo = (s1l >>> 0) + (W[2 * i - 13] >>> 0) + (s0l >>> 0) + (W[2 * i - 31] >>> 0);
                W[2 * i] = (s1h + W[2 * i - 14] + s0h + W[2 * i - 32] + ((lo / TWO32) | 0)) | 0;
                W[2 * i + 1] = lo | 0;
            }
            var ah = H[0], al = H[1], bh2 = H[2], bl2 = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
            var eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
            for (i = 0; i < 80; i++) {
                var S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
                var S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
                var chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
                var t1l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K512[2 * i + 1] >>> 0) + (W[2 * i + 1] >>> 0);
                var t1h = hh + S1h + chh + K512[2 * i] + W[2 * i] + ((t1l / TWO32) | 0);
                var S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
                var S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
                var mjh = (ah & bh2) ^ (ah & ch) ^ (bh2 & ch), mjl = (al & bl2) ^ (al & cl) ^ (bl2 & cl);
                var t2l = (S0l >>> 0) + (mjl >>> 0), t2h = S0h + mjh + ((t2l / TWO32) | 0);
                hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
                var nel = (dl >>> 0) + (t1l >>> 0) % TWO32;
                eh = (dh + t1h + ((nel / TWO32) | 0)) | 0; el = nel | 0;
                dh = ch; dl = cl; ch = bh2; cl = bl2; bh2 = ah; bl2 = al;
                var nal = (t1l % TWO32) + (t2l % TWO32);
                ah = (t1h + t2h + ((nal / TWO32) | 0)) | 0; al = nal | 0;
            }
            add64(H, 0, ah, al); add64(H, 2, bh2, bl2); add64(H, 4, ch, cl); add64(H, 6, dh, dl); add64(H, 8, eh, el); add64(H, 10, fh, fl); add64(H, 12, gh, gl); add64(H, 14, hh, hl);
        };
        // (pre as for sha256)
        var sha512 = function (bytes, is384, pre) {
            var I = is384 ? H384 : H512, H = [], W = [], l = bytes.length, full = l - l % 128, tail = hashTail(bytes, full, (pre ? 128 : 0) + l, 128, 16), off, i;
            for (i = 0; i < 16; i++) H[i] = I[i];
            if (pre) sha512Block(H, W, pre, 0);
            for (off = 0; off < full; off += 128) sha512Block(H, W, bytes, off);
            for (off = 0; off < tail.length; off += 128) sha512Block(H, W, tail, off);
            var n = is384 ? 12 : 16, out = new CryptoU8(n * 4);
            for (i = 0; i < n; i++) { out[i * 4] = H[i] >>> 24; out[i * 4 + 1] = (H[i] >>> 16) & 255; out[i * 4 + 2] = (H[i] >>> 8) & 255; out[i * 4 + 3] = H[i] & 255; }
            return out;
        };
        // name -> [hash, block size, output size]. (No prototype: a name a page put on Object.prototype would have been
        // a "hash" here, and HMAC hands its hash the key block.)
        var HASHES = Object.create(null);
        HASHES['SHA-1'] = [sha1, 64, 20];
        HASHES['SHA-256'] = [sha256, 64, 32];
        HASHES['SHA-384'] = [function (b, pre) { return sha512(b, true, pre); }, 128, 48];
        HASHES['SHA-512'] = [function (b, pre) { return sha512(b, false, pre); }, 128, 64];
        var algName = function (a) { return String(typeof a === 'string' ? a : (a && a.name) || '').toUpperCase(); };
        var hashName = function (h) { var n = algName(h); if (/^SHA\d/.test(n)) n = 'SHA-' + n.slice(3); return HASHES[n] ? n : null; };
        // HMAC: the key (hashed first when longer than a block) XOR 0x36 and XOR 0x5c, each block hashed in front of its
        // message - no copy of the two together. The pair [inner, outer] serves a whole PBKDF2 or HKDF run.
        var hmacPads = function (hn, key) {
            var hf = HASHES[hn], bs = hf[1], k = key.length > bs ? hf[0](key) : key, ipad = new CryptoU8(bs), opad = new CryptoU8(bs), i, kb;
            for (i = 0; i < bs; i++) { kb = i < k.length ? k[i] : 0; ipad[i] = kb ^ 0x36; opad[i] = kb ^ 0x5c; }
            return [ipad, opad];
        };
        var hmacWith = function (hn, pads, data) { var h = HASHES[hn][0]; return h(h(data, pads[0]), pads[1]); };
        var hmac = function (hn, key, data) { return hmacWith(hn, hmacPads(hn, key), data); };
        // ---- AES (SJCL's tables: the S-box and the combined round tables, both directions; SJCL's BSD notice is above
        // brSubtle)
        var T = null;
        var aesTables = function () {
            if (T) return T;
            var enc = [[], [], [], [], []], dec = [[], [], [], [], []], sbox = enc[4], sboxInv = dec[4], d = [], th = [], i, x, xInv, x2, x4, x8, s, tEnc, tDec;
            for (i = 0; i < 256; i++) th[(d[i] = i << 1 ^ (i >> 7) * 283) ^ i] = i;
            for (x = xInv = 0; !sbox[x]; x ^= x2 || 1, xInv = th[xInv] || 1) {
                s = xInv ^ xInv << 1 ^ xInv << 2 ^ xInv << 3 ^ xInv << 4;
                s = s >> 8 ^ s & 255 ^ 99;
                sbox[x] = s;
                sboxInv[s] = x;
                x8 = d[x4 = d[x2 = d[x]]];
                tDec = x8 * 0x1010101 ^ x4 * 0x10001 ^ x2 * 0x101 ^ x * 0x1010100;
                tEnc = d[s] * 0x101 ^ s * 0x1010100;
                for (i = 0; i < 4; i++) {
                    enc[i][x] = tEnc = tEnc << 24 ^ tEnc >>> 8;
                    dec[i][s] = tDec = tDec << 24 ^ tDec >>> 8;
                }
            }
            T = [enc, dec];
            return T;
        };
        var aesKey = function (bytes) {
            var t = aesTables(), sbox = t[0][4], decT = t[1], keyLen = bytes.length / 4, encKey = [], decKey = [], i, j, tmp, rcon = 1;
            // (the key words go straight into the schedule: push and slice were the page's to replace)
            for (i = 0; i < keyLen; i++) encKey[i] = (bytes[4 * i] << 24) | (bytes[4 * i + 1] << 16) | (bytes[4 * i + 2] << 8) | bytes[4 * i + 3];
            for (i = keyLen; i < 4 * keyLen + 28; i++) {
                tmp = encKey[i - 1];
                if (i % keyLen === 0 || (keyLen === 8 && i % keyLen === 4)) {
                    tmp = sbox[tmp >>> 24] << 24 ^ sbox[tmp >> 16 & 255] << 16 ^ sbox[tmp >> 8 & 255] << 8 ^ sbox[tmp & 255];
                    if (i % keyLen === 0) { tmp = tmp << 8 ^ tmp >>> 24 ^ rcon << 24; rcon = rcon << 1 ^ (rcon >> 7) * 283; }
                }
                encKey[i] = encKey[i - keyLen] ^ tmp;
            }
            for (j = 0; i; j++, i--) {
                tmp = encKey[j & 3 ? i : i - 4];
                if (i <= 4 || j < 4) decKey[j] = tmp;
                else decKey[j] = decT[0][sbox[tmp >>> 24]] ^ decT[1][sbox[tmp >> 16 & 255]] ^ decT[2][sbox[tmp >> 8 & 255]] ^ decT[3][sbox[tmp & 255]];
            }
            return [encKey, decKey];
        };
        // one block (4 big-endian words) through the cipher: dir 0 encrypts, 1 decrypts
        var aesBlock = function (ks, input, dir) {
            var key = ks[dir], a = input[0] ^ key[0], b = input[dir ? 3 : 1] ^ key[1], c = input[2] ^ key[2], d = input[dir ? 1 : 3] ^ key[3];
            var a2, b2, c2, rounds = key.length / 4 - 2, i, k = 4, out = [0, 0, 0, 0], table = aesTables()[dir];
            var t0 = table[0], t1 = table[1], t2 = table[2], t3 = table[3], sbox = table[4];
            for (i = 0; i < rounds; i++) {
                a2 = t0[a >>> 24] ^ t1[b >> 16 & 255] ^ t2[c >> 8 & 255] ^ t3[d & 255] ^ key[k];
                b2 = t0[b >>> 24] ^ t1[c >> 16 & 255] ^ t2[d >> 8 & 255] ^ t3[a & 255] ^ key[k + 1];
                c2 = t0[c >>> 24] ^ t1[d >> 16 & 255] ^ t2[a >> 8 & 255] ^ t3[b & 255] ^ key[k + 2];
                d = t0[d >>> 24] ^ t1[a >> 16 & 255] ^ t2[b >> 8 & 255] ^ t3[c & 255] ^ key[k + 3];
                k += 4;
                a = a2; b = b2; c = c2;
            }
            for (i = 0; i < 4; i++) {
                out[dir ? 3 & -i : i] = sbox[a >>> 24] << 24 ^ sbox[b >> 16 & 255] << 16 ^ sbox[c >> 8 & 255] << 8 ^ sbox[d & 255] ^ key[k++];
                a2 = a; a = b; b = c; c = d; d = a2;
            }
            return out;
        };
        var words = function (b, o) { return [(b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3], (b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7],
            (b[o + 8] << 24) | (b[o + 9] << 16) | (b[o + 10] << 8) | b[o + 11], (b[o + 12] << 24) | (b[o + 13] << 16) | (b[o + 14] << 8) | b[o + 15]]; };
        var putWords = function (w, b, o) { for (var i = 0; i < 4; i++) { b[o + 4 * i] = w[i] >>> 24; b[o + 4 * i + 1] = (w[i] >>> 16) & 255; b[o + 4 * i + 2] = (w[i] >>> 8) & 255; b[o + 4 * i + 3] = w[i] & 255; } };
        var err = function (name, msg) { return domException(name, msg); };
        // ---- GCM
        var gmul = function (x, y) {
            var z0 = 0, z1 = 0, z2 = 0, z3 = 0, v0 = y[0], v1 = y[1], v2 = y[2], v3 = y[3], i, lsb;
            for (i = 0; i < 128; i++) {
                if ((x[i >>> 5] >>> (31 - (i & 31))) & 1) { z0 ^= v0; z1 ^= v1; z2 ^= v2; z3 ^= v3; }
                lsb = v3 & 1;
                v3 = (v3 >>> 1) | (v2 << 31); v2 = (v2 >>> 1) | (v1 << 31); v1 = (v1 >>> 1) | (v0 << 31); v0 = v0 >>> 1;
                if (lsb) v0 ^= 0xE1000000;
            }
            return [z0, z1, z2, z3];
        };
        var ghashInto = function (Hk, y, bytes) {
            var padded = bytes.length % 16 ? new Uint8Array(bytes.length + 16 - bytes.length % 16) : bytes;
            if (padded !== bytes) padded.set(bytes);
            for (var o = 0; o < padded.length; o += 16) {
                var w = words(padded, o);
                y = gmul([y[0] ^ w[0], y[1] ^ w[1], y[2] ^ w[2], y[3] ^ w[3]], Hk);
            }
            return y;
        };
        var lenBlock = function (a, c) {
            var b = new Uint8Array(16), la = a * 8, lc = c * 8;
            var put = function (v, o) { var h = Math.floor(v / TWO32), l = v >>> 0; b[o] = h >>> 24; b[o + 1] = (h >>> 16) & 255; b[o + 2] = (h >>> 8) & 255; b[o + 3] = h & 255; b[o + 4] = l >>> 24; b[o + 5] = (l >>> 16) & 255; b[o + 6] = (l >>> 8) & 255; b[o + 7] = l & 255; };
            put(la, 0); put(lc, 8);
            return b;
        };
        // (counter blocks copied element by element, not with slice: for an IV of other than 12 bytes they come from the
        // GHASH key, and a slice of the page's would have seen them)
        var gctr = function (ks, cb, input) {
            var out = new Uint8Array(input.length), ctr = [cb[0], cb[1], cb[2], cb[3]], blk = new CryptoU8(16);
            for (var o = 0; o < input.length; o += 16) {
                putWords(aesBlock(ks, ctr, 0), blk, 0);
                for (var i = 0; i < 16 && o + i < input.length; i++) out[o + i] = input[o + i] ^ blk[i];
                ctr[3] = (ctr[3] + 1) | 0;
            }
            return out;
        };
        var gcm = function (ks, iv, aad, data, tagBits, decrypt) {
            var Hk = aesBlock(ks, [0, 0, 0, 0], 0), J0;
            if (iv.length === 12) J0 = [(iv[0] << 24) | (iv[1] << 16) | (iv[2] << 8) | iv[3], (iv[4] << 24) | (iv[5] << 16) | (iv[6] << 8) | iv[7], (iv[8] << 24) | (iv[9] << 16) | (iv[10] << 8) | iv[11], 1];
            else J0 = ghashInto(Hk, ghashInto(Hk, [0, 0, 0, 0], iv), lenBlock(0, iv.length));
            var tagLen = tagBits / 8, ct = data;
            if (decrypt) {
                if (data.length < tagLen) throw err('OperationError', 'The data is too short');
                ct = data.subarray(0, data.length - tagLen);
            }
            var start = [J0[0], J0[1], J0[2], (J0[3] + 1) | 0];
            var body = decrypt ? null : gctr(ks, start, data), cipher = decrypt ? ct : body;
            var S = ghashInto(Hk, ghashInto(Hk, ghashInto(Hk, [0, 0, 0, 0], aad), cipher), lenBlock(aad.length, cipher.length));
            var tagFull = new CryptoU8(16), ej = aesBlock(ks, J0, 0);
            putWords([ej[0] ^ S[0], ej[1] ^ S[1], ej[2] ^ S[2], ej[3] ^ S[3]], tagFull, 0);
            if (decrypt) {
                var given = data.subarray(data.length - tagLen), diff = 0;
                for (var i = 0; i < tagLen; i++) diff |= given[i] ^ tagFull[i];
                if (diff) throw err('OperationError', 'The operation failed for an operation-specific reason');
                return gctr(ks, start, ct);
            }
            var out = new Uint8Array(body.length + tagLen);
            out.set(body);
            out.set(tagFull.subarray(0, tagLen), body.length);
            return out;
        };
        // ---- CBC (PKCS #7 padding) and CTR (a counter of `length` low bits)
        var cbc = function (ks, iv, data, decrypt) {
            var prev = words(iv, 0), i, o, w;
            if (!decrypt) {
                var pad = 16 - data.length % 16, inp = new Uint8Array(data.length + pad), outE = new Uint8Array(inp.length);
                inp.set(data);
                for (i = data.length; i < inp.length; i++) inp[i] = pad;
                for (o = 0; o < inp.length; o += 16) {
                    w = words(inp, o);
                    prev = aesBlock(ks, [w[0] ^ prev[0], w[1] ^ prev[1], w[2] ^ prev[2], w[3] ^ prev[3]], 0);
                    putWords(prev, outE, o);
                }
                return outE;
            }
            if (!data.length || data.length % 16) throw err('OperationError', 'The data is not a whole number of blocks');
            var outD = new Uint8Array(data.length);
            for (o = 0; o < data.length; o += 16) {
                w = words(data, o);
                var p = aesBlock(ks, w, 1);
                putWords([p[0] ^ prev[0], p[1] ^ prev[1], p[2] ^ prev[2], p[3] ^ prev[3]], outD, o);
                prev = w;
            }
            var n = outD[outD.length - 1];
            if (n < 1 || n > 16) throw err('OperationError', 'Bad padding');
            for (i = outD.length - n; i < outD.length; i++) if (outD[i] !== n) throw err('OperationError', 'Bad padding');
            return outD.subarray(0, outD.length - n);
        };
        var ctrMode = function (ks, counter, length, data) {
            var ctr = new Uint8Array(counter), out = new Uint8Array(data.length), blk = new CryptoU8(16);
            for (var o = 0; o < data.length; o += 16) {
                putWords(aesBlock(ks, words(ctr, 0), 0), blk, 0);
                for (var i = 0; i < 16 && o + i < data.length; i++) out[o + i] = data[o + i] ^ blk[i];
                // (the low `length` bits count up, wrapping; the others stay)
                for (var bit = 0, pos = 15; bit < length && pos >= 0; pos--, bit += 8) {
                    var span = Math.min(8, length - bit), mask = (1 << span) - 1, v = ctr[pos] & mask;
                    v = (v + 1) & mask;
                    ctr[pos] = (ctr[pos] & ~mask & 255) | v;
                    if (v !== 0) break;
                }
            }
            return out;
        };
        // ---- keys
        var b64u = function (bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
        var unb64u = function (s) {
            s = String(s).replace(/-/g, '+').replace(/_/g, '/');
            while (s.length % 4) s += '=';
            var bin = atob(s), out = new CryptoU8(bin.length);
            for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        };
        var CryptoKeyC = window.CryptoKey || function CryptoKey() { throw new TypeError('Illegal constructor'); };
        if (!window.CryptoKey) window.CryptoKey = CryptoKeyC;
        var AES = { 'AES-GCM': 1, 'AES-CBC': 1, 'AES-CTR': 1, 'AES-KW': 1 };
        // The key bytes never sit on the key object: a key that is not extractable must not give them to the page's
        // scripts (sites keep such keys so that an injected script cannot take them). The key carries a function that
        // puts its record - bytes, algorithm, usages, extractable - into `held`, which only this closure can read; a
        // forged key with extractable: true that borrows that function still gets the real key's record and its
        // extractable. (A WeakMap would do, but the engine has none and the shims' stand-in keeps entries on the key.)
        var held = null;
        // generated keys: the engine's own generator, taken before any page script could put another in its place, and
        // bound to its Crypto object now (a call through the page's Function.prototype.call would hand it the new key);
        // without one generateKey fails (never Math.random, see shims.js)
        var rngOwner = window.crypto, rngFill = rngOwner && rngOwner.getRandomValues;
        var rngCall = typeof rngFill === 'function' && rngFill.bind ? rngFill.bind(rngOwner) : null;
        // usages as bits, which keyOf tests without a method a page can replace (one whose indexOf answered 0 decrypted
        // with an encrypt-only key)
        var USE = { encrypt: 1, decrypt: 2, sign: 4, verify: 8, deriveKey: 16, deriveBits: 32, wrapKey: 64, unwrapKey: 128 };
        // (own properties: a CryptoKey prototype of the engine's has getters only)
        // (the CryptoKey of the moment: the interface stubs further down may put another one in place)
        var makeKey = function (raw, alg, extractable, usages) {
            var C = typeof window.CryptoKey === 'function' ? window.CryptoKey : CryptoKeyC;
            var k = Object.create(C.prototype), own = function (name, v, en) { Object.defineProperty(k, name, { value: v, enumerable: en, configurable: true }); };
            var use = Array.prototype.slice.call(usages || []), bits = 0;
            for (var i = 0; i < use.length; i++) bits |= USE[use[i]] | 0;
            var rec = { raw: raw, name: alg.name, hash: alg.hash ? alg.hash.name : '', extractable: !!extractable, usages: use.slice(), use: bits };
            own('type', 'secret', true);
            own('extractable', rec.extractable, true);
            own('algorithm', alg, true);
            own('usages', use, true);
            Object.defineProperty(k, '__brKey', { value: function () { held = rec; } });
            return k;
        };
        var keyAlgorithm = function (name, algorithm, raw) {
            if (AES[name]) {
                if (raw.length !== 16 && raw.length !== 24 && raw.length !== 32) throw err('DataError', 'AES key data must be 128, 192 or 256 bits');
                return { name: name, length: raw.length * 8 };
            }
            if (name === 'HMAC') {
                var hn = hashName(algorithm && algorithm.hash);
                if (!hn) throw err('NotSupportedError', 'Unrecognized hash');
                return { name: 'HMAC', hash: { name: hn }, length: raw.length * 8 };
            }
            if (name === 'PBKDF2' || name === 'HKDF') return { name: name };
            throw err('NotSupportedError', 'Algorithm: Unrecognized name');
        };
        var JWK_ALG = { 'AES-GCM': 'GCM', 'AES-CBC': 'CBC', 'AES-CTR': 'CTR', 'AES-KW': 'KW' };
        // a key's record (see makeKey), for an operation that needs `usage` among its usages, as the standard checks
        var keyOf = function (key, usage) {
            var f = key && (typeof key === 'object' || typeof key === 'function') ? key.__brKey : null, rec;
            held = null;
            if (typeof f === 'function') f();
            rec = held;
            held = null;
            if (!rec) throw err('InvalidAccessError', 'The key is not usable here');
            if (usage && !(rec.use & USE[usage])) throw err('InvalidAccessError', "The key's usages do not include '" + usage + "'");
            return rec;
        };
        // (KDF base keys are never extractable, as the standard and other browsers have it)
        var KDF = { PBKDF2: 1, HKDF: 1 };
        var run = function (fn) { return new P(function (resolve) { resolve(fn()); }); };
        var copy = function (u) { var out = new Uint8Array(u.length); out.set(u); return out.buffer; };
        var deriveBitsNow = function (algorithm, baseKey, length, usage) {
            var name = algName(algorithm), hn = hashName(algorithm.hash);
            if (!KDF[name]) throw err('NotSupportedError', 'Algorithm: Unrecognized name');
            if (!hn) throw err('NotSupportedError', 'Unrecognized hash');
            var base = keyOf(baseKey, usage), raw = base.raw;
            if (base.name !== name) throw err('InvalidAccessError', 'The key does not match the algorithm');
            if (!length || length % 8) throw err('OperationError', 'The length must be a multiple of 8');
            // (what holds derived bits is copied element by element: deriveKey's bits are a key)
            var n = length / 8, hl = HASHES[hn][2], out = new CryptoU8(n), i, j, k, u, t, pads;
            if (name === 'PBKDF2') {
                var salt = toBytes(algorithm.salt), iters = algorithm.iterations | 0;
                if (iters < 1) throw err('OperationError', 'The iterations must be at least 1');
                pads = hmacPads(hn, raw);
                for (i = 1, k = 0; k < n; i++) {
                    var block = new Uint8Array(salt.length + 4);
                    block.set(salt);
                    block[salt.length] = i >>> 24; block[salt.length + 1] = (i >>> 16) & 255; block[salt.length + 2] = (i >>> 8) & 255; block[salt.length + 3] = i & 255;
                    // (U1 becomes the sum T: each U is read whole before the next is added)
                    t = u = hmacWith(hn, pads, block);
                    for (j = 1; j < iters; j++) { u = hmacWith(hn, pads, u); for (var q = 0; q < hl; q++) t[q] ^= u[q]; }
                    for (j = 0; j < hl && k < n; j++) out[k++] = t[j];
                }
                return out;
            }
            if (name === 'HKDF') {
                var prk = hmac(hn, algorithm.salt ? toBytes(algorithm.salt) : new CryptoU8(hl), raw), info = algorithm.info ? toBytes(algorithm.info) : new Uint8Array(0), il = info.length;
                if (n > 255 * hl) throw err('OperationError', 'The length is too big');
                pads = hmacPads(hn, prk);
                t = new CryptoU8(0);
                for (i = 1, k = 0; k < n; i++) {
                    var tl = t.length, m = new CryptoU8(tl + il + 1);
                    for (j = 0; j < tl; j++) m[j] = t[j];
                    for (j = 0; j < il; j++) m[tl + j] = info[j];
                    m[tl + il] = i;
                    t = hmacWith(hn, pads, m);
                    for (j = 0; j < hl && k < n; j++) out[k++] = t[j];
                }
                return out;
            }
            throw err('NotSupportedError', 'Algorithm: Unrecognized name');
        };
        var importNow = function (format, keyData, algorithm, extractable, usages) {
            var name = algName(algorithm), raw;
            if (KDF[name] && extractable) throw err('SyntaxError', 'KDF keys must set extractable=false');
            if (format === 'raw') {
                var src = toBytes(keyData);
                raw = new CryptoU8(src.length);
                for (var i = 0; i < raw.length; i++) raw[i] = src[i];
            } else if (format === 'jwk') {
                if (!keyData || keyData.kty !== 'oct' || typeof keyData.k !== 'string') throw err('DataError', 'Only symmetric JWK keys are supported');
                raw = unb64u(keyData.k);
            } else throw err('NotSupportedError', 'Unsupported key format');
            return makeKey(raw, keyAlgorithm(name, algorithm, raw), extractable, usages);
        };
        var cryptNow = function (algorithm, key, data, decrypt) {
            var name = algName(algorithm), rec = keyOf(key, decrypt ? 'decrypt' : 'encrypt'), bytes = toBytes(data);
            if (!AES[name] || rec.name !== name) throw err('InvalidAccessError', 'The key does not match the algorithm');
            var ks = aesKey(rec.raw);
            if (name === 'AES-GCM') {
                var iv = toBytes(algorithm.iv), tl = algorithm.tagLength === undefined ? 128 : algorithm.tagLength;
                if (!iv.length) throw err('OperationError', 'The iv must not be empty');
                // (compared one by one: with the page's indexOf a tag of 0 bits would have let anything decrypt)
                if (tl !== 128 && tl !== 120 && tl !== 112 && tl !== 104 && tl !== 96 && tl !== 64 && tl !== 32) throw err('OperationError', 'Bad tagLength');
                return gcm(ks, iv, algorithm.additionalData ? toBytes(algorithm.additionalData) : new Uint8Array(0), bytes, tl, decrypt);
            }
            if (name === 'AES-CBC') {
                var civ = toBytes(algorithm.iv);
                if (civ.length !== 16) throw err('OperationError', 'The iv must be 16 bytes');
                return cbc(ks, civ, bytes, decrypt);
            }
            if (name === 'AES-CTR') {
                var ctr = toBytes(algorithm.counter), len = algorithm.length | 0;
                if (ctr.length !== 16 || len < 1 || len > 128) throw err('OperationError', 'Bad counter or length');
                return ctrMode(ks, ctr, len, bytes);
            }
            throw err('NotSupportedError', 'Algorithm: Unrecognized name');
        };
        return {
            digest: function (algorithm, data) {
                return run(function () {
                    var hn = hashName(algorithm);
                    if (!hn) throw err('NotSupportedError', 'Algorithm: Unrecognized name');
                    return HASHES[hn][0](toBytes(data)).buffer;
                });
            },
            importKey: function (format, keyData, algorithm, extractable, usages) { return run(function () { return importNow(format, keyData, algorithm, extractable, usages); }); },
            exportKey: function (format, key) {
                return run(function () {
                    // (what the key was made with, not its properties: a page can redefine those)
                    var rec = keyOf(key);
                    if (!rec.extractable) throw err('InvalidAccessError', 'The key is not extractable');
                    if (format === 'raw') return copy(rec.raw);
                    if (format === 'jwk') {
                        var alg = rec.name === 'HMAC' ? 'HS' + rec.hash.slice(4) : JWK_ALG[rec.name] ? 'A' + rec.raw.length * 8 + JWK_ALG[rec.name] : undefined;
                        var jwk = { kty: 'oct', k: b64u(rec.raw), ext: true, key_ops: rec.usages.slice() };
                        if (alg) jwk.alg = alg;
                        return jwk;
                    }
                    throw err('NotSupportedError', 'Unsupported key format');
                });
            },
            generateKey: function (algorithm, extractable, usages) {
                return run(function () {
                    var name = algName(algorithm), n;
                    if (AES[name]) n = (algorithm.length | 0) / 8;
                    else if (name === 'HMAC') { var hn = hashName(algorithm.hash); if (!hn) throw err('NotSupportedError', 'Unrecognized hash'); n = algorithm.length ? Math.ceil(algorithm.length / 8) : HASHES[hn][1]; }
                    else throw err('NotSupportedError', 'Algorithm: Unrecognized name');
                    if (!rngCall) throw err('OperationError', 'No secure random source is available');
                    var raw = new CryptoU8(n);
                    rngCall(raw);
                    return makeKey(raw, keyAlgorithm(name, algorithm, raw), extractable, usages);
                });
            },
            encrypt: function (algorithm, key, data) { return run(function () { return copy(cryptNow(algorithm, key, data, false)); }); },
            decrypt: function (algorithm, key, data) { return run(function () { return copy(cryptNow(algorithm, key, data, true)); }); },
            sign: function (algorithm, key, data) {
                return run(function () {
                    if (algName(algorithm) !== 'HMAC') throw err('NotSupportedError', 'Only HMAC signatures are available');
                    var rec = keyOf(key, 'sign');
                    if (rec.name !== 'HMAC') throw err('InvalidAccessError', 'The key does not match the algorithm');
                    return hmac(rec.hash, rec.raw, toBytes(data)).buffer;
                });
            },
            verify: function (algorithm, key, signature, data) {
                return run(function () {
                    if (algName(algorithm) !== 'HMAC') throw err('NotSupportedError', 'Only HMAC signatures are available');
                    var rec = keyOf(key, 'verify');
                    if (rec.name !== 'HMAC') throw err('InvalidAccessError', 'The key does not match the algorithm');
                    var mac = hmac(rec.hash, rec.raw, toBytes(data)), sig = toBytes(signature), diff = mac.length ^ sig.length;
                    for (var i = 0; i < mac.length && i < sig.length; i++) diff |= mac[i] ^ sig[i];
                    return diff === 0;
                });
            },
            deriveBits: function (algorithm, baseKey, length) { return run(function () { return deriveBitsNow(algorithm, baseKey, length, 'deriveBits').buffer; }); },
            deriveKey: function (algorithm, baseKey, derivedKeyType, extractable, usages) {
                return run(function () {
                    var dn = algName(derivedKeyType), len = derivedKeyType.length;
                    if (KDF[dn] && extractable) throw err('SyntaxError', 'KDF keys must set extractable=false');
                    if (dn === 'HMAC' && !len) { var hn = hashName(derivedKeyType.hash); len = hn ? HASHES[hn][1] * 8 : 0; }
                    var bits = deriveBitsNow(algorithm, baseKey, len, 'deriveKey');
                    return makeKey(bits, keyAlgorithm(dn, derivedKeyType, bits), extractable, usages);
                });
            },
            wrapKey: rejectWith('NotSupportedError', 'This operation is not available in this browser'),
            unwrapKey: rejectWith('NotSupportedError', 'This operation is not available in this browser')
        };
    })();
    try { Object.defineProperty(window, '__brSubtleImpl', { value: brSubtle, configurable: true }); } catch (e) {}   // (for tools/crypto-test.html)
    if (window.crypto && !window.crypto.subtle && !window.crypto.webkitSubtle) {
        var subtle = brSubtle;
        // getRandomValues of this engine fills the array but returns nothing (apple.com reads [0] of the result)
        try {
            var cproto = Object.getPrototypeOf(window.crypto), nativeGRV = cproto && cproto.getRandomValues;
            if (nativeGRV && !nativeGRV.__brFixed) {
                var fixedGRV = function getRandomValues(arr) { var r = nativeGRV.call(this, arr); return r === undefined ? arr : r; };
                fixedGRV.__brFixed = true;
                cproto.getRandomValues = fixedGRV;
            }
        } catch (e5) {}
        // Expandos on the Crypto wrapper vanish when the old engine garbage-collects and recreates the wrapper,
        // so the property lives on the prototype (and the wrapper is pinned below just in case).
        try { Object.defineProperty(Object.getPrototypeOf(window.crypto), 'subtle', { get: function () { return subtle; }, configurable: true }); } catch (e4) {}
        if (!window.crypto.subtle) try { Object.defineProperty(window.crypto, 'subtle', { value: subtle, configurable: true }); } catch (e) {}
        if (!window.crypto.subtle) {
            // the native Crypto object refuses new properties: replace it with a wrapper
            var nativeCrypto = window.crypto, nativeFill = nativeCrypto.getRandomValues;
            var cryptoWrapper = { subtle: subtle };
            // (random values from the engine's generator or none at all - never Math.random, see shims.js)
            if (typeof nativeFill === 'function') {
                cryptoWrapper.getRandomValues = function (arr) { nativeFill.call(nativeCrypto, arr); return arr; };
                cryptoWrapper.randomUUID = nativeCrypto.randomUUID ? function () { return nativeCrypto.randomUUID(); } : function () {
                    var b = new Uint8Array(16), s = '', i;
                    nativeFill.call(nativeCrypto, b);
                    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
                    for (i = 0; i < 16; i++) { s += (b[i] + 256).toString(16).slice(1); if (i === 3 || i === 5 || i === 7 || i === 9) s += '-'; }
                    return s;
                };
            }
            try { Object.defineProperty(window, 'crypto', { value: cryptoWrapper, configurable: true, writable: true }); } catch (e2) { try { window.crypto = cryptoWrapper; } catch (e3) {} }
        }
        window.SubtleCrypto = function SubtleCrypto() {};
        window.CryptoKey = function CryptoKey() {};
        window.Crypto = window.Crypto || function Crypto() {};
    }

    // ---- Credentials, authentication, payments
    if (!navigator.credentials) {
        var credUnsupported = rejectWith('NotSupportedError', 'Credential management is not available');
        // (no stored password: null, as a browser that has none answers - Facebook's login page logged the rejection as
        // an error; public keys and one-time codes stay unsupported)
        navigator.credentials = {
            get: function (opts) { return opts && (opts.publicKey || opts.otp || opts.identity) ? credUnsupported() : resolved(null); },
            create: function (opts) { return opts && opts.password && window.PasswordCredential ? resolved(new window.PasswordCredential(opts.password)) : credUnsupported(); },
            store: function () { return resolved(undefined); },
            preventSilentAccess: function () { return resolved(); }
        };
        window.Credential = function Credential() {};
        window.PasswordCredential = function PasswordCredential(init) { init = init || {}; this.type = 'password'; this.id = init.id || ''; this.password = init.password || ''; this.name = init.name || ''; this.iconURL = init.iconURL || ''; };
        window.FederatedCredential = function FederatedCredential(init) { init = init || {}; this.type = 'federated'; this.id = init.id || ''; this.provider = init.provider || ''; this.name = init.name || ''; };
        window.CredentialsContainer = function CredentialsContainer() {};
    }
    if (!window.PublicKeyCredential) {
        window.PublicKeyCredential = function PublicKeyCredential() {};
        window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function () { return resolved(false); };
        window.PublicKeyCredential.isConditionalMediationAvailable = function () { return resolved(false); };
        window.AuthenticatorResponse = function AuthenticatorResponse() {};
    }
    if (!window.PaymentRequest) {
        window.PaymentRequest = function PaymentRequest(methods, details) {
            this.id = (details && details.id) || 'pr-' + Math.random().toString(36).slice(2);
            this.shippingAddress = null; this.shippingOption = null; this.shippingType = null;
            this.onshippingaddresschange = this.onshippingoptionchange = this.onpaymentmethodchange = null;
        };
        window.PaymentRequest.prototype = {
            canMakePayment: function () { return resolved(false); },
            hasEnrolledInstrument: function () { return resolved(false); },
            show: rejectWith('NotSupportedError', 'Web Payments are not available in this browser'),
            abort: function () { return resolved(); },
            addEventListener: noop, removeEventListener: noop, dispatchEvent: function () { return true; }
        };
        window.PaymentResponse = function PaymentResponse() {};
        window.PaymentAddress = function PaymentAddress() {};
    }

    // ---- Media: Web Audio alias, DRM, tracks, subtitles
    if (!window.AudioContext && window.webkitAudioContext) {
        window.AudioContext = window.webkitAudioContext;
        if (!window.OfflineAudioContext && window.webkitOfflineAudioContext) window.OfflineAudioContext = window.webkitOfflineAudioContext;
    }
    if (window.AudioContext && !window.AudioContext.prototype.createGain && window.AudioContext.prototype.createGainNode) {
        var ACp = window.AudioContext.prototype;
        ACp.createGain = ACp.createGainNode;
        ACp.createDelay = ACp.createDelayNode;
        ACp.createScriptProcessor = ACp.createJavaScriptNode;
    }
    if (window.AudioContext && window.AudioContext.prototype && !window.AudioContext.prototype.resume) {
        window.AudioContext.prototype.resume = function () { return resolved(); };
        window.AudioContext.prototype.suspend = function () { return resolved(); };
        window.AudioContext.prototype.close = function () { return resolved(); };
    }
    if (!navigator.requestMediaKeySystemAccess) navigator.requestMediaKeySystemAccess = rejectWith('NotSupportedError', 'Encrypted media is not available');
    if (!window.MediaKeys) { window.MediaKeys = function MediaKeys() {}; window.MediaKeySystemAccess = function MediaKeySystemAccess() {}; }
    var MEp = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    if (MEp) {
        var trackList = function trackList() { return { length: 0, getTrackById: function () { return null; }, addEventListener: noop, removeEventListener: noop, onchange: null, onaddtrack: null, onremovetrack: null }; };
        if (!('audioTracks' in MEp)) try { Object.defineProperty(MEp, 'audioTracks', { get: function () { return this.__brAudioTracks || (this.__brAudioTracks = trackList()); }, configurable: true }); } catch (e) {}
        if (!('videoTracks' in MEp)) try { Object.defineProperty(MEp, 'videoTracks', { get: function () { return this.__brVideoTracks || (this.__brVideoTracks = trackList()); }, configurable: true }); } catch (e2) {}
        if (!MEp.setSinkId) MEp.setSinkId = rejectWith('NotSupportedError', 'Audio output selection is not available');
        if (!MEp.captureStream) MEp.captureStream = MEp.mozCaptureStream = function () { return new window.MediaStream(); };
        if (!('playsInline' in MEp)) defineBoolAttrProp(MEp, 'playsInline');
        if (!MEp.setMediaKeys) MEp.setMediaKeys = rejectWith('NotSupportedError', 'Encrypted media is not available');
        // play() returns a promise in modern browsers; many players rely on that. It rejects with NotAllowedError when
        // the browser does not let the media start (iOS plays only from a tap): the engine then leaves it paused, and
        // players show their play button again (YouTube's autoplay waited for playback forever, a black box without
        // a button, when the promise said it had started).
        // Autoplay: the app lets media start without a tap (mediaPlaybackRequiresUserAction off) so that muted videos play
        // by themselves, as in current browsers; media with sound waits for a tap (the activation of current browsers,
        // 5 s here): its play() is refused with NotAllowedError, and one that starts anyway (autoplay set by a script,
        // the rewriter takes it off the tags) is paused. The muted attribute is made the muted state first.
        var lastTap = 0;
        var tapped = function () { lastTap = Date.now(); };
        document.addEventListener('touchend', tapped, true);
        document.addEventListener('click', tapped, true);
        document.addEventListener('keydown', tapped, true);
        var mutedByAttr = function (m) { if (!m.__brMuted && m.hasAttribute && m.hasAttribute('muted')) { m.__brMuted = true; m.muted = true; } };
        var soundWithoutTap = function (m) { return !m.muted && m.volume > 0 && Date.now() - lastTap > 5000; };
        document.addEventListener('play', function (e) {
            var m = e.target;
            if (!m || !m.pause) return;
            mutedByAttr(m);
            if (soundWithoutTap(m)) m.pause();
        }, true);
        var origPlay = MEp.play;
        // (whether play() gives a promise, without calling it: play() on a probe element started the engine's media
        // machinery on every page, 177 ms here. Engines whose play() gives one have srcObject too - Safari 11, Chrome 52 -
        // and none of the shims adds it.)
        if (origPlay && !('srcObject' in MEp)) {
            MEp.play = function () {
                mutedByAttr(this);
                if (soundWithoutTap(this)) return P ? P.reject(domException('NotAllowedError', "play() failed because the user didn't interact with the document first.")) : undefined;
                this.__brWantPlay = true;   // (kept for a switch to the media proxy, below)
                var r;
                try { r = origPlay.apply(this, arguments); } catch (e) { return P ? P.reject(e) : undefined; }
                if (r && r.then) return r;
                if (this.paused && P) return P.reject(domException('NotAllowedError', 'play() can only be started by a tap'));
                return resolved();
            };
        }
        // Media the system's player cannot load (it has a network stack of its own, without the current TLS ciphers many
        // servers insist on: developer.mozilla.org's videos gave error 4): the same file through the app's local proxy
        // (BRMediaProxy), once per element, playing on if it was asked to play.
        var viaProxy = function (media, src) {
            if (media.__brProxied || !/^https?:/i.test(src || '') || /^http:\/\/127\.0\.0\.1:\d+\//.test(src)) return;
            media.__brProxied = true;
            var url = null;
            try {
                var x = new XMLHttpRequest();
                x.open('GET', 'https://ios6-browser.invalid/mediaproxy?u=' + encodeURIComponent(src), false);
                x.send(null);
                if (x.status === 200) url = JSON.parse(x.responseText).url;
            } catch (e) { url = null; }
            if (!url) return;
            var play = media.__brWantPlay || media.autoplay;
            media.src = url;   // (a src attribute wins over the <source> children)
            try { media.load(); } catch (e2) {}
            if (play) try { var pr = media.play(); if (pr && pr.then) pr.then(null, noop); } catch (e3) {}
        };
        document.addEventListener('error', function (e) {
            var t = e.target, name = t && t.tagName;
            if (name === 'SOURCE') {
                var m = t.parentNode;
                if (m && (m.tagName === 'VIDEO' || m.tagName === 'AUDIO')) viaProxy(m, t.src);
            } else if ((name === 'VIDEO' || name === 'AUDIO') && t.error && (t.error.code === 2 || t.error.code === 4)) {
                viaProxy(t, t.currentSrc || t.src);
            }
        }, true);
    }
    if (!window.HTMLTrackElement) window.HTMLTrackElement = function HTMLTrackElement() {};
    if (!window.TextTrack) { window.TextTrack = function TextTrack() {}; window.TextTrackCue = window.VTTCue = function VTTCue(start, end, text) { this.startTime = start; this.endTime = end; this.text = text; }; }
    if (!window.MediaSession && !navigator.mediaSession) navigator.mediaSession = { metadata: null, playbackState: 'none', setActionHandler: noop, setPositionState: noop };
    if (!window.MediaMetadata) window.MediaMetadata = function MediaMetadata(init) { init = init || {}; this.title = init.title || ''; this.artist = init.artist || ''; this.album = init.album || ''; this.artwork = init.artwork || []; };
    if (!window.Audio) window.Audio = function Audio(src) { var a = document.createElement('audio'); if (src) a.src = src; return a; };

    // ---- Canvas helpers
    var C2D = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
    if (C2D) {
        if (!C2D.ellipse) C2D.ellipse = function (x, y, rx, ry, rotation, start, end, ccw) {
            this.save();
            this.translate(x, y);
            this.rotate(rotation || 0);
            this.scale(rx, ry);
            this.arc(0, 0, 1, start, end, !!ccw);
            this.restore();
        };
        if (!C2D.setLineDash) {
            if ('webkitLineDash' in C2D) {
                C2D.setLineDash = function (segments) { this.webkitLineDash = segments; };
                C2D.getLineDash = function () { return this.webkitLineDash || []; };
                try { Object.defineProperty(C2D, 'lineDashOffset', { get: function () { return this.webkitLineDashOffset; }, set: function (v) { this.webkitLineDashOffset = v; }, configurable: true }); } catch (e) {}
            } else {
                C2D.setLineDash = noop;
                C2D.getLineDash = function () { return []; };
            }
        }
        if (!C2D.drawFocusIfNeeded) C2D.drawFocusIfNeeded = noop;
        if (!C2D.isPointInStroke) C2D.isPointInStroke = function () { return false; };
        if (!C2D.addHitRegion) { C2D.addHitRegion = noop; C2D.removeHitRegion = noop; C2D.clearHitRegions = noop; }
        if (!C2D.resetTransform) C2D.resetTransform = function () { this.setTransform(1, 0, 0, 1, 0, 0); };
        if (!('imageSmoothingEnabled' in C2D) && ('webkitImageSmoothingEnabled' in C2D)) {
            try { Object.defineProperty(C2D, 'imageSmoothingEnabled', { get: function () { return this.webkitImageSmoothingEnabled; }, set: function (v) { this.webkitImageSmoothingEnabled = v; }, configurable: true }); } catch (e) {}
        }
        if (!('filter' in C2D)) try { Object.defineProperty(C2D, 'filter', { get: function () { return this.__brFilter || 'none'; }, set: function (v) { this.__brFilter = v; }, configurable: true }); } catch (e2) {}
        if (!window.Path2D) {
            var Path2D = function Path2D(init) {
                this.__ops = [];
                if (init instanceof Path2D) this.__ops = init.__ops.slice();
            };
            var pathMethods = ['moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'closePath'];
            for (var pm = 0; pm < pathMethods.length; pm++) (function (m) { Path2D.prototype[m] = function () { this.__ops.push([m, Array.prototype.slice.call(arguments)]); }; })(pathMethods[pm]);
            Path2D.prototype.addPath = function (p) { if (p && p.__ops) this.__ops = this.__ops.concat(p.__ops); };
            Path2D.prototype.__replay = function (ctx) { ctx.beginPath(); for (var i = 0; i < this.__ops.length; i++) ctx[this.__ops[i][0]].apply(ctx, this.__ops[i][1]); };
            var wrapPathOp = function (name) {
                var orig = C2D[name];
                if (!orig) return;
                C2D[name] = function (a, b, c, d) {
                    if (a instanceof Path2D) { a.__replay(this); return name === 'isPointInPath' ? orig.call(this, b, c, d) : orig.call(this, b); }
                    return orig.apply(this, arguments);
                };
            };
            wrapPathOp('fill'); wrapPathOp('stroke'); wrapPathOp('clip'); wrapPathOp('isPointInPath');
            window.Path2D = Path2D;
        }
    }
    var HCp = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
    if (HCp && !HCp.toBlob) HCp.toBlob = function (callback, type, quality) {
        var canvas = this;
        setTimeout(function () {
            var dataURL = canvas.toDataURL(type, quality);
            var parts = dataURL.split(','), mime = /data:([^;]+)/.exec(parts[0]), bin = atob(parts[1]), arr = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            callback(new Blob([arr], { type: mime ? mime[1] : 'image/png' }));
        }, 0);
    };
    if (HCp && !HCp.captureStream) HCp.captureStream = function () { return new window.MediaStream(); };
    if (HCp && !HCp.transferControlToOffscreen) HCp.transferControlToOffscreen = function () { return this; };
    if (!window.OffscreenCanvas) {
        window.OffscreenCanvas = function OffscreenCanvas(width, height) {
            var c = document.createElement('canvas');
            c.width = width; c.height = height;
            c.convertToBlob = function (opts) { return new P(function (res) { c.toBlob(res, opts && opts.type, opts && opts.quality); }); };
            c.transferToImageBitmap = function () { return c; };
            return c;
        };
    }
    // aspect-ratio: cssfix stores the ratio in "counter-reset: br-aspect W br-aspect-h H"; media elements and
    // empty boxes with such a rule get their height from their width (and again when the viewport changes)
    var aspectTimer = null, aspectElements = [], containerElements = [], markerHooks = [];
    var onMarkers = function (fn) { markerHooks.push(fn); };   // fn(list of {el, cr}) after every marker scan
    // A picture or video with height: 100% inside a box whose own height is a percentage (a thumbnail filling an
    // absolutely positioned box in a padding-top ratio box: YouTube) gets 0 px from the old engine, which does not
    // resolve such a chain: the box gets its height in pixels (what it has anyway), the percentage then resolves.
    var PCT_TAGS = { IMG: 1, VIDEO: 1, CANVAS: 1, IFRAME: 1, PICTURE: 1, EMBED: 1, OBJECT: 1 };
    var pctFixed = [];
    // (debugging: the trials of the marker scan that write and read back, each a layout of the page)
    var scanStats = { pct: 0, svgTry: 0, svgPct: 0, aspect: 0, pctMs: 0, svgMs: 0 };
    var fixPercentHeight = function (el) {
        var p = el.parentNode;
        if (!p || p.nodeType !== 1 || p.__brPctFix || el.offsetHeight > 2 || el.offsetWidth < 20) return;
        // (a try that did not help is not repeated for the same box width: every try changes the style attribute
        // twice, and the page's and our own observers took that for new content, so blesk.cz's lazy pictures kept
        // the page busy for good)
        if (el.__brPctTried === p.offsetWidth) return;
        var ph = p.clientHeight;
        if (ph < 20 || p.style.height) return;
        var cs = getComputedStyle(p), inner = ph - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
        if (inner < 20) return;
        el.__brPctTried = p.offsetWidth;
        scanStats.pct++;
        p.style.height = (cs.boxSizing === 'border-box' ? p.offsetHeight : inner) + 'px';
        if (el.offsetHeight > 2) { p.__brPctFix = p.offsetWidth; pctFixed.push(p); }
        else p.style.height = '';   // (not that: left as it was)
    };
    // A video with height: 100% (or auto) in a box without a height of its own: current browsers give it the height of
    // its proportions (the video's, or the poster's before the metadata), the old engine its default 150 px
    // (edition.cnn.com's players were 992 x 150 strips with a small poster in the middle). It gets that height in pixels
    // (again when its width changes); a height the page gives in pixels stays.
    var fixVideoHeight = function (el) {
        if (el.tagName !== 'VIDEO') return;
        var w = el.offsetWidth;
        if (el.__brVidRatio) {
            var want = Math.round(w / el.__brVidRatio);
            if (w > 0 && el.style.height === el.__brVidSet && Math.abs(el.offsetHeight - want) > 1) { el.style.height = want + 'px'; el.__brVidSet = el.style.height; }
            return;
        }
        if (w < 40 || w === 300 || el.offsetHeight !== 150 || el.style.height || el.__brVidWait) return;
        var rules = window.getMatchedCSSRules ? window.getMatchedCSSRules(el) : null;
        for (var i = 0; rules && i < rules.length; i++) if (/px$/.test(rules[i].style.getPropertyValue('height') || '')) return;
        // (final: the video's own proportions replace a poster's or the default ones)
        var apply = function (rw, rh, final) {
            if (!(rw > 0 && rh > 0) || (el.__brVidFinal && !final) || (el.style.height && el.style.height !== el.__brVidSet)) return;
            el.__brVidRatio = rw / rh;
            el.__brVidFinal = !!final;
            el.style.height = Math.round(el.offsetWidth / el.__brVidRatio) + 'px';
            el.__brVidSet = el.style.height;
        };
        if (el.videoWidth && el.videoHeight) { apply(el.videoWidth, el.videoHeight, true); return; }
        el.__brVidWait = true;
        el.addEventListener('loadedmetadata', function () { apply(el.videoWidth, el.videoHeight, true); }, false);
        if (el.poster) {
            var im = new Image();
            im.onload = function () { apply(im.naturalWidth || im.width, im.naturalHeight || im.height, false); };
            im.src = el.poster;
        } else apply(2, 1, false);   // (the default 300 x 150 proportions, as current browsers use them)
    };
    // A loaded picture with height and no width (height: 100% and width: auto in a 2009 box: YouTube's round channel
    // pictures were 1 px wide) gets the width its own proportions give.
    var fixThinPicture = function (el) {
        if (el.tagName !== 'IMG' || el.__brThin) return;
        var w = el.offsetWidth, h = el.offsetHeight, nw = el.naturalWidth, nh = el.naturalHeight;
        if (w > 2 || h < 10 || !nw || !nh) return;
        // (the placeholder of object-fit-images has the picture's proportions too)
        el.style.width = Math.round(h * nw / nh) + 'px';
        el.__brThin = true;
    };
    // Outermost <svg> sizes. The old engine lays out a width or a height the element was not given as 100% (the SVG 1.1
    // default of the attributes), where current browsers take it from the other one and the viewBox proportions: a logo
    // with only a height (Tailwind's h-8) lay in the middle of a row as wide as the page, or was nothing where the box
    // shrinks to its content; a drawing with only a width was 2000 px high, and in a stretched item of a flex row (a
    // 2009 box) that height grew with every layout (The Guardian's logo: 124 000 px and counting). Rules from other
    // hosts are hidden from the page, so what the element was given is found by trying: in a table that shrinks to its
    // content, a width or a height it was not given comes out as nothing (a percentage does not). Tried once per size,
    // with the other children of the box out of the way (a text beside the drawing leaves the width unknown).
    var SVG_NS = 'http://www.w3.org/2000/svg';
    var restoreStyle = function (node, prop, value, prio) { if (value) node.style.setProperty(prop, value, prio); else node.style.removeProperty(prop); };
    // (the size the drawing is laid out at, not its bounding rectangle, which a rotation turns: sport.cz's chevrons are
    // turned by 90 degrees, their growing height was taken for a width and set as one, 27 000 px)
    var svgBox = function (el) {
        var cs = getComputedStyle(el), w = parseFloat(cs.width), h = parseFloat(cs.height);
        if (isNaN(w) || isNaN(h)) { var r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; }
        return { width: w, height: h };
    };
    // The trials (what a drawing was given) go together: the scan plans them, then every box takes its trial form, the
    // drawings are measured, and the boxes are put back, one layout of the page for all of them (one each took 140 ms
    // on seznam.cz, 51 drawings: 7 s, and as long again for the scan reading styles after each). Boxes inside one
    // another, or the same box, wait for the next round (a trial hides the other children of its box).
    var SVG_PROBE = [['display', 'table'], ['width', 'auto'], ['min-width', '0'], ['max-width', 'none']];
    var svgQueue = null;   // ({tries, fixes} while the scan runs)
    var svgPlanTry = function (el, p) {
        var others = [], textBeside = false, n;
        for (n = p.firstChild; n; n = n.nextSibling) {
            if (n === el) continue;
            if (n.nodeType === 3) { if (/\S/.test(n.nodeValue)) textBeside = true; }
            else if (n.nodeType === 1) { if (others.length >= 8) return null; others.push(n); }
        }
        return { el: el, p: p, others: others, textBeside: textBeside };
    };
    var svgTrySet = function (t) {
        var p = t.p, i;
        t.hadStyle = p.hasAttribute('style');
        t.old = [];
        for (i = 0; i < SVG_PROBE.length; i++) {
            t.old.push(p.style.getPropertyValue(SVG_PROBE[i][0]), p.style.getPropertyPriority(SVG_PROBE[i][0]));
            p.style.setProperty(SVG_PROBE[i][0], SVG_PROBE[i][1], 'important');
        }
        t.oldOthers = [];
        for (i = 0; i < t.others.length; i++) {
            var o = t.others[i];
            t.oldOthers.push(o.style.getPropertyValue('display'), o.style.getPropertyPriority('display'), o.hasAttribute('style'));
            o.style.setProperty('display', 'none', 'important');
        }
    };
    var svgTryUnset = function (t) {
        var p = t.p, i;
        for (i = 0; i < t.others.length; i++) {
            var o = t.others[i];
            restoreStyle(o, 'display', t.oldOthers[3 * i], t.oldOthers[3 * i + 1]);
            if (!t.oldOthers[3 * i + 2] && !o.style.length) o.removeAttribute('style');
        }
        for (i = 0; i < SVG_PROBE.length; i++) restoreStyle(p, SVG_PROBE[i][0], t.old[2 * i], t.old[2 * i + 1]);
        if (!t.hadStyle && !p.style.length) p.removeAttribute('style');
    };
    var svgFix = function (el, prop, v, p) {
        if (svgQueue) { svgQueue.fixes.push({ el: el, prop: prop, v: v, p: p }); return; }
        svgApplyFixes([{ el: el, prop: prop, v: v, p: p }]);
    };
    var svgRunTries = function (tries) {
        var rest = tries, i, j;
        while (rest.length) {
            var round = [], later = [];
            for (i = 0; i < rest.length; i++) {
                var t = rest[i], clash = false;
                for (j = 0; j < round.length && !clash; j++) { var q = round[j].p; if (q === t.p || q.contains(t.p) || t.p.contains(q)) clash = true; }
                (clash ? later : round).push(t);
            }
            scanStats.svgTry += round.length;
            for (i = 0; i < round.length; i++) svgTrySet(round[i]);
            for (i = 0; i < round.length; i++) round[i].box = svgBox(round[i].el);
            for (i = 0; i < round.length; i++) svgTryUnset(round[i]);
            for (i = 0; i < round.length; i++) {
                var s = round[i], gw = s.textBeside ? true : s.box.width > 1, gh = s.box.height >= 0.5;
                if (!s.hOwn && !gh && s.r.width >= 2) svgFix(s.el, 'height', s.r.width / s.ratio, s.p);
                else if (!s.wOwn && !gw && (s.hOwn || gh) && s.r.height >= 1) svgFix(s.el, 'width', s.r.height * s.ratio, s.p);
            }
            rest = later;
        }
    };
    // (the sizes set, then the 2009 boxes around them laid out afresh, together: a box keeps the old heights of its items)
    var svgApplyFixes = function (fixes) {
        var boxes = [], i, a;
        for (i = 0; i < fixes.length; i++) {
            fixes[i].el.style.setProperty(fixes[i].prop, Math.round(fixes[i].v * 100) / 100 + 'px', 'important');
            fixes[i].el.__brSvgFixed = true;
        }
        for (i = 0; i < fixes.length; i++) {
            for (a = fixes[i].p; a && a.nodeType === 1; a = a.parentNode) {
                var d = getComputedStyle(a).display;
                if (d === '-webkit-box' || d === '-webkit-inline-box') { if (boxes.indexOf(a) < 0) boxes.push(a); break; }
            }
        }
        relayoutAll(boxes);
    };
    // Is the box around a drawing with a percentage height as high as its content? Then current browsers take the
    // percentage for auto, the old engine a share of the screen (or of a box that grows with it): the box shrinks by
    // (most of) the drawing's height when the drawing is made 0 px high for a moment.
    var pctOfContent = function (el, p, h) {
        scanStats.svgPct++;
        var had = el.hasAttribute('style'), before = p.offsetHeight;
        el.style.setProperty('height', '0px', 'important');
        var after = p.offsetHeight;
        el.style.removeProperty('height');
        if (!had && !el.style.length) el.removeAttribute('style');
        return before - after > h / 2;
    };
    var fixSvgSize = function (el) {
        if (el.__brSvgFixed) return;
        var wOwn = el.getAttribute('width') !== null || !!el.style.width, hOwn = el.getAttribute('height') !== null || !!el.style.height;
        // (height="100%" in a box of no definite height is the viewBox proportions in current browsers, and so is a
        // height: auto of the page's rules over it: react.dev's logo, width 112 px, was 42 000 px high here)
        var hPct = /%\s*$/.test(el.getAttribute('height') || '') && !el.style.height;
        if (wOwn && hOwn && !hPct) return;
        var p = el.parentNode;
        if (!p || p.nodeType !== 1 || p.namespaceURI === SVG_NS || p === document.body || p === document.documentElement) return;
        var vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/), vw = parseFloat(vb[2]), vh = parseFloat(vb[3]);
        if (!(vw > 0 && vh > 0)) return;
        var r = svgBox(el), ratio = vw / vh;
        if ((r.width < 1 && r.height < 1) || Math.abs(r.width - r.height * ratio) <= 1) return;
        var seen = Math.round(r.width) + 'x' + Math.round(r.height), setH = 0, setW = 0;
        if (el.__brSvgSeen === seen) return;
        el.__brSvgSeen = seen;
        var pctFree = hPct && el.getAttribute('preserveAspectRatio') !== 'none';
        if ((!hOwn || pctFree) && r.width >= 1 && r.height > Math.max(2000, r.width / ratio * 10)) setH = r.width / ratio;   // (absurd: never meant)
        // (tried only on drawings far taller than their proportions: the trial lays the page out, seznam.cz has hundreds)
        else if (pctFree && r.width >= 2 && r.height > Math.max(60, r.width / ratio * 1.5) && pctOfContent(el, p, r.height)) setH = r.width / ratio;
        else {
            if (wOwn && hOwn) return;
            var pos = getComputedStyle(el).position;
            if (pos === 'absolute' || pos === 'fixed') return;
            var t = svgPlanTry(el, p);
            if (!t) return;
            t.r = r; t.ratio = ratio; t.wOwn = wOwn; t.hOwn = hOwn;
            if (svgQueue) svgQueue.tries.push(t); else svgRunTries([t]);
            return;
        }
        svgFix(el, 'height', setH, p);
    };
    // display: contents, which the rewriter turns into the parent's kind of box that spreads its children as the parent
    // does (marked br-contents, see cssfix.js): in a row that spreads its items (justify-content: space-between and the
    // like) the box takes the room left over, so that its children are spread over it with the others. (apple.com's menu
    // sits three levels of display: contents deep in a spread row: its entries were squeezed into 480 px of 950.)
    // The outermost such box gets the width its children and the gaps between them take, the gap being the one all the
    // items of the row get when they are spread as one list (space-between); the boxes inside it fill it.
    var isContents = function (el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.__brContents) return true;
        var cr = getComputedStyle(el).counterReset || '';
        return cr.indexOf('br-contents') >= 0 || (cr.indexOf('br-dinherit') >= 0 && isContents(el.parentNode));
    };
    var rowLeaves = function (box, out) {
        for (var c = box.firstChild; c; c = c.nextSibling) {
            if (c.nodeType !== 1) continue;
            var cs = getComputedStyle(c);
            if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
            if (isContents(c)) rowLeaves(c, out);
            else out.push((c.offsetWidth || c.getBoundingClientRect().width) + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0));
        }
        return out;
    };
    var setBoxFlex = function (el, want) {
        if ((el.style.getPropertyValue('-webkit-box-flex') || '') === want) return;
        if (want) el.style.setProperty('-webkit-box-flex', want); else el.style.removeProperty('-webkit-box-flex');
    };
    var fixContents = function (el) {
        var p = el.parentNode;
        if (!p || p.nodeType !== 1) return;
        var pcs = getComputedStyle(p);
        var spread = /^-webkit-(inline-)?box$/.test(pcs.display) && pcs.webkitBoxOrient !== 'vertical' && pcs.webkitBoxOrient !== 'block-axis' && pcs.webkitBoxPack === 'justify';
        if (!spread) { setBoxFlex(el, ''); if (el.__brContentsW) { el.style.width = ''; el.__brContentsW = false; } return; }
        if (isContents(p)) { setBoxFlex(el, '1'); return; }   // (inside the outermost one: fills it)
        var all = rowLeaves(p, []), own = rowLeaves(el, []), sumAll = 0, sumOwn = 0, i;
        for (i = 0; i < all.length; i++) sumAll += all[i];
        for (i = 0; i < own.length; i++) sumOwn += own[i];
        var room = p.clientWidth - (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0);
        var gap = all.length > 1 ? Math.max(0, (room - sumAll) / (all.length - 1)) : 0;
        setBoxFlex(el, '');
        el.style.width = Math.floor(sumOwn + Math.max(0, own.length - 1) * gap) + 'px';
        el.__brContentsW = true;
    };
    // (a box that changed its width since, a rotation: measured again)
    var recheckPercentHeights = function () {
        var keep = [];
        for (var i = 0; i < pctFixed.length; i++) {
            var p = pctFixed[i];
            if (p.parentNode && Math.abs(p.offsetWidth - p.__brPctFix) <= 1) { keep.push(p); continue; }
            p.style.height = '';
            p.__brPctFix = null;
        }
        pctFixed = keep;
    };
    // a box without content in the flow: no text of its own, every child positioned absolutely or not displayed (a
    // video tile whose picture, caption and links all sit on top of it: csfd.cz's were 0 px high, their captions
    // over the page's menu)
    var flowEmpty = function (el) {
        for (var n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) { if (/\S/.test(n.nodeValue)) return false; continue; }
            if (n.nodeType !== 1) continue;
            var ccs = getComputedStyle(n);
            if (ccs.display !== 'none' && ccs.position !== 'absolute' && ccs.position !== 'fixed') return false;
        }
        return true;
    };
    // The elements the marker scan reads the style of. Once the page's manifest is known: those the rules with markers
    // match (their selectors come as manifest "mk"), style attributes with markers, pictures and media (the
    // percentage-height fixes) and the boxes that got a height last time; before that (null) every element. Reading
    // the style of every element took about a second per scan on big pages.
    var mkPlan = null, mkKey = null, mkStamp = 0;
    var splitSelectorList = function (s) {
        var out = [], depth = 0, start = 0, q = null;
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
            if (c === '"' || c === "'") q = c;
            else if (c === '(' || c === '[') depth++;
            else if (c === ')' || c === ']') depth--;
            else if (c === ',' && !depth) { out.push(s.slice(start, i)); start = i + 1; }
        }
        out.push(s.slice(start));
        return out;
    };
    var markerCandidates = function () {
        var rules = window.__brMarkerRules;
        if (!rules) return null;
        if (mkKey !== rules.key) {
            var sels = [], seen = {}, i, k;
            for (i = 0; i < rules.list.length; i++) {
                var parts = splitSelectorList(rules.list[i]);
                for (k = 0; k < parts.length; k++) {
                    var sel = parts[k].replace(/^\s+|\s+$/g, '');
                    // (pseudo-elements cannot be queried, nor used by the shims)
                    if (!sel || seen[sel] || /::|:(before|after|first-line|first-letter)\b/i.test(sel)) continue;
                    seen[sel] = 1;
                    sels.push(sel);
                }
            }
            var plan = [];
            for (i = 0; i < sels.length; i += 50) {
                var chunk = sels.slice(i, i + 50), joined = chunk.join(',');
                try { document.querySelector(joined); plan.push(joined); }
                catch (e) { for (k = 0; k < chunk.length; k++) { try { document.querySelector(chunk[k]); plan.push(chunk[k]); } catch (e2) {} } }
            }
            plan.push('[style*="counter-reset"]', 'img,video,canvas,iframe,embed,object,picture', 'svg');
            mkPlan = plan;
            mkKey = rules.key;
        }
        var out = [], stamp = ++mkStamp, p, q, list;
        for (p = 0; p < mkPlan.length; p++) {
            try { list = document.querySelectorAll(mkPlan[p]); } catch (e3) { continue; }
            for (q = 0; q < list.length; q++) if (list[q].__brMkStamp !== stamp) { list[q].__brMkStamp = stamp; out.push(list[q]); }
        }
        for (q = 0; q < aspectElements.length; q++) if (aspectElements[q].__brMkStamp !== stamp) { aspectElements[q].__brMkStamp = stamp; out.push(aspectElements[q]); }
        return out;
    };
    var applyAspectRatios = function () {
        var t0 = Date.now(), tm = [], media = 0;
        try {
            recheckPercentHeights();
            var all = markerCandidates() || document.getElementsByTagName('*'), found = [], containers = [], marked = [];
            tm.push(Date.now());
            svgQueue = { tries: [], fixes: [] };   // (the drawings' trials and fixes, together after the loop)
            for (var i = 0; i < all.length && i < 4000; i++) {
                var el = all[i];
                if (PCT_TAGS[el.tagName]) { var tq = Date.now(); fixPercentHeight(el); fixThinPicture(el); fixVideoHeight(el); media += Date.now() - tq; scanStats.pctMs += Date.now() - tq; }
                else if (el.tagName === 'svg') { var tv = Date.now(); fixSvgSize(el); media += Date.now() - tv; scanStats.svgMs += Date.now() - tv; }
                var cr = getComputedStyle(el).counterReset || '';
                if (cr.indexOf('br-') < 0) { if (el.__brAspect) { el.style.height = ''; el.__brAspect = false; } continue; }
                marked.push({ el: el, cr: cr });
                if (cr.indexOf('br-contents') >= 0) { el.__brContents = true; fixContents(el); }
                else if (cr.indexOf('br-dinherit') >= 0 && el.parentNode && el.parentNode.__brContents) {
                    // display: inherit under a display: contents element is display: contents too (apple.com's menu)
                    if (!el.__brContents) {
                        var dk = ['-webkit-box-orient', '-webkit-box-direction', '-webkit-box-align', '-webkit-box-pack'];
                        for (var dki = 0; dki < dk.length; dki++) el.style.setProperty(dk[dki], 'inherit');
                        el.__brContents = true;
                    }
                    fixContents(el);
                }
                if (cr.indexOf('br-c') >= 0) {   // container-type / container-name markers (see the manifest block)
                    var names = [], cn = /br-cn-([\w-]+)/g, cm;
                    while ((cm = cn.exec(cr)) !== null) names.push(cm[1]);
                    if (cr.indexOf('br-container') >= 0 || names.length) containers.push({ el: el, names: names });
                }
                if (cr.indexOf('br-aspect') < 0) { if (el.__brAspect) { el.style.height = ''; el.__brAspect = false; } continue; }
                // the engine serialises the counters in its own order, so the two are read independently
                var mw = /br-aspect\s+(\d+)/.exec(cr), mhh = /br-aspect-h\s+(\d+)/.exec(cr);
                if (!mw || !mhh) continue;
                var m = [null, mw[1], mhh[1]];
                var tag = el.tagName;
                var replaced = tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME' || tag === 'CANVAS' || tag === 'EMBED' || tag === 'OBJECT' || tag === 'SVG';
                if (!replaced && !flowEmpty(el)) {   // boxes with content keep their own height
                    if (el.__brAspect) { el.style.height = ''; el.__brAspect = false; }
                    continue;
                }
                var w = el.offsetWidth;
                if (!w) continue;
                var h = Math.round(w * parseInt(m[2], 10) / parseInt(m[1], 10));
                if (Math.abs(el.offsetHeight - h) > 1) { el.style.height = h + 'px'; el.__brAspect = true; scanStats.aspect++; }
                found.push(el);
            }
            aspectElements = found;
            containerElements = containers;
            var sq = svgQueue, ts = Date.now();
            svgQueue = null;
            svgRunTries(sq.tries);
            svgApplyFixes(sq.fixes);
            media += Date.now() - ts; scanStats.svgMs += Date.now() - ts;
            tm.push(Date.now());
            if (window.__brApplyContainerQueries) window.__brApplyContainerQueries(containers);
            tm.push(Date.now());
            for (var mh = 0; mh < markerHooks.length; mh++) { try { markerHooks[mh](marked); } catch (e2) {} tm.push(Date.now()); }
        } catch (e) {}
        svgQueue = null;
        // (debugging: candidates, the scan (media fixes in it), container queries, each marker hook)
        if (window.__brNoteSlow && tm.length > 2) {
            var parts = [];
            for (var tp = 1; tp < tm.length; tp++) parts.push(tm[tp] - tm[tp - 1]);
            window.__brNoteSlow('marker scan', Date.now() - t0, 'candidates ' + (tm[0] - t0) + ' of ' + (all ? all.length : 0) + ', scan ' + parts[0] + ' (media ' + media + '), marked ' +
                                (marked ? marked.length : 0) + ', containers ' + parts[1] + ', hooks ' + parts.slice(2).join(' ') +
                                ' [pictures ' + scanStats.pctMs + ' ms, ' + scanStats.pct + ' tries; svg ' + scanStats.svgMs + ' ms, ' + scanStats.svgTry + ' size tries, ' + scanStats.svgPct + ' % tries; ' + scanStats.aspect + ' ratios]');
        }
        scanStats.pct = scanStats.svgTry = scanStats.svgPct = scanStats.aspect = scanStats.pctMs = scanStats.svgMs = 0;
    };
    // (the scan reads the style of every element: on a big page that changes all the time it waits five times its cost)
    var aspectCost = 0, aspectEnd = 0;
    var scheduleAspect = function () {
        if (aspectTimer || leanPage()) return;
        aspectTimer = setTimeout(function () {
            aspectTimer = null;
            var t0 = Date.now();
            applyAspectRatios();
            aspectEnd = Date.now();
            aspectCost = aspectEnd - t0;
        }, Math.max(200, aspectEnd + aspectCost * 5 - Date.now()));
    };
    onReady(scheduleAspect);
    onSettled(scheduleAspect);
    window.addEventListener('resize', scheduleAspect, false);
    window.addEventListener('load', scheduleAspect, false);
    // z-index of flex items (cssfix marks rules with a z-index and no position "br-zi 1"): a flex item stacks by its
    // z-index without being positioned; the old engine's boxes (the 2009 model) paint such items in document order
    // (an item drawn over the one the page puts on top). A positioned item stacks by its z-index here, so the item gets
    // position: relative from a rule ahead of the page's styles (any position of the page's own wins over it), unless
    // that would move something: offsets it sets, or absolutely positioned boxes inside it that it would become the
    // containing block of (a flex item is not one). Looked at again when the width changes (other media rules).
    // Flex items are blocks (see BLOCKIFY in cssfix.js): the children of flex containers (found with the selectors of
    // the page's flex rules from the manifest, and by the boxes of style attributes) get data-br-bf: "b" for the kinds
    // of element the engine makes inline (see bfValueOf), made blocks by the rule here, which stands ahead of the page's
    // styles; wherever a rule of the page sets a display its twin decides. A display in the style attribute is changed
    // there. A container that is no longer flex lets go of its children. Line-clamped boxes (display: -webkit-box of the
    // page's own) keep their inline children.
    var bfRule = null, bfBoxes = [], fxPlan = null, fxKey = null;
    var BF_STYLE = { inline: 'block', 'inline-block': 'block', 'inline-table': 'table', '-webkit-inline-box': '-webkit-box' };
    var BF_SKIP = { BR: 1, WBR: 1, SCRIPT: 1, STYLE: 1, TEMPLATE: 1, LINK: 1, META: 1, NOSCRIPT: 1, DATALIST: 1, SOURCE: 1, TRACK: 1, PARAM: 1, AREA: 1, TITLE: 1, BASE: 1, DIALOG: 1 };
    var flexPlan = function () {
        var rules = window.__brFlexRules;
        if (!rules) return null;
        if (fxKey !== rules.key) {
            var build = function (list) {
                var plan = [], i, k;
                for (i = 0; i < list.length; i += 50) {
                    var chunk = list.slice(i, i + 50), joined = chunk.join(',');
                    try { document.querySelector(joined); plan.push(joined); }
                    catch (e) { for (k = 0; k < chunk.length; k++) { try { document.querySelector(chunk[k]); plan.push(chunk[k]); } catch (e2) {} } }
                }
                return plan;
            };
            // (and the boxes of style attributes: flex written there by the rewriter or by scripts, see "Flex set by scripts")
            fxPlan = { box: build(rules.box.concat('[style*="-webkit-box"]')), col: build(rules.col) };
            fxKey = rules.key;
        }
        return fxPlan;
    };
    var isFlexBox = function (box, column) {
        if (!box.parentNode) return false;
        var cs = getComputedStyle(box), d = cs.display;
        if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') return false;
        if (column) return d === 'block' && cs.webkitBoxOrient === 'vertical';
        return d === '-webkit-box' || d === '-webkit-inline-box';
    };
    // (the value comes from the element's kind, not its computed style: every display rule of the page has its twin,
    // so only the engine's own display is left to give, and that follows the tag: inline for spans, links, pictures,
    // form fields and unknown (custom) elements; reading each child's style took 0.9 s on theguardian.com)
    var BF_INLINE = { A: 1, ABBR: 1, ACRONYM: 1, B: 1, BDI: 1, BDO: 1, BIG: 1, CITE: 1, CODE: 1, DATA: 1, DEL: 1, DFN: 1, EM: 1, FONT: 1, I: 1, IMG: 1,
        INS: 1, KBD: 1, LABEL: 1, MARK: 1, METER: 1, OUTPUT: 1, PICTURE: 1, PROGRESS: 1, Q: 1, S: 1, SAMP: 1, SELECT: 1, SMALL: 1, SPAN: 1, STRIKE: 1,
        STRONG: 1, SUB: 1, SUP: 1, TEXTAREA: 1, TIME: 1, TT: 1, U: 1, VAR: 1, BUTTON: 1, INPUT: 1, VIDEO: 1, CANVAS: 1, IFRAME: 1, EMBED: 1,
        OBJECT: 1, svg: 1, SVG: 1, math: 1, MATH: 1, NOBR: 1 };
    var bfValueOf = function (c) {
        var t = c.tagName;
        if (t === 'INPUT' && String(c.type).toLowerCase() === 'hidden') return null;   // (the engine hides these)
        if (t === 'AUDIO') return c.hasAttribute('controls') ? 'b' : null;
        if (BF_INLINE[t] || t.indexOf('-') > 0) return 'b';
        return '';
    };
    // (reads only, and of the DOM only: the children to mark go to `writes`; reading and writing in turn made the
    // engine work out the page's styles again for every child, 30 s on novinky.cz)
    var collectItems = function (box, width, writes) {
        var n = 0;
        for (var c = box.firstElementChild; c; c = c.nextElementSibling) {
            n++;
            if (BF_SKIP[c.tagName] || c.__brBfBox === box) continue;
            if (c.__brContents) { collectItems(c, width, writes); c.__brBfBox = box; continue; }   // (display: contents: its children are the items)
            var v = bfValueOf(c);
            if (v !== null) writes.push(c, v);
            c.__brBfBox = box;
        }
        box.__brFxN = n;
        box.__brFxW = width;
    };
    var writeItems = function (writes) {
        for (var i = 0; i < writes.length; i += 2) {
            var c = writes[i], st = c.style.display;
            if (BF_STYLE[st]) { c.__brBfStyle = st; c.style.display = BF_STYLE[st]; }
            // (one marked already, moved here from another box, keeps its value: its display now is the block-level one)
            if (!c.hasAttribute('data-br-bf')) c.setAttribute('data-br-bf', writes[i + 1]);
        }
    };
    var unmarkItems = function (box) {
        for (var c = box.firstElementChild; c; c = c.nextElementSibling) {
            if (c.__brBfBox !== box) continue;
            if (c.__brContents) unmarkItems(c);
            c.removeAttribute('data-br-bf');
            if (c.__brBfStyle) { c.style.display = c.__brBfStyle; c.__brBfStyle = null; }
            c.__brBfBox = null;
        }
        box.__brFxN = box.__brFxW = box.__brFx = undefined;
    };
    var markStats = { plan: 0, query: 0, check: 0, checks: 0, write: 0, writes: 0 };
    var markFlexItems = function () {
        if (window.__brNoFlexItems) return;   // (debugging switch)
        var tp = Date.now(), plan = flexPlan();
        markStats.plan = Date.now() - tp;
        markStats.query = markStats.check = markStats.checks = 0;
        if (!plan) return;
        if (!bfRule) {
            bfRule = ownStyleElement();
            // (not over the engine's own hiding of elements with the hidden attribute)
            bfRule.textContent = '[data-br-bf=b]:not([hidden]){display:block}';
            var head = document.head || document.documentElement;
            head.insertBefore(bfRule, head.firstChild);
        }
        var width = window.innerWidth, kept = [], gone = [], writes = [], i, k, list, box;
        // (containers marked before: still flex boxes? a width change can change that through media rules)
        for (i = 0; i < bfBoxes.length; i++) {
            box = bfBoxes[i];
            if (box.__brFxW === width && box.parentNode) { kept.push(box); continue; }
            if (isFlexBox(box, box.__brFx === 2)) { collectItems(box, width, writes); kept.push(box); }
            else { gone.push(box); box.__brFx = -1; }
        }
        for (var kind = 1; kind <= 2; kind++) {
            var sels = kind === 1 ? plan.box : plan.col;
            for (k = 0; k < sels.length; k++) {
                var tq = Date.now();
                try { list = document.querySelectorAll(sels[k]); } catch (e) { continue; }
                var tc = Date.now();
                markStats.query += tc - tq;
                for (i = 0; i < list.length; i++) {
                    box = list[i];
                    if (box.__brFx === -1) continue;   // (no longer flex: let go of below)
                    if (box.__brFx) {
                        // (known: only its new children, when it has some)
                        if (box.__brFxN !== box.childElementCount) collectItems(box, box.__brFxW, writes);
                        continue;
                    }
                    markStats.checks++;
                    if (!isFlexBox(box, kind === 2)) continue;
                    box.__brFx = kind;
                    collectItems(box, width, writes);
                    kept.push(box);
                }
                markStats.check += Date.now() - tc;
            }
        }
        // (then the writes, all together)
        var tw = Date.now();
        for (i = 0; i < gone.length; i++) unmarkItems(gone[i]);
        writeItems(writes);
        markStats.write = Date.now() - tw;
        markStats.writes = writes.length / 2;
        bfBoxes = kept;
    };
    // align-self of flex items (cssfix sends the rules that set it, with their specificity and media queries, see
    // alignSelfOf): the old boxes align all their children alike (-webkit-box-align of the box). A box with items
    // aligned otherwise aligns at the start (data-br-asp); in a column the items get auto margins (centre, end) or the
    // full width (the stretched ones, data-br-as); in a row the heights are measured: stretched items get the row's
    // height as their min-height, centred and end ones a margin-top. What was set is taken back before the next time
    // (only when the widths, heights or values changed), so the page's own styles stay what they were.
    var asBoxes = [], asRule = null;
    var AS_CODE = function (v) {
        v = String(v || '').toLowerCase();
        if (v === 'center' || v === 'anchor-center') return 'c';
        if (/^(end|flex-end|self-end|right|last baseline)$/.test(v)) return 'e';
        if (/^(start|flex-start|self-start|left|baseline|first baseline)$/.test(v)) return 's';
        return v === 'stretch' ? 'x' : '';   // ('' auto, normal: the box's own)
    };
    var BOX_CODE = { stretch: 'x', start: 's', center: 'c', end: 'e', baseline: 's' };
    var asMediaOk = function (list, cache) {
        var key = list.join('&');
        if (cache[key] === undefined) {
            cache[key] = true;
            for (var i = 0; i < list.length; i++) { try { if (!window.matchMedia(list[i]).matches) { cache[key] = false; break; } } catch (e) { cache[key] = false; break; } }
        }
        return cache[key];
    };
    var asSet = function (el, prop, value) {
        var saved = el.__brAsSet || (el.__brAsSet = {});
        if (!saved.hasOwnProperty(prop)) saved[prop] = el.style.getPropertyValue(prop);
        el.style.setProperty(prop, value);
    };
    // (what was set, taken back; the old boxes lay out again only the items whose own style changed, the others kept
    // the sizes of the other alignment, so the boxes are then laid out afresh, all at once, see relayoutAll)
    var asUndo = function (box) {
        if (!box.hasAttribute('data-br-asp')) return false;
        box.removeAttribute('data-br-asp');
        for (var c = box.firstElementChild; c; c = c.nextElementSibling) {
            var saved = c.__brAsSet;
            if (!saved) continue;
            c.removeAttribute('data-br-as');
            for (var p in saved) if (saved.hasOwnProperty(p)) { if (saved[p]) c.style.setProperty(p, saved[p]); else c.style.removeProperty(p); }
            if (!c.getAttribute('style')) c.removeAttribute('style');
            c.__brAsSet = null;
        }
        box.__brAsSig = null;
        return true;
    };
    // (relayout of several boxes with one layout of the page: out of it together, one read, back together)
    var relayoutAll = function (boxes) {
        if (!boxes.length) return;
        var prev = [], i, s;
        for (i = 0; i < boxes.length; i++) {
            s = boxes[i].style;
            prev.push(s.getPropertyValue('display'), s.getPropertyPriority('display'));
            s.setProperty('display', 'none', 'important');
        }
        var x = document.body ? document.body.offsetHeight : 0;
        for (i = 0; i < boxes.length; i++) {
            s = boxes[i].style;
            if (prev[2 * i]) s.setProperty('display', prev[2 * i], prev[2 * i + 1]); else s.removeProperty('display');
        }
        return x;
    };
    var num0 = function (v) { return parseFloat(v) || 0; };
    // (the state a box was aligned in: its width and height and every item's height and value)
    var asSignature = function (box, kids) {
        var s = [box.clientWidth, box.clientHeight];
        for (var i = 0; i < kids.length; i++) s.push(kids[i].code, kids[i].el.offsetHeight);
        return s.join(',');
    };
    // (read: the box's own alignment, whether any item differs, the stretched items)
    var asPrepare = function (t) {
        var box = t.box, cs = getComputedStyle(box), P = BOX_CODE[cs.webkitBoxAlign] || 'x', kids = t.kids, i, k, kcs, any = false;
        t.P = P;
        t.vertical = box.__brFx === 2 || cs.webkitBoxOrient === 'vertical' || cs.webkitBoxOrient === 'block-axis';
        // (a column that stays a block stretches every item, whatever its own alignment says)
        var base = box.__brFx === 2 ? 'x' : P;
        for (i = 0; i < kids.length; i++) { kids[i].eff = kids[i].code || P; if (kids[i].eff !== base) any = true; }
        if (!any) return false;
        if (box.__brFx === 2) t.P = 'x';
        t.padA = t.vertical ? num0(cs.paddingLeft) + num0(cs.paddingRight) : num0(cs.paddingTop) + num0(cs.paddingBottom);
        var room = (t.vertical ? box.clientWidth : box.clientHeight) - t.padA;
        for (i = 0; i < kids.length; i++) {
            k = kids[i]; kcs = getComputedStyle(k.el);
            if (t.vertical) {
                k.m = num0(kcs.marginLeft) + num0(kcs.marginRight);
                k.full = Math.abs(k.el.offsetWidth + k.m - room) < 1.5;
            } else {
                k.mt = num0(kcs.marginTop); k.mb = num0(kcs.marginBottom);
                k.full = Math.abs(k.el.offsetHeight + k.mt + k.mb - room) < 1.5;
            }
        }
        // (only when some item would sit elsewhere: an item of a stretching box that is not stretched, a height of its
        // own, already sits at the start; one as big as the box sits the same anywhere. 48 boxes of theguardian.com)
        var P0 = box.__brFx === 2 ? 'x' : P;
        for (i = 0; i < kids.length; i++) {
            k = kids[i];
            if (k.eff === base) continue;
            if (k.eff === 'x') { if (!k.full) return true; continue; }
            if (P0 === 'x') { if (k.eff !== 's' || k.full) return true; continue; }
            if (!k.full) return true;
        }
        return false;
    };
    // (write: the box at the start; a column's items placed by margins or given the full width)
    var asStart = function (t) {
        var box = t.box, kids = t.kids, i, k;
        box.setAttribute('data-br-asp', t.vertical ? (box.__brFx === 2 ? 'b' : 'v') : 'h');
        box.__brAsRow = !t.vertical;
        if (!t.vertical) return;
        // (every item's style changes, so that each is laid out again: at the start, margin-right: auto changes nothing
        // there; a fresh layout of the box instead cost 1.7 s on github.com)
        for (i = 0; i < kids.length; i++) {
            k = kids[i];
            if (k.eff === 'x' && (t.P !== 'x' || k.full)) {
                k.el.setAttribute('data-br-as', 'w');
                asSet(k.el, 'width', k.m ? '-webkit-calc(100% - ' + k.m + 'px)' : '100%');
                continue;
            }
            k.el.setAttribute('data-br-as', k.eff === 'c' || k.eff === 'e' ? k.eff : 's');
            if (!k.el.__brAsSet) k.el.__brAsSet = {};
        }
    };
    // (a row, read: its height and the items' heights at the start)
    var asMeasureRow = function (t) {
        t.H = t.box.clientHeight - t.padA;
        for (var i = 0; i < t.kids.length; i++) t.kids[i].h = t.kids[i].el.offsetHeight;
    };
    // (a row, write: stretched items get its height as min-height, centred and end ones a top margin)
    var asPlaceRow = function (t) {
        var H = t.H, k;
        for (var i = 0; i < t.kids.length; i++) {
            k = t.kids[i];
            if (k.eff === 'x' && (t.P !== 'x' || k.full)) asSet(k.el, 'min-height', Math.max(0, H - k.mt - k.mb) + 'px');
            else if (k.eff === 'c') asSet(k.el, 'margin-top', Math.round((k.mt + (H - k.h - k.mt - k.mb) / 2) * 10) / 10 + 'px');
            else if (k.eff === 'e') asSet(k.el, 'margin-top', Math.max(k.mt, H - k.h - k.mb) + 'px');
        }
    };
    var alignFlexItems = function () {
        if (window.__brNoAlignSelf) return;   // (debugging switch)
        var rules = window.__brAlignSelfRules || [], i, j, k, t;
        if (!rules.length && !asBoxes.length) {
            var anyCol = false;
            for (i = 0; i < bfBoxes.length && !anyCol; i++) if (bfBoxes[i].__brFx === 2) anyCol = true;
            if (!anyCol) return;
        }
        if (!asRule) {
            asRule = ownStyleElement();
            asRule.textContent = '[data-br-asp=v],[data-br-asp=h]{-webkit-box-align:start!important}' +
                '[data-br-asp=b]{display:-webkit-box!important;-webkit-box-orient:vertical!important;-webkit-box-align:start!important}' +
                '[data-br-as=c]{margin-left:auto!important;margin-right:auto!important}[data-br-as=e]{margin-left:auto!important}[data-br-as=s]{margin-right:auto!important}' +
                '[data-br-as=w]{-webkit-box-sizing:border-box}';
            var head = document.head || document.documentElement;
            head.insertBefore(asRule, head.firstChild);
        }
        // the winning align-self of every element some rule gives one (specificity, then the later rule)
        var media = {}, gen = (alignFlexItems.gen = (alignFlexItems.gen || 0) + 1), boxes = [];
        for (i = 0; i < rules.length; i++) {
            var e = rules[i];
            if (e.m && !asMediaOk(e.m, media)) continue;
            for (k = 0; k < e.sl.length; k++) {
                var els;
                try { els = document.querySelectorAll(e.sl[k]); } catch (x) { continue; }
                for (j = 0; j < els.length; j++) {
                    var el = els[j], p = el.parentNode, sp = e.sp[k] || 0;
                    if (!p || !p.__brFx || p.__brFx === -1) continue;   // (items of the flex containers markFlexItems found)
                    if (el.__brAsGen !== gen) { el.__brAsGen = gen; el.__brAsSp = -1; }
                    if (sp >= el.__brAsSp) { el.__brAsSp = sp; el.__brAsCode = AS_CODE(e.as); }
                    if (p.__brAsGen !== gen) { p.__brAsGen = gen; boxes.push(p); }
                }
            }
        }
        // (columns that stay blocks and centre or end their items: aligned here too)
        for (i = 0; i < bfBoxes.length; i++) {
            var cb = bfBoxes[i];
            if (cb.__brFx !== 2 || cb.__brAsGen === gen || !cb.parentNode) continue;
            var cba = getComputedStyle(cb).webkitBoxAlign;
            if (cba && cba !== 'stretch') { cb.__brAsGen = gen; boxes.push(cb); }
        }
        // read: every box's items, and the boxes that changed since they were aligned (the others stay as they are)
        var undo = [], todo = [], kept = [];
        for (i = 0; i < asBoxes.length; i++) if (asBoxes[i].__brAsGen !== gen) undo.push(asBoxes[i]);
        for (i = 0; i < boxes.length; i++) {
            var box = boxes[i], kids = [];
            for (var c = box.firstElementChild; c; c = c.nextElementSibling) {
                if (BF_SKIP[c.tagName]) continue;
                var ccs = getComputedStyle(c);
                if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed') continue;
                kids.push({ el: c, code: c.__brAsGen === gen ? c.__brAsCode : '' });
            }
            if (box.__brAsSig && box.__brAsSig === asSignature(box, kids)) { kept.push(box); continue; }
            todo.push({ box: box, kids: kids });
            undo.push(box);
        }
        if (!todo.length && !undo.length) return;
        // write: taken back, rows laid out afresh (in a column every item's style changed)
        var fresh = [];
        for (i = 0; i < undo.length; i++) { var row = undo[i].__brAsRow; if (asUndo(undo[i]) && row) fresh.push(undo[i]); }
        relayoutAll(fresh);
        // read, write: boxes to the start, columns placed; rows laid out afresh, measured and placed
        var go = [], rows = [];
        for (i = 0; i < todo.length; i++) {
            if (asPrepare(todo[i])) { go.push(todo[i]); continue; }
            // (nothing to move: remembered as it is, so that it is not measured again until something changes)
            todo[i].box.__brAsSig = asSignature(todo[i].box, todo[i].kids);
            kept.push(todo[i].box);
        }
        for (i = 0; i < go.length; i++) asStart(go[i]);
        var moved = [];
        for (i = 0; i < go.length; i++) if (!go[i].vertical) { moved.push(go[i].box); rows.push(go[i]); }
        relayoutAll(moved);
        for (i = 0; i < rows.length; i++) asMeasureRow(rows[i]);
        for (i = 0; i < rows.length; i++) asPlaceRow(rows[i]);
        for (i = 0; i < go.length; i++) { t = go[i]; t.box.__brAsSig = asSignature(t.box, t.kids); kept.push(t.box); }
        asBoxes = kept;
    };
    onMarkers(function () {
        var t0 = Date.now();
        markFlexItems();
        var t1 = Date.now();
        alignFlexItems();
        var t2 = Date.now();
        // (debugging: the time of each, the containers marked and the boxes aligned)
        if (window.__brNoteSlow) window.__brNoteSlow('flex items', t2 - t0, 'mark ' + (t1 - t0) + ' (' + bfBoxes.length + ' boxes: plan ' + markStats.plan + ', queries ' + markStats.query +
            ', checks ' + markStats.check + ' for ' + markStats.checks + ', writes ' + markStats.write + ' for ' + markStats.writes + '), align ' + (t2 - t1) + ' (' + asBoxes.length + ' boxes)');
    });
    var zRule = null, zWidth = 0;
    var positionsInside = function (el) {
        var stack = [], seen = 0, c, n, pos;
        for (c = el.firstElementChild; c; c = c.nextElementSibling) stack.push(c);
        while (stack.length) {
            n = stack.pop();
            if (++seen > 120) return true;   // (too many to look at: left as it is)
            pos = getComputedStyle(n).position;
            if (pos === 'absolute') return true;
            if (pos !== 'static' || n.tagName === 'svg') continue;   // (the boxes inside a positioned one are placed in it)
            for (c = n.firstElementChild; c; c = c.nextElementSibling) stack.push(c);
        }
        return false;
    };
    var stacksByZ = function (el) {
        var par = el.parentNode;
        if (!par || par.nodeType !== 1) return false;
        var pd = getComputedStyle(par).display;
        if (pd !== '-webkit-box' && pd !== '-webkit-inline-box') return false;
        var cs = getComputedStyle(el);
        if (cs.position !== 'static' || cs.display === 'none') return false;
        return !positionsInside(el);
    };
    // (all the items at once: each read after a write made the engine lay the page out again, 2 s on github.com)
    onMarkers(function (marked) {
        var w = window.innerWidth, again = w !== zWidth, todo = [], ok = [], i, el;
        zWidth = w;
        for (i = 0; i < marked.length; i++) {
            if (marked[i].cr.indexOf('br-zi') < 0) continue;
            el = marked[i].el;
            if (el.__brZi && !again) continue;
            el.__brZi = true;
            todo.push(el);
        }
        if (!todo.length) return;
        if (!zRule) {
            zRule = ownStyleElement();
            zRule.textContent = '[data-br-z]{position:relative}';
            var head = document.head || document.documentElement;
            head.insertBefore(zRule, head.firstChild);
        }
        for (i = 0; i < todo.length; i++) if (todo[i].hasAttribute('data-br-z')) todo[i].removeAttribute('data-br-z');   // (what the page's own rules make of it now)
        for (i = 0; i < todo.length; i++) if (stacksByZ(todo[i])) ok.push(todo[i], todo[i].getBoundingClientRect());
        for (i = 0; i < ok.length; i += 2) ok[i].setAttribute('data-br-z', '');
        var back = [];
        for (i = 0; i < ok.length; i += 2) {
            var r0 = ok[i + 1], r1 = ok[i].getBoundingClientRect();
            // (offsets the page gives it, which move a positioned item only (the engine reports them as auto until
            // then), or a z-index its rules no longer give: left as it was)
            if (Math.abs(r1.left - r0.left) > 0.5 || Math.abs(r1.top - r0.top) > 0.5 || getComputedStyle(ok[i]).zIndex === 'auto') back.push(ok[i]);
        }
        for (i = 0; i < back.length; i++) back[i].removeAttribute('data-br-z');
    });
    // A child with a percentage height (cssfix marks it "br-pcth <percent x 100>") of a stretched item of a flex row
    // (a horizontal 2009 box here) grows with every layout on this engine, three times each time: a card's picture at
    // height: 100% made The Guardian's page 86 million px tall. What the percentage means there is the item's
    // stretched height, which the rest of the row's content gives: every such child is taken out (display: none) while
    // the items are measured, then gets its item's height in pixels (or auto when nothing else gives the row a
    // height: auto does not grow). Measured again when the row's or the item's width changes, or when the row grew
    // around the child.
    // A lone horizontal auto margin (cssfix made it 0 and marked it "br-mauto 1|2", the auto side left|right) comes
    // back wherever the 2009 box model does not misuse it: outside 2009 boxes it is auto again (a block pushed to the
    // right). In a box row the old engine resolves it as if the item were alone in the row (a header's menu ended
    // outside the header) and, next to a flexible sibling, hands it all the free space first (Google's result text
    // got 0 px): in a row without flexible items the margin gets the row's free space in pixels, with one it stays 0.
    var mautoEls = [];
    var outerWidth = function (c) {
        var cs = getComputedStyle(c);
        if (cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') return 0;
        // (an inline element that is an item of a box row reports offsetWidth 0 in the old engine: The Guardian's
        // header links got no room, and the row ran 278 px past the page)
        var w = c.offsetWidth || c.getBoundingClientRect().width;
        return w + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
    };
    onMarkers(function (marked) {
        var keep = [], i, el;
        for (i = 0; i < marked.length; i++) {
            var mm = /br-mauto\s+(\d)/.exec(marked[i].cr);
            if (!mm) continue;
            el = marked[i].el;
            var side = mm[1] === '1' ? 'margin-left' : 'margin-right', p = el.parentNode, want = 'auto';
            if (p && p.nodeType === 1) {
                var ps = getComputedStyle(p);
                if ((ps.display === '-webkit-box' || ps.display === '-webkit-inline-box') && ps.webkitBoxOrient === 'horizontal') {
                    var used = 0, c;
                    for (c = p.firstElementChild; c; c = c.nextElementSibling) {
                        if (parseFloat(getComputedStyle(c).webkitBoxFlex) > 0) { want = null; break; }
                        // (the pushed item's own margin on that side is ours, or 0 from the rewriter)
                        used += outerWidth(c) - (c === el ? (parseFloat(getComputedStyle(c)[side === 'margin-left' ? 'marginLeft' : 'marginRight']) || 0) : 0);
                    }
                    if (want) {
                        var free = p.clientWidth - (parseFloat(ps.paddingLeft) || 0) - (parseFloat(ps.paddingRight) || 0) - used;
                        want = free > 0 ? Math.floor(free) + 'px' : null;
                    }
                }
            }
            var had = el.__brMauto;
            if (had && (!want || had.side !== side)) { if (had.prev) el.style.setProperty(had.side, had.prev); else el.style.removeProperty(had.side); el.__brMauto = had = null; }
            if (want && (!had || had.value !== want)) {
                if (!had) el.__brMauto = had = { side: side, prev: el.style.getPropertyValue(side) };
                had.value = want;
                el.style.setProperty(side, want);
            }
            if (el.__brMauto) keep.push(el);
        }
        // (one whose rule no longer applies, a media query after a rotation, loses the margin again)
        for (i = 0; i < mautoEls.length; i++) {
            el = mautoEls[i];
            if (keep.indexOf(el) >= 0 || !el.__brMauto) continue;
            if (el.__brMauto.prev) el.style.setProperty(el.__brMauto.side, el.__brMauto.prev); else el.style.removeProperty(el.__brMauto.side);
            el.__brMauto = null;
        }
        mautoEls = keep;
    });
    // A 2009 box with a percentage height whose parent's height is auto (a card at height: 100% in a plain block)
    // grows the same way; there the percentage means auto (CSS 2.1), so the box gets auto. (The parent's own
    // height is read while it is hidden, when the computed style gives the specified value.)
    var isBox = function (d) { return d === '-webkit-box' || d === '-webkit-inline-box'; };
    var specifiedHeight = function (p) {
        var s = p.style, prev = s.getPropertyValue('display'), prio = s.getPropertyPriority('display');
        s.setProperty('display', 'none', 'important');
        var h = getComputedStyle(p).height;
        if (prev) s.setProperty('display', prev, prio); else s.removeProperty('display');
        return h;
    };
    // the engine keeps a 2009 box's old heights until the box is laid out from scratch (a card stayed a million
    // px tall after its picture got 50 px): out of the layout and back
    var relayout = function (el) {
        var s = el.style, prev = s.getPropertyValue('display'), prio = s.getPropertyPriority('display');
        s.setProperty('display', 'none', 'important');
        var x = el.offsetHeight;
        if (prev) s.setProperty('display', prev, prio); else s.removeProperty('display');
        return x;
    };
    // (only boxes that are already running away are touched: taking elements out of the layout and back is not
    // something to do on every page, and a growing one is far taller than the screen within a few layouts)
    var runaway = function (h) { return h > Math.max(3000, 4 * (window.innerHeight || 700)); };
    onMarkers(function (marked) {
        var todo = [], i, g;
        for (i = 0; i < marked.length; i++) {
            var cr = marked[i].cr;
            if (cr.indexOf('br-pcth') < 0) continue;
            g = marked[i].el;
            var item = g.parentNode, row = item && item.parentNode;
            if (!row || row.nodeType !== 1 || item.nodeType !== 1) continue;
            if (!g.__brPct && !g.__brPctAuto && !runaway(g.offsetHeight)) continue;
            var rs = getComputedStyle(row);
            if (!isBox(rs.display) || rs.webkitBoxOrient !== 'horizontal' || rs.webkitBoxAlign !== 'stretch') {
                // (not the child of a stretched item: a box whose parent has an auto height)
                var gcs = getComputedStyle(g);
                if (!isBox(gcs.display) || /^(absolute|fixed)$/.test(gcs.position) || document.compatMode !== 'CSS1Compat' || item === document.documentElement) continue;
                var akey = item.offsetWidth + 'x' + g.offsetWidth;
                if (g.__brPctAuto === akey) continue;
                g.__brPctAuto = akey;
                if (specifiedHeight(item) === 'auto') { g.style.setProperty('height', 'auto', 'important'); relayout(g); }
                continue;
            }
            var pm = /br-pcth\s+(\d+)/.exec(cr), pct = pm ? parseInt(pm[1], 10) / 10000 : 1;
            var key = row.offsetWidth + 'x' + item.offsetWidth;
            if (g.__brPct && g.__brPct.key === key) {
                // (done for these widths; again only when the item became taller than what the child was given)
                var ics0 = getComputedStyle(item), inner0 = item.clientHeight - (parseFloat(ics0.paddingTop) || 0) - (parseFloat(ics0.paddingBottom) || 0);
                if (!g.__brPct.h || Math.abs(Math.round(inner0 * pct) - g.__brPct.h) <= 1) continue;
            }
            if (!g.__brPct) g.__brPct = { prev: g.style.height, prio: g.style.getPropertyPriority('height') };
            todo.push({ g: g, item: item, row: row, pct: pct, key: key, disp: g.style.getPropertyValue('display'), dprio: g.style.getPropertyPriority('display') });
            g.style.setProperty('display', 'none', 'important');
        }
        if (!todo.length) return;
        var rows = [];
        for (i = 0; i < todo.length; i++) if (rows.indexOf(todo[i].row) < 0) rows.push(todo[i].row);
        for (i = 0; i < rows.length; i++) relayout(rows[i]);
        for (i = 0; i < todo.length; i++) {
            var t = todo[i], ics = getComputedStyle(t.item);
            var inner = t.item.clientHeight - (parseFloat(ics.paddingTop) || 0) - (parseFloat(ics.paddingBottom) || 0);
            t.h = Math.max(0, Math.round(inner * t.pct));
        }
        for (i = 0; i < todo.length; i++) {
            var tg = todo[i].g;
            if (todo[i].disp) tg.style.setProperty('display', todo[i].disp, todo[i].dprio); else tg.style.removeProperty('display');
            tg.style.setProperty('height', todo[i].h > 0 ? todo[i].h + 'px' : 'auto', 'important');
            tg.__brPct.key = todo[i].key;
            tg.__brPct.h = todo[i].h;
        }
        for (i = 0; i < rows.length; i++) relayout(rows[i]);
    });
    // Form controls and replaced elements styled with display:flex (Google's search box) become 2009 boxes after
    // the CSS rewrite, which draws their text outside the control: they go back to block / inline-block.
    // (all styles are read first, then the controls changed: a read after a change lays the page out again)
    var unboxControls = function () {
        try {
            var controls = document.querySelectorAll('textarea, input, select, button, img, video, canvas, iframe'), change = [], i;
            for (i = 0; i < controls.length; i++) {
                var c = controls[i];
                if (c.__brUnboxed) continue;
                var disp = getComputedStyle(c).display;
                if (disp === '-webkit-box' || disp === '-webkit-inline-box') change.push(c, disp === '-webkit-box' ? 'block' : 'inline-block');
            }
            for (i = 0; i < change.length; i += 2) { change[i].style.display = change[i + 1]; change[i].__brUnboxed = true; }
        } catch (e) {}
    };
    onReady(unboxControls);
    onSettled(unboxControls);
    // Items of a flex row shrink when the row has too little room (flex-shrink: 1 is the default); the 2009 boxes here
    // keep every item at its preferred width, and a row with a full-width item next to a logo was wider than the
    // screen (seznam.cz: 1904 px of 1024). When the page is wider than the window, a row whose items reach past its
    // own width gets its shrinkable items capped (max-width) at their share of the room, shared out by their widths
    // as flex-shrink does: not items with flex-shrink: 0 (the rewriter lists their selectors, see noteMarkerRules),
    // flexible ones (the old box shrinks those itself), pictures or form controls. An item whose content cannot
    // become that narrow keeps its narrowest width (min-width: auto).
    var SHRINK_NOT = { IMG: 1, VIDEO: 1, CANVAS: 1, IFRAME: 1, EMBED: 1, OBJECT: 1, svg: 1, SVG: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, BUTTON: 1 };
    var shrunk = [], shrinkTimer = null, shrinkCost = 0, shrinkEnd = 0, shrinkStamp = 1, shrinkFutile = -1, noShrinkPlan = null, noShrinkLen = -1;
    var noShrink = function (el) {
        var list = window.__brNoShrink;
        if (!list || !list.length || !el.webkitMatchesSelector) return false;
        if (noShrinkLen !== list.length) {
            // (in chunks, and one by one where a chunk has a selector the engine refuses)
            noShrinkPlan = [];
            for (var i = 0; i < list.length; i += 30) {
                var chunk = list.slice(i, i + 30).join(',');
                try { el.webkitMatchesSelector(chunk); noShrinkPlan.push(chunk); }
                catch (e) { for (var k = i; k < i + 30 && k < list.length; k++) { try { el.webkitMatchesSelector(list[k]); noShrinkPlan.push(list[k]); } catch (e2) {} } }
            }
            noShrinkLen = list.length;
        }
        for (var p = 0; p < noShrinkPlan.length; p++) { try { if (el.webkitMatchesSelector(noShrinkPlan[p])) return true; } catch (e3) {} }
        return false;
    };
    // how much wider an item would have to be for its content: its own overflow, or that of a child that clips it (a
    // link with overflow: hidden in a menu entry: the entry seemed to fit at any width and was squeezed to nothing)
    var overflowOf = function (el) {
        // (an item that clips or scrolls its own content can get narrower than it: its min-width: auto is 0 - sport.cz's
        // menu, overflow: hidden, frozen at its content's width stood 200 px past the screen)
        if (getComputedStyle(el).overflowX !== 'visible') return 0;
        var over = el.scrollWidth - el.clientWidth;
        for (var c = el.firstElementChild; c; c = c.nextElementSibling) over = Math.max(over, c.scrollWidth - c.clientWidth);
        return over;
    };
    var unshrink = function () {
        for (var i = 0; i < shrunk.length; i++) { shrunk[i].style.maxWidth = shrunk[i].__brShrink || ''; shrunk[i].__brShrink = undefined; }
        shrunk = [];
        shrinkFutile = -1;
    };
    var shrinkRows = function () {
        var t0 = Date.now(), root = document.documentElement, body = document.body, changed = false;
        try {
            for (var round = 0; body && round < 3; round++) {
                var wide = root.scrollWidth;
                if (wide <= root.clientWidth + 1 || wide === shrinkFutile) break;
                // (reads only) the parents with a child reaching past their right edge, outermost first
                var all = body.getElementsByTagName('*'), rows = [], stamp = ++shrinkStamp, i;
                for (i = 0; i < all.length && i < 8000; i++) {
                    var el = all[i], p = el.parentNode;
                    if (!p || p.nodeType !== 1 || p.__brShrinkRow === stamp) continue;
                    var r = el.getBoundingClientRect();
                    if (!r.width || r.right <= 0) continue;
                    if (p.__brShrinkStamp !== stamp) { p.__brShrinkStamp = stamp; p.__brShrinkRight = p.getBoundingClientRect().right; }
                    if (r.right > p.__brShrinkRight + 1) { p.__brShrinkRow = stamp; rows.push(p); }
                }
                var applied = [], wraps = [];
                // (a row in a box that scrolls sideways does not widen the page: it scrolls, like strips of news)
                var inScroller = function (el) {
                    for (var s = el; s && s.nodeType === 1 && s !== body; s = s.parentNode) {
                        var ox = getComputedStyle(s).overflowX;
                        if (ox === 'auto' || ox === 'scroll' || ox === 'overlay') return true;
                    }
                    return false;
                };
                for (var k = 0; k < rows.length; k++) {
                    var row = rows[k], cs = getComputedStyle(row);
                    if ((cs.display !== '-webkit-box' && cs.display !== '-webkit-inline-box') || cs.webkitBoxOrient === 'vertical' || cs.webkitBoxOrient === 'block-axis') continue;
                    // (a row that wraps wraps in a box that scrolls sideways too: sport.cz's menu wraps its entries into a
                    // strip that shows the first line; unwrapped they widened the page to 26 000 px)
                    if (cs.webkitBoxLines === 'multiple') { wraps.push(row, cs.display, cs.webkitBoxPack); continue; }
                    var scroller = inScroller(row);
                    var avail = row.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
                    var items = [], total = 0, scaled = 0;
                    for (var c = row.firstChild; c; c = c.nextSibling) {
                        if (c.nodeType !== 1) continue;
                        var ccs = getComputedStyle(c);
                        if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed') continue;
                        var w = c.offsetWidth || c.getBoundingClientRect().width;   // (an inline item reports 0, see outerWidth)
                        total += w + (parseFloat(ccs.marginLeft) || 0) + (parseFloat(ccs.marginRight) || 0);
                        var can = !SHRINK_NOT[c.tagName] && !(parseFloat(ccs.webkitBoxFlex) > 0) && c.__brShrink === undefined && !noShrink(c);
                        items.push(c, w, can);
                        if (can) scaled += w;
                    }
                    var over = total - avail;
                    if (over <= 1 || scaled <= 0) continue;
                    // (in a box that scrolls sideways only a row that nearly fits: strips of news several screens long are
                    // meant to scroll; sport.cz's menu, a fifth too wide, is meant to shrink)
                    if (scroller && over > avail / 2) continue;
                    // The overflow is shared in proportion to the widths; an item whose content cannot get that narrow
                    // keeps its narrowest width (min-width: auto) and what it did not give up is shared among the others
                    // again, as flexbox freezes such items (github.com: its menu could not shrink, so the buttons beside
                    // it took only part of the overflow and the header stood 270 px past the screen).
                    var active = [], n;
                    for (n = 0; n < items.length; n += 3) {
                        if (!items[n + 2]) continue;
                        var it = items[n];
                        it.__brShrink = it.style.maxWidth;
                        shrunk.push(it);
                        applied.push(it);
                        active.push(it, items[n + 1]);
                    }
                    for (var pass = 0; pass < 4 && over > 1 && active.length; pass++) {
                        var share = 0, j2, next = [];
                        for (j2 = 0; j2 < active.length; j2 += 2) share += active[j2 + 1];
                        if (share <= 0) break;
                        for (j2 = 0; j2 < active.length; j2 += 2) active[j2].style.maxWidth = Math.max(0, Math.floor(active[j2 + 1] - over * active[j2 + 1] / share)) + 'px';
                        for (j2 = 0; j2 < active.length; j2 += 2) {
                            var aw = active[j2], ov = overflowOf(aw);
                            if (ov > 1) aw.style.maxWidth = (aw.offsetWidth + ov) + 'px';
                            else next.push(aw, aw.offsetWidth);
                        }
                        var sum = 0;
                        for (var c2 = row.firstChild; c2; c2 = c2.nextSibling) {
                            if (c2.nodeType !== 1) continue;
                            var c2s = getComputedStyle(c2);
                            if (c2s.display === 'none' || c2s.position === 'absolute' || c2s.position === 'fixed') continue;
                            sum += (c2.offsetWidth || c2.getBoundingClientRect().width) + (parseFloat(c2s.marginLeft) || 0) + (parseFloat(c2s.marginRight) || 0);
                        }
                        over = sum - avail;
                        active = next;
                    }
                }
                // A row that wraps (flex-wrap: the rewriter marks it -webkit-box-lines: multiple) through a class of its own,
                // not the rule that makes it flex: the 2009 box does not wrap, so it becomes a block of inline boxes, as
                // the rewriter makes a row that says both in one rule (seznam.cz's third column stood 900 px past the
                // screen). Its items keep their kind of box (a flex item that is a row stays one, inline).
                var wrapped = 0;
                for (var q = 0; q < wraps.length; q += 3) {
                    var wr = wraps[q];
                    if (wr.__brWrap) continue;
                    wr.__brWrap = true;
                    var wkids = [];
                    for (var wc = wr.firstChild; wc; wc = wc.nextSibling) {
                        if (wc.nodeType !== 1) continue;
                        var wcs = getComputedStyle(wc);
                        if (wcs.position !== 'absolute' && wcs.position !== 'fixed') wkids.push(wc, wcs.display);
                    }
                    wr.style.display = wraps[q + 1] === '-webkit-inline-box' ? 'inline-block' : 'block';
                    for (var kw = 0; kw < wkids.length; kw += 2) {
                        var kd = wkids[kw + 1];
                        if (kd === 'none' || /^inline|^-webkit-inline|table-cell/.test(kd)) continue;
                        wkids[kw].style.display = kd === '-webkit-box' ? '-webkit-inline-box' : kd === 'table' ? 'inline-table' : 'inline-block';
                        wkids[kw].style.verticalAlign = 'top';
                    }
                    wrapped++;
                }
                for (i = 0; i < applied.length; i++) {
                    var a = applied[i], aov = overflowOf(a);
                    if (aov > 1) a.style.maxWidth = (a.offsetWidth + aov) + 'px';
                }
                if (!applied.length && !wrapped) { shrinkFutile = wide; break; }   // (nothing here narrows it: not looked at again while it stays so)
                changed = true;
            }
        } catch (e) {}
        shrinkCost = Date.now() - t0;
        shrinkEnd = Date.now();
        return changed;
    };
    // (the scan reads every element: a page it ran long on waits five times its cost)
    var scheduleShrink = function () {
        if (shrinkTimer || leanPage()) return;
        shrinkTimer = setTimeout(function () { shrinkTimer = null; shrinkRows(); }, Math.max(200, shrinkEnd + shrinkCost * 5 - Date.now()));
    };
    onReady(scheduleShrink);
    onSettled(scheduleShrink);
    window.addEventListener('load', scheduleShrink, false);
    var reshrink = function () { unshrink(); scheduleShrink(); };
    window.__brReshrink = function () { if (shrunk.length) reshrink(); };
    window.addEventListener('orientationchange', reshrink, false);
    window.addEventListener('resize', function () { if (shrunk.length) reshrink(); else scheduleShrink(); }, false);
    window.__brShrinkRows = shrinkRows;   // (tests)
    // Gaps of flex containers set by a rule of their own (utility classes: class="flex gap-4"; see gapMark in
    // cssfix.js): the marker carries the length ("br-cgap-rem 100": 1rem between columns). In a row box the items after
    // the first get the column gap as a left margin on top of their own; a column box, or the plain block a flex column
    // is here, gives the row gap as a top margin. (Floats and inline blocks are the grid and wrapping forms, which have
    // margins of their own.) All styles are read before any margin changes.
    var gapLength = function (unit, n, el) {
        if (unit === 'px') return n;
        var from = unit === 'rem' ? document.documentElement : el;
        return n * (parseFloat(getComputedStyle(from).fontSize) || 16);
    };
    onMarkers(function (marked) {
        var todo = [], i, t;
        for (i = 0; i < marked.length; i++) {
            var cr = marked[i].cr;
            if (cr.indexOf('gap-') < 0) continue;
            var el = marked[i].el, cs = getComputedStyle(el), re = /br-([rc])gap-(px|rem|em) (\d+)/g, m, gaps = { r: 0, c: 0 };
            while ((m = re.exec(cr)) !== null) gaps[m[1]] = gapLength(m[2], +m[3] / 100, el);
            var box = cs.display === '-webkit-box' || cs.display === '-webkit-inline-box';
            if (!box && cs.display !== 'block') continue;
            // (a multi-column box spaces its columns itself)
            if (!box && ((cs.webkitColumnCount && cs.webkitColumnCount !== 'auto') || (cs.webkitColumnWidth && cs.webkitColumnWidth !== 'auto'))) continue;
            var row = box && cs.webkitBoxOrient !== 'vertical' && cs.webkitBoxOrient !== 'block-axis';
            var rev = box && cs.webkitBoxDirection === 'reverse';
            var prop = row ? (rev ? 'marginRight' : 'marginLeft') : (rev ? 'marginBottom' : 'marginTop');
            var gap = row ? gaps.c : gaps.r, first = true, kids = [];
            for (var c = el.firstChild; c; c = c.nextSibling) {
                if (c.nodeType !== 1) continue;
                var ccs = getComputedStyle(c);
                if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed') continue;
                if (!box && (ccs.cssFloat !== 'none' || /^inline/.test(ccs.display))) { kids = null; break; }
                kids.push(c, ccs, first ? 0 : gap);
                first = false;
            }
            if (!kids) continue;
            for (var k = 0; k < kids.length; k += 3) {
                var kid = kids[k], want = kids[k + 2], g = kid.__brGap;
                if (g && kid.style[g.prop] !== g.set) g = kid.__brGap = null;   // (the page set the margin itself since)
                if (g ? g.prop === prop && g.gap === want : !want) continue;
                var own = parseFloat(kids[k + 1][prop]) || 0;
                if (g && g.prop === prop) own -= g.gap;
                todo.push({ el: kid, g: g, prop: prop, want: want, own: own });
            }
        }
        for (i = 0; i < todo.length; i++) {
            t = todo[i];
            if (t.g) { t.el.style[t.g.prop] = t.g.inline; t.el.__brGap = null; }
            if (!t.want) continue;
            var inline = t.el.style[t.prop];
            t.el.style[t.prop] = (t.own + t.want) + 'px';
            t.el.__brGap = { prop: t.prop, set: t.el.style[t.prop], inline: inline, gap: t.want };
        }
    });
    // A box that scrolls (overflow-y auto/scroll: marked br-scroll by cssfix) but grew to its content inside a box that
    // clips it: in a flex column it would have shrunk to the room left (a dialog's text scrolls and its buttons stay in
    // view), but flex columns are plain blocks here (YouTube's consent dialog had its buttons below the screen). It
    // gets the height that fits (one finger scrolls it, see the block below); measured again from its own height at
    // every marker scan.
    onMarkers(function (marked) {
        for (var i = 0; i < marked.length; i++) {
            if (marked[i].cr.indexOf('br-scroll') < 0) continue;
            var s = marked[i].el;
            try {
                if (s.__brFit) { s.style.maxHeight = s.__brFit.maxHeight; s.__brFit = null; }
                if (s.clientHeight < 80 || s.scrollHeight > s.clientHeight + 1) continue;   // (small, or it scrolls already)
                var clip = null;
                for (var a = s.parentNode, depth = 0; a && a.nodeType === 1 && a !== document.body && a !== document.documentElement && depth < 8; a = a.parentNode, depth++) {
                    var cs = getComputedStyle(a);
                    if (cs.overflowY === 'hidden' || cs.position === 'fixed') { clip = a; break; }
                    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') break;   // (inside a scrolling box it is reachable)
                }
                if (!clip) continue;
                var over = clip.scrollHeight - clip.clientHeight;
                if (over <= 1 || s.getBoundingClientRect().bottom <= clip.getBoundingClientRect().bottom + 1) continue;
                var fit = s.clientHeight - over;
                if (fit < 60) continue;
                s.__brFit = { maxHeight: s.style.maxHeight };
                s.style.maxHeight = fit + 'px';
            } catch (e) {}
        }
    });
    // One finger moves boxes that scroll. iOS 6 does that itself only for a box with -webkit-overflow-scrolling: touch
    // on a page drawn with accelerated compositing, which the app switches off for heavy pages (YouTube); every other
    // overflow: auto / scroll box takes two fingers, which nobody knows (the text of YouTube's consent dialog could not
    // be moved to its buttons). Here the innermost box under the finger that can scroll along the gesture moves with
    // it (the page when the box is at its end at the start), and glides on after the finger lets go.
    (function () {
        if (!('ontouchstart' in window) || !document.addEventListener) return;
        var compositing = null, askedAt = 0, active = null, glide = null;
        // (whether the page is drawn with compositing only the app knows; asked when a box with native touch
        // scrolling is met, at most every 10 s)
        var nativeTouch = function (el) {
            var ws = '';
            try { ws = getComputedStyle(el).webkitOverflowScrolling; } catch (e) {}
            if (ws !== 'touch') return false;
            if (compositing === null || Date.now() - askedAt > 10000) {
                askedAt = Date.now();
                try {
                    var x = new XMLHttpRequest();
                    x.open('GET', 'https://ios6-browser.invalid/state', false);
                    x.send(null);
                    compositing = x.status === 200 ? !!JSON.parse(x.responseText).compositing : true;
                } catch (e2) { compositing = true; }
            }
            return compositing;
        };
        var boxesAt = function (target) {
            var list = [];
            for (var n = target && target.nodeType === 1 ? target : target && target.parentNode; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentNode) {
                var cs = getComputedStyle(n);
                var y = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 1;
                var x = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1;
                if (y || x) list.push({ el: n, y: y, x: x });
            }
            return list;
        };
        // (capture, and not passive where browsers make document touch listeners passive by default: the old engine
        // takes the object as a true useCapture)
        var listenOpts = { capture: true, passive: false };
        var stopGlide = function () { if (glide) { clearTimeout(glide.timer); glide = null; } };
        var pos = function (el, axis) { return axis === 'y' ? el.scrollTop : el.scrollLeft; };
        var moveBy = function (el, axis, d) { var before = pos(el, axis); if (axis === 'y') el.scrollTop = before + d; else el.scrollLeft = before + d; return pos(el, axis) !== before; };
        document.addEventListener('touchstart', function (e) {
            stopGlide();
            active = null;
            if (!e.touches || e.touches.length !== 1) return;
            var list = boxesAt(e.target);
            if (!list.length) return;
            var t = e.touches[0];
            active = { list: list, sx: t.clientX, sy: t.clientY, x: t.clientX, y: t.clientY, axis: null, el: null, took: false, t: Date.now(), v: 0 };
        }, listenOpts);
        document.addEventListener('touchmove', function (e) {
            if (!active) return;
            if (!e.touches || e.touches.length !== 1) { active = null; return; }
            var t = e.touches[0];
            if (!active.axis) {
                var ax = Math.abs(t.clientX - active.sx), ay = Math.abs(t.clientY - active.sy);
                if (ax < 8 && ay < 8) return;   // (a tap so far)
                active.axis = ay >= ax ? 'y' : 'x';
                for (var i = 0; i < active.list.length; i++) if (active.list[i][active.axis]) { active.el = active.list[i].el; break; }
                if (!active.el || nativeTouch(active.el)) { active = null; return; }
                active.x = t.clientX;
                active.y = t.clientY;
                active.t = Date.now();
                return;
            }
            var d = active.axis === 'y' ? active.y - t.clientY : active.x - t.clientX;
            var moved = moveBy(active.el, active.axis, d);
            var now = Date.now(), dt = Math.max(8, now - active.t);
            active.v = 0.8 * (d / dt) + 0.2 * active.v;
            active.t = now;
            active.x = t.clientX;
            active.y = t.clientY;
            // (once the box has the gesture the page stays where it is; a box at its end at the start leaves it to the page)
            if (moved) active.took = true;
            if (active.took) e.preventDefault();
        }, listenOpts);
        document.addEventListener('touchend', function () {
            var a = active;
            active = null;
            if (!a || !a.took || Date.now() - a.t > 120 || Math.abs(a.v) < 0.15) return;
            var el = a.el, axis = a.axis;
            glide = { v: a.v };
            var step = function () {
                if (!glide) return;
                var moved = moveBy(el, axis, glide.v * 16);
                glide.v *= 0.95;
                if (!moved || Math.abs(glide.v) < 0.03) { glide = null; return; }
                glide.timer = setTimeout(step, 16);
            };
            glide.timer = setTimeout(step, 16);
        }, true);
        document.addEventListener('touchcancel', function () { active = null; }, true);
    })();
    // ---- Pseudo-classes as classes: cssfix rewrites :focus-within, :placeholder-shown, :user-invalid/:user-valid,
    // :blank, :target-within, :playing/:paused/:muted and :local-link to .br-* classes that are kept up to date here.
    (function () {
        var focusChain = [];
        var setChain = function (el, on) { for (var n = el; n && n.nodeType === 1; n = n.parentNode) setStateClass(n, 'br-focus-within', on); };
        var onFocus = function (e) {
            var t = e.target;
            if (!t || t.nodeType !== 1) return;
            for (var i = 0; i < focusChain.length; i++) setStateClass(focusChain[i], 'br-focus-within', false);
            focusChain = [];
            for (var n = t; n && n.nodeType === 1; n = n.parentNode) { setStateClass(n, 'br-focus-within', true); focusChain.push(n); }
        };
        var onBlur = function () {
            setTimeout(function () {
                var active = document.activeElement;
                if (active && active !== document.body && active !== document.documentElement) return;   // focus moved elsewhere: onFocus handled it
                for (var i = 0; i < focusChain.length; i++) setStateClass(focusChain[i], 'br-focus-within', false);
                focusChain = [];
            }, 0);
        };
        document.addEventListener('focus', onFocus, true);
        document.addEventListener('blur', onBlur, true);
        // text fields: placeholder-shown / blank, user-invalid / user-valid after the user has touched the field
        var isField = function (el) { return el && el.nodeType === 1 && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'); };
        var updateField = function (el, touched) {
            if (!isField(el)) return;
            var empty = el.tagName === 'SELECT' ? false : !el.value;
            setStateClass(el, 'br-blank', empty);
            setStateClass(el, 'br-placeholder-shown', empty && !!el.getAttribute('placeholder'));
            if (touched) el.__brTouched = true;
            if (el.__brTouched && typeof el.checkValidity === 'function') {
                var valid = true;
                try { valid = el.checkValidity(); } catch (e) {}
                setStateClass(el, 'br-user-invalid', !valid);
                setStateClass(el, 'br-user-valid', valid && !!el.value);
            }
        };
        var scanFields = function () {
            try { var all = document.querySelectorAll('input, textarea'); for (var i = 0; i < all.length; i++) updateField(all[i], false); } catch (e) {}
        };
        document.addEventListener('input', function (e) { updateField(e.target, false); }, true);
        document.addEventListener('change', function (e) { updateField(e.target, true); }, true);
        document.addEventListener('blur', function (e) { if (isField(e.target) && e.target.value) updateField(e.target, true); }, true);
        document.addEventListener('invalid', function (e) { updateField(e.target, true); }, true);
        document.addEventListener('reset', function () { setTimeout(scanFields, 0); }, true);
        onReady(scanFields);
        onSettled(scanFields);
        setInterval(scanFields, 1500);   // programmatic value changes
        // media
        var mediaState = function (e) {
            var m = e.target;
            if (!m || (m.tagName !== 'VIDEO' && m.tagName !== 'AUDIO')) return;
            setStateClass(m, 'br-playing', !m.paused && !m.ended);
            setStateClass(m, 'br-paused', m.paused || m.ended);
            setStateClass(m, 'br-muted', !!m.muted || m.volume === 0);
            setStateClass(m, 'br-seeking', !!m.seeking);
            if (e.type === 'waiting') m.__brBuffering = true; else if (e.type === 'playing' || e.type === 'canplay' || e.type === 'pause' || e.type === 'ended') m.__brBuffering = false;
            if (e.type === 'stalled') m.__brStalled = true; else if (e.type === 'progress' || e.type === 'playing' || e.type === 'canplay') m.__brStalled = false;
            setStateClass(m, 'br-buffering', !!m.__brBuffering);
            setStateClass(m, 'br-stalled', !!m.__brStalled);
        };
        var mediaEvents = ['play', 'playing', 'pause', 'ended', 'volumechange', 'loadedmetadata', 'emptied', 'seeking', 'seeked', 'waiting', 'canplay', 'stalled', 'progress'];
        for (var me = 0; me < mediaEvents.length; me++) document.addEventListener(mediaEvents[me], mediaState, true);
        // :target-within
        var targetChain = [];
        var updateTarget = function () {
            for (var i = 0; i < targetChain.length; i++) setStateClass(targetChain[i], 'br-target-within', false);
            targetChain = [];
            var id = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
            if (!id) return;
            var t = null;
            try { t = document.getElementById(id); } catch (e) {}
            for (var n = t; n && n.nodeType === 1; n = n.parentNode) { setStateClass(n, 'br-target-within', true); targetChain.push(n); }
        };
        window.addEventListener('hashchange', updateTarget, false);
        onReady(updateTarget);
        // :local-link: links to the current site
        var markLocalLinks = function (root) {
            if (leanPage()) return;
            try {
                var links = (root && root.querySelectorAll ? root : document).querySelectorAll('a[href]');
                for (var i = 0; i < links.length; i++) {
                    var a = links[i];
                    if (a.__brLocalChecked) continue;
                    a.__brLocalChecked = true;
                    if (a.host === location.host && a.protocol === location.protocol) setStateClass(a, 'br-local-link', true);
                }
            } catch (e) {}
        };
        onReady(function () { markLocalLinks(document); });
        onSettled(function () { markLocalLinks(document); });
    })();
    // ---- :has() and @container: the CSS rewriter turned them into .br-has-<h> / .br-cq-<h> classes and left the
    // entries in a manifest the app serves per page; the classes are kept up to date here.
    (function () {
        var manifest = null, lastText = '', applyTimer = null, fetching = false, fetchTimer = null, fetches = 0;
        var manifestURL = function () { return window.__brManifestURL || ('https://ios6-browser.invalid/manifest?doc=' + encodeURIComponent(location.href.split('#')[0])); };   // the override is for tests
        var trim = function (s) { return String(s).trim(); };
        var splitTop = function (s, sep) {
            var parts = [], depth = 0, start = 0, q = null;
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (q) { if (c === q) q = null; continue; }
                if (c === '"' || c === "'") q = c; else if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--;
                else if (depth === 0 && c === sep) { parts.push(s.slice(start, i)); start = i + 1; }
            }
            parts.push(s.slice(start));
            return parts;
        };
        // ---- :has(): does `el` have what the relative selector list asks for?
        var hasMatch = function (el, inner) {
            var parts = splitTop(inner, ','), parent = el.parentNode || document;
            el.setAttribute('data-br-scope', '1');
            var found = false;
            try {
                for (var i = 0; i < parts.length && !found; i++) {
                    var p = trim(parts[i]);
                    if (!p) continue;
                    var sel = '[data-br-scope]' + (/^[>+~]/.test(p) ? ' ' + p : ' ' + p);
                    try { found = !!parent.querySelector(sel); } catch (e) { found = false; }
                }
            } finally { el.removeAttribute('data-br-scope'); }
            return found;
        };
        // a part of a :has() argument that can be answered from the inside: one compound selector (no combinator in
        // it) as a descendant or a child; null for anything else
        var insideOut = function (p) {
            var child = false;
            if (p.charAt(0) === '>') { child = true; p = trim(p.slice(1)); }
            else if (/^[+~]/.test(p)) return null;
            var depth = 0, q = null;
            for (var i = 0; i < p.length; i++) {
                var c = p.charAt(i);
                if (q) { if (c === q) q = null; continue; }
                if (c === '"' || c === "'") q = c;
                else if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (!depth && (c === ' ' || c === '>' || c === '+' || c === '~' || c === ',')) return null;
            }
            return p ? { sel: p, child: child } : null;
        };
        var hasStamp = 0;
        var applyHas = function () {
            if (!manifest || !manifest.has || !manifest.has.length) return;
            for (var i = 0; i < manifest.has.length; i++) {
                var entry = manifest.has[i], candidates, k;
                try { candidates = document.querySelectorAll(entry.target); } catch (e) { continue; }
                if (!candidates.length) continue;
                // The usual forms (":has(img)", ":has(> .x)") are found from the inside: the elements the compound
                // matches stamp their parents or ancestors, once per pass. (Asking every candidate with a scoped
                // query marked and unmarked each of them: seconds per pass on a big page that changes all the time.)
                var parts = entry.__brParts || (entry.__brParts = (function () {
                    var ps = splitTop(entry.inner, ','), out = [];
                    for (var x = 0; x < ps.length; x++) { var io = insideOut(trim(ps[x])); if (!io) return false; out.push(io); }
                    return out;
                })());
                if (parts) {
                    var stamp = ++hasStamp, keep = [];
                    for (var pi = 0; pi < parts.length; pi++) {
                        var found;
                        try { found = document.querySelectorAll(parts[pi].sel); } catch (e2) { found = []; }
                        for (k = 0; k < found.length; k++) {
                            if (parts[pi].child) {
                                var par = found[k].parentNode;
                                if (par && par.nodeType === 1 && par.__brHasStamp !== stamp) { par.__brHasStamp = stamp; keep.push(par); }
                                continue;
                            }
                            // (a stamped ancestor has its own ancestors stamped already)
                            for (var a = found[k].parentNode; a && a.nodeType === 1 && a.__brHasStamp !== stamp; a = a.parentNode) { a.__brHasStamp = stamp; keep.push(a); }
                        }
                    }
                    for (k = 0; k < candidates.length; k++) setStateClass(candidates[k], 'br-has-' + entry.h, candidates[k].__brHasStamp === stamp);
                    keep = null;
                    continue;
                }
                for (k = 0; k < candidates.length && k < 3000; k++) setStateClass(candidates[k], 'br-has-' + entry.h, hasMatch(candidates[k], entry.inner));
            }
        };
        // ---- structural selectors (manifest "sc"): :nth-child(An+B of S), :nth-col() / :nth-last-col(), the column
        // combinator (cells in the columns of <col> elements), :defined (custom elements not upgraded yet)
        var anMatch = function (an, idx) {   // idx is 1-based
            an = String(an).replace(/\s+/g, '');
            if (an === 'odd') return idx % 2 === 1;
            if (an === 'even') return idx % 2 === 0;
            var m = /^([+-]?\d*)n([+-]\d+)?$/.exec(an);
            if (!m) return idx === parseInt(an, 10);
            var a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : 0;
            if (a === 0) return idx === b;
            var n = (idx - b) / a;
            return n >= 0 && Math.floor(n) === n;
        };
        // (a selector the engine took once goes without a try - a function with one costs 2.3 us more per call here)
        var selOK = Object.create(null);
        var matchesTry = function (el, s) { var f = el.matches || el.webkitMatchesSelector; try { var r = !!f.call(el, s); selOK[s] = true; return r; } catch (e) { return false; } };
        var matchesSel = function (el, s) { return selOK[s] === true ? !!(el.matches || el.webkitMatchesSelector).call(el, s) : matchesTry(el, s); };
        // cells of a table with the columns they cover (colspan / rowspan honoured), and the table's width in columns
        var tableGrid = function (table) {
            var taken = [], cells = [], rows = table.rows, width = 0;
            for (var r = 0; r < rows.length; r++) {
                var row = rows[r].cells, col = 0;
                taken[r] = taken[r] || [];
                for (var c = 0; c < row.length; c++) {
                    while (taken[r][col]) col++;
                    var cs = Math.max(1, row[c].colSpan || 1), rs = Math.max(1, row[c].rowSpan || 1);
                    for (var rr = r; rr < Math.min(rows.length, r + rs); rr++) { taken[rr] = taken[rr] || []; for (var cc = col; cc < col + cs; cc++) taken[rr][cc] = 1; }
                    cells.push({ el: row[c], from: col + 1, to: col + cs });
                    col += cs;
                    if (col > width) width = col;
                }
            }
            return { cells: cells, width: width };
        };
        // the columns each <col> / <colgroup> of a table stands for
        var columnElements = function (table) {
            var out = [], pos = 1;
            for (var g = table.firstElementChild || table.firstChild; g; g = g.nextSibling) {
                if (g.nodeType !== 1 || g.tagName !== 'COLGROUP') continue;
                var start = pos, cols = g.getElementsByTagName('col');
                if (!cols.length) pos += parseInt(g.getAttribute('span'), 10) || 1;
                for (var k = 0; k < cols.length; k++) { var span = parseInt(cols[k].getAttribute('span'), 10) || 1; out.push({ el: cols[k], from: pos, to: pos + span - 1 }); pos += span; }
                out.push({ el: g, from: start, to: pos - 1 });
            }
            return out;
        };
        var scStamp = 0, undefinedMarks = false;
        var applyStructural = function () {
            if (!manifest || !manifest.sc || !manifest.sc.length) return;
            var grids = null, i, k;
            scStamp++;
            for (i = 0; i < manifest.sc.length; i++) {
                var e = manifest.sc[i], on = [];
                if (e.k === 'defined') { undefinedMarks = true; if (window.__brMarkUndefined) window.__brMarkUndefined(document); continue; }
                try {
                    if (e.k === 'nth') {
                        // the element's index among its siblings that match S
                        var list = document.querySelectorAll(e.of), parents = [];
                        for (k = 0; k < list.length; k++) {
                            var par = list[k].parentNode;
                            if (par.__brScStamp !== scStamp) { par.__brScStamp = scStamp; par.__brScList = []; parents.push(par); }
                            par.__brScList.push(list[k]);
                        }
                        for (var g = 0; g < parents.length; g++) {
                            var items = parents[g].__brScList;
                            for (var j = 0; j < items.length; j++) if (anMatch(e.an, e.last ? items.length - j : j + 1)) on.push(items[j]);
                            parents[g].__brScList = null;
                        }
                    } else if (e.k === 'col') {
                        if (!grids) { grids = []; var ts = document.getElementsByTagName('table'); for (var t = 0; t < ts.length; t++) grids.push(tableGrid(ts[t])); }
                        for (var gi = 0; gi < grids.length; gi++) {
                            var gr = grids[gi];
                            for (k = 0; k < gr.cells.length; k++) {
                                var cell = gr.cells[k];
                                for (var col = cell.from; col <= cell.to; col++) if (anMatch(e.an, e.last ? gr.width - col + 1 : col)) { on.push(cell.el); break; }
                            }
                        }
                    } else if (e.k === 'cc') {
                        var colEls = document.querySelectorAll(e.col);
                        for (k = 0; k < colEls.length; k++) {
                            var table = colEls[k];
                            while (table && table.tagName !== 'TABLE') table = table.parentNode;
                            if (!table) continue;
                            var ranges = columnElements(table), range = null;
                            for (var ri = 0; ri < ranges.length; ri++) if (ranges[ri].el === colEls[k]) range = ranges[ri];
                            if (!range) continue;
                            var grid = tableGrid(table);
                            for (var q = 0; q < grid.cells.length; q++) {
                                var ce = grid.cells[q];
                                if (ce.to >= range.from && ce.from <= range.to && matchesSel(ce.el, e.cell)) on.push(ce.el);
                            }
                        }
                    }
                } catch (x) { continue; }
                var cls = 'br-sc-' + e.h, had = document.getElementsByClassName(cls), before = [];
                for (k = 0; k < had.length; k++) before.push(had[k]);
                for (k = 0; k < on.length; k++) { on[k].__brScOn = scStamp + ':' + e.h; setStateClass(on[k], cls, true); }
                for (k = 0; k < before.length; k++) if (before[k].__brScOn !== scStamp + ':' + e.h) setStateClass(before[k], cls, false);
            }
        };
        // ---- @container: size conditions evaluated against the marked container elements (size: the container's, with
        // its em and the rem read with it)
        var lengthPx = function (tok, el, size) {
            var m = /^(-?[\d.]+)([a-z%]*)$/i.exec(tok);
            if (!m) return null;
            var n = parseFloat(m[1]), u = m[2].toLowerCase();
            switch (u) {
                case '': case 'px': return n;
                case 'em': return n * (size && size.em || parseFloat(getComputedStyle(el).fontSize) || 16);
                case 'rem': return n * (size && size.rem || parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
                case 'vw': return n * window.innerWidth / 100;
                case 'vh': return n * window.innerHeight / 100;
                case 'vmin': return n * Math.min(window.innerWidth, window.innerHeight) / 100;
                case 'vmax': return n * Math.max(window.innerWidth, window.innerHeight) / 100;
                case 'pt': return n * 4 / 3;
                case 'cm': return n * 96 / 2.54;
                case 'mm': return n * 96 / 25.4;
                case 'in': return n * 96;
            }
            return null;
        };
        var featureValue = function (name, el, size) {
            switch (name) {
                case 'width': case 'inline-size': return size.w;
                case 'height': case 'block-size': return size.h;
                case 'aspect-ratio': return size.h ? size.w / size.h : 0;
                case 'orientation': return size.w >= size.h ? 'landscape' : 'portrait';
            }
            return undefined;
        };
        var ratioValue = function (tok) { var m = /^([\d.]+)\s*\/\s*([\d.]+)$/.exec(tok); return m ? parseFloat(m[1]) / (parseFloat(m[2]) || 1) : parseFloat(tok); };
        var compare = function (a, op, b) {
            switch (op) { case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b; default: return a === b; }
        };
        var evalFeature = function (expr, el, size) {
            expr = trim(expr);
            if (/^(style|scroll-state)\(/i.test(expr)) return false;
            var colon = expr.indexOf(':');
            var m;
            if (colon > 0 && !/[<>=]/.test(expr)) {
                var name = trim(expr.slice(0, colon)).toLowerCase(), val = trim(expr.slice(colon + 1)).toLowerCase();
                var minmax = /^(min|max)-(.+)$/.exec(name), base = minmax ? minmax[2] : name;
                var fv = featureValue(base, el, size);
                if (fv === undefined) return false;
                if (base === 'orientation') return fv === val;
                var target = base === 'aspect-ratio' ? ratioValue(val) : lengthPx(val, el, size);
                if (target === null || isNaN(target)) return false;
                return minmax ? (minmax[1] === 'min' ? fv >= target : fv <= target) : fv === target;
            }
            // range syntax: "width >= 400px", "400px < width <= 800px", "orientation = portrait"
            m = /^([\w-]+|[\d.]+[a-z%]*(?:\s*\/\s*[\d.]+)?)\s*(<=|>=|<|>|=)\s*([\w-]+|[\d.]+[a-z%]*(?:\s*\/\s*[\d.]+)?)(?:\s*(<=|>=|<|>|=)\s*([\d.]+[a-z%]*(?:\s*\/\s*[\d.]+)?))?$/.exec(expr);
            if (!m) return false;
            var leftIsFeature = featureValue(m[1].toLowerCase(), el, size) !== undefined;
            var feature = leftIsFeature ? m[1].toLowerCase() : m[3].toLowerCase();
            var fval = featureValue(feature, el, size);
            if (fval === undefined) return false;
            var conv = function (tok) { return feature === 'aspect-ratio' ? ratioValue(tok) : feature === 'orientation' ? tok.toLowerCase() : lengthPx(tok, el, size); };
            if (leftIsFeature) return compare(fval, m[2], conv(m[3])) && (!m[4] || compare(fval, m[4], conv(m[5])));
            // "400px < width <= 800px": the first comparison is written from the value's side
            var flip = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' };
            return compare(fval, flip[m[2]], conv(m[1])) && (!m[4] || compare(fval, m[4], conv(m[5])));
        };
        var evalCond = function (cond, el, size) {
            cond = trim(cond);
            if (!cond) return false;
            while (cond.charAt(0) === '(' && (function () { var d = 0; for (var i = 0; i < cond.length; i++) { var c = cond.charAt(i); if (c === '(') d++; else if (c === ')') { d--; if (d === 0) return i === cond.length - 1; } } return false; })()) cond = trim(cond.slice(1, -1));
            if (/^not\s/i.test(cond)) return !evalCond(cond.slice(4), el, size);
            var terms = [], ops = [], depth = 0, start = 0;
            for (var i = 0; i < cond.length; i++) {
                var c = cond.charAt(i);
                if (c === '(') depth++; else if (c === ')') depth--;
                else if (depth === 0) {
                    var m = /^\s+(and|or)\s+/i.exec(cond.slice(i));
                    if (m) { terms.push(cond.slice(start, i)); ops.push(m[1].toLowerCase()); i += m[0].length - 1; start = i + 1; }
                }
            }
            terms.push(cond.slice(start));
            if (terms.length === 1) return evalFeature(cond, el, size);
            var result = evalCond(terms[0], el, size);
            for (var k = 1; k < terms.length; k++) { var v = evalCond(terms[k], el, size); result = ops[k - 1] === 'or' ? (result || v) : (result && v); }
            return result;
        };
        var containerSize = function (el, remPx) {
            var cs = getComputedStyle(el);
            var w = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
            var h = el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
            return { w: w > 0 ? w : 0, h: h > 0 ? h : 0, em: parseFloat(cs.fontSize) || 16, rem: remPx || 0 };
        };
        // Per nesting level of the containers: every size read first (one layout), then the classes set; a container
        // inside another one of the list comes a level later (its size may follow the outer one's classes). One size
        // read after another's class change was a layout each: tailwindcss.com 4 s a scan.
        var cqStamp = 0;
        var applyContainers = function (containers) {
            if (!manifest || !manifest.cq || !manifest.cq.length || !containers) return;
            var stamp = ++cqStamp, levels = [], i, k, d, c;
            for (i = 0; i < containers.length; i++) containers[i].el.__brCqStamp = stamp;
            for (i = 0; i < containers.length; i++) {
                for (d = 0, c = containers[i].el.parentNode; c && c.nodeType === 1; c = c.parentNode) if (c.__brCqStamp === stamp) d++;
                (levels[d] || (levels[d] = [])).push(containers[i]);
            }
            var remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            for (d = 0; d < levels.length; d++) {
                var level = levels[d];
                if (!level) continue;
                for (i = 0; i < level.length; i++) level[i].size = containerSize(level[i].el, remPx);
                for (i = 0; i < level.length; i++) {
                    c = level[i];
                    for (k = 0; k < manifest.cq.length; k++) {
                        var q = manifest.cq[k];
                        if (q.name && c.names.indexOf(q.name) < 0) { setStateClass(c.el, 'br-cq-' + q.h, false); continue; }
                        var on = false;
                        try { on = evalCond(q.cond, c.el, c.size); } catch (e) { on = false; }
                        setStateClass(c.el, 'br-cq-' + q.h, on);
                    }
                }
            }
        };
        window.__brApplyContainerQueries = applyContainers;
        var applyCost = 0, applyEnd = 0;
        var apply = function () {
            applyTimer = null;
            if (!manifest) return;
            var t0 = Date.now(), t = [];
            try { applyStructural(); } catch (e7) {}
            t.push(Date.now());
            try { applyHas(); } catch (e) {}
            t.push(Date.now());
            // the marker scan calls applyContainers and collects the inline deferred-value markers
            try { if (manifest.cq.length || (window.__brDeferred && window.__brDeferred.needsMarkers())) applyAspectRatios(); } catch (e2) {}
            t.push(Date.now());
            try { if (window.__brVars) window.__brVars.apply(); } catch (e5) {}
            t.push(Date.now());
            try { if (window.__brDeferred) window.__brDeferred.apply(); } catch (e3) {}
            t.push(Date.now());
            try { if (window.__brGrid) window.__brGrid.apply(); } catch (e8) {}
            try { if (window.__brSyncSlots) window.__brSyncSlots(); } catch (e10) {}
            applyEnd = Date.now();
            applyCost = applyEnd - t0;
            if (window.__brNoteSlow) window.__brNoteSlow('style pass', applyCost, 'structural ' + (t[0] - t0) + ', :has ' + (t[1] - t[0]) + ', markers ' + (t[2] - t[1]) +
                                                                                 ', vars ' + (t[3] - t[2]) + ', deferred ' + (t[4] - t[3]) + ', grid ' + (applyEnd - t[4]));
        };
        // A pass costs what the page's size makes it cost (blesk.cz: 2.5 s, and the page changes all the time, so the
        // passes ran back to back and the page itself hardly got to run): the next one waits five times as long as
        // the last took.
        var schedule = function () {
            if (applyTimer) return;
            applyTimer = setTimeout(apply, Math.max(120, applyEnd + applyCost * 5 - Date.now()));
        };
        // entries of styles scripts inserted at run time (see runtimeCSS), kept across reloads of the page manifest; and
        // the custom properties those styles define (a CSS-in-JS theme, :root{--x:...} or a class with its own): the root
        // values and the scoped names, for the rules inserted after them and the variables pass (Twitch's consent banner
        // lost its background, color and shadow: var() of names nobody had seen)
        var extra = { has: [], cq: [], dv: [], pt: [], cv: [], sc: [], mk: [], gd: [] }, extraVars = {}, extraScoped = {}, anyExtraVars = false;
        var mergeExtra = function (m) {
            for (var kind in extra) {
                if (!extra.hasOwnProperty(kind) || !extra[kind].length) continue;
                if (!m[kind]) m[kind] = [];
                m[kind] = m[kind].concat(extra[kind]);
            }
            if (anyExtraVars) {
                var vars = {}, k, mv = m.vars || {};
                for (k in mv) if (mv.hasOwnProperty(k)) vars[k] = mv[k];
                for (k in extraVars) if (extraVars.hasOwnProperty(k)) vars[k] = extraVars[k];
                m.vars = vars;
            }
        };
        // the selectors of the rules with markers, for the marker scan (see markerCandidates)
        // (only when the network layer sends them: a manifest without the kind, a test's, means every element is scanned)
        var mkKnown = false;
        var noteMarkerRules = function (m) {
            var list = [], ns = [], mk = m.mk || [], fxBox = [], fxCol = [], as = [];
            // (entries with ns: items that must not shrink, for the shrinking of rows too wide for their room; with fx:
            // flex containers, 2 for a column that stays a block, whose children are marked as items, see markFlexItems;
            // with as: rules that set align-self, see alignFlexItems)
            for (var i = 0; i < mk.length; i++) {
                if (!mk[i] || !mk[i].s) continue;
                if (mk[i].as) { if (mk[i].sl) as.push(mk[i]); }
                else if (mk[i].fx) (mk[i].fx === 2 ? fxCol : fxBox).push(mk[i].s);
                else (mk[i].ns ? ns : list).push(mk[i].s);
            }
            window.__brAlignSelfRules = as;
            window.__brFlexRules = { box: fxBox, col: fxCol, key: fxBox.length + '|' + fxCol.length + '|' + (fxBox.length ? fxBox[fxBox.length - 1] : '') };
            // (rows shrunk before the list came are shrunk again)
            var nsChanged = !window.__brNoShrink || window.__brNoShrink.length !== ns.length;
            window.__brNoShrink = ns;
            if (nsChanged && window.__brReshrink) window.__brReshrink();
            if (!mkKnown) { window.__brMarkerRules = null; return; }
            window.__brMarkerRules = { list: list, key: list.length + '|' + (list.length ? list[list.length - 1] : '') };
        };
        // the root custom properties and the scoped ones, for the rewriter the page runs itself
        var notePageVars = function (m) {
            var names = {}, list = [], cv = m.cv || [];
            for (var i = 0; i < cv.length; i++) {
                var e = cv[i], k;
                if (e.d) for (k = 0; k < e.d.length; k++) names[e.d[k][0]] = 1;
                if (e.r) names[e.r[0]] = 1;
            }
            for (var sn in extraScoped) if (extraScoped.hasOwnProperty(sn)) names[sn] = 1;
            for (var n in names) if (names.hasOwnProperty(n)) list.push(n);
            var vars = m.vars || {};
            if (anyExtraVars) {
                vars = {};
                for (k in m.vars) if (m.vars.hasOwnProperty(k)) vars[k] = m.vars[k];
                for (k in extraVars) if (extraVars.hasOwnProperty(k)) vars[k] = extraVars[k];
            }
            window.__brPageVars = { vars: vars, scoped: list.join(' ') };
        };
        window.__brManifestAdd = function (add) {
            var any = false, varsNew = false, k3;
            for (var kind in extra) {
                if (!extra.hasOwnProperty(kind) || !add[kind] || !add[kind].length) continue;
                extra[kind] = extra[kind].concat(add[kind]);
                any = true;
            }
            if (add.vars) for (k3 in add.vars) if (add.vars.hasOwnProperty(k3) && extraVars[k3] !== add.vars[k3]) { extraVars[k3] = add.vars[k3]; varsNew = anyExtraVars = true; }
            if (add.scoped) for (k3 = 0; k3 < add.scoped.length; k3++) if (!extraScoped[add.scoped[k3]]) { extraScoped[add.scoped[k3]] = 1; varsNew = true; }
            if (!any && !varsNew) return;
            if (!manifest) manifest = { has: [], cq: [], dv: [], pt: [], cv: [], sc: [], mk: [], gd: [] };
            for (var k2 in add) if (add.hasOwnProperty(k2) && extra.hasOwnProperty(k2) && add[k2]) manifest[k2] = (manifest[k2] || []).concat(add[k2]);
            if (varsNew) {
                var mv = {};
                for (k3 in manifest.vars) if (manifest.vars.hasOwnProperty(k3)) mv[k3] = manifest.vars[k3];
                for (k3 in extraVars) if (extraVars.hasOwnProperty(k3)) mv[k3] = extraVars[k3];
                manifest.vars = mv;
                notePageVars(manifest);
            }
            noteMarkerRules(manifest);
            try { if (window.__brDeferred) window.__brDeferred.setManifest(manifest); } catch (e) {}
            try { if (window.__brVars) window.__brVars.setManifest(manifest); } catch (e2) {}
            try { if (window.__brGrid) window.__brGrid.setManifest(manifest); } catch (e8) {}
            schedule();
        };
        // what the network layer registered so far (the page asks only for what came since: GitHub's is 2.3 MB), and
        // the count of its root variables and stylesheets
        var KINDS = ['has', 'cq', 'dv', 'pt', 'cv', 'sc', 'mk', 'gd'], base = null, baseVars = 0;
        var sinceParam = function () {
            if (!base || window.__brManifestURL) return '';
            var parts = [];
            for (var i = 0; i < KINDS.length; i++) parts.push(KINDS[i] + ':' + base[KINDS[i]].length);
            parts.push('vars:' + baseVars, 'sheets:' + (base.sheets ? base.sheets.length : 0));
            return '&since=' + parts.join(',');
        };
        // (a script asking for a custom property before the manifest came: fetched now, synchronously, as the network
        // layer answers at once; apple.com's menu read --r-globalnav-font-size when it started, got nothing, and drew its
        // labels 0 px high)
        window.__brManifestNow = function () {
            if (base || window.__brManifestURL || !window.XMLHttpRequest) return;
            try {
                var x = new XMLHttpRequest();
                x.open('GET', manifestURL(), false);
                x.send(null);
                if (x.status === 200 && x.responseText) receive(x.responseText);
            } catch (e) {}
        };
        var load = function () {
            if (fetching || !window.XMLHttpRequest || fetches > 40) return;
            fetching = true;
            fetches++;
            try {
                var x = new XMLHttpRequest();
                x.open('GET', manifestURL() + sinceParam(), true);
                x.onreadystatechange = function () {
                    if (x.readyState !== 4) return;
                    fetching = false;
                    if (x.status !== 200 || !x.responseText) return;
                    receive(x.responseText);
                };
                x.send(null);
            } catch (e) { fetching = false; }
        };
        var receive = function (text) {
            if (text === lastText) return;
            var got = null, i, k;
            try { got = JSON.parse(text); } catch (e) { got = null; }
            if (!got || got.same) return;
            lastText = text;
            if (got.mk && !window.__brManifestURL) mkKnown = true;
            // (a full answer: the first one, a test URL, or reset because the network layer forgot the page)
            if (!base || got.reset || window.__brManifestURL) base = { has: [], cq: [], dv: [], pt: [], cv: [], sc: [], mk: [], gd: [] };
            for (i = 0; i < KINDS.length; i++) { k = KINDS[i]; if (got[k] && got[k].length) base[k] = base[k].concat(got[k]); }
            if (got.sheets) base.sheets = got.sheets;
            if (got.vars) { base.vars = got.vars; baseVars = 0; for (k in got.vars) if (got.vars.hasOwnProperty(k)) baseVars++; }
            manifest = { sheets: base.sheets, vars: base.vars };
            for (i = 0; i < KINDS.length; i++) manifest[KINDS[i]] = base[KINDS[i]].slice(0);
            if (manifest) { notePageVars(manifest); mergeExtra(manifest); noteMarkerRules(manifest); }
            try { if (manifest && window.__brDeferred) window.__brDeferred.setManifest(manifest); } catch (e4) {}
            try { if (manifest && window.__brVars) window.__brVars.setManifest(manifest); } catch (e6) {}
            try { if (manifest && window.__brGrid) window.__brGrid.setManifest(manifest); } catch (e9) {}
            schedule();
        };
        var scheduleLoad = function () { if (!fetchTimer) fetchTimer = setTimeout(function () { fetchTimer = null; load(); }, 300); };
        onReady(scheduleLoad);
        window.addEventListener('load', scheduleLoad, false);
        onSettled(function () { scheduleLoad(); if (manifest) schedule(); });
        window.addEventListener('resize', function () { if (manifest && (manifest.cq.length || manifest.dv.length || (manifest.gd && manifest.gd.length))) schedule(); }, false);
        var reevaluate = function () { if (manifest && manifest.has.length) schedule(); };
        observeAddedTree(function () { if (manifest && ((manifest.sc && manifest.sc.length) || manifest.has.length)) schedule(); });
        // (an app's page: not at every keystroke - its :has() rules are about its structure, which the DOM changes report)
        document.addEventListener('input', function () { if (!leanPage()) reevaluate(); }, true);
        document.addEventListener('change', reevaluate, true);
        document.addEventListener('click', reevaluate, true);
        document.addEventListener('focus', reevaluate, true);
        document.addEventListener('blur', reevaluate, true);
        window.__brManifestReload = load;
    })();
    // ---- Deferred values (manifest "dv" and "pt", see registerDeferred in cssfix.js): declarations whose value depends
    // on the element. Each pass finds the elements the entries' selectors match (and the style attributes marked with
    // br-dv-<hash>), resolves the cascade among the entries by specificity and order, computes the values and sets
    // them inline: anchor positioning (anchor(), anchor-size(), position-area, position-try-fallbacks, position-visibility,
    // anchor-scope, anchor-center), attr(), calc-size() of intrinsic sizes, sibling-index()/sibling-count(),
    // container-progress(), toggle(), field-sizing and the SVG geometry properties (cx, cy, r, rx, ry, x, y, d).
    (function () {
        var entries = [], byHash = {}, tryRules = {}, inlineMarked = [], hasInline = false;
        var gen = 0, recGen = 0, tracked = [], positioned = [], timelineRecs = [], anchors = {}, scopes = [], scrollTimer = null;
        var SVGNS = 'http://www.w3.org/2000/svg';
        var trim = function (s) { return String(s).trim(); };
        var num = function (s) { var n = parseFloat(s); return isNaN(n) ? 0 : n; };
        var round2 = function (n) { return Math.round(n * 100) / 100; };
        var isGlobal = function (v) { return v === 'inherit' || v === 'initial' || v === 'unset' || v === 'revert' || v === 'revert-layer'; };
        var matchParen = function (s, i) {   // s[i] === '('
            var depth = 0;
            for (var k = i; k < s.length; k++) { var c = s.charAt(k); if (c === '(') depth++; else if (c === ')') { depth--; if (!depth) return k; } }
            return s.length;
        };
        var topComma = function (s) {
            var depth = 0;
            for (var k = 0; k < s.length; k++) { var c = s.charAt(k); if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && !depth) return k; }
            return -1;
        };
        var splitTop = function (s, sep) {
            var parts = [], depth = 0, start = 0;
            for (var k = 0; k < s.length; k++) {
                var c = s.charAt(k);
                if (c === '(') depth++; else if (c === ')') depth--;
                else if (!depth && (sep === ' ' ? /\s/.test(c) : c === sep)) { if (k > start || sep !== ' ') parts.push(trim(s.slice(start, k))); start = k + 1; }
            }
            parts.push(trim(s.slice(start)));
            var out = [];
            for (var j = 0; j < parts.length; j++) if (parts[j] !== '' || sep !== ' ') out.push(parts[j]);
            return out;
        };
        // name(...) -> fn(inner) for every call of `name` (not part of a longer identifier); null makes the value invalid
        var replaceFunctions = function (s, name, fn) {
            if (s === null) return null;
            var out = '', i = 0, lower = s.toLowerCase(), key = name + '(';
            while (i < s.length) {
                var at = lower.indexOf(key, i);
                while (at > 0 && /[\w-]/.test(lower.charAt(at - 1))) at = lower.indexOf(key, at + 1);
                if (at < 0) { out += s.slice(i); break; }
                var close = matchParen(s, at + name.length);
                var r = fn(s.slice(at + key.length, close));
                if (r === null || r === undefined) return null;
                out += s.slice(i, at) + r;
                i = close + 1;
            }
            return out;
        };
        // ---- lengths: numbers with absolute, font, viewport and percentage units, + - * /, calc()/min()/max()/clamp()
        var evalLength = function (str, el, pctBase) {
            var s = trim(String(str)).toLowerCase().replace(/-webkit-calc\(/g, 'calc('), pos = 0, failed = false, fs = null, rfs = null;
            var vw = window.innerWidth, vh = window.innerHeight;
            var fontPx = function () { if (fs === null) fs = num(getComputedStyle(el).fontSize) || 16; return fs; };
            var rootPx = function () { if (rfs === null) rfs = num(getComputedStyle(document.documentElement).fontSize) || 16; return rfs; };
            var unitVal = function (n, u) {
                switch (u) {
                    case '': return { n: n, u: '' };
                    case 'px': return { n: n, u: 'px' };
                    case 'em': return { n: n * fontPx(), u: 'px' };
                    case 'rem': return { n: n * rootPx(), u: 'px' };
                    case 'ex': case 'ch': return { n: n * fontPx() / 2, u: 'px' };
                    case 'lh': return { n: n * fontPx() * 1.2, u: 'px' };
                    case 'vw': case 'svw': case 'lvw': case 'dvw': case 'vi': return { n: n * vw / 100, u: 'px' };
                    case 'vh': case 'svh': case 'lvh': case 'dvh': case 'vb': return { n: n * vh / 100, u: 'px' };
                    case 'vmin': return { n: n * Math.min(vw, vh) / 100, u: 'px' };
                    case 'vmax': return { n: n * Math.max(vw, vh) / 100, u: 'px' };
                    case '%': return pctBase === null || pctBase === undefined ? null : { n: n * pctBase / 100, u: 'px' };
                    case 'pt': return { n: n * 4 / 3, u: 'px' };
                    case 'pc': return { n: n * 16, u: 'px' };
                    case 'in': return { n: n * 96, u: 'px' };
                    case 'cm': return { n: n * 96 / 2.54, u: 'px' };
                    case 'mm': return { n: n * 96 / 25.4, u: 'px' };
                    case 'q': return { n: n * 96 / 101.6, u: 'px' };
                    case 'deg': return { n: n, u: 'deg' };
                    case 'grad': return { n: n * 0.9, u: 'deg' };
                    case 'rad': return { n: n * 180 / Math.PI, u: 'deg' };
                    case 'turn': return { n: n * 360, u: 'deg' };
                    case 's': return { n: n * 1000, u: 'ms' };
                    case 'ms': return { n: n, u: 'ms' };
                }
                return null;
            };
            var skip = function () { while (pos < s.length && /\s/.test(s.charAt(pos))) pos++; };
            var sum, product, atom, args;
            args = function () {
                var list = [];
                for (;;) {
                    var v = sum();
                    if (!v) { failed = true; return null; }
                    list.push(v);
                    skip();
                    var c = s.charAt(pos);
                    if (c === ',') { pos++; continue; }
                    if (c === ')') { pos++; return list; }
                    failed = true;
                    return null;
                }
            };
            atom = function () {
                skip();
                var c = s.charAt(pos), m;
                if (c === '(') { pos++; var v = sum(); skip(); if (s.charAt(pos) !== ')') { failed = true; return null; } pos++; return v; }
                m = /^(calc|min|max|clamp)\(/.exec(s.slice(pos));
                if (m) {
                    pos += m[0].length;
                    var list = args();
                    if (!list) return null;
                    if (m[1] === 'calc') { if (list.length !== 1) { failed = true; return null; } return list[0]; }
                    if (m[1] === 'clamp') { if (list.length !== 3) { failed = true; return null; } return { n: Math.max(list[0].n, Math.min(list[1].n, list[2].n)), u: list[1].u }; }
                    var best = list[0];
                    for (var i = 1; i < list.length; i++) if (m[1] === 'min' ? list[i].n < best.n : list[i].n > best.n) best = list[i];
                    return best;
                }
                if ((c === '-' || c === '+') && !/[\d.]/.test(s.charAt(pos + 1))) {
                    pos++;
                    var inner = atom();
                    if (!inner) return null;
                    return c === '-' ? { n: -inner.n, u: inner.u } : inner;
                }
                m = /^[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/.exec(s.slice(pos));
                if (m) {
                    pos += m[0].length;
                    var u = /^(%|[a-z]+)/.exec(s.slice(pos));
                    if (u) pos += u[0].length;
                    var uv = unitVal(parseFloat(m[0]), u ? u[0] : '');
                    if (!uv) failed = true;
                    return uv;
                }
                failed = true;
                return null;
            };
            product = function () {
                var left = atom();
                for (;;) {
                    if (failed || !left) return null;
                    skip();
                    var op = s.charAt(pos);
                    if (op !== '*' && op !== '/') return left;
                    pos++;
                    var right = atom();
                    if (!right) { failed = true; return null; }
                    if (op === '*') { if (left.u && right.u) { failed = true; return null; } left = { n: left.n * right.n, u: left.u || right.u }; }
                    else { if ((right.u && right.u !== left.u) || !right.n) { failed = true; return null; } left = { n: left.n / right.n, u: right.u ? '' : left.u }; }
                }
            };
            sum = function () {
                var left = product();
                for (;;) {
                    if (failed || !left) return null;
                    skip();
                    var op = s.charAt(pos);
                    if (op !== '+' && op !== '-') return left;
                    pos++;
                    var right = product();
                    if (!right) { failed = true; return null; }
                    if (left.u !== right.u) {
                        if (!left.n && !left.u) left.u = right.u;
                        else if (!right.n && !right.u) right.u = left.u;
                        else { failed = true; return null; }
                    }
                    left = { n: op === '+' ? left.n + right.n : left.n - right.n, u: left.u };
                }
            };
            var r = sum();
            skip();
            if (failed || !r || pos < s.length || isNaN(r.n)) return null;
            return r;
        };
        // ---- property names: logical to physical (horizontal writing, left to right), shorthands to longhands
        var PHYS = { 'inset-block-start': 'top', 'inset-block-end': 'bottom', 'inset-inline-start': 'left', 'inset-inline-end': 'right',
            'inline-size': 'width', 'block-size': 'height', 'min-inline-size': 'min-width', 'min-block-size': 'min-height', 'max-inline-size': 'max-width',
            'max-block-size': 'max-height', 'margin-block-start': 'margin-top', 'margin-block-end': 'margin-bottom', 'margin-inline-start': 'margin-left',
            'margin-inline-end': 'margin-right', 'padding-block-start': 'padding-top', 'padding-block-end': 'padding-bottom',
            'padding-inline-start': 'padding-left', 'padding-inline-end': 'padding-right', 'flex-basis': 'width' };
        var SHORT = { inset: ['top', 'right', 'bottom', 'left'], 'inset-block': ['top', 'bottom'], 'inset-inline': ['left', 'right'],
            'margin-block': ['margin-top', 'margin-bottom'], 'margin-inline': ['margin-left', 'margin-right'],
            'padding-block': ['padding-top', 'padding-bottom'], 'padding-inline': ['padding-left', 'padding-right'] };
        var INSETS = { top: 1, right: 1, bottom: 1, left: 1 };
        var SIZES = { width: 1, height: 1, 'min-width': 1, 'min-height': 1, 'max-width': 1, 'max-height': 1 };
        var POSITION_PROPS = { 'anchor-name': 1, 'anchor-scope': 1, 'position-anchor': 1, 'position-area': 1, 'inset-area': 1, 'position-try': 1,
            'position-try-fallbacks': 1, 'position-try-options': 1, 'position-try-order': 1, 'position-visibility': 1 };
        var SELF_ALIGN = { 'justify-self': 1, 'align-self': 1, 'place-self': 1, 'justify-items': 1, 'align-items': 1, 'place-items': 1 };
        var SVG_GEOM = { cx: 1, cy: 1, r: 1, rx: 1, ry: 1, x: 1, y: 1, d: 1 };
        var PREFIXED = { transform: 1, 'transform-origin': 1, perspective: 1, filter: 1 };
        var expand = function (vals, n) {
            if (n === 2) return [vals[0], vals.length > 1 ? vals[1] : vals[0]];
            var t = vals[0], r = vals.length > 1 ? vals[1] : t, b = vals.length > 2 ? vals[2] : t, l = vals.length > 3 ? vals[3] : r;
            return [t, r, b, l];
        };
        // [[physical property, value]] for a declaration
        var longhands = function (p, v) {
            if (SHORT[p]) {
                var parts = splitTop(v, ' '), names = SHORT[p], vals = expand(parts, names.length), out = [];
                for (var i = 0; i < names.length; i++) out.push([names[i], vals[i]]);
                return out;
            }
            return [[PHYS[p] || p, v]];
        };
        // ---- inline styles we set, with what the page had, so that a later pass can give it back
        var setProp = function (el, prop, value) {
            if (calcRisk(prop, value)) return;   // (evalValue gives px where it can; a calc left over would crash transitions)
            if (!el.__brDVOrig) { el.__brDVOrig = {}; el.__brDVSet = {}; tracked.push(el); }
            if (!el.__brDVOrig.hasOwnProperty(prop)) el.__brDVOrig[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
            el.__brDVSet[prop] = gen;
            if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value, '');
            if (PREFIXED[prop] && el.style.getPropertyValue('-webkit-' + prop) !== value) setProp(el, '-webkit-' + prop, value);
        };
        var unsetProp = function (el, prop) {   // back to what the page had before we set it
            if (!el.__brDVSet || !el.__brDVSet.hasOwnProperty(prop)) return;
            var o = el.__brDVOrig[prop];
            if (o && o[0]) el.style.setProperty(prop, o[0], o[1]); else el.style.removeProperty(prop);
            delete el.__brDVSet[prop];
            delete el.__brDVOrig[prop];
        };
        var restoreStale = function () {
            for (var i = 0; i < tracked.length; i++) {
                var el = tracked[i], set = el.__brDVSet;
                for (var p in set) {
                    if (!set.hasOwnProperty(p) || set[p] === gen) continue;
                    var o = el.__brDVOrig[p];
                    if (o && o[0]) el.style.setProperty(p, o[0], o[1]); else el.style.removeProperty(p);
                    delete set[p];
                    delete el.__brDVOrig[p];
                }
            }
        };
        // ---- containing block of an absolutely or fixed positioned element, in viewport coordinates
        var containingBlock = function (el) {
            var cs = getComputedStyle(el);
            if (cs.position === 'fixed') return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, viewport: true };
            var op = el.offsetParent;
            if (op && op !== document.documentElement && (op !== document.body || getComputedStyle(op).position !== 'static')) {
                var r = op.getBoundingClientRect();
                return { x: r.left + op.clientLeft - op.scrollLeft, y: r.top + op.clientTop - op.scrollTop, w: op.clientWidth, h: op.clientHeight };
            }
            var de = document.documentElement;
            return { x: -window.pageXOffset, y: -window.pageYOffset, w: de.clientWidth || window.innerWidth, h: de.clientHeight || window.innerHeight, initial: true };
        };
        var rectIn = function (a, cb) {
            var r = a.getBoundingClientRect();
            return { l: r.left - cb.x, t: r.top - cb.y, r: r.right - cb.x, b: r.bottom - cb.y, w: r.width, h: r.height };
        };
        var pctBaseFor = function (el, prop, st) {
            var vertical = /^(top|bottom|height|min-height|max-height)$/.test(prop);
            if (st && st.cb) return vertical ? st.cb.h : st.cb.w;
            var p = el.parentNode;
            if (!p || p.nodeType !== 1) return vertical ? window.innerHeight : window.innerWidth;
            return vertical ? p.clientHeight : p.clientWidth;
        };
        // ---- anchors
        var findAnchor = function (name, el) {
            var list = anchors[name];
            if (!list) return null;
            for (var i = list.length - 1; i >= 0; i--) {   // the last one in tree order wins
                var a = list[i];
                if (a === el || el.contains(a)) continue;
                var blocked = false;
                for (var s = 0; s < scopes.length && !blocked; s++) {
                    var sc = scopes[s];
                    if ((sc.names === 'all' || sc.names.indexOf(name) >= 0) && sc.el.contains(a) && !sc.el.contains(el)) blocked = true;
                }
                if (blocked || getComputedStyle(a).display === 'none') continue;
                return a;
            }
            return null;
        };
        var anchorFor = function (st, name) {
            var n = name || (st.defaultName && /^--/.test(st.defaultName) ? st.defaultName : null);
            if (n) return findAnchor(n, st.el);
            var inv = st.el.__brInvoker;   // implicit anchor: the button that opened this popover
            return inv && inv.nodeType === 1 && document.documentElement.contains(inv) ? inv : null;
        };
        var anchorArgs = function (inner) {
            var comma = topComma(inner), head = trim(comma < 0 ? inner : inner.slice(0, comma)), fb = comma < 0 ? null : trim(inner.slice(comma + 1));
            var toks = head.split(/\s+/), name = null, key = null;
            for (var i = 0; i < toks.length; i++) { if (/^--/.test(toks[i])) name = toks[i]; else if (toks[i]) key = toks[i].toLowerCase(); }
            return { name: name, key: key, fb: fb };
        };
        // anchor() for the inset `side` (top/right/bottom/left)
        var anchorFn = function (inner, side, st) {
            var a = anchorArgs(inner), el = anchorFor(st, a.name);
            if (!el || !a.key || !INSETS[side]) { st.invalid = st.invalid || !el; return a.fb; }
            var axis = side === 'top' || side === 'bottom' ? 'y' : 'x', frac = null, key = a.key, pm;
            if (key === 'top') frac = axis === 'y' ? 0 : null;
            else if (key === 'bottom') frac = axis === 'y' ? 1 : null;
            else if (key === 'left') frac = axis === 'x' ? 0 : null;
            else if (key === 'right') frac = axis === 'x' ? 1 : null;
            else if (key === 'start' || key === 'self-start') frac = 0;
            else if (key === 'end' || key === 'self-end') frac = 1;
            else if (key === 'center') frac = 0.5;
            else if (key === 'inside') frac = side === 'top' || side === 'left' ? 0 : 1;
            else if (key === 'outside') frac = side === 'top' || side === 'left' ? 1 : 0;
            else if ((pm = /^(-?[\d.]+)%$/.exec(key))) frac = parseFloat(pm[1]) / 100;
            if (frac === null) return a.fb;
            var ar = rectIn(el, st.cb), coord = axis === 'y' ? ar.t + frac * ar.h : ar.l + frac * ar.w;
            var value = side === 'top' || side === 'left' ? coord : (axis === 'y' ? st.cb.h : st.cb.w) - coord;
            return round2(value) + 'px';
        };
        var anchorSizeFn = function (inner, prop, st) {
            var a = anchorArgs(inner), el = anchorFor(st, a.name);
            if (!el) { st.invalid = true; return a.fb; }
            var r = el.getBoundingClientRect(), key = a.key;
            if (!key) key = /height|top|bottom/.test(prop) ? 'height' : 'width';
            if (key === 'width' || key === 'inline' || key === 'self-inline') return round2(r.width) + 'px';
            if (key === 'height' || key === 'block' || key === 'self-block') return round2(r.height) + 'px';
            return a.fb;
        };
        // ---- attr(), sibling-index(), sibling-count(), toggle(), container-progress(), calc-size()
        var ATTR_UNIT = /^(%|px|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q|deg|grad|rad|turn|s|ms|hz|khz|dpi|dpcm|dppx|fr)$/;
        var quote = function (t) { return '"' + String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; };
        var attrFn = function (el, inner, prop) {
            var comma = topComma(inner), head = trim(comma < 0 ? inner : inner.slice(0, comma)), fb = comma < 0 ? null : trim(inner.slice(comma + 1));
            var m = /^([\w:.-]+)\s*([\s\S]*)$/.exec(head);
            if (!m) return fb;
            var raw = el.getAttribute(m[1]), type = trim(m[2]).toLowerCase();
            if (raw === null) return fb;
            raw = trim(raw);
            if (!type) return prop === 'content' ? quote(raw) : fb;   // an untyped attr() is a string, which only content takes
            if (type === 'string' || /^type\(\s*<string>\s*\)$/.test(type)) return quote(raw);
            if (ATTR_UNIT.test(type)) return /^-?(\d*\.\d+|\d+)(e[-+]?\d+)?$/.test(raw) ? raw + type : fb;
            var t = /^type\(\s*([\s\S]*)\)$/.exec(type);
            if (!t) return fb;
            var want = t[1].replace(/["'\s]/g, '');
            if (want === '*') return raw;
            if (/^<(number|integer)>$/.test(want) && !/^-?(\d*\.\d+|\d+)(e[-+]?\d+)?$/.test(raw)) return fb;
            if (/^<(length|length-percentage|percentage|angle|time|resolution)>/.test(want) && !/^-?(\d*\.\d+|\d+)(%|[a-z]+)?$/i.test(raw) && !(want.indexOf('auto') >= 0 && raw === 'auto')) {
                if (want.indexOf('+') < 0 && want.indexOf('#') < 0) return fb;
            }
            if (want === '<url>') return 'url(' + quote(raw) + ')';
            return raw;
        };
        var siblingIndex = function (el) { var i = 1; for (var n = el.previousSibling; n; n = n.previousSibling) if (n.nodeType === 1) i++; return i; };
        var siblingCount = function (el) { var p = el.parentNode, c = 0; if (!p) return 1; for (var n = p.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) c++; return c; };
        var toggleFn = function (el, prop, inner) {
            var alts = splitTop(inner, ','), parent = el.parentNode;
            if (!alts.length) return null;
            if (!parent || parent.nodeType !== 1) return alts[0];
            var pv = trim(getComputedStyle(parent).getPropertyValue(prop) || '').toLowerCase();
            for (var i = 0; i < alts.length; i++) if (trim(alts[i]).toLowerCase() === pv) return alts[(i + 1) % alts.length];
            return alts[0];
        };
        var nearestContainer = function (el, name) {
            for (var n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) {
                var cr = ' ' + (getComputedStyle(n).counterReset || '') + ' ';
                if (name ? cr.indexOf(' br-cn-' + name + ' ') >= 0 : cr.indexOf(' br-container ') >= 0) return n;
            }
            return null;
        };
        var containerProgressFn = function (inner, el) {
            var a = splitTop(inner, ',');
            if (a.length !== 3) return null;
            var m = /^([\w-]+)(?:\s+of\s+--([\w-]+))?$/.exec(trim(a[0]).toLowerCase());
            if (!m) return null;
            var c = nearestContainer(el, m[2] || null);
            if (!c) return null;
            var size = /height|block/.test(m[1]) ? c.clientHeight : c.clientWidth;
            var lo = evalLength(a[1], el, size), hi = evalLength(a[2], el, size);
            if (!lo || !hi || hi.n === lo.n) return null;
            return String(Math.round(Math.max(0, Math.min(1, (size - lo.n) / (hi.n - lo.n))) * 10000) / 10000);
        };
        var MEASURE_KEYS = ['width', 'height', 'display', 'white-space', 'min-width', 'max-width', 'min-height', 'max-height'], BOX_DISPLAY = /^-webkit-(inline-)?box$/;
        // The content widths of a pass measured together: every element in its measuring form, one layout, all read,
        // all put back (a layout per element took 4-7 s a pass on theguardian.com, for 108 flex footers of cards).
        // (measureBasis measures one alone the same way)
        var measureWidths = function (recs) {
            var list = [], i, k, it;
            for (i = 0; i < recs.length; i++) {
                var w = recs[i].props.width || recs[i].props['inline-size'];
                if (!w) continue;
                var t = trim(w.v).toLowerCase().replace(/^-(webkit|moz)-/, '');
                if (t !== 'fit-content' && t !== 'max-content' && t !== 'min-content') continue;
                if (t !== 'min-content' && inHorizontalBox(recs[i].el)) continue;
                list.push({ el: recs[i].el, basis: t });
            }
            if (list.length < 2) return;
            for (i = 0; i < list.length; i++) list[i].box = BOX_DISPLAY.test(getComputedStyle(list[i].el).display);
            for (i = 0; i < list.length; i++) {
                it = list[i];
                var style = it.el.style;
                it.saved = [];
                for (k = 0; k < MEASURE_KEYS.length; k++) it.saved.push([style.getPropertyValue(MEASURE_KEYS[k]), style.getPropertyPriority(MEASURE_KEYS[k])]);
                style.setProperty('min-width', '0px', 'important');
                style.setProperty('max-width', 'none', 'important');
                style.setProperty('display', it.box ? '-webkit-inline-box' : 'inline-block', 'important');
                style.setProperty('width', it.basis === 'min-content' ? '0px' : 'auto', 'important');
                if (it.basis === 'max-content') style.setProperty('white-space', 'nowrap', 'important');
            }
            for (i = 0; i < list.length; i++) {
                it = list[i];
                var cs = getComputedStyle(it.el), px = it.basis === 'min-content' ? it.el.scrollWidth : it.el.offsetWidth;
                if (cs.boxSizing !== 'border-box' && cs.webkitBoxSizing !== 'border-box') px -= num(cs.paddingLeft) + num(cs.paddingRight) + num(cs.borderLeftWidth) + num(cs.borderRightWidth);
                it.px = Math.max(0, px);
            }
            for (i = 0; i < list.length; i++) {
                it = list[i];
                for (k = 0; k < MEASURE_KEYS.length; k++) { if (it.saved[k][0]) it.el.style.setProperty(MEASURE_KEYS[k], it.saved[k][0], it.saved[k][1]); else it.el.style.removeProperty(MEASURE_KEYS[k]); }
                it.el.__brFit = { gen: gen, basis: it.basis, px: it.px };
            }
        };
        var measureBasis = function (el, prop, basis) {
            var isX = !/height|block/.test(prop), dim = isX ? 'width' : 'height';
            if (basis === 'any') return 0;
            if (/^calc-size\(/.test(basis)) {
                var nested = replaceFunctions(basis, 'calc-size', function (inner) { return calcSizeFn(inner, el, prop); });
                var nv = nested === null ? null : evalLength(nested, el, pctBaseFor(el, prop, null));
                return nv ? nv.n : null;
            }
            var len = evalLength(basis, el, pctBaseFor(el, prop, null));
            if (len) return len.n;
            var cs0 = getComputedStyle(el);
            if (basis === 'stretch') {
                // the containing block's content size minus this box's margins (and padding and border unless border-box)
                var cb = el.offsetParent || el.parentNode;
                if (!cb || cb.nodeType !== 1) cb = document.documentElement;
                var cbs = getComputedStyle(cb);
                var avail = isX ? cb.clientWidth - num(cbs.paddingLeft) - num(cbs.paddingRight) - num(cs0.marginLeft) - num(cs0.marginRight)
                                : cb.clientHeight - num(cbs.paddingTop) - num(cbs.paddingBottom) - num(cs0.marginTop) - num(cs0.marginBottom);
                if (cs0.boxSizing !== 'border-box' && cs0.webkitBoxSizing !== 'border-box') {
                    avail -= isX ? num(cs0.paddingLeft) + num(cs0.paddingRight) + num(cs0.borderLeftWidth) + num(cs0.borderRightWidth)
                                 : num(cs0.paddingTop) + num(cs0.paddingBottom) + num(cs0.borderTopWidth) + num(cs0.borderBottomWidth);
                }
                return Math.max(0, avail);
            }
            // (measured together with the others of the pass, see measureWidths)
            var fit = el.__brFit;
            if (isX && fit && fit.gen === gen && fit.basis === basis) return fit.px;
            var style = el.style, keys = MEASURE_KEYS, saved = [], k, box = isX && BOX_DISPLAY.test(cs0.display);
            for (k = 0; k < keys.length; k++) saved.push([style.getPropertyValue(keys[k]), style.getPropertyPriority(keys[k])]);
            style.setProperty('min-' + dim, '0px', 'important');
            style.setProperty('max-' + dim, 'none', 'important');
            if (basis === 'stretch') style.setProperty(dim, '-webkit-fill-available', 'important');
            else if (isX && (basis === 'min-content' || basis === 'max-content' || basis === 'fit-content')) {
                // (a box, the stand-in for a flex container, keeps its row: its inline form)
                style.setProperty('display', box ? '-webkit-inline-box' : 'inline-block', 'important');
                style.setProperty(dim, basis === 'min-content' ? '0px' : 'auto', 'important');
                if (basis === 'max-content') style.setProperty('white-space', 'nowrap', 'important');
            } else style.setProperty(dim, 'auto', 'important');
            var cs = getComputedStyle(el), px = isX ? (basis === 'min-content' ? el.scrollWidth : el.offsetWidth) : el.offsetHeight;
            if (cs.boxSizing !== 'border-box' && cs.webkitBoxSizing !== 'border-box') {
                px -= isX ? num(cs.paddingLeft) + num(cs.paddingRight) + num(cs.borderLeftWidth) + num(cs.borderRightWidth)
                          : num(cs.paddingTop) + num(cs.paddingBottom) + num(cs.borderTopWidth) + num(cs.borderBottomWidth);
            }
            for (k = 0; k < keys.length; k++) { if (saved[k][0]) style.setProperty(keys[k], saved[k][0], saved[k][1]); else style.removeProperty(keys[k]); }
            return Math.max(0, px);
        };
        var calcSizeFn = function (inner, el, prop) {
            var comma = topComma(inner);
            if (comma < 0) return null;
            var basis = trim(inner.slice(0, comma)).toLowerCase(), expr = trim(inner.slice(comma + 1));
            if (basis === 'content') basis = 'max-content';
            var px = measureBasis(el, prop, basis);
            if (px === null) return null;
            var e = expr.replace(/(^|[^\w-])size(?![\w-])/gi, function (m0, pre) { return pre + '(' + px + 'px)'; });
            var val = evalLength(e, el, pctBaseFor(el, prop, null));
            return val ? round2(val.n) + (val.u === 'px' ? 'px' : val.u) : 'calc(' + e + ')';
        };
        // ---- mixes driven by a timeline: mix(), calc-mix(), color-mix(), cross-fade() whose progress is scroll(), view()
        // or a named timeline (scroll-timeline-name / view-timeline-name, marked br-stl-<name> / br-vtl-<name>)
        var scrollerOf = function (el, inline) {
            for (var n = el.parentNode; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentNode) {
                var cs = getComputedStyle(n), ov = inline ? cs.overflowX : cs.overflowY;
                if ((ov === 'auto' || ov === 'scroll') && (inline ? n.scrollWidth > n.clientWidth : n.scrollHeight > n.clientHeight)) return n;
            }
            return null;   // the viewport
        };
        var scrollProgressOf = function (sc, inline) {
            var pos, max, de = document.documentElement;
            if (!sc) { max = inline ? de.scrollWidth - window.innerWidth : de.scrollHeight - window.innerHeight; pos = inline ? window.pageXOffset : window.pageYOffset; }
            else { max = inline ? sc.scrollWidth - sc.clientWidth : sc.scrollHeight - sc.clientHeight; pos = inline ? sc.scrollLeft : sc.scrollTop; }
            return max > 0 ? Math.max(0, Math.min(1, pos / max)) : 0;
        };
        var viewProgressOf = function (subject, inline) {   // the "cover" range: entering at the far edge until gone at the near edge
            var sc = scrollerOf(subject, inline), r = subject.getBoundingClientRect(), start = 0, size = inline ? window.innerWidth : window.innerHeight;
            if (sc) { var sr = sc.getBoundingClientRect(); start = inline ? sr.left : sr.top; size = inline ? sc.clientWidth : sc.clientHeight; }
            var pos = (inline ? r.left : r.top) - start, len = inline ? r.width : r.height;
            return Math.max(0, Math.min(1, (size - pos) / (size + len)));
        };
        var timelineProgress = function (spec, el) {
            var m = /^(scroll|view)\(([^)]*)\)$/i.exec(spec);
            if (m) {
                var a = m[2].toLowerCase(), inline = /\b(inline|x)\b/.test(a);
                if (m[1].toLowerCase() === 'view') return viewProgressOf(el, inline);
                return scrollProgressOf(/\broot\b/.test(a) ? null : /\bself\b/.test(a) ? el : scrollerOf(el, inline), inline);
            }
            var name = spec.slice(2);
            for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
                var cr = ' ' + (getComputedStyle(n).counterReset || '') + ' ', inl = cr.indexOf(' br-tl-src-inline ') >= 0;
                if (cr.indexOf(' br-stl-' + name + ' ') >= 0) return scrollProgressOf(n === document.documentElement || n === document.body ? null : n, inl);
                if (cr.indexOf(' br-vtl-' + name + ' ') >= 0) return viewProgressOf(n, inl);
            }
            return null;
        };
        var cubicBezier = function (x1, y1, x2, y2, t) {
            var bx = function (u) { return 3 * x1 * u * (1 - u) * (1 - u) + 3 * x2 * u * u * (1 - u) + u * u * u; };
            var by = function (u) { return 3 * y1 * u * (1 - u) * (1 - u) + 3 * y2 * u * u * (1 - u) + u * u * u; };
            var lo = 0, hi = 1, u = t;
            for (var i = 0; i < 30; i++) { u = (lo + hi) / 2; if (bx(u) < t) lo = u; else hi = u; }
            return by(u);
        };
        var EASINGS = { ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1] };
        var applyEasing = function (e, p) {
            e = trim(e).toLowerCase();
            var m;
            if (EASINGS.hasOwnProperty(e)) return cubicBezier(EASINGS[e][0], EASINGS[e][1], EASINGS[e][2], EASINGS[e][3], p);
            if ((m = /^cubic-bezier\(([^)]*)\)$/.exec(e))) { var cb = m[1].split(','); return cubicBezier(num(cb[0]), num(cb[1]), num(cb[2]), num(cb[3]), p); }
            if ((m = /^steps\(\s*(\d+)\s*(?:,\s*([\w-]+))?\s*\)$/.exec(e))) {
                var n = Math.max(1, parseInt(m[1], 10)), pos = m[2] || 'end', k = Math.floor(p * n);
                if (pos === 'start' || pos === 'jump-start') return Math.min(1, (k + 1) / n);
                if (pos === 'jump-none') return n > 1 ? Math.min(1, k / (n - 1)) : p;
                if (pos === 'jump-both') return Math.min(1, (k + 1) / (n + 1));
                return Math.min(1, k / n);
            }
            if ((m = /^linear\(([^)]*)\)$/.exec(e))) {
                var pts = m[1].split(','), vals = [];
                for (var i = 0; i < pts.length; i++) vals.push(num(trim(pts[i]).split(/\s+/)[0]));
                if (vals.length < 2) return p;
                var x = p * (vals.length - 1), j = Math.min(vals.length - 2, Math.floor(x));
                return vals[j] + (vals[j + 1] - vals[j]) * (x - j);
            }
            return p;
        };
        var probe = null;
        var colorOf = function (c) {
            // (under <html>, after <body>: React 19 hydrates <body> as a singleton and takes elements there for its own)
            if (!probe) { probe = document.createElement('i'); probe.__brOwn = true; probe.style.display = 'none'; document.documentElement.appendChild(probe); }
            probe.style.color = '';
            probe.style.color = c;
            if (!probe.style.color) return null;
            var m = /rgba?\(([^)]*)\)/.exec(getComputedStyle(probe).color);
            if (!m) return null;
            var p = m[1].split(',');
            return [num(p[0]), num(p[1]), num(p[2]), p.length > 3 ? num(p[3]) : 1];
        };
        var TIMELINE_ARG = /^\s*(scroll\([^)]*\)|view\([^)]*\)|--[\w-]+)(?:\s+by\s+([\s\S]*?))?(?:\s+in\s+[\s\S]*)?\s*$/i;
        var mixFn = function (name, inner, el, prop) {
            var args = splitTop(inner, ','), m = TIMELINE_ARG.exec(args[0]);
            if (!m) return name + '(' + inner + ')';   // not a timeline mix: left as it is
            var p = timelineProgress(m[1], el);
            if (p === null || args.length !== 3) return null;
            if (m[2]) p = applyEasing(m[2], p);
            var a = trim(args[1]), b = trim(args[2]);
            if (name === 'cross-fade') return '-webkit-cross-fade(' + a + ', ' + b + ', ' + Math.round(p * 100) + '%)';
            if (name !== 'color-mix') {
                var base = pctBaseFor(el, prop, null), la = evalLength(a, el, base), lb = evalLength(b, el, base);
                if (la && lb && la.u === lb.u) return (Math.round((la.n + (lb.n - la.n) * p) * 10000) / 10000) + la.u;
            }
            if (name !== 'calc-mix') {
                var ca = colorOf(a), cb = colorOf(b);
                if (ca && cb) {
                    var mix = function (i) { return Math.round(ca[i] + (cb[i] - ca[i]) * p); };
                    return 'rgba(' + mix(0) + ',' + mix(1) + ',' + mix(2) + ',' + (Math.round((ca[3] + (cb[3] - ca[3]) * p) * 1000) / 1000) + ')';
                }
            }
            return name === 'mix' ? (p < 0.5 ? a : b) : null;
        };
        var TIMELINE_VALUE = /(^|[^\w-])(mix|calc-mix|color-mix|cross-fade)\(\s*(scroll\(|view\(|--)/i;
        // the value of `prop` for `el` with every element-dependent function computed (st: positioning state or null)
        // intrinsic size keywords (see INTRINSIC_SIZE in cssfix.js): measured like calc-size(<keyword>, size)
        var INTRINSIC = /^(min-content|max-content|fit-content|stretch|-webkit-fill-available|fill-available|-moz-available|-webkit-min-content|-webkit-max-content|-webkit-fit-content|-moz-fit-content|contain)$/i;
        var intrinsicAsCalcSize = function (s) {
            var t = trim(s).toLowerCase(), fc = /^fit-content\(([^()]*)\)$/.exec(t);
            // fit-content(limit): max-content, but no more than the limit and no less than min-content
            if (fc) return 'max(calc-size(min-content, size), min(calc-size(max-content, size), ' + fc[1] + '))';
            if (!INTRINSIC.test(t)) return s;
            t = t.replace(/^-(webkit|moz)-/, '');
            if (t === 'fill-available' || t === 'available' || t === 'contain') t = 'stretch';
            return 'calc-size(' + t + ', size)';
        };
        // an item of a horizontal box (the stand-in for a flex row) is as wide as its content already at width: auto: no
        // measuring (theguardian.com: 126 such items, a layout each, 4-7 s a pass)
        var CONTENT_WIDTH = /^(-webkit-|-moz-)?(fit|max)-content$/i;
        var inHorizontalBox = function (el) {
            var p = el.parentNode;
            if (!p || p.nodeType !== 1) return false;
            var cs = getComputedStyle(p);
            return !!cs && /^-webkit-(inline-)?box$/.test(cs.display) && !/vertical|block-axis/.test(cs.webkitBoxOrient || '');
        };
        var evalValue = function (el, prop, v, st) {
            var s = String(v);
            if ((prop === 'width' || prop === 'inline-size') && CONTENT_WIDTH.test(trim(s)) && inHorizontalBox(el)) return 'auto';
            if (/^(width|height|min-|max-|inline-size|block-size|flex-basis)/.test(prop)) s = intrinsicAsCalcSize(s);
            s = replaceFunctions(s, 'sibling-index', function () { return String(siblingIndex(el)); });
            s = replaceFunctions(s, 'sibling-count', function () { return String(siblingCount(el)); });
            s = replaceFunctions(s, 'attr', function (inner) { return attrFn(el, inner, prop); });
            if (s !== null && /anchor(-size)?\(/i.test(s)) {
                if (!st) return null;   // anchor functions only work on absolutely positioned elements
                s = replaceFunctions(s, 'anchor-size', function (inner) { return anchorSizeFn(inner, prop, st); });
                s = replaceFunctions(s, 'anchor', function (inner) { return anchorFn(inner, prop, st); });
            }
            s = replaceFunctions(s, 'container-progress', function (inner) { return containerProgressFn(inner, el); });
            s = replaceFunctions(s, 'calc-size', function (inner) { return calcSizeFn(inner, el, prop); });
            s = replaceFunctions(s, 'toggle', function (inner) { return toggleFn(el, prop, inner); });
            if (s !== null && TIMELINE_VALUE.test(s)) {
                s = replaceFunctions(s, 'calc-mix', function (inner) { return mixFn('calc-mix', inner, el, prop); });
                s = replaceFunctions(s, 'color-mix', function (inner) { return mixFn('color-mix', inner, el, prop); });
                s = replaceFunctions(s, 'cross-fade', function (inner) { return mixFn('cross-fade', inner, el, prop); });
                s = replaceFunctions(s, 'mix', function (inner) { return mixFn('mix', inner, el, prop); });
            }
            if (s === null) return null;
            var len = evalLength(s, el, pctBaseFor(el, prop, st));
            if (len && (len.u === 'px' || len.u === 'deg' || len.u === 'ms')) {
                if (len.u === 'px' && len.n < 0 && /^(width|height|min-|max-|padding)/.test(prop)) len.n = 0;
                return round2(len.n) + len.u;
            }
            if (len && !len.u) return String(round2(len.n));
            return s.replace(/(^|[^\w-])calc\(/gi, '$1-webkit-calc(');
        };
        // ---- position-area: a 3x3 grid around the anchor inside the containing block
        var AREA_ROW = { top: 's', 'y-start': 's', 'block-start': 's', 'self-block-start': 's', 'y-self-start': 's', bottom: 'e', 'y-end': 'e', 'block-end': 'e',
            'self-block-end': 'e', 'y-self-end': 'e', 'span-top': 'ss', 'span-y-start': 'ss', 'span-block-start': 'ss', 'span-self-block-start': 'ss',
            'span-y-self-start': 'ss', 'span-bottom': 'se', 'span-y-end': 'se', 'span-block-end': 'se', 'span-self-block-end': 'se', 'span-y-self-end': 'se' };
        var AREA_COL = { left: 's', 'x-start': 's', 'inline-start': 's', 'self-inline-start': 's', 'x-self-start': 's', right: 'e', 'x-end': 'e', 'inline-end': 'e',
            'self-inline-end': 'e', 'x-self-end': 'e', 'span-left': 'ss', 'span-x-start': 'ss', 'span-inline-start': 'ss', 'span-self-inline-start': 'ss',
            'span-x-self-start': 'ss', 'span-right': 'se', 'span-x-end': 'se', 'span-inline-end': 'se', 'span-self-inline-end': 'se', 'span-x-self-end': 'se' };
        var AREA_ANY = { start: 's', end: 'e', 'self-start': 's', 'self-end': 'e', 'span-start': 'ss', 'span-end': 'se', 'span-self-start': 'ss', 'span-self-end': 'se',
            center: 'c', 'span-all': 'a' };
        var parseArea = function (v) {
            var toks = trim(v).toLowerCase().split(/\s+/), row = null, col = null, generic = [];
            if (toks.length > 2) return null;
            for (var i = 0; i < toks.length; i++) {
                var t = toks[i];
                if (AREA_ROW.hasOwnProperty(t)) row = AREA_ROW[t];
                else if (AREA_COL.hasOwnProperty(t)) col = AREA_COL[t];
                else if (AREA_ANY.hasOwnProperty(t)) generic.push(AREA_ANY[t]);
                else return null;
            }
            if (generic.length === 2) { row = generic[0]; col = generic[1]; }
            else if (generic.length === 1) { if (row === null && col === null) { row = generic[0]; col = generic[0]; } else if (row === null) row = generic[0]; else col = generic[0]; }
            return { row: row === null ? 'a' : row, col: col === null ? 'a' : col };
        };
        // where the margin box starts along one axis: before the anchor end-aligned, after it start-aligned, over it centred
        var areaPos = function (code, a0, a1, m) {
            if (code === 's') return a0 - m;
            if (code === 'e') return a1;
            if (code === 'ss') return a1 - m;
            if (code === 'se') return a0;
            return (a0 + a1) / 2 - m / 2;
        };
        var FLIP_CODE = { s: 'e', e: 's', ss: 'se', se: 'ss', c: 'c', a: 'a' };
        // ---- one placement: position-area or insets, sizes, margins, anchor-center
        var placementOf = function (props, parentProps) {
            var pl = { area: null, insets: {}, sizes: {}, margins: {}, cx: false, cy: false };
            for (var p in props) {
                if (!props.hasOwnProperty(p)) continue;
                var v = props[p].v, lv = trim(v).toLowerCase();
                if (p === 'position-area' || p === 'inset-area') { if (lv !== 'none' && !isGlobal(lv)) pl.area = parseArea(lv); continue; }
                if (SELF_ALIGN[p]) {
                    if (/anchor-center/.test(lv) && (p === 'justify-self' || p === 'place-self')) pl.cx = true;
                    if (/anchor-center/.test(lv) && (p === 'align-self' || p === 'place-self')) pl.cy = true;
                    continue;
                }
                if (POSITION_PROPS[p]) continue;
                var lh = longhands(p, v);
                for (var i = 0; i < lh.length; i++) {
                    var name = lh[i][0];
                    if (INSETS[name]) pl.insets[name] = lh[i][1];
                    else if (SIZES[name]) pl.sizes[name] = lh[i][1];
                    else if (/^margin-/.test(name)) pl.margins[name] = lh[i][1];
                }
            }
            if (parentProps) {   // justify-items / align-items: anchor-center on the containing element
                for (var q in parentProps) {
                    if (!parentProps.hasOwnProperty(q) || !/anchor-center/.test(parentProps[q].v)) continue;
                    if ((q === 'justify-items' || q === 'place-items') && !props['justify-self'] && !props['place-self']) pl.cx = true;
                    if ((q === 'align-items' || q === 'place-items') && !props['align-self'] && !props['place-self']) pl.cy = true;
                }
            }
            return pl;
        };
        var copyPlacement = function (pl) {
            var out = { area: pl.area, insets: {}, sizes: {}, margins: {}, cx: pl.cx, cy: pl.cy }, k;
            for (k in pl.insets) if (pl.insets.hasOwnProperty(k)) out.insets[k] = pl.insets[k];
            for (k in pl.sizes) if (pl.sizes.hasOwnProperty(k)) out.sizes[k] = pl.sizes[k];
            for (k in pl.margins) if (pl.margins.hasOwnProperty(k)) out.margins[k] = pl.margins[k];
            return out;
        };
        var flipPlacement = function (pl, tactic) {
            var side, kw, k;
            if (tactic === 'flip-block') { side = { top: 'bottom', bottom: 'top' }; kw = { top: 'bottom', bottom: 'top', start: 'end', end: 'start', 'self-start': 'self-end', 'self-end': 'self-start' }; }
            else if (tactic === 'flip-inline') { side = { left: 'right', right: 'left' }; kw = { left: 'right', right: 'left', start: 'end', end: 'start', 'self-start': 'self-end', 'self-end': 'self-start' }; }
            else { side = { top: 'left', left: 'top', bottom: 'right', right: 'bottom' }; kw = { top: 'left', left: 'top', bottom: 'right', right: 'bottom', width: 'height', height: 'width', block: 'inline', inline: 'block', 'self-block': 'self-inline', 'self-inline': 'self-block' }; }
            var flipArgs = function (v) {
                return String(v).replace(/(anchor(?:-size)?\()([^,)]*)/gi, function (m0, fn, args) {
                    return fn + args.replace(/-?[\w.-]+%?/g, function (w) {
                        var lw = w.toLowerCase(), pm = /^(-?[\d.]+)%$/.exec(lw);
                        if (kw.hasOwnProperty(lw)) return kw[lw];
                        if (pm && tactic !== 'flip-start') return (100 - parseFloat(pm[1])) + '%';
                        return w;
                    });
                });
            };
            var out = { area: null, insets: {}, sizes: {}, margins: {}, cx: tactic === 'flip-start' ? pl.cy : pl.cx, cy: tactic === 'flip-start' ? pl.cx : pl.cy, variant: true };
            for (k in pl.insets) if (pl.insets.hasOwnProperty(k)) out.insets[side[k] || k] = flipArgs(pl.insets[k]);
            for (k in pl.sizes) if (pl.sizes.hasOwnProperty(k)) out.sizes[tactic === 'flip-start' ? k.replace(/width|height/, function (d) { return d === 'width' ? 'height' : 'width'; }) : k] = flipArgs(pl.sizes[k]);
            for (k in pl.margins) if (pl.margins.hasOwnProperty(k)) { var mside = k.slice(7); out.margins['margin-' + (side[mside] || mside)] = pl.margins[k]; }
            if (pl.area) {
                if (tactic === 'flip-block') out.area = { row: FLIP_CODE[pl.area.row], col: pl.area.col };
                else if (tactic === 'flip-inline') out.area = { row: pl.area.row, col: FLIP_CODE[pl.area.col] };
                else out.area = { row: pl.area.col, col: pl.area.row };
            }
            return out;
        };
        var applyPlacement = function (st, pl) {
            var el = st.el, k, val;
            st.invalid = false;
            for (k in pl.sizes) if (pl.sizes.hasOwnProperty(k)) { val = evalValue(el, k, pl.sizes[k], st); if (val === null) st.invalid = true; else setProp(el, k, val); }
            for (k in pl.margins) if (pl.margins.hasOwnProperty(k)) { val = evalValue(el, k, pl.margins[k], st); if (val !== null) setProp(el, k, val); }
            var cs = getComputedStyle(el);
            if (pl.area) {
                var a = anchorFor(st, null);
                if (a) {
                    var ar = rectIn(a, st.cb);
                    var mw = el.offsetWidth + num(cs.marginLeft) + num(cs.marginRight), mh = el.offsetHeight + num(cs.marginTop) + num(cs.marginBottom);
                    setProp(el, 'left', round2(areaPos(pl.area.col, ar.l, ar.r, mw)) + 'px');
                    setProp(el, 'top', round2(areaPos(pl.area.row, ar.t, ar.b, mh)) + 'px');
                    setProp(el, 'right', 'auto');
                    setProp(el, 'bottom', 'auto');
                } else st.invalid = true;
            }
            for (k in pl.insets) {
                if (!pl.insets.hasOwnProperty(k) || pl.area) continue;
                val = evalValue(el, k, pl.insets[k], st);
                if (val === null) st.invalid = true; else setProp(el, k, val);
            }
            if (!pl.area) {
                // sides this placement does not name: auto in a fallback option, the page's own value otherwise
                for (k in INSETS) {
                    if (!INSETS.hasOwnProperty(k) || pl.insets.hasOwnProperty(k)) continue;
                    if (pl.variant) setProp(el, k, 'auto'); else unsetProp(el, k);
                }
            }
            if (pl.cx || pl.cy) {
                var ca = anchorFor(st, null);
                if (ca) {
                    var cr = rectIn(ca, st.cb);
                    if (pl.cx) { setProp(el, 'left', round2((cr.l + cr.r) / 2 - (el.offsetWidth + num(cs.marginLeft) + num(cs.marginRight)) / 2) + 'px'); setProp(el, 'right', 'auto'); }
                    if (pl.cy) { setProp(el, 'top', round2((cr.t + cr.b) / 2 - (el.offsetHeight + num(cs.marginTop) + num(cs.marginBottom)) / 2) + 'px'); setProp(el, 'bottom', 'auto'); }
                }
            }
        };
        var overflows = function (st) {
            var r = st.el.getBoundingClientRect(), cb = st.cb;
            var box = cb.initial || cb.viewport ? { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight } : { l: cb.x, t: cb.y, r: cb.x + cb.w, b: cb.y + cb.h };
            return r.left < box.l - 1 || r.top < box.t - 1 || r.right > box.r + 1 || r.bottom > box.b + 1;
        };
        // space the placement leaves the element in the containing block, for position-try-order
        var available = function (st, order) {
            var s = st.el.style;
            if (order === 'most-width' || order === 'most-inline-size') return st.cb.w - num(s.left) - num(s.right);
            return st.cb.h - num(s.top) - num(s.bottom);
        };
        var optionPlacement = function (base, opt) {
            var toks = trim(opt).split(/\s+/), named = null, tactics = [], area = [], pl = base, i;
            for (i = 0; i < toks.length; i++) {
                var t = toks[i], lt = t.toLowerCase();
                if (/^--/.test(t)) named = t;
                else if (/^flip-(block|inline|start)$/.test(lt)) tactics.push(lt);
                else area.push(lt);
            }
            if (area.length) {
                var parsed = parseArea(area.join(' '));
                if (!parsed || named || tactics.length) return null;
                pl = copyPlacement(base);
                pl.area = parsed;
                pl.insets = {};
                pl.variant = true;
                return pl;
            }
            if (named) {
                var decls = tryRules[named];
                if (!decls) return null;
                var props = {};
                for (i = 0; i < decls.length; i++) props[decls[i][0]] = { v: decls[i][1] };
                var over = placementOf(props, null);
                pl = copyPlacement(base);
                pl.variant = true;
                var k;
                if (over.area || props['position-area']) { pl.area = over.area; pl.insets = {}; }
                for (k in over.insets) if (over.insets.hasOwnProperty(k)) { pl.insets[k] = over.insets[k]; pl.area = null; }
                for (k in over.sizes) if (over.sizes.hasOwnProperty(k)) pl.sizes[k] = over.sizes[k];
                for (k in over.margins) if (over.margins.hasOwnProperty(k)) pl.margins[k] = over.margins[k];
                if (over.cx) pl.cx = true;
                if (over.cy) pl.cy = true;
            }
            for (i = 0; i < tactics.length; i++) pl = flipPlacement(pl, tactics[i]);
            return pl;
        };
        var positionElement = function (rec) {
            var el = rec.el, props = rec.props, ecs = getComputedStyle(el);
            // anchor functions and position-area only apply to absolutely and fixed positioned boxes
            if (ecs.display === 'none' || (ecs.position !== 'absolute' && ecs.position !== 'fixed')) return;
            var pa = props['position-anchor'] ? trim(props['position-anchor'].v) : 'auto';
            var st = { el: el, cb: containingBlock(el), defaultName: /^--/.test(pa) ? pa : null, invalid: false };
            var parentRec = el.parentNode && el.parentNode.__brDV && el.parentNode.__brDV.gen === recGen ? el.parentNode.__brDV.props : null;
            var base = placementOf(props, parentRec);
            // position-try: <order>? <fallbacks>; position-try-fallbacks / position-try-options; position-try-order
            var order = props['position-try-order'] ? trim(props['position-try-order'].v).toLowerCase() : 'normal', fbv = null;
            if (props['position-try']) {
                var ptv = trim(props['position-try'].v), om = /^(normal|most-width|most-height|most-block-size|most-inline-size)\s*(.*)$/i.exec(ptv);
                if (om) { order = om[1].toLowerCase(); fbv = om[2]; } else fbv = ptv;
            }
            if (props['position-try-fallbacks']) fbv = props['position-try-fallbacks'].v;
            else if (props['position-try-options']) fbv = props['position-try-options'].v;
            applyPlacement(st, base);
            var chosenInvalid = st.invalid;
            if (fbv && !/^\s*(none|normal)?\s*$/i.test(fbv) && (overflows(st) || order !== 'normal')) {
                var opts = splitTop(fbv, ','), candidates = [], i;
                for (i = 0; i < opts.length; i++) { var op = optionPlacement(base, opts[i]); if (op) candidates.push(op); }
                var winner = null;
                if (order !== 'normal') {
                    var bestSpace = available(st, order);
                    winner = base;
                    for (i = 0; i < candidates.length; i++) {
                        applyPlacement(st, candidates[i]);
                        var sp = available(st, order);
                        if (!overflows(st) && sp > bestSpace) { bestSpace = sp; winner = candidates[i]; }
                    }
                } else {
                    for (i = 0; i < candidates.length && !winner; i++) { applyPlacement(st, candidates[i]); if (!overflows(st) && !st.invalid) winner = candidates[i]; }
                }
                applyPlacement(st, winner || base);
                chosenInvalid = st.invalid;
            }
            // position-visibility
            var vis = props['position-visibility'] ? trim(props['position-visibility'].v).toLowerCase() : 'always', hide = false;
            if (vis.indexOf('anchors-valid') >= 0 && chosenInvalid) hide = true;
            if (vis.indexOf('anchors-visible') >= 0) {
                var an = anchorFor(st, null);
                if (an) {
                    var r = an.getBoundingClientRect();
                    if ((!r.width && !r.height) || r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) hide = true;
                }
            }
            if (vis.indexOf('no-overflow') >= 0 && overflows(st)) hide = true;
            if (hide) setProp(el, 'visibility', 'hidden');
        };
        // ---- the other deferred properties
        var fieldSizing = function (el, mode) {
            var tag = el.tagName;
            if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return;
            el.__brFieldSizing = mode === 'content';
            if (!el.__brFieldSizing || el.__brFieldSize) { if (el.__brFieldSize) el.__brFieldSize(); return; }
            var resize = el.__brFieldSize = function () {
                if (!el.__brFieldSizing) return;
                if (el.tagName === 'TEXTAREA') {
                    el.style.height = 'auto';
                    el.style.overflow = 'hidden';
                    el.style.height = el.scrollHeight + 'px';
                    return;
                }
                var cs = getComputedStyle(el), probe = document.createElement('span');
                probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0;font:' + cs.font + ';letter-spacing:' + cs.letterSpacing + ';text-transform:' + cs.textTransform;
                probe.textContent = el.value || el.getAttribute('placeholder') || ' ';
                (document.body || document.documentElement).appendChild(probe);
                var w = probe.offsetWidth + num(cs.paddingLeft) + num(cs.paddingRight) + num(cs.borderLeftWidth) + num(cs.borderRightWidth) + 4;
                probe.parentNode.removeChild(probe);
                el.style.width = Math.ceil(w) + 'px';
            };
            el.addEventListener('input', resize, false);
            el.addEventListener('change', resize, false);
            resize();
        };
        var svgGeometry = function (el, p, v) {
            if (el.namespaceURI !== SVGNS) return;
            var val = evalValue(el, p, v, null);
            if (val === null) return;
            val = trim(val);
            if (!val || isGlobal(val.toLowerCase())) return;
            if (p === 'd') {
                var m = /^path\(\s*(["'])([\s\S]*)\1\s*\)$/i.exec(val);
                if (m) el.setAttribute('d', m[2]); else if (val.toLowerCase() === 'none') el.removeAttribute('d');
                return;
            }
            if (val.toLowerCase() === 'auto') el.removeAttribute(p); else el.setAttribute(p, val);
        };
        // ---- CSS Borders 4 box painter: corner shapes (superellipses), border-shape, border-clip, border-limit. The box
        // becomes two SVGs: its outline as the element's mask and its border as a background layer above the element's
        // own backgrounds; the engine's border keeps its widths (the layout) but becomes transparent.
        var BOX_PAINT = /^(corner-.*-?shape|border-shape|border-limit|border-clip(-.*)?)$/;
        var CORNER_K = { round: 1, scoop: -1, bevel: 0, notch: -Infinity, square: Infinity, squircle: 2 };
        var cornerK = function (tok) {
            tok = trim(tok).toLowerCase();
            if (CORNER_K.hasOwnProperty(tok)) return CORNER_K[tok];
            var m = /^superellipse\(\s*(-?infinity|[+-]?\d*\.?\d+)\s*\)$/.exec(tok);
            if (!m) return null;
            return m[1] === 'infinity' ? Infinity : m[1] === '-infinity' ? -Infinity : parseFloat(m[1]);
        };
        // which corners [tl, tr, br, bl] a corner property sets, and how its 1-4 values spread over them
        var CORNER_TARGETS = { 'corner-shape': [0, 1, 2, 3], 'corner-top-shape': [0, 1], 'corner-right-shape': [1, 2], 'corner-bottom-shape': [3, 2],
            'corner-left-shape': [0, 3], 'corner-block-start-shape': [0, 1], 'corner-block-end-shape': [3, 2], 'corner-inline-start-shape': [0, 3],
            'corner-inline-end-shape': [1, 2], 'corner-top-left-shape': [0], 'corner-top-right-shape': [1], 'corner-bottom-right-shape': [2],
            'corner-bottom-left-shape': [3], 'corner-start-start-shape': [0], 'corner-start-end-shape': [1], 'corner-end-end-shape': [2], 'corner-end-start-shape': [3] };
        var cornerShapes = function (props) {
            var ks = [1, 1, 1, 1], win = [null, null, null, null], any = false;
            var better = function (a, b) { return !b || (a.imp && !b.imp) || (!!a.imp === !!b.imp && (a.spec > b.spec || (a.spec === b.spec && a.order >= b.order))); };
            for (var p in props) {
                if (!props.hasOwnProperty(p) || !CORNER_TARGETS[p]) continue;
                var targets = CORNER_TARGETS[p], vals = splitTop(trim(props[p].v), ' '), spread;
                if (targets.length === 4) spread = [vals[0], vals[1] || vals[0], vals[2] || vals[0], vals[3] || vals[1] || vals[0]];
                else if (targets.length === 2) spread = [vals[0], vals[1] || vals[0]];
                else spread = [vals[0]];
                for (var i = 0; i < targets.length; i++) {
                    var k = cornerK(spread[i] || ''), c = targets[i];
                    if (k === null || !better(props[p], win[c])) continue;
                    ks[c] = k; win[c] = props[p]; any = true;
                }
            }
            return any ? ks : null;
        };
        var BOX_MANAGED = ['-webkit-mask-image', '-webkit-mask-size', '-webkit-mask-repeat', '-webkit-mask-position', '-webkit-mask-origin', '-webkit-mask-clip',
            'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
            'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
            'background-image', 'background-size', 'background-position', 'background-repeat', 'background-origin', 'background-clip'];
        var f1 = function (n) { return Math.round(n * 10) / 10; };
        // points of one corner from (u = 0, v = ry) to (u = rx, v = 0) in the corner's own axes, mapped into the box
        var cornerPoints = function (cx, cy, dx, dy, rx, ry, k, reverse) {
            var pts = [];
            if (rx <= 0.01 || ry <= 0.01) pts.push([0, 0]);
            else if (k === Infinity) pts.push([0, ry], [0, 0], [rx, 0]);
            else if (k === -Infinity) pts.push([0, ry], [rx, ry], [rx, 0]);
            else {
                var e = Math.pow(2, Math.abs(k)), n = k === 0 ? 1 : 20;
                for (var i = 0; i <= n; i++) {
                    var t = i / n * Math.PI / 2, c = Math.pow(Math.cos(t), 2 / e), s = Math.pow(Math.sin(t), 2 / e);
                    pts.push(k >= 0 ? [rx - rx * c, ry - ry * s] : [rx * s, ry * c]);
                }
            }
            var out = [];
            for (var j = 0; j < pts.length; j++) out.push([cx + dx * pts[j][0], cy + dy * pts[j][1]]);
            if (reverse) out.reverse();
            return out;
        };
        // the outline of a box (x0, y0, x1, y1) with radii [[rx, ry] x 4] and corner shapes, clockwise from the top-left
        var boxPath = function (x0, y0, x1, y1, r, ks) {
            var pts = [].concat(
                cornerPoints(x0, y0, 1, 1, r[0][0], r[0][1], ks[0], false),
                cornerPoints(x1, y0, -1, 1, r[1][0], r[1][1], ks[1], true),
                cornerPoints(x1, y1, -1, -1, r[2][0], r[2][1], ks[2], false),
                cornerPoints(x0, y1, 1, -1, r[3][0], r[3][1], ks[3], true));
            var d = 'M' + f1(pts[0][0]) + ' ' + f1(pts[0][1]);
            for (var i = 1; i < pts.length; i++) d += 'L' + f1(pts[i][0]) + ' ' + f1(pts[i][1]);
            return d + 'Z';
        };
        var radiusPair = function (v, w, h) {
            var parts = trim(v || '0').split(/\s+/), conv = function (s, base) { return /%$/.test(s) ? parseFloat(s) * base / 100 : num(s); };
            return [conv(parts[0], w), conv(parts.length > 1 ? parts[1] : parts[0], h)];
        };
        // visible intervals of one side from border-clip ("10px 20px 1fr": alternately drawn and not, from the start)
        var clipIntervals = function (v, len) {
            var toks = splitTop(trim(v || 'normal').toLowerCase(), ' ');
            if (!toks.length || toks[0] === 'normal') return null;
            var fixed = 0, frs = 0, sizes = [], i, pos = 0, out = [];
            for (i = 0; i < toks.length; i++) {
                var m = /^(\d*\.?\d+)(px|%|fr|em|rem)?$/.exec(toks[i]);
                var sz = { fr: 0, px: 0 };
                if (m && m[2] === 'fr') { sz.fr = parseFloat(m[1]); frs += sz.fr; }
                else if (m && m[2] === '%') sz.px = parseFloat(m[1]) * len / 100;
                else if (m && (m[2] === 'em' || m[2] === 'rem')) sz.px = parseFloat(m[1]) * 16;
                else if (m) sz.px = parseFloat(m[1]);
                fixed += sz.px;
                sizes.push(sz);
            }
            var free = Math.max(0, len - fixed);
            for (i = 0; i < sizes.length && pos < len; i++) {
                var l = sizes[i].fr ? free * sizes[i].fr / frs : sizes[i].px;
                if (i % 2 === 0) out.push([pos, Math.min(len, pos + l)]);
                pos += l;
            }
            if (!frs && pos < len && sizes.length % 2 === 0) out.push([pos, len]);   // an even list repeats: the rest is drawn
            return out;
        };
        var paintBox = function (el, props) {
            var ks = cornerShapes(props) || [1, 1, 1, 1];
            var shapeV = props['border-shape'] ? trim(props['border-shape'].v).toLowerCase() : 'none';
            var limitV = props['border-limit'] ? trim(props['border-limit'].v).toLowerCase() : 'all';
            var clips = {}, sides = ['top', 'right', 'bottom', 'left'], logical = { 'block-start': 'top', 'inline-end': 'right', 'block-end': 'bottom', 'inline-start': 'left' };
            if (props['border-clip']) for (var s0 = 0; s0 < 4; s0++) clips[sides[s0]] = props['border-clip'];
            for (var lp in logical) if (logical.hasOwnProperty(lp) && props['border-clip-' + lp]) clips[logical[lp]] = props['border-clip-' + lp];
            for (var s1 = 0; s1 < 4; s1++) if (props['border-clip-' + sides[s1]]) clips[sides[s1]] = props['border-clip-' + sides[s1]];
            // the page's own box, without what an earlier pass set
            for (var u = 0; u < BOX_MANAGED.length; u++) unsetProp(el, BOX_MANAGED[u]);
            var cs = getComputedStyle(el), w = el.offsetWidth, h = el.offsetHeight;
            if (!w || !h) return;
            var bw = [], bc = [];
            for (var s = 0; s < 4; s++) {
                var st = cs.getPropertyValue('border-' + sides[s] + '-style');
                bw.push(st === 'none' || st === 'hidden' ? 0 : num(cs.getPropertyValue('border-' + sides[s] + '-width')));
                bc.push(cs.getPropertyValue('border-' + sides[s] + '-color'));
            }
            var r = [radiusPair(cs.borderTopLeftRadius, w, h), radiusPair(cs.borderTopRightRadius, w, h), radiusPair(cs.borderBottomRightRadius, w, h), radiusPair(cs.borderBottomLeftRadius, w, h)];
            // radii that do not fit are scaled down together (CSS Backgrounds)
            var fit = Math.min(1, w / Math.max(1e-6, r[0][0] + r[1][0]), w / Math.max(1e-6, r[3][0] + r[2][0]), h / Math.max(1e-6, r[0][1] + r[3][1]), h / Math.max(1e-6, r[1][1] + r[2][1]));
            if (fit < 1) for (var ri = 0; ri < 4; ri++) { r[ri][0] *= fit; r[ri][1] *= fit; }
            var outer, inner;
            if (shapeV !== 'none' && shapeV.indexOf('(') > 0) {
                outer = shapePath(shapeV, w, h);
                if (!outer) return;
                inner = null;
            } else {
                outer = boxPath(0, 0, w, h, r, ks);
                var ir = [[Math.max(0, r[0][0] - bw[3]), Math.max(0, r[0][1] - bw[0])], [Math.max(0, r[1][0] - bw[1]), Math.max(0, r[1][1] - bw[0])],
                          [Math.max(0, r[2][0] - bw[1]), Math.max(0, r[2][1] - bw[2])], [Math.max(0, r[3][0] - bw[3]), Math.max(0, r[3][1] - bw[2])]];
                inner = boxPath(bw[3], bw[0], w - bw[1], h - bw[2], ir, ks);
            }
            var svg = function (body) { return 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + body + '</svg>') + '")'; };
            // the border: the ring between the outlines (or the shape's stroke), per side when colours, clips or limits differ
            var ringD = inner ? outer + inner : outer, strokeW = Math.max(bw[0], bw[1], bw[2], bw[3]);
            var drawRing = function (color) { return inner ? '<path d="' + ringD + '" fill-rule="evenodd" fill="' + color + '"/>' : '<path d="' + outer + '" fill="none" stroke="' + color + '" stroke-width="' + strokeW + '"/>'; };
            var tri = { top: '0,0 ' + w + ',0 ' + w / 2 + ',' + h / 2, right: w + ',0 ' + w + ',' + h + ' ' + w / 2 + ',' + h / 2,
                        bottom: w + ',' + h + ' 0,' + h + ' ' + w / 2 + ',' + h / 2, left: '0,' + h + ' 0,0 ' + w / 2 + ',' + h / 2 };
            var limit = /^(all|(sides|corners)(\s+(\S+))?|(top|right|bottom|left)\s+(\S+))$/.exec(limitV) || ['all', 'all'];
            var defs = '', body = '', sameColor = bc[0] === bc[1] && bc[1] === bc[2] && bc[2] === bc[3], plain = sameColor && limit[1] === 'all';
            for (var side in clips) if (clips.hasOwnProperty(side)) plain = false;
            if (plain) body = drawRing(bc[0]);
            else {
                for (var si = 0; si < 4; si++) {
                    var sd = sides[si], len = si % 2 ? h : w, horizontal = si % 2 === 0, vis = [[0, len]];
                    var rStart = horizontal ? r[si === 0 ? 0 : 3][0] : r[si === 1 ? 1 : 0][1], rEnd = horizontal ? r[si === 0 ? 1 : 2][0] : r[si === 1 ? 2 : 3][1];
                    var lim = function (v, base) { return v === undefined ? null : (/%$/.test(v) ? parseFloat(v) * base / 100 : evalLength(v, el, base) ? evalLength(v, el, base).n : num(v)); };
                    if (limit[2] === 'sides') { var sl = lim(limit[4], len); var a = sl === null ? rStart : (len - sl) / 2, b = sl === null ? len - rEnd : (len + sl) / 2; vis = [[a, b]]; }
                    else if (limit[2] === 'corners') { var cl = lim(limit[4], len); vis = [[0, rStart + (cl || 0)], [len - rEnd - (cl || 0), len]]; }
                    else if (limit[5]) { var tl2 = lim(limit[6], len); vis = limit[5] === sd ? [[(len - tl2) / 2, (len + tl2) / 2]] : []; }
                    if (clips[sd]) { var ci = clipIntervals(clips[sd].v, len); if (ci) vis = ci; }
                    if (!vis.length) continue;
                    var rects = '';
                    for (var vi = 0; vi < vis.length; vi++) {
                        var p0 = vis[vi][0], p1 = vis[vi][1];
                        if (p1 <= p0) continue;
                        rects += horizontal ? '<rect x="' + f1(p0) + '" y="0" width="' + f1(p1 - p0) + '" height="' + h + '"/>' : '<rect x="0" y="' + f1(p0) + '" width="' + w + '" height="' + f1(p1 - p0) + '"/>';
                    }
                    defs += '<clipPath id="s' + si + '"><polygon points="' + tri[sd] + '"/></clipPath><clipPath id="v' + si + '">' + rects + '</clipPath>';
                    body += '<g clip-path="url(#s' + si + ')"><g clip-path="url(#v' + si + ')">' + drawRing(bc[si]) + '</g></g>';
                }
            }
            var ringImage = svg((defs ? '<defs>' + defs + '</defs>' : '') + body);
            var maskImage = svg(inner ? '<path d="' + outer + '" fill="#000"/>' : '<path d="' + outer + '" fill="#000" stroke="#000" stroke-width="' + strokeW + '"/>');
            // the border layer goes above the element's own background layers
            var layers = function (prop, ours) { var cur = cs.getPropertyValue(prop); return cur && cur !== 'none' && cs.backgroundImage !== 'none' ? ours + ', ' + cur : ours; };
            setProp(el, 'background-image', layers('background-image', ringImage));
            setProp(el, 'background-size', layers('background-size', w + 'px ' + h + 'px'));
            setProp(el, 'background-position', layers('background-position', '0px 0px'));
            setProp(el, 'background-repeat', layers('background-repeat', 'no-repeat'));
            setProp(el, 'background-origin', layers('background-origin', 'border-box'));
            setProp(el, 'background-clip', layers('background-clip', 'border-box'));
            for (var c2 = 0; c2 < 4; c2++) setProp(el, 'border-' + sides[c2] + '-color', 'transparent');
            setProp(el, 'border-top-left-radius', '0px'); setProp(el, 'border-top-right-radius', '0px');
            setProp(el, 'border-bottom-right-radius', '0px'); setProp(el, 'border-bottom-left-radius', '0px');
            setProp(el, '-webkit-mask-image', maskImage);
            setProp(el, '-webkit-mask-size', w + 'px ' + h + 'px');
            setProp(el, '-webkit-mask-repeat', 'no-repeat');
            setProp(el, '-webkit-mask-position', '0px 0px');
            setProp(el, '-webkit-mask-origin', 'border-box');
            setProp(el, '-webkit-mask-clip', 'border-box');
        };
        // border-shape: a basic shape in the border box as an SVG path
        var shapePath = function (v, w, h) {
            var m = /^(inset|circle|ellipse|polygon|path|rect|xywh)\(([\s\S]*)\)/.exec(v);
            if (!m) return null;
            var args = m[2], len = function (s, base) { s = trim(s); return /%$/.test(s) ? parseFloat(s) * base / 100 : num(s); };
            var pos = function (s) {   // "at x y" -> [x, y]
                var at = /\bat\s+(.+)$/.exec(s), t = at ? trim(at[1]).split(/\s+/) : ['center'];
                var kw = { left: 0, center: 50, right: 100, top: 0, bottom: 100 };
                var xs = t[0], ys = t[1] || 'center';
                if (xs === 'top' || xs === 'bottom') { var tmp = xs; xs = ys; ys = tmp; }
                return [kw.hasOwnProperty(xs) ? kw[xs] * w / 100 : len(xs, w), kw.hasOwnProperty(ys) ? kw[ys] * h / 100 : len(ys, h)];
            };
            switch (m[1]) {
                case 'inset': case 'rect': case 'xywh': {
                    var parts = args.split(/\s+round\s+/), n = trim(parts[0]).split(/\s+/), x0, y0, x1, y1;
                    if (m[1] === 'inset') { var e = [n[0], n[1] || n[0], n[2] || n[0], n[3] || n[1] || n[0]]; y0 = len(e[0], h); x1 = w - len(e[1], w); y1 = h - len(e[2], h); x0 = len(e[3], w); }
                    else if (m[1] === 'rect') { y0 = len(n[0], h); x1 = n[1] === 'auto' ? w : len(n[1], w); y1 = n[2] === 'auto' ? h : len(n[2], h); x0 = n[3] === 'auto' ? 0 : len(n[3], w); }
                    else { x0 = len(n[0], w); y0 = len(n[1], h); x1 = x0 + len(n[2], w); y1 = y0 + len(n[3], h); }
                    var rr = parts[1] ? trim(parts[1]).split(/\s+/) : ['0'], ra = [rr[0], rr[1] || rr[0], rr[2] || rr[0], rr[3] || rr[1] || rr[0]], bw2 = x1 - x0, bh2 = y1 - y0;
                    return boxPath(x0, y0, x1, y1, [[len(ra[0], bw2), len(ra[0], bh2)], [len(ra[1], bw2), len(ra[1], bh2)], [len(ra[2], bw2), len(ra[2], bh2)], [len(ra[3], bw2), len(ra[3], bh2)]], [1, 1, 1, 1]);
                }
                case 'circle': case 'ellipse': {
                    var c = pos(args), radii = trim(args.replace(/\bat\s+.+$/, '')).split(/\s+/), dd = function (s, base) { return s === 'closest-side' || !s ? null : len(s, base); };
                    var rx = dd(radii[0], w), ry = m[1] === 'circle' ? rx : dd(radii[1], h);
                    if (rx === null) rx = m[1] === 'circle' ? Math.min(c[0], w - c[0], c[1], h - c[1]) : Math.min(c[0], w - c[0]);
                    if (ry === null) ry = m[1] === 'circle' ? rx : Math.min(c[1], h - c[1]);
                    return 'M' + f1(c[0] - rx) + ' ' + f1(c[1]) + 'A' + f1(rx) + ' ' + f1(ry) + ' 0 1 0 ' + f1(c[0] + rx) + ' ' + f1(c[1]) + 'A' + f1(rx) + ' ' + f1(ry) + ' 0 1 0 ' + f1(c[0] - rx) + ' ' + f1(c[1]) + 'Z';
                }
                case 'polygon': {
                    var list = args.replace(/^\s*(nonzero|evenodd)\s*,/, '').split(','), d = '';
                    for (var i = 0; i < list.length; i++) { var xy = trim(list[i]).split(/\s+/); d += (i ? 'L' : 'M') + f1(len(xy[0], w)) + ' ' + f1(len(xy[1], h)); }
                    return d + 'Z';
                }
                case 'path': { var q = /["']([^"']*)["']/.exec(args); return q ? q[1] : null; }
            }
            return null;
        };
        // ---- Gap decorations: rules in the gaps between the columns and rows of multi-column, flex and grid containers,
        // drawn as an SVG background layer under the items (value lists with repeat(), rule-break, rule-outset,
        // rule-paint-order). A plain column rule of a multi-column container stays the engine's own.
        var GAP_PAINT = /^((column|row)-rule|rule)(-(color|style|width|break|outset))?$|^rule-paint-order$/;
        var GAP_W = { thin: 1, medium: 3, thick: 5 };
        // the cascade winner among the given properties (they are separate entries in the record)
        var winner = function (props, names) {
            var best = null;
            for (var i = 0; i < names.length; i++) {
                var c = props[names[i]];
                if (c && (!best || (c.imp && !best.imp) || (!!c.imp === !!best.imp && (c.spec > best.spec || (c.spec === best.spec && c.order >= best.order))))) best = c;
            }
            return best;
        };
        // "red repeat(2, lime blue) repeat(auto, ...)" -> {lead: [...], auto: [...] or null, tail: [...]}
        var gapItems = function (v, rule) {
            var toks = splitTop(trim(v), ' '), lead = [], tail = [], auto = null, pending = [];
            var push = function (x) { (auto ? tail : lead).push(x); };
            var flush = function () { if (pending.length) { push(pending.join(' ')); pending = []; } };
            for (var i = 0; i < toks.length; i++) {
                var m = /^repeat\(\s*(auto|\d+)\s*,([\s\S]*)\)$/i.exec(toks[i]);
                if (m) {
                    flush();
                    var inner = rule ? splitTop(m[2], ',') : splitTop(trim(m[2]), ' ');
                    for (var k = 0; k < inner.length; k++) inner[k] = trim(inner[k]);
                    if (m[1].toLowerCase() === 'auto') auto = inner;
                    else for (var n = 0; n < parseInt(m[1], 10); n++) for (var q = 0; q < inner.length; q++) push(inner[q]);
                } else if (rule) { if (/,$/.test(toks[i])) { pending.push(toks[i].slice(0, -1)); flush(); } else pending.push(toks[i]); }
                else push(toks[i]);
            }
            flush();
            return { lead: lead, auto: auto, tail: tail };
        };
        var gapValueAt = function (items, i, n) {
            if (!items) return null;
            var lead = items.lead, tail = items.tail, auto = items.auto;
            if (!auto) { var all = lead.concat(tail); return all.length ? all[i % all.length] : null; }
            if (i < lead.length) return lead[i];
            if (i >= n - tail.length) return tail[i - (n - tail.length)];
            return auto.length ? auto[(i - lead.length) % auto.length] : null;
        };
        // width, style and colour lists of one direction ("column" or "row")
        var gapRules = function (props, dir, cs, native) {
            var pick = function (part) {
                var own = winner(props, [dir + '-rule-' + part, dir + '-rule', 'rule-' + part, 'rule']);
                if (!own) return native ? { lead: [native[part]], auto: null, tail: [] } : null;
                var isShort = own === props[dir + '-rule'] || own === props.rule;
                if (!isShort) return gapItems(own.v, false);
                // a shorthand: the part of each rule
                var rules = gapItems(own.v, true), take = function (list) {
                    var out = [];
                    for (var i = 0; list && i < list.length; i++) {
                        var t = splitTop(list[i], ' '), val = part === 'width' ? 'medium' : part === 'style' ? 'none' : 'currentcolor';
                        for (var k = 0; k < t.length; k++) {
                            var lt = t[k].toLowerCase();
                            if (part === 'width' && (GAP_W[lt] || /^\d*\.?\d+(px|em|rem|%|pt)$|^0$/.test(lt))) val = t[k];
                            else if (part === 'style' && /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/.test(lt)) val = lt;
                            else if (part === 'color' && !GAP_W[lt] && !/^\d*\.?\d+(px|em|rem|%|pt)$|^0$/.test(lt) && !/^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/.test(lt)) val = t[k];
                        }
                        out.push(val);
                    }
                    return out;
                };
                return { lead: take(rules.lead), auto: rules.auto ? take(rules.auto) : null, tail: take(rules.tail) };
            };
            return { width: pick('width'), style: pick('style'), color: pick('color') };
        };
        var gapLine = function (x1, y1, x2, y2, width, style, color) {
            if (!width || style === 'none' || style === 'hidden') return '';
            var dash = style === 'dashed' ? ' stroke-dasharray="' + width * 3 + ' ' + width * 3 + '"' : style === 'dotted' ? ' stroke-dasharray="0.01 ' + width * 2 + '" stroke-linecap="round"' : '';
            if (style === 'double' && width >= 3) {
                var t = width / 3, dx = x1 === x2 ? t : 0, dy = y1 === y2 ? t : 0;
                return gapLine(x1 - dx, y1 - dy, x2 - dx, y2 - dy, t, 'solid', color) + gapLine(x1 + dx, y1 + dy, x2 + dx, y2 + dy, t, 'solid', color);
            }
            return '<line x1="' + f1(x1) + '" y1="' + f1(y1) + '" x2="' + f1(x2) + '" y2="' + f1(y2) + '" stroke="' + color + '" stroke-width="' + width + '"' + dash + '/>';
        };
        var paintGaps = function (el, props, keepLayers) {
            if (!keepLayers) for (var u = 0; u < BOX_MANAGED.length; u++) if (/^background/.test(BOX_MANAGED[u])) unsetProp(el, BOX_MANAGED[u]);
            var cs = getComputedStyle(el), w = el.offsetWidth, h = el.offsetHeight;
            if (!w || !h) return;
            var bl = num(cs.borderLeftWidth), bt = num(cs.borderTopWidth), pl = num(cs.paddingLeft), pt = num(cs.paddingTop);
            var ox = bl + pl, oy = bt + pt, cw = el.clientWidth - pl - num(cs.paddingRight), ch = el.clientHeight - pt - num(cs.paddingBottom);
            var colGaps = [], rowGaps = [], count = cs.webkitColumnCount, cwid = cs.webkitColumnWidth;
            var multicol = (count && count !== 'auto') || (cwid && cwid !== 'auto');
            if (multicol) {
                var g = cs.webkitColumnGap === 'normal' ? num(cs.fontSize) : num(cs.webkitColumnGap), n = parseInt(count, 10) || 0, colW = num(cwid);
                if (!n) n = Math.max(1, Math.floor((cw + g) / (colW + g)));
                else if (colW) n = Math.max(1, Math.min(n, Math.floor((cw + g) / (colW + g))));
                var width = (cw - (n - 1) * g) / n;
                for (var i = 1; i < n; i++) colGaps.push({ x: ox + i * (width + g) - g / 2, y1: oy, y2: oy + ch, size: g });
            } else {
                // the in-flow items, in rows by their top edge
                var box = el.getBoundingClientRect(), rows = [];
                for (var c = el.firstElementChild || el.firstChild; c; c = c.nextSibling) {
                    if (c.nodeType !== 1) continue;
                    var ccs = getComputedStyle(c);
                    if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed') continue;
                    var rr = c.getBoundingClientRect(), it = { l: rr.left - box.left, r: rr.right - box.left, t: rr.top - box.top, b: rr.bottom - box.top };
                    var row = null;
                    for (var ri = 0; ri < rows.length; ri++) if (Math.abs(rows[ri].t - it.t) < 2) { row = rows[ri]; break; }
                    if (!row) { row = { t: it.t, b: it.b, items: [] }; rows.push(row); }
                    row.items.push(it);
                    if (it.b > row.b) row.b = it.b;
                }
                rows.sort(function (a, b) { return a.t - b.t; });
                for (var r0 = 0; r0 < rows.length; r0++) {
                    var its = rows[r0].items.sort(function (a, b) { return a.l - b.l; });
                    for (var k = 1; k < its.length; k++) if (its[k].l - its[k - 1].r > 0.5) colGaps.push({ x: (its[k - 1].r + its[k].l) / 2, y1: rows[r0].t, y2: rows[r0].b, size: its[k].l - its[k - 1].r, row: r0 });
                    if (r0 > 0 && rows[r0].t - rows[r0 - 1].b > 0.5) rowGaps.push({ y: (rows[r0 - 1].b + rows[r0].t) / 2, x1: ox, x2: ox + cw, size: rows[r0].t - rows[r0 - 1].b });
                }
            }
            if (!colGaps.length && !rowGaps.length) return;
            // the engine's own column rule (a single value) for flex and grid containers
            var nativeRule = cs.webkitColumnRuleStyle && cs.webkitColumnRuleStyle !== 'none' ? { width: cs.webkitColumnRuleWidth, style: cs.webkitColumnRuleStyle, color: cs.webkitColumnRuleColor } : null;
            var colRules = gapRules(props, 'column', cs, multicol ? null : nativeRule), rowRules = gapRules(props, 'row', cs, null);
            var brk = function (dir) { var c = winner(props, [dir + '-rule-break', 'rule-break']); return c ? trim(c.v).toLowerCase() : 'spanning-item'; };
            var outsetOf = function (dir, size) { var c = winner(props, [dir + '-rule-outset', 'rule-outset']), v = c ? trim(c.v) : '50%'; return /%$/.test(v) ? parseFloat(v) * size / 100 : evalLength(v, el, size) ? evalLength(v, el, size).n : 0; };
            // columns: one segment per row, joined across the rows unless the rule breaks at intersections
            if (brk('column') !== 'intersection' && !multicol) {
                var merged = [];
                for (var m = 0; m < colGaps.length; m++) {
                    var gm = colGaps[m], join = null;
                    for (var q = 0; q < merged.length; q++) if (Math.abs(merged[q].x - gm.x) < 1 && gm.y1 - merged[q].y2 < gm.size + 40) join = merged[q];
                    if (join) join.y2 = Math.max(join.y2, gm.y2); else merged.push({ x: gm.x, y1: gm.y1, y2: gm.y2, size: gm.size });
                }
                colGaps = merged;
            }
            var draw = function (gaps, rules, dir) {
                var out = '', rowGapSize = rowGaps.length ? rowGaps[0].size : 0, colGapSize = colGaps.length ? colGaps[0].size : 0;
                for (var i = 0; i < gaps.length; i++) {
                    var wv = gapValueAt(rules.width, i, gaps.length) || 'medium', sv = gapValueAt(rules.style, i, gaps.length) || 'none', cv = gapValueAt(rules.color, i, gaps.length) || cs.color;
                    if (/^currentcolor$/i.test(cv)) cv = cs.color;
                    var gw = GAP_W[String(wv).toLowerCase()] || (/%$/.test(wv) ? parseFloat(wv) * gaps[i].size / 100 : num(evalValue(el, 'width', wv, null)));
                    var gi = gaps[i];
                    if (dir === 'column') { var o = outsetOf('column', rowGapSize); out += gapLine(gi.x + ox * 0, Math.max(0, gi.y1 - o), gi.x, Math.min(h, gi.y2 + o), gw, String(sv).toLowerCase(), cv); }
                    else { var o2 = outsetOf('row', colGapSize); out += gapLine(Math.max(0, gi.x1 - o2), gi.y, Math.min(w, gi.x2 + o2), gi.y, gw, String(sv).toLowerCase(), cv); }
                }
                return out;
            };
            var order = winner(props, ['rule-paint-order']), rowsOnTop = !order || trim(order.v).toLowerCase() === 'row-over-column';
            var cols = multicol && !winner(props, ['column-rule', 'column-rule-color', 'column-rule-style', 'column-rule-width', 'rule', 'rule-color', 'rule-style', 'rule-width']) ? '' : draw(colGaps, colRules, 'column');
            var rowsSvg = draw(rowGaps, rowRules, 'row');
            var body = rowsOnTop ? cols + rowsSvg : rowsSvg + cols;
            if (!body) return;
            var image = 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + body + '</svg>') + '")';
            var layers = function (prop, ours) { var cur = cs.getPropertyValue(prop); return cur && cur !== 'none' && cs.backgroundImage !== 'none' ? ours + ', ' + cur : ours; };
            setProp(el, 'background-image', layers('background-image', image));
            setProp(el, 'background-size', layers('background-size', w + 'px ' + h + 'px'));
            setProp(el, 'background-position', layers('background-position', '0px 0px'));
            setProp(el, 'background-repeat', layers('background-repeat', 'no-repeat'));
            setProp(el, 'background-origin', layers('background-origin', 'border-box'));
            setProp(el, 'background-clip', layers('background-clip', 'border-box'));
        };
        var INDIVIDUAL_TRANSFORM = { rotate: 1, scale: 1, translate: 1 };
        var SPEECH = { speak: 1, 'speak-as': 1, pause: 1, 'pause-before': 1, 'pause-after': 1, rest: 1, 'rest-before': 1, 'rest-after': 1, cue: 1,
            'cue-before': 1, 'cue-after': 1, 'voice-family': 1, 'voice-rate': 1, 'voice-pitch': 1, 'voice-range': 1, 'voice-volume': 1, 'voice-stress': 1,
            'voice-balance': 1, 'voice-duration': 1 };
        var SPEECH_INHERITED = { speak: 1, 'speak-as': 1, 'voice-family': 1, 'voice-rate': 1, 'voice-pitch': 1, 'voice-range': 1, 'voice-volume': 1, 'voice-stress': 1, 'voice-balance': 1 };
        // the speech properties of an element: its own (from the last pass) and the inherited ones of its ancestors
        var speechOf = function (el) {
            var out = {}, own = true;
            for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
                var rec = n.__brDV;
                if (rec && rec.gen === recGen) {
                    for (var p in rec.props) {
                        if (!rec.props.hasOwnProperty(p) || !SPEECH[p] || out.hasOwnProperty(p)) continue;
                        var sv = trim(rec.props[p].v), lsv = sv.toLowerCase();
                        if (lsv === 'inherit' || (lsv === 'unset' && SPEECH_INHERITED[p])) continue;   // the ancestors decide
                        if (own || SPEECH_INHERITED[p]) out[p] = lsv === 'initial' || lsv === 'unset' ? '' : sv;
                    }
                }
                own = false;
            }
            return out;
        };
        var applyGeneral = function (rec) {
            var el = rec.el, props = rec.props, boxPaint = false, gapPaint = false;
            for (var p in props) {
                if (!props.hasOwnProperty(p) || POSITION_PROPS[p] || SELF_ALIGN[p]) continue;
                var v = props[p].v;
                if (SPEECH[p]) continue;   // kept in the record for the read-aloud feature (see speechOf)
                if (BOX_PAINT.test(p)) { boxPaint = true; continue; }
                if (GAP_PAINT.test(p)) { gapPaint = true; continue; }
                if (p === 'field-sizing') { fieldSizing(el, trim(v).toLowerCase()); continue; }
                if (SVG_GEOM[p]) { svgGeometry(el, p, v); continue; }
                if (p === 'margin-trim') {
                    // the margins of the first / last in-flow child at the container's edges become zero; inherit takes
                    // the parent's value
                    var mt = trim(v).toLowerCase();
                    for (var mp = el.parentNode; mt === 'inherit' && mp && mp.nodeType === 1; mp = mp.parentNode) mt = mp.__brDV && mp.__brDV.gen === recGen && mp.__brDV.props['margin-trim'] ? trim(mp.__brDV.props['margin-trim'].v).toLowerCase() : 'none';
                    if (mt === 'none' || mt === 'initial' || mt === 'unset' || mt === 'inherit') continue;
                    var kids = [];
                    for (var kc = el.firstElementChild || el.firstChild; kc; kc = kc.nextSibling) {
                        if (kc.nodeType !== 1) continue;
                        var kcs = getComputedStyle(kc);
                        if (kcs.display !== 'none' && kcs.position !== 'absolute' && kcs.position !== 'fixed' && kcs['float'] === 'none') kids.push(kc);
                    }
                    if (!kids.length) continue;
                    var first = kids[0], last = kids[kids.length - 1];
                    if (/\bblock\b|block-start/.test(mt)) setProp(first, 'margin-top', '0px');
                    if (/\bblock\b|block-end/.test(mt)) setProp(last, 'margin-bottom', '0px');
                    if (/\binline\b|inline-start/.test(mt)) setProp(first, 'margin-left', '0px');
                    if (/\binline\b|inline-end/.test(mt)) setProp(last, 'margin-right', '0px');
                    continue;
                }
                if (p === 'text-decoration-color') {
                    // decorations are painted in the text stroke colour (see pushDecorationColor in cssfix.js)
                    var dcv = evalValue(el, p, v, null);
                    if (dcv !== null) { setProp(el, '-webkit-text-stroke-color', dcv); setProp(el, '-webkit-text-stroke-width', '0.001px'); }
                    continue;
                }
                if (INDIVIDUAL_TRANSFORM[p]) {
                    var tv = evalValue(el, p, v, null);
                    if (tv === null || /^none$/i.test(trim(tv))) continue;
                    var parts = splitTop(tv, ' ');
                    var fn = p === 'rotate' ? 'rotate(' + parts[parts.length - 1] + ')' : p + '(' + parts.join(', ') + ')';
                    setProp(el, 'transform', fn);
                    continue;
                }
                var lh = longhands(p, v);
                for (var i = 0; i < lh.length; i++) {
                    var val = evalValue(el, lh[i][0], lh[i][1], null);
                    if (val !== null) setProp(el, lh[i][0], val);
                }
            }
            if (boxPaint) { try { paintBox(el, props); } catch (e) {} }
            if (gapPaint) { try { paintGaps(el, props, boxPaint); } catch (e2) {} }
        };
        var needsPositioning = function (props) {
            for (var p in props) {
                if (!props.hasOwnProperty(p) || p === 'anchor-name' || p === 'anchor-scope') continue;
                if (POSITION_PROPS[p] || (SELF_ALIGN[p] && /anchor-center/.test(props[p].v)) || /anchor(-size)?\(/i.test(props[p].v)) return true;
            }
            return false;
        };
        var mediaOk = function (list) {
            if (!list) return true;
            for (var i = 0; i < list.length; i++) { try { if (!window.matchMedia(list[i]).matches) return false; } catch (e) { return false; } }
            return true;
        };
        var collect = function () {
            var recs = [], i, k, b;
            var consider = function (el, e, spec) {
                var rec = el.__brDV;
                if (!rec || rec.gen !== gen) { rec = el.__brDV = { gen: gen, el: el, props: {} }; recs.push(rec); }
                var cur = rec.props[e.p];
                if (cur && ((cur.imp && !e.i) || (!!cur.imp === !!e.i && (cur.spec > spec || (cur.spec === spec && cur.order > e.__order))))) return;
                rec.props[e.p] = { v: e.v, spec: spec, order: e.__order, imp: !!e.i };
            };
            for (i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (!e.s || !mediaOk(e.m)) continue;
                for (b = 0; b < e.s.length; b++) {
                    var list = null;
                    try { list = document.querySelectorAll(e.s[b]); } catch (x) { list = null; }
                    if (list) for (k = 0; k < list.length; k++) consider(list[k], e, e.sp ? e.sp[b] : 0);
                }
            }
            for (i = 0; i < inlineMarked.length; i++) {
                var mk = inlineMarked[i];
                for (k = 0; k < mk.hs.length; k++) { var ie = byHash[mk.hs[k]]; if (ie && !ie.s) consider(mk.el, ie, 1000000); }
            }
            return recs;
        };
        var byDocumentOrder = function (a, b) { return a === b ? 0 : (a.compareDocumentPosition(b) & 4 ? -1 : 1); };
        var pass = function (positionOnly) {
            if (!entries.length) return;
            gen++;
            var i, t0 = Date.now(), tc = t0, ta = t0, counts = {};
            if (!positionOnly) {
                recGen = gen;
                var recs = collect();
                tc = Date.now();
                anchors = {};
                scopes = [];
                positioned = [];
                for (i = 0; i < recs.length; i++) {
                    var props = recs[i].props;
                    if (props['anchor-name']) {
                        var names = splitTop(props['anchor-name'].v, ',');
                        for (var n = 0; n < names.length; n++) if (/^--/.test(names[n])) (anchors[names[n]] = anchors[names[n]] || []).push(recs[i].el);
                    }
                    if (props['anchor-scope']) {
                        var sv = trim(props['anchor-scope'].v);
                        if (sv.toLowerCase() === 'all') scopes.push({ el: recs[i].el, names: 'all' });
                        else if (!/^(none|inherit|initial|unset)$/i.test(sv)) scopes.push({ el: recs[i].el, names: splitTop(sv, ',') });
                    }
                }
                for (var an in anchors) if (anchors.hasOwnProperty(an)) anchors[an].sort(byDocumentOrder);
                timelineRecs = [];
                try { measureWidths(recs); } catch (em) {}
                for (i = 0; i < recs.length; i++) {
                    try { applyGeneral(recs[i]); } catch (e1) {}
                    if (needsPositioning(recs[i].props)) positioned.push(recs[i]);
                    for (var tp in recs[i].props) if (recs[i].props.hasOwnProperty(tp)) {
                        counts[tp] = (counts[tp] || 0) + 1;
                        if (TIMELINE_VALUE.test(recs[i].props[tp].v)) { timelineRecs.push(recs[i]); break; }
                    }
                }
                ta = Date.now();
            } else {
                for (i = 0; i < timelineRecs.length; i++) { try { applyGeneral(timelineRecs[i]); } catch (e3) {} }
            }
            for (i = 0; i < positioned.length; i++) { try { positionElement(positioned[i]); } catch (e2) {} }
            var tp2 = Date.now();
            if (!positionOnly) restoreStale();
            if (window.__brNoteSlow && !positionOnly) {
                var top = [];
                for (var cp in counts) if (counts.hasOwnProperty(cp)) top.push(cp + ' ' + counts[cp]);
                top.sort(function (a, b) { return parseInt(b.split(' ').pop(), 10) - parseInt(a.split(' ').pop(), 10); });
                window.__brNoteSlow('deferred values', Date.now() - t0, 'collect ' + (tc - t0) + ', apply ' + (ta - tc) + ', position ' + (tp2 - ta) + ', restore ' + (Date.now() - tp2) +
                                    '; ' + (recs ? recs.length : 0) + ' elements, ' + positioned.length + ' positioned, ' + entries.length + ' entries: ' + top.slice(0, 8).join(', '));
            }
        };
        onMarkers(function (marked) {
            inlineMarked = [];
            for (var i = 0; i < marked.length; i++) {
                var hs = marked[i].cr.match(/br-dv-[0-9a-z]+/g);
                if (!hs) continue;
                for (var k = 0; k < hs.length; k++) hs[k] = hs[k].slice(6);
                inlineMarked.push({ el: marked[i].el, hs: hs });
            }
        });
        window.addEventListener('scroll', function () {
            if ((!positioned.length && !timelineRecs.length) || scrollTimer) return;
            scrollTimer = setTimeout(function () { scrollTimer = null; pass(true); }, 30);
        }, true);
        document.addEventListener('toggle', function () { if (entries.length) setTimeout(function () { pass(false); }, 0); }, true);
        window.__brDeferred = {
            setManifest: function (m) {
                entries = m.dv || [];
                byHash = {};
                tryRules = {};
                hasInline = false;
                for (var i = 0; i < entries.length; i++) { entries[i].__order = i; byHash[entries[i].h] = entries[i]; if (!entries[i].s) hasInline = true; }
                var pts = m.pt || [];
                for (var k = 0; k < pts.length; k++) tryRules[pts[k].n] = pts[k].d;
            },
            needsMarkers: function () { return hasInline; },
            apply: function () { pass(false); },
            speech: function (el) { return speechOf(el); },
            // a length value of `prop` on `el` evaluated to px (percentages against the containing block), or null
            lengthPx: function (el, prop, value) {
                var st = null;
                try { if (/^(absolute|fixed)$/.test(getComputedStyle(el).position)) st = { cb: containingBlock(el) }; } catch (e) { st = null; }
                var len = evalLength(value, el, pctBaseFor(el, prop, st));
                return len && len.u === 'px' ? round2(len.n) + 'px' : null;
            },
            reposition: function () { pass(true); },
            state: function () { return { entries: entries.length, positioned: positioned.length, anchors: anchors }; }
        };
    })();
    // ---- CSS grid layout (manifest "gd", see registerGridRule in cssfix.js). The old engine has no grid: the rewriter
    // floats the children into equal columns as a stand-in, and here grids are laid out for real: tracks from
    // grid-template-* / grid / grid-auto-* (lengths, %, fr, auto, min-/max-content, minmax(), fit-content(), repeat()
    // with auto-fill/auto-fit, line names, areas), items placed by grid-row/-column/-area or automatically (row flow,
    // dense), then positioned absolutely inside the container (position: relative, its height the rows'), stretched
    // or aligned (justify-/align-items, -self, -content). The container gets .br-grid, which turns the stand-in off.
    // Columns are sized top-down through nested grids and rows bottom-up, with a read and a write phase per nesting
    // level (a layout each, not one per grid). Column-flow grids keep the stand-in strip. Min-content sizes count as 0
    // and items spanning several tracks do not size them.
    (function () {
        var probe = document.createElement('div');
        try { probe.style.display = 'grid'; } catch (e0) {}
        if (probe.style.display === 'grid' && !window.__brGridForce) { window.__brGrid = { setManifest: function () {}, apply: function () {} }; return; }
        var entries = [], gen = 0, touched = [], stats = { passes: 0, grids: 0, items: 0, ms: 0 };
        var PROPS = ['position', 'left', 'top', 'right', 'bottom', 'width', 'height'];
        var trim = function (s) { return String(s).trim(); };
        var num = function (v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; };
        // top-level tokens: whitespace separates; (...), [...] and strings stay whole
        var tokens = function (s) {
            var out = [], cur = '', depth = 0, quote = '';
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (quote) { cur += c; if (c === quote) quote = ''; continue; }
                if (c === '"' || c === "'") { quote = c; cur += c; continue; }
                if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                if (!depth && /\s/.test(c)) { if (cur) out.push(cur); cur = ''; continue; }
                cur += c;
            }
            if (cur) out.push(cur);
            return out;
        };
        // index of the first top-level ch (outside brackets and strings), -1 when none
        var topIndex = function (s, ch) {
            var depth = 0, quote = '';
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (quote) { if (c === quote) quote = ''; continue; }
                if (c === '"' || c === "'") quote = c;
                else if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (!depth && c === ch) return i;
            }
            return -1;
        };
        var splitTopAll = function (s, ch) {
            var out = [], i;
            while ((i = topIndex(s, ch)) >= 0) { out.push(s.slice(0, i)); s = s.slice(i + 1); }
            out.push(s);
            return out;
        };

        // ---- lengths: px, font and viewport units, percentages of a base, calc()/min()/max()/clamp()
        var fontCache = null;
        var fontSize = function (el) {
            if (!el || el.nodeType !== 1) el = document.documentElement;
            if (fontCache && fontCache.el === el) return fontCache.v;
            var v = num(getComputedStyle(el).fontSize) || 16;
            fontCache = { el: el, v: v };
            return v;
        };
        var unitPx = function (n, u, el, base) {
            switch (u) {
                case '': case 'px': return n;
                case '%': return base === null || base === undefined ? NaN : n * base / 100;
                case 'em': return n * fontSize(el);
                case 'ex': case 'ch': return n * fontSize(el) / 2;
                case 'rem': return n * fontSize(document.documentElement);
                case 'vw': return n * window.innerWidth / 100;
                case 'vh': case 'svh': case 'lvh': case 'dvh': return n * window.innerHeight / 100;
                case 'svw': case 'lvw': case 'dvw': return n * window.innerWidth / 100;
                case 'vmin': return n * Math.min(window.innerWidth, window.innerHeight) / 100;
                case 'vmax': return n * Math.max(window.innerWidth, window.innerHeight) / 100;
                case 'pt': return n * 4 / 3;
                case 'pc': return n * 16;
                case 'in': return n * 96;
                case 'cm': return n * 96 / 2.54;
                case 'mm': return n * 96 / 25.4;
                case 'q': return n * 96 / 101.6;
            }
            return NaN;
        };
        var calcPx = function (v, el, base) {
            var s = v.toLowerCase().replace(/-webkit-calc\(/g, 'calc('), i = 0;
            var ws = function () { while (i < s.length && /\s/.test(s.charAt(i))) i++; };
            var expr;
            var factor = function () {
                ws();
                if (s.charAt(i) === '(') { i++; var r = expr(); ws(); if (s.charAt(i) === ')') i++; return r; }
                var fm = /^(calc|min|max|clamp)\(/.exec(s.slice(i));
                if (fm) {
                    i += fm[0].length;
                    var args = [];
                    for (;;) {
                        args.push(expr());
                        ws();
                        if (s.charAt(i) === ',') { i++; continue; }
                        if (s.charAt(i) === ')') { i++; break; }
                        return NaN;
                    }
                    if (fm[1] === 'calc') return args[0];
                    if (fm[1] === 'min') return Math.min.apply(Math, args);
                    if (fm[1] === 'max') return Math.max.apply(Math, args);
                    return args.length === 3 ? Math.max(args[0], Math.min(args[1], args[2])) : NaN;
                }
                var nm = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/.exec(s.slice(i));
                if (!nm) return NaN;
                i += nm[0].length;
                return unitPx(parseFloat(nm[1]), nm[2], el, base);
            };
            var term = function () {
                var r = factor();
                for (;;) {
                    ws();
                    var c = s.charAt(i);
                    if (c === '*') { i++; r *= factor(); } else if (c === '/') { i++; r /= factor(); } else return r;
                }
            };
            expr = function () {
                var r = term();
                for (;;) {
                    ws();
                    var c = s.charAt(i);
                    if ((c === '+' || c === '-') && /\s/.test(s.charAt(i + 1))) { i++; var t = term(); r = c === '+' ? r + t : r - t; } else return r;
                }
            };
            var out = expr();
            return isNaN(out) ? null : out;
        };
        // v in px (percentages of base), or null for anything that is not a length
        var lengthPx = function (v, el, base) {
            v = trim(String(v)).toLowerCase();
            var m = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/.exec(v);
            if (m) { var r = unitPx(parseFloat(m[1]), m[2], el, base); return isNaN(r) ? null : r; }
            if (/^(calc|min|max|clamp|-webkit-calc)\(/.test(v)) return calcPx(v, el, base);
            return null;
        };

        // ---- track lists
        var sizeFn = function (t) {
            var lt = trim(t).toLowerCase(), fr = /^([\d.]+)fr$/.exec(lt);
            if (lt === 'auto') return { k: 'auto' };
            if (lt === 'min-content') return { k: 'min' };
            if (lt === 'max-content') return { k: 'max' };
            if (fr) return { k: 'fr', n: parseFloat(fr[1]) };
            return { k: 'len', v: trim(t) };
        };
        var parseTrack = function (t) {
            var m = /^minmax\(([\s\S]*)\)$/i.exec(t);
            if (m) {
                var args = splitTopAll(m[1], ','), mn = sizeFn(args[0]), mx = sizeFn(args[1] || 'auto');
                if (mn.k === 'fr') mn = { k: 'auto' };   // (a flexible minimum is invalid)
                return { min: mn, max: mx };
            }
            m = /^fit-content\(([\s\S]*)\)$/i.exec(t);
            if (m) return { min: { k: 'auto' }, max: { k: 'fit', v: trim(m[1]) } };
            var one = sizeFn(t);
            return one.k === 'fr' ? { min: { k: 'auto' }, max: one } : { min: one, max: one };
        };
        var lineNames = function (t) { var s = trim(t.slice(1, -1)); return s ? s.split(/\s+/) : []; };
        // [{names}, {track}, {repeat: n | 'auto-fill' | 'auto-fit', list}] in order
        var parseList = function (text) {
            var out = [], toks = tokens(trim(text || ''));
            for (var i = 0; i < toks.length; i++) {
                var t = toks[i], m;
                if (t.charAt(0) === '[') out.push({ names: lineNames(t) });
                else if ((m = /^repeat\(([\s\S]*)\)$/i.exec(t))) {
                    var c = topIndex(m[1], ','), cnt = trim(m[1].slice(0, c)).toLowerCase();
                    out.push({ repeat: /^\d+$/.test(cnt) ? parseInt(cnt, 10) : cnt, list: parseList(m[1].slice(c + 1)) });
                } else if (!/^(none|subgrid|masonry)$/i.test(t)) out.push({ track: parseTrack(t) });
            }
            return out;
        };
        // the size a track is sure to have (a length for its maximum, else its minimum), 0 when neither is one
        var definite = function (tr, el, base) {
            var mx = tr.max.k === 'len' ? lengthPx(tr.max.v, el, base) : null;
            if (mx !== null) return mx;
            var mn = tr.min.k === 'len' ? lengthPx(tr.min.v, el, base) : null;
            return mn !== null ? mn : 0;
        };
        // how many times repeat(auto-fill / auto-fit) goes into the room
        var autoCount = function (list, avail, gap, el) {
            var other = 0, otherN = 0, unit = 0, unitN = 0, i, k;
            for (i = 0; i < list.length; i++) {
                var it = list[i];
                if (it.track) { other += definite(it.track, el, avail); otherN++; }
                else if (it.repeat !== undefined && typeof it.repeat === 'number') {
                    for (k = 0; k < it.list.length; k++) if (it.list[k].track) { other += it.repeat * definite(it.list[k].track, el, avail); otherN += it.repeat; }
                } else if (it.repeat !== undefined) {
                    for (k = 0; k < it.list.length; k++) if (it.list[k].track) { unit += definite(it.list[k].track, el, avail); unitN++; }
                }
            }
            if (unit <= 0 || avail === null) return 1;
            var n = Math.floor((avail - other - Math.max(0, otherN - 1) * gap + gap) / (unit + unitN * gap));
            return Math.max(1, n);
        };
        // -> {tracks: [track], lines: [[names]], fit: [index of auto-fit tracks]}
        var expand = function (list, count) {
            var tracks = [], lines = [[]], fit = [];
            var add = function (items, fitting) {
                for (var i = 0; i < items.length; i++) {
                    var it = items[i];
                    if (it.names) lines[lines.length - 1] = lines[lines.length - 1].concat(it.names);
                    else if (it.track) { if (fitting) fit.push(tracks.length); tracks.push(it.track); lines.push([]); }
                    else if (it.repeat !== undefined) {
                        var n = typeof it.repeat === 'number' ? it.repeat : count;
                        for (var r = 0; r < n; r++) add(it.list, it.repeat === 'auto-fit');
                    }
                }
            };
            add(list, false);
            return { tracks: tracks, lines: lines, fit: fit };
        };
        var hasAutoRepeat = function (list) { for (var i = 0; i < list.length; i++) if (list[i].repeat !== undefined && typeof list[i].repeat !== 'number') return true; return false; };
        // a list with tracks sized by their content (the items' natural widths are measured for those)
        var intrinsicList = function (list) {
            for (var i = 0; i < list.length; i++) {
                var it = list[i];
                if (it.track && (/^(auto|min|max|fit)$/.test(it.track.max.k) || /^(min|max)$/.test(it.track.min.k))) return true;
                if (it.repeat !== undefined && intrinsicList(it.list)) return true;
            }
            return false;
        };
        // grid-template-areas -> {rows, cols, areas: {name: {r0, r1, c0, c1}}}
        var parseAreas = function (v) {
            var strs = String(v || '').match(/"[^"]*"|'[^']*'/g);
            if (!strs) return null;
            var areas = {}, cols = 0;
            for (var r = 0; r < strs.length; r++) {
                var cells = trim(strs[r].slice(1, -1)).split(/\s+/);
                cols = Math.max(cols, cells.length);
                for (var c = 0; c < cells.length; c++) {
                    var n = cells[c];
                    if (!n || /^\.+$/.test(n)) continue;
                    var a = areas[n];
                    if (!a) areas[n] = { r0: r, r1: r + 1, c0: c, c1: c + 1 };
                    else { a.r0 = Math.min(a.r0, r); a.r1 = Math.max(a.r1, r + 1); a.c0 = Math.min(a.c0, c); a.c1 = Math.max(a.c1, c + 1); }
                }
            }
            return { rows: strs.length, cols: cols, areas: areas };
        };

        // ---- shorthands into longhands (the cascade then works per longhand)
        var expandTemplate = function (v) {
            v = trim(v);
            if (/^none$/i.test(v)) return { 'grid-template-rows': 'none', 'grid-template-columns': 'none', 'grid-template-areas': 'none' };
            var slash = topIndex(v, '/'), left = slash < 0 ? v : v.slice(0, slash), right = slash < 0 ? 'none' : trim(v.slice(slash + 1));
            if (!/["']/.test(left)) return { 'grid-template-rows': trim(left), 'grid-template-columns': right, 'grid-template-areas': 'none' };
            var toks = tokens(left), rows = [], areas = [];
            for (var i = 0; i < toks.length; i++) {
                var t = toks[i];
                if (t.charAt(0) === '"' || t.charAt(0) === "'") {
                    areas.push(t);
                    if (i + 1 < toks.length && !/^["'\[]/.test(toks[i + 1])) { rows.push(toks[i + 1]); i++; } else rows.push('auto');
                } else if (t.charAt(0) === '[') rows.push(t);
            }
            return { 'grid-template-rows': rows.join(' '), 'grid-template-columns': right, 'grid-template-areas': areas.join(' ') };
        };
        var expandGrid = function (v) {
            var out = { 'grid-template-rows': 'none', 'grid-template-columns': 'none', 'grid-template-areas': 'none', 'grid-auto-flow': 'row', 'grid-auto-rows': 'auto', 'grid-auto-columns': 'auto' };
            var slash = topIndex(v, '/');
            if (slash >= 0) {
                var l = trim(v.slice(0, slash)), r = trim(v.slice(slash + 1)), rest;
                if (/\bauto-flow\b/i.test(r)) {
                    out['grid-template-rows'] = l;
                    out['grid-auto-flow'] = 'column' + (/\bdense\b/i.test(r) ? ' dense' : '');
                    rest = trim(r.replace(/\bauto-flow\b|\bdense\b/gi, ''));
                    if (rest) out['grid-auto-columns'] = rest;
                    return out;
                }
                if (/\bauto-flow\b/i.test(l)) {
                    out['grid-template-columns'] = r;
                    out['grid-auto-flow'] = 'row' + (/\bdense\b/i.test(l) ? ' dense' : '');
                    rest = trim(l.replace(/\bauto-flow\b|\bdense\b/gi, ''));
                    if (rest) out['grid-auto-rows'] = rest;
                    return out;
                }
            }
            var t = expandTemplate(v);
            for (var k in t) if (t.hasOwnProperty(k)) out[k] = t[k];
            return out;
        };
        var twoLines = function (v, a, b) {
            var parts = splitTopAll(v, '/'), o = {};
            o[a] = trim(parts[0]);
            if (parts.length > 1) o[b] = trim(parts[1]);
            else o[b] = /^[a-z_-][\w-]*$/i.test(o[a]) && !/^(auto|span)$/i.test(o[a]) ? o[a] : 'auto';   // (a name: both lines)
            return o;
        };
        var longhands = function (p, v) {
            var o = {}, t, parts;
            switch (p) {
                case 'grid-template': return expandTemplate(v);
                case 'grid': return expandGrid(v);
                case 'gap': case 'grid-gap':
                    t = tokens(v); o['row-gap'] = t[0]; o['column-gap'] = t.length > 1 ? t[1] : t[0]; return o;
                case 'grid-row-gap': o['row-gap'] = v; return o;
                case 'grid-column-gap': o['column-gap'] = v; return o;
                case 'place-items': t = tokens(v); o['align-items'] = t[0]; o['justify-items'] = t.length > 1 ? t[1] : t[0]; return o;
                case 'place-content': t = tokens(v); o['align-content'] = t[0]; o['justify-content'] = t.length > 1 ? t[1] : t[0]; return o;
                case 'place-self': t = tokens(v); o['align-self'] = t[0]; o['justify-self'] = t.length > 1 ? t[1] : t[0]; return o;
                case 'grid-row': return twoLines(v, 'grid-row-start', 'grid-row-end');
                case 'grid-column': return twoLines(v, 'grid-column-start', 'grid-column-end');
                case 'grid-area':
                    parts = splitTopAll(v, '/');
                    for (var i = 0; i < parts.length; i++) parts[i] = trim(parts[i]);
                    var name = /^[a-z_-][\w-]*$/i.test(parts[0]) && !/^(auto|span)$/i.test(parts[0]);
                    o['grid-row-start'] = parts[0];
                    o['grid-column-start'] = parts.length > 1 ? parts[1] : name ? parts[0] : 'auto';
                    o['grid-row-end'] = parts.length > 2 ? parts[2] : name ? parts[0] : 'auto';
                    o['grid-column-end'] = parts.length > 3 ? parts[3] : parts.length > 1 && /^[a-z_-][\w-]*$/i.test(parts[1]) && !/^(auto|span)$/i.test(parts[1]) ? parts[1] : name && parts.length === 1 ? parts[0] : 'auto';
                    return o;
            }
            o[p] = v;
            return o;
        };

        // ---- the cascade: per element, the winning value of every longhand among the rules that match it
        var mediaOk = function (list) {
            if (!list) return true;
            for (var i = 0; i < list.length; i++) { try { if (!window.matchMedia(list[i]).matches) return false; } catch (e) { return false; } }
            return true;
        };
        // Entries that say something grid-specific find their elements with querySelectorAll; the others (alignment,
        // gaps, order, display: the utility rules of a document that has grids, often a thousand flex rules) are only
        // tried on the grid containers and items found, through an index by the key of their subject (a class, id or
        // tag), like an engine's rule hash (aktualne.cz: 1254 entries took 745 ms a pass with querySelectorAll).
        var prepared = null;
        // (escapes count: Tailwind's .md\:items-center is the class "md:items-center")
        var subjectKey = function (sel) {
            var s = String(sel), i, c, depth = 0, quote = '', start = 0;
            for (i = 0; i < s.length; i++) {
                c = s.charAt(i);
                if (c === '\\') { i++; continue; }
                if (quote) { if (c === quote) quote = ''; continue; }
                if (c === '"' || c === "'") quote = c;
                else if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (!depth && /[\s>+~]/.test(c)) start = i + 1;
            }
            var last = s.slice(start), ident = function (from) {
                var out = '';
                for (var j = from; j < last.length; j++) {
                    var ch = last.charAt(j);
                    if (ch === '\\' && j + 1 < last.length) { out += last.charAt(j + 1); j++; }
                    else if (/[\w-]/.test(ch) || ch.charCodeAt(0) > 127) out += ch;
                    else break;
                }
                return out;
            };
            var tag = ident(0), id = '';
            depth = 0;
            for (i = 0; i < last.length; i++) {
                c = last.charAt(i);
                if (c === '\\') { i++; continue; }
                if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (!depth && c === '.') { var cls = ident(i + 1); if (cls) return 'c:' + cls; }
                else if (!depth && c === '#' && !id) id = ident(i + 1);
            }
            if (id) return 'i:' + id;
            return tag && tag !== '*' ? 't:' + tag.toLowerCase() : '*';
        };
        var prepare = function () {
            var list = [], index = {}, i, d, b;
            for (i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (!e.s || !e.d) continue;
                var decls = [], specific = false;
                for (d = 0; d < e.d.length; d++) {
                    var p0 = e.d[d][0], v0 = String(e.d[d][1]);
                    if (/^grid/.test(p0) || (p0 === 'display' && /grid/i.test(v0))) specific = true;
                    var lh = longhands(p0, v0);
                    for (var lp in lh) if (lh.hasOwnProperty(lp)) decls.push([lp, lh[lp], !!e.d[d][2]]);
                }
                var pe = { order: i, s: e.s, sp: e.sp || [], m: e.m ? e.m.join('&') : '', decls: decls, specific: specific };
                list.push(pe);
                if (!specific) for (b = 0; b < e.s.length; b++) { var key = subjectKey(e.s[b]); (index[key] || (index[key] = [])).push([pe, b]); }
            }
            return { list: list, index: index };
        };
        var collect = function () {
            if (!prepared) prepared = prepare();
            var recs = [], i, b, k, d, media = {};
            var ok = function (m) { if (!m) return true; if (media[m] === undefined) media[m] = mediaOk(m.split('&')); return media[m]; };
            var consider = function (el, pe, spec) {
                var rec = el.__brGD;
                if (!rec || rec.gen !== gen) { rec = el.__brGD = { gen: gen, el: el, props: {} }; recs.push(rec); }
                for (var q = 0; q < pe.decls.length; q++) {
                    var p = pe.decls[q][0], imp = pe.decls[q][2], cur = rec.props[p];
                    if (cur && ((cur.imp && !imp) || (cur.imp === imp && (cur.spec > spec || (cur.spec === spec && cur.order > pe.order))))) continue;
                    rec.props[p] = { v: pe.decls[q][1], spec: spec, order: pe.order, imp: imp };
                }
            };
            for (i = 0; i < prepared.list.length; i++) {
                var pe = prepared.list[i];
                if (!pe.specific || !ok(pe.m)) continue;
                for (b = 0; b < pe.s.length; b++) {
                    var found = null;
                    try { found = document.querySelectorAll(pe.s[b]); } catch (x) { found = null; }
                    if (found) for (k = 0; k < found.length; k++) consider(found[k], pe, pe.sp[b] || 0);
                }
            }
            // the containers and their children get the other entries that match them
            var targets = [];
            for (i = 0; i < recs.length; i++) {
                var dv = recs[i].props.display;
                if (!dv || !/grid/i.test(dv.v)) continue;
                targets.push(recs[i].el);
                for (var c = recs[i].el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) targets.push(c);
            }
            var index = prepared.index, matchFn = Ep.webkitMatchesSelector || Ep.matches;
            for (i = 0; i < targets.length; i++) {
                var el = targets[i], keys = ['*', 't:' + el.tagName.toLowerCase()];
                if (el.id) keys.push('i:' + el.id);
                var cls = String(el.getAttribute('class') || '').split(/\s+/);
                for (k = 0; k < cls.length; k++) if (cls[k]) keys.push('c:' + cls[k]);
                var tried = {};
                for (k = 0; k < keys.length; k++) {
                    var cand = index[keys[k]];
                    if (!cand) continue;
                    for (d = 0; d < cand.length; d++) {
                        var pc = cand[d][0], bi = cand[d][1], tk = pc.order + ':' + bi;
                        if (tried[tk]) continue;
                        tried[tk] = 1;
                        if (!ok(pc.m)) continue;
                        var hit = false;
                        try { hit = matchFn.call(el, pc.s[bi]); } catch (x2) { hit = false; }
                        if (hit) consider(el, pc, pc.sp[bi] || 0);
                    }
                }
            }
            return recs;
        };
        var prop = function (rec, p, dflt) { return rec && rec.props[p] ? trim(rec.props[p].v) : dflt; };

        // ---- styles we set, and the page's own values to put back
        var setStyle = function (el, p, v) {
            var saved = el.__brGridSaved;
            if (!saved) {
                saved = el.__brGridSaved = {};
                for (var i = 0; i < PROPS.length; i++) saved[PROPS[i]] = [el.style.getPropertyValue(PROPS[i]), el.style.getPropertyPriority(PROPS[i])];
                touched.push(el);
            }
            el.__brGridGen = gen;
            // (null: the page's own inline value again. A value already there is not written again: every write of a
            // style is a change of the style attribute for every MutationObserver of the page - rohlik.cz got 700
            // "width: 158px !important" a minute, handed on to its observers, which checked the layout each time.)
            if (v === null) { if (saved[p] && saved[p][0]) el.style.setProperty(p, saved[p][0], saved[p][1]); else if (el.style.getPropertyValue(p)) el.style.removeProperty(p); }
            else if (el.style.getPropertyValue(p) !== v || el.style.getPropertyPriority(p) !== 'important') el.style.setProperty(p, v, 'important');
        };
        // (a width of the page's own: in the style attribute before the layout wrote there, or from a rule)
        var ownWidth = function (el) {
            var saved = el.__brGridSaved, inl = saved && saved.width ? saved.width[0] : el.style.width;
            if (inl && inl !== 'auto') return true;
            if (!window.getMatchedCSSRules) return false;
            var mr = null;
            try { mr = window.getMatchedCSSRules(el, ''); } catch (e) { mr = null; }
            for (var q = mr ? mr.length - 1 : -1; q >= 0; q--) { var w = mr[q].style && mr[q].style.width; if (w) return w !== 'auto'; }
            return false;
        };
        var restore = function (el) {
            var saved = el.__brGridSaved;
            if (!saved) return;
            for (var p in saved) if (saved.hasOwnProperty(p)) {
                if (saved[p][0]) el.style.setProperty(p, saved[p][0], saved[p][1]); else el.style.removeProperty(p);
            }
            el.__brGridSaved = null;
            if (el.__brGridBox) { var c = ' ' + el.className + ' '; el.className = trim(c.replace(' br-grid ', ' ')); el.__brGridBox = false; }
        };

        // ---- line placement
        var parseLine = function (v) {
            v = trim(String(v || 'auto'));
            if (/^auto$/i.test(v)) return { auto: true };
            var toks = v.split(/\s+/), s = { span: false, n: null, name: null };
            for (var i = 0; i < toks.length; i++) {
                if (/^span$/i.test(toks[i])) s.span = true;
                else if (/^[+-]?\d+$/.test(toks[i])) s.n = parseInt(toks[i], 10);
                else s.name = toks[i];
            }
            return s;
        };
        var findLines = function (lines, name) { var out = []; for (var i = 0; i < lines.length; i++) if (lines[i].indexOf(name) >= 0) out.push(i); return out; };
        var lineIndex = function (s, lines, side) {
            if (s.name) {
                var idx = findLines(lines, s.name + (side === 'start' ? '-start' : '-end'));
                if (!idx.length) idx = findLines(lines, s.name);
                if (!idx.length) return null;
                var k = s.n || 1;
                if (k > 0) return k <= idx.length ? idx[k - 1] : idx[idx.length - 1];
                return -k <= idx.length ? idx[idx.length + k] : idx[0];
            }
            if (s.n === null || s.n === 0) return null;
            return s.n > 0 ? s.n - 1 : Math.max(0, lines.length + s.n);
        };
        // -> {start: line index or null (auto), span}
        var placeAxis = function (st, en, lines) {
            var s = st.auto || st.span ? null : lineIndex(st, lines, 'start');
            var e = en.auto || en.span ? null : lineIndex(en, lines, 'end');
            var spanS = st.span ? (st.n || 1) : 0, spanE = en.span ? (en.n || 1) : 0;
            if (s !== null && e !== null) { if (e < s) { var t = s; s = e; e = t; } return { start: s, span: Math.max(1, e - s) }; }
            if (s !== null) return { start: s, span: spanE || 1 };
            if (e !== null) { var sp = spanS || 1; return { start: Math.max(0, e - sp), span: Math.max(1, Math.min(sp, e)) }; }
            return { start: null, span: spanS || spanE || 1 };
        };
        // auto-placement in row flow; items get r, c (track indices) and rs, cs (spans)
        var placeItems = function (items, colCount, dense) {
            var occ = [], i, r, c;
            var free = function (r0, c0, rs, cs) {
                if (c0 + cs > colCount) return false;
                for (var y = r0; y < r0 + rs; y++) { var row = occ[y]; if (!row) continue; for (var x = c0; x < c0 + cs; x++) if (row[x]) return false; }
                return true;
            };
            var take = function (it) { for (var y = it.r; y < it.r + it.rs; y++) { var row = occ[y] || (occ[y] = []); for (var x = it.c; x < it.c + it.cs; x++) row[x] = true; } };
            for (i = 0; i < items.length; i++) colCount = Math.max(colCount, items[i].c !== null ? items[i].c + items[i].cs : items[i].cs);
            for (i = 0; i < items.length; i++) { var it0 = items[i]; if (it0.r !== null && it0.c !== null) take(it0); }
            // locked to a row
            for (i = 0; i < items.length; i++) {
                var it1 = items[i];
                if (it1.r === null || it1.c !== null) continue;
                for (c = 0; c + it1.cs <= colCount && !free(it1.r, c, it1.rs, it1.cs); c++) { /* the first free column */ }
                if (c + it1.cs > colCount) { c = colCount; colCount += it1.cs; }
                it1.c = c;
                take(it1);
            }
            var cr = 0, cc = 0;
            for (i = 0; i < items.length; i++) {
                var it = items[i];
                if (it.r !== null) continue;
                if (dense) { cr = 0; cc = 0; }
                if (it.c !== null) {
                    // a column of its own: the next row where it fits
                    r = cr + (it.c < cc ? 1 : 0);
                    while (r < 5000 && !free(r, it.c, it.rs, it.cs)) r++;
                    it.r = r;
                    cr = r; cc = it.c;
                } else {
                    for (r = cr, c = cc; r < 5000; ) {
                        if (c + it.cs > colCount) { r++; c = 0; continue; }
                        if (free(r, c, it.rs, it.cs)) break;
                        c++;
                    }
                    it.r = r; it.c = c;
                    cr = r; cc = c + it.cs;
                }
                take(it);
            }
            var rows = 0;
            for (i = 0; i < items.length; i++) rows = Math.max(rows, items[i].r + items[i].rs);
            return { cols: colCount, rows: rows };
        };

        // ---- track sizing: sizes of tracks for the room avail (null: indefinite) with gaps; contrib[i] = the largest
        // natural size of the items that sit in track i alone
        // (contentMin: an auto minimum is the content's size, as for rows, where the content height is known; for
        // columns it would be the min-content width, which is not measured, so 0)
        var sizeTracks = function (tracks, avail, gap, contrib, el, stretchAuto, contentMin) {
            var n = tracks.length, base = [], limit = [], flex = [], i, sum = 0, flexSum = 0;
            var lenOf = function (sz) { return sz.k === 'len' ? lengthPx(sz.v, el, avail) : null; };
            for (i = 0; i < n; i++) {
                var t = tracks[i], c = contrib[i] || 0, mn = lenOf(t.min), mx;
                base[i] = mn !== null ? mn : contentMin && t.min.k !== 'len' ? c : 0;
                if (t.max.k === 'fr') { flex[i] = t.max.n; limit[i] = Infinity; }
                else if (t.max.k === 'len') { mx = lenOf(t.max); limit[i] = mx !== null ? mx : c; }
                else if (t.max.k === 'fit') { mx = lengthPx(t.max.v, el, avail); limit[i] = mx !== null ? Math.min(c, mx) : c; }
                else limit[i] = c;
                if (!flex[i] && limit[i] < base[i]) limit[i] = base[i];
                // (an indefinite room makes flexible tracks auto ones)
                if (flex[i] && avail === null) { base[i] = Math.max(base[i], c); flex[i] = 0; limit[i] = base[i]; }
            }
            var gaps = Math.max(0, n - 1) * gap;
            var size = base.slice(0);
            // grow toward the limits
            if (avail !== null) {
                for (var guard = 0; guard < 20; guard++) {
                    sum = 0;
                    for (i = 0; i < n; i++) sum += size[i];
                    var freeSpace = avail - gaps - sum, growable = [];
                    if (freeSpace <= 0.5) break;
                    for (i = 0; i < n; i++) if (!flex[i] && limit[i] > size[i] + 0.01) growable.push(i);
                    if (!growable.length) break;
                    var share = freeSpace / growable.length, grown = false;
                    for (i = 0; i < growable.length; i++) {
                        var g = growable[i], add = Math.min(share, limit[g] - size[g]);
                        if (add > 0) { size[g] += add; grown = true; }
                    }
                    if (!grown) break;
                }
            } else for (i = 0; i < n; i++) if (!flex[i] && isFinite(limit[i])) size[i] = limit[i];
            // flexible tracks share what is left
            var anyFlex = false;
            for (i = 0; i < n; i++) if (flex[i]) anyFlex = true;
            if (anyFlex && avail !== null) {
                var inflexible = {};
                for (var round = 0; round < n + 1; round++) {
                    var left = avail - gaps;
                    flexSum = 0;
                    for (i = 0; i < n; i++) { if (flex[i] && !inflexible[i]) flexSum += flex[i]; else left -= size[i]; }
                    var fr = flexSum > 0 ? Math.max(0, left) / Math.max(flexSum, 1) : 0, again = false;
                    for (i = 0; i < n; i++) if (flex[i] && !inflexible[i] && flex[i] * fr < base[i]) { inflexible[i] = true; again = true; }
                    if (!again) { for (i = 0; i < n; i++) if (flex[i] && !inflexible[i]) size[i] = flex[i] * fr; break; }
                }
            } else if (!anyFlex && avail !== null && stretchAuto) {
                // auto tracks take what is still free (justify-/align-content normal or stretch)
                sum = 0;
                var autos = [];
                for (i = 0; i < n; i++) { sum += size[i]; if (tracks[i].max.k === 'auto') autos.push(i); }
                var rest = avail - gaps - sum;
                if (rest > 0.5 && autos.length) for (i = 0; i < autos.length; i++) size[autos[i]] += rest / autos.length;
            }
            return size;
        };
        var ALIGN = function (v) {
            v = String(v || '').toLowerCase().replace(/^(safe|unsafe)\s+/, '');
            if (/^(start|flex-start|self-start|left|baseline|first baseline|last baseline)$/.test(v)) return 'start';
            if (/^(end|flex-end|self-end|right)$/.test(v)) return 'end';
            if (v === 'center') return 'center';
            return v === 'stretch' ? 'stretch' : 'normal';
        };
        // (normal stretches everything but pictures and other replaced elements, which keep their size)
        var REPLACED = { IMG: 1, VIDEO: 1, CANVAS: 1, IFRAME: 1, EMBED: 1, OBJECT: 1, svg: 1, SVG: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, BUTTON: 1 };
        var stretches = function (a, el) { return a === 'stretch' || (a === 'normal' && !REPLACED[el.tagName]); };
        // offset and extra gap for justify-/align-content when the tracks leave room
        var distribute = function (v, free, n) {
            v = String(v || 'normal').toLowerCase().replace(/^(safe|unsafe)\s+/, '');
            if (free <= 0 || n < 1) return [0, 0];
            if (/^(end|flex-end|right)$/.test(v)) return [free, 0];
            if (v === 'center') return [free / 2, 0];
            if (v === 'space-between') return n > 1 ? [0, free / (n - 1)] : [0, 0];
            if (v === 'space-around') return [free / (2 * n), free / n];
            if (v === 'space-evenly') return [free / (n + 1), free / (n + 1)];
            return [0, 0];
        };
        var offsets = function (sizes, gap, start, extra) {
            var pos = [], x = start;
            for (var i = 0; i < sizes.length; i++) { pos.push(x); x += sizes[i] + gap + extra; }
            return pos;
        };
        var spanSize = function (sizes, pos, from, count, gap) {
            var last = Math.min(sizes.length, from + count) - 1;
            return last < from ? 0 : pos[last] + sizes[last] - pos[from];
        };

        // ---- one layout of every grid on the page
        var layoutAll = function () {
            gen++;
            fontCache = null;
            var t0 = Date.now();
            var recs = collect(), grids = [], byEl = [], i, j, g;
            stats.collectMs = Date.now() - t0;
            stats.items = 0;
            stats.entries = entries.length;
            for (i = 0; i < recs.length; i++) {
                var rec = recs[i], d = prop(rec, 'display', '').toLowerCase();
                if (d !== 'grid' && d !== 'inline-grid') continue;
                if (/column/i.test(prop(rec, 'grid-auto-flow', 'row'))) continue;
                grids.push({ el: rec.el, rec: rec, inline: d === 'inline-grid' });
            }
            // read phase 0 (nothing written yet): the rendered containers, their items, nesting
            var kept = [];
            for (i = 0; i < grids.length; i++) {
                g = grids[i];
                var cs = getComputedStyle(g.el);
                if (cs.display === 'none' || !g.el.getClientRects().length) continue;
                g.items = [];
                for (var c = g.el.firstChild; c; c = c.nextSibling) {
                    if (c.nodeType !== 1) continue;
                    var ccs = getComputedStyle(c);
                    if (ccs.display === 'none' || /^(SCRIPT|STYLE|TEMPLATE)$/.test(c.tagName)) continue;
                    // (the page's own absolute or fixed children are not grid items; ours were items last time)
                    if ((ccs.position === 'absolute' || ccs.position === 'fixed') && !c.__brGridSaved) continue;
                    g.items.push({ el: c, rec: c.__brGD && c.__brGD.gen === gen ? c.__brGD : null });
                }
                g.static = cs.position === 'static';
                // (a floated or inline grid without a width of its own is as wide as its tracks: sized from the items'
                // natural widths every pass, see below; with the items out of the flow it collapsed, and a badge of
                // bbc.com kept a 2 px width and a 0 px text track from a pass made before its text was there)
                g.shrink = (cs.cssFloat !== 'none' || cs.display === 'inline-block') && !ownWidth(g.el);
                g.w0 = g.el.clientWidth - num(cs.paddingLeft) - num(cs.paddingRight);
                g.pad = { l: num(cs.paddingLeft), r: num(cs.paddingRight), t: num(cs.paddingTop), b: num(cs.paddingBottom) };
                g.border = cs.boxSizing === 'border-box' ? { h: num(cs.borderLeftWidth) + num(cs.borderRightWidth), v: num(cs.borderTopWidth) + num(cs.borderBottomWidth) } : null;
                g.el.__brGridNow = gen;
                kept.push(g);
            }
            grids = kept;
            // depth: grids inside the items of other grids
            for (i = 0; i < grids.length; i++) {
                g = grids[i];
                g.depth = 0;
                for (var a = g.el.parentNode; a && a.nodeType === 1; a = a.parentNode) if (a.__brGridNow === gen) g.depth++;
            }
            var maxDepth = 0;
            for (i = 0; i < grids.length; i++) maxDepth = Math.max(maxDepth, grids[i].depth);
            var level = function (dpt) { var out = []; for (var k = 0; k < grids.length; k++) if (grids[k].depth === dpt) out.push(grids[k]); return out; };
            var L, lv, it;
            var t1 = Date.now();
            stats.r0Ms = t1 - t0 - stats.collectMs;
            // columns: one write and one read for every grid at once (a layout each, not a few per nesting level),
            // then the sizes top-down in script, an inner grid's room following the width its outer item gets
            var byDepth = grids.slice(0).sort(function (x, y) { return x.depth - y.depth; });
            // write: the container turns the stand-in off; its items leave the flow, stretched to both edges (outer
            // grids first: an inner container that is an outer item is absolute by then, a containing block as it is)
            for (i = 0; i < byDepth.length; i++) {
                g = byDepth[i];
                if (!g.el.__brGridBox) { g.el.className = trim(g.el.className + ' br-grid'); g.el.__brGridBox = true; }
                setStyle(g.el, 'height', null);
                if (g.static && g.el.style.getPropertyValue('position') !== 'absolute') setStyle(g.el, 'position', 'relative');
                for (j = 0; j < g.items.length; j++) {
                    it = g.items[j].el;
                    it.__brGridItem = g.items[j];
                    g.items[j].pass = gen;
                    setStyle(it, 'position', 'absolute');
                    setStyle(it, 'left', '0px'); setStyle(it, 'right', '0px'); setStyle(it, 'top', '0px'); setStyle(it, 'bottom', '0px');
                    setStyle(it, 'width', null); setStyle(it, 'height', null);
                }
            }
            // read: the room, and which items take the stretch (auto sizes fill both edges of the padding box)
            for (i = 0; i < grids.length; i++) {
                g = grids[i];
                var gcs = getComputedStyle(g.el);
                g.W = g.el.clientWidth - g.pad.l - g.pad.r;
                // (a container sized by its content lost it: it keeps the width it had)
                g.keepW = !g.shrink && g.W < g.w0 - 1 ? g.w0 : null;
                if (g.keepW) g.W = g.keepW;
                var h0 = g.el.clientHeight - g.pad.t - g.pad.b;
                g.H = h0 > 0.5 ? h0 : null;
                // (the height min-height gives: flexible rows fill it, and it grows when the rows need more)
                g.minH = num(gcs.minHeight) - (g.border ? g.pad.t + g.pad.b + g.border.v : 0);
                g.minMode = g.H !== null && g.minH > 0 && g.minH >= g.H - 1;
                g.edges = g.pad.l + g.pad.r + num(gcs.borderLeftWidth) + num(gcs.borderRightWidth);
                var pbw = g.el.clientWidth, pbh = g.el.clientHeight;
                g.needNat = false;
                for (j = 0; j < g.items.length; j++) {
                    var item = g.items[j], ics = getComputedStyle(item.el);
                    item.m = { l: num(ics.marginLeft), r: num(ics.marginRight), t: num(ics.marginTop), b: num(ics.marginBottom) };
                    item.box = ics.boxSizing === 'border-box' ? { h: 0, v: 0 } :
                        { h: num(ics.paddingLeft) + num(ics.paddingRight) + num(ics.borderLeftWidth) + num(ics.borderRightWidth),
                          v: num(ics.paddingTop) + num(ics.paddingBottom) + num(ics.borderTopWidth) + num(ics.borderBottomWidth) };
                    item.w1 = item.el.offsetWidth;
                    item.autoW = Math.abs(item.w1 - Math.max(0, pbw - item.m.l - item.m.r)) < 1.5;
                    // (a percentage width is of the grid area, not of the container the item is placed in here)
                    item.pctW = null;
                    if (!item.autoW) {
                        var specW = item.el.style.width;
                        if (!specW && window.getMatchedCSSRules) {
                            var mr = null;
                            try { mr = window.getMatchedCSSRules(item.el, ''); } catch (eM) { mr = null; }
                            for (var q = mr ? mr.length - 1 : -1; q >= 0; q--) { if (mr[q].style && mr[q].style.width) { specW = mr[q].style.width; break; } }
                        }
                        if (/^[\d.]+%$/.test(specW || '')) item.pctW = parseFloat(specW);
                    }
                    item.autoH = Math.abs(item.el.offsetHeight - Math.max(0, pbh - item.m.t - item.m.b)) < 1.5;
                    item.order = parseInt(prop(item.rec, 'order', '0'), 10) || 0;
                    item.finalW = item.w1;
                    // (items centred or at the end need their own width; so do content-sized tracks, below)
                    var jsv = ALIGN(prop(item.rec, 'justify-self', 'auto') === 'auto' ? prop(g.rec, 'justify-items', 'normal') : prop(item.rec, 'justify-self', 'auto'));
                    if (jsv === 'center' || jsv === 'end') g.needNat = true;
                    if (item.rec && (item.rec.props['grid-column-start'] || item.rec.props['grid-column-end'])) g.colPlaced = true;
                }
                var tcols = parseList(prop(g.rec, 'grid-template-columns', 'none'));
                var implicitCols = !tcols.length && (g.colPlaced || !/^none$/i.test(prop(g.rec, 'grid-template-areas', 'none')));
                if (intrinsicList(tcols) || (implicitCols && intrinsicList(parseList(prop(g.rec, 'grid-auto-columns', 'auto'))))) g.needNat = true;
                if (g.shrink) g.needNat = true;
            }
            // (a container that is an item of an outer grid is stretched to that grid's height right now: with an auto
            // height of its own it is not definite)
            for (i = 0; i < grids.length; i++) {
                g = grids[i];
                var asItem = g.el.__brGridItem && g.el.__brGridItem.pass === gen ? g.el.__brGridItem : null;
                if (asItem && asItem.autoH) { g.H = g.minH > 0 ? g.minH : null; g.minMode = g.minH > 0; }
            }
            // write, read: natural widths (shrink to fit) where they are needed
            var anyNat = false;
            for (i = 0; i < grids.length; i++) {
                g = grids[i];
                if (g.keepW) setStyle(g.el, 'width', (g.border ? g.keepW + g.pad.l + g.pad.r + g.border.h : g.keepW) + 'px');
                // (room for the items' natural widths while they are measured: a collapsed box would wrap their text)
                if (g.shrink) setStyle(g.el, 'width', '5000px');
                if (!g.needNat) continue;
                anyNat = true;
                for (j = 0; j < g.items.length; j++) { setStyle(g.items[j].el, 'right', 'auto'); setStyle(g.items[j].el, 'bottom', 'auto'); }
            }
            for (i = 0; i < grids.length; i++) {
                g = grids[i];
                // (fractional widths up, to the engine's 1/64 px: a track a fraction too narrow wraps its text; whole
                // pixels added up across the tracks of a content-sized grid)
                for (j = 0; j < g.items.length; j++) g.items[j].natW = g.needNat ? Math.ceil(g.items[j].el.getBoundingClientRect().width * 64 - 0.01) / 64 + g.items[j].m.l + g.items[j].m.r : 0;
            }
            stats.nat = anyNat;
            // placement and columns, outer grids first
            for (i = 0; i < byDepth.length; i++) {
                g = byDepth[i];
                // an inner grid's room: what its nearest ancestor that is an outer item gains or loses from the stretch
                if (g.depth > 0) {
                    for (var carrier = g.el; carrier && carrier.nodeType === 1 && !(carrier.__brGridItem && carrier.__brGridItem.gen === gen); carrier = carrier.parentNode) { /* up */ }
                    if (carrier && carrier.nodeType === 1) {
                        var ci = carrier.__brGridItem;
                        if (carrier === g.el) g.W = Math.max(0, ci.finalW - g.edges);
                        else g.W = Math.max(0, g.W + ci.finalW - ci.w1);
                    }
                }
                var r0 = g.rec, el = g.el;
                g.colGap = lengthPx(prop(r0, 'column-gap', '0').replace(/^normal$/i, '0'), el, g.W) || 0;
                g.rowGap = lengthPx(prop(r0, 'row-gap', '0').replace(/^normal$/i, '0'), el, g.H) || 0;
                var colList = parseList(prop(r0, 'grid-template-columns', 'none')), rowList = parseList(prop(r0, 'grid-template-rows', 'none'));
                var cx = expand(colList, hasAutoRepeat(colList) ? autoCount(colList, g.W, g.colGap, el) : 1);
                var rx = expand(rowList, hasAutoRepeat(rowList) ? autoCount(rowList, g.H, g.rowGap, el) : 1);
                var areas = parseAreas(prop(r0, 'grid-template-areas', 'none'));
                if (areas) {
                    while (cx.tracks.length < areas.cols) { cx.tracks.push(parseTrack('auto')); cx.lines.push([]); }
                    while (rx.tracks.length < areas.rows) { rx.tracks.push(parseTrack('auto')); rx.lines.push([]); }
                    for (var an in areas.areas) if (areas.areas.hasOwnProperty(an)) {
                        var ar = areas.areas[an];
                        cx.lines[ar.c0].push(an + '-start'); cx.lines[ar.c1].push(an + '-end');
                        rx.lines[ar.r0].push(an + '-start'); rx.lines[ar.r1].push(an + '-end');
                    }
                }
                var list = g.items.slice(0);
                for (j = 0; j < list.length; j++) list[j].idx = j;
                list.sort(function (x, y) { return x.order - y.order || x.idx - y.idx; });
                for (j = 0; j < list.length; j++) {
                    var ir = list[j].rec;
                    var ca = placeAxis(parseLine(prop(ir, 'grid-column-start', 'auto')), parseLine(prop(ir, 'grid-column-end', 'auto')), cx.lines);
                    var ra = placeAxis(parseLine(prop(ir, 'grid-row-start', 'auto')), parseLine(prop(ir, 'grid-row-end', 'auto')), rx.lines);
                    list[j].c = ca.start; list[j].cs = ca.span; list[j].r = ra.start; list[j].rs = ra.span;
                }
                var dims = placeItems(list, cx.tracks.length, /dense/i.test(prop(r0, 'grid-auto-flow', 'row')));
                // implicit tracks
                var autoCols = parseList(prop(r0, 'grid-auto-columns', 'auto')), autoRows = parseList(prop(r0, 'grid-auto-rows', 'auto'));
                var ac = expand(autoCols, 1).tracks, arw = expand(autoRows, 1).tracks;
                if (!ac.length) ac = [parseTrack('auto')];
                if (!arw.length) arw = [parseTrack('auto')];
                var explicitCols = cx.tracks.length, explicitRows = rx.tracks.length;
                for (j = cx.tracks.length; j < dims.cols; j++) cx.tracks.push(ac[(j - explicitCols) % ac.length]);
                for (j = rx.tracks.length; j < dims.rows; j++) rx.tracks.push(arw[(j - explicitRows) % arw.length]);
                // auto-fit: repeated tracks without items collapse (their gaps too): they leave the list before sizing
                if (cx.fit.length) {
                    var used = {}, keepIdx = [], newIdx = {};
                    for (j = 0; j < list.length; j++) for (var uc = list[j].c; uc < list[j].c + list[j].cs; uc++) used[uc] = true;
                    var fitSet = {};
                    for (j = 0; j < cx.fit.length; j++) fitSet[cx.fit[j]] = true;
                    for (j = 0; j < cx.tracks.length; j++) if (!fitSet[j] || used[j]) { newIdx[j] = keepIdx.length; keepIdx.push(j); }
                    if (keepIdx.length < cx.tracks.length) {
                        var keptTracks = [];
                        for (j = 0; j < keepIdx.length; j++) keptTracks.push(cx.tracks[keepIdx[j]]);
                        cx.tracks = keptTracks;
                        for (j = 0; j < list.length; j++) list[j].c = newIdx[list[j].c];
                    }
                    cx.fit = [];
                }
                g.cols = cx; g.rows = rx;
                var contrib = [];
                for (j = 0; j < list.length; j++) if (list[j].cs === 1) contrib[list[j].c] = Math.max(contrib[list[j].c] || 0, list[j].natW);
                var jc = prop(r0, 'justify-content', 'normal');
                // (a shrinking grid: the tracks take their content's widths, and the grid is as wide as they are)
                var sizes = sizeTracks(cx.tracks, g.shrink ? null : g.W, g.colGap, contrib, el, !g.shrink && /^(normal|stretch)$/i.test(jc));
                var total = 0;
                for (j = 0; j < sizes.length; j++) total += sizes[j];
                total += Math.max(0, sizes.length - 1) * g.colGap;
                if (g.shrink) g.W = total;
                var dj = distribute(jc, g.W - total, sizes.length);
                g.colSizes = sizes;
                g.colPos = offsets(sizes, g.colGap, g.pad.l + dj[0], dj[1]);
                g.colGapX = g.colGap + dj[1];
                g.list = list;
                g.justifyItems = prop(r0, 'justify-items', 'normal');
                g.alignItems = prop(r0, 'align-items', 'normal');
                g.alignContent = prop(r0, 'align-content', 'normal');
                // the items' widths and left edges (written below, all at once)
                for (j = 0; j < list.length; j++) {
                    it = list[j];
                    var areaW = spanSize(g.colSizes, g.colPos, it.c, it.cs, g.colGapX);
                    var js = ALIGN(prop(it.rec, 'justify-self', 'auto') === 'auto' ? g.justifyItems : prop(it.rec, 'justify-self', 'auto'));
                    var outerW = it.natW || it.w1 + it.m.l + it.m.r, x = g.colPos[it.c] !== undefined ? g.colPos[it.c] : g.pad.l;
                    it.setW = null;
                    if (it.pctW !== null) {
                        it.setW = Math.max(0, areaW * it.pctW / 100);
                        it.finalW = it.setW + it.box.h;
                        outerW = it.finalW + it.m.l + it.m.r;
                    }
                    if (stretches(js, it.el) && it.autoW) {
                        it.setW = Math.max(0, areaW - it.m.l - it.m.r - it.box.h);
                        it.finalW = Math.max(0, areaW - it.m.l - it.m.r);
                    } else if (js === 'center') x += (areaW - outerW) / 2;
                    else if (js === 'end') x += areaW - outerW;
                    it.x = Math.round(x * 100) / 100;
                    it.areaW = areaW;
                    it.gen = gen;
                }
            }
            // write: widths and left edges
            for (i = 0; i < grids.length; i++) {
                g = grids[i];
                if (g.shrink) setStyle(g.el, 'width', Math.ceil(g.border ? g.W + g.pad.l + g.pad.r + g.border.h : g.W) + 'px');
                for (j = 0; j < g.list.length; j++) {
                    it = g.list[j];
                    if (it.setW !== null) setStyle(it.el, 'width', Math.round(it.setW * 64) / 64 + 'px');
                    setStyle(it.el, 'left', it.x + 'px');
                    if (!g.needNat) { setStyle(it.el, 'right', 'auto'); setStyle(it.el, 'bottom', 'auto'); }
                }
            }
            var t2 = Date.now();
            stats.downMs = t2 - t1;
            // rows, bottom-up (an item holding a grid is measured after that grid has its height)
            for (L = maxDepth; L >= 0; L--) {
                lv = level(L);
                for (i = 0; i < lv.length; i++) {
                    g = lv[i];
                    for (j = 0; j < g.list.length; j++) g.list[j].natH = Math.ceil(g.list[j].el.getBoundingClientRect().height - 0.01) + g.list[j].m.t + g.list[j].m.b;
                }
                for (i = 0; i < lv.length; i++) {
                    g = lv[i];
                    var rcontrib = [], k2;
                    for (j = 0; j < g.list.length; j++) if (g.list[j].rs === 1) rcontrib[g.list[j].r] = Math.max(rcontrib[g.list[j].r] || 0, g.list[j].natH);
                    var rsizes = sizeTracks(g.rows.tracks, g.H, g.rowGap, rcontrib, g.el, /^(normal|stretch)$/i.test(g.alignContent), true);
                    // items over several rows: what does not fit goes to their auto rows
                    for (j = 0; j < g.list.length; j++) {
                        it = g.list[j];
                        if (it.rs < 2) continue;
                        var have = (it.rs - 1) * g.rowGap, autos = [];
                        for (k2 = it.r; k2 < it.r + it.rs && k2 < rsizes.length; k2++) { have += rsizes[k2]; if (g.rows.tracks[k2].max.k !== 'len') autos.push(k2); }
                        if (it.natH > have + 0.5) {
                            if (!autos.length) autos.push(Math.min(rsizes.length, it.r + it.rs) - 1);
                            for (k2 = 0; k2 < autos.length; k2++) rsizes[autos[k2]] += (it.natH - have) / autos.length;
                        }
                    }
                    var rtotal = 0;
                    for (j = 0; j < rsizes.length; j++) rtotal += rsizes[j];
                    rtotal += Math.max(0, rsizes.length - 1) * g.rowGap;
                    var dA = g.H !== null ? distribute(g.alignContent, g.H - rtotal, rsizes.length) : [0, 0];
                    g.rowSizes = rsizes;
                    g.rowPos = offsets(rsizes, g.rowGap, g.pad.t + dA[0], dA[1]);
                    g.rowGapX = g.rowGap + dA[1];
                    // (a height that only comes from min-height grows with rows that need more)
                    g.contentH = g.H === null || (g.minMode && rtotal > g.H + 0.5) ? rtotal : null;
                }
                for (i = 0; i < lv.length; i++) {
                    g = lv[i];
                    for (j = 0; j < g.list.length; j++) {
                        it = g.list[j];
                        var areaH = spanSize(g.rowSizes, g.rowPos, it.r, it.rs, g.rowGapX);
                        var as = ALIGN(prop(it.rec, 'align-self', 'auto') === 'auto' ? g.alignItems : prop(it.rec, 'align-self', 'auto'));
                        var y = g.rowPos[it.r] !== undefined ? g.rowPos[it.r] : g.pad.t;
                        if (stretches(as, it.el) && it.autoH) setStyle(it.el, 'height', Math.max(0, areaH - it.m.t - it.m.b - it.box.v) + 'px');
                        else if (as === 'center') y += (areaH - it.natH) / 2;
                        else if (as === 'end') y += areaH - it.natH;
                        setStyle(it.el, 'top', Math.round(y * 100) / 100 + 'px');
                    }
                    if (g.contentH !== null) setStyle(g.el, 'height', Math.ceil(g.contentH + (g.border ? g.pad.t + g.pad.b + g.border.v : 0)) + 'px');
                    stats.items += g.list.length;
                }
            }
            stats.upMs = Date.now() - t2;
            stats.levels = maxDepth + 1;
            stats.grids = grids.length;
            // elements laid out before and not now (a media query, a removed rule) get their own styles back
            var keep = [];
            for (i = 0; i < touched.length; i++) {
                if (touched[i].__brGridGen === gen) keep.push(touched[i]);
                else restore(touched[i]);
            }
            touched = keep;
        };
        var running = false;
        // (nothing changed since the last pass: as many elements in the page, the grids with their classes and widths,
        // their items with theirs and their sizes as the pass left them: the pass is skipped, collection and all; a
        // pass cost 2.3 s on bbc.com, 286 grids, and style passes come with every change of the page)
        var lastSig = null, lastGrids = null, lastFull = 0, allEls = document.getElementsByTagName('*');
        var gridSignature = function () {
            if (!lastGrids) return null;
            var s = [window.innerWidth, allEls.length], i, g, c;
            for (i = 0; i < lastGrids.length; i++) {
                g = lastGrids[i];
                if (!g.parentNode) return null;
                s.push(g.className, g.clientWidth, g.childElementCount);
                for (c = g.firstElementChild; c; c = c.nextElementSibling) s.push(c.className, c.offsetWidth, c.offsetHeight);
            }
            return s.join('|');
        };
        var apply = function () {
            if (running || (!entries.length && !touched.length)) return;
            // (at least every 10 s a whole pass all the same: a grid made by a class change alone is not in the signature)
            var sig = gridSignature(), t0 = Date.now();
            if (sig !== null && sig === lastSig && t0 - lastFull < 10000) { stats.skipped = (stats.skipped || 0) + 1; return; }
            lastFull = t0;
            running = true;
            try { layoutAll(); } catch (e) { if (window.console && console.error) console.error(e); }
            running = false;
            stats.passes++;
            stats.ms = Date.now() - t0;
            lastGrids = [];
            for (var i = 0; i < touched.length; i++) if (touched[i].__brGridNow === gen) lastGrids.push(touched[i]);
            lastSig = gridSignature();
        };
        // a picture that loads in a grid item changes its height
        document.addEventListener('load', function (e) {
            var t = e.target;
            if (!t || t.tagName !== 'IMG' || !touched.length) return;
            for (var a = t.parentNode; a && a.nodeType === 1; a = a.parentNode) {
                if (a.__brGridSaved) { if (!apply.timer) apply.timer = setTimeout(function () { apply.timer = null; apply(); }, 150); return; }
            }
        }, true);
        window.__brGrid = {
            setManifest: function (m) { entries = (m && m.gd) || []; prepared = null; },
            apply: apply,
            state: function () { return stats; }
        };
    })();
    // ---- The CSS rewriter inside the page (cssfix.js, loaded on first use): values computed here and styles that
    // scripts insert go through the same conversions as the stylesheets did
    var cssFixLib = null, cssFixTried = false;
    var loadCSSFix = function () {
        if (window.CSSFix) return window.CSSFix;
        if (cssFixTried) return cssFixLib;
        cssFixTried = true;
        try {
            var x = new XMLHttpRequest();
            x.open('GET', 'https://ios6-browser.invalid/cssfix.js', false);
            x.send(null);
            if (x.status === 200 && x.responseText) {
                (0, eval)(x.responseText);   // global scope: defines window.CSSFix
                cssFixLib = window.CSSFix || null;
            }
        } catch (e) { cssFixLib = null; }
        return cssFixLib;
    };
    window.__brLoadCSSFix = loadCSSFix;
    // ---- Custom properties per element (manifest "cv", see registerVarRule in cssfix.js). The rewriter substituted a
    // single value for every var(); where a custom property has several definitions (component variants, themes, media
    // queries, style attributes) each element's value is computed here: the winner of the cascade among the definitions
    // that match the element, or else its parent's value. Declarations that come out different from the substituted
    // value are set inline (on ::before/::after through generated rules), unless another rule wins that property.
    (function () {
        var rules = [], registered = {}, rootVars = {}, gen = 0, tracked = [], timer = null, busy = false, lastCost = 0, universal = {};
        var watchStates = false, observer = null, classObserver = null, feedRecords = null, fixCache = {}, fixCacheSize = 0, pseudoStyle = null, pseudoText = '', pseudoSeq = 0;
        var pseudoTracked = [], stats = { passes: 0, applied: 0, skipped: 0, rules: 0 };
        var trim = function (s) { return String(s).trim(); };
        var norm = function (s) { return trim(String(s)).replace(/\s+/g, ' ').replace(/\s*([,()\/])\s*/g, '$1').toLowerCase(); };
        var matchParen = function (s, i) {
            var depth = 0;
            for (var k = i; k < s.length; k++) { var c = s.charAt(k); if (c === '(') depth++; else if (c === ')') { depth--; if (!depth) return k; } }
            return s.length;
        };
        var topComma = function (s) {
            var depth = 0;
            for (var k = 0; k < s.length; k++) { var c = s.charAt(k); if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && !depth) return k; }
            return -1;
        };
        // name(...) -> fn(inner); null from fn makes the whole value invalid
        var replaceFn = function (s, name, fn) {
            if (s === null) return null;
            var out = '', i = 0, lower = s.toLowerCase(), key = name + '(';
            while (i < s.length) {
                var at = lower.indexOf(key, i);
                while (at > 0 && /[\w-]/.test(lower.charAt(at - 1))) at = lower.indexOf(key, at + 1);
                if (at < 0) { out += s.slice(i); break; }
                var close = matchParen(s, at + name.length);
                var r = fn(s.slice(at + key.length, close));
                if (r === null || r === undefined) return null;
                out += s.slice(i, at) + r;
                i = close + 1;
            }
            return out;
        };
        var INHERITED = /^(color|font(-.*)?|line-height|letter-spacing|word-spacing|text-(align|align-last|indent|transform|shadow|rendering|justify|underline-position|emphasis.*|size-adjust|decoration-skip.*)|white-space|visibility|cursor|list-style(-.*)?|quotes|direction|border-collapse|border-spacing|caption-side|empty-cells|orphans|widows|tab-size|hyphens|word-break|overflow-wrap|word-wrap|writing-mode|fill(-.*)?|stroke(-.*)?|paint-order|color-scheme|accent-color|caret-color|pointer-events|-webkit-text-fill-color|-webkit-text-stroke.*)$/i;
        var LONGHANDS = (function () {
            var sides = ['top', 'right', 'bottom', 'left'], m = {}, i;
            var each = function (fmt) { var out = []; for (var s = 0; s < 4; s++) out.push(fmt.replace('*', sides[s])); return out; };
            m.margin = each('margin-*'); m.padding = each('padding-*');
            m['border-color'] = each('border-*-color'); m['border-style'] = each('border-*-style'); m['border-width'] = each('border-*-width');
            m.border = m['border-color'].concat(m['border-style'], m['border-width']);
            for (i = 0; i < 4; i++) m['border-' + sides[i]] = ['border-' + sides[i] + '-color', 'border-' + sides[i] + '-style', 'border-' + sides[i] + '-width'];
            m['border-radius'] = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
            m.background = ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat'];
            m.font = ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family'];
            m.outline = ['outline-color', 'outline-style', 'outline-width'];
            m['list-style'] = ['list-style-type', 'list-style-position', 'list-style-image'];
            m.transition = ['-webkit-transition-property', '-webkit-transition-duration', '-webkit-transition-timing-function', '-webkit-transition-delay'];
            m['-webkit-transition'] = m.transition;
            m.overflow = ['overflow-x', 'overflow-y'];
            m['text-decoration'] = ['text-decoration'];
            m['-webkit-mask'] = ['-webkit-mask-image', '-webkit-mask-position', '-webkit-mask-size', '-webkit-mask-repeat'];
            m['-webkit-column-rule'] = ['-webkit-column-rule-color', '-webkit-column-rule-style', '-webkit-column-rule-width'];
            return m;
        })();
        // ---- selectors: the pseudo-element is cut off (the shim finds its element), classes the selector needs are kept
        // so that rules for components missing from the page cost nothing
        var PSEUDO_EL = /(::?(?:before|after|first-line|first-letter)|::(?:marker|placeholder|selection|backdrop|-webkit-[\w-]+))$/i;
        var unescapeCSS = function (s) { return s.replace(/\\([0-9a-fA-F]{1,6})\s?/g, function (a, h) { return String.fromCharCode(parseInt(h, 16)); }).replace(/\\(.)/g, '$1'); };
        var prepareSelector = function (sel) {
            var s = trim(sel), pseudo = null, m = PSEUDO_EL.exec(s);
            if (m) { pseudo = m[1].replace(/^:(?!:)/, '::').toLowerCase(); s = trim(s.slice(0, m.index)) || '*'; if (/[\s>+~]$/.test(s)) s += '*'; }
            var req = [], stripped = s.replace(/\[[^\]]*\]/g, ' ').replace(/:(not|-webkit-any|is|where|matches|has)\((?:[^()]|\([^()]*\))*\)/gi, ' '), re = /\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)/g, cm;
            while ((cm = re.exec(stripped)) !== null) req.push(unescapeCSS(cm[1]));
            var state = /:(hover|active|focus|checked|target|enabled|disabled|valid|invalid|indeterminate)/i.test(s);
            if (state) watchStates = true;
            var attrRe = /\[\s*([\w-]+)/g, am;
            while ((am = attrRe.exec(s)) !== null) attrNames[am[1].toLowerCase()] = 1;
            return { base: s, pseudo: pseudo, req: req, state: state };
        };
        // attributes whose changes can change what the selectors match ("style" only when a selector looks at it:
        // scripts animating inline styles would otherwise start a pass every frame)
        var attrNames = { 'class': 1, id: 1, open: 1, hidden: 1, disabled: 1, checked: 1, selected: 1 };
        var docClasses = function () {
            var set = {}, all = document.getElementsByTagName('*');
            for (var i = 0; i < all.length; i++) {
                var c = all[i].className;
                if (typeof c !== 'string') c = c && typeof c.baseVal === 'string' ? c.baseVal : '';
                if (!c) continue;
                var parts = c.split(/\s+/);
                for (var k = 0; k < parts.length; k++) if (parts[k]) set[parts[k]] = 1;
            }
            return set;
        };
        var possible = function (req, classes) { for (var i = 0; i < req.length; i++) if (!classes[req[i]]) return false; return true; };
        var beats = function (a, b) { return (a.i && !b.i) || (!!a.i === !!b.i && (a.sp > b.sp || (a.sp === b.sp && a.o >= b.o))); };
        // ---- the value of custom property `name` on `el` (null: guaranteed-invalid)
        var initialOf = function (name) {
            if (registered[name]) return registered[name].init;
            return rootVars.hasOwnProperty(name) ? rootVars[name] : null;
        };
        var resolveVar = function (el, name, depth) {
            if (!el || el.nodeType !== 1 || depth > 80) return initialOf(name);
            var memo = el.__brCVm;
            if (!memo || memo.g !== gen) memo = el.__brCVm = { g: gen, v: {} };
            if (memo.v.hasOwnProperty(name)) return memo.v[name];
            memo.v[name] = null;   // a reference cycle makes the property invalid
            var rec = el.__brCV, own = rec && rec.g === gen ? rec.d[name] : null, val, uni = universal[name];
            if (uni && (!own || beats(uni, own))) own = uni;
            // the style attribute (and style.setProperty of scripts, the later write) beats the stylesheets, unless a
            // rule has !important and the inline declaration does not
            var inl = el.__brCVi, cs0 = el.style, cp = cs0 && cs0.__brCP, iv, ii = false;
            if (cp && cp.hasOwnProperty(name)) { iv = cp[name]; ii = !!(cs0.__brCPi && cs0.__brCPi[name]); }
            else if (inl && inl.d.hasOwnProperty(name)) { iv = inl.d[name]; ii = !!inl.di[name]; }
            if (iv !== undefined && iv !== null && (!own || !own.i || ii)) own = { v: iv };
            // CSS-wide keywords: initial is the guaranteed-invalid value (or the registered initial value), inherit and
            // unset take the parent's value
            var kw = own ? trim(own.v).toLowerCase() : '';
            if (kw === 'inherit' || kw === 'unset' || kw === 'revert' || kw === 'revert-layer') own = null;
            if (kw === 'initial') val = registered[name] ? registered[name].init : null;
            else if (own) val = substitute(own.v, el, depth + 1);
            else if (registered[name] && !registered[name].inh) val = registered[name].init;
            else val = el.parentNode && el.parentNode.nodeType === 1 ? resolveVar(el.parentNode, name, depth + 1) : initialOf(name);
            if ((val === null || val === undefined) && registered[name]) val = registered[name].init;
            memo.v[name] = val === undefined ? null : val;
            return memo.v[name];
        };
        var substitute = function (v, el, depth) {
            if (v === null || v === undefined) return null;
            depth = depth || 0;
            if (v.indexOf('var(') >= 0) v = replaceFn(v, 'var', function (inner) {
                var c = topComma(inner), name = trim(c < 0 ? inner : inner.slice(0, c));
                var r = resolveVar(el, name, depth);
                if (r === null) r = c < 0 ? null : substitute(trim(inner.slice(c + 1)), el, depth + 1);
                return r;
            });
            if (v !== null && v.indexOf('inherit(') >= 0) v = replaceFn(v, 'inherit', function (inner) {
                var c = topComma(inner), name = trim(c < 0 ? inner : inner.slice(0, c));
                var parent = el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null;
                var r = parent ? resolveVar(parent, name, depth) : initialOf(name);
                if (r === null) r = c < 0 ? null : substitute(trim(inner.slice(c + 1)), el, depth + 1);
                return r;
            });
            return v;
        };
        // ---- a declaration through the page's copy of the rewriter: [[property, value, important]]
        var fixDecl = function (p, v) {
            // (viewport units become pixels of the current orientation)
            var land = window.orientation === 90 || window.orientation === -90, key = (land ? 'L' : 'P') + p + ':' + v;
            if (fixCache.hasOwnProperty(key)) return fixCache[key];
            var out = [], lib = loadCSSFix();
            if (!lib) out.push([p, v]);
            else {
                var text = '';
                try {
                    if (lib.setViewport) lib.setViewport(land ? 'landscape' : 'portrait');
                    text = lib.fixInlineStyle(p + ':' + v, lib.makeContext(null));
                } catch (e) { text = p + ':' + v; }
                var parts = text.split(';');
                for (var i = 0; i < parts.length; i++) {
                    var c = parts[i].indexOf(':');
                    if (c < 0) continue;
                    var dp = trim(parts[i].slice(0, c)), dv = trim(parts[i].slice(c + 1).replace(/\s*!important\s*$/i, ''));
                    if (!dp || (dp === 'counter-reset' && /^(br-[\w-]+\s+\d+\s*)+$/.test(dv))) continue;   // rewriter markers
                    if (/^--/.test(dp)) continue;
                    out.push([dp, dv]);
                }
            }
            if (fixCacheSize > 3000) { fixCache = {}; fixCacheSize = 0; }
            fixCache[key] = out;
            fixCacheSize++;
            return out;
        };
        // ---- inline styles we set, with what the page had there
        var setInline = function (el, p, v, imp) {
            if (calcRisk(p, v)) {
                // a calc length in a property the page transitions: its px value instead (the element is frozen here)
                var px = calcToPx(el, p, v, imp);
                if (px) for (var q = 0; q < px.length; q++) setInline(el, px[q][0], px[q][1], imp);
                return;
            }
            if (!el.__brCVOrig) { el.__brCVOrig = {}; el.__brCVSet = {}; el.__brCVVal = {}; tracked.push(el); }
            // (through styleGet & co., see there; the page's value read once when it is kept)
            var st = el.style, pr = imp ? 'important' : '', kept = el.__brCVOrig.hasOwnProperty(p) ? null : (el.__brCVOrig[p] = [styleGet(st, p), stylePriority(st, p)]);
            el.__brCVSet[p] = gen;
            if ((kept ? kept[0] : styleGet(st, p)) !== v || (kept ? kept[1] : stylePriority(st, p)) !== pr) styleSet(st, p, v, pr);
            el.__brCVVal[p] = styleGet(st, p);   // as the engine serialises it
        };
        var restoreInline = function (el, p) {
            if (!el.__brCVSet || !el.__brCVSet.hasOwnProperty(p)) return;
            var o = el.__brCVOrig[p], st = el.style;
            // a script set its own value over ours meanwhile: that one stays
            if (styleGet(st, p) === el.__brCVVal[p]) { if (o && o[0]) styleSet(st, p, o[0], o[1]); else styleRemove(st, p); }
            delete el.__brCVSet[p];
            delete el.__brCVOrig[p];
            delete el.__brCVVal[p];
        };
        var restoreStale = function () {
            var keep = [];
            for (var i = 0; i < tracked.length; i++) {
                var el = tracked[i], set = el.__brCVSet, any = false;
                for (var p in set) {
                    if (!set.hasOwnProperty(p)) continue;
                    if (set[p] === gen) { any = true; continue; }
                    restoreInline(el, p);
                }
                if (any) keep.push(el); else { el.__brCVOrig = null; el.__brCVSet = null; el.__brCVVal = null; }
            }
            tracked = keep;
        };
        // ---- style attributes: custom properties defined there and declarations using them (the rewriter keeps
        // both in the attribute; the engine ignores them), and custom properties set with style.setProperty()
        var inlineEls = [], cpUsed = false;
        var parseInline = function (el) {
            var attr = el.getAttribute('style') || '';
            var cache = el.__brCVi;
            // once we (or anything else) changed the style, the engine serialises it without the declarations it does
            // not know: the parsed ones stay until the page writes new custom properties or var()s into the attribute
            if (cache && (cache.attr === attr || !/--|var\(|inherit\(/.test(attr))) return cache;
            var info = { attr: attr, out: null, d: {}, di: {}, u: [] }, parts = attr.split(';'), statics = {};
            for (var i = 0; i < parts.length; i++) {
                var c = parts[i].indexOf(':');
                if (c < 0) continue;
                var p = trim(parts[i].slice(0, c)), v = trim(parts[i].slice(c + 1)), imp = /!important\s*$/i.test(v);
                v = trim(v.replace(/\s*!important\s*$/i, ''));
                if (p.indexOf('--') === 0) { info.d[p] = v; if (imp) info.di[p] = 1; continue; }   // custom property names keep their case
                p = p.toLowerCase();
                if (/(^|[^\w-])(var|inherit)\(/i.test(v)) info.u.push({ p: p, v: v, st: statics.hasOwnProperty(p) ? statics[p] : null, i: imp, sp: 1e8, o: 1e9, ps: null, inl: true });
                else statics[p] = v;
            }
            if (!el.__brCVi) inlineEls.push(el);
            el.__brCVi = info;
            try { el.style.__brOwner = el; } catch (e) {}   // style.getPropertyValue('--x') answers from the attribute
            return info;
        };
        // a style attribute with custom properties, var() or inherit() that is new or changed since it was read (the
        // engine writes an attribute out again without them once anything changes it: that is no change)
        var INLINE_CV = /--|var\(|inherit\(/;
        var inlineChanged = function () {
            var list, i, el, attr;
            try { list = document.querySelectorAll('[style*="--"], [style*="var("], [style*="inherit("]'); } catch (e) { return true; }
            for (i = 0; i < list.length; i++) {
                el = list[i];
                attr = el.getAttribute('style') || '';
                if (!el.__brCVi || (el.__brCVi.attr !== attr && INLINE_CV.test(attr))) return true;
            }
            return false;
        };
        // ---- one pass over the page
        var lastPending = [];
        var run = function () {
            gen++;
            stats.passes++;
            stats.dirty = dirtyAll ? dirtyWhy : dirtyRoots.length + ' changed' + (dirtyWhy ? ', ' + dirtyWhy : '');
            // (for the debug log: the biggest changed subtree)
            if (!dirtyAll && dirtyRoots.length) {
                var big = null, bigN = -1;
                for (i = 0; i < dirtyRoots.length; i++) { var nn = dirtyRoots[i].getElementsByTagName('*').length; if (nn > bigN) { bigN = nn; big = dirtyRoots[i]; } }
                var bc = big.getAttribute('class');
                stats.dirty += ' (' + big.tagName.toLowerCase() + (big.id ? '#' + big.id : '') + (bc ? '.' + bc.split(/\s+/)[0].slice(0, 30) : '') + ' ' + bigN + ')';
            }
            var tRun = Date.now();
            var classes = docClasses(), mediaCache = {}, users = [], i, b, k, r, list, el, rec;
            var docMs = Date.now() - tRun, qsaN = 0, qsaMs = 0, qsaEls = 0, q0;
            var mediaOk = function (m) {
                if (!m) return true;
                for (var j = 0; j < m.length; j++) {
                    var q = m[j];
                    if (!mediaCache.hasOwnProperty(q)) { try { mediaCache[q] = window.matchMedia(q).matches; } catch (e) { mediaCache[q] = false; } }
                    if (!mediaCache[q]) return false;
                }
                return true;
            };
            var recOf = function (e2) { var rc = e2.__brCV; if (!rc || rc.g !== gen) rc = e2.__brCV = { g: gen, d: {}, u: {}, user: false }; return rc; };
            var matched = 0, stateNow = [], stateNowSub = [];
            universal = {};
            for (i = 0; i < rules.length; i++) {
                r = rules[i];
                if (!r.s || !mediaOk(r.m)) continue;
                for (b = 0; b < r.sel.length; b++) {
                    var sel = r.sel[b];
                    if (!possible(sel.req, classes)) continue;
                    // a rule for every element that only defines custom properties (Tailwind's `*, ::before, ::after`
                    // with 40 --tw-* properties): one entry that holds wherever no other rule wins, not 40 records per
                    // element (nextjs.org: 200,000, a second of every pass)
                    if (sel.base === '*' && !sel.pseudo && r.d && !r.u) {
                        matched++;
                        for (var ud = 0; ud < r.d.length; ud++) {
                            var uv = { v: r.d[ud][1], sp: r.sp ? r.sp[b] : 0, o: r.o, i: r.d[ud][2] }, uc = universal[r.d[ud][0]];
                            if (!uc || beats(uv, uc)) universal[r.d[ud][0]] = uv;
                        }
                        continue;
                    }
                    q0 = Date.now();
                    try { list = document.querySelectorAll(sel.base); } catch (x) { continue; }
                    qsaMs += Date.now() - q0;
                    qsaN++;
                    qsaEls += list.length;
                    if (list.length) matched++;
                    if (sel.state) for (k = 0; k < list.length; k++) { stateNow.push(list[k]); stateNowSub.push(!!(r.d && r.d.length)); }
                    var spec = r.sp ? r.sp[b] : 0;
                    for (k = 0; k < list.length; k++) {
                        el = list[k];
                        rec = recOf(el);
                        if (r.d && !sel.pseudo) {
                            for (var d = 0; d < r.d.length; d++) {
                                var cd = { v: r.d[d][1], sp: spec, o: r.o, i: r.d[d][2] }, curD = rec.d[r.d[d][0]];
                                if (!curD || beats(cd, curD)) rec.d[r.d[d][0]] = cd;
                            }
                        }
                        if (r.u) {
                            if (!rec.user) { rec.user = true; users.push(el); }
                            for (var u = 0; u < r.u.length; u++) {
                                var key = (sel.pseudo || '') + '|' + r.u[u][0];
                                var cu = { p: r.u[u][0], v: r.u[u][1], st: r.u[u][3], sp: spec, o: r.o, i: r.u[u][2], ps: sel.pseudo, sel: sel.base, rk: r.key }, curU = rec.u[key];
                                if (!curU || beats(cu, curU)) rec.u[key] = cu;
                            }
                        }
                    }
                }
            }
            stats.rules = matched;
            stateEls = stateNow;
            stateSub = stateNowSub;
            stats.tCollect = Date.now() - tRun;
            stats.collectParts = [docMs, rules.length, qsaN, qsaMs, qsaEls];
            // style attributes (and style.setProperty('--x') of scripts)
            var inl = [], seen = [];
            try { inl = document.querySelectorAll('[style*="--"], [style*="var("], [style*="inherit("]'); } catch (x2) {}
            for (i = 0; i < inl.length; i++) seen.push(inl[i]);
            var root = document.documentElement, keepInline = [];
            for (i = 0; i < inlineEls.length; i++) if (root.contains(inlineEls[i])) { keepInline.push(inlineEls[i]); seen.push(inlineEls[i]); }
            inlineEls = keepInline;
            if (cpUsed) {
                var every = document.getElementsByTagName('*'), est;
                for (i = 0; i < every.length; i++) {
                    est = every[i].style;
                    if (!est || !est.__brCP) continue;
                    seen.push(every[i]);
                    // (a script set a custom property here since the last pass: this subtree is redone, not the page)
                    if (est.__brCPdirty) { est.__brCPdirty = false; markDirty(every[i]); }
                }
            }
            for (i = 0; i < seen.length; i++) {
                el = seen[i];
                if (el.__brCVs === gen) continue;
                el.__brCVs = gen;
                var info = parseInline(el);
                if (info.u.length) {
                    rec = recOf(el);
                    if (!rec.user) { rec.user = true; users.push(el); }
                    for (k = 0; k < info.u.length; k++) { var ikey = '|' + info.u[k].p, icur = rec.u[ikey]; if (!icur || beats(info.u[k], icur)) rec.u[ikey] = info.u[k]; }
                }
            }
            stats.tInline = Date.now() - tRun - stats.tCollect;
            // what each user of a scoped property gets (an element nothing changed around keeps what it got last time)
            var pending = [], reused = 0, redone = 0, subMs = 0, normMs = 0, s0;
            for (i = 0; i < users.length; i++) {
                el = users[i];
                rec = el.__brCV;
                var oldRaw = el.__brCVr, prevRaw = isDirty(el) ? null : oldRaw, nextRaw = {};
                for (var ukey in rec.u) {
                    if (!rec.u.hasOwnProperty(ukey)) continue;
                    var use = rec.u[ukey], raw, same, pr = prevRaw && prevRaw.hasOwnProperty(ukey) ? prevRaw[ukey] : null;
                    if (pr && pr.v === use.v) { raw = pr.raw; reused++; }
                    else {
                        redone++;
                        s0 = Date.now();
                        raw = substitute(use.v, el, 0);
                        subMs += Date.now() - s0;
                        if (raw === null) raw = INHERITED.test(use.p) ? 'inherit' : 'initial';   // invalid at computed-value time
                    }
                    // (the comparison with the stylesheet's value is kept with the value: thousands of norm() calls a pass)
                    var old = oldRaw && oldRaw.hasOwnProperty(ukey) ? oldRaw[ukey] : null;
                    if (old && old.raw === raw && old.st === use.st) same = old.same;
                    else { s0 = Date.now(); same = use.st !== null && use.st !== undefined && norm(raw) === norm(use.st); normMs += Date.now() - s0; }
                    nextRaw[ukey] = { v: use.v, raw: raw, st: use.st, same: same };
                    if (same) continue;   // the stylesheet already has it
                    pending.push({ el: el, use: use, raw: raw, key: ukey });
                }
                el.__brCVr = nextRaw;
            }
            pending.sort(function (a, c) { return a.use.sp - c.use.sp || a.use.o - c.use.o; });
            stats.tResolve = Date.now() - tRun;
            stats.resolveParts = [stats.tInline, users.length, reused, redone, subMs, normMs];
            lastPending = pending;
            var t1 = Date.now();
            apply(pending);
            writePseudo();
            stats.tApply = Date.now() - t1;
            stats.pending = pending.length;
            dirtyAll = false;
            dirtyRoots = [];
            dirtyWhy = '';
            dirtyEls = false;
            cpDirty = false;
            dirtyStamp++;
        };
        // ---- decisions of earlier passes stay while nothing that can change an element's rules happened around it
        // (a class or attribute of the element, an ancestor or a sibling, children added or removed)
        var dirtyAll = true, dirtyRoots = [], dirtyWhy = 'start', stateEls = [], stateSub = [], dirtyStamp = 1, dirtyEls = false, cpDirty = false;
        var isDirty = function (el) {
            if (dirtyAll || el.__brCVdirty === dirtyStamp) return true;
            for (var i = 0; i < dirtyRoots.length; i++) { var r = dirtyRoots[i]; if (r === el || r.contains(el)) return true; }
            return false;
        };
        var markDirty = function (node) {
            if (!node || node.nodeType !== 1 || dirtyRoots.length > 40) { dirtyAll = true; dirtyWhy = dirtyRoots.length > 40 ? 'many changes' : 'a node'; return; }
            for (var i = 0; i < dirtyRoots.length; i++) if (dirtyRoots[i] === node || dirtyRoots[i].contains(node)) return;
            dirtyRoots.push(node);
        };
        // the element alone (a rule that only uses custom properties changes nothing its subtree inherits)
        var markDirtyEl = function (el) { if (el && el.nodeType === 1) { el.__brCVdirty = dirtyStamp; dirtyEls = true; } };
        // ---- the rule's substituted value as the engine computes it, on a hidden probe (values that depend on the
        // element - em, %, currentColor, auto, line-height - are measured on the element itself instead)
        var probe = null, probeCache = {}, probeCacheSize = 0;
        var CONTEXT_VALUE = /(\d|\.)(em|ex|ch|lh|cap|ic)\b|%|currentcolor|inherit|initial|unset|auto|var\(|attr\(/i;
        var PROBE_BASE = 'position:absolute;visibility:hidden;left:-9999px;top:0;border-style:solid;outline-style:solid;';
        var probeValues = function (fb, props) {
            var key = JSON.stringify(fb) + '|' + props.join(',');
            if (probeCache.hasOwnProperty(key)) return probeCache[key];
            var i, vals = [];
            for (i = 0; i < fb.length; i++) if (CONTEXT_VALUE.test(fb[i][1]) || /line-height|^font$/.test(fb[i][0])) vals = null;
            if (vals) {
                if (!probe) { probe = document.createElement('div'); probe.__brOwn = true; }
                // (under <html>, not in <body>: React 19 would take a <div> there for one of its own when it hydrates)
                if (!probe.parentNode) document.documentElement.appendChild(probe);
                probe.style.cssText = PROBE_BASE;
                for (i = 0; i < fb.length; i++) probe.style.setProperty(fb[i][0], fb[i][1], '');
                var cs = getComputedStyle(probe);
                for (i = 0; i < props.length; i++) vals.push(cs.getPropertyValue(props[i]));
            }
            if (probeCacheSize > 2000) { probeCache = {}; probeCacheSize = 0; }
            probeCache[key] = vals;
            probeCacheSize++;
            return vals;
        };
        // ---- setting the values: another rule may win the property on this element (a site's own override), so the
        // value the rule has in the stylesheet is compared with what the element computes before ours goes in
        // transitions are held while the values are measured and set (a running transition shows the old value).
        // (Any style change like this one crashed WebKit on seznam.cz until cssfix kept -webkit-calc lengths out of the
        // transition lists, see guardCalcTransitions.)
        var frozen = [];
        // (the engine's own style methods: 'none' and the engine's own serialisation need no transition guard)
        var freeze = function (el) {
            if (el.__brCVfz) return;
            var st = el.style;
            el.__brCVfz = [esGet.call(st, '-webkit-transition-property'), esPri.call(st, '-webkit-transition-property')];
            esSet.call(st, '-webkit-transition-property', 'none', 'important');
            frozen.push(el);
        };
        var thaw = function () {
            for (var i = 0; i < frozen.length; i++) getComputedStyle(frozen[i]).color;   // commit the values first
            for (var k = 0; k < frozen.length; k++) {
                var el = frozen[k], o = el.__brCVfz;
                el.__brCVfz = null;
                if (o && o[0]) esSet.call(el.style, '-webkit-transition-property', o[0], o[1]); else esRemove.call(el.style, '-webkit-transition-property');
            }
            frozen = [];
        };
        // the longhands a shorthand declaration sets, as the engine parses them (a shorthand another rule wins in part
        // goes in as the longhands this rule still wins)
        var scratch = null;
        var longhandValues = function (decls, props) {
            if (!scratch) scratch = document.createElement('div');
            var st = scratch.style, out = [], k;
            st.cssText = '';
            for (k = 0; k < decls.length; k++) styleSet(st, decls[k][0], decls[k][1], '');
            for (k = 0; k < props.length; k++) { var v = styleGet(st, props[k]); if (v) out.push([props[k], v]); }
            return out;
        };
        // what the element computes against what the rule's static value gives: every longhand the same (the rule wins),
        // some of them (another rule wins the others), none
        var decide = function (it, now) {
            var same = [];
            for (var k = 0; k < it.props.length; k++) if (now[k] === it.before[k]) same.push(it.props[k]);
            it.ok = same.length === it.props.length;
            it.part = !it.ok && same.length ? same : null;
        };
        var apply = function (pending) {
            var work = [], keep = [], slow = [], i, k, it, cs, tm = [Date.now()];
            for (i = 0; i < pending.length; i++) {
                it = pending[i];
                it.decls = fixDecl(it.use.p, it.raw);
                if (it.use.ps) { pseudoRule(it); continue; }
                var cache = it.el.__brCVc && it.el.__brCVc[it.key];
                if (cache && cache.raw === it.raw && cache.st === it.use.st && !isDirty(it.el)) { it.ok = cache.ok; it.part = cache.part; keep.push(it); continue; }
                it.prevPart = cache ? cache.part : null;
                work.push(it);
                if (it.use.inl || it.use.st === null || it.use.st === undefined) { it.ok = true; continue; }
                it.fb = fixDecl(it.use.p, it.use.st);
                it.props = [];
                for (k = 0; k < it.fb.length; k++) it.props = it.props.concat(LONGHANDS[it.fb[k][0]] || [it.fb[k][0]]);
                it.check = true;
            }
            // elements whose inline values may change: transitions held, our earlier values taken back
            tm.push(Date.now());
            for (i = 0; i < work.length; i++) {
                it = work[i];
                freeze(it.el);   // the new value appears at once instead of fading in (and a restore does not animate)
                if (it.fb) for (k = 0; k < it.fb.length; k++) restoreInline(it.el, it.fb[k][0]);
                for (k = 0; k < it.decls.length; k++) restoreInline(it.el, it.decls[k][0]);
                if (it.prevPart) for (k = 0; k < it.prevPart.length; k++) restoreInline(it.el, it.prevPart[k]);
            }
            // what the stylesheets give the element now, against what the rule's own value computes to
            tm.push(Date.now());
            for (i = 0; i < work.length; i++) {
                it = work[i];
                if (!it.check) continue;
                cs = getComputedStyle(it.el);
                it.before = [];
                for (k = 0; k < it.props.length; k++) it.before.push(cs.getPropertyValue(it.props[k]));
                // the page's own inline value wins over any rule (unless the rule is !important)
                it.own = false;
                for (k = 0; k < it.fb.length; k++) if (styleGet(it.el.style, it.fb[k][0]) && !it.use.i) it.own = true;
            }
            tm.push(Date.now());
            for (i = 0; i < work.length; i++) {
                it = work[i];
                if (!it.check) continue;
                if (it.own) { it.ok = false; it.part = null; continue; }
                var pv = probeValues(it.fb, it.props);
                if (pv === null) { slow.push(it); continue; }
                decide(it, pv);
            }
            tm.push(Date.now());
            if (slow.length) slowCheck(slow);
            tm.push(Date.now());
            rivalCheck(work);
            tm.push(Date.now());
            for (i = 0; i < work.length; i++) {
                it = work[i];
                if (!it.el.__brCVc) it.el.__brCVc = {};
                it.el.__brCVc[it.key] = { raw: it.raw, st: it.use.st, ok: it.ok, part: it.ok ? null : it.part || null };
                var set = it.ok ? it.decls : it.part ? longhandValues(it.decls, it.part) : null;
                if (!set) { stats.skipped++; continue; }
                stats.applied++;
                for (k = 0; k < set.length; k++) setInline(it.el, set[k][0], set[k][1], it.use.i);
            }
            tm.push(Date.now());
            for (i = 0; i < keep.length; i++) {
                it = keep[i];
                var kept = it.ok ? it.decls : it.part ? longhandValues(it.decls, it.part) : [];
                for (k = 0; k < kept.length; k++) keepInline(it, kept[k][0], kept[k][1]);
            }
            restoreStale();
            tm.push(Date.now());
            thaw();
            tm.push(Date.now());
            // (for the debug log: fix, freeze, before, probe, slow, rival, set, keep, thaw; work/keep/slow counts)
            stats.applyParts = [];
            for (i = 1; i < tm.length; i++) stats.applyParts.push(tm[i] - tm[i - 1]);
            stats.applyParts.push(work.length, keep.length, slow.length);
        };
        // ---- ties: the stylesheet gives the element the rule's substituted value, but another rule with the same value
        // may be the one winning. The style rules of the CSSOM that set the property and match the element are
        // compared with ours by importance, specificity and order. This only reads the CSSOM: changing a rule of a
        // stylesheet whose @font-face fonts are in use makes the old WebKit drop fonts that painting still uses (the
        // app crashed in CoreGraphics seconds later on astro.build). Rules the CSSOM does not expose keep the probe's
        // answer.
        var cssomList = null, cssomByProp = {}, lastRivals = [];
        var normSel = function (s) { return String(s).replace(/["'\s]+/g, '').toLowerCase(); };
        // (no brackets, quotes or escapes: what most selectors are, split without a walk over their characters)
        var PLAIN_SEL = /^[^(\["'\\]*$/;
        var selectorList = function (text) {
            var parts = [], depth = 0, start = 0, q = null, s = String(text);
            if (PLAIN_SEL.test(s)) return s.split(',');
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
                if (c === '"' || c === "'") q = c;
                else if (c === '\\') i++;
                else if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (c === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
            }
            parts.push(s.slice(start));
            return parts;
        };
        // (the rewriter's specificity(): ids, classes/attributes/pseudo-classes, types/pseudo-elements)
        var selectorSpecificity = function (sel) {
            var s = String(sel).replace(/"[^"]*"|'[^']*'/g, '""').replace(/\[[^\]]*\]/g, '.x'), c = 0;
            s = s.replace(/::?(before|after|first-line|first-letter)\b|::[\w-]+(\([^)]*\))?/gi, function () { c++; return ' '; });
            var a = (s.match(/#[\w-]+/g) || []).length;
            var b = (s.match(/\.[\w-]+|:[\w-]+/g) || []).length - (s.match(/:(not|-webkit-any|is|where|matches)\b/gi) || []).length;
            c += (s.replace(/[.#:][\w-]+/g, ' ').match(/(^|[\s>+~(,])[a-zA-Z][\w-]*/g) || []).length;
            return Math.min(a, 99) * 10000 + Math.min(Math.max(b, 0), 99) * 100 + Math.min(c, 99);
        };
        // the style rules in effect, in cascade order ({rule, key, order}; @media blocks that do not match left out), and
        // for each property the rules that set it ({entry, imp}), from one walk over the declarations. Kept while the
        // stylesheets stay as they are (their count and rule counts; a resize starts over): the walk read the CSSOM of
        // every rule for every property, in every pass (tailwindcss.com: 5 s of each 8 s pass).
        var cssomKey = '';
        var cssomFingerprint = function () {
            var parts = [document.styleSheets.length, window.innerWidth, window.innerHeight];
            for (var s = 0; s < document.styleSheets.length; s++) {
                var sh = document.styleSheets[s], n = -1, owner = sh.ownerNode;
                if (owner && (owner.__brOwn || /^br-/.test(owner.id || ''))) continue;   // (the shims' own, rewritten every pass)
                try { n = sh.cssRules ? sh.cssRules.length : -1; } catch (e) {}
                parts.push(n, sh.disabled ? 1 : 0);
            }
            return parts.join(',');
        };
        var cssomRules = function () {
            if (cssomList) return cssomList;
            cssomList = [];
            cssomByProp = {};
            var vp = window.innerWidth + 'x' + window.innerHeight;
            var mediaOn = function (m) { var t = m && m.mediaText; if (!t) return true; try { return window.matchMedia(t).matches; } catch (e) { return true; } };
            var walk = function (list, depth, out) {
                if (!list || depth > 6) return;
                for (var i = 0; i < list.length; i++) {
                    var r = list[i];
                    if (r.type === 1) {
                        // (its key and each declaration's importance once a check needs them, see rivalIndex and look:
                        // for IKEA's 13,000 rules they were 380 ms of every walk)
                        var entry = { rule: r, key: null, order: 0, sels: null, items: [] }, st = r.style, n = st ? st.length : 0;
                        for (var d = 0; d < n; d++) {
                            var p = st[d];
                            if (p) entry.items.push({ p: p, entry: entry, imp: null });
                        }
                        out.push(entry);
                        continue;
                    }
                    if (r.type === 4 && !mediaOn(r.media)) continue;
                    if (r.cssRules) walk(r.cssRules, depth + 1, out);
                }
            };
            // each sheet's walk is kept while its rule count and the window size stay (one stylesheet a script added
            // walked all the others again: 6,000 rules, a second)
            for (var s = 0; s < document.styleSheets.length; s++) {
                var sheet = document.styleSheets[s], rs = null, entries = null;
                if (sheet.disabled || (sheet.ownerNode && sheet.ownerNode.id === 'br-cv-pseudo') || !mediaOn(sheet.media)) continue;
                try { rs = sheet.cssRules; } catch (e) { rs = null; }
                if (!rs) continue;
                var kept = sheet.__brCVw;
                if (kept && kept.n === rs.length && kept.vp === vp) entries = kept.entries;
                else { entries = []; walk(rs, 0, entries); try { sheet.__brCVw = { n: rs.length, vp: vp, entries: entries }; } catch (e2) {} }
                for (var k = 0; k < entries.length; k++) {
                    var en = entries[k];
                    en.order = cssomList.length;
                    cssomList.push(en);
                    for (var q = 0; q < en.items.length; q++) { var it = en.items[q]; (cssomByProp.hasOwnProperty(it.p) ? cssomByProp[it.p] : (cssomByProp[it.p] = [])).push(it); }
                }
            }
            return cssomList;
        };
        // the rules that set `prop` ({entry, imp})
        var rulesSetting = function (prop) {
            cssomRules();
            return cssomByProp.hasOwnProperty(prop) ? cssomByProp[prop] : [];
        };
        // (a selector the engine took once goes without a try - a function with one costs 2.3 us more per call here)
        var selTaken = Object.create(null);
        var matchesElTry = function (el, s) { var f = el.matches || el.webkitMatchesSelector; try { var r = !!f.call(el, s); selTaken[s] = true; return r; } catch (e) { return false; } };
        var matchesEl = function (el, s) { return selTaken[s] === true ? !!(el.matches || el.webkitMatchesSelector).call(el, s) : matchesElTry(el, s); };
        // what the subject of a selector (its last compound) needs on the element itself: its classes and id. A
        // selector whose subject needs a class the element lacks cannot match it: no engine call (tailwindcss.com: 84,000
        // selector matches, 5 s, a pass).
        var subjectNeeds = function (sel) {
            var s = String(sel), depth = 0, start = 0, q = null;
            if (PLAIN_SEL.test(s)) {
                // (IKEA's 10,000 selectors took 1.7 s a page this way, the walk below included)
                var t = trim(s), cut = Math.max(t.lastIndexOf(' '), t.lastIndexOf('>'), t.lastIndexOf('+'), t.lastIndexOf('~')), tail = t.slice(cut + 1);
                var pcls = [], pm, pre = /\.([\w-]+)/g, pid = /#([\w-]+)/.exec(tail);
                while ((pm = pre.exec(tail)) !== null) pcls.push(pm[1]);
                var ptag = tail.indexOf('|') < 0 ? /^([a-zA-Z][\w-]*)/.exec(tail) : null;
                return { cls: pcls, id: pid ? pid[1] : null, tag: ptag ? ptag[1].toLowerCase() : null, attrs: [], pe: /::|:(before|after|first-line|first-letter)\b/i.test(tail) };
            }
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
                if (c === '"' || c === "'") q = c;
                else if (c === '\\') i++;
                else if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (!depth && (c === ' ' || c === '>' || c === '+' || c === '~')) start = i + 1;
            }
            var raw = trim(s.slice(start)), outer = raw.replace(/:(not|-webkit-any|is|where|matches|has)\((?:[^()]|\([^()]*\))*\)/gi, ' ');
            var last = outer.replace(/\[[^\]]*\]/g, ' ');
            var cls = [], re = /\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)/g, m, id = /#((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)/.exec(last);
            while ((m = re.exec(last)) !== null) cls.push(unescapeCSS(m[1]));
            // also the subject's tag, the attributes it must have and a pseudo-element (which no element matches):
            // `.prose table`, `[data-toast][data-styled="true"]`, `.x [data-light]::after` were most of the engine calls
            var attrs = [], am, ar = /\[\s*([\w-]+)/g;
            while ((am = ar.exec(outer)) !== null) attrs.push(am[1]);
            var tag = raw.indexOf('|') < 0 ? /^([a-zA-Z][\w-]*)/.exec(raw) : null;
            return { cls: cls, id: id ? unescapeCSS(id[1]) : null, tag: tag ? tag[1].toLowerCase() : null, attrs: attrs, pe: /::|:(before|after|first-line|first-letter)\b/i.test(outer) };
        };
        var SIMPLE_SEL = /^(?:[.#](?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)+$/;
        // the compounds of a selector that need a state (:hover, :active, :focus outside :not() and the like), or null:
        // a selector whose state compound no element in that state matches cannot match at all - tried once a pass on
        // those few elements, not on every candidate (IKEA's buttons have a rule per state: 3,700 engine calls, 2.7 s)
        var STATE_PSEUDO = /:(hover|active|focus|disabled|checked)(?![\w-])/i, FUNC_PSEUDO = /:(?:not|is|where|matches|-webkit-any|has)\((?:[^()]|\([^()]*\))*\)/gi;
        // (one id, then a subject of a tag and classes: nothing the checks before the engine call leave open)
        var EXACT_ANC = /^#[\w-]+\s+(?:[a-zA-Z][\w-]*(?:\.[\w-]+)*|(?:\.[\w-]+)+)$/;
        // ({text, state, subject}; sib: the selector has sibling combinators, where no compound encloses the element)
        var stateCompounds = function (sel) {
            var s = String(sel), out = null, depth = 0, start = 0, q = null, sib = false;
            // (the subject's own classes and tag were looked at before; every compound before it, and a subject with a
            // state or an attribute selector: [aria-disabled="true"], `.grid > *` - such compounds hold for few elements)
            var take = function (end, subject) {
                var comp = trim(s.slice(start, end)), bare = comp.replace(FUNC_PSEUDO, '');
                if (comp && comp !== '*' && (!subject || STATE_PSEUDO.test(bare) || bare.indexOf('[') >= 0)) (out || (out = [])).push({ text: comp, subject: subject });
            };
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
                if (c === '"' || c === "'") q = c;
                else if (c === '\\') i++;
                else if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (!depth && (c === ' ' || c === '>' || c === '+' || c === '~')) { if (c === '+' || c === '~') sib = true; take(i, false); start = i + 1; }
            }
            take(s.length, true);
            if (out) out.sib = sib;
            return out;
        };
        // the ids a selector needs on the element's ancestors (`#onetrust-banner-sdk span`: every span of IKEA's page was
        // matched against such rules, 6,800 engine calls a pass), or null; only for selectors joined by descendant and
        // child combinators, where the element sits inside them (a walk up its parents instead of an engine call)
        var ancestorIds = function (sel) {
            var s = String(sel), ids = null, depth = 0, start = 0, q = null, comps = [];
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
                if (c === '"' || c === "'") q = c;
                else if (c === '\\') i++;
                else if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (!depth && (c === '+' || c === '~')) return null;
                else if (!depth && (c === ' ' || c === '>')) { comps.push(s.slice(start, i)); start = i + 1; }
            }
            // (the subject's own id is looked at elsewhere, see subjectNeeds)
            for (var k = 0; k < comps.length; k++) {
                var m = /#((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)/.exec(comps[k].replace(FUNC_PSEUDO, '').replace(/\[[^\]]*\]/g, ''));
                if (m) (ids || (ids = [])).push(unescapeCSS(m[1]));
            }
            return ids;
        };
        var insideIds = function (el, ids) {
            for (var k = 0; k < ids.length; k++) {
                var p = el.parentNode;
                while (p && p.nodeType === 1 && p.id !== ids[k]) p = p.parentNode;
                if (!p || p.nodeType !== 1) return false;
            }
            return true;
        };
        var statePass = null, stateUses = null;
        // the elements that match the compound, once a pass (null: too many to be worth it, or a selector the engine
        // refuses). A search of the document costs about what a few element matches do: a compound gets one from its
        // fourth use in the pass on (IKEA has hundreds of compounds used once or twice: searching them all cost more)
        var stateMatches = function (comp) {
            if (!statePass) { statePass = Object.create(null); stateUses = Object.create(null); }
            var got = statePass[comp.text];
            if (got !== undefined) return got;
            var n = (stateUses[comp.text] || 0) + 1;
            stateUses[comp.text] = n;
            if (n < 4) return null;
            var q0 = Date.now();
            try { got = document.querySelectorAll(comp.text); } catch (e) { got = null; }
            rivalQsaMs += Date.now() - q0;
            if (got && got.length > 64) got = null;
            return (statePass[comp.text] = got ? Array.prototype.slice.call(got) : null);
        };
        // can the element match, as far as its state compounds say: the subject one must be the element itself, one
        // before it must enclose it (with sibling combinators only that some element is in the state)
        var stateMayMatch = function (sel, el) {
            for (var i = 0; i < sel.stc.length; i++) {
                var comp = sel.stc[i], ms = stateMatches(comp), hit = false;
                if (ms === null) continue;
                if (!ms.length) return false;
                if (sel.stc.sib) continue;
                for (var j = 0; j < ms.length && !hit; j++) hit = comp.subject ? ms[j] === el : ms[j] !== el && ms[j].contains(el);
                if (!hit) return false;
            }
            return true;
        };
        var classSet = function (el) {
            var set = {}, c = el.className;
            if (typeof c !== 'string') c = c && typeof c.baseVal === 'string' ? c.baseVal : '';
            var parts = c.split(/\s+/);
            for (var i = 0; i < parts.length; i++) if (parts[i]) set[parts[i]] = 1;
            return set;
        };
        // the rules that set `prop`, by what the subject of each selector needs first: its id, else its first class,
        // else its tag, else nothing (an element looks only at the buckets of its own id, classes and tag: every rule
        // setting `color` for every element was 4 s a pass on tailwind-style pages). Kept with the CSSOM list.
        var rivalIndexes = {}, rivalIndexOf = null, hasOwnRI = Object.prototype.hasOwnProperty, selInfo = {}, selInfoSize = 0;
        var bucket = function (map, k, item) { (hasOwnRI.call(map, k) ? map[k] : (map[k] = [])).push(item); };
        var rivalIndex = function (prop) {
            var list = rulesSetting(prop);
            if (rivalIndexOf !== cssomList) { rivalIndexes = {}; rivalIndexOf = cssomList; }
            if (hasOwnRI.call(rivalIndexes, prop)) return rivalIndexes[prop];
            var ix = { own: {}, id: {}, cls: {}, tag: {}, any: [] }, i, j, x0 = Date.now();
            for (i = 0; i < list.length; i++) {
                var r = list[i], e = r.entry;
                if (e.key === null) e.key = normSel(e.rule.selectorText);
                ix.own['$' + e.key] = e;   // (the last copy counts)
                if (!e.sels) {
                    // (by selector text: a sheet walked again keeps what its selectors need)
                    var text = e.rule.selectorText;
                    if (hasOwnRI.call(selInfo, text)) e.sels = selInfo[text];
                    else {
                        e.sels = [];
                        var parts = selectorList(text);
                        // (a selector of classes and an id only matches every element that has them: no engine call; most
                        // utility-class selectors are such, tailwind-style pages made 7,000 matches a pass, 2.7 s)
                        // (its specificity and whether it is simple once an element gets that far, see look)
                        for (var k = 0; k < parts.length; k++) e.sels.push({ s: parts[k], sp: -1, need: subjectNeeds(parts[k]), simple: null });
                        if (selInfoSize++ > 30000) { selInfo = {}; selInfoSize = 0; }
                        selInfo[text] = e.sels;
                    }
                }
                for (j = 0; j < e.sels.length; j++) {
                    var sel = e.sels[j], need = sel.need, item = { r: r, sel: sel };
                    if (need.pe) continue;   // a pseudo-element: never the element itself
                    if (need.id !== null) bucket(ix.id, need.id, item);
                    else if (need.cls.length) bucket(ix.cls, need.cls[0], item);
                    else if (need.tag !== null && need.tag !== '*') bucket(ix.tag, need.tag, item);
                    else ix.any.push(item);
                }
            }
            rivalIdxMs += Date.now() - x0;
            rivalIdxN++;
            return (rivalIndexes[prop] = ix);
        };
        // does another rule win `prop` on the item's element? (null when our own rule is not in the CSSOM)
        var rivalWins = function (it, prop) {
            var ix = rivalIndex(prop), own = hasOwnRI.call(ix.own, '$' + it.use.rk) ? ix.own['$' + it.use.rk] : null;
            if (!own) return null;
            var ownImp = !!it.use.i, el = it.el, tag = el.tagName.toLowerCase(), hit = false, c;
            if (!it.cls) it.cls = classSet(el);
            rivalCalls++;
            var look = function (items) {
                rivalLooked += items.length;
                for (var b = 0; b < items.length; b++) {
                    var r = items[b].r, e = r.entry, sel = items[b].sel, need = sel.need, miss = false, k;
                    if (e === own || e.key === it.use.rk) continue;
                    if (r.imp === null) r.imp = e.rule.style.getPropertyPriority(r.p) === 'important';
                    if (ownImp && !r.imp) continue;
                    // only a selector that would beat ours needs matching
                    if (sel.sp < 0) sel.sp = selectorSpecificity(sel.s);
                    if (!(r.imp && !ownImp) && (sel.sp < it.use.sp || (sel.sp === it.use.sp && e.order <= own.order))) continue;
                    if (need.id !== null && el.id !== need.id) continue;
                    if (need.tag !== null && need.tag !== '*' && need.tag !== tag) continue;
                    for (k = 0; k < need.cls.length && !miss; k++) if (it.cls[need.cls[k]] !== 1) miss = true;
                    for (k = 0; k < need.attrs.length && !miss; k++) if (!el.hasAttribute(need.attrs[k])) miss = true;
                    if (miss) continue;
                    if (sel.simple === null) sel.simple = SIMPLE_SEL.test(trim(sel.s));
                    if (sel.simple) return sel.s;
                    if (sel.anc === undefined) { sel.anc = ancestorIds(sel.s); sel.exact = sel.anc !== null && EXACT_ANC.test(trim(sel.s)); }
                    if (sel.anc !== null && !insideIds(el, sel.anc)) continue;
                    if (sel.exact) return sel.s;   // (`#id tag.class`: what was checked above is all it asks)
                    if (sel.stc === undefined) sel.stc = stateCompounds(sel.s);
                    if (sel.stc !== null && !stateMayMatch(sel, el)) continue;
                    matchCalls++;
                    if (rivalSelCount) rivalSelCount[sel.s] = (rivalSelCount[sel.s] || 0) + 1;
                    if (matchesEl(el, sel.s)) return sel.s;
                }
                return false;
            };
            if (el.id && hasOwnRI.call(ix.id, el.id)) hit = look(ix.id[el.id]);
            if (!hit) for (c in it.cls) if (hasOwnRI.call(it.cls, c) && hasOwnRI.call(ix.cls, c) && (hit = look(ix.cls[c]))) break;
            if (!hit && hasOwnRI.call(ix.tag, tag)) hit = look(ix.tag[tag]);
            if (!hit) hit = look(ix.any);
            return hit || false;
        };
        var matchCalls = 0, rivalSelCount = null, rivalCalls = 0, rivalLooked = 0, rivalIdxMs = 0, rivalIdxN = 0, rivalQsaMs = 0;
        var rivalCheck = function (work) {
            var i, k, it, t0 = Date.now(), key = cssomFingerprint();
            rivalSelCount = window.__brNoteSlow ? {} : null;
            statePass = null;
            if (key !== cssomKey) { cssomList = null; cssomKey = key; }
            var t1 = Date.now();
            cssomRules();
            var t2 = Date.now();
            matchCalls = 0; rivalCalls = 0; rivalLooked = 0; rivalIdxMs = 0; rivalIdxN = 0; rivalQsaMs = 0;
            lastRivals = [];
            for (i = 0; i < work.length; i++) {
                it = work[i];
                if (it.use.inl || it.use.ps || (it.ok === false && !it.part) || !it.use.rk) continue;
                var props = it.part || it.props || [];
                if (!props.length) for (k = 0; k < it.decls.length; k++) props = props.concat(LONGHANDS[it.decls[k][0]] || [it.decls[k][0]]);
                var keep = [];
                for (k = 0; k < props.length; k++) {
                    var rival = rivalWins(it, props[k]);
                    if (!rival) keep.push(props[k]);
                    else if (lastRivals.length < 1000) lastRivals.push(props[k] + ': ' + rival + ' beats ' + it.use.sel + ' (' + it.el.tagName + ')');
                }
                if (keep.length === props.length) continue;
                it.ok = false;
                it.part = keep.length ? keep : null;
            }
            stats.rivalParts = [t1 - t0, t2 - t1, Date.now() - t2, matchCalls, cssomList ? cssomList.length : 0, rivalCalls, rivalLooked, rivalIdxN, rivalIdxMs, rivalQsaMs];
            // (for the debug log: the selectors matched most often)
            if (rivalSelCount) {
                var top = [];
                for (var s in rivalSelCount) if (rivalSelCount.hasOwnProperty(s)) top.push([rivalSelCount[s], s]);
                top.sort(function (a, b) { return b[0] - a[0]; });
                stats.rivalTop = top.slice(0, 5).map(function (t) { return t[0] + 'x ' + t[1].slice(0, 70); }).join(' | ');
                if (matchCalls > (stats.rivalTopMaxCalls || 0)) { stats.rivalTopMaxCalls = matchCalls; stats.rivalTopMax = matchCalls + ' calls: ' + stats.rivalTop; }
            }
        };
        // an unchanged decision: our inline value stays (unless a script replaced it meanwhile: then the page's stays)
        var keepInline = function (it, p, v) {
            var el = it.el;
            if (el.__brCVSet && el.__brCVSet.hasOwnProperty(p)) {
                if (el.style.getPropertyValue(p) === el.__brCVVal[p]) { el.__brCVSet[p] = gen; return; }
                delete el.__brCVSet[p]; delete el.__brCVOrig[p]; delete el.__brCVVal[p];
                if (el.__brCVc && el.__brCVc[it.key]) { el.__brCVc[it.key].ok = false; el.__brCVc[it.key].part = null; }
                return;
            }
            freeze(el);
            setInline(el, p, v, it.use.i);
        };
        // values that depend on the element: the rule's value goes on the element for a moment and is measured there
        var slowCheck = function (checks) {
            var i, k, it, cs;
            for (i = 0; i < checks.length; i++) {
                it = checks[i];
                it.saved = [];
                for (k = 0; k < it.fb.length; k++) {
                    it.saved.push([it.fb[k][0], it.el.style.getPropertyValue(it.fb[k][0]), it.el.style.getPropertyPriority(it.fb[k][0])]);
                    it.el.style.setProperty(it.fb[k][0], it.fb[k][1], '');
                }
            }
            for (i = 0; i < checks.length; i++) {
                it = checks[i];
                cs = getComputedStyle(it.el);
                var now = [];
                for (k = 0; k < it.props.length; k++) now.push(cs.getPropertyValue(it.props[k]));
                decide(it, now);
                if (it.own) { it.ok = false; it.part = null; }
            }
            for (i = 0; i < checks.length; i++) {
                it = checks[i];
                for (k = it.saved.length - 1; k >= 0; k--) {
                    if (it.saved[k][1]) it.el.style.setProperty(it.saved[k][0], it.saved[k][1], it.saved[k][2]);
                    else it.el.style.removeProperty(it.saved[k][0]);
                }
            }
        };
        // ---- ::before / ::after values: a generated rule for the element, one class more specific than the original
        var pseudoRules = [];
        var pseudoRule = function (it) {
            var el = it.el;
            if (!el.__brCVp) { el.__brCVp = 'br-cvp-' + (++pseudoSeq); }
            if (el.__brCVpg !== gen) { el.__brCVpg = gen; pseudoTracked.push(el); }
            setStateClass(el, el.__brCVp, true);
            var sel = it.use.sel + '.' + el.__brCVp + it.use.ps, body = [];
            for (var k = 0; k < it.decls.length; k++) body.push(it.decls[k][0] + ':' + it.decls[k][1] + (it.use.i ? ' !important' : ''));
            pseudoRules.push(sel + '{' + body.join(';') + '}');
        };
        var writePseudo = function () {
            var text = pseudoRules.join('\n');
            pseudoRules = [];
            var keep = [];
            for (var i = 0; i < pseudoTracked.length; i++) {
                var el = pseudoTracked[i];
                if (el.__brCVpg === gen) { keep.push(el); continue; }
                setStateClass(el, el.__brCVp, false);
            }
            pseudoTracked = keep;
            if (text === pseudoText) return;
            pseudoText = text;
            if (!pseudoStyle) {
                pseudoStyle = ownStyleElement();
                pseudoStyle.id = 'br-cv-pseudo';
            }
            pseudoStyle.textContent = text;
            if (!pseudoStyle.parentNode) (document.body || document.documentElement).appendChild(pseudoStyle);
        };
        // ---- when to run: after the manifest arrives, on resizes, DOM changes, and state changes the selectors use
        var pass = function () {
            timer = null;
            if (!rules.length || busy) return;
            busy = true;
            var t0 = Date.now();
            try { run(); } catch (e) { stats.err = String(e); if (window.console && console.warn) console.warn('cv pass: ' + e); }
            lastCost = Date.now() - t0;
            busy = false;
            // (the last passes, for state(): why, cost, collect/resolve/apply, work items)
            if (!stats.log) stats.log = [];
            stats.log.push(stats.dirty + ': ' + lastCost + ' = ' + stats.tCollect + '/' + (stats.tResolve - stats.tCollect) + '/' + stats.tApply + ' work ' + (stats.applyParts ? stats.applyParts[stats.applyParts.length - 3] : '?') +
                           ' [' + (stats.applyParts || []).slice(0, 9).join(' ') + '] rival ' + (stats.rivalParts || []).join(' ') + (stats.rivalTop ? ' top ' + stats.rivalTop.slice(0, 160) : ''));
            if (stats.log.length > 12) stats.log.shift();
            if (window.__brNoteSlow) window.__brNoteSlow('custom properties', lastCost, '(' + stats.dirty + ') collect ' + stats.tCollect + ' [doc rules qsaN qsaMs els: ' + (stats.collectParts || []).join(' ') +
                                                        '], resolve ' + (stats.tResolve - stats.tCollect) +
                                                        ' [inline users reused redone subMs normMs: ' + (stats.resolveParts || []).join(' ') + '], apply ' + stats.tApply +
                                                        ' [fix freeze before probe slow rival set keep thaw / work keep slow: ' + (stats.applyParts || []).join(' ') + '], pending ' + stats.pending +
                                                        ', rival [key index match / matches rules calls looked idxN idxMs qsaMs: ' +(stats.rivalParts || []).join(' ') + '] top ' + (stats.rivalTop || ''));
            if (observer && observer.takeRecords) observer.takeRecords();   // our own style changes
            if (classObserver && classObserver.takeRecords) classObserver.takeRecords();
        };
        var schedule = function (soon) {
            if (timer || !rules.length) return;
            // (an expensive pass waits four times its cost: blesk.cz's took 1.5 s and came every second; a hover or tap
            // waits at most 1.5 s, it changes little)
            timer = setTimeout(pass, lastCost > 40 ? Math.min(soon ? 1500 : 20000, lastCost * (soon ? 1 : 4)) : 40);
        };
        var OWN_CLASSES = /(?:^|\s)br-[\w-]+/g;
        var watch = function () {
            if (observer || !window.MutationObserver) return;
            var filter = [];
            for (var a in attrNames) if (attrNames.hasOwnProperty(a)) filter.push(a);
            // (the shims' own elements: the probe, generated styles, measuring boxes)
            var ownNode = function (n) { return n === probe || !!n.__brOwn || (n.nodeType === 1 && /^br-/.test(n.id || '')); };
            // below <body> or <html> itself only the element and its following siblings (+ ~ :nth-*): a whole
            // subtree of <body> is the whole page (an element a script appends there started every pass over)
            var isTop = function (n) { return n === document.body || n === document.documentElement; };
            var markSiblings = function (from) { for (var s = from; s; s = s.nextSibling) if (s.nodeType === 1) markDirty(s); };
            // (own: the style pass of the page shims asks, see apply - the marker classes it set, :has() and container
            // queries, count then)
            var onRecords = function (records, own) {
                if (busy) return;
                var any = false;
                for (var i = 0; i < records.length; i++) {
                    var r = records[i], t = r.target, n;
                    if (!t || t.id === 'br-cv-pseudo' || t === probe) continue;
                    if (r.type === 'attributes') {
                        // (the classes the page shims set, br-..., change no rule of the page: every pass started over for them)
                        if (!own && r.attributeName === 'class' && String(r.oldValue || '').replace(OWN_CLASSES, '').replace(/\s+/g, ' ').replace(/^ | $/g, '') ===
                            String(t.getAttribute('class') || '').replace(OWN_CLASSES, '').replace(/\s+/g, ' ').replace(/^ | $/g, '')) continue;
                        any = true;
                        // an attribute can change what its element, the descendants and the following siblings match
                        if (t.parentNode && t.parentNode.nodeType === 1 && !isTop(t.parentNode)) markDirty(t.parentNode);
                        else { markDirty(t); markSiblings(t.nextSibling); }
                        continue;
                    }
                    var mine = true;
                    for (n = 0; n < r.addedNodes.length && mine; n++) mine = ownNode(r.addedNodes[n]);
                    for (n = 0; n < r.removedNodes.length && mine; n++) mine = ownNode(r.removedNodes[n]);
                    if (mine) continue;
                    any = true;
                    if (!isTop(t)) { markDirty(t); continue; }
                    for (n = 0; n < r.addedNodes.length; n++) if (r.addedNodes[n].nodeType === 1) markDirty(r.addedNodes[n]);
                    markSiblings(r.nextSibling);
                }
                if (any && !own) schedule();
            };
            feedRecords = function () {
                if (observer && observer.takeRecords) { var a = observer.takeRecords(); if (a.length) onRecords(a, true); }
                if (classObserver && classObserver.takeRecords) { var b = classObserver.takeRecords(); if (b.length) onRecords(b, true); }
            };
            // (the old value only of class, by an observer of its own: asked for with the style attribute among the
            // filter - a page with [style*=...] selectors - the engine wrote the whole attribute out on every change of it)
            var others = [];
            for (var f = 0; f < filter.length; f++) if (filter[f] !== 'class') others.push(filter[f]);
            try {
                observer = new MutationObserver(onRecords);
                classObserver = new MutationObserver(onRecords);
                observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: others.length ? others : ['data-br-none'] });
                classObserver.observe(document.documentElement, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
            } catch (e) { observer = null; classObserver = null; }
            var everything = function (e) { dirtyAll = true; dirtyWhy = e && e.type || 'event'; schedule(); };
            // a hover, tap or focus changes only what the rules with state pseudo-classes match: the elements they
            // matched before and match now (with their subtrees, which inherit) are redone, not the page (nextjs.org:
            // 15 s after every mouseover)
            var stateChange = function (e) {
                if (busy || dirtyAll || !rules.length) return;
                var now = [], nowSub = [], i, b, list;
                for (i = 0; i < rules.length; i++) {
                    var r = rules[i];
                    if (!r.s) continue;
                    for (b = 0; b < r.sel.length; b++) {
                        if (!r.sel[b].state) continue;
                        try { list = document.querySelectorAll(r.sel[b].base); } catch (x) { continue; }
                        for (var k = 0; k < list.length; k++) { now.push(list[k]); nowSub.push(!!(r.d && r.d.length)); }
                    }
                }
                var before = stateEls, beforeSub = stateSub, changed = before.length !== now.length;
                for (i = 0; i < now.length && !changed; i++) if (now[i] !== before[i]) changed = true;
                stateEls = now;
                stateSub = nowSub;
                if (!changed) return;
                for (i = 0; i < before.length && !dirtyAll; i++) { if (beforeSub[i]) markDirty(before[i]); else markDirtyEl(before[i]); }
                for (i = 0; i < now.length && !dirtyAll; i++) { if (nowSub[i]) markDirty(now[i]); else markDirtyEl(now[i]); }
                dirtyWhy = (e && e.type || 'event') + (dirtyAll ? ', many' : '');
                schedule(!dirtyAll);
            };
            if (watchStates) {
                var ev = ['touchstart', 'touchend', 'mouseover', 'mouseout', 'focus', 'blur', 'change', 'input'];
                for (var k = 0; k < ev.length; k++) document.addEventListener(ev[k], stateChange, true);
            }
            window.addEventListener('resize', everything, false);
            window.addEventListener('orientationchange', everything, false);
        };
        // custom properties that scripts set through style.setProperty (the engine drops them)
        var CSDp = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype;
        if (CSDp && CSDp.setProperty && !CSDp.__brCVWrapped) {
            CSDp.__brCVWrapped = true;
            var origSet = CSDp.setProperty, origGet = CSDp.getPropertyValue, origRemove = CSDp.removeProperty;
            CSDp.setProperty = function (name, value, priority) {
                if (typeof name === 'string' && name.charCodeAt(0) === 45 && name.charCodeAt(1) === 45) {
                    if (!this.__brCP) { this.__brCP = {}; this.__brCPi = {}; }
                    // an empty value removes the declaration (null: removed, the attribute's value no longer counts)
                    var nv = value === null || value === undefined || String(value) === '' ? null : String(value);
                    var ni = String(priority || '').toLowerCase() === 'important';
                    if (this.__brCP.hasOwnProperty(name) && this.__brCP[name] === nv && !!this.__brCPi[name] === ni) return;   // (unchanged)
                    this.__brCP[name] = nv;
                    this.__brCPi[name] = ni;
                    cpUsed = true;
                    cpDirty = true;
                    this.__brCPdirty = true;
                    if (!dirtyAll && !dirtyWhy) dirtyWhy = 'setProperty ' + name;
                    schedule();
                    return;
                }
                return origSet.call(this, name, value, priority || '');
            };
            CSDp.getPropertyValue = function (name) {
                if (typeof name === 'string' && name.charCodeAt(0) === 45 && name.charCodeAt(1) === 45) {
                    if (this.__brCP && this.__brCP.hasOwnProperty(name)) return this.__brCP[name] === null ? '' : this.__brCP[name];
                    if (this.__brEl) { var v = computedVar(this.__brEl, name); return v === null ? '' : v; }
                    var owner = this.__brOwner;
                    if (owner && owner.__brCVi && owner.__brCVi.d.hasOwnProperty(name)) return owner.__brCVi.d[name];
                    return '';
                }
                return origGet.call(this, name);
            };
            CSDp.removeProperty = function (name) {
                if (typeof name === 'string' && name.charCodeAt(0) === 45 && name.charCodeAt(1) === 45) {
                    var old = this.getPropertyValue(name);
                    if (!this.__brCP) { this.__brCP = {}; this.__brCPi = {}; }
                    this.__brCP[name] = null;
                    cpUsed = true;
                    cpDirty = true;
                    this.__brCPdirty = true;
                    if (!dirtyAll && !dirtyWhy) dirtyWhy = 'removeProperty ' + name;
                    schedule();
                    return old;
                }
                return origRemove.apply(this, arguments);
            };
        }
        // style="--x: ..." written by a script
        if (Ep && Ep.setAttribute && !Ep.setAttribute.__brCV) {
            var origSetAttr = Ep.setAttribute;
            var wrappedSetAttr = function (name, value) {
                var r = origSetAttr.call(this, name, value);
                if (rules.length && (name === 'style' || name === 'STYLE') && String(value).indexOf('--') >= 0) { markDirty(this); schedule(); }
                return r;
            };
            wrappedSetAttr.__brCV = true;
            Ep.setAttribute = wrappedSetAttr;
        }
        // getComputedStyle(el).getPropertyValue('--x'): the computed style remembers its element
        if (window.getComputedStyle && !window.getComputedStyle.__brCV) {
            var origGCS = window.getComputedStyle;
            var wrappedGCS = function (el, pseudo) {
                var cs = origGCS.call(window, el, pseudo === undefined ? null : pseudo);
                try { if (cs && el && el.nodeType === 1) cs.__brEl = el; } catch (e) {}
                return cs;
            };
            wrappedGCS.__brCV = true;
            try { window.getComputedStyle = wrappedGCS; } catch (e) {}
        }
        var manifestAsked = false;
        var computedVar = function (el, name) {
            // (asked before the page's manifest came: fetched now, see __brManifestNow)
            if (!rules.length && !manifestAsked && window.__brManifestNow) { manifestAsked = true; window.__brManifestNow(); }
            if (!rules.length) return initialOf(name);
            if (el.__brCVm && el.__brCVm.g === gen && el.__brCVm.v.hasOwnProperty(name)) return el.__brCVm.v[name];
            return resolveVar(el, name, 0);
        };
        // the document order of the manifest's stylesheets (imports before the rules of the sheet importing them;
        // the page's own <style> blocks at the place of the first one): entries arrive in network order
        var sheetRanks = function (sheets) {
            var order = [], page = location.href.split('#')[0], ranks = [];
            var walk = function (sheet, depth) {
                if (depth > 8) return;
                try {
                    var rs = sheet.cssRules;
                    if (rs) for (var i = 0; i < rs.length; i++) if (rs[i].type === 3 && rs[i].styleSheet) walk(rs[i].styleSheet, depth + 1);
                } catch (e) {}
                order.push(sheet.href ? String(sheet.href).split('#')[0] : page);
            };
            try { for (var s = 0; s < document.styleSheets.length; s++) walk(document.styleSheets[s], 0); } catch (e2) {}
            for (var k = 0; k < (sheets || []).length; k++) {
                var at = -1;
                for (var j = 0; j < order.length; j++) if (order[j] === sheets[k]) { at = j; break; }
                ranks.push(at < 0 ? 10000 + k : at);
            }
            return ranks;
        };
        window.__brVars = {
            setManifest: function (m) {
                var list = m.cv || [], ranks = sheetRanks(m.sheets);
                rules = [];
                registered = {};
                rootVars = m.vars || {};
                for (var i = 0; i < list.length; i++) {
                    var e = list[i];
                    if (e.r) { registered[e.r[0]] = { init: e.r[1], inh: !!e.r[2] }; continue; }
                    if (!e.s) continue;
                    e.o = (e.si !== undefined && ranks[e.si] !== undefined ? ranks[e.si] : 0) * 100000 + i;
                    e.key = normSel(e.s.join(','));   // finds the rule in the CSSOM (see rivalCheck)
                    e.sel = [];
                    for (var b = 0; b < e.s.length; b++) e.sel.push(prepareSelector(e.s[b]));
                    rules.push(e);
                }
                dirtyAll = true;
                dirtyWhy = 'manifest';
                if (rules.length) watch();
            },
            // the style pass of the page shims (see its apply): a pass only when something changed - the marker classes
            // it just set, what the observers saw, a custom property of a script, a style attribute with custom
            // properties (style.cssText cannot be seen otherwise); nextjs.org made a full pass of 1.3 s every time
            apply: function () {
                if (!rules.length) return;
                if (feedRecords) feedRecords();
                var due = !!timer;
                if (timer) { clearTimeout(timer); timer = null; }   // (the pass it waited for is this one)
                if (due || dirtyAll || dirtyRoots.length || dirtyEls || cpDirty || inlineChanged()) pass();
            },
            resolve: function (el, name) { return computedVar(el, name); },
            state: function () { return { rules: rules.length, passes: stats.passes, applied: stats.applied, skipped: stats.skipped, matchedRules: stats.rules, cost: lastCost, collectMs: stats.tCollect, resolveMs: stats.tResolve, applyMs: stats.tApply, pending: stats.pending, dirty: stats.dirty, work: stats.applyParts ? stats.applyParts[stats.applyParts.length - 3] : null, rivalTop: stats.rivalTop, err: stats.err || null, rivalTopMax: stats.rivalTopMax || null,
                                        applyParts: stats.applyParts, resolveParts: stats.resolveParts, rivalParts: stats.rivalParts, log: stats.log || [] }; },
            rivals: function () { return lastRivals; },
            // the decision steps for one declaration of an element (diagnosis)
            explain: function (el, prop) {
                var use = el.__brCV && el.__brCV.u['|' + prop];
                if (!use) return null;
                var raw = substitute(use.v, el, 0), fb = use.st === null ? null : fixDecl(use.p, use.st), props = [];
                if (fb) for (var k = 0; k < fb.length; k++) props = props.concat(LONGHANDS[fb[k][0]] || [fb[k][0]]);
                var cs = getComputedStyle(el), before = [];
                for (k = 0; k < props.length; k++) before.push(cs.getPropertyValue(props[k]));
                return { raw: raw, st: use.st, decls: fixDecl(use.p, raw), fb: fb, props: props, before: before, probe: fb ? probeValues(fb, props) : null, inline: el.getAttribute('style') };
            },
            // what the last pass had to set (for diagnosis): element, property, per-element value, stylesheet value
            sample: function (n) {
                var out = [];
                for (var i = 0; i < lastPending.length && out.length < (n || 20); i++) {
                    var it = lastPending[i], el = it.el;
                    out.push((el.tagName || '') + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\s+/).slice(0, 3).join('.') : '') + ' ' + it.use.p + ': ' + it.raw + ' <- ' + it.use.st + (it.part ? ' (only ' + it.part.join(', ') + ')' : it.ok === false ? ' (not applied)' : ''));
                }
                return out;
            }
        };
    })();
    // ---- Scroll snap, smooth scrolling and balanced text, driven by the rewriter's counter-reset markers
    // (br-snap-x/y, br-snap-m, br-snap-pad, br-snap-align on the items, br-smooth, br-balance)
    (function () {
        var raf = function (fn) { return setTimeout(fn, 16); };   // a timer keeps running where requestAnimationFrame would stall
        var ease = function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; };
        // animate the scroll position of `target` (window or element) to x/y over `ms`
        var animateScroll = function (target, x, y, ms) {
            var isWin = target === window;
            var sx = isWin ? window.pageXOffset : target.scrollLeft, sy = isWin ? window.pageYOffset : target.scrollTop;
            if (x === null || x === undefined) x = sx;
            if (y === null || y === undefined) y = sy;
            if (Math.abs(x - sx) < 1 && Math.abs(y - sy) < 1) { return; }
            var start = Date.now(), token = {};
            target.__brScrollAnim = token;
            var step = function () {
                if (target.__brScrollAnim !== token) return;
                var t = Math.min(1, (Date.now() - start) / ms), k = ease(t);
                var nx = sx + (x - sx) * k, ny = sy + (y - sy) * k;
                if (isWin) window.scrollTo(nx, ny); else { target.scrollLeft = nx; target.scrollTop = ny; }
                if (t < 1) raf(step); else target.__brScrollAnim = null;
            };
            raf(step);
        };
        var smoothWanted = function (arg, target) {
            var b = arg && typeof arg === 'object' ? arg.behavior : undefined;
            if (b === 'smooth') return true;
            if (b === 'instant' || b === 'auto') return false;
            return false;
        };
        // window.scrollTo / scrollBy / scroll with { behavior: 'smooth' }
        var origWinScrollTo = window.scrollTo, origWinScrollBy = window.scrollBy;
        window.scrollTo = window.scroll = function (x, y) {
            if (x && typeof x === 'object') {
                var tx = x.left !== undefined ? x.left : window.pageXOffset, ty = x.top !== undefined ? x.top : window.pageYOffset;
                if (smoothWanted(x)) { animateScroll(window, tx, ty, 350); return; }
                return origWinScrollTo.call(window, tx, ty);
            }
            return origWinScrollTo.apply(window, arguments);
        };
        window.scrollBy = function (x, y) {
            if (x && typeof x === 'object') {
                var dx = x.left || 0, dy = x.top || 0;
                if (smoothWanted(x)) { animateScroll(window, window.pageXOffset + dx, window.pageYOffset + dy, 350); return; }
                return origWinScrollBy.call(window, dx, dy);
            }
            return origWinScrollBy.apply(window, arguments);
        };
        if (Ep) {
            var origElScrollTo = Ep.scrollTo, origElScrollBy = Ep.scrollBy, origScrollIntoView = Ep.scrollIntoView;
            Ep.scrollTo = Ep.scroll = function (x, y) {
                if (x && typeof x === 'object' && smoothWanted(x)) { animateScroll(this, x.left !== undefined ? x.left : this.scrollLeft, x.top !== undefined ? x.top : this.scrollTop, 350); return; }
                return origElScrollTo.apply(this, arguments);
            };
            Ep.scrollBy = function (x, y) {
                if (x && typeof x === 'object' && smoothWanted(x)) { animateScroll(this, this.scrollLeft + (x.left || 0), this.scrollTop + (x.top || 0), 350); return; }
                return origElScrollBy.apply(this, arguments);
            };
            Ep.scrollIntoView = function (arg) {
                if (arg && typeof arg === 'object' && smoothWanted(arg)) {
                    // only the window scrolls smoothly; inside another scroll container the engine jumps as before
                    var r = this.getBoundingClientRect(), block = arg.block || 'start', inline = arg.inline || 'nearest';
                    var y = window.pageYOffset + r.top - (block === 'center' ? (window.innerHeight - r.height) / 2 : block === 'end' ? window.innerHeight - r.height : block === 'nearest' ? (r.top >= 0 && r.bottom <= window.innerHeight ? r.top : r.top < 0 ? 0 : window.innerHeight - r.height) : 0);
                    var x = inline === 'nearest' ? window.pageXOffset : window.pageXOffset + r.left - (inline === 'center' ? (window.innerWidth - r.width) / 2 : inline === 'end' ? window.innerWidth - r.width : 0);
                    animateScroll(window, x, Math.max(0, y), 350);
                    return;
                }
                return origScrollIntoView.apply(this, arguments);
            };
        }
        // CSS scroll-behavior: smooth on the root: in-page anchor links glide
        var rootSmooth = false;
        document.addEventListener('click', function (e) {
            if (!rootSmooth || e.defaultPrevented || e.button) return;
            var a = e.target;
            while (a && a.nodeType === 1 && a.tagName !== 'A') a = a.parentNode;
            if (!a || a.nodeType !== 1) return;
            var href = a.getAttribute('href') || '';
            if (href.charAt(0) !== '#' || href.length < 2) return;
            var target = null;
            try { target = document.getElementById(decodeURIComponent(href.slice(1))); } catch (e2) {}
            if (!target) return;
            e.preventDefault();
            var r = target.getBoundingClientRect();
            animateScroll(window, window.pageXOffset, Math.max(0, window.pageYOffset + r.top), 400);
            try { if (window.history && history.pushState) history.pushState(null, '', href); } catch (e3) {}
        }, false);
        // scroll snap containers
        var snapContainers = [];
        var alignOf = function (child) {
            if (child.__brSnapAlign === undefined) {
                var cr = getComputedStyle(child).counterReset || '', m = /br-snap-align\s+(\d)/.exec(cr), mm = /br-snap-margin\s+(-?\d+)/.exec(cr);
                child.__brSnapAlign = m ? parseInt(m[1], 10) : 0;
                child.__brSnapMargin = mm ? parseInt(mm[1], 10) : 0;   // scroll-margin: the item's own outset from the snap position
            }
            return child.__brSnapAlign;
        };
        var snapNow = function (c) {
            var el = c.el;
            if (el.__brTouching || el.__brScrollAnim) return;
            var kids = el.children, bestX = null, bestY = null, bestDX = Infinity, bestDY = Infinity;
            var cw = el.clientWidth, ch = el.clientHeight, sx = el.scrollLeft, sy = el.scrollTop;
            var maxX = el.scrollWidth - cw, maxY = el.scrollHeight - ch;
            for (var i = 0; i < kids.length; i++) {
                var k = kids[i], a = alignOf(k);
                if (!a) continue;
                if (c.x) {
                    var tx = a === 2 ? k.offsetLeft - (cw - k.offsetWidth) / 2 : a === 3 ? k.offsetLeft + k.offsetWidth - cw : k.offsetLeft - c.pad - (k.__brSnapMargin || 0);
                    tx = Math.max(0, Math.min(maxX, tx));
                    var dx = Math.abs(tx - sx);
                    if (dx < bestDX) { bestDX = dx; bestX = tx; }
                }
                if (c.y) {
                    var ty = a === 2 ? k.offsetTop - (ch - k.offsetHeight) / 2 : a === 3 ? k.offsetTop + k.offsetHeight - ch : k.offsetTop - c.pad - (k.__brSnapMargin || 0);
                    ty = Math.max(0, Math.min(maxY, ty));
                    var dy = Math.abs(ty - sy);
                    if (dy < bestDY) { bestDY = dy; bestY = ty; }
                }
            }
            // proximity snapping only pulls when the nearest stop is within a quarter of the viewport
            if (bestX !== null && (bestDX < 1 || (!c.mandatory && bestDX > cw / 4))) bestX = null;
            if (bestY !== null && (bestDY < 1 || (!c.mandatory && bestDY > ch / 4))) bestY = null;
            if (bestX === null && bestY === null) return;
            animateScroll(el, bestX === null ? sx : bestX, bestY === null ? sy : bestY, 200);
        };
        var attachSnap = function (c) {
            var el = c.el;
            if (el.__brSnapAttached) return;
            el.__brSnapAttached = true;
            var timer = null;
            el.addEventListener('scroll', function () { if (el.__brScrollAnim) return; if (timer) clearTimeout(timer); timer = setTimeout(function () { timer = null; var cur = el.__brSnapConfig; if (cur) snapNow(cur); }, 120); }, false);
            el.addEventListener('touchstart', function () { el.__brTouching = true; }, false);
            el.addEventListener('touchend', function () { el.__brTouching = false; }, false);
            el.addEventListener('touchcancel', function () { el.__brTouching = false; }, false);
        };
        // balanced headings: the smallest max-width that keeps the line count (binary search, applied inline)
        var balance = function (el) {
            if (el.__brBalancing) return;
            var text = el.textContent || '';
            if (text.length > 400) return;
            var cs = getComputedStyle(el);
            if (cs.display === 'inline' || cs.whiteSpace === 'nowrap') return;
            el.__brBalancing = true;
            try {
                var prev = el.style.maxWidth;
                el.style.maxWidth = '';
                var full = el.clientWidth, lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 20;
                var height = el.offsetHeight, lines = Math.round(height / lineH);
                if (lines < 2 || full < 80) { el.style.maxWidth = ''; return; }
                if (el.__brBalanceKey === full + ':' + text.length) { el.style.maxWidth = prev; return; }
                var lo = Math.floor(full / lines), hi = full, best = full;
                for (var it = 0; it < 8 && hi - lo > 4; it++) {
                    var mid = Math.floor((lo + hi) / 2);
                    el.style.maxWidth = mid + 'px';
                    if (el.offsetHeight <= height + 1) { best = mid; hi = mid; } else lo = mid;
                }
                el.style.maxWidth = best + 'px';
                el.__brBalanceKey = full + ':' + text.length;
            } catch (e) {} finally { el.__brBalancing = false; }
        };
        onMarkers(function (marked) {
            rootSmooth = false;
            snapContainers = [];
            for (var i = 0; i < marked.length; i++) {
                var el = marked[i].el, cr = marked[i].cr;
                if (cr.indexOf('br-smooth') >= 0 && (el === document.documentElement || el === document.body)) rootSmooth = true;
                if (cr.indexOf('br-snap-x') >= 0 || cr.indexOf('br-snap-y') >= 0) {
                    var pad = /br-snap-pad\s+(-?\d+)/.exec(cr), padp = /br-snap-padp\s+(-?\d+)/.exec(cr);
                    var c = { el: el, x: cr.indexOf('br-snap-x') >= 0, y: cr.indexOf('br-snap-y') >= 0, mandatory: cr.indexOf('br-snap-m') >= 0, pad: pad ? parseInt(pad[1], 10) : 0 };
                    // a percentage padding is taken of the scrollport along the snapping axis
                    if (padp) c.pad = Math.round(parseInt(padp[1], 10) / 10000 * (c.x && !c.y ? el.clientWidth : el.clientHeight));
                    el.__brSnapConfig = c;
                    snapContainers.push(c);
                    attachSnap(c);
                }
                if (cr.indexOf('br-balance') >= 0) balance(el);
            }
        });
    })();
    // ---- Scroll-driven animations (markers br-tl-scroll / br-tl-view / br-tl-named-<name>, br-tl-inline/root/self,
    // ranges br-ar-s / br-ar-e, timeline sources br-stl-<name> / br-vtl-<name>): the animation is paused and
    // seeked with a negative animation-delay as the scroll position changes.
    (function () {
        var raf = function (fn) { return setTimeout(fn, 16); };   // rAF stalls in hidden pages; a timer always runs
        var RANGE = ['cover', 'contain', 'entry', 'exit', 'entry-crossing', 'exit-crossing'];
        var driven = [];
        var clamp01 = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };
        var scrollerOf = function (el, inline) {
            for (var n = el.parentNode; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentNode) {
                var cs = getComputedStyle(n), ov = inline ? cs.overflowX : cs.overflowY;
                if ((ov === 'auto' || ov === 'scroll') && (inline ? n.scrollWidth > n.clientWidth : n.scrollHeight > n.clientHeight)) return n;
            }
            return null;   // the viewport
        };
        var durationOf = function (el) {
            var cs = getComputedStyle(el), d = parseFloat(cs.webkitAnimationDuration || cs.animationDuration || '0');
            if (!(d > 0)) { el.style.webkitAnimationDuration = '1s'; el.style.animationDuration = '1s'; d = 1; }
            return d;
        };
        var progressFor = function (d) {
            var inline = d.inline, scroller = d.source === 'root' ? null : d.source || scrollerOf(d.subject || d.el, inline);
            if (d.kind === 'scroll') {
                var max, pos;
                if (!scroller) { max = inline ? document.documentElement.scrollWidth - window.innerWidth : document.documentElement.scrollHeight - window.innerHeight; pos = inline ? window.pageXOffset : window.pageYOffset; }
                else { max = inline ? scroller.scrollWidth - scroller.clientWidth : scroller.scrollHeight - scroller.clientHeight; pos = inline ? scroller.scrollLeft : scroller.scrollTop; }
                if (max <= 0) return 0;
                // offsets of the range: a percentage of the scroll range or a length (px) from its start
                var s0 = d.rsPx !== null ? d.rsPx : d.rsPct * max, s1 = d.rePx !== null ? d.rePx : d.rePct * max;
                return s1 === s0 ? 0 : clamp01((pos - s0) / (s1 - s0));
            }
            var subject = d.subject || d.el, rect = subject.getBoundingClientRect(), vTop, vSize;
            if (!scroller) { vTop = 0; vSize = inline ? window.innerWidth : window.innerHeight; }
            else { var sr = scroller.getBoundingClientRect(); vTop = inline ? sr.left : sr.top; vSize = inline ? scroller.clientWidth : scroller.clientHeight; }
            // view-timeline-inset shrinks the scrollport the subject is measured against
            if (d.insetS || d.insetE) {
                var is = d.insetS ? (d.insetS.pct !== null ? vSize * d.insetS.pct / 100 : d.insetS.px) : 0, ie = d.insetE ? (d.insetE.pct !== null ? vSize * d.insetE.pct / 100 : d.insetE.px) : 0;
                vTop += is;
                vSize -= is + ie;
            }
            var top = (inline ? rect.left : rect.top) - vTop, size = inline ? rect.width : rect.height;
            // the subject's start edge relative to the scrollport start, at 0 % and 100 % of each named range
            var edge = function (name, pct) {
                var a, b;
                switch (name) {
                    case 'entry': case 'entry-crossing': a = vSize; b = vSize - size; break;
                    case 'exit': case 'exit-crossing': a = 0; b = -size; break;
                    case 'contain': a = vSize - size; b = 0; break;
                    default: a = vSize; b = -size;
                }
                return a + (b - a) * pct;
            };
            // (a length offset moves that far into its range from the range's start)
            var t0 = d.rsPx !== null ? edge(d.rsName, 0) - d.rsPx : edge(d.rsName, d.rsPct);
            var t1 = d.rePx !== null ? edge(d.reName, 0) - d.rePx : edge(d.reName, d.rePct);
            return t0 === t1 ? 0 : clamp01((t0 - top) / (t0 - t1));
        };
        var apply = function () {
            for (var i = 0; i < driven.length; i++) {
                var d = driven[i], p = progressFor(d);
                var delay = (-(p * d.duration * 0.999)).toFixed(4) + 's';
                if (d.lastDelay !== delay) { d.lastDelay = delay; d.el.style.webkitAnimationDelay = delay; d.el.style.animationDelay = delay; }
            }
        };
        var scheduled = false;
        var onScroll = function () { if (scheduled || !driven.length) return; scheduled = true; raf(function () { scheduled = false; apply(); }); };
        onMarkers(function (marked) {
            var sources = {}, i, cr, el, m;
            for (i = 0; i < marked.length; i++) {
                cr = marked[i].cr; el = marked[i].el;
                var re = /br-(stl|vtl)-([\w-]+)/g, inset = function (side) {
                    var px = new RegExp('br-vti-' + side + '\\s+(-?\\d+)').exec(cr), pct = new RegExp('br-vtip-' + side + '\\s+(-?\\d+)').exec(cr);
                    return pct ? { pct: parseInt(pct[1], 10), px: null } : px ? { pct: null, px: parseInt(px[1], 10) } : null;
                };
                while ((m = re.exec(cr)) !== null) sources[m[1] + ':' + m[2]] = { el: el, inline: cr.indexOf('br-tl-src-inline') >= 0, insetS: inset('s'), insetE: inset('e') };
            }
            driven = [];
            for (i = 0; i < marked.length; i++) {
                cr = marked[i].cr; el = marked[i].el;
                m = /br-tl-(scroll|view|named-([\w-]+))/.exec(cr);
                if (!m) continue;
                var d = { el: el, kind: m[1] === 'view' ? 'view' : 'scroll', inline: cr.indexOf('br-tl-inline') >= 0, source: cr.indexOf('br-tl-root') >= 0 ? 'root' : cr.indexOf('br-tl-self') >= 0 ? el : null, subject: null,
                          rsName: 'cover', rsPct: 0, reName: 'cover', rePct: 1, rsPx: null, rePx: null, insetS: null, insetE: null, lastDelay: null };
                var pxs = /br-arpx-s\s+(-?\d+)/.exec(cr), pxe = /br-arpx-e\s+(-?\d+)/.exec(cr);
                if (pxs) d.rsPx = parseInt(pxs[1], 10);
                if (pxe) d.rePx = parseInt(pxe[1], 10);
                if (m[2]) {
                    var vt = sources['vtl:' + m[2]], st = sources['stl:' + m[2]];
                    if (vt) { d.kind = 'view'; d.subject = vt.el; d.inline = vt.inline; d.insetS = vt.insetS; d.insetE = vt.insetE; }
                    else if (st) { d.kind = 'scroll'; d.source = st.el === document.documentElement || st.el === document.body ? 'root' : st.el; d.inline = st.inline; }
                    else continue;
                }
                var rs = /br-ar-s\s+(\d+)/.exec(cr), rEnd = /br-ar-e\s+(\d+)/.exec(cr);
                if (rs) { d.rsName = RANGE[Math.floor(parseInt(rs[1], 10) / 1000)] || 'cover'; d.rsPct = (parseInt(rs[1], 10) % 1000) / 100; }
                if (rEnd) { d.reName = RANGE[Math.floor(parseInt(rEnd[1], 10) / 1000)] || 'cover'; d.rePct = (parseInt(rEnd[1], 10) % 1000) / 100; }
                if (d.kind === 'scroll' && rs && rs[1].indexOf('0') !== 0 && d.rsName !== 'cover') { d.rsPct = 0; }   // named ranges mean nothing for scroll timelines
                d.duration = durationOf(el);
                el.style.webkitAnimationPlayState = 'paused'; el.style.animationPlayState = 'paused';
                el.style.webkitAnimationFillMode = 'both'; el.style.animationFillMode = 'both';
                driven.push(d);
            }
            apply();
        });
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll, false);
        window.addEventListener('load', onScroll, false);
        window.__brScrollDriven = { list: function () { return driven; }, apply: apply, progress: progressFor };
    })();
    // ---- Popover API: [popover] elements, showPopover()/hidePopover()/togglePopover(), popovertarget buttons,
    // light dismiss for auto popovers, ToggleEvent; cssfix rewrites :popover-open to .br-popover-open
    if (Ep && !('popover' in Ep)) (function () {
        var open = [];
        addStyle('[popover]:not(.br-popover-open){display:none !important}' +
                 '[popover].br-popover-open{position:fixed;top:0;right:0;bottom:0;left:0;width:-webkit-fit-content;width:fit-content;height:-webkit-fit-content;height:fit-content;' +
                 'margin:auto;border:solid;padding:0.25em;overflow:auto;color:black;background:white;z-index:2147483646}');
        var ToggleEvent = function ToggleEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, false, type === 'beforetoggle'); e.oldState = init && init.oldState || ''; e.newState = init && init.newState || ''; return e; };
        try { ToggleEvent.prototype = Object.create(window.Event.prototype); ToggleEvent.prototype.oldState = ''; ToggleEvent.prototype.newState = ''; } catch (e0) {}
        if (!window.ToggleEvent) window.ToggleEvent = ToggleEvent;
        var isOpen = function (el) { return open.indexOf(el) >= 0; };
        var hide = function (el, viaDismiss) {
            var i = open.indexOf(el);
            if (i < 0) return;
            var before = new ToggleEvent('beforetoggle', { oldState: 'open', newState: 'closed' });
            el.dispatchEvent(before);
            open.splice(i, 1);
            setStateClass(el, 'br-popover-open', false);
            setTimeout(function () { el.dispatchEvent(new ToggleEvent('toggle', { oldState: 'open', newState: 'closed' })); }, 0);
        };
        var show = function (el) {
            if (isOpen(el) || !el.hasAttribute('popover')) return;
            var before = new ToggleEvent('beforetoggle', { oldState: 'closed', newState: 'open' });
            if (!el.dispatchEvent(before)) return;   // preventDefault keeps it closed
            var mode = (el.getAttribute('popover') || 'auto').toLowerCase();
            if (mode !== 'manual') {   // an auto popover closes the other auto popovers (nested ones stay)
                for (var i = open.length - 1; i >= 0; i--) if ((open[i].getAttribute('popover') || 'auto').toLowerCase() !== 'manual' && !open[i].contains(el)) hide(open[i]);
            }
            open.push(el);
            setStateClass(el, 'br-popover-open', true);
            setTimeout(function () { el.dispatchEvent(new ToggleEvent('toggle', { oldState: 'closed', newState: 'open' })); }, 0);
        };
        // the invoking element becomes the popover's implicit anchor (anchor positioning without a name)
        Ep.showPopover = function (opts) { if (opts && opts.source) this.__brInvoker = opts.source; show(this); };
        Ep.hidePopover = function () { hide(this); };
        Ep.togglePopover = function (force) {
            if (force && typeof force === 'object') { if (force.source) this.__brInvoker = force.source; force = force.force; }
            var want = force === undefined ? !isOpen(this) : !!force; if (want) show(this); else hide(this); return want;
        };
        try {
            Object.defineProperty(Ep, 'popover', { get: function () { if (!this.hasAttribute('popover')) return null; var v = (this.getAttribute('popover') || '').toLowerCase(); return v === 'manual' ? 'manual' : 'auto'; }, set: function (v) { if (v === null || v === undefined) this.removeAttribute('popover'); else this.setAttribute('popover', v); }, configurable: true });
            var targetProp = function (proto) {
                Object.defineProperty(proto, 'popoverTargetElement', { get: function () { var id = this.getAttribute('popovertarget'); return id ? document.getElementById(id) : null; }, set: function (el) { if (el && el.id) this.setAttribute('popovertarget', el.id); else this.removeAttribute('popovertarget'); }, configurable: true });
                Object.defineProperty(proto, 'popoverTargetAction', { get: function () { var a = (this.getAttribute('popovertargetaction') || '').toLowerCase(); return a === 'show' || a === 'hide' ? a : 'toggle'; }, set: function (v) { this.setAttribute('popovertargetaction', v); }, configurable: true });
            };
            if (window.HTMLButtonElement) targetProp(window.HTMLButtonElement.prototype);
            if (window.HTMLInputElement) targetProp(window.HTMLInputElement.prototype);
        } catch (e1) {}
        document.addEventListener('click', function (e) {
            var t = e.target;
            while (t && t.nodeType === 1 && !t.hasAttribute('popovertarget')) t = t.parentNode;
            if (t && t.nodeType === 1) {
                var target = document.getElementById(t.getAttribute('popovertarget') || '');
                if (target && target.hasAttribute('popover')) {
                    target.__brInvoker = t;
                    var action = (t.getAttribute('popovertargetaction') || 'toggle').toLowerCase();
                    if (action === 'show') show(target); else if (action === 'hide') hide(target); else { if (isOpen(target)) hide(target); else show(target); }
                    e.__brPopoverHandled = true;
                    return;
                }
            }
            // light dismiss: a click outside every open auto popover closes them
            for (var i = open.length - 1; i >= 0; i--) {
                var p = open[i];
                if ((p.getAttribute('popover') || 'auto').toLowerCase() === 'manual') continue;
                var inside = false, n = e.target;
                while (n) { if (n === p) { inside = true; break; } n = n.parentNode; }
                if (!inside) hide(p, true);
            }
        }, false);
        document.addEventListener('keydown', function (e) { if (e.keyCode === 27) for (var i = open.length - 1; i >= 0; i--) if ((open[i].getAttribute('popover') || 'auto').toLowerCase() !== 'manual') hide(open[i], true); }, false);
    })();
    // WebGL work left in the GPU's queue: a context that goes (the garbage collector took its canvas) with rendering still
    // queued crashes the iPad's driver (glDeleteRenderbuffers -> sgxEndRender -> sgxPatchDeferredFramebufferOffsets,
    // SIGSEGV). A canvas on the screen is presented, which flushes; a fingerprinting script's canvas outside the document
    // never is (LinkedIn made three at start: the app crashed every time a few seconds later). So each context with new
    // work is flushed at the end of the task; the pending list holds it until then.
    var glPending = [];
    var glFlushAll = function () {
        var list = glPending;
        glPending = [];
        for (var i = 0; i < list.length; i++) { list[i].__brGLDirty = false; try { list[i].flush(); } catch (e) {} }
    };
    var glDirty = function (gl) {
        if (gl.__brGLDirty) return;
        gl.__brGLDirty = true;
        glPending.push(gl);
        if (glPending.length === 1) setTimeout(glFlushAll, 0);
    };
    var WGLp = window.WebGLRenderingContext && window.WebGLRenderingContext.prototype;
    if (WGLp && !WGLp.__brFlushes) {
        WGLp.__brFlushes = true;
        var glWork = function (name) {
            var orig = WGLp[name];
            if (typeof orig !== 'function') return;
            WGLp[name] = function (a, b, c, d) {
                if (this.__brGLDirty !== true) glDirty(this);
                return orig.call(this, a, b, c, d);
            };
        };
        glWork('clear'); glWork('drawArrays'); glWork('drawElements');
    }
    // The engine knows WebGL only under its experimental name; pages ask for 'webgl' (and 'webgl2', which does not exist here)
    if (HCp && HCp.getContext && !HCp.__brGLAlias) {
        HCp.__brGLAlias = true;
        var origGL = HCp.getContext;
        HCp.getContext = function (type, attrs) {
            var ctx = origGL.apply(this, arguments);
            if (!ctx && type === 'webgl') { try { ctx = origGL.call(this, 'experimental-webgl', attrs); } catch (e) {} }
            // (a new context clears its drawing buffer: work already)
            if (ctx && WGLp && typeof type === 'string' && type.indexOf('webgl') >= 0 && !ctx.__brGLSeen) { ctx.__brGLSeen = true; glDirty(ctx); }
            return ctx;
        };
    }
    // canvas.getContext('bitmaprenderer'): a thin wrapper over the 2D context
    if (HCp && !window.ImageBitmapRenderingContext) {
        var BitmapContext = function ImageBitmapRenderingContext(canvas) { this.canvas = canvas; };
        BitmapContext.prototype.transferFromImageBitmap = function (bitmap) {
            var ctx = this.canvas.getContext('2d');
            if (!ctx) return;
            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            if (bitmap) try { ctx.drawImage(bitmap, 0, 0); } catch (e) {}
        };
        window.ImageBitmapRenderingContext = BitmapContext;
        var origGetContext = HCp.getContext;
        HCp.getContext = function (type) {
            if (type === 'bitmaprenderer') return this.__brBitmapContext || (this.__brBitmapContext = new BitmapContext(this));
            return origGetContext.apply(this, arguments);
        };
    }
    if (!window.createImageBitmap) {
        window.ImageBitmap = function ImageBitmap() {};
        window.createImageBitmap = function (source, sx, sy, sw, sh) {
            if (!P) return null;
            return new P(function (resolve, reject) {
                function finish(img) {
                    if (typeof sx === 'number' && typeof sw === 'number') {
                        var c = document.createElement('canvas');
                        c.width = sw; c.height = sh;
                        c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
                        img = c;
                    }
                    img.close = noop;
                    resolve(img);
                }
                if (source instanceof Blob) {
                    var url = URL.createObjectURL(source), img = new Image();
                    img.onload = function () { URL.revokeObjectURL(url); finish(img); };
                    img.onerror = function () { URL.revokeObjectURL(url); reject(domException('InvalidStateError', 'The image could not be decoded')); };
                    img.src = url;
                } else if (window.ImageData && source instanceof ImageData) {
                    var c = document.createElement('canvas');
                    c.width = source.width; c.height = source.height;
                    c.getContext('2d').putImageData(source, 0, 0);
                    finish(c);
                } else if (source && (source.tagName === 'IMG' || source.tagName === 'CANVAS' || source.tagName === 'VIDEO')) {
                    if (source.tagName === 'IMG' && !source.complete) { source.addEventListener('load', function () { finish(source); }, false); source.addEventListener('error', function () { reject(domException('InvalidStateError', 'The image could not be decoded')); }, false); }
                    else finish(source);
                } else {
                    reject(domException('InvalidStateError', 'Unsupported image source'));
                }
            });
        };
    }
    // new ImageData(w, h) / new ImageData(data, w[, h]): the old engine's ImageData cannot be constructed; a context
    // makes one (with a copy of the given pixels, not the same buffer)
    (function () {
        var Native = window.ImageData, ctx = null, works = false;
        if (!Native) return;
        try { works = new Native(1, 1).width === 1; } catch (e) {}
        if (works) return;
        var make = function ImageData(a, b, c) {
            if (!ctx) { var cv = document.createElement('canvas'); cv.width = cv.height = 1; ctx = cv.getContext('2d'); }
            var img;
            if (typeof a === 'number') {
                if (!(a > 0) || !(b > 0)) throw domException('IndexSizeError', 'The source width and height must be positive');
                img = ctx.createImageData(a, b);
            } else {
                var w = b, h = c !== undefined ? c : a && a.length / 4 / w;
                if (!a || !(w > 0) || !(h > 0) || a.length !== w * h * 4) throw domException('IndexSizeError', 'The input data length is not equal to (4 * width * height)');
                img = ctx.createImageData(w, h);
                var d = img.data;
                if (d.set) d.set(a); else for (var i = 0; i < a.length; i++) d[i] = a[i];
            }
            return img;
        };
        make.prototype = Native.prototype;
        window.ImageData = make;
    })();

    // ---- IndexedDB: the WebSQL-backed shim (150 KB) is fetched on first use only
    if (!window.indexedDB && window.openDatabase) {
        var idbLoaded = false, idbLoading = false;
        var idbNames = ['indexedDB', 'IDBKeyRange', 'IDBFactory', 'IDBDatabase', 'IDBObjectStore', 'IDBIndex', 'IDBTransaction', 'IDBRequest', 'IDBOpenDBRequest', 'IDBCursor', 'IDBCursorWithValue', 'IDBVersionChangeEvent'];
        var loadIndexedDB = function () {
            if (idbLoaded || idbLoading) return;
            idbLoading = true;
            for (var i = 0; i < idbNames.length; i++) try { delete window[idbNames[i]]; } catch (e) {}
            try {
                var tag = document.querySelector('script[src*="/__br_polyfills"], script[src*="ios6-browser.invalid/polyfills"]');
                var crc = tag ? /polyfills(-[0-9a-f]+)?\.js/.exec(tag.src) : null;
                var url = 'https://ios6-browser.invalid/indexeddbshim' + (crc && crc[1] ? crc[1] : '') + '.js';
                var x = new XMLHttpRequest();
                x.open('GET', url, false);
                x.send(null);
                if (x.status === 200 && x.responseText) {
                    (0, eval)(x.responseText);
                    if (window.shimIndexedDB && window.shimIndexedDB.__useShim) window.shimIndexedDB.__useShim();
                    // (transactions commit by themselves here: an explicit commit() only asks for it sooner - Windy's
                    // "'undefined' is not a function (evaluating 'a.commit()')")
                    var IDBT = window.IDBTransaction && window.IDBTransaction.prototype;
                    if (IDBT && !IDBT.commit) IDBT.commit = function () {};
                    // (the shim's globals are getters, indexedDB's throws "Illegal invocation" unless `this` is the
                    // window it was set on, and the old engine hands a getter reached by a bare name another object
                    // for the global: TikTok's `typeof indexedDB` threw and its app gave up; plain values instead)
                    for (var gi = 0; gi < idbNames.length; gi++) {
                        try {
                            var gd = Object.getOwnPropertyDescriptor(window, idbNames[gi]);
                            if (gd && gd.get) {
                                var gv = window[idbNames[gi]];
                                Object.defineProperty(window, idbNames[gi], { value: gv, writable: true, configurable: true, enumerable: !!gd.enumerable });
                            }
                        } catch (e5) {}
                    }
                }
            } catch (e2) { if (window.console && console.error) console.error('IndexedDB shim failed: ' + e2.message); }
            idbLoaded = true;
            idbLoading = false;
        };
        for (var idbn = 0; idbn < idbNames.length; idbn++) (function (name) {
            try {
                Object.defineProperty(window, name, {
                    configurable: true, enumerable: true,
                    get: function () { loadIndexedDB(); return window[name]; },
                    set: function (v) { try { delete window[name]; } catch (e) {} window[name] = v; }
                });
            } catch (e3) {}
        })(idbNames[idbn]);
    }

    // ---- Workers, storage, files
    if (!window.SharedWorker) window.SharedWorker = function SharedWorker() { throw domException('NotSupportedError', 'SharedWorker is not available'); };
    if (!window.Worklet) window.Worklet = function Worklet() {};
    // the Cache API (caches.open(name).put/match...), in memory for the page's life and at most 150 entries (the iPad's
    // memory): Telegram Web read caches at start ("Can't find variable: caches"); the same in worker-shims.js
    if (!window.caches && P) {
        (function (G) {
            var total = [];
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
        })(window);
    }
    if (!window.requestFileSystem && !window.webkitRequestFileSystem) {
        window.requestFileSystem = window.webkitRequestFileSystem = function (type, size, ok, err) { setTimeout(function () { if (err) err(domException('SecurityError', 'The file system is not available')); }, 0); };
        window.resolveLocalFileSystemURL = window.webkitResolveLocalFileSystemURL = function (url, ok, err) { setTimeout(function () { if (err) err(domException('NotFoundError', 'not found')); }, 0); };
        window.TEMPORARY = 0; window.PERSISTENT = 1;
    }
    if (navigator.storage && !navigator.storage.persist) { navigator.storage.persist = function () { return resolved(false); }; navigator.storage.persisted = function () { return resolved(false); }; navigator.storage.getDirectory = rejectWith('NotSupportedError', 'no origin private file system'); }
    if (!navigator.locks) navigator.locks = { request: function (name, opts, cb) { if (typeof opts === 'function') cb = opts; var lock = { name: name, mode: 'exclusive' }; return P ? P.resolve().then(function () { return cb(lock); }) : cb(lock); }, query: function () { return resolved({ held: [], pending: [] }); } };
    if (!window.PushManager) { window.PushManager = function PushManager() {}; window.PushManager.supportedContentEncodings = []; window.PushSubscription = function PushSubscription() {}; }
    if (!navigator.registerProtocolHandler) navigator.registerProtocolHandler = noop;
    if (!navigator.registerContentHandler) navigator.registerContentHandler = noop;
    if (!navigator.unregisterProtocolHandler) navigator.unregisterProtocolHandler = noop;
    if (!navigator.setAppBadge) { navigator.setAppBadge = function () { return resolved(); }; navigator.clearAppBadge = function () { return resolved(); }; }
    if (!navigator.wakeLock) navigator.wakeLock = { request: rejectWith('NotAllowedError', 'Wake lock is not available') };
    if (!navigator.vibrate) navigator.vibrate = function () { return false; };
    if (!navigator.getBattery) navigator.getBattery = function () { return resolved({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1, addEventListener: noop, removeEventListener: noop, onchargingchange: null, onlevelchange: null }); };
    if (!navigator.permissions) navigator.permissions = { query: function (desc) { var name = desc && desc.name; var state = (name === 'geolocation') ? 'prompt' : 'denied'; return resolved({ state: state, status: state, name: name, onchange: null, addEventListener: noop, removeEventListener: noop }); } };
    if (!navigator.userAgentData) navigator.userAgentData = { brands: [{ brand: 'Safari', version: '6' }], mobile: true, platform: 'iOS', getHighEntropyValues: function () { return resolved({ platform: 'iOS', platformVersion: '6.1', architecture: 'arm', model: '', uaFullVersion: '6.0' }); }, toJSON: function () { return { brands: this.brands, mobile: true, platform: 'iOS' }; } };
    if (!navigator.hardwareConcurrency) try { navigator.hardwareConcurrency = 2; } catch (e) {}
    if (!('deviceMemory' in navigator)) try { navigator.deviceMemory = 0.5; } catch (e) {}
    if (!navigator.scheduling) navigator.scheduling = { isInputPending: function () { return false; } };
    if (!window.scheduler) window.scheduler = { postTask: function (cb, opts) { var delay = opts && opts.delay || 0; return new P(function (res, rej) { setTimeout(function () { try { res(cb()); } catch (e) { rej(e); } }, delay); }); }, yield: function () { return new P(function (res) { setTimeout(res, 0); }); } };
    if (!navigator.cookieEnabled) try { navigator.cookieEnabled = true; } catch (e) {}
    // Interface objects the old engine does not expose for objects it has (Navigator, History, Location...): a page's
    // `navigator instanceof Navigator` or `Navigator.prototype` threw "Navigator is not defined" (TikTok's security
    // SDK stopped there, and the feed with it). The prototype is the instance's own; a plain object of these shims
    // gets a prototype of its own, so instanceof tells it apart from other objects.
    var exposeInterface = function (name, instance) {
        if (window[name] !== undefined || !instance || (typeof instance !== 'object' && typeof instance !== 'function')) return;
        var C = function () { throw new TypeError('Illegal constructor'); }, proto = null;
        try { proto = Object.getPrototypeOf(instance); } catch (e0) { proto = null; }
        if (!proto || proto === Object.prototype) {
            proto = {};
            try { Object.setPrototypeOf ? Object.setPrototypeOf(instance, proto) : (instance.__proto__ = proto); } catch (e1) { return; }
        }
        C.prototype = proto;
        try { Object.defineProperty(proto, 'constructor', { value: C, configurable: true, writable: true }); } catch (e2) {}
        try { Object.defineProperty(C, 'name', { value: name, configurable: true }); } catch (e3) {}
        try { Object.defineProperty(window, name, { value: C, configurable: true, writable: true }); } catch (e4) { window[name] = C; }
        mirrorMethods(instance, proto);
        onReady(function () { mirrorMethods(instance, proto); });
    };
    // The methods these shims put on the object itself (navigator.sendBeacon, vibrate, getBattery...) are on the
    // prototype today, where pages call them: Seznam's scripts run Navigator.prototype.sendBeacon.apply(...), which
    // threw once Navigator existed ("'undefined' is not an object", seznamzpravy.cz, sport.cz)
    var mirrorMethods = function (instance, proto) {
        var names = [];
        try { names = Object.getOwnPropertyNames(instance); } catch (e) { return; }
        for (var i = 0; i < names.length; i++) {
            var k = names[i], v;
            if (k === 'constructor' || k.slice(0, 4) === '__br' || k in proto) continue;
            try { v = instance[k]; } catch (e1) { continue; }
            if (typeof v !== 'function') continue;
            try { Object.defineProperty(proto, k, { value: v, writable: true, configurable: true }); } catch (e2) {}
        }
    };
    var perf = window.performance;
    exposeInterface('Navigator', navigator);
    exposeInterface('History', window.history);
    exposeInterface('Location', window.location);
    exposeInterface('BarProp', window.locationbar || window.menubar || window.toolbar);
    exposeInterface('Performance', perf);
    exposeInterface('PerformanceTiming', perf && perf.timing);
    exposeInterface('PerformanceNavigation', perf && perf.navigation);
    exposeInterface('Geolocation', navigator.geolocation);
    exposeInterface('Permissions', navigator.permissions);
    exposeInterface('StorageManager', navigator.storage);
    exposeInterface('MediaDevices', navigator.mediaDevices);
    exposeInterface('ServiceWorkerContainer', navigator.serviceWorker);
    exposeInterface('NetworkInformation', navigator.connection);
    exposeInterface('External', window.external);
    if (!window.cookieStore) window.cookieStore = {
        get: function (name) { var m = document.cookie.match(new RegExp('(?:^|; )' + String(typeof name === 'object' ? name.name : name).replace(/([.*+?^${}()|[\]\\])/g, '\\$1') + '=([^;]*)')); return resolved(m ? { name: typeof name === 'object' ? name.name : name, value: decodeURIComponent(m[1]) } : null); },
        getAll: function () { var out = [], parts = document.cookie ? document.cookie.split('; ') : []; for (var i = 0; i < parts.length; i++) { var eq = parts[i].indexOf('='); out.push({ name: parts[i].slice(0, eq), value: decodeURIComponent(parts[i].slice(eq + 1)) }); } return resolved(out); },
        set: function (name, value) { var o = typeof name === 'object' ? name : { name: name, value: value }; var s = o.name + '=' + encodeURIComponent(o.value) + '; path=' + (o.path || '/'); if (o.expires) s += '; expires=' + new Date(o.expires).toUTCString(); if (o.domain) s += '; domain=' + o.domain; document.cookie = s; return resolved(); },
        'delete': function (name) { var n = typeof name === 'object' ? name.name : name; document.cookie = n + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'; return resolved(); },
        addEventListener: noop, removeEventListener: noop
    };

    // ---- Editing, interaction, security attributes
    defineBoolAttrProp(Ep, 'spellcheck');
    defineBoolAttrProp(Ep, 'inert');
    defineAttrProp(Ep, 'enterKeyHint', 'enterkeyhint');
    defineAttrProp(Ep, 'inputMode', 'inputmode');
    defineAttrProp(Ep, 'autocapitalize');
    if (window.HTMLScriptElement) { defineAttrProp(window.HTMLScriptElement.prototype, 'integrity'); defineAttrProp(window.HTMLScriptElement.prototype, 'referrerPolicy', 'referrerpolicy'); }
    if (window.HTMLLinkElement) { defineAttrProp(window.HTMLLinkElement.prototype, 'integrity'); defineAttrProp(window.HTMLLinkElement.prototype, 'as'); defineAttrProp(window.HTMLLinkElement.prototype, 'referrerPolicy', 'referrerpolicy'); }
    if (window.HTMLIFrameElement) { defineAttrProp(window.HTMLIFrameElement.prototype, 'allow'); defineAttrProp(window.HTMLIFrameElement.prototype, 'loading'); defineAttrProp(window.HTMLIFrameElement.prototype, 'referrerPolicy', 'referrerpolicy'); }
    if (window.HTMLAnchorElement) { defineAttrProp(window.HTMLAnchorElement.prototype, 'download'); defineAttrProp(window.HTMLAnchorElement.prototype, 'referrerPolicy', 'referrerpolicy'); }
    if (!window.ClipboardEvent) window.ClipboardEvent = function ClipboardEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, !!(init && init.bubbles), !!(init && init.cancelable)); e.clipboardData = (init && init.clipboardData) || null; return e; };
    if (!window.DataTransfer) {
        window.DataTransfer = function DataTransfer() { this.__data = {}; this.dropEffect = 'none'; this.effectAllowed = 'none'; this.files = []; this.items = []; this.types = []; };
        window.DataTransfer.prototype = {
            setData: function (type, value) { this.__data[type] = String(value); if (this.types.indexOf(type) < 0) this.types.push(type); },
            getData: function (type) { return this.__data[type] || ''; },
            clearData: function (type) { if (type) { delete this.__data[type]; } else { this.__data = {}; this.types = []; } },
            setDragImage: noop
        };
    }
    if (!window.DragEvent) window.DragEvent = function DragEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, !!(init && init.bubbles), !!(init && init.cancelable)); e.dataTransfer = (init && init.dataTransfer) || new window.DataTransfer(); return e; };
    // ---- Drag and drop. The old engine has neither the draggable attribute nor drag events, and a finger cannot drag
    // anything: the attributes and handler properties are here, and on a page that listens for drag events a finger
    // that moves a draggable="true" element drags it - dragstart with a DataTransfer, a see-through copy following the
    // finger, dragenter / dragover / dragleave on what is under it, drop where dragover said yes, then dragend
    // (sortable lists, boards). A page that takes the touch itself (preventDefault) keeps it.
    (function () {
        if (!Ep) return;
        var probe = document.createElement('div'), TYPES = ['drag', 'dragstart', 'dragenter', 'dragover', 'dragleave', 'dragend', 'drop'];
        if (!('draggable' in probe)) {
            try {
                Object.defineProperty(Ep, 'draggable', {
                    get: function () {
                        var v = this.getAttribute('draggable');
                        return v === 'true' ? true : v === 'false' ? false : this.tagName === 'IMG' || (this.tagName === 'A' && this.hasAttribute('href'));
                    },
                    set: function (v) { this.setAttribute('draggable', v ? 'true' : 'false'); },
                    configurable: true
                });
            } catch (e0) {}
        }
        if (!('dropzone' in probe)) defineAttrProp(Ep, 'dropzone');
        for (var ti = 0; ti < TYPES.length; ti++) (function (type) {
            if (('on' + type) in probe) return;
            var key = '__brOn' + type;
            try {
                Object.defineProperty(Ep, 'on' + type, {
                    get: function () { return this[key] || null; },
                    set: function (fn) {
                        if (this[key]) this.removeEventListener(type, this[key], false);
                        this[key] = typeof fn === 'function' ? fn : null;
                        if (this[key]) { this.addEventListener(type, this[key], false); window.__brPageDnD = true; }
                    },
                    configurable: true
                });
            } catch (e1) {}
        })(TYPES[ti]);
        if (!('ontouchstart' in window)) return;
        var transfer = function () {
            var dt;
            try { dt = new window.DataTransfer(); } catch (e2) { dt = null; }
            if (!dt || !dt.setData) {
                dt = { __data: {}, types: [], files: [], items: [] };
                dt.setData = function (t, v) { this.__data[t] = String(v); if (this.types.indexOf(t) < 0) this.types.push(t); };
                dt.getData = function (t) { return this.__data[t] || ''; };
                dt.clearData = function (t) { if (t) delete this.__data[t]; else { this.__data = {}; this.types = []; } };
            }
            try { dt.effectAllowed = 'all'; dt.dropEffect = 'none'; } catch (e3) {}
            dt.setDragImage = function (el, x, y) { this.__brImage = el; this.__brX = x || 0; this.__brY = y || 0; };
            return dt;
        };
        // (a plain event with the mouse event's fields as its own properties: a MouseEvent of this engine has a read-only
        // dataTransfer of its own, which stays null)
        var fire = function (target, type, t, dt, cancelable) {
            var e = document.createEvent('Event');
            e.initEvent(type, true, cancelable);
            var own = { dataTransfer: dt, clientX: t.clientX, clientY: t.clientY, screenX: t.screenX, screenY: t.screenY, pageX: t.clientX + window.pageXOffset,
                        pageY: t.clientY + window.pageYOffset, offsetX: 0, offsetY: 0, button: 0, buttons: type === 'drop' || type === 'dragend' ? 0 : 1, which: 1,
                        ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, relatedTarget: null };
            for (var k in own) { try { Object.defineProperty(e, k, { value: own[k], configurable: true, enumerable: true }); } catch (e4) { e[k] = own[k]; } }
            try { if (window.MouseEvent && window.MouseEvent.prototype) e.__proto__ = window.MouseEvent.prototype; } catch (e5) {}
            return target.dispatchEvent(e);   // (false: the page prevented it)
        };
        var ghostOf = function (s, t) {
            var src = s.dt.__brImage && s.dt.__brImage.nodeType === 1 ? s.dt.__brImage : s.src, r = src.getBoundingClientRect(), g = src.cloneNode(true);
            var ids = g.querySelectorAll ? g.querySelectorAll('[id]') : [];
            g.removeAttribute('id');
            for (var i = 0; i < ids.length; i++) ids[i].removeAttribute('id');
            s.dx = s.dt.__brImage ? s.dt.__brX : t.clientX - r.left;
            s.dy = s.dt.__brImage ? s.dt.__brY : t.clientY - r.top;
            g.style.cssText += ';position:fixed!important;left:0!important;top:0!important;margin:0!important;pointer-events:none!important;opacity:.6;z-index:2147483647;' +
                'width:' + r.width + 'px;height:' + r.height + 'px;-webkit-box-sizing:border-box';
            document.body.appendChild(g);
            return g;
        };
        var state = null;
        var draggableFrom = function (el) {
            for (; el && el.nodeType === 1; el = el.parentNode) {
                var a = el.getAttribute('draggable');
                if (a === 'true') return el;
                if (a === 'false') return null;
            }
            return null;
        };
        document.addEventListener('touchstart', function (ev) {
            state = null;
            if (!window.__brPageDnD || ev.defaultPrevented || !ev.touches || ev.touches.length !== 1) return;
            var src = draggableFrom(ev.target);
            if (src) state = { src: src, x: ev.touches[0].clientX, y: ev.touches[0].clientY, dragging: false, over: null, ok: false };
        }, false);
        document.addEventListener('touchmove', function (ev) {
            if (!state) return;
            var t = ev.touches[0], s = state;
            if (!s.dragging) {
                if (ev.defaultPrevented || ev.touches.length !== 1) { state = null; return; }
                if (Math.abs(t.clientX - s.x) + Math.abs(t.clientY - s.y) < 8) return;
                s.dt = transfer();
                if (!fire(s.src, 'dragstart', t, s.dt, true)) { state = null; return; }
                s.dragging = true;
                s.ghost = ghostOf(s, t);
            }
            ev.preventDefault();   // (the finger drags; the page does not scroll)
            s.ghost.style.webkitTransform = 'translate3d(' + (t.clientX - s.dx) + 'px,' + (t.clientY - s.dy) + 'px,0)';
            fire(s.src, 'drag', t, s.dt, true);
            var under = document.elementFromPoint(t.clientX, t.clientY);
            if (under !== s.over) {
                if (under) fire(under, 'dragenter', t, s.dt, true);
                if (s.over) fire(s.over, 'dragleave', t, s.dt, false);
                s.over = under;
            }
            s.ok = under ? !fire(under, 'dragover', t, s.dt, true) : false;
        }, false);
        var end = function (ev) {
            var s = state;
            state = null;
            if (!s || !s.dragging) return;
            var t = ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0] : { clientX: 0, clientY: 0, screenX: 0, screenY: 0 };
            if (s.over && s.ok && ev.type === 'touchend') fire(s.over, 'drop', t, s.dt, true);
            else { try { s.dt.dropEffect = 'none'; } catch (e5) {} }
            fire(s.src, 'dragend', t, s.dt, false);
            if (s.ghost && s.ghost.parentNode) s.ghost.parentNode.removeChild(s.ghost);
            ev.preventDefault();   // (no click after a drag)
        };
        document.addEventListener('touchend', end, false);
        document.addEventListener('touchcancel', end, false);
    })();
    if (!window.InputEvent) window.InputEvent = function InputEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, !!(init && init.bubbles), !!(init && init.cancelable)); e.data = (init && init.data) || null; e.inputType = (init && init.inputType) || ''; e.isComposing = false; return e; };
    if (!window.FocusEvent) window.FocusEvent = function FocusEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, !!(init && init.bubbles), !!(init && init.cancelable)); e.relatedTarget = (init && init.relatedTarget) || null; return e; };
    if (!window.SecurityPolicyViolationEvent) window.SecurityPolicyViolationEvent = function SecurityPolicyViolationEvent() {};
    if (!window.ResizeObserverEntry) window.ResizeObserverEntry = function ResizeObserverEntry() {};
    // (no Sanitizer and no Element.setHTML: the standard ones remove everything that can run script, and sites that find
    // them hand them untrusted markup instead of running their own sanitizer - a stand-in that is innerHTML underneath
    // turned that into script injection. Without them pages keep to DOMPurify or what else they bring.)
    // Trusted Types: a policy gives what its own rule makes of the text; one without the rule for that kind throws, as
    // in other browsers - handing the raw text back made code that counts on that refusal pass markup through. (The
    // rules are taken when the policy is made, as the standard has it.)
    if (!window.trustedTypes) {
        var ttRule = function (name, rules, kind) {
            var f = rules[kind];
            return function () {
                if (typeof f !== 'function') throw new TypeError("Failed to execute '" + kind + "' on 'TrustedTypePolicy': Policy " + name + "'s TrustedTypePolicyOptions did not specify a '" + kind + "' member.");
                return f.apply(null, arguments);
            };
        };
        window.trustedTypes = { createPolicy: function (name, rules) { rules = rules || {}; name = String(name); return { name: name, createHTML: ttRule(name, rules, 'createHTML'), createScript: ttRule(name, rules, 'createScript'), createScriptURL: ttRule(name, rules, 'createScriptURL') }; },
            isHTML: function () { return false; }, isScript: function () { return false; }, isScriptURL: function () { return false; }, emptyHTML: '', emptyScript: '', getAttributeType: function () { return null; }, getPropertyType: function () { return null; }, defaultPolicy: null };
    }

    // ---- Elements the old parser does not know get real constructors, prototypes and behaviour
    var HEp = window.HTMLElement && window.HTMLElement.prototype;
    var protoSwapWorks = false;
    try {
        var probeEl = document.createElement('x-probe');
        var probeProto = Object.create(Object.getPrototypeOf(probeEl));
        probeProto.__brProbe = 1;
        probeEl.__proto__ = probeProto;
        protoSwapWorks = probeEl.__brProbe === 1;
    } catch (e) {}
    if (HEp && protoSwapWorks) {
        var upgrades = {};   // tag -> prototype
        var createElementBefore = document.createElement;
        var defineElementClass = function (tag, className, define) {
            // only elements this engine does not know get a synthetic class
            try { if (!window.HTMLUnknownElement || !(createElementBefore.call(document, tag) instanceof window.HTMLUnknownElement)) return; } catch (e0) { return; }
            var proto = Object.create(HEp);
            if (className) {
                var Ctor = function () { throw new TypeError('Illegal constructor'); };
                try { Object.defineProperty(Ctor, 'name', { value: className }); } catch (e) {}
                Ctor.prototype = proto;
                proto.constructor = Ctor;
                if (!window[className] || typeof window[className] === 'function' && !window[className].prototype.__brReal) window[className] = Ctor;
                proto.__brReal = true;
            }
            if (define) define(proto);
            upgrades[tag] = proto;
        };
        var attrProp = function (proto, name, attr) { defineAttrProp(proto, name, attr || name.toLowerCase()); };
        var numProp = function (proto, name, fallback, after) {
            try {
                Object.defineProperty(proto, name, {
                    get: function () { var v = parseFloat(this.getAttribute(name)); return isNaN(v) ? (typeof fallback === 'function' ? fallback.call(this) : fallback) : v; },
                    set: function (v) { this.setAttribute(name, String(v)); if (after) after.call(this); },
                    configurable: true
                });
            } catch (e) {}
        };
        var paintBar = function (el) {
            var value = parseFloat(el.getAttribute('value')), min = parseFloat(el.getAttribute('min')), max = parseFloat(el.getAttribute('max'));
            if (isNaN(min)) min = 0;
            if (isNaN(max)) max = 1;
            if (max <= min) max = min + 1;
            if (isNaN(value)) { el.style.backgroundImage = 'none'; return; }
            var pct = Math.max(0, Math.min(100, (value - min) / (max - min) * 100));
            var color = el.tagName === 'METER' ? (pct < 34 ? '#e2493b' : pct < 67 ? '#e7b416' : '#2dc937') : '#4a90e2';
            el.style.backgroundImage = '-webkit-linear-gradient(left, ' + color + ' ' + pct + '%, transparent ' + pct + '%)';
        };
        addStyle('main{display:block}picture{display:inline}' +
                 'progress,meter{display:inline-block;width:10em;height:1em;vertical-align:-0.2em;background-color:#e6e6e6;border:1px solid #bbb;border-radius:3px;overflow:hidden;-webkit-box-sizing:border-box;box-sizing:border-box;background-repeat:no-repeat}' +
                 'datalist{display:none}time,data{display:inline}menu{display:block;list-style:none;margin:0;padding:0}' +
                 // (the engine's own textarea overflow is auto, which crashed WebCore inside a horizontal -webkit-box when
                 // its scrollbars came or went; see the overflow case in cssfix.js)
                 'textarea{overflow:scroll}');
        defineElementClass('main', null, null);
        defineElementClass('time', 'HTMLTimeElement', function (p) { attrProp(p, 'dateTime', 'datetime'); });
        defineElementClass('data', 'HTMLDataElement', function (p) { attrProp(p, 'value'); });
        defineElementClass('picture', 'HTMLPictureElement', null);
        defineElementClass('progress', 'HTMLProgressElement', function (p) {
            numProp(p, 'value', NaN, function () { paintBar(this); });
            numProp(p, 'max', 1, function () { paintBar(this); });
            try { Object.defineProperty(p, 'position', { get: function () { var v = this.value; return isNaN(v) ? -1 : Math.max(0, Math.min(1, v / (this.max || 1))); }, configurable: true }); } catch (e) {}
            try { Object.defineProperty(p, 'labels', { get: function () { return []; }, configurable: true }); } catch (e2) {}
        });
        defineElementClass('meter', 'HTMLMeterElement', function (p) {
            var names = ['value', 'min', 'max', 'low', 'high', 'optimum'];
            for (var i = 0; i < names.length; i++) numProp(p, names[i], names[i] === 'max' ? 1 : 0, function () { paintBar(this); });
            try { Object.defineProperty(p, 'labels', { get: function () { return []; }, configurable: true }); } catch (e) {}
        });
        defineElementClass('datalist', 'HTMLDataListElement', function (p) {
            try { Object.defineProperty(p, 'options', { get: function () { return this.getElementsByTagName('option'); }, configurable: true }); } catch (e) {}
        });
        var defineMenuProps = function (p) {
            try {
                Object.defineProperty(p, 'type', {
                    get: function () {
                        var t = (this.getAttribute('type') || '').toLowerCase();
                        if (t === 'context' || t === 'toolbar') return t;
                        // a menu without a type inherits "context" from an enclosing context menu
                        var parent = this.parentNode;
                        while (parent && parent.nodeType === 1) {
                            if (parent.tagName === 'MENU') return parent.type;
                            parent = parent.parentNode;
                        }
                        return 'toolbar';
                    },
                    set: function (v) { this.setAttribute('type', String(v)); },
                    configurable: true
                });
            } catch (e) {}
            attrProp(p, 'label');
        };
        defineElementClass('menuitem', 'HTMLMenuItemElement', function (p) { attrProp(p, 'label'); attrProp(p, 'icon'); attrProp(p, 'type'); defineBoolAttrProp(p, 'disabled'); defineBoolAttrProp(p, 'checked'); defineBoolAttrProp(p, 'default'); });
        if (window.HTMLMenuElement && window.HTMLMenuElement.prototype && !('type' in document.createElement('menu'))) defineMenuProps(window.HTMLMenuElement.prototype);
        else defineElementClass('menu', 'HTMLMenuElement', defineMenuProps);
        defineElementClass('track', 'HTMLTrackElement', function (p) {
            attrProp(p, 'kind'); attrProp(p, 'src'); attrProp(p, 'srclang'); attrProp(p, 'label');
            defineBoolAttrProp(p, 'default');
            try { Object.defineProperty(p, 'track', { get: function () { return this.__brTrack || (this.__brTrack = { kind: this.kind || 'subtitles', label: this.label, language: this.srclang, mode: 'disabled', cues: null, activeCues: null, addCue: noop, removeCue: noop, addEventListener: noop, removeEventListener: noop }); }, configurable: true }); } catch (e) {}
            try { Object.defineProperty(p, 'readyState', { get: function () { return 0; }, configurable: true }); } catch (e2) {}
        });
        if (window.dialogPolyfill) defineElementClass('dialog', 'HTMLDialogElement', null);
        var upgradeKnownElement = function (el) {
            var proto = upgrades[el.tagName ? el.tagName.toLowerCase() : ''];
            if (!proto || Object.getPrototypeOf(el) === proto) return;
            try { el.__proto__ = proto; } catch (e) {}
            if (el.tagName === 'PROGRESS' || el.tagName === 'METER') paintBar(el);
        };
        var upgradeSelector = null;
        var upgradeKnownTree = function (root) {
            if (root.nodeType === 1) {
                upgradeKnownElement(root);
                if (!root.firstElementChild) return;
            }
            if (!root.querySelectorAll) return;
            var list = root.querySelectorAll(upgradeSelector || (upgradeSelector = Object.keys(upgrades).join(',')));
            for (var i = 0; i < list.length; i++) upgradeKnownElement(list[i]);
        };
        if (Object.keys(upgrades).length) {
            document.createElement = function (name) {
                var el = createElementBefore.call(document, name);
                if (typeof name === 'string' && upgrades[name.toLowerCase()]) upgradeKnownElement(el);
                return el;
            };
            onReady(function () { upgradeKnownTree(document); });
            observeAddedTree(upgradeKnownTree);
        }
        if (window.MutationObserver) {
            var barObserver = new MutationObserver(function (records) {
                for (var r = 0; r < records.length; r++) { var t = records[r].target; if (t && (t.tagName === 'PROGRESS' || t.tagName === 'METER')) paintBar(t); }
            });
            onReady(function () { try { barObserver.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['value', 'max', 'min'] }); } catch (e) {} });
        }
        // <input list="..."> and <fieldset>.elements
        if (window.HTMLInputElement) {
            var IPp = window.HTMLInputElement.prototype;
            if (!('list' in IPp)) try { Object.defineProperty(IPp, 'list', { get: function () { var id = this.getAttribute('list'); return id ? document.getElementById(id) : null; }, configurable: true }); } catch (e) {}
            defineBoolAttrProp(IPp, 'webkitdirectory');
            defineBoolAttrProp(IPp, 'directory');
            if (!window.Directory) window.Directory = function Directory() { this.name = ''; this.path = ''; };
        }
        if (window.HTMLFieldSetElement && !('elements' in window.HTMLFieldSetElement.prototype)) {
            try { Object.defineProperty(window.HTMLFieldSetElement.prototype, 'elements', { get: function () { return this.querySelectorAll('input,select,textarea,button,fieldset,object,output'); }, configurable: true }); } catch (e) {}
        }
    }
    // custom elements v0 on top of the v1 shim
    if (!document.registerElement) {
        document.registerElement = function (name, options) {
            options = options || {};
            var proto = options.prototype || HEp;
            var Ctor = function () { return document.createElement(name); };
            Ctor.prototype = proto;
            var wrapped = function () {};
            wrapped.prototype = proto;
            wrapped.observedAttributes = [];
            var v0 = function () {
                var el = this;
                try { if (proto.createdCallback) proto.createdCallback.call(el); } catch (e) {}
                try { if (proto.attachedCallback) proto.attachedCallback.call(el); } catch (e2) {}
            };
            v0.prototype = proto;
            try { window.customElements.define(name, v0); } catch (e3) {}
            return Ctor;
        };
    }
    // drag and drop handler properties (touch devices have no native drag events)
    var dragNames = ['drag', 'dragstart', 'dragenter', 'dragover', 'dragleave', 'dragend', 'drop'];
    var defineDragHandlers = function (obj) {
        if (!obj || ('ondragstart' in obj)) return;
        for (var i = 0; i < dragNames.length; i++) (function (type) {
            try {
                Object.defineProperty(obj, 'on' + type, {
                    get: function () { return this['__on' + type] || null; },
                    set: function (fn) { var old = this['__on' + type]; if (old) this.removeEventListener(type, old, false); this['__on' + type] = typeof fn === 'function' ? fn : null; if (fn) this.addEventListener(type, fn, false); },
                    configurable: true
                });
            } catch (e) {}
        })(dragNames[i]);
    };
    defineDragHandlers(window); defineDragHandlers(document); defineDragHandlers(Ep);
    defineBoolAttrProp(Ep, 'draggable');
    defineAttrProp(Ep, 'dropzone');
    if (!window.WriteableStream && window.WritableStream) window.WriteableStream = window.WritableStream;   // feature checks with the old spelling
    if (!window.webauthn) window.webauthn = { getAssertion: rejectWith('NotSupportedError', 'Web Authentication is not available'), makeCredential: rejectWith('NotSupportedError', 'Web Authentication is not available') };
    if (!window.AuthenticatorAttestationResponse) { window.AuthenticatorAttestationResponse = function AuthenticatorAttestationResponse() {}; window.AuthenticatorAssertionResponse = function AuthenticatorAssertionResponse() {}; }
    if (window.speechSynthesis && window.speechSynthesis.__brStub !== false && !window.speechSynthesis.getVoices().length) {
        var fakeVoice = { voiceURI: 'default', name: 'Default', lang: (navigator.language || 'en-US'), localService: true, 'default': true };
        window.speechSynthesis.getVoices = function () { return [fakeVoice]; };
    }
    // script execution events (fired after the script has run, which is when the old engine tells us)
    observeAdded(function (el) {
        if (el.tagName === 'SCRIPT' && el.src && !el.__brExecEvents) {
            el.__brExecEvents = true;
            el.addEventListener('load', function () { fire(el, 'beforescriptexecute'); fire(el, 'afterscriptexecute'); }, false);
        }
    });

    // ---- Newer DOM conveniences: relList, translate, accessKey, minLength, reportValidity, resource hints
    var makeTokenList = function (el, attr) {
        var list = {
            get length() { return this.__tokens().length; },
            __tokens: function () { var v = el.getAttribute(attr) || ''; return v.split(/\s+/).filter(function (t) { return t; }); },
            item: function (i) { return this.__tokens()[i] || null; },
            contains: function (t) { return this.__tokens().indexOf(String(t)) >= 0; },
            add: function () { var t = this.__tokens(); for (var i = 0; i < arguments.length; i++) if (t.indexOf(String(arguments[i])) < 0) t.push(String(arguments[i])); el.setAttribute(attr, t.join(' ')); },
            remove: function () { var t = this.__tokens(); for (var i = 0; i < arguments.length; i++) { var k = t.indexOf(String(arguments[i])); if (k >= 0) t.splice(k, 1); } el.setAttribute(attr, t.join(' ')); },
            toggle: function (token, force) { var has = this.contains(token); if (force === undefined ? has : !force) { if (has) this.remove(token); return false; } this.add(token); return true; },
            replace: function (a, b) { if (!this.contains(a)) return false; this.remove(a); this.add(b); return true; },
            supports: function (token) { return ['alternate', 'author', 'bookmark', 'help', 'icon', 'license', 'next', 'nofollow', 'noreferrer', 'prev', 'search', 'stylesheet', 'tag', 'prefetch', 'preconnect', 'preload', 'dns-prefetch', 'modulepreload'].indexOf(String(token).toLowerCase()) >= 0; },
            toString: function () { return el.getAttribute(attr) || ''; },
            forEach: function (fn, ctx) { var t = this.__tokens(); for (var i = 0; i < t.length; i++) fn.call(ctx, t[i], i, this); }
        };
        try { Object.defineProperty(list, 'value', { get: function () { return el.getAttribute(attr) || ''; }, set: function (v) { el.setAttribute(attr, v); } }); } catch (e) {}
        return list;
    };
    // <link rel=preload> (and modulepreload) does nothing in the old engine: no request, no load event (tools/babel-test
    // linkload.html). The usual way of loading a stylesheet late, <link rel=preload as=style onload="this.rel=
    // 'stylesheet'">, never applied it, and a loader waiting for such a link waited for ever. The link gets its load
    // event here, a moment after it is added (the stylesheet the handler asks for then loads as usual); an image to
    // preload is fetched meanwhile.
    (function () {
        var PRELOAD = /(^|\s)(preload|modulepreload)(\s|$)/i;
        var isPreload = function (l) { return PRELOAD.test(l.getAttribute('rel') || '') && !!l.getAttribute('href'); };
        var fire = function (l) {
            if (l.__brPreload) return;
            l.__brPreload = true;
            if ((l.getAttribute('as') || '').toLowerCase() === 'image') { try { new Image().src = l.href; } catch (e) {} }
            setTimeout(function () {
                if (!isPreload(l)) return;   // (made something else meanwhile: that loads for real)
                var e = document.createEvent('Event');
                e.initEvent('load', false, false);
                l.dispatchEvent(e);
            }, 30);
        };
        observeAdded(function (el) { if (el.tagName === 'LINK' && isPreload(el)) fire(el); });
        var scan = function () { var ls = document.getElementsByTagName('link'); for (var i = 0; i < ls.length; i++) if (isPreload(ls[i])) fire(ls[i]); };
        scan();
        document.addEventListener('DOMContentLoaded', scan, false);
    })();
    var relOwners = [window.HTMLAnchorElement, window.HTMLLinkElement, window.HTMLAreaElement];
    for (var ro = 0; ro < relOwners.length; ro++) {
        if (!relOwners[ro] || !relOwners[ro].prototype || ('relList' in relOwners[ro].prototype)) continue;
        try { Object.defineProperty(relOwners[ro].prototype, 'relList', { get: function () { return this.__brRelList || (this.__brRelList = makeTokenList(this, 'rel')); }, configurable: true }); } catch (e) {}
    }
    if (Ep && !('translate' in document.createElement('div'))) {
        try { Object.defineProperty(HEp || Ep, 'translate', { get: function () { var v = (this.getAttribute('translate') || '').toLowerCase(); return v !== 'no'; }, set: function (v) { this.setAttribute('translate', v ? 'yes' : 'no'); }, configurable: true }); } catch (e) {}
    }
    if (HEp && !('accessKey' in document.createElement('div'))) defineAttrProp(HEp, 'accessKey', 'accesskey');
    if (HEp && !('accessKeyLabel' in document.createElement('div'))) try { Object.defineProperty(HEp, 'accessKeyLabel', { get: function () { return this.getAttribute('accesskey') || ''; }, configurable: true }); } catch (e) {}
    if (window.HTMLTextAreaElement && !('minLength' in document.createElement('textarea'))) {
        try { Object.defineProperty(window.HTMLTextAreaElement.prototype, 'minLength', { get: function () { var v = parseInt(this.getAttribute('minlength'), 10); return isNaN(v) ? -1 : v; }, set: function (v) { this.setAttribute('minlength', v); }, configurable: true }); } catch (e) {}
    }
    if (window.HTMLInputElement && !('minLength' in document.createElement('input'))) {
        try { Object.defineProperty(window.HTMLInputElement.prototype, 'minLength', { get: function () { var v = parseInt(this.getAttribute('minlength'), 10); return isNaN(v) ? -1 : v; }, set: function (v) { this.setAttribute('minlength', v); }, configurable: true }); } catch (e) {}
    }
    var validityOwners = [window.HTMLFormElement, window.HTMLInputElement, window.HTMLSelectElement, window.HTMLTextAreaElement, window.HTMLButtonElement];
    for (var vo = 0; vo < validityOwners.length; vo++) {
        var VP = validityOwners[vo] && validityOwners[vo].prototype;
        if (!VP || VP.reportValidity || !VP.checkValidity) continue;
        VP.reportValidity = function () {
            var ok = this.checkValidity();
            if (!ok) {
                var bad = this.tagName === 'FORM' ? this.querySelector(':invalid') : this;
                try { if (bad && bad.focus) bad.focus(); } catch (e) {}
            }
            return ok;
        };
    }
    // sensors and hardware access: present, permission always denied
    var sensorError = function (self) { setTimeout(function () { var ev = { type: 'error', error: domException('NotAllowedError', 'Sensor access is not available') }; if (self.onerror) self.onerror(ev); for (var i = 0; i < self.__l.length; i++) self.__l[i](ev); }, 0); };
    var sensorNames = ['Sensor', 'Accelerometer', 'LinearAccelerationSensor', 'GravitySensor', 'Gyroscope', 'Magnetometer', 'AbsoluteOrientationSensor', 'RelativeOrientationSensor', 'AmbientLightSensor'];
    for (var sn = 0; sn < sensorNames.length; sn++) (function (name) {
        if (window[name]) return;
        var S = function () { this.activated = false; this.hasReading = false; this.timestamp = null; this.onreading = this.onerror = this.onactivate = null; this.__l = []; };
        S.prototype.start = function () { sensorError(this); };
        S.prototype.stop = noop;
        S.prototype.addEventListener = function (t, f) { if (t === 'error') this.__l.push(f); };
        S.prototype.removeEventListener = noop;
        try { Object.defineProperty(S, 'name', { value: name }); } catch (e) {}
        window[name] = S;
    })(sensorNames[sn]);
    if (!navigator.bluetooth) navigator.bluetooth = { requestDevice: rejectWith('NotFoundError', 'Bluetooth is not available'), getAvailability: function () { return resolved(false); }, getDevices: function () { return resolved([]); }, addEventListener: noop, removeEventListener: noop };
    if (!navigator.usb) navigator.usb = { requestDevice: rejectWith('NotFoundError', 'USB is not available'), getDevices: function () { return resolved([]); }, addEventListener: noop, removeEventListener: noop };
    if (!navigator.serial) navigator.serial = { requestPort: rejectWith('NotFoundError', 'Serial is not available'), getPorts: function () { return resolved([]); }, addEventListener: noop, removeEventListener: noop };
    if (!navigator.hid) navigator.hid = { requestDevice: function () { return resolved([]); }, getDevices: function () { return resolved([]); }, addEventListener: noop, removeEventListener: noop };
    if (!window.NDEFReader) { window.NDEFReader = function NDEFReader() { this.onreading = null; this.onreadingerror = null; }; window.NDEFReader.prototype.scan = rejectWith('NotSupportedError', 'NFC is not available'); window.NDEFReader.prototype.write = rejectWith('NotSupportedError', 'NFC is not available'); window.NDEFReader.prototype.addEventListener = noop; window.NDEFReader.prototype.removeEventListener = noop; window.NDEFMessage = function NDEFMessage() {}; window.NDEFRecord = function NDEFRecord() {}; }
    if (!navigator.gpu) navigator.gpu = { requestAdapter: function () { return resolved(null); }, getPreferredCanvasFormat: function () { return 'bgra8unorm'; }, wgslLanguageFeatures: [] };
    if (!window.GPU) window.GPU = function GPU() {};
    if (!window.XRSystem) { window.XRSystem = function XRSystem() {}; window.XRSession = function XRSession() {}; }
    if (window.HTMLMediaElement && !window.HTMLMediaElement.prototype.requestPictureInPicture) { window.HTMLMediaElement.prototype.requestPictureInPicture = rejectWith('NotSupportedError', 'Picture in picture is not available'); if (!('pictureInPictureEnabled' in document)) try { Object.defineProperty(document, 'pictureInPictureEnabled', { get: function () { return false; }, configurable: true }); document.exitPictureInPicture = rejectWith('InvalidStateError', 'not in picture in picture'); } catch (e) {} }
    if (window.MathMLElement === undefined) window.MathMLElement = function MathMLElement() {};
    // canPlayType: the old engine says "maybe" for types that name exactly one codec it plays (ADTS AAC, MP3), where
    // today's browsers say "probably" (players that insist on "probably" skipped AAC and MP3 streams)
    if (window.HTMLMediaElement && window.HTMLMediaElement.prototype.canPlayType && !window.HTMLMediaElement.prototype.canPlayType.__brSure) {
        var nativeCanPlay = window.HTMLMediaElement.prototype.canPlayType, SINGLE_CODEC = { 'audio/aac': 1, 'audio/x-aac': 1, 'audio/mpeg': 1, 'audio/mp3': 1 };
        window.HTMLMediaElement.prototype.canPlayType = function (type) {
            var r = nativeCanPlay.apply(this, arguments);
            return r === 'maybe' && SINGLE_CODEC[String(type).replace(/\s+/g, '').toLowerCase()] ? 'probably' : r;
        };
        window.HTMLMediaElement.prototype.canPlayType.__brSure = true;
    }

    // ---- Empty ad boxes: a blocked ad leaves its box (edition.cnn.com: a 276 px black band at the top of the page).
    // A box with one of the usual ad names (Google's slots, AdSense, Seznam's zones, ad-slot / advert words) that shows
    // no text but an "advertisement" label and no picture, video or frame is taken out, as ad blockers do; only while
    // the app blocks the page's ads (asked once), a few times after the page loaded.
    (function () {
        var SLOTS = '[id^="div-gpt-ad"],[id^="google_ads"],ins.adsbygoogle,[data-ad-slot],[data-google-query-id],[id^="ssp-zone"],[class*="ssp-zone"],' +
                    '[class*="ad-slot"],[class*="adslot"],[class*="AdSlot"],[class*="ad-container"],[class*="adContainer"],[class*="ad-wrapper"],' +
                    '[class*="adWrapper"],[class*="ad-banner"],[class*="adBanner"],[id*="ad-slot"],[id*="adslot"],[class*="advert"],[id*="advert"]';
        var LABEL = /^(advertisement|advertising|ads?|reklama|inzerce|anzeige|publicit[ée]|sponsored|sponzorov[aá]no|\s)*$/i;
        var blocked = null, runs = 0;
        var shows = function (el) {
            var text = el.innerText || '';
            if (!LABEL.test(text.replace(/\s+/g, ' '))) return true;
            var media = el.querySelectorAll('img,video,iframe,canvas,embed,object,svg');
            for (var i = 0; i < media.length; i++) { var r = media[i].getBoundingClientRect(); if (r.width > 4 && r.height > 4) return true; }
            return false;
        };
        var collapse = function () {
            if (blocked !== true) return;
            var list;
            try { list = document.querySelectorAll(SLOTS); } catch (e) { return; }
            for (var i = 0; i < list.length; i++) {
                var el = list[i];
                if (el.__brAdGone || el === document.body || el === document.documentElement || el.offsetHeight < 20 || shows(el)) continue;
                el.__brAdGone = true;
                el.style.setProperty('display', 'none', 'important');
            }
        };
        var later = function () {
            if (runs++ > 6) return;
            collapse();
            setTimeout(later, 2500 * runs);
        };
        window.addEventListener('load', function () {
            try {
                var x = new XMLHttpRequest();
                x.open('GET', window.__brStateURL || 'https://ios6-browser.invalid/state', true);   // (tests give their own)
                x.onreadystatechange = function () {
                    if (x.readyState !== 4) return;
                    try { blocked = (x.status === 200 || (x.status === 0 && !!x.responseText)) && !!JSON.parse(x.responseText).adblock; } catch (e) { blocked = false; }
                    if (blocked) setTimeout(later, 1500);
                };
                x.send(null);
            } catch (e2) {}
        }, false);
    })();
    // ---- IntersectionObserver (the polyfill in the bundle): one watcher for all observers of the page instead of a
    // MutationObserver and scroll and resize listeners per observer; checks that wait for their own cost; the styles and
    // boxes of the elements around the targets read once per check. (seznam.cz: every check read the computed style of
    // every ancestor of every target, per observer: 4-6 s a check, again after each change of the page.)
    (function () {
        var IO = window.IntersectionObserver, IOp = IO && IO.prototype;
        // (the polyfill's entries carry their fields as own properties; a page's own copy of the same polyfill takes the
        // observer for a native one only when IntersectionObserverEntry.prototype has intersectionRatio - else it put
        // itself in place, one MutationObserver on the whole document per observer, without the shared watcher below:
        // rohlik.cz had about 20 of them, each handed every style change)
        var IOE = window.IntersectionObserverEntry;
        if (IOE && IOE.prototype && !('intersectionRatio' in IOE.prototype)) {
            try { IOE.prototype.intersectionRatio = 0; IOE.prototype.isIntersecting = false; } catch (eIOE) {}
        }
        if (!IOp || !IOp._checkForIntersections || !IOp._monitorIntersections || !IOp._computeTargetAndRootIntersection || !IOp._unmonitorAllIntersections) return;
        var check = IOp._checkForIntersections, compute = IOp._computeTargetAndRootIntersection;
        var monitor = IOp._monitorIntersections, unmonitor = IOp._unmonitorIntersections, unmonitorAll = IOp._unmonitorAllIntersections;
        var observers = [], timer = null, lastEnd = 0, lastCost = 0, round = null, gen = 0, listening = false;
        // (per check: an element's display and overflow, and its box)
        var styleOf = function (el) {
            var s = round && el.__brIoStyle;
            if (s && s.gen === round.gen) return s;
            var cs = getComputedStyle(el);
            s = { gen: round ? round.gen : -1, display: cs ? cs.display : '', overflow: cs ? cs.overflow : '' };
            if (round) try { el.__brIoStyle = s; } catch (e) {}
            return s;
        };
        var rectOf = function (el) {
            var c = round && el.__brIoRect;
            if (c && c.gen === round.gen) return c.rect;
            var r = null;
            try { r = el.getBoundingClientRect(); } catch (e) {}
            r = r ? { top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.right - r.left, height: r.bottom - r.top } : { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };
            if (round) try { el.__brIoRect = { gen: round.gen, rect: r }; } catch (e2) {}
            return r;
        };
        var intersect = function (a, b) {
            var top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom), left = Math.max(a.left, b.left), right = Math.min(a.right, b.right);
            return right - left >= 0 && bottom - top >= 0 ? { top: top, bottom: bottom, left: left, right: right, width: right - left, height: bottom - top } : null;
        };
        var parentOf = function (node) {
            var p = node.parentNode;
            if (p && p.assignedSlot) p = p.assignedSlot.parentNode;
            return p && p.nodeType === 11 && p.host ? p.host : p;
        };
        IOp._checkForIntersections = function () {
            var outer = !round;
            if (outer) round = { gen: ++gen };
            try { return check.apply(this, arguments); } finally { if (outer) round = null; }
        };
        // (the polyfill's walk up from the target, for targets of this document)
        IOp._computeTargetAndRootIntersection = function (target, targetRect, rootRect) {
            if (target.ownerDocument !== document) return compute.apply(this, arguments);
            if (styleOf(target).display === 'none') return;
            var rect = targetRect, html = document.documentElement, body = document.body;
            for (var parent = parentOf(target); parent; parent = parentOf(parent)) {
                var st = parent.nodeType === 1 ? styleOf(parent) : null;
                if (st && st.display === 'none') return null;
                if (parent === this.root || parent.nodeType === 9) {
                    if (parent !== this.root && parent !== document) return compute.apply(this, arguments);
                    return intersect(rootRect, rect);
                }
                if (st && parent !== body && parent !== html && st.overflow !== 'visible') {
                    rect = intersect(rectOf(parent), rect);
                    if (!rect) return rect;
                }
            }
            return rect;
        };
        var runAll = function () {
            timer = null;
            var t0 = Date.now(), list = observers.slice(), debug = !!window.__brNoteSlow, inPage = 0, targets = 0;
            round = { gen: ++gen };
            try {
                for (var i = 0; i < list.length; i++) {
                    var o = list[i], cb = o._callback;
                    targets += o._observationTargets.length;
                    // (debugging: how much of it the page's own callbacks take)
                    if (debug) o._callback = function () { var s = Date.now(); try { return cb.apply(this, arguments); } finally { inPage += Date.now() - s; } };
                    try { check.call(o); } catch (e) {} finally { if (debug) o._callback = cb; }
                }
            } finally { round = null; }
            lastEnd = Date.now();
            lastCost = lastEnd - t0;
            if (debug) window.__brNoteSlow('intersection check', lastCost, list.length + ' observers, ' + targets + ' targets, ' + inPage + ' ms in their callbacks');
        };
        var schedule = function () {
            if (timer || !observers.length) return;
            timer = setTimeout(runAll, Math.max(IOp.THROTTLE_TIMEOUT || 100, lastEnd + lastCost * 3 - Date.now()));
        };
        // (the classes and attributes the page shims set themselves change nothing an observer looks at)
        var OWN = /(?:^|\s)br-[\w-]+/g;
        var ownChange = function (r) {
            if (r.type !== 'attributes') return false;
            if (/^data-br-/.test(r.attributeName || '')) return true;
            if (r.attributeName !== 'class') return false;
            var now = r.target.getAttribute && r.target.getAttribute('class');
            return String(r.oldValue || '').replace(OWN, '').replace(/\s+/g, ' ').trim() === String(now || '').replace(OWN, '').replace(/\s+/g, ' ').trim();
        };
        var listen = function () {
            if (listening) return;
            listening = true;
            window.addEventListener('resize', schedule, true);
            document.addEventListener('scroll', schedule, true);
            var MO = window.MutationObserver || window.WebKitMutationObserver;
            if (!MO) return;
            // (the old value only of class, to tell the shims' own classes: asked for every attribute, the engine wrote
            // out the whole style attribute before each change of it - 0.4 ms a style change on nextjs.org, where the
            // custom properties runtime makes thousands and the page's scripts more)
            new MO(function (records) {
                for (var i = 0; i < records.length; i++) if (!ownChange(records[i])) { schedule(); return; }
            }).observe(document, { attributes: true, attributeOldValue: true, attributeFilter: ['class'], subtree: true });
            new MO(function (records) {
                for (var i = 0; i < records.length; i++) {
                    var r = records[i];
                    if (r.type === 'attributes' && (r.attributeName === 'class' || ownChange(r))) continue;
                    schedule();
                    return;
                }
            }).observe(document, { attributes: true, childList: true, characterData: true, subtree: true });
        };
        var drop = function (o) { var i = observers.indexOf(o); if (i >= 0) observers.splice(i, 1); };
        IOp._monitorIntersections = function (doc) {
            // (another document, or an observer that polls: as the polyfill does it)
            if (doc !== document || this.POLL_INTERVAL || this.USE_MUTATION_OBSERVER === false) return monitor.apply(this, arguments);
            if (observers.indexOf(this) < 0) observers.push(this);
            // (its own check, which observe() asks for right after this, is the shared one)
            this._checkForIntersections = schedule;
            listen();
        };
        IOp._unmonitorIntersections = function (doc) {
            if (doc !== document) return unmonitor.apply(this, arguments);
            var left = false;
            for (var i = 0; i < this._observationTargets.length && !left; i++) left = this._observationTargets[i].element.ownerDocument === document;
            if (!left) drop(this);
        };
        IOp._unmonitorAllIntersections = function () { drop(this); return unmonitorAll.apply(this, arguments); };
    })();

    // ---- Everyday DOM differences that break modern scripts on the old engine
    // addEventListener(type, fn, {passive, once, capture, signal}): the old engine reads the options object as capture=true
    // (once and signal get their closures from functions of their own, and the target is asked whether it is a slot
    // only on pages with shadow roots: this runs for every listener a page adds, and a closure in it, or a DOM getter,
    // costs every call here)
    var onceListener = function (target, type, fn, capture) {
        return fn.__brOnce || (fn.__brOnce = function (ev) { target.removeEventListener(type, fn, capture); return typeof fn === 'function' ? fn.call(this, ev) : fn.handleEvent(ev); });
    };
    var removeOnAbort = function (signal, target, type, fn, capture) {
        signal.addEventListener('abort', function () { target.removeEventListener(type, fn, capture); });
    };
    var patchEventTarget = function (obj) {
        if (!obj || !obj.addEventListener || obj.__brListenerOptions) return;
        var origAdd = obj.addEventListener, origRemove = obj.removeEventListener;
        obj.addEventListener = function (type, fn, options) {
            if (!fn) return;
            // (a page that listens for drag events gets dragging by finger, see the drag and drop block)
            if (typeof type === 'string' && (type === 'drop' || type.indexOf('drag') === 0)) window.__brPageDnD = true;
            // (called unbound too, addEventListener('load', f): this is undefined in here then)
            if (window.__brShadowUsed && this && this.tagName === 'SLOT' && window.__brSlotListen) window.__brSlotListen(this, type, fn, options);
            if (options && typeof options === 'object') {
                var capture = !!options.capture, actual = fn;
                if (options.once) actual = onceListener(this, type, fn, capture);
                if (options.signal) {
                    if (options.signal.aborted) return;
                    removeOnAbort(options.signal, this, type, fn, capture);
                }
                return origAdd.call(this, type, actual, capture);
            }
            return origAdd.call(this, type, fn, !!options);
        };
        obj.removeEventListener = function (type, fn, options) {
            var capture = options && typeof options === 'object' ? !!options.capture : !!options;
            if (this && this.__brSlotL && this.tagName === 'SLOT') {
                for (var sl = this.__brSlotL.length - 1; sl >= 0; sl--) { var rec = this.__brSlotL[sl]; if (rec.type === type && rec.fn === fn && rec.capture === capture) this.__brSlotL.splice(sl, 1); }
            }
            if (fn && fn.__brOnce) origRemove.call(this, type, fn.__brOnce, capture);
            return origRemove.call(this, type, fn, capture);
        };
        obj.__brListenerOptions = true;
    };
    var listenerTargets = [Np, window, window.XMLHttpRequest && window.XMLHttpRequest.prototype, window.XMLHttpRequestUpload && window.XMLHttpRequestUpload.prototype,
                           window.WebSocket && window.WebSocket.prototype, window.EventSource && window.EventSource.prototype, window.FileReader && window.FileReader.prototype,
                           window.MessagePort && window.MessagePort.prototype, window.Worker && window.Worker.prototype, window.MediaQueryList && window.MediaQueryList.prototype,
                           window.EventTarget && window.EventTarget.prototype];
    for (var lt = 0; lt < listenerTargets.length; lt++) patchEventTarget(listenerTargets[lt]);
    // EventTarget.prototype above every event target, as in current engines. The old engine has no EventTarget: each
    // interface (Node, the window, XMLHttpRequest, WebSocket...) has its own addEventListener. zone.js (Angular)
    // patches EventTarget.prototype only, so it saw no DOM listener, and its XMLHttpRequest patch reads the original
    // addEventListener from the request's prototype chain: "'undefined' is not an object (evaluating 'J.call')" on
    // every request (aukro.cz). Each interface's methods move to __brAEL/__brREL/__brDEV and forward to
    // EventTarget.prototype, whose methods call the target's own ones (or the listener store of new EventTarget()).
    (function () {
        var ET = window.EventTarget, ETp = ET && ET.prototype, own = Object.prototype.hasOwnProperty, gp = Object.getPrototypeOf;
        // (an engine with EventTarget of its own: nodes inherit from it already)
        if (!ETp || own.call(ETp, '__brUnified') || typeof ETp.addEventListener !== 'function' || !Np || ETp.isPrototypeOf(Np)) return;
        var hide = function (o, k, v) { try { Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: false }); return true; } catch (e) { return false; } };
        var METHODS = [['addEventListener', '__brAEL'], ['removeEventListener', '__brREL'], ['dispatchEvent', '__brDEV']];
        // (the arguments by name, no arguments object and no apply: every listener a page adds or removes goes through
        // both of these)
        var dispatcher = function (name, key) {
            var store = ETp[name];
            var f = name === 'dispatchEvent' ?
                function (ev) { var t = this === undefined || this === null ? window : this; return (t[key] || store).call(t, ev); } :
                function (type, fn, options) { var t = this === undefined || this === null ? window : this; return (t[key] || store).call(t, type, fn, options); };
            hide(f, '__brFwd', true);
            return f;
        };
        var forwarder = function (name) {
            var f = name === 'dispatchEvent' ?
                function (ev) { return ETp[name].call(this === undefined || this === null ? window : this, ev); } :
                function (type, fn, options) { return ETp[name].call(this === undefined || this === null ? window : this, type, fn, options); };
            hide(f, '__brFwd', true);
            return f;
        };
        var m;
        for (m = 0; m < METHODS.length; m++) ETp[METHODS[m][0]] = dispatcher(METHODS[m][0], METHODS[m][1]);
        hide(ETp, '__brUnified', true);
        // (not hasOwnProperty: the window reports everything its prototype has as its own)
        var unify = function (p) {
            if (!p || p === ETp || p === Object.prototype || typeof p.addEventListener !== 'function' || p.addEventListener.__brFwd) return;
            for (var i = 0; i < METHODS.length; i++) {
                var impl = p[METHODS[i][0]];
                if (typeof impl !== 'function' || impl.__brFwd || !hide(p, METHODS[i][1], impl)) continue;
                try { p[METHODS[i][0]] = forwarder(METHODS[i][0]); } catch (e) {}
            }
            var top = p, up = gp(p);
            while (up && up !== Object.prototype && up !== ETp) { top = up; up = gp(up); }
            if (up === Object.prototype) { try { top.__proto__ = ETp; } catch (e2) {} }
        };
        // (the window's prototype before the window, whose own methods are the wrappers above)
        var targets = [gp(window), window, Np], NAMES = ['XMLHttpRequest', 'XMLHttpRequestUpload', 'WebSocket', 'EventSource', 'FileReader',
                       'MessagePort', 'Worker', 'SharedWorker', 'MediaQueryList', 'SVGElementInstance', 'Notification', 'MediaController',
                       'TextTrack', 'TextTrackCue', 'TextTrackList', 'DOMApplicationCache'];
        for (m = 0; m < NAMES.length; m++) {
            var p = window[NAMES[m]] && window[NAMES[m]].prototype;
            while (p && p !== Object.prototype && !own.call(p, 'addEventListener')) p = gp(p);
            targets.push(p);
        }
        if (window.applicationCache) targets.push(gp(window.applicationCache));
        for (m = 0; m < targets.length; m++) unify(targets[m]);
    })();
    // classList.add('a', 'b') only added the first class
    if (window.DOMTokenList && window.DOMTokenList.prototype) {
        var probeList = document.createElement('div');
        probeList.classList.add('a', 'b');
        if (!probeList.classList.contains('b')) {
            var TLp = window.DOMTokenList.prototype, origAddClass = TLp.add, origRemoveClass = TLp.remove;
            TLp.add = function () { for (var i = 0; i < arguments.length; i++) origAddClass.call(this, arguments[i]); };
            TLp.remove = function () { for (var i = 0; i < arguments.length; i++) origRemoveClass.call(this, arguments[i]); };
        }
    }
    // getBoundingClientRect().x / .y: getters on the rectangles' prototype (a wrapper made two objects per call, and
    // pages call it by the thousand: seznam.cz's visibility checks), else a wrapper
    if (Ep && Ep.getBoundingClientRect) {
        var probeRect = document.documentElement.getBoundingClientRect();
        var rectProto = probeRect && !('x' in probeRect) ? Object.getPrototypeOf(probeRect) : null;
        if (rectProto && rectProto !== Object.prototype) {
            try {
                Object.defineProperty(rectProto, 'x', { get: function () { return this.left; }, configurable: true });
                Object.defineProperty(rectProto, 'y', { get: function () { return this.top; }, configurable: true });
                Object.defineProperty(rectProto, 'toJSON', { value: function () { return { x: this.left, y: this.top, left: this.left, top: this.top, right: this.right, bottom: this.bottom, width: this.width, height: this.height }; }, configurable: true, writable: true });
            } catch (eRect) {}
            probeRect = document.documentElement.getBoundingClientRect();
        }
        if (probeRect && !('x' in probeRect)) {
            // (no arguments object, one toJSON for all: layout code asks for rectangles all the time)
            var origRect = Ep.getBoundingClientRect, rectJSON = function () { return this; };
            Ep.getBoundingClientRect = function () {
                var r = origRect.call(this);
                return { x: r.left, y: r.top, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, toJSON: rectJSON };
            };
            if (window.Range && window.Range.prototype.getBoundingClientRect) {
                var origRangeRect = window.Range.prototype.getBoundingClientRect;
                window.Range.prototype.getBoundingClientRect = function () { var r = origRangeRect.call(this); return { x: r.left, y: r.top, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
            }
        }
    }
    // ':scope' in selectors (the old engine takes it, but for the root element, as in scoped style sheets: an element's
    // querySelectorAll(':scope > li') found nothing)
    var scopeSupported = false;
    try {
        var scopeProbe = document.createElement('div');
        scopeProbe.appendChild(document.createElement('i'));
        scopeSupported = scopeProbe.querySelector(':scope > i') === scopeProbe.firstChild;
    } catch (e) {}
    if (!scopeSupported) {
        var fixScope = function (sel) { return typeof sel === 'string' && sel.indexOf(':scope') >= 0 ? sel.replace(/:scope\b\s*>?/g, function (m) { return m.indexOf('>') >= 0 ? ':scope-child' : ''; }) : sel; };
        // (the try in a function of its own: a function with one makes a scope object on every call here)
        var scopedCall = function (orig, el, sel) {
            var tmpId = false;
            if (!el.id) { el.id = 'br-scope-' + Math.random().toString(36).slice(2); tmpId = true; }
            var rewritten = sel.replace(/:scope\b/g, '#' + el.id);
            try { return orig.call(el.parentNode || document, rewritten); } finally { if (tmpId) el.removeAttribute('id'); }
        };
        var scopedQuery = function (orig) {
            return function (sel) {
                if (typeof sel === 'string' && sel.indexOf(':scope') >= 0) {
                    if (this.nodeType === 1) return scopedCall(orig, this, sel);
                    return orig.call(this, sel.replace(/:scope\b\s*/g, ''));
                }
                return orig.call(this, sel);
            };
        };
        var queryOwners = [Ep, window.Document && window.Document.prototype, window.DocumentFragment && window.DocumentFragment.prototype];
        for (var qo = 0; qo < queryOwners.length; qo++) {
            if (!queryOwners[qo]) continue;
            if (queryOwners[qo].querySelector) queryOwners[qo].querySelector = scopedQuery(queryOwners[qo].querySelector);
            if (queryOwners[qo].querySelectorAll) queryOwners[qo].querySelectorAll = scopedQuery(queryOwners[qo].querySelectorAll);
        }
    }
    // ':read-write' / ':read-only' in queries: the old engine matches only form fields, not editable content
    // (contenteditable). During a query with them, editable elements carry data-br-rw; ':read-write' becomes the
    // engine's own plus [data-br-rw], ':read-only' the rest.
    (function () {
        if (!Ep || !document.documentElement) return;
        var probe = document.createElement('div'), works = false;
        probe.id = 'br-rw-probe';
        probe.setAttribute('contenteditable', 'true');
        try { document.documentElement.appendChild(probe); works = document.querySelector('#br-rw-probe:read-write') === probe; } catch (e) {}
        if (probe.parentNode) probe.parentNode.removeChild(probe);
        if (works && window.__brForceXHR !== 'all') return;   // (tools/xhr-test.html)
        var RW = /:(?:-moz-)?read-(write|only)(?![\w-])/;
        // the selectors of a list (commas outside brackets, parentheses and strings)
        var split = function (sel) {
            var out = [], depth = 0, quote = '', start = 0;
            for (var i = 0; i < sel.length; i++) {
                var c = sel.charAt(i);
                if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
                if (c === '"' || c === "'") quote = c;
                else if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (c === ',' && depth === 0) { out.push(sel.slice(start, i)); start = i + 1; }
            }
            out.push(sel.slice(start));
            return out;
        };
        var NATIVE = '\u0001';
        var rewrite = function (sel) {
            var parts = split(sel), out = [];
            for (var i = 0; i < parts.length; i++) {
                var variants = [parts[i]];
                for (var round = 0; round < 4; round++) {
                    var next = [], changed = false;
                    for (var v = 0; v < variants.length; v++) {
                        var m = RW.exec(variants[v]);
                        if (!m) { next.push(variants[v]); continue; }
                        changed = true;
                        var before = variants[v].slice(0, m.index), after = variants[v].slice(m.index + m[0].length);
                        if (m[1] === 'write') { next.push(before + NATIVE + after); next.push(before + '[data-br-rw]' + after); }
                        else next.push(before + ':not(' + NATIVE + '):not([data-br-rw])' + after);
                    }
                    variants = next;
                    if (!changed) break;
                }
                out = out.concat(variants);
            }
            return out.join(',').split(NATIVE).join(':read-write');
        };
        var mark = function () {
            var roots = document.querySelectorAll('[contenteditable]'), marked = [];
            for (var i = 0; i < roots.length; i++) {
                var r = roots[i];
                if (!r.isContentEditable || r.hasAttribute('data-br-rw')) continue;
                var all = [r], inner = r.getElementsByTagName('*');
                for (var k = 0; k < inner.length; k++) all.push(inner[k]);
                for (var j = 0; j < all.length; j++) if (all[j].isContentEditable && !all[j].hasAttribute('data-br-rw')) { all[j].setAttribute('data-br-rw', ''); marked.push(all[j]); }
            }
            return marked;
        };
        // (the try in a function of its own, and the cheap test first: every query of the page comes through here)
        var query = function (self, orig, sel) {
            var marked = mark();
            try { return orig.call(self, rewrite(sel)); } finally { for (var i = 0; i < marked.length; i++) marked[i].removeAttribute('data-br-rw'); }
        };
        var wrap = function (orig) {
            return function (sel) {
                if (typeof sel !== 'string' || sel.indexOf(':') < 0 || sel.indexOf('read-') < 0 || !RW.test(sel)) return orig.call(this, sel);
                return query(this, orig, sel);
            };
        };
        var owners = [Ep, window.Document && window.Document.prototype, window.DocumentFragment && window.DocumentFragment.prototype];
        for (var o = 0; o < owners.length; o++) {
            if (!owners[o]) continue;
            if (owners[o].querySelector) owners[o].querySelector = wrap(owners[o].querySelector);
            if (owners[o].querySelectorAll) owners[o].querySelectorAll = wrap(owners[o].querySelectorAll);
        }
        if (Ep.matches) Ep.matches = wrap(Ep.matches);
        if (Ep.webkitMatchesSelector) Ep.webkitMatchesSelector = wrap(Ep.webkitMatchesSelector);
    })();
    // ---- selectors of today that the old engine rejects with SYNTAX_ERR in querySelector(All) / matches (Adobe Launch
    // on o2.cz, blesk.cz, zive.cz): the query is tried as written first; on that error brackets, parentheses and a
    // string left open at the end are closed (as the CSS parser does at the end of the input), :is()/:where() are
    // spelled out, :not(a, b) becomes :not(a):not(b), a :not() of a complex selector (:not(.box a)) on the last
    // compound becomes a filter for the elements found, :scope marks the element, :focus-visible is :focus, the state
    // pseudo-classes become the classes the page shim keeps, and alternatives with :has() or "of S" (nothing to match
    // them with here) are left out. When that does not parse either, the original error stands.
    (function () {
        if (!Ep || !document.querySelectorAll) return;
        var STATES = { 'focus-within': '.br-focus-within', 'placeholder-shown': '.br-placeholder-shown', 'user-invalid': '.br-user-invalid',
            'user-valid': '.br-user-valid', 'popover-open': '.br-popover-open', modal: '.br-modal', fullscreen: '.br-fullscreen', 'focus-visible': ':focus',
            'any-link': ':link', defined: '', 'read-write': ':read-write', blank: '.br-blank', playing: '.br-playing', paused: '.br-paused' };
        var trim = function (s) { return s.trim(); };
        var splitList = function (s) {
            var out = [], depth = 0, quote = '', start = 0;
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (c === '\\') { i++; continue; }
                if (quote) { if (c === quote) quote = ''; continue; }
                if (c === '"' || c === "'") quote = c;
                else if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
            }
            out.push(s.slice(start));
            return out;
        };
        var closeParen = function (s, open) {
            var depth = 0, quote = '';
            for (var i = open; i < s.length; i++) {
                var c = s.charAt(i);
                if (c === '\\') { i++; continue; }
                if (quote) { if (c === quote) quote = ''; continue; }
                if (c === '"' || c === "'") quote = c;
                else if (c === '(') depth++;
                else if (c === ')' && --depth === 0) return i;
            }
            return -1;
        };
        // brackets, parentheses and a string still open at the end closed
        var balance = function (s) {
            var stack = [], quote = '';
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (c === '\\') { i++; continue; }
                if (quote) { if (c === quote) quote = ''; continue; }
                if (c === '"' || c === "'") quote = c;
                else if (c === '(') stack.push(')');
                else if (c === '[') stack.push(']');
                else if ((c === ')' || c === ']') && stack.length && stack[stack.length - 1] === c) stack.pop();
            }
            return s + quote + stack.reverse().join('');
        };
        // ids and classes that are identifiers only since CSS Syntax 3 (starting with "--" or "-" and a digit: htmx
        // looks for #--htmx-preserve-pantry--) as attribute selectors; attribute values and strings stay as they are
        var modernIdents = function (s) {
            var out = '', i = 0, quote = '', depth = 0, start = 0;
            var flush = function (end) {
                out += s.slice(start, end).replace(/([#.])(--[\w-]*|-\d[\w-]*)/g, function (all, kind, name) { return kind === '#' ? '[id="' + name + '"]' : '[class~="' + name + '"]'; });
            };
            for (; i < s.length; i++) {
                var c = s.charAt(i);
                if (c === '\\') { i++; continue; }
                if (quote) { if (c === quote) quote = ''; continue; }
                if (depth) { if (c === '"' || c === "'") quote = c; else if (c === ']') { depth = 0; out += s.slice(start, i + 1); start = i + 1; } continue; }
                if (c === '[') { flush(i); start = i; depth = 1; }
            }
            if (depth) out += s.slice(start); else flush(s.length);
            return out;
        };
        // a combinator outside brackets, parentheses and strings
        var hasCombinator = function (s) {
            var depth = 0, quote = '';
            s = trim(s);
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (c === '\\') { i++; continue; }
                if (quote) { if (c === quote) quote = ''; continue; }
                if (c === '"' || c === "'") quote = c;
                else if (c === '(' || c === '[') depth++;
                else if (c === ')' || c === ']') depth--;
                else if (!depth && /[\s>+~]/.test(c)) return true;
            }
            return false;
        };
        // one selector (no top-level commas) -> [{t: the text for the engine, x: [selectors an element found must not
        // match]}], [] when it cannot be had
        var variants = function (sel, excl) {
            var m = /:(?:is|where|matches|-webkit-any)\(/i.exec(sel);
            if (m) {
                var open = m.index + m[0].length - 1, close = closeParen(sel, open);
                if (close < 0) return [{ t: sel, x: excl || [] }];
                var inner = splitList(sel.slice(open + 1, close)), out = [];
                for (var i = 0; i < inner.length; i++) out = out.concat(variants(sel.slice(0, m.index) + trim(inner[i]) + sel.slice(close + 1), excl));
                return out;
            }
            if (/:has\(|:nth-(?:last-)?child\([^)]*\sof\s/i.test(sel)) return [];
            var n = /:not\(/i.exec(sel), from;
            while (n) {
                var o = n.index + 4, c = closeParen(sel, o);
                if (c < 0) break;
                var parts = splitList(sel.slice(o + 1, c)), simple = '', hard = [];
                for (var k = 0; k < parts.length; k++) { var p = trim(parts[k]); if (hasCombinator(p)) hard.push(p); else simple += ':not(' + p + ')'; }
                // (a complex one filters the elements found: only on the subject, the last compound)
                if (hard.length && hasCombinator(sel.slice(c + 1))) return [];
                if (hard.length) excl = (excl || []).concat(hard);
                if (hard.length || parts.length > 1) { sel = sel.slice(0, n.index) + simple + sel.slice(c + 1); from = n.index + simple.length; }
                else from = n.index + 5;
                var next = /:not\(/i.exec(sel.slice(from));
                n = next ? { index: from + next.index } : null;
            }
            // :defined through the class undefined custom elements get (:not(:defined) became ":not()", a syntax error:
            // Shoelace's autoloader looks for :not(:defined) elements)
            if (/:defined\b/i.test(sel)) {
                sel = sel.replace(/:not\(\s*:defined\s*\)/gi, '.br-undefined').replace(/:defined\b/gi, ':not(.br-undefined)');
                if (!window.__brUndefinedActive && window.__brMarkUndefined) window.__brMarkUndefined(document);
            }
            sel = sel.replace(/:([a-z-]+)(?![\w(-])/gi, function (all, name) { var s = STATES[name.toLowerCase()]; return s === undefined ? all : s; });
            sel = sel.replace(/(\[[^\]"']*(?:"[^"]*"|'[^']*')?)\s+[is]\s*\]/g, '$1]');   // attribute case flags
            sel = modernIdents(sel);
            if (!trim(sel) || /[\s>+~]$/.test(sel)) sel += '*';   // (the compound had only the complex :not)
            return [{ t: sel, x: excl || [] }];
        };
        var rewrite = function (sel) {
            var parts = splitList(balance(sel)), out = [];
            for (var i = 0; i < parts.length; i++) out = out.concat(variants(trim(parts[i]), null));
            return out;
        };
        var joined = function (list) { var t = []; for (var i = 0; i < list.length; i++) t.push(list[i].t); return t.join(', '); };
        var filtering = function (list) { for (var i = 0; i < list.length; i++) if (list[i].x.length) return true; return false; };
        var scopeSeq = 0, pickSeq = 0;
        // fn(text) with :scope pointing at el (marked meanwhile)
        var scoped = function (el, text, fn) {
            var marked = false;
            if (/:scope\b/i.test(text)) {
                if (el && el.nodeType === 1) { el.setAttribute('data-br-scope', String(++scopeSeq)); marked = true; text = text.replace(/:scope\b/gi, '[data-br-scope="' + scopeSeq + '"]'); }
                else text = text.replace(/:scope\b/gi, ':root');
            }
            try { return fn(text); } finally { if (marked) el.removeAttribute('data-br-scope'); }
        };
        var nativeMatches = Ep.webkitMatchesSelector || Ep.matches;
        var excluded = function (el, x) {
            for (var i = 0; i < x.length; i++) {
                var list = rewrite(x[i]);
                if (!list.length) continue;
                try { if (nativeMatches.call(el, joined(list).replace(/:scope\b/gi, ':root'))) return true; } catch (e) {}
            }
            return false;
        };
        var matchesList = function (el, list) {
            for (var i = 0; i < list.length; i++) {
                var hit = false, t = list[i].t;
                try { hit = scoped(el, t, function (text) { return nativeMatches.call(el, text); }); } catch (e) { hit = false; }
                if (hit && !excluded(el, list[i].x)) return true;
            }
            return false;
        };
        // querySelector(All) with filters: the elements that pass are marked and fetched in one more query (a real
        // NodeList in document order)
        var pick = function (root, list, qsa, first) {
            var seq = 'p' + (++pickSeq), picked = [], ran = 0;
            try {
                for (var i = 0; i < list.length; i++) {
                    var found;
                    try { found = scoped(root, list[i].t, function (text) { return qsa.call(root, text); }); ran++; } catch (e) { continue; }
                    for (var k = 0; k < found.length; k++) {
                        var el = found[k];
                        if (el.getAttribute('data-br-pick') === seq || (list[i].x.length && excluded(el, list[i].x))) continue;
                        el.setAttribute('data-br-pick', seq);
                        picked.push(el);
                    }
                }
                if (!ran) throw new Error('selector refused');
                var all = qsa.call(root, '[data-br-pick="' + seq + '"]');
                return first ? (all.length ? all[0] : null) : all;
            } finally {
                for (var j = 0; j < picked.length; j++) picked[j].removeAttribute('data-br-pick');
            }
        };
        var isSyntax = function (e) { return e && (e.code === 12 || /SYNTAX_ERR|SyntaxError/.test(String(e.name) + String(e.message))); };
        var refusedLogged = 0;
        var emptyList = function () { return document.createDocumentFragment().querySelectorAll('br-none'); };
        // What each selector text turned out to be: true (the engine takes it) or its rewrite, so that a query runs
        // without a try (a function with one makes a scope object on every call here) and a refused selector is not
        // taken apart again on every call (Tailwind's [&_:is(...)] rules, matched for every element by the custom
        // properties runtime). Bounded: pages that build selectors with ids start it over.
        // (per kind of call: querySelector(All) take :scope, which matches() leaves to the rewrite)
        // (a table per family, keyed by the selector itself: no string made per call; no prototype, so a selector
        // named like an Object.prototype property finds nothing there)
        var known = { q: Object.create(null), m: Object.create(null), u: Object.create(null) }, knownCount = 0;
        var remember = function (family, sel, v) {
            if (knownCount >= 3000) { known = { q: Object.create(null), m: Object.create(null), u: Object.create(null) }; knownCount = 0; }
            known[family][sel] = v;
            knownCount++;
        };
        var retry = function (self, orig, kind, qsa, sel, rw, e) {
            var list = rw.list, direct = function (text) { return orig.call(self, text); };
            try {
                if (!list.length) return kind === 'all' ? emptyList() : kind === 'is' ? false : null;
                if (!rw.filter) return scoped(self, rw.text, direct);
                if (kind === 'is') return matchesList(self, list);
                if (kind === 'up') { for (var el = self; el && el.nodeType === 1; el = el.parentNode) if (matchesList(el, list)) return el; return null; }
                return pick(self, list, qsa, kind === 'one');
            } catch (e2) {
                // (debugging: which selector the retry could not take either; other engines' prefixed ones, which
                // current browsers refuse too, are not worth a line)
                if (window.__brDebugErrors && refusedLogged < 8 && !/:-(?:moz|ms)-/.test(sel)) { refusedLogged++; sendToApp('brlog', 'Selector refused: ' + sel.slice(0, 300) + ' page ' + location.hostname); }
                if (e) throw e;
                orig.call(self, sel);   // (the engine's own error, as the first time)
                throw e2;
            }
        };
        var first = function (self, orig, kind, qsa, sel, family) {
            // (not a :scope selector: the engine takes it or not depending on the node, a fragment's has no element)
            try { var r = orig.call(self, sel); if (family && sel.indexOf(':scope') < 0) remember(family, sel, true); return r; } catch (e) {
                if (!family || !isSyntax(e)) throw e;
                var list = rewrite(sel), rw = { list: list, text: list.length ? joined(list) : '', filter: filtering(list) };
                remember(family, sel, rw);
                return retry(self, orig, kind, qsa, sel, rw, e);
            }
        };
        // kind: 'one' querySelector, 'all' querySelectorAll, 'is' matches, 'up' closest; qsa: the owner's own querySelectorAll
        // (the selector alone: no arguments object - every query of a page comes through here)
        // (before: the method as it was before the :scope and :read-only wrappers, which leave a selector without ':'
        // as it is - such a selector, known to be taken, goes straight there)
        var wrap = function (orig, kind, qsa, before) {
            var family = kind === 'one' || kind === 'all' ? 'q' : kind === 'is' ? 'm' : 'u';
            var direct = typeof before === 'function' && before !== orig ? before : null;
            return function (sel) {
                var k = typeof sel === 'string' ? known[family][sel] : undefined;
                if (k === true) return (direct !== null && sel.indexOf(':') < 0 ? direct : orig).call(this, sel);
                if (k) return retry(this, orig, kind, qsa, sel, k, null);
                return first(this, orig, kind, qsa, sel, typeof sel === 'string' ? family : null);
            };
        };
        var owners = [Ep, window.Document && window.Document.prototype, window.DocumentFragment && window.DocumentFragment.prototype];
        for (var o = 0; o < owners.length; o++) {
            var owner = owners[o];
            if (!owner || !owner.querySelectorAll) continue;
            var ownQSA = owner.querySelectorAll;
            if (owner.querySelector) owner.querySelector = wrap(owner.querySelector, 'one', ownQSA, queryBefore(owner, 'one'));
            owner.querySelectorAll = wrap(ownQSA, 'all', ownQSA, queryBefore(owner, 'all'));
        }
        if (Ep.matches) Ep.matches = wrap(Ep.matches, 'is', undefined, queryBefore(Ep, 'is'));
        if (Ep.webkitMatchesSelector) Ep.webkitMatchesSelector = wrap(Ep.webkitMatchesSelector, 'is', undefined, queryBefore(Ep, 'is'));
        if (Ep.closest) Ep.closest = wrap(Ep.closest, 'up', undefined, queryBefore(Ep, 'up'));
    })();
    // KeyboardEvent.key from keyCode
    if (window.KeyboardEvent && window.KeyboardEvent.prototype && !('key' in window.KeyboardEvent.prototype)) {
        var keyNames = { 8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Control', 18: 'Alt', 20: 'CapsLock', 27: 'Escape', 32: ' ', 33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 45: 'Insert', 46: 'Delete', 91: 'Meta', 93: 'ContextMenu', 186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`', 219: '[', 220: '\\', 221: ']', 222: "'" };
        try {
            Object.defineProperty(window.KeyboardEvent.prototype, 'key', { get: function () {
                var c = this.keyCode || this.which || 0;
                if (keyNames[c]) return keyNames[c];
                if (c >= 112 && c <= 123) return 'F' + (c - 111);
                if (c >= 48 && c <= 57) return String.fromCharCode(c);
                if (c >= 65 && c <= 90) return this.shiftKey ? String.fromCharCode(c) : String.fromCharCode(c + 32);
                if (c >= 96 && c <= 105) return String(c - 96);
                return this.keyIdentifier && this.keyIdentifier.indexOf('U+') === 0 ? String.fromCharCode(parseInt(this.keyIdentifier.slice(2), 16)) : 'Unidentified';
            }, configurable: true });
            Object.defineProperty(window.KeyboardEvent.prototype, 'code', { get: function () { var k = this.key; return k.length === 1 && /[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : k.length === 1 && /[0-9]/.test(k) ? 'Digit' + k : k === ' ' ? 'Space' : k; }, configurable: true });
        } catch (e) {}
    }
    if (window.Event && window.Event.prototype && !window.Event.prototype.composedPath) {
        window.Event.prototype.composedPath = function () { var path = [], n = this.target; while (n) { path.push(n); n = n.parentNode || (n === document ? window : null); } if (path[path.length - 1] !== window) path.push(window); return path; };
    }
    // event.isTrusted and event.composed, which the old engine lacks (a handler that skips events with !e.isTrusted
    // skipped every tap): the events scripts make (document.createEvent, and so the shims' Event and CustomEvent
    // constructors) are marked, the others come from the engine
    (function () {
        var EP = window.Event && window.Event.prototype, probe = null;
        try { probe = document.createEvent('Event'); } catch (e) { probe = null; }
        if (!EP || !probe || probe.isTrusted !== undefined) return;
        var owner = document;
        while (owner && !Object.prototype.hasOwnProperty.call(owner, 'createEvent')) owner = Object.getPrototypeOf(owner);
        var create = owner && owner.createEvent;
        if (typeof create !== 'function') return;
        // (the try in a function of its own, no arguments object)
        var made = function (e) { try { Object.defineProperty(e, '__brMade', { value: true }); } catch (x) {} return e; };
        owner.createEvent = function createEvent(kind) { return made(create.call(this, kind)); };
        // (and every event a script dispatches: the engine's own Event constructors make them without createEvent; all
        // dispatchEvent calls come through EventTarget.prototype, see above)
        var ETp = window.EventTarget && window.EventTarget.prototype, dispatch = ETp && ETp.dispatchEvent;
        // (the try in a function of its own and no arguments object: each costs every call here)
        var markMade = function (ev) { try { Object.defineProperty(ev, '__brMade', { value: true }); } catch (x) {} };
        if (typeof dispatch === 'function') ETp.dispatchEvent = function dispatchEvent(ev) {
            if (ev && typeof ev === 'object' && !ev.__brMade) markMade(ev);
            return dispatch.call(this, ev);
        };
        // (the click a script's element.click() makes is the engine's own too: untrusted while such a call runs)
        var HP = window.HTMLElement && window.HTMLElement.prototype, nativeClick = HP && HP.click, scriptClicks = 0;
        if (typeof nativeClick === 'function') HP.click = function click() {
            scriptClicks++;
            try { return nativeClick.apply(this, arguments); } finally { scriptClicks--; }
        };
        var UI = /^(click|dblclick|auxclick|contextmenu|mouse|pointer|touch|key|focus|blur|input|beforeinput|wheel|composition)/;
        try {
            Object.defineProperty(EP, 'isTrusted', { get: function () { return !this.__brMade && !(scriptClicks && this.type === 'click'); }, configurable: true });
            Object.defineProperty(EP, 'composed', { get: function () { return !this.__brMade && UI.test(this.type); }, configurable: true });
        } catch (e2) {}
    })();
    // window.origin (replaceable, as a script's own global `origin` must keep working), document.contentType, a
    // fragment's getElementById, the nonce of elements
    if (!('origin' in window)) {
        try {
            Object.defineProperty(window, 'origin', { configurable: true, enumerable: true,
                get: function () { return location.protocol + '//' + location.host; },
                set: function (v) { Object.defineProperty(window, 'origin', { value: v, writable: true, configurable: true, enumerable: true }); } });
        } catch (eO) {}
    }
    if (window.Document && !('contentType' in document)) {
        try { Object.defineProperty(window.Document.prototype, 'contentType', { get: function () { return this.xmlVersion ? 'application/xml' : 'text/html'; }, configurable: true }); } catch (eC) {}
    }
    // range.createContextualFragment(html) on a range in a document, a fragment or at the html element (a new Range
    // starts at the document): the standard parses in a body element then, the old engine refuses (NOT_SUPPORTED_ERR,
    // as for SVG elements too): OneTrust's cookie banner, on thousands of sites, failed so (theverge.com). And the
    // scripts of such a fragment run once it is inserted, which the old engine's never did (as after innerHTML): they
    // are made anew.
    (function () {
        var RP = window.Range && window.Range.prototype, ccf = RP && RP.createContextualFragment;
        if (typeof ccf !== 'function') return;
        var HTML_NS = 'http://www.w3.org/1999/xhtml';
        var runnable = function (frag) {
            var ss = frag && frag.querySelectorAll ? frag.querySelectorAll('script') : [];
            for (var i = 0; i < ss.length; i++) {
                var o = ss[i], n = (o.ownerDocument || document).createElement('script'), at = o.attributes;
                for (var a = 0; a < at.length; a++) n.setAttribute(at[a].name, at[a].value);
                n.text = o.text;
                o.parentNode.replaceChild(n, o);
            }
            return frag;
        };
        RP.createContextualFragment = function createContextualFragment(html) {
            var c = this.startContainer, el = c && (c.nodeType === 1 ? c : c.parentNode);
            if (el && el.nodeType === 1 && el.nodeName !== 'HTML' && (!el.namespaceURI || el.namespaceURI === HTML_NS)) return runnable(ccf.call(this, html));
            var doc = c ? (c.nodeType === 9 ? c : c.ownerDocument) || document : document;
            var r = doc.createRange();
            r.selectNodeContents(doc.body || doc.createElement('body'));
            return runnable(ccf.call(r, html));
        };
    })();
    if (window.DocumentFragment && !window.DocumentFragment.prototype.getElementById) {
        window.DocumentFragment.prototype.getElementById = function (id) {
            id = String(id);
            var all = this.querySelectorAll('[id]');
            for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
            return null;
        };
    }
    if (window.HTMLElement && !('nonce' in document.createElement('script'))) {
        try { Object.defineProperty(window.HTMLElement.prototype, 'nonce', { get: function () { return this.getAttribute('nonce') || ''; }, set: function (v) { this.setAttribute('nonce', v); }, configurable: true }); } catch (eN) {}
    }
    // setAttribute with a name today's DOM takes and the old engine refuses (INVALID_CHARACTER_ERR): the standard dropped
    // the XML name rule in 2025 (only whitespace, / > = and NUL are out), and templates set names like @click, :class,
    // #ref or [x] (eBay's header stopped on one). The HTML parser makes such an attribute, setAttributeNode moves it.
    (function () {
        var orig = Ep && Ep.setAttribute;
        if (typeof orig !== 'function') return;
        var PLAIN = /^[A-Za-z_][\w.:-]*$/, RELAXED = /^[^\s\/>=\0"'<&]+$/, box = null;
        var viaParser = function (el, name, value) {
            box = box || document.createElement('div');
            box.innerHTML = '<i ' + name + '=""></i>';
            var i = box.firstChild, a = i && i.attributes && i.attributes.length === 1 ? i.attributes[0] : null;
            if (!a) return false;
            i.removeAttributeNode(a);
            box.innerHTML = '';
            a.value = String(value);
            el.setAttributeNode(a);
            return true;
        };
        var slow = function (el, name, value) {
            try { return orig.call(el, name, value); } catch (e) {
                var n = String(name);
                if (!e || e.code !== 5 || !RELAXED.test(n) || !viaParser(el, n, value)) throw e;
            }
        };
        Ep.setAttribute = function setAttribute(name, value) {
            if (typeof name === 'string' && PLAIN.test(name)) return orig.call(this, name, value);
            return slow(this, name, value);
        };
    })();
    if (Ep && !Ep.insertAdjacentElement) {
        Ep.insertAdjacentElement = function (position, el) {
            var p = String(position).toLowerCase();
            if (p === 'beforebegin') this.parentNode.insertBefore(el, this);
            else if (p === 'afterbegin') this.insertBefore(el, this.firstChild);
            else if (p === 'beforeend') this.appendChild(el);
            else if (p === 'afterend') this.parentNode.insertBefore(el, this.nextSibling);
            return el;
        };
        Ep.insertAdjacentText = function (position, text) { return this.insertAdjacentElement(position, document.createTextNode(text)); };
    }
    var collectionProtos = [window.NodeList && window.NodeList.prototype, window.HTMLCollection && window.HTMLCollection.prototype];
    for (var cp = 0; cp < collectionProtos.length; cp++) {
        if (!collectionProtos[cp]) continue;
        if (!collectionProtos[cp].forEach) collectionProtos[cp].forEach = Array.prototype.forEach;
        if (!collectionProtos[cp].entries) collectionProtos[cp].entries = function () { return Array.prototype.slice.call(this).entries(); };
        if (!collectionProtos[cp].keys) collectionProtos[cp].keys = function () { return Array.prototype.slice.call(this).keys(); };
        if (!collectionProtos[cp].values) collectionProtos[cp].values = function () { return Array.prototype.slice.call(this).values(); };
    }
    if (!String.prototype.trimStart) { String.prototype.trimStart = String.prototype.trimLeft || function () { return this.replace(/^\s+/, ''); }; String.prototype.trimEnd = String.prototype.trimRight || function () { return this.replace(/\s+$/, ''); }; }
    if (!Number.parseFloat) Number.parseFloat = parseFloat;
    if (!Number.parseInt) Number.parseInt = parseInt;
    if (!String.prototype.replaceAll) {
        String.prototype.replaceAll = function (search, replacement) {
            if (search instanceof RegExp) { if (!search.global) throw new TypeError('replaceAll must be called with a global RegExp'); return this.replace(search, replacement); }
            if (typeof replacement === 'function') { var s = String(this), out = '', idx = 0, pos; search = String(search); while ((pos = s.indexOf(search, idx)) >= 0) { out += s.slice(idx, pos) + replacement(search, pos, s); idx = pos + search.length; if (!search.length) { if (idx >= s.length) break; out += s.charAt(idx); idx++; } } return out + s.slice(idx); }
            return String(this).split(String(search)).join(String(replacement).replace(/\$/g, '$$$$'));
        };
    }
    // String.prototype.normalize (the old engine has none): decompositions of Latin, Greek, Cyrillic and Vietnamese
    // letters and of common compatibility characters (ligatures, full-width forms, spaces, super/subscripts, circled
    // numbers), generated from a desktop engine as code points; NFC/NFKC recompose pairwise. Enough for the usual
    // "remove diacritics" (NFD + strip U+0300-U+036F) and search matching.
    if (!String.prototype.normalize) (function () {
        var CANON = 'c0:41.300,c1:41.301,c2:41.302,c3:41.303,c4:41.308,c5:41.30a,c7:43.327,c8:45.300,c9:45.301,ca:45.302,cb:45.308,cc:49.300,cd:49.301,ce:49.302,cf:49.308,d1:4e.303,d2:4f.300,d3:4f.301,d4:4f.302,d5:4f.303,d6:4f.308,d9:55.300,da:55.301,db:55.302,dc:55.308,dd:59.301,e0:61.300,e1:61.301,e2:61.302,e3:61.303,e4:61.308,e5:61.30a,e7:63.327,e8:65.300,e9:65.301,ea:65.302,eb:65.308,ec:69.300,ed:69.301,ee:69.302,ef:69.308,f1:6e.303,f2:6f.300,f3:6f.301,f4:6f.302,f5:6f.303,f6:6f.308,f9:75.300,fa:75.301,fb:75.302,fc:75.308,fd:79.301,ff:79.308,100:41.304,101:61.304,102:41.306,103:61.306,104:41.328,105:61.328,106:43.301,107:63.301,108:43.302,109:63.302,10a:43.307,10b:63.307,10c:43.30c,10d:63.30c,10e:44.30c,10f:64.30c,112:45.304,113:65.304,114:45.306,115:65.306,116:45.307,117:65.307,118:45.328,119:65.328,11a:45.30c,11b:65.30c,11c:47.302,11d:67.302,11e:47.306,11f:67.306,120:47.307,121:67.307,122:47.327,123:67.327,124:48.302,125:68.302,128:49.303,129:69.303,12a:49.304,12b:69.304,12c:49.306,12d:69.306,12e:49.328,12f:69.328,130:49.307,134:4a.302,135:6a.302,136:4b.327,137:6b.327,139:4c.301,13a:6c.301,13b:4c.327,13c:6c.327,13d:4c.30c,13e:6c.30c,143:4e.301,144:6e.301,145:4e.327,146:6e.327,147:4e.30c,148:6e.30c,14c:4f.304,14d:6f.304,14e:4f.306,14f:6f.306,150:4f.30b,151:6f.30b,154:52.301,155:72.301,156:52.327,157:72.327,158:52.30c,159:72.30c,15a:53.301,15b:73.301,15c:53.302,15d:73.302,15e:53.327,15f:73.327,160:53.30c,161:73.30c,162:54.327,163:74.327,164:54.30c,165:74.30c,168:55.303,169:75.303,16a:55.304,16b:75.304,16c:55.306,16d:75.306,16e:55.30a,16f:75.30a,170:55.30b,171:75.30b,172:55.328,173:75.328,174:57.302,175:77.302,176:59.302,177:79.302,178:59.308,179:5a.301,17a:7a.301,17b:5a.307,17c:7a.307,17d:5a.30c,17e:7a.30c,1a0:4f.31b,1a1:6f.31b,1af:55.31b,1b0:75.31b,1cd:41.30c,1ce:61.30c,1cf:49.30c,1d0:69.30c,1d1:4f.30c,1d2:6f.30c,1d3:55.30c,1d4:75.30c,1d5:55.308.304,1d6:75.308.304,1d7:55.308.301,1d8:75.308.301,1d9:55.308.30c,1da:75.308.30c,1db:55.308.300,1dc:75.308.300,1de:41.308.304,1df:61.308.304,1e0:41.307.304,1e1:61.307.304,1e2:c6.304,1e3:e6.304,1e6:47.30c,1e7:67.30c,1e8:4b.30c,1e9:6b.30c,1ea:4f.328,1eb:6f.328,1ec:4f.328.304,1ed:6f.328.304,1ee:1b7.30c,1ef:292.30c,1f0:6a.30c,1f4:47.301,1f5:67.301,1f8:4e.300,1f9:6e.300,1fa:41.30a.301,1fb:61.30a.301,1fc:c6.301,1fd:e6.301,1fe:d8.301,1ff:f8.301,200:41.30f,201:61.30f,202:41.311,203:61.311,204:45.30f,205:65.30f,206:45.311,207:65.311,208:49.30f,209:69.30f,20a:49.311,20b:69.311,20c:4f.30f,20d:6f.30f,20e:4f.311,20f:6f.311,210:52.30f,211:72.30f,212:52.311,213:72.311,214:55.30f,215:75.30f,216:55.311,217:75.311,218:53.326,219:73.326,21a:54.326,21b:74.326,21e:48.30c,21f:68.30c,226:41.307,227:61.307,228:45.327,229:65.327,22a:4f.308.304,22b:6f.308.304,22c:4f.303.304,22d:6f.303.304,22e:4f.307,22f:6f.307,230:4f.307.304,231:6f.307.304,232:59.304,233:79.304,1e00:41.325,1e01:61.325,1e02:42.307,1e03:62.307,1e04:42.323,1e05:62.323,1e06:42.331,1e07:62.331,1e08:43.327.301,1e09:63.327.301,1e0a:44.307,1e0b:64.307,1e0c:44.323,1e0d:64.323,1e0e:44.331,1e0f:64.331,1e10:44.327,1e11:64.327,1e12:44.32d,1e13:64.32d,1e14:45.304.300,1e15:65.304.300,1e16:45.304.301,1e17:65.304.301,1e18:45.32d,1e19:65.32d,1e1a:45.330,1e1b:65.330,1e1c:45.327.306,1e1d:65.327.306,1e1e:46.307,1e1f:66.307,1e20:47.304,1e21:67.304,1e22:48.307,1e23:68.307,1e24:48.323,1e25:68.323,1e26:48.308,1e27:68.308,1e28:48.327,1e29:68.327,1e2a:48.32e,1e2b:68.32e,1e2c:49.330,1e2d:69.330,1e2e:49.308.301,1e2f:69.308.301,1e30:4b.301,1e31:6b.301,1e32:4b.323,1e33:6b.323,1e34:4b.331,1e35:6b.331,1e36:4c.323,1e37:6c.323,1e38:4c.323.304,1e39:6c.323.304,1e3a:4c.331,1e3b:6c.331,1e3c:4c.32d,1e3d:6c.32d,1e3e:4d.301,1e3f:6d.301,1e40:4d.307,1e41:6d.307,1e42:4d.323,1e43:6d.323,1e44:4e.307,1e45:6e.307,1e46:4e.323,1e47:6e.323,1e48:4e.331,1e49:6e.331,1e4a:4e.32d,1e4b:6e.32d,1e4c:4f.303.301,1e4d:6f.303.301,1e4e:4f.303.308,1e4f:6f.303.308,1e50:4f.304.300,1e51:6f.304.300,1e52:4f.304.301,1e53:6f.304.301,1e54:50.301,1e55:70.301,1e56:50.307,1e57:70.307,1e58:52.307,1e59:72.307,1e5a:52.323,1e5b:72.323,1e5c:52.323.304,1e5d:72.323.304,1e5e:52.331,1e5f:72.331,1e60:53.307,1e61:73.307,1e62:53.323,1e63:73.323,1e64:53.301.307,1e65:73.301.307,1e66:53.30c.307,1e67:73.30c.307,1e68:53.323.307,1e69:73.323.307,1e6a:54.307,1e6b:74.307,1e6c:54.323,1e6d:74.323,1e6e:54.331,1e6f:74.331,1e70:54.32d,1e71:74.32d,1e72:55.324,1e73:75.324,1e74:55.330,1e75:75.330,1e76:55.32d,1e77:75.32d,1e78:55.303.301,1e79:75.303.301,1e7a:55.304.308,1e7b:75.304.308,1e7c:56.303,1e7d:76.303,1e7e:56.323,1e7f:76.323,1e80:57.300,1e81:77.300,1e82:57.301,1e83:77.301,1e84:57.308,1e85:77.308,1e86:57.307,1e87:77.307,1e88:57.323,1e89:77.323,1e8a:58.307,1e8b:78.307,1e8c:58.308,1e8d:78.308,1e8e:59.307,1e8f:79.307,1e90:5a.302,1e91:7a.302,1e92:5a.323,1e93:7a.323,1e94:5a.331,1e95:7a.331,1e96:68.331,1e97:74.308,1e98:77.30a,1e99:79.30a,1e9b:17f.307,1ea0:41.323,1ea1:61.323,1ea2:41.309,1ea3:61.309,1ea4:41.302.301,1ea5:61.302.301,1ea6:41.302.300,1ea7:61.302.300,1ea8:41.302.309,1ea9:61.302.309,1eaa:41.302.303,1eab:61.302.303,1eac:41.323.302,1ead:61.323.302,1eae:41.306.301,1eaf:61.306.301,1eb0:41.306.300,1eb1:61.306.300,1eb2:41.306.309,1eb3:61.306.309,1eb4:41.306.303,1eb5:61.306.303,1eb6:41.323.306,1eb7:61.323.306,1eb8:45.323,1eb9:65.323,1eba:45.309,1ebb:65.309,1ebc:45.303,1ebd:65.303,1ebe:45.302.301,1ebf:65.302.301,1ec0:45.302.300,1ec1:65.302.300,1ec2:45.302.309,1ec3:65.302.309,1ec4:45.302.303,1ec5:65.302.303,1ec6:45.323.302,1ec7:65.323.302,1ec8:49.309,1ec9:69.309,1eca:49.323,1ecb:69.323,1ecc:4f.323,1ecd:6f.323,1ece:4f.309,1ecf:6f.309,1ed0:4f.302.301,1ed1:6f.302.301,1ed2:4f.302.300,1ed3:6f.302.300,1ed4:4f.302.309,1ed5:6f.302.309,1ed6:4f.302.303,1ed7:6f.302.303,1ed8:4f.323.302,1ed9:6f.323.302,1eda:4f.31b.301,1edb:6f.31b.301,1edc:4f.31b.300,1edd:6f.31b.300,1ede:4f.31b.309,1edf:6f.31b.309,1ee0:4f.31b.303,1ee1:6f.31b.303,1ee2:4f.31b.323,1ee3:6f.31b.323,1ee4:55.323,1ee5:75.323,1ee6:55.309,1ee7:75.309,1ee8:55.31b.301,1ee9:75.31b.301,1eea:55.31b.300,1eeb:75.31b.300,1eec:55.31b.309,1eed:75.31b.309,1eee:55.31b.303,1eef:75.31b.303,1ef0:55.31b.323,1ef1:75.31b.323,1ef2:59.300,1ef3:79.300,1ef4:59.323,1ef5:79.323,1ef6:59.309,1ef7:79.309,1ef8:59.303,1ef9:79.303,374:2b9,37e:3b,385:a8.301,386:391.301,387:b7,388:395.301,389:397.301,38a:399.301,38c:39f.301,38e:3a5.301,38f:3a9.301,390:3b9.308.301,3aa:399.308,3ab:3a5.308,3ac:3b1.301,3ad:3b5.301,3ae:3b7.301,3af:3b9.301,3b0:3c5.308.301,3ca:3b9.308,3cb:3c5.308,3cc:3bf.301,3cd:3c5.301,3ce:3c9.301,3d3:3d2.301,3d4:3d2.308,400:415.300,401:415.308,403:413.301,407:406.308,40c:41a.301,40d:418.300,40e:423.306,419:418.306,439:438.306,450:435.300,451:435.308,453:433.301,457:456.308,45c:43a.301,45d:438.300,45e:443.306,476:474.30f,477:475.30f,4c1:416.306,4c2:436.306,4d0:410.306,4d1:430.306,4d2:410.308,4d3:430.308,4d6:415.306,4d7:435.306,4da:4d8.308,4db:4d9.308,4dc:416.308,4dd:436.308,4de:417.308,4df:437.308,4e2:418.304,4e3:438.304,4e4:418.308,4e5:438.308,4e6:41e.308,4e7:43e.308,4ea:4e8.308,4eb:4e9.308,4ec:42d.308,4ed:44d.308,4ee:423.304,4ef:443.304,4f0:423.308,4f1:443.308,4f2:423.30b,4f3:443.30b,4f4:427.308,4f5:447.308,4f8:42b.308,4f9:44b.308';
        var COMPAT = 'a0:20,a8:20.308,aa:61,af:20.304,b2:32,b3:33,b4:20.301,b5:3bc,b8:20.327,b9:31,ba:6f,bc:31.2044.34,bd:31.2044.32,be:33.2044.34,132:49.4a,133:69.6a,13f:4c.b7,140:6c.b7,149:2bc.6e,17f:73,1c4:44.5a.30c,1c5:44.7a.30c,1c6:64.7a.30c,1c7:4c.4a,1c8:4c.6a,1c9:6c.6a,1ca:4e.4a,1cb:4e.6a,1cc:6e.6a,1f1:44.5a,1f2:44.7a,1f3:64.7a,2000:20,2001:20,2002:20,2003:20,2004:20,2005:20,2006:20,2007:20,2008:20,2009:20,200a:20,2011:2010,2024:2e,2025:2e.2e,2026:2e.2e.2e,202f:20,205f:20,2070:30,2071:69,2074:34,2075:35,2076:36,2077:37,2078:38,2079:39,207a:2b,207b:2212,207c:3d,207d:28,207e:29,207f:6e,2080:30,2081:31,2082:32,2083:33,2084:34,2085:35,2086:36,2087:37,2088:38,2089:39,208a:2b,208b:2212,208c:3d,208d:28,208e:29,2090:61,2091:65,2092:6f,2093:78,2094:259,2095:68,2096:6b,2097:6c,2098:6d,2099:6e,209a:70,209b:73,209c:74,2100:61.2f.63,2101:61.2f.73,2102:43,2103:b0.43,2105:63.2f.6f,2106:63.2f.75,2107:190,2109:b0.46,210a:67,210b:48,210c:48,210d:48,210e:68,210f:127,2110:49,2111:49,2112:4c,2113:6c,2115:4e,2116:4e.6f,2119:50,211a:51,211b:52,211c:52,211d:52,2120:53.4d,2121:54.45.4c,2122:54.4d,2124:5a,2128:5a,212c:42,212d:43,212f:65,2130:45,2131:46,2133:4d,2134:6f,2135:5d0,2136:5d1,2137:5d2,2138:5d3,2139:69,213b:46.41.58,213c:3c0,213d:3b3,213e:393,213f:3a0,2140:2211,2145:44,2146:64,2147:65,2148:69,2149:6a,2150:31.2044.37,2151:31.2044.39,2152:31.2044.31.30,2153:31.2044.33,2154:32.2044.33,2155:31.2044.35,2156:32.2044.35,2157:33.2044.35,2158:34.2044.35,2159:31.2044.36,215a:35.2044.36,215b:31.2044.38,215c:33.2044.38,215d:35.2044.38,215e:37.2044.38,215f:31.2044,2160:49,2161:49.49,2162:49.49.49,2163:49.56,2164:56,2165:56.49,2166:56.49.49,2167:56.49.49.49,2168:49.58,2169:58,216a:58.49,216b:58.49.49,216c:4c,216d:43,216e:44,216f:4d,2170:69,2171:69.69,2172:69.69.69,2173:69.76,2174:76,2175:76.69,2176:76.69.69,2177:76.69.69.69,2178:69.78,2179:78,217a:78.69,217b:78.69.69,217c:6c,217d:63,217e:64,217f:6d,2460:31,2461:32,2462:33,2463:34,2464:35,2465:36,2466:37,2467:38,2468:39,2469:31.30,246a:31.31,246b:31.32,246c:31.33,246d:31.34,246e:31.35,246f:31.36,2470:31.37,2471:31.38,2472:31.39,2473:32.30,2474:28.31.29,2475:28.32.29,2476:28.33.29,2477:28.34.29,2478:28.35.29,2479:28.36.29,247a:28.37.29,247b:28.38.29,247c:28.39.29,247d:28.31.30.29,247e:28.31.31.29,247f:28.31.32.29,2480:28.31.33.29,2481:28.31.34.29,2482:28.31.35.29,2483:28.31.36.29,2484:28.31.37.29,2485:28.31.38.29,2486:28.31.39.29,2487:28.32.30.29,2488:31.2e,2489:32.2e,248a:33.2e,248b:34.2e,248c:35.2e,248d:36.2e,248e:37.2e,248f:38.2e,2490:39.2e,2491:31.30.2e,2492:31.31.2e,2493:31.32.2e,2494:31.33.2e,2495:31.34.2e,2496:31.35.2e,2497:31.36.2e,2498:31.37.2e,2499:31.38.2e,249a:31.39.2e,249b:32.30.2e,249c:28.61.29,249d:28.62.29,249e:28.63.29,249f:28.64.29,24a0:28.65.29,24a1:28.66.29,24a2:28.67.29,24a3:28.68.29,24a4:28.69.29,24a5:28.6a.29,24a6:28.6b.29,24a7:28.6c.29,24a8:28.6d.29,24a9:28.6e.29,24aa:28.6f.29,24ab:28.70.29,24ac:28.71.29,24ad:28.72.29,24ae:28.73.29,24af:28.74.29,24b0:28.75.29,24b1:28.76.29,24b2:28.77.29,24b3:28.78.29,24b4:28.79.29,24b5:28.7a.29,24b6:41,24b7:42,24b8:43,24b9:44,24ba:45,24bb:46,24bc:47,24bd:48,24be:49,24bf:4a,24c0:4b,24c1:4c,24c2:4d,24c3:4e,24c4:4f,24c5:50,24c6:51,24c7:52,24c8:53,24c9:54,24ca:55,24cb:56,24cc:57,24cd:58,24ce:59,24cf:5a,24d0:61,24d1:62,24d2:63,24d3:64,24d4:65,24d5:66,24d6:67,24d7:68,24d8:69,24d9:6a,24da:6b,24db:6c,24dc:6d,24dd:6e,24de:6f,24df:70,24e0:71,24e1:72,24e2:73,24e3:74,24e4:75,24e5:76,24e6:77,24e7:78,24e8:79,24e9:7a,24ea:30,fb00:66.66,fb01:66.69,fb02:66.6c,fb03:66.66.69,fb04:66.66.6c,fb05:73.74,fb06:73.74,ff01:21,ff02:22,ff03:23,ff04:24,ff05:25,ff06:26,ff07:27,ff08:28,ff09:29,ff0a:2a,ff0b:2b,ff0c:2c,ff0d:2d,ff0e:2e,ff0f:2f,ff10:30,ff11:31,ff12:32,ff13:33,ff14:34,ff15:35,ff16:36,ff17:37,ff18:38,ff19:39,ff1a:3a,ff1b:3b,ff1c:3c,ff1d:3d,ff1e:3e,ff1f:3f,ff20:40,ff21:41,ff22:42,ff23:43,ff24:44,ff25:45,ff26:46,ff27:47,ff28:48,ff29:49,ff2a:4a,ff2b:4b,ff2c:4c,ff2d:4d,ff2e:4e,ff2f:4f,ff30:50,ff31:51,ff32:52,ff33:53,ff34:54,ff35:55,ff36:56,ff37:57,ff38:58,ff39:59,ff3a:5a,ff3b:5b,ff3c:5c,ff3d:5d,ff3e:5e,ff3f:5f,ff40:60,ff41:61,ff42:62,ff43:63,ff44:64,ff45:65,ff46:66,ff47:67,ff48:68,ff49:69,ff4a:6a,ff4b:6b,ff4c:6c,ff4d:6d,ff4e:6e,ff4f:6f,ff50:70,ff51:71,ff52:72,ff53:73,ff54:74,ff55:75,ff56:76,ff57:77,ff58:78,ff59:79,ff5a:7a,ff5b:7b,ff5c:7c,ff5d:7d,ff5e:7e,3000:20';
        var dec = null, kdec = null, comp = null;
        var chars = function (s) { var parts = s.split('.'), out = ''; for (var i = 0; i < parts.length; i++) out += String.fromCharCode(parseInt(parts[i], 16)); return out; };
        var tables = function () {
            if (dec) return;
            dec = {}; kdec = {}; comp = {};
            var rev = {}, list = CANON.split(','), i, kv, ch, d;
            for (i = 0; i < list.length; i++) { kv = list[i].split(':'); ch = String.fromCharCode(parseInt(kv[0], 16)); d = chars(kv[1]); dec[ch] = d; kdec[ch] = d; rev[d] = ch; }
            // pairwise compositions: (the composite of all but the last mark) + last mark
            for (ch in dec) if (dec.hasOwnProperty(ch)) {
                d = dec[ch];
                if (d.length < 2) continue;
                var first = d.length === 2 ? d.charAt(0) : rev[d.slice(0, -1)];
                if (first) comp[first + d.charAt(d.length - 1)] = ch;
            }
            for (list = COMPAT.split(','), i = 0; i < list.length; i++) { kv = list[i].split(':'); kdec[String.fromCharCode(parseInt(kv[0], 16))] = chars(kv[1]); }
        };
        var decompose = function (s, table) {
            var out = '';
            for (var i = 0; i < s.length; i++) { var c = s.charAt(i); out += table.hasOwnProperty(c) ? table[c] : c; }
            return out;
        };
        var compose = function (s) {
            var out = '', i = 0;
            while (i < s.length) {
                var c = s.charAt(i++);
                while (i < s.length && comp.hasOwnProperty(c + s.charAt(i))) c = comp[c + s.charAt(i++)];
                out += c;
            }
            return out;
        };
        var normalize = function normalize(form) {
            'use strict';
            if (this === null || this === undefined) throw new TypeError('String.prototype.normalize called on null or undefined');
            var s = String(this), f = form === undefined ? 'NFC' : String(form);
            if (f !== 'NFC' && f !== 'NFD' && f !== 'NFKC' && f !== 'NFKD') throw new RangeError('The normalization form should be one of NFC, NFD, NFKC, NFKD.');
            if (!/[^\x00-\x7f]/.test(s)) return s;
            tables();
            var d = decompose(s, f === 'NFC' || f === 'NFD' ? dec : kdec);
            return f === 'NFD' || f === 'NFKD' ? d : compose(d);
        };
        try { Object.defineProperty(String.prototype, 'normalize', { value: normalize, writable: true, configurable: true }); } catch (e) { String.prototype.normalize = normalize; }
    })();
    // DOMParser for text/html (the old engine parses only XML types and returns null)
    if (window.DOMParser) (function () {
        var proto = window.DOMParser.prototype, parse = proto.parseFromString;
        try { if (new window.DOMParser().parseFromString('', 'text/html')) return; } catch (e) {}
        proto.parseFromString = function (markup, type) {
            if (!/^\s*text\/html\s*(;|$)/i.test(String(type))) return parse.apply(this, arguments);
            var doc = document.implementation.createHTMLDocument('');
            markup = String(markup);
            if (/<(!doctype|html)[\s>]/i.test(markup)) doc.documentElement.innerHTML = markup.replace(/^[\s\S]*?<html[^>]*>|<\/html>[\s\S]*$/gi, '');
            else doc.body.innerHTML = markup;
            return doc;
        };
    })();
    if (!('origin' in window.location)) try { Object.defineProperty(window.location, 'origin', { get: function () { return location.protocol + '//' + location.host; } }); } catch (e) {}
    if (window.history && !('scrollRestoration' in window.history)) try { window.history.scrollRestoration = 'auto'; } catch (e) {}
    if (!('isSecureContext' in window)) try { window.isSecureContext = location.protocol === 'https:' || location.hostname === 'localhost'; } catch (e) {}

    // Host object wrappers that carry our added properties must not be collected and recreated without them
    try { window.__brKeepAlive = [window.navigator, window.crypto, window.screen, window.history, window.performance, window.localStorage, window.sessionStorage, navigator.mediaDevices, navigator.geolocation]; } catch (e) {}

    // ---- CSSOM and view interfaces the old engine lacks or hides (browserscore inventory)
    try {
        if (Ep && typeof Ep.scrollTo !== 'function') {
            Ep.scrollTo = function (x, y) { if (x && typeof x === 'object') { y = x.top; x = x.left; } if (x !== undefined && x !== null) this.scrollLeft = x; if (y !== undefined && y !== null) this.scrollTop = y; };
            Ep.scroll = Ep.scrollTo;
            Ep.scrollBy = function (x, y) { if (x && typeof x === 'object') { y = x.top; x = x.left; } this.scrollLeft += x || 0; this.scrollTop += y || 0; };
        }
        if (window.matchMedia && !window.MediaQueryList) {
            var mqlProto = Object.getPrototypeOf(window.matchMedia('all'));
            window.MediaQueryList = function MediaQueryList() {};
            window.MediaQueryList.prototype = mqlProto;
            if (!('onchange' in mqlProto)) try { Object.defineProperty(mqlProto, 'onchange', { get: function () { return this.__onchange || null; }, set: function (f) { if (this.__onchange) this.removeListener(this.__onchange); this.__onchange = f; if (f) this.addListener(f); }, configurable: true }); } catch (e0) {}
        }
        if (!window.MediaQueryListEvent) window.MediaQueryListEvent = function MediaQueryListEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, false, false); e.media = init && init.media || ''; e.matches = !!(init && init.matches); return e; };
        if (!window.Screen && window.screen) { window.Screen = function Screen() {}; window.Screen.prototype = Object.getPrototypeOf(window.screen); }
        if (window.visualViewport && !window.VisualViewport) {
            window.VisualViewport = function VisualViewport() {};
            var vv = window.visualViewport, vvProto = window.VisualViewport.prototype;
            vvProto.addEventListener = noop; vvProto.removeEventListener = noop; vvProto.dispatchEvent = function () { return true; };
            var vvNames = ['width', 'height', 'scale', 'offsetLeft', 'offsetTop', 'pageLeft', 'pageTop', 'onresize', 'onscroll', 'onscrollend'];
            for (var vvi = 0; vvi < vvNames.length; vvi++) if (!(vvNames[vvi] in vvProto)) vvProto[vvNames[vvi]] = vv[vvNames[vvi]] === undefined ? null : vv[vvNames[vvi]];
            try { vv.__proto__ = vvProto; } catch (e1) {}
        }
        if (window.CSSRule) {
            var ruleConsts = { KEYFRAMES_RULE: 7, KEYFRAME_RULE: 8, MARGIN_RULE: 9, NAMESPACE_RULE: 10, COUNTER_STYLE_RULE: 11, SUPPORTS_RULE: 12, FONT_FEATURE_VALUES_RULE: 14, VIEWPORT_RULE: 15, REGION_STYLE_RULE: 16 };
            for (var rc in ruleConsts) if (ruleConsts.hasOwnProperty(rc) && !(rc in window.CSSRule)) try { window.CSSRule[rc] = ruleConsts[rc]; } catch (e2) {}
        }
        if (!window.CSSKeyframesRule && window.WebKitCSSKeyframesRule) window.CSSKeyframesRule = window.WebKitCSSKeyframesRule;
        if (!window.CSSKeyframeRule && window.WebKitCSSKeyframeRule) window.CSSKeyframeRule = window.WebKitCSSKeyframeRule;
        if (window.CSSKeyframesRule && window.CSSKeyframesRule.prototype && !window.CSSKeyframesRule.prototype.appendRule) {
            window.CSSKeyframesRule.prototype.appendRule = function (rule) { return this.insertRule(rule); };
        }
        var ruleStubs = ['CSSGroupingRule', 'CSSConditionRule', 'CSSSupportsRule', 'CSSLayerBlockRule', 'CSSLayerStatementRule', 'CSSContainerRule', 'CSSCounterStyleRule',
                         'CSSFontFeatureValuesRule', 'CSSFontPaletteValuesRule', 'CSSPropertyRule', 'CSSScopeRule', 'CSSNestedDeclarations', 'CSSStartingStyleRule', 'CSSPositionTryRule', 'CSSViewTransitionRule'];
        for (var rs = 0; rs < ruleStubs.length; rs++) if (!window[ruleStubs[rs]]) window[ruleStubs[rs]] = (function (n) { var F = function () {}; try { F.prototype = Object.create(window.CSSRule ? window.CSSRule.prototype : Object.prototype); } catch (e3) {} F.prototype.constructor = F; return F; })(ruleStubs[rs]);
        if (window.CSSStyleRule && window.CSSStyleRule.prototype && !('cssRules' in window.CSSStyleRule.prototype)) {
            try { Object.defineProperty(window.CSSStyleRule.prototype, 'cssRules', { get: function () { return []; }, configurable: true }); } catch (e4) {}
            window.CSSStyleRule.prototype.insertRule = function () { return 0; };
            window.CSSStyleRule.prototype.deleteRule = noop;
        }
        // Web Animations: a fuller Animation object for element.animate()
        if (!window.Animation || !window.Animation.prototype.play) {
            var Animation = function Animation(effect, timeline) {
                this.effect = effect || null; this.timeline = timeline || (document.timeline || null); this.id = ''; this.startTime = null; this.currentTime = 0;
                this.playbackRate = 1; this.playState = 'finished'; this.replaceState = 'active'; this.pending = false;
                this.onfinish = null; this.oncancel = null; this.onremove = null;
                var self = this;
                this.ready = P ? P.resolve(self) : null; this.finished = this.ready;
            };
            Animation.prototype.cancel = function () { this.playState = 'idle'; if (typeof this.oncancel === 'function') this.oncancel({ target: this }); };
            Animation.prototype.finish = function () { this.playState = 'finished'; if (typeof this.onfinish === 'function') this.onfinish({ target: this }); };
            Animation.prototype.play = function () { this.playState = 'finished'; var s = this; setTimeout(function () { if (typeof s.onfinish === 'function') s.onfinish({ target: s }); }, 0); };
            Animation.prototype.pause = function () { this.playState = 'paused'; };
            Animation.prototype.reverse = noop; Animation.prototype.updatePlaybackRate = function (r) { this.playbackRate = r; }; Animation.prototype.persist = noop; Animation.prototype.commitStyles = noop;
            Animation.prototype.addEventListener = noop; Animation.prototype.removeEventListener = noop; Animation.prototype.dispatchEvent = function () { return true; };
            window.Animation = Animation;
            if (Ep) { Ep.animate = function () { var a = new Animation(); a.play(); return a; }; Ep.getAnimations = function () { return []; }; }
            window.CSSAnimation = function CSSAnimation() { Animation.call(this); this.animationName = ''; };
            window.CSSAnimation.prototype = Object.create(Animation.prototype);
            window.CSSTransition = function CSSTransition() { Animation.call(this); this.transitionProperty = ''; };
            window.CSSTransition.prototype = Object.create(Animation.prototype);
            if (!window.KeyframeEffect) window.KeyframeEffect = function KeyframeEffect(target, keyframes, options) { this.target = target || null; this.composite = 'replace'; this.pseudoElement = null; this.__k = keyframes; this.__o = options; };
            window.KeyframeEffect.prototype.getKeyframes = function () { return this.__k || []; };
            window.KeyframeEffect.prototype.setKeyframes = function (k) { this.__k = k; };
            window.KeyframeEffect.prototype.getTiming = function () { return typeof this.__o === 'object' && this.__o ? this.__o : { duration: this.__o || 0 }; };
            window.KeyframeEffect.prototype.getComputedTiming = window.KeyframeEffect.prototype.getTiming;
            window.KeyframeEffect.prototype.updateTiming = noop;
            window.AnimationEffect = window.AnimationEffect || window.KeyframeEffect;
            if (!window.AnimationTimeline) window.AnimationTimeline = function AnimationTimeline() { this.currentTime = 0; };
            if (!window.DocumentTimeline) { window.DocumentTimeline = function DocumentTimeline() { this.currentTime = 0; }; }
            if (!document.timeline) document.timeline = new window.DocumentTimeline();
            if (!document.getAnimations) document.getAnimations = function () { return []; };
        }
        // Font loading: FontFace members and a FontFaceSet class behind document.fonts
        if (window.FontFace && !('weight' in window.FontFace.prototype)) {
            var ffDefaults = { style: 'normal', weight: 'normal', stretch: 'normal', unicodeRange: 'U+0-10FFFF', variant: 'normal', featureSettings: 'normal', variationSettings: 'normal', display: 'auto', ascentOverride: 'normal', descentOverride: 'normal', lineGapOverride: 'normal' };
            for (var ffk in ffDefaults) if (ffDefaults.hasOwnProperty(ffk) && !(ffk in window.FontFace.prototype)) window.FontFace.prototype[ffk] = ffDefaults[ffk];
            if (!('features' in window.FontFace.prototype)) { window.FontFace.prototype.features = {}; window.FontFace.prototype.variations = {}; window.FontFace.prototype.palettes = {}; }
        }
        if (document.fonts && !window.FontFaceSet) {
            var FontFaceSet = function FontFaceSet() {};
            var fsProto = FontFaceSet.prototype;
            fsProto.add = function () { return this; }; fsProto['delete'] = function () { return false; }; fsProto.clear = noop; fsProto.has = function () { return false; };
            fsProto.load = function () { return resolved([]); }; fsProto.check = function () { return true; }; fsProto.forEach = noop; fsProto.entries = function () { return [].entries ? [].entries() : []; };
            fsProto.keys = fsProto.entries; fsProto.values = fsProto.entries; fsProto.addEventListener = noop; fsProto.removeEventListener = noop; fsProto.dispatchEvent = function () { return true; };
            fsProto.status = 'loaded'; fsProto.size = 0; fsProto.onloading = null; fsProto.onloadingdone = null; fsProto.onloadingerror = null;
            fsProto.ready = resolved({ status: 'loaded' });
            window.FontFaceSet = FontFaceSet;
            try { document.fonts.__proto__ = fsProto; } catch (e5) {}
            window.FontFaceSetLoadEvent = window.FontFaceSetLoadEvent || function FontFaceSetLoadEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, false, false); e.fontfaces = init && init.fontfaces || []; return e; };
        }
        if (window.Highlight && !window.Highlight.prototype.has) {
            var hp = window.Highlight.prototype;
            hp.has = function () { return false; }; hp.add = function () { return this; }; hp['delete'] = function () { return false; }; hp.clear = noop; hp.forEach = noop;
            hp.values = function () { return listIterator([]); }; hp.keys = hp.values; hp.entries = hp.values; hp.size = 0; hp.priority = 0; hp.type = 'highlight';
        }
        if (!window.CaretPosition) { window.CaretPosition = function CaretPosition() { this.offsetNode = null; this.offset = 0; }; window.CaretPosition.prototype.getClientRect = function () { return null; }; }
        if (!document.caretPositionFromPoint) document.caretPositionFromPoint = function (x, y) { var r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null; var c = new window.CaretPosition(); if (r) { c.offsetNode = r.startContainer; c.offset = r.startOffset; } return c; };
        if (!document.elementsFromPoint) document.elementsFromPoint = function (x, y) { var el = document.elementFromPoint(x, y), list = []; while (el) { list.push(el); el = el.parentElement; } return list; };
    } catch (eCSSOM) {}

    // ---- Language runtime extras
    if (!window.globalThis) try { window.globalThis = window; } catch (e) {}
    if (!window.queueMicrotask) window.queueMicrotask = function (cb) { if (P) P.resolve().then(cb); else setTimeout(cb, 0); };
    if (!window.WeakRef) { window.WeakRef = function WeakRef(target) { this.__t = target; }; window.WeakRef.prototype.deref = function () { return this.__t; }; }
    if (!window.FinalizationRegistry) { window.FinalizationRegistry = function FinalizationRegistry() {}; window.FinalizationRegistry.prototype.register = noop; window.FinalizationRegistry.prototype.unregister = noop; }
    if (!window.Atomics) window.Atomics = { add: function (a, i, v) { var o = a[i]; a[i] = o + v; return o; }, load: function (a, i) { return a[i]; }, store: function (a, i, v) { a[i] = v; return v; }, wait: function () { return 'not-equal'; }, notify: function () { return 0; }, isLockFree: function () { return true; } };
    if (!window.SharedArrayBuffer) window.SharedArrayBuffer = window.ArrayBuffer;
    if (!window.DOMMatrix) {
        window.DOMMatrix = window.WebKitCSSMatrix || function DOMMatrix() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; this.is2D = true; this.isIdentity = true; };
        window.DOMMatrixReadOnly = window.DOMMatrix;
    }
    if (!window.DOMPoint) { window.DOMPoint = function DOMPoint(x, y, z, w) { this.x = x || 0; this.y = y || 0; this.z = z || 0; this.w = w === undefined ? 1 : w; }; window.DOMPointReadOnly = window.DOMPoint; }
    if (!window.DOMRect) { window.DOMRect = function DOMRect(x, y, w, h) { this.x = x || 0; this.y = y || 0; this.width = w || 0; this.height = h || 0; this.top = this.y; this.left = this.x; this.right = this.x + this.width; this.bottom = this.y + this.height; }; window.DOMRectReadOnly = window.DOMRect; }
    if (!window.DOMQuad) window.DOMQuad = function DOMQuad() {};
    if (window.Notification && !window.Notification.prototype.close) { window.Notification.prototype.close = noop; window.Notification.prototype.addEventListener = noop; window.Notification.prototype.removeEventListener = noop; window.Notification.maxActions = 0; }
    if (!window.ErrorEvent) window.ErrorEvent = function ErrorEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, false, true); init = init || {}; e.message = init.message || ''; e.filename = init.filename || ''; e.lineno = init.lineno || 0; e.colno = init.colno || 0; e.error = init.error; return e; };
    if (!window.PromiseRejectionEvent) window.PromiseRejectionEvent = function PromiseRejectionEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, false, true); e.promise = init && init.promise; e.reason = init && init.reason; return e; };
    if (!window.PageTransitionEvent) window.PageTransitionEvent = function PageTransitionEvent() {};
    if (!window.BeforeUnloadEvent) window.BeforeUnloadEvent = function BeforeUnloadEvent() {};
    if (!window.PopStateEvent) window.PopStateEvent = function PopStateEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, false, false); e.state = init && init.state; return e; };
    if (!window.HashChangeEvent) window.HashChangeEvent = function HashChangeEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, false, false); e.oldURL = init && init.oldURL; e.newURL = init && init.newURL; return e; };
    if (!window.TransitionEvent && window.WebKitTransitionEvent) window.TransitionEvent = window.WebKitTransitionEvent;
    if (!window.AnimationEvent && window.WebKitAnimationEvent) window.AnimationEvent = window.WebKitAnimationEvent;
    if (!window.Animation) { window.Animation = function Animation() {}; window.KeyframeEffect = function KeyframeEffect() {}; window.DocumentTimeline = function DocumentTimeline() { this.currentTime = 0; }; document.timeline = document.timeline || new window.DocumentTimeline(); document.getAnimations = document.getAnimations || function () { return []; }; }
    if (!window.Worklet) { window.Worklet = function Worklet() {}; window.Worklet.prototype.addModule = function () { return resolved(); }; }
    var makeWorklet = function () { try { return new window.Worklet(); } catch (e) { return { addModule: function () { return resolved(); } }; } };   // a native Worklet cannot be constructed
    try { if (!window.CSS.paintWorklet) window.CSS.paintWorklet = makeWorklet(); } catch (e0) {}
    try { if (!window.CSS.animationWorklet) window.CSS.animationWorklet = makeWorklet(); } catch (e1) {}
    try { if (!window.CSS.layoutWorklet) window.CSS.layoutWorklet = makeWorklet(); } catch (e2) {}
    if (!window.CSS.highlights) { window.CSS.highlights = { set: noop, get: function () { return undefined; }, has: function () { return false; }, 'delete': function () { return false; }, clear: noop, size: 0 }; window.Highlight = function Highlight() {}; }
    if (!window.CSS.elementSources) window.CSS.elementSources = {};
    // ---- Styles that scripts insert (CSS-in-JS through insertRule, <style> elements created or filled at run time,
    // style-loader bundles) go through the same rewriter as the stylesheets the app fetched. A rule the rewriter turns
    // into several stays one rule (@media all { ... }), so libraries that count their rules keep their indexes.
    var runtimeCSS = (function () {
        var ruleCache = {}, ruleCacheSize = 0;
        var trimS = function (s) { return String(s).replace(/^\s+|\s+$/g, ''); };
        var syncTried = false;
        // the properties the page gives -webkit-calc() values and the ones it transitions (see guardCalcTransitions in
        // cssfix.js): the app's documents bring theirs in the manifest's vars, and every style rewritten here adds its
        // own (each insertRule is a document of its own for the rewriter)
        var runState = { ' calc': {}, ' trans': {} }, stateGen = 0;
        var noteState = function (vars) {
            if (!vars) return;
            for (var key in runState) {
                if (!runState.hasOwnProperty(key) || typeof vars[key] !== 'string') continue;
                var names = vars[key].split(' ');
                for (var i = 0; i < names.length; i++) if (names[i] && !runState[key][names[i]]) { runState[key][names[i]] = 1; stateGen++; }
            }
        };
        var withState = function (o) {
            for (var key in runState) {
                if (!runState.hasOwnProperty(key)) continue;
                var names = {}, list = [], n;
                if (typeof o[key] === 'string') { var had = o[key].split(' '); for (n = 0; n < had.length; n++) if (had[n]) names[had[n]] = 1; }
                for (n in runState[key]) if (runState[key].hasOwnProperty(n)) names[n] = 1;
                for (n in names) if (names.hasOwnProperty(n)) list.push(n);
                if (list.length) o[key] = list.join(' ');
            }
            return o;
        };
        var pageVars = function () {
            var pv = window.__brPageVars;
            if (!pv && !syncTried) {
                // a style inserted before the page manifest arrived: the page's custom properties are fetched now
                syncTried = true;
                try {
                    var x = new XMLHttpRequest();
                    x.open('GET', window.__brManifestURL || ('https://ios6-browser.invalid/manifest?doc=' + encodeURIComponent(location.href.split('#')[0])), false);
                    x.send(null);
                    var m = x.status === 200 || x.status === 0 ? JSON.parse(x.responseText) : null;
                    if (m) {
                        var names = [], cv = m.cv || [];
                        for (var i = 0; i < cv.length; i++) { var d = cv[i].d || []; for (var k = 0; k < d.length; k++) names.push(d[k][0]); if (cv[i].r) names.push(cv[i].r[0]); }
                        pv = window.__brPageVars = { vars: m.vars || {}, scoped: names.join(' ') };
                    }
                } catch (e) {}
            }
            // (kept while neither the page's variables nor the state changed: every style a script inserted and every
            // transition the shims set copied all the page's variables; the readers only read it)
            if (pvCache && pvCacheOf === pv && pvCacheGen === stateGen) return pvCache;
            var o = {};
            if (pv) {
                for (var k in pv.vars) if (pv.vars.hasOwnProperty(k)) o[k] = pv.vars[k];
                if (pv.scoped) o[' scoped'] = pv.scoped;
            }
            pvCache = withState(o);
            pvCacheOf = pv;
            pvCacheGen = stateGen;
            nameSets = {};
            return pvCache;
        };
        var pvCache = null, pvCacheOf = null, pvCacheGen = -1, nameSets = {};
        // A stylesheet of an emulated shadow root: every instance of a component brings the same text (Lit puts its
        // styles into each root; Reddit's 40 posts took a second each). It is rewritten once for a stand-in host that
        // each root's own id then replaces, in the output and in the manifest entries; unless entries whose classes are
        // hashed from their selectors name the host (:has(), @container...): such a text is rewritten for each root.
        var HOST_MARK = 'brhostmark', hostCache = {}, hostCacheN = 0;
        var hostSafe = function (manifest) {
            for (var k in manifest) if (manifest.hasOwnProperty(k) && k !== 'cv' && k !== 'vars' && JSON.stringify(manifest[k]).indexOf(HOST_MARK) >= 0) return false;
            return true;
        };
        var addEntries = function (add) { if (add && window.__brManifestAdd) { try { window.__brManifestAdd(add); } catch (e) {} } };
        // A big text goes to the app's rewriter, whose code is compiled and warm and which keeps what it did (a copy
        // loaded here took three times as long: Didomi's 64 KB consent styles 0.74 s on idnes.cz); a small one, or one
        // while the app is busy with the page's stylesheets, is done here.
        var APP_MIN = 4096;
        var runFix = function (css, pv, opts) {
            if (css.length >= APP_MIN) {
                try {
                    var x = new XMLHttpRequest();
                    x.open('POST', 'https://ios6-browser.invalid/cssrun', false);
                    x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');   // (without one the app got no body)
                    x.send(JSON.stringify([css, JSON.stringify(pv), JSON.stringify(opts)]));
                    if (x.status === 200 && x.responseText) return JSON.parse(x.responseText);
                } catch (e) {}
            }
            var lib = loadCSSFix();
            return lib && lib.run ? JSON.parse(lib.run('css', css, pv, opts)) : null;
        };
        var fixText = function (css, hostScope) {
            var pv = pageVars(), land = window.orientation === 90 || window.orientation === -90, ck = null;
            if (hostScope && css.length > 256) {
                ck = (land ? 'L|' : 'P|') + css;
                var hit = hostCache[ck];
                if (hit && hit.pv === pv) {
                    if (hit.add) addEntries(JSON.parse(hit.add.split(HOST_MARK).join(hostScope)));
                    return hit.out.split(HOST_MARK).join(hostScope);
                }
            }
            var r, vw = Math.min(screen.width || 768, screen.height || 1024), opts = { viewportWidth: vw, devicePixelRatio: window.devicePixelRatio || 1,
                orientation: land ? 'landscape' : 'portrait' };
            try {
                if (hostScope) opts.hostScope = ck !== null ? HOST_MARK : hostScope;   // (a stylesheet inside an emulated shadow root, see hostSelector)
                r = runFix(css, pv, opts);
                if (r && ck !== null && r.manifest && !hostSafe(r.manifest)) {
                    ck = null;
                    opts.hostScope = hostScope;
                    r = runFix(css, pv, opts);
                }
            } catch (e) { return null; }
            if (!r) return null;
            noteState(r.vars);
            // (with the custom properties this text defines, see extraVars)
            var add = r.manifest || null, rv = r.vars, defs = null;
            for (var vk in rv) if (rv.hasOwnProperty(vk) && vk.charAt(0) === '-' && vk.charAt(1) === '-') { if (!defs) defs = {}; defs[vk] = rv[vk]; }
            if (defs || (r.scoped && r.scoped.length)) { add = add || {}; if (defs) add.vars = defs; if (r.scoped && r.scoped.length) add.scoped = r.scoped; }
            // (the page-state and manifest comments close the output)
            var out = String(r.out || '').replace(/\n?\/\*br-(page|manifest):[\s\S]*$/, '');
            if (ck === null) { addEntries(add); return out; }
            var addText = add ? JSON.stringify(add) : null;
            if (out.length < 800000) {
                if (hostCacheN >= 24) { hostCache = {}; hostCacheN = 0; }
                if (!hostCache[ck]) hostCacheN++;
                hostCache[ck] = { pv: pv, out: out, add: addText };
            }
            if (addText) addEntries(JSON.parse(addText.split(HOST_MARK).join(hostScope)));
            return out.split(HOST_MARK).join(hostScope);
        };
        // top-level rules of a stylesheet text
        var splitRules = function (s) {
            var out = [], depth = 0, start = 0, q = null;
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
                if (c === '"' || c === "'") q = c;
                else if (c === '/' && s.charAt(i + 1) === '*') { var e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; }
                else if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) { out.push(trimS(s.slice(start, i + 1))); start = i + 1; } }
                else if (c === ';' && depth === 0) { var st = trimS(s.slice(start, i + 1)); if (st.length > 1) out.push(st); start = i + 1; }
            }
            return out;
        };
        var rewriteRule = function (text) {
            if (ruleCache.hasOwnProperty(text)) return ruleCache[text];
            var out = fixText(text), res = null;
            if (out !== null) {
                var parts = splitRules(out);
                if (!parts.length) res = '@media not all{}';   // nothing the engine can use, but the rule still counts
                else if (parts.length === 1) res = parts[0];
                else res = '@media all{' + parts.join('\n') + '}';
            }
            if (ruleCacheSize > 5000) { ruleCache = {}; ruleCacheSize = 0; }
            ruleCache[text] = res;
            ruleCacheSize++;
            return res;
        };
        // the page's properties with -webkit-calc() values / the transitioned ones as sets (for transitions scripts
        // set and values the shims set, see calcRisk)
        var nameSet = function (key) {
            var o = pageVars();
            if (nameSets.hasOwnProperty(key)) return nameSets[key];
            var set = {}, names = typeof o[key] === 'string' ? o[key].split(' ') : [];
            for (var i = 0; i < names.length; i++) if (names[i]) set[names[i]] = 1;
            return (nameSets[key] = set);
        };
        var calcSet = function () { return nameSet(' calc'); };
        var transSet = function () { return nameSet(' trans'); };
        return { fixText: fixText, rewriteRule: rewriteRule, calcSet: calcSet, transSet: transSet, splitRules: splitRules };
    })();
    if (window.CSSStyleSheet && window.CSSStyleSheet.prototype.insertRule && !window.CSSStyleSheet.prototype.__brWrapped) {
        // the old engine also requires the index argument; modern code omits it (append)
        window.CSSStyleSheet.prototype.__brWrapped = true;
        var origInsert = window.CSSStyleSheet.prototype.insertRule;
        window.__brNativeInsertRule = origInsert;   // (rules already rewritten by the app)
        window.CSSStyleSheet.prototype.insertRule = function (rule, index) {
            if (index === undefined) index = this.cssRules ? this.cssRules.length : 0;
            var text = String(rule), fixed = null;
            // @import/@charset/@namespace stay as they are; everything else is rewritten
            if (!/^\s*@(import|charset|namespace)\b/i.test(text)) { try { fixed = runtimeCSS.rewriteRule(text); } catch (e) { fixed = null; } }
            if (fixed !== null && fixed !== text) {
                try { return origInsert.call(this, fixed, index); } catch (e2) { /* the original text decides whether it throws */ }
            }
            return origInsert.call(this, text, index);
        };
        if (!window.CSSStyleSheet.prototype.deleteRule && window.CSSStyleSheet.prototype.removeRule) window.CSSStyleSheet.prototype.deleteRule = window.CSSStyleSheet.prototype.removeRule;
    }
    // <style> elements: the app's rewriter marked the ones it rewrote with a leading /*br*/; the others get their text
    // rewritten here, node by node (libraries append text nodes to one style element as they go)
    (function () {
        if (!window.MutationObserver) return;
        // server-rendered React pages (see REACT_SSR in cssfix.js): the text stays as sent, the app's rewritten CSS in
        // data-br-css goes rule by rule into a style element nested inside (no text of its own, so the element's
        // textContent is still what React rendered; its sheet sits where the element is in the cascade) and the
        // element's own sheet is switched off
        var shadowCSS = function (el) {
            var css = el.getAttribute('data-br-css');
            if (css === null) return false;
            el.removeAttribute('data-br-css');
            el.__brNative = true;
            if (!css) return true;
            var inner = document.createElement('style'), rules = runtimeCSS.splitRules(css), ins = window.__brNativeInsertRule || CSSStyleSheet.prototype.insertRule;
            inner.__brOwn = true;
            if (el.media) inner.setAttribute('media', el.media);
            el.appendChild(inner);
            var sheet = inner.sheet;
            for (var i = 0; sheet && i < rules.length; i++) { try { ins.call(sheet, rules[i], sheet.cssRules.length); } catch (e) {} }
            try { if (el.sheet) el.sheet.disabled = true; } catch (e2) {}
            el.__brShadow = inner;
            return true;
        };
        // rewritten by the app: its first text node starts with the marker (the parser splits long text into several),
        // or it came with data-br-css. A script that later gives it new text takes the nested sheet out with the old
        // children: that text is rewritten here like any other.
        var nativeStyle = function (el) {
            if (el.__brShadow && el.__brShadow.parentNode !== el) { el.__brShadow = null; el.__brNative = false; return false; }
            if (el.__brNative) return true;
            if (shadowCSS(el)) return true;
            var f = el.firstChild;
            if (f && f.nodeType === 3 && /^\s*\/\*br\*\//.test(f.data)) { el.__brNative = true; return true; }
            return false;
        };
        // the host of the emulated shadow root a style element sits in (it gets a data-br-host id), or null
        var hostSeq = 0;
        var shadowHost = function (el) {
            for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
                if (n.hasAttribute('data-shadow-root')) {
                    var host = n.host || n.parentNode;
                    if (!host || host.nodeType !== 1) return null;
                    if (!host.getAttribute('data-br-host')) host.setAttribute('data-br-host', 'h' + (++hostSeq));
                    return host.getAttribute('data-br-host');
                }
            }
            return null;
        };
        // The parser splits a long style text into nodes of 65,536 characters, cut anywhere (Didomi's 86 KB on idnes.cz
        // mid-selector): such pieces are rewritten as one text, which goes into the first; the others are emptied.
        // __brIn keeps what a node held before it was rewritten (only where it can matter).
        var PIECE = 65536;
        var sourceOf = function (n) { return n.__brOut === n.data && n.__brIn !== undefined ? n.__brIn : n.data; };
        var cutPieces = function (el) {
            for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nextSibling && sourceOf(n).length === PIECE) return true;
            return false;
        };
        var fixJoined = function (el) {
            var list = [], src = '', n, i, out = null;
            for (n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) { list.push(n); src += sourceOf(n); }
            el.__brJoined = true;
            if (!/[{:]/.test(src)) return;
            try { out = runtimeCSS.fixText(src, shadowHost(el)); } catch (e) { out = null; }
            if (out === null) return;
            for (i = 0; i < list.length; i++) {
                list[i].__brIn = i ? '' : src;
                list[i].__brOut = i ? '' : out;
                if (list[i].data !== list[i].__brOut) list[i].data = list[i].__brOut;
            }
        };
        var fixNode = function (node) {
            var data = node.data, el = node.parentNode;
            if (node.__brOut === data) return;
            if (el && el.nodeName === 'STYLE' && (el.__brJoined || ((node.nextSibling || node.previousSibling) && cutPieces(el)))) {
                if (!nativeStyle(el)) fixJoined(el);
                return;
            }
            if (!data || !/[{:]/.test(data)) return;
            if (el && nativeStyle(el)) return;
            var out = null;
            try { out = runtimeCSS.fixText(data, el ? shadowHost(el) : null); } catch (e) { out = null; }
            if (out === null) return;
            if (data.length === PIECE) node.__brIn = data;
            node.__brOut = out;
            if (out !== data) node.data = out;
        };
        var ownStyle = function (el) { return el.__brOwn || (el.id && el.id.indexOf('br-') === 0) || (el.type && !/^\s*(text\/css)?\s*$/i.test(el.type)); };
        // Identical copies of a big stylesheet: only the last one in document order stays on, the others are switched
        // off while it is there. Reddit renders its whole Tailwind (2,700 rules) into the declarative shadow root of
        // every component; the app rewrites those without a host, so all of them reach the whole page anyway: 40
        // copies, 110,000 rules the engine matched every element against (and the custom property pass walked).
        var DUP_MIN = 8192, dupGroups = {}, dupSeen = false;   // (dupSeen: some text had a copy; removals are looked at from then on)
        var dupElect = function (key) {
            var g = dupGroups[key], live = [], last = null, i, root = document.documentElement;
            if (!g) return;
            for (i = 0; i < g.els.length; i++) if (g.els[i].__brDupKey === key && root.contains(g.els[i])) live.push(g.els[i]);
            g.els = live;
            if (!live.length) { delete dupGroups[key]; return; }
            last = live[0];
            for (i = 1; i < live.length; i++) if (last.compareDocumentPosition(live[i]) & 4) last = live[i];
            for (i = 0; i < live.length; i++) {
                var el = live[i], sh = el.sheet;
                if (!sh) continue;
                // (only what this switched off comes on again: a sheet the page switched off stays so)
                if (el === last) { if (el.__brDupOff) { el.__brDupOff = false; sh.disabled = false; } }
                else if (!sh.disabled) { el.__brDupOff = true; sh.disabled = true; }
            }
        };
        var dupLeave = function (el) {
            var key = el.__brDupKey;
            if (!key) return;
            el.__brDupKey = null;
            if (el.__brDupOff) { el.__brDupOff = false; if (el.sheet) el.sheet.disabled = false; }
            dupElect(key);
        };
        var dupJoin = function (el) {
            if (el.__brShadow || el.hasAttribute('data-br-sheet') || el.hasAttribute('data-br-adopted')) return;
            var text = el.textContent || '', og = el.__brDupKey ? dupGroups[el.__brDupKey] : null;
            if (og && og.text === text) {
                // (moved: back in its group)
                if (og.els.indexOf(el) < 0) og.els.push(el);
                if (og.els.length > 1) dupElect(el.__brDupKey);
                return;
            }
            if (el.__brDupKey) dupLeave(el);
            if (text.length < DUP_MIN) return;
            var key = (el.getAttribute('media') || '') + '|' + text.length + '|' + text.slice(0, 120) + text.slice(-120), g = dupGroups[key];
            if (!g) g = dupGroups[key] = { text: text, els: [] };
            else if (g.text !== text) return;   // (the same length, start and end, another text: rare, left alone)
            el.__brDupKey = key;
            g.els.push(el);
            if (g.els.length > 1) { dupSeen = true; dupElect(key); }
        };
        var fixStyle = function (el) {
            if (ownStyle(el)) return;
            for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) fixNode(n);
            dupJoin(el);
        };
        var dupGone = function (n) {
            if (n.nodeType !== 1) return;
            if (n.nodeName === 'STYLE') { if (n.__brDupKey) dupElect(n.__brDupKey); return; }
            if (!n.getElementsByTagName) return;
            var inner = n.getElementsByTagName('style');
            for (var s = 0; s < inner.length; s++) if (inner[s].__brDupKey) dupElect(inner[s].__brDupKey);
        };
        var styleObserver = new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
                var rec = records[i], t = rec.target;
                if (rec.type === 'characterData') {
                    if (t.parentNode && t.parentNode.nodeName === 'STYLE' && !ownStyle(t.parentNode)) { fixNode(t); if (t.parentNode.__brDupKey) dupJoin(t.parentNode); }
                    continue;
                }
                var added = rec.addedNodes, removed = rec.removedNodes;
                for (var k = 0; k < added.length; k++) {
                    var a = added[k];
                    // (text a library appends to its style element rule by rule is not compared as it grows: only a
                    // copy's text that changes leaves its group)
                    if (a.nodeType === 3) { if (t.nodeName === 'STYLE' && !ownStyle(t)) { fixNode(a); if (t.__brDupKey) dupJoin(t); } continue; }
                    if (a.nodeType !== 1) continue;
                    if (a.nodeName === 'STYLE') fixStyle(a);
                    else if (a.getElementsByTagName) { var inner = a.getElementsByTagName('style'); for (var s = 0; s < inner.length; s++) fixStyle(inner[s]); }
                }
                if (dupSeen && removed) for (var r = 0; r < removed.length; r++) dupGone(removed[r]);
            }
        });
        try { styleObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (e) {}
        // (blocks the observer has not seen: parsed before it existed)
        var shadowScan = function () {
            var list = document.querySelectorAll ? document.querySelectorAll('style[data-br-css]') : [];
            for (var i = 0; i < list.length; i++) nativeStyle(list[i]);
        };
        shadowScan();
        document.addEventListener('DOMContentLoaded', shadowScan, false);
    })();
    // ---- constructable stylesheets: new CSSStyleSheet(), replace() / replaceSync(), document.adoptedStyleSheets (and
    // the emulated shadow roots' adoptedStyleSheets, see attachShadow). The old engine cannot construct a sheet
    // (vercel.com: "is not a constructor"), so each one is the sheet of a <style> element of ours, disabled (media
    // "not all") until the document adopts it; its rules go in through insertRule, which rewrites them like the page's
    // own. The document itself does not get the property on Document.prototype: Lit and similar libraries look there
    // and then keep using <style> elements in their shadow roots, which the shadow emulation handles.
    (function () {
        var Base = window.CSSStyleSheet;
        if (!Base || !Base.prototype || Base.__brConstructable) return;
        try { new Base(); return; } catch (e) {}   // (an engine that constructs them itself)
        var recordRule = function (sheet, text, index) {
            // (the text is kept for copies in shadow roots; rules only change through our methods)
            sheet.__brRules = sheet.__brRules || [];
            sheet.__brRules.splice(Math.min(index, sheet.__brRules.length), 0, String(text));
        };
        var copies = [];   // [{ sheet, style }] <style> copies in shadow roots
        var refreshCopies = function (sheet) {
            for (var i = 0; i < copies.length; i++) if (copies[i].sheet === sheet) copies[i].style.textContent = (sheet.__brRules || []).join('\n');
        };
        var methods = {
            insertRule: function (rule, index) {
                if (index === undefined) index = this.cssRules ? this.cssRules.length : 0;
                var r = Base.prototype.insertRule.call(this, rule, index);
                recordRule(this, rule, index);
                refreshCopies(this);
                return r;
            },
            deleteRule: function (index) {
                Base.prototype.deleteRule.call(this, index);
                if (this.__brRules) this.__brRules.splice(index, 1);
                refreshCopies(this);
            },
            replaceSync: function (text) {
                text = String(text === undefined || text === null ? '' : text).replace(/@import[^;]*;/gi, '');   // (not in constructed sheets)
                while (this.cssRules && this.cssRules.length) { try { Base.prototype.deleteRule.call(this, 0); } catch (e) { break; } }
                this.__brRules = [];
                var parts = runtimeCSS.splitRules(text);
                for (var i = 0; i < parts.length; i++) { try { methods.insertRule.call(this, parts[i], this.cssRules.length); } catch (e2) {} }
                refreshCopies(this);
            },
            replace: function (text) {
                try { this.replaceSync(text); return P.resolve(this); } catch (e) { return P.reject(e); }
            }
        };
        // (the old engine makes no sheet at all for a <style media="not all">: a sheet stays disabled until adopted)
        var Constructed = function CSSStyleSheet(options) {
            var style = ownStyleElement(), media = options && options.media;   // (its rules are rewritten one by one by insertRule)
            media = media ? String(media.mediaText !== undefined ? media.mediaText : media) : '';
            if (media) style.setAttribute('media', media);
            style.setAttribute('data-br-sheet', '');
            (document.head || document.documentElement).appendChild(style);
            var sheet = style.sheet;
            if (!sheet) throw new TypeError('The stylesheet could not be created');
            sheet.disabled = true;
            sheet.__brStyle = style;
            sheet.__brOff = !!(options && options.disabled);
            sheet.__brRules = [];
            // (its constructor property is the engine's own, whatever we set: lowered code asks __br_ctor, which reads
            // this; Stencil copies the rules of a sheet whose constructor is not window.CSSStyleSheet, rewritten ones)
            sheet.__brCtor = Constructed;
            for (var m in methods) if (methods.hasOwnProperty(m)) sheet[m] = methods[m];
            return sheet;
        };
        Constructed.prototype = Base.prototype;
        for (var k in Base) if (Base.hasOwnProperty(k)) Constructed[k] = Base[k];
        Constructed.__brConstructable = true;
        window.CSSStyleSheet = Constructed;
        // Sheets with :host rules that the DOCUMENT adopts: a library that did not take the emulated shadow root for one
        // (Stencil wants nodeType 11 and falls back to the document) meant them for the component it renders next. They
        // stay off in the document (their other rules would reach the whole page); the next emulated root that gets
        // children claims them for its host's tag, and every root of that tag gets <style> copies.
        var pendingHost = [], tagSheets = {}, versions = {};
        var isHostSheet = function (s) { return !!(s && s.__brRules && /:host\b/.test(s.__brRules.join('\n'))); };
        window.__brHostSheets = {
            forTag: function (tag) { return tagSheets[tag] || []; },
            claim: function (host) {
                if (!pendingHost.length || !host || !host.tagName) return;
                var tag = host.tagName.toLowerCase(), list = pendingHost;
                pendingHost = [];
                for (var i = 0; i < list.length; i++) list[i].__brClaimed = tag;
                tagSheets[tag] = (tagSheets[tag] || []).concat(list);
                versions[tag] = (versions[tag] || 0) + 1;
                var hosts = document.getElementsByTagName(tag);
                for (var h = 0; h < hosts.length; h++) if (hosts[h].shadowRoot) this.sync(hosts[h].shadowRoot, hosts[h]);
            },
            // a root that missed a claim (made before it, and out of the document then) catches up when it gets
            // children or its host is connected
            sync: function (root, host) {
                var v = host && host.tagName ? versions[host.tagName.toLowerCase()] : 0;
                if (!v || !root || root.__brTagVer === v || !root.__brRestyle) return;
                root.__brTagVer = v;
                root.__brRestyle();
            }
        };
        // adoption: our sheets are switched on in the document, the others stay as they are
        var adopted = [];
        var adopt = function (list) {
            var i, s;
            for (i = 0; i < adopted.length; i++) { s = adopted[i]; if (list.indexOf(s) < 0 && s && s.__brStyle) s.disabled = true; }
            for (i = 0; i < list.length; i++) {
                s = list[i];
                if (!s || !s.__brStyle) continue;
                if (isHostSheet(s)) {
                    s.disabled = true;
                    if (!s.__brClaimed && pendingHost.indexOf(s) < 0) pendingHost.push(s);
                } else s.disabled = !!s.__brOff;
            }
            adopted = list.slice();
            live.length = 0;
            Array.prototype.push.apply(live, adopted);
        };
        // (the property is an array scripts may also push to)
        var live = [];
        var mutator = function (name) { return function () { var copy = adopted.slice(); var r = Array.prototype[name].apply(copy, arguments); adopt(copy); return r; }; };
        var names = ['push', 'pop', 'shift', 'unshift', 'splice'];
        for (var n = 0; n < names.length; n++) { try { Object.defineProperty(live, names[n], { value: mutator(names[n]), configurable: true }); } catch (e3) {} }
        try {
            Object.defineProperty(document, 'adoptedStyleSheets', { configurable: true, get: function () { return live; }, set: function (v) { adopt(v ? Array.prototype.slice.call(v) : []); } });
        } catch (e4) {}
        // an emulated shadow root: a <style> inside it per adopted sheet, which the shadow emulation scopes to the host
        window.__brAdoptInto = function (root, list) {
            var keep = [], i;
            list = list ? Array.prototype.slice.call(list) : [];
            for (i = 0; i < copies.length; i++) {
                if (copies[i].root !== root) { keep.push(copies[i]); continue; }
                if (copies[i].style.parentNode) copies[i].style.parentNode.removeChild(copies[i].style);
            }
            copies = keep;
            for (i = 0; i < list.length; i++) {
                var sheet = list[i];
                if (!sheet || !sheet.__brRules) continue;
                var style = document.createElement('style');
                style.setAttribute('data-br-adopted', '');
                style.textContent = sheet.__brRules.join('\n');
                // (the engine's insertBefore: the root's own one claims pending component sheets)
                Node.prototype.insertBefore.call(root, style, root.firstChild);
                copies.push({ root: root, sheet: sheet, style: style });
            }
        };
    })();
    // ---- standard names for the -webkit- style properties and events. The old engine knows transform, transition,
    // animation, perspective, user-select... only prefixed (style.transform is a plain expando there and
    // setProperty('transform', ...) does nothing) and fires only webkitTransitionEnd / webkitAnimationStart|Iteration|End
    // (both checked on the device). React inline styles, Popper and sliders set style.transform, UI kits wait for
    // transitionend. So the style objects get accessors for the standard names (one on CSSStyleDeclaration.prototype
    // serves element and computed styles alike), setProperty() & co. take the dashed names, and every prefixed event is
    // followed by its standard twin on the same target (libraries that now find style.transition listen for those).
    // Transition values get the engine's property names, and while the page has -webkit-calc() lengths they leave
    // those properties out (see guardCalcTransitions in cssfix.js: such a transition crashes the engine).
    (function () {
        var CSDp = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype, probe = document.createElement('div').style;
        if (!CSDp || !probe || ('transform' in probe) || !('webkitTransform' in probe) || CSDp.__brStdNames) return;
        CSDp.__brStdNames = true;
        var NAMES = ['transform', 'transformOrigin', 'transformStyle', 'perspective', 'perspectiveOrigin', 'backfaceVisibility', 'transition',
            'transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'transitionDelay', 'animation', 'animationName', 'animationDuration',
            'animationTimingFunction', 'animationDelay', 'animationIterationCount', 'animationDirection', 'animationFillMode', 'animationPlayState',
            'userSelect', 'appearance', 'mask', 'maskImage', 'maskSize', 'maskPosition', 'maskRepeat', 'maskClip', 'maskOrigin', 'columns', 'columnCount',
            'columnGap', 'columnWidth', 'columnRule', 'columnRuleColor', 'columnRuleStyle', 'columnRuleWidth', 'columnSpan', 'columnFill',
            'hyphens', 'textSizeAdjust', 'fontFeatureSettings', 'fontKerning', 'boxDecorationBreak', 'textEmphasis', 'textEmphasisColor',
            'textEmphasisStyle', 'textEmphasisPosition', 'textStroke', 'textStrokeColor', 'textStrokeWidth', 'textFillColor', 'lineClamp',
            'tapHighlightColor', 'touchCallout', 'clipPath', 'shapeOutside', 'textOrientation', 'boxReflect', 'textCombineUpright'];
        var trim = function (s) { return String(s).trim(); };
        var dashed = function (camel) { return camel.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); };
        var camel = function (d) { return d.replace(/^-webkit-/, 'webkit-').replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }); };
        var DASHED = {};   // standard dashed name -> the prefixed one the engine knows
        var i, name, pref;
        for (i = 0; i < NAMES.length; i++) {
            name = NAMES[i];
            pref = 'webkit' + name.charAt(0).toUpperCase() + name.slice(1);
            if ((name in probe) || !(pref in probe)) continue;
            DASHED[dashed(name)] = '-webkit-' + dashed(name);
        }
        // transition lists: what `all` stands for while calc lengths are around (cssfix's list, see transitionAllList)
        var ANIMATABLE = ('background-color,border-top-color,border-right-color,border-bottom-color,border-left-color,border-top-left-radius,' +
            'border-top-right-radius,border-bottom-left-radius,border-bottom-right-radius,box-shadow,-webkit-box-shadow,clip,color,' +
            '-webkit-column-rule-color,-webkit-filter,fill,fill-opacity,flood-color,flood-opacity,lighting-color,max-height,opacity,' +
            'outline-color,outline-offset,outline-width,stop-color,stroke,stroke-opacity,stroke-width,-webkit-text-fill-color,' +
            '-webkit-text-stroke-color,text-shadow,-webkit-transform,-webkit-transform-origin,visibility,z-index,zoom,margin-top,margin-right,' +
            'margin-bottom,margin-left,padding-top,padding-right,padding-bottom,padding-left,border-top-width,border-right-width,' +
            'border-bottom-width,border-left-width,letter-spacing,word-spacing,font-size,line-height,text-indent,-webkit-background-size,' +
            '-webkit-perspective').split(',');
        var PARTS = { margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'], padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
            '-webkit-transform-origin': ['-webkit-transform-origin-x', '-webkit-transform-origin-y'], 'background-position': ['background-position-x', 'background-position-y'] };
        var WORDS = { ease: 1, linear: 1, 'ease-in': 1, 'ease-out': 1, 'ease-in-out': 1, 'step-start': 1, 'step-end': 1, initial: 1, inherit: 1, unset: 1,
            normal: 1, 'allow-discrete': 1 };
        var splitList = function (s) {
            var parts = [], depth = 0, start = 0;
            for (var k = 0; k < s.length; k++) {
                var c = s.charAt(k);
                if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth === 0) { parts.push(s.slice(start, k)); start = k + 1; }
            }
            parts.push(s.slice(start));
            return parts;
        };
        var calcHit = function (prop, calc) {
            if (calc[prop]) return true;
            var parts = PARTS[prop];
            if (parts) for (var k = 0; k < parts.length; k++) if (calc[parts[k]]) return true;
            return false;
        };
        // one property name as the engine knows it ('' when it knows none, null for `all`)
        var engineName = function (p) {
            p = p.toLowerCase();
            if (p === 'all') return null;
            if (DASHED[p]) return DASHED[p];
            if (p === 'filter') return '-webkit-filter';
            return camel(p) in probe && p.indexOf('--') !== 0 ? p : '';
        };
        // (the answer kept per value while the page's calc properties stay: the custom properties runtime sets the same
        // transition on thousands of elements, 0.2-0.5 ms each to take apart again)
        var safeCache = {}, safeCacheSize = 0, safeCacheCalc = null;
        var safeTransition = function (value, list) {
            if (value === null || value === undefined) return value;
            var s = String(value);
            if (!/[a-z]/i.test(s) || /^\s*(none|inherit|initial|unset|revert)\s*$/i.test(s)) return value;
            var calc = runtimeCSS.calcSet() || {};   // (no try here: a function with one makes a scope object per call)
            if (calc !== safeCacheCalc) { safeCache = {}; safeCacheSize = 0; safeCacheCalc = calc; }
            var key = (list ? 'L' : 'S') + s;
            if (safeCache.hasOwnProperty(key)) return safeCache[key];
            if (safeCacheSize++ > 400) { safeCache = {}; safeCacheSize = 0; }
            return (safeCache[key] = safeTransitionOf(s, list, calc, value));
        };
        var safeTransitionOf = function (s, list, calc, value) {
            var items = splitList(s), out = [], changed = false, allList = null;
            for (var k = 0; k < items.length; k++) {
                var item = trim(items[k]), toks = item.split(/\s+/), at = -1, j;
                if (list) at = 0;
                else for (j = 0; j < toks.length; j++) if (/^-{0,2}[a-z][\w-]*$/i.test(toks[j]) && !WORDS[toks[j].toLowerCase()]) { at = j; break; }
                var prop = at >= 0 ? toks[at] : 'all', en = engineName(prop);
                if (en === null) {
                    // `all`: the animatable properties without the ones holding calc lengths (unless there are none)
                    var anyCalc = false;
                    for (var c in calc) if (calc.hasOwnProperty(c)) { anyCalc = true; break; }
                    if (!anyCalc) { out.push(item); continue; }
                    if (!allList) { allList = []; for (j = 0; j < ANIMATABLE.length; j++) if (!calcHit(ANIMATABLE[j], calc)) allList.push(ANIMATABLE[j]); }
                    for (j = 0; j < allList.length; j++) {
                        var t2 = toks.slice(0);
                        if (at >= 0) t2[at] = allList[j]; else t2.unshift(allList[j]);
                        out.push(t2.join(' '));
                    }
                    changed = true;
                    continue;
                }
                if (en && calcHit(en, calc)) { changed = true; continue; }
                // a name the engine does not know would invalidate the whole list: a harmless one keeps the positions
                if (!en) en = '-webkit-user-select';
                if (en !== prop) { toks[at] = en; item = toks.join(' '); changed = true; }
                out.push(item);
            }
            return changed ? (out.length ? out.join(', ') : 'none') : value;
        };
        for (name in DASHED) {
            if (!DASHED.hasOwnProperty(name)) continue;
            (function (std, prefixed) {
                var guard = std === 'transition' ? 1 : std === 'transitionProperty' ? 2 : 0;
                try {
                    Object.defineProperty(CSDp, std, {
                        get: function () { return this[prefixed]; },
                        set: function (v) { this[prefixed] = guard ? safeTransition(v, guard === 2) : v; },
                        configurable: true
                    });
                } catch (e) {}
            })(camel(name), camel(DASHED[name]));
        }
        var origSet = CSDp.setProperty, origGet = CSDp.getPropertyValue, origRemove = CSDp.removeProperty, origPriority = CSDp.getPropertyPriority;
        // (DASHED without a prototype: a plain lookup, no hasOwnProperty call)
        var DASHED_N = Object.create(null);
        for (name in DASHED) if (DASHED.hasOwnProperty(name)) DASHED_N[name] = DASHED[name];
        var mapName = function (n) { return typeof n === 'string' ? DASHED_N[lowerName(n)] || null : null; };
        CSDp.setProperty = function (n, value, priority) {
            var m = mapName(n);
            if (!m) {
                // (only a name starting with a dash can be -webkit-transition: no regular expression for the rest)
                if (typeof n === 'string' && n.charCodeAt(0) === 45 && /^-webkit-transition(-property)?$/i.test(n)) return origSet.call(this, n, safeTransition(value, /property$/i.test(n)), priority || '');
                return origSet.call(this, n, value, priority || '');
            }
            if (m === '-webkit-transition' || m === '-webkit-transition-property') value = safeTransition(value, m === '-webkit-transition-property');
            return origSet.call(this, m, value, priority || '');
        };
        CSDp.getPropertyValue = function (n) { var m = mapName(n); return origGet.call(this, m || n); };
        CSDp.removeProperty = function (n) { var m = mapName(n); return origRemove.call(this, m || n); };
        if (origPriority) CSDp.getPropertyPriority = function (n) { var m = mapName(n); return origPriority.call(this, m || n); };
        // the standard twins of the prefixed events (bubbling like them, with their fields)
        if (!('ontransitionend' in window)) {
            var TWINS = { webkitTransitionEnd: 'transitionend', webkitAnimationStart: 'animationstart', webkitAnimationIteration: 'animationiteration',
                webkitAnimationEnd: 'animationend' };
            var twin = function (ev) {
                var type = TWINS[ev.type], target = ev.target;
                if (!type || !target || !target.dispatchEvent) return;
                var e = document.createEvent('Event');
                e.initEvent(type, true, type === 'transitionend');
                e.propertyName = ev.propertyName || '';
                e.animationName = ev.animationName || '';
                e.elapsedTime = ev.elapsedTime || 0;
                e.pseudoElement = '';
                try { target.dispatchEvent(e); } catch (x) {}
            };
            for (var t in TWINS) if (TWINS.hasOwnProperty(t)) window.addEventListener(t, twin, true);
        }
    })();
    if (!window.CSSLayerBlockRule) { window.CSSLayerBlockRule = function CSSLayerBlockRule() {}; window.CSSContainerRule = function CSSContainerRule() {}; window.CSSSupportsRule = window.CSSSupportsRule || function CSSSupportsRule() {}; }
    // ---- CSSOM interfaces the engine lacks, and the interface objects inheriting from their parents as WebIDL has it
    (function () {
        var define = function (name, parent) {
            if (window[name]) return;
            var C = function () { throw new TypeError('Illegal constructor'); };
            try { C.prototype = Object.create((window[parent] && window[parent].prototype) || Object.prototype); C.prototype.constructor = C; } catch (e) {}
            window[name] = C;
        };
        define('CSSGroupingRule', 'CSSRule');
        define('CSSConditionRule', 'CSSGroupingRule');
        define('CSSMarginRule', 'CSSRule');
        define('CSSNamespaceRule', 'CSSRule');
        define('CSSPageDescriptors', 'CSSStyleDeclaration');
        define('CSSStyleProperties', 'CSSStyleDeclaration');
        var chain = function (child, parent) {
            var C = window[child], Pa = window[parent];
            if (!C || !Pa || C === Pa) return;
            try { if (Object.getPrototypeOf(C) !== Pa) C.__proto__ = Pa; } catch (e) {}
        };
        var pairs = [['CSSStyleSheet', 'StyleSheet'], ['CSSGroupingRule', 'CSSRule'], ['CSSConditionRule', 'CSSGroupingRule'], ['CSSMediaRule', 'CSSConditionRule'],
            ['CSSSupportsRule', 'CSSConditionRule'], ['CSSContainerRule', 'CSSConditionRule'], ['CSSStyleRule', 'CSSGroupingRule'], ['CSSPageRule', 'CSSGroupingRule'],
            ['CSSMarginRule', 'CSSRule'], ['CSSNamespaceRule', 'CSSRule'], ['CSSImportRule', 'CSSRule'], ['CSSFontFaceRule', 'CSSRule'], ['CSSKeyframesRule', 'CSSRule'],
            ['CSSKeyframeRule', 'CSSRule'], ['CSSLayerBlockRule', 'CSSGroupingRule'], ['CSSPageDescriptors', 'CSSStyleDeclaration'], ['CSSStyleProperties', 'CSSStyleDeclaration']];
        for (var i = 0; i < pairs.length; i++) chain(pairs[i][0], pairs[i][1]);
        // style rules hold nested rules in the current CSSOM (the rewriter flattens nesting, so the list stays empty)
        var SRp = window.CSSStyleRule && window.CSSStyleRule.prototype;
        if (SRp && !('cssRules' in SRp)) try { Object.defineProperty(SRp, 'cssRules', { get: function () { return []; }, configurable: true }); } catch (e2) {}
    })();
    // ---- ElementInternals with custom states: states.add('x') puts the class br-state-x on the element, which the
    // rewriter substitutes for :state(x)
    if (Ep && !Ep.attachInternals) (function () {
        var CustomStateSet = function CustomStateSet(el) { this.__el = el; this.__s = []; };
        CustomStateSet.prototype = {
            constructor: CustomStateSet,
            add: function (s) { s = String(s).replace(/^--/, ''); if (this.__s.indexOf(s) < 0) { this.__s.push(s); setStateClass(this.__el, 'br-state-' + s, true); } return this; },
            'delete': function (s) { s = String(s).replace(/^--/, ''); var i = this.__s.indexOf(s); if (i < 0) return false; this.__s.splice(i, 1); setStateClass(this.__el, 'br-state-' + s, false); return true; },
            has: function (s) { return this.__s.indexOf(String(s).replace(/^--/, '')) >= 0; },
            clear: function () { while (this.__s.length) this['delete'](this.__s[0]); },
            forEach: function (fn, thisArg) { var l = this.__s.slice(); for (var i = 0; i < l.length; i++) fn.call(thisArg, l[i], l[i], this); },
            values: function () { return listIterator(this.__s.slice()); }, keys: function () { return listIterator(this.__s.slice()); },
            entries: function () { var out = []; for (var i = 0; i < this.__s.length; i++) out.push([this.__s[i], this.__s[i]]); return listIterator(out); }
        };
        try { Object.defineProperty(CustomStateSet.prototype, 'size', { get: function () { return this.__s.length; } }); } catch (e) {}
        if (window.Symbol && window.Symbol.iterator) CustomStateSet.prototype[window.Symbol.iterator] = CustomStateSet.prototype.values;
        var ElementInternals = function ElementInternals(el) {
            this.__el = el; this.states = new CustomStateSet(el); this.__value = null; this.__validity = { valid: true, customError: false };
            this.validationMessage = ''; this.role = null;
        };
        ElementInternals.prototype = {
            constructor: ElementInternals,
            setFormValue: function (value, state) { this.__value = value; this.__state = state; },
            setValidity: function (flags, message) {
                var v = { valid: true }, any = false;
                for (var k in flags) if (flags.hasOwnProperty(k) && flags[k]) { v[k] = true; any = true; }
                v.valid = !any;
                this.__validity = v;
                this.validationMessage = any ? String(message || '') : '';
            },
            checkValidity: function () { return this.__validity.valid; },
            reportValidity: function () { return this.__validity.valid; }
        };
        try {
            Object.defineProperty(ElementInternals.prototype, 'validity', { get: function () { return this.__validity; } });
            Object.defineProperty(ElementInternals.prototype, 'willValidate', { get: function () { return true; } });
            Object.defineProperty(ElementInternals.prototype, 'form', { get: function () { for (var n = this.__el.parentNode; n; n = n.parentNode) if (n.tagName === 'FORM') return n; return null; } });
            Object.defineProperty(ElementInternals.prototype, 'labels', { get: function () { return []; } });
            Object.defineProperty(ElementInternals.prototype, 'shadowRoot', { get: function () { return this.__el.shadowRoot || null; } });
        } catch (e2) {}
        Ep.attachInternals = function () {
            if (this.__brInternals) throw domException('NotSupportedError', 'ElementInternals already attached');
            this.__brInternals = new ElementInternals(this);
            return this.__brInternals;
        };
        window.ElementInternals = ElementInternals;
        window.CustomStateSet = CustomStateSet;
    })();
    // ---- Flex set by scripts. The old engine rejects display: flex and knows no flex property in element styles either
    // (checked on the device: setProperty('display', 'flex'), setAttribute('style', 'display:flex') and
    // style.justifyContent all left a block). These become the 2009-box forms cssfix.js writes: setProperty() and
    // setAttribute('style', ...) with flex values, and the flex properties scripts set by name (style.justifyContent,
    // which the engine does not know: an accessor here takes them). The boxes made so are found by the item marking
    // through their style attribute (see markFlexItems). A display assigned as style.display = 'flex' (or in cssText)
    // cannot be seen: the engine takes such an assignment itself, and the value is gone.
    (function () {
        var CSDp = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype, probe = document.createElement('div').style;
        if (!CSDp || !CSDp.setProperty || ('justifyContent' in probe) || CSDp.__brFlexStyles) return;
        CSDp.__brFlexStyles = true;
        var DISPLAY = { flex: '-webkit-box', 'inline-flex': '-webkit-inline-box', grid: 'block', 'inline-grid': 'inline-block', 'flow-root': 'block' };
        var PACK = { 'flex-start': 'start', start: 'start', left: 'start', normal: 'start', stretch: 'start', 'flex-end': 'end', end: 'end', right: 'end',
            center: 'center', 'space-between': 'justify', 'space-around': 'justify', 'space-evenly': 'justify' };
        var ALIGN = { 'flex-start': 'start', start: 'start', 'self-start': 'start', 'flex-end': 'end', end: 'end', 'self-end': 'end', center: 'center',
            baseline: 'baseline', stretch: 'stretch', normal: 'stretch' };
        // the flex properties by their dashed and script names, and the engine's properties each is written as
        var NAMES = { 'justify-content': 'justifyContent', 'align-items': 'alignItems', 'flex-direction': 'flexDirection', 'flex-wrap': 'flexWrap',
            'flex-flow': 'flexFlow', flex: 'flex', 'flex-grow': 'flexGrow', order: 'order' };
        var ENGINE = { 'justify-content': ['-webkit-box-pack'], 'align-items': ['-webkit-box-align'], 'flex-direction': ['-webkit-box-orient', '-webkit-box-direction'],
            'flex-wrap': ['-webkit-box-lines'], 'flex-flow': ['-webkit-box-orient', '-webkit-box-direction', '-webkit-box-lines'], flex: ['-webkit-box-flex'],
            'flex-grow': ['-webkit-box-flex'], order: ['-webkit-box-ordinal-group'] };
        var low = function (v) { return String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, '').toLowerCase(); };
        // [[name, value]...] the engine takes for one declaration, or null
        var boxForm = function (name, v) {
            var m, out;
            switch (name) {
                case 'display': return DISPLAY[v] ? [['display', DISPLAY[v]]] : null;
                case 'flex-direction':
                    return /^(row|column)(-reverse)?$/.test(v) ? [['-webkit-box-orient', v.indexOf('column') === 0 ? 'vertical' : 'horizontal'], ['-webkit-box-direction', /reverse/.test(v) ? 'reverse' : 'normal']] : null;
                case 'flex-wrap': return /^(wrap|nowrap|wrap-reverse)$/.test(v) ? [['-webkit-box-lines', v === 'nowrap' ? 'single' : 'multiple']] : null;
                case 'flex-flow':
                    out = [];
                    if ((m = /\b(row|column)(-reverse)?\b/.exec(v))) out = out.concat(boxForm('flex-direction', m[0]));
                    if ((m = /\b(nowrap|wrap-reverse|wrap)\b/.exec(v))) out = out.concat(boxForm('flex-wrap', m[0]));
                    return out.length ? out : null;
                case 'justify-content': return PACK[v] ? [['-webkit-box-pack', PACK[v]]] : null;
                case 'align-items': return ALIGN[v] ? [['-webkit-box-align', ALIGN[v]]] : null;
                case 'flex-grow': return /^\d*\.?\d+$/.test(v) ? [['-webkit-box-flex', v]] : null;
                case 'flex':
                    if (v === 'none') return [['-webkit-box-flex', '0']];
                    if (v === 'auto') return [['-webkit-box-flex', '1']];
                    return (m = /^(\d*\.?\d+)(\s|$)/.exec(v)) ? [['-webkit-box-flex', m[1]]] : null;
                case 'order': return /^-?\d+$/.test(v) ? [['-webkit-box-ordinal-group', String(Math.max(1, parseInt(v, 10) + 1))]] : null;
            }
            return null;
        };
        var origSet = CSDp.setProperty, origGet = CSDp.getPropertyValue, origRemove = CSDp.removeProperty;
        // (one flex declaration on a style object: its value kept for reading back, its box form written; an empty value
        // takes the box form away)
        var put = function (style, name, value, priority) {
            var v = low(value).replace(/\s*!\s*important$/, '');
            if (name !== 'display') {
                var vals = style.__brFlexVals || (style.__brFlexVals = {});
                vals[name] = v === '' ? '' : String(value);
            }
            if (v === '') {
                if (name === 'display') return false;
                var eng = ENGINE[name] || [];
                for (var i = 0; i < eng.length; i++) origRemove.call(style, eng[i]);
                return true;
            }
            var decls = boxForm(name, v);
            if (!decls) return name !== 'display';
            for (var k = 0; k < decls.length; k++) origSet.call(style, decls[k][0], decls[k][1], priority || '');
            return true;
        };
        // (the flex names without a prototype: a plain lookup; names lower-cased once, see lowerName)
        var FLEX_N = Object.create(null);
        for (var fn0 in NAMES) if (NAMES.hasOwnProperty(fn0)) FLEX_N[fn0] = NAMES[fn0];
        CSDp.setProperty = function (n, value, priority) {
            var name = typeof n === 'string' ? lowerName(n) : '';
            if ((name === 'display' || FLEX_N[name] !== undefined) && put(this, name, value, priority)) return;
            return origSet.call(this, n, value, priority || '');
        };
        CSDp.getPropertyValue = function (n) {
            var name = typeof n === 'string' ? lowerName(n) : '';
            if (FLEX_N[name] !== undefined) { var vals = this.__brFlexVals; return vals && vals[name] ? vals[name] : ''; }
            return origGet.call(this, n);
        };
        CSDp.removeProperty = function (n) {
            var name = typeof n === 'string' ? lowerName(n) : '';
            if (FLEX_N[name] !== undefined) { var old = this.getPropertyValue(name); put(this, name, '', ''); return old; }
            return origRemove.call(this, n);
        };
        var accessor = function (name) {
            return {
                get: function () { var vals = this.__brFlexVals; return vals && vals[name] ? vals[name] : ''; },
                set: function (v) { try { put(this, name, v, ''); } catch (e) {} },
                configurable: true
            };
        };
        for (var dn in NAMES) {
            if (!NAMES.hasOwnProperty(dn) || (NAMES[dn] in probe)) continue;
            try { Object.defineProperty(CSDp, NAMES[dn], accessor(dn)); } catch (e) {}
        }
        // style attributes set by scripts: each flex declaration followed by its box form (the original stays, for
        // reading back; the engine drops it)
        var splitDecls = function (s) {
            var out = [], depth = 0, q = null, start = 0;
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
                if (c === '"' || c === "'") q = c;
                else if (c === '(') depth++;
                else if (c === ')') depth--;
                else if (c === ';' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
            }
            out.push(s.slice(start));
            return out;
        };
        var fixStyleText = function (text) {
            var parts = splitDecls(text), changed = false, out = [];
            for (var i = 0; i < parts.length; i++) {
                var part = parts[i], colon = part.indexOf(':');
                if (colon < 0) { if (/\S/.test(part)) out.push(part); continue; }
                out.push(part);
                var name = low(part.slice(0, colon)), raw = part.slice(colon + 1), imp = /!\s*important\s*$/i.test(raw);
                if (name !== 'display' && !NAMES.hasOwnProperty(name)) continue;
                var decls = boxForm(name, low(raw).replace(/\s*!\s*important$/, ''));
                if (!decls) continue;
                for (var k = 0; k < decls.length; k++) out.push(decls[k][0] + ':' + decls[k][1] + (imp ? ' !important' : ''));
                changed = true;
            }
            return changed ? out.join(';') : null;
        };
        var Elp = window.Element && window.Element.prototype;
        if (Elp && Elp.setAttribute) {
            var origSetAttr = Elp.setAttribute;
            // (no arguments object: React sets every attribute through here)
            Elp.setAttribute = function (name, value) {
                if (typeof name === 'string' && name.length === 5 && name.toLowerCase() === 'style' && typeof value === 'string' && /flex|grid|order|justify|align-items/i.test(value)) {
                    var fixed = fixStyleText(value);
                    if (fixed !== null) return origSetAttr.call(this, name, fixed);
                }
                return origSetAttr.call(this, name, value);
            };
        }
    })();
    // ---- element.part: the tokens of the part attribute (what ::part() selects)
    if (Ep && !('part' in Ep)) try {
        Object.defineProperty(Ep, 'part', { configurable: true, get: function () {
            var el = this, tokens = function () { var v = el.getAttribute('part'); return v ? v.replace(/^\s+|\s+$/g, '').split(/\s+/) : []; };
            var write = function (list) { el.setAttribute('part', list.join(' ')); };
            return {
                get length() { return tokens().length; },
                get value() { return el.getAttribute('part') || ''; },
                set value(v) { el.setAttribute('part', v); },
                item: function (i) { var t = tokens(); return i < t.length ? t[i] : null; },
                contains: function (t) { return tokens().indexOf(t) >= 0; },
                add: function () { var t = tokens(); for (var i = 0; i < arguments.length; i++) if (t.indexOf(arguments[i]) < 0) t.push(arguments[i]); write(t); },
                remove: function () { var t = tokens(); for (var i = 0; i < arguments.length; i++) { var k = t.indexOf(arguments[i]); if (k >= 0) t.splice(k, 1); } write(t); },
                toggle: function (tok, force) { var has = this.contains(tok); if (force === true || (force === undefined && !has)) { this.add(tok); return true; } this.remove(tok); return false; },
                replace: function (a, b) { var t = tokens(), k = t.indexOf(a); if (k < 0) return false; t[k] = b; write(t); return true; },
                supports: function () { return true; },
                toString: function () { return el.getAttribute('part') || ''; }
            };
        } });
    } catch (e) {}
    // ---- CSS Font Loading: FontFace registers an @font-face rule and finds out when the engine has the font (a probe
    // string changes width once the web font replaces the fallback); document.fonts is a FontFaceSet of the faces added
    // by script, and load()/check() also reach the @font-face families of the stylesheets.
    if (!document.fonts && P) (function () {
        var FACE_DESCRIPTORS = { style: 'normal', weight: 'normal', stretch: 'normal', unicodeRange: 'U+0-10FFFF', variant: 'normal', featureSettings: 'normal',
            variationSettings: 'normal', display: 'auto', ascentOverride: 'normal', descentOverride: 'normal', lineGapOverride: 'normal' };
        var CSS_NAMES = { style: 'font-style', weight: 'font-weight', stretch: 'font-stretch', unicodeRange: 'unicode-range', variant: 'font-variant',
            featureSettings: 'font-feature-settings', variationSettings: 'font-variation-settings', display: 'font-display', ascentOverride: 'ascent-override',
            descentOverride: 'descent-override', lineGapOverride: 'line-gap-override' };
        var quoteFamily = function (f) { return '"' + String(f).replace(/^["']|["']$/g, '').replace(/"/g, '\\"') + '"'; };
        // resolves when text in `family` measures differently from the fallback (or after the timeout: same metrics)
        var whenRendered = function (family, style, weight, timeout) {
            return new P(function (res) {
                var probe = document.createElement('span'), base = document.createElement('span');
                var css = 'position:absolute;left:-9999px;top:0;visibility:hidden;font-size:72px;white-space:nowrap;font-style:' + (style || 'normal') + ';font-weight:' + (weight || 'normal') + ';';
                probe.style.cssText = css + 'font-family:' + quoteFamily(family) + ',monospace';
                base.style.cssText = css + 'font-family:monospace';
                probe.textContent = base.textContent = 'BESbswy 0123 WQ@&%';
                (document.body || document.documentElement).appendChild(probe);
                (document.body || document.documentElement).appendChild(base);
                var start = Date.now();
                var tick = function () {
                    var differs = probe.offsetWidth !== base.offsetWidth || probe.offsetHeight !== base.offsetHeight;
                    if (differs || Date.now() - start > (timeout || 3000)) {
                        probe.parentNode.removeChild(probe);
                        base.parentNode.removeChild(base);
                        res(differs);
                    } else setTimeout(tick, 50);
                };
                tick();
            });
        };
        var bytesToDataURL = function (src) {
            var bytes = src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset || 0, src.byteLength);
            var bin = '';
            for (var i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, Math.min(bytes.length, i + 8192))));
            return 'url(data:font/ttf;base64,' + btoa(bin) + ')';
        };
        var faces = null;
        var FontFace = function FontFace(family, source, descriptors) {
            var self = this;
            this.family = String(family).replace(/^["']|["']$/g, '');
            descriptors = descriptors || {};
            for (var k in FACE_DESCRIPTORS) if (FACE_DESCRIPTORS.hasOwnProperty(k)) this[k] = descriptors[k] !== undefined ? String(descriptors[k]) : FACE_DESCRIPTORS[k];
            this.status = 'unloaded';
            this.features = {}; this.variations = {}; this.palettes = [];
            this.__source = source && typeof source !== 'string' && (source instanceof ArrayBuffer || source.buffer) ? bytesToDataURL(source) : String(source || '');
            this.loaded = new P(function (res, rej) { self.__resolve = res; self.__reject = rej; });
            // binary data is there at once: such a face starts loading when it is constructed
            if (source && typeof source !== 'string') setTimeout(function () { self.load(); }, 0);
        };
        FontFace.prototype.load = function () {
            var self = this;
            if (faces && !faces.has(self)) faces.__list.push(self);
            if (self.status !== 'unloaded') return self.loaded;
            self.status = 'loading';
            var css = '@font-face{font-family:' + quoteFamily(self.family) + ';src:' + self.__source;
            for (var k in CSS_NAMES) if (CSS_NAMES.hasOwnProperty(k) && self[k] !== FACE_DESCRIPTORS[k]) css += ';' + CSS_NAMES[k] + ':' + self[k];
            addStyle(css + '}');
            whenRendered(self.family, self.style, self.weight, 5000).then(function (ok) {
                self.status = ok ? 'loaded' : 'error';
                if (ok) self.__resolve(self); else self.__reject(domException('NetworkError', 'font could not be loaded: ' + self.family));
                if (faces) faces.__changed();
            });
            if (faces) faces.__changed();
            return self.loaded;
        };
        // the families of the page's @font-face rules
        var cssFamilies = function () {
            var out = {};
            try {
                for (var s = 0; s < document.styleSheets.length; s++) {
                    var rules = null;
                    try { rules = document.styleSheets[s].cssRules; } catch (e) { rules = null; }
                    if (rules) for (var r = 0; r < rules.length; r++) if (rules[r].type === 5) { var f = rules[r].style.getPropertyValue('font-family'); if (f) out[f.replace(/^["']|["']$/g, '').toLowerCase()] = 1; }
                }
            } catch (e2) {}
            return out;
        };
        var familiesOf = function (font) {   // "bold 16px 'Foo Bar', serif" -> ['Foo Bar', 'serif']
            var m = /(?:^|\s)(?:[\d.]+(?:px|pt|em|rem|%|ex|vw|vh)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:\s*\/\s*\S+)?\s+(.+)$/i.exec(String(font));
            var list = m ? m[1] : String(font), out = [], parts = list.split(',');
            for (var i = 0; i < parts.length; i++) out.push(parts[i].replace(/^\s*["']?|["']?\s*$/g, ''));
            return out;
        };
        var FontFaceSet = function FontFaceSet() { this.__list = []; this.__l = {}; this.status = 'loaded'; this.onloading = null; this.onloadingdone = null; this.onloadingerror = null; this.__ready(); };
        FontFaceSet.prototype = {
            constructor: FontFaceSet,
            onloading: null, onloadingdone: null, onloadingerror: null,
            __ready: function () { var self = this; this.ready = new P(function (res) { self.__readyResolve = res; }); if (this.status === 'loaded') this.__readyResolve(this); },
            __fire: function (type, list) {
                var ev = new window.FontFaceSetLoadEvent(type, { fontfaces: list || [] });
                if (typeof this['on' + type] === 'function') try { this['on' + type](ev); } catch (e) {}
                var ls = (this.__l[type] || []).slice();
                for (var i = 0; i < ls.length; i++) try { ls[i].call(this, ev); } catch (e2) {}
            },
            __changed: function () {
                var loading = false, i;
                for (i = 0; i < this.__list.length; i++) if (this.__list[i].status === 'loading') loading = true;
                if (loading && this.status !== 'loading') { this.status = 'loading'; this.__ready(); this.__fire('loading'); }
                else if (!loading && this.status === 'loading') {
                    this.status = 'loaded';
                    var done = [], failed = [];
                    for (i = 0; i < this.__list.length; i++) (this.__list[i].status === 'error' ? failed : done).push(this.__list[i]);
                    this.__fire('loadingdone', done);
                    if (failed.length) this.__fire('loadingerror', failed);
                    this.__readyResolve(this);
                }
            },
            add: function (face) { if (this.__list.indexOf(face) < 0) this.__list.push(face); if (face.status === 'loading') this.__changed(); return this; },
            'delete': function (face) { var i = this.__list.indexOf(face); if (i < 0) return false; this.__list.splice(i, 1); return true; },
            clear: function () { this.__list = []; },
            has: function (face) { return this.__list.indexOf(face) >= 0; },
            forEach: function (fn, thisArg) { var l = this.__list.slice(); for (var i = 0; i < l.length; i++) fn.call(thisArg, l[i], l[i], this); },
            // (set-like: iterators, not arrays; Google walks document.fonts.keys() with next())
            values: function () { return listIterator(this.__list.slice()); },
            keys: function () { return listIterator(this.__list.slice()); },
            entries: function () { var out = []; for (var i = 0; i < this.__list.length; i++) out.push([this.__list[i], this.__list[i]]); return listIterator(out); },
            addEventListener: function (t, f) { (this.__l[t] = this.__l[t] || []).push(f); },
            removeEventListener: function (t, f) { var l = this.__l[t] || [], i = l.indexOf(f); if (i >= 0) l.splice(i, 1); },
            dispatchEvent: function (e) { this.__fire(e.type); return true; },
            // the script faces of the font's families are loaded; @font-face families of the stylesheets load when used,
            // so they are drawn once off screen and waited for
            load: function (font) {
                var fams = familiesOf(font), css = cssFamilies(), waits = [], found = [], self = this;
                for (var i = 0; i < fams.length; i++) {
                    var lf = fams[i].toLowerCase();
                    for (var k = 0; k < self.__list.length; k++) if (self.__list[k].family.toLowerCase() === lf) { found.push(self.__list[k]); waits.push(self.__list[k].load()); }
                    if (css[lf]) waits.push(whenRendered(fams[i], /italic|oblique/i.test(font) ? 'italic' : 'normal', /\bbold\b|\b[6-9]00\b/.test(font) ? 'bold' : 'normal', 3000));
                }
                return P.all(waits).then(function () { return found; });
            },
            check: function (font) {
                var fams = familiesOf(font);
                for (var i = 0; i < fams.length; i++) for (var k = 0; k < this.__list.length; k++) if (this.__list[k].family.toLowerCase() === fams[i].toLowerCase() && this.__list[k].status !== 'loaded') return false;
                return true;
            }
        };
        try { Object.defineProperty(FontFaceSet.prototype, 'size', { get: function () { return this.__list.length; } }); } catch (e) {}
        if (window.Symbol && window.Symbol.iterator) FontFaceSet.prototype[window.Symbol.iterator] = FontFaceSet.prototype.values;
        window.FontFaceSetLoadEvent = function FontFaceSetLoadEvent(type, init) {
            var e = document.createEvent('Event');
            e.initEvent(type, false, false);
            e.fontfaces = (init && init.fontfaces) || [];
            return e;
        };
        for (var d in FACE_DESCRIPTORS) if (FACE_DESCRIPTORS.hasOwnProperty(d)) FontFace.prototype[d] = FACE_DESCRIPTORS[d];
        FontFace.prototype.family = ''; FontFace.prototype.status = 'unloaded'; FontFace.prototype.features = null; FontFace.prototype.variations = null; FontFace.prototype.palettes = null;
        window.FontFace = FontFace;
        window.FontFaceSet = FontFaceSet;
        faces = new FontFaceSet();
        try { Object.defineProperty(document, 'fonts', { value: faces, configurable: true }); } catch (e3) { document.fonts = faces; }
    })();
    if (!window.ScreenOrientation) window.ScreenOrientation = function ScreenOrientation() {};
    if (window.screen && window.screen.orientation && !window.screen.orientation.lock) { window.screen.orientation.lock = rejectWith('NotSupportedError', 'Orientation lock is not available'); window.screen.orientation.unlock = noop; }
    if (!window.CloseEvent) window.CloseEvent = function CloseEvent(type, init) { var e = document.createEvent('Event'); e.initEvent(type, false, false); init = init || {}; e.wasClean = !!init.wasClean; e.code = init.code || 0; e.reason = init.reason || ''; return e; };
    if (!window.MessageChannel) {
        window.MessagePort = function MessagePort() { this.onmessage = null; this.__peer = null; this.__l = []; };
        window.MessagePort.prototype = {
            postMessage: function (data) { var peer = this.__peer; if (!peer) return; setTimeout(function () { var ev = { type: 'message', data: data, ports: [], target: peer }; if (peer.onmessage) peer.onmessage(ev); for (var i = 0; i < peer.__l.length; i++) peer.__l[i](ev); }, 0); },
            start: noop, close: noop, addEventListener: function (t, f) { if (t === 'message') this.__l.push(f); }, removeEventListener: function (t, f) { var i = this.__l.indexOf(f); if (i >= 0) this.__l.splice(i, 1); }
        };
        window.MessageChannel = function MessageChannel() { this.port1 = new window.MessagePort(); this.port2 = new window.MessagePort(); this.port1.__peer = this.port2; this.port2.__peer = this.port1; };
    }
    // new Request(request, {body}) and fetch(request, {body}): the new body replaces the old one, which stays unread, as
    // the standard has it; the fetch polyfill (whatwg-fetch) throws "Already read" when the old body was read and marks it
    // read when the new body is "". Its clone() of a request whose body is "" marked the original read too, and fetch()
    // of it then threw (TikTok's privacy layer clones every request, its client posts body "": "Feature access control
    // initialization error TypeError: Already read")
    (function () {
        var R = window.Request, F = window.fetch;
        if (!R || !F || !F.polyfill || R.__brReplaced) return;
        var clone = R.prototype.clone;
        if (clone) R.prototype.clone = function () {
            var used = this.bodyUsed, c = clone.call(this);
            if (!used && this.bodyUsed) this.bodyUsed = false;
            return c;
        };
        var replaced = function (input, init) {
            if (!(input instanceof R) || !init || init.body === undefined || init.body === null) return null;
            var copy = { method: input.method, headers: input.headers, credentials: input.credentials, mode: input.mode, signal: input.signal, referrer: input.referrer };
            for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k) && init[k] !== undefined) copy[k] = init[k];
            return [input.url, copy];
        };
        var Request = function Request(input, init) {
            var r = replaced(input, init);
            return r ? new R(r[0], r[1]) : new R(input, init);
        };
        Request.prototype = R.prototype;
        Request.__brReplaced = true;
        var fetch = function fetch(input, init) {
            var r = replaced(input, init);
            return r ? F.call(this, r[0], r[1]) : F.call(this, input, init);
        };
        fetch.polyfill = true;
        window.Request = Request;
        window.fetch = fetch;
    })();
    // postMessage(message, {transfer}) and window.postMessage(message, {targetOrigin, transfer}): the old engine knows
    // the transfer list and the target origin as plain arguments only (Windy's workers got "Type error"), and a window's
    // target origin is required there. A transfer the engine refuses is left out: the data goes as a copy.
    (function () {
        var plainObject = function (x) { return !!x && typeof x === 'object' && !(x instanceof Array) && typeof x.length !== 'number'; };
        // (the try in a function of its own: setImmediate polyfills post a message per task, and a try costs every call)
        var withTransfer = function (orig, self, msg, origin, list, isWindow) {
            try { return isWindow ? orig.call(self, msg, origin, list) : orig.call(self, msg, list); }
            catch (e) { return isWindow ? orig.call(self, msg, origin) : orig.call(self, msg); }
        };
        var fixPost = function (owner, isWindow) {
            var orig = owner && owner.postMessage;
            if (typeof orig !== 'function' || orig.__brPost) return;
            var wrapped = function (msg, a2, a3) {
                var transfer = isWindow ? a3 : a2, origin = isWindow ? a2 : undefined, self = this || window;
                if (plainObject(a2)) { transfer = a2.transfer; if (isWindow) origin = a2.targetOrigin; }
                if (isWindow && (origin === undefined || origin === null)) origin = '/';
                if (transfer && transfer.length) return withTransfer(orig, self, msg, origin, transfer, isWindow);
                return isWindow ? orig.call(self, msg, origin) : orig.call(self, msg);
            };
            wrapped.__brPost = true;
            try { owner.postMessage = wrapped; } catch (e) {}
        };
        if (window.Worker && window.Worker.prototype) fixPost(window.Worker.prototype, false);
        if (window.MessagePort && window.MessagePort.prototype) fixPost(window.MessagePort.prototype, false);
        fixPost(window, true);
    })();

    // ---- CSS Typed OM (css-typed-om-1): a working subset. Values parse into CSSUnitValue / CSSKeywordValue /
    // CSSMathSum ... / CSSTransformValue / CSSRGB / CSSImageValue / CSSUnparsedValue, computedStyleMap() and
    // attributeStyleMap wrap the style declarations, and CSS.px() & co. make unit values.
    // Set up on first use (a page touches it through CSS.px() & co., an element's computedStyleMap / attributeStyleMap
    // or one of the main interface objects): compiling and running the setup took 8-11 ms of every page.
    var typedOMSetup = null;
    var TYPED_OM_UNITS = ['number', 'percent', 'em', 'ex', 'ch', 'ic', 'rem', 'lh', 'rlh', 'vw', 'vh', 'vi', 'vb', 'vmin', 'vmax', 'svw', 'svh', 'svi', 'svb', 'svmin',
        'svmax', 'lvw', 'lvh', 'lvi', 'lvb', 'lvmin', 'lvmax', 'dvw', 'dvh', 'dvi', 'dvb', 'dvmin', 'dvmax', 'cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax', 'cm', 'mm',
        'Q', 'in', 'pt', 'pc', 'px', 'deg', 'grad', 'rad', 'turn', 's', 'ms', 'Hz', 'kHz', 'dpi', 'dpcm', 'dppx', 'fr', 'cap', 'rcap', 'rex', 'rch', 'ric'];
    if (!window.CSSStyleValue || !window.CSSStyleValue.parse) typedOMSetup = function () { try { (function () {
        // instances inherit through the prototypes, the interface objects themselves as WebIDL (and class extends) have it
        var extend = function (Child, Parent) { Child.prototype = Object.create(Parent.prototype); Child.prototype.constructor = Child; try { Child.__proto__ = Parent; } catch (e) {} return Child; };
        var UNIT_SUFFIX = { number: '', percent: '%' };
        var unitText = function (unit) { return UNIT_SUFFIX.hasOwnProperty(unit) ? UNIT_SUFFIX[unit] : unit; };
        var CSSStyleValue = function CSSStyleValue() {};
        CSSStyleValue.prototype.toString = function () { return this.__css || ''; };
        var CSSKeywordValue = extend(function CSSKeywordValue(value) { this.value = String(value); }, CSSStyleValue);
        CSSKeywordValue.prototype.value = '';
        CSSKeywordValue.prototype.toString = function () { return this.value; };
        var CSSVariableReferenceValue = extend(function CSSVariableReferenceValue(variable, fallback) { this.variable = String(variable); this.fallback = fallback || null; }, CSSStyleValue);
        CSSVariableReferenceValue.prototype.variable = ''; CSSVariableReferenceValue.prototype.fallback = null;
        CSSVariableReferenceValue.prototype.toString = function () { return 'var(' + this.variable + (this.fallback ? ',' + this.fallback : '') + ')'; };
        var listMethods = function (proto) {
            proto.length = 0;
            proto.forEach = function (fn, thisArg) { for (var i = 0; i < this.length; i++) fn.call(thisArg, this[i], i, this); };
            proto.entries = function () { var a = []; for (var i = 0; i < this.length; i++) a.push([i, this[i]]); return a; };
            proto.keys = function () { var a = []; for (var i = 0; i < this.length; i++) a.push(i); return a; };
            proto.values = function () { var a = []; for (var i = 0; i < this.length; i++) a.push(this[i]); return a; };
        };
        var fillList = function (self, items) { for (var i = 0; i < items.length; i++) self[i] = items[i]; self.length = items.length; };
        var CSSUnparsedValue = extend(function CSSUnparsedValue(members) { fillList(this, members || []); }, CSSStyleValue);
        listMethods(CSSUnparsedValue.prototype);
        CSSUnparsedValue.prototype.toString = function () { return this.values().join(''); };
        var CSSNumericArray = function CSSNumericArray(items) { fillList(this, items || []); };
        listMethods(CSSNumericArray.prototype);
        // numeric values
        var CSSNumericValue = extend(function CSSNumericValue() {}, CSSStyleValue);
        var toNumeric = function (v) { return typeof v === 'number' ? new CSSUnitValue(v, 'number') : v; };
        var numericArgs = function (args) { var out = []; for (var i = 0; i < args.length; i++) out.push(toNumeric(args[i])); return out; };
        CSSNumericValue.prototype.add = function () { var a = numericArgs(arguments); if (this instanceof CSSUnitValue && a.length === 1 && a[0] instanceof CSSUnitValue && a[0].unit === this.unit) return new CSSUnitValue(this.value + a[0].value, this.unit); return new CSSMathSum([this].concat(a)); };
        CSSNumericValue.prototype.sub = function () { var a = numericArgs(arguments); if (this instanceof CSSUnitValue && a.length === 1 && a[0] instanceof CSSUnitValue && a[0].unit === this.unit) return new CSSUnitValue(this.value - a[0].value, this.unit); var neg = []; for (var i = 0; i < a.length; i++) neg.push(new CSSMathNegate(a[i])); return new CSSMathSum([this].concat(neg)); };
        CSSNumericValue.prototype.mul = function () { var a = numericArgs(arguments); if (this instanceof CSSUnitValue && a.length === 1 && a[0] instanceof CSSUnitValue && (a[0].unit === 'number' || this.unit === 'number')) return new CSSUnitValue(this.value * a[0].value, this.unit === 'number' ? a[0].unit : this.unit); return new CSSMathProduct([this].concat(a)); };
        CSSNumericValue.prototype.div = function () { var a = numericArgs(arguments); if (this instanceof CSSUnitValue && a.length === 1 && a[0] instanceof CSSUnitValue && a[0].unit === 'number' && a[0].value !== 0) return new CSSUnitValue(this.value / a[0].value, this.unit); var inv = []; for (var i = 0; i < a.length; i++) inv.push(new CSSMathInvert(a[i])); return new CSSMathProduct([this].concat(inv)); };
        CSSNumericValue.prototype.min = function () { return new CSSMathMin([this].concat(numericArgs(arguments))); };
        CSSNumericValue.prototype.max = function () { return new CSSMathMax([this].concat(numericArgs(arguments))); };
        CSSNumericValue.prototype.equals = function () { for (var i = 0; i < arguments.length; i++) if (String(toNumeric(arguments[i])) !== String(this)) return false; return true; };
        var ABS = { px: 1, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, 'in': 96, pt: 4 / 3, pc: 16, deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360, s: 1000, ms: 1, hz: 1, khz: 1000, dpi: 1, dpcm: 2.54, dppx: 96 };
        var CANON = { px: 'px', cm: 'px', mm: 'px', q: 'px', 'in': 'px', pt: 'px', pc: 'px', deg: 'deg', grad: 'deg', rad: 'deg', turn: 'deg', s: 'ms', ms: 'ms', hz: 'hz', khz: 'hz', dpi: 'dpi', dpcm: 'dpi', dppx: 'dpi' };
        CSSNumericValue.prototype.to = function (unit) {
            if (!(this instanceof CSSUnitValue)) throw new TypeError('Cannot convert a math value');
            var from = this.unit.toLowerCase(), to = String(unit).toLowerCase();
            if (from === to) return new CSSUnitValue(this.value, unit);
            if (!ABS.hasOwnProperty(from) || !ABS.hasOwnProperty(to) || CANON[from] !== CANON[to]) throw new TypeError('Incompatible units');
            return new CSSUnitValue(this.value * ABS[from] / ABS[to], unit);
        };
        CSSNumericValue.prototype.toSum = function () { var s = new CSSMathSum([this]); if (arguments.length) { var vals = []; for (var i = 0; i < arguments.length; i++) vals.push(this.to(arguments[i])); s = new CSSMathSum(vals); } return s; };
        var TYPE_OF = { px: 'length', em: 'length', rem: 'length', vw: 'length', vh: 'length', cm: 'length', mm: 'length', 'in': 'length', pt: 'length', pc: 'length', percent: 'percent', deg: 'angle', rad: 'angle', turn: 'angle', grad: 'angle', s: 'time', ms: 'time', hz: 'frequency', khz: 'frequency', dpi: 'resolution', dppx: 'resolution', fr: 'flex' };
        CSSNumericValue.prototype.type = function () { var t = {}; if (this instanceof CSSUnitValue && TYPE_OF[this.unit.toLowerCase()]) t[TYPE_OF[this.unit.toLowerCase()]] = 1; return t; };
        CSSNumericValue.parse = function (text) { var v = parseValue(String(text)); if (!(v instanceof CSSNumericValue)) throw new SyntaxError('Not a numeric value'); return v; };
        var CSSUnitValue = extend(function CSSUnitValue(value, unit) { this.value = Number(value); this.unit = String(unit); }, CSSNumericValue);
        CSSUnitValue.prototype.value = 0; CSSUnitValue.prototype.unit = '';
        CSSUnitValue.prototype.toString = function () { return this.value + unitText(this.unit); };
        var CSSMathValue = extend(function CSSMathValue() {}, CSSNumericValue);
        CSSMathValue.prototype.operator = '';
        // "calc(100% - 20px)": negated terms and inverted factors serialise with - and /, nested sums in parentheses
        var mathBody = function (m) {
            var parts = m.values.values(), s = '';
            for (var i = 0; i < parts.length; i++) {
                var v = parts[i];
                if (m.operator === 'sum') s += (v instanceof CSSMathNegate ? (i ? ' - ' : '-') + mathTerm(v.value) : (i ? ' + ' : '') + mathTerm(v));
                else s += (v instanceof CSSMathInvert ? (i ? ' / ' : '1 / ') + mathTerm(v.value) : (i ? ' * ' : '') + mathTerm(v));
            }
            return s;
        };
        var mathTerm = function (v) { return (v instanceof CSSMathSum || v instanceof CSSMathProduct) ? '(' + mathBody(v) + ')' : String(v); };
        var mathList = function (name, operator, joiner) {
            var C = extend(function (values) { this.values = new CSSNumericArray(numericArgs(values && values.length !== undefined && !(values instanceof CSSStyleValue) ? values : arguments)); }, CSSMathValue);
            C.prototype.operator = operator; C.prototype.values = null;
            C.prototype.toString = function () { return joiner ? 'calc(' + mathBody(this) + ')' : operator + '(' + this.values.values().join(', ') + ')'; };
            try { Object.defineProperty(C, 'name', { value: name }); } catch (e) {}
            return C;
        };
        var CSSMathSum = mathList('CSSMathSum', 'sum', ' + ');
        var CSSMathProduct = mathList('CSSMathProduct', 'product', ' * ');
        var CSSMathMin = mathList('CSSMathMin', 'min', null);
        var CSSMathMax = mathList('CSSMathMax', 'max', null);
        var CSSMathNegate = extend(function CSSMathNegate(value) { this.value = toNumeric(value); }, CSSMathValue);
        CSSMathNegate.prototype.operator = 'negate'; CSSMathNegate.prototype.value = null;
        CSSMathNegate.prototype.toString = function () { return '-' + this.value; };
        var CSSMathInvert = extend(function CSSMathInvert(value) { this.value = toNumeric(value); }, CSSMathValue);
        CSSMathInvert.prototype.operator = 'invert'; CSSMathInvert.prototype.value = null;
        CSSMathInvert.prototype.toString = function () { return '1 / ' + this.value; };
        var CSSMathClamp = extend(function CSSMathClamp(lower, value, upper) { this.lower = toNumeric(lower); this.value = toNumeric(value); this.upper = toNumeric(upper); }, CSSMathValue);
        CSSMathClamp.prototype.operator = 'clamp'; CSSMathClamp.prototype.lower = null; CSSMathClamp.prototype.value = null; CSSMathClamp.prototype.upper = null;
        CSSMathClamp.prototype.toString = function () { return 'clamp(' + this.lower + ', ' + this.value + ', ' + this.upper + ')'; };
        // transforms
        var CSSTransformComponent = function CSSTransformComponent() {};
        CSSTransformComponent.prototype.is2D = true;
        CSSTransformComponent.prototype.toMatrix = function () { var M = window.DOMMatrix; try { return new M(this.toString()); } catch (e) { return new M(); } };
        var component = function (name, fields, build) {
            var C = extend(function () { for (var i = 0; i < fields.length; i++) this[fields[i]] = arguments[i] === undefined ? null : arguments[i]; if (build.init) build.init.apply(this, arguments); }, CSSTransformComponent);
            for (var f = 0; f < fields.length; f++) C.prototype[fields[f]] = null;
            C.prototype.toString = build.text;
            try { Object.defineProperty(C, 'name', { value: name }); } catch (e) {}
            return C;
        };
        var num0 = function (v) { return v === null || v === undefined ? new CSSUnitValue(0, 'px') : toNumeric(v); };
        var CSSTranslate = component('CSSTranslate', ['x', 'y', 'z'], { init: function () { this.z = this.z === null ? new CSSUnitValue(0, 'px') : this.z; this.is2D = String(this.z) === '0px'; }, text: function () { return this.is2D ? 'translate(' + num0(this.x) + ', ' + num0(this.y) + ')' : 'translate3d(' + num0(this.x) + ', ' + num0(this.y) + ', ' + this.z + ')'; } });
        var CSSRotate = component('CSSRotate', ['x', 'y', 'z', 'angle'], { init: function () { if (arguments.length === 1) { this.angle = arguments[0]; this.x = 0; this.y = 0; this.z = 1; this.is2D = true; } else this.is2D = false; }, text: function () { return this.is2D ? 'rotate(' + this.angle + ')' : 'rotate3d(' + this.x + ', ' + this.y + ', ' + this.z + ', ' + this.angle + ')'; } });
        var CSSScale = component('CSSScale', ['x', 'y', 'z'], { init: function () { if (this.z === null) { this.z = 1; this.is2D = true; } else this.is2D = false; }, text: function () { return this.is2D ? 'scale(' + this.x + ', ' + this.y + ')' : 'scale3d(' + this.x + ', ' + this.y + ', ' + this.z + ')'; } });
        var CSSSkew = component('CSSSkew', ['ax', 'ay'], { text: function () { return 'skew(' + this.ax + ', ' + this.ay + ')'; } });
        var CSSSkewX = component('CSSSkewX', ['ax'], { text: function () { return 'skewX(' + this.ax + ')'; } });
        var CSSSkewY = component('CSSSkewY', ['ay'], { text: function () { return 'skewY(' + this.ay + ')'; } });
        var CSSPerspective = component('CSSPerspective', ['length'], { init: function () { this.is2D = false; }, text: function () { return 'perspective(' + this.length + ')'; } });
        var CSSMatrixComponent = component('CSSMatrixComponent', ['matrix'], { init: function (m, options) { this.is2D = options && options.is2D !== undefined ? !!options.is2D : !(m && m.is2D === false); }, text: function () { var m = this.matrix; if (!m) return 'matrix(1, 0, 0, 1, 0, 0)'; return this.is2D ? 'matrix(' + [m.a, m.b, m.c, m.d, m.e, m.f].join(', ') + ')' : 'matrix3d(' + [m.m11, m.m12, m.m13, m.m14, m.m21, m.m22, m.m23, m.m24, m.m31, m.m32, m.m33, m.m34, m.m41, m.m42, m.m43, m.m44].join(', ') + ')'; } });
        CSSMatrixComponent.prototype.toMatrix = function () { return this.matrix; };
        var CSSTransformValue = extend(function CSSTransformValue(components) { fillList(this, components || []); }, CSSStyleValue);
        listMethods(CSSTransformValue.prototype);
        CSSTransformValue.prototype.is2D = true;
        try { Object.defineProperty(CSSTransformValue.prototype, 'is2D', { get: function () { for (var i = 0; i < this.length; i++) if (!this[i].is2D) return false; return true; }, configurable: true }); } catch (e) {}
        CSSTransformValue.prototype.toMatrix = function () { var M = window.DOMMatrix; try { return new M(this.toString()); } catch (e) { return new M(); } };
        CSSTransformValue.prototype.toString = function () { return this.values().join(' '); };
        // colours and images
        var CSSColorValue = extend(function CSSColorValue() {}, CSSStyleValue);
        CSSColorValue.prototype.alpha = null;
        var colorClass = function (name, fields, fn) {
            var C = extend(function () { for (var i = 0; i < fields.length; i++) this[fields[i]] = arguments[i] === undefined ? (fields[i] === 'alpha' ? new CSSUnitValue(1, 'number') : null) : toNumeric(arguments[i]); }, CSSColorValue);
            for (var f = 0; f < fields.length; f++) C.prototype[fields[f]] = null;
            C.prototype.toString = function () { var parts = []; for (var i = 0; i < fields.length - 1; i++) parts.push(String(this[fields[i]])); return fn + '(' + parts.join(' ') + ' / ' + this.alpha + ')'; };
            try { Object.defineProperty(C, 'name', { value: name }); } catch (e) {}
            return C;
        };
        var CSSRGB = colorClass('CSSRGB', ['r', 'g', 'b', 'alpha'], 'rgb');
        var CSSHSL = colorClass('CSSHSL', ['h', 's', 'l', 'alpha'], 'hsl');
        var CSSHWB = colorClass('CSSHWB', ['h', 'w', 'b', 'alpha'], 'hwb');
        var CSSLab = colorClass('CSSLab', ['l', 'a', 'b', 'alpha'], 'lab');
        var CSSLCH = colorClass('CSSLCH', ['l', 'c', 'h', 'alpha'], 'lch');
        var CSSOKLab = colorClass('CSSOKLab', ['l', 'a', 'b', 'alpha'], 'oklab');
        var CSSOKLCH = colorClass('CSSOKLCH', ['l', 'c', 'h', 'alpha'], 'oklch');
        var CSSColor = extend(function CSSColor(colorSpace, channels, alpha) { this.colorSpace = colorSpace; this.channels = channels || []; this.alpha = alpha === undefined ? new CSSUnitValue(1, 'number') : toNumeric(alpha); }, CSSColorValue);
        CSSColor.prototype.colorSpace = ''; CSSColor.prototype.channels = null;
        CSSColor.prototype.toString = function () { return 'color(' + this.colorSpace + ' ' + this.channels.join(' ') + ' / ' + this.alpha + ')'; };
        CSSColorValue.parse = function (text) { var v = parseValue(String(text)); return v instanceof CSSColorValue ? v : new CSSKeywordValue(text); };
        var CSSImageValue = extend(function CSSImageValue(css) { this.__css = css; }, CSSStyleValue);
        // parsing
        var NUM_RE = /^([-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?)([a-z%]*)$/i;
        var splitTop = function (s, sep) { var parts = [], depth = 0, start = 0, q = null; for (var i = 0; i < s.length; i++) { var c = s.charAt(i); if (q) { if (c === q) q = null; continue; } if (c === '"' || c === "'") q = c; else if (c === '(') depth++; else if (c === ')') depth--; else if (depth === 0 && c === sep) { parts.push(s.slice(start, i)); start = i + 1; } } parts.push(s.slice(start)); return parts; };
        var trim = function (s) { return s.trim(); };
        var parseNumeric = function (s) {
            s = trim(s);
            var m = NUM_RE.exec(s);
            if (m) return new CSSUnitValue(parseFloat(m[1]), m[2] === '' ? 'number' : m[2] === '%' ? 'percent' : m[2].toLowerCase());
            var fm = /^(calc|min|max|clamp)\((.*)\)$/i.exec(s);
            if (!fm) return null;
            var name = fm[1].toLowerCase(), inner = fm[2];
            if (name === 'min' || name === 'max' || name === 'clamp') {
                var args = splitTop(inner, ','), vals = [];
                for (var i = 0; i < args.length; i++) { var pv = parseNumeric(args[i]); if (!pv) return null; vals.push(pv); }
                return name === 'min' ? new CSSMathMin(vals) : name === 'max' ? new CSSMathMax(vals) : new CSSMathClamp(vals[0], vals[1], vals[2]);
            }
            // calc: sums of products
            var terms = [], depth = 0, cur = '', sign = 1, i2;
            var flush = function () { var t = trim(cur); if (!t) return true; var pv = parseProduct(t); if (!pv) return false; terms.push(sign < 0 ? new CSSMathNegate(pv) : pv); cur = ''; return true; };
            for (i2 = 0; i2 < inner.length; i2++) {
                var ch = inner.charAt(i2);
                if (ch === '(') depth++; else if (ch === ')') depth--;
                if (depth === 0 && (ch === '+' || ch === '-') && /\s$/.test(cur) && cur.replace(/\s+$/, '')) { if (!flush()) return null; sign = ch === '-' ? -1 : 1; continue; }
                cur += ch;
            }
            if (!flush()) return null;
            return terms.length === 1 && !(terms[0] instanceof CSSMathNegate) ? terms[0] : new CSSMathSum(terms);
        };
        var parseProduct = function (t) {
            var parts = [], depth = 0, cur = '', op = '*';
            var ops = [];
            for (var i = 0; i < t.length; i++) {
                var ch = t.charAt(i);
                if (ch === '(') depth++; else if (ch === ')') depth--;
                if (depth === 0 && (ch === '*' || ch === '/')) { parts.push(cur); ops.push(ch); cur = ''; continue; }
                cur += ch;
            }
            parts.push(cur);
            var vals = [];
            for (var k = 0; k < parts.length; k++) {
                var p = trim(parts[k]);
                if (/^\(.*\)$/.test(p)) p = 'calc' + p;
                var pv = parseNumeric(p);
                if (!pv) return null;
                vals.push(k > 0 && ops[k - 1] === '/' ? new CSSMathInvert(pv) : pv);
            }
            return vals.length === 1 ? vals[0] : new CSSMathProduct(vals);
        };
        var TRANSFORM_FN = /^(translate|translate3d|translatex|translatey|translatez|rotate|rotate3d|rotatex|rotatey|rotatez|scale|scale3d|scalex|scaley|scalez|skew|skewx|skewy|perspective|matrix|matrix3d)\((.*)\)$/i;
        var parseTransform = function (s) {
            var fns = s.match(/[a-z0-9]+\([^)]*\)/gi);
            if (!fns) return null;
            var comps = [];
            for (var i = 0; i < fns.length; i++) {
                var m = TRANSFORM_FN.exec(trim(fns[i]));
                if (!m) return null;
                var name = m[1].toLowerCase(), args = splitTop(m[2], ','), a = [];
                for (var k = 0; k < args.length; k++) { var av = parseNumeric(args[k]); if (!av) return null; a.push(av); }
                var zero = new CSSUnitValue(0, 'px'), one = new CSSUnitValue(1, 'number');
                switch (name) {
                    case 'translate': comps.push(new CSSTranslate(a[0], a[1] || zero)); break;
                    case 'translatex': comps.push(new CSSTranslate(a[0], zero)); break;
                    case 'translatey': comps.push(new CSSTranslate(zero, a[0])); break;
                    case 'translatez': comps.push(new CSSTranslate(zero, zero, a[0])); break;
                    case 'translate3d': comps.push(new CSSTranslate(a[0], a[1], a[2])); break;
                    case 'rotate': case 'rotatez': comps.push(new CSSRotate(a[0])); break;
                    case 'rotatex': comps.push(new CSSRotate(1, 0, 0, a[0])); break;
                    case 'rotatey': comps.push(new CSSRotate(0, 1, 0, a[0])); break;
                    case 'rotate3d': comps.push(new CSSRotate(a[0], a[1], a[2], a[3])); break;
                    case 'scale': comps.push(new CSSScale(a[0], a.length > 1 ? a[1] : a[0])); break;
                    case 'scalex': comps.push(new CSSScale(a[0], one)); break;
                    case 'scaley': comps.push(new CSSScale(one, a[0])); break;
                    case 'scalez': comps.push(new CSSScale(one, one, a[0])); break;
                    case 'scale3d': comps.push(new CSSScale(a[0], a[1], a[2])); break;
                    case 'skew': comps.push(new CSSSkew(a[0], a[1] || new CSSUnitValue(0, 'deg'))); break;
                    case 'skewx': comps.push(new CSSSkewX(a[0])); break;
                    case 'skewy': comps.push(new CSSSkewY(a[0])); break;
                    case 'perspective': comps.push(new CSSPerspective(a[0])); break;
                    default: { var M = window.DOMMatrix, mx; try { mx = new M(trim(fns[i])); } catch (e) { mx = null; } comps.push(new CSSMatrixComponent(mx, { is2D: name === 'matrix' })); }
                }
            }
            return new CSSTransformValue(comps);
        };
        var parseColor = function (s) {
            var m = /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((.*)\)$/i.exec(s);
            if (m) {
                var inner = m[2].replace('/', ' ').replace(/,/g, ' '), toks = inner.split(/\s+/).filter(function (x) { return x; }), vals = [];
                for (var i = 0; i < toks.length; i++) { var pv = parseNumeric(toks[i]); vals.push(pv || new CSSKeywordValue(toks[i])); }
                var fn = m[1].toLowerCase();
                var C = fn === 'rgb' || fn === 'rgba' ? CSSRGB : fn === 'hsl' || fn === 'hsla' ? CSSHSL : fn === 'hwb' ? CSSHWB : fn === 'lab' ? CSSLab : fn === 'lch' ? CSSLCH : fn === 'oklab' ? CSSOKLab : CSSOKLCH;
                return new C(vals[0], vals[1], vals[2], vals.length > 3 ? vals[3] : undefined);
            }
            var hex = /^#([0-9a-f]{3,8})$/i.exec(s);
            if (hex) {
                var h = hex[1];
                if (h.length === 3 || h.length === 4) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2) + (h.length === 4 ? h.charAt(3) + h.charAt(3) : '');
                var n = function (i) { return parseInt(h.substr(i, 2), 16); };
                return new CSSRGB(n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : undefined);
            }
            var cm = /^color\(\s*([a-z0-9-]+)\s+(.*)\)$/i.exec(s);
            if (cm) { var ct = cm[2].replace('/', ' ').split(/\s+/).filter(function (x) { return x; }), cv = []; for (var ci = 0; ci < ct.length; ci++) cv.push(parseNumeric(ct[ci]) || new CSSKeywordValue(ct[ci])); return new CSSColor(cm[1], cv.slice(0, 3), cv.length > 3 ? cv[3] : undefined); }
            return null;
        };
        var parseValue = function (text) {
            var s = trim(text);
            if (!s) return undefined;
            if (/var\(/i.test(s)) {
                var members = [], re = /var\(\s*(--[^,)]+)\s*(?:,\s*([^)]*))?\)/gi, last = 0, mm;
                while ((mm = re.exec(s)) !== null) { if (mm.index > last) members.push(s.slice(last, mm.index)); members.push(new CSSVariableReferenceValue(trim(mm[1]), mm[2] !== undefined ? new CSSUnparsedValue([trim(mm[2])]) : null)); last = mm.index + mm[0].length; }
                if (last < s.length) members.push(s.slice(last));
                return new CSSUnparsedValue(members);
            }
            var num = parseNumeric(s);
            if (num) return num;
            if (/^[a-z-]+$/i.test(s)) return new CSSKeywordValue(s);
            var col = parseColor(s);
            if (col) return col;
            if (/^url\(/i.test(s) || /^(-webkit-)?(linear|radial|conic|repeating-linear|repeating-radial|repeating-conic)-gradient\(/i.test(s) || /^image(-set)?\(/i.test(s)) return new CSSImageValue(s);
            if (TRANSFORM_FN.test(trim(s.split(/\)\s+/)[0] + (s.indexOf(') ') > 0 ? ')' : '')))) { var tv = parseTransform(s); if (tv) return tv; }
            return new CSSUnparsedValue([s]);
        };
        CSSStyleValue.parse = function (property, text) { var v = parseValue(String(text)); if (v === undefined) throw new TypeError('Empty value'); return v; };
        CSSStyleValue.parseAll = function (property, text) { var parts = splitTop(String(text), ','), out = []; for (var i = 0; i < parts.length; i++) { var v = parseValue(parts[i]); if (v !== undefined) out.push(v); } return out; };
        // property maps
        var StylePropertyMapReadOnly = function StylePropertyMapReadOnly(decl, computed) { this.__d = decl; this.__c = !!computed; };
        // a computed map answers every property: what the old engine does not know comes as its initial value (lidl.cz
        // read computedStyleMap().get('row-gap').value and stopped on undefined)
        var INITIAL = { 'row-gap': 'normal', 'column-gap': 'normal', gap: 'normal', 'aspect-ratio': 'auto', translate: 'none', rotate: 'none', scale: 'none',
            inset: 'auto', 'inset-block': 'auto', 'inset-inline': 'auto', 'container-type': 'normal', 'container-name': 'none', 'accent-color': 'auto',
            'scroll-behavior': 'auto', 'overscroll-behavior': 'auto', 'scrollbar-gutter': 'auto', 'content-visibility': 'visible', 'place-items': 'normal',
            'place-content': 'normal', 'justify-items': 'normal', 'justify-self': 'auto', 'align-self': 'auto', 'align-items': 'normal', 'align-content': 'normal',
            'justify-content': 'normal', 'flex-direction': 'row', 'flex-wrap': 'nowrap', 'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': 'auto', order: '0',
            'grid-template-columns': 'none', 'grid-template-rows': 'none', 'grid-auto-flow': 'row', 'text-wrap': 'wrap', 'white-space-collapse': 'collapse',
            'font-optical-sizing': 'auto', 'font-variation-settings': 'normal', 'color-scheme': 'normal', 'forced-color-adjust': 'auto', 'touch-action': 'auto',
            'will-change': 'auto', 'object-position': '50% 50%', 'object-fit': 'fill', isolation: 'auto', 'mix-blend-mode': 'normal', 'backdrop-filter': 'none' };
        StylePropertyMapReadOnly.prototype.get = function (p) {
            var name = String(p), v = this.__d.getPropertyValue(name);
            if (!v && this.__c) v = INITIAL.hasOwnProperty(name) ? INITIAL[name] : name.indexOf('--') === 0 ? '' : 'normal';
            return v ? parseValue(v) : undefined;
        };
        StylePropertyMapReadOnly.prototype.getAll = function (p) { var v = this.__d.getPropertyValue(String(p)); if (!v) return []; return /^(transition|animation|background|font-family|will-change|mask|box-shadow|text-shadow)/.test(p) ? CSSStyleValue.parseAll(p, v) : [parseValue(v)]; };
        StylePropertyMapReadOnly.prototype.has = function (p) { return !!this.__d.getPropertyValue(String(p)); };
        StylePropertyMapReadOnly.prototype.size = 0;
        try { Object.defineProperty(StylePropertyMapReadOnly.prototype, 'size', { get: function () { return this.__d.length; }, configurable: true }); } catch (e) {}
        StylePropertyMapReadOnly.prototype.entries = function () { var a = []; for (var i = 0; i < this.__d.length; i++) { var p = this.__d[i] || this.__d.item(i); a.push([p, this.getAll(p)]); } return a; };
        StylePropertyMapReadOnly.prototype.keys = function () { var a = []; for (var i = 0; i < this.__d.length; i++) a.push(this.__d[i] || this.__d.item(i)); return a; };
        StylePropertyMapReadOnly.prototype.values = function () { var e = this.entries(), a = []; for (var i = 0; i < e.length; i++) a.push(e[i][1]); return a; };
        StylePropertyMapReadOnly.prototype.forEach = function (fn, thisArg) { var e = this.entries(); for (var i = 0; i < e.length; i++) fn.call(thisArg, e[i][1], e[i][0], this); };
        var StylePropertyMap = extend(function StylePropertyMap(decl) { this.__d = decl; }, StylePropertyMapReadOnly);
        StylePropertyMap.prototype.set = function (p) { var vals = []; for (var i = 1; i < arguments.length; i++) vals.push(String(arguments[i])); this.__d.setProperty(String(p), vals.join(', ')); };
        StylePropertyMap.prototype.append = function (p) { var cur = this.__d.getPropertyValue(String(p)), vals = cur ? [cur] : []; for (var i = 1; i < arguments.length; i++) vals.push(String(arguments[i])); this.__d.setProperty(String(p), vals.join(', ')); };
        StylePropertyMap.prototype['delete'] = function (p) { this.__d.removeProperty(String(p)); };
        StylePropertyMap.prototype.clear = function () { var names = this.keys(); for (var i = 0; i < names.length; i++) this.__d.removeProperty(names[i]); };
        if (Ep) {
            Ep.computedStyleMap = function () { return new StylePropertyMapReadOnly(window.getComputedStyle(this), true); };
            try { Object.defineProperty(Ep, 'attributeStyleMap', { get: function () { if (!this.__brStyleMap) this.__brStyleMap = new StylePropertyMap(this.style); return this.__brStyleMap; }, configurable: true }); } catch (e) {}
        }
        var units = TYPED_OM_UNITS;
        for (var ui = 0; ui < units.length; ui++) (function (u) { window.CSS[u] = function (v) { return new CSSUnitValue(v, u); }; })(units[ui]);
        var expose = { CSSStyleValue: CSSStyleValue, CSSKeywordValue: CSSKeywordValue, CSSUnparsedValue: CSSUnparsedValue, CSSVariableReferenceValue: CSSVariableReferenceValue, CSSNumericValue: CSSNumericValue, CSSUnitValue: CSSUnitValue,
            CSSMathValue: CSSMathValue, CSSMathSum: CSSMathSum, CSSMathProduct: CSSMathProduct, CSSMathNegate: CSSMathNegate, CSSMathInvert: CSSMathInvert, CSSMathMin: CSSMathMin, CSSMathMax: CSSMathMax, CSSMathClamp: CSSMathClamp,
            CSSNumericArray: CSSNumericArray, CSSTransformValue: CSSTransformValue, CSSTransformComponent: CSSTransformComponent, CSSTranslate: CSSTranslate, CSSRotate: CSSRotate, CSSScale: CSSScale, CSSSkew: CSSSkew, CSSSkewX: CSSSkewX,
            CSSSkewY: CSSSkewY, CSSPerspective: CSSPerspective, CSSMatrixComponent: CSSMatrixComponent, CSSImageValue: CSSImageValue, CSSColorValue: CSSColorValue, CSSRGB: CSSRGB, CSSHSL: CSSHSL, CSSHWB: CSSHWB, CSSLab: CSSLab, CSSLCH: CSSLCH,
            CSSOKLab: CSSOKLab, CSSOKLCH: CSSOKLCH, CSSColor: CSSColor, StylePropertyMapReadOnly: StylePropertyMapReadOnly, StylePropertyMap: StylePropertyMap };
        for (var ek in expose) if (expose.hasOwnProperty(ek)) window[ek] = expose[ek];
    })(); } catch (eTypedOM) {} };
    // (the stand-ins call the real thing once the setup put it in place; nothing when the setup failed)
    if (typedOMSetup) (function () {
        var LAZY = ['CSSStyleValue', 'CSSUnitValue', 'CSSNumericValue', 'CSSKeywordValue', 'CSSUnparsedValue', 'CSSTransformValue', 'CSSMathSum',
                    'StylePropertyMap', 'StylePropertyMapReadOnly'];
        var ensure = function () {
            var setup = typedOMSetup;
            if (!setup) return;
            typedOMSetup = null;
            for (var i = 0; i < LAZY.length; i++) try { delete window[LAZY[i]]; } catch (e) {}
            setup();
        };
        for (var i = 0; i < LAZY.length; i++) (function (name) {
            try {
                Object.defineProperty(window, name, { get: function () { ensure(); return window[name]; }, set: function (v) { ensure(); window[name] = v; },
                                                      configurable: true, enumerable: false });
            } catch (e) {}
        })(LAZY[i]);
        if (Ep) {
            var lazyMap = function () { ensure(); return Ep.computedStyleMap !== lazyMap ? Ep.computedStyleMap.call(this) : undefined; };
            Ep.computedStyleMap = lazyMap;
            var lazyAttrMap = function () {
                ensure();
                var d = Object.getOwnPropertyDescriptor(Ep, 'attributeStyleMap');
                return d && d.get && d.get !== lazyAttrMap ? d.get.call(this) : undefined;
            };
            try { Object.defineProperty(Ep, 'attributeStyleMap', { get: lazyAttrMap, configurable: true }); } catch (e2) {}
        }
        if (window.CSS) for (var u = 0; u < TYPED_OM_UNITS.length; u++) (function (unit) {
            var lazyUnit = function (v) { ensure(); var f = window.CSS[unit]; return f !== lazyUnit ? f(v) : undefined; };
            window.CSS[unit] = lazyUnit;
        })(TYPED_OM_UNITS[u]);
    })();

    // ---- CSSOM rule classes with their members, view extras, event handler attributes, view transitions
    try {
        var proto = function (name) { return window[name] && window[name].prototype; };
        var defaults = function (name, members) { var p = proto(name); if (!p) return; for (var k in members) if (members.hasOwnProperty(k) && !(k in p)) p[k] = members[k]; };
        var emptyRules = function () { return []; };
        defaults('CSSGroupingRule', { cssRules: emptyRules(), insertRule: function () { return 0; }, deleteRule: noop });
        defaults('CSSConditionRule', { conditionText: '' });
        defaults('CSSSupportsRule', { conditionText: '', matches: false });
        if (proto('CSSMediaRule') && !('matches' in proto('CSSMediaRule'))) try { Object.defineProperty(proto('CSSMediaRule'), 'matches', { get: function () { try { return window.matchMedia(this.media.mediaText).matches; } catch (e) { return false; } }, configurable: true }); } catch (e0) {}
        defaults('CSSMediaRule', { conditionText: '' });
        defaults('CSSImportRule', { layerName: null, supportsText: null });
        defaults('CSSLayerBlockRule', { name: '' });
        defaults('CSSLayerStatementRule', { nameList: [] });
        defaults('CSSScopeRule', { start: null, end: null });
        defaults('CSSContainerRule', { containerName: '', containerQuery: '' });
        defaults('CSSPropertyRule', { name: '', syntax: '*', inherits: false, initialValue: null });
        defaults('CSSCounterStyleRule', { name: '', system: '', symbols: '', additiveSymbols: '', negative: '', prefix: '', suffix: '', range: '', pad: '', speakAs: '', fallback: '' });
        defaults('CSSFontFeatureValuesRule', { fontFamily: '', annotation: {}, ornaments: {}, stylistic: {}, swash: {}, characterVariant: {}, styleset: {} });
        defaults('CSSFontPaletteValuesRule', { name: '', fontFamily: '', basePalette: '', overrideColors: '' });
        defaults('CSSPositionTryRule', { name: '', style: null });
        defaults('CSSNestedDeclarations', { style: null });
        var moreStubs = { CSSMarginRule: { name: '', style: null }, CSSNamespaceRule: { namespaceURI: '', prefix: '' }, CSSFunctionRule: { name: '', returnType: '', getParameters: emptyRules, cssRules: [] }, CSSFunctionDeclarations: { style: null },
            CSSColorProfileRule: { name: '', src: '', renderingIntent: '', components: [] }, CSSFontFeatureValuesMap: { set: noop, get: function () { return undefined; }, has: function () { return false; }, 'delete': function () { return false; }, clear: noop, size: 0 } };
        for (var ms in moreStubs) if (moreStubs.hasOwnProperty(ms) && !window[ms]) { window[ms] = (function () { var F = function () {}; try { F.prototype = Object.create(window.CSSRule ? window.CSSRule.prototype : Object.prototype); } catch (e) {} F.prototype.constructor = F; return F; })(); defaults(ms, moreStubs[ms]); }
        if (window.CSSStyleDeclaration) {
            if (!window.CSSStyleProperties) { window.CSSStyleProperties = function CSSStyleProperties() {}; window.CSSStyleProperties.prototype = Object.create(window.CSSStyleDeclaration.prototype); defaults('CSSStyleProperties', { cssFloat: '' }); }
            if (!window.CSSPageDescriptors) { window.CSSPageDescriptors = function CSSPageDescriptors() {}; window.CSSPageDescriptors.prototype = Object.create(window.CSSStyleDeclaration.prototype); defaults('CSSPageDescriptors', { margin: '', marginTop: '', marginRight: '', marginBottom: '', marginLeft: '', 'margin-top': '', 'margin-right': '', 'margin-bottom': '', 'margin-left': '', size: '', pageOrientation: '', 'page-orientation': '', marks: '', bleed: '' }); }
        }
        if (!window.CSSPseudoElement) {
            window.CSSPseudoElement = function CSSPseudoElement() {};
            defaults('CSSPseudoElement', { type: '', element: null, parent: null, pseudo: function () { return null; }, getBoxQuads: emptyRules, convertQuadFromNode: function (q) { return q; }, convertRectFromNode: function (r) { return r; }, convertPointFromNode: function (p) { return p; }, addEventListener: noop, removeEventListener: noop, dispatchEvent: function () { return true; } });
            if (Ep && !Ep.pseudo) Ep.pseudo = function () { return null; };
        }
        if (window.Text && window.Text.prototype && !window.Text.prototype.getBoxQuads) {
            var geometry = { getBoxQuads: emptyRules, convertQuadFromNode: function (q) { return q; }, convertRectFromNode: function (r) { return r; }, convertPointFromNode: function (p) { return p; } };
            defaults('Text', geometry); defaults('Element', geometry); defaults('Document', geometry);
        }
        if (Ep && !('regionOverset' in Ep)) { Ep.regionOverset = 'empty'; Ep.getRegionFlowRanges = emptyRules; }
        // window / document / element view extras
        if (window.HTMLImageElement && window.HTMLImageElement.prototype && !('x' in window.HTMLImageElement.prototype)) {
            try {
                Object.defineProperty(window.HTMLImageElement.prototype, 'x', { get: function () { return Math.round(this.getBoundingClientRect().left + window.pageXOffset); }, configurable: true });
                Object.defineProperty(window.HTMLImageElement.prototype, 'y', { get: function () { return Math.round(this.getBoundingClientRect().top + window.pageYOffset); }, configurable: true });
            } catch (e1) {}
        }
        if (window.MouseEvent && window.MouseEvent.prototype && !('x' in window.MouseEvent.prototype)) {
            try {
                Object.defineProperty(window.MouseEvent.prototype, 'x', { get: function () { return this.clientX; }, configurable: true });
                Object.defineProperty(window.MouseEvent.prototype, 'y', { get: function () { return this.clientY; }, configurable: true });
            } catch (e2) {}
        }
        if (!window.moveTo) { window.moveTo = noop; window.moveBy = noop; window.resizeTo = noop; window.resizeBy = noop; }
        if (!window.scroll) window.scroll = window.scrollTo;
        // handler attributes for the prefixed animation and transition events
        var wireHandler = function (attr, eventName) {
            var Hp = window.HTMLElement && window.HTMLElement.prototype;
            if (!Hp || (attr in Hp)) return;
            try {
                Object.defineProperty(Hp, attr, {
                    get: function () { return this['__' + attr] || null; },
                    set: function (fn) { var old = this['__' + attr]; if (old && eventName) this.removeEventListener(eventName, old, false); this['__' + attr] = typeof fn === 'function' ? fn : null; if (fn && eventName) this.addEventListener(eventName, fn, false); },
                    configurable: true
                });
            } catch (e3) {}
        };
        wireHandler('ontransitionend', 'webkitTransitionEnd'); wireHandler('ontransitionstart', null); wireHandler('ontransitionrun', null); wireHandler('ontransitioncancel', null);
        wireHandler('onanimationstart', 'webkitAnimationStart'); wireHandler('onanimationiteration', 'webkitAnimationIteration'); wireHandler('onanimationend', 'webkitAnimationEnd'); wireHandler('onanimationcancel', null);
        wireHandler('onsnapchanged', null); wireHandler('onsnapchanging', null);
        var evProto = function (name) { return window[name] && window[name].prototype; };
        if (evProto('TransitionEvent') && !('pseudoElement' in evProto('TransitionEvent'))) evProto('TransitionEvent').pseudoElement = '';
        if (evProto('AnimationEvent') && !('pseudoElement' in evProto('AnimationEvent'))) evProto('AnimationEvent').pseudoElement = '';
        var simpleEvent = function (name, fields) {
            if (window[name]) return;
            window[name] = function (type, init) { var e = document.createEvent('Event'); e.initEvent(type, !!(init && init.bubbles), !!(init && init.cancelable)); for (var k in fields) if (fields.hasOwnProperty(k)) e[k] = init && init[k] !== undefined ? init[k] : fields[k]; return e; };
            try { window[name].prototype = Object.create(window.Event.prototype); window[name].prototype.constructor = window[name]; for (var f in fields) if (fields.hasOwnProperty(f)) window[name].prototype[f] = fields[f]; } catch (e4) {}
        };
        simpleEvent('SnapEvent', { snapTargetBlock: null, snapTargetInline: null });
        simpleEvent('ContentVisibilityAutoStateChangeEvent', { skipped: false });
        simpleEvent('PageRevealEvent', { viewTransition: null });
        simpleEvent('AnimationPlaybackEvent', { currentTime: null, timelineTime: null });
        simpleEvent('NavigationEvent', { dir: '', relatedTarget: null });
        // view transitions: the callback runs at once, the promises resolve (the spec's own fallback)
        if (!document.startViewTransition) {
            window.ViewTransition = window.ViewTransition || function ViewTransition() { this.updateCallbackDone = resolved(); this.ready = resolved(); this.finished = resolved(); };
            window.ViewTransition.prototype.skipTransition = noop;
            document.startViewTransition = function (cb) {
                var t = new window.ViewTransition(), fn = typeof cb === 'function' ? cb : cb && typeof cb.update === 'function' ? cb.update : null;
                var done = P ? new P(function (res, rej) { try { res(fn ? fn() : undefined); } catch (e) { rej(e); } }) : null;
                if (done) { t.updateCallbackDone = done; t.ready = done; t.finished = done; }
                return t;
            };
        }
        // animation timelines and effects (web-animations-2, scroll-animations-1)
        if (window.AnimationTimeline) {
            defaults('AnimationTimeline', { currentTime: 0, duration: null, play: function () { return new window.Animation(); } });
            if (!window.ScrollTimeline) { window.ScrollTimeline = function ScrollTimeline(options) { this.source = options && options.source || null; this.axis = options && options.axis || 'block'; }; window.ScrollTimeline.prototype = Object.create(window.AnimationTimeline.prototype); defaults('ScrollTimeline', { source: null, axis: 'block' }); }
            if (!window.ViewTimeline) { window.ViewTimeline = function ViewTimeline(options) { try { window.ScrollTimeline.call(this, options); } catch (e) {} this.subject = options && options.subject || null; this.startOffset = null; this.endOffset = null; }; window.ViewTimeline.prototype = Object.create(window.ScrollTimeline.prototype); defaults('ViewTimeline', { subject: null, startOffset: null, endOffset: null }); }
        }
        if (window.AnimationEffect) {
            defaults('AnimationEffect', { parent: null, previousSibling: null, nextSibling: null, before: noop, after: noop, replace: noop, remove: noop, getTiming: function () { return {}; }, getComputedTiming: function () { return {}; }, updateTiming: noop });
            defaults('KeyframeEffect', { iterationComposite: 'replace', iteratonComposite: 'replace' });
            if (!window.GroupEffect) {
                window.AnimationNodeList = function AnimationNodeList() { this.length = 0; }; window.AnimationNodeList.prototype.item = function () { return null; }; window.AnimationNodeList.prototype.length = 0;
                window.GroupEffect = function GroupEffect(children) { this.children = new window.AnimationNodeList(); this.firstChild = children && children[0] || null; this.lastChild = children && children[children.length - 1] || null; };
                window.GroupEffect.prototype = Object.create(window.AnimationEffect.prototype);
                defaults('GroupEffect', { children: null, firstChild: null, lastChild: null, clone: function () { return new window.GroupEffect(); }, prepend: noop, append: noop });
                window.SequenceEffect = function SequenceEffect(children) { window.GroupEffect.call(this, children); };
                window.SequenceEffect.prototype = Object.create(window.GroupEffect.prototype);
                defaults('SequenceEffect', { clone: function () { return new window.SequenceEffect(); } });
            }
        }
        if (window.Animation && !window.WorkletAnimation) { window.WorkletAnimation = function WorkletAnimation(name) { try { window.Animation.call(this); } catch (e) {} this.animatorName = name || ''; }; window.WorkletAnimation.prototype = Object.create(window.Animation.prototype); defaults('WorkletAnimation', { animatorName: '' }); }
        // resize observer entries with box sizes
        if (window.ResizeObserverEntry && window.ResizeObserverEntry.prototype && !('borderBoxSize' in window.ResizeObserverEntry.prototype)) {
            window.ResizeObserverSize = window.ResizeObserverSize || function ResizeObserverSize(inlineSize, blockSize) { this.inlineSize = inlineSize; this.blockSize = blockSize; };
            defaults('ResizeObserverSize', { inlineSize: 0, blockSize: 0 });
            var sizeOf = function (entry, border) { var t = entry.target, w = border ? t.offsetWidth : t.clientWidth, h = border ? t.offsetHeight : t.clientHeight; return [new window.ResizeObserverSize(w || 0, h || 0)]; };
            try {
                Object.defineProperty(window.ResizeObserverEntry.prototype, 'borderBoxSize', { get: function () { return sizeOf(this, true); }, configurable: true });
                Object.defineProperty(window.ResizeObserverEntry.prototype, 'contentBoxSize', { get: function () { return sizeOf(this, false); }, configurable: true });
                Object.defineProperty(window.ResizeObserverEntry.prototype, 'devicePixelContentBoxSize', { get: function () { var s = sizeOf(this, false)[0], r = window.devicePixelRatio || 1; return [new window.ResizeObserverSize(s.inlineSize * r, s.blockSize * r)]; }, configurable: true });
            } catch (e5) {}
        }
        // The resize observer polyfill takes only `target instanceof target.ownerDocument.defaultView.Element`: an element
        // this window made and put into an iframe's document is none of that one's (Airbnb's start observed such a
        // div: 'parameter 1 is not of type "Element"', its setup stopped there). A native observer takes any element:
        // such a one is left unobserved here (what an iframe lays out is not measured in this window anyway).
        var ROp = window.ResizeObserver && window.ResizeObserver.prototype;
        if (ROp && !ROp.__brOtherDoc && !/\[native code\]/.test(String(window.ResizeObserver))) {
            ROp.__brOtherDoc = true;
            var foreign = function (t) {
                var od = t && t.nodeType === 1 ? t.ownerDocument : null, dv = od && od !== document ? od.defaultView : null;
                if (!dv || dv === window) return false;
                try { return !(t instanceof dv.Element); } catch (e) { return true; }
            };
            var roSkip = function (name) {
                var orig = ROp[name];
                if (typeof orig !== 'function') return;
                ROp[name] = function (t) { return foreign(t) ? undefined : orig.apply(this, arguments); };
            };
            roSkip('observe');
            roSkip('unobserve');
        }
        // font loading extras
        if (window.FontFace) {
            if (!window.FontFaceFeatures) window.FontFaceFeatures = function FontFaceFeatures() {};
            if (!window.FontFaceVariationAxis) { window.FontFaceVariationAxis = function FontFaceVariationAxis() {}; defaults('FontFaceVariationAxis', { name: '', axisTag: '', minimumValue: 0, maximumValue: 0, defaultValue: 0 }); }
            if (!window.FontFacePalettes) { window.FontFacePalettes = function FontFacePalettes() {}; defaults('FontFacePalettes', { length: 0 }); }
            if (!window.FontFacePalette) { window.FontFacePalette = function FontFacePalette() {}; defaults('FontFacePalette', { length: 0, usableWithLightBackground: false, usableWithDarkBackground: false }); }
        }
        if (!window.Viewport) { window.Viewport = function Viewport() {}; defaults('Viewport', { segments: null }); if (!window.viewport) window.viewport = new window.Viewport(); }
    } catch (eCSSOM2) {}

    // ---- This engine keeps DOM attributes on the instances: runtimes that take the getter from the prototype
    // (Svelte 5: Object.getOwnPropertyDescriptor(Node.prototype, 'firstChild').get.call(node)) get one asking the
    // instance. (Instance lookups still find the engine's own attribute first, so normal access does not change.)
    (function () {
        var sample = document.createElement('div');
        var add = function (Ctor, names, writable) {
            var proto = Ctor && Ctor.prototype;
            if (!proto) return;
            // (only an instance's own attribute is read: on anything else inheriting from the prototype, a custom
            // element's prototype for one, this[name] found this getter again and recursed until the stack ran out)
            var own = Object.prototype.hasOwnProperty;
            for (var i = 0; i < names.length; i++) (function (name) {
                if (Object.getOwnPropertyDescriptor(proto, name) || !(name in sample) || !own.call(sample, name)) return;
                var d = { configurable: true, enumerable: true, get: function () { return this === proto || !own.call(this, name) ? undefined : this[name]; } };
                if (writable) d.set = function (v) { if (this !== proto && own.call(this, name)) this[name] = v; };
                try { Object.defineProperty(proto, name, d); } catch (e) {}
            })(names[i]);
        };
        try {
            add(window.Node, ['firstChild', 'lastChild', 'nextSibling', 'previousSibling', 'parentNode', 'childNodes', 'nodeType', 'nodeName', 'ownerDocument'], false);
            add(window.Node, ['textContent', 'nodeValue'], true);
            add(window.Element, ['firstElementChild', 'lastElementChild', 'nextElementSibling', 'previousElementSibling', 'children', 'childElementCount'], false);
        } catch (e) {}
    })();

    // ---- new Function(...) with ES2015+ syntax (template compilers, feature tests, AsyncFunction): when the engine
    // refuses it, the page loads the transpiler (acorn and jsfix.js from the app, once) and builds the lowered function.
    // (eval is left alone: a wrapper would turn direct eval into global eval.)
    (function () {
        var NativeFunction = window.Function, ready = null;
        if (!NativeFunction || NativeFunction.__brLowering) return;
        var load = function (name) {
            var x = new XMLHttpRequest();
            x.open('GET', 'https://ios6-browser.invalid/' + name, false);
            x.send(null);
            if (x.status === 200 && x.responseText) (0, eval)(x.responseText);
        };
        var transpiler = function () {
            if (ready !== null) return ready;
            ready = false;
            try {
                if (!window.JSFIX_UNICODE) { try { load('unicode-props.js'); } catch (e0) {} }
                if (!window.acorn) load('acorn.js');
                if (!window.JSFix) load('jsfix.js');
                ready = !!(window.acorn && window.JSFix && window.JSFix.transpile);
            } catch (e) { ready = false; }
            return ready;
        };
        var Lowering = function Function() {
            try { return NativeFunction.apply(this, arguments); } catch (e) {
                if (!(e instanceof SyntaxError) || !transpiler()) throw e;
                var params = Array.prototype.slice.call(arguments, 0, -1).join(','), body = arguments.length ? String(arguments[arguments.length - 1]) : '';
                var out = null;
                try { out = window.JSFix.transpile('(function anonymous(' + params + '\n) {\n' + body + '\n});', {}); } catch (e2) { out = null; }
                if (!out) throw e;
                return (0, eval)(out);
            }
        };
        Lowering.prototype = NativeFunction.prototype;
        Lowering.__brLowering = true;
        Lowering.__brNative = NativeFunction;
        window.__brTranspiler = transpiler;
        // a script's text lowered by the app's transpiler, which keeps what it lowered by the text and makes room for it
        // (Alza inserts 600 KB of script text on every visit: 12 s of lowering in the page each time): the ES5 text, ''
        // when it needs nothing, null when the app did not answer (then the page lowers it itself)
        try {
            Object.defineProperty(window, '__brLowerByApp', { configurable: true, writable: true, value: function (text) {
                try {
                    var x = new XMLHttpRequest();
                    x.open('POST', 'https://ios6-browser.invalid/lower', false);
                    x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
                    x.send(String(text));
                    if (x.status === 200) return x.responseText;
                } catch (e4) {}
                return null;
            } });
        } catch (e5) {}
        try { window.Function = Lowering; } catch (e3) {}
    })();

    // ---- Workers made from blob: URLs. MapLibre builds its worker from the source text of (transpiled) functions,
    // which call the transpiler's helpers and program variables of the page's script; a worker scope has neither, nor
    // the polyfills (Promise...). The script gets a prelude with the polyfills for workers, those helpers and
    // variables; a script the engine cannot parse is lowered first.
    (function () {
        var NativeWorker = window.Worker, NativeBlob = window.Blob;
        if (!NativeWorker || NativeWorker.__brWrapped || !NativeBlob) return;
        var read = function (url) {
            try {
                var x = new XMLHttpRequest();
                x.open('GET', url, false);
                x.send(null);
                return x.status === 200 || x.status === 0 ? x.responseText : null;
            } catch (e) { return null; }
        };
        var unique = function (list) { var out = [], seen = {}; for (var i = 0; list && i < list.length; i++) if (!seen['$' + list[i]]) { seen['$' + list[i]] = 1; out.push(list[i]); } return out; };
        var prepare = function (src) {
            var F = window.Function.__brNative || window.Function;
            // (text of transpiled functions parses; a big worker is not parsed twice)
            if (!/\b__br_\w+\(|\b_rt\$\w+\./.test(src)) try { F(src); } catch (e) {
                if (!(e instanceof SyntaxError) || !window.__brTranspiler || !window.__brTranspiler()) return null;
                var out = '';
                try { out = window.JSFix.run(src, '{}'); } catch (e2) { out = ''; }
                if (!out) return null;
                src = out;
            }
            // the helpers the text calls (and the ones those call), as the page has them; _rt$ variables hold __br_regen()
            var rts = unique(src.match(/\b_rt\$\w+/g)), tpls = unique(src.match(/\b_tpl\$\w+/g)), vars = [];
            var queue = unique(src.match(/\b__br_\w+/g)).concat(rts.length ? ['__br_regen'] : []), done = {}, parts = [];
            while (queue.length) {
                var n = queue.shift();
                if (done[n]) continue;
                done[n] = 1;
                if (typeof window[n] !== 'function' || new RegExp('function\\s+' + n + '\\s*\\(').test(src)) continue;
                var text = Function.prototype.toString.call(window[n]);
                if (!/^function\s+__br_/.test(text)) text = 'var ' + n + ' = ' + text + ';';
                parts.push(text);
                queue = queue.concat(unique(text.match(/\b__br_\w+/g)));
            }
            for (var i = 0; i < rts.length; i++) vars.push(rts[i] + '=__br_regen()');
            for (var j = 0; j < tpls.length; j++) vars.push(tpls[j]);
            return 'try{importScripts("https://ios6-browser.invalid/worker-polyfills.js");}catch(e){}\n' + parts.join('\n') + (vars.length ? '\nvar ' + vars.join(',') + ';' : '') + '\n' + src;
        };
        // the text of script blobs made from strings, by object URL (XHR of blob: URLs does not work everywhere)
        var recent = [], texts = {};
        var WrappedBlob = function Blob(parts, opts) {
            var b = arguments.length > 1 ? new NativeBlob(parts, opts) : arguments.length ? new NativeBlob(parts) : new NativeBlob();
            if (parts && parts.length && opts && /javascript|ecmascript/i.test(opts.type || '')) {
                var text = '';
                for (var i = 0; i < parts.length; i++) { if (typeof parts[i] !== 'string') { text = null; break; } text += parts[i]; }
                if (text !== null) { recent.push([b, text]); if (recent.length > 16) recent.shift(); }
            }
            return b;
        };
        WrappedBlob.prototype = NativeBlob.prototype;
        try { window.Blob = WrappedBlob; } catch (e0) {}
        var remember = function (owner) {
            if (!owner || !owner.createObjectURL || owner.createObjectURL.__brBlobText) return;
            var createURL = owner.createObjectURL;
            owner.createObjectURL = function (obj) {
                var u = createURL.apply(this, arguments);
                for (var i = recent.length - 1; i >= 0; i--) if (recent[i][0] === obj) { texts[u] = recent[i][1]; break; }
                return u;
            };
            owner.createObjectURL.__brBlobText = true;
        };
        try { remember(window.URL); remember(window.webkitURL); } catch (e1) {}
        var workerURL = function (url) {
            var u = String(url);
            if (/^blob:/i.test(u)) {
                var src = texts.hasOwnProperty(u) ? texts[u] : read(u), fixed = src ? prepare(src) : null;
                if (fixed !== null) { try { u = (window.URL || window.webkitURL).createObjectURL(new NativeBlob([fixed], { type: 'text/javascript' })); } catch (e) {} }
            } else if (!/^data:/i.test(u) && u.indexOf('__brwork=1') < 0) {
                // a script from a URL: the network layer puts the worker polyfills in front of it when it sees the marker
                // (before the fragment, which some pass parameters in: turbopack's workers)
                var hash = u.indexOf('#'), base = hash < 0 ? u : u.slice(0, hash);
                u = base + (base.indexOf('?') < 0 ? '?' : '&') + '__brwork=1' + (hash < 0 ? '' : u.slice(hash));
            }
            return u;
        };
        var Wrapped = function Worker(url, opts) {
            var u = workerURL(url);
            return arguments.length > 1 ? new NativeWorker(u, opts) : new NativeWorker(u);
        };
        Wrapped.prototype = NativeWorker.prototype;
        Wrapped.__brWrapped = true;
        window.__brWorkerPrelude = prepare;   // (tests)
        try { window.Worker = Wrapped; } catch (e) {}
        // the old engine has shared workers too, which need the same (Telegram's web client runs its protocol in one:
        // "Can't find variable: Promise" there)
        var NativeShared = window.SharedWorker;
        if (NativeShared && !NativeShared.__brWrapped) {
            // (the old engine takes only a name as the second argument: an options object became the name
            // "[object Object]" for every worker, and a second one of another URL threw URL_MISMATCH_ERR)
            var WrappedShared = function SharedWorker(url, opts) {
                var u = workerURL(url), name = typeof opts === 'string' ? opts : opts && typeof opts === 'object' && opts.name !== undefined ? String(opts.name) : undefined;
                return name !== undefined ? new NativeShared(u, name) : new NativeShared(u);
            };
            WrappedShared.prototype = NativeShared.prototype;
            WrappedShared.__brWrapped = true;
            try { window.SharedWorker = WrappedShared; } catch (e6) {}
        }
    })();

    // ---- ES modules. The rewriter turns <script type="module"> into __brModules.entry(src) (inline ones into their
    // registration followed by an entry) when the page has no nomodule fallback. Module files are fetched with the
    // internal marker ?__brmod=1 (the network layer strips it, lowers the module and answers with
    // __brModules.define(url, deps, factory), see jsfix.js). Graphs are fetched in parallel, linked (namespaces with
    // live getters, `export *`), and run depth-first; entries run in document order once the document is parsed.
    // import() loads on demand.
    (function () {
        if (window.__brModules || !window.Promise) return;
        var P = window.Promise, records = {}, queue = [], draining = false, mapCache = null, hasOwnP = Object.prototype.hasOwnProperty;
        var toURL = function (spec, base) {
            try { return new window.URL(spec, base).href; } catch (e) {}
            var a = document.createElement('a');
            a.href = spec;
            return a.href;
        };
        // import maps: <script type="importmap"> (imports and scopes, prefix entries ending in "/")
        var importMap = function () {
            if (mapCache) return mapCache;
            mapCache = { imports: {}, scopes: {} };
            var list = document.querySelectorAll('script[type="importmap"]');
            for (var i = 0; i < list.length; i++) {
                var m = null;
                try { m = JSON.parse(list[i].textContent); } catch (e) { continue; }
                var k, s;
                if (m && m.imports) for (k in m.imports) if (hasOwnP.call(m.imports, k)) mapCache.imports[k] = toURL(m.imports[k], document.baseURI);
                if (m && m.scopes) for (s in m.scopes) if (hasOwnP.call(m.scopes, s)) {
                    var scope = toURL(s, document.baseURI), target = mapCache.scopes[scope] || (mapCache.scopes[scope] = {});
                    for (k in m.scopes[s]) if (hasOwnP.call(m.scopes[s], k)) target[k] = toURL(m.scopes[s][k], document.baseURI);
                }
            }
            return mapCache;
        };
        var lookup = function (spec, map) {
            if (hasOwnP.call(map, spec)) return map[spec];
            var best = null;
            for (var k in map) if (hasOwnP.call(map, k) && k.charAt(k.length - 1) === '/' && spec.indexOf(k) === 0 && (!best || k.length > best.length)) best = k;
            return best !== null ? map[best] + spec.slice(best.length) : null;
        };
        var resolve = function (spec, base) {
            var map = importMap(), asURL = /^(\.{0,2}\/|[a-z][a-z0-9+.\-]*:)/i.test(spec) ? toURL(spec, base) : null, key = asURL || spec, r = null, best = null, s;
            for (s in map.scopes) if (hasOwnP.call(map.scopes, s) && base.indexOf(s) === 0 && (!best || s.length > best.length)) best = s;
            if (best !== null) r = lookup(key, map.scopes[best]);
            if (r === null) r = lookup(key, map.imports);
            if (r !== null) return r;
            if (asURL) return asURL;
            throw new TypeError('Failed to resolve module specifier "' + spec + '"');
        };
        var record = function (url) { return records[url] || (records[url] = { url: url, deps: null, factory: null, ns: null, state: 0, error: null }); };
        var makeNS = function () {
            var ns = Object.create(null);
            try { if (window.Symbol && Symbol.toStringTag) Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' }); } catch (e) {}
            return ns;
        };
        var getter = function (ns, name, fn) { try { Object.defineProperty(ns, name, { get: fn, enumerable: true, configurable: true }); } catch (e) {} };
        var fetchRecord = function (r) {
            if (r.factory || r.error) return P.resolve(r);
            if (r.fetching) return r.fetching;
            // a data: URL (reddit imports its inline modules that way): the text is here already, and the old engine's
            // XHR cannot load one
            if (/^data:/i.test(r.url)) {
                r.fetching = new P(function (done) {
                    var text = dataText(r.url);
                    if (text === null || !defineText(text, r.url)) r.error = r.error || new TypeError('Failed to fetch module ' + r.url.slice(0, 100));
                    else if (!r.factory && !r.error) r.error = new SyntaxError('Module ' + r.url.slice(0, 100) + ' did not register');
                    done(r);
                });
                return r.fetching;
            }
            r.fetching = new P(function (done) {
                var hook = window.__brModuleTransform, tries = 0;   // (tests transform in the page)
                var asked = hook ? r.url : r.url + (r.url.indexOf('?') >= 0 ? '&' : '?') + '__brmod=1';
                var load = function () {
                    var x = new XMLHttpRequest();
                    x.open('GET', asked, true);
                    x.onreadystatechange = function () {
                        if (x.readyState !== 4) return;
                        if ((x.status && (x.status < 200 || x.status >= 300)) || (!x.status && !x.responseText)) {
                            r.error = new TypeError('Failed to fetch module ' + r.url + (x.status ? ' (HTTP ' + x.status + ')' : ''));
                            done(r);
                            return;
                        }
                        var code = x.responseText, unparsed = false, ctype = '';
                        // a JSON module (import ... with { type: 'json' }; the app passes it as it came): the parsed value
                        // as the default export
                        try { ctype = String(x.getResponseHeader('Content-Type') || '').toLowerCase(); } catch (eH) {}
                        if (!hook && ctype.indexOf('json') >= 0) {
                            var value;
                            try { value = JSON.parse(code); } catch (eJ) { r.error = eJ; done(r); return; }
                            api.define(r.url, [], function (ex) { ex({ 'default': function () { return value; } }); return [[], function () {}]; });
                            done(r);
                            return;
                        }
                        try { if (hook) code = hook(code, r.url); (0, eval)(code + '\n//# sourceURL=' + r.url); } catch (e) { r.error = e; unparsed = e instanceof SyntaxError; }
                        // the app had no room to lower it just now: its failure says so, or the module came as it is (the
                        // old engine meets import/export). Asked for again in a while, twice - what depends on it waits;
                        // a copy the cache kept goes first
                        if (!r.factory && r.error && tries < 2 && !hook && (r.error.__brNoRoom || (unparsed && code.indexOf('__brModules') < 0))) {
                            tries++;
                            r.error = null;
                            sendToApp('brevict', asked);
                            setTimeout(load, 3000 * tries);
                            return;
                        }
                        if (!r.factory && !r.error) r.error = new SyntaxError('Module ' + r.url + ' did not register');
                        done(r);
                    };
                    x.send(null);
                };
                load();
            });
            return r.fetching;
        };
        // every module reachable from root, fetched in parallel (cycles included)
        var fetchAll = function (root) {
            return new P(function (done) {
                var pending = 0, seen = {};
                var visit = function (r) {
                    if (seen[r.url]) return;
                    seen[r.url] = 1;
                    pending++;
                    fetchRecord(r).then(function () {
                        if (!r.error && !r.depRecs) {
                            var list = [];
                            for (var i = 0; i < r.deps.length; i++) {
                                try { list.push(record(resolve(r.deps[i], r.url))); } catch (e) { r.error = e; break; }
                            }
                            if (!r.error) r.depRecs = list;
                        }
                        if (!r.error) for (var j = 0; j < r.depRecs.length; j++) visit(r.depRecs[j]);
                        if (--pending === 0) done(root);
                    });
                };
                visit(root);
            });
        };
        var instantiate = function (r) {
            if (r.state >= 1 || r.error) return;
            r.state = 1;
            var ns = r.ns || (r.ns = makeNS());
            var ex = function (getters, stars) {
                for (var k in getters) if (hasOwnP.call(getters, k)) getter(ns, k, getters[k]);
                r.stars = stars || [];
            };
            var res;
            try { res = r.factory.call(void 0, ex, { url: r.url, resolve: function (s) { return resolve(s, r.url); } }); } catch (e) { r.error = e; return; }
            r.setters = res[0];
            r.run = res[1];
            for (var i = 0; i < r.depRecs.length; i++) instantiate(r.depRecs[i]);
        };
        var linkStars = function (r) {
            if (r.starsDone || r.error || !r.ns) return;
            r.starsDone = true;
            for (var i = 0; i < (r.stars || []).length; i++) {
                var d = r.depRecs[r.stars[i]];
                if (!d || !d.ns) continue;
                linkStars(d);
                var names = Object.getOwnPropertyNames(d.ns);
                for (var j = 0; j < names.length; j++) {
                    if (names[j] === 'default' || hasOwnP.call(r.ns, names[j])) continue;
                    getter(r.ns, names[j], (function (dns, n) { return function () { return dns[n]; }; })(d.ns, names[j]));
                }
            }
        };
        var linkSetters = function (r) {
            if (r.linked || r.error || !r.setters) return;
            r.linked = true;
            for (var i = 0; i < r.depRecs.length; i++) { linkStars(r.depRecs[i]); r.setters[i](r.depRecs[i].ns || makeNS()); linkSetters(r.depRecs[i]); }
        };
        var running = 0;
        var isThenable = function (x) { return !!x && typeof x.then === 'function'; };
        // runs r after its dependencies and returns its error; a promise of it when a module on the way awaits at its
        // top level (its run returns a promise, and whatever depends on it waits). path: the modules on the way here
        var execute = function (r, path) {
            if (path && path[r.url] === 1) return r.error;   // a dependency cycle back to a running module: skipped, as with real modules
            if (r.state >= 2) return r.pending || r.error;
            r.state = 2;
            var deps = r.depRecs || [], i = 0, mine = Object.create(path || null);
            mine[r.url] = 1;
            var finish = function (err) { if (err && !r.error) r.error = err; r.state = 3; r.pending = null; return r.error; };
            var go = function () {
                for (; i < deps.length; i++) {
                    var res = execute(deps[i], mine);
                    if (isThenable(res)) { i++; return res.then(function (e) { if (e && !r.error) r.error = e; return go(); }); }
                    if (res && !r.error) r.error = res;
                }
                if (r.error || !r.run) return finish(null);
                var out;
                running++;
                try { out = r.run.call(void 0); } catch (e) { running--; return finish(e); }
                running--;
                if (isThenable(out)) return out.then(function () { return finish(null); }, function (e) { return finish(e || new Error('Module ' + r.url + ' failed')); });
                return finish(null);
            };
            var result = go();
            if (isThenable(result)) r.pending = result;
            return result;
        };
        var evaluate = function (r) {
            return fetchAll(r).then(function () {
                instantiate(r);
                linkStars(r);
                linkSetters(r);
                return P.resolve(execute(r)).then(function (err) {
                    if (err) throw err;
                    return r.ns;
                });
            });
        };
        var report = function (e) { try { if (window.console && console.error) console.error(e); } catch (x) {} };
        // (a script element inserted by a script gets its load/error event once its module ran)
        var fire = function (el, type) {
            if (!el) return;
            try { var ev = document.createEvent('Event'); ev.initEvent(type, false, false); el.dispatchEvent(ev); } catch (e) {}
        };
        var drain = function () {
            if (draining || document.readyState === 'loading') return;
            var item = queue.shift();
            if (!item) return;
            draining = true;
            var next = function () { draining = false; drain(); };
            item.p.then(function () { return evaluate(item.r); }).then(function () { fire(item.el, 'load'); next(); }, function (e) { report(e); fire(item.el, 'error'); next(); });
        };
        // modules run after the document is parsed, often after DOMContentLoaded/load already happened here: listeners
        // they add for those while they run are called anyway (real modules run before both)
        var fired = { DOMContentLoaded: false, load: false };
        document.addEventListener('DOMContentLoaded', function () { fired.DOMContentLoaded = true; drain(); }, false);
        window.addEventListener('load', function () { fired.load = true; drain(); }, false);
        if (document.readyState !== 'loading') fired.DOMContentLoaded = true;
        if (document.readyState === 'complete') fired.load = true;
        // (the late call made in a function of its own and no arguments object: a function that makes a closure, or
        // reads arguments, pays for it on every call here)
        var callLate = function (target, type, fn) {
            setTimeout(function () { try { if (typeof fn === 'function') fn.call(target, { type: type, target: document }); else if (fn.handleEvent) fn.handleEvent({ type: type, target: document }); } catch (e) { report(e); } }, 0);
        };
        var lateListeners = function (target, orig) {
            return function (type, fn, options) {
                var r = orig.call(this, type, fn, options);
                if (running && fired[type] && fn && (type === 'DOMContentLoaded' || type === 'load')) callLate(target, type, fn);
                return r;
            };
        };
        try { document.addEventListener = lateListeners(document, document.addEventListener); } catch (e1) {}
        try { window.addEventListener = lateListeners(window, window.addEventListener); } catch (e2) {}
        var api = {
            define: function (url, deps, factory) { var r = record(url); if (!r.factory) { r.deps = deps; r.factory = factory; r.error = null; } },
            fail: function (url, message) {
                var e = new SyntaxError('Module ' + url + ' could not be lowered: ' + message);
                if (/memory/.test(message)) e.__brNoRoom = true;   // (see fetchRecord)
                record(url).error = e;
            },
            // a <script type="module">: src (resolved against the document) or the id of an inline module defined before
            entry: function (src, id, el) {
                var r = record(id || toURL(src, document.baseURI));
                queue.push({ r: r, p: fetchAll(r), el: el || null });
                drain();
            },
            'import': function (spec, base) {
                var url;
                try { url = resolve(String(spec), base || document.baseURI); } catch (e) { return P.reject(e); }
                return evaluate(record(url));
            },
            records: records
        };
        window.__brModules = api;
        window.__brImport = api['import'];
        // (module scripts run here, so the feature pages look for says so: GOV.UK Frontend starts its components only
        // where 'noModule' in HTMLScriptElement.prototype, "not supported in this browser" otherwise)
        var HSp = window.HTMLScriptElement && window.HTMLScriptElement.prototype;
        if (HSp && !('noModule' in HSp)) try {
            Object.defineProperty(HSp, 'noModule', { configurable: true,
                get: function () { return this.hasAttribute('nomodule'); },
                set: function (v) { if (v) this.setAttribute('nomodule', ''); else this.removeAttribute('nomodule'); } });
        } catch (eNM) {}

        // <script type="module"> elements that scripts insert (the engine ignores the type): a src is loaded like the
        // document's; a data: URL or inline text is defined here, plain code without import/export in a function
        // of its own (module scope, strict), anything else lowered by the page's transpiler
        // (window.__brTestModuleType: another type for tests in engines that run modules themselves)
        var isModuleScript = function (n) {
            if (!n || n.nodeType !== 1 || n.nodeName !== 'SCRIPT' || n.__brModule) return false;
            var t = n.getAttribute('type') || '';
            return /^\s*module\s*$/i.test(t) || (!!window.__brTestModuleType && t === window.__brTestModuleType);
        };
        var dataText = function (url) {
            var m = /^data:([^,]*),([\s\S]*)$/i.exec(url);
            if (!m) return null;
            try { return /;base64$/i.test(m[1]) ? window.atob(m[2]) : decodeURIComponent(m[2]); } catch (e) { return null; }
        };
        var inlineCount = 0, IMPORT_EXPORT = /(^|[;}\s])(import|export)\b/;
        var defineText = function (text, id) {
            var F = window.Function.__brNative || window.Function, body = null;
            if (!IMPORT_EXPORT.test(text)) {
                try { body = F('"use strict";\n' + text); } catch (e) { body = null; }
                if (body) {
                    api.define(id, [], function () { return [[], function () { body.call(void 0); }]; });
                    return true;
                }
            }
            if (!window.__brTranspiler || !window.__brTranspiler()) return false;
            var code = '';
            try { code = window.JSFix.run(text, JSON.stringify({ module: true, url: id })); } catch (e2) { code = ''; }
            if (!code) return false;
            try { (0, eval)(code); } catch (e3) { record(id).error = e3; }
            return true;
        };
        var startModule = function (el) {
            if (!isModuleScript(el)) return;
            el.__brModule = true;
            var src = el.getAttribute('src');
            if (src && !/^data:/i.test(src)) { api.entry(src, null, el); return; }
            // (the rewriter names the document's inline modules <page>#module-<n>)
            var text = src ? dataText(src) : el.text, id = document.baseURI.replace(/#.*$/, '') + '#inserted-module-' + (++inlineCount);
            if (text === null || !defineText(text, id)) { setTimeout(function () { fire(el, 'error'); }, 0); return; }
            api.entry(null, id, el);
        };
        // classic inline scripts that scripts insert (loaders, jQuery's globalEval, ad tags): text the old engine cannot
        // parse (ES2015+, a function declared in a block of strict code) is lowered by the page's transpiler before the
        // element goes in (it runs when inserted)
        var CLASSIC_TYPE = /^\s*$|^\s*(text|application)\/(x-)?(java|ecma)script\s*(;.*)?$|^\s*text\/jscript\s*$/i;
        var lowerClassic = function (n) {
            if (!n || n.nodeType !== 1 || n.nodeName !== 'SCRIPT' || n.__brClassic) return;
            // a script file in CORS mode: as in the documents (see cssfix.js), the engine refused to run a file it had
            // loaded without the attribute (Airbnb's loader asks again for chunks the document loaded, crossorigin=
            // "anonymous": error events, "Failed to async require", no page)
            if (n.getAttribute('src') !== null) { if (n.hasAttribute('crossorigin')) n.removeAttribute('crossorigin'); return; }
            var t = n.getAttribute('type');
            if (t !== null && !CLASSIC_TYPE.test(t)) return;
            try { n.__brClassic = true; } catch (e0) {}
            var text = n.text;
            if (!text || !/\S/.test(text)) return;
            var F = window.Function.__brNative || window.Function;
            // (a big one goes straight to the app, which remembers which texts need nothing too)
            if (text.length < 65536) try { F(text); return; } catch (e) { if (!(e instanceof SyntaxError)) return; }
            var byApp = window.__brLowerByApp ? window.__brLowerByApp(text) : null;
            if (byApp !== null) { if (byApp) n.text = byApp; return; }
            if (text.length >= 65536) try { F(text); return; } catch (e1) { if (!(e1 instanceof SyntaxError)) return; }
            if (!window.__brTranspiler || !window.__brTranspiler()) return;
            var out = '';
            try { out = window.JSFix.run(text, '{}'); } catch (e2) { out = ''; }
            if (out) n.text = out;
        };
        var inDocument = function (n) { return !!n && !!document.documentElement && document.documentElement.contains(n); };
        // the scripts inside a node that is a script or a fragment (null: none); classic ones are lowered on the way
        var scriptsIn = function (n) {
            var scripts = null, inner, k;
            if (n.nodeName === 'SCRIPT') { if (isModuleScript(n)) scripts = [n]; else lowerClassic(n); }
            else if (n.nodeType === 11 && n.querySelectorAll) {
                inner = n.querySelectorAll('script');
                for (k = 0; k < inner.length; k++) { if (isModuleScript(inner[k])) (scripts || (scripts = [])).push(inner[k]); else lowerClassic(inner[k]); }
            }
            return scripts;
        };
        var startIn = function (scripts) { for (var i = 0; i < scripts.length; i++) if (inDocument(scripts[i])) startModule(scripts[i]); };
        // appendChild, insertBefore, replaceChild: the node alone - no arguments object, no array for the usual node that
        // is no script (every insertion of the page comes through here, reading arguments costs a microsecond a call)
        var watchOne = function (proto, name) {
            var orig = proto && proto[name];
            if (typeof orig !== 'function' || orig.__brModules) return;
            var wrapped = function (n, ref) {
                var scripts = n && typeof n === 'object' && (n.nodeType === 11 || n.nodeName === 'SCRIPT') ? scriptsIn(n) : null;
                var r = orig.call(this, n, ref);
                if (scripts !== null) startIn(scripts);
                return r;
            };
            wrapped.__brModules = true;
            try { proto[name] = wrapped; } catch (e) {}
        };
        var watchInsert = function (proto, name) {
            var orig = proto && proto[name];
            if (typeof orig !== 'function' || orig.__brModules) return;
            var wrapped = function () {
                var scripts = [];
                for (var a = 0; a < arguments.length; a++) {
                    var n = arguments[a];
                    if (!n || typeof n !== 'object') continue;
                    if (isModuleScript(n)) scripts.push(n);
                    else if (n.nodeName === 'SCRIPT') lowerClassic(n);
                    else if (n.nodeType === 11 && n.querySelectorAll) { var inner = n.querySelectorAll('script'); for (var k = 0; k < inner.length; k++) { if (isModuleScript(inner[k])) scripts.push(inner[k]); else lowerClassic(inner[k]); } }
                    if (name === 'insertBefore' || name === 'replaceChild') break;   // (the second argument is the reference node)
                }
                var r = orig.apply(this, arguments);
                for (var i = 0; i < scripts.length; i++) if (inDocument(scripts[i])) startModule(scripts[i]);
                return r;
            };
            wrapped.__brModules = true;
            try { proto[name] = wrapped; } catch (e) {}
        };
        var NodeP = window.Node && Node.prototype, ElementP = window.Element && Element.prototype;
        watchOne(NodeP, 'appendChild');
        watchOne(NodeP, 'insertBefore');
        watchOne(NodeP, 'replaceChild');
        watchInsert(ElementP, 'append');
        watchInsert(ElementP, 'prepend');
        watchInsert(ElementP, 'before');
        watchInsert(ElementP, 'after');
        watchInsert(ElementP, 'replaceWith');
    })();
    // ---- Saved passwords (kept by the app in the keychain): a login's name and password go to the app when the form is
    // sent - submit, Enter in the password field, or a click on a button of its form (pages that log in by script) -
    // and the app offers to keep them; when a password or name field gets the focus on a site with kept logins the app
    // offers to fill them in (window.__brFillLogin, on the user's tap only). Both messages carry the token the app puts
    // into the top document when it has loaded or when asked (window.__brLoginToken, new for every page): the app takes no message
    // without it, so a frame of another site - an ad, a widget - can neither raise "Save password?" for the site on
    // screen nor overwrite a kept login. Frames never get the token and send nothing.
    (function () {
        var token = function () { var t = window.top === window ? window.__brLoginToken : null; return typeof t === 'string' && t ? t : null; };
        // (the app gives it when the page has loaded, which on a heavy page can take a minute: until then it is asked for -
        // the main frame alone, at once and then every 2 s while one waits - and comes within half a second)
        var askToken = function (tries) { if (tries % 4 === 0 && window.top === window) sendToApp('brpwtoken', '1'); };
        var isPassword = function (el) { return !!el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password'; };
        var isName = function (el) {
            if (!el || el.tagName !== 'INPUT') return false;
            var t = String(el.type || 'text').toLowerCase(), ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
            return (t === 'text' || t === 'email' || t === 'tel') && (ac.indexOf('username') >= 0 || ac === 'email' || t === 'email' || /user|login|mail|name|jmeno|ucet/i.test((el.name || '') + ' ' + (el.id || '')));
        };
        var scope = function (el) { return el.form || document; };
        // the password field of a form or of the page with something typed in it, and the name field before it
        var findLogin = function (root) {
            var inputs = root.getElementsByTagName('input'), pass = null, user = null, i;
            for (i = 0; i < inputs.length; i++) if (isPassword(inputs[i]) && inputs[i].value) { pass = inputs[i]; break; }
            if (!pass) return null;
            for (i = 0; i < inputs.length && inputs[i] !== pass; i++) {
                var t = String(inputs[i].type || 'text').toLowerCase();
                if ((t === 'text' || t === 'email' || t === 'tel') && inputs[i].value) user = inputs[i];
            }
            return { pass: pass, user: user };
        };
        var lastSent = '', lastTime = 0;
        // (a login sent by script before the page has loaded goes once the token is there, should the page still be on)
        var send = function (user, pass, tries) {
            var t = token();
            if (!t) { if (tries < 60) { askToken(tries); setTimeout(function () { send(user, pass, tries + 1); }, 500); } return; }
            var key = user + '\n' + pass, now = Date.now();
            if (key === lastSent && now - lastTime < 10000) return;
            lastSent = key; lastTime = now;
            sendToApp('brpw', JSON.stringify({ h: location.host, u: user, p: pass, t: t }));
        };
        var offer = function (root) {
            var login = window.top === window ? findLogin(root) : null;
            if (login) send(login.user ? login.user.value : '', login.pass.value, 0);
        };
        document.addEventListener('submit', function (e) { if (e.target && e.target.tagName === 'FORM') offer(e.target); }, true);
        document.addEventListener('keydown', function (e) { if ((e.keyCode === 13) && isPassword(e.target)) offer(scope(e.target)); }, true);
        document.addEventListener('click', function (e) {
            for (var el = e.target, n = 0; el && el.nodeType === 1 && n < 4; el = el.parentNode, n++) {
                var t = el.tagName;
                if (t === 'BUTTON' || (t === 'INPUT' && /^(submit|button|image)$/i.test(el.type)) || el.getAttribute('role') === 'button') { offer(el.form || document); return; }
            }
        }, true);
        // (a field focused before the page has loaded - autofocus - asks once the token is there, if it still has the focus)
        var asked = false;
        var ask = function (tries) {
            var el = document.activeElement, t = token();
            if (tries && !(isPassword(el) || isName(el))) { asked = false; return; }
            if (!t) { if (tries < 60) { askToken(tries); setTimeout(function () { ask(tries + 1); }, 500); } else asked = false; return; }
            sendToApp('brpwfocus', JSON.stringify({ h: location.host, t: t }));
        };
        document.addEventListener('focusin', function (e) {
            if (asked || window.top !== window || !(isPassword(e.target) || isName(e.target))) return;
            asked = true;
            ask(0);
        }, true);
        // (a page with a password field asks for the token as soon as its document is there: a form sent before the page
        // has loaded, which navigates away at once, then still has it)
        if (window.top === window) document.addEventListener('DOMContentLoaded', function () {
            if (token()) return;
            var inputs = document.getElementsByTagName('input');
            for (var i = 0; i < inputs.length; i++) if (isPassword(inputs[i])) { askToken(0); return; }
        }, false);
        // (from the app, after the user's tap: the fields get the values and the events a typing user would give; fixed
        // in place, so a script of the page cannot put itself where the app hands over the password)
        var fill = function (user, pass) {
            var active = document.activeElement, inputs = document.getElementsByTagName('input'), pw = isPassword(active) ? active : null, i;
            for (i = 0; !pw && i < inputs.length; i++) if (isPassword(inputs[i]) && inputs[i].offsetWidth > 0) pw = inputs[i];
            var name = null;
            for (i = 0; i < inputs.length; i++) {
                if (inputs[i] === pw) break;
                var t = String(inputs[i].type || 'text').toLowerCase();
                if ((t === 'text' || t === 'email' || t === 'tel') && inputs[i].offsetWidth > 0) name = inputs[i];
            }
            var set = function (el, v) {
                if (!el || v === undefined || v === null) return;
                el.focus();
                el.value = v;
                var ev = document.createEvent('Event');
                ev.initEvent('input', true, true); el.dispatchEvent(ev);
                ev = document.createEvent('Event');
                ev.initEvent('change', true, true); el.dispatchEvent(ev);
            };
            if (name && user) set(name, user);
            if (pw) set(pw, pass);
            return pw ? 'filled' : (name ? 'name' : 'none');
        };
        try { Object.defineProperty(window, '__brFillLogin', { value: fill, writable: false, configurable: false, enumerable: false }); } catch (eF) {
            try { if (!window.__brFillLogin) window.__brFillLogin = fill; } catch (eG) {}
        }
    })();
    // ---- CompressionStream / DecompressionStream (gzip, deflate, deflate-raw): inflate after RFC 1951 in the manner of
    // zlib's puff, deflate with LZ77 matches in the fixed Huffman code (smaller, if not as small as zlib's); the bytes
    // are collected and come out when the stream closes
    /*! The inflate code below (huffman, inflate) is an altered version - a JavaScript port - of puff.c from zlib's
     * contrib/puff, whose notice follows:
     * puff.h
     * Copyright (C) 2002-2013 Mark Adler, all rights reserved
     * version 2.3, 21 Jan 2013
     * This software is provided 'as-is', without any express or implied warranty. In no event will the author be held
     * liable for any damages arising from the use of this software.
     * Permission is granted to anyone to use this software for any purpose, including commercial applications, and to
     * alter it and redistribute it freely, subject to the following restrictions:
     * 1. The origin of this software must not be misrepresented; you must not claim that you wrote the original
     *    software. If you use this software in a product, an acknowledgment in the product documentation would be
     *    appreciated but is not required.
     * 2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original
     *    software.
     * 3. This notice may not be removed or altered from any source distribution.
     * Mark Adler    madler@alumni.caltech.edu
     */
    (function () {
        var TS = window.TransformStream;
        if (!TS || (window.CompressionStream && window.DecompressionStream)) return;
        var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
        var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
        var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
        var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
        var ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        var bad = function (why) { return new TypeError(why || 'The compressed data was not valid.'); };
        var CRC = null;
        var crc32 = function (b) {
            var i, c;
            if (!CRC) { CRC = []; for (var n = 0; n < 256; n++) { c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
            c = 0xFFFFFFFF;
            for (i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
            return (c ^ 0xFFFFFFFF) >>> 0;
        };
        var adler32 = function (b) {
            var a = 1, s = 0, i = 0;
            while (i < b.length) {
                var end = Math.min(b.length, i + 5552);
                for (; i < end; i++) { a += b[i]; s += a; }
                a %= 65521; s %= 65521;
            }
            return ((s * 65536) + a) >>> 0;
        };
        // a canonical Huffman code from code lengths: how many codes of each length, the symbols in code order, and
        // what is left of the code space (negative: over-subscribed, positive: incomplete)
        var huffman = function (lengths, n) {
            var count = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], offs = [0, 0], symbol = [], i, left = 1;
            for (i = 0; i < n; i++) count[lengths[i]]++;
            if (count[0] === n) return { count: count, symbol: symbol, left: 0, empty: true };
            for (i = 1; i < 16; i++) { left = left * 2 - count[i]; if (left < 0) return { count: count, symbol: symbol, left: left }; }
            for (i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
            for (i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
            return { count: count, symbol: symbol, left: left };
        };
        var FIXED = null;
        // the deflate data of src from pos: the bytes, and where the data ended
        var inflate = function (src, pos) {
            var bitbuf = 0, bitcnt = 0, out = new Uint8Array(Math.max(1024, src.length * 3)), outLen = 0;
            var need = function (n) {
                var val = bitbuf;
                while (bitcnt < n) { if (pos >= src.length) throw bad(); val |= src[pos++] << bitcnt; bitcnt += 8; }
                bitbuf = val >>> n; bitcnt -= n;
                return val & ((1 << n) - 1);
            };
            var grow = function (min) { var o = new Uint8Array(Math.max(out.length * 2, min)); o.set(out.subarray(0, outLen)); out = o; };
            var decode = function (h) {
                var code = 0, first = 0, index = 0;
                for (var len = 1; len < 16; len++) {
                    code |= need(1);
                    var count = h.count[len];
                    if (code - count < first) return h.symbol[index + (code - first)];
                    index += count; first += count; first <<= 1; code <<= 1;
                }
                throw bad();
            };
            var codes = function (lc, dc) {
                for (;;) {
                    var sym = decode(lc);
                    if (sym < 256) { if (outLen === out.length) grow(outLen + 1); out[outLen++] = sym; continue; }
                    if (sym === 256) return;
                    sym -= 257;
                    if (sym >= 29) throw bad();
                    var len = LBASE[sym] + need(LEXT[sym]), d = decode(dc);
                    if (d >= 30) throw bad();
                    var dist = DBASE[d] + need(DEXT[d]);
                    if (dist > outLen) throw bad();
                    if (outLen + len > out.length) grow(outLen + len);
                    for (var k = 0; k < len; k++) { out[outLen] = out[outLen - dist]; outLen++; }
                }
            };
            var lengths, i, last;
            do {
                last = need(1);
                var type = need(2);
                if (type === 0) {
                    bitbuf = 0; bitcnt = 0;   // (to the byte boundary)
                    if (pos + 4 > src.length) throw bad();
                    var slen = src[pos] | (src[pos + 1] << 8), nlen = src[pos + 2] | (src[pos + 3] << 8);
                    pos += 4;
                    if (slen !== (~nlen & 0xFFFF) || pos + slen > src.length) throw bad();
                    if (outLen + slen > out.length) grow(outLen + slen);
                    out.set(src.subarray(pos, pos + slen), outLen);
                    outLen += slen; pos += slen;
                } else if (type === 1) {
                    if (!FIXED) {
                        var fl = [], fd = [];
                        for (i = 0; i < 288; i++) fl[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
                        for (i = 0; i < 30; i++) fd[i] = 5;
                        FIXED = [huffman(fl, 288), huffman(fd, 30)];
                    }
                    codes(FIXED[0], FIXED[1]);
                } else if (type === 2) {
                    var nl = need(5) + 257, nd = need(5) + 1, nc = need(4) + 4;
                    if (nl > 286 || nd > 30) throw bad();
                    lengths = [];
                    for (i = 0; i < 19; i++) lengths[i] = 0;
                    for (i = 0; i < nc; i++) lengths[ORDER[i]] = need(3);
                    var cl = huffman(lengths, 19);
                    if (cl.left !== 0 || cl.empty) throw bad();
                    lengths = [];
                    var at = 0;
                    while (at < nl + nd) {
                        var s = decode(cl), rep, val = 0;
                        if (s < 16) { lengths[at++] = s; continue; }
                        if (s === 16) { if (at === 0) throw bad(); val = lengths[at - 1]; rep = 3 + need(2); }
                        else if (s === 17) rep = 3 + need(3);
                        else rep = 11 + need(7);
                        if (at + rep > nl + nd) throw bad();
                        while (rep--) lengths[at++] = val;
                    }
                    if (!lengths[256]) throw bad();
                    var lc = huffman(lengths, nl), dc = huffman(lengths.slice(nl), nd);
                    // (an incomplete code only as a single code of length 1)
                    if (lc.left < 0 || (lc.left > 0 && nl !== lc.count[0] + lc.count[1])) throw bad();
                    if (dc.left < 0 || (dc.left > 0 && nd !== dc.count[0] + dc.count[1])) throw bad();
                    codes(lc, dc);
                } else throw bad();
            } while (!last);
            return { out: out.subarray(0, outLen), end: pos };
        };
        // deflate data in one fixed-code block: LZ77 matches over a 32 KB window (hash chains of 32 at most)
        var deflate = function (src) {
            var out = [], bitbuf = 0, bitcnt = 0, n = src.length, i = 0, k;
            var put = function (v, nb) { bitbuf |= v << bitcnt; bitcnt += nb; while (bitcnt >= 8) { out.push(bitbuf & 255); bitbuf >>>= 8; bitcnt -= 8; } };
            // (Huffman codes go top bit first)
            var rev = function (code, len) { var r = 0; for (var j = 0; j < len; j++) { r = (r << 1) | (code & 1); code >>>= 1; } return r; };
            var sym = function (c) {
                if (c < 144) put(rev(0x30 + c, 8), 8);
                else if (c < 256) put(rev(0x190 + c - 144, 9), 9);
                else if (c < 280) put(rev(c - 256, 7), 7);
                else put(rev(0xC0 + c - 280, 8), 8);
            };
            put(1, 1); put(1, 2);   // (the last block, fixed codes)
            var HSIZE = 32768, head = [], prev = [];
            for (k = 0; k < HSIZE; k++) head[k] = -1;
            var hash = function (p) { return ((src[p] << 10) ^ (src[p + 1] << 5) ^ src[p + 2]) & (HSIZE - 1); };
            var insert = function (p) { var h = hash(p); prev[p & 32767] = head[h]; head[h] = p; };
            while (i < n) {
                var bestLen = 0, bestDist = 0;
                if (i + 2 < n) {
                    var cand = head[hash(i)], chain = 0, max = Math.min(258, n - i);
                    while (cand >= 0 && i - cand <= 32768 && chain++ < 32) {
                        if (src[cand + bestLen] === src[i + bestLen]) {
                            var l = 0;
                            while (l < max && src[cand + l] === src[i + l]) l++;
                            if (l > bestLen) { bestLen = l; bestDist = i - cand; if (l === max) break; }
                        }
                        cand = prev[cand & 32767];
                    }
                }
                if (bestLen >= 3) {
                    var li = 0, di = 0;
                    while (li < 28 && LBASE[li + 1] <= bestLen) li++;
                    sym(257 + li); put(bestLen - LBASE[li], LEXT[li]);
                    while (di < 29 && DBASE[di + 1] <= bestDist) di++;
                    put(rev(di, 5), 5); put(bestDist - DBASE[di], DEXT[di]);
                    for (var stop = i + bestLen; i < stop; i++) if (i + 2 < n) insert(i);
                } else {
                    sym(src[i]);
                    if (i + 2 < n) insert(i);
                    i++;
                }
            }
            sym(256);
            if (bitcnt > 0) out.push(bitbuf & 255);
            return out;
        };
        var u32le = function (b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; };
        var pack = function (format, src) {
            var body = deflate(src), out;
            if (format === 'deflate-raw') return new Uint8Array(body);
            if (format === 'deflate') {
                var a = adler32(src);
                out = [0x78, 0x9C].concat(body, [(a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255]);
            } else {
                var c = crc32(src), size = src.length >>> 0;
                out = [0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 0, 255].concat(body, [c & 255, (c >>> 8) & 255, (c >>> 16) & 255, (c >>> 24) & 255,
                    size & 255, (size >>> 8) & 255, (size >>> 16) & 255, (size >>> 24) & 255]);
            }
            return new Uint8Array(out);
        };
        var unpack = function (format, src) {
            var r, p = 0;
            if (format === 'deflate-raw') r = inflate(src, 0);
            else if (format === 'deflate') {
                if (src.length < 2 || (src[0] & 15) !== 8 || ((src[0] << 8) | src[1]) % 31 || (src[1] & 32)) throw bad();
                r = inflate(src, 2);
                if (r.end + 4 > src.length) throw bad();
                if (((src[r.end] << 24) | (src[r.end + 1] << 16) | (src[r.end + 2] << 8) | src[r.end + 3]) >>> 0 !== adler32(r.out)) throw bad();
                r.end += 4;
            } else {
                if (src.length < 10 || src[0] !== 0x1F || src[1] !== 0x8B || src[2] !== 8) throw bad();
                var flags = src[3];
                p = 10;
                if (flags & 4) { if (p + 2 > src.length) throw bad(); p += 2 + (src[p] | (src[p + 1] << 8)); }
                if (flags & 8) { while (p < src.length && src[p] !== 0) p++; p++; }
                if (flags & 16) { while (p < src.length && src[p] !== 0) p++; p++; }
                if (flags & 2) p += 2;
                if (p > src.length) throw bad();
                r = inflate(src, p);
                if (r.end + 8 > src.length || u32le(src, r.end) !== crc32(r.out) || u32le(src, r.end + 4) !== (r.out.length >>> 0)) throw bad();
                r.end += 8;
            }
            if (r.end !== src.length) throw bad('Junk found after end of compressed data.');
            return r.out;
        };
        var bytesOf = function (chunk) {
            if (chunk instanceof Uint8Array) return chunk;
            if (window.ArrayBuffer && chunk instanceof window.ArrayBuffer) return new Uint8Array(chunk);
            if (chunk && chunk.buffer && typeof chunk.byteLength === 'number') return new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength);
            throw new TypeError("The provided value is not of type '(ArrayBuffer or ArrayBufferView)'");
        };
        var FORMATS = { gzip: 1, deflate: 1, 'deflate-raw': 1 };
        var make = function (self, format, compress, name) {
            format = String(format);
            if (!FORMATS.hasOwnProperty(format)) throw new TypeError("Failed to construct '" + name + "': Unsupported compression format: '" + format + "'");
            var parts = [], total = 0;
            var t = new TS({
                transform: function (chunk) {
                    var b = bytesOf(chunk);
                    if (b.length) { parts.push(new Uint8Array(b)); total += b.length; }
                },
                flush: function (c) {
                    var all = new Uint8Array(total), at = 0;
                    for (var i = 0; i < parts.length; i++) { all.set(parts[i], at); at += parts[i].length; }
                    parts = [];
                    try {
                        var out = compress ? pack(format, all) : unpack(format, all);
                        if (out.length) c.enqueue(out);
                    } catch (e) { c.error(e); throw e; }
                }
            });
            self.readable = t.readable;
            self.writable = t.writable;
        };
        function CompressionStream(format) { make(this, format, true, 'CompressionStream'); }
        function DecompressionStream(format) { make(this, format, false, 'DecompressionStream'); }
        if (!window.CompressionStream) window.CompressionStream = CompressionStream;
        if (!window.DecompressionStream) window.DecompressionStream = DecompressionStream;
    })();
    // ---- input.showPicker() (the old engine opens its pickers on focus, a file chooser on click), Response.json(),
    // setHTMLUnsafe() / getHTML() (no declarative shadow roots here: plain markup)
    (function () {
        var IP = window.HTMLInputElement && window.HTMLInputElement.prototype;
        if (IP && !IP.showPicker) IP.showPicker = function () {
            if (this.disabled || this.readOnly) throw domException('InvalidStateError', "Failed to execute 'showPicker' on 'HTMLInputElement': HTMLInputElement::showPicker() cannot be used on immutable controls.");
            try { this.focus(); if (String(this.type).toLowerCase() === 'file') this.click(); } catch (e) {}
        };
        var SP = window.HTMLSelectElement && window.HTMLSelectElement.prototype;
        if (SP && !SP.showPicker) SP.showPicker = function () { try { this.focus(); } catch (e) {} };
        var R = window.Response;
        if (R && !R.json && window.Headers) R.json = function (data, init) {
            var body = JSON.stringify(data);
            if (body === undefined) throw new TypeError("Failed to execute 'json' on 'Response': The data is not JSON serializable");
            init = init || {};
            var headers = new window.Headers(init.headers || {});
            if (!headers.has('content-type')) headers.set('content-type', 'application/json');
            return new R(body, { status: init.status === undefined ? 200 : init.status, statusText: init.statusText || '', headers: headers });
        };
        var owners = [window.Element && window.Element.prototype, window.ShadowRoot && window.ShadowRoot.prototype];
        for (var i = 0; i < owners.length; i++) {
            var O = owners[i];
            if (!O) continue;
            if (!O.setHTMLUnsafe) O.setHTMLUnsafe = function (html) { this.innerHTML = html; };
            if (!O.getHTML) O.getHTML = function () { return this.innerHTML; };
        }
    })();
    // ---- WebSockets through the app's network layer: WebCore opens wss:// with the system's TLS, which knows neither
    // today's ciphers nor today's root certificates (Let's Encrypt), so most secure sockets never opened. A wss://
    // socket asks the app for a local ws:// address (BRMediaProxy), which opens the real one with the app's own TLS and
    // passes the frames through. The engine's own socket goes only when the app gives no such address: once the relay
    // has the socket, a failure before it opens is 'error' and 'close' for the page, never a second try over the
    // system's TLS - an attacker on the way who made the relay's connection fail (a reset, a blocked connect) would get
    // the old ciphers and roots the app turns down. (A server the app's TLS refused gives an open socket closed at once,
    // reason "tls": an error and close 1015 for the page.) The page gets a socket object of the shims (the real URL, its events re-sent). Relative and http(s)
    // URLs are taken too, as today's browsers take them. (The same in worker-shims.js.)
    (function (G) {
        var Native = G.WebSocket;
        if (!Native || (typeof Native !== 'function' && typeof Native !== 'object') || Native.__brLocal || !Native.prototype) return;
        var resolve = function (u) {
            var s = String(u);
            if (/^wss?:\/\//i.test(s)) return s;
            var a = document.createElement('a');
            a.href = s;
            return a.href.replace(/^http(s?):/i, 'ws$1:');
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
                    // (a server the app's TLS refused: the relay closes with 4015 "tls", since WebCore refuses the reserved
                    // 1015 in a close frame; the page gets what a failed TLS handshake gives, an error and 1015. The relay
                    // failed before the socket opened: the page's one error, no second try - see above.)
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
    })(window);
    // ---- Library additions of ES2024-2026 that core-js 3.41 still counts among its proposals (the bundle leaves those
    // out, see build.yml): Array.fromAsync (Baseline 2024: bundles call it as it is), Uint8Array base64/hex,
    // Error.isError, Iterator.concat, and Symbol.dispose / Symbol.asyncDispose for TypeScript's lowered `using`
    (function () {
        var P = window.Promise, Sym = window.Symbol, U8 = window.Uint8Array, It = window.Iterator;
        var ITER = Sym && Sym.iterator, AITER = Sym && Sym.asyncIterator;
        var put = function (o, k, v) { try { Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: false }); } catch (e) { o[k] = v; } };
        var isObj = function (o) { return o !== null && (typeof o === 'object' || typeof o === 'function'); };
        if (Sym) {
            if (!Sym.dispose) try { Object.defineProperty(Sym, 'dispose', { value: Sym('Symbol.dispose') }); } catch (e1) {}
            if (!Sym.asyncDispose) try { Object.defineProperty(Sym, 'asyncDispose', { value: Sym('Symbol.asyncDispose') }); } catch (e2) {}
        }
        if (!Error.isError) put(Error, 'isError', function (v) {
            if (!isObj(v)) return false;
            if (v instanceof Error || (window.DOMException && v instanceof window.DOMException)) return true;
            var t = Object.prototype.toString.call(v);
            return t === '[object Error]' || t === '[object DOMException]';
        });
        // (the standard's steps: an async iterable's values as they come, a sync iterable's and an array-like's awaited,
        // each mapped value awaited, the iterator closed when mapping or awaiting fails)
        if (!Array.fromAsync && P) put(Array, 'fromAsync', function (items, mapFn, thisArg) {
            var C = this;
            return new P(function (resolve, reject) {
                if (mapFn !== undefined && typeof mapFn !== 'function') throw new TypeError(mapFn + ' is not a function');
                if (items === null || items === undefined) throw new TypeError(items + ' is not iterable');
                var out, k = 0, it = null, isAsync = false, list = null, len = 0;
                var am = AITER ? items[AITER] : undefined, sm;
                if (am !== undefined && am !== null) { it = am.call(items); isAsync = true; }
                else if (ITER && (sm = items[ITER]) !== undefined && sm !== null) it = sm.call(items);
                else { list = Object(items); len = Math.min(Math.max(Math.floor(Number(list.length)) || 0, 0), 9007199254740991); }
                if (it !== null && !isObj(it)) throw new TypeError('Result of the Symbol.iterator method is not an object');
                out = typeof C === 'function' && C !== Array ? (list !== null ? new C(len) : new C()) : [];
                var close = function (e) {
                    var ret = it !== null ? it['return'] : undefined, r;
                    if (typeof ret !== 'function') { reject(e); return; }
                    try { r = ret.call(it); } catch (e2) { reject(e); return; }
                    if (isAsync) P.resolve(r).then(function () { reject(e); }, function () { reject(e); });
                    else reject(e);
                };
                var add = function (v) {
                    try { out[k] = v; } catch (e) { close(e); return; }
                    k++;
                    step();
                };
                var take = function (v) {
                    if (!mapFn) { add(v); return; }
                    var m;
                    try { m = mapFn.call(thisArg, v, k); } catch (e) { close(e); return; }
                    P.resolve(m).then(add, close);
                };
                var finish = function () { try { out.length = k; } catch (e) { reject(e); return; } resolve(out); };
                var got = function (r) {
                    if (!isObj(r)) { reject(new TypeError('Iterator result ' + r + ' is not an object')); return; }
                    if (r.done) finish();
                    else if (isAsync) take(r.value);
                    else P.resolve(r.value).then(take, close);
                };
                var step = function () {
                    if (list !== null) {
                        if (k >= len) finish();
                        else P.resolve(list[k]).then(take, reject);
                        return;
                    }
                    var r;
                    try { r = it.next(); } catch (e) { reject(e); return; }
                    if (isAsync) P.resolve(r).then(got, reject);
                    else got(r);
                };
                step();
            });
        });
        if (typeof It === 'function' && It.prototype && !It.concat && ITER) put(It, 'concat', function () {
            var list = [], j;
            for (j = 0; j < arguments.length; j++) {
                var o = arguments[j], m = isObj(o) ? o[ITER] : undefined;
                if (typeof m !== 'function') throw new TypeError(o + ' is not an iterable object');
                list.push([o, m]);
            }
            var at = 0, cur = null, done = false, res = Object.create(It.prototype);
            put(res, 'next', function () {
                while (!done) {
                    if (cur === null) {
                        if (at >= list.length) { done = true; break; }
                        var e = list[at++];
                        cur = e[1].call(e[0]);
                        if (!isObj(cur)) { done = true; throw new TypeError('Result of the Symbol.iterator method is not an object'); }
                    }
                    var r = cur.next();
                    if (!isObj(r)) throw new TypeError('Iterator result ' + r + ' is not an object');
                    if (r.done) { cur = null; continue; }
                    return { value: r.value, done: false };
                }
                return { value: undefined, done: true };
            });
            put(res, 'return', function () {
                var c = cur;
                done = true; cur = null;
                if (c !== null && typeof c['return'] === 'function') c['return']();
                return { value: undefined, done: true };
            });
            return res;
        });
        // Uint8Array.fromBase64 / fromHex, toBase64 / toHex and setFromBase64 / setFromHex, after the standard's
        // FromBase64 and FromHex (padding optional in the default "loose" mode, ASCII white space skipped)
        if (U8 && !U8.fromBase64) (function () {
            var STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', HEX = '0123456789abcdef', VAL = {}, i;
            for (i = 0; i < 64; i++) VAL[STD.charCodeAt(i)] = i;
            var isWS = function (c) { return c === 9 || c === 10 || c === 12 || c === 13 || c === 32; };
            var fail = function (read, bytes, msg) { return { read: read, bytes: bytes, error: new SyntaxError(msg) }; };
            var ok = function (read, bytes) { return { read: read, bytes: bytes, error: null }; };
            var options = function (o) {
                if (o === undefined) return {};
                if (!isObj(o)) throw new TypeError('The options argument must be an object');
                return o;
            };
            var alphabetOf = function (o) {
                var a = o.alphabet;
                if (a === undefined) return 'base64';
                if (a !== 'base64' && a !== 'base64url') throw new TypeError('The alphabet must be "base64" or "base64url"');
                return a;
            };
            var lastOf = function (o) {
                var l = o.lastChunkHandling;
                if (l === undefined) return 'loose';
                if (l !== 'loose' && l !== 'strict' && l !== 'stop-before-partial') throw new TypeError('lastChunkHandling must be "loose", "strict" or "stop-before-partial"');
                return l;
            };
            var needU8 = function (a) { if (!(a instanceof U8)) throw new TypeError('The receiver must be a Uint8Array'); };
            var needStr = function (s) { if (typeof s !== 'string') throw new TypeError('The input must be a string'); };
            // (2 to 4 sextets; false when strict and the bits past the last byte are not zero)
            var chunk = function (v, n, strict, out) {
                var b = (v[0] << 18) | (v[1] << 12) | ((n > 2 ? v[2] : 0) << 6) | (n > 3 ? v[3] : 0);
                var b0 = (b >> 16) & 255, b1 = (b >> 8) & 255, b2 = b & 255;
                if (n === 2) { if (strict && b1 !== 0) return false; out.push(b0); }
                else if (n === 3) { if (strict && b2 !== 0) return false; out.push(b0, b1); }
                else out.push(b0, b1, b2);
                return true;
            };
            var decode = function (s, alphabet, last, max) {
                var bytes = [], read = 0, v = [], n = 0, at = 0, len = s.length, c, x;
                if (max === 0) return ok(0, bytes);
                for (;;) {
                    while (at < len && isWS(s.charCodeAt(at))) at++;
                    if (at === len) {
                        if (n > 0) {
                            if (last === 'stop-before-partial') return ok(read, bytes);
                            if (last !== 'loose') return fail(read, bytes, 'Missing padding at the end of the base64 input');
                            if (n === 1) return fail(read, bytes, 'A lone base64 character at the end of the input');
                            chunk(v, n, false, bytes);
                        }
                        return ok(len, bytes);
                    }
                    c = s.charCodeAt(at++);
                    if (c === 61) {
                        if (n < 2) return fail(read, bytes, 'Unexpected padding in the base64 input');
                        while (at < len && isWS(s.charCodeAt(at))) at++;
                        if (n === 2) {
                            if (at === len) return last === 'stop-before-partial' ? ok(read, bytes) : fail(read, bytes, 'Incomplete padding in the base64 input');
                            if (s.charCodeAt(at) === 61) { at++; while (at < len && isWS(s.charCodeAt(at))) at++; }
                        }
                        if (at < len) return fail(read, bytes, 'Characters after the padding of the base64 input');
                        if (!chunk(v, n, last === 'strict', bytes)) return fail(read, bytes, 'Nonzero bits after the last byte of the base64 input');
                        return ok(len, bytes);
                    }
                    if (alphabet === 'base64url') {
                        if (c === 43 || c === 47) return fail(read, bytes, 'A base64 character that base64url does not have');
                        if (c === 45) c = 43; else if (c === 95) c = 47;
                    }
                    x = VAL[c];
                    if (x === undefined) return fail(read, bytes, 'An invalid character in the base64 input');
                    var room = max - bytes.length;
                    if ((room === 1 && n === 2) || (room === 2 && n === 3)) return ok(read, bytes);
                    v[n++] = x;
                    if (n === 4) {
                        chunk(v, 4, false, bytes);
                        n = 0; read = at;
                        if (bytes.length === max) return ok(read, bytes);
                    }
                }
            };
            var hexit = function (c) { return c >= 48 && c <= 57 ? c - 48 : (c | 32) >= 97 && (c | 32) <= 102 ? (c | 32) - 87 : -1; };
            var decodeHex = function (s, max) {
                var len = s.length, bytes = [], read = 0, h, l;
                if (len % 2) return fail(0, bytes, 'A hex string of odd length');
                while (read < len && bytes.length < max) {
                    h = hexit(s.charCodeAt(read)); l = hexit(s.charCodeAt(read + 1));
                    if (h < 0 || l < 0) return fail(read, bytes, 'An invalid character in the hex input');
                    bytes.push(h * 16 + l);
                    read += 2;
                }
                return ok(read, bytes);
            };
            var into = function (a, r) {
                for (var j = 0; j < r.bytes.length; j++) a[j] = r.bytes[j];
                if (r.error) throw r.error;
                return { read: r.read, written: r.bytes.length };
            };
            put(U8, 'fromBase64', function (s, opts) {
                needStr(s);
                var o = options(opts), alphabet = alphabetOf(o), r = decode(s, alphabet, lastOf(o), Infinity);
                if (r.error) throw r.error;
                return new U8(r.bytes);
            });
            put(U8, 'fromHex', function (s) {
                needStr(s);
                var r = decodeHex(s, Infinity);
                if (r.error) throw r.error;
                return new U8(r.bytes);
            });
            put(U8.prototype, 'setFromBase64', function (s, opts) {
                needU8(this); needStr(s);
                var o = options(opts), alphabet = alphabetOf(o);
                return into(this, decode(s, alphabet, lastOf(o), this.length));
            });
            put(U8.prototype, 'setFromHex', function (s) {
                needU8(this); needStr(s);
                return into(this, decodeHex(s, this.length));
            });
            put(U8.prototype, 'toBase64', function (opts) {
                needU8(this);
                var o = options(opts), alphabet = alphabetOf(o), omit = !!o.omitPadding, n = this.length, bin = '', j;
                for (j = 0; j < n; j += 4096) bin += String.fromCharCode.apply(null, Array.prototype.slice.call(this.subarray(j, Math.min(n, j + 4096))));
                var out = window.btoa(bin);
                if (alphabet === 'base64url') out = out.replace(/\+/g, '-').replace(/\//g, '_');
                return omit ? out.replace(/=+$/, '') : out;
            });
            put(U8.prototype, 'toHex', function () {
                needU8(this);
                var out = '', n = this.length, b;
                for (var j = 0; j < n; j++) { b = this[j]; out += HEX.charAt(b >> 4) + HEX.charAt(b & 15); }
                return out;
            });
        })();
    })();
    // ---- The attributes of document, window, navigator, location, screen and history are own non-configurable data
    // properties in the old engine (current browsers keep them as accessors on the prototypes, which pages wrap:
    // consent managers redefine document.cookie, sreality.cz threw there). Such a redefinition by the page is skipped
    // instead of throwing: the page's wrapper is not in place and the engine's own attribute keeps working. Elements
    // keep the error (object-fit-images and React check for it themselves). Last in the bundle: the shims above still
    // see the engine's own behaviour.
    (function () {
        var dp = Object.defineProperty, dps = Object.defineProperties, gopd = Object.getOwnPropertyDescriptor, tag = Object.prototype.toString;
        if (!dp || !gopd) return;
        var HOSTS = /^\[object (HTMLDocument|Document|DOMWindow|Window|global|Navigator|Location|Screen|History)\]$/;
        var host = function (o) {
            if (!o || (typeof o !== 'object' && typeof o !== 'function')) return false;
            if (o === window || o === document || o === window.navigator || o === window.location || o === window.screen || o === window.history) return true;
            try { return HOSTS.test(tag.call(o)); } catch (e) { return false; }
        };
        var fixed = function (o, k) {
            var d = null;
            try { d = gopd(o, k); } catch (e) { d = null; }
            return !!d && d.configurable === false;
        };
        var guarded = function (o, k, d) {
            try { return dp(o, k, d); } catch (e) {
                if (e instanceof TypeError && host(o) && fixed(o, k)) return o;
                throw e;
            }
        };
        // (anything but those objects, documents and objects of other frames goes on without the try: a function with
        // one makes a scope object per call here, and bundles define properties by the ten thousand)
        // (and a key that cannot be one of core-js's symbols goes to the engine's own right away, as in shims.js: a call less)
        var nav = window.navigator, loc = window.location, scr = window.screen, hist = window.history, Doc = window.Document;
        var engineDP = (window.__brNative || {}).defineProperty, OP = Object.prototype;
        Object.defineProperty = function defineProperty(o, k, d) {
            if (typeof o !== 'object' || o === null || (o !== window && o !== document && o !== nav && o !== loc && o !== scr && o !== hist &&
                o instanceof Object && !(Doc && o instanceof Doc))) {
                if (engineDP && typeof k === 'string' && k.charCodeAt(0) !== 83 && o !== OP && !(typeof o === 'function' && (k === 'name' || k === 'length'))) return engineDP(o, k, d);
                if (engineDP && typeof k === 'number' && o !== OP) return engineDP(o, k, d);   // (an array index, see shims.js)
                return dp(o, k, d);
            }
            return guarded(o, k, d);
        };
        if (dps) Object.defineProperties = function defineProperties(o, props) {
            try { return dps(o, props); } catch (e) {
                if (!(e instanceof TypeError) || !host(o) || !props) throw e;
                var keys = Object.keys(props);
                for (var i = 0; i < keys.length; i++) Object.defineProperty(o, keys[i], props[keys[i]]);
                return o;
            }
        };
    })();
})(window, document);
