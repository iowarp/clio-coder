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
import { operatorOnlyAsk, type SafetyJudgeSubject } from "../../src/domains/safety/safety-judge.js";
import { effectiveScratchRoots } from "../../src/domains/safety/scratch-roots.js";
import {
	createWorkspaceSnapshots,
	type WorkspaceSnapshotOutcome,
} from "../../src/domains/workspace-snapshots/store.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { editTool } from "../../src/tools/edit.js";
import { createRegistry, type RegistryDeps } from "../../src/tools/registry.js";
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
	for (const path of ["/opt/clio-contained-scratch-probe/x.txt", join(scratch, "repo", ".git", "hooks", "pre-commit")]) {
		const verdict = admit(write(path));
		strictEqual(verdict.kind === "ask" && verdict.decision.policy?.reasonCode, "system-modify-confirm", path);
	}
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
