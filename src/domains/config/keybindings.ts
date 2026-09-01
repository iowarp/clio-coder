/**
 * Clio app keybinding schema. Merges pi-tui's editor/select defaults (in
 * TUI_KEYBINDINGS) with the Clio-specific action ids so `KeybindingsManager`
 * can resolve both against user overrides stored in `settings.yaml`.
 *
 * The `Keybindings` interface in pi-tui is extensible via declaration merging.
 * Adding `clio-coder.*` ids here makes them typed everywhere the manager is
 * used: pass a wrong id to `matches("clio-coder.typo", ...)` and the compiler
 * complains.
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
	"clio-coder.thinking.cycle": true;
	"clio-coder.exit": true;
	"clio-coder.status.toggle": true;
	"clio-coder.session.tree": true;
	"clio-coder.dispatchBoard.toggle": true;
	"clio-coder.tasks.open": true;
	"clio-coder.decisions.open": true;
	"clio-coder.dispatch.background": true;
	"clio-coder.model.select": true;
	"clio-coder.model.cycleForward": true;
	"clio-coder.model.cycleBackward": true;
	"clio-coder.tool.expand": true;
	"clio-coder.tool.expandAll": true;
	"clio-coder.tool.liveOutput": true;
	"clio-coder.thinking.expand": true;
	"clio-coder.thinking.expandAll": true;
	"clio-coder.editor.external": true;
	"clio-coder.message.followUp": true;
	"clio-coder.message.interrupt": true;
	"clio-coder.message.dequeue": true;
	"clio-coder.notifications.dismiss": true;
	"clio-coder.leader": true;
}

export type ClioKeybinding = keyof ClioAppKeybindings;

/**
 * Declaration merge: pi-tui's `Keybindings` interface is open so downstream
 * packages register their action ids. After this block, `KeybindingsManager`
 * returned from `createKeybindingManager` accepts `clio-coder.*` ids with full
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
 * pi-tui's editor reserves except for the approved `Alt+B` and `Alt+D`
 * application-boundary overrides. They open the task and decision boards
 * before the editor can interpret those chords as word-back or word-delete.
 * The CSI-u/reserved-key detector in `keybinding-manager.ts` stays as a safety
 * net for user rebinds.
 */
export const CLIO_APP_KEYBINDINGS = {
	"clio-coder.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle orchestrator thinking level",
	},
	"clio-coder.exit": {
		defaultKeys: "ctrl+d",
		description: "Exit when the editor is empty",
	},
	"clio-coder.status.toggle": {
		defaultKeys: "alt+u",
		description: "Toggle the footer dashboard (compact / expanded)",
	},
	"clio-coder.session.tree": {
		defaultKeys: "alt+t",
		description: "Open the /tree navigator",
	},
	"clio-coder.dispatchBoard.toggle": {
		defaultKeys: "alt+w",
		description: "Toggle the dispatch (workers) board overlay",
	},
	"clio-coder.tasks.open": {
		// Approved application-boundary override of pi-tui editor word-back.
		defaultKeys: "alt+b",
		description: "Open the composite session and operator task board",
	},
	"clio-coder.decisions.open": {
		// Approved application-boundary override of pi-tui editor word-delete.
		defaultKeys: "alt+d",
		description: "Open the settled interview decision board",
	},
	"clio-coder.dispatch.background": {
		// Ctrl+B alone is pi-tui's editor cursor-left, so the Claude Code chord
		// cannot be the primary here. Alt+S ("send to background") keeps the app
		// scheme and earns the Ctrl+G leader fallback, which only alt+<letter>
		// bindings get; Ctrl+Alt+B stays for the b-for-background muscle memory.
		defaultKeys: ["alt+s", "ctrl+alt+b"],
		description: "Send the running attached dispatch to the background as a detached batch",
	},
	"clio-coder.model.select": {
		defaultKeys: "alt+l",
		description: "Open the model + targets selector",
	},
	"clio-coder.model.cycleForward": {
		defaultKeys: "alt+j",
		description: "Cycle to next scoped model",
	},
	"clio-coder.model.cycleBackward": {
		defaultKeys: "alt+k",
		description: "Cycle to previous scoped model",
	},
	"clio-coder.tool.expand": {
		defaultKeys: "alt+o",
		description:
			"Fold or unfold the newest tool call or worker block between its one-line summary and full details, overriding the /output level for that block",
	},
	"clio-coder.tool.expandAll": {
		// Alt+Shift+letter is commonly consumed by OS keyboard-layout switching.
		// Keep it discoverable, but pair it with the legacy-safe Ctrl+Alt form.
		defaultKeys: ["ctrl+alt+o", "alt+shift+o"],
		description:
			"Fold or unfold every tool call and worker block at once, overriding the /output level; changing /output clears the overrides",
	},
	"clio-coder.tool.liveOutput": {
		defaultKeys: "alt+p",
		description: "Toggle streaming partial tool output in expanded tool bodies",
	},
	"clio-coder.thinking.expand": {
		defaultKeys: "alt+r",
		description:
			"Toggle the latest thinking block between hidden marker and full body (no effect while /output verbose pins it open)",
	},
	"clio-coder.thinking.expandAll": {
		// Ctrl+Alt+R is the fallback for terminals/OSes that do not forward
		// Alt+Shift+R as a distinct key event.
		defaultKeys: ["ctrl+alt+r", "alt+shift+r"],
		description:
			"Toggle all thinking blocks between hidden markers and full bodies, overriding the /output level; changing /output clears the overrides",
	},
	"clio-coder.editor.external": {
		defaultKeys: "alt+g",
		description: "Open the current input in an external editor",
	},
	"clio-coder.message.followUp": {
		defaultKeys: "alt+enter",
		description:
			"End of turn: queue the current input for delivery when the active run settles (Enter delivers it at the next slot, between tool batches)",
	},
	"clio-coder.message.interrupt": {
		// Alt+I keeps the app scheme and earns the Ctrl+G leader fallback. A
		// Ctrl+Enter chord was rejected because legacy terminals send it as a
		// plain Enter, which would turn every send into a cancel.
		defaultKeys: "alt+i",
		description:
			"Interrupt: cancel the active run and deliver the current input now (refused while an attached dispatch runs or a permission ask is parked; the input then queues for the next slot)",
	},
	"clio-coder.message.dequeue": {
		defaultKeys: "alt+up",
		description: "Restore queued steering and follow-up messages to the editor",
	},
	"clio-coder.notifications.dismiss": {
		defaultKeys: "alt+x",
		description: "Dismiss footer notifications",
	},
	"clio-coder.leader": {
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
