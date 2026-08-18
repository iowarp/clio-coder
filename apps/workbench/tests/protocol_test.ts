import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import {
	assertLocalWebSocketUrl,
	CLIENT_COMMAND_KINDS,
	type ClientCommand,
	encodeClientCommand,
	encodeServerEvent,
	ENGINE_KINDS,
	ENGINE_PHASES,
	ENGINE_SOURCES,
	FAKE_SCENARIOS,
	MAX_CLIENT_FRAME_BYTES,
	MAX_SERVER_EVENT_BYTES,
	parseClientCommand,
	parseServerEvent,
	PERMISSION_DECISIONS,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type ProtocolValidationErrorCode,
	READINESS_KEYS,
	SERVER_EVENT_KINDS,
	type ServerEvent,
	ServerSequenceGuard,
	validateClientCommand,
	validateServerEvent,
	WebSocketLocalTransport,
} from "../src/protocol.ts";

function clientFrame(kind: string, payload: unknown, requestId = "request-0001"): string {
	return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId, kind, payload });
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
	throw new Error("Expected ProtocolValidationError with code " + code);
}

function connectionEvent(
	sequence: number,
	overrides: Partial<{
		workspaceInstanceId: string;
		eventId: string;
		terminal: boolean;
	}> = {},
): ServerEvent {
	return validateServerEvent({
		protocolVersion: PROTOCOL_VERSION,
		workspaceInstanceId: overrides.workspaceInstanceId ?? "workspace-0001",
		sequence,
		eventId: overrides.eventId ?? "event-" + sequence,
		kind: "connection.ready",
		terminal: overrides.terminal ?? false,
		payload: {},
	});
}

function engineFacts() {
	return READINESS_KEYS.map((key) => ({
		key,
		label: key === "authentication" ? "Authentication" : key[0]?.toUpperCase() + key.slice(1),
		state: key === "runtime" || key === "protocol" || key === "project" ? "ready" : "unavailable",
		detail: key === "runtime" ? "Clio 0.3.2" : "Bounded readiness fact",
		source: "observed-by-workbench",
	}));
}

function engineSnapshot(kind: "fake" | "clio-acp" = "fake", phase: string = "ready") {
	return {
		kind,
		phase,
		facts: engineFacts(),
		checkedAt: "2026-08-17T12:00:00.000Z",
	};
}

function wireWorkspace() {
	return {
		project: {
			id: "project-alpha",
			displayName: "Alpha",
			identity: { kind: "local-sandbox", displayPath: "Controlled sandbox / alpha" },
			lastOpenedAt: "2026-08-17T12:00:00.000Z",
		},
		tree: [
			{
				name: "src",
				path: { segments: ["src"] },
				kind: "directory",
				operable: true,
				children: [],
			},
		],
		treeTruncated: false,
		sessions: [],
		selectedSessionId: null,
		timeline: [],
		engine: engineSnapshot(),
		pendingPermission: null,
		deleteChallenge: null,
		agents: [],
		changes: [],
		evidence: [],
		engineGeneration: null,
		activeTurnId: null,
		lastSequence: 0,
	};
}

function turnEvent(kind: string, payload: unknown, sequence = 1): ServerEvent {
	return validateServerEvent({
		protocolVersion: PROTOCOL_VERSION,
		workspaceInstanceId: "workspace-0001",
		sequence,
		eventId: "event-turn-" + sequence,
		kind,
		projectId: "project-alpha",
		engineGeneration: "generation-public-001",
		sessionId: "session-public-001",
		turnId: "turn-001",
		terminal: kind === "turn.terminal",
		payload,
	});
}

Deno.test("protocol v2 command family is a hard cut with no demo or preview aliases", () => {
	equal(PROTOCOL_VERSION, 2);
	deepStrictEqual(CLIENT_COMMAND_KINDS, [
		"project.create",
		"project.register",
		"project.select",
		"fs.refresh",
		"fs.create-file",
		"fs.create-folder",
		"fs.move",
		"fs.delete.prepare",
		"fs.delete.confirm",
		"engine.select",
		"engine.probe",
		"turn.start",
		"turn.cancel",
		"permission.resolve",
	]);
	for (const oldKind of ["demo.start", "demo.cancel", "approval.resolve", "readiness.preview"]) {
		expectProtocolError(() => parseCommand(oldKind, {}));
	}
	expectProtocolError(
		() =>
			parseClientCommand(JSON.stringify({
				protocolVersion: 1,
				requestId: "request-001",
				kind: "project.select",
				payload: { projectId: "project-alpha" },
			})),
		"unsupported-version",
	);
});

