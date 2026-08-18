import { deepStrictEqual, equal, match, notDeepStrictEqual, ok, throws } from "node:assert/strict";
import {
	MAX_WIRE_COLLECTION_ENTRIES,
	type ServerEvent,
	type WireEngineReadinessFact,
	type WirePendingPermission,
} from "../src/protocol.ts";
import {
	appReducer,
	formatProjectPath,
	initialAppState,
	MAX_TIMELINE_STREAM_BYTES,
	parseBootstrapPayload,
	selectedWorkspace,
	TIMELINE_STREAM_TRUNCATION_MARKER,
} from "../src/state.ts";
import { bootstrapFixture, engineSnapshotFixture, serverEventFixture, workspaceFixture } from "./fixtures.ts";

const source = "simulated-by-workbench" as const;

function pendingPermissionFixture(): WirePendingPermission {
	return {
		permissionId: "permission-fixture-0001",
		toolCallId: "tool-fixture-0001",
		title: "Update a project file",
		kind: "edit",
		locations: [{ segments: ["src", "model.ts"] }],
		expiresAt: "2026-08-17T12:05:00.000Z",
		source,
	};
}

function withFact(
	key: WireEngineReadinessFact["key"],
	state: WireEngineReadinessFact["state"],
): readonly WireEngineReadinessFact[] {
	return engineSnapshotFixture().facts.map((fact) => fact.key === key ? { ...fact, state } : fact);
}

Deno.test("bootstrap validation accepts only an exact, internally consistent v2 wire payload", () => {
	const bootstrap = bootstrapFixture();
	deepStrictEqual(parseBootstrapPayload(structuredClone(bootstrap)), bootstrap);

	const invalidSelection = structuredClone(bootstrap) as unknown as Record<string, unknown>;
	invalidSelection.selectedProjectId = "project-missing-9999";
	throws(() => parseBootstrapPayload(invalidSelection), /selected project is missing/u);

	const incompatible = structuredClone(bootstrap) as unknown as Record<string, unknown>;
	incompatible.protocolVersion = 1;
	throws(() => parseBootstrapPayload(incompatible), /protocolVersion must be 2/u);

	const v1Alias = structuredClone(bootstrap) as unknown as Record<string, unknown>;
	v1Alias.fakeEngine = true;
	throws(() => parseBootstrapPayload(v1Alias), /unknown field "fakeEngine"/u);

	const nestedAlias = structuredClone(bootstrap) as unknown as {
		projects: Array<Record<string, unknown>>;
	};
	nestedAlias.projects[0]!.engineState = "ready";
	throws(() => parseBootstrapPayload(nestedAlias), /unknown field.*engineState/u);

	const awaitingWithoutPermission = structuredClone(bootstrap) as unknown as {
		projects: Array<{ engine: { phase: string } }>;
	};
	awaitingWithoutPermission.projects[0]!.engine.phase = "awaiting-approval";
	throws(() => parseBootstrapPayload(awaitingWithoutPermission), /pendingPermission must be present exactly/u);

	const permissionWithoutTurn = structuredClone(bootstrap) as unknown as {
		projects: Array<{
			engine: { phase: string };
			pendingPermission: WirePendingPermission | null;
			engineGeneration: string | null;
			activeTurnId: string | null;
		}>;
	};
	permissionWithoutTurn.projects[0]!.engine.phase = "awaiting-approval";
	permissionWithoutTurn.projects[0]!.pendingPermission = pendingPermissionFixture();
	permissionWithoutTurn.projects[0]!.engineGeneration = null;
	permissionWithoutTurn.projects[0]!.activeTurnId = null;
	throws(() => parseBootstrapPayload(permissionWithoutTurn), /pendingPermission requires an activeTurnId/u);

	const generationWithoutTurn = structuredClone(bootstrap);
	generationWithoutTurn.projects[0]!.engineGeneration = "generation-without-turn-0001";
	throws(() => parseBootstrapPayload(generationWithoutTurn), /must be present or absent together/u);

	const turnWithoutGeneration = structuredClone(bootstrap);
	turnWithoutGeneration.projects[0]!.activeTurnId = "turn-without-generation-0001";
	throws(() => parseBootstrapPayload(turnWithoutGeneration), /must be present or absent together/u);
});

