// The extension host's main thread parts that Kodium leaves out (vite.config.mjs LEFT_OUT: what an extension cannot do
// on the iPad) get an empty stand-in, as monaco-vscode-api gives one to those it lacks: a host checks at its start that
// every part is there, and without one every call into the host failed (an extension waiting for its language, for
// one, never started). A call of an extension into one of them fails on its own.
import { ExtHostCustomersRegistry, extHostNamedCustomer } from '@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/extHostCustomers'
import { MainContext } from '@codingame/monaco-vscode-api/vscode/vs/workbench/api/common/extHost.protocol'

export function standInForLeftOutParts(): void {
  const registered = new Set(ExtHostCustomersRegistry.getNamedCustomers().map(([id]) => id.sid))
  for (const id of Object.values(MainContext)) {
    if (registered.has(id.sid)) continue
    extHostNamedCustomer(id)(class {
      dispose(): void {}
    })
  }
}
