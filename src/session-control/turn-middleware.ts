/**
 * Middleware turn hooks for the chat loop: turn_start / turn_end /
 * on_compaction dispatch, the pending-reminder buffer that flushes into the
 * next request, hard-block interrupts, and the stalled-turn continuation
 * nudge. Owns every `deps.middleware` interaction of the loop.
 */

import { runtimeModelField } from "../core/model-tier.js";
import { systemReminderBlock } from "../core/reminder-framing.js";
import { ownerTelemetryContext } from "../core/telemetry/context.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import { normalizeTokenUsage } from "../core/token-split.js";
import { ToolNames } from "../core/tool-names.js";
import { turnAllowsContinuation, turnAllowsTool } from "../core/turn-constraints.js";
import { turnOriginMetadata } from "../core/turn-origin.js";
import {
	type CompletionFact,
	MIDDLEWARE_HOOK_TEXT_MAX_CHARS,
	type MiddlewareContract,
	type MiddlewareEffect,
	type MiddlewareHookInput,
	type MiddlewareHookResult,
	type MiddlewareMetadataValue,
	type MiddlewareReminderSeverity,
	type MiddlewareToolChoiceControl,
} from "../domains/middleware/index.js";
import { STALLED_TURN_REQUEST_CONTINUATION_MESSAGE } from "../domains/middleware/stalled-turn.js";
import { withPluginDiscoveryPass } from "../domains/plugins/index.js";
import {
	FINISH_CONTRACT_ADVISORY_MESSAGE,
	FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE,
	FINISH_CONTRACT_DECLARED_CHECKS_PREFIX,
	FINISH_CONTRACT_EVIDENCE_SCOPE_ADVISORY_MESSAGE,
	FINISH_CONTRACT_FAILED_CHECK_ADVISORY_MESSAGE,
	FINISH_CONTRACT_RAN_CHANGED_PREFIX,
	FINISH_CONTRACT_RUN_CHECKS_PREFIX,
} from "../domains/safety/finish-contract.js";
import type { SessionContract } from "../domains/session/contract.js";
import type {
	CompactionTrigger,
	EvictionTrigger,
	HostInsertSource,
	RecallTrigger,
} from "../domains/session/entries.js";
import type { AgentMessage } from "../engine/types.js";
import { sealCompletion } from "../tools/finish.js";
import type { ToolBoundaryReminder, ToolRegistry } from "../tools/registry.js";
import { extractText, hasStructuredToolCall, toolNamesFromAgentState } from "./chat-loop-messages.js";
import type { HostInserts } from "./host-inserts.js";
import type { NoticeSource } from "./notice-source.js";
import type { AgentRuntime, TurnMiddlewareState } from "./turn-state.js";

export interface TurnMiddlewareDeps {
	memoryContentGuard?: ((content?: string) => () => boolean) | undefined;
	state: TurnMiddlewareState;
	middleware?: MiddlewareContract | undefined;
	toolRegistry?: ToolRegistry | undefined;
	session?: SessionContract | undefined;
	/** Writes the deferred reminder tail durably before it joins the live history. */
	hostInserts?: HostInserts | undefined;
	middlewareToolChoice: MiddlewareToolChoiceControl;
	emitNotice: (text: string, level?: "info" | "warning" | "error", source?: NoticeSource) => void;
	emitFooterNotice: (level: "info" | "success" | "warning" | "error", text: string, key: string) => void;
	/**
	 * Show an operator-only message from a `notify_operator` effect, such as a
	 * capability tip. Absent, it becomes an info notice. Either way it never
	 * joins the reminder buffer, so the model does not see it.
	 */
	emitOperatorTip?: (message: string, key: string) => void;
	/** Journals a middleware failure that escaped the runtime, as `middleware.hook_failed`. */
	bus?: TelemetryHub | undefined;
	/**
	 * At turn_end of a step-policy turn, before it settles: whether a step continuation follows it, and the user row
	 * of the earlier turn that opened the step pipeline it continues (bt-12 #4). Null off a step-policy turn.
	 */
	stepTurnEnd?: () => { continues: boolean; startTurnId?: string } | null;
	/** Facts the host itself seals on every ended turn beside the middleware's, such as a headless run's spent observation pool (CLI-P42). */
	hostCompletionFacts?: () => CompletionFact[];
	/** The outputs the session's operator prompts named that do not exist at the seal (M-4): each is a `missing_output`. */
	missingOutputs?: () => string[];
	/**
	 * The settling firings whose effect never entered a request: a spent or declared-away continuation, a turn that
	 * errored or was aborted, a refused turn start, a released reminder buffer. The outcome ledger settles them
	 * `suppressed` (memory design 4.1).
	 */
	suppressFirings?: (firingIds: ReadonlyArray<string>) => void;
	/** Queues a host message for the next tool-batch boundary (`TurnQueues.queueHostMessage`); false when not queued. */
	queueHostMessage?: (text: string, source: HostInsertSource, rule?: string) => boolean;
}

/** The admitted awaited turn_start phase's effects, each settling effect mapped to its firing. */
export interface AwaitedTurnStart {
	readonly effects: ReadonlyArray<MiddlewareEffect>;
	readonly firings: ReadonlyMap<MiddlewareEffect, string>;
}

/** What a sealed fact still leaves open, in plain words, when no continuation note names it. */
const COMPLETION_FACT_NOTES: Record<CompletionFact, string> = {
	unvalidated_mutation: "the change has no validation evidence yet",
	failed_check: "a check failed after the last change",
	uncollected_run: "detached runs are still uncollected",
	open_task: "tasks are still open",
	observation_budget: "the observation pool refused the last reads, so what they would return was not read",
	missing_output: "a file the operator asked for does not exist",
};

/** The awaited turn_start phase's answer: the turn's refusal, or the effects an admitted turn applies. */
export type TurnStartGate = { refusal: string } | ({ refusal: null } & AwaitedTurnStart);

