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

export interface CompileWorkerPromptInput extends WorkerPromptInputs {
	/** Working directory the rule loader and repo-awareness checks run against; defaults to `process.cwd()`. */
	cwd?: string;
	/**
	 * Best-effort paths this worker's run actually touches (from `writeRoots`
	 * and path-like tokens in the task/briefing text), used the same way the
	 * session's `workingContextPaths` selects path-scoped project rules. There
	 * is no structured path field on the model-facing dispatch tool, so this is
	 * inference, not a guarantee: a rule can be missed, never fabricated.
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

	/** Compile the canonical stable harness for one mediated fleet worker. */
	compileWorkerPrompt(input: CompileWorkerPromptInput): Promise<CompiledSessionPrompt>;

	/** Reload fragment table (triggered by config.hotReload). */
	reload(): void;
}
