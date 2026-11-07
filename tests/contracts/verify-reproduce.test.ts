import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { withReadOnlyMode } from "../../src/core/read-only-mode.js";
import { currentProcessLease } from "../../src/tools/process-lease.js";
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

	it("sweeps the worktrees a dead run left before the next run, keeping a live run's and a fresh unowned one", async () => {
		const root = scratch();
		const repo = join(root, "repo");
		mkdirSync(repo);
		const gitIn = (cwd: string, ...args: string[]) =>
			execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
		const script = "console.log(JSON.stringify({x:1}))\n";
		writeFileSync(join(repo, "a.js"), script);
		gitIn(repo, "init", "-q");
		gitIn(repo, "add", "a.js");
		gitIn(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
		const envs = join(root, "envs");
		const leave = (owner: unknown) => {
			const base = join(envs, randomUUID());
			gitIn(repo, "worktree", "add", "--detach", "--quiet", join(base, "tree"), "HEAD");
			if (owner !== undefined) writeFileSync(join(base, "owner.json"), JSON.stringify({ owner, repository: repo }));
			return base;
		};
		const exited = spawnSync(process.execPath, ["-e", ""]).pid;
		ok(exited !== undefined);
		const dead = leave({ host: hostname(), pid: exited, birthToken: "linux:0" });
		const live = leave(currentProcessLease());
		const oldUnowned = leave(undefined);
		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		utimesSync(oldUnowned, twoDaysAgo, twoDaysAgo);
		const freshUnowned = leave(undefined);
		const run = () =>
			runReproduce({
				command: ["node", "a.js"],
				cwd: ".",
				timeoutMs: 10_000,
				spec: { inputs: [], compare: { mode: "twice" }, tolerance: { absolute: 0 } },
				workspaceRoot: repo,
				scratchRoot: envs,
			});
		const registered = () =>
			gitIn(repo, "worktree", "list", "--porcelain")
				.split("\n")
				.filter((line) => line.startsWith("worktree "))
				.map((line) => realpathSync(line.slice("worktree ".length)));
		// Read-only work leaves Clio's state as it found it, abandoned environments included.
		strictEqual((await withReadOnlyMode(run)).kind, "judged");
		ok(existsSync(dead) && existsSync(oldUnowned));
		strictEqual((await run()).kind, "judged");
		deepStrictEqual(readdirSync(envs).sort(), [live, freshUnowned].map((base) => base.slice(envs.length + 1)).sort());
		deepStrictEqual(
			registered().sort(),
			[repo, join(live, "tree"), join(freshUnowned, "tree")].map((path) => realpathSync(path)).sort(),
		);
	});
});
