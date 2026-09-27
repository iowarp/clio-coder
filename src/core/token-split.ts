export interface TokenSplit {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly totalTokens: number;
	/** "reported" when every contributing source reported usage; otherwise "partial" or "none". */
	readonly provenance: "reported" | "partial" | "none";
}
