import { type CommunicationPosture, selectCommunicationPosture } from "../prompts/communication-posture.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect } from "./types.js";

export interface CommunicationPostureDeps {
	fragments: Readonly<Record<CommunicationPosture, string>>;
	highRigor: () => boolean;
	testsFirst: () => boolean;
}

/** Selects one short turn reminder from operator text and observed tool results. */
export function createCommunicationPostureRegistration(deps: CommunicationPostureDeps): MiddlewareHookRegistration {
	let recentToolFailures = 0;
	return {
		id: "nudge.communication-posture",
		description: "choose one bounded communication posture for this turn",
		hooks: ["turn_start", "after_tool"],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			if (input.hook === "after_tool") {
				if (input.metadata?.resultKind === "error") recentToolFailures += 1;
				else if (input.metadata?.resultKind === "ok") recentToolFailures = 0;
				return [];
			}
			if (input.hook !== "turn_start") return [];
			const posture = selectCommunicationPosture({
				operatorText: input.text ?? "",
				continuation: input.metadata?.requestContinuation === true,
				recentToolFailures,
				highRigor: deps.highRigor(),
				testsFirst: deps.testsFirst(),
			});
			if (posture === null) return [];
			if (posture === "recovery") recentToolFailures = 0;
			return [{ kind: "inject_reminder", message: `[Communication] ${deps.fragments[posture]}` }];
		},
	};
}
