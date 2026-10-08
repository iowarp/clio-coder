import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { isDevVersion, readClioVersionLabel } from "../../src/core/build-info.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { JobRecord } from "../../src/core/job-types.js";
import { readClioVersion } from "../../src/core/package-root.js";
import {
	stripTerminalSequences as stripAnsi,
	type Terminal,
	TuiMainScreen,
	visibleWidth,
} from "../../src/engine/tui.js";
import { ClioEditor, type EditorChrome } from "../../src/interactive/clio-editor.js";
import { createEditorSubmitController } from "../../src/interactive/editor-submit.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import {
	createInteractivePresentation,
	type InteractivePresentationDeps,
} from "../../src/interactive/interactive-presentation.js";
import { buildLayout } from "../../src/interactive/layout.js";
import {
	buildWelcomeDashboardLines,
	createBootWelcome,
	createWelcomeDashboard,
	WELCOME_PROJECT_CONTEXT_RETRY_MS,
	WELCOME_PROJECT_CONTEXT_TTL_MS,
	WELCOME_TAGLINES,
	type WelcomeDashboardDeps,
} from "../../src/interactive/welcome-dashboard.js";

/** Content assertions ignore the box; geometry tests below inspect raw rendered rows. */
function stripTerminalSequences(line: string): string {
	return stripAnsi(line)
		.replace(/^│ /u, "  ")
		.replace(/ │( *)$/u, "  $1");
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);

const WIDTHS = [8, 12, 20, 30, 40, 60, 80, 120, 160, 200] as const;

type Health = { status: string; lastCheckAt: string | null; lastError: string | null; latencyMs: number | null };

function health(status: string, lastError: string | null = null, latencyMs: number | null = null): Health {
	return { status, lastCheckAt: status === "unknown" ? null : "2026-09-10T00:00:00.000Z", lastError, latencyMs };
}

function status(over: Record<string, unknown> = {}): unknown {
	return {
		target: { id: "dynamo", defaultModel: "qwen3.8-27b", runtime: "lmstudio", wireModels: [] },
		runtime: { id: "lmstudio" },
		available: true,
		reason: "configured",
		health: health("healthy", null, 42),
		capabilities: { tools: true, reasoning: true, contextWindow: 131072 },
		...over,
	};
}

function workspace(over: Record<string, unknown> = {}): unknown {
	return {
		cwd: "/tmp/work/clio-coder",
		isGit: true,
		branch: "main",
		dirty: false,
		ahead: null,
		behind: null,
		recentCommits: [],
		remoteUrl: null,
		projectType: "node",
		capturedAt: "2026-09-10T00:00:00.000Z",
		...over,
	};
}

interface BannerOptions {
	preload?: string;
	statuses?: unknown[];
	target?: string | undefined;
	model?: string | undefined;
	workspace?: unknown;
	clioMd?: "ok" | "stale" | "none" | "malformed";
	contextThrows?: boolean;
	submitKey?: string | null;
	now?: () => number;
	/** Defaults to a synchronous runner so a render's refresh lands deterministically. */
	scheduleRefresh?: (run: () => void) => void;
	onFactsRefreshed?: () => void;
	countContextReads?: { value: number };
	countSubmitKeyReads?: { value: number };
}

function banner(options: BannerOptions = {}) {
	const deps: WelcomeDashboardDeps = {
		getProjectPreload: () => options.preload ?? null,
		providers: { list: () => (options.statuses ?? [status()]) as never },
		getSettings: () =>
			({
				chat: {
					target: "target" in options ? options.target : "dynamo",
					model: "model" in options ? options.model : "qwen3.8-27b",
					thinkingLevel: "off",
				},
			}) as never,
		getWorkspaceSnapshot: () => (options.workspace === undefined ? workspace() : options.workspace) as never,
		getContextState: () => {
			if (options.countContextReads) options.countContextReads.value += 1;
			if (options.contextThrows === true) throw new Error("context read failed");
			return { clioMd: options.clioMd ?? "ok", memoryCount: 0 } as never;
		},
		getSubmitKeyLabel: () => {
			if (options.countSubmitKeyReads) options.countSubmitKeyReads.value += 1;
			return options.submitKey === undefined ? "Enter" : options.submitKey;
		},
		scheduleRefresh: options.scheduleRefresh ?? ((run) => run()),
		...(options.now ? { now: options.now } : {}),
		...(options.onFactsRefreshed ? { onFactsRefreshed: options.onFactsRefreshed } : {}),
	};
	return createWelcomeDashboard(deps);
}

/** Render twice: the first lands the scheduled context read, the second is a steady frame. */
function rows(component: ReturnType<typeof banner>, width: number): string[] {
	component.render(width);
	return component.render(width).map((line) => stripTerminalSequences(line));
}

