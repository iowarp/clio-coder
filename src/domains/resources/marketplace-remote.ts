import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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
	timestamp: number;
	skills: RemoteSkill[];
	details: Record<string, { description?: string; version?: string; body: string }>;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILENAME = "marketplace-cache.json";
const LISTING_URL = "https://api.github.com/repos/iowarp/clio-coder/contents/skills?ref=main";

export interface RemoteMarketplaceOptions {
	fetchFn?: typeof fetch;
	nowFn?: () => number;
	forceRefresh?: boolean;
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
		if (typeof record.timestamp !== "number" || !Array.isArray(record.skills)) return null;
		const details = typeof record.details === "object" && record.details !== null ? record.details : {};
		return {
			timestamp: record.timestamp,
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
		writeFileSync(cachePath(cacheDir), JSON.stringify(cache, null, 2), "utf8");
	} catch {
		// Cache persistence is best-effort; the listing already succeeded.
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
	if (!options.forceRefresh && cache && now - cache.timestamp < CACHE_TTL_MS) {
		return cache.skills;
	}
	const fetcher = options.fetchFn ?? fetch;
	try {
		const res = await fetcher(LISTING_URL, { headers: { "User-Agent": "clio-coder" } });
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
		saveCache(cacheDir, { timestamp: now, skills, details: cache?.details ?? {} });
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
	if (!options.forceRefresh && cache && cached && now - cache.timestamp < CACHE_TTL_MS) {
		return { ...cached, source: "cache" };
	}
	const fetcher = options.fetchFn ?? fetch;
	try {
		const rawUrl = `https://raw.githubusercontent.com/iowarp/clio-coder/main/skills/${name}/SKILL.md`;
		const res = await fetcher(rawUrl, { headers: { "User-Agent": "clio-coder" } });
		if (!res.ok) throw new Error(`Failed to fetch SKILL.md: ${res.status}`);
		const detail = parseSkillMarkdown(await res.text());
		const next = cache ?? { timestamp: now, skills: [], details: {} };
		next.details[name] = detail;
		saveCache(cacheDir, next);
		return { ...detail, source: "remote" };
	} catch (err) {
		if (cached) return { ...cached, source: "cache" };
		const pinned = getMarketplaceSkills().find((skill) => skill.name === name);
		if (pinned) return { description: pinned.description, body: "", source: "pinned" };
		throw err;
	}
}
