import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { attributeCommitMessage } from "../../src/core/commit-attribution.js";
import { parseFleetCommands } from "../../src/domains/agents/fleet-commands.js";
import {
	FleetCommandRegistryMissingError,
	type FleetContract,
	listFleetContracts,
	parseFleetContract,
	validateFleetCommands,
} from "../../src/domains/agents/index.js";
import { resultContractAuthorship } from "../../src/domains/agents/result-contract.js";
import { runCodeStep } from "../../src/domains/dispatch/code-step.js";
import type { ExecutionPlan } from "../../src/domains/dispatch/execution-plan.js";
import {
	type ExecutionSchedulerAdapter,
	type ExecutionStepResult,
	executePlan,
} from "../../src/domains/dispatch/execution-scheduler.js";
import { deriveFleetCommitAttribution } from "../../src/domains/dispatch/fleet-commit-attribution.js";
import { compileFleetExecutionPlan } from "../../src/domains/dispatch/fleet-plan.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function contract(steps: string[], onFailure = "stop"): FleetContract {
	return parseFleetContract(
		[
			"---",
			"version: 3",
			"name: chain",
			"steps:",
			...steps,
			"maxWorkers: 2",
			`onFailure: ${onFailure}`,
			"---",
			"Do {{task}}.",
		].join("\n"),
		"fleet.md",
	);
}

const BUILD = ["  - kind: agent", "    id: build", "    agent: coder", "    scope: workspace", "    dependencies: []"];

function loop(
	id: string,
	maxAttempts: number,
	dependencies: string,
	check = "{kind: code, command: test, scope: workspace}",
) {
	return [
		"  - kind: loop",
		`    id: ${id}`,
		`    maxAttempts: ${maxAttempts}`,
		`    dependencies: ${dependencies}`,
		`    check: ${check}`,
		"    repair: {kind: agent, agent: coder, scope: workspace}",
	];
}

function plan(source: FleetContract): ExecutionPlan {
	return compileFleetExecutionPlan({
		contract: source,
		task: "task",
		resolveAgent: (context) => ({
			requestedAuthority: "workspace-edit",
			approvedAuthority: "workspace-edit",
			expectedResultContract: context.gateRole === "reviewer" ? "verifier-report" : "mutation-report",
			executionRole: context.attempt > 0 ? "recovery" : context.gateRole === "reviewer" ? "reviewer" : "builder",
		}),
	});
}

interface StubOptions {
	/** Per step id: whether the run succeeded. Missing means success. */
	outcomes?: Record<string, boolean>;
	/** Loop verdicts for agent-checked loops, by check step id. */
	verdicts?: Record<string, boolean>;
	/** Step ids whose result should be integrity-invalid. */
	broken?: ReadonlyArray<string>;
	/** Later results for a code step re-run, in order, by step id. */
	rerun?: Record<string, boolean[]>;
}

