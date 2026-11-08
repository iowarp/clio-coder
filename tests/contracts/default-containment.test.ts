import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioConfigDir } from "../../src/core/xdg.js";
import type { ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import { evaluateAdmission } from "../../src/domains/safety/admission.js";
import { createSafetyPolicyEngine, type OperatorDefaultScope } from "../../src/domains/safety/policy-engine.js";
import { createSafetyJudge, operatorOnlyAsk, type SafetyJudgeSubject } from "../../src/domains/safety/safety-judge.js";
import { asksToLeaveSandbox } from "../../src/domains/safety/sandbox-escape.js";
import { effectiveScratchRoots } from "../../src/domains/safety/scratch-roots.js";
import {
	createWorkspaceSnapshots,
	type WorkspaceSnapshotOutcome,
} from "../../src/domains/workspace-snapshots/store.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { editTool } from "../../src/tools/edit.js";
import { createRegistry, type RegistryDeps, type ToolSpec } from "../../src/tools/registry.js";
import { createRunScriptTool } from "../../src/tools/run-script.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { writeTool } from "../../src/tools/write.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function workspace(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const bash = (command: string, extra: Record<string, unknown> = {}): ClassifierCall => ({
	tool: ToolNames.Bash,
	args: { command, ...extra },
});

/**
 * The main session's registry at autonomy default with the containment the
 * orchestrator wires, a judge seat that records what it was asked to review
 * and then gives no verdict, and a bash body that records how it was run.
 * With no permission listener an unjudged ask is denied, never run.
 */
function defaultSession(
	cwd: string,
	containment: { sandbox: boolean; snapshots: boolean },
	extra: Partial<RegistryDeps> = {},
) {
	const reviewed: SafetyJudgeSubject[] = [];
	const order: string[] = [];
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => containment,
		safetyJudge: {
			review: (subject) => {
				reviewed.push(subject);
				return { kind: "skip" };
			},
			operatorApproved: () => {},
		},
		...extra,
	});
	const ran: Array<{ command: string; sandboxed: boolean }> = [];
	registry.register({
		...bashTool,
		run: async (args, options) => {
			order.push("body");
			ran.push({ command: String(args.command), sandboxed: options?.shellSandbox !== undefined });
			return { kind: "ok", output: "" };
		},
	});
	return { registry, ran, reviewed, order };
}

const reviewedCommands = (reviewed: SafetyJudgeSubject[]) => reviewed.map((subject) => String(subject.args?.command));

test("a contained unrecognized command and a named script run at default without an ask, in the sandbox", async () => {
	const cwd = workspace("clio-contained-run-");
	writeFileSync(join(cwd, "x.sh"), "echo hi\n");
	const session = defaultSession(cwd, { sandbox: true, snapshots: false });
	for (const command of ["make bench", "bash x.sh"]) {
		strictEqual((await session.registry.invoke(bash(command))).kind, "ok", command);
	}
	deepStrictEqual(session.ran, [
		{ command: "make bench", sandboxed: true },
		{ command: "bash x.sh", sandboxed: true },
	]);
	deepStrictEqual(session.reviewed, []);
});

test("unsandboxed: true and an outward call leave containment and reach the safety judge", async () => {
	const cwd = workspace("clio-contained-leave-");
	const session = defaultSession(cwd, { sandbox: true, snapshots: false });
	for (const call of [bash("make bench", { unsandboxed: true }), bash("git push origin main"), bash("gh pr create")]) {
		strictEqual((await session.registry.invoke(call)).kind, "blocked", JSON.stringify(call.args));
	}
	deepStrictEqual(session.ran, []);
	deepStrictEqual(reviewedCommands(session.reviewed), ["make bench", "git push origin main", "gh pr create"]);
	for (const subject of session.reviewed) strictEqual(operatorOnlyAsk(subject), null, String(subject.args?.command));
});

