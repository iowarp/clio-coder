import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { acceptanceFromTaskFlags } from "../../src/cli/tasks.js";
import { normalizeDispatchIntent } from "../../src/domains/dispatch/intent.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import { createFinishContractRegistration } from "../../src/domains/safety/finish-contract-registration.js";
import {
	createTaskBoardStore,
	foldTaskBoard,
	type TaskLedgerEntryFields,
} from "../../src/domains/session/task-board.js";
import type { UserTaskAcceptance } from "../../src/domains/user-tasks/acceptance.js";
import { activeUserTaskAcceptance } from "../../src/domains/user-tasks/active-acceptance.js";
import { createUserTasksStore, UserTasksStoreError } from "../../src/domains/user-tasks/store.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";
import { createTasksTool } from "../../src/tools/tasks.js";

const acceptance: UserTaskAcceptance = {
	expectedOutputs: ["src/solver.ts"],
	verification: [
		{ check: "test:solver", timeoutMs: 60000 },
		{ check: "lint", timeoutMs: 1000 },
	],
};
const timestamp = "2026-09-05T12:00:00.000Z";
const base = { timestamp, parentTurnId: null };
function call(id: string, name: string, args: Record<string, unknown>) {
	return { ...base, kind: "message", role: "tool_call", turnId: id, payload: { name, toolCallId: id, args } };
}
function result(id: string, isError = false, details?: Record<string, unknown>) {
	return {
		...base,
		kind: "message",
		role: "tool_result",
		turnId: `${id}-result`,
		payload: {
			toolCallId: id,
			isError,
			...(details ? { toolName: "verify" } : {}),
			result: { kind: isError ? "error" : "ok", details },
		},
	};
}
function mutation() {
	return [call("write", "write", { path: "src/solver.ts", content: "fixed" }), result("write")];
}
function passed(check: string) {
	return [
		call(check, "verify", { check }),
		result(check, false, {
			check,
			source: { kind: "package.json", path: "/workspace/package.json" },
			cwd: "/workspace",
			argv: ["npm", "run", check],
			exitCode: 0,
		}),
	];
}
function limited(paths: string[], error = false) {
	return [
		call("lim", "limitation", { scope: "Cannot run tests here", reason: "environment", paths }),
		result("lim", error),
	];
}
function project(run: (cwd: string) => void) {
	const cwd = mkdtempSync(join(tmpdir(), "task-acceptance-"));
	try {
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({
				scripts: { "test:solver": "node solver.test.js", lint: "lint", custom: "custom", "check:12": "check" },
			}),
		);
		run(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("operator task acceptance", () => {
	it("normalizes with dispatch rules, persists, validates updates, and returns detached arrays", () =>
		project((cwd) => {
			const store = createUserTasksStore({ cwd });
			const raw = {
				expectedOutputs: [" ./src//solver.ts ", "src/solver.ts"],
				verification: [{ check: " lint ", timeoutMs: 1 }],
			};
			const task = store.add(" fix solver ", " note ", raw);
			const dispatch = normalizeDispatchIntent(
				{ expected_outputs: raw.expectedOutputs, verification: [{ check: " lint ", timeout_ms: 1 }] },
				new Map([["lint", { id: "lint", timeoutMs: 1000 }]]),
			);
			ok(dispatch.ok);
			deepStrictEqual(task.acceptance, {
				expectedOutputs: dispatch.intent.expectedOutputs,
				verification: dispatch.intent.verification,
			});
			ok(task.acceptance);
			task.acceptance.expectedOutputs.push("mutated");
			const check = task.acceptance.verification[0];
			ok(check);
			check.check = "mutated";
			deepStrictEqual(createUserTasksStore({ cwd }).get(task.id)?.acceptance?.expectedOutputs, ["src/solver.ts"]);
			strictEqual(store.get(task.id)?.acceptance?.verification[0]?.check, "lint");
			store.setAcceptance(task.id, acceptance);
			deepStrictEqual(store.get(task.id)?.acceptance, acceptance);
			const before = readFileSync(store.path, "utf8");
			for (const bad of [
				{ expectedOutputs: ["../escape"], verification: [] },
				{ expectedOutputs: ["/absolute"], verification: [] },
				{ expectedOutputs: [], verification: [{ check: "", timeoutMs: 1000 }] },
				{ expectedOutputs: [], verification: [{ check: "lint", timeoutMs: -1 }] },
				{ expectedOutputs: [], verification: Array.from({ length: 9 }, () => ({ check: "lint", timeoutMs: 1000 })) },
				{ expectedOutputs: [], verification: [], extra: true },
			]) {
				throws(() => store.add("bad", undefined, bad), UserTasksStoreError);
				throws(() => store.setAcceptance(task.id, bad), UserTasksStoreError);
				strictEqual(readFileSync(store.path, "utf8"), before);
			}
			throws(() => store.setAcceptance("u99", acceptance), /not found/);
			const file = JSON.parse(before);
			file.tasks[0].acceptance.expectedOutputs = ["../escape"];
			writeFileSync(store.path, JSON.stringify(file));
			throws(() => store.snapshot(), /schema validation/);
		}));

	it("admits catalog and package ids, resolves colon ids, bounds timeouts, and refuses unknown ids including none", () =>
		project((cwd) => {
			mkdirSync(join(cwd, ".clio-coder"));
			writeFileSync(
				join(cwd, ".clio-coder/verifiers.yaml"),
				"version: 1\nchecks:\n  - id: solver-oracle\n    description: Solver oracle\n    command: [node, oracle.js]\n    cwd: .\n    timeoutMs: 5000\n    tags: []\n",
			);
			const parsed = acceptanceFromTaskFlags(
				cwd,
				["./src/solver.ts"],
				["solver-oracle:9000", "test:solver:1", "check:12", "custom"],
			);
			deepStrictEqual(
				parsed?.verification.map((item) => item.check),
				["solver-oracle", "test:solver", "check:12", "custom"],
			);
			strictEqual(parsed?.verification[0]?.timeoutMs, 5000);
			strictEqual(parsed?.verification[1]?.timeoutMs, 1000);
			for (const id of ["unknown", "none"])
				throws(() => acceptanceFromTaskFlags(cwd, [], [id]), /Known ids:.*lint.*solver-oracle.*test:solver/);
		}));

	it("the actual CLI refuses unknown ids without writing and accepts repeated flags", () =>
		project((cwd) => {
			const cli = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
			const run = (...args: string[]) =>
				spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "tasks", ...args], {
					cwd,
					encoding: "utf8",
					timeout: 30000,
				});
			const refused = run("add", "Fix solver", "--verify", "missing");
			strictEqual(refused.status, 1, refused.stderr);
			match(refused.stderr, /Known ids:.*lint.*test:solver/);
			const store = createUserTasksStore({ cwd });
			deepStrictEqual(store.snapshot(), []);
			const added = run(
				"add",
				"Fix solver",
				"--expect",
				"src/solver.ts",
				"--expect",
				"test/solver.ts",
				"--verify",
				"test:solver:60000",
				"--verify",
				"lint:1000",
			);
			strictEqual(added.status, 0, added.stderr);
			deepStrictEqual(store.get("u1")?.acceptance, {
				...acceptance,
				expectedOutputs: ["src/solver.ts", "test/solver.ts"],
			});
		}));

	it("slash grammar recognizes repeated flags before and after task text", () => {
		deepStrictEqual(
			parseSlashCommand(
				"/tasks add --expect src/solver.ts Fix solver --verify test:solver:60000 --expect test/solver.ts --verify lint",
			),
			{
				kind: "tasks-add",
				text: "Fix solver",
				expectedOutputs: ["src/solver.ts", "test/solver.ts"],
				verification: ["test:solver:60000", "lint"],
			},
		);
		strictEqual(parseSlashCommand("/tasks add Fix solver --verify").kind, "usage-error");
	});

	it("hand and pick seed required ledger evidence that survives start, done, and folding", async () => {
		let body: string | undefined;
		const userTasks = createUserTasksStore({
			cwd: "/virtual",
			exists: () => body !== undefined,
			read: () => body ?? "",
			write: (_path, value) => {
				body = value;
			},
		});
		const entries: unknown[] = [];
		const board = createTaskBoardStore({
			getSessionId: () => "s1",
			createBoardId: () => "b1",
			appendEntry: (entry: TaskLedgerEntryFields) => {
				entries.push({ ...base, turnId: `ledger-${entries.length}`, ...entry });
			},
		});
		const tool = createTasksTool({ board, userTasks, getSessionId: () => "s1" });
		const task = userTasks.add("Fix solver", undefined, acceptance);
		userTasks.hand(task.id, "s1");
		const pickup = await tool.run({ action: "pick", id: task.id });
		ok(pickup.kind === "ok");
		match(pickup.output, /expected outputs: src\/solver.ts/);
		const required = board.snapshot()?.tasks[0]?.requiredValidationEvidence;
		deepStrictEqual(
			required?.map((item) => [item.command, item.status, item.notes]),
			[
				["test:solver", "pending", "timeoutMs=60000"],
				["lint", "pending", "timeoutMs=1000"],
			],
		);
		deepStrictEqual(foldTaskBoard(entries)?.tasks[0]?.requiredValidationEvidence, required);
		deepStrictEqual(activeUserTaskAcceptance(userTasks.snapshot(), board.snapshot(), "s1", []), acceptance);
		strictEqual(activeUserTaskAcceptance(userTasks.snapshot(), board.snapshot(), "other", []), undefined);
		await tool.run({ action: "start", id: "t1" });
		await tool.run({ action: "done", id: "t1", note: "I finished" });
		deepStrictEqual(foldTaskBoard(entries)?.tasks[0]?.requiredValidationEvidence, required);
		strictEqual(activeUserTaskAcceptance(userTasks.snapshot(), board.snapshot(), "s1", []), undefined);
		const window = [call("done", "tasks", { action: "done", id: "t1" })];
		deepStrictEqual(activeUserTaskAcceptance(userTasks.snapshot(), board.snapshot(), "s1", window), acceptance);
	});
});

