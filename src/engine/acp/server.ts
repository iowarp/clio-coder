import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { BusChannels, type LoopBlockedPayload } from "../../core/bus-events.js";
import { DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS } from "../../core/defaults.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import { MAX_TIMER_DELAY_MS } from "../../core/timers.js";
import type { ProvidersContract } from "../../domains/providers/contract.js";
import { isOrchestratorEligibleRuntime } from "../../domains/providers/eligibility.js";
import { type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL } from "../../domains/safety/autonomy.js";
import type { SessionContract, SessionMeta } from "../../domains/session/contract.js";
import type { MessageEntry, SessionEntry } from "../../domains/session/entries.js";
import { filterEntriesToActivePath } from "../../domains/session/tree/active-path.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { toolResultPresentationText } from "../../tools/result-disposition.js";
import type { AgentMessage } from "../types.js";
import { ACP_TURN_FAILED_MESSAGE, AcpRequestError, AcpTimeoutError, acpErrorMessage } from "./errors.js";
import type { AcpJsonRpcPeerTransport } from "./transport.js";
import type {
	AcpContentBlock,
	AcpInitializeResponse,
	AcpPromptResponse,
	AcpRequestPermissionResponse,
	AcpSessionUpdateParams,
	AcpToolCallLocation,
	AcpToolCallStatus,
	AcpToolKind,
} from "./types.js";
import {
	ACP_MAX_CHUNK_BYTES,
	ACP_MAX_RAW_RECORD_BYTES,
	ACP_MAX_STRING_BYTES,
	ACP_MAX_TOOL_CALL_ID_BYTES,
	ACP_SESSION_META_KEY,
	ACP_USAGE_META_KEY,
} from "./types.js";

type AcpServerEvent = unknown;
type AcpEventRecord = Record<string, unknown> & { type?: unknown };

export interface AcpServerChat {
	submit(text: string, options?: unknown): Promise<void>;
	cancel(): void;
	onEvent(handler: (event: AcpServerEvent) => void): () => void;
	isStreaming(): boolean;
	getSessionId(): string | null;
	/** Replace provider context and the next persisted parent after session/load. */
	resetForSession?(leafTurnId: string | null, replayMessages?: ReadonlyArray<AgentMessage>): void;
	dispose?(): void;
}

export interface AcpRoutingSnapshot {
	target: string | null;
	model: string | null;
}

export type AcpThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AcpSafeSettingsSnapshot extends AcpRoutingSnapshot {
	thinkingLevel: AcpThinkingLevel;
	autonomy: AutonomyLevel;
}

export type AcpSafeSettingsPatch = Partial<{
	"orchestrator.target": string | null;
	"orchestrator.model": string | null;
	"orchestrator.thinkingLevel": AcpThinkingLevel;
	autonomy: AutonomyLevel;
}>;

export interface AcpSettingsControl {
	read(): AcpSafeSettingsSnapshot;
	commit(patch: AcpSafeSettingsPatch): AcpSafeSettingsSnapshot;
}

export interface ClioAcpServerOptions {
	transport: AcpJsonRpcPeerTransport;
	chat: AcpServerChat;
	session?: SessionContract;
	providers?: ProvidersContract;
	settings?: AcpSettingsControl;
	toolRegistry?: ToolRegistry;
	bus?: SafeEventBus;
	autonomy?: () => AutonomyLevel;
	/** Initial effective next-turn route captured when a session is bound. */
	routing?: () => AcpRoutingSnapshot;
	/** Durable rich-entry reader used by standard session/load. */
	readSessionEntries?: (sessionId: string) => ReadonlyArray<SessionEntry>;
	/** Builds the provider context; this is deliberately separate from client replay. */
	buildReplayMessages?: (entries: ReadonlyArray<SessionEntry>, leafTurnId: string | null) => ReadonlyArray<AgentMessage>;
	onActiveSessionAutonomyChange?: (level: AutonomyLevel | null) => void;
	cwd?: string;
	version?: string;
	permissionTimeoutMs?: number;
	/**
	 * Where text this process did not author goes instead of the wire. Stdout is
	 * JSON-RPC only, so the operator-facing detail behind a failure lands on the
	 * unstructured stderr tail (CONTRACT C001 §6). Defaults to dropping it.
	 */
	diagnostics?: (line: string) => void;
}

interface AcpServerSession {
	id: string;
	cwd: string;
	autonomy: AutonomyLevel;
	autonomySource: "settings" | "session";
	target: string | null;
	model: string | null;
	createdAt: string;
	activePrompt: ActivePrompt | null;
}

interface ActivePrompt {
	cancelled: boolean;
	/** The server approval ceiling won; distinct from operator cancellation/denial. */
	permissionExpired: boolean;
	/** The ACP presentation ceiling won before a 129th tool call reached the wire. */
	toolCallLimitReached: boolean;
	errored: boolean;
	errorMessage?: string;
	/** Machine-readable reason from the first admission notice of this turn. */
	admissionReason?: string;
	sentAssistantChars: number;
	sentThinkingChars: number;
	/** `session/update` notifications emitted for this turn. */
	updatesSent: number;
	/** True once the engine reported a turn end (`message_end` or `agent_end`). */
	sawTurnEnd: boolean;
	stopReason: string;
	usage: AcpServerUsage;
	usageMessages: WeakSet<object>;
	/**
	 * Engine tool-call id -> every wire id it has been given this turn, oldest
	 * first. An engine that reuses one id for two calls gets a second wire id
	 * rather than a second call folded onto the first.
	 */
	toolCallWireIds: Map<string, string[]>;
	/** Every wire id this turn has handed out, literal engine ids and aliases alike. */
	usedWireIds: Set<string>;
	/** Wire ids that received `tool_call` and no terminal `tool_call_update`. */
	openToolCalls: Set<string>;
	/**
	 * Wire ids that have already received a terminal `tool_call_update`, the
	 * cancel/fail sweep included. A client renders the first terminal update it
	 * sees and a second one for the same id either resurrects a finished call or
	 * overwrites its result, so a terminal id is never updated again.
	 */
	terminalToolCalls: Set<string>;
	/**
	 * Wire id -> the exact frame material that id's `tool_call` carried. A
	 * permission request reuses this instead of deriving anything from the
	 * registry's copy of the call: a tool's `prepareAdmissionArguments` may
	 * normalize or wholly replace the arguments before the safety net sees them,
	 * so the two frames legitimately disagreed and a client diffing the call it
	 * rendered against the call it is asked to approve failed closed. One entry
	 * per emitted call, each bounded by the raw-record cap, so the map is bounded
	 * by the turn's tool calls and dies with the turn.
	 */
	toolCallSnapshots: Map<string, AcpToolCallSnapshot>;
	/** Most recent wire id a `tool_call` was actually emitted for, open or not. */
	lastEmittedToolCallId: string | null;
	toolCallSequence: number;
}

/** What one emitted `tool_call` put on the wire that its permission request must repeat. */
interface AcpToolCallSnapshot {
	rawInput: Record<string, unknown>;
	locations?: AcpToolCallLocation[];
}

interface AcpServerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventRecord(value: unknown): AcpEventRecord {
	return isRecord(value) ? value : {};
}

function textContent(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

/**
 * Maps Clio canonical tool names onto the ACP v1 `ToolKind` closed enum. The
 * kind is a UI hint; the human-readable tool name travels in `title`. Anything
 * unrecognised (dynamic/MCP tools) falls back to `other` so the discriminated
 * union always deserialises on strict clients.
 */
const TOOL_KIND_BY_NAME: Record<string, AcpToolKind> = {
	read: "read",
	ls: "read",
	context: "read",
	write: "edit",
	edit: "edit",
	artifact: "edit",
	grep: "search",
	find: "search",
	code_nav: "search",
	bash: "execute",
	verify: "execute",
	web_fetch: "fetch",
	git: "other",
	dispatch: "other",
	monitor: "read",
	steer: "other",
};

/**
 * The admission reasons this server puts on the wire (CONTRACT C001 §4). The
 * engine's runtime-resolution diagnostics are a larger and faster-moving set
 * (`runtime-target-unsupported`, `runtime-use-unsupported`,
 * `required-capability-missing`, …), and a client cannot branch on codes the
 * profile never promised, so anything outside this set is reported as the
 * catch-all rather than leaking an engine-internal identifier.
 */
const ACP_ADMISSION_REASONS = new Set([
	"orchestrator-not-configured",
	"target-unknown",
	"target-not-configured",
	"target-not-found",
	"runtime-not-registered",
	"model-not-configured",
	"chat-unsupported",
	"streaming-unsupported",
	"admission-failed",
]);

const ACP_ADMISSION_FALLBACK_REASON = "admission-failed";

function admissionReason(raw: string): string {
	return ACP_ADMISSION_REASONS.has(raw) ? raw : ACP_ADMISSION_FALLBACK_REASON;
}

function toolKind(name: string | undefined): AcpToolKind {
	if (!name) return "other";
	return TOOL_KIND_BY_NAME[name] ?? "other";
}

/** ACP `ToolCallContent[]`. The `content` variant wraps a regular ContentBlock. */
function toolCallContent(text: string): Array<{ type: "content"; content: { type: "text"; text: string } }> {
	return [{ type: "content", content: textContent(text) }];
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
	if (!isRecord(value)) return "";
	if (value.type === "text" && typeof value.text === "string") return value.text;
	if (Array.isArray(value.content)) return contentText(value.content);
	if (typeof value.content === "string") return value.content;
	return "";
}

/**
 * The prompt text of one `session/prompt`. ACP v1 carries it as `params.prompt`,
 * an array of content blocks, and only `text` blocks have a textual reading;
 * image, audio, and resource_link blocks are ignored rather than coerced into
 * prose the model would then answer. Nothing else is accepted: tolerating
 * `params.content`, `params.message`, or a bare string meant this server
 * answered request shapes no ACP client sends and no schema describes, so a
 * client's own framing bug looked like a working prompt here and failed
 * against every other agent.
 */
function promptText(params: unknown): string {
	if (!isRecord(params) || !Array.isArray(params.prompt)) return "";
	const parts: string[] = [];
	for (const block of params.prompt) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		parts.push(block.text);
	}
	return parts.join("\n").trim();
}

/** Marker appended to any value this server shortened before sending it. */
const ACP_TRUNCATION_SUFFIX = "…[truncated]";

const ACP_TRUNCATION_SUFFIX_BYTES = Buffer.byteLength(ACP_TRUNCATION_SUFFIX, "utf8");

/** Workbench's frozen bounds for standard ACP tool-call presentation fields. */
const ACP_MAX_LOCATION_PATH_BYTES = 4 * 1024;
const ACP_MAX_TOOL_TITLE_BYTES = 512;

