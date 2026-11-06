import { deepStrictEqual, notDeepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { brotliCompressSync } from "node:zlib";
import type { ToolSpec } from "../../src/tools/registry.js";

/** A pack in the layout scripts/build-source-pack.ts writes: magic, u32 LE index length, JSON index, brotli members. */
function writePack(file: string, members: Record<string, string>): void {
	const blobs: Buffer[] = [];
	const files: Array<{ path: string; offset: number; length: number; size: number }> = [];
	let offset = 0;
	for (const path of Object.keys(members).sort()) {
		const bytes = Buffer.from(members[path] ?? "", "utf8");
		const blob = brotliCompressSync(bytes);
		files.push({ path, offset, length: blob.length, size: bytes.length });
		blobs.push(blob);
		offset += blob.length;
	}
	const index = Buffer.from(JSON.stringify({ version: 1, files }), "utf8");
	const header = Buffer.alloc(12);
	header.write("CLIOSRC1", 0, "latin1");
	header.writeUInt32LE(index.length, 8);
	writeFileSync(file, Buffer.concat([header, index, ...blobs]));
}

/**
 * An installed package serves most of its own `src/` from dist/assets/source.pack,
 * so a directory such as `src/interactive` exists only inside the pack. Reading
 * it must answer exactly like reading a loose directory, not "File not found".
 */
describe("packed source directory read", () => {
	let pkg: string;
	let readTool: ToolSpec;
	const savedRoot = process.env.CLIO_CODER_PACKAGE_ROOT;

	before(async () => {
		pkg = realpathSync(mkdtempSync(join(tmpdir(), "clio-packed-dir-")));
		writeFileSync(join(pkg, "package.json"), '{"name":"packed-fixture","version":"0.0.0"}\n');
		mkdirSync(join(pkg, "dist", "assets"), { recursive: true });
		writePack(join(pkg, "dist", "assets", "source.pack"), {
			"src/interactive/nested/view.ts": "export const view = 1;\n",
			"src/interactive/index.ts": "export const index = 1;\n",
		});
		mkdirSync(join(pkg, "src", "loose"), { recursive: true });
		writeFileSync(join(pkg, "src", "loose", "kept.ts"), "export const kept = 1;\n");
		// The package root is cached on first resolve, so it is pinned before read.ts loads.
		process.env.CLIO_CODER_PACKAGE_ROOT = pkg;
		const packageRoot = await import("../../src/core/package-root.js");
		strictEqual(packageRoot.resolvePackageRoot(), pkg, "another import resolved the package root first");
		({ readTool } = await import("../../src/tools/read.js"));
	});

	after(() => {
		if (savedRoot === undefined) delete process.env.CLIO_CODER_PACKAGE_ROOT;
		else process.env.CLIO_CODER_PACKAGE_ROOT = savedRoot;
		rmSync(pkg, { recursive: true, force: true });
	});

	/** A read's verdict with its own path taken out, so two paths compare by behavior rather than by wording. */
	async function readVerdict(path: string): Promise<{ kind: string; message: string | undefined }> {
		const result = (await readTool.run({ path })) as { kind: string; message?: string };
		return { kind: result.kind, message: result.message?.replaceAll(path, "<dir>") };
	}

	for (const relative of ["src/interactive", "src/interactive/nested"]) {
		it(`answers the pack-only ${relative} as the loose src/loose answers`, async () => {
			const loose = await readVerdict(join(pkg, "src", "loose"));
			strictEqual(loose.kind, "error");
			deepStrictEqual(await readVerdict(join(pkg, ...relative.split("/"))), loose);
		});
	}

	it("still reports a path in neither the pack nor on disk as missing", async () => {
		const missing = await readVerdict(join(pkg, "src", "absent"));
		strictEqual(missing.kind, "error");
		notDeepStrictEqual(missing, await readVerdict(join(pkg, "src", "loose")));
	});

	it("still reads a packed member as a file", async () => {
		const result = (await readTool.run({ path: join(pkg, "src", "interactive", "index.ts") })) as {
			kind: string;
			output?: string;
		};
		strictEqual(result.kind, "ok");
		strictEqual(/export const index = 1;/.test(result.output ?? ""), true, result.output);
	});
});
