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
	outDir: "dist",
	banner: ({ format }) => (format === "esm" ? { js: "#!/usr/bin/env node" } : {}),
	external: [
		"@anthropic-ai/claude-agent-sdk",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-tui",
		"@silvia-odwyer/photon-node",
		"typescript",
		"tree-sitter-wasms",
		"web-tree-sitter",
	],
});
