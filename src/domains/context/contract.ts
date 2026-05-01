import type { DomainContract } from "../../core/domain-loader.js";
import type { RunBootstrapInput, RunBootstrapResult } from "./bootstrap.js";
import type { ParsedClioMd } from "./clio-md.js";

export interface ProjectPromptContext {
	text: string;
	clioMd: ParsedClioMd | null;
	warnings: string[];
}

export interface ContextContract extends DomainContract {
	runBootstrap(input?: RunBootstrapInput): Promise<RunBootstrapResult>;
	renderPromptContext(cwd: string): ProjectPromptContext;
}
