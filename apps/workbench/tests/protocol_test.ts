import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import {
	assertLocalWebSocketUrl,
	AUTONOMY_LEVELS,
	CLIENT_COMMAND_KINDS,
	type ClientCommand,
	COMMAND_ERROR_CODES,
	encodeClientCommand,
	encodeServerEvent,
	isTurnEventKind,
	MAX_CLIENT_FRAME_BYTES,
	MAX_SERVER_EVENT_BYTES,
	parseClientCommand,
	parseServerEvent,
	PERMISSION_DECISIONS,
	PERMISSION_RESOLUTIONS,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type ProtocolValidationErrorCode,
	SERVER_EVENT_KINDS,
	type ServerEventKind,
	type ServerEventOf,
	ServerSequenceGuard,
	SESSION_STATES,
	validateClientCommand,
	validateServerEvent,
	WebSocketLocalTransport,
} from "../src/protocol.ts";

function clientFrame(
	kind: string,
	payload: unknown,
	requestId = "request-0001",
): string {
	return JSON.stringify({
		protocolVersion: PROTOCOL_VERSION,
		requestId,
		kind,
		payload,
	});
}

function parseCommand(kind: string, payload: unknown): ClientCommand {
	return parseClientCommand(clientFrame(kind, payload));
}

function expectProtocolError(
	action: () => unknown,
	code: ProtocolValidationErrorCode = "invalid-payload",
): ProtocolValidationError {
	try {
		action();
	} catch (error) {
		ok(error instanceof ProtocolValidationError);
		equal(error.code, code);
		return error;
	}
	throw new Error(`Expected ProtocolValidationError with code ${code}`);
}

function clioSnapshot(phase = "idle") {
	return {
		phase,
		agent: { name: "clio-coder", version: "0.3.2" },
		capabilities: {
			load: true,
			list: true,
			label: true,
			delete: true,
			autonomy: true,
			settings: true,
			targets: true,
			loopBlocked: true,
			dispatchEvents: true,
			agentAttribution: true,
		},
		session: null,
		lastFailure: null,
		checkedAt: "2026-08-18T12:00:00.000Z",
	};
}

function wireWorkspace(overrides: Record<string, unknown> = {}) {
	return {
		project: {
			id: "project-alpha",
			displayName: "Alpha",
			rootPath: "/tmp/workbench/alpha",
			lastOpenedAt: "2026-08-18T12:00:00.000Z",
			available: true,
		},
		tree: [{
			name: "src",
			path: { segments: ["src"] },
			kind: "directory",
			operable: true,
			children: [],
		}],
		treeTruncated: false,
		sessions: [],
		sessionsTruncated: false,
		clio: clioSnapshot(),
		timeline: [],
		timelineTruncated: false,
		activeTurn: null,
		pendingPermission: null,
		deleteChallenge: null,
		settings: null,
		configInspection: null,
		catalogInspection: null,
		usageInspection: null,
		routingInspection: null,
		targets: null,
		targetsTruncated: false,
		fleet: [],
		processGeneration: null,
		lastSequence: 0,
		...overrides,
	};
}

function serverEvent<K extends ServerEventKind>(
	kind: K,
	payload: unknown,
	sequence = 1,
): ServerEventOf<K> {
	const context = isTurnEventKind(kind)
		? {
			projectId: "project-alpha",
			processGeneration: "generation-public-001",
			sessionId: "session-public-001",
			turnId: "turn-1",
		}
		: kind === "connection.ready" || kind === "protocol.error" ||
				kind === "command.error" ||
				kind === "project.browse.listing" || kind === "dispatch.state" ||
				kind === "fleet.inspection.state" ||
				kind === "toolchain.state" || kind === "trace.state" || kind === "evidence.state" ||
				kind === "evidence.detail.state" || kind === "fleet.verification.state" ||
				kind === "recovery.state"
		? {}
		: { projectId: "project-alpha" };
	return validateServerEvent({
		protocolVersion: PROTOCOL_VERSION,
		workspaceInstanceId: "workspace-0001",
		sequence,
		eventId: `event-${kind.replaceAll(".", "-")}-${sequence}`,
		kind,
		...context,
		terminal: kind === "turn.terminal" || kind === "protocol.error",
		payload,
	}) as ServerEventOf<K>;
}

Deno.test("the v4 command family is a hard cut with no engine or sandbox aliases", () => {
	equal(PROTOCOL_VERSION, 4);
	deepStrictEqual(CLIENT_COMMAND_KINDS, [
		"project.browse",
		"project.open",
		"project.select",
		"project.forget",
		"fs.refresh",
		"fs.create-file",
		"fs.create-folder",
		"fs.move",
		"fs.delete.prepare",
		"fs.delete.confirm",
		"session.new",
		"session.load",
		"session.close",
		"session.list",
		"session.label",
		"session.delete",
		"turn.start",
		"turn.cancel",
		"permission.resolve",
		"settings.get",
		"settings.patch",
		"config.inspect",
		"catalog.inspect",
		"usage.inspect",
		"routing.inspect",
		"dispatch.inspect",
		"fleet.inspect",
		"toolchain.inspect",
		"trace.inspect",
		"evidence.inspect",
		"evidence.read",
		"fleet.verify",
		"recovery.inspect",
		"targets.list",
		"targets.probe",
		"autonomy.set",
	]);
	for (
		const removed of [
			"engine.select",
			"engine.probe",
			"project.create",
			"project.register",
			"turn.preview",
		]
	) {
		expectProtocolError(() => parseCommand(removed, { projectId: "project-alpha" }));
	}
	deepStrictEqual(PERMISSION_DECISIONS, ["allow-once", "reject"]);
	deepStrictEqual(PERMISSION_RESOLUTIONS, [
		"allow-once",
		"reject",
		"cancelled",
		"unanswered",
		"disconnect",
	]);
	deepStrictEqual(SESSION_STATES, ["open", "closed", "unknown"]);
	deepStrictEqual(AUTONOMY_LEVELS, [
		"read-only",
		"suggest",
		"auto-edit",
		"full-auto",
	]);
});

Deno.test("project commands accept absolute native paths only", () => {
	deepStrictEqual(
		parseCommand("project.open", { path: "/tmp/workbench/alpha" }).payload,
		{
			path: "/tmp/workbench/alpha",
		},
	);
	deepStrictEqual(parseCommand("project.browse", {}).payload, {});
	deepStrictEqual(
		parseCommand("project.browse", { path: "/home/operator" }).payload,
		{ path: "/home/operator" },
	);
	for (
		const invalidPath of [
			"relative/path",
			"",
			" /tmp/padded",
			"/tmp/with\0null",
			`/tmp/${"x".repeat(4 * 1024)}`,
		]
	) {
		expectProtocolError(() => parseCommand("project.open", { path: invalidPath }));
	}
	expectProtocolError(() => parseCommand("project.open", { path: "/tmp/a", extra: 1 }));
	deepStrictEqual(
		parseCommand("project.select", { projectId: "project-alpha" }).payload,
		{
			projectId: "project-alpha",
		},
	);
	expectProtocolError(() => parseCommand("project.forget", { projectId: "project alpha" }));
});

