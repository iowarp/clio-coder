import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { bashShape } from "../../src/cli/usage.js";
import { type RunEnvelope, type RunReceipt, verifyReceiptIntegrity } from "../../src/domains/dispatch/index.js";
import {
	closeServer,
	seedOpenAICompatOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";
import type { ScratchHome } from "../harness/scratch-env.js";
import { makeScratchHome, type RunResult, runCli } from "../harness/spawn.js";

// The usage report reads the local archive and is pure I/O over on-disk state,
// so it is exercised end-to-end through the built CLI in a spawned process. An
// earlier in-process draft monkey-patched process.stdout.write and fought the
// node:test spec reporter (async flushes landed in the capture buffer and ate
// the run counters); the child-process harness sidesteps that entirely.

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const isoAgo = (ms: number): string => new Date(NOW - ms).toISOString();
const RECENT = isoAgo(DAY);
const RECENT_EARLIER = isoAgo(DAY + 2 * HOUR);
const OLD = isoAgo(45 * DAY);

interface JsonRow {
	schema: string;
	kind: string;
	windowDays: number;
	[key: string]: unknown;
}

function writeFileEnsured(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function writeJson(path: string, value: unknown): void {
	writeFileEnsured(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(path: string, rows: ReadonlyArray<string>): void {
	writeFileEnsured(path, `${rows.join("\n")}\n`);
}

function seedSkill(configDir: string, name: string): void {
	writeFileEnsured(
		join(configDir, "skills", name, "SKILL.md"),
		`---\nname: ${name}\ndescription: seeded ${name} for the usage report contract test\n---\nBody\n`,
	);
}

function bashExecLine(turnId: string, timestamp: string, command: string): string {
	return JSON.stringify({
		kind: "bashExecution",
		turnId,
		parentTurnId: null,
		timestamp,
		command,
		output: "ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
	});
}

function skillActivationLine(turnId: string, timestamp: string, name: string): string {
	return JSON.stringify({
		kind: "skillActivation",
		turnId,
		parentTurnId: null,
		timestamp,
		activation: {
			name,
			filePath: `/seed/${name}/SKILL.md`,
			hash: "deadbeef",
			source: "clio",
			triggeredBy: "slash-command",
		},
	});
}

/**
 * Seed a full, well-formed archive: 3 installed skills, 3 receipts (2 in the
 * default window sharing a task prefix, 1 old), 5 sessions (4 running the same
 * non-trivial python3 shape, one of which also activates a skill, plus a
 * trivial-shape session), audit rows, an evidence index with a memorized and an
 * unmemorized failure tag, and one approved memory record naming build-failure.
 */
function seedArchive(dir: string): void {
	const state = join(dir, "state");
	const data = join(dir, "data");
	const config = join(dir, "config");

	seedSkill(config, "alpha-skill");
	seedSkill(config, "beta-skill");
	seedSkill(config, "gamma-skill");

	const READ_STATS = [{ tool: "read", count: 4, ok: 4, errors: 0, blocked: 0 }];
	writeJson(join(state, "receipts", "run-aaa.json"), {
		runId: "run-aaa",
		agentId: "scout",
		task: "investigate flaky integration test in module foo",
		startedAt: RECENT,
		endedAt: RECENT,
		sessionId: "sess-1",
		toolStats: READ_STATS,
		skillActivations: [{ name: "alpha-skill" }],
	});
	writeJson(join(state, "receipts", "run-bbb.json"), {
		runId: "run-bbb",
		agentId: "scout",
		task: "investigate flaky integration test in module foo",
		startedAt: RECENT,
		endedAt: RECENT,
		sessionId: "sess-2",
		toolStats: READ_STATS,
		skillActivations: [],
	});
	writeJson(join(state, "receipts", "run-ccc.json"), {
		runId: "run-ccc",
		agentId: "scout",
		task: "old triage run for the release cut",
		startedAt: OLD,
		endedAt: OLD,
		sessionId: "sess-old",
		toolStats: [{ tool: "read", count: 1, ok: 1, errors: 0, blocked: 0 }],
		skillActivations: [],
	});

	const PY = "python3 scripts/run.py --input=data.csv --verbose";
	const sessions = join(state, "sessions", "repohash");
	writeJsonl(join(sessions, "sess-1", "current.jsonl"), [bashExecLine("t1", RECENT, PY)]);
	writeJsonl(join(sessions, "sess-2", "current.jsonl"), [bashExecLine("t1", RECENT, PY)]);
	writeJsonl(join(sessions, "sess-3", "current.jsonl"), [bashExecLine("t1", RECENT, PY)]);
	writeJsonl(join(sessions, "sess-4", "current.jsonl"), [
		bashExecLine("t1", RECENT, PY),
		skillActivationLine("t2", RECENT, "beta-skill"),
	]);
	writeJsonl(join(sessions, "sess-5", "current.jsonl"), [bashExecLine("t1", RECENT, "ls -la")]);

	writeJsonl(join(state, "audit", "rows.jsonl"), [
		JSON.stringify({ ts: RECENT, kind: "tool_call", correlationId: "c1", decision: "allowed", tool: "read" }),
		JSON.stringify({ ts: RECENT, kind: "tool_call", correlationId: "c2", decision: "allowed", tool: "read" }),
		JSON.stringify({ ts: RECENT, kind: "tool_call", correlationId: "c3", decision: "blocked", tool: "bash" }),
	]);

	const evRow = (evidenceId: string, tags: string[], generatedAt: string): Record<string, unknown> => ({
		runId: `r-${evidenceId}`,
		evidenceId,
		tags,
		firstPassSuccess: false,
		findingCount: 1,
		generatedAt,
	});
	writeJson(join(state, "evidence-index.json"), [
		evRow("ev-test-1", ["test-failure"], RECENT_EARLIER),
		evRow("run-aaa", ["test-failure"], RECENT),
		evRow("ev-build-1", ["build-failure"], RECENT_EARLIER),
		evRow("ev-build-2", ["build-failure"], RECENT),
		evRow("ev-timeout-1", ["timeout"], RECENT),
		evRow("ev-test-old", ["test-failure"], OLD),
	]);

	writeJson(join(data, "memory", "records.json"), {
		version: 1,
		records: [
			{
				id: "mem-0123456789abcdef",
				scope: "repo",
				key: "build-failure recovery playbook",
				lesson: "When the build fails on missing generated headers, re-run codegen before make.",
				evidenceRefs: ["ev-build-1"],
				appliesWhen: ["build-failure recovery"],
				avoidWhen: [],
				confidence: 0.8,
				createdAt: RECENT,
				approved: true,
			},
		],
	});
}

function usageEnv(scratch: ScratchHome): NodeJS.ProcessEnv {
	// HOME points inside the scratch home so ~/.claude/skills and the other user
	// compat skill roots resolve to empty dirs; cwd is likewise the empty scratch
	// home so no project skills are discovered. Only the seeded config skills load.
	return { ...scratch.env, HOME: scratch.dir };
}

function runUsage(scratch: ScratchHome, args: ReadonlyArray<string>): Promise<RunResult> {
	return runCli(["usage", ...args], { env: usageEnv(scratch), cwd: scratch.dir, timeoutMs: 30_000 });
}

function parseJsonl(stdout: string): JsonRow[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as JsonRow);
}

function facts(rows: ReadonlyArray<JsonRow>, fact: string): JsonRow[] {
	return rows.filter((row) => row.kind === "fact" && row.fact === fact);
}

function opportunities(rows: ReadonlyArray<JsonRow>, kind: string): JsonRow[] {
	return rows.filter((row) => row.kind === "opportunity" && row.opportunity === kind);
}

describe("contracts/usage-report seeded archive facts", () => {
	const scratch = makeScratchHome("clio-usage-facts-");
	let rows: JsonRow[] = [];
	before(async () => {
		seedArchive(scratch.dir);
		const result = await runUsage(scratch, ["report", "--json"]);
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		strictEqual(result.stderr, "", `unexpected stderr: ${result.stderr}`);
		rows = parseJsonl(result.stdout);
	});
	after(() => scratch.cleanup());

	it("counts sessions, dispatch runs, and audited tool calls", () => {
		strictEqual(facts(rows, "sessions")[0]?.value, 5);
		strictEqual(facts(rows, "dispatch-runs")[0]?.value, 2);
		const audit = facts(rows, "audit-tool-calls")[0];
		strictEqual(audit?.value, 3);
		strictEqual(audit?.blocked, 1);
	});

	it("aggregates receipt toolStats across the in-window receipts", () => {
		const read = facts(rows, "top-tool").find((row) => row.tool === "read");
		ok(read, "expected a top-tool fact for read");
		strictEqual(read?.count, 8);
		strictEqual(read?.ok, 8);
		strictEqual(read?.errors, 0);
		strictEqual(read?.blocked, 0);
	});

	it("strips arguments to a bash shape and drops the slash-bearing script path", () => {
		const py = facts(rows, "bash-shape").find((row) => row.shape === "python3 --input --verbose");
		ok(py, "expected the python3 shape with the script path dropped");
		strictEqual(py?.count, 4);
		strictEqual(py?.sessions, 4);
		const ls = facts(rows, "bash-shape").find((row) => row.shape === "ls -la");
		strictEqual(ls?.count, 1);
	});

	it("reports skill activations from receipts and sessions and the never-activated set", () => {
		strictEqual(facts(rows, "skill-activated").find((row) => row.skill === "alpha-skill")?.activations, 1);
		strictEqual(facts(rows, "skill-activated").find((row) => row.skill === "beta-skill")?.activations, 1);
		const never = facts(rows, "skill-never-activated").map((row) => row.skill);
		ok(never.includes("gamma-skill"), "gamma-skill should never activate");
		ok(!never.includes("alpha-skill"), "alpha-skill activated, must not appear as never-activated");
		ok(!never.includes("beta-skill"), "beta-skill activated, must not appear as never-activated");
	});

	it("counts dispatch recipe use by agent id", () => {
		strictEqual(facts(rows, "recipe-used").find((row) => row.agentId === "scout")?.runs, 2);
	});

	it("histograms failure tags from the evidence index and pins the latest evidence id", () => {
		const test = facts(rows, "failure-tag").find((row) => row.tag === "test-failure");
		strictEqual(test?.count, 2);
		strictEqual(test?.latestEvidenceId, "run-aaa");
		strictEqual(facts(rows, "failure-tag").find((row) => row.tag === "build-failure")?.count, 2);
		strictEqual(facts(rows, "failure-tag").find((row) => row.tag === "timeout")?.count, 1);
	});

	it("summarizes memory approval state", () => {
		const memory = facts(rows, "memory")[0];
		strictEqual(memory?.approved, 1);
		strictEqual(memory?.pending, 0);
	});

	it("tags every emitted row with the experimental schema, window, and a known kind", () => {
		ok(rows.length > 0, "expected JSONL output");
		for (const row of rows) {
			strictEqual(row.schema, "experimental");
			strictEqual(row.windowDays, 30);
			ok(row.kind === "fact" || row.kind === "opportunity", `unexpected kind: ${row.kind}`);
		}
	});
});

describe("contracts/usage-report headless main-agent receipts", () => {
	const scratch = makeScratchHome("clio-usage-headless-");
	after(() => scratch.cleanup());

	it("counts a live headless main-agent receipt in the usage report", async () => {
		const fixed = await runCli(["doctor", "--fix"], { env: usageEnv(scratch), cwd: scratch.dir });
		strictEqual(fixed.code, 0, `stderr=${fixed.stderr}`);
		const fixture = await startOpenAICompatFixture("receipt reply");
		try {
			seedOpenAICompatOrchestrator(join(scratch.dir, "config"), fixture.url);
			const env = { ...usageEnv(scratch), CLIO_TEST_OPENAI_KEY: "sk-test" };
			const run = await runCli(["--no-context-files", "--no-skills", "run", "hello receipt"], {
				env,
				cwd: scratch.dir,
				timeoutMs: 20_000,
			});
			strictEqual(run.code, 0, `stderr=${run.stderr}`);
			strictEqual(run.stdout, "receipt reply\n");

			const receiptFiles = readdirSync(join(scratch.dir, "state", "receipts")).filter((name) => name.endsWith(".json"));
			strictEqual(receiptFiles.length, 1);
			const receipt = JSON.parse(
				readFileSync(join(scratch.dir, "state", "receipts", receiptFiles[0] ?? ""), "utf8"),
			) as Record<string, unknown>;
			strictEqual(receipt.agentId, "main-agent");
			strictEqual(receipt.targetId, "mock-chat");
			strictEqual(receipt.runtimeKind, "http");
			strictEqual(receipt.exitCode, 0);
			ok(typeof receipt.sessionId === "string" && receipt.sessionId.length > 0, "receipt records the session id");
			ok(typeof receipt.tokenCount === "number" && receipt.tokenCount > 0, "receipt records token usage");
			ok(Array.isArray(receipt.toolStats), "receipt carries toolStats");
			ok(Array.isArray(receipt.skillActivations), "receipt carries skillActivations");
			const runs = JSON.parse(readFileSync(join(scratch.dir, "state", "runs.json"), "utf8")) as RunEnvelope[];
			const envelope = runs.find((runEnvelope) => runEnvelope.id === receipt.runId);
			ok(envelope, "receipt has a matching run ledger envelope");
			const integrity = verifyReceiptIntegrity(receipt as unknown as RunReceipt, envelope);
			strictEqual(integrity.ok, true, integrity.ok ? "" : integrity.reason);

			const usage = await runUsage(scratch, ["report", "--json"]);
			strictEqual(usage.code, 0, `stderr=${usage.stderr}`);
			const rows = parseJsonl(usage.stdout);
			strictEqual(facts(rows, "dispatch-runs")[0]?.value, 1);
			strictEqual(facts(rows, "recipe-used").find((row) => row.agentId === "main-agent")?.runs, 1);
		} finally {
			await closeServer(fixture.server);
		}
	});
});

describe("contracts/usage-report opportunities", () => {
	const scratch = makeScratchHome("clio-usage-opps-");
	let rows: JsonRow[] = [];
	before(async () => {
		seedArchive(scratch.dir);
		const result = await runUsage(scratch, ["report", "--json"]);
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		rows = parseJsonl(result.stdout);
	});
	after(() => scratch.cleanup());

	it("suggests workflow-distiller for a recurring unskilled shape, excluding the skill-activating session", () => {
		const distiller = opportunities(rows, "workflow-distiller");
		strictEqual(distiller.length, 1);
		const only = distiller[0];
		ok(String(only?.suggestion).includes("python3 --input --verbose"));
		const evidence = String(only?.evidence);
		ok(evidence.startsWith("3 sessions"), `evidence: ${evidence}`);
		for (const id of ["sess-1", "sess-2", "sess-3"]) ok(evidence.includes(id), `missing ${id}`);
		ok(!evidence.includes("sess-4"), "the skill-activating session must be excluded");
	});

	it("suggests a recipe for a repeated dispatch task prefix, citing both run ids", () => {
		const recipe = opportunities(rows, "recipe");
		strictEqual(recipe.length, 1);
		ok(String(recipe[0]?.suggestion).includes("investigate flaky integration test in module foo"));
		const evidence = String(recipe[0]?.evidence);
		ok(evidence.startsWith("2 runs"), `evidence: ${evidence}`);
		ok(evidence.includes("run-aaa") && evidence.includes("run-bbb"), `evidence: ${evidence}`);
	});

	it("suggests memory only for the unmemorized failure tag", () => {
		const memory = opportunities(rows, "memory");
		strictEqual(memory.length, 1);
		const suggestion = String(memory[0]?.suggestion);
		ok(suggestion.includes("test-failure"));
		ok(suggestion.includes("clio memory propose --from-evidence run-aaa"), `suggestion: ${suggestion}`);
		ok(!suggestion.includes("build-failure"), "memorized build-failure must stay silent");
		ok(!suggestion.includes("timeout"), "single-occurrence timeout must stay silent");
	});
});

describe("contracts/usage-report window", () => {
	const scratch = makeScratchHome("clio-usage-window-");
	before(() => seedArchive(scratch.dir));
	after(() => scratch.cleanup());

	it("--days 60 picks up the old receipt and the old evidence row", async () => {
		const result = await runUsage(scratch, ["report", "--days", "60", "--json"]);
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		const rows = parseJsonl(result.stdout);
		strictEqual(rows[0]?.windowDays, 60);
		strictEqual(facts(rows, "recipe-used").find((row) => row.agentId === "scout")?.runs, 3);
		strictEqual(facts(rows, "failure-tag").find((row) => row.tag === "test-failure")?.count, 3);
	});
});

describe("contracts/usage-report diagnostics", () => {
	const scratch = makeScratchHome("clio-usage-diag-");
	before(() => {
		const state = join(scratch.dir, "state");
		writeFileEnsured(join(state, "receipts", "broken.json"), "{not valid json");
		writeJsonl(join(state, "sessions", "h", "sess-x", "current.jsonl"), [
			bashExecLine("t1", RECENT, "make build"),
			"{ broken session line",
		]);
		writeJsonl(join(state, "audit", "rows.jsonl"), [
			JSON.stringify({ ts: RECENT, kind: "tool_call", decision: "allowed" }),
			"{ broken audit row",
		]);
	});
	after(() => scratch.cleanup());

	it("counts malformed receipts, session lines, and audit rows on stderr, still exiting 0", async () => {
		const result = await runUsage(scratch, ["report"]);
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		ok(result.stderr.includes("1 malformed receipt(s) skipped"), result.stderr);
		ok(result.stderr.includes("1 malformed session line(s) skipped"), result.stderr);
		ok(result.stderr.includes("1 malformed audit row(s) skipped"), result.stderr);
	});
});

describe("contracts/usage-report edges", () => {
	const scratch = makeScratchHome("clio-usage-edge-");
	after(() => scratch.cleanup());

	it("reports a clean zero report on an empty state dir", async () => {
		const result = await runUsage(scratch, ["report"]);
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		strictEqual(result.stderr, "");
		ok(result.stdout.includes("sessions in window: 0"));
		ok(result.stdout.includes("dispatch runs (receipts) in window: 0"));
		ok(result.stdout.includes("opportunities"));
		ok(result.stdout.includes("none:"), result.stdout);
	});

	it("exits 2 on usage errors before reading any state", async () => {
		for (const args of [
			["usage"],
			["usage", "frobnicate"],
			["usage", "report", "--days", "0"],
			["usage", "report", "--days", "abc"],
			["usage", "report", "--bogus"],
			["usage", "report", "--repo"],
		]) {
			const result = await runCli(args, { env: usageEnv(scratch), cwd: scratch.dir, timeoutMs: 30_000 });
			strictEqual(result.code, 2, `expected exit 2 for: ${args.join(" ")} (stderr=${result.stderr})`);
		}
	});
});

describe("contracts/usage-report bashShape", () => {
	it("keeps the verb, subcommand, and one bare positional; strips flag values and env", () => {
		strictEqual(bashShape("git commit -m 'fix the parser'"), "git commit -m");
		strictEqual(bashShape("FOO=bar python3 script.py --input=data.csv -v"), "python3 script.py --input -v");
		strictEqual(bashShape("/usr/local/bin/cmake --build build -j8"), "cmake --build build -j8");
		strictEqual(bashShape("rm -rf /tmp/scratch-dir"), "rm -rf");
	});

	it("uses only the first pipeline segment and skips comment lines", () => {
		strictEqual(bashShape("cat foo.txt | grep bar"), "cat foo.txt");
		strictEqual(bashShape("ls -la && cd .."), "ls -la");
		strictEqual(bashShape("# only a comment"), "");
		strictEqual(bashShape("   "), "");
	});
});