/** W001-A1 cardinality bounds for one live prompt and one load replay. */
const ACP_MAX_LIVE_TOOL_CALLS = 128;
const ACP_MAX_REPLAY_TOOL_CALLS = 8192;

/** Depth past which `boundRawRecord` stops walking and elides the subtree. */
const ACP_MAX_RAW_RECORD_DEPTH = 8;

/**
 * The longest prefix of `value` that fits `maxBytes` UTF-8 bytes without
 * splitting a code point. `Buffer.write` stops before a partial sequence, so a
 * surrogate pair is either wholly inside the prefix or wholly outside it and no
 * cut can produce a lone surrogate the peer decodes as a replacement character.
 */
function sliceToBytes(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const buffer = Buffer.allocUnsafe(maxBytes);
	const written = buffer.write(value, 0, maxBytes, "utf8");
	return buffer.toString("utf8", 0, written);
}

/** Bounds one string to `maxBytes` UTF-8 bytes, marker included in the budget. */
function boundString(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	// The marker is part of what goes on the wire, so it is reserved inside the
	// cap rather than appended past it.
	const budget = maxBytes - ACP_TRUNCATION_SUFFIX_BYTES;
	if (budget <= 0) return sliceToBytes(value, maxBytes);
	return `${sliceToBytes(value, budget)}${ACP_TRUNCATION_SUFFIX}`;
}

/**
 * Splits one delta into wire-sized chunks. Nothing is dropped and no code point
 * is split: the pieces concatenate back to the input, so a client that appends
 * chunks in order reconstructs the model's text exactly.
 */
function chunkText(text: string, maxBytes: number): string[] {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > 0) {
		const chunk = sliceToBytes(rest, maxBytes);
		// One code point wider than the whole bound cannot be split further, so it
		// travels oversized rather than being dropped or mangled.
		if (chunk.length === 0) {
			chunks.push(rest);
			break;
		}
		chunks.push(chunk);
		rest = rest.slice(chunk.length);
	}
	return chunks;
}

function boundRawValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") return boundString(value, ACP_MAX_STRING_BYTES);
	if (Array.isArray(value)) {
		if (depth >= ACP_MAX_RAW_RECORD_DEPTH) return "[depth]";
		return value.map((entry) => boundRawValue(entry, depth + 1));
	}
	if (isRecord(value)) {
		if (depth >= ACP_MAX_RAW_RECORD_DEPTH) return "[depth]";
		const bounded: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) bounded[key] = boundRawValue(entry, depth + 1);
		return bounded;
	}
	return value;
}

/**
 * The record's serialized UTF-8 size before any bounding, or null when it does
 * not serialize at all (a cycle, a BigInt, a throwing `toJSON`). This is the
 * figure `{truncated:true,bytes}` reports: the size a client is told about is
 * the payload the engine actually produced, not the size of the shortened copy
 * this process built and then decided not to send.
 */
function originalRawRecordBytes(value: unknown): number | null {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
	} catch {
		return null;
	}
}

/**
 * Bounds one `rawInput`/`rawOutput` record for the wire (CONTRACT C001 §3).
 * Strings are capped first, then the whole record: a payload that is still over
 * the record cap after per-string bounding is thousands of small fields, and
 * the honest thing to send is the fact that it was elided plus its size.
 */
function boundRawRecord(value: unknown): Record<string, unknown> {
	const bounded = isRecord(value) ? (boundRawValue(value, 0) as Record<string, unknown>) : {};
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(bounded);
	} catch {
		serialized = undefined;
	}
	// Nothing about this record can be measured, so the elision carries whatever
	// size the original could still report and 0 when it could not report one.
	if (serialized === undefined) return { truncated: true, bytes: originalRawRecordBytes(value) ?? 0 };
	const boundedBytes = Buffer.byteLength(serialized, "utf8");
	if (boundedBytes <= ACP_MAX_RAW_RECORD_BYTES) return bounded;
	// The bounded size is the fallback: an unserializable original has no size of
	// its own, and reporting the copy's is closer than reporting nothing.
	return { truncated: true, bytes: originalRawRecordBytes(value) ?? boundedBytes };
}

/** Built-in tools whose first positional argument names a workspace path. */
const PATH_BEARING_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);

/**
 * The standard `locations` field for a path-bearing call. The path is resolved
 * against the pinned workspace root but never realpath'ed: an `edit` or `write`
 * target legitimately does not exist yet, and a client that canonicalizes on
 * its own side treats an absent `locations` as "unavailable".
 */