Deno.test("session and autonomy commands round-trip their exact shapes", () => {
	deepStrictEqual(
		parseCommand("session.load", {
			projectId: "project-alpha",
			sessionId: "session-1",
		}).payload,
		{
			projectId: "project-alpha",
			sessionId: "session-1",
		},
	);
	deepStrictEqual(
		parseCommand("session.label", {
			projectId: "project-alpha",
			sessionId: "session-1",
			label: "Audit",
		}).payload,
		{ projectId: "project-alpha", sessionId: "session-1", label: "Audit" },
	);
	// An empty label clears it; a padded or oversized one is refused.
	deepStrictEqual(
		parseCommand("session.label", {
			projectId: "project-alpha",
			sessionId: "session-1",
			label: "",
		}).payload,
		{ projectId: "project-alpha", sessionId: "session-1", label: "" },
	);
	expectProtocolError(() =>
		parseCommand("session.label", {
			projectId: "project-alpha",
			sessionId: "session-1",
			label: " padded ",
		})
	);
	expectProtocolError(() =>
		parseCommand("session.label", {
			projectId: "project-alpha",
			sessionId: "session-1",
			label: "x".repeat(257),
		})
	);
	deepStrictEqual(
		parseCommand("autonomy.set", {
			projectId: "project-alpha",
			level: "read-only",
		}).payload,
		{
			projectId: "project-alpha",
			level: "read-only",
		},
	);
	expectProtocolError(() => parseCommand("autonomy.set", { projectId: "project-alpha", level: "yolo" }));
});

Deno.test("turn and permission commands stay bounded and one-use", () => {
	deepStrictEqual(
		parseCommand("turn.start", {
			projectId: "project-alpha",
			prompt: "Audit the study",
		}).payload,
		{
			projectId: "project-alpha",
			prompt: "Audit the study",
		},
	);
	for (
		const prompt of [
			"",
			" ",
			" padded ",
			"x".repeat(8 * 1024 + 1),
			"with\0null",
		]
	) {
		expectProtocolError(() => parseCommand("turn.start", { projectId: "project-alpha", prompt }));
	}
	expectProtocolError(() =>
		parseCommand("turn.start", {
			projectId: "project-alpha",
			prompt: "ok",
			fakeScenario: "complete",
		})
	);
	deepStrictEqual(
		parseCommand("permission.resolve", {
			projectId: "project-alpha",
			turnId: "turn-1",
			permissionId: "permission-1",
			decision: "allow-once",
		}).payload,
		{
			projectId: "project-alpha",
			turnId: "turn-1",
			permissionId: "permission-1",
			decision: "allow-once",
		},
	);
	for (const decision of ["allow-always", "timeout", "cancelled"]) {
		expectProtocolError(() =>
			parseCommand("permission.resolve", {
				projectId: "project-alpha",
				turnId: "turn-1",
				permissionId: "permission-1",
				decision,
			})
		);
	}
});

Deno.test("settings patches encode the four key specific value domains", () => {
	deepStrictEqual(
		parseCommand("settings.patch", {
			projectId: "project-alpha",
			patch: { "orchestrator.model": "qwen3.8-27b" },
		})
			.payload,
		{
			projectId: "project-alpha",
			patch: { "orchestrator.model": "qwen3.8-27b" },
		},
	);
	deepStrictEqual(
		parseCommand("settings.patch", {
			projectId: "project-alpha",
			patch: {
				"orchestrator.target": null,
				"orchestrator.model": "qwen3.8-27b",
				"orchestrator.thinkingLevel": "xhigh",
				autonomy: "suggest",
			},
		}).payload,
		{
			projectId: "project-alpha",
			patch: {
				"orchestrator.target": null,
				"orchestrator.model": "qwen3.8-27b",
				"orchestrator.thinkingLevel": "xhigh",
				autonomy: "suggest",
			},
		},
	);
	expectProtocolError(() => parseCommand("settings.patch", { projectId: "project-alpha", patch: {} }));
	for (
		const patch of [
			{ "Bad Key": "x" },
			{ "orchestrator.target": "" },
			{ "orchestrator.model": "x".repeat(257) },
			{ "orchestrator.thinkingLevel": null },
			{ "orchestrator.thinkingLevel": "extreme" },
			{ autonomy: null },
			{ autonomy: "yolo" },
		]
	) {
		expectProtocolError(() => parseCommand("settings.patch", { projectId: "project-alpha", patch }));
	}
});

Deno.test("filesystem commands keep their strict project-relative DTOs", () => {
	deepStrictEqual(
		parseCommand("fs.refresh", { projectId: "project-alpha", directory: [] })
			.payload,
		{
			projectId: "project-alpha",
			directory: [],
		},
	);
	deepStrictEqual(
		parseCommand("fs.move", {
			projectId: "project-alpha",
			source: ["notes.md"],
			destination: { parent: ["analysis"], name: "notes.md" },
			expectedNodeVersion: "node-1",
		}).payload,
		{
			projectId: "project-alpha",
			source: ["notes.md"],
			destination: { parent: ["analysis"], name: "notes.md" },
			expectedNodeVersion: "node-1",
		},
	);
	for (const segment of ["..", ".", "a/b", "a\\b", ""]) {
		expectProtocolError(() =>
			parseCommand("fs.refresh", {
				projectId: "project-alpha",
				directory: [segment],
			})
		);
	}
	expectProtocolError(() =>
		parseCommand("fs.delete.prepare", {
			projectId: "project-alpha",
			target: [],
		})
	);
});

Deno.test("every command kind round-trips and the list stays exhaustive", () => {
	const samples: Record<string, unknown> = {
		"project.browse": {},
		"project.open": { path: "/tmp/workbench/alpha" },
		"project.select": { projectId: "project-alpha" },
		"project.forget": { projectId: "project-alpha" },
		"fs.refresh": { projectId: "project-alpha", directory: [] },
		"fs.create-file": {
			projectId: "project-alpha",
			parent: [],
			name: "notes.md",
		},
		"fs.create-folder": {
			projectId: "project-alpha",
			parent: [],
			name: "analysis",
		},
		"fs.move": {
			projectId: "project-alpha",
			source: ["notes.md"],
			destination: { parent: [], name: "renamed.md" },
		},
		"fs.delete.prepare": { projectId: "project-alpha", target: ["notes.md"] },
		"fs.delete.confirm": {
			projectId: "project-alpha",
			confirmationId: "confirmation-1",
		},
		"session.new": { projectId: "project-alpha" },
		"session.load": { projectId: "project-alpha", sessionId: "session-1" },
		"session.close": { projectId: "project-alpha" },
		"session.list": { projectId: "project-alpha" },
		"session.label": {
			projectId: "project-alpha",
			sessionId: "session-1",
			label: "Audit",
		},
		"session.delete": { projectId: "project-alpha", sessionId: "session-1" },
		"turn.start": { projectId: "project-alpha", prompt: "Audit the study" },
		"turn.cancel": { projectId: "project-alpha", turnId: "turn-1" },
		"permission.resolve": {
			projectId: "project-alpha",
			turnId: "turn-1",
			permissionId: "permission-1",
			decision: "reject",
		},
		"settings.get": { projectId: "project-alpha" },
		"settings.patch": {
			projectId: "project-alpha",
			patch: { autonomy: "suggest" },
		},
		"config.inspect": { projectId: "project-alpha" },
		"catalog.inspect": { projectId: "project-alpha" },
		"usage.inspect": { projectId: "project-alpha" },
		"routing.inspect": { projectId: "project-alpha" },
		"dispatch.inspect": {},
		"fleet.inspect": {},
		"toolchain.inspect": {},
		"trace.inspect": {},
		"evidence.inspect": {},
		"evidence.read": { evidenceId: "run-alpha-bundle" },
		"fleet.verify": { runId: "run-alpha" },
		"recovery.inspect": {},
		"targets.list": { projectId: "project-alpha" },
		"targets.probe": { projectId: "project-alpha", targetId: "lmstudio" },
		"autonomy.set": { projectId: "project-alpha", level: "auto-edit" },
	};
	deepStrictEqual(
		Object.keys(samples).sort(),
		[...CLIENT_COMMAND_KINDS].sort(),
	);
	for (const kind of CLIENT_COMMAND_KINDS) {
		const command = parseCommand(kind, samples[kind]);
		deepStrictEqual(
			validateClientCommand(JSON.parse(encodeClientCommand(command))),
			command,
		);
	}
});

