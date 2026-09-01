/**
 * One Clio Coder process per open project, alive across many prompts.
 *
 * `ClioProjectHost` owns exactly one `clio-coder acp` child at a time. The child
 * is spawned when the project opens, initialized once, and then either binds a
 * session (`session/new` or `session/load`) or answers pre-session methods such
 * as the session list. Because one process backs one Clio Coder session, closing or
 * switching a session retires the child and spawns a fresh one.
 *
 * Everything that crosses to the renderer is a bounded DTO from
 * `src/protocol.ts`. Wire identifiers, native paths outside the project, argv,
 * environment, and stderr never leave this module.
 */

import {
	ACP_MAX_PERMISSION_TIMEOUT_MS,
	ACP_MAX_REQUEST_TIMEOUT_MS,
	type AcpAgentAttribution,
	AcpClient,
	AcpClientError,
	type AcpClientTiming,
	type AcpDispatchEventKind,
	type AcpDispatchEventPayload,
	type AcpExtensionEvent,
	type AcpFailure,
	type AcpLaunchSpec,
	type AcpPermissionRequest,
	AcpRemoteError,
	AcpTimeoutError,
	EXTENSION_EVENT_KINDS,
	localAcpLaunch,
	type ValidatedAcpUpdate,
} from "./acp-client.ts";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	AUTONOMY_LEVELS,
	MAX_WIRE_FLEET_RUNS,
	PRODUCT_NAME,
	type ServerEventPayloadByKind,
	THINKING_LEVELS,
	type WireAgentAttribution,
	type WireAutonomyLevel,
	type WireBoundSession,
	type WireClioCapabilities,
	type WireClioSnapshot,
	type WireEventSource,
	type WireFleetRun,
	type WireFleetRunState,
	type WireLoopDisposition,
	type WireSessionSummary,
	type WireSettingsState,
	type WireTarget,
	type WireTargetHealth,
	type WireUsage,
} from "./src/protocol.ts";

export type { WireAutonomyLevel } from "./src/protocol.ts";

export interface ClioLauncher {
	launch(trustedRoot: string): AcpLaunchSpec;
}

export interface LocalClioLauncherOptions {
	readonly executable?: string;
	readonly prefixArgs?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly clearEnv?: boolean;
	readonly permissionTimeoutMs?: number;
}

export interface HostProject {
	readonly projectId: string;
	readonly trustedRoot: string;
	readonly displayName: string;
}

export interface HostTurnContext {
	readonly projectId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly turnId: string;
}

export type HostEvent =
	| Readonly<{ type: "clio-coder.state"; projectId: string; snapshot: WireClioSnapshot }>
	| Readonly<{
		type: "session.list";
		projectId: string;
		sessions: readonly WireSessionSummary[];
		truncated: boolean;
	}>
	| Readonly<{ type: "settings.state"; projectId: string; settings: WireSettingsState }>
	| Readonly<{ type: "targets.state"; projectId: string; targets: readonly WireTarget[]; truncated: boolean }>
	| Readonly<{ type: "targets.probed"; projectId: string; targetId: string; health: WireTargetHealth }>
	| Readonly<{ type: "turn.started"; context: HostTurnContext; payload: ServerEventPayloadByKind["turn.started"] }>
	| Readonly<
		{ type: "turn.text" | "turn.thought"; context: HostTurnContext; payload: ServerEventPayloadByKind["turn.text"] }
	>
	| Readonly<{ type: "turn.tool"; context: HostTurnContext; payload: ServerEventPayloadByKind["turn.tool"] }>
	| Readonly<{ type: "turn.loop"; context: HostTurnContext; payload: ServerEventPayloadByKind["turn.loop"] }>
	| Readonly<{
		type: "turn.permission.requested";
		context: HostTurnContext;
		payload: ServerEventPayloadByKind["turn.permission.requested"];
	}>
	| Readonly<{
		type: "turn.permission.resolved";
		context: HostTurnContext;
		payload: ServerEventPayloadByKind["turn.permission.resolved"];
	}>
	| Readonly<{ type: "turn.terminal"; context: HostTurnContext; payload: ServerEventPayloadByKind["turn.terminal"] }>
	| Readonly<{
		type: "fleet.activity";
		projectId: string;
		generation: string;
		sessionId: string;
		payload: ServerEventPayloadByKind["fleet.activity"];
	}>;

export interface HostSink {
	emit(event: HostEvent): void;
	refreshProject(projectId: string): Promise<void>;
}

export interface ClioHostOptions {
	readonly launcher: ClioLauncher;
	readonly project: HostProject;
	readonly sink: HostSink;
	readonly acpTiming?: AcpClientTiming;
	readonly promptTimeoutMs?: number;
	readonly permissionEscalateMs?: number;
	readonly permissionBudgetMs?: number;
	readonly now?: () => number;
	/** Configuration diagnostics. Never carries session content. */
	readonly log?: (message: string) => void;
}

export class HostError extends Error {
	readonly code: "invalid" | "conflict" | "not-ready" | "not-found" | "refused" | "unsupported" | "internal";

	constructor(code: HostError["code"], message: string) {
		super(message);
		this.name = "HostError";
		this.code = code;
	}
}

const encoder = new TextEncoder();
const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_CUMULATIVE_STREAM_BYTES = 1024 * 1024;
const MAX_ACP_UPDATES_PER_TURN = 8_192;
const MAX_TOOLS_PER_TURN = 128;
const MAX_REPLAY_TURNS = 64;
const MAX_REPLAY_TOOLS = 8_192;
const INITIALIZE_TIMEOUT_MS = 10_000;
const NEW_SESSION_TIMEOUT_MS = 15_000;
const LOAD_SESSION_TIMEOUT_MS = 60_000;
const METHOD_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_PROMPT_TIMEOUT_MS = ACP_MAX_REQUEST_TIMEOUT_MS;
const MAX_SESSION_ID_BYTES = 128;
const MAX_STOP_REASON_BYTES = 64;
const MAX_TOOL_KIND_BYTES = 64;
const MAX_TITLE_BYTES = 512;
const MAX_SESSIONS_LISTED = 200;
/** How long a card may sit unanswered before the GUI escalates it. */
export const DEFAULT_PERMISSION_ESCALATE_MS = 45_000;
/** How long a card may sit unanswered before the turn is stopped. Never a denial. */
export const DEFAULT_PERMISSION_BUDGET_MS = 10 * 60 * 1_000;
const PROMPT_STOP_REASONS = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const;
const PROBE_REASONS = ["not-configured", "unreachable", "unsupported", "probe-failed"] as const;
const SAFE_SETTING_KEYS = [
	"chat.target",
	"chat.model",
	"chat.thinkingLevel",
	"safety.autonomy",
] as const;
export const ACP_CLIENT_NAME = "clio-coder-workbench" as const;
const CLIENT_INFO = { name: ACP_CLIENT_NAME, title: PRODUCT_NAME, version: "0.0.1" } as const;
/**
 * Every kind this host is prepared to project. Asking for a kind the peer does
 * not know is harmless; the peer intersects the request with its own allowlist.
 */
const EVENT_OPT_IN = { version: 1, kinds: EXTENSION_EVENT_KINDS } as const;
const MAX_AGENT_ID_BYTES = 128;
const MAX_TASK_PREVIEW_BYTES = 512;

function bytes(value: string): number {
	return encoder.encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function boundedString(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || bytes(value) > maximum || hasControlCharacter(value)) {
		throw new HostError("internal", `${label} failed validation.`);
	}
	return value;
}

function requiredNullableBoundedString(
	record: Record<string, unknown>,
	key: string,
	label: string,
	maximum: number,
): string | null {
	if (!Object.hasOwn(record, key)) throw new HostError("internal", `${label} was missing.`);
	return record[key] === null ? null : boundedString(record[key], label, maximum);
}