function toolLocations(toolName: string | undefined, args: unknown, cwd: string): AcpToolCallLocation[] | null {
	if (toolName === undefined || !PATH_BEARING_TOOLS.has(toolName)) return null;
	if (!isRecord(args)) return null;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return null;
	return [{ path: boundString(resolvePath(cwd, path), ACP_MAX_LOCATION_PATH_BYTES) }];
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function emptyUsage(): AcpServerUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function createActivePromptState(): ActivePrompt {
	return {
		cancelled: false,
		permissionExpired: false,
		toolCallLimitReached: false,
		errored: false,
		sentAssistantChars: 0,
		sentThinkingChars: 0,
		updatesSent: 0,
		sawTurnEnd: false,
		stopReason: "end_turn",
		usage: emptyUsage(),
		usageMessages: new WeakSet<object>(),
		toolCallWireIds: new Map<string, string[]>(),
		usedWireIds: new Set<string>(),
		openToolCalls: new Set<string>(),
		terminalToolCalls: new Set<string>(),
		toolCallSnapshots: new Map<string, AcpToolCallSnapshot>(),
		lastEmittedToolCallId: null,
		toolCallSequence: 0,
	};
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function mergeUsage(into: AcpServerUsage, usage: unknown): void {
	if (!isRecord(usage)) return;
	into.input +=
		finite(usage.input) + finite(usage.inputTokens) + finite(usage.input_tokens) + finite(usage.prompt_tokens);
	into.output +=
		finite(usage.output) + finite(usage.outputTokens) + finite(usage.output_tokens) + finite(usage.completion_tokens);
	into.cacheRead += finite(usage.cacheRead) + finite(usage.cacheReadTokens) + finite(usage.cache_read_tokens);
	into.cacheWrite += finite(usage.cacheWrite) + finite(usage.cacheWriteTokens) + finite(usage.cache_write_tokens);
	into.reasoning += finite(usage.reasoning) + finite(usage.reasoningTokens) + finite(usage.reasoning_tokens);
}

function mergeMessageUsage(into: AcpServerUsage, message: unknown, seen?: WeakSet<object>): void {
	if (!isRecord(message)) return;
	if (seen) {
		if (seen.has(message)) return;
		seen.add(message);
	}
	mergeUsage(into, message.usage);
}

function mergeMessagesUsage(into: AcpServerUsage, messages: unknown, seen?: WeakSet<object>): void {
	if (!Array.isArray(messages)) return;
	for (const message of messages) mergeMessageUsage(into, message, seen);
}

function assistantText(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant") return "";
	return contentText(message.content);
}

function assistantThinking(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.map((block) => {
			if (!isRecord(block)) return "";
			if (block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
			if (block.type === "thinking" && typeof block.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("");
}

/**
 * Collapses pi-agent / Clio message stop reasons onto the ACP v1 StopReason
 * closed enum (end_turn | max_tokens | max_turn_requests | refusal | cancelled).
 * Tool-driven or unknown reasons ("stop", "toolUse", "length"…) map to
 * "end_turn"; "error" is a sentinel that the prompt handler converts into a
 * JSON-RPC error, since ACP has no error StopReason.
 */
function mapAcpStopReason(raw: unknown): string {
	switch (raw) {
		case "aborted":
		case "cancelled":
			return "cancelled";
		case "error":
			return "error";
		case "refusal":
			return "refusal";
		case "length":
		case "max_tokens":
		case "maxTokens":
			return "max_tokens";
		case "max_turn_requests":
		case "maxTurnRequests":
			return "max_turn_requests";
		default:
			return "end_turn";
	}
}

/** Applies a message's stop reason to the active prompt, tracking the error sentinel. */
function applyStopReason(active: ActivePrompt, message: unknown): void {
	const mapped = mapAcpStopReason(isRecord(message) ? message.stopReason : undefined);
	if (mapped === "error") {
		active.errored = true;
		const explicit = isRecord(message) && typeof message.errorMessage === "string" ? message.errorMessage : "";
		const text = explicit.length > 0 ? explicit : assistantText(message);
		if (text.length > 0) active.errorMessage = text;
		return;
	}
	active.errored = false;
	active.stopReason = mapped;
}

function outputText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return "";
	const presentationText = toolResultPresentationText(value);
	if (presentationText !== null) return presentationText;
	if (Array.isArray(value.content)) return contentText(value.content);
	if (typeof value.output === "string") return value.output;
	if (typeof value.text === "string") return value.text;
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

function toolStatus(event: AcpEventRecord): string {
	return event.isError === true ? "failed" : "completed";
}

function eventString(event: AcpEventRecord, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = event[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function eventTextDelta(event: AcpEventRecord): string {
	const direct = eventString(event, "delta", "text");
	if (direct !== undefined) return direct;
	const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
	if (assistantEvent) {
		const nested = assistantEvent.delta;
		if (typeof nested === "string") return nested;
	}
	return "";
}

/**
 * The next unused `clio-tool-<n>`. The counter alone is not enough: an engine
 * that names its own calls `clio-tool-1` would otherwise collide with an alias
 * this server minted, and two different calls sharing one wire id is the exact
 * failure aliasing exists to prevent.
 */
function nextAliasToolCallId(active: ActivePrompt): string {
	for (;;) {
		active.toolCallSequence += 1;
		const alias = `clio-tool-${active.toolCallSequence}`;
		if (active.usedWireIds.has(alias)) continue;
		active.usedWireIds.add(alias);
		return alias;
	}
}

/** Records `wireId` as the newest wire id this engine id speaks under. */
function pushWireId(active: ActivePrompt, engineId: string, wireId: string): string {
	const existing = active.toolCallWireIds.get(engineId);
	if (existing === undefined) active.toolCallWireIds.set(engineId, [wireId]);
	else existing.push(wireId);
	return wireId;
}

/**
 * The first wire id an engine id gets. The engine's own id is used when it fits
 * the wire bound and no other call in this turn has claimed it; otherwise the
 * call travels under a per-prompt alias.
 */
function mintWireId(active: ActivePrompt, engineId: string): string {
	const usable = utf8Bytes(engineId) <= ACP_MAX_TOOL_CALL_ID_BYTES && !active.usedWireIds.has(engineId);
	if (usable) active.usedWireIds.add(engineId);
	return pushWireId(active, engineId, usable ? engineId : nextAliasToolCallId(active));
}

/**
 * The id a starting tool call travels under. An engine id this turn has already
 * used gets a fresh alias rather than the wire id of the earlier call: engines
 * that number their calls per request legitimately repeat an id, and reusing the
 * wire id merged two distinct calls into one on the client, so the second call's
 * arguments overwrote the first and one of the two ends was lost.
 */
function startToolCallId(active: ActivePrompt, engineId: string | undefined): string {
	if (engineId === undefined || engineId.length === 0) return nextAliasToolCallId(active);
	if (active.toolCallWireIds.has(engineId)) return pushWireId(active, engineId, nextAliasToolCallId(active));
	return mintWireId(active, engineId);
}

/**
 * The most recently opened wire id for this engine id, or null when it names no
 * call that is still open. "Open" is the client's own view: a `tool_call` was
 * emitted and no terminal `tool_call_update` followed it.
 */
function openWireIdFor(active: ActivePrompt, engineId: string): string | null {
	const wireIds = active.toolCallWireIds.get(engineId);
	if (wireIds === undefined) return null;
	for (let index = wireIds.length - 1; index >= 0; index -= 1) {
		const wireId = wireIds[index];
		if (wireId !== undefined && active.openToolCalls.has(wireId)) return wireId;
	}
	return null;
}

/**
 * The most recently opened wire id this turn still has running, or null when
 * nothing is open. `openToolCalls` is insertion-ordered and only ever loses
 * members, so the last one standing is the newest call the client has been shown
 * and not yet seen finish.
 */
function newestOpenToolCallId(active: ActivePrompt): string | null {
	let newest: string | null = null;
	for (const wireId of active.openToolCalls) newest = wireId;
	return newest;
}

/**
 * The wire id an ending tool call travels under, or null when this turn has no
 * call it could belong to. Nothing here mints: an end is an update to a call the
 * client already rendered, and a fresh id announced a `tool_call_update` for a
 * `tool_call` that was never sent, which a client either drops or renders as a
 * tool that finished without ever starting.
 *
 * An end that names an engine id is confined to that engine id's own calls. It
 * closes them newest first, which is the order a nested or retried call finishes
 * in, and when they are all finished it still resolves to that id's last wire id
 * so the caller can drop the end as the duplicate it is. An engine id this turn
 * emitted nothing for binds to nothing: borrowing another call's wire id
 * reported one tool's result under another tool's identity and closed a call
 * that was still running.
 *
 * An end with no engine id belongs to the newest call still running, which is
 * what makes nested lifecycles work. With A and B open and B already ended, the
 * next unidentified end is A's. With nothing open it falls back to the last call
 * the client actually saw, so the caller drops it as a duplicate rather than
 * inventing an identity for it.
 */
function endToolCallId(active: ActivePrompt, engineId: string | undefined): string | null {
	if (engineId === undefined || engineId.length === 0) {
		return newestOpenToolCallId(active) ?? active.lastEmittedToolCallId;
	}
	const open = openWireIdFor(active, engineId);
	if (open !== null) return open;
	const wireIds = active.toolCallWireIds.get(engineId);
	if (wireIds === undefined) return null;
	return wireIds[wireIds.length - 1] ?? null;
}

function sendUpdate(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	update: Record<string, unknown>,
): void {
	const params: AcpSessionUpdateParams = { sessionId, update };
	active.updatesSent += 1;
	transport.notify("session/update", params);
}

function sendTextChunks(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
	text: string,
): void {
	for (const chunk of chunkText(text, ACP_MAX_CHUNK_BYTES)) {
		sendUpdate(transport, sessionId, active, { sessionUpdate, content: textContent(chunk) });
	}
}

/**
 * Closes out every tool call that never received a terminal update. A client
 * that renders a running spinner per `tool_call` otherwise keeps spinning after
 * the turn settled, since ACP has no "the turn is over, drop what is open"
 * signal beyond the prompt response itself.
 */
function settleOpenToolCalls(
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	text: string,
): void {
	for (const toolCallId of active.openToolCalls) {
		sendUpdate(transport, sessionId, active, {
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "failed" satisfies AcpToolCallStatus,
			content: toolCallContent(text),
		});
		// The sweep is a terminal update like any other, so a late end for a swept
		// id cannot reopen the call the client has already seen fail.
		active.terminalToolCalls.add(toolCallId);
	}
	active.openToolCalls.clear();
}

function handleChatEvent(
	rawEvent: AcpServerEvent,
	transport: AcpJsonRpcPeerTransport,
	sessionId: string,
	active: ActivePrompt,
	cwd: string,
	diagnostics: ((line: string) => void) | undefined,
	onToolCallLimitReached: () => void,
): void {
	const event = eventRecord(rawEvent);
	// Once the approval ceiling wins, the prompt is terminal. Registry
	// cancellation may still make engine promises unwind and emit ordinary tool
	// or assistant events; none of those are part of a continuing model turn.
	if (active.permissionExpired || active.toolCallLimitReached) return;
	if (event.type === "text_delta") {
		const text = eventTextDelta(event);
		if (text.length === 0) return;
		active.sentAssistantChars += text.length;
		sendTextChunks(transport, sessionId, active, "agent_message_chunk", text);
		return;
	}
	if (event.type === "thinking_delta") {
		const text = eventTextDelta(event);
		if (text.length === 0) return;
		active.sentThinkingChars += text.length;
		sendTextChunks(transport, sessionId, active, "agent_thought_chunk", text);
		return;
	}
	if (event.type === "notice") {
		// Advisory notices have no ACP v1 equivalent and stay dropped. The one
		// exception is an admission notice: it is the only evidence that Clio
		// refused to start the turn, and the prompt handler fails the request
		// with its reason instead of returning an empty success.
		const admission = isRecord(event.admission) ? event.admission : null;
		const reason = admission !== null && typeof admission.reason === "string" ? admission.reason : "";
		if (reason.length > 0 && active.admissionReason === undefined) active.admissionReason = admissionReason(reason);
		return;
	}
	if (event.type === "tool_execution_start") {
		// Tool starts are emitted before registry validation/admission, so Clio's
		// configurable execution guard is not a wire-cardinality guarantee. Stop
		// before minting or emitting the 129th id; the prompt handler resolves with
		// ACP's standard max_turn_requests reason after the underlying run unwinds.
		if (active.usedWireIds.size >= ACP_MAX_LIVE_TOOL_CALLS) {
			active.toolCallLimitReached = true;
			onToolCallLimitReached();
			return;
		}
		const toolName = eventString(event, "toolName");
		const toolCallId = startToolCallId(active, eventString(event, "toolCallId"));
		active.openToolCalls.add(toolCallId);
		active.lastEmittedToolCallId = toolCallId;
		const locations = toolLocations(toolName, event.args, cwd);
		// Built once and kept: the permission request for this call must send the
		// same objects rather than recompute them from a copy of the arguments that
		// may since have been normalized.
		const snapshot: AcpToolCallSnapshot = {
			rawInput: boundRawRecord(event.args),
			...(locations !== null ? { locations } : {}),
		};
		active.toolCallSnapshots.set(toolCallId, snapshot);
		sendUpdate(transport, sessionId, active, {
			sessionUpdate: "tool_call",
			toolCallId,
			title: boundString(toolName ?? "tool", ACP_MAX_TOOL_TITLE_BYTES),
			kind: toolKind(toolName),
			status: "in_progress" satisfies AcpToolCallStatus,
			rawInput: snapshot.rawInput,
			...(snapshot.locations !== undefined ? { locations: snapshot.locations } : {}),
		});
		return;
	}
	if (event.type === "tool_execution_end") {
		const toolName = eventString(event, "toolName");
		const toolCallId = endToolCallId(active, eventString(event, "toolCallId"));
		// This turn put no `tool_call` on the wire, so there is no call an update
		// could name. The event is reported on the stderr tail instead.
		if (toolCallId === null) {
			diagnostics?.("dropped tool_execution_end with no tool call to update");
			return;
		}
		// The client has already been told how this call ended. A second terminal
		// update either resurrects a finished call or overwrites its result with a
		// later one, so the duplicate goes to the stderr tail and not the wire.
		if (active.terminalToolCalls.has(toolCallId)) {
			diagnostics?.(`dropped duplicate terminal update for ${toolCallId}`);
			return;
		}
		active.openToolCalls.delete(toolCallId);
		active.terminalToolCalls.add(toolCallId);
		const output = boundString(outputText(event.result), ACP_MAX_CHUNK_BYTES);
		sendUpdate(transport, sessionId, active, {
			sessionUpdate: "tool_call_update",
			toolCallId,
			title: boundString(toolName ?? "tool", ACP_MAX_TOOL_TITLE_BYTES),
			kind: toolKind(toolName),
			status: toolStatus(event),
			...(output.length > 0 ? { content: toolCallContent(output) } : {}),
			rawOutput: boundRawRecord({ result: event.result, isError: event.isError === true }),
		});
		return;
	}
	if (event.type === "message_end") {
		const message = event.message;
		active.sawTurnEnd = true;
		mergeMessageUsage(active.usage, message, active.usageMessages);
		applyStopReason(active, message);
		const thinking = assistantThinking(message);
		if (thinking.length > active.sentThinkingChars) {
			const tail = thinking.slice(active.sentThinkingChars);
			active.sentThinkingChars = thinking.length;
			sendTextChunks(transport, sessionId, active, "agent_thought_chunk", tail);
		}
		const text = assistantText(message);
		if (text.length > active.sentAssistantChars) {
			const tail = text.slice(active.sentAssistantChars);
			active.sentAssistantChars = text.length;
			sendTextChunks(transport, sessionId, active, "agent_message_chunk", tail);
		}
		return;
	}
	if (event.type === "agent_end") {
		active.sawTurnEnd = true;
		mergeMessagesUsage(active.usage, event.messages, active.usageMessages);
		const messages = Array.isArray(event.messages) ? event.messages : [];
		const last = [...messages].reverse().find((message) => isRecord(message) && message.role === "assistant");
		if (last !== undefined) applyStopReason(active, last);
		return;
	}
	// Clio lifecycle events (agent_start, retry_status, clio_plan_update) have
	// no ACP v1 SessionUpdate equivalent. The prompt turn is bounded by the
	// session/prompt response, so emitting non-spec `progress` updates would
	// break strict clients. They are intentionally dropped. The same protocol
	// gap applies to routing advisories (external settings divergence, active
	// target removed): ACP v1 has no agent-initiated advisory channel, so the
	// orchestrator records those as `custom` session-ledger entries
	// (customType "clio.routing-notice") instead of inventing update kinds.
}

const ACP_MAX_SESSION_ID_BYTES = 128;
const ACP_MAX_TARGET_ID_BYTES = 128;
const ACP_MAX_MODEL_ID_BYTES = 256;
const ACP_MAX_LABEL_BYTES = 256;
const ACP_MAX_PREVIEW_BYTES = 512;
const ACP_MAX_REPLAY_TURNS = 64;
const ACP_MAX_REPLAY_BYTES = 4 * 1024 * 1024;
const ACP_REPLAY_META_KEY = "clio-coder/replay";

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
	}
	return false;
}

function requireBoundedClientString(
	value: unknown,
	name: string,
	maxBytes: number,
	options: { allowEmpty?: boolean } = {},
): string {
	if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
		throw new AcpRequestError(-32602, `${name} is required`, { code: "invalid_params" });
	}
	if (utf8Bytes(value) > maxBytes || hasControlCharacters(value)) {
		throw new AcpRequestError(-32602, `${name} is invalid`, { code: "invalid_params" });
	}
	return value;
}

function safeStoredString(value: unknown, maxBytes: number, fallback = ""): string {
	if (typeof value !== "string") return fallback;
	let safe = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		safe += codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? " " : character;
	}
	return boundString(safe, maxBytes);
}

function safeStoredIdentifier(value: unknown, maxBytes: number): string | null {
	if (typeof value !== "string" || value.length === 0 || hasControlCharacters(value) || utf8Bytes(value) > maxBytes) {
		return null;
	}
	return value;
}

/**
 * A selected route cannot be represented as null merely to satisfy the wire
 * bound: null means genuinely unselected in W001. Refuse the affected method
 * instead, with the fixed internal-error envelope, until the operator repairs
 * the local configuration.
 */
function safeConfiguredIdentifier(value: unknown, maxBytes: number): string | null {
	if (value === null || value === undefined) return null;
	const safe = safeStoredIdentifier(value, maxBytes);
	if (safe === null) {
		throw new AcpRequestError(-32000, "configured route cannot be represented safely", { code: "internal_error" });
	}
	return safe;
}

function safeIso(value: unknown): string {
	if (typeof value === "string" && !hasControlCharacters(value)) {
		const timestamp = Date.parse(value);
		if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
	}
	return new Date(0).toISOString();
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
	return isRecord(payload) ? payload : null;
}

function replayTextBlocks(entry: MessageEntry): { text: string[]; thinking: string[] } {
	const text: string[] = [];
	const thinking: string[] = [];
	if (typeof entry.payload === "string") text.push(entry.payload);
	const payload = payloadRecord(entry.payload);
	if (payload === null) return { text, thinking };
	if (typeof payload.text === "string") text.push(payload.text);
	if (!Array.isArray(payload.content)) return { text, thinking };
	// A rich payload's `text` is the flattened copy of `content`. Prefer the
	// original blocks so a replay does not duplicate the same prose.
	if (payload.content.length > 0) text.length = 0;
	for (const block of payload.content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") text.push(block.text);
		if (block.type === "thinking") {
			if (typeof block.thinking === "string") thinking.push(block.thinking);
			else if (typeof block.text === "string") thinking.push(block.text);
		}
	}
	return { text, thinking };
}

interface AcpReplayFrame {
	update: Record<string, unknown>;
}

interface AcpReplayTurn {
	frames: AcpReplayFrame[];
	toolCalls: number;
}

interface PreparedAcpReplay {
	params: Array<AcpSessionUpdateParams & { _meta: Record<string, unknown> }>;
	turns: number;
	truncated: boolean;
}

function replayMessageChunks(
	frames: AcpReplayFrame[],
	sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
	texts: ReadonlyArray<string>,
): void {
	for (const text of texts) {
		for (const chunk of chunkText(text, ACP_MAX_CHUNK_BYTES)) {
			if (chunk.length === 0) continue;
			frames.push({ update: { sessionUpdate, content: textContent(chunk) } });
		}
	}
}

function replayToolCall(entry: MessageEntry): { engineId: string; name: string; args: unknown } {
	const payload = payloadRecord(entry.payload);
	return {
		engineId:
			typeof payload?.toolCallId === "string" && payload.toolCallId.length > 0
				? payload.toolCallId
				: `persisted-tool-${entry.turnId}`,
		name: safeStoredString(payload?.name ?? payload?.toolName, 64, "tool") || "tool",
		args: payload?.args,
	};
}

function closeUnrecordedReplayCalls(active: ActivePrompt, frames: AcpReplayFrame[]): void {
	for (const toolCallId of active.openToolCalls) {
		frames.push({
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "failed" satisfies AcpToolCallStatus,
				content: toolCallContent("unrecorded"),
			},
		});
		active.terminalToolCalls.add(toolCallId);
	}
	active.openToolCalls.clear();
}

/**
 * Build client-visible replay from original active-branch transcript entries.
 * Provider-only synthetic context never enters this projection.
 */
function prepareAcpReplay(
	entries: ReadonlyArray<SessionEntry>,
	leafTurnId: string | null,
	sessionId: string,
): PreparedAcpReplay {
	const branch = filterEntriesToActivePath(entries, leafTurnId ?? undefined);
	const turns: AcpReplayTurn[] = [];
	const ids = createActivePromptState();
	let current: AcpReplayTurn | null = null;
	for (const entry of branch) {
		if (entry.kind !== "message") continue;
		const payload = payloadRecord(entry.payload);
		if (entry.role === "user") {
			// Middleware continuations are provider context, not operator authorship.
			if (payload?.synthetic === true) continue;
			if (current !== null) closeUnrecordedReplayCalls(ids, current.frames);
			current = { frames: [], toolCalls: 0 };
			turns.push(current);
			const operatorText =
				typeof payload?.operatorText === "string" ? [payload.operatorText] : replayTextBlocks(entry).text;
			replayMessageChunks(current.frames, "user_message_chunk", operatorText);
			continue;
		}
		if (current === null) continue;
		if (entry.role === "assistant") {
			const blocks = replayTextBlocks(entry);
			replayMessageChunks(current.frames, "agent_thought_chunk", blocks.thinking);
			replayMessageChunks(current.frames, "agent_message_chunk", blocks.text);
			continue;
		}
		if (entry.role === "tool_call") {
			const call = replayToolCall(entry);
			const toolCallId = startToolCallId(ids, call.engineId);
			ids.openToolCalls.add(toolCallId);
			ids.lastEmittedToolCallId = toolCallId;
			current.toolCalls += 1;
			current.frames.push({
				update: {
					sessionUpdate: "tool_call",
					toolCallId,
					title: call.name,
					kind: toolKind(call.name),
					status: "in_progress" satisfies AcpToolCallStatus,
					rawInput: boundRawRecord(call.args),
				},
			});
			continue;
		}
		if (entry.role === "tool_result") {
			const engineId = typeof payload?.toolCallId === "string" ? payload.toolCallId : undefined;
			const toolCallId = endToolCallId(ids, engineId);
			if (toolCallId === null || ids.terminalToolCalls.has(toolCallId)) continue;
			ids.openToolCalls.delete(toolCallId);
			ids.terminalToolCalls.add(toolCallId);
			const failed = payload?.isError === true || payload?.outcome === "error" || payload?.outcome === "blocked";
			const output = boundString(outputText(payload?.result), ACP_MAX_CHUNK_BYTES);
			const name = safeStoredString(payload?.toolName, 64, "tool") || "tool";
			current.frames.push({
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId,
					title: name,
					kind: toolKind(name),
					status: (failed ? "failed" : "completed") satisfies AcpToolCallStatus,
					...(output.length > 0 ? { content: toolCallContent(output) } : {}),
					rawOutput: boundRawRecord({ result: payload?.result, isError: failed }),
				},
			});
		}
	}
	if (current !== null) closeUnrecordedReplayCalls(ids, current.frames);

	let selected = turns.slice(-ACP_MAX_REPLAY_TURNS);
	let truncated = selected.length !== turns.length;
	let selectedToolCalls = selected.reduce((total, turn) => total + turn.toolCalls, 0);
	while (selectedToolCalls > ACP_MAX_REPLAY_TOOL_CALLS && selected.length > 0) {
		selectedToolCalls -= selected[0]?.toolCalls ?? 0;
		selected = selected.slice(1);
		truncated = true;
	}
	let decorated: Array<AcpSessionUpdateParams & { _meta: Record<string, unknown> }> = [];
	for (;;) {
		decorated = selected.flatMap((turn, index) =>
			turn.frames.map((frame) => ({
				sessionId,
				update: frame.update,
				_meta: { [ACP_REPLAY_META_KEY]: { turn: index + 1 } },
			})),
		);
		const bytes = decorated.reduce(
			(total, params) =>
				total + Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params }), "utf8") + 1,
			0,
		);
		if (bytes <= ACP_MAX_REPLAY_BYTES || selected.length === 0) break;
		selected = selected.slice(1);
		truncated = true;
	}
	return { params: decorated, turns: selected.length, truncated };
}

