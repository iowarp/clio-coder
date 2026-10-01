import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ClassifierCall } from "./action-classifier.js";
import { describeBashCallConsequences, type PathKind } from "./command-consequence.js";

/** What exists at `path` once resolved against `cwd`; null when it does not, or cannot be read. */
function pathKindIn(cwd: string): (path: string) => PathKind {
	return (path) => {
		try {
			const stat = statSync(resolve(cwd, path));
			return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
		} catch {
			// A path that cannot be statted is not an existing file to overwrite.
			return null;
		}
	};
}

/**
 * The consequence sentences for a bash ask the main agent made, read from the
 * full command and checked against the filesystem it will run in. Card text
 * only: a failure here is no sentence, never a different admission. Every
 * approval surface (the terminal card and the ACP permission request) reads
 * it here so they describe one command the same way.
 */
export function describeMainCallConsequences(call: ClassifierCall): string[] {
	const cwd = typeof call.args?.cwd === "string" && call.args.cwd.length > 0 ? call.args.cwd : process.cwd();
	return describeBashCallConsequences(call.tool, call.args, {
		pathKind: pathKindIn(resolve(process.cwd(), cwd)),
		home: homedir,
	});
}
