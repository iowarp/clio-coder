import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	stat,
	statfs,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fsyncDirectoryAsync, safeResourceWriteAsync } from "../../../core/safe-resource-write.js";
import {
	decodeTagSegment,
	isRecordsTag,
	storeBlobPath,
	storeProjectDir,
	storeProjectRoot,
	storeRoot,
	storeTagDir,
	validateBlobName,
	validateTagName,
} from "../../../core/store-paths.js";
import { clioDataDir } from "../../../core/xdg.js";
import { withFileMutationQueue } from "../../../tools/file-mutation-queue.js";
import type { StoreBackend } from "../backend.js";
import { withStoreLock } from "../lock.js";
import { type StoreBackendFacts, type StoreBlobStat, StoreRefusal } from "../types.js";

const XATTR_KEY_MAX_BYTES = 255;
const XATTR_VALUE_MAX_BYTES = 64 * 1024;
const RECORD_MAX_BYTES = 64 * 1024;

function errnoOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Every method throws StoreRefusal and nothing else, so OS errors are mapped here. */
function refusalFrom(error: unknown): StoreRefusal {
	if (error instanceof StoreRefusal) return error;
	if (errnoOf(error) === "ENOSPC") {
		return new StoreRefusal("no-space", `The store's file system is full: ${messageOf(error)}`);
	}
	return new StoreRefusal("io", messageOf(error));
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw refusalFrom(error);
	}
}

/** A records tag (`<tag>/.records`) is valid when its base tag is; validateTagName reserves the dot for it. */
function tagProblem(tag: string): string | null {
	return validateTagName(tag, { allowRecords: true });
}

function checkTag(tag: string): void {
	const problem = tagProblem(tag);
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
}

const RECORD_NAME = /^(.+)#\d{8}$/u;

/** In a records tag a blob is named `<blob>#<8-digit seq>` (M-23), the one place `#` is allowed. */
function checkBlob(tag: string, blob: string): void {
	const record = isRecordsTag(tag) ? RECORD_NAME.exec(blob) : null;
	const problem = validateBlobName(record?.[1] ?? blob);
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
}

async function lstatOrNull(target: string) {
	try {
		return await lstat(target);
	} catch (error) {
		if (errnoOf(error) === "ENOENT" || errnoOf(error) === "ENOTDIR") return null;
		throw error;
	}
}

