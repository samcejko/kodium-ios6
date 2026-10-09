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

for (const name of NAMES) {
  const t0 = Date.now()
  await build({
    configFile: false,
    root: web,
    logLevel: 'warn',
    plugins: [leanerWorker],
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
