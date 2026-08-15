import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "tsup";
import { GRAMMAR_ASSETS, type GrammarAssetSource } from "./src/domains/context/codewiki/grammar-assets.js";

const require = createRequire(import.meta.url);

/** Where each grammar package keeps its wasm files, resolved from the checkout's devDependencies. */
const GRAMMAR_SOURCE_DIRS: Record<GrammarAssetSource, string> = {
	"@vscode/tree-sitter-wasm": dirname(require.resolve("@vscode/tree-sitter-wasm")),
	"tree-sitter-wasms": join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out"),
};

/** Notices that travel with the vendored wasm; each lands beside the grammars under its package name. */
const GRAMMAR_NOTICES: Record<GrammarAssetSource, string[]> = {
	"@vscode/tree-sitter-wasm": ["LICENSE", "cgmanifest.json"],
	"tree-sitter-wasms": ["LICENSE"],
};

/**
 * Vendor the twelve wasm files the codewiki indexer loads into
 * dist/assets/grammars/ so the package needs neither grammar collection at
 * install time (~72MB between them; ~19MB actually used).
 */
function vendorGrammars(): void {
	const target = join("dist", "assets", "grammars");
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	for (const asset of GRAMMAR_ASSETS) {
		cpSync(join(GRAMMAR_SOURCE_DIRS[asset.from], asset.file), join(target, asset.file));
	}
	for (const [source, notices] of Object.entries(GRAMMAR_NOTICES) as Array<[GrammarAssetSource, string[]]>) {
		const packageDir = dirname(require.resolve(`${source}/package.json`));
		const noticeDir = join(target, "notices", source.replace("/", "__"));
		mkdirSync(noticeDir, { recursive: true });
		for (const notice of notices) cpSync(join(packageDir, notice), join(noticeDir, notice));
	}
}

const entries = {
	"cli/index": "src/cli/index.ts",
	"worker/entry": "src/worker/entry.ts",
};

export default defineConfig({
	entry: entries,
	format: ["esm"],
	target: "node22",
	platform: "node",
	// Code splitting is what makes cli/index.ts's dynamic `await import("./x.js")`
	// per-subcommand loading pay off: each command module (and its transitive
	// heavy externals) lands in its own chunk, loaded only when that subcommand
	// runs. Without splitting, esbuild inlines everything into one chunk and the
	// external imports still execute eagerly, so `clio-coder --version` would pay the
	// full module-load tax.
	splitting: true,
	sourcemap: true,
	clean: true,
	dts: false,
	// The web-tree-sitter runtime (bundled from @vscode/tree-sitter-wasm) is a
	// UMD that probes `__filename` at module scope; the ESM shim supplies it.
	shims: true,
	// No minification, by decision (#64, #65): dist/ is Clio-facing. She reads
	// her own installed code, and stack traces from the field must name real
	// symbols. The ~2MB it would save is not worth an opaque package.
	minify: false,
	// Node 22.19 ships `node:sqlite`; retaining the protocol prevents tsup from
	// turning that newer builtin into a lookup for the nonexistent `sqlite` package.
	removeNodeProtocol: false,
	outDir: "dist",
	// The pure-JS tail is bundled and tree-shaken into dist/ so an install does
	// not pull these packages; they live in devDependencies. undici is CJS that
	// require()s node builtins, so every ESM chunk needs a real `require` (see
	// banner below).
	noExternal: ["chalk", "diff", "uuid", "yaml", "typebox", "undici", "@vscode/tree-sitter-wasm"],
	// The shebang comes from the hashbang line in each entry source file;
	// esbuild hoists it above this banner on the entry chunks and never puts
	// one on a shared chunk.
	banner: {
		js: 'import { createRequire as __clioCreateRequire } from "node:module"; const require = __clioCreateRequire(import.meta.url);',
	},
	onSuccess() {
		vendorGrammars();
	},
	// tsup already externalizes every package.json `dependencies` entry, so the
	// runtime deps need no listing here. Only the builtin needs the explicit
	// entry; see removeNodeProtocol above.
	external: ["node:sqlite"],
});
