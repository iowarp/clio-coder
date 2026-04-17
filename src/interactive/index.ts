import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { SuperModeConfirmation } from "../domains/modes/contract.js";
import type { ModesContract } from "../domains/modes/index.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { Editor, ProcessTerminal, TUI, Text } from "../engine/tui.js";
import { buildFooter } from "./footer-panel.js";
import { buildLayout, defaultBanner } from "./layout.js";
import { renderSuperOverlayLines } from "./super-overlay.js";

export interface InteractiveDeps {
	modes: ModesContract;
	providers: ProvidersContract;
	dispatch: DispatchContract;
	onShutdown: () => Promise<void>;
}

export const SHIFT_TAB = "\x1b[Z";
export const CTRL_D = "\x04";
export const ALT_S = "\x1bs";
export const ENTER = "\r";
export const ESC = "\x1b";

export interface KeyBindingDeps {
	cycleMode: () => void;
	requestShutdown: () => void;
	requestSuper: () => void;
}

export interface SuperOverlayKeyDeps {
	cancelSuper: () => void;
	confirmSuper: (conf: SuperModeConfirmation) => void;
	now: () => number;
}

/** Pure key router: returns true when the input was consumed. */
export function routeInteractiveKey(data: string, deps: KeyBindingDeps): boolean {
	if (data === ALT_S) {
		deps.requestSuper();
		return true;
	}
	if (data === SHIFT_TAB) {
		deps.cycleMode();
		return true;
	}
	if (data === CTRL_D) {
		deps.requestShutdown();
		return true;
	}
	return false;
}

/** Pure overlay key router: returns true when the input was consumed. */
export function routeSuperOverlayKey(data: string, deps: SuperOverlayKeyDeps): boolean {
	if (data === ENTER) {
		deps.confirmSuper({
			requestedBy: "keybind",
			acceptedAt: deps.now(),
		});
		return true;
	}
	if (data === ESC) {
		deps.cancelSuper();
		return true;
	}
	return false;
}

export type SlashCommand =
	| { kind: "quit" }
	| { kind: "help" }
	| { kind: "run"; agentId: string; task: string }
	| { kind: "run-usage" }
	| { kind: "unknown"; text: string }
	| { kind: "empty" };

/** Pure slash-command parser: no I/O, no side effects. */
export function parseSlashCommand(input: string): SlashCommand {
	const trimmed = input.trim();
	if (trimmed.length === 0) return { kind: "empty" };
	if (trimmed === "/quit" || trimmed === "/exit") return { kind: "quit" };
	if (trimmed === "/help" || trimmed.startsWith("/help ")) return { kind: "help" };
	if (trimmed === "/run" || trimmed === "/run ") return { kind: "run-usage" };
	if (trimmed.startsWith("/run ")) {
		const rest = trimmed.slice(5).trim();
		const [agentId, ...taskParts] = rest.split(/\s+/);
		const task = taskParts.join(" ").trim();
		if (!agentId || !task) return { kind: "run-usage" };
		return { kind: "run", agentId, task };
	}
	return { kind: "unknown", text: trimmed };
}

export interface RunIo {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
}

