import { detectProjectType } from "../session/workspace/project-type.js";
import type { BootstrapIo, BootstrapProgressSink } from "./bootstrap.js";
import { buildCodewiki, type Codewiki, writeCodewiki } from "./codewiki/indexer.js";
import { computeFingerprint, type Fingerprint } from "./fingerprint.js";
import { readClioState, writeClioState } from "./state.js";
import { type RunWikiGenerateResult, runWikiGenerate, type WikiGenerate } from "./wiki/generate.js";
import { readWikiMeta } from "./wiki/meta.js";
import { wikiCompleteness, wikiStaleness } from "./wiki/staleness.js";

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
	wiki?: boolean;
	wikiGenerate?: WikiGenerate;
	/**
	 * Resolved wire model id of the documenter target, recorded on the wiki
	 * metadata when `--wiki` updates run. Supplied by the CLI, which can load the
	 * providers contract; absent for callers that never trigger wiki generation.
	 */
	wikiModel?: string;
}

export interface RunContextRefreshResult {
	action: "refreshed";
	codewikiEntries: number;
	fingerprint: Fingerprint;
	wiki?: RunWikiGenerateResult;
	hint?: string;
}

function indexedSourceFileCount(codewiki: Codewiki): number {
	return codewiki.files.filter((file) => file.lang !== "config").length;
}

const STALE_WIKI_REFRESH_HINT = "wiki is stale; run clio context refresh --wiki or clio context wiki --update";
const NO_WIKI_HINT = "no wiki exists, so --wiki had nothing to update; run clio context wiki to build one";

function incompleteWikiHint(cwd: string): string | undefined {
	const completeness = wikiCompleteness(cwd);
	if (!completeness || completeness.owed === 0) return undefined;
	return `wiki is incomplete: ${completeness.pagesWritten} of ${completeness.pagesPlanned} planned pages written, ${completeness.owed} owed; run clio context wiki --update to resume`;
}

export async function runContextRefresh(input: RunContextRefreshInput = {}): Promise<RunContextRefreshResult> {
	const cwd = input.cwd ?? process.cwd();
	const now = input.now ?? (() => new Date());
	const prev = readClioState(cwd);
	const hasWiki = readWikiMeta(cwd) !== null;
	const projectType = prev?.projectType ?? detectProjectType(cwd);
	const indexedAt = now().toISOString();

	input.onProgress?.({ phase: "codewiki", status: "started", message: "rebuilding codewiki" });
	const codewiki = await buildCodewiki({ cwd, language: projectType, generatedAt: indexedAt });
	writeCodewiki(cwd, codewiki);
	const fingerprint = computeFingerprint(cwd, codewiki);

	input.onProgress?.({ phase: "state", status: "running", message: "writing state" });
	writeClioState(cwd, {
		version: 1,
		projectType,
		fingerprint,
		codewikiVersion: codewiki.version,
		...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
		...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
		...(prev?.lastBootstrap ? { lastBootstrap: prev.lastBootstrap } : {}),
		...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
		lastSessionAt: prev?.lastSessionAt ?? indexedAt,
		lastIndexedAt: indexedAt,
	});

	const entries = indexedSourceFileCount(codewiki);
	let wikiResult: RunWikiGenerateResult | undefined;
	let hint: string | undefined;
	if (input.wiki === true && hasWiki) {
		wikiResult = await runWikiGenerate({
			cwd,
			mode: "update",
			model: input.wikiModel ?? "unresolved-documenter-target",
			...(input.wikiGenerate ? { generate: input.wikiGenerate } : {}),
			...(input.onProgress ? { onProgress: input.onProgress } : {}),
		});
	} else if (input.wiki === true) {
		// --wiki with no wiki on disk used to return silently, so an operator who
		// asked for an update got a bare "codewiki rebuilt" and no way to tell the
		// request had been dropped.
		hint = NO_WIKI_HINT;
	} else if (hasWiki) {
		// Incompleteness is checked before staleness: a partial wiki is often
		// perfectly fresh, and that combination used to produce no hint at all.
		hint = incompleteWikiHint(cwd) ?? (wikiStaleness(cwd).state === "stale" ? STALE_WIKI_REFRESH_HINT : undefined);
	}

	input.io?.stdout(`clio context refresh: codewiki rebuilt (${entries} source file${entries === 1 ? "" : "s"})\n`);
	input.onProgress?.({ phase: "done", status: "completed", message: "context refreshed" });
	return {
		action: "refreshed",
		codewikiEntries: entries,
		fingerprint,
		...(wikiResult ? { wiki: wikiResult } : {}),
		...(hint ? { hint } : {}),
	};
}
