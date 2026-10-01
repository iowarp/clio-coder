/**
 * One site call, from object to verdict.
 *
 * The runner owns everything that must hold for every engine: the decision
 * window check, the timeout breaker, the deadline, and the single record each
 * call leaves behind. A caller gets a verdict or null, and null always means
 * it behaves as if System One did not exist, so nothing in here throws.
 */

import { randomUUID } from "node:crypto";
import { createRedactionTally } from "../evidence/redact.js";
import { cutsFor, validationOf } from "./calibration.js";
import type { DecisionTask } from "./contract.js";
import { primaryTask, SITE_TASKS, thresholdIdentity } from "./contract.js";
import { validateQuestion } from "./questions.js";
import { scrub } from "./recorder/scrub.js";
import type {
	Answer,
	CallOutcome,
	DecisionEngine,
	DecisionRecord,
	DecisionRecorder,
	EngineReply,
	Question,
	RouteRecord,
	RunOptions,
	SiteCuts,
	SiteDefinition,
	SiteId,
	Verdict,
} from "./types.js";

/** Consecutive timed-out calls that stop an engine being asked at a site. */
export const BREAKER_THRESHOLD = 3;
/** How long a tripped engine is left alone before one call probes it again. */
export const BREAKER_COOLDOWN_MS = 5 * 60_000;
/**
 * How long the build an engine last answered with is trusted. A server can be
 * upgraded under the same binding, and a caller that skips or detaches calls
 * while the build is unfitted would otherwise never learn of the new build.
 */
export const ANSWERED_BUILD_TTL_MS = 10 * 60_000;

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
	recorder?: () => DecisionRecorder | null;
	/**
	 * The session current now, read once when a call starts. A slow answer can
	 * land after the operator switched sessions, and the record it leaves has to
	 * name the session that asked, not the one that happens to be current by then.
	 */
	currentSession?: () => string | null;
	/** `systemOne.cuts`, read per call so an edited cut applies to the next one. */
	cutOverrides: () => Readonly<Record<string, Readonly<Record<string, number>>>>;
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
	/**
	 * Whether the engine behind this digest last answered `site` from a threshold
	 * identity with any cut there, or null when it has not answered within the TTL.
	 * The identity includes the renderer and site version, which only a call knows.
	 */
	answeredFitted(digest: string, site: SiteId): boolean | null;
}

interface BreakerState {
	failures: number;
	openUntil: number;
}

/** The same chars/4 estimate the rest of the harness budgets with. */
function estimateTokens(value: unknown): number {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
	return Math.ceil(text.length / 4);
}

