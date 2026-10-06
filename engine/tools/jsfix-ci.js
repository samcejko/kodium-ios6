// Runs tools/jsfix-cases.js against Resources/jsfix.js in node (CI): every case, run as written and as lowered by
// JSFix.transpile, must give the same result, and the lowered text must be ES5 without function declarations inside
// blocks of strict code (the iOS 6 JavaScriptCore refuses both).
// Usage: node tools/jsfix-ci.js   (needs the acorn package)
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const acorn = require('acorn');

const ctx = vm.createContext({ acorn, JSFIX_UNICODE: require('./gen-unicode.js')() });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Resources', 'jsfix.js'), 'utf8'), ctx, { filename: 'jsfix.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, 'jsfix-cases.js'), 'utf8'), ctx, { filename: 'jsfix-cases.js' });
const JSFix = ctx.JSFix;
const cases = ctx.JSFIX_CASES;

function nestedStrictFunctions(ast) {
    let count = 0;
    (function walk(node, inBlock, strict) {
        if (!node || typeof node.type !== 'string') return;
        if (node.type === 'Program' || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
            const body = node.type === 'Program' ? node.body : (node.body && node.body.body) || [];
            const s = strict || (body[0] && body[0].type === 'ExpressionStatement' && body[0].directive === 'use strict');
            for (const st of body) walk(st, false, s);
            return;
        }
        for (const key of Object.keys(node)) {
            const v = node[key];
            const childInBlock = inBlock || node.type === 'BlockStatement' || node.type === 'SwitchCase';
            const visit = (c) => {
                if (c && typeof c.type === 'string') {
                    if (c.type === 'FunctionDeclaration' && childInBlock && strict) count++;
                    walk(c, childInBlock, strict);
                }
            };
            if (Array.isArray(v)) v.forEach(visit); else visit(v);
        }
    })(ast, false, false);
    return count;
}

const run = (code) => vm.runInContext('(function () {' + code + '\n})()', vm.createContext({}));

