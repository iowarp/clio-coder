import { deepStrictEqual, notStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildCodewiki, syncCodewiki } from "../../src/domains/context/codewiki/indexer.js";

const roots: string[] = [];

function project(): string {
	const cwd = mkdtempSync(join(tmpdir(), "clio-codewiki-sync-"));
	roots.push(cwd);
	mkdirSync(join(cwd, "src"));
	return cwd;
}

describe("contracts/codewiki-sync", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's.
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("returns the existing object when the workspace is unchanged", async () => {
		const cwd = project();
		writeFileSync(join(cwd, "src", "main.ts"), "export const main = true;\n");
		const initial = await buildCodewiki({ cwd, language: "typescript" });
		strictEqual(await syncCodewiki(cwd, initial), initial);
	});

	it("reconciles modifications, additions, and deletions", async () => {
		const cwd = project();
		writeFileSync(join(cwd, "src", "main.ts"), "export function oldName() { return 1; }\n");
		const initial = await buildCodewiki({ cwd, language: "typescript" });
		writeFileSync(join(cwd, "src", "main.ts"), "export function newName() { return 2; }\n");
		writeFileSync(join(cwd, "src", "added.ts"), "export const added = true;\n");
		const updated = await syncCodewiki(cwd, initial);
		strictEqual(updated.files.length, 2);
		notStrictEqual(updated, initial);
		strictEqual(
			updated.symbols.some((symbol) => symbol.name === "oldName"),
			false,
		);
		strictEqual(
			updated.symbols.some((symbol) => symbol.name === "newName"),
			true,
		);
		strictEqual(
			updated.files.some((file) => file.path === "src/added.ts"),
			true,
		);

		rmSync(join(cwd, "src", "main.ts"));
		const deleted = await syncCodewiki(cwd, updated);
		deepStrictEqual(
			deleted.files.map((file) => file.path),
			["src/added.ts"],
		);
	});
});
