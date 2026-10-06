/*
 * cssfix.js - rewrites modern CSS so that the iOS 6 WebKit (536.26) can render it.
 *
 * Runs inside JavaScriptCore on the device (ES5 only!) and in the test harness.
 *
 *   CSSFix.run(kind, text, pageVars)  ->  JSON string {"out": ..., "vars": {...}}
 *     kind: "css" or "html"; pageVars: object or JSON string of already known :root custom properties
 *
 * What it does:
 *   - custom properties: static substitution (rule-local, page, :root, other), fallbacks honoured
 *   - flexbox (2012 syntax) -> the 2009 -webkit-box model; wrapping containers fall back to block
 *   - vendor prefixes: transform, transition, animation, @keyframes, columns, filter, mask, ...
 *   - calc() -> -webkit-calc(), gradients -> -webkit-*-gradient() with old direction syntax
 *   - colours: rgb(r g b / a), #rrggbbaa, hsl(), hwb(), oklch(), oklab(), lab(), lch(), color-mix()
 *   - clamp()/min()/max() approximated, env() removed, logical properties -> physical, inset -> t/r/b/l
 *   - selectors: :is()/:where() -> :-webkit-any() or expansion, :not(a,b) -> :not(a):not(b),
 *     :focus-visible -> :focus, ::placeholder -> ::-webkit-input-placeholder, unsupported ones dropped
 *     per selector instead of the whole rule
 *   - @supports evaluated and unwrapped/dropped, @layer unwrapped, @container dropped,
 *     @media range syntax and resolution converted, hover/pointer/prefers-* queries resolved
 */
var CSSFix = (function () {
    'use strict';

    // ------------------------------------------------------------------ scanning helpers

    function isWS(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 12; }

    // index just past the string that starts at i (s[i] is the quote)
    function skipString(s, i, n) {
        var q = s.charCodeAt(i);
        i++;
        while (i < n) {
            var c = s.charCodeAt(i);
            if (c === 92) { i += 2; continue; }          // backslash escape
            if (c === q) return i + 1;
            if (c === 10) return i;                        // unterminated string ends at newline
            i++;
        }
        return n;
    }

    function stripComments(s) {
        if (s.indexOf('/*') < 0) return s;
        var out = [], i = 0, n = s.length, start = 0;
        while (i < n) {
            var c = s.charCodeAt(i);
            if (c === 34 || c === 39) { i = skipString(s, i, n); continue; }
            if (c === 47 && s.charCodeAt(i + 1) === 42) {
                out.push(s.slice(start, i));
                var e = s.indexOf('*/', i + 2);
                i = e < 0 ? n : e + 2;
                start = i;
                continue;
            }
            i++;
        }
        out.push(s.slice(start));
        return out.join('');
    }

    // advances from i until a char of `stops` at depth 0 (parens/brackets), respecting strings and escapes
    function scanUntil(s, i, end, stops) {
        var depth = 0;
        while (i < end) {
            var c = s.charCodeAt(i);
            if (c === 34 || c === 39) { i = skipString(s, i, end); continue; }
            if (c === 92) { i += 2; continue; }
            if (c === 40 || c === 91) depth++;
            else if (c === 41 || c === 93) { if (depth > 0) depth--; }
            else if (depth === 0 && stops.indexOf(s.charAt(i)) >= 0) return i;
            i++;
        }
        return end;
    }

    // s[i] === '{'; returns the index of the matching '}' or -1
    function findBlockEnd(s, i, end) {
        var depth = 0;
        while (i < end) {
            var c = s.charCodeAt(i);
            if (c === 34 || c === 39) { i = skipString(s, i, end); continue; }
            if (c === 92) { i += 2; continue; }
            if (c === 123) depth++;
            else if (c === 125) { depth--; if (depth === 0) return i; }
            i++;
        }
        return -1;
    }

    // s[i] === '('; returns index of the matching ')' or s.length
    function matchParen(s, i) {
        var depth = 0, n = s.length;
        while (i < n) {
            var c = s.charCodeAt(i);
            if (c === 34 || c === 39) { i = skipString(s, i, n); continue; }
            if (c === 92) { i += 2; continue; }
            if (c === 40) depth++;
            else if (c === 41) { depth--; if (depth === 0) return i; }
            i++;
        }
        return n;
    }

    // split at depth 0 by a single character
    function splitTop(s, sep) {
        var parts = [], i = 0, n = s.length, start = 0, depth = 0;
        while (i < n) {
            var c = s.charCodeAt(i);
            if (c === 34 || c === 39) { i = skipString(s, i, n); continue; }
            if (c === 92) { i += 2; continue; }
            if (c === 40 || c === 91) depth++;
            else if (c === 41 || c === 93) { if (depth > 0) depth--; }
            else if (depth === 0 && s.charAt(i) === sep) { parts.push(s.slice(start, i)); start = i + 1; }
            i++;
        }
        parts.push(s.slice(start));
        return parts;
    }

    // split by whitespace at depth 0
    // A shadow's blur is the costliest thing this engine draws (WebCore::boxBlur took 7.6 % of the WebThread on
    // m.youtube.com, growing with the radius and the box): past BLUR_CAP px it is drawn as BLUR_CAP, a soft shadow
    // turning a little firmer
    var BLUR_CAP = 8;
    function capBlur(len) {
        var m = /^([\d.]+)(px|em|rem)?$/.exec(len);
        if (!m) return len;
        var px = parseFloat(m[1]) * (m[2] === 'em' || m[2] === 'rem' ? 16 : 1);
        return px > BLUR_CAP ? BLUR_CAP + 'px' : len;
    }
    // (the third length of each shadow of a box-shadow list; values with var() stay as they are)
    function capShadowBlurs(v) {
        if (v.indexOf('var(') >= 0 || v.indexOf('(') < 0 && !/\d/.test(v)) return v;
        var shadows = splitTop(v, ','), changed = false;
        for (var i = 0; i < shadows.length; i++) {
            var toks = splitWS(trim(shadows[i])), n = 0;
            for (var j = 0; j < toks.length; j++) {
                if (!/^-?[\d.]+(px|em|rem|pt|%|vw|vh)?$/.test(toks[j])) continue;
                if (++n === 3) { var c = capBlur(toks[j]); if (c !== toks[j]) { toks[j] = c; changed = true; } }
            }
            shadows[i] = toks.join(' ');
        }
        return changed ? shadows.join(', ') : v;
    }
    function splitWS(s) {
        var parts = [], i = 0, n = s.length, start = -1, depth = 0;
        while (i < n) {
            var c = s.charCodeAt(i);
            if (c === 34 || c === 39) { if (start < 0) start = i; i = skipString(s, i, n); continue; }
            if (c === 40) depth++;
            else if (c === 41) { if (depth > 0) depth--; }
            if (depth === 0 && isWS(c)) {
                if (start >= 0) { parts.push(s.slice(start, i)); start = -1; }
            } else if (start < 0) start = i;
            i++;
        }
        if (start >= 0) parts.push(s.slice(start));
        return parts;
    }

    function trim(s) { return s.replace(/^\s+|\s+$/g, ''); }

    // ------------------------------------------------------------------ parser

    var RULE_AT = { media: 1, supports: 1, layer: 1, container: 1, keyframes: 1, '-webkit-keyframes': 1, document: 1, '-moz-document': 1, scope: 1, 'starting-style': 1 };
    var DECL_AT = { 'font-face': 1, page: 1, property: 1, 'counter-style': 1, viewport: 1, '-ms-viewport': 1, 'font-palette-values': 1, 'position-try': 1 };

    function atName(prelude) {
        var m = /^@([a-zA-Z_-][a-zA-Z0-9_-]*)/.exec(prelude);
        return m ? m[1].toLowerCase() : '';
    }

    // Declarations of a block. With `nestedOut`, nested rules (CSS nesting: "&:hover{}", ".b{}", "@media{}")
    // are collected into it as {t:'q', sel, decls, nested} / {t:'at', name, prelude, decls, nested}; without
    // it they are skipped (descriptor blocks, inline styles).
    function parseDecls(str, nestedOut) {
        var decls = [], i = 0, n = str.length, start = 0, depth = 0;
        function flush(end) {
            var seg = trim(str.slice(start, end));
            if (!seg) return;
            var colon = seg.indexOf(':');
            if (colon <= 0) return;
            var p = trim(seg.slice(0, colon));
            if (p.charAt(0) !== '-' || p.charAt(1) !== '-') p = p.toLowerCase();   // custom property names are case-sensitive
            var v = trim(seg.slice(colon + 1));
            var imp = false;
            var m = /!\s*important\s*$/i.exec(v);
            if (m) { imp = true; v = trim(v.slice(0, m.index)); }
            if (p.charAt(0) === '*' || p.charAt(0) === '_') return;   // old IE hacks
            decls.push({ p: p, v: v, imp: imp });
        }
        while (i < n) {
            var c = str.charCodeAt(i);
            if (c === 34 || c === 39) { i = skipString(str, i, n); continue; }
            if (c === 92) { i += 2; continue; }
            if (c === 40 || c === 91) depth++;
            else if (c === 41 || c === 93) { if (depth > 0) depth--; }
            else if (depth === 0 && c === 123) {          // nested rule
                var e = findBlockEnd(str, i, n);
                if (e < 0) e = n;
                if (nestedOut) {
                    var head = trim(str.slice(start, i)), sub = [];
                    if (head) {
                        var inner = str.slice(i + 1, e);
                        if (head.charAt(0) === '@') {
                            var an = atName(head);
                            nestedOut.push({ t: 'at', name: an, prelude: trim(head.slice(an.length + 1)), decls: parseDecls(inner, sub), nested: sub });
                        } else nestedOut.push({ t: 'q', sel: head, decls: parseDecls(inner, sub), nested: sub });
                    }
                }
                start = e + 1;
                i = start;
                continue;
            } else if (depth === 0 && c === 59) { flush(i); start = i + 1; }
            i++;
        }
        flush(n);
        return decls;
    }

    // ---- CSS nesting: nested rules become plain descendant rules, nested conditional at-rules are hoisted
    var NESTED_AT = { media: 1, supports: 1, container: 1, layer: 1, scope: 1, 'starting-style': 1 };

    function replaceNestingSelector(sel, parent) {   // every "&" outside strings and brackets -> parent
        var out = '', i = 0, n = sel.length, depth = 0;
        while (i < n) {
            var c = sel.charCodeAt(i);
            if (c === 34 || c === 39) { var e = skipString(sel, i, n); out += sel.slice(i, e); i = e; continue; }
            if (c === 91) depth++; else if (c === 93) { if (depth > 0) depth--; }
            if (c === 38 && depth === 0) out += parent; else out += sel.charAt(i);
            i++;
        }
        return out;
    }

    function nestedSelectors(parentSels, childSel) {
        var parts = splitTop(childSel, ','), out = [];
        for (var i = 0; i < parts.length && out.length < 64; i++) {
            var c = trim(parts[i].replace(/\s+/g, ' '));
            if (!c) continue;
            for (var k = 0; k < parentSels.length && out.length < 64; k++) {
                if (c.indexOf('&') >= 0) out.push(replaceNestingSelector(c, parentSels[k]));
                else out.push(parentSels[k] + ' ' + c);   // relative selectors (".b", "> .b", "+ .b") are descendants of the parent
            }
        }
        return out;
    }

    function emitNested(nested, parentSels, out, depth) {
        if (depth > 12) return;
        for (var i = 0; i < nested.length; i++) {
            var n = nested[i];
            if (n.t === 'q' || n.name === 'nest') {
                var sels = nestedSelectors(parentSels, n.t === 'q' ? n.sel : n.prelude);
                if (!sels.length) continue;
                out.push({ t: 'q', sel: sels.join(','), decls: n.decls });
                if (n.nested.length) emitNested(n.nested, sels, out, depth + 1);
            } else if (NESTED_AT[n.name]) {
                var inner = [];
                if (n.decls.length) inner.push({ t: 'q', sel: parentSels.join(','), decls: n.decls });
                if (n.nested.length) emitNested(n.nested, parentSels, inner, depth + 1);
                if (inner.length) out.push({ t: 'at', name: n.name, prelude: n.prelude, rules: inner, decls: null, raw: null });
            }
        }
    }

    function flattenNesting(rules) {
        var out = [];
        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            if (r.t === 'q') {
                out.push(r);
                if (r.nested && r.nested.length) {
                    var sels = [], parts = splitTop(r.sel, ',');
                    for (var k = 0; k < parts.length; k++) { var ps = trim(parts[k].replace(/\s+/g, ' ')); if (ps) sels.push(ps); }
                    if (sels.length) emitNested(r.nested, sels, out, 0);
                }
            } else if (r.t === 'at' && r.rules) {
                out.push({ t: 'at', name: r.name, prelude: r.prelude, rules: flattenNesting(r.rules), decls: null, raw: null });
            } else out.push(r);
        }
        return out;
    }

    function parseRules(s, i, end, out) {
        while (i < end) {
            var c = s.charCodeAt(i);
            if (isWS(c) || c === 125 || c === 59) { i++; continue; }
            if (c === 64) {   // @rule
                var j = scanUntil(s, i, end, '{;');
                var prelude = trim(s.slice(i, j));
                var name = atName(prelude);
                var rest = trim(prelude.slice(name.length + 1));
                if (j >= end || s.charCodeAt(j) === 59) {
                    out.push({ t: 'at', name: name, prelude: rest, rules: null, decls: null, raw: null });
                    i = j + 1;
                    continue;
                }
                var close = findBlockEnd(s, j, end);
                if (close < 0) close = end;
                var node = { t: 'at', name: name, prelude: rest, rules: null, decls: null, raw: null };
                if (RULE_AT[name]) { node.rules = []; parseRules(s, j + 1, close, node.rules); }
                else if (DECL_AT[name]) node.decls = parseDecls(s.slice(j + 1, close));
                else node.raw = s.slice(i, close + 1);
                out.push(node);
                i = close + 1;
                continue;
            }
            var j2 = scanUntil(s, i, end, '{;}');
            if (j2 >= end || s.charCodeAt(j2) !== 123) { i = j2 + 1; continue; }
            var sel = trim(s.slice(i, j2));
            var close2 = findBlockEnd(s, j2, end);
            if (close2 < 0) close2 = end;
            var nested = [];
            out.push({ t: 'q', sel: sel, decls: parseDecls(s.slice(j2 + 1, close2), nested), nested: nested });
            i = close2 + 1;
        }
    }

    function serializeDecls(decls) {
        var parts = [];
        for (var i = 0; i < decls.length; i++) {
            var d = decls[i];
            parts.push(d.p + ':' + d.v + (d.imp ? ' !important' : ''));
        }
        return parts.join(';');
    }

    function serializeRules(rules) {
        var out = [];
        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            if (r.t === 'q') out.push(r.sel + '{' + serializeDecls(r.decls) + '}');
            else if (r.t === 'raw') out.push(r.raw);
            else if (r.t === 'at') {
                var head = '@' + r.name + (r.prelude ? ' ' + r.prelude : '');
                if (r.rules) out.push(head + '{' + serializeRules(r.rules) + '}');
                else if (r.decls) out.push(head + '{' + serializeDecls(r.decls) + '}');
                else if (r.raw) out.push(r.raw);
                else out.push(head + ';');
            }
        }
        return out.join('\n');
    }

    // ------------------------------------------------------------------ custom properties

    function isRootSelector(sel) {
        var parts = splitTop(sel, ',');
        for (var i = 0; i < parts.length; i++) {
            var p = trim(parts[i]).toLowerCase();
            if (p === ':root' || p === 'html' || p === 'body' || p === '*' || p === 'html,body' || p === ':root,body') return true;
        }
        return false;
    }

    // true when every selector of the list is the root element, the body or everything: a custom property defined
    // there has the same value in the whole document, so it can be substituted when the stylesheet is rewritten
    function allRootSelectors(sel) {
        var parts = splitTop(sel, ',');
        for (var i = 0; i < parts.length; i++) {
            var p = trim(parts[i]).toLowerCase().replace(/^:(where|is)\((.*)\)$/, '$2');
            if (p !== ':root' && p !== 'html' && p !== 'body' && p !== '*' && p !== ':host' && p !== 'html:root') return false;
        }
        return true;
    }

    function collectVars(rules, ctx, inMedia) {
        if (!ctx.defs) ctx.defs = [];
        if (!ctx.varInfo) ctx.varInfo = {};
        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            if (r.t === 'q') {
                var root = !inMedia && isRootSelector(r.sel);
                var local = !allRootSelectors(r.sel);
                for (var k = 0; k < r.decls.length; k++) {
                    var d = r.decls[k];
                    // var(--x, fallback) somewhere: outside the scope of --x the fallback applies
                    if (d.v.indexOf('var(') >= 0 || d.v.indexOf('inherit(') >= 0) {
                        var fbRe = /(?:^|[^\w-])(?:var|inherit)\(\s*(--[\w-]+)(?=(\s*,)?)/g, fm;   // the comma is looked at, not consumed: "var(--a,var(--b))"
                        while ((fm = fbRe.exec(d.v)) !== null) { var ri = varInfo(ctx, fm[1]); ri.used = true; if (fm[2]) ri.fallback = true; }
                    }
                    if (d.p.charAt(0) === '-' && d.p.charAt(1) === '-') {
                        if (root) ctx.root[d.p] = d.v;
                        else if (!(d.p in ctx.root)) ctx.other[d.p] = d.v;
                        ctx.defs.push({ n: d.p, v: d.v });
                        var info = varInfo(ctx, d.p);
                        info.values[trim(d.v)] = true;
                        if (inMedia) info.cond = true;
                        if (local) info.local = true;
                    }
                }
            } else if (r.t === 'at' && r.rules) {
                if (r.name === 'keyframes' || r.name === '-webkit-keyframes') continue;
                // @supports is decided here (see transformRules): a false block defines nothing
                if (r.name === 'supports') { if (evalSupports(r.prelude)) collectVars(r.rules, ctx, inMedia); continue; }
                collectVars(r.rules, ctx, inMedia || r.name === 'media' || r.name === 'container' || r.name === 'scope');
            } else if (r.t === 'at' && r.name === 'property' && r.decls) {
                // @property --x { initial-value: 4px }: a registered property falls back to its initial value
                // (var() fallbacks never apply to it), so the initial value is the last resort of resolveVars
                var pname = trim(r.prelude);
                if (pname.indexOf('--') === 0) {
                    if (!ctx.initial) ctx.initial = {};
                    if (!ctx.registered) ctx.registered = {};
                    ctx.registered[pname] = { inh: true };
                    for (var q = 0; q < r.decls.length; q++) {
                        if (r.decls[q].p === 'initial-value') { ctx.initial[pname] = r.decls[q].v; ctx.registered[pname].init = r.decls[q].v; }
                        else if (r.decls[q].p === 'inherits') ctx.registered[pname].inh = trim(r.decls[q].v).toLowerCase() !== 'false';
                    }
                }
            }
        }
    }

    // ---- custom properties resolved per element at run time ("cv" manifest entries). The rewriter still substitutes
    // a static value (what the declaration gets without a scoped definition); the entries give the shim the rule's
    // selectors, the scoped definitions and the raw declarations, so it can compute the real value for each element.
    function varRefs(v, set) {   // does the value reference one of the properties in `set`?
        var re = /(?:^|[^\w-])(?:var|inherit)\(\s*(--[\w-]+)/g, m;
        while ((m = re.exec(v)) !== null) if (set[m[1]]) return true;
        return false;
    }
    function varInfo(ctx, name) {
        if (!ctx.varInfo) ctx.varInfo = {};
        return ctx.varInfo[name] || (ctx.varInfo[name] = { values: {}, cond: false, local: false, fallback: false, inline: false, used: false });
    }
    // Custom properties whose value differs between elements: two or more different definitions (in this document or
    // against the page's earlier ones), a definition inside @media / @container, one in a style attribute, or a
    // definition limited to some elements while a var() elsewhere has a fallback for the others. A property with a
    // single definition gets that value everywhere, which is what the static substitution already does. Then every
    // property whose definition refers to one of those, and the page's scoped properties from earlier documents.
    function runtimeVars(ctx) {
        var set = {}, n, any = false, infos = ctx.varInfo || {};
        for (n in infos) {
            if (!infos.hasOwnProperty(n)) continue;
            var info = infos[n], count = 0, v, reg = ctx.registered && ctx.registered[n];
            for (v in info.values) if (info.values.hasOwnProperty(v)) count++;
            var known = count > 0 || n in ctx.page;
            if (n in ctx.page && count && !info.values.hasOwnProperty(trim(String(ctx.page[n])))) count++;
            // used but defined nowhere: scripts set it (style.setProperty) or another document of the page defines it
            var undefinedUse = info.used && !known && !reg;
            if (count > 1 || info.cond || info.inline || (info.local && info.fallback && count) || undefinedUse || (reg && !reg.inh && info.local)) { set[n] = true; any = true; }
        }
        if (ctx.pageScoped) for (n in ctx.pageScoped) if (ctx.pageScoped.hasOwnProperty(n)) { set[n] = true; any = true; }
        if (!any) return null;
        var defs = ctx.defs || [], changed = true, guard = 0;
        while (changed && guard++ < 16) {
            changed = false;
            for (var i = 0; i < defs.length; i++) {
                if (set[defs[i].n] || !varRefs(defs[i].v, set)) continue;
                set[defs[i].n] = true;
                changed = true;
            }
        }
        return set;
    }
    // A registered custom property (@property) that does not inherit has its initial value on every element without a
    // definition of its own, and so has a registered one resolved per element at run time where no ancestor defines
    // it: another rule's definition is not the static value then (tailwind 4 gave every translate utility the last
    // --tw-translate-y definition, `calc(calc(3/4 * 100%) * -1)`, instead of 0). null: no such default.
    function registeredDefault(name, ctx) {
        var reg = ctx.registered && ctx.registered[name];
        if (!reg || reg.init === undefined) return null;
        return !reg.inh || (ctx.rt && ctx.rt[name]) ? reg.init : null;
    }
    // The value another document of the page gave a property (undefined: none that counts here). One that only resets
    // it ("--x: initial") does not hide this document's own definition: YouTube resets every property in one stylesheet
    // and defines them in the next, and its consent dialog lost its white background (the text and buttons were on
    // the dark backdrop, and taps on the video went to the invisible dialog).
    var RESET_VALUE = /^\s*(initial|inherit|unset|revert|revert-layer)\s*$/i;
    function pageValue(name, ctx) {
        if (!(name in ctx.page)) return undefined;
        var pv = ctx.page[name];
        if (name in ctx.root && RESET_VALUE.test(String(pv)) && !RESET_VALUE.test(String(ctx.root[name]))) return undefined;
        return pv;
    }
    // what resolveVars would substitute for one property (null: nothing known)
    function staticVarValue(name, local, ctx) {
        var pv;
        if (local && local.hasOwnProperty(name)) return local[name];
        if ((pv = pageValue(name, ctx)) !== undefined) return pv;
        if (name in ctx.root) return ctx.root[name];
        var rd = registeredDefault(name, ctx);
        if (rd !== null) return rd;
        if (name in ctx.other) return ctx.other[name];
        if (ctx.initial && name in ctx.initial) return ctx.initial[name];
        return null;
    }
    // var() of properties that are not resolved at run time are substituted now, so the manifest only carries the
    // scoped ones (and the shim needs no other definitions)
    function staticizeVars(v, local, ctx, set, depth) {
        if ((depth || 0) > 8 || v.indexOf('var(') < 0) return v;
        var out = '', i = 0, lower = v.toLowerCase();
        for (;;) {
            var at = lower.indexOf('var(', i);
            while (at > 0 && /[\w-]/.test(lower.charAt(at - 1))) at = lower.indexOf('var(', at + 4);
            if (at < 0) { out += v.slice(i); break; }
            var close = matchParen(v, at + 3);
            var inner = v.slice(at + 4, close), comma = scanUntil(inner, 0, inner.length, ',');
            var name = trim(inner.slice(0, comma)), fb = comma < inner.length ? inner.slice(comma + 1) : null;
            out += v.slice(i, at);
            if (set[name]) out += 'var(' + name + (fb !== null ? ',' + staticizeVars(fb, local, ctx, set, (depth || 0) + 1) : '') + ')';
            else {
                var sv = staticVarValue(name, local, ctx);
                if (sv !== null) out += staticizeVars(trim(sv), local, ctx, set, (depth || 0) + 1);
                else if (fb !== null) out += staticizeVars(trim(fb), local, ctx, set, (depth || 0) + 1);
                else out += 'var(' + name + ')';   // guaranteed-invalid at run time too
            }
            i = close + 1;
        }
        return out;
    }

    // returns the value with var() resolved, or null when it cannot be resolved
    function resolveVars(v, local, ctx) {
        for (var iter = 0; iter < 12; iter++) {
            var at = v.indexOf('var(');
            if (at < 0) return v;
            // make sure this is the function name, not e.g. "--foo-var("
            if (at > 0 && /[a-zA-Z0-9_-]/.test(v.charAt(at - 1))) {
                // search further
                var later = v.indexOf('var(', at + 4);
                while (later > 0 && /[a-zA-Z0-9_-]/.test(v.charAt(later - 1))) later = v.indexOf('var(', later + 4);
                if (later < 0) return v;
                at = later;
            }
            var close = matchParen(v, at + 3);
            var inner = v.slice(at + 4, close);
            var comma = scanUntil(inner, 0, inner.length, ',');
            var name = trim(inner.slice(0, comma));
            var fallback = comma < inner.length ? trim(inner.slice(comma + 1)) : null;
            var val = null, rd = null, pv;
            if (local && name in local) val = local[name];
            else if ((pv = pageValue(name, ctx)) !== undefined) val = pv;
            else if (name in ctx.root) val = ctx.root[name];
            else if ((rd = registeredDefault(name, ctx)) !== null) val = rd;
            // a property only some rules define, resolved per element at run time, with a fallback here: the fallback is
            // what the elements outside those rules get (vercel.com: 58 scoped --themed-bg definitions, and the last
            // one made every button mint instead of var(--ds-gray-1000))
            else if (fallback !== null && ctx.rt && ctx.rt[name]) val = null;
            else if (name in ctx.other) val = ctx.other[name];
            else if (ctx.initial && name in ctx.initial) val = ctx.initial[name];
            // "--x: initial" is the guaranteed-invalid value (and inherit/unset cannot be known here): the fallback applies
            if (val !== null && RESET_VALUE.test(val)) val = null;
            if (val === null && fallback !== null) val = fallback;
            if (val === null) return null;
            v = v.slice(0, at) + trim(val) + v.slice(close + 1);
        }
        return null;
    }

    // ------------------------------------------------------------------ colours

    var NAMED = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0],
        gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192], orange: [255, 165, 0], purple: [128, 0, 128], pink: [255, 192, 203],
        rebeccapurple: [102, 51, 153], teal: [0, 128, 128], olive: [128, 128, 0], navy: [0, 0, 128], maroon: [128, 0, 0], lime: [0, 255, 0], aqua: [0, 255, 255],
        cyan: [0, 255, 255], magenta: [255, 0, 255], fuchsia: [255, 0, 255], brown: [165, 42, 42], gold: [255, 215, 0], beige: [245, 245, 220],
        transparent: [0, 0, 0, 0], currentcolor: null };
    // colour keywords the old engine does not know (CSS Color 4 named and system colours), as plain hex
    var COLOR_KEYWORDS = { rebeccapurple: '#663399', canvas: '#ffffff', canvastext: '#000000', linktext: '#0000ee', visitedtext: '#551a8b',
        activetext: '#ff0000', field: '#ffffff', fieldtext: '#000000', accentcolor: '#0a84ff', accentcolortext: '#ffffff', buttonborder: '#767676',
        buttontext: '#000000', mark: '#ffff00', marktext: '#000000', selecteditem: '#b3d4fc', selecteditemtext: '#000000' };
    var COLOR_KEYWORD_RE = /\b(rebeccapurple|canvas|canvastext|linktext|visitedtext|activetext|field|fieldtext|accentcolor|accentcolortext|buttonborder|buttontext|mark|marktext|selecteditem|selecteditemtext)\b/i;

    function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
    function gamma(c) { c = clamp01(c); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
    function to255(c) { return Math.round(clamp01(c) * 255); }

    function numOrPct(tok, scale) {   // "50%" -> scale*0.5 ; "0.5" -> 0.5 ; "none" -> 0
        if (tok === undefined || tok === 'none') return 0;
        if (tok.charAt(tok.length - 1) === '%') return parseFloat(tok) / 100 * scale;
        var n = parseFloat(tok);
        return isNaN(n) ? 0 : n;
    }

    function alphaOf(tok) {
        if (tok === undefined || tok === null) return 1;
        if (tok === 'none') return 0;   // a missing alpha renders as 0 (CSS Color 4)
        if (tok.charAt(tok.length - 1) === '%') return parseFloat(tok) / 100;
        var a = parseFloat(tok);
        return isNaN(a) ? 1 : a;
    }

    function hueDeg(tok) {
        if (tok === 'none') return 0;
        var v = parseFloat(tok);
        if (isNaN(v)) return 0;
        if (/grad$/.test(tok)) v = v * 0.9;
        else if (/rad$/.test(tok)) v = v * 180 / Math.PI;
        else if (/turn$/.test(tok)) v = v * 360;
        return v;
    }

    function rgbString(r, g, b, a) {
        if (a === undefined || a === null || a >= 1) return 'rgb(' + r + ',' + g + ',' + b + ')';
        return 'rgba(' + r + ',' + g + ',' + b + ',' + (Math.round(a * 1000) / 1000) + ')';
    }

    function oklabToRGB(L, a, b, alpha) {
        var l_ = L + 0.3963377774 * a + 0.2158037573 * b;
        var m_ = L - 0.1055613458 * a - 0.0638541728 * b;
        var s_ = L - 0.0894841775 * a - 1.2914855480 * b;
        var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
        var R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
        var G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
        var B = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
        return rgbString(to255(gamma(R)), to255(gamma(G)), to255(gamma(B)), alpha);
    }

    function labToRGB(L, a, b, alpha) {
        // CIE Lab (D50) -> XYZ -> (Bradford D50->D65) -> linear sRGB
        var fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
        var e = 216 / 24389, k = 24389 / 27;
        var xr = fx * fx * fx > e ? fx * fx * fx : (116 * fx - 16) / k;
        var yr = L > k * e ? Math.pow((L + 16) / 116, 3) : L / k;
        var zr = fz * fz * fz > e ? fz * fz * fz : (116 * fz - 16) / k;
        var X = xr * 0.96422, Y = yr * 1.0, Z = zr * 0.82521;
        var X2 = 0.9555766 * X - 0.0230393 * Y + 0.0631636 * Z;
        var Y2 = -0.0282895 * X + 1.0099416 * Y + 0.0210077 * Z;
        var Z2 = 0.0122982 * X - 0.0204830 * Y + 1.3299098 * Z;
        var R = 3.2404542 * X2 - 1.5371385 * Y2 - 0.4985314 * Z2;
        var G = -0.9692660 * X2 + 1.8760108 * Y2 + 0.0415560 * Z2;
        var B = 0.0556434 * X2 - 0.2040259 * Y2 + 1.0572252 * Z2;
        return rgbString(to255(gamma(R)), to255(gamma(G)), to255(gamma(B)), alpha);
    }

    function hslToRGB(h, s, l, alpha) {
        h = ((h % 360) + 360) % 360;
        var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
        var r, g, b;
        if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; } else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; } else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
        return rgbString(to255(r + m), to255(g + m), to255(b + m), alpha);
    }

    // every CSS named colour (for relative colour syntax, colour math and contrast-color)
    var NAMED_ALL_SRC = 'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32';
    var NAMED_ALL = null;
    function namedColor(name) {
        if (!NAMED_ALL) {
            NAMED_ALL = {};
            var t = NAMED_ALL_SRC.split(' ');
            for (var i = 0; i + 1 < t.length; i += 2) NAMED_ALL[t[i]] = t[i + 1];
        }
        return NAMED_ALL.hasOwnProperty(name) ? NAMED_ALL[name] : null;
    }

    // ---- sRGB -> other colour spaces (inverse of the conversions above), for relative colour syntax
    function linearChannel(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function cbrt(x) { return x < 0 ? -Math.pow(-x, 1 / 3) : Math.pow(x, 1 / 3); }
    function rgbToXYZ(r, g, b) {   // D65
        var R = linearChannel(r), G = linearChannel(g), B = linearChannel(b);
        return [0.4124564 * R + 0.3575761 * G + 0.1804375 * B, 0.2126729 * R + 0.7151522 * G + 0.0721750 * B, 0.0193339 * R + 0.1191920 * G + 0.9503041 * B];
    }
    function rgbToLab(r, g, b) {
        var xyz = rgbToXYZ(r, g, b);
        var X = 1.0478112 * xyz[0] + 0.0228866 * xyz[1] - 0.0501270 * xyz[2];   // Bradford D65 -> D50
        var Y = 0.0295424 * xyz[0] + 0.9904844 * xyz[1] - 0.0170491 * xyz[2];
        var Z = -0.0092345 * xyz[0] + 0.0150436 * xyz[1] + 0.7521316 * xyz[2];
        var e = 216 / 24389, k = 24389 / 27;
        var f = function (t) { return t > e ? cbrt(t) : (k * t + 16) / 116; };
        var fx = f(X / 0.96422), fy = f(Y), fz = f(Z / 0.82521);
        return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    }
    function rgbToOklab(r, g, b) {
        var R = linearChannel(r), G = linearChannel(g), B = linearChannel(b);
        var l = cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
        var m = cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
        var s = cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
        return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
    }
    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, h = 0, s = 0, d = max - min;
        if (d) {
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
            h *= 60;
        }
        return [h, s * 100, l * 100];
    }
    function polar(ab) {   // [a, b] -> [chroma, hue in degrees]
        var h = Math.atan2(ab[1], ab[0]) * 180 / Math.PI;
        return [Math.sqrt(ab[0] * ab[0] + ab[1] * ab[1]), h < 0 ? h + 360 : h];
    }
    function num4(n) { return String(Math.round(n * 10000) / 10000); }

    // "rgb(from indianred 255 g b)", "oklch(from var(--c) l c calc(h + 90))": the base colour's channels in the
    // target space replace the channel keywords, calc() is evaluated, and the plain function is converted
    function relativeColor(name, inner) {
        var s = trim(inner.slice(4)), baseEnd, m = /^[a-zA-Z-]+\(/.exec(s);
        if (m) baseEnd = matchParen(s, m[0].length - 1) + 1;
        else { baseEnd = 0; while (baseEnd < s.length && !isWS(s.charCodeAt(baseEnd))) baseEnd++; }
        var base = parseColor(s.slice(0, baseEnd));
        if (!base) return null;
        var rest = trim(s.slice(baseEnd)).toLowerCase(), space = name;
        if (name === 'color') {
            var sm = /^([a-z0-9-]+)\s*/.exec(rest);
            if (!sm) return null;
            space = sm[1];
            rest = rest.slice(sm[0].length);
        }
        var r = base[0], g = base[1], b = base[2], alpha = base[3] === undefined ? 1 : base[3];
        var names, vals, pct = [false, false, false], hsl, lab, ok, xyz;
        switch (space) {
            case 'rgb': case 'rgba': names = ['r', 'g', 'b']; vals = [r, g, b]; break;
            case 'hsl': case 'hsla': hsl = rgbToHsl(r, g, b); names = ['h', 's', 'l']; vals = hsl; pct = [false, true, true]; break;
            case 'hwb': hsl = rgbToHsl(r, g, b); names = ['h', 'w', 'b']; vals = [hsl[0], Math.min(r, g, b) / 255 * 100, (1 - Math.max(r, g, b) / 255) * 100]; pct = [false, true, true]; break;
            case 'lab': names = ['l', 'a', 'b']; vals = rgbToLab(r, g, b); break;
            case 'lch': lab = rgbToLab(r, g, b); names = ['l', 'c', 'h']; vals = [lab[0]].concat(polar([lab[1], lab[2]])); break;
            case 'oklab': names = ['l', 'a', 'b']; vals = rgbToOklab(r, g, b); break;
            case 'oklch': ok = rgbToOklab(r, g, b); names = ['l', 'c', 'h']; vals = [ok[0]].concat(polar([ok[1], ok[2]])); break;
            case 'srgb': names = ['r', 'g', 'b']; vals = [r / 255, g / 255, b / 255]; break;
            case 'srgb-linear': case 'display-p3': case 'a98-rgb': case 'prophoto-rgb': case 'rec2020':
                names = ['r', 'g', 'b']; vals = spaceFromXYZ(space, rgbToXYZ(r, g, b)); break;
            case 'xyz': case 'xyz-d65': names = ['x', 'y', 'z']; vals = rgbToXYZ(r, g, b); break;
            case 'xyz-d50': names = ['x', 'y', 'z']; vals = d65ToD50(rgbToXYZ(r, g, b)); break;
            default: return null;
        }
        var alphaTok = null, slash = scanUntil(rest, 0, rest.length, '/');
        if (slash < rest.length) { alphaTok = trim(rest.slice(slash + 1)); rest = rest.slice(0, slash); }
        var toks = splitWS(rest);
        if (toks.length < 3) return null;
        var subst = function (tok) {
            // the walker already turned "calc(h + 90)" (unknown keywords) into "-webkit-calc(h + 90)"
            tok = tok.replace(/-webkit-calc\(/g, 'calc(').replace(/(^|[^a-zA-Z0-9_.%-])(alpha|[a-z])(?![a-zA-Z0-9_%-])/g, function (all, pre, id) {
                if (id === 'alpha') return pre + num4(alpha);
                var k = names.indexOf(id);
                return k < 0 ? all : pre + num4(vals[k]);
            });
            if (tok.indexOf('calc(') >= 0) tok = transformFunctions(tok);
            return tok;
        };
        var outToks = [];
        for (var i = 0; i < 3; i++) {
            var t = subst(toks[i]);
            if (pct[i] && /^-?[\d.]+$/.test(t)) t += '%';   // hsl()/hwb() channels are percentages
            outToks.push(t);
        }
        var assembled = (name === 'color' ? space + ' ' : '') + outToks.join(' ') + (alphaTok !== null ? ' / ' + subst(alphaTok) : (alpha < 1 ? ' / ' + num4(alpha) : ''));
        return convertColorFunction(name, assembled);
    }

    // ---- colour spaces of color(): matrices to and from CIE XYZ (D65), transfer functions (CSS Color 4 and HDR)
    function xyzToLinearSRGB(v) {
        return [3.2409699419045226 * v[0] - 1.537383177570094 * v[1] - 0.4986107602930034 * v[2],
                -0.9692436362808796 * v[0] + 1.8759675015077202 * v[1] + 0.04155505740717559 * v[2],
                0.05563007969699366 * v[0] - 0.20397695888897652 * v[1] + 1.0569715142428786 * v[2]];
    }
    function d50ToD65(v) {
        return [0.955473421488075 * v[0] - 0.02309845494876471 * v[1] + 0.06325924320057072 * v[2],
                -0.0283697093338637 * v[0] + 1.0099953980813041 * v[1] + 0.021041441191917323 * v[2],
                0.012314014864481998 * v[0] - 0.020507649298898964 * v[1] + 1.330365926242124 * v[2]];
    }
    function d65ToD50(v) {
        return [1.0479298208405488 * v[0] + 0.022946793341019088 * v[1] - 0.05019222954313557 * v[2],
                0.029627815688159344 * v[0] + 0.990434484573249 * v[1] - 0.01707382502938514 * v[2],
                -0.009243058152591178 * v[0] + 0.015055144896577895 * v[1] + 0.7518742899580008 * v[2]];
    }
    function rec2020ToXYZ(r, g, b) {
        return [0.6369580483012914 * r + 0.14461690358620832 * g + 0.1688809751641721 * b,
                0.2627002120112671 * r + 0.6779980715188708 * g + 0.05930171646986196 * b,
                0.028072693049087428 * g + 1.060985057710791 * b];
    }
    var REC2020_A = 1.09929682680944, REC2020_B = 0.018053968510807;
    function signedPow(x, e) { return x < 0 ? -Math.pow(-x, e) : Math.pow(x, e); }
    // encoded channels of a colour space -> linear-light sRGB
    function spaceToLinearSRGB(space, r, g, b) {
        var lin = function (c) { var a = Math.abs(c), v = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4); return c < 0 ? -v : v; };
        switch (space) {
            case 'srgb': return [lin(r), lin(g), lin(b)];
            case 'srgb-linear': return [r, g, b];
            case 'display-p3': {
                var pr = lin(r), pg = lin(g), pb = lin(b);
                return xyzToLinearSRGB([0.4865709486482162 * pr + 0.26566769316909306 * pg + 0.1982172852343625 * pb,
                    0.2289745640697488 * pr + 0.6917385218365064 * pg + 0.079286914093745 * pb, 0.04511338185890264 * pg + 1.043944368900976 * pb]);
            }
            case 'a98-rgb': {
                var ar = signedPow(r, 563 / 256), ag = signedPow(g, 563 / 256), ab = signedPow(b, 563 / 256);
                return xyzToLinearSRGB([0.5766690429101305 * ar + 0.1855582379065463 * ag + 0.1882286462349947 * ab,
                    0.29734497525053605 * ar + 0.6273635662554661 * ag + 0.07529145849399788 * ab, 0.02703136138641234 * ar + 0.07068885253582723 * ag + 0.9913375368376388 * ab]);
            }
            case 'prophoto-rgb': {
                var pl = function (c) { var a = Math.abs(c); return a <= 16 / 512 ? c / 16 : signedPow(c, 1.8); };
                var qr = pl(r), qg = pl(g), qb = pl(b);
                return xyzToLinearSRGB(d50ToD65([0.7977604896723027 * qr + 0.13518583717574031 * qg + 0.0313493495815248 * qb,
                    0.2880711282292934 * qr + 0.7118432178101014 * qg + 0.00008565396060525902 * qb, 0.8251046025104601 * qb]));
            }
            case 'rec2020': {
                var rl = function (c) { var a = Math.abs(c), v = a < REC2020_B * 4.5 ? a / 4.5 : Math.pow((a + REC2020_A - 1) / REC2020_A, 1 / 0.45); return c < 0 ? -v : v; };
                return xyzToLinearSRGB(rec2020ToXYZ(rl(r), rl(g), rl(b)));
            }
            case 'xyz': case 'xyz-d65': return xyzToLinearSRGB([r, g, b]);
            case 'xyz-d50': return xyzToLinearSRGB(d50ToD65([r, g, b]));
        }
        return null;
    }
    // XYZ (D65) -> encoded channels of a colour space (for relative colour syntax)
    function spaceFromXYZ(space, v) {
        var enc = function (c) { var a = Math.abs(c), e = a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055; return c < 0 ? -e : e; };
        var m;
        switch (space) {
            case 'srgb-linear': return xyzToLinearSRGB(v);
            case 'display-p3':
                m = [2.493496911941425 * v[0] - 0.9313836179191239 * v[1] - 0.40271078445071684 * v[2], -0.8294889695615747 * v[0] + 1.7626640603183463 * v[1] + 0.023624685841943577 * v[2],
                     0.03584583024378447 * v[0] - 0.07617238926804182 * v[1] + 0.9568845240076872 * v[2]];
                return [enc(m[0]), enc(m[1]), enc(m[2])];
            case 'a98-rgb':
                m = [2.0415879038107465 * v[0] - 0.5650069742788596 * v[1] - 0.34473135077832956 * v[2], -0.9692436362808795 * v[0] + 1.8759675015077202 * v[1] + 0.04155505740717557 * v[2],
                     0.013444280632031142 * v[0] - 0.11836239223101838 * v[1] + 1.0151749943912054 * v[2]];
                return [signedPow(m[0], 256 / 563), signedPow(m[1], 256 / 563), signedPow(m[2], 256 / 563)];
            case 'prophoto-rgb': {
                var d = d65ToD50(v), pe = function (c) { var a = Math.abs(c), e = a < 1 / 512 ? a * 16 : Math.pow(a, 1 / 1.8); return c < 0 ? -e : e; };
                m = [1.3457989731028281 * d[0] - 0.25558010007997534 * d[1] - 0.05110628506753401 * d[2], -0.5446224939028347 * d[0] + 1.5082327413132781 * d[1] + 0.02053603239147973 * d[2], 1.2119675456389454 * d[2]];
                return [pe(m[0]), pe(m[1]), pe(m[2])];
            }
            case 'rec2020': {
                var re = function (c) { var a = Math.abs(c), e = a < REC2020_B ? 4.5 * a : REC2020_A * Math.pow(a, 0.45) - (REC2020_A - 1); return c < 0 ? -e : e; };
                m = [1.7166511879712674 * v[0] - 0.35567078377639233 * v[1] - 0.25336628137365974 * v[2], -0.6666843518324892 * v[0] + 1.6164812366349395 * v[1] + 0.01576854581391113 * v[2],
                     0.017639857445310783 * v[0] - 0.042770613257808524 * v[1] + 0.9421031212354738 * v[2]];
                return [re(m[0]), re(m[1]), re(m[2])];
            }
        }
        return v;
    }
    // ---- HDR (CSS Color HDR): PQ, HLG, linear Rec. 2100, ICtCp, Jzazbz, JzCzHz; media white is 203 cd/m2 and what
    // lies above it clips on this SDR display
    var HDR_SPACES = { 'rec2100-pq': 1, 'rec2100-hlg': 1, 'rec2100-linear': 1, jzazbz: 1, jzczhz: 1, ictcp: 1 };
    var SDR_WHITE = 203;
    var PQ_M1 = 2610 / 16384, PQ_M2 = 2523 / 4096 * 128, PQ_C1 = 3424 / 4096, PQ_C2 = 2413 / 4096 * 32, PQ_C3 = 2392 / 4096 * 32;
    function pqToLinear(e) {   // PQ signal -> luminance in units of 10000 cd/m2
        var p = Math.pow(Math.max(e, 0), 1 / PQ_M2);
        return Math.pow(Math.max(p - PQ_C1, 0) / (PQ_C2 - PQ_C3 * p), 1 / PQ_M1);
    }
    function hlgToLinear(e) {   // HLG signal -> display light relative to 1000 cd/m2 (system gamma 1.2)
        var a = 0.17883277, b = 0.28466892, c = 0.55991073;
        var s = e <= 0.5 ? e * e / 3 : (Math.exp((e - c) / a) + b) / 12;
        return Math.pow(Math.max(s, 0), 1.2);
    }
    function hdrChannel(tok, pctRef) {
        if (tok === undefined || tok === 'none') return 0;
        if (tok.charAt(tok.length - 1) === '%') return parseFloat(tok) / 100 * pctRef;
        var n = parseFloat(tok);
        return isNaN(n) ? 0 : n;
    }
    function hdrColor(space, t1, t2, t3, alpha) {
        var lin, xyz;
        if (space === 'rec2100-pq' || space === 'rec2100-hlg' || space === 'rec2100-linear') {
            var ch = [hdrChannel(t1, 1), hdrChannel(t2, 1), hdrChannel(t3, 1)];
            for (var i = 0; i < 3; i++) {
                if (space === 'rec2100-pq') ch[i] = pqToLinear(ch[i]) * 10000 / SDR_WHITE;
                else if (space === 'rec2100-hlg') ch[i] = hlgToLinear(ch[i]) * 1000 / SDR_WHITE;
            }
            lin = xyzToLinearSRGB(rec2020ToXYZ(ch[0], ch[1], ch[2]));
        } else if (space === 'ictcp') {
            var I = hdrChannel(t1, 1), Ct = hdrChannel(t2, 0.5), Cp = hdrChannel(t3, 0.5);
            var l = pqToLinear(I + 0.008609037037932761 * Ct + 0.11102962500302593 * Cp) * 10000 / SDR_WHITE;
            var m = pqToLinear(I - 0.00860903703793275 * Ct - 0.11102962500302599 * Cp) * 10000 / SDR_WHITE;
            var s = pqToLinear(I + 0.5600313357106791 * Ct - 0.32062717498731885 * Cp) * 10000 / SDR_WHITE;
            lin = xyzToLinearSRGB(rec2020ToXYZ(3.4366066943330784 * l - 2.5064521186562698 * m + 0.0698454243231915 * s,
                -0.7913295555989289 * l + 1.9836004517922909 * m - 0.1922708961933620 * s, -0.0259498996905927 * l - 0.0989137147117265 * m + 1.1248636144023192 * s));
        } else {
            var Jz = hdrChannel(t1, 1), az, bz;
            if (space === 'jzczhz') { var Cz = hdrChannel(t2, 0.5), hz = hueDeg(t3) * Math.PI / 180; az = Cz * Math.cos(hz); bz = Cz * Math.sin(hz); }
            else { az = hdrChannel(t2, 0.5); bz = hdrChannel(t3, 0.5); }
            var d = -0.56, d0 = 1.6295499532821566e-11;
            var Iz = (Jz + d0) / (1 + d - d * (Jz + d0));
            var jpq = function (v) {   // Jzazbz's PQ curve, inverted: -> cd/m2
                var p = Math.pow(Math.max(v, 0), 1 / (1.7 * 2523 / 32));
                return 10000 * Math.pow(Math.max((3424 / 4096 - p) / (2392 / 128 * p - 2413 / 128), 0), 16384 / 2610);
            };
            var L = jpq(Iz + 0.1386050432715393 * az + 0.05804731615611886 * bz);
            var M = jpq(Iz - 0.1386050432715393 * az - 0.05804731615611886 * bz);
            var S = jpq(Iz - 0.09601924202631895 * az - 0.8118918960560388 * bz);
            var Xp = 1.9242264357876067 * L - 1.0047923125953657 * M + 0.037651404030618 * S;
            var Yp = 0.35031676209499907 * L + 0.7264811939316552 * M - 0.06538442294808501 * S;
            var Zp = -0.09098281098284752 * L - 0.3127282905230739 * M + 1.5227665613052603 * S;
            var X = (Xp + 0.15 * Zp) / 1.15, Y = (Yp - 0.34 * X) / 0.66;
            xyz = [X / SDR_WHITE, Y / SDR_WHITE, Zp / SDR_WHITE];
            lin = xyzToLinearSRGB(xyz);
        }
        return rgbString(to255(gamma(lin[0])), to255(gamma(lin[1])), to255(gamma(lin[2])), alpha);
    }

    function relativeLuminance(c) {
        return 0.2126 * linearChannel(c[0]) + 0.7152 * linearChannel(c[1]) + 0.0722 * linearChannel(c[2]);
    }

    // splits "a b c / d" or "a, b, c, d" into components and alpha
    function colorComponents(inner) {
        var alpha = null, main = inner;
        var slash = inner.indexOf('/');
        if (slash >= 0) { alpha = trim(inner.slice(slash + 1)); main = inner.slice(0, slash); }
        var comps;
        if (main.indexOf(',') >= 0) {
            comps = splitTop(main, ',');
            for (var i = 0; i < comps.length; i++) comps[i] = trim(comps[i]);
            if (alpha === null && comps.length === 4) alpha = comps.pop();
        } else comps = splitWS(main);
        return { c: comps, a: alpha };
    }

    // parses a colour string into [r,g,b,a] or null
    function parseColor(str) {
        str = trim(str).toLowerCase();
        if (NAMED.hasOwnProperty(str)) return NAMED[str] ? NAMED[str].slice(0) : null;
        if (/^[a-z]+$/.test(str)) { var named = namedColor(str); if (!named) return null; str = '#' + named; }
        var m = /^#([0-9a-f]{3,8})$/.exec(str);
        if (m) {
            var h = m[1];
            if (h.length === 3 || h.length === 4) {
                var r = parseInt(h.charAt(0) + h.charAt(0), 16), g = parseInt(h.charAt(1) + h.charAt(1), 16), b = parseInt(h.charAt(2) + h.charAt(2), 16);
                return [r, g, b, h.length === 4 ? parseInt(h.charAt(3) + h.charAt(3), 16) / 255 : 1];
            }
            if (h.length === 6 || h.length === 8) {
                return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
            }
            return null;
        }
        m = /^(rgba?|hsla?)\((.*)\)$/.exec(str);
        if (m) {
            var cc = colorComponents(m[2]);
            if (cc.c.length < 3) return null;
            var a = alphaOf(cc.a);
            if (m[1].charAt(0) === 'r') return [Math.round(numOrPct(cc.c[0], 255)), Math.round(numOrPct(cc.c[1], 255)), Math.round(numOrPct(cc.c[2], 255)), a];
            var rgb = /rgba?\((\d+),(\d+),(\d+)/.exec(hslToRGB(hueDeg(cc.c[0]), numOrPct(cc.c[1], 1), numOrPct(cc.c[2], 1), 1));
            return [+rgb[1], +rgb[2], +rgb[3], a];
        }
        return null;
    }

    function pctChannel(tok) {   // "50%" -> 0.5, "50" -> 0.5 (modern syntax takes numbers as percentages), "none" -> 0
        if (tok === undefined || tok === 'none') return 0;
        var n = parseFloat(tok);
        return isNaN(n) ? 0 : n / 100;
    }

    function convertColorFunction(name, inner) {
        var cc, a;
        if (/^from\s/i.test(inner) && name !== 'ictcp' && name !== 'jzazbz' && name !== 'jzczhz') return relativeColor(name, inner);
        if (name === 'rgb' || name === 'rgba') {
            if (inner.indexOf(',') >= 0 && inner.indexOf('/') < 0) return null;   // legacy syntax already
            cc = colorComponents(inner);
            if (cc.c.length < 3) return null;
            return rgbString(Math.round(numOrPct(cc.c[0], 255)), Math.round(numOrPct(cc.c[1], 255)), Math.round(numOrPct(cc.c[2], 255)), alphaOf(cc.a));
        }
        if (name === 'hsl' || name === 'hsla') {
            if (inner.indexOf(',') >= 0 && inner.indexOf('/') < 0 && !/deg|turn|rad/.test(inner)) return null;
            cc = colorComponents(inner);
            if (cc.c.length < 3) return null;
            return hslToRGB(hueDeg(cc.c[0]), pctChannel(cc.c[1]), pctChannel(cc.c[2]), alphaOf(cc.a));
        }
        if (name === 'contrast-color') {
            // black or white, whichever contrasts more with the given colour
            var cbase = parseColor(trim(inner));
            if (!cbase) return null;
            return relativeLuminance(cbase) > 0.179 ? '#000000' : '#ffffff';
        }
        if (name === 'device-cmyk') {
            cc = colorComponents(inner);
            if (cc.c.length < 4) return null;
            var cy = numOrPct(cc.c[0], 1), mg = numOrPct(cc.c[1], 1), ye = numOrPct(cc.c[2], 1), kk = numOrPct(cc.c[3], 1);
            return rgbString(to255((1 - cy) * (1 - kk)), to255((1 - mg) * (1 - kk)), to255((1 - ye) * (1 - kk)), alphaOf(cc.a));
        }
        if (name === 'hwb') {
            cc = colorComponents(inner);
            if (cc.c.length < 3) return null;
            var w = pctChannel(cc.c[1]), bl = pctChannel(cc.c[2]);
            if (w + bl > 1) { var sum = w + bl; w /= sum; bl /= sum; }
            var base = /rgba?\((\d+),(\d+),(\d+)/.exec(hslToRGB(hueDeg(cc.c[0]), 1, 0.5, 1));
            var f = function (c) { return Math.round((c / 255 * (1 - w - bl) + w) * 255); };
            return rgbString(f(+base[1]), f(+base[2]), f(+base[3]), alphaOf(cc.a));
        }
        if (name === 'oklch' || name === 'oklab') {
            cc = colorComponents(inner);
            if (cc.c.length < 3) return null;
            var L = numOrPct(cc.c[0], 1);
            a = alphaOf(cc.a);
            if (name === 'oklab') return oklabToRGB(L, numOrPct(cc.c[1], 0.4), numOrPct(cc.c[2], 0.4), a);
            var C = numOrPct(cc.c[1], 0.4), H = hueDeg(cc.c[2]) * Math.PI / 180;
            return oklabToRGB(L, C * Math.cos(H), C * Math.sin(H), a);
        }
        if (name === 'lab' || name === 'lch') {
            cc = colorComponents(inner);
            if (cc.c.length < 3) return null;
            var Lc = numOrPct(cc.c[0], 100);
            a = alphaOf(cc.a);
            if (name === 'lab') return labToRGB(Lc, numOrPct(cc.c[1], 125), numOrPct(cc.c[2], 125), a);
            var Cc = numOrPct(cc.c[1], 150), Hc = hueDeg(cc.c[2]) * Math.PI / 180;
            return labToRGB(Lc, Cc * Math.cos(Hc), Cc * Math.sin(Hc), a);
        }
        if (name === 'color') {
            var toks = splitWS(inner.replace('/', ' / '));
            if (toks.length < 4) return null;
            var alphaTok = null, sl = toks.indexOf('/');
            if (sl >= 0) { alphaTok = toks[sl + 1]; toks = toks.slice(0, sl); }
            var cspace = toks[0].toLowerCase();
            if (HDR_SPACES[cspace]) return hdrColor(cspace, toks[1], toks[2], toks[3], alphaOf(alphaTok));
            var lin = spaceToLinearSRGB(cspace, numOrPct(toks[1], 1), numOrPct(toks[2], 1), numOrPct(toks[3], 1));
            if (!lin) return rgbString(to255(numOrPct(toks[1], 1)), to255(numOrPct(toks[2], 1)), to255(numOrPct(toks[3], 1)), alphaOf(alphaTok));
            return rgbString(to255(gamma(lin[0])), to255(gamma(lin[1])), to255(gamma(lin[2])), alphaOf(alphaTok));
        }
        if (name === 'ictcp' || name === 'jzazbz' || name === 'jzczhz') {
            var hin = inner;
            if (/^from\s/i.test(hin)) {
                // relative forms whose channels are all literal do not depend on the base colour
                var fm = /^from\s+([a-z]+\([^)]*\)|#[0-9a-f]+|[a-z-]+)\s+([\s\S]*)$/i.exec(hin);
                if (!fm || /(^|[\s(])(i|ct|cp|jz|az|bz|cz|hz|alpha)(?=[\s)*+\/-]|$)/i.test(fm[2])) return null;
                hin = fm[2];
            }
            cc = colorComponents(hin);
            if (cc.c.length < 3) return null;
            return hdrColor(name, cc.c[0], cc.c[1], cc.c[2], alphaOf(cc.a));
        }
        if (name === 'color-hdr') {
            // one colour per display headroom: this display is SDR, so the entry with the smallest headroom
            var entries = splitTop(inner, ','), pick = null, pickH = Infinity;
            for (var ei = 0; ei < entries.length; ei++) {
                var en = trim(entries[ei]);
                if (!en) continue;
                var eh = /^([\s\S]*?)\s+(-?[\d.]+)$/.exec(en), ecol = eh ? eh[1] : en, head = eh ? parseFloat(eh[2]) : 0;
                if (head < pickH) { pickH = head; pick = trim(ecol); }
            }
            return pick;
        }
        if (name === 'color-mix') {
            var args = splitTop(inner, ',');
            if (args.length < 3) return null;
            if (/^\s*(scroll\(|view\(|--)/i.test(args[0])) return null;   // a timeline progress: the page shim mixes on scroll
            var c1 = splitWS(trim(args[1])), c2 = splitWS(trim(args[2]));
            var p1 = null, p2 = null, s1 = [], s2 = [], i;
            for (i = 0; i < c1.length; i++) { if (/%$/.test(c1[i])) p1 = parseFloat(c1[i]) / 100; else s1.push(c1[i]); }
            for (i = 0; i < c2.length; i++) { if (/%$/.test(c2[i])) p2 = parseFloat(c2[i]) / 100; else s2.push(c2[i]); }
            var col1 = parseColor(s1.join(' ')), col2 = parseColor(s2.join(' '));
            if (!col1 || !col2) return s1.join(' ');
            // color-mix(<progress> in <space>, a, b): the progress is the share of b
            var progressFirst = /^\s*(-?[\d.]+%?)\s+in\s/i.exec(args[0]);
            if (progressFirst && p1 === null && p2 === null) { p2 = mixProgress(progressFirst[1]); p1 = 1 - p2; }
            if (p1 === null && p2 === null) { p1 = 0.5; p2 = 0.5; }
            else if (p1 === null) p1 = 1 - p2;
            else if (p2 === null) p2 = 1 - p1;
            var tot = p1 + p2; if (tot <= 0) tot = 1;
            p1 /= tot; p2 /= tot;
            var mix = function (k) { return Math.round(col1[k] * p1 + col2[k] * p2); };
            var alphaMix = (col1[3] === undefined ? 1 : col1[3]) * p1 + (col2[3] === undefined ? 1 : col2[3]) * p2;
            return rgbString(mix(0), mix(1), mix(2), alphaMix);
        }
        if (name === 'light-dark') {
            var ld = splitTop(inner, ',');
            return trim(ld[0]);
        }
        return null;
    }

    function fixHexAlpha(v) {
        if (v.indexOf('#') < 0) return v;
        return v.replace(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{4})(?![0-9a-zA-Z_-])/g, function (all, h) {
            var c = parseColor('#' + h);
            return c ? rgbString(c[0], c[1], c[2], c[3]) : all;
        });
    }

    // ------------------------------------------------------------------ gradients

    var SIDES = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

    function normalizeStops(stops) {
        var out = [];
        for (var i = 0; i < stops.length; i++) {
            var toks = splitWS(trim(stops[i]));
            if (!toks.length) continue;
            if (toks.length === 1 && /^-?[\d.]+(%|px|em|rem|vw|vh)?$/.test(toks[0])) continue;   // colour hint: drop
            if (toks.length === 3) { out.push(toks[0] + ' ' + toks[1]); out.push(toks[0] + ' ' + toks[2]); continue; }
            out.push(toks.join(' '));
        }
        return out;
    }

    // "in lch", "in hsl longer hue": colour interpolation methods the old engine cannot parse
    var INTERPOLATION_RE = /\s*\bin\s+[a-z][a-z0-9-]*(\s+(shorter|longer|increasing|decreasing)\s+hue)?\b\s*/i;

    function convertLinearGradient(inner) {
        inner = inner.replace(INTERPOLATION_RE, ' ');
        var args = splitTop(inner, ',');
        var first = trim(args[0]);
        if (!first) args = args.slice(1);
        first = trim(args[0] || '');
        var rest = args.slice(1);
        var dir = null;
        if (/^to\s+/i.test(first)) {
            var words = splitWS(first).slice(1), mapped = [];
            for (var i = 0; i < words.length; i++) mapped.push(SIDES[words[i].toLowerCase()] || words[i]);
            dir = mapped.join(' ');
        } else if (/^-?[\d.]+(deg|grad|rad|turn)$/i.test(first) || first === '0') {
            var ang = 90 - hueDeg(first === '0' ? '0deg' : first);
            ang = ((ang % 360) + 360) % 360;
            dir = (Math.round(ang * 100) / 100) + 'deg';
        } else rest = args;
        var stops = singleStop(normalizeStops(rest));
        return (dir ? dir + ', ' : '') + stops.join(', ');
    }

    // a gradient with one colour stop is a solid fill; the old syntax needs two stops for that
    function singleStop(stops) {
        if (stops.length === 1) stops.push(splitWS(stops[0])[0]);
        return stops;
    }

    function convertRadialGradient(inner) {
        inner = inner.replace(INTERPOLATION_RE, ' ');
        var args = splitTop(inner, ',');
        var first = trim(args[0]);
        if (!first) { args = args.slice(1); first = trim(args[0] || ''); }
        var rest = args.slice(1);
        var head = null;
        if (/\bat\b/i.test(first)) {
            var parts = first.split(/\s+at\s+/i);
            var shape = trim(parts[0]), pos = trim(parts[1] || 'center');
            head = pos + (shape ? ', ' + shape : '');
        } else if (/^(circle|ellipse|closest-|farthest-|-?[\d.]+(px|%|em|rem))/i.test(first)) {
            head = first;
        } else rest = args;
        var stops = singleStop(normalizeStops(rest));
        return (head ? head + ', ' : '') + stops.join(', ');
    }

    // conic gradients do not exist in the old engine: the same colour stops as a top-to-bottom linear gradient
    // keep the colours of pie charts and decorations instead of leaving the box empty
    function convertConicGradient(inner) {
        inner = inner.replace(INTERPOLATION_RE, ' ');
        var args = splitTop(inner, ',');
        if (/^\s*(from\s|at\s)/i.test(args[0])) args = args.slice(1);
        var stops = [];
        for (var i = 0; i < args.length; i++) {
            var toks = splitWS(trim(args[i])), out = [];
            for (var k = 0; k < toks.length; k++) {
                if (/^-?[\d.]+(deg|grad|rad|turn)$/i.test(toks[k])) out.push((Math.round(hueDeg(toks[k].toLowerCase()) / 360 * 10000) / 100) + '%');
                else out.push(toks[k]);
            }
            if (out.length) stops.push(out.join(' '));
        }
        return singleStop(normalizeStops(stops)).join(', ');
    }

    // image("a.png"), image(url(a.png), red), image(red): the first image, or a flat gradient of the colour
    function convertImage(inner) {
        var args = splitTop(inner, ','), color = null;
        for (var i = 0; i < args.length; i++) {
            var a = trim(args[i]).replace(/^(ltr|rtl)\s+/i, '');
            if (/^["']/.test(a)) return 'url(' + a + ')';
            if (/^(url|-webkit-[a-z-]*gradient|[a-z-]*gradient|-webkit-image-set|image-set)\(/i.test(a)) return a;
            if (!color && parseColor(a)) color = a;
        }
        return color ? '-webkit-linear-gradient(' + color + ', ' + color + ')' : 'none';
    }

    // cross-fade(url(a) 25%, url(b)) / cross-fade(url(a), url(b), 25%) -> -webkit-cross-fade(url(a), url(b), 25%)
    function convertCrossFade(inner) {
        var args = splitTop(inner, ','), images = [], pcts = [], trailing = null;
        if (/^\s*(scroll\(|view\(|--)/i.test(args[0])) return null;   // a timeline progress: the page shim fades on scroll
        var lead = /^\s*(-?[\d.]+%?)\s*$/.exec(args[0]);
        if (lead && args.length === 3) {
            // cross-fade(<progress>, a, b): the progress is the share of b
            var fade = function (im) { im = trim(im); return !/\(/.test(im) && parseColor(im) ? '-webkit-linear-gradient(' + im + ', ' + im + ')' : im; };
            return '-webkit-cross-fade(' + fade(args[1]) + ', ' + fade(args[2]) + ', ' + Math.round(mixProgress(lead[1]) * 100) + '%)';
        }
        for (var i = 0; i < args.length; i++) {
            var toks = splitWS(trim(args[i])), pct = null, img = [];
            for (var k = 0; k < toks.length; k++) { if (/^[\d.]+%$/.test(toks[k])) pct = toks[k]; else img.push(toks[k]); }
            if (img.length) {
                var im = img.join(' ');
                if (!/\(/.test(im) && parseColor(im)) im = '-webkit-linear-gradient(' + im + ', ' + im + ')';
                images.push(im);
                pcts.push(pct);
            } else if (pct !== null) trailing = pct;
        }
        if (!images.length) return 'none';
        if (images.length === 1) return images[0];
        var p = trailing !== null ? trailing : pcts[1] !== null ? pcts[1] : pcts[0] !== null ? (100 - parseFloat(pcts[0])) + '%' : '50%';
        return '-webkit-cross-fade(' + images[0] + ', ' + images[1] + ', ' + p + ')';
    }

    // ------------------------------------------------------------------ values

    var ABS_UNIT = /^-?[\d.]+(px|rem|em|pt|cm|mm|in|ch|ex)$/i;

    function pickMin(args) {
        for (var i = 0; i < args.length; i++) if (ABS_UNIT.test(trim(args[i]))) return trim(args[i]);
        return trim(args[0]);
    }

    // viewport of the page being rewritten (set by run()), for media-progress()
    var g_viewportWidth = 768, g_viewportHeight = 1024;
    // Viewport units. Inside UIWebView the old engine measures vw/vh against the whole document (the web view is
    // as large as the page, the scroll view around it shows a part): 100vh was the page's full height, 100vw its
    // scroll width, and a box sized by them made the page larger still (sport.cz's header: 11043 px). They become
    // pixels of the layout viewport: a rule's declarations with them go into orientation media queries right after
    // the rule, one pixel value per orientation (g_vpPortrait / g_vpLandscape, from the app's web view size);
    // style attributes and keyframes... see VP_UNIT_RE. g_vpW/g_vpH: the viewport the current pass converts with.
    var g_vpPortrait = { w: 768, h: 930 }, g_vpLandscape = { w: 1024, h: 674 }, g_vpCurrent = g_vpPortrait;
    var g_vpW = 768, g_vpH = 930;
    var VP_UNIT_RE = /\d(?:[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))\b/i;
    function hasViewportUnits(v) { return VP_UNIT_RE.test(v) && VP_UNIT_RE.test(v.replace(/url\([^)]*\)|"[^"]*"|'[^']*'/g, '')); }
    function setViewportPass(dims) { g_vpW = dims.w; g_vpH = dims.h; }
    // the page is laid out `lw` px wide (0: the device width; 980 without a viewport meta tag)
    function applyLayoutWidth(ctx, lw) {
        ctx.layoutWidth = lw;
        ctx.vpCurrent = layoutViewport(g_vpCurrent, lw);
        setViewportPass(ctx.vpCurrent);
    }
    // the layout width a page's <meta name="viewport"> asks for (0: device width), or null for a fragment
    function metaLayoutWidth(html) {
        var tag = /<meta\b[^>]*\bname\s*=\s*["']?viewport\b[^>]*>/i.exec(html);
        if (!tag) return /<head\b|<body\b|<html\b/i.test(html) ? 980 : null;
        var cm = /\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
        var c = cm ? (cm[2] !== undefined ? cm[2] : cm[3] !== undefined ? cm[3] : cm[4]) : '';
        var wm = /(?:^|[,;\s])width\s*=\s*([\w.-]+)/i.exec(c);
        if (wm) return /device-width/i.test(wm[1]) ? 0 : (parseFloat(wm[1]) > 0 ? Math.round(parseFloat(wm[1])) : 0);
        return /initial-scale/i.test(c) ? 0 : 980;
    }
    // "width=device-width" without an initial scale: the old engine takes the device width for the portrait width in
    // both orientations and zooms a landscape page in (github.com: laid out 768 px wide, its text a third larger);
    // current browsers lay it out as wide as the screen, which an initial scale of 1 does here too (and what the
    // viewport units above are computed for)
    function deviceWidthScale(html) {
        return html.replace(/<meta\b[^>]*\bname\s*=\s*["']?viewport\b[^>]*>/i, function (tag) {
            return tag.replace(/(\bcontent\s*=\s*)("([^"]*)"|'([^']*)')/i, function (all, pre, quoted, dq, sq) {
                var c = dq !== undefined ? dq : sq, q = dq !== undefined ? '"' : "'";
                if (!/(?:^|[,;\s])width\s*=\s*device-width/i.test(c) || /initial-scale/i.test(c)) return all;
                return pre + q + c.replace(/[\s,;]+$/, '') + ', initial-scale=1' + q;
            });
        });
    }
    var INSET_SIDES = { top: 1, right: 1, bottom: 1, left: 1 }, TRANSFORM_FAMILY = { transform: 1, translate: 1, rotate: 1, scale: 1 };
    // whether declarations of a and b set (part of) the same thing: margin / margin-left, inset / top, ...
    function propsOverlap(a, b) {
        if (a === b || a.indexOf(b + '-') === 0 || b.indexOf(a + '-') === 0) return true;
        if ((a === 'inset' && INSET_SIDES[b]) || (b === 'inset' && INSET_SIDES[a])) return true;
        return !!(TRANSFORM_FAMILY[a] && TRANSFORM_FAMILY[b]);
    }
    function overlapsAny(p, list) {
        for (var i = 0; i < list.length; i++) if (propsOverlap(p, list[i])) return true;
        return false;
    }
    // the layout viewport of a page laid out `layoutWidth` px wide (0: device width) in the app's view of `view` size
    function layoutViewport(view, layoutWidth) {
        if (!layoutWidth || layoutWidth === view.w) return view;
        return { w: layoutWidth, h: Math.round(layoutWidth * view.h / view.w) };
    }

    // ---- manifest for the page shim: :has() selectors and @container queries the engine cannot evaluate are
    // rewritten to classes (.br-has-<hash>, .br-cq-<hash>) that shims-extra.js toggles on the elements; the
    // entries travel in a trailing comment of the rewritten output and the app hands them to the page.
    var g_manifest = null, g_suppressManifest = false;   // suppressed while @supports selector() is only being evaluated
    var g_hostScope = null;   // id of the shadow host whose stylesheet is being rewritten (see hostSelector)
    function manifestHash(s) {
        var h = 5381;
        for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return h.toString(36);
    }
    // ---- deferred values: declarations whose value depends on the element (anchor(), anchor-size(), attr(),
    // calc-size() of an intrinsic size, sibling-index(), toggle(), ...) and the anchor positioning properties. The
    // rewriter records them in the manifest with the rule's selectors, their specificity and the media queries
    // around the rule; the page shim finds the matching elements, resolves the cascade among the entries and
    // computes the value for each element. Inline style attributes are found through the br-dv-<hash> marker.
    var DV_PROPS = { 'anchor-name': 1, 'anchor-scope': 1, 'position-anchor': 1, 'position-area': 1, 'inset-area': 1, 'position-try': 1,
        'position-try-fallbacks': 1, 'position-try-options': 1, 'position-try-order': 1, 'position-visibility': 1,
        cx: 1, cy: 1, r: 1, rx: 1, ry: 1, x: 1, y: 1, d: 1, 'field-sizing': 1, 'margin-trim': 1 };
    var DV_FN = /(?:^|[^\w-])(anchor|anchor-size|attr|calc-size|sibling-index|sibling-count|container-progress|toggle)\(/i;
    // CSS Speech: the read-aloud feature of the shim speaks with these (they go to the manifest like deferred values,
    // the shim keeps them per element instead of setting them). Values are checked against the module's grammar.
    var SPEECH_PROPS = { speak: 1, 'speak-as': 1, pause: 1, 'pause-before': 1, 'pause-after': 1, rest: 1, 'rest-before': 1, 'rest-after': 1,
        cue: 1, 'cue-before': 1, 'cue-after': 1, 'voice-family': 1, 'voice-rate': 1, 'voice-pitch': 1, 'voice-range': 1, 'voice-volume': 1,
        'voice-stress': 1, 'voice-balance': 1, 'voice-duration': 1 };
    function validSpeechValue(p, v) {
        var lv = trim(v).toLowerCase(), toks = splitWS(lv), i, t;
        if (isGlobalKeyword(lv) || lv === 'unset') return true;
        var TIME = /^\d*\.?\d+m?s$/, STRENGTH = /^(none|x-weak|weak|medium|strong|x-strong)$/;
        var pauseValue = function (tk) { return TIME.test(tk) || STRENGTH.test(tk); };
        var cueValue = function (list) {
            var a = String(list[0] || '').toLowerCase(), b = String(list[1] || '').toLowerCase();
            return list.length === 1 && a === 'none' || (/^url\(/.test(a) && (list.length === 1 || (list.length === 2 && /^[+-]?\d*\.?\d+db$/.test(b))));
        };
        switch (p) {
            case 'speak': return /^(auto|never|always)$/.test(lv);
            case 'speak-as':
                if (lv === 'normal') return true;
                for (i = 0; i < toks.length; i++) if (!/^(spell-out|digits|literal-punctuation|no-punctuation)$/.test(toks[i])) return false;
                return !(toks.indexOf('literal-punctuation') >= 0 && toks.indexOf('no-punctuation') >= 0);
            case 'pause-before': case 'pause-after': case 'rest-before': case 'rest-after': return toks.length === 1 && pauseValue(toks[0]);
            case 'pause': case 'rest': return toks.length <= 2 && pauseValue(toks[0]) && (toks.length < 2 || pauseValue(toks[1]));
            case 'cue-before': case 'cue-after': return cueValue(splitWS(trim(v)));
            case 'cue': {
                var cues = splitWS(trim(v)), parts = [], cur = [];
                for (i = 0; i < cues.length; i++) { if ((/^url\(/i.test(cues[i]) || cues[i] === 'none') && cur.length) { parts.push(cur); cur = []; } cur.push(cues[i].toLowerCase()); }
                if (cur.length) parts.push(cur);
                return parts.length >= 1 && parts.length <= 2 && cueValue(parts[0]) && (parts.length < 2 || cueValue(parts[1]));
            }
            case 'voice-family': {
                if (lv === 'preserve') return true;
                var fams = splitTop(lv, ',');
                for (i = 0; i < fams.length; i++) {
                    t = trim(fams[i]);
                    if (/^(["']).*\1$/.test(t)) continue;
                    var ft = splitWS(t), gen = /^(child|young|old)?\s*(male|female|neutral)(\s+\d+)?$/.test(t);
                    if (!gen && !/^[a-z_][\w-]*(\s+[a-z_][\w-]*)*$/.test(t)) return false;
                    if (!gen && ft.length && /^(child|young|old)$/.test(ft[0]) && ft.length === 1) return false;
                }
                return true;
            }
            case 'voice-rate': {
                var kw = 0, pc = 0;
                for (i = 0; i < toks.length; i++) { if (/^(normal|x-slow|slow|medium|fast|x-fast)$/.test(toks[i])) kw++; else if (/^\d*\.?\d+%$/.test(toks[i])) pc++; else return false; }
                return kw <= 1 && pc <= 1 && toks.length >= 1;
            }
            case 'voice-pitch': case 'voice-range': {
                var kw2 = 0, num2 = 0, abs = 0, freq = 0;
                for (i = 0; i < toks.length; i++) {
                    t = toks[i];
                    if (/^(x-low|low|medium|high|x-high)$/.test(t)) kw2++;
                    else if (t === 'absolute') abs++;
                    else if (/^[+-]?\d*\.?\d+k?hz$/.test(t)) { num2++; freq++; }
                    else if (/^[+-]?\d*\.?\d+(st|%)$/.test(t)) num2++;
                    else return false;
                }
                if (abs) return abs === 1 && freq === 1 && num2 === 1 && !kw2 && toks.length === 2;
                return kw2 <= 1 && num2 <= 1 && toks.length >= 1;
            }
            case 'voice-volume': {
                if (lv === 'silent') return true;
                var kw3 = 0, db = 0;
                for (i = 0; i < toks.length; i++) { if (/^(x-soft|soft|medium|loud|x-loud)$/.test(toks[i])) kw3++; else if (/^[+-]?\d*\.?\d+db$/.test(toks[i])) db++; else return false; }
                return kw3 <= 1 && db <= 1 && toks.length >= 1;
            }
            case 'voice-stress': return /^(normal|strong|moderate|none|reduced)$/.test(lv);
            case 'voice-balance': return /^([+-]?\d*\.?\d+|left|center|right|leftwards|rightwards)$/.test(lv);
            case 'voice-duration': return lv === 'auto' || TIME.test(lv);
        }
        return false;
    }
    var ANCHOR_CENTER_PROPS = { 'justify-self': 1, 'align-self': 1, 'place-self': 1, 'justify-items': 1, 'align-items': 1, 'place-items': 1 };

    var TIMELINE_MIX = /(^|[^\w-])(mix|calc-mix|color-mix|cross-fade)\(\s*(scroll\(|view\(|--[\w-]+(\s|,))/i;
    // intrinsic and stretch sizes the engine has no keyword for: the shim measures them (see measureBasis)
    var SIZE_PROPS = { width: 1, height: 1, 'min-width': 1, 'min-height': 1, 'max-width': 1, 'max-height': 1, 'inline-size': 1, 'block-size': 1,
        'min-inline-size': 1, 'min-block-size': 1, 'max-inline-size': 1, 'max-block-size': 1, 'flex-basis': 1 };
    var INTRINSIC_SIZE = /^(min-content|max-content|fit-content|stretch|-webkit-fill-available|fill-available|-moz-available|-webkit-min-content|-webkit-max-content|-webkit-fit-content|-moz-fit-content|contain|fit-content\([^()]*\))$/i;
    var INTRINSIC_CONTENT = /^(min-content|max-content|fit-content|-webkit-min-content|-webkit-max-content|-webkit-fit-content|-moz-fit-content)$/i;
    // sizes that need measuring: stretch / contain / fit-content(limit) anywhere, the content keywords in min-* and
    // max-* (a width has the table form below, a height with them is plain auto)
    function intrinsicDeferred(p, v) {
        if (!SIZE_PROPS[p]) return false;
        var t = trim(v);
        if (/^(stretch|-webkit-fill-available|fill-available|-moz-available|contain)$/i.test(t) || /^fit-content\([^()]*\)$/i.test(t)) return true;
        return INTRINSIC_CONTENT.test(t) && /^(min|max)-/.test(p);
    }
    // CSS Borders 4: the shim paints such boxes itself (corner shapes as superellipses, border-shape, border-clip,
    // border-limit), see the box painter in shims-extra.js
    var BOX_PAINT_PROPS = /^(corner-shape|corner-(top|right|bottom|left|block-start|block-end|inline-start|inline-end)-shape|corner-(top-left|top-right|bottom-right|bottom-left|start-start|start-end|end-end|end-start)-shape|border-shape|border-limit|border-clip(-(top|right|bottom|left|block-start|block-end|inline-start|inline-end))?)$/;
    function validBoxPaintValue(p, v) {
        var lv = trim(v).toLowerCase(), toks = splitTop(lv, ' '), i;
        if (isGlobalKeyword(lv) || lv === 'unset') return true;
        if (/^corner-/.test(p)) {
            var max = p === 'corner-shape' ? 4 : /^corner-(top|right|bottom|left|block-start|block-end|inline-start|inline-end)-shape$/.test(p) ? 2 : 1;
            if (!toks.length || toks.length > max) return false;
            for (i = 0; i < toks.length; i++) if (!/^(round|scoop|bevel|notch|square|squircle|superellipse\(\s*(-?infinity|[+-]?\d*\.?\d+)\s*\))$/.test(toks[i])) return false;
            return true;
        }
        if (p === 'border-shape') {
            if (lv === 'none') return true;
            var shapes = 0, boxes = 0;
            for (i = 0; i < toks.length; i++) {
                if (/^(inset|circle|ellipse|polygon|path|rect|xywh|shape|url)\(/.test(toks[i])) shapes++;
                else if (/^(margin-box|border-box|padding-box|content-box|fill-box|stroke-box|view-box)$/.test(toks[i])) boxes++;
                else return false;
            }
            return shapes <= 2 && boxes <= 2 && shapes + boxes >= 1;
        }
        if (p === 'border-limit') return /^(all|(sides|corners)(\s+[\d.]+(px|%|em|rem))?|(top|right|bottom|left)\s+[\d.]+(px|%|em|rem))$/.test(lv);
        // border-clip*: normal | [<length-percentage> | <flex>]+
        if (lv === 'normal') return true;
        for (i = 0; i < toks.length; i++) if (!/^(\d*\.?\d+(px|%|em|rem|fr)|0)$/.test(toks[i])) return false;
        return toks.length > 0;
    }
    // CSS Gap Decorations: rules between the columns and rows of multi-column, flex and grid containers. A single
    // column rule is the engine's own (multi-column); value lists with repeat(), row rules and the placement properties
    // are painted by the shim (see the gap painter in shims-extra.js).
    var GAP_PROPS = /^((column|row)-rule|rule)(-(color|style|width))?$|^((column|row)-rule|rule)-(break|outset)$|^rule-paint-order$/;
    var GAP_WIDTH = /^(\d*\.?\d+(px|em|rem|%|pt)|0|thin|medium|thick)$/, GAP_STYLE = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/;
    function gapColor(t) { return !!parseColor(t) || /^(currentcolor|transparent)$/i.test(t); }
    // "red repeat(2, lime blue) repeat(auto, ...)": the items of a gap value list, null when invalid (nested repeat()s,
    // more than one auto repeat, a bad token)
    function gapList(v, kind) {
        var toks = splitTop(trim(v), ' '), items = [], autos = 0;
        var okToken = function (t) { return kind === 'color' ? gapColor(t) : kind === 'style' ? GAP_STYLE.test(t.toLowerCase()) : kind === 'width' ? GAP_WIDTH.test(t.toLowerCase()) : null; };
        var rule = function (tokens) {   // shorthand: <width> || <style> || <color>
            var w = 0, s = 0, c = 0;
            for (var i = 0; i < tokens.length; i++) { var t = trim(tokens[i]); if (!t) continue; if (GAP_WIDTH.test(t.toLowerCase())) w++; else if (GAP_STYLE.test(t.toLowerCase())) s++; else if (gapColor(t)) c++; else return false; }
            return w <= 1 && s <= 1 && c <= 1 && w + s + c > 0;
        };
        var pending = [];
        var flush = function () { if (!pending.length) return true; var okr = rule(pending); if (okr) items.push({ rule: pending }); pending = []; return okr; };
        for (var i = 0; i < toks.length; i++) {
            var t = toks[i], m = /^repeat\(\s*(auto|\d+)\s*,([\s\S]*)\)$/i.exec(t);
            if (/^repeat\(/i.test(t)) {
                if (!m || /repeat\(/i.test(m[2]) || matchParen(t, 6) !== t.length - 1) return null;
                if (kind === 'rule' && !flush()) return null;
                var inner = kind === 'rule' ? splitTop(m[2], ',') : splitTop(trim(m[2]), ' ');
                for (var k = 0; k < inner.length; k++) if (kind === 'rule' ? !rule(splitTop(trim(inner[k]), ' ')) : !okToken(trim(inner[k]))) return null;
                if (m[1].toLowerCase() === 'auto') autos++;
                else if (parseInt(m[1], 10) < 1) return null;
                items.push({ repeat: m[1].toLowerCase(), list: inner });
            } else if (kind === 'rule') {
                if (/,$/.test(t)) { pending.push(t.slice(0, -1)); if (!flush()) return null; }
                else pending.push(t);
            } else if (!okToken(t)) return null;
            else items.push({ value: t });
        }
        if (kind === 'rule' && !flush()) return null;
        return autos <= 1 && items.length ? items : null;
    }
    function validGapValue(p, v) {
        var lv = trim(v).toLowerCase();
        if (isGlobalKeyword(lv) || lv === 'unset') return true;
        if (/-break$/.test(p)) return /^(none|spanning-item|intersection)$/.test(lv);
        if (/-outset$/.test(p)) return /^-?(\d*\.?\d+(px|em|rem|%)|0)$/.test(lv);
        if (p === 'rule-paint-order') return /^(row-over-column|column-over-row)$/.test(lv);
        var kind = /-color$/.test(p) ? 'color' : /-style$/.test(p) ? 'style' : /-width$/.test(p) ? 'width' : 'rule';
        return gapList(v, kind) !== null;
    }
    // a column rule the multi-column engine draws by itself: one value, no list
    function nativeColumnRule(p, v) { return /^column-rule(-(color|style|width))?$/.test(p) && !/repeat\(/i.test(v) && (p === 'column-rule' || splitTop(trim(v), ' ').length === 1); }
    function isDeferred(p, v) {
        if (p === 'margin-trim') {
            var mtv = trim(v).toLowerCase();
            return isGlobalKeyword(mtv) || mtv === 'unset' || /^(none|block|inline)$/.test(mtv) || /^((block-start|inline-start|block-end|inline-end)(\s+|$))+$/.test(mtv);
        }
        if (DV_PROPS[p]) return true;
        if (SPEECH_PROPS[p]) return validSpeechValue(p, v);
        if (BOX_PAINT_PROPS.test(p)) return validBoxPaintValue(p, v);
        if (GAP_PROPS.test(p) && !nativeColumnRule(p, v)) return validGapValue(p, v);
        if (ANCHOR_CENTER_PROPS[p] && /\banchor-center\b/i.test(v)) return true;
        if (TIMELINE_MIX.test(v)) return true;   // mixes driven by a scroll or view timeline
        if (intrinsicDeferred(p, v)) return true;
        if (!DV_FN.test(v)) return false;
        var lv = v.toLowerCase();
        // content is mostly on ::before/::after, which the shim cannot reach: attr() there becomes the engine's own
        // plain attr(name) (see fixValue)
        if (p === 'content' && !/(anchor|calc-size|sibling-|container-progress|toggle)\(/.test(lv)) return false;
        // calc-size() with a length basis is evaluated statically (unless that leaves a size to measure)
        if (/calc-size\(/.test(lv) && !/(anchor|anchor-size|attr|sibling-|container-progress|toggle)\(/.test(lv)) {
            var tv = trim(transformFunctions(v));
            if (tv.toLowerCase().indexOf('calc-size(') < 0 && !intrinsicDeferred(p, tv)) return false;
        }
        return true;
    }

    // first-valid(a; b; c): the engine keeps the last declaration it understands, so the candidates in reverse order
    // leave the first valid one in effect
    function expandFirstValid(decls) {
        var out = null;
        for (var i = 0; i < decls.length; i++) {
            var d = decls[i], m = /^\s*first-valid\(([\s\S]*)\)\s*$/i.exec(d.v);
            if (!m) { if (out) out.push(d); continue; }
            if (!out) out = decls.slice(0, i);
            var cands = splitTop(m[1], ';');
            for (var k = cands.length - 1; k >= 0; k--) if (trim(cands[k])) out.push({ p: d.p, v: trim(cands[k]), imp: d.imp });
        }
        return out || decls;
    }

    // ---- if(): conditions known when the stylesheet is rewritten (supports(), style() of the custom properties in
    // scope) are decided here; media() branches become @media rules emitted after the rule, last branch first, so that
    // the first matching branch wins. Returns the value for the rule itself, or null when no branch is certain.
    function splitBoolean(s) {   // top-level " and " / " or " -> {terms, ops}
        var terms = [], ops = [], depth = 0, start = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            if (c === '(') depth++;
            else if (c === ')') depth--;
            else if (depth === 0) {
                var m = /^\s+(and|or)\s+/i.exec(s.slice(i));
                if (m) { terms.push(s.slice(start, i)); ops.push(m[1].toLowerCase()); i += m[0].length - 1; start = i + 1; }
            }
        }
        terms.push(s.slice(start));
        return { terms: terms, ops: ops };
    }
    function unwrapParens(s) {
        s = trim(s);
        while (s.charAt(0) === '(' && matchParen(s, 0) === s.length - 1) s = trim(s.slice(1, -1));
        return s;
    }
    function evalStyleQuery(q, local, ctx) {
        q = unwrapParens(q);
        if (/^not\s/i.test(q)) return !evalStyleQuery(q.slice(4), local, ctx);
        var b = splitBoolean(q);
        if (b.terms.length > 1) {
            var acc = evalStyleQuery(b.terms[0], local, ctx);
            for (var i = 1; i < b.terms.length; i++) { var r = evalStyleQuery(b.terms[i], local, ctx); acc = b.ops[i - 1] === 'and' ? acc && r : acc || r; }
            return acc;
        }
        var m = /^(--[\w-]+)\s*(?::\s*([\s\S]*))?$/.exec(q);
        if (!m) return false;
        var val = resolveVars('var(' + m[1] + ')', local, ctx);
        if (m[2] === undefined) return val !== null && trim(val) !== '' && trim(val).toLowerCase() !== 'initial';
        return val !== null && trim(val) === trim(m[2]);
    }
    function evalIfCondition(cond, local, ctx) {   // {k: 't'} | {k: 'f'} | {k: 'm', q: <media query>}
        cond = unwrapParens(cond);
        if (/^not\s/i.test(cond)) {
            var n = evalIfCondition(cond.slice(4), local, ctx);
            if (n.k !== 'm') return { k: n.k === 't' ? 'f' : 't' };
            return n.q.indexOf(',') >= 0 ? { k: 'f' } : { k: 'm', q: 'not all and ' + n.q };
        }
        var b = splitBoolean(cond);
        if (b.terms.length > 1) {
            var acc = evalIfCondition(b.terms[0], local, ctx);
            for (var i = 1; i < b.terms.length; i++) {
                var r = evalIfCondition(b.terms[i], local, ctx);
                if (b.ops[i - 1] === 'and') acc = acc.k === 'f' || r.k === 'f' ? { k: 'f' } : acc.k === 't' ? r : r.k === 't' ? acc : { k: 'm', q: acc.q + ' and ' + r.q };
                else acc = acc.k === 't' || r.k === 't' ? { k: 't' } : acc.k === 'f' ? r : r.k === 'f' ? acc : { k: 'm', q: acc.q + ', ' + r.q };
            }
            return acc;
        }
        var fm = /^(media|supports|style)\(([\s\S]*)\)$/i.exec(cond);
        if (!fm) return { k: 'f' };
        var kind = fm[1].toLowerCase(), arg = trim(fm[2]);
        if (kind === 'supports') return evalSupports(/^[\w-]+\s*:/.test(arg) ? '(' + arg + ')' : arg) ? { k: 't' } : { k: 'f' };
        if (kind === 'media') {
            // media(width < 600px): a bare media feature is allowed here, a media query needs it in parentheses
            if (arg.charAt(0) !== '(' && !/^(not\s+|only\s+)?(all|screen|print|speech)\b/i.test(arg) && /^[\w.-]+\s*(:|<|>|=)/.test(arg)) arg = '(' + arg + ')';
            var q = fixMedia(arg);
            return /^\s*all\s*$/i.test(q) ? { k: 't' } : { k: 'm', q: q };
        }
        return evalStyleQuery(arg, local, ctx) ? { k: 't' } : { k: 'f' };
    }
    function resolveIf(p, v, imp, local, ctx) {
        for (var guard = 0; guard < 8; guard++) {
            var m = /(^|[^\w-])if\(/i.exec(v);
            if (!m) return v;
            var start = m.index + m[1].length, open = start + 2, close = matchParen(v, open);
            var branches = splitTop(v.slice(open + 1, close), ';'), base = null, media = [];
            for (var i = 0; i < branches.length; i++) {
                var br = trim(branches[i]);
                if (!br) continue;
                var colon = scanUntil(br, 0, br.length, ':');
                if (colon >= br.length) continue;
                var cond = trim(br.slice(0, colon)), val = trim(br.slice(colon + 1));
                var r = /^else$/i.test(cond) ? { k: 't' } : evalIfCondition(cond, local, ctx);
                if (r.k === 'f') continue;
                if (r.k === 't') { base = val; break; }
                media.push([r.q, val]);
            }
            if (media.length && ctx.condRules) {
                for (var k = media.length - 1; k >= 0; k--) ctx.condRules.push({ m: media[k][0], p: p, v: v.slice(0, start) + media[k][1] + v.slice(close + 1), imp: imp });
            }
            if (base === null) return null;
            v = v.slice(0, start) + base + v.slice(close + 1);
        }
        return v;
    }

    // a*10000 + b*100 + c (ids, classes/attributes/pseudo-classes, types/pseudo-elements)
    function specificity(sel) {
        var s = String(sel).replace(/"[^"]*"|'[^']*'/g, '""').replace(/\[[^\]]*\]/g, '.x');
        var c = 0;
        s = s.replace(/::?(before|after|first-line|first-letter)\b|::[\w-]+(\([^)]*\))?/gi, function () { c++; return ' '; });
        var a = (s.match(/#[\w-]+/g) || []).length;
        var b = (s.match(/\.[\w-]+|:[\w-]+/g) || []).length - (s.match(/:(not|-webkit-any|is|where|matches)\b/gi) || []).length;
        c += (s.replace(/[.#:][\w-]+/g, ' ').match(/(^|[\s>+~(,])[a-zA-Z][\w-]*/g) || []).length;
        return Math.min(a, 99) * 10000 + Math.min(Math.max(b, 0), 99) * 100 + Math.min(c, 99);
    }

    function registerDeferred(ctx, p, v, imp, markers) {
        var sels = ctx.curSels || null, media = ctx.mediaStack && ctx.mediaStack.length ? ctx.mediaStack.slice(0) : null;
        // timeline mixes keep their function (it returns null here) while the colours inside become ones the engine knows
        if (TIMELINE_MIX.test(v) && !DV_FN.test(v)) v = transformFunctions(v);
        var entry = { h: manifestHash((sels ? sels.join(',') : '@inline') + '|' + p + '|' + v + '|' + (media ? media.join('&') : '')), p: p, v: v };
        if (sels) {
            entry.s = sels;
            entry.sp = [];
            for (var i = 0; i < sels.length; i++) entry.sp.push(specificity(sels[i]));
        }
        if (media) entry.m = media;
        if (imp) entry.i = 1;
        manifestAdd('dv', entry);
        markers.push('br-dv-' + entry.h + ' 1');
    }

    // one "cv" manifest entry per style rule: its selectors (with specificity and the media queries around it), the
    // scoped custom properties it defines ([name, value, important]) and the declarations using them
    // ([property, raw value, important, static value])
    function registerVarRule(ctx, sels, defs, uses) {
        var media = ctx.mediaStack && ctx.mediaStack.length ? ctx.mediaStack.slice(0) : null;
        var entry = { h: manifestHash('cv|' + sels.join(',') + '|' + JSON.stringify(defs) + '|' + JSON.stringify(uses) + '|' + (media ? media.join('&') : '')), s: sels, sp: [] };
        for (var i = 0; i < sels.length; i++) entry.sp.push(specificity(sels[i]));
        if (media) entry.m = media;
        if (defs.length) entry.d = defs;
        if (uses.length) entry.u = uses;
        manifestAdd('cv', entry);
    }

    // which custom properties this document resolves at run time; registered ones (@property) among them go to the
    // manifest with their initial value and whether they inherit
    function prepareRuntimeVars(ctx) {
        ctx.rt = g_manifest !== false ? runtimeVars(ctx) : null;
        if (!ctx.rt || !ctx.registered) return;
        for (var n in ctx.registered) {
            if (!ctx.registered.hasOwnProperty(n) || !ctx.rt[n]) continue;
            var reg = ctx.registered[n];
            manifestAdd('cv', { h: manifestHash('cvr|' + n + '|' + reg.init + '|' + reg.inh), r: [n, reg.init === undefined ? null : reg.init, reg.inh ? 1 : 0] });
        }
    }

    // the value to show before the shim runs: anchor()/attr() fallbacks, the keyword basis of calc-size()
    function deferredFallback(v, p) {
        var lv = trim(v).toLowerCase();
        // an intrinsic keyword: the property's initial value until the shim has measured
        if (INTRINSIC_SIZE.test(lv)) return /^max-/.test(p || '') ? 'none' : /^min-/.test(p || '') ? '0' : 'auto';
        var cs = /^calc-size\(\s*(auto|stretch)\s*,/.exec(lv);
        if (cs) return cs[1] === 'stretch' ? '-webkit-fill-available' : 'auto';
        var m = /^(anchor|anchor-size|attr)\(([\s\S]*)\)$/i.exec(trim(v));
        if (!m || matchParen(trim(v), m[1].length) !== trim(v).length - 1) return null;
        var comma = scanUntil(m[2], 0, m[2].length, ',');
        return comma < m[2].length ? trim(m[2].slice(comma + 1)) : null;
    }

    // CSS grid for the page shim (manifest "gd"): per rule that says something grid-specific, its selectors (with
    // specificity and the media queries around it) and its grid, alignment, gap and order declarations ([property,
    // value, important]). The shim lays the grids out; the floated columns of gridColumns are what shows until then.
    // (A rule with only display matters when its selectors made a grid before: a media query turning it into a block.)
    var GRID_SPECIFIC = /^(grid|grid-template|grid-template-(columns|rows|areas)|grid-auto-(flow|rows|columns)|grid-(column|row)(-(start|end))?|grid-area)$/;
    var GRID_RELATED = /^(justify-items|align-items|place-items|justify-content|align-content|place-content|justify-self|align-self|place-self|gap|row-gap|column-gap|grid-gap|grid-row-gap|grid-column-gap|order)$/;
    function registerGridRule(ctx, sels, decls, key) {
        var d = [], specific = false, display = null;
        for (var i = 0; i < decls.length; i++) {
            var p = decls[i].p, isDisplay = p === 'display';
            if (!isDisplay && !GRID_SPECIFIC.test(p) && !GRID_RELATED.test(p)) continue;
            var v = resolveVars(decls[i].v, null, ctx);
            if (v === null) continue;
            v = trim(v);
            if (isDisplay) { display = v.toLowerCase(); if (/^(inline-)?grid$/.test(display)) specific = true; }
            else if (GRID_SPECIFIC.test(p)) specific = true;
            d.push([p, v, decls[i].imp ? 1 : 0]);
        }
        var wasGrid = display !== null && ctx.gridSels && ctx.gridSels[key] !== undefined;
        if (!d.length || (!specific && !wasGrid && display !== null && d.length === 1)) return;
        var media = ctx.mediaStack && ctx.mediaStack.length ? ctx.mediaStack.slice(0) : null;
        var entry = { h: manifestHash('gd|' + sels.join(',') + '|' + JSON.stringify(d) + '|' + (media ? media.join('&') : '')), s: sels, sp: [], d: d };
        for (var k = 0; k < sels.length; k++) entry.sp.push(specificity(sels[k]));
        if (media) entry.m = media;
        // (alignment, gaps and order in rules of their own, utility classes: they matter only in a document that has
        // grids, and go out with its manifest at the end)
        if (!specific && !wasGrid) { (ctx.gdPending || (ctx.gdPending = [])).push(entry); return; }
        ctx.gdAny = true;
        manifestAdd('gd', entry);
    }
    function flushGridRules(ctx) {
        if (ctx.gdAny && ctx.gdPending) for (var i = 0; i < ctx.gdPending.length; i++) manifestAdd('gd', ctx.gdPending[i]);
        ctx.gdPending = null;
    }

    function manifestAdd(kind, entry) {
        if (g_suppressManifest) return;
        if (!g_manifest) g_manifest = { has: [], cq: [], dv: [], pt: [], cv: [], sc: [], mk: [], gd: [], seen: {} };
        var key = kind + ':' + entry.h;
        if (g_manifest.seen[key]) return;
        g_manifest.seen[key] = true;
        g_manifest[kind].push(entry);
    }

    function pxString(n) { return (Math.round(n * 100) / 100) + 'px'; }

    // ---- calc-style expressions evaluated statically: numbers with absolute, font or viewport units, + - * /, parentheses.
    // Returns {n, u} with u '' (number), 'px', '%', 'deg' or 's', or null when something (ch, unknown idents, a
    // percentage mixed with a length) cannot be resolved. Percentages only combine with percentages and numbers:
    // tailwind 4's -translate-x-1/2 is calc(calc(1/2 * 100%) * -1), which the old engine keeps as a calc it cannot
    // use inside translate(), and -50% is what it means.
    var MATH_CONSTANTS = { e: Math.E, pi: Math.PI, infinity: Infinity, nan: NaN };
    // (keepFont: em and rem stay what they are, for calc(): calc(1 * 1em) in a rule with font-size: 44px is 44 px, not
    // the 16 px the default font size gives; min(), max() and clamp() compare them with pixels at 16 px each)
    function unitValue(num, unit, keepFont) {
        var n = parseFloat(num);
        if (isNaN(n)) return null;
        switch (unit) {
            case '': return { n: n, u: '' };
            case 'px': return { n: n, u: 'px' };
            case '%': return { n: n, u: '%' };
            case 'vw': return { n: n * g_vpW / 100, u: 'px' };
            case 'vh': return { n: n * g_vpH / 100, u: 'px' };
            case 'vmin': return { n: n * Math.min(g_vpW, g_vpH) / 100, u: 'px' };
            case 'vmax': return { n: n * Math.max(g_vpW, g_vpH) / 100, u: 'px' };
            case 'rem': case 'em': return keepFont ? { n: n, u: unit } : { n: n * 16, u: 'px' };
            case 'ic': case 'ric': return { n: n * 16, u: 'px' };
            case 'lh': case 'rlh': return { n: n * 16 * 1.2, u: 'px' };
            case 'cap': case 'rcap': return { n: n * 16 * 0.7, u: 'px' };
            case 'rex': case 'rch': return { n: n * 8, u: 'px' };
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
            case 's': return { n: n, u: 's' };
            case 'ms': return { n: n / 1000, u: 's' };
        }
        return null;
    }
    function evalExpr(expr, keepFont) {
        var s = trim(expr).toLowerCase(), pos = 0, failed = false;
        function peek() { return s.charAt(pos); }
        function skip() { while (pos < s.length && /\s/.test(s.charAt(pos))) pos++; }
        function atom() {
            skip();
            var c = peek();
            if (c === '(') { pos++; var v = sum(); skip(); if (peek() !== ')') { failed = true; return null; } pos++; return v; }
            if (c === '-' || c === '+') { pos++; var inner = atom(); if (!inner) return null; return { n: c === '-' ? -inner.n : inner.n, u: inner.u }; }
            var m = /^(\d*\.?\d+(?:e[-+]?\d+)?)([a-z%]*)/.exec(s.slice(pos));
            if (m) { pos += m[0].length; var uv = unitValue(m[1], m[2], keepFont); if (!uv) failed = true; return uv; }
            var id = /^[a-z][a-z0-9-]*/.exec(s.slice(pos));
            if (id && MATH_CONSTANTS.hasOwnProperty(id[0])) { pos += id[0].length; return { n: MATH_CONSTANTS[id[0]], u: '' }; }
            failed = true;
            return null;
        }
        function product() {
            var left = atom();
            for (;;) {
                skip();
                var op = peek();
                if (op !== '*' && op !== '/') return left;
                pos++;
                var right = atom();
                if (!left || !right) { failed = true; return null; }
                if (op === '*') {
                    if (left.u && right.u) { failed = true; return null; }
                    left = { n: left.n * right.n, u: left.u || right.u };
                } else {
                    if (right.u && right.u !== left.u) { failed = true; return null; }
                    if (right.n === 0) { failed = true; return null; }
                    left = { n: left.n / right.n, u: right.u ? '' : left.u };
                }
            }
        }
        function sum() {
            var left = product();
            for (;;) {
                skip();
                var op = peek();
                if (op !== '+' && op !== '-') return left;
                pos++;
                var right = product();
                if (!left || !right) { failed = true; return null; }
                if (left.u !== right.u) { if (left.n === 0 && !left.u) left.u = right.u; else if (right.n === 0 && !right.u) right.u = left.u; else { failed = true; return null; } }
                left = { n: op === '+' ? left.n + right.n : left.n - right.n, u: left.u };
            }
        }
        var result = sum();
        skip();
        if (failed || !result || pos < s.length) return null;
        // a NaN result is censored to 0, infinities to a very large value (CSS Values 4)
        if (isNaN(result.n)) result.n = 0;
        else if (!isFinite(result.n)) result.n = result.n > 0 ? 1e7 : -1e7;
        return result;
    }
    function fmtValue(v) {
        var n = Math.round(v.n * 100000) / 100000;   // enough precision for nested evaluation
        return n + (v.u || '');
    }
    function evalArgs(args) {
        var out = [];
        for (var i = 0; i < args.length; i++) { var v = evalExpr(args[i]); if (!v) return null; out.push(v); }
        return out;
    }
    function sameUnit(vals) {
        for (var i = 1; i < vals.length; i++) if (vals[i].u !== vals[0].u) return false;
        return true;
    }
    function toRadians(v) { return v.u === 'deg' ? v.n * Math.PI / 180 : v.n; }
    // math functions with statically evaluable arguments; null when they must be left alone
    function evalMathFunction(name, args) {
        var vals, a, b;
        switch (name) {
            case 'round': {
                var strategy = 'nearest', list = args.slice(0);
                if (/^(nearest|up|down|to-zero)$/.test(trim(list[0]).toLowerCase())) strategy = trim(list.shift()).toLowerCase();
                vals = evalArgs(list);
                if (!vals || vals.length < 1) return null;
                a = vals[0]; b = vals.length > 1 ? vals[1] : { n: 1, u: a.u };
                if (a.u !== b.u || b.n === 0) return null;
                var q = a.n / b.n, r;
                if (strategy === 'up') r = Math.ceil(q); else if (strategy === 'down') r = Math.floor(q); else if (strategy === 'to-zero') r = q < 0 ? Math.ceil(q) : Math.floor(q); else r = Math.round(q);
                return fmtValue({ n: r * b.n, u: a.u });
            }
            case 'mod': case 'rem': {
                vals = evalArgs(args);
                if (!vals || vals.length !== 2 || vals[0].u !== vals[1].u || vals[1].n === 0) return null;
                a = vals[0].n; b = vals[1].n;
                var res = name === 'mod' ? a - b * Math.floor(a / b) : a - b * (a / b < 0 ? Math.ceil(a / b) : Math.floor(a / b));
                return fmtValue({ n: res, u: vals[0].u });
            }
            case 'abs': vals = evalArgs(args); return vals && vals.length === 1 ? fmtValue({ n: Math.abs(vals[0].n), u: vals[0].u }) : null;
            case 'sign': {
                var sv = /^\s*(-?)\s*[\d.]/.exec(args[0] || '');
                vals = evalArgs(args);
                if (vals && vals.length === 1) return String(vals[0].n > 0 ? 1 : vals[0].n < 0 ? -1 : 0);
                return sv ? (sv[1] === '-' ? '-1' : '1') : null;   // percentages keep their sign
            }
            case 'pow': vals = evalArgs(args); return vals && vals.length === 2 && !vals[0].u && !vals[1].u ? fmtValue({ n: Math.pow(vals[0].n, vals[1].n), u: '' }) : null;
            case 'sqrt': vals = evalArgs(args); return vals && vals.length === 1 && !vals[0].u && vals[0].n >= 0 ? fmtValue({ n: Math.sqrt(vals[0].n), u: '' }) : null;
            case 'hypot': {
                vals = evalArgs(args);
                if (!vals || !vals.length || !sameUnit(vals)) return null;
                var sq = 0;
                for (var i = 0; i < vals.length; i++) sq += vals[i].n * vals[i].n;
                return fmtValue({ n: Math.sqrt(sq), u: vals[0].u });
            }
            case 'exp': vals = evalArgs(args); return vals && vals.length === 1 && !vals[0].u ? fmtValue({ n: Math.exp(vals[0].n), u: '' }) : null;
            case 'log': {
                vals = evalArgs(args);
                if (!vals || !vals.length || vals[0].u || vals[0].n <= 0) return null;
                var lg = Math.log(vals[0].n);
                if (vals.length > 1) { if (vals[1].u || vals[1].n <= 0) return null; lg /= Math.log(vals[1].n); }
                return fmtValue({ n: lg, u: '' });
            }
            case 'sin': case 'cos': case 'tan': {
                vals = evalArgs(args);
                if (!vals || vals.length !== 1 || (vals[0].u && vals[0].u !== 'deg')) return null;
                var rad = toRadians(vals[0]);
                var t = name === 'sin' ? Math.sin(rad) : name === 'cos' ? Math.cos(rad) : Math.tan(rad);
                if (!isFinite(t) || Math.abs(t) > 1e12) return null;
                return fmtValue({ n: t, u: '' });
            }
            case 'asin': case 'acos': case 'atan': {
                vals = evalArgs(args);
                if (!vals || vals.length !== 1 || vals[0].u) return null;
                var an = name === 'asin' ? Math.asin(vals[0].n) : name === 'acos' ? Math.acos(vals[0].n) : Math.atan(vals[0].n);
                if (isNaN(an)) return null;
                return fmtValue({ n: an * 180 / Math.PI, u: 'deg' });
            }
            case 'atan2': {
                vals = evalArgs(args);
                if (!vals || vals.length !== 2 || vals[0].u !== vals[1].u) return null;
                return fmtValue({ n: Math.atan2(vals[0].n, vals[1].n) * 180 / Math.PI, u: 'deg' });
            }
        }
        return null;
    }

    function applyFunction(name, inner) {
        switch (name) {
            case 'calc': {
                var calcEval = evalExpr(inner, g_mathDepth === 0);
                if (calcEval) return fmtValue(calcEval);
                // constants and evaluable pieces are substituted; the rest stays a calc() the old engine understands
                var calcInner = inner.replace(/(^|[^\w.-])(e|pi)(?![\w.-])/gi, function (m, pre, id) { return pre + Math.round(MATH_CONSTANTS[id.toLowerCase()] * 100000) / 100000; });
                return '-webkit-calc(' + calcInner + ')';
            }
            case 'clamp': {
                var a = splitTop(inner, ',');
                if (a.length === 3) {
                    var cv = evalArgs(a);
                    if (cv && sameUnit(cv)) return fmtValue({ n: Math.min(Math.max(cv[1].n, cv[0].n), cv[2].n), u: cv[0].u });
                    return trim(a[1]);
                }
                return trim(a[0]);
            }
            case 'min': { var mn = splitTop(inner, ','), mnv = evalArgs(mn); if (mnv && sameUnit(mnv)) { var mnBest = mnv[0]; for (var mi = 1; mi < mnv.length; mi++) if (mnv[mi].n < mnBest.n) mnBest = mnv[mi]; return fmtValue(mnBest); } return pickMin(mn); }
            case 'max': { var mx = splitTop(inner, ','), mxv = evalArgs(mx); if (mxv && sameUnit(mxv)) { var mxBest = mxv[0]; for (var xi = 1; xi < mxv.length; xi++) if (mxv[xi].n > mxBest.n) mxBest = mxv[xi]; return fmtValue(mxBest); } return trim(mx[0]); }
            case 'round': case 'mod': case 'rem': case 'abs': case 'sign': case 'pow': case 'sqrt': case 'hypot':
            case 'sin': case 'cos': case 'tan': case 'asin': case 'acos': case 'atan': case 'atan2': case 'exp': case 'log': {
                var mr = evalMathFunction(name, splitTop(inner, ','));
                if (mr !== null) return mr;
                var r = splitTop(inner, ',');
                return trim(/^(nearest|up|down|to-zero)$/.test(trim(r[0])) && r.length > 1 ? r[1] : r[0]);
            }
            case 'linear-gradient': case 'repeating-linear-gradient':
                return '-webkit-' + name + '(' + convertLinearGradient(inner) + ')';
            case 'radial-gradient': case 'repeating-radial-gradient':
                return '-webkit-' + name + '(' + convertRadialGradient(inner) + ')';
            case 'conic-gradient': return '-webkit-linear-gradient(' + convertConicGradient(inner) + ')';
            case 'repeating-conic-gradient': return '-webkit-repeating-linear-gradient(' + convertConicGradient(inner) + ')';
            case 'image': return convertImage(inner);
            case 'cross-fade': return convertCrossFade(inner);
            case 'paint': case 'element':
                return 'none';
            case 'image-set': {
                // type() hints go, bare strings become url(), resolutions become x; the engine's -webkit-image-set takes
                // url() images only, so a set with gradients resolves to the candidate meant for this display
                var cands = splitTop(inner.replace(/\s*type\([^)]*\)/g, ''), ','), parsedSet = [], allUrls = true;
                for (var ci2 = 0; ci2 < cands.length; ci2++) {
                    var ctoks = splitWS(trim(cands[ci2]));
                    if (!ctoks.length) continue;
                    var img = ctoks[0], res = 1, rm = ctoks.length > 1 ? /^([\d.]+)(x|dppx|dpi|dpcm)$/i.exec(ctoks[ctoks.length - 1]) : null;
                    if (rm) { var rn = parseFloat(rm[1]), ru = rm[2].toLowerCase(); res = ru === 'dpi' ? rn / 96 : ru === 'dpcm' ? rn * 2.54 / 96 : rn; if (ctoks.length > 2) img = ctoks.slice(0, -1).join(' '); }
                    else if (ctoks.length > 1) img = ctoks.join(' ');
                    if (/^["']/.test(img)) img = 'url(' + img + ')';
                    if (!/^url\(/i.test(img)) allUrls = false;
                    parsedSet.push({ img: img, res: res });
                }
                if (!parsedSet.length) return 'none';
                if (allUrls) {
                    var setParts = [];
                    for (var sp2 = 0; sp2 < parsedSet.length; sp2++) setParts.push(parsedSet[sp2].img + ' ' + (Math.round(parsedSet[sp2].res * 1000) / 1000) + 'x');
                    return '-webkit-image-set(' + setParts.join(', ') + ')';
                }
                var bestC = parsedSet[0];
                for (var bc = 1; bc < parsedSet.length; bc++) {
                    var cand = parsedSet[bc];
                    if ((cand.res >= g_dpr && (bestC.res < g_dpr || cand.res < bestC.res)) || (bestC.res < g_dpr && cand.res > bestC.res)) bestC = cand;
                }
                return bestC.img;
            }
            case 'fit-content': return inner;
            case 'progress': {
                // progress(value, start, end) -> a plain number
                var pa = evalArgs(splitTop(inner, ','));
                if (pa && pa.length === 3 && sameUnit(pa) && pa[2].n !== pa[1].n) return fmtValue({ n: (pa[0].n - pa[1].n) / (pa[2].n - pa[1].n), u: '' });
                return null;
            }
            case 'mix': case 'calc-mix': {
                // mix(<progress>, a, b): numbers and lengths interpolate, colours go through color-mix, anything else picks a side
                var ma = splitTop(inner, ',');
                if (ma.length !== 3) return null;
                var mp = mixProgress(trim(ma[0]));
                if (mp === null) return null;
                var mA = trim(ma[1]), mB = trim(ma[2]), nA = evalExpr(mA), nB = evalExpr(mB);
                if (nA && nB && sameUnit([nA, nB])) return fmtValue({ n: nA.n + (nB.n - nA.n) * mp, u: nA.u });
                if (name === 'mix' && parseColor(mA) && parseColor(mB)) return convertColorFunction('color-mix', 'in srgb, ' + mA + ' ' + Math.round((1 - mp) * 100) + '%, ' + mB);
                return mp < 0.5 ? mA : mB;
            }
            case 'ident': {
                // ident("cool-" 1) -> cool-1
                var idParts = splitWS(inner), ident = '';
                for (var ip = 0; ip < idParts.length; ip++) { var sm = /^(["'])([\s\S]*)\1$/.exec(idParts[ip]); ident += sm ? sm[2] : idParts[ip]; }
                return /^-?[a-zA-Z_][\w-]*$/.test(ident) ? ident : null;
            }
            case 'random-item': {
                // random-item(<key>; a; b; c): one of the items, chosen when the stylesheet is rewritten
                var items = splitTop(inner, ';');
                if (items.length < 2) return null;
                return trim(items[1 + Math.floor(Math.random() * (items.length - 1))]);
            }
            case 'media-progress': {
                // media-progress(width, a, b) against the viewport the page is rewritten for
                var mp = splitTop(inner, ',');
                if (mp.length !== 3) return null;
                var feature = trim(mp[0]).toLowerCase(), fv, pctUnit;
                if (feature === 'width') { fv = g_viewportWidth; pctUnit = 'vw'; }
                else if (feature === 'height') { fv = g_viewportHeight; pctUnit = 'vh'; }
                else if (feature === 'resolution') { fv = g_dpr * 96; pctUnit = null; }
                else return null;
                var toUnits = function (s) { s = s.replace(/(\d)%/g, '$1' + (pctUnit || '%')); return feature === 'resolution' ? s.replace(/(-?[\d.]+)dppx/g, function (m0, n) { return (parseFloat(n) * 96) + 'px'; }).replace(/(-?[\d.]+)dpi/g, '$1px') : s; };
                var mlo = evalExpr(toUnits(mp[1])), mhi = evalExpr(toUnits(mp[2]));
                if (!mlo || !mhi || mhi.n === mlo.n) return null;
                return fmtValue({ n: (fv - mlo.n) / (mhi.n - mlo.n), u: '' });
            }
            case 'random': {
                // random([options,] min, max [, step]): one value chosen when the stylesheet is rewritten
                var rArgs = splitTop(inner, ','), rNums = [];
                for (var ri = 0; ri < rArgs.length; ri++) { var rvv = evalExpr(rArgs[ri]); if (rvv) rNums.push(rvv); }
                if (rNums.length < 2 || !sameUnit(rNums)) return null;
                var rMin = rNums[0].n, rMax = rNums[1].n, rVal = rMin + Math.random() * (rMax - rMin);
                if (rNums.length > 2 && rNums[2].n > 0) rVal = rMin + Math.round((rVal - rMin) / rNums[2].n) * rNums[2].n;
                return fmtValue({ n: Math.min(rMax, rVal), u: rNums[0].u });
            }
            case 'calc-size': {
                // calc-size(basis, expr): the basis alone, or the expression evaluated when the basis is a plain length
                var csArgs = splitTop(inner, ',');
                if (csArgs.length !== 2) return null;
                var csBasis = trim(csArgs[0]), csExpr = trim(csArgs[1]).toLowerCase();
                if (/^stretch$/i.test(csBasis)) return null;   // the engine has no stretch keyword: measured by the page shim
                if (csExpr === 'size') return csBasis;
                if (csExpr.indexOf('size') < 0) { var csPlain = evalExpr(csExpr); return csPlain ? fmtValue(csPlain) : '-webkit-calc(' + csExpr + ')'; }
                var csBase = evalExpr(csBasis);
                if (!csBase) return null;   // auto / stretch / max-content bases need the layout, which only the engine knows
                var csVal = evalExpr(csExpr.replace(/\bsize\b/g, '(' + fmtValue(csBase) + ')'));
                return csVal ? fmtValue(csVal) : null;
            }
            case 'rgb': case 'rgba': case 'hsl': case 'hsla': case 'hwb': case 'oklch': case 'oklab': case 'lab': case 'lch': case 'color': case 'color-mix': case 'light-dark':
            case 'contrast-color': case 'device-cmyk': case 'ictcp': case 'jzazbz': case 'jzczhz': case 'color-hdr':
                return convertColorFunction(name, inner);
            case 'env': { var e = splitTop(inner, ','); return e.length > 1 ? trim(e[1]) : '0px'; }
        }
        return null;
    }

    // values that contain none of the functions we rewrite skip the walker entirely (url(), translate(), ... are common)
    var INTERESTING_FN = /(?:^|[^a-zA-Z0-9_-])(?:calc|clamp|min|max|linear-gradient|repeating-linear-gradient|radial-gradient|repeating-radial-gradient|conic-gradient|repeating-conic-gradient|rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch|color|color-mix|light-dark|contrast-color|device-cmyk|env|image-set|image|fit-content|round|mod|rem|abs|sign|pow|sqrt|hypot|sin|cos|tan|asin|acos|atan|atan2|exp|log|paint|element|cross-fade|progress|mix|calc-mix|random|calc-size|ident|random-item|media-progress|ictcp|jzazbz|jzczhz|color-hdr)\(/i;

    var g_dpr = 1;   // device pixel ratio of the page being rewritten (set by run())

    function mixProgress(tok) {   // "0.5" or "50%" -> 0.5; timelines and other sources cannot be resolved statically
        if (/^-?[\d.]+%$/.test(tok)) return parseFloat(tok) / 100;
        if (/^-?[\d.]+$/.test(tok)) return parseFloat(tok);
        return null;
    }

    // (how deep in math functions the one being rewritten is: a calc() inside min(), max() or clamp() gives pixels, so
    // that they can be compared; one on its own keeps em and rem)
    var MATH_FNS = { calc: 1, min: 1, max: 1, clamp: 1, round: 1, mod: 1, rem: 1, abs: 1, sign: 1, pow: 1, sqrt: 1, hypot: 1, sin: 1, cos: 1,
        tan: 1, asin: 1, acos: 1, atan: 1, atan2: 1, exp: 1, log: 1 };
    var g_mathDepth = 0;
    function transformFunctions(s) {
        if (s.indexOf('(') < 0 || !INTERESTING_FN.test(s)) return s;
        var out = [], i = 0, n = s.length, start = 0;
        while (i < n) {
            var c = s.charCodeAt(i);
            if (c === 34 || c === 39) { i = skipString(s, i, n); continue; }
            if (c !== 40) { i++; continue; }
            // function call: name is the identifier right before the "("
            var k = i;
            while (k > start && /[a-zA-Z0-9_-]/.test(s.charAt(k - 1))) k--;
            var name = s.slice(k, i).toLowerCase();
            var close = matchParen(s, i);
            var rawInner = s.slice(i + 1, close);
            if (name === 'url' || name === 'attr' || name === 'format' || name === 'local' || name === 'var') { i = close + 1; continue; }
            var math = MATH_FNS.hasOwnProperty(name), inner;
            if (math) g_mathDepth++;
            try { inner = transformFunctions(rawInner); } finally { if (math) g_mathDepth--; }
            var replaced = name ? applyFunction(name, inner) : null;
            if (replaced !== null && replaced !== undefined) {
                out.push(s.slice(start, k), replaced);
            } else if (inner !== rawInner) {
                out.push(s.slice(start, i + 1), inner, ')');
            } else {
                i = close + 1;
                continue;
            }
            start = i = close + 1;
        }
        if (!out.length) return s;
        out.push(s.slice(start));
        return out.join('');
    }

    var INHERITED = { color: 1, cursor: 1, direction: 1, font: 1, 'font-family': 1, 'font-size': 1, 'font-style': 1, 'font-weight': 1, 'font-variant': 1,
        'letter-spacing': 1, 'line-height': 1, 'list-style': 1, 'list-style-type': 1, 'list-style-position': 1, 'list-style-image': 1, quotes: 1,
        'text-align': 1, 'text-indent': 1, 'text-transform': 1, visibility: 1, 'white-space': 1, 'word-spacing': 1, 'word-break': 1, 'word-wrap': 1,
        'overflow-wrap': 1, 'caption-side': 1, 'border-collapse': 1, 'border-spacing': 1, 'empty-cells': 1, 'tab-size': 1, hyphens: 1, 'text-shadow': 1 };

    // lh = line height (normal is about 1.2 em), cap = cap height, ic = ideographic advance, rex/rch = root ex/ch
    var FONT_UNITS = { lh: [1.2, 'em'], rlh: [1.2, 'rem'], cap: [0.7, 'em'], rcap: [0.7, 'rem'], ic: [1, 'em'], ric: [1, 'rem'], rex: [0.5, 'rem'], rch: [0.5, 'rem'] };

    // properties whose words are names (an animation called "mark", a font called "Canvas"), never system colors
    var NAME_PROPS = { 'font-family': 1, animation: 1, 'animation-name': 1, '-webkit-animation': 1, '-webkit-animation-name': 1,
        'grid-area': 1, 'grid-row': 1, 'grid-column': 1, 'grid-row-start': 1, 'grid-row-end': 1, 'grid-column-start': 1, 'grid-column-end': 1,
        'counter-reset': 1, 'counter-increment': 1, 'counter-set': 1, 'list-style-type': 1, 'will-change': 1, 'transition-property': 1,
        'container-name': 1, container: 1, 'view-transition-name': 1, 'anchor-name': 1, 'position-anchor': 1 };

    var SIZING = { width: 1, height: 1, 'min-width': 1, 'min-height': 1, 'max-width': 1, 'max-height': 1, 'flex-basis': 1,
        'inline-size': 1, 'block-size': 1, 'min-inline-size': 1, 'max-inline-size': 1, 'min-block-size': 1, 'max-block-size': 1 };

    // Addresses and strings are set aside while a value's units and colors are rewritten, and put back after: the
    // passes rewrote them too (a "6lh" in a base64 font became "7.2em", url(icons.svg#face) a color, "Mark" a system color)
    function maskLiterals(v, kept) {
        if (!/url\(|["']/i.test(v)) return v;
        return v.replace(/url\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*)\s*\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gi, function (m) {
            kept.push(m);
            return '' + (kept.length - 1) + '';
        });
    }
    function unmaskLiterals(v, kept) {
        return kept.length ? v.replace(/(\d+)/g, function (m, i) { return kept[+i]; }) : v;
    }

    function fixValue(p, v) {
        // typed attr() and attr() fallbacks in content: the engine's plain attr(name)
        if (p === 'content' && /attr\(/i.test(v)) v = v.replace(/attr\(\s*([\w:.-]+)[^)]*\)/gi, 'attr($1)');
        // request modifiers inside url(): url("a.png" crossorigin(anonymous) referrerpolicy(no-referrer)) -> url("a.png")
        if (/url\(\s*["']/i.test(v)) v = v.replace(/url\(\s*("[^"]*"|'[^']*')(?:\s+[a-z-]+\([^()]*\))+\s*\)/gi, 'url($1)');
        if (v.indexOf('(') >= 0) v = transformFunctions(v);
        var kept = [];
        v = maskLiterals(v, kept);
        v = fixHexAlpha(v);
        if (COLOR_KEYWORD_RE.test(v) && !NAME_PROPS[p]) v = v.replace(new RegExp(COLOR_KEYWORD_RE.source, 'gi'), function (m) { return COLOR_KEYWORDS[m.toLowerCase()] || m; });
        if (/\d(dvh|svh|lvh|dvw|svw|lvw|cqw|cqh|cqi|cqb|cqmin|cqmax|vi|vb|svi|lvi|dvi|svb|lvb|dvb|svmin|lvmin|dvmin|svmax|lvmax|dvmax)\b/.test(v)) {
            v = v.replace(/(\d)(dvh|svh|lvh|cqh|cqb|vb|svb|lvb|dvb)\b/g, '$1vh').replace(/(\d)(dvw|svw|lvw|cqw|cqi|vi|svi|lvi|dvi)\b/g, '$1vw')
                 .replace(/(\d)(cqmin|svmin|lvmin|dvmin)\b/g, '$1vmin').replace(/(\d)(cqmax|svmax|lvmax|dvmax)\b/g, '$1vmax');
        }
        // viewport units as pixels of the pass's viewport (see VP_UNIT_RE)
        if (/\dv(w|h|min|max)\b/i.test(v)) v = v.replace(/(-?\d*\.?\d+)(vw|vh|vmin|vmax)\b/gi, function (m, n, u) {
            u = u.toLowerCase();
            var base = u === 'vw' ? g_vpW : u === 'vh' ? g_vpH : u === 'vmin' ? Math.min(g_vpW, g_vpH) : Math.max(g_vpW, g_vpH);
            return (Math.round(parseFloat(n) * base) / 100) + 'px';
        });
        // font-relative units the engine lacks, as their typical em/rem equivalents
        if (/\d(lh|rlh|cap|rcap|ic|ric|rex|rch)\b/.test(v)) v = v.replace(/(-?\d*\.?\d+)(lh|rlh|cap|rcap|ic|ric|rex|rch)\b/g, function (m, num, unit) {
            var f = FONT_UNITS[unit];
            return (Math.round(parseFloat(num) * f[0] * 1000) / 1000) + f[1];
        });
        v = unmaskLiterals(v, kept);
        var lv = v.toLowerCase();
        if (lv === 'unset' || lv === 'revert' || lv === 'revert-layer') return INHERITED[p] ? 'inherit' : 'initial';
        // a height sized by its content is what auto already gives
        if ((p === 'height' || p === 'block-size') && /^(-webkit-)?(fit|max|min)-content$/.test(lv)) return 'auto';
        if (SIZING[p]) {
            if (lv === 'fit-content') return '-webkit-fit-content';
            if (lv === 'max-content') return '-webkit-max-content';
            if (lv === 'min-content') return '-webkit-min-content';
            if (lv === 'stretch' || lv === '-moz-available') return '-webkit-fill-available';
        }
        return v;
    }

    // ------------------------------------------------------------------ declarations

    var PREFIX = { transform: 1, 'transform-origin': 1, 'transform-style': 1, transition: 1, 'transition-property': 1, 'transition-duration': 1,
        'transition-timing-function': 1, 'transition-delay': 1, animation: 1, 'animation-name': 1, 'animation-duration': 1, 'animation-timing-function': 1,
        'animation-delay': 1, 'animation-iteration-count': 1, 'animation-direction': 1, 'animation-fill-mode': 1, 'animation-play-state': 1,
        'backface-visibility': 1, perspective: 1, 'perspective-origin': 1, 'column-count': 1, 'column-gap': 1, 'column-width': 1, 'column-rule': 1,
        'column-rule-color': 1, 'column-rule-style': 1, 'column-rule-width': 1, 'column-span': 1, 'column-fill': 1, columns: 1, 'user-select': 1,
        appearance: 1, filter: 1, mask: 1, 'mask-image': 1, 'mask-size': 1, 'mask-position': 1, 'mask-repeat': 1, 'mask-composite': 1, 'mask-clip': 1,
        'mask-origin': 1, 'clip-path': 1, 'text-size-adjust': 1, 'font-feature-settings': 1, hyphens: 1, 'box-decoration-break': 1, 'font-kerning': 1,
        'writing-mode': 1, 'text-orientation': 1, 'shape-outside': 1, 'shape-margin': 1, 'text-emphasis': 1, 'text-emphasis-style': 1, 'text-emphasis-color': 1,
        'line-clamp': 1, 'box-reflect': 1, 'text-combine': 1, 'font-smoothing': 1, 'overflow-scrolling': 1, 'tap-highlight-color': 1, 'text-fill-color': 1, 'hyphenate-character': 1, 'tab-size': 1,
        'text-stroke': 1, 'text-stroke-width': 1, 'text-stroke-color': 1, 'print-color-adjust': 1, 'background-clip': 0 };

    var PACK = { 'flex-start': 'start', start: 'start', left: 'start', 'flex-end': 'end', end: 'end', right: 'end', center: 'center',
        'space-between': 'justify', 'space-around': 'justify', 'space-evenly': 'justify', stretch: 'start', normal: 'start', 'anchor-center': 'center' };
    var ALIGN = { 'flex-start': 'start', start: 'start', 'self-start': 'start', left: 'start', 'flex-end': 'end', end: 'end', 'self-end': 'end', right: 'end',
        center: 'center', 'anchor-center': 'center', baseline: 'baseline', stretch: 'stretch', normal: 'stretch' };

    function isGlobalKeyword(lv) { return lv === 'inherit' || lv === 'initial'; }

    var NON_NEGATIVE = { width: 1, height: 1, 'min-width': 1, 'min-height': 1, 'max-width': 1, 'max-height': 1, padding: 1, 'padding-top': 1,
        'padding-right': 1, 'padding-bottom': 1, 'padding-left': 1, 'inline-size': 1, 'block-size': 1, 'border-width': 1, 'font-size': 1, 'line-height': 1 };
    // the gaps of flex and grid containers (see gapMark in fixDeclarations)
    var GAP_NAMES = { gap: 1, 'row-gap': 1, 'column-gap': 1, 'grid-gap': 1, 'grid-row-gap': 1, 'grid-column-gap': 1 };

    // ---- transitions of properties the old engine does not know crash its animation code (WebCore null
    // dereference on some pages, found on astro.build): such names become one it knows and never animates
    // (replaced rather than dropped, so the duration and delay lists stay aligned). OLD_ENGINE_PROPS: the property
    // names of the iOS 6 engine, read from the device (for (k in element.style)).
    var OLD_ENGINE_PROPS = 'alignment-baseline,background,background-attachment,background-clip,background-color,background-image,background-origin,background-position,' +
        'background-position-x,background-position-y,background-repeat,background-repeat-x,background-repeat-y,background-size,baseline-shift,border,' +
        'border-bottom,border-bottom-color,border-bottom-left-radius,border-bottom-right-radius,border-bottom-style,border-bottom-width,' +
        'border-collapse,border-color,border-image,border-image-outset,border-image-repeat,border-image-slice,border-image-source,border-image-width,' +
        'border-left,border-left-color,border-left-style,border-left-width,border-radius,border-right,border-right-color,border-right-style,' +
        'border-right-width,border-spacing,border-style,border-top,border-top-color,border-top-left-radius,border-top-right-radius,border-top-style,' +
        'border-top-width,border-width,bottom,box-shadow,box-sizing,caption-side,clear,clip,clip-path,clip-rule,color,color-interpolation,' +
        'color-interpolation-filters,color-profile,color-rendering,content,counter-increment,counter-reset,cursor,direction,display,dominant-baseline,' +
        'empty-cells,enable-background,fill,fill-opacity,fill-rule,filter,float,flood-color,flood-opacity,font,font-family,font-size,font-stretch,' +
        'font-style,font-variant,font-weight,glyph-orientation-horizontal,glyph-orientation-vertical,height,image-rendering,kerning,left,' +
        'letter-spacing,lighting-color,line-height,list-style,list-style-image,list-style-position,list-style-type,margin,margin-bottom,margin-left,' +
        'margin-right,margin-top,marker,marker-end,marker-mid,marker-start,mask,max-height,max-width,min-height,min-width,opacity,orphans,outline,' +
        'outline-color,outline-offset,outline-style,outline-width,overflow,overflow-x,overflow-y,padding,padding-bottom,padding-left,padding-right,' +
        'padding-top,page,page-break-after,page-break-before,page-break-inside,pointer-events,position,quotes,resize,right,shape-rendering,size,speak,' +
        'src,stop-color,stop-opacity,stroke,stroke-dasharray,stroke-dashoffset,stroke-linecap,stroke-linejoin,stroke-miterlimit,stroke-opacity,' +
        'stroke-width,table-layout,text-align,text-anchor,text-decoration,text-indent,text-line-through,text-line-through-color,' +
        'text-line-through-mode,text-line-through-style,text-line-through-width,text-overflow,text-overline,text-overline-color,text-overline-mode,' +
        'text-overline-style,text-overline-width,text-rendering,text-shadow,text-transform,text-underline,text-underline-color,text-underline-mode,' +
        'text-underline-style,text-underline-width,top,unicode-bidi,unicode-range,vector-effect,vertical-align,visibility,-webkit-animation,' +
        '-webkit-animation-delay,-webkit-animation-direction,-webkit-animation-duration,-webkit-animation-fill-mode,-webkit-animation-iteration-count,' +
        '-webkit-animation-name,-webkit-animation-play-state,-webkit-animation-timing-function,-webkit-appearance,-webkit-aspect-ratio,' +
        '-webkit-backface-visibility,-webkit-background-clip,-webkit-background-composite,-webkit-background-origin,-webkit-background-size,' +
        '-webkit-border-after,-webkit-border-after-color,-webkit-border-after-style,-webkit-border-after-width,-webkit-border-before,' +
        '-webkit-border-before-color,-webkit-border-before-style,-webkit-border-before-width,-webkit-border-end,-webkit-border-end-color,' +
        '-webkit-border-end-style,-webkit-border-end-width,-webkit-border-fit,-webkit-border-horizontal-spacing,-webkit-border-image,' +
        '-webkit-border-radius,-webkit-border-start,-webkit-border-start-color,-webkit-border-start-style,-webkit-border-start-width,' +
        '-webkit-border-vertical-spacing,-webkit-box-align,-webkit-box-direction,-webkit-box-flex,-webkit-box-flex-group,-webkit-box-lines,' +
        '-webkit-box-ordinal-group,-webkit-box-orient,-webkit-box-pack,-webkit-box-reflect,-webkit-box-shadow,-webkit-color-correction,' +
        '-webkit-column-axis,-webkit-column-break-after,-webkit-column-break-before,-webkit-column-break-inside,-webkit-column-count,' +
        '-webkit-column-gap,-webkit-column-progression,-webkit-column-rule,-webkit-column-rule-color,-webkit-column-rule-style,' +
        '-webkit-column-rule-width,-webkit-column-span,-webkit-column-width,-webkit-columns,-webkit-composition-fill-color,' +
        '-webkit-composition-frame-color,-webkit-filter,-webkit-font-feature-settings,-webkit-font-kerning,-webkit-font-size-delta,' +
        '-webkit-font-smoothing,-webkit-font-variant-ligatures,-webkit-grid-column,-webkit-grid-columns,-webkit-grid-row,-webkit-grid-rows,' +
        '-webkit-highlight,-webkit-hyphenate-character,-webkit-hyphenate-limit-after,-webkit-hyphenate-limit-before,-webkit-hyphenate-limit-lines,' +
        '-webkit-hyphens,-webkit-line-align,-webkit-line-box-contain,-webkit-line-break,-webkit-line-clamp,-webkit-line-grid,-webkit-line-snap,' +
        '-webkit-locale,-webkit-logical-height,-webkit-logical-width,-webkit-margin-after,-webkit-margin-after-collapse,-webkit-margin-before,' +
        '-webkit-margin-before-collapse,-webkit-margin-bottom-collapse,-webkit-margin-collapse,-webkit-margin-end,-webkit-margin-start,' +
        '-webkit-margin-top-collapse,-webkit-marquee,-webkit-marquee-direction,-webkit-marquee-increment,-webkit-marquee-repetition,' +
        '-webkit-marquee-speed,-webkit-marquee-style,-webkit-mask,-webkit-mask-attachment,-webkit-mask-box-image,-webkit-mask-box-image-outset,' +
        '-webkit-mask-box-image-repeat,-webkit-mask-box-image-slice,-webkit-mask-box-image-source,-webkit-mask-box-image-width,-webkit-mask-clip,' +
        '-webkit-mask-composite,-webkit-mask-image,-webkit-mask-origin,-webkit-mask-position,-webkit-mask-position-x,-webkit-mask-position-y,' +
        '-webkit-mask-repeat,-webkit-mask-repeat-x,-webkit-mask-repeat-y,-webkit-mask-size,-webkit-match-nearest-mail-blockquote-color,' +
        '-webkit-max-logical-height,-webkit-max-logical-width,-webkit-min-logical-height,-webkit-min-logical-width,-webkit-nbsp-mode,' +
        '-webkit-overflow-scrolling,-webkit-padding-after,-webkit-padding-before,-webkit-padding-end,-webkit-padding-start,-webkit-perspective,' +
        '-webkit-perspective-origin,-webkit-perspective-origin-x,-webkit-perspective-origin-y,-webkit-print-color-adjust,-webkit-rtl-ordering,' +
        '-webkit-svg-shadow,-webkit-tap-highlight-color,-webkit-text-combine,-webkit-text-decorations-in-effect,-webkit-text-emphasis,' +
        '-webkit-text-emphasis-color,-webkit-text-emphasis-position,-webkit-text-emphasis-style,-webkit-text-fill-color,-webkit-text-orientation,' +
        '-webkit-text-security,-webkit-text-size-adjust,-webkit-text-stroke,-webkit-text-stroke-color,-webkit-text-stroke-width,-webkit-touch-callout,' +
        '-webkit-transform,-webkit-transform-origin,-webkit-transform-origin-x,-webkit-transform-origin-y,-webkit-transform-origin-z,' +
        '-webkit-transform-style,-webkit-transition,-webkit-transition-delay,-webkit-transition-duration,-webkit-transition-property,' +
        '-webkit-transition-timing-function,-webkit-user-drag,-webkit-user-modify,-webkit-user-select,-webkit-writing-mode,white-space,widows,width,' +
        'word-break,word-spacing,word-wrap,writing-mode,z-index,zoom';
    var OLD_PROPS_SET = null;
    var TRANSITION_WORDS = { ease: 1, linear: 1, 'ease-in': 1, 'ease-out': 1, 'ease-in-out': 1, 'step-start': 1, 'step-end': 1, initial: 1, inherit: 1,
                             unset: 1, normal: 1, 'allow-discrete': 1 };
    function safeTransitionProps(value, shorthand) {
        if (!OLD_PROPS_SET) { OLD_PROPS_SET = {}; var names = OLD_ENGINE_PROPS.split(','); for (var n = 0; n < names.length; n++) OLD_PROPS_SET[names[n]] = 1; }
        var parts = splitTop(value, ','), changed = false;
        for (var i = 0; i < parts.length; i++) {
            var toks = splitWS(trim(parts[i]));
            for (var j = 0; j < toks.length; j++) {
                var t = toks[j].toLowerCase();
                if (!/^-{0,2}[a-z][\w-]*$/.test(t) || (shorthand && TRANSITION_WORDS[t])) continue;   // durations, timing functions
                if (t !== 'all' && t !== 'none' && !OLD_PROPS_SET[t]) { toks[j] = '-webkit-user-select'; changed = true; }
                if (shorthand) break;   // (one property per transition)
            }
            parts[i] = toks.join(' ');
        }
        return changed ? parts.join(', ') : value;
    }

    // ---- translate(calc(A% + B)): the old engine has no calc() inside transform functions (the declaration is dropped),
    // but translations add up, so it becomes translate(A%) translate(B) when every argument is a percentage plus a
    // length (the centring idiom translateX(calc(-50% + 10px)))
    var TRANSLATE_CALC = /\b(translate(?:X|Y|3d)?)\(((?:[^()]|\([^()]*\))*)\)/gi;
    function splitCalcTranslates(v) {
        if (!/calc\(/i.test(v)) return v;
        return v.replace(TRANSLATE_CALC, function (whole, fn, argText) {
            var args = splitTop(argText, ','), pct = [], len = [], any = false;
            for (var i = 0; i < args.length; i++) {
                var a = trim(args[i]), m = /^(?:-webkit-)?calc\((.*)\)$/i.exec(a), pieces = m ? trim(m[1]).split(/\s([+-])\s/) : [a], p = 0, l = 0;
                if (m) any = true;
                if (/[()]/.test(pieces.join(''))) return whole;
                for (var k = 0; k < pieces.length; k += 2) {
                    var sign = k > 0 && pieces[k - 1] === '-' ? -1 : 1, t = trim(pieces[k]);
                    if (/^-?\d*\.?\d+%$/.test(t)) { p += sign * parseFloat(t); continue; }
                    var e = evalExpr(t);
                    if (!e || (e.u && e.u !== 'px')) return whole;
                    l += sign * e.n;
                }
                // (translate3d's z takes no percentage: "0%" there drops the whole declaration)
                if (i === 2 && p) return whole;
                pct.push(i === 2 ? '0px' : Math.round(p * 10000) / 10000 + '%');
                len.push(Math.round(l * 10000) / 10000 + 'px');
            }
            return any ? fn + '(' + pct.join(', ') + ') ' + fn + '(' + len.join(', ') + ')' : whole;
        });
    }

    // ---- transitions of -webkit-calc() values crash the old engine: once an element whose transitioned property holds
    // a calc length is styled again (any class or inline change nearby), WebKit 536 starts a transition between two
    // "different" calc values and dies blending them (seznam.cz; reproduced with a single div). The engine only meets
    // -webkit-calc because we write it, so the rewritten output is checked last: properties that got a -webkit-calc
    // value in this document or an earlier one of the page (the " calc" page entry) leave every -webkit-transition
    // list, and `all` always becomes the animatable properties without them and without the geometry ones calc is
    // mostly used for (a later stylesheet, or a value the page shim sets, may still bring calc there). A lone
    // `-webkit-transition: all ...` keeps its timing and gets the list as -webkit-transition-property after it.
    // The other order: an earlier document of the page transitions a property this one gives a calc value (nextjs.org:
    // `transition-property: height` in one stylesheet, `height: calc(100% - 4px)` in the next one). That stylesheet is in
    // the engine already, so the rule with the calc value takes the transitions of its elements over: an !important
    // -webkit-transition-property with the page's transitioned properties (the " trans" page entry) minus the calc ones.
    // Each output also ends with a /*br-page:{"calc":..,"trans":..}*/ comment of its own findings, which the app reads
    // back from cached copies too (those are not rewritten again, see BRCSSRewriter registerManifestInData).
    // Measured on the device (raw pages, a restyle loop and a class switching between two calc values): width, height,
    // max-height, top, margin-left, padding-left, text-indent, -webkit-background-size crash; -webkit-transform, border
    // radii, font-size, line-height and box shadows with calc values transition fine (the untested stay crash-prone).
    var CALC_GEOMETRY = { width: 1, height: 1, 'min-width': 1, 'min-height': 1, 'max-width': 1, left: 1, right: 1, top: 1, bottom: 1 };
    var CALC_SAFE = { '-webkit-transform': 1, transform: 1, 'border-radius': 1, 'border-top-left-radius': 1, 'border-top-right-radius': 1,
        'border-bottom-left-radius': 1, 'border-bottom-right-radius': 1, 'font-size': 1, 'line-height': 1, 'box-shadow': 1, '-webkit-box-shadow': 1 };
    // the longhands a shorthand's calc lengths land in, and the ones a transition of the shorthand animates
    var CALC_LONGHANDS = { margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
        padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
        'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
        border: ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'], 'border-top': ['border-top-width'],
        'border-right': ['border-right-width'], 'border-bottom': ['border-bottom-width'], 'border-left': ['border-left-width'], outline: ['outline-width'],
        font: ['font-size', 'line-height'], '-webkit-column-rule': ['-webkit-column-rule-width'], '-webkit-columns': ['-webkit-column-width'],
        '-webkit-perspective-origin': ['-webkit-perspective-origin-x', '-webkit-perspective-origin-y'],
        '-webkit-transform-origin': ['-webkit-transform-origin-x', '-webkit-transform-origin-y', '-webkit-transform-origin-z'],
        'background-position': ['background-position-x', 'background-position-y'], '-webkit-mask-position': ['-webkit-mask-position-x', '-webkit-mask-position-y'] };
    var TRANSITION_PARTS = { margin: CALC_LONGHANDS.margin, padding: CALC_LONGHANDS.padding, 'border-width': CALC_LONGHANDS['border-width'],
        border: CALC_LONGHANDS.border.concat(['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']),
        'border-top': ['border-top-width', 'border-top-color'], 'border-right': ['border-right-width', 'border-right-color'],
        'border-bottom': ['border-bottom-width', 'border-bottom-color'], 'border-left': ['border-left-width', 'border-left-color'],
        outline: ['outline-width', 'outline-color'], font: ['font-size', 'line-height'], '-webkit-column-rule': ['-webkit-column-rule-width', '-webkit-column-rule-color'],
        '-webkit-columns': ['-webkit-column-width', '-webkit-column-count'], '-webkit-perspective-origin': CALC_LONGHANDS['-webkit-perspective-origin'],
        '-webkit-transform-origin': CALC_LONGHANDS['-webkit-transform-origin'], 'background-position': CALC_LONGHANDS['background-position'],
        '-webkit-mask-position': CALC_LONGHANDS['-webkit-mask-position'] };
    var TAKEOVER_MARK = String.fromCharCode(1) + 'brTakeover' + String.fromCharCode(1);
    // the engine's Length properties (the crash-prone kind): a take-over list never names them, since a later
    // stylesheet may give the element a calc value there that this one cannot know of (the element keeps its other
    // transitions)
    var CALC_LENGTH = { width: 1, height: 1, 'min-width': 1, 'min-height': 1, 'max-width': 1, 'max-height': 1, top: 1, right: 1, bottom: 1, left: 1,
        'margin-top': 1, 'margin-right': 1, 'margin-bottom': 1, 'margin-left': 1, 'padding-top': 1, 'padding-right': 1, 'padding-bottom': 1,
        'padding-left': 1, 'text-indent': 1, '-webkit-background-size': 1, 'background-size': 1, 'background-position': 1, 'background-position-x': 1,
        'background-position-y': 1, '-webkit-mask-size': 1, '-webkit-mask-position': 1, '-webkit-mask-position-x': 1, '-webkit-mask-position-y': 1,
        '-webkit-transform-origin': 1, '-webkit-transform-origin-x': 1, '-webkit-transform-origin-y': 1, '-webkit-perspective-origin': 1,
        '-webkit-perspective-origin-x': 1, '-webkit-perspective-origin-y': 1, clip: 1, 'vertical-align': 1 };
    // the properties a calc value of `p` crashes transitions of (none for the safe ones)
    function calcCrashProps(p) {
        p = p.toLowerCase();
        if (CALC_SAFE[p]) return [];
        var parts = CALC_LONGHANDS[p], out = [];
        if (!parts) return [p];
        for (var i = 0; i < parts.length; i++) if (!CALC_SAFE[parts[i]]) out.push(parts[i]);
        return out.length ? [p].concat(out) : [];
    }
    // does a transition of `name` (a longhand or a shorthand) animate a property in `calc`?
    function transitionHitsCalc(name, calc) {
        if (calc[name]) return true;
        var parts = TRANSITION_PARTS[name];
        if (parts) for (var i = 0; i < parts.length; i++) if (calc[parts[i]]) return true;
        return false;
    }
    // Keyframe animations blend lengths just like transitions, and WebKit 536 dies on a -webkit-calc() there as well
    // (nextjs.org: `@keyframes x { to { height: calc(100% + 150px) } }` on lines starting at height 0%, measured on the
    // device). Inside @keyframes such a value becomes its percentage part alone (calc(100% + 150px) -> 100%), or its
    // length part when it has no percentage; null when the expression has other shapes (the declaration is dropped).
    function approximateCalc(v) {
        var out = '', i = 0, lower = v.toLowerCase();
        for (;;) {
            var at = lower.indexOf('-webkit-calc(', i);
            if (at < 0) { out += v.slice(i); break; }
            var close = matchParen(v, at + 12);
            if (close >= v.length) return null;
            var inner = v.slice(at + 13, close).replace(/(-webkit-)?calc\(/gi, '(');
            var terms = [], depth = 0, start = 0, k;
            for (k = 0; k < inner.length; k++) {
                var c = inner.charAt(k);
                if (c === '(') depth++;
                else if (c === ')') depth--;
                else if (depth === 0 && (c === '+' || c === '-') && k > 0 && /\s/.test(inner.charAt(k - 1)) && /\s/.test(inner.charAt(k + 1))) {
                    terms.push(inner.slice(start, k));
                    start = k;
                }
            }
            terms.push(inner.slice(start));
            var pct = 0, len = 0, anyPct = false;
            for (k = 0; k < terms.length; k++) {
                var t = trim(terms[k]), sign = 1;
                if (/^[+-]\s/.test(t)) { sign = t.charAt(0) === '-' ? -1 : 1; t = trim(t.slice(1)); }
                var e = evalExpr(t);
                if (!e) return null;
                if (e.u === '%') { pct += sign * e.n; anyPct = true; }
                else if (e.u === 'px' || (e.u === '' && e.n === 0)) len += sign * e.n;
                else return null;
            }
            out += v.slice(i, at) + (anyPct ? Math.round(pct * 10000) / 10000 + '%' : Math.round(len * 100) / 100 + 'px');
            i = close + 1;
        }
        return out;
    }
    // the parts of a shorthand transition that stay (the engine knows them and they hold no calc value)
    function transitionSafeParts(name, calc) {
        var parts = TRANSITION_PARTS[name] || [], out = [];
        if (!OLD_PROPS_SET) safeTransitionProps('', false);
        for (var i = 0; i < parts.length; i++) if (!calc[parts[i]] && OLD_PROPS_SET[parts[i]]) out.push(parts[i]);
        return out;
    }
    var ANIMATABLE = ('background-color,border-top-color,border-right-color,border-bottom-color,border-left-color,border-top-left-radius,' +
        'border-top-right-radius,border-bottom-left-radius,border-bottom-right-radius,box-shadow,-webkit-box-shadow,clip,color,' +
        '-webkit-column-rule-color,-webkit-filter,fill,fill-opacity,flood-color,flood-opacity,lighting-color,max-height,opacity,' +
        'outline-color,outline-offset,outline-width,stop-color,stroke,stroke-opacity,stroke-width,-webkit-text-fill-color,' +
        '-webkit-text-stroke-color,text-shadow,-webkit-transform,-webkit-transform-origin,visibility,z-index,zoom,margin-top,margin-right,' +
        'margin-bottom,margin-left,padding-top,padding-right,padding-bottom,padding-left,border-top-width,border-right-width,' +
        'border-bottom-width,border-left-width,letter-spacing,word-spacing,font-size,line-height,text-indent,-webkit-background-size,' +
        '-webkit-perspective').split(',');
    var CALC_DECL = /(^|[{;\s"'])(-?[a-z][\w-]*)\s*:\s*[^;{}"]*-webkit-calc\(/gi;
    function transitionAllList(calc) {
        if (!OLD_PROPS_SET) safeTransitionProps('', false);
        var out = [];
        for (var i = 0; i < ANIMATABLE.length; i++) {
            var p = ANIMATABLE[i];
            if (OLD_PROPS_SET[p] && !calc[p] && !CALC_GEOMETRY[p]) out.push(p);
        }
        return out;
    }
    // (a document: only its <style> blocks and style attributes are CSS)
    var STYLE_PARTS = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)|(\sstyle\s*=\s*")([^"]*)(")/gi;
    function guardCalcTransitions(out, ctx, kind) {
        var calc = {}, own = {}, k, m, i, names = [], css = kind === 'html' ? '' : out, scripts = [];
        if (kind === 'html') {
            out = hideScripts(out, scripts);
            STYLE_PARTS.lastIndex = 0;
            while ((m = STYLE_PARTS.exec(out))) css += (m[2] || m[5] || '') + ';';
        }
        if (ctx.pageCalc) for (k in ctx.pageCalc) if (ctx.pageCalc.hasOwnProperty(k)) calc[k] = 1;
        CALC_DECL.lastIndex = 0;
        while ((m = CALC_DECL.exec(css))) {
            var hit = calcCrashProps(m[2]);
            for (i = 0; i < hit.length; i++) { calc[hit[i]] = 1; own[hit[i]] = 1; }
        }
        for (k in calc) if (calc.hasOwnProperty(k)) names.push(k);
        if (names.length) ctx.root[' calc'] = names.join(' ');   // for the page's later documents
        ctx.docCalc = own;
        var trans = {}, docTrans = {};
        if (ctx.pageTrans) for (k in ctx.pageTrans) if (ctx.pageTrans.hasOwnProperty(k)) trans[k] = 1;
        if (/-webkit-transition/i.test(css)) {
            if (kind === 'html') {
                out = out.replace(STYLE_PARTS, function (whole, o1, body1, c1, o2, body2, c2) {
                    if (o1 !== undefined && o1 !== '') { body1 = guardTransitionText(body1, calc); noteTransitioned(body1, docTrans); return o1 + body1 + c1; }
                    body2 = guardTransitionText(body2, calc);
                    noteTransitioned(body2, docTrans);
                    return o2 + body2 + c2;
                });
            } else {
                out = guardTransitionText(out, calc);
                noteTransitioned(out, docTrans);
            }
        }
        for (k in docTrans) if (docTrans.hasOwnProperty(k)) trans[k] = 1;
        names = [];
        for (k in trans) if (trans.hasOwnProperty(k)) names.push(k);
        if (names.length) ctx.root[' trans'] = names.join(' ');
        ctx.docTrans = docTrans;
        // rules with a calc value an earlier document transitions (see fixDeclarations): the page's transitioned
        // properties without the calc ones
        if (out.indexOf(TAKEOVER_MARK) >= 0) {
            if (!OLD_PROPS_SET) safeTransitionProps('', false);
            var list = [];
            for (k in trans) if (trans.hasOwnProperty(k) && OLD_PROPS_SET[k] && !TRANSITION_PARTS[k] && !calc[k] && !CALC_LENGTH[k]) list.push(k);
            list.sort();
            out = out.split(TAKEOVER_MARK).join(list.length ? list.join(',') : 'none');
        }
        return kind === 'html' ? showScripts(out, scripts) : out;
    }
    // the properties the (guarded) transition declarations of a text name, shorthands with their parts
    function noteTransitioned(text, set) {
        var re = /-webkit-transition(-property)?\s*:\s*([^;{}"']*)/gi, m;
        while ((m = re.exec(text))) {
            var v = m[2].replace(/\s*!important\s*$/i, ''), items = splitTop(v, ',');
            for (var i = 0; i < items.length; i++) {
                var toks = splitWS(trim(items[i])), name = null;
                for (var j = 0; j < toks.length; j++) {
                    var t = toks[j].toLowerCase();
                    if (!/^-{0,2}[a-z][\w-]*$/.test(t)) continue;
                    if (!m[1] && TRANSITION_WORDS[t]) continue;
                    name = t;
                    break;
                }
                if (!name || name === 'all' || name === 'none' || TRANSITION_WORDS[name]) continue;
                set[name] = 1;
                var parts = TRANSITION_PARTS[name];
                if (parts) for (var p = 0; p < parts.length; p++) set[parts[p]] = 1;
            }
        }
    }
    function guardTransitionText(text, calc) {
        if (!/-webkit-transition/i.test(text)) return text;
        var allList = null;
        return text.replace(/(-webkit-transition(-property)?\s*:\s*)([^;{}"']*)/gi, function (whole, head, longhand, value) {
            var imp = /\s*!important\s*$/i.exec(value), v = imp ? value.slice(0, imp.index) : value, items = splitTop(v, ','), kept = [], changed = false;
            if (/^\s*(inherit|initial|unset|revert|none)\s*$/i.test(v) || v.indexOf(TAKEOVER_MARK) >= 0) return whole;
            if (!allList) allList = transitionAllList(calc);
            // a lone "all" in the shorthand: its timing stays, the property list follows as the longhand
            if (!longhand && items.length === 1) {
                var lone = splitWS(trim(items[0])), named = null;
                for (var q = 0; q < lone.length && named === null; q++) if (/^-{0,2}[a-z][\w-]*$/.test(lone[q]) && !TRANSITION_WORDS[lone[q].toLowerCase()]) named = lone[q].toLowerCase();
                if (named === null || named === 'all') return whole + ';-webkit-transition-property:' + allList.join(',') + (imp ? ' !important' : '');
            }
            for (var i = 0; i < items.length; i++) {
                var item = trim(items[i]), parts, a;
                if (longhand) {
                    var lp = item.toLowerCase();
                    if (lp === 'all') { kept = kept.concat(allList); changed = true; }
                    else if (calc[lp]) changed = true;
                    else if (transitionHitsCalc(lp, calc)) { kept = kept.concat(transitionSafeParts(lp, calc)); changed = true; }   // (a shorthand)
                    else kept.push(item);
                    continue;
                }
                // the shorthand: one property per item (none named: all)
                var toks = splitWS(item), at = -1;
                for (var j = 0; j < toks.length; j++) if (/^-{0,2}[a-z][\w-]*$/.test(toks[j]) && !TRANSITION_WORDS[toks[j].toLowerCase()]) { at = j; break; }
                var prop = at >= 0 ? toks[at].toLowerCase() : 'all';
                if (prop === 'none') { kept.push(item); continue; }
                if (calc[prop]) { changed = true; continue; }
                if (prop !== 'all' && !transitionHitsCalc(prop, calc)) { kept.push(item); continue; }
                changed = true;
                parts = prop === 'all' ? allList : transitionSafeParts(prop, calc);
                for (a = 0; a < parts.length; a++) {
                    var t2 = toks.slice(0);
                    if (at >= 0) t2[at] = parts[a]; else t2.unshift(parts[a]);
                    kept.push(t2.join(' '));
                }
            }
            if (!changed) return whole;
            return head + (kept.length ? kept.join(', ') : 'none') + (imp ? imp[0] : '');
        });
    }

    // animation-range "entry 0% cover 100%" -> [startCode, endCode, startPx, endPx]; a code is <range index> * 1000 +
    // <percent>, a length is a px offset along the range (then the percent part is 0); normal is cover 0% / cover 100%
    var RANGE_NAMES = ['cover', 'contain', 'entry', 'exit', 'entry-crossing', 'exit-crossing'];
    var rangeLength = function (t) {
        var m = /^(-?[\d.]+)(px|rem|em)$/.exec(t);
        return m ? Math.round(parseFloat(m[1]) * (m[2] === 'px' ? 1 : 16)) : null;
    };
    function animationRangeCodes(p, lv) {
        var toks = splitWS(lv), points = [], i;
        for (i = 0; i < toks.length; i++) {
            var t = toks[i], ni = RANGE_NAMES.indexOf(t), next = toks[i + 1] || '';
            if (ni >= 0) {
                var pt = { n: ni, pct: null, px: null };
                if (/^-?[\d.]+%$/.test(next)) { pt.pct = parseFloat(next); i++; }
                else if (rangeLength(next) !== null) { pt.px = rangeLength(next); i++; }
                points.push(pt);
            }
            else if (/^-?[\d.]+%$/.test(t)) points.push({ n: 0, pct: parseFloat(t), px: null });
            else if (rangeLength(t) !== null) points.push({ n: 0, pct: null, px: rangeLength(t) });
            else if (t === 'normal') points.push({ n: 0, pct: null, px: null, normal: true });
            else return [null, null, null, null];
        }
        var code = function (pt, defPct) { return pt ? pt.n * 1000 + (pt.px !== null ? 0 : Math.max(0, Math.min(100, Math.round(pt.pct === null ? defPct : pt.pct)))) : null; };
        var px = function (pt) { return pt && pt.px !== null ? pt.px : null; };
        if (p === 'animation-range-start') return [code(points[0], 0), null, px(points[0]), null];
        if (p === 'animation-range-end') return [null, code(points[0], 100), null, px(points[0])];
        if (points.length === 1) {
            // one range name alone covers that whole range; a single offset only sets the start
            var only = points[0], whole = only && only.pct === null && only.px === null;
            return [code(only, 0), whole ? code(only, 100) : null, px(only), null];
        }
        return [code(points[0], 0), code(points[1], 100), px(points[0]), px(points[1])];
    }
    // view-timeline-inset "auto | <length-percentage>{1,2}" -> markers (px, or percent of the scrollport)
    function timelineInsetMarkers(v, markers) {
        var t = splitWS(v);
        if (!t.length || t.length > 2) return false;
        for (var i = 0; i < 2; i++) {
            var tok = t[i] !== undefined ? t[i] : t[0], side = i ? 'e' : 's';
            if (tok === 'auto') continue;
            if (/^-?[\d.]+%$/.test(tok)) markers.push('br-vtip-' + side + ' ' + Math.round(parseFloat(tok)));
            else if (rangeLength(tok) !== null || tok === '0') markers.push('br-vti-' + side + ' ' + (tok === '0' ? 0 : rangeLength(tok)));
            else return false;
        }
        return true;
    }

    // ---- clip-path basic shapes -> -webkit-mask-image SVG. Percentages map onto a stretched 100x100 viewBox,
    // px values onto an unscaled SVG the size of the box; a shape mixing the two cannot be expressed.
    var POS_KEYWORDS = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
    function clipPathToMask(v) {
        // a box alone clips to that box (with its rounded corners): a solid mask painted in it; SVG boxes of an
        // HTML element are its content box (fill-box) or border box (stroke-box, view-box); the margin box clips nothing
        var boxOnly = /^(border-box|padding-box|content-box|margin-box|fill-box|stroke-box|view-box)$/i.exec(trim(v));
        if (boxOnly) {
            var bx = boxOnly[1].toLowerCase();
            if (bx === 'margin-box') return [['-webkit-mask-image', 'none']];
            bx = bx === 'fill-box' ? 'content-box' : bx === 'stroke-box' || bx === 'view-box' ? 'border-box' : bx;
            return [['-webkit-mask-image', '-webkit-linear-gradient(#000, #000)'], ['-webkit-mask-clip', bx], ['-webkit-mask-origin', bx]];
        }
        var m = /^(inset|circle|ellipse|polygon|path|rect|xywh)\(/i.exec(trim(v));
        if (!m) return null;
        var open = v.indexOf('('), close = matchParen(v, open);
        var fn = m[1].toLowerCase(), inner = trim(v.slice(open + 1, close)), rest = trim(v.slice(close + 1)).toLowerCase();
        var mode = null;   // 'pct' | 'px'
        var bad = false;
        var val = function (tok, axis) {   // -> number in the current mode, or sets `bad`
            tok = String(tok).toLowerCase();
            if (POS_KEYWORDS.hasOwnProperty(tok)) { if (mode === 'px') { bad = true; return 0; } mode = 'pct'; return POS_KEYWORDS[tok]; }
            var mm = /^(-?[\d.]+)(px|%)?$/.exec(tok);
            if (!mm) { bad = true; return 0; }
            var n = parseFloat(mm[1]), u = mm[2];
            if (!u && n !== 0) { bad = true; return 0; }
            if (u) { var want = u === '%' ? 'pct' : 'px'; if (mode && mode !== want) { bad = true; return 0; } mode = want; }
            return n;
        };
        var radiusOf = function (roundPart) {
            if (!roundPart) return 0;
            var r = splitWS(trim(roundPart))[0], mm = /^(-?[\d.]+)(px|%)?$/.exec(r || '');
            if (!mm) return 0;
            var want = mm[2] === '%' ? 'pct' : 'px';
            return mode && mode !== want && parseFloat(mm[1]) !== 0 ? 0 : parseFloat(mm[1]);
        };
        var shape = '', fillRule = '';
        var atSplit = function (s) { var p = s.split(/\s+at\s+/i); return { size: trim(p[0]), pos: p[1] ? splitWS(trim(p[1])) : ['50%', '50%'] }; };
        // (a shape reaching outside the box shows what is there, which a mask, painted in the box only, would hide:
        // DuckDuckGo's toolbar has polygon(0 -200%, ...) to show its tabs above it and a shadow only upwards. And a
        // mask on an element with a filter and layers of its own outside its box made the old engine abort while
        // painting it: then no mask)
        var outside = false;
        var span = function (lo, hi) { if (lo < 0 || (mode !== 'px' && hi > 100)) outside = true; };
        switch (fn) {
            case 'circle': {
                var c = atSplit(inner), rTok = c.size || 'closest-side';
                if (/^(closest|farthest)-side$/.test(rTok)) { if (mode === 'px') return null; mode = 'pct'; rTok = '50%'; }
                var cr = val(rTok), cx = val(c.pos[0]), cy = val(c.pos.length > 1 ? c.pos[1] : '50%');
                span(cx - cr, cx + cr); span(cy - cr, cy + cr);
                shape = "<circle cx='" + cx + "' cy='" + cy + "' r='" + cr + "'/>";
                break;
            }
            case 'ellipse': {
                var e = atSplit(inner), rs = e.size ? splitWS(e.size) : [];
                var rxTok = rs[0] || 'closest-side', ryTok = rs[1] || rxTok;
                if (/^(closest|farthest)-side$/.test(rxTok)) { if (mode === 'px') return null; mode = 'pct'; rxTok = '50%'; }
                if (/^(closest|farthest)-side$/.test(ryTok)) { if (mode === 'px') return null; mode = 'pct'; ryTok = '50%'; }
                var erx = val(rxTok), ery = val(ryTok), ecx = val(e.pos[0]), ecy = val(e.pos.length > 1 ? e.pos[1] : '50%');
                span(ecx - erx, ecx + erx); span(ecy - ery, ecy + ery);
                shape = "<ellipse cx='" + ecx + "' cy='" + ecy + "' rx='" + erx + "' ry='" + ery + "'/>";
                break;
            }
            case 'inset': case 'rect': case 'xywh': {
                var roundAt = inner.search(/\s+round\s+/i), body = roundAt >= 0 ? inner.slice(0, roundAt) : inner, roundPart = roundAt >= 0 ? inner.slice(roundAt).replace(/^\s+round\s+/i, '') : '';
                var t = splitWS(trim(body)), x, y, w, h;
                if (fn === 'inset') {
                    if (mode === 'px') return null;
                    mode = 'pct';
                    var ib = expandBox(t), it = val(ib[0]), ir = val(ib[1]), ibt = val(ib[2]), il = val(ib[3]);
                    x = il; y = it; w = 100 - il - ir; h = 100 - it - ibt;
                } else if (fn === 'xywh') {
                    if (t.length < 4) return null;
                    x = val(t[0]); y = val(t[1]); w = val(t[2]); h = val(t[3]);
                } else {
                    if (t.length < 4) return null;
                    var edge = function (tok, def) { return tok.toLowerCase() === 'auto' ? def : val(tok); };
                    var rt = edge(t[0], 0), rr = edge(t[1], null), rb = edge(t[2], null), rl = edge(t[3], 0);
                    if (rr === null || rb === null) { if (mode === 'px') return null; mode = 'pct'; if (rr === null) rr = 100; if (rb === null) rb = 100; }
                    x = rl; y = rt; w = rr - rl; h = rb - rt;
                }
                var rx = radiusOf(roundPart);
                span(x, x + w); span(y, y + h);
                shape = "<rect x='" + x + "' y='" + y + "' width='" + w + "' height='" + h + "'" + (rx ? " rx='" + rx + "'" : '') + "/>";
                break;
            }
            case 'polygon': {
                var pts = splitTop(inner, ','), points = [];
                if (/^(nonzero|evenodd)$/i.test(trim(pts[0]))) { fillRule = trim(pts[0]).toLowerCase(); pts = pts.slice(1); }
                for (var pi = 0; pi < pts.length; pi++) {
                    var pt = splitWS(trim(pts[pi]));
                    if (pt.length < 2) return null;
                    var px = val(pt[0]), py = val(pt[1]);
                    span(px, px); span(py, py);
                    points.push(px + ',' + py);
                }
                if (points.length < 3) return null;
                shape = "<polygon points='" + points.join(' ') + "'" + (fillRule ? " fill-rule='" + fillRule + "'" : '') + "/>";
                break;
            }
            case 'path': {
                var pa = splitTop(inner, ','), dTok = trim(pa[pa.length - 1]);
                if (pa.length > 1 && /^(nonzero|evenodd)$/i.test(trim(pa[0]))) fillRule = trim(pa[0]).toLowerCase();
                var dm = /^(["'])([\s\S]*)\1$/.exec(dTok);
                if (!dm) return null;
                mode = 'px';
                shape = "<path d='" + dm[2].replace(/'/g, '') + "'" + (fillRule ? " fill-rule='" + fillRule + "'" : '') + "/>";
                break;
            }
        }
        if (bad || !shape) return null;
        if (outside) return [];
        if (!mode) mode = 'pct';
        var svg = "<svg xmlns='http://www.w3.org/2000/svg'" + (mode === 'pct' ? " viewBox='0 0 100 100' preserveAspectRatio='none'" : '') + '>' + shape + '</svg>';
        var url = 'url("data:image/svg+xml;charset=utf8,' + svg.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/ /g, '%20') + '")';
        var decls = [['-webkit-mask-image', url], ['-webkit-mask-repeat', 'no-repeat'], ['-webkit-mask-position', '0 0'], ['-webkit-mask-size', mode === 'pct' ? '100% 100%' : 'auto']];
        var boxKw = /\b(border-box|padding-box|content-box|margin-box|fill-box|stroke-box|view-box)\b/.exec(rest);
        if (boxKw) { var mb = boxKw[1] === 'padding-box' || boxKw[1] === 'content-box' ? boxKw[1] : 'border-box'; decls.push(['-webkit-mask-clip', mb], ['-webkit-mask-origin', mb]); }
        return decls;
    }

    // the two corners of each css-borders-4 side shorthand, clockwise
    var RADIUS_SIDES = { top: ['border-top-left-radius', 'border-top-right-radius'], right: ['border-top-right-radius', 'border-bottom-right-radius'],
        bottom: ['border-bottom-right-radius', 'border-bottom-left-radius'], left: ['border-bottom-left-radius', 'border-top-left-radius'] };
    RADIUS_SIDES['block-start'] = RADIUS_SIDES.top; RADIUS_SIDES['block-end'] = RADIUS_SIDES.bottom;
    RADIUS_SIDES['inline-start'] = RADIUS_SIDES.left; RADIUS_SIDES['inline-end'] = RADIUS_SIDES.right;

    // css-text-4: white-space is "<white-space-collapse> || <text-wrap-mode>"; the old engine knows the five classic values
    function whiteSpaceValue(p, lv) {
        if (isGlobalKeyword(lv)) return p === 'white-space' ? lv : null;
        var collapse = null, wrap = null, toks = lv.split(/\s+/);
        if (toks.length === 1 && /^(normal|pre|nowrap|pre-wrap|pre-line)$/.test(lv)) return lv;
        for (var i = 0; i < toks.length; i++) {
            var t = toks[i];
            if (t === 'normal' || t === 'pre' || t === 'pre-wrap' || t === 'pre-line') return t;
            if (t === 'collapse' || t === 'preserve' || t === 'preserve-breaks' || t === 'preserve-spaces' || t === 'break-spaces' || t === 'discard') collapse = t;
            else if (t === 'wrap' || t === 'nowrap') wrap = t;
            else if (p === 'text-wrap' || p === 'text-wrap-mode') { /* balance, pretty, stable, auto: no equivalent */ }
            else return null;
        }
        if (p === 'text-wrap' || p === 'text-wrap-mode') return wrap === 'nowrap' ? 'nowrap' : wrap === 'wrap' ? 'normal' : null;
        if (collapse === null && wrap === null) return null;
        var nowrap = wrap === 'nowrap';
        switch (collapse) {
            case 'preserve': return nowrap ? 'pre' : 'pre-wrap';
            case 'preserve-breaks': return 'pre-line';
            case 'preserve-spaces': case 'break-spaces': return 'pre-wrap';
            default: return nowrap ? 'nowrap' : 'normal';   // collapse, discard, none
        }
    }
    // "safe center", "first baseline", "legacy left": the qualifiers mean nothing to the 2009 box model
    function alignKeywords(lv) {
        var toks = lv.split(/\s+/), out = [];
        for (var i = 0; i < toks.length; i++) if (!/^(safe|unsafe|first|last|legacy)$/.test(toks[i])) out.push(toks[i]);
        return out.length ? out : ['baseline'];
    }
    function alignKeyword(lv) { return alignKeywords(lv)[0]; }

    function push(out, p, v, imp) { out.push({ p: p, v: v, imp: imp }); }

    // font-variant-* keywords as OpenType feature settings (small caps and sub/superscripts are synthesised instead)
    var FONT_VARIANT_FEATURES = {
        'common-ligatures': '"liga" 1, "clig" 1', 'no-common-ligatures': '"liga" 0, "clig" 0', 'discretionary-ligatures': '"dlig" 1',
        'no-discretionary-ligatures': '"dlig" 0', 'historical-ligatures': '"hlig" 1', 'no-historical-ligatures': '"hlig" 0',
        contextual: '"calt" 1', 'no-contextual': '"calt" 0', 'lining-nums': '"lnum" 1', 'oldstyle-nums': '"onum" 1',
        'proportional-nums': '"pnum" 1', 'tabular-nums': '"tnum" 1', 'diagonal-fractions': '"frac" 1', 'stacked-fractions': '"afrc" 1',
        ordinal: '"ordn" 1', 'slashed-zero': '"zero" 1', jis78: '"jp78" 1', jis83: '"jp83" 1', jis90: '"jp90" 1', jis04: '"jp04" 1',
        simplified: '"smpl" 1', traditional: '"trad" 1', 'full-width': '"fwid" 1', 'proportional-width': '"pwid" 1', ruby: '"ruby" 1',
        unicase: '"unic" 1', 'titling-caps': '"titl" 1', 'historical-forms': '"hist" 1'
    };
    // ---- positions: the engine takes two plain values; an offset from the right or bottom edge ("right 20px bottom
    // 10px", background-position-x: right 20px) becomes calc(100% - offset)
    var POS_KEYWORDS = { left: 'x', right: 'x', top: 'y', bottom: 'y', center: 'c' };
    function edgeValue(kw, off) {
        if (kw === 'center') return '50%';
        var far = kw === 'right' || kw === 'bottom';
        if (!off) return far ? '100%' : '0%';
        if (!far) return off;
        return off.charAt(0) === '-' ? '-webkit-calc(100% + ' + off.slice(1) + ')' : '-webkit-calc(100% - ' + off.replace(/^\+/, '') + ')';
    }
    function isPosLength(t) { return /^[-+]?(\d*\.)?\d+([a-z%]+)?$/i.test(t) || /^(-webkit-)?calc\(/i.test(t); }
    // one layer of a 3/4-value position as [x, y]; null when it is a plain 1/2-value one (or not a position)
    function positionPair(layer) {
        var toks = splitWS(trim(layer)), groups = [], i;
        if (toks.length < 3) return null;
        for (i = 0; i < toks.length; i++) {
            var t = toks[i].toLowerCase();
            if (!POS_KEYWORDS[t]) return null;
            var g = { kw: t, off: null };
            if (i + 1 < toks.length && isPosLength(toks[i + 1])) { g.off = toks[i + 1]; i++; }
            groups.push(g);
        }
        if (groups.length !== 2) return null;
        var a = groups[0], b = groups[1], swap = POS_KEYWORDS[a.kw] === 'y' || POS_KEYWORDS[b.kw] === 'x';
        var h = swap ? b : a, vv = swap ? a : b;
        return [edgeValue(h.kw, h.off), edgeValue(vv.kw, vv.off)];
    }
    function convertPositions(v) {
        var layers = splitTop(v, ','), out = [], changed = false;
        for (var i = 0; i < layers.length; i++) {
            var pp = positionPair(layers[i]);
            if (pp) { out.push(pp.join(' ')); changed = true; } else out.push(trim(layers[i]));
        }
        return changed ? out.join(', ') : null;
    }
    // background-position-x / -y (and the logical ones): "right 20px" per layer
    function convertAxisPositions(v, horizontal) {
        var layers = splitTop(v, ','), out = [], changed = false;
        for (var i = 0; i < layers.length; i++) {
            var toks = splitWS(trim(layers[i])), kw = toks[0] ? toks[0].toLowerCase() : '';
            kw = { 'x-start': 'left', 'x-end': 'right', 'y-start': 'top', 'y-end': 'bottom' }[kw] || kw;
            if (toks.length === 2 && isPosLength(toks[1]) && (horizontal ? /^(left|right)$/.test(kw) : /^(top|bottom)$/.test(kw))) { out.push(edgeValue(kw, toks[1])); changed = true; }
            else out.push(trim(layers[i]));
        }
        return changed ? out.join(', ') : null;
    }
    // perspective-origin / a 1-2 value origin as [x, y]
    function originPair(lv) {
        var toks = splitWS(lv), kwv = function (t) { return t === 'center' ? '50%' : (t === 'left' || t === 'top') ? '0%' : (t === 'right' || t === 'bottom') ? '100%' : t; };
        if (toks.length === 1) {
            var t = toks[0];
            if (t === 'top' || t === 'bottom') return ['50%', kwv(t)];
            return [kwv(t), '50%'];
        }
        if (toks.length !== 2) return null;
        var a = toks[0], b = toks[1];
        if (a === 'top' || a === 'bottom' || b === 'left' || b === 'right') { var tmp = a; a = b; b = tmp; }
        return [kwv(a), kwv(b)];
    }

    // selectors that reach the whole page (features there would slow down all text)
    // the first family of a font-family value (or of the font shorthand), without quotes; null when there is none
    var GENERIC_FAMILIES = { serif: 1, 'sans-serif': 1, monospace: 1, cursive: 1, fantasy: 1, 'system-ui': 1, math: 1, emoji: 1, fangsong: 1,
        'ui-serif': 1, 'ui-sans-serif': 1, 'ui-monospace': 1, 'ui-rounded': 1, '-apple-system': 1, blinkmacsystemfont: 1,
        inherit: 1, initial: 1, unset: 1, revert: 1, 'revert-layer': 1 };
    function firstFontFamily(v, shorthand) {
        var list = v;
        if (shorthand) {
            var m = /(?:^|\s)(?:[\d.]+(?:px|pt|pc|em|rem|ex|ch|%|vw|vh|cm|mm|in|q)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:\s*\/\s*\S+)?\s+(.+)$/.exec(v);
            if (!m) return null;
            list = m[1];
        }
        var f = trim(splitTop(list, ',')[0] || '').replace(/^["']|["']$/g, '');
        return f ? f.toLowerCase() : null;
    }

    function broadSelectors(sels) {
        if (!sels) return false;
        for (var i = 0; i < sels.length; i++) {
            var s = trim(sels[i]).toLowerCase().replace(/^:(where|is)\((.*)\)$/, '$2');
            if (/^(html|body|:root|\*|html\s+body|html\s*>\s*body|:host|html\s+\*|body\s+\*)$/.test(s)) return true;
        }
        return false;
    }

    // text-decoration-color: the old engine paints decorations in the text stroke colour when the stroke is wider than
    // 0 (a fully transparent stroke colour is skipped), otherwise in the fill colour. A 0.001px stroke draws nothing
    // visible on the glyphs and carries the decoration colour; a transparent colour keeps a trace of alpha.
    function pushDecorationColor(out, v, imp) {
        var lv = trim(v).toLowerCase();
        if (isGlobalKeyword(lv) || lv === 'unset') {
            var kw = lv === 'unset' ? 'initial' : lv;
            push(out, '-webkit-text-stroke-color', kw, imp);
            push(out, '-webkit-text-stroke-width', kw, imp);
            return;
        }
        if (lv === 'currentcolor') { push(out, '-webkit-text-stroke-color', 'currentColor', imp); return; }
        var c = parseColor(v);
        if (!c) return;
        var a = c.length > 3 ? c[3] : 1;
        push(out, '-webkit-text-stroke-color', 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' + (a < 0.004 ? 0.004 : Math.round(a * 1000) / 1000) + ')', imp);
        push(out, '-webkit-text-stroke-width', '0.001px', imp);
    }

    // two-value display syntax (css-display-3): "block flex" -> flex, "inline flow-root" -> inline-block, ...
    var DISPLAY_INSIDE = { flow: 1, 'flow-root': 1, table: 1, flex: 1, grid: 1, ruby: 1, math: 1 };
    function normalizeDisplay(lv) {
        var toks = lv.split(/\s+/), outside = null, inside = null, listItem = false;
        for (var i = 0; i < toks.length; i++) {
            var t = toks[i];
            if (t === 'block' || t === 'inline' || t === 'run-in') outside = t;
            else if (DISPLAY_INSIDE[t]) inside = t;
            else if (t === 'list-item') listItem = true;
            else return lv;
        }
        if (listItem) return outside === 'inline' ? 'inline-block' : 'list-item';
        var inl = outside === 'inline';
        switch (inside || 'flow') {
            case 'flow': return outside || 'block';
            case 'flow-root': return inl ? 'inline-block' : 'flow-root';
            case 'table': return inl ? 'inline-table' : 'table';
            case 'flex': return inl ? 'inline-flex' : 'flex';
            case 'grid': return inl ? 'inline-grid' : 'grid';
            case 'ruby': return inl ? 'ruby' : 'block';
            case 'math': return inl ? 'inline' : 'block';
        }
        return lv;
    }

    function expandBox(vals) {   // 1-4 values -> [top, right, bottom, left]
        var t = vals[0], r = vals.length > 1 ? vals[1] : t, b = vals.length > 2 ? vals[2] : t, l = vals.length > 3 ? vals[3] : r;
        return [t, r, b, l];
    }

    var LOGICAL_SINGLE = { 'margin-inline-start': 'margin-left', 'margin-inline-end': 'margin-right', 'margin-block-start': 'margin-top', 'margin-block-end': 'margin-bottom',
        'padding-inline-start': 'padding-left', 'padding-inline-end': 'padding-right', 'padding-block-start': 'padding-top', 'padding-block-end': 'padding-bottom',
        'border-inline-start': 'border-left', 'border-inline-end': 'border-right', 'border-block-start': 'border-top', 'border-block-end': 'border-bottom',
        'border-inline-start-width': 'border-left-width', 'border-inline-end-width': 'border-right-width', 'border-inline-start-color': 'border-left-color',
        'border-inline-end-color': 'border-right-color', 'border-inline-start-style': 'border-left-style', 'border-inline-end-style': 'border-right-style',
        'border-block-start-width': 'border-top-width', 'border-block-end-width': 'border-bottom-width',
        'border-block-start-color': 'border-top-color', 'border-block-end-color': 'border-bottom-color',
        'border-block-start-style': 'border-top-style', 'border-block-end-style': 'border-bottom-style',
        'inset-inline-start': 'left', 'inset-inline-end': 'right', 'inset-block-start': 'top', 'inset-block-end': 'bottom',
        'inline-size': 'width', 'block-size': 'height', 'min-inline-size': 'min-width', 'max-inline-size': 'max-width', 'min-block-size': 'min-height', 'max-block-size': 'max-height',
        'border-start-start-radius': 'border-top-left-radius', 'border-start-end-radius': 'border-top-right-radius',
        'border-end-start-radius': 'border-bottom-left-radius', 'border-end-end-radius': 'border-bottom-right-radius',
        'overflow-inline': 'overflow-x', 'overflow-block': 'overflow-y' };
    var LOGICAL_PAIR = { 'margin-inline': ['margin-left', 'margin-right'], 'margin-block': ['margin-top', 'margin-bottom'],
        'padding-inline': ['padding-left', 'padding-right'], 'padding-block': ['padding-top', 'padding-bottom'],
        'border-inline': ['border-left', 'border-right'], 'border-block': ['border-top', 'border-bottom'],
        'border-inline-width': ['border-left-width', 'border-right-width'], 'border-block-width': ['border-top-width', 'border-bottom-width'],
        'border-inline-color': ['border-left-color', 'border-right-color'], 'border-inline-style': ['border-left-style', 'border-right-style'],
        'border-block-color': ['border-top-color', 'border-bottom-color'], 'border-block-style': ['border-top-style', 'border-bottom-style'],
        'inset-inline': ['left', 'right'], 'inset-block': ['top', 'bottom'], 'scroll-margin-inline': ['scroll-margin-left', 'scroll-margin-right'] };

    // the flex-shrink factor a flex / flex-shrink declaration sets ("flex: none" and "0 0 auto" are 0, the default is 1)
    function flexShrinkOf(p, lv) {
        if (p === 'flex-shrink') { var n = parseFloat(lv); return isNaN(n) ? null : n; }
        if (lv === 'none') return 0;
        if (lv === 'auto' || lv === 'initial') return 1;
        var toks = splitWS(lv), nums = [];
        for (var i = 0; i < toks.length; i++) if (/^-?[\d.]+$/.test(toks[i])) nums.push(parseFloat(toks[i]));
        return nums.length > 1 ? nums[1] : 1;
    }

    function parseFlexShorthand(v) {   // returns {grow, basis}
        var lv = v.toLowerCase();
        if (lv === 'none') return { grow: '0', basis: null };
        if (lv === 'auto') return { grow: '1', basis: null };
        if (lv === 'initial') return { grow: '0', basis: null };
        var toks = splitWS(v), grow = null, basis = null;
        for (var i = 0; i < toks.length; i++) {
            var t = toks[i];
            if (/^-?[\d.]+$/.test(t)) { if (grow === null) grow = t; }
            else if (t !== 'auto' && t !== 'content') basis = t;
        }
        return { grow: grow === null ? '1' : grow, basis: basis };
    }

    // [leftIsAuto, rightIsAuto] for a margin / margin-inline shorthand value
    function autoMarginSides(prop, value) {
        var mv = splitWS(value);
        if (!mv.length) return [false, false];
        if (prop === 'margin-inline') return [mv[0] === 'auto', (mv.length > 1 ? mv[1] : mv[0]) === 'auto'];
        if (mv.length === 1) return [mv[0] === 'auto', mv[0] === 'auto'];
        if (mv.length < 4) return [mv[1] === 'auto', mv[1] === 'auto'];
        return [mv[3] === 'auto', mv[1] === 'auto'];
    }

    // the margin shorthand with the lone auto side replaced by 0
    function replaceAutoMargin(value, leftIsTheAutoSide) {
        var mv = splitWS(value);
        if (mv.length === 1) return value;                       // "margin: auto" centres, left alone
        if (mv.length < 4) { if (mv[1] !== 'auto') return value; mv = [mv[0], mv[1], mv.length > 2 ? mv[2] : mv[0], mv[1]]; }
        if (leftIsTheAutoSide && mv[3] === 'auto') mv[3] = '0';
        if (!leftIsTheAutoSide && mv[1] === 'auto') mv[1] = '0';
        return mv.join(' ');
    }

    function fixDeclarations(decls, ctx, keyframe) {
        var local = null, i, d;
        decls = expandFirstValid(decls);
        var wrap = false, hasTransform = false, translate = null, rotate = null, scale = null, lastImp = false;
        var objectFit = null, objectPosition = null, ofiDone = false, columnFlex = false;
        var autoLeft = false, autoRight = false, hasDisplay = false, dispVal = '', gapRow = null, gapCol = null, shrink = null, multicol = false;
        // markers the page shim reads back from the computed counter-reset: aspect ratios, containers, scroll snap,
        // smooth scrolling, balanced text (one counter-reset per rule, emitted after the declarations)
        var markers = [], markerKeyword = null;   // "inherit"/"initial" on a marker property becomes counter-reset: inherit/initial
        var pctHeightMarked = false;
        var features = [];   // OpenType features the rule's font-variant-* / font-feature-settings ask for
        var ligaAsked = false, iconLike = false, ownFamily = null, zIndexed = false, positioned = false;
        var ovSetX = false, ovSetY = false;   // (the overflow axes the rule sets, see the overflow case)
        for (i = 0; i < decls.length; i++) {
            d = decls[i];
            if (d.p === 'display') { hasDisplay = true; dispVal = String(d.v).toLowerCase(); }
            if (d.p === 'overflow') ovSetX = ovSetY = true;
            else if (d.p === 'overflow-x' || d.p === 'overflow-inline') ovSetX = true;
            else if (d.p === 'overflow-y' || d.p === 'overflow-block') ovSetY = true;
            if (d.p.charAt(0) === '-' && d.p.charAt(1) === '-') { if (!local) local = {}; local[d.p] = d.v; }
            else if ((d.p === 'flex-wrap' || d.p === 'flex-flow') && /wrap/i.test(d.v) && !/nowrap/i.test(d.v)) wrap = true;
            else if (d.p === 'object-fit') objectFit = d.v.toLowerCase();
            else if (d.p === 'object-position') objectPosition = d.v.toLowerCase();
            // a column flex container is plain block stacking; the 2009 box model lays nested boxes out
            // repeatedly and deeply nested flex pages (seznam.cz) never finished, so columns stay blocks
            if ((d.p === 'flex-direction' || d.p === 'flex-flow') && /column/i.test(d.v)) columnFlex = true;
            // horizontal auto margins: which sides does the rule set to auto?
            var mvl = trim(d.v).toLowerCase();
            if (d.p === 'margin-left' || d.p === 'margin-inline-start') { if (mvl === 'auto') autoLeft = true; }
            else if (d.p === 'margin-right' || d.p === 'margin-inline-end') { if (mvl === 'auto') autoRight = true; }
            else if (d.p === 'margin' || d.p === 'margin-inline') {
                var ms = autoMarginSides(d.p, mvl);
                if (ms[0]) autoLeft = true;
                if (ms[1]) autoRight = true;
            }
            // (icon fonts, see below)
            if (d.p === 'text-rendering') { if (/legibility|precision/.test(mvl)) ligaAsked = true; }
            else if (d.p === 'font-feature-settings' || d.p === '-webkit-font-feature-settings') { if (/["'](liga|clig|dlig)["'](?!\s*(0|off)\b)/.test(mvl)) ligaAsked = true; }
            else if (d.p === 'font-variant-ligatures' || d.p === '-webkit-font-variant-ligatures') { if (/(^|\s)(common|discretionary)-ligatures\b/.test(mvl)) ligaAsked = true; }
            else if (d.p === 'font-family' || d.p === 'font') {
                ownFamily = firstFontFamily(mvl, d.p === 'font');
                if (d.p === 'font' && /\/\s*1(\s|$)/.test(mvl)) iconLike = true;   // (a line height of 1 in the shorthand)
            }
            else if ((d.p === 'font-style' && mvl === 'normal') || (d.p === 'line-height' && mvl === '1') || (d.p === 'white-space' && mvl === 'nowrap')) iconLike = true;
            if (d.p === 'z-index') { if (/^-?\d+$/.test(mvl)) zIndexed = true; }
            else if (d.p === 'position') { if (mvl !== 'static') positioned = true; }
        }
        // A flex item stacks by its z-index without being positioned; the old engine's boxes (the 2009 model) ignore it
        // there (a hero's backdrop covered its heading): marked "br-zi 1", the shim positions such items (see fixFlexZ)
        if (zIndexed && !positioned && !keyframe) markers.push('br-zi 1');
        // "margin-left: auto" on one side only is how flex items are pushed to the far end. The 2009 box model
        // resolves that auto margin to all the free space before the flexible siblings get theirs (Google's
        // result text ended up 0 px wide next to its thumbnail), so the lone auto margin becomes 0.
        var flexPush = autoLeft !== autoRight;
        // (marked "br-mauto 1|2", the auto side: the shim gives the margin back where the old model does not misuse it)
        if (flexPush && !keyframe) markers.push('br-mauto ' + (autoLeft ? 1 : 2));
        var out = [];
        var rt = !keyframe && g_manifest !== false ? ctx.rt : null;
        // declarations with viewport units go to the orientation rules (see VP_UNIT_RE and transformRules)
        var vpList = !keyframe && !ctx.vpPass && ctx.vpDecls ? ctx.vpDecls : null, vpProps = null;
        for (i = 0; i < decls.length; i++) {
            d = decls[i];
            var p = d.p, imp = d.imp;
            if (p.charAt(0) === '-' && p.charAt(1) === '-') {
                // a scoped definition goes to the manifest; in a style attribute it stays (the engine ignores it and
                // the shim reads it back from the attribute)
                if (rt && rt[p] && ctx.cvDefs && ctx.curSels) ctx.cvDefs.push([p, staticizeVars(d.v, local, ctx, rt), imp ? 1 : 0]);
                if (ctx.inlineStyle) push(out, p, d.v, imp);
                continue;
            }
            // inherit(--x, fallback): the static value is var()'s without the rule's own definitions (they are the
            // element's, not the parent's); the shim takes the parent's value
            var hasInherit = /(^|[^\w-])inherit\(/i.test(d.v);
            var v = hasInherit ? resolveVars(d.v.replace(/(^|[^\w-])inherit\(/gi, '$1var('), null, ctx) : resolveVars(d.v, local, ctx);
            var cvUse = rt && (hasInherit || varRefs(d.v, rt)) ? [p, staticizeVars(d.v, local, ctx, rt), imp ? 1 : 0] : null;
            if (cvUse) {
                // the static value the rule gets below, which the shim compares with the per-element one
                var cvStatic = v;
                if (cvStatic !== null && /(^|[^\w-])if\(/i.test(cvStatic)) cvStatic = resolveIf(p, cvStatic, imp, local, { page: ctx.page, root: ctx.root, other: ctx.other, initial: ctx.initial });
                cvUse.push(cvStatic);
                if (ctx.cvUses && ctx.curSels) ctx.cvUses.push(cvUse);
                else if (ctx.inlineStyle) ctx.inlineUses.push(cvUse);
            }
            if (v === null) continue;
            if (/(^|[^\w-])if\(/i.test(v)) { v = resolveIf(p, v, imp, local, ctx); if (v === null) continue; }
            // a width with a content keyword in a rule that sets its own display cannot take the table form: measured
            var sizedByShim = hasDisplay && (p === 'width' || p === 'inline-size') && INTRINSIC_CONTENT.test(trim(v));
            if (!keyframe && g_manifest !== false && (isDeferred(p, v) || sizedByShim)) {
                registerDeferred(ctx, p, v, imp, markers);
                // "rule" with one value also sets the column rule, which multi-column layout draws by itself
                if (/^rule(-(color|style|width))?$/.test(p) && !/repeat\(/i.test(v) && (p === 'rule' || splitTop(trim(v), ' ').length === 1)) push(out, '-webkit-column-' + p, v, imp);
                var dvFallback = deferredFallback(v, p);
                if (dvFallback !== null && !DV_PROPS[p]) push(out, p, fixValue(p, dvFallback), imp);
                push(out, p, v, imp);   // the engine drops it; kept for reference
                continue;
            }
            if (vpList) {
                if (hasViewportUnits(v)) {
                    vpList.push({ p: p, v: v, imp: imp });
                    (vpProps || (vpProps = [])).push(p);
                    continue;
                }
                // a later declaration of the same property (or of a longhand / shorthand of it) follows it into the
                // orientation rules, so that it still wins there as it did in the rule
                if (vpProps && overlapsAny(p, vpProps)) vpList.push({ p: p, v: v, imp: imp });
            }
            v = fixValue(p, v);
            // keyframes blend their values, and a calc length there crashes the old engine (see approximateCalc)
            if (keyframe && v.indexOf('-webkit-calc(') >= 0 && calcCrashProps(p).length) {
                v = approximateCalc(v);
                if (v === null) continue;
            }
            var lv = v.toLowerCase();
            if (!keyframe && (p === 'flex' || p === 'flex-shrink') && !isGlobalKeyword(trim(lv))) shrink = flexShrinkOf(p, trim(lv));
            // (column-gap of a multi-column box is its column spacing, which the engine has)
            if ((p === 'columns' || p === 'column-count' || p === 'column-width') && !/^(auto|auto auto|initial|unset|inherit)$/.test(trim(lv))) multicol = true;
            if (!keyframe && GAP_NAMES[p]) {
                var gparts = splitWS(trim(lv));
                if (p === 'gap' || p === 'grid-gap') { gapRow = gparts[0]; gapCol = gparts.length > 1 ? gparts[1] : gparts[0]; }
                else if (p === 'row-gap' || p === 'grid-row-gap') gapRow = gparts[0];
                else gapCol = gparts[0];
            }
            // A percentage height is marked with its percentage for the shim: on this engine a child with a percentage
            // height of a stretched item of a flex row (a 2009 box here) grows with every layout, three times each
            // time (The Guardian's page reached 86 million px); the shim gives it the item's height in pixels.
            if ((p === 'height' || p === 'block-size') && !keyframe && !pctHeightMarked && /^\d*\.?\d+%$/.test(trim(lv)) && parseFloat(lv) > 0) {
                markers.push('br-pcth ' + Math.round(parseFloat(lv) * 100));
                pctHeightMarked = true;
            }
            // a math function whose result is negative is clamped to the property's range (a literal stays invalid)
            if (NON_NEGATIVE[p] && d.v.indexOf('(') >= 0 && /^-\d*\.?\d+[a-z%]*$/.test(lv)) { v = '0' + lv.replace(/^-\d*\.?\d+/, ''); lv = v; }
            // "logical" order in the box shorthands: block-start inline-start block-end inline-end
            if (/^logical\s/.test(lv) && /^(margin|padding|border-color|border-style|border-width|inset)$/.test(p)) {
                var lg = splitWS(v).slice(1);
                if (lg.length) { var bs = lg[0], is0 = lg.length > 1 ? lg[1] : bs, be = lg.length > 2 ? lg[2] : bs, ie = lg.length > 3 ? lg[3] : is0; v = bs + ' ' + ie + ' ' + be + ' ' + is0; lv = v.toLowerCase(); }
            }
            switch (p) {
                case 'float': case 'clear':
                    push(out, p, lv === 'inline-start' ? 'left' : lv === 'inline-end' ? 'right' : v, imp);
                    continue;
                case 'caption-side':
                    push(out, p, lv === 'inline-start' ? 'left' : lv === 'inline-end' ? 'right' : lv === 'block-start' ? 'top' : lv === 'block-end' ? 'bottom' : v, imp);
                    continue;
                case 'mask-composite': case '-webkit-mask-composite': {
                    var comp = { add: 'source-over', subtract: 'source-out', intersect: 'source-in', exclude: 'xor' }, cparts = splitTop(lv, ','), cout = [];
                    for (var cpi = 0; cpi < cparts.length; cpi++) cout.push(comp[trim(cparts[cpi])] || trim(cparts[cpi]));
                    push(out, '-webkit-mask-composite', cout.join(', '), imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'mask-clip': case 'mask-origin': {
                    // SVG boxes of an HTML element: fill-box is its content box, stroke-box and view-box its border box
                    var boxes = { 'fill-box': 'content-box', 'stroke-box': 'border-box', 'view-box': 'border-box', 'no-clip': 'border-box' }, bparts = splitTop(lv, ','), bout = [];
                    for (var bpi = 0; bpi < bparts.length; bpi++) bout.push(boxes[trim(bparts[bpi])] || trim(bparts[bpi]));
                    push(out, '-webkit-' + p, bout.join(', '), imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'mask-border': case 'mask-border-source': case 'mask-border-slice': case 'mask-border-width': case 'mask-border-outset': case 'mask-border-repeat':
                    push(out, '-webkit-mask-box-image' + p.slice(11), v, imp);
                    push(out, p, v, imp);
                    continue;
                case 'background-position-inline': case 'background-position-block': {
                    var bpx = p === 'background-position-inline', bpl = splitTop(v, ','), bpo = [];
                    for (var bpk = 0; bpk < bpl.length; bpk++) bpo.push(trim(bpl[bpk]).replace(/\bstart\b/g, bpx ? 'left' : 'top').replace(/\bend\b/g, bpx ? 'right' : 'bottom'));
                    var bpv = bpo.join(', ');
                    push(out, bpx ? 'background-position-x' : 'background-position-y', convertAxisPositions(bpv, bpx) || bpv, imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'background-position-x': case 'background-position-y':
                    push(out, p, convertAxisPositions(v, p === 'background-position-x') || v, imp);
                    continue;
                case 'background-position':
                    push(out, p, convertPositions(v) || v, imp);
                    continue;
                case 'mask-position': case '-webkit-mask-position':
                    push(out, '-webkit-mask-position', convertPositions(v) || v, imp);
                    if (p === 'mask-position') push(out, p, v, imp);
                    continue;
                case 'perspective-origin': case '-webkit-perspective-origin': {
                    // the engine exposes the two longhands only
                    var po = isGlobalKeyword(lv) ? [lv, lv] : originPair(lv);
                    if (po) { push(out, '-webkit-perspective-origin-x', po[0], imp); push(out, '-webkit-perspective-origin-y', po[1], imp); }
                    push(out, p, v, imp);
                    continue;
                }
                case 'max-lines':
                    if (/^\d+$/.test(lv)) { push(out, '-webkit-line-clamp', v, imp); if (!hasDisplay) push(out, 'display', '-webkit-box', imp); push(out, '-webkit-box-orient', 'vertical', imp); }
                    else if (lv === 'none') push(out, '-webkit-line-clamp', 'none', imp);
                    push(out, p, v, imp);
                    continue;
                case 'initial-letter': {
                    // a drop cap: the first letter floats and grows to span about that many lines
                    var il = /^(-?[\d.]+)(?:\s+(\d+|drop|raise))?$/.exec(lv);
                    if (il && parseFloat(il[1]) > 0) {
                        push(out, 'float', 'left', imp);
                        push(out, 'font-size', (Math.round(parseFloat(il[1]) * 1.15 * 100) / 100) + 'em', imp);
                        push(out, 'line-height', '1', imp);
                        push(out, 'margin-right', '0.08em', imp);
                    }
                    push(out, p, v, imp);
                    continue;
                }
                case 'display':
                    if (lv.indexOf(' ') > 0 || lv === 'flow') { lv = normalizeDisplay(lv); v = lv; }
                    // a column flex container stays a block (see columnFlex); its classes are remembered so that a later
                    // rule turning the same class into a row ("navbar-expand-lg .navbar-nav") makes it a box again
                    // (also a column that centres, ends or spreads its items: as boxes, seznam.cz's nested columns made its
                    // start take 41 s)
                    var colBlock = columnFlex && !columnHasOwnHeight(decls);
                    if ((lv === 'flex' || lv === 'inline-flex') && colBlock && !wrap) rememberColumnFlex(ctx, lv === 'inline-flex');
                    if (lv === 'flex') push(out, 'display', (wrap || colBlock) ? 'block' : '-webkit-box', imp);
                    else if (lv === 'inline-flex') push(out, 'display', (wrap || colBlock) ? 'inline-block' : '-webkit-inline-box', imp);
                    else if (lv === 'contents') {
                        // an element without a box of its own, whose children take part in the parent's layout: here it
                        // takes the parent's kind of box (in a flex row it lays its children out in a row: vercel.com
                        // wraps each menu entry in one, and the menu stood in a column), the way the parent spreads its
                        // items, and no margins, padding or border. Marked for the shim, which lets it take the room
                        // left over in a row that spreads its items (see fixContents in shims-extra.js).
                        push(out, 'display', 'inherit', imp);
                        push(out, '-webkit-box-orient', 'inherit', imp);
                        push(out, '-webkit-box-direction', 'inherit', imp);
                        push(out, '-webkit-box-align', 'inherit', imp);
                        push(out, '-webkit-box-pack', 'inherit', imp);
                        push(out, 'margin', '0', imp);
                        push(out, 'padding', '0', imp);
                        push(out, 'border-width', '0', imp);
                        if (!keyframe) markers.push('br-contents 1');
                    }
                    else if (lv === 'inherit') {
                        // (a child of a display: contents element is one too: the shim treats it like one, see above)
                        push(out, 'display', 'inherit', imp);
                        if (!keyframe) markers.push('br-dinherit 1');
                    }
                    else if (lv === 'grid' || lv === 'flow-root') push(out, 'display', 'block', imp);
                    else if (lv === 'inline-grid') push(out, 'display', 'inline-block', imp);
                    else push(out, 'display', v, imp);
                    continue;
                case 'flex-direction':
                    if (isGlobalKeyword(lv)) { push(out, '-webkit-box-orient', lv, imp); push(out, '-webkit-box-direction', lv, imp); }
                    else {
                        if (!hasDisplay && /^row/.test(lv)) {
                            var cfd = columnFlexDisplay(ctx);
                            // a row that wraps becomes what display:flex + flex-wrap:wrap becomes (the 2009 box cannot wrap:
                            // Google's sign-in put its heading, form and buttons rows on one squeezed line)
                            if (cfd && wrap) { push(out, 'display', cfd === '-webkit-inline-box' ? 'inline-block' : 'block', imp); ctx.rowWrapRule = true; }
                            else if (cfd) push(out, 'display', cfd, imp);
                        }
                        push(out, '-webkit-box-orient', /column/.test(lv) ? 'vertical' : 'horizontal', imp);
                        push(out, '-webkit-box-direction', /reverse/.test(lv) ? 'reverse' : 'normal', imp);
                    }
                    push(out, p, v, imp);
                    continue;
                case 'flex-flow':
                    if (!hasDisplay && /\brow/.test(lv)) {
                        var cff = columnFlexDisplay(ctx);
                        if (cff && wrap) { push(out, 'display', cff === '-webkit-inline-box' ? 'inline-block' : 'block', imp); ctx.rowWrapRule = true; }   // (see flex-direction)
                        else if (cff) push(out, 'display', cff, imp);
                    }
                    if (/column|row/.test(lv)) {
                        push(out, '-webkit-box-orient', /column/.test(lv) ? 'vertical' : 'horizontal', imp);
                        push(out, '-webkit-box-direction', /reverse/.test(lv) ? 'reverse' : 'normal', imp);
                    } else if (isGlobalKeyword(lv)) { push(out, '-webkit-box-orient', lv, imp); push(out, '-webkit-box-direction', lv, imp); push(out, '-webkit-box-lines', lv, imp); }
                    if (/wrap/.test(lv) && !/nowrap/.test(lv)) push(out, '-webkit-box-lines', 'multiple', imp);
                    push(out, p, v, imp);
                    continue;
                case 'flex-wrap':
                    push(out, '-webkit-box-lines', isGlobalKeyword(lv) ? lv : /^wrap/.test(lv) ? 'multiple' : 'single', imp);
                    push(out, p, v, imp);
                    continue;
                case 'justify-content': {
                    var jcv = alignKeyword(lv);
                    if (PACK[jcv]) push(out, '-webkit-box-pack', PACK[jcv], imp);
                    else if (isGlobalKeyword(lv)) push(out, '-webkit-box-pack', lv, imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'align-items': {
                    var aiv = alignKeyword(lv);
                    if (ALIGN[aiv]) push(out, '-webkit-box-align', ALIGN[aiv], imp);
                    else if (isGlobalKeyword(lv)) push(out, '-webkit-box-align', lv, imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'place-items': {
                    var pi = alignKeyword(lv);   // "<align-items> <justify-items>?": the first is the cross axis
                    if (ALIGN[pi]) push(out, '-webkit-box-align', ALIGN[pi], imp);
                    else if (isGlobalKeyword(lv)) push(out, '-webkit-box-align', lv, imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'place-content': {
                    var pc = alignKeywords(lv), jc = pc.length > 1 ? pc[1] : pc[0];
                    if (PACK[jc]) push(out, '-webkit-box-pack', PACK[jc], imp);
                    else if (isGlobalKeyword(lv)) push(out, '-webkit-box-pack', lv, imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'flex': {
                    if (isGlobalKeyword(lv)) { push(out, '-webkit-box-flex', lv, imp); push(out, p, v, imp); continue; }
                    var f = parseFlexShorthand(v);
                    push(out, '-webkit-box-flex', f.grow, imp);
                    if (f.basis && f.basis !== '0' && f.basis !== '0px' && f.basis !== '0%') push(out, 'width', /^(min-content|max-content|fit-content|stretch)$/.test(f.basis) ? 'auto' : f.basis, imp);
                    else if (/\b(auto|content)\b/.test(lv) || lv === 'none' || lv === 'initial') push(out, 'width', 'auto', imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'flex-grow':
                    push(out, '-webkit-box-flex', v, imp);
                    push(out, p, v, imp);
                    continue;
                case 'flex-basis':
                    if (lv === 'auto' || lv === 'content' || /^(min-content|max-content|fit-content|stretch|-webkit-)/.test(lv)) push(out, 'width', 'auto', imp);
                    else if (lv !== '0' && lv !== '0px') push(out, 'width', v, imp);
                    push(out, p, v, imp);
                    continue;
                case 'order': {
                    var o = parseInt(v, 10);
                    push(out, '-webkit-box-ordinal-group', isGlobalKeyword(lv) ? lv : String(isNaN(o) ? 1 : Math.max(1, o + 1)), imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'inset': {
                    var ib = expandBox(splitWS(v));
                    push(out, 'top', ib[0], imp); push(out, 'right', ib[1], imp); push(out, 'bottom', ib[2], imp); push(out, 'left', ib[3], imp);
                    continue;
                }
                case 'aspect-ratio': {
                    // the engine has no aspect-ratio: the ratio travels in a harmless counter-reset value that
                    // shims-extra.js reads back from the computed style and turns into a height
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    var ar = /(?:^|\s)([\d.]+)\s*(?:\/\s*([\d.]+))?\s*$/.exec(lv.replace(/^auto\s*/, ''));
                    if (ar) {
                        var arw = parseFloat(ar[1]), arh = ar[2] ? parseFloat(ar[2]) : 1;
                        if (arw > 0 && arh > 0) markers.push('br-aspect ' + Math.round(arw * 1000) + ' br-aspect-h ' + Math.round(arh * 1000));
                    }
                    push(out, p, v, imp);
                    continue;
                }
                case 'width': case 'inline-size':
                    // the engine has no intrinsic sizing keywords: a table shrinks to fit its content (and never
                    // below the min-content width, which "width: 1px" then asks for). In a stylesheet that goes into a
                    // rule of its own at the top (see fixCSS): the display of any other rule wins over it, as utility
                    // CSS needs (Tailwind's .w-max comes after .flex and .hidden: denik.cz's card strip became a
                    // table with its cards stacked).
                    if (!hasDisplay && !keyframe && (lv === '-webkit-fit-content' || lv === '-webkit-max-content' || lv === '-webkit-min-content')) {
                        var fitDecls = [{ p: 'display', v: 'table', imp: false }, { p: 'width', v: lv === '-webkit-min-content' ? '1px' : 'auto', imp: imp }];
                        if (ctx.headRules && ctx.curSels) ctx.tableFit = fitDecls;
                        else { push(out, 'display', 'table', imp); push(out, 'width', fitDecls[1].v, imp); }
                    }
                    push(out, 'width', v, imp);
                    continue;
                case 'margin-left': case 'margin-inline-start':
                    push(out, 'margin-left', (flexPush && autoLeft && lv === 'auto') ? '0' : v, imp);
                    continue;
                case 'margin-right': case 'margin-inline-end':
                    push(out, 'margin-right', (flexPush && autoRight && lv === 'auto') ? '0' : v, imp);
                    continue;
                case 'margin':
                    push(out, p, flexPush ? replaceAutoMargin(lv, autoLeft) : v, imp);
                    continue;
                case 'margin-inline': {
                    var miv = splitWS(lv), miStart = miv[0], miEnd = miv.length > 1 ? miv[1] : miv[0];
                    if (flexPush && autoLeft && miStart === 'auto') miStart = '0';
                    if (flexPush && autoRight && miEnd === 'auto') miEnd = '0';
                    push(out, 'margin-left', miStart, imp);
                    push(out, 'margin-right', miEnd, imp);
                    continue;
                }
                case 'overflow': case 'overflow-x': case 'overflow-y': {
                    // auto scrolls as scroll: this engine draws no scrollbars and keeps no room for them, and a -webkit-box
                    // with auto overflow inside a horizontal one crashed it when its scrollbars came or went (WebCore
                    // LayoutState, from finishDelayUpdateScrollInfo: novinky.cz). Rules for html/body/:root and style
                    // attributes (whose element may be those) keep auto, which carries over to the page's own scrolling.
                    var ovAuto = ctx.curSels && ctx.curSels.length && !/(^|[\s,>+~(])(html|body|:root)(?![\w-])/i.test(ctx.curSels.join(',')) ? 'scroll' : 'auto';
                    var ovs = splitWS(lv), ovMap = function (x) { return x === 'overlay' || x === 'auto' ? ovAuto : x === 'clip' ? 'hidden' : x; };
                    // (one axis other than visible makes a visible other axis auto: that one scrolls as scroll too.
                    // The crash above came from overflow-x: hidden alone on a button, which is a -webkit-box here)
                    var ovOther = function (x) { return ovAuto === 'scroll' && /^(hidden|clip|scroll|auto|overlay)$/.test(x) ? 'scroll' : null; };
                    // two values (x y) are two properties here
                    if (p === 'overflow' && ovs.length === 2 && !isGlobalKeyword(ovs[0])) {
                        var ov0 = ovMap(ovs[0]), ov1 = ovMap(ovs[1]);
                        if (ov0 === 'visible' && ovOther(ovs[1])) ov0 = 'scroll';
                        if (ov1 === 'visible' && ovOther(ovs[0])) ov1 = 'scroll';
                        push(out, 'overflow-x', ov0, imp);
                        push(out, 'overflow-y', ov1, imp);
                    } else {
                        push(out, p, ovs.length === 1 ? ovMap(lv) : v, imp);
                        if (ovs.length === 1 && ovOther(lv)) {
                            if ((p === 'overflow-x' || p === 'overflow-inline') && !ovSetY) push(out, 'overflow-y', 'scroll', imp);
                            else if ((p === 'overflow-y' || p === 'overflow-block') && !ovSetX) push(out, 'overflow-x', 'scroll', imp);
                        }
                    }
                    // a box that scrolls vertically: marked for the page shim, which limits its height where the flex
                    // column that should have shrunk it is a plain block here (the buttons of a dialog below the screen)
                    var ovY = p === 'overflow-x' ? '' : ovs[ovs.length - 1];
                    if (!keyframe && (ovY === 'auto' || ovY === 'scroll' || ovY === 'overlay')) markers.push('br-scroll 1');
                    continue;
                }
                case 'opacity':
                    push(out, p, /%$/.test(lv) ? String(Math.round(parseFloat(lv) * 10) / 1000) : v, imp);
                    continue;
                case 'overflow-wrap': case 'word-wrap':
                    push(out, 'word-wrap', lv === 'anywhere' ? 'break-word' : v, imp);
                    if (p === 'overflow-wrap') push(out, p, v, imp);
                    continue;
                case 'word-break':
                    push(out, p, lv === 'auto-phrase' ? 'normal' : v, imp);
                    continue;
                case 'white-space': case 'white-space-collapse': case 'text-wrap': case 'text-wrap-mode': {
                    // css-text-4 keywords and the two-value syntax become the classic white-space values
                    var wsv = whiteSpaceValue(p, lv);
                    if (p === 'white-space') { push(out, p, wsv || v, imp); continue; }
                    if (wsv) push(out, 'white-space', wsv, imp);
                    if (/\bbalance\b/.test(lv)) markers.push('br-balance 1');   // the shim balances the lines of marked headings
                    if (p === 'text-wrap' && isGlobalKeyword(lv)) markerKeyword = lv;
                    push(out, p, v, imp);
                    continue;
                }
                case 'text-wrap-style':
                    if (lv === 'balance') markers.push('br-balance 1');
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    push(out, p, v, imp);
                    continue;
                case 'vertical-align': {
                    // css-inline-3 baseline keywords (alphabetic, central, first/last) map onto the classic ones
                    var vat = lv.split(/\s+/), vout = [];
                    for (var vi = 0; vi < vat.length; vi++) {
                        var vt = vat[vi];
                        if (vt === 'first' || vt === 'last') continue;
                        vout.push(vt === 'alphabetic' ? 'baseline' : vt === 'central' || vt === 'mathematical' || vt === 'center' ? 'middle' : vt === 'ideographic' ? 'text-bottom' : vt);
                    }
                    push(out, p, vout.length ? vout[0] : 'baseline', imp);
                    continue;
                }
                case 'text-overflow': {
                    // fade() and strings are not drawn here; of two values (start/end lines) the end one is kept
                    var tov = splitWS(lv), tol = tov[tov.length - 1] || 'clip';
                    push(out, p, tol === 'clip' || tol === 'ellipsis' || isGlobalKeyword(tol) ? tol : 'ellipsis', imp);
                    continue;
                }
                case 'image-rendering':
                    if (lv === 'pixelated' || lv === 'crisp-edges') push(out, p, '-webkit-optimize-contrast', imp);
                    else if (lv === 'smooth' || lv === 'high-quality') push(out, p, 'auto', imp);
                    push(out, p, v, imp);
                    continue;
                case 'contain':
                    if (/(^|\s)(strict|content|paint)(\s|$)/.test(lv)) push(out, 'overflow', 'hidden', imp);   // paint containment clips
                    push(out, p, v, imp);
                    continue;
                case 'hyphenate-limit-chars': {
                    // "<total> <before> <after>" -> the old engine's before/after limits
                    var hl = lv.split(/\s+/);
                    if (hl.length > 1 && hl[1] !== 'auto') push(out, '-webkit-hyphenate-limit-before', hl[1], imp);
                    if (hl.length > 2 && hl[2] !== 'auto') push(out, '-webkit-hyphenate-limit-after', hl[2], imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'hyphenate-limit-lines':
                    push(out, '-webkit-hyphenate-limit-lines', v, imp);
                    push(out, p, v, imp);
                    continue;
                case 'letter-spacing': case 'word-spacing':
                    // percentages are relative to the font size (letter-spacing) or the space width (word-spacing, about a quarter em)
                    if (/^-?[\d.]+%$/.test(lv)) push(out, p, (Math.round(parseFloat(lv) * (p === 'letter-spacing' ? 100 : 25)) / 10000) + 'em', imp);
                    else push(out, p, v, imp);
                    continue;
                case 'resize':
                    push(out, p, lv === 'block' ? 'vertical' : lv === 'inline' ? 'horizontal' : v, imp);
                    continue;
                case 'user-select':
                    push(out, '-webkit-user-select', lv === 'contain' || lv === 'all' ? 'text' : v, imp);
                    push(out, p, v, imp);
                    continue;
                case 'line-break':
                    push(out, '-webkit-line-break', lv === 'anywhere' ? 'loose' : v, imp);
                    push(out, p, v, imp);
                    continue;
                case 'text-align': {
                    var ta = lv === 'start' ? 'left' : lv === 'end' ? 'right' : lv === 'justify-all' ? 'justify' : v;
                    push(out, p, ta, imp);
                    continue;
                }
                case 'font-weight': {
                    // arbitrary numbers (CSS Fonts 4) become the nearest hundred the old engine knows
                    var fw = /^-?[\d.]+$/.test(lv) ? parseFloat(lv) : NaN;
                    if (!isNaN(fw) && (fw % 100 !== 0 || fw < 100 || fw > 900)) fw = Math.min(900, Math.max(100, Math.round(fw / 100) * 100));
                    push(out, p, isNaN(fw) ? v : String(fw), imp);
                    continue;
                }
                case 'font-style':
                    push(out, p, /^oblique\s+-?[\d.]+(deg|grad|rad|turn)/.test(lv) ? 'oblique' : v, imp);
                    continue;
                case 'text-decoration': {
                    // the shorthand may carry style, colour and thickness; the old engine only takes the lines (the
                    // colour goes the text-decoration-color way below)
                    var lines = [], tdToks = splitWS(lv), other = false, tdColor = null;
                    for (var tdi = 0; tdi < tdToks.length; tdi++) {
                        if (/^(none|underline|overline|line-through|blink)$/.test(tdToks[tdi])) lines.push(tdToks[tdi]);
                        else { other = true; if (!/^(solid|double|dotted|dashed|wavy|auto|from-font|-?[\d.]+[a-z%]*)$/.test(tdToks[tdi])) tdColor = splitWS(v)[tdi]; }
                    }
                    push(out, p, other && lines.length ? lines.join(' ') : v, imp);
                    if (tdColor) pushDecorationColor(out, tdColor, imp);
                    continue;
                }
                case 'text-decoration-line':
                    push(out, 'text-decoration', v, imp);
                    push(out, p, v, imp);
                    continue;
                case 'text-decoration-color': case '-webkit-text-decoration-color':
                    pushDecorationColor(out, v, imp);
                    push(out, p, v, imp);
                    continue;
                case 'text-shadow': case 'box-shadow': case '-webkit-box-shadow': {
                    // a fourth length (spread) in text-shadow is CSS Text Decoration 4: the old parser rejects the whole value;
                    // and a blur past BLUR_CAP px is drawn as BLUR_CAP (see capBlur)
                    if (p === 'text-shadow') {
                        var shadows = splitTop(v, ','), fixedShadows = [];
                        for (var shi = 0; shi < shadows.length; shi++) {
                            var stoks = splitWS(trim(shadows[shi])), lens = [], others = [];
                            for (var sti = 0; sti < stoks.length; sti++) { if (/^-?[\d.]+(px|em|rem|pt|%|vw|vh)?$/.test(stoks[sti]) && lens.length < 3) lens.push(stoks[sti]); else if (/^-?[\d.]+(px|em|rem|pt|%|vw|vh)?$/.test(stoks[sti])) { /* spread dropped */ } else others.push(stoks[sti]); }
                            if (lens.length === 3) lens[2] = capBlur(lens[2]);
                            fixedShadows.push(lens.concat(others).join(' '));
                        }
                        push(out, p, fixedShadows.join(', '), imp);
                        continue;
                    }
                    push(out, p, capShadowBlurs(v), imp);
                    continue;
                }
                case 'list-style-type': {
                    var LST_SAFE = /^(disc|circle|square|decimal|decimal-leading-zero|lower-roman|upper-roman|lower-greek|lower-latin|upper-latin|lower-alpha|upper-alpha|armenian|georgian|none|inherit|initial|hebrew|hiragana|katakana|hiragana-iroha|katakana-iroha|cjk-ideographic|lower-norwegian|upper-norwegian|afar|amharic|arabic-indic|bengali|cambodian|devanagari|gujarati|gurmukhi|kannada|khmer|lao|malayalam|mongolian|myanmar|oriya|persian|telugu|thai|tibetan|urdu)$/;
                    var lst = v;
                    if (!LST_SAFE.test(lv)) lst = /decimal|numeric|formal|informal|hangul|hanja|chinese|japanese|tamil|ethiopic|arabic|persian/.test(lv) ? 'decimal' : 'disc';
                    push(out, p, lst, imp);
                    continue;
                }
                case 'break-before': case 'break-after': {
                    var side = p === 'break-before' ? 'before' : 'after';
                    var pageVal = /^avoid/.test(lv) ? 'avoid' : (lv === 'page' || lv === 'always' || lv === 'recto' || lv === 'verso') ? 'always' : (lv === 'left' || lv === 'right') ? lv : 'auto';
                    var colVal = /^avoid/.test(lv) ? 'avoid' : (lv === 'column' || lv === 'always') ? 'always' : 'auto';
                    push(out, 'page-break-' + side, pageVal, imp);
                    push(out, '-webkit-column-break-' + side, colVal, imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'min-width': case 'min-height': case 'min-inline-size': case 'min-block-size':
                    // "auto" is the flexbox initial value; the old engine only knows 0 there
                    push(out, p === 'min-inline-size' ? 'min-width' : p === 'min-block-size' ? 'min-height' : p, lv === 'auto' ? '0' : v, imp);
                    continue;
                case 'translate': translate = v; continue;
                case 'rotate': rotate = v; continue;
                case 'scale': scale = v; continue;
                case 'transform': {
                    hasTransform = true;
                    var tfv = splitCalcTranslates(v.replace(/\s*perspective\(\s*none\s*\)\s*/gi, ' ').replace(/^\s+|\s+$/g, '')) || 'none';
                    push(out, '-webkit-transform', tfv, imp);
                    push(out, p, v, imp);
                    continue;
                }
                case 'transition': case 'transition-property': {
                    var tv = v.replace(/(^|[\s,])(transform|filter|mask|clip-path|backdrop-filter)\b/g, '$1-webkit-$2');
                    push(out, '-webkit-' + p, isGlobalKeyword(lv) ? v : safeTransitionProps(tv, p === 'transition'), imp);
                    push(out, p, v, imp);
                    continue;
                }
                case '-webkit-transition': case '-webkit-transition-property':
                    push(out, p, isGlobalKeyword(lv) ? v : safeTransitionProps(v, p === '-webkit-transition'), imp);
                    continue;
                case 'background-clip': case '-webkit-background-clip':
                    if (lv === 'text') push(out, '-webkit-background-clip', 'text', imp);
                    push(out, p, v, imp);
                    continue;
                case 'break-inside': case 'page-break-inside':
                    if (lv === 'avoid' || lv === 'avoid-column') push(out, '-webkit-column-break-inside', 'avoid', imp);
                    push(out, p, v, imp);
                    continue;
                case 'position':
                    if (lv === 'sticky') push(out, p, '-webkit-sticky', imp);   // iOS 6.1 knows the prefixed value
                    push(out, p, v, imp);
                    continue;
                case 'text-rendering':
                    // optimizeLegibility / geometricPrecision force the slow CoreText shaping path in the old engine
                    push(out, p, /speed|auto/i.test(lv) ? v : 'optimizeSpeed', imp);
                    continue;
                case 'container-type': case 'container-name': case 'container': {
                    // container elements are marked through counter-reset (read back from the computed style by the
                    // shim): "br-container 1" for a size container, "br-cn-<name> 1" for each container name
                    var cqMarks = [], cqNames = '', cqType = '';
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    if (p === 'container') { var slash = lv.indexOf('/'); cqNames = trim(slash >= 0 ? lv.slice(0, slash) : lv); cqType = slash >= 0 ? trim(lv.slice(slash + 1)) : ''; }
                    else if (p === 'container-name') cqNames = lv;
                    else cqType = lv;
                    if (cqType === 'size' || cqType === 'inline-size') cqMarks.push('br-container 1');
                    if (cqNames && cqNames !== 'none') { var cqList = cqNames.split(/\s+/); for (var cqi = 0; cqi < cqList.length; cqi++) if (/^[a-z_][\w-]*$/.test(cqList[cqi])) cqMarks.push('br-cn-' + cqList[cqi] + ' 1'); }
                    for (var cqk = 0; cqk < cqMarks.length; cqk++) markers.push(cqMarks[cqk]);
                    push(out, p, v, imp);
                    continue;
                }
                case 'scroll-snap-type': {
                    // "x mandatory", "both proximity", "inline mandatory": the shim snaps the scroll position of marked containers
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    var snapAxis = /\b(x|inline)\b/.test(lv) ? 'x' : /\b(y|block)\b/.test(lv) ? 'y' : /\bboth\b/.test(lv) ? 'both' : null;
                    if (snapAxis && lv !== 'none') {
                        if (snapAxis !== 'y') markers.push('br-snap-x 1');
                        if (snapAxis !== 'x') markers.push('br-snap-y 1');
                        if (/\bmandatory\b/.test(lv)) markers.push('br-snap-m 1');
                    } else if (lv === 'none') markerKeyword = 'none';   // no markers: this container does not snap
                    push(out, p, v, imp);
                    continue;
                }
                case 'scroll-snap-align': case 'scroll-snap-stop': {
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    if (p === 'scroll-snap-align') {
                        var snapAlign = /\bcenter\b/.test(lv) ? 2 : /\bend\b/.test(lv) ? 3 : /\bstart\b/.test(lv) ? 1 : 0;
                        if (snapAlign) markers.push('br-snap-align ' + snapAlign);
                        else if (lv === 'none') markerKeyword = 'none';   // not a snap position
                    } else if (lv === 'always') markers.push('br-snap-stop 1');
                    push(out, p, v, imp);
                    continue;
                }
                case 'scroll-padding': case 'scroll-padding-left': case 'scroll-padding-top': case 'scroll-padding-inline-start': case 'scroll-padding-block-start':
                case 'scroll-padding-inline': case 'scroll-padding-block': case 'scroll-padding-right': case 'scroll-padding-bottom': case 'scroll-padding-inline-end': case 'scroll-padding-block-end':
                case 'scroll-margin': case 'scroll-margin-left': case 'scroll-margin-top': case 'scroll-margin-inline-start': case 'scroll-margin-block-start': case 'scroll-margin-inline': case 'scroll-margin-block':
                case 'scroll-margin-right': case 'scroll-margin-bottom': case 'scroll-margin-inline-end': case 'scroll-margin-block-end': {
                    // the start-side value (px, em, rem) becomes the container's snap padding or the item's snap margin
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    var spToks = lv.split(/\s+/), spTok = spToks[(p === 'scroll-padding' || p === 'scroll-margin') && spToks.length > 1 ? 3 : 0] || spToks[0];
                    if ((p === 'scroll-padding' || p === 'scroll-margin') && spToks.length === 2) spTok = spToks[1];
                    if ((p === 'scroll-padding' || p === 'scroll-margin') && spToks.length === 3) spTok = spToks[1];
                    var spv = /^(-?[\d.]+)(px|em|rem)$/.exec(spTok);
                    var sppct = /^(-?[\d.]+)%$/.exec(spTok);
                    if (!spv && !sppct) { var spc = evalExpr(spTok); if (spc && spc.u === 'px') spv = [null, String(spc.n), 'px']; }   // calc(3 * 25px)
                    if (spv && !/-(right|bottom|inline-end|block-end)$/.test(p)) markers.push((p.indexOf('scroll-padding') === 0 ? 'br-snap-pad ' : 'br-snap-margin ') + Math.round(parseFloat(spv[1]) * (spv[2] === 'px' ? 1 : 16)));
                    else if (sppct && p.indexOf('scroll-padding') === 0 && !/-(right|bottom|inline-end|block-end)$/.test(p)) markers.push('br-snap-padp ' + Math.round(parseFloat(sppct[1]) * 100));   // percent of the scrollport
                    else if (spv || sppct || /^(auto|0|calc\()/.test(spTok)) markers.push('br-snap-end 1');   // end-side values only mark the element as snap-aware
                    push(out, p, v, imp);
                    continue;
                }
                case 'scroll-behavior':
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    if (lv === 'smooth') markers.push('br-smooth 1');
                    push(out, p, v, imp);
                    continue;
                case 'border-top-radius': case 'border-right-radius': case 'border-bottom-radius': case 'border-left-radius':
                case 'border-block-start-radius': case 'border-block-end-radius': case 'border-inline-start-radius': case 'border-inline-end-radius': {
                    // css-borders-4 side shorthands: "<h1> <h2>? / <v1> <v2>?" -> the two corner longhands
                    var corners = RADIUS_SIDES[p.replace(/^border-|-radius$/g, '')];
                    if (isGlobalKeyword(lv)) { push(out, corners[0], v, imp); push(out, corners[1], v, imp); continue; }
                    var rSlash = scanUntil(v, 0, v.length, '/');
                    var rh = splitWS(trim(v.slice(0, rSlash))), rv = rSlash < v.length ? splitWS(trim(v.slice(rSlash + 1))) : null;
                    if (!rh.length) { push(out, p, v, imp); continue; }
                    var rh2 = rh.length > 1 ? rh[1] : rh[0], rv1 = rv && rv.length ? rv[0] : null, rv2 = rv && rv.length ? (rv.length > 1 ? rv[1] : rv[0]) : null;
                    push(out, corners[0], rv1 ? rh[0] + ' ' + rv1 : rh[0], imp);
                    push(out, corners[1], rv2 ? rh2 + ' ' + rv2 : rh2, imp);
                    continue;
                }
                case 'animation-timeline': {
                    // scroll-driven animations: the shim pauses the animation and seeks it with a negative delay
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    var tl0 = trim(splitTop(lv, ',')[0]), tlm = /^(scroll|view)\(([^)]*)\)$/.exec(tl0);
                    if (tlm) {
                        markers.push('br-tl-' + tlm[1] + ' 1');
                        if (/\b(inline|x)\b/.test(tlm[2])) markers.push('br-tl-inline 1');
                        if (/\broot\b/.test(tlm[2])) markers.push('br-tl-root 1');
                        if (/\bself\b/.test(tlm[2])) markers.push('br-tl-self 1');
                    } else if (/^--[\w-]+$/.test(tl0)) markers.push('br-tl-named-' + tl0.slice(2) + ' 1');
                    push(out, p, v, imp);
                    continue;
                }
                case 'scroll-timeline-name': case 'view-timeline-name': case 'scroll-timeline': case 'view-timeline': {
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    var tnl = splitTop(lv, ',');
                    for (var tni = 0; tni < tnl.length; tni++) {
                        var tnt = splitWS(trim(tnl[tni]));
                        if (tnt.length === 1 && tnt[0] === 'none') { markers.push('br-tl-none 1'); continue; }   // (no timeline: nothing to drive)
                        if (tnt.length && /^--[\w-]+$/.test(tnt[0])) markers.push((p.indexOf('scroll') === 0 ? 'br-stl-' : 'br-vtl-') + tnt[0].slice(2) + ' 1');
                        if (/\b(inline|x)\b/.test(tnl[tni])) markers.push('br-tl-src-inline 1');
                        // view-timeline: name, axis and inset in any order after the name
                        if (p === 'view-timeline' && tnt.length > 1) {
                            var insetToks = [];
                            for (var tii = 1; tii < tnt.length; tii++) if (!/^(block|inline|x|y)$/.test(tnt[tii])) insetToks.push(tnt[tii]);
                            if (insetToks.length) timelineInsetMarkers(insetToks.join(' '), markers);
                        }
                    }
                    push(out, p, v, imp);
                    continue;
                }
                case 'scroll-timeline-axis': case 'view-timeline-axis': {
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    var axes = splitTop(lv, ','), axisOk = true;
                    for (var axi = 0; axi < axes.length; axi++) if (!/^(block|inline|x|y)$/.test(trim(axes[axi]))) axisOk = false;
                    if (axisOk && !isGlobalKeyword(lv)) markers.push(/^(inline|x)$/.test(trim(axes[0])) ? 'br-tl-src-inline 1' : 'br-tl-src-block 1');
                    push(out, p, v, imp);
                    continue;
                }
                case 'view-timeline-inset': {
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    else timelineInsetMarkers(trim(splitTop(lv, ',')[0]), markers);
                    push(out, p, v, imp);
                    continue;
                }
                case 'timeline-scope': {
                    // named timelines are found anywhere in the document here, so every scope works
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    else if (/^(none|all|--[\w-]+(\s*,\s*--[\w-]+)*)$/.test(lv)) markers.push('br-tls 1');
                    push(out, p, v, imp);
                    continue;
                }
                case 'animation-range': case 'animation-range-start': case 'animation-range-end': {
                    if (isGlobalKeyword(lv)) markerKeyword = lv;
                    // (several animations: the first range drives them all)
                    var arc = animationRangeCodes(p, trim(splitTop(lv, ',')[0]));
                    if (arc[0] !== null) markers.push('br-ar-s ' + arc[0]);
                    if (arc[1] !== null) markers.push('br-ar-e ' + arc[1]);
                    if (arc[2] !== null) markers.push('br-arpx-s ' + arc[2]);
                    if (arc[3] !== null) markers.push('br-arpx-e ' + arc[3]);
                    push(out, p, v, imp);
                    continue;
                }
                case 'animation-duration': {
                    // "auto" belongs to scroll timelines; the engine needs a real length to seek in
                    var adv = lv === 'auto' ? '1s' : v.replace(/\bauto\b/g, '1s');
                    push(out, '-webkit-animation-duration', adv, imp);
                    push(out, p, adv, imp);
                    continue;
                }
                case 'clip-path': case '-webkit-clip-path': {
                    // the engine has no clip-path: basic shapes become an SVG mask image (alpha), which the old
                    // -webkit-mask-image does render
                    var maskDecls = clipPathToMask(v);
                    if (maskDecls) for (var md = 0; md < maskDecls.length; md++) push(out, maskDecls[md][0], maskDecls[md][1], imp);
                    push(out, '-webkit-clip-path', v, imp);
                    push(out, 'clip-path', v, imp);
                    continue;
                }
                case 'line-clamp':
                    // the standard property is the old -webkit-line-clamp idiom (which needs the legacy box); the old
                    // engine always ends with an ellipsis, whatever the second value asks for
                    if (lv === 'none') push(out, '-webkit-line-clamp', 'none', imp);
                    var lcm = /^(\d+)(\s+(clip|ellipsis|"[^"]*"|'[^']*'))?$/.exec(lv);
                    if (lcm) {
                        push(out, '-webkit-line-clamp', lcm[1], imp);
                        if (!hasDisplay) push(out, 'display', '-webkit-box', imp);
                        push(out, '-webkit-box-orient', 'vertical', imp);
                        push(out, 'overflow', 'hidden', imp);
                    }
                    push(out, p, v, imp);
                    continue;
                case 'font-variant-caps': case 'font-variant-numeric': case 'font-variant-east-asian': case 'font-variant-ligatures':
                case 'font-variant-position': case 'font-variant-alternates': case 'font-variant': {
                    // OpenType features for what the keywords ask (collected for the whole rule, below); small capitals
                    // and sub/superscripts are synthesised by the engine, as the spec allows for fonts without them
                    if (isGlobalKeyword(lv)) {
                        if (p === 'font-variant' || p === 'font-variant-caps') push(out, 'font-variant', lv, imp);
                        if (p !== 'font-variant-caps' && p !== 'font-variant-position') features.push(lv);
                        push(out, p, v, imp);
                        continue;
                    }
                    var fvToks = splitWS(lv), fvCaps = null, fvPos = null;
                    for (var fvi = 0; fvi < fvToks.length; fvi++) {
                        var fvt = fvToks[fvi];
                        if (/^(all-)?(small|petite)-caps$/.test(fvt)) fvCaps = fvt;
                        else if (fvt === 'sub' || fvt === 'super') fvPos = fvt;
                        else if (FONT_VARIANT_FEATURES.hasOwnProperty(fvt)) features.push(FONT_VARIANT_FEATURES[fvt]);
                        else if (fvt === 'none' && (p === 'font-variant' || p === 'font-variant-ligatures')) features.push(FONT_VARIANT_FEATURES['no-common-ligatures'], FONT_VARIANT_FEATURES['no-discretionary-ligatures'], FONT_VARIANT_FEATURES['no-historical-ligatures'], FONT_VARIANT_FEATURES['no-contextual']);
                    }
                    if (fvCaps) {
                        push(out, 'font-variant', 'small-caps', imp);
                        if (/^all-/.test(fvCaps)) push(out, 'text-transform', 'lowercase', imp);   // capitals shrink too
                    } else if ((p === 'font-variant' || p === 'font-variant-caps') && (lv === 'normal' || lv === 'none')) push(out, 'font-variant', 'normal', imp);
                    if (fvPos) { push(out, 'vertical-align', fvPos, imp); push(out, 'font-size', 'smaller', imp); }
                    push(out, p, v, imp);
                    continue;
                }
                case 'font-feature-settings': case '-webkit-font-feature-settings':
                    // only where a rule asks for more than the defaults, and not for the whole page: features switch on
                    // the engine's complex text layout, which is slow on this hardware
                    if (!/^\s*normal\s*$/i.test(lv) && !/^(\s*,?\s*["'](kern|liga|clig|calt|rlig|locl|ccmp|mark|mkmk)["']\s*(1|on)?)+\s*$/i.test(lv)) features.push(v);
                    continue;
                case 'font-kerning': case '-webkit-font-kerning': case 'font-optical-sizing': case 'font-variation-settings':
                    continue;   // each of these switches on complex text layout for the whole element
                case 'object-fit': case 'object-position':
                    // object-fit-images (in the polyfill bundle) reads the intent from this font-family hack
                    push(out, p, v, imp);
                    if (!ofiDone) {
                        ofiDone = true;
                        push(out, 'font-family', '"' + (objectFit ? 'object-fit: ' + objectFit : '') + (objectFit && objectPosition ? '; ' : '') +
                             (objectPosition ? 'object-position: ' + objectPosition : '') + '"', imp);
                    }
                    continue;
                case 'font':
                    push(out, p, v.replace(/\b(system-ui|-apple-system)\b/g, 'Helvetica Neue'), imp);
                    continue;
                case 'font-family':
                    push(out, p, v.replace(/\b(system-ui|-apple-system|BlinkMacSystemFont|ui-sans-serif|ui-serif|ui-monospace)\b/g, function (m) {
                        return m === 'ui-serif' ? 'Georgia' : m === 'ui-monospace' ? 'Courier' : '"Helvetica Neue"';
                    }), imp);
                    continue;
            }
            if (LOGICAL_SINGLE[p]) { push(out, LOGICAL_SINGLE[p], v, imp); continue; }
            if (LOGICAL_PAIR[p]) {
                var pair = LOGICAL_PAIR[p], pv = splitWS(v);
                push(out, pair[0], pv[0], imp);
                push(out, pair[1], pv.length > 1 ? pv[1] : pv[0], imp);
                continue;
            }
            if (p === '-webkit-transform') v = splitCalcTranslates(v);
            if (PREFIX[p]) {
                push(out, '-webkit-' + p, v, imp);
                push(out, p, v, imp);
                continue;
            }
            push(out, p, v, imp);
            lastImp = imp;
        }
        if ((translate || rotate || scale) && !hasTransform) {
            var parts = [];
            // the individual transforms are composed into transform here: inherit takes the parent's composed transform,
            // none / initial / unset contribute nothing (all of them nothing: no transform)
            var tkw = function (x) { x = x ? trim(x).toLowerCase() : null; return x === 'initial' || x === 'unset' || x === 'revert' ? 'none' : x; };
            translate = tkw(translate); rotate = tkw(rotate); scale = tkw(scale);
            if (translate === 'inherit' || rotate === 'inherit' || scale === 'inherit') { push(out, '-webkit-transform', 'inherit', false); push(out, 'transform', 'inherit', false); translate = rotate = scale = null; }
            else if ((!translate || translate === 'none') && (!rotate || rotate === 'none') && (!scale || scale === 'none')) { push(out, '-webkit-transform', 'none', false); push(out, 'transform', 'none', false); translate = rotate = scale = null; }
            if (translate && translate !== 'none') {
                var tt = splitWS(translate);
                parts.push(tt.length > 2 ? 'translate3d(' + tt[0] + ', ' + tt[1] + ', ' + tt[2] + ')' : tt.length > 1 ? 'translate(' + tt[0] + ', ' + tt[1] + ')' : 'translate(' + tt[0] + ')');
            }
            if (rotate && rotate !== 'none') {
                var rt = splitWS(rotate), rl = rt[0].toLowerCase();
                if (rt.length === 2 && (rl === 'x' || rl === 'y' || rl === 'z')) parts.push(rl === 'z' ? 'rotate(' + rt[1] + ')' : 'rotate' + rl.toUpperCase() + '(' + rt[1] + ')');
                else if (rt.length === 4) parts.push('rotate3d(' + rt[0] + ', ' + rt[1] + ', ' + rt[2] + ', ' + rt[3] + ')');
                else parts.push('rotate(' + rotate + ')');
            }
            if (scale && scale !== 'none') {
                var st = splitWS(scale);
                parts.push(st.length > 2 ? 'scale3d(' + st[0] + ', ' + st[1] + ', ' + st[2] + ')' : st.length > 1 ? 'scale(' + st[0] + ', ' + st[1] + ')' : 'scale(' + st[0] + ')');
            }
            if (parts.length) { push(out, '-webkit-transform', parts.join(' '), false); push(out, 'transform', parts.join(' '), false); }
        }
        if (features.length && !broadSelectors(ctx.curSels)) {
            var fset = [], fseen = {};
            for (var fi = 0; fi < features.length; fi++) {
                var ftag = trim(features[fi]);
                if (isGlobalKeyword(ftag.toLowerCase())) { fset = [ftag.toLowerCase()]; break; }
                if (!fseen[ftag]) { fseen[ftag] = 1; fset.push(ftag); }
            }
            push(out, '-webkit-font-feature-settings', fset.join(', '), false);
        }
        // Icon fonts that draw each icon as the ligature of its name (Material Icons and Symbols, a site's own icon or
        // logo font: "home" becomes the house, denik.cz's logo is the word "denik"): the old engine forms ligatures only
        // when asked, and the optimizeLegibility such rules ask with is turned off above because it slows all text
        // down. A rule that asks for ligatures, names its font and sets what icon rules set (font-style: normal,
        // line-height: 1, white-space: nowrap) gets them back; for an icon's few letters they cost nothing.
        if (ligaAsked && iconLike && ownFamily && !GENERIC_FAMILIES.hasOwnProperty(ownFamily) && !keyframe && !broadSelectors(ctx.curSels))
            push(out, '-webkit-font-variant-ligatures', 'common-ligatures', false);
        // a -webkit-calc() length in a property an earlier document of the page transitions: the rule takes the
        // transitions of its elements over (the list goes in at the end, see guardCalcTransitions)
        if (ctx.pageTrans && !keyframe) {
            var takeover = false;
            for (var tk = 0; tk < out.length && !takeover; tk++) {
                if (String(out[tk].v).indexOf('-webkit-calc(') < 0) continue;
                var hitProps = calcCrashProps(out[tk].p);
                for (var th = 0; th < hitProps.length; th++) if (ctx.pageTrans[hitProps[th]]) { takeover = true; break; }
            }
            if (takeover) push(out, '-webkit-transition-property', TAKEOVER_MARK, true);
        }
        // A gap in a rule of its own (utility classes: class="flex gap-4"; next to display:flex or grid the container
        // rule turns it into margins, see transformRules): marked for the shim, the length times 100 per unit
        // ("br-cgap-rem 100": a column gap of 1rem), which gives the items margins once it sees what the box is.
        // (a style attribute has no rule for the margins; a later rule of a known grid has its own form)
        var gapKey = ctx.curSels ? ctx.curSels.join(',') : null;
        var gapGrid = gapKey && ((ctx.gridSels && ctx.gridSels[gapKey] > 0) || (ctx.gridFlow && ctx.gridFlow[gapKey]));
        if (!keyframe && (gapRow || gapCol) && !multicol && (ctx.inlineStyle || !/flex|grid/.test(dispVal)) && !gapGrid) {
            var gapMark = function (kind, gv) {
                var gm = gv && /^(\d*\.?\d+)(px|rem|em)$/.exec(gv);
                if (gm && parseFloat(gm[1]) > 0) markers.push('br-' + kind + 'gap-' + gm[2] + ' ' + Math.round(parseFloat(gm[1]) * 100));
            };
            gapMark('r', gapRow);
            gapMark('c', gapCol);
        }
        // Items that must not shrink (flex-shrink: 0, flex: none): their selectors go to the manifest ("mk" entries with
        // ns), for the shim that shrinks the other items of a row too wide for its room (the 2009 box does not shrink)
        if (!keyframe && shrink === 0 && gapKey) {
            manifestAdd('mk', { h: manifestHash('mk|ns|' + gapKey), s: gapKey, ns: 1 });
        }
        if (markers.length || markerKeyword) {
            // a counter-reset of the rule itself keeps its counters next to the markers
            var ownReset = null;
            for (var cr = 0; cr < out.length; cr++) if (out[cr].p === 'counter-reset') ownReset = out[cr];
            if (markers.length) {
                if (ownReset && !/^(none|inherit|initial|unset)$/i.test(trim(ownReset.v))) out.push({ p: 'counter-reset', v: ownReset.v + ' ' + markers.join(' '), imp: ownReset.imp });
                else push(out, 'counter-reset', markers.join(' '), ownReset ? ownReset.imp : false);
            } else if (!ownReset) push(out, 'counter-reset', markerKeyword, false);
            // the rule's selectors go to the manifest ("mk"): the shim looks for marked elements with them instead of
            // reading the style of every element of the page
            if (ctx.curSels && ctx.curSels.length && !keyframe) {
                var mkSel = ctx.curSels.join(',');
                manifestAdd('mk', { h: manifestHash('mk|' + mkSel), s: mkSel });
            }
        }
        // a style attribute keeps its declarations with scoped custom properties after the static ones: the engine
        // drops them, the shim reads them back from the attribute
        if (ctx.inlineStyle && ctx.inlineUses && ctx.inlineUses.length) {
            for (var iu = 0; iu < ctx.inlineUses.length; iu++) push(out, ctx.inlineUses[iu][0], ctx.inlineUses[iu][1], !!ctx.inlineUses[iu][2]);
            ctx.inlineUses = [];
        }
        return out;
    }

    // ------------------------------------------------------------------ selectors

    var DROP_SELECTOR = /:has\(|::slotted\(|:host|:state\(|::backdrop|::marker|::file-selector-button|::cue|::view-transition|:autofill|:picture-in-picture|:defined|:current|:past|:future|::highlight|::spelling-error|::grammar-error|::target-text|:xr-overlay|:open|:closed|:volume-locked|>>>|\/deep\/|^\s*&|\s&|&\s|:nth-child\([^)]*\bof\b/i;

    // Pseudo-classes the engine lacks that shims-extra.js maintains as classes on the elements (focus-within,
    // placeholder-shown, user-invalid/valid, blank, target-within, playing/paused/muted, local-link, modal, fullscreen)
    var STATE_CLASSES = { ':focus-within': '.br-focus-within', ':placeholder-shown': '.br-placeholder-shown', ':user-invalid': '.br-user-invalid',
        ':user-valid': '.br-user-valid', ':blank': '.br-blank', ':target-within': '.br-target-within', ':playing': '.br-playing', ':paused': '.br-paused',
        ':muted': '.br-muted', ':local-link': '.br-local-link', ':modal': '.br-modal', ':fullscreen': '.br-fullscreen', ':-webkit-full-screen': '.br-fullscreen', ':popover-open': '.br-popover-open',
        ':seeking': '.br-seeking', ':buffering': '.br-buffering', ':stalled': '.br-stalled' };
    var STATE_CLASS_RE = /:(focus-within|placeholder-shown|user-invalid|user-valid|blank|target-within|playing|paused|muted|local-link|modal|fullscreen|-webkit-full-screen|popover-open|seeking|buffering|stalled)\b/gi;

    function isCompound(sel) {   // no combinators at depth 0
        var depth = 0;
        for (var i = 0; i < sel.length; i++) {
            var c = sel.charAt(i);
            if (c === '"' || c === "'") { i = skipString(sel, i, sel.length) - 1; continue; }
            if (c === '(' || c === '[') depth++;
            else if (c === ')' || c === ']') depth--;
            else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) return false;
        }
        return true;
    }

    // number of simple selectors in a compound (e.g. ".a.b" -> 2, "div" -> 1)
    function simpleCount(sel) {
        var count = 0, depth = 0, i = 0, n = sel.length;
        while (i < n) {
            var c = sel.charAt(i);
            if (c === '"' || c === "'") { i = skipString(sel, i, n); continue; }
            if (c === '\\') { i += 2; continue; }
            if (c === '(' || c === '[') { depth++; if (c === '[') count++; }
            else if (c === ')' || c === ']') depth--;
            else if (depth === 0 && (c === '.' || c === '#' || c === ':')) { if (c !== ':' || sel.charAt(i - 1) !== ':') count++; }
            else if (depth === 0 && i === 0 && /[a-zA-Z*]/.test(c)) count++;
            i++;
        }
        return count;
    }

    // splits "a b > c" into [prefix, lastCompound] at the last top-level combinator
    function splitLastCompound(sel) {
        var depth = 0, cut = -1, n = sel.length;
        for (var i = 0; i < n; i++) {
            var c = sel.charAt(i);
            if (c === '"' || c === "'") { i = skipString(sel, i, n) - 1; continue; }
            if (c === '(' || c === '[') depth++;
            else if (c === ')' || c === ']') depth--;
            else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) cut = i;
        }
        if (cut < 0) return ['', sel];
        return [sel.slice(0, cut + 1), sel.slice(cut + 1)];
    }

    // the compound selector text immediately before position `at` (so it can be merged)
    function compoundBefore(sel, at) {
        var depth = 0, i = at - 1;
        while (i >= 0) {
            var c = sel.charAt(i);
            if (c === ')' || c === ']') depth++;
            else if (c === '(' || c === '[') depth--;
            else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~' || c === ',')) break;
            i--;
        }
        return sel.slice(i + 1, at);
    }

    function mergeCompound(outer, inner) {
        // a type selector must come first
        var innerTag = /^[a-zA-Z*][a-zA-Z0-9_-]*/.exec(inner), outerTag = /^[a-zA-Z*][a-zA-Z0-9_-]*/.exec(outer);
        if (innerTag && outerTag) return null;
        if (innerTag) return innerTag[0] + outer + inner.slice(innerTag[0].length);
        return outer + inner;
    }

    function expandIs(sel, budget) {
        var m = /:(?:is|where|matches|-moz-any)\(/i.exec(sel);
        if (!m) return [sel];
        var open = m.index + m[0].length - 1;
        var close = matchParen(sel, open);
        var inner = sel.slice(open + 1, close);
        var items = splitTop(inner, ','), i;
        var allCompound = true;
        for (i = 0; i < items.length; i++) { items[i] = trim(items[i]); if (!isCompound(items[i])) allCompound = false; }
        var before = sel.slice(0, m.index), after = sel.slice(close + 1);
        var results = [];
        if (allCompound && items.length > 1) {
            results.push(before + ':-webkit-any(' + items.join(',') + ')' + after);
        } else {
            for (i = 0; i < items.length; i++) {
                var item = items[i];
                if (!item) continue;
                if (isCompound(item)) { results.push(before + (item.charAt(0) === '*' && before ? item.slice(1) : item) + after); continue; }
                var sp = splitLastCompound(item);
                var outerCompound = compoundBefore(before, before.length);
                var merged = outerCompound ? mergeCompound(outerCompound, sp[1]) : sp[1];
                if (merged === null) continue;
                results.push(before.slice(0, before.length - outerCompound.length) + sp[0] + merged + after);
            }
        }
        var expanded = [];
        for (i = 0; i < results.length; i++) {
            if (expanded.length > budget) break;
            var sub = expandIs(results[i], budget);
            for (var k = 0; k < sub.length; k++) expanded.push(sub[k]);
        }
        return expanded;
    }

    function fixNot(sel) {
        var out = '', i = 0, n = sel.length;
        while (i < n) {
            var idx = sel.indexOf(':not(', i);
            if (idx < 0) { out += sel.slice(i); break; }
            var close = matchParen(sel, idx + 4);
            var inner = sel.slice(idx + 5, close);
            var items = splitTop(inner, ','), parts = [];
            for (var k = 0; k < items.length; k++) {
                var it = trim(items[k]);
                if (!it) continue;
                if (!isCompound(it) || simpleCount(it) > 1) return null;   // level 3 :not() takes one simple selector
                parts.push(':not(' + it + ')');
            }
            out += sel.slice(i, idx) + parts.join('');
            i = close + 1;
        }
        return out;
    }

    // ".card:has(> img):hover" -> ".card.br-has-xxxx:hover"; the shim finds the ".card" candidates and checks "> img"
    // inside each. :has() nested in :not()/:is() stays unsupported (the selector is dropped).
    function rewriteHas(sel) {
        var out = '', i = 0, n = sel.length;
        while (i < n) {
            var at = sel.indexOf(':has(', i);
            if (at < 0) { out += sel.slice(i); break; }
            var close = matchParen(sel, at + 4);
            var inner = trim(sel.slice(at + 5, close));
            var prefix = trim(out + sel.slice(i, at));
            if (!inner) return null;
            // ":not(:has(X))" works the same way with the class negated; :has() inside any other function stays unsupported
            var inNot = /:not\($/i.test(prefix);
            var target = inNot ? trim(prefix.slice(0, -5)) : prefix;
            if (!inNot && openParens(prefix) > 0) return null;
            if (!target || /[>+~\s]$/.test(target)) target += '*';
            var h = manifestHash(target + '|' + inner);
            manifestAdd('has', { h: h, target: target, inner: inner });
            out += sel.slice(i, at) + ((/[>+~\s]$/.test(sel.slice(i, at)) || at === i) && !inNot ? '*' : '') + '.br-has-' + h;
            i = close + 1;
        }
        return out;
    }

    function openParens(s) {   // unbalanced "(" outside strings and brackets
        var depth = 0, i = 0, n = s.length;
        while (i < n) {
            var c = s.charCodeAt(i);
            if (c === 34 || c === 39) { i = skipString(s, i, n); continue; }
            if (c === 40) depth++; else if (c === 41) depth--;
            i++;
        }
        return depth;
    }

    // A stylesheet inside an emulated shadow root (the shim's <div data-shadow-root> in the host, see attachShadow):
    // its selectors are scoped to that root, :host is the host element (data-br-host="<id>"), ::slotted() the host's
    // light DOM children.
    function hostSelector(sel) {
        var host = '[data-br-host="' + g_hostScope + '"]', shadow = host + ' > [data-shadow-root]';
        var FN = '((?:[^()]|\\([^()]*\\))*)';
        var slotted = new RegExp('^(.*?)::slotted\\(' + FN + '\\)(.*)$', 'i').exec(sel);
        if (slotted) return host + ' > ' + (trim(slotted[2]) || '*') + ':not([data-shadow-root])' + slotted[3];
        var ctxm = new RegExp(':host-context\\(' + FN + '\\)', 'i').exec(sel);
        if (ctxm) return trim(ctxm[1]) + ' ' + host + hostRest(sel.slice(ctxm.index + ctxm[0].length), shadow);
        var hm = new RegExp(':host(\\(' + FN + '\\))?', 'i').exec(sel);
        if (hm) {
            var compound = hm[2] ? trim(hm[2]) : '';
            var hostPart = compound ? (mergeCompound(host, compound) || host + compound) : host;
            return trim(sel.slice(0, hm.index)) ? null : hostPart + hostRest(sel.slice(hm.index + hm[0].length), shadow);
        }
        return shadow + ' ' + sel;
    }
    function hostRest(rest, shadow) {   // what follows :host in a selector
        if (!trim(rest)) return '';
        if (/^[:.\[#]/.test(rest)) return rest;   // :host:hover, :host::before
        return ' > [data-shadow-root] ' + trim(rest).replace(/^>\s*/, '');
    }

    // Structural selectors the shim computes ("sc" manifest entries, class .br-sc-<hash> on the matching elements):
    //   :nth-child(An+B of S) / :nth-last-child(An+B of S)   {k:'nth', last, an, of}
    //   :nth-col(An+B) / :nth-last-col(An+B)                 {k:'col', last, an}   (table cells by column)
    //   A || B                                                {k:'cc', col, cell}   (cells in the columns of col elements A)
    function rewriteStructural(sel) {
        var guard = 0, m;
        while (guard++ < 8 && (m = /:(nth-child|nth-last-child)\(/i.exec(sel)) !== null) {
            var open = m.index + m[0].length - 1, close = matchParen(sel, open), inner = sel.slice(open + 1, close);
            var of = /^\s*([\s\S]*?)\s+of\s+([\s\S]*)$/i.exec(inner);
            if (!of) { sel = sel.slice(0, m.index) + '\u0001' + m[1] + sel.slice(m.index + m[0].length - 1); continue; }   // plain one: kept
            var ofSels = fixSelectorList(of[2]);
            if (!ofSels.length) return null;
            var an = trim(of[1]).toLowerCase(), h = manifestHash('nth|' + m[1] + '|' + an + '|' + ofSels.join(','));
            manifestAdd('sc', { h: h, k: 'nth', last: /last/i.test(m[1]) ? 1 : 0, an: an, of: ofSels.join(',') });
            sel = sel.slice(0, m.index) + ((m.index === 0 || /[\s>+~(]$/.test(sel.slice(0, m.index))) ? '*' : '') + '.br-sc-' + h + sel.slice(close + 1);
        }
        sel = sel.replace(/\u0001/g, ':');
        sel = sel.replace(/:(nth-col|nth-last-col)\(([^)]*)\)/gi, function (all, kind, an) {
            var h = manifestHash('col|' + kind + '|' + trim(an).toLowerCase());
            manifestAdd('sc', { h: h, k: 'col', last: /last/i.test(kind) ? 1 : 0, an: trim(an).toLowerCase() });
            return '.br-sc-' + h;
        });
        var cc = sel.indexOf('||');
        if (cc > 0) {
            var colSel = fixSelectorList(trim(sel.slice(0, cc))), cellSel = trim(sel.slice(cc + 2));
            if (!colSel.length || !cellSel) return null;
            var hc = manifestHash('cc|' + colSel.join(',') + '|' + cellSel);
            manifestAdd('sc', { h: hc, k: 'cc', col: colSel.join(','), cell: cellSel });
            sel = cellSel + '.br-sc-' + hc;
        }
        return sel.replace(/(^|[\s>+~(])\.br-sc-/g, '$1*.br-sc-');
    }

    function fixSelector(sel) {
        sel = trim(sel);
        if (sel.indexOf(':has(') >= 0 && g_manifest !== false) {
            var rewritten = rewriteHas(sel);
            if (rewritten === null) return [];
            sel = rewritten;
        }
        if (g_manifest !== false && (/:nth-(last-)?(child|col)\(|\|\|/i.test(sel))) {
            var structural = rewriteStructural(sel);
            if (structural === null) return [];
            sel = structural;
        }
        // states this browser knows the answer to: media volume is set by the device buttons on iOS, there is no
        // picture-in-picture; :open / :closed follow the open attribute and open popovers; :defined through the class the
        // custom element shim keeps on elements that are not upgraded yet; :host outside a shadow root matches nothing
        sel = sel.replace(/:volume-locked\b/gi, ':-webkit-any(audio,video)')
                 .replace(/:picture-in-picture\b/gi, ':not(*)')
                 .replace(/:open\b/gi, ':-webkit-any([open],.br-popover-open)')
                 .replace(/:closed\b/gi, ':-webkit-any(details,dialog,[popover]):not([open]):not(.br-popover-open)')
                 .replace(/:not\(\s*:defined\s*\)|:defined\b/gi, function (m) { manifestAdd('sc', { h: 'defined', k: 'defined' }); return m.charAt(1) === 'n' ? '.br-undefined' : ':not(.br-undefined)'; });
        // custom states (ElementInternals.states in the shim puts .br-state-<name> on the element), autofilled fields,
        // and what never matches here: WebXR overlays, slotted content outside a shadow root
        // time-dimensional pseudo-classes: the read-aloud feature marks the block being spoken and the ones before/after
        sel = sel.replace(/:(current|past|future)\(((?:[^()]|\([^()]*\))*)\)/gi, function (m, kind, list) { return ':-webkit-any(' + trim(list) + ').br-' + kind.toLowerCase(); })
                 .replace(/:(current|past|future)\b(?!\()/gi, function (m, kind) { return '.br-' + kind.toLowerCase(); });
        sel = sel.replace(/:state\(\s*([\w-]+)\s*\)|:--([\w-]+)/gi, function (m, a, b) { return '.br-state-' + (a || b); })
                 .replace(/:autofill\b/gi, ':-webkit-autofill')
                 .replace(/:xr-overlay\b/gi, ':not(*)');
        if (g_hostScope) { sel = hostSelector(sel); if (sel === null) return []; }
        else {
            if (/:host\b/i.test(sel)) sel = sel.replace(/:host-context\((?:[^()]|\([^()]*\))*\)|:host(\((?:[^()]|\([^()]*\))*\))?/gi, ':not(*)');
            if (/::slotted\(|:has-slotted\b/i.test(sel)) sel = sel.replace(/::slotted\((?:[^()]|\([^()]*\))*\)|:has-slotted\b/gi, ':not(*)');
        }
        if (!sel || DROP_SELECTOR.test(sel)) return [];
        sel = sel.replace(/:focus-visible/gi, ':focus')
                 .replace(/::?placeholder(?![\w-])/gi, '::-webkit-input-placeholder')
                 .replace(/:any-link/gi, ':link')
                 .replace(/:scope\b/gi, ':root')
                 .replace(/(\[[^\]]*?)\s+[isIS]\s*\]/g, '$1]')
                 .replace(/:lang\(([^,)]*),[^)]*\)/gi, ':lang($1)')
                 .replace(STATE_CLASS_RE, function (m) { return STATE_CLASSES[m.toLowerCase()] || m; })
                 // shadow DOM is emulated in the light DOM, so exported parts are plain part attributes
                 .replace(/::part\(\s*([^)]*?)\s*\)/gi, function (m, names) { var ps = names.split(/\s+/), s = ''; for (var k = 0; k < ps.length; k++) if (ps[k]) s += '[part~="' + ps[k] + '"]'; return s || m; })
                 .replace(/:read-only\b/gi, '[readonly]')
                 .replace(/:read-write\b/gi, ':not([readonly])')
                 .replace(/:dir\(\s*rtl\s*\)/gi, '[dir="rtl"]')
                 .replace(/:dir\(\s*ltr\s*\)/gi, ':not([dir="rtl"])');
        var list = /:(is|where|matches|-moz-any)\(/i.test(sel) ? expandIs(sel, 48) : [sel];
        var out = [];
        for (var i = 0; i < list.length && out.length < 64; i++) {
            var s = list[i];
            if (s.indexOf(':not(') >= 0) { s = fixNot(s); if (s === null) continue; }
            s = trim(s.replace(/\s+/g, ' '));
            if (s) out.push(s);
        }
        return out;
    }

    function fixSelectorList(sel) {
        var parts = splitTop(sel, ','), out = [];
        for (var i = 0; i < parts.length; i++) {
            var fixed = fixSelector(parts[i]);
            for (var k = 0; k < fixed.length; k++) out.push(fixed[k]);
        }
        return out;
    }

    // ------------------------------------------------------------------ at-rules

    // a strict bound of a range query just inside ("width < 40rem" stops short of 40rem, not at it)
    function strictBound(v, op, up) {
        if (op.length > 1) return v;
        var m = /^(-?[\d.]+)(px|em|rem)$/i.exec(trim(v));
        if (!m) return v;
        var d = /px/i.test(m[2]) ? 0.02 : 0.001, n = parseFloat(m[1]) + (up ? d : -d);
        return (Math.round(n * 1000) / 1000) + m[2];
    }
    function fixMedia(q) {
        q = q.replace(/\(\s*(-?[\d.]+(?:px|em|rem))\s*(<=|<)\s*(width|height)\s*(<=|<)\s*(-?[\d.]+(?:px|em|rem))\s*\)/gi, function (m, a, op1, f, op2, b) { return '(min-' + f + ': ' + strictBound(a, op1, true) + ') and (max-' + f + ': ' + strictBound(b, op2, false) + ')'; })
             .replace(/\(\s*(width|height)\s*(>=|>)\s*([^)]+?)\s*\)/gi, function (m, f, op, v) { return '(min-' + f + ': ' + strictBound(v, op, true) + ')'; })
             .replace(/\(\s*(width|height)\s*(<=|<)\s*([^)]+?)\s*\)/gi, function (m, f, op, v) { return '(max-' + f + ': ' + strictBound(v, op, false) + ')'; })
             .replace(/\(\s*([^)]+?)\s*(<=|<)\s*(width|height)\s*\)/gi, function (m, v, op, f) { return '(min-' + f + ': ' + strictBound(v, op, true) + ')'; })
             .replace(/\(\s*([^)]+?)\s*(>=|>)\s*(width|height)\s*\)/gi, function (m, v, op, f) { return '(max-' + f + ': ' + strictBound(v, op, false) + ')'; })
             // (the old engine takes no rem in media queries, the whole query fails; there both mean the initial font
             // size: Tailwind's breakpoints are rem, so no sm:/md:/lg: style ever applied)
             .replace(/(\d*\.?\d+)rem\b/gi, '$1em')
             .replace(/\(\s*(min-|max-)?resolution\s*:\s*([\d.]+)\s*(dppx|x)\s*\)/gi, function (m, mm, n) { return '(-webkit-' + (mm || '') + 'device-pixel-ratio: ' + n + ')'; })
             .replace(/\(\s*(min-|max-)?resolution\s*:\s*([\d.]+)\s*dpi\s*\)/gi, function (m, mm, n) { return '(-webkit-' + (mm || '') + 'device-pixel-ratio: ' + (Math.round(n / 96 * 100) / 100) + ')'; })
             .replace(/\(\s*(?:any-)?hover\s*:\s*none\s*\)/gi, '(min-width: 0px)')
             .replace(/\(\s*(?:any-)?hover\s*:\s*hover\s*\)/gi, '(max-width: 0px)')
             .replace(/\(\s*(?:any-)?pointer\s*:\s*coarse\s*\)/gi, '(min-width: 0px)')
             .replace(/\(\s*(?:any-)?pointer\s*:\s*(fine|none)\s*\)/gi, '(max-width: 0px)')
             .replace(/\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/gi, '(min-width: 0px)')
             .replace(/\(\s*prefers-reduced-motion\s*(?::\s*reduce\s*)?\)/gi, '(max-width: 0px)')
             .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, '(min-width: 0px)')
             .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, '(max-width: 0px)')
             .replace(/\(\s*prefers-contrast\s*:\s*no-preference\s*\)/gi, '(min-width: 0px)')
             .replace(/\(\s*prefers-contrast\s*:\s*[a-z]+\s*\)/gi, '(max-width: 0px)')
             .replace(/\(\s*prefers-reduced-transparency\s*[^)]*\)/gi, '(max-width: 0px)')
             .replace(/\(\s*forced-colors\s*:\s*none\s*\)/gi, '(min-width: 0px)')
             .replace(/\(\s*forced-colors\s*:\s*active\s*\)/gi, '(max-width: 0px)')
             .replace(/\(\s*display-mode\s*:\s*browser\s*\)/gi, '(min-width: 0px)')
             .replace(/\(\s*display-mode\s*:\s*[a-z-]+\s*\)/gi, '(max-width: 0px)')
             .replace(/\(\s*scripting\s*:\s*enabled\s*\)/gi, '(min-width: 0px)')
             .replace(/\(\s*scripting\s*:\s*[a-z-]+\s*\)/gi, '(max-width: 0px)')
             .replace(/\(\s*update\s*:\s*fast\s*\)/gi, '(min-width: 0px)')
             .replace(/\(\s*dynamic-range\s*:\s*standard\s*\)/gi, '(min-width: 0px)')
             .replace(/\(\s*dynamic-range\s*:\s*high\s*\)/gi, '(max-width: 0px)')
             .replace(/\(\s*(min-|max-)?aspect-ratio\s*:\s*([\d.]+)\s*\/\s*([\d.]+)\s*\)/gi, '($1aspect-ratio: $2/$3)');
        // "@media screen and (max-width: 100px), ..." is fine; old WebKit also needs "and" lower case
        return q.replace(/\bAND\b/g, 'and');
    }

    var SUPPORTED_PROPS = { display: /^(block|inline|inline-block|none|flex|inline-flex|-webkit-box|-webkit-flex|table|table-cell|table-row|list-item|inline-table|-webkit-inline-box)$/i,
        position: /^(static|relative|absolute|fixed|sticky|-webkit-sticky)$/i, transform: 1, '-webkit-transform': 1, transition: 1, animation: 1, filter: 1, '-webkit-filter': 1,
        mask: 1, '-webkit-mask': 1, 'clip-path': 1, '-webkit-clip-path': 1, columns: 1, 'column-count': 1, 'box-shadow': 1, 'border-radius': 1, opacity: 1,
        'background-size': 1, 'background-clip': 1, 'box-sizing': 1, 'text-overflow': 1, 'word-break': 1, 'overflow-wrap': 1, 'pointer-events': 1,
        calc: 1, width: /calc|vw|vh|vmin|px|%|em|rem|fit-content|max-content|min-content/i, height: /calc|vw|vh|vmin|px|%|em|rem/i,
        'font-feature-settings': 1, 'user-select': 1, appearance: 1, '-webkit-appearance': 1, color: 1, 'background-color': 1, 'background-image': 1, background: 1, inset: 1,
        'margin-inline': 1, 'padding-inline': 1, 'flex-direction': 1, 'justify-content': 1, 'align-items': 1, 'flex-wrap': 0, 'flex-grow': 1, 'flex-basis': 1, flex: 1, order: 1 };

    function supportsDeclaration(decl) {
        var colon = decl.indexOf(':');
        if (colon < 0) return false;
        var p = trim(decl.slice(0, colon)).toLowerCase(), v = trim(decl.slice(colon + 1));
        if (p.charAt(0) === '-' && p.charAt(1) === '-') return true;   // custom properties: resolved statically
        if (p === 'clip-path' || p === '-webkit-clip-path') return clipPathToMask(v) !== null;   // basic shapes render as masks
        if (p.indexOf('grid') >= 0 || p === 'gap' || p === 'row-gap' || p === 'column-gap' && !/column/.test(v) || p === 'aspect-ratio' || p === 'object-fit' ||
            p === 'backdrop-filter' || p === '-webkit-backdrop-filter' ||
            p === 'overflow' && /clip/i.test(v) || p === 'display' && /grid|contents|flow-root/i.test(v) ||
            p === 'writing-mode' || p === 'anchor-name' || p === 'view-transition-name' || p === 'contain' || p === 'content-visibility' ||
            p === 'accent-color' || p === 'color-scheme' || p === 'field-sizing' || p === 'text-box-trim' || p === 'animation-timeline') return false;
        if (/oklch|oklab|lab\(|lch\(|color-mix|light-dark|hwb\(/i.test(v)) return true;   // converted statically
        if (/conic-gradient|paint\(|anchor\(|round\(|mod\(|rem\(|sin\(|cos\(/i.test(v)) return false;
        if (/^(min|max|clamp)\(/i.test(v)) return true;   // approximated
        var s = SUPPORTED_PROPS[p];
        if (s === undefined) return false;
        if (s === 1) return true;
        if (s === 0) return false;
        return s.test(v);
    }

    function evalSupports(cond) {
        cond = trim(cond);
        if (!cond) return false;
        // strip one level of outer parens when they wrap the whole condition
        while (cond.charAt(0) === '(' && matchParen(cond, 0) === cond.length - 1) cond = trim(cond.slice(1, -1));
        if (/^not\s/i.test(cond)) return !evalSupports(cond.slice(4));
        // split by top level " and " / " or "
        var terms = [], ops = [], i = 0, n = cond.length, depth = 0, start = 0;
        while (i < n) {
            var c = cond.charAt(i);
            if (c === '"' || c === "'") { i = skipString(cond, i, n); continue; }
            if (c === '(') depth++;
            else if (c === ')') depth--;
            else if (depth === 0) {
                var m = /^\s+(and|or)\s+/i.exec(cond.slice(i));
                if (m) { terms.push(cond.slice(start, i)); ops.push(m[1].toLowerCase()); i += m[0].length; start = i; continue; }
            }
            i++;
        }
        terms.push(cond.slice(start));
        if (terms.length === 1) {
            var t = trim(terms[0]);
            if (/^selector\(/i.test(t)) {
                // supported when the rewriter can turn it into something the engine parses (natively or emulated)
                var selInner = trim(t.slice(9, t.lastIndexOf(')') > 9 ? t.lastIndexOf(')') : t.length)), selOk = false, prevSuppress = g_suppressManifest;
                g_suppressManifest = true;
                try { selOk = fixSelectorList(selInner).length > 0; } catch (e) { selOk = false; }
                g_suppressManifest = prevSuppress;
                return selOk;
            }
            if (/^font-tech\(|^font-format\(/i.test(t)) return false;
            if (t.charAt(0) === '(') return evalSupports(t);
            if (/^not\s/i.test(t)) return !evalSupports(t.slice(4));
            return supportsDeclaration(t);
        }
        var result = evalSupports(terms[0]);
        for (i = 0; i < ops.length; i++) {
            var r = evalSupports(terms[i + 1]);
            result = ops[i] === 'and' ? (result && r) : (result || r);
        }
        return result;
    }

    // ------------------------------------------------------------------ rule transformation

    // Number of columns a grid container would have (0 when the rule is not a grid or the count is unclear).
    // gaps of a grid container rule: [rowGap, columnGap] as plain lengths or null
    function gridGaps(decls, ctx) {
        var row = null, col = null;
        for (var i = 0; i < decls.length; i++) {
            var p = decls[i].p, v = resolveVars(decls[i].v, null, ctx);
            if (v === null) continue;
            var lv = trim(v).toLowerCase();
            if (p === 'gap' || p === 'grid-gap') { var g = splitWS(lv); row = g[0]; col = g.length > 1 ? g[1] : g[0]; }
            else if (p === 'row-gap' || p === 'grid-row-gap') row = lv;
            else if (p === 'column-gap' || p === 'grid-column-gap') col = lv;
        }
        function simple(x) { return x && /^[\d.]+(px|rem|em|vw|vh|%)$/.test(x) && parseFloat(x) > 0 ? x : null; }
        return [simple(row), simple(col)];
    }

    function timesLength(len, n) {
        var m = /^([\d.]+)([a-z%]+)$/.exec(len);
        return m ? (Math.round(parseFloat(m[1]) * n * 100) / 100) + m[2] : null;
    }

    // Number of equal columns a grid container rule asks for (0: not a grid, or nothing to emulate; -1: a
    // container that was a multi-column grid earlier in the sheet goes back to one column, typically in a
    // media query, and the floated children must be reset). `key` identifies the rule's selector list.
    function gridColumns(decls, ctx, key) {
        var isGrid = false, tracks = null, display = null;
        for (var i = 0; i < decls.length; i++) {
            var p = decls[i].p, v = decls[i].v;
            if (p === 'display') { display = trim(v).toLowerCase(); isGrid = /^(inline-)?grid$/.test(display); }
            else if (p === 'grid-template-columns') tracks = v;
            else if (p === 'grid-template' && v.indexOf('/') >= 0) tracks = v.slice(v.lastIndexOf('/') + 1);
            else if (p === 'grid' && v.indexOf('/') >= 0 && !/auto-flow/i.test(v.slice(0, v.indexOf('/')))) tracks = v.slice(v.lastIndexOf('/') + 1);
        }
        if (!ctx.gridSels) ctx.gridSels = {};
        // per selector list: undefined = never a grid, 0 = no longer one, 1 = grid with one column, n = n floated columns
        var state = key ? ctx.gridSels[key] : undefined, known = state > 0, wasColumns = state > 1;
        if (isGrid && key) ctx.gridSels[key] = 1;
        else if (!isGrid && display !== null && known && key) { ctx.gridSels[key] = 0; return wasColumns ? -1 : 0; }   // display:block / none in a media query
        if (!isGrid && !known) return 0;
        if (!tracks) return 0;
        tracks = resolveVars(tracks, null, ctx);
        if (tracks === null) return 0;
        var t = trim(tracks).replace(/\[[^\]]*\]/g, ' ');
        if (/^(none|auto|subgrid|masonry)$/i.test(t)) return wasColumns ? -1 : 0;
        var width = ctx.viewportWidth || 768;
        var rep = /repeat\(\s*(\d+|auto-fill|auto-fit)\s*,\s*([^)]*(?:\([^)]*\))?[^)]*)\)/i.exec(t);
        var count = 0;
        if (rep) {
            var inner = splitWS(trim(rep[2])).length || 1;
            if (/^\d+$/.test(rep[1])) count = parseInt(rep[1], 10) * inner;
            else {
                var px = /minmax\(\s*([\d.]+)(px|rem|em)/i.exec(rep[2]) || /^([\d.]+)(px|rem|em)/i.exec(trim(rep[2]));
                if (!px) return 0;
                var minPx = parseFloat(px[1]) * (px[2] === 'px' ? 1 : 16);
                count = Math.max(1, Math.floor((width - 32) / Math.max(minPx, 40)));
            }
            // tracks before/after the repeat()
            var rest = t.replace(rep[0], ' ');
            count += splitWS(trim(rest)).length;
        } else {
            count = splitWS(t).length;
        }
        // 6+ explicit tracks (12-column systems) are used with spans: stacking the children beats twelve narrow columns
        var autoRepeat = rep && !/^\d+$/.test(rep[1]);
        if (count < 2 || (!autoRepeat && count >= 6)) { if (key) ctx.gridSels[key] = 1; return wasColumns ? -1 : 0; }
        count = Math.min(count, 8);
        if (key) ctx.gridSels[key] = count;
        return count;
    }

    // A grid that flows into columns (grid-auto-flow: column: a horizontal strip, usually scrolled sideways like a
    // carousel) cannot float its children into rows: they become inline blocks on one line, as wide as the column
    // tracks ask (the size in repeat(N, size), a single track, or grid-auto-columns; fr/auto sizes leave the width to
    // the content). Returns {width, gap} for a rule of such a grid (also a later rule of the same selectors, in a
    // media query), or null.
    var FLEX_TRACK = /fr\b|\bauto\b|min-content|max-content|fit-content|minmax/;
    function gridColumnFlow(decls, ctx, key) {
        var isGrid = false, flow = null, tracks = null, autoCols = null, gap = null;
        for (var i = 0; i < decls.length; i++) {
            var p = decls[i].p, v = resolveVars(decls[i].v, null, ctx);
            if (v === null) continue;
            var lv = trim(v).toLowerCase().replace(/\s+/g, ' ');
            if (p === 'display') isGrid = /^(inline-)?grid$/.test(lv);
            else if (p === 'grid-auto-flow') flow = lv;
            else if (p === 'grid-template-columns') tracks = lv;
            else if (p === 'grid-auto-columns') autoCols = lv;
            else if (p === 'gap' || p === 'grid-gap') { var g = splitWS(lv); gap = g.length > 1 ? g[1] : g[0]; }
            else if (p === 'column-gap' || p === 'grid-column-gap') gap = lv;
        }
        if (!key) return null;
        if (!ctx.gridFlow) ctx.gridFlow = {};
        if (flow !== null) ctx.gridFlow[key] = /\bcolumn\b/.test(flow);
        if (!ctx.gridFlow[key]) return null;
        var size = null;
        if (tracks) {
            var rep = /^repeat\(\s*\d+\s*,([\s\S]*)\)$/.exec(tracks);
            var one = rep ? trim(rep[1]) : (splitWS(tracks).length === 1 ? tracks : null);
            if (one && !FLEX_TRACK.test(one)) size = one;
        }
        if (!size && autoCols && splitWS(autoCols).length === 1 && !FLEX_TRACK.test(autoCols)) size = autoCols;
        return { width: size, gap: gap && /^[\d.]+(px|rem|em|vw|vh|%)$/.test(gap) && parseFloat(gap) > 0 ? gap : null, grid: isGrid || flow !== null };
    }

    // A fixed row height a grid container rule asks for ("grid-auto-rows: 100px", "minmax(6rem, auto)", "repeat(3, 100px)"),
    // or null. Only rules that are (or were) grid containers count.
    function gridRowHeight(decls, ctx, key) {
        var isGrid = false, rows = null;
        for (var i = 0; i < decls.length; i++) {
            var p = decls[i].p, v = decls[i].v;
            if (p === 'display' && /^(inline-)?grid$/i.test(trim(v))) isGrid = true;
            else if (p === 'grid-auto-rows' || p === 'grid-template-rows') rows = v;
            else if (p === 'grid-template' && v.indexOf('/') >= 0) rows = v.slice(0, v.indexOf('/'));
        }
        if (!rows || (!isGrid && !(ctx.gridSels && ctx.gridSels[key] > 0))) return null;
        rows = resolveVars(rows, null, ctx);
        if (rows === null) return null;
        var t = trim(trim(rows).toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' '));
        var LEN = '([\\d.]+(?:px|rem|em|vh|vw))';
        // one track, repeat(N, track) or minmax(track, ...) forms; a list of different tracks is not one row height
        var m = new RegExp('^' + LEN + '$').exec(t) ||
                new RegExp('^repeat\\( ?(?:\\d+|auto-fill|auto-fit) ?, ?' + LEN + ' ?\\)$').exec(t) ||
                new RegExp('^minmax\\( ?' + LEN + ' ?,[^)]*\\)$').exec(t) ||
                new RegExp('^repeat\\( ?(?:\\d+|auto-fill|auto-fit) ?, ?minmax\\( ?' + LEN + ' ?,[^)]*\\) ?\\)$').exec(t);
        return m ? m[1] : null;
    }

    // margin-trim of a rule as the physical sides to trim (horizontal writing), or null
    function marginTrimSides(decls, ctx) {
        var v = null;
        for (var i = 0; i < decls.length; i++) if (decls[i].p === 'margin-trim') v = resolveVars(decls[i].v, null, ctx);
        if (v === null) return null;
        var toks = splitWS(trim(v).toLowerCase()), s = { top: false, bottom: false, left: false, right: false }, any = false;
        for (var k = 0; k < toks.length; k++) {
            var t = toks[k];
            if (t === 'block' || t === 'block-start') { s.top = any = true; }
            if (t === 'block' || t === 'block-end') { s.bottom = any = true; }
            if (t === 'inline' || t === 'inline-start') { s.left = any = true; }
            if (t === 'inline' || t === 'inline-end') { s.right = any = true; }
        }
        return any ? s : null;
    }

    // the classes of a selector's subject, its last compound: ".navbar-expand-lg .navbar-nav" -> ["navbar-nav"]
    function subjectClasses(sel) {
        var s = trim(sel), depth = 0, start = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            if (c === '(' || c === '[') depth++;
            else if (c === ')' || c === ']') depth--;
            else if (!depth && (c === ' ' || c === '>' || c === '+' || c === '~')) start = i + 1;
        }
        var last = s.slice(start).replace(/:(not|-webkit-any)\([^)]*\)/g, ''), out = [], re = /\.([\w-]+)/g, m;
        while ((m = re.exec(last)) !== null) out.push(m[1]);
        return out;
    }
    // Whether a column flex container rule gives it a height of its own: a length of height (not a percentage, that of
    // a parent often without one), or fixed / absolute between its top and bottom. Such a column stays a vertical box:
    // its items that grow share that height (TikTok's page, position: fixed; top: 0; bottom: 0 around a flex: 1 player,
    // was 0 px high as a block and showed no video); one only as high as its content stays a block (see columnFlex).
    var OWN_HEIGHT = /^-?[\d.]+(px|vh|dvh|svh|lvh|vmin|vmax|em|rem)$|^(-webkit-)?calc\([^%]*\)$/;
    function columnHasOwnHeight(decls) {
        var height = false, fixed = false, top = false, bottom = false, inset = false;
        for (var i = 0; i < decls.length; i++) {
            var p = decls[i].p, v = trim(String(decls[i].v)).toLowerCase();
            if (p === 'height' || p === 'block-size') height = OWN_HEIGHT.test(v) && !/^0(px)?$/.test(v);
            else if (p === 'position') fixed = v === 'fixed' || v === 'absolute';
            else if (p === 'top' || p === 'inset-block-start') top = v !== 'auto';
            else if (p === 'bottom' || p === 'inset-block-end') bottom = v !== 'auto';
            else if (p === 'inset' || p === 'inset-block') inset = v !== 'auto';
        }
        return height || (fixed && (inset || (top && bottom)));
    }
    function rememberColumnFlex(ctx, inline) {
        if (!ctx.curSels) return;
        if (!ctx.colFlex) ctx.colFlex = {};
        for (var i = 0; i < ctx.curSels.length; i++) {
            var cls = subjectClasses(ctx.curSels[i]);
            for (var k = 0; k < cls.length; k++) ctx.colFlex[cls[k]] = inline ? '-webkit-inline-box' : '-webkit-box';
        }
    }
    // the box display for a rule that turns a remembered column flex container into a row, or null
    function columnFlexDisplay(ctx) {
        if (!ctx.colFlex || !ctx.curSels) return null;
        for (var i = 0; i < ctx.curSels.length; i++) {
            var cls = subjectClasses(ctx.curSels[i]);
            for (var k = 0; k < cls.length; k++) if (ctx.colFlex.hasOwnProperty(cls[k])) return ctx.colFlex[cls[k]];
        }
        return null;
    }

    // What a flex container rule asks for that the 2009 box model cannot do by itself: wrapping and gaps.
    // the align-self a rule gives (place-self: its first value), or null
    function alignSelfOf(decls, ctx) {
        var out = null;
        for (var i = 0; i < decls.length; i++) {
            if (decls[i].p !== 'align-self' && decls[i].p !== 'place-self') continue;
            var v = resolveVars(decls[i].v, null, ctx);
            if (v === null) continue;
            var lv = trim(v).toLowerCase().replace(/^(safe|unsafe)\s+/, '');
            if (decls[i].p === 'place-self') lv = alignKeyword(lv);
            if (/^(auto|normal|stretch|center|start|end|flex-start|flex-end|self-start|self-end|left|right|baseline|first baseline|last baseline|anchor-center)$/.test(lv)) out = lv;
        }
        return out;
    }

    // ---- Flex items are blocks: current engines make every child of a flex container a block-level box (an inline
    // one becomes a block, an inline-block a block, an inline-flex a flex box). The old engine's boxes take a run of
    // inline children as one item that lays them out as a line of text (spans in a column stood side by side, a row's
    // space-between did not spread its links). The shim marks the children of flex containers (data-br-bf, see
    // markFlexItems in shims-extra.js); every rule that sets a display gets a twin for marked elements with the display
    // made block-level, right after it, so that among the twins the page's cascade decides as it did (a hidden item
    // stays hidden). Elements whose display no rule sets get theirs from the shim's rules, ahead of the page's.
    var BLOCKIFY = { inline: 'block', 'inline-block': 'block', 'run-in': 'block', 'inline-table': 'table', '-webkit-inline-box': '-webkit-box',
        'inline-flex': '-webkit-box', 'inline-grid': 'block', 'inline-list-item': 'list-item', initial: 'block' };
    var PSEUDO_ELEMENT = /::|:(before|after|first-line|first-letter)\b/i;
    function blockifiedTwin(sels, decls) {
        var disp = null;
        for (var i = 0; i < decls.length; i++) if (decls[i].p === 'display') disp = decls[i];
        if (!disp) return null;
        var twin = [];
        for (var k = 0; k < sels.length; k++) if (!PSEUDO_ELEMENT.test(sels[k])) twin.push(sels[k] + '[data-br-bf]');
        if (!twin.length) return null;
        var lv = trim(disp.v).toLowerCase();
        return { t: 'q', sel: twin.join(','), decls: [{ p: 'display', v: BLOCKIFY.hasOwnProperty(lv) ? BLOCKIFY[lv] : disp.v, imp: disp.imp }] };
    }

    function flexContainerInfo(decls, ctx) {
        var info = { flex: false, wrap: false, column: false, rowGap: null, colGap: null, justify: null };
        for (var i = 0; i < decls.length; i++) {
            var p = decls[i].p, v = resolveVars(decls[i].v, null, ctx);
            if (v === null) continue;
            var lv = trim(v).toLowerCase();
            if (p === 'display' && /^(inline-)?flex$/.test(lv)) info.flex = true;
            else if ((p === 'flex-wrap' || p === 'flex-flow') && /wrap/.test(lv) && !/nowrap/.test(lv)) info.wrap = true;
            else if ((p === 'flex-direction' || p === 'flex-flow') && /column/.test(lv)) info.column = true;
            else if (p === 'gap') { var g = splitWS(lv); info.rowGap = g[0]; info.colGap = g.length > 1 ? g[1] : g[0]; }
            else if (p === 'row-gap') info.rowGap = lv;
            else if (p === 'column-gap') info.colGap = lv;
            else if (p === 'justify-content') info.justify = lv;
        }
        if (info.rowGap === '0' || info.rowGap === '0px' || info.rowGap === 'normal') info.rowGap = null;
        if (info.colGap === '0' || info.colGap === '0px' || info.colGap === 'normal') info.colGap = null;
        return info;
    }

    function halfLength(v) {
        var m = /^([\d.]+)([a-z%]*)$/i.exec(v);
        return m ? (Math.round(parseFloat(m[1]) * 50) / 100) + m[2] : v;
    }

    // whether the keyframes of an animation use viewport units (see VP_UNIT_RE)
    function keyframesUseViewport(rules) {
        for (var i = 0; i < rules.length; i++) {
            var ds = rules[i].decls;
            if (ds) for (var k = 0; k < ds.length; k++) if (hasViewportUnits(ds[k].v)) return true;
        }
        return false;
    }
    // "screen and (min-width: 600px)" + "(orientation: portrait)" -> one query list meaning both (null: never true)
    function joinMedia(outer, inner) {
        var a = splitTop(outer, ','), b = splitTop(inner, ','), out = [];
        for (var i = 0; i < a.length; i++) for (var k = 0; k < b.length; k++) {
            var q = joinQuery(trim(a[i]), trim(b[k]));
            if (q) out.push(q);
        }
        return out.length ? out.join(', ') : null;
    }
    function joinQuery(a, b) {
        var pa = queryParts(a), pb = queryParts(b);
        if (!pa || !pb) return null;
        if (pa.type && pb.type && pa.type !== pb.type) return null;
        var type = pa.type || pb.type, rest = pa.rest.concat(pb.rest);
        return (type ? type + (rest.length ? ' and ' : '') : '') + rest.join(' and ');
    }
    // {type, rest: [features]} of one media query ("all" counts as no type); null for "not ..." queries
    function queryParts(q) {
        var lq = q.toLowerCase();
        if (/^not\b/.test(lq)) return null;
        q = q.replace(/^only\s+/i, '');
        var type = '', m = /^([a-z-]+)\s*(?:\band\b\s*)?/i.exec(q);
        if (m && q.charAt(0) !== '(') { type = m[1].toLowerCase(); q = q.slice(m[0].length); }
        if (type === 'all') type = '';
        var rest = [], parts = trim(q) ? splitTop(q, ' ') : [], cur = '';
        for (var i = 0; i < parts.length; i++) {
            var p = trim(parts[i]);
            if (!p) continue;
            if (p.toLowerCase() === 'and') { if (cur) rest.push(cur); cur = ''; }
            else cur = cur ? cur + ' ' + p : p;
        }
        if (cur) rest.push(cur);
        return { type: type, rest: rest };
    }

    function transformRules(rules, ctx, keyframe) {
        var out = [];
        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            if (r.t === 'q') {
                var sels = keyframe ? [r.sel] : (r.fixedSels || fixSelectorList(r.sel));   // (rules made here have theirs)
                if (!sels.length) continue;
                var prevSels = ctx.curSels, prevCond = ctx.condRules, prevDefs = ctx.cvDefs, prevUses = ctx.cvUses, prevVp = ctx.vpDecls;
                ctx.curSels = keyframe ? null : sels;
                ctx.condRules = keyframe ? null : [];
                ctx.cvDefs = ctx.rt && !keyframe ? [] : null;
                ctx.cvUses = ctx.rt && !keyframe ? [] : null;
                ctx.vpDecls = keyframe || ctx.vpPass ? null : [];
                ctx.rowWrapRule = false;
                ctx.tableFit = null;
                var decls = fixDeclarations(r.decls, ctx, keyframe);
                var rowWrap = ctx.rowWrapRule;   // (a remembered column flex container turned into a wrapping row)
                ctx.rowWrapRule = false;
                if (ctx.tableFit) {
                    // (the shrink-to-fit table at the top of the stylesheet, inside the same media queries)
                    var head = { t: 'q', sel: sels.join(','), decls: ctx.tableFit }, hm = ctx.mediaStack || [], hmq = hm.length ? hm[0] : null;
                    for (var hi = 1; hi < hm.length && hmq; hi++) hmq = joinMedia(hmq, hm[hi]);
                    if (hm.length) head = hmq ? { t: 'at', name: 'media', prelude: hmq, rules: [head], decls: null, raw: null } : null;
                    if (head) ctx.headRules.push(head);
                    ctx.tableFit = null;
                }
                if (ctx.cvDefs && (ctx.cvDefs.length || ctx.cvUses.length)) registerVarRule(ctx, sels, ctx.cvDefs, ctx.cvUses);
                ctx.cvDefs = prevDefs;
                ctx.cvUses = prevUses;
                var condRules = ctx.condRules, vpDecls = ctx.vpDecls;
                ctx.condRules = null;
                ctx.vpDecls = prevVp;
                if (vpDecls && vpDecls.length) {
                    // viewport units: the declarations again per orientation, in the page's layout viewport pixels
                    condRules.push({ m: '(orientation: portrait)', decls: vpDecls, vp: layoutViewport(g_vpPortrait, ctx.layoutWidth) },
                                   { m: '(orientation: landscape)', decls: vpDecls, vp: layoutViewport(g_vpLandscape, ctx.layoutWidth) });
                }
                if (condRules && condRules.length) {
                    // if() media branches and orientation rules: the same selectors inside @media, after the rule
                    for (var ci = 0; ci < condRules.length; ci++) {
                        var cr0 = condRules[ci];
                        if (!ctx.mediaStack) ctx.mediaStack = [];
                        ctx.mediaStack.push(cr0.m);
                        var vpBefore = ctx.vpPass;
                        if (cr0.vp) { ctx.vpPass = true; setViewportPass(cr0.vp); }
                        var cdecls = fixDeclarations(cr0.decls || [{ p: cr0.p, v: cr0.v, imp: cr0.imp }], ctx, false);
                        if (cr0.vp) { ctx.vpPass = vpBefore; setViewportPass(ctx.vpCurrent || g_vpCurrent); }
                        ctx.mediaStack.pop();
                        if (cdecls.length) condRules[ci] = { t: 'at', name: 'media', prelude: cr0.m, rules: [{ t: 'q', sel: sels.join(','), decls: cdecls }], decls: null, raw: null };
                        else condRules[ci] = null;
                    }
                }
                ctx.curSels = prevSels;
                ctx.condRules = prevCond;
                if (!decls.length && !(condRules && condRules.length)) continue;
                if (decls.length) {
                    out.push({ t: 'q', sel: sels.join(','), decls: decls });
                    var twin = keyframe ? null : blockifiedTwin(sels, decls);   // (flex items are blocks, see BLOCKIFY)
                    if (twin) out.push(twin);
                }
                if (condRules) for (var cj = 0; cj < condRules.length; cj++) if (condRules[cj]) out.push(condRules[cj]);
                if (!keyframe) {
                    // margin-trim: the margins of the first / last child at the container's edges become zero
                    var mt = marginTrimSides(r.decls, ctx);
                    if (mt) {
                        var mtFirst = [], mtLast = [], mtFd = [], mtLd = [];
                        for (var mts = 0; mts < sels.length; mts++) { mtFirst.push(sels[mts] + ' > :first-child'); mtLast.push(sels[mts] + ' > :last-child'); }
                        if (mt.top) mtFd.push({ p: 'margin-top', v: '0', imp: true });
                        if (mt.left) mtFd.push({ p: 'margin-left', v: '0', imp: true });
                        if (mt.bottom) mtLd.push({ p: 'margin-bottom', v: '0', imp: true });
                        if (mt.right) mtLd.push({ p: 'margin-right', v: '0', imp: true });
                        if (mtFd.length) out.push({ t: 'q', sel: mtFirst.join(','), decls: mtFd });
                        if (mtLd.length) out.push({ t: 'q', sel: mtLast.join(','), decls: mtLd });
                    }
                    var fi = flexContainerInfo(r.decls, ctx);
                    if (rowWrap) { fi.flex = true; fi.wrap = true; fi.column = false; }
                    // (the flex containers, whose children the shim marks as items: fx 2 for a column that stays a block)
                    if (fi.flex && !fi.wrap && g_manifest !== false) manifestAdd('mk', { h: manifestHash('mk|fx|' + sels.join(',')), s: sels.join(','), fx: fi.column && !columnHasOwnHeight(r.decls) ? 2 : 1 });
                    // (align-self: the old boxes align all their children alike; the shim aligns the items that differ, with
                    // the rule's specificity and media queries to find the winner, see alignFlexItems in shims-extra.js)
                    var asv = alignSelfOf(r.decls, ctx);
                    if (asv && g_manifest !== false) {
                        var asMedia = ctx.mediaStack && ctx.mediaStack.length ? ctx.mediaStack.slice(0) : null, asSp = [];
                        for (var ak = 0; ak < sels.length; ak++) asSp.push(specificity(sels[ak]));
                        var asEntry = { h: manifestHash('mk|as|' + sels.join(',') + '|' + asv + '|' + (asMedia ? asMedia.join('&') : '')), s: sels.join(','), sl: sels, sp: asSp, as: asv };
                        if (asMedia) asEntry.m = asMedia;
                        manifestAdd('mk', asEntry);
                    }
                    if (fi.flex) {
                        var childSel = [], gapSel = [], gs;
                        for (gs = 0; gs < sels.length; gs++) { childSel.push(sels[gs] + ' > *'); gapSel.push(sels[gs] + ' > * + *'); }
                        if (fi.wrap && !fi.column) {
                            // wrapping rows: inline-blocks wrap like flex items sized by their content; justify-content becomes text-align
                            var wrapDecls = [{ p: 'display', v: 'inline-block', imp: false }, { p: 'vertical-align', v: 'top', imp: false }];
                            if (fi.rowGap || fi.colGap) wrapDecls.push({ p: 'margin', v: halfLength(fi.rowGap || '0') + ' ' + halfLength(fi.colGap || '0'), imp: false });
                            out.push({ t: 'q', sel: childSel.join(','), decls: wrapDecls });
                            var ta = fi.justify === 'center' ? 'center' : (fi.justify === 'flex-end' || fi.justify === 'end' || fi.justify === 'right') ? 'right' :
                                     (fi.justify === 'space-between' || fi.justify === 'space-around' || fi.justify === 'space-evenly') ? 'justify' : null;
                            if (ta) out.push({ t: 'q', sel: sels.join(','), decls: [{ p: 'text-align', v: ta, imp: false }] });
                        } else if (fi.column && fi.rowGap) {
                            out.push({ t: 'q', sel: gapSel.join(','), decls: [{ p: 'margin-top', v: fi.rowGap, imp: false }] });
                        } else if (!fi.column && fi.colGap) {
                            out.push({ t: 'q', sel: gapSel.join(','), decls: [{ p: 'margin-left', v: fi.colGap, imp: false }] });
                        }
                    }
                    var gridKey = sels.join(',');
                    if (g_manifest !== false && !keyframe) registerGridRule(ctx, sels, r.decls, gridKey);
                    var flowGrid = gridColumnFlow(r.decls, ctx, gridKey);
                    if (flowGrid) {
                        // one line of inline blocks (the strip scrolls sideways when the container says so)
                        var flowChild = [], flowLast = [];
                        for (var fs = 0; fs < sels.length; fs++) { flowChild.push(sels[fs] + ' > *'); flowLast.push(sels[fs] + ' > :last-child'); }
                        if (flowGrid.grid) out.push({ t: 'q', sel: sels.join(','), decls: [{ p: 'white-space', v: 'nowrap', imp: false }] });
                        var flowDecls = flowGrid.grid ? [{ p: 'display', v: 'inline-block', imp: false }, { p: 'vertical-align', v: 'top', imp: false }, { p: 'white-space', v: 'normal', imp: false }] : [];
                        if (flowGrid.width) flowDecls.push({ p: 'width', v: flowGrid.width, imp: false });
                        if (flowGrid.gap) flowDecls.push({ p: 'margin-right', v: flowGrid.gap, imp: false });
                        if (flowDecls.length) {
                            // (through the declaration pipeline: widths in vw and max()/calc() become pixels per orientation)
                            var flowOut = transformRules([{ t: 'q', sel: flowChild.join(','), fixedSels: flowChild, decls: flowDecls }], ctx, false);
                            for (var fo = 0; fo < flowOut.length; fo++) out.push(flowOut[fo]);
                        }
                        if (flowGrid.gap) out.push({ t: 'q', sel: flowLast.join(','), decls: [{ p: 'margin-right', v: '0', imp: false }] });
                        continue;
                    }
                    var columns = gridColumns(r.decls, ctx, gridKey);
                    var rowHeight = gridRowHeight(r.decls, ctx, gridKey);
                    // (the stand-in stops where the page shim has laid the grid out: it marks the container br-grid)
                    var gridOff = function (s) { return s + ':not(.br-grid)'; };
                    if (rowHeight) {
                        // fixed row tracks (grid-auto-rows: 120px, minmax(120px, auto), repeat(3, 8rem)): the children get that minimum height
                        var rowSels = [];
                        for (var rh = 0; rh < sels.length; rh++) rowSels.push(gridOff(sels[rh]) + ' > *');
                        out.push({ t: 'q', sel: rowSels.join(','), decls: [{ p: 'min-height', v: rowHeight, imp: false }] });
                    }
                    if (columns === -1) {
                        // the same container goes back to a single column (a media query): the floats are undone
                        var resetSels = [];
                        for (var rs = 0; rs < sels.length; rs++) resetSels.push(gridOff(sels[rs]) + ' > *');
                        out.push({ t: 'q', sel: resetSels.join(','), decls: [{ p: 'float', v: 'none', imp: false }, { p: 'width', v: 'auto', imp: false }, { p: 'margin-right', v: '0', imp: false }] });
                    } else if (columns > 1) {
                        // CSS grid does not exist here: the children float into equal columns instead of piling up;
                        // a column gap is taken out of the widths, a row gap becomes a bottom margin
                        var childSels = [], afterSels = [], lastSels = [];
                        for (var gs = 0; gs < sels.length; gs++) { childSels.push(gridOff(sels[gs]) + ' > *'); afterSels.push(gridOff(sels[gs]) + '::after'); lastSels.push(gridOff(sels[gs]) + ' > *:nth-child(' + columns + 'n)'); }
                        var gaps = gridGaps(r.decls, ctx), colGap = gaps[1], rowGap = gaps[0];
                        var pct = (Math.floor(10000 / columns) / 100) + '%';
                        var childDecls = [{ p: 'float', v: 'left', imp: false }];
                        var total = colGap ? timesLength(colGap, columns - 1) : null;
                        if (total) childDecls.push({ p: 'width', v: '-webkit-calc((100% - ' + total + ') / ' + columns + ')', imp: false });
                        else childDecls.push({ p: 'width', v: pct, imp: false });
                        childDecls.push({ p: '-webkit-box-sizing', v: 'border-box', imp: false }, { p: 'box-sizing', v: 'border-box', imp: false }, { p: 'min-width', v: '0', imp: false });
                        if (total) childDecls.push({ p: 'margin-right', v: colGap, imp: false });
                        if (rowGap) childDecls.push({ p: 'margin-bottom', v: rowGap, imp: false });
                        out.push({ t: 'q', sel: childSels.join(','), decls: childDecls });
                        if (total) out.push({ t: 'q', sel: lastSels.join(','), decls: [{ p: 'margin-right', v: '0', imp: false }] });
                        out.push({ t: 'q', sel: afterSels.join(','), decls: [{ p: 'content', v: '""', imp: false }, { p: 'display', v: 'block', imp: false }, { p: 'clear', v: 'both', imp: false }] });
                    }
                }
                continue;
            }
            if (r.t !== 'at') continue;
            var name = r.name, k, sub;
            if (name === 'media') {
                if (!r.rules) continue;
                var fixedMedia = fixMedia(r.prelude);
                if (!ctx.mediaStack) ctx.mediaStack = [];
                ctx.mediaStack.push(fixedMedia);   // deferred values remember the media queries around them
                sub = transformRules(r.rules, ctx, keyframe);
                ctx.mediaStack.pop();
                // the old engine ignores @media inside @media (nesting, if() branches, orientation rules): an inner
                // block goes out on its own with both queries joined, the rules around it keep their order
                var seg = [];
                for (k = 0; k < sub.length; k++) {
                    var sr = sub[k];
                    if (sr.t === 'at' && sr.name === 'media' && sr.rules) {
                        if (seg.length) { out.push({ t: 'at', name: 'media', prelude: fixedMedia, rules: seg, decls: null, raw: null }); seg = []; }
                        var joined = joinMedia(fixedMedia, sr.prelude);
                        if (joined) out.push({ t: 'at', name: 'media', prelude: joined, rules: sr.rules, decls: null, raw: null });
                    } else seg.push(sr);
                }
                if (seg.length) out.push({ t: 'at', name: 'media', prelude: fixedMedia, rules: seg, decls: null, raw: null });
            } else if (name === 'position-try') {
                // "@position-try --name { top: anchor(bottom); ... }": the declarations go to the manifest for
                // position-try-fallbacks; the engine gets nothing
                var ptName = trim(r.prelude);
                if (/^--[\w-]+$/.test(ptName) && r.decls && g_manifest !== false) {
                    var ptDecls = [];
                    for (k = 0; k < r.decls.length; k++) {
                        var ptv = resolveVars(r.decls[k].v, null, ctx);
                        if (ptv !== null) ptDecls.push([r.decls[k].p, ptv]);
                    }
                    manifestAdd('pt', { h: manifestHash('pt|' + ptName + '|' + JSON.stringify(ptDecls)), n: ptName, d: ptDecls });
                }
            } else if (name === 'supports') {
                if (r.rules && evalSupports(r.prelude)) {
                    sub = transformRules(r.rules, ctx, keyframe);
                    for (k = 0; k < sub.length; k++) out.push(sub[k]);
                }
            } else if (name === 'layer' || name === 'scope') {
                if (r.rules) {
                    sub = transformRules(r.rules, ctx, keyframe);
                    for (k = 0; k < sub.length; k++) out.push(sub[k]);
                }
            } else if (name === 'container') {
                // "@container [name] (cond) { rules }": the rules become descendants of ".br-cq-<hash>", a class the
                // page shim puts on container elements (marked by container-type) whose size satisfies the condition
                if (r.rules && g_manifest !== false) {
                    var cqm = /^([a-zA-Z_][\w-]*)?\s*([\s\S]*)$/.exec(trim(r.prelude));
                    var cqName = cqm && cqm[1] && !/^(not|and|or)$/i.test(cqm[1]) ? cqm[1] : '', cqCond = cqm ? trim(cqm[1] && cqName ? cqm[2] : r.prelude) : r.prelude;
                    var cqh = manifestHash(cqName + '|' + cqCond);
                    manifestAdd('cq', { h: cqh, name: cqName, cond: cqCond });
                    sub = transformRules(r.rules, ctx, keyframe);
                    prefixRules(sub, '.br-cq-' + cqh + ' ');
                    for (k = 0; k < sub.length; k++) out.push(sub[k]);
                }
            } else if (name === 'keyframes' || name === '-webkit-keyframes') {
                if (!r.rules) continue;
                if (!ctx.vpPass && keyframesUseViewport(r.rules)) {
                    // viewport units: one copy of the animation per orientation (the engine takes @keyframes in @media)
                    var orients = [['(orientation: portrait)', g_vpPortrait], ['(orientation: landscape)', g_vpLandscape]];
                    for (var oi = 0; oi < orients.length; oi++) {
                        setViewportPass(layoutViewport(orients[oi][1], ctx.layoutWidth));
                        sub = transformRules(r.rules, ctx, true);
                        out.push({ t: 'at', name: 'media', prelude: orients[oi][0], decls: null, raw: null,
                                   rules: [{ t: 'at', name: '-webkit-keyframes', prelude: r.prelude, rules: sub, decls: null, raw: null }] });
                    }
                    setViewportPass(ctx.vpCurrent || g_vpCurrent);
                    continue;
                }
                sub = transformRules(r.rules, ctx, true);
                out.push({ t: 'at', name: '-webkit-keyframes', prelude: r.prelude, rules: sub, decls: null, raw: null });
            } else if (name === 'font-face') {
                var fd = fixDeclarations(r.decls || [], ctx, false);
                for (k = 0; k < fd.length; k++) {
                    if (fd[k].p === 'src') {
                        // WOFF2 files are converted to TrueType by the network layer, so tell the engine to try them
                        fd[k].v = fd[k].v.replace(/format\(\s*(["']?)woff2(?:-variations)?\1\s*\)/gi, 'format("truetype")')
                                         .replace(/\s*tech\([^)]*\)/gi, '');
                    }
                }
                out.push({ t: 'at', name: name, prelude: r.prelude, rules: null, decls: fd, raw: null });
            } else if (name === 'page') {
                out.push({ t: 'at', name: name, prelude: r.prelude, rules: null, decls: r.decls || [], raw: null });
            } else if (name === 'import') {
                var pre = r.prelude.replace(/\s+layer(\([^)]*\))?/i, '').replace(/\s+supports\([^)]*\)/i, '');
                out.push({ t: 'at', name: name, prelude: pre, rules: null, decls: null, raw: null });
            } else if (name === 'charset' || name === 'namespace') {
                out.push({ t: 'at', name: name, prelude: r.prelude, rules: null, decls: null, raw: null });
            }
            // container, property, counter-style, document, starting-style, font-feature-values and unknown ones are dropped
        }
        return out;
    }

    // every style rule (also inside nested at-rules) gets `prefix` before each of its selectors
    function prefixRules(rules, prefix) {
        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            if (r.t === 'q') {
                var parts = splitTop(r.sel, ','), sels = [];
                for (var k = 0; k < parts.length; k++) sels.push(prefix + trim(parts[k]));
                r.sel = sels.join(',');
            } else if (r.t === 'at' && r.rules && r.name !== '-webkit-keyframes' && r.name !== 'keyframes') prefixRules(r.rules, prefix);
        }
    }

    function makeContext(pageVars) {
        var page = {}, pageScoped = null, pageCalc = null, pageTrans = null, pageLayoutWidth = 0;
        if (pageVars) {
            if (typeof pageVars === 'string') { try { pageVars = JSON.parse(pageVars); } catch (e) { pageVars = null; } }
            if (pageVars && typeof pageVars === 'object') {
                for (var k in pageVars) {
                    if (!pageVars.hasOwnProperty(k)) continue;
                    if (k === ' scoped') {
                        // the page's scoped custom properties found in earlier documents (space separated)
                        var names = String(pageVars[k]).split(/\s+/);
                        for (var n = 0; n < names.length; n++) if (names[n]) { if (!pageScoped) pageScoped = {}; pageScoped[names[n]] = true; }
                    } else if (k === ' calc' || k === ' trans') {
                        // properties that got -webkit-calc values / are transitioned in earlier documents (see
                        // guardCalcTransitions)
                        var props = String(pageVars[k]).split(/\s+/), set = null;
                        for (var c = 0; c < props.length; c++) if (props[c]) { if (!set) set = {}; set[props[c]] = true; }
                        if (k === ' calc') pageCalc = set; else pageTrans = set;
                    } else if (k === ' vpw') {
                        // the layout width of the page (its HTML's viewport meta tag, see metaLayoutWidth)
                        pageLayoutWidth = parseInt(pageVars[k], 10) || 0;
                    } else page[k] = pageVars[k];
                }
            }
        }
        return { page: page, root: {}, other: {}, initial: {}, pageScoped: pageScoped, pageCalc: pageCalc, pageTrans: pageTrans, pageLayoutWidth: pageLayoutWidth };
    }
    // {"calc":"...","trans":"..."}: the crash-prone calc properties and the transitioned ones this document has itself
    // (not the page's earlier ones), or null
    function pageState(ctx) {
        var st = {}, any = false, k, list;
        if (ctx.docCalc) { list = []; for (k in ctx.docCalc) if (ctx.docCalc.hasOwnProperty(k)) list.push(k); if (list.length) { st.calc = list.sort().join(' '); any = true; } }
        if (ctx.docTrans) { list = []; for (k in ctx.docTrans) if (ctx.docTrans.hasOwnProperty(k)) list.push(k); if (list.length) { st.trans = list.sort().join(' '); any = true; } }
        return any ? JSON.stringify(st) : null;
    }

    function fixCSS(text, ctx) {
        var clean = stripComments(text);
        var rules = [];
        parseRules(clean, 0, clean.length, rules);
        rules = flattenNesting(rules);
        collectVars(rules, ctx, false);
        prepareRuntimeVars(ctx);
        // (rules for the top of the stylesheet: see the width case of fixDeclarations)
        var prevHead = ctx.headRules;
        ctx.headRules = [];
        var body = transformRules(rules, ctx, false), head = ctx.headRules;
        ctx.headRules = prevHead;
        return serializeRules(head.length ? head.concat(body) : body);
    }

    function fixInlineStyle(text, ctx) {
        var decls = parseDecls(stripComments(text));
        var prevSels = ctx.curSels, prevMedia = ctx.mediaStack;
        ctx.curSels = null;   // deferred values of a style attribute are found through their marker
        ctx.mediaStack = null;
        ctx.inlineStyle = true;
        ctx.inlineUses = [];
        var out = serializeDecls(fixDeclarations(decls, ctx, false));
        ctx.inlineStyle = false;
        ctx.curSels = prevSels;
        ctx.mediaStack = prevMedia;
        return out;
    }

    // ------------------------------------------------------------------ scripts inside HTML

    // hash -> [inline script, its lowered text]. Every site's documents share it and the hash is a quick one, which a page
    // could match with a script of its own: an entry counts only for the very same text.
    var scriptCache = {}, scriptCacheSize = 0;

    function hashString(s) {
        var h = 2166136261, i = 0, n = s.length;
        for (; i < n; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
        return h.toString(36) + ':' + n;
    }

    function isJavaScriptType(type) {
        if (!type) return true;
        type = trim(type).toLowerCase();
        return type === '' || type === 'text/javascript' || type === 'application/javascript' || type === 'text/ecmascript' ||
               type === 'application/ecmascript' || type === 'text/jscript' || type === 'application/x-javascript' || type === 'module';
    }

    // an inline script in ES2015+ syntax lowered by jsfix.js (loaded into the same context by the app); null: unchanged
    // what a script costs the parser: a string literal counts as two characters (an inline script may carry a lot of
    // markup in strings: Google's deferred search results, 800 KB, lower in about a second on the iPad)
    function codeWeight(code) {
        var weight = 0, n = code.length, i = 0, c, q;
        while (i < n) {
            c = code.charCodeAt(i);
            if (c === 34 || c === 39) {
                q = c;
                i++;
                while (i < n) { c = code.charCodeAt(i); if (c === 92) { i += 2; continue; } i++; if (c === q || c === 10) break; }
                weight += 2;
                continue;
            }
            weight++;
            i++;
        }
        return weight;
    }

    function tooBigInline(code) {
        return code.length > 600000 && (code.length > 4000000 || codeWeight(code) > 400000);
    }

    // the inline scripts of this document set aside for the app ([name, text], see fixScripts); null: kept inline
    var g_external = null;
    // a script's directive prologue ("use strict"; and the like, with the comments and spaces around): code added in front
    // of a script goes after it (a directive left to automatic semicolon insertion is not seen: minified scripts end
    // theirs with a semicolon)
    var DIRECTIVES = /^(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:(["'])(?:[^"'\\\n]|\\.)*?\1\s*;(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*)*/;

    // a file name for a script's text: two 32-bit hashes and the length (the app names the file and the document's
    // reference to it again, by a SHA-256 of the text: see BRCSSRewriter rewrittenData)
    function scriptName(s) {
        var a = 2166136261, b = 5381, i = 0, n = s.length, c;
        for (; i < n; i++) {
            c = s.charCodeAt(i);
            a ^= c; a = (a * 16777619) >>> 0;
            b = ((b * 33) ^ c) >>> 0;
        }
        return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8) + '-' + n.toString(16);
    }

    function transpileInline(code) {
        if (typeof JSFix === 'undefined' || !code || !/[^\s]/.test(code)) return null;
        if (tooBigInline(code)) return null;
        var key = hashString(code), hit = scriptCache.hasOwnProperty(key) ? scriptCache[key] : null;
        if (hit && hit[0] === code) return hit[1];
        var out = null;
        try { out = JSFix.run(code, '{}'); } catch (e) { out = null; }
        if (out === '') out = null;   // already ES5 (or not lowerable)
        if (scriptCacheSize > 2000000) { scriptCache = {}; scriptCacheSize = 0; }
        scriptCache[key] = [code, out];
        scriptCacheSize += code.length + (out || '').length;
        return out;
    }

    // the value of an attribute, attribute by attribute: data-type="gh" is not a type (eBay's inline scripts with ?. were
    // taken for a script type of their own and not lowered: "Unexpected token '.'"), nor is type=... inside a value
    var ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    function attrValue(attrs, name) {
        var m;
        ATTR.lastIndex = 0;
        while ((m = ATTR.exec(attrs)) !== null) {
            if (m[1].toLowerCase() === name) return m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
        }
        return null;
    }

    function jsString(s) {
        return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/<\//g, '<\\/').replace(/\n/g, '\\n') + '"';
    }

    function fixScripts(html, opts) {
        var re = /(<script\b([^>]*)>)([\s\S]*?)(<\/script\s*>)/gi;
        var pageBase = '';
        if (opts && opts.pageURL) {
            pageBase = String(opts.pageURL).replace(/[#?].*$/, '');
            pageBase = pageBase.slice(0, pageBase.lastIndexOf('/') + 1);
        }
        // module scripts go to the module loader of the page shim (in the polyfill bundle of main documents), unless the
        // page ships a nomodule fallback: that one runs as it is (the old engine skips type=module on its own)
        var modules = !!(opts && opts.transpile && opts.polyfillURL) && !/<script\b[^>]*\snomodule\b/i.test(html), moduleCount = 0;
        var pageId = opts && opts.pageURL ? String(opts.pageURL).replace(/#.*$/, '') : 'about:blank';
        html = html.replace(re, function (all, open, attrs, body, close) {
            var type = attrValue(attrs, 'type') || '';
            var ltype = trim(type).toLowerCase();
            if (!opts || !opts.transpile) return all;
            var src = attrValue(attrs, 'src');
            if (ltype === 'module') {
                // the old engine never runs a module script, and one our loader does not take is not fetched either:
                // WebKit's preload scanner would load it and the app would lower megabytes nothing uses (DuckDuckGo's
                // modern bundles next to its nomodule ones cost 36 s on the device)
                if (!modules) return src ? open.replace(/(\s)src(\s*=)/i, '$1data-br-src$2') + body + close : all;
                if (src) return '<script>window.__brModules&&__brModules.entry(' + jsString(src.replace(/&amp;/g, '&')) + ');' + close;
                if (!/[^\s]/.test(body) || typeof JSFix === 'undefined') return all;
                var id = pageId + '#module-' + (++moduleCount), code = null;
                try { code = JSFix.run(body, JSON.stringify({ module: true, url: id })); } catch (e) { code = null; }
                if (!code) return all;
                return '<script>' + code + '\nwindow.__brModules&&__brModules.entry(null,' + jsString(id) + ');' + close;
            }
            if (!isJavaScriptType(type)) return all;
            // external scripts are lowered by the network layer. A crossorigin one is fetched in CORS mode by the parser
            // but without by the preload scanner, and the old engine then refused to run it from the resource it had
            // (Pinterest's app scripts from s.pinimg.com: no error, no app); without the attribute it runs as it should
            // (the page loses only the details of its errors in window.onerror)
            if (src) return /\scrossorigin\b/i.test(attrs) ? '<script' + attrs.replace(/\scrossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '') + '>' + body + close : all;
            // too big to lower here: the app keeps the text and the page loads it as a script file, which the network
            // layer lowers (it makes room for it and keeps the result; CNN's 2 MB of modules stayed ES2020). The file
            // first takes its own src away: webpack's automatic publicPath takes the src of the running script (or of
            // the last script with one) for the directory of the page's chunks, and an inline script has none. (Fetched
            // synchronously instead, half a minute of lowering ended in a network error.)
            if (g_external && tooBigInline(body)) {
                var name = scriptName(body), url = '/__br_inline-' + name + '.js';
                var dirs = DIRECTIVES.exec(body)[0];
                g_external.push([name, dirs + '\n;(function(){var s=document.getElementsByTagName("script"),i=s.length;' +
                                 'while(i--)if(s[i].getAttribute("src")===' + JSON.stringify(url) + '){s[i].removeAttribute("src");break;}})();\n' +
                                 body.slice(dirs.length)]);
                return '<script' + attrs.replace(/\s(?:async|defer|integrity|crossorigin|charset|onload|onerror|src)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '') +
                       ' src="' + url + '" charset="utf-8">' + close;
            }
            var fixed = transpileInline(body);
            if (fixed === null) return all;
            return open + fixed + close;
        });
        return html;
    }

    function injectPolyfills(html, url) {
        if (!url || html.indexOf(url) >= 0) return html;
        if (!/<html|<head|<body/i.test(html)) return html;               // fragments
        var tag = '<script src="' + url + '"></script>';
        var m = /<head\b[^>]*>/i.exec(html);
        if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
        m = /<html\b[^>]*>/i.exec(html);
        if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
        m = /<(script|link|style|body)\b/i.exec(html);
        if (m) return html.slice(0, m.index) + tag + html.slice(m.index);
        return tag + html;
    }

    // Consent dialogs of the common cookie-banner services: hidden, and the scroll lock they put on the page lifted.
    // Only container ids/classes those services generate themselves are listed (no generic words).
    var COOKIE_BANNER_CSS =
        '#onetrust-consent-sdk,#onetrust-banner-sdk,.onetrust-pc-dark-filter,#didomi-host,#didomi-popup,.didomi-popup-backdrop,.didomi-popup-container,' +
        '#CybotCookiebotDialog,#CybotCookiebotDialogBodyUnderlay,#cookiescript_injected,#cookiescript_injected_wrapper,.qc-cmp2-container,#qc-cmp2-container,' +
        '.qc-cmp-ui-container,[id^="sp_message_container_"],#cmpbox,#cmpbox2,.cmpboxBG,#usercentrics-root,#usercentrics-cmp-ui,#iubenda-cs-banner,' +
        '.iubenda-cs-container,#BorlabsCookieBox,#truste-consent-track,.truste_overlay,.truste_box_overlay,#consent_blackbar,#cookie-law-info-bar,' +
        '#cookie-law-info-again,#moove_gdpr_cookie_info_bar,#catapult-cookie-bar,#cookieChoiceInfo,.cc-window.cc-banner,.cc-window.cc-floating,' +
        '#CookieConsent,#cookieconsent,.js-consent-banner,#gdpr-cookie-message,#cookie-notice,#cookie-consent-banner,#cookie_consent_banner,' +
        '.szn-cmp-dialog-container,#szn-cmp-dialog-container,szn-cmp-dialog,.cpex-cmp,#cpexCmp,.seznam-cmp,[id^="sp_message_iframe_"],' +
        '#cookiebanner,#cookieBanner,.cookie-banner,#cookie-bar,#cookieBar,.cookie-bar,#cookies-banner,.cookies-banner,#cookie-modal,.cookie-modal,' +
        '#cookie-popup,.cookie-popup,#cookieNotice,.cookieNotice,#cookie-message,.cookie-message,#cookies-consent,.cookies-consent,#cookie-consent,.cookie-consent' +
        '{display:none !important;visibility:hidden !important}' +
        'html.didomi-popup-open,body.didomi-popup-open,html.sp-message-open,body.sp-message-open,body.cmp-body-lock,body.onetrust-noscroll,' +
        'html.cookiebot-open,body.cookie-modal-open,body.cc-modal-open,body.qc-cmp-ui-showing,html.qc-cmp-ui-showing,body.cmp-open,html.cmp-open' +
        '{overflow:auto !important;position:static !important;height:auto !important}';

    function injectCookieBannerCSS(html) {
        if (!/<html|<head|<body/i.test(html)) return html;
        var tag = '<style id="br-cookie-banners" data-precedence="br">' + COOKIE_BANNER_CSS + '</style>';   // (React 19 skips it, see ownStyleElement in shims-extra.js)
        var m = /<\/head\s*>/i.exec(html);
        if (m) return html.slice(0, m.index) + tag + html.slice(m.index);
        m = /<body\b[^>]*>/i.exec(html);
        if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
        return html + tag;
    }

    // Scripts set aside while a document's <style> blocks and style attributes are rewritten: markup inside their
    // strings (Google builds '<style>...</style>' and style="..." in JavaScript) is not the document's, and rewritten
    // CSS with line breaks there ended the string literals (SyntaxError on google.com).
    var SCRIPT_MARK = String.fromCharCode(1) + 'brScript', SCRIPT_MARK_RE = new RegExp(SCRIPT_MARK + '(\\d+)' + String.fromCharCode(1), 'g');
    function hideScripts(html, store) {
        return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, function (s) { store.push(s); return SCRIPT_MARK + (store.length - 1) + String.fromCharCode(1); });
    }
    function showScripts(html, store) {
        return store.length ? html.replace(SCRIPT_MARK_RE, function (all, i) { return store[+i]; }) : html;
    }
    // Server-rendered React compares the text of the <style> elements it renders with its own: one rewritten block and
    // the whole page is thrown away and rendered again (vercel.com). There the block keeps the text as sent and the
    // rewritten CSS goes in the attribute data-br-css, which the page shim moves into a style element nested inside
    // (through the CSSOM: no text of its own) while switching the element's own sheet off.
    var REACT_SSR = /<!--\$-->|<!--\/\$-->|<!-- -->|self\.__next_f|__NEXT_DATA__|data-reactroot/;
    var attrEscape = function (s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); };
    function fixHTML(html, ctx, opts) {
        var styleRe = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, scripts = [], hydrates = REACT_SSR.test(html);
        html = hideScripts(html, scripts);
        // the layout width of the page (viewport units), also for its stylesheets rewritten after it
        if (opts && opts.mainFrame) {
            var lw = metaLayoutWidth(html);
            if (lw !== null) { applyLayoutWidth(ctx, lw); ctx.root[' vpw'] = String(lw); }
            html = deviceWidthScale(html);
        }
        // 1. collect variables from every <style> block first (they usually hold the theme)
        var m;
        while ((m = styleRe.exec(html)) !== null) {
            var clean = stripComments(m[2]);
            var rules = [];
            parseRules(clean, 0, clean.length, rules);
            collectVars(flattenNesting(rules), ctx, false);
        }
        // custom properties defined in style attributes are scoped to those elements
        var inlineDefRe = /\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, im;
        while ((im = inlineDefRe.exec(html)) !== null) {
            if (im[1].indexOf('--') < 0) continue;
            var defNames = im[1].match(/--[\w-]+(?=\s*:)/g);
            if (defNames) for (var dn = 0; dn < defNames.length; dn++) varInfo(ctx, defNames[dn]).inline = true;
        }
        prepareRuntimeVars(ctx);
        // 2. rewrite the blocks
        html = html.replace(styleRe, function (all, open, body, close) {
            if (!trim(body)) return all;
            var fixed = fixCSS(body, ctx);
            // (an empty data-br-css: nothing to change, but done)
            if (hydrates) return open.replace(/\s*\/?>$/, '') + ' data-br-css="' + (fixed === body ? '' : attrEscape(fixed)) + '">' + body + close;
            // the marker tells the page shim this block is done (it rewrites the <style> text scripts add)
            return open + '/*br*/' + fixed + close;
        });
        // 3. inline style attributes
        html = html.replace(/(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/gi, function (all, prefix, quoted, dq, sq) {
            var css = dq !== undefined ? dq : sq;
            if (!css || (css.indexOf('(') < 0 && css.indexOf('var') < 0 && css.indexOf('flex') < 0 && css.indexOf('transform') < 0 && css.indexOf('inset') < 0 && css.indexOf('#') < 0 &&
                         css.indexOf('contents') < 0 && css.indexOf('gap') < 0 && !VP_UNIT_RE.test(css))) return all;
            var fixed = fixInlineStyle(css.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'), ctx);
            fixed = fixed.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            return prefix + '"' + fixed + '"';
        });
        // 4. media with sound does not play by itself, as in current browsers: the app lets media start without a tap
        // (for muted videos, the loops that stand in for GIFs), so autoplay goes from the tags without muted
        html = html.replace(/<(video|audio)\b([^>]*)>/gi, function (all, tag, attrs) {
            if (!/\sautoplay\b/i.test(attrs) || /\smuted\b/i.test(attrs)) return all;
            return '<' + tag + attrs.replace(/\sautoplay(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i, '') + '>';
        });
        // 5. scripts: inline ones transpiled, polyfill bundle injected first thing in <head>
        html = showScripts(html, scripts);
        html = fixScripts(html, opts);
        if (opts && opts.polyfillURL) html = injectPolyfills(html, opts.polyfillURL);
        if (opts && opts.hideCookieBanners) html = injectCookieBannerCSS(html);
        return html;
    }

    function run(kind, text, pageVars, options) {
        var ctx = makeContext(pageVars);
        var opts = null;
        if (options) {
            if (typeof options === 'string') { try { opts = JSON.parse(options); } catch (e) { opts = null; } }
            else opts = options;
        }
        if (opts && opts.viewportWidth > 0) ctx.viewportWidth = opts.viewportWidth;
        g_viewportWidth = (opts && opts.viewportWidth > 0) ? opts.viewportWidth : 768;
        g_viewportHeight = (opts && opts.viewportHeight > 0) ? opts.viewportHeight : Math.round(g_viewportWidth * 4 / 3);
        // the app's web view in both orientations (device pixels = CSS pixels of a device-width page) and the
        // current one (style attributes, and scripts' styles: see VP_UNIT_RE)
        var dims = function (a, def) { return a && a.length === 2 && a[0] > 0 && a[1] > 0 ? { w: +a[0], h: +a[1] } : def; };
        g_vpPortrait = dims(opts && opts.viewportPortrait, { w: 768, h: 930 });
        g_vpLandscape = dims(opts && opts.viewportLandscape, { w: 1024, h: 674 });
        g_vpCurrent = opts && opts.orientation === 'landscape' ? g_vpLandscape : g_vpPortrait;
        applyLayoutWidth(ctx, ctx.pageLayoutWidth || 0);
        g_dpr = (opts && opts.devicePixelRatio > 0) ? opts.devicePixelRatio : 1;
        g_manifest = null;
        g_hostScope = opts && opts.hostScope ? String(opts.hostScope).replace(/[^\w-]/g, '') : null;
        g_external = kind === 'html' && opts && opts.transpile && opts.externalScripts ? [] : null;
        var out, external;
        try { out = kind === 'html' ? fixHTML(text, ctx, opts) : fixCSS(text, ctx); } finally { g_hostScope = null; external = g_external; g_external = null; }
        out = guardCalcTransitions(out, ctx, kind);
        // the scripts set aside, named for the cache (a stored copy of the document needs their texts)
        if (external && external.length) {
            var names = [];
            for (var xi = 0; xi < external.length; xi++) names.push(external[xi][0]);
            out += '\n<!--br-inline:' + names.join(',') + '-->';
        } else external = null;
        // this document's own calc and transition findings, for the page's later documents also when this one comes
        // from the cache (see guardCalcTransitions)
        var state = pageState(ctx);
        if (state && (kind !== 'html' || /<html|<head|<body/i.test(text))) out += kind === 'html' ? '\n<!--br-page:' + state + '-->' : '\n/*br-page:' + state + '*/';
        flushGridRules(ctx);
        var manifest = null;
        if (g_manifest && (g_manifest.has.length || g_manifest.cq.length || g_manifest.dv.length || g_manifest.pt.length || g_manifest.cv.length || g_manifest.sc.length || g_manifest.mk.length || g_manifest.gd.length)) {
            manifest = { has: g_manifest.has, cq: g_manifest.cq };
            if (g_manifest.dv.length) manifest.dv = g_manifest.dv;
            if (g_manifest.pt.length) manifest.pt = g_manifest.pt;
            if (g_manifest.cv.length) manifest.cv = g_manifest.cv;
            if (g_manifest.sc.length) manifest.sc = g_manifest.sc;
            if (g_manifest.mk.length) manifest.mk = g_manifest.mk;
            if (g_manifest.gd.length) manifest.gd = g_manifest.gd;
            // the entries ride along in the output (so a cached copy keeps them); "*/" cannot occur inside
            var json = JSON.stringify(manifest).replace(/\*\//g, '*\\/');
            out += kind === 'html' ? '\n<!--br-manifest:' + json.replace(/--/g, '-\\u002d') + '-->' : '\n/*br-manifest:' + json + '*/';
        }
        g_manifest = null;
        // the scoped custom properties, for the documents of the page rewritten after this one
        var scoped = [];
        if (ctx.rt) for (var sn in ctx.rt) if (ctx.rt.hasOwnProperty(sn)) scoped.push(sn);
        var result = { out: out, vars: ctx.root, manifest: manifest, scoped: scoped };
        if (external) result.external = external;
        return JSON.stringify(result);
    }

    // the manifest comment of a rewritten document or stylesheet, parsed (used by the shim's dev harness and tests)
    function readManifest(text) {
        var m = /br-manifest:(\{[\s\S]*?\})(?:\*\/|-->)\s*$/.exec(text);
        if (!m) return null;
        try { return JSON.parse(m[1]); } catch (e) { return null; }
    }

    // the orientation (and layout width, 0 = device width) style attributes are converted for (the page shim's copy)
    function setViewport(orientation, layoutWidth) {
        g_vpCurrent = orientation === 'landscape' ? g_vpLandscape : g_vpPortrait;
        setViewportPass(layoutViewport(g_vpCurrent, layoutWidth || 0));
    }

    return { run: run, fixCSS: fixCSS, fixHTML: fixHTML, fixInlineStyle: fixInlineStyle, makeContext: makeContext, evalSupports: evalSupports, setViewport: setViewport,
             fixSelectorList: fixSelectorList, fixMedia: fixMedia, transformFunctions: transformFunctions, parseColor: parseColor, readManifest: readManifest };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CSSFix;
