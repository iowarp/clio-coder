import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import type { WirePendingPermission } from "../src/protocol.ts";
import {
	appReducer,
	initialAppState,
	isPromptBlocked,
	parseBootstrapPayload,
	workspaceConsistencyError,
} from "../src/state.ts";
import {
	bootstrapFixture,
	catalogInspectionFixture,
	clioSnapshotFixture,
	FIXTURE_PROJECT_ID,
	serverEventFixture,
	workspaceFixture,
} from "./fixtures.ts";

const source = "observed-on-acp" as const;

function pendingPermissionFixture(): WirePendingPermission {
	return {
		permissionId: "permission-fixture-0001",
		toolCallId: "tool-fixture-0001",
		title: "Update a project file",
		kind: "edit",
		locations: [{ segments: ["src", "model.ts"] }],
		requestedAt: "2026-08-18T12:04:00.000Z",
		escalateAt: "2026-08-18T12:04:45.000Z",
		expiresAt: "2026-08-18T12:14:00.000Z",
		source,
	};
}

function readyState() {
	return appReducer(initialAppState, {
		type: "bootstrap.loaded",
		payload: parseBootstrapPayload(structuredClone(bootstrapFixture()) as unknown),
	});
}

Deno.test("bootstrap validation accepts only an exact, internally consistent v3 payload", () => {
	const bootstrap = bootstrapFixture();
	deepStrictEqual(parseBootstrapPayload(structuredClone(bootstrap) as unknown), bootstrap);

	const wrongVersion = structuredClone(bootstrap) as unknown as Record<string, unknown>;
	wrongVersion.protocolVersion = 2;
	throws(() => parseBootstrapPayload(wrongVersion), /protocolVersion must be 3/u);

	const v2Alias = structuredClone(bootstrap) as unknown as Record<string, unknown>;
	v2Alias.selectedProjectId = FIXTURE_PROJECT_ID;
	throws(() => parseBootstrapPayload(v2Alias), /unknown field "selectedProjectId"/u);

	const nestedAlias = structuredClone(bootstrap) as unknown as { workspace: Record<string, unknown> };
	nestedAlias.workspace.engine = { phase: "ready" };
	throws(() => parseBootstrapPayload(nestedAlias), /unknown field.*engine/u);

	const halfOpen = structuredClone(bootstrap) as unknown as Record<string, unknown>;
	halfOpen.workspace = null;
	throws(() => parseBootstrapPayload(halfOpen), /present or absent together/u);

	const mismatched = structuredClone(bootstrap) as unknown as Record<string, unknown>;
	mismatched.openProjectId = "project-other-0002";
	throws(() => parseBootstrapPayload(mismatched), /workspace is invalid|does not describe/u);

	const relativeHome = structuredClone(bootstrap) as unknown as Record<string, unknown>;
	relativeHome.homePath = "operator";
	throws(() => parseBootstrapPayload(relativeHome), /homePath must be absolute/u);
});

Deno.test("a bootstrap with no open project is valid and leaves the app waiting for a folder", () => {
	const bootstrap = bootstrapFixture({ openProjectId: null, workspace: null, recent: [] });
	const parsed = parseBootstrapPayload(structuredClone(bootstrap) as unknown);
	const state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: parsed });
	equal(state.boot, "ready");
	equal(state.open, null);
	deepStrictEqual(state.recent, []);
	ok(state.announcement.includes("Open a project"));
	equal(isPromptBlocked(state.open), true);
});

