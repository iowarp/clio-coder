/**
 * One site call, from object to verdict.
 *
 * The runner owns everything that must hold for every engine: the decision
 * window check, the timeout breaker, the deadline, and the single record each
 * call leaves behind. A caller gets a verdict or null, and null always means
 * it behaves as if System One did not exist, so nothing in here throws.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { EventPayload } from "../../core/telemetry/events.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { createRedactionTally } from "../evidence/redact.js";
import type { DecisionTask } from "./contract.js";
import { primaryTask, SITE_TASKS } from "./contract.js";
import { validateQuestion } from "./questions.js";
import { clearedSiteObject, scrub } from "./scrub.js";
import type {
	Answer,
	CallOutcome,
	DecisionEngine,
	EngineReply,
	Question,
	RunOptions,
	SiteDefinition,
	SiteId,
	SystemOneBreakerView,
	Verdict,
} from "./types.js";

/** Consecutive timed-out calls that stop an engine being asked at a site. */
export const BREAKER_THRESHOLD = 3;
/** How long a tripped engine is left alone before one call probes it again. */
export const BREAKER_COOLDOWN_MS = 5 * 60_000;
/** One engine and the tasks of a site it answers. */
export interface RunnerRoute {
	readonly name: string;
	readonly engine: DecisionEngine;
	/** Identity of the engine's configuration, so a repointed target does not inherit the old one's timeouts. */
	readonly digest: string;
	/** The tasks routed to it, or null for the site's own engine, which answers every task not routed elsewhere. */
	readonly tasks: ReadonlyArray<DecisionTask> | null;
}

export interface RunnerBinding {
	/** The site's own engine first, then one route per engine a task is routed to. */
	readonly routes: ReadonlyArray<RunnerRoute>;
	/** The binding's own deadline; replaces the site's, and bounds every route together. */
	readonly timeoutMs?: number;
}

/**
 * The information-flow check every outgoing request passes, supplied by the
 * composition root from the safety domain. Synchronous and content-blind: it
 * judges where the evidence came from (`inherited`) against where it would go.
 * A missing port or a throw allows, so no configuration means no change.
 */
export type DecisionFlowCheck = (request: {
	readonly channel: "system-one";
	readonly site: SiteId;
	readonly task: string;
	readonly destination: {
		readonly targetId: string;
		readonly runtime: string;
		readonly url: string | null;
		readonly model: string | null;
		readonly engine: string;
	};
	readonly inherited?: unknown;
}) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export interface RunnerDeps {
	/**
	 * The session current now, read once when a call starts. A slow answer can
	 * land after the operator switched sessions, and the record it leaves has to
	 * name the session that asked, not the one that happens to be current by then.
	 */
	currentSession?: () => string | null;
	flowCheck?: DecisionFlowCheck;
}

export interface Runner {
	run<O, V>(
		binding: RunnerBinding,
		site: SiteDefinition<O, V>,
		object: O,
		options: RunOptions,
	): Promise<Verdict<V> | null>;
	/**
	 * Resolves when no call is in flight, or after `maxWaitMs`, whichever is first.
	 * A call settles no later than its own deadline, so the wait is also bounded by
	 * the longest one still running. Resolves at once when nothing is in flight.
	 */
	settled(maxWaitMs: number): Promise<void>;
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
	site: SiteId;
	moment: string | null;
}

/** The journal calls a decision's model requests open, collected while its engines run (#429, #434). */
const decisionCalls = new AsyncLocalStorage<Set<string>>();

/** The host's request admission names the call it opened, so system_one.decided can cite it (#429). */
export function noteSystemOneCall(callId: string): void {
	decisionCalls.getStore()?.add(callId);
}

/** The same chars/4 estimate the rest of the harness budgets with. */
function estimateTokens(value: unknown): number {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	return Math.ceil(text.length / 4);
}

