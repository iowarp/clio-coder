/**
 * Phase 9 minimal TUI scaffold diag.
 *
 * This test deliberately does NOT spin up a real terminal. Instead it exercises
 * the three public seams that other code paths (the orchestrator, the key
 * router, the footer) depend on:
 *
 *   1. `startInteractive` is exported from src/interactive/index.ts as a
 *      function.
 *   2. `buildFooter` returns a Text whose initial render contains "mode=default"
 *      and the active provider's displayName when mock contracts are wired in.
 *   3. The Shift+Tab sequence ("\x1b[Z") routes through `routeInteractiveKey`
 *      to cycleNormal on the modes contract. Ctrl+D ("\x04") routes to
 *      requestShutdown.
 *
 * Full keyboard-driven tests live post-v0.1 when the terminal harness lands.
 */

import type { ModesContract } from "../src/domains/modes/index.js";
import type { ProviderListEntry, ProvidersContract } from "../src/domains/providers/contract.js";
import { buildFooter } from "../src/interactive/footer-panel.js";
import { CTRL_D, SHIFT_TAB, routeInteractiveKey, startInteractive } from "../src/interactive/index.js";

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

function main(): void {
	// (1) exports
	check("export:startInteractive-is-function", typeof startInteractive === "function");
	check("export:routeInteractiveKey-is-function", typeof routeInteractiveKey === "function");
	check("export:SHIFT_TAB-matches-CSI-Z", SHIFT_TAB === "\x1b[Z", JSON.stringify(SHIFT_TAB));
	check("export:CTRL_D-matches-0x04", CTRL_D === "\x04", JSON.stringify(CTRL_D));

	// (2) buildFooter initial render
	const modes = makeMockModes();
	const providers = makeMockProviders();
	const footer = buildFooter({ modes, providers });
	const initialLines = footer.view.render(80);
	const initial = initialLines.join("");
	check("footer:initial-contains-mode-default", initial.includes("mode=default"), initial);
	check("footer:initial-contains-provider-displayname", initial.includes("anthropic/Anthropic"), initial);

	// After cycle the footer should refresh to advise.
	modes.cycleNormal();
	footer.refresh();
	const afterCycle = footer.view.render(80).join("");
	check("footer:refresh-reflects-advise", afterCycle.includes("mode=advise"), afterCycle);

	// (3) routeInteractiveKey wiring
	let cycleCalls = 0;
	let shutdownCalls = 0;
	const routed = routeInteractiveKey(SHIFT_TAB, {
		cycleMode: () => {
			cycleCalls += 1;
		},
		requestShutdown: () => {
			shutdownCalls += 1;
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
	});
	check("route:ctrl-d-consumed", routedCtrlD === true);
	check("route:ctrl-d-calls-shutdown", shutdownCalls === 1, String(shutdownCalls));

	const unrouted = routeInteractiveKey("a", {
		cycleMode: () => {
			cycleCalls += 1;
		},
		requestShutdown: () => {
			shutdownCalls += 1;
		},
	});
	check("route:ordinary-char-not-consumed", unrouted === false);

	if (failures.length > 0) {
		process.stderr.write(`[diag-interactive-tui] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-interactive-tui] PASS\n");
}

try {
	main();
} catch (err) {
	process.stderr.write(`[diag-interactive-tui] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
}
