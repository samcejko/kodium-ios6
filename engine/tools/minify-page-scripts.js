// Minifies the scripts the app puts in front of every page (and core-js-custom) for the bundle:
//   node tools/minify-page-scripts.js <in> <out> [<in> <out> ...]
// Function expressions lose their names, except constructors (capitalized) and trim, trimStart, trimEnd and values,
// whose names core-js checks before it keeps them: on iOS 6 a named function expression costs every call - the engine
// reads the variables it uses through a scope object of its own (measured on the iPad: 0.9 us instead of 0.2 for
// three reads, 5.0 instead of 2.9 for JSON.stringify's wrapper). Functions that keep their names are written as
// declarations in the sources where they are called often; reduce_vars is off so that terser does not inline a
// declaration used once into a (named) function expression.
// Lines are kept short: iOS 6 reports errors with a line and no column, and shims-extra on one line made every error
// from it point at the same place (tools/bundle-line.ps1 finds a reported line in a build).
// Licence headers stay (/*! ... */, @license, @preserve, a copyright line, core-js's "license:" banner): MIT, BSD and
// Apache-2.0 want the notice in every copy, and the bundled polyfills are copies (all of them are also listed in
// THIRD_PARTY_NOTICES.md). The app's own sources have no such comments, so they still lose every comment.
const { minify } = require('terser');
const fs = require('fs');
const KEEP = /^(?:[A-Z][\w$]*|trim|trimStart|trimEnd|values)$/;
const KEEP_COMMENT = /^!|@license|@preserve|copyright|\(c\)|\u00a9|\blicen[cs]e:/i;
const args = process.argv.slice(2);
if (!args.length || args.length % 2) { console.error('usage: minify-page-scripts.js <in> <out> [...]'); process.exit(2); }
(async () => {
  for (let i = 0; i < args.length; i += 2) {
    const src = fs.readFileSync(args[i], 'utf8');
    const r = await minify(src, {
      ecma: 5,
      compress: { keep_fnames: KEEP, reduce_vars: false },
      mangle: { keep_fnames: KEEP },
      format: { ascii_only: true, max_line_len: 400, comments: (node, comment) => KEEP_COMMENT.test(comment.value) }
    });
    fs.writeFileSync(args[i + 1], r.code);
    console.log(args[i] + ': ' + src.length + ' -> ' + r.code.length + ' bytes');
  }
})().catch(e => { console.error(e); process.exit(1); });
