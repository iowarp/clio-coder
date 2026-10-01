/**
 * An engine over any target whose runtime implements `decide()`: TypeSafe's
 * hosted Jev, `laya-serve`, `clm-serve`, OpenJev, Kev. The wire parsing lives
 * in `postSystemOne`; this converts what it returns into contract answers.
 */

import type { DecisionAnswer, DecisionQuestion } from "../../providers/types/inference.js";
import type { ProbeContext, RuntimeDescriptor } from "../../providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../providers/types/target-descriptor.js";
import { certaintyFromMass } from "../answers.js";
import type { DecisionTask, ReadoutKind } from "../contract.js";
import { semanticKind } from "../contract.js";
import type { ProfileId } from "../profiles.js";
import { profileFor, render } from "../profiles.js";
import type { Answer, DecisionEngine, EngineReply, EngineRequest, Question } from "../types.js";
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

function convert(raw: DecisionAnswer, question: Question, readout: ReadoutKind): Answer | null {
	if (raw.type !== question.type) return null;
	if (question.type === "noul") {
		if (raw.noul === undefined) return null;
		return {
			type: "noul",
			noul: raw.noul,
			certainty: certaintyFromMass("noul", { noul: raw.noul }),
			calibrated: true,
			readout,
		};
	}
	if (raw.probabilities === undefined) return null;
	const certainty = certaintyFromMass(question.type, { probabilities: raw.probabilities });
	if (question.type === "choice") {
		if (raw.choice === undefined || !Object.hasOwn(question.criteria, raw.choice)) return null;
		return {
			type: "choice",
			choice: raw.choice,
			probabilities: raw.probabilities,
			certainty,
			calibrated: true,
			readout,
		};
	}
	if (raw.score === undefined) return null;
	return { type: "score", score: raw.score, probabilities: raw.probabilities, certainty, calibrated: true, readout };
}

const NO_CREDENTIALS: ReadonlySet<string> = new Set();

export function createSystemOneEngine(input: SystemOneEngineInput): DecisionEngine {
	const { name, target, runtime, model, host } = input;
	const decide = runtime.decide;
	if (decide === undefined) throw new Error(`runtime '${runtime.id}' does not answer typed decisions`);
	const asked = model ?? target.defaultModel ?? null;
	const profile = profileFor(input.profile);
	const declared = target.capabilities?.contextWindow ?? runtime.defaultCapabilities.contextWindow;
	const window = typeof declared === "number" && Number.isFinite(declared) && declared > 0 ? declared : null;
	// The profile's ceiling bounds what the target claims; neither is raised by the other.
	const windowTokens =
		profile.windowCeiling === null
			? window
			: window === null
				? profile.windowCeiling
				: Math.min(window, profile.windowCeiling);
	return {
		name,
		kind: "systemone",
		target: target.id,
		model,
		windowTokens,
		runtime: runtime.id,
		url: target.url ?? null,
		profile: profile.id,
		renderer: profile.renderer,
		unsupported(task: DecisionTask, question: Question, compact?: Question): string | null {
			const rendered = render(profile, task, question, compact);
			return "abstain" in rendered ? rendered.abstain : null;
		},
		async decide(request: EngineRequest): Promise<EngineReply> {
			// Every question passes the renderer here too, so no caller can reach the
			// wire with one this profile refuses, and what is sent is what was rendered.
			const sent: Record<string, Question> = {};
			const abstained: Record<string, string> = {};
			for (const [id, question] of Object.entries(request.questions)) {
				const rendered = render(profile, request.tasks?.[id] ?? "consult", question, request.compact?.[id]);
				if ("abstain" in rendered) abstained[id] = rendered.abstain;
				else sent[id] = rendered.question;
			}
			if (Object.keys(sent).length === 0) throw new Error(`profile ${profile.id} answers none of the questions`);
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
					questions: sent as Record<string, DecisionQuestion>,
					...(model !== null ? { model } : {}),
					signal: request.signal,
				},
				ctx,
			);
			const answers: Record<string, Answer> = {};
			for (const [id, raw] of Object.entries(result.answers)) {
				const question = sent[id];
				if (question === undefined) continue;
				const task = request.tasks?.[id] ?? "consult";
				const answer = convert(raw, question, profile.readout[semanticKind(task, question.type)]);
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
			return {
				build,
				answers,
				...(result.tokensUsed !== undefined ? { usage: result.tokensUsed } : {}),
				...(Object.keys(abstained).length > 0 ? { abstained } : {}),
				...(profile.renderer !== "systemone-v1" ? { rendered: sent } : {}),
				};
		},
	};
}
