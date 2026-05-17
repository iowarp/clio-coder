import { defineConfig } from "tsup";

const entries = {
	"cli/index": "src/cli/index.ts",
	"worker/entry": "src/worker/entry.ts",
};

export default defineConfig({
	entry: entries,
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
	external: [
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-tui",
		"@silvia-odwyer/photon-node",
		"typescript",
	],
});