// A webpack chunk with big factories keeps them for later: the skeleton is ES5, its stubs ask __br_lazy, and a factory
// lowered on its own (as the app does for /lazy/<key>/<n>.js) behaves like the original.
function lazyCheck() {
    const pad = (kb) => '/*' + 'x'.repeat(kb * 1024) + '*/';
    const chunk = '(self.webpackChunk_t=self.webpackChunk_t||[]).push([[1],{' +
        '11:(e,t,n)=>{' + pad(60) + 'e.exports={sum:(...a)=>a.reduce((x,y)=>x+y,0),Cls:class{constructor(v){this.v=v}get d(){return this.v*2}},re:/[}{]`/g.source}},' +
        '12:(e,t,n)=>{e.exports=`small ${1+1} }`},' +
        '"./x.js":function(e){' + pad(200) + 'e.exports=[..."ab"].join("-")}}]);';
    const out = JSFix.run(chunk, JSON.stringify({ url: 'https://x/c.js', lazy: 'k-1', force: true }));
    if (!/^\/\*br-lazy:2:k-1\*\//.test(out)) throw new Error('no lazy skeleton: ' + JSFix.last() + ' ' + out.slice(0, 80));
    acorn.parse(out, { ecmaVersion: 5 });
    const parts = JSON.parse(JSFix.lazy());
    const g = vm.createContext({});
    g.self = g;
    g.__br_lazy = function (k, t, a) {
        const i = +k.split('/')[1], part = chunk.slice(parts[i][0], parts[i][1]), wrapped = 'var __br_lazyValue=(' + part + '\n);';
        const low = JSFix.run(wrapped, '{"force":true}') || wrapped;
        acorn.parse(low, { ecmaVersion: 5 });
        return vm.runInContext('(function(){' + low + '\n;return __br_lazyValue;})()', g).apply(t, a);
    };
    vm.runInContext(out, g);
    const mods = g.webpackChunk_t[0][1], req = (id) => { const m = { exports: {} }; mods[id].call(m.exports, m, m.exports, null); return m.exports; };
    const a = req(11), b = req(12), c = req('./x.js');
    const got = JSON.stringify([a.sum(1, 2, 3), new a.Cls(2).d, a.re, b, c, Object.keys(mods)]);
    const want = JSON.stringify([6, 4, '[}{]`', 'small 2 }', 'a-b', ['11', '12', './x.js']]);
    if (got !== want) throw new Error('expected ' + want + ' got ' + got);
}
// A script the engine takes as it is keeps its text, except `delete el.dataset.x` (the old engine throws in strict code
// when there is no such attribute): through the helper; one with such text inside a string stays as it is.
function datasetCheck() {
    const src = "'use strict';var el={dataset:{a:1,b:2,c:{r:1}}},k='b';delete el.dataset.a;var r=!delete el.dataset[k];" +
        'delete el.dataset.c.r;var result=[Object.keys(el.dataset).join(),r,Object.keys(el.dataset.c).length];';
    const out = JSFix.run(src, '{}');
    if (!/__br_dsdel\(el,"a"\)/.test(out) || !/__br_dsdel\(el,\(k\)\)/.test(out) || !/delete el\.dataset\.c\.r/.test(out)) throw new Error('not through the helper: ' + JSFix.last() + ' ' + out);
    acorn.parse(out, { ecmaVersion: 5 });
    const g = vm.createContext({});
    vm.runInContext(out, g);
    const got = JSON.stringify(g.result), want = JSON.stringify(['c', false, 0]);
    if (got !== want) throw new Error('expected ' + want + ' got ' + got);
    const inString = JSFix.run("'use strict';var s=\"delete x.dataset.y\";delete el.dataset.a;", '{}');
    if (inString !== '') throw new Error('a string was changed: ' + inString);
    if (JSFix.run('var a={b:1};delete a.b;', '{}') !== '') throw new Error('an ES5 script without dataset was changed');
}
// A big row of statements with no room for all of it at once goes a group at a time (jsfix.js pieces): the same result
// and ES5 text; a group with a let in a block at its top gives up (as without room). The engine's check is ES5 here.
function piecesCheck() {
    ctx.__brES5Parses = (code) => { try { acorn.parse(code, { ecmaVersion: 5 }); return true; } catch (e) { return false; } };
    try {
        const pad = 'x'.repeat(12 * 1024);
        let src = 'var log = [];\n';
        for (let i = 0; i < 40; i++) src += '(self.q = self.q || []).push([' + i + ', (a = ' + i + ') => ({ v: a * 2, s: `t' + i + '`, p: "' + pad + '".length })]);\n';
        src += 'log.push(self.q.map(function (e) { return e[1]().v + e[1]().s; }).join());\n';
        const shape = JSFix.shape(src, '{}');
        if (shape !== 'pieces') throw new Error('shape ' + JSON.stringify(shape));
        const out = JSFix.run(src, '{}');
        if (!out || !/^pieces:/.test(JSFix.note())) throw new Error('not in pieces: ' + JSFix.last() + ' ' + JSFix.note());
        acorn.parse(out, { ecmaVersion: 5 });
        const a = vm.createContext({}), b = vm.createContext({});
        a.self = a; b.self = b;
        vm.runInContext(src, a);
        vm.runInContext(out, b);
        if (JSON.stringify(a.log) !== JSON.stringify(b.log)) throw new Error('expected ' + JSON.stringify(a.log) + ' got ' + JSON.stringify(b.log));
        const bad = src + '{ let z = 1; log.push(() => z); }\n';
        JSFix.shape(bad, '{}');
        JSFix.run(bad, '{}');
        if (/^pieces:/.test(JSFix.note())) throw new Error('a let in a block at the top went a group at a time');
        // a run given up for lack of memory goes on from where it stopped once there is room
        let calls = 0;
        ctx.__brAvailableMB = () => (++calls > 5 ? 20 : 500);
        JSFix.shape(src, '{}');
        if (JSFix.run(src, '{}') !== '' || !/memory/.test(JSFix.last())) throw new Error('did not stop for lack of memory: ' + JSFix.last());
        ctx.__brAvailableMB = () => 500;
        const again = JSFix.run(src, '{}');
        if (!again || !/waits for room/.test(JSFix.note())) throw new Error('did not go on: ' + JSFix.last() + ' ' + JSFix.note());
        acorn.parse(again, { ecmaVersion: 5 });
        const c = vm.createContext({});
        c.self = c;
        vm.runInContext(again, c);
        if (JSON.stringify(a.log) !== JSON.stringify(c.log)) throw new Error('after the wait: expected ' + JSON.stringify(a.log) + ' got ' + JSON.stringify(c.log));
    } finally { delete ctx.__brES5Parses; delete ctx.__brAvailableMB; }
}
// A big "ES5" script with a few pieces of newer syntax is lowered only there (jsfix.js islands). A rename that reaches a
// statement the parser skipped has that statement parsed again (W.stmtAgain) instead of the whole script lowered; the
// engine's check is ES5 here. (tools/islands-test.html has more cases, for a desktop browser.)
function islandsCheck() {
    ctx.__brES5Parses = (code) => { try { acorn.parse(code, { ecmaVersion: 5, allowReturnOutsideFunction: true }); return true; } catch (e) { return false; } };
    try {
        let pad = '';
        // (over ISLAND_SCRIPT, 192 KB, with the pad twice)
        for (let i = 0; i < 600; i++) pad += 'var __v' + i + ' = { n: ' + i + ', s: "text ' + i + ' / not a regex /", f: function (x) { return x + ' + i + ' / 2; } };\n';
        for (let j = 0; j < 600; j++) pad += 'function __f' + j + '(a, b) { var s = 0; for (var k = 0; k < a; k++) { s += k * b; } return s + "|" + ' + j + '; }\n';
        const long = '"' + '.'.repeat(80) + '"';
        const cases = [
            ['a parameter named like its function', "var kF = function e(e) { const z = e + 1;\nvar bigF = { first: e, second: e * 2, pad: " + long + " };\nreturn bigF.first + bigF.second + z; };\nout.push(kF(5));"],
            ['a renamed block let used by a skipped statement', "var resY = [];\nif (true) { let e = 'blockE'; var gY = function () { var arrowY = () => 1;\nvar holderY = { v: e, n: arrowY(), pad: " + long + " };\nreturn holderY.v + holderY.n; }; resY.push(gY()); }\nvar e = 'outerE';\nresY.push(e);\nout.push(resY);"],
            ['functions of a skipped statement with names of their own', "var resZ = [];\nif (true) { let e = 'blockZ'; resZ.push(e); }\nvar e = 'outerZ';\nvar hZ = function () { var arrowZ = () => 2;\nvar listZ = [1, 2].map(function (e) { return e * 10 + " + long + ".length; });\nreturn listZ.concat(arrowZ()); };\nresZ.push(hZ(), e);\nout.push(resZ);"],
            ['a var of a skipped statement read by a parsed closure', "function fAC() { var getAC = () => w;\nif (true) { let w = 'blockW'; getAC.b = w; };\nvar w = 'fnW' + { pad: " + long + " }.pad.length;\nreturn [getAC(), getAC.b]; }\nout.push(fAC());"],
            ['a run of statements with a function declaration, parsed again', "var resAG = [];\nif (true) { let q2 = 'blockQ2'; var gAG = function () { var arrowAG = () => 6;\ntry { resAG.push(q2 + " + long + ".length); } catch (e) {} function midAG() { return q2 + '!'; } resAG.push(midAG(), typeof midAG);\nreturn arrowAG(); }; resAG.push(gAG()); }\nvar q2 = 'outerQ2';\nresAG.push(q2);\nout.push(resAG);"],
            // (an async function without await: the engine takes the text after its `async`; instagram.com)
            ['an async function without await', "var resAD = [];\nvar objAD = { run: async function (x) { resAD.push('ran ' + x + " + long + ".length); return x * 2; }, pad: " + long + " };\nvar pAD = objAD.run(3);\nout.push(resAD.slice(), typeof pAD.then);"]
        ];
        for (const [name, body] of cases) {
            const src = 'var out = [];\n!function () {\n' + pad + body + '\n' + pad + '}();';
            const want = JSON.stringify(vm.runInContext(src + '\nout;', vm.createContext({})));
            const out = JSFix.run(src, '{"force":true}');
            if (!out || !/^islands: \d+ %/.test(JSFix.note())) throw new Error(name + ': islands not used: ' + JSFix.last() + ' / ' + JSFix.note());
            acorn.parse(out, { ecmaVersion: 5, allowReturnOutsideFunction: true });
            const got = JSON.stringify(vm.runInContext(out + '\nout;', vm.createContext({})));
            if (got !== want) throw new Error(name + ': expected ' + want + ' got ' + got);
        }
    } finally { delete ctx.__brES5Parses; }
}
const settle = (v) => (v && typeof v.then === 'function')
    ? v.then((x) => JSON.stringify(x), (e) => 'rejected: ' + ((e && e.message) || e))
    : Promise.resolve(JSON.stringify(v));

// every case twice: as a small script (the whole tree at once) and with every function lowered while parsing (the
// mode of scripts over 96 KB)
const MODES = [['', {}], [' (early)', { early: 0 }]];
(async () => {
    let failed = 0;
    for (const [mode, opts] of MODES) for (const [caseName, code] of cases) {
        const name = caseName + mode;
        let expected, out, actual;
        try { expected = await settle(run(code)); } catch (e) { console.error(`FAIL ${name}: original threw ${e.message}`); failed++; continue; }
        try { out = JSFix.transpile(code, opts); } catch (e) { console.error(`FAIL ${name}: transpile threw ${e.message || e.what}`); failed++; continue; }
        if (out === null) out = code;
        try {
            acorn.parse(out, { ecmaVersion: 5, allowReturnOutsideFunction: true });
            if (nestedStrictFunctions(acorn.parse(out, { ecmaVersion: 2015, allowReturnOutsideFunction: true }))) throw new Error('function declaration in a block of strict code');
        } catch (e) { console.error(`FAIL ${name}: not ES5: ${e.message}`); failed++; continue; }
        try { actual = await settle(run(out)); } catch (e) { console.error(`FAIL ${name}: lowered threw ${e.message}`); failed++; continue; }
        if (actual !== expected) { console.error(`FAIL ${name}: expected ${expected} got ${actual}`); failed++; continue; }
    }
    console.log(`jsfix: ${cases.length * MODES.length - failed}/${cases.length * MODES.length} cases pass (${JSFix.stats.early} functions lowered while parsing, ${JSFix.stats.fallbacks} fallbacks)`);
    try { lazyCheck(); console.log('jsfix: lazy factories pass'); } catch (e) { console.error('FAIL lazy factories: ' + (e.message || e)); failed++; }
    try { datasetCheck(); console.log('jsfix: dataset deletes in ES5 scripts pass'); } catch (e) { console.error('FAIL dataset deletes: ' + (e.message || e)); failed++; }
    try { piecesCheck(); console.log('jsfix: pieces pass'); } catch (e) { console.error('FAIL pieces: ' + (e.message || e)); failed++; }
    try { islandsCheck(); console.log('jsfix: islands with statements parsed again pass'); } catch (e) { console.error('FAIL islands: ' + (e.message || e)); failed++; }
    process.exit(failed ? 1 : 0);
})();
