import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_SEED, generateCorpus } from "../../evals/tool-bench/lib/corpus.js";
import { renderEditSuite } from "../../evals/tool-bench/lib/suite-gen.js";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "../..");
const DRIVER = "evals/tool-bench/lib/driver.ts";

interface DriverRun {
	exitCode: number;
	metrics: Record<string, unknown>;
}

async function runDriver(id: string): Promise<DriverRun> {
	const args = ["--import", "tsx", DRIVER, "--scenario", id, "--seed", String(DEFAULT_SEED), "--split", "search"];
	let stdout: string;
	let exitCode = 0;
	try {
		({ stdout } = await execFileAsync(process.execPath, args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }));
	} catch (error) {
		const failed = error as { stdout?: string; code?: number };
		stdout = failed.stdout ?? "";
		exitCode = failed.code ?? 1;
	}
	const line = stdout.trim().split("\n").at(-1) ?? "{}";
	return { exitCode, metrics: (JSON.parse(line) as { metrics?: Record<string, unknown> }).metrics ?? {} };
}

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
	return out;
}

describe("tool-bench edit driver across processes", () => {
	it("gives identical digests and fs_ops for every default scenario in two separate driver processes", async () => {
		const ids = generateCorpus(DEFAULT_SEED, "search").map((scenario) => scenario.id);
		const first = await inBatches(ids, 4, runDriver);
		const second = await inBatches(ids, 4, runDriver);
		for (const [index, id] of ids.entries()) {
			const left = first[index] as DriverRun;
			const right = second[index] as DriverRun;
			strictEqual(left.exitCode, 0, `${id} solved`);
			strictEqual(right.exitCode, 0, `${id} solved`);
			deepStrictEqual(
				[right.metrics["custom.digest.behavior"], right.metrics["custom.counters.fs_ops"]],
				[left.metrics["custom.digest.behavior"], left.metrics["custom.counters.fs_ops"]],
				id,
			);
		}
	});

	it("lands the driver's metrics unchanged in a sealed eval artifact", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-coder-tool-bench-suite-"));
		// One task of the committed suite, pointed at this checkout by absolute path.
		const suite = renderEditSuite("search", "default")
			.split("\n  - id: ")
			.slice(0, 2)
			.join("\n  - id: ")
			.replace("path: ../..", `path: ${ROOT}`);
		const suitePath = join(scratch, "edit-one.yaml");
		writeFileSync(suitePath, `${suite}\n`);
		const artifactPath = join(scratch, "artifact.json");
		await execFileAsync(
			process.execPath,
			[join(ROOT, "dist/cli/index.js"), "eval", "run", "--suite", suitePath, "--trials", "1", "--out", artifactPath],
			{ cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
		);
		const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
			results: Array<{ taskId: string; pass: boolean; metrics: Record<string, unknown> }>;
		};
		strictEqual(artifact.results.length, 1);
		const result = artifact.results[0];
		ok(result !== undefined);
		strictEqual(result.taskId, "edit.search.size-1k-head");
		strictEqual(result.pass, true);
		strictEqual(result.metrics["task.solved"], true);
		const direct = await runDriver("edit.search.size-1k-head");
		strictEqual(result.metrics["custom.digest.behavior"], direct.metrics["custom.digest.behavior"]);
		strictEqual(result.metrics["custom.counters.fs_ops"], direct.metrics["custom.counters.fs_ops"]);
		for (const key of [
			"custom.latency.wall_ms",
			"custom.memory.max_rss_kb",
			"custom.cpu.user_ms",
			"custom.cpu.system_ms",
		]) {
			strictEqual(typeof result.metrics[key], "number", key);
		}
	});
});