Deno.test("an approval that contradicts the phase is refused in both directions", () => {
	const awaitingWithout = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		clio: clioSnapshotFixture("awaiting-approval"),
	});
	ok(workspaceConsistencyError(awaitingWithout)?.includes("pendingPermission must be present exactly"));

	const pendingWhileIdle = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		pendingPermission: pendingPermissionFixture(),
		activeTurn: {
			turnId: "turn-1",
			startedAt: "2026-08-18T12:03:00.000Z",
			toolCalls: 1,
			lastToolTitle: null,
			repeatedShapes: 0,
		},
	});
	ok(workspaceConsistencyError(pendingWhileIdle)?.includes("pendingPermission must be present exactly"));

	const withoutTurn = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		clio: clioSnapshotFixture("awaiting-approval"),
		pendingPermission: pendingPermissionFixture(),
		activeTurn: null,
	});
	ok(withoutTurn && workspaceConsistencyError(withoutTurn)?.includes("requires an active turn"));

	const consistent = workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", {
		clio: clioSnapshotFixture("awaiting-approval"),
		pendingPermission: pendingPermissionFixture(),
		activeTurn: {
			turnId: "turn-1",
			startedAt: "2026-08-18T12:03:00.000Z",
			toolCalls: 1,
			lastToolTitle: null,
			repeatedShapes: 0,
		},
	});
	equal(workspaceConsistencyError(consistent), null);
	const bootstrap = bootstrapFixture({ workspace: consistent });
	const parsed = parseBootstrapPayload(structuredClone(bootstrap) as unknown);
	const state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: parsed });
	deepStrictEqual(state.open?.projection.pendingPermission, pendingPermissionFixture());
});

Deno.test("a contradictory project.opened is refused without replacing the open project", () => {
	const state = readyState();
	const event = serverEventFixture("project.opened", {
		workspace: workspaceFixture(FIXTURE_PROJECT_ID, "Alpha", { clio: clioSnapshotFixture("awaiting-approval") }),
	}, { sequence: 2 });
	const next = appReducer(state, { type: "host.event", event });
	equal(next.notice?.tone, "error");
	deepStrictEqual(next.open?.clio, state.open?.clio);
});

Deno.test("turn events fold into the projection and clear the pending submission", () => {
	let state = readyState();
	state = appReducer(state, { type: "turn.submitted", requestId: "request-1" });
	equal(state.pendingTurnStart, "request-1");
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("turn.started", {
			promptSummary: "Audit the convergence study",
			origin: "live",
			startedAt: "2026-08-18T12:03:00.000Z",
			source: "observed-by-workbench",
		}, { sequence: 2 }),
	});
	equal(state.pendingTurnStart, null);
	equal(state.open?.projection.activeTurn?.turnId, "turn-1");

	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("turn.text", { text: "Reading the notes.", source }, { sequence: 3 }),
	});
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("turn.tool", {
			toolCallId: "tool-1",
			title: "Read notes.md",
			kind: "read",
			status: "in_progress",
			summary: "reading",
			locations: [{ segments: ["notes.md"] }],
			source,
		}, { sequence: 4 }),
	});
	equal(state.open?.projection.activeTurn?.toolCalls, 1);
	// Clio's own name for the call rather than the generic kind label.
	equal(state.open?.projection.activeTurn?.lastToolTitle, "reading");

	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("turn.terminal", {
			outcome: "completed",
			code: "clio-completed",
			summary: "Clio finished this turn.",
			source: "reported-by-clio",
		}, { sequence: 5 }),
	});
	equal(state.open?.projection.activeTurn, null);
	deepStrictEqual(
		state.open?.projection.timeline.map((item) => item.kind),
		["request", "narrative", "tool", "outcome"],
	);
});

Deno.test("a frame batch folds every validated event in sequence with one reducer action", () => {
	const state = readyState();
	const started = serverEventFixture("turn.started", {
		promptSummary: "Measure the frame batch.",
		origin: "live",
		startedAt: "2026-08-18T12:05:00.000Z",
		source: "observed-by-workbench",
	}, { sequence: 2 });
	const first = serverEventFixture(
		"turn.text",
		{ text: "alpha ", source },
		{ sequence: 3, eventId: "event-frame-alpha" },
	);
	const second = serverEventFixture(
		"turn.text",
		{ text: "beta", source },
		{ sequence: 4, eventId: "event-frame-beta" },
	);
	const next = appReducer(state, { type: "host.events", events: [started, first, second] });

	equal(next.lastSequence, 4);
	equal(next.open?.projection.timeline.at(-1)?.summary, "alpha beta");
});

