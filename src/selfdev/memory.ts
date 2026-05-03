import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface DevMemoryEntry {
	ts: string;
	tags: string[];
	note: string;
}

export interface AppendDevMemoryInput {
	note: string;
	tags?: ReadonlyArray<string>;
}

export interface DevMemoryReadSummary {
	entries: DevMemoryEntry[];
	totalCount: number;
	malformedCount: number;
	rotatedExists: boolean;
}

export interface RecallDevMemorySummary extends DevMemoryReadSummary {
	matchedCount: number;
	returnedCount: number;
	limitApplied: boolean;
}

export interface PruneDevMemoryInput {
	keep?: number;
	dryRun?: boolean;
}

export interface PruneDevMemoryResult {
	dryRun: boolean;
	totalCount: number;
	keptCount: number;
	droppedCount: number;
	malformedCount: number;
	rotatedExists: boolean;
	limitApplied: boolean;
}

const MEMORY_MAX_BYTES = 64 * 1024;
const MEMORY_PROMPT_MAX_BYTES = 4 * 1024;
const MEMORY_PRUNE_DEFAULT_KEEP = 50;
const MEMORY_PRUNE_MAX_KEEP = 500;
const MEMORY_LOCK_STALE_MS = 30_000;
const MEMORY_LOCK_TIMEOUT_MS = 5000;

const memoryWriteQueues = new Map<string, Promise<unknown>>();

export function devMemoryPath(repoRoot: string): string {
	return join(repoRoot, ".clio", "dev-memory.jsonl");
}

function sanitizeTags(tags: ReadonlyArray<string> | undefined): string[] {
	const seen = new Set<string>();
	for (const tag of tags ?? []) {
		const normalized = tag.trim();
		if (normalized.length === 0) continue;
		seen.add(normalized);
	}
	return [...seen].sort((left, right) => left.localeCompare(right));
}

function normalizeLimit(limit: number | undefined): number {
	const raw = limit ?? 10;
	return Number.isFinite(raw) ? Math.max(1, Math.min(50, Math.trunc(raw))) : 10;
}

function normalizeKeep(keep: number | undefined): number {
	const raw = keep ?? MEMORY_PRUNE_DEFAULT_KEEP;
	return Number.isFinite(raw)
		? Math.max(1, Math.min(MEMORY_PRUNE_MAX_KEEP, Math.trunc(raw)))
		: MEMORY_PRUNE_DEFAULT_KEEP;
}

function parseEntry(line: string): DevMemoryEntry | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const value = parsed as Record<string, unknown>;
	if (typeof value.ts !== "string") return null;
	if (typeof value.note !== "string") return null;
	if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) return null;
	return { ts: value.ts, tags: [...value.tags], note: value.note };
}

async function rotateIfNeeded(filePath: string, incomingBytes: number): Promise<void> {
	let currentSize = 0;
	try {
		currentSize = (await stat(filePath)).size;
	} catch {
		return;
	}
	if (currentSize + incomingBytes <= MEMORY_MAX_BYTES) return;
	try {
		await rename(filePath, `${filePath}.1`);
	} catch {
		return;
	}
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
	const deadline = Date.now() + MEMORY_LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			await mkdir(lockPath);
			await writeFile(join(lockPath, "owner"), `${process.pid}\n${Date.now()}\n`, "utf8");
			return async () => {
				await rm(lockPath, { recursive: true, force: true });
			};
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw err;
			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > MEMORY_LOCK_STALE_MS) {
					await rm(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(`dev-memory lock timeout: ${lockPath}`);
			}
			await delay(25);
		}
	}
}

async function withMemoryWriteLock<T>(filePath: string, op: () => Promise<T>): Promise<T> {
	const previous = memoryWriteQueues.get(filePath) ?? Promise.resolve();
	const queued = previous
		.catch(() => undefined)
		.then(async () => {
			await mkdir(dirname(filePath), { recursive: true });
			const release = await acquireLock(`${filePath}.lock`);
			try {
				return await op();
			} finally {
				await release();
			}
		});
	memoryWriteQueues.set(filePath, queued);
	try {
		return await queued;
	} finally {
		if (memoryWriteQueues.get(filePath) === queued) {
			memoryWriteQueues.delete(filePath);
		}
	}
}

/**
 * Append a leading newline if the existing file is non-empty and does not
 * already end in one. Self-heals after a torn write or a crash that left a
 * partial JSON line; without this, the next `appendFile` would concatenate
 * the new entry with the prior fragment and corrupt both lines.
 */
async function ensureNewlineTerminated(filePath: string): Promise<void> {
	let size = 0;
	try {
		size = (await stat(filePath)).size;
	} catch {
		return;
	}
	if (size === 0) return;
	const handle = await open(filePath, "r+");
	try {
		const buf = Buffer.alloc(1);
		await handle.read(buf, 0, 1, size - 1);
		if (buf[0] === 0x0a) return;
	} finally {
		await handle.close();
	}
	await appendFile(filePath, "\n", "utf8");
}

