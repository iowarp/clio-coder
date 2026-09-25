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
import { installDiagnosticSink } from "../core/diagnostics.js";
import { getTerminationCoordinator } from "../core/termination.js";
import {
	type Component,
	Container,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	ScrollView,
	type TUI,
	VStack,
} from "../engine/tui.js";
import { ClioEditor, type EditorChrome } from "./clio-editor.js";
import { createProcessInteractiveShell } from "./interactive-shell.js";
import { type ClioKeybindingManager, createKeybindingManager, formatKeyLabel } from "./keybinding-manager.js";
import { clioTheme, GLYPH } from "./theme/index.js";
import { createBootWelcome } from "./welcome-dashboard.js";

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

/**
 * How long the Stage 0 editor could not answer input. Stage 0 paints before
 * hydration, but keystrokes echo only when the event loop turns, so the longest
 * loop block between the two frames is what an operator typing at Stage 0 waits.
 * Times are milliseconds since process start.
 */
export interface BootInteractivity {
	readonly stage0Ms: number;
	readonly hydratedMs: number;
	readonly inputBlockedMaxMs: number;
}

export interface TerminalLeaseAdoption {
	root: Component;
	editorChrome: EditorChrome;
	admitSubmission: (submission: BootSubmission) => Promise<void>;
	onHydratedFrame?: (frameId: number | null, interactivity: BootInteractivity) => void;
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

interface RootHost extends Component {
	replace(next: Component): void;
}

/** Fullscreen lays the root out against the viewport height, so its host is a flex stack. */
class FlexRootHost extends VStack implements RootHost {
	constructor(current: Component) {
		super();
		this.replace(current);
	}

	replace(next: Component): void {
		this.clear();
		this.addChild(next, { grow: 1, shrink: 1, minSize: 1 });
	}
}

/**
 * Regular mode renders into scrollback with no height to allocate, so its host
 * only delegates. A stack here copied every transcript row twice per frame, the
 * second time through a spread push that throws once a transcript passes
 * roughly 150k rows.
 */
class DirectRootHost implements RootHost {
	constructor(private current: Component) {}

	replace(next: Component): void {
		this.current = next;
	}

	render(width: number): string[] {
		return this.current.render(width);
	}

