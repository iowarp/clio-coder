/**
 * Deterministic stdio ACP child used only by Workbench process-boundary tests.
 *
 * Invoke with `deno run acp-child-fixture.ts --scenario=<name>`. The default
 * scenario is `happy`. This is deliberately not a reusable ACP implementation:
 * it exists to make byte framing, process failure, cancellation, and permission
 * behavior observable without a provider or network connection.
 *
 * Fixture-only controls (never part of the product protocol):
 * - Any request params may include `_fixture: { delayMs: 0..1000 }` to delay the
 *   fixture action at a deterministic cancellation point.
 * - `fixture/inspect` returns the bounded call log and the exact JSON-RPC
 *   responses observed for outbound permission requests.
 */

import { dirname, join } from "node:path";

type JsonRpcId = string | number;

type JsonRpcRecord = Record<string, unknown>;

interface RecordedCall {
	readonly method: string;
	readonly notification: boolean;
	readonly id?: JsonRpcId;
}

interface PermissionObservation {
	readonly id: unknown;
	readonly result?: unknown;
	readonly error?: unknown;
	readonly matched: boolean;
}

interface ActiveTurn {
	readonly requestId: JsonRpcId;
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly toolTitle: string;
	readonly toolKind: "read" | "edit";
	cancelled: boolean;
	settled: boolean;
	toolStarted: boolean;
	toolTerminal: boolean;
	permissionRequestId: JsonRpcId | null;
}

interface PendingPermission {
	readonly turn: ActiveTurn;
	resolve(message: JsonRpcRecord): void;
}

const SCENARIOS = [
	"happy",
	"permission",
	"permission-chain",
	"permission-late-after-cancel",
	"stdout-partial",
	"stdout-multiple",
	"stdout-crlf",
	"stdout-malformed",
	"stdout-oversize",
	"stdout-partial-eof",
	"response-out-of-order",
	"response-unknown",
	"response-duplicate",
	"response-mixed",
	"notification-unknown",
	"request-unknown",
	"initialize-version-invalid",
	"initialize-capabilities-missing",
	"initialize-capabilities-unsupported",
	"remote-error-extra",
	"remote-error-admission",
	"remote-error-protocol-version",
	"stderr-noise",
	"unicode-delta",
	"unicode-delta-oversize",
	"project-root-split",
	"outside-location",
	"stream-budget",
	"forged-session-update",
	"tool-update-unknown",
	"tool-update-minimal",
	"tool-status-regression",
	"tool-terminal-duplicate",
	"update-flood",
	"end-turn-no-updates",
	"end-turn-blank-message",
	"end-turn-thought-only",
	"permission-unknown-tool",
	"permission-raw-mismatch",
	"permission-raw-utf8-oversize",
	"permission-raw-nonfinite-collision",
	"permission-extra-option",
	"permission-swapped-kinds",
	"permission-option-missing",
	"permission-option-duplicate",
	"permission-wrong-discriminator",
	"exit-early",
	"exit-during-turn",
	"leader-exits-descendant",
	"hang",
	"resist-term",
] as const;

type Scenario = (typeof SCENARIOS)[number];

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_INPUT_BUFFER_CHARS = 2 * 1024 * 1024;
const MAX_RECORDED_CALLS = 128;
const MAX_PERMISSION_OBSERVATIONS = 32;
const SESSION_ID = "fixture-session-1";
const TOOL_CALL_ID = "fixture-tool-1";
const PERMISSION_REQUEST_ID = "fixture-permission-1";
const SECOND_PERMISSION_REQUEST_ID = "fixture-permission-2";
const UNKNOWN_REQUEST_ID = "fixture-unknown-request-1";
const FORGED_SESSION_ID = "raw-attacker-session-93841";
const OWNED_SESSION_ID = "owned-session";
const STREAM_BUDGET_MARKER = "must-not-render-stream-budget-overflow";
const LATE_PERMISSION_MARKER = "Late cancellation permission reached the host.";

function isRecord(value: unknown): value is JsonRpcRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function selectedScenario(): Scenario {
	const value = Deno.args.find((argument) => argument.startsWith("--scenario="))?.slice("--scenario=".length) ??
		"happy";
	if ((SCENARIOS as readonly string[]).includes(value)) return value as Scenario;
	throw new Error(`Unknown fixture scenario: ${value}. Expected one of ${SCENARIOS.join(", ")}`);
}