Deno.test("v2 validates engine selection and explicit readiness probes exactly", () => {
	for (const kind of ENGINE_KINDS) {
		deepStrictEqual(parseCommand("engine.select", { projectId: "project-alpha", kind }).payload, {
			projectId: "project-alpha",
			kind,
		});
	}
	deepStrictEqual(parseCommand("engine.probe", { projectId: "project-alpha" }).payload, {
		projectId: "project-alpha",
	});
	expectProtocolError(() => parseCommand("engine.select", { projectId: "project-alpha", kind: "shell" }));
	expectProtocolError(() =>
		parseCommand("engine.select", {
			projectId: "project-alpha",
			kind: "clio-acp",
			executable: "/usr/bin/clio-coder",
		})
	);
	expectProtocolError(() =>
		parseCommand("engine.probe", {
			projectId: "project-alpha",
			target: "remote-provider",
		})
	);
});

Deno.test("v2 validates neutral turn and one-use permission commands", () => {
	for (const fakeScenario of FAKE_SCENARIOS) {
		deepStrictEqual(
			parseCommand("turn.start", {
				projectId: "project-alpha",
				prompt: "Inspect the bounded project",
				fakeScenario,
			}).payload,
			{ projectId: "project-alpha", prompt: "Inspect the bounded project", fakeScenario },
		);
	}
	deepStrictEqual(
		parseCommand("turn.start", { projectId: "project-alpha", prompt: "Use the selected engine" }).payload,
		{ projectId: "project-alpha", prompt: "Use the selected engine" },
	);
	deepStrictEqual(parseCommand("turn.cancel", { projectId: "project-alpha", turnId: "turn-001" }).payload, {
		projectId: "project-alpha",
		turnId: "turn-001",
	});
	for (const decision of PERMISSION_DECISIONS) {
		const parsed = parseCommand("permission.resolve", {
			projectId: "project-alpha",
			turnId: "turn-001",
			permissionId: "permission-001",
			decision,
		});
		equal(parsed.kind, "permission.resolve");
		equal(parsed.payload.decision, decision);
	}

	expectProtocolError(() => parseCommand("turn.start", { projectId: "project-alpha", prompt: "" }));
	expectProtocolError(() => parseCommand("turn.start", { projectId: "project-alpha", prompt: " padded " }));
	expectProtocolError(() => parseCommand("turn.start", { projectId: "project-alpha", prompt: "\0unsafe" }));
	expectProtocolError(() =>
		parseCommand("turn.start", {
			projectId: "project-alpha",
			prompt: "Run",
			fakeScenario: "cancel",
		})
	);
	expectProtocolError(() =>
		parseCommand("permission.resolve", {
			projectId: "project-alpha",
			turnId: "turn-001",
			permissionId: "permission-001",
			decision: "allow-always",
		})
	);
	expectProtocolError(() =>
		parseCommand("permission.resolve", {
			projectId: "project-alpha",
			turnId: "turn-001",
			permissionId: "permission-001",
			decision: "allow-once",
			scope: "workspace",
		})
	);
});

Deno.test("v2 preserves strict project registration, selection, and bounded creation", () => {
	deepStrictEqual(
		parseCommand("project.create", { displayName: "Numerics / Study", directoryName: "numerics-study" }).payload,
		{ displayName: "Numerics / Study", directoryName: "numerics-study" },
	);
	deepStrictEqual(
		parseCommand("project.register", { relativeRoot: ["existing", "solver"], displayName: "Existing solver" })
			.payload,
		{ relativeRoot: ["existing", "solver"], displayName: "Existing solver" },
	);
	deepStrictEqual(parseCommand("project.select", { projectId: "project-alpha" }).payload, {
		projectId: "project-alpha",
	});

	expectProtocolError(() => parseCommand("project.create", { displayName: "Unsafe", directoryName: "../outside" }));
	expectProtocolError(() => parseCommand("project.register", { relativeRoot: "/tmp/project" }));
	expectProtocolError(() => parseCommand("project.register", { relativeRoot: [] }));
	expectProtocolError(() => parseCommand("project.register", { relativeRoot: ["existing"], writable: true }));
	expectProtocolError(() =>
		parseCommand("project.select", { projectId: "project-alpha", trustedRoot: "/tmp/project" })
	);
});

