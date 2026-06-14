import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { getMarketplaceSkills } from "./skills/marketplace.js";

/**
 * Live marketplace listing for the Skills Hub. The source of truth is the
 * `skills/` tree of github.com/iowarp/clio-coder@main, reached through the
 * GitHub contents API for the listing and raw.githubusercontent.com for the
 * per-skill SKILL.md. Responses are cached on disk so the hub opens instantly
 * and the unauthenticated rate limit (60/hour) is respected; offline or
 * rate-limited sessions fall back first to the cache, then to the pinned
 * local marketplace list.
 */

export interface RemoteSkill {
	name: string;
	repoUrl: string;
}

/** Structured SKILL.md content; presentation belongs to the overlay layer. */
export interface RemoteSkillDetail {
	description?: string;
	version?: string;
	/** Markdown body with the frontmatter block stripped. */
	body: string;
	/** Where the detail came from, so the hub can label offline content. */
	source: "remote" | "cache" | "pinned";
}

interface CacheData {
	/** Epoch ms of the last successful listing fetch; absent until one succeeds. */
	listingTimestamp?: number;
	/** Epoch ms of the last successful detail fetch; absent until one succeeds. */
	detailTimestamp?: number;
	skills: RemoteSkill[];
	details: Record<string, { description?: string; version?: string; body: string }>;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard ceiling on any single marketplace request so the hub never hangs. */
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_FILENAME = "marketplace-cache.json";
const LISTING_URL = "https://api.github.com/repos/iowarp/clio-coder/contents/skills?ref=main";

export interface RemoteMarketplaceOptions {
	fetchFn?: typeof fetch;
	nowFn?: () => number;
	forceRefresh?: boolean;
	/** Caller lifecycle signal (e.g. the overlay aborts it on close). */
	signal?: AbortSignal;
}

/** Combine the caller's lifecycle signal with a hard per-request timeout. */
function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function cachePath(cacheDir: string): string {
	return path.join(cacheDir, CACHE_FILENAME);
}

function loadCache(cacheDir: string): CacheData | null {
	const file = cachePath(cacheDir);
	if (!existsSync(file)) return null;
	try {
		const data: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof data !== "object" || data === null) return null;
		const record = data as Record<string, unknown>;
		if (!Array.isArray(record.skills)) return null;
		const details = typeof record.details === "object" && record.details !== null ? record.details : {};
		// Legacy caches used one shared `timestamp` for both listing and details;
		// map it onto both so older cache files keep working after the upgrade.
		const legacy = typeof record.timestamp === "number" ? record.timestamp : undefined;
		const listingTimestamp = typeof record.listingTimestamp === "number" ? record.listingTimestamp : legacy;
		const detailTimestamp = typeof record.detailTimestamp === "number" ? record.detailTimestamp : legacy;
		return {
			...(listingTimestamp !== undefined ? { listingTimestamp } : {}),
			...(detailTimestamp !== undefined ? { detailTimestamp } : {}),
			skills: record.skills.filter(isRemoteSkill),
			details: details as CacheData["details"],
		};
	} catch {
		// A corrupt cache file is a miss, never a failure.
		return null;
	}
}

