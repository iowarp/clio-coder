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
	AUTONOMY_EXPOSURES,
	AUTONOMY_LEVELS,
	type AutonomyDisposition,
	type AutonomyExposure,
	type AutonomyLevel,
	autonomyAskRejection,
	mapAutonomy,
} from "../../src/domains/safety/autonomy.js";
import type { SafetyDecision } from "../../src/domains/safety/contract.js";
import { createSafetyBundle } from "../../src/domains/safety/extension.js";
import { formatModelRejection } from "../../src/domains/safety/rejection-feedback.js";
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
import { invokeRegisteredTool } from "../../src/tools/agent-tools.js";
import { askUserExposure, createAskUserTool, normalizeAskUserCall } from "../../src/tools/ask-user.js";
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

/** An ask_user round carrying the exposure tier under test, or none at all. */
const askUserCall = (exposure: string | undefined) => ({
	tool: ToolNames.AskUser,
	args: {
		action: "ask",
		questions: [{ question: "File the issue now?" }],
		...(exposure === undefined ? {} : { exposure }),
	},
});

/** A registry holding the real ask_user tool with a counting answer handler. */
function askUserRegistryAt(level: AutonomyLevel): { registry: ToolRegistry; answered: () => number } {
	let answered = 0;
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd: process.cwd() }),
		autonomy: () => level,
	});
	registry.register(
		createAskUserTool({
			askUser: async (questions) => {
				answered += 1;
				return { answers: questions.map((question) => ({ question: question.question, answer: "yes" })) };
			},
		}),
	);
	return { registry, answered: () => answered };
}

/**
 * Point the state dir at scratch for tests whose tool body runs: ask_user
 * persists an interview transcript under it, and a contract test has no
 * business writing into the operator's real state directory.
 */
async function withScratchState(fn: () => Promise<void>): Promise<void> {
	const previous = process.env.CLIO_CODER_STATE_DIR;
	const scratch = mkdtempSync(join(tmpdir(), "clio-autonomy-exposure-"));
	process.env.CLIO_CODER_STATE_DIR = join(scratch, "state");
	resetXdgCache();
	try {
		await fn();
	} finally {
		if (previous === undefined) Reflect.deleteProperty(process.env, "CLIO_CODER_STATE_DIR");
		else process.env.CLIO_CODER_STATE_DIR = previous;
		resetXdgCache();
		rmSync(scratch, { recursive: true, force: true });
	}
}

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
	process.env.CLIO_CODER_HOME = scratch;
	process.env.CLIO_CODER_DATA_DIR = join(scratch, "data");
	process.env.CLIO_CODER_CONFIG_DIR = join(scratch, "config");
	process.env.CLIO_CODER_STATE_DIR = stateDir;
	process.env.CLIO_CODER_CACHE_DIR = join(scratch, "cache");
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