Deno.test("bootstrap restores a consistent authoritative pending permission", () => {
	const bootstrap = bootstrapFixture();
	const alpha = bootstrap.projects[0]!;
	alpha.engine = engineSnapshotFixture("awaiting-approval");
	alpha.engineGeneration = "generation-bootstrap-0001";
	alpha.activeTurnId = "turn-bootstrap-0001";
	alpha.pendingPermission = pendingPermissionFixture();
	const parsed = parseBootstrapPayload(structuredClone(bootstrap));
	const state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: parsed });
	const workspace = state.projects[alpha.project.id]!;

	equal(workspace.engine.phase, "awaiting-approval");
	deepStrictEqual(workspace.pendingPermission, pendingPermissionFixture());
});

Deno.test("bootstrap projects are projected from authoritative engine and path DTOs", () => {
	const bootstrap = bootstrapFixture();
	const alpha = bootstrap.projects[0]!;
	alpha.changes.push({
		id: "change-bootstrap-0001",
		path: { segments: ["src", "solver.ts"] },
		summary: "Recorded solver change",
		status: "recorded",
		source,
	});
	alpha.agents.push({
		id: "agent-bootstrap-0001",
		name: "Verifier",
		task: "Check the solver",
		status: "complete",
		summary: "Solver checked",
		source,
	});
	alpha.evidence.push({
		id: "evidence-bootstrap-0001",
		label: "Focused test",
		detail: "Passed",
		status: "observed",
		source,
	});

	const state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrap });
	const workspace = state.projects[alpha.project.id]!;
	equal(workspace.engine.kind, "fake");
	equal(workspace.engine.phase, "ready");
	equal(workspace.pendingPermission, null);
	equal(workspace.changes[0]?.path, "src/solver.ts");
	equal(workspace.changes[0]?.source, source);
	equal(workspace.agents[0]?.target, "Solver checked");
	equal(workspace.evidence[0]?.source, source);
	equal(formatProjectPath({ segments: [] }), "/");
	equal(formatProjectPath({ segments: ["src", "solver.ts"] }), "src/solver.ts");
});

Deno.test("project selection is separate from identity and v2 events never leak across projects or workspaces", () => {
	let state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrapFixture() });
	const betaBefore = structuredClone(state.projects["project-beta-0002"]);

	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("engine.state", { snapshot: engineSnapshotFixture("running") }, { sequence: 1 }),
	});
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("turn.started", {
			promptSummary: "Only Alpha changes",
			fakeScenario: "complete",
			source,
		}, { sequence: 2 }),
	});

	equal(state.projects["project-alpha-0001"]?.engine.phase, "running");
	equal(state.projects["project-alpha-0001"]?.activeTurnId, "turn-alpha-0001");
	equal(state.projects["project-alpha-0001"]?.timeline.length, 1);
	deepStrictEqual(state.projects["project-beta-0002"], betaBefore);

	const beforeForeignWorkspace = state;
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("engine.state", { snapshot: engineSnapshotFixture("failed") }, {
			sequence: 3,
			workspaceInstanceId: "workspace-foreign-0002",
		}),
	});
	equal(state, beforeForeignWorkspace);

	state = appReducer(state, { type: "project.selected", projectId: "project-beta-0002" });
	equal(state.selectedProjectId, "project-beta-0002");
	equal(selectedWorkspace(state)?.project.displayName, "Beta");
	equal(state.projects["project-alpha-0001"]?.project.id, "project-alpha-0001");
	notDeepStrictEqual(state.projects["project-alpha-0001"], state.projects["project-beta-0002"]);
});

Deno.test("responsive drawers remain mutually exclusive across breakpoint state changes", () => {
	let state = appReducer(initialAppState, { type: "drawer.left", open: true });
	equal(state.leftDrawerOpen, true);
	equal(state.rightDrawerOpen, false);

	state = appReducer(state, { type: "drawer.right", open: true });
	equal(state.leftDrawerOpen, false);
	equal(state.rightDrawerOpen, true);

	state = appReducer(state, { type: "drawer.right", open: false });
	equal(state.leftDrawerOpen, false);
	equal(state.rightDrawerOpen, false);
});

Deno.test("turn events are isolated by the opaque engine generation as well as session and turn", () => {
	let state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrapFixture() });
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("turn.started", { promptSummary: "Generation-bound turn", source }, { sequence: 1 }),
	});
	const beforeWrongGeneration = structuredClone(state.projects["project-alpha-0001"]);

	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("turn.text", { text: "stale generation", source }, {
			sequence: 2,
			engineGeneration: "generation-stale-9999",
		}),
	});
	deepStrictEqual(state.projects["project-alpha-0001"], beforeWrongGeneration);

	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("turn.text", { text: "current generation", source }, { sequence: 3 }),
	});
	equal(state.projects["project-alpha-0001"]?.timeline.at(-1)?.summary, "current generation");
});