Deno.test("v2 preserves strict refresh, create, move, and two-step delete DTOs", () => {
	deepStrictEqual(parseCommand("fs.refresh", { projectId: "project-alpha", directory: [] }).payload, {
		projectId: "project-alpha",
		directory: [],
	});
	for (const kind of ["fs.create-file", "fs.create-folder"] as const) {
		deepStrictEqual(parseCommand(kind, { projectId: "project-alpha", parent: ["src"], name: "model.ts" }).payload, {
			projectId: "project-alpha",
			parent: ["src"],
			name: "model.ts",
		});
	}
	deepStrictEqual(
		parseCommand("fs.move", {
			projectId: "project-alpha",
			source: ["src", "old.ts"],
			destination: { parent: ["src", "core"], name: "new.ts" },
			expectedNodeVersion: "5ac9e0219a20f0b1",
		}).payload,
		{
			projectId: "project-alpha",
			source: ["src", "old.ts"],
			destination: { parent: ["src", "core"], name: "new.ts" },
			expectedNodeVersion: "5ac9e0219a20f0b1",
		},
	);
	deepStrictEqual(
		parseCommand("fs.delete.prepare", {
			projectId: "project-alpha",
			target: ["tmp", "result.txt"],
			expectedNodeVersion: "opaque version token",
		}).payload,
		{
			projectId: "project-alpha",
			target: ["tmp", "result.txt"],
			expectedNodeVersion: "opaque version token",
		},
	);
	deepStrictEqual(
		parseCommand("fs.delete.confirm", { projectId: "project-alpha", confirmationId: "confirmation-001" }).payload,
		{ projectId: "project-alpha", confirmationId: "confirmation-001" },
	);

	expectProtocolError(() => parseCommand("fs.refresh", { projectId: "project-alpha", directory: "src" }));
	expectProtocolError(() =>
		parseCommand("fs.create-file", {
			projectId: "project-alpha",
			parent: ["src"],
			name: "model.ts",
			contents: "ambient write data",
		})
	);
	expectProtocolError(() =>
		parseCommand("fs.move", {
			projectId: "project-alpha",
			source: ["old.ts"],
			destination: ["new.ts"],
		})
	);
	expectProtocolError(() =>
		parseCommand("fs.move", {
			projectId: "project-alpha",
			source: ["old.ts"],
			destination: { parent: [], name: "new.ts" },
			overwrite: true,
		})
	);
	expectProtocolError(() =>
		parseCommand("fs.delete.prepare", { projectId: "project-alpha", target: ["tmp"], recursive: true })
	);
	expectProtocolError(() =>
		parseCommand("fs.delete.confirm", {
			projectId: "project-alpha",
			confirmationId: "confirmation-001",
			target: ["tmp"],
		})
	);
});

Deno.test("all v2 command kinds round-trip and the command list stays exhaustive", () => {
	const commands = [
		parseCommand("project.create", { displayName: "Alpha", directoryName: "alpha" }),
		parseCommand("project.register", { relativeRoot: ["alpha"] }),
		parseCommand("project.select", { projectId: "project-alpha" }),
		parseCommand("fs.refresh", { projectId: "project-alpha", directory: [] }),
		parseCommand("fs.create-file", { projectId: "project-alpha", parent: [], name: "new.txt" }),
		parseCommand("fs.create-folder", { projectId: "project-alpha", parent: [], name: "new" }),
		parseCommand("fs.move", {
			projectId: "project-alpha",
			source: ["old"],
			destination: { parent: [], name: "new" },
		}),
		parseCommand("fs.delete.prepare", { projectId: "project-alpha", target: ["old"] }),
		parseCommand("fs.delete.confirm", { projectId: "project-alpha", confirmationId: "confirmation-001" }),
		parseCommand("engine.select", { projectId: "project-alpha", kind: "fake" }),
		parseCommand("engine.probe", { projectId: "project-alpha" }),
		parseCommand("turn.start", { projectId: "project-alpha", prompt: "Inspect the project" }),
		parseCommand("turn.cancel", { projectId: "project-alpha", turnId: "turn-001" }),
		parseCommand("permission.resolve", {
			projectId: "project-alpha",
			turnId: "turn-001",
			permissionId: "permission-001",
			decision: "reject",
		}),
	];

	deepStrictEqual(commands.map((command) => command.kind), [...CLIENT_COMMAND_KINDS]);
	for (const command of commands) deepStrictEqual(parseClientCommand(encodeClientCommand(command)), command);
});

