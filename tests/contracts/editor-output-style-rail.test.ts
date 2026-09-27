import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import type { OutputStyle } from "../../src/core/defaults.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProcessTerminal, Terminal } from "../../src/engine/tui.js";
import { stripTerminalSequences, TuiMainScreen, VStack } from "../../src/engine/tui.js";
import type { TerminalLease } from "../../src/interactive/terminal-lease.js";
import { createProcessTerminalLease } from "../../src/interactive/terminal-lease.js";

class RailTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

const noop = (): void => {};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function lease(settings: ClioSettings): TerminalLease {
	const terminal = new RailTerminal();
	const tui = new TuiMainScreen(terminal);
	const created = createProcessTerminalLease({
		settings,
		testing: {
			shell: {
				terminal: terminal as unknown as ProcessTerminal,
				tui,
				mount(root, focus) {
					tui.addChild(root);
					tui.setFocus(focus);
				},
				anchor: async () => 0,
				releaseAnchor: noop,
				stop: noop,
				settle: async () => {},
				complete: noop,
				commitCurrentFrame: async () => null,
				hasObservedBackpressure: () => false,
				setStreamPacingActive: noop,
				nextCommittedFrame: async () => null,
			},
			termination: {
				installSignalHandlers: noop,
				releaseInterruptOwnership: () => noop,
				onDrain: noop,
				shutdown: async () => {},
			},
			signals: { on: () => process, off: () => process },
			write: noop,
		},
	});
	cleanups.push(() => created.close());
	return created;
}

function thinkingRail(target: TerminalLease): string {
	return stripTerminalSequences(target.editor.render(80).at(-1) ?? "");
}

// BT-009: the adopted editor reads live chrome through the lease proxy. Thinking
// now lives on the bottom rail and remains independent of transcript detail.
it("keeps the bottom thinking rail coherent across Stage 0 adoption and output styles", () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.thinkingLevel = "medium";
	settings.interface.outputDetail = "compact";
	const shell = lease(settings);
	assert.match(thinkingRail(shell), /think medium/u, "Stage 0 exposes the configured effort on the bottom rail");

	let style: OutputStyle = "compact";
	let effort = "medium";
	shell.registerApplicationInput(() => undefined);
	const root = new VStack();
	root.addChild(shell.editor);
	assert.equal(
		shell.adopt({
			root,
			editorChrome: {
				getModelLabel: () => "ready",
				getThinkingLabel: () => effort,
				getOutputStyle: () => style,
			},
			admitSubmission: async () => {},
		}),
		true,
	);

	for (const next of ["compact", "standard", "detailed"] as const) {
		style = next;
		assert.match(thinkingRail(shell), /think medium/u, "effort remains visible across style changes and adoption");
	}
	effort = "high";
	assert.match(thinkingRail(shell), /think high/u, "adopted chrome forwards live effort changes");
});
