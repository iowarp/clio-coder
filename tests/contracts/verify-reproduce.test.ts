import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	type DeclaredReproduce,
	judgeReproduce,
	parseReproducePayload,
	type ReproduceConditions,
} from "../../src/tools/verify/reproduce.js";
import { runReproduce } from "../../src/tools/verify/reproduce-run.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-verify-reproduce-")));
	roots.push(root);
	return root;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const conditions: ReproduceConditions = {
	inputs: [],
	environment: "copy",
	commit: null,
	trackedTreeClean: null,
	seed: null,
	platform: { os: "linux", arch: "x64", release: "r", nodeVersion: "n", clioVersion: "c" },
	argv: ["x"],
	cwd: ".",
};

describe("reproduce judgement", () => {
	it("fails a units mismatch and a declared shape mismatch even when every value agrees", () => {
		const spec: DeclaredReproduce = {
			inputs: [],
			compare: { mode: "twice" },
			tolerance: { relative: 1e-12 },
			units: { t: "K" },
			shapes: { m: [3, 2] },
		};
		const payload = parseReproducePayload('{"t":{"value":1.5,"units":"degC"},"m":[[1,2,3],[4,5,6]]}', "out");
		ok(!(payload instanceof Error));
		const report = judgeReproduce({
			spec,
			actual: payload,
			expected: payload,
			expectedIsReference: false,
			conditions,
			runs: [],
		});
		strictEqual(report.passed, false);
		deepStrictEqual(report.failedMetrics, ["m", "t"]);
		deepStrictEqual(report.metrics.find((metric) => metric.metric === "t")?.failed, ["units-mismatch"]);
		deepStrictEqual(report.metrics.find((metric) => metric.metric === "m")?.shape?.reported, [
			[2, 3],
			[2, 3],
		]);
	});

	it("refuses a ragged array instead of flattening it", () => {
		ok(parseReproducePayload('{"m":[[1,2],[3]]}', "out") instanceof Error);
	});
});

describe("reproduce runner", () => {
	it("refuses on a digest mismatch before running and naming both digests", async () => {
		const root = scratch();
		writeFileSync(join(root, "data.txt"), "measured\n");
		const marker = "require('fs').writeFileSync('ran', '1')\n";
		writeFileSync(join(root, "marker.js"), marker);
		const pinned = sha256("original\n");
		const outcome = await runReproduce({
			command: ["node", "marker.js"],
			cwd: ".",
			timeoutMs: 10_000,
			spec: {
				inputs: [
					{ path: "data.txt", sha256: pinned },
					{ path: "marker.js", sha256: sha256(marker) },
				],
				environment: "copy",
				compare: { mode: "twice" },
				tolerance: { absolute: 0 },
			},
			workspaceRoot: root,
			scratchRoot: join(root, "envs"),
		});
		strictEqual(outcome.kind, "refused");
		if (outcome.kind !== "refused") return;
		deepStrictEqual(outcome.refusal.mismatches, [{ path: "data.txt", expected: pinned, actual: sha256("measured\n") }]);
		ok(!readdirSync(root).includes("envs") && !readdirSync(root).includes("ran"), "nothing ran");
	});

	it("passes twice in two copies that are removed afterwards, with the seed recorded", async () => {
		const root = scratch();
		const script = "const s=Number(process.env.SEED);console.log(JSON.stringify({x:{value:Math.sin(s),units:'m'}}))\n";
		writeFileSync(join(root, "a.js"), script);
		const outcome = await runReproduce({
			command: ["node", "a.js"],
			cwd: ".",
			timeoutMs: 10_000,
			spec: {
				inputs: [{ path: "a.js", sha256: sha256(script) }],
				environment: "copy",
				seed: { env: "SEED", value: "7" },
				compare: { mode: "twice" },
				tolerance: { absolute: 0 },
				units: { x: "m" },
			},
			workspaceRoot: root,
			scratchRoot: join(root, "envs"),
		});
		strictEqual(outcome.kind, "judged");
		if (outcome.kind !== "judged") return;
		strictEqual(outcome.report.passed, true);
		deepStrictEqual(outcome.report.conditions.seed, { env: "SEED", value: "7" });
		strictEqual(outcome.report.runs.length, 2);
		deepStrictEqual(readdirSync(join(root, "envs")), []);
	});
});
