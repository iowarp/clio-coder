import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CallFailureRecord } from "../../../core/call-failure.js";
import { trackCallFetch } from "../../../core/call-failure.js";
import type { ThinkingLevel } from "../../../core/defaults.js";
import type { SideCallAuth } from "../../../core/oauth-retry.js";
import { rememberOAuthCallFailure, withOAuthRefresh } from "../../../core/oauth-retry.js";
import { prepareProviderCheckpoint } from "../../../core/provider-checkpoint.js";
import { ProviderCompactionError } from "../../../core/provider-checkpoint-handle.js";
import type { SurfaceId } from "../../../core/side-surfaces.js";
import type { CallMessageObserver } from "../../../core/telemetry/producer.js";
import type { CheckpointDefect, CompactionFailureCause } from "../../../core/telemetry/schemas.js";
// Direct modules, not the memory barrel: entries and compaction sit in the
// interactive Stage 0 graph, and the barrel would pull in the whole runtime.
import {
	buildLivePrefixUserText,
	buildTurnPrefixUserText,
	buildUserText,
	COMPACTION_SYSTEM_PROMPT,
} from "../../memory/compaction-prompts.js";
import type { MemoryCompactionOffer, MemoryConsumptionReceipt, MemoryOfferOutcome } from "../../memory/contract.js";
import { observationEvent, observationTracing, traceObservation } from "../../memory/observation-events.js";
import type { AdmissionHold, CallJournalOptions, CallScope } from "../../telemetry/call-scope.js";
import { openCallScope } from "../../telemetry/call-scope.js";

export {
	COMPACTION_SYSTEM_PROMPT,
	COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE,
	COMPACTION_USER_PROMPT_TEMPLATE,
} from "../../memory/compaction-prompts.js";

import { ceilChars, normalizeTokenUsage } from "../../../core/token-split.js";
import { continuityPayloadFromFold } from "../continuity/carry.js";
import type { ContinuityCheckpointPayload } from "../continuity/contract.js";
import { type ContinuityProjectionInput, resolveContinuityProjection } from "../continuity/projection.js";
/**
 * Compaction orchestration.
 *
 * Given a list of session entries, finds the cut point, summarizes the
 * history portion via the supplied model, and returns the trimmed entry
 * list plus summary metadata. Callers persist the summary via
 * `session.appendEntry({ kind: "compactionSummary", ... })`.
 *
 * The stream call goes through `src/engine/ai.ts` to honor the engine
 * boundary; this module does not import pi-ai directly.
 */

import { hasAssistantGenerationDelta, streamSimple } from "../../../engine/ai.js";
import type { EngineModel, ProviderCheckpointHandle, ProviderCompactionResult, Usage } from "../../../engine/types.js";
import { effectiveToolCall, expandChainMessages } from "../../../tools/surface.js";
import { foldWorkingSet } from "../../context/working-set/fold.js";
import { projectWorkingSet } from "../../context/working-set/project.js";
import { recallableRefs } from "../../context/working-set/recall.js";
import { estimateAgentContextTokens, extractReasoningTokens } from "../context-accounting.js";
import type { CompactionSummaryEntry } from "../entries.js";
import {
	type CompactionUsage,
	latestSkillContextState,
	OPERATOR_NOTE_ENTRY,
	type PreservedUserContext,
	type SessionEntry,
	type SkillContextCheckpoint,
	type SkillContextState,
	skillContextContentHash,
	standingOperatorNotes,
	verifiedSkillContextCheckpoint,
} from "../entries.js";
import { findLastEntry } from "../tree/active-path.js";
import { serializeConversation, TOOL_RESULT_MAX_CHARS } from "./branch-summary.js";
import { findCutPoint } from "./cut-point.js";
import { DEFAULT_KEEP_RECENT_TOKENS, DEFAULT_RESERVE_TOKENS } from "./defaults.js";
import {
	type FileOperations,
	formatExactFacts,
	recordPriorFileOperations,
	stripEchoedExactFacts,
} from "./exact-facts.js";
import { noteSummaryUsage } from "./reasoning-share.js";
import { summaryOutputBudget, summaryOutputForRoom, summaryRoomTokens } from "./summary-output.js";
import { type ContinuityNoteCost, calculateContextTokens, estimateTokens, getLastAssistantUsage } from "./tokens.js";

/** Why a compaction failed and, for a refused checkpoint, what the validator refused (FX-6). */
type CompactionFailure = { cause: CompactionFailureCause; defect?: CheckpointDefect };
const compactionFailures = new WeakMap<object, CompactionFailure>();

/** Mark an error with its compaction failure cause; the first mark stands. Returns the error for `throw`. */
export function tagCompactionFailure<T>(error: T, cause: CompactionFailureCause, defect?: CheckpointDefect): T {
	if (typeof error === "object" && error !== null && !compactionFailures.has(error))
		compactionFailures.set(error, defect === undefined ? { cause } : { cause, defect });
	return error;
}

/** The cause a failed `compaction.settled` journals; a stop wins, and an unmarked error is `internal`. */
export function compactionFailureOf(error: unknown, aborted: boolean): CompactionFailure {
	if (aborted || (error instanceof Error && error.name === "AbortError")) return { cause: "aborted" };
	return (
		(typeof error === "object" && error !== null ? compactionFailures.get(error) : undefined) ?? { cause: "internal" }
	);
}

const HISTORY_HEADINGS = [
	"## Goal",
	"## Constraints & Preferences",
	"## Progress",
	"### Done",
	"### In Progress",
	"### Blocked",
	"## Key Decisions",
	"## Next Steps",
	"## Critical Context",
];

/**
 * Validate the history checkpoint, never the intentionally different split-turn prompt. A checkpoint with every
 * required heading once, outside code fences, but out of order is repaired: each heading's section, through the line
 * before the next required heading, moves into the required order, so a paid summary is not discarded for its order
 * alone (FX-6). A fence still open at the end is closed there, which costs no call (CLI-P5); a missing or repeated
 * heading, including one the closed fence holds, is refused.
 */
function checkedHistorySummary(summary: string): string {
	let text = summary;
	const lines = text.split(/\r?\n/);
	const found: Array<{ heading: string; line: number }> = [];
	let fence: { character: string; length: number } | undefined;
	for (const [index, line] of lines.entries()) {
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1] ?? "";
			if (!fence) fence = { character: marker[0] ?? "", length: marker.length };
			else if (marker[0] === fence.character && marker.length >= fence.length && !fenceMatch[2]?.trim()) fence = undefined;
			continue;
		}
		if (fence) continue;
		const heading = /^ {0,3}(#{2,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
		if (heading) {
			const normalized = `${heading[1]} ${heading[2]}`;
			if (HISTORY_HEADINGS.includes(normalized)) found.push({ heading: normalized, line: index });
		}
	}
	const refuse = (defect: CheckpointDefect): never => {
		throw tagCompactionFailure(
			new Error(
				"compaction returned an incomplete history checkpoint: required headings must appear in order outside code fences; checkpoint was not saved",
			),
			"checkpoint_format",
			defect,
		);
	};
	const closed = fence !== undefined;
	if (fence) {
		const marker = fence.character.repeat(fence.length);
		lines.push(marker);
		text = `${text}\n${marker}`;
	}
	if (found.length !== HISTORY_HEADINGS.length || new Set(found.map((entry) => entry.heading)).size !== found.length)
		refuse(closed ? "unclosed_fence" : "heading_set");
	if (found.every((entry, index) => entry.heading === HISTORY_HEADINGS[index])) return text;
	const sections = new Map(
		found.map((entry, index) => [entry.heading, lines.slice(entry.line, found[index + 1]?.line ?? lines.length)]),
	);
	return [
		...lines.slice(0, found[0]?.line ?? 0),
		...HISTORY_HEADINGS.flatMap((heading) => sections.get(heading) ?? []),
	].join("\n");
}

/** The request a refused checkpoint is asked for again with: the original request and what the validator said. */
function checkpointRetryText(userText: string, error: unknown, history: boolean): string {
	const reason = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/u, "");
	const format = history
		? ` Use each of these headings exactly once, in this order, outside code fences: ${HISTORY_HEADINGS.join(", ")}.`
		: "";
	return `${userText}\n\n<checkpoint-rejected>\nYour previous reply to this request was rejected: ${reason}. Write the complete checkpoint again.${format}\n</checkpoint-rejected>`;
}

/** One invoked summary stream, including failed calls that produce no checkpoint. */
export interface CompactionCallObservation {
	callId?: string;
	attemptId?: string;
	failure?: CallFailureRecord;
	outcome: "success" | "error" | "aborted";
	usage: unknown;
	timestamp: string;
}

export interface CompactInput extends SideCallAuth {
	telemetry?: CallJournalOptions;
	/** Main-route native port, supplied only after runtime, setting and flow admission (#423). */
	providerCompaction?: (
		observe: CompactInput["onCall"],
		callTelemetry?: CallMessageObserver,
	) => Promise<ProviderCompactionResult>;
	providerCheckpointSource?: { sessionId: string; archive: string };
	providerFallbackReason?: string;
	/** The destination must restore original history instead of replaying the existing native handle (#422). */
	providerReplayFallback?: boolean;
	/**
	 * Memory's substitute for one history slice. `slice` holds the raw ledger
	 * entries the slice covers, which is what observation batches were prepared
	 * from and are keyed on; `projected` holds the same positions after the
	 * working-set projection (evicted results as stubs), which is what any
	 * uncovered unit is serialized from so the fallback text stays the ordinary one.
	 */
	offerMemory?: (
		slice: readonly SessionEntry[],
		ordinary: string,
		projected: readonly SessionEntry[],
	) => MemoryCompactionOffer | null;
	/**
	 * Admission after exact request-fit, before each provider call. Its time is the call's admission stage; it sets
	 * `hold.waitedOn` when a ceiling held the call (#434).
	 */
	beforeSummaryCall?: ((hold: AdmissionHold, signal?: AbortSignal) => void | Promise<void>) | undefined;
	/**
	 * A split fold's second endpoint slot (MD10), asked once just before its history and split-turn summaries are sent.
	 * A release means the route admits both now: they run concurrently and the release follows the later settle. Null,
	 * or no hook, runs them in sequence, as on a capacity-one route.
	 */
	holdSecondSummarySlot?: () => (() => void) | null;
	/** Price the proposed replay before persisting the operator-visible figures. */
	checkpointTokenFigures?: (entry: Readonly<Omit<CompactionSummaryEntry, "timestamp">>) => {
		tokensBefore: number;
		tokensAfter: number;
		/** Tokens `tokensAfter` sits below the automatic trigger, 0 at or above it; journaled on `compaction.settled`. */
		headroomTokens?: number;
		/** Tokens `tokensAfter` still sits above the automatic trigger. */
		overTriggerTokens?: number;
		/** The output reserve a request of `tokensAfter` input is fitted with. */
		fitReserveTokens?: number;
	};
	checkpointForSummary?:
		| ((summaryRef: string, tokensBefore: number, tokensAfter: number) => ContinuityCheckpointPayload)
		| undefined;
	/** Ordered active-path session entries to compact; returned cut indexes address this same array. */
	entries: ReadonlyArray<SessionEntry>;
	/** Session working directory; the exact-facts block measures the files it names against it. */
	cwd?: string;
	/** Authoritative main-agent selection; omitted for unknown legacy state. */
	skillContextState?: SkillContextState | null;
	/**
	 * The main route's live prefix as a summarizer, offered only when the compaction model is the live main model.
	 * Used instead of the portable request when it is the cheaper of the two; null when the prefix is not servable
	 * from cache (T4).
	 */
	livePrefix?: (signal?: AbortSignal) => Promise<LivePrefixSummary | null>;
	/** Pure source-test seam. Production uses the existing summary stream. */
	summarize?: (request: {
		systemPrompt: string;
		userText: string;
		/** Absent when the model reports no output limit and the server decides. */
		maxTokens?: number;
	}) => Promise<{ text: string; usage?: unknown }>;

