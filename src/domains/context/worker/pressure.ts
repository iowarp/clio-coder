import type { ContextFoldPayload } from "../../../core/telemetry/live-events.js";
import type { AgentMessage } from "../../../engine/types.js";
import { effectiveToolCall } from "../../../tools/surface.js";
import { estimateAgentContextBreakdown, estimateAgentMessageTokens } from "../../session/context-accounting.js";
import type { EvictedItem } from "../../session/entries.js";
import type { FoldCheckpoint, FoldRouteFacts } from "../fold/contract.js";
import { supersededStageApplies } from "../fold/contract.js";
import { withinRearmBand } from "../working-set/checkpoint.js";
import { DEFAULT_WORKING_SET_SETTINGS } from "../working-set/defaults.js";
import type { MarkerReason } from "../working-set/marker.js";
import { renderMarker } from "../working-set/marker.js";
import { contextHash, messageToolCalls } from "./snapshot.js";

export interface WorkerPressureInput {
	messages: ReadonlyArray<AgentMessage>;
	systemPrompt: string;
	tools: ReadonlyArray<unknown>;
	contextWindow: number;
	/**
	 * Output tokens the request must leave room for at a given input size, the
	 * same reserve the main loop admits a turn against (D1-5).
	 */
	outputReserve: (inputTokens: number) => number;
	/**
	 * Tokens the request carries at send time beyond these messages, such as the
	 * result-contract reminders. They ride fixed positions, so projection never
	 * changes them, but the fit check must price the request that is sent.
	 */
	overheadTokens?: number;
	/** The economic trigger as a share of the window. */
	threshold?: number;
	/** `context.workingSet.target`: where a batch over the trigger stops. */
	target?: number;
	/** `context.workingSet.rearmFraction`: the growth since the last record a new batch needs. */
	rearmFraction?: number;
	autoEvict?: boolean;
}

export class WorkerContextExhaustedError extends Error {}

/**
 * A server overflow reports only that the request was too large, never by how
 * much. The one retry must shrink the failed request to this share of its own
 * estimate. The target is relative to the request, so it needs no window and
 * serves an unreported window and a known one alike.
 */
const OVERFLOW_RECOVERY_KEEP = 0.7;
const DEFAULT_THRESHOLD = 0.8;
/** Only observations with known read semantics leave; mutations and opaque tools stay. */
const READ_CLASS = new Set(["read", "grep", "find", "ls", "code_nav", "web_read", "web_fetch"]);
const OBSERVATION_FLOOR_CHARS = 1000;
const STEP_OVERFLOW_ADVICE =
	"This step's results did not fit the model's context window. Read only the part you need, with offset and limit, one large source per step.";

/** D1: the superseded stage stays off on workers; enabled, it would still need an uncached worker route. */
const WORKER_SUPERSEDED_STAGE = false;
function workerSupersededStageApplies(route: FoldRouteFacts): boolean {
	return WORKER_SUPERSEDED_STAGE && supersededStageApplies(route);
}

export type WorkerEvictionReason = Extract<
	MarkerReason,
	"age_horizon" | "thinking_turn_closed" | "step_overflow" | "unseen_overflow"
>;
export type WorkerEvictedItem = Omit<EvictedItem, "reason"> & { reason: WorkerEvictionReason };

/** The worker's in-memory eviction record: one per checkpoint, in the fold's item shape. */
export interface WorkerEvictionRecord {
	id: string;
	checkpoint: FoldCheckpoint;
	/** The stage id: `step_overflow` when the record took a protected read for fit, seen or unseen. */
	policyId: "working_set" | "step_overflow";
	evicted: WorkerEvictedItem[];
	tokensBefore: number;
	tokensAfter: number;
}

export interface WorkerGuardOptions {
	/** The parent's alias mark the seed carries; this run's first alias is the next one. */
	aliasFloor?: number;
	/** Where `archive` keeps a message: the marker's `offload` pointer, readable without the context tool. */
	archivePath?: (message: AgentMessage) => string;
	route?: FoldRouteFacts;
	onDecision?: (decision: ContextFoldPayload) => void;
}

export interface WorkerContextGuard {
	(input: WorkerPressureInput): AgentMessage[];
	/**
	 * Project a smaller request after the server rejected the last one as too
	 * large, whether Clio's own estimate saw the overflow coming or not. Plans
	 * the same two selections as the ceiling path, bypassing the band, and
	 * returns null unless that brings the request to the recovery target, so the
	 * caller fails with the server's own error instead of spending the only retry
	 * on a request that is still far too large. The first request is the caller's
	 * chosen fork and is never trimmed.
	 */
	recover(input: WorkerPressureInput): AgentMessage[] | null;
	readonly records: ReadonlyArray<WorkerEvictionRecord>;
	/**
	 * The input the last admitted request was counted at, the figure its fit
	 * check passed. Admission and the output clamp size that request from it,
	 * so a request the guard fitted is never refused for a different count (A2c).
	 */
	readonly inputTokens: number;
}

