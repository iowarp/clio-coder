/**
 * Single-owner Stage 0 -> Stage 1 terminal transaction.
 *
 * This module is deliberately a leaf of the interactive graph. It constructs
 * the one terminal, renderer, root host, editor, input listener, and SIGINT
 * listener used for the entire interactive process. Hydration swaps delegates
 * and the root host synchronously; it never starts a second terminal or copies
 * editor text into a replacement editor.
 */

import type { ClioSettings } from "../core/config.js";
import { getTerminationCoordinator } from "../core/termination.js";
import { type Component, Container, matchesKey, ScrollView, Text, type TUI, VStack } from "../engine/tui.js";
import { ClioEditor, type EditorChrome } from "./clio-editor.js";
import { createProcessInteractiveShell } from "./interactive-shell.js";
import { type ClioKeybindingManager, createKeybindingManager } from "./keybinding-manager.js";
import { clioTheme, GLYPH } from "./theme/index.js";

export const INSTANT_SHELL_ENV = "CLIO_CODER_INSTANT_SHELL";
const DOUBLE_TAP_MS = 500;
const DIAGNOSTIC_LIMIT_BYTES = 64 * 1024;

export type TerminalLeaseState = "created" | "mounted" | "adopting" | "adopted" | "closing" | "closed";

export interface BootSubmission {
	readonly sequence: number;
	readonly rawText: string;
	readonly submittedAt: number;
}

export interface BootDiagnostic {
	readonly stream: "stdout" | "stderr";
	readonly text: string;
}

export type TuiInputDelegate = (data: string) => { consume?: boolean; data?: string } | undefined;

export interface TerminalLeaseSignalCoordinator {
	takeInterruptOwnership(): () => void;
	on(signal: "SIGINT", listener: () => void): void;
	off(signal: "SIGINT", listener: () => void): void;
}

export interface TerminalLeaseAdoption {
	root: Component;
	editorChrome: EditorChrome;
	admitSubmission: (submission: BootSubmission) => Promise<void>;
	onHydratedFrame?: (frameId: number | null) => void;
}

export interface TerminalLease {
	readonly shell: ReturnType<typeof createProcessInteractiveShell>;
	readonly terminal: ReturnType<typeof createProcessInteractiveShell>["terminal"];
	readonly tui: TUI;
	readonly editor: ClioEditor;
	readonly keybindings: ClioKeybindingManager;
	readonly pending: Component;
	readonly state: TerminalLeaseState;
	readonly epoch: number;
	readonly abortSignal: AbortSignal;
	writeDiagnostic(stream: "stdout" | "stderr", text: string): void;
	/** Trace-only output held until after terminal restoration. */
	deferDiagnostic(stream: "stdout" | "stderr", text: string): void;
	takeDiagnostics(): BootDiagnostic[];
	registerApplicationInput(delegate: TuiInputDelegate): () => void;
	readonly applicationSignals: TerminalLeaseSignalCoordinator;
	adopt(adoption: TerminalLeaseAdoption): boolean;
	close(options?: { recoverInput?: boolean }): Promise<void>;
	fail(): Promise<void>;
}

export interface CreateProcessTerminalLeaseOptions {
	settings: Readonly<ClioSettings>;
	onStage0Commit?: (frameId: number) => void;
	shutdown?: (code: number) => void | Promise<void>;
	/** Narrow construction seams used by deterministic ownership contracts. */
	testing?: {
		shell?: ReturnType<typeof createProcessInteractiveShell>;
		termination?: {
			installSignalHandlers(): void;
			releaseInterruptOwnership(): () => void;
			onDrain(hook: () => void | Promise<void>): void;
			shutdown(code: number): Promise<void>;
		};
		signals?: Pick<NodeJS.Process, "on" | "off">;
		write?: (stream: "stdout" | "stderr", text: string) => void;
		now?: () => number;
	};
}

/** `0` is the immediate rollback. Unset and `1` enable the accepted default. */
export function instantShellEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
	return env[INSTANT_SHELL_ENV] !== "0";
}

class RootHost extends VStack {
	constructor(current: Component) {
		super();
		this.replace(current);
	}

	replace(next: Component): void {
		this.clear();
		this.addChild(next, { grow: 1, shrink: 1, minSize: 1 });
	}
}

class BootSubmissionPanel implements Component {
	private records: BootSubmission[] = [];

	set(records: ReadonlyArray<BootSubmission>): void {
		this.records = [...records];
	}