Deno.test("events for another project or an older sequence are ignored", () => {
	const state = readyState();
	const foreign = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("clio.state", { snapshot: clioSnapshotFixture("failed") }, {
			sequence: 2,
			projectId: "project-other-0002",
		}),
	});
	equal(foreign.open?.clio.phase, "idle");

	const replayed = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("clio.state", { snapshot: clioSnapshotFixture("failed") }, { sequence: 0 }),
	});
	equal(replayed.open?.clio.phase, "idle");

	const foreignWorkspace = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("clio.state", { snapshot: clioSnapshotFixture("failed") }, {
			sequence: 2,
			workspaceInstanceId: "workspace-other-0002",
		}),
	});
	equal(foreignWorkspace.open?.clio.phase, "idle");
});

Deno.test("a command error becomes a visible notice and releases the composer", () => {
	let state = readyState();
	state = appReducer(state, { type: "turn.submitted", requestId: "request-1" });
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("command.error", {
			code: "conflict",
			message: "Clio is still working on the previous prompt. Cancel it or wait.",
			requestId: "request-1",
		}, { sequence: 2 }),
	});
	equal(state.notice?.tone, "warning");
	equal(state.pendingTurnStart, null);
	equal(state.announcement, "Clio is still working on the previous prompt. Cancel it or wait.");

	state = appReducer(state, { type: "config.inspect.submitted", requestId: "request-config" });
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("command.error", {
			code: "not-ready",
			message: "Clio could not inspect configuration.",
			requestId: "request-config",
		}, { sequence: 3 }),
	});
	equal(state.pendingConfigInspect, null);

	state = appReducer(state, { type: "catalog.inspect.submitted", requestId: "request-catalog" });
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("command.error", {
			code: "not-ready",
			message: "Clio could not inspect catalogs.",
			requestId: "request-catalog",
		}, { sequence: 4 }),
	});
	equal(state.pendingCatalogInspect, null);
});

Deno.test("a protocol error fails the connection", () => {
	const state = appReducer(readyState(), {
		type: "host.event",
		event: serverEventFixture("protocol.error", { code: "invalid-frame", message: "bad frame" }, { sequence: 2 }),
	});
	equal(state.connection, "failed");
	equal(state.notice?.tone, "error");
});

Deno.test("opening a project replaces the workspace and updates the recent list", () => {
	const state = readyState();
	const opened = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("project.opened", {
			workspace: workspaceFixture("project-beta-0002", "Beta"),
		}, { sequence: 2, projectId: "project-beta-0002" }),
	});
	equal(opened.open?.project.id, "project-beta-0002");
	equal(opened.recent.length, 2);
	equal(opened.recent[0]?.id, "project-beta-0002");
	equal(opened.leftDrawerOpen, false);

	const forgotten = appReducer(opened, {
		type: "host.event",
		event: serverEventFixture("project.forgotten", {}, { sequence: 3, projectId: "project-beta-0002" }),
	});
	equal(forgotten.open, null);
	deepStrictEqual(forgotten.recent.map((entry) => entry.id), [FIXTURE_PROJECT_ID]);
});