function selectedCallLogPath(): string | null {
	return Deno.args.find((argument) => argument.startsWith("--call-log="))?.slice("--call-log=".length) ?? null;
}

function fixtureDelay(params: unknown): number {
	if (!isRecord(params) || !isRecord(params._fixture)) return 0;
	const delayMs = params._fixture.delayMs;
	return Number.isInteger(delayMs) && typeof delayMs === "number" && delayMs >= 0 && delayMs <= 1_000 ? delayMs : 0;
}

function sessionIdFrom(params: unknown): string {
	if (!isRecord(params) || typeof params.sessionId !== "string") return SESSION_ID;
	return params.sessionId;
}

function permissionKey(id: JsonRpcId): string {
	return `${typeof id}:${String(id)}`;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeAll(
	writer: { write(bytes: Uint8Array): Promise<number> },
	bytes: Uint8Array,
): Promise<void> {
	let offset = 0;
	while (offset < bytes.length) {
		const written = await writer.write(bytes.subarray(offset));
		if (written === 0) throw new Error("Fixture output stream stopped accepting bytes");
		offset += written;
	}
}

async function run(): Promise<void> {
	const scenario = selectedScenario();
	const callLogPath = selectedCallLogPath();
	if (scenario === "exit-early") {
		await writeAll(Deno.stderr, encoder.encode("fixture: intentional early exit\n"));
		Deno.exit(21);
	}

	let outputTail: Promise<void> = Promise.resolve();
	let stderrTail: Promise<void> = Promise.resolve();
	let emittedAdversarialPrelude = false;
	let initialized = false;
	let sessionCreated = false;
	let sessionClosed = false;
	let sessionCwd = Deno.cwd();
	let activeTurn: ActiveTurn | null = null;
	let resistantInterval: ReturnType<typeof setInterval> | undefined;
	const calls: RecordedCall[] = [];
	const permissionObservations: PermissionObservation[] = [];
	const pendingPermissions = new Map<string, PendingPermission>();
	const turnTasks = new Set<Promise<void>>();
	const heldInitializeIds: JsonRpcId[] = [];

	const queueBytes = (chunks: readonly Uint8Array[], pauseBetweenChunks = false): Promise<void> => {
		const operation = outputTail.then(async () => {
			for (let index = 0; index < chunks.length; index += 1) {
				const chunk = chunks[index];
				if (chunk === undefined) continue;
				await writeAll(Deno.stdout, chunk);
				if (pauseBetweenChunks && index + 1 < chunks.length) await delay(2);
			}
		});
		outputTail = operation.catch(() => undefined);
		return operation;
	};

	const queueRaw = (text: string): Promise<void> => queueBytes([encoder.encode(text)]);
	const queueStderr = (text: string): Promise<void> => {
		const operation = stderrTail.then(() => writeAll(Deno.stderr, encoder.encode(text)));
		stderrTail = operation.catch(() => undefined);
		return operation;
	};

	if (scenario === "leader-exits-descendant") {
		const descendant = new Deno.Command("/usr/bin/sleep", {
			args: ["30"],
			stdin: "null",
			stdout: "null",
			stderr: "null",
		}).spawn();
		await queueStderr(`fixture: descendant-pid=${descendant.pid}\n`);
	}

	const emitPreludeIfNeeded = async (): Promise<boolean> => {
		if (emittedAdversarialPrelude) return false;
		emittedAdversarialPrelude = true;

		if (scenario === "stdout-malformed") {
			await queueRaw('{"jsonrpc":"2.0",not-json}\n');
			return false;
		}
		if (scenario === "stdout-oversize") {
			const oversized = JSON.stringify({
				jsonrpc: "2.0",
				method: "fixture/oversize",
				params: { text: "x".repeat(300 * 1024) },
			});
			await queueRaw(`${oversized}\n`);
			return false;
		}
		if (scenario === "notification-unknown") {
			await queueRaw(`${JSON.stringify({ jsonrpc: "2.0", method: "fixture/unknown_notification", params: {} })}\n`);
			return false;
		}
		if (scenario === "request-unknown") {
			await queueRaw(`${
				JSON.stringify({
					jsonrpc: "2.0",
					id: UNKNOWN_REQUEST_ID,
					method: "fixture/unknown_request",
					params: {},
				})
			}\n`);
			return false;
		}
		if (scenario === "stdout-partial-eof") {
			await queueRaw('{"jsonrpc":"2.0","id":');
			await outputTail;
			Deno.exit(0);
		}
		return false;
	};

	const emit = async (message: JsonRpcRecord): Promise<void> => {
		await emitPreludeIfNeeded();
		const ending = scenario === "stdout-crlf" ? "\r\n" : "\n";
		const bytes = encoder.encode(`${JSON.stringify(message)}${ending}`);
		if (scenario === "stdout-partial" && bytes.length >= 3) {
			const first = Math.floor(bytes.length / 3);
			const second = Math.floor((bytes.length * 2) / 3);
			await queueBytes([bytes.subarray(0, first), bytes.subarray(first, second), bytes.subarray(second)], true);
			return;
		}
		await queueBytes([bytes]);
	};

	const emitBatch = async (messages: readonly JsonRpcRecord[]): Promise<void> => {
		await emitPreludeIfNeeded();
		const ending = scenario === "stdout-crlf" ? "\r\n" : "\n";
		const bytes = encoder.encode(messages.map((message) => `${JSON.stringify(message)}${ending}`).join(""));
		await queueBytes([bytes]);
	};

	const emitResult = (id: JsonRpcId, result: unknown): Promise<void> => emit({ jsonrpc: "2.0", id, result });

	const emitError = (
		id: JsonRpcId | null,
		code: number,
		message: string,
		fixtureCode: string,
		fixtureReason?: string,
	): Promise<void> =>
		emit({
			jsonrpc: "2.0",
			id,
			error: {
				code,
				message,
				data: {
					_meta: {
						"clio-coder/error": {
							version: 1,
							code: fixtureCode,
							...(fixtureReason === undefined ? {} : { reason: fixtureReason }),
						},
					},
				},
			},
		});

	const updateMessage = (sessionId: string, update: JsonRpcRecord): JsonRpcRecord => ({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId, update },
	});

	const fixtureLocation = (): string => {
		if (scenario === "outside-location") return join(dirname(sessionCwd), "outside.txt");
		const separator = sessionCwd.includes("\\") ? "\\" : "/";
		return `${sessionCwd.replace(/[\\/]+$/, "")}${separator}notes.txt`;
	};

	const promptResult = (stopReason: string): JsonRpcRecord => ({
		stopReason,
		_meta: {
			"clio-coder/usage": {
				input: 5,
				output: 8,
				cacheRead: 1,
				cacheWrite: 0,
				reasoning: 2,
			},
		},
	});

	const supportedAgentCapabilities: JsonRpcRecord = {
		loadSession: false,
		promptCapabilities: { audio: false, embeddedContext: false, image: false },
		mcpCapabilities: { http: false, sse: false },
		_meta: { "clio-coder/session": { close: true }, "clio-coder/tools": "mediated" },
	};

	const initializeResult: JsonRpcRecord = {
		protocolVersion: 1,
		agentInfo: { name: "clio-coder", title: "Clio Workbench ACP fixture", version: "0.0.0" },
		agentCapabilities: supportedAgentCapabilities,
		authMethods: [],
	};
	const scenarioInitializeResult = scenario === "initialize-version-invalid"
		? { ...initializeResult, protocolVersion: 2 }
		: scenario === "initialize-capabilities-missing"
		? {
			...initializeResult,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { audio: false, embeddedContext: false, image: false },
				mcpCapabilities: { http: false, sse: false },
			},
		}
		: scenario === "initialize-capabilities-unsupported"
		? { ...initializeResult, agentCapabilities: { ...supportedAgentCapabilities, loadSession: true } }
		: initializeResult;

	const settleTurn = async (turn: ActiveTurn, stopReason: string): Promise<void> => {
		if (turn.settled) return;
		turn.settled = true;
		await emitResult(turn.requestId, promptResult(stopReason));
		if (activeTurn === turn) activeTurn = null;
	};

	const emitCancelledTool = (turn: ActiveTurn): Promise<void> =>
		emit(updateMessage(turn.sessionId, {
			sessionUpdate: "tool_call_update",
			toolCallId: turn.toolCallId,
			title: turn.toolTitle,
			kind: turn.toolKind,
			status: "failed",
			content: [{ type: "content", content: { type: "text", text: "cancelled" } }],
			locations: [{ path: fixtureLocation() }],
		}));

	const cancelTurn = async (turn: ActiveTurn): Promise<void> => {
		if (turn.settled || turn.cancelled) return;
		turn.cancelled = true;
		if (turn.permissionRequestId !== null) {
			pendingPermissions.get(permissionKey(turn.permissionRequestId))?.resolve({
				jsonrpc: "2.0",
				id: turn.permissionRequestId,
				result: { outcome: { outcome: "cancelled" } },
				_fixtureSynthetic: true,
			});
		}
		if (turn.toolStarted && !turn.toolTerminal) {
			turn.toolTerminal = true;
			await emitCancelledTool(turn);
		}
		await settleTurn(turn, "cancelled");
	};

	const runOrderedTurn = async (turn: ActiveTurn, waitMs: number): Promise<void> => {
		if (waitMs > 0) await delay(waitMs);
		if (turn.cancelled) {
			await settleTurn(turn, "cancelled");
			return;
		}
		if (scenario === "update-flood") {
			for (let index = 0; index <= 1_024; index += 1) {
				await emit(updateMessage(turn.sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: index === 1_024 ? "must-not-render-update-overflow" : "" },
				}));
			}
			return;
		}
		if (scenario === "stream-budget") {
			const fullChunk = "x".repeat(16 * 1024);
			const overflowChunk = "x".repeat(16 * 1024 - encoder.encode(STREAM_BUDGET_MARKER).byteLength) +
				STREAM_BUDGET_MARKER;
			for (let index = 0; index < 17; index += 1) {
				await emit(updateMessage(turn.sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: index === 16 ? overflowChunk : fullChunk },
				}));
			}
			return;
		}
		if (scenario === "forged-session-update") {
			await emit(updateMessage(FORGED_SESSION_ID, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "must-not-render" },
			}));
			return;
		}
		if (scenario === "end-turn-no-updates") {
			await settleTurn(turn, "end_turn");
			return;
		}
		if (scenario === "end-turn-blank-message") {
			await emit(updateMessage(turn.sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: " \t" },
			}));
			await settleTurn(turn, "end_turn");
			return;
		}
		if (scenario === "end-turn-thought-only") {
			await emit(updateMessage(turn.sessionId, {
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "Reasoning alone is not a completed answer." },
			}));
			await settleTurn(turn, "end_turn");
			return;
		}
		if (scenario === "project-root-split") {
			const midpoint = Math.max(1, Math.floor(sessionCwd.length / 2));
			await emit(updateMessage(turn.sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `Observed ${sessionCwd.slice(0, midpoint)}` },
			}));
			await emit(updateMessage(turn.sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `${sessionCwd.slice(midpoint)}/notes.txt` },
			}));
			await settleTurn(turn, "end_turn");
			return;
		}

		const firstUpdates = [
			updateMessage(turn.sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: scenario === "unicode-delta"
						? "😀".repeat(4 * 1024)
						: scenario === "unicode-delta-oversize"
						? `${"😀".repeat(4 * 1024)}x`
						: "Fixture turn started. ",
				},
			}),
			updateMessage(turn.sessionId, {
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "Inspecting deterministic input. " },
			}),
		];
		if (scenario === "stdout-multiple") await emitBatch(firstUpdates);
		else {
			for (const update of firstUpdates) await emit(update);
		}
		if (turn.cancelled || turn.settled) return;
		if (scenario === "tool-update-unknown") {
			await emit(updateMessage(turn.sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: "fixture-tool-never-started",
				title: "Unknown fixture tool",
				kind: "read",
				status: "completed",
				locations: [{ path: fixtureLocation() }],
			}));
			return;
		}

		turn.toolStarted = true;
		await emit(updateMessage(turn.sessionId, {
			sessionUpdate: "tool_call",
			toolCallId: turn.toolCallId,
			title: "Read fixture note",
			kind: "read",
			status: "in_progress",
			rawInput: { path: "notes.txt" },
			locations: [{ path: fixtureLocation() }],
		}));
		if (turn.cancelled || turn.settled) return;
		if (scenario === "tool-status-regression") {
			await emit(updateMessage(turn.sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: turn.toolCallId,
				title: turn.toolTitle,
				kind: turn.toolKind,
				status: "pending",
				locations: [{ path: fixtureLocation() }],
			}));
			return;
		}
		turn.toolTerminal = true;
		await emit(updateMessage(
			turn.sessionId,
			scenario === "tool-update-minimal"
				? {
					sessionUpdate: "tool_call_update",
					toolCallId: turn.toolCallId,
					status: "completed",
					content: [{ type: "content", content: { type: "text", text: "fixture note" } }],
				}
				: {
					sessionUpdate: "tool_call_update",
					toolCallId: turn.toolCallId,
					title: turn.toolTitle,
					kind: turn.toolKind,
					status: "completed",
					content: [{ type: "content", content: { type: "text", text: "fixture note" } }],
					rawOutput: { bytes: 12 },
					locations: [{ path: fixtureLocation() }],
				},
		));
		if (turn.cancelled || turn.settled) return;
		if (scenario === "tool-terminal-duplicate") {
			await emit(updateMessage(turn.sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId: turn.toolCallId,
				title: turn.toolTitle,
				kind: turn.toolKind,
				status: "completed",
				locations: [{ path: fixtureLocation() }],
			}));
			return;
		}
		await emit(updateMessage(turn.sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Fixture turn complete." },
		}));
		await settleTurn(turn, "end_turn");
	};

	const waitForPermission = (turn: ActiveTurn, requestId = PERMISSION_REQUEST_ID): Promise<JsonRpcRecord> =>
		new Promise((resolve) => {
			pendingPermissions.set(permissionKey(requestId), { turn, resolve });
		});

	const emitPermissionRequest = (
		turn: ActiveTurn,
		requestId: JsonRpcId,
		options: readonly JsonRpcRecord[],
		toolCallId: string,
		sessionUpdate: string,
		rawInput: JsonRpcRecord,
	): Promise<void> =>
		emit({
			jsonrpc: "2.0",
			id: requestId,
			method: "session/request_permission",
			params: {
				sessionId: turn.sessionId,
				toolCall: {
					sessionUpdate,
					toolCallId,
					title: "Write fixture note",
					kind: "edit",
					status: "pending",
					rawInput,
					locations: [{ path: fixtureLocation() }],
				},
				options,
			},
		});

	const runPermissionTurn = async (turn: ActiveTurn, waitMs: number): Promise<void> => {
		if (waitMs > 0) await delay(waitMs);
		if (turn.cancelled) {
			await settleTurn(turn, "cancelled");
			return;
		}

		await emit(updateMessage(turn.sessionId, {
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "Permission is required. " },
		}));
		if (turn.cancelled || turn.settled) return;
		turn.toolStarted = true;
		const rawContent = scenario === "permission-raw-mismatch"
			? "different content"
			: scenario === "permission-raw-utf8-oversize"
			? "é".repeat(2_049)
			: "fixture content";
		const toolStart = updateMessage(turn.sessionId, {
			sessionUpdate: "tool_call",
			toolCallId: turn.toolCallId,
			title: "Write fixture note",
			kind: "edit",
			status: "in_progress",
			rawInput: scenario === "permission-raw-nonfinite-collision"
				? { path: "notes.txt", value: "__fixture_nonfinite__" }
				: { path: "notes.txt", content: rawContent },
			locations: [{ path: fixtureLocation() }],
		});
		if (scenario === "permission-raw-nonfinite-collision") {
			// JSON permits an exponent that JavaScript parses as Infinity. Sending the
			// token literally proves the client does not let JSON.stringify collapse it
			// to null and bind a different permission payload to the same signature.
			const raw = JSON.stringify(toolStart).replace('"__fixture_nonfinite__"', "1e400");
			await queueRaw(`${raw}\n`);
		} else {
			await emit(toolStart);
		}
		if (turn.cancelled || turn.settled) return;

		turn.permissionRequestId = PERMISSION_REQUEST_ID;
		const permissionToolCallId = scenario === "permission-unknown-tool"
			? "fixture-tool-never-started"
			: turn.toolCallId;
		const responsePromise = waitForPermission(turn);
		const options = scenario === "permission-swapped-kinds"
			? [
				{ optionId: "allow-once", name: "Reject", kind: "reject_once" },
				{ optionId: "reject-once", name: "Allow once", kind: "allow_once" },
			]
			: scenario === "permission-option-missing"
			? [
				{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
				{ optionId: "not-reject-once", name: "Reject", kind: "reject_once" },
			]
			: scenario === "permission-option-duplicate"
			? [
				{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
				{ optionId: "allow-once", name: "Reject", kind: "reject_once" },
			]
			: [
				{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
				{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
				...(scenario === "permission-extra-option"
					? [{ optionId: "allow-always", name: "Allow always", kind: "allow_always" }]
					: []),
			];
		await emitPermissionRequest(
			turn,
			PERMISSION_REQUEST_ID,
			options,
			permissionToolCallId,
			scenario === "permission-wrong-discriminator" ? "tool_call_update" : "tool_call",
			scenario === "permission-raw-nonfinite-collision"
				? { path: "notes.txt", value: null }
				: { path: "notes.txt", content: "fixture content" },
		);

		let response = await responsePromise;
		pendingPermissions.delete(permissionKey(PERMISSION_REQUEST_ID));
		turn.permissionRequestId = null;
		if (scenario === "permission-chain" || scenario === "permission-late-after-cancel") {
			turn.permissionRequestId = SECOND_PERMISSION_REQUEST_ID;
			const secondResponse = waitForPermission(turn, SECOND_PERMISSION_REQUEST_ID);
			await emitPermissionRequest(
				turn,
				SECOND_PERMISSION_REQUEST_ID,
				options,
				turn.toolCallId,
				"tool_call",
				{ path: "notes.txt", content: "fixture content" },
			);
			if (scenario === "permission-late-after-cancel") {
				await emit(updateMessage(turn.sessionId, {
					sessionUpdate: "agent_thought_chunk",
					content: { type: "text", text: LATE_PERMISSION_MARKER },
				}));
			}
			response = await secondResponse;
			pendingPermissions.delete(permissionKey(SECOND_PERMISSION_REQUEST_ID));
			turn.permissionRequestId = null;
		}
		if (turn.cancelled || turn.settled) return;

		const outcome = isRecord(response.result) && isRecord(response.result.outcome) ? response.result.outcome : null;
		const allowed = outcome?.outcome === "selected" && outcome.optionId === "allow-once";
		const permissionCancelled = outcome?.outcome === "cancelled";
		if (permissionCancelled) return;
		turn.toolTerminal = true;
		await emit(updateMessage(turn.sessionId, {
			sessionUpdate: "tool_call_update",
			toolCallId: turn.toolCallId,
			title: turn.toolTitle,
			kind: turn.toolKind,
			status: allowed ? "completed" : "failed",
			content: [{
				type: "content",
				content: {
					type: "text",
					text: allowed ? "permission allowed" : "permission denied",
				},
			}],
			locations: [{ path: fixtureLocation() }],
		}));
		if (turn.cancelled || turn.settled) return;
		await emit(updateMessage(turn.sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: {
				type: "text",
				text: allowed ? "Observed allow-once." : "Observed rejection.",
			},
		}));
		await settleTurn(turn, "end_turn");
	};

	const runTurn = async (turn: ActiveTurn, waitMs: number): Promise<void> => {
		if (scenario === "exit-during-turn") {
			await emit(updateMessage(turn.sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Fixture exits during this turn." },
			}));
			await writeAll(Deno.stderr, encoder.encode("fixture: intentional during-turn exit\n"));
			Deno.exit(22);
		}
		if (scenario === "hang" || scenario === "resist-term") {
			if (waitMs > 0) await delay(waitMs);
			await emit(updateMessage(turn.sessionId, {
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "Fixture is intentionally parked." },
			}));
			return;
		}
		if (scenario.startsWith("permission")) {
			await runPermissionTurn(turn, waitMs);
			return;
		}
		await runOrderedTurn(turn, waitMs);
	};

	const launchTurn = (turn: ActiveTurn, waitMs: number): void => {
		const task = runTurn(turn, waitMs).catch(async (error: unknown) => {
			if (turn.settled) return;
			turn.settled = true;
			const message = error instanceof Error ? error.message.slice(0, 120) : "Fixture turn failed";
			await emitError(turn.requestId, -32_000, message, "turn_failed").catch(() => undefined);
			if (activeTurn === turn) activeTurn = null;
		}).finally(() => turnTasks.delete(task));
		turnTasks.add(task);
	};

	const recordCall = (method: string, id: JsonRpcId | undefined): void => {
		if (calls.length >= MAX_RECORDED_CALLS) calls.shift();
		const boundedMethod = method.slice(0, 128);
		calls.push(
			id === undefined
				? { method: boundedMethod, notification: true }
				: { method: boundedMethod, notification: false, id },
		);
	};

	const handlePermissionResponse = (message: JsonRpcRecord): boolean => {
		if (!isJsonRpcId(message.id) || (!("result" in message) && !("error" in message))) return false;
		const pending = pendingPermissions.get(permissionKey(message.id));
		if (permissionObservations.length >= MAX_PERMISSION_OBSERVATIONS) permissionObservations.shift();
		permissionObservations.push({
			id: message.id,
			...("result" in message ? { result: message.result } : {}),
			...("error" in message ? { error: message.error } : {}),
			matched: pending !== undefined,
		});
		const observation = permissionObservations.at(-1);
		if (observation !== undefined) {
			void queueStderr(`fixture: permission-response=${JSON.stringify(observation)}\n`);
		}
		if (pending !== undefined) pending.resolve(message);
		return true;
	};

	const handleMethod = async (message: JsonRpcRecord): Promise<void> => {
		const method = message.method;
		if (typeof method !== "string") return;
		const id = isJsonRpcId(message.id) ? message.id : undefined;
		const params = message.params;
		recordCall(method, id);
		const waitMs = fixtureDelay(params);

		if (method === "initialize") {
			if (waitMs > 0) await delay(waitMs);
			if (id === undefined) return;
			if (scenario === "response-out-of-order") {
				heldInitializeIds.push(id);
				if (heldInitializeIds.length < 2) return;
				const first = heldInitializeIds.shift();
				const second = heldInitializeIds.shift();
				if (first === undefined || second === undefined) return;
				initialized = true;
				await emitResult(second, scenarioInitializeResult);
				await emitResult(first, scenarioInitializeResult);
				return;
			}
			if (scenario === "response-unknown") await emitResult(999, {});
			if (scenario === "response-mixed") {
				await emit({ jsonrpc: "2.0", id, method: "session/update", result: {} });
				return;
			}
			if (scenario === "remote-error-extra") {
				await emit({
					jsonrpc: "2.0",
					id,
					error: {
						code: -32_000,
						message: "fixture-secret-message must not survive projection",
						data: {
							_meta: {
								"clio-coder/error": {
									version: 1,
									code: "fixture_rejected",
									reason: "test",
									supported: [1],
								},
							},
							secret: "fixture-secret-data",
							path: "/fixture/private/project",
						},
						stack: "fixture-secret-stack",
					},
					extra: "fixture-secret-extra",
				});
				return;
			}
			if (scenario === "remote-error-protocol-version") {
				await emit({
					jsonrpc: "2.0",
					id,
					error: {
						code: -32_602,
						message: "unsupported protocol version",
						data: {
							_meta: {
								"clio-coder/error": {
									version: 1,
									code: "protocol_version_unsupported",
									supported: [1],
								},
							},
						},
					},
				});
				return;
			}
			initialized = true;
			await emitResult(id, scenarioInitializeResult);
			if (scenario === "response-duplicate") await emitResult(id, scenarioInitializeResult);
			return;
		}

		if (method === "fixture/inspect") {
			if (waitMs > 0) await delay(waitMs);
			if (id !== undefined) {
				await emitResult(id, {
					scenario,
					calls: [...calls],
					permissionResponses: [...permissionObservations],
					state: { initialized, sessionCreated, sessionClosed, activePrompt: activeTurn !== null },
				});
			}
			return;
		}

		if (!initialized) {
			if (id !== undefined) await emitError(id, -32_000, "Initialize first.", "not_initialized");
			return;
		}

		if (method === "session/new") {
			if (waitMs > 0) await delay(waitMs);
			if (isRecord(params) && typeof params.cwd === "string") sessionCwd = params.cwd;
			sessionCreated = true;
			sessionClosed = false;
			if (id !== undefined) {
				await emitResult(id, { sessionId: scenario === "forged-session-update" ? OWNED_SESSION_ID : SESSION_ID });
			}
			return;
		}

		if (method === "session/prompt") {
			if (id === undefined) return;
			if (!sessionCreated || sessionClosed) {
				await emitError(id, -32_000, "Unknown fixture session.", "session_unknown");
				return;
			}
			if (activeTurn !== null) {
				await emitError(id, -32_000, "A fixture prompt is already active.", "prompt_active");
				return;
			}
			if (scenario === "remote-error-admission") {
				await emitError(
					id,
					-32_000,
					"fixture admission prose must not survive projection",
					"prompt_not_admitted",
					"model-not-configured",
				);
				return;
			}
			const turn: ActiveTurn = {
				requestId: id,
				sessionId: sessionIdFrom(params),
				toolCallId: TOOL_CALL_ID,
				toolTitle: scenario.startsWith("permission") ? "Write fixture note" : "Read fixture note",
				toolKind: scenario.startsWith("permission") ? "edit" : "read",
				cancelled: false,
				settled: false,
				toolStarted: false,
				toolTerminal: false,
				permissionRequestId: null,
			};
			activeTurn = turn;
			launchTurn(turn, waitMs);
			return;
		}

		if (method === "session/cancel") {
			const cancellation = activeTurn === null ? Promise.resolve() : cancelTurn(activeTurn);
			if (id !== undefined) await emitResult(id, {});
			await cancellation;
			return;
		}

		if (method === "session/close") {
			if (waitMs > 0) await delay(waitMs);
			if (id === undefined) return;
			if (activeTurn !== null) {
				await emitError(id, -32_000, "A fixture prompt is active.", "prompt_active");
				return;
			}
			sessionClosed = true;
			await emitResult(id, {});
			return;
		}

		if (id !== undefined) await emitError(id, -32_601, "Fixture method not found.", "method_not_found");
	};

	const handleLine = async (line: string): Promise<void> => {
		if (line.length === 0) return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			await emitError(null, -32_700, "Fixture received malformed JSON.", "parse_error");
			return;
		}
		if (!isRecord(message)) {
			await emitError(null, -32_600, "Fixture expected an object.", "invalid_request");
			return;
		}
		if (handlePermissionResponse(message)) return;
		await handleMethod(message);
	};

	if (scenario === "stderr-noise") {
		const noise = `${"fixture diagnostic: harmless-noise\n".repeat(600)}${"€".repeat(6_000)}\n`;
		await queueStderr(`${noise}Authorization: Bearer fixture-secret-value\nfixture path=/fixture/private/project\n`);
	}

	if (scenario === "resist-term") {
		resistantInterval = setInterval(() => undefined, 1_000);
		if (Deno.build.os !== "windows") {
			Deno.addSignalListener("SIGTERM", () => {
				void queueStderr("fixture: intentionally ignored SIGTERM\n");
			});
		}
	}

	let inputBuffer = "";
	for await (const chunk of Deno.stdin.readable) {
		inputBuffer += decoder.decode(chunk, { stream: true });
		if (inputBuffer.length > MAX_INPUT_BUFFER_CHARS) {
			inputBuffer = "";
			await emitError(null, -32_600, "Fixture input exceeded its test bound.", "input_line_too_large");
			continue;
		}
		let newlineIndex = inputBuffer.indexOf("\n");
		while (newlineIndex >= 0) {
			let line = inputBuffer.slice(0, newlineIndex);
			inputBuffer = inputBuffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			await handleLine(line);
			newlineIndex = inputBuffer.indexOf("\n");
		}
	}
	inputBuffer += decoder.decode();
	if (inputBuffer.endsWith("\r")) inputBuffer = inputBuffer.slice(0, -1);
	if (inputBuffer.length > 0) await handleLine(inputBuffer);
	if (activeTurn !== null) await cancelTurn(activeTurn);
	await Promise.allSettled([...turnTasks]);
	const callLog = calls.map((call) => `${call.notification ? "notification" : "request"}:${call.method}`).join(">")
		.slice(0, 4_096);
	if (callLogPath !== null) await Deno.writeTextFile(callLogPath, JSON.stringify(calls));
	await queueStderr(`fixture: eof-calls=${callLog}\n`).catch(() => undefined);
	await outputTail;
	await stderrTail;

	// `resist-term` intentionally keeps both the timer and signal listener alive;
	// process-boundary tests must escalate from TERM to KILL for this scenario.
	if (scenario !== "resist-term" && resistantInterval !== undefined) clearInterval(resistantInterval);
}

await run();
