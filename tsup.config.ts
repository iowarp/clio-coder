import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
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

/** Patched Pi JS is bundled; the pinned runtime package retains its native assets.
 * native-module-path resolves that installed package before package-relative fallbacks.
 */
function vendorTuiNotices(): void {
	const target = join("dist", "assets", "tui-notices");
	mkdirSync(target, { recursive: true });
	const piRequire = createRequire(require.resolve("@earendil-works/pi-tui"));
	cpSync("src/engine/notices/pi-tui-LICENSE", join(target, "pi-tui-LICENSE"));
	cpSync(join(dirname(piRequire.resolve("marked/package.json")), "LICENSE"), join(target, "marked-LICENSE"));
	cpSync(
		join(dirname(piRequire.resolve("get-east-asian-width")), "license"),
		join(target, "get-east-asian-width-LICENSE"),
	);
}

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
	"web/server": "apps/clio-coder-web/server/main.ts",
	"web/reads-worker": "apps/clio-coder-web/server/worker/reads-main.ts",
	"web/ops-worker": "apps/clio-coder-web/server/worker/ops-main.ts",
	"worker/entry": "src/worker/entry.ts",
	"codewiki/build-worker": "src/domains/context/codewiki/build-worker.ts",
};

export default defineConfig({
	entry: entries,
	define: { __CLIO_WEB_BUNDLED__: "true" },
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
	// not pull these packages; they live in devDependencies.
	noExternal: [
		"hono",
		"@hono/node-server",
		"chalk",
		"diff",
		"uuid",
		"yaml",
		"typebox",
		"@vscode/tree-sitter-wasm",
		/^@earendil-works\/pi-tui(?:\/|$)/,
		"marked",
		"get-east-asian-width",
	],
	// The shebang comes from the hashbang line in each entry source file;
	// esbuild hoists it above this banner on the entry chunks and never puts
	// one on a shared chunk.
	banner: {
		js: 'import { createRequire as __clioCreateRequire } from "node:module"; const require = __clioCreateRequire(import.meta.url);',
	},
	async onSuccess() {
		const appRequire = createRequire(join(process.cwd(), "apps/clio-coder-web/package.json"));
		const { build: buildClient } = await import(appRequire.resolve("vite"));
		await buildClient({ configFile: "apps/clio-coder-web/vite.config.ts", configLoader: "runner" });
		cpSync("apps/clio-coder-web/dist/client", "dist/web/client", { recursive: true });
		vendorGrammars();
		vendorTuiNotices();
		const notices = join("dist", "assets", "web-notices");
		mkdirSync(notices, { recursive: true });
		for (const name of ["hono", "@hono/node-server"]) {
			let directory = dirname(appRequire.resolve(name));
			while (!existsSync(join(directory, "LICENSE"))) {
				const parent = dirname(directory);
				if (parent === directory) throw new Error(`Missing license for ${name}`);
				directory = parent;
			}
			cpSync(join(directory, "LICENSE"), join(notices, `${name.replace("/", "__")}-LICENSE`));
		}
	},
	// tsup already externalizes every package.json `dependencies` entry, so the
	// runtime deps need no listing here. `optionalDependencies` is not part of
	// that default, so the Claude Agent SDK needs the explicit entry: without it
	// esbuild would bundle the optional package into dist/ and reintroduce the
	// hard requirement that #258 removed. External keeps the lazy
	// `await import()` in src/engine/claude/sdk-module.ts a real runtime import.
	// The builtin entry is for removeNodeProtocol above.
	external: ["node:sqlite", "@anthropic-ai/claude-agent-sdk"],
});
