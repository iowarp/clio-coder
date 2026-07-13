import type { CompiledSessionPrompt, SessionPromptInputs, WorkerPromptInputs } from "./compiler.js";

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

export type CompileWorkerPromptInput = WorkerPromptInputs;

export interface PromptsContract {
	/**
	 * Compile the session system prompt. Called once per session (and again
	 * only on explicit, logged events: model/target change, autonomy-level
	 * change, fragment reload, session switch). Inputs must be constant for
	 * the session's lifetime.
	 */
	compileSessionPrompt(input: CompileSessionPromptInput): Promise<CompiledSessionPrompt>;

	/** Compile the canonical stable harness for one mediated fleet worker. */
	compileWorkerPrompt(input: CompileWorkerPromptInput): Promise<CompiledSessionPrompt>;

	/** Reload fragment table (triggered by config.hotReload). */
	reload(): void;
}