describe("contracts/autonomy exposure tier", () => {
	// The tier is orthogonal to the action class. ask_user, the only tool that
	// declares one today, is read class, so `local` is the read row and the
	// outward row parks at both supervised-and-above levels that would otherwise
	// answer the gate: auto-edit and suggest.
	const expected: Record<AutonomyExposure, Record<AutonomyLevel, AutonomyDisposition>> = {
		local: { "read-only": "allow", suggest: "allow", "auto-edit": "allow", "full-auto": "allow" },
		outward: { "read-only": "allow", suggest: "ask", "auto-edit": "ask", "full-auto": "allow" },
	};

	it("maps the exposure × level matrix for a read-class gate", () => {
		for (const exposure of AUTONOMY_EXPOSURES) {
			for (const level of AUTONOMY_LEVELS) {
				strictEqual(
					mapAutonomy(level, "read", { exposure }),
					expected[exposure][level],
					`expected exposure ${exposure} at ${level} to be ${expected[exposure][level]}`,
				);
			}
		}
	});

	it("reads the outward column monotonically down the dial", () => {
		// #50: the dial is ordered, so no level may gate an outward gate less than
		// the looser level below it. suggest is stricter than auto-edit and must
		// not answer a gate auto-edit parks.
		const strictness: Record<AutonomyDisposition, number> = { allow: 0, ask: 1, deny: 2 };
		strictEqual(
			strictness[expected.outward.suggest] >= strictness[expected.outward["auto-edit"]],
			true,
			"suggest must gate an outward gate at least as hard as auto-edit",
		);
		strictEqual(mapAutonomy("suggest", "read", { exposure: "outward" }), "ask");
		// The two ends of the dial are the ones #50 leaves alone.
		strictEqual(mapAutonomy("read-only", "read", { exposure: "outward" }), "allow");
		strictEqual(mapAutonomy("full-auto", "read", { exposure: "outward" }), "allow");
	});

	it("declaring a tier never widens what the action class already gated", () => {
		// The tier only ever adds an ask. A denied or blocked row stays denied at
		// every level, and an omitted tier is the pre-tier behavior exactly.
		strictEqual(mapAutonomy("read-only", "write", { exposure: "outward" }), "deny");
		strictEqual(mapAutonomy("auto-edit", "git_destructive", { exposure: "outward" }), "deny");
		strictEqual(mapAutonomy("suggest", "write", { exposure: "outward" }), "ask");
		for (const level of AUTONOMY_LEVELS) {
			strictEqual(mapAutonomy(level, "read", { exposure: "local" }), mapAutonomy(level, "read"));
			strictEqual(mapAutonomy(level, "write", { exposure: "local" }), mapAutonomy(level, "write"));
		}
	});

	it("parks an outward ask_user gate at auto-edit and answers it after one approval", async () => {
		await withScratchState(async () => {
			const gate = askUserRegistryAt("auto-edit");
			const parked: SafetyDecision[] = [];
			gate.registry.onPermissionRequired((_call, decision) => {
				parked.push(decision);
			});
			const pending = gate.registry.invoke(askUserCall("outward"));
			await settle();
			strictEqual(gate.registry.hasParkedCalls(), true);
			strictEqual(gate.answered(), 0);
			strictEqual(parked.length, 1);
			const rejection = parked[0]?.kind === "ask" ? parked[0].rejection : null;
			ok(rejection, "the parked decision carries an ask rejection");
			match(rejection.short, /outward-facing gate at autonomy auto-edit/);
			match(rejection.detail, /exposure=outward/);

			await gate.registry.resumeParkedCalls({ actionClass: "read", requestedBy: "test" });
			strictEqual((await pending).kind, "ok");
			strictEqual(gate.answered(), 1);
		});
	});

	it("parks an outward ask_user gate at suggest through the same approvals context", async () => {
		await withScratchState(async () => {
			const gate = askUserRegistryAt("suggest");
			const parked: SafetyDecision[] = [];
			gate.registry.onPermissionRequired((_call, decision) => {
				parked.push(decision);
			});
			const pending = gate.registry.invoke(askUserCall("outward"));
			await settle();
			strictEqual(gate.registry.hasParkedCalls(), true);
			strictEqual(gate.answered(), 0);
			const rejection = parked[0]?.kind === "ask" ? parked[0].rejection : null;
			ok(rejection, "the parked decision carries an ask rejection");
			match(rejection.short, /outward-facing gate at autonomy suggest/);

			await gate.registry.resumeParkedCalls({ actionClass: "read", requestedBy: "test" });
			strictEqual((await pending).kind, "ok");
			strictEqual(gate.answered(), 1);

			// A local gate at suggest is still answered without parking: the tier is
			// what moved, not the read row.
			const local = askUserRegistryAt("suggest");
			strictEqual((await local.registry.invoke(askUserCall("local"))).kind, "ok");
			strictEqual(local.registry.hasParkedCalls(), false);
			strictEqual(local.answered(), 1);
		});
	});

	it("denying the parked outward gate blocks the call instead of answering it", async () => {
		await withScratchState(async () => {
			const gate = askUserRegistryAt("auto-edit");
			const pending = gate.registry.invoke(askUserCall("outward"));
			await settle();
			gate.registry.cancelParkedCalls("operator declined");
			const verdict = await pending;
			strictEqual(verdict.kind, "blocked");
			strictEqual(gate.answered(), 0);
		});
	});

	it("answers a local gate at auto-edit and an outward gate at full-auto without parking", async () => {
		await withScratchState(async () => {
			const local = askUserRegistryAt("auto-edit");
			strictEqual((await local.registry.invoke(askUserCall("local"))).kind, "ok");
			strictEqual((await local.registry.invoke(askUserCall(undefined))).kind, "ok");
			strictEqual(local.registry.hasParkedCalls(), false);
			strictEqual(local.answered(), 2);

			// full-auto is unchanged by the tier: auto means auto.
			const auto = askUserRegistryAt("full-auto");
			strictEqual((await auto.registry.invoke(askUserCall("outward"))).kind, "ok");
			strictEqual(auto.registry.hasParkedCalls(), false);
			strictEqual(auto.answered(), 1);
		});
	});

	it("reads an unrecognized tier as outward and then rejects the call", async () => {
		await withScratchState(async () => {
			const gate = askUserRegistryAt("auto-edit");
			const pending = gate.registry.invoke({
				tool: ToolNames.AskUser,
				args: { action: "ask", exposure: "public", questions: [{ question: "File the issue?" }] },
			});
			await settle();
			// Fail closed at admission: a tier the schema does not know must not
			// read as the default `local` and skip the operator.
			strictEqual(gate.registry.hasParkedCalls(), true);
			await gate.registry.resumeParkedCalls({ actionClass: "read", requestedBy: "test" });
			const verdict = await pending;
			ok(verdict.kind === "ok" && verdict.result.kind === "error");
			match(verdict.result.message, /exposure must be local or outward/);
			strictEqual(gate.answered(), 0);
		});
	});

	it("normalizes the declared tier and rejects values outside it", () => {
		strictEqual(askUserExposure(undefined), "local");
		strictEqual(askUserExposure({}), "local");
		strictEqual(askUserExposure({ exposure: "local" }), "local");
		strictEqual(askUserExposure({ exposure: " OUTWARD " }), "outward");
		strictEqual(askUserExposure({ exposure: "public" }), "outward");
		strictEqual(askUserExposure({ exposure: 7 }), "outward");
		strictEqual(normalizeAskUserCall({ action: "complete", exposure: "outward" }).error, undefined);
		strictEqual(
			normalizeAskUserCall({ action: "complete", exposure: "public" }).error,
			"exposure must be local or outward",
		);
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

	it("does not charge an operator's thinking time to the tool it approved", async () => {
		const registry = registryAt("auto-edit");
		const finished: Array<{ tool: string; durationMs: number }> = [];
		const pending = invokeRegisteredTool(registry, ToolNames.Bash, bashCall("echo hello").args, {
			telemetry: {
				onFinish: (event) => {
					finished.push({ tool: event.tool, durationMs: event.durationMs });
				},
			},
		});
		await settle();
		strictEqual(registry.hasParkedCalls(), true);
		// Stand in for an operator reading the card before pressing allow.
		await new Promise((resolve) => setTimeout(resolve, 120));
		await registry.resumeParkedCalls({ actionClass: "execute", requestedBy: "test" });
		await pending;

		strictEqual(finished.length, 1);
		const durationMs = finished[0]?.durationMs ?? -1;
		ok(durationMs >= 0, `duration must stay non-negative, got ${durationMs}`);
		ok(durationMs < 100, `the 120ms park must not be charged to the tool, got ${durationMs}ms`);
	});

	it("charges an approved dispatch the fan-out it ran, not the slice before admission", async () => {
		// A dispatch that parks runs its whole fan-out inside the resume pass, so
		// a park measured to the verdict swallows the fan-out and the settled
		// transcript line reads as the admission slice. Issue #82 saw 224.8s of
		// fan-out render as 15ms.
		const fanOutMs = 400;
		const parkMs = 200;
		const registry = registryAt("auto-edit");
		registry.register({
			...mockSpec(ToolNames.Dispatch, "dispatch"),
			describeDispatchPlan: () => ({
				topology: "review",
				taskCount: 2,
				planScale: true,
				tasks: [],
				text: "review plan",
				hash: "0".repeat(64),
			}),
			run: async () => {
				await new Promise((resolve) => setTimeout(resolve, fanOutMs));
				return { kind: "ok", output: "fan-out settled" };
			},
		});
		const finished: number[] = [];
		const pending = invokeRegisteredTool(
			registry,
			ToolNames.Dispatch,
			{},
			{
				telemetry: {
					onFinish: (event) => {
						finished.push(event.durationMs);
					},
				},
			},
		);
		await settle();
		strictEqual(registry.hasParkedCalls(), true);
		await new Promise((resolve) => setTimeout(resolve, parkMs));
		await registry.resumeParkedCalls({ actionClass: "dispatch", requestedBy: "test" });
		await pending;

		strictEqual(finished.length, 1);
		const durationMs = finished[0] ?? -1;
		ok(durationMs >= fanOutMs * 0.8, `the fan-out must be charged to the tool, got ${durationMs}ms`);
		ok(durationMs < fanOutMs + parkMs * 0.5, `the ${parkMs}ms park must not be charged, got ${durationMs}ms`);
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
		ok(notice.text.includes(".clio-coder/safety.yaml"));

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

/**
 * Denying one bash call rendered the denied state six times on one frame. Two of
 * those were paragraphs inside the model-facing payload: the operator's decision,
 * then the ask-time rejection explaining that the call is parked and how
 * approving it would resume it, followed by four hints for an approval that is
 * not coming, and a closing "do not retry" that the decision line had already
 * said. The answer is the message; the composer still closes it with the
 * standing pivot.
 */
describe("contracts/autonomy denial payload says the denial once", () => {
	const denial = "User cancelled this tool call from the permission confirmation prompt. Wait for new instruction.";

	it("carries the operator's decision and drops the pre-decision ask text", async () => {
		const registry = registryAt("auto-edit");
		registry.onPermissionRequired((_call, _decision, meta) => {
			registry.cancelParkedCall(meta.requestId, denial);
		});
		const verdict = await registry.invoke(bashCall("id"));

		strictEqual(verdict.kind, "blocked");
		ok(verdict.kind === "blocked" && "rejection" in verdict.decision);
		const rejection = verdict.kind === "blocked" && "rejection" in verdict.decision ? verdict.decision.rejection : null;
		strictEqual(rejection?.detail, denial, "the decision is the whole explanation");
		deepStrictEqual([...(rejection?.hints ?? [])], [], "no approval hints after the approval was refused");

		const modelText = formatModelRejection(verdict.kind === "blocked" ? verdict.reason : "", rejection ?? undefined);
		const lines = modelText.split("\n");
		strictEqual(lines.filter((line) => line.includes("cancelled this tool call")).length, 1);
		ok(!modelText.includes("The call is parked until"), `no stale parked-state paragraph: ${modelText}`);
		ok(!modelText.includes("Approving resumes only this call"), modelText);
		strictEqual(lines.length, 2, `one denial plus the standing pivot: ${modelText}`);
	});

	it("keeps the blocked decision shape downstream consumers read", async () => {
		const registry = registryAt("auto-edit");
		registry.onPermissionRequired((_call, _decision, meta) => {
			registry.cancelParkedCall(meta.requestId, denial);
		});
		const verdict = await registry.invoke(bashCall("id"));
		ok(verdict.kind === "blocked");
		strictEqual(verdict.decision.kind, "block", "an answered park is a block, not a pending ask");
		strictEqual(verdict.decision.classification.actionClass, "execute");
	});
});

describe("contracts/autonomy approvals contexts", () => {
	it("headless: an autonomy ask resolves as a deterministic deny when the context cancels parked calls", async () => {
		const registry = registryAt("auto-edit");
		const headlessReason =
			"clio-coder run cannot confirm permission requests; rerun interactively to approve this action.";
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
		const verdict = await registry.invoke(writeCall(join(".clio-coder", "test-scratch", "autonomy-worker.txt")));
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
