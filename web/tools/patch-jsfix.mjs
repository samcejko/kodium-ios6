// Kodium's fixes on top of Surfari's transpiler (engine/Resources/jsfix.js), applied as exact-once text edits so that a
// newer copy from Surfari takes them again (or fails loudly where its text changed). Once Surfari has them, they go.
// Usage: node patch-jsfix.mjs <Surfari's jsfix.js> <output jsfix.js>
//
// super.x: Surfari lowered a read of super.x to Parent.prototype.x, so an accessor of the parent class ran with the
// prototype as this (VS Code's `super.logFile` getter read undefined paths), super.x = v set the prototype's property
// (or called its setter on the prototype), and super.x(...) read the function the same way (VS Code's
// `super.onDidChangeFullScreen(...)`, a getter that returns the event, threw). Reads, writes, updates and calls of
// super properties now go through __br_superGet / __br_superSet, which pass the instance as the receiver like ES2015.
import fs from 'node:fs'

const [input, output] = process.argv.slice(2)
// (Surfari's working tree on Windows has CRLF line ends; the edits and the output use LF)
let text = fs.readFileSync(input, 'utf8').replace(/\r\n/g, '\n')

const HELPERS = `        // super.x (lowered): the parent's property as the instance sees it - an accessor of the parent class runs with
        // the instance as this (the parent's prototype as the receiver gave a getter nothing to read)
        __br_superGet: function (proto, key, self) {
            for (var o = proto; o; o = Object.getPrototypeOf(o)) {
                var d = Object.getOwnPropertyDescriptor(o, key);
                if (d) return d.get ? d.get.call(self) : d.value;
            }
            return undefined;
        },
        // super.x = v: the parent's setter with the instance as this, or x as the instance's own value (not through the
        // instance's own class, whose setter is usually the one running this)
        __br_superSet: function (proto, key, value, self) {
            for (var o = proto; o; o = Object.getPrototypeOf(o)) {
                var d = Object.getOwnPropertyDescriptor(o, key);
                if (d) {
                    if (d.set) { d.set.call(self, value); return value; }
                    if (d.get || !d.writable) return value;
                    break;
                }
            }
            var own = Object.getOwnPropertyDescriptor(self, key);
            if (!own) Object.defineProperty(self, key, { value: value, writable: true, enumerable: true, configurable: true });
            else if (own.writable) Object.defineProperty(self, key, { value: value });
            return value;
        },
`

