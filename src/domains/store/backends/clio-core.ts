import { randomBytes } from "node:crypto";
import { type Dirent, constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, readdir, realpath, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import {
	decodeTagSegment,
	encodeTagSegment,
	isRecordsTag,
	recordsTag,
	STORE_NATIVE_PREFIX,
	storeProjectKey,
	storeProjectRoot,
	validateBlobName,
	validateTagName,
} from "../../../core/store-paths.js";
import { clioCachePath } from "../../../core/xdg.js";
import type { StoreBackend } from "../backend.js";
import type { CoreHost } from "../core-host/supervisor.js";
import { type StoreBackendFacts, type StoreBlobStat, StoreRefusal } from "../types.js";

/** The top of the CTE chain (filesystem 560 over cache 563); the default client binds the bottom, 512.0. */
export const CLIO_CORE_CHAIN_TOP_POOL = "563.0";
export const CLIO_CORE_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const NOT_DURABLE = "the runtime has no durable tier; data would not survive a restart";
const XATTR_KEY_MAX_BYTES = 255;
const XATTR_VALUE_MAX_BYTES = 64 * 1024;
const RECORD_MAX_BYTES = 64 * 1024;
const HOST_LIST_PAGE = 1000;
const RECORD_NAME = /^(.+)#\d{8}$/u;
/** The core host's in-flight put name (`.<leaf>#put-<12 hex>`); one a killed put left behind is never listed. */
const PUT_TEMP = /(?:^|\/)\.[^/]+#put-[0-9a-f]{12}$/u;
/** `materialize`'s download directory beside the cached copies. */
const GET_TEMP = /^\.get-\d+-[0-9a-f]{12}$/u;

export interface ClioCoreStoreOptions {
	/** Pool the host must address; `startCoreHost` was launched with it. Defaults to the chain top. */
	pool?: string;
	/** A `clio_cte_fuse` mount over the same pool; `getBlobAsPath` returns paths in it instead of copying. */
	mount?: string;
	/** Root of the materialization cache; defaults to `<cacheDir>/store`. */
	cacheRoot?: string;
	cacheMaxBytes?: number;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof StoreRefusal) throw error;
		if ((error as NodeJS.ErrnoException | null)?.code === "ENOSPC")
			throw new StoreRefusal("no-space", `The store cache's file system is full: ${messageOf(error)}`);
		throw new StoreRefusal("io", messageOf(error));
	}
}

function checkTag(tag: string): void {
	const problem = validateTagName(tag, { allowRecords: true });
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
}

function checkBlob(tag: string, blob: string): void {
	const record = isRecordsTag(tag) ? RECORD_NAME.exec(blob) : null;
	const problem = validateBlobName(record?.[1] ?? blob);
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** A cached copy is current when its size and its mtime, set to the remote mtime, still match the blob. */
function cacheIsCurrent(cached: { size: number; mtimeMs: number }, remote: StoreBlobStat): boolean {
	return cached.size === remote.bytes && Math.round(cached.mtimeMs) === Math.round(remote.modifiedMs);
}

/** The cache mirrors blob names as paths, so a stale entry can block a new one ("d" cached as a file, "d/e" wanted now); entries are disposable. */
async function clearCachePath(tagDir: string, target: string): Promise<void> {
	for (let dir = path.dirname(target); dir.startsWith(`${tagDir}${path.sep}`); dir = path.dirname(dir)) {
		const info = await lstat(dir).catch(() => null);
		if (info !== null && !info.isDirectory()) await rm(dir, { force: true });
	}
	if ((await lstat(target).catch(() => null))?.isDirectory()) await rm(target, { recursive: true, force: true });
}

async function walkFiles(dir: string, out: { file: string; bytes: number; usedMs: number }[]): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) await walkFiles(full, out);
		else if (entry.isFile()) {
			try {
				const info = await stat(full);
				out.push({ file: full, bytes: info.size, usedMs: info.atimeMs });
			} catch {
				// Removed by a concurrent prune.
			}
		}
	}
}