function stub(options: StubOptions = {}): ExecutionSchedulerAdapter & {
	launched: string[];
	code: string[];
	handoffs: Map<string, ReadonlyArray<{ stepId: string; output: string }>>;
	messages: Map<string, ReadonlyArray<string>>;
} {
	const launched: string[] = [];
	const code: string[] = [];
	const handoffs = new Map<string, ReadonlyArray<{ stepId: string; output: string }>>();
	const messages = new Map<string, ReadonlyArray<string>>();
	const runs = new Map<string, number>();
	const outcomeOf = (id: string): boolean => {
		const attempt = runs.get(id) ?? 0;
		runs.set(id, attempt + 1);
		const later = options.rerun?.[id];
		if (attempt > 0 && later !== undefined) return later[attempt - 1] ?? false;
		return options.outcomes?.[id] ?? true;
	};
	const result = (id: string, succeeded: boolean): ExecutionStepResult => ({
		stepId: id,
		assignmentId: `assignment-${id}`,
		terminalRunId: `run-${id}`,
		receiptDigest: "a".repeat(64),
		output: `${id}-output`,
		succeeded,
		integrityValid: !(options.broken ?? []).includes(id),
	});
	return {
		launched,
		code,
		handoffs,
		messages,
		preflight: (step) => ({ step, costUpperBoundUsd: 1, nodeId: "local" }),
		reserve: () => ({ ownerId: "reservation" }),
		async run(step, given) {
			launched.push(step.id);
			handoffs.set(
				step.id,
				given.map((handoff) => ({ stepId: handoff.stepId, output: handoff.output })),
			);
			return { assignmentId: `assignment-${step.id}`, result: Promise.resolve(result(step.id, outcomeOf(step.id))) };
		},
		async runCode(step, given, _signal, priorResults) {
			code.push(step.id);
			handoffs.set(
				step.id,
				given.map((handoff) => ({ stepId: handoff.stepId, output: handoff.output })),
			);
			if (step.commitFrom !== undefined) {
				messages.set(
					step.id,
					step.commitFrom.filter((candidate) => priorResults.has(candidate)),
				);
			}
			return result(step.id, outcomeOf(step.id));
		},
		async decideLoop({ step, result: settled }) {
			const resolved = options.verdicts?.[step.id] ?? true;
			return { resolved, findings: resolved ? null : `findings-for-${settled.stepId}` };
		},
		cancel: () => {},
		release: () => {},
		releaseUnconsumed: () => {},
	};
}

// ---------------------------------------------------------------------------

describe("bounded loop contracts", () => {
	it("a loop declares a finite bound and compiles to unrolled attempts", () => {
		const source = contract([...BUILD, ...loop("suite", 3, "[build]")]);
		const compiled = plan(source);
		deepStrictEqual(
			compiled.steps.map((step) => step.id),
			["build", "suite.check.1", "suite.repair.1", "suite.check.2", "suite.repair.2", "suite.check.3"],
		);
		deepStrictEqual(compiled.loops, [
			{
				id: "suite",
				checkKind: "code",
				maxAttempts: 3,
				checkStepIds: ["suite.check.1", "suite.check.2", "suite.check.3"],
				repairStepIds: ["suite.repair.1", "suite.repair.2"],
			},
		]);
		// One verification per attempt, one fewer repair, chained so attempt n+1
		// only exists behind repair n.
		deepStrictEqual(compiled.steps.find((step) => step.id === "suite.check.2")?.dependencies, ["suite.repair.1"]);
		strictEqual(compiled.version, 4);
	});

	it("a repair attempt is recovery work and a code check is a verification", () => {
		const compiled = plan(contract([...BUILD, ...loop("suite", 2, "[build]")]));
		const repair = compiled.steps.find((step) => step.id === "suite.repair.1");
		strictEqual(repair?.kind === "agent" ? repair.executionRole : null, "recovery");
		const check = compiled.steps.find((step) => step.id === "suite.check.1");
		strictEqual(check?.kind === "code" ? check.verification : null, true);
	});

	it("an unbounded or over-bounded loop is refused by contract validation", () => {
		throws(
			() =>
				contract([
					...BUILD,
					"  - kind: loop",
					"    id: suite",
					"    dependencies: [build]",
					"    check: {kind: code, command: test, scope: workspace}",
					"    repair: {kind: agent, agent: coder, scope: workspace}",
				]),
			/steps/,
		);
		throws(() => contract([...BUILD, ...loop("suite", 6, "[build]")]), /steps/);
	});

	it("a mutually looping declaration is refused before anything runs", () => {
		throws(
			() =>
				contract([
					"  - kind: agent",
					"    id: a",
					"    agent: coder",
					"    scope: workspace",
					"    dependencies: [b]",
					"  - kind: agent",
					"    id: b",
					"    agent: coder",
					"    scope: workspace",
					"    dependencies: [a]",
				]),
			/dependency cycle/,
		);
		throws(() => contract([...BUILD, ...loop("suite", 2, "[suite]")]), /depends on itself/);
	});

	it("a declared id may not collide with one a loop generates", () => {
		throws(
			() =>
				contract([
					...BUILD,
					...loop("suite", 2, "[build]"),
					"  - kind: agent",
					"    id: suite.check.1",
					"    agent: coder",
					"    scope: workspace",
					"    dependencies: []",
				]),
			/collides with an id loop 'suite' generates/,
		);
	});

	it("a commit must depend on the step whose words it uses", () => {
		throws(
			() =>
				contract([
					...BUILD,
					"  - kind: agent",
					"    id: other",
					"    agent: coder",
					"    scope: workspace",
					"    dependencies: []",
					"  - kind: code",
					"    id: commit",
					"    command: commit",
					"    scope: workspace",
					"    dependencies: [build]",
					"    commitFrom: [other]",
				]),
			/must depend on its message source 'other'/,
		);
	});

	it("a loop's deterministic check is bound to a registered command", () => {
		const source = contract([...BUILD, ...loop("suite", 2, "[build]")]);
		const registry = parseFleetCommands('version: 1\ncommands:\n  test:\n    argv: ["true"]', "commands.yaml");
		validateFleetCommands(source, registry);
		throws(() => validateFleetCommands(source, null), /require a command registry/);
		const unknown = contract([...BUILD, ...loop("suite", 2, "[build]", "{kind: code, command: nope, scope: workspace}")]);
		throws(() => validateFleetCommands(unknown, registry), /unknown command 'nope'/);
	});
});