test("a verify check that runs a command is contained at default like bash; listing runs nothing and is not", async (t) => {
	const cwd = workspace("clio-contained-verify-");
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
	// verify resolves its checks in the process's working directory, as the main session runs it.
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const session = defaultSession(cwd, { sandbox: true, snapshots: false });
	const checks: Array<{ check: unknown; sandboxed: boolean }> = [];
	session.registry.register({
		...verifyTool,
		run: async (args, options) => {
			checks.push({ check: args.check, sandboxed: options?.shellSandbox !== undefined });
			return { kind: "ok", output: "" };
		},
	});
	for (const args of [{ check: "test" }, {}]) {
		const verdict = await session.registry.invoke({ tool: ToolNames.Verify, args });
		strictEqual(verdict.kind, "ok", JSON.stringify(args));
	}
	deepStrictEqual(checks, [
		{ check: "test", sandboxed: true },
		{ check: undefined, sandboxed: false },
	]);
	deepStrictEqual(session.reviewed, []);
});

// ob-yolo Q7: a recognized command with unsandboxed: true ran unconfined at default with no review.
test("unsandboxed: true asks at default even for a recognized command; the judge decides it first", async (t) => {
	const cwd = workspace("clio-contained-escape-");
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
	writeFileSync(join(cwd, "x.sh"), "echo hi\n");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const escapes: ClassifierCall[] = [
		bash("npm test", { unsandboxed: true }),
		{ tool: ToolNames.Verify, args: { check: "test", unsandboxed: true } },
		{ tool: ToolNames.RunScript, args: { interpreter: "bash", script: "x.sh", unsandboxed: true } },
	];
	const session = (verdict: "skip" | "allow") => {
		const ran: Array<{ tool: string; sandboxed: boolean }> = [];
		const recorder = (spec: ToolSpec): ToolSpec => ({
			...spec,
			run: async (_args, options) => {
				ran.push({ tool: spec.name, sandboxed: options?.shellSandbox !== undefined });
				return { kind: "ok" as const, output: "" };
			},
		});
		const judge = defaultSession(
			cwd,
			{ sandbox: true, snapshots: false },
			{
				safetyJudge: {
					review: () =>
						verdict === "skip"
							? { kind: "skip" }
							: { kind: "allow", rule: "operator-named", reason: "the operator asked for it", build: "t", latencyMs: 0 },
					operatorApproved: () => {},
				},
			},
		);
		for (const spec of [bashTool, verifyTool, createRunScriptTool({ getWorkspaceRoot: () => cwd })])
			judge.registry.register(recorder(spec));
		return { registry: judge.registry, ran };
	};
	const unjudged = session("skip");
	for (const call of escapes) {
		const verdict = await unjudged.registry.invoke(call);
		strictEqual(verdict.kind, "blocked", call.tool);
		strictEqual(verdict.decision.policy?.reasonCode, "sandbox-escape", call.tool);
	}
	strictEqual(unjudged.ran.length, 0);
	// The same calls without the flag run contained with no ask.
	for (const call of escapes) {
		const { unsandboxed: _, ...args } = call.args ?? {};
		strictEqual((await unjudged.registry.invoke({ tool: call.tool, args })).kind, "ok", call.tool);
	}
	deepStrictEqual(
		unjudged.ran.map((entry) => entry.sandboxed),
		[true, true, true],
	);
	const allowed = session("allow");
	for (const call of escapes) strictEqual((await allowed.registry.invoke(call)).kind, "ok", call.tool);
	deepStrictEqual(
		allowed.ran.map((entry) => entry.sandboxed),
		[false, false, false],
	);
});

