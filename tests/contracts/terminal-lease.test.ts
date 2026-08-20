import { deepStrictEqual, match, rejects, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { terminalLeaseEligible } from "../../src/cli/clio.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { Component, TUI } from "../../src/engine/tui.js";
import type { InteractiveShell } from "../../src/interactive/interactive-shell.js";
import {
	createProcessTerminalLease,
	instantShellEnabled,
	type TuiInputDelegate,
} from "../../src/interactive/terminal-lease.js";

function component(line: string): Component {
	return { render: () => [line], invalidate: () => {} };
}

interface HarnessMetrics {
	stops: number;
	restores: number;
	inputRemovals: number;
	releases: number;
	settles: number;
	writeAttempts: number;
}

function emptyMetrics(): HarnessMetrics {
	return { stops: 0, restores: 0, inputRemovals: 0, releases: 0, settles: 0, writeAttempts: 0 };
}

function harness(
	options: {
		metrics?: HarnessMetrics;
		mountError?: Error;
		renderError?: Error;
		releaseError?: Error;
		stopError?: Error;
		settleError?: Error;
		writeError?: Error;
	} = {},
) {
	const metrics = options.metrics ?? emptyMetrics();
	let mountedRoot: Component | null = null;
	let focused: Component | null = null;
	let input: TuiInputDelegate | null = null;
	let processSigint: (() => void) | null = null;
	let drain: (() => void | Promise<void>) | null = null;
	let renders = 0;
	let frameSequence = 0;
	const frameWaiters: Array<(frame: number) => void> = [];
	const writes: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
	const terminal = { columns: 80, rows: 24 };
	const tui = {
		mode: "regular",
		terminal,
		addInputListener(listener: TuiInputDelegate) {
			input = listener;
			return () => {
				metrics.inputRemovals += 1;
				if (input === listener) input = null;
			};
		},
		addChild(root: Component) {
			mountedRoot = root;
		},
		setFocus(next: Component | null) {
			focused = next;
		},
		requestRender() {
			renders += 1;
			const frame = ++frameSequence;
			for (const resolve of frameWaiters.splice(0)) resolve(frame);
		},
		renderNow() {
			tui.requestRender();
			if (options.renderError) throw options.renderError;
		},
		start() {},
		stop() {
			metrics.stops += 1;
			if (options.stopError) throw options.stopError;
		},
	} as unknown as TUI;
	const shell = {
		terminal,
		tui,
		mount(root: Component, nextFocus: Component) {
			if (mountedRoot) return;
			tui.addChild(root);
			tui.setFocus(nextFocus);
			if (options.mountError) throw options.mountError;
		},
		anchor: async () => 0,
		releaseAnchor() {
			metrics.releases += 1;
			if (options.releaseError) throw options.releaseError;
		},
		stop() {
			tui.stop();
		},
		commitCurrentFrame: async () => null,
		hasObservedBackpressure: () => false,
		setStreamPacingActive() {},
		settle: async () => {
			metrics.settles += 1;
			if (options.settleError) throw options.settleError;
		},
		nextCommittedFrame: () => new Promise<number>((resolve) => frameWaiters.push(resolve)),
		complete() {},
	} as unknown as InteractiveShell;
	const lease = createProcessTerminalLease({
		settings: structuredClone(DEFAULT_SETTINGS),
		testing: {
			shell: shell as ReturnType<
				typeof import("../../src/interactive/interactive-shell.js").createProcessInteractiveShell
			>,
			termination: {
				installSignalHandlers() {},
				releaseInterruptOwnership: () => () => {
					metrics.restores += 1;
				},
				onDrain: (hook) => {
					drain = hook;
				},
				shutdown: async () => {},
			},
			signals: {
				on: (_signal, listener) => {
					processSigint = listener as () => void;
					return process as never;
				},
				off: (_signal, listener) => {
					if (processSigint === listener) processSigint = null;
					return process as never;
				},
			},
			write: (stream, text) => {
				metrics.writeAttempts += 1;
				if (options.writeError) throw options.writeError;
				writes.push({ stream, text });
			},
		},
	});
	return {
		lease,
		get root() {
			return mountedRoot;
		},
		get focus() {
			return focused;
		},
		get input() {
			return input;
		},
		get signal() {
			return processSigint;
		},
		get drain() {
			return drain;
		},
		get stops() {
			return metrics.stops;
		},
		get restores() {
			return metrics.restores;
		},
		get inputRemovals() {
			return metrics.inputRemovals;
		},
		get renders() {
			return renders;
		},
		writes,
		metrics,
	};
}

describe("single-owner terminal lease", () => {
	it("keeps the same root host and editor while draining immutable boot submissions serially", async () => {
		const h = harness();
		const host = h.root;
		const editor = h.lease.editor;
		strictEqual(h.focus, editor);
		editor.onSubmit?.("first");
		editor.onSubmit?.("second");
		editor.setText("later draft");
		match((host?.render(80) ?? []).join("\n"), /first/u);
		match((host?.render(80) ?? []).join("\n"), /second/u);

		let releaseFirst = (): void => {};
		const firstAdmission = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const admitted: string[] = [];
		const applicationInput = () => ({ consume: true as const });
		h.lease.registerApplicationInput(applicationInput);
		let applicationSigints = 0;
		h.lease.applicationSignals.on("SIGINT", () => {
			applicationSigints += 1;
		});
		const nextRoot = component("hydrated");
		strictEqual(
			h.lease.adopt({
				root: nextRoot,
				editorChrome: { getModelLabel: () => "ready", getThinkingLabel: () => "off" },
				admitSubmission: async (record) => {
					admitted.push(record.rawText);
					if (record.rawText === "first") await firstAdmission;
				},
			}),
			true,
		);
		strictEqual(h.root, host, "the TUI keeps one mounted root host");
		deepStrictEqual(host?.render(80), ["hydrated"]);
		strictEqual(h.lease.editor, editor, "the editor object is never reconstructed");
		strictEqual(editor.getText(), "later draft", "the post-submit draft survives adoption");
		deepStrictEqual(admitted, ["first"], "N+1 cannot overtake N's admission decision");
		h.signal?.();
		strictEqual(applicationSigints, 1, "the stable SIGINT listener routes to Stage 1 after adoption");

		releaseFirst();
		await new Promise<void>((resolve) => setImmediate(resolve));
		deepStrictEqual(admitted, ["first", "second"]);
		strictEqual(editor.getText(), "later draft");
	});

	it("closes exactly once, rejects stale adoption, and recovers queued input plus the draft", async () => {
		const h = harness();
		h.lease.editor.onSubmit?.("queued prompt");
		h.lease.editor.setText("unfinished draft");
		h.lease.writeDiagnostic("stderr", "boot warning\n");
		const first = h.lease.fail();
		strictEqual(h.lease.close(), first);
		await first;
		await h.drain?.();
		strictEqual(h.lease.state, "closed");
		strictEqual(h.stops, 1);
		strictEqual(h.restores, 1);
		strictEqual(h.inputRemovals, 1);
		strictEqual(h.signal, null);
		strictEqual(
			h.lease.adopt({
				root: component("too late"),
				editorChrome: { getModelLabel: () => "late", getThinkingLabel: () => "off" },
				admitSubmission: async () => {},
			}),
			false,
		);
		const stderr = h.writes
			.filter((entry) => entry.stream === "stderr")
			.map((entry) => entry.text)
			.join("");
		match(stderr, /boot warning/u);
		match(stderr, /\[queued 1\] queued prompt/u);
		match(stderr, /\[draft\] unfinished draft/u);
	});

	it("finishes one idempotent close transaction even when every teardown surface reports an error", async () => {
		const h = harness({
			releaseError: new Error("release failed"),
			stopError: new Error("stop failed"),
			settleError: new Error("settle failed"),
			writeError: new Error("write failed"),
		});
		h.lease.editor.onSubmit?.("recover me");
		h.lease.writeDiagnostic("stderr", "diagnostic\n");

		const first = h.lease.close({ recoverInput: true });
		strictEqual(h.lease.close(), first);
		await rejects(first, /terminal lease cleanup failed/u);
		strictEqual(h.lease.state, "closed");
		strictEqual(h.stops, 1);
		strictEqual(h.metrics.releases, 1);
		strictEqual(h.metrics.settles, 1);
		strictEqual(h.restores, 1);
		strictEqual(h.inputRemovals, 1);
		strictEqual(h.metrics.writeAttempts, 2, "diagnostic flush and recovery are each attempted once");
	});

	it("rolls back partial terminal ownership when mount or initial render throws", async () => {
		for (const fault of ["mount", "render"] as const) {
			const metrics = emptyMetrics();
			throws(
				() =>
					harness({
						metrics,
						...(fault === "mount" ? { mountError: new Error(fault) } : { renderError: new Error(fault) }),
					}),
				new RegExp(fault, "u"),
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			strictEqual(metrics.stops, 1, `${fault}: terminal stops once`);
			strictEqual(metrics.releases, 1, `${fault}: anchor releases once`);
			strictEqual(metrics.settles, 1, `${fault}: terminal settlement is awaited once`);
			strictEqual(metrics.restores, 1, `${fault}: signal ownership restores once`);
			strictEqual(metrics.inputRemovals, 1, `${fault}: input ownership restores once`);
		}
	});

	it("aborts an in-flight admission and recovers the whole remaining FIFO on close", async () => {
		const h = harness();
		h.lease.editor.onSubmit?.("first");
		h.lease.editor.onSubmit?.("second");
		h.lease.registerApplicationInput(() => ({ consume: true }));
		const entered: string[] = [];
		const completed: string[] = [];
		h.lease.adopt({
			root: component("hydrated"),
			editorChrome: { getModelLabel: () => "ready", getThinkingLabel: () => "off" },
			admitSubmission: async (record) => {
				entered.push(record.rawText);
				await new Promise<void>((_resolve, reject) => {
					const signal = h.lease.abortSignal;
					if (signal.aborted) return reject(signal.reason);
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
				completed.push(record.rawText);
			},
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		deepStrictEqual(entered, ["first"]);

		await h.lease.close();
		await new Promise<void>((resolve) => setImmediate(resolve));
		deepStrictEqual(completed, []);
		const stderr = h.writes
			.filter((entry) => entry.stream === "stderr")
			.map((entry) => entry.text)
			.join("");
		match(stderr, /\[queued 1\] first/u);
		match(stderr, /\[queued 2\] second/u);
	});

	it("retains a rejected FIFO record and every later record for ordered recovery", async () => {
		const h = harness();
		h.lease.editor.onSubmit?.("correctable");
		h.lease.editor.onSubmit?.("later");
		h.lease.registerApplicationInput(() => ({ consume: true }));
		const attempted: string[] = [];
		h.lease.adopt({
			root: component("hydrated"),
			editorChrome: { getModelLabel: () => "ready", getThinkingLabel: () => "off" },
			admitSubmission: async (record) => {
				attempted.push(record.rawText);
				throw new Error("needs correction");
			},
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		deepStrictEqual(attempted, ["correctable"], "later records cannot overtake a rejected FIFO head");

		await h.lease.close();
		const stderr = h.writes
			.filter((entry) => entry.stream === "stderr")
			.map((entry) => entry.text)
			.join("");
		match(stderr, /\[queued 1\] correctable/u);
		match(stderr, /\[queued 2\] later/u);
	});

	it("recovers a live adopted draft even after the boot FIFO is empty", async () => {
		const h = harness();
		h.lease.registerApplicationInput(() => ({ consume: true }));
		h.lease.adopt({
			root: component("hydrated"),
			editorChrome: { getModelLabel: () => "ready", getThinkingLabel: () => "off" },
			admitSubmission: async () => {},
		});
		h.lease.editor.setText("adopted unsent draft");

		await h.drain?.();
		const stderr = h.writes
			.filter((entry) => entry.stream === "stderr")
			.map((entry) => entry.text)
			.join("");
		match(stderr, /\[draft\] adopted unsent draft/u);
	});

	it("keeps the environment escape hatch explicit", () => {
		strictEqual(instantShellEnabled({}), true);
		strictEqual(instantShellEnabled({ CLIO_CODER_INSTANT_SHELL: "1" }), true);
		strictEqual(instantShellEnabled({ CLIO_CODER_INSTANT_SHELL: "0" }), false);
	});

	it("never lets an ambient interactive marker seize headless or ACP transport ownership", () => {
		const env = { CLIO_CODER_INTERACTIVE: "1" };
		strictEqual(terminalLeaseEligible({}, env), true);
		strictEqual(terminalLeaseEligible({ headless: { prompt: "hello" } }, env), false);
		strictEqual(terminalLeaseEligible({ acp: {} }, env), false);
	});
});
