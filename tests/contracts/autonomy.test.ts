import { match, ok, strictEqual } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { ActionClass } from "../../src/domains/safety/action-classifier.js";
import {
	AUTONOMY_LEVELS,
	type AutonomyDisposition,
	type AutonomyLevel,
	mapAutonomy,
} from "../../src/domains/safety/autonomy.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import { AcpToolMediator } from "../../src/engine/acp/tool-mediator.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { approvalParkedNotice, autonomyDeniedNotice } from "../../src/interactive/bus-notices.js";
import { askAxis, createPermissionOverlayBody } from "../../src/interactive/permission-overlay.js";
import { createRegistry, type ToolRegistry, type ToolSpec } from "../../src/tools/registry.js";

function mockSpec(name: string, baseActionClass: ActionClass): ToolSpec {
	return {
		name: name as ToolName,
		description: "autonomy test tool",
		parameters: Type.Object({}),
		baseActionClass,
		run: async () => ({ kind: "ok", output: "ran" }),
	};
}

function registryAt(level: AutonomyLevel): ToolRegistry {
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd: process.cwd() }),
		autonomy: () => level,
	});
	registry.register(mockSpec(ToolNames.Read, "read"));
	registry.register(mockSpec(ToolNames.Write, "write"));
	registry.register(mockSpec(ToolNames.Bash, "execute"));
	registry.register(mockSpec(ToolNames.Dispatch, "dispatch"));
	return registry;
}

const bashCall = (command: string) => ({ tool: ToolNames.Bash, args: { command } });
const writeCall = (filePath: string) => ({ tool: ToolNames.Write, args: { file_path: filePath, content: "x" } });

async function settle(): Promise<void> {
	await Promise.resolve();
}

describe("contracts/autonomy mapping matrix", () => {
	// The §2.3 matrix, verbatim: every action class at every level.
	const expected: Record<string, Record<AutonomyLevel, AutonomyDisposition>> = {
		read: { "read-only": "allow", suggest: "allow", "auto-edit": "allow", "full-auto": "allow" },
		write: { "read-only": "deny", suggest: "ask", "auto-edit": "allow", "full-auto": "allow" },
		"execute:recognized": { "read-only": "deny", suggest: "ask", "auto-edit": "allow", "full-auto": "allow" },
		"execute:unrecognized": { "read-only": "deny", suggest: "ask", "auto-edit": "ask", "full-auto": "allow" },
		dispatch: { "read-only": "deny", suggest: "ask", "auto-edit": "allow", "full-auto": "allow" },
		system_modify: { "read-only": "deny", suggest: "ask", "auto-edit": "ask", "full-auto": "ask" },
		git_destructive: { "read-only": "deny", suggest: "deny", "auto-edit": "deny", "full-auto": "deny" },
		unknown: { "read-only": "deny", suggest: "ask", "auto-edit": "ask", "full-auto": "ask" },
	};

	it("maps every action class at every level per the sd-01 §2.3 matrix", () => {
		for (const [row, byLevel] of Object.entries(expected)) {
			const [actionClass, recognition] = row.split(":") as [ActionClass, string | undefined];
			const options = actionClass === "execute" ? { executeRecognized: recognition === "recognized" } : {};
			for (const level of AUTONOMY_LEVELS) {
				strictEqual(
					mapAutonomy(level, actionClass, options),
					byLevel[level],
					`expected ${row} at ${level} to be ${byLevel[level]}`,
				);
			}
		}
	});
});

