import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { warnLegacyNaming } from "../../../core/naming-compat.js";
import type { CapabilityFlags } from "./capability-flags.js";

export interface KnowledgeBaseEntry {
	family: string;
	matchPatterns: ReadonlyArray<string>;
	capabilities: Partial<CapabilityFlags>;
	quirks?: Record<string, unknown>;
	/** Product-owned catalog metadata, normalized from either YAML spelling. */
	clioCoder?: Record<string, unknown>;
}

export type MatchKind = "family" | "alias";

export interface KnowledgeBaseHit {
	entry: KnowledgeBaseEntry;
	matchKind: MatchKind;
}

export interface KnowledgeBase {
	lookup(modelId: string): KnowledgeBaseHit | null;
	entries(): ReadonlyArray<KnowledgeBaseEntry>;
}

export interface KnowledgeBaseRoot {
	dir: string;
	/** Human-readable label used in parse/validation diagnostics. */
	label?: string;
	/** Missing optional roots are ignored; non-optional roots must exist. */
	optional?: boolean;
}

export class FileKnowledgeBase implements KnowledgeBase {
	private readonly roots: KnowledgeBaseRoot[];
	private loaded: KnowledgeBaseEntry[] = [];

	constructor(root: string | ReadonlyArray<string | KnowledgeBaseRoot>) {
		this.roots = normalizeRoots(root);
		this.reload();
	}

	reload(): void {
		const next: KnowledgeBaseEntry[] = [];
		for (const root of this.roots) {
			const files = collectYamlFiles(root.dir);
			for (const file of files) {
				const name = root.label ? `${root.label}:${file.name}` : file.name;
				const raw = readFileSync(file.path, "utf8");
				const parsed = parseYaml(raw);
				if (!Array.isArray(parsed)) {
					throw new Error(`knowledge base file ${name} must be a YAML list of KnowledgeBaseEntry`);
				}
				for (const item of parsed) {
					next.push(normalizeEntry(item, name));
				}
			}
		}
		this.loaded = next;
	}

	entries(): ReadonlyArray<KnowledgeBaseEntry> {
		return this.loaded;
	}

	lookup(modelId: string): KnowledgeBaseHit | null {
		const needle = modelId.toLowerCase();
		let best: { entry: KnowledgeBaseEntry; pattern: string } | null = null;
		for (const entry of this.loaded) {
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
}

function normalizeRoots(root: string | ReadonlyArray<string | KnowledgeBaseRoot>): KnowledgeBaseRoot[] {
	const rawRoots =
		typeof root === "string"
			? [{ dir: root }]
			: root.map((entry) => (typeof entry === "string" ? { dir: entry } : entry));
	const out: KnowledgeBaseRoot[] = [];
	const seen = new Set<string>();
	for (const raw of rawRoots) {
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
		out.push({ dir, ...(raw.label ? { label: raw.label } : {}), ...(raw.optional === true ? { optional: true } : {}) });
	}
	return out;
}

function collectYamlFiles(dir: string, prefix = ""): Array<{ path: string; name: string }> {
	const out: Array<{ path: string; name: string }> = [];
	const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const path = join(dir, entry.name);
		const name = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...collectYamlFiles(path, name));
			continue;
		}
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;
		out.push({ path, name });
	}
	return out;
}

function normalizeEntry(raw: unknown, file: string): KnowledgeBaseEntry {
	if (typeof raw !== "object" || raw === null) {
		throw new Error(`knowledge base file ${file}: every entry must be an object`);
	}
	const candidate = raw as Record<string, unknown>;
	const family = candidate.family;
	const patterns = candidate.matchPatterns;
	const capabilities = candidate.capabilities;
	if (typeof family !== "string" || family.length === 0) {
		throw new Error(`knowledge base file ${file}: entry is missing 'family' string`);
	}
	if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string")) {
		throw new Error(`knowledge base file ${file}: entry '${family}' needs matchPatterns: string[]`);
	}
	if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
		throw new Error(`knowledge base file ${file}: entry '${family}' needs capabilities object`);
	}
	const entry: KnowledgeBaseEntry = {
		family,
		matchPatterns: patterns as string[],
		capabilities: capabilities as Partial<CapabilityFlags>,
	};
	if (candidate.quirks !== undefined) {
		if (typeof candidate.quirks !== "object" || candidate.quirks === null || Array.isArray(candidate.quirks)) {
			throw new Error(`knowledge base file ${file}: entry '${family}' quirks must be an object`);
		}
		entry.quirks = candidate.quirks as Record<string, unknown>;
	}
	const canonicalMetadata = candidate["clio-coder"];
	const legacyMetadata = candidate.clio;
	if (legacyMetadata !== undefined) warnLegacyNaming("clio: model metadata", "clio-coder: model metadata");
	const metadata = canonicalMetadata ?? legacyMetadata;
	if (metadata !== undefined) {
		if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
			throw new Error(`knowledge base file ${file}: entry '${family}' clio-coder metadata must be an object`);
		}
		entry.clioCoder = metadata as Record<string, unknown>;
	}
	return entry;
}
