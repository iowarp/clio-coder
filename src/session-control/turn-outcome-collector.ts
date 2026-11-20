import { isReadOnlyCall } from "../core/read-only-calls.js";
import { ownerTelemetryContext, type TelemetryContext } from "../core/telemetry/context.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { SurfaceOutcome, SurfaceSettled } from "../core/telemetry/schemas.js";
import { ToolNames } from "../core/tool-names.js";
import { nextFiringId } from "../domains/middleware/fired-record.js";
import {
	type MiddlewareHookInput,
	type MiddlewareHookRegistration,
	READ_STREAK_REGISTRATION_ID,
	READ_STREAK_SERIAL_EVIDENCE,
	type ReadStreakObserver,
	type ReadStreakStep,
	SCOUT_NUDGE_REGISTRATION_ID,
} from "../domains/middleware/index.js";
import { hashToolCall } from "../domains/safety/loop-detector.js";
import type { TurnControlRecord, TurnOutcomeRecord } from "../domains/turn-control/index.js";
import { dispatchKeysFromArgs } from "../domains/turn-control/index.js";
import { effectiveToolCall } from "../tools/surface.js";

export interface CollectedTurn {
	readonly control: TurnOutcomeRecord["control"];
	readonly toolNames: ReadonlyArray<string>;
	readonly readOnlyCallsBeforeFirstDispatch: number;
	readonly dispatches: TurnOutcomeRecord["coordinator"]["dispatches"];
	readonly duplicateDispatch: boolean;
	readonly harness: TurnOutcomeRecord["harness"];
	readonly completion: TurnOutcomeRecord["completion"];
	readonly previousClarificationStreak: number;
	readonly exploration: NonNullable<TurnOutcomeRecord["exploration"]>;
}

/**
 * The ledger also hears the read-streak rule (exploration design 3.4, X4): each call it judged settles the rule's
 * notes and measures the turn, so the ledger and the rule never read a call two ways.
 */
export interface TurnOutcomeCollector extends MiddlewareHookRegistration, ReadStreakObserver {
	/** `current` is the id the turn runs under now: input queued mid-turn files its own user entry and moves it there. */
	take(userTurnId: string, current?: string | null): CollectedTurn;
	recordCompletion(
		turnId: string | null,
		decision: "ok" | "engage",
		mutatedPaths: number,
		evidenceKinds: ReadonlyArray<string>,
	): void;
	seedClarificationStreak(value: number): void;
	clarificationStreak(): number;
	recordControl(record: TurnControlRecord): void;
	/**
	 * Start the outcome ledger on `hub`: it reads the settling firings of the session `currentSession` names off their
	 * `middleware.fired` rows, and the loop guard's escalations, and writes one `surface.settled` per firing. A firing
	 * joins the ledger under that session even before any hook of its turn ran (memory design 4.1, 4.6). `held` names
	 * the firings whose effect still waits for a later request (a buffered reminder, an armed tool choice); at a turn's
	 * end every other firing no request carried settles `suppressed`. The returned stop settles every firing still
	 * open, as the session it belonged to is over.
	 */
	attachLedger(hub: TelemetryHub, currentSession: () => string | undefined, held: () => ReadonlySet<string>): () => void;
	/**
	 * A main request went out, journaled under `callId` or unjournaled (null). It admits the firings named in `carried`,
	 * whose effects its composition holds, and the turn's own tool-hook firings, whose blocked result or tool choice
	 * rides the next request of their run. Nothing else waiting is admitted.
	 */
	requestSent(callId: string | null, carried: ReadonlyArray<string>): void;
	/** These firings' effects never entered a request (a spent nudge, a released buffer, an ended turn). */
	suppressFirings(firingIds: ReadonlyArray<string>): void;
	/**
	 * Settle one steering triage round of either route (memory design 4.5), which acts on the queue rather than through
	 * a request: `acted` when a verdict's relabel or interrupt applied to the queued message `applied`, `expired` when
	 * the queue moved on before it could. A round with no verdict, or no session, fired nothing.
	 */
	settleTriage(sessionId: string | undefined, verdicts: ReadonlyArray<unknown>, applied: string | null): void;
}

type SettlementFact = SurfaceSettled["fact"];

