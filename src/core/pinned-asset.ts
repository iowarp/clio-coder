import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { readOnlyMode } from "./read-only-mode.js";
import { safeResourceWrite } from "./safe-resource-write.js";

/**
 * A file too large or too rarely used to ship in the package, fetched on first
 * use from one pinned URL, accepted only when its sha256 matches, and kept at
 * `path` (under Clio's cache dir) for every later use. Callers own fallback
 * policy. A caller that passes `retryAfterMs` also gets a failure record beside
 * the cache path: every process on the host skips the download inside that
 * window, so an air-gapped login node pays one bounded wait per window, not one
 * per session.
 */
export interface PinnedAsset {
	/** Plain name for error text, such as "the Ruby tree-sitter grammar". */
	label: string;
	url: string;
	sha256: string;
	path: string;
}

export interface PinnedAssetLoadOptions {
	/** Bounds the whole download, connect phase included. */
	timeoutMs: number;
	/** After a failed download, refuse without fetching for this long, across processes. */
	retryAfterMs?: number;
}

interface FailureRecord {
	/** Epoch ms; read by other processes, so not a monotonic clock. */
	failedAt: number;
	reason: string;
}

function failurePath(asset: PinnedAsset): string {
	return `${asset.path}.unavailable.json`;
}

/** The persisted reason the last download failed, while its retry window is open. */
export function pinnedAssetFailure(asset: PinnedAsset, retryAfterMs: number, now = Date.now()): string | null {
	try {
		const record = JSON.parse(readFileSync(failurePath(asset), "utf8")) as Partial<FailureRecord>;
		if (typeof record.failedAt !== "number" || typeof record.reason !== "string") return null;
		return now - record.failedAt >= 0 && now - record.failedAt < retryAfterMs ? record.reason : null;
	} catch {
		// No record, or one torn by a concurrent writer: either way, try the download.
		return null;
	}
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
 * In read-only mode the cache and its failure record are read but never
 * changed: a download serves this process only. Throws an Error whose message
 * says why in words an operator can act on.
 */
export async function loadPinnedAsset(asset: PinnedAsset, options: PinnedAssetLoadOptions): Promise<Buffer> {
	if (existsSync(asset.path)) {
		const cached = readFileSync(asset.path);
		if (sha256Hex(cached) === asset.sha256) return cached;
	}
	if (options.retryAfterMs !== undefined) {
		const reason = pinnedAssetFailure(asset, options.retryAfterMs);
		if (reason !== null) throw new Error(reason);
	}
	try {
		const bytes = await download(asset, options.timeoutMs);
		if (readOnlyMode()) return bytes;
		safeResourceWrite(asset.path, bytes);
		if (options.retryAfterMs !== undefined) rmSync(failurePath(asset), { force: true });
		return bytes;
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		if (options.retryAfterMs !== undefined && !readOnlyMode()) {
			try {
				safeResourceWrite(failurePath(asset), `${JSON.stringify({ failedAt: Date.now(), reason })}\n`);
			} catch {
				// An unwritable cache dir only costs the next process another bounded attempt.
			}
		}
		throw err;
	}
}

async function download(asset: PinnedAsset, timeoutMs: number): Promise<Buffer> {
	const signal = AbortSignal.timeout(timeoutMs);
	let response: Response;
	try {
		response = await fetch(asset.url, { signal });
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