function sessionResultMeta(
	session: AcpServerSession,
	resumed: boolean,
	replayed?: { turns: number; truncated: boolean },
): Record<string, unknown> {
	return {
		sessionId: session.id,
		target: session.target,
		model: session.model,
		autonomy: session.autonomy,
		createdAt: safeIso(session.createdAt),
		resumed,
		...(replayed !== undefined ? { replayed } : {}),
	};
}

const ACP_SAFE_SETTINGS_KEYS = [
	"orchestrator.target",
	"orchestrator.model",
	"orchestrator.thinkingLevel",
	"autonomy",
] as const;
const ACP_THINKING_LEVELS = new Set<AcpThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ACP_AUTONOMY_LEVELS = new Set<AutonomyLevel>(["read-only", "suggest", "auto-edit", "full-auto"]);
const ACP_MAX_TARGETS = 64;
const ACP_MAX_TARGET_MODELS = 64;
// Workbench's frozen reader ceiling is 256 KiB per JSON-RPC line. Reserve
// 16 KiB for the response envelope/request id and keep this result a stable
// prefix of whole targets/model ids.
const ACP_MAX_TARGET_LIST_RESULT_BYTES = 240 * 1024;
const ACP_EMPTY_TRUNCATED_TARGET_LIST_BYTES = utf8Bytes(
	JSON.stringify({ targets: [], _meta: { "clio-coder/truncated": true } }),
);
// Session summaries share the same Workbench JSON-RPC line ceiling. Keep a
// stable newest-first prefix of whole rows and reserve 16 KiB for the envelope.
const ACP_MAX_SESSION_LIST_RESULT_BYTES = 240 * 1024;
const ACP_EMPTY_TRUNCATED_SESSION_LIST_BYTES = utf8Bytes(
	JSON.stringify({ sessions: [], truncated: true, _meta: { "clio-coder/truncated": true } }),
);

