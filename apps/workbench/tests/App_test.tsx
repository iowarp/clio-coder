import { equal, match, ok } from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
	ClioCatalog,
	DispatchLedger,
	EffectiveClioMap,
	RoutingInventory,
	UsageNotebook,
	type WorkbenchActions,
	WorkbenchView,
} from "../src/App.tsx";
import { appReducer, type AppState, initialAppState, parseBootstrapPayload } from "../src/state.ts";
import {
	bootstrapFixture,
	catalogInspectionFixture,
	clioSnapshotFixture,
	configInspectionFixture,
	dispatchInspectionFixture,
	FIXTURE_PROJECT_ID,
	routingInspectionFixture,
	serverEventFixture,
	sessionSummaryFixture,
	usageInspectionFixture,
	workspaceFixture,
} from "./fixtures.ts";
import type { WireProjectWorkspace } from "../src/protocol.ts";

const inertActions: WorkbenchActions = {
	browseProjects() {},
	openProject() {},
	selectProject() {},
	forgetProject() {},
	refreshTree() {},
	createNode() {},
	moveNode() {},
	prepareDelete() {},
	confirmDelete() {},
	newSession() {},
	loadSession() {},
	closeSession() {},
	listSessions() {},
	labelSession() {},
	deleteSession() {},
	startTurn() {},
	cancelTurn() {},
	resolvePermission() {},
	getSettings() {},
	patchSettings() {},
	inspectConfig() {},
	inspectCatalog() {},
	inspectUsage() {},
	inspectRouting() {},
	inspectDispatch() {},
	listTargets() {},
	probeTarget() {},
	setAutonomy() {},
};

function render(state: AppState): string {
	return renderToStaticMarkup(<WorkbenchView state={state} dispatch={() => undefined} actions={inertActions} />);
}

function stateWith(workspace: WireProjectWorkspace | null): AppState {
	const bootstrap = bootstrapFixture(
		workspace === null ? { openProjectId: null, workspace: null } : { workspace },
	);
	return appReducer(initialAppState, {
		type: "bootstrap.loaded",
		payload: parseBootstrapPayload(structuredClone(bootstrap) as unknown),
	});
}

Deno.test("the shell renders three truthful regions with accessible landmarks and no engine concept", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		tree: [{
			name: "analysis",
			path: { segments: ["analysis"] },
			kind: "directory",
			operable: true,
			children: [{
				name: "convergence.md",
				path: { segments: ["analysis", "convergence.md"] },
				kind: "file",
				operable: true,
			}],
		}],
	});
	const html = render(stateWith(workspace));

	match(html, /<main class="conversation" id="conversation">/u);
	match(html, /aria-label="Projects, files, and sessions"/u);
	match(html, /aria-label="Run and evidence overview"/u);
	match(html, /aria-label="Request, work, approval, and outcome timeline"/u);
	match(html, /aria-label="Clio Coder status"/u);
	match(html, /class="brand-lockup__name">Clio Coder</u);
	match(html, /aria-live="assertive"/u);
	match(html, /aria-live="polite"/u);
	match(html, /class="file-tree"/u);
	match(html, /class="file-node file-node--file"/u);
	match(html, /aria-label="Prompt for Clio Coder"/u);
	match(html, /Prompts go only to the Clio Coder target you configured/u);
	match(html, /Collapse projects, files, and sessions/u);
	match(html, /Collapse run and evidence overview/u);
	equal((html.match(/<main/gu) ?? []).length, 1);
	equal((html.match(/<aside/gu) ?? []).length, 2);
	ok(!html.includes("undefined"));
	ok(!html.includes(">Workbench<"), "Workbench must not appear as a product label");
	ok(!/engine/iu.test(html), "no product surface may mention an engine");
	ok(!html.includes("activity-rail"));
	ok(!html.includes("No prompt leaves this machine"));
});

Deno.test("the Effective Clio Coder map renders provenance, apply timing, redaction, and bounded issues without raw JSON", () => {
	const html = renderToStaticMarkup(
		<EffectiveClioMap
			inspection={configInspectionFixture()}
			pending={false}
			onRefresh={() => undefined}
			onBack={() => undefined}
		/>,
	);

	match(html, /Why Clio Coder behaves this way/u);
	match(html, /From source to behavior/u);
	match(html, /Project context/u);
	match(html, /Next turn/u);
	match(html, /Restart/u);
	match(html, /Estimated context cost/u);
	match(html, /orchestrator\.model/u);
	match(html, /qwen3\.8-27b/u);
	match(html, /Clio Coder could not fully inspect every surface/u);
	match(html, /Project sources use project-relative paths/u);
	ok(!html.includes("sourcePath"));
	ok(!html.includes("issueCounts"));
	ok(!html.includes("/home/"));
});

