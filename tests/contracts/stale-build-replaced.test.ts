import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { incompleteInstallationAcpAdvice } from "../../src/core/incomplete-installation.js";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import type { ProcessTerminal, Terminal } from "../../src/engine/tui.js";
import { ApplicationInputTuiMainScreen, VStack } from "../../src/engine/tui.js";
import { createProcessTerminalLease } from "../../src/interactive/terminal-lease.js";
import { buildIdPlugin, currentBuildId } from "../../tsup.config.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function missingChunk(path: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(`Cannot find module '${path}' imported from somewhere`);
	error.code = "ERR_MODULE_NOT_FOUND";
	return error;
}

it("mints a fresh build id for every build the bundler starts, watch rebuilds included", () => {
	const starts: (() => void)[] = [];
	const loads: (() => { contents: string })[] = [];
	buildIdPlugin.setup({
		onStart: (callback) => starts.push(callback),
		onLoad: (_options, callback) => loads.push(callback),
	});
	const ids: string[] = [];
	for (let build = 0; build < 2; build++) {
		for (const start of starts) start();
		const contents = loads[0]?.().contents ?? "";
		assert.ok(contents.includes(JSON.stringify(currentBuildId())), "the build id module carries this build's id");
		ids.push(currentBuildId());
	}
	assert.notEqual(ids[0], ids[1]);
});

it("tells an ACP client to restart the agent when its build was replaced", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-acp-replaced-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const outputDir = join(root, "dist");
	mkdirSync(outputDir);
	writeFileSync(join(outputDir, "build.json"), JSON.stringify({ id: "new-build", files: [] }));
	const advice = incompleteInstallationAcpAdvice(missingChunk(join(outputDir, "chunk-gone.js")), {
		outputDir,
		runningId: "old-build",
	});
	assert.equal(advice?.reason, "build_replaced");
	assert.match(advice?.message ?? "", /replaced; restart the agent from your editor/u);
	assert.doesNotMatch(advice?.message ?? "", /gui|chunk-gone|\n/iu, "host text only, no GUI advice and no path");
	assert.equal(incompleteInstallationAcpAdvice(new Error("unrelated")), null);
});

class QuietTerminal implements Terminal {
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
	setProgramStatus(): void {}
}

it("shows a notice and keeps the TUI running when a lazy chunk a rebuild deleted fails to load", () => {
	const noop = (): void => {};
	const terminal = new QuietTerminal();
	const tui = new ApplicationInputTuiMainScreen(terminal);
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const shutdowns: number[] = [];
	const lease = createProcessTerminalLease({
		settings: structuredClone(DEFAULT_SETTINGS),
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
				shutdown: async (code) => {
					shutdowns.push(code);
				},
			},
			signals: {
				on: (event: string, handler: (...args: unknown[]) => void) => {
					handlers.set(event, handler);
					return process;
				},
				off: () => process,
			} as unknown as Pick<NodeJS.Process, "on" | "off">,
			write: noop,
		},
	});
	cleanups.push(() => lease.close());
	lease.registerApplicationInput(() => undefined);
	const root = new VStack();
	root.addChild(lease.editor);
	const notices: string[] = [];
	assert.equal(
		lease.adopt({
			root,
			editorChrome: { getModelLabel: () => "ready", getThinkingLabel: () => "off" },
			admitSubmission: async () => {},
			notice: (text) => notices.push(text),
		}),
		true,
	);
	const gone = missingChunk(join(resolvePackageRoot(), "dist", "chunk-replaced-by-rebuild.js"));
	handlers.get("unhandledRejection")?.(gone, Promise.resolve());
	assert.equal(notices.length, 1, "the advice reaches the operator as a notice");
	assert.deepEqual(shutdowns, [], "the session keeps running");
});
