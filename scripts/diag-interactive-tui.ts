/**
 * Phase 9 minimal TUI scaffold diag.
 *
 * This test deliberately does NOT spin up a real terminal. Instead it exercises
 * the public seams that other code paths (the orchestrator, the key router, the
 * footer, the slash-command router) depend on:
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
 *
 * Full keyboard-driven tests live post-v0.1 when the terminal harness lands.
 */

import type { DispatchContract, DispatchRequest } from "../src/domains/dispatch/contract.js";
import type { RunEnvelope, RunReceipt, RunStatus } from "../src/domains/dispatch/types.js";
import type { ModesContract } from "../src/domains/modes/index.js";
import type { ProviderListEntry, ProvidersContract } from "../src/domains/providers/contract.js";
import { buildFooter } from "../src/interactive/footer-panel.js";
import {
	ALT_S,
	CTRL_D,
	ENTER,
	ESC,
	SHIFT_TAB,
	handleRun,
	parseSlashCommand,
	routeInteractiveKey,
	routeSuperOverlayKey,
	startInteractive,
} from "../src/interactive/index.js";
import { renderSuperOverlayLines } from "../src/interactive/super-overlay.js";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-interactive-tui] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-interactive-tui] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
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

async function main(): Promise<void> {
	// (1) exports
	check("export:startInteractive-is-function", typeof startInteractive === "function");
	check("export:routeInteractiveKey-is-function", typeof routeInteractiveKey === "function");
	check("export:routeSuperOverlayKey-is-function", typeof routeSuperOverlayKey === "function");
	check("export:parseSlashCommand-is-function", typeof parseSlashCommand === "function");
	check("export:handleRun-is-function", typeof handleRun === "function");
	check("export:ALT_S-matches-esc-s", ALT_S === "\x1bs", JSON.stringify(ALT_S));
	check("export:SHIFT_TAB-matches-CSI-Z", SHIFT_TAB === "\x1b[Z", JSON.stringify(SHIFT_TAB));
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
	});
	check("route:alt-s-consumed", routedAltS === true);
	check("route:alt-s-calls-request-super", requestSuperCalls === 1, String(requestSuperCalls));
	check("route:alt-s-does-not-cycle", cycleCalls === 1, String(cycleCalls));
	check("route:alt-s-does-not-shutdown", shutdownCalls === 1, String(shutdownCalls));

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

	const overlayOther = routeSuperOverlayKey("x", {
		cancelSuper: () => {
			overlayCancelCalls += 1;
		},
		confirmSuper: (conf) => {
			overlayConfirmCalls.push(conf);
		},
		now: () => 1_710_000_000_002,
	});
	check("overlay:other-key-not-consumed", overlayOther === false);
	check("overlay:other-key-keeps-confirm-count", overlayConfirmCalls.length === 1, JSON.stringify(overlayConfirmCalls));
	check("overlay:other-key-keeps-cancel-count", overlayCancelCalls === 1, String(overlayCancelCalls));

	// (4) parseSlashCommand — discriminated union covers each branch
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

	// (5) handleRun dispatches with faux defaults and streams non-heartbeat events
	const stdout: string[] = [];
	const stderr: string[] = [];
	const mockDispatch = makeMockDispatch();
	await handleRun("scout", "hello", mockDispatch, {
		stdout: (s) => stdout.push(s),
		stderr: (s) => stderr.push(s),
	});
	check("handleRun:dispatch-called-once", mockDispatch.calls.length === 1, String(mockDispatch.calls.length));
	const req = mockDispatch.calls[0];
	check(
		"handleRun:dispatch-passes-agent-and-task",
		req.agentId === "scout" && req.task === "hello",
		JSON.stringify(req),
	);
	check(
		"handleRun:dispatch-defaults-to-faux-provider",
		req.providerId === "faux" && req.modelId === "faux-model" && req.runtime === "native",
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

	// handleRun on failure routes the error to stderr
	const failStdout: string[] = [];
	const failStderr: string[] = [];
	const failingDispatch = makeMockDispatch({ throwOnDispatch: new Error("boom") });
	await handleRun("scout", "hello", failingDispatch, {
		stdout: (s) => failStdout.push(s),
		stderr: (s) => failStderr.push(s),
	});
	check("handleRun:failure-routes-to-stderr", failStderr.join("").includes("[run] failed: boom"), failStderr.join(""));
	check("handleRun:failure-no-stdout-run-lines", failStdout.length === 0, failStdout.join(""));

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
