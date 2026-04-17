import type { ModeName } from "../modes/index.js";
import type { CompileResult, DynamicInputs } from "./compiler.js";

export interface CompileForTurnInput {
	dynamicInputs: DynamicInputs;
	overrideMode?: ModeName;
	safetyLevel?: string;
}

export interface PromptsContract {
	/** Compile the current turn's prompt. Safe to call multiple times per turn. */
	compileForTurn(input: CompileForTurnInput): CompileResult;

	/** Reload fragment table (triggered by config.hotReload). */
	reload(): void;
}
