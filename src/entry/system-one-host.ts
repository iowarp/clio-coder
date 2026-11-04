/**
 * What the composition root keeps between System One calls.
 *
 * The turn site is asked once, at submit, without holding up the submit. The
 * hint registration and the prewarm take a fitted
 * reading that has already landed when they read, and otherwise behave as if
 * the site were unbound. The turn controller runs before the prompt and usually
 * before any reading could land, so it alone may wait for one: only when a
 * reading could change what it decides, and never past the site's deadline or
 * the operator's cancel. That bounded wait is the only delay the reading can
 * add before the prompt. The turn-end site is asked once per settled turn,
 * detached, and its reading is only recorded beside the turn outcome; the
 * clarification streak keeps the regex reading. The relevance site ranks a
 * catalog when a tool is asked for one. The turn-end, tool-result, gate and steer
 * readings have no reader, so they are asked only while the dataset is recorded.
 * Everything here degrades to what the harness did before System One existed:
 * an unbound, slow, failed or unfitted site hands back null and the reader
 * keeps its own answer.
 */

import type { Fact } from "../core/telemetry/fact.js";
import { sumFacts } from "../core/telemetry/pricing.js";
import type { DecisionHintLines } from "../domains/middleware/decision-hints.js";
import { operatorTextOfUserPayload } from "../domains/session/history.js";
import type { SessionEntry } from "../domains/session/index.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";
import type { DecisionRecorder, OutcomeRecord, SystemOne, Verdict } from "../domains/system-one/index.js";
import { STEER_SITE } from "../domains/system-one/sites/steer.js";
import { TOOL_CALL_GATE_SITE } from "../domains/system-one/sites/tool-call.js";
import { TOOL_RESULT_SITE } from "../domains/system-one/sites/tool-result.js";
import type { TurnRecipeOption, TurnValue } from "../domains/system-one/sites/turn.js";
import { TURN_SITE, WORKER_PREPARE_SITE } from "../domains/system-one/sites/turn.js";
import { TURN_END_SITE } from "../domains/system-one/sites/turn-end.js";
import { addGroup, emptyFactSum } from "../domains/telemetry/folds.js";
import type { TurnInterpretation, TurnTokens } from "../domains/turn-control/index.js";
import type { ToolCallGateSubject } from "../tools/registry.js";

/** Earlier operator requests the turn-end site reads beside the current one. */
const EARLIER_REQUESTS = 3;

/** Turns whose System One spend is still being counted. */
const COUNTED_TURNS = 8;

/** Answers per site behind the latency `/systemone status` shows. */
const KEPT_LATENCIES = 32;

/** One counted call's tokens; a call that reported no usage is unknown, never zero (#434). */
interface Spend {
	input: Fact<number>[];
	output: Fact<number>[];
}

export interface DecisionUsageTally {
	/** The recorder to hand to `createSystemOne`: it forwards everything and counts what each turn's calls spent. */
	readonly recorder: DecisionRecorder;
	/** Start counting the calls joined to this user turn. */
	begin(ref: string): void;
	/** What the counted calls spent, one fact sum per quantity; empty when nothing was counted. */
	read(ref: string): TurnTokens;
	/** The median latency of this session's recent answers at a site, or null before any. */
	latency(site: string): number | null;
}

export function createDecisionUsageTally(inner: DecisionRecorder): DecisionUsageTally {
	const counted = new Map<string, Spend>();
	const latencies = new Map<string, number[]>();
	return {
		recorder: {
			decision(record) {
				inner.decision(record);
				if (record.outcome === "answered") {
					const kept = latencies.get(record.site) ?? [];
					kept.push(record.latencyMs);
					if (kept.length > KEPT_LATENCIES) kept.shift();
					latencies.set(record.site, kept);
				}
				const spend = record.ref === undefined ? undefined : counted.get(record.ref);
				if (spend === undefined) return;
				const fact = (value: number | undefined): Fact<number> =>
					value === undefined
						? { kind: "unknown", reason: "provider-omitted" }
						: { kind: "measured", value, source: "provider" };
				spend.input.push(fact(record.usage?.input));
				spend.output.push(fact(record.usage?.output));
			},
			outcome: (record) => inner.outcome(record),
		},
		begin(ref) {
			counted.set(ref, { input: [], output: [] });
			// A turn nobody reads back must not keep its counter forever.
			for (const key of counted.keys()) {
				if (counted.size <= COUNTED_TURNS) break;
				counted.delete(key);
			}
		},
		latency(site) {
			const kept = latencies.get(site);
			if (kept === undefined || kept.length === 0) return null;
			return [...kept].sort((a, b) => a - b)[Math.floor(kept.length / 2)] ?? null;
		},
		read(ref) {
			const spend = counted.get(ref) ?? { input: [], output: [] };
			// The decision model reports no cache reads; its total is its input and output, call by call.
			return {
				input: sumFacts(spend.input),
				output: sumFacts(spend.output),
				cacheRead: sumFacts([]),
				total: spend.input.reduce((sum, input, index) => {
					addGroup(sum, [input, spend.output[index] ?? input]);
					return sum;
				}, emptyFactSum()),
			};
		},
	};
}