	/** Resolved orchestrator or compaction-override model. */
	model: EngineModel;
	/**
	 * The thinking level the portable summary request runs at: what its route resolves for a request with thinking off,
	 * so an always-on model still reads as thinking. Under `summaryOutputCap` only a level above off reserves reasoning
	 * room in the summary's output cap (CTX-3); an uncapped summary keys on the model. Absent reads as off.
	 */
	summaryThinkingLevel?: ThinkingLevel;
	/** API key for the model. Optional because local engines accept a fallback handled upstream. */
	apiKey?: string;
	/** Per-provider headers to pass through with the stream request. */
	headers?: Record<string, string>;
	/** AbortSignal to cancel the summarization mid-stream. */
	signal?: AbortSignal;
	/** Optional user-supplied focus appended to the summarization instructions. */
	instructions?: string;
	/** Override the built-in COMPACTION_SYSTEM_PROMPT for the call. */
	systemPrompt?: string;
	/** Override the built-in reserve-tokens default (DEFAULT_RESERVE_TOKENS). */
	reserveTokens?: number;
	/** Override the built-in keep-recent default (DEFAULT_KEEP_RECENT_TOKENS). */
	keepRecentTokens?: number;
	/** A bound on the summary request's output cap: a chat-route summary on a small window (bt-18). */
	summaryOutputCap?: number;
	/** The silence each summary stream may keep before it is stopped (CLI-P9); absent, a stream waits unbounded. */
	summaryStall?: SummaryStallWindow;
	/**
	 * History the cut aims to leave: the checkpoint plus the retained suffix. The summary request states the room
	 * this leaves the checkpoint when that room is below the summary's own output room.
	 */
	retainedTargetTokens?: number;
	/**
	 * The pending request does not fit without a reduction, so it is refused
	 * unless this pass shrinks the context. A retained suffix smaller than the
	 * checkpoint-rewrite threshold then still justifies the rewrite; the no-gain
	 * check discards one that would not reduce context.
	 */
	requireFit?: boolean;
	/** Carry this user message verbatim if removed; defaults to the latest operator turn for manual compaction. */
	preserveUserTurnId?: string;
	/** A new operator request is pending admission and is not yet in `entries`. */
	pendingOperatorTurn?: boolean;
	/** The turn this compaction's calls are journaled under and charged to; unset leaves the ledger order to decide. */
	chargeTurnId?: string;
	/**
	 * Output the summarizer has streamed so far, estimated from the characters
	 * received, beside the request's output cap when it sends one. Called as
	 * text or reasoning arrives; the test seam `summarize` never calls it.
	 */
	onSummaryOutput?: (written: { tokens: number; limit?: number }) => void;
	/** Accounting observer; called once per invoked stream, including failures. */
	onCall?: (call: CompactionCallObservation) => void;
	/**
	 * The continuity note replay projects, from `continuityProjectionTokens` and
	 * the projection's `noteAnchorTurnId`. The note survives the reduction, so it
	 * is on both sides of the before/after comparison; counting it needs the
	 * session and fork facts the caller has and this module does not, and the
	 * anchor id is what keeps it from being counted twice once a provider usage
	 * anchor already includes it.
	 */
	continuityNote?: ContinuityNoteCost;
	/**
	 * `summaryDigest` of the last automatic attempt whose checkpoint would not
	 * reduce context. A request that hashes to it again is not sent: the same
	 * input cannot produce a different verdict, and each repeat is paid (#422).
	 */
	skipSummaryDigest?: string;
	/**
	 * An automatic threshold pass, neither `/compact` nor overflow recovery. It makes no summary call when the span it
	 * would compress, outside the kept suffix and the preserved user turn, prices below the summary room, since the
	 * summary may take as much as it replaces (bt-47 cf1j-d).
	 */
	automatic?: boolean;
}

/**
 * The live main-route request as a summarizer (T4): the next turn's prefix, still served by the provider cache, with
 * the compaction instruction appended as its one new message. Built by session-control from the engine's request.
 */
export interface LivePrefixSummary {
	/** The route the request goes to; a compaction resolved to any other model cannot use it. */
	model: { id: string; provider: string };
	/** The turn's effective thinking level, which this request keeps; a capped request is sized for it (CTX-3). Absent reads as off. */
	thinkingLevel?: ThinkingLevel;
	/** Base-input-equivalent tokens the request costs before output, with `tail` as the appended message. */
	inputCost(tail: string): number;
	/** Estimated input tokens of the whole request, for the window fit check. */
	inputTokens(tail: string): number;
	stream(
		tail: string,
		options: { maxTokens?: number; signal?: AbortSignal; fetch?: typeof globalThis.fetch },
	): ReturnType<typeof streamSimple>;
}

/** Why a pass returned without a summary and without calling the summarizer. */
export type CompactEmptyReason =
	| "protected-recent"
	| "protected-skill"
	| "repeat-no-gain"
	| "nothing-to-summarize"
	| "below-summary-room";

export interface CompactResult {
	/** Journal calls belonging to this checkpoint attempt, including retries (#434). */
	callIds?: string[];
	providerCheckpoint?: ProviderCheckpointHandle;
	/** Called synchronously by the session owner immediately before its durable ledger append (#423). */
	publishProviderCheckpoint?: () => void;
	providerFallbackReason?: string;
	checkpointParentTurnId?: string;
	/** Turn id of the checkpoint entry the flow confirmed in the ledger; publication keys on it. */
	checkpointId?: string;
	memoryReceipt?: MemoryConsumptionReceipt;
	/** The paid checkpoint was discarded because it would not reduce context. */
	noGain?: boolean;
	/** Digest of the summarizer request(s) this pass sent, or matched against `skipSummaryDigest`. */
	summaryDigest?: string;
	/** Set on an empty result that made no summarizer call. */
	emptyReason?: CompactEmptyReason;
	/** The output cap the summary request was sent with, when one was set. */
	summaryMaxTokens?: number;
	/** The checkpoint room the summary request stated, when it stated one. */
	summaryRoomTokens?: number;
	skillContext?: SkillContextCheckpoint;
	userContext?: PreservedUserContext;
	/** Generated summary text. Empty when there was nothing to summarize. */
	summary: string;
	/**
	 * Provider usage for the summarization call(s), summed. A compaction is a
	 * real model call and is billed like one; absent when the provider reported
	 * no usage at all, so a caller never records a fabricated zero-token call.
	 */
	usage?: CompactionUsage;
	/** Index into `entries` of the first entry that remains post-compaction. */
	firstKeptEntryIndex: number;
	/** Turn id of that first-kept entry, or null when entries is empty. */
	firstKeptTurnId: string | null;
	/** Estimated total context tokens before compaction. */
	tokensBefore: number;
	/** Number of newly compacted entries (excluding a carried-forward prior checkpoint and retained suffix). */
	messagesSummarized: number;
	/** The same span counted in provider messages, the unit a context snapshot's `messageRange` counts. */
	conversationMessagesSummarized: number;
	/** True when the cut split a turn (caller may want to show a banner). */
	isSplitTurn: boolean;
}

function buildUserMessage(text: string): {
	role: "user";
	content: Array<{ type: "text"; text: string }>;
	timestamp: number;
} {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

/**
 * Walk entries from newest to oldest and return the index of the most recent
 * `compactionSummary` entry, or -1 when none is present. Mirrors pi-coding-agent's
 * `prevCompactionIndex` discovery in compaction.ts:613-618 so iterative
 * compactions do not re-summarize content already captured in a prior summary.
 */
function findLatestCompactionIndex(entries: ReadonlyArray<SessionEntry>): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.kind === "compactionSummary") return i;
	}
	return -1;
}

/**
 * Whether a slice carries anything the summarizer would read. Custom records,
 * worker settlements, model changes and activation receipts serialize to an
 * empty or receipt-only conversation, and a paid call over them cannot reduce
 * context (#422).
 */
function hasConversation(slice: ReadonlyArray<SessionEntry>): boolean {
	return slice.some(
		(entry) =>
			(entry.kind === "message" && entry.role !== "checkpoint") ||
			(entry.kind === "bashExecution" && entry.excludeFromContext !== true) ||
			entry.kind === "branchSummary",
	);
}

/**
 * Provider messages a slice replays as, the unit a context snapshot's `messageRange` counts: a tool call rides in its
 * assistant message, and bookkeeping rows send nothing.
 */
function conversationMessages(slice: ReadonlyArray<SessionEntry>): number {
	return slice.filter(
		(entry) =>
			(entry.kind === "message" && entry.role !== "checkpoint" && entry.role !== "tool_call") ||
			(entry.kind === "bashExecution" && entry.excludeFromContext !== true) ||
			entry.kind === "branchSummary",
	).length;
}

/** Floor for the per-message cap applied when a span only fits with user and assistant text clipped. */
const MESSAGE_MIN_CHARS = 2000;
/** The least room a checkpoint is asked to fit, so a large kept suffix never squeezes the summary to nothing. */
const CHECKPOINT_ROOM_FLOOR = 1024;

const isUserMessage = (entry: SessionEntry | undefined): boolean => entry?.kind === "message" && entry.role === "user";

/**
 * A dispatch fold appends a worker's skill loads to this ledger tagged with
 * its run (`foldDispatchSkillActivations`). The worker read those instructions
 * in its own subprocess and nothing in this transcript carries them, yet
 * protecting the receipt's turn froze every later cut (#422). Skip a receipt
 * only when that is provable: it names no main user turn and no main call in
 * its turn loads the same skill. Anything ambiguous keeps protection.
 */
function isFoldedWorkerRunResult(entries: ReadonlyArray<SessionEntry>, index: number): boolean {
	const entry = entries[index];
	if (entry?.kind !== "skillActivation" || entry.activation.runId === undefined) return false;
	const { name, turnId } = entry.activation;
	if (turnId && entries.some((candidate) => candidate.turnId === turnId && isUserMessage(candidate))) return false;
	let start = index;
	while (start > 0 && !isUserMessage(entries[start])) start--;
	let end = index + 1;
	while (end < entries.length && !isUserMessage(entries[end])) end++;
	return !entries
		.slice(start, end)
		.some(
			(candidate) =>
				candidate.kind === "message" &&
				candidate.role === "tool_call" &&
				historicalSkillCall(payloadObject(candidate.payload), name) !== null,
		);
}

function findLatestSkillActivationProtectionStart(
	entries: ReadonlyArray<SessionEntry>,
	startIndex: number,
): number | null {
	for (let i = entries.length - 1; i >= startIndex; i--) {
		if (entries[i]?.kind !== "skillActivation" || isFoldedWorkerRunResult(entries, i)) continue;
		const turnStart = findTurnStartForProtection(entries, i, startIndex);
		return turnStart === -1 ? i : turnStart;
	}
	return null;
}

function findTurnStartForProtection(
	entries: ReadonlyArray<SessionEntry>,
	entryIndex: number,
	startIndex: number,
): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (!entry) continue;
		if (entry.kind === "branchSummary") return i;
		if (entry.kind === "bashExecution") return i;
		if (entry.kind === "message" && entry.role === "user") return i;
	}
	return -1;
}

/**
 * The ledger chains entries linearly, so a result's parent is its own call only
 * when that call was alone in its batch. In a parallel batch the parent chain
 * runs back through sibling calls, results and activation receipts. The load is
 * still verifiable when that chain reaches the call without crossing another
 * assistant or user message, which would make it a different exchange.
 */
function resultFollowsCallInBatch(
	turn: ReadonlyArray<SessionEntry>,
	resultEntry: SessionEntry,
	call: SessionEntry,
): boolean {
	let parent = resultEntry.parentTurnId;
	for (let hops = 0; hops < turn.length && parent; hops++) {
		if (parent === call.turnId) return true;
		const link = turn.find((candidate) => candidate.turnId === parent);
		if (!link) return false;
		if (link.kind === "message" && link.role !== "tool_call" && link.role !== "tool_result") return false;
		parent = link.parentTurnId;
	}
	return false;
}

/**
 * The same linear chaining parents a call on its assistant only when it is the
 * first call of its batch; a later call in a sequential batch is parented on
 * the previous sibling's result (#422). Walk back through sibling calls and
 * results to the issuing assistant. Any other entry on the way, or a chain
 * that leaves the turn, proves nothing.
 */
function batchAssistantForCall(turn: ReadonlyArray<SessionEntry>, call: SessionEntry): SessionEntry | undefined {
	let parent = call.parentTurnId;
	for (let hops = 0; hops < turn.length && parent; hops++) {
		const link = turn.find((candidate) => candidate.turnId === parent);
		if (link?.kind !== "message") return undefined;
		if (link.role === "assistant") return link;
		if (link.role !== "tool_call" && link.role !== "tool_result") return undefined;
		parent = link.parentTurnId;
	}
	return undefined;
}

