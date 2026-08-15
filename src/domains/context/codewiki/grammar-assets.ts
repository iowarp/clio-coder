/**
 * The tree-sitter wasm files the codewiki indexer loads, and the package each
 * one is copied from at build time. tsup.config.ts vendors exactly this list
 * into dist/assets/grammars/, and tree-sitter.ts resolves grammars from there,
 * so the two cannot drift: the packages themselves are devDependencies and are
 * absent from an installed package.
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
	{ file: "tree-sitter-ruby.wasm", from: "@vscode/tree-sitter-wasm" },
	{ file: "tree-sitter-c-sharp.wasm", from: "@vscode/tree-sitter-wasm" },
];
