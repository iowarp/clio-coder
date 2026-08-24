import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import { parseFleetCommands, parseFleetContract, renderFleetPrompt } from "../../src/domains/agents/index.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { ExecutionStepResult } from "../../src/domains/dispatch/execution-scheduler.js";
import {
	compileFleetExecutionPlan,
	executeFleetRun,
	type FleetRunRecord,
	planFleetResume,
} from "../../src/domains/dispatch/index.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

function contract(name: string, steps: string, body = "Run the declared workflow."): string {
	return [
		"---",
		"version: 3",
		`name: ${name}`,
		"steps:",
		steps,
		"maxWorkers: 1",
		"onFailure: stop",
		"---",
		body,
		"",
	].join("\n");
}

describe("contracts/cli-fleet-authoring", () => {
	const scratch = makeScratchHome("clio-fleet-authoring-");
	let repo = "";

	before(() => {
		repo = mkdtempSync(join(tmpdir(), "clio-fleet-authoring-repo-"));
	});
	after(() => {
		rmSync(repo, { recursive: true, force: true });
		scratch.cleanup();
	});

	it("copies a builtin and refuses replacement, unsafe names, and unknown builtins", async () => {
		const created = await runCli(["fleet", "new", "my-review", "--from", "build-review"], {
			cwd: repo,
			env: scratch.env,
		});
		strictEqual(created.code, 0, created.stderr);
		strictEqual(created.stdout.trim(), join(repo, ".clio-coder", "fleets", "my-review.md"));
		match(readFileSync(created.stdout.trim(), "utf8"), /name: my-review/);
		const existing = await runCli(["fleet", "new", "my-review", "--from", "build-review"], {
			cwd: repo,
			env: scratch.env,
		});
		strictEqual(existing.code, 2);
		match(existing.stderr, /already exists/);
		const unknown = await runCli(["fleet", "new", "other", "--from", "missing"], { cwd: repo, env: scratch.env });
		strictEqual(unknown.code, 2);
		match(unknown.stderr, /Known builtins: build-review, build-test, sdlc/);
		const unsafe = await runCli(["fleet", "new", "..", "--from", "sdlc"], { cwd: repo, env: scratch.env });
		strictEqual(unsafe.code, 2);
	});

	it("validates a good contract, reports an invalid contract, and leaves the state directory absent", async () => {
		const fleetDir = join(repo, ".clio-coder", "fleets");
		mkdirSync(fleetDir, { recursive: true });
		writeFileSync(
			join(fleetDir, "valid.md"),
			contract("valid", "  - id: inspect\n    agent: scout\n    scope: readonly\n    dependencies: []"),
		);
		writeFileSync(
			join(fleetDir, "invalid.md"),
			contract("invalid", "  - id: inspect\n    agent: no-such-agent\n    scope: readonly\n    dependencies: []"),
		);
		const stateDir = String(scratch.env.CLIO_CODER_STATE_DIR);
		rmSync(stateDir, { recursive: true, force: true });
		const valid = await runCli(["fleet", "validate", "valid"], { cwd: repo, env: scratch.env });
		strictEqual(valid.code, 0, valid.stderr);
		match(valid.stdout, /^parse: parsed contract version 3/m);
		match(valid.stdout, /^plan: compiled 1 plan steps/m);
		strictEqual(existsSync(stateDir), false);
		const invalid = await runCli(["fleet", "validate", "invalid", "--json"], { cwd: repo, env: scratch.env });
		strictEqual(invalid.code, 1, invalid.stderr);
		strictEqual(JSON.parse(invalid.stdout).valid, false);
		match(invalid.stdout, /unknown agent/);
		strictEqual(existsSync(stateDir), false);
	});

	it("renders expanded loop members and each compiled write boundary", async () => {
		const text = [
			"---",
			"version: 4",
			"name: loop-graph",
			"steps:",
			"  - id: repair-cycle",
			"    kind: loop",
			"    maxAttempts: 2",
			"    dependencies: []",
			"    check:",
			"      kind: code",
			"      command: test",
			"      scope: readonly",
			"    repair:",
			"      kind: agent",
			"      agent: coder",
			"      scope: workspace",
			"      writes: [src/]",
			"maxWorkers: 1",
			"onFailure: stop",
			"---",
			"Repair the project.",
			"",
		].join("\n");
		writeFileSync(join(repo, ".clio-coder", "fleets", "loop-graph.md"), text);
		writeFileSync(
			join(repo, ".clio-coder", "fleets", "commands.yaml"),
			'version: 1\ncommands:\n  test:\n    argv: ["true"]\n',
		);
		const graph = await runCli(["fleet", "graph", "loop-graph", "--json"], { cwd: repo, env: scratch.env });
		strictEqual(graph.code, 0, graph.stderr);
		const parsed = JSON.parse(graph.stdout) as {
			loops: Array<{ check: unknown[]; repair: Array<{ writes: string[] }> }>;
		};
		strictEqual(parsed.loops[0]?.check.length, 2);
		strictEqual(parsed.loops[0]?.repair.length, 1);
		strictEqual(parsed.loops[0]?.repair[0]?.writes[0], "src/");
	});

	it("writes a fully commented command draft from package scripts and Makefile targets and refuses overwrite", async () => {
		rmSync(join(repo, ".clio-coder", "fleets", "commands.yaml"), { force: true });
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ scripts: { test: "node test.js", build: "node build.js" } }),
		);
		writeFileSync(join(repo, "Makefile"), "check:\n\t@true\nrelease: check\n\t@true\n");
		const initialized = await runCli(["fleet", "commands", "init"], { cwd: repo, env: scratch.env });
		strictEqual(initialized.code, 0, initialized.stderr);
		const draft = readFileSync(initialized.stdout.trim(), "utf8");
		strictEqual(
			draft
				.split("\n")
				.filter(Boolean)
				.every((line) => line.startsWith("#")),
			true,
			draft,
		);
		match(draft, /argv: \["npm", "run", "test"\]/);
		match(draft, /argv: \["make", "check"\]/);
		const overwrite = await runCli(["fleet", "commands", "init"], { cwd: repo, env: scratch.env });
		strictEqual(overwrite.code, 2);
		match(overwrite.stderr, /already exists/);
	});

	it("replays a successful prefix, runs the unfinished step, and refuses changed plans and variables", async () => {
		const fleetDir = join(repo, ".clio-coder", "fleets");
		const steps = [
			"  - id: first",
			"    kind: code",
			"    command: first",
			"    scope: readonly",
			"    dependencies: []",
			"  - id: second",
			"    kind: code",
			"    command: second",
			"    scope: readonly",
			"    dependencies: [first]",
		].join("\n");
		writeFileSync(join(fleetDir, "replay.md"), contract("replay", steps, "Run in {{mode}} mode."));
		writeFileSync(
			join(fleetDir, "commands.yaml"),
			'version: 1\ncommands:\n  first:\n    argv: ["true"]\n  second:\n    argv: ["false"]\n',
		);
		const first = await runCli(["fleet", "run", "replay", "--var", "mode=one"], { cwd: repo, env: scratch.env });
		strictEqual(first.code, 1, `stdout=${first.stdout}\nstderr=${first.stderr}`);
		const rootId = /root=(fleet-[a-f0-9]+)/u.exec(first.stderr)?.[1];
		strictEqual(typeof rootId, "string", first.stderr);
		writeFileSync(
			join(fleetDir, "commands.yaml"),
			'version: 1\ncommands:\n  first:\n    argv: ["true"]\n  second:\n    argv: ["true"]\n',
		);
		const resumed = await runCli(["fleet", "run", "replay", "--var", "mode=one", "--resume", rootId as string], {
			cwd: repo,
			env: scratch.env,
		});
		strictEqual(resumed.code, 0, `stdout=${resumed.stdout}\nstderr=${resumed.stderr}`);
		match(resumed.stdout, /step first: replayed terminal-run=/);
		match(resumed.stdout, /step second code:second: passed/);
		const differentVars = await runCli(["fleet", "run", "replay", "--var", "mode=two", "--resume", rootId as string], {
			cwd: repo,
			env: scratch.env,
		});
		strictEqual(differentVars.code, 1);
		match(differentVars.stderr, /different --var values/);
		writeFileSync(
			join(fleetDir, "replay.md"),
			contract("replay", steps.replace("id: second", "id: changed"), "Run in {{mode}} mode."),
		);
		const changed = await runCli(["fleet", "run", "replay", "--var", "mode=one", "--resume", rootId as string], {
			cwd: repo,
			env: scratch.env,
		});
		strictEqual(changed.code, 1);
		match(changed.stderr, /resume plan hash differs/);
		match(changed.stderr, /step 2: second -> changed/);
	});

	it("plans only an integrity-valid prefix and returns typed resume refusals", () => {
		const parsed = parseFleetContract(
			contract(
				"planner",
				[
					"  - id: first",
					"    kind: code",
					"    command: first",
					"    scope: readonly",
					"    dependencies: []",
					"  - id: second",
					"    kind: code",
					"    command: second",
					"    scope: readonly",
					"    dependencies: [first]",
				].join("\n"),
			),
			"planner.md",
		);
		const plan = compileFleetExecutionPlan({
			contract: parsed,
			task: "plan",
			resolveAgent: () => {
				throw new Error("the planner fixture has no agent steps");
			},
		});
		const result = (stepId: string, succeeded = true, integrityValid = true): ExecutionStepResult => ({
			stepId,
			assignmentId: `assignment-${stepId}`,
			terminalRunId: `run-${stepId}`,
			receiptDigest: `digest-${stepId}`,
			output: stepId,
			succeeded,
			integrityValid,
		});
		const record: FleetRunRecord = {
			version: 1,
			id: "fleet-prior",
			fleet: parsed.name,
			planHash: plan.hash,
			stepIds: plan.steps.map((step) => step.id),
			planSteps: plan.steps.map((step) => structuredClone(step)),
			vars: { mode: "one" },
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:00:01.000Z",
			resumedFrom: null,
			steps: [
				{ stepId: "first", result: result("first") },
				{ stepId: "second", result: result("second", true, false) },
			],
		};
		const prefix = planFleetResume(record, plan, parsed, { mode: "one" });
		strictEqual(prefix.ok, true);
		if (prefix.ok) deepStrictEqual([...prefix.replayed.keys()], ["first"]);
		deepStrictEqual(planFleetResume({ ...record, fleet: "another" }, plan, parsed, { mode: "one" }), {
			ok: false,
			reason: "fleet-name",
			priorFleet: "another",
			currentFleet: "planner",
		});
		deepStrictEqual(planFleetResume(record, plan, parsed, { mode: "two" }), { ok: false, reason: "vars" });
		const changed = {
			...plan,
			hash: "changed",
			steps: [{ ...plan.steps[0], id: "renamed" }, plan.steps[1]],
		} as typeof plan;
		const refusal = planFleetResume(record, changed, parsed, { mode: "one" });
		strictEqual(refusal.ok, false);
		if (!refusal.ok && refusal.reason === "plan-hash") {
			strictEqual(refusal.priorHash, plan.hash);
			strictEqual(refusal.currentHash, "changed");
			deepStrictEqual(
				refusal.diff.map((entry) => [entry.index, entry.priorId, entry.currentId]),
				[[0, "first", "renamed"]],
			);
		}
	});

	it("resumes a domain-started run and records its lineage through the shared executor", async () => {
		const fleetDir = join(repo, ".clio-coder", "fleets");
		const steps = [
			"  - id: first",
			"    kind: code",
			"    command: first",
			"    scope: readonly",
			"    dependencies: []",
			"  - id: second",
			"    kind: code",
			"    command: second",
			"    scope: readonly",
			"    dependencies: [first]",
		].join("\n");
		const contractText = contract("domain-replay", steps);
		const failingCommands = 'version: 1\ncommands:\n  first:\n    argv: ["true"]\n  second:\n    argv: ["false"]\n';
		writeFileSync(join(fleetDir, "domain-replay.md"), contractText);
		writeFileSync(join(fleetDir, "commands.yaml"), failingCommands);
		const parsed = parseFleetContract(contractText, join(fleetDir, "domain-replay.md"));
		const commands = parseFleetCommands(failingCommands, join(fleetDir, "commands.yaml"));
		const plan = compileFleetExecutionPlan({
			contract: parsed,
			task: renderFleetPrompt(parsed.body, {}),
			resolveAgent: () => {
				throw new Error("the domain resume fixture has no agent steps");
			},
		});
		const stateDir = String(scratch.env.CLIO_CODER_STATE_DIR);
		mkdirSync(join(stateDir, "fleet-runs"), { recursive: true });
		const previousState = process.env.CLIO_CODER_STATE_DIR;
		process.env.CLIO_CODER_STATE_DIR = stateDir;
		// The state dir is cached on first resolution, so an earlier file in the
		// same lane would otherwise pin this in-process run to its own scratch.
		resetXdgCache();
		try {
			const first = await executeFleetRun({
				plan,
				contractName: parsed.name,
				commands,
				workspaceRoot: repo,
				fleetRootId: "fleet-domain-start",
				dispatch: { abort() {} } as unknown as DispatchContract,
				agents: { getSpec: () => null },
				attributionEnabled: false,
				vars: {},
			});
			strictEqual(first.cleanRun, false);
		} finally {
			if (previousState === undefined) delete process.env.CLIO_CODER_STATE_DIR;
			else process.env.CLIO_CODER_STATE_DIR = previousState;
			resetXdgCache();
		}
		const initialRecord = JSON.parse(
			readFileSync(join(stateDir, "fleet-runs", "fleet-domain-start.json"), "utf8"),
		) as FleetRunRecord;
		strictEqual(initialRecord.resumedFrom, null);
		strictEqual(typeof initialRecord.endedAt, "string");
		writeFileSync(
			join(fleetDir, "commands.yaml"),
			'version: 1\ncommands:\n  first:\n    argv: ["true"]\n  second:\n    argv: ["true"]\n',
		);
		const resumed = await runCli(["fleet", "run", "domain-replay", "--resume", "fleet-domain-start"], {
			cwd: repo,
			env: scratch.env,
		});
		strictEqual(resumed.code, 0, `stdout=${resumed.stdout}\nstderr=${resumed.stderr}`);
		match(resumed.stdout, /step first: replayed terminal-run=/);
		const resumedId = /root=(fleet-[a-f0-9]+)/u.exec(resumed.stderr)?.[1];
		strictEqual(typeof resumedId, "string", resumed.stderr);
		const resumedRecord = JSON.parse(
			readFileSync(join(stateDir, "fleet-runs", `${String(resumedId)}.json`), "utf8"),
		) as FleetRunRecord;
		strictEqual(resumedRecord.resumedFrom, "fleet-domain-start");
	});
});