interface HistoricalSkillCall {
	args: Record<string, unknown>;
	stepId?: string;
}

function historicalSkillCall(payload: Record<string, unknown> | null, name: string): HistoricalSkillCall | null {
	if (!payload || typeof payload.name !== "string") return null;
	const effective = effectiveToolCall(payload.name, payload.args);
	if (effective.toolName === "context" && effective.args?.scope === "skills" && effective.args.name === name)
		return { args: effective.args };
	const args = payloadObject(payload.args);
	if (payload.name !== "gateway" || args?.op !== "chain" || !Array.isArray(args.steps)) return null;
	const steps = args.steps
		.map(payloadObject)
		.filter(
			(step) =>
				step?.capability === "context" &&
				payloadObject(step.args)?.scope === "skills" &&
				payloadObject(step.args)?.name === name,
		);
	const step = steps[0];
	const stepArgs = payloadObject(step?.args);
	return steps.length === 1 && typeof step?.id === "string" && stepArgs ? { args: stepArgs, stepId: step.id } : null;
}

/**
 * Prove the child instructions were actually visible in the complete
 * aggregate: the step settled untruncated (`details.steps`), the child receipt
 * pairs with the call, and the aggregate text carries that receipt verbatim.
 */
function historicalSkillReceipt(
	call: HistoricalSkillCall,
	result: Record<string, unknown> | null,
	summary: Record<string, unknown> | null,
): { result: Record<string, unknown> | null; summary: Record<string, unknown> | null } | null {
	if (call.stepId === undefined) return { result, summary };
	const details = payloadObject(result?.details);
	if (
		details?.op !== "chain" ||
		details.capability !== "context" ||
		summary?.truncated !== false ||
		!Array.isArray(details.chainResults) ||
		!Array.isArray(details.steps) ||
		!Array.isArray(result?.content)
	)
		return null;
	const children = details.chainResults.map(payloadObject).filter((child) => child?.id === call.stepId);
	const child = children[0];
	const receipt = payloadObject(child?.result);
	if (
		children.length !== 1 ||
		child?.capability !== "context" ||
		child.isError !== false ||
		JSON.stringify(child.args) !== JSON.stringify(call.args) ||
		!Array.isArray(receipt?.content)
	)
		return null;
	const rows = details.steps.map(payloadObject).filter((row) => row?.id === call.stepId);
	const row = rows[0];
	if (rows.length !== 1 || row?.capability !== "context" || row.kind !== "ok" || row.truncated !== false) return null;
	const text = (content: unknown[]) => content.map((block) => payloadObject(block)?.text).join("\n");
	const aggregate = text(result.content);
	const body = text(receipt.content);
	// The model read the body only if it sits whole under its own step header
	// and runs to the next section or the end. The header spelling mirrors
	// `chainStepHeader` in src/tools/gateway/chain.ts; the chained-skill
	// contract in tests/contracts/chain-output-eviction.test.ts fails if they drift.
	const section = `### step ${call.stepId} (context): ok\n${body}`;
	const at = aggregate.indexOf(section);
	const end = at + section.length;
	if (
		at < 0 ||
		(at > 0 && !aggregate.startsWith("\n\n", at - 2)) ||
		(end !== aggregate.length && !aggregate.startsWith("\n\n", end))
	)
		return null;
	return { result: receipt, summary: { bytes: Buffer.byteLength(body, "utf8"), truncated: false } };
}

/** Recover only complete, uniquely paired historical main-agent loads. Never consult current disk. */
export function captureSkillContext(
	entries: ReadonlyArray<SessionEntry>,
	selection: SkillContextState | undefined,
): SkillContextCheckpoint | undefined {
	if (!selection || selection.unknown) return undefined;
	const newestSelected = Math.max(
		-1,
		...selection.activationRefs.map((ref) => entries.findIndex((entry) => entry.turnId === ref)),
	);
	if (
		selection.activationRefs.length > 0 &&
		entries
			.slice(newestSelected + 1)
			.some((entry) => entry.kind === "skillActivation" && entry.activation.runId === undefined)
	)
		return undefined;
	const skills: SkillContextCheckpoint["skills"] = [];
	for (const ref of selection.activationRefs) {
		const matches = entries.filter((entry) => entry.turnId === ref);
		const entry = matches[0];
		if (matches.length !== 1 || entry?.kind !== "skillActivation") return undefined;
		const activation = entry.activation;
		if (
			activation.runId !== undefined ||
			activation.triggeredBy !== "tool" ||
			!activation.turnId ||
			activation.drift === "mismatch"
		)
			return undefined;
		// A later load with the same name supersedes this receipt, even if the later evidence is incomplete.
		if (
			entries
				.slice(entries.indexOf(entry) + 1)
				.some(
					(later) =>
						later.kind === "skillActivation" &&
						later.activation.runId === undefined &&
						later.activation.name === activation.name,
				)
		)
			return undefined;
		const request = entries.find((candidate) => candidate.turnId === activation.turnId);
		if (request?.kind !== "message" || request.role !== "user") return undefined;
		const start = entries.indexOf(request);
		const next = entries.findIndex(
			(candidate, index) => index > start && candidate.kind === "message" && candidate.role === "user",
		);
		const turn = entries.slice(start, next < 0 ? undefined : next);
		if (!turn.includes(entry)) return undefined;
		const calls = turn.filter((candidate) => {
			if (candidate.kind !== "message" || candidate.role !== "tool_call") return false;
			const payload = payloadObject(candidate.payload);
			return historicalSkillCall(payload, activation.name) !== null;
		});
		if (calls.length !== 1) return undefined;
		const call = calls[0];
		if (call?.kind !== "message") return undefined;
		const selectedCall = historicalSkillCall(payloadObject(call.payload), activation.name);
		if (!selectedCall) return undefined;
		const callId = payloadObject(call.payload)?.toolCallId;
		if (typeof callId !== "string" || !callId) return undefined;
		const assistant = batchAssistantForCall(turn, call);
		if (
			assistant?.kind !== "message" ||
			assistant.role !== "assistant" ||
			!contentBlocks(assistant.payload).some(
				(block) =>
					block.type === "toolCall" &&
					block.id === callId &&
					block.name === payloadObject(call.payload)?.name &&
					JSON.stringify(block.arguments) === JSON.stringify(payloadObject(call.payload)?.args),
			)
		)
			return undefined;
		const results = entries.filter(
			(candidate) =>
				candidate.kind === "message" &&
				candidate.role === "tool_result" &&
				payloadObject(candidate.payload)?.toolCallId === callId,
		);
		const resultEntry = results[0];
		if (
			results.length !== 1 ||
			resultEntry?.kind !== "message" ||
			!turn.includes(resultEntry) ||
			!resultFollowsCallInBatch(turn, resultEntry, call) ||
			entry.parentTurnId !== request.turnId
		)
			return undefined;
		const payload = payloadObject(resultEntry.payload);
		const selectedReceipt = historicalSkillReceipt(
			selectedCall,
			payloadObject(payload?.result),
			payloadObject(payload?.resultSummary),
		);
		if (!selectedReceipt) return undefined;
		const result = selectedReceipt.result;
		const details = payloadObject(result?.details);
		const observation = payloadObject(details?.observation);
		const resultSummary = selectedReceipt.summary;
		const summaryObservation = payloadObject(resultSummary?.observation);
		const sourceInfo = payloadObject(details?.sourceInfo);
		if (
			payload === null ||
			payload.toolName !== payloadObject(call.payload)?.name ||
			payload.isError !== false ||
			payload.outcome !== "ok" ||
			details?.kind !== "ok" ||
			observation?.truncated !== false ||
			details.workingSet !== undefined ||
			details.contextCompaction !== undefined ||
			resultSummary?.truncated !== false ||
			summaryObservation?.truncated === true ||
			details.name !== activation.name ||
			details.path !== activation.filePath ||
			details.hash !== activation.hash ||
			details.source !== activation.source ||
			details.sourceOrigin !== activation.sourceOrigin ||
			sourceInfo?.path !== activation.filePath ||
			sourceInfo.scope !== details.scope ||
			sourceInfo.source !== activation.sourceOrigin ||
			(details.drift !== undefined && details.drift !== "match") ||
			details.drift !== activation.drift ||
			!Array.isArray(result?.content) ||
			!result.content.every((block: unknown) => {
				const obj = payloadObject(block);
				return obj?.type === "text" && typeof obj.text === "string";
			})
		)
			return undefined;
		const content = result.content as Array<{ type: "text"; text: string }>;
		const text = content.map((block) => block.text).join("\n");
		if (
			observation.shownBytes !== Buffer.byteLength(text, "utf8") ||
			observation.totalBytes !== observation.shownBytes ||
			resultSummary?.bytes !== observation.shownBytes
		)
			return undefined;
		const requestPayload = payloadObject(request.payload);
		const operatorText = requestPayload?.operatorText;
		const requestText =
			typeof operatorText === "string" && operatorText.trim().length > 0 ? operatorText : requestPayload?.text;
		if (typeof requestText !== "string") return undefined;
		skills.push({
			activationRef: ref,
			requestRef: request.turnId,
			callRef: call.turnId,
			resultRef: resultEntry.turnId,
			activation: structuredClone(activation),
			requestText,
			content: structuredClone(content),
			contentHash: skillContextContentHash(content),
		});
	}
	const checkpoint = { version: 1 as const, skills };
	return verifiedSkillContextCheckpoint(checkpoint) ? checkpoint : undefined;
}

/**
 * Recover the context that the latest compaction left live. A compaction
 * summary is appended after the retained suffix, so on the next pass that
 * suffix sits immediately before the summary entry and is otherwise outside
 * `boundaryStart`. Replay drops both the older summary and that suffix once a
 * newer summary is appended; feeding them to every applicable prompt branch
 * lets the model produce a genuinely cumulative replacement checkpoint.
 */
function priorCompactionContextEntries(entries: ReadonlyArray<SessionEntry>, compactionIndex: number): SessionEntry[] {
	const compaction = entries[compactionIndex];
	if (compaction?.kind !== "compactionSummary") return [];

	let firstKeptIndex = -1;
	if (compaction.firstKeptTurnId.length > 0) {
		for (let index = 0; index < compactionIndex; index++) {
			if (entries[index]?.turnId === compaction.firstKeptTurnId) {
				firstKeptIndex = index;
				break;
			}
		}
	}

	const retainedSuffix = firstKeptIndex >= 0 ? entries.slice(firstKeptIndex, compactionIndex) : [];
	// Put the summary first: semantically it precedes the retained suffix even
	// though append-only session order stores the summary after that suffix.
	return [compaction, ...retainedSuffix];
}

/**
 * Sentences where the operator asked Clio to remember something. A summarizing
 * model may drop such a value when the assistant declined to store it as
 * memory (p6/U1: `MARBLE-OTTER` survived live replay and not a resume), so
 * these sentences are carried verbatim next to the generated summary instead
 * of trusting it to keep them.
 */
const OPERATOR_NOTE_SENTENCE = /^(?:please\s+)?(?:remember|keep in mind|don'?t forget)\b/iu;
const OPERATOR_NOTE_MAX_CHARS = 400;
// The `/compact` instruction is the operator's own standing text: kept whole up to a hard bound.
const COMPACT_NOTE_PREFIX = "/compact: ";
const COMPACT_NOTE_MAX_CHARS = 8000;
const OPERATOR_NOTE_MAX_COUNT = 30;
const OPERATOR_NOTES_BLOCK = /<operator-notes\b([^>]*)>\s*\n([\s\S]*?)\n\s*<\/operator-notes\s*>/giu;

function escapeOperatorNote(note: string): string {
	// Newlines are encoded so a multi-line note stays one `- ` line in the block.
	return note
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/\r/gu, "&#13;")
		.replace(/\n/gu, "&#10;");
}

