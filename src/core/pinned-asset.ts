import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { safeResourceWrite } from "./safe-resource-write.js";

/**
 * A file too large or too rarely used to ship in the package, fetched on first
 * use from one pinned URL, accepted only when its sha256 matches, and kept at
 * `path` (under Clio's cache dir) for every later use. Callers own retry and
 * fallback policy: this module holds no state, so a failed fetch costs the
 * caller exactly one bounded attempt.
 */
export interface PinnedAsset {
	/** Plain name for error text, such as "the Ruby tree-sitter grammar". */
	label: string;
	url: string;
	sha256: string;
	path: string;
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** True when a file sits at the cache path; the hash is checked only on load. */
export function pinnedAssetPresent(asset: PinnedAsset): boolean {
	return existsSync(asset.path);
}

/**
 * The asset's verified bytes: the cached copy when its hash matches, otherwise
 * one download bounded by `timeoutMs`, verified, then written to the cache.
 * Throws an Error whose message says why in words an operator can act on.
 */
export async function loadPinnedAsset(asset: PinnedAsset, timeoutMs: number): Promise<Buffer> {
	if (existsSync(asset.path)) {
		const cached = readFileSync(asset.path);
		if (sha256Hex(cached) === asset.sha256) return cached;
	}
	let response: Response;
	try {
		response = await fetch(asset.url, { signal: AbortSignal.timeout(timeoutMs) });
	} catch (err) {
		throw new Error(`could not download ${asset.label} from ${asset.url}: ${fetchFailure(err, timeoutMs)}`);
	}
	if (!response.ok) throw new Error(`could not download ${asset.label} from ${asset.url}: HTTP ${response.status}`);
	let bytes: Buffer;
	try {
		bytes = Buffer.from(await response.arrayBuffer());
	} catch (err) {
		throw new Error(`could not download ${asset.label} from ${asset.url}: ${fetchFailure(err, timeoutMs)}`);
	}
	if (sha256Hex(bytes) !== asset.sha256) {
		throw new Error(`${asset.label} downloaded from ${asset.url} does not match its pinned sha256`);
	}
	safeResourceWrite(asset.path, bytes);
	return bytes;
}

/** Undici reports every network failure as "fetch failed"; the cause carries the code worth showing. */
function fetchFailure(err: unknown, timeoutMs: number): string {
	if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
		return `no complete response within ${Math.round(timeoutMs / 1000)}s`;
	}
	const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
	if (cause instanceof Error) {
		const code = (cause as Error & { code?: unknown }).code;
		return typeof code === "string" ? `${code} (${cause.message})` : cause.message;
	}
	return err instanceof Error ? err.message : String(err);
}
