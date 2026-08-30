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
	/** JSON-RPC ids for this turn's outbound permission requests, unique per turn. */
	readonly permissionIds: readonly [string, string];
	readonly toolTitle: string;
	readonly toolKind: "read" | "edit";
	cancelled: boolean;
	settled: boolean;
	toolStarted: boolean;
	toolTerminal: boolean;
	permissionRequestId: JsonRpcId | null;
	/**
	 * Set by turns that open more than one tool call, so a cancellation settles the
	 * call that is actually open rather than the turn's nominal first one. An
	 * update for a tool the client never saw start is a protocol failure.
	 */
	openTool: { readonly toolCallId: string; readonly title: string; readonly kind: string } | null;
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
	"session-attribution-missing",
	"session-attribution-field-missing",
	"session-attribution-session-mismatch",
	"session-attribution-resumed-mismatch",
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
	"conversation",
	"resume",
	"resume-truncated",
	"resume-64-turns",
	"resume-65-turns",
	"resume-attribution-mismatch",
	"max-turn-requests",
	"settings",
	"settings-truncated",
	"settings-invalid-thinking",
	"settings-invalid-autonomy",
	"settings-invalid-editable",
	"settings-invalid-patch-result",
	"targets-invalid-orchestrator",
	"probe-target-mismatch",
	"probe-latency-invalid",
	"sessions-missing-preview",
	"sessions-invalid-hosted",
	"sessions-hosted-false",
	"autonomy-source-invalid",
	"seventeen-bash",
	"seventeen-bash-quiet",
	"event-without-opt-in",
	"event-workspace-mismatch",
	"event-sequence-repeat",
	"event-session-mismatch",
	"event-turn-changed",
	"event-terminal-invalid",
	"event-tool-fields-invalid",
	"event-count-invalid",
	"event-interruption-invalid",
] as const;

type Scenario = (typeof SCENARIOS)[number];

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_INPUT_LINE_BYTES = 1024 * 1024;
const MAX_RECORDED_CALLS = 128;
const MAX_PERMISSION_OBSERVATIONS = 32;
const MAX_TURN_TOOL_STARTS = 128;
const SESSION_ID = "fixture-session-1";
const TOOL_CALL_ID = "fixture-tool-1";
const PERMISSION_REQUEST_ID = "fixture-permission-1";
const SECOND_PERMISSION_REQUEST_ID = "fixture-permission-2";
const UNKNOWN_REQUEST_ID = "fixture-unknown-request-1";
const FORGED_SESSION_ID = "raw-attacker-session-93841";
const OWNED_SESSION_ID = "owned-session";
const STREAM_BUDGET_MARKER = "must-not-render-stream-budget-overflow";
/** One update past `MAX_ACP_UPDATES_PER_TURN` in clio-host.ts. */
const UPDATE_FLOOD_COUNT = 8_192;
/** 16 KiB apiece, one chunk past `MAX_CUMULATIVE_STREAM_BYTES` in clio-host.ts. */
const STREAM_BUDGET_CHUNKS = 65;
const LATE_PERMISSION_MARKER = "Late cancellation permission reached the host.";
const RESUMABLE_SESSION_ID = "fixture-session-earlier";
/** Scenarios that host a conversation: many prompts, session methods, attribution. */
const CONVERSATION_SCENARIOS = new Set<string>([
	"conversation",
	"resume",
	"resume-truncated",
	"resume-64-turns",
	"resume-65-turns",
	"resume-attribution-mismatch",
	"max-turn-requests",
	"settings",
	"settings-truncated",
	"settings-invalid-thinking",
	"settings-invalid-autonomy",
	"settings-invalid-editable",
	"settings-invalid-patch-result",
	"targets-invalid-orchestrator",
	"probe-target-mismatch",
	"probe-latency-invalid",
	"sessions-missing-preview",
	"sessions-invalid-hosted",
	"sessions-hosted-false",
	"autonomy-source-invalid",
]);
/** Scenarios that additionally advertise and serve the settings and targets methods. */
const SETTINGS_SCENARIOS = new Set<string>([
	"settings",
	"settings-truncated",
	"settings-invalid-thinking",
	"settings-invalid-autonomy",
	"settings-invalid-editable",
	"settings-invalid-patch-result",
	"targets-invalid-orchestrator",
	"probe-target-mismatch",
	"probe-latency-invalid",
]);
/**
 * These named fixture paths deliberately emulate an older ACP server with a
 * partial capability advertisement. They exercise focused transport and host
 * boundaries, but they do not represent the current W001 server surface.
 */
const OLDER_SERVER_PARTIAL_CAPABILITY_SCENARIOS = new Set<Scenario>(
	SCENARIOS.filter((candidate) => !SETTINGS_SCENARIOS.has(candidate)),
);
/** Scenarios that replay the recorded seventeen-bash run from the sprint charter. */
const LOOP_SCENARIOS = new Set<string>([
	"seventeen-bash",
	"seventeen-bash-quiet",
	"event-without-opt-in",
	"event-workspace-mismatch",
	"event-sequence-repeat",
	"event-session-mismatch",
	"event-turn-changed",
	"event-terminal-invalid",
	"event-tool-fields-invalid",
	"event-count-invalid",
	"event-interruption-invalid",
]);
/**
 * The command sequence from session 1v3dja8tfu9m, the run that produced the
 * charter's Defect 2 and Defect 3. The first two words of each are its shape, so
 * `git log` repeats often enough that a loop detector has something real to see.
 */
