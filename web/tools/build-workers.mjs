// The workbench's web workers for iOS 6, each a classic script of its own (src/workers): the editor's - diffs, word
// suggestions, links, off the page's thread - the language services of JSON, CSS and HTML, and JavaScript's syntax
// check and symbols (acorn, asked by src/javascript.ts itself). Vite builds each entry
// as an IIFE, tools/lower.mjs lowers it to ES5 as it does the workbench, and in front of it goes what a worker of the
// iOS 6 engine lacks: the engine's polyfills for workers (Promise, Map... - https://ios6-browser.invalid/ is answered
// by the app's engine only; a desktop browser has its own), the names the Proxy stand-in needs and the helpers of
// prelude/worker-prelude.js. The workbench asks for them by label (src/main.ts, MonacoEnvironment.getWorker).
// Usage: node build-workers.mjs   (after the workbench's build: writes dist/assets/workers/<name>.worker.es5.js)
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { quickerDiffs } from './quicker-diffs.mjs'

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = path.join(web, 'dist', 'workers')
const out = path.join(web, 'dist', 'assets', 'workers')
const NAMES = ['editor', 'json', 'css', 'html', 'javascript']
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
fs.mkdirSync(out, { recursive: true })
const prelude = fs.readFileSync(path.join(web, 'prelude', 'worker-prelude.js'), 'utf8')
// (the editor's worker without the WebAssembly and native diff computers - other settings, the default one stays: as
// in the workbench, see leanerBundle in vite.config.mjs)
const leanerWorker = {
  name: 'kodium-leaner-worker',
  transform(code, id) {
    if (!id.replace(/\\/g, '/').endsWith('/vs/editor/common/diff/linesDiffComputers.js')) return null
    const find = "import { getExternalLinesDiffComputer } from './externalLinesDiffComputer.js';"
    if (code.split(find).length !== 2) this.error('kodium-leaner-worker: linesDiffComputers.js has another form')
    return { code: code.replace(find, 'const getExternalLinesDiffComputer = async () => new DefaultLinesDiffComputer();'), map: null }
  }
}

// (the words of the open documents for the suggestions came out of a generator - lowered to ES5, the regenerator
// runtime's machinery for every word: ~450 ms on the iPad 2 for a file of 1,500 lines at every list of suggestions;
// now a plain loop over the lines and the word regex's matches)
const quickerWords = {
  name: 'kodium-quicker-words',
  transform(code, id) {
    const p = id.replace(/\\/g, '/')
    const edits = p.endsWith('/vs/editor/common/services/textModelSync/textModelSync.impl.js') ? [
      ['    getLineWords(lineNumber, wordDefinition) {\n',
       '    kdEachWord(wordDefinition, fn) {\n' +
       '        const lines = this._lines;\n' +
       '        for (let i = 0; i < lines.length; i++) {\n' +
       '            const text = lines[i];\n' +
       '            let match;\n' +
       '            wordDefinition.lastIndex = 0;\n' +
       '            while (match = wordDefinition.exec(text)) {\n' +
       '                if (match[0].length === 0) {\n                    break;\n                }\n' +
       '                if (fn(match[0]) === false) {\n                    return;\n                }\n' +
       '            }\n' +
       '        }\n' +
       '    }\n' +
       '    getLineWords(lineNumber, wordDefinition) {\n']
    ] : p.endsWith('/vs/editor/common/services/editorWebWorker.js') ? [
      ['            for (const word of model.words(wordDefRegExp)) {\n' +
       '                if (word === leadingWord || !isNaN(Number(word))) {\n' +
       '                    continue;\n' +
       '                }\n' +
       '                seen.add(word);\n' +
       '                if (seen.size > EditorWorker._suggestionsLimit) {\n' +
       '                    break outer;\n' +
       '                }\n' +
       '            }\n',
       // (each word looked up in a plain object first - the worker's Set is a polyfill, 9,000 adds for 345 words -
       // and Number() asked only of what can be a number: a digit, "-", "." or "I"nfinity first)
       '            let kdFull = false;\n' +
       '            model.kdEachWord(wordDefRegExp, word => {\n' +
       '                if (word === leadingWord || kdSeen[word] !== undefined) {\n                    return true;\n                }\n' +
       '                const kdFirst = word.charCodeAt(0);\n' +
       '                if ((kdFirst >= 48 && kdFirst <= 57 || kdFirst === 45 || kdFirst === 46 || kdFirst === 73) && !isNaN(Number(word))) {\n                    kdSeen[word] = 2;\n                    return true;\n                }\n' +
       '                kdSeen[word] = 1;\n' +
       '                seen.add(word);\n' +
       '                if (seen.size > EditorWorker._suggestionsLimit) {\n                    kdFull = true;\n                    return false;\n                }\n' +
       '                return true;\n' +
       '            });\n' +
       '            if (kdFull) {\n                break outer;\n            }\n'],
      ['        const seen = ( new Set());\n        outer:\n', '        const seen = ( new Set());\n        const kdSeen = Object.create(null);\n        outer:\n']
    ] : null
    if (!edits) return null
    for (const [find, replace] of edits) {
      if (code.split(find).length !== 2) this.error('kodium-quicker-words: ' + p + ' has another form')
      code = code.replace(find, () => replace)
    }
    return { code, map: null }
  }
}

for (const name of NAMES) {
  const t0 = Date.now()
  await build({
    configFile: false,
    root: web,
    logLevel: 'warn',
    plugins: [leanerWorker, quickerWords, quickerDiffs()],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      target: 'es2022',
      minify: 'esbuild',
      sourcemap: false,
      emptyOutDir: false,
      outDir: tmp,
      reportCompressedSize: false,
      copyPublicDir: false,
      lib: { entry: path.join(web, 'src', 'workers', name + '.worker.ts'), formats: ['iife'], name: 'KodiumWorker', fileName: () => name + '.worker.js' },
      rollupOptions: { output: { inlineDynamicImports: true } }
    }
  })
  const bundled = path.join(tmp, name + '.worker.js'), lowered = path.join(tmp, name + '.worker.lowered.js')
  const r = spawnSync(process.execPath, ['--max-old-space-size=4096', '--stack-size=8000', path.join(web, 'tools', 'lower.mjs'), bundled, lowered], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('build-workers: lowering ' + name + ' failed')
  // (lower.mjs writes the names for a page: a worker has self)
  const names = fs.readFileSync(lowered.replace(/\.js$/, '') + '.names.js', 'utf8').replace(/\bwindow\.__vsc_proxyNames\b/, 'self.__vsc_proxyNames')
  const file = path.join(out, name + '.worker.es5.js')
  fs.writeFileSync(file, '/* Kodium: the ' + name + ' worker, see web/tools/build-workers.mjs */\n' +
    'try{importScripts("https://ios6-browser.invalid/worker-polyfills.js")}catch(e){}\n' +
    names + prelude + '\n' + fs.readFileSync(lowered, 'utf8'))
  console.log(name + ' worker:', (fs.statSync(file).size / 1024).toFixed(0), 'KB', ((Date.now() - t0) / 1000).toFixed(1), 's')
}
