import type { ModeName } from "../modes/index.js";
import type { CompileResult, DynamicInputs } from "./compiler.js";

export interface CompileForTurnInput {
	dynamicInputs: DynamicInputs;
	overrideMode?: ModeName;
	safetyLevel?: string;
	cwd?: string;
}

export interface PromptsContract {
	/** Compile the current turn's prompt. Safe to call multiple times per turn. */
	compileForTurn(input: CompileForTurnInput): Promise<CompileResult>;

	/** Self-development worker preamble, present only when selfdev fragments are loaded. */
	getSelfDevWorkerPreamble(): string | null;

	/** Reload fragment table (triggered by config.hotReload). */
	reload(): void;
}