Deno.test("client frames reject malformed, inherited, unknown, invalid, and oversized input", () => {
	expectProtocolError(() => parseClientCommand("{"), "invalid-frame");
	expectProtocolError(() => parseClientCommand(" ".repeat(MAX_CLIENT_FRAME_BYTES + 1)), "frame-too-large");
	expectProtocolError(() => parseCommand("unknown.command", {}));
	expectProtocolError(() => parseCommand("project.create", null));
	expectProtocolError(() => parseCommand("project.create", { displayName: "Alpha" }));
	expectProtocolError(() => parseCommand("turn.cancel", { projectId: "bad id", turnId: "turn-001" }));
	expectProtocolError(() =>
		parseClientCommand(
			JSON.stringify({
				protocolVersion: 2,
				requestId: "request-001",
				kind: "project.create",
				payload: { displayName: "Alpha", directoryName: "alpha" },
				ambientAuthority: true,
			}),
		)
	);
	expectProtocolError(() =>
		validateClientCommand({
			protocolVersion: 2,
			requestId: "request-001",
			kind: "project.create",
			payload: Object.assign(Object.create({ inherited: true }), {
				displayName: "Alpha",
				directoryName: "alpha",
			}),
		})
	);
});

Deno.test("engine snapshots use closed kinds, phases, sources, and one bounded fact per key", () => {
	for (const kind of ENGINE_KINDS) {
		for (const phase of ENGINE_PHASES) {
			const event = validateServerEvent({
				protocolVersion: PROTOCOL_VERSION,
				workspaceInstanceId: "workspace-0001",
				sequence: 1,
				eventId: "event-engine",
				kind: "engine.state",
				projectId: "project-alpha",
				terminal: false,
				payload: { snapshot: engineSnapshot(kind, phase) },
			});
			equal(event.kind, "engine.state");
		}
	}
	for (const source of ENGINE_SOURCES) {
		const snapshot = engineSnapshot();
		snapshot.facts[0] = { ...snapshot.facts[0]!, source };
		validateServerEvent({
			protocolVersion: PROTOCOL_VERSION,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-source",
			kind: "engine.state",
			projectId: "project-alpha",
			terminal: false,
			payload: { snapshot },
		});
	}

	const missing = engineSnapshot();
	missing.facts = missing.facts.slice(1);
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: 2,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-missing-fact",
			kind: "engine.state",
			projectId: "project-alpha",
			terminal: false,
			payload: { snapshot: missing },
		})
	);
	const duplicate = engineSnapshot();
	duplicate.facts[1] = { ...duplicate.facts[1]!, key: duplicate.facts[0]!.key };
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: 2,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-duplicate-fact",
			kind: "engine.state",
			projectId: "project-alpha",
			terminal: false,
			payload: { snapshot: duplicate },
		})
	);
	for (
		const snapshot of [
			{ ...engineSnapshot(), kind: "shell" },
			{ ...engineSnapshot(), phase: "installing" },
			{
				...engineSnapshot(),
				facts: [{ ...engineFacts()[0], source: "claimed-by-provider" }, ...engineFacts().slice(1)],
			},
			{ ...engineSnapshot(), generation: "private-generation" },
		]
	) {
		expectProtocolError(() =>
			validateServerEvent({
				protocolVersion: 2,
				workspaceInstanceId: "workspace-0001",
				sequence: 1,
				eventId: "event-bad-engine",
				kind: "engine.state",
				projectId: "project-alpha",
				terminal: false,
				payload: { snapshot },
			})
		);
	}
});

