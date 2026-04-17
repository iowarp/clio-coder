import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function resolvePackageRoot(metaUrl = import.meta.url): string {
	if (cached) return cached;
	const override = process.env.CLIO_PACKAGE_ROOT?.trim();
	if (override) {
		cached = resolve(override);
		return cached;
	}
	let dir = resolve(dirname(fileURLToPath(metaUrl)));
	while (true) {
		if (existsSync(join(dir, "package.json"))) {
			cached = dir;
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(`Could not find package.json above ${dir}`);
		}
		dir = parent;
	}
}

export function resetPackageRootCache(): void {
	cached = null;
}
