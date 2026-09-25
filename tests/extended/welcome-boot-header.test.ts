import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
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
import {
	createBootWelcome,
	createWelcomeDashboard,
	WELCOME_PROJECT_CONTEXT_RETRY_MS,
	WELCOME_PROJECT_CONTEXT_TTL_MS,
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

// ---------------------------------------------------------------------------
// Displayed text
// ---------------------------------------------------------------------------

test("a healthy route shows the route without a latency number", () => {
	const lines = rows(banner(), 80);
	strictEqual(lines[4]?.slice(34).trim(), "✓ dynamo · qwen3.8-27b");
	ok(!lines.join("\n").includes("42ms"), "probe latency must not reach the header");
	ok(!lines.join("\n").includes("healthy"), "the glyph carries the verdict, not the word");
});

test("a failing route carries its reason, and the action names the repair surface", () => {
	const lines = rows(
		banner({
			statuses: [
				status({ available: false, reason: "connection refused", health: health("down", "ECONNREFUSED 127.0.0.1:1234") }),
			],
		}),
		80,
	);
	ok(lines[4]?.includes("ECONNREFUSED 127.0.0.1:1234"), lines[4]);
	strictEqual(lines[13]?.trim(), "route unavailable · /settings targets");
});

test("the failure reason still fits at 60 columns, shrinking the route rather than vanishing", () => {
	const lines = rows(
		banner({
			statuses: [status({ available: false, reason: "refused", health: health("down", "ECONNREFUSED 127.0.0.1:1234") })],
		}),
		60,
	);
	ok(lines[4]?.includes("ECONNREFUSED 127.0.0.1:1234"), `reason lost at 60 columns: ${lines[4]}`);
});

test("at 40 columns the route shrinks and the reason is cut rather than dropped", () => {
	const lines = rows(
		banner({
			statuses: [status({ available: false, reason: "refused", health: health("down", "ECONNREFUSED 127.0.0.1:1234") })],
		}),
		40,
	);
	ok(lines[4]?.includes("ECONNREFUSED"), `reason dropped at 40 columns: ${lines[4]}`);
	ok(lines[4]?.includes("…"), "a cut must be marked");
});

test("a configured but unprobed target is neither ready nor unavailable", () => {
	const lines = rows(banner({ statuses: [status({ health: health("unknown") })] }), 80).join("\n");
	ok(lines.includes("◌ dynamo · qwen3.8-27b"), lines);
	ok(!lines.includes("✓"), "an unprobed target must not claim readiness");
	ok(!lines.includes("✗"), "an unprobed target must not claim failure");
	ok(!lines.includes("unavailable"), lines);
});

test("a target with no model and no default is unset, not ready", () => {
	const lines = rows(
		banner({
			statuses: [status({ target: { id: "dynamo", defaultModel: null, runtime: "lmstudio", wireModels: [] } })],
			model: undefined,
		}),
		80,
	);
	strictEqual(lines[4]?.slice(34).trim(), "dynamo · no model");
	strictEqual(lines[13]?.trim(), "no model selected · /model");
	ok(!lines.join("\n").includes("✓"), "a route with no model must not read as ready");
});

test("no target and no model names the route, not the context", () => {
	const lines = rows(banner({ statuses: [], target: undefined, model: undefined, clioMd: "none" }), 80);
	strictEqual(lines[4]?.slice(34).trim(), "not configured");
	strictEqual(lines[13]?.trim(), "no route selected · /model");
});

test("a target id absent from the list is a misconfiguration, not an unprobed route", () => {
	const lines = rows(
		banner({ statuses: [status({ target: { id: "other", defaultModel: "m", runtime: "lmstudio", wireModels: [] } })] }),
		80,
	);
	ok(lines[4]?.includes("no such target in settings"), lines[4]);
});

test("a malformed CLIO-CODER.md points at the read-only view, never at a regenerating command", () => {
	const lines = rows(banner({ clioMd: "malformed" }), 80);
	strictEqual(lines[13]?.trim(), "CLIO-CODER.md malformed · /context to inspect");
	const all = lines.join("\n");
	ok(!all.includes("/context init"), "init would overwrite the file the operator must repair");
	ok(!all.includes("/context refresh"), "refresh regenerates; it is not a repair for malformed content");
});

test("missing project context is guidance that keeps the invitation to work", () => {
	const lines = rows(banner({ clioMd: "none" }), 80);
	strictEqual(lines[13]?.trim(), "describe a task · /context init to index this repo");
	ok(lines.join("\n").includes("Ask Clio how to use or extend her."));
});

test("stale project context offers refresh", () => {
	const lines = rows(banner({ clioMd: "stale" }), 80);
	strictEqual(lines[13]?.trim(), "describe a task · /context refresh to update it");
});

test("the submit hint prints only a key that works", () => {
	// The component prints the label it is handed; the presentation owns the
	// KeyId-to-label spelling (see the effective-binding test below).
	strictEqual(rows(banner({ submitKey: "Enter" }), 80)[13]?.trim(), "describe a task · Enter to send · / for commands");
	strictEqual(
		rows(banner({ submitKey: "Ctrl+S" }), 80)[13]?.trim(),
		"describe a task · Ctrl+S to send · / for commands",
	);
	strictEqual(rows(banner({ submitKey: null }), 80)[13]?.trim(), "describe a task · / for commands");
});

test("route faults outrank project-context guidance", () => {
	const lines = rows(
		banner({
			clioMd: "none",
			statuses: [status({ available: false, reason: "down", health: health("down", "boom") })],
		}),
		80,
	);
	strictEqual(lines[13]?.trim(), "route unavailable · /settings targets");
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
	ok(visible.join("\n").includes("upstream 502 bad gateway"), visible.join("\n"));
	ok(visible.join("\n").includes("网关错误"), "wide Unicode in a reason must survive sanitation");
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

test("the launchpad is fifteen rows and the session header one, at every width and state", () => {
	for (const [label, options] of GEOMETRY_CASES) {
		for (const width of WIDTHS) {
			const launchpad = banner(options);
			strictEqual(rows(launchpad, width).length, 15, `${label}@${width} launchpad rows`);
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
	match(wide, /^>C_ Clio Coder v\d+\.\d+\.\d+ · dynamo/u);
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
	const masthead = rows(component, 60)[5] ?? "";
	ok(masthead.includes("project-leaf"), `leaf lost while branch kept: ${masthead}`);
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
	strictEqual(first[13]?.trim(), "describe a task · Enter to send · / for commands");
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
	strictEqual(
		component.render(80).map(stripTerminalSequences)[13]?.trim(),
		"describe a task · /context init to index this repo",
	);
});

test("a reader that throws never becomes ok or none", () => {
	const component = banner({ contextThrows: true });
	const lines = rows(component, 80);
	strictEqual(lines[13]?.trim(), "describe a task · Enter to send · / for commands");
	ok(!lines.join("\n").includes("/context"), "a failed read must not suggest a context command");
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
		return stripTerminalSequences(component.render(80)[13] ?? "").trim();
	};
	strictEqual(action(), "describe a task · /context init to index this repo");

	// Reads start failing. The last good value stands in while retries are paced…
	fail = true;
	clock += WELCOME_PROJECT_CONTEXT_TTL_MS + 1;
	strictEqual(action(), "describe a task · /context init to index this repo");
	clock += WELCOME_PROJECT_CONTEXT_RETRY_MS + 1;
	strictEqual(action(), "describe a task · /context init to index this repo");

	// …but once the failure streak outlives the trust window it stops being asserted.
	clock += WELCOME_PROJECT_CONTEXT_TTL_MS + 1;
	strictEqual(action(), "describe a task · Enter to send · / for commands");

	// A successful read restores a real answer.
	fail = false;
	clock += WELCOME_PROJECT_CONTEXT_RETRY_MS + 1;
	strictEqual(action(), "describe a task · /context init to index this repo");
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
	const action = (): string => {
		component.render(80);
		return stripTerminalSequences(component.render(80)[13] ?? "").trim();
	};
	strictEqual(action(), "describe a task · /context init to index this repo");
	cwd = "/tmp/work/second";
	strictEqual(action(), "describe a task · Enter to send · / for commands");
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
			chat: { target: "dynamo", model: "qwen3.8-27b", thinkingLevel: "off" },
			interface: { mode: "regular", outputDetail: "standard", smoothStreaming: "off" },
		}),
		getContextState: () => ({ clioMd: "ok", memoryCount: 0 }),
		scheduleInterval: () => ({ unref: noop }),
		clearScheduledInterval: noop,
		factories: {
			createChatPanel: () => ({ ...view, reset: noop, appendReplayBlock: noop, workerStates: () => [] }),
			createFollowUpQueuePanel: () => view,
			createStatusController: () => ({ current: () => ({ phase: "idle" }), reset: noop, dispose: noop }),
			createDispatchBoardStore: () => ({ rows: () => [], unsubscribe: noop }),
			createContextActivityStore: () => ({ current: () => ({}), unsubscribe: noop }),
			createNotificationCenter: () => ({ add: noop, list: () => [], dismiss: noop }),
			buildFooter: realFooter
				? (deps: Parameters<typeof buildFooterDashboard>[0]) =>
						buildFooterDashboard({ ...deps, resolveCurrentBranch: async () => null })
				: () => ({ view, refresh: noop, dispose: noop, isExpanded: () => false }),
			createEditor: (_tui: unknown, chrome: EditorChrome) =>
				realEditor
					? new ClioEditor(new TuiMainScreen({ columns: 120, rows: 24, write: noop } as unknown as Terminal), chrome)
					: { ...view, focused: false, setAutocompleteProvider: noop },
			createAutocomplete: () => ({}),
			createDispatchBoardView: () => view,
			createChatRenderer: () => ({ mutate: (run: () => void) => run(), reset: (run: () => void) => run(), flush: noop }),
			createIo: () => ({ stderr: noop, stdout: noop }),
			buildLayout: () => view,
		},
		...over,
	} as unknown as InteractivePresentationDeps;
	const built = createInteractivePresentation(deps);
	return { presentation: built, renders: () => rendered };
}

function headerRows(built: ReturnType<typeof presentation>["presentation"], width = 100): string[] {
	built.banner.render(width);
	return built.banner.render(width).map((line) => stripTerminalSequences(line));
}

test("the presentation opens on the launchpad and collapses on first submit", async () => {
	const { presentation: built } = presentation();
	strictEqual(headerRows(built).length, 15);

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

test("a new session restores the launchpad", () => {
	const { presentation: built } = presentation();
	built.collapseWelcomeDashboard();
	strictEqual(headerRows(built).length, 1);
	built.resetForNewSession();
	strictEqual(headerRows(built).length, 15);
});

test("a boot-time resume opens collapsed, with no fresh-start onboarding", () => {
	const { presentation: built } = presentation({ startsResumed: true } as Partial<InteractivePresentationDeps>);
	const lines = headerRows(built);
	strictEqual(lines.length, 1, "a resumed boot showed the launchpad");
	ok(!lines[0]?.includes("describe a task"), lines[0]);
	ok(lines[0]?.includes("dynamo · qwen3.8-27b"), lines[0]);
});

test("the presentation's submit hint follows the effective binding", () => {
	const rebound = presentation({
		keybindings: {
			getKeys: (id: string) => (id === "tui.input.submit" ? ["ctrl+s"] : []),
			isDisabled: () => false,
			actionLabel: () => "",
		},
	} as unknown as Partial<InteractivePresentationDeps>);
	ok(headerRows(rebound.presentation)[13]?.includes("Ctrl+S to send"), headerRows(rebound.presentation)[13]);

	const unbound = presentation({
		keybindings: { getKeys: () => [], isDisabled: () => true, actionLabel: () => "" },
	} as unknown as Partial<InteractivePresentationDeps>);
	ok(!headerRows(unbound.presentation)[13]?.includes("to send"), headerRows(unbound.presentation)[13]);
});

test("disposing the presentation disposes the header", () => {
	const { presentation: built } = presentation();
	built.dispose();
	// A disposed banner schedules nothing further; rendering must still be safe.
	strictEqual(headerRows(built).length, 15);
});

for (const width of [40, 44, 60, 92, 120]) {
	test(`production presentation footer preserves model identity at ${width} columns`, () => {
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
			const identities: string[] = [];
			for (const placement of ["very-long-placement", "dynamo-long-placement"]) {
				for (const family of ["qwopus3.8", "llamus3.8", "qwen3", "llama3"]) {
					model = `${placement}/${family}-27b-q6`;
					deepStrictEqual(built.editorChrome.getModelLabel(), { targetId: "blade-gateway", modelId: model });
					const composer = built.editor.render(width);
					for (const row of composer) ok(visibleWidth(row) <= width);
					const rail = stripTerminalSequences(composer[0] ?? "");
					for (const label of [family, placement, "blade-gateway", "q6"]) ok(!rail.includes(label), rail);
					const footer = footerRows(width).map(stripTerminalSequences).join("\n");
					ok(footer.includes("q6"), footer);
					// Compact footer uses middle truncation: narrow budgets can omit
					// the family along with placement, but must retain the suffix.
					if (width < 92) ok(footer.includes("…"), footer);
					else ok(footer.includes(model), footer);
					const wide = footerRows(120).map(stripTerminalSequences).join("\n");
					ok(wide.includes(`blade-gateway · ${model}`), wide);
					identities.push(wide);
				}
			}
			strictEqual(new Set(identities).size, 8, "all families and placements stay distinct with room to show them");
			// The callback carries raw fields; rendering sanitizes before truncation.
			model = `very-long-placement/\x1b]0;FAKE_MODEL_NAME\x07qwopus3.8-27b-q6`;
			deepStrictEqual(built.editorChrome.getModelLabel(), { targetId: "blade-gateway", modelId: model });
			for (const columns of [width, 120]) {
				const raw = footerRows(columns).join("\n");
				ok(!raw.includes("FAKE_MODEL_NAME"), raw);
				ok(!raw.includes("\x1b]"), raw);
				const clean = stripTerminalSequences(raw);
				ok(clean.includes("q6"), clean);
				if (columns >= 92) ok(clean.includes("very-long-placement/qwopus3.8-27b-q6"), clean);
			}
		} finally {
			built.dispose();
		}
	});
}

test("compact footer keeps the quantization token whole when placement does not fit", () => {
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
		built.footer.refresh();
		const footer = built.footer.view.render(60).map(stripTerminalSequences).join("\n");
		ok(footer.includes("@q4_k_m"), footer);
		const primary = footer.split("\n")[0] ?? "";
		if (primary.includes("…")) match(primary, /…[/.@_-]/u, primary);
	} finally {
		built.dispose();
	}
});

test("the welcome keeps a full model name when space permits and shows the logo, tagline, and permissions", () => {
	const model = "dynamo/qwopus3.5-flash@q4_k_m";
	const component = banner({ model });
	const wide = rows(component, 120);
	const tagline = "Systems engineering beats vibes! Built by researchers who love to code.";
	ok(wide.join("\n").includes(model));
	ok(wide[1]?.includes(tagline));
	ok(!wide[0]?.includes(tagline));
	ok(rows(component, 200)[1]?.includes(tagline));
	ok(wide.join("\n").includes("Permissions  default"));
	ok(wide[1]?.includes("████"));
	component.collapseToSessionHeader();
	strictEqual(rows(component, 120).length, 1);
	ok(rows(component, 120)[0]?.includes(model));
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
		strictEqual(lines.length, 15);
		for (const line of lines) ok(visibleWidth(line) <= width);
		ok(!lines.join("\n").includes("Starting Clio"));
		ok(!lines.join("\n").includes("✓"));
	}
	const wide = boot.render(120).map(stripTerminalSequences).join("\n");
	ok(wide.includes("Permissions  yolo"));
	ok(wide.includes("Ctrl+S to send"));
	ok(wide.includes("Clio Coder v"));
});

test("the welcome box closes at the viewport edge on narrow and wide terminals", () => {
	const component = banner();
	for (const width of [60, 80, 100, 160, 240]) {
		const lines = component.render(width).map(stripAnsi);
		const edge = width - 1;
		strictEqual(lines[0]?.[0], "┌");
		strictEqual(lines[0]?.[edge], "┐");
		strictEqual(lines[14]?.[edge], "┘");
		for (const line of lines.slice(1, 12)) strictEqual(line[edge], "│", line);
		for (const line of lines.slice(13, 14)) strictEqual(line[edge], "│", line);
		ok(
			!lines
				.slice(1, 6)
				.filter((line) => line.includes("██"))
				.some((line) => line.includes("…")),
			"art must resize rather than truncate",
		);
	}
});

test("fleet and targets show cached facts, bound names, sanitize text, and refresh counts", () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "dynamo";
	settings.chat.model = "qwen3.8-27b";
	settings.targets = [
		{ id: "dynamo", runtime: "lmstudio" },
		{ id: "cloud", runtime: "openai" },
	];
	settings.fleet.rosters = Object.fromEntries(
		["review", "research", "verify", "more"].map((name) => [name, { members: [] }]),
	);
	let agents = 12;
	let verdict = "unknown";
	const component = createWelcomeDashboard({
		getSettings: () => settings,
		getAgentCount: () => agents,
		providers: {
			list: () =>
				[status({ health: health(verdict) }), status({ target: settings.targets[1], health: health("unknown") })] as never,
		},
	});
	let lines = component.render(120).map(stripAnsi).join("\n");
	ok(lines.includes("2 configured"));
	ok(!lines.includes("ready"), "unprobed targets must not claim readiness");
	ok(lines.includes("12 agent recipes · Rosters: review, research, verify +1"));
	agents = 14;
	verdict = "healthy";
	lines = component.render(120).map(stripAnsi).join("\n");
	ok(lines.includes("14 agent recipes"));
	ok(lines.includes("1 ready"));
	settings.fleet.rosters = { [`review${ESC}[2J${BEL}team`]: { members: [] } };
	lines = component.render(120).map(stripAnsi).join("\n");
	ok(!lines.includes(ESC) && !lines.includes(BEL));
	component.dispose();
});

test("the wordmark stacks CLIO over CODER with details beside both words and no separate emblem", () => {
	for (const width of [80, 100, 120]) {
		const lines = banner().render(width).map(stripAnsi);
		for (const index of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11]) ok(lines[index]?.includes("██"));
		ok(lines[4]?.includes("dynamo"));
		ok(lines[9]?.includes("configured"));
		ok(!lines.join("\n").includes(">_C"));
		ok(!lines.slice(1, 12).some((line) => line.includes("…") && line.indexOf("…") < 30));
	}
});