type StageEntry = ContextFoldPayload["stages"][number];

function resultText(message: AgentMessage & { role: "toolResult" }): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/**
 * Per-worker reversible projection. The raw history is never rewritten: each
 * checkpoint plans units by occurrence (the message's index in a history that
 * only grows), commits at most one record, and renders each evicted result as
 * the fold's marker under a run-local `r<N>` alias that recalls the archive.
 */
export function createWorkerContextGuard(
	archive: (alias: string, message: AgentMessage) => void,
	options: WorkerGuardOptions = {},
): WorkerContextGuard {
	const projected = new Map<number, { digest: string; message: AgentMessage }>();
	const records: WorkerEvictionRecord[] = [];
	const route: ContextFoldPayload["route"] = {
		...(options.route?.modelTier !== undefined ? { modelTier: options.route.modelTier } : {}),
		...(options.route?.promptCaching !== undefined ? { promptCaching: options.route.promptCaching } : {}),
	};
	let aliasSequence = options.aliasFloor ?? 0;
	let calls = 0;
	let firstInputLength = 0;
	let lastRequestTokens = 0;
	let anchorKey = "";
	let anchorUsage = 0;
	let anchorFootprint = 0;
	let admittedTokens = 0;

	const checkpointAt = (input: WorkerPressureInput, checkpoint: FoldCheckpoint): AgentMessage[] | null => {
		const recovering = checkpoint === "overflow";
		// An unreported serving window resolves to 0. It admits the request: the
		// server enforces its own limit, and only its rejection can act here.
		const windowKnown = Number.isFinite(input.contextWindow) && input.contextWindow > 0;
		const trigger = windowKnown
			? Math.floor(input.contextWindow * (input.threshold ?? DEFAULT_THRESHOLD))
			: Number.POSITIVE_INFINITY;
		// The reserve is resolved at the request's own size: a wire-clamped transport
		// reserves less as input grows, so no single reserve gives a fixed ceiling (D5).
		const fitsWindow = (tokens: number) => !windowKnown || tokens + input.outputReserve(tokens) <= input.contextWindow;
		const fits = (tokens: number) => tokens <= trigger && fitsWindow(tokens);
		const messages = input.messages.map((message, index) => {
			const unit = projected.get(index);
			return unit !== undefined && unit.digest === contextHash(message) ? unit.message : message;
		});
		const breakdown = estimateAgentContextBreakdown({ systemPrompt: input.systemPrompt, tools: input.tools, messages });
		let structural =
			Object.values(breakdown).reduce((sum, value) => sum + value, 0) + Math.max(0, input.overheadTokens ?? 0);

		// Parent usage never anchors a child. Only a response to this worker's own request can do so.
		if (calls === 0) firstInputLength = input.messages.length;
		else {
			for (let index = messages.length - 1; index >= firstInputLength; index--) {
				const message = messages[index];
				if (
					message?.role !== "assistant" ||
					!message.usage ||
					message.stopReason === "error" ||
					message.stopReason === "aborted"
				)
					continue;
				const usage = message.usage;
				const actual = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				const nextKey = contextHash(message);
				if (nextKey !== anchorKey) {
					anchorKey = nextKey;
					anchorUsage = Number.isFinite(actual) && actual > 0 ? actual : 0;
					// Usage describes the previous projected request plus this answer.
					// Keep that footprint stable across repeated projection of the same answer.
					anchorFootprint = lastRequestTokens + estimateAgentMessageTokens(message);
				}
				break;
			}
		}
		const count = () => Math.max(structural, anchorUsage > 0 ? anchorUsage + structural - anchorFootprint : 0);
		// The recovery target is relative to the failed request, so recovery measures structurally.
		const measure = recovering ? () => structural : count;
		const tokensBefore = recovering ? lastRequestTokens : count();
		const stages: StageEntry[] = [];
		const close = () => {
			if (stages.length === 0) return;
			const committed = stages.some((stage) => stage.outcome === "committed");
			options.onDecision?.({
				checkpoint,
				route,
				stages,
				tokensBefore: Math.max(0, Math.round(tokensBefore)),
				tokensAfter: Math.max(0, Math.round(measure())),
				...(committed ? { cause: "working_set_evict" as const } : {}),
			});
		};
		const accept = () => {
			close();
			calls++;
			lastRequestTokens = structural;
			admittedTokens = Math.max(0, Math.round(count()));
			return messages;
		};
		const fail = (message: string): never => {
			stages.push({ stage: "stop", outcome: "failed", reason: "error" });
			close();
			throw new WorkerContextExhaustedError(message);
		};

		if (recovering) {
			// The first request is the caller's chosen fork, never auto-trimmed.
			if (calls <= 1 || input.autoEvict === false) {
				stages.push(
					{ stage: "working_set", outcome: "none", reason: calls <= 1 ? "protected_recent" : "disabled" },
					{ stage: "stop", outcome: "failed", reason: "error" },
				);
				close();
				return null;
			}
		} else {
			if (!windowKnown || fits(count())) return accept();
			// With no checkpoint stage on a worker, exhaustion stays an error.
			if (calls === 0) {
				stages.push({ stage: "working_set", outcome: "none", reason: "protected_recent" });
				// The first request must honor the selected fork; never auto-trim it into a splice.
				return fail("worker context: initial request leaves insufficient context headroom; use a smaller splice");
			}
			if (input.autoEvict === false) {
				stages.push({ stage: "working_set", outcome: "none", reason: "disabled" });
				return fail("worker context: context budget exhausted with automatic eviction disabled");
			}
		}

		// Plan on a copy; nothing is archived or recorded unless the plan commits.
		const plan = new Map<number, { original: AgentMessage; projection: AgentMessage }>();
		const items: WorkerEvictedItem[] = [];
		let planAliases = aliasSequence;
		const assistantIndices = input.messages.flatMap((message, index) => (message.role === "assistant" ? [index] : []));
		const cutoff = assistantIndices[Math.max(0, assistantIndices.length - 2)] ?? 0;
		// A result after the last assistant arrived in the round being admitted: the model has not read it yet.
		const lastAssistant = assistantIndices.at(-1) ?? -1;
		const toolCalls = new Map(input.messages.flatMap(messageToolCalls).map((call) => [call.id, call]));
		const open = (index: number) => !plan.has(index) && messages[index] === input.messages[index];
		const observation = (index: number): (AgentMessage & { role: "toolResult" }) | undefined => {
			const message = input.messages[index];
			if (message?.role !== "toolResult" || message.isError || !open(index)) return undefined;
			const call = toolCalls.get(message.toolCallId);
			// A gateway call carries its capability's read semantics: a page
			// fetched through the gateway is as evictable as a direct fetch.
			const name = call ? effectiveToolCall(call.name, call.arguments).toolName : undefined;
			if (!name || !READ_CLASS.has(name)) return undefined;
			return JSON.stringify(message.content).length >= OBSERVATION_FLOOR_CHARS ? message : undefined;
		};
		const take = (
			index: number,
			original: AgentMessage,
			projection: AgentMessage,
			item: Omit<WorkerEvictedItem, "tokensFreed">,
		) => {
			const tokensFreed = estimateAgentMessageTokens(original) - estimateAgentMessageTokens(projection);
			if (tokensFreed <= 0) return false;
			plan.set(index, { original, projection });
			items.push({ ...item, tokensFreed });
			messages[index] = projection;
			structural -= tokensFreed;
			return true;
		};
		const takeObservation = (
			index: number,
			message: AgentMessage & { role: "toolResult" },
			reason: WorkerEvictionReason,
		) => {
			const alias = `r${planAliases + 1}`;
			const args = toolCalls.get(message.toolCallId)?.arguments ?? {};
			const path = [args.path, args.file_path, args.filePath].find((value) => typeof value === "string");
			const ref = { entry: String(index) };
			const rendered = renderMarker({
				alias,
				ref,
				reason,
				toolName: message.toolName,
				text: resultText(message),
				...(typeof path === "string" ? { path } : {}),
				...(options.archivePath ? { offloadPath: options.archivePath(message) } : {}),
			});
			const marker = reason === "step_overflow" ? `${rendered} ${STEP_OVERFLOW_ADVICE}` : rendered;
			const projection = { ...message, content: [{ type: "text" as const, text: marker }] } as AgentMessage;
			if (take(index, message, projection, { alias, ref, reason, marker })) planAliases += 1;
		};
		// Units before the last two steps, in position order, while the request is still over.
		const selectAged = (over: () => boolean) => {
			for (let index = 0; index < cutoff && over(); index++) {
				const message = input.messages[index];
				if (message?.role === "assistant" && open(index)) {
					// Thinking is its own unit and leaves no marker, as on the session.
					const content = message.content.filter((block) => block.type !== "thinking");
					if (content.length === 0 || content.length === message.content.length) continue;
					take(
						index,
						message,
						{ ...message, content },
						{ ref: { entry: String(index) }, reason: "thinking_turn_closed", marker: "" },
					);
					continue;
				}
				const result = observation(index);
				if (result !== undefined) takeObservation(index, result, "age_horizon");
			}
		};
		// One step's own results can outgrow the window: a 64K-token worker that
		// reads eight large files in parallel protects all of them as its latest
		// step. Before failing, evict the protected read results too, largest
		// first. Seen results go first and say why, so the next step reads
		// narrower. Results the model has not seen go only after every seen one
		// (A2b): evicting one costs a re-read the model did nothing to cause.
		const selectStepOverflow = (over: () => boolean, unseen: boolean) => {
			const reason: WorkerEvictionReason = unseen ? "unseen_overflow" : "step_overflow";
			const recent = input.messages
				.map((_message, index) => index)
				.filter((index) => index >= cutoff && index > lastAssistant === unseen && observation(index) !== undefined)
				.sort(
					(a, b) =>
						estimateAgentMessageTokens(input.messages[b] as AgentMessage) -
						estimateAgentMessageTokens(input.messages[a] as AgentMessage),
				);
			for (const index of recent) {
				if (!over()) break;
				const result = observation(index);
				if (result !== undefined) takeObservation(index, result, reason);
			}
		};
		// Older units, then seen protected reads, then unseen ones: each stage only while still over.
		const selectForFit = (over: () => boolean) => {
			selectAged(over);
			selectStepOverflow(over, false);
			selectStepOverflow(over, true);
		};

		if (recovering) {
			const goal = Math.floor(lastRequestTokens * OVERFLOW_RECOVERY_KEEP);
			selectForFit(() => structural > goal);
			if (structural > goal) {
				// No retry unless the target is reached: the plan is dropped and the server's error stands.
				stages.push(
					{ stage: "working_set", outcome: "none", reason: items.length === 0 ? "no_candidates" : "no_gain" },
					{ stage: "stop", outcome: "failed", reason: "error" },
				);
				close();
				return null;
			}
		} else {
			// S0 would select first where its gate admits it; D1 holds it off, so no worker record gains a superseded item.
			if (workerSupersededStageApplies(options.route ?? {}))
				stages.push({ stage: "superseded", outcome: "none", reason: "unavailable" });
			const estimate = count();
			const held =
				estimate > trigger &&
				withinRearmBand({
					projectedTokens: estimate,
					contextWindow: input.contextWindow,
					rearmFraction: input.rearmFraction ?? DEFAULT_WORKING_SET_SETTINGS.rearmFraction,
					lastEvictionTokensAfter: records.at(-1)?.tokensAfter ?? null,
				});
			if (held) stages.push({ stage: "working_set", outcome: "held", reason: "rearm_band" });
			else if (estimate > trigger) {
				const goal = Math.floor(input.contextWindow * (input.target ?? DEFAULT_WORKING_SET_SETTINGS.target));
				selectAged(() => count() > goal);
			}
			// Short of headroom, or still over after the batch: the band holds the trigger, never a fit.
			// A fit takes older units before any protected read, without the band (A2a).
			const exhausted = () => (held ? !fitsWindow(count()) : !fits(count()));
			if (exhausted()) selectForFit(exhausted);
			if (exhausted()) {
				if (items.length > 0) stages.push({ stage: "working_set", outcome: "none", reason: "no_gain" });
				return fail("worker context: protected task context exceeds available headroom after reversible eviction");
			}
		}
		if (items.length === 0) {
			if (!stages.some((stage) => stage.outcome === "held"))
				stages.push({ stage: "working_set", outcome: "none", reason: "no_candidates" });
			return accept();
		}
		const record: WorkerEvictionRecord = {
			id: `eviction-${records.length + 1}`,
			checkpoint,
			policyId: items.some((item) => item.reason === "step_overflow" || item.reason === "unseen_overflow")
				? "step_overflow"
				: "working_set",
			evicted: items,
			tokensBefore: Math.max(0, Math.round(tokensBefore)),
			tokensAfter: Math.max(0, Math.round(measure())),
		};
		for (const [index, { original, projection }] of plan) {
			const item = items.find((candidate) => candidate.ref.entry === String(index));
			if (item?.alias !== undefined) archive(item.alias, structuredClone(original));
			projected.set(index, { digest: contextHash(original), message: projection });
		}
		aliasSequence = planAliases;
		records.push(record);
		// The journal names a commit that took a protected read; the item reasons stay on the record.
		const reason = items.some((item) => item.reason === "unseen_overflow")
			? "unseen_overflow"
			: items.some((item) => item.reason === "step_overflow")
				? "step_overflow"
				: "evicted";
		stages.push({ stage: "working_set", outcome: "committed", reason, recordId: record.id });
		return accept();
	};
	const guard = (input: WorkerPressureInput): AgentMessage[] =>
		checkpointAt(input, calls === 0 ? "submit" : "tool_batch") as AgentMessage[];
	return Object.defineProperties(guard, {
		recover: { value: (input: WorkerPressureInput): AgentMessage[] | null => checkpointAt(input, "overflow") },
		records: { value: records },
		inputTokens: { get: () => admittedTokens },
	}) as WorkerContextGuard;
}
