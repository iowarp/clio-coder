import type { RuntimeAdapter } from "../../runtime-contract.js";
import { claudeCodeCliAdapter } from "./claude-code.js";
import { codexCliAdapter } from "./codex.js";
import { copilotCliAdapter } from "./copilot.js";
import { geminiCliAdapter } from "./gemini.js";
import { opencodeCliAdapter } from "./opencode.js";
import { piCodingAgentCliAdapter } from "./pi-coding-agent.js";

export { claudeCodeCliAdapter } from "./claude-code.js";
export { codexCliAdapter } from "./codex.js";
export { copilotCliAdapter } from "./copilot.js";
export { geminiCliAdapter } from "./gemini.js";
export { opencodeCliAdapter } from "./opencode.js";
export { piCodingAgentCliAdapter } from "./pi-coding-agent.js";

export const CLI_ADAPTERS: ReadonlyArray<RuntimeAdapter> = [
	piCodingAgentCliAdapter,
	claudeCodeCliAdapter,
	codexCliAdapter,
	geminiCliAdapter,
	opencodeCliAdapter,
	copilotCliAdapter,
];
