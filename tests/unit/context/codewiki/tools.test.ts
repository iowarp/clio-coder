import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type CodewikiEntry, writeCodewiki } from "../../../../src/domains/context/codewiki/indexer.js";
import { entryPointsTool } from "../../../../src/tools/codewiki/entry-points.js";
import { findSymbolTool } from "../../../../src/tools/codewiki/find-symbol.js";
import { whereIsTool } from "../../../../src/tools/codewiki/where-is.js";

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
	const prev = process.cwd();
	process.chdir(cwd);
	try {
		return await fn();
	} finally {
		process.chdir(prev);
	}
}

function parseEntries(output: string): CodewikiEntry[] {
	const parsed = JSON.parse(output) as { entries?: CodewikiEntry[] };
	return parsed.entries ?? [];
}

describe("codewiki query tools", () => {
	it("query the local codewiki index", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-codewiki-tools-"));
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ main: "dist/index.js" }), "utf8");
			writeCodewiki(dir, {
				version: 1,
				generatedAt: "2026-05-01T00:00:00.000Z",
				language: "typescript",
				entries: [
					{ path: "src/index.ts", exports: ["value"], imports: [], role: "entry point" },
					{ path: "src/util.ts", exports: ["helper"], imports: [] },
				],
			});

			await withCwd(dir, async () => {
				const symbol = await findSymbolTool.run({ symbol: "helper" });
				strictEqual(symbol.kind, "ok");
				if (symbol.kind === "ok") strictEqual(parseEntries(symbol.output)[0]?.path, "src/util.ts");

				const entries = await entryPointsTool.run({});
				strictEqual(entries.kind, "ok");
				if (entries.kind === "ok") strictEqual(parseEntries(entries.output)[0]?.path, "src/index.ts");

				const located = await whereIsTool.run({ pattern: "src/*.ts" });
				strictEqual(located.kind, "ok");
				if (located.kind === "ok") strictEqual(parseEntries(located.output).length, 2);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns a clean error when codewiki is absent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-codewiki-tools-empty-"));
		try {
			await withCwd(dir, async () => {
				const result = await findSymbolTool.run({ symbol: "x" });
				strictEqual(result.kind, "error");
				if (result.kind === "error") ok(result.message.includes("codewiki not built"));
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
