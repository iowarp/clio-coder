import { detectProjectType } from "../session/workspace/project-type.js";
import type { BootstrapIo, BootstrapProgressSink } from "./bootstrap.js";
import { buildCodewiki, type Codewiki, writeCodewiki } from "./codewiki/indexer.js";
import { computeFingerprint, type Fingerprint } from "./fingerprint.js";
import { readClioState, writeClioState } from "./state.js";

/**
 * `/context refresh` and `clio context refresh`: rebuild the codewiki index
 * and `.clio` state. It never reads or writes CLIO.md; regenerating handbook
 * prose stays with `/context init`.
 */

export interface RunContextRefreshInput {
	cwd?: string;
	io?: BootstrapIo;
	now?: () => Date;
	onProgress?: BootstrapProgressSink;
}

export interface RunContextRefreshResult {
	action: "refreshed";
	codewikiEntries: number;
	fingerprint: Fingerprint;
}

function indexedSourceFileCount(codewiki: Codewiki): number {
	return codewiki.files.filter((file) => file.lang !== "config").length;
}

export async function runContextRefresh(input: RunContextRefreshInput = {}): Promise<RunContextRefreshResult> {
	const cwd = input.cwd ?? process.cwd();
	const now = input.now ?? (() => new Date());
	const prev = readClioState(cwd);
	const projectType = prev?.projectType ?? detectProjectType(cwd);
	const indexedAt = now().toISOString();

	input.onProgress?.({ phase: "codewiki", status: "started", message: "rebuilding codewiki" });
	const codewiki = buildCodewiki({ cwd, language: projectType, generatedAt: indexedAt });
	writeCodewiki(cwd, codewiki);
	const fingerprint = computeFingerprint(cwd);

	input.onProgress?.({ phase: "state", status: "running", message: "writing state" });
	writeClioState(cwd, {
		version: 1,
		projectType,
		fingerprint,
		...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
		...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
		...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
		lastSessionAt: prev?.lastSessionAt ?? indexedAt,
		lastIndexedAt: indexedAt,
	});

	const entries = indexedSourceFileCount(codewiki);
	input.io?.stdout(`clio context refresh: codewiki rebuilt (${entries} source file${entries === 1 ? "" : "s"})\n`);
	input.onProgress?.({ phase: "done", status: "completed", message: "context refreshed" });
	return { action: "refreshed", codewikiEntries: entries, fingerprint };
}