function unescapeOperatorNote(note: string): string {
	return note
		.replace(/&lt;/gu, "<")
		.replace(/&gt;/gu, ">")
		.replace(/&#13;/gu, "\r")
		.replace(/&#10;/gu, "\n")
		.replace(/&amp;/gu, "&");
}

function operatorMessageText(entry: SessionEntry): string | null {
	if (entry.kind !== "message" || entry.role !== "user") return null;
	const payload = payloadObject(entry.payload);
	if (payload === null || payload.synthetic === true) return null;
	if (typeof payload.operatorText === "string") return payload.operatorText;
	if (typeof payload.text === "string") return payload.text;
	const parts = contentBlocks(payload)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string);
	return parts.length > 0 ? parts.join("\n") : null;
}

function extractOperatorNotes(entries: ReadonlyArray<SessionEntry>, latest?: string): string[] {
	const notes = new Set<string>();
	const add = (note: string): void => {
		const trimmed = note.trim();
		if (trimmed.length === 0) return;
		const max = trimmed.startsWith(COMPACT_NOTE_PREFIX) ? COMPACT_NOTE_MAX_CHARS : OPERATOR_NOTE_MAX_CHARS;
		notes.add(trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed);
	};
	for (const entry of entries) {
		if (entry.kind === "compactionSummary") {
			for (const [, attributes, body] of entry.summary.matchAll(OPERATOR_NOTES_BLOCK)) {
				const escaped = /\bencoding=["']xml["']/iu.test(attributes ?? "");
				for (const line of (body ?? "").split("\n")) {
					const note = line.replace(/^- /u, "").trim();
					add(escaped ? unescapeOperatorNote(note) : note);
				}
			}
			continue;
		}
		const text = operatorMessageText(entry);
		if (text === null) continue;
		for (const sentence of text.split(/\n+|(?<=[.!?])\s+/u)) {
			const trimmed = sentence.trim();
			if (!OPERATOR_NOTE_SENTENCE.test(trimmed)) continue;
			add(trimmed);
		}
	}
	if (latest !== undefined) add(latest);
	return [...notes].slice(-OPERATOR_NOTE_MAX_COUNT);
}

function formatOperatorNotes(notes: ReadonlyArray<string>): string {
	if (notes.length === 0) return "";
	// Encode delimiters before promoting operator text into checkpoint context (p6/U1).
	return `\n\n<operator-notes encoding="xml">\n${notes.map((note) => `- ${escapeOperatorNote(note)}`).join("\n")}\n</operator-notes>`;
}

function createFileOps(): FileOperations {
	return { read: new Set(), modified: new Set() };
}

function recordFileOperation(fileOps: FileOperations, operation: unknown, filePath: unknown): void {
	if (typeof filePath !== "string" || filePath.trim().length === 0) return;
	const normalized = filePath.trim();
	if (operation === "read") {
		fileOps.read.add(normalized);
		return;
	}
	if (operation === "write" || operation === "edit" || operation === "create" || operation === "delete") {
		fileOps.modified.add(normalized);
	}
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}

function contentBlocks(payload: unknown): ReadonlyArray<Record<string, unknown>> {
	const content = payloadObject(payload)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is Record<string, unknown> => !!block && typeof block === "object");
}

function extractPathArg(args: unknown): string | null {
	const obj = payloadObject(args);
	if (!obj) return null;
	const candidate = obj.path ?? obj.file_path ?? obj.filePath;
	return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

function extractFileOpsFromMessage(entry: SessionEntry, fileOps: FileOperations): void {
	if (entry.kind !== "message") return;
	if (entry.role === "tool_call") {
		const obj = payloadObject(entry.payload);
		if (!obj) return;
		const name = typeof obj.name === "string" ? obj.name : typeof obj.toolName === "string" ? obj.toolName : "";
		recordFileOperation(fileOps, name, extractPathArg(obj.args ?? obj.arguments ?? obj.input));
		return;
	}
	if (entry.role !== "assistant") return;
	for (const block of contentBlocks(entry.payload)) {
		if (block.type !== "toolCall") continue;
		const name = typeof block.name === "string" ? block.name : "";
		recordFileOperation(fileOps, name, extractPathArg(block.arguments ?? block.args ?? block.input));
	}
}

function extractFileOps(entries: ReadonlyArray<SessionEntry>): FileOperations {
	const fileOps = createFileOps();
	// Chained read, write and edit steps touch files the summary must name.
	for (const entry of expandChainMessages(entries)) {
		if (entry.kind === "fileEntry") {
			recordFileOperation(fileOps, entry.operation, entry.path);
			continue;
		}
		if (entry.kind === "compactionSummary") {
			recordPriorFileOperations(entry.summary, (operation, filePath) => recordFileOperation(fileOps, operation, filePath));
			continue;
		}
		extractFileOpsFromMessage(entry, fileOps);
	}
	return fileOps;
}

/**
 * The skill context a checkpoint written now carries, held to the one the
 * latest checkpoint in `entries` already carries, and the index the cut must
 * not pass to keep a skill load it cannot carry (null when nothing needs
 * keeping). `entries` is the working-set projection of `rawEntries`, which
 * holds the load receipts. Throws when a carried skill no longer verifies, so
 * a destructive pass never drops one.
 */
export function checkpointSkillContext(
	entries: ReadonlyArray<SessionEntry>,
	rawEntries: ReadonlyArray<SessionEntry>,
	state: SkillContextState | null | undefined,
): { skillContext: SkillContextCheckpoint | undefined; protectedStart: number | null } {
	const prevCompactionIndex = findLatestCompactionIndex(entries);
	const boundaryStart = prevCompactionIndex + 1;
	const selection = state === null ? undefined : (state ?? latestSkillContextState(rawEntries));
	let skillContext = captureSkillContext(rawEntries, selection);
	const priorCheckpoint = entries[prevCompactionIndex];
	// An explicit-off checkpoint carries an empty skill list: nothing was
	// retained, so nothing needs re-verification and later unknown state must
	// not block compaction forever.
	const priorSkillContext =
		priorCheckpoint?.kind === "compactionSummary" &&
		priorCheckpoint.skillContext !== undefined &&
		priorCheckpoint.skillContext.skills.length > 0
			? priorCheckpoint.skillContext
			: undefined;
	// A typed checkpoint is not regenerated from summary prose. Failure to verify
	// its original receipts prevents another destructive pass.
	if (priorSkillContext !== undefined && !skillContext) {
		throw new Error("cannot verify preserved skill context; retaining the existing checkpoint");
	}
	if (priorSkillContext !== undefined) {
		if (!verifiedSkillContextCheckpoint(priorSkillContext)) throw new Error("invalid preserved skill checkpoint");
		for (const previous of priorSkillContext.skills) {
			const current = skillContext?.skills.find((skill) => skill.activationRef === previous.activationRef);
			if (current && JSON.stringify(current) !== JSON.stringify(previous)) {
				throw new Error("preserved skill context no longer matches its captured receipt");
			}
		}
	}
	if (skillContext && priorSkillContext !== undefined) {
		skillContext = {
			version: 1,
			skills: skillContext.skills.map((skill) =>
				structuredClone(
					priorSkillContext.skills.find((previous) => previous.activationRef === skill.activationRef) ?? skill,
				),
			),
		};
	}
	// A legacy checkpoint (no typed field) never adjudicated older activations,
	// so the fallback clamp stays fail-closed across its boundary. A typed
	// checkpoint already retained or explicitly dropped everything before it.
	const legacyPriorCheckpoint =
		priorCheckpoint?.kind === "compactionSummary" && priorCheckpoint.skillContext === undefined;
	const protectedStart = skillContext
		? null
		: findLatestSkillActivationProtectionStart(entries, legacyPriorCheckpoint ? 0 : boundaryStart);
	return { skillContext, protectedStart };
}

/**
 * The continuity payload a checkpoint written now carries: the latest validated
 * fold over the full active path before the cut. A suppressed projection carries
 * nothing, and `continuityPayloadFromFold` refuses an unvalidated fold. The
 * summary flow and the step checkpoint both carry this.
 */
export function checkpointContinuityCarry(input: ContinuityProjectionInput): ContinuityCheckpointPayload | null {
	const fold = resolveContinuityProjection(input).current;
	return fold === null ? null : continuityPayloadFromFold(fold);
}

/**
 * The prior checkpoint's preserved request, carried while it is still the
 * latest operator turn in `entries`. A summary and a step checkpoint carry it by
 * this one rule; a summary may then replace it with the active request its cut
 * removes.
 */
function carriedUserContext(
	entries: ReadonlyArray<SessionEntry>,
	prior: SessionEntry | undefined,
): PreservedUserContext | undefined {
	if (prior?.kind !== "compactionSummary" || !prior.userContext) return undefined;
	const latestOperator = findLastEntry(
		entries,
		(entry) =>
			entry.kind === "message" &&
			entry.role === "user" &&
			(entry.payload as { synthetic?: unknown } | null)?.synthetic !== true,
	);
	return !latestOperator || latestOperator.turnId === prior.userContext.turnId ? prior.userContext : undefined;
}

/** Blocks a host checkpoint rebuilds from the entries, including the path lists exact-facts replaced. */
const CHECKPOINT_BUILT_BLOCK = /\n*<(operator-notes|read-files|modified-files)\b[^>]*>[\s\S]*?<\/\1\s*>\n*/giu;

/**
 * A checkpoint the host writes without a model call. Its summary is the
 * latest summarized checkpoint's body (its goal and decisions, without the
 * blocks this one rebuilds, held to the summary's token room by dropping its
 * start), then `lead`, then the
 * operator notes and file facts with recall refs the entries
 * carry, exactly as a native checkpoint appends them, so a later summary and
 * `context(scope="recall")` still reach what the cut removed from replay. An
 * earlier step checkpoint is not carried: its body is that same summarized
 * checkpoint plus a lead the next lead supersedes, so a step chain holds one
 * body and one lead (x2-1). The previous checkpoint's preserved request
 * carries while it is still the latest operator turn, as in native compaction.
 */
export function hostCheckpoint(
	entries: ReadonlyArray<SessionEntry>,
	lead: string,
	cwd?: string,
): { summary: string; userContext?: PreservedUserContext } {
	const prior = entries[findLatestCompactionIndex(entries)];
	let carried = "";
	let userContext: PreservedUserContext | undefined;
	if (prior?.kind === "compactionSummary") {
		const summarized = findLastEntry(entries, (entry) => entry.kind === "compactionSummary" && entry.trigger !== "step");
		if (summarized?.kind === "compactionSummary")
			carried = stripEchoedExactFacts(summarized.summary.replace(CHECKPOINT_BUILT_BLOCK, "\n\n")).trim();
		const maxChars = summaryRoomTokens() * 4;
		if (carried.length > maxChars) {
			const marker = (dropped: number) => `[earlier checkpoint start truncated: ${dropped} characters dropped]\n`;
			const kept = maxChars - marker(carried.length).length;
			carried = `${marker(carried.length - kept)}${carried.slice(-kept)}`;
		}
		userContext = carriedUserContext(entries, prior);
	}
	const summary = `${carried.length > 0 ? `${carried}\n\n---\n\n` : ""}${lead}${formatOperatorNotes(extractOperatorNotes(entries))}${formatExactFacts(extractFileOps(entries), entries, cwd, recallableRefs(entries, foldWorkingSet(entries), { keptFrom: entries.length }))}`;
	return { summary, ...(userContext !== undefined ? { userContext } : {}) };
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Fold one summarization call's provider report into the checkpoint's raw report. A split turn runs two calls; both
 * are reported. The calls' journal facts are the accounting (#434).
 */
function addCompactionUsage(total: CompactionUsage | undefined, raw: unknown): CompactionUsage {
	const usage = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<Usage> & {
		reasoning?: number;
	};
	const { input, output, cacheRead, cacheWrite, reasoning, totalTokens } = normalizeTokenUsage(
		usage as Record<string, unknown>,
	);
	const base = total ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: { total: 0 },
		apiCalls: 0,
	};
	return {
		input: base.input + input,
		output: base.output + output,
		cacheRead: base.cacheRead + cacheRead,
		cacheWrite: base.cacheWrite + cacheWrite,
		...(base.cacheWrite1h === undefined && usage.cacheWrite1h === undefined
			? {}
			: { cacheWrite1h: (base.cacheWrite1h ?? 0) + numberOrZero(usage.cacheWrite1h) }),
		reasoning: base.reasoning + reasoning,
		totalTokens: base.totalTokens + totalTokens,
		cost: { total: base.cost.total + numberOrZero(usage.cost?.total) },
		apiCalls: base.apiCalls + 1,
	};
}

/** Keep attributable partial facts if a failed terminal object resets missing fields to zero. */
function retainReportedUsage(previous: Record<string, unknown>, raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return previous;
	const usage = raw as Record<string, unknown>;
	const known = { ...previous };
	for (const field of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "totalTokens"]) {
		const value = numberOrZero(usage[field]);
		if (value > 0) known[field] = value;
	}
	const reasoning = extractReasoningTokens({ ...usage, reasoningTokens: undefined });
	if (reasoning !== null && reasoning > 0) known.reasoning = reasoning;
	if (usage.cost && typeof usage.cost === "object" && "total" in usage.cost) {
		const cost = numberOrZero(usage.cost.total);
		if (cost > 0) known.cost = { total: cost };
	}
	return known;
}

/**
 * The silence a summary stream may keep, by the main turn's `chat.retry` rule for the compaction route (CLI-P9):
 * `streamMs` once output has started, `firstTokenMs` before it (null: no limit before the first token). A `streamMs`
 * of 0 never stops a stream.
 */
export interface SummaryStallWindow {
	streamMs: number;
	firstTokenMs: number | null;
}

/** The watchdog stopped a silent summary stream; the call journals it as a harness stall, the compaction as `provider`. */
class SummaryStallError extends Error {
	constructor(
		readonly awaitingFirstToken: boolean,
		idleMs: number,
	) {
		super(
			`compaction summary stream stalled: no ${awaitingFirstToken ? "first token" : "output"} for ${Math.round(idleMs / 1000)}s, aborting (stream timeout); incomplete checkpoint was not saved`,
		);
	}
}

/**
 * Yield `events` until they go silent past the stall window, then stop the request through `bound` and throw a
 * `provider` failure, which the checkpoint retry never repeats (CLI-P9). Every event is progress; the first generated
 * delta ends the first-token window, as on the main turn. The caller's own stop is left to its signal, so it still
 * reads as aborted. `next()` is raced, so a transport that ignores the abort cannot hold the summary open.
 */
async function* stallWatched<T>(
	events: AsyncIterable<T>,
	window: SummaryStallWindow | undefined,
	bound: AbortController,
	callerSignal: AbortSignal | undefined,
): AsyncGenerator<T> {
	if (window === undefined || window.streamMs <= 0) {
		yield* events;
		return;
	}
	const iterator = events[Symbol.asyncIterator]();
	let lastActivityAt = performance.now();
	let started = false;
	let stall: SummaryStallError | undefined;
	let onStall: ((error: SummaryStallError) => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = (delayMs: number): void => {
		timer = setTimeout(
			() => {
				timer = undefined;
				if (callerSignal?.aborted) return;
				const limitMs = started ? window.streamMs : window.firstTokenMs;
				if (limitMs === null) return arm(window.streamMs);
				const idleMs = performance.now() - lastActivityAt;
				if (idleMs < limitMs) return arm(limitMs - idleMs);
				stall = tagCompactionFailure(new SummaryStallError(!started, idleMs), "provider");
				bound.abort();
				onStall?.(stall);
			},
			Math.max(1, delayMs),
		);
	};
	arm(window.firstTokenMs ?? window.streamMs);
	let done = false;
	try {
		while (true) {
			if (stall) throw stall;
			const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
				onStall = reject;
				iterator.next().then(resolve, reject);
			});
			onStall = undefined;
			if (next.done) {
				done = true;
				return;
			}
			lastActivityAt = performance.now();
			if (hasAssistantGenerationDelta(next.value)) started = true;
			yield next.value;
		}
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		// A stalled transport may never answer `return()`; `bound` already ended its request.
		if (!done && stall === undefined) await iterator.return?.();
	}
}

