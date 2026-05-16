import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function findExecutableOnPath(name: string): string | null {
	const pathEnv = process.env.PATH;
	if (!pathEnv) return null;
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			const stat = statSync(candidate);
			if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
		} catch {
			// absent
		}
	}
	return null;
}

export function resolveFdBinary(): string | null {
	return findExecutableOnPath("fd") ?? findExecutableOnPath("fdfind");
}

export function resolveRgBinary(): string | null {
	return findExecutableOnPath("rg");
}
