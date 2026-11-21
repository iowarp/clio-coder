import type { CapabilityFlags } from "./capability-flags.js";

export interface KnowledgeBaseEntry {
	family: string;
	matchPatterns: ReadonlyArray<string>;
	capabilities: Partial<CapabilityFlags>;
	/**
	 * Unverified model ceilings from the profile file. They label what the model can do,
	 * never what a server serves, so `capabilities.contextWindow` and `capabilities.maxTokens`
	 * from a catalog file are ignored and only these two feed the resolvers.
	 */
	modelMaxContext?: number;
	modelMaxOutput?: number;
	quirks?: Record<string, unknown>;
	/** Product-owned catalog metadata, normalized from either YAML spelling. */
	clioCoder?: Record<string, unknown>;
}

export type MatchKind = "family" | "alias";

export interface KnowledgeBaseHit {
	entry: KnowledgeBaseEntry;
	matchKind: MatchKind;
}

export interface KnowledgeBase {
	/** `runtimeId` lets a runtime-qualified profile win a tie against an unqualified one. */
	lookup(modelId: string, runtimeId?: string): KnowledgeBaseHit | null;
	entries(): ReadonlyArray<KnowledgeBaseEntry>;
}

export interface KnowledgeBaseRoot {
	dir: string;
	/** Missing optional roots are ignored; non-optional roots must exist. */
	optional?: boolean;
}
