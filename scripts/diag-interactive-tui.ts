/**
 * Phase 9 minimal TUI scaffold diag.
 *
 * This test mostly stays in-process and exercises the public seams that other
 * code paths (the orchestrator, the key router, the footer, the slash-command
 * router) depend on:
 *
 *   1. `startInteractive` is exported from src/interactive/index.ts as a
 *      function.
 *   2. `buildFooter` returns a Text whose initial render contains "mode=default"
 *      and the active provider's displayName when mock contracts are wired in.
 *   3. The Shift+Tab sequence ("\x1b[Z") routes through `routeInteractiveKey`
 *      to cycleNormal on the modes contract. Ctrl+D ("\x04") routes to
 *      requestShutdown.
 *   4. `parseSlashCommand` produces a discriminated union covering /quit,
 *      /help, /run <agent> <task>, /run with missing args, empty input, and
 *      unknown slash/plain input.
 *   5. `handleRun` invokes the injected DispatchContract with faux provider +
 *      model defaults, streams events (filtering heartbeats), and prints the
 *      final receipt summary. On dispatch error it surfaces to stderr.
 *   6. A child-process harness drives `/run` and `Ctrl+B` against the real
 *      interactive loop so the dispatch-board overlay is verified mid-stream.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BusChannels } from "../src/core/bus-events.js";
import { createSafeEventBus } from "../src/core/event-bus.js";
import type { DispatchContract, DispatchRequest } from "../src/domains/dispatch/contract.js";
import type { RunEnvelope, RunReceipt, RunStatus } from "../src/domains/dispatch/types.js";
import type { ModesContract } from "../src/domains/modes/index.js";
import type { ProviderListEntry, ProvidersContract } from "../src/domains/providers/contract.js";
import {
	type DispatchBoardRow,
	createDispatchBoardStore,
	formatDispatchBoardLines,
} from "../src/interactive/dispatch-board.js";
import { buildFooter } from "../src/interactive/footer-panel.js";
import {
	ALT_S,
	CTRL_B,
	CTRL_D,
	ENTER,
	ESC,
	SHIFT_TAB,
	handleRun,
	parseSlashCommand,
	routeDispatchBoardOverlayKey,
	routeInteractiveKey,
	routeOverlayKey,
	routeProvidersOverlayKey,
	routeSuperOverlayKey,
	startInteractive,
} from "../src/interactive/index.js";
import { formatProvidersOverlayLines } from "../src/interactive/providers-overlay.js";
import { renderSuperOverlayLines } from "../src/interactive/super-overlay.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-interactive-tui] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-interactive-tui] FAIL ${label}${detail ? ` - ${detail}` : ""}\n`);
}

function makeMockModes(): ModesContract & { cycleCalls: number } {
	let current: "default" | "advise" | "super" = "default";
	let cycleCalls = 0;
	return {
		current: () => current,
		setMode: (next) => {
			current = next as typeof current;
			return current;
		},
		cycleNormal: () => {
			cycleCalls += 1;
			current = current === "default" ? "advise" : "default";
			return current;
		},
		visibleTools: () => new Set(),
		isToolVisible: () => true,
		isActionAllowed: () => true,
		requestSuper: () => {},
		confirmSuper: () => "super",
		get cycleCalls() {
			return cycleCalls;
		},
	} as ModesContract & { cycleCalls: number };
}

function makeMockProviders(): ProvidersContract {
	const entries: ProviderListEntry[] = [
		{
			id: "anthropic",
			displayName: "Anthropic",
			tier: "sdk",
			available: true,
			reason: "mock",
			health: {
				providerId: "anthropic",
				status: "unknown",
				lastCheckAt: null,
				lastError: null,
				latencyMs: null,
			},
		},
	];
	return {
		list: () => entries,
		getAdapter: () => null,
		probeAll: async () => {},
		credentials: {
			hasKey: () => false,
			set: () => {},
			remove: () => {},
		},
	};
}

interface MockDispatch extends DispatchContract {
	calls: DispatchRequest[];
}

function makeMockDispatch(options?: {
	events?: Array<{ type: string }>;
	receipt?: Partial<RunReceipt>;
	throwOnDispatch?: Error;
}): MockDispatch {
	const calls: DispatchRequest[] = [];
	const events = options?.events ?? [{ type: "start" }, { type: "heartbeat" }, { type: "stdout" }, { type: "end" }];
	const receipt: RunReceipt = {
		runId: "run-mock-1",
		agentId: "scout",
		task: "hello",
		providerId: "faux",
		modelId: "faux-model",
		runtime: "native",
		startedAt: "2026-04-17T00:00:00.000Z",
		endedAt: "2026-04-17T00:00:01.000Z",
		exitCode: 0,
		tokenCount: 42,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.0-dev",
		piMonoVersion: "0.67.4",
		platform: "linux",
		nodeVersion: "v20",
		toolCalls: 0,
		sessionId: null,
		...options?.receipt,
	};
	async function* iter(): AsyncIterableIterator<unknown> {
		for (const e of events) yield e;
	}
	const contract: MockDispatch = {
		calls,
		dispatch: async (req) => {
			calls.push(req);
			if (options?.throwOnDispatch) throw options.throwOnDispatch;
			return {
				runId: receipt.runId,
				events: iter(),
				finalPromise: Promise.resolve(receipt),
			};
		},
		listRuns: (_status?: RunStatus): ReadonlyArray<RunEnvelope> => [],
		getRun: () => null,
		abort: () => {},
		drain: async () => {},
	};
	return contract;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readUtf8(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function fileLength(path: string): number {
	return readUtf8(path).length;
}

async function waitForResult(
	label: string,
	probe: () => { ok: true; detail: string } | { ok: false; detail: string },
	timeoutMs = 5_000,
	pollMs = 20,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastDetail = "";
	while (Date.now() <= deadline) {
		const result = probe();
		lastDetail = result.detail;
		if (result.ok) return result.detail;
		await sleep(pollMs);
	}
	throw new Error(`${label}: ${lastDetail}`);
}

interface InteractiveStreamProbe {
	stdout: string;
	stderr: string;
	midLog: string;
	finalLog: string;
	exitCode: number | null;
}

async function typeText(stream: NodeJS.WritableStream, text: string, delayMs = 5): Promise<void> {
	for (const char of text) {
		stream.write(char);
		await sleep(delayMs);
	}
}

async function runInteractiveStreamProbe(): Promise<InteractiveStreamProbe> {
	const projectRoot = process.cwd();
	const tempRoot = mkdtempSync(join(tmpdir(), "clio-diag-interactive-tui-"));
	const childPath = join(tempRoot, "interactive-stream-probe.ts");
	const writeLogPath = join(tempRoot, "interactive-stream-probe.log");
	const tsxPath = join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
	const busEventsUrl = pathToFileURL(join(projectRoot, "src/core/bus-events.ts")).href;
	const eventBusUrl = pathToFileURL(join(projectRoot, "src/core/event-bus.ts")).href;
	const interactiveUrl = pathToFileURL(join(projectRoot, "src/interactive/index.ts")).href;

	const childSource = `
import { setTimeout as sleep } from "node:timers/promises";
import { BusChannels } from ${JSON.stringify(busEventsUrl)};
import { createSafeEventBus } from ${JSON.stringify(eventBusUrl)};
import { startInteractive } from ${JSON.stringify(interactiveUrl)};

const bus = createSafeEventBus();
const runId = "run-live-overlay";
const usage = { input: 7, output: 13, cacheRead: 5, cacheWrite: 3 };
const receipt = {
	runId,
	agentId: "scout",
	task: "stream smoke",
	providerId: "faux",
	modelId: "faux-model",
	runtime: "native",
	startedAt: "2026-04-17T00:00:00.000Z",
	endedAt: "2026-04-17T00:00:01.000Z",
	exitCode: 0,
	tokenCount: 28,
	costUsd: 0,
	compiledPromptHash: null,
	staticCompositionHash: null,
	clioVersion: "0.1.0-dev",
	piMonoVersion: "0.67.4",
	platform: "linux",
	nodeVersion: "v20",
	toolCalls: 1,
	sessionId: null,
};

const modes = {
	current: () => "default",
	setMode: (next) => next,
	cycleNormal: () => "default",
	visibleTools: () => new Set(),
	isToolVisible: () => true,
	isActionAllowed: () => true,
	requestSuper: () => {},
	confirmSuper: () => "super",
};

const providers = {
	list: () => [
		{
			id: "faux",
			displayName: "Faux",
			tier: "sdk",
			available: true,
			reason: "diag",
			health: {
				providerId: "faux",
				status: "healthy",
				lastCheckAt: null,
				lastError: null,
				latencyMs: null,
			},
		},
	],
	getAdapter: () => null,
	probeAll: async () => {},
	credentials: {
		hasKey: () => false,
		set: () => {},
		remove: () => {},
	},
};

	const dispatch = {
		dispatch: async (req) => {
			bus.emit(BusChannels.DispatchEnqueued, {
				runId,
			agentId: req.agentId,
			providerId: "faux",
			modelId: "faux-model",
			runtime: "native",
		});
		bus.emit(BusChannels.DispatchStarted, {
			runId,
			agentId: req.agentId,
			providerId: "faux",
			modelId: "faux-model",
			runtime: "native",
		});
			const events = [
				{ type: "heartbeat" },
				{ type: "message_update", message: { content: [{ type: "text", text: "partial" }] } },
				{ type: "tool_execution_start", toolCallId: "t1", toolName: "read" },
				{ type: "tool_execution_update", toolCallId: "t1", delta: "chunk" },
				{ type: "turn_end", toolResults: [{ toolCallId: "t1", result: "ok" }] },
				{ type: "message_end", message: { role: "assistant", usage } },
				{
					type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						usage,
						stopReason: "stop",
					},
				],
			},
		];
		let finishStream = () => {};
		const streamFinished = new Promise((resolve) => {
			finishStream = resolve;
		});
		async function* iter() {
			for (const event of events) {
				yield event;
				await sleep(event.type === "heartbeat" ? 25 : 180);
			}
			finishStream();
		}
		const finalPromise = (async () => {
			await streamFinished;
			bus.emit(BusChannels.DispatchCompleted, {
				runId,
				agentId: req.agentId,
				providerId: "faux",
				modelId: "faux-model",
				runtime: "native",
				tokenCount: receipt.tokenCount,
				costUsd: 0,
				durationMs: 1000,
			});
			process.stderr.write("[child] completed\\n");
			return receipt;
		})();
		return { runId, events: iter(), finalPromise };
	},
	listRuns: () => [],
	getRun: () => null,
	abort: () => {},
	drain: async () => {},
};

bus.on(BusChannels.DispatchProgress, (raw) => {
	process.stderr.write("[child] progress " + String(raw?.event?.type ?? "unknown") + "\\n");
});
bus.on(BusChannels.DispatchCompleted, () => {
	process.stderr.write("[child] bus completed\\n");
});

async function main() {
	const run = startInteractive({
		bus,
		modes,
		providers,
		dispatch,
		getWorkerDefault: () => ({ provider: "faux", model: "faux-model" }),
		onShutdown: async () => {},
	});

	process.stderr.write("[child] ready\\n");
	const code = await run;
	process.stderr.write("[child] exit " + String(code) + "\\n");
	process.exit(code);
}

main().catch((err) => {
	process.stderr.write("[child] crash " + (err instanceof Error ? err.stack ?? err.message : String(err)) + "\\n");
	process.exit(1);
});
`;

	writeFileSync(childPath, childSource, "utf8");

	const child: ChildProcessWithoutNullStreams = spawn(tsxPath, [childPath], {
		cwd: projectRoot,
		env: {
			...process.env,
			PI_TUI_WRITE_LOG: writeLogPath,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});

	try {
		await waitForResult("child-ready", () => ({
			ok: stderr.includes("[child] ready\n"),
			detail: stderr,
		}));

		await typeText(child.stdin, "/run scout stream smoke");
		await sleep(30);
		child.stdin.write(ENTER);

		await waitForResult("progress-message-update", () => ({
			ok: stderr.includes("[child] progress message_update\n"),
			detail: stderr,
		}));

		const midStart = fileLength(writeLogPath);
		child.stdin.write(CTRL_B);
		const midLog = await waitForResult("mid-stream-overlay", () => {
			const slice = readUtf8(writeLogPath).slice(midStart);
			return {
				ok: slice.includes("Dispatch Board") && slice.includes("scout") && slice.includes("running"),
				detail: slice,
			};
		});

		child.stdin.write(ESC);

		await waitForResult("run-completed", () => ({
			ok: stderr.includes("[child] bus completed\n"),
			detail: stderr,
		}));

		const finalStart = fileLength(writeLogPath);
		child.stdin.write(CTRL_B);
		const finalLog = await waitForResult("final-overlay", () => {
			const slice = readUtf8(writeLogPath).slice(finalStart);
			return {
				ok: slice.includes("Dispatch Board") && slice.includes("scout") && slice.includes("completed"),
				detail: slice,
			};
		});

		child.stdin.write(CTRL_D);
		const exit = await Promise.race([
			exitPromise,
			sleep(5_000).then(() => {
				throw new Error(`child-exit-timeout: ${stderr}`);
			}),
		]);
		if (exit.signal !== null) {
			throw new Error(`child-exit-signal: ${JSON.stringify(exit)}`);
		}
		return {
			stdout,
			stderr,
			midLog,
			finalLog,
			exitCode: typeof exit.code === "number" ? exit.code : null,
		};
	} finally {
		if (child.exitCode === null && !child.killed) {
			child.kill("SIGKILL");
			await exitPromise.catch(() => {});
		}
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	// (1) exports
	check("export:startInteractive-is-function", typeof startInteractive === "function");
	check("export:routeInteractiveKey-is-function", typeof routeInteractiveKey === "function");
	check("export:routeDispatchBoardOverlayKey-is-function", typeof routeDispatchBoardOverlayKey === "function");
	check("export:routeOverlayKey-is-function", typeof routeOverlayKey === "function");
	check("export:routeSuperOverlayKey-is-function", typeof routeSuperOverlayKey === "function");
	check("export:parseSlashCommand-is-function", typeof parseSlashCommand === "function");
	check("export:handleRun-is-function", typeof handleRun === "function");
	check("export:ALT_S-matches-esc-s", ALT_S === "\x1bs", JSON.stringify(ALT_S));
	check("export:SHIFT_TAB-matches-CSI-Z", SHIFT_TAB === "\x1b[Z", JSON.stringify(SHIFT_TAB));
	check("export:CTRL_B-matches-0x02", CTRL_B === "\x02", JSON.stringify(CTRL_B));
	check("export:CTRL_D-matches-0x04", CTRL_D === "\x04", JSON.stringify(CTRL_D));
	check("export:ENTER-matches-cr", ENTER === "\r", JSON.stringify(ENTER));
	check("export:ESC-matches-0x1b", ESC === "\x1b", JSON.stringify(ESC));

	// (2) buildFooter initial render
	const modes = makeMockModes();
	const providers = makeMockProviders();
	const footer = buildFooter({ modes, providers });
	const initialLines = footer.view.render(80);
	const initial = initialLines.join("");
	check("footer:initial-contains-mode-default", initial.includes("mode=default"), initial);
	check("footer:initial-contains-provider-displayname", initial.includes("anthropic/Anthropic"), initial);

	modes.cycleNormal();
	footer.refresh();
	const afterCycle = footer.view.render(80).join("");
	check("footer:refresh-reflects-advise", afterCycle.includes("mode=advise"), afterCycle);

	// (3) routeInteractiveKey wiring
	let cycleCalls = 0;
	let shutdownCalls = 0;
	let requestSuperCalls = 0;
	let toggleDispatchBoardCalls = 0;
	const routed = routeInteractiveKey(SHIFT_TAB, {
		cycleMode: () => {
			cycleCalls += 1;
		},
		requestShutdown: () => {
			shutdownCalls += 1;
		},
		requestSuper: () => {
			requestSuperCalls += 1;
		},
		toggleDispatchBoard: () => {
			toggleDispatchBoardCalls += 1;
		},
	});
	check("route:shift-tab-consumed", routed === true);
	check("route:shift-tab-calls-cycle", cycleCalls === 1, String(cycleCalls));

	const routedCtrlD = routeInteractiveKey(CTRL_D, {
		cycleMode: () => {
			cycleCalls += 1;
		},
		requestShutdown: () => {
			shutdownCalls += 1;
		},
		requestSuper: () => {
			requestSuperCalls += 1;
		},
		toggleDispatchBoard: () => {
			toggleDispatchBoardCalls += 1;
		},
	});
	check("route:ctrl-d-consumed", routedCtrlD === true);
	check("route:ctrl-d-calls-shutdown", shutdownCalls === 1, String(shutdownCalls));

	const routedAltS = routeInteractiveKey(ALT_S, {
		cycleMode: () => {
			cycleCalls += 1;
		},
		requestShutdown: () => {
			shutdownCalls += 1;
		},
		requestSuper: () => {
			requestSuperCalls += 1;
		},
		toggleDispatchBoard: () => {
			toggleDispatchBoardCalls += 1;
		},
	});
	check("route:alt-s-consumed", routedAltS === true);
	check("route:alt-s-calls-request-super", requestSuperCalls === 1, String(requestSuperCalls));
	check("route:alt-s-does-not-cycle", cycleCalls === 1, String(cycleCalls));
	check("route:alt-s-does-not-shutdown", shutdownCalls === 1, String(shutdownCalls));
	check("route:alt-s-does-not-toggle-dispatch-board", toggleDispatchBoardCalls === 0, String(toggleDispatchBoardCalls));

	const routedCtrlB = routeInteractiveKey(CTRL_B, {
		cycleMode: () => {
			cycleCalls += 1;
		},
		requestShutdown: () => {
			shutdownCalls += 1;
		},
		requestSuper: () => {
			requestSuperCalls += 1;
		},
		toggleDispatchBoard: () => {
			toggleDispatchBoardCalls += 1;
		},
	});
	check("route:ctrl-b-consumed", routedCtrlB === true);
	check("route:ctrl-b-calls-toggle-dispatch-board", toggleDispatchBoardCalls === 1, String(toggleDispatchBoardCalls));
	check("route:ctrl-b-does-not-cycle", cycleCalls === 1, String(cycleCalls));
	check("route:ctrl-b-does-not-shutdown", shutdownCalls === 1, String(shutdownCalls));
	check("route:ctrl-b-does-not-request-super", requestSuperCalls === 1, String(requestSuperCalls));

	const unrouted = routeInteractiveKey("a", {
		cycleMode: () => {
			cycleCalls += 1;
		},
		requestShutdown: () => {
			shutdownCalls += 1;
		},
		requestSuper: () => {
			requestSuperCalls += 1;
		},
		toggleDispatchBoard: () => {
			toggleDispatchBoardCalls += 1;
		},
	});
	check("route:ordinary-char-not-consumed", unrouted === false);

	const overlayLines = renderSuperOverlayLines();
	check("overlay:render-line-count", overlayLines.length === 8, JSON.stringify(overlayLines));
	check(
		"overlay:render-contains-confirm-hint",
		overlayLines.some((line) => line.includes("[Enter] confirm") && line.includes("[Esc] cancel")),
		JSON.stringify(overlayLines),
	);

	let overlayCancelCalls = 0;
	const overlayConfirmCalls: Array<{ requestedBy: string; acceptedAt: number }> = [];
	const overlayEnter = routeSuperOverlayKey(ENTER, {
		cancelSuper: () => {
			overlayCancelCalls += 1;
		},
		confirmSuper: (conf) => {
			overlayConfirmCalls.push(conf);
		},
		now: () => 1_710_000_000_000,
	});
	check("overlay:enter-consumed", overlayEnter === true);
	check("overlay:enter-calls-confirm-once", overlayConfirmCalls.length === 1, JSON.stringify(overlayConfirmCalls));
	check(
		"overlay:enter-confirm-shape",
		overlayConfirmCalls[0]?.requestedBy === "keybind" && overlayConfirmCalls[0]?.acceptedAt === 1_710_000_000_000,
		JSON.stringify(overlayConfirmCalls[0]),
	);
	check("overlay:enter-does-not-cancel", overlayCancelCalls === 0, String(overlayCancelCalls));

	const overlayEsc = routeSuperOverlayKey(ESC, {
		cancelSuper: () => {
			overlayCancelCalls += 1;
		},
		confirmSuper: (conf) => {
			overlayConfirmCalls.push(conf);
		},
		now: () => 1_710_000_000_001,
	});
	check("overlay:esc-consumed", overlayEsc === true);
	check("overlay:esc-calls-cancel", overlayCancelCalls === 1, String(overlayCancelCalls));
	check("overlay:esc-does-not-confirm", overlayConfirmCalls.length === 1, JSON.stringify(overlayConfirmCalls));
	check("overlay:esc-does-not-cycle", cycleCalls === 1, String(cycleCalls));

	let overlayShutdownCalls = 0;
	let closeOverlayCalls = 0;
	const overlayTypedChar = routeOverlayKey("x", "super-confirm", {
		cancelSuper: () => {
			overlayCancelCalls += 1;
		},
		confirmSuper: (conf) => {
			overlayConfirmCalls.push(conf);
		},
		now: () => 1_710_000_000_002,
		closeOverlay: () => {
			closeOverlayCalls += 1;
		},
		requestShutdown: () => {
			overlayShutdownCalls += 1;
		},
	});
	check("overlay:typed-char-consumed", overlayTypedChar === true);
	check("overlay:typed-char-keeps-confirm-count", overlayConfirmCalls.length === 1, JSON.stringify(overlayConfirmCalls));
	check("overlay:typed-char-keeps-cancel-count", overlayCancelCalls === 1, String(overlayCancelCalls));
	check("overlay:typed-char-does-not-shutdown", overlayShutdownCalls === 0, String(overlayShutdownCalls));

	const dispatchBoardEsc = routeDispatchBoardOverlayKey(ESC, {
		closeOverlay: () => {
			closeOverlayCalls += 1;
		},
	});
	check("dispatch-overlay:esc-consumed", dispatchBoardEsc === true);
	check("dispatch-overlay:esc-calls-close-overlay", closeOverlayCalls === 1, String(closeOverlayCalls));

	const overlayArrow = routeOverlayKey("\x1b[A", "dispatch-board", {
		cancelSuper: () => {
			overlayCancelCalls += 1;
		},
		confirmSuper: (conf) => {
			overlayConfirmCalls.push(conf);
		},
		now: () => 1_710_000_000_003,
		closeOverlay: () => {
			closeOverlayCalls += 1;
		},
		requestShutdown: () => {
			overlayShutdownCalls += 1;
		},
	});
	check("dispatch-overlay:arrow-key-consumed", overlayArrow === true);
	check("dispatch-overlay:arrow-key-does-not-close", closeOverlayCalls === 1, String(closeOverlayCalls));

	const overlayCtrlD = routeOverlayKey(CTRL_D, "dispatch-board", {
		cancelSuper: () => {
			overlayCancelCalls += 1;
		},
		confirmSuper: (conf) => {
			overlayConfirmCalls.push(conf);
		},
		now: () => 1_710_000_000_004,
		closeOverlay: () => {
			closeOverlayCalls += 1;
		},
		requestShutdown: () => {
			overlayShutdownCalls += 1;
		},
	});
	check("overlay:ctrl-d-consumed", overlayCtrlD === true);
	check("overlay:ctrl-d-calls-shutdown", overlayShutdownCalls === 1, String(overlayShutdownCalls));
	check("overlay:ctrl-d-does-not-close-overlay", closeOverlayCalls === 1, String(closeOverlayCalls));

	// (4) parseSlashCommand - discriminated union covers each branch
	check("parse:empty", parseSlashCommand("   ").kind === "empty");
	check("parse:quit", parseSlashCommand("/quit").kind === "quit");
	check("parse:exit-alias", parseSlashCommand("/exit").kind === "quit");
	check("parse:help", parseSlashCommand("/help").kind === "help");
	check("parse:help-with-arg", parseSlashCommand("/help run").kind === "help");
	check("parse:run-usage-bare", parseSlashCommand("/run").kind === "run-usage");
	check("parse:run-usage-agent-only", parseSlashCommand("/run scout").kind === "run-usage");

	const runCmd = parseSlashCommand("/run scout  hello world");
	check(
		"parse:run-agent+task",
		runCmd.kind === "run" && runCmd.agentId === "scout" && runCmd.task === "hello world",
		JSON.stringify(runCmd),
	);

	const unk = parseSlashCommand("/foo bar");
	check("parse:unknown-slash", unk.kind === "unknown" && unk.text === "/foo bar", JSON.stringify(unk));

	const plain = parseSlashCommand("just text");
	check("parse:unknown-plain", plain.kind === "unknown" && plain.text === "just text", JSON.stringify(plain));

	// (5) handleRun refuses to dispatch when no worker default is configured
	const emptyDispatchStdout: string[] = [];
	const emptyDispatchStderr: string[] = [];
	const emptyDispatch = makeMockDispatch();
	await handleRun("scout", "hello", {
		dispatch: emptyDispatch,
		io: {
			stdout: (s) => emptyDispatchStdout.push(s),
			stderr: (s) => emptyDispatchStderr.push(s),
		},
		workerDefault: undefined,
	});
	check("handleRun:no-provider-skips-dispatch", emptyDispatch.calls.length === 0, String(emptyDispatch.calls.length));
	check(
		"handleRun:no-provider-prints-config-hint",
		emptyDispatchStderr.join("").includes("no provider configured"),
		emptyDispatchStderr.join(""),
	);

	// (5b) handleRun dispatches when caller provides a worker default
	const stdout: string[] = [];
	const stderr: string[] = [];
	const mockDispatch = makeMockDispatch();
	await handleRun("scout", "hello", {
		dispatch: mockDispatch,
		io: {
			stdout: (s) => stdout.push(s),
			stderr: (s) => stderr.push(s),
		},
		workerDefault: { provider: "faux", model: "faux-model" },
	});
	check("handleRun:dispatch-called-once", mockDispatch.calls.length === 1, String(mockDispatch.calls.length));
	const req = mockDispatch.calls[0];
	check(
		"handleRun:dispatch-passes-agent-and-task",
		req.agentId === "scout" && req.task === "hello",
		JSON.stringify(req),
	);
	check(
		"handleRun:dispatch-omits-provider-fields-when-settings-resolve",
		req.providerId === undefined && req.modelId === undefined && req.runtime === "native",
		JSON.stringify(req),
	);
	const joined = stdout.join("");
	check("handleRun:prints-runId", joined.includes("[run] runId=run-mock-1"), joined);
	check("handleRun:prints-start-event", joined.includes("[run] start"), joined);
	check("handleRun:prints-stdout-event", joined.includes("[run] stdout"), joined);
	check("handleRun:prints-end-event", joined.includes("[run] end"), joined);
	check("handleRun:filters-heartbeat", !joined.includes("[run] heartbeat"), joined);
	check("handleRun:prints-final-receipt", joined.includes("[run] done exit=0 tokens=42"), joined);
	check("handleRun:no-stderr-on-success", stderr.length === 0, stderr.join(""));

	// (6) /providers slash command parsing + overlay formatting
	check("parse:providers-command", parseSlashCommand("/providers").kind === "providers");
	check(
		"parse:providers-with-trailing-space",
		parseSlashCommand("  /providers  ").kind === "providers",
		parseSlashCommand("  /providers  ").kind,
	);
	check(
		"parse:providers-with-arg-is-unknown",
		parseSlashCommand("/providers set").kind === "unknown",
		parseSlashCommand("/providers set").kind,
	);

	const providersFixture: ProviderListEntry[] = [
		{
			id: "anthropic",
			displayName: "Anthropic",
			tier: "sdk",
			available: false,
			reason: "missing ANTHROPIC_API_KEY",
			health: {
				providerId: "anthropic",
				status: "unknown",
				lastCheckAt: null,
				lastError: null,
				latencyMs: null,
			},
		},
		{
			id: "llamacpp",
			displayName: "llama.cpp",
			tier: "native",
			available: true,
			reason: "endpoints configured",
			health: {
				providerId: "llamacpp",
				status: "healthy",
				lastCheckAt: "2026-04-17T00:00:00.000Z",
				lastError: null,
				latencyMs: 42,
			},
			endpoints: [
				{
					name: "primary",
					url: "http://localhost:8080",
					probe: {
						name: "primary",
						url: "http://localhost:8080",
						ok: true,
						latencyMs: 12,
						models: ["qwen2.5-coder-7b", "llama-3.2-3b"],
					},
				},
			],
		},
		{
			id: "lmstudio",
			displayName: "LM Studio",
			tier: "native",
			available: false,
			reason: "endpoint unreachable",
			health: {
				providerId: "lmstudio",
				status: "down",
				lastCheckAt: "2026-04-17T00:00:00.000Z",
				lastError: "connection refused",
				latencyMs: null,
			},
			endpoints: [
				{
					name: "main",
					url: "http://localhost:1234",
					probe: {
						name: "main",
						url: "http://localhost:1234",
						ok: false,
						error: "connection refused",
					},
				},
			],
		},
	];

	const overlayRender = formatProvidersOverlayLines(providersFixture);
	check("providers-overlay:first-line-is-top-border", overlayRender[0]?.startsWith("┌"), overlayRender[0]);
	check(
		"providers-overlay:last-line-is-bottom-border",
		overlayRender[overlayRender.length - 1]?.startsWith("└"),
		overlayRender[overlayRender.length - 1],
	);
	const joinedOverlay = overlayRender.join("\n");
	check("providers-overlay:lists-anthropic-row", joinedOverlay.includes("anthropic"), joinedOverlay);
	check(
		"providers-overlay:shows-unknown-tag-for-anthropic",
		/anthropic\s+sdk\s+unknown/.test(joinedOverlay),
		joinedOverlay,
	);
	check(
		"providers-overlay:lists-llamacpp-header",
		joinedOverlay.includes("llamacpp (1 endpoint, 1 healthy)"),
		joinedOverlay,
	);
	check("providers-overlay:shows-endpoint-model-count", joinedOverlay.includes("2 models"), joinedOverlay);
	check("providers-overlay:shows-endpoint-latency", joinedOverlay.includes("12ms"), joinedOverlay);
	check(
		"providers-overlay:lists-lmstudio-header",
		joinedOverlay.includes("lmstudio (1 endpoint, 0 healthy, 1 unreachable)"),
		joinedOverlay,
	);
	check("providers-overlay:shows-endpoint-error", joinedOverlay.includes("connection refused"), joinedOverlay);
	check("providers-overlay:hint-line-present", joinedOverlay.includes("[Esc] close"), joinedOverlay);

	const widths = new Set(overlayRender.map((l) => l.length));
	check("providers-overlay:every-line-same-width", widths.size === 1, [...widths].join(","));

	const errorRender = formatProvidersOverlayLines([], { error: "network down" });
	check(
		"providers-overlay:surfaces-probe-error",
		errorRender.some((line) => line.includes("probe error: network down")),
		errorRender.join("\n"),
	);

	let providersOverlayCloseCalls = 0;
	const providersEsc = routeProvidersOverlayKey(ESC, {
		closeOverlay: () => {
			providersOverlayCloseCalls += 1;
		},
	});
	check("providers-overlay:esc-consumed", providersEsc === true);
	check("providers-overlay:esc-calls-close", providersOverlayCloseCalls === 1, String(providersOverlayCloseCalls));

	const providersOtherKey = routeProvidersOverlayKey("x", {
		closeOverlay: () => {
			providersOverlayCloseCalls += 1;
		},
	});
	check("providers-overlay:other-key-not-routed", providersOtherKey === false);
	check(
		"providers-overlay:other-key-does-not-close",
		providersOverlayCloseCalls === 1,
		String(providersOverlayCloseCalls),
	);

	let providersOverlayShutdownCalls = 0;
	let providersOverlayGenericCloseCalls = 0;
	const providersOverlayCtrlD = routeOverlayKey(CTRL_D, "providers", {
		cancelSuper: () => {},
		confirmSuper: () => {},
		now: () => 1_710_000_000_010,
		closeOverlay: () => {
			providersOverlayGenericCloseCalls += 1;
		},
		requestShutdown: () => {
			providersOverlayShutdownCalls += 1;
		},
	});
	check("providers-overlay:ctrl-d-consumed", providersOverlayCtrlD === true);
	check(
		"providers-overlay:ctrl-d-calls-shutdown",
		providersOverlayShutdownCalls === 1,
		String(providersOverlayShutdownCalls),
	);
	check(
		"providers-overlay:ctrl-d-does-not-close",
		providersOverlayGenericCloseCalls === 0,
		String(providersOverlayGenericCloseCalls),
	);

	const providersOverlayEscGeneric = routeOverlayKey(ESC, "providers", {
		cancelSuper: () => {},
		confirmSuper: () => {},
		now: () => 1_710_000_000_011,
		closeOverlay: () => {
			providersOverlayGenericCloseCalls += 1;
		},
		requestShutdown: () => {
			providersOverlayShutdownCalls += 1;
		},
	});
	check("providers-overlay:esc-via-overlay-router-consumed", providersOverlayEscGeneric === true);
	check(
		"providers-overlay:esc-via-overlay-router-calls-close",
		providersOverlayGenericCloseCalls === 1,
		String(providersOverlayGenericCloseCalls),
	);

	// handleRun on failure routes the error to stderr
	const failStdout: string[] = [];
	const failStderr: string[] = [];
	const failingDispatch = makeMockDispatch({ throwOnDispatch: new Error("boom") });
	await handleRun("scout", "hello", {
		dispatch: failingDispatch,
		io: {
			stdout: (s) => failStdout.push(s),
			stderr: (s) => failStderr.push(s),
		},
		workerDefault: { provider: "faux", model: "faux-model" },
	});
	check("handleRun:failure-routes-to-stderr", failStderr.join("").includes("[run] failed: boom"), failStderr.join(""));
	check("handleRun:failure-no-stdout-run-lines", failStdout.length === 0, failStdout.join(""));

	// (7) /run scout streams real worker events into the dispatch-board overlay.
	// Simulates the golden-path flow: dispatch emits enqueued + started,
	// worker stream yields message_update / tool_execution_* / turn_end /
	// message_end / agent_end,
	// handleRun forwards each non-heartbeat event on BusChannels.DispatchProgress,
	// the dispatch-board store updates the in-flight row live, and the row
	// transitions to completed on the terminal receipt.
	const streamBus = createSafeEventBus();
	const streamStore = createDispatchBoardStore(streamBus);

	const progressEvents: Array<{ runId?: string; event?: { type?: string } }> = [];
	streamBus.on(BusChannels.DispatchProgress, (raw) => {
		progressEvents.push(raw as { runId?: string; event?: { type?: string } });
	});

	let midStreamSnapshot: ReadonlyArray<DispatchBoardRow> | null = null;
	let postMessageEndSnapshot: ReadonlyArray<DispatchBoardRow> | null = null;

	const streamRunId = "run-stream-smoke";
	const streamEvents: Array<{ type: string; [k: string]: unknown }> = [
		{ type: "agent_start" },
		{ type: "heartbeat" },
		{ type: "message_update", message: { content: [{ type: "text", text: "partial" }] } },
		{ type: "tool_execution_start", toolCallId: "t1", toolName: "read" },
		{ type: "tool_execution_update", toolCallId: "t1", delta: "chunk" },
		{ type: "tool_execution_end", toolCallId: "t1", toolName: "read" },
		{ type: "turn_end", toolResults: [{ toolCallId: "t1", result: "ok" }] },
		{ type: "message_end", message: { role: "assistant", usage: { input: 7, output: 13, cacheRead: 5, cacheWrite: 3 } } },
		{
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
		},
	];
	const streamReceipt: RunReceipt = {
		runId: streamRunId,
		agentId: "scout",
		task: "faux-smoke",
		providerId: "faux",
		modelId: "faux-model",
		runtime: "native",
		startedAt: "2026-04-17T00:00:00.000Z",
		endedAt: "2026-04-17T00:00:01.000Z",
		exitCode: 0,
		tokenCount: 28,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.1.0-dev",
		piMonoVersion: "0.67.4",
		platform: "linux",
		nodeVersion: "v20",
		toolCalls: 1,
		sessionId: null,
	};

	const streamDispatch: DispatchContract = {
		dispatch: async (req: DispatchRequest) => {
			streamBus.emit(BusChannels.DispatchEnqueued, {
				runId: streamRunId,
				agentId: req.agentId,
				providerId: "faux",
				modelId: "faux-model",
				runtime: "native",
			});
			streamBus.emit(BusChannels.DispatchStarted, {
				runId: streamRunId,
				agentId: req.agentId,
				providerId: "faux",
				modelId: "faux-model",
				runtime: "native",
			});
			let finalResolve = (): void => {};
			const finalGate = new Promise<void>((resolve) => {
				finalResolve = resolve;
			});
			async function* iter(): AsyncIterableIterator<unknown> {
				let sawMidStream = false;
				let sawMessageEnd = false;
				for (const e of streamEvents) {
					yield e;
					// Snapshots run right after handleRun has processed `yield e` -
					// at that point any DispatchProgress emit for this event has
					// already fanned out through the store's synchronous listener.
					if (!sawMidStream && e.type === "message_update") {
						midStreamSnapshot = streamStore.rows();
						sawMidStream = true;
					}
					if (!sawMessageEnd && e.type === "message_end") {
						postMessageEndSnapshot = streamStore.rows();
						sawMessageEnd = true;
					}
				}
				finalResolve();
			}
			const finalPromise = (async (): Promise<RunReceipt> => {
				await finalGate;
				streamBus.emit(BusChannels.DispatchCompleted, {
					runId: streamRunId,
					agentId: req.agentId,
					providerId: "faux",
					modelId: "faux-model",
					runtime: "native",
					tokenCount: streamReceipt.tokenCount,
					costUsd: 0,
					durationMs: 1000,
				});
				return streamReceipt;
			})();
			return { runId: streamRunId, events: iter(), finalPromise };
		},
		listRuns: (_status?: RunStatus): ReadonlyArray<RunEnvelope> => [],
		getRun: () => null,
		abort: () => {},
		drain: async () => {},
	};

	const streamStdout: string[] = [];
	const streamStderr: string[] = [];
	await handleRun("scout", "faux-smoke", {
		dispatch: streamDispatch,
		io: {
			stdout: (s) => streamStdout.push(s),
			stderr: (s) => streamStderr.push(s),
		},
		workerDefault: { provider: "faux", model: "faux-model" },
		bus: streamBus,
	});

	check(
		"stream:mid-stream-row-present",
		midStreamSnapshot !== null && midStreamSnapshot.length === 1 && midStreamSnapshot[0]?.runId === streamRunId,
		JSON.stringify(midStreamSnapshot),
	);
	check(
		"stream:mid-stream-row-status-running",
		midStreamSnapshot?.[0]?.status === "running",
		JSON.stringify(midStreamSnapshot),
	);
	const midLines = midStreamSnapshot ? formatDispatchBoardLines(midStreamSnapshot) : [];
	check(
		"stream:mid-stream-overlay-shows-in-flight-row",
		midLines.some((line) => line.includes("scout") && line.includes("running")),
		JSON.stringify(midLines),
	);

	check(
		"stream:tokens-update-from-message-end-before-terminal-receipt",
		postMessageEndSnapshot?.[0]?.status === "running" && postMessageEndSnapshot?.[0]?.tokenCount === 28,
		JSON.stringify(postMessageEndSnapshot),
	);

	const progressTypes = progressEvents.map((ev) => ev.event?.type ?? "?");
	check(
		"stream:progress-forwards-message-update",
		progressTypes.includes("message_update"),
		JSON.stringify(progressTypes),
	);
	check(
		"stream:progress-forwards-tool-execution-start",
		progressTypes.includes("tool_execution_start"),
		JSON.stringify(progressTypes),
	);
	check(
		"stream:progress-forwards-tool-execution-update",
		progressTypes.includes("tool_execution_update"),
		JSON.stringify(progressTypes),
	);
	check(
		"stream:progress-forwards-tool-execution-end",
		progressTypes.includes("tool_execution_end"),
		JSON.stringify(progressTypes),
	);
	check("stream:progress-forwards-turn-end", progressTypes.includes("turn_end"), JSON.stringify(progressTypes));
	check("stream:progress-forwards-message-end", progressTypes.includes("message_end"), JSON.stringify(progressTypes));
	check("stream:progress-forwards-agent-end", progressTypes.includes("agent_end"), JSON.stringify(progressTypes));
	check("stream:progress-suppresses-heartbeat", !progressTypes.includes("heartbeat"), JSON.stringify(progressTypes));
	check(
		"stream:progress-payload-carries-runid",
		progressEvents.every((ev) => ev.runId === streamRunId),
		JSON.stringify(progressEvents.map((ev) => ev.runId)),
	);

	const finalRows = streamStore.rows();
	check(
		"stream:final-row-status-completed",
		finalRows.length === 1 && finalRows[0]?.status === "completed",
		JSON.stringify(finalRows),
	);
	check(
		"stream:final-row-tokens-match-receipt",
		finalRows[0]?.tokenCount === streamReceipt.tokenCount,
		JSON.stringify(finalRows),
	);
	const finalLines = formatDispatchBoardLines(finalRows);
	check(
		"stream:final-overlay-shows-completed-row",
		finalLines.some((line) => line.includes("scout") && line.includes("completed")),
		JSON.stringify(finalLines),
	);

	streamStore.unsubscribe();

	try {
		const interactiveProbe = await runInteractiveStreamProbe();
		check(
			"stream:interactive-run-command-prints-runid",
			interactiveProbe.stdout.includes("[run] runId=run-live-overlay"),
			interactiveProbe.stdout,
		);
		check(
			"stream:interactive-progress-forwards-required-types",
			interactiveProbe.stderr.includes("[child] progress message_update\n") &&
				interactiveProbe.stderr.includes("[child] progress tool_execution_start\n") &&
				interactiveProbe.stderr.includes("[child] progress tool_execution_update\n") &&
				interactiveProbe.stderr.includes("[child] progress turn_end\n") &&
				interactiveProbe.stderr.includes("[child] progress message_end\n") &&
				interactiveProbe.stderr.includes("[child] progress agent_end\n"),
			interactiveProbe.stderr,
		);
		check(
			"stream:interactive-suppresses-heartbeat",
			!interactiveProbe.stderr.includes("[child] progress heartbeat\n"),
			interactiveProbe.stderr,
		);
		check(
			"stream:interactive-overlay-opens-mid-stream",
			interactiveProbe.midLog.includes("Dispatch Board") &&
				interactiveProbe.midLog.includes("scout") &&
				interactiveProbe.midLog.includes("running"),
			interactiveProbe.midLog,
		);
		check(
			"stream:interactive-overlay-reopens-with-terminal-state",
			interactiveProbe.finalLog.includes("Dispatch Board") &&
				interactiveProbe.finalLog.includes("scout") &&
				interactiveProbe.finalLog.includes("completed"),
			interactiveProbe.finalLog,
		);
		check("stream:interactive-child-exits-cleanly", interactiveProbe.exitCode === 0, String(interactiveProbe.exitCode));
	} catch (err) {
		check("stream:interactive-child-probe", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
	}

	if (failures.length > 0) {
		process.stderr.write(`[diag-interactive-tui] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-interactive-tui] PASS\n");
}

main().catch((err: unknown) => {
	process.stderr.write(`[diag-interactive-tui] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