const EDITS = [
  // the helpers, before __br_in's comment
  ['        // `k in o` where k may be a polyfilled symbol:',
   HELPERS + '        // `k in o` where k may be a polyfilled symbol:'],

  // super.x++ / --super.x
  [`    P.update = function (n) {
        var arg = this.E(n.argument, P_POSTFIX), code = n.prefix ? n.operator + arg : arg + n.operator;`,
   `    P.update = function (n) {
        if (n.argument.type === 'MemberExpression' && n.argument.object.type === 'Super') {
            // super.x++: read and written with the instance as the receiver (see assign)
            var sref = this.ctxSuper(), sself = this.thisCode(), skey = this.superKey(n.argument), sold = this.temp();
            var sget = this.h('__br_superGet'), sset = this.h('__br_superSet'), snew = sold + (n.operator === '++' ? '+1' : '-1');
            this.prec = P_PRIMARY;
            return '(' + sold + '=+' + sget + '(' + sref + ',' + skey.first + ',' + sself + '),' + sset + '(' + sref + ',' + skey.later + ',' + snew + ',' + sself + ')' +
                   (n.prefix ? '' : ',' + sold) + ')';
        }
        var arg = this.E(n.argument, P_POSTFIX), code = n.prefix ? n.operator + arg : arg + n.operator;`],

  // super.x
  [`        if (n.object.type === 'Super') code = this.ctxSuper() + this.tail(n);
        else {`,
   `        if (n.object.type === 'Super') {
            // super.x: the parent's property as the instance sees it (an accessor runs with the instance as this)
            code = this.h('__br_superGet') + '(' + this.ctxSuper() + ',' + this.superKey(n).first + ',' + this.thisCode() + ')';
        } else {`],

  // the key of a super property as an argument
  [`    P.ctxSuper = function () {
        var r = this.ctx.superRef;
        if (!r) throw new Unsupported('super outside a class');
        return r;
    };`,
   `    P.ctxSuper = function () {
        var r = this.ctx.superRef;
        if (!r) throw new Unsupported('super outside a class');
        return r;
    };
    // the key of super.x / super[k] as an argument, for a target used twice (the first use evaluates it)
    P.superKey = function (left) {
        if (!left.computed) { var nk = quote(left.property.name); return { first: nk, later: nk }; }
        var k = this.E(left.property, P_ASSIGN);
        if (left.property.type === 'Literal' || isIdentCode(k)) return { first: k, later: k };
        var kt = this.temp();
        return { first: '(' + kt + '=' + k + ')', later: kt };
    };`],

  // super.x = v, super.x += v, super.x ||= v...
  [`        if (op === '||=' || op === '&&=' || op === '??=') {
            var r = this.refParts(left), val = this.E(n.right, P_ASSIGN);`,
   `        if (left.type === 'MemberExpression' && left.object.type === 'Super') {
            // super.x = v sets x on the instance, through the parent class's setter if it has one
            var sref = this.ctxSuper(), sself = this.thisCode(), skey = this.superKey(left), shGet = this.h('__br_superGet'), shSet = this.h('__br_superSet');
            var sget = shGet + '(' + sref + ',' + skey.first + ',' + sself + ')', sval = this.E(n.right, P_ASSIGN);
            var sset = function (k, v) { return shSet + '(' + sref + ',' + k + ',' + v + ',' + sself + ')'; };
            this.prec = P_CALL;
            if (op === '=') code = sset(skey.first, sval);
            else if (op === '||=' || op === '&&=') { code = sget + (op === '||=' ? '||' : '&&') + sset(skey.later, sval); this.prec = op === '||=' ? 4 : 5; }
            else if (op === '??=') { var sv = this.temp(); code = '(' + sv + '=' + sget + ') != null?' + sv + ':' + sset(skey.later, sval); this.prec = P_COND; }
            else {
                var sop = op.slice(0, -1), sold = shGet + '(' + sref + ',' + skey.later + ',' + sself + ')';
                code = sset(skey.first, sop === '**' ? 'Math.pow(' + sold + ',' + sval + ')' : sold + sop + '(' + sval + ')');
            }
            return code;
        }
        if (op === '||=' || op === '&&=' || op === '??=') {
            var r = this.refParts(left), val = this.E(n.right, P_ASSIGN);`],

  // super.x(...): the function read as the instance sees it (an accessor of the parent class can return it)
  ['            var fn = this.ctxSuper() + this.tail(callee), self = this.thisCode();',
   "            var self = this.thisCode(), fn = this.h('__br_superGet') + '(' + this.ctxSuper() + ',' + this.superKey(callee).first + ',' + self + ')';"],

  // the same inside generators and async functions (expressions that wait)
  ["                if (n.object.type === 'Super') return finish(this.ctxSuper() + (n.computed ? '[' + this.gx(n.property, false) + ']' : this.tail(n)));",
   "                if (n.object.type === 'Super') return finish(this.h('__br_superGet') + '(' + this.ctxSuper() + ',' + (n.computed ? this.gx(n.property, false) : quote(n.property.name)) + ',' + this.thisCode() + ')');"],
  [`                    calleeCode = this.ctxSuper() + (callee.computed ? '[' + viaTemp(null, callee.property) + ']' : this.tail(callee));
                    thisVal = this.thisCode();`,
   `                    thisVal = this.thisCode();
                    calleeCode = this.h('__br_superGet') + '(' + this.ctxSuper() + ',' + (callee.computed ? viaTemp(null, callee.property) : quote(callee.property.name)) + ',' + thisVal + ')';`],
  ["                lhs = n.left.type === 'MemberExpression' ? (n.left.object.type === 'Super' ? this.ctxSuper() : viaTemp(null, n.left.object))",
   `                if (op === '=' && n.left.type === 'MemberExpression' && n.left.object.type === 'Super') {
                    var sk = n.left.computed ? viaTemp(this.gTemp(), n.left.property) : quote(n.left.property.name);
                    return finish(this.h('__br_superSet') + '(' + this.ctxSuper() + ',' + sk + ',' + this.gx(n.right, false) + ',' + this.thisCode() + ')');
                }
                lhs = n.left.type === 'MemberExpression' ? (n.left.object.type === 'Super' ? this.ctxSuper() : viaTemp(null, n.left.object))`]
]

for (const [find, repl] of EDITS) {
  const at = text.indexOf(find)
  if (at < 0) throw new Error('patch-jsfix: text not found (Surfari changed it?):\n' + find)
  if (text.indexOf(find, at + 1) >= 0) throw new Error('patch-jsfix: text found more than once:\n' + find)
  text = text.slice(0, at) + repl + text.slice(at + find.length)
}
text = "/* Kodium: Surfari's jsfix.js with the fixes of web/tools/patch-jsfix.mjs */\n" + text
fs.writeFileSync(output, text)
console.log('patch-jsfix:', EDITS.length, 'edits ->', output)
