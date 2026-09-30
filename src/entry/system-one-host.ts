/**
 * What the composition root keeps between System One calls.
 *
 * The turn site is asked once, before the prompt is built, and three readers
 * that cannot await take what it left: the hint registration, the turn
 * controller and the prewarm. The turn-end site is asked once per settled turn
 * and its reading is shared: whether the message asks or blocks on the operator
 * feeds the clarification streak and the turn outcome record that measures how
 * turns end. The relevance site ranks a catalog when a tool is asked for one.
 * Everything here degrades to what the harness did before System One existed:
 * an unbound, slow, failed or unfitted site hands back null and the reader
 * keeps its own answer.
 */

import type { DecisionHintLines } from "../domains/middleware/decision-hints.js";
import type { ObservabilityContract } from "../domains/observability/contract.js";
import { appendOutOfTurnUsageRow } from "../domains/observability/out-of-turn-usage.js";
import { resolveEffectivePricing } from "../domains/providers/catalog.js";
import type { ProvidersContract } from "../domains/providers/contract.js";
import { SessionCostCeilingError } from "../domains/scheduling/budget.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import { operatorTextOfUserPayload } from "../domains/session/history.js";
import type { SessionEntry } from "../domains/session/index.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type {
	DecisionRecorder,
	LlmRequestAdmission,
	OutcomeRecord,
	SystemOne,
	Verdict,
} from "../domains/system-one/index.js";
import { LlmAdmissionRefused } from "../domains/system-one/index.js";
import { TOOL_CALL_GATE_SITE } from "../domains/system-one/sites/tool-call.js";
import { TOOL_RESULT_SITE } from "../domains/system-one/sites/tool-result.js";
import { TURN_SITE, type TurnRecipeOption, type TurnValue } from "../domains/system-one/sites/turn.js";
import { TURN_END_SITE, type TurnEndValue } from "../domains/system-one/sites/turn-end.js";
import type { TokenSplit, TurnInterpretation } from "../domains/turn-control/index.js";
import type { ToolCallGateSubject, ToolCallGateVerdict } from "../tools/registry.js";

/**
 * How long a turn waits for the turn-end reading, counted from the moment it
 * was first asked for. The settled turn holds the next prompt behind it, so
 * a slower answer is recorded by the runner but never waited for.
 */
export const TURN_END_WAIT_MS = 1_200;

/** Earlier operator requests the turn-end site reads beside the current one. */
const EARLIER_REQUESTS = 3;

/** Turns whose System One spend is still being counted. */
const COUNTED_TURNS = 8;

export function createSystemOneRequestAdmission(deps: {
	providers: Pick<ProvidersContract, "getTarget">;
	scheduling?: SchedulingContract;
	observability?: ObservabilityContract;
	getCeilingUsd: () => number;
	currentSession: () => string | null;
	repoIdentity: () => string | null;
	stateDir: string;
}): LlmRequestAdmission {
	return async ({ targetId, model, signal }) => {
		const session = deps.currentSession();
		const repoIdentity = deps.repoIdentity();
		const target = deps.providers.getTarget(targetId);
		if (target === null) throw new LlmAdmissionRefused(`target '${targetId}' is no longer configured`);
		const pricing = resolveEffectivePricing(target, target.runtime, model);
		try {
			signal.throwIfAborted();
			if (pricing.provenance === "known" || pricing.provenance === "estimated") {
				if (deps.scheduling?.admitPaidRequest) {
					await deps.scheduling.admitPaidRequest({ waitForRaise: false, getCeilingUsd: deps.getCeilingUsd, signal });
				} else {
					const currentUsd = deps.observability?.sessionCost() ?? 0;
					const ceilingUsd = deps.getCeilingUsd();
					if (currentUsd >= ceilingUsd) throw new SessionCostCeilingError(currentUsd, ceilingUsd);
				}
			}
			signal.throwIfAborted();
			if (deps.currentSession() !== session) throw new Error("System One session changed before the request");
		} catch (error) {
			throw new LlmAdmissionRefused(error instanceof Error ? error.message : String(error), { cause: error });
		}
		return (usage) => {
			if (usage === null) return;
			const cacheRead = usage.cacheRead ?? 0;
			const cacheWrite = usage.cacheWrite ?? 0;
			const reasoning = usage.reasoning ?? 0;
			const totalTokens = usage.totalTokens ?? usage.input + usage.output + cacheRead + cacheWrite;
			const costUsd =
				usage.costUsd ??
				(pricing.rates === null
					? 0
					: (usage.input * pricing.rates.input +
							usage.output * pricing.rates.output +
							cacheRead * pricing.rates.cacheRead +
							cacheWrite * pricing.rates.cacheWrite) /
						1_000_000);
			// Late answers must not charge the session that replaced their origin.
			if (deps.currentSession() === session) {
				deps.observability?.recordTokens(
					targetId,
					model,
					totalTokens,
					costUsd,
					{
						input: usage.input,
						output: usage.output,
						cacheRead,
						cacheWrite,
						...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
						reasoningTokens: reasoning,
						totalTokens,
						apiCalls: 1,
					},
					pricing.provenance,
					undefined,
					"system-one",
				);
			}
			appendOutOfTurnUsageRow(deps.stateDir, {
				label: "system-one",
				repoIdentity,
				timestamp: new Date().toISOString(),
				target: targetId,
				attributedModelId: model,
				usage: {
					input: usage.input,
					output: usage.output,
					cacheRead,
					cacheWrite,
					...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
					reasoning,
					totalTokens,
					costUsd: pricing.provenance === "unknown" ? null : costUsd,
				},
			});
		};
	};
}

