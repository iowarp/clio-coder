import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function resolveProvidersModelsDir(importMetaUrl: string): string | null {
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