function actionLine(lines: readonly string[]): string {
	return lines.at(-2)?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Displayed text
// ---------------------------------------------------------------------------

test("the session header shows the active route without a latency number", () => {
	const component = banner();
	component.collapseToSessionHeader();
	const lines = rows(component, 120);
	ok(lines[0]?.includes("dynamo · qwen3.8-27b"), lines[0]);
	ok(!lines.join("\n").includes("42ms"), "probe latency must not reach the header");
	ok(!lines.join("\n").includes("healthy"), "the session header does not claim readiness");
});

test("a failing route names the repair surface without spilling provider diagnostics into the welcome", () => {
	const lines = rows(
		banner({
			statuses: [
				status({ available: false, reason: "connection refused", health: health("down", "ECONNREFUSED 127.0.0.1:1234") }),
			],
		}),
		80,
	);
	ok(actionLine(lines).includes("route unavailable · /settings targets"), actionLine(lines));
	ok(!lines.join("\n").includes("ECONNREFUSED"), "raw provider error should not crowd the welcome");
});

test("the route repair action fits at 60 columns", () => {
	const lines = rows(
		banner({
			statuses: [status({ available: false, reason: "refused", health: health("down", "ECONNREFUSED 127.0.0.1:1234") })],
		}),
		60,
	);
	ok(actionLine(lines).includes("route unavailable · /settings targets"), actionLine(lines));
});

test("at 40 columns the route fault remains visible and its cut is marked", () => {
	const lines = rows(
		banner({
			statuses: [status({ available: false, reason: "refused", health: health("down", "ECONNREFUSED 127.0.0.1:1234") })],
		}),
		40,
	);
	ok(actionLine(lines).includes("route unavailable"), actionLine(lines));
	ok(actionLine(lines).includes("…"), "a cut must be marked");
});

test("a configured but unprobed target is neither ready nor unavailable", () => {
	const component = banner({ statuses: [status({ health: health("unknown") })] });
	const lines = rows(component, 80).join("\n");
	ok(!lines.includes("✓"), "an unprobed target must not claim readiness");
	ok(!lines.includes("✗"), "an unprobed target must not claim failure");
	ok(!lines.includes("unavailable"), lines);
	component.collapseToSessionHeader();
	ok(rows(component, 120)[0]?.includes("dynamo · qwen3.8-27b"));
});

test("a target with no model and no default is unset, not ready", () => {
	const lines = rows(
		banner({
			statuses: [status({ target: { id: "dynamo", defaultModel: null, runtime: "lmstudio", wireModels: [] } })],
			model: undefined,
		}),
		80,
	);
	ok(actionLine(lines).includes("no model selected · /model"), actionLine(lines));
	ok(!lines.join("\n").includes("✓"), "a route with no model must not read as ready");
});

test("no target and no model names the route, not the context", () => {
	const lines = rows(banner({ statuses: [], target: undefined, model: undefined, clioMd: "none" }), 80);
	ok(actionLine(lines).includes("no route selected · /model"), actionLine(lines));
	ok(!actionLine(lines).includes("/context init"), "route faults outrank context guidance");
});

test("a target id absent from the list directs the operator to route settings", () => {
	const lines = rows(
		banner({ statuses: [status({ target: { id: "other", defaultModel: "m", runtime: "lmstudio", wireModels: [] } })] }),
		80,
	);
	ok(actionLine(lines).includes("route unavailable · /settings targets"), actionLine(lines));
});

test("a malformed CLIO-CODER.md points at the read-only view, never at a regenerating command", () => {
	const lines = rows(banner({ clioMd: "malformed" }), 80);
	ok(actionLine(lines).includes("CLIO-CODER.md malformed · /context to inspect"), actionLine(lines));
	const all = lines.join("\n");
	ok(!all.includes("/context init"), "init would overwrite the file the operator must repair");
	ok(!all.includes("/context refresh"), "refresh regenerates; it is not a repair for malformed content");
});

test("missing project context is guidance that keeps the invitation to work", () => {
	const lines = rows(banner({ clioMd: "none" }), 80);
	ok(actionLine(lines).includes("/context init to index this repo"), actionLine(lines));
	ok(WELCOME_TAGLINES.some((tagline) => lines.join("\n").includes(tagline)));
});

test("stale project context offers refresh", () => {
	const lines = rows(banner({ clioMd: "stale" }), 80);
	ok(actionLine(lines).includes("Stale project awareness: /context refresh to fix."), actionLine(lines));
});

test("the welcome action never advertises a submit binding", () => {
	const actions = ["Enter", "Ctrl+S", null].map((submitKey) => actionLine(rows(banner({ submitKey }), 80)));
	strictEqual(new Set(actions).size, 1);
	ok(actions[0]?.endsWith(`v${readClioVersion()}${isDevVersion(readClioVersion()) ? "·source" : ""}`));
	ok(!actions[0]?.includes("to send"), actions[0]);
});

test("route faults outrank project-context guidance", () => {
	const lines = rows(
		banner({
			clioMd: "none",
			statuses: [status({ available: false, reason: "down", health: health("down", "boom") })],
		}),
		80,
	);
	ok(actionLine(lines).includes("route unavailable · /settings targets"), actionLine(lines));
	ok(!actionLine(lines).includes("/context init"), actionLine(lines));
});

// ---------------------------------------------------------------------------
// Untrusted text
// ---------------------------------------------------------------------------

/**
 * True when no C0 control byte or DEL survived into a rendered line. Written as
 * a scan rather than a regex literal so no control character appears in source,
 * the same reason domains/safety/call-target.ts builds its patterns dynamically.
 * Applied per line: a rendered line is a single row and must contain no line
 * break of its own.
 */
function controlFreeLines(lines: ReadonlyArray<string>): boolean {
	for (const line of lines) {
		for (const ch of line) {
			const code = ch.codePointAt(0) ?? 0;
			if (code < 0x20 || code === 0x7f) return false;
		}
	}
	return true;
}

test("a hostile provider reason cannot style, clear, or retitle the terminal", () => {
	const hostile = `${ESC}]0;PWNED${BEL}upstream 502\r\n${ESC}[31m${ESC}[2Jbad gateway${ESC}[10;10H 网关错误 ${NUL} tail`;
	const component = banner({
		statuses: [status({ available: false, reason: "configured", health: health("down", hostile) })],
	});
	component.render(120);
	const lines = component.render(120);
	const raw = lines.join("\n");
	ok(!raw.includes(`${ESC}]`), "OSC introducer reached the screen");
	ok(!raw.includes(`${ESC}[2J`), "a clear-screen sequence reached the screen");
	ok(!raw.includes(`${ESC}[10;10H`), "a cursor-move sequence reached the screen");
	ok(!raw.includes(BEL) && !raw.includes(NUL), "a control byte reached the screen");
	ok(!raw.includes("PWNED"), "OSC payload text survived");
	const visible = lines.map((line) => stripTerminalSequences(line));
	ok(controlFreeLines(visible), `control byte survived: ${JSON.stringify(visible)}`);
	ok(actionLine(visible).includes("route unavailable · /settings targets"), actionLine(visible));
	ok(!visible.join("\n").includes("upstream 502"), "provider diagnostics should stay out of the welcome");
});

test("escape sequences in the cwd and branch are neutralized too", () => {
	const component = banner({
		workspace: workspace({ cwd: `/tmp/wo${ESC}[31mrk/re${BEL}po`, branch: `ma${ESC}]0;x${BEL}in` }),
	});
	component.render(120);
	const lines = component.render(120);
	const raw = lines.join("\n");
	ok(!raw.includes(`${ESC}]`) && !raw.includes(`${ESC}[31m`), "an injected sequence reached the screen");
	const visible = lines.map((line) => stripTerminalSequences(line));
	ok(controlFreeLines(visible), `control byte survived: ${JSON.stringify(visible)}`);
	ok(visible.join("\n").includes("re po"), visible.join("\n"));
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const GEOMETRY_CASES: Array<[string, BannerOptions]> = [
	["ready", {}],
	["unprobed", { statuses: [status({ health: health("unknown") })] }],
	["unset", { statuses: [], target: undefined, model: undefined }],
	[
		"down",
		{ statuses: [status({ available: false, reason: "x", health: health("down", "ECONNREFUSED 127.0.0.1:1234") })] },
	],
	["malformed", { clioMd: "malformed" }],
	["non-git", { workspace: workspace({ isGit: false, branch: null, dirty: null }) }],
	[
		"long-unicode",
		{
			statuses: [
				status({
					target: {
						id: "hpc-gateway-北京-cluster",
						defaultModel: "deepseek-ai/DeepSeek-Coder-V2.5-Instruct-0724-fp8-长上下文",
						runtime: "openai-completions",
						wireModels: [],
					},
				}),
			],
			target: "hpc-gateway-北京-cluster",
			model: "deepseek-ai/DeepSeek-Coder-V2.5-Instruct-0724-fp8-长上下文",
			workspace: workspace({
				cwd: "/tmp/研究/実験-データ/very-long-project-directory-name-for-overflow",
				branch: "feature/scientific-workflow-integration-with-a-very-long-branch-name",
			}),
		},
	],
	[
		"emoji-combining",
		{
			statuses: [status({ target: { id: "lab-🧪", defaultModel: "modél-👩‍🔬-v2", runtime: "lmstudio", wireModels: [] } })],
			target: "lab-🧪",
			model: "modél-👩‍🔬-v2",
			workspace: workspace({ cwd: "/tmp/projécts/🧬-genome-🔬-pipeline", branch: "main-🚀" }),
		},
	],
];

test("the launchpad keeps a bounded footprint and the session header one row", () => {
	for (const [label, options] of GEOMETRY_CASES) {
		for (const width of WIDTHS) {
			const launchpad = banner(options);
			const baseRows = width >= 57 && width < 76 ? 21 : 17;
			const taglineRows = width < 40 ? 0 : width < 76 ? 2 : 1;
			const height = rows(launchpad, width).length;
			ok(height >= baseRows && height <= baseRows + taglineRows, `${label}@${width} launchpad rows: ${height}`);
			const session = banner(options);
			session.collapseToSessionHeader();
			strictEqual(rows(session, width).length, 1, `${label}@${width} session rows`);
		}
	}
});

test("no rendered line ever exceeds its width", () => {
	for (const [label, options] of GEOMETRY_CASES) {
		for (const width of WIDTHS) {
			for (const mode of ["launchpad", "session"] as const) {
				const component = banner(options);
				if (mode === "session") component.collapseToSessionHeader();
				component.render(width);
				for (const line of component.render(width)) {
					const measured = visibleWidth(line);
					ok(measured <= width, `${label}/${mode}@${width}: line measured ${measured} columns`);
				}
			}
		}
	}
});

test("the session header keeps the route when everything else has to go", () => {
	const component = banner();
	component.collapseToSessionHeader();
	for (const width of [20, 30, 40]) {
		const line = rows(component, width)[0] ?? "";
		ok(line.includes("dynamo"), `route lost at ${width} columns: ${line}`);
	}
	// Wide enough, identity sits next to the wordmark rather than trailing the row.
	const wide = rows(component, 120)[0] ?? "";
	match(wide, /^>C_ Clio Coder v\d+\.\d+\.\d+(?:-(?:dev·source|rc\.\d+|snapshot\.\d{12}\.g[0-9a-f]{7}))? · dynamo/u);
});

test("the collapsed header drops readiness, latency and onboarding", () => {
	const component = banner({ clioMd: "none" });
	component.collapseToSessionHeader();
	const line = rows(component, 160)[0] ?? "";
	for (const forbidden of ["✓", "✗", "◌", "describe a task", "/context init", "to send", "/ for commands"]) {
		ok(!line.includes(forbidden), `collapsed header still shows ${forbidden}: ${line}`);
	}
	ok(line.includes("dynamo · qwen3.8-27b"), line);
});

test("the workspace gives up its branch before the path's leaf", () => {
	const component = banner({
		workspace: workspace({ cwd: "/tmp/a/b/c/project-leaf", branch: "an-extremely-long-branch-name-that-will-not-fit" }),
	});
	component.collapseToSessionHeader();
	const masthead = rows(component, 100)[0] ?? "";
	ok(masthead.includes("project-leaf"), `leaf lost while branch kept: ${masthead}`);
	ok(!masthead.includes("an-extremely-long-branch-name"), masthead);
});

// ---------------------------------------------------------------------------
// The off-render project-context read
// ---------------------------------------------------------------------------

test("render never calls the context reader on its own call stack", () => {
	const reads = { value: 0 };
	const deferred: Array<() => void> = [];
	const component = banner({ countContextReads: reads, scheduleRefresh: (run) => deferred.push(run) });
	const first = component.render(80).map(stripTerminalSequences);
	strictEqual(reads.value, 0, "the reader ran inside render");
	ok(actionLine(first).includes("Checking project awareness…"), actionLine(first));
	ok(deferred.length === 1, "a refresh should be scheduled exactly once");
	for (const run of deferred.splice(0)) run();
	strictEqual(reads.value, 1);
});

test("a scheduled refresh asks for a frame when it lands", () => {
	let frames = 0;
	const deferred: Array<() => void> = [];
	const component = banner({
		clioMd: "none",
		onFactsRefreshed: () => {
			frames += 1;
		},
		scheduleRefresh: (run) => deferred.push(run),
	});
	component.render(80);
	strictEqual(frames, 0);
	for (const run of deferred.splice(0)) run();
	strictEqual(frames, 1);
	ok(actionLine(component.render(80).map(stripTerminalSequences)).includes("/context init to index this repo"));
});

test("a reader that throws never becomes ok or none", () => {
	const component = banner({ contextThrows: true });
	const lines = rows(component, 80);
	ok(actionLine(lines).includes("Checking project awareness…"), actionLine(lines));
	ok(!actionLine(lines).includes("/context"), "a failed read must not suggest a context command");
});

test("a failure never renews the trust window, and a stale value stops being asserted", () => {
	let clock = 1_000;
	let fail = false;
	const component = createWelcomeDashboard({
		providers: { list: () => [status()] as never },
		getSettings: () => ({ chat: { target: "dynamo", model: "qwen3.8-27b", thinkingLevel: "off" } }) as never,
		getWorkspaceSnapshot: () => workspace() as never,
		getContextState: () => {
			if (fail) throw new Error("read failed");
			return { clioMd: "none", memoryCount: 0 } as never;
		},
		getSubmitKeyLabel: () => "Enter",
		scheduleRefresh: (run) => run(),
		now: () => clock,
	});
	const action = (): string => {
		component.render(80);
		return actionLine(component.render(80).map(stripTerminalSequences));
	};
	ok(action().includes("/context init to index this repo"));

	// Reads start failing. The last good value stands in while retries are paced…
	fail = true;
	clock += WELCOME_PROJECT_CONTEXT_TTL_MS + 1;
	ok(action().includes("/context init to index this repo"));
	clock += WELCOME_PROJECT_CONTEXT_RETRY_MS + 1;
	ok(action().includes("/context init to index this repo"));

	// …but once the failure streak outlives the trust window it stops being asserted.
	clock += WELCOME_PROJECT_CONTEXT_TTL_MS + 1;
	ok(action().includes("Checking project awareness…"));

	// A successful read restores a real answer.
	fail = false;
	clock += WELCOME_PROJECT_CONTEXT_RETRY_MS + 1;
	ok(action().includes("/context init to index this repo"));
});

test("a reading is never served for a different directory", () => {
	let cwd = "/tmp/work/first";
	const seen: string[] = [];
	const component = createWelcomeDashboard({
		providers: { list: () => [status()] as never },
		getSettings: () => ({ chat: { target: "dynamo", model: "qwen3.8-27b", thinkingLevel: "off" } }) as never,
		getWorkspaceSnapshot: () => workspace({ cwd }) as never,
		getContextState: (requested) => {
			seen.push(requested);
			return { clioMd: requested.endsWith("first") ? "none" : "ok", memoryCount: 0 } as never;
		},
		getSubmitKeyLabel: () => "Enter",
		scheduleRefresh: (run) => run(),
	});
	component.render(80);
	ok(actionLine(component.render(80).map(stripTerminalSequences)).includes("/context init to index this repo"));
	cwd = "/tmp/work/second";
	ok(actionLine(component.render(80).map(stripTerminalSequences)).includes("Checking project awareness…"));
	ok(actionLine(component.render(80).map(stripTerminalSequences)).includes("/context to inspect project awareness"));
	deepStrictEqual(seen, ["/tmp/work/first", "/tmp/work/second"]);
});

test("the collapsed header spends nothing on facts it does not show", () => {
	const reads = { value: 0 };
	const keys = { value: 0 };
	const component = banner({ countContextReads: reads, countSubmitKeyReads: keys });
	component.collapseToSessionHeader();
	for (let index = 0; index < 5; index += 1) component.render(80 + index);
	strictEqual(reads.value, 0, "session mode read project context it cannot display");
	strictEqual(keys.value, 0, "session mode read a submit key it cannot display");
	// Returning to the launchpad resumes the check.
	component.resetToLaunchpad();
	component.render(80);
	ok(reads.value > 0, "the launchpad must resume the project-context check");
});

test("dispose stops a pending refresh from touching a torn-down presentation", () => {
	let frames = 0;
	const deferred: Array<() => void> = [];
	const component = banner({
		onFactsRefreshed: () => {
			frames += 1;
		},
		scheduleRefresh: (run) => deferred.push(run),
	});
	component.render(80);
	strictEqual(deferred.length, 1);
	component.dispose();
	for (const run of deferred.splice(0)) run();
	strictEqual(frames, 0, "a refresh after dispose asked for a frame");
});

test("mode transitions are idempotent", () => {
	const component = banner();
	strictEqual(component.collapseToSessionHeader(), true);
	strictEqual(component.collapseToSessionHeader(), false);
	strictEqual(component.resetToLaunchpad(), true);
	strictEqual(component.resetToLaunchpad(), false);
});

// ---------------------------------------------------------------------------
// Integration through the real presentation graph
// ---------------------------------------------------------------------------

function noop(): void {}

/**
 * The real `createInteractivePresentation` with the real banner factory, so the
 * transitions below run through the wiring the application uses rather than
 * through direct calls on the component.
 */
function presentation(over: Partial<InteractivePresentationDeps> = {}, realEditor = false, realFooter = false) {
	let rendered = 0;
	let footerDeps!: Parameters<typeof buildFooterDashboard>[0];
	const view = { render: () => [], invalidate: noop };
	const deps = {
		bus: { on: () => noop, emit: noop },
		providers: { list: () => [status()] },
		dispatch: { snapshot: () => ({ running: [] }) },
		observability: { bindRunReaders: () => noop, snapshot: () => ({ session: {} }), subscribe: () => noop },
		chat: {
			contextUsage: () => ({}),
			contextLedger: () => null,
			isStreaming: () => false,
			turnPreparation: () => ({ phase: "idle" }),
			activeSkillSurface: () => [],
		},
		workspaceFacts: {
			getExtensionStats: () => ({ active: 0, installed: 0 }),
			getLiveWorkspaceSnapshot: () => workspace(),
			getWorkspaceSnapshot: () => workspace(),
			refreshLiveWorkspaceGit: () => Promise.resolve(),
		},
		sessionTranscript: { liveSessionTurns: () => 0 },
		tui: {
			requestRender: () => {
				rendered += 1;
			},
		},
		terminal: { columns: 100 },
		keybindings: {
			getKeys: (id: string) => (id === "tui.input.submit" ? ["enter"] : []),
			isDisabled: () => false,
			actionLabel: () => "unbound; see /help",
		},
		getSettings: () => ({
			...DEFAULT_SETTINGS,
			chat: { ...DEFAULT_SETTINGS.chat, target: "dynamo", model: "qwen3.8-27b", thinkingLevel: "off" },
			interface: { ...DEFAULT_SETTINGS.interface, mode: "regular", outputDetail: "standard", smoothStreaming: "off" },
		}),
		getContextState: () => ({ clioMd: "ok", memoryCount: 0 }),
		scheduleInterval: () => ({ unref: noop }),
		clearScheduledInterval: noop,
		factories: {
			createChatPanel: () => ({ ...view, reset: noop, appendReplayBlock: noop, workerStates: () => [] }),
			createFollowUpQueuePanel: () => view,
			createStatusController: () => ({ current: () => ({ phase: "idle" }), reset: noop, dispose: noop }),
			createDispatchBoardStore: () => ({ rows: () => [], activeRows: () => [], unsubscribe: noop }),
			createContextActivityStore: () => ({ current: () => null, unsubscribe: noop }),
			createNotificationCenter: () => ({ add: noop, list: () => [], dismiss: noop }),
			buildFooter: (deps: Parameters<typeof buildFooterDashboard>[0]) => {
				footerDeps = deps;
				return realFooter
					? buildFooterDashboard({ ...deps, resolveCurrentBranch: async () => null })
					: { view, refresh: noop, dispose: noop, isExpanded: () => false };
			},
			createEditor: (_tui: unknown, chrome: EditorChrome) =>
				realEditor
					? new ClioEditor(new TuiMainScreen({ columns: 120, rows: 24, write: noop } as unknown as Terminal), chrome)
					: { ...view, render: () => ["COMPOSER"], focused: false, setAutocompleteProvider: noop },
			createAutocomplete: () => ({}),
			createDispatchBoardView: () => view,
			createChatRenderer: () => ({ mutate: (run: () => void) => run(), reset: (run: () => void) => run(), flush: noop }),
			createIo: () => ({ stderr: noop, stdout: noop }),
			buildLayout,
		},
		...over,
	} as unknown as InteractivePresentationDeps;
	const built = createInteractivePresentation(deps);
	return { presentation: built, renders: () => rendered, footerDeps };
}

function headerRows(built: ReturnType<typeof presentation>["presentation"], width = 100): string[] {
	built.banner.render(width);
	return built.banner.render(width).map((line) => stripTerminalSequences(line));
}

test("the presentation opens on the launchpad and collapses on first submit", async () => {
	const { presentation: built } = presentation();
	strictEqual(headerRows(built).length, 18);

	// Drive the collapse through the real submit controller, the way a typed
	// prompt reaches it, rather than by calling the banner directly.
	let dispatched = "";
	const controller = createEditorSubmitController({
		editor: {
			getText: () => "",
			getTextForSubmit: () => "",
			setText: noop,
			addToHistory: noop,
		},
		ui: { start: noop, stop: noop, requestRender: noop },
		io: { stderr: noop, stdout: noop },
		chat: { isStreaming: () => false },
		dispatch: { snapshot: () => ({ running: [] }) },
		sessionTranscript: {
			ensureSessionForLocalEntry: noop,
			refreshChatContextFromSession: noop,
			recordSubmittedTurn: noop,
		},
		chatPanel: { appendReplayBlock: noop },
		dispatchCommand: (text: string) => {
			dispatched = text;
			return "accepted";
		},
		collapseLaunchpadBeforeSubmit: () => built.collapseWelcomeDashboard(),
		expandSubmit: async (text: string) => ({ text, images: [] }),
		notify: noop,
	} as never);

	controller.submitEditorText("explain the boot path");
	strictEqual(dispatched, "explain the boot path");
	strictEqual(headerRows(built).length, 1, "the header did not collapse on first submit");

	// A second submit must not transition again.
	controller.submitEditorText("and the resume path");
	strictEqual(headerRows(built).length, 1);
});

test("a session reset restores the launchpad and clears tool telemetry, including late results", (t) => {
	let wall = 100_000;
	let elapsed = 1_000;
	t.mock.method(Date, "now", () => wall);
	t.mock.method(performance, "now", () => elapsed);
	for (const mode of ["regular", "fullscreen"] as const) {
		let currentSession = "loop-session";
		let reads = 0;
		let listener: ((job: JobRecord) => void) | null = null;
		let heartbeat: (() => void) | undefined;
		const job: JobRecord = {
			version: 1,
			id: "watch-build",
			revision: 0,
			spec: {
				intervalMs: 10_000,
				runner: { kind: "main", prompt: "Inspect build" },
				count: 3,
				deadlineAt: null,
				timeoutMs: 1_000,
				until: null,
				onMatch: { kind: "notice" },
				constraints: null,
				originTurnId: null,
			},
			specHash: "fixture",
			owner: { sessionId: currentSession, cwd: process.cwd(), generation: "initial" },
			generation: 0,
			process: { pid: process.pid, birthToken: null, instanceId: "fixture" },
			createdAt: wall,
			updatedAt: wall,
			state: "active",
			reason: null,
			cancelRequested: false,
			nextDueAt: wall + 10_000,
			starts: 0,
			settled: 0,
			consecutiveFailures: 0,
			pendingReason: null,
			active: null,
			pending: null,
			history: [],
			delivery: null,
			costUsd: null,
			persistenceError: null,
		};
		const emit = (updated: JobRecord): void => {
			listener?.(updated);
		};
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.interface.mode = mode;
		const {
			presentation: built,
			footerDeps,
			renders,
		} = presentation(
			{
				getSessionId: () => currentSession,
				getSettings: () => settings,
				jobs: {
					list: () => {
						reads += 1;
						return currentSession === "loop-session" ? [job] : [];
					},
					subscribe: (next) => {
						listener = next;
						return () => {
							listener = null;
						};
					},
				},
				scheduleInterval: (run, interval) => {
					if (interval === 1_000) heartbeat = run;
					return { unref: noop };
				},
			},
			true,
			true,
		);
		const frame = (width = 100): string[] => built.root.render(width).map(stripAnsi);
		const loopRow = (width = 100): string => frame(width).find((row) => row.includes("Loop ")) ?? "";
		try {
			match(loopRow(), /Loop waiting · ────── · 0\/3 · in 10s/u);
			const rows = frame();
			strictEqual(loopRow(), stripAnsi(built.editor.render(100).at(-1) ?? ""));
			ok(rows.find((row) => row.includes("Loop "))?.startsWith("━ Loop "), "loop status belongs to the composer rail");
			emit({ ...job, id: "other-watch" });
			match(loopRow(), /\+1 loops/u);
			for (const width of [1, 8, 20, 40, 80, 120]) {
				frame(width);
				const row = stripAnsi(built.editor.render(width).at(-1) ?? "");
				ok(row.length > 0);
				ok(visibleWidth(row) <= width, row);
			}
			emit({ ...job, id: "other-watch", state: "terminal", nextDueAt: null });
			built.footer.setExpanded(true);
			match(loopRow(), /waiting/u);
			built.footer.setExpanded(false);
			const beforeTick = renders();
			wall += 2_000;
			elapsed += 2_000;
			heartbeat?.();
			ok(renders() > beforeTick, "idle loops must repaint their next-run countdown");
			match(loopRow(), /Loop waiting · ━───── · 0\/3 · in 8\.0s/u);
			strictEqual(reads, 1, "rendering and heartbeat must use the event cache");
			const occurrence = {
				id: "run-1",
				scheduledAt: wall,
				startedAt: wall,
				endedAt: null,
				state: "running" as const,
				evidence: null,
			};
			emit({ ...job, active: occurrence, starts: 1 });
			match(loopRow(), /Loop running · 0\/3/u);
			emit({ ...job, active: occurrence, starts: 1, persistenceError: "write failed" });
			match(loopRow(), /not saved/u);
			ok(!loopRow().includes("running"));
			emit({ ...job, pendingReason: "Waiting for operator \x1b]0;FAKE\x07 input\nready" });
			const waiting = loopRow(160);
			match(waiting, /waiting/u);
			ok(!waiting.includes("FAKE") && !waiting.includes("\n"), waiting);
			emit({ ...job, state: "paused", nextDueAt: null });
			match(loopRow(), /paused/u);
			emit({ ...job, state: "terminal", cancelRequested: true, active: occurrence, nextDueAt: null, starts: 1 });
			match(loopRow(), /Loop cancel requested · 0\/3/u);
			emit({
				...job,
				state: "terminal",
				nextDueAt: null,
				delivery: {
					id: "delivery-1",
					occurrenceId: "run-1",
					kind: "main_turn",
					state: "pending",
					createdAt: wall,
					startedAt: null,
					endedAt: null,
					reason: null,
					evidence: null,
				},
			});
			match(loopRow(), /analysis waiting/u);
			emit({
				...job,
				state: "terminal",
				nextDueAt: null,
				delivery: {
					id: "notice-1",
					occurrenceId: "run-1",
					kind: "notice",
					state: "pending",
					createdAt: wall,
					startedAt: null,
					endedAt: null,
					reason: null,
					evidence: null,
				},
			});
			match(loopRow(), /notice waiting/u);
			emit({ ...job, state: "terminal", nextDueAt: null, starts: 3, settled: 3 });
			strictEqual(loopRow(), "", "completed jobs leave the band immediately");
			emit(job);
			built.collapseWelcomeDashboard();
			strictEqual(headerRows(built).length, 1);
			built.recordToolStart("failed-call", "bash");
			built.recordToolEnd({ toolCallId: "failed-call", isError: true, truncated: true });
			built.recordToolStart("pending-call", "read");
			deepStrictEqual(footerDeps.getToolCounts?.(), {
				tools: { bash: 1, read: 1 },
				errors: 1,
				active: 1,
				truncatedResults: 1,
			});
			currentSession = "other-session";
			built.resetForNewSession();
			strictEqual(loopRow(), "", "session navigation clears the old loop projection");
			emit(job);
			strictEqual(loopRow(), "", "late old-session updates cannot restore its row");
			strictEqual(headerRows(built).length, 18);
			built.collapseWelcomeDashboard();
			strictEqual(headerRows(built).length, 1);
			built.recordToolEnd({ toolCallId: "pending-call", isError: true, truncated: true });
			deepStrictEqual(footerDeps.getToolCounts?.(), { tools: {}, errors: 0, active: 0, truncatedResults: 0 });
			strictEqual(built.toolCounts().size, 0);
			built.recordToolStart("current-call", "read");
			built.recordToolEnd({ toolCallId: "current-call", isError: true, truncated: false });
			built.recordToolEnd({ toolCallId: "current-call", isError: true, truncated: false });
			deepStrictEqual(footerDeps.getToolCounts?.(), { tools: { read: 1 }, errors: 1, active: 0, truncatedResults: 0 });
			currentSession = "loop-session";
			built.resetForNewSession();
			match(loopRow(), /Loop waiting · .*0\/3/u);
			strictEqual(reads, 3, "each canonical session reset loads one scoped snapshot");
		} finally {
			built.dispose();
			strictEqual(listener, null, "disposing the presentation releases its job subscription");
		}
	}
});

test("a boot-time resume opens collapsed, with no fresh-start onboarding", () => {
	const { presentation: built } = presentation({ startsResumed: true } as Partial<InteractivePresentationDeps>);
	const lines = headerRows(built);
	strictEqual(lines.length, 1, "a resumed boot showed the launchpad");
	ok(!lines[0]?.includes("describe a task"), lines[0]);
	ok(lines[0]?.includes("dynamo · qwen3.8-27b"), lines[0]);
});

test("the presentation's welcome action leaves submit bindings to the composer", () => {
	const rebound = presentation({
		keybindings: {
			getKeys: (id: string) => (id === "tui.input.submit" ? ["ctrl+s"] : []),
			isDisabled: () => false,
			actionLabel: () => "",
		},
	} as unknown as Partial<InteractivePresentationDeps>);
	const reboundAction = actionLine(headerRows(rebound.presentation));
	ok(!reboundAction.includes("Ctrl+S") && !reboundAction.includes("to send"), reboundAction);

	const unbound = presentation({
		keybindings: { getKeys: () => [], isDisabled: () => true, actionLabel: () => "" },
	} as unknown as Partial<InteractivePresentationDeps>);
	strictEqual(actionLine(headerRows(unbound.presentation)), reboundAction);
});

test("disposing the presentation disposes the header", () => {
	const { presentation: built } = presentation();
	built.dispose();
	// A disposed banner schedules nothing further; rendering must still be safe.
	strictEqual(headerRows(built).length, 18);
});

for (const width of [40, 44, 60, 92, 120]) {
	test(`production presentation keeps model identity in the composer and session header at ${width} columns`, () => {
		let model = "very-long-placement/qwopus3.8-27b-q6";
		const settings = structuredClone(DEFAULT_SETTINGS);
		const terminal = { columns: width };
		const { presentation: built } = presentation(
			{
				terminal,
				getSettings: () => ({
					...settings,
					chat: { ...settings.chat, target: "blade-gateway", model, thinkingLevel: "low" },
					interface: { ...settings.interface, mode: "regular", outputDetail: "standard", smoothStreaming: "off" },
				}),
			},
			true,
			true,
		);
		const footerRows = (columns: number): string[] => {
			terminal.columns = columns;
			built.footer.refresh();
			const rows = built.footer.view.render(columns);
			for (const row of rows) ok(visibleWidth(row) <= columns);
			return rows;
		};
		try {
			built.banner.collapseToSessionHeader();
			const identities: string[] = [];
			for (const placement of ["very-long-placement", "dynamo-long-placement"]) {
				for (const family of ["qwopus3.8", "llamus3.8", "qwen3", "llama3"]) {
					model = `${placement}/${family}-27b-q6`;
					deepStrictEqual(built.editorChrome.getModelLabel(), { targetId: "blade-gateway", modelId: model });
					const composer = built.editor.render(width);
					for (const row of composer) ok(visibleWidth(row) <= width);
					const rail = stripTerminalSequences(composer[0] ?? "");
					const nickname = family.charAt(0).toUpperCase() + family.slice(1);
					ok(rail.includes(nickname), rail);
					for (const label of [placement, "blade-gateway", "q6"]) ok(!rail.includes(label), rail);
					const footer = footerRows(width).map(stripTerminalSequences).join("\n");
					ok(footer.includes("clio-coder"), footer);
					ok(!footer.includes("q6"), "compact footer should leave model identity to the rail");
					const session = headerRows(built, 120)[0] ?? "";
					ok(session.includes(`blade-gateway · ${model}`), session);
					identities.push(session);
				}
			}
			strictEqual(new Set(identities).size, 8, "all families and placements stay distinct with room to show them");
			// The callback carries raw fields; both visible identity surfaces sanitize them.
			model = `very-long-placement/\x1b]0;FAKE_MODEL_NAME\x07qwopus3.8-27b-q6`;
			deepStrictEqual(built.editorChrome.getModelLabel(), { targetId: "blade-gateway", modelId: model });
			const raw = `${built.editor.render(width).join("\n")}\n${headerRows(built, 120).join("\n")}`;
			ok(!raw.includes("FAKE_MODEL_NAME") && !raw.includes("\x1b]"), raw);
			ok(stripTerminalSequences(raw).includes("very-long-placement/qwopus3.8-27b-q6"), raw);
		} finally {
			built.dispose();
		}
	});
}

test("the composer rail uses a model nickname while the session header retains its wire id", () => {
	const model = "dynamo/qwopus3.8-27b-flash@q4_k_m";
	const settings = structuredClone(DEFAULT_SETTINGS);
	const { presentation: built } = presentation(
		{
			terminal: { columns: 60 },
			getSettings: () => ({
				...settings,
				chat: { ...settings.chat, target: "blade", model, thinkingLevel: "low" },
				interface: { ...settings.interface, mode: "regular", outputDetail: "standard" },
			}),
		},
		true,
		true,
	);
	try {
		built.banner.collapseToSessionHeader();
		const rail = stripTerminalSequences(built.editor.render(60)[0] ?? "");
		ok(rail.includes("Qwopus3.8"), rail);
		built.footer.refresh();
		const footer = built.footer.view.render(60).map(stripTerminalSequences).join("\n");
		ok(footer.includes("clio-coder") && !footer.includes("@q4_k_m"), footer);
		const session = headerRows(built, 120)[0] ?? "";
		ok(session.includes(`blade · ${model}`), session);
	} finally {
		built.dispose();
	}
});

test("the welcome keeps a quiet launchpad and the session header names the full model", () => {
	const model = "dynamo/qwopus3.5-flash@q4_k_m";
	const preload =
		"CLIO-CODER.md: first 23,100 of 27,928 characters loaded; lines 129-180 left out (24,000-character preload limit, including supporting instructions). Shorten the project instructions.";
	const component = banner({ model, preload });
	const wide = rows(component, 120);
	ok(wide.join("\n").includes("████"));
	for (const label of [
		"Session started",
		"Project",
		"AI usage",
		"Instructions",
		"lines 129-180 left out",
		"24,000-character",
	])
		ok(wide.join("\n").includes(label));
	ok(actionLine(wide).endsWith(`v${readClioVersion()}${isDevVersion(readClioVersion()) ? "·source" : ""}`));
	component.collapseToSessionHeader();
	strictEqual(rows(component, 120).length, 1);
	ok(rows(component, 120)[0]?.includes(model));
	ok(!rows(component, 120).join("\n").includes("Instructions"));
});

test("the instant shell uses the finished welcome footprint without hydration copy or false readiness", () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "local";
	settings.chat.model = "model";
	settings.targets = [{ id: "local", runtime: "llamacpp" }];
	settings.safety.autonomy = "yolo";
	const boot = createBootWelcome(settings, "Ctrl+S");
	for (const width of WIDTHS) {
		const lines = boot.render(width).map(stripTerminalSequences);
		const baseRows = width >= 57 && width < 76 ? 21 : 17;
		const taglineRows = width < 40 ? 0 : width < 76 ? 2 : 1;
		ok(lines.length >= baseRows && lines.length <= baseRows + taglineRows);
		for (const line of lines) ok(visibleWidth(line) <= width);
		ok(!lines.join("\n").includes("Starting Clio"));
		ok(!lines.join("\n").includes("✓"));
	}
	const wide = boot.render(120).map(stripTerminalSequences).join("\n");
	ok(wide.includes("Session started"));
	ok(wide.includes("Checking project awareness"));
	match(wide, /v\d+\.\d+\.\d+/u);
	ok(!boot.render(120).map(stripTerminalSequences)[0]?.includes("Clio Coder"));
});

test("the welcome box closes at the viewport edge on narrow and wide terminals", () => {
	const component = banner();
	for (const width of [60, 80, 100, 160, 240]) {
		const lines = component.render(width).map(stripAnsi);
		const edge = width - 1;
		strictEqual(lines[0]?.[0], "┌");
		strictEqual(lines[0]?.[edge], "┐");
		strictEqual(lines.at(-1)?.[edge], "┘");
		for (const line of lines.slice(1, -1)) strictEqual(line[edge], "│", line);
		ok(
			!lines
				.slice(1, 6)
				.filter((line) => line.includes("██"))
				.some((line) => line.includes("…")),
			"art must resize rather than truncate",
		);
	}
});

test("account usage hydrates without moving the welcome frame or passing through control codes", () => {
	let quota: string | null = null;
	const component = createWelcomeDashboard({
		getSettings: () => DEFAULT_SETTINGS,
		providers: { list: () => [status()] as never },
		getWorkspaceSnapshot: () => workspace() as never,
		getContextState: () => ({ clioMd: "ok", memoryCount: 0 }) as never,
		getQuotaSummary: () => quota,
		scheduleRefresh: (run) => run(),
	});
	component.render(120);
	let lines = component.render(120).map(stripAnsi);
	strictEqual(lines.length, 18);
	ok(lines.join("\n").includes("No usage data"));
	quota = "Claude 5h 23% used";
	lines = component.render(120).map(stripAnsi);
	strictEqual(lines.length, 18);
	ok(lines.join("\n").includes("Accounts") && lines.join("\n").includes("Claude 5h 23%"));
	quota = `Claude ${ESC}]0;PWNED${BEL}5h 23% used`;
	const raw = component.render(120).join("\n");
	ok(!raw.includes(`${ESC}]`) && !raw.includes(BEL) && !raw.includes("PWNED"), raw);
	component.dispose();
});

test("the wordmark stacks CLIO over CODER with details beside both words and no separate emblem", () => {
	for (const width of [80, 100, 120]) {
		const lines = banner().render(width).map(stripAnsi);
		for (const index of [2, 3, 4, 5, 6, 8, 9, 10, 11, 12]) ok(lines[index]?.includes("██"));
		ok(lines[2]?.includes("Session started"));
		ok(lines[10]?.includes("AI usage"));
		ok(!lines.join("\n").includes(">_C"));
		ok(!lines.slice(1, 12).some((line) => line.includes("…") && line.indexOf("…") < 30));
	}
});

test("the narrow launchpad sets the compact letters on one band, or the brand in the title", () => {
	for (const width of [36, 40, 48, 56, 57, 60, 70, 75]) {
		const lines = rows(banner(), width);
		for (const line of lines) ok(visibleWidth(line) <= width, `${width}: ${line}`);
		if (width < 57) {
			ok(lines[0]?.includes("Clio Coder"), `${width}: ${lines[0]}`);
			ok(lines[0]?.includes(`v${readClioVersion()}`));
			ok(!lines.at(-2)?.includes(`v${readClioVersion()}`));
		} else {
			// CLIO and CODER share each art row, so the band is five rows, not eleven.
			ok(lines[1]?.includes(" ████ ██░   ███  ███     ████  ███  ████  █████ ████"), `${width}: ${lines[1]}`);
			ok(lines[5]?.includes(" ████ █████ ███  ███     ████  ███  ████  █████ ██░██"), `${width}: ${lines[5]}`);
			ok(lines[7]?.includes("Session started"));
			ok(lines.at(-2)?.includes(`v${readClioVersion()}`));
		}
	}
});

for (const width of [60, 80, 106, 160]) {
	test(`development header retains version and route at ${width} columns`, (t) => {
		const [line = ""] = buildWelcomeDashboardLines(
			{
				cwd: "/home/operator/projects/tinyjs",
				workspace: workspace({ cwd: "/home/operator/projects/tinyjs" }) as never,
				targetLabel: "openai-codex",
				modelLabel: "gpt-6-luna",
				route: "ready",
				routeReason: null,
				projectContext: "ok",
				submitKeyLabel: null,
				autonomy: "default",
				targets: "",
				fleet: "",
				quota: null,
			},
			"0.6.0-dev (unreleased · 2ca8896)",
			width,
			"session",
		);
		const text = stripAnsi(line);
		t.diagnostic(text.trimEnd());
		ok(text.includes("v0.6.0-dev·2ca8896"), text);
		ok(text.includes("openai-codex · gpt-6-luna"), text);
		ok(visibleWidth(line) <= width, text);
	});
}

test("source dev version identifies itself without bundle provenance", () => {
	const version = readClioVersion();
	strictEqual(readClioVersionLabel(), isDevVersion(version) ? `${version} (unreleased · source)` : version);
});
