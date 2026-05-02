import { ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { grepTool } from "../../src/tools/grep.js";

describe("tools/grep", () => {
	it("skips ignored cache directories and binary files", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "clio-grep-"));
		mkdirSync(path.join(root, "src"));
		mkdirSync(path.join(root, ".clio"));
		mkdirSync(path.join(root, ".fallow"));
		writeFileSync(path.join(root, "src", "index.ts"), "export const thinkingBudget = 1;\n", "utf8");
		writeFileSync(path.join(root, ".clio", "codewiki.json"), '{"text":"thinkingBudget"}\n', "utf8");
		writeFileSync(path.join(root, ".fallow", "cache.bin"), "thinkingBudget".repeat(1000), "utf8");
		writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 116, 104, 105, 110, 107, 105, 110, 103]));

		const result = await grepTool.run({ pattern: "thinkingBudget", path: root });

		ok(result.kind === "ok", JSON.stringify(result));
		if (result.kind !== "ok") return;
		ok(result.output.includes("src/index.ts"), result.output);
		ok(!result.output.includes(".clio/codewiki.json"), result.output);
		ok(!result.output.includes(".fallow/cache.bin"), result.output);
		ok(!result.output.includes("blob.bin"), result.output);
		ok(result.output.includes("[skipped"), result.output);
	});
});
