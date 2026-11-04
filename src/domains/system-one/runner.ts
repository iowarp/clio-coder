/**
 * One `ask`, from object to verdict: the routes tried in order, and the lifecycle
 * around each. Before a route: formation, redaction, the flow check. Around it: its
 * own timeout, inside the point's total. After the ask: one content-free decided
 * event. A caller gets a verdict or null, and null always means it behaves as if
 * System One did not exist, so nothing in here throws.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { EventPayload } from "../../core/telemetry/events.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { createRedactionTally } from "../evidence/redact.js";
import type { Formation, FormedRequest } from "./formation.js";
import { formRequest } from "./formation.js";
import { exactBoundFor } from "./profiles.js";
import { clearedObject, scrub } from "./scrub.js";
import type {
	Abstention,
	Answer,
	AskAnswers,
	AskOptions,
	CallOutcome,
	DecisionEngine,
	DecisionPoint,
	EngineDestination,
	EngineReply,
	PointQuestion,
	Question,
	RouteAttempt,
	SystemOneBreakerView,
	Verdict,
} from "./types.js";

/** Consecutive timed-out calls that stop an engine being asked. */
export const BREAKER_THRESHOLD = 3;
/** How long a tripped engine is left alone before one call probes it again. */
export const BREAKER_COOLDOWN_MS = 5 * 60_000;

/** One named route: the engine, its configuration's identity and how long one request may take. */
export interface RunnerRoute {
	readonly name: string;
	readonly engine: DecisionEngine;
	/** Identity of the engine's configuration, so a repointed target does not inherit the old one's timeouts. */
	readonly digest: string;
	readonly timeoutMs: number;
}

/**
 * The information-flow check every outgoing request passes, supplied by the
 * composition root from the safety domain. Synchronous and content-blind: it
 * judges where the evidence came from (`inherited`) against where it would go. A
 * null destination has no request to judge, so it is never asked.
 */
export type DecisionFlowCheck = (request: {
	readonly channel: "system-one";
	readonly point: string;
	readonly destination: EngineDestination & { readonly engine: string };
	readonly inherited?: unknown;
}) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export interface RunnerDeps {
	/** The session current now, read once when an ask starts, so a late answer names the session that asked. */
	currentSession?: () => string | null;
	flowCheck?: DecisionFlowCheck;
	/** Whether the endpoint behind a destination has no free slot. An optional point skips such a route. */
	slotsFull?: (destination: EngineDestination) => boolean;
}

export interface Runner {
	ask<O, V>(
		routes: ReadonlyArray<RunnerRoute>,
		point: DecisionPoint<O, V>,
		object: O,
		options: AskOptions,
	): Promise<Verdict<V> | null>;
	/** Every breaker that counts a timeout or is tripped. */
	breakers(): SystemOneBreakerView[];
	/** Engine configurations whose server refused the model by name, which no retry can change. */
	refused(): ReadonlyArray<{ digest: string; engine: string; reason: string }>;
}

interface BreakerState {
	failures: number;
	openUntil: number;
	/** The one call past the cooldown is running. */
	probing?: boolean;
	engine: string;
}

/** The journal calls an ask's model requests open, collected while its engines run (#429, #434). */
const decisionCalls = new AsyncLocalStorage<Set<string>>();

/** The host's request admission names the call it opened, so the decided event can cite it (#429). */
export function noteSystemOneCall(callId: string): void {
	decisionCalls.getStore()?.add(callId);
}

/** A server that does not know the model answers every later ask the same way, so one request settles it. */
const UNKNOWN_MODEL_RE = /\b400\b.*\bunknown model\b/isu;

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Question values redacted with the state's filters; ids and option keys stay exact, because answers come back under them. */
function redactQuestion(question: Question): Question {
	const text = (value: string): string => scrub(value, createRedactionTally(), false);
	if (question.type === "noul") {
		return {
			type: "noul",
			instructions: text(question.instructions),
			criteria: { true: text(question.criteria.true), false: text(question.criteria.false) },
		};
	}
	if (question.type === "choice") {
		const criteria: Record<string, string> = {};
		for (const [key, value] of Object.entries(question.criteria)) criteria[key] = text(value);
		return { type: "choice", instructions: text(question.instructions), criteria };
	}
	return { type: "score", instructions: text(question.instructions), criteria: question.criteria.map(text) };
}

function redactItem(item: PointQuestion): PointQuestion {
	return {
		semantic: item.semantic,
		question: redactQuestion(item.question),
		...(item.compact !== undefined ? { compact: redactQuestion(item.compact) } : {}),
	};
}

