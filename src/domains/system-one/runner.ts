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
import { cutsFor } from "./calibration.js";
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
	RunOptions,
	SiteDefinition,
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

export interface RunnerBinding {
	readonly name: string;
	readonly engine: DecisionEngine;
	/** Identity of the engine's configuration, so a repointed target does not inherit the old one's timeouts. */
	readonly digest: string;
	/** The binding's own deadline; replaces the site's. */
	readonly timeoutMs?: number;
}

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
	/** The build the engine behind this digest last answered with, or null when none answered within the TTL. */
	answeredBuild(digest: string): string | null;
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
	const answered = new Map<string, { build: string; at: number }>();

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

	async function runCall<O, V>(
		binding: RunnerBinding,
		site: SiteDefinition<O, V>,
		object: O,
		options: RunOptions,
	): Promise<Verdict<V> | null> {
		const { engine } = binding;
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
		const finish = (
			outcome: CallOutcome,
			detail: {
				questions?: Readonly<Record<string, Question>>;
				error?: unknown;
				reply?: EngineReply;
				fitted?: boolean;
				policy?: DecisionRecord["policy"];
			} = {},
		): number => {
			const latencyMs = Math.round(performance.now() - started);
			record({
				v: 1,
				callId,
				at,
				...(session !== undefined ? { session } : {}),
				...(options.ref !== undefined ? { ref: options.ref } : {}),
				site: site.id,
				siteVersion: site.version,
				engine: binding.name,
				kind: engine.kind,
				target: engine.target,
				model: engine.model,
				build: detail.reply?.build ?? null,
				outcome,
				...(detail.error !== undefined ? { error: errorText(detail.error) } : {}),
				latencyMs,
				deadlineMs,
				state: state as Readonly<Record<string, unknown>>,
				questions: detail.questions ?? {},
				...(detail.reply !== undefined ? { answers: detail.reply.answers } : {}),
				...(detail.reply?.usage !== undefined ? { usage: detail.reply.usage } : {}),
				...(detail.fitted !== undefined ? { fitted: detail.fitted } : {}),
				...(detail.policy !== undefined ? { policy: detail.policy } : {}),
			});
			return latencyMs;
		};

		let questions: Readonly<Record<string, Question>>;
		let serialized: string;
		try {
			questions = site.questions(object);
			const ids = Object.keys(questions);
			if (ids.length === 0) throw new Error("the site asked no questions");
			for (const id of ids) {
				const problem = validateQuestion(questions[id] as Question);
				if (problem !== null) throw new Error(`question '${id}': ${problem}`);
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

		// Laya keeps the head of an oversized state and CLM the tail, both
		// silently, so evidence at the far end is simply not read. An LLM engine
		// truncates or errors at its own window. Asking nothing is the only answer
		// that cannot mislead.
		if (engine.windowTokens !== null) {
			const longest = Math.max(0, ...Object.values(questions).map(estimateTokens));
			const needed = estimateTokens(serialized) + longest;
			if (needed > engine.windowTokens) {
				finish("overflow", {
					questions,
					error: `decision state needs about ${needed} tokens; engine '${binding.name}' allows ${engine.windowTokens}`,
				});
				return null;
			}
		}

		const breakerKey = `${binding.digest}|${site.id}${site.moment !== undefined ? `|${site.moment}` : ""}`;
		const breaker = breakers.get(breakerKey);
		if (breaker !== undefined && breaker.failures >= BREAKER_THRESHOLD && performance.now() < breaker.openUntil) {
			finish("breaker-open", {
				questions,
				error: `engine '${binding.name}' is cooling down after ${breaker.failures} consecutive timeouts`,
			});
			return null;
		}
		// Half-open: the first call past the cooldown is the one probe. Parallel tool
		// calls would otherwise each wait a full deadline on an engine that just
		// timed out three times in a row.
		if (breaker !== undefined && breaker.failures >= BREAKER_THRESHOLD)
			breaker.openUntil = performance.now() + deadlineMs;

		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error(`decision timed out after ${deadlineMs}ms`));
		}, deadlineMs);
		const upstream = options.signal;
		const onUpstreamAbort = () => controller.abort(upstream?.reason);
		upstream?.addEventListener("abort", onUpstreamAbort, { once: true });
		const aborted = new Promise<never>((_resolve, reject) => {
			controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
		});
		// The race loses quietly when the engine settles first.
		aborted.catch(() => {
			// The rejection is consumed by the race below or is irrelevant once it settled.
		});

		let reply: EngineReply;
		try {
			reply = await Promise.race([engine.decide({ state, questions, signal: controller.signal }), aborted]);
		} catch (error) {
			if (timedOut) {
				const failures = (breakers.get(breakerKey)?.failures ?? 0) + 1;
				breakers.set(breakerKey, {
					failures,
					openUntil: failures >= BREAKER_THRESHOLD ? performance.now() + BREAKER_COOLDOWN_MS : 0,
				});
				finish("timeout", { questions, error });
			} else if (upstream?.aborted === true) {
				finish("canceled", { questions, error });
			} else {
				// An answer or a refusal both prove the engine responds.
				breakers.delete(breakerKey);
				finish("failed", { questions, error });
			}
			return null;
		} finally {
			clearTimeout(timer);
			upstream?.removeEventListener("abort", onUpstreamAbort);
		}
		breakers.delete(breakerKey);
		answered.set(binding.digest, { build: reply.build, at: performance.now() });

		let overrides: ReturnType<typeof deps.cutOverrides> | undefined;
		try {
			overrides = deps.cutOverrides();
		} catch {
			// Unreadable settings leave the fitted table alone, and the call still
			// leaves its one record instead of vanishing with the answer in hand.
		}
		const cuts = cutsFor(reply.build, site.id, overrides);
		let value: V | null = null;
		let readError: unknown;
		try {
			value = site.read(reply.answers as Readonly<Record<string, Answer>>, object, cuts);
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
			reply,
			fitted: cuts.fitted,
			...(readError !== undefined ? { error: readError } : {}),
			...(policy !== undefined ? { policy } : {}),
		});
		if (value === null) return null;
		return { value, callId, engine: binding.name, build: reply.build, fitted: cuts.fitted, latencyMs };
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

	function answeredBuild(digest: string): string | null {
		const last = answered.get(digest);
		return last !== undefined && performance.now() - last.at < ANSWERED_BUILD_TTL_MS ? last.build : null;
	}

	return { run, settled, answeredBuild };
}
