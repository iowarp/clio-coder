import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectProjectType } from "../session/workspace/project-type.js";
import type { BootstrapIo } from "./bootstrap.js";
import type { ClioMdFingerprintFooter } from "./clio-md.js";
import { buildCodewiki, type Codewiki, writeCodewiki } from "./codewiki/indexer.js";
import { computeFingerprint, type Fingerprint } from "./fingerprint.js";
import { readClioState, writeClioState } from "./state.js";

/**
 * `/context refresh` and `clio context refresh`: rebuild the codewiki index
 * and restamp the CLIO.md fingerprint footer (gitHead/treeHash/loc) so the
 * stale marker clears, without touching any handbook prose. This is the cheap
 * staleness fix; regenerating prose stays with `/context init`.
 */

export interface RunContextRefreshInput {
	cwd?: string;
	io?: BootstrapIo;
	now?: () => Date;
}

export interface RunContextRefreshResult {
	action: "refreshed";
	codewikiEntries: number;
	fingerprint: Fingerprint;
	/** True when CLIO.md carried a fingerprint footer and it was rewritten. */
	clioMdRestamped: boolean;
}

const FOOTER_PATTERN = /<!-- clio:fingerprint v1\n([\s\S]*?)\n-->/;

/**
 * Replace only the fingerprint footer's gitHead/treeHash/loc fields inside a
 * raw CLIO.md source. Returns null when no parseable footer exists. Every
 * byte outside the footer comment is preserved verbatim.
 */
export function restampFingerprintFooter(source: string, fingerprint: Fingerprint): string | null {
	const matched = FOOTER_PATTERN.exec(source);
	if (!matched || matched[1] === undefined) return null;
	let footer: ClioMdFingerprintFooter;
	try {
		footer = JSON.parse(matched[1]) as ClioMdFingerprintFooter;
	} catch {
		return null;
	}
	const next: ClioMdFingerprintFooter = {
		...footer,
		gitHead: fingerprint.gitHead,
		treeHash: fingerprint.treeHash,
		loc: fingerprint.loc,
	};
	const rendered = `<!-- clio:fingerprint v1\n${JSON.stringify(next, null, 2)}\n-->`;
	return source.slice(0, matched.index) + rendered + source.slice(matched.index + matched[0].length);
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

	const codewiki = buildCodewiki({ cwd, language: projectType, generatedAt: indexedAt });
	writeCodewiki(cwd, codewiki);
	const fingerprint = computeFingerprint(cwd);

	let clioMdRestamped = false;
	const clioMdPath = join(cwd, "CLIO.md");
	if (existsSync(clioMdPath)) {
		const source = readFileSync(clioMdPath, "utf8");
		const restamped = restampFingerprintFooter(source, fingerprint);
		if (restamped !== null && restamped !== source) {
			writeFileSync(clioMdPath, restamped, "utf8");
			clioMdRestamped = true;
		}
	}
	// Persist state AFTER the CLIO.md restamp so the stored treeHash matches
	// the tree that now contains the restamped file.
	const finalFingerprint = clioMdRestamped ? computeFingerprint(cwd) : fingerprint;
	writeClioState(cwd, {
		version: 1,
		projectType,
		fingerprint: finalFingerprint,
		...(prev?.contextSources ? { contextSources: prev.contextSources } : {}),
		...(prev?.contextSourceHash ? { contextSourceHash: prev.contextSourceHash } : {}),
		...(prev?.lastInitAt ? { lastInitAt: prev.lastInitAt } : {}),
		lastSessionAt: prev?.lastSessionAt ?? indexedAt,
		lastIndexedAt: indexedAt,
	});

	const entries = indexedSourceFileCount(codewiki);
	input.io?.stdout(
		`clio context refresh: codewiki rebuilt (${entries} source file${entries === 1 ? "" : "s"}); fingerprint ${
			clioMdRestamped ? "restamped in CLIO.md" : "unchanged"
		}\n`,
	);
	return { action: "refreshed", codewikiEntries: entries, fingerprint: finalFingerprint, clioMdRestamped };
}
