import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { build } from "esbuild";

export type CompileResult = { kind: "ok"; outputPath: string } | { kind: "error"; error: string };

/**
 * Bundle a TypeScript file into a single ESM module on disk under `cacheRoot`.
 *
 * Relative imports (e.g. `../core/tool-names.js`) are inlined because the
 * output lands outside the source tree and relative resolution would fail.
 * Bare specifiers (npm packages and `node:*` builtins) are left external and
 * resolved at runtime via Node's normal module-lookup walk; callers must
 * place `cacheRoot` inside a directory where a `node_modules/` is reachable.
 *
 * Output filenames are content-hashed so every successful compile produces a
 * fresh URL (Node caches ESM by URL, so a new name bypasses the cache
 * without a loader hook).
 */
export async function compileTool(sourcePath: string, cacheRoot: string): Promise<CompileResult> {
	if (!existsSync(sourcePath)) {
		return { kind: "error", error: `source not found: ${sourcePath}` };
	}

	let js: string;
	try {
		const result = await build({
			entryPoints: [sourcePath],
			bundle: true,
			format: "esm",
			platform: "node",
			target: "node20",
			write: false,
			sourcemap: "inline",
			logLevel: "silent",
			plugins: [
				{
					name: "externalize-bare-specifiers",
					setup(b) {
						// Any specifier that does not start with "." or "/" is a bare
						// package name or node builtin; leave it as-is so Node resolves
						// it from the nearest node_modules at runtime.
						b.onResolve({ filter: /^[^./]/ }, (args) => ({ path: args.path, external: true }));
					},
				},
			],
		});
		const outputFile = result.outputFiles?.[0];
		if (!outputFile) {
			return { kind: "error", error: "esbuild produced no output" };
		}
		js = outputFile.text;
	} catch (err) {
		return { kind: "error", error: err instanceof Error ? err.message : String(err) };
	}

	const hash = createHash("sha256").update(js).digest("hex").slice(0, 10);
	const base = basename(sourcePath, ".ts");
	const outDir = join(cacheRoot, "hot", "tools");
	try {
		mkdirSync(outDir, { recursive: true });
	} catch (err) {
		return { kind: "error", error: `mkdir failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	const outputPath = join(outDir, `${base}-${hash}.mjs`);
	try {
		writeFileSync(outputPath, js);
	} catch (err) {
		return { kind: "error", error: `write failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { kind: "ok", outputPath };
}