Deno.test("neutral v2 turn event family round-trips strict safe payloads", () => {
	const payloads = {
		"turn.started": {
			promptSummary: "Inspect the bounded project",
			fakeScenario: "complete",
			source: "simulated-by-workbench",
		},
		"turn.text": { text: "Clio narrative\ncontinues", source: "observed-on-acp" },
		"turn.thought": { text: "Checking the exact boundary", source: "observed-on-acp" },
		"turn.agent": {
			agentId: "agent-001",
			name: "Evidence scout",
			task: "Review the numerical boundary",
			status: "active",
			summary: "Review in progress",
			source: "reported-by-clio",
		},
		"turn.tool": {
			toolCallId: "tool-public-001",
			title: "Read project file",
			kind: "read",
			status: "completed",
			summary: "Read completed",
			locations: [{ segments: ["src", "model.ts"] }],
			source: "observed-on-acp",
		},
		"turn.change": {
			path: { segments: ["src", "model.ts"] },
			summary: "Clio reported a bounded change",
			source: "reported-by-clio",
		},
		"turn.permission.requested": {
			permissionId: "permission-public-001",
			toolCallId: "tool-public-002",
			title: "Update project file",
			kind: "edit",
			locations: [{ segments: ["src", "model.ts"] }],
			expiresAt: "2026-08-17T12:05:00.000Z",
			source: "observed-on-acp",
		},
		"turn.permission.resolved": {
			permissionId: "permission-public-001",
			decision: "allow-once",
			source: "observed-by-workbench",
		},
		"turn.evidence": {
			label: "Focused test",
			detail: "1 test passed",
			status: "observed",
			source: "observed-by-workbench",
		},
		"turn.terminal": {
			outcome: "completed",
			code: "turn-complete",
			summary: "The turn completed.",
			stopReason: "end_turn",
			usage: { input: 7, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1 },
			source: "reported-by-clio",
		},
	} as const;

	deepStrictEqual(
		SERVER_EVENT_KINDS.filter((kind) => kind.startsWith("turn.")),
		Object.keys(payloads),
	);
	for (const [index, [kind, payload]] of Object.entries(payloads).entries()) {
		const event = turnEvent(kind, payload, index + 1);
		deepStrictEqual(parseServerEvent(encodeServerEvent(event)), event);
	}
});

Deno.test("turn contexts expose exactly public project/session/turn IDs and no authority fields", () => {
	const started = turnEvent("turn.started", {
		promptSummary: "Inspect project",
		source: "observed-on-acp",
	});
	equal(started.projectId, "project-alpha");
	equal(started.sessionId, "session-public-001");
	equal(started.turnId, "turn-001");

	equal(started.engineGeneration, "generation-public-001");

	for (
		const forbidden of [
			{ generation: "generation-private" },
			{ trustedRoot: "/home/private/project" },
			{ pid: 1234 },
			{ rawSessionId: "acp-session-private" },
			{ acpSessionId: "acp-session-private" },
		]
	) {
		expectProtocolError(() =>
			validateServerEvent({
				protocolVersion: 2,
				workspaceInstanceId: "workspace-0001",
				sequence: 1,
				eventId: "event-authority",
				kind: "turn.started",
				projectId: "project-alpha",
				sessionId: "session-public-001",
				turnId: "turn-001",
				terminal: false,
				payload: { promptSummary: "Inspect project", source: "observed-on-acp" },
				...forbidden,
			})
		);
	}
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: 2,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-missing-session",
			kind: "turn.text",
			projectId: "project-alpha",
			turnId: "turn-001",
			terminal: false,
			payload: { text: "chunk", source: "observed-on-acp" },
		})
	);
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: 2,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-engine-context",
			kind: "engine.state",
			projectId: "project-alpha",
			sessionId: "session-public-001",
			terminal: false,
			payload: { snapshot: engineSnapshot() },
		})
	);
});

Deno.test("tool, permission, workspace changes, and change events accept only project-path DTOs", () => {
	const tool = {
		toolCallId: "tool-public-001",
		title: "Read file",
		kind: "read",
		status: "completed",
		summary: "Read complete",
		locations: [{ segments: ["src", "model.ts"] }],
		source: "observed-on-acp",
	};
	turnEvent("turn.tool", tool);
	turnEvent("turn.permission.requested", {
		permissionId: "permission-public-001",
		toolCallId: "tool-public-001",
		title: "Edit file",
		kind: "edit",
		locations: [{ segments: ["src", "model.ts"] }],
		expiresAt: "2026-08-17T12:05:00.000Z",
		source: "observed-on-acp",
	});
	turnEvent("turn.change", {
		path: { segments: ["src", "model.ts"] },
		summary: "Reported change",
		source: "reported-by-clio",
	});

	for (
		const badLocations of [
			["src/model.ts"],
			[{ segments: ["/tmp/model.ts"] }],
			[{ segments: ["..", "model.ts"] }],
			[{ segments: [] }],
		]
	) {
		expectProtocolError(() => turnEvent("turn.tool", { ...tool, locations: badLocations }));
	}
	expectProtocolError(() =>
		turnEvent("turn.change", {
			path: "src/model.ts",
			summary: "Reported change",
			source: "reported-by-clio",
		})
	);
	expectProtocolError(() =>
		turnEvent("turn.permission.requested", {
			permissionId: "permission-public-001",
			toolCallId: "tool-public-001",
			title: "Edit file",
			kind: "edit",
			locations: ["/tmp/model.ts"],
			expiresAt: "2026-08-17T12:05:00.000Z",
			source: "observed-on-acp",
		})
	);

	const workspace = {
		...wireWorkspace(),
		changes: [{
			id: "change-001",
			path: "src/model.ts",
			summary: "Legacy raw path",
			status: "recorded",
			source: "reported-by-clio",
		}],
	};
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: 2,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-workspace-path",
			kind: "project.created",
			projectId: "project-alpha",
			terminal: false,
			payload: { workspace },
		})
	);
});

