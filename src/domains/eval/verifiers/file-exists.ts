import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function forbiddenPathHits(cwd: string, paths: ReadonlyArray<string>): string[] {
	return paths.filter((path) => existsSync(resolve(cwd, path)));
}
