import { defineConfig } from "tsup";

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
	shims: false,
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
	noExternal: ["chalk", "diff", "uuid", "yaml", "typebox", "undici"],
	// The shebang comes from the hashbang line in each entry source file;
	// esbuild hoists it above this banner on the entry chunks and never puts
	// one on a shared chunk.
	banner: {
		js: 'import { createRequire as __clioCreateRequire } from "node:module"; const require = __clioCreateRequire(import.meta.url);',
	},
	// tsup already externalizes every package.json `dependencies` entry, so the
	// runtime deps need no listing here. Only the builtin needs the explicit
	// entry; see removeNodeProtocol above.
	external: ["node:sqlite"],
});
