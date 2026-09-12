import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runHostVerification } from "../../src/domains/dispatch/host-verification.js";
import { loadProjectVerifierCatalog } from "../../src/tools/verify/catalog.js";
import { evaluatePerfBudget, parsePerfBaseline, renderPerfBaseline } from "../../src/tools/verify/perf.js";
import { recordPerfBaseline, runProjectCheck } from "../../src/tools/verify/scripts.js";

const roots: string[] = [];
const originalCwd = process.cwd();

function workspace(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-verify-perf-")));
	roots.push(root);
	for (const [relative, text] of Object.entries(files)) {
		mkdirSync(join(root, relative, ".."), { recursive: true });
		writeFileSync(join(root, relative), text, "utf8");
	}
	return root;
}

afterEach(() => {
	process.chdir(originalCwd);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const QUICK = ["node", "-e", "0"];

function catalog(checks: Array<Record<string, unknown>>): string {
	return JSON.stringify({ version: 2, checks });
}

async function loadCheck(root: string, id: string) {
	const loaded = loadProjectVerifierCatalog(root);
	if (!loaded.ok || loaded.source === null) throw new Error(loaded.ok ? "no catalog" : loaded.reason);
	const check = loaded.source.checks.find((candidate) => candidate.id === id);
	if (check === undefined) throw new Error(`no check ${id}`);
	return check;
}

describe("perf-budget math", () => {
	it("passes within a budget, applies relative headroom, and fails above it", () => {
		const pass = evaluatePerfBudget(90, { budget: { wallTimeMs: 100 } });
		ok(!(pass instanceof Error));
		strictEqual(pass.passed, true);
		strictEqual(pass.budgetMs, 100);
		strictEqual(pass.ratio, 0.9);
		strictEqual(pass.source, "budget");
		const headroom = evaluatePerfBudget(110, { budget: { wallTimeMs: 100, tolerance: { relative: 0.25 } } });
		ok(!(headroom instanceof Error));
		strictEqual(headroom.passed, true);
		strictEqual(headroom.budgetMs, 125);
		const fail = evaluatePerfBudget(130, { budget: { wallTimeMs: 100, tolerance: { relative: 0.25 } } });
		ok(!(fail instanceof Error));
		strictEqual(fail.passed, false);
		match(fail.summary, /perf-budget failed: measured 130ms exceeds 125ms \(budget 100ms \+25%\), ratio 1\.04/u);
	});

	it("judges against a baseline with relative headroom and refuses without either", () => {
		const report = evaluatePerfBudget(120, { baseline: { wallTimeMs: 100 }, relative: 0.1 });
		ok(!(report instanceof Error));
		strictEqual(report.source, "baseline");
		strictEqual(report.budgetMs, 110.00000000000001);
		strictEqual(report.passed, false);
		ok(evaluatePerfBudget(10, {}) instanceof Error);
		ok(evaluatePerfBudget(Number.NaN, { budget: { wallTimeMs: 1 } }) instanceof Error);
	});

	it("renders and parses a baseline file", () => {
		const text = renderPerfBaseline({ wallTimeMs: 42.5, check: "solver", recordedAt: "2026-09-05T00:00:00.000Z" });
		deepStrictEqual(JSON.parse(text), {
			version: 1,
			check: "solver",
			wallTimeMs: 42.5,
			recordedAt: "2026-09-05T00:00:00.000Z",
		});
		deepStrictEqual(parsePerfBaseline(text, "baseline"), {
			wallTimeMs: 42.5,
			recordedAt: "2026-09-05T00:00:00.000Z",
			check: "solver",
		});
		ok(parsePerfBaseline('{"wallTimeMs": 0}', "baseline") instanceof Error);
		ok(parsePerfBaseline("nope", "baseline") instanceof Error);
	});
});

describe("perf-budget through the verify runner", () => {
	it("passes a generous budget and fails a budget the process cannot meet", async () => {
		const root = workspace({
			".clio-coder/verifiers.yaml": catalog([
				{
					id: "fast",
					description: "Quick",
					kind: "perf-budget",
					command: QUICK,
					budget: { wallTimeMs: 60_000 },
					cwd: ".",
					timeoutMs: 30_000,
					tags: [],
				},
				{
					id: "impossible",
					description: "Too tight",
					kind: "perf-budget",
					command: QUICK,
					budget: { wallTimeMs: 0.001 },
					cwd: ".",
					timeoutMs: 30_000,
					tags: [],
				},
			]),
		});
		process.chdir(root);
		const passed = await runProjectCheck(await loadCheck(root, "fast"));
		strictEqual(passed.kind, "ok", JSON.stringify(passed));
		if (passed.kind !== "ok") return;
		match(passed.output, /^perf-budget passed: measured \d+ms within 60000ms \(budget 60000ms\), ratio/u);
		const report = passed.details?.report as { kind: string; measuredMs: number; budgetMs: number; ratio: number };
		strictEqual(report.kind, "perf-budget");
		strictEqual(report.budgetMs, 60_000);
		ok(report.measuredMs > 0);
		const failed = await runProjectCheck(await loadCheck(root, "impossible"));
		strictEqual(failed.kind, "error");
		if (failed.kind !== "error") return;
		match(failed.message, /perf-budget failed: measured \d+ms exceeds 0ms \(budget 0ms\), ratio \d+/u);
	});

	it("records a baseline, then compares against it with headroom", async () => {
		const root = workspace({
			".clio-coder/verifiers.yaml": catalog([
				{
					id: "solver",
					description: "Solver time",
					kind: "perf-budget",
					command: QUICK,
					baseline: ".clio-coder/baselines/solver.json",
					tolerance: { relative: 50 },
					cwd: ".",
					timeoutMs: 30_000,
					tags: [],
				},
				{
					id: "broken",
					description: "Crashing command",
					kind: "perf-budget",
					command: ["node", "-e", "process.exit(2)"],
					baseline: ".clio-coder/baselines/broken.json",
					cwd: ".",
					timeoutMs: 30_000,
					tags: [],
				},
			]),
		});
		process.chdir(root);
		const solver = await loadCheck(root, "solver");
		const before = await runProjectCheck(solver);
		strictEqual(before.kind, "error");
		if (before.kind === "error")
			match(
				before.message,
				/baseline '\.clio-coder\/baselines\/solver\.json' does not exist; record it with `clio-coder verifiers baseline <id>`/u,
			);
		const recorded = await recordPerfBaseline(solver, { now: () => new Date("2026-09-05T00:00:00.000Z") });
		strictEqual(recorded.ok, true, JSON.stringify(recorded));
		if (!recorded.ok) return;
		strictEqual(recorded.path, ".clio-coder/baselines/solver.json");
		const written = JSON.parse(readFileSync(join(root, recorded.path), "utf8")) as Record<string, unknown>;
		strictEqual(written.check, "solver");
		strictEqual(written.wallTimeMs, recorded.wallTimeMs);
		strictEqual(written.recordedAt, "2026-09-05T00:00:00.000Z");
		const after = await runProjectCheck(solver);
		strictEqual(after.kind, "ok", JSON.stringify(after));
		if (after.kind !== "ok") return;
		const report = after.details?.report as { source: string; referenceMs: number; relative: number };
		strictEqual(report.source, "baseline");
		strictEqual(report.referenceMs, recorded.wallTimeMs);
		strictEqual(report.relative, 50);
		const broken = await recordPerfBaseline(await loadCheck(root, "broken"));
		strictEqual(broken.ok, false);
		if (!broken.ok) match(broken.message, /exited with code 2; no baseline recorded/u);
		strictEqual(existsSync(join(root, ".clio-coder/baselines/broken.json")), false);
	});
});

describe("perf-budget under host verification", () => {
	it("judges the measured duration against the sealed budget and records the report", async () => {
		const root = workspace({});
		const stateDir = join(root, "state");
		mkdirSync(stateDir, { recursive: true });
		const base = { check: "solver", argv: QUICK, cwd: root, timeoutMs: 30_000, kind: "perf-budget" as const };
		const passing = await runHostVerification({
			runId: "run-pass",
			request: { resolvedVerification: [{ ...base, perf: { budget: { wallTimeMs: 60_000 } } }] },
			workerSuccessful: true,
			stateDir,
		});
		strictEqual(passing?.status, "verified");
		strictEqual(passing?.checks[0]?.report?.kind, "perf-budget");
		const failing = await runHostVerification({
			runId: "run-fail",
			request: { resolvedVerification: [{ ...base, perf: { budget: { wallTimeMs: 0.001 } } }] },
			workerSuccessful: true,
			stateDir,
		});
		strictEqual(failing?.status, "rejected");
		strictEqual(failing?.checks[0]?.exitCode, 1);
		match(failing?.checks[0]?.outputTail ?? "", /^perf-budget failed/u);
		const baselinePath = join(root, "baseline.json");
		writeFileSync(
			baselinePath,
			renderPerfBaseline({ wallTimeMs: 1, check: "solver", recordedAt: "2026-09-05T00:00:00.000Z" }),
			"utf8",
		);
		const generous = await runHostVerification({
			runId: "run-baseline",
			request: { resolvedVerification: [{ ...base, perf: { baseline: baselinePath, tolerance: { relative: 100_000 } } }] },
			workerSuccessful: true,
			stateDir,
		});
		strictEqual(generous?.status, "verified");
		strictEqual(generous?.checks[0]?.report?.kind, "perf-budget");
	});
});
