import type { CompileResult, DynamicInputs } from "./compiler.js";

export interface ProjectContextPolicyInput {
	userText?: string;
	turnCount?: number;
	providerSupportsTools?: boolean;
	sendPolicy?: DynamicInputs["sendPolicy"];
	activeToolCount?: number;
}

export interface CompileForTurnInput {
	dynamicInputs: DynamicInputs;
	safetyLevel?: string;
	cwd?: string;
	contextPolicy?: ProjectContextPolicyInput;
}

export interface PromptsContract {
	/** Compile the current turn's prompt. Safe to call multiple times per turn. */
	compileForTurn(input: CompileForTurnInput): Promise<CompileResult>;

	/** Reload fragment table (triggered by config.hotReload). */
	reload(): void;
}
