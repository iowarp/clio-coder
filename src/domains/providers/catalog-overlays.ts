import { readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { clioProjectRoot } from "../../core/project-root.js";
import { resolveClioDirs } from "../../core/xdg.js";
import type { CapabilityFlags } from "./types/capability-flags.js";
import type { KnowledgeBaseEntry, KnowledgeBaseHit, KnowledgeBaseRoot } from "./types/knowledge-base.js";

/**
 * The operator's `model-catalog.d` overlays: YAML lists of catalog entries matched by substring, read
 * from the config dir, the project's `.clio-coder` dir and `CLIO_CODER_MODEL_CATALOG_DIRS`, lowest
 * precedence first. The file format, root order, file order and tie-break are the ones the retired
 * file-backed knowledge base used, so an overlay written for it loads the same.
 */
export const MODEL_CATALOG_OVERLAY_DIR = "model-catalog.d";
export const MODEL_CATALOG_DIRS_ENV = "CLIO_CODER_MODEL_CATALOG_DIRS";

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function uniqueExistingDirs(paths: ReadonlyArray<string | null | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const candidate of paths) {
		const path = candidate?.trim();
		if (!path || seen.has(path) || !isDirectory(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

function envOverlayDirs(): string[] {
	const raw = process.env[MODEL_CATALOG_DIRS_ENV]?.trim();
	if (!raw) return [];
	return raw
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Existing overlay roots, lowest precedence first: config dir, project, then the env list in order. */
export function resolveModelCatalogOverlayRoots(options: { cwd?: string } = {}): KnowledgeBaseRoot[] {
	const cwd = options.cwd ?? process.cwd();
	return uniqueExistingDirs([
		join(resolveClioDirs().config, MODEL_CATALOG_OVERLAY_DIR),
		join(clioProjectRoot(cwd, MODEL_CATALOG_OVERLAY_DIR), ".clio-coder", MODEL_CATALOG_OVERLAY_DIR),
		...envOverlayDirs(),
	]).map((dir) => ({ dir }));
}

/** A file the last load skipped: its path, and what is wrong with it, which can run over several lines. */
export interface ModelCatalogOverlayProblem {
	path: string;
	message: string;
}

/**
 * Overlay entries in load order. A bad root throws from the constructor and from `reload`; a malformed file is
 * skipped alone and named in `problems()`, so the files beside it still load.
 */
export class ModelCatalogOverlays {
	private readonly roots: KnowledgeBaseRoot[];
	private loaded: KnowledgeBaseEntry[] = [];
	private skipped: ModelCatalogOverlayProblem[] = [];

	constructor(roots: ReadonlyArray<string | KnowledgeBaseRoot>) {
		this.roots = normalizeRoots(roots);
		this.reload();
	}

	/** Rereads every root; a root that cannot be listed leaves the previous entries in place. */
	reload(): void {
		const next: KnowledgeBaseEntry[] = [];
		const skipped: ModelCatalogOverlayProblem[] = [];
		for (const root of this.roots) {
			for (const file of collectYamlFiles(root.dir)) {
				try {
					const parsed = parseYaml(readFileSync(file.path, "utf8"));
					if (!Array.isArray(parsed)) throw new Error("must be a YAML list of catalog entries");
					next.push(...parsed.map(normalizeEntry));
				} catch (err) {
					skipped.push({ path: file.path, message: (err instanceof Error ? err.message : String(err)).trimEnd() });
				}
			}
		}
		this.loaded = next;
		this.skipped = skipped;
	}

	entries(): ReadonlyArray<KnowledgeBaseEntry> {
		return this.loaded;
	}

	/** One problem per file the last load skipped. */
	problems(): ReadonlyArray<ModelCatalogOverlayProblem> {
		return this.skipped;
	}
}

/**
 * The longest pattern contained in the id wins, case-insensitively; on a tie the later entry wins, so an
 * overlay beats the packaged tier and a higher-precedence overlay beats a lower one.
 */
export function substringCatalogLookup(
	entries: ReadonlyArray<KnowledgeBaseEntry>,
	modelId: string,
): KnowledgeBaseHit | null {
	const needle = modelId.toLowerCase();
	let best: { entry: KnowledgeBaseEntry; pattern: string } | null = null;
	for (const entry of entries) {
		for (const pattern of entry.matchPatterns) {
			if (!needle.includes(pattern.toLowerCase())) continue;
			if (best === null || pattern.length >= best.pattern.length) {
				best = { entry, pattern };
			}
		}
	}
	if (best === null) return null;
	const isFamilyMatch = best.pattern.toLowerCase() === best.entry.family.toLowerCase();
	return { entry: best.entry, matchKind: isFamilyMatch ? "family" : "alias" };
}

function normalizeRoots(roots: ReadonlyArray<string | KnowledgeBaseRoot>): KnowledgeBaseRoot[] {
	const out: KnowledgeBaseRoot[] = [];
	const seen = new Set<string>();
	for (const raw of roots.map((entry) => (typeof entry === "string" ? { dir: entry } : entry))) {
		const dir = raw.dir.trim();
		if (dir.length === 0 || seen.has(dir)) continue;
		let isRootDir = false;
		try {
			isRootDir = statSync(dir).isDirectory();
		} catch (err) {
			if (raw.optional === true) continue;
			throw err;
		}
		if (!isRootDir) {
			if (raw.optional === true) continue;
			throw new Error(`knowledge base path is not a directory: ${dir}`);
		}
		seen.add(dir);
		out.push({ dir, ...(raw.optional === true ? { optional: true } : {}) });
	}
	return out;
}

function collectYamlFiles(dir: string): Array<{ path: string }> {
	const out: Array<{ path: string }> = [];
	const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectYamlFiles(path));
			continue;
		}
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;
		out.push({ path });
	}
	return out;
}

function normalizeEntry(raw: unknown): KnowledgeBaseEntry {
	if (typeof raw !== "object" || raw === null) {
		throw new Error("every entry must be an object");
	}
	const candidate = raw as Record<string, unknown>;
	const family = candidate.family;
	const patterns = candidate.matchPatterns;
	const capabilities = candidate.capabilities;
	if (typeof family !== "string" || family.length === 0) {
		throw new Error("entry is missing 'family' string");
	}
	if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string")) {
		throw new Error(`entry '${family}' needs matchPatterns: string[]`);
	}
	if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
		throw new Error(`entry '${family}' needs capabilities object`);
	}
	const entry: KnowledgeBaseEntry = {
		family,
		matchPatterns: patterns as string[],
		capabilities: capabilities as Partial<CapabilityFlags>,
	};
	if (candidate.quirks !== undefined) {
		if (typeof candidate.quirks !== "object" || candidate.quirks === null || Array.isArray(candidate.quirks)) {
			throw new Error(`entry '${family}' quirks must be an object`);
		}
		entry.quirks = candidate.quirks as Record<string, unknown>;
	}
	const metadata = candidate["clio-coder"];
	if (metadata !== undefined) {
		if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
			throw new Error(`entry '${family}' clio-coder metadata must be an object`);
		}
		entry.clioCoder = metadata as Record<string, unknown>;
	}
	return entry;
}
