import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createHookReceiptLog,
	type HookReceipt,
	installUserHooks,
	loadUserHooks,
	type MiddlewareHookInput,
	type MiddlewareHookRegistration,
	normalizeUserHook,
	runMiddlewareRegistrations,
	spawnSyncCommandRunner,
	USER_HOOK_COMMAND_OUTPUT_MAX_CHARS,
	type UserHookCommandResult,
	type UserHookDeclarationBatch,
	type UserHookSource,
	userHookToRegistration,
} from "../../src/domains/middleware/index.js";

const WORKSPACE = "/work/repo";
const PROJECT: UserHookSource = { origin: "project", sourcePath: ".clio/hooks.yaml" };

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-hooks-"));
	dirs.push(dir);
	return dir;
}

function beforeToolInput(toolName?: string): MiddlewareHookInput {
	return { hook: "before_tool", ...(toolName !== undefined ? { toolName } : {}) };
}

describe("contracts/middleware user-hook normalization", () => {
	it("normalizes a prompt hook with source attribution and a stable hash", () => {
		const result = normalizeUserHook({ on: "turn_start", kind: "prompt", message: "Remember the style guide" }, PROJECT, {
			workspaceRoot: WORKSPACE,
		});
		ok(result.hook, result.issues.join("; "));
		strictEqual(result.hook.spec.kind, "prompt");
		strictEqual(result.hook.source.origin, "project");
		strictEqual(result.hook.hash.length, 16);
		// The hash is content-derived and stable across identical declarations.
		const again = normalizeUserHook({ on: "turn_start", kind: "prompt", message: "Remember the style guide" }, PROJECT, {
			workspaceRoot: WORKSPACE,
		});
		strictEqual(again.hook?.hash, result.hook.hash);
	});

	it("rejects malformed hooks with reasons and without throwing", () => {
		const badKind = normalizeUserHook({ on: "turn_start", kind: "exec" }, PROJECT, { workspaceRoot: WORKSPACE });
		strictEqual(badKind.hook, undefined);
		ok(badKind.issues.some((issue) => issue.includes("kind")));

		const badHook = normalizeUserHook({ on: "whenever", kind: "prompt", message: "x" }, PROJECT, {
			workspaceRoot: WORKSPACE,
		});
		strictEqual(badHook.hook, undefined);

		const escaping = normalizeUserHook({ on: "before_tool", kind: "command", argv: ["ls"], cwd: "../../etc" }, PROJECT, {
			workspaceRoot: WORKSPACE,
		});
		strictEqual(escaping.hook, undefined);
		ok(escaping.issues.some((issue) => issue.includes("workspace")));

		const emptyArgv = normalizeUserHook({ on: "before_tool", kind: "command", argv: [] }, PROJECT, {
			workspaceRoot: WORKSPACE,
		});
		strictEqual(emptyArgv.hook, undefined);
	});

	it("clamps a command timeout into the allowed window", () => {
		const result = normalizeUserHook(
			{ on: "before_tool", kind: "command", argv: ["true"], timeoutMs: 999_999 },
			PROJECT,
			{ workspaceRoot: WORKSPACE },
		);
		ok(result.hook);
		strictEqual(result.hook.spec.kind, "command");
		if (result.hook.spec.kind === "command") strictEqual(result.hook.spec.timeoutMs, 5_000);
	});

	it("defaults command cwd to the workspace root", () => {
		const result = normalizeUserHook({ on: "before_tool", kind: "command", argv: ["pwd"] }, PROJECT, {
			workspaceRoot: WORKSPACE,
		});
		ok(result.hook, result.issues.join("; "));
		strictEqual(result.hook.spec.kind, "command");
		if (result.hook.spec.kind === "command") strictEqual(result.hook.spec.cwd, WORKSPACE);
	});
});

