import { join } from "node:path";
import { type PinnedAsset, pinnedAssetFailure } from "../../../core/pinned-asset.js";
import { resolveClioDirs } from "../../../core/xdg.js";
import { FETCHED_GRAMMAR_PACKAGE, FETCHED_GRAMMARS, type FetchedGrammar } from "./grammar-assets.js";
import type { CodewikiFile } from "./schema.js";

/**
 * One first-use grammar download may hold an index build this long, connect
 * phase included. Both grammars are a few MB and arrived in 130 to 260 ms on a
 * working link; past this the network is treated as absent.
 */
export const GRAMMAR_FETCH_TIMEOUT_MS = 5_000;

/**
 * After a failed download no process retries that grammar for this long (the
 * record sits beside the cache path), so an air-gapped node pays the timeout
 * once per window rather than once per session or incremental update.
 */
export const GRAMMAR_FETCH_RETRY_MS = 10 * 60_000;

/**
 * Where a first-use grammar comes from and where it is kept. jsDelivr serves
 * single files out of the exact npm release, so one grammar costs its own
 * bytes rather than the whole 22 MB package; the sha256 pin makes the mirror
 * untrusted. The cache path carries the package version, so a version bump
 * never loads a grammar built for another runtime ABI.
 */
export function fetchedGrammarAsset(grammar: FetchedGrammar): PinnedAsset {
	const { name, version } = FETCHED_GRAMMAR_PACKAGE;
	return {
		label: `the ${grammar.language} tree-sitter grammar`,
		url: `https://cdn.jsdelivr.net/npm/${name}@${version}/wasm/${grammar.file}`,
		sha256: grammar.sha256,
		path: join(resolveClioDirs().cache, "grammars", `${name.replace("/", "__")}@${version}`, grammar.file),
	};
}

export function fetchedGrammarForFile(file: string): FetchedGrammar | undefined {
	return FETCHED_GRAMMARS.find((grammar) => grammar.file === file);
}

/**
 * The plain statement code_nav gives when files of a fetched-grammar language
 * were indexed without their parser. Each file records that when it is indexed,
 * in whichever process: the grammar's cache file says nothing about it, since
 * read-only mode parses with a downloaded grammar it never keeps on disk.
 */
export function missingGrammarNote(files: Iterable<CodewikiFile>): string | undefined {
	const langs = new Set<string>();
	for (const file of files) if (file.grammarMissing) langs.add(file.lang);
	const missing = FETCHED_GRAMMARS.filter((grammar) => langs.has(grammar.lang));
	if (missing.length === 0) return undefined;
	const names = missing.map((grammar) => grammar.language).join(" and ");
	const reasons = missing
		.map((grammar) => pinnedAssetFailure(fetchedGrammarAsset(grammar), GRAMMAR_FETCH_RETRY_MS))
		.filter((reason): reason is string => reason !== null);
	const why = reasons.length > 0 ? reasons.join("; ") : "offline, or the download failed";
	return (
		`${names} symbols come from line patterns, not a parser: Clio downloads the ${names} tree-sitter grammar on first use ` +
		`and could not (${why}). Symbols and imports for those files may be incomplete; use grep for an exhaustive search.`
	);
}
