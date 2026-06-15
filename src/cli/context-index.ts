import {
	buildCodewikiWithTreeSitter,
	type Codewiki,
	codewikiPath,
	structuralCodewikiHash,
	writeCodewiki,
} from "../domains/context/codewiki/indexer.js";
import { computeFingerprint } from "../domains/context/fingerprint.js";
import { readClioState, statePath, writeClioState } from "../domains/context/state.js";
import { detectProjectProfile } from "../domains/session/workspace/project-type.js";

const HELP = `Usage:
  clio context-index [--json]

Build the Stage 1 codewiki index for the current repository without model calls.
Writes .clio/codewiki.json and .clio/state.json, then prints source coverage.

Options:
  --json          print machine-readable coverage and hash details
`;

function hasFlag(args: ReadonlyArray<string>, name: string): boolean {
	return args.includes(name);
}

function languageCounts(profile: ReturnType<typeof detectProjectProfile>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(profile.languageCounts)
			.filter(([, count]) => count > 0)
			.sort(([a], [b]) => a.localeCompare(b)),
	);
}

function formatCounts(counts: Record<string, number>): string {
	const parts = Object.entries(counts).map(([language, count]) => `${language}=${count}`);
	return parts.length > 0 ? parts.join(", ") : "none";
}

function indexedSourceCount(codewiki: Codewiki): number {
	return codewiki.files.filter((file) => file.lang !== "config").length;
}

export async function runContextIndexCommand(args: string[]): Promise<number> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const allowed = new Set(["--json"]);
	for (const arg of args) {
		if (!allowed.has(arg)) {
			process.stderr.write(`clio context-index: unknown flag ${arg}\n`);
			return 2;
		}
	}
	const cwd = process.cwd();
	const now = new Date().toISOString();
	const profile = detectProjectProfile(cwd);
	const codewiki = await buildCodewikiWithTreeSitter({ cwd, language: profile.projectType });
	writeCodewiki(cwd, codewiki);
	const prev = readClioState(cwd);
	const fingerprint = computeFingerprint(cwd);
	writeClioState(cwd, {
		version: 1,
		projectType: profile.projectType,
		fingerprint,
		...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
		...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
		...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
		lastSessionAt: prev?.lastSessionAt ?? now,
		lastIndexedAt: now,
	});
	const indexed = indexedSourceCount(codewiki);
	const coverage = profile.sourceFiles === 0 ? 1 : indexed / profile.sourceFiles;
	const counts = languageCounts(profile);
	const payload = {
		projectType: profile.projectType,
		sourceFiles: profile.sourceFiles,
		indexedSourceFiles: indexed,
		coverage,
		languageCounts: counts,
		codewikiPath: codewikiPath(cwd),
		statePath: statePath(cwd),
		structuralHash: structuralCodewikiHash(codewiki),
	};
	if (hasFlag(args, "--json")) {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(
		[
			`clio context-index indexed ${indexed}/${profile.sourceFiles} source file${profile.sourceFiles === 1 ? "" : "s"} (${(coverage * 100).toFixed(1)}%)`,
			`  language ${profile.projectType}; counts ${formatCounts(counts)}`,
			`  codewiki ${payload.codewikiPath}`,
			`  state ${payload.statePath}`,
			`  structural hash ${payload.structuralHash}`,
			"",
		].join("\n"),
	);
	return 0;
}
