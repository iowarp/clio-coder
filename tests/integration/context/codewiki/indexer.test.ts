import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildCodewiki, readCodewiki, writeCodewiki } from "../../../../src/domains/context/codewiki/indexer.js";

function scratch(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "clio-codewiki-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("context/codewiki indexer", () => {
	it("extracts TypeScript exports, imports, and roles deterministically", () => {
		const t = scratch();
		try {
			mkdirSync(join(t.dir, "src"), { recursive: true });
			writeFileSync(join(t.dir, "src", "util.ts"), "export function helper() {}\n", "utf8");
			writeFileSync(
				join(t.dir, "src", "index.ts"),
				"/** Main entry. */\nimport { helper } from './util.js';\nexport const value = helper;\nexport { helper };\n",
				"utf8",
			);
			const codewiki = buildCodewiki({
				cwd: t.dir,
				language: "typescript",
				generatedAt: "2026-05-01T00:00:00.000Z",
			});
			strictEqual(codewiki.entries.length, 2);
			const index = codewiki.entries.find((entry) => entry.path === "src/index.ts");
			ok(index);
			deepStrictEqual(index.exports, ["helper", "value"]);
			deepStrictEqual(index.imports, ["src/util.ts"]);
			strictEqual(index.role, "Main entry.");
		} finally {
			t.cleanup();
		}
	});

	it("round-trips .clio/codewiki.json", () => {
		const t = scratch();
		try {
			const codewiki = {
				version: 1 as const,
				generatedAt: "2026-05-01T00:00:00.000Z",
				language: "typescript" as const,
				entries: [{ path: "src/index.ts", exports: ["value"], imports: [], role: "entry point" }],
			};
			writeCodewiki(t.dir, codewiki);
			strictEqual(readCodewiki(t.dir)?.entries[0]?.path, "src/index.ts");
		} finally {
			t.cleanup();
		}
	});
});