async function runSummaryStream(
	input: CompactInput,
	purpose: Extract<SurfaceId, `compaction.${string}`>,
	userText: string,
	systemPrompt: string,
	maxTokens: number | undefined,
	prefix?: LivePrefixSummary,
): Promise<{ text: string; usage: unknown }> {
	const scope = await openCallScope(input.telemetry && { ...input.telemetry, purpose }, input.model);
	try {
		return await withOAuthRefresh(input, (auth) =>
			runSummaryAttempt({ ...input, ...auth }, userText, systemPrompt, maxTokens, scope, prefix),
		);
	} finally {
		await scope.close();
	}
}

async function runSummaryAttempt(
	input: CompactInput,
	userText: string,
	systemPrompt: string,
	maxTokens: number | undefined,
	scope: CallScope,
	prefix?: LivePrefixSummary,
): Promise<{ text: string; usage: unknown }> {
	// The live prefix keeps the turn's tool declarations and auto choice; the portable request sends no tools.
	scope.startAttempt(prefix ? { roundKind: "normal", toolChoice: "auto" } : undefined);
	try {
		return await scope.withContext(() => runSummaryRequest(input, userText, systemPrompt, maxTokens, scope, prefix));
	} catch (error) {
		// The request settles its own transport failures; this covers admission and fit checks (#434).
		scope.settle({ stopReason: input.signal?.aborted ? "aborted" : "error", callInvoked: false });
		throw error;
	}
}

