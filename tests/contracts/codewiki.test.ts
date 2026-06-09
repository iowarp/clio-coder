import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildCodewiki, readCodewiki, updateCodewikiPaths, writeCodewiki } from "../../src/domains/context/index.js";
import { loadCodewikiForTool } from "../../src/tools/codewiki/shared.js";

describe("contracts/codewiki", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-codewiki-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("writes v2 entries with kind and optional summary split apart", () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(
			join(scratch, "src", "index.ts"),
			["/**", " * Starts the application.", " */", "export function main() {}", ""].join("\n"),
			"utf8",
		);
		writeFileSync(join(scratch, "src", "math.test.ts"), "export const testValue = 1;\n", "utf8");
		writeFileSync(join(scratch, "src", "worker.ts"), "export const worker = true;\n", "utf8");

		const codewiki = buildCodewiki({ cwd: scratch, language: "typescript", generatedAt: "2026-05-01T00:00:00.000Z" });
		writeCodewiki(scratch, codewiki);
		const read = readCodewiki(scratch);
		ok(read);
		strictEqual(read.version, 2);
		strictEqual(read.entries.find((entry) => entry.path === "src/index.ts")?.kind, "entry-point");
		strictEqual(read.entries.find((entry) => entry.path === "src/index.ts")?.summary, "Starts the application.");
		strictEqual(read.entries.find((entry) => entry.path === "src/math.test.ts")?.kind, "test");
		strictEqual(read.entries.find((entry) => entry.path === "src/worker.ts")?.kind, "module");
	});

	it("treats v1 codewiki files as stale instead of throwing", () => {
		mkdirSync(join(scratch, ".clio"), { recursive: true });
		writeFileSync(
			join(scratch, ".clio", "codewiki.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-05-01T00:00:00.000Z",
				language: "typescript",
				entries: [{ path: "src/index.ts", exports: [], imports: [], role: "entry point" }],
			}),
			"utf8",
		);

		strictEqual(readCodewiki(scratch), null);
	});

	it("updates changed TypeScript paths incrementally", () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "alpha.ts"), "export const alpha = 1;\n", "utf8");
		const original = buildCodewiki({
			cwd: scratch,
			language: "typescript",
			generatedAt: "2026-05-01T00:00:00.000Z",
		});
		writeFileSync(join(scratch, "src", "beta.ts"), "export function beta() {}\n", "utf8");

		const added = updateCodewikiPaths(scratch, original, ["src/beta.ts"]);
		ok(added !== original);
		ok(added.entries.some((entry) => entry.path === "src/beta.ts" && entry.exports.includes("beta")));

		rmSync(join(scratch, "src", "alpha.ts"));
		const removed = updateCodewikiPaths(scratch, added, ["src/alpha.ts"]);
		strictEqual(
			removed.entries.some((entry) => entry.path === "src/alpha.ts"),
			false,
		);

		const untouched = updateCodewikiPaths(scratch, removed, ["README.md"]);
		strictEqual(untouched, removed);
	});

	it("rebuilds missing or stale codewiki on tool demand", () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		mkdirSync(join(scratch, ".clio"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const rebuilt = true;\n", "utf8");
		writeFileSync(
			join(scratch, ".clio", "codewiki.json"),
			JSON.stringify({
				version: 1,
				generatedAt: "2026-05-01T00:00:00.000Z",
				language: "typescript",
				entries: [],
			}),
			"utf8",
		);

		const loaded = loadCodewikiForTool(scratch);
		if (!loaded.ok) throw new Error(loaded.message);
		strictEqual(loaded.codewiki.version, 2);
		ok(loaded.codewiki.entries.some((entry) => entry.path === "src/index.ts" && entry.exports.includes("rebuilt")));
		ok(existsSync(join(scratch, ".clio", "codewiki.json")));
		ok(existsSync(join(scratch, ".clio", "state.json")));
	});
});