const SEVENTEEN_BASH_COMMANDS = [
	"git status",
	"git log --all --oneline",
	"git log --all --diff-filter=D",
	"git log --all --stat",
	"git rev-parse --show-toplevel",
	"git remote -v",
	"git check-ignore -v data/mesh-study.csv",
	"git log --follow data/mesh-study.csv",
	"git status --short",
	"git rev-list --all --count",
	"git show --stat HEAD",
	"git diff --name-only HEAD~1",
	"git ls-files --others",
	"git log --diff-filter=A -- data",
	"git reflog --all",
	"git fsck --lost-found",
	"find . -maxdepth 3 -name '*.csv'",
	"pwd --logical",
	"stat data/mesh-study.csv",
	"du -sh data",
] as const;
const SEVENTEEN_BASH_CALLS = 17;
const SEVENTEEN_BASH_CANDIDATE_LIMIT = 128;
/** Blocks a turn may spend before the disposition stops being a plain block. */
const LOOP_BUDGET = 8;
/** A shape must be seen this many times before Clio reports it as a loop. */
const LOOP_REPEAT_THRESHOLD = 3;

/** The first two words of a command, which is what repeats when a model rephrases. */
function commandShape(command: string): string {
	return command.split(/\s+/u).slice(0, 2).join(" ");
}

/**
 * A denied command comes back rephrased rather than abandoned, which is exactly
 * what the recorded model did. Rotating the arguments keeps the shape identical
 * and changes the string, so the retry is visible and the loop is detectable.
 */
