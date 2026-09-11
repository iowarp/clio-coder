import { cp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const root = new URL("../../../", import.meta.url);
const app = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

/** Mirrors root tsup policy; root integration and its installed-package gate remain R1. */
await build({
	// Avoid tsup’s temporary bundled config files beside source; tsx uses the external temp directory.
	config: false,
	entry: {
		"web/server": fileURLToPath(new URL("server/main.ts", app)),
		"web/reads-worker": fileURLToPath(new URL("server/worker/reads-main.ts", app)),
		"web/ops-worker": fileURLToPath(new URL("server/worker/ops-main.ts", app)),
	},
	outDir: fileURLToPath(new URL("dist/rehearsal/", app)),
	tsconfig: fileURLToPath(new URL("tsconfig.json", app)),
	format: ["esm"],
	target: "node22",
	platform: "node",
	splitting: true,
	sourcemap: true,
	clean: true,
	dts: false,
	shims: true,
	minify: false,
	removeNodeProtocol: false,
	define: { __CLIO_WEB_BUNDLED__: "true" },
	noExternal: [
		"chalk",
		"diff",
		"uuid",
		"yaml",
		"typebox",
		"@vscode/tree-sitter-wasm",
		/^@earendil-works\/pi-tui(?:\/|$)/,
		"marked",
		"get-east-asian-width",
		"hono",
		"@hono/node-server",
	],
	external: [
		"node:sqlite",
		...Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).filter(
			(name) => name !== "@earendil-works/pi-tui",
		),
	],
	banner: {
		js: 'import { createRequire as __clioCreateRequire } from "node:module"; const require = __clioCreateRequire(import.meta.url);',
	},
	async onSuccess() {
		await cp(new URL("dist/client/", app), new URL("dist/rehearsal/web/client/", app), { recursive: true });
	},
});