describe("contracts/middleware user-hook loading and precedence", () => {
	it("keeps the highest-precedence hook on an id collision and records the loser", () => {
		const batches: UserHookDeclarationBatch[] = [
			{
				source: { origin: "extension", sourcePath: "ext:hooks.yaml", sourceId: "ext" },
				declarations: [{ id: "lint", on: "turn_end", kind: "prompt", message: "extension" }],
			},
			{
				source: PROJECT,
				declarations: [{ id: "lint", on: "turn_end", kind: "prompt", message: "project" }],
			},
		];
		const result = loadUserHooks(batches, { workspaceRoot: WORKSPACE });
		strictEqual(result.hooks.length, 1);
		strictEqual(result.hooks[0]?.source.origin, "project");
		strictEqual(result.overridden.length, 1);
		strictEqual(result.overridden[0]?.loser.source.origin, "extension");
	});

	it("collects issues for malformed declarations without dropping valid siblings", () => {
		const result = loadUserHooks(
			[
				{
					source: PROJECT,
					declarations: [
						{ on: "turn_start", kind: "prompt", message: "ok" },
						{ on: "turn_start", kind: "bogus" },
					],
				},
			],
			{ workspaceRoot: WORKSPACE },
		);
		strictEqual(result.hooks.length, 1);
		strictEqual(result.issues.length, 1);
		strictEqual(result.issues[0]?.index, 1);
	});
});

describe("contracts/middleware user-hook execution and receipts", () => {
	function registrationFor(raw: unknown, receipts: HookReceipt[], runCommand = okRunner): MiddlewareHookRegistration {
		const normalized = normalizeUserHook(raw, PROJECT, { workspaceRoot: WORKSPACE });
		ok(normalized.hook, normalized.issues.join("; "));
		return userHookToRegistration(normalized.hook, {
			recordReceipt: (receipt) => receipts.push(receipt),
			runCommand,
			now: () => 1_000,
		});
	}

	const okRunner = (): UserHookCommandResult => ({ code: 0, timedOut: false, stdout: "lint clean", stderr: "" });

	it("emits an inject_reminder and a receipt for a prompt hook", () => {
		const receipts: HookReceipt[] = [];
		const registration = registrationFor({ on: "turn_start", kind: "prompt", message: "stay focused" }, receipts);
		const result = runMiddlewareRegistrations({ hook: "turn_start" }, [registration]);
		deepStrictEqual(result.effects, [{ kind: "inject_reminder", message: "stay focused" }]);
		strictEqual(receipts.length, 1);
		strictEqual(receipts[0]?.outcome, "emitted");
		deepStrictEqual(receipts[0]?.effectKinds, ["inject_reminder"]);
	});

	it("passes an effect hook through verbatim and receipts the effect kind", () => {
		const receipts: HookReceipt[] = [];
		const registration = registrationFor(
			{ on: "before_tool", kind: "effect", effect: { kind: "block_tool", reason: "frozen", severity: "hard-block" } },
			receipts,
		);
		const result = runMiddlewareRegistrations(beforeToolInput("Bash"), [registration]);
		strictEqual(result.effects[0]?.kind, "block_tool");
		strictEqual(receipts[0]?.effectKinds?.[0], "block_tool");
	});

	it("runs a command hook, bounds output into an effect, and receipts the exit code", () => {
		const receipts: HookReceipt[] = [];
		const registration = registrationFor({ on: "before_tool", kind: "command", argv: ["lint"] }, receipts);
		const result = runMiddlewareRegistrations(beforeToolInput("Bash"), [registration]);
		strictEqual(result.effects[0]?.kind, "annotate_tool_result");
		strictEqual(receipts[0]?.outcome, "command-ok");
		strictEqual(receipts[0]?.exitCode, 0);
	});

	it("truncates oversized command output before injecting it", () => {
		const receipts: HookReceipt[] = [];
		const output = "x".repeat(USER_HOOK_COMMAND_OUTPUT_MAX_CHARS + 50);
		const registration = registrationFor({ on: "before_tool", kind: "command", argv: ["verbose"] }, receipts, () => ({
			code: 0,
			timedOut: false,
			stdout: output,
			stderr: "",
		}));
		const result = runMiddlewareRegistrations(beforeToolInput("Bash"), [registration]);
		strictEqual(result.effects[0]?.kind, "annotate_tool_result");
		if (result.effects[0]?.kind === "annotate_tool_result") {
			strictEqual(result.effects[0].message.length, USER_HOOK_COMMAND_OUTPUT_MAX_CHARS);
		}
		strictEqual(receipts[0]?.outputChars, output.length);
	});

	it("runs production command hooks without a shell", () => {
		const dir = scratch();
		const result = spawnSyncCommandRunner()(
			[process.execPath, "-e", "console.log(process.argv[1])", "literal;echo shell-ran"],
			{ cwd: dir, timeoutMs: 1_000 },
		);
		strictEqual(result.code, 0);
		strictEqual(result.stdout.trim(), "literal;echo shell-ran");
	});

	it("receipts a command timeout and emits no effect", () => {
		const receipts: HookReceipt[] = [];
		const timeoutRunner = (): UserHookCommandResult => ({ code: null, timedOut: true, stdout: "", stderr: "" });
		const registration = registrationFor(
			{ on: "before_tool", kind: "command", argv: ["sleep"] },
			receipts,
			timeoutRunner,
		);
		const result = runMiddlewareRegistrations(beforeToolInput("Bash"), [registration]);
		strictEqual(result.effects.length, 0);
		strictEqual(receipts[0]?.outcome, "command-timeout");
	});

	it("only fires on the declared hook and tool", () => {
		const receipts: HookReceipt[] = [];
		const registration = userHookToRegistration(
			normalizeUserHook({ on: "before_tool", tools: ["Bash"], kind: "prompt", message: "careful" }, PROJECT, {
				workspaceRoot: WORKSPACE,
			}).hook ?? raise("normalize failed"),
			{ recordReceipt: (receipt) => receipts.push(receipt), runCommand: okRunner },
		);
		strictEqual(runMiddlewareRegistrations(beforeToolInput("Read"), [registration]).effects.length, 0);
		strictEqual(runMiddlewareRegistrations({ hook: "turn_start" }, [registration]).effects.length, 0);
		strictEqual(runMiddlewareRegistrations(beforeToolInput("Bash"), [registration]).effects.length, 1);
	});
});