describe("bounded loop execution", () => {
	it("a red verification repairs once and a green one leaves the rest unrun", async () => {
		const compiled = plan(contract([...BUILD, ...loop("suite", 3, "[build]")]));
		const adapter = stub({ outcomes: { "suite.check.1": false } });
		const outcome = await executePlan(compiled, adapter);
		deepStrictEqual(adapter.code, ["suite.check.1", "suite.check.2"]);
		deepStrictEqual(adapter.launched, ["build", "suite.repair.1"]);
		deepStrictEqual(outcome.unneeded, ["suite.repair.2", "suite.check.3"]);
		deepStrictEqual(outcome.loops, [{ loopId: "suite", resolved: true, attempts: 2, repairs: 1, reason: "resolved" }]);
		// The repair reads the failing command's own output, not a summary.
		deepStrictEqual(adapter.handoffs.get("suite.repair.1"), [
			{ stepId: "suite.check.1", output: "suite.check.1-output" },
		]);
	});

	it("spending the bound without a pass fails the run with a typed reason", async () => {
		const compiled = plan(
			contract([
				...BUILD,
				...loop("suite", 2, "[build]"),
				"  - kind: agent",
				"    id: after",
				"    agent: coder",
				"    scope: workspace",
				"    dependencies: [suite]",
			]),
		);
		const adapter = stub({ outcomes: { "suite.check.1": false, "suite.check.2": false } });
		const outcome = await executePlan(compiled, adapter);
		deepStrictEqual(outcome.loops, [
			{ loopId: "suite", resolved: false, attempts: 2, repairs: 1, reason: "loop_bound_exhausted" },
		]);
		// Nothing downstream of an unconverged loop runs.
		strictEqual(adapter.launched.includes("after"), false);
	});

	it("an agent-checked loop reuses the coordinator's review continuation policy", async () => {
		const compiled = plan(
			contract([...BUILD, ...loop("review", 2, "[build]", "{kind: agent, agent: verifier, scope: readonly}")]),
		);
		const adapter = stub({ verdicts: { "review.check.1": false } });
		const outcome = await executePlan(compiled, adapter);
		deepStrictEqual(adapter.launched, ["build", "review.check.1", "review.repair.1", "review.check.2"]);
		strictEqual(outcome.loops[0]?.resolved, true);
		// The repair answers the gate's findings, never its raw transcript.
		deepStrictEqual(adapter.handoffs.get("review.repair.1"), [
			{ stepId: "review.check.1", output: "findings-for-review.check.1" },
		]);
	});

	it("a rejected review blocks the commit even though the reviewer ran fine", async () => {
		const compiled = plan(
			contract([
				...BUILD,
				...loop("review", 2, "[build]", "{kind: agent, agent: verifier, scope: readonly}"),
				"  - kind: code",
				"    id: commit",
				"    command: commit",
				"    scope: workspace",
				"    dependencies: [review]",
				"    commitFrom: [build]",
			]),
		);
		// Both gate runs succeed as runs and both answer "no". A verification's
		// exit status is not its verdict, so nothing downstream may treat the
		// completed reviewer as approval.
		const adapter = stub({ verdicts: { "review.check.1": false, "review.check.2": false } });
		const outcome = await executePlan(compiled, adapter);
		strictEqual(adapter.code.includes("commit"), false);
		deepStrictEqual(outcome.loops, [
			{ loopId: "review", resolved: false, attempts: 2, repairs: 1, reason: "loop_bound_exhausted" },
		]);
	});

	it("an agent-checked loop refuses to run without a decider", async () => {
		const compiled = plan(
			contract([...BUILD, ...loop("review", 2, "[build]", "{kind: agent, agent: verifier, scope: readonly}")]),
		);
		const { decideLoop: _decider, ...withoutDecider } = stub();
		await rejects(() => executePlan(compiled, withoutDecider), /cannot decide one/);
	});
});

