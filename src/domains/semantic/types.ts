export type SemanticSourceKind = "code" | "wiki" | "memory" | "evidence" | "inbox" | "recording";

export interface SemanticProfile {
	id: string;
	dimensions: number;
	/** Configured asset hashes, projector, quantization, pooling, prefixes, normalization,
	 * preprocessing/extraction recipe and canary fingerprint belong in this identity. */
	profileIdentity: string;
	identity: Readonly<Record<string, unknown>>;
}

export type SemanticInput =
	| { kind: "text"; text: string }
	| { kind: "image" | "audio" | "video"; path: string; mimeType: string; dataBase64?: string };

export type SemanticEmbed = (
	inputs: readonly SemanticInput[],
	options: { task: "query" | "document"; profile: SemanticProfile; signal?: AbortSignal },
) => Promise<{ profileKey: string; vectors: number[][] }>;

export interface SemanticLocation {
	line?: number;
	endLine?: number;
	byte?: number;
	page?: number;
	cell?: number;
	output?: number;
	frame?: number;
	startSeconds?: number;
	endSeconds?: number;
}

export interface SemanticRecord {
	id: string;
	sourceId: string;
	kind: SemanticSourceKind;
	projectId: string;
	scope: "project" | "global";
	path: string;
	contentHash: string;
	extractionVersion: string;
	visibility: "project" | "private" | "global";
	text: string;
	input: SemanticInput;
	location: SemanticLocation;
	mediaType: string;
	runId?: string;
	experimentId?: string;
	updatedAt?: string;
	/** Current eligibility must be supplied again at retrieval, so revoked memory stays hidden. */
	memoryId?: string;
}

export interface SemanticLimits {
	maxRecords: number;
	maxBytes: number;
	maxTextChars: number;
	batchSize: number;
	maxEmbeddingsPerDay: number;
	queryTimeoutMs: number;
	documentTimeoutMs: number;
	searchBudgetMs: number;
}

export interface SemanticFilters {
	projectId: string;
	/** Host-owned path gate applied before scoring; never derive it from model tool arguments. */
	allowsPath?: (path: string) => boolean;
	/** Host-owned source gate, for checking a cached locator against current roots. */
	allowsRecord?: (record: SemanticRecord) => boolean;
	includeGlobal?: boolean;
	kinds?: readonly SemanticSourceKind[];
	runId?: string;
	mediaType?: string;
	after?: string;
	before?: string;
	visibility?: readonly SemanticRecord["visibility"][];
	/** Private records are hidden unless explicitly authorized. */
	includePrivate?: boolean;
	/** Recompute through the memory public eligibility API at query time. Omitted hides memories. */
	eligibleMemoryIds?: readonly string[];
	limit?: number;
}

export interface SemanticHit {
	id: string;
	sourceId: string;
	kind: SemanticSourceKind;
	path: string;
	location: SemanticLocation;
	excerpt: string;
	score: number;
	method: "hybrid" | "lexical" | "exact" | "semantic";
	mediaType: string;
	runId?: string;
	experimentId?: string;
}

export interface SemanticSearchResult {
	hits: SemanticHit[];
	generation: string | null;
	profileKey: string;
	indexedAt: string | null;
	pending: boolean;
	truncated: boolean;
	fallbackReason?: string;
}

export interface SemanticRefreshOptions {
	signal?: AbortSignal;
	maxEmbeddings?: number;
	shouldYield?: () => boolean;
}
