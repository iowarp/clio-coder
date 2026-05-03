import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { devMemoryPath } from "../../src/selfdev/memory.js";
import { clioRecallTool } from "../../src/selfdev/tools/recall.js";
import { clioRememberTool } from "../../src/selfdev/tools/remember.js";
import type { ToolResult } from "../../src/tools/registry.js";

const dirs: string[] = [];

function tmpRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-selfdev-memory-"));
	dirs.push(dir);
	return dir;
}

function parse(result: ToolResult): Record<string, unknown> {
	strictEqual(result.kind, "ok");
	return JSON.parse(result.output) as Record<string, unknown>;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("selfdev memory tools", () => {
	it("round-trips remember and recall by tag", async () => {
		const repo = tmpRepo();
		const remember = clioRememberTool({ repoRoot: repo });
		const recall = clioRecallTool({ repoRoot: repo });
		strictEqual(parse(await remember.run({ note: "prefer focused tests", tags: ["tests", "tests"] })).row_count, 1);
		const rows = parse(await recall.run({ tags: ["tests"], limit: 5 })).entries as Array<{
			note: string;
			tags: string[];
		}>;
		strictEqual(rows[0]?.note, "prefer focused tests");
		strictEqual(rows[0]?.tags.join(","), "tests");
	});

	it("rotates when the memory file exceeds 64 KB", async () => {
		const repo = tmpRepo();
		const file = devMemoryPath(repo);
		mkdirSync(join(repo, ".clio"), { recursive: true });
		writeFileSync(file, "x".repeat(64 * 1024), "utf8");
		parse(await clioRememberTool({ repoRoot: repo }).run({ note: "after rotation" }));
		ok(existsSync(`${file}.1`));
	});
});
