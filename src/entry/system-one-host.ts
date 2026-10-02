/**
 * What the composition root keeps between System One calls.
 *
 * The turn site is asked once, at submit, and nothing waits for it. Its readers
 * (the hint registration, the turn controller, the plan-close registration and
 * the prewarm) take a fitted reading that has already landed when they read,
 * and otherwise behave as if the site were unbound. The turn-end site is asked
 * once per settled turn, detached, and its reading is only recorded beside the
 * turn outcome; the clarification streak keeps the regex reading. The relevance
 * site ranks a catalog when a tool is asked for one.
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
import type { TurnRecipeOption, TurnValue } from "../domains/system-one/sites/turn.js";
import { recipesInGroup, TURN_RECIPE_SITE, TURN_SITE } from "../domains/system-one/sites/turn.js";
import { TURN_END_SITE } from "../domains/system-one/sites/turn-end.js";
import type { TokenSplit, TurnInterpretation } from "../domains/turn-control/index.js";
import type { ToolCallGateSubject } from "../tools/registry.js";

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
	/** The operator's previous request. It reparses the ledger, so it is read only when a call will be made. */
	previousTask: () => string;
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
	/**
	 * Start asking the `turn` site about this request and return at once. A
	 * fitted reading is kept for the readers below when it lands; an unfitted one
	 * is only recorded.
	 */
	readTurn(input: TurnReadInput): void;
	/** This turn's hint lines, or null until a fitted reading has landed. */
	hints(): DecisionHintLines | null;
	/** What the turn controller may act on, or undefined until a fitted reading has landed. */
	interpretation(): TurnInterpretation | undefined;
	/** The worker a confident forecast says the agent is about to dispatch, or null. */
	prewarm(): TurnPrewarmPrediction | null;
	/** Forget this turn's verdict, so a continuation or the next turn cannot read a stale one. */
	clearVerdict(): void;
	/** The task text of the last operator turn, for a catalog ranking asked for mid-turn. */
	task(): string;
	/** The user turn id of the last operator turn, the join key of a mid-turn ranking. */
	turnId(): string | null;
	/** Drop the operator texts kept in memory. The next turn-end reading reads the ledger once. */
	forgetOperatorTexts(): void;
	/**
	 * Read the settled turn's final message, detached, for the record. The
	 * turn-end site is experimental and record-only: nothing waits for it and no
	 * reader takes its answer.
	 */
	recordTurnEnd(input: TurnEndReadInput): void;
	/**
	 * Read a delivered tool result for instructions aimed at an agent, detached,
	 * for the record. The classifier is experimental and never changes the result.
	 */
	screenToolResult(source: string, content: string, ref: string | undefined, restrictions: unknown): void;
	/**
	 * Read an unrecognized command yolo runs unread, detached, for the record.
	 * The gate is experimental and never holds or parks the call.
	 */
	observeToolCallGate(subject: ToolCallGateSubject, ref: string | undefined): void;
	/** What followed a decision, joined to it by `ref`. */
	recordOutcome(outcome: {
		ref: string;
		source: OutcomeRecord["source"];
		facts: Readonly<Record<string, unknown>>;
	}): void;
}

function runOptions(ref: string | undefined, flow?: unknown): { ref?: string; flow?: unknown } {
	return {
		...(ref !== undefined ? { ref } : {}),
		...(flow !== undefined && flow !== null ? { flow } : {}),
	};
}

/**
 * Start a call nobody waits on; the runner records its answer whenever it
 * settles. The caller's abort signal is not passed: the call outlives the turn
 * or tool call it describes, and the site's own deadline bounds it.
 */
