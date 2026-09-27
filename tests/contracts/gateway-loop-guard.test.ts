import { deepStrictEqual, match, ok } from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import type { ToolRegistry } from "../../src/tools/registry.js";

/**
 * The loop guard judges a capability the same way however the model reached
 * it (#F4, #F8 of the v0.5.7 release review). A chain wrapper is aggregate
 * bookkeeping: its completion must not reset or overwrite the stagnation
 * history its children built. A gateway op=call has one identity, the
 * capability and its own arguments, for the repeat detector and for the
 * success memory that tells the model it already has the answer.
 */

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): { cwd: string; registry: ToolRegistry } {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-gateway-loop-guard-")));
	roots.push(cwd);
	writeFileSync(join(cwd, "notes.ts"), ["export const alpha = 1;", "export const beta = 2;", ""].join("\n"));
	const safety = createWorkerSafety({ cwd });
	const guard = createLoopGuardRegistration({ safety, toolCallCap: 100, turnBlockBudget: 100 });
	const registry = createWorkerToolRegistry(undefined, safety, undefined, [guard]);
	// Stand in for an operator who approves the write the mutation case makes.
	registry.onPermissionRequired((_call, decision, meta) => {
		void registry.resumeParkedCalls({
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			requestedBy: "test:operator",
		});
	});
	return { cwd, registry };
}

type Outcome = "ok" | "error" | "blocked";

/** A direct call's verdict, or a single-step chain's verdict as its step's own admission. */
async function invoke(
	registry: ToolRegistry,
	tool: string,
	args: Record<string, unknown>,
): Promise<{ outcome: Outcome; reason: string }> {
	const verdict = await registry.invoke({ tool, args }, { turnId: "turn-1" });
	if (verdict.kind !== "ok") return { outcome: "blocked", reason: verdict.reason };
	const details = verdict.result.details as { op?: string; chainResults?: Array<Record<string, unknown>> } | undefined;
	if (tool === ToolNames.Gateway && details?.op === "chain") {
		const child = details.chainResults?.[0] as
			| { result?: { details?: { chainAdmission?: { outcome?: Outcome; blockReason?: string } } } }
			| undefined;
		const admission = child?.result?.details?.chainAdmission;
		return { outcome: admission?.outcome ?? "error", reason: admission?.blockReason ?? "" };
	}
	return {
		outcome: verdict.result.kind,
		reason: verdict.result.kind === "error" ? verdict.result.message : "",
	};
}

const grepArgs = (cwd: string, limit: number, pattern = "alpha") => ({ pattern, path: cwd, limit });
const direct = (registry: ToolRegistry, args: Record<string, unknown>) => invoke(registry, ToolNames.Grep, args);
const chained = (registry: ToolRegistry, args: Record<string, unknown>) =>
	invoke(registry, ToolNames.Gateway, { op: "chain", steps: [{ id: "find", capability: ToolNames.Grep, args }] });

describe("stagnation through gateway chains", () => {
	for (const [label, via] of [
		["direct", direct],
		["chained", chained],
		[
			"alternating",
			(registry: ToolRegistry, args: Record<string, unknown>) =>
				(Number(args.limit) / 10) % 2 === 0 ? chained(registry, args) : direct(registry, args),
		],
	] as const) {
		it(`blocks size-only escalation with identical results (${label})`, async () => {
			const { cwd, registry } = workspace();
			const outcomes: Outcome[] = [];
			const reasons: string[] = [];
			for (const limit of [10, 20, 30, 40, 50]) {
				const result = await via(registry, grepArgs(cwd, limit));
				outcomes.push(result.outcome);
				reasons.push(result.reason);
			}
			deepStrictEqual(outcomes, ["ok", "ok", "blocked", "blocked", "blocked"]);
			match(reasons[2] ?? "", /returned byte-identical results even though size arguments/u);
		});
	}

	it("still lets genuinely new evidence and a workspace change through", async () => {
		const { cwd, registry } = workspace();
		const outcomes: Outcome[] = [];
		outcomes.push((await chained(registry, grepArgs(cwd, 10))).outcome);
		outcomes.push((await chained(registry, grepArgs(cwd, 20))).outcome);
		// A different query is a new question, not an escalation.
		outcomes.push((await chained(registry, grepArgs(cwd, 30, "beta"))).outcome);
		outcomes.push((await chained(registry, grepArgs(cwd, 40, "beta"))).outcome);
		// A chained write changes what the same query returns.
		const write = await invoke(registry, ToolNames.Gateway, {
			op: "chain",
			steps: [
				{
					id: "put",
					capability: ToolNames.Write,
					args: { path: join(cwd, "notes.ts"), content: "export const beta = 3;\nexport const betaTwo = 4;\n" },
				},
			],
		});
		ok(write.outcome === "ok", write.reason);
		outcomes.push((await chained(registry, grepArgs(cwd, 50, "beta"))).outcome);
		deepStrictEqual(outcomes, ["ok", "ok", "ok", "ok", "ok"]);
	});
});

describe("gateway op=call identity", () => {
	const absent = { name: "CLIO_GATEWAY_LOOP_GUARD_ABSENT" };
	const viaCall = (registry: ToolRegistry, args: Record<string, unknown>) =>
		invoke(registry, ToolNames.Gateway, { op: "call", capability: ToolNames.CredentialPresent, args });
	const viaName = (registry: ToolRegistry, args: Record<string, unknown>) =>
		invoke(registry, ToolNames.CredentialPresent, args);

	for (const [label, via] of [
		["by name", viaName],
		["through op=call", viaCall],
	] as const) {
		it(`repeats of a successful call name the earlier success (${label})`, async () => {
			const { registry } = workspace();
			const results = [];
			for (let attempt = 0; attempt < 3; attempt += 1) results.push(await via(registry, absent));
			deepStrictEqual(
				results.map((result) => result.outcome),
				["ok", "ok", "blocked"],
			);
			match(results[2]?.reason ?? "", /This exact call already succeeded 2 times this run/u);
		});
	}

	it("keeps different arguments distinct", async () => {
		const { registry } = workspace();
		const outcomes: Outcome[] = [];
		outcomes.push((await viaCall(registry, absent)).outcome);
		outcomes.push((await viaCall(registry, absent)).outcome);
		outcomes.push((await viaCall(registry, { name: "CLIO_GATEWAY_LOOP_GUARD_OTHER" })).outcome);
		deepStrictEqual(outcomes, ["ok", "ok", "ok"]);
	});
});
