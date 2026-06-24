import type { CompiledSessionPrompt, SessionPromptInputs } from "./compiler.js";

export interface CompileSessionPromptInput {
	sessionInputs: SessionPromptInputs;
	autonomy?: string;
	cwd?: string;
	/**
	 * Files already present in the session's working context. Project rules with
	 * `paths:` frontmatter are selected from this set.
	 */
	workingContextPaths?: ReadonlyArray<string>;
}

export interface PromptsContract {
	/**
	 * Compile the session system prompt. Called once per session (and again
	 * only on explicit, logged events: model/target change, autonomy-level
	 * change, fragment reload, session switch). Inputs must be constant for
	 * the session's lifetime.
	 */
	compileSessionPrompt(input: CompileSessionPromptInput): Promise<CompiledSessionPrompt>;

	/** Reload fragment table (triggered by config.hotReload). */
	reload(): void;
}