	invalidate(): void {
		this.current.invalidate();
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
	settings: Readonly<ClioSettings>,
	submitKeyLabel: string | null,
	editor: ClioEditor,
	pending: Component,
	shutdownArmed: () => boolean,
	keybindings: ClioKeybindingManager,
): Component {
	const theme = clioTheme();
	const heading = createBootWelcome(settings, submitKeyLabel, (action) => {
		const key = keybindings.isDisabled(action) ? undefined : keybindings.getKeys(action)[0];
		return key ? formatKeyLabel(key, "") : null;
	});
	const footer: Component = {
		render: () =>
			shutdownArmed() ? [theme.fg("warning", "Ctrl+C again to exit · typed input will be recovered")] : [""],
		invalidate: () => {},
	};
	if (settings.interface.mode === "fullscreen") {
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
			[settings.chat.target, settings.chat.model].filter((part) => part && part.length > 0).join("·") || "starting",
		getThinkingLabel: () => settings.chat.thinkingLevel ?? "off",
		getOutputStyle: () => settings.interface.outputDetail,
		getAutonomy: () => settings.safety.autonomy,
		getSubmitKeyLabel: () => keybindings.getKeys("tui.input.submit")[0] ?? "Enter",
		getNewlineKeyLabel: () => keybindings.getKeys("tui.input.newLine")[0] ?? "Ctrl+J",
	};
	// Presentation drives the lease's editor through this proxy, so a chrome
	// field it omits never reaches the rail. It dropped the output style and
	// Alt+O left the thinking rail on the Standard label (BT-009). Required
	// makes the next new field a type error here; the animation clock is a
	// rendering-test seam that the editor already defaults.
	const editorChromeProxy: Required<Omit<EditorChrome, "getAnimationTime">> = {
		getModelLabel: () => editorChrome.getModelLabel(),
		getThinkingLabel: () => editorChrome.getThinkingLabel(),
		getOutputStyle: () => editorChrome.getOutputStyle?.() ?? settings.interface.outputDetail,
		getAutonomy: () => editorChrome.getAutonomy?.() ?? settings.safety.autonomy,
		isStreaming: () => editorChrome.isStreaming?.() ?? false,
		isAwaitingApproval: () => editorChrome.isAwaitingApproval?.() ?? false,
		getPermissionInspection: () => editorChrome.getPermissionInspection?.() ?? "none",
		getTurnPreparation: () => editorChrome.getTurnPreparation?.() ?? "idle",
		willEnterSteer: (text) => editorChrome.willEnterSteer?.(text) ?? false,
		getSubmitKeyLabel: () => editorChrome.getSubmitKeyLabel?.() ?? "Enter",
		getNewlineKeyLabel: () => editorChrome.getNewlineKeyLabel?.() ?? "Ctrl+J",
	};
	const shell =
		options.testing?.shell ??
		createProcessInteractiveShell({
			tuiMode: settings.interface.mode,
			...(options.onStage0Commit ? { onFirstFrameCommit: options.onStage0Commit } : {}),
		});
	const tui = shell.tui as TUI;
	const editor = new ClioEditor(tui, editorChromeProxy);
	editor.focused = true;
	const pendingPanel = new BootSubmissionPanel();
	let shutdownArmed = false;
	const submitKey = keybindings.isDisabled("tui.input.submit") ? undefined : keybindings.getKeys("tui.input.submit")[0];
	const stage0 = stageZeroRoot(
		settings,
		submitKey ? formatKeyLabel(submitKey, "") : null,
		editor,
		pendingPanel,
		() => shutdownArmed,
		keybindings,
	);
	const host: RootHost =
		settings.interface.mode === "fullscreen" ? new FlexRootHost(stage0) : new DirectRootHost(stage0);

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
	let removeDiagnosticSink = () => {};
	let stage0Ms = 0;
	// A delay histogram records a sample only when its timer fires, so one block
	// spanning the whole window reads as zero. Track loop turns directly and
	// count the gap still open when hydration commits.
	let turnProbe: NodeJS.Timeout | null = null;
	let lastTurnAt = 0;
	let longestTurnGap = 0;
	const finishInputBlock = (): number => {
		if (!turnProbe) return 0;
		clearInterval(turnProbe);
		turnProbe = null;
		return Math.max(longestTurnGap, performance.now() - lastTurnAt);
	};

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
		if (submissions.length > 0) {
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
		if (isKeyRelease(data)) return { consume: true };
		if (
			isKeyRepeat(data) &&
			(matchesKey(data, "ctrl+c") ||
				keybindings.matches(data, "clio-coder.exit") ||
				keybindings.matches(data, "tui.input.submit"))
		)
			return { consume: true };
		if (matchesKey(data, "ctrl+c")) {
			handleStage0CtrlC();
			return { consume: true };
		}
		if (keybindings.matches(data, "clio-coder.exit") && editor.getText().length === 0 && submissions.length === 0) {
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
	const removeStableInput = tui.setApplicationInputPolicy(stableInput);
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
				const interactivity = {
					stage0Ms,
					hydratedMs: performance.now(),
					inputBlockedMaxMs: finishInputBlock(),
				};
				if (epoch === adoptedEpoch && state === "adopted") adoption.onHydratedFrame?.(frameId, interactivity);
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
					attempt(() => finishInputBlock());
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
					removeDiagnosticSink();
				}
				if (errors.length > 0) throw new AggregateError(errors, "terminal lease cleanup failed");
			})();
			return closePromise;
		},
		fail(): Promise<void> {
			return lease.close({ recoverInput: true });
		},
	};

	removeDiagnosticSink = installDiagnosticSink((text) => lease.writeDiagnostic("stderr", text));
	termination.onDrain(() => lease.close({ recoverInput: state !== "adopted" }));
	try {
		shell.mount(host, editor);
		state = "mounted";
		// TuiBase.start() schedules its initial frame. The orchestrator import that
		// follows is synchronous module evaluation and would starve that callback,
		// turning Stage 0 into a label on the eventual Stage 1 paint. Commit the
		// shell now so the terminal write actually precedes heavyweight hydration.
		tui.renderNow(false);
		stage0Ms = performance.now();
		lastTurnAt = stage0Ms;
		turnProbe = setInterval(() => {
			const now = performance.now();
			longestTurnGap = Math.max(longestTurnGap, now - lastTurnAt);
			lastTurnAt = now;
		}, 10);
		turnProbe.unref();
	} catch (error) {
		void lease.close({ recoverInput: true }).catch(() => {});
		throw error;
	}
	return lease;
}