// ob-yolo batch7: a judge allowed npm test unsandboxed as task-local on a repository file's say-so.
// ob-yolo batch8: a judge cited operator-named for it when the operator had only asked to fix the tests.
test("a sandbox escape runs only when the judge finds the operator named it and they did", async (t) => {
	const cwd = workspace("clio-escape-named-");
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const escapes = [bash("npm test", { unsandboxed: true }), bash("rm -rf build", { unsandboxed: true })];
	const session = (rule: string, operator = "fix the tests, running them outside the sandbox") => {
		const ran: boolean[] = [];
		const reviewed: SafetyJudgeSubject[] = [];
		const judge = createSafetyJudge({
			config: () => ({ enabled: true, target: "local", model: "m", environment: [], allow: [], deny: [] }),
			complete: async () => ({ text: JSON.stringify({ verdict: "allow", rule, reason: "serves the task" }) }),
			operatorMessages: () => [operator],
			session: () => "s",
			consequences: () => [],
		});
		const { registry } = defaultSession(
			cwd,
			{ sandbox: true, snapshots: false },
			{
				safetyJudge: {
					review: (subject) => {
						reviewed.push(subject);
						return judge.review(subject);
					},
					operatorApproved: () => {},
				},
			},
		);
		registry.register({
			...bashTool,
			run: async (_args, options) => {
				ran.push(options?.shellSandbox !== undefined);
				return { kind: "ok" as const, output: "" };
			},
		});
		return { registry, ran, reviewed };
	};
	const inferred = session("task-local");
	for (const call of escapes) {
		const verdict = await inferred.registry.invoke(call);
		strictEqual(verdict.kind, "blocked", String(call.args?.command));
	}
	deepStrictEqual(inferred.ran, []);
	// The delete asks under its own rule; the escape rides along as a reason.
	deepStrictEqual(
		inferred.reviewed.map((subject) => [subject.decision.policy?.ruleId, asksToLeaveSandbox(subject.decision)]),
		[
			["sandbox-escape", true],
			["delete-without-snapshot", true],
		],
	);
	const misread = session("operator-named", "The tests fail. Fix calc.js so npm test passes.");
	for (const call of escapes)
		strictEqual((await misread.registry.invoke(call)).kind, "blocked", String(call.args?.command));
	deepStrictEqual(misread.ran, []);
	const named = session("operator-named");
	for (const call of escapes) strictEqual((await named.registry.invoke(call)).kind, "ok", String(call.args?.command));
	deepStrictEqual(named.ran, [false, false]);
});

test("with no sandbox backend the default rails still ask", async () => {
	const cwd = workspace("clio-contained-none-");
	const session = defaultSession(cwd, { sandbox: false, snapshots: false });
	strictEqual((await session.registry.invoke(bash("make bench"))).kind, "blocked");
	deepStrictEqual(session.ran, []);
	deepStrictEqual(reviewedCommands(session.reviewed), ["make bench"]);
});

test("git reset --hard runs after its snapshot, is refused without one, and asks when snapshots are off", async () => {
	const cwd = workspace("clio-contained-reset-");
	const taken = (order: string[]) => async (): Promise<WorkspaceSnapshotOutcome> => {
		order.push("snapshot");
		return { kind: "taken", record: {} as never, reused: false, durationMs: 0 };
	};
	const order: string[] = [];
	const snapshotted = defaultSession(cwd, { sandbox: true, snapshots: true }, { workspaceSnapshot: taken(order) });
	strictEqual((await snapshotted.registry.invoke(bash("git reset --hard"))).kind, "ok");
	deepStrictEqual([...order, ...snapshotted.order], ["snapshot", "body"]);
	deepStrictEqual(snapshotted.reviewed, []);

	const failed = defaultSession(
		cwd,
		{ sandbox: true, snapshots: true },
		{ workspaceSnapshot: async () => ({ kind: "unavailable", reason: "git timed out", durationMs: 0 }) },
	);
	const refused = await failed.registry.invoke(bash("git reset --hard"));
	strictEqual(refused.kind === "blocked" && refused.decision.policy?.reasonCode, "snapshot-required");
	deepStrictEqual(failed.ran, []);

	const off = defaultSession(cwd, { sandbox: true, snapshots: false });
	strictEqual((await off.registry.invoke(bash("git reset --hard"))).kind, "blocked");
	deepStrictEqual(off.ran, []);
	deepStrictEqual(reviewedCommands(off.reviewed), ["git reset --hard"]);
});