/** Least recently used first until the cache fits; a cache file's atime is its last use (its mtime is the remote one). */
async function pruneCache(root: string, maxBytes: number, keep: string): Promise<void> {
	const files: { file: string; bytes: number; usedMs: number }[] = [];
	await walkFiles(root, files);
	let total = files.reduce((sum, entry) => sum + entry.bytes, 0);
	files.sort((a, b) => a.usedMs - b.usedMs);
	for (const entry of files) {
		if (total <= maxBytes) return;
		if (entry.file === keep) continue;
		await rm(entry.file, { force: true });
		total -= entry.bytes;
	}
}

/**
 * The clio-core backend: a thin mapping onto a core host (M-35). Tag `T` is the
 * CTE tag `agentspace/<projectKey>/T`; a data blob is the filesystem-module
 * file `/agentspace/<projectKey>/T/B`; records are plain CTE blobs in the
 * records tag. The host receives physical tag names and owns the CTE calls;
 * names, the durability gate and the materialization cache live here. Nothing
 * is written under Clio Coder's data directory. A clio-core space reserved
 * over `agentspace/<projectKey>/` charges both the records and the data blobs.
 */
export async function createClioCoreStoreBackend(
	cwd: string,
	host: CoreHost,
	options: ClioCoreStoreOptions = {},
): Promise<StoreBackend> {
	const pool = options.pool ?? CLIO_CORE_CHAIN_TOP_POOL;
	if (host.hello !== null && host.hello.pool !== pool) {
		throw new StoreRefusal(
			"unavailable",
			`The clio-core host addresses pool ${host.hello.pool}, not ${pool}; restart it with --pool ${pool}.`,
		);
	}
	const projectKey = storeProjectKey(storeProjectRoot(cwd));
	const spacePrefix = `${STORE_NATIVE_PREFIX}/${projectKey}/`;
	const cacheRoot = options.cacheRoot ?? path.join(clioCachePath(), "store");
	const cacheMaxBytes = options.cacheMaxBytes ?? CLIO_CORE_CACHE_MAX_BYTES;
	const durable = (await host.call("facts", {})).durable;

	const physical = (tag: string): string => {
		checkTag(tag);
		// One path segment per tag, as the local layout does: tag "a" blob "b/c" and tag "a/b" blob "c" stay apart.
		return `${spacePrefix}${encodeTagSegment(tag)}`;
	};
	const writable = (): void => {
		if (!durable) throw new StoreRefusal("unavailable", `Refusing the write: ${NOT_DURABLE}.`);
	};

	async function statBlob(tag: string, blob: string): Promise<StoreBlobStat | null> {
		const tagName = physical(tag);
		checkBlob(tag, blob);
		return (await host.call("statBlob", { tag: tagName, blob })).stat;
	}

	const cacheTagDir = (tag: string): string => path.join(cacheRoot, projectKey, encodeTagSegment(tag));

	async function materialize(tag: string, blob: string, signal?: AbortSignal, refetch = false): Promise<string> {
		const info = await statBlob(tag, blob);
		if (info === null) throw new StoreRefusal("not-found", `Tag ${tag} has no blob named ${blob}.`);
		const tagDir = cacheTagDir(tag);
		// The copy keeps the blob's own name (and extension) at a stable path; a replace refreshes it in place.
		const target = path.join(tagDir, blob);
		try {
			const cached = await stat(target);
			if (!refetch && cached.isFile() && cacheIsCurrent(cached, info)) {
				await utimes(target, new Date(), cached.mtime);
				return target;
			}
		} catch {
			// Not cached yet.
		}
		const destDir = path.join(tagDir, `.get-${process.pid}-${randomBytes(6).toString("hex")}`);
		// Cached copies are blob bytes, so they stay owner-only like the local backend's.
		await mkdir(destDir, { recursive: true, mode: 0o700 });
		try {
			const got = await host.call(
				"getBlobAsPath",
				{ tag: physical(tag), blob, destDir },
				{ bytes: info.bytes, ...(signal !== undefined ? { signal } : {}) },
			);
			const relative = path.relative(destDir, got.path);
			if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
				throw new StoreRefusal("io", `The clio-core host wrote ${got.path}, outside ${destDir}.`);
			if ((await stat(got.path)).size !== info.bytes)
				throw new StoreRefusal("io", `Blob ${blob} in tag ${tag} changed while it was being read; try again.`);
			await chmod(got.path, 0o600);
			await utimes(got.path, new Date(), new Date(info.modifiedMs));
			await clearCachePath(tagDir, target);
			await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
			await rename(got.path, target);
		} finally {
			await rm(destDir, { recursive: true, force: true });
		}
		await pruneCache(cacheRoot, cacheMaxBytes, target);
		return target;
	}

	/**
	 * A put through this backend refetches a copy getBlobAsPath already handed
	 * out, so that path reads the new bytes as it would on the local backend; a
	 * same-size replace within one millisecond would otherwise look current.
	 */
	async function refreshCached(tag: string, blob: string, signal?: AbortSignal): Promise<void> {
		const target = path.join(cacheTagDir(tag), blob);
		if (!(await lstat(target).catch(() => null))?.isFile()) return;
		try {
			await materialize(tag, blob, signal, true);
		} catch {
			// The put itself succeeded; dropping the copy is enough to never serve the old bytes.
			await rm(target, { force: true });
		}
	}

	return {
		kind: "clio-core",

		facts: () =>
			guarded(async (): Promise<StoreBackendFacts> => {
				const facts = await host.call("facts", {});
				return {
					...facts,
					kind: "clio-core",
					mapping:
						"a tag is a CTE tag with a filesystem-module directory; a blob is a file there, stored as 1 MiB CTE page blobs; records are CTE blobs",
					conditionalPut: "if-absent-and-version",
					blobVersions: false,
				};
			}),

		getOrCreateTag: (tag) =>
			guarded(async () => {
				const tagName = physical(tag);
				writable();
				return await host.call("getOrCreateTag", { tag: tagName });
			}),

		tagExists: (tag) => guarded(async () => (await host.call("tagExists", { tag: physical(tag) })).exists),

		listTags: () =>
			guarded(async () => {
				const { tags } = await host.call("listTags", { pattern: `^${escapeRegExp(spacePrefix)}.*` });
				return tags
					.filter((name) => name.startsWith(spacePrefix))
					.flatMap((name) => {
						try {
							return [decodeTagSegment(name.slice(spacePrefix.length))];
						} catch {
							return [];
						}
					})
					.filter((tag) => validateTagName(tag, { allowRecords: true }) === null)
					.sort();
			}),

		delTag: (tag) =>
			guarded(async () => {
				const tagName = physical(tag);
				writable();
				await host.call("delTag", { tag: tagName });
				if (!isRecordsTag(tag)) await host.call("delTag", { tag: physical(recordsTag(tag)) });
			}),

		setTagXattr: (tag, key, value) =>
			guarded(async () => {
				const tagName = physical(tag);
				if (key.length === 0 || Buffer.byteLength(key, "utf8") > XATTR_KEY_MAX_BYTES)
					throw new StoreRefusal("invalid-name", `A tag attribute key must be 1 to ${XATTR_KEY_MAX_BYTES} bytes.`);
				if (Buffer.byteLength(value, "utf8") > XATTR_VALUE_MAX_BYTES)
					throw new StoreRefusal("invalid-name", `A tag attribute value must be at most ${XATTR_VALUE_MAX_BYTES} bytes.`);
				writable();
				await host.call("setTagXattr", { tag: tagName, key, value });
			}),

		getTagXattrs: (tag) => guarded(async () => (await host.call("getTagXattrs", { tag: physical(tag) })).xattrs),

		putBlobFromFile: (tag, blob, source, signal) =>
			guarded(async () => {
				const tagName = physical(tag);
				checkBlob(tag, blob);
				writable();
				let info: Awaited<ReturnType<typeof stat>>;
				try {
					info = await stat(source);
				} catch (error) {
					if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT")
						throw new StoreRefusal("not-found", `No file at ${source}.`);
					throw error;
				}
				if (!info.isFile()) throw new StoreRefusal("not-a-file", `${source} is not a regular file.`);
				await access(source, fsConstants.R_OK);
				if (signal?.aborted) throw new StoreRefusal("io", `The put of ${blob} into ${tag} was aborted.`);
				if (!(await host.call("tagExists", { tag: tagName })).exists)
					throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
				const put = await host.call(
					"putBlobFromFile",
					{ tag: tagName, blob, source: path.resolve(source) },
					{ bytes: info.size, ...(signal !== undefined ? { signal } : {}) },
				);
				if (options.mount === undefined) await refreshCached(tag, blob, signal);
				return put;
			}),

		getBlobAsPath: (tag, blob, signal) =>
			guarded(async () => {
				if (options.mount !== undefined) {
					if ((await statBlob(tag, blob)) === null)
						throw new StoreRefusal("not-found", `Tag ${tag} has no blob named ${blob}.`);
					return { path: path.join(options.mount, physical(tag), blob), copied: false };
				}
				return { path: await materialize(tag, blob, signal), copied: true };
			}),

		putRecordIfAbsent: (tag, blob, data) =>
			guarded(async () => {
				const tagName = physical(tag);
				checkBlob(tag, blob);
				if (data.byteLength > RECORD_MAX_BYTES)
					throw new StoreRefusal("invalid-name", `A record must be at most ${RECORD_MAX_BYTES} bytes.`);
				writable();
				await host.call("getOrCreateTag", { tag: tagName });
				const { outcome } = await host.call("putRecordIfAbsent", {
					tag: tagName,
					blob,
					data: Buffer.from(data).toString("base64"),
				});
				return outcome;
			}),

		getRecord: (tag, blob) =>
			guarded(async () => {
				const tagName = physical(tag);
				checkBlob(tag, blob);
				const { data } = await host.call("getRecord", { tag: tagName, blob });
				return data === null ? null : new Uint8Array(Buffer.from(data, "base64"));
			}),

		statBlob: (tag, blob) => guarded(() => statBlob(tag, blob)),

		listBlobs: (tag, q) =>
			guarded(async () => {
				const tagName = physical(tag);
				let matcher: RegExp | null = null;
				if (q.pattern !== undefined) {
					try {
						matcher = new RegExp(`^(?:${q.pattern})$`);
					} catch (error) {
						throw new StoreRefusal("invalid-name", `Invalid blob pattern: ${messageOf(error)}`);
					}
				}
				const offset = Math.max(0, Math.floor(q.offset));
				const limit = Math.max(0, Math.floor(q.limit));
				const wanted = offset + limit + 1;
				const matches: string[] = [];
				for (let page = 0; matches.length < wanted; page += HOST_LIST_PAGE) {
					const { names, hasMore } = await host.call("listBlobs", { tag: tagName, offset: page, limit: HOST_LIST_PAGE });
					for (const name of names) {
						if (!isRecordsTag(tag) && PUT_TEMP.test(name)) continue;
						if (matcher === null || matcher.test(name)) matches.push(name);
					}
					if (!hasMore) break;
				}
				matches.sort();
				return { names: matches.slice(offset, offset + limit), hasMore: matches.length > offset + limit };
			}),

		delBlob: (tag, blob) =>
			guarded(async () => {
				const tagName = physical(tag);
				checkBlob(tag, blob);
				writable();
				return (await host.call("delBlob", { tag: tagName, blob })).deleted;
			}),

		blobRefOfPath: async (realPath) => {
			const segmentsUnder = async (root: string): Promise<string[] | null> => {
				const resolved = await realpath(root).catch(() => null);
				if (resolved === null) return null;
				const relative = path.relative(resolved, realPath);
				if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
				return relative.split(path.sep);
			};
			const named = (tag: string, blob: string) =>
				validateTagName(tag) === null && validateBlobName(blob) === null ? { tag, blob } : null;
			// A cached copy sits at <cache>/<projectKey>/<encoded tag>/<blob>, one segment per tag.
			const cached = await segmentsUnder(path.join(cacheRoot, projectKey));
			if (cached !== null) {
				const [encodedTag, ...rest] = cached;
				if (encodedTag === undefined || rest.length === 0 || GET_TEMP.test(rest[0] ?? "")) return null;
				try {
					return named(decodeTagSegment(encodedTag), rest.join("/"));
				} catch {
					// A malformed escape is no tag of ours.
					return null;
				}
			}
			if (options.mount === undefined) return null;
			// The first segment under the project is the encoded tag; the rest is the blob.
			const viewed = await segmentsUnder(path.join(options.mount, spacePrefix));
			if (viewed === null || viewed.length < 2) return null;
			let ref: ReturnType<typeof named>;
			try {
				ref = named(decodeTagSegment(viewed[0] ?? ""), viewed.slice(1).join("/"));
			} catch {
				return null;
			}
			if (ref !== null && (await statBlob(ref.tag, ref.blob).catch(() => null)) !== null) return ref;
			return null;
		},
	};
}
