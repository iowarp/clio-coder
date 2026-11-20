import { isReadOnlyCall } from "../core/read-only-calls.js";
import { ownerTelemetryContext, type TelemetryContext } from "../core/telemetry/context.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { SurfaceOutcome, SurfaceSettled } from "../core/telemetry/schemas.js";
import { ToolNames } from "../core/tool-names.js";
import { nextFiringId } from "../domains/middleware/fired-record.js";
import type { MiddlewareHookInput, MiddlewareHookRegistration } from "../domains/middleware/index.js";
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
}

export interface TurnOutcomeCollector extends MiddlewareHookRegistration {
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
	 * Start the outcome ledger on `hub`: it reads this session's settling firings off their `middleware.fired` rows and
	 * the loop guard's escalations, and writes one `surface.settled` per firing. The returned stop settles every firing
	 * still open, as the session it belonged to is over (memory design 4.1, 4.6).
	 */
	attachLedger(hub: TelemetryHub): () => void;
	/** A main request was sent: every firing waiting for admission rode it. */
	requestSent(callId: string): void;
	/** These firings' effects never entered a request (a spent nudge, a released buffer, an ended turn). */
	suppressFirings(firingIds: ReadonlyArray<string>): void;
	/**
	 * Settle a host surface that fires and settles in one step, such as steering triage, which acts on the queue rather
	 * than through a request. Returns the firing id, or null with no ledger attached.
	 */
	settleHostFiring(
		sessionId: string,
		surface: string,
		outcome: SurfaceOutcome,
		fact: SurfaceSettled["fact"],
	): string | null;
}

type SettlementFact = SurfaceSettled["fact"];

/** A settling firing the ledger has not settled yet (memory design 4.1). */
interface OpenFiring {
	firingId: string;
	surface: string;
	/** A block settles `recovered` or `exhausted`; anything else that settles is a nudge, `acted` or `ignored`. */
	kind: "nudge" | "block";
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
	/** The turn it fired in has ended, so an exhausted block settles as soon as a request carries it. */
	turnOver?: true;
}

const IDENTITY_LIMIT = 64;

/** A call's identity for recovery: the tool as called and its arguments as sent. */
function callIdentity(input: MiddlewareHookInput): string {
	return `${input.toolName ?? ""}\u0000${JSON.stringify(input.toolArgs ?? {})}`;
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
	};
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
	/** A firing whose turn is over: a block by how its turn ended, a nudge `ignored` for want of a typed fact. */
	const settleEnded = (firing: OpenFiring): void => {
		if (firing.kind === "block" && firing.exhausted !== undefined)
			settle(firing, "exhausted", { kind: "scope-end", ref: firing.exhausted });
		else if (firing.kind === "block" && firing.credit !== undefined) settle(firing, "recovered", firing.credit);
		else settle(firing, "ignored", { kind: "none" });
	};
	/** The admitted firings settle with the turn that carried them; an exhausted block waits only for its request. */
	const endTurn = (): void => {
		for (const firing of [...open.values()]) {
			if (firing.admitted !== null) settleEnded(firing);
			else if (firing.exhausted !== undefined) firing.turnOver = true;
		}
		turnExhausted = null;
	};
	/** A session is over: nothing it left waiting can enter a request now. */
	const closeSession = (): void => {
		for (const firing of [...open.values()]) {
			if (firing.admitted !== null || firing.exhausted !== undefined) settleEnded(firing);
			else settle(firing, "suppressed", { kind: "none" });
		}
		identities.clear();
		turnExhausted = null;
	};
	/**
	 * One terminal fact credits one firing: the most recently admitted claimant. Every other claimant of the same fact
	 * settles `moot`. A block never claims its own call's later success.
	 */
	const credit = (fact: SettlementFact, identity: string): void => {
		const claimants = [...open.values()].filter(
			(firing) =>
				firing.admitted !== null &&
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
	const onFired = (
		payload: { firingId?: string; hook: string; ruleId: string; effects: ReadonlyArray<string> },
		ctx: TelemetryContext | undefined,
	): void => {
		// A worker's forwarded firings belong to its run, not to this session's requests.
		if (payload.firingId === undefined || ctx?.runId !== undefined || !ctx?.sessionId || ctx.sessionId !== sessionId)
			return;
		const block = payload.effects.includes("block_tool");
		const identity = block && ctx.toolCallId !== undefined ? identities.get(ctx.toolCallId) : undefined;
		const firing: OpenFiring = {
			firingId: payload.firingId,
			surface: payload.ruleId,
			kind: block ? "block" : "nudge",
			sessionId: ctx.sessionId,
			...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
			...(identity !== undefined ? { identity } : {}),
			admittedIn: null,
			admitted: null,
			...(block && turnExhausted !== null ? { exhausted: turnExhausted } : {}),
		};
		// A further block of the same call takes back a recovery an earlier block was credited with.
		if (identity !== undefined)
			for (const earlier of open.values()) if (earlier.identity === identity) delete earlier.credit;
		open.set(firing.firingId, firing);
		// An observe-only compaction point discards every effect, so none can enter a request.
		if (payload.hook === "on_compaction") settle(firing, "suppressed", { kind: "none" });
	};
	/** A lockout, a stop or a crossed tool budget ends the turn's tool use: its blocks cannot recover now. */
	const onExhausted = (event: string, ctx: TelemetryContext | undefined): void => {
		if (ctx?.runId !== undefined || (ctx?.sessionId != null && ctx.sessionId !== sessionId)) return;
		turnExhausted ??= event;
		for (const firing of open.values()) if (firing.kind === "block") firing.exhausted ??= event;
	};
	return {
		id: "observer.turn-outcome",
		description: "collect host facts for the operator turn without steering it",
		hooks: ["turn_start", "before_tool", "after_tool", "turn_end"],
		evidence: "observer:turn-outcome@turn",
		clarificationStreak: () => previousClarificationStreak,
		attachLedger(target) {
			hub = target;
			const stops = [
				target.subscribe("middleware.fired", (payload, ctx) => onFired(payload, ctx)),
				target.subscribe("safety.loop_blocked", (payload, ctx) => {
					if (payload.disposition !== "block") onExhausted(`safety.loop_blocked:${payload.disposition}`, ctx);
				}),
				target.subscribe("safety.tool_budget_exceeded", (_payload, ctx) => onExhausted("safety.tool_budget_exceeded", ctx)),
			];
			return () => {
				for (const stop of stops) stop();
				closeSession();
				if (hub === target) hub = null;
			};
		},
		requestSent(callId) {
			let carried = false;
			for (const firing of [...open.values()]) {
				if (firing.admitted !== null) continue;
				if (!carried) admissions += 1;
				carried = true;
				firing.admitted = admissions;
				firing.admittedIn = callId;
				if (firing.turnOver === true) settleEnded(firing);
			}
		},
		suppressFirings(firingIds) {
			for (const id of firingIds) {
				const firing = open.get(id);
				if (firing !== undefined && firing.admitted === null) settle(firing, "suppressed", { kind: "none" });
			}
		},
		settleHostFiring(owner, surface, outcome, fact) {
			if (hub === null) return null;
			const firingId = nextFiringId(owner);
			const firing: OpenFiring = { firingId, surface, kind: "nudge", sessionId: owner, admittedIn: null, admitted: null };
			open.set(firingId, firing);
			settle(firing, outcome, fact);
			return firingId;
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
			if (input.sessionId !== undefined && input.sessionId !== sessionId) {
				closeSession();
				succeededKeys.clear();
				harnessReads.clear();
				sessionId = input.sessionId;
			}
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
