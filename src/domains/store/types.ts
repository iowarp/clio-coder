export type StoreBackendKind = "local" | "clio-core";

export type StoreTagClass = "input" | "output" | "cache" | "archive";

export interface StoreBackendFacts {
	kind: StoreBackendKind;
	/** One sentence: what a tag and a blob are on this backend. */
	mapping: string;
	tiers: false | ReadonlyArray<{ name: string; score: number; freeBytes: number | null }>;
	multiNode: boolean;
	durable: boolean;
	conditionalPut: "if-absent" | "if-absent-and-version";
	blobVersions: boolean;
	freeBytes: number | null;
}

export interface StoreBlobStat {
	bytes: number;
	modifiedMs: number;
	version: number | null;
}

/**
 * What one put stored, observed by the put itself: the size and sha256 of the
 * bytes it streamed and the stat of its own copy before it took the blob's
 * name, so a concurrent writer's bytes never stand in for this put's.
 */
export interface StoreBlobPut extends StoreBlobStat {
	sha256: string;
	/** The backend's own name for the blob: the absolute path on the local backend. */
	key: string;
}

export type StoreRefusalReason =
	| "invalid-name"
	| "not-found"
	| "exists"
	| "not-a-file"
	| "is-link"
	| "no-space"
	| "unavailable"
	| "io";

/** The one error a backend throws for an expected failure. */
export class StoreRefusal extends Error {
	readonly reason: StoreRefusalReason;

	constructor(reason: StoreRefusalReason, message: string) {
		super(message);
		this.name = "StoreRefusal";
		this.reason = reason;
	}
}
