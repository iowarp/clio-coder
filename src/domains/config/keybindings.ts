/**
 * Clio app keybinding schema. Merges pi-tui's editor/select defaults (in
 * TUI_KEYBINDINGS) with the Clio-specific action ids so `KeybindingsManager`
 * can resolve both against user overrides stored in `settings.yaml`.
 *
 * The `Keybindings` interface in pi-tui is extensible via declaration merging.
 * Adding `clio.*` ids here makes them typed everywhere the manager is used:
 * pass a wrong id to `matches("clio.typo", ...)` and the compiler complains.
 */

import type { KeybindingDefinitions } from "../../engine/tui.js";
import { TUI_KEYBINDINGS } from "../../engine/tui.js";

/**
 * Clio-specific keybinding ids. Each entry represents a routable action in
 * `routeInteractiveKey`. Ctrl+C is intentionally absent because its three-way
 * semantics (cancel stream / close overlay / clear editor / double-tap exit)
 * live in `resolveCtrlCAction` and are not a simple keybinding.
 */
export interface ClioAppKeybindings {
	"clio.thinking.cycle": true;
	"clio.exit": true;
	"clio.status.toggle": true;
	"clio.session.tree": true;
	"clio.dispatchBoard.toggle": true;
	"clio.dispatch.background": true;
	"clio.model.select": true;
	"clio.model.cycleForward": true;
	"clio.model.cycleBackward": true;
	"clio.tool.expand": true;
	"clio.tool.expandAll": true;
	"clio.tool.liveOutput": true;
	"clio.thinking.expand": true;
	"clio.thinking.expandAll": true;
	"clio.editor.external": true;
	"clio.message.followUp": true;
	"clio.message.interrupt": true;
	"clio.message.dequeue": true;
	"clio.notifications.dismiss": true;
	"clio.leader": true;
}

export type ClioKeybinding = keyof ClioAppKeybindings;

/**
 * Declaration merge: pi-tui's `Keybindings` interface is open so downstream
 * packages register their action ids. After this block, `KeybindingsManager`
 * returned from `createKeybindingManager` accepts `clio.*` ids with full
 * TypeScript checking.
 */
declare module "@earendil-works/pi-tui" {
	interface Keybindings extends ClioAppKeybindings {}
}

/**
 * Built-in defaults. Users override via `settings.yaml.keybindings`; the
 * manager reads those and patches this table before the TUI starts.
 *
 * Clio's app bindings follow one scheme: `Alt + <key>` (with `shift+tab`,
 * `ctrl+d`, and the portable `ctrl+g` leader retained because every terminal
 * already transmits them). `Alt + <letter>` decodes from the legacy
 * `ESC <letter>` sequence on meta-capable terminals. The chosen letters avoid
 * pi-tui's editor reserves (`alt+b/f/d/y`, and the `ESC n`/`ESC p` aliases for
 * `alt+down`/`alt+up`) and the readline/terminal line-editing reserves the
 * router relies on for editor behavior. The CSI-u/reserved-key detector in
 * `keybinding-manager.ts` stays as a safety net for user rebinds.
 */