test("a recoverable stash drop is refused when its snapshot cannot pin the stash", async () => {
	const cwd = workspace("clio-contained-pins-");
	const git = (...args: string[]) =>
		spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", ...args], { cwd, encoding: "utf8" });
	git("init", "-q");
	writeFileSync(join(cwd, "a.txt"), "one\n");
	git("add", ".");
	git("commit", "-qm", "init");
	writeFileSync(join(cwd, "a.txt"), "two\n");
	git("stash", "push", "-q");
	// A ref where the pin directory belongs fails every pin write; the files snapshot still lands.
	git("update-ref", "refs/clio-coder/snapshots/s-1/pins", "HEAD");
	const snapshots = createWorkspaceSnapshots({
		stateDir: workspace("clio-contained-pins-state-"),
		sessionId: "s-1",
		cwd,
	});
	const session = defaultSession(
		cwd,
		{ sandbox: true, snapshots: true },
		{ workspaceSnapshot: (request) => snapshots.snapshot(request) },
	);
	const refused = await session.registry.invoke(bash("git stash drop"));
	strictEqual(refused.kind === "blocked" && refused.decision.policy?.reasonCode, "snapshot-required");
	match(refused.kind === "blocked" ? refused.reason : "", /could not pin the stash/);
	deepStrictEqual(session.ran, []);
	strictEqual(snapshots.list().length, 1);
});