Deno.test("the capability atlas renders bounded inventory facts and names the verifier interface gap", () => {
	const html = renderToStaticMarkup(
		<ClioCatalog
			inspection={catalogInspectionFixture()}
			pending={false}
			onRefresh={() => undefined}
			onBack={() => undefined}
		/>,
	);

	match(html, /Agents, skills, extensions &amp; resource library/u);
	match(html, /Researcher/u);
	match(html, /research-report/u);
	match(html, /Tool-call budget/u);
	match(html, /24–64/u);
	match(html, /Installed skills/u);
	match(html, /1 reported loader issue/u);
	match(html, /Library resources/u);
	match(html, /Extensions/u);
	match(html, /mutate an extension package/u);
	match(html, /Typed interface required/u);
	match(html, /Bodies, hashes, native paths, source URLs, requirements, and raw diagnostics stay host-side/u);
	ok(!html.includes("sourcePath"));
	ok(!html.includes("sourceUrl"));
	ok(!html.includes("rootPath"));
	ok(!html.includes("manifestPath"));
	ok(!/https?:\/\//u.test(html));
	ok(!html.includes("/home/"));
});

Deno.test("the Usage record renders exact project aggregates and its honest upstream boundaries", () => {
	const html = renderToStaticMarkup(
		<UsageNotebook
			inspection={usageInspectionFixture()}
			pending={false}
			onRefresh={() => undefined}
			onBack={() => undefined}
		/>,
	);

	match(html, /Thirty days of work in this project/u);
	match(html, /13,922,000/u);
	match(html, /\$4\.125/u);
	match(html, /qwen3\.8-27b/u);
	match(html, /frontend-design/u);
	match(html, /researcher/u);
	match(html, /Typed outcomes, not command shapes/u);
	match(html, /Evidence/u);
	match(html, /Evaluations/u);
	match(html, /Traces/u);
	match(html, /Fleet/u);
	match(html, /suggestions are reduced to counts/u);
	ok(!html.includes("rawSuggestions"));
	ok(!html.includes("session-alpha"));
	ok(!html.includes("/home/"));
});

Deno.test("the Dispatch snapshot is installation-wide and omits raw fleet identities and controls", () => {
	const html = renderToStaticMarkup(
		<DispatchLedger
			inspection={dispatchInspectionFixture()}
			pending={false}
			onRefresh={() => undefined}
			onBack={() => undefined}
		/>,
	);
	match(html, /Dispatch across this Clio Coder installation/u);
	match(html, /Installation-wide dispatch summary/u);
	match(html, /15,918,587/u);
	match(html, /Alive/u);
	match(html, /cross-process status command cannot observe/u);
	for (const forbidden of ["runId", "agentId", '"node":', "requestedByPid", "Drain fleet", "Resume fleet"]) {
		ok(!html.includes(forbidden), `dispatch surface leaked or offered ${forbidden}`);
	}
});

Deno.test("the routing inventory renders offline model limits and explicit agent-profile resolution", () => {
	const html = renderToStaticMarkup(
		<RoutingInventory
			projectId={FIXTURE_PROJECT_ID}
			inspection={routingInspectionFixture()}
			pending={false}
			onRefresh={() => undefined}
		/>,
	);

	match(html, /What Clio Coder can route work to/u);
	match(html, /qwen3\.8-27b/u);
	match(html, /262,144/u);
	match(html, /32,768/u);
	match(html, /Reasoning/u);
	match(html, /deep-research/u);
	match(html, /researcher/u);
	match(html, /Missing profile/u);
	match(html, /no endpoint probe/u);
	match(html, /Provider URLs, credentials, environment, native paths, and raw warnings remain on the host/u);
	ok(!html.includes("baseUrl"));
	ok(!html.includes("credentialPath"));
	ok(!html.includes("/home/"));
});

Deno.test("the observatory summarizes recorded facts without inventing telemetry", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		timeline: [
			{
				id: "turn-1:request",
				kind: "request",
				title: "Check the field notes",
				summary: "Review the notes and run the existing checks.",
				status: "complete",
				turnId: "turn-1",
				origin: "live",
				startedAt: "2026-08-18T12:00:00.000Z",
				sequence: 1,
				source: "observed-by-workbench",
			},
			{
				id: "turn-1:tool:check",
				kind: "tool",
				title: "Run project checks",
				summary: "Clio Coder ran the configured checks.",
				status: "failed",
				turnId: "turn-1",
				origin: "live",
				startedAt: "2026-08-18T12:00:01.000Z",
				endedAt: "2026-08-18T12:00:02.000Z",
				sequence: 2,
				source: "observed-on-acp",
			},
		],
	});
	const html = render(stateWith(workspace));

	match(html, /Timeline at a glance/u);
	match(html, /Check the field notes — Observed by desktop — complete/u);
	match(html, /Run project checks — Observed on ACP — failed/u);
	match(html, /Observed locally/u);
	match(html, /Observed live/u);
	match(html, /This panel summarizes the record\. It never infers completion from silence or invents measurements\./u);
	ok(!/memory|cpu|dependency map/iu.test(html), "the overview must not fabricate system telemetry");
});

