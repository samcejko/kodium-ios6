// Checks jsfix's lowering of super property reads and writes against the engine's own behaviour.
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tp = path.join(here, '..', 'tp')
const ctx = vm.createContext({ console })
for (const f of ['acorn.js', 'unicode-props.js', 'jsfix.js']) vm.runInContext(fs.readFileSync(path.join(tp, f), 'utf8'), ctx, { filename: f })
const { acorn, JSFix } = ctx

const src = `
var log = [];
class A {
  constructor() { this._v = 1; this._r = 'a'; }
  get v() { return this._v * 10; }
  set v(x) { log.push('A.set ' + x); this._v = x; }
  get runner() { return this._r; }
  set runner(x) { this._r = 'A:' + x; }
  m() { return 'A.m ' + this._v; }
  get ev() { var self = this; return function (x) { return 'ev ' + x + ' ' + self._v + ' ' + (this === self); }; }
  static s() { return 'A.s'; }
  static get sv() { return 'A.sv:' + this.name; }
}
class B extends A {
  get v() { return super.v + 1; }
  set v(x) { super.v = x * 2; }
  get runner() { return super.runner; }
  set runner(x) { super.runner = x; }
  m() { return super.m() + '/B'; }
  get ev() { return super.ev; }
  callEv() { return super.ev('a') + ' ' + super.ev(...['b']); }
  async callEvLater() { return super.ev(await Promise.resolve('c')); }
  plain() { super.plainField = 5; return this.plainField + ':' + Object.prototype.hasOwnProperty.call(this, 'plainField'); }
  comp() { super.v += 3; return this._v; }
  inc() { var a = super.v++; return a + ',' + this._v; }
  orr() { super.missing ||= 7; return this.missing; }
  key(k) { return super[k]; }
  arrow() { return (() => super.v)(); }
  async later() { await null; return super.v + (await Promise.resolve(100)); }
  static s() { return super.s() + '/B'; }
  static get sv() { return super.sv + '/B'; }
}
var b = new B();
var out = [];
out.push(b.v);
b.v = 4; out.push(b._v, b.v);
b.runner = 'x'; out.push(b.runner);
out.push(b.m(), b.plain(), b.comp(), b.inc(), b.orr(), b.key('runner'), b.arrow(), B.s(), B.sv, b.callEv(), b.ev('d'));
b.later().then(function (r) { out.push(r); return b.callEvLater(); }).then(function (r) { out.push(r); done(out.join(' | ') + ' || ' + log.join(';')); });
`
const runIn = (code, extra) => new Promise((resolve) => {
  const c = vm.createContext(Object.assign({ console, Promise, done: resolve }, extra || {}))
  vm.runInContext(code, c)
})

const native = await runIn(src)
const lowered = JSFix.run(src, JSON.stringify({ force: true, url: 'http://t.invalid/t.js' }))
if (!lowered) throw new Error('jsfix: ' + JSFix.last())
acorn.parse(lowered, { ecmaVersion: 5 })
const prelude = fs.readFileSync(path.join(here, '..', 'prelude', 'vsc-prelude.js'), 'utf8')
const helpers = fs.readFileSync(path.join(here, 'surfari-jsfix-helpers.js'), 'utf8')
const regen = fs.readFileSync(path.join(here, 'surfari-regenerator-runtime.js'), 'utf8')
const page = { addEventListener() {}, document: {} }
const viaLowered = await runIn('var window=this;' + regen + '\n' + helpers + '\n' + prelude + '\n' + lowered, page)
console.log('native :', native)
console.log('lowered:', viaLowered)
console.log(native === viaLowered ? 'SAME' : 'DIFFERENT')
if (process.argv.includes('--show')) console.log(lowered)
