// Makes <bundle>.dbg.js: a copy of the lowered bundle with debugging code put in at given places.
// Usage: node dbg.mjs <bundle.js> <patches.json>   (patches: [[find, replaceWith], ...], each find must occur once)
import fs from 'node:fs'
const [file, patchesFile] = process.argv.slice(2)
let text = fs.readFileSync(file, 'utf8')
for (const [find, repl] of JSON.parse(fs.readFileSync(patchesFile, 'utf8'))) {
  const at = text.indexOf(find)
  if (at < 0) throw new Error('not found: ' + find)
  if (text.indexOf(find, at + 1) >= 0) throw new Error('found more than once: ' + find)
  text = text.slice(0, at) + repl + text.slice(at + find.length)
}
const out = file.replace(/\.js$/, '.dbg.js')
fs.writeFileSync(out, text)
console.log('written', out)