Deno.test("client frames reject malformed, inherited, unknown, and oversized input", () => {
	expectProtocolError(() => parseClientCommand("{"), "invalid-frame");
	expectProtocolError(() => parseClientCommand("[]"));
	expectProtocolError(
		() =>
			parseClientCommand(
				JSON.stringify({
					protocolVersion: 2,
					requestId: "r",
					kind: "session.new",
					payload: {},
				}),
			),
		"unsupported-version",
	);
	expectProtocolError(() =>
		parseClientCommand(
			clientFrame("session.new", { projectId: "project-alpha" }, " padded "),
		)
	);
	const oversized = clientFrame("turn.start", {
		projectId: "project-alpha",
		prompt: "x".repeat(MAX_CLIENT_FRAME_BYTES),
	});
	expectProtocolError(() => parseClientCommand(oversized), "frame-too-large");
});

Deno.test("clio snapshots use closed phases and never carry an engine kind", () => {
	const event = serverEvent("clio.state", {
		snapshot: clioSnapshot("awaiting-approval"),
	});
	equal(event.kind, "clio.state");
	expectProtocolError(() => serverEvent("clio.state", { snapshot: { ...clioSnapshot(), kind: "fake" } }));
	expectProtocolError(() => serverEvent("clio.state", { snapshot: clioSnapshot("ready") }));
	expectProtocolError(() =>
		serverEvent("clio.state", {
			snapshot: { ...clioSnapshot(), capabilities: {} },
		})
	);
});

Deno.test("workspace payloads accept only the exact v4 workspace", () => {
	const opened = serverEvent("project.opened", { workspace: wireWorkspace() });
	equal(opened.payload.workspace.project.rootPath, "/tmp/workbench/alpha");
	expectProtocolError(() => serverEvent("project.opened", { workspace: wireWorkspace({ agents: [] }) }));
	expectProtocolError(() =>
		serverEvent("project.opened", {
			workspace: wireWorkspace({
				project: { id: "project-alpha", displayName: "Alpha", identity: {} },
			}),
		})
	);
	expectProtocolError(() =>
		serverEvent("project.opened", {
			workspace: wireWorkspace({ lastSequence: -1 }),
		})
	);
});

Deno.test("workspace terminal cards preserve bounded Clio Coder usage and reject usage on non-terminal cards", () => {
	const terminal = {
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
		usage: {
			input: 1_024,
			output: 233,
			cacheRead: 800,
			cacheWrite: 17,
			reasoning: 91,
		},
		source: "reported-by-clio",
	};
	const opened = serverEvent("project.opened", {
		workspace: wireWorkspace({ timeline: [terminal] }),
	});
	deepStrictEqual(opened.payload.workspace.timeline[0]?.usage, terminal.usage);

	for (
		const invalidTimeline of [
			{ ...terminal, kind: "tool" },
			{ ...terminal, usage: { ...terminal.usage, output: -1 } },
			{ ...terminal, usage: { ...terminal.usage, total: 2_165 } },
		]
	) {
		expectProtocolError(() =>
			serverEvent("project.opened", {
				workspace: wireWorkspace({ timeline: [invalidTimeline] }),
			})
		);
	}
});

Deno.test("replay timeline DTOs carry neutral status, no clock, and an explicit replay source", () => {
	const replayedRequest = {
		id: "turn-1:request",
		kind: "request",
		title: "Earlier request",
		summary: "Earlier prompt",
		status: "replayed",
		turnId: "turn-1",
		origin: "replay",
		startedAt: null,
		sequence: 1,
		source: "replayed-from-clio",
	};
	const opened = serverEvent("project.opened", {
		workspace: wireWorkspace({ timeline: [replayedRequest] }),
	});
	equal(opened.payload.workspace.timeline[0]?.startedAt, null);
	equal(opened.payload.workspace.timeline[0]?.status, "replayed");
	equal(opened.payload.workspace.timeline[0]?.source, "replayed-from-clio");

	serverEvent("turn.started", {
		promptSummary: "Earlier prompt",
		origin: "replay",
		startedAt: null,
		source: "replayed-from-clio",
	});
	for (
		const invalidTimeline of [
			{ ...replayedRequest, startedAt: "2026-08-18T12:00:00.000Z" },
			{ ...replayedRequest, source: "observed-on-acp" },
			{ ...replayedRequest, status: "complete" },
			{ ...replayedRequest, kind: "outcome", status: "replayed" },
			{ ...replayedRequest, endedAt: "2026-08-18T12:00:01.000Z" },
		]
	) {
		expectProtocolError(() =>
			serverEvent("project.opened", {
				workspace: wireWorkspace({ timeline: [invalidTimeline] }),
			})
		);
	}
	expectProtocolError(() =>
		serverEvent("turn.started", {
			promptSummary: "Earlier prompt",
			origin: "replay",
			startedAt: "2026-08-18T12:00:00.000Z",
			source: "observed-on-acp",
		})
	);
	expectProtocolError(() =>
		serverEvent("turn.started", {
			promptSummary: "Live prompt",
			origin: "live",
			startedAt: null,
			source: "observed-by-workbench",
		})
	);
});

Deno.test("turn events carry a full context and reject raw ACP data", () => {
	const tool = serverEvent("turn.tool", {
		toolCallId: "tool-1",
		title: "Read notes.md",
		kind: "read",
		status: "in_progress",
		summary: "reading",
		locations: [{ segments: ["notes.md"] }],
		agents: [],
		source: "observed-on-acp",
	});
	equal(tool.turnId, "turn-1");
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: PROTOCOL_VERSION,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-1",
			kind: "turn.text",
			projectId: "project-alpha",
			terminal: false,
			payload: { text: "hello", agents: [], source: "observed-on-acp" },
		})
	);
	for (
		const forbidden of [
			{ rawInput: { path: "/etc/passwd" } },
			{ requestId: 4 },
			{ nativePath: "/etc" },
		]
	) {
		expectProtocolError(() =>
			serverEvent("turn.tool", {
				toolCallId: "tool-1",
				title: "Read",
				kind: "read",
				status: "completed",
				summary: "done",
				locations: [],
				agents: [],
				source: "observed-on-acp",
				...forbidden,
			})
		);
	}
});

const FLEET_RUN = {
	runId: "run-1",
	agentId: "explorer",
	state: "progress",
	taskPreview: "Audit the convergence study",
	node: "blade",
	attempt: 0,
	progressCount: 4,
	progressTruncated: false,
	outcome: null,
	durationMs: null,
	tokenCount: null,
	updatedAt: "2026-08-18T12:00:00.000Z",
};

Deno.test("fleet activity carries only reported dispatch facts under a closed state set", () => {
	const activity = serverEvent("fleet.activity", {
		run: FLEET_RUN,
		source: "reported-by-clio",
	});
	equal(activity.payload.run.state, "progress");
	equal(activity.payload.run.progressCount, 4);
	// A fleet fact belongs to the session, not to a turn: a detached run settles
	// after the turn that started it returned.
	equal(activity.turnId, undefined);

	for (
		const invalidRun of [
			{ ...FLEET_RUN, state: "cancelled" },
			{ ...FLEET_RUN, progressCount: -1 },
			{ ...FLEET_RUN, outcome: "succeeded" },
			{ ...FLEET_RUN, runId: "run\u0007one" },
			{ ...FLEET_RUN, task: "the exact dispatched task" },
		]
	) {
		expectProtocolError(() =>
			serverEvent("fleet.activity", {
				run: invalidRun,
				source: "reported-by-clio",
			})
		);
	}
	// A settled run may name its outcome; that is the only state that may.
	const settled = serverEvent("fleet.activity", {
		run: {
			...FLEET_RUN,
			state: "done",
			outcome: "succeeded",
			durationMs: 1_200,
			tokenCount: 640,
		},
		source: "reported-by-clio",
	});
	equal(settled.payload.run.outcome, "succeeded");
});

