import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findTool } from "../../src/tools/find.js";
import { grepTool } from "../../src/tools/grep.js";
import { SEARCH_SPAWN_TIMEOUT_MS } from "../../src/tools/spawn-hygiene.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("native searches retain results and clean up at the production timeout", { timeout: 40_000 }, async () => {
	const env = await isolateClioEnv("search-lifecycle-");
	try {
		const root = join(env.dir, "tree");
		const bin = join(env.dir, "bin");
		mkdirSync(root);
		mkdirSync(bin);
		process.env.PATH = bin;
		const file = join(root, "a.txt");
		writeFileSync(file, "needle");
		const match = JSON.stringify({
			type: "match",
			data: { path: { text: file }, line_number: 1, lines: { text: "needle\n" } },
		});
		for (const [name, line] of [
			["rg", match],
			["fd", file],
		]) {
			writeFileSync(
				join(bin, name ?? ""),
				`#!${process.execPath}\nconsole.log(${JSON.stringify(line)}); setInterval(()=>{},1000);\n`,
				{ mode: 0o755 },
			);
		}
		const started = performance.now();
		const results = await Promise.all([
			grepTool.run({ path: root, pattern: "needle" }),
			findTool.run({ path: root, pattern: "*.txt" }),
		]);
		assert.ok(performance.now() - started >= SEARCH_SPAWN_TIMEOUT_MS);
		for (const result of results) {
			assert.equal(result.kind, "ok");
			if (result.kind !== "ok") throw new Error("Expected partial result");
			assert.deepEqual(result.details?.search, { complete: false, reason: "timeout", skipped: { count: 0, samples: [] } });
			assert.match(result.output, /timeout; 1 (matches|paths) shown/);
			assert.match(result.output, /a.txt/);
		}
	} finally {
		env.restore();
	}
});
