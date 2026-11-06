import { join } from "node:path";
import { type PinnedAsset, pinnedAssetPresent } from "../../../core/pinned-asset.js";
import { resolveClioDirs } from "../../../core/xdg.js";
import { FETCHED_GRAMMAR_PACKAGE, FETCHED_GRAMMARS, type FetchedGrammar } from "./grammar-assets.js";

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
 * were indexed without their parser. The cache is the cross-process record:
 * the indexer may run in another process, and without the grammar on disk no
 * process could have parsed these files with tree-sitter.
 */
export function missingGrammarNote(langs: ReadonlySet<string>): string | undefined {
	const missing = FETCHED_GRAMMARS.filter(
		(grammar) => langs.has(grammar.lang) && !pinnedAssetPresent(fetchedGrammarAsset(grammar)),
	);
	if (missing.length === 0) return undefined;
	const names = missing.map((grammar) => grammar.language).join(" and ");
	return (
		`${names} symbols come from line patterns, not a parser: Clio downloads the ${names} tree-sitter grammar on first use ` +
		"and could not (offline, or the download failed). Symbols and imports for those files may be incomplete; use grep for an exhaustive search."
	);
}