Deno.test("agent attribution is a closed role set that binds a worker to its run", () => {
	const attributed = serverEvent("turn.text", {
		text: "The worker reported back.",
		agents: [
			{
				role: "orchestrator",
				agentId: "orchestrator",
				runId: null,
				node: null,
			},
			{ role: "worker", agentId: "explorer", runId: "run-1", node: "blade" },
		],
		source: "observed-on-acp",
	});
	equal(attributed.payload.agents.length, 2);
	equal(attributed.payload.agents[1]?.agentId, "explorer");

	for (
		const invalidAgents of [
			[{ role: "supervisor", agentId: "explorer", runId: "run-1", node: null }],
			[{
				role: "orchestrator",
				agentId: "orchestrator",
				runId: "run-1",
				node: null,
			}],
			[{ role: "worker", agentId: "explorer", runId: "run-1" }],
			[{
				role: "worker",
				agentId: "explorer",
				runId: "run-1",
				node: null,
				task: "raw",
			}],
			Array.from(
				{ length: 18 },
				() => ({ role: "worker", agentId: "a", runId: "r", node: null }),
			),
		]
	) {
		expectProtocolError(() =>
			serverEvent("turn.text", {
				text: "x",
				agents: invalidAgents,
				source: "observed-on-acp",
			})
		);
	}
});

Deno.test("loop events carry the block accounting Clio Coder reported and never a fabricated shape", () => {
	const loop = serverEvent("turn.loop", {
		toolCallId: null,
		tool: "bash",
		repeatCount: 3,
		blocksThisTurn: 1,
		budget: 5,
		disposition: "block",
		interrupted: false,
		shape: null,
		source: "reported-by-clio",
	});
	equal(loop.payload.repeatCount, 3);
	expectProtocolError(() =>
		serverEvent("turn.loop", {
			toolCallId: null,
			tool: "bash",
			repeatCount: -1,
			blocksThisTurn: 1,
			budget: 5,
			disposition: "block",
			interrupted: false,
			shape: null,
			source: "reported-by-clio",
		})
	);
	expectProtocolError(() =>
		serverEvent("turn.loop", {
			toolCallId: null,
			tool: "bash",
			repeatCount: 3,
			blocksThisTurn: 1,
			budget: 5,
			disposition: "explode",
			interrupted: false,
			shape: null,
			source: "reported-by-clio",
		})
	);
	for (
		const forbidden of [
			{ toolCallId: "tool-1", shape: null },
			{ toolCallId: null, shape: "bash git log" },
		]
	) {
		expectProtocolError(() =>
			serverEvent("turn.loop", {
				...forbidden,
				tool: "bash",
				repeatCount: 3,
				blocksThisTurn: 1,
				budget: 5,
				disposition: "block",
				interrupted: false,
				source: "reported-by-clio",
			})
		);
	}
});

Deno.test("permission events use the escalation stamps and the closed resolution set", () => {
	const requested = serverEvent("turn.permission.requested", {
		permissionId: "permission-1",
		toolCallId: "tool-1",
		title: "Write notes.md",
		kind: "edit",
		locations: [{ segments: ["notes.md"] }],
		requestedAt: "2026-08-18T12:04:00.000Z",
		escalateAt: "2026-08-18T12:04:45.000Z",
		expiresAt: "2026-08-18T12:14:00.000Z",
		source: "observed-on-acp",
	});
	equal(requested.payload.escalateAt, "2026-08-18T12:04:45.000Z");
	for (const decision of PERMISSION_RESOLUTIONS) {
		const resolved = serverEvent("turn.permission.resolved", {
			permissionId: "permission-1",
			decision,
			source: "observed-by-workbench",
		});
		equal(resolved.payload.decision, decision);
	}
	expectProtocolError(() =>
		serverEvent("turn.permission.resolved", {
			permissionId: "permission-1",
			decision: "timeout",
			source: "observed-by-workbench",
		})
	);
});

Deno.test("only terminal events are flagged terminal and usage stays exact", () => {
	const terminal = serverEvent("turn.terminal", {
		outcome: "canceled",
		code: "approval-unanswered",
		summary: "Workbench stopped the turn.",
		stopReason: "cancelled",
		usage: { input: 5, output: 8, cacheRead: 1, cacheWrite: 0, reasoning: 2 },
		source: "observed-by-workbench",
	});
	equal(terminal.terminal, true);
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: PROTOCOL_VERSION,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-1",
			kind: "clio.state",
			projectId: "project-alpha",
			terminal: true,
			payload: { snapshot: clioSnapshot() },
		})
	);
	expectProtocolError(() =>
		serverEvent("turn.terminal", {
			outcome: "completed",
			code: "clio-completed",
			summary: "done",
			usage: {
				input: -1,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
			},
			source: "reported-by-clio",
		})
	);
});

Deno.test("browse listings, session lists, settings, and targets keep their bounded shapes", () => {
	const listing = serverEvent("project.browse.listing", {
		path: "/home/operator",
		parent: "/home",
		entries: [{ name: "code", hidden: false, guarded: false }],
		truncated: false,
		openable: false,
		reason: "Your home directory cannot be opened as a project.",
	});
	equal(listing.payload.entries.length, 1);
	expectProtocolError(() =>
		serverEvent("project.browse.listing", {
			path: "relative",
			parent: null,
			entries: [],
			truncated: false,
			openable: true,
			reason: null,
		})
	);
	const sessions = serverEvent("session.list", {
		sessions: [{
			id: "session-1",
			label: null,
			preview: "",
			createdAt: "2026-08-18T12:00:00.000Z",
			updatedAt: "2026-08-18T12:00:00.000Z",
			turns: 0,
			target: null,
			model: null,
			state: "unknown",
			hosted: false,
		}],
		truncated: false,
	});
	equal(sessions.payload.sessions[0]?.state, "unknown");
	const targets = serverEvent("targets.state", {
		targets: [{
			id: "lmstudio",
			runtime: "openai",
			models: ["qwen"],
			isOrchestrator: true,
			health: null,
		}],
		truncated: true,
	});
	equal(targets.payload.targets[0]?.health, null);
	equal(targets.payload.truncated, true);
	// A target list without its truncation flag would let a shortened list read as complete.
	expectProtocolError(() =>
		serverEvent("targets.state", {
			targets: [{
				id: "lmstudio",
				runtime: "openai",
				models: ["qwen"],
				isOrchestrator: true,
				health: null,
			}],
		})
	);
	const probed = serverEvent("targets.probed", {
		targetId: "lmstudio",
		health: {
			healthy: false,
			latencyMs: null,
			reason: "not-configured",
			probedAt: "2026-08-18T12:00:00.000Z",
		},
	});
	equal(probed.payload.health.healthy, false);
	const settings = serverEvent("settings.state", {
		settings: {
			settings: { "orchestrator.target": "lmstudio" },
			editable: ["orchestrator.target"],
			options: { "orchestrator.target": ["lmstudio"] },
			checkedAt: "2026-08-18T12:00:00.000Z",
		},
	});
	deepStrictEqual(settings.payload.settings.editable, ["orchestrator.target"]);
});