describe("contracts/autonomy registry admission", () => {
	it("read-only auto-denies mutations with the propose-instead rejection and never parks", async () => {
		const registry = registryAt("read-only");
		const verdict = await registry.invoke(writeCall("notes/autonomy-test.txt"));
		strictEqual(verdict.kind, "blocked");
		ok(verdict.kind === "blocked" && verdict.reason.includes("autonomy level is read-only"));
		strictEqual(registry.hasParkedCalls(), false);

		const read = await registry.invoke({ tool: ToolNames.Read, args: { file_path: "README.md" } });
		strictEqual(read.kind, "ok");
	});

	it("suggest parks every mutation for approval", async () => {
		const registry = registryAt("suggest");
		let asked = 0;
		registry.onPermissionRequired(() => {
			asked += 1;
		});
		const pending = registry.invoke(writeCall("notes/autonomy-test.txt"));
		await settle();
		strictEqual(registry.hasParkedCalls(), true);
		strictEqual(asked, 1);
		registry.cancelParkedCalls("operator declined");
		const verdict = await pending;
		strictEqual(verdict.kind, "blocked");
	});

	it("auto-edit runs writes and recognized commands, parks unrecognized bash, and a one-shot grant resumes it", async () => {
		const registry = registryAt("auto-edit");
		strictEqual((await registry.invoke(writeCall("notes/autonomy-test.txt"))).kind, "ok");
		strictEqual((await registry.invoke(bashCall("git status"))).kind, "ok");
		strictEqual((await registry.invoke({ tool: ToolNames.Dispatch, args: {} })).kind, "ok");

		const pending = registry.invoke(bashCall("echo hello"));
		await settle();
		strictEqual(registry.hasParkedCalls(), true);
		await registry.resumeParkedCalls({ actionClass: "execute", requestedBy: "test" });
		strictEqual((await pending).kind, "ok");
	});

	it("full-auto runs unrecognized bash but system_modify still asks and net rails still block", async () => {
		const registry = registryAt("full-auto");
		strictEqual((await registry.invoke(bashCall("echo hello"))).kind, "ok");

		// Net block, level-independent (I2a stance; I3 revisits operators).
		const operators = await registry.invoke(bashCall("echo a && echo b"));
		strictEqual(operators.kind, "blocked");

		// Damage-control block rule through the net.
		const destructive = await registry.invoke(bashCall("rm -rf src"));
		strictEqual(destructive.kind, "blocked");

		// system_modify asks at every level above read-only.
		const pendingSudo = registry.invoke(bashCall("sudo ls /root"));
		await settle();
		strictEqual(registry.hasParkedCalls(), true);
		registry.cancelParkedCalls("operator declined");
		strictEqual((await pendingSudo).kind, "blocked");
	});

	it("honors M3: an authored git ask rule parks and a git_destructive grant resumes it", async () => {
		const registry = registryAt("full-auto");
		const pending = registry.invoke(bashCall("git stash drop"));
		await settle();
		strictEqual(registry.hasParkedCalls(), true);
		await registry.resumeParkedCalls({ actionClass: "git_destructive", requestedBy: "test" });
		strictEqual((await pending).kind, "ok");

		// Block rules and classifier escalation stay terminal even at full-auto.
		const force = await registry.invoke(bashCall("git push --force origin main"));
		strictEqual(force.kind, "blocked");
	});

	it("write targets outside the workspace escalate to system_modify and ask at full-auto", async () => {
		const registry = registryAt("full-auto");
		const pending = registry.invoke(writeCall(join(tmpdir(), "autonomy-escape.txt")));
		await settle();
		strictEqual(registry.hasParkedCalls(), true);
		registry.cancelParkedCalls("operator declined");
		strictEqual((await pending).kind, "blocked");
	});
});

describe("contracts/autonomy ask provenance: notices and overlay", () => {
	it("fires onAutonomyDenied at read-only and the [autonomy] notice names the level", async () => {
		const registry = registryAt("read-only");
		const denials: Array<{ decision: SafetyDecision; level: string }> = [];
		registry.onAutonomyDenied((_call, decision, level) => {
			denials.push({ decision, level });
		});
		await registry.invoke(writeCall("notes/autonomy-test.txt"));
		strictEqual(denials.length, 1);
		const denied = denials[0];
		ok(denied);
		strictEqual(denied.level, "read-only");
		strictEqual(
			autonomyDeniedNotice(denied.decision, denied.level).text,
			"[autonomy] denied write (read-only): Clio proposes changes at this level.",
		);
	});

	it("an autonomy ask names the level as the asking axis in notice and overlay", async () => {
		const registry = registryAt("auto-edit");
		const asks: SafetyDecision[] = [];
		registry.onPermissionRequired((_call, decision) => {
			asks.push(decision);
			registry.cancelParkedCalls("test done");
		});
		await registry.invoke(bashCall("echo hello"));
		const decision = asks[0];
		ok(decision);
		strictEqual(askAxis(decision).kind, "autonomy");

		const notice = approvalParkedNotice("bash", decision, "auto-edit");
		match(notice.text, /^\[approval\] bash parked \(execute\): asks at autonomy auto-edit\./);
		ok(notice.text.includes(".clio/safety.yaml"));

		const body = createPermissionOverlayBody(bashCall("echo hello"), decision, "auto-edit").render(60);
		ok(body.includes("Asked by: autonomy level (auto-edit)"), body.join("\n"));
	});

	it("a safety-net confirm rail names its rule as the asking axis even at full-auto", async () => {
		const registry = registryAt("full-auto");
		const asks: SafetyDecision[] = [];
		registry.onPermissionRequired((_call, decision) => {
			asks.push(decision);
			registry.cancelParkedCalls("test done");
		});
		await registry.invoke(bashCall("git stash drop"));
		const decision = asks[0];
		ok(decision);
		const axis = askAxis(decision);
		strictEqual(axis.kind, "net");
		ok(axis.kind === "net" && axis.ruleId.includes("stash"), JSON.stringify(axis));

		const notice = approvalParkedNotice("bash", decision, "full-auto");
		match(notice.text, /^\[approval\] bash parked \(git_destructive\): safety-net rail \S+ asks for confirmation\./);

		const body = createPermissionOverlayBody(bashCall("git stash drop"), decision, "full-auto").render(60);
		ok(
			body.some((line) => line.startsWith("Asked by: safety-net rail")),
			body.join("\n"),
		);
	});
});

