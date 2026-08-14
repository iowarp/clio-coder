import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveClioDirs } from "../../core/xdg.js";
import type { KnowledgeBaseRoot } from "./types/knowledge-base.js";

export const MODEL_CATALOG_OVERLAY_DIR = "model-catalog.d";
export const MODEL_CATALOG_DIRS_ENV = "CLIO_CODER_MODEL_CATALOG_DIRS";

export interface ProviderModelCatalogDirs {
	/** Bundled curated catalog shipped with Clio, when present. */
	bundled: string | null;
	/** Existing user/project/env overlay roots, ordered from lower to higher precedence. */
	overlays: string[];
	/** All existing roots, ordered from lower to higher precedence. */
	all: string[];
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function resolveProvidersModelsDir(importMetaUrl: string): string | null {
	const start = dirname(fileURLToPath(importMetaUrl));
	const directCandidates = [
		join(start, "models"),
		join(start, "..", "domains", "providers", "models"),
		join(start, "..", "providers-models"),
	];
	for (const candidate of directCandidates) {
		if (isDirectory(candidate)) return candidate;
	}

	let cursor = start;
	for (let i = 0; i < 8; i++) {
		const packageJson = join(cursor, "package.json");
		const sourceModels = join(cursor, "src", "domains", "providers", "models");
		const distModels = join(cursor, "dist", "providers-models");
		if (existsSync(packageJson)) {
			if (isDirectory(sourceModels)) return sourceModels;
			if (isDirectory(distModels)) return distModels;
		}
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return null;
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

export function resolveProviderModelCatalogDirs(
	importMetaUrl: string,
	options: { cwd?: string } = {},
): ProviderModelCatalogDirs {
	const bundled = resolveProvidersModelsDir(importMetaUrl);
	const cwd = options.cwd ?? process.cwd();
	const overlays = uniqueExistingDirs([
		join(resolveClioDirs().config, MODEL_CATALOG_OVERLAY_DIR),
		join(cwd, ".clio-coder", MODEL_CATALOG_OVERLAY_DIR),
		...envOverlayDirs(),
	]);
	return {
		bundled,
		overlays,
		all: uniqueExistingDirs([bundled, ...overlays]),
	};
}

export function resolveProviderKnowledgeBaseRoots(
	importMetaUrl: string,
	options: { cwd?: string } = {},
): KnowledgeBaseRoot[] {
	const dirs = resolveProviderModelCatalogDirs(importMetaUrl, options);
	return [
		...(dirs.bundled ? [{ dir: dirs.bundled, label: "bundled" }] : []),
		...dirs.overlays.map((dir) => ({ dir, label: `overlay:${dir}` })),
	];
}