function safeSettingsProjection(snapshot: AcpSafeSettingsSnapshot): Record<string, unknown> {
	const thinkingLevel = ACP_THINKING_LEVELS.has(snapshot.thinkingLevel) ? snapshot.thinkingLevel : "off";
	const autonomy = ACP_AUTONOMY_LEVELS.has(snapshot.autonomy) ? snapshot.autonomy : DEFAULT_AUTONOMY_LEVEL;
	return {
		settings: {
			orchestrator: {
				target: safeConfiguredIdentifier(snapshot.target, ACP_MAX_TARGET_ID_BYTES),
				model: safeConfiguredIdentifier(snapshot.model, ACP_MAX_MODEL_ID_BYTES),
				thinkingLevel,
			},
			autonomy,
		},
		editable: [...ACP_SAFE_SETTINGS_KEYS],
	};
}

function safeTargetModels(status: ReturnType<ProvidersContract["list"]>[number]): string[] {
	const candidates = [status.target.defaultModel, ...(status.target.wireModels ?? []), ...status.discoveredModels];
	const seen = new Set<string>();
	const models: string[] = [];
	for (const candidate of candidates) {
		const id = safeStoredIdentifier(candidate, ACP_MAX_MODEL_ID_BYTES);
		if (id === null || seen.has(id)) continue;
		seen.add(id);
		models.push(id);
		if (models.length === ACP_MAX_TARGET_MODELS) break;
	}
	return models;
}

interface AcpSafeTargetProjection {
	id: string;
	runtime: string;
	models: string[];
	isOrchestrator: boolean;
}

function safeTargetProjection(status: ReturnType<ProvidersContract["list"]>[number]): AcpSafeTargetProjection | null {
	const id = safeStoredIdentifier(status.target.id, ACP_MAX_TARGET_ID_BYTES);
	const runtime = safeStoredIdentifier(status.target.runtime, 64);
	if (id === null || runtime === null) return null;
	return {
		id,
		runtime,
		models: safeTargetModels(status),
		isOrchestrator: status.runtime !== null && isOrchestratorEligibleRuntime(status.runtime),
	};
}

function safeProbeReason(
	providers: ProvidersContract,
	status: ReturnType<ProvidersContract["list"]>[number],
): "not-configured" | "unreachable" | "unsupported" | null {
	if (status.runtime === null || typeof status.runtime.probe !== "function") return "unsupported";
	try {
		if (status.runtime.auth !== "none" && !providers.auth.statusForTarget(status.target, status.runtime).available) {
			return "not-configured";
		}
	} catch {
		return "not-configured";
	}
	return status.available && status.health.status === "healthy" ? null : "unreachable";
}

interface AcpPermissionBridge {
	unregister(): void;
	/** Settles the outstanding permission request, if any, as cancellation. */
	cancelPending(reason: string): void;
}