export interface TurnMiddleware {
	/** Async-only completed tool-batch observation and delivery of already-finished background reminders. */
	prepareToolContinuation(agentRuntime: AgentRuntime, signal?: AbortSignal): Promise<boolean>;
	/**
	 * `userTurnId` is the id the turn's user row is filed under; without it the
	 * turn already filed (an in-run continuation's) is the one that starts.
	 * `awaited` is the admitted awaited phase's answer, applied after this
	 * synchronous phase's own.
	 */
	fireTurnStart(
		agentRuntime: AgentRuntime,
		promptText: string,
		pendingSkillRequestCount?: number,
		requestContinuation?: boolean,
		userTurnId?: string,
		awaited?: AwaitedTurnStart,
	): void;
	/**
	 * The awaited turn_start phase for extension runtime hooks: the turn's gate,
	 * run before anything else the turn spends or buffers (an image sidecar
	 * call, turn control, the synchronous phase's reminders). It awaits nothing
	 * unless an awaited registration matches turn_start. A hard block_tool there
	 * is a closed gate refusing the turn: its reason comes back and no other
	 * effect of the phase applies. An admitted turn gets the phase's effects,
	 * which the caller hands to `fireTurnStart`.
	 */
	awaitTurnStart(
		agentRuntime: AgentRuntime,
		promptText: string,
		pendingSkillRequestCount?: number,
		userTurnId?: string,
	): Promise<TurnStartGate>;
	/**
	 * `pinFinishRound` says whether this turn's one pinned `finish` round would go out were the turn counted as work.
	 * Resolves true when the stalled-turn nudge yielded to that round (memory design 4.6, MD14): the caller then spends
	 * the round as if the turn had done work.
	 */
	fireTurnEnd(
		agentRuntime: AgentRuntime,
		messages: ReadonlyArray<AgentMessage>,
		terminalToolResult?: { toolCallId: string; toolName: string },
		pinFinishRound?: () => boolean,
	): Promise<boolean>;
	fireCompactionHook(
		stage:
			| "mask_observations"
			| "superseded"
			| "working_set_evict"
			| "working_set_recall"
			| "llm_summary"
			| "step_checkpoint",
		trigger: CompactionTrigger | EvictionTrigger | RecallTrigger,
		tokensBefore?: number,
	): void;
	flushPendingReminders(): string;
	/**
	 * Take the buffer for the turn's request. `leading` yields host-owned turn text that opens the block (turn scope,
	 * prompt delta). The taken reminders wait for that request: `requestCarried` when it goes out, or the submit's
	 * `releaseTurnHolds` when it ends without sending it.
	 */
	takePendingReminderProjection(leading?: () => readonly string[]): () => string;
	/**
	 * A submit starts holding effects for its requests: what an earlier submit still holds was abandoned with it and
	 * settles `suppressed`. The returned token releases this submit's holds and no later one's.
	 */
	beginTurnHolds(): number;
	/**
	 * The submit `token` began ended: what it held for a request that never went out (a taken buffer, an armed tool
	 * choice, a flushed continuation, an awaited gate's effects) never entered one. Buffered reminders stay for the next
	 * request.
	 */
	releaseTurnHolds(token: number): void;
	/**
	 * A main request went out: the settling firings whose effects it carries (the taken reminders its last composition
	 * held, an armed tool choice, a flushed continuation). A taken reminder the composition left out as no longer
	 * current never entered it and settles `suppressed`. Each firing is named once.
	 */
	requestCarried(): string[];
	/** The settling firings whose effect still waits for a request: buffered, taken, armed, flushed or gated. */
	heldFirings(): ReadonlySet<string>;
	clearPendingReminders(): void;
	/**
	 * Deliver a reminder produced after its own turn boundary already closed.
	 * Background observers that outlive a turn use this instead of a hook return
	 * value; the reminder joins the same buffer, ledger, and transcript path a
	 * turn_end reminder takes.
	 */
	injectDeferredReminder(
		message: string,
		severity?: MiddlewareReminderSeverity,
		isCurrent?: () => boolean,
		source?: NoticeSource,
	): void;
	/**
	 * Deliver an operator-facing finding produced after its turn boundary closed.
	 * The watchdog seam: its run settles well after the turn it reviewed, and
	 * what it found is for the person, not the model. Unlike a deferred
	 * reminder, this never joins the pending-reminder buffer and never appends a
	 * `middlewareReminder` entry, so nothing it says can enter the next request.
	 */
	emitDeferredNotice(text: string, level?: "info" | "warning", source?: NoticeSource): void;
	/**
	 * Reminders a synchronous after_tool rule emitted (X6): each becomes one host-framed `<system-reminder>` user
	 * message waiting for the next tool-batch boundary, where the turn runtime appends it to the outgoing context as a
	 * host insert (never through the engine's steering queue). It never interrupts a running tool.
	 */
	applyToolBoundaryReminders(reminders: ReadonlyArray<ToolBoundaryReminder>): void;
}

/** The transcript level of a reminder: advice informs, a warning or a hard stop warns. */
function reminderNoticeLevel(severity: MiddlewareReminderSeverity): "info" | "warning" {
	return severity === "warn" || severity === "hard-block" ? "warning" : "info";
}

interface PendingReminder {
	message: string;
	severity: MiddlewareReminderSeverity;
	deferred: boolean;
	isCurrent?: (() => boolean) | undefined;
	/** The settling firings this text carries; a firing no remaining entry carries never entered a request. */
	firingIds?: string[];
}

/** Each effect of a settling firing, mapped to that firing's id, by the order the runtime records them in. */
function firingsOf(result: MiddlewareHookResult): Map<MiddlewareEffect, string> {
	const owners = new Map<MiddlewareEffect, string>();
	let offset = 0;
	for (const rule of result.fired ?? []) {
		if (rule.firingId !== undefined)
			for (const effect of result.effects.slice(offset, offset + rule.effects.length)) owners.set(effect, rule.firingId);
		offset += rule.effects.length;
	}
	return owners;
}

const NO_HOOK_RESULT = { effects: [] as ReadonlyArray<MiddlewareEffect>, firings: new Map<MiddlewareEffect, string>() };