Deno.test("turn payloads reject raw ACP data, request IDs, private IDs, and ambient fields", () => {
	const safeTool = {
		toolCallId: "tool-public-001",
		title: "Read file",
		kind: "read",
		status: "completed",
		summary: "Read complete",
		locations: [],
		source: "observed-on-acp",
	};
	for (
		const forbidden of [
			{ rawInput: { command: "print secret" } },
			{ rawOutput: "secret output" },
			{ content: [{ type: "content", content: { type: "text", text: "raw" } }] },
			{ requestId: "json-rpc-id" },
			{ rawToolCallId: "tool-private" },
		]
	) {
		expectProtocolError(() => turnEvent("turn.tool", { ...safeTool, ...forbidden }));
	}
	expectProtocolError(() =>
		turnEvent("turn.permission.requested", {
			permissionId: "permission-public-001",
			toolCallId: "tool-public-001",
			title: "Edit file",
			kind: "edit",
			locations: [],
			expiresAt: "2026-08-17T12:05:00.000Z",
			source: "observed-on-acp",
			optionId: "raw-option-id",
		})
	);
});

Deno.test("terminal events alone are terminal and usage is exact nonnegative integer data", () => {
	const terminal = turnEvent("turn.terminal", {
		outcome: "completed",
		code: "turn-complete",
		summary: "The turn completed.",
		stopReason: "end_turn",
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
		source: "reported-by-clio",
	});
	equal(terminal.terminal, true);
	const protocolError = validateServerEvent({
		protocolVersion: 2,
		workspaceInstanceId: "workspace-0001",
		sequence: 2,
		eventId: "event-protocol-error",
		kind: "protocol.error",
		terminal: true,
		payload: { code: "invalid-frame", message: "The frame was invalid." },
	});
	equal(protocolError.terminal, true);

	expectProtocolError(() => connectionEvent(1, { terminal: true }));
	expectProtocolError(() =>
		validateServerEvent({
			...terminal,
			eventId: "event-terminal-false",
			terminal: false,
		})
	);
	for (
		const usage of [
			{ input: -1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
			{ input: 1.5, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
			{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
			{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, total: 15 },
		]
	) {
		expectProtocolError(() =>
			turnEvent("turn.terminal", {
				outcome: "completed",
				code: "turn-complete",
				summary: "The turn completed.",
				usage,
				source: "reported-by-clio",
			})
		);
	}
	expectProtocolError(() =>
		turnEvent("turn.terminal", {
			outcome: "success",
			code: "turn-complete",
			summary: "The turn completed.",
			source: "reported-by-clio",
		})
	);
	expectProtocolError(() =>
		turnEvent("turn.terminal", {
			outcome: "completed",
			code: "turn-complete",
			summary: "The turn completed.",
			stopReason: "tool_use",
			source: "reported-by-clio",
		})
	);
});

Deno.test("project, filesystem, workspace, and error event payload unions remain strict", () => {
	const base = {
		protocolVersion: 2,
		workspaceInstanceId: "workspace-0001",
		projectId: "project-alpha",
		terminal: false,
	} as const;
	const events = [
		{
			...base,
			sequence: 1,
			eventId: "event-created",
			kind: "project.created",
			payload: { workspace: wireWorkspace() },
		},
		{
			...base,
			sequence: 2,
			eventId: "event-selected",
			kind: "project.selected",
			payload: {},
		},
		{
			...base,
			sequence: 3,
			eventId: "event-fs",
			kind: "fs.changed",
			payload: { tree: wireWorkspace().tree, treeTruncated: false },
		},
		{
			...base,
			sequence: 4,
			eventId: "event-delete",
			kind: "fs.delete.challenge",
			payload: {
				confirmationId: "confirmation-001",
				target: { segments: ["src", "old.ts"] },
				displayPath: "src/old.ts",
				targetKind: "file",
				expiresAt: "2026-08-17T12:01:00.000Z",
			},
		},
	] as const;
	for (const event of events) deepStrictEqual(parseServerEvent(encodeServerEvent(validateServerEvent(event))), event);

	const commandError = validateServerEvent({
		protocolVersion: 2,
		workspaceInstanceId: "workspace-0001",
		sequence: 5,
		eventId: "event-command-error",
		kind: "command.error",
		projectId: "project-alpha",
		terminal: false,
		payload: { code: "conflict", message: "The node version changed.", requestId: "request-0001" },
	});
	equal(commandError.kind, "command.error");

	const legacyWorkspace = wireWorkspace();
	Object.assign(legacyWorkspace.project, { readiness: "ready" });
	expectProtocolError(() =>
		validateServerEvent({
			...events[0],
			eventId: "event-legacy-workspace",
			payload: { workspace: legacyWorkspace },
		})
	);
	expectProtocolError(() =>
		validateServerEvent({
			...events[1],
			eventId: "event-selected-extra",
			payload: { trustedRoot: "/tmp/project" },
		})
	);
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: 2,
			workspaceInstanceId: "workspace-0001",
			sequence: 6,
			eventId: "event-error-unsanitized",
			kind: "command.error",
			terminal: false,
			payload: { code: "invalid", message: "bad\nterminal injection" },
		})
	);
});

