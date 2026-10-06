// Prints the code around line:column of a big bundle. Usage: node ctx.mjs <file> <line> <column> [before] [after]
import fs from 'node:fs'
const [file, line, col, before = 400, after = 200] = process.argv.slice(2)
const text = fs.readFileSync(file, 'utf8')
let start = 0
for (let i = 1; i < +line; i++) start = text.indexOf('\n', start) + 1
const at = start + (+col) - 1
console.log(text.slice(Math.max(0, at - +before), at) + ' /*HERE*/ ' + text.slice(at, at + +after))