test("a force push asks at default instead of being refused, and the floor still refuses", () => {
	const cwd = workspace("clio-contained-resort-");
	const safety = createWorkerSafety({ cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const admit = (call: ClassifierCall) =>
		evaluateAdmission({ principal: "main", effects: [call], safety, autonomy: "default", operatorDefault });
	const push = admit(bash("git push --force origin main"));
	strictEqual(push.kind === "ask" && push.approvalAuthority, "operator");
	strictEqual(push.decision.policy?.reasonCode, "damage-control:git-push-force-main");
	// Without the operator's scope (a worker, a grant, a command job) it stays a hard block.
	strictEqual(
		evaluateAdmission({ principal: "main", effects: [bash("git push --force origin main")], safety }).kind,
		"deny",
	);
	const floor = admit(bash("rm -rf ~"));
	strictEqual(floor.kind === "deny" && floor.decision.policy?.reasonCode, "yolo-floor:rm-home-or-root");
});

test("reads of Clio's credential store are floor at default and at yolo", async (t) => {
	const home = await isolateClioEnv("clio-contained-credentials-");
	t.after(() => home.restore());
	const store = join(clioConfigDir(), "credentials.yaml");
	mkdirSync(clioConfigDir(), { recursive: true });
	writeFileSync(store, "openai: x\n");
	const engine = createSafetyPolicyEngine({ cwd: workspace("clio-contained-credentials-ws-") });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	for (const call of [{ tool: ToolNames.Read, args: { path: store } }, bash(`cat ${store}`)]) {
		for (const decision of [
			engine.evaluate(call, undefined, operatorDefault),
			engine.evaluate(call, "yolo", { scratchRoots: [] }),
		]) {
			strictEqual(decision.kind, "block", JSON.stringify(call.args));
			strictEqual(decision.reasonCode, "yolo-floor:yolo-floor-clio-credentials", JSON.stringify(call.args));
		}
	}
});

test("typed writes and edits inside a scratch root run at default with no ask, even with the sandbox off", async (t) => {
	const cwd = workspace("clio-contained-scratch-write-ws-");
	// $TMPDIR is a built-in scratch root, and the typed tools resolve paths against the process cwd.
	const scratch = workspace("clio-contained-scratch-write-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const session = defaultSession(cwd, { sandbox: false, snapshots: false });
	session.registry.register(writeTool);
	session.registry.register(editTool);
	const target = join(scratch, "smoke", "analyze.py");
	const calls: ClassifierCall[] = [
		{ tool: ToolNames.Write, args: { path: target, content: "print(1)\n" } },
		// The file now exists, so these used to ask under outside-file-replacement.
		{ tool: ToolNames.Edit, args: { path: target, edits: [{ oldText: "print(1)", newText: "print(2)" }] } },
		{ tool: ToolNames.Write, args: { path: target, content: "print(3)\n" } },
	];
	for (const call of calls) {
		const verdict = await session.registry.invoke(call);
		strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? verdict.reason : call.tool);
	}
	strictEqual(readFileSync(target, "utf8"), "print(3)\n");
	deepStrictEqual(session.reviewed, []);
});

test("outside scratch roots, in a scratch repository's .git and on secret paths the write rails still hold", () => {
	const cwd = workspace("clio-contained-scratch-rails-ws-");
	const scratch = workspace("clio-contained-scratch-rails-");
	const safety = createWorkerSafety({ cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const write = (path: string): ClassifierCall => ({ tool: ToolNames.Write, args: { path, content: "x" } });
	const admit = (call: ClassifierCall) =>
		evaluateAdmission({ principal: "main", effects: [call], safety, autonomy: "default", operatorDefault });
	// /opt is never a scratch root, so this path is outside every one on any host.
	const outside = admit(write("/opt/clio-contained-scratch-probe/x.txt"));
	strictEqual(outside.kind === "ask" && outside.decision.policy?.reasonCode, "system-modify-confirm");
	const hook = admit(write(join(scratch, "repo", ".git", "hooks", "pre-commit")));
	strictEqual(hook.kind === "ask" && hook.decision.policy?.reasonCode, "git-control-file");
	const secret = admit(write(join(scratch, "server.pem")));
	strictEqual(secret.kind === "deny" && secret.decision.policy?.reasonCode, "path-policy:zeroAccessPaths");
	// Without the operator's scope (a worker, a grant, a command job) a scratch write keeps its ask.
	const unscoped = evaluateAdmission({ principal: "main", effects: [write(join(scratch, "a.txt"))], safety });
	strictEqual(unscoped.kind, "ask");
});

test("a typed write to the workspace repository's hooks asks at default, and an ordinary workspace file runs", (t) => {
	const cwd = workspace("clio-contained-git-control-");
	mkdirSync(join(cwd, ".git"));
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const safety = createWorkerSafety({ cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const admit = (path: string) =>
		evaluateAdmission({
			principal: "main",
			effects: [{ tool: ToolNames.Write, args: { path, content: "x" } }],
			safety,
			autonomy: "default",
			operatorDefault,
		});
	const hook = admit(".git/hooks/pre-commit");
	strictEqual(hook.kind === "ask" && hook.decision.policy?.reasonCode, "git-control-file");
	strictEqual(admit("src/app.py").kind, "allow");
});

test("a worker's typed write to its repository's hooks asks the main agent at default, and an ordinary file runs", (t) => {
	const cwd = workspace("clio-worker-git-control-");
	mkdirSync(join(cwd, ".git"));
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const safety = createWorkerSafety({ cwd, writeRoots: [`${cwd}/`] });
	const admit = (path: string) =>
		evaluateAdmission({
			principal: "worker",
			effects: [{ tool: ToolNames.Write, args: { path, content: "x" } }],
			safety,
		});
	const hook = admit(".git/hooks/pre-commit");
	strictEqual(hook.kind === "ask" && hook.approvalAuthority, "main");
	strictEqual(hook.decision.policy?.ruleId, "git-control-file");
	strictEqual(admit("src/app.py").kind, "allow");
});

test("a typed write into a repository created after the engine was built asks at default, main and worker alike", (t) => {
	const cwd = workspace("clio-git-control-late-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const main = createWorkerSafety({ cwd });
	const worker = createWorkerSafety({ cwd, writeRoots: [`${cwd}/`] });
	spawnSync("git", ["init", "-q"], { cwd });
	spawnSync("git", ["init", "-q", "nested"], { cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const write = (path: string): ClassifierCall => ({ tool: ToolNames.Write, args: { path, content: "x" } });
	const admitMain = (path: string) =>
		evaluateAdmission({ principal: "main", effects: [write(path)], safety: main, autonomy: "default", operatorDefault });
	const admitWorker = (path: string) =>
		evaluateAdmission({ principal: "worker", effects: [write(path)], safety: worker });
	for (const path of [".git/hooks/pre-commit", "nested/.git/hooks/pre-commit"]) {
		const asked = admitMain(path);
		strictEqual(asked.kind === "ask" && asked.decision.policy?.reasonCode, "git-control-file", path);
		const workerAsked = admitWorker(path);
		strictEqual(workerAsked.kind === "ask" && workerAsked.approvalAuthority, "main", path);
		strictEqual(workerAsked.decision.policy?.ruleId, "git-control-file", path);
	}
	strictEqual(admitMain("src/app.py").kind, "allow");
	strictEqual(admitWorker("src/app.py").kind, "allow");
});

test("a typed write into the core.hooksPath directory asks at default, also once the session has set it", (t) => {
	const cwd = workspace("clio-git-control-hooks-path-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	spawnSync("git", ["init", "-q"], { cwd });
	mkdirSync(join(cwd, ".husky"));
	const before = createWorkerSafety({ cwd });
	spawnSync("git", ["config", "core.hooksPath", ".husky"], { cwd });
	const main = createWorkerSafety({ cwd });
	const worker = createWorkerSafety({ cwd, writeRoots: [`${cwd}/`] });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const write = (path: string): ClassifierCall => ({ tool: ToolNames.Write, args: { path, content: "x" } });
	const admitMain = (safety: typeof main, call: ClassifierCall) =>
		evaluateAdmission({ principal: "main", effects: [call], safety, autonomy: "default", operatorDefault });
	const asked = admitMain(main, write(".husky/pre-commit"));
	strictEqual(asked.kind === "ask" && asked.decision.policy?.reasonCode, "git-control-file");
	const workerAsked = evaluateAdmission({ principal: "worker", effects: [write(".husky/pre-commit")], safety: worker });
	strictEqual(workerAsked.kind === "ask" && workerAsked.approvalAuthority, "main");
	strictEqual(admitMain(main, write("src/app.py")).kind, "allow");
	// An engine built before the setting re-reads it after an admitted command that may have written it.
	strictEqual(admitMain(before, bash("git config core.hooksPath .husky")).kind, "allow");
	const refreshed = admitMain(before, write(".husky/pre-commit"));
	strictEqual(refreshed.kind === "ask" && refreshed.decision.policy?.reasonCode, "git-control-file");
});

test("the default scratch roots include $TMPDIR and /tmp", () => {
	const roots = effectiveScratchRoots([], workspace("clio-contained-scratch-"));
	ok(roots.includes(realpathSync(tmpdir())), roots.join(", "));
	ok(roots.includes(realpathSync("/tmp")), roots.join(", "));
});

test("under bwrap a contained main-session command writes the workspace and /tmp but not $HOME", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	// The assertion about $HOME means something only where the host itself can write it.
	if (spawnSync("bash", ["-c", 'test -w "$HOME"']).status !== 0) {
		t.skip("$HOME is not writable on this host");
		return;
	}
	const cwd = workspace("clio-contained-bwrap-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: false }),
	});
	registry.register(bashTool);
	// `test -w` asks the kernel, so a read-only bind answers no without a file being written.
	const verdict = await registry.invoke(
		bash('echo a > a.txt; test -w /tmp && echo tmp-writable; test -w "$HOME" || echo home-read-only'),
	);
	strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? verdict.reason : "");
	const output = verdict.kind === "ok" && verdict.result.kind === "ok" ? verdict.result.output : "";
	match(output, /tmp-writable/u);
	match(output, /home-read-only/u);
	strictEqual(existsSync(join(cwd, "a.txt")), true);
});

test("under bwrap the core.hooksPath directory is read-only for a contained command", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const cwd = workspace("clio-contained-hooks-path-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	spawnSync("git", ["init", "-q"], { cwd });
	spawnSync("git", ["config", "core.hooksPath", ".husky"], { cwd });
	mkdirSync(join(cwd, ".husky"));
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: false }),
	});
	registry.register(bashTool);
	const verdict = await registry.invoke(bash("echo a > a.txt; echo x > .husky/pre-commit || echo hooks-path-read-only"));
	strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? verdict.reason : "");
	const output = verdict.kind === "ok" && verdict.result.kind === "ok" ? verdict.result.output : "";
	match(output, /hooks-path-read-only/u);
	strictEqual(existsSync(join(cwd, "a.txt")), true);
	strictEqual(existsSync(join(cwd, ".husky", "pre-commit")), false);
});

/** A read-only main session's registry, recording the sandbox each bash call was given. */
function readOnlySession(cwd: string, readOnlySandbox: boolean, level: "default" | "yolo") {
	const reviewed: SafetyJudgeSubject[] = [];
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => level,
		readOnly: true,
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: true, readOnlySandbox }),
		currentSessionId: () => "s1",
		safetyJudge: {
			review: (subject) => {
				reviewed.push(subject);
				return { kind: "skip" };
			},
			operatorApproved: () => {},
		},
	});
	const ran: Array<{ command: string; readOnly: boolean; writableRoots: ReadonlyArray<string> }> = [];
	registry.register({
		...bashTool,
		run: async (args, options) => {
			ran.push({
				command: String(args.command),
				readOnly: options?.shellSandbox?.readOnly === true,
				writableRoots: options?.shellSandbox?.writableRoots ?? [],
			});
			return { kind: "ok", output: "" };
		},
	});
	return { registry, ran, reviewed };
}