function installPermissionBridge(input: {
	transport: AcpJsonRpcPeerTransport;
	toolRegistry: ToolRegistry | undefined;
	bus?: SafeEventBus;
	activeSessionId: () => string | null;
	/**
	 * The wire id of the engine id's most recently opened tool call, or null when
	 * it names no call the client currently has open. Lookup only: this never
	 * mints a wire id, so an engine id nothing was emitted for fails closed.
	 */
	resolveToolCallId: (engineToolCallId: string) => string | null;
	/** The wire id of the turn's one open tool call, or null when it is not exactly one. */
	soleOpenToolCallId: () => string | null;
	/**
	 * What this wire id's `tool_call` update put on the wire, or null when this
	 * turn emitted no such call. The ask repeats it verbatim; nothing here is
	 * rebuilt from the registry's arguments.
	 */
	toolCallSnapshot: (wireId: string) => AcpToolCallSnapshot | null;
	permissionTimeoutMs: number;
	expireActivePrompt: () => void;
}): AcpPermissionBridge {
	if (!input.toolRegistry) return { unregister: () => {}, cancelPending: () => {} };
	let pendingCancel: ((reason: string) => void) | null = null;
	let chain = Promise.resolve();
	const queuedRequestIds = new Set<string>();
	const queuedRequestDetails = new Map<string, { tool: string; actionClass: string }>();
	const unregister = input.toolRegistry.onPermissionRequired((call, decision, meta) => {
		if (queuedRequestIds.has(meta.requestId)) return;
		queuedRequestIds.add(meta.requestId);
		queuedRequestDetails.set(meta.requestId, {
			tool: call.tool,
			actionClass: decision.classification.actionClass,
		});
		const emitResolution = (payload: {
			status: "granted" | "denied" | "expired";
			decidedBy: string;
			reason?: string;
		}): void => {
			input.bus?.emit(BusChannels.PermissionResolved, {
				status: payload.status,
				requestId: meta.requestId,
				origin: "acp-server",
				decidedBy: payload.decidedBy,
				tool: call.tool,
				actionClass: decision.classification.actionClass,
				...(payload.reason !== undefined ? { reason: payload.reason } : {}),
			});
		};
		const emitQueuedErrorResolutions = (currentRequestId: string, reason: string): void => {
			for (const requestId of queuedRequestIds) {
				if (requestId === currentRequestId) continue;
				const details = queuedRequestDetails.get(requestId);
				input.bus?.emit(BusChannels.PermissionResolved, {
					status: "denied",
					requestId,
					origin: "acp-server",
					decidedBy: "error",
					...(details !== undefined ? { tool: details.tool, actionClass: details.actionClass } : {}),
					reason,
				});
			}
		};
		const emitQueuedExpiryResolutions = (currentRequestId: string): void => {
			for (const requestId of queuedRequestIds) {
				if (requestId === currentRequestId) continue;
				const details = queuedRequestDetails.get(requestId);
				input.bus?.emit(BusChannels.PermissionResolved, {
					status: "expired",
					requestId,
					origin: "acp-server",
					decidedBy: "timeout",
					...(details !== undefined ? { tool: details.tool, actionClass: details.actionClass } : {}),
					reason: "permission approval expired",
				});
			}
		};
		const run = async (): Promise<void> => {
			if (!queuedRequestIds.has(meta.requestId)) return;
			const sessionId = input.activeSessionId();
			const noSessionReason = "ACP permission requested with no active session";
			if (!sessionId) {
				emitResolution({
					status: "denied",
					decidedBy: "error",
					reason: noSessionReason,
				});
				emitQueuedErrorResolutions(meta.requestId, noSessionReason);
				queuedRequestIds.clear();
				queuedRequestDetails.clear();
				input.toolRegistry?.cancelParkedCalls(noSessionReason);
				return;
			}
			// The client already rendered a tool_call under the engine's id; asking
			// about a different id would present the operator with a call they
			// cannot see. So the engine's id is resolved by lookup and nothing
			// else: an id no tool_call was emitted for, or one whose call the
			// client has already seen finish, binds to nothing. When the bridge
			// gets no engine id, the turn's one open call is the only binding that
			// can be right. Everything else fails closed: a bridge-local id nothing
			// on the client matches asked the operator to approve a call they had
			// no way to identify.
			const toolCallId =
				meta.toolCallId !== undefined && meta.toolCallId.length > 0
					? input.resolveToolCallId(meta.toolCallId)
					: input.soleOpenToolCallId();
			// The operator is being shown a call the client already rendered, so the
			// arguments in the ask are that frame's own: a tool's admission normalizer
			// can rewrite a relative path to an absolute one or attach a prepared
			// artifact, and rebuilding the record from the registry's copy produced a
			// `rawInput` the client could not match to anything it had drawn. A bound
			// id always has a snapshot, since every open call stored one when it was
			// emitted; the missing case fails closed anyway.
			const snapshot = toolCallId === null ? null : input.toolCallSnapshot(toolCallId);
			if (toolCallId === null || snapshot === null) {
				const unbindableReason = "permission request has no bindable tool call";
				emitResolution({ status: "denied", decidedBy: "error", reason: unbindableReason });
				input.toolRegistry?.cancelParkedCall(meta.requestId, unbindableReason);
				queuedRequestIds.delete(meta.requestId);
				queuedRequestDetails.delete(meta.requestId);
				return;
			}
			// The transport has no per-request abort, so a cancelled prompt races
			// the outstanding request against a local deferral. The client's late
			// answer resolves a promise nothing is waiting on any more.
			const cancelled = new Promise<{ kind: "cancelled"; reason: string }>((resolveCancelled) => {
				pendingCancel = (reason: string) => resolveCancelled({ kind: "cancelled", reason });
			});
			try {
				const answered = Promise.resolve()
					.then(() =>
						input.transport.request<AcpRequestPermissionResponse>(
							"session/request_permission",
							{
								sessionId,
								toolCall: {
									sessionUpdate: "tool_call",
									toolCallId,
									title: boundString(call.tool, ACP_MAX_TOOL_TITLE_BYTES),
									kind: toolKind(call.tool),
									status: "pending",
									rawInput: snapshot.rawInput,
									...(snapshot.locations !== undefined ? { locations: snapshot.locations } : {}),
								},
								options: [
									{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
									{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
								],
							},
							input.permissionTimeoutMs,
						),
					)
					.then(
						(response) => ({ kind: "response" as const, response }),
						(err: unknown) => ({ kind: "failed" as const, err }),
					);
				const outcome = await Promise.race([answered, cancelled]);
				if (outcome.kind === "cancelled") {
					emitResolution({ status: "denied", decidedBy: "cancelled", reason: outcome.reason });
					input.toolRegistry?.cancelParkedCall(meta.requestId, outcome.reason);
					return;
				}
				if (outcome.kind === "response") {
					// Exactly one option grants. `startsWith("allow")` would let a
					// client mint `allow-always` and get a grant this server never
					// offered as an option.
					const answer = outcome.response.outcome;
					if (answer.outcome === "selected" && answer.optionId === "allow-once") {
						emitResolution({ status: "granted", decidedBy: "acp-client" });
						await input.toolRegistry?.resumeParkedCalls({
							actionClass: decision.classification.actionClass,
							requestId: meta.requestId,
							requestedBy: "acp-client",
						});
						return;
					}
					emitResolution({
						status: "denied",
						decidedBy: "acp-client",
						reason: "ACP client denied this tool call",
					});
					input.toolRegistry?.cancelParkedCall(meta.requestId, "ACP client denied this tool call");
					return;
				}
				const err = outcome.err;
				const message = `ACP permission request failed: ${err instanceof Error ? err.message : String(err)}`;
				if (err instanceof AcpTimeoutError) {
					emitResolution({
						status: "expired",
						decidedBy: "timeout",
						reason: "permission approval expired",
					});
					emitQueuedExpiryResolutions(meta.requestId);
					queuedRequestIds.clear();
					queuedRequestDetails.clear();
					// The registry has no non-denial settlement primitive. Cancel every
					// parked call only to let the aborted run unwind; the prompt handler
					// fails terminally before the model can observe/retry those verdicts.
					input.toolRegistry?.cancelParkedCalls("permission approval expired");
					input.expireActivePrompt();
					return;
				}
				emitResolution({
					status: "denied",
					decidedBy: "error",
					reason: message,
				});
				emitQueuedErrorResolutions(meta.requestId, message);
				queuedRequestIds.clear();
				queuedRequestDetails.clear();
				input.toolRegistry?.cancelParkedCalls(message);
			} finally {
				pendingCancel = null;
				queuedRequestIds.delete(meta.requestId);
				queuedRequestDetails.delete(meta.requestId);
			}
		};
		chain = chain.then(run, run);
	});
	return {
		unregister,
		cancelPending: (reason: string) => {
			pendingCancel?.(reason);
		},
	};
}

/** How long transport close waits for an in-flight prompt handler to settle. */
const ACP_PROMPT_SETTLE_BOUND_MS = 5000;

export async function serveClioAcpAgent(options: ClioAcpServerOptions): Promise<number> {
	const sessions = new Map<string, AcpServerSession>();
	const workspaceInstanceId = randomUUID();
	let initialized = false;
	let loopBlockedEventsEnabled = false;
	let eventSequence = 0;
	let activeSessionId: string | null = null;
	let activePromptState: ActivePrompt | null = null;
	let sessionCreated = false;
	let promptSettled: Promise<void> | null = null;
	const closedSessionIds = new Set<string>();
	// The launch cwd is the process's one workspace identity: settings, project
	// context, and the session ledger were all resolved against it during boot.
	// It is canonicalized once here so a client that passes a symlinked path, a
	// trailing slash, or a `/.` suffix is recognised rather than refused.
	const canonicalCwd = realpathSync(options.cwd ?? process.cwd());
	const permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(permissionTimeoutMs) ||
		permissionTimeoutMs < 1 ||
		permissionTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new Error(`ACP permission timeout must be between 1 and ${MAX_TIMER_DELAY_MS} milliseconds`);
	}
	const permission = installPermissionBridge({
		transport: options.transport,
		toolRegistry: options.toolRegistry,
		...(options.bus ? { bus: options.bus } : {}),
		activeSessionId: () => activeSessionId,
		resolveToolCallId: (engineToolCallId) =>
			activePromptState === null ? null : openWireIdFor(activePromptState, engineToolCallId),
		soleOpenToolCallId: () => {
			if (activePromptState === null || activePromptState.openToolCalls.size !== 1) return null;
			const [only] = activePromptState.openToolCalls;
			return only ?? null;
		},
		toolCallSnapshot: (wireId) =>
			activePromptState === null ? null : (activePromptState.toolCallSnapshots.get(wireId) ?? null),
		permissionTimeoutMs,
		expireActivePrompt: () => {
			if (activePromptState === null) return;
			activePromptState.permissionExpired = true;
			options.chat.cancel();
		},
	});
	const unsubscribeLoopBlocked =
		options.bus?.on(BusChannels.LoopBlocked, (payload: LoopBlockedPayload) => {
			if (!initialized || !loopBlockedEventsEnabled || activeSessionId === null || activePromptState === null) return;
			if (
				!Number.isSafeInteger(payload.repeatCount) ||
				payload.repeatCount < 1 ||
				!Number.isSafeInteger(payload.blocksThisTurn) ||
				payload.blocksThisTurn < 1 ||
				!Number.isSafeInteger(payload.budget) ||
				payload.budget < 1 ||
				!(["block", "lockout", "stop"] as ReadonlyArray<string>).includes(payload.disposition) ||
				payload.interrupted !== (payload.disposition === "stop")
			) {
				return;
			}
			const tool = safeStoredString(payload.tool, 64).trim();
			if (tool.length === 0) return;
			eventSequence += 1;
			try {
				options.transport.notify("clio-coder/event", {
					version: 1,
					workspaceInstanceId,
					sessionId: activeSessionId,
					turnId: safeStoredIdentifier(payload.turnId, ACP_MAX_SESSION_ID_BYTES),
					sequence: eventSequence,
					kind: "safety.loopBlocked",
					terminal: false,
					payload: {
						toolCallId: null,
						tool,
						repeatCount: payload.repeatCount,
						blocksThisTurn: payload.blocksThisTurn,
						budget: payload.budget,
						disposition: payload.disposition,
						interrupted: payload.interrupted,
						shape: null,
					},
				});
			} catch {
				options.diagnostics?.("failed to send an opted-in ACP event");
			}
		}) ?? (() => {});

	const requireInitialized = (): void => {
		if (!initialized) throw new AcpRequestError(-32000, "initialize must be called first", { code: "not_initialized" });
	};

	const sessionIdOf = (params: unknown): string => {
		return requireBoundedClientString(
			isRecord(params) ? params.sessionId : undefined,
			"sessionId",
			ACP_MAX_SESSION_ID_BYTES,
		);
	};

	const assertParamKeys = (params: unknown, allowed: ReadonlySet<string>): Record<string, unknown> => {
		if (params === undefined) return {};
		if (!isRecord(params) || Object.keys(params).some((key) => !allowed.has(key))) {
			throw new AcpRequestError(-32602, "invalid method parameters", { code: "invalid_params" });
		}
		return params;
	};

	const canonicalSessionCwd = (requested: unknown): string => {
		const mismatch = (): AcpRequestError =>
			new AcpRequestError(-32000, "session cwd does not match the server workspace", {
				code: "session_cwd_mismatch",
			});
		if (typeof requested !== "string" || requested.trim().length === 0 || !isAbsolute(requested)) throw mismatch();
		let sessionCwd: string;
		try {
			sessionCwd = realpathSync(resolvePath(requested));
		} catch {
			throw mismatch();
		}
		if (sessionCwd !== canonicalCwd) throw mismatch();
		return sessionCwd;
	};

	const workspaceHistory = (): SessionMeta[] => {
		const history = options.session?.history() ?? [];
		return history.filter((meta) => {
			if (safeStoredIdentifier(meta.id, ACP_MAX_SESSION_ID_BYTES) === null) return false;
			try {
				return realpathSync(resolvePath(meta.cwd)) === canonicalCwd;
			} catch {
				return false;
			}
		});
	};

	const workspaceMeta = (sessionId: string): SessionMeta => {
		const meta = workspaceHistory().find((candidate) => candidate.id === sessionId);
		if (!meta) throw new AcpRequestError(-32000, "unknown ACP session", { code: "session_unknown" });
		return meta;
	};

	const routingSnapshot = (): AcpRoutingSnapshot => {
		const route = options.routing?.() ?? { target: null, model: null };
		return {
			target: safeConfiguredIdentifier(route.target, ACP_MAX_TARGET_ID_BYTES),
			model: safeConfiguredIdentifier(route.model, ACP_MAX_MODEL_ID_BYTES),
		};
	};

	const getSession = (params: unknown): AcpServerSession => {
		const id = sessionIdOf(params);
		const session = sessions.get(id);
		if (!session) throw new AcpRequestError(-32000, "unknown ACP session", { code: "session_unknown" });
		return session;
	};

	options.transport.onRequest("initialize", (params) => {
		if (initialized) throw new AcpRequestError(-32000, "already initialized", { code: "already_initialized" });
		// A client that asked for a version this server does not speak must be
		// told so. Accepting it silently would leave a future v2 client believing
		// negotiation succeeded while every frame it receives is v1.
		const version = isRecord(params) ? params.protocolVersion : undefined;
		if (version !== 1) {
			throw new AcpRequestError(-32602, "unsupported ACP protocol version", {
				code: "protocol_version_unsupported",
				supported: [1],
			});
		}
		const clientCapabilities = isRecord(params) && isRecord(params.clientCapabilities) ? params.clientCapabilities : null;
		const clientMeta =
			clientCapabilities !== null && isRecord(clientCapabilities._meta) ? clientCapabilities._meta : null;
		const eventRequest =
			clientMeta !== null && isRecord(clientMeta["clio-coder/events"]) ? clientMeta["clio-coder/events"] : null;
		const requestedEventKinds = eventRequest !== null ? eventRequest.kinds : null;
		loopBlockedEventsEnabled =
			eventRequest !== null &&
			eventRequest.version === 1 &&
			Array.isArray(requestedEventKinds) &&
			requestedEventKinds.length <= 16 &&
			requestedEventKinds.every(
				(kind) => typeof kind === "string" && utf8Bytes(kind) <= 64 && !hasControlCharacters(kind),
			) &&
			requestedEventKinds.includes("safety.loopBlocked");
		const canLoadSession =
			options.session !== undefined &&
			options.readSessionEntries !== undefined &&
			options.buildReplayMessages !== undefined &&
			options.chat.resetForSession !== undefined;
		initialized = true;
		return {
			protocolVersion: 1,
			agentInfo: {
				name: "clio-coder",
				title: "Clio Coder",
				...(options.version !== undefined ? { version: options.version } : {}),
			},
			agentCapabilities: {
				loadSession: canLoadSession,
				promptCapabilities: { audio: false, embeddedContext: false, image: false },
				mcpCapabilities: { http: false, sse: false },
				// Clio mediates every tool through its own safety policy and supports an
				// explicit session/close (a documented ACP RFD, not yet in the stable
				// schema). Both are advertised via the _meta extension slot so strict
				// clients never observe a non-spec capability field.
				_meta: {
					[ACP_SESSION_META_KEY]: {
						close: true,
						list: options.session !== undefined,
						label: options.session !== undefined,
						delete: options.session !== undefined,
						autonomy: true,
					},
					"clio-coder/settings": {
						get_safe: options.settings !== undefined,
						patch_safe: options.settings !== undefined,
					},
					"clio-coder/targets": {
						list: options.providers !== undefined,
						probe: options.providers !== undefined,
					},
					...(options.bus
						? {
								"clio-coder/events": {
									version: 1,
									notification: "clio-coder/event",
									kinds: ["safety.loopBlocked"],
									workspaceInstanceId,
								},
							}
						: {}),
					...(options.toolRegistry !== undefined ? { "clio-coder/tools": "mediated" } : {}),
				},
			},
			authMethods: [],
		} satisfies AcpInitializeResponse;
	});

	options.transport.onRequest("session/new", (params) => {
		requireInitialized();
		// One chat instance, one provider context, one ledger ancestry. A second
		// session id over the same process would share all three with the first,
		// so the honest answer is to refuse and let the client start a process.
		if (sessionCreated) {
			throw new AcpRequestError(-32000, "this server hosts one session per process", { code: "session_limit" });
		}
		const sessionCwd = canonicalSessionCwd(isRecord(params) ? params.cwd : undefined);
		const route = routingSnapshot();
		const createInput: { cwd: string; target?: string; model?: string } = { cwd: sessionCwd };
		if (route.target !== null) createInput.target = route.target;
		if (route.model !== null) createInput.model = route.model;
		const meta = options.session?.create(createInput);
		const id = meta?.id ?? randomUUID();
		if (safeStoredIdentifier(id, ACP_MAX_SESSION_ID_BYTES) === null) {
			throw new AcpRequestError(-32000, "session creation failed", { code: "internal_error" });
		}
		const autonomy = options.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
		const boundTarget = safeConfiguredIdentifier(meta?.target ?? route.target, ACP_MAX_TARGET_ID_BYTES);
		const boundModel = safeConfiguredIdentifier(meta?.model ?? route.model, ACP_MAX_MODEL_ID_BYTES);
		const session: AcpServerSession = {
			id,
			cwd: sessionCwd,
			autonomy,
			autonomySource: "settings",
			target: boundTarget,
			model: boundModel,
			createdAt: meta?.createdAt ?? new Date().toISOString(),
			activePrompt: null,
		};
		sessionCreated = true;
		sessions.set(id, session);
		// NewSessionResponse is { sessionId, modes?, models?, _meta? }; cwd is not a
		// schema field. Clio runs a single-session-per-process server pinned to the
		// launch cwd, so no extra fields are needed.
		return { sessionId: id, _meta: { [ACP_SESSION_META_KEY]: sessionResultMeta(session, false) } };
	});

	options.transport.onRequest("session/load", async (params) => {
		requireInitialized();
		if (sessionCreated) {
			throw new AcpRequestError(-32000, "this server hosts one session per process", { code: "session_limit" });
		}
		const request = assertParamKeys(params, new Set(["sessionId", "cwd", "mcpServers"]));
		const id = sessionIdOf(request);
		canonicalSessionCwd(request.cwd);
		if (!Array.isArray(request.mcpServers) || request.mcpServers.length !== 0) {
			throw new AcpRequestError(-32602, "mcpServers must be an empty array", { code: "invalid_params" });
		}
		const stored = workspaceMeta(id);
		if (stored.endedAt === null) {
			throw new AcpRequestError(-32000, "session may already be open", { code: "session_open" });
		}
		const storedTarget = safeConfiguredIdentifier(stored.target, ACP_MAX_TARGET_ID_BYTES);
		const storedModel = safeConfiguredIdentifier(stored.model, ACP_MAX_MODEL_ID_BYTES);
		if (
			options.session === undefined ||
			options.readSessionEntries === undefined ||
			options.buildReplayMessages === undefined ||
			options.chat.resetForSession === undefined
		) {
			throw new AcpRequestError(-32000, "session loading is unavailable", { code: "internal_error" });
		}

		let leafTurnId: string | null;
		let replayMessages: ReadonlyArray<AgentMessage>;
		let replay: PreparedAcpReplay;
		try {
			leafTurnId = options.session.tree(id).leafId;
			const entries = options.readSessionEntries(id);
			replayMessages = options.buildReplayMessages(entries, leafTurnId);
			replay = prepareAcpReplay(entries, leafTurnId, id);
		} catch {
			throw new AcpRequestError(-32000, "session could not be loaded", { code: "internal_error" });
		}

		let resumed: SessionMeta;
		try {
			resumed = options.session.resume(id);
			if (resumed.id !== id || options.session.current()?.id !== id) throw new Error("resume identity mismatch");
			options.chat.resetForSession(leafTurnId, replayMessages);
		} catch {
			if (options.session.current()?.id === id) {
				try {
					await options.session.close();
				} catch {
					// Best effort: no replay has been emitted and the slot remains unused.
				}
			}
			throw new AcpRequestError(-32000, "session could not be loaded", { code: "internal_error" });
		}

		const autonomy = options.autonomy?.() ?? DEFAULT_AUTONOMY_LEVEL;
		const session: AcpServerSession = {
			id,
			cwd: canonicalCwd,
			autonomy,
			autonomySource: "settings",
			target: storedTarget,
			model: storedModel,
			createdAt: stored.createdAt,
			activePrompt: null,
		};
		sessionCreated = true;
		sessions.set(id, session);
		for (const replayParams of replay.params) options.transport.notify("session/update", replayParams);
		return {
			_meta: {
				[ACP_SESSION_META_KEY]: sessionResultMeta(session, true, {
					turns: replay.turns,
					truncated: replay.truncated,
				}),
			},
		};
	});

	options.transport.onRequest("clio-coder/session/list", (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["limit"]));
		const limit = request.limit === undefined ? 50 : request.limit;
		if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200) {
			throw new AcpRequestError(-32602, "limit must be an integer from 1 to 200", { code: "invalid_params" });
		}
		const history = workspaceHistory();
		const projected: Array<Record<string, unknown>> = [];
		let budgetBytes = ACP_EMPTY_TRUNCATED_SESSION_LIST_BYTES;
		let budgetExhausted = false;
		for (const meta of history.slice(0, limit as number)) {
			const hosted = sessions.has(meta.id);
			const label = safeStoredString(meta.name, ACP_MAX_LABEL_BYTES).trim();
			const preview = safeStoredString(meta.firstMessagePreview, ACP_MAX_PREVIEW_BYTES).replace(/\s+/gu, " ").trim();
			const item = {
				sessionId: meta.id,
				label: label.length > 0 ? label : null,
				preview,
				createdAt: safeIso(meta.createdAt),
				updatedAt: safeIso(meta.lastActivityAt ?? meta.endedAt ?? meta.createdAt),
				turns: Number.isSafeInteger(meta.messageCount) && (meta.messageCount ?? 0) >= 0 ? meta.messageCount : 0,
				target: safeStoredIdentifier(meta.target, ACP_MAX_TARGET_ID_BYTES),
				model: safeStoredIdentifier(meta.model, ACP_MAX_MODEL_ID_BYTES),
				state: hosted ? "open" : meta.endedAt === null ? "unknown" : "closed",
				hosted,
			};
			const itemBytes = utf8Bytes(JSON.stringify(item));
			const separatorBytes = projected.length > 0 ? 1 : 0;
			if (budgetBytes + separatorBytes + itemBytes > ACP_MAX_SESSION_LIST_RESULT_BYTES) {
				budgetExhausted = true;
				break;
			}
			projected.push(item);
			budgetBytes += separatorBytes + itemBytes;
		}
		return {
			sessions: projected,
			truncated: history.length > projected.length,
			...(budgetExhausted ? { _meta: { "clio-coder/truncated": true } } : {}),
		};
	});

	options.transport.onRequest("clio-coder/session/label", (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "label"]));
		const id = sessionIdOf(request);
		workspaceMeta(id);
		const label = requireBoundedClientString(request.label, "label", ACP_MAX_LABEL_BYTES, { allowEmpty: true });
		if (options.session === undefined) {
			throw new AcpRequestError(-32000, "session naming is unavailable", { code: "internal_error" });
		}
		try {
			options.session.setName(label, id);
		} catch {
			throw new AcpRequestError(-32000, "session label could not be saved", { code: "internal_error" });
		}
		return {};
	});

	options.transport.onRequest("clio-coder/session/delete", (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const id = sessionIdOf(request);
		const meta = workspaceMeta(id);
		if (sessions.has(id) || meta.endedAt === null) {
			throw new AcpRequestError(-32000, "session may already be open", { code: "session_open" });
		}
		if (options.session === undefined) {
			throw new AcpRequestError(-32000, "session deletion is unavailable", { code: "internal_error" });
		}
		try {
			options.session.deleteSession(id);
		} catch {
			throw new AcpRequestError(-32000, "session could not be deleted", { code: "internal_error" });
		}
		return {};
	});

	options.transport.onRequest("clio-coder/session/autonomy", (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "level"]));
		const session = getSession(request);
		if (request.level === undefined) return { level: session.autonomy, source: session.autonomySource };
		if (
			typeof request.level !== "string" ||
			!(["read-only", "suggest", "auto-edit", "full-auto"] as ReadonlyArray<string>).includes(request.level)
		) {
			throw new AcpRequestError(-32602, "invalid autonomy level", { code: "invalid_params" });
		}
		if (session.activePrompt !== null) {
			throw new AcpRequestError(-32000, "cannot change autonomy during an active prompt", { code: "prompt_active" });
		}
		session.autonomy = request.level as AutonomyLevel;
		session.autonomySource = "session";
		return { level: session.autonomy, source: session.autonomySource };
	});

	options.transport.onRequest("clio-coder/settings/get_safe", (params) => {
		requireInitialized();
		assertParamKeys(params, new Set());
		if (options.settings === undefined) {
			throw new AcpRequestError(-32000, "safe settings are unavailable", { code: "internal_error" });
		}
		return safeSettingsProjection(options.settings.read());
	});

	options.transport.onRequest("clio-coder/settings/patch_safe", (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["patch"]));
		if (!isRecord(request.patch)) {
			throw new AcpRequestError(-32602, "patch must be an object", { code: "invalid_params" });
		}
		if (activePromptState !== null) {
			throw new AcpRequestError(-32000, "cannot patch settings during an active prompt", { code: "prompt_active" });
		}
		if (options.settings === undefined) {
			throw new AcpRequestError(-32000, "safe settings are unavailable", { code: "internal_error" });
		}
		const patch: AcpSafeSettingsPatch = {};
		for (const [key, value] of Object.entries(request.patch)) {
			if (!(ACP_SAFE_SETTINGS_KEYS as ReadonlyArray<string>).includes(key)) {
				throw new AcpRequestError(-32602, "patch contains an unknown setting", { code: "invalid_params" });
			}
			switch (key) {
				case "orchestrator.target": {
					if (value === null) {
						patch[key] = null;
						break;
					}
					const target = requireBoundedClientString(value, key, ACP_MAX_TARGET_ID_BYTES);
					if (options.providers?.getTarget(target) === null || options.providers === undefined) {
						throw new AcpRequestError(-32602, "target is not configured", {
							code: "invalid_params",
							reason: "target-unknown",
						});
					}
					patch[key] = target;
					break;
				}
				case "orchestrator.model":
					patch[key] = value === null ? null : requireBoundedClientString(value, key, ACP_MAX_MODEL_ID_BYTES);
					break;
				case "orchestrator.thinkingLevel":
					if (typeof value !== "string" || !ACP_THINKING_LEVELS.has(value as AcpThinkingLevel)) {
						throw new AcpRequestError(-32602, "invalid thinking level", { code: "invalid_params" });
					}
					patch[key] = value as AcpThinkingLevel;
					break;
				case "autonomy":
					if (typeof value !== "string" || !ACP_AUTONOMY_LEVELS.has(value as AutonomyLevel)) {
						throw new AcpRequestError(-32602, "invalid autonomy level", { code: "invalid_params" });
					}
					patch[key] = value as AutonomyLevel;
					break;
			}
		}
		const current = options.settings.read();
		const nextTarget = patch["orchestrator.target"] === undefined ? current.target : patch["orchestrator.target"];
		const nextModel = patch["orchestrator.model"] === undefined ? current.model : patch["orchestrator.model"];
		if (nextTarget === null && nextModel !== null) {
			throw new AcpRequestError(-32602, "model requires a configured target", { code: "invalid_params" });
		}
		try {
			return safeSettingsProjection(options.settings.commit(patch));
		} catch {
			throw new AcpRequestError(-32000, "safe settings could not be updated", { code: "internal_error" });
		}
	});

	options.transport.onRequest("clio-coder/targets/list", (params) => {
		requireInitialized();
		assertParamKeys(params, new Set());
		if (options.providers === undefined) {
			throw new AcpRequestError(-32000, "target discovery is unavailable", { code: "internal_error" });
		}
		const targets: AcpSafeTargetProjection[] = [];
		let budgetExhausted = false;
		// Budget incrementally from the exact JSON representation. Re-serializing
		// the growing full result for every one of up to 4,096 model ids turns a
		// bounded config list into avoidable quadratic work.
		let budgetBytes = ACP_EMPTY_TRUNCATED_TARGET_LIST_BYTES;
		for (const status of options.providers.list()) {
			const projected = safeTargetProjection(status);
			if (projected === null) continue;
			const bounded: AcpSafeTargetProjection = { ...projected, models: [] };
			let boundedBytes = utf8Bytes(JSON.stringify(bounded));
			const targetSeparatorBytes = targets.length > 0 ? 1 : 0;
			if (budgetBytes + targetSeparatorBytes + boundedBytes > ACP_MAX_TARGET_LIST_RESULT_BYTES) {
				budgetExhausted = true;
				break;
			}
			targets.push(bounded);
			budgetBytes += targetSeparatorBytes + boundedBytes;
			for (const model of projected.models) {
				const candidateModels = [...bounded.models, model];
				const candidate = { ...bounded, models: candidateModels };
				const candidateBytes = utf8Bytes(JSON.stringify(candidate));
				if (budgetBytes + candidateBytes - boundedBytes > ACP_MAX_TARGET_LIST_RESULT_BYTES) {
					budgetExhausted = true;
					break;
				}
				bounded.models.push(model);
				budgetBytes += candidateBytes - boundedBytes;
				boundedBytes = candidateBytes;
			}
			if (budgetExhausted) break;
			if (targets.length === ACP_MAX_TARGETS) break;
		}
		return {
			targets,
			...(budgetExhausted ? { _meta: { "clio-coder/truncated": true } } : {}),
		};
	});

	options.transport.onRequest("clio-coder/targets/probe", async (params) => {
		requireInitialized();
		const request = assertParamKeys(params, new Set(["targetId"]));
		const targetId = requireBoundedClientString(request.targetId, "targetId", ACP_MAX_TARGET_ID_BYTES);
		if (options.providers === undefined || options.providers.getTarget(targetId) === null) {
			throw new AcpRequestError(-32602, "target is not configured", {
				code: "invalid_params",
				reason: "target-unknown",
			});
		}
		try {
			const status = await options.providers.probeTarget(targetId, { reasoning: false });
			if (status === null) return { targetId, healthy: false, latencyMs: null, reason: "probe-failed" };
			const reason = safeProbeReason(options.providers, status);
			const latencyMs =
				typeof status.health.latencyMs === "number" &&
				Number.isFinite(status.health.latencyMs) &&
				status.health.latencyMs >= 0
					? Math.round(status.health.latencyMs)
					: null;
			return { targetId, healthy: reason === null, latencyMs, reason };
		} catch {
			return { targetId, healthy: false, latencyMs: null, reason: "probe-failed" };
		}
	});

	const cancelSession = (session: AcpServerSession, reason: string): void => {
		if (!session.activePrompt) return;
		session.activePrompt.cancelled = true;
		options.chat.cancel();
		// A prompt cancelled with a permission parked would otherwise sit on the
		// outstanding request until the client answers or the timeout fires, and
		// the turn cannot settle until the parked tool does.
		permission.cancelPending(reason);
	};

	const cancel = (params: unknown): Record<string, never> => {
		requireInitialized();
		cancelSession(getSession(params), "prompt cancelled");
		return {};
	};
	options.transport.onRequest("session/cancel", cancel);
	options.transport.onNotification("session/cancel", (params) => {
		// A notification has no reply channel, so an ordering or identity error
		// has nowhere to go. Dropping it silently is the only conformant option.
		if (!initialized) return;
		const id = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : null;
		const session = id === null ? undefined : sessions.get(id);
		if (session) cancelSession(session, "prompt cancelled");
	});

	options.transport.onRequest("session/close", async (params) => {
		requireInitialized();
		const id = sessionIdOf(params);
		// Idempotent: a client tearing down cannot always know whether the server
		// already dropped the session, and a second close is not an error.
		if (!sessions.has(id) && closedSessionIds.has(id)) return {};
		const session = getSession(params);
		// Closing under an active prompt is what raced the session writer against
		// the chat loop still persisting the aborted turn. The client cancels and
		// awaits the prompt's terminal response first.
		if (session.activePrompt) {
			throw new AcpRequestError(-32000, "cancel the active prompt before closing the session", {
				code: "prompt_active",
			});
		}
		if (options.session?.current()?.id === session.id) await options.session.close();
		sessions.delete(session.id);
		closedSessionIds.add(session.id);
		return {};
	});

	options.transport.onRequest("session/prompt", async (params): Promise<AcpPromptResponse> => {
		requireInitialized();
		const session = getSession(params);
		if (session.activePrompt || options.chat.isStreaming()) {
			throw new AcpRequestError(-32000, "this session already has an active prompt", { code: "prompt_active" });
		}
		const text = promptText(params);
		if (text.length === 0) throw new AcpRequestError(-32602, "prompt text is required", { code: "invalid_params" });
		if (options.session?.current()?.id !== session.id && options.session) options.session.resume(session.id);
		const active = createActivePromptState();
		session.activePrompt = active;
		activePromptState = active;
		activeSessionId = session.id;
		// Transport close waits on this so the session store never stops while the
		// chat loop is still persisting an aborted turn.
		let settle: () => void = () => {};
		promptSettled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		options.onActiveSessionAutonomyChange?.(session.autonomy);
		const unsubscribe = options.chat.onEvent((event) =>
			handleChatEvent(event, options.transport, session.id, active, canonicalCwd, options.diagnostics, () => {
				permission.cancelPending("tool call limit exceeded");
				options.toolRegistry?.cancelParkedCalls("tool call limit exceeded");
				options.chat.cancel();
			}),
		);
		try {
			await options.chat.submit(text);
		} catch (err) {
			active.errored = true;
			active.errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			unsubscribe();
			if (session.activePrompt === active) session.activePrompt = null;
			if (activePromptState === active) activePromptState = null;
			if (activeSessionId === session.id) {
				activeSessionId = null;
				options.onActiveSessionAutonomyChange?.(null);
			}
			promptSettled = null;
			settle();
		}
		// Expiry is not a delayed denial or an operator cancellation. It aborts
		// the run and fails the prompt so the model cannot react to/retry it.
		if (active.permissionExpired) {
			settleOpenToolCalls(options.transport, session.id, active, "permission approval expired");
			throw new AcpRequestError(-32000, "permission approval expired", { code: "permission_expired" });
		}
		// W001-A1: a peer that holds bounded per-turn state must never see a
		// 129th tool start. This is a normal ACP agent-side request ceiling, not a
		// provider failure or an operator cancellation.
		if (active.toolCallLimitReached) {
			settleOpenToolCalls(options.transport, session.id, active, "tool call limit exceeded");
			return promptResponse("max_turn_requests", active);
		}
		// Operator cancellation takes precedence over ordinary turn outcomes.
		if (active.cancelled) {
			settleOpenToolCalls(options.transport, session.id, active, "cancelled");
			return promptResponse("cancelled", active);
		}
		// The empty-success defect: Clio refused to start the turn, the notice
		// carrying the reason has no ACP equivalent, and nothing else in the turn
		// distinguishes the refusal from a model that chose to say nothing. The
		// reason travels as a code; the notice text carries the settings path and
		// stays off the wire.
		if (active.admissionReason !== undefined && !active.sawTurnEnd && active.updatesSent === 0) {
			throw new AcpRequestError(-32000, `Clio could not admit this prompt: ${active.admissionReason}`, {
				code: "prompt_not_admitted",
				reason: active.admissionReason,
			});
		}
		// ACP has no error StopReason: a failed turn is signalled by failing the
		// session/prompt request itself.
		if (active.errored) {
			settleOpenToolCalls(options.transport, session.id, active, "turn failed");
			// Provider prose never reaches the wire. Bounding it was not enough: a
			// provider error body legitimately quotes a request URL, a filesystem
			// path, or the credential it was rejected for, and a bounded copy of a
			// secret is still the secret. The client gets host-authored text plus
			// the `turn_failed` code; the original goes to the stderr tail.
			if (active.errorMessage !== undefined) {
				options.diagnostics?.(`turn failed: ${acpErrorMessage(active.errorMessage)}`);
			}
			throw new AcpRequestError(-32000, ACP_TURN_FAILED_MESSAGE, { code: "turn_failed" });
		}
		return promptResponse(active.stopReason, active);
	});

	return await new Promise<number>((resolve) => {
		options.transport.onClose(() => {
			permission.unregister();
			unsubscribeLoopBlocked();
			permission.cancelPending("ACP transport closed");
			for (const session of sessions.values()) cancelSession(session, "ACP transport closed");
			const inFlight = promptSettled;
			if (inFlight === null) {
				resolve(0);
				return;
			}
			// The prompt handler owns the chat loop's settlement; resolving the
			// serve promise before it returns lets the orchestrator stop domains
			// under a live writer. The bound keeps a wedged turn from holding the
			// process open forever.
			const timer = setTimeout(() => resolve(0), ACP_PROMPT_SETTLE_BOUND_MS);
			timer.unref?.();
			void inFlight.then(() => {
				clearTimeout(timer);
				resolve(0);
			});
		});
	});
}

/** PromptResponse is `{ stopReason, _meta? }`; usage is not an ACP v1 field. */
function promptResponse(stopReason: string, active: ActivePrompt): AcpPromptResponse {
	return {
		stopReason,
		_meta: {
			[ACP_USAGE_META_KEY]: {
				input: active.usage.input,
				output: active.usage.output,
				cacheRead: active.usage.cacheRead,
				cacheWrite: active.usage.cacheWrite,
				reasoning: active.usage.reasoning,
			},
		},
	};
}

export type AcpPromptContent = AcpContentBlock[];
