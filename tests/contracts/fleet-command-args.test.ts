import { deepStrictEqual, notStrictEqual, rejects, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { parseFleetCommands, resolveFleetCommandArgs } from "../../src/domains/agents/fleet-commands.js";
import { parseFleetContract, validateFleetCommands } from "../../src/domains/agents/fleet-contract.js";
import { runCodeStep } from "../../src/domains/dispatch/code-step.js";
import { compileFleetExecutionPlan } from "../../src/domains/dispatch/fleet-plan.js";

const raw = `---
version: 2
name: argument-fixture
description: Run a registered command with a task directory.
steps:
  - kind: code
    id: verify
    command: verify
    args: ["{{taskDir}}"]
    scope: readonly
    dependencies: []
maxWorkers: 1
onFailure: stop
---
Verify the task output.
`;

const parameterized = () =>
	parseFleetCommands(
		JSON.stringify({
			version: 1,
			commands: {
				verify: {
					argv: [process.execPath, "-e", "process.stdout.write('approved')", "--"],
					argumentSlots: [{ name: "taskDir", maxLength: 256 }],
				},
			},
		}),
		"/fixture/commands.yaml",
	);

it("seals resolved arguments into the execution plan and rejects missing variables before execution", () => {
	const contract = parseFleetContract(raw, "/fixture/fleet.md");
	const plan = (taskDir: string) =>
		compileFleetExecutionPlan({
			commands: parameterized(),
			contract,
			task: contract.body,
			vars: { taskDir },
			resolveAgent() {
				throw new Error("no agent");
			},
		});
	const first = plan("task-01").steps[0];
	deepStrictEqual(first?.kind === "code" ? first.args : undefined, ["task-01"]);
	notStrictEqual(plan("task-01").hash, plan("task-02").hash);
	throws(
		() =>
			compileFleetExecutionPlan({
				commands: parameterized(),
				contract,
				task: contract.body,
				resolveAgent() {
					throw new Error("no agent");
				},
			}),
		/missing variable/,
	);
	const registry = parseFleetCommands("version: 1\ncommands:\n  different: {argv: [echo]}\n", "/fixture/commands.yaml");
	throws(() => validateFleetCommands(contract, registry), /unknown command/);
});

it("accepts only bounded string argument vectors and whole-token variables", () => {
	throws(() => parseFleetContract(raw.replace('args: ["{{taskDir}}"]', 'args: "shell string"'), "/fixture/fleet.md"));
	throws(() => parseFleetContract(raw.replace('args: ["{{taskDir}}"]', "args: [17]"), "/fixture/fleet.md"));
	throws(() => resolveFleetCommandArgs(["--path={{taskDir}}"], { taskDir: "x" }), /whole argument/);
	throws(() => resolveFleetCommandArgs(["{{taskDir}}"], { taskDir: "x\0y" }), /NUL/);
	throws(() => resolveFleetCommandArgs(Array(65).fill("x")), /64/);
	deepStrictEqual(resolveFleetCommandArgs(["{{taskDir}}", ""], { taskDir: "a b; $(echo secret)" }), [
		"a b; $(echo secret)",
		"",
	]);
});

it("passes shell metacharacters and placeholder-looking values as literal argv exactly once", async () => {
	const workspaceRoot = mkdtempSync(join(tmpdir(), "clio-fleet-args-"));
	try {
		const command = {
			id: "echo-json",
			argumentSlots: [
				{ name: "taskDir", maxLength: 256 },
				{ name: "label", maxLength: 32 },
			],
			argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--"],
			cwd: "",
			timeoutMs: 10000,
			env: [],
			description: "argument fixture",
		};
		const args = resolveFleetCommandArgs(["{{taskDir}}", "literal"], { taskDir: "a b; $(touch impossible) {{unbound}}" });
		const result = await runCodeStep({ command, stepId: "verify", workspaceRoot, args });
		strictEqual(result.record.exitCode, 0);
		deepStrictEqual(JSON.parse(result.stdout), args);
		deepStrictEqual(result.record.argv.slice(-2), args);
		await rejects(runCodeStep({ command, stepId: "invalid", workspaceRoot, args: ["bad\0arg"] }), /invalid additional/);
	} finally {
		rmSync(workspaceRoot, { recursive: true, force: true });
	}
});

it("binds the same literal argument vector into every unrolled loop check", () => {
	const contract = parseFleetContract(
		`---
version: 3
name: loop-argument-fixture
description: Recheck one task after repair.
steps:
  - kind: loop
    id: check
    maxAttempts: 2
    dependencies: []
    check: {kind: code, command: verify, args: ["{{taskDir}}"], scope: readonly}
    repair: {kind: agent, agent: coder, scope: workspace}
maxWorkers: 1
onFailure: stop
---
Verify task output.
`,
		"/fixture/loop.md",
	);
	const plan = compileFleetExecutionPlan({
		commands: parameterized(),
		contract,
		task: contract.body,
		vars: { taskDir: "task-03" },
		resolveAgent() {
			return {
				requestedAuthority: "workspace-edit",
				approvedAuthority: "workspace-edit",
				expectedResultContract: "mutation-report",
				executionRole: "builder",
			};
		},
	});
	deepStrictEqual(
		plan.steps.filter((step) => step.kind === "code").map((step) => step.args),
		[["task-03"], ["task-03"]],
	);
});

it("keeps legacy commands fixed and rejects eval flags before admission and direct execution", async () => {
	const workspaceRoot = mkdtempSync(join(tmpdir(), "clio-fixed-command-"));
	try {
		const marker = join(workspaceRoot, "changed-authority.txt");
		const registry = parseFleetCommands(
			JSON.stringify({
				version: 1,
				commands: { verify: { argv: [process.execPath, "-e", "process.stdout.write('approved fixed check')"] } },
			}),
			"/fixture/commands.yaml",
		);
		const contract = parseFleetContract(raw, "/fixture/fleet.md");
		throws(() => validateFleetCommands(contract, registry), /expected 0 declared argument slots/);
		throws(
			() =>
				compileFleetExecutionPlan({
					commands: registry,
					contract,
					task: contract.body,
					vars: { taskDir: "--eval" },
					resolveAgent() {
						throw new Error("unused");
					},
				}),
			/expected 0 declared argument slots/,
		);
		const command = registry.commands.get("verify");
		if (!command) throw new Error("fixture command missing");
		await rejects(
			runCodeStep({
				command,
				stepId: "attack",
				workspaceRoot,
				args: ["--eval", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
			}),
			/expected 0 declared argument slots/,
		);
		strictEqual(existsSync(marker), false);
		const result = await runCodeStep({ command, stepId: "fixed", workspaceRoot });
		strictEqual(result.stdout, "approved fixed check");
		const optedIn = { ...command, argumentSlots: [{ name: "taskDir", maxLength: 12 }] };
		await rejects(runCodeStep({ command: optedIn, stepId: "flag", workspaceRoot, args: ["--eval"] }), /leading dash/);
		await rejects(runCodeStep({ command: optedIn, stepId: "long", workspaceRoot, args: ["x".repeat(13)] }), /at most 12/);
		throws(() => validateFleetCommands(contract, parameterized(), { taskDir: "--eval" }), /leading dash/);
	} finally {
		rmSync(workspaceRoot, { recursive: true, force: true });
	}
});