Deno.test("server envelopes reject v1, invalid contexts, invalid records, and unknown kinds", () => {
	deepStrictEqual(parseServerEvent(encodeServerEvent(connectionEvent(1))), connectionEvent(1));
	expectProtocolError(
		() =>
			validateServerEvent({
				protocolVersion: 1,
				workspaceInstanceId: "workspace-0001",
				sequence: 1,
				eventId: "event-v1",
				kind: "connection.ready",
				terminal: false,
				payload: {},
			}),
		"unsupported-version",
	);
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: 2,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-array",
			kind: "connection.ready",
			terminal: false,
			payload: [],
		})
	);
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: 2,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-project",
			kind: "project.snapshot",
			terminal: false,
			payload: {},
		})
	);
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: 2,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-unknown",
			kind: "ambient.event",
			terminal: false,
			payload: {},
		})
	);
	const unsafePayload = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
	expectProtocolError(() =>
		validateServerEvent({
			protocolVersion: 2,
			workspaceInstanceId: "workspace-0001",
			sequence: 1,
			eventId: "event-unsafe",
			kind: "connection.ready",
			terminal: false,
			payload: unsafePayload,
		})
	);
});

Deno.test("server and client frame parsing enforce malformed and byte bounds before validation", () => {
	expectProtocolError(() => parseClientCommand("not-json"), "invalid-frame");
	expectProtocolError(() => parseClientCommand(" ".repeat(MAX_CLIENT_FRAME_BYTES + 1)), "frame-too-large");
	expectProtocolError(() => parseServerEvent("not-json"), "invalid-frame");
	expectProtocolError(() => parseServerEvent(" ".repeat(MAX_SERVER_EVENT_BYTES + 1)), "frame-too-large");

	const oversized = JSON.stringify({
		protocolVersion: 2,
		workspaceInstanceId: "workspace-0001",
		sequence: 1,
		eventId: "event-large",
		kind: "connection.ready",
		terminal: false,
		payload: { text: "x".repeat(MAX_SERVER_EVENT_BYTES) },
	});
	ok(new TextEncoder().encode(oversized).byteLength > MAX_SERVER_EVENT_BYTES);
	expectProtocolError(() => parseServerEvent(oversized), "frame-too-large");
});

Deno.test("sequence guard accepts contiguous events and ignores only the exact latest duplicate", () => {
	const first = connectionEvent(1);
	const exactDuplicate = connectionEvent(1);
	const second = connectionEvent(2);
	const guard = new ServerSequenceGuard();

	equal(guard.observe(first), "accepted");
	equal(guard.observe(exactDuplicate), "duplicate");
	equal(guard.accept(second), "accepted");
	equal(guard.lastSequence, 2);
	equal(guard.nextSequence, 3);
	equal(guard.workspaceInstanceId, "workspace-0001");
	expectProtocolError(() => guard.observe(first), "sequence-error");
});