describe("verification staleness", () => {
	const staleContract = () =>
		contract([
			...BUILD,
			...loop("suite", 2, "[build]"),
			...loop("review", 2, "[suite]", "{kind: agent, agent: verifier, scope: readonly}"),
			"  - kind: code",
			"    id: commit",
			"    command: commit",
			"    scope: workspace",
			"    dependencies: [suite, review]",
			"    commitFrom: [review, build]",
		]);

	it("a revision after the last green re-runs the suite before anything commits", async () => {
		const compiled = plan(staleContract());
		const adapter = stub({ verdicts: { "review.check.1": false } });
		const outcome = await executePlan(compiled, adapter);
		// The revise attempt is a workspace step that landed after the green
		// suite, so the suite ran again before the commit was admitted.
		deepStrictEqual(outcome.revalidated, ["suite.check.1"]);
		deepStrictEqual(adapter.code, ["suite.check.1", "suite.check.1", "commit"]);
		strictEqual(outcome.results.get("commit")?.succeeded, true);
	});

	it("a stale re-run that comes back red stops the run before the commit", async () => {
		const compiled = plan(staleContract());
		const adapter = stub({ verdicts: { "review.check.1": false }, rerun: { "suite.check.1": [false] } });
		const outcome = await executePlan(compiled, adapter);
		deepStrictEqual(outcome.revalidated, ["suite.check.1"]);
		strictEqual(adapter.code.includes("commit"), false);
		strictEqual(outcome.loops.find((entry) => entry.loopId === "suite")?.resolved, false);
	});

	it("an untouched green is not re-run", async () => {
		const compiled = plan(staleContract());
		const adapter = stub();
		const outcome = await executePlan(compiled, adapter);
		deepStrictEqual(outcome.revalidated, []);
		deepStrictEqual(adapter.code, ["suite.check.1", "commit"]);
	});
});