export interface SystemOneHostDeps {
	systemOne: SystemOne;
	usage: DecisionUsageTally;
	/** The current session's ledger, for the operator's earlier requests. */
	readSessionEntries: () => ReadonlyArray<SessionEntry>;
	/** The recipes a dispatch could name first, or null unless worker preparation is on. */
	listRecipes: () => ReadonlyArray<TurnRecipeOption> | null;
	/** The session current now, so operator texts kept for one session are never read in another. */
	currentSession?: () => string | null;
	/**
	 * Whether the dataset is kept (research capture, or the deprecated `systemOne.record`). A shadowed call can only be recorded, so
	 * with recording off it is not made at all. Absent reads as on.
	 */
	recording?: () => boolean;
	/** Called once per turn when a reading predicts a worker, however late before settlement it lands. */
	onPrediction?: (prediction: TurnPrewarmPrediction) => void;
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

export interface SteerReadInput {
	/** The queue entry id; the outcome rows the queue writes later join on it. */
	ref: string;
	text: string;
	chosen: "next-slot" | "end-of-turn";
	/** 1-based place in the queue at enqueue time, and the queue's length then. */
	position: number;
	queued: number;
	/** The assistant's latest text when the message was queued, or empty. */
	previous: string;
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
	/**
	 * `interpretation()` once this turn's reading has landed, or after
	 * `maxWaitMs`, or when `signal` aborts, whichever comes first. Returns at
	 * once when no reading is in flight: the site is unbound or shadowed, or the
	 * reading already settled.
	 */
	awaitInterpretation(maxWaitMs: number, signal: AbortSignal): Promise<TurnInterpretation | undefined>;
	/** The worker a confident forecast says the agent is about to dispatch, or null. */
	prewarm(): TurnPrewarmPrediction | null;
	/** Forget this turn's verdict, so a continuation or the next turn cannot read a stale one. */
	clearVerdict(): void;
	/** The task text of the last operator turn, for a catalog ranking asked for mid-turn. */
	task(): string;
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
	/**
	 * Read a message the operator queued during a run, detached, for the record.
	 * The steer site is experimental and record-only: delivery follows the
	 * operator's keys, and no reader takes this answer.
	 */
	readSteer(input: SteerReadInput): void;
	/** What followed a decision, joined to it by `ref`. */
	recordOutcome(outcome: {
		session?: string | null;
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

interface HeldTurn {
	id: string;
	task: string;
	verdict: Verdict<TurnValue> | null;
	/** The recipe `WORKER_PREPARE_SITE` picked once the reading predicted a dispatch. */
	recipe: string | null;
	/** Settles when the fitted reading is held or the call settled without one; null when nothing is in flight. */
	landed: Promise<void> | null;
	/** Whether this turn's prediction was already handed over. */
	predicted: boolean;
}

export function createSystemOneHost(deps: SystemOneHostDeps): SystemOneHost {
	const { systemOne } = deps;
	let turn: HeldTurn | null = null;
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

	function predictionOf(held: HeldTurn): TurnPrewarmPrediction | null {
		const value = held.verdict?.value;
		if (value === undefined || !value.acts.prewarm || held.recipe === null) return null;
		// A second held process only under a measured parallel reading; anything else is one.
		return { agentId: held.recipe, count: value.shape === "parallel" ? 2 : 1 };
	}

	function announcePrediction(held: HeldTurn): void {
		if (turn !== held || held.predicted) return;
		const prediction = predictionOf(held);
		if (prediction === null) return;
		held.predicted = true;
		try {
			deps.onPrediction?.(prediction);
		} catch {
			// A hold that cannot start leaves the dispatch to spawn its own worker.
		}
	}

	function interpretation(): TurnInterpretation | undefined {
		const value = turn?.verdict?.value;
		if (value === undefined) return undefined;
		return {
			intent: "unknown",
			// Automatic scouts stay off: an architecture reading is advice to the main agent.
			orientation: { wanted: false, breadth: null },
			direction: { requested: value.acts.direction },
			dispatch: { expected: value.acts.dispatch, ...(value.dispatch !== null ? { probability: value.dispatch } : {}) },
		};
	}

	return {
		readTurn(input) {
			const held: HeldTurn = {
				id: input.userTurnId,
				task: input.task,
				verdict: null,
				recipe: null,
				landed: null,
				predicted: false,
			};
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
			let previousTask = "";
			try {
				previousTask = input.previousTask();
			} catch {
				// An unreadable ledger costs the correction evidence, never the turn.
			}
			const object = { task: input.task, previous: input.previous, previousTask };
			if (shadow) {
				detached(() => systemOne.run(TURN_SITE, object, { ref: input.userTurnId }));
				return;
			}
			// Only the turn controller may wait for the reading, and never past the
			// site's deadline. Readers take it only from a fitted build. The operator's cancel does not abort it, because the reading is
			// still a record of the request.
			let markLanded: () => void = () => {};
			held.landed = new Promise<void>((resolve) => {
				markLanded = resolve;
			});
			detached(async () => {
				try {
					const verdict = await systemOne.run(TURN_SITE, object, { ref: input.userTurnId });
					if (turn === held && verdict !== null && verdict.fitted) held.verdict = verdict;
				} finally {
					// Released before the recipe follow-up, so a waiting controller never
					// waits for a second call.
					held.landed = null;
					markLanded();
				}
				const verdict = held.verdict;
				if (turn !== held || verdict === null || !verdict.value.acts.prewarm) return;
				// A chained call under its own deadline, so most turns spend no request here and
				// no reader ever waits for it.
				let recipes: ReadonlyArray<TurnRecipeOption> | null = null;
				try {
					recipes = deps.listRecipes();
				} catch {
					// Without recipes there is nothing to hold.
				}
				if (recipes === null || !systemOne.bound("workerPrepare")) return;
				const picked = await systemOne.run(WORKER_PREPARE_SITE, { ...object, recipes }, { ref: input.userTurnId });
				if (turn !== held) return;
				held.recipe = picked?.value.recipe ?? null;
				announcePrediction(held);
			});
		},

		hints: () => turn?.verdict?.value.hints ?? null,

		interpretation,

		async awaitInterpretation(maxWaitMs, signal) {
			const landed = turn?.landed ?? null;
			if (landed === null || signal.aborted || !(maxWaitMs > 0)) return interpretation();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let onAbort: (() => void) | undefined;
			try {
				await Promise.race([
					landed,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, maxWaitMs);
						onAbort = () => resolve();
						signal.addEventListener("abort", onAbort, { once: true });
					}),
				]);
			} finally {
				clearTimeout(timer);
				if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
			}
			return interpretation();
		},

		prewarm: () => (turn === null ? null : predictionOf(turn)),

		clearVerdict() {
			// A fresh record, so a reading still in flight lands in the one it was
			// started for and never in what the next continuation reads.
			if (turn !== null)
				turn = { id: turn.id, task: turn.task, verdict: null, recipe: null, landed: null, predicted: false };
		},

		task: () => turn?.task ?? "",

		forgetOperatorTexts() {
			operatorTexts = { session: null, seeded: false, turns: [] };
		},

		recordTurnEnd(input) {
			// No reader takes this answer, whatever its build: without recording it would only spend a request.
			if (!systemOne.bound("turnEnd") || !recordingOn()) return;
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
			if (!systemOne.bound("toolResult") || !recordingOn()) return;
			// The restrictions the result carries travel with the request, so the
			// engine's flow check refuses the classifier call before any byte
			// leaves: a restricted read is never redacted after being classified.
			detached(() => systemOne.run(TOOL_RESULT_SITE, { source, content }, runOptions(ref, restrictions)));
		},

		observeToolCallGate(subject, ref) {
			if (!systemOne.bound("toolCall") || !recordingOn()) return;
			detached(() => systemOne.run(TOOL_CALL_GATE_SITE, { ...subject, moment: "gate" }, runOptions(ref)));
		},

		readSteer(input) {
			if (!systemOne.bound("steer") || !recordingOn()) return;
			detached(() =>
				systemOne.run(
					STEER_SITE,
					{
						message: input.text,
						task: turn?.task ?? "",
						previous: input.previous,
						position: input.position,
						queued: input.queued,
						chosen: input.chosen,
					},
					{ ref: input.ref },
				),
			);
		},

		recordOutcome(outcome) {
			deps.usage.recorder.outcome({
				ref: outcome.ref,
				...(outcome.session !== undefined ? { session: outcome.session } : {}),
				source: outcome.source,
				at: new Date().toISOString(),
				facts: outcome.facts,
			});
		},
	};
}