interface Spend {
	calls: number;
	reported: number;
	input: number;
	output: number;
}

export interface DecisionUsageTally {
	/** The recorder to hand to `createSystemOne`: it forwards everything and counts what each turn's calls spent. */
	readonly recorder: DecisionRecorder;
	/** Start counting the calls joined to this user turn. */
	begin(ref: string): void;
	/** What the counted calls spent; `none` when nothing was counted or no call reported usage. */
	read(ref: string): TokenSplit;
}

export function createDecisionUsageTally(inner: DecisionRecorder): DecisionUsageTally {
	const counted = new Map<string, Spend>();
	return {
		recorder: {
			decision(record) {
				inner.decision(record);
				const spend = record.ref === undefined ? undefined : counted.get(record.ref);
				if (spend === undefined) return;
				spend.calls += 1;
				if (record.usage === undefined) return;
				spend.reported += 1;
				spend.input += record.usage.input;
				spend.output += record.usage.output;
			},
			outcome: (record) => inner.outcome(record),
		},
		begin(ref) {
			counted.set(ref, { calls: 0, reported: 0, input: 0, output: 0 });
			// A turn nobody reads back must not keep its counter forever.
			for (const key of counted.keys()) {
				if (counted.size <= COUNTED_TURNS) break;
				counted.delete(key);
			}
		},
		read(ref) {
			const spend = counted.get(ref);
			if (spend === undefined) {
				return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, provenance: "none" };
			}
			return {
				inputTokens: spend.input,
				outputTokens: spend.output,
				cacheReadTokens: 0,
				totalTokens: spend.input + spend.output,
				provenance: spend.reported === 0 ? "none" : spend.reported === spend.calls ? "reported" : "partial",
			};
		},
	};
}

export interface SystemOneHostDeps {
	systemOne: SystemOne;
	usage: DecisionUsageTally;
	/** The current session's ledger, for the operator's earlier requests. */
	readSessionEntries: () => ReadonlyArray<SessionEntry>;
	/** The recipes a dispatch could name first, or null unless the prewarm is on. */
	listRecipes: () => ReadonlyArray<TurnRecipeOption> | null;
	/** The session current now, so operator texts kept for one session are never read in another. */
	currentSession?: () => string | null;
	/**
	 * Whether `systemOne.record` is on. A shadowed call can only be recorded, so
	 * with recording off it is not made at all. Absent reads as on.
	 */
	recording?: () => boolean;
}

export interface TurnReadInput {
	userTurnId: string;
	task: string;
	/** What the operator typed, as the ledger shows it: an expansion's typed title rather than its body. */
	request: string;
	previous: string;
	/** The operator's previous request. It reparses the ledger, so it is read only when the site is bound. */
	previousTask: () => string;
	signal: AbortSignal;
}

