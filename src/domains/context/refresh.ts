import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectProjectType } from "../session/workspace/project-type.js";
import { type BootstrapIo, type BootstrapProgressSink, codewikiSections } from "./bootstrap.js";
import { serializeClioMd, tryReadClioMd } from "./clio-md.js";
import { buildCodewiki, type Codewiki, writeCodewiki } from "./codewiki/indexer.js";
import { computeFingerprint, type Fingerprint } from "./fingerprint.js";
import { readClioState, writeClioState } from "./state.js";
import { type RunWikiGenerateResult, runWikiGenerate, type WikiGenerate } from "./wiki/generate.js";
import { readWikiMeta } from "./wiki/meta.js";
import { wikiCompleteness, wikiStaleness } from "./wiki/staleness.js";

/**
 * `/context refresh` and `clio-coder context refresh`: rebuild the codewiki index and
 * `.clio-coder` state, then re-derive the handbook sections the index owns. Authoring
 * handbook prose stays with `/context init`.
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

/**
 * What refresh did to CLIO-CODER.md. "absent" covers no handbook and an unparseable
 * one alike: a missing or broken handbook is never an error here, because a
 * repository must stay fully usable without one.
 */
export type ClioMdCuration = "updated" | "unchanged" | "absent";

export interface RunContextRefreshResult {
	action: "refreshed";
	codewikiEntries: number;
	fingerprint: Fingerprint;
	clioMd: ClioMdCuration;
	wiki?: RunWikiGenerateResult;
	hint?: string;
}

/**
 * Re-derive the index-owned sections of an existing handbook against the codewiki
 * this run just built. Only sections whose title the index authors are replaced,
 * and only when they are already present, so a human's handbook is never grown a
 * section it did not ask for and never loses one it wrote. Best-effort by
 * construction: nothing here may turn a routine refresh into a failure.
 */
function curateClioMd(cwd: string, codewiki: Codewiki): ClioMdCuration {
	try {
		const parsed = tryReadClioMd(cwd);
		if (!parsed?.ok) return "absent";
		const handbook = parsed.value;
		const fresh = new Map(codewikiSections(codewiki).map((section) => [section.title, section.body] as const));
		let changed = false;
		const sections = handbook.sections.map((section) => {
			const body = fresh.get(section.title);
			if (body === undefined || body === section.body) return section;
			changed = true;
			return { title: section.title, body };
		});
		// Rewrite only when an index-owned body actually moved. Serializing on every
		// refresh would silently reformat a hand-written handbook into the generator's
		// canonical rendering, which is a diff the author never asked for.
		if (!changed) return "unchanged";
		writeFileSync(
			join(cwd, "CLIO-CODER.md"),
			serializeClioMd({
				projectName: handbook.projectName,
				identity: handbook.identity,
				conventions: handbook.conventions,
				invariants: handbook.invariants,
				sections,
				...(handbook.importedAgentContext ? { importedAgentContext: handbook.importedAgentContext } : {}),
				fingerprint: handbook.fingerprint,
			}),
			"utf8",
		);
		return "updated";
	} catch {
		return "absent";
	}
}

function indexedSourceFileCount(codewiki: Codewiki): number {
	return codewiki.files.filter((file) => file.lang !== "config").length;
}

const STALE_WIKI_REFRESH_HINT =
	"wiki is stale; run clio-coder context refresh --wiki or clio-coder context wiki --update";
const NO_WIKI_HINT = "no wiki exists, so --wiki had nothing to update; run clio-coder context wiki to build one";

function incompleteWikiHint(cwd: string): string | undefined {
	const completeness = wikiCompleteness(cwd);
	if (!completeness || completeness.owed === 0) return undefined;
	return `wiki is incomplete: ${completeness.pagesWritten} of ${completeness.pagesPlanned} planned pages written, ${completeness.owed} owed; run clio-coder context wiki --update to resume`;
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
	const clioMd = curateClioMd(cwd, codewiki);

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

	const handbookNote = clioMd === "updated" ? "; CLIO-CODER.md index sections updated" : "";
	input.io?.stdout(
		`clio-coder context refresh: codewiki rebuilt (${entries} source file${entries === 1 ? "" : "s"})${handbookNote}\n`,
	);
	input.onProgress?.({ phase: "done", status: "completed", message: "context refreshed" });
	return {
		action: "refreshed",
		codewikiEntries: entries,
		fingerprint,
		clioMd,
		...(wikiResult ? { wiki: wikiResult } : {}),
		...(hint ? { hint } : {}),
	};
}
