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
	 * Canonical paths for this worker's declared intent. Legacy requests without
	 * intent retain path-like task and briefing inference. The prompt compiler
	 * consumes the resolved set without deriving another one.
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

	/**
	 * Compile the canonical stable harness for one mediated fleet worker. The
	 * result's `rulesApplied` and `operatorProfileApplied` are the receipt
	 * provenance for this run's customization layer: dispatch reads them
	 * straight off this return rather than re-deriving them.
	 */
	compileWorkerPrompt(input: CompileWorkerPromptInput): Promise<CompiledSessionPrompt>;

	/** Reload fragment table (triggered by config.hotReload). */
	reload(): void;
}