async function runSummaryRequest(
	input: CompactInput,
	userText: string,
	systemPrompt: string,
	maxTokens: number | undefined,
	scope: CallScope,
	prefix?: LivePrefixSummary,
): Promise<{ text: string; usage: unknown }> {
	const options: Record<string, unknown> = {};
	if (input.apiKey !== undefined) options.apiKey = input.apiKey;
	if (input.headers !== undefined) options.headers = input.headers;
	if (input.signal !== undefined) options.signal = input.signal;
	// A portable summary request is never repeated, so a cache write on it is paid for and never read (T4).
	options.cacheRetention = "none";

	const context = {
		systemPrompt,
		messages: [buildUserMessage(userText)],
	};
	// Price the complete serialized request, including templates, previous
	// context, custom instructions and message overhead. This is the shared
	// estimate, not provider-exact tokenization; never truncate constraints to
	// make an oversized projected conversation fit.
	const estimatedInput = prefix ? prefix.inputTokens(userText) : estimateAgentContextTokens(context);
	const contextWindow = input.model.contextWindow;
	if (!Number.isFinite(contextWindow) || contextWindow < 0) {
		throw new Error("compaction requires a non-negative finite model context window");
	}
	// An unreported serving window is 0, not a zero-token window. The reactive
	// overflow retry compacts on exactly such routes, so the server judges the
	// summary request and the fit check applies only to a known window.
	if (contextWindow > 0) {
		// The output budget is a ceiling. A small window keeps whatever the request
		// leaves it, down to the 1024-token floor compact() sets; a summary that
		// needs more stops at the length check below and is never saved.
		const minOutput = Math.min(maxTokens ?? 1024, 1024);
		if (estimatedInput + minOutput > contextWindow) {
			throw tagCompactionFailure(
				new Error(
					`compaction estimated input ${estimatedInput} tokens plus output ${minOutput} tokens exceeds model context window ${contextWindow}; use a larger compaction model or reduce the working set`,
				),
				"window",
			);
		}
		if (maxTokens !== undefined) maxTokens = Math.min(maxTokens, contextWindow - estimatedInput);
	}
	// An unknown output limit sends no explicit cap; the server decides.
	if (maxTokens !== undefined) options.maxTokens = maxTokens;

	input.signal?.throwIfAborted();
	// The call's own signal, so a split fold's sibling failure wakes a call parked in admission (MD10).
	await scope.admit((hold) => input.beforeSummaryCall?.(hold, input.signal));
	const timestamp = new Date().toISOString();
	if (observationTracing())
		traceObservation("compaction-input", {
			mode: prefix ? "live-prefix" : "portable",
			systemPrompt: prefix ? null : systemPrompt,
			userText,
			maxTokens: maxTokens ?? null,
			estimatedInput,
			contextWindow,
		});
	let usage: unknown;
	let reported: Record<string, unknown> = {};
	let outcome: CompactionCallObservation["outcome"] = "error";
	let failure: CallFailureRecord | undefined;
	const tracking = trackCallFetch();
	options.fetch = tracking.fetch;
	try {
		input.signal?.throwIfAborted();
		tracking.start(input.summarize ? undefined : input.model.api);
		if (input.summarize) {
			const response = await input.summarize({
				systemPrompt,
				userText,
				...(maxTokens !== undefined ? { maxTokens } : {}),
			});
			usage = response.usage;
			scope.settle({ stopReason: "stop", usage });
			reported = retainReportedUsage(reported, usage);
			input.signal?.throwIfAborted();
			outcome = "success";
			return { text: response.text.trim(), usage };
		}
		// The stream is bounded by its summary budget: a route that ignores the output cap, or reasons without end, is
		// stopped at twice what the summary may write instead of streaming unbounded. A summary under it is untouched.
		const outputBound = 2 * (maxTokens ?? input.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
		const bound = new AbortController();
		const streamSignal = input.signal ? AbortSignal.any([input.signal, bound.signal]) : bound.signal;
		options.signal = streamSignal;
		// Summarization requests thinking off, as its resolver does. Bare stream
		// infers an active level from model.reasoning and would undo that choice.
		// The live prefix instead keeps the turn's own thinking: a change there
		// drops Anthropic's cached messages.
		const events = prefix
			? prefix.stream(userText, {
					...(maxTokens !== undefined ? { maxTokens } : {}),
					signal: streamSignal,
					fetch: tracking.fetch,
				})
			: streamSimple(
					input.model,
					context as unknown as Parameters<typeof streamSimple>[1],
					options as unknown as Parameters<typeof streamSimple>[2],
				);
		let writtenChars = 0;
		for await (const event of stallWatched(events, input.summaryStall, bound, input.signal)) {
			if (event.type === "text_delta" || event.type === "thinking_delta") {
				writtenChars += event.delta.length;
				input.onSummaryOutput?.({
					tokens: ceilChars(writtenChars),
					...(maxTokens !== undefined ? { limit: maxTokens } : {}),
				});
				if (ceilChars(writtenChars) > outputBound) {
					bound.abort();
					throw tagCompactionFailure(
						new Error(
							`compaction summary passed its output bound of ${outputBound} tokens; incomplete checkpoint was not saved`,
						),
						"output_cap",
					);
				}
			}
			// Some transports throw after yielding a partial response. Retain the
			// last reported usage even without a terminal error message.
			if ("partial" in event) {
				usage = event.partial.usage ?? usage;
				reported = retainReportedUsage(reported, usage);
			}
			if (event.type === "done") {
				scope.settle(event.message);
				usage = event.message.usage ?? usage;
				reported = retainReportedUsage(reported, usage);
				input.signal?.throwIfAborted();
				if (event.reason === "length" || event.message.stopReason === "length") {
					throw tagCompactionFailure(
						new Error("compaction summary reached the model output limit; incomplete checkpoint was not saved"),
						"output_cap",
					);
				}
				// The live prefix keeps the turn's tools declared; a model that calls one wrote no checkpoint.
				if (prefix && event.message.content.some((block) => block.type === "toolCall")) {
					throw tagCompactionFailure(
						new Error("compaction summarizer called a tool instead of writing the checkpoint"),
						"checkpoint_format",
						"tool_call",
					);
				}
				outcome = "success";
				return { text: textFromAssistant(event.message).trim(), usage };
			}
			if (event.type === "error") {
				scope.settle({ ...event.error, failure: tracking.failure(event.error, event.error.stopReason === "aborted") });
				usage = event.error.usage ?? usage;
				reported = retainReportedUsage(reported, usage);
				outcome = event.error.stopReason === "aborted" ? "aborted" : "error";
				throw new Error(`compaction stream failed: ${event.error.errorMessage ?? "unknown error"}`);
			}
		}
		throw new Error("compaction stream ended without a terminal response");
	} catch (error) {
		// Whatever the request did not mark itself failed on the provider's side: the stream, its end, or the summarizer.
		tagCompactionFailure(error, "provider");
		failure = tracking.failure(error, input.signal?.aborted || outcome === "aborted", Object.keys(reported).length > 0);
		// The watchdog's stop is Clio's own, named by where the stream went silent (CLI-P9).
		if (error instanceof SummaryStallError)
			failure = {
				...failure,
				stage: "harness",
				errorClass: error.awaitingFirstToken ? "stall_first_token" : "stall_mid_stream",
			};
		scope.settle({ stopReason: input.signal?.aborted || outcome === "aborted" ? "aborted" : "error", failure });
		rememberOAuthCallFailure(error, failure);
		throw error;
	} finally {
		// A summary stopped at the cap reports the reasoning that filled it; the next cap learns from it.
		noteSummaryUsage(input.model, outcome === "success" ? usage : reported);
		input.onCall?.({
			...scope.identity(),
			...(failure === undefined ? {} : { failure }),
			outcome: outcome === "error" && input.signal?.aborted ? "aborted" : outcome,
			usage: outcome === "success" ? usage : reported,
			timestamp,
		});
	}
}

/**
 * Run the compaction pipeline: find the cut, serialize the history portion,
 * ask the model for a summary, and return the result. The caller decides
 * what to do with `summary` and `firstKeptTurnId`; typically they persist a
 * `compactionSummary` entry via `session.appendEntry` and swap the live
 * message list for `entries.slice(firstKeptEntryIndex)`.
 */
export async function compact(input: CompactInput): Promise<CompactResult> {
	if (!input.telemetry) return compactWithCalls(input);
	const callIds = new Set<string>();
	const telemetry = input.telemetry;
	const result = await compactWithCalls({
		...input,
		telemetry: {
			...telemetry,
			onSettled: (facts) => {
				callIds.add(facts.callId);
				telemetry.onSettled?.(facts);
			},
		},
	});
	return { ...result, callIds: [...callIds] };
}

async function compactWithCalls(input: CompactInput): Promise<CompactResult> {
	let nativeUsage: CompactionUsage | undefined;
	let fallbackReason = input.providerFallbackReason;
	const providerCompaction = input.providerCompaction;
	if (providerCompaction && input.providerCheckpointSource && input.entries.some((entry) => entry.kind === "message")) {
		input.signal?.throwIfAborted();
		const selection =
			input.skillContextState === null ? undefined : (input.skillContextState ?? latestSkillContextState(input.entries));
		const skillContext = captureSkillContext(input.entries, selection);
		const scope = await openCallScope(
			input.telemetry && { ...input.telemetry, purpose: "compaction.native" },
			input.model,
		);
		const observations: CompactionCallObservation[] = [];
		scope.startAttempt({ roundKind: "normal", toolChoice: "auto" });
		try {
			if (!skillContext && input.entries.some((entry) => entry.kind === "skillActivation" && !entry.activation.runId))
				throw new ProviderCompactionError("native-skills-unverified");
			await scope.admit((hold) => input.beforeSummaryCall?.(hold, input.signal));
			input.signal?.throwIfAborted();
			const native = await scope.withContext(() => providerCompaction((call) => observations.push(call), scope));
			scope.settle({ stopReason: "stop", usage: native.usage });
			nativeUsage = addCompactionUsage(undefined, native.usage);
			input.signal?.throwIfAborted();
			const cutCursor = [...input.entries].reverse().find((entry) => entry.kind === "message")?.turnId ?? "";
			const prepared = prepareProviderCheckpoint(
				{
					...native,
					...input.providerCheckpointSource,
					version: 1,
					createdAt: new Date().toISOString(),
					cutCursor,
					entryRefs: input.entries.map((entry) => entry.turnId),
					receiptRefs: input.entries
						.filter((entry) => entry.kind === "workerRun" || entry.kind === "skillActivation")
						.map((entry) => entry.turnId),
					recallRefs: input.entries
						.filter((entry) => entry.kind === "message" && entry.role === "tool_result")
						.map((entry) => entry.turnId),
					skillContext: skillContext ?? null,
				},
				input.signal,
			);
			const latestUser = [...input.entries]
				.reverse()
				.find(
					(entry) =>
						entry.kind === "message" &&
						entry.role === "user" &&
						(entry.payload as { synthetic?: unknown } | null)?.synthetic !== true,
				);
			const text = latestUser?.kind === "message" ? operatorMessageText(latestUser) : null;
			const userContext =
				!input.pendingOperatorTurn && latestUser && text ? { turnId: latestUser.turnId, text } : undefined;
			return {
				providerCheckpoint: prepared.handle,
				publishProviderCheckpoint: prepared.publish,
				checkpointParentTurnId: cutCursor,
				summary: `Native Codex checkpoint; original history is retained for recall.${formatOperatorNotes(extractOperatorNotes(input.entries, input.instructions))}${formatExactFacts(extractFileOps(input.entries), input.entries, input.cwd, recallableRefs(input.entries, foldWorkingSet(input.entries), { keptFrom: input.entries.length }))}`,
				firstKeptEntryIndex: input.entries.length,
				firstKeptTurnId: null,
				tokensBefore: calculateContextTokens(input.entries, getLastAssistantUsage(input.entries), input.continuityNote),
				messagesSummarized: input.entries.filter((entry) => entry.kind === "message").length,
				conversationMessagesSummarized: conversationMessages(input.entries),
				isSplitTurn: false,
				...(nativeUsage ? { usage: nativeUsage } : {}),
				...(skillContext ? { skillContext } : {}),
				...(userContext ? { userContext } : {}),
			};
		} catch (error) {
			scope.settle({ stopReason: input.signal?.aborted ? "aborted" : "error", callInvoked: false });
			input.signal?.throwIfAborted();
			if (!(error instanceof ProviderCompactionError)) throw error;
			fallbackReason = error.category;
		} finally {
			for (const call of observations) input.onCall?.({ ...call, ...scope.identity() });
			await scope.close();
		}
	}
	// Native checkpoints never replace evidence. A portable route summarizes the original ledger lazily (#423).
	const latestCompaction = [...input.entries].reverse().find((entry) => entry.kind === "compactionSummary");
	if (latestCompaction?.providerCheckpoint) {
		const { providerCompaction: _native, ...portable } = input;
		const original = input.entries.filter((entry) => entry.kind !== "compactionSummary" || !entry.providerCheckpoint);
		const result = await compact({ ...portable, entries: original });
		return {
			...result,
			providerFallbackReason: fallbackReason ?? "native-checkpoint-needs-portable-route",
			firstKeptEntryIndex:
				result.firstKeptTurnId === null
					? input.entries.length
					: input.entries.findIndex((entry) => entry.turnId === result.firstKeptTurnId),
			...(nativeUsage ? { usage: addCompactionUsage(result.usage, nativeUsage) } : {}),
		};
	}
	if (fallbackReason !== undefined) {
		const { providerCompaction: _native, providerFallbackReason: _reason, ...portable } = input;
		const result = await compact(portable);
		return {
			...result,
			providerFallbackReason: fallbackReason,
			...(nativeUsage ? { usage: addCompactionUsage(result.usage, nativeUsage) } : {}),
		};
	}
	const reserveTokens = input.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const keepRecentTokens = input.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
	// Apply the same ledger decisions as live replay before pricing or
	// serializing any slice, including the prior checkpoint's retained suffix.
	// Projection preserves positions and turn IDs; cuts still address the raw
	// input, which remains untouched and available for exact recall.
	const workingSet = foldWorkingSet(input.entries);
	const entries = projectWorkingSet(input.entries, workingSet);
	// Iterative compaction: when a prior `compactionSummary` exists, the
	// summary is canonical history. Restrict the cut search and the new-history
	// slice to entries strictly after that boundary; the canonical summary and
	// its retained suffix are recovered below and prepended explicitly rather
	// than rediscovering already-compacted raw history. Mirrors pi-coding-agent's
	// `boundaryStart = prevCompactionIndex + 1` and `usageStart = prevCompactionIndex`
	// in compaction.ts:619-628.
	const prevCompactionIndex = findLatestCompactionIndex(entries);
	const boundaryStart = prevCompactionIndex + 1;
	const priorCheckpoint = entries[prevCompactionIndex];
	const { skillContext, protectedStart } = checkpointSkillContext(entries, input.entries, input.skillContextState);
	const usageStart = prevCompactionIndex >= 0 ? prevCompactionIndex : 0;
	const usageEntries = entries.slice(usageStart);
	const lastUsage = getLastAssistantUsage(usageEntries);
	const tokensBefore = calculateContextTokens(usageEntries, lastUsage, input.continuityNote);
	const rawCut = findCutPoint(entries, keepRecentTokens, { startIndex: boundaryStart });
	const cut =
		protectedStart !== null && rawCut.firstKeptEntryIndex > protectedStart
			? { firstKeptEntryIndex: protectedStart, turnStartIndex: -1, isSplitTurn: false }
			: rawCut;
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const splitTurnStart = cut.isSplitTurn ? entries[cut.turnStartIndex] : undefined;
	const activeRequest = splitTurnStart === undefined ? undefined : (operatorMessageText(splitTurnStart) ?? undefined);
	const preRange = [boundaryStart, Math.max(boundaryStart, historyEnd)] as const;
	const prefixRange = [Math.max(boundaryStart, cut.turnStartIndex), cut.firstKeptEntryIndex] as const;
	// A slice of bookkeeping alone counts as empty, so no call is paid for it.
	const pre = hasConversation(entries.slice(...preRange)) ? entries.slice(...preRange) : [];
	const turnPrefix =
		cut.isSplitTurn && hasConversation(entries.slice(...prefixRange)) ? entries.slice(...prefixRange) : [];
	// The projection keeps every ledger position, so the same ranges over
	// `input.entries` are the raw slices memory prepared its observations from.
	const rawPre = pre.length > 0 ? input.entries.slice(...preRange) : [];
	const rawTurnPrefix = turnPrefix.length > 0 ? input.entries.slice(...prefixRange) : [];
	const previousContextEntries = priorCompactionContextEntries(entries, prevCompactionIndex);
	const rawPriorSuffix = priorCompactionContextEntries(input.entries, prevCompactionIndex).slice(1);
	const previousContextText = serializeConversation(previousContextEntries, seenBy(entries, previousContextEntries));
	const compactedEntries = [
		...priorCompactionContextEntries(input.entries, prevCompactionIndex),
		...input.entries.slice(boundaryStart, cut.firstKeptEntryIndex),
	];
	const fileOps = extractFileOps(compactedEntries);
	const firstKept = input.entries[cut.firstKeptEntryIndex] ?? null;
	// The newest complete exchange can begin immediately after the checkpoint.
	// Its earlier retained suffix is still live context, even though it sits
	// before boundaryStart in the append-only ledger. Summarize that suffix
	// with the canonical prior summary instead of declaring nothing to compact.
	// Never use this path to cross a protected cut or to re-summarize a bare
	// checkpoint with no retained work. An automatic pass rewrites only a suffix
	// at least twice the checkpoint, so one small exchange is not worth a paid
	// call; a pass the pending request needs to fit rewrites any retained work,
	// because the alternative is refusing that request.
	const priorSuffix = previousContextEntries.slice(1);
	const summarizePriorSuffix =
		pre.length === 0 &&
		turnPrefix.length === 0 &&
		firstKept !== null &&
		cut.firstKeptEntryIndex >= boundaryStart &&
		hasConversation(priorSuffix) &&
		(input.requireFit === true ||
			priorSuffix.reduce((tokens, entry) => tokens + estimateTokens(entry), 0) >=
				2 * (priorCheckpoint?.kind === "compactionSummary" ? estimateTokens(priorCheckpoint) : 0));

	const emptyResult = (emptyReason: CompactEmptyReason): CompactResult => ({
		summary: "",
		firstKeptEntryIndex: cut.firstKeptEntryIndex,
		firstKeptTurnId: firstKept?.turnId ?? null,
		tokensBefore,
		messagesSummarized: 0,
		conversationMessagesSummarized: 0,
		isSplitTurn: cut.isSplitTurn,
		emptyReason,
	});
	if (pre.length === 0 && turnPrefix.length === 0 && !summarizePriorSuffix) {
		return emptyResult(cut === rawCut ? "protected-recent" : "protected-skill");
	}
	if (input.automatic === true && input.requireFit !== true) {
		// The preserved turn rides verbatim whether or not it is cut, so it compresses nothing.
		const preservedTurnId = input.pendingOperatorTurn
			? undefined
			: (input.preserveUserTurnId ??
				[...entries]
					.reverse()
					.find(
						(entry) =>
							entry.kind === "message" &&
							entry.role === "user" &&
							(entry.payload as { synthetic?: unknown } | null)?.synthetic !== true,
					)?.turnId);
		const span = (summarizePriorSuffix ? priorSuffix : [...pre, ...turnPrefix]).filter(
			(entry) => entry.turnId !== preservedTurnId,
		);
		if (!hasConversation(span)) return emptyResult("nothing-to-summarize");
		// A capped summary on a small window keeps to the room its cap leaves, so a span above that still gains (bt-18).
		const room = summaryOutputBudget(
			input.model,
			reserveTokens,
			input.summaryOutputCap,
			input.summaryThinkingLevel,
		).summaryRoom;
		if (span.reduce((tokens, entry) => tokens + estimateTokens(entry), 0) < room)
			return { ...emptyResult("below-summary-room"), noGain: true };
	}

	// The instructions also ride verbatim as an operator note, so they survive
	// a summarizer that ignores them and carry into later checkpoints (DF-7).
	const compactInstructions = input.instructions?.trim();
	// Notes pinned with "remember ... for this session" stand for the whole session, wherever their entry sits;
	// one the operator undid or retracted leaves the block even when an earlier checkpoint carried it.
	const pinned = standingOperatorNotes(input.entries);
	const unpinned = new Set(
		input.entries.flatMap((entry) => {
			if (entry.kind !== "custom" || entry.customType !== OPERATOR_NOTE_ENTRY) return [];
			const data = entry.data as { id?: unknown; text?: unknown } | undefined;
			return typeof data?.text === "string" && !pinned.some((note) => note.id === data.id) ? [data.text.trim()] : [];
		}),
	);
	const operatorNotes = [
		...extractOperatorNotes(
			[
				...priorCompactionContextEntries(entries, prevCompactionIndex),
				...entries.slice(boundaryStart, cut.firstKeptEntryIndex),
			],
			compactInstructions ? `/compact: ${compactInstructions}` : undefined,
			// "Remember that X" is kept as typed, so an undone pin's text inside it drops the sentence too.
		).filter((note) => ![...unpinned].some((text) => note.includes(text))),
		...pinned.map((note) => note.text.trim()),
	]
		.filter((note, index, all) => all.indexOf(note) === index)
		.slice(-OPERATOR_NOTE_MAX_COUNT);
	// Clio's own blocks follow the model's text; they are built before the calls so the checkpoint's room counts them.
	const hidden = recallableRefs(input.entries, workingSet, { keptFrom: cut.firstKeptEntryIndex });
	const trailer = `${formatOperatorNotes(operatorNotes)}${formatExactFacts(fileOps, compactedEntries, input.cwd, hidden)}`;
	const systemPrompt = input.systemPrompt ?? COMPACTION_SYSTEM_PROMPT;
	if (!Number.isFinite(reserveTokens) || reserveTokens <= 0) {
		throw new Error("compaction requires a positive finite reserve token budget");
	}
	// A cumulative checkpoint told nothing of its room outgrew a small window's history space a little more each cycle,
	// while the retained suffix could shrink no further than the newest tool batch, so each cut landed closer to the
	// trigger (bt-18). The request names what the target leaves once the kept suffix and Clio's blocks are counted.
	// A capped summary on a small window always names its budget, the tighter of that and its own room (item 8).
	const capped = input.summaryOutputCap !== undefined;
	const retainedRoom = (() => {
		if (input.retainedTargetTokens === undefined) return undefined;
		const kept = entries.slice(cut.firstKeptEntryIndex).reduce((tokens, entry) => tokens + estimateTokens(entry), 0);
		return Math.max(
			CHECKPOINT_ROOM_FLOOR,
			Math.floor(input.retainedTargetTokens / 3),
			input.retainedTargetTokens - kept - ceilChars(trailer.length),
		);
	})();
	// A fixed cap let reasoning consume it and the summary was never saved (pi upstream #9512); summaryOutputBudget
	// sizes it per route. Under a cap each send is sized at the thinking level it runs at: a capped summary with
	// thinking off keeps no reasoning room, whatever the model could do (CTX-3). An uncapped one keys on the model.
	const sendBudget = (thinking: ThinkingLevel | undefined) => {
		const outputBudget = summaryOutputBudget(input.model, reserveTokens, input.summaryOutputCap, thinking);
		const { summaryRoom } = outputBudget;
		const checkpointRoom =
			retainedRoom !== undefined && retainedRoom < summaryRoom ? retainedRoom : capped ? summaryRoom : undefined;
		// The stated budget is the request's too: the output cap leaves it past the send's reasoning share.
		const maxTokens =
			capped && checkpointRoom !== undefined && outputBudget.maxTokens !== undefined
				? Math.min(outputBudget.maxTokens, summaryOutputForRoom(input.model, checkpointRoom, thinking))
				: outputBudget.maxTokens;
		return { summaryRoom, checkpointRoom, maxTokens };
	};
	const { summaryRoom, checkpointRoom, maxTokens } = sendBudget(input.summaryThinkingLevel);
	// A split turn's summary is the smaller part of the checkpoint, so it gets a third of the room.
	const historyRoom =
		checkpointRoom === undefined || turnPrefix.length === 0 ? checkpointRoom : Math.ceil((checkpointRoom * 2) / 3);
	const prefixRoom =
		checkpointRoom === undefined || (pre.length === 0 && !summarizePriorSuffix)
			? checkpointRoom
			: checkpointRoom - (historyRoom ?? 0);
	let memoryOffer: MemoryCompactionOffer | null = null;
	// Every offer memory issued for this fold, chosen or declined: a fold that fails tells each of them, so a decline
	// from a failed attempt never settles at a later commit.
	const issuedOffers: MemoryCompactionOffer[] = [];
	// The hook is memory's bookkeeping. A throw from it must never stop the raw fallback or replace the summary's own
	// error, so it is swallowed here and its result ignored.
	const tellOffer = (offer: MemoryCompactionOffer, outcome: MemoryOfferOutcome): void => {
		try {
			offer.onOutcome?.(outcome);
		} catch {
			// Ignored: see above.
		}
	};
	// Once per fold: both concurrent split summaries fail when one does.
	let offersSettledFailed = false;
	const offersFailed = (): void => {
		if (offersSettledFailed) return;
		offersSettledFailed = true;
		for (const offer of issuedOffers) tellOffer(offer, { kind: "failed" });
	};
	// Recorded only once a portable request carrying the offer is sent, so a
	// request skipped as a repeat or replaced by a cheaper live prefix leaves no
	// offer-used event behind.
	let commitMemoryOffer: (() => void) | undefined;
	let declineMemoryOffer: ((reason: string) => void) | undefined;
	// A summary request sees whole tool results when they fit the summarizer's
	// window beside its output room, else the largest per-result cap that fits,
	// never below TOOL_RESULT_MAX_CHARS. The fixed 2000-char cap kept only a long
	// read's opening even with the window nearly empty, so a checkpoint written
	// between two reads and the answer lost every value past it and the answer
	// filled the gap from the other file. The margin covers the chars/4 estimate
	// running under real tokenization of code.
	const summaryWindow = input.model.contextWindow;
	const summaryInputBudget =
		summaryWindow > 0
			? Math.floor((summaryWindow - Math.min(maxTokens ?? summaryRoom, Math.floor(summaryWindow / 2))) * 0.8)
			: 0;
	const serializeWithinBudget = (slice: readonly SessionEntry[], build: (text: string) => string): string => {
		const seen = seenBy(entries, slice);
		const capped = serializeConversation(slice, seen);
		if (summaryInputBudget <= 0) return capped;
		const price = (text: string) =>
			estimateAgentContextTokens({ systemPrompt, messages: [buildUserMessage(build(text))] });
		const whole = serializeConversation(slice, { ...seen, toolResultMaxChars: Number.POSITIVE_INFINITY });
		if (price(whole) <= summaryInputBudget) return whole;
		if (whole === capped || price(capped) >= summaryInputBudget) {
			// Smallest tool-result cap still does not fit: one oversized user or
			// assistant message would block every compaction, so clip message text
			// for the summarizer only, halving down to a floor.
			let messageMaxChars = capped.length;
			let clipped = capped;
			while (messageMaxChars > MESSAGE_MIN_CHARS) {
				messageMaxChars = Math.max(MESSAGE_MIN_CHARS, Math.floor(messageMaxChars / 2));
				clipped = serializeConversation(slice, { ...seen, messageMaxChars });
				if (price(clipped) <= summaryInputBudget) return clipped;
			}
			return clipped;
		}
		let fits = TOOL_RESULT_MAX_CHARS;
		let over = whole.length;
		while (over - fits > 1) {
			const cap = Math.floor((fits + over) / 2);
			if (price(serializeConversation(slice, { ...seen, toolResultMaxChars: cap })) <= summaryInputBudget) fits = cap;
			else over = cap;
		}
		return serializeConversation(slice, { ...seen, toolResultMaxChars: fits });
	};
	const represent = (
		slice: readonly SessionEntry[],
		rawSlice: readonly SessionEntry[],
		previous: string,
		split: boolean,
	): string => {
		const build = (text: string) =>
			split
				? buildTurnPrefixUserText(text, input.instructions, previous, prefixRoom)
				: buildUserText(text, input.instructions, previous, activeRequest, historyRoom);
		const ordinary = serializeWithinBudget(slice, build);
		const raw = build(ordinary);
		if (memoryOffer !== null || input.offerMemory === undefined) return raw;
		const offer = input.offerMemory(rawSlice, ordinary, slice);
		if (offer) issuedOffers.push(offer);
		const declined = (reason: string, facts: Record<string, unknown> = {}) => {
			if (offer) tellOffer(offer, { kind: "declined", reason });
			observationEvent("offer-declined", { reason, split, entries: slice.length, ...facts });
			if (observationTracing()) traceObservation("offer-declined", { reason, split, entries: slice.length, ...facts });
			return raw;
		};
		if (!offer) return declined("no-offer");
		if (!offer.isCurrent()) return declined("not-current");
		const proposed = build(offer.text);
		const price = (userText: string) =>
			estimateAgentContextTokens({ systemPrompt, messages: [buildUserMessage(userText)] });
		const fits =
			input.model.contextWindow > 0 && price(proposed) + (maxTokens ?? summaryRoom) + 64 <= input.model.contextWindow;
		if (!fits) return declined("no-fit", { proposed: price(proposed), window: input.model.contextWindow });
		const use = { originalInputTokens: price(raw), substitutedInputTokens: price(proposed) };
		if (use.substitutedInputTokens >= use.originalInputTokens)
			return declined("no-gain", { proposed: use.substitutedInputTokens, raw: use.originalInputTokens });
		memoryOffer = offer;
		declineMemoryOffer = (reason) => {
			declined(reason, { proposed: use.substitutedInputTokens, raw: use.originalInputTokens });
		};
		commitMemoryOffer = () => {
			offer.onUse?.(use);
			if (observationTracing())
				traceObservation("offer-used", {
					receipt: offer.receipt,
					...use,
					retainedBoundary: firstKept?.turnId ?? null,
				});
		};
		return proposed;
	};
	const historyText =
		pre.length > 0 || summarizePriorSuffix
			? represent(
					summarizePriorSuffix ? priorSuffix : pre,
					summarizePriorSuffix ? rawPriorSuffix : rawPre,
					summarizePriorSuffix ? serializeConversation(previousContextEntries.slice(0, 1)) : previousContextText,
					false,
				)
			: undefined;
	// The previous context rides only one request. When the history summary carries it, a split-turn summary that
	// carried it too wrote the prior checkpoint twice, so each checkpoint grew by a copy of the last (bt-18).
	const prefixText =
		turnPrefix.length > 0
			? represent(turnPrefix, rawTurnPrefix, historyText === undefined ? previousContextText : "", true)
			: undefined;
	// T4: the live request is chosen only when its cached price is below the portable requests' plain input, and it
	// fits the window with the whole transcript in it.
	const chooseLivePrefix = async (): Promise<
		{ port: LivePrefixSummary; tail: string; budget: ReturnType<typeof sendBudget> } | undefined
	> => {
		if (!input.livePrefix) return undefined;
		const port = await input.livePrefix(input.signal);
		input.signal?.throwIfAborted();
		if (!port || port.model.id !== input.model.id || port.model.provider !== input.model.provider) return undefined;
		// The live request keeps the turn's thinking, so its cap and stated room are sized at that level (CTX-3).
		const budget = sendBudget(port.thinkingLevel);
		const retainedFrom = retainedOpening(entries, cut.firstKeptEntryIndex);
		const tail = buildLivePrefixUserText({
			...(retainedFrom !== undefined ? { retainedFrom } : {}),
			...(activeRequest !== undefined ? { activeRequest } : {}),
			...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
			...(budget.checkpointRoom !== undefined ? { roomTokens: budget.checkpointRoom } : {}),
		});
		const portable = [historyText, prefixText].reduce(
			(tokens, text) =>
				text === undefined
					? tokens
					: tokens + estimateAgentContextTokens({ systemPrompt, messages: [buildUserMessage(text)] }),
			0,
		);
		const cost = port.inputCost(tail);
		const window = input.model.contextWindow;
		const fits = !(window > 0) || port.inputTokens(tail) + (budget.maxTokens ?? budget.summaryRoom) <= window;
		if (observationTracing())
			traceObservation("compaction-route", {
				portable,
				livePrefix: Math.round(cost),
				fits,
				chosen: fits && cost < portable,
			});
		return fits && cost < portable ? { port, tail, budget } : undefined;
	};
	// The exact requests about to be sent, on the route that would serve them.
	// Credentials and headers stay out; they do not change what is summarized.
	const summaryDigest = createHash("sha256")
		.update(
			JSON.stringify({
				route: {
					provider: input.model.provider,
					api: input.model.api,
					id: input.model.id,
					baseUrl: input.model.baseUrl,
					contextWindow: input.model.contextWindow,
					maxTokens: input.model.maxTokens,
				},
				systemPrompt,
				maxTokens: maxTokens ?? null,
				historyText: historyText ?? null,
				prefixText: prefixText ?? null,
			}),
		)
		.digest("hex");
	if (input.skipSummaryDigest === summaryDigest) {
		// No checkpoint comes of this fold, so its offers settle nothing.
		offersFailed();
		return { ...emptyResult("repeat-no-gain"), summaryDigest };
	}
	const summaryParts: string[] = [];
	let usage: CompactionUsage | undefined;
	// T4: on the live main route the summary can be asked inside the cached request prefix, as one call that also
	// covers a split turn. It is priced against the portable texts with memory's substitute already in them.
	const live = await chooseLivePrefix().catch((error: unknown) => {
		offersFailed();
		throw error;
	});
	let liveCovered = false;
	if (live) {
		try {
			const liveSummary = await runSummaryStream(
				input,
				"compaction.live",
				live.tail,
				systemPrompt,
				live.budget.maxTokens,
				live.port,
			);
			usage = addCompactionUsage(usage, liveSummary.usage);
			if (liveSummary.text.length === 0)
				throw tagCompactionFailure(new Error("compaction returned an empty history summary"), "checkpoint_format", "empty");
			summaryParts.push(checkedHistorySummary(liveSummary.text));
			liveCovered = true;
		} catch (error) {
			if (input.signal?.aborted) offersFailed();
			input.signal?.throwIfAborted();
			// A stalled live call means the route is wedged: the portable request goes to the same route and would only
			// spend a second stall window before failing the same way (f-r-summary-stall).
			if (error instanceof SummaryStallError) {
				offersFailed();
				throw error;
			}
			// The failed call reported its own usage; the portable requests below still produce the checkpoint.
			if (observationTracing())
				traceObservation("compaction-live-prefix-fallback", {
					error: error instanceof Error ? error.message : String(error),
				});
		}
	}
	if (liveCovered) {
		declineMemoryOffer?.("live-prefix-cheaper");
		memoryOffer = null;
	} else commitMemoryOffer?.();
	// A reply the checkpoint validator refuses is asked for once more with the refusal in the request, on every pass
	// (CLI-P5). The retry is an ordinary summary call; a failed call (provider, window, cap, stop) is never retried.
	const checkedSummary = async (
		userText: string,
		history: boolean,
		check: (text: string) => string,
		call: CompactInput = input,
	) => {
		let request = userText;
		for (let attempt = 0; ; attempt++) {
			const reply = await runSummaryStream(
				call,
				history ? "compaction.history" : "compaction.split",
				request,
				systemPrompt,
				maxTokens,
			).catch((error: unknown) => {
				offersFailed();
				throw error;
			});
			usage = addCompactionUsage(usage, reply.usage);
			try {
				return check(reply.text);
			} catch (error) {
				if (attempt > 0 || compactionFailureOf(error, false).cause !== "checkpoint_format") {
					offersFailed();
					throw error;
				}
				if (call.signal?.aborted) {
					// Stopped between a refused reply and its retry: the fold fails here, so its offers hear so (MD10).
					offersFailed();
					call.signal.throwIfAborted();
				}
				request = checkpointRetryText(userText, error, history);
			}
		}
	};
	const checkHistory = (text: string): string => {
		if (text.length === 0)
			throw tagCompactionFailure(new Error("compaction returned an empty history summary"), "checkpoint_format", "empty");
		return checkedHistorySummary(text);
	};
	const checkPrefix = (text: string): string => {
		if (text.length === 0)
			throw tagCompactionFailure(
				new Error("compaction returned an empty split-turn summary"),
				"checkpoint_format",
				"empty",
			);
		return `**Turn Context (split turn):**\n\n${text}`;
	};
	// MD10: with a second slot free, a split fold's two portable summaries run together. The requests are the serial
	// ones and the results install history first. A failure cancels the sibling and commits nothing; a sibling that
	// already completed reported its own call, so it is still charged.
	let releaseSecondSlot: (() => void) | null = null;
	if (!liveCovered && historyText !== undefined && prefixText !== undefined) {
		try {
			releaseSecondSlot = input.holdSecondSummarySlot?.() ?? null;
		} catch (error) {
			offersFailed();
			throw error;
		}
	}
	if (releaseSecondSlot !== null && historyText !== undefined && prefixText !== undefined) {
		const sibling = new AbortController();
		const signal = input.signal ? AbortSignal.any([input.signal, sibling.signal]) : sibling.signal;
		// Progress is the two streams' sum, so the operator sees one count rather than two alternating.
		const streamed: Array<{ tokens: number; limit?: number } | undefined> = [undefined, undefined];
		const call = (index: 0 | 1): CompactInput => ({
			...input,
			signal,
			...(input.onSummaryOutput
				? {
						onSummaryOutput: (written: { tokens: number; limit?: number }) => {
							streamed[index] = written;
							const limits = streamed.map((part) => part?.limit ?? maxTokens);
							input.onSummaryOutput?.({
								tokens: (streamed[0]?.tokens ?? 0) + (streamed[1]?.tokens ?? 0),
								...(limits[0] !== undefined && limits[1] !== undefined ? { limit: limits[0] + limits[1] } : {}),
							});
						},
					}
				: {}),
		});
		let firstFailure: { error: unknown } | undefined;
		const cancelSiblingOnFailure = (run: Promise<string>): Promise<string> =>
			run.catch((error: unknown) => {
				firstFailure ??= { error };
				sibling.abort();
				throw error;
			});
		try {
			// Both settle before the slot is released: a cancelled request may still hold the server until it stops.
			const parts = await Promise.allSettled([
				cancelSiblingOnFailure(checkedSummary(historyText, true, checkHistory, call(0))),
				cancelSiblingOnFailure(checkedSummary(prefixText, false, checkPrefix, call(1))),
			]);
			if (firstFailure !== undefined) throw firstFailure.error;
			for (const part of parts) if (part.status === "fulfilled") summaryParts.push(part.value);
		} finally {
			releaseSecondSlot();
		}
	} else {
		if (!liveCovered && historyText !== undefined)
			summaryParts.push(await checkedSummary(historyText, true, checkHistory));
		if (!liveCovered && prefixText !== undefined) summaryParts.push(await checkedSummary(prefixText, false, checkPrefix));
	}

	if (memoryOffer !== null && !(memoryOffer as MemoryCompactionOffer).isCurrent()) {
		offersFailed();
		throw new Error("memory offer became stale during compaction");
	}

	// A generated split summary is not a reliable copy of the active request.
	// Keep it in the canonical checkpoint so live replay and resume agree.
	// A checkpoint's verbatim request belongs to its original turn. Once a new
	// user turn exists, replay must not present the old request as still active.
	let userContext: PreservedUserContext | undefined = input.pendingOperatorTurn
		? undefined
		: carriedUserContext(entries, priorCheckpoint);
	// Manual compaction has no live active-turn hint after a turn settles.
	// Preserve the latest operator request if the split removes it as well.
	let activeUserIndex = -1;
	for (let index = entries.length - 1; !input.pendingOperatorTurn && index >= 0; index--) {
		const entry = entries[index];
		if (entry?.kind !== "message" || entry.role !== "user") continue;
		if ((entry.payload as { synthetic?: unknown } | null)?.synthetic === true) continue;
		if (input.preserveUserTurnId === undefined || entry.turnId === input.preserveUserTurnId) {
			activeUserIndex = index;
			break;
		}
	}
	const activeUser =
		activeUserIndex >= 0 && activeUserIndex < cut.firstKeptEntryIndex ? entries[activeUserIndex] : undefined;
	if (activeUser?.kind === "message" && activeUser.payload && typeof activeUser.payload === "object") {
		const payload = activeUser.payload;
		// Composed text can contain transient reminders. Reassert only the
		// operator's canonical words when present, without normalizing them.
		const operatorText = "operatorText" in payload ? payload.operatorText : undefined;
		const text =
			typeof operatorText === "string" && operatorText.trim().length > 0
				? operatorText
				: "text" in payload && typeof payload.text === "string"
					? payload.text
					: null;
		if (text !== null) userContext = { turnId: activeUser.turnId, text };
	}

	const summary = `${stripEchoedExactFacts(
		summaryParts
			.join("\n\n---\n\n")
			// The model sees the prior blocks inside <previous-context> and may echo them;
			// the harness-built copies below are the one authoritative copy.
			// Only a block is stripped: an opening tag alone on its own line, through
			// its closing tag or, if the echo was cut off, the end. An inline mention
			// of the tag stays as summary text.
			.replace(
				/\n*^[^\S\n]*<operator-notes\b[^>\n]*>[^\S\n]*(?:\n[\s\S]*?<\/operator-notes\s*>|(?:\n[\s\S]*)?(?![\s\S]))\n*/gimu,
				"\n\n",
			),
	).trim()}${trailer}`.trim();
	// The send that wrote the checkpoint names its own cap and room.
	const written = liveCovered && live ? live.budget : { maxTokens, checkpointRoom };

	return {
		summary,
		firstKeptEntryIndex: cut.firstKeptEntryIndex,
		firstKeptTurnId: firstKept?.turnId ?? null,
		tokensBefore,
		messagesSummarized: pre.length + turnPrefix.length + (summarizePriorSuffix ? priorSuffix.length : 0),
		conversationMessagesSummarized:
			conversationMessages(pre) +
			conversationMessages(turnPrefix) +
			(summarizePriorSuffix ? conversationMessages(priorSuffix) : 0),
		isSplitTurn: cut.isSplitTurn,
		summaryDigest,
		...(written.maxTokens !== undefined ? { summaryMaxTokens: written.maxTokens } : {}),
		...(written.checkpointRoom !== undefined ? { summaryRoomTokens: written.checkpointRoom } : {}),
		...(memoryOffer !== null ? { memoryReceipt: (memoryOffer as MemoryCompactionOffer).receipt } : {}),
		...(usage !== undefined ? { usage } : {}),
		...(skillContext !== undefined ? { skillContext } : {}),
		...(userContext !== undefined ? { userContext } : {}),
	};
}

/** A slice cut before the assistant message that followed it still holds results a model call read. */
function seenBy(
	entries: ReadonlyArray<SessionEntry>,
	slice: ReadonlyArray<SessionEntry>,
): { assistantFollows: boolean } {
	const last = slice.length > 0 ? entries.lastIndexOf(slice[slice.length - 1] as SessionEntry) : -1;
	return {
		assistantFollows: last >= 0 && entries.slice(last + 1).some((e) => e.kind === "message" && e.role === "assistant"),
	};
}

/** How the first retained message opens, as the live transcript shows it, so the summarizer can find the cut. */
function retainedOpening(entries: ReadonlyArray<SessionEntry>, firstKeptIndex: number): string | undefined {
	for (const entry of entries.slice(firstKeptIndex)) {
		const opening = serializeConversation([entry])
			.split(/\n(?=\[[A-Z][A-Za-z ]*\]: )/u)
			.find((part) => !part.startsWith("[Assistant thinking]: "))
			?.replace(/\s+/gu, " ")
			.trim();
		if (opening) return opening.length > 240 ? `${opening.slice(0, 240)}…` : opening;
	}
	return undefined;
}

interface TextBlock {
	type: "text";
	text: string;
}

function textFromAssistant(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is TextBlock =>
				!!c &&
				typeof c === "object" &&
				(c as { type?: unknown }).type === "text" &&
				typeof (c as { text?: unknown }).text === "string",
		)
		.map((c) => c.text)
		.join("\n");
}