describe("contracts/autonomy approvals contexts", () => {
	it("headless: an autonomy ask resolves as a deterministic deny when the context cancels parked calls", async () => {
		const registry = registryAt("auto-edit");
		const headlessReason = "clio run cannot confirm permission requests; rerun interactively to approve this action.";
		registry.onPermissionRequired(() => {
			registry.cancelParkedCalls(headlessReason);
		});
		const verdict = await registry.invoke(bashCall("echo hello"));
		strictEqual(verdict.kind, "blocked");
		ok(verdict.kind === "blocked" && verdict.reason === headlessReason);
	});

	it("worker: the worker registry inherits the spec autonomy level and routes asks to the permission seam", async () => {
		const registry = createWorkerToolRegistry(
			undefined,
			createWorkerSafety({ cwd: process.cwd() }),
			undefined,
			[],
			"suggest",
		);
		let askedTool: string | null = null;
		registry.onPermissionRequired((call) => {
			askedTool = call.tool;
			// worker-runtime.ts resolves this per workers.onPermission: "deny"
			// cancels and continues; "fail" cancels and aborts the run.
			registry.cancelParkedCalls("permission denied by policy: dispatched workers run non-interactively");
		});
		const verdict = await registry.invoke(writeCall(join(".clio", "test-scratch", "autonomy-worker.txt")));
		strictEqual(verdict.kind, "blocked");
		strictEqual(askedTool, ToolNames.Write);

		const fullAuto = createWorkerToolRegistry(
			undefined,
			createWorkerSafety({ cwd: process.cwd() }),
			undefined,
			[],
			"full-auto",
		);
		const echo = await fullAuto.invoke(bashCall("echo worker"));
		strictEqual(echo.kind, "ok");
	});

	it("delegation: clio-policy governance applies the level and asks resolve as non-stall denials", async () => {
		const safety = createWorkerSafety({ cwd: process.cwd() });

		const autoEdit = new AcpToolMediator({
			safety,
			cwd: process.cwd(),
			toolGovernance: "clio-policy",
			autonomy: "auto-edit",
		});
		await autoEdit.handle({
			options: [{ optionId: "reject", kind: "reject_once" }],
			toolCall: { toolCallId: "c1", kind: "execute", rawInput: { command: "echo hello" } },
		});
		strictEqual(autoEdit.snapshot().toolCallLog[0]?.decision, "denied");
		match(autoEdit.snapshot().toolCallLog[0]?.reason ?? "", /^permission_required: autonomy auto-edit/);
		match(autoEdit.snapshot().toolCallLog[0]?.reason ?? "", /non-stall/);

		const fullAuto = new AcpToolMediator({
			safety,
			cwd: process.cwd(),
			toolGovernance: "clio-policy",
			autonomy: "full-auto",
		});
		await fullAuto.handle({
			options: [{ optionId: "allow", kind: "allow_once" }],
			toolCall: { toolCallId: "c2", kind: "execute", rawInput: { command: "echo hello" } },
		});
		strictEqual(fullAuto.snapshot().toolCallLog[0]?.decision, "approved");

		const readOnly = new AcpToolMediator({
			safety,
			cwd: process.cwd(),
			toolGovernance: "clio-policy",
			autonomy: "read-only",
		});
		await readOnly.handle({
			options: [{ optionId: "reject", kind: "reject_once" }],
			toolCall: { toolCallId: "c3", kind: "edit", rawInput: { path: "src/x.ts" } },
		});
		strictEqual(readOnly.snapshot().toolCallLog[0]?.decision, "denied");
		match(readOnly.snapshot().toolCallLog[0]?.reason ?? "", /autonomy level is read-only/);
	});
});