Deno.test("session, settings, configuration, catalog, and target events land on the open workspace", () => {
	let state = readyState();
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("session.list", {
			sessions: [],
			truncated: true,
		}, { sequence: 2 }),
	});
	deepStrictEqual(state.open?.sessions, []);
	equal(state.open?.sessionsTruncated, true);

	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("targets.state", {
			targets: [{
				id: "lmstudio",
				runtime: "openai-compatible",
				models: ["qwen3.8-27b"],
				isOrchestrator: true,
				health: null,
			}],
			truncated: true,
		}, { sequence: 3 }),
	});
	equal(state.open?.targets?.[0]?.health, null);
	equal(state.open?.targetsTruncated, true);

	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("targets.probed", {
			targetId: "lmstudio",
			health: { healthy: true, latencyMs: 12, reason: null, probedAt: "2026-08-18T12:06:00.000Z" },
		}, { sequence: 4 }),
	});
	equal(state.open?.targets?.[0]?.health?.healthy, true);

	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("settings.state", {
			settings: {
				settings: { "orchestrator.target": "lmstudio" },
				editable: ["orchestrator.target"],
				options: { "orchestrator.target": ["lmstudio", "openai"] },
				checkedAt: "2026-08-18T12:06:00.000Z",
			},
		}, { sequence: 5 }),
	});
	deepStrictEqual(state.open?.settings?.editable, ["orchestrator.target"]);

	state = appReducer(state, { type: "config.inspect.submitted", requestId: "request-config" });
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("config.state", {
			inspection: {
				inspectedAt: "2026-08-29T12:00:00.000Z",
				settings: [{ key: "autonomy", source: "project", value: "suggest", valueKind: "exact" }],
				settingsTruncated: false,
				entries: [],
				entriesTruncated: false,
				issueCounts: [],
				issuesTruncated: false,
			},
		}, { sequence: 6 }),
	});
	equal(state.open?.configInspection?.settings[0]?.value, "suggest");
	equal(state.pendingConfigInspect, null);

	state = appReducer(state, { type: "catalog.inspect.submitted", requestId: "request-catalog" });
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("catalog.state", { inspection: catalogInspectionFixture() }, { sequence: 7 }),
	});
	equal(state.open?.catalogInspection?.agents.items[0]?.id, "researcher");
	equal(state.open?.catalogInspection?.verifiers.availability, "typed-interface-required");
	equal(state.pendingCatalogInspect, null);
});

Deno.test("a browse listing is held until it is dismissed", () => {
	let state = readyState();
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("project.browse.listing", {
			path: "/home/operator",
			parent: "/home",
			entries: [{ name: "code", hidden: false, guarded: false }],
			truncated: false,
			openable: false,
			reason: "Your home directory cannot be opened as a project; choose a folder inside it.",
		}, { sequence: 2 }),
	});
	equal(state.browse?.entries.length, 1);
	equal(appReducer(state, { type: "browse.dismissed" }).browse, null);
});

Deno.test("a reconnected socket restarts the sequence window", () => {
	let state = readyState();
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("clio.state", { snapshot: clioSnapshotFixture("running") }, { sequence: 9 }),
	});
	equal(state.open?.clio.phase, "running");
	state = appReducer(state, { type: "connection.changed", connection: "disconnected" });
	state = appReducer(state, { type: "connection.changed", connection: "connected" });
	equal(state.lastSequence, 0);
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("clio.state", { snapshot: clioSnapshotFixture("idle") }, { sequence: 1 }),
	});
	equal(state.open?.clio.phase, "idle");
});

Deno.test("the composer is blocked exactly while Clio is occupied", () => {
	const state = readyState();
	equal(isPromptBlocked(state.open), false);
	for (const phase of ["running", "awaiting-approval", "cancelling"] as const) {
		const busy = appReducer(state, {
			type: "host.event",
			event: serverEventFixture("clio.state", { snapshot: clioSnapshotFixture(phase) }, { sequence: 2 }),
		});
		equal(isPromptBlocked(busy.open), true, `expected ${phase} to block the composer`);
	}
});

