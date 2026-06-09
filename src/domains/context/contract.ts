import type { DomainContract } from "../../core/domain-loader.js";
import type { RunBootstrapInput, RunBootstrapResult } from "./bootstrap.js";
import type { RunContextClearInput, RunContextClearResult } from "./clear.js";
import type { ParsedClioMd } from "./clio-md.js";

export interface ProjectPromptContext {
	text: string;
	clioMd: ParsedClioMd | null;
	warnings: string[];
}

export interface ContextState {
	clioMd: "ok" | "stale" | "none" | "malformed" | "no-fingerprint";
	memoryCount: number;
}

export interface ContextContract extends DomainContract {
	runBootstrap(input?: RunBootstrapInput): Promise<RunBootstrapResult>;
	runContextClear(input?: RunContextClearInput): Promise<RunContextClearResult>;
	renderPromptContext(cwd: string): ProjectPromptContext;
	contextState(cwd?: string): ContextState;
	startupHints(): string[];
	/**
	 * Incrementally refresh the codewiki for files changed during the session
	 * (e.g. after an edit or write). No-op when the project was never indexed;
	 * full reconciliation still happens at session start and stop. Best-effort:
	 * failures are swallowed so a tool call is never blocked by indexing.
	 */
	noteFileChanges(paths: ReadonlyArray<string>, cwd?: string): void;
}