Deno.test("neutral turn events coalesce streams, tools, and agents while retaining provenance and safe paths", () => {
	let state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrapFixture() });
	let sequence = 0;
	const apply = (event: ServerEvent) => {
		state = appReducer(state, { type: "host.event", event });
	};
	const options = () => ({ sequence: ++sequence });

	apply(serverEventFixture("engine.state", { snapshot: engineSnapshotFixture("running") }, options()));
	apply(serverEventFixture("turn.started", {
		promptSummary: "Audit the numerical solver",
		fakeScenario: "complete",
		source,
	}, options()));
	apply(serverEventFixture("turn.text", { text: "Hello ", source }, options()));
	apply(serverEventFixture("turn.text", { text: "world", source }, options()));
	apply(serverEventFixture("turn.thought", { text: "Check the boundary.", source }, options()));
	apply(serverEventFixture("turn.agent", {
		agentId: "agent-verifier-0001",
		name: "Verifier",
		task: "Check convergence",
		status: "active",
		summary: "Verification started",
		source,
	}, options()));
	apply(serverEventFixture("turn.agent", {
		agentId: "agent-verifier-0001",
		name: "Verifier",
		task: "Check convergence",
		status: "complete",
		summary: "Verification completed",
		source,
	}, options()));
	apply(serverEventFixture("turn.tool", {
		toolCallId: "tool-read-0001",
		title: "Read solver",
		kind: "read",
		status: "in_progress",
		summary: "Reading solver evidence",
		locations: [{ segments: ["src", "solver.ts"] }],
		source,
	}, options()));
	apply(serverEventFixture("turn.tool", {
		toolCallId: "tool-read-0001",
		title: "Read solver",
		kind: "read",
		status: "completed",
		summary: "Solver evidence read",
		locations: [{ segments: ["src", "solver.ts"] }],
		source,
	}, options()));
	apply(serverEventFixture("turn.change", {
		path: { segments: ["src", "solver.ts"] },
		summary: "Recorded a bounded solver change",
		source,
	}, options()));

	let workspace = state.projects["project-alpha-0001"]!;
	equal(workspace.timeline.filter((item) => item.title === "Fake engine").length, 1);
	equal(workspace.timeline.find((item) => item.title === "Fake engine")?.summary, "Hello world");
	equal(workspace.timeline.filter((item) => item.kind === "agent").length, 1);
	equal(workspace.timeline.filter((item) => item.kind === "tool").length, 1);
	equal(workspace.timeline.find((item) => item.kind === "tool")?.status, "complete");
	equal(workspace.timeline.find((item) => item.kind === "tool")?.detail, "read · src/solver.ts");
	equal(workspace.agents.length, 1);
	equal(workspace.agents[0]?.status, "complete");
	equal(workspace.agents[0]?.source, source);
	equal(workspace.changes[0]?.path, "src/solver.ts");
	equal(workspace.changes[0]?.source, source);

	const completedTool = workspace.timeline.find((item) => item.kind === "tool");
	apply(serverEventFixture("turn.tool", {
		toolCallId: "tool-read-0001",
		title: "Read solver",
		kind: "read",
		status: "in_progress",
		summary: "Stale replay",
		locations: [{ segments: ["src", "solver.ts"] }],
		source,
	}, { sequence: sequence - 1 }));
	workspace = state.projects["project-alpha-0001"]!;
	deepStrictEqual(workspace.timeline.find((item) => item.kind === "tool"), completedTool);
});

