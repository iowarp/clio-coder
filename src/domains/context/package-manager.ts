import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Handbook generation and live orientation must name the same executable. */
export function packageManager(cwd: string): PackageManager {
	try {
		const manifest = join(cwd, "package.json");
		const stat = statSync(manifest);
		if (stat.isFile() && stat.size <= 1024 * 1024) {
			const declared: unknown = JSON.parse(readFileSync(manifest, "utf8")).packageManager;
			const name = typeof declared === "string" ? declared.trim().split("@")[0] : undefined;
			if (name === "pnpm" || name === "yarn" || name === "bun" || name === "npm") return name;
		}
	} catch {
		// Missing or malformed manifests still permit lockfile-based discovery.
	}
	if (isFile(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (isFile(join(cwd, "yarn.lock"))) return "yarn";
	if (isFile(join(cwd, "bun.lock")) || isFile(join(cwd, "bun.lockb"))) return "bun";
	return "npm";
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		// A missing or unreadable lockfile declares no manager.
		return false;
	}
}
