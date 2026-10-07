// The extension host's main thread parts that Kodium leaves out (vite.config.mjs LEFT_OUT: what an extension cannot do
// on the iPad) get a stand-in, as monaco-vscode-api gives one to those it lacks: a host checks at its start that every
// part is there, and without one every call into the host failed (an extension waiting for its language, for one, never
// started). The stand-in takes any call and does nothing: the host itself calls some at its start ($registerTaskSystem,
// $registerDebugTypes), which an empty one turned into errors with long stacks in the log.
// (A Proxy: on iOS 6 the prelude's stand-in for it, which knows every $name of the bundle.)
import { ExtHostCustomersRegistry, extHostNamedCustomer } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/extHostCustomers'
import { MainContext } from '@codingame/monaco-vscode-api/vscode/vs/workbench/api/common/extHost.protocol'

const nothing = (): undefined => undefined
// What the host goes through at its start: Copilot's tools (none) - "undefined is not iterable" in the log otherwise
const answers: Record<string, () => unknown> = { $getTools: () => [] }
const takesAnything: ProxyHandler<object> = {
  get: (_target, name) => (typeof name === 'string' && (name.charAt(0) === '$' || name === 'dispose') ? answers[name] || nothing : undefined)
}

class StandIn {
  constructor() {
    return new Proxy(this, takesAnything)
  }

  dispose(): void {}
}

export function standInForLeftOutParts(): void {
  const registered = new Set(ExtHostCustomersRegistry.getNamedCustomers().map(([id]) => id.sid))
  for (const id of Object.values(MainContext)) {
    if (!registered.has(id.sid)) extHostNamedCustomer(id)(StandIn)
  }
}