Deno.test("reported terminal usage becomes a legible per-turn record and a visible-record comparison", () => {
	const usage = { input: 1_024, output: 233, cacheRead: 800, cacheWrite: 17, reasoning: 91 };
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		timeline: [{
			id: "turn-1:terminal",
			kind: "outcome",
			title: "Turn complete",
			summary: "Clio Coder finished this turn.",
			detail: "end_turn",
			status: "complete",
			turnId: "turn-1",
			origin: "live",
			startedAt: "2026-08-18T12:00:00.000Z",
			endedAt: "2026-08-18T12:00:01.000Z",
			sequence: 1,
			usage,
			source: "reported-by-clio",
		}],
	});
	const html = render(stateWith(workspace));

	match(html, /Reported token record/u);
	match(html, /Token fields reported by Clio Coder for this turn/u);
	match(html, /aria-label="1 turn report"/u);
	match(html, /aria-label="Run and evidence details"/u);
	match(html, /Prompt \+ context/u);
	match(html, /Answer produced/u);
	match(html, /Context reused/u);
	match(html, /Context cached/u);
	match(html, /Model reasoning/u);
	match(html, /<ul class="token-ledger" aria-label="Token fields across visible terminal records">/u);
	match(html, /<dl class="token-ledger__fact">/u);
	match(html, /<code>cacheRead<\/code>/u);
	match(html, /1,024/u);
	match(html, /800/u);
	match(html, /the GUI does not infer a price/u);
	ok(!html.includes("$"), "per-turn token reporting must not fabricate a cost");
});

Deno.test("with no project open the rail offers a path field and the canvas explains the boundary", () => {
	const html = render(stateWith(null));
	match(html, /Project folder/u);
	match(html, /name="projectPath"/u);
	match(html, />Browse folders</u);
	match(html, /Bring a research folder\. Keep every decision visible\./u);
	match(html, /Choose a project folder/u);
	match(html, /The desktop app enforces the project boundary in its own code/u);
	match(html, /No project open/u);
	match(html, />START</u);
	ok(!html.includes("Clio Coder is finishing the previous prompt."));
	ok(!html.includes("sandbox"));
});

Deno.test("a pending approval is announced, titled, and never leaks wire identifiers", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		clio: clioSnapshotFixture("awaiting-approval"),
		activeTurn: {
			turnId: "turn-1",
			startedAt: "2026-08-18T12:03:00.000Z",
			toolCalls: 1,
			lastToolTitle: "Write notes.md",
			repeatedShapes: 0,
		},
		pendingPermission: {
			permissionId: "permission-internal-0001",
			toolCallId: "tool-internal-0001",
			title: "Update project file",
			kind: "edit",
			locations: [{ segments: ["src", "solver.ts"] }],
			requestedAt: "2026-08-18T12:04:00.000Z",
			escalateAt: "2026-08-18T12:04:45.000Z",
			expiresAt: "2026-08-18T12:14:00.000Z",
			source: "observed-on-acp",
		},
	});
	const html = render(stateWith(workspace));

	match(html, /APPROVAL NEEDED · ONE USE/u);
	match(html, /Update project file/u);
	match(html, /src\/solver\.ts/u);
	match(html, /Nothing runs until you answer/u);
	match(html, />Reject</u);
	match(html, />Allow once</u);
	ok(!html.includes("permission-internal-0001"));
	ok(!html.includes("tool-internal-0001"));
});

