import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
	// external imports still execute eagerly, so `clio --version` would pay the
	// full module-load tax.
	splitting: true,
	sourcemap: true,
	clean: true,
	dts: false,
	shims: false,
	// Node 22.19 ships `node:sqlite`; retaining the protocol prevents tsup from
	// turning that newer builtin into a lookup for the nonexistent `sqlite` package.
	removeNodeProtocol: false,
	outDir: "dist",
	onSuccess() {
		const recipes = join("dist", "domains", "agents", "builtins");
		rmSync(recipes, { recursive: true, force: true });
		mkdirSync(join("dist", "domains", "agents"), { recursive: true });
		cpSync(join("src", "domains", "agents", "builtins"), recipes, { recursive: true });
	},
	// The shebang comes from the hashbang line in each entry source file;
	// esbuild hoists it to the top of the corresponding entry chunk. A tsup
	// `banner` would stamp it onto every emitted chunk instead.
	external: [
		// Keep the builtin outside generated chunks; see removeNodeProtocol above.
		"node:sqlite",
		"@anthropic-ai/claude-agent-sdk",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-tui",
		"@silvia-odwyer/photon-node",
		"@vscode/tree-sitter-wasm",
		"tree-sitter-wasms",
	],
});