function detached(call: () => Promise<unknown>): void {
	try {
		// run() never rejects; the catch covers a test double that does.
		call().catch(() => {});
	} catch {
		// Recording is all a detached call can do, and failing to start it costs nothing.
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
	let turn: { id: string; task: string; verdict: Verdict<TurnValue> | null; groupRecipe: string | null } | null = null;
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

	return {
		readTurn(input) {
			const held: NonNullable<typeof turn> = { id: input.userTurnId, task: input.task, verdict: null, groupRecipe: null };
			turn = held;
			noteOperatorTurn(input.userTurnId, input.request);
			// Counted and held even unbound: a catalog ranking or a consult later in the
			// turn joins this id.
			deps.usage.begin(input.userTurnId);
			if (!systemOne.bound("turn")) return;
			// A build with no fitted cut can hint and act on nothing, so with recording
			// off its call is not made, and the recipe list and the ledger reparse that
			// would only build its state are skipped with it.
			const shadow = systemOne.shadowed("turn");
			if (shadow && !recordingOn()) return;
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
			const recipeOptionLimit = systemOne.limits?.("turn", "recipe")?.maxOptions;
			const object = {
				task: input.task,
				previous: input.previous,
				previousTask,
				...(recipes !== null ? { recipes } : {}),
				...(recipeOptionLimit !== undefined ? { recipeOptionLimit } : {}),
			};
			if (shadow) {
				detached(() => systemOne.run(TURN_SITE, object, { ref: input.userTurnId }));
				return;
			}
			// Nothing waits for the reading. Its readers take it only if it landed
			// before they read, and only from a fitted build: an unfitted reading's
			// intent has no cut and once overrode the plan-close regex on its own.
			// The operator's cancel does not abort it, because the reading is still a
			// record of the request.
			detached(async () => {
				const verdict = await systemOne.run(TURN_SITE, object, { ref: input.userTurnId });
				if (turn !== held || verdict === null || !verdict.fitted) return;
				held.verdict = verdict;
				// A category was chosen but not its member: one bounded follow-up under
				// its own deadline picks the recipe to hold, chained here so it never
				// adds a wait of its own.
				const value = verdict.value;
				if (!value.acts.prewarmPending || typeof value.recipeGroup !== "string") return;
				const members = recipesInGroup(object, value.recipeGroup);
				if (members.length === 0) return;
				const picked = await systemOne.run(
					TURN_RECIPE_SITE,
					{ task: input.task, previous: input.previous, previousTask, recipes: members },
					{ ref: input.userTurnId },
				);
				if (turn === held) held.groupRecipe = picked?.value.recipe ?? null;
			});
		},

		hints: () => turn?.verdict?.value.hints ?? null,

		interpretation() {
			const value = turn?.verdict?.value;
			if (value === undefined) return undefined;
			return {
				intent: value.intent,
				orientation: {
					wanted: value.acts.orientation,
					breadth: value.breadth,
					...(value.orientation !== null ? { probability: value.orientation } : {}),
				},
				direction: { requested: value.acts.direction },
				dispatch: { expected: value.acts.dispatch, ...(value.dispatch !== null ? { probability: value.dispatch } : {}) },
			};
		},

		prewarm() {
			const value = turn?.verdict?.value;
			if (value === undefined) return null;
			const recipe =
				value.acts.prewarm && typeof value.recipe === "string"
					? value.recipe
					: value.acts.prewarmPending
						? (turn?.groupRecipe ?? null)
						: null;
			if (recipe === null) return null;
			// Two held workers cover a parallel split; anything else is one.
			return { agentId: recipe, count: value.shape === "parallel" ? 2 : 1 };
		},

		clearVerdict() {
			if (turn !== null) turn.verdict = null;
		},

		task: () => turn?.task ?? "",
		turnId: () => turn?.id ?? null,

		forgetOperatorTexts() {
			operatorTexts = { session: null, seeded: false, turns: [] };
		},

		recordTurnEnd(input) {
			if (!systemOne.bound("turnEnd")) return;
			// A shadowed build's reading can only be recorded, so with recording off
			// there is nothing to make the call for.
			if (systemOne.shadowed("turnEnd") && !recordingOn()) return;
			let earlier: string[] = [];
			try {
				earlier = earlierOperatorTexts(input.userTurnId);
			} catch {
				// The ledger is evidence for one question about switching gears; the rest stand without it.
			}
			detached(() =>
				systemOne.run(
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
				),
			);
		},

		screenToolResult(source, content, ref, restrictions) {
			if (!systemOne.bound("toolResult")) return;
			if (systemOne.shadowed("toolResult") && !recordingOn()) return;
			// The restrictions the result carries travel with the request, so the
			// engine's flow check refuses the classifier call before any byte
			// leaves: a restricted read is never redacted after being classified.
			detached(() => systemOne.run(TOOL_RESULT_SITE, { source, content }, runOptions(ref, restrictions)));
		},

		observeToolCallGate(subject, ref) {
			if (!systemOne.bound("toolCall")) return;
			// A shadowed build's reading can only be recorded, so with recording off
			// there is nothing to make the call for.
			if (systemOne.shadowed("toolCall", "gate") && !recordingOn()) return;
			detached(() => systemOne.run(TOOL_CALL_GATE_SITE, { ...subject, moment: "gate" }, runOptions(ref)));
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
