import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES } from "../../src/core/safe-exec.js";
import { runHostVerification } from "../../src/domains/dispatch/host-verification.js";
import { loadProjectVerifierCatalog } from "../../src/tools/verify/catalog.js";
import {
	capturePerfEnvironment,
	comparePerfEnvironments,
	evaluatePerfBudget,
	type PerfEnvironment,
	parsePerfBaseline,
	renderPerfBaseline,
} from "../../src/tools/verify/perf.js";
import {
	JUDGED_CHECK_MAX_OUTPUT_BYTES,
	judgePerfTexts,
	recordPerfBaseline,
	runProjectCheck,
} from "../../src/tools/verify/scripts.js";

/** A recording host that differs from every real machine on hostname and CPU, so environment drift is observable. */
const RECORDING_HOST: PerfEnvironment = {
	hostname: "recording-host.example",
	platform: "linux",
	arch: "x64",
	cpuModel: "Reference CPU 0 @ 1.00GHz",
	cpuCount: 2,
	totalMemoryBytes: 8 * 1024 ** 3,
	nodeVersion: "v22.19.0",
};

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
		// The baseline format moved to version 2 so a recording carries the host
		// it was measured on; a version 1 file still parses without one.
		const text = renderPerfBaseline({
			wallTimeMs: 42.5,
			check: "solver",
			recordedAt: "2026-09-05T00:00:00.000Z",
			environment: RECORDING_HOST,
		});
		deepStrictEqual(JSON.parse(text), {
			version: 2,
			check: "solver",
			wallTimeMs: 42.5,
			recordedAt: "2026-09-05T00:00:00.000Z",
			environment: RECORDING_HOST,
		});
		deepStrictEqual(parsePerfBaseline(text, "baseline"), {
			wallTimeMs: 42.5,
			recordedAt: "2026-09-05T00:00:00.000Z",
			check: "solver",
			environment: RECORDING_HOST,
		});
		deepStrictEqual(parsePerfBaseline('{"version":1,"wallTimeMs":42.5,"check":"solver"}', "baseline"), {
			wallTimeMs: 42.5,
			check: "solver",
		});
		deepStrictEqual(parsePerfBaseline('{"wallTimeMs":42.5}', "baseline"), { wallTimeMs: 42.5 });
		ok(parsePerfBaseline('{"wallTimeMs": 0}', "baseline") instanceof Error);
		ok(parsePerfBaseline("nope", "baseline") instanceof Error);
		const badVersion = parsePerfBaseline('{"version":3,"wallTimeMs":1}', "baseline");
		ok(badVersion instanceof Error);
		match(badVersion.message, /^baseline\.version must be one of 1, 2$/u);
		const badEnvironment = parsePerfBaseline('{"version":2,"wallTimeMs":1,"environment":{"hostname":1}}', "baseline");
		ok(badEnvironment instanceof Error);
		match(badEnvironment.message, /^baseline\.environment\.hostname must be a string$/u);
		const strayField = parsePerfBaseline(
			'{"version":2,"wallTimeMs":1,"environment":{"hostname":"h","platform":"linux","arch":"x64","cpuModel":"c","cpuCount":1,"totalMemoryBytes":1,"nodeVersion":"v22","gpu":"x"}}',
			"baseline",
		);
		ok(strayField instanceof Error);
		match(strayField.message, /^baseline\.environment has unknown field\(s\): gpu$/u);
	});

	it("reports environment drift beside a baseline verdict without changing it", () => {
		const current = capturePerfEnvironment();
		strictEqual(current.cpuCount > 0, true);
		const same = comparePerfEnvironments(current, current);
		deepStrictEqual(same.differing, []);
		const drifted = comparePerfEnvironments({ ...current, cpuModel: "other", cpuCount: current.cpuCount + 1 }, current);
		deepStrictEqual(drifted.differing, ["cpuModel", "cpuCount"]);
		const report = evaluatePerfBudget(120, {
			baseline: { wallTimeMs: 100, environment: { ...current, cpuModel: "other", cpuCount: current.cpuCount + 1 } },
			relative: 0.5,
			environment: current,
		});
		ok(!(report instanceof Error));
		strictEqual(report.passed, true);
		deepStrictEqual(report.environment?.differing, ["cpuModel", "cpuCount"]);
		match(report.summary, /^perf-budget passed: .*; environment differs: cpuModel, cpuCount$/u);
		const failing = evaluatePerfBudget(200, {
			baseline: { wallTimeMs: 100, environment: { ...current, hostname: "elsewhere" } },
			environment: current,
		});
		ok(!(failing instanceof Error));
		strictEqual(failing.passed, false, "a differing environment never flips the verdict");
		match(failing.summary, /^perf-budget failed: .*; environment differs: hostname$/u);
		const legacy = evaluatePerfBudget(50, { baseline: { wallTimeMs: 100 }, environment: current });
		ok(!(legacy instanceof Error));
		strictEqual(legacy.environment?.baseline, null);
		match(legacy.summary, /; baseline records no environment$/u);
		const budgetOnly = evaluatePerfBudget(50, { budget: { wallTimeMs: 100 }, environment: current });
		ok(!(budgetOnly instanceof Error));
		strictEqual("environment" in budgetOnly, false, "a declared budget has no recording host to compare");
	});

	it("records the baseline file's identity on a baseline judgement", () => {
		const text = renderPerfBaseline({
			wallTimeMs: 100,
			check: "solver",
			recordedAt: "2026-09-05T00:00:00.000Z",
			environment: RECORDING_HOST,
		});
		const report = judgePerfTexts(90, { baseline: "bench/solver.json", tolerance: { relative: 0.1 } }, text, "baseline", {
			environment: { ...RECORDING_HOST, hostname: "judging-host.example" },
		});
		ok(!(report instanceof Error));
		strictEqual(report.passed, true);
		deepStrictEqual(report.baseline, {
			path: "bench/solver.json",
			sha256: createHash("sha256").update(text).digest("hex"),
			bytes: Buffer.byteLength(text, "utf8"),
			recordedAt: "2026-09-05T00:00:00.000Z",
			check: "solver",
		});
		deepStrictEqual(report.environment?.differing, ["hostname"]);
		const budget = judgePerfTexts(90, { budget: { wallTimeMs: 100 } }, undefined, "baseline");
		ok(!(budget instanceof Error));
		strictEqual("baseline" in budget, false);
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
		strictEqual(written.version, 2);
		strictEqual(written.check, "solver");
		strictEqual(written.wallTimeMs, recorded.wallTimeMs);
		strictEqual(written.recordedAt, "2026-09-05T00:00:00.000Z");
		deepStrictEqual(written.environment, capturePerfEnvironment());
		const after = await runProjectCheck(solver);
		strictEqual(after.kind, "ok", JSON.stringify(after));
		if (after.kind !== "ok") return;
		const report = after.details?.report as {
			source: string;
			referenceMs: number;
			relative: number;
			environment?: { differing: string[] };
			baseline?: { path: string; sha256: string; bytes: number; check?: string };
		};
		strictEqual(report.source, "baseline");
		strictEqual(report.referenceMs, recorded.wallTimeMs);
		strictEqual(report.relative, 50);
		deepStrictEqual(report.environment?.differing, [], "the same host judges the baseline it recorded");
		strictEqual(report.baseline?.path, ".clio-coder/baselines/solver.json");
		strictEqual(report.baseline?.check, "solver");
		strictEqual(report.baseline?.bytes, Buffer.byteLength(readFileSync(join(root, recorded.path), "utf8")));
		deepStrictEqual(after.details?.judgement, {
			execution: "succeeded",
			validation: "passed",
			scientificValidity: "not established by this check",
		});
		const broken = await recordPerfBaseline(await loadCheck(root, "broken"));
		strictEqual(broken.ok, false);
		if (!broken.ok) match(broken.message, /exited with code 2; no baseline recorded/u);
		strictEqual(existsSync(join(root, ".clio-coder/baselines/broken.json")), false);
	});
});

