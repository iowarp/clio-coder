/**
 * The terminal-engine primitives a non-interactive surface needs, kept in a
 * module of its own rather than behind ./tui.js.
 *
 * ./tui.js is the interactive layer's barrel: it carries the instrumented
 * renderer and SelectList, and every consumer of it also pulls the interactive
 * theme. A CLI command that only measures text and paints an alternate screen
 * needs none of that, and reaching it through the barrel is not free. An edge
 * from outside src/interactive/ to ./tui.js, static or dynamic, gives that
 * module a reachability set the theme modules do not share, so the bundler
 * peels it into a chunk of its own. That chunk lands in the Stage 0 instant
 * shell closure, which tests/contracts/instant-shell-import-graph.test.ts holds
 * to six chunks. Everything re-exported here is a pass-through to the external
 * terminal engine, which is not bundled and so adds no chunk at all.
 *
 * The engine-boundary rule (rule1 in tests/boundaries/check-boundaries.ts) keeps
 * terminal-engine value imports inside src/engine/, which is why this seam lives
 * here and not in src/cli/.
 */

export { ProcessTerminal, TuiAltScreen, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
