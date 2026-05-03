import { appendFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
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

const MEMORY_MAX_BYTES = 64 * 1024;
const MEMORY_PROMPT_MAX_BYTES = 4 * 1024;

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

async function readEntries(repoRoot: string): Promise<DevMemoryEntry[]> {
	const filePath = devMemoryPath(repoRoot);
	let raw = "";
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		return [];
	}
	const entries: DevMemoryEntry[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		const entry = parseEntry(line);
		if (entry) entries.push(entry);
	}
	return entries;
}

export async function appendDevMemory(repoRoot: string, input: AppendDevMemoryInput): Promise<{ rowCount: number }> {
	const note = input.note.trim();
	if (note.length === 0) throw new Error("clio_remember requires a non-empty note");
	const filePath = devMemoryPath(repoRoot);
	await mkdir(dirname(filePath), { recursive: true });
	const entry: DevMemoryEntry = {
		ts: new Date().toISOString(),
		tags: sanitizeTags(input.tags),
		note,
	};
	const line = `${JSON.stringify(entry)}\n`;
	await rotateIfNeeded(filePath, Buffer.byteLength(line, "utf8"));
	await ensureNewlineTerminated(filePath);
	await appendFile(filePath, line, "utf8");
	const rowCount = (await readEntries(repoRoot)).length;
	return { rowCount };
}

export async function recallDevMemory(
	repoRoot: string,
	options: { tags?: ReadonlyArray<string>; limit?: number } = {},
): Promise<DevMemoryEntry[]> {
	const tags = sanitizeTags(options.tags);
	const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 10)));
	const entries = await readEntries(repoRoot);
	const filtered: DevMemoryEntry[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) continue;
		if (tags.length > 0 && !tags.every((tag) => entry.tags.includes(tag))) continue;
		filtered.push(entry);
		if (filtered.length >= limit) break;
	}
	return filtered;
}

export async function renderDevMemoryFragment(repoRoot: string): Promise<string> {
	const entries = await recallDevMemory(repoRoot, { limit: 50 });
	if (entries.length === 0) return "";
	const lines = ["## Dev memory"];
	let used = Buffer.byteLength(`${lines[0]}\n`, "utf8");
	for (const entry of entries) {
		const rendered = JSON.stringify(entry);
		const next = Buffer.byteLength(`${rendered}\n`, "utf8");
		if (used + next > MEMORY_PROMPT_MAX_BYTES) break;
		lines.push(rendered);
		used += next;
	}
	return lines.join("\n");
}