describe("contracts/middleware hook receipt log", () => {
	it("rings to capacity and persists atomically through safeResourceWrite", () => {
		const dir = scratch();
		const persistPath = join(dir, "hook-receipts.json");
		const log = createHookReceiptLog({ capacity: 2, persistPath, throttleMs: 0 });
		const receipt = (id: string): HookReceipt => ({
			at: 1,
			hookId: id,
			origin: "project",
			sourcePath: ".clio/hooks.yaml",
			hash: "abc",
			hook: "turn_start",
			kind: "prompt",
			outcome: "emitted",
		});
		log.record(receipt("a"));
		log.record(receipt("b"));
		log.record(receipt("c"));
		const listed = log.list();
		strictEqual(listed.length, 2);
		deepStrictEqual(
			listed.map((entry) => entry.hookId),
			["b", "c"],
		);
		ok(existsSync(persistPath));
		const persisted = JSON.parse(readFileSync(persistPath, "utf8")) as { receipts: HookReceipt[] };
		strictEqual(persisted.receipts.length, 2);
	});
});

describe("contracts/middleware install from disk", () => {
	it("reads project hook files, registers them, and surfaces file issues", () => {
		const dir = scratch();
		mkdirSync(join(dir, ".clio"), { recursive: true });
		writeFileSync(
			join(dir, ".clio", "hooks.yaml"),
			"- on: turn_start\n  kind: prompt\n  message: project hook\n",
			"utf8",
		);
		writeFileSync(join(dir, ".clio", "hooks.local.yaml"), ": not valid yaml :\n  - [", "utf8");
		const registrations: MiddlewareHookRegistration[] = [];
		const receipts: HookReceipt[] = [];
		const result = installUserHooks({
			cwd: dir,
			registerHook: (registration) => registrations.push(registration),
			recordReceipt: (receipt) => receipts.push(receipt),
			runCommand: () => ({ code: 0, timedOut: false, stdout: "", stderr: "" }),
		});
		strictEqual(result.hooks.length, 1);
		strictEqual(registrations.length, 1);
		ok(result.fileIssues.length >= 1, "malformed local file should be reported");
		const fired = runMiddlewareRegistrations({ hook: "turn_start" }, registrations);
		strictEqual(fired.effects[0]?.kind, "inject_reminder");
		strictEqual(receipts[0]?.origin, "project");
	});
});

function raise(message: string): never {
	throw new Error(message);
}
