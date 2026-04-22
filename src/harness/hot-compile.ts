import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { transform } from "esbuild";

export type CompileResult = { kind: "ok"; outputPath: string } | { kind: "error"; error: string };

/**
 * Transform a TypeScript file to an ESM module on disk under `cacheRoot`.
 * The output filename is content-hashed so every successful compile produces
 * a fresh URL (Node's ESM loader caches by URL, so a new name bypasses the
 * cache without a loader hook).
 */
export async function compileTool(sourcePath: string, cacheRoot: string): Promise<CompileResult> {
	let source: string;
	try {
		source = readFileSync(sourcePath, "utf8");
	} catch (err) {
		return { kind: "error", error: `read failed: ${err instanceof Error ? err.message : String(err)}` };
	}

	let js: string;
	try {
		const result = await transform(source, {
			loader: "ts",
			format: "esm",
			target: "node20",
			sourcefile: sourcePath,
			sourcemap: "inline",
		});
		js = result.code;
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