/**
 * An exploration note's own settlement (exploration design 3.4, X4). A ladder note (`streak`) is acted on by a call
 * that resets the streak and ignored after {@link NOTE_IGNORED_AFTER_READS} more reads; a serial-round note is acted
 * on by a round with two or more reads, ignored after {@link NOTE_IGNORED_AFTER_ROUNDS} rounds without one, and moot
 * when the streak resets first. Either is moot at a fold or when its turn ends. A scout-survey note is acted on by a
 * dispatch that starts later in its turn and ignored when the turn ends without one.
 */
interface NoteSettlement {
	rule: "streak" | "serial" | "survey";
	/** Read-class calls since the request that carried the note. */
	reads: number;
	/** Rounds since that request with at least one judged call. */
	rounds: number;
	/** Judged calls and reads in the round now running. */
	roundCalls: number;
	roundReads: number;
}

const NOTE_IGNORED_AFTER_READS = 10;
const NOTE_IGNORED_AFTER_ROUNDS = 3;

/** A settling firing the ledger has not settled yet (memory design 4.1). */
interface OpenFiring {
	firingId: string;
	surface: string;
	/** A block settles `recovered` or `exhausted`; anything else that settles is a nudge, `acted` or `ignored`. */
	kind: "nudge" | "block";
	/** Fired by a tool hook: its effect rides the next request of its own run, or none. */
	inRun: boolean;
	sessionId: string;
	turnId?: string;
	/** The blocked call's identity: its own later success is not a recovery. */
	identity?: string;
	admittedIn: string | null;
	/** Admission order, so a fact credits the most recently admitted claimant; null until a request carries it. */
	admitted: number | null;
	/** A block's credited fact, held to the turn's end so a lockout of the same turn can still exhaust it. */
	credit?: SettlementFact;
	/** The loop guard escalation that ended the turn's tool use, when one did. */
	exhausted?: string;
	/** Set for an exploration note, which settles by its own rule rather than by the shared credit. */
	note?: NoteSettlement;
}

const IDENTITY_LIMIT = 64;

/** A call's identity for recovery: the call it runs (a gateway call's capability) hashed as the loop guard hashes it. */
function callIdentity(input: MiddlewareHookInput): string {
	const call = effectiveToolCall(input.toolName ?? "", input.toolArgs, input.toolResultDetails);
	return hashToolCall(call.toolName, call.args ?? {});
}

/**
 * The typed fact a succeeded call states for settlement: a `finish` declaration, a check's receipt, or a non-read
 * call's receipt. A read, a failed call and reply text state none (memory design 4.1).
 */
function callFact(
	toolName: string,
	args: Readonly<Record<string, unknown>> | undefined,
): SettlementFact["kind"] | null {
	if (toolName === ToolNames.Finish) return "declaration";
	if (toolName === ToolNames.Verify) return "receipt";
	return isReadOnlyCall(toolName, args) ? null : "receipt";
}

function emptyTurn(previousClarificationStreak: number): CollectedTurn {
	return {
		control: null,
		toolNames: [],
		readOnlyCallsBeforeFirstDispatch: 0,
		dispatches: [],
		duplicateDispatch: false,
		harness: { runIds: [], reads: 0 },
		completion: { decision: "not-assessed", mutatedPaths: 0, evidenceKinds: [] },
		previousClarificationStreak,
		exploration: { maxReadStreak: 0, serialRounds: 0, notes: 0 },
	};
}

function noteRule(ruleId: string, evidence: string | undefined): NoteSettlement["rule"] | null {
	if (ruleId === SCOUT_NUDGE_REGISTRATION_ID) return "survey";
	if (ruleId !== READ_STREAK_REGISTRATION_ID) return null;
	return evidence === READ_STREAK_SERIAL_EVIDENCE ? "serial" : "streak";
}

function dispatchRuns(details: MiddlewareHookInput["toolResultDetails"]): { agentIds: string[]; runIds: string[] } {
	const runs = Array.isArray(details?.runs) ? details.runs : [];
	return {
		agentIds: runs.flatMap((run: unknown) =>
			run !== null && typeof run === "object" && "agentId" in run && typeof run.agentId === "string" ? [run.agentId] : [],
		),
		runIds: runs.flatMap((run: unknown) =>
			typeof run === "string"
				? [run]
				: run !== null && typeof run === "object" && "runId" in run && typeof run.runId === "string"
					? [run.runId]
					: [],
		),
	};
}

/** `dispatch {list:true}` reads the fleet roster and launches nothing, so it is not a dispatch. */
function isDispatchListing(args: Readonly<Record<string, unknown>> | undefined): boolean {
	return args?.list === true;
}