export function createTurnMiddleware(deps: TurnMiddlewareDeps): TurnMiddleware {
	const { state, middlewareToolChoice } = deps;
	// Internal availability includes admitted gateway capabilities. Keep the
	// attached names separate: prose detection needs the actual model surface.
	const activeCapabilityNames = (runtime: AgentRuntime): string => {
		const attached = toolNamesFromAgentState(runtime.agent.state.tools);
		const hidden = attached.includes(ToolNames.Gateway)
			? (deps.toolRegistry?.listGateway() ?? []).map((spec) => spec.name)
			: [];
		return [...new Set([...attached, ...hidden])]
			.filter((name) => turnAllowsTool(state.currentTurnConstraints, name))
			.join(",");
	};

	// Reminders accumulated from middleware `inject_reminder` effects
	// (turn_end advisories, hard-block recovery guidance, turn_start
	// injections). The next accepted prompt flushes them into the model
	// request as one system-reminder block. Completed background reminders
	// can also drain at a native tool-batch boundary; session switches clear all.
	const pendingReminders: PendingReminder[] = [];
	/** The reminders the last projection took, and the ones its latest composition carried, until its request goes out. */
	let taken: { entries: PendingReminder[]; carried: Set<PendingReminder> } | null = null;
	/** Settling firings whose effect is in place for the next main request: a tool choice, a flushed continuation. */
	const armed = new Set<string>();
	/** The awaited turn_start gate's firings, from the gate until fireTurnStart applies their effects. */
	const gated = new Set<string>();
	/** The submit whose holds these are; a release from any other is not this one's to make. */
	let holdToken = 0;
	const entryFirings = (entries: ReadonlyArray<PendingReminder>): string[] =>
		entries.flatMap((entry) => entry.firingIds ?? []);
	const heldFirings = (): Set<string> =>
		new Set([...entryFirings(pendingReminders), ...entryFirings(taken?.entries ?? []), ...armed, ...gated]);
	/** Settle `suppressed` the firings of `ids` whose effect nothing holds any longer. */
	const releaseFirings = (ids: ReadonlyArray<string>): void => {
		if (ids.length === 0) return;
		const held = heldFirings();
		const released = [...new Set(ids)].filter((id) => !held.has(id));
		if (released.length > 0) deps.suppressFirings?.(released);
	};
	/** Settle the taken reminders: those `kept` rode the request, whose firings it returns; the rest entered none. */
	const settleTaken = (kept: ReadonlySet<PendingReminder>): string[] => {
		if (taken === null) return [];
		const rode = new Set(entryFirings([...kept]));
		const dropped = entryFirings(taken.entries.filter((entry) => !kept.has(entry)));
		taken = null;
		// A firing whose reminder and continuation are separate entries entered the request if either did.
		releaseFirings(dropped.filter((id) => !rode.has(id)));
		return [...rode];
	};
	/** What the submits so far held for a request that never went out entered none; the buffer stays. */
	const abandonHeld = (): void => {
		const ids = [...armed, ...gated];
		armed.clear();
		gated.clear();
		settleTaken(new Set());
		releaseFirings(ids);
	};
	const dropStale = () => {
		const removed: PendingReminder[] = [];
		for (let index = pendingReminders.length - 1; index >= 0; index--) {
			if (pendingReminders[index]?.isCurrent?.() === false) removed.push(...pendingReminders.splice(index, 1));
		}
		releaseFirings(entryFirings(removed));
	};

	/** True when the message is in the buffer afterwards, its own entry or an identical one already there. */
	const bufferReminder = (
		message: string,
		severity: MiddlewareReminderSeverity,
		deferred = false,
		isCurrent?: () => boolean,
		firingId?: string,
	): boolean => {
		dropStale();
		// Memory text revalidates its own offer (cited facts, open failures) until the request carries it.
		isCurrent ??= message.startsWith("Memory:") ? deps.memoryContentGuard?.(message) : undefined;
		if (isCurrent?.() === false) return false;
		const existing = pendingReminders.find((entry) => entry.message === message && entry.severity === severity);
		if (existing !== undefined) {
			if (firingId !== undefined) existing.firingIds = [...(existing.firingIds ?? []), firingId];
			return true;
		}
		pendingReminders.push({
			message,
			severity,
			deferred,
			isCurrent,
			...(firingId !== undefined ? { firingIds: [firingId] } : {}),
		});
		return true;
	};

	// Per-registration throws are already isolated inside the runtime; anything escaping it is a runtime bug that
	// must not break the turn, so the turn continues without the hook's effects and the failure is reported the way
	// an isolated registration failure is: a journaled middleware.hook_failed and a warning notice.
	const reportHookFailure = (hook: MiddlewareHookInput["hook"], error: unknown): void => {
		const registrationId = "middleware.runtime";
		const message = error instanceof Error ? error.message : String(error);
		const sessionId = deps.session?.current()?.id;
		deps.bus?.emit(
			"middleware.hook_failed",
			{ kind: "hook_failed", registrationId, hook, at: Date.now(), message },
			...(sessionId === undefined ? [] : [ownerTelemetryContext({ sessionId })]),
		);
		deps.emitFooterNotice(
			"warning",
			`[middleware] Hook evaluation failed on ${hook}: ${message}. Its effects were skipped; the turn continued.`,
			`middleware:${registrationId}:${hook}:hook_failed`,
		);
	};

	const runMiddlewareTurnHook = (input: MiddlewareHookInput): typeof NO_HOOK_RESULT => {
		if (!deps.middleware) return NO_HOOK_RESULT;
		try {
			const result = deps.middleware.runHook(input);
			return { effects: result.effects, firings: firingsOf(result) };
		} catch (error) {
			reportHookFailure(input.hook, error);
			return NO_HOOK_RESULT;
		}
	};

	const runMiddlewareTurnHookAsync = async (
		input: MiddlewareHookInput,
		priorEffects: ReadonlyArray<MiddlewareEffect>,
	): Promise<typeof NO_HOOK_RESULT> => {
		if (!deps.middleware?.runAsyncHook) return NO_HOOK_RESULT;
		try {
			const result = await deps.middleware.runAsyncHook(input, priorEffects);
			return { effects: result.effects, firings: firingsOf(result) };
		} catch (error) {
			reportHookFailure(input.hook, error);
			return NO_HOOK_RESULT;
		}
	};

	const appendMiddlewareReminderEntry = (
		message: string,
		severity: MiddlewareReminderSeverity,
		source: NoticeSource,
		display = true,
		firingId?: string,
	): void => {
		if (!deps.session?.current()) return;
		try {
			deps.session.appendEntry({
				kind: "custom",
				parentTurnId: state.lastTurnId,
				customType: "middlewareReminder",
				display,
				// The source rides with the entry so a resumed transcript titles the callout the live one did. The firing id
				// joins the entry to its firing row and its settlement (memory design 4.1).
				data: { message, severity, source, ...(firingId !== undefined ? { firingId } : {}) },
			});
		} catch {
			// Reminder persistence is best-effort; the live notice still
			// reaches the operator through the existing chat event path.
		}
	};

	const applyTurnEndReminder = (
		agentRuntime: AgentRuntime,
		message: string,
		severity: MiddlewareReminderSeverity,
		source: NoticeSource = "reminder",
		modelOnly = false,
		firingId?: string,
		failedChecks: ReadonlyArray<string> = [],
	): boolean => {
		if (modelOnly && severity !== "hard-block") {
			// Advice for the model rides the next request and stays in the ledger
			// for inspection. As a callout it reached the operator after the
			// answer they asked for, addressed to someone else.
			const buffered = bufferReminder(message, severity, false, undefined, firingId);
			appendMiddlewareReminderEntry(message, severity, source, false, firingId);
			return buffered;
		}
		if (message.startsWith(FINISH_CONTRACT_ADVISORY_MESSAGE) && severity === "warn") {
			// The finish decision is already in the evidence ledger. Surface the
			// warning to the operator without posing it as a new user instruction
			// or carrying stale advice into the next model turn. When the workspace
			// declares checks, name the one to run rather than leave a bare warning.
			const named = (prefix: string): string[] => {
				const at = message.indexOf(prefix);
				if (at < 0) return [];
				// Check ids may hold dots, so a list ends at ". " or the message's final period.
				const rest = message.slice(at + prefix.length);
				const stop = rest.indexOf(". ");
				const list = stop >= 0 ? rest.slice(0, stop) : rest.replace(/\.$/u, "");
				return list.split(", ").filter((id) => id.length > 0);
			};
			const declared = named(FINISH_CONTRACT_DECLARED_CHECKS_PREFIX);
			const runChecks = named(FINISH_CONTRACT_RUN_CHECKS_PREFIX);
			const ran = named(FINISH_CONTRACT_RAN_CHANGED_PREFIX);
			const more = (list: ReadonlyArray<string>) => (list.length > 1 ? ` and ${list.length - 1} more` : "");
			const hint =
				declared.length > 0
					? `; run verify ${declared[0]}${declared.length > 1 ? ` (or ${declared.slice(1).join(", ")})` : ""}`
					: runChecks.length > 0
						? `; the run's --verify check (${runChecks.join(", ")}) still runs after the turn`
						: "";
			deps.emitFooterNotice(
				"warning",
				failedChecks.length > 0
					? `CLIO Coder changed files and ran ${failedChecks[0]}${more(failedChecks)} after the edit; ${failedChecks.length > 1 ? "they" : "it"} failed${hint}`
					: ran.length > 0
						? `CLIO Coder changed files and ran ${ran[0]}${more(ran)} afterwards, but no recognized check covered the change${hint}`
						: `CLIO Coder changed files but ran no check on them afterwards${hint}`,
				"finish.unverified",
			);
			return false;
		}
		if (
			severity === "warn" &&
			(message === FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE ||
				message === FINISH_CONTRACT_FAILED_CHECK_ADVISORY_MESSAGE ||
				message === FINISH_CONTRACT_EVIDENCE_SCOPE_ADVISORY_MESSAGE)
		) {
			// CLB-3: unknown coverage is operator status, never a recovery request
			// or permission to execute another check. A red after the last change is never "checks passed" (bt-44).
			const failed = message === FINISH_CONTRACT_FAILED_CHECK_ADVISORY_MESSAGE;
			deps.emitFooterNotice(
				failed ? "warning" : "info",
				failed
					? "a check failed after the last change; coverage of the change not measured"
					: message === FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE
						? "checks passed; coverage of the change not measured"
						: "validation evidence recorded; coverage of the change not measured",
				"finish.coverage-unverified",
			);
			return false;
		}
		const buffered = bufferReminder(message, severity, false, undefined, firingId);
		if (severity === "hard-block") {
			// Interrupt the turn unless the streaming tool-prose cutoff already
			// aborted it mid-delta; the buffered reminder carries the recovery
			// guidance into the next request either way.
			if (state.toolProseAbortReason === null) {
				state.toolProseAbortReason = message;
				agentRuntime.agent.abort();
				deps.emitNotice(message, "warning", source);
			}
			return buffered;
		}
		appendMiddlewareReminderEntry(message, severity, source, true, firingId);
		deps.emitNotice(message, reminderNoticeLevel(severity), source);
		return buffered;
	};

	/** Whether {@link applyTurnEndReminder} writes this reminder to the ledger; mirrors its branches. */
	const pairedReminderPersists = (effect: Extract<MiddlewareEffect, { kind: "inject_reminder" }>): boolean => {
		const severity = effect.severity ?? "info";
		if (severity === "hard-block") return false;
		if (effect.audience === "model") return true;
		if (severity !== "warn") return true;
		return !(
			effect.message.startsWith(FINISH_CONTRACT_ADVISORY_MESSAGE) ||
			effect.message === FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE ||
			effect.message === FINISH_CONTRACT_FAILED_CHECK_ADVISORY_MESSAGE ||
			effect.message === FINISH_CONTRACT_EVIDENCE_SCOPE_ADVISORY_MESSAGE
		);
	};

	/**
	 * FX-38: a declared done the seal lowered, in one footer line, in place of the reminders that carried its facts. An
	 * honest partly_done or not_done claimed no more than the facts allow, so it gets no line.
	 */
	const announceAssessment = (effects: ReadonlyArray<MiddlewareEffect>): void => {
		const sealed = state.turnSealedCompletion;
		if (!sealed?.declared || sealed.claimed !== "done" || sealed.assessed === "done") return;
		const noteOf = (fact: CompletionFact): string => {
			for (const effect of effects)
				if (effect.kind === "request_continuation" && effect.fact === fact && effect.note) return effect.note;
			return COMPLETION_FACT_NOTES[fact];
		};
		const open = [...new Set(sealed.facts.map(noteOf))].join("; ");
		deps.emitFooterNotice(
			"warning",
			`declared done, assessed ${sealed.assessed.replace("_", " ")}: ${open}`,
			"finish.assessed",
		);
	};

	const notifyOperator = (message: string, key: string): void => {
		if (deps.emitOperatorTip) deps.emitOperatorTip(message, key);
		// `notify_operator` is the operator-only advisory channel. A tip is not part
		// of the work, so it takes the footer's fading slot instead of a callout in
		// the transcript, and the rule's own `[tip]` label becomes the line's lead.
		else deps.emitFooterNotice("info", message.replace(/^\[tip\]\s*/u, "tip: "), key);
	};

	const applyRequestContinuation = (
		message: string,
		note?: string,
		reserved?: "verification",
		persisted = false,
		firingId?: string,
	): boolean => {
		if (!state.continuation.request(reserved)) {
			if (reserved === "verification") {
				deps.emitFooterNotice(
					"warning",
					"the change has no validation evidence and this prompt's verification nudge is spent; it is recorded unverified",
					"nudge.verification.spent",
				);
				return false;
			}
			// One continuation per user prompt, and that cap is all this branch
			// knows. It cannot tell whether the model stalled, answered, or was
			// carried here by a second producer entirely, so it reports the cap and
			// leaves any claim about a stall to the watchdog that measures one.
			deps.emitFooterNotice("warning", "turn still has open work; this turn's nudge is spent", "nudge.continuation.spent");
			return false;
		}
		const buffered = bufferReminder(message, "info", false, undefined, firingId);
		// The nudge reaches the model as context inside the run, never as a
		// persisted operator turn, so the ledger keeps it for inspection only. A
		// paired reminder with the same text already keeps it there, once (XR-8).
		if (!persisted) appendMiddlewareReminderEntry(message, "info", "reminder", false, firingId);
		// The producer's own note says what was nudged. An empty note is the plan
		// close, whose "Carry out this plan?" card is already the announcement.
		if (note === "") return buffered;
		deps.emitFooterNotice(
			"info",
			note === undefined ? "nudged the model to continue" : `nudged the model to continue: ${note}`,
			"nudge.continuation.sent",
		);
		return buffered;
	};

	const lastAssistantMessage = (messages: ReadonlyArray<AgentMessage>): AgentMessage | null => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
				return message;
			}
		}
		return null;
	};

	/**
	 * The newest reply text of this turn: a pinned `finish` round may carry none, so the reply it declares is the text
	 * before it. Host reminder inserts are crossed; the operator's own message ends the search.
	 */
	const lastAssistantReplyText = (messages: ReadonlyArray<AgentMessage>): string => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (!message || typeof message !== "object" || !("role" in message)) continue;
			if (message.role === "assistant") {
				const text = extractText(message);
				if (text.trim().length > 0) return text;
			} else if (message.role === "user" && !extractText(message).trimStart().startsWith("<system-reminder>")) {
				return "";
			}
		}
		return "";
	};

	const turnStartInput = (
		agentRuntime: AgentRuntime,
		promptText: string,
		pendingSkillRequestCount: number,
		requestContinuation: boolean,
		userTurnId: string | undefined,
	): MiddlewareHookInput => {
		const sessionId = deps.session?.current()?.id;
		// The user turn its tool hooks and turn_end name in `userTurnId`, so extensions correlate a turn by one id.
		const turnId = userTurnId ?? state.activeUserTurnId;
		return {
			hook: "turn_start",
			...(sessionId ? { sessionId } : {}),
			modelId: agentRuntime.wireModelId,
			...runtimeModelField(agentRuntime.runtimeResolution),
			// The raw user text so the skills reminder can tell a substantive task
			// turn from a bare greeting; the runtime caps it on clone.
			text: promptText.slice(0, MIDDLEWARE_HOOK_TEXT_MAX_CHARS),
			metadata: {
				promptChars: promptText.length,
				queued: false,
				requestContinuation,
				turnMode: state.currentTurnConstraints?.mode ?? "",
				// The route-scoped step policy this turn runs under, if any: such a turn runs one step, not a task list.
				turnStepPolicy: state.currentTurnConstraints?.turnPolicy !== undefined,
				turnReadOnly: state.currentTurnConstraints?.readOnly === true,
				activeToolNames: toolNamesFromAgentState(agentRuntime.agent.state.tools).join(","),
				activeCapabilityNames: activeCapabilityNames(agentRuntime),
				// First-substantive-turn signal for once-per-session reminders:
				// a fresh session's opening turn has an empty conversation.
				conversationMessages: agentRuntime.agent.state.messages.filter((message) => message.role !== "system").length,
				pendingSkillRequests: pendingSkillRequestCount,
				...turnOriginMetadata(state.currentTurnOrigin),
				...(turnId ? { userTurnId: turnId } : {}),
			},
		};
	};

	/** Settle `suppressed` every firing of `firings` none of whose effects entered a request. */
	const suppressUnentered = (firings: ReadonlyMap<MiddlewareEffect, string>, entered: ReadonlySet<string>): void => {
		const ids = [...new Set(firings.values())].filter((id) => !entered.has(id));
		if (ids.length > 0) deps.suppressFirings?.(ids);
	};

	const applyTurnStartEffects = (
		effects: ReadonlyArray<MiddlewareEffect>,
		firings: ReadonlyMap<MiddlewareEffect, string> = new Map(),
	): void => {
		middlewareToolChoice.apply(effects);
		// A tool-choice effect is armed for the turn's next request; a reminder enters it when buffered. Nothing else
		// applies here.
		const entered = new Set<string>();
		for (const effect of effects) {
			const firingId = firings.get(effect);
			if (effect.kind === "inject_reminder") {
				if (bufferReminder(effect.message, effect.severity ?? "info", false, undefined, firingId) && firingId)
					entered.add(firingId);
			} else if (effect.kind === "notify_operator") {
				notifyOperator(effect.message, effect.key);
			} else if ((effect.kind === "lock_tools" || effect.kind === "require_tool") && firingId) {
				armed.add(firingId);
				entered.add(firingId);
			}
		}
		suppressUnentered(firings, entered);
	};

	return {
		async prepareToolContinuation(agentRuntime, signal): Promise<boolean> {
			const sessionId = deps.session?.current()?.id;
			const userTurnId = state.activeUserTurnId;
			const current = () =>
				!signal?.aborted &&
				state.activeInterruptReason === null &&
				deps.session?.current()?.id === sessionId &&
				state.activeUserTurnId === userTurnId;
			if (!current()) return false;
			// This is not a user-turn finish: run only the async observation phase,
			// never completion assessors or foreground continuation effects.
			const observed = await runMiddlewareTurnHookAsync(
				{
					hook: "after_tool",
					...(sessionId ? { sessionId } : {}),
					...(state.lastTurnId ? { turnId: state.lastTurnId } : {}),
					metadata: { stage: "tool_batch_end", ...(userTurnId ? { userTurnId } : {}) },
				},
				[],
			);
			// Its effects are observation only and never applied.
			suppressUnentered(observed.firings, new Set());
			if (!current()) return false;
			dropStale();
			const ready = pendingReminders.filter((entry) => entry.deferred);
			if (ready.length === 0) return false;
			const content = systemReminderBlock([...new Set(ready.map((entry) => entry.message))]);
			// injectDeferredReminder already persisted a middleware receipt. Update
			// context directly: message events would invent a new operator turn and
			// reset task/tool authority in appendQueuedUserTurn.
			const reminder: AgentMessage = { role: "user", content, timestamp: Date.now() };
			if (deps.hostInserts) deps.hostInserts.insert(agentRuntime, "reminder", [reminder]);
			else agentRuntime.agent.state.messages.push(reminder);
			// The delivered text rides the run's next request, as a flushed buffer does, with the firings that joined it.
			for (let index = pendingReminders.length - 1; index >= 0; index--) {
				if (!pendingReminders[index]?.deferred) continue;
				for (const firingId of entryFirings(pendingReminders.splice(index, 1))) armed.add(firingId);
			}
			return true;
		},

		fireTurnStart(
			agentRuntime,
			promptText,
			pendingSkillRequestCount = 0,
			requestContinuation = false,
			userTurnId,
			awaited,
		): void {
			const input = turnStartInput(agentRuntime, promptText, pendingSkillRequestCount, requestContinuation, userTurnId);
			// The skills reminder and the marketplace offer each list installed
			// skills on a session's first substantive turn. One discovery pass
			// verifies every plugin tree once for all turn_start registrations.
			const started = withPluginDiscoveryPass(() => runMiddlewareTurnHook(input));
			applyTurnStartEffects(started.effects, started.firings);
			if (awaited === undefined) return;
			for (const firingId of awaited.firings.values()) gated.delete(firingId);
			applyTurnStartEffects(awaited.effects, awaited.firings);
		},

		async awaitTurnStart(agentRuntime, promptText, pendingSkillRequestCount = 0, userTurnId): Promise<TurnStartGate> {
			if (!deps.middleware?.hasAwaitedHook?.("turn_start") || !deps.middleware.runAwaitedHook)
				return { refusal: null, ...NO_HOOK_RESULT };
			const input = turnStartInput(agentRuntime, promptText, pendingSkillRequestCount, false, userTurnId);
			try {
				const result = await deps.middleware.runAwaitedHook(input);
				const { effects } = result;
				const firings = firingsOf(result);
				const refusal = effects.find((effect) => effect.kind === "block_tool");
				// A refused turn sends no request, so nothing its gate fired can enter one.
				if (refusal !== undefined) {
					suppressUnentered(firings, new Set());
					return { refusal: refusal.reason };
				}
				// An admitted turn's gate holds its firings until fireTurnStart applies them; a submit that returns first
				// releases them unsent.
				for (const firingId of firings.values()) gated.add(firingId);
				return { refusal: null, effects, firings };
			} catch (error) {
				reportHookFailure(input.hook, error);
			}
			return { refusal: null, ...NO_HOOK_RESULT };
		},

		async fireTurnEnd(agentRuntime, messages, terminalToolResult, pinFinishRound): Promise<boolean> {
			// Fleet design 4.3: the host seals every ended turn, the claim beside its assessment from the turn's facts.
			state.turnSealedCompletion = sealCompletion(
				state.turnCompletion,
				deps.hostCompletionFacts?.() ?? [],
				deps.missingOutputs?.() ?? [],
			);
			if (!deps.middleware) return false;
			// A turn `finish` ended closes on the reply the model wrote beside it (fleet design 4.3): that text is the
			// final answer, as a settled stop turn's would be. Any other terminal tool's result stands in for the reply.
			const declared = terminalToolResult?.toolName === ToolNames.Finish;
			const message = terminalToolResult === undefined ? lastAssistantMessage(messages) : null;
			if (message === null && terminalToolResult === undefined) return false;
			const text = declared ? lastAssistantReplyText(messages) : message === null ? "" : extractText(message);
			// Empty error/abort completions still close a tool-bearing turn. Let
			// lifecycle observers settle their state even without final prose.
			const stopReason = message === null ? "stop" : (message as { stopReason?: unknown }).stopReason;
			const metadata: Record<string, MiddlewareMetadataValue> = {
				assistantTextChars: text.length,
				hasStructuredToolCall: terminalToolResult !== undefined || (message !== null && hasStructuredToolCall(message)),
				runtimeId: agentRuntime.runtimeId,
				runtimeTier: agentRuntime.runtimeResolution.runtimeTier ?? "",
				activeToolNames: toolNamesFromAgentState(agentRuntime.agent.state.tools).join(","),
				activeCapabilityNames: activeCapabilityNames(agentRuntime),
				turnToolCalls: state.turnToolCalls,
				turnToolNames: state.turnToolNames.join(","),
				sharedWorkerNote: state.turnSharedWorkerNote,
				collectedDetachedBatch: state.turnCollectedDetachedBatch,
				turnMode: state.currentTurnConstraints?.mode ?? "",
				toolsLocked: state.synthesisToolLock || state.toolBudgetLock,
				// An unattended turn's one pinned `finish` round is spent: the stalled-turn nudge does not fall back to prose (MD14).
				...(state.finishRoundSpent ? { finishRoundSpent: true } : {}),
				...turnOriginMetadata(state.currentTurnOrigin),
				...(state.turnCompletion !== null ? { completionState: state.turnCompletion.state } : {}),
				// Metadata carries scalars, so the declaration's `remaining` items ride one per line (memory design MD14).
				...(state.turnCompletion?.remaining?.length
					? {
							completionRemaining: state.turnCompletion.remaining.map((item) => item.replace(/\s+/gu, " ").trim()).join("\n"),
						}
					: {}),
			};
			// The final call's input includes cache tokens and measures the context
			// a plan-close continuation would repeat (#431).
			const contextMessage = message ?? lastAssistantMessage(messages);
			if (contextMessage !== null && "usage" in contextMessage && contextMessage.usage) {
				const usage = normalizeTokenUsage(contextMessage.usage as unknown as Record<string, unknown>);
				if (usage.observed) metadata.contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			}
			if (terminalToolResult !== undefined) {
				metadata.terminalToolResult = true;
				metadata.terminalToolCallId = terminalToolResult.toolCallId;
				metadata.terminalToolName = terminalToolResult.toolName;
			}
			// turnId intentionally identifies the final assistant ledger entry (the
			// finish contract needs that evidence boundary). Registrations that span
			// tool hooks and turn_end correlate through the initiating user turn.
			if (state.activeUserTurnId) metadata.userTurnId = state.activeUserTurnId;
			if (typeof stopReason === "string") metadata.stopReason = stopReason;
			const step = deps.stepTurnEnd?.() ?? null;
			if (step?.continues === true) metadata.stepContinues = true;
			if (step?.startTurnId !== undefined) metadata.stepPipelineStartTurnId = step.startTurnId;
			const sessionId = deps.session?.current()?.id;
			const input: MiddlewareHookInput = {
				hook: "turn_end",
				...(sessionId ? { sessionId } : {}),
				...(state.lastTurnId ? { turnId: state.lastTurnId } : {}),
				modelId: agentRuntime.wireModelId,
				...runtimeModelField(agentRuntime.runtimeResolution),
				text: text.slice(0, MIDDLEWARE_HOOK_TEXT_MAX_CHARS),
				metadata,
			};
			const sync = runMiddlewareTurnHook(input);
			const later = await runMiddlewareTurnHookAsync(input, sync.effects);
			const effects = [...sync.effects, ...later.effects];
			const firings = new Map([...sync.firings, ...later.firings]);
			/** The settling firings an effect of which entered the reminder buffer, so the next request carries it. */
			const entered = new Set<string>();
			const enter = (effect: MiddlewareEffect, carried: boolean): void => {
				const firingId = firings.get(effect);
				if (carried && firingId !== undefined) entered.add(firingId);
			};
			// The four coordinator obligations come from the producers that already watch them, as typed tags.
			const facts = effects.flatMap((effect) =>
				(effect.kind === "inject_reminder" || effect.kind === "request_continuation") && effect.fact !== undefined
					? [effect.fact]
					: [],
			);
			state.turnSealedCompletion = sealCompletion(
				state.turnCompletion,
				[...facts, ...(deps.hostCompletionFacts?.() ?? [])],
				deps.missingOutputs?.() ?? [],
			);
			// `finish` is turn-terminal: a declared turn never continues, and what a nudge would have asked is sealed
			// as a fact above. An undeclared turn keeps today's continuations.
			const declaredTurn = state.turnCompletion !== null;
			// Observation is not recovery authority. No reminder or continuation
			// may restart a failed or operator-canceled foreground turn.
			if (stopReason === "aborted") {
				const removed: PendingReminder[] = [];
				for (let index = pendingReminders.length - 1; index >= 0; index--) {
					if (pendingReminders[index]?.deferred) removed.push(...pendingReminders.splice(index, 1));
				}
				releaseFirings(entryFirings(removed));
			}
			if (stopReason === "error" || stopReason === "aborted") {
				suppressUnentered(firings, entered);
				return false;
			}
			// A continuation paired with a reminder of the same text is written to the ledger by the reminder alone.
			const paired = new Set(
				effects.flatMap((effect) =>
					effect.kind === "inject_reminder" && pairedReminderPersists(effect) ? [effect.message] : [],
				),
			);
			// FX-38: a declared turn is over, so a finish-gate reminder from any producer (one that tags a completion fact,
			// footer advisories included, or voices a continuation the turn drops) is sealed, not delivered: the operator
			// reads the assessment in one footer line and the model is not reminded. A model-only fact is context for the
			// next turn and still rides its request; a factless advisory the footer already carries stays there.
			const voiced = new Set(
				declaredTurn ? effects.flatMap((effect) => (effect.kind === "request_continuation" ? [effect.message] : [])) : [],
			);
			const sealedOnly = (effect: MiddlewareEffect): boolean =>
				declaredTurn &&
				effect.kind === "inject_reminder" &&
				effect.audience !== "model" &&
				effect.severity !== "hard-block" &&
				(effect.fact !== undefined || (pairedReminderPersists(effect) && voiced.has(effect.message)));
			if (declaredTurn) announceAssessment(effects);
			// The stalled-turn nudge yields only when nothing else carries the turn on: another continuation, already asked or
			// asked in this pass, goes out instead of the pinned round, so the nudge then takes its own path (MD14).
			const otherContinuation =
				state.continuation.requested ||
				effects.some(
					(effect) =>
						effect.kind === "request_continuation" &&
						effect.message !== STALLED_TURN_REQUEST_CONTINUATION_MESSAGE &&
						!sealedOnly(effect) &&
						turnAllowsContinuation(state.currentTurnConstraints) &&
						(effect.toolFree === true || !(state.synthesisToolLock || state.toolBudgetLock)),
				);
			let yieldedToFinish: string | null = null;
			for (const effect of effects) {
				if (sealedOnly(effect)) continue;
				if (effect.kind === "inject_reminder") {
					const carried = applyTurnEndReminder(
						agentRuntime,
						effect.message,
						effect.severity ?? "info",
						effect.source === "memory" ? "memory" : "reminder",
						effect.audience === "model",
						firings.get(effect),
						effect.failedChecks,
					);
					enter(effect, carried);
					continue;
				}
				if (effect.kind === "request_continuation" && declaredTurn) continue;
				// Memory design 4.6 (MD14): on an unattended turn the stalled-turn nudge yields to the turn's pinned `finish`
				// round, which asks for the typed declaration instead of prose. Its firing rides that round's request. Where no
				// pinned round can go out (an attended turn, a spent round, locked tools, no `finish`), the nudge stands.
				if (
					effect.kind === "request_continuation" &&
					effect.message === STALLED_TURN_REQUEST_CONTINUATION_MESSAGE &&
					!declaredTurn &&
					!otherContinuation &&
					turnAllowsContinuation(state.currentTurnConstraints) &&
					pinFinishRound?.() === true
				) {
					const firingId = firings.get(effect);
					yieldedToFinish = firingId ?? "";
					if (firingId !== undefined) armed.add(firingId);
					enter(effect, true);
					continue;
				}
				if (effect.kind === "request_continuation" && turnAllowsContinuation(state.currentTurnConstraints)) {
					// A locked request cannot call the tool a nudge asks for: a plan close
					// here reasoned over that conflict for 131k tokens until max_tokens.
					if (effect.toolFree === true || !(state.synthesisToolLock || state.toolBudgetLock))
						enter(
							effect,
							applyRequestContinuation(
								effect.message,
								effect.note,
								effect.reserved,
								paired.has(effect.message),
								firings.get(effect),
							),
						);
					continue;
				}
				if (effect.kind === "notify_operator") notifyOperator(effect.message, effect.key);
			}
			// The yielded firing is armed only for the pinned round: if a continuation was asked after all, that request is not
			// the round's, and the firing never enters it.
			if (yieldedToFinish !== null && state.continuation.requested) {
				if (yieldedToFinish !== "") {
					armed.delete(yieldedToFinish);
					entered.delete(yieldedToFinish);
				}
				yieldedToFinish = null;
			}
			// A declared turn, a locked request or a spent nudge left these firings nothing to carry.
			suppressUnentered(firings, entered);
			return yieldedToFinish !== null;
		},

		/**
		 * Observe-only lifecycle point fired before each compaction or working-set
		 * stage. Consumers record telemetry or state around projected context
		 * changes; returned effects are discarded by design.
		 */
		fireCompactionHook(stage, trigger, tokensBefore): void {
			if (!deps.middleware) return;
			const sessionId = deps.session?.current()?.id;
			const metadata: Record<string, MiddlewareMetadataValue> = { stage, trigger };
			if (tokensBefore !== undefined) metadata.tokensBefore = tokensBefore;
			// The ledger settles a firing here `suppressed` itself: this hook's effects are discarded by design.
			runMiddlewareTurnHook({
				hook: "on_compaction",
				...(sessionId ? { sessionId } : {}),
				...(state.activeUserTurnId ? { turnId: state.activeUserTurnId } : {}),
				metadata,
			});
		},

		takePendingReminderProjection(leading = () => []): () => string {
			// A projection taken earlier and never sent was abandoned with the turn that took it.
			settleTaken(new Set());
			const entries = pendingReminders.splice(0);
			const own: NonNullable<typeof taken> = { entries, carried: new Set() };
			taken = own;
			return (): string => {
				const current = entries.filter((entry) => entry.isCurrent?.() !== false);
				own.carried = new Set(current);
				const messages = [...new Set([...leading(), ...current.map((entry) => entry.message)])];
				return messages.length ? systemReminderBlock(messages) : "";
			};
		},
		beginTurnHolds(): number {
			abandonHeld();
			holdToken += 1;
			return holdToken;
		},
		releaseTurnHolds(token): void {
			// A later submit's holds are its own to release.
			if (token === holdToken) abandonHeld();
		},
		requestCarried(): string[] {
			const rode = taken === null ? [] : settleTaken(taken.carried);
			const carried = [...new Set([...armed, ...rode])];
			armed.clear();
			return carried;
		},
		heldFirings,
		flushPendingReminders(): string {
			dropStale();
			if (pendingReminders.length === 0) return "";
			// Severity affects host actions, not the text delivered to the model.
			// A paired continuation/info and reminder/warn still needs one copy.
			const messages = [...new Set(pendingReminders.map((entry) => entry.message))];
			// The flushed text rides the run's next request; a run that ends first releases it unsent.
			for (const firingId of entryFirings(pendingReminders.splice(0))) armed.add(firingId);
			return systemReminderBlock(messages);
		},

		clearPendingReminders(): void {
			const buffered = entryFirings(pendingReminders.splice(0));
			abandonHeld();
			releaseFirings(buffered);
		},

		injectDeferredReminder(message, severity = "advisory", isCurrent, source = "reminder"): void {
			dropStale();
			if (isCurrent?.() === false) return;
			const text = message.trim();
			if (text.length === 0) return;
			// A deferred reminder never carries hard-block authority: the turn it
			// could have interrupted is already over.
			const level: MiddlewareReminderSeverity = severity === "hard-block" ? "advisory" : severity;
			if (pendingReminders.some((entry) => entry.message === text)) return;
			bufferReminder(text, level, true, isCurrent);
			appendMiddlewareReminderEntry(text, level, source);
			deps.emitNotice(text, reminderNoticeLevel(level), source);
		},

		emitDeferredNotice(text, level = "warning", source): void {
			const message = text.trim();
			if (message.length === 0) return;
			deps.emitNotice(message, level, source);
		},

		applyToolBoundaryReminders(reminders): void {
			for (const reminder of reminders) {
				const severity = reminder.severity ?? "info";
				// Journaled as a `reminder` insert carrying its rule, a record builds before X6 still read.
				const queued =
					deps.queueHostMessage?.(systemReminderBlock([reminder.message]), "reminder", reminder.ruleId) ?? false;
				// Advice for the model alone stays out of the transcript, as it does at turn_end.
				if (queued && reminder.audience !== "model") deps.emitNotice(reminder.message, reminderNoticeLevel(severity));
			}
		},
	};
}