function rephraseCommand(command: string, attempt: number): string {
	const words = command.split(/\s+/u);
	const head = words.slice(0, 2);
	const tail = words.slice(2);
	if (tail.length < 2) return `${command} --retry-${attempt}`;
	const offset = attempt % tail.length;
	return [...head, ...tail.slice(offset), ...tail.slice(0, offset)].join(" ");
}
const AUTONOMY_LEVELS = ["read-only", "suggest", "auto-edit", "full-auto"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EDITABLE_SETTING_KEYS = [
	"orchestrator.target",
	"orchestrator.model",
	"orchestrator.thinkingLevel",
	"autonomy",
] as const;
/** Two targets so a probe can prove both a healthy and a not-configured outcome. */
const FIXTURE_TARGETS = [
	{
		id: "lmstudio",
		runtime: "openai-compatible",
		models: ["qwen3.8-27b", "qwen3.8-4b"],
		isOrchestrator: true,
	},
	{
		id: "offline-lab",
		runtime: "openai-compatible",
		models: ["stub-tiny"],
		isOrchestrator: false,
	},
] as const;

interface StoredSession {
	readonly sessionId: string;
	label: string | null;
	readonly preview: string;
	readonly createdAt: string;
	updatedAt: string;
	turns: number;
	readonly target: string | null;
	readonly model: string | null;
	endedAt: string | null;
}

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

/** Written once at startup so a test can prove which child is alive. */
function selectedPidPath(): string | null {
	return Deno.args.find((argument) => argument.startsWith("--pid-file="))?.slice("--pid-file=".length) ?? null;
}

function selectedCallLogPath(): string | null {
	return Deno.args.find((argument) => argument.startsWith("--call-log="))?.slice("--call-log=".length) ?? null;
}

/**
 * Separate from the call log so its array shape stays untouched. This one records
 * every answer the client sent to an outbound permission request, which is how a
 * test proves an expiry never reached Clio as a rejection.
 */
function selectedPermissionLogPath(): string | null {
	return Deno.args.find((argument) => argument.startsWith("--permission-log="))?.slice("--permission-log=".length) ??
		null;
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
	const permissionLogPath = selectedPermissionLogPath();
	const pidPath = selectedPidPath();
	if (pidPath !== null) await Deno.writeTextFile(pidPath, String(Deno.pid));
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
	let hostedSessionId = SESSION_ID;
	let sessionCwd = Deno.cwd();
	let activeTurn: ActiveTurn | null = null;
	// A real Clio never reuses a JSON-RPC id across turns, so neither does this.
	let turnOrdinal = 0;
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

	const conversational = CONVERSATION_SCENARIOS.has(scenario);
	const configurable = SETTINGS_SCENARIOS.has(scenario);
	const olderServerPartialCapabilities = OLDER_SERVER_PARTIAL_CAPABILITY_SCENARIOS.has(scenario);
	const supportedAgentCapabilities: JsonRpcRecord = {
		loadSession: conversational,
		promptCapabilities: { audio: false, embeddedContext: false, image: false },
		mcpCapabilities: { http: false, sse: false },
		_meta: {
			"clio-coder/session": conversational
				? { close: true, list: true, label: true, delete: true, autonomy: true }
				: { close: true },
			...(olderServerPartialCapabilities ? {} : {
				"clio-coder/settings": { get_safe: true, patch_safe: true },
				"clio-coder/targets": { list: true, probe: true },
			}),
			"clio-coder/events": {
				version: 1,
				notification: "clio-coder/event",
				kinds: ["safety.loopBlocked"],
				workspaceInstanceId: "fixture-workspace-1",
			},
			"clio-coder/tools": "mediated",
		},
	};

	const initializeResult: JsonRpcRecord = {
		protocolVersion: 1,
		agentInfo: { name: "clio-coder", title: "Clio Coder ACP fixture", version: "0.0.0" },
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

	// Support is advertised independently. Emission still requires client opt in.
	let eventsOptedIn = false;
	const readEventOptIn = (params: unknown): boolean => {
		if (LOOP_SCENARIOS.has(scenario) === false || scenario === "seventeen-bash-quiet") return false;
		if (!isRecord(params) || !isRecord(params.clientCapabilities)) return false;
		const meta = params.clientCapabilities._meta;
		if (!isRecord(meta)) return false;
		const optIn = meta["clio-coder/events"];
		if (!isRecord(optIn) || optIn.version !== 1 || !Array.isArray(optIn.kinds)) return false;
		return optIn.kinds.includes("safety.loopBlocked");
	};
	const initializeResultFor = (params: unknown): JsonRpcRecord => {
		eventsOptedIn = scenario === "event-without-opt-in" ? true : readEventOptIn(params);
		return scenarioInitializeResult;
	};

	// A per-process session store. Real Clio persists this; the fixture keeps it in
	// memory so list, label, and delete are observable end to end.
	const sessions = new Map<string, StoredSession>();
	if (conversational) {
		sessions.set(RESUMABLE_SESSION_ID, {
			sessionId: RESUMABLE_SESSION_ID,
			label: "Earlier audit",
			preview: "Audit the convergence study",
			createdAt: "2026-08-18T11:00:00.000Z",
			updatedAt: "2026-08-18T11:30:00.000Z",
			turns: 2,
			target: "lmstudio",
			model: "qwen3.8-27b",
			endedAt: "2026-08-18T11:30:00.000Z",
		});
	}

	// The safe settings projection and the bound session's autonomy are mutable so
	// a patch and a per-session override are observable on the next read and turn.
	const safeSettings = {
		orchestrator: { target: "lmstudio", model: "qwen3.8-27b", thinkingLevel: "off" },
		autonomy: "auto-edit",
	} as { orchestrator: { target: string | null; model: string | null; thinkingLevel: string }; autonomy: string };
	let sessionAutonomy = safeSettings.autonomy;
	let autonomySource: "settings" | "session" = "settings";

	const safeSettingsResult = (afterPatch = false): JsonRpcRecord => ({
		settings: {
			orchestrator: {
				target: safeSettings.orchestrator.target,
				model: safeSettings.orchestrator.model,
				thinkingLevel: scenario === "settings-invalid-thinking" ? null : safeSettings.orchestrator.thinkingLevel,
			},
			autonomy: scenario === "settings-invalid-autonomy" ||
					(scenario === "settings-invalid-patch-result" && afterPatch)
				? null
				: safeSettings.autonomy,
		},
		editable: scenario === "settings-invalid-editable" ? ["autonomy"] : [...EDITABLE_SETTING_KEYS],
	});

	const sessionMeta = (sessionId: string, resumed: boolean, replayed?: JsonRpcRecord): JsonRpcRecord => ({
		"clio-coder/session": {
			sessionId,
			target: "lmstudio",
			model: "qwen3.8-27b",
			autonomy: sessionAutonomy,
			createdAt: "2026-08-18T12:00:00.000Z",
			resumed,
			...(replayed === undefined ? {} : { replayed }),
		},
	});
	const scenarioSessionMeta = (
		sessionId: string,
		resumed: boolean,
		replayed?: JsonRpcRecord,
	): JsonRpcRecord | undefined => {
		if (scenario === "session-attribution-missing") return undefined;
		const meta = sessionMeta(sessionId, resumed, replayed);
		const attribution = meta["clio-coder/session"] as JsonRpcRecord;
		if (scenario === "session-attribution-field-missing") {
			const { target: _target, ...withoutTarget } = attribution;
			return { "clio-coder/session": withoutTarget };
		}
		if (scenario === "session-attribution-session-mismatch") {
			return { "clio-coder/session": { ...attribution, sessionId: "fixture-session-other" } };
		}
		if (scenario === "session-attribution-resumed-mismatch") {
			return { "clio-coder/session": { ...attribution, resumed: !resumed } };
		}
		if (scenario === "resume-attribution-mismatch" && resumed) {
			return { "clio-coder/session": { ...attribution, resumed: false } };
		}
		return meta;
	};
	let extensionEventSequence = 0;

	const replayFrame = (sessionId: string, turn: number, update: JsonRpcRecord): JsonRpcRecord => ({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId, update, _meta: { "clio-coder/replay": { turn } } },
	});

	/** Replays ordinary history plus exact boundary cases for the 64-group ceiling. */
	const emitReplay = async (sessionId: string): Promise<void> => {
		const turnCount = scenario === "resume-64-turns" ? 64 : scenario === "resume-65-turns" ? 65 : 2;
		for (let turn = 1; turn <= turnCount; turn += 1) {
			await emit(replayFrame(sessionId, turn, {
				sessionUpdate: "user_message_chunk",
				content: { type: "text", text: `Earlier prompt ${turn}` },
			}));
			if (turnCount > 2) continue;
			await emit(replayFrame(sessionId, turn, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `Earlier answer ${turn}` },
			}));
			await emit(replayFrame(sessionId, turn, {
				sessionUpdate: "tool_call",
				toolCallId: `fixture-replay-tool-${turn}`,
				title: "Read fixture note",
				kind: "read",
				status: "in_progress",
				locations: [{ path: fixtureLocation() }],
			}));
			if (turn === 1) {
				await emit(replayFrame(sessionId, turn, {
					sessionUpdate: "tool_call_update",
					toolCallId: `fixture-replay-tool-${turn}`,
					title: "Read fixture note",
					kind: "read",
					status: "completed",
					content: [{ type: "content", content: { type: "text", text: "earlier note" } }],
					locations: [{ path: fixtureLocation() }],
				}));
			}
		}
	};

	const runConversationTurn = async (turn: ActiveTurn, waitMs: number): Promise<void> => {
		if (waitMs > 0) await delay(waitMs);
		if (turn.cancelled) {
			await settleTurn(turn, "cancelled");
			return;
		}
		if (scenario === "max-turn-requests") {
			for (let index = 1; index <= MAX_TURN_TOOL_STARTS; index += 1) {
				const ordinal = String(index).padStart(3, "0");
				const toolCallId = `fixture-budget-tool-${ordinal}`;
				const title = `Read fixture note ${ordinal}`;
				turn.toolStarted = true;
				turn.toolTerminal = false;
				turn.openTool = { toolCallId, title, kind: "read" };
				await emit(updateMessage(turn.sessionId, {
					sessionUpdate: "tool_call",
					toolCallId,
					title,
					kind: "read",
					status: "in_progress",
					locations: [{ path: fixtureLocation() }],
				}));
				if (turn.settled) return;
				turn.toolTerminal = true;
				turn.openTool = null;
				await emit(updateMessage(turn.sessionId, {
					sessionUpdate: "tool_call_update",
					toolCallId,
					title,
					kind: "read",
					status: "completed",
					content: [{ type: "content", content: { type: "text", text: `fixture note ${ordinal}` } }],
					locations: [{ path: fixtureLocation() }],
				}));
			}
			// The server stops before publishing the 129th candidate as a tool start.
			await settleTurn(turn, "max_turn_requests");
			return;
		}
		// The count proves the child remembered the earlier prompts in this session.
		// The settings scenarios also name the autonomy the turn started under, which
		// is how a test proves an ACP autonomy change reached the next prompt.
		await emit(updateMessage(turn.sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: {
				type: "text",
				text: configurable
					? `This session has seen ${turnOrdinal} prompts at autonomy ${sessionAutonomy}.`
					: `This session has seen ${turnOrdinal} prompts.`,
			},
		}));
		await settleTurn(turn, "end_turn");
	};

	const settleTurn = async (turn: ActiveTurn, stopReason: string): Promise<void> => {
		if (turn.settled) return;
		turn.settled = true;
		await emitResult(turn.requestId, promptResult(stopReason));
		if (activeTurn === turn) activeTurn = null;
	};

	const emitCancelledTool = (turn: ActiveTurn): Promise<void> =>
		emit(updateMessage(turn.sessionId, {
			sessionUpdate: "tool_call_update",
			toolCallId: turn.openTool?.toolCallId ?? turn.toolCallId,
			title: turn.openTool?.title ?? turn.toolTitle,
			kind: turn.openTool?.kind ?? turn.toolKind,
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
			// One past the host's per-turn update budget, so the last one must never project.
			for (let index = 0; index <= UPDATE_FLOOD_COUNT; index += 1) {
				await emit(updateMessage(turn.sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: index === UPDATE_FLOOD_COUNT ? "must-not-render-update-overflow" : "" },
				}));
			}
			return;
		}
		if (scenario === "stream-budget") {
			const fullChunk = "x".repeat(16 * 1024);
			const overflowChunk = "x".repeat(16 * 1024 - encoder.encode(STREAM_BUDGET_MARKER).byteLength) +
				STREAM_BUDGET_MARKER;
			for (let index = 0; index < STREAM_BUDGET_CHUNKS; index += 1) {
				await emit(updateMessage(turn.sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: index === STREAM_BUDGET_CHUNKS - 1 ? overflowChunk : fullChunk },
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

	const waitForPermission = (turn: ActiveTurn, requestId: string): Promise<JsonRpcRecord> =>
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

		const [firstPermissionId, secondPermissionId] = turn.permissionIds;
		turn.permissionRequestId = firstPermissionId;
		const permissionToolCallId = scenario === "permission-unknown-tool"
			? "fixture-tool-never-started"
			: turn.toolCallId;
		const responsePromise = waitForPermission(turn, firstPermissionId);
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
			firstPermissionId,
			options,
			permissionToolCallId,
			scenario === "permission-wrong-discriminator" ? "tool_call_update" : "tool_call",
			scenario === "permission-raw-nonfinite-collision"
				? { path: "notes.txt", value: null }
				: { path: "notes.txt", content: "fixture content" },
		);

		let response = await responsePromise;
		pendingPermissions.delete(permissionKey(firstPermissionId));
		turn.permissionRequestId = null;
		if (scenario === "permission-chain" || scenario === "permission-late-after-cancel") {
			turn.permissionRequestId = secondPermissionId;
			const secondResponse = waitForPermission(turn, secondPermissionId);
			await emitPermissionRequest(
				turn,
				secondPermissionId,
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
			pendingPermissions.delete(permissionKey(secondPermissionId));
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

	/**
	 * Seventeen consecutive execute calls, each mediated, none narrated. This is
	 * the shape of the run that produced the charter's Defect 2 and Defect 3: the
	 * operator sees nothing but tool cards, and a denial makes the model rephrase
	 * and try the same shape again rather than move on.
	 */
	const runSeventeenBashTurn = async (turn: ActiveTurn, waitMs: number): Promise<void> => {
		if (waitMs > 0) await delay(waitMs);
		if (turn.cancelled) {
			await settleTurn(turn, "cancelled");
			return;
		}
		const shapeCounts = new Map<string, number>();
		let blocksThisTurn = 0;
		let commandIndex = 0;
		let retryAttempt = 0;
		let emittedStarts = 0;

		for (let candidate = 0; emittedStarts < SEVENTEEN_BASH_CALLS; candidate += 1) {
			if (candidate >= SEVENTEEN_BASH_CANDIDATE_LIMIT) {
				throw new Error("The fixture could not produce seventeen accepted tool starts.");
			}
			if (turn.cancelled || turn.settled) return;
			const base = SEVENTEEN_BASH_COMMANDS[Math.min(commandIndex, SEVENTEEN_BASH_COMMANDS.length - 1)] ?? "git status";
			const command = retryAttempt === 0 ? base : rephraseCommand(base, retryAttempt);

			// Clio notices the repeat when the shape lands for the third time, and
			// blocks that candidate before any tool start reaches ACP.
			const shape = commandShape(command);
			const repeatCount = (shapeCounts.get(shape) ?? 0) + 1;
			shapeCounts.set(shape, repeatCount);
			if (repeatCount >= LOOP_REPEAT_THRESHOLD) {
				blocksThisTurn += 1;
				if (eventsOptedIn) {
					extensionEventSequence += 1;
					const emittedSequence = scenario === "event-sequence-repeat" && extensionEventSequence > 1
						? extensionEventSequence - 1
						: extensionEventSequence;
					const emittedTurnId = scenario === "event-turn-changed" && extensionEventSequence > 1
						? `fixture-turn-other-${turnOrdinal}`
						: `fixture-turn-${turnOrdinal}`;
					await emit({
						jsonrpc: "2.0",
						method: "clio-coder/event",
						params: {
							version: 1,
							workspaceInstanceId: scenario === "event-workspace-mismatch"
								? "fixture-workspace-other"
								: "fixture-workspace-1",
							sessionId: scenario === "event-session-mismatch" ? "fixture-session-other" : turn.sessionId,
							turnId: emittedTurnId,
							sequence: emittedSequence,
							kind: "safety.loopBlocked",
							terminal: scenario === "event-terminal-invalid",
							payload: {
								toolCallId: scenario === "event-tool-fields-invalid" ? "fixture-tool-other" : null,
								tool: "bash",
								repeatCount: scenario === "event-count-invalid" ? 0 : repeatCount,
								blocksThisTurn,
								budget: LOOP_BUDGET,
								disposition: scenario === "event-interruption-invalid"
									? "stop"
									: blocksThisTurn >= LOOP_BUDGET
									? "lockout"
									: "block",
								interrupted: false,
								shape: scenario === "event-tool-fields-invalid" ? "git log" : null,
							},
						},
					});
				}
				commandIndex += 1;
				retryAttempt = 0;
				continue;
			}
			if (turn.cancelled || turn.settled) return;

			emittedStarts += 1;
			const toolCallId = `seventeen-tool-${turnOrdinal}-${emittedStarts}`;
			const permissionId = `seventeen-permission-${turnOrdinal}-${emittedStarts}`;
			const title = `bash: ${command}`;
			turn.toolStarted = true;
			turn.toolTerminal = false;
			turn.openTool = { toolCallId, title, kind: "execute" };
			await emit(updateMessage(turn.sessionId, {
				sessionUpdate: "tool_call",
				toolCallId,
				title,
				kind: "execute",
				status: "in_progress",
				rawInput: { command },
				locations: [{ path: fixtureLocation() }],
			}));
			if (turn.cancelled || turn.settled) return;

			turn.permissionRequestId = permissionId;
			const responsePromise = waitForPermission(turn, permissionId);
			await emit({
				jsonrpc: "2.0",
				id: permissionId,
				method: "session/request_permission",
				params: {
					sessionId: turn.sessionId,
					toolCall: {
						sessionUpdate: "tool_call",
						toolCallId,
						title,
						kind: "execute",
						status: "pending",
						rawInput: { command },
						locations: [{ path: fixtureLocation() }],
					},
					options: [
						{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
						{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
					],
				},
			});
			const response = await responsePromise;
			pendingPermissions.delete(permissionKey(permissionId));
			turn.permissionRequestId = null;
			if (turn.cancelled || turn.settled) return;

			const outcome = isRecord(response.result) && isRecord(response.result.outcome) ? response.result.outcome : null;
			if (outcome?.outcome === "cancelled") return;
			const allowed = outcome?.outcome === "selected" && outcome.optionId === "allow-once";
			turn.toolTerminal = true;
			turn.openTool = null;
			await emit(updateMessage(turn.sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId,
				title,
				kind: "execute",
				status: allowed ? "completed" : "failed",
				locations: [{ path: fixtureLocation() }],
			}));

			if (allowed) {
				commandIndex += 1;
				retryAttempt = 0;
			} else {
				retryAttempt += 1;
			}
		}
		// No assistant text anywhere in this turn, deliberately.
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
		if (LOOP_SCENARIOS.has(scenario)) {
			await runSeventeenBashTurn(turn, waitMs);
			return;
		}
		if (scenario.startsWith("permission")) {
			await runPermissionTurn(turn, waitMs);
			return;
		}
		if (conversational) {
			await runConversationTurn(turn, waitMs);
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
			const result = initializeResultFor(params);
			await emitResult(id, result);
			if (scenario === "response-duplicate") await emitResult(id, result);
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
			if (sessionCreated && conversational) {
				if (id !== undefined) await emitError(id, -32_000, "One session per fixture process.", "session_limit");
				return;
			}
			sessionCreated = true;
			sessionClosed = false;
			hostedSessionId = scenario === "forged-session-update" ? OWNED_SESSION_ID : SESSION_ID;
			if (conversational) {
				sessions.set(hostedSessionId, {
					sessionId: hostedSessionId,
					label: null,
					preview: "",
					createdAt: "2026-08-18T12:00:00.000Z",
					updatedAt: "2026-08-18T12:00:00.000Z",
					turns: 0,
					target: "lmstudio",
					model: "qwen3.8-27b",
					endedAt: null,
				});
			}
			if (id !== undefined) {
				const attribution = scenarioSessionMeta(hostedSessionId, false);
				await emitResult(id, {
					sessionId: hostedSessionId,
					...(attribution === undefined ? {} : { _meta: attribution }),
				});
			}
			return;
		}

		if (method === "session/load") {
			if (waitMs > 0) await delay(waitMs);
			if (id === undefined) return;
			if (!conversational) {
				await emitError(id, -32_601, "Fixture method not found.", "method_not_found");
				return;
			}
			const requested = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : "";
			const stored = sessions.get(requested);
			if (stored === undefined) {
				await emitError(id, -32_000, "Unknown fixture session.", "session_unknown");
				return;
			}
			if (sessionCreated) {
				await emitError(id, -32_000, "One session per fixture process.", "session_limit");
				return;
			}
			if (isRecord(params) && typeof params.cwd === "string") sessionCwd = params.cwd;
			// Every replayed frame precedes the response: that ordering is the
			// history boundary the client relies on.
			await emitReplay(requested);
			sessionCreated = true;
			sessionClosed = false;
			hostedSessionId = requested;
			stored.endedAt = null;
			const replayedTurns = scenario === "resume-64-turns" ? 64 : scenario === "resume-65-turns" ? 65 : 2;
			const attribution = scenarioSessionMeta(requested, true, {
				turns: replayedTurns,
				truncated: scenario === "resume-truncated",
			});
			await emitResult(id, attribution === undefined ? {} : { _meta: attribution });
			return;
		}

		if (method === "clio-coder/session/list") {
			if (waitMs > 0) await delay(waitMs);
			if (id === undefined) return;
			if (!conversational) {
				await emitError(id, -32_601, "Fixture method not found.", "method_not_found");
				return;
			}
			const ordered = [...sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
			const sessionEntries = ordered.map((session) => {
				const entry: JsonRpcRecord = {
					sessionId: session.sessionId,
					label: session.label,
					preview: session.preview,
					createdAt: session.createdAt,
					updatedAt: session.updatedAt,
					turns: session.turns,
					target: session.target,
					model: session.model,
					state: session.sessionId === hostedSessionId ? "open" : session.endedAt === null ? "unknown" : "closed",
					hosted: scenario === "sessions-invalid-hosted"
						? "yes"
						: scenario === "sessions-hosted-false"
						? false
						: session.sessionId === hostedSessionId,
				};
				if (scenario === "sessions-missing-preview") delete entry.preview;
				return entry;
			});
			await emitResult(id, {
				sessions: sessionEntries,
				truncated: false,
				// The server drops trailing entries when the response would exceed its
				// byte budget. `resume-truncated` reports that budget signal instead of
				// the count signal so the client must honour both.
				...(scenario === "resume-truncated" ? { _meta: { "clio-coder/truncated": true } } : {}),
			});
			return;
		}

		if (method === "clio-coder/session/label" || method === "clio-coder/session/delete") {
			if (waitMs > 0) await delay(waitMs);
			if (id === undefined) return;
			if (!conversational) {
				await emitError(id, -32_601, "Fixture method not found.", "method_not_found");
				return;
			}
			const requested = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : "";
			const stored = sessions.get(requested);
			if (stored === undefined) {
				await emitError(id, -32_000, "Unknown fixture session.", "session_unknown");
				return;
			}
			if (method === "clio-coder/session/label") {
				const label = isRecord(params) && typeof params.label === "string" ? params.label : "";
				stored.label = label.length === 0 ? null : label;
				await emitResult(id, {});
				return;
			}
			if (requested === hostedSessionId) {
				await emitError(id, -32_000, "That session is open.", "session_open");
				return;
			}
			sessions.delete(requested);
			await emitResult(id, {});
			return;
		}

		if (method === "clio-coder/session/autonomy") {
			if (waitMs > 0) await delay(waitMs);
			if (id === undefined) return;
			if (!conversational) {
				await emitError(id, -32_601, "Fixture method not found.", "method_not_found");
				return;
			}
			const requested = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : "";
			if (requested !== hostedSessionId || !sessionCreated || sessionClosed) {
				await emitError(id, -32_000, "Unknown fixture session.", "session_unknown");
				return;
			}
			const level = isRecord(params) ? params.level : undefined;
			if (level === undefined) {
				await emitResult(id, {
					level: sessionAutonomy,
					source: scenario === "autonomy-source-invalid" ? "fixture" : autonomySource,
				});
				return;
			}
			if (typeof level !== "string" || !(AUTONOMY_LEVELS as readonly string[]).includes(level)) {
				await emitError(id, -32_602, "Unknown autonomy level.", "invalid_params");
				return;
			}
			if (activeTurn !== null) {
				await emitError(id, -32_000, "A fixture prompt is already active.", "prompt_active");
				return;
			}
			sessionAutonomy = level;
			autonomySource = "session";
			await emitResult(id, {
				level: sessionAutonomy,
				source: scenario === "autonomy-source-invalid" ? "fixture" : "session",
			});
			return;
		}

		if (method === "clio-coder/settings/get_safe" || method === "clio-coder/settings/patch_safe") {
			if (waitMs > 0) await delay(waitMs);
			if (id === undefined) return;
			if (!configurable) {
				await emitError(id, -32_601, "Fixture method not found.", "method_not_found");
				return;
			}
			if (method === "clio-coder/settings/get_safe") {
				await emitResult(id, safeSettingsResult());
				return;
			}
			if (activeTurn !== null) {
				await emitError(id, -32_000, "A fixture prompt is already active.", "prompt_active");
				return;
			}
			const patch = isRecord(params) && isRecord(params.patch) ? params.patch : null;
			if (patch === null) {
				await emitError(id, -32_602, "A patch object is required.", "invalid_params");
				return;
			}
			// Validate the whole patch before writing any of it: a partial write would
			// leave the operator's settings in a state neither side asked for.
			const staged = {
				target: safeSettings.orchestrator.target,
				model: safeSettings.orchestrator.model,
				thinkingLevel: safeSettings.orchestrator.thinkingLevel,
				autonomy: safeSettings.autonomy,
			};
			for (const [key, value] of Object.entries(patch)) {
				if (!(EDITABLE_SETTING_KEYS as readonly string[]).includes(key)) {
					await emitError(id, -32_602, "That setting is not editable.", "invalid_params");
					return;
				}
				if (key === "orchestrator.target") {
					if (value !== null && (typeof value !== "string" || !FIXTURE_TARGETS.some((t) => t.id === value))) {
						await emitError(id, -32_602, "Unknown target.", "invalid_params", "target-unknown");
						return;
					}
					staged.target = value as string | null;
					continue;
				}
				if (key === "orchestrator.model") {
					if (value !== null && typeof value !== "string") {
						await emitError(id, -32_602, "Unknown model.", "invalid_params");
						return;
					}
					staged.model = value as string | null;
					continue;
				}
				if (key === "orchestrator.thinkingLevel") {
					if (typeof value !== "string" || !(THINKING_LEVELS as readonly string[]).includes(value)) {
						await emitError(id, -32_602, "Unknown thinking level.", "invalid_params");
						return;
					}
					staged.thinkingLevel = value;
					continue;
				}
				if (typeof value !== "string" || !(AUTONOMY_LEVELS as readonly string[]).includes(value)) {
					await emitError(id, -32_602, "Unknown autonomy level.", "invalid_params");
					return;
				}
				staged.autonomy = value;
			}
			safeSettings.orchestrator.target = staged.target;
			safeSettings.orchestrator.model = staged.model;
			safeSettings.orchestrator.thinkingLevel = staged.thinkingLevel;
			safeSettings.autonomy = staged.autonomy;
			await emitResult(id, safeSettingsResult(true));
			return;
		}

		if (method === "clio-coder/targets/list") {
			if (waitMs > 0) await delay(waitMs);
			if (id === undefined) return;
			if (!configurable) {
				await emitError(id, -32_601, "Fixture method not found.", "method_not_found");
				return;
			}
			await emitResult(id, {
				targets: FIXTURE_TARGETS.map((target) => ({
					id: target.id,
					runtime: target.runtime,
					models: [...target.models],
					isOrchestrator: scenario === "targets-invalid-orchestrator" ? "yes" : target.isOrchestrator,
				})),
				// The server sets this when its aggregate byte budget dropped an entry.
				...(scenario === "settings-truncated" ? { _meta: { "clio-coder/truncated": true } } : {}),
			});
			return;
		}

		if (method === "clio-coder/targets/probe") {
			if (waitMs > 0) await delay(waitMs);
			if (id === undefined) return;
			if (!configurable) {
				await emitError(id, -32_601, "Fixture method not found.", "method_not_found");
				return;
			}
			const targetId = isRecord(params) && typeof params.targetId === "string" ? params.targetId : "";
			if (!FIXTURE_TARGETS.some((target) => target.id === targetId)) {
				await emitError(id, -32_602, "Unknown target.", "invalid_params", "target-unknown");
				return;
			}
			// One healthy target and one whose credentials were never configured, so
			// both halves of the probe presentation are provable.
			await emitResult(
				id,
				targetId === "lmstudio"
					? {
						targetId: scenario === "probe-target-mismatch" ? "offline-lab" : targetId,
						healthy: true,
						latencyMs: scenario === "probe-latency-invalid" ? -1 : 12,
						reason: null,
					}
					: { targetId, healthy: false, latencyMs: null, reason: "not-configured" },
			);
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
			turnOrdinal += 1;
			const hosted = sessions.get(hostedSessionId);
			if (hosted !== undefined) {
				hosted.turns += 1;
				hosted.updatedAt = "2026-08-18T12:10:00.000Z";
			}
			const suffix = turnOrdinal === 1 ? "" : `-${turnOrdinal}`;
			const turn: ActiveTurn = {
				requestId: id,
				sessionId: sessionIdFrom(params),
				toolCallId: `${TOOL_CALL_ID}${suffix}`,
				permissionIds: [`${PERMISSION_REQUEST_ID}${suffix}`, `${SECOND_PERMISSION_REQUEST_ID}${suffix}`],
				toolTitle: scenario.startsWith("permission") ? "Write fixture note" : "Read fixture note",
				toolKind: scenario.startsWith("permission") ? "edit" : "read",
				cancelled: false,
				settled: false,
				toolStarted: false,
				toolTerminal: false,
				permissionRequestId: null,
				openTool: null,
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
			const closing = sessions.get(hostedSessionId);
			if (closing !== undefined) closing.endedAt = "2026-08-18T12:20:00.000Z";
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

	const exceedsInputLineBytes = (value: string): boolean => {
		if (value.length <= MAX_INPUT_LINE_BYTES / 3) return false;
		return encoder.encode(value).byteLength > MAX_INPUT_LINE_BYTES;
	};
	const reportOversizedInputLine = (): Promise<void> =>
		emitError(null, -32_600, "Fixture input exceeded its one MiB byte bound.", "input_line_too_large");
	let inputBuffer = "";
	let discardingInputLine = false;
	for await (const chunk of Deno.stdin.readable) {
		inputBuffer += decoder.decode(chunk, { stream: true });
		let newlineIndex = inputBuffer.indexOf("\n");
		while (newlineIndex >= 0) {
			let line = inputBuffer.slice(0, newlineIndex);
			inputBuffer = inputBuffer.slice(newlineIndex + 1);
			if (discardingInputLine) {
				discardingInputLine = false;
				newlineIndex = inputBuffer.indexOf("\n");
				continue;
			}
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (exceedsInputLineBytes(line)) await reportOversizedInputLine();
			else await handleLine(line);
			newlineIndex = inputBuffer.indexOf("\n");
		}
		if (discardingInputLine) {
			inputBuffer = "";
			continue;
		}
		if (exceedsInputLineBytes(inputBuffer)) {
			inputBuffer = "";
			discardingInputLine = true;
			await reportOversizedInputLine();
		}
	}
	inputBuffer += decoder.decode();
	if (!discardingInputLine) {
		if (inputBuffer.endsWith("\r")) inputBuffer = inputBuffer.slice(0, -1);
		if (exceedsInputLineBytes(inputBuffer)) await reportOversizedInputLine();
		else if (inputBuffer.length > 0) await handleLine(inputBuffer);
	}
	if (activeTurn !== null) await cancelTurn(activeTurn);
	await Promise.allSettled([...turnTasks]);
	const callLog = calls.map((call) => `${call.notification ? "notification" : "request"}:${call.method}`).join(">")
		.slice(0, 4_096);
	if (callLogPath !== null) await Deno.writeTextFile(callLogPath, JSON.stringify(calls));
	if (permissionLogPath !== null) {
		await Deno.writeTextFile(permissionLogPath, JSON.stringify(permissionObservations));
	}
	await queueStderr(`fixture: eof-calls=${callLog}\n`).catch(() => undefined);
	await outputTail;
	await stderrTail;

	// `resist-term` intentionally keeps both the timer and signal listener alive;
	// process-boundary tests must escalate from TERM to KILL for this scenario.
	if (scenario !== "resist-term" && resistantInterval !== undefined) clearInterval(resistantInterval);
}

await run();