export function createTurnOutcomeCollector(): TurnOutcomeCollector {
	let previousClarificationStreak = 0;
	let active = emptyTurn(0);
	let userTurnId: string | null = null;
	let assistantTurnId: string | null = null;
	let sessionId: string | undefined;
	let dispatched = false;
	const succeededKeys = new Set<string>();
	const harnessReads = new Map<string, number>();
	// --- outcome ledger (memory design 4.1, 4.6) ---
	let hub: TelemetryHub | null = null;
	let currentSession: () => string | undefined = () => undefined;
	let held: () => ReadonlySet<string> = () => new Set();
	const open = new Map<string, OpenFiring>();
	const identities = new Map<string, string>();
	let admissions = 0;
	/** The loop guard escalation that ended this turn's tool use, if one did. */
	let turnExhausted: string | null = null;
	const settle = (firing: OpenFiring, outcome: SurfaceOutcome, fact: SettlementFact): void => {
		if (!open.delete(firing.firingId)) return;
		const ctx: TelemetryContext | undefined = ownerTelemetryContext({
			sessionId: firing.sessionId,
			...(firing.turnId !== undefined ? { turnId: firing.turnId } : {}),
		});
		hub?.emit(
			"surface.settled",
			{ firingId: firing.firingId, surface: firing.surface, admittedIn: firing.admittedIn, outcome, fact },
			ctx,
		);
	};
	/**
	 * A firing whose turn is over: a block by how its turn ended, a nudge `ignored` for want of a typed fact. A streak
	 * note whose turn ended first is moot: the turn's end, not the model, closed the streak it asked about.
	 */
	const settleEnded = (firing: OpenFiring): void => {
		if (firing.note !== undefined && firing.note.rule !== "survey") settle(firing, "moot", { kind: "scope-end" });
		else if (firing.kind === "block" && firing.exhausted !== undefined)
			settle(firing, "exhausted", { kind: "scope-end", ref: firing.exhausted });
		else if (firing.kind === "block" && firing.credit !== undefined) settle(firing, "recovered", firing.credit);
		else settle(firing, "ignored", { kind: "none" });
	};
	/**
	 * The admitted firings settle with the turn that carried them. A firing no request carried before its turn ended
	 * never enters one unless its effect still waits in the buffer for the next request (a delayed nudge): a block is
	 * exhausted when the turn's tool use ended, and every other one is suppressed. A later turn's request carries none.
	 */
	const endTurn = (): void => {
		const waiting = held();
		for (const firing of [...open.values()]) {
			if (firing.admitted !== null) settleEnded(firing);
			else if (firing.kind === "block" && firing.exhausted !== undefined)
				settle(firing, "exhausted", { kind: "scope-end", ref: firing.exhausted });
			else if (!waiting.has(firing.firingId)) settle(firing, "suppressed", { kind: "none" });
		}
		turnExhausted = null;
	};
	/** A session is over: nothing it left waiting can enter a request now. */
	const closeSession = (): void => {
		for (const firing of [...open.values()]) {
			if (firing.admitted !== null) settleEnded(firing);
			else if (firing.kind === "block" && firing.exhausted !== undefined)
				settle(firing, "exhausted", { kind: "scope-end", ref: firing.exhausted });
			else settle(firing, "suppressed", { kind: "none" });
		}
		identities.clear();
		turnExhausted = null;
	};
	/** The collector now follows `id`: what the earlier session left open settles with it. */
	const enterSession = (id: string): void => {
		if (id === sessionId) return;
		closeSession();
		succeededKeys.clear();
		harnessReads.clear();
		sessionId = id;
	};
	/**
	 * Whether a ledger event belongs to this loop's session: the one it runs now, known from the loop rather than from a
	 * later hook, so a firing before the first turn's hooks (an awaited turn_start, a compaction) still joins it. A
	 * worker's forwarded event belongs to its run, and an event with no session to none of this loop's requests.
	 */
	const ownSession = (ctx: TelemetryContext | undefined): ctx is TelemetryContext & { sessionId: string } => {
		if (ctx?.runId !== undefined || !ctx?.sessionId) return false;
		const current = currentSession() ?? sessionId;
		if (current === undefined || ctx.sessionId !== current) return false;
		enterSession(current);
		return true;
	};
	/**
	 * One terminal fact credits one firing: the most recently admitted claimant. Every other claimant of the same fact
	 * settles `moot`. A block never claims its own call's later success.
	 */
	const credit = (fact: SettlementFact, identity: string): void => {
		const claimants = [...open.values()].filter(
			(firing) =>
				firing.admitted !== null &&
				firing.note === undefined &&
				(firing.kind === "nudge" ||
					(firing.credit === undefined && firing.exhausted === undefined && firing.identity !== identity)),
		);
		let winner: OpenFiring | undefined;
		for (const firing of claimants)
			if (winner === undefined || (firing.admitted ?? 0) >= (winner.admitted ?? 0)) winner = firing;
		for (const firing of claimants) {
			if (firing !== winner) settle(firing, "moot", fact);
			else if (firing.kind === "nudge") settle(firing, "acted", fact);
			else firing.credit = fact;
		}
	};
	/** The admitted exploration notes of `owner`'s session that settle by `rules`. */
	const openNotes = (owner: string | undefined, ...rules: ReadonlyArray<NoteSettlement["rule"]>): OpenFiring[] =>
		[...open.values()].filter(
			(firing) =>
				firing.admitted !== null &&
				firing.sessionId === owner &&
				firing.note !== undefined &&
				rules.includes(firing.note.rule),
		);
	/** One call the read-streak rule judged, against the notes the model has seen (exploration design 3.4). */
	const settleNotes = (step: Extract<ReadStreakStep, { kind: "call" }>): void => {
		const ref = step.toolCallId !== undefined ? { ref: step.toolCallId } : {};
		const fact: SettlementFact =
			step.toolName === ToolNames.Finish ? { kind: "declaration", ...ref } : { kind: "receipt", ...ref };
		for (const firing of openNotes(step.sessionId, "streak", "serial")) {
			const note = firing.note as NoteSettlement;
			if (step.effect === "progress") {
				settle(firing, note.rule === "streak" ? "acted" : "moot", fact);
				continue;
			}
			note.roundCalls += 1;
			if (step.effect !== "read") continue;
			note.reads += 1;
			note.roundReads += 1;
			if (note.rule === "serial" && note.roundReads >= 2) settle(firing, "acted", fact);
			else if (note.rule === "streak" && note.reads >= NOTE_IGNORED_AFTER_READS)
				settle(firing, "ignored", { kind: "none" });
		}
	};
	/** A request went out: the round the model answered the last one with is over. */
	const closeRounds = (): void => {
		for (const firing of open.values()) {
			const note = firing.note;
			if (note?.rule !== "serial" || firing.admitted === null) continue;
			if (note.roundCalls > 0) note.rounds += 1;
			note.roundCalls = 0;
			note.roundReads = 0;
			if (note.rounds >= NOTE_IGNORED_AFTER_ROUNDS) settle(firing, "ignored", { kind: "none" });
		}
	};
	const onFired = (
		payload: { firingId?: string; hook: string; ruleId: string; effects: ReadonlyArray<string>; evidence?: string },
		ctx: TelemetryContext | undefined,
	): void => {
		if (payload.firingId === undefined || !ownSession(ctx)) return;
		const rule = noteRule(payload.ruleId, payload.evidence);
		const block = payload.effects.includes("block_tool");
		const identity = block && ctx.toolCallId !== undefined ? identities.get(ctx.toolCallId) : undefined;
		const firing: OpenFiring = {
			firingId: payload.firingId,
			surface: payload.ruleId,
			kind: block ? "block" : "nudge",
			inRun: payload.hook === "before_tool" || payload.hook === "after_tool",
			sessionId: ctx.sessionId,
			...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
			...(identity !== undefined ? { identity } : {}),
			admittedIn: null,
			admitted: null,
			...(block && turnExhausted !== null ? { exhausted: turnExhausted } : {}),
			...(rule !== null ? { note: { rule, reads: 0, rounds: 0, roundCalls: 0, roundReads: 0 } } : {}),
		};
		// A further block of the same call takes back a recovery an earlier block was credited with.
		if (identity !== undefined)
			for (const earlier of open.values()) if (earlier.identity === identity) delete earlier.credit;
		open.set(firing.firingId, firing);
		// An observe-only compaction point discards every effect, so none can enter a request.
		if (payload.hook === "on_compaction") settle(firing, "suppressed", { kind: "none" });
	};
	/** A lockout, a stop or a crossed tool budget of this session ends the turn's tool use: its blocks cannot recover now. */
	const onExhausted = (event: string, ctx: TelemetryContext | undefined): void => {
		if (!ownSession(ctx)) return;
		turnExhausted ??= event;
		for (const firing of open.values()) if (firing.kind === "block") firing.exhausted ??= event;
	};
	return {
		id: "observer.turn-outcome",
		description: "collect host facts for the operator turn without steering it",
		hooks: ["turn_start", "before_tool", "after_tool", "turn_end"],
		evidence: "observer:turn-outcome@turn",
		clarificationStreak: () => previousClarificationStreak,
		attachLedger(target, session, waiting) {
			hub = target;
			currentSession = session;
			held = waiting;
			const stops = [
				target.subscribe("middleware.fired", (payload, ctx) => onFired(payload, ctx)),
				target.subscribe("safety.loop_blocked", (payload, ctx) => {
					if (payload.disposition !== "block") onExhausted(`safety.loop_blocked:${payload.disposition}`, ctx);
				}),
				// A rolled crossing is a silent roll: its batch still runs, so the turn's tool use did not end.
				target.subscribe("safety.tool_budget_exceeded", (payload, ctx) => {
					if (payload.rolled !== true) onExhausted("safety.tool_budget_exceeded", ctx);
				}),
			];
			return () => {
				for (const stop of stops) stop();
				closeSession();
				if (hub === target) hub = null;
			};
		},
		requestSent(callId, carried) {
			closeRounds();
			const named = new Set(carried);
			let any = false;
			for (const firing of open.values()) {
				if (firing.admitted !== null || !(firing.inRun || named.has(firing.firingId))) continue;
				if (!any) admissions += 1;
				any = true;
				firing.admitted = admissions;
				firing.admittedIn = callId;
			}
		},
		suppressFirings(firingIds) {
			for (const id of firingIds) {
				const firing = open.get(id);
				if (firing !== undefined && firing.admitted === null) settle(firing, "suppressed", { kind: "none" });
			}
		},
		settleTriage(owner, verdicts, applied) {
			if (hub === null || owner === undefined || verdicts.length === 0) return;
			const firing: OpenFiring = {
				firingId: nextFiringId(),
				surface: "triage",
				kind: "nudge",
				inRun: false,
				sessionId: owner,
				admittedIn: null,
				admitted: null,
			};
			open.set(firing.firingId, firing);
			if (applied === null) settle(firing, "expired", { kind: "none" });
			else settle(firing, "acted", { kind: "receipt", ref: applied });
		},
		recordControl(record) {
			userTurnId = record.turnId;
			// A refused act may still have started workers; those runs belong to the turn.
			const runIds =
				record.executed === null
					? []
					: "runIds" in record.executed
						? record.executed.runIds
						: (record.executed.startedRunIds ?? []);
			active = {
				...active,
				control: {
					decision: record.decision.kind,
					decisionHash: record.decisionHash,
					executed: record.executed !== null && "runIds" in record.executed,
				},
				harness: {
					...active.harness,
					reads: harnessReads.get(record.turnId) ?? active.harness.reads,
					runIds: [...active.harness.runIds, ...runIds],
				},
			};
			harnessReads.delete(record.turnId);
		},
		observeReadStreak(step) {
			if (step.kind === "fold") {
				// The results the note pointed at may be gone, so what follows no longer answers it.
				for (const firing of openNotes(step.sessionId, "streak", "serial")) settle(firing, "moot", { kind: "fold" });
				return;
			}
			const measured = active.exploration;
			active = {
				...active,
				exploration: {
					maxReadStreak: Math.max(measured.maxReadStreak, step.reads),
					serialRounds: measured.serialRounds + step.serialRounds,
					notes: measured.notes + (step.note !== null ? 1 : 0),
				},
			};
			settleNotes(step);
		},
		seedClarificationStreak(value) {
			previousClarificationStreak = value;
		},
		take(id, current) {
			const result =
				userTurnId === null || userTurnId === id || userTurnId === current
					? active
					: emptyTurn(previousClarificationStreak);
			active = emptyTurn(previousClarificationStreak);
			userTurnId = null;
			assistantTurnId = null;
			dispatched = false;
			return result;
		},
		recordCompletion(id, decision, mutatedPaths, evidenceKinds) {
			if (id !== null && (id === assistantTurnId || id === userTurnId)) {
				active = { ...active, completion: { decision, mutatedPaths, evidenceKinds: [...evidenceKinds] } };
			}
		},
		evaluate(input) {
			if (input.sessionId !== undefined) enterSession(input.sessionId);
			if (input.hook === "turn_start") {
				// A turn that ended without a turn_end hook still ended; what it carried settles before this one starts.
				endTurn();
				active = emptyTurn(previousClarificationStreak);
				userTurnId = input.turnId ?? null;
				assistantTurnId = null;
				dispatched = false;
				return [];
			}
			if (input.hook === "turn_end") {
				if (typeof input.metadata?.userTurnId === "string") userTurnId = input.metadata.userTurnId;
				assistantTurnId = input.turnId ?? null;
				endTurn();
				return [];
			}
			if (input.metadata?.nested === true) return [];
			if (input.turnId !== undefined) userTurnId = input.turnId;
			const call = effectiveToolCall(input.toolName ?? "", input.toolArgs, input.toolResultDetails);
			const toolName = call.toolName;
			const args = call.args;
			if (input.metadata?.origin === "harness") {
				if (input.hook !== "after_tool") return [];
				if (toolName !== ToolNames.Dispatch && input.turnId !== undefined) {
					// S7: observations precede turn_start; retain them under the reserved user id.
					if (harnessReads.size >= 32 && !harnessReads.has(input.turnId)) {
						const oldest = harnessReads.keys().next().value;
						if (oldest !== undefined) harnessReads.delete(oldest);
					}
					harnessReads.set(input.turnId, (harnessReads.get(input.turnId) ?? 0) + 1);
				}
				active = {
					...active,
					harness:
						toolName === ToolNames.Dispatch
							? { ...active.harness, runIds: [...active.harness.runIds, ...dispatchRuns(input.toolResultDetails).runIds] }
							: { ...active.harness, reads: active.harness.reads + 1 },
				};
				return [];
			}
			if (input.hook === "before_tool") {
				if (input.toolCallId !== undefined) {
					if (identities.size >= IDENTITY_LIMIT) {
						const oldest = identities.keys().next().value;
						if (oldest !== undefined) identities.delete(oldest);
					}
					identities.set(input.toolCallId, callIdentity(input));
				}
				active = { ...active, toolNames: [...active.toolNames, toolName] };
				if (toolName === ToolNames.Dispatch) dispatched ||= !isDispatchListing(args);
				else if (!dispatched && isReadOnlyCall(toolName, args)) {
					active = { ...active, readOnlyCallsBeforeFirstDispatch: active.readOnlyCallsBeforeFirstDispatch + 1 };
				}
			} else if (input.hook === "after_tool" && input.metadata?.resultKind === "ok" && input.toolName !== undefined) {
				const kind = callFact(toolName, args);
				if (kind !== null)
					credit({ kind, ...(input.toolCallId !== undefined ? { ref: input.toolCallId } : {}) }, callIdentity(input));
			}
			if (input.hook === "after_tool" && toolName === ToolNames.Dispatch && !isDispatchListing(args)) {
				// A dispatch whose worker failed or was aborted still launched a run
				// and spent worker tokens; tokens.workers is built from these run ids.
				// Only a successful dispatch can make a later identical one a duplicate.
				const succeeded = input.metadata?.resultKind === "ok";
				const runs = dispatchRuns(input.toolResultDetails);
				if (!succeeded && runs.runIds.length === 0) return [];
				// A dispatch that started answers the scout-survey note the model saw earlier in this turn.
				for (const firing of openNotes(input.sessionId ?? sessionId, "survey"))
					settle(firing, "acted", {
						kind: "receipt",
						...(input.toolCallId !== undefined ? { ref: input.toolCallId } : {}),
					});
				const keys = dispatchKeysFromArgs(args).map((key) => JSON.stringify([key.agentId, key.task]));
				const duplicateDispatch = succeeded && keys.some((key) => succeededKeys.has(key));
				if (succeeded) for (const key of keys) succeededKeys.add(key);
				active = {
					...active,
					duplicateDispatch: active.duplicateDispatch || duplicateDispatch,
					dispatches: [
						...active.dispatches,
						{
							mode:
								typeof input.toolResultDetails?.mode === "string"
									? input.toolResultDetails.mode
									: typeof args?.mode === "string"
										? args.mode
										: "pipeline",
							agentIds: runs.agentIds.length > 0 ? runs.agentIds : dispatchKeysFromArgs(args).map((key) => key.agentId),
							runIds: runs.runIds,
							...(succeeded ? {} : { failed: true as const }),
						},
					],
				};
			}
			return [];
		},
	};
}
