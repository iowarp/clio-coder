import { INSTRUCTION_SHAPED_WARNING } from "../../core/untrusted-content.js";
import type { MiddlewareRuleDefinition } from "./runtime.js";

/** Raw-body marker detection is supplied by the registry before result shaping. */
export const INJECTION_SCREEN_RULE: MiddlewareRuleDefinition = {
	rule: {
		id: "safety.untrusted-instructions",
		source: "builtin",
		description: "Warn when external tool data contains instruction-shaped markers",
		enabled: true,
		hooks: ["after_tool"],
		effectKinds: ["annotate_tool_result"],
	},
	toolNames: ["web_fetch", "read", "bash", "dispatch", "monitor"],
	predicate: (input) => input.metadata?.untrustedInstructionMarkers === true,
	effects: [
		{
			kind: "annotate_tool_result",
			severity: "warn",
			message: INSTRUCTION_SHAPED_WARNING,
		},
	],
};
