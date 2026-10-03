/**
 * ANSI-aware, display-width text wrapping for surfaces that run before or
 * without the terminal UI (the shutdown notice in src/core/termination.ts).
 *
 * This deep-imports pi-tui's utils module instead of going through
 * ./tui-primitives.js or ./tui.js. Those re-export the pi-tui root barrel,
 * which has no sideEffects flag, so importing either from a non-TUI command
 * would evaluate the whole bundled terminal engine on every `clio-coder targets`
 * or `models` run. The utils module alone is a small leaf.
 */

export { wrapTextWithAnsi } from "@earendil-works/pi-tui/dist/utils.js";