Deno.test("sequence guard rejects conflicts, gaps, workspace swaps, and reused IDs", () => {
	const conflictGuard = new ServerSequenceGuard();
	conflictGuard.observe(connectionEvent(1));
	expectProtocolError(
		() => conflictGuard.observe(connectionEvent(1, { eventId: "event-conflict" })),
		"sequence-error",
	);

	const gapGuard = new ServerSequenceGuard();
	const gap = expectProtocolError(() => gapGuard.observe(connectionEvent(2)), "sequence-error");
	match(gap.message, /gap/u);

	const workspaceGuard = new ServerSequenceGuard();
	workspaceGuard.observe(connectionEvent(1));
	expectProtocolError(
		() => workspaceGuard.observe(connectionEvent(2, { workspaceInstanceId: "workspace-0002" })),
		"sequence-error",
	);

	const idGuard = new ServerSequenceGuard();
	idGuard.observe(connectionEvent(1, { eventId: "stable-event" }));
	expectProtocolError(
		() => idGuard.observe(connectionEvent(2, { eventId: "stable-event" })),
		"sequence-error",
	);
});

Deno.test("sequence guard bounds retained event IDs and still accepts only the exact latest duplicate", () => {
	const guard = new ServerSequenceGuard(1, 2);
	const first = connectionEvent(1);
	const second = connectionEvent(2);
	guard.observe(first);
	guard.observe(second);
	equal(guard.observe(second), "duplicate");
	const limit = expectProtocolError(() => guard.observe(connectionEvent(3)), "sequence-error");
	match(limit.message, /2-event connection limit/u);

	guard.reset();
	equal(guard.observe(first), "accepted");
});

class FakeWebSocket {
	readyState: number = WebSocket.OPEN;
	readonly sent: string[] = [];
	readonly closes: Array<{ code?: number; reason?: string }> = [];
	readonly #listeners = new Map<string, Array<(event: unknown) => void>>();

	addEventListener(type: string, listener: (event: unknown) => void): void {
		const listeners = this.#listeners.get(type) ?? [];
		listeners.push(listener);
		this.#listeners.set(type, listeners);
	}

	send(frame: string): void {
		this.sent.push(frame);
	}

	close(code?: number, reason?: string): void {
		this.readyState = WebSocket.CLOSING;
		this.closes.push({ code, reason });
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}
}

Deno.test("browser transport is loopback-only, suppresses duplicates, and disconnects once on protocol failure", () => {
	equal(assertLocalWebSocketUrl("ws://127.0.0.1:8765/events"), "ws://127.0.0.1:8765/events");
	equal(assertLocalWebSocketUrl("wss://localhost/events"), "wss://localhost/events");
	throws(() => assertLocalWebSocketUrl("wss://example.com/events"), TypeError);
	throws(() => assertLocalWebSocketUrl("ws://user:secret@localhost/events"), TypeError);

	const socket = new FakeWebSocket();
	const transport = new WebSocketLocalTransport("ws://localhost:8765/events", {
		webSocketFactory: () => socket as unknown as WebSocket,
	});
	const events: ServerEvent[] = [];
	const disconnects: unknown[] = [];
	transport.onEvent((event) => events.push(event));
	transport.onDisconnect((disconnect) => disconnects.push(disconnect));

	const command = parseCommand("fs.refresh", { projectId: "project-alpha", directory: [] });
	transport.send(command);
	equal(socket.sent.length, 1);
	deepStrictEqual(parseClientCommand(socket.sent[0] as string), command);

	const first = connectionEvent(1);
	socket.emit("message", { data: encodeServerEvent(first) });
	socket.emit("message", { data: encodeServerEvent(first) });
	equal(events.length, 1);

	socket.emit("message", { data: encodeServerEvent(connectionEvent(3)) });
	equal(disconnects.length, 1);
	equal(socket.closes.length, 1);
	equal(socket.closes[0]?.code, 1002);
	let lateDisconnects = 0;
	transport.onDisconnect(() => lateDisconnects += 1);
	equal(lateDisconnects, 1);
	socket.emit("message", { data: new Uint8Array([1, 2, 3]) });
	equal(disconnects.length, 1);
});