function saveCache(cacheDir: string, cache: CacheData): void {
	try {
		// Atomic temp-file + rename so a concurrent reader or a second writer never
		// sees a half-written cache file.
		safeResourceWrite(cachePath(cacheDir), `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8" });
	} catch {
		// Cache persistence is best-effort; the fetch already succeeded.
	}
}

function isRemoteSkill(value: unknown): value is RemoteSkill {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.name === "string" && record.name.length > 0 && typeof record.repoUrl === "string";
}

interface GithubContentsEntry {
	name: string;
	type: string;
	html_url?: string;
}

function isGithubContentsEntry(value: unknown): value is GithubContentsEntry {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.name === "string" && typeof record.type === "string";
}

/** Reject names that could escape the skills directory when used in paths. */
export function isSafeSkillName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

function pinnedFallback(): RemoteSkill[] {
	return getMarketplaceSkills().map((skill) => ({ name: skill.name, repoUrl: skill.sourceUrl }));
}

export async function fetchRemoteMarketplace(
	cacheDir: string,
	options: RemoteMarketplaceOptions = {},
): Promise<RemoteSkill[]> {
	const now = options.nowFn?.() ?? Date.now();
	const cache = loadCache(cacheDir);
	if (
		!options.forceRefresh &&
		cache &&
		cache.listingTimestamp !== undefined &&
		now - cache.listingTimestamp < CACHE_TTL_MS
	) {
		return cache.skills;
	}
	const fetcher = options.fetchFn ?? fetch;
	try {
		const res = await fetcher(LISTING_URL, {
			headers: { "User-Agent": "clio-coder" },
			signal: requestSignal(options.signal),
		});
		if (!res.ok) throw new Error(`GitHub API returned status ${res.status}`);
		const payload: unknown = await res.json();
		if (!Array.isArray(payload)) throw new Error("GitHub API returned a non-array contents payload");
		const skills = payload
			.filter(isGithubContentsEntry)
			.filter((entry) => entry.type === "dir" && isSafeSkillName(entry.name))
			.map((entry) => ({
				name: entry.name,
				repoUrl: entry.html_url ?? `https://github.com/iowarp/clio-coder/tree/main/skills/${entry.name}`,
			}));
		saveCache(cacheDir, {
			listingTimestamp: now,
			...(cache?.detailTimestamp !== undefined ? { detailTimestamp: cache.detailTimestamp } : {}),
			skills,
			details: cache?.details ?? {},
		});
		return skills;
	} catch {
		if (cache) return cache.skills;
		return pinnedFallback();
	}
}

/** Split SKILL.md into frontmatter fields and the markdown body. */
export function parseSkillMarkdown(content: string): { description?: string; version?: string; body: string } {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { body: content };
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end === -1) return { body: content };
	const fields: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		fields[line.slice(0, colon).trim()] = line
			.slice(colon + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
	}
	return {
		...(fields.description ? { description: fields.description } : {}),
		...(fields.version ? { version: fields.version } : {}),
		body: lines
			.slice(end + 1)
			.join("\n")
			.trim(),
	};
}

export async function fetchRemoteSkillDetail(
	cacheDir: string,
	name: string,
	options: RemoteMarketplaceOptions = {},
): Promise<RemoteSkillDetail> {
	if (!isSafeSkillName(name)) throw new Error(`Unsafe skill name: ${name}`);
	const now = options.nowFn?.() ?? Date.now();
	const cache = loadCache(cacheDir);
	const cached = cache?.details[name];
	if (
		!options.forceRefresh &&
		cache &&
		cached &&
		cache.detailTimestamp !== undefined &&
		now - cache.detailTimestamp < CACHE_TTL_MS
	) {
		return { ...cached, source: "cache" };
	}
	const fetcher = options.fetchFn ?? fetch;
	try {
		const rawUrl = `https://raw.githubusercontent.com/iowarp/clio-coder/main/skills/${name}/SKILL.md`;
		const res = await fetcher(rawUrl, { headers: { "User-Agent": "clio-coder" }, signal: requestSignal(options.signal) });
		if (!res.ok) throw new Error(`Failed to fetch SKILL.md: ${res.status}`);
		const detail = parseSkillMarkdown(await res.text());
		// A detail fetch owns only the detail timestamp; it must never stamp the
		// listing timestamp, or a cold-cache detail fetch would publish an empty
		// `skills` listing that looks fresh for the full TTL.
		const next: CacheData = cache ?? { skills: [], details: {} };
		next.details[name] = detail;
		next.detailTimestamp = now;
		saveCache(cacheDir, next);
		return { ...detail, source: "remote" };
	} catch (err) {
		if (cached) return { ...cached, source: "cache" };
		const pinned = getMarketplaceSkills().find((skill) => skill.name === name);
		if (pinned) return { description: pinned.description, body: "", source: "pinned" };
		throw err;
	}
}