export interface TurnEndReadInput {
	userTurnId: string;
	request: string;
	message: string;
	toolNames: ReadonlyArray<string>;
}

export interface TurnPrewarmPrediction {
	readonly agentId: string;
	readonly count: number;
}

export interface SystemOneHost {
	/** Ask the `turn` site about this request and keep the verdict for its three readers. */
	readTurn(input: TurnReadInput): Promise<void>;
	/** This turn's hint lines, or null when no site answered. */
	hints(): DecisionHintLines | null;
	/** What the turn controller may act on, or undefined when no site answered. */
	interpretation(): TurnInterpretation | undefined;
	/** The worker a confident forecast says the agent is about to dispatch, or null. */
	prewarm(): TurnPrewarmPrediction | null;
	/** Forget this turn's verdict, so a continuation or the next turn cannot read a stale one. */
	clearVerdict(): void;
	/** The task text of the last operator turn, for a catalog ranking asked for mid-turn. */
	task(): string;
	/** The user turn id of the last operator turn, the join key of a mid-turn ranking. */
	turnId(): string | null;
	/** Whether the turn-end site can answer, so a reader knows whether to wait. */
	turnEndBound(): boolean;
	/** Drop the operator texts kept in memory. The next turn-end reading reads the ledger once. */
	forgetOperatorTexts(): void;
	/** The settled turn's reading of whether the message asks the operator something; null keeps the regex. */
	readTurnEnd(input: TurnEndReadInput): Promise<{ asks: boolean | null } | null>;
	/** Whether the message blocks on a decision; false says it is an invitation, null keeps today's behavior. */
	blocksOnOperator(input: TurnEndReadInput): Promise<boolean | null>;
	/** The banner to put in front of a tool result whose content reads as directing an agent, or null. */
	screenToolResult(
		source: string,
		content: string,
		ref: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<string | null>;
	/** Whether an unrecognized command that yolo would run unread should go to the operator first. */
	gateToolCall(
		subject: ToolCallGateSubject,
		ref: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<ToolCallGateVerdict | null>;
	/** What followed a decision, joined to it by `ref`. */
	recordOutcome(outcome: {
		ref: string;
		source: OutcomeRecord["source"];
		facts: Readonly<Record<string, unknown>>;
	}): void;
}

function runOptions(ref: string | undefined, signal: AbortSignal | undefined): { ref?: string; signal?: AbortSignal } {
	return { ...(ref !== undefined ? { ref } : {}), ...(signal !== undefined ? { signal } : {}) };
}

/**
 * Start a call nobody waits on. An unfitted build can never flag or escalate,
 * so the tool call it would hold goes ahead at once and the answer is only
 * recorded. The tool's abort signal is not passed: the call outlives the tool
 * call it describes, and the site's own deadline bounds it.
 */
function detached(call: () => Promise<unknown>): void {
	try {
		// run() never rejects; the catch covers a test double that does.
		call().catch(() => {});
	} catch {
		// Recording is all a detached call can do, and failing to start it costs nothing.
	}
}

/** A promise's value, or null once `ms` passed. The answer that arrives late is still recorded by its runner. */
async function withinDeadline<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Up to `limit` operator messages that precede the turn `beforeTurnId`, oldest
 * first. Synthetic user turns (a continuation's nudge) are not the operator's
 * words and are skipped.
 */
function priorOperatorTexts(entries: ReadonlyArray<SessionEntry>, beforeTurnId: string, limit: number): string[] {
	const path = filterEntriesToActivePath(entries, beforeTurnId);
	let end = path.findIndex((entry) => entry.turnId === beforeTurnId);
	if (end < 0) end = path.length;
	const texts: string[] = [];
	for (let index = end - 1; index >= 0 && texts.length < limit; index -= 1) {
		const entry = path[index];
		if (entry?.kind !== "message" || entry.role !== "user") continue;
		if ((entry.payload as { synthetic?: unknown } | null)?.synthetic === true) continue;
		const text = operatorTextOfUserPayload(entry.payload);
		if (text !== null && text.trim().length > 0) texts.unshift(text);
	}
	return texts;
}

export function createSystemOneHost(deps: SystemOneHostDeps): SystemOneHost {
	const { systemOne } = deps;
	let turn: { id: string; task: string; verdict: Verdict<TurnValue> | null } | null = null;
	let turnEnd: { id: string; read: Promise<Verdict<TurnEndValue> | null>; askedAt: number } | null = null;
	/**
	 * The operator's recent requests on the active path, newest last, so the
	 * turn-end site does not reparse the whole ledger every turn. Seeded from the
	 * ledger once after a reset: a new session, a park, a resume, a fork or a
	 * `/tree` switch, each of which can change which requests precede the next.
	 */
	let operatorTexts: { session: string | null; seeded: boolean; turns: Array<{ id: string; text: string }> } = {
		session: null,
		seeded: false,
		turns: [],
	};

	function recordingOn(): boolean {
		try {
			return deps.recording?.() ?? true;
		} catch {
			return true;
		}
	}

	function sessionNow(): string | null {
		try {
			return deps.currentSession?.() ?? null;
		} catch {
			return null;
		}
	}

	/** The kept texts, emptied first when the session moved under them. */
	function operatorTextsNow(): typeof operatorTexts {
		const session = sessionNow();
		if (operatorTexts.session !== session) operatorTexts = { session, seeded: false, turns: [] };
		return operatorTexts;
	}

	function noteOperatorTurn(id: string, text: string): void {
		const kept = operatorTextsNow();
		kept.turns.push({ id, text });
		// The current request plus the earlier ones the site reads.
		if (kept.turns.length > EARLIER_REQUESTS + 1) kept.turns.splice(0, kept.turns.length - (EARLIER_REQUESTS + 1));
	}

	/** Up to `EARLIER_REQUESTS` operator texts before `turnId`, oldest first. */
	function earlierOperatorTexts(turnId: string): string[] {
		const kept = operatorTextsNow();
		const index = kept.turns.findIndex((entry) => entry.id === turnId);
		if (kept.seeded && index >= 0)
			return kept.turns
				.slice(0, index)
				.slice(-EARLIER_REQUESTS)
				.map((entry) => entry.text);
		const earlier = priorOperatorTexts(deps.readSessionEntries(), turnId, EARLIER_REQUESTS);
		kept.turns = [...earlier.map((text) => ({ id: "", text })), ...(index >= 0 ? kept.turns.slice(index) : [])];
		kept.seeded = true;
		return earlier;
	}

	/** One reading per turn, shared by the nudge and the settled turn. */
	function turnEndReading(input: TurnEndReadInput): Promise<Verdict<TurnEndValue> | null> {
		if (turnEnd?.id === input.userTurnId) return turnEnd.read;
		if (!systemOne.bound("turnEnd")) return Promise.resolve(null);
		let earlier: string[] = [];
		try {
			earlier = earlierOperatorTexts(input.userTurnId);
		} catch {
			// The ledger is evidence for one question about switching gears; the rest stand without it.
		}
		const read = systemOne.run(
			TURN_END_SITE,
			{
				request: input.request,
				message: input.message,
				earlier,
				// The names once each, in the order the turn first used them: forty reads
				// would otherwise fill the site's bound and hide the one edit after them.
				tools: [...new Set(input.toolNames)],
			},
			{ ref: input.userTurnId },
		);
		turnEnd = { id: input.userTurnId, read, askedAt: performance.now() };
		return read;
	}

	/**
	 * The shared reading, or null once the turn's wait is spent. A settled turn
	 * that follows a nudge which already waited would otherwise wait a second
	 * full interval on an engine that missed the first.
	 */
	function awaitTurnEnd(input: TurnEndReadInput): Promise<Verdict<TurnEndValue> | null> {
		// Nothing a shadowed build says can move the nudge or the streak, so neither
		// waits for it. With recording on the shared call still runs, detached; with it
		// off there is nothing to feed, so no call is made. Once the build's last
		// answer ages out `shadowed` reads false and the call is awaited again.
		if (systemOne.shadowed("turnEnd")) {
			if (recordingOn()) turnEndReading(input).catch(() => {});
			return Promise.resolve(null);
		}
		const read = turnEndReading(input);
		const askedAt = turnEnd?.id === input.userTurnId ? turnEnd.askedAt : performance.now();
		return withinDeadline(read, Math.max(0, TURN_END_WAIT_MS - (performance.now() - askedAt)));
	}

	return {
		async readTurn(input) {
			const held: NonNullable<typeof turn> = { id: input.userTurnId, task: input.task, verdict: null };
			turn = held;
			noteOperatorTurn(input.userTurnId, input.request);
			// Counted and held even unbound: a catalog ranking or a consult later in the
			// turn joins this id.
			deps.usage.begin(input.userTurnId);
			if (!systemOne.bound("turn")) return;
			let recipes: ReadonlyArray<TurnRecipeOption> | null = null;
			try {
				recipes = deps.listRecipes();
			} catch {
				// Without recipes the turn asks no recipe question, which is the prewarm off.
			}
			let previousTask = "";
			try {
				previousTask = input.previousTask();
			} catch {
				// An unreadable ledger costs the correction evidence, never the turn.
			}
			const object = {
				task: input.task,
				previous: input.previous,
				previousTask,
				...(recipes !== null ? { recipes } : {}),
			};
			// A build with no fitted cut can hint and act on nothing, so the prompt does
			// not wait up to the site's deadline for an answer that changes no reader.
			// With recording on the call still runs and is recorded, and the turn proceeds
			// as if it were null; with it off no call is made.
			if (systemOne.shadowed("turn")) {
				if (!recordingOn()) return;
				detached(() => systemOne.run(TURN_SITE, object, { ref: input.userTurnId }));
				return;
			}
			const verdict = await systemOne.run(TURN_SITE, object, { ref: input.userTurnId, signal: input.signal });
			// A newer turn may have started while this one waited.
			if (turn === held) held.verdict = verdict;
		},

		hints: () => turn?.verdict?.value.hints ?? null,

		interpretation() {
			const value = turn?.verdict?.value;
			if (value === undefined) return undefined;
			return {
				intent: value.intent,
				orientation: { wanted: value.acts.orientation, breadth: value.breadth, probability: value.orientation },
				direction: { requested: value.acts.direction },
				dispatch: { expected: value.acts.dispatch, probability: value.dispatch },
			};
		},

		prewarm() {
			const value = turn?.verdict?.value;
			if (value === undefined || !value.acts.prewarm || typeof value.recipe !== "string") return null;
			// Two held workers cover a parallel split; anything else is one.
			return { agentId: value.recipe, count: value.shape === "parallel" ? 2 : 1 };
		},

		clearVerdict() {
			if (turn !== null) turn.verdict = null;
		},

		task: () => turn?.task ?? "",
		turnId: () => turn?.id ?? null,
		turnEndBound: () => systemOne.bound("turnEnd"),

		forgetOperatorTexts() {
			operatorTexts = { session: null, seeded: false, turns: [] };
		},

		async readTurnEnd(input) {
			const verdict = await awaitTurnEnd(input);
			return verdict === null ? null : { asks: verdict.value.asks };
		},

		async blocksOnOperator(input) {
			const verdict = await awaitTurnEnd(input);
			return verdict === null ? null : verdict.value.blocks;
		},

		async screenToolResult(source, content, ref, signal) {
			if (!systemOne.bound("toolResult")) return null;
			if (systemOne.shadowed("toolResult")) {
				detached(() => systemOne.run(TOOL_RESULT_SITE, { source, content }, runOptions(ref, undefined)));
				return null;
			}
			const verdict = await systemOne.run(TOOL_RESULT_SITE, { source, content }, runOptions(ref, signal));
			return verdict?.value.flagged ? verdict.value.banner : null;
		},

		async gateToolCall(subject, ref, signal) {
			if (!systemOne.bound("toolCall")) return null;
			if (systemOne.shadowed("toolCall")) {
				detached(() => systemOne.run(TOOL_CALL_GATE_SITE, { ...subject, moment: "gate" }, runOptions(ref, undefined)));
				return null;
			}
			const verdict = await systemOne.run(TOOL_CALL_GATE_SITE, { ...subject, moment: "gate" }, runOptions(ref, signal));
			return verdict === null
				? null
				: { escalate: verdict.value.escalate, reason: verdict.value.reason, build: verdict.build };
		},

		recordOutcome(outcome) {
			deps.usage.recorder.outcome({
				ref: outcome.ref,
				source: outcome.source,
				at: new Date().toISOString(),
				facts: outcome.facts,
			});
		},
	};
}
