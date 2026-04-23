import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { CapabilityFlags } from "./capability-flags.js";

export interface KnowledgeBaseEntry {
	family: string;
	matchPatterns: ReadonlyArray<string>;
	capabilities: Partial<CapabilityFlags>;
	quirks?: Record<string, unknown>;
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

export class FileKnowledgeBase implements KnowledgeBase {
	private readonly dir: string;
	private loaded: KnowledgeBaseEntry[] = [];

	constructor(dir: string) {
		const stat = statSync(dir);
		if (!stat.isDirectory()) {
			throw new Error(`knowledge base path is not a directory: ${dir}`);
		}
		this.dir = dir;
		this.reload();
	}

	reload(): void {
		const next: KnowledgeBaseEntry[] = [];
		const files = collectYamlFiles(this.dir);
		for (const entry of files) {
			const raw = readFileSync(entry.path, "utf8");
			const parsed = parseYaml(raw);
			if (!Array.isArray(parsed)) {
				throw new Error(`knowledge base file ${entry.name} must be a YAML list of KnowledgeBaseEntry`);
			}
			for (const item of parsed) {
				next.push(normalizeEntry(item, entry.name));
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
				if (best === null || pattern.length > best.pattern.length) {
					best = { entry, pattern };
				}
			}
		}
		if (best === null) return null;
		const isFamilyMatch = best.pattern.toLowerCase() === best.entry.family.toLowerCase();
		return { entry: best.entry, matchKind: isFamilyMatch ? "family" : "alias" };
	}
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
	return entry;
}