Deno.test("stream coalescing is UTF-8 byte bounded with a stable marker and runtime collections stay capped", () => {
	let state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrapFixture() });
	let sequence = 1;
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("turn.started", { promptSummary: "Bound the renderer stream", source }, { sequence }),
	});
	const chunk = "😀".repeat(4096);
	for (let index = 0; index < 6; index += 1) {
		state = appReducer(state, {
			type: "host.event",
			event: serverEventFixture("turn.text", { text: chunk, source }, { sequence: ++sequence }),
		});
	}
	let workspace = state.projects["project-alpha-0001"]!;
	const stream = workspace.timeline.find((item) => item.title === "Fake engine")!;
	ok(new TextEncoder().encode(stream.summary).byteLength <= MAX_TIMELINE_STREAM_BYTES);
	ok(stream.summary.endsWith(TIMELINE_STREAM_TRUNCATION_MARKER));
	const stableSummary = stream.summary;

	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("turn.text", { text: "ignored after truncation", source }, { sequence: ++sequence }),
	});
	equal(
		state.projects["project-alpha-0001"]?.timeline.find((item) => item.title === "Fake engine")?.summary,
		stableSummary,
	);

	for (let index = 0; index < MAX_WIRE_COLLECTION_ENTRIES + 8; index += 1) {
		state = appReducer(state, {
			type: "host.event",
			event: serverEventFixture("turn.evidence", {
				label: `Bounded evidence ${index}`,
				detail: "Observed fixture evidence",
				status: "observed",
				source,
			}, { sequence: ++sequence }),
		});
	}
	workspace = state.projects["project-alpha-0001"]!;
	equal(workspace.evidence.length, MAX_WIRE_COLLECTION_ENTRIES);
	equal(workspace.timeline.length, MAX_WIRE_COLLECTION_ENTRIES);
	equal(workspace.evidence.at(-1)?.label, `Bounded evidence ${MAX_WIRE_COLLECTION_ENTRIES + 7}`);
});

Deno.test("permissions bind to the active turn, resolve by ID, announce urgently, and clear terminally", () => {
	let state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrapFixture() });
	let sequence = 0;
	const apply = (event: ServerEvent) => {
		state = appReducer(state, { type: "host.event", event });
	};
	const options = () => ({ sequence: ++sequence });

	apply(serverEventFixture("engine.state", { snapshot: engineSnapshotFixture("running") }, options()));
	apply(serverEventFixture("turn.started", { promptSummary: "Update the solver", source }, options()));
	apply(serverEventFixture("engine.state", { snapshot: engineSnapshotFixture("awaiting-approval") }, options()));
	apply(serverEventFixture("turn.permission.requested", {
		permissionId: "permission-edit-0001",
		toolCallId: "tool-edit-0001",
		title: "Update solver file",
		kind: "edit",
		locations: [{ segments: ["src", "solver.ts"] }],
		expiresAt: "2026-08-17T12:05:00.000Z",
		source,
	}, options()));

	let workspace = state.projects["project-alpha-0001"]!;
	equal(workspace.pendingPermission?.permissionId, "permission-edit-0001");
	equal(workspace.pendingPermission?.toolCallId, "tool-edit-0001");
	deepStrictEqual(workspace.pendingPermission?.locations, [{ segments: ["src", "solver.ts"] }]);
	const approvalItem = workspace.timeline.find((item) => item.kind === "approval");
	match(approvalItem?.summary ?? "", /edit permission requested for src\/solver\.ts/u);
	match(approvalItem?.detail ?? "", /Allow once for src\/solver\.ts/u);
	match(state.announcement, /requires your decision/u);

	apply(serverEventFixture("turn.permission.resolved", {
		permissionId: "permission-other-0002",
		decision: "reject",
		source,
	}, options()));
	equal(state.projects["project-alpha-0001"]?.pendingPermission?.permissionId, "permission-edit-0001");
	equal(state.projects["project-alpha-0001"]?.timeline.some((item) => item.title === "Permission resolved"), false);

	apply(serverEventFixture("turn.terminal", {
		outcome: "canceled",
		code: "operator-cancelled",
		summary: "Canceled by the operator.",
		stopReason: "cancelled",
		source,
	}, options()));
	workspace = state.projects["project-alpha-0001"]!;
	equal(workspace.pendingPermission, null);
	equal(workspace.activeTurnId, null);
	equal(workspace.timeline.at(-1)?.status, "canceled");
	equal(workspace.sessions.find((session) => session.id === "session-alpha-0001")?.status, "canceled");
});

Deno.test("all terminal outcomes map explicitly and authoritative engine state changes only from snapshots", () => {
	for (const outcome of ["completed", "canceled", "failed"] as const) {
		let state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrapFixture() });
		state = appReducer(state, {
			type: "host.event",
			event: serverEventFixture("engine.state", { snapshot: engineSnapshotFixture("running") }, { sequence: 1 }),
		});
		state = appReducer(state, {
			type: "host.event",
			event: serverEventFixture("turn.started", { promptSummary: `${outcome} request`, source }, { sequence: 2 }),
		});
		state = appReducer(state, {
			type: "host.event",
			event: serverEventFixture("turn.terminal", {
				outcome,
				code: `fixture-${outcome}`,
				summary: `Turn ${outcome}.`,
				...(outcome === "canceled" ? { stopReason: "cancelled" as const } : {}),
				source,
			}, { sequence: 3 }),
		});

		let workspace = state.projects["project-alpha-0001"]!;
		equal(workspace.engine.phase, "running");
		equal(workspace.activeTurnId, null);
		equal(workspace.timeline.at(-1)?.kind, outcome === "failed" ? "failure" : "outcome");
		equal(
			workspace.timeline.at(-1)?.status,
			outcome === "completed" ? "complete" : outcome === "canceled" ? "canceled" : "failed",
		);
		if (outcome === "failed") match(state.announcement, /Turn failed/u);

		const finalPhase = outcome === "failed" ? "failed" : "ready";
		state = appReducer(state, {
			type: "host.event",
			event: serverEventFixture("engine.state", { snapshot: engineSnapshotFixture(finalPhase) }, { sequence: 4 }),
		});
		workspace = state.projects["project-alpha-0001"]!;
		equal(workspace.engine.phase, finalPhase);
	}
});

