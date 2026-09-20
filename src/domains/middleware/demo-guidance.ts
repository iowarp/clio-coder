import type { MiddlewareHookRegistration } from "./runtime.js";

/** One contextual reminder during substantive interactive work; never a continuation. */
export function createDemoGuidanceRegistration(enabled: () => boolean): MiddlewareHookRegistration {
	let active = false;
	let observations = 0;
	const investigationTools = new Set(["read", "grep", "find", "ls", "code_nav"]);
	return {
		id: "observer.demo-guidance",
		description: "connect an investigation's findings to one useful project capability",
		hooks: ["turn_start", "after_tool", "turn_end"],
		evaluate(input) {
			if (input.hook === "turn_start") {
				active = true;
				observations = 0;
				return [];
			}
			if (input.hook === "turn_end") {
				active = false;
				return [];
			}
			if (!active || !enabled() || input.metadata?.resultKind !== "ok" || !investigationTools.has(input.toolName ?? ""))
				return [];
			if (++observations !== 3) return [];
			active = false;
			return [
				{
					kind: "annotate_tool_result",
					severity: "info",
					message:
						"Demo guidance: use the evidence you are gathering to identify one useful next capability for this actual task. At your next meaningful finding, include a brief concrete offer (for example, checking a change with the relevant tests or assigning an independent question to an available helper). If the action is already requested and authorized, do it. Skip the offer if the user declined suggestions or required a strict output format such as JSON-only. Do not invent an opportunity, repeat a declined offer, or perform extra work solely to demonstrate a feature.",
				},
			];
		},
	};
}
