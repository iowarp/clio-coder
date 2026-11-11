import type { StoreBackendFacts, StoreBackendKind, StoreBlobPut, StoreBlobStat } from "./types.js";

/**
 * The store's backend contract, shaped on the clio-core CTE client so a
 * clio-core backend is a mapping and not a redesign. Every method throws
 * `StoreRefusal` for expected failures and nothing else.
 */
export interface StoreBackend {
	readonly kind: StoreBackendKind;
	facts(): Promise<StoreBackendFacts>;
	// Tags. CTE: GetOrCreateTag, TagQuery, DelTag, TagSetXattr/GetXattr.
	getOrCreateTag(tag: string): Promise<{ created: boolean }>;
	tagExists(tag: string): Promise<boolean>;
	/** This project's tags, records tags included. */
	listTags(): Promise<string[]>;
	delTag(tag: string): Promise<void>;
	/** Key at most 255 bytes, value at most 64 KiB. */
	setTagXattr(tag: string, key: string, value: string): Promise<void>;
	getTagXattrs(tag: string): Promise<Record<string, string>>;
	// Whole-object data path. CTE: TruncateBlob then PutBlob at offsets; GetBlob at offsets.
	/** Never re-reads the blob's name to describe the put: a concurrent put may own it by then. */
	putBlobFromFile(tag: string, blob: string, source: string, signal?: AbortSignal): Promise<StoreBlobPut>;
	/** A readable local path. `copied` is true when the backend had to materialize bytes to produce it. */
	getBlobAsPath(tag: string, blob: string, signal?: AbortSignal): Promise<{ path: string; copied: boolean }>;
	// Small records. CTE: PutBlobIfAbsent, GetBlob.
	putRecordIfAbsent(tag: string, blob: string, data: Uint8Array): Promise<"written" | "exists">;
	getRecord(tag: string, blob: string): Promise<Uint8Array | null>;
	// Listing and removal. CTE: GetBlobSize, BlobQuery (full-match regex), DelBlob.
	statBlob(tag: string, blob: string): Promise<StoreBlobStat | null>;
	/** `pattern` is a regular expression matched against the whole blob name (CTE `BlobQuery`); names come back sorted. */
	listBlobs(
		tag: string,
		q: { pattern?: string; offset: number; limit: number },
	): Promise<{ names: string[]; hasMore: boolean }>;
	delBlob(tag: string, blob: string): Promise<boolean>;
	/** The blob whose bytes a resolved local path (a `getBlobAsPath` result) holds, else null; provenance names inputs by it. */
	blobRefOfPath(realPath: string): Promise<{ tag: string; blob: string } | null>;
}