Deno.test("a running turn shows elapsed work and offers stop instead of send", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		clio: clioSnapshotFixture("running"),
		activeTurn: {
			turnId: "turn-1",
			startedAt: new Date().toISOString(),
			toolCalls: 17,
			lastToolTitle: "bash: git status",
			repeatedShapes: 3,
		},
	});
	const html = render(stateWith(workspace));
	match(html, /17 tool calls/u);
	match(html, /bash: git status/u);
	match(html, /3 repeated/u);
	match(html, />Stop</u);
	match(html, />RUNNING</u);
	ok(!html.includes(">Send<"));
});

Deno.test("an unknown session is explained honestly and cannot be resumed or deleted", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		sessions: [{
			id: "session-unknown-0002",
			label: null,
			preview: "An earlier run",
			createdAt: "2026-08-18T11:00:00.000Z",
			updatedAt: "2026-08-18T11:30:00.000Z",
			turns: 4,
			target: null,
			model: null,
			state: "unknown",
			hosted: false,
		}],
		clio: clioSnapshotFixture("idle", { session: null }),
	});
	const html = render(stateWith(workspace));
	match(html, /Clio Coder cannot tell whether another process still holds this session\./u);
	ok((html.match(/disabled=""/gu) ?? []).length >= 2);
});

Deno.test("a Clio Coder failure is visible in the conversation region without opening anything", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		clio: clioSnapshotFixture("failed", {
			session: null,
			lastFailure: { code: "acp-process-exited", summary: "Clio Coder exited before the session was bound." },
		}),
	});
	const html = render(stateWith(workspace));
	match(html, /CLIO CODER REPORTED A FAILURE/u);
	match(html, /Clio Coder exited before the session was bound\./u);
	match(html, /acp-process-exited/u);
});

Deno.test("truncated replay says so without claiming Clio Coder lost the context", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		timeline: [{
			id: "turn-1:request",
			kind: "request",
			title: "Earlier request",
			summary: "An earlier prompt",
			status: "replayed",
			turnId: "turn-1",
			origin: "replay",
			startedAt: null,
			sequence: 1,
			source: "replayed-from-clio",
		}],
		timelineTruncated: true,
	});
	const html = render(stateWith(workspace));
	match(html, /earlier turns are not shown; Clio Coder still has the full context/iu);
	match(html, /timeline-card--replay/u);
	match(html, /is-replayed/u);
	match(html, />earlier</u);
	match(html, /Replayed from Clio Coder/u);
	match(html, />replayed</u);
	ok(!html.includes("<time"), "replay history must render without an invented time");
});

Deno.test("the status bar names the bound session, its autonomy, and where autonomy came from", () => {
	const html = render(stateWith(workspaceFixture()));
	match(html, /Session bound to/u);
	match(html, /lmstudio · qwen3\.8-27b/u);
	match(html, /inherited from settings/u);
	match(html, /aria-label="Session autonomy"/u);
	match(html, />idle</u);
});

Deno.test("a command notice is rendered as an alert the operator can dismiss", () => {
	const state = appReducer(stateWith(workspaceFixture()), {
		type: "host.event",
		event: serverEventFixture("command.error", {
			code: "conflict",
			message: "Clio Coder is still working on the previous prompt. Cancel it or wait.",
		}, { sequence: 2 }),
	});
	const html = render(state);
	match(html, /role="alert"/u);
	match(html, /Clio Coder is still working on the previous prompt\. Cancel it or wait\./u);
	match(html, /Dismiss notification/u);
});

Deno.test("loading and failed boot states remain meaningful without animation or color", () => {
	const loading = render(initialAppState);
	match(loading, /aria-busy="true"/u);
	match(loading, /Starting the localhost instrument/u);

	const failed = render(
		appReducer(initialAppState, { type: "bootstrap.failed", message: "Bounded bootstrap diagnostic" }),
	);
	match(failed, /role="alert"/u);
	match(failed, /Bounded bootstrap diagnostic/u);
	match(failed, /Retry bootstrap/u);
});

