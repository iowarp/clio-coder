/**
 * Deterministic #351 fixture; no provider or model is called.
 * Run: node --import tsx evals/scalar-decision-machinery.ts /path/to/python
 * Requires an existing NumPy interpreter. All commits belong to owned scratch
 * repos. This checks grading/decision/commit machinery, not model compliance.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	setCommitDecisionRefsProvider,
	withManagedGitCommitAttributionEnvironment,
} from "../src/core/git-commit-attribution.js";
import { activeDecisionRefs, createDecisionBoardStore } from "../src/domains/session/decision-board.js";
import type { DecisionLedgerEntry } from "../src/domains/session/entries.js";
import { createDecideTool } from "../src/tools/decide.js";
import { isolateClioEnv } from "../tests/harness/scratch-env.js";

const python = process.argv[2];
if (!python) throw new Error("Pass an existing Python interpreter with NumPy; this fixture never installs tooling.");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/scalar-decision.json", import.meta.url), "utf8"));
const grader = fileURLToPath(new URL("./scalar-decision-grader.py", import.meta.url));
const { restore } = await isolateClioEnv();
const root = mkdtempSync(join(tmpdir(), "clio-scalar-decision-"));

function grade(source: string, value: string) {
	const policy = value === fixture.pythonPolicy ? "python-int" : value === fixture.numpyPolicy ? "numpy-integer" : null;
	ok(policy, "Only an explicitly recorded fixture policy can select the grader");
	const result = spawnSync(python as string, [grader, policy], { input: source, encoding: "utf8", timeout: 10_000 });
	if (result.error) throw result.error;
	strictEqual(result.signal, null);
	const measurements = JSON.parse(result.stdout);
	strictEqual(measurements.indexable, true);
	strictEqual(measurements.roundTrip, true);
	return { status: result.status, stderr: result.stderr, ...measurements };
}

try {
	for (const scenario of ["old-numpy", "python-int", "explicit-revision"] as const) {
		const cwd = join(root, scenario);
		mkdirSync(cwd);
		const env = {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(root, "absent-config"),
			GIT_AUTHOR_NAME: "Scalar Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Scalar Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		};
		const git = (args: string[], spawnEnv = env) =>
			execFileSync("git", args, { cwd, env: spawnEnv, encoding: "utf8", timeout: 10_000 }).trim();
		git(["init", "--quiet"]);
		const entries: DecisionLedgerEntry[] = [];
		const operations: string[] = [];
		const board = createDecisionBoardStore({
			getSessionId: () => scenario,
			readEntries: () => entries,
			getActiveLeafTurnId: () => "fixture-turn",
			appendEntry: (entry) => {
				operations.push("decision");
				entries.push({ ...entry, turnId: `entry-${entries.length}`, timestamp: new Date().toISOString() });
			},
		});
		const tool = createDecideTool({ decisionBoard: board });
		strictEqual(
			(
				await tool.run({
					key: fixture.key,
					value: fixture.pythonPolicy,
					alternatives: [fixture.numpyPolicy],
					rationale: "Pinned council selected ordinary Python ints.",
				})
			).kind,
			"ok",
		);
		const initialRefs = activeDecisionRefs(board.snapshot());
		if (scenario === "explicit-revision") {
			const revision = await tool.run({
				key: fixture.key,
				value: fixture.numpyPolicy,
				alternatives: [fixture.pythonPolicy],
				rationale: "Scripted alternative task explicitly chooses NumPy scalar preservation before commit.",
			});
			strictEqual(revision.kind, "ok");
			if (revision.kind !== "ok") throw new Error("revision failed");
			strictEqual((revision.details?.decision as { superseded: string }).superseded, initialRefs[0]);
			const superseded = board
				.snapshot()
				.flatMap((entry) => entry.decisions)
				.find((decision) => decision.status === "superseded");
			strictEqual(superseded?.revisionSource, "agent");
			ok(superseded?.correction);
			strictEqual(entries.length, 3);
		}
		const active = board
			.snapshot()
			.flatMap((entry) => entry.decisions)
			.filter((decision) => decision.status === "active");
		strictEqual(active.length, 1);
		const policy = active[0]?.value;
		ok(policy);
		const source =
			scenario === "python-int"
				? fixture.source.replace("return tuple(idx)", "return tuple(int(value) for value in idx)")
				: fixture.source;
		writeFileSync(join(cwd, "index-policy.py"), source);
		const before = grade(source, policy);
		// The negative control deliberately commits the old failure to prove
		// that valid attribution cannot make its implementation grade pass.
		strictEqual(before.status, scenario === "old-numpy" ? 1 : 0, before.stderr);
		if (scenario === "old-numpy") match(before.stderr, /active Python-int policy requires type\(value\) is int/u);
		git(["add", "index-policy.py"]);
		setCommitDecisionRefsProvider(() => activeDecisionRefs(board.snapshot()));
		const managed = withManagedGitCommitAttributionEnvironment(env, { cwd, enabled: true });
		strictEqual(managed.diagnostic, null);
		operations.push("commit");
		git(["-c", "commit.gpgSign=false", "commit", "--quiet", "-m", `fixture: ${scenario}`], managed.env as typeof env);
		deepStrictEqual(
			operations,
			scenario === "explicit-revision" ? ["decision", "decision", "decision", "commit"] : ["decision", "commit"],
		);
		const commit = git(["rev-parse", "HEAD"]);
		const message = git(["show", "-s", "--format=%B", commit]);
		const trailers = message
			.split("\n")
			.filter((line) => line.startsWith("Clio-Decision: "))
			.map((line) => line.slice("Clio-Decision: ".length));
		deepStrictEqual(trailers, activeDecisionRefs(board.snapshot()));
		if (scenario === "explicit-revision") ok(!trailers.includes(initialRefs[0] as string));
		const after = grade(git(["show", `${commit}:index-policy.py`]), policy);
		strictEqual(after.status, before.status);
		strictEqual(after.pythonInts, scenario === "python-int");
		process.stdout.write(
			`${JSON.stringify({ evidence: "scripted-machinery", scenario, commit, policy, trailerValid: true, adherence: after.status === 0, ...after })}\n`,
		);
	}
} finally {
	setCommitDecisionRefsProvider(null);
	rmSync(root, { recursive: true, force: true });
	restore();
}