for (const level of ["default", "yolo"] as const) {
	test(`a read-only session runs a contained command at ${level} in the read-only sandbox, and asks nobody`, async () => {
		const cwd = workspace("clio-read-only-shell-");
		const session = readOnlySession(cwd, true, level);
		strictEqual((await session.registry.invoke(bash("make bench"))).kind, "ok");
		strictEqual(session.ran.length, 1);
		strictEqual(session.ran[0]?.readOnly, true);
		strictEqual(session.ran[0]?.writableRoots.length, 1);
		match(session.ran[0]?.writableRoots[0] ?? "", /\/scratch\/read-only\/s1$/u);
		for (const call of [bash("make bench", { unsandboxed: true }), bash("git push origin main")]) {
			const verdict = await session.registry.invoke(call);
			strictEqual(verdict.kind, "blocked", JSON.stringify(call.args));
			if (verdict.kind === "blocked") match(verdict.reason, /read-only/u);
		}
		strictEqual(session.ran.length, 1);
		deepStrictEqual(session.reviewed, []);
	});
}

test("a read-only session refuses shell commands where the read-only sandbox does not run", async () => {
	const session = readOnlySession(workspace("clio-read-only-shell-none-"), false, "default");
	strictEqual((await session.registry.invoke(bash("make bench"))).kind, "blocked");
	deepStrictEqual(session.ran, []);
	deepStrictEqual(session.reviewed, []);
});