function breakerKey(route: RunnerRoute, site: { readonly id: SiteId; readonly moment?: string }): string {
	return `${route.digest}|${site.id}${site.moment !== undefined ? `|${site.moment}` : ""}`;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function createRunner(deps: RunnerDeps): Runner {
	// A pre-turn site costs every turn its full deadline when its server hangs.
	// Only timeouts trip the breaker: a refused connection or an unusable answer
	// comes back in milliseconds and costs the turn nothing.
	const breakers = new Map<string, BreakerState>();
	// Calls that have not left their record yet. A turn waits only briefly for a
	// slow answer, and the call goes on to record it whenever it settles, so a
	// process that exits in between would lose the row without something to wait on.
	const inflight = new Set<Promise<unknown>>();
	const answered = new Map<string, { fitted: boolean; at: number }>();

	function sessionAtStart(): string | null | undefined {
		if (deps.currentSession === undefined) return undefined;
		try {
			return deps.currentSession();
		} catch {
			// The record goes without a session and the recorder files it under the one current on arrival.
			return undefined;
		}
	}

	function record(row: DecisionRecord): void {
		try {
			deps.recorder?.()?.decision(row);
		} catch {
			// Recording never costs the decision it describes.
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
		readonly compact: Record<string, Question>;
		readonly abstained: Record<string, string>;
		outcome: CallOutcome;
		reply?: EngineReply;
		error?: string;
		cuts?: SiteCuts;
		identity?: string;
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
		try {
			const built = site.state(object);
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
		const at = new Date().toISOString();
		const session = sessionAtStart();
		const started = performance.now();
		const deadlineMs = binding.timeoutMs ?? site.deadlineMs;
		const plans: RoutePlan[] = binding.routes.map((route) => ({
			route,
			tasks: new Set(route.tasks ?? []),
			questions: {},
			taskOf: {},
			compact: {},
			abstained: {},
			outcome: "unsupported",
		}));
		// Cut keys the site's policy read, so a route's validation names only cuts that mattered.
		const cutKeys = new Set<string>();
		const planOf = (task: DecisionTask): RoutePlan =>
			plans.find((plan, index) => index > 0 && plan.tasks.has(task)) ?? (plans[0] as RoutePlan);

		const finish = (
			outcome: CallOutcome,
			detail: {
				questions?: Readonly<Record<string, Question>>;
				error?: unknown;
				answers?: Readonly<Record<string, Answer>>;
				fitted?: boolean;
				policy?: DecisionRecord["policy"];
			} = {},
		): number => {
			const latencyMs = Math.round(performance.now() - started);
			const responded = plans.filter((plan) => plan.reply !== undefined);
			// One build names the call only when one engine answered all of it.
			const build = responded.length === 1 ? (responded[0]?.reply?.build ?? null) : null;
			const usage = responded.reduce<{ input: number; output: number } | undefined>((sum, plan) => {
				const used = plan.reply?.usage;
				if (used === undefined) return sum;
				return { input: (sum?.input ?? 0) + used.input, output: (sum?.output ?? 0) + used.output };
			}, undefined);
			const notes = responded
				.filter((plan) => plan.reply?.note !== undefined)
				.map((plan) => (plans.length > 1 ? `${plan.route.name}: ${plan.reply?.note}` : (plan.reply?.note as string)));
			const routes: RouteRecord[] = plans
				.filter((plan) => Object.keys(plan.questions).length > 0 || Object.keys(plan.abstained).length > 0)
				.map((plan) => {
					const abstained = { ...plan.abstained, ...(plan.reply?.abstained ?? {}) };
					return {
						engine: plan.route.name,
						kind: plan.route.engine.kind,
						target: plan.route.engine.target,
						model: plan.route.engine.model,
						profile: plan.route.engine.profile,
						renderer: plan.route.engine.renderer,
						tasks: [...new Set([...Object.values(plan.taskOf)])],
						questions: Object.keys(plan.questions),
						outcome: plan.outcome,
						build: plan.reply?.build ?? null,
						identity: plan.identity ?? null,
						validation: plan.cuts === undefined ? "none" : plan.cuts.fitted ? validationOf(plan.cuts, cutKeys) : "none",
						...(plan.error !== undefined ? { error: plan.error } : {}),
						...(plan.reply?.note !== undefined ? { note: plan.reply.note } : {}),
						...(Object.keys(abstained).length > 0 ? { abstained } : {}),
						...(plan.reply?.usage !== undefined ? { usage: plan.reply.usage } : {}),
						// What actually left, for replay and training: the semantic question is in `questions`.
						...(plan.reply?.rendered !== undefined ? { rendered: plan.reply.rendered } : {}),
						...(Object.keys(plan.compact).length > 0 && site.compact !== undefined
							? { compactVersion: site.compact.version }
							: {}),
					};
				});
			record({
				v: 1,
				callId,
				at,
				...(session !== undefined ? { session } : {}),
				...(options.ref !== undefined ? { ref: options.ref } : {}),
				site: site.id,
				siteVersion: site.version,
				engine: primary.name,
				kind: primary.engine.kind,
				target: primary.engine.target,
				model: primary.engine.model,
				build,
				outcome,
				...(detail.error !== undefined ? { error: errorText(detail.error) } : {}),
				latencyMs,
				deadlineMs,
				state: state as Readonly<Record<string, unknown>>,
				questions: detail.questions ?? {},
				...(detail.answers !== undefined ? { answers: detail.answers } : {}),
				...(usage !== undefined ? { usage } : {}),
				...(notes.length > 0 ? { note: notes.join("; ") } : {}),
				...(detail.fitted !== undefined ? { fitted: detail.fitted } : {}),
				...(detail.policy !== undefined ? { policy: detail.policy } : {}),
				...(routes.length > 0 ? { routes } : {}),
			});
			return latencyMs;
		};

		let questions: Readonly<Record<string, Question>>;
		let serialized: string;
		try {
			// Question text can carry the operator's words (a consult question, a
			// need), so it is redacted like the state, by value only: ids and option
			// keys are the semantic keys answers and cuts are joined by.
			questions = redactAll(site.questions(object));
			const ids = Object.keys(questions);
			if (ids.length === 0) throw new Error("the site asked no questions");
			for (const id of ids) {
				const problem = validateQuestion(questions[id] as Question);
				if (problem !== null) throw new Error(`question '${id}': ${problem}`);
			}
			const compact = site.compact === undefined ? {} : redactAll(site.compact.questions(object));
			const asked = SITE_TASKS[site.id];
			for (const id of ids) {
				const task = site.taskOf?.(id) ?? primaryTask(site.id);
				// A task outside the source matrix would be routed by a rule nobody configured.
				if (!asked.includes(task)) throw new Error(`question '${id}': task ${task} is not asked at site ${site.id}`);
				const plan = planOf(task);
				const question = questions[id] as Question;
				const short = Object.hasOwn(compact, id) ? compact[id] : undefined;
				const refused = plan.route.engine.unsupported(task, question, short);
				if (refused !== null) {
					plan.abstained[id] = refused;
					continue;
				}
				plan.questions[id] = question;
				plan.taskOf[id] = task;
				if (short !== undefined) plan.compact[id] = short;
			}
			serialized = JSON.stringify(state) ?? "";
		} catch (error) {
			finish("failed", { error });
			return null;
		}

		if (options.signal?.aborted) {
			finish("canceled", { questions });
			return null;
		}

		const live = plans.filter((plan) => Object.keys(plan.questions).length > 0);
		if (live.length === 0) {
			// Every question was refused by its engine's profile: the baseline, not a failure.
			finish("unsupported", { questions, error: "no routed engine answers these questions" });
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
			}
			plan.outcome = "answered";
		}
		const sending = live.filter((plan) => plan.outcome === "answered");
		if (sending.length === 0) {
			const first = live[0] as RoutePlan;
			finish(first.outcome, { questions, error: first.error });
			return null;
		}

		// Every route shares the one deadline, counted from the call's start, so
		// routing and preflight spend the same budget and a routed task never extends it.
		const remainingMs = deadlineMs - (performance.now() - started);
		if (remainingMs <= 0) {
			for (const plan of sending) plan.outcome = "timeout";
			finish("timeout", { questions, error: `decision preflight used the ${deadlineMs}ms deadline` });
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
			await Promise.all(
				sending.map(async (plan) => {
					const key = breakerKey(plan.route, site);
					try {
						plan.reply = await Promise.race([
							plan.route.engine.decide({
								state: state as Readonly<Record<string, unknown>>,
								questions: plan.questions,
								tasks: plan.taskOf,
								...(Object.keys(plan.compact).length > 0 ? { compact: plan.compact } : {}),
								signal: controller.signal,
							}),
							aborted,
						]);
						breakers.delete(key);
					} catch (error) {
						plan.error = errorText(error);
						if (timedOut) {
							const failures = (breakers.get(key)?.failures ?? 0) + 1;
							breakers.set(key, {
								failures,
								openUntil: failures >= BREAKER_THRESHOLD ? performance.now() + BREAKER_COOLDOWN_MS : 0,
							});
							plan.outcome = "timeout";
						} else if (upstream?.aborted === true) {
							plan.outcome = "canceled";
						} else {
							// An answer or a refusal both prove the engine responds.
							breakers.delete(key);
							plan.outcome = "failed";
						}
					}
				}),
			);
		} finally {
			clearTimeout(timer);
			upstream?.removeEventListener("abort", onUpstreamAbort);
		}

		const replied = sending.filter((plan) => plan.reply !== undefined);
		if (replied.length === 0) {
			const first = sending[0] as RoutePlan;
			finish(first.outcome, { questions, error: first.error });
			return null;
		}

		let overrides: ReturnType<typeof deps.cutOverrides> | undefined;
		try {
			overrides = deps.cutOverrides();
		} catch {
			// Unreadable settings leave the fitted table alone, and the call still
			// leaves its one record instead of vanishing with the answer in hand.
		}
		const answers: Record<string, Answer> = {};
		for (const plan of replied) {
			const reply = plan.reply as EngineReply;
			// Only ids this route was asked: an engine cannot answer for another's task.
			for (const id of Object.keys(plan.questions)) {
				const answer = reply.answers[id];
				if (answer !== undefined) answers[id] = answer;
			}
			const compactVersion =
				Object.keys(plan.compact).length > 0 && site.compact !== undefined ? site.compact.version : undefined;
			plan.identity = thresholdIdentity(reply.build, plan.route.engine.renderer, site.version, compactVersion);
			plan.cuts = cutsFor(plan.identity, site.id, overrides, {
				siteVersion: site.version,
				renderer: plan.route.engine.renderer,
			});
			answered.set(`${plan.route.digest}|${site.id}`, { fitted: plan.cuts.fitted, at: performance.now() });
		}
		// A cut is read from the route that answered the task it is compared with,
		// so a Jev cut is never applied to another engine's number.
		const cutPlan = (key: string): RoutePlan | undefined => {
			cutKeys.add(key);
			const plan = planOf(site.cutTask?.(key) ?? primaryTask(site.id));
			return plan.cuts !== undefined && plan.cuts.fitted ? plan : undefined;
		};
		const fitted = replied.some((plan) => plan.cuts?.fitted === true);
		const builds = [...new Set(replied.map((plan) => plan.identity as string))];
		const cuts: SiteCuts = {
			build: builds.join(" + "),
			fitted,
			cut: (key) => cutPlan(key)?.cuts?.cut(key),
			source: (key) => cutPlan(key)?.cuts?.source(key),
		};
		let value: V | null = null;
		let readError: unknown;
		try {
			value = site.read(answers, object, cuts);
		} catch (error) {
			readError = error;
		}
		let policy: DecisionRecord["policy"] | undefined;
		if (value !== null) {
			try {
				policy = site.summarize(value);
			} catch {
				// The verdict stands without its ledger summary.
			}
		}
		const latencyMs = finish("answered", {
			questions,
			answers,
			fitted,
			...(readError !== undefined ? { error: readError } : {}),
			...(policy !== undefined ? { policy } : {}),
		});
		if (value === null) return null;
		const build = replied.length === 1 ? (replied[0]?.reply?.build as string) : cuts.build;
		return { value, callId, engine: primary.name, build, fitted, latencyMs };
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

	function answeredFitted(digest: string, site: SiteId): boolean | null {
		const last = answered.get(`${digest}|${site}`);
		return last !== undefined && performance.now() - last.at < ANSWERED_BUILD_TTL_MS ? last.fitted : null;
	}

	return { run, settled, answeredFitted };
}