/** One key per engine configuration, site and moment, shared by the breaker and the answered builds. */
function momentKey(digest: string, site: SiteId, moment?: string): string {
	return `${digest}|${site}${moment !== undefined ? `|${moment}` : ""}`;
}

function breakerKey(route: RunnerRoute, site: { readonly id: SiteId; readonly moment?: string }): string {
	return momentKey(route.digest, site.id);
}

/** A server that does not know the model answers every later decision the same way, so one request settles it. */
const UNKNOWN_MODEL_RE = /\b400\b.*\bunknown model\b/isu;

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function createRunner(deps: RunnerDeps): Runner {
	// A pre-turn site costs every turn its full deadline when its server hangs.
	// Only timeouts trip the breaker: a refused connection or an unusable answer
	// comes back in milliseconds and costs the turn nothing.
	const breakers = new Map<string, BreakerState>();
	const refused = new Map<string, { digest: string; engine: string; reason: string }>();
	// Calls that have not left their record yet. A turn waits only briefly for a
	// slow answer, and the call goes on to record it whenever it settles, so a
	// process that exits in between would lose the row without something to wait on.
	const inflight = new Set<Promise<unknown>>();

	function sessionAtStart(): string | null | undefined {
		if (deps.currentSession === undefined) return undefined;
		try {
			return deps.currentSession();
		} catch {
			// The record goes without a session and the recorder files it under the one current on arrival.
			return undefined;
		}
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

	function redactAll(questions: Readonly<Record<string, Question>>): Record<string, Question> {
		const out: Record<string, Question> = {};
		for (const [id, question] of Object.entries(questions)) out[id] = redactQuestion(question);
		return out;
	}

	interface RoutePlan {
		readonly route: RunnerRoute;
		readonly tasks: Set<DecisionTask>;
		readonly questions: Record<string, Question>;
		readonly taskOf: Record<string, DecisionTask>;
		readonly abstained: Record<string, string>;
		outcome: CallOutcome;
		reply?: EngineReply;
		error?: string;
	}

	async function runCall<O, V>(
		binding: RunnerBinding,
		site: SiteDefinition<O, V>,
		object: O,
		options: RunOptions,
	): Promise<Verdict<V> | null> {
		const primary = binding.routes[0];
		if (primary === undefined) return null;
		let state: Readonly<Record<string, unknown>> | null;
		// What the sites build from, cleared before any of them can cut it. Only `read` sees the original, and what it
		// returns stays in this process.
		let cleared: O;
		try {
			cleared = clearedSiteObject(object, createRedactionTally());
			const built = site.state(cleared);
			// The state is the operator's prompt and tool output, and a hosted engine
			// (Jev, an LLM API) receives it verbatim. Redacting once here, before the
			// request exists, covers every engine kind and the record alike. The key-name
			// pass stays off because state keys are harness vocabulary (a skill named
			// `token-counter` is a candidate id); the dataset applies it on its own copy.
			state = built === null ? null : scrub(built, createRedactionTally(), false);
		} catch {
			// A site that cannot build its state asks nothing, and nothing is the
			// answer that cannot mislead.
			return null;
		}
		if (state === null) return null;

		const callId = `dc_${randomUUID()}`;
		const session = sessionAtStart();
		const started = performance.now();
		const deadlineMs = binding.timeoutMs ?? site.deadlineMs;
		const plans: RoutePlan[] = binding.routes.map((route) => ({
			route,
			tasks: new Set(route.tasks ?? []),
			questions: {},
			taskOf: {},
			abstained: {},
			outcome: "unsupported",
		}));
		// What this call did to each route's breaker, and the calls its engines opened (#429).
		const breakerMoves = new Map<RoutePlan, "opened" | "probe" | "closed">();
		// A probe that dies without the engine's answer, cancelled or never sent, proves nothing about the engine, so its
		// breaker is half-open again at once instead of reading probing until the probe's deadline (#434).
		const releaseProbe = (plan: RoutePlan): void => {
			const breaker = breakers.get(breakerKey(plan.route, site));
			if (breakerMoves.get(plan) !== "probe" || breaker?.probing !== true) return;
			breaker.probing = false;
			breaker.openUntil = performance.now();
		};
		const callIds = new Set<string>();
		const planOf = (task: DecisionTask): RoutePlan =>
			plans.find((plan, index) => index > 0 && plan.tasks.has(task)) ?? (plans[0] as RoutePlan);

		const finish = (outcome: CallOutcome, detail: { error?: unknown } = {}): number => {
			if (outcome !== "answered") {
				try {
					options.onFailure?.(scrub(errorText(detail.error ?? outcome), createRedactionTally(), false));
				} catch {
					// Diagnostics cannot change the decision's null fallback.
				}
			}
			const latencyMs = Math.round(performance.now() - started);
			recordDecision(outcome, latencyMs);
			return latencyMs;
		};
		const recordDecision = (outcome: string, latencyMs: number): void => {
			if (typeof session !== "string" || session.length === 0) return;
			const asked = plans.filter(
				(plan) => Object.keys(plan.questions).length > 0 || Object.keys(plan.abstained).length > 0,
			);
			const routes: EventPayload<"system_one.decided">["routes"] = (asked.length > 0 ? asked : plans)
				.slice(0, 16)
				.map((plan) => {
					const breaker = breakerMoves.get(plan);
					return {
						engine: plan.route.name,
						kind: plan.route.engine.kind,
						outcome: plan.outcome,
						...(plan.reply?.roundTripMs !== undefined ? { roundTripMs: plan.reply.roundTripMs } : {}),
						...(breaker !== undefined ? { breaker } : {}),
					};
				});
			if (routes.length === 0) return;
			try {
				telemetryHub().emit(
					"system_one.decided",
					{
						site: site.id,
						outcome: outcome as EventPayload<"system_one.decided">["outcome"],
						latencyMs,
						deadlineMs,
						routes,
						callIds: [...callIds],
					},
					// The decision acts for the site's own engine, which routes list first; the routes name every engine asked.
					{ sessionId: session, agent: { role: "system-one", id: plans[0]?.route.name ?? site.id } },
				);
			} catch {
				// The decision's record never changes the decision (#434).
			}
		};

		let questions: Readonly<Record<string, Question>>;
		let serialized: string;
		try {
			// Question text can carry the operator's words (a consult question, a
			// need), so it is redacted like the state, by value only: ids and option
			// keys are the semantic keys answers and cuts are joined by.
			questions = redactAll(site.questions(cleared));
			const ids = Object.keys(questions);
			if (ids.length === 0) throw new Error("the site asked no questions");
			for (const id of ids) {
				const problem = validateQuestion(questions[id] as Question);
				if (problem !== null) throw new Error(`question '${id}': ${problem}`);
			}
			const asked = SITE_TASKS[site.id];
			for (const id of ids) {
				const task = primaryTask(site.id);
				// A task outside the source matrix would be routed by a rule nobody configured.
				if (!asked.includes(task)) throw new Error(`question '${id}': task ${task} is not asked at site ${site.id}`);
				const plan = planOf(task);
				const question = questions[id] as Question;
				const refused = plan.route.engine.unsupported(task, question);
				if (refused !== null) {
					plan.abstained[id] = refused;
					continue;
				}
				plan.questions[id] = question;
				plan.taskOf[id] = task;
			}
			serialized = JSON.stringify(state) ?? "";
		} catch (error) {
			finish("failed", { error });
			return null;
		}

		if (options.signal?.aborted) {
			finish("canceled");
			return null;
		}

		const live = plans.filter((plan) => Object.keys(plan.questions).length > 0);
		if (live.length === 0) {
			// Every question was refused by its engine's profile: the baseline, not a failure.
			finish("unsupported", { error: "no routed engine answers these questions" });
			return null;
		}

		for (const plan of live) {
			const { route } = plan;
			// Laya keeps the head of an oversized state and CLM the tail, both
			// silently, so evidence at the far end is simply not read. An LLM engine
			// truncates or errors at its own window. Asking nothing is the only answer
			// that cannot mislead.
			if (route.engine.windowTokens !== null) {
				const longest = Math.max(0, ...Object.values(plan.questions).map(estimateTokens));
				const needed = estimateTokens(serialized) + longest;
				if (needed > route.engine.windowTokens) {
					plan.outcome = "overflow";
					plan.error = `decision state needs about ${needed} tokens; engine '${route.name}' allows ${route.engine.windowTokens}`;
					continue;
				}
			}
			const refusal = refused.get(route.digest);
			if (refusal !== undefined) {
				plan.outcome = "breaker-open";
				plan.error = refusal.reason;
				continue;
			}
			const breaker = breakers.get(breakerKey(route, site));
			if (breaker !== undefined && breaker.failures >= BREAKER_THRESHOLD && performance.now() < breaker.openUntil) {
				plan.outcome = "breaker-open";
				plan.error = `engine '${route.name}' is cooling down after ${breaker.failures} consecutive timeouts`;
				continue;
			}
			if (deps.flowCheck !== undefined) {
				let verdict: ReturnType<DecisionFlowCheck>;
				try {
					verdict = deps.flowCheck({
						channel: "system-one",
						site: site.id,
						task: [...new Set(Object.values(plan.taskOf))].join(","),
						destination: {
							targetId: route.engine.target,
							runtime: route.engine.runtime,
							url: route.engine.url,
							model: route.engine.model,
							engine: route.name,
						},
						...(options.flow !== undefined ? { inherited: options.flow } : {}),
					});
				} catch (error) {
					// A configured check that cannot answer is not a permit. This call is
					// optional, so it abstains and the evidence stays where it is.
					verdict = { allowed: false, reason: `flow check failed: ${errorText(error)}` };
				}
				if (!verdict.allowed) {
					plan.outcome = "flow-denied";
					plan.error = `flow denied: ${verdict.reason}`;
					continue;
				}
			}
			// Half-open: the first call past the cooldown is the one probe. Parallel tool
			// calls would otherwise each wait a full deadline on an engine that just
			// timed out three times in a row.
			if (breaker !== undefined && breaker.failures >= BREAKER_THRESHOLD) {
				breaker.openUntil = performance.now() + deadlineMs;
				breaker.probing = true;
				breakerMoves.set(plan, "probe");
			}
			plan.outcome = "answered";
		}
		const sending = live.filter((plan) => plan.outcome === "answered");
		if (sending.length === 0) {
			const first = live[0] as RoutePlan;
			finish(first.outcome, { error: first.error });
			return null;
		}

		// Every route shares the one deadline, counted from the call's start, so
		// routing and preflight spend the same budget and a routed task never extends it.
		const remainingMs = deadlineMs - (performance.now() - started);
		if (remainingMs <= 0) {
			for (const plan of sending) {
				// The probe never reached its engine, so this call made no breaker move.
				releaseProbe(plan);
				breakerMoves.delete(plan);
				plan.outcome = "timeout";
			}
			finish("timeout", { error: `decision preflight used the ${deadlineMs}ms deadline` });
			return null;
		}
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error(`decision timed out after ${deadlineMs}ms`));
		}, remainingMs);
		const upstream = options.signal;
		const onUpstreamAbort = () => controller.abort(upstream?.reason);
		upstream?.addEventListener("abort", onUpstreamAbort, { once: true });
		const aborted = new Promise<never>((_resolve, reject) => {
			controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
		});
		// The race loses quietly when the engines settle first.
		aborted.catch(() => {
			// The rejection is consumed by the races below or is irrelevant once they settled.
		});

		try {
			await decisionCalls.run(callIds, () =>
				Promise.all(
					sending.map(async (plan) => {
						const key = breakerKey(plan.route, site);
						try {
							plan.reply = await Promise.race([
								plan.route.engine.decide({
									state: state as Readonly<Record<string, unknown>>,
									questions: plan.questions,
									tasks: plan.taskOf,
									signal: controller.signal,
								}),
								aborted,
							]);
							if (breakers.delete(key)) breakerMoves.set(plan, "closed");
						} catch (error) {
							plan.error = errorText(error);
							if (timedOut) {
								const failures = (breakers.get(key)?.failures ?? 0) + 1;
								breakers.set(key, {
									failures,
									openUntil: failures >= BREAKER_THRESHOLD ? performance.now() + BREAKER_COOLDOWN_MS : 0,
									engine: plan.route.name,
									site: site.id,
									moment: null,
								});
								if (failures >= BREAKER_THRESHOLD) breakerMoves.set(plan, "opened");
								plan.outcome = "timeout";
							} else if (upstream?.aborted === true) {
								releaseProbe(plan);
								plan.outcome = "canceled";
							} else {
								// An answer or a refusal both prove the engine responds.
								if (breakers.delete(key)) breakerMoves.set(plan, "closed");
								plan.outcome = "failed";
								if (UNKNOWN_MODEL_RE.test(plan.error)) {
									const { digest, name } = plan.route;
									refused.set(digest, { digest, engine: name, reason: plan.error });
								}
							}
						}
					}),
				),
			);
		} finally {
			clearTimeout(timer);
			upstream?.removeEventListener("abort", onUpstreamAbort);
		}

		const replied = sending.filter((plan) => plan.reply !== undefined);
		if (replied.length === 0) {
			const first = sending[0] as RoutePlan;
			finish(first.outcome, { error: first.error });
			return null;
		}

		const answers: Record<string, Answer> = {};
		for (const plan of replied) {
			const reply = plan.reply as EngineReply;
			// Only ids this route was asked: an engine cannot answer for another's task.
			for (const id of Object.keys(plan.questions)) {
				const answer = reply.answers[id];
				if (answer !== undefined) answers[id] = answer;
			}
		}
		let value: V | null = null;
		let readError: unknown;
		try {
			value = site.read(answers, object);
		} catch (error) {
			readError = error;
		}
		const latencyMs = finish("answered", readError !== undefined ? { error: readError } : {});
		if (value === null) return null;
		const builds = [...new Set(replied.map((plan) => (plan.reply as EngineReply).build))];
		return { value, callId, engine: primary.name, build: builds.join(" + "), latencyMs };
	}

	function run<O, V>(
		binding: RunnerBinding,
		site: SiteDefinition<O, V>,
		object: O,
		options: RunOptions,
	): Promise<Verdict<V> | null> {
		const call = runCall(binding, site, object, options);
		inflight.add(call);
		const done = (): void => {
			inflight.delete(call);
		};
		call.then(done, done);
		return call;
	}

	async function settled(maxWaitMs: number): Promise<void> {
		const until = performance.now() + Math.max(0, maxWaitMs);
		// A call that starts while this waits is waited for too, inside the same bound.
		while (inflight.size > 0) {
			const left = until - performance.now();
			if (left <= 0) return;
			let timer: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					Promise.allSettled([...inflight]),
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, left);
					}),
				]);
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		}
	}

	function breakerViews(): SystemOneBreakerView[] {
		const now = performance.now();
		const views: SystemOneBreakerView[] = [];
		for (const breaker of breakers.values()) {
			const tripped = breaker.failures >= BREAKER_THRESHOLD;
			const remainingMs = tripped ? Math.max(0, breaker.openUntil - now) : 0;
			views.push({
				engine: breaker.engine,
				site: breaker.site,
				moment: breaker.moment,
				state: !tripped ? "closed" : remainingMs === 0 ? "half-open" : breaker.probing ? "probing" : "open",
				failures: breaker.failures,
				remainingMs,
			});
		}
		return views;
	}

	return { run, settled, breakers: breakerViews, refused: () => [...refused.values()] };
}