Deno.test("a refused select is the only thing that marks a remembered folder unopenable", () => {
	const ready = readyState();
	const beta = {
		id: "project-beta-0002",
		displayName: "Beta",
		rootPath: "/tmp/workbench-fixture/beta",
		lastOpenedAt: "2026-08-18T11:00:00.000Z",
		available: true,
	};
	const withBeta = appReducer(ready, {
		type: "bootstrap.loaded",
		payload: parseBootstrapPayload(
			structuredClone(bootstrapFixture({ recent: [...bootstrapFixture().recent, beta] })) as unknown,
		),
	});
	equal(withBeta.recent.length, 2);

	// A refusal that answers this exact select is the host saying the canonical
	// path failed the guards or is no longer a directory.
	const submitted = appReducer(withBeta, {
		type: "project.select.submitted",
		requestId: "request-select-beta",
		projectId: beta.id,
	});
	deepStrictEqual(submitted.pendingProjectSelect, { requestId: "request-select-beta", projectId: beta.id });
	const refused = appReducer(submitted, {
		type: "host.event",
		event: serverEventFixture("command.error", {
			code: "refused",
			message: "That directory does not exist.",
			requestId: "request-select-beta",
		}, { sequence: 2, projectId: beta.id }),
	});
	equal(refused.recent.find((entry) => entry.id === beta.id)?.available, false);
	equal(refused.recent.find((entry) => entry.id === FIXTURE_PROJECT_ID)?.available, true);
	equal(refused.pendingProjectSelect, null);
	equal(refused.notice?.tone, "warning");

	// A conflict says a prompt is running, not that the folder is gone.
	const conflicted = appReducer(
		appReducer(withBeta, { type: "project.select.submitted", requestId: "request-select-2", projectId: beta.id }),
		{
			type: "host.event",
			event: serverEventFixture("command.error", {
				code: "conflict",
				message: "Clio is still working in the open project.",
				requestId: "request-select-2",
			}, { sequence: 3, projectId: beta.id }),
		},
	);
	equal(conflicted.recent.find((entry) => entry.id === beta.id)?.available, true);
	equal(conflicted.pendingProjectSelect, null);

	// A refusal that belongs to some other command leaves every row alone.
	const unrelated = appReducer(
		appReducer(withBeta, { type: "project.select.submitted", requestId: "request-select-3", projectId: beta.id }),
		{
			type: "host.event",
			event: serverEventFixture("command.error", {
				code: "refused",
				message: "That path is outside the project.",
				requestId: "request-move-1",
			}, { sequence: 4, projectId: FIXTURE_PROJECT_ID }),
		},
	);
	equal(unrelated.recent.find((entry) => entry.id === beta.id)?.available, true);
	deepStrictEqual(unrelated.pendingProjectSelect, { requestId: "request-select-3", projectId: beta.id });
});

Deno.test("a select that succeeds or is forgotten clears the pending selection", () => {
	const submitted = appReducer(readyState(), {
		type: "project.select.submitted",
		requestId: "request-select-alpha",
		projectId: FIXTURE_PROJECT_ID,
	});
	const opened = appReducer(submitted, {
		type: "host.event",
		event: serverEventFixture("project.opened", {
			workspace: workspaceFixture(FIXTURE_PROJECT_ID, "Alpha"),
		}, { sequence: 2, projectId: FIXTURE_PROJECT_ID }),
	});
	equal(opened.pendingProjectSelect, null);

	const forgotten = appReducer(submitted, {
		type: "host.event",
		event: serverEventFixture("project.forgotten", {}, { sequence: 3, projectId: FIXTURE_PROJECT_ID }),
	});
	equal(forgotten.pendingProjectSelect, null);
});

Deno.test("the desktop notification preference is in-memory only and defaults to on", () => {
	equal(initialAppState.desktopNotifications, true);
	const muted = appReducer(readyState(), { type: "notifications.set", enabled: false });
	equal(muted.desktopNotifications, false);
	equal(appReducer(muted, { type: "notifications.set", enabled: true }).desktopNotifications, true);
	// The bootstrap payload carries no such field, so re-bootstrapping over a live
	// socket neither sets nor clears what the operator just chose. A real page
	// reload starts from the initial state, where it is on and the browser's own
	// permission is still the thing that decides whether anything is posted.
	const bootstrapped = appReducer(muted, {
		type: "bootstrap.loaded",
		payload: parseBootstrapPayload(structuredClone(bootstrapFixture()) as unknown),
	});
	equal(bootstrapped.desktopNotifications, false);
});