/** Dispatches /run through the dispatch contract and streams events to stdout. */
export async function handleRun(agentId: string, task: string, dispatch: DispatchContract, io: RunIo): Promise<void> {
	try {
		const handle = await dispatch.dispatch({
			agentId,
			task,
			providerId: "faux",
			modelId: "faux-model",
			runtime: "native",
		});
		io.stdout(`\n[run] runId=${handle.runId}\n`);
		for await (const event of handle.events) {
			const e = event as { type?: string };
			if (e.type && e.type !== "heartbeat") {
				io.stdout(`[run] ${e.type}\n`);
			}
		}
		const receipt = await handle.finalPromise;
		io.stdout(`[run] done exit=${receipt.exitCode} tokens=${receipt.tokenCount}\n`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		io.stderr(`[run] failed: ${msg}\n`);
	}
}

const IDENTITY = (s: string): string => s;

export async function startInteractive(deps: InteractiveDeps): Promise<number> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	const banner = defaultBanner();
	const footer = buildFooter({ modes: deps.modes, providers: deps.providers });
	const editor = new Editor(tui, {
		borderColor: IDENTITY,
		selectList: {
			selectedPrefix: IDENTITY,
			selectedText: IDENTITY,
			description: IDENTITY,
			scrollInfo: IDENTITY,
			noMatch: IDENTITY,
		},
	});
	editor.focused = true;

	const superOverlayLines = renderSuperOverlayLines();
	const superOverlayWidth = superOverlayLines.reduce((max, line) => Math.max(max, line.length), 0);
	const superOverlay = new Text(superOverlayLines.join("\n"), 0, 0);

	const io: RunIo = {
		stdout: (s) => process.stdout.write(s),
		stderr: (s) => process.stderr.write(s),
	};

	editor.onSubmit = (text: string): void => {
		const command = parseSlashCommand(text);
		switch (command.kind) {
			case "empty":
				return;
			case "quit":
				void shutdown();
				return;
			case "help":
				io.stdout("\ncommands: /run <agent> <task>, /help, /quit\n");
				return;
			case "run-usage":
				io.stdout("\nusage: /run <agent> <task>\n");
				return;
			case "run":
				void (async () => {
					await handleRun(command.agentId, command.task, deps.dispatch, io);
					tui.requestRender();
				})();
				return;
			case "unknown":
				io.stderr(`[interactive] unknown input: ${command.text}\n`);
				return;
		}
	};

	const root = buildLayout({ banner, body: editor, footer: footer.view });
	tui.addChild(root);
	tui.start();

	let resolveRun: (code: number) => void = () => {};
	const run = new Promise<number>((resolve) => {
		resolveRun = resolve;
	});

	// Anchor the Node event loop while the TUI is alive. Piped or /dev/null
	// stdin (used by diag harnesses) can close early, which would otherwise
	// let the process exit before the termination coordinator runs.
	const keepAlive = setInterval(() => {}, 1 << 30);

	let overlayState: "closed" | "super-confirm" = "closed";
	let overlayHandle: ReturnType<TUI["showOverlay"]> | null = null;
	let shuttingDown = false;

	const closeSuperOverlay = (): void => {
		if (overlayState === "closed") return;
		overlayState = "closed";
		overlayHandle?.hide();
		overlayHandle = null;
		tui.requestRender();
	};

	const openSuperOverlay = (): void => {
		if (overlayState !== "closed") return;
		deps.modes.requestSuper("keybind");
		overlayState = "super-confirm";
		overlayHandle = tui.showOverlay(superOverlay, {
			anchor: "center",
			width: superOverlayWidth,
		});
		tui.requestRender();
	};

	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		clearInterval(keepAlive);
		try {
			tui.stop();
		} catch {
			// TUI may already be stopped; swallow.
		}
		await deps.onShutdown();
		resolveRun(0);
	};

	tui.addInputListener((data: string) => {
		if (overlayState === "super-confirm") {
			const consumed = routeSuperOverlayKey(data, {
				cancelSuper: () => {
					closeSuperOverlay();
				},
				confirmSuper: (conf) => {
					deps.modes.confirmSuper(conf);
					closeSuperOverlay();
					footer.refresh();
					tui.requestRender();
				},
				now: () => Date.now(),
			});
			return consumed ? { consume: true } : undefined;
		}

		const consumed = routeInteractiveKey(data, {
			cycleMode: () => {
				deps.modes.cycleNormal();
				footer.refresh();
				tui.requestRender();
			},
			requestShutdown: () => {
				void shutdown();
			},
			requestSuper: () => {
				openSuperOverlay();
			},
		});
		return consumed ? { consume: true } : undefined;
	});

	return run;
}
