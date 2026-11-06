/**
 * The tree-sitter wasm files the codewiki indexer loads, and the package each
 * one is copied from at build time. tsup.config.ts vendors exactly the
 * GRAMMAR_ASSETS list into dist/assets/grammars/, and tree-sitter.ts resolves
 * grammars from there, so the two cannot drift: the packages themselves are
 * devDependencies and are absent from an installed package. FETCHED_GRAMMARS
 * do not ship; tree-sitter.ts fetches each on first use (fetched-grammars.ts).
 */
export type GrammarAssetSource = "@vscode/tree-sitter-wasm" | "tree-sitter-wasms";

export interface GrammarAsset {
	file: string;
	from: GrammarAssetSource;
}

/** The web-tree-sitter runtime module; the parser cannot start without it. */
export const TREE_SITTER_RUNTIME_WASM = "tree-sitter.wasm";

export const GRAMMAR_ASSETS: ReadonlyArray<GrammarAsset> = [
	{ file: TREE_SITTER_RUNTIME_WASM, from: "@vscode/tree-sitter-wasm" },
	{ file: "tree-sitter-typescript.wasm", from: "@vscode/tree-sitter-wasm" },
	{ file: "tree-sitter-tsx.wasm", from: "@vscode/tree-sitter-wasm" },
	{ file: "tree-sitter-javascript.wasm", from: "@vscode/tree-sitter-wasm" },
	{ file: "tree-sitter-python.wasm", from: "@vscode/tree-sitter-wasm" },
	{ file: "tree-sitter-go.wasm", from: "@vscode/tree-sitter-wasm" },
	{ file: "tree-sitter-rust.wasm", from: "@vscode/tree-sitter-wasm" },
	// VS Code does not ship a C grammar; its runtime accepts this ABI-compatible
	// compact C side module from tree-sitter-wasms.
	{ file: "tree-sitter-c.wasm", from: "tree-sitter-wasms" },
	{ file: "tree-sitter-cpp.wasm", from: "@vscode/tree-sitter-wasm" },
	{ file: "tree-sitter-java.wasm", from: "@vscode/tree-sitter-wasm" },
];

export interface FetchedGrammar {
	file: string;
	/** The codewiki language whose files this grammar parses. */
	lang: "ruby" | "c#";
	/** Language name for operator-facing text. */
	language: string;
	sha256: string;
}

/**
 * Must equal the `@vscode/tree-sitter-wasm` devDependency: the fetched grammars
 * load into the runtime vendored from that package, so their ABI has to match.
 * tsup.config.ts refuses a build whose installed copies hash differently.
 */
export const FETCHED_GRAMMAR_PACKAGE = { name: "@vscode/tree-sitter-wasm", version: "0.3.1" } as const;

/**
 * Ruby (2.1 MB) and C# (5.1 MB) were a third of the shipped grammar bytes for
 * languages HPC code rarely uses, so they are fetched on first use instead.
 */
export const FETCHED_GRAMMARS: ReadonlyArray<FetchedGrammar> = [
	{
		file: "tree-sitter-ruby.wasm",
		lang: "ruby",
		language: "Ruby",
		sha256: "09a96427d7c72f0613ed470cd9812223fc4a91d6a9c025c0235cc6bd59ff96f4",
	},
	{
		file: "tree-sitter-c-sharp.wasm",
		lang: "c#",
		language: "C#",
		sha256: "d12d85996c25957b4c1b71e26db2d7cc8a294997b60642e9c2a3b031b2c66dd3",
	},
];
