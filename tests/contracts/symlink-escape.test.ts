import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { canonicalizeExistingPath, canonicalizePath } from "../../src/core/path-canonical.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { compilePathPolicy, evaluatePathPolicy } from "../../src/domains/safety/path-policy.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry } from "../../src/tools/registry.js";
import { writeTool } from "../../src/tools/write.js";

/**
 * Path admission must follow a symlink at any component, dangling or not, to
 * where a read or write through it lands. The workspace root sits one level
 * inside its own temp directory, so `../../x` from `data/` escapes to that
 * directory, the way tool-bench's `err-symlink-escape` scenario does.
 */
describe("symlink escape admission", () => {
	let originalCwd: string;
	let base: string;
	let root: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		base = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-symlink-escape-")));
		root = join(base, "root");
		mkdirSync(join(root, "data"), { recursive: true });
		process.chdir(root);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(base, { recursive: true, force: true });
	});

	function writeClass(path: string): { actionClass: string; reasons: readonly string[] } {
		return classify({ tool: ToolNames.Write, args: { path, content: "x" } });
	}

	function assertOutsideCwd(path: string, landing: string): void {
		const classification = writeClass(path);
		strictEqual(classification.actionClass, "system_modify", path);
		deepStrictEqual(classification.reasons, [`write-path-outside-cwd: ${landing}`], path);
	}

	it("classifies a write through a dangling escaping link as out of the workspace", () => {
		symlinkSync("../../escape.txt", join(root, "data", "out.txt"));
		strictEqual(canonicalizePath(join(root, "data", "out.txt")), join(base, "escape.txt"));
		assertOutsideCwd("data/out.txt", join(base, "escape.txt"));
	});

	it("refuses the dangling escaping write end to end and leaves nothing outside the root", async () => {
		symlinkSync("../../escape.txt", join(root, "data", "out.txt"));
		const decision = createSafetyPolicyEngine({ cwd: root }).evaluate({
			tool: ToolNames.Write,
			args: { path: "data/out.txt", content: "x" },
		});
		strictEqual(decision.actionClass, "system_modify");
		strictEqual(decision.kind, "ask");
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "auto-edit" });
		registry.register(writeTool);
		registry.onPermissionRequired((_call, _decision, meta) => {
			registry.cancelParkedCall(meta.requestId, "contract: denied");
		});
		const verdict = await registry.invoke({ tool: ToolNames.Write, args: { path: "data/out.txt", content: "x" } });
		strictEqual(verdict.kind, "blocked");
		strictEqual(existsSync(join(base, "escape.txt")), false);
	});

	it("classifies a write through an escaping link whose target exists as out of the workspace", () => {
		writeFileSync(join(base, "escape.txt"), "outside\n");
		symlinkSync("../../escape.txt", join(root, "data", "out.txt"));
		assertOutsideCwd("data/out.txt", join(base, "escape.txt"));
	});

	it("blocks a read through an escaping link into a zero-access path", () => {
		writeFileSync(join(base, "secret.txt"), "secret\n");
		symlinkSync("../../secret.txt", join(root, "data", "notes.txt"));
		const policy = compilePathPolicy({ zeroAccessPaths: [join(base, "secret.txt")] }, root);
		const decision = evaluatePathPolicy(policy, "read", "data/notes.txt");
		strictEqual(decision.kind, "block");
		strictEqual(decision.kind === "block" ? decision.reasonCode : null, "path-policy:zeroAccessPaths");
		strictEqual(classify({ tool: ToolNames.Read, args: { path: "data/notes.txt" } }).actionClass, "read");
	});

	it("blocks a write through a dangling escaping link into a zero-access path", () => {
		symlinkSync("../../credentials.yaml", join(root, "data", "creds.yaml"));
		const policy = compilePathPolicy({ zeroAccessPaths: [join(base, "credentials.yaml")] }, root);
		const decision = evaluatePathPolicy(policy, "write", "data/creds.yaml");
		strictEqual(decision.kind, "block");
		strictEqual(decision.kind === "block" ? decision.reasonCode : null, "path-policy:zeroAccessPaths");
	});

	it("classifies a write below an escaping link in a parent directory component as out of the workspace", () => {
		symlinkSync("../../elsewhere", join(root, "data", "linkdir"));
		// Dangling directory link: the target directory does not exist yet.
		assertOutsideCwd("data/linkdir/out.txt", join(base, "elsewhere", "out.txt"));
		mkdirSync(join(base, "elsewhere"));
		assertOutsideCwd("data/linkdir/out.txt", join(base, "elsewhere", "out.txt"));
	});

	it("classifies a write through a chain of two links whose second escapes as out of the workspace", () => {
		symlinkSync("second.txt", join(root, "data", "first.txt"));
		symlinkSync("../../escape.txt", join(root, "data", "second.txt"));
		strictEqual(canonicalizePath(join(root, "data", "first.txt")), join(base, "escape.txt"));
		assertOutsideCwd("data/first.txt", join(base, "escape.txt"));
	});

	it("fails closed on a link loop at the target or in a parent component", () => {
		symlinkSync("loop-b", join(root, "data", "loop-a"));
		symlinkSync("loop-a", join(root, "data", "loop-b"));
		symlinkSync("self", join(root, "data", "self"));
		for (const target of ["data/loop-a", "data/self", "data/loop-a/out.txt"]) {
			strictEqual(canonicalizePath(join(root, target)), null, target);
			const classification = writeClass(target);
			strictEqual(classification.actionClass, "system_modify", target);
			match(classification.reasons[0] ?? "", /^write-path-outside-cwd: /u, target);
		}
		// Callers that key rather than contain get the lexical path back.
		strictEqual(canonicalizeExistingPath(join(root, "data", "self")), join(root, "data", "self"));
		const shellCwd = createSafetyPolicyEngine({ cwd: root }).evaluate({
			tool: ToolNames.Bash,
			args: { command: "ls", cwd: "data/loop-a" },
		});
		strictEqual(shellCwd.kind, "block");
		strictEqual(shellCwd.reasonCode, "bash-cwd-escape");
	});

	it("fails closed past 40 link hops and resolves a chain of exactly 40", () => {
		const chain = (prefix: string, length: number): void => {
			for (let index = 0; index < length; index += 1) {
				const next = index === length - 1 ? "../end.txt" : `${prefix}${index + 1}`;
				symlinkSync(next, join(root, "data", `${prefix}${index}`));
			}
		};
		chain("forty-", 40);
		chain("forty-one-", 41);
		strictEqual(canonicalizePath(join(root, "data", "forty-0")), join(root, "end.txt"));
		strictEqual(canonicalizePath(join(root, "data", "forty-one-0")), null);
		strictEqual(writeClass("data/forty-0").actionClass, "write");
		strictEqual(writeClass("data/forty-one-0").actionClass, "system_modify");
	});

	it("keeps links that stay inside the workspace admitted as plain writes", () => {
		writeFileSync(join(root, "data", "real.txt"), "inside\n");
		symlinkSync("real.txt", join(root, "data", "link.txt"));
		symlinkSync("missing.txt", join(root, "data", "dangling.txt"));
		symlinkSync("../data", join(root, "data", "up"));
		for (const target of ["data/link.txt", "data/dangling.txt", "data/up/new/file.txt"]) {
			const classification = writeClass(target);
			strictEqual(classification.actionClass, "write", target);
			deepStrictEqual(classification.reasons, [], target);
		}
		strictEqual(canonicalizePath(join(root, "data", "dangling.txt")), join(root, "data", "missing.txt"));
		strictEqual(canonicalizePath(join(root, "data", "up", "new", "file.txt")), join(root, "data", "new", "file.txt"));
		const policy = compilePathPolicy({}, root);
		strictEqual(evaluatePathPolicy(policy, "read", "data/link.txt").kind, "allow");
	});

	it("keeps plain missing files and missing directories on the deepest real parent", () => {
		const alias = join(base, "alias");
		symlinkSync(root, alias);
		strictEqual(canonicalizePath(join(alias, "missing.txt")), join(root, "missing.txt"));
		strictEqual(canonicalizePath(join(alias, "a", "b", "c.txt")), join(root, "a", "b", "c.txt"));
		strictEqual(canonicalizePath(join(root, "data")), join(root, "data"));
		writeFileSync(join(root, "file.txt"), "");
		strictEqual(canonicalizePath(join(root, "file.txt", "under")), join(root, "file.txt", "under"));
		ok(writeClass("data/new/deeper/file.txt").actionClass === "write");
	});
});

