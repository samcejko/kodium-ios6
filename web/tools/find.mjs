// Finds a regular expression in a window of a big bundle around line:column and prints each hit with some context.
// Usage: node find.mjs <file> <line> <column> <before> <after> <regex> [context]
import fs from 'node:fs'
const [file, line, col, before, after, re, context = 150] = process.argv.slice(2)
const text = fs.readFileSync(file, 'utf8')
let start = 0
for (let i = 1; i < +line; i++) start = text.indexOf('\n', start) + 1
const at = start + (+col) - 1
const from = Math.max(0, at - +before), win = text.slice(from, at + +after)
const rx = new RegExp(re, 'g')
let m
while ((m = rx.exec(win))) {
  const pos = from + m.index
  console.log('@' + (pos - at) + ': ' + text.slice(Math.max(0, pos - +context), pos) + ' /*>*/ ' + text.slice(pos, pos + +context))
  console.log('---')
}
