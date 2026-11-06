/**
 * Parsed SKILL.md frontmatter, cached across processes. YAML parsing was the
 * bulk of a skill catalog load (about 22 ms of a 47-61 ms first load for 34
 * skills), and every boot and every `context(scope="skills")` call paid it
 * again for files that had not changed.
 *
 * An entry is keyed by file path and answers only when the file's mtime and
 * size match and the frontmatter text is byte-identical to what was parsed, so
 * an edit inside one mtime tick still reparses. The file records the Clio
 * version that wrote it and is dropped whole on a version change, because the
 * YAML parser ships with Clio. Only JSON-exact values are cached; a
 * frontmatter whose YAML yields anything JSON cannot carry is parsed every time.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { readClioVersion } from "../../../core/package-root.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { clioCacheDir } from "../../../core/xdg.js";

const CACHE_FILE = "skill-frontmatter.json";
const CACHE_FORMAT = 1;
/** Bounds the file when skill roots churn; a full cache simply stops adding entries. */
const MAX_ENTRIES = 2048;

interface CacheEntry {
	mtimeMs: number;
	size: number;
	text: string;
	/** JSON of the parsed frontmatter; parsed per hit so callers never share objects. */
	json: string;
}

interface CacheFile {
	format: number;
	clioVersion: string;
	entries: Record<string, CacheEntry>;
}

interface LoadedCache {
	file: string;
	/** mtime and size of the file as last read or written; another writer changes them. */
	signature: string;
	entries: Map<string, CacheEntry>;
	touched: Set<string>;
	dirty: boolean;
}

let loaded: LoadedCache | null = null;

function cacheFilePath(): string | null {
	try {
		return path.join(clioCacheDir(), CACHE_FILE);
	} catch {
		// No usable cache root (unwritable XDG dir): parsing uncached is still correct.
		return null;
	}
}

function isEntry(value: unknown): value is CacheEntry {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.mtimeMs === "number" &&
		typeof entry.size === "number" &&
		typeof entry.text === "string" &&
		typeof entry.json === "string"
	);
}

function fileSignature(file: string): string {
	try {
		const stat = statSync(file);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "missing";
	}
}

function readCache(file: string): Map<string, CacheEntry> {
	const entries = new Map<string, CacheEntry>();
	let parsed: Partial<CacheFile>;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheFile>;
	} catch {
		// Missing or corrupt cache: start empty and rewrite it on the next flush.
		return entries;
	}
	if (parsed.format !== CACHE_FORMAT || parsed.clioVersion !== readClioVersion()) return entries;
	if (parsed.entries === null || typeof parsed.entries !== "object") return entries;
	for (const [key, value] of Object.entries(parsed.entries)) {
		if (isEntry(value)) entries.set(key, value);
	}
	return entries;
}

function currentCache(): LoadedCache | null {
	return loaded;
}

function openCache(): void {
	const file = cacheFilePath();
	if (file === null) {
		loaded = null;
		return;
	}
	// Relocated homes move the cache root inside one process, and another
	// process may have added parses since this one last looked.
	const signature = fileSignature(file);
	if (loaded?.file === file && loaded.signature === signature) {
		loaded.touched.clear();
		return;
	}
	loaded = { file, signature, entries: readCache(file), touched: new Set(), dirty: false };
}

/**
 * Run one catalog load against the cache: reopen it if its file changed, then
 * persist new parses and drop entries for skill files that no longer exist.
 */
export function withFrontmatterCache<T>(load: () => T): T {
	openCache();
	try {
		return load();
	} finally {
		flushFrontmatterCache();
	}
}

/** True when JSON round-trips the value exactly, so a cache hit equals a fresh parse. */
function isJsonExact(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
	if (Array.isArray(value)) return value.every(isJsonExact);
	if (typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.values(value as Record<string, unknown>).every(isJsonExact);
}

/**
 * A frontmatter text parser for one skill file, answering from the cache when
 * the file is unchanged. Throws exactly what the YAML parser throws.
 */
export function cachedFrontmatterParser(
	filePath: string,
	stat: { mtimeMs: number; size: number },
): (text: string) => unknown {
	return (text) => {
		const cache = currentCache();
		const hit = cache?.entries.get(filePath);
		if (cache && hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.text === text) {
			cache.touched.add(filePath);
			return JSON.parse(hit.json) as unknown;
		}
		const value = parseYaml(text) as unknown;
		if (cache && isJsonExact(value) && (hit !== undefined || cache.entries.size < MAX_ENTRIES)) {
			cache.entries.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, text, json: JSON.stringify(value) });
			cache.touched.add(filePath);
			cache.dirty = true;
		}
		return value;
	};
}

function pruneMissing(cache: LoadedCache): void {
	for (const filePath of [...cache.entries.keys()]) {
		if (cache.touched.has(filePath)) continue;
		try {
			statSync(filePath);
		} catch {
			cache.entries.delete(filePath);
			cache.dirty = true;
		}
	}
}

function flushFrontmatterCache(): void {
	const cache = loaded;
	if (!cache) return;
	// A pass touches every skill it loaded, so this stats only entries from other roots.
	pruneMissing(cache);
	if (!cache.dirty) return;
	const body: CacheFile = {
		format: CACHE_FORMAT,
		clioVersion: readClioVersion(),
		entries: Object.fromEntries(cache.entries),
	};
	try {
		safeResourceWrite(cache.file, `${JSON.stringify(body)}\n`);
		cache.dirty = false;
		cache.signature = fileSignature(cache.file);
	} catch {
		// The cache is disposable; a failed write costs the next process a reparse, nothing more.
	}
}