/** realpath of the deepest existing ancestor, with the missing tail joined back on. */
async function resolveDeepest(target: string): Promise<string> {
	const tail: string[] = [];
	let current = path.resolve(target);
	for (;;) {
		try {
			return path.join(await realpath(current), ...tail.reverse());
		} catch (error) {
			if (errnoOf(error) !== "ENOENT" && errnoOf(error) !== "ENOTDIR") throw error;
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(target);
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

/** tempSibling's name shape, so list hides only the backend's own temps and still lists a blob named `*.tmp`. */
const TEMP_SIBLING = /^\..+\.\d+\.[0-9a-f]{12}\.tmp$/u;

function tempSibling(target: string): string {
	const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`;
	return path.join(path.dirname(target), `.${path.basename(target)}.${suffix}.tmp`);
}

async function fsyncFile(filePath: string): Promise<void> {
	// Windows FlushFileBuffers requires a handle opened with write access.
	const handle = await open(filePath, process.platform === "win32" ? "r+" : "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Create target with data exactly once. The bytes go to a private temp name
 * first and link() publishes them, so a crash never leaves a short file under
 * the real name, and link's EEXIST picks one winner as open("wx") would.
 */
async function createExclusive(target: string, data: Uint8Array | string): Promise<boolean> {
	await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	const temp = tempSibling(target);
	try {
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(data);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await link(temp, target);
		} catch (error) {
			if (errnoOf(error) === "EEXIST") return false;
			throw error;
		}
		await fsyncDirectoryAsync(path.dirname(target));
		return true;
	} finally {
		await rm(temp, { force: true });
	}
}

interface TagFile {
	v: 1;
	tag: string;
	xattrs: Record<string, string>;
	createdAt: string;
}

/** Directories sort as `name/`, so a depth-first walk yields full names in sorted order. */
function walkKey(entry: Dirent): string {
	return entry.isDirectory() ? `${entry.name}/` : entry.name;
}

/** The local backend: one host, one directory tree, no tiers, no replication, no blob versions. */
export function createLocalStoreBackend(cwd: string): StoreBackend {
	const projectDir = storeProjectDir(cwd);
	const tagsDir = path.join(projectDir, "tags");

	async function assertUnderProject(target: string): Promise<void> {
		const root = await resolveDeepest(projectDir);
		const resolved = await resolveDeepest(target);
		if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
			throw new StoreRefusal("is-link", `Refusing a store path that resolves outside this project's store: ${target}`);
		}
	}

	async function requireTag(tag: string): Promise<string> {
		checkTag(tag);
		const dir = storeTagDir(cwd, tag);
		await assertUnderProject(dir);
		const info = await lstatOrNull(path.join(dir, "tag.json"));
		if (!info?.isFile()) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
		return dir;
	}

	/** Refuse when the blob, or any existing directory between `blobs/` and it, is a symbolic link. */
	async function blobTarget(tag: string, blob: string): Promise<string> {
		checkTag(tag);
		checkBlob(tag, blob);
		const target = storeBlobPath(cwd, tag, blob);
		const blobsDir = path.join(storeTagDir(cwd, tag), "blobs");
		await assertUnderProject(blobsDir);
		let current = blobsDir;
		for (const segment of blob.split("/")) {
			current = path.join(current, segment);
			const info = await lstatOrNull(current);
			if (info === null) break;
			if (info.isSymbolicLink()) {
				throw new StoreRefusal("is-link", `Refusing blob ${blob} in tag ${tag}: ${current} is a symbolic link.`);
			}
		}
		await assertUnderProject(target);
		return target;
	}

	/** A blob cannot nest under another blob, nor take the name of a directory holding blobs. */
	async function refuseNameConflict(tag: string, blob: string): Promise<void> {
		const blobsDir = path.join(storeTagDir(cwd, tag), "blobs");
		const segments = blob.split("/");
		let current = blobsDir;
		for (const [index, segment] of segments.entries()) {
			current = path.join(current, segment);
			const info = await lstatOrNull(current);
			if (info === null) return;
			const prefix = segments.slice(0, index + 1).join("/");
			if (index < segments.length - 1 && !info.isDirectory()) {
				throw new StoreRefusal(
					"exists",
					`Refusing blob ${blob} in tag ${tag}: it would nest under the existing blob ${prefix}.`,
				);
			}
			if (index === segments.length - 1 && info.isDirectory()) {
				const inside = (await readdir(current)).find((name) => !TEMP_SIBLING.test(name));
				const example = inside === undefined ? "" : ` (for example ${blob}/${inside})`;
				throw new StoreRefusal(
					"exists",
					`Refusing blob ${blob} in tag ${tag}: existing blobs are stored under that name${example}.`,
				);
			}
		}
	}

	async function readTagFile(tag: string): Promise<TagFile> {
		const dir = await requireTag(tag);
		return JSON.parse(await readFile(path.join(dir, "tag.json"), "utf8")) as TagFile;
	}

	async function getOrCreateTag(tag: string): Promise<{ created: boolean }> {
		checkTag(tag);
		const dir = storeTagDir(cwd, tag);
		await assertUnderProject(dir);
		// Blobs and records hold workspace bytes, argv and session ids, so the store is owner-only like
		// transcripts; clioDataDir gives a missing data root its 0700 mode and root marker first.
		clioDataDir();
		await mkdir(path.join(dir, "blobs"), { recursive: true, mode: 0o700 });
		await assertUnderProject(path.join(dir, "blobs"));
		const createdAt = new Date().toISOString();
		await createExclusive(
			path.join(projectDir, "project.json"),
			`${JSON.stringify({ v: 1, root: storeProjectRoot(cwd), createdAt })}\n`,
		);
		const tagFile: TagFile = { v: 1, tag, xattrs: {}, createdAt };
		return { created: await createExclusive(path.join(dir, "tag.json"), `${JSON.stringify(tagFile)}\n`) };
	}

	return {
		kind: "local",

		facts: () =>
			guarded(async (): Promise<StoreBackendFacts> => {
				let freeBytes: number | null = null;
				try {
					const info = await statfs(storeRoot());
					freeBytes = Number(info.bavail) * Number(info.bsize);
				} catch {
					// No store root yet, or a file system without statfs: null is the honest answer.
				}
				return {
					kind: "local",
					mapping: "a tag is a directory and a blob is a regular file under it",
					tiers: false,
					multiNode: false,
					durable: true,
					conditionalPut: "if-absent",
					blobVersions: false,
					freeBytes,
				};
			}),

		getOrCreateTag: (tag) => guarded(() => getOrCreateTag(tag)),

		tagExists: (tag) =>
			guarded(async () => {
				try {
					await requireTag(tag);
					return true;
				} catch (error) {
					if (error instanceof StoreRefusal && error.reason === "not-found") return false;
					throw error;
				}
			}),

		listTags: () =>
			guarded(async () => {
				let entries: string[];
				try {
					entries = await readdir(tagsDir);
				} catch (error) {
					if (errnoOf(error) === "ENOENT") return [];
					throw error;
				}
				const tags: string[] = [];
				for (const segment of entries) {
					let tag: string;
					try {
						tag = decodeTagSegment(segment);
					} catch {
						// An undecodable directory name is not a tag this store wrote.
						continue;
					}
					if (tagProblem(tag) !== null) continue;
					try {
						JSON.parse(await readFile(path.join(tagsDir, segment, "tag.json"), "utf8"));
						tags.push(tag);
					} catch {
						// Without a readable tag.json the directory is not a tag (a crashed create, or a stray).
					}
				}
				return tags.sort();
			}),

		delTag: (tag) =>
			guarded(async () => {
				checkTag(tag);
				const dir = storeTagDir(cwd, tag);
				await assertUnderProject(dir);
				await rm(dir, { recursive: true, force: true });
			}),

		setTagXattr: (tag, key, value) =>
			guarded(async () => {
				if (key.length === 0 || Buffer.byteLength(key, "utf8") > XATTR_KEY_MAX_BYTES) {
					throw new StoreRefusal("invalid-name", `A tag attribute key must be 1 to ${XATTR_KEY_MAX_BYTES} bytes.`);
				}
				if (Buffer.byteLength(value, "utf8") > XATTR_VALUE_MAX_BYTES) {
					throw new StoreRefusal("invalid-name", `A tag attribute value must be at most ${XATTR_VALUE_MAX_BYTES} bytes.`);
				}
				const file = path.join(await requireTag(tag), "tag.json");
				// The queue orders writers in this process; the store lock orders them across processes.
				await withFileMutationQueue(file, () =>
					withStoreLock(cwd, `tag.json\0${tag}`, async () => {
						const current = await readTagFile(tag);
						current.xattrs = { ...current.xattrs, [key]: value };
						await safeResourceWriteAsync(file, `${JSON.stringify(current)}\n`, { mode: 0o600 });
					}),
				);
			}),

		getTagXattrs: (tag) => guarded(async () => ({ ...(await readTagFile(tag)).xattrs })),

		putBlobFromFile: (tag, blob, source, signal) =>
			guarded(async (): Promise<StoreBlobStat> => {
				await requireTag(tag);
				const target = await blobTarget(tag, blob);
				let sourceInfo: Awaited<ReturnType<typeof stat>>;
				try {
					sourceInfo = await stat(source);
				} catch (error) {
					if (errnoOf(error) === "ENOENT") throw new StoreRefusal("not-found", `No file at ${source}.`);
					throw error;
				}
				if (!sourceInfo.isFile()) throw new StoreRefusal("not-a-file", `${source} is not a regular file.`);
				if (signal?.aborted) throw new StoreRefusal("io", `The put of ${blob} into ${tag} was aborted.`);
				await refuseNameConflict(tag, blob);
				await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
				// A link may have been planted between the check and mkdir; judge the path again.
				await blobTarget(tag, blob);
				const temp = tempSibling(target);
				try {
					await pipeline(
						createReadStream(source),
						createWriteStream(temp, { flags: "wx", mode: 0o600 }),
						...(signal !== undefined ? [{ signal }] : []),
					);
					await fsyncFile(temp);
					if (signal?.aborted) throw new StoreRefusal("io", `The put of ${blob} into ${tag} was aborted.`);
					await rename(temp, target);
				} catch (error) {
					await rm(temp, { force: true });
					if (signal?.aborted) throw new StoreRefusal("io", `The put of ${blob} into ${tag} was aborted.`);
					throw error;
				}
				await fsyncDirectoryAsync(path.dirname(target));
				const info = await lstat(target);
				return { bytes: info.size, modifiedMs: info.mtimeMs, version: null };
			}),

		getBlobAsPath: (tag, blob) =>
			guarded(async () => {
				const target = await blobTarget(tag, blob);
				const info = await lstatOrNull(target);
				if (info === null) throw new StoreRefusal("not-found", `Tag ${tag} has no blob named ${blob}.`);
				if (!info.isFile()) throw new StoreRefusal("not-a-file", `Blob ${blob} in tag ${tag} is not a regular file.`);
				return { path: target, copied: false };
			}),

		putRecordIfAbsent: (tag, blob, data) =>
			guarded(async () => {
				if (data.byteLength > RECORD_MAX_BYTES) {
					throw new StoreRefusal("invalid-name", `A record must be at most ${RECORD_MAX_BYTES} bytes.`);
				}
				// A record in a tag nobody created would be invisible to listTags, so the tag comes first.
				await getOrCreateTag(tag);
				const target = await blobTarget(tag, blob);
				return (await createExclusive(target, data)) ? "written" : "exists";
			}),

		getRecord: (tag, blob) =>
			guarded(async () => {
				const target = await blobTarget(tag, blob);
				const info = await lstatOrNull(target);
				if (info === null) return null;
				if (!info.isFile()) throw new StoreRefusal("not-a-file", `Record ${blob} in tag ${tag} is not a regular file.`);
				if (info.size > RECORD_MAX_BYTES) {
					throw new StoreRefusal("io", `Record ${blob} in tag ${tag} is larger than ${RECORD_MAX_BYTES} bytes.`);
				}
				return new Uint8Array(await readFile(target));
			}),

		statBlob: (tag, blob) =>
			guarded(async () => {
				const info = await lstatOrNull(await blobTarget(tag, blob));
				if (!info?.isFile()) return null;
				return { bytes: info.size, modifiedMs: info.mtimeMs, version: null };
			}),

		listBlobs: (tag, q) =>
			guarded(async () => {
				const blobsDir = path.join(await requireTag(tag), "blobs");
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
				const walk = async (dir: string, prefix: string): Promise<void> => {
					let entries: Dirent[];
					try {
						entries = await readdir(dir, { withFileTypes: true });
					} catch (error) {
						if (errnoOf(error) === "ENOENT") return;
						throw error;
					}
					entries.sort((a, b) => {
						const left = walkKey(a);
						const right = walkKey(b);
						return left < right ? -1 : left > right ? 1 : 0;
					});
					for (const entry of entries) {
						if (matches.length >= wanted) return;
						const name = `${prefix}${entry.name}`;
						// Dirent types come from lstat, so a link is neither a directory nor a file here.
						if (entry.isDirectory()) {
							await walk(path.join(dir, entry.name), `${name}/`);
						} else if (entry.isFile() && !TEMP_SIBLING.test(entry.name)) {
							if (matcher === null || matcher.test(name)) matches.push(name);
						}
					}
				};
				await walk(blobsDir, "");
				return { names: matches.slice(offset, offset + limit), hasMore: matches.length > offset + limit };
			}),

		delBlob: (tag, blob) =>
			guarded(async () => {
				const target = await blobTarget(tag, blob);
				const info = await lstatOrNull(target);
				if (!info?.isFile()) return false;
				await unlink(target);
				const blobsDir = path.join(storeTagDir(cwd, tag), "blobs");
				let dir = path.dirname(target);
				while (dir.startsWith(`${blobsDir}${path.sep}`)) {
					try {
						await rmdir(dir);
					} catch {
						// Not empty, or already gone: either way the walk up stops here.
						break;
					}
					dir = path.dirname(dir);
				}
				return true;
			}),

		blobRefOfPath: async (realPath) => {
			const root = await realpath(projectDir).catch(() => null);
			if (root === null) return null;
			const [tags, encodedTag, blobs, ...rest] = path.relative(root, realPath).split(path.sep);
			if (tags !== "tags" || encodedTag === undefined || blobs !== "blobs" || rest.length === 0) return null;
			return { tag: decodeTagSegment(encodedTag), blob: rest.join("/") };
		},
	};
}
