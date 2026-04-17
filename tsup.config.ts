import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		"cli/index": "src/cli/index.ts",
		"worker/entry": "src/worker/entry.ts",
	},
	format: ["esm"],
	target: "node20",
	platform: "node",
	splitting: false,
	sourcemap: true,
	clean: true,
	dts: false,
	shims: false,
	outDir: "dist",
	banner: ({ format }) => (format === "esm" ? { js: "#!/usr/bin/env node" } : {}),
	external: ["@mariozechner/pi-agent-core", "@mariozechner/pi-ai", "@mariozechner/pi-tui"],
});