function safeInteger(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function isoTimestamp(value: unknown, label: string): string {
	const text = boundedString(value, label, 128);
	const parsed = new Date(text);
	if (Number.isNaN(parsed.getTime())) throw new HostError("internal", `${label} was not a timestamp.`);
	return parsed.toISOString();
}

function autonomyLevel(value: unknown, label: string): WireAutonomyLevel {
	if (typeof value !== "string" || !(AUTONOMY_LEVELS as readonly string[]).includes(value)) {
		throw new HostError("internal", `${label} was not an autonomy level.`);
	}
	return value as WireAutonomyLevel;
}

function validateProject(project: HostProject): void {
	boundedString(project.projectId, "projectId", 128);
	boundedString(project.displayName, "project display name", 256);
	boundedString(project.trustedRoot, "trusted project root", 4 * 1024);
	if (!isAbsolute(project.trustedRoot)) throw new HostError("invalid", "The trusted project root must be absolute.");
}

function isInsideRoot(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function canonicalExistingAncestor(candidate: string): string | null {
	let current = candidate;
	while (true) {
		try {
			return Deno.realPathSync(current);
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) return null;
			const parent = dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}
}

/** ACP locations are untrusted presentation hints. Anything outside the root vanishes. */
export function projectLocations(
	trustedRoot: string,
	rawLocations: readonly string[],
): readonly (readonly string[])[] {
	const result: Array<readonly string[]> = [];
	for (const rawLocation of rawLocations) {
		if (!isAbsolute(rawLocation) || hasControlCharacter(rawLocation)) continue;
		const candidate = resolve(rawLocation);
		if (!isInsideRoot(trustedRoot, candidate)) continue;
		const ancestor = canonicalExistingAncestor(candidate);
		if (ancestor === null || !isInsideRoot(trustedRoot, ancestor)) continue;
		const local = relative(trustedRoot, candidate);
		if (local === "") continue;
		const segments = local.split(sep).filter((segment) => segment.length > 0);
		if (segments.some((segment) => segment === "." || segment === ".." || hasControlCharacter(segment))) continue;
		result.push(segments);
	}
	return result;
}

/**
 * Projects Clio Coder's own attribution into the bounded wire shape. The host
 * validates rather than repairs: an identity it cannot represent is a host
 * error, because relabelling a worker's work as the orchestrator's would be a
 * lie the operator has no way to notice.
 */
function projectAgents(agents: readonly AcpAgentAttribution[]): readonly WireAgentAttribution[] {
	return agents.map((agent) => ({
		role: agent.role,
		agentId: boundedString(agent.agentId, "Clio Coder agent id", MAX_AGENT_ID_BYTES),
		runId: agent.runId === null ? null : boundedString(agent.runId, "Clio Coder run id", MAX_AGENT_ID_BYTES),
		node: agent.node === null ? null : boundedString(agent.node, "Clio Coder node", MAX_AGENT_ID_BYTES),
	}));
}

export function safeToolTitle(kind: string): string {
	const labels: Readonly<Record<string, string>> = {
		read: "Read project content",
		edit: "Edit project content",
		delete: "Delete project content",
		move: "Move project content",
		search: "Search project content",
		execute: "Run a project command",
		think: "Reason about the task",
		fetch: "Fetch external content",
		switch_mode: "Change work mode",
		other: "Use a Clio Coder tool",
	};
	return labels[kind] ?? labels.other ?? "Use a Clio Coder tool";
}

/** Clio Coder's own tool title, with the project root hidden and unsafe characters removed. */
function presentableToolTitle(rawTitle: string, trustedRoot: string, kind: string): string {
	let text = rawTitle.replaceAll(trustedRoot, "[project]");
	text = Array.from(text).filter((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code >= 0x20 && code !== 0x7f;
	}).join("").trim();
	if (text.length === 0) return safeToolTitle(kind);
	const characters = Array.from(text);
	let used = 0;
	let end = 0;
	for (const character of characters) {
		const size = bytes(character);
		if (used + size > MAX_TITLE_BYTES - 1) break;
		used += size;
		end += 1;
	}
	const bounded = characters.slice(0, end).join("");
	return end < characters.length ? `${bounded}…` : bounded;
}

interface ValidatedInitialize {
	readonly agent: Readonly<{ name: string; version: string }>;
	readonly capabilities: WireClioCapabilities;
	readonly eventWorkspaceInstanceId: string | null;
}

function validateInitialize(value: unknown): ValidatedInitialize {
	if (!isRecord(value) || value.protocolVersion !== 1 || !isRecord(value.agentInfo)) {
		throw new HostError("internal", "Clio Coder returned an invalid ACP initialize result.");
	}
	if (value.agentInfo.name !== "clio-coder" || !isRecord(value.agentCapabilities)) {
		throw new HostError("internal", "The ACP peer did not identify as Clio Coder.");
	}
	const version = boundedString(value.agentInfo.version ?? "unknown", "Clio Coder version", 128);
	const capabilities = value.agentCapabilities;
	if (
		typeof capabilities.loadSession !== "boolean" || !isRecord(capabilities.promptCapabilities) ||
		!isRecord(capabilities.mcpCapabilities) || !isRecord(capabilities._meta)
	) throw new HostError("internal", "Clio Coder returned unsupported ACP capabilities.");
	const meta = capabilities._meta;
	const sessionMeta = meta["clio-coder/session"];
	if (!isRecord(sessionMeta) || sessionMeta.close !== true || meta["clio-coder/tools"] !== "mediated") {
		throw new HostError("internal", "Clio Coder did not advertise the mediated ACP session contract.");
	}
	if (!Array.isArray(value.authMethods)) {
		throw new HostError("internal", "Clio Coder returned invalid ACP auth metadata.");
	}
	const flag = (record: unknown, key: string): boolean => isRecord(record) && record[key] === true;
	const settingsMeta = meta["clio-coder/settings"];
	const targetsMeta = meta["clio-coder/targets"];
	const eventsMeta = meta["clio-coder/events"];
	let loopBlocked = false;
	let dispatchEvents = false;
	let eventWorkspaceInstanceId: string | null = null;
	if (isRecord(eventsMeta) && eventsMeta.version === 1 && Array.isArray(eventsMeta.kinds)) {
		const kinds: readonly unknown[] = eventsMeta.kinds;
		loopBlocked = eventsMeta.notification === "clio-coder/event" && kinds.includes("safety.loopBlocked");
		// The board needs the whole lifecycle. A peer that forwards only part of it
		// would leave runs stuck in a state nothing ever settles, so a partial
		// advertisement counts as absent rather than as a degraded board.
		dispatchEvents = loopBlocked &&
			(["dispatch.enqueued", "dispatch.started", "dispatch.progress", "dispatch.completed", "dispatch.failed"] as const)
				.every((kind) => kinds.includes(kind));
		if (loopBlocked) eventWorkspaceInstanceId = boundedString(eventsMeta.workspaceInstanceId, "event workspace", 128);
	}
	const agentMeta = meta["clio-coder/agent"];
	const agentAttribution = isRecord(agentMeta) && agentMeta.version === 1;
	return {
		agent: { name: "clio-coder", version },
		capabilities: {
			load: capabilities.loadSession,
			list: flag(sessionMeta, "list"),
			label: flag(sessionMeta, "label"),
			delete: flag(sessionMeta, "delete"),
			autonomy: flag(sessionMeta, "autonomy"),
			settings: flag(settingsMeta, "get_safe") && flag(settingsMeta, "patch_safe"),
			targets: flag(targetsMeta, "list") && flag(targetsMeta, "probe"),
			loopBlocked,
			dispatchEvents,
			agentAttribution,
		},
		eventWorkspaceInstanceId,
	};
}

interface ValidatedSessionMeta {
	readonly rawSessionId: string;
	readonly target: string | null;
	readonly model: string | null;
	readonly autonomy: WireAutonomyLevel;
	readonly createdAt: string;
	readonly resumed: boolean;
	readonly replayedTurns: number;
	readonly replayTruncated: boolean;
}

function validateSessionResult(value: unknown, mode: "new" | "load", requestedId: string | null): ValidatedSessionMeta {
	if (!isRecord(value)) throw new HostError("internal", "Clio Coder returned an invalid ACP session result.");
	const meta = isRecord(value._meta) ? value._meta["clio-coder/session"] : undefined;
	let rawSessionId: string;
	if (mode === "new") rawSessionId = boundedString(value.sessionId, "Clio Coder sessionId", MAX_SESSION_ID_BYTES);
	else if (requestedId === null) throw new HostError("internal", "A session load lost its identity.");
	else rawSessionId = requestedId;
	if (!isRecord(meta)) throw new HostError("internal", "Clio Coder omitted required session attribution.");
	for (const field of ["sessionId", "target", "model", "autonomy", "createdAt", "resumed"] as const) {
		if (!Object.hasOwn(meta, field)) {
			throw new HostError("internal", `Clio Coder omitted session attribution field ${field}.`);
		}
	}
	if (boundedString(meta.sessionId, "Clio Coder sessionId", MAX_SESSION_ID_BYTES) !== rawSessionId) {
		throw new HostError("internal", "Clio Coder attributed a different session than it bound.");
	}
	const expectedResumed = mode === "load";
	if (meta.resumed !== expectedResumed) {
		throw new HostError("internal", "Clio Coder returned inconsistent session resume attribution.");
	}
	let replayedTurns = 0;
	let replayTruncated = false;
	if (mode === "load") {
		if (!isRecord(meta.replayed)) {
			throw new HostError("internal", "Clio Coder omitted replay metadata on session load.");
		}
		replayedTurns = safeInteger(meta.replayed.turns) ?? -1;
		if (replayedTurns < 0 || typeof meta.replayed.truncated !== "boolean") {
			throw new HostError("internal", "Clio Coder returned invalid replay metadata.");
		}
		replayTruncated = meta.replayed.truncated;
	}
	return {
		rawSessionId,
		target: meta.target === null ? null : boundedString(meta.target, "session target", 128),
		model: meta.model === null ? null : boundedString(meta.model, "session model", 256),
		autonomy: autonomyLevel(meta.autonomy, "session autonomy"),
		createdAt: isoTimestamp(meta.createdAt, "session createdAt"),
		resumed: expectedResumed,
		replayedTurns,
		replayTruncated,
	};
}

function validateUsage(value: unknown): WireUsage {
	if (!isRecord(value)) throw new HostError("internal", "Clio Coder returned invalid bounded usage metadata.");
	const input = safeInteger(value.input);
	const output = safeInteger(value.output);
	const cacheRead = safeInteger(value.cacheRead);
	const cacheWrite = safeInteger(value.cacheWrite);
	const reasoning = safeInteger(value.reasoning);
	if (input === null || output === null || cacheRead === null || cacheWrite === null || reasoning === null) {
		throw new HostError("internal", "Clio Coder returned invalid bounded usage metadata.");
	}
	return { input, output, cacheRead, cacheWrite, reasoning };
}

interface ProjectedPromptResult {
	readonly stopReason: (typeof PROMPT_STOP_REASONS)[number];
	readonly usage: WireUsage;
}

function validatePromptResult(value: unknown): ProjectedPromptResult {
	if (!isRecord(value)) throw new HostError("internal", "Clio Coder returned an invalid ACP prompt result.");
	const stopReason = boundedString(value.stopReason, "Clio Coder stopReason", MAX_STOP_REASON_BYTES);
	if (!(PROMPT_STOP_REASONS as readonly string[]).includes(stopReason)) {
		throw new HostError("internal", "Clio Coder returned an unsupported ACP stop reason.");
	}
	if (!isRecord(value._meta)) throw new HostError("internal", "Clio Coder omitted bounded ACP usage metadata.");
	const usage = validateUsage(value._meta["clio-coder/usage"]);
	return { stopReason: stopReason as ProjectedPromptResult["stopReason"], usage };
}

type PublicClioFailure = Readonly<{ code: string; summary: string }>;

const CLIO_REMOTE_FAILURES: Readonly<Record<string, PublicClioFailure>> = {
	not_initialized: {
		code: "clio-coder-not-initialized",
		summary: "Clio Coder rejected the operation because its ACP session was not initialized.",
	},
	already_initialized: {
		code: "clio-coder-already-initialized",
		summary: "Clio Coder reported that its ACP connection was already initialized.",
	},
	protocol_version_unsupported: {
		code: "clio-coder-protocol-version-unsupported",
		summary: "Clio Coder does not support the ACP protocol version required by the GUI.",
	},
	invalid_params: { code: "clio-coder-invalid-params", summary: "Clio Coder rejected the bounded ACP parameters." },
	session_cwd_mismatch: {
		code: "clio-coder-session-cwd-mismatch",
		summary: "Clio Coder rejected the session because its project root did not match the launched workspace.",
	},
	session_limit: {
		code: "clio-coder-session-limit",
		summary: "Clio Coder rejected an unexpected additional session on this owned process.",
	},
	session_unknown: {
		code: "clio-coder-session-unknown",
		summary: "Clio Coder does not know that session for this project.",
	},
	session_open: {
		code: "clio-coder-session-open",
		summary: "Clio Coder cannot tell whether another process still holds that session, so it refused.",
	},
	prompt_active: { code: "clio-coder-prompt-active", summary: "Clio Coder is still working on the previous prompt." },
	prompt_not_admitted: { code: "clio-coder-prompt-not-admitted", summary: "Clio Coder could not admit this turn." },
	turn_failed: { code: "clio-coder-turn-failed", summary: "Clio Coder reported that the admitted turn failed." },
	permission_expired: {
		code: "clio-coder-permission-expired",
		summary: "An approval waited past Clio Coder's own ceiling. Clio Coder stopped the turn; nothing was denied.",
	},
	parse_error: { code: "clio-coder-parse-error", summary: "Clio Coder rejected input that did not parse as JSON." },
	invalid_request: {
		code: "clio-coder-invalid-request",
		summary: "Clio Coder rejected an invalid JSON-RPC request shape.",
	},
	method_not_found: { code: "clio-coder-method-not-found", summary: "This Clio Coder does not support that method." },
	internal_error: {
		code: "clio-coder-internal-error",
		summary: "Clio Coder reported an internal ACP handler failure.",
	},
	input_line_too_large: {
		code: "clio-coder-input-line-too-large",
		summary: "Clio Coder rejected an ACP input line that exceeded its bound.",
	},
	invalid_request_id: {
		code: "clio-coder-invalid-request-id",
		summary: "Clio Coder rejected an invalid JSON-RPC request identifier.",
	},
};

const CLIO_ADMISSION_FAILURES: Readonly<Record<string, PublicClioFailure>> = {
	"orchestrator-not-configured": {
		code: "clio-coder-admission-orchestrator-not-configured",
		summary: "Clio Coder has no orchestrator target configured. Choose one in Settings.",
	},
	"target-unknown": {
		code: "clio-coder-admission-target-unknown",
		summary: "Clio Coder does not recognize the configured target for this turn.",
	},
	"target-not-configured": {
		code: "clio-coder-admission-target-not-configured",
		summary: "Clio Coder requires a configured target before it can start this turn.",
	},
	"target-not-found": {
		code: "clio-coder-admission-target-not-found",
		summary: "Clio Coder could not locate the configured target for this turn.",
	},
	"runtime-not-registered": {
		code: "clio-coder-admission-runtime-not-registered",
		summary: "Clio Coder requires a registered runtime for the configured target.",
	},
	"model-not-configured": {
		code: "clio-coder-admission-model-not-configured",
		summary: "Clio Coder has no model configured for the orchestrator. Choose one in Settings.",
	},
	"chat-unsupported": {
		code: "clio-coder-admission-chat-unsupported",
		summary: "The configured Clio Coder target does not support chat turns.",
	},
	"streaming-unsupported": {
		code: "clio-coder-admission-streaming-unsupported",
		summary: "The configured Clio Coder target does not support streaming turns.",
	},
	"admission-failed": { code: "clio-coder-admission-failed", summary: "Clio Coder could not admit this turn." },
};

function protocolVersionFailure(supported: readonly number[] | undefined): PublicClioFailure {
	const versions = [...new Set((supported ?? []).filter((version) => Number.isSafeInteger(version) && version >= 0))]
		.sort((left, right) => left - right);
	const base = CLIO_REMOTE_FAILURES.protocol_version_unsupported!;
	return {
		code: base.code,
		summary: versions.length === 0 ? base.summary : `${base.summary} Supported versions: ${versions.join(", ")}.`,
	};
}

export function failureProjection(error: unknown, transportFailure: AcpFailure | null): PublicClioFailure & {
	readonly source: WireEventSource;
} {
	if (error instanceof AcpRemoteError && error.remote !== null) {
		const projected = error.remote.code === "protocol_version_unsupported"
			? protocolVersionFailure(error.remote.supported)
			: error.remote.code === "prompt_not_admitted" && error.remote.reason !== undefined
			? CLIO_ADMISSION_FAILURES[error.remote.reason] ?? CLIO_REMOTE_FAILURES.prompt_not_admitted
			: CLIO_REMOTE_FAILURES[error.remote.code];
		return {
			code: projected?.code ?? "clio-coder-operation-rejected",
			summary: projected?.summary ?? "Clio Coder rejected the bounded ACP operation.",
			source: "reported-by-clio",
		};
	}
	if (error instanceof AcpRemoteError) {
		return {
			code: "clio-coder-operation-rejected",
			summary: "Clio Coder rejected the bounded ACP operation.",
			source: "reported-by-clio",
		};
	}
	if (transportFailure !== null) {
		return { code: `acp-${transportFailure.code}`, summary: transportFailure.message, source: "observed-by-workbench" };
	}
	if (error instanceof AcpTimeoutError) {
		return {
			code: "acp-request-timeout",
			summary: `Clio Coder did not answer ${error.method} within its bound.`,
			source: "observed-by-workbench",
		};
	}
	if (error instanceof AcpClientError) {
		return {
			code: "acp-client-failure",
			summary: "The bounded Clio Coder ACP client could not complete this operation.",
			source: "observed-by-workbench",
		};
	}
	if (error instanceof HostError) {
		return { code: "acp-contract-failure", summary: error.message, source: "observed-by-workbench" };
	}
	return {
		code: "acp-contract-failure",
		summary: "Clio Coder did not satisfy the bounded GUI integration contract.",
		source: "observed-by-workbench",
	};
}

function sameLocations(left: readonly (readonly string[])[], right: readonly (readonly string[])[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function consumeProjectRedaction(
	pending: string,
	trustedRoot: string,
	final: boolean,
): Readonly<{ text: string; remainder: string }> {
	if (final) return { text: pending.replaceAll(trustedRoot, "[project]"), remainder: "" };
	let offset = 0;
	let text = "";
	while (offset < pending.length) {
		const matchAt = pending.indexOf(trustedRoot, offset);
		if (matchAt >= 0) {
			text += `${pending.slice(offset, matchAt)}[project]`;
			offset = matchAt + trustedRoot.length;
			continue;
		}
		const tail = pending.slice(offset);
		let retained = Math.min(tail.length, trustedRoot.length - 1);
		while (retained > 0 && !tail.endsWith(trustedRoot.slice(0, retained))) retained -= 1;
		text += tail.slice(0, tail.length - retained);
		return { text, remainder: tail.slice(tail.length - retained) };
	}
	return { text, remainder: "" };
}

export function createLocalClioLauncher(options: LocalClioLauncherOptions = {}): ClioLauncher {
	const executable = options.executable ?? "clio-coder";
	const prefixArgs = [...(options.prefixArgs ?? [])];
	const permissionTimeoutMs = options.permissionTimeoutMs ?? ACP_MAX_PERMISSION_TIMEOUT_MS;
	return {
		launch(trustedRoot) {
			const launch = localAcpLaunch(executable, trustedRoot, permissionTimeoutMs, prefixArgs);
			return {
				...launch,
				...(options.env === undefined ? {} : { env: options.env }),
				...(options.clearEnv === undefined ? {} : { clearEnv: options.clearEnv }),
			};
		},
	};
}

interface RealTool {
	readonly publicId: string;
	readonly rawTitle: string;
	readonly kind: string;
	readonly locations: readonly (readonly string[])[];
	terminal: boolean;
}

interface RealPermission {
	readonly publicId: string;
	readonly request: AcpPermissionRequest;
	readonly requestedAt: number;
	readonly escalateAt: number;
	readonly expiresAt: number;
	readonly timer: ReturnType<typeof setTimeout>;
}

type CancelReason = "operator" | "approval-unanswered" | "client-disconnected" | "host-shutdown";

interface Turn {
	readonly context: HostTurnContext;
	readonly promptSummary: string;
	readonly startedAt: number;
	promptActive: boolean;
	settling: boolean;
	cancelReason: CancelReason | null;
	streamBytes: number;
	streamTail: string;
	streamTailType: "message" | "thought" | null;
	/** Attribution reported on the frames feeding the open text buffer. */
	streamAgents: readonly WireAgentAttribution[];
	projectionClosed: boolean;
	updateCount: number;
	hasSubstantiveActivity: boolean;
	toolCounter: number;
	readonly tools: Map<string, RealTool>;
	permission: RealPermission | null;
	readonly done: Promise<void>;
	readonly resolveDone: () => void;
}

interface Replay {
	readonly context: HostTurnContext;
	currentTurn: number;
	turnCounter: number;
	streamTail: string;
	streamTailType: "message" | "thought" | "user" | null;
	toolCounter: number;
	readonly tools: Map<string, RealTool>;
	frames: number;
}

interface BoundSession {
	readonly rawSessionId: string;
	readonly publicId: string;
	target: string | null;
	model: string | null;
	autonomy: WireAutonomyLevel;
	autonomySource: "settings" | "session";
	readonly resumed: boolean;
	readonly replayedTurns: number;
	readonly replayTruncated: boolean;
	readonly createdAt: string;
	turnCounter: number;
}

interface Process {
	readonly client: AcpClient;
	readonly generation: string;
	initialized: ValidatedInitialize | null;
	session: BoundSession | null;
	turn: Turn | null;
	replay: Replay | null;
	transportFailure: AcpFailure | null;
	lastExtensionSequence: number;
	/** Dispatch runs Clio Coder has reported on this process, oldest first. */
	readonly fleet: Map<string, WireFleetRun>;
	retiring: boolean;
	readonly retired: Promise<void>;
	readonly resolveRetired: () => void;
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

/**
 * The per-project host. Public methods are the only entry points; every one of
 * them validates the caller's capability (turn id, permission id) before it
 * touches the child.
 */
export class ClioProjectHost {
	readonly project: HostProject;
	readonly #launcher: ClioLauncher;
	readonly #sink: HostSink;
	readonly #acpTiming: AcpClientTiming;
	readonly #promptTimeoutMs: number;
	readonly #permissionEscalateMs: number;
	readonly #permissionBudgetMs: number;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	readonly #publicSessionIds = new Map<string, string>();
	readonly #rawSessionIds = new Map<string, string>();
	#process: Process | null = null;
	#phase: WireClioSnapshot["phase"] = "starting";
	#lastFailure: WireClioSnapshot["lastFailure"] = null;
	#closed = false;
	#sessions: readonly WireSessionSummary[] = [];
	#sessionsTruncated = false;
	#settings: WireSettingsState | null = null;
	#targets: readonly WireTarget[] | null = null;
	#targetsTruncated = false;
	#serial: Promise<void> = Promise.resolve();

	constructor(options: ClioHostOptions) {
		validateProject(options.project);
		this.project = options.project;
		this.#launcher = options.launcher;
		this.#sink = options.sink;
		this.#acpTiming = options.acpTiming ?? {};
		this.#promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
		this.#permissionEscalateMs = options.permissionEscalateMs ?? DEFAULT_PERMISSION_ESCALATE_MS;
		this.#permissionBudgetMs = options.permissionBudgetMs ?? DEFAULT_PERMISSION_BUDGET_MS;
		if (
			!Number.isSafeInteger(this.#permissionBudgetMs) || this.#permissionBudgetMs < 1 ||
			this.#permissionBudgetMs > ACP_MAX_PERMISSION_TIMEOUT_MS ||
			!Number.isSafeInteger(this.#permissionEscalateMs) || this.#permissionEscalateMs < 1 ||
			this.#permissionEscalateMs > this.#permissionBudgetMs
		) {
			throw new HostError(
				"invalid",
				"Permission budgets must be bounded positive integers with escalation before expiry.",
			);
		}
		if (!Number.isSafeInteger(this.#promptTimeoutMs) || this.#promptTimeoutMs < 1) {
			throw new HostError("invalid", "promptTimeoutMs must be a bounded positive integer.");
		}
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? ((message) => console.error(message));
	}

	// ---------------------------------------------------------------- snapshot

	get phase(): WireClioSnapshot["phase"] {
		return this.#phase;
	}

	get sessions(): Readonly<{ sessions: readonly WireSessionSummary[]; truncated: boolean }> {
		return { sessions: this.#sessions, truncated: this.#sessionsTruncated };
	}

	get settings(): WireSettingsState | null {
		return this.#settings;
	}

	get targets(): readonly WireTarget[] | null {
		return this.#targets;
	}

	/** True when Clio Coder's own byte budget dropped a target or model from the list. */
	get targetsTruncated(): boolean {
		return this.#targetsTruncated;
	}

	/** Dispatch runs reported on the live process, oldest first. Empty before a child exists. */
	get fleet(): readonly WireFleetRun[] {
		return this.#process === null ? [] : [...this.#process.fleet.values()];
	}

	get generation(): string | null {
		return this.#process?.generation ?? null;
	}

	get activeTurnId(): string | null {
		return this.#process?.turn?.context.turnId ?? null;
	}

	get hasActivePrompt(): boolean {
		return this.#process?.turn !== null && this.#process?.turn !== undefined;
	}

	get boundSessionPublicId(): string | null {
		return this.#process?.session?.publicId ?? null;
	}

	snapshot(): WireClioSnapshot {
		const process = this.#process;
		const session = process?.session ?? null;
		return {
			phase: this.#phase,
			agent: process?.initialized?.agent ?? null,
			capabilities: process?.initialized?.capabilities ?? null,
			session: session === null ? null : this.#boundSessionDto(session),
			lastFailure: this.#lastFailure,
			checkedAt: new Date(this.#now()).toISOString(),
		};
	}

	#boundSessionDto(session: BoundSession): WireBoundSession {
		return {
			id: session.publicId,
			target: session.target,
			model: session.model,
			autonomy: session.autonomy,
			autonomySource: session.autonomySource,
			resumed: session.resumed,
			replayedTurns: session.replayedTurns,
			replayTruncated: session.replayTruncated,
			createdAt: session.createdAt,
		};
	}

	// ---------------------------------------------------------------- lifecycle

	/** Spawns the child and initializes it. Resolves when the host is `unbound` or `failed`. */
	open(): Promise<void> {
		return this.#serialize(async () => {
			this.#assertOpen();
			if (this.#process !== null) return;
			await this.#spawn();
		});
	}

	async close(): Promise<void> {
		if (this.#closed) {
			await this.#process?.retired;
			return;
		}
		this.#closed = true;
		await this.#serialize(async () => {
			const process = this.#process;
			if (process === null) return;
			if (process.turn !== null) await this.#cancelTurn(process, process.turn, "host-shutdown");
			await this.#retire(process, { closeSession: true });
			this.#setPhase("closed");
		});
	}

	// ---------------------------------------------------------------- sessions

	newSession(): Promise<void> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			if (process.turn !== null) {
				throw new HostError("conflict", "Clio Coder is still working. Cancel or wait before starting a new session.");
			}
			let target = process;
			if (process.session !== null) {
				await this.#retire(process, { closeSession: true });
				target = await this.#spawn();
			}
			await this.#bind(target, "new", null);
			await this.#refreshSessions(target, false);
		});
	}

	loadSession(publicSessionId: string): Promise<void> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			if (!process.initialized?.capabilities.load) {
				throw new HostError("unsupported", "This Clio Coder cannot resume sessions.");
			}
			if (process.turn !== null) {
				throw new HostError("conflict", "Clio Coder is still working. Cancel or wait before resuming a session.");
			}
			const rawSessionId = this.#rawSessionIds.get(publicSessionId);
			if (rawSessionId === undefined) throw new HostError("not-found", "That session is not in this project's list.");
			if (process.session?.rawSessionId === rawSessionId) return;
			let target = process;
			if (process.session !== null) {
				await this.#retire(process, { closeSession: true });
				target = await this.#spawn();
			}
			await this.#bind(target, "load", rawSessionId);
			await this.#refreshSessions(target, false);
		});
	}

	closeSession(): Promise<void> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			if (process.session === null) return;
			if (process.turn !== null) {
				throw new HostError("conflict", "Clio Coder is still working. Cancel or wait before closing the session.");
			}
			await this.#retire(process, { closeSession: true });
			const fresh = await this.#spawn();
			await this.#refreshSessions(fresh, false);
		});
	}

	listSessions(): Promise<void> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			await this.#refreshSessions(process, true);
		});
	}

	labelSession(publicSessionId: string, label: string): Promise<void> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			if (!process.initialized?.capabilities.label) {
				throw new HostError("unsupported", "This Clio Coder cannot label sessions.");
			}
			const rawSessionId = this.#rawSessionIds.get(publicSessionId);
			if (rawSessionId === undefined) throw new HostError("not-found", "That session is not in this project's list.");
			await this.#request(process, "clio-coder/session/label", { sessionId: rawSessionId, label }, METHOD_TIMEOUT_MS);
			await this.#refreshSessions(process, true);
		});
	}

	deleteSession(publicSessionId: string): Promise<void> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			if (!process.initialized?.capabilities.delete) {
				throw new HostError("unsupported", "This Clio Coder cannot delete sessions.");
			}
			const rawSessionId = this.#rawSessionIds.get(publicSessionId);
			if (rawSessionId === undefined) throw new HostError("not-found", "That session is not in this project's list.");
			if (process.session?.rawSessionId === rawSessionId) {
				throw new HostError("refused", "Close this session before deleting it.");
			}
			await this.#request(process, "clio-coder/session/delete", { sessionId: rawSessionId }, METHOD_TIMEOUT_MS);
			this.#rawSessionIds.delete(publicSessionId);
			await this.#refreshSessions(process, true);
		});
	}

	// ---------------------------------------------------------------- settings

	getSettings(): Promise<void> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			await this.#refreshSettings(process, true);
		});
	}

	patchSettings(patch: Readonly<Record<string, string | null>>): Promise<void> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			if (!process.initialized?.capabilities.settings) {
				throw new HostError("unsupported", "This Clio Coder cannot change settings over ACP.");
			}
			if (process.turn !== null) {
				throw new HostError("conflict", "Clio Coder is still working. Settings change between turns.");
			}
			for (const key of Object.keys(patch)) {
				if (!(SAFE_SETTING_KEYS as readonly string[]).includes(key)) {
					throw new HostError("invalid", "That setting is not one the GUI may change.");
				}
			}
			const result = await this.#request(
				process,
				"clio-coder/settings/patch_safe",
				{ patch: { ...patch } },
				METHOD_TIMEOUT_MS,
			);
			this.#settings = this.#settingsDto(result);
			this.#sink.emit({ type: "settings.state", projectId: this.project.projectId, settings: this.#settings });
		});
	}

	listTargets(): Promise<void> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			await this.#refreshTargets(process, true);
		});
	}

	probeTarget(targetId: string): Promise<void> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			if (!process.initialized?.capabilities.targets) {
				throw new HostError("unsupported", "This Clio Coder cannot probe targets over ACP.");
			}
			if (this.#targets === null) await this.#refreshTargets(process, false);
			if (!(this.#targets ?? []).some((target) => target.id === targetId)) {
				throw new HostError("not-found", "That target is not configured.");
			}
			const result = await this.#request(process, "clio-coder/targets/probe", { targetId }, PROBE_TIMEOUT_MS);
			if (
				!isRecord(result) || typeof result.healthy !== "boolean" ||
				boundedString(result.targetId, "probe targetId", 128) !== targetId ||
				!Object.hasOwn(result, "latencyMs") || !Object.hasOwn(result, "reason")
			) {
				throw new HostError("internal", "Clio Coder returned an invalid probe result.");
			}
			const latency = result.latencyMs === null ? null : safeInteger(result.latencyMs);
			if (result.latencyMs !== null && latency === null) {
				throw new HostError("internal", "Clio Coder returned an invalid probe latency.");
			}
			const reason = result.reason === null ? null : boundedString(result.reason, "probe reason", 64);
			if (reason !== null && !(PROBE_REASONS as readonly string[]).includes(reason)) {
				throw new HostError("internal", "Clio Coder returned an unknown probe reason.");
			}
			const health: WireTargetHealth = {
				healthy: result.healthy,
				latencyMs: latency,
				reason,
				probedAt: new Date(this.#now()).toISOString(),
			};
			this.#targets = (this.#targets ?? []).map((target) => target.id === targetId ? { ...target, health } : target);
			this.#sink.emit({
				type: "targets.state",
				projectId: this.project.projectId,
				targets: this.#targets,
				truncated: this.#targetsTruncated,
			});
			this.#sink.emit({ type: "targets.probed", projectId: this.project.projectId, targetId, health });
		});
	}

	setAutonomy(level: WireAutonomyLevel): Promise<void> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			if (!process.initialized?.capabilities.autonomy) {
				throw new HostError("unsupported", "This Clio Coder cannot change autonomy over ACP.");
			}
			const session = process.session;
			if (session === null) throw new HostError("not-ready", "Start or resume a session before changing its autonomy.");
			if (process.turn !== null) {
				throw new HostError("conflict", "Clio Coder is still working. Autonomy changes between turns.");
			}
			const result = await this.#request(
				process,
				"clio-coder/session/autonomy",
				{ sessionId: session.rawSessionId, level },
				METHOD_TIMEOUT_MS,
			);
			if (!isRecord(result)) throw new HostError("internal", "Clio Coder returned an invalid autonomy result.");
			const autonomy = autonomyLevel(result.level, "autonomy level");
			if (result.source !== "settings" && result.source !== "session") {
				throw new HostError("internal", "Clio Coder returned an invalid autonomy source.");
			}
			session.autonomy = autonomy;
			session.autonomySource = result.source;
			this.#emitState();
		});
	}

	// ---------------------------------------------------------------- turns

	startTurn(promptText: string): Promise<HostTurnContext> {
		return this.#serialize(async () => {
			const process = await this.#requireProcess();
			const session = process.session;
			if (session === null) throw new HostError("not-ready", "Start or resume a session before sending a prompt.");
			const prompt = promptText.trim();
			if (prompt.length === 0 || bytes(prompt) > MAX_PROMPT_BYTES) {
				throw new HostError("invalid", "The prompt must contain at most 8 KiB of non-blank text.");
			}
			if (process.turn !== null) {
				throw new HostError("conflict", "Clio Coder is still working on the previous prompt. Cancel it or wait.");
			}
			session.turnCounter += 1;
			const context: HostTurnContext = {
				projectId: this.project.projectId,
				generation: process.generation,
				sessionId: session.publicId,
				turnId: `turn-${session.turnCounter}`,
			};
			const completion = deferred();
			const turn: Turn = {
				context,
				promptSummary: prompt.slice(0, 2_048),
				startedAt: this.#now(),
				promptActive: false,
				settling: false,
				cancelReason: null,
				streamBytes: 0,
				streamTail: "",
				streamTailType: null,
				streamAgents: [],
				projectionClosed: false,
				updateCount: 0,
				hasSubstantiveActivity: false,
				toolCounter: 0,
				tools: new Map(),
				permission: null,
				done: completion.promise,
				resolveDone: completion.resolve,
			};
			process.turn = turn;
			this.#setPhase("running");
			this.#sink.emit({
				type: "turn.started",
				context,
				payload: {
					promptSummary: turn.promptSummary,
					origin: "live",
					startedAt: new Date(turn.startedAt).toISOString(),
					source: "observed-by-workbench",
				},
			});
			void this.#drivePrompt(process, turn, prompt);
			return context;
		});
	}

	resolvePermission(turnId: string, permissionId: string, decision: "allow_once" | "reject_once"): Promise<void> {
		return this.#serialize(async () => {
			const process = this.#process;
			const turn = process?.turn ?? null;
			if (process === null || turn === null || turn.context.turnId !== turnId) {
				throw new HostError("not-found", "That permission does not belong to the active turn.");
			}
			if (turn.permission === null || turn.permission.publicId !== permissionId) {
				throw new HostError("not-found", "That permission is no longer waiting.");
			}
			try {
				await this.#settlePermission(turn, decision === "allow_once" ? "allow-once" : "reject", decision, "running");
			} catch {
				await this.#failTurn(process, turn, {
					code: "permission-settlement-failed",
					summary: "The GUI could not deliver the permission decision to Clio Coder.",
					source: "observed-by-workbench",
				});
				throw new HostError("internal", "The permission decision could not be delivered safely.");
			}
		});
	}

	cancelTurn(turnId: string, reason: CancelReason = "operator"): Promise<void> {
		return this.#serialize(async () => {
			const process = this.#process;
			const turn = process?.turn ?? null;
			if (process === null || turn === null || turn.context.turnId !== turnId) {
				throw new HostError("not-found", "That turn is not active.");
			}
			await this.#cancelTurn(process, turn, reason);
		});
	}

	/** Called by the runtime when the last browser connection goes away for longer than its grace. */
	abandon(): Promise<void> {
		return this.#serialize(async () => {
			const process = this.#process;
			const turn = process?.turn ?? null;
			if (process === null || turn === null) return;
			await this.#cancelTurn(process, turn, "client-disconnected");
		});
	}

	// ---------------------------------------------------------------- internals

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const queued = this.#serial.then(operation, operation);
		this.#serial = queued.then(() => undefined, () => undefined);
		return queued;
	}

	#assertOpen(): void {
		if (this.#closed) throw new HostError("not-ready", "This project is closed.");
	}

	async #requireProcess(): Promise<Process> {
		this.#assertOpen();
		if (this.#process === null || this.#process.retiring) {
			// A crashed child is replaced on the next command so the operator is never stuck.
			return await this.#spawn();
		}
		if (this.#process.initialized === null) throw new HostError("not-ready", "Clio Coder is still starting.");
		return this.#process;
	}

	#setPhase(phase: WireClioSnapshot["phase"]): void {
		this.#phase = phase;
		this.#emitState();
	}

	#emitState(): void {
		this.#sink.emit({ type: "clio-coder.state", projectId: this.project.projectId, snapshot: this.snapshot() });
	}

	#publicSessionId(rawSessionId: string): string {
		let publicId = this.#publicSessionIds.get(rawSessionId);
		if (publicId === undefined) {
			publicId = `session-${crypto.randomUUID()}`;
			this.#publicSessionIds.set(rawSessionId, publicId);
			this.#rawSessionIds.set(publicId, rawSessionId);
		}
		return publicId;
	}

	async #spawn(): Promise<Process> {
		this.#setPhase("starting");
		let process: Process | null = null;
		const retired = deferred();
		const client = AcpClient.spawn(this.#launcher.launch(this.project.trustedRoot), {
			onUpdate: (generation, update) => {
				if (process === null || generation !== process.generation) {
					throw new HostError("internal", "A stale Clio Coder update crossed its process generation.");
				}
				this.#handleUpdate(process, update);
			},
			onPermission: (generation, request) => {
				if (process === null || generation !== process.generation) {
					throw new HostError("internal", "A stale Clio Coder permission crossed its process generation.");
				}
				this.#handlePermission(process, request);
			},
			onExtensionEvent: (generation, event) => {
				if (process === null || generation !== process.generation) return;
				this.#handleExtensionEvent(process, event);
			},
			onFailure: (generation, failure) => {
				if (process === null || generation !== process.generation) return;
				process.transportFailure = failure;
				void this.#handleProcessFailure(process, failure);
			},
		}, this.#acpTiming);
		process = {
			client,
			generation: client.generation,
			initialized: null,
			session: null,
			turn: null,
			replay: null,
			transportFailure: null,
			lastExtensionSequence: 0,
			fleet: new Map(),
			retiring: false,
			retired: retired.promise,
			resolveRetired: retired.resolve,
		};
		this.#process = process;
		try {
			const result = await client.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
					_meta: { "clio-coder/events": EVENT_OPT_IN },
				},
				clientInfo: CLIENT_INFO,
			}, INITIALIZE_TIMEOUT_MS);
			process.initialized = validateInitialize(result);
			this.#lastFailure = null;
			this.#setPhase("unbound");
			await this.#refreshSessions(process, false);
			return process;
		} catch (error) {
			const failure = failureProjection(error, process.transportFailure);
			this.#lastFailure = { code: failure.code, summary: failure.summary };
			await this.#retire(process, { closeSession: false });
			this.#setPhase("failed");
			throw new HostError("not-ready", failure.summary);
		}
	}

	async #retire(process: Process, options: Readonly<{ closeSession: boolean }>): Promise<void> {
		if (process.retiring) {
			await process.retired;
			return;
		}
		process.retiring = true;
		try {
			const turn = process.turn;
			if (turn !== null && !turn.settling) {
				await this.#finishTurn(process, turn, {
					outcome: "canceled",
					code: "clio-coder-process-retired",
					summary: "The Clio Coder process was retired before the turn finished.",
					stopReason: "cancelled",
					source: "observed-by-workbench",
				});
			}
			await process.client.retire({
				sessionId: process.session?.rawSessionId,
				supportsClose: options.closeSession && process.initialized !== null,
				cancelActive: turn !== null,
			});
		} finally {
			process.session = null;
			if (this.#process === process) this.#process = null;
			process.resolveRetired();
		}
	}

	async #handleProcessFailure(process: Process, failure: AcpFailure): Promise<void> {
		if (process.retiring) return;
		this.#lastFailure = { code: `acp-${failure.code}`, summary: failure.message };
		const turn = process.turn;
		if (turn !== null && !turn.settling) {
			await this.#finishTurn(process, turn, {
				outcome: "failed",
				code: `acp-${failure.code}`,
				summary: failure.message,
				source: "observed-by-workbench",
			}, { settleToIdle: false });
		}
		await this.#retire(process, { closeSession: false });
		this.#setPhase("failed");
	}

	async #bind(process: Process, mode: "new" | "load", rawSessionId: string | null): Promise<void> {
		if (process.session !== null) throw new HostError("conflict", "This process already hosts a session.");
		const publicId = mode === "load" && rawSessionId !== null ? this.#publicSessionId(rawSessionId) : null;
		if (mode === "load" && rawSessionId !== null && publicId !== null) {
			process.replay = {
				context: {
					projectId: this.project.projectId,
					generation: process.generation,
					sessionId: publicId,
					turnId: "turn-replay-0",
				},
				currentTurn: 0,
				turnCounter: 0,
				streamTail: "",
				streamTailType: null,
				toolCounter: 0,
				tools: new Map(),
				frames: 0,
			};
		}
		let result: unknown;
		try {
			result = mode === "new"
				? await this.#request(
					process,
					"session/new",
					{ cwd: this.project.trustedRoot, mcpServers: [] },
					NEW_SESSION_TIMEOUT_MS,
				)
				: await this.#request(
					process,
					"session/load",
					{ sessionId: rawSessionId, cwd: this.project.trustedRoot, mcpServers: [] },
					LOAD_SESSION_TIMEOUT_MS,
				);
		} catch (error) {
			process.replay = null;
			throw error;
		}
		let meta: ValidatedSessionMeta;
		try {
			meta = validateSessionResult(result, mode, rawSessionId);
		} catch (error) {
			process.replay = null;
			const failure = failureProjection(error, process.transportFailure);
			this.#lastFailure = { code: failure.code, summary: failure.summary };
			await this.#retire(process, { closeSession: false });
			this.#setPhase("failed");
			throw new HostError("not-ready", failure.summary);
		}
		this.#flushReplayText(process);
		const replay = process.replay;
		process.replay = null;
		process.session = {
			rawSessionId: meta.rawSessionId,
			publicId: this.#publicSessionId(meta.rawSessionId),
			target: meta.target,
			model: meta.model,
			autonomy: meta.autonomy,
			autonomySource: "settings",
			resumed: meta.resumed,
			replayedTurns: meta.replayedTurns,
			replayTruncated: meta.replayTruncated,
			createdAt: meta.createdAt,
			turnCounter: replay?.turnCounter ?? 0,
		};
		this.#setPhase("idle");
	}

	async #request(process: Process, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		try {
			return await process.client.request(method, params, timeoutMs);
		} catch (error) {
			throw this.#hostErrorFrom(error, process);
		}
	}

	#hostErrorFrom(error: unknown, process: Process): HostError {
		if (error instanceof HostError) return error;
		const projected = failureProjection(error, process.transportFailure);
		if (error instanceof AcpRemoteError && error.remote !== null) {
			const code = error.remote.code;
			const hostCode: HostError["code"] = code === "prompt_active"
				? "conflict"
				: code === "session_unknown"
				? "not-found"
				: code === "session_open"
				? "refused"
				: code === "method_not_found"
				? "unsupported"
				: code === "invalid_params"
				? "invalid"
				: "not-ready";
			return new HostError(hostCode, projected.summary);
		}
		return new HostError("not-ready", projected.summary);
	}

	async #refreshSessions(process: Process, emitError: boolean): Promise<void> {
		if (!process.initialized?.capabilities.list) {
			this.#sessions = process.session === null ? [] : [this.#hostedOnlySummary(process.session)];
			this.#sessionsTruncated = false;
			this.#sink.emit({
				type: "session.list",
				projectId: this.project.projectId,
				sessions: this.#sessions,
				truncated: false,
			});
			return;
		}
		let result: unknown;
		try {
			result = await this.#request(
				process,
				"clio-coder/session/list",
				{ limit: MAX_SESSIONS_LISTED },
				METHOD_TIMEOUT_MS,
			);
		} catch (error) {
			if (emitError) throw error;
			return;
		}
		if (!isRecord(result) || !Array.isArray(result.sessions) || typeof result.truncated !== "boolean") {
			throw new HostError("internal", "Clio Coder returned an invalid session list.");
		}
		if (result.sessions.length > MAX_SESSIONS_LISTED) {
			throw new HostError("internal", "Clio Coder returned too many sessions.");
		}
		const sessions: WireSessionSummary[] = [];
		for (const entry of result.sessions) {
			if (!isRecord(entry)) throw new HostError("internal", "Clio Coder returned an invalid session entry.");
			for (
				const field of [
					"sessionId",
					"label",
					"preview",
					"createdAt",
					"updatedAt",
					"turns",
					"target",
					"model",
					"state",
					"hosted",
				] as const
			) {
				if (!Object.hasOwn(entry, field)) throw new HostError("internal", `Clio Coder omitted session field ${field}.`);
			}
			const rawSessionId = boundedString(entry.sessionId, "session id", MAX_SESSION_ID_BYTES);
			const state = entry.state === "open"
				? "open"
				: entry.state === "closed"
				? "closed"
				: entry.state === "unknown"
				? "unknown"
				: null;
			if (state === null) throw new HostError("internal", "Clio Coder returned an unknown session state.");
			const turns = safeInteger(entry.turns);
			if (turns === null) throw new HostError("internal", "Clio Coder returned an invalid turn count.");
			if (
				typeof entry.preview !== "string" || bytes(entry.preview) > 512 || hasControlCharacter(entry.preview) ||
				typeof entry.hosted !== "boolean"
			) throw new HostError("internal", "Clio Coder returned invalid session presentation fields.");
			sessions.push({
				id: this.#publicSessionId(rawSessionId),
				label: requiredNullableBoundedString(entry, "label", "session label", 256),
				preview: entry.preview.replaceAll(this.project.trustedRoot, "[project]"),
				createdAt: isoTimestamp(entry.createdAt, "session createdAt"),
				updatedAt: isoTimestamp(entry.updatedAt, "session updatedAt"),
				turns,
				target: requiredNullableBoundedString(entry, "target", "session target", 128),
				model: requiredNullableBoundedString(entry, "model", "session model", 256),
				state,
				hosted: entry.hosted,
			});
		}
		this.#sessions = sessions;
		// The server also drops trailing entries to stay under its response byte
		// budget; either signal means the operator is not seeing every session.
		const byteBudgetTruncated = isRecord(result._meta) && result._meta["clio-coder/truncated"] === true;
		this.#sessionsTruncated = result.truncated || byteBudgetTruncated;
		this.#sink.emit({
			type: "session.list",
			projectId: this.project.projectId,
			sessions: this.#sessions,
			truncated: this.#sessionsTruncated,
		});
	}

	#hostedOnlySummary(session: BoundSession): WireSessionSummary {
		return {
			id: session.publicId,
			label: null,
			preview: "",
			createdAt: session.createdAt,
			updatedAt: session.createdAt,
			turns: session.turnCounter,
			target: session.target,
			model: session.model,
			state: "open",
			hosted: true,
		};
	}

	async #refreshSettings(process: Process, emitError: boolean): Promise<void> {
		if (!process.initialized?.capabilities.settings) {
			if (emitError) throw new HostError("unsupported", "This Clio Coder does not expose settings over ACP.");
			return;
		}
		let result: unknown;
		try {
			result = await this.#request(process, "clio-coder/settings/get_safe", {}, METHOD_TIMEOUT_MS);
		} catch (error) {
			if (emitError) throw error;
			return;
		}
		this.#settings = this.#settingsDto(result);
		this.#sink.emit({ type: "settings.state", projectId: this.project.projectId, settings: this.#settings });
	}

	#settingsDto(result: unknown): WireSettingsState {
		if (!isRecord(result) || !isRecord(result.settings) || !Array.isArray(result.editable)) {
			throw new HostError("internal", "Clio Coder returned an invalid settings projection.");
		}
		if (!isRecord(result.settings.chat) || !isRecord(result.settings.safety)) {
			throw new HostError("internal", "Clio Coder omitted required safe settings.");
		}
		const chat = result.settings.chat;
		for (const field of ["target", "model", "thinkingLevel"] as const) {
			if (!Object.hasOwn(chat, field)) throw new HostError("internal", `Clio Coder omitted setting chat.${field}.`);
		}
		if (!Object.hasOwn(result.settings.safety, "autonomy")) {
			throw new HostError("internal", "Clio Coder omitted setting safety.autonomy.");
		}
		const thinkingLevel = boundedString(chat.thinkingLevel, "chat.thinkingLevel", 16);
		const autonomy = boundedString(result.settings.safety.autonomy, "safety.autonomy", 16);
		if (!(THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) {
			throw new HostError("internal", "Clio Coder returned an unknown thinking level.");
		}
		if (!(AUTONOMY_LEVELS as readonly string[]).includes(autonomy)) {
			throw new HostError("internal", "Clio Coder returned an unknown autonomy level.");
		}
		const settings: Record<string, string | null> = {
			"chat.target": requiredNullableBoundedString(
				chat,
				"target",
				"chat.target",
				128,
			),
			"chat.model": requiredNullableBoundedString(chat, "model", "chat.model", 256),
			"chat.thinkingLevel": thinkingLevel,
			"safety.autonomy": autonomy,
		};
		const editable = result.editable;
		const editableSet = new Set(editable);
		if (
			editable.length !== SAFE_SETTING_KEYS.length || editableSet.size !== SAFE_SETTING_KEYS.length ||
			!SAFE_SETTING_KEYS.every((key) => editableSet.has(key))
		) throw new HostError("internal", "Clio Coder returned an invalid editable settings set.");
		const targets = this.#targets ?? [];
		const selectedTarget = settings["chat.target"];
		const options: Record<string, readonly string[]> = {
			"chat.thinkingLevel": [...THINKING_LEVELS],
			"safety.autonomy": [...AUTONOMY_LEVELS],
			"chat.target": targets.map((target) => target.id),
			"chat.model": targets.find((target) => target.id === selectedTarget)?.models ?? [],
		};
		return { settings, editable: [...SAFE_SETTING_KEYS], options, checkedAt: new Date(this.#now()).toISOString() };
	}

	async #refreshTargets(process: Process, emitError: boolean): Promise<void> {
		if (!process.initialized?.capabilities.targets) {
			if (emitError) throw new HostError("unsupported", "This Clio Coder does not expose targets over ACP.");
			return;
		}
		let result: unknown;
		try {
			result = await this.#request(process, "clio-coder/targets/list", {}, METHOD_TIMEOUT_MS);
		} catch (error) {
			if (emitError) throw error;
			return;
		}
		if (!isRecord(result) || !Array.isArray(result.targets) || result.targets.length > 64) {
			throw new HostError("internal", "Clio Coder returned an invalid target list.");
		}
		const previous = new Map((this.#targets ?? []).map((target) => [target.id, target.health]));
		const targets: WireTarget[] = [];
		for (const entry of result.targets) {
			if (!isRecord(entry) || !Array.isArray(entry.models) || entry.models.length > 64) {
				throw new HostError("internal", "Clio Coder returned an invalid target entry.");
			}
			if (typeof entry.isOrchestrator !== "boolean") {
				throw new HostError("internal", "Clio Coder returned an invalid target role.");
			}
			const id = boundedString(entry.id, "target id", 128);
			targets.push({
				id,
				runtime: boundedString(entry.runtime, "target runtime", 64),
				models: entry.models.map((model) => boundedString(model, "target model", 256)),
				isOrchestrator: entry.isOrchestrator,
				health: previous.get(id) ?? null,
			});
		}
		this.#targets = targets;
		// The server also drops trailing entries to stay inside its response byte
		// budget, so the operator is not seeing every configured target or model.
		this.#targetsTruncated = isRecord(result._meta) && result._meta["clio-coder/truncated"] === true;
		this.#sink.emit({
			type: "targets.state",
			projectId: this.project.projectId,
			targets,
			truncated: this.#targetsTruncated,
		});
		if (this.#settings !== null) {
			// Options depend on the target list; re-project so selects stay truthful.
			this.#settings = {
				...this.#settings,
				options: this.#settingsDto({ settings: this.#nestedSettings(), editable: this.#settings.editable }).options,
			};
			this.#sink.emit({ type: "settings.state", projectId: this.project.projectId, settings: this.#settings });
		}
	}

	#nestedSettings(): Record<string, unknown> {
		const flat = this.#settings?.settings ?? {};
		return {
			chat: {
				target: flat["chat.target"] ?? null,
				model: flat["chat.model"] ?? null,
				thinkingLevel: flat["chat.thinkingLevel"] ?? null,
			},
			safety: { autonomy: flat["safety.autonomy"] ?? null },
		};
	}

	/** Loads settings and targets once after bind; failures are silent because both surfaces are optional. */
	async primeSettings(): Promise<void> {
		await this.#serialize(async () => {
			const process = this.#process;
			if (process === null || process.initialized === null) return;
			await this.#refreshTargets(process, false);
			await this.#refreshSettings(process, false);
		});
	}

	// ---------------------------------------------------------------- prompt driver

	async #drivePrompt(process: Process, turn: Turn, prompt: string): Promise<void> {
		const session = process.session;
		if (session === null) return;
		try {
			turn.promptActive = true;
			const result = await process.client.request("session/prompt", {
				sessionId: session.rawSessionId,
				prompt: [{ type: "text", text: prompt }],
			}, this.#promptTimeoutMs);
			turn.promptActive = false;
			if (turn.settling) return;
			const projected = validatePromptResult(result);
			const incomplete = [...turn.tools.values()].filter((tool) => !tool.terminal);
			for (const tool of incomplete) {
				tool.terminal = true;
				this.#sink.emit({
					type: "turn.tool",
					context: turn.context,
					payload: {
						toolCallId: tool.publicId,
						title: safeToolTitle(tool.kind),
						kind: tool.kind,
						status: "failed",
						summary: "Clio Coder ended before reporting a terminal tool status.",
						locations: tool.locations.map((segments) => ({ segments })),
						agents: [],
						source: "observed-by-workbench",
					},
				});
			}
			if (incomplete.length > 0) {
				await this.#finishTurn(process, turn, {
					outcome: "failed",
					code: "incomplete-tool-lifecycle",
					summary: "Clio Coder ended with an incomplete tool lifecycle.",
					stopReason: projected.stopReason,
					usage: projected.usage,
					source: "observed-by-workbench",
				});
				return;
			}
			this.#flushText(turn);
			if (projected.stopReason === "end_turn" && !turn.hasSubstantiveActivity) {
				await this.#finishTurn(process, turn, {
					outcome: "failed",
					code: "empty-turn",
					summary: "Clio Coder returned an empty turn without any message or tool activity.",
					stopReason: projected.stopReason,
					usage: projected.usage,
					source: "observed-on-acp",
				});
				return;
			}
			const completed = projected.stopReason === "end_turn";
			const cancelled = projected.stopReason === "cancelled";
			const cancelSummary: Record<CancelReason, PublicClioFailure> = {
				operator: { code: "operator-cancelled", summary: "You stopped this turn." },
				"approval-unanswered": {
					code: "approval-unanswered",
					summary:
						"An approval waited unanswered for the whole budget, so the GUI stopped the turn. Clio Coder was not told no; send a new prompt to continue.",
				},
				"client-disconnected": {
					code: "client-disconnected",
					summary: "The GUI window went away, so the turn was stopped. Send a new prompt to continue.",
				},
				"host-shutdown": { code: "host-shutdown", summary: "The GUI shut down and stopped the turn." },
			};
			const cancel = turn.cancelReason === null
				? { code: "clio-coder-cancelled", summary: "Clio Coder reported that the turn was cancelled." }
				: cancelSummary[turn.cancelReason];
			await this.#finishTurn(process, turn, {
				outcome: completed ? "completed" : cancelled ? "canceled" : "failed",
				code: completed ? "clio-coder-completed" : cancelled ? cancel.code : `clio-coder-${projected.stopReason}`,
				summary: completed
					? "Clio Coder finished this turn."
					: cancelled
					? cancel.summary
					: `Clio Coder stopped the turn with ${projected.stopReason.replaceAll("_", " ")}.`,
				stopReason: projected.stopReason,
				usage: projected.usage,
				source: cancelled && turn.cancelReason !== null ? "observed-by-workbench" : "reported-by-clio",
			});
		} catch (error) {
			const promptTimedOut = error instanceof AcpTimeoutError && error.method === "session/prompt";
			if (!promptTimedOut) turn.promptActive = false;
			if (turn.settling) return;
			const terminal = failureProjection(error, process.transportFailure);
			if (promptTimedOut) {
				// The child is unresponsive on the prompt: ask it to stop before its
				// stdin closes, then fail closed by retiring it.
				const session = process.session;
				if (session !== null) {
					try {
						await process.client.notify("session/cancel", { sessionId: session.rawSessionId });
					} catch {
						// A dead child settles through its failure path.
					}
				}
				await this.#finishTurn(process, turn, { outcome: "failed", ...terminal }, { settleToIdle: false });
				await this.#retire(process, { closeSession: false });
				this.#lastFailure = { code: terminal.code, summary: terminal.summary };
				this.#setPhase("failed");
				return;
			}
			await this.#finishTurn(process, turn, { outcome: "failed", ...terminal });
		}
	}

	#handleUpdate(process: Process, update: ValidatedAcpUpdate): void {
		if (process.replay !== null) {
			this.#handleReplayUpdate(process, process.replay, update);
			return;
		}
		if (update.replay !== null) {
			throw new HostError("internal", "Clio Coder sent replay metadata outside a session load.");
		}
		const turn = process.turn;
		if (
			turn === null || process.session === null || update.sessionId !== process.session.rawSessionId ||
			!turn.promptActive
		) {
			throw new HostError("internal", "A Clio Coder update crossed its bounded session turn.");
		}
		if (update.type === "user") throw new HostError("internal", "Clio Coder echoed a user message outside a replay.");
		if (turn.projectionClosed) return;
		if (turn.updateCount >= MAX_ACP_UPDATES_PER_TURN) {
			this.#closeProjectionForBudget(
				process,
				turn,
				"workbench-update-budget-exceeded",
				"The GUI stopped this turn after the bounded update budget was exceeded.",
			);
			return;
		}
		turn.updateCount += 1;
		if (update.type !== "tool") {
			const nextStreamBytes = turn.streamBytes + bytes(update.text);
			if (nextStreamBytes > MAX_CUMULATIVE_STREAM_BYTES) {
				this.#closeProjectionForBudget(
					process,
					turn,
					"workbench-stream-budget-exceeded",
					"The GUI stopped this turn after the bounded text budget was exceeded.",
				);
				return;
			}
			turn.streamBytes = nextStreamBytes;
			if (update.text.length > 0) this.#emitText(turn, update.type, update.text, projectAgents(update.agents));
			return;
		}
		this.#flushText(turn);
		const locations = projectLocations(this.project.trustedRoot, update.locations);
		let tool = turn.tools.get(update.toolCallId);
		if (tool === undefined) {
			if (
				update.variant !== "start" || turn.tools.size >= MAX_TOOLS_PER_TURN || update.status === "completed" ||
				update.status === "failed"
			) throw new HostError("internal", "Clio Coder emitted an invalid tool lifecycle.");
			turn.toolCounter += 1;
			tool = {
				publicId: `tool-${turn.context.turnId}-${turn.toolCounter}`,
				rawTitle: update.title,
				kind: boundedString(update.kind, "Clio Coder tool kind", MAX_TOOL_KIND_BYTES),
				locations,
				terminal: false,
			};
			turn.tools.set(update.toolCallId, tool);
		} else if (
			update.variant !== "update" || tool.terminal || tool.rawTitle !== update.title || tool.kind !== update.kind ||
			!sameLocations(tool.locations, locations)
		) throw new HostError("internal", "Clio Coder changed or replayed a bounded tool identity.");
		const terminal = update.status === "completed" || update.status === "failed";
		if (terminal) tool.terminal = true;
		turn.hasSubstantiveActivity = true;
		this.#sink.emit({
			type: "turn.tool",
			context: turn.context,
			payload: {
				toolCallId: tool.publicId,
				title: safeToolTitle(tool.kind),
				kind: tool.kind,
				status: update.status === "pending" ? "in_progress" : update.status,
				summary: presentableToolTitle(tool.rawTitle, this.project.trustedRoot, tool.kind),
				locations: tool.locations.map((segments) => ({ segments })),
				agents: projectAgents(update.agents),
				source: "observed-on-acp",
			},
		});
	}

	#handleReplayUpdate(process: Process, replay: Replay, update: ValidatedAcpUpdate): void {
		if (update.replay === null) throw new HostError("internal", "Clio Coder replayed a frame without replay metadata.");
		replay.frames += 1;
		if (update.replay.turn < replay.currentTurn) {
			throw new HostError("internal", "Clio Coder replayed turns out of order.");
		}
		if (update.replay.turn > replay.currentTurn) {
			this.#flushReplayText(process);
			if (replay.turnCounter >= MAX_REPLAY_TURNS) {
				throw new HostError("internal", "Clio Coder replayed more turns than the contract allows.");
			}
			replay.currentTurn = update.replay.turn;
			replay.turnCounter += 1;
			replay.tools.clear();
			(replay as { context: HostTurnContext }).context = {
				...replay.context,
				turnId: `turn-${replay.turnCounter}`,
			};
			if (update.type !== "user") {
				// A turn group that opens without its user prompt still gets a request card, truthfully empty.
				this.#sink.emit({
					type: "turn.started",
					context: replay.context,
					payload: {
						promptSummary: "(earlier prompt not replayed)",
						origin: "replay",
						startedAt: null,
						source: "replayed-from-clio",
					},
				});
			}
		}
		if (update.type === "user") {
			if (replay.streamTailType === "user") {
				replay.streamTail += update.text;
				return;
			}
			this.#flushReplayText(process);
			replay.streamTailType = "user";
			replay.streamTail = update.text;
			return;
		}
		if (update.type !== "tool") {
			if (replay.streamTailType === "user") this.#flushReplayText(process);
			if (replay.streamTailType !== null && replay.streamTailType !== update.type) this.#flushReplayText(process);
			replay.streamTailType = update.type;
			const projected = consumeProjectRedaction(replay.streamTail + update.text, this.project.trustedRoot, false);
			replay.streamTail = projected.remainder;
			if (projected.text.length > 0) {
				this.#sink.emit({
					type: update.type === "message" ? "turn.text" : "turn.thought",
					context: replay.context,
					payload: { text: projected.text, agents: [], source: "replayed-from-clio" },
				});
			}
			return;
		}
		this.#flushReplayText(process);
		const locations = projectLocations(this.project.trustedRoot, update.locations);
		let tool = replay.tools.get(update.toolCallId);
		if (tool === undefined) {
			if (update.variant !== "start" || replay.toolCounter >= MAX_REPLAY_TOOLS) {
				throw new HostError("internal", "Clio Coder replayed an invalid tool lifecycle.");
			}
			replay.toolCounter += 1;
			tool = {
				publicId: `tool-${replay.context.turnId}-${replay.tools.size + 1}`,
				rawTitle: update.title,
				kind: boundedString(update.kind, "Clio Coder tool kind", MAX_TOOL_KIND_BYTES),
				locations,
				terminal: false,
			};
			replay.tools.set(update.toolCallId, tool);
		} else if (tool.terminal) throw new HostError("internal", "Clio Coder replayed a terminal tool twice.");
		const terminal = update.status === "completed" || update.status === "failed";
		if (terminal) tool.terminal = true;
		this.#sink.emit({
			type: "turn.tool",
			context: replay.context,
			payload: {
				toolCallId: tool.publicId,
				title: safeToolTitle(tool.kind),
				kind: tool.kind,
				status: update.status === "pending" ? "in_progress" : update.status,
				summary: presentableToolTitle(tool.rawTitle, this.project.trustedRoot, tool.kind),
				locations: tool.locations.map((segments) => ({ segments })),
				agents: projectAgents(update.agents),
				source: "replayed-from-clio",
			},
		});
	}

	#flushReplayText(process: Process): void {
		const replay = process.replay;
		if (replay === null || replay.streamTailType === null) return;
		const type = replay.streamTailType;
		const projected = consumeProjectRedaction(replay.streamTail, this.project.trustedRoot, true);
		replay.streamTail = "";
		replay.streamTailType = null;
		if (type === "user") {
			this.#sink.emit({
				type: "turn.started",
				context: replay.context,
				payload: {
					promptSummary: projected.text.trim().length === 0 ? "(empty prompt)" : projected.text.trim().slice(0, 2_048),
					origin: "replay",
					startedAt: null,
					source: "replayed-from-clio",
				},
			});
			return;
		}
		if (projected.text.length === 0) return;
		this.#sink.emit({
			type: type === "message" ? "turn.text" : "turn.thought",
			context: replay.context,
			payload: { text: projected.text, agents: [], source: "replayed-from-clio" },
		});
	}

	#handleExtensionEvent(process: Process, event: AcpExtensionEvent): void {
		const turn = process.turn;
		if (
			process.session === null || process.initialized === null ||
			process.initialized.eventWorkspaceInstanceId === null ||
			event.workspaceInstanceId !== process.initialized.eventWorkspaceInstanceId ||
			event.sessionId !== process.session.rawSessionId || event.sequence <= process.lastExtensionSequence
		) throw new HostError("internal", "A Clio Coder extension event crossed its process or session boundary.");
		process.lastExtensionSequence = event.sequence;
		if (event.kind !== "safety.loopBlocked") {
			// A dispatch run legitimately settles after the turn that started it, so
			// these facts are bound to the session rather than to a live turn.
			this.#applyDispatchEvent(process, event.kind, event.payload);
			return;
		}
		if (turn === null) throw new HostError("internal", "A Clio Coder loop block crossed its turn boundary.");
		this.#sink.emit({
			type: "turn.loop",
			context: turn.context,
			payload: {
				toolCallId: null,
				tool: event.payload.tool,
				repeatCount: event.payload.repeatCount,
				blocksThisTurn: event.payload.blocksThisTurn,
				budget: event.payload.budget,
				disposition: event.payload.disposition as WireLoopDisposition,
				interrupted: event.payload.interrupted,
				shape: null,
				source: "reported-by-clio",
			},
		});
	}

	/**
	 * Folds one reported dispatch fact into the run this process is tracking and
	 * publishes the result. The host keeps the runs so a browser that reloads
	 * mid-flight gets the same strip it would have built by watching the stream;
	 * nothing is invented, and a run only leaves a state Clio Coder moved it out
	 * of.
	 */
	#applyDispatchEvent(
		process: Process,
		kind: AcpDispatchEventKind,
		payload: AcpDispatchEventPayload,
	): void {
		const runId = boundedString(payload.runId, "Clio Coder dispatch run id", MAX_AGENT_ID_BYTES);
		const prior = process.fleet.get(runId);
		const state: WireFleetRunState = kind === "dispatch.enqueued"
			? "queued"
			: kind === "dispatch.started"
			? "running"
			: kind === "dispatch.progress"
			? "progress"
			: kind === "dispatch.completed"
			? "done"
			: "failed";
		const settled = state === "done" || state === "failed";
		const run: WireFleetRun = {
			runId,
			agentId: boundedString(payload.agentId, "Clio Coder dispatch agent id", MAX_AGENT_ID_BYTES),
			state,
			taskPreview: payload.taskPreview === null
				? (prior?.taskPreview ?? null)
				: boundedString(payload.taskPreview, "Clio Coder dispatch task preview", MAX_TASK_PREVIEW_BYTES),
			node: payload.node === null
				? (prior?.node ?? null)
				: boundedString(payload.node, "Clio Coder dispatch node", MAX_AGENT_ID_BYTES),
			attempt: payload.attempt ?? prior?.attempt ?? null,
			progressCount: payload.progressCount ?? prior?.progressCount ?? 0,
			progressTruncated: payload.progressCount === null
				? (prior?.progressTruncated ?? false)
				: payload.progressTruncated,
			outcome: settled
				? boundedString(
					payload.reason ?? payload.outcome ?? state,
					"Clio Coder dispatch outcome",
					MAX_AGENT_ID_BYTES,
				)
				: null,
			durationMs: payload.durationMs ?? prior?.durationMs ?? null,
			tokenCount: payload.tokenCount ?? prior?.tokenCount ?? null,
			updatedAt: new Date(this.#now()).toISOString(),
		};
		if (prior === undefined && process.fleet.size >= MAX_WIRE_FLEET_RUNS) {
			// Drop a run that has already settled before one that is still going: a
			// live run is the one the operator can still act on.
			const evictable = [...process.fleet.values()].find((candidate) =>
				candidate.state === "done" || candidate.state === "failed"
			) ?? [...process.fleet.values()][0];
			if (evictable !== undefined) process.fleet.delete(evictable.runId);
		}
		process.fleet.delete(runId);
		process.fleet.set(runId, run);
		if (process.session === null) return;
		this.#sink.emit({
			type: "fleet.activity",
			projectId: this.project.projectId,
			generation: process.generation,
			sessionId: process.session.publicId,
			payload: { run, source: "reported-by-clio" },
		});
	}

	#closeProjectionForBudget(process: Process, turn: Turn, code: string, summary: string): void {
		if (turn.projectionClosed) return;
		turn.projectionClosed = true;
		void this.#failTurn(process, turn, { code, summary, source: "observed-by-workbench" }).catch(() => undefined);
	}

	#handlePermission(process: Process, request: AcpPermissionRequest): void {
		const turn = process.turn;
		if (
			turn === null || !turn.promptActive || process.session === null ||
			request.sessionId !== process.session.rawSessionId ||
			turn.permission !== null
		) throw new HostError("internal", "A stale or concurrent Clio Coder permission crossed its turn boundary.");
		const tool = turn.tools.get(request.toolCallId);
		if (tool === undefined || tool.terminal || tool.rawTitle !== request.title || tool.kind !== request.kind) {
			throw new HostError("internal", "Clio Coder requested permission for an unknown tool identity.");
		}
		const locations = projectLocations(this.project.trustedRoot, request.locations);
		if (!sameLocations(tool.locations, locations)) {
			throw new HostError("internal", "Clio Coder changed a tool location at the permission boundary.");
		}
		if (turn.cancelReason !== null || turn.settling) {
			void request.resolve("cancelled").catch(() => undefined);
			return;
		}
		const publicId = `permission-${crypto.randomUUID()}`;
		const requestedAt = this.#now();
		const clientRemainingMs = Math.max(0, request.expiresAt - Date.now());
		const expiresAt = requestedAt + Math.min(this.#permissionBudgetMs, clientRemainingMs);
		if (expiresAt <= requestedAt) {
			this.#log("The GUI discarded an approval because the Clio Coder permission ceiling had already passed.");
			void request.resolve("cancelled").catch(() => undefined);
			void this.#cancelTurn(process, turn, "approval-unanswered").catch(() => undefined);
			return;
		}
		const scheduledEscalateAt = requestedAt + this.#permissionEscalateMs;
		const escalateAt = scheduledEscalateAt < expiresAt ? scheduledEscalateAt : requestedAt;
		if (scheduledEscalateAt >= expiresAt) {
			this.#log(
				`The GUI escalated this approval immediately: the Clio Coder permission ceiling leaves ${
					expiresAt - requestedAt
				} ms, shorter than the ${this.#permissionEscalateMs} ms escalation budget.`,
			);
		}
		const timer = setTimeout(() => {
			if (this.#process === process && turn.permission?.publicId === publicId && !turn.settling) {
				void this.#cancelTurn(process, turn, "approval-unanswered").catch(() => undefined);
			}
		}, Math.max(0, expiresAt - requestedAt));
		turn.permission = { publicId, request, requestedAt, escalateAt, expiresAt, timer };
		// The card is published before the phase moves, so no snapshot reports
		// `awaiting-approval` while the projection still has nothing to approve.
		this.#sink.emit({
			type: "turn.permission.requested",
			context: turn.context,
			payload: {
				permissionId: publicId,
				toolCallId: tool.publicId,
				title: presentableToolTitle(tool.rawTitle, this.project.trustedRoot, tool.kind),
				kind: tool.kind,
				locations: tool.locations.map((segments) => ({ segments })),
				requestedAt: new Date(requestedAt).toISOString(),
				escalateAt: new Date(escalateAt).toISOString(),
				expiresAt: new Date(expiresAt).toISOString(),
				source: "observed-on-acp",
			},
		});
		this.#setPhase("awaiting-approval");
	}

	/**
	 * Publishes the resolution and moves the phase off `awaiting-approval` in one
	 * synchronous step, so no snapshot observes a pending approval without the
	 * awaiting phase or the awaiting phase without a pending approval. A chained
	 * request that arrives while the decision is in flight keeps the phase.
	 */
	async #settlePermission(
		turn: Turn,
		publicDecision: "allow-once" | "reject" | "cancelled" | "unanswered" | "disconnect",
		wireDecision: "allow_once" | "reject_once" | "cancelled",
		nextPhase: WireClioSnapshot["phase"],
	): Promise<void> {
		const permission = turn.permission;
		if (permission === null) throw new HostError("not-found", "That permission is no longer waiting.");
		turn.permission = null;
		clearTimeout(permission.timer);
		await permission.request.resolve(wireDecision);
		this.#sink.emit({
			type: "turn.permission.resolved",
			context: turn.context,
			payload: { permissionId: permission.publicId, decision: publicDecision, source: "observed-by-workbench" },
		});
		if (turn.permission === null && this.#phase === "awaiting-approval") this.#setPhase(nextPhase);
	}

	async #cancelTurn(process: Process, turn: Turn, reason: CancelReason): Promise<void> {
		if (turn.settling) {
			await turn.done;
			return;
		}
		if (turn.cancelReason !== null) {
			await turn.done;
			return;
		}
		turn.cancelReason = reason;
		// A parked approval is withdrawn first so the phase only leaves
		// `awaiting-approval` in the same step that publishes its resolution.
		if (turn.permission !== null) {
			try {
				await this.#settlePermission(
					turn,
					reason === "approval-unanswered"
						? "unanswered"
						: reason === "client-disconnected"
						? "disconnect"
						: "cancelled",
					"cancelled",
					"cancelling",
				);
			} catch {
				// The cancel below still settles the turn.
			}
		}
		if (this.#phase !== "cancelling") this.#setPhase("cancelling");
		const session = process.session;
		if (session !== null && turn.promptActive) {
			try {
				await process.client.notify("session/cancel", { sessionId: session.rawSessionId });
			} catch {
				// A dead child settles through its failure path.
			}
		}
		const grace = this.#acpTiming.cancelGraceMs ?? 5_000;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const settled = await Promise.race([
			turn.done.then(() => true),
			new Promise<boolean>((resolve) => {
				graceTimer = setTimeout(() => resolve(false), grace);
			}),
		]).finally(() => {
			if (graceTimer !== undefined) clearTimeout(graceTimer);
		});
		if (!settled && !turn.settling) {
			// Clio Coder did not settle its cancelled prompt in time: retire the child so nothing lingers.
			await this.#finishTurn(process, turn, {
				outcome: "canceled",
				code: reason === "operator" ? "operator-cancelled" : reason,
				summary: "Clio Coder did not confirm the cancellation in time, so its process was retired.",
				stopReason: "cancelled",
				source: "observed-by-workbench",
			}, { settleToIdle: false });
			await this.#retire(process, { closeSession: false });
			this.#lastFailure = {
				code: "acp-cancel-timeout",
				summary: "Clio Coder did not confirm a cancellation and was retired.",
			};
			this.#setPhase("failed");
		}
		await turn.done;
	}

	async #failTurn(
		process: Process,
		turn: Turn,
		failure: PublicClioFailure & { readonly source: WireEventSource },
	): Promise<void> {
		if (turn.settling) return;
		turn.cancelReason ??= "operator";
		const session = process.session;
		if (session !== null && turn.promptActive) {
			try {
				await process.client.notify("session/cancel", { sessionId: session.rawSessionId });
			} catch {
				// Finish below regardless.
			}
		}
		await this.#finishTurn(process, turn, { outcome: "failed", ...failure });
	}

	async #finishTurn(
		process: Process,
		turn: Turn,
		terminal: Readonly<{
			outcome: "completed" | "canceled" | "failed";
			code: string;
			summary: string;
			stopReason?: (typeof PROMPT_STOP_REASONS)[number];
			usage?: WireUsage;
			source: WireEventSource;
		}>,
		options: Readonly<{ settleToIdle?: boolean }> = {},
	): Promise<void> {
		if (turn.settling) return;
		turn.settling = true;
		try {
			try {
				this.#flushText(turn);
			} catch {
				// Text flush is presentation only.
			}
			if (turn.permission !== null) {
				try {
					await this.#settlePermission(turn, "cancelled", "cancelled", "cancelling");
				} catch {
					// The turn is finishing regardless.
				}
			}
			for (const tool of turn.tools.values()) {
				if (tool.terminal) continue;
				tool.terminal = true;
				this.#sink.emit({
					type: "turn.tool",
					context: turn.context,
					payload: {
						toolCallId: tool.publicId,
						title: safeToolTitle(tool.kind),
						kind: tool.kind,
						status: "canceled",
						summary: "This call did not finish before the turn ended.",
						locations: tool.locations.map((segments) => ({ segments })),
						agents: [],
						source: "observed-by-workbench",
					},
				});
			}
			this.#sink.emit({
				type: "turn.terminal",
				context: turn.context,
				payload: {
					outcome: terminal.outcome,
					code: terminal.code,
					summary: terminal.summary,
					...(terminal.stopReason === undefined ? {} : { stopReason: terminal.stopReason }),
					...(terminal.usage === undefined ? {} : { usage: terminal.usage }),
					source: terminal.source,
				},
			});
		} finally {
			if (process.turn === turn) process.turn = null;
			turn.resolveDone();
			// A caller that is about to record a failure suppresses this so the
			// operator never sees a false `idle` between the two.
			if (options.settleToIdle !== false && !process.retiring && this.#process === process) this.#setPhase("idle");
			try {
				void this.#sink.refreshProject(this.project.projectId).catch(() => undefined);
			} catch {
				// Refresh is presentation only.
			}
		}
	}

	#emitText(turn: Turn, type: "message" | "thought", text: string, agents: readonly WireAgentAttribution[]): void {
		if (turn.streamTailType !== null && turn.streamTailType !== type) this.#flushText(turn);
		turn.streamTailType = type;
		turn.streamAgents = agents;
		const projected = consumeProjectRedaction(turn.streamTail + text, this.project.trustedRoot, false);
		turn.streamTail = projected.remainder;
		if (projected.text.length === 0) return;
		if (type === "message" && projected.text.trim().length > 0) turn.hasSubstantiveActivity = true;
		this.#sink.emit({
			type: type === "message" ? "turn.text" : "turn.thought",
			context: turn.context,
			payload: { text: projected.text, agents: turn.streamAgents, source: "observed-on-acp" },
		});
	}

	#flushText(turn: Turn): void {
		if (turn.streamTailType === null) return;
		const type = turn.streamTailType;
		const projected = consumeProjectRedaction(turn.streamTail, this.project.trustedRoot, true);
		turn.streamTail = projected.remainder;
		turn.streamTailType = null;
		if (projected.text.length === 0) return;
		if (type === "message" && projected.text.trim().length > 0) turn.hasSubstantiveActivity = true;
		this.#sink.emit({
			type: type === "message" ? "turn.text" : "turn.thought",
			context: turn.context,
			payload: { text: projected.text, agents: turn.streamAgents, source: "observed-on-acp" },
		});
	}
}
