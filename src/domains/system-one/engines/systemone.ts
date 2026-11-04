/**
 * An engine over any target whose runtime implements `decide()`: TypeSafe's
 * hosted Jev, `laya-serve`, `clm-serve`, OpenJev, Kev. The wire parsing lives
 * in `postSystemOne`; this converts what it returns into contract answers.
 */

import type { DecisionAnswer, DecisionQuestion } from "../../providers/types/inference.js";
import type { ProbeContext, RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../providers/types/target-descriptor.js";
import type { ProfileId } from "../profiles.js";
import { engineCapabilities, profileFor } from "../profiles.js";
import type { DecisionEngine, EngineReply, EngineRequest, Question } from "../types.js";
import type { EngineHost } from "./shared.js";
import { resolveToken } from "./shared.js";

export interface SystemOneEngineInput {
	readonly name: string;
	readonly target: TargetDescriptor;
	readonly runtime: RuntimeDescriptor;
	readonly model: string | null;
	readonly host: EngineHost;
	readonly profile?: ProfileId | undefined;
}

/**
 * Ceiling for the HTTP layer only. The runner's deadline is the real bound and
 * arrives as the request signal, which the wire honors before this fires.
 */
const HTTP_CEILING_MS = 120_000;

function convert(raw: DecisionAnswer, question: Question): EngineReply["answers"][string] | null {
	if (raw.type !== question.type) return null;
	if (question.type === "noul") return raw.noul === undefined ? null : { type: "noul", noul: raw.noul };
	if (raw.probabilities === undefined) return null;
	if (question.type === "choice") {
		if (raw.choice === undefined) return null;
		return { type: "choice", choice: raw.choice, probabilities: raw.probabilities };
	}
	if (raw.score === undefined) return null;
	return { type: "score", score: raw.score, probabilities: raw.probabilities };
}

const NO_CREDENTIALS: ReadonlySet<string> = new Set();

export function createSystemOneEngine(input: SystemOneEngineInput): DecisionEngine {
	const { name, target, runtime, model, host } = input;
	const decide = runtime.decide;
	if (decide === undefined) throw new Error(`runtime '${runtime.id}' does not answer typed decisions`);
	const asked = model ?? target.defaultModel ?? runtime.decisionAlias?.defaultModel ?? null;
	const profile = profileFor(input.profile);
	// A profile's tokenizer counts options once it is cached; until then its byte proof applies.
	void profile.tokenizer?.load().catch(() => {
		// A tokenizer that will not load leaves the byte proof in force, which is the stricter bound.
	});
	return {
		name,
		kind: "systemone",
		profile: profile.id,
		capabilities: engineCapabilities(
			profile,
			target.capabilities?.contextWindow ?? runtime.defaultCapabilities.contextWindow,
		),
		destination: {
			targetId: target.id,
			runtimeId: runtime.id,
			wireModelId: asked,
			...(target.url !== undefined ? { url: target.url } : {}),
		},
		async decide(request: EngineRequest): Promise<EngineReply> {
			const authToken = await resolveToken(host, target, runtime, request.signal);
			request.signal.throwIfAborted();
			const ctx: ProbeContext = {
				// The runtimes read this set only to find an env key when no token
				// resolved, and building it reparses the auth store, which a question
				// asked on every tool call must not pay for.
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
			const answers: Record<string, EngineReply["answers"][string]> = {};
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
			// id is no substitute: a server that does not echo its build could be anything.
			const reported = result.model.trim();
			const build = reported.length > 0 && reported !== "unknown" ? reported : `${target.id}/${asked ?? "default"}`;
			return {
				build,
				answers,
				...(result.tokensUsed !== undefined ? { usage: result.tokensUsed } : {}),
				...(result.roundTripMs !== undefined ? { roundTripMs: result.roundTripMs } : {}),
			};
		},
	};
}