Deno.test("authoritative v2 engine snapshots retain exact phases and readiness facts", () => {
	let state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrapFixture() });
	let sequence = 0;
	const applySnapshot = (
		phase: Parameters<typeof engineSnapshotFixture>[0],
		facts?: readonly WireEngineReadinessFact[],
	) => {
		const snapshot = engineSnapshotFixture(phase, "clio-acp", facts);
		state = appReducer(state, {
			type: "host.event",
			event: serverEventFixture("engine.state", { snapshot }, {
				sequence: ++sequence,
			}),
		});
		const engine = state.projects["project-alpha-0001"]!.engine;
		deepStrictEqual(engine, snapshot);
		return engine;
	};

	equal(applySnapshot("unprobed").phase, "unprobed");
	equal(applySnapshot("probing").phase, "probing");
	equal(
		applySnapshot("unavailable", withFact("runtime", "unavailable")).facts.find((fact) => fact.key === "runtime")
			?.state,
		"unavailable",
	);
	equal(
		applySnapshot("unavailable", withFact("runtime", "failed")).facts.find((fact) => fact.key === "runtime")
			?.state,
		"failed",
	);
	equal(
		applySnapshot("unavailable", withFact("target", "unavailable")).facts.find((fact) => fact.key === "target")
			?.state,
		"unavailable",
	);
	equal(applySnapshot("failed").phase, "failed");
	equal(
		applySnapshot("failed", withFact("target", "unavailable")).facts.find((fact) => fact.key === "target")?.state,
		"unavailable",
	);

	const fakePartialFacts = engineSnapshotFixture().facts.map((fact) =>
		fact.key === "protocol" || fact.key === "target" ? { ...fact, state: "unavailable" as const } : fact
	);
	const ready = applySnapshot("ready", fakePartialFacts);
	equal(ready.phase, "ready");
	equal(ready.facts.find((fact) => fact.key === "protocol")?.state, "unavailable");
	equal(ready.facts.find((fact) => fact.key === "target")?.state, "unavailable");
});

Deno.test("registered workspaces are projected, selected, and rejected when event identity contradicts payload", () => {
	let state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrapFixture() });
	const gamma = workspaceFixture("project-gamma-0003", "Gamma");
	gamma.engine = engineSnapshotFixture("unprobed", "clio-acp");

	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("project.registered", { workspace: gamma }, {
			sequence: 1,
			projectId: gamma.project.id,
		}),
	});
	equal(state.selectedProjectId, gamma.project.id);
	equal(state.projects[gamma.project.id]?.engine.kind, "clio-acp");
	equal(state.projects[gamma.project.id]?.engine.phase, "unprobed");

	const beforeMismatch = state;
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("project.registered", { workspace: workspaceFixture("project-delta-0004", "Delta") }, {
			sequence: 2,
			projectId: "project-not-delta-9999",
		}),
	});
	equal(state, beforeMismatch);
});

Deno.test("protocol and command errors remain bounded notices with protocol failure changing connection state", () => {
	let state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrapFixture() });
	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("command.error", {
			code: "not-ready",
			message: "The selected engine is not ready.",
			requestId: "request-fixture-0001",
		}, { sequence: 1 }),
	});
	equal(state.notice?.message, "The selected engine is not ready.");
	equal(state.connection, "connecting");

	state = appReducer(state, {
		type: "host.event",
		event: serverEventFixture("protocol.error", {
			code: "sequence-error",
			message: "The local event sequence was invalid.",
		}, { sequence: 2 }),
	});
	equal(state.notice?.message, "The local event sequence was invalid.");
	equal(state.connection, "failed");
	ok(state.announcement.includes("sequence"));
});