Deno.test("the session rail renders state, attribution, and the actions each session allows", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		sessions: [
			sessionSummaryFixture("session-alpha-0001", { label: "Live audit", hosted: true, state: "open", turns: 3 }),
			sessionSummaryFixture("session-earlier-0002", {
				label: null,
				preview: "Audit the convergence study",
				state: "closed",
				hosted: false,
				turns: 2,
			}),
		],
		sessionsTruncated: true,
	});
	const html = render(stateWith(workspace));
	match(html, /Live audit/u);
	match(html, /Audit the convergence study/u);
	match(html, /open · 3 turns/u);
	match(html, /closed · 2 turns/u);
	match(html, /lmstudio/u);
	match(html, />bound</u);
	match(html, />Resume</u);
	match(html, />Rename</u);
	match(html, />Delete</u);
	match(html, /This list is shortened; Clio Coder has more sessions than are shown\./u);
	ok(!html.includes("fixture-session"));
});

Deno.test("a resumed session with truncated replay says so without claiming lost context", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		clio: clioSnapshotFixture("idle", {
			session: {
				id: "session-alpha-0001",
				target: "lmstudio",
				model: "qwen3.8-27b",
				autonomy: "auto-edit",
				autonomySource: "settings",
				resumed: true,
				replayedTurns: 64,
				replayTruncated: true,
				createdAt: "2026-08-18T11:00:00.000Z",
			},
		}),
		timeline: [{
			id: "turn-1:request",
			kind: "request",
			title: "Earlier request",
			summary: "An earlier prompt",
			status: "replayed",
			turnId: "turn-1",
			origin: "replay",
			startedAt: null,
			sequence: 1,
			source: "replayed-from-clio",
		}],
		timelineTruncated: false,
	});
	const html = render(stateWith(workspace));
	match(html, /Earlier turns are not shown; Clio Coder still has the full context\./u);
	match(html, /timeline-card--replay/u);
	match(html, /Replayed from Clio Coder/u);
	ok(!html.includes("<time"), "resumed replay history must render without an invented time");
});

Deno.test("an unknown session can be neither resumed nor deleted, and says why", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		sessions: [sessionSummaryFixture("session-unknown-0003", { state: "unknown", hosted: false, label: null })],
		clio: clioSnapshotFixture("idle", { session: null }),
	});
	const html = render(stateWith(workspace));
	match(html, /Clio Coder cannot tell whether another process still holds this session\./u);
	const resumeDisabled = /<button[^>]*disabled=""[^>]*>Resume<\/button>/u.test(html);
	const deleteDisabled = /<button[^>]*disabled=""[^>]*>Delete<\/button>/u.test(html);
	ok(resumeDisabled, "resume must be disabled for an unknown session");
	ok(deleteDisabled, "delete must be disabled for an unknown session");
});

Deno.test("a Clio Coder that cannot list, label, or delete sessions hides those controls honestly", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		sessions: [sessionSummaryFixture("session-alpha-0001", { hosted: true, state: "open" })],
		clio: clioSnapshotFixture("idle", {
			capabilities: {
				load: false,
				list: false,
				label: false,
				delete: false,
				autonomy: false,
				settings: false,
				targets: false,
				loopBlocked: false,
			},
		}),
	});
	const html = render(stateWith(workspace));
	match(html, /This Clio Coder cannot list its earlier sessions over ACP\./u);
	// The file toolbar has its own Rename; only the session row's must disappear.
	const sessionActions = html.slice(html.indexOf("session-row__actions"), html.indexOf("</article>"));
	ok(!sessionActions.includes(">Rename<"), "the rename control must be absent without the label capability");
	match(html, /aria-label="Session autonomy"[^>]*disabled=""/u);
});