describe("high-rigor acceptance finish contract", () => {
	const assess = (entries: unknown[]) =>
		assessFinishContract({
			sessionEntries: entries,
			rigor: "high",
			activeAcceptance: acceptance,
			workspaceRoot: "/workspace",
		});
	it("requires every check, accepts mixed passing and named limitation receipts, and ignores prose or unrelated evidence", () => {
		strictEqual(assess([...mutation(), ...passed("test:solver"), ...passed("lint")]).reason, "validation_evidence");
		strictEqual(assess([...mutation(), ...passed("test:solver")]).kind, "engage");
		strictEqual(assess([...mutation(), ...passed("test:solver"), ...limited(["lint"])]).reason, "explicit_limitation");
		strictEqual(assess([...mutation(), ...limited(["test:solver", "lint"])]).reason, "explicit_limitation");
		strictEqual(assess([...mutation(), ...limited(["src/solver.ts"])]).kind, "engage");
		strictEqual(assess([...mutation(), ...limited(["test:solver", "lint"], true)]).kind, "engage");
		strictEqual(assess([...mutation(), ...passed("test:solver-extra"), ...passed("lint")]).kind, "engage");
		strictEqual(
			assess([...mutation(), call("test", "verify", { check: "test:solver" }), result("test", true), ...passed("lint")])
				.kind,
			"engage",
		);
		strictEqual(
			assess([...mutation(), { kind: "protectedArtifact", action: "protect", artifact: { path: "src/solver.ts" } }]).kind,
			"engage",
		);
	});
	it("counts npm check receipts and respects the user-message window and rigor", () => {
		const commands = [
			call("test", "bash", { command: "npm run test:solver" }),
			result("test"),
			{ kind: "bashExecution", command: "npm run lint", exitCode: 0 },
		];
		strictEqual(assess([...mutation(), ...commands]).reason, "validation_evidence");
		strictEqual(
			assess([...commands, { kind: "message", role: "user", payload: { text: "next" } }, ...mutation()]).kind,
			"engage",
		);
		strictEqual(assess([...passed("lint")]).reason, "no_mutation");
		strictEqual(
			assessFinishContract({
				sessionEntries: [...mutation(), ...passed("lint")],
				rigor: "normal",
				activeAcceptance: acceptance,
			}).kind,
			"ok",
		);
	});
	it("requires execution identity and respects the acceptance timeout for each requirement", () => {
		strictEqual(
			assess([
				...mutation(),
				call("test:solver", "verify", { check: "test:solver" }),
				result("test:solver"),
				...passed("lint"),
			]).kind,
			"engage",
		);
		const entries = [...mutation(), ...passed("test:solver"), ...passed("lint")];
		strictEqual(
			assessFinishContract({ sessionEntries: entries, rigor: "high", activeAcceptance: acceptance }).kind,
			"engage",
		);
		const run = result("test:solver", false, {
			check: "test:solver",
			source: { kind: "package.json", path: "/workspace/package.json" },
			cwd: "/workspace",
			argv: ["npm", "run", "test:solver"],
			exitCode: 0,
			durationMs: 2000,
		});
		const sessionEntries = [...mutation(), call("test:solver", "verify", { check: "test:solver" }), run];
		const activeAcceptance = {
			expectedOutputs: [],
			verification: [
				{ check: "test:solver", timeoutMs: 60000 },
				{ check: "test:solver", timeoutMs: 1000 },
			],
		};
		strictEqual(
			assessFinishContract({ sessionEntries, rigor: "high", activeAcceptance, workspaceRoot: "/workspace" }).kind,
			"engage",
		);
		strictEqual(
			assessFinishContract({
				sessionEntries: [...sessionEntries, ...limited(["test:solver"])],
				rigor: "high",
				activeAcceptance,
				workspaceRoot: "/workspace",
			}).reason,
			"explicit_limitation",
		);
	});
	it("admits a declared custom package script and refuses a nonzero receipt", () => {
		const activeAcceptance = { expectedOutputs: [], verification: [{ check: "custom", timeoutMs: 1000 }] };
		const sessionEntries = [...mutation(), call("custom", "bash", { command: "npm run custom" }), result("custom")];
		strictEqual(
			assessFinishContract({ sessionEntries, rigor: "high", activeAcceptance, workspaceRoot: "/workspace" }).reason,
			"validation_evidence",
		);
		const failed = {
			...base,
			kind: "message",
			role: "tool_result",
			turnId: "failed",
			payload: { toolCallId: "custom", result: { kind: "ok", details: { exitCode: 1 } } },
		};
		strictEqual(
			assessFinishContract({ sessionEntries: [...sessionEntries.slice(0, -1), failed], rigor: "high", activeAcceptance })
				.kind,
			"engage",
		);
	});
	it("production registration supplies acceptance and re-prompts with the missing ids", () => {
		const hook = createFinishContractRegistration({
			readSessionEntries: () => [...mutation(), ...passed("lint")],
			resolveRigor: () => "high",
			readActiveAcceptance: () => acceptance,
		});
		const effects = hook.evaluate({ hook: "turn_end", turnId: "assistant", text: "Done" });
		ok(Array.isArray(effects));
		ok(effects.some((effect) => effect.kind === "request_continuation" && effect.message.includes("test:solver")));
	});
});
