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

function topRail(target: TerminalLease): string {
	return stripTerminalSequences(target.editor.render(80)[0] ?? "");
}

// BT-009: the instant shell hands presentation the lease's editor, which reads
// its chrome through a forwarding proxy. The proxy dropped the output style, so
// Alt+O restyled the transcript while the rail stayed on the Standard label.
it("keeps the composer thinking rail on the live output style across the Stage 0 lease", () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.thinkingLevel = "medium";
	settings.interface.outputDetail = "compact";
	const shell = lease(settings);
	assert.match(topRail(shell), /\bT ▰▰▱▱▱/u, "Stage 0 honors the configured compact style");
	assert.doesNotMatch(topRail(shell), /think/u);

	let style: OutputStyle = "compact";
	shell.registerApplicationInput(() => undefined);
	const root = new VStack();
	root.addChild(shell.editor);
	assert.equal(
		shell.adopt({
			root,
			editorChrome: {
				getModelLabel: () => "ready",
				getThinkingLabel: () => "medium",
				getOutputStyle: () => style,
			},
			admitSubmission: async () => {},
		}),
		true,
	);

	assert.match(topRail(shell), /\bT ▰▰▱▱▱/u);
	assert.doesNotMatch(topRail(shell), /think/u);
	style = "standard";
	assert.match(topRail(shell), /think ▰▰▱▱▱/u);
	assert.doesNotMatch(topRail(shell), /▱ medium/u);
	style = "detailed";
	assert.match(topRail(shell), /think ▰▰▱▱▱ medium/u);
});
