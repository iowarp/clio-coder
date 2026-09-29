/**
 * An engine over any target whose runtime implements `decide()`: TypeSafe's
 * hosted Jev, `laya-serve`, `clm-serve`, OpenJev, Kev. The wire parsing lives
 * in `postSystemOne`; this converts what it returns into contract answers.
 */

import type { DecisionAnswer, DecisionQuestion } from "../../providers/types/inference.js";
import type { ProbeContext, RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../providers/types/target-descriptor.js";
import { certaintyFromMass } from "../answers.js";
import type { Answer, DecisionEngine, EngineReply, EngineRequest, Question } from "../types.js";
import type { EngineHost } from "./shared.js";
import { resolveToken } from "./shared.js";

export interface SystemOneEngineInput {
	readonly name: string;
	readonly target: TargetDescriptor;
	readonly runtime: RuntimeDescriptor;
	readonly model: string | null;
	readonly host: EngineHost;
}

/**
 * Ceiling for the HTTP layer only. The runner's deadline is the real bound and
 * arrives as the request signal, which the wire honors before this fires.
 */
const HTTP_CEILING_MS = 120_000;

function convert(raw: DecisionAnswer, question: Question): Answer | null {
	if (raw.type !== question.type) return null;
	if (question.type === "noul") {
		if (raw.noul === undefined) return null;
		return {
			type: "noul",
			noul: raw.noul,
			certainty: certaintyFromMass("noul", { noul: raw.noul }),
			calibrated: true,
		};
	}
	if (raw.probabilities === undefined) return null;
	const certainty = certaintyFromMass(question.type, { probabilities: raw.probabilities });
	if (question.type === "choice") {
		if (raw.choice === undefined || !Object.hasOwn(question.criteria, raw.choice)) return null;
		return { type: "choice", choice: raw.choice, probabilities: raw.probabilities, certainty, calibrated: true };
	}
	if (raw.score === undefined) return null;
	return { type: "score", score: raw.score, probabilities: raw.probabilities, certainty, calibrated: true };
}

const NO_CREDENTIALS: ReadonlySet<string> = new Set();

export function createSystemOneEngine(input: SystemOneEngineInput): DecisionEngine {
	const { name, target, runtime, model, host } = input;
	const decide = runtime.decide;
	if (decide === undefined) throw new Error(`runtime '${runtime.id}' does not answer typed decisions`);
	const asked = model ?? target.defaultModel ?? null;
	const window = target.capabilities?.contextWindow ?? runtime.defaultCapabilities.contextWindow;
	return {
		name,
		kind: "systemone",
		target: target.id,
		model,
		windowTokens: typeof window === "number" && Number.isFinite(window) && window > 0 ? window : null,
		async decide(request: EngineRequest): Promise<EngineReply> {
			const authToken = await resolveToken(host, target, runtime, request.signal);
			request.signal.throwIfAborted();
			const ctx: ProbeContext = {
				// The runtimes read this set only to find an env key when no token
				// resolved, and building it reparses the auth store, which a gate or a
				// screen on every tool call must not pay for.
				credentialsPresent: authToken !== undefined ? NO_CREDENTIALS : host.credentialsPresent(),
				httpTimeoutMs: HTTP_CEILING_MS,
				signal: request.signal,
				...(authToken !== undefined ? { authToken } : {}),
			};
			const result = await decide.call(
				runtime,
				target,
				{
					state: request.state,
					questions: request.questions as Record<string, DecisionQuestion>,
					...(model !== null ? { model } : {}),
					signal: request.signal,
				},
				ctx,
			);
			const answers: Record<string, Answer> = {};
			for (const [id, raw] of Object.entries(result.answers)) {
				const question = request.questions[id];
				if (question === undefined) continue;
				const answer = convert(raw, question);
				if (answer !== null) answers[id] = answer;
			}
			if (Object.keys(answers).length === 0) {
				throw new Error(`System One (${target.id}) returned no usable answer`);
			}
			// The wire reports "unknown" when a server names no model. The requested
			// id is no substitute: a server that does not echo its build could be
			// anything, and a fitted cut applied to it would gate on foreign numbers.
			const reported = result.model.trim();
			const build = reported.length > 0 && reported !== "unknown" ? reported : `${target.id}/${asked ?? "default"}`;
			return { build, answers, ...(result.tokensUsed !== undefined ? { usage: result.tokensUsed } : {}) };
		},
	};
}
