import type { CompiledSessionPrompt, SessionPromptInputs } from "./compiler.js";

export interface CompileSessionPromptInput {
	sessionInputs: SessionPromptInputs;
	safetyLevel?: string;
	cwd?: string;
}

export interface PromptsContract {
	/**
	 * Compile the session system prompt. Called once per session (and again
	 * only on explicit, logged events: model/endpoint change, safety-level
	 * change, fragment reload, session switch). Inputs must be constant for
	 * the session's lifetime.
	 */
	compileSessionPrompt(input: CompileSessionPromptInput): Promise<CompiledSessionPrompt>;

	/** Reload fragment table (triggered by config.hotReload). */
	reload(): void;
}