Deno.test("a remembered folder that can no longer be opened explains itself and offers removal", () => {
	const bootstrap = bootstrapFixture({
		openProjectId: null,
		workspace: null,
		recent: [
			{
				id: "project-gone-0002",
				displayName: "Beta",
				rootPath: "/tmp/workbench-fixture/beta",
				lastOpenedAt: "2026-08-18T11:00:00.000Z",
				available: false,
			},
			{
				id: FIXTURE_PROJECT_ID,
				displayName: "Alpha",
				rootPath: "/tmp/workbench-fixture/alpha",
				lastOpenedAt: "2026-08-18T12:00:00.000Z",
				available: true,
			},
		],
	});
	const html = render(appReducer(initialAppState, {
		type: "bootstrap.loaded",
		payload: parseBootstrapPayload(structuredClone(bootstrap) as unknown),
	}));

	match(html, /project-card-row is-missing/u);
	match(html, /cannot be opened/u);
	match(
		html,
		/The GUI can no longer open this folder\. It may have been moved, renamed, or deleted, or it may now be a location the GUI refuses to open\. Removing it from this list changes nothing on disk\./u,
	);
	match(html, />Remove Beta from this list<\/button>/u);
	// The unopenable row must not also carry the compact forget glyph, and the
	// healthy row must not carry the recovery block.
	ok(!html.includes("Forget Beta"));
	match(html, /Forget Alpha/u);
	equal((html.match(/project-recovery"/gu) ?? []).length, 1);
	const missingRow = html.slice(html.indexOf("project-card-row is-missing"), html.indexOf("Forget Alpha"));
	match(missingRow, /<button[^>]*class="project-card"[^>]*disabled=""/u);
});

Deno.test("the settings page claims a target's health only after that target was probed", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		settings: {
			settings: {
				"orchestrator.target": "lmstudio",
				"orchestrator.model": "qwen3.8-27b",
				"orchestrator.thinkingLevel": "off",
				autonomy: "auto-edit",
			},
			editable: ["orchestrator.target", "orchestrator.model", "orchestrator.thinkingLevel", "autonomy"],
			options: {
				"orchestrator.target": ["lmstudio", "offline-lab"],
				"orchestrator.model": ["qwen3.8-27b", "qwen3.8-4b"],
				"orchestrator.thinkingLevel": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
				autonomy: ["read-only", "suggest", "auto-edit", "full-auto"],
			},
			checkedAt: "2026-08-18T12:00:00.000Z",
		},
		targets: [
			{
				id: "lmstudio",
				runtime: "openai-compatible",
				models: ["qwen3.8-27b", "qwen3.8-4b"],
				isOrchestrator: true,
				health: { healthy: true, latencyMs: 12, reason: null, probedAt: "2026-08-18T12:06:00.000Z" },
			},
			{
				id: "offline-lab",
				runtime: "openai-compatible",
				models: ["stub-tiny"],
				isOrchestrator: false,
				health: null,
			},
		],
		targetsTruncated: true,
	});
	const html = render(appReducer(stateWith(workspace), { type: "settings.opened", open: true }));

	match(html, /<h3[^>]*>Configured targets<\/h3>/u);
	match(html, />Probe lmstudio</u);
	match(html, />Probe offline-lab</u);
	match(html, /healthy/u);
	match(html, /12 ms/u);
	match(html, /not probed/u);
	match(html, /A target&#x27;s health is shown only after you probe it\./u);
	match(html, /This list is shortened; Clio Coder has more targets or models than are shown\./u);
	match(html, /orchestrator\.thinkingLevel/u);
	match(html, /Clio Coder target/u);
	match(html, /Reasoning effort/u);
	match(html, /Default working freedom/u);
	match(html, /NEXT TURN/u);
	match(html, /NEXT SESSION/u);
	// The unprobed target must not borrow the probed one's verdict.
	const offlineRow = html.slice(html.indexOf("<strong>offline-lab</strong>"));
	ok(!offlineRow.includes("unhealthy"));
	ok(!offlineRow.includes("12 ms"));
});

Deno.test("a Clio Coder without the targets capability says so instead of showing an empty list", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		clio: clioSnapshotFixture("idle", {
			capabilities: {
				load: true,
				list: true,
				label: true,
				delete: true,
				autonomy: true,
				settings: false,
				targets: false,
				loopBlocked: false,
			},
		}),
	});
	const html = render(appReducer(stateWith(workspace), { type: "settings.opened", open: true }));
	match(html, /This Clio Coder does not expose settings over ACP\./u);
	match(html, /This Clio Coder does not expose targets over ACP\./u);
	ok(!html.includes("Probe "));
});

