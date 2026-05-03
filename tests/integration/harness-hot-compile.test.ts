import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { compileTool } from "../../src/selfdev/harness/hot-compile.js";

describe("compileTool", () => {
	let tmp: string;
	let cache: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "clio-hot-compile-"));
		cache = join(tmp, "cache");
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("transforms a valid TS tool file to an ESM bundle on disk", async () => {
		const source = join(tmp, "fake.ts");
		writeFileSync(source, `export const fakeTool = { name: "fake", run: async () => ({ kind: "ok", output: "hi" }) };\n`);
		const result = await compileTool(source, cache);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.outputPath.endsWith(".mjs"), `expected .mjs, got ${result.outputPath}`);
		const contents = readFileSync(result.outputPath, "utf8");
		ok(contents.includes("fakeTool"), "compiled output should reference fakeTool");
		ok(contents.includes("export"), "compiled output should be ESM");
	});

	it("returns an error result for invalid TS", async () => {
		const source = join(tmp, "broken.ts");
		writeFileSync(source, "export const x: = }\n");
		const result = await compileTool(source, cache);
		strictEqual(result.kind, "error");
		if (result.kind === "error") ok(result.error.length > 0);
	});

	it("uses content-hashed filenames so repeated compiles are cache-busted", async () => {
		const source = join(tmp, "same.ts");
		writeFileSync(source, `export const sameTool = { name: "same" };\n`);
		const a = await compileTool(source, cache);
		writeFileSync(source, `export const sameTool = { name: "same2" };\n`);
		const b = await compileTool(source, cache);
		strictEqual(a.kind, "ok");
		strictEqual(b.kind, "ok");
		if (a.kind === "ok" && b.kind === "ok") ok(a.outputPath !== b.outputPath);
	});
});