/**
 * The out-of-root write at auto-edit is the known call the policy engine
 * parks for operator confirmation. A park settles only through a listener's
 * answer, so a registry with no listener must refuse it rather than hang.
 */
describe("park without a permission listener", () => {
	let originalCwd: string;
	let base: string;
	let root: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		base = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-headless-park-")));
		root = join(base, "root");
		mkdirSync(join(root, "data"), { recursive: true });
		symlinkSync("../../escape.txt", join(root, "data", "out.txt"));
		process.chdir(root);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(base, { recursive: true, force: true });
	});

	function autoEditRegistry() {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "auto-edit" });
		registry.register(writeTool);
		return registry;
	}

	async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
		let timer: NodeJS.Timeout | undefined;
		const pending = new Promise<"pending">((resolve) => {
			timer = setTimeout(() => resolve("pending"), ms);
		});
		try {
			return await Promise.race([promise, pending]);
		} finally {
			clearTimeout(timer);
		}
	}

	it("refuses the call fail closed and says why", async () => {
		const registry = autoEditRegistry();
		const verdict = await settledWithin(
			registry.invoke({ tool: ToolNames.Write, args: { path: "data/out.txt", content: "x" } }),
			2000,
		);
		ok(verdict !== "pending", "the call settles instead of waiting on a park nobody can answer");
		strictEqual(verdict.kind, "blocked");
		if (verdict.kind !== "blocked") return;
		match(verdict.reason, /no permission listener is registered/u);
		strictEqual(verdict.deniedPark, true);
		strictEqual(verdict.decision.classification.actionClass, "system_modify");
		strictEqual(registry.hasParkedCalls(), false);
		strictEqual(existsSync(join(base, "escape.txt")), false);
	});

	it("parks as before when a listener is registered, and runs the call once approved", async () => {
		const registry = autoEditRegistry();
		const asked: Array<{ actionClass: string; requestId: string }> = [];
		registry.onPermissionRequired((_call, decision, meta) => {
			asked.push({ actionClass: decision.classification.actionClass, requestId: meta.requestId });
		});
		const verdict = registry.invoke({ tool: ToolNames.Write, args: { path: "data/out.txt", content: "x" } });
		strictEqual(await settledWithin(verdict, 50), "pending");
		strictEqual(registry.parkedCount(), 1);
		strictEqual(asked.length, 1);
		strictEqual(asked[0]?.actionClass, "system_modify");
		await registry.resumeParkedCalls({
			actionClass: "system_modify",
			requestId: asked[0]?.requestId as string,
			requestedBy: "contract-operator",
		});
		strictEqual((await verdict).kind, "ok");
		strictEqual(existsSync(join(base, "escape.txt")), true);
	});
});
