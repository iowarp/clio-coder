import { rmSync } from "node:fs";
import { defineConfig } from "tsup";

const includeSelfdev = process.env.CLIO_BUILD_PRIVATE === "1";
const baseEntries = {
	"cli/index": "src/cli/index.ts",
	"worker/entry": "src/worker/entry.ts",
};

export default defineConfig({
	entry: includeSelfdev ? { ...baseEntries, "selfdev/index": "src/selfdev/index.ts" } : baseEntries,
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
		"@mariozechner/pi-agent-core",
		"@mariozechner/pi-ai",
		"@mariozechner/pi-tui",
		"@silvia-odwyer/photon-node",
		"typescript",
	],
	onSuccess: includeSelfdev
		? undefined
		: () => {
				rmSync("dist/selfdev", { recursive: true, force: true });
			},
});