test("a read-only worker's shell command passes only when its sandbox confines every write, and never asks", () => {
	const cwd = workspace("clio-read-only-worker-shell-");
	const safety = createWorkerSafety({ cwd });
	const admit = (command: string, confined: boolean, extra: Record<string, unknown> = {}) =>
		evaluateAdmission({
			principal: "worker",
			effects: [bash(command, extra)],
			safety,
			constraints: { readOnly: true },
			...(confined ? { readOnlyShellConfined: true } : {}),
		});
	strictEqual(admit("ls -la", true).kind, "allow");
	strictEqual(admit("ls -la", false).kind, "deny");
	strictEqual(admit("ls -la", true, { unsandboxed: true }).kind, "deny");
	const unrecognized = admit("make bench", true);
	strictEqual(unrecognized.kind === "deny" && unrecognized.code, "read_only");
});

test("a read-only run admits a dispatch, whose workers inherit read-only, and refuses steering", () => {
	const cwd = workspace("clio-read-only-dispatch-");
	const safety = createWorkerSafety({ cwd });
	for (const principal of ["main", "worker"] as const) {
		const admit = (tool: string, args: Record<string, unknown>) =>
			evaluateAdmission({ principal, effects: [{ tool, args }], safety, constraints: { readOnly: true } });
		strictEqual(admit(ToolNames.Dispatch, { agent: "scout", task: "map the repo" }).kind, "allow", principal);
		const steer = admit(ToolNames.Steer, { run_id: "r1", message: "write it" });
		strictEqual(steer.kind === "deny" && steer.code, "read_only", principal);
	}
});