export const CLIO_APP_KEYBINDINGS = {
	"clio.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle orchestrator thinking level",
	},
	"clio.exit": {
		defaultKeys: "ctrl+d",
		description: "Exit when the editor is empty",
	},
	"clio.status.toggle": {
		defaultKeys: "alt+u",
		description: "Toggle the footer dashboard (compact / expanded)",
	},
	"clio.session.tree": {
		defaultKeys: "alt+t",
		description: "Open the /tree navigator",
	},
	"clio.dispatchBoard.toggle": {
		defaultKeys: "alt+w",
		description: "Toggle the dispatch (workers) board overlay",
	},
	"clio.dispatch.background": {
		// Ctrl+B alone is pi-tui's editor cursor-left, so the Claude Code chord
		// cannot be the primary here. Alt+S ("send to background") keeps the app
		// scheme and earns the Ctrl+G leader fallback, which only alt+<letter>
		// bindings get; Ctrl+Alt+B stays for the b-for-background muscle memory.
		defaultKeys: ["alt+s", "ctrl+alt+b"],
		description: "Send the running attached dispatch to the background as a detached batch",
	},
	"clio.model.select": {
		defaultKeys: "alt+l",
		description: "Open the model + targets selector",
	},
	"clio.model.cycleForward": {
		defaultKeys: "alt+j",
		description: "Cycle to next scoped model",
	},
	"clio.model.cycleBackward": {
		defaultKeys: "alt+k",
		description: "Cycle to previous scoped model",
	},
	"clio.tool.expand": {
		defaultKeys: "alt+o",
		description:
			"Fold or unfold the newest tool call or worker block between its one-line summary and full details (no effect while /output verbose pins them open)",
	},
	"clio.tool.expandAll": {
		// Alt+Shift+letter is commonly consumed by OS keyboard-layout switching.
		// Keep it discoverable, but pair it with the legacy-safe Ctrl+Alt form.
		defaultKeys: ["ctrl+alt+o", "alt+shift+o"],
		description:
			"Fold or unfold every tool call and worker block at once (no effect while /output verbose pins them open)",
	},
	"clio.tool.liveOutput": {
		defaultKeys: "alt+p",
		description: "Toggle streaming partial tool output in expanded tool bodies",
	},
	"clio.thinking.expand": {
		defaultKeys: "alt+r",
		description:
			"Toggle the latest thinking block between hidden marker and full body (no effect while /output verbose pins it open)",
	},
	"clio.thinking.expandAll": {
		// Ctrl+Alt+R is the fallback for terminals/OSes that do not forward
		// Alt+Shift+R as a distinct key event.
		defaultKeys: ["ctrl+alt+r", "alt+shift+r"],
		description:
			"Toggle all thinking blocks between hidden markers and full bodies (no effect while /output verbose pins them open)",
	},
	"clio.editor.external": {
		defaultKeys: "alt+g",
		description: "Open the current input in an external editor",
	},
	"clio.message.followUp": {
		defaultKeys: "alt+enter",
		description:
			"End of turn: queue the current input for delivery when the active run settles (Enter delivers it at the next slot, between tool batches)",
	},
	"clio.message.interrupt": {
		// Alt+I keeps the app scheme and earns the Ctrl+G leader fallback. A
		// Ctrl+Enter chord was rejected because legacy terminals send it as a
		// plain Enter, which would turn every send into a cancel.
		defaultKeys: "alt+i",
		description:
			"Interrupt: cancel the active run and deliver the current input now (refused while an attached dispatch runs or a permission ask is parked; the input then queues for the next slot)",
	},
	"clio.message.dequeue": {
		defaultKeys: "alt+up",
		description: "Restore queued steering and follow-up messages to the editor",
	},
	"clio.notifications.dismiss": {
		defaultKeys: "alt+x",
		description: "Dismiss footer notifications",
	},
	"clio.leader": {
		defaultKeys: "ctrl+g",
		description: "Start portable leader-key fallback for Alt shortcuts",
	},
} as const satisfies KeybindingDefinitions;

/**
 * Full definition table = pi-tui editor/select defaults + Clio app ids.
 * pi-tui 0.84 supplies dedicated prompt-history actions but leaves them
 * unbound for applications to place. Clio uses the readline-style Ctrl+P and
 * Ctrl+N pair because its model cycling already lives on Alt+J and Alt+K.
 */
export const CLIO_KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"tui.editor.historyPrevious": {
		...TUI_KEYBINDINGS["tui.editor.historyPrevious"],
		defaultKeys: "ctrl+p",
	},
	"tui.editor.historyNext": {
		...TUI_KEYBINDINGS["tui.editor.historyNext"],
		defaultKeys: "ctrl+n",
	},
	...CLIO_APP_KEYBINDINGS,
} as const satisfies KeybindingDefinitions;

export const CLIO_APP_KEYBINDING_IDS = Object.keys(CLIO_APP_KEYBINDINGS) as ReadonlyArray<ClioKeybinding>;
