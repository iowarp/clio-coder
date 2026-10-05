import type { DecisionLedgerEntry } from "../session/entries.js";
import { detectProjectType } from "../session/workspace/project-type.js";
import type { BootstrapIo, BootstrapProgressSink } from "./bootstrap.js";
import { tryReadClioMd } from "./clio-md.js";
import { coordinateCodewikiWrite } from "./codewiki/coordinator.js";
import type { Codewiki } from "./codewiki/schema.js";
import type { Fingerprint } from "./fingerprint.js";
import { indexProgressSink } from "./progress.js";
import { readClioState, writeClioState } from "./state.js";
import { type RunWikiGenerateResult, runWikiGenerate, type WikiGenerate } from "./wiki/generate.js";
import { readWikiMeta } from "./wiki/meta.js";
import { wikiCompleteness, wikiStaleness } from "./wiki/staleness.js";

/**
 * `/context refresh` and `clio-coder context refresh`: rebuild the codemap index and
 * `.clio-coder` state while preserving authored handbook bytes. Derived navigation
 * stays in codewiki and the optional Markdown wiki.
 */

export interface RunContextRefreshInput {
	signal?: AbortSignal;
	decisions?: ReadonlyArray<DecisionLedgerEntry>;
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
 * What refresh found at CLIO-CODER.md. "absent" covers missing, empty, and unreadable
 * files: an unavailable handbook is never an error here, because a
 * repository must stay fully usable without one.
 */
export type ClioMdCuration = "unchanged" | "absent";

export interface RunContextRefreshResult {
	action: "refreshed";
	codewikiEntries: number;
	fingerprint: Fingerprint;
	clioMd: ClioMdCuration;
	wiki?: RunWikiGenerateResult;
	hint?: string;
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
	input.signal?.throwIfAborted();
	const cwd = input.cwd ?? process.cwd();
	const now = input.now ?? (() => new Date());
	const prev = readClioState(cwd);
	const hasWiki = readWikiMeta(cwd) !== null;
	const projectType = prev?.projectType ?? detectProjectType(cwd);
	const indexedAt = now().toISOString();

	input.onProgress?.({
		phase: "codewiki",
		status: "started",
		message: "reconciling codemap",
		stages: input.wiki && hasWiki ? ["codewiki", "generate", "state"] : ["codewiki", "state"],
	});
	let fingerprint: Fingerprint | undefined;
	let clioMd: ClioMdCuration = "absent";
	const coordinated = await coordinateCodewikiWrite(
		cwd,
		(current) => ({
			kind: "ensure",
			cwd,
			language: projectType,
			current,
			previous: readClioState(cwd)?.fingerprint ?? null,
		}),
		{
			onProgress: indexProgressSink(input.onProgress),
			...(input.signal ? { signal: input.signal } : {}),
			afterCommit: (result, workspace) => {
				fingerprint = result.fingerprint;
				clioMd = tryReadClioMd(workspace)?.ok ? "unchanged" : "absent";
				const entries = indexedSourceFileCount(result.codewiki);
				input.onProgress?.({
					phase: "codewiki",
					status: "completed",
					message: `index current; ${entries} source files`,
					current: entries,
					total: entries,
				});
				const latest = readClioState(workspace);
				writeClioState(
					workspace,
					{
						version: 1,
						projectType,
						fingerprint: result.fingerprint,
						codewikiVersion: result.codewiki.version,
						...(latest?.contextSources ? { contextSources: latest.contextSources } : {}),
						...(latest?.contextSourceHash ? { contextSourceHash: latest.contextSourceHash } : {}),
						...(latest?.lastBootstrap ? { lastBootstrap: latest.lastBootstrap } : {}),
						...(latest?.bootstrapFingerprint ? { bootstrapFingerprint: latest.bootstrapFingerprint } : {}),
						...(latest?.lastInitAt ? { lastInitAt: latest.lastInitAt } : {}),
						lastSessionAt: latest?.lastSessionAt ?? indexedAt,
						lastIndexedAt: indexedAt,
					},
					result.codewiki,
				);
			},
		},
	);
	if (!coordinated || !fingerprint) throw new Error("codewiki refresh transaction did not commit");
	const codewiki = coordinated.codewiki;

	const entries = indexedSourceFileCount(codewiki);
	let wikiResult: RunWikiGenerateResult | undefined;
	let hint: string | undefined;
	if (input.wiki === true && hasWiki) {
		wikiResult = await runWikiGenerate({
			cwd,
			mode: "update",
			...(input.decisions ? { decisions: input.decisions } : {}),
			model: input.wikiModel ?? "unresolved-documenter-target",
			...(input.wikiGenerate ? { generate: input.wikiGenerate } : {}),
			...(input.onProgress ? { onProgress: input.onProgress } : {}),
		});
	} else if (input.wiki === true) {
		// --wiki with no wiki on disk used to return silently, so an operator who
		// asked for an update got a bare "codemap rebuilt" and no way to tell the
		// request had been dropped.
		hint = NO_WIKI_HINT;
	} else if (hasWiki) {
		// Incompleteness is checked before staleness: a partial wiki is often
		// perfectly fresh, and that combination used to produce no hint at all.
		hint = incompleteWikiHint(cwd) ?? (wikiStaleness(cwd).state === "stale" ? STALE_WIKI_REFRESH_HINT : undefined);
	}

	const committedClioMd = clioMd as ClioMdCuration;
	input.io?.stdout(
		`clio-coder context refresh: codemap reconciled (${entries} source file${entries === 1 ? "" : "s"})\n`,
	);
	input.onProgress?.({ phase: "state", status: "completed", message: "project state saved" });
	input.onProgress?.({
		phase: "done",
		status: wikiResult?.status === "failed" ? "failed" : "completed",
		message: wikiResult?.status === "failed" ? "context refreshed; wiki update failed" : "context refreshed",
	});
	return {
		action: "refreshed",
		codewikiEntries: entries,
		fingerprint,
		clioMd: committedClioMd,
		...(wikiResult ? { wiki: wikiResult } : {}),
		...(hint ? { hint } : {}),
	};
}
