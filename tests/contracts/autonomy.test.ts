import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import type { ActionClass } from "../../src/domains/safety/action-classifier.js";
import type { ToolCallAuditRecord } from "../../src/domains/safety/audit.js";
import {
	AUTONOMY_LEVELS,
	type AutonomyDisposition,
	type AutonomyLevel,
	autonomyAskRejection,
	mapAutonomy,
} from "../../src/domains/safety/autonomy.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import { createSafetyBundle } from "../../src/domains/safety/extension.js";
import { AcpToolMediator } from "../../src/engine/acp/tool-mediator.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import {
	approvalParkedNotice,
	autonomyDeniedNotice,
	workerEscalationNotice,
} from "../../src/interactive/bus-notices.js";
import {
	type ApprovalRequestView,
	askAxis,
	createPermissionOverlayBody,
	describeCallTarget,
	sanitizeCallTargetText,
} from "../../src/interactive/permission-overlay.js";
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

function registerMockTools(registry: ToolRegistry): void {
	registry.register(mockSpec(ToolNames.Read, "read"));
	registry.register(mockSpec(ToolNames.Write, "write"));
	registry.register(mockSpec(ToolNames.Bash, "execute"));
	registry.register(mockSpec(ToolNames.Dispatch, "dispatch"));
}

const bashCall = (command: string) => ({ tool: ToolNames.Bash, args: { command } });
const writeCall = (filePath: string) => ({ tool: ToolNames.Write, args: { file_path: filePath, content: "x" } });

async function settle(): Promise<void> {
	await Promise.resolve();
}

function approvalViewForDecision(
	tool: string,
	decision: SafetyDecision,
	autonomy: string,
	requestId = "perm-test",
): ApprovalRequestView {
	const axis = askAxis(decision);
	return {
		requestId,
		tool,
		actionClass: decision.classification.actionClass,
		axis: axis.kind === "net" ? { kind: "net", ruleId: axis.ruleId } : { kind: "autonomy", level: autonomy },
		origin: { kind: "main" },
		reason:
			decision.kind === "ask" ? decision.rejection.short : `${tool} requests ${decision.classification.actionClass}`,
	};
}

function readToolCallAuditRows(stateDir: string): ToolCallAuditRecord[] {
	const auditDir = join(stateDir, "audit");
	let files: string[];
	try {
		files = readdirSync(auditDir).filter((file) => file.endsWith(".jsonl"));
	} catch {
		return [];
	}
	return files.flatMap((file) =>
		readFileSync(join(auditDir, file), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as ToolCallAuditRecord)
			.filter((row) => row.kind === "tool_call"),
	);
}