export function createRunner(deps: RunnerDeps): Runner {
	// An engine that hangs costs every ask its full timeout. Only its own timeouts trip
	// the breaker: a refused connection or an unusable answer comes back in milliseconds.
	const breakers = new Map<string, BreakerState>();
	const refused = new Map<string, { digest: string; engine: string; reason: string }>();

	function sessionAtStart(): string | null | undefined {
		if (deps.currentSession === undefined) return undefined;
		try {
			return deps.currentSession();
		} catch {
			// The decided event is then not journaled to a session; the answer still stands.
			return undefined;
		}
	}

	function decided(
		session: string | null | undefined,
		payload: EventPayload<"system_one.decided">,
		engine: string,
	): void {
		try {
			// An ask with no session still reaches subscribers; only the journal needs a session to file under.
			const context =
				typeof session === "string" && session.length > 0
					? { sessionId: session, agent: { role: "system-one" as const, id: engine } }
					: undefined;
			telemetryHub().emit("system_one.decided", payload, context);
		} catch {
			// The decision's record never changes the decision (#434).
		}
	}

	/** Whether a route may be sent to now, and if not the attempt that says why. */
	function preflight<O, V>(
		route: RunnerRoute,
		point: DecisionPoint<O, V>,
		options: AskOptions,
	): { outcome: CallOutcome; reason: string } | { breaker?: "probe" } {
		const { engine } = route;
		const refusal = refused.get(route.digest);
		if (refusal !== undefined) return { outcome: "breaker-open", reason: refusal.reason };
		const breaker = breakers.get(route.digest);
		const tripped = breaker !== undefined && breaker.failures >= BREAKER_THRESHOLD;
		if (tripped && performance.now() < (breaker as BreakerState).openUntil) {
			return {
				outcome: "breaker-open",
				reason: `engine '${route.name}' is cooling down after ${(breaker as BreakerState).failures} consecutive timeouts`,
			};
		}
		const { destination } = engine;
		// A null destination sends no byte anywhere, so nothing here needs a network to judge it.
		if (destination !== null) {
			if (point.optional === true && deps.slotsFull?.(destination) === true) {
				return { outcome: "busy", reason: `engine '${route.name}' has no free slot` };
			}
			if (deps.flowCheck !== undefined) {
				let verdict: ReturnType<DecisionFlowCheck>;
				try {
					verdict = deps.flowCheck({
						channel: "system-one",
						point: point.id,
						destination: { ...destination, engine: route.name },
						...(options.flow !== undefined ? { inherited: options.flow } : {}),
					});
				} catch (error) {
					// A configured check that cannot answer is not a permit. The ask is
					// optional, so it abstains and the evidence stays where it is.
					verdict = { allowed: false, reason: `flow check failed: ${errorText(error)}` };
				}
				if (!verdict.allowed) return { outcome: "flow-denied", reason: `flow denied: ${verdict.reason}` };
			}
		}
		if (tripped) return { breaker: "probe" };
		return {};
	}

	async function attempt(
		route: RunnerRoute,
		state: Readonly<Record<string, unknown>>,
		formed: FormedRequest,
		totalLeftMs: number,
		upstream: AbortSignal | undefined,
	): Promise<{ reply: EngineReply } | { outcome: CallOutcome; error: string; opened: boolean }> {
		const timeoutMs = Math.min(route.timeoutMs, totalLeftMs);
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error(`decision timed out after ${Math.round(timeoutMs)}ms`));
		}, timeoutMs);
		const onUpstreamAbort = (): void => controller.abort(upstream?.reason);
		upstream?.addEventListener("abort", onUpstreamAbort, { once: true });
		if (upstream?.aborted === true) onUpstreamAbort();
		const aborted = new Promise<never>((_resolve, reject) => {
			controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
		});
		// The race loses quietly when the engine settles first.
		aborted.catch(() => {
			// The rejection is consumed by the race below or is irrelevant once it settled.
		});
		try {
			const reply = await Promise.race([
				route.engine.decide({ state, questions: formed.questions, signal: controller.signal }),
				aborted,
			]);
			breakers.delete(route.digest);
			return { reply };
		} catch (error) {
			const message = errorText(error);
			if (timedOut && timeoutMs < route.timeoutMs) {
				// The ask's total ran out, not this route's own bound, so it says nothing about the engine.
				const breaker = breakers.get(route.digest);
				if (breaker?.probing === true) {
					breaker.probing = false;
					breaker.openUntil = performance.now();
				}
				return { outcome: "timeout", error: message, opened: false };
			}
			if (timedOut) {
				const failures = (breakers.get(route.digest)?.failures ?? 0) + 1;
				breakers.set(route.digest, {
					failures,
					openUntil: failures >= BREAKER_THRESHOLD ? performance.now() + BREAKER_COOLDOWN_MS : 0,
					engine: route.name,
				});
				return { outcome: "timeout", error: message, opened: failures === BREAKER_THRESHOLD };
			}
			if (upstream?.aborted === true) {
				// A probe that dies without the engine's answer proves nothing, so the next call may probe at once.
				const breaker = breakers.get(route.digest);
				if (breaker?.probing === true) {
					breaker.probing = false;
					breaker.openUntil = performance.now();
				}
				return { outcome: "canceled", error: message, opened: false };
			}
			// An answer or a refusal both prove the engine responds.
			breakers.delete(route.digest);
			if (UNKNOWN_MODEL_RE.test(message)) {
				refused.set(route.digest, { digest: route.digest, engine: route.name, reason: message });
			}
			return { outcome: "failed", error: message, opened: false };
		} finally {
			clearTimeout(timer);
			upstream?.removeEventListener("abort", onUpstreamAbort);
		}
	}

	async function ask<O, V>(
		routes: ReadonlyArray<RunnerRoute>,
		point: DecisionPoint<O, V>,
		object: O,
		options: AskOptions,
	): Promise<Verdict<V> | null> {
		const fail = (reason: string): void => {
			try {
				options.onFailure?.(scrub(reason, createRedactionTally(), false));
			} catch {
				// Diagnostics cannot change the null fallback.
			}
		};
		if (routes.length === 0) return null;
		const askId = `dc_${randomUUID()}`;
		const session = sessionAtStart();
		const started = performance.now();
		const { deadlineMs } = point;
		// Built and redacted once, so every route reads the same evidence and a point that cannot build asks nothing.
		let built: { state: Readonly<Record<string, unknown>>; asked: Readonly<Record<string, PointQuestion>> } | null;
		try {
			const cleared = clearedObject(object, createRedactionTally());
			const state = point.state(cleared);
			const asked = state === null ? {} : point.questions(cleared);
			built =
				state === null || Object.keys(asked).length === 0
					? null
					: {
							// Key-name redaction stays off: state keys are harness vocabulary and ids answers come back under.
							state: scrub(state, createRedactionTally(), false),
							asked: Object.fromEntries(Object.entries(asked).map(([id, item]) => [id, redactItem(item)])),
						};
		} catch (error) {
			fail(errorText(error));
			return null;
		}
		if (built === null) return null;
		const { state, asked } = built;
		const askedCount = Object.keys(asked).length;
		const attempts: RouteAttempt[] = [];
		const callIds = new Set<string>();
		const tally = (route: RunnerRoute, outcome: CallOutcome, extra: Partial<RouteAttempt> = {}): void => {
			attempts.push({ engine: route.name, kind: route.engine.kind, profile: route.engine.profile, outcome, ...extra });
		};
		// Formed once per route, before any byte leaves. A route that carries the whole ask goes before one that
		// carries part of it; among equals the operator's order stands. One engine answers one ask.
		const formed = new Map<RunnerRoute, FormedRequest>();
		const failures: string[] = [];
		for (const route of routes) {
			let formation: Formation;
			try {
				formation = formRequest({
					requiresProbabilities: point.requires?.probabilities === true,
					state,
					asked,
					capabilities: route.engine.capabilities,
					exactBound: exactBoundFor(route.engine.profile),
				});
			} catch (error) {
				tally(route, "failed");
				failures.push(errorText(error));
				continue;
			}
			if (formation.kind === "refused") {
				tally(route, formation.outcome);
				failures.push(formation.reason);
				continue;
			}
			formed.set(route, formation);
		}
		const whole = routes.filter((route) => {
			const form = formed.get(route);
			return form !== undefined && Object.keys(form.abstained).length === 0;
		});
		const ordered = [...whole, ...routes.filter((route) => formed.has(route) && !whole.includes(route))];

		let answered: { route: RunnerRoute; form: FormedRequest; reply: EngineReply } | null = null;
		await decisionCalls.run(callIds, async () => {
			for (const route of ordered) {
				if (options.signal?.aborted === true) {
					tally(route, "canceled");
					return;
				}
				const totalLeftMs = deadlineMs - (performance.now() - started);
				if (totalLeftMs <= 0) {
					tally(route, "timeout");
					failures.push(`the ${deadlineMs}ms total ran out before engine '${route.name}'`);
					return;
				}
				const ready = preflight(route, point, options);
				if ("outcome" in ready) {
					tally(route, ready.outcome);
					failures.push(ready.reason);
					continue;
				}
				const breaker = breakers.get(route.digest);
				if (ready.breaker === "probe" && breaker !== undefined) {
					breaker.openUntil = performance.now() + route.timeoutMs;
					breaker.probing = true;
				}
				const form = formed.get(route) as FormedRequest;
				const hadBreaker = breaker !== undefined;
				const sentAt = performance.now();
				const result = await attempt(route, state, form, totalLeftMs, options.signal);
				const roundTripMs = Math.round(performance.now() - sentAt);
				if ("reply" in result) {
					tally(route, "answered", {
						roundTripMs: result.reply.roundTripMs ?? roundTripMs,
						...(ready.breaker === "probe" ? { breaker: "probe" as const } : hadBreaker ? { breaker: "closed" as const } : {}),
					});
					answered = { route, form, reply: result.reply };
					return;
				}
				tally(route, result.outcome, {
					roundTripMs,
					...(result.opened
						? { breaker: "opened" as const }
						: ready.breaker === "probe"
							? { breaker: "probe" as const }
							: {}),
				});
				failures.push(result.error);
				// Cancelling the ask ends it; anything else moves to the next route, once.
				if (result.outcome === "canceled") return;
			}
		});

		const latencyMs = Math.round(performance.now() - started);
		const emit = (
			outcome: CallOutcome,
			abstained: number,
			extra: Partial<EventPayload<"system_one.decided">> = {},
		): void => {
			const route = (answered as { route: RunnerRoute } | null)?.route ?? routes[0];
			if (route === undefined) return;
			decided(
				session,
				{
					point: point.id,
					set: point.version,
					askId,
					...(options.ref !== undefined ? { ref: options.ref } : {}),
					outcome,
					latencyMs,
					deadlineMs,
					asked: askedCount,
					abstained,
					routes: attempts.slice(0, 16),
					callIds: [...callIds],
					...extra,
				},
				route.name,
			);
		};
		const done = answered as { route: RunnerRoute; form: FormedRequest; reply: EngineReply } | null;
		if (done === null) {
			const last = attempts.at(-1)?.outcome ?? "unsupported";
			fail(failures[0] ?? last);
			emit(last, askedCount);
			return null;
		}
		const { route, form, reply } = done;
		const answers: Record<string, Answer | Abstention> = {};
		for (const [id, reason] of Object.entries(form.abstained)) answers[id] = { abstained: reason };
		let readout: Answer["readout"] | undefined;
		for (const id of Object.keys(form.questions)) {
			const raw = reply.answers[id];
			const answer = raw === undefined ? null : form.decode(id, raw);
			answers[id] = answer ?? { abstained: "the engine gave no usable answer" };
			if (answer !== null) readout ??= answer.readout;
		}
		const abstainedCount = Object.values(answers).filter((answer) => "abstained" in answer).length;
		emit("answered", abstainedCount, {
			engineKind: route.engine.kind,
			profile: route.engine.profile,
			build: reply.build,
			...(readout !== undefined ? { readout } : {}),
			...(reply.usage !== undefined ? { tokens: reply.usage } : {}),
		});
		let value: V | null;
		try {
			value = point.read(answers as AskAnswers, object);
		} catch (error) {
			fail(errorText(error));
			return null;
		}
		if (value === null) {
			fail("the engine gave no usable answer");
			return null;
		}
		return {
			value,
			askId,
			engine: route.name,
			kind: route.engine.kind,
			profile: route.engine.profile,
			build: reply.build,
			latencyMs,
			...(reply.usage !== undefined ? { usage: reply.usage } : {}),
			routes: attempts,
		};
	}

	function breakerViews(): SystemOneBreakerView[] {
		const now = performance.now();
		const views: SystemOneBreakerView[] = [];
		for (const breaker of breakers.values()) {
			const tripped = breaker.failures >= BREAKER_THRESHOLD;
			const remainingMs = tripped ? Math.max(0, breaker.openUntil - now) : 0;
			views.push({
				engine: breaker.engine,
				state: !tripped ? "closed" : remainingMs === 0 ? "half-open" : breaker.probing ? "probing" : "open",
				failures: breaker.failures,
				remainingMs,
			});
		}
		return views;
	}

	return { ask, breakers: breakerViews, refused: () => [...refused.values()] };
}