Deno.test("the status bar names the next turn's routing only when it differs from the bound session", () => {
	const base = {
		editable: ["orchestrator.target", "orchestrator.model"],
		options: {},
		checkedAt: "2026-08-18T12:00:00.000Z",
	};
	const same = render(stateWith(workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		settings: {
			...base,
			settings: { "orchestrator.target": "lmstudio", "orchestrator.model": "qwen3.8-27b" },
		},
	})));
	ok(!same.includes("Next turn"), "an unchanged routing must not add a second reading of the same fact");

	const changed = render(stateWith(workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		settings: {
			...base,
			settings: { "orchestrator.target": "offline-lab", "orchestrator.model": "stub-tiny" },
		},
	})));
	match(changed, /Next turn/u);
	match(changed, /offline-lab · stub-tiny/u);
	match(changed, /Session bound to/u);
	match(changed, /lmstudio · qwen3\.8-27b/u);
	// Routing reaches the bound session at prompt time, so it is a turn fact and
	// must never borrow the session-scoped label.
	ok(!changed.includes("Next session"), "a routing difference is not a next-session fact");
});

Deno.test("a patched target or model is labelled next turn while a patched autonomy is labelled next session", () => {
	const base = {
		editable: ["orchestrator.target", "orchestrator.model", "orchestrator.thinkingLevel", "autonomy"],
		options: {},
		checkedAt: "2026-08-18T12:00:00.000Z",
	};
	// The bound session in the fixture runs lmstudio · qwen3.8-27b at auto-edit.
	const routingOnly = render(stateWith(workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		settings: {
			...base,
			settings: {
				"orchestrator.target": "offline-lab",
				"orchestrator.model": "stub-tiny",
				"orchestrator.thinkingLevel": "high",
				autonomy: "auto-edit",
			},
		},
	})));
	match(routingOnly, /Next turn/u);
	match(routingOnly, /offline-lab · stub-tiny/u);
	ok(!routingOnly.includes("Next session"), "an autonomy that already matches the session must add no row");

	// Clio Coder pins autonomy at session/new for the life of the bound session, so a
	// global autonomy patch reaches only the session bound after this one.
	const autonomyOnly = render(stateWith(workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		settings: {
			...base,
			settings: {
				"orchestrator.target": "lmstudio",
				"orchestrator.model": "qwen3.8-27b",
				"orchestrator.thinkingLevel": "off",
				autonomy: "read-only",
			},
		},
	})));
	match(autonomyOnly, /Next session/u);
	match(autonomyOnly, /read only autonomy/u);
	ok(!autonomyOnly.includes("Next turn"), "a pinned autonomy must never be announced as this session's next turn");
	// The bound session keeps reporting the level Clio Coder is actually enforcing.
	match(autonomyOnly, /inherited from settings/u);
});

Deno.test("a pending approval is repeated in a banner outside the scrolling conversation", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		clio: clioSnapshotFixture("awaiting-approval"),
		activeTurn: {
			turnId: "turn-1",
			startedAt: "2026-08-18T12:03:00.000Z",
			toolCalls: 3,
			lastToolTitle: "bash: git status",
			repeatedShapes: 0,
		},
		pendingPermission: {
			permissionId: "permission-internal-0001",
			toolCallId: "tool-internal-0001",
			title: "Run a project command",
			kind: "execute",
			locations: [],
			requestedAt: "2026-08-18T12:04:00.000Z",
			escalateAt: "2036-08-18T12:04:45.000Z",
			expiresAt: "2036-08-18T12:14:00.000Z",
			source: "observed-on-acp",
		},
	});
	const html = render(stateWith(workspace));

	// The banner must sit between the header and the scroll region, so an operator
	// scrolled away from the anchor point still has it on screen.
	const bannerIndex = html.indexOf("approval-banner");
	const scrollIndex = html.indexOf("conversation__scroll");
	ok(bannerIndex > 0, "the banner must render while an approval is pending");
	ok(bannerIndex < scrollIndex, "the banner must not live inside the scrolling region");
	match(html, /id="approval-banner-title"/u);
	match(html, /Alt\+A allows once · Alt\+R rejects/u);
	// Prominent without being a dialog: a focus trap would block the operator.
	ok(!html.includes('role="alertdialog"'));
	// The inline card at the anchor point stays as well.
	match(html, /id="permission-title"/u);
	ok(!html.includes("permission-internal-0001"));
});

