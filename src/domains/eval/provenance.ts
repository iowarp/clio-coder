import { spawnSync } from "node:child_process";
import { readClioVersion, resolvePackageRoot } from "../../core/package-root.js";
import type { EvalClioProvenance, EvalEnvironmentProvenance } from "./types.js";

export interface EvalProvenanceOptions {
	entry?: string;
	commit?: string | null;
}

export function evalClioProvenance(options: EvalProvenanceOptions = {}): EvalClioProvenance {
	return {
		version: readClioVersion(),
		commit: options.commit === undefined ? currentClioCommit() : options.commit,
		entry: options.entry ?? process.argv[1] ?? "unknown",
	};
}

export function evalEnvironmentProvenance(): EvalEnvironmentProvenance {
	return {
		platform: `${process.platform}-${process.arch}`,
		node: process.version,
	};
}

function currentClioCommit(): string | null {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: resolvePackageRoot(),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 1000,
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return null;
	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}