Deno.test("effective configuration events accept only the redacted bounded graph", () => {
	const event = serverEvent("config.state", {
		inspection: {
			inspectedAt: "2026-08-29T12:00:00.000Z",
			settings: [{
				key: "orchestrator.model",
				source: "project",
				value: "qwen",
				valueKind: "exact",
			}],
			settingsTruncated: false,
			entries: [{
				category: "rule",
				id: "project-rule",
				scope: "project",
				sourcePath: { segments: [".clio-coder", "rules", "project.yaml"] },
				hash: "aabbccdd",
				trust: "trusted",
				precedence: "winner",
				reloadClass: "next-turn",
				contextCostTokens: 22,
				facts: [{ label: "Enabled", value: "yes" }],
			}],
			entriesTruncated: false,
			issueCounts: [{ surface: "settings", count: 1 }],
			issuesTruncated: false,
		},
	});
	equal(
		event.payload.inspection.entries[0]?.sourcePath?.segments.join("/"),
		".clio-coder/rules/project.yaml",
	);
	expectProtocolError(() =>
		serverEvent("config.state", {
			inspection: {
				...event.payload.inspection,
				entries: [{
					...event.payload.inspection.entries[0],
					sourcePath: "/home/operator/private",
				}],
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("config.state", {
			inspection: {
				...event.payload.inspection,
				settings: [{
					key: "secret",
					source: "user",
					value: "configured",
					valueKind: "raw",
				}],
			},
		})
	);
});

Deno.test("resource catalog events accept only bounded inventory fields", () => {
	const event = serverEvent("catalog.state", {
		inspection: {
			inspectedAt: "2026-08-29T13:00:00.000Z",
			agents: {
				availability: "available",
				items: [{
					id: "researcher",
					name: "Researcher",
					description: "Finds evidence.",
					version: 1,
					source: "builtin",
					audience: "base",
					category: "research",
					capability: "read-only",
					latency: "deep",
					contextTier: "none",
					tags: ["evidence"],
					skills: ["literature"],
					tools: ["read"],
					resultKind: "research-report",
					budget: {
						toolCalls: 24,
						readReserve: 4,
						synthesis: true,
						maximumToolCalls: null,
						maximumReadReserve: null,
					},
				}],
				truncated: false,
				issueCount: 0,
			},
			skills: {
				availability: "available",
				items: [{
					name: "literature",
					description: "Finds papers.",
					scope: "project",
					source: "clio",
					trusted: true,
					precedence: 30,
					modelInvocable: true,
					issueCount: 0,
				}],
				truncated: false,
				issueCount: 0,
			},
			library: {
				availability: "available",
				items: [{
					kind: "skill",
					name: "available-skill",
					description: "Available from the catalog.",
					version: "1.0.0",
					category: "research",
					origin: "catalog",
					audit: "pass",
				}],
				truncated: false,
				issueCount: 0,
			},
			extensions: {
				availability: "available",
				items: [{
					id: "lab-pack",
					name: "Lab Pack",
					version: "2.1.0",
					description: "Adds research workflows.",
					scope: "user",
					enabled: true,
					effective: false,
					overriddenBy: "project",
					resources: ["skills", "agents"],
					issueCount: 1,
				}],
				truncated: false,
				issueCount: 1,
			},
			verifiers: { availability: "typed-interface-required" },
		},
	});
	equal(event.payload.inspection.agents.items[0]?.capability, "read-only");
	equal(event.payload.inspection.library.items[0]?.audit, "pass");
	equal(event.payload.inspection.extensions.items[0]?.overriddenBy, "project");
	expectProtocolError(() =>
		serverEvent("catalog.state", {
			inspection: {
				...event.payload.inspection,
				skills: {
					...event.payload.inspection.skills,
					items: [{
						...event.payload.inspection.skills.items[0],
						content: "raw skill body",
					}],
				},
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("catalog.state", {
			inspection: {
				...event.payload.inspection,
				verifiers: { availability: "scraped-table" },
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("catalog.state", {
			inspection: {
				...event.payload.inspection,
				extensions: {
					...event.payload.inspection.extensions,
					items: [{
						...event.payload.inspection.extensions.items[0],
						effective: true,
						overriddenBy: "project",
					}],
				},
			},
		})
	);
});

Deno.test("project usage events keep exact aggregates while rejecting raw and contradictory history", () => {
	const event = serverEvent("usage.state", {
		inspection: {
			inspectedAt: "2026-08-29T14:00:00.000Z",
			schema: "experimental",
			windowDays: 30,
			windowFrom: "2026-07-30T13:00:00.000Z",
			windowTo: "2026-08-29T13:00:00.000Z",
			stores: { sessions: "available", dispatchReceipts: "available" },
			sessionCount: 3,
			dispatchRunCount: 2,
			totals: {
				apiCalls: 42,
				input: 8_500_000,
				output: 1_200_000,
				cacheRead: 3_400_000,
				cacheWrite: 22_000,
				reasoning: 800_000,
				totalTokens: 13_922_000,
				costUsd: 4.125,
				turns: 38,
				sideQuestions: 3,
				handoffs: 1,
			},
			models: [{
				provider: "lmstudio",
				model: "qwen3.8-27b",
				apiCalls: 42,
				input: 8_500_000,
				output: 1_200_000,
				cacheRead: 3_400_000,
				cacheWrite: 22_000,
				reasoning: 800_000,
				totalTokens: 13_922_000,
				costUsd: 4.125,
			}],
			modelsTruncated: false,
			tools: [{
				name: "read",
				calls: 17,
				successful: 16,
				errors: 1,
				blocked: 0,
			}],
			toolsTruncated: false,
			skills: [{
				name: "frontend-design",
				activations: 5,
				observedInWindow: true,
			}],
			skillsTruncated: false,
			recipes: [{ agentId: "researcher", runs: 4 }],
			recipesTruncated: false,
			opportunities: [
				{ kind: "workflow-distiller", count: 1 },
				{ kind: "recipe", count: 1 },
			],
		},
	});
	equal(event.payload.inspection.totals?.totalTokens, 13_922_000);
	equal(event.payload.inspection.totals?.costUsd, 4.125);
	equal(event.payload.inspection.models[0]?.model, "qwen3.8-27b");

	expectProtocolError(() =>
		serverEvent("usage.state", {
			inspection: {
				...event.payload.inspection,
				rawSuggestions: ["repeat the private prompt"],
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("usage.state", {
			inspection: {
				...event.payload.inspection,
				models: [{
					...event.payload.inspection.models[0],
					requestedModelIds: ["private-model"],
				}],
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("usage.state", {
			inspection: {
				...event.payload.inspection,
				stores: { ...event.payload.inspection.stores, sessions: "missing" },
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("usage.state", {
			inspection: {
				...event.payload.inspection,
				skills: [{
					name: "frontend-design",
					activations: 0,
					observedInWindow: true,
				}],
			},
		})
	);
});

Deno.test("routing events accept only bounded offline model and resolved profile facts", () => {
	const event = serverEvent("routing.state", {
		inspection: {
			inspectedAt: "2026-08-29T15:00:00.000Z",
			models: {
				availability: "available",
				items: [{
					targetId: "lmstudio",
					runtimeId: "openai-compatible",
					modelId: "qwen3.8-27b",
					capabilities: ["chat", "tools", "reasoning"],
					contextWindow: 262_144,
					maxOutputTokens: 32_768,
					residency: "loaded",
				}],
				truncated: false,
				emptyTargetCount: 0,
			},
			profiles: {
				availability: "available",
				items: [{
					name: "deep-research",
					target: "lmstudio",
					runtime: "openai-compatible",
					model: "qwen3.8-27b",
					thinkingLevel: "high",
				}],
				truncated: false,
			},
			bindings: {
				availability: "available",
				items: [{
					agentId: "researcher",
					profile: "deep-research",
					target: "lmstudio",
					model: "qwen3.8-27b",
					resolved: true,
				}],
				truncated: false,
			},
		},
	});
	equal(event.payload.inspection.models.items[0]?.contextWindow, 262_144);
	equal(event.payload.inspection.bindings.items[0]?.resolved, true);
	expectProtocolError(() =>
		serverEvent("routing.state", {
			inspection: {
				...event.payload.inspection,
				models: {
					...event.payload.inspection.models,
					items: [{
						...event.payload.inspection.models.items[0],
						baseUrl: "https://private.invalid",
					}],
				},
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("routing.state", {
			inspection: {
				...event.payload.inspection,
				bindings: {
					...event.payload.inspection.bindings,
					items: [{
						...event.payload.inspection.bindings.items[0],
						resolved: false,
					}],
				},
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("routing.state", {
			inspection: {
				...event.payload.inspection,
				models: {
					...event.payload.inspection.models,
					items: [{
						...event.payload.inspection.models.items[0],
						modelId: "file:///home/operator/private-model.gguf",
					}],
				},
			},
		})
	);
});

Deno.test("dispatch events are installation-wide aggregates with no project or raw row context", () => {
	const inspection = {
		scope: "installation",
		inspectedAt: "2026-08-30T14:02:00.000Z",
		generatedAt: "2026-08-30T14:01:28.728Z",
		admission: { state: "open", expiresAt: null },
		running: { total: 3, alive: 1, stale: 1, dead: 1, unreported: 0 },
		retryingCount: 0,
		totals: {
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 18,
			costUsd: 0.25,
			runtimeSeconds: 31.5,
		},
	};
	const event = serverEvent("dispatch.state", { inspection });
	equal(event.projectId, undefined);
	deepStrictEqual(event.payload.inspection.running, inspection.running);
	expectProtocolError(() =>
		serverEvent("dispatch.state", {
			inspection: {
				...inspection,
				running: { ...inspection.running, total: 4 },
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("dispatch.state", {
			inspection: { ...inspection, runId: "run-private" },
		})
	);
});

Deno.test("durable run inspection validates bounded journal and receipt trust facts", () => {
	const inspection = {
		scope: "installation",
		inspectedAt: "2026-08-31T14:02:00.000Z",
		generatedAt: "2026-08-31T14:01:28.728Z",
		runs: [{
			runId: "run-alpha",
			agentId: "builder",
			model: "qwen3-coder",
			target: "local-lmstudio",
			node: "local",
			phase: "running",
			startedAt: "2026-08-31T14:00:00.000Z",
			elapsedMs: 88_728,
			task: "Inspect durable work",
			journal: "available",
			events: [{
				at: "2026-08-31T14:00:01.000Z",
				label: "run opened",
				detail: null,
			}],
			eventsTruncated: false,
			evidence: { state: "pending", summary: "Receipt pending." },
			outcome: null,
			outcomeDetail: null,
			terminal: false,
		}],
		truncated: false,
		roots: [],
		rootsTruncated: false,
	};
	const event = serverEvent("fleet.inspection.state", { inspection });
	equal(event.projectId, undefined);
	equal(event.payload.inspection.runs[0]?.runId, "run-alpha");
	expectProtocolError(() =>
		serverEvent("fleet.inspection.state", {
			inspection: {
				...inspection,
				runs: [{ ...inspection.runs[0], receiptPath: "/private/receipt.json" }],
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("fleet.inspection.state", {
			inspection: {
				...inspection,
				runs: [...inspection.runs, inspection.runs[0]],
			},
		})
	);
});

Deno.test("the fleet root index validates step counts, attribution, and identity", () => {
	const root = {
		rootId: "fleet-345ea2e6c1ad",
		fleet: "build-review",
		startedAt: "2026-08-31T13:59:00.000Z",
		elapsedMs: 210_000,
		running: true,
		resumedFrom: null,
		plannedSteps: 2,
		recordedSteps: 1,
		steps: [
			{ stepId: "build", runId: "run-alpha", agentId: "builder", outcome: "succeeded", detail: null },
			{ stepId: "apply", runId: null, agentId: null, outcome: "not run", detail: null },
		],
		stepsTruncated: false,
	};
	const inspection = {
		scope: "installation",
		inspectedAt: "2026-08-31T14:02:00.000Z",
		generatedAt: "2026-08-31T14:01:28.728Z",
		runs: [],
		truncated: false,
		roots: [root],
		rootsTruncated: false,
	};
	const event = serverEvent("fleet.inspection.state", { inspection });
	equal(event.payload.inspection.roots[0]?.steps[1]?.runId, null);
	equal(event.payload.inspection.roots[0]?.fleet, "build-review");
	for (
		const broken of [
			// A durable fleet-run path is never a public fact.
			{ ...root, recordPath: "/private/fleet-runs/fleet-345ea2e6c1ad.json" },
			// A step that never ran cannot carry an agent.
			{ ...root, steps: [{ ...root.steps[1], agentId: "builder" }] },
			// More recorded than planned, and more indexed than planned.
			{ ...root, recordedSteps: 3 },
			{ ...root, plannedSteps: 1 },
			// One step id may not appear twice in one index.
			{ ...root, plannedSteps: 4, steps: [root.steps[0], root.steps[0]] },
		]
	) {
		expectProtocolError(() =>
			serverEvent("fleet.inspection.state", { inspection: { ...inspection, roots: [broken] } })
		);
	}
	expectProtocolError(() =>
		serverEvent("fleet.inspection.state", { inspection: { ...inspection, roots: [root, root] } })
	);
});

Deno.test("toolchain events retain version policy while rejecting native paths and contradictions", () => {
	const inspection = {
		scope: "installation",
		inspectedAt: "2026-08-31T15:02:00.000Z",
		tools: [{
			id: "herdr",
			pinnedVersion: "0.8.2",
			license: "Apache-2.0",
			platform: "linux-x64",
			supported: true,
			installed: true,
			source: "vendored",
			foundVersion: "0.8.2",
			minimumVersion: "0.8.2",
			pathCandidate: { version: "0.7.5", satisfiesMinimum: false },
		}],
		truncated: false,
	};
	const event = serverEvent("toolchain.state", { inspection });
	equal(event.projectId, undefined);
	equal(event.payload.inspection.tools[0]?.license, "Apache-2.0");
	expectProtocolError(() =>
		serverEvent("toolchain.state", {
			inspection: {
				...inspection,
				tools: [{ ...inspection.tools[0], binaryPath: "/private/herdr" }],
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("toolchain.state", {
			inspection: {
				...inspection,
				tools: [{ ...inspection.tools[0], source: "none" }],
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("toolchain.state", {
			inspection: { ...inspection, tools: [...inspection.tools, inspection.tools[0]] },
		})
	);
});

Deno.test("recovery events retain category counts while rejecting identities and contradictory health", () => {
	const inspection = {
		scope: "installation",
		projectContext: true,
		inspectedAt: "2026-08-30T15:00:00.000Z",
		healthy: false,
		pathsResolved: 4,
		versions: { clioCoder: "0.3.9", node: "v24.9.0", platform: "linux-x64" },
		summary: { checks: 3, passed: 1, warnings: 1, failures: 1 },
		sections: [
			{ id: "runtime", checks: 1, passed: 1, warnings: 0, failures: 0 },
			{ id: "models", checks: 2, passed: 0, warnings: 1, failures: 1 },
		],
		checks: [
			{ name: "platform", section: "runtime", level: "ok" },
			{ name: "target private-lab", section: "models", level: "warn" },
			{ name: null, section: "models", level: "error" },
		],
		checksTruncated: false,
	};
	const event = serverEvent("recovery.state", { inspection });
	equal(event.projectId, undefined);
	deepStrictEqual(event.payload.inspection.summary, inspection.summary);
	equal(event.payload.inspection.checks[1]?.name, "target private-lab");
	expectProtocolError(() =>
		serverEvent("recovery.state", {
			inspection: { ...inspection, healthy: true },
		})
	);
	expectProtocolError(() =>
		serverEvent("recovery.state", {
			inspection: {
				...inspection,
				healthy: true,
				summary: { checks: 0, passed: 0, warnings: 0, failures: 0 },
				sections: [],
				checks: [],
			},
		})
	);
	expectProtocolError(() =>
		serverEvent("recovery.state", {
			inspection: { ...inspection, targetId: "private-lab" },
		})
	);
	expectProtocolError(() =>
		serverEvent("recovery.state", {
			inspection: {
				...inspection,
				sections: [...inspection.sections, inspection.sections[0]],
			},
		})
	);
	for (
		const brokenChecks of [
			// A name carrying a native path, URL, or raw detail is not a name the
			// host should ever have emitted, so the browser refuses rather than
			// redacting on its behalf.
			[{ name: "settings at /private/settings.yaml", section: "runtime", level: "ok" }],
			[{ name: "runtime http://10.0.0.7:1234", section: "runtime", level: "ok" }],
			// One check short of the reported count.
			inspection.checks.slice(1),
			// The per-check verdicts have to agree with the section tallies.
			[
				{ name: "platform", section: "runtime", level: "ok" },
				{ name: "target private-lab", section: "models", level: "warn" },
				{ name: "model private-lab", section: "models", level: "warn" },
			],
		]
	) {
		expectProtocolError(() => serverEvent("recovery.state", { inspection: { ...inspection, checks: brokenChecks } }));
	}
});

Deno.test("command errors use the closed code set and stay hierarchical", () => {
	for (const code of COMMAND_ERROR_CODES) {
		const event = serverEvent("command.error", {
			code,
			message: "refused",
			requestId: "request-1",
		});
		equal(event.payload.code, code);
	}
	expectProtocolError(() => serverEvent("command.error", { code: "teapot", message: "refused" }));
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: PROTOCOL_VERSION,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-1",
			kind: "command.error",
			turnId: "turn-1",
			terminal: false,
			payload: { code: "invalid", message: "no session context" },
		})
	);
});

Deno.test("server envelopes reject old versions, unknown kinds, and oversized frames", () => {
	expectProtocolError(
		() =>
			validateServerEvent({
				protocolVersion: 2,
				workspaceInstanceId: "workspace-0001",
				sequence: 1,
				eventId: "event-1",
				kind: "connection.ready",
				terminal: false,
				payload: {},
			}),
		"unsupported-version",
	);
	for (
		const removed of [
			"engine.state",
			"turn.agent",
			"turn.change",
			"turn.evidence",
			"project.created",
		]
	) {
		ok(
			!(SERVER_EVENT_KINDS as readonly string[]).includes(removed),
			`${removed} must be gone`,
		);
	}
	const modest = serverEvent("turn.text", {
		text: "x".repeat(1_024),
		agents: [],
		source: "observed-on-acp",
	});
	deepStrictEqual(parseServerEvent(encodeServerEvent(modest)), modest);
	// Every field below is individually legal; only the assembled frame is too large.
	const inflated = serverEvent("project.opened", {
		workspace: wireWorkspace({
			timeline: Array.from({ length: 5 }, (_unused, index) => ({
				id: `turn-1:text:${index + 1}`,
				kind: "narrative",
				title: "Clio Coder",
				summary: "x".repeat(64 * 1024),
				status: "complete",
				turnId: "turn-1",
				origin: "live",
				startedAt: "2026-08-18T12:00:00.000Z",
				sequence: index + 1,
				source: "observed-on-acp",
			})),
		}),
	});
	ok(
		new TextEncoder().encode(JSON.stringify(inflated)).byteLength >
			MAX_SERVER_EVENT_BYTES,
	);
	expectProtocolError(() => encodeServerEvent(inflated), "frame-too-large");
});

Deno.test("the sequence guard accepts contiguous events and only the exact latest duplicate", () => {
	const guard = new ServerSequenceGuard();
	equal(guard.observe(serverEvent("connection.ready", {}, 1)), "accepted");
	equal(guard.observe(serverEvent("connection.ready", {}, 1)), "duplicate");
	equal(
		guard.observe(serverEvent("clio.state", { snapshot: clioSnapshot() }, 2)),
		"accepted",
	);
	equal(guard.nextSequence, 3);
	throws(
		() =>
			guard.observe(
				serverEvent("clio.state", { snapshot: clioSnapshot("running") }, 2),
			),
		ProtocolValidationError,
	);
	throws(
		() => guard.observe(serverEvent("connection.ready", {}, 9)),
		ProtocolValidationError,
	);
	throws(
		() =>
			guard.observe({
				...serverEvent("connection.ready", {}, 3),
				workspaceInstanceId: "workspace-0002",
			}),
		ProtocolValidationError,
	);
});

Deno.test("the browser transport is loopback-only", () => {
	equal(
		assertLocalWebSocketUrl("ws://127.0.0.1:8720/api/events"),
		"ws://127.0.0.1:8720/api/events",
	);
	for (
		const url of [
			"ws://example.com/api/events",
			"http://127.0.0.1/api/events",
			"ws://10.0.0.1/api/events",
		]
	) {
		throws(() => assertLocalWebSocketUrl(url));
	}
	match(WebSocketLocalTransport.name, /WebSocketLocalTransport/u);
});

Deno.test("trace accounting validates bounds and refuses rows from an unavailable database", () => {
	const phase = {
		name: "builder",
		kind: "agent",
		owner: "builder",
		status: "success",
		attempt: 1,
		retries: 0,
		failed: false,
		elapsedMs: 21_000,
		totalTokens: 20_120,
		totalCostUsd: 0.31,
	};
	const run = {
		runId: "run-alpha",
		agent: "builder",
		target: "local-lmstudio",
		model: "qwen3-coder",
		runtime: "lmstudio",
		node: null,
		status: "success",
		startedAt: "2026-08-31T14:00:00.000Z",
		elapsedMs: 30_000,
		totalTokens: 28_665,
		totalCostUsd: 0.4213,
		phases: [phase],
		phasesTruncated: false,
		events: {
			total: 4,
			firstAt: "2026-08-31T14:00:00.000Z",
			lastAt: "2026-08-31T14:00:29.000Z",
			kinds: [{ kind: "message_update", count: 3 }, { kind: "tool_call", count: 1 }],
			kindsTruncated: false,
		},
		processes: {
			total: 2,
			running: 1,
			kinds: [{ kind: "worker", total: 2, running: 1 }],
			kindsTruncated: false,
		},
	};
	const inspection = {
		scope: "installation",
		inspectedAt: "2026-08-31T14:02:00.000Z",
		generatedAt: "2026-08-31T14:01:30.000Z",
		available: true,
		runs: [run],
		truncated: false,
	};
	const event = serverEvent("trace.state", { inspection });
	equal(event.projectId, undefined);
	equal(event.payload.inspection.runs[0]?.phases[0]?.totalCostUsd, 0.31);
	// A cost is a fraction, so the amount validator must not demand an integer.
	equal(event.payload.inspection.runs[0]?.totalCostUsd, 0.4213);
	for (
		const broken of [
			// The request text and the phase error text are the two fields that must
			// never appear, so an unknown key is refused rather than ignored.
			{ ...inspection, runs: [{ ...run, request: "the prompt text" }] },
			{ ...inspection, runs: [{ ...run, phases: [{ ...phase, error: "boom" }] }] },
			{ ...inspection, runs: [run, run] },
			// A database that was never written cannot also have produced rows.
			{ ...inspection, available: false },
			{ ...inspection, available: false, runs: [], truncated: true },
			// Negative accounting is not a smaller number, it is a broken store.
			{ ...inspection, runs: [{ ...run, totalTokens: -1 }] },
			// Event and process shapes must account for themselves, and a half-open
			// span is a broken answer rather than a narrower one.
			{ ...inspection, runs: [{ ...run, events: { ...run.events, kinds: [{ kind: "log", count: 1 }] } }] },
			{ ...inspection, runs: [{ ...run, events: { ...run.events, lastAt: null } }] },
			{ ...inspection, runs: [{ ...run, processes: { ...run.processes, running: 9 } }] },
			// The row-level fields are the ones that must never appear.
			{ ...inspection, runs: [{ ...run, events: { ...run.events, payloads: ["{}"] } }] },
			{ ...inspection, runs: [{ ...run, processes: { ...run.processes, commands: ["/usr/bin/node"] } }] },
		]
	) {
		expectProtocolError(() => serverEvent("trace.state", { inspection: broken }));
	}
	// An unavailable database with nothing alongside it is the ordinary answer.
	const empty = serverEvent("trace.state", {
		inspection: { ...inspection, available: false, runs: [], truncated: false },
	});
	equal(empty.payload.inspection.available, false);
});

Deno.test("evidence inventory validates trust, tool counts, and identity without bundle contents", () => {
	const artifact = {
		evidenceId: "run-alpha-bundle",
		sourceKind: "run",
		generatedAt: "2026-08-31T14:00:40.000Z",
		startedAt: "2026-08-31T14:00:00.000Z",
		endedAt: "2026-08-31T14:00:30.000Z",
		runIds: ["run-alpha"],
		runIdsTruncated: false,
		agentIds: ["builder"],
		statuses: ["completed"],
		tags: ["audit-linked"],
		totals: {
			runs: 1,
			receipts: 1,
			toolCalls: 4,
			toolErrors: 1,
			blockedToolCalls: 1,
			protectedArtifacts: 0,
			tokens: 28_665,
			costUsd: 0.4213,
			wallTimeMs: 30_000,
		},
		redactionCount: 3,
		trust: { verdict: "compromised", runsCovered: 1, historical: false },
	};
	const inspection = {
		scope: "installation",
		inspectedAt: "2026-08-31T14:02:00.000Z",
		generatedAt: "2026-08-31T14:01:40.000Z",
		artifacts: [artifact],
		truncated: false,
	};
	const event = serverEvent("evidence.state", { inspection });
	equal(event.projectId, undefined);
	equal(event.payload.inspection.artifacts[0]?.trust.verdict, "compromised");
	// A cost is a fraction, so the amount check must not demand an integer.
	equal(event.payload.inspection.artifacts[0]?.totals.costUsd, 0.4213);
	for (
		const broken of [
			// The three fields a bundle carries that must never reach the browser.
			{ ...artifact, tasks: ["rewrite the loader"] },
			{ ...artifact, cwds: ["/private/code"] },
			{ ...artifact, files: ["transcript.md"] },
			// A historical bundle has no canonical runs and no verdict of its own.
			{ ...artifact, trust: { verdict: "grounded", runsCovered: 0, historical: true } },
			{ ...artifact, trust: { verdict: "unknown", runsCovered: 2, historical: true } },
			// A failed call is a subset of the calls that were attempted.
			{ ...artifact, totals: { ...artifact.totals, toolErrors: 9 } },
			// A run may appear once in one bundle's index.
			{ ...artifact, runIds: ["run-alpha", "run-alpha"] },
			// The verdict vocabulary is closed.
			{ ...artifact, trust: { verdict: "probably-fine", runsCovered: 1, historical: false } },
		]
	) {
		expectProtocolError(() => serverEvent("evidence.state", { inspection: { ...inspection, artifacts: [broken] } }));
	}
	expectProtocolError(() =>
		serverEvent("evidence.state", { inspection: { ...inspection, artifacts: [artifact, artifact] } })
	);
});

Deno.test("an artifact reference is an identifier, never a path, a flag, or a traversal", () => {
	deepStrictEqual(
		parseCommand("evidence.read", { evidenceId: "run-alpha-bundle" }).payload,
		{ evidenceId: "run-alpha-bundle" },
	);
	for (
		const hostile of [
			"../../etc/passwd",
			"run/../other",
			"run..alpha",
			"/absolute/run",
			"--force",
			"run alpha",
			"",
			"a".repeat(129),
			42,
			null,
		]
	) {
		expectProtocolError(() => parseCommand("evidence.read", { evidenceId: hostile }));
	}
	// The frame carries the reference and nothing else: no path, no depth, no
	// alternate store to read it from.
	expectProtocolError(() => parseCommand("evidence.read", {}));
	expectProtocolError(() => parseCommand("evidence.read", { evidenceId: "run-alpha", dataDir: "/private" }));
});

Deno.test("an evidence trust record validates every axis against its own state set", () => {
	const axes = {
		artifactIntegrity: "verified",
		validationGrounding: "failed",
		independentReview: "absent",
		contextProvenance: "recorded",
		autonomyEnforcement: "enforced",
		completionEvidence: "absent",
	};
	const detail = {
		evidenceId: "run-alpha-bundle",
		sourceKind: "run",
		inspectedAt: "2026-08-31T14:03:00.000Z",
		generatedAt: "2026-08-31T14:00:40.000Z",
		canonical: true,
		runs: [{ runId: "run-alpha", verdict: "compromised", axes }],
		runsTruncated: false,
	};
	const event = serverEvent("evidence.detail.state", { detail });
	equal(event.projectId, undefined);
	equal(event.payload.detail.runs[0]?.axes.validationGrounding, "failed");
	for (
		const broken of [
			// `validated` is a validationGrounding state and not a contextProvenance one.
			{
				...detail,
				runs: [{ runId: "run-alpha", verdict: "compromised", axes: { ...axes, contextProvenance: "validated" } }],
			},
			// Every axis is always reported.
			{ ...detail, runs: [{ runId: "run-alpha", verdict: "compromised", axes: { artifactIntegrity: "verified" } }] },
			// A non-canonical bundle has no axes to report.
			{ ...detail, canonical: false },
			{ ...detail, runs: [detail.runs[0], detail.runs[0]] },
			// Nothing from the bundle's prose surfaces belongs on this record.
			{ ...detail, transcript: "the model said" },
		]
	) {
		expectProtocolError(() => serverEvent("evidence.detail.state", { detail: broken }));
	}
});

Deno.test("a receipt verification states what it checked and cannot contradict itself", () => {
	const axes = {
		artifactIntegrity: "failed",
		validationGrounding: "absent",
		independentReview: "absent",
		contextProvenance: "absent",
		autonomyEnforcement: "absent",
		completionEvidence: "absent",
	};
	const verification = {
		runId: "run-alpha",
		verifiedAt: "2026-08-31T14:05:00.000Z",
		state: "failed",
		reason: "ledger-mismatch",
		axes,
	};
	const event = serverEvent("fleet.verification.state", { verification });
	equal(event.projectId, undefined);
	equal(event.payload.verification.reason, "ledger-mismatch");

	// A run that has not sealed yet has nothing to give a reason about.
	const pending = serverEvent("fleet.verification.state", {
		verification: { ...verification, state: "pending", reason: null, axes: { ...axes, artifactIntegrity: "absent" } },
	});
	equal(pending.payload.verification.reason, null);

	for (
		const broken of [
			// A verdict without a reason, and a reason without a verdict.
			{ ...verification, reason: null },
			{ ...verification, state: "verified", reason: "ledger-mismatch" },
			// The two states meaning "nothing readable to check" are exactly the two
			// reasons that say so.
			{ ...verification, state: "unavailable", reason: "ledger-mismatch" },
			{ ...verification, reason: "receipt-unreadable" },
			// A receipt that authenticated cannot report its integrity as failed.
			{ ...verification, state: "verified", reason: null },
			// The reason vocabulary is closed, and so is each axis.
			{ ...verification, reason: "it looked wrong" },
			{ ...verification, axes: { ...axes, contextProvenance: "validated" } },
			// Nothing from the receipt itself belongs on this record.
			{ ...verification, receiptPath: "/private/receipts/run-alpha.json" },
		]
	) {
		expectProtocolError(() => serverEvent("fleet.verification.state", { verification: broken }));
	}
});
