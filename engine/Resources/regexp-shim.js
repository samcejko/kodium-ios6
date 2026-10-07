/*
 * RegExp flags and syntax the old engine refuses, for pages (polyfill bundle, before shims-extra.js) and for workers
 * (worker-polyfills.js): see the comment below. G is the global object of either.
 */
(function (G) {
// ---- RegExp flags and syntax the engine refuses. new RegExp(pattern, flags) asks the engine first; what it rejects
// is lowered: s (the dot matches everything), u and v (\u{...}, \p{...} and astral characters become surrogate
// pairs: the Unicode tables and jsfix.js are loaded once when a pattern needs them, otherwise the flag just goes),
// named groups (numbered; .groups on the results), y (exec/test only match at lastIndex) and d (.indices).
// Such expressions carry __brRe, and String.prototype.match/replace/matchAll go through their exec (as ES2015
// does), so .groups, $<name> and sticky matching work there too. The flag getters and RegExp.escape are added.
(function () {
    var Native = G.RegExp;
    if (!Native || Native.__brFlags) return;
    var proto = Native.prototype, nativeExec = proto.exec, hasOwnR = Object.prototype.hasOwnProperty;
    var nativeReplace = String.prototype.replace, nativeMatch = String.prototype.match;
    var hidden = function (o, k, v) { try { Object.defineProperty(o, k, { value: v, writable: true, configurable: true }); } catch (e) { o[k] = v; } };
    var ORDER = 'dgimsuvy';
    var flagsOf = function (re) {
        if (re.__brRe && re.__brRe.flags !== undefined) return re.__brRe.flags;
        return (re.global ? 'g' : '') + (re.ignoreCase ? 'i' : '') + (re.multiline ? 'm' : '');
    };
    // An app's page (window.__brLeanPage) keeps what was lowered, in its localStorage: the same expressions come at
    // every start (Kodium's workbench: marked's \p{...} rules - with jsfix.js and the Unicode tables loaded into the page
    // for them, 0.6 s of every start on the iPad 2)
    var KEPT_KEY = 'brLoweredRegExps', kept = null, keptTimer = null;
    var keptLowering = function (q) {
        if (G.__brLeanPage !== true) return undefined;
        if (kept === null) {
            try { kept = JSON.parse(G.localStorage.getItem(KEPT_KEY) || '{}') || {}; } catch (e) { kept = {}; }
        }
        return hasOwnR.call(kept, q) ? kept[q] : undefined;
    };
    var keepLowering = function (q, out) {
        if (G.__brLeanPage !== true || kept === null || typeof out !== 'string') return;
        kept[q] = out;
        if (!keptTimer) keptTimer = setTimeout(function () {
            keptTimer = null;
            try { G.localStorage.setItem(KEPT_KEY, JSON.stringify(kept)); } catch (e) {}
        }, 2000);
    };
    // jsfix.js (and the Unicode tables for \p{...}) from the app, once
    var unicodeLowering = function (tables) {
        var load = function (name) {
            var x = new XMLHttpRequest();
            x.open('GET', 'https://ios6-browser.invalid/' + name, false);
            x.send(null);
            if (x.status === 200 && x.responseText) (0, eval)(x.responseText);
        };
        try {
            if (tables && !G.JSFIX_UNICODE && !unicodeLowering.triedTables) { unicodeLowering.triedTables = true; load('unicode-props.js'); }
            if (!G.JSFix && !unicodeLowering.tried) { unicodeLowering.tried = true; load('jsfix.js'); }
        } catch (e) {}
        return !!(G.JSFix && G.JSFix.lowerUnicode);
    };
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
    // named groups: the names go, \k<name> becomes a numbered backreference; name -> group number(s)
    var namedGroups = function (p) {
        var names = {}, count = 0, out = '', inClass = false, i, c, e, k;
        for (i = 0; i < p.length; i++) {
            c = p.charAt(i);
            if (c === '\\') {
                if (!inClass && p.charAt(i + 1) === 'k' && p.charAt(i + 2) === '<') {
                    e = p.indexOf('>', i);
                    k = e > 0 ? p.slice(i + 3, e) : '';
                    if (e > 0 && hasOwnR.call(names, k)) { out += '\\' + (typeof names[k] === 'number' ? names[k] : names[k][0]); i = e; continue; }
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
                    k = p.slice(i + 3, e);
                    // (duplicate names in alternatives: the first group that took part)
                    if (hasOwnR.call(names, k)) names[k] = [].concat(names[k], count); else names[k] = count;
                    out += '(';
                    i = e;
                    continue;
                }
            }
            out += c;
        }
        return { pattern: out, names: names };
    };
    // what makes a u pattern differ from the same pattern without u: \p{...}, \u{...}, astral characters, and the
    // dot (which takes a whole surrogate pair)
    var NEEDS_UNICODE = /\\[pP]\{|\\u\{|[\ud800-\udfff]/;
    var hasDot = function (p) {
        var inClass = false;
        for (var i = 0; i < p.length; i++) {
            var c = p.charAt(i);
            if (c === '\\') { i++; continue; }
            if (inClass) { if (c === ']') inClass = false; continue; }
            if (c === '[') inClass = true;
            else if (c === '.') return true;
        }
        return false;
    };
    // A lookbehind at the very start of the pattern, (?<=X)rest or (?<!X)rest, with no alternation after it and no
    // groups of its own: {neg, behind: X, rest} (the engine has no lookbehind at all; the rest is searched and X tested
    // against the text before each candidate), else null. Other lookbehinds are not lowered.
    var leadingLookbehind = function (p) {
        if (!/^\(\?<[=!]/.test(p)) return null;
        var depth = 0, inClass = false, i, c, close = -1;
        for (i = 0; i < p.length; i++) {
            c = p.charAt(i);
            if (c === '\\') { i++; continue; }
            if (inClass) { if (c === ']') inClass = false; continue; }
            if (c === '[') { inClass = true; continue; }
            if (c === '(') depth++;
            else if (c === ')') { depth--; if (!depth) { close = i; break; } }
        }
        if (close < 0) return null;
        var behind = p.slice(4, close), rest = p.slice(close + 1);
        // (groups of its own would shift the numbers; alternatives after it would lose it; a second lookbehind)
        if (/\((?!\?)/.test(behind.replace(/\\./g, '')) || /\(\?<[=!]/.test(rest)) return null;
        depth = 0; inClass = false;
        for (i = 0; i < rest.length; i++) {
            c = rest.charAt(i);
            if (c === '\\') { i++; continue; }
            if (inClass) { if (c === ']') inClass = false; continue; }
            if (c === '[') inClass = true;
            else if (c === '(') depth++;
            else if (c === ')') depth--;
            else if (c === '|' && !depth) return null;
        }
        return { neg: p.charAt(3) === '!', behind: behind, rest: rest };
    };
    // {pattern, flags (for the engine), info} or null when it cannot be lowered
    var lower = function (source, flags) {
        var p = source, all = '', i, c, names = null, lb = null;
        for (i = 0; i < flags.length; i++) {
            c = flags.charAt(i);
            if (ORDER.indexOf(c) < 0 || all.indexOf(c) >= 0) return null;
            all += c;
        }
        var has = function (f) { return all.indexOf(f) >= 0; };
        if (has('u') && has('v')) return null;
        if (/\(\?<[=!]/.test(p)) {
            lb = leadingLookbehind(p);
            if (!lb) return null;
            p = lb.rest;
        }
        var unicode = function (q) {
            if (!(has('u') || has('v')) || !(NEEDS_UNICODE.test(q) || hasDot(q))) return q;
            var hit = keptLowering(q);
            if (hit !== undefined) return hit;
            if (!unicodeLowering(/\\[pP]\{/.test(q))) return null;
            try { var out = G.JSFix.lowerUnicode(q); keepLowering(q, out); return out; } catch (e) { return null; }
        };
        if (has('s')) p = dotAll(p);
        if (/\(\?<[A-Za-z_$]/.test(p)) { var r = namedGroups(p); p = r.pattern; names = r.names; }
        p = unicode(p);
        if (p === null) return null;
        var behind = null;
        if (lb) {
            behind = unicode(has('s') ? dotAll(lb.behind) : lb.behind);
            if (behind === null) return null;
            // (without a quantifier that repeats without end, what it matches is short: only the last 256 characters
            // before a candidate are tested)
            behind = { re: new Native('(?:' + behind + ')$', has('i') ? 'i' : ''), neg: lb.neg, bounded: !/[*+]|\{\d*,\}/.test(behind.replace(/\\./g, '')) };
        }
        var sorted = '';
        for (i = 0; i < ORDER.length; i++) if (has(ORDER.charAt(i))) sorted += ORDER.charAt(i);
        return { pattern: p, flags: (has('g') ? 'g' : '') + (has('i') ? 'i' : '') + (has('m') ? 'm' : ''),
                 info: { source: source, flags: sorted, names: names, sticky: has('y'), indices: has('d'), behind: behind } };
    };
    var groupsOf = function (m, names) {
        var g = {};
        for (var k in names) if (hasOwnR.call(names, k)) {
            var n = names[k];
            if (typeof n === 'number') { g[k] = m[n]; continue; }
            g[k] = undefined;
            for (var j = 0; j < n.length; j++) if (m[n[j]] !== undefined) { g[k] = m[n[j]]; break; }
        }
        return g;
    };
    // (until an expression with its own exec exists, String.prototype.match/replace/split go straight to the engine:
    // every replace of a page, 220,000 on nextjs.org, looked the property up on its expression)
    var anyLowered = false;
    hidden(G, '__brNoteLowered', function () { anyLowered = true; });
    var decorate = function (re, l) {
        var info = l.info, anchored = null, scan = null, behind = info.behind;
        hidden(re, '__brRe', info);
        if (info.names || info.sticky || info.indices || behind) anyLowered = true;
        // a leading lookbehind: candidates of the rest, each kept when the text before it does (not) end in X
        if (behind) scan = new Native(l.pattern, l.flags.indexOf('g') >= 0 ? l.flags : l.flags + 'g');
        // sticky: (?:pattern)|() always matches at lastIndex; the empty alternative taking it means no match there
        else if (info.sticky) anchored = new Native('(?:' + l.pattern + ')|()', l.flags.indexOf('g') >= 0 ? l.flags : l.flags + 'g');
        if (!anchored && !scan && !info.names && !info.indices) return re;
        hidden(re, 'exec', function (s) {
            s = String(s);
            var m;
            if (scan) {
                var moving = this.global || info.sticky, from = moving ? this.lastIndex : 0, c;
                m = null;
                while (from <= s.length) {
                    scan.lastIndex = from;
                    c = nativeExec.call(scan, s);
                    if (!c || (info.sticky && c.index !== from)) break;
                    if (behind.re.test(s.slice(behind.bounded ? Math.max(0, c.index - 256) : 0, c.index)) !== behind.neg) { m = c; break; }
                    if (info.sticky) break;
                    from = c.index + 1;
                }
                if (moving) this.lastIndex = m ? m.index + m[0].length : 0;
                if (!m) return null;
            } else if (anchored) {
                anchored.lastIndex = this.lastIndex;
                m = nativeExec.call(anchored, s);
                if (!m || m[m.length - 1] !== undefined) { this.lastIndex = 0; return null; }
                m.length--;
                this.lastIndex = anchored.lastIndex;
            } else m = nativeExec.call(this, s);
            if (!m) return m;
            if (info.names) m.groups = groupsOf(m, info.names);
            if (info.indices) {
                // (group positions: the first occurrence of the group's text within the match)
                var ind = [[m.index, m.index + m[0].length]];
                for (var i = 1; i < m.length; i++) {
                    var at = m[i] === undefined ? -1 : m[0].indexOf(m[i]);
                    ind.push(at < 0 ? undefined : [m.index + at, m.index + at + m[i].length]);
                }
                if (info.names) ind.groups = groupsOf(ind, info.names);
                m.indices = ind;
            }
            return m;
        });
        hidden(re, 'test', function (s) { return this.exec(s) !== null; });
        return re;
    };
    // (debugging, BRDebugJSErrors: a pattern the engine refuses even after lowering goes to the app's log)
    var logRefused = function (e, source, f) {
        if (!G.__brDebugErrors || !G.document) return;
        try {
            var fr = G.document.createElement('iframe');
            fr.style.display = 'none';
            fr.src = 'brlog:' + encodeURIComponent('RegExp refused (' + e.message + '): /' + String(source).slice(0, 400) + '/' + f);
            (G.document.body || G.document.documentElement).appendChild(fr);
            setTimeout(function () { if (fr.parentNode) fr.parentNode.removeChild(fr); }, 100);
        } catch (x) {}
    };
    // IsRegExp: Symbol.match says, else being one (a page's own core-js checks that RegExp(re) makes a new expression
    // when re[Symbol.match] is false, and put a RegExp of its own in place otherwise)
    var K_MATCH_RE = (function () { var s = G.Symbol && G.Symbol.match; return !s ? null : typeof s === 'symbol' ? s : String(s); })();
    var isRegExp = function (p) {
        if (p === null || (typeof p !== 'object' && typeof p !== 'function')) return false;
        var m = K_MATCH_RE !== null ? p[K_MATCH_RE] : undefined;
        return m !== undefined ? !!m : p instanceof Native;
    };
    // (the engine first, what it refuses lowered; the tries in a function of their own: a function with one costs
    // 2.3 us more on every call here)
    var build = function (source, f) {
        try { return new Native(source, f); } catch (e) {
            if (!(e instanceof SyntaxError)) throw e;
            var l = lower(source, f);
            if (!l) { logRefused(e, source, f); throw e; }
            try { return decorate(new Native(l.pattern, l.flags), l); } catch (e2) { logRefused(e2, source, f); throw e2; }
        }
    };
    // (a declaration: it keeps its name, and a named function expression reads every outer variable through a scope
    // object of its own here)
    var BRRegExp = RegExp;
    function RegExp(pattern, flags) {
        var isRe = pattern instanceof Native, isReg = isRegExp(pattern);
        // RegExp(re) is re
        if (!(this instanceof BRRegExp) && flags === undefined && isReg && pattern.constructor === BRRegExp) return pattern;
        // (an expression's own source and flags; another object that says it is one: its source and flags properties)
        var source = isRe ? (pattern.__brRe ? pattern.__brRe.source : pattern.source) : isReg ? String(pattern.source) : pattern === undefined ? '' : String(pattern);
        var f = flags === undefined ? (isRe ? flagsOf(pattern) : isReg ? String(pattern.flags) : '') : String(flags);
        return build(source, f);
    }
    BRRegExp.prototype = proto;
    hidden(proto, 'constructor', BRRegExp);
    hidden(BRRegExp, '__brFlags', true);
    // the legacy statics ($1..$9, lastMatch...) stay the engine's
    var statics = ['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', 'input', '$_', 'lastMatch', '$&', 'lastParen', '$+', 'leftContext', '$`', 'rightContext', "$'", 'multiline', '$*'];
    for (var si = 0; si < statics.length; si++) (function (k) {
        try { Object.defineProperty(BRRegExp, k, { get: function () { return Native[k]; }, set: function (v) { try { Native[k] = v; } catch (e) {} }, configurable: true }); } catch (e) {}
    })(statics[si]);
    if (!BRRegExp.escape) hidden(BRRegExp, 'escape', function escape(s) {
        if (typeof s !== 'string') throw new TypeError('RegExp.escape requires a string');
        var out = '', hex = function (c, w) { var h = c.toString(16); while (h.length < w) h = '0' + h; return h; };
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i), c = s.charCodeAt(i);
            if (i === 0 && /[0-9A-Za-z]/.test(ch)) { out += '\\x' + hex(c, 2); continue; }
            if ('^$\\.*+?()[]{}|/'.indexOf(ch) >= 0) { out += '\\' + ch; continue; }
            var ctl = { 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r' }[c];
            if (ctl) { out += '\\' + ctl; continue; }
            var lone = c >= 0xD800 && c <= 0xDFFF && !(c <= 0xDBFF && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xDC00 && s.charCodeAt(i + 1) <= 0xDFFF) &&
                       !(c >= 0xDC00 && i > 0 && s.charCodeAt(i - 1) >= 0xD800 && s.charCodeAt(i - 1) <= 0xDBFF);
            if (",-=<>#&!%:;@~'`\"".indexOf(ch) >= 0 || /\s/.test(ch) || lone) { out += c <= 0xFF ? '\\x' + hex(c, 2) : '\\u' + hex(c, 4); continue; }
            out += ch;
        }
        return out;
    });
    var getter = function (name, fn) {
        if (name in proto) return;
        try { Object.defineProperty(proto, name, { get: fn, configurable: true }); } catch (e) {}
    };
    var flagGetter = function (f) { return function () { return flagsOf(this).indexOf(f) >= 0; }; };
    // (flags of any object: its flag properties in the standard order - core-js calls this getter on a plain object
    // and, getting less than 'dgimsy' in that order, put a flags getter of its own in place)
    getter('flags', function () {
        if (this instanceof Native) return flagsOf(this);
        if (this === null || (typeof this !== 'object' && typeof this !== 'function')) throw new TypeError('RegExp.prototype.flags getter called on a non-object');
        var r = '';
        if (this.hasIndices) r += 'd';
        if (this.global) r += 'g';
        if (this.ignoreCase) r += 'i';
        if (this.multiline) r += 'm';
        if (this.dotAll) r += 's';
        if (this.unicode) r += 'u';
        if (this.unicodeSets) r += 'v';
        if (this.sticky) r += 'y';
        return r;
    });
    getter('sticky', flagGetter('y'));
    getter('unicode', flagGetter('u'));
    getter('unicodeSets', flagGetter('v'));
    getter('dotAll', flagGetter('s'));
    getter('hasIndices', flagGetter('d'));
    try { G.RegExp = BRRegExp; } catch (e) { return; }

    // String.prototype.match/replace/search/split as ES2015 has them: an object argument with a Symbol.match/replace/
    // search/split method (every regular expression: RegExp.prototype has them) is handed to it, and those go through
    // the expression's exec. A page's own core-js checks exactly that and, failing, put its own versions of all eight
    // in place, JS through and through (20-50 us a call here, a replace with a function or a split by a pattern far
    // more). An expression with the engine's exec (nearly all: literals, and lowered ones that only lost a u or s
    // flag) still takes the engine's method after two property reads; one with an exec of its own (named groups,
    // sticky, indices, a lookbehind, or a script's) is matched through that exec.
    // (an engine with symbols of its own delegates already - its String methods would call these, and these the String
    // methods again: nothing is put in place there, a lowered expression's exec is called by the engine's methods)
    var S = G.Symbol, nativeSymbols = !!S && typeof S.replace === 'symbol';
    var keyOf = function (sym) { return !sym || nativeSymbols ? null : typeof sym === 'symbol' ? sym : String(sym); };
    var K_MATCH = keyOf(S && S.match), K_REPLACE = keyOf(S && S.replace), K_SEARCH = keyOf(S && S.search), K_SPLIT = keyOf(S && S.split);
    var K_SPECIES = keyOf(S && S.species);
    var nativeSplit = String.prototype.split, nativeSearch = String.prototype.search;
    var isLowered = function (re) {
        if (typeof re !== 'object' || re === null) return false;
        var i = re.__brRe;
        return i !== undefined && !!(i.names || i.sticky || i.indices || i.behind);
    };
    var isObject = function (v) { return v !== null && (typeof v === 'object' || typeof v === 'function'); };
    var needObject = function (v, name) { if (!isObject(v)) throw new TypeError('RegExp.prototype.' + name + ' called on a non-object'); };
    var toLength = function (v) { v = +v; if (!(v > 0)) return 0; v = Math.floor(v); return v > 9007199254740991 ? 9007199254740991 : v; };
    var toInt = function (v) { v = +v; return v !== v ? 0 : v < 0 ? Math.ceil(v) : Math.floor(v); };
    // (the index after i: past a whole surrogate pair when matching by code points)
    var advance = function (s, i, unicode) {
        if (!unicode || i + 1 >= s.length) return i + 1;
        var c = s.charCodeAt(i), d = s.charCodeAt(i + 1);
        return c >= 0xD800 && c <= 0xDBFF && d >= 0xDC00 && d <= 0xDFFF ? i + 2 : i + 1;
    };
    var regExpExec = function (R, s) {
        var exec = R.exec;
        if (typeof exec === 'function') {
            var r = exec.call(R, s);
            if (r !== null && !isObject(r)) throw new TypeError('The result of exec must be an object or null');
            return r;
        }
        if (!(R instanceof Native)) throw new TypeError('RegExp exec called on an incompatible receiver');
        return nativeExec.call(R, s);
    };
    var hasUnicode = function (flags) { return flags.indexOf('u') >= 0 || flags.indexOf('v') >= 0; };
    // GetSubstitution: $$, $&, $`, $', $n / $nn, $<name> (literal without named groups)
    var substitute = function (matched, s, pos, caps, named, rep) {
        if (rep.indexOf('$') < 0) return rep;
        var tail = pos + matched.length, m = caps.length;
        return nativeReplace.call(rep, /\$([$&`']|\d\d?|<[^>]*>)/g, function (all, t) {
            var c = t.charAt(0);
            if (c === '$') return '$';
            if (c === '&') return matched;
            if (c === '`') return s.slice(0, pos);
            if (c === "'") return tail >= s.length ? '' : s.slice(tail);
            if (c === '<') { if (named === undefined) return all; var v = named[t.slice(1, -1)]; return v === undefined ? '' : String(v); }
            var n = +t;
            if (n >= 1 && n <= m) return caps[n - 1] === undefined ? '' : caps[n - 1];
            if (t.length === 2) { var n1 = +c; if (n1 >= 1 && n1 <= m) return (caps[n1 - 1] === undefined ? '' : caps[n1 - 1]) + t.charAt(1); }
            return all;
        });
    };
    var protoMatch = function (string) {
        var rx = this;
        needObject(rx, '@@match');
        var s = String(string);
        if (rx.exec === nativeExec && rx instanceof Native) return nativeMatch.call(s, rx);
        var flags = String(rx.flags);
        if (flags.indexOf('g') < 0) return regExpExec(rx, s);
        var fullUnicode = hasUnicode(flags), A = [], result, str;
        rx.lastIndex = 0;
        while ((result = regExpExec(rx, s)) !== null) {
            str = String(result[0]);
            A.push(str);
            if (str === '') rx.lastIndex = advance(s, toLength(rx.lastIndex), fullUnicode);
        }
        return A.length ? A : null;
    };
    var protoReplace = function (string, replaceValue) {
        var rx = this;
        needObject(rx, '@@replace');
        var s = String(string), fnRep = typeof replaceValue === 'function';
        if (rx.exec === nativeExec && rx instanceof Native) return nativeReplace.call(s, rx, replaceValue);
        if (!fnRep) replaceValue = String(replaceValue);
        var flags = String(rx.flags), global = flags.indexOf('g') >= 0, fullUnicode = false, results = [], result, i, n;
        if (global) { fullUnicode = hasUnicode(flags); rx.lastIndex = 0; }
        while ((result = regExpExec(rx, s)) !== null) {
            results.push(result);
            if (!global) break;
            if (String(result[0]) === '') rx.lastIndex = advance(s, toLength(rx.lastIndex), fullUnicode);
        }
        var acc = '', next = 0;
        for (i = 0; i < results.length; i++) {
            result = results[i];
            var nCaps = Math.max(toLength(result.length) - 1, 0), matched = String(result[0]);
            var pos = Math.max(Math.min(toInt(result.index), s.length), 0), caps = [], named = result.groups, rep;
            for (n = 1; n <= nCaps; n++) caps.push(result[n] === undefined ? undefined : String(result[n]));
            if (fnRep) {
                var args = [matched].concat(caps);
                args.push(pos, s);
                if (named !== undefined) args.push(named);
                rep = String(replaceValue.apply(undefined, args));
            } else rep = substitute(matched, s, pos, caps, named === undefined ? undefined : Object(named), replaceValue);
            if (pos >= next) { acc += s.slice(next, pos) + rep; next = pos + matched.length; }
        }
        return next >= s.length ? acc : acc + s.slice(next);
    };
    var protoSearch = function (string) {
        var rx = this;
        needObject(rx, '@@search');
        var s = String(string);
        if (rx.exec === nativeExec && rx instanceof Native) return nativeSearch.call(s, rx);
        var prev = rx.lastIndex;
        if (!(prev === 0 && 1 / prev > 0)) rx.lastIndex = 0;
        var result = regExpExec(rx, s), cur = rx.lastIndex;
        if (!(cur === prev && (cur !== 0 || 1 / cur === 1 / prev)) && !(cur !== cur && prev !== prev)) rx.lastIndex = prev;
        return result === null ? -1 : result.index;
    };
    var speciesOf = function (O, def) {
        var C = O.constructor;
        if (C === undefined) return def;
        if (!isObject(C)) throw new TypeError('object.constructor is not an object');
        var Sp = K_SPECIES !== null ? C[K_SPECIES] : undefined;
        if (Sp === undefined || Sp === null) return def;
        if (typeof Sp !== 'function') throw new TypeError('object.constructor[Symbol.species] is not a constructor');
        return Sp;
    };
    var protoSplit = function (string, limit) {
        var rx = this, i;
        needObject(rx, '@@split');
        var s = String(string);
        if (rx.exec === nativeExec && rx instanceof Native) return nativeSplit.call(s, rx, limit);
        var A = [], lim = limit === undefined ? 4294967295 : limit >>> 0, p = 0, q = 0, z, e;
        if (!lim) return A;
        if (isLowered(rx)) {
            // (one of ours: a global search stands in for the sticky one of the standard - a match found further on
            // is the sticky match at that position - instead of an exec at every index)
            var g = new BRRegExp(rx.__brRe.source, rx.__brRe.flags.replace(/[gy]/g, '') + 'g');
            if (!s.length) return g.exec(s) ? A : [s];
            while (q < s.length) {
                g.lastIndex = q;
                z = g.exec(s);
                if (!z || z.index >= s.length) break;
                e = z.index + z[0].length;
                if (e === p) { q = z.index + 1; continue; }
                A.push(s.slice(p, z.index));
                if (A.length === lim) return A;
                for (i = 1; i < z.length; i++) { A.push(z[i]); if (A.length === lim) return A; }
                p = q = e;
            }
            A.push(s.slice(p));
            return A;
        }
        var C = speciesOf(rx, G.RegExp), flags = String(rx.flags), unicode = hasUnicode(flags);
        var splitter = new C(rx, flags.indexOf('y') >= 0 ? flags : flags + 'y'), size = s.length;
        if (!size) return regExpExec(splitter, s) !== null ? A : [s];
        while (q < size) {
            splitter.lastIndex = q;
            z = regExpExec(splitter, s);
            if (z === null) { q = advance(s, q, unicode); continue; }
            e = Math.min(toLength(splitter.lastIndex), size);
            if (e === p) { q = advance(s, q, unicode); continue; }
            A.push(s.slice(p, q));
            if (A.length === lim) return A;
            p = e;
            var nCaps = Math.max(toLength(z.length) - 1, 0);
            for (i = 1; i <= nCaps; i++) { A.push(z[i]); if (A.length === lim) return A; }
            q = p;
        }
        A.push(s.slice(p, size));
        return A;
    };
    if (K_MATCH !== null && K_REPLACE !== null && K_SEARCH !== null && K_SPLIT !== null) {
        hidden(proto, K_MATCH, protoMatch);
        hidden(proto, K_REPLACE, protoReplace);
        hidden(proto, K_SEARCH, protoSearch);
        hidden(proto, K_SPLIT, protoSplit);
    } else K_MATCH = K_REPLACE = K_SEARCH = K_SPLIT = null;
    // (a string pattern goes to the engine at once; an object is asked for its method)
    String.prototype.match = function match(regexp) {
        'use strict';
        if (this === null || this === undefined) throw new TypeError('String.prototype.match called on null or undefined');
        if (K_MATCH !== null && regexp !== null && (typeof regexp === 'object' || typeof regexp === 'function')) {
            var m = regexp[K_MATCH];
            if (m === protoMatch && regexp.exec === nativeExec) return nativeMatch.call(this, regexp);
            if (m !== undefined && m !== null) return m.call(regexp, this);
        } else if (K_MATCH === null && isLowered(regexp)) return protoMatch.call(regexp, this);
        return nativeMatch.call(this, regexp);
    };
    String.prototype.replace = function replace(searchValue, replaceValue) {
        'use strict';
        if (this === null || this === undefined) throw new TypeError('String.prototype.replace called on null or undefined');
        if (K_REPLACE !== null && searchValue !== null && (typeof searchValue === 'object' || typeof searchValue === 'function')) {
            var r = searchValue[K_REPLACE];
            if (r === protoReplace && searchValue.exec === nativeExec) return nativeReplace.call(this, searchValue, replaceValue);
            if (r !== undefined && r !== null) return r.call(searchValue, this, replaceValue);
        } else if (K_REPLACE === null && isLowered(searchValue)) return protoReplace.call(searchValue, this, replaceValue);
        return nativeReplace.call(this, searchValue, replaceValue);
    };
    String.prototype.search = function search(regexp) {
        'use strict';
        if (this === null || this === undefined) throw new TypeError('String.prototype.search called on null or undefined');
        if (K_SEARCH !== null && regexp !== null && (typeof regexp === 'object' || typeof regexp === 'function')) {
            var f = regexp[K_SEARCH];
            if (f === protoSearch && regexp.exec === nativeExec) return nativeSearch.call(this, regexp);
            if (f !== undefined && f !== null) return f.call(regexp, this);
        } else if (K_SEARCH === null && isLowered(regexp)) return protoSearch.call(regexp, this);
        return nativeSearch.call(this, regexp);
    };
    String.prototype.split = function split(separator, limit) {
        'use strict';
        if (this === null || this === undefined) throw new TypeError('String.prototype.split called on null or undefined');
        if (K_SPLIT !== null && separator !== null && (typeof separator === 'object' || typeof separator === 'function')) {
            var f = separator[K_SPLIT];
            if (f === protoSplit && separator.exec === nativeExec) return nativeSplit.call(this, separator, limit);
            if (f !== undefined && f !== null) return f.call(separator, this, limit);
        } else if (K_SPLIT === null && isLowered(separator)) return protoSplit.call(separator, this, limit);
        return nativeSplit.call(this, separator, limit);
    };
    if (!String.prototype.matchAll) {
        hidden(String.prototype, 'matchAll', function matchAll(re) {
            'use strict';
            if (this === null || this === undefined) throw new TypeError('String.prototype.matchAll called on null or undefined');
            var s = String(this), rx;
            if (re instanceof Native) {
                var fl = flagsOf(re);
                if (fl.indexOf('g') < 0) throw new TypeError('String.prototype.matchAll called with a non-global RegExp argument');
                rx = new BRRegExp(re, fl);
                rx.lastIndex = re.lastIndex;
            } else rx = new BRRegExp(re === undefined ? '' : String(re), 'g');
            var done = false, it = {
                next: function () {
                    var m = done ? null : rx.exec(s);
                    if (!m) { done = true; return { value: undefined, done: true }; }
                    if (m[0] === '') rx.lastIndex++;
                    return { value: m, done: false };
                }
            };
            if (G.Symbol && Symbol.iterator) it[Symbol.iterator] = function () { return this; };
            it['@@iterator'] = function () { return this; };
            return it;
        });
    }
    // test through the expression's exec when a script put another one there, as ES2015 has it: a page's own core-js
    // checks exactly that and, failing, put a test written in JS (an exec and a match array per call) on every
    // regular expression of the page. Ordinary ones still take the engine's test.
    var nativeTest = proto.test;
    hidden(proto, 'test', function test(s) {
        var ex = this.exec;
        if (ex === nativeExec || typeof ex !== 'function') return nativeTest.call(this, s);
        var r = ex.call(this, String(s));
        if (r !== null && typeof r !== 'object') throw new TypeError('The result of exec must be an object or null');
        return r !== null;
    });
})();
})(typeof window !== 'undefined' ? window : this);
