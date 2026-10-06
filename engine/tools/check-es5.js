// Fails when a script is not plain ES5 or declares a function inside a block under 'use strict':
// the iOS 6 JavaScriptCore refuses both ("Functions cannot be declared in a nested block in strict
// mode"), and one such file kills the whole concatenated polyfill bundle.
// Usage: node tools/check-es5.js file.js [more.js ...]
'use strict';
const fs = require('fs');
const acorn = require('acorn');

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
            if (key === 'type' || key === 'loc') continue;
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

let failed = false;
for (const file of process.argv.slice(2)) {
    const src = fs.readFileSync(file, 'utf8');
    try {
        acorn.parse(src, { ecmaVersion: 5, allowReturnOutsideFunction: true });
    } catch (e) {
        console.error(`${file}: not ES5: ${e.message}`);
        failed = true;
        continue;
    }
    const nested = nestedStrictFunctions(acorn.parse(src, { ecmaVersion: 2015, allowReturnOutsideFunction: true }));
    if (nested) {
        console.error(`${file}: ${nested} function declaration(s) inside blocks under strict mode`);
        failed = true;
        continue;
    }
    console.log(`${file}: ok (${src.length} bytes)`);
}
process.exit(failed ? 1 : 0);
