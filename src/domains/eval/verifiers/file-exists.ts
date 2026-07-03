import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function forbiddenPathHits(cwd: string, paths: ReadonlyArray<string>): string[] {
	return paths.filter((path) => existsSync(resolve(cwd, path)));
}

export function requiredPathExists(cwd: string, path: string): boolean {
	return existsSync(resolve(cwd, path));
}