describe("commit steps", () => {
	it("a commit takes the newest available author's message and falls back deterministically", () => {
		strictEqual(
			resultContractAuthorship(
				{ kind: "mutation-report" },
				'{"mutatedPaths":[],"validations":[],"commitMessage":"Add a bounded loop"}',
			).commitMessage,
			"Add a bounded loop",
		);
		// A result with no authored message yields none, which is what makes the
		// caller's deterministic fallback the only other possibility.
		strictEqual(
			resultContractAuthorship({ kind: "mutation-report" }, '{"mutatedPaths":[],"validations":[]}').commitMessage,
			null,
		);
		strictEqual(resultContractAuthorship({ kind: "mutation-report" }, "not json").commitMessage, null);
		// A contract that produces no work product never authors a commit.
		strictEqual(resultContractAuthorship({ kind: "verifier-report" }, '{"commitMessage":"nope"}').commitMessage, null);
	});

	it("commit candidates are offered newest first, loops standing for their repairs", async () => {
		const compiled = plan(
			contract([
				...BUILD,
				...loop("suite", 3, "[build]"),
				"  - kind: code",
				"    id: commit",
				"    command: commit",
				"    scope: workspace",
				"    dependencies: [suite]",
				"    commitFrom: [suite, build]",
			]),
		);
		const commit = compiled.steps.find((step) => step.id === "commit");
		deepStrictEqual(commit?.kind === "code" ? commit.commitFrom : null, ["suite.repair.2", "suite.repair.1", "build"]);
		const adapter = stub({ outcomes: { "suite.check.1": false } });
		await executePlan(compiled, adapter);
		// Only attempts that actually ran are candidates.
		deepStrictEqual(adapter.messages.get("commit"), ["suite.repair.1", "build"]);
	});

	it("an empty diff fails the commit instead of recording nothing", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-commit-"));
		try {
			execFileSync("git", ["-C", root, "init", "-q"]);
			execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
			execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
			writeFileSync(join(root, "seed.txt"), "seed\n");
			execFileSync("git", ["-C", root, "add", "-A"]);
			execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
			const registry = parseFleetCommands(
				["version: 1", "commands:", "  commit:", '    argv: [git, commit, --all, --message, "{{commitMessage}}"]'].join(
					"\n",
				),
				"commands.yaml",
			);
			const command = registry.commands.get("commit");
			ok(command !== undefined);
			const clean = await runCodeStep({
				stepId: "commit",
				command,
				workspaceRoot: root,
				substitutions: { commitMessage: "Nothing to say" },
				requireWorkspaceChanges: true,
			});
			strictEqual(clean.report.passed, false);
			ok(clean.report.checks[0]?.evidence.includes("nothing to commit"));
			// Nothing ran, so the log is unchanged.
			strictEqual(
				execFileSync("git", ["-C", root, "log", "--oneline"], { encoding: "utf8" }).trim().split("\n").length,
				1,
			);

			writeFileSync(join(root, "seed.txt"), "changed\n");
			const dirty = await runCodeStep({
				stepId: "commit",
				command,
				workspaceRoot: root,
				substitutions: { commitMessage: "Record the change" },
				requireWorkspaceChanges: true,
			});
			strictEqual(dirty.report.passed, true);
			ok(
				execFileSync("git", ["-C", root, "log", "-1", "--pretty=%s"], { encoding: "utf8" }).includes("Record the change"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("an unbound placeholder is refused rather than committed empty", async () => {
		const registry = parseFleetCommands(
			["version: 1", "commands:", "  commit:", '    argv: [git, commit, -m, "{{commitMessage}}"]'].join("\n"),
			"commands.yaml",
		);
		const command = registry.commands.get("commit");
		ok(command !== undefined);
		await rejects(
			() => runCodeStep({ stepId: "commit", command, workspaceRoot: process.cwd() }),
			/no value for placeholder/,
		);
	});
});

describe("builtin SDLC fleets", () => {
	it("the shipped chains are discoverable and valid against a configured repo", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-fleets-"));
		try {
			const listings = listFleetContracts(root);
			const names = listings.map((entry) => entry.name);
			for (const expected of ["build-review", "build-test", "sdlc"]) ok(names.includes(expected), expected);
			// Decision 5: a repo with no command registry gets a hard, named error,
			// never a green placeholder.
			const sdlc = listings.find((entry) => entry.name === "sdlc");
			strictEqual(sdlc?.source, "builtin");
			strictEqual(sdlc?.contract, null);
			ok(sdlc?.error?.includes("commands.yaml"));
			// Unrunnable for a reason the operator fixes by writing a file, and the
			// listing carries which ids that file has to bind. A fleet with no code
			// steps at all is untouched by any of this.
			deepStrictEqual(sdlc?.needsCommands, ["commit", "test"]);
			deepStrictEqual(listings.find((entry) => entry.name === "build-test")?.needsCommands, ["test"]);
			strictEqual(listings.find((entry) => entry.name === "build-review")?.needsCommands, null);
			strictEqual(listings.find((entry) => entry.name === "build-review")?.error, null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a registry that exists and does not bind the ids is an error, not unfinished setup", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-fleets-"));
		try {
			execFileSync("mkdir", ["-p", join(root, ".clio-coder", "fleets")]);
			writeFileSync(
				join(root, ".clio-coder", "fleets", "commands.yaml"),
				["version: 1", "commands:", "  lint:", '    argv: ["true"]'].join("\n"),
			);
			const sdlc = listFleetContracts(root).find((entry) => entry.name === "sdlc");
			strictEqual(sdlc?.contract, null);
			match(sdlc?.error ?? "", /names unknown command 'commit'/);
			// The repo answered the question; the answer is wrong. Telling it to
			// write the file it already wrote would be the useless remedy.
			strictEqual(sdlc?.needsCommands, null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("the missing-registry failure is typed and names the ids the contract binds", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-fleets-"));
		try {
			const builtTest = listFleetContracts(root).find((entry) => entry.name === "build-test");
			ok(builtTest !== undefined);
			throws(
				() => {
					const parsed = parseFleetContract(readFileSync(builtTest.path, "utf8"), builtTest.path);
					validateFleetCommands(parsed, null);
				},
				(err: unknown) => {
					ok(err instanceof FleetCommandRegistryMissingError);
					deepStrictEqual([...err.commands], ["test"]);
					match(err.message, /require a command registry/);
					return true;
				},
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("the full chain compiles to plan, build, bounded loops, and three commits", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-fleets-"));
		try {
			execFileSync("mkdir", ["-p", join(root, ".clio-coder", "fleets")]);
			writeFileSync(
				join(root, ".clio-coder", "fleets", "commands.yaml"),
				[
					"version: 1",
					"commands:",
					"  test:",
					'    argv: ["true"]',
					"  commit:",
					'    argv: [git, commit, --all, --message, "{{commitMessage}}"]',
				].join("\n"),
			);
			const sdlc = listFleetContracts(root).find((entry) => entry.name === "sdlc");
			strictEqual(sdlc?.error, null);
			ok(sdlc?.contract !== null && sdlc?.contract !== undefined);
			const compiled = plan(sdlc.contract);
			const ids = compiled.steps.map((step) => step.id);
			for (const expected of [
				"plan",
				"commit-plan",
				"build",
				"suite.check.1",
				"suite.repair.1",
				"review.check.1",
				"review.repair.1",
				"commit-code",
				"document",
				"commit-docs",
			]) {
				ok(ids.includes(expected), expected);
			}
			deepStrictEqual(
				compiled.loops.map((entry) => `${entry.id}:${entry.maxAttempts}`),
				["suite:3", "review:2"],
			);

			const trusted = (id: string) =>
				[id, { succeeded: true, integrityValid: true, receiptDigest: "a".repeat(64) }] as const;
			const resultMap = new Map([trusted("plan"), trusted("build"), trusted("document")]);
			const commitPlan = compiled.steps.find((step) => step.id === "commit-plan");
			const commitCode = compiled.steps.find((step) => step.id === "commit-code");
			const commitDocs = compiled.steps.find((step) => step.id === "commit-docs");
			ok(commitPlan?.kind === "code" && commitCode?.kind === "code" && commitDocs?.kind === "code");
			const planEvidence = deriveFleetCommitAttribution({
				plan: compiled,
				step: commitPlan,
				priorResults: resultMap,
				validationFresh: false,
				independentReviewFresh: false,
			});
			deepStrictEqual(planEvidence, {
				materiallyAssisted: true,
				materiallyAuthored: true,
				validationSucceeded: false,
				independentReviewPassed: false,
				receipt: {
					version: 16,
					algorithm: "sha256",
					digest: "a".repeat(64),
					integrityValid: true,
					directlyRelevant: true,
				},
			});
			const planMessage = attributeCommitMessage("Plan", planEvidence);
			ok(planMessage.includes("Assisted-by:"));
			ok(planMessage.includes("Co-authored-by:"));
			strictEqual(planMessage.includes("Tested-by:"), false);
			strictEqual(planMessage.includes("Reviewed-by:"), false);
			const codeEvidence = deriveFleetCommitAttribution({
				plan: compiled,
				step: commitCode,
				priorResults: resultMap,
				validationFresh: true,
				independentReviewFresh: true,
			});
			strictEqual(codeEvidence.materiallyAuthored, true);
			strictEqual(codeEvidence.validationSucceeded, true);
			strictEqual(codeEvidence.independentReviewPassed, true);
			const codeMessage = attributeCommitMessage("Code", codeEvidence);
			for (const role of ["Assisted-by:", "Tested-by:", "Reviewed-by:", "Co-authored-by:"]) {
				ok(codeMessage.includes(role), role);
			}
			const docsEvidence = deriveFleetCommitAttribution({
				plan: compiled,
				step: commitDocs,
				priorResults: resultMap,
				validationFresh: true,
				independentReviewFresh: false,
			});
			strictEqual(docsEvidence.materiallyAuthored, true);
			strictEqual(docsEvidence.validationSucceeded, true);
			strictEqual(docsEvidence.independentReviewPassed, false);
			const docsMessage = attributeCommitMessage("Docs", docsEvidence);
			ok(docsMessage.includes("Assisted-by:"));
			ok(docsMessage.includes("Tested-by:"));
			strictEqual(docsMessage.includes("Reviewed-by:"), false);
			ok(docsMessage.includes("Co-authored-by:"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a full sdlc run with a red first suite commits plan, code, and docs in order", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-fleets-"));
		try {
			execFileSync("mkdir", ["-p", join(root, ".clio-coder", "fleets")]);
			writeFileSync(
				join(root, ".clio-coder", "fleets", "commands.yaml"),
				["version: 1", "commands:", "  test:", '    argv: ["true"]', "  commit:", '    argv: ["true"]'].join("\n"),
			);
			const sdlc = listFleetContracts(root).find((entry) => entry.name === "sdlc")?.contract;
			ok(sdlc !== null && sdlc !== undefined);
			const compiled = plan(sdlc);
			const adapter = stub({ outcomes: { "suite.check.1": false } });
			const outcome = await executePlan(compiled, adapter);
			deepStrictEqual(adapter.code, [
				"commit-plan",
				"suite.check.1",
				"suite.check.2",
				"commit-code",
				// The write-up is a workspace step too, so the suite is re-run before
				// its commit rather than recording a tree nothing has verified.
				"suite.check.2",
				"commit-docs",
			]);
			deepStrictEqual(adapter.launched, ["plan", "build", "suite.repair.1", "review.check.1", "document"]);
			deepStrictEqual(
				outcome.loops.map((entry) => `${entry.loopId}:${entry.reason}`),
				["suite:resolved", "review:resolved"],
			);
			// The fix repair landed before the review, so the code commit rode a
			// green nothing had touched; only the documenter invalidated one.
			deepStrictEqual(outcome.revalidated, ["suite.check.2"]);
			deepStrictEqual(outcome.skipped, []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