describe("perf-budget baseline recording output ceiling", () => {
	it("records a command whose output passes the safe-exec default and refuses one past the judged ceiling", async () => {
		// The recording run and the judged run share one ceiling; a command
		// printing between the two caps records and then judges the same way.
		const between = 1 << 20;
		ok(SAFE_EXEC_DEFAULT_MAX_OUTPUT_BYTES < between && between < JUDGED_CHECK_MAX_OUTPUT_BYTES);
		const chunks = Math.ceil(JUDGED_CHECK_MAX_OUTPUT_BYTES / between) + 2;
		const root = workspace({
			".clio-coder/verifiers.yaml": catalog([
				{
					id: "chatty",
					description: "Prints a megabyte",
					kind: "perf-budget",
					command: ["node", "-e", `process.stdout.write("x".repeat(${between}))`],
					baseline: ".clio-coder/baselines/chatty.json",
					tolerance: { relative: 50 },
					cwd: ".",
					timeoutMs: 30_000,
					tags: [],
				},
				{
					id: "flood",
					description: "Prints past the ceiling",
					kind: "perf-budget",
					command: ["node", "-e", `const c="x".repeat(${between});for(let i=0;i<${chunks};i+=1)process.stdout.write(c);`],
					baseline: ".clio-coder/baselines/flood.json",
					tolerance: { relative: 50 },
					cwd: ".",
					timeoutMs: 120_000,
					tags: [],
				},
			]),
		});
		process.chdir(root);
		const chatty = await loadCheck(root, "chatty");
		const recorded = await recordPerfBaseline(chatty);
		strictEqual(recorded.ok, true, JSON.stringify(recorded));
		ok(existsSync(join(root, ".clio-coder/baselines/chatty.json")));
		const judged = await runProjectCheck(chatty);
		strictEqual(judged.kind, "ok", JSON.stringify(judged));
		const refused = await recordPerfBaseline(await loadCheck(root, "flood"));
		strictEqual(refused.ok, false);
		if (!refused.ok) {
			strictEqual(refused.message, `command output exceeded ${JUDGED_CHECK_MAX_OUTPUT_BYTES} bytes; no baseline recorded`);
		}
		strictEqual(existsSync(join(root, ".clio-coder/baselines/flood.json")), false);
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
			renderPerfBaseline({
				wallTimeMs: 1,
				check: "solver",
				recordedAt: "2026-09-05T00:00:00.000Z",
				environment: RECORDING_HOST,
			}),
			"utf8",
		);
		const generous = await runHostVerification({
			runId: "run-baseline",
			request: { resolvedVerification: [{ ...base, perf: { baseline: baselinePath, tolerance: { relative: 100_000 } } }] },
			workerSuccessful: true,
			stateDir,
		});
		strictEqual(generous?.status, "verified");
		const sealedReport = generous?.checks[0]?.report;
		ok(sealedReport?.kind === "perf-budget");
		// The recording host is fictional, so the sealed verdict names the drift
		// and still passes: the comparison is evidence, not a gate.
		ok((sealedReport.environment?.differing.length ?? 0) > 0);
		match(sealedReport.summary, /^perf-budget passed: .*; environment differs: /u);
		strictEqual(sealedReport.baseline?.path, baselinePath);
	});
});