	render(width: number): string[] {
		if (this.records.length === 0) return [];
		const theme = clioTheme();
		return this.records.map((record) => {
			const oneLine = record.rawText.replace(/\s+/gu, " ").trim();
			const room = Math.max(0, width - 11);
			const preview = oneLine.length > room ? `${oneLine.slice(0, Math.max(0, room - 1))}…` : oneLine;
			return `${theme.fg("action", `${GLYPH.queued} queued`)} ${theme.fg("muted", preview)}`;
		});
	}

	invalidate(): void {}
}

function stageZeroRoot(
	mode: Readonly<ClioSettings>["terminal"]["tuiMode"],
	editor: ClioEditor,
	pending: Component,
	shutdownArmed: () => boolean,
): Component {
	const theme = clioTheme();
	const heading = new Text(
		`${theme.style("title", ">C_ Clio Coder", { bold: true })}\n${theme.fg("muted", "Hydrating session services…")}`,
		0,
		0,
	);
	const footer: Component = {
		render: () => [
			shutdownArmed()
				? theme.fg("warning", "Ctrl+C again to exit · typed input will be recovered")
				: theme.fg("dim", "Warming up · typing and submit are ready"),
		],
		invalidate: () => {},
	};
	if (mode === "fullscreen") {
		const document = new Container();
		document.addChild(heading);
		const transcript = new ScrollView(document, { follow: "end", primary: true, overscroll: "chain" });
		const dock = new VStack();
		dock.addChild(pending, { shrink: 1, minSize: 0 });
		dock.addChild(editor, { shrink: 1, minSize: 3 });
		dock.addChild(footer, { shrink: 1, minSize: 1 });
		const root = new VStack();
		root.addChild(transcript, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
		root.addChild(dock, { basis: "auto", grow: 0, shrink: 1, minSize: 1 });
		return root;
	}
	const root = new Container();
	root.addChild(heading);
	root.addChild(pending);
	root.addChild(editor);
	root.addChild(footer);
	return root;
}

function recoveryText(records: ReadonlyArray<BootSubmission>, draft: string): string | null {
	if (records.length === 0 && draft.length === 0) return null;
	const sections = records.map((record) => `[queued ${record.sequence}] ${record.rawText}`);
	if (draft.length > 0) sections.push(`[draft] ${draft}`);
	return `Clio Coder recovered input from an interrupted boot; copy and resubmit after restart:\n${sections.join("\n")}`;
}

export function createProcessTerminalLease(options: CreateProcessTerminalLeaseOptions): TerminalLease {
	const settings = options.settings;
	const keybindings = createKeybindingManager(settings);
	let editorChrome: EditorChrome = {
		getModelLabel: () =>
			[settings.orchestrator.target, settings.orchestrator.model].filter((part) => part && part.length > 0).join("·") ||
			"starting",
		getThinkingLabel: () => settings.orchestrator.thinkingLevel ?? "off",
		getSubmitKeyLabel: () => keybindings.getKeys("tui.input.submit")[0] ?? "Enter",
		getNewlineKeyLabel: () => keybindings.getKeys("tui.input.newLine")[0] ?? "Shift+Enter",
	};
	const editorChromeProxy: EditorChrome = {
		getModelLabel: () => editorChrome.getModelLabel(),
		getThinkingLabel: () => editorChrome.getThinkingLabel(),
		isStreaming: () => editorChrome.isStreaming?.() ?? false,
		isAwaitingApproval: () => editorChrome.isAwaitingApproval?.() ?? false,
		getPermissionInspection: () => editorChrome.getPermissionInspection?.() ?? "none",
		getTurnPreparation: () => editorChrome.getTurnPreparation?.() ?? "idle",
		willEnterSteer: (text) => editorChrome.willEnterSteer?.(text) ?? false,
		getSubmitKeyLabel: () => editorChrome.getSubmitKeyLabel?.() ?? "Enter",
		getNewlineKeyLabel: () => editorChrome.getNewlineKeyLabel?.() ?? "Shift+Enter",
	};
	const shell =
		options.testing?.shell ??
		createProcessInteractiveShell({
			tuiMode: settings.terminal.tuiMode,
			...(options.onStage0Commit ? { onFirstFrameCommit: options.onStage0Commit } : {}),
		});
	const tui = shell.tui as TUI;
	const editor = new ClioEditor(tui, editorChromeProxy);
	editor.focused = true;
	const pendingPanel = new BootSubmissionPanel();
	let shutdownArmed = false;
	const stage0 = stageZeroRoot(settings.terminal.tuiMode, editor, pendingPanel, () => shutdownArmed);
	const host = new RootHost(stage0);

	let state: TerminalLeaseState = "created";
	let epoch = 0;
	const bootAbort = new AbortController();
	let sequence = 0;
	const submissions: BootSubmission[] = [];
	const diagnostics: BootDiagnostic[] = [];
	const deferredDiagnostics: BootDiagnostic[] = [];
	let diagnosticBytes = 0;
	let deferredDiagnosticBytes = 0;
	let diagnosticsTruncated = false;
	let deferredDiagnosticsTruncated = false;
	let inputDelegate: TuiInputDelegate;
	let applicationInput: TuiInputDelegate | null = null;
	let applicationSignal: (() => void) | null = null;
	let lastCtrlCAt = 0;
	let closePromise: Promise<void> | null = null;
	let inputDisposed = false;
	let signalDisposed = false;

	const termination = options.testing?.termination ?? getTerminationCoordinator();
	const signals = options.testing?.signals ?? process;
	const now = options.testing?.now ?? Date.now;
	const write =
		options.testing?.write ??
		((stream: "stdout" | "stderr", text: string): void => {
			(stream === "stdout" ? process.stdout : process.stderr).write(text);
		});
	termination.installSignalHandlers();
	const restoreInterruptOwner = termination.releaseInterruptOwnership();

	const requestShutdown = (): void => {
		void (async () => {
			let cleanupError: unknown;
			try {
				await lease.close({ recoverInput: state !== "adopted" });
			} catch (error) {
				cleanupError = error;
			}
			if (options.shutdown) await options.shutdown(0);
			else await termination.shutdown(0);
			if (cleanupError) throw cleanupError;
		})().catch((error) => {
			try {
				write(
					"stderr",
					`Clio Coder: terminal shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			} catch {
				// Every restoration path was already attempted; there is no safer sink.
			}
		});
	};

	const handleStage0CtrlC = (): void => {
		const text = editor.getText();
		if (text.length > 0) {
			editor.setText("");
			shutdownArmed = false;
			lastCtrlCAt = 0;
			tui.requestRender();
			return;
		}
		const pressedAt = now();
		if (lastCtrlCAt > 0 && pressedAt - lastCtrlCAt <= DOUBLE_TAP_MS) {
			lastCtrlCAt = 0;
			requestShutdown();
			return;
		}
		lastCtrlCAt = pressedAt;
		shutdownArmed = true;
		tui.requestRender();
	};

	inputDelegate = (data) => {
		if (matchesKey(data, "ctrl+c")) {
			handleStage0CtrlC();
			return { consume: true };
		}
		if (keybindings.matches(data, "clio.exit") && editor.getText().length === 0) {
			requestShutdown();
			return { consume: true };
		}
		return undefined;
	};

	editor.onSubmit = (rawText) => {
		const record = Object.freeze({ sequence: ++sequence, rawText, submittedAt: performance.now() });
		submissions.push(record);
		pendingPanel.set(submissions);
		tui.requestRender();
	};

	const stableInput = (data: string) => inputDelegate(data);
	const removeStableInput = tui.addInputListener(stableInput);
	const stableSignal = (): void => {
		if (applicationSignal) applicationSignal();
		else handleStage0CtrlC();
	};
	signals.on("SIGINT", stableSignal);

	const disposeStableOwners = (): void => {
		if (!inputDisposed) {
			inputDisposed = true;
			removeStableInput();
		}
		if (!signalDisposed) {
			signalDisposed = true;
			signals.off("SIGINT", stableSignal);
			restoreInterruptOwner();
		}
	};

	const flushDiagnostics = (): void => {
		for (const diagnostic of [...diagnostics.splice(0), ...deferredDiagnostics.splice(0)]) {
			write(diagnostic.stream, diagnostic.text);
		}
	};
	const enqueueDiagnostic = (stream: "stdout" | "stderr", text: string, deferred: boolean): void => {
		const target = deferred ? deferredDiagnostics : diagnostics;
		const bytes = Buffer.byteLength(text, "utf8");
		const used = deferred ? deferredDiagnosticBytes : diagnosticBytes;
		if (used + bytes <= DIAGNOSTIC_LIMIT_BYTES) {
			target.push(Object.freeze({ stream, text }));
			if (deferred) deferredDiagnosticBytes += bytes;
			else diagnosticBytes += bytes;
			return;
		}
		const alreadyTruncated = deferred ? deferredDiagnosticsTruncated : diagnosticsTruncated;
		if (alreadyTruncated) return;
		if (deferred) deferredDiagnosticsTruncated = true;
		else diagnosticsTruncated = true;
		target.push({ stream: "stderr", text: "Clio Coder: additional boot diagnostics were truncated.\n" });
	};

	const lease: TerminalLease = {
		shell,
		terminal: shell.terminal,
		tui,
		editor,
		keybindings,
		pending: pendingPanel,
		get state() {
			return state;
		},
		get epoch() {
			return epoch;
		},
		get abortSignal() {
			return bootAbort.signal;
		},
		writeDiagnostic(stream, text): void {
			if (state === "closed") {
				write(stream, text);
				return;
			}
			enqueueDiagnostic(stream, text, false);
		},
		deferDiagnostic(stream, text): void {
			if (state === "closed") {
				write(stream, text);
				return;
			}
			enqueueDiagnostic(stream, text, true);
		},
		takeDiagnostics(): BootDiagnostic[] {
			const taken = diagnostics.splice(0);
			diagnosticBytes = 0;
			return taken;
		},
		registerApplicationInput(delegate): () => void {
			applicationInput = delegate;
			return () => {
				if (applicationInput === delegate) applicationInput = null;
			};
		},
		applicationSignals: {
			takeInterruptOwnership: () => () => {},
			on: (_signal, listener) => {
				applicationSignal = listener;
			},
			off: (_signal, listener) => {
				if (applicationSignal === listener) applicationSignal = null;
			},
		},
		adopt(adoption): boolean {
			if (state !== "mounted" || bootAbort.signal.aborted || !applicationInput) return false;
			state = "adopting";
			const adoptedEpoch = epoch;
			// No await is permitted in this transaction: editor callbacks, root,
			// input, and SIGINT become Stage 1 as one JavaScript turn.
			editorChrome = adoption.editorChrome;
			inputDelegate = applicationInput;
			host.replace(adoption.root);
			tui.setFocus(editor);
			state = "adopted";
			const hydratedFrame = shell.nextCommittedFrame();
			tui.requestRender();
			void hydratedFrame.then((frameId) => {
				if (epoch === adoptedEpoch && state === "adopted") adoption.onHydratedFrame?.(frameId);
			});
			void (async () => {
				for (const record of [...submissions]) {
					if (epoch !== adoptedEpoch || state !== "adopted") return;
					await adoption.admitSubmission(record);
					if (epoch !== adoptedEpoch || state !== "adopted") return;
					const index = submissions.findIndex((entry) => entry.sequence === record.sequence);
					if (index >= 0) submissions.splice(index, 1);
					pendingPanel.set(submissions);
					tui.requestRender();
				}
			})().catch((error) => {
				if (bootAbort.signal.aborted) return;
				lease.writeDiagnostic(
					"stderr",
					`Clio Coder: queued boot submission failed: ${error instanceof Error ? error.message : String(error)}\n`,
				);
			});
			return true;
		},
		close(closeOptions = {}): Promise<void> {
			if (closePromise) return closePromise;
			state = "closing";
			epoch += 1;
			closePromise = (async () => {
				const errors: unknown[] = [];
				const attempt = (operation: () => void): void => {
					try {
						operation();
					} catch (error) {
						errors.push(error);
					}
				};
				try {
					attempt(() => bootAbort.abort());
					attempt(() => disposeStableOwners());
					attempt(() => shell.releaseAnchor());
					attempt(() => shell.stop());
					try {
						await shell.settle();
					} catch (error) {
						errors.push(error);
					}
					attempt(() => flushDiagnostics());
					if (closeOptions.recoverInput || submissions.length > 0 || editor.getText().length > 0) {
						attempt(() => {
							const recovered = recoveryText(submissions, editor.getText());
							if (recovered) write("stderr", `${recovered}\n`);
						});
					}
				} finally {
					state = "closed";
				}
				if (errors.length > 0) throw new AggregateError(errors, "terminal lease cleanup failed");
			})();
			return closePromise;
		},
		fail(): Promise<void> {
			return lease.close({ recoverInput: true });
		},
	};

	termination.onDrain(() => lease.close({ recoverInput: state !== "adopted" }));
	try {
		shell.mount(host, editor);
		state = "mounted";
		// TuiBase.start() schedules its initial frame. The orchestrator import that
		// follows is synchronous module evaluation and would starve that callback,
		// turning Stage 0 into a label on the eventual Stage 1 paint. Commit the
		// shell now so the terminal write actually precedes heavyweight hydration.
		tui.renderNow(false);
	} catch (error) {
		void lease.close({ recoverInput: true }).catch(() => {});
		throw error;
	}
	return lease;
}
