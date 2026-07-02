import type { DomainContract } from "../../core/domain-loader.js";
import type { RunBootstrapInput, RunBootstrapResult } from "./bootstrap.js";
import type { RunContextClearInput, RunContextClearResult } from "./clear.js";
import type { ParsedClioMd } from "./clio-md.js";

export interface ProjectPromptContext {
	text: string;
	clioMd: ParsedClioMd | null;
	warnings: string[];
}

/**
 * Structured CLIO.md fields for bounded injection into worker prompts.
 * Deliberately excludes the identity paragraph and any raw handbook prose.
 */
export interface ProjectStructuredContext {
	projectName: string;
	conventions: ReadonlyArray<string>;
	invariants: ReadonlyArray<string>;
}

export interface ContextState {
	clioMd: "ok" | "stale" | "none" | "malformed" | "no-fingerprint";
	memoryCount: number;
}

export interface ContextContract extends DomainContract {
	runBootstrap(input?: RunBootstrapInput): Promise<RunBootstrapResult>;
	runContextClear(input?: RunContextClearInput): Promise<RunContextClearResult>;
	renderPromptContext(cwd: string): ProjectPromptContext;
	/**
	 * Parsed CLIO.md structured fields (project name, conventions, invariants)
	 * or null when CLIO.md is absent or malformed. Never returns raw handbook
	 * text; used by dispatch to give workers bounded project context.
	 */
	projectStructuredContext(cwd?: string): ProjectStructuredContext | null;
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
