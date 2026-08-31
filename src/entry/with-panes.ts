/**
 * The panes extension's composition surface.
 *
 * This is the one module that statically imports panes-only code: the mux
 * domain (socket client, contract, yazi session machinery) and the interactive
 * glue built on it. The orchestrator imports it dynamically, and only when
 * `resolvePanesEnablement` (src/entry/panes-activation.ts) says the extension
 * is active, so a plain `clio-coder` boot never loads any of it. The built
 * import graph is pinned by tests/contracts/instant-shell-import-graph.test.ts:
 * the default boot chunk must carry no mux domain code.
 *
 * Everything re-exported here is a value the orchestrator wires; types cross
 * the seam as type-only imports at the call sites and cost nothing.
 */

export { createMuxDomainModule } from "../domains/mux/index.js";
export { createMuxBridge } from "../interactive/mux-bridge.js";
export { createPanesRuntime } from "../interactive/panes-runtime.js";
export { createWatchPaneController } from "../interactive/watch-pane.js";
export { createYaziBridge } from "../interactive/yazi-bridge.js";
