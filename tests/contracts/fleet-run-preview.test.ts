import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { parseFleetCommands, parseFleetContract } from "../../src/domains/agents/index.js";
import type { AgentSpec } from "../../src/domains/agents/spec.js";
import { agentRoleFactsResolver } from "../../src/domains/dispatch/execution-role.js";
import type { ExecuteFleetRunInput, FleetRunOutcome } from "../../src/domains/dispatch/index.js";
import { emptyCostAggregate } from "../../src/domains/observability/cost.js";
import type { Component, OverlayHandle, TUI } from "../../src/engine/tui.js";
import {
	createDispatchBoardStore,
	formatDispatchPhaseCell,
	formatTaskIslandLines,
	renderDispatchCard,
} from "../../src/interactive/dispatch-board.js";
import { compileFleetRunPreview } from "../../src/interactive/fleet-run-preview.js";
import {
	createOverlayGeneralOpeners,
	type OverlayGeneralOpenersDeps,
} from "../../src/interactive/overlay-general-openers.js";
import {
	formatFleetRunApprovalBody,
	formatFleetRunPreviewStep,
	formatWriteBoundary,
	openFleetRunApprovalOverlay,
} from "../../src/interactive/overlays/fleet-run-approval.js";
import {
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

const CONTRACT = [
	"---",
	"version: 4",
	"name: preview-demo",
	"description: two waves and a deterministic check",
	"steps:",
	"  - id: scout",
	"    agent: scout",
	"    scope: readonly",
	"    dependencies: []",
	"  - id: build",
	"    agent: builder",
	"    scope: workspace",
	"    writes: [src/]",
	"    dependencies: [scout]",
	"  - kind: code",
	"    id: check",
	"    command: test",
	"    scope: readonly",
	"    dependencies: [build]",
	"maxWorkers: 2",
	"budgetUsd: 1.5",
	"onFailure: stop",
	"---",
	"Work on {{target}}.",
].join("\n");

const COMMANDS = ["version: 1", "commands:", "  test:", "    argv: [npm, run, test]", "    description: suite"].join(
	"\n",
);

function spec(capabilityClass: AgentSpec["capabilityClass"]): AgentSpec {
	return {
		capabilityClass,
		resultContract: { kind: "mutation-report" },
	} as unknown as AgentSpec;
}

function previewFixture(
	overrides: {
		contract?: string;
		getAgentSpec?: (agentId: string) => AgentSpec | null;
		resolveRoute?: Parameters<typeof compileFleetRunPreview>[0]["resolveRoute"];
	} = {},
): ReturnType<typeof compileFleetRunPreview> {
	const contract = parseFleetContract(overrides.contract ?? CONTRACT, ".clio-coder/fleets/preview-demo.md");
	const commands = parseFleetCommands(COMMANDS, ".clio-coder/fleets/commands.yaml");
	const getAgentSpec =
		overrides.getAgentSpec ?? ((agentId: string) => (agentId === "scout" ? spec("read-only") : spec("workspace-edit")));
	return compileFleetRunPreview({
		workspaceRoot: process.cwd(),
		name: "preview-demo",
		vars: { target: "the parser" },
		getAgentSpec,
		roleFacts: agentRoleFactsResolver(getAgentSpec),
		budget: { ceilingUsd: 20, currentUsd: 2.5, verdict: "under" },
		resolveRoute:
			overrides.resolveRoute ??
			((step) => ({
				targetId: step.scope === "readonly" ? "local-small" : "local-large",
				wireModelId: "qwen3-coder",
				nodeId: "local",
			})),
		load: () => ({ contract, commands }),
	});
}

function fakeTui(): { tui: TUI; component: () => Component } {
	let mounted: Component | undefined;
	const handle = {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => true,
	} as OverlayHandle;
	const tui = {
		terminal: { columns: 100, rows: 40 },
		showOverlay(component: Component): OverlayHandle {
			mounted = component;
			return handle;
		},
		requestRender() {},
	} as unknown as TUI;
	return {
		tui,
		component: () => {
			if (!mounted) throw new Error("overlay not mounted");
			return mounted;
		},
	};
}

/** The opener under test with only the collaborators the fleet-run path touches. */
function openersHarness(options: { preview?: string; inFlight?: boolean } = {}) {
	const notices: string[] = [];
	const runs: ExecuteFleetRunInput[] = [];
	const phases: Array<{ runId: string; wave: number; stepId: string }> = [];
	let state: string = "closed";
	let opened: Parameters<typeof openFleetRunApprovalOverlay>[1] | null = null;
	const getAgentSpec = (agentId: string) => (agentId === "scout" ? spec("read-only") : spec("workspace-edit"));
	const contract = parseFleetContract(options.preview ?? CONTRACT, ".clio-coder/fleets/preview-demo.md");
	const commands = parseFleetCommands(COMMANDS, ".clio-coder/fleets/commands.yaml");
	const deps = {
		tui: fakeTui().tui,
		transitions: {
			get state() {
				return state;
			},
			set state(next: string) {
				state = next;
			},
			handle: null,
			close: () => {
				state = "closed";
			},
		},
		terminal: { columns: 100 },
		notify: (level: string, text: string) => notices.push(`${level}:${text}`),
		stderr: () => {},
		requestRender: () => {},
		closeOverlay: () => {
			state = "closed";
		},
		dispatch: {
			preview: () => ({ targetId: "local", wireModelId: "qwen3-coder", node: { id: "local" } }),
		},
		getSessionMeta: () => ({ cwd: process.cwd() }),
		getSettings: () => ({ attribution: { gitCommits: false } }),
		agents: { getSpec: getAgentSpec },
		isTurnInFlight: () => options.inFlight === true,
		setFleetRunPhase: (runId: string, phase: { wave: number; stepId: string }) => phases.push({ runId, ...phase }),
		openFleetRunApprovalOverlay: (_tui: TUI, overlayOptions: Parameters<typeof openFleetRunApprovalOverlay>[1]) => {
			opened = overlayOptions;
			return { hide() {} } as OverlayHandle;
		},
		runFleet: async (input: ExecuteFleetRunInput): Promise<FleetRunOutcome> => {
			runs.push(input);
			input.onStepDispatched?.({ stepId: "scout", kind: "agent", waveIndex: 0, assignmentId: "run-a", agentId: "scout" });
			return {
				rootId: input.fleetRootId,
				planHash: input.plan.hash,
				result: { planHash: input.plan.hash } as FleetRunOutcome["result"],
				receipts: [],
				totalCostUsd: 0,
				totalCost: emptyCostAggregate(),
				requiredStepCount: 3,
				succeededStepCount: 3,
				resolvedLoopCount: 0,
				cleanRun: true,
			};
		},
		// The projection reads the fixture rather than the operator's checkout.
		loadFleetSources: () => ({ contract, commands }),
	} as unknown as OverlayGeneralOpenersDeps;
	const openers = createOverlayGeneralOpeners({
		...deps,
		agents: {
			getSpec: getAgentSpec,
			get: () => null,
			list: () => [],
			listSpecs: () => [],
			diagnostics: () => [],
			reload: () => {},
		},
	});
	return {
		openers,
		notices,
		runs,
		phases,
		overlay: () => opened,
		state: () => state,
	};
}

describe("contracts/fleet-run command spec", () => {
	it("keeps /fleet alone a settings deep link", () => {
		deepStrictEqual(parseSlashCommand("/fleet"), { kind: "settings", section: "fleet" });
		// Junk arguments stay the usage error every settings deep link reports.
		deepStrictEqual(parseSlashCommand("/fleet nodes"), {
			kind: "usage-error",
			command: "fleet",
			reason: "Unexpected argument: nodes",
		});
	});

	it("parses /fleet run with repeated --var pairs", () => {
		deepStrictEqual(parseSlashCommand("/fleet run x --var a=b --var c=d"), {
			kind: "fleet-run",
			name: "x",
			vars: { a: "b", c: "d" },
		});
	});

	// A task variable is prose, so its value carries spaces; the tokenizer
	// used to end every token at whitespace and reported the second word as an
	// unexpected argument even when the operator quoted it.
	it("carries quoted --var values with spaces through, quoted either way", () => {
		deepStrictEqual(parseSlashCommand('/fleet run x --var task="add a pow function" --var mode=fast'), {
			kind: "fleet-run",
			name: "x",
			vars: { task: "add a pow function", mode: "fast" },
		});
		deepStrictEqual(parseSlashCommand("/fleet run x --var 'task=add a pow function'"), {
			kind: "fleet-run",
			name: "x",
			vars: { task: "add a pow function" },
		});
	});

	it("reports usage for a run form that does not parse", () => {
		const notices: string[] = [];
		const ctx = {
			notice: (_level: string, text: string) => notices.push(text),
			startFleetRun: () => {
				throw new Error("usage input must never start a run");
			},
		} as unknown as SlashCommandContext;
		for (const input of ["/fleet run", "/fleet run x --var novalue", "/fleet run x --bogus"]) {
			dispatchSlashCommand(parseSlashCommand(input), ctx);
		}
		strictEqual(notices.length, 3);
		for (const text of notices) ok(text.includes("usage: /fleet run"), text);
	});

	it("hands a parsed run to the approval opener", () => {
		const started: Array<{ name: string; vars: Record<string, string> }> = [];
		const ctx = {
			notice: () => {},
			startFleetRun: (name: string, vars: Record<string, string>) => started.push({ name, vars: { ...vars } }),
		} as unknown as SlashCommandContext;
		dispatchSlashCommand(parseSlashCommand("/fleet run demo --var k=v"), ctx);
		deepStrictEqual(started, [{ name: "demo", vars: { k: "v" } }]);
	});
});

describe("contracts/fleet-run preview projection", () => {
	it("projects waves, agents, targets, boundaries, budget, and code-step argv", () => {
		const result = previewFixture();
		ok(result.ok, `preview should compile: ${result.ok ? "" : result.diagnostics.join("; ")}`);
		if (!result.ok) return;
		const { preview } = result;
		strictEqual(preview.name, "preview-demo");
		deepStrictEqual(
			preview.waves.map((wave) => wave.steps.map((step) => step.stepId)),
			[["scout"], ["build"], ["check"]],
		);
		const [scout] = preview.waves[0]?.steps ?? [];
		strictEqual(scout?.agentId, "scout");
		strictEqual(scout?.route?.targetId, "local-small");
		deepStrictEqual(scout?.writes, []);
		const [build] = preview.waves[1]?.steps ?? [];
		deepStrictEqual(build?.writes, ["src/"]);
		strictEqual(build?.route?.wireModelId, "qwen3-coder");
		const [check] = preview.waves[2]?.steps ?? [];
		strictEqual(check?.kind, "code");
		strictEqual(check?.commandId, "test");
		deepStrictEqual(check?.argv, ["npm", "run", "test"]);
		deepStrictEqual(preview.budget, { ceilingUsd: 20, currentUsd: 2.5, contractUsd: 1.5 });
		// The task every agent node carries is the rendered prompt, variables in.
		ok(preview.task.includes("the parser"), preview.task);
	});

	it("renders the projected facts in the overlay body", () => {
		const result = previewFixture();
		ok(result.ok);
		if (!result.ok) return;
		const text = stripAnsi(formatFleetRunApprovalBody({ ok: true, preview: result.preview }, 100, 0).join("\n"));
		ok(text.includes("wave 0"), text);
		ok(text.includes("local-small"), text);
		ok(text.includes("writes src/"), text);
		ok(text.includes("argv npm run test"), text);
		ok(text.includes("session ceiling"), text);
		strictEqual(formatWriteBoundary(undefined), "writes unenforced");
		strictEqual(formatWriteBoundary([]), "writes nothing");
		ok(
			formatFleetRunPreviewStep({ stepId: "a", kind: "agent", scope: "readonly", writes: [] }).includes(
				"route unresolved",
			),
		);
	});

	it("reports a preflight failure as diagnostics rather than a plan", () => {
		const result = previewFixture({ getAgentSpec: () => null });
		strictEqual(result.ok, false);
		if (result.ok) return;
		ok(result.diagnostics.length > 0);
		ok(result.diagnostics.join(" ").includes("unknown agent"), result.diagnostics.join(" "));
	});

	it("refuses unknown version 5 targets and profiles during route preflight", () => {
		for (const [field, value] of [
			["target", "missing-target"],
			["profile", "missing-profile"],
		] as const) {
			const contract = CONTRACT.replace("version: 4", "version: 5").replace(
				"    scope: readonly\n    dependencies: []",
				`    scope: readonly\n    ${field}: ${value}\n    dependencies: []`,
			);
			const result = previewFixture({
				contract,
				resolveRoute: (step) => {
					throw new Error(`unknown ${field} '${step[field]}'`);
				},
			});
			strictEqual(result.ok, false);
			if (result.ok) continue;
			ok(result.diagnostics.join(" ").includes(value), result.diagnostics.join(" "));
		}
	});

	it("refuses an unresolved version 4 route with a named preflight diagnostic", () => {
		const result = previewFixture({
			resolveRoute: () => {
				throw new Error("configured route is unavailable");
			},
		});
		strictEqual(result.ok, false);
		if (result.ok) return;
		match(result.diagnostics.join(" "), /step 'scout' route preflight failed: configured route is unavailable/);
	});

	it("offers no accept action when preflight failed", () => {
		const mounted = fakeTui();
		let accepted = 0;
		let cancelled = 0;
		openFleetRunApprovalOverlay(mounted.tui, {
			subject: { ok: false, name: "broken", diagnostics: ["unknown agent 'ghost'"] },
			columns: 100,
			onAccept: () => {
				accepted += 1;
			},
			onCancel: () => {
				cancelled += 1;
			},
		});
		const body = mounted.component();
		const text = stripAnsi(body.render(100).join("\n"));
		ok(text.includes("preflight failed"), text);
		ok(text.includes("unknown agent 'ghost'"), text);
		body.handleInput?.("\r");
		strictEqual(accepted, 0, "Enter must not accept a plan that cannot run");
		body.handleInput?.(ESC);
		strictEqual(cancelled, 1);
	});
	// Under the kitty keyboard protocol Esc arrives as CSI 27 u and a key
	// release carries the release modifier; a byte comparison against "\x1b"
	// answered neither, and the overlay could only be left by killing Clio.
	it("answers kitty-encoded keys and ignores key releases", () => {
		const mounted = fakeTui();
		let cancelled = 0;
		openFleetRunApprovalOverlay(mounted.tui, {
			subject: { ok: false, name: "broken", diagnostics: ["unknown agent 'ghost'"] },
			columns: 100,
			onAccept: () => {},
			onCancel: () => {
				cancelled += 1;
			},
		});
		const body = mounted.component();
		body.handleInput?.("\x1b[27;1:3u");
		strictEqual(cancelled, 0, "an Esc release is not a press");
		body.handleInput?.("\x1b[27u");
		strictEqual(cancelled, 1, "a kitty-encoded Esc cancels");
	});
});

describe("contracts/fleet-run approval dispatch", () => {
	it("refuses a run while a turn is in flight and never queues it", () => {
		const harness = openersHarness({ inFlight: true });
		harness.openers.startFleetRun("preview-demo", { target: "the parser" });
		strictEqual(harness.runs.length, 0);
		strictEqual(harness.overlay(), null);
		ok(harness.notices.join("\n").includes("turn is in flight"), harness.notices.join("\n"));
	});

	it("dispatches nothing when the operator cancels", () => {
		const harness = openersHarness();
		harness.openers.startFleetRun("preview-demo", { target: "the parser" });
		const overlay = harness.overlay();
		ok(overlay, "the approval overlay should have opened");
		overlay?.onCancel();
		strictEqual(harness.runs.length, 0);
		strictEqual(harness.state(), "closed");
		ok(harness.notices.join("\n").includes("nothing was dispatched"), harness.notices.join("\n"));
	});

	it("reaches the shared fleet-run path exactly once on accept and records the step's phase", () => {
		const harness = openersHarness();
		harness.openers.startFleetRun("preview-demo", { target: "the parser" });
		const overlay = harness.overlay();
		ok(overlay);
		overlay?.onAccept();
		strictEqual(harness.runs.length, 1);
		const input = harness.runs[0];
		strictEqual(input?.contractName, "preview-demo");
		strictEqual(input?.plan.steps.length, 3);
		deepStrictEqual(harness.phases, [{ runId: "run-a", wave: 0, stepId: "scout" }]);
	});
});

describe("contracts/fleet-run board phase column", () => {
	it("carries the wave and step on the row a fleet step dispatched", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		store.setFleetPhase("run-1", { wave: 2, stepId: "build" });
		// Partial payloads on purpose: the board tolerates runtime events thinner
		// than the compile-time contract, so the typed emit check is bypassed.
		bus.emit(BusChannels.DispatchStarted, { runId: "run-1", agentId: "builder" } as never);
		bus.emit(BusChannels.DispatchStarted, { runId: "run-2", agentId: "solo" } as never);
		const rows = store.rows();
		deepStrictEqual(rows.find((row) => row.runId === "run-1")?.phase, { wave: 2, stepId: "build" });
		strictEqual(rows.find((row) => row.runId === "run-2")?.phase, undefined);

		const fleetRow = rows.find((row) => row.runId === "run-1");
		const plainRow = rows.find((row) => row.runId === "run-2");
		ok(fleetRow && plainRow, "both rows should be on the board");
		if (!fleetRow || !plainRow) return;
		const fleetCard = stripAnsi(renderDispatchCard(fleetRow, 80).join("\n"));
		ok(fleetCard.includes("w2 build"), fleetCard);
		const plainCard = stripAnsi(renderDispatchCard(plainRow, 80).join("\n"));
		ok(/phase\s+—/.test(plainCard), plainCard);
	});

	it("keeps the compact island at its fixed width with and without a phase cell", () => {
		const bus = createSafeEventBus();
		const store = createDispatchBoardStore(bus);
		store.setFleetPhase("run-1", { wave: 0, stepId: "scout" });
		bus.emit(BusChannels.DispatchStarted, { runId: "run-1", agentId: "scout" } as never);
		bus.emit(BusChannels.DispatchStarted, { runId: "run-2", agentId: "solo" } as never);
		const lines = formatTaskIslandLines(store.rows());
		const widths = new Set(lines.map((line) => stripAnsi(line).length));
		strictEqual(widths.size, 1, `island rows must share one width: ${[...widths].join(",")}`);
		strictEqual(formatDispatchPhaseCell(undefined), null);
		strictEqual(formatDispatchPhaseCell({ wave: 1, stepId: "check" }), "w1 check");
	});
});