Deno.test("an approval past its escalation point is marked escalated and announced", () => {
	const base = {
		clio: clioSnapshotFixture("awaiting-approval"),
		activeTurn: {
			turnId: "turn-1",
			startedAt: "2026-08-18T12:03:00.000Z",
			toolCalls: 3,
			lastToolTitle: "bash: git status",
			repeatedShapes: 0,
		},
	};
	const pending = (escalateAt: string) => ({
		permissionId: "permission-internal-0002",
		toolCallId: "tool-internal-0002",
		title: "Run a project command",
		kind: "execute",
		locations: [],
		requestedAt: "2026-08-18T12:04:00.000Z",
		escalateAt,
		expiresAt: "2036-08-18T12:14:00.000Z",
		source: "observed-on-acp" as const,
	});

	const waiting = render(stateWith(workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		...base,
		pendingPermission: pending("2036-08-18T12:04:45.000Z"),
	})));
	ok(!waiting.includes("approval-banner--escalated"));
	ok(!waiting.includes("has been waiting for"));
	ok(!waiting.includes("is-escalated"));

	const escalated = render(stateWith(workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		...base,
		pendingPermission: pending("2026-08-18T12:04:45.000Z"),
	})));
	match(escalated, /approval-banner--escalated/u);
	match(escalated, /APPROVAL WAITING · ESCALATED/u);
	match(escalated, /An approval has been waiting for 45 seconds\./u);
	match(escalated, /status-bar__operation[^"]*is-escalated/u);
	match(escalated, /awaiting approval · escalated/u);
});

Deno.test("a tool call that has been open past thirty seconds says so", () => {
	const longStart = new Date(Date.now() - 45_000).toISOString();
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		clio: clioSnapshotFixture("running"),
		activeTurn: {
			turnId: "turn-1",
			startedAt: longStart,
			toolCalls: 1,
			lastToolTitle: "bash: git log --all",
			repeatedShapes: 0,
		},
		timeline: [
			{
				id: "turn-1:tool-1",
				kind: "tool",
				title: "Run a project command",
				summary: "bash: git log --all",
				status: "active",
				turnId: "turn-1",
				origin: "live",
				startedAt: longStart,
				sequence: 2,
				source: "observed-on-acp",
			},
			{
				id: "turn-1:tool-2",
				kind: "tool",
				title: "Run a project command",
				summary: "bash: git status",
				status: "active",
				turnId: "turn-1",
				origin: "live",
				startedAt: new Date(Date.now() - 2_000).toISOString(),
				sequence: 3,
				source: "observed-on-acp",
			},
		],
	});
	const html = render(stateWith(workspace));
	equal((html.match(/still running · /gu) ?? []).length, 1);
	match(html, /still running · 45s/u);
	match(html, /timeline-card--long/u);
});

Deno.test("a repeated command shape is reported as Clio Coder's finding, never as a GUI guess", () => {
	const workspace = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		clio: clioSnapshotFixture("running"),
		activeTurn: {
			turnId: "turn-1",
			startedAt: new Date().toISOString(),
			toolCalls: 17,
			lastToolTitle: "bash: git log --all --stat",
			repeatedShapes: 2,
		},
		timeline: [{
			id: "turn-1:loop-1",
			kind: "loop",
			title: "Clio Coder blocked a repeated bash call",
			summary: "Repeated 3 times; 1 of 8 blocks used this turn (block).",
			status: "complete",
			turnId: "turn-1",
			origin: "live",
			startedAt: "2026-08-18T12:05:00.000Z",
			sequence: 9,
			source: "reported-by-clio",
		}],
	});
	const html = render(stateWith(workspace));
	match(html, /Clio Coder blocked a repeated bash call/u);
	match(html, /Reported by Clio Coder/u);
	match(html, /17 tool calls/u);
	match(html, /2 repeated/u);
	match(html, /bash: git log --all --stat/u);
});

Deno.test("the settings page offers desktop notifications without ever asking for them itself", () => {
	const html = render(
		appReducer(stateWith(workspaceFixture()), { type: "settings.opened", open: true }),
	);
	match(html, /<h3[^>]*>Approvals<\/h3>/u);
	// Server-rendered there is no Notification API, which must degrade quietly.
	match(html, /This browser cannot post desktop notifications\./u);
	match(html, /A notification carries the tool title only\. The GUI never puts a project path in one\./u);
});
