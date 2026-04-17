import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { createLoopState, observe } from "../../src/domains/safety/loop-detector.js";
import { DEFAULT_SCOPE, READONLY_SCOPE, SUPER_SCOPE, isSubset } from "../../src/domains/safety/scope.js";

describe("safety/action-classifier", () => {
	it("read tools classify as read", () => {
		strictEqual(classify({ tool: "read", args: { path: "/x" } }).actionClass, "read");
		strictEqual(classify({ tool: "grep", args: {} }).actionClass, "read");
		strictEqual(classify({ tool: "glob", args: {} }).actionClass, "read");
	});

	it("write tools classify as write when under cwd", () => {
		const cwdPath = `${process.cwd()}/scratch.txt`;
		strictEqual(classify({ tool: "write", args: { path: cwdPath } }).actionClass, "write");
		strictEqual(classify({ tool: "edit", args: { path: cwdPath } }).actionClass, "write");
	});

	it("write outside cwd escalates to system_modify", () => {
		strictEqual(classify({ tool: "write", args: { path: "/etc/nope" } }).actionClass, "system_modify");
	});

	it("bash with benign command classifies as execute", () => {
		strictEqual(classify({ tool: "bash", args: { command: "ls -la" } }).actionClass, "execute");
	});

	it("git destructive patterns escalate to git_destructive", () => {
		strictEqual(classify({ tool: "bash", args: { command: "git push --force" } }).actionClass, "git_destructive");
		strictEqual(classify({ tool: "bash", args: { command: "git reset --hard HEAD" } }).actionClass, "git_destructive");
		strictEqual(classify({ tool: "bash", args: { command: "git branch -D feature" } }).actionClass, "git_destructive");
	});

	it("system modify patterns escalate to system_modify", () => {
		strictEqual(classify({ tool: "bash", args: { command: "sudo rm /foo" } }).actionClass, "system_modify");
		strictEqual(classify({ tool: "bash", args: { command: "apt-get install vim" } }).actionClass, "system_modify");
		strictEqual(classify({ tool: "bash", args: { command: "rm -rf /etc/passwd" } }).actionClass, "system_modify");
	});

	it("rm -rf under /tmp is not system_modify", () => {
		strictEqual(classify({ tool: "bash", args: { command: "rm -rf /tmp/foo" } }).actionClass, "execute");
	});

	it("unknown tool returns unknown", () => {
		strictEqual(classify({ tool: "mystery" }).actionClass, "unknown");
	});
});

describe("safety/scope", () => {
	it("READONLY is subset of DEFAULT and SUPER", () => {
		strictEqual(isSubset(READONLY_SCOPE, DEFAULT_SCOPE), true);
		strictEqual(isSubset(READONLY_SCOPE, SUPER_SCOPE), true);
	});

	it("SUPER is not subset of DEFAULT (system_modify missing)", () => {
		strictEqual(isSubset(SUPER_SCOPE, DEFAULT_SCOPE), false);
	});

	it("DEFAULT is subset of SUPER", () => {
		strictEqual(isSubset(DEFAULT_SCOPE, SUPER_SCOPE), true);
	});

	it("worker with extra write root outside orchestrator fails", () => {
		const worker = { ...DEFAULT_SCOPE, allowedWriteRoots: ["/etc"] };
		strictEqual(isSubset(worker, DEFAULT_SCOPE), false);
	});

	it("worker with dispatch when orchestrator has none fails", () => {
		strictEqual(isSubset(DEFAULT_SCOPE, READONLY_SCOPE), false);
	});
});

describe("safety/loop-detector", () => {
	it("fresh state does not loop", () => {
		const state = createLoopState({ maxRepeats: 3, windowMs: 1000 });
		const [, verdict] = observe(state, "k", 0);
		strictEqual(verdict.looping, false);
		strictEqual(verdict.count, 1);
	});

	it("detects loop when threshold hit", () => {
		let state = createLoopState({ maxRepeats: 3, windowMs: 1000 });
		state = observe(state, "k", 0)[0];
		state = observe(state, "k", 10)[0];
		const [, verdict] = observe(state, "k", 20);
		strictEqual(verdict.looping, true);
		strictEqual(verdict.count, 3);
	});

	it("trims events outside window", () => {
		let state = createLoopState({ maxRepeats: 3, windowMs: 100 });
		state = observe(state, "k", 0)[0];
		state = observe(state, "k", 50)[0];
		const [, verdict] = observe(state, "k", 200);
		// first two events aged out, only current remains
		strictEqual(verdict.count, 1);
		strictEqual(verdict.looping, false);
	});

	it("different keys do not collide", () => {
		let state = createLoopState({ maxRepeats: 3, windowMs: 1000 });
		state = observe(state, "a", 0)[0];
		state = observe(state, "b", 10)[0];
		const [, verdict] = observe(state, "a", 20);
		deepStrictEqual(verdict.count, 2);
		strictEqual(verdict.looping, false);
	});
});