async function withAuditedRegistry(
	level: AutonomyLevel,
	fn: (registry: ToolRegistry) => Promise<void>,
): Promise<ToolCallAuditRecord[]> {
	const originalEnv = { ...process.env };
	const scratch = mkdtempSync(join(tmpdir(), "clio-autonomy-audit-"));
	const stateDir = join(scratch, "state");
	process.env.CLIO_HOME = scratch;
	process.env.CLIO_DATA_DIR = join(scratch, "data");
	process.env.CLIO_CONFIG_DIR = join(scratch, "config");
	process.env.CLIO_STATE_DIR = stateDir;
	process.env.CLIO_CACHE_DIR = join(scratch, "cache");
	resetXdgCache();
	const bus = createSafeEventBus();
	const mockContext: DomainContext = { bus, getContract: () => undefined };
	const bundle = createSafetyBundle(mockContext);
	const registry = createRegistry({ safety: bundle.contract, autonomy: () => level });
	registerMockTools(registry);
	let stopped = false;
	await bundle.extension.start();
	try {
		await fn(registry);
		await bundle.extension.stop?.();
		stopped = true;
		return readToolCallAuditRows(stateDir);
	} finally {
		if (!stopped) await bundle.extension.stop?.();
		for (const k of Object.keys(process.env)) {
			if (!(k in originalEnv)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(originalEnv)) {
			if (v !== undefined) process.env[k] = v;
		}
		resetXdgCache();
		rmSync(scratch, { recursive: true, force: true });
	}
}

describe("contracts/autonomy mapping matrix", () => {
	// The §2.3 level-dependent rows. system_modify is a safety-net rail owned
	// by the policy engine, not a row owned by the autonomy dial.
	const expected: Record<string, Record<AutonomyLevel, AutonomyDisposition>> = {
		read: { "read-only": "allow", suggest: "allow", "auto-edit": "allow", "full-auto": "allow" },
		write: { "read-only": "deny", suggest: "ask", "auto-edit": "allow", "full-auto": "allow" },
		"execute:recognized": { "read-only": "deny", suggest: "ask", "auto-edit": "allow", "full-auto": "allow" },
		"execute:unrecognized": { "read-only": "deny", suggest: "ask", "auto-edit": "ask", "full-auto": "allow" },
		dispatch: { "read-only": "deny", suggest: "ask", "auto-edit": "allow", "full-auto": "allow" },
		git_destructive: { "read-only": "deny", suggest: "deny", "auto-edit": "deny", "full-auto": "deny" },
		unknown: { "read-only": "deny", suggest: "ask", "auto-edit": "ask", "full-auto": "ask" },
	};

	it("maps every level-dependent action class per the sd-01 §2.3 matrix", () => {
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

		// Sequencing operators run at full-auto (sd-01 M5/I3): the command is
		// unrecognized, and the matrix allows unrecognized execute here.
		const operators = await registry.invoke(bashCall("echo a && echo b"));
		strictEqual(operators.kind, "ok");

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

	it("shell operators: substitution asks at full-auto, sequencing asks at auto-edit, the pack scans through both", async () => {
		// $() is a net confirm rail at every level, full-auto included; a
		// one-shot grant resumes it with confirmed posture.
		const fullAuto = registryAt("full-auto");
		const pendingSubstitution = fullAuto.invoke(bashCall("echo $(date +%s)"));
		await settle();
		strictEqual(fullAuto.hasParkedCalls(), true);
		await fullAuto.resumeParkedCalls({ actionClass: "execute", requestedBy: "test" });
		strictEqual((await pendingSubstitution).kind, "ok");

		const pendingBackticks = fullAuto.invoke(bashCall("echo `date`"));
		await settle();
		strictEqual(fullAuto.hasParkedCalls(), true);
		fullAuto.cancelParkedCalls("operator declined");
		strictEqual((await pendingBackticks).kind, "blocked");

		// A destructive verb behind an operator hits the pack before any
		// operator handling, so it blocks even at full-auto.
		const destructive = await fullAuto.invoke(bashCall("git status && find /tmp/clio-i3 -delete"));
		strictEqual(destructive.kind, "blocked");

		// At auto-edit, a piped command is unrecognized bash: it asks instead
		// of blocking, and a grant resumes it.
		const autoEdit = registryAt("auto-edit");
		const pendingPipe = autoEdit.invoke(bashCall("printf 'a\\nb' | wc -l"));
		await settle();
		strictEqual(autoEdit.hasParkedCalls(), true);
		await autoEdit.resumeParkedCalls({ actionClass: "execute", requestedBy: "test" });
		strictEqual((await pendingPipe).kind, "ok");

		// read-only denies the substitution ask like every other mutation.
		const readOnly = registryAt("read-only");
		const denied = await readOnly.invoke(bashCall("echo $(date)"));
		strictEqual(denied.kind, "blocked");
		ok(denied.kind === "blocked" && denied.reason.includes("autonomy level is read-only"));
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

		const body = createPermissionOverlayBody(approvalViewForDecision("bash", decision, "auto-edit")).render(60);
		ok(body.includes("Asked by: autonomy level (auto-edit)"), body.join("\n"));
	});

	it("carries the invoke toolCallId on permission-required metadata", async () => {
		const registry = registryAt("auto-edit");
		const metas: Array<{ toolCallId?: string }> = [];
		registry.onPermissionRequired((_call, _decision, meta) => {
			metas.push({ ...(meta.toolCallId !== undefined ? { toolCallId: meta.toolCallId } : {}) });
			registry.cancelParkedCalls("test done");
		});
		// With a provider tool-call id: the meta correlates the park to its
		// transcript segment. Without one: the field stays absent, never "".
		await registry.invoke(bashCall("echo hello"), { toolCallId: "call-77" });
		await registry.invoke(bashCall("echo hello again"));
		deepStrictEqual(metas, [{ toolCallId: "call-77" }, {}]);
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

		const body = createPermissionOverlayBody(approvalViewForDecision("bash", decision, "full-auto")).render(60);
		ok(
			body.some((line) => line.startsWith("Asked by: safety-net rail")),
			body.join("\n"),
		);
	});

	it("system_modify names the builtin confirm rail as the asking axis", async () => {
		const registry = registryAt("full-auto");
		const asks: Array<{ decision: SafetyDecision; axis: string }> = [];
		registry.onPermissionRequired((_call, decision, meta) => {
			asks.push({ decision, axis: meta.axis });
			registry.cancelParkedCalls("test done");
		});
		await registry.invoke(bashCall("sudo whoami"));
		const ask = asks[0];
		ok(ask);
		strictEqual(ask.axis, "net:system-modify-confirm");
		const axis = askAxis(ask.decision);
		strictEqual(axis.kind, "net");
		ok(axis.kind === "net" && axis.ruleId === "system-modify-confirm", JSON.stringify(axis));
		strictEqual(ask.decision.policy?.reasonCode, "system-modify-confirm");
		strictEqual(ask.decision.policy?.policySource, "builtin-classifier");

		const notice = approvalParkedNotice("bash", ask.decision, "full-auto");
		strictEqual(
			notice.text,
			"[approval] bash parked (system_modify): safety-net rail system-modify-confirm asks for confirmation. Approve once, or Esc to deny this call.",
		);

		const body = createPermissionOverlayBody(approvalViewForDecision("bash", ask.decision, "full-auto")).render(80);
		ok(body.includes("Asked by: safety-net rail system-modify-confirm"), body.join("\n"));
	});

	it("permission overlay renders real approval request views", () => {
		const mainView: ApprovalRequestView = {
			requestId: "perm-main",
			tool: "bash",
			actionClass: "execute",
			axis: { kind: "autonomy", level: "auto-edit" },
			origin: { kind: "main" },
			reason: "bash requires execute confirmation",
			target: "git stash drop",
			queueDepth: 2,
		};
		deepStrictEqual(createPermissionOverlayBody(mainView).render(80), [
			"Tool: bash",
			"Target: git stash drop",
			"Action: execute",
			"Asked by: autonomy level (auto-edit)",
			"1 of 2 parked",
			"",
			"Parked until you decide; allow or deny applies to this call only.",
			"Stopping the turn denies it and ends the run, so nothing asks again.",
			"Hard-blocked actions remain blocked.",
		]);

		const workerNetView: ApprovalRequestView = {
			requestId: "perm-worker-net",
			tool: "bash",
			actionClass: "execute",
			axis: { kind: "net", ruleId: "bash-command-substitution" },
			origin: { kind: "worker", agentId: "scout", runId: "r-abc" },
			reason: "bash requires execute confirmation",
		};
		deepStrictEqual(createPermissionOverlayBody(workerNetView).render(80), [
			"Tool: bash",
			"Action: execute",
			"Asked by: worker scout (run r-abc), safety-net rail bash-command-substitution",
			"",
			"Parked until you decide; allow or deny applies to this call only.",
			"Stopping the turn denies it and ends the run, so nothing asks again.",
			"Hard-blocked actions remain blocked.",
		]);

		const workerAutonomyView: ApprovalRequestView = {
			requestId: "perm-worker-autonomy",
			tool: "write",
			actionClass: "write",
			axis: { kind: "autonomy", level: "suggest" },
			origin: { kind: "worker", agentId: "coder", runId: "r-def" },
			reason: "write requires write confirmation",
		};
		deepStrictEqual(createPermissionOverlayBody(workerAutonomyView).render(80), [
			"Tool: write",
			"Action: write",
			"Asked by: worker coder (run r-def), autonomy level suggest",
			"",
			"Parked until you decide; allow or deny applies to this call only.",
			"Stopping the turn denies it and ends the run, so nothing asks again.",
			"Hard-blocked actions remain blocked.",
		]);
	});

	it("permission overlay renders every line of a resolved dispatch plan", () => {
		const view: ApprovalRequestView = {
			requestId: "perm-plan",
			tool: "dispatch",
			actionClass: "dispatch",
			axis: { kind: "autonomy", level: "auto-edit" },
			origin: { kind: "main" },
			reason: "dispatch plan needs approval",
			artifact: {
				kind: "dispatch-plan",
				text: [
					"dispatch plan: topology=parallel tasks=2",
					"cost ceiling: $5.0000",
					"  1. agent=coder model=model-a node=blade-a",
					"  2. agent=reviewer model=model-b node=blade-b",
				].join("\n"),
			},
		};
		const body = createPermissionOverlayBody(view).render(80).join("\n");
		ok(body.includes("Resolved dispatch plan:"), body);
		ok(body.includes("cost ceiling: $5.0000"), body);
		ok(body.includes("1. agent=coder model=model-a node=blade-a"), body);
		ok(body.includes("2. agent=reviewer model=model-b node=blade-b"), body);
	});

	it("permission overlay derives the call target from args and never renders the blocked wording", () => {
		strictEqual(describeCallTarget({ command: "rm -rf build" }), "rm -rf build");
		strictEqual(describeCallTarget({ path: "/tmp/probe.txt", content: "hello" }), "/tmp/probe.txt");
		strictEqual(describeCallTarget({ name: ".env", source: "file" }), ".env");
		strictEqual(describeCallTarget(undefined), "");
		strictEqual(describeCallTarget({}), "");
		strictEqual(describeCallTarget({ count: 3 }), '{"count":3}');

		const view: ApprovalRequestView = {
			requestId: "perm-target",
			tool: "write",
			actionClass: "system_modify",
			axis: { kind: "net", ruleId: "system-modify-confirm" },
			origin: { kind: "main" },
			reason: "write blocked: system_modify",
			target: describeCallTarget({ path: "/tmp/perm-probe-test.txt", content: "hello" }),
		};
		strictEqual(
			describeCallTarget({ command: "echo \u001b[31mspoof\u001b[0m \u0007 done" }),
			"echo spoof done",
			"escape sequences and control bytes never reach the approval overlay",
		);
		const body = createPermissionOverlayBody(view).render(80).join("\n");
		ok(body.includes("Target: /tmp/perm-probe-test.txt"), body);
		ok(!body.includes("blocked: system_modify"), `the ask overlay must not echo blocked wording: ${body}`);
	});

	it("worker escalation views render the payload's target and re-sanitize it at the trust boundary", () => {
		strictEqual(
			sanitizeCallTargetText("printf \u001b]0;spoof\u0007 worker\n ok"),
			"printf worker ok",
			"a target that crossed worker stdout is neutralized before display",
		);
		const view: ApprovalRequestView = {
			requestId: "perm-worker-target",
			tool: "bash",
			actionClass: "execute",
			axis: { kind: "net", ruleId: "bash-command-substitution" },
			origin: { kind: "worker", agentId: "coder", runId: "r-abc" },
			reason: "bash requires execute confirmation",
			target: sanitizeCallTargetText("printf worker-ok"),
		};
		const body = createPermissionOverlayBody(view).render(80).join("\n");
		ok(body.includes("Target: printf worker-ok"), `a worker ask shows what the call touches: ${body}`);
	});

	it("worker escalation notices name net rails and autonomy levels", () => {
		const netNotice = workerEscalationNotice({
			requestId: "perm-net",
			origin: "worker:r-abc",
			agentId: "scout",
			tool: "bash",
			actionClass: "execute",
			axis: "net:bash-command-substitution",
		});
		strictEqual(
			netNotice?.text,
			"[approval] worker scout (run r-abc) asks to run bash (execute): safety-net rail bash-command-substitution asks for confirmation. Approve once, or Esc to deny this call.",
		);

		const autonomyNotice = workerEscalationNotice({
			requestId: "perm-autonomy",
			origin: "worker:r-def",
			agentId: "coder",
			tool: "write",
			actionClass: "write",
			axis: "autonomy:suggest",
		});
		strictEqual(
			autonomyNotice?.text,
			"[approval] worker coder (run r-def) asks to run write (write): asks at autonomy suggest. Approve once, or Esc to deny this call.",
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

		const fullAutoSystemModify = new AcpToolMediator({
			safety,
			cwd: process.cwd(),
			toolGovernance: "clio-policy",
			autonomy: "full-auto",
		});
		await fullAutoSystemModify.handle({
			options: [{ optionId: "reject", kind: "reject_once" }],
			toolCall: { toolCallId: "c4", kind: "execute", rawInput: { command: "sudo whoami" } },
		});
		const systemModifyLog = fullAutoSystemModify.snapshot().toolCallLog[0];
		strictEqual(systemModifyLog?.decision, "denied");
		match(systemModifyLog?.reason ?? "", /^permission_required:/);
		match(systemModifyLog?.reason ?? "", /non-stall/);
		strictEqual(systemModifyLog?.safetyDecision?.reasonCode, "system-modify-confirm");
		strictEqual(systemModifyLog?.safetyDecision?.policySource, "builtin-classifier");
		strictEqual(systemModifyLog?.safetyDecision?.ruleId, "system-modify-confirm");
	});
});

describe("contracts/autonomy audit honesty", () => {
	it("read-only autonomy denial writes classified then denied rows without claiming allowed", async () => {
		const rows = await withAuditedRegistry("read-only", async (registry) => {
			const verdict = await registry.invoke(writeCall("notes/autonomy-test.txt"));
			strictEqual(verdict.kind, "blocked");
		});

		deepStrictEqual(
			rows.map((row) => row.decision),
			["classified", "denied"],
		);
		const denied = rows[1];
		ok(denied);
		strictEqual(denied.tool, ToolNames.Write);
		ok(
			denied.reasons.some((reason) => reason.includes("autonomy read-only")),
			JSON.stringify(denied.reasons),
		);
		// The denied row's reasonCode must reflect the final decision (the
		// autonomy axis), not repeat the policy engine's net-pass "allowed".
		strictEqual(denied.reasonCode, "autonomy:read-only");
	});

	it("suggest autonomy park writes classified then permission_requested at park time", async () => {
		const rows = await withAuditedRegistry("suggest", async (registry) => {
			const pending = registry.invoke(writeCall("notes/autonomy-test.txt"));
			await settle();
			strictEqual(registry.hasParkedCalls(), true);
			registry.cancelParkedCalls("operator declined");
			strictEqual((await pending).kind, "blocked");
		});

		deepStrictEqual(
			rows.map((row) => row.decision),
			["classified", "permission_requested"],
		);
		const requested = rows[1];
		ok(requested);
		ok(
			requested.reasons.some((reason) => reason.includes("Autonomy suggest")),
			JSON.stringify(requested.reasons),
		);
	});

	it("a granted autonomy park keeps a single final allowed row on resume", async () => {
		const rows = await withAuditedRegistry("auto-edit", async (registry) => {
			const pending = registry.invoke(bashCall("echo hello"));
			await settle();
			strictEqual(registry.hasParkedCalls(), true);
			await registry.resumeParkedCalls({ actionClass: "execute", requestedBy: "test" });
			strictEqual((await pending).kind, "ok");
		});

		deepStrictEqual(
			rows.map((row) => row.decision),
			["classified", "permission_requested", "allowed"],
		);
		strictEqual(rows.filter((row) => row.decision === "allowed").length, 1);
	});
});

describe("contracts/autonomy ask rejection hints", () => {
	it("execute asks name the approval-free pivots: verify and the observe tools", () => {
		const rejection = autonomyAskRejection("auto-edit", "bash", "execute");
		ok(
			rejection.hints.some((hint) => hint.includes('verify(check="<script>")')),
			"the verify pivot reaches the model",
		);
		ok(
			rejection.hints.some((hint) => hint.includes("ls, read, grep, and find")),
			"the observe-tool pivot reaches the model",
		);
	});

	it("non-execute asks carry no shell-pivot hints", () => {
		const rejection = autonomyAskRejection("suggest", "write", "write");
		strictEqual(
			rejection.hints.some((hint) => hint.includes("verify(check")),
			false,
		);
	});
});