async function readEntriesFromPath(filePath: string): Promise<DevMemoryReadSummary> {
	let raw = "";
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		return { entries: [], totalCount: 0, malformedCount: 0, rotatedExists: await exists(`${filePath}.1`) };
	}
	const entries: DevMemoryEntry[] = [];
	let malformedCount = 0;
	for (const line of raw.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		const entry = parseEntry(line);
		if (entry) entries.push(entry);
		else malformedCount += 1;
	}
	return {
		entries,
		totalCount: entries.length,
		malformedCount,
		rotatedExists: await exists(`${filePath}.1`),
	};
}

async function readEntries(repoRoot: string): Promise<DevMemoryEntry[]> {
	return (await readEntriesFromPath(devMemoryPath(repoRoot))).entries;
}

export async function appendDevMemory(repoRoot: string, input: AppendDevMemoryInput): Promise<{ rowCount: number }> {
	const note = input.note.trim();
	if (note.length === 0) throw new Error("clio_remember requires a non-empty note");
	const filePath = devMemoryPath(repoRoot);
	const entry: DevMemoryEntry = {
		ts: new Date().toISOString(),
		tags: sanitizeTags(input.tags),
		note,
	};
	const line = `${JSON.stringify(entry)}\n`;
	return await withMemoryWriteLock(filePath, async () => {
		await rotateIfNeeded(filePath, Buffer.byteLength(line, "utf8"));
		await ensureNewlineTerminated(filePath);
		await appendFile(filePath, line, "utf8");
		const rowCount = (await readEntries(repoRoot)).length;
		return { rowCount };
	});
}

export async function recallDevMemorySummary(
	repoRoot: string,
	options: { tags?: ReadonlyArray<string>; limit?: number } = {},
): Promise<RecallDevMemorySummary> {
	const tags = sanitizeTags(options.tags);
	const limit = normalizeLimit(options.limit);
	const summary = await readEntriesFromPath(devMemoryPath(repoRoot));
	const matched: DevMemoryEntry[] = [];
	for (const entry of summary.entries) {
		if (tags.length > 0 && !tags.every((tag) => entry.tags.includes(tag))) continue;
		matched.push(entry);
	}
	const returned: DevMemoryEntry[] = [];
	for (let i = matched.length - 1; i >= 0; i--) {
		const entry = matched[i];
		if (!entry) continue;
		returned.push(entry);
		if (returned.length >= limit) break;
	}
	return {
		...summary,
		entries: returned,
		matchedCount: matched.length,
		returnedCount: returned.length,
		limitApplied: matched.length > returned.length,
	};
}

export async function recallDevMemory(
	repoRoot: string,
	options: { tags?: ReadonlyArray<string>; limit?: number } = {},
): Promise<DevMemoryEntry[]> {
	return (await recallDevMemorySummary(repoRoot, options)).entries;
}

export async function pruneDevMemory(repoRoot: string, input: PruneDevMemoryInput = {}): Promise<PruneDevMemoryResult> {
	const filePath = devMemoryPath(repoRoot);
	const keep = normalizeKeep(input.keep);
	const dryRun = input.dryRun !== false;
	return await withMemoryWriteLock(filePath, async () => {
		const summary = await readEntriesFromPath(filePath);
		const kept = summary.entries.slice(Math.max(0, summary.entries.length - keep));
		if (!dryRun) {
			const body = kept.length > 0 ? `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
			await writeFile(filePath, body, "utf8");
		}
		return {
			dryRun,
			totalCount: summary.totalCount,
			keptCount: kept.length,
			droppedCount: summary.totalCount - kept.length,
			malformedCount: summary.malformedCount,
			rotatedExists: summary.rotatedExists,
			limitApplied: summary.totalCount > kept.length,
		};
	});
}

export async function renderDevMemoryFragment(repoRoot: string): Promise<string> {
	const entries = await recallDevMemory(repoRoot, { limit: 50 });
	if (entries.length === 0) return "";
	const lines = ["## Dev memory"];
	const lineBytes = [Buffer.byteLength(`${lines[0]}\n`, "utf8")];
	let used = lineBytes[0] ?? 0;
	let droppedByCap = 0;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const rendered = JSON.stringify(entry);
		const next = Buffer.byteLength(`${rendered}\n`, "utf8");
		if (used + next > MEMORY_PROMPT_MAX_BYTES) {
			droppedByCap = entries.length - i;
			break;
		}
		lines.push(rendered);
		lineBytes.push(next);
		used += next;
	}
	if (droppedByCap > 0) {
		const markerBytesFor = (count: number): number =>
			Buffer.byteLength(
				`[dev-memory truncated: ${count} entr${count === 1 ? "y" : "ies"} omitted by 4096 byte prompt cap]\n`,
				"utf8",
			);
		while (lines.length > 1 && used + markerBytesFor(droppedByCap) > MEMORY_PROMPT_MAX_BYTES) {
			const removedBytes = lineBytes.pop() ?? 0;
			lines.pop();
			used -= removedBytes;
			droppedByCap += 1;
		}
		const marker = `[dev-memory truncated: ${droppedByCap} entr${droppedByCap === 1 ? "y" : "ies"} omitted by 4096 byte prompt cap]`;
		lines.push(marker);
	}
	return lines.join("\n");
}
